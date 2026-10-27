// ERRANDS AND HOLDS: provisioning runs, signet returns, reconnecting, leaving a hold, parking.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 13 methods: runProvision, runSignetReturn, runErrand, payFarmer, reconnect, leaveHold,
//   wallUpBeforeSettingOff, stepOutOfThePocket, maybeTestSpot, park, unpark, parkStatus, static
//   PARK_GRACE_MS
import { poisonedNow, POISON_RELOG_OFFLINE_MS } from '../m59-poison.mjs';
import { withCastRite } from '../m59-castrite.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { HOLD_WHILE_HURT_MAX_MS, pct, spotHeldBy, whereIs } from '../m59-autopilot.mjs';

export class ErrandsPart {
  // @part 1

  // ------------------------------------------------------------- loot runs
  //
  // GO AND FETCH WHAT SOMEBODY ELSE CANNOT CARRY.
  //
  // A farmer that is doing well drops more than it can hold, and cannot leave to sell
  // it without giving up a wall it spent twenty minutes proving. A character with no
  // food is stuck at the resting cap of 80 vigor for ever and has no safe way to earn
  // its way out. Those are the same problem from two ends.
  //
  // The errand takes priority over farming but NOT over staying alive: it is checked
  // after the death, danger and rest branches, so a runner that gets into trouble on
  // the way deals with that first and picks the errand up afterwards.
  //
  // Payment is deliberately asymmetric and deliberately not carried: food changes
  // hands on the spot because a fed farmer earns back its value many times over, and
  // anything owed in coin is settled in a town afterwards. Carrying money into the
  // wilderness to settle a debt would put the one thing death takes into the one place
  // death happens.
  // WALK OVER AND MAKE THEM ONE.
  //
  // Both creation spells are self-only: creaweap.kod:117 and creafood.kod do
  // Send(who,@NewHold,#what=...) where `who` is the CASTER, and lTargets is never
  // read. So there is no such thing as casting a weapon onto someone else — the
  // quartermaster casts for itself and then hands the result over, which is the same
  // two-sided trade a loot run uses to pay a farmer.
  //
  // The caster travels, never the supplicant: a character with no weapon is the one
  // that should be walking through the fewest monster rooms.
  async runProvision(e) {
    const s = this.s, c = s.need();
    const room = s.world?.room;

    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('setting out to provision someone')).refused) return true;
      const r = await this.travel(e.room, { origin: keeperOrigin('provision'), maxHops: 14 }).catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the supplicant', { to_room: e.room, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the supplicant');
        return true;
      }
      this.note('arrived to provision', { room: e.room_name, for: e.supplicant_name });
      this.progress('reached the supplicant');
      return true;
    }

    const them = [...c.room.objects.values()]
      .find(o => (o.flags & OF.PLAYER) &&
                 (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(e.supplicant_name || '').toLowerCase());
    if (!them) {
      // They roamed. Follow once rather than abandoning: we are already out here, the
      // spell is already known, and giving up sends the whole errand back to the planner
      // only for it to pair the same two characters again against another stale room.
      const now = whereIs(e.supplicant);
      if (now && now.room !== e.room && (e.chases || 0) < 2) {
        e.chases = (e.chases || 0) + 1;
        this.note('supplicant has moved — following', {
          wanted: e.supplicant_name, expected: e.room_name, now: now.name ?? now.room,
          chase: e.chases });
        e.room = now.room; e.room_name = now.name ?? String(now.room);
        return true;
      }
      e.done = true; e.why_done = 'they had moved on';
      this.note('supplicant not here', { wanted: e.supplicant_name, room: e.room_name,
        chases: e.chases ?? 0,
        why: now ? 'followed as far as we are willing to' : 'no recent reading of where they went' });
      return true;
    }

    // Cast it for ourselves, then find what appeared. Comparing inventory before and
    // after is the only reliable way to know WHICH object to hand over — the spell
    // rolls a random weapon or foodstuff and tells us nothing machine-readable.
    // c.spells is empty until it is asked for — reading it cold is the phantom
    // "the spell did not encode" bug.
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 500));
    const want = String(e.service).toLowerCase();
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === want);
    if (!spell) {
      e.done = true; e.why_done = `does not know ${e.service}`;
      this.note('cannot provide that', { spell: e.service,
                                         knows: (c.spells || []).map(sp => c.rsc.get(sp.nameRsc)) });
      return true;
    }

    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});

    // DO NOT CAST TWICE FOR ONE ERRAND.
    //
    // The hand-over can fail on its own — a supplicant in the middle of a fight does
    // not reach the branch that accepts gifts within our window — and the retry used to
    // start again from the cast. Kraanite made a weapon, failed to hand it over, cast a
    // second one at fifteen mana, and then had nothing left to cast with while carrying
    // a perfectly good weapon it had already made. If what we made last pass is still in
    // the pack, offer that instead.
    const stillHave = (e.made_ids || []).filter(id => (c.inventory || []).some(o => o.id === id));
    let made;
    if (stillHave.length) {
      made = (c.inventory || []).filter(o => stillHave.includes(o.id));
      this.note('offering what we already made', { to: e.supplicant_name,
        items: made.map(o => c.rsc.get(o.nameRsc)),
        why: 'the previous hand-over did not complete; recasting would spend mana for nothing' });
    } else {
      const had = new Set((c.inventory || []).map(o => o.id));
      const manaBefore = c.vitals?.()?.mana?.value ?? null;
      const reagentsBefore = e.service === 'create food' ? this.reagentCount() : null;
      // Both creation spells take no target, so the target list is empty.
      await withCastRite(s, { spell, targets: [], why: 'runProvision' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));
      await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
      await new Promise(x => setTimeout(x, 1200));
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      made = (c.inventory || []).filter(o => !had.has(o.id));
      e.made_ids = made.map(o => o.id);
      // Recorded as a cast for SOMEBODY ELSE. Same spell, same mana, entirely different
      // decision — a quartermaster spending its reagents on a crewmate is not the same
      // event as one feeding itself, and the audit should not have to guess from timing.
      this.recordCast(e.service, { ok: made.length > 0, target: e.supplicant_name,
        why: 'errand: a crewmate asked for one', reagents_before: reagentsBefore,
        made: made.map(o => c.rsc.get(o.nameRsc)),
        mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
    }
    if (!made.length) {
      e.failures = (e.failures || 0) + 1;
      this.note('the cast produced nothing we can see', {
        spell: e.service, attempt: e.failures,
        mana: c.vitals?.()?.mana,
        // The server refuses both of these without a word, so the absence of an item is
        // the only signal there is. Naming them saves the next reader an hour.
        why: e.service === 'create food'
          ? 'create food needs 2 ElderBerry and 2 Herbs in OUR pack, and refuses silently without them'
          : 'create weapon costs 15 mana and refuses silently below it' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'cast produced nothing'; }
      return true;
    }

    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, made.map(o => o.id)));
    // Their keeper counters from social(), which runs once per pass — so the window has
    // to be wider than one of their passes or a supplicant that is mid-fight never
    // answers in time and we conclude, wrongly, that nobody is home.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 20000 })
                      .catch(() => ({ events: [] }));
    if (!ev.events?.some(x => x.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      e.failures = (e.failures || 0) + 1;
      this.note('they never countered', { to: e.supplicant_name,
        why: 'a gift completes only when the other side counters; their keeper does that in social()' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'no counteroffer'; }
      return true;
    }
    await s.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(x => setTimeout(x, 1200));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});

    e.done = true;
    e.why_done = 'handed over';
    e.gave = made.map(o => c.rsc.get(o.nameRsc));
    this.note('provisioned', { to: e.supplicant_name, service: e.service, gave: e.gave,
      caveat: e.service === 'create weapon'
        ? 'a made weapon is temporary — it buys the walk to a shop, it is not a repair' : undefined });
    this.progress('provisioned someone');
    return true;
  }

  // WALK THE RING TO THE PERSON IT BELONGS TO, THEN PUT THE MONEY SOMEWHERE DEATH CANNOT
  // REACH IT.
  //
  // The opportunistic check in the main loop hands a ring back whenever its owner happens
  // to be in the room, which for a fleet that never enters a town is approximately never.
  // Fifteen of the nineteen possible owners stand in a fixed room (SIGNET_OWNERS in
  // m59-skills.mjs), so this is a two-hop errand: go to that room, offer the ring.
  //
  // IT IS DISPATCHED TO THE CHARACTER THAT GETS PAID MOST, which is what makes the whole
  // thing worth building. Under 30 max health the ring pays ten times its value; at or
  // over, one times. So the fleet moves rings DOWN to its smallest characters first —
  // `signets` action=redistribute — and only then sends them walking.
  //
  // The last step is not optional. This errand deliberately hands a four-figure sum to
  // the most fragile character in the fleet, in a purse, in a world where death drops
  // your entire inventory. Banking it is the point of earning it.
  async runSignetReturn(e) {
    const s = this.s, c = s.need();
    const room = s.world?.room;

    // 0. IS THE RING STILL IN THE PACK? The first live dispatch died on the way and
    //    dropped both rings on a corpse, and the errand carried on walking to Tos to hand
    //    over something it no longer had — twenty-five minutes of a small character
    //    crossing the world for nothing, ending in the same two failures a missing owner
    //    produces. Death is not the only way to lose it either: the opportunistic check
    //    hands rings back whenever the owner walks past, and the world deletes the oldest
    //    signet when a twenty-first is made (library.kod:4288).
    //
    //    The cached inventory is checked first because it is free; only if it looks empty
    //    is a real read spent, because "empty" is also what a stale snapshot looks like
    //    in the seconds after a reconnect and giving up on that would be a coin flip.
    const carrying = () => (c.inventory || []).some(o => /signet ring/i.test(c.rsc.get(o.nameRsc) || ''));
    if (!carrying()) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      if (!carrying()) {
        e.done = true;
        e.why_done = 'the ring is gone';
        this.note('no signet ring left to return', {
          was_for: e.owner, to: e.where,
          why: 'dropped on death, handed over already, or deleted by the world — either way ' +
               'there is nothing to walk anywhere for' });
        return true;
      }
    }

    // 1. Get there. Two failures and it gives up rather than pacing between a wall and a
    //    town for twenty minutes; the ring stays in the pack and the opportunistic check
    //    keeps working on it for free.
    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('taking a signet ring back to its owner')).refused) return true;
      const r = await this.travel(e.room, { origin: keeperOrigin('signet_return'), maxHops: 20 })
                      .catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the ring\'s owner',
                  { to_room: e.room, where: e.where, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the signet ring\'s owner');
        return true;
      }
      this.note('arrived to return a signet ring', { room: e.where, owner: e.owner });
      this.progress('reached the ring\'s owner');
      return true;
    }

    // 2. Hand it over. returnSignetRings matches the owner named on each ring against the
    //    objects in this room, so it gives back every ring this character is carrying that
    //    belongs here — not only the one the errand was cut for. That is free and it is
    //    the whole reason redistribution groups rings by town before dispatching.
    const gave = await skills.returnSignetRings(s).catch(x => ({ returned: [], why: x.message }));
    if (!gave.returned?.length) {
      e.failures = (e.failures || 0) + 1;
      // The owner not being here is the interesting case and it is not a bug: the ring
      // may have named a Wanderer, or the room snapshot may be a pass stale. Two goes.
      this.note('the ring\'s owner was not here', {
        owner: e.owner, room: e.where, attempt: e.failures, why: gave.why,
        note: 'CheckWhyWanted names the correct owner out loud when the wrong NPC is ' +
              'offered a ring — read the journal if this keeps happening' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'the owner was not there'; }
      return true;
    }

    e.returned = gave.returned.length;
    this.tally.signets_returned = (this.tally.signets_returned || 0) + gave.returned.length;
    this.note('returned a signet ring', {
      to: gave.returned.map(r => r.to), still_carrying: gave.carrying,
      paid: skills.signetPayout({ level: c.vitals()?.health?.max ?? null }),
      why: 'walked here on purpose; a ring returned by a character under 30 max health ' +
           'pays ten times its value',
    });
    this.progress('returned a signet ring');

    // 3. BANK IT BEFORE ANYTHING ELSE HAPPENS. bankSurplus() only acts when there is a
    //    teller in the room, which is exactly right for Yevitan — he stands in the Royal
    //    Bank of Jasper, so a Jasper ring pays out and is banked without moving. Anywhere
    //    else this is a no-op and the ordinary bankRun picks it up on a later pass, which
    //    it will: the default threshold is 500 and this just cleared four figures.
    await this.bankSurplus().catch(x => this.note('could not bank the ring money',
      { why: x.message, warning: 'this character is now carrying the payout in a purse' }));

    e.done = true;
    e.why_done = 'handed over';
    return true;
  }

  async runErrand() {
    const e = this.errand;
    if (!e) return false;
    const s = this.s, c = s.client;
    const room = s.world?.room;

    if (e.done || (e.expires && Date.now() > e.expires)) {
      if (e.kind === 'provision')
        this.note('provisioning errand finished',
                  { for: e.supplicant_name, service: e.service, gave: e.gave ?? [],
                    why: e.why_done ?? 'timed out' });
      else if (e.kind === 'signet')
        this.note('signet errand finished',
                  { to: e.owner, town: e.town, returned: e.returned ?? 0,
                    why: e.why_done ?? 'timed out' });
      else
        this.note('loot run finished', { for: e.farmer_name, took: e.took ?? [], why: e.why_done ?? 'timed out' });
      this.errand = null;
      return false;
    }

    // A quartermaster errand is a different job with the same priority: it outranks
    // farming and is outranked by staying alive, and we are already past those branches.
    if (e.kind === 'provision') return this.runProvision(e);
    if (e.kind === 'signet') return this.runSignetReturn(e);

    // 1. Get there. Travel is the risky half and the keeper above us has already
    //    decided we are healthy enough to be doing this at all.
    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('setting out on a loot run')).refused) return true;
      const r = await this.travel(e.room, { origin: keeperOrigin('errand'), maxHops: 14 }).catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the loot run', { to_room: e.room, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the loot run');
        return true;
      }
      this.note('arrived for the loot run', { room: e.room_name, for: e.farmer_name });
      this.progress('reached the loot run');
      return true;
    }

    // 2. Hand over the food FIRST. It is the half of the bargain that pays for itself,
    //    and doing it before looting means a runner that has to leave in a hurry has
    //    already kept its side.
    if (!e.paid) {
      const paid = await this.payFarmer(e).catch(x => ({ gave: [], why: x.message }));
      e.paid = true;
      e.gave = paid.gave ?? [];
      this.note(paid.gave?.length ? 'paid the farmer in food' : 'nothing to pay with yet', {
        to: e.farmer_name, gave: paid.gave, why: paid.why,
        owes: paid.gave?.length ? null : 'half the sale proceeds, to be settled in town' });
    }

    // 3. STAND WHERE THE FARMER STANDS. This is the deliberate exception to one wall
    //    each: sharing a spot is pointless when both parties are fighting, and it is
    //    exactly right when one is fighting and the other is picking up behind them.
    //    The runner is the fragile one in the room and it is about to spend several
    //    passes stationary with its hands full — the wall is worth more to it than to
    //    anyone. Players have done this forever.
    //
    //    It is the farmer's claim, so we do not take it in the register; we just go
    //    and stand there, and the farmer's own keeper still owns it.
    if (!this.hold) {
      const farmerSpot = spotHeldBy(e.farmer);
      if (farmerSpot && farmerSpot.room === room?.num) {
        const near = s.world?.approachSquare?.(farmerSpot.col, farmerSpot.row);
        if (near && near.steps > 0 && near.steps <= 6) {
          this.doing = 'travelling';
          const w = await s.walkTo(near.col, near.row, { maxSteps: near.steps + 6 })
                          .catch(() => ({ arrived: false }));
          this.movedAt = Date.now();
          if (w.arrived) this.note('sheltering beside the farmer', {
            farmer: e.farmer_name, their_spot: { col: farmerSpot.col, row: farmerSpot.row },
            why: 'a loot run is several passes of standing still with full hands — the safest ' +
                 'place to do that is the wall the farmer already proved' });
        }
      }
    }

    //    Pick the floor clean. lootFloor already refuses cursed items and walks only
    //    when it has to; seven squares of reach covers a kill site.
    this.doing = 'trading';
    const l = await s.lootFloor({ maxItems: 12 }).catch(x => ({ taken: [], refused: [], error: x.message }));
    const took = (l.taken || []).map(t => t.name + (t.amount ? ` x${t.amount}` : ''));
    e.took = [...(e.took || []), ...took];
    this.countLoot(took);

    const cap = this.policy.maxCarry ?? 14;
    const full = (c.inventory?.length ?? 0) >= cap;
    if (!took.length || full) {
      e.done = true;
      e.why_done = full ? 'pack is full' : 'nothing left on the floor';
      this.note('loot run collected', {
        for: e.farmer_name, took: e.took, carrying: c.inventory?.length, of: cap,
        next: full ? 'go and sell it, then bank the money' : 'floor is clear' });
      this.progress('collected a loot run');
      return true;
    }
    this.note('picking up', { for: e.farmer_name, took, carrying: c.inventory?.length });
    this.progress('picking up loot');
    return true;
  }

  // Hand over every edible thing we are carrying. A runner is chosen for being poor,
  // so this is usually nothing — and that is fine, it becomes a debt instead. When
  // there IS food, giving all of it is correct: the runner is about to walk to a shop
  // and the farmer is not going anywhere.
  async payFarmer(e) {
    const s = this.s, c = s.need();
    const larder = this.giveableLarder(c);
    if (!larder.length) return { gave: [], why: 'carrying no food' };
    const them = [...c.room.objects.values()]
      .find(o => (o.flags & OF.PLAYER) &&
                 (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(e.farmer_name || '').toLowerCase());
    if (!them) return { gave: [], why: 'the farmer is not in the room' };
    const ids = larder.map(x => x.o.id);
    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, ids));

    // FINISH THE HANDSHAKE. An offer alone moves nothing: the sequence is
    // offer -> they counter (empty, which is how a gift is accepted) -> WE ACCEPT.
    // Stopping at the counter leaves the food sitting on the table until the trade
    // is cancelled, while the journal says "paid the farmer in food" — a hand-over
    // that reads as done in every log we keep and never happened in the world. The
    // farmer's own keeper counters for us in social(), so the only missing half was
    // this one.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 })
                      .catch(() => ({ events: [] }));
    if (!ev.events?.some(x => x.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      return { gave: [], why: 'they never countered, so the gift could not be completed' };
    }
    await s.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(r => setTimeout(r, 1200));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    return { gave: larder.map(x => x.name) };
  }

  // EVERY RECONNECT GOES THROUGH HERE, because a reconnect establishes two things and
  // both of them are easy to establish in only three of the four places it happens:
  //
  //   every object id we are holding is stale — the server reissues them at login
  //   the entry grace period has been handed back, so from now until we act again,
  //     nothing that fails to hit us proves anything about where we are standing
  //
  // The second is the subtle one and it is why this exists as a method. Without it a
  // character reconnects into a corner, sits quietly for a minute because the server
  // is holding the monsters back, and concludes the corner is safe. It is not; it was
  // never tested; and the next time it stands there it will do so believing it can
  // rest through anything.
  async reconnect(why, { offlineMs = 0 } = {}) {
    // A POISONED RELOG MUST OUTLAST THE POISON TIMER, or it doubles the poison. player.kod: PoisonTimer re-arms itself
    // every 10 s only while the player is in the world, and UserLogonHook starts a NEW one whenever poison strength is
    // left -- so a relog inside ten seconds leaves the old timer running beside the new one. Prod 2026-10-27, Fozzie: four
    // relogs while poisoned, two interleaved 5-HP-per-10-s cadences, about -1 HP/s instead of -0.5. Twelve seconds out
    // lets the old timer's next tick find nobody and stop.
    if (poisonedNow(this.s?.client)) offlineMs = Math.max(Number(offlineMs) || 0, POISON_RELOG_OFFLINE_MS);
    const r = await this.s.rejoin(why, { offlineMs }).then(() => ({ ok: true }), e => ({ ok: false, why: e.message }));
    // Stamped even on failure: if we do not know whether we came back, we certainly
    // do not know whether the monsters are awake.
    this.rejoinedAt = Date.now();
    this.foeId = null;
    this.lastObs = null;
    this.campedIds = new Set();
    if (!r.ok) this.note('reconnect failed', { why: r.why, trying_to: why });
    return r;
  }

  // The one call every deliberate departure goes through, so that "we decided to
  // leave" and "we got out alive" are not two different problems solved in five
  // places. Breaks the siege first when there is one, then lets the hold go.
  // GIVING UP A WALL IS A SURVIVAL DECISION, AND MOST CALLERS ARE NOT MAKING ONE.
  //
  // Camilla, 2026-08-06 23:59. At −18.0s the keeper saw 69% health, took a safe spot, and
  // refused to rest in the open. TWO HUNDRED MILLISECONDS LATER, in the same pass, the
  // room check fired — "this room cannot produce our prey — leaving now" — and this
  // method gave up the wall it had just taken, `held_s: 0`. She walked out at 20/29 with
  // two monsters on her and was dead 17.8 seconds later, without swinging once.
  //
  // Both decisions were individually right and nothing arbitrated between them. So the
  // arbitration lives here, at the one place they both go through: A DISCRETIONARY
  // DEPARTURE FROM A HELD SPOT IS REFUSED WHILE HURT. Routing, roaming, banking and
  // errands are all discretionary — the room will still be the wrong room in thirty
  // seconds. Withdrawing from a fight is not, and passes `force`.
  //
  // `readyToLeaveSanctuary` is the same rule for inns and does not cover this: it returns
  // true immediately unless `sanctuary()`, and a monster room with a proven wall in it is
  // not a sanctuary. It is, however, the safest place in the world for a hurt character —
  // nothing can hit you there unless you swing first — which is exactly why leaving is
  // the mistake.
  //
  // IT CANNOT DEADLOCK. Refusing returns the pass, the rest gate above sees `hurt` and
  // `sheltered` and rests to full on the wall, and the next attempt is allowed. If that
  // somehow never happens the wait is capped and it goes anyway, saying so — the same
  // shape as the sanctuary hold, and for the same reason: a condition that cannot be met
  // is a character retired by accident.
  async leaveHold(why, { force = false } = {}) {
    // NO WALL IS NOT THE SAME AS NOTHING TO DECIDE. #movement
    //
    // This line used to read `if (!this.hold) return { left: false };` — a character holding
    // nothing was waved through the discretionary-departure gate without its health ever being
    // looked at. That is the hole every one of these deaths went through.
    //
    // MEASURED over the 268 travelling deaths since 2026-09-01, on the 163 where the departure
    // itself is inside the frame ring:
    //
    //     131 of 163 (80%)  set off ALREADY BELOW their own flee line
    //     128 of 163 (79%)  below the flee line AND holding nothing   <- this branch
    //       4 of 163        were holding a wall                       <- the branch below
    //      13 of 163  (8%)  set off at full health
    //
    //   modal departure health 20-29%; 26 of them set off under 10%; median time from
    //   setting off to dying TWENTY-FIVE SECONDS, p10 six seconds.
    //
    // The rule below — a discretionary departure is refused while hurt — was already exactly
    // right, and it governed four departures out of a hundred and sixty-three. Camilla is named
    // in it for giving up a proven wall at 69%; these characters never had a wall to give up,
    // so the rule never ran. The fleet was not ignoring the gate. It was walking past it.
    //
    // SO THE ANSWER IS TO TAKE A WALL, NOT TO STAND HERE. Refusing on its own would be the
    // same bug pointing the other way, and `readyToLeaveSanctuary` says why in its first line:
    // "a character standing in a monster room must never be held there by this — that is the
    // worse direction". Once a wall is taken this becomes the ordinary held case, which already
    // rests to full on the wall, caps the wait at HOLD_WHILE_HURT_MAX_MS and goes anyway.
    //
    // AND IF NO WALL CAN BE TAKEN, THE JOURNEY GOES. Standing hurt in a room that spawns, with
    // nothing to put our back against, is worse than walking — that is the whole argument of
    // the rung at `going somewhere safe to recover`, and it is why this is not capped here: the
    // two outcomes are "we are behind a wall now" and "we are leaving now", never "we are
    // waiting in the open".
    //
    // WHY HERE AND NOT IN `travel()`. The confinement gate one screen down argues that the
    // single door every journey passes through is the place to enforce a rule, and for THAT
    // rule it is. Not for this one: `travel()` is also how a character flees to town after
    // fleeing twice (`:4749`) and how it walks out of the room it respawned in (`:12918`), and
    // both of those are journeys begun BECAUSE the character is hurt. Gating the door would
    // have refused the two cases where travelling hurt is the correct answer. `leaveHold` is
    // already the discretionary-only gate — its thirteen callers are the discretionary
    // departures, and the non-discretionary ones pass `force`.
    if (!this.hold) return force ? { left: false } : await this.wallUpBeforeSettingOff(why);
    if (!force) {
      const hp = pct(this.s.client?.vitals?.()?.health);
      const floor = this.policy.restBelow ?? 0.7;
      if (hp !== null && hp < floor) {
        this.holdKeptSince ??= Date.now();
        const kept = Date.now() - this.holdKeptSince;
        if (kept < HOLD_WHILE_HURT_MAX_MS) {
          // Once per hold rather than once per pass: this fires every second otherwise.
          if (!this.holdKeptNoted) {
            this.holdKeptNoted = true;
            this.note('staying on the wall — too hurt to go anywhere discretionary', {
              wanted_to: why, health: Math.round(hp * 100) + '%',
              rest_below: Math.round(floor * 100) + '%',
              proven: this.holdWorks?.() ?? null,
              why: 'a held safe spot is the safest square available and the errand is not ' +
                   'urgent. Rest here first — this is the decision that killed Camilla, ' +
                   'who gave up a proven wall at 69% and died 17.8s later',
            });
          }
          this.holdKept = (this.holdKept || 0) + 1;
          return { left: false, refused: true, health: hp, wanted_to: why };
        }
        this.note('leaving the wall anyway — waited long enough', {
          wanted_to: why, health: Math.round(hp * 100) + '%',
          waited_s: Math.round(kept / 1000),
          why: 'held for the cap without recovering. A wait that cannot end is a stall ' +
               'worth seeing rather than a wait worth continuing' });
      }
      this.holdKeptSince = null;
      this.holdKeptNoted = false;
    }
    const out = await this.breakOut(why).catch(e => ({ did: false, why: e.message }));
    const stepped = await this.stepOutOfThePocket(why);
    this.releaseHold(why);
    return { left: true, reconnected: !!out.did, crowd: out.crowd ?? 0,
             ...(stepped ? { stepped_out_of_the_pocket: stepped } : {}) };
  }

  // HURT, IN THE OPEN, AND ABOUT TO WALK ACROSS THE WORLD. TAKE A WALL FIRST. #movement
  //
  // The `leaveHold` branch above; the measurement and the argument are there. This turns
  // "hurt and holding nothing" into "hurt and holding a wall", after which the existing rule
  // governs the departure — including its cap and its `leaving the wall anyway` escape. It
  // decides nothing about the journey itself and never cancels one that is already running.
  //
  // THREE ANSWERS, AND ONE OF THEM IS NOT "WAIT IN THE OPEN":
  //   * not hurt, or in a sanctuary   -> go, unchanged. `readyToLeaveSanctuary` owns the inn.
  //   * a wall was taken              -> refuse THIS attempt; the rest rung fills the bars and
  //                                      the next attempt is the ordinary held case.
  //   * no wall could be taken        -> go, and say so. Standing here is the worse option.
  async wallUpBeforeSettingOff(why) {
    const hp = pct(this.s.client?.vitals?.()?.health);
    const floor = this.policy.restBelow ?? 0.7;
    // A null reading is "no such bar", not "empty" — the same rule every other gate here
    // follows. Blocking on a missing number is how a character gets retired by accident.
    if (hp === null || hp >= floor) {
      this.setOffHurtNoted = false;
      return { left: false };
    }
    // An inn already has a gate with a longer rule than this one, and running both would mean
    // two thresholds for one question.
    if (this.sanctuary()) return { left: false };
    // Recover locally before starting the journey; its destination can wait.
    const took = await this.takeRecoverySpot(why, { source: 'travel' })
                           .catch(e => ({ took: false, why: e.message }));
    if (took?.took) {
      this.setOffHurtNoted = false;
      this.note('taking a wall before setting off — too hurt to start a journey', {
        wanted_to: why, health: Math.round(hp * 100) + '%',
        rest_below: Math.round(floor * 100) + '%',
        where: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
        why: 'eighty per cent of this fleet\'s travelling deaths set off already below the ' +
             'flee line and holding nothing, and the median one was dead twenty-five seconds ' +
             'later. The destination will still be there once the bar is full',
        note: 'the journey is not cancelled — this refuses one attempt. Resting on the wall ' +
              'happens below, and the next attempt goes through the ordinary held rule',
      });
      this.tally.walled_up_before_setting_off =
        (this.tally.walled_up_before_setting_off || 0) + 1;
      // Progress, and truthfully: a wall was taken. This is not the `progress()`-on-a-refusal
      // that hid these bodies from every stall detector — something changed.
      this.progress('took a wall instead of setting off hurt');
      return { left: false, refused: true, sheltering: true, health: hp, wanted_to: why };
    }
    // NOWHERE TO MEND. Say it once per episode rather than once per pass, and GO.
    if (!this.setOffHurtNoted) {
      this.setOffHurtNoted = true;
      this.note('setting off hurt — nothing here to put our back against', {
        wanted_to: why, health: Math.round(hp * 100) + '%',
        rest_below: Math.round(floor * 100) + '%',
        could_not_shelter: took?.why ?? 'no wall found',
        why: 'a character standing hurt in a room that spawns, with no wall available, is not ' +
             'made safer by being held here. This is the worse-direction case that ' +
             'readyToLeaveSanctuary refuses to create, so the journey stands',
        note: 'this is the departure that kills, recorded rather than prevented — a run of ' +
              'these is a room that needs a safe spot in the book, not a threshold change',
      });
    }
    this.tally.set_off_hurt_unsheltered = (this.tally.set_off_hurt_unsheltered || 0) + 1;
    return { left: false };
  }

  /**
   * A SAFE SPOT IS A POCKET THE ROUTER CANNOT PLAN OUT OF. WALK OUT THE WAY YOU CAME IN.
   *
   * This is written down in docs/m59-routing.md — "a safe spot is a pocket the router
   * frequently cannot plan out of, which is what breadcrumbs are for" — and it became live
   * the moment safe spots started being REAL walls. A real wall is a square the coarse grid
   * refuses; that refusal is the whole mechanism, and it applies to us as much as to the
   * thing that wanted to eat us. The router plans on the coarse grid, so standing on a
   * square that grid says does not exist, it cannot plan anything at all.
   *
   * Measured, Bbbb, The Twisted Wood, this afternoon. It sheltered, rested to full, resumed
   * — and then spent four hundred and twenty-six seconds failing to leave a room it had
   * crossed in twenty-five when it was healthy:
   *
   *   18:24:39  to 598  cancelled by a travel guard rung taking the character back
   *   18:27:09  to 598  every square for that exit refused (4 tried)
   *   18:28:08  to 598  every square for that exit refused (4 tried)
   *   ... seven times, fifty to sixty seconds each, until the leg ran out of clock
   *
   * Every exit square refused, from a body standing two squares from where it had been
   * walking perfectly well a minute earlier. Not a routing bug and not a bad exit: the
   * character was in the pocket its own shelter had put it in.
   *
   * BREADCRUMBS RATHER THAN A COARSE-GRID ESCAPE, for the reason `retreatAlongBreadcrumbs`
   * already argues at length: the grid and the BSP disagree exactly where the walls are, and
   * relaxing collision there is the failure this repository exists to protect against. The
   * way in was a sequence of validated steps, so the way out is the same sequence backwards.
   *
   * `until` stops the retreat the moment the coarse grid admits the square again — the goal
   * is to get out of the pocket, not to undo the journey.
   */
  async stepOutOfThePocket(why = 'leaving a wall') {
    const geo = this.s?.world?.geometry;
    const me = this.s?.client?.self;
    if (!geo || !me || typeof geo.walkable !== 'function') return null;
    // Only from a square the coarse grid refuses. On ordinary floor the router is fine and
    // unwinding a trail would be a detour bought for nothing.
    if (geo.walkable(me.row, me.col) !== false) return null;
    if (typeof this.s.retreatAlongBreadcrumbs !== 'function') return null;

    const back = await this.s.retreatAlongBreadcrumbs({
      maxCrumbs: 8,
      until: at => at && geo.walkable(at.row, at.col) === true,
    }).catch(e => ({ moved: 0, reason: e.message }));

    const now = this.s?.client?.self;
    const outNow = now ? geo.walkable(now.row, now.col) === true : null;
    this.note('stepped back out of the pocket the wall put us in', {
      why, from: { col: me.col, row: me.row }, to: now ? { col: now.col, row: now.row } : null,
      crumbs_walked: back?.moved ?? 0, on_walkable_ground_now: outNow,
      note: 'a real safe spot is a square the COARSE grid refuses, and the router plans on ' +
            'the coarse grid — so a body left standing there can be refused every exit in ' +
            'the room. Bbbb spent 426s in The Twisted Wood exactly that way',
      ...(outNow === false ? { still_stuck: back?.reason ?? 'the trail ran out' } : {}),
    });
    return { crumbs: back?.moved ?? 0, out: outNow };
  }

  // HOLD THE SWING AND WATCH.
  //
  // The one state that can prove a wall is being next to something that wants to kill
  // you and NOT hitting it — and a keeper that attacks every pass never enters it. So
  // proof used to arrive only by accident, when a fight went badly enough to force a
  // rest, which is precisely the moment the proof is too late to be worth anything.
  //
  // This makes it deliberate: a monster has walked to the wall, the spot is untested,
  // so hold the attack for a pass or two and let observe() adjudicate. It costs a few
  // seconds and it buys holdWorks() for the whole rest of the fight — which is what
  // makes breaking off free, and resting to full possible.
  //
  // Budgeted per session rather than done once and trusted for ever: walls do not
  // move, but maps get rebuilt and rooms renumbered, and a handful of fresh readings
  // each session is what keeps the book from ageing into fiction.
  //
  // Returns true if the caller should NOT attack this pass.
  maybeTestSpot(adjacent) {
    if (!this.hold || this.holdWorks() || !adjacent.length) { this.spotTest = null; return false; }
    const at = `${this.hold.col},${this.hold.row}`;
    if (this.spotTest && this.spotTest.at !== at) this.spotTest = null;   // a different square
    if (!this.spotTest) {
      if (this.hold.failures) return false;                                // already disproved
      if ((this.spotTestsRun || 0) >= (this.policy.spotTestsPerSession ?? 3)) return false;
      this.spotTestsRun = (this.spotTestsRun || 0) + 1;
      this.spotTest = { at, since: Date.now(), passes: 0 };
      this.note('holding the swing to test this spot', {
        where: { col: this.hold.col, row: this.hold.row },
        adjacent: adjacent.length, test: this.spotTestsRun,
        of: this.policy.spotTestsPerSession ?? 3,
        why: 'something has come to the wall and we have never tested this square. Standing ' +
             'still without swinging is the only thing that can prove it, and proving it now ' +
             'is worth far more than proving it after the fight has gone wrong.' });
    }
    this.spotTest.passes++;
    // Two passes covers the proof window; three is the cap, so a creature that
    // wanders off again cannot leave us standing here indefinitely.
    if (this.spotTest.passes > 3) {
      this.note('stopped testing this spot — nothing conclusive', {
        where: { col: this.hold.col, row: this.hold.row },
        why: 'three passes without a clean verdict; getting on with the fight' });
      this.spotTest = null;
      return false;
    }
    // Standing still on purpose is not idling, and must not read as a stall.
    this.doing = 'recovering';
    this.progress('testing a safe spot');
    return true;
  }

  // WHAT THIS CHARACTER IS DOING, in the words someone watching would use.
  //
  // `doing` is the time-accounting bucket and is too coarse to read — "recovering"
  // covers eating, resting and waiting out a digestion clock. This is the one-line
  // answer to "what is it up to?", which is the question a fleet page is for.
  // PARK: FINISH WHAT YOU ARE DOING, GET BEHIND A WALL, AND STOP.
  //
  // A broker restart stops all twenty-one keepers at once, and a stopped keeper is not
  // a paused character — it is a character held still in whatever fight it was in while
  // everything already swinging at it carries on. That is why deaths arrive in waves
  // after a restart, and it is the whole reason m59-uptime.mjs exists.
  //
  // Parking is the fix, and the only part of it that matters is WHEN it takes effect:
  // not mid-swing, not mid-route, but at the next point the keeper would have chosen a
  // new action anyway. So the check sits in pass() exactly where the mode dispatch does
  // — past death, danger and rest — and everything above it still runs. A parked
  // character that is attacked still defends itself, still flees, still escapes the
  // Underworld. It simply stops picking new fights.
  //
  // `ready` is the handshake. The orchestrator waits for every keeper to raise it before
  // it restarts anything, so the outage lands on a fleet that is standing behind walls
  // rather than one that is mid-pull.
  park(why = 'a fleet update is waiting for us') {
    if (!this.parking) {
      this.parking = { why, at: Date.now(), ready: false, tries: 0, since: null };
      this.note('parking for a fleet update', {
        why, what_happens: 'this pass finishes, then the keeper takes a wall and holds it. ' +
          'It will not start another fight. Danger, flight and death handling are unaffected' });
    }
    return this.parkStatus();
  }

  unpark(why = 'the update finished') {
    if (this.parking) this.note('unparked', { why });
    this.parking = null;
    return this.parkStatus();
  }

  parkStatus() {
    if (!this.parking) return null;
    return { parked: true, ready: !!this.parking.ready, why: this.parking.why,
             waiting_for_s: Math.round((Date.now() - this.parking.at) / 1000),
             holding: this.hold ? { col: this.hold.col, row: this.hold.row,
                                    proven: this.holdWorks() } : null };
  }

  // How long we will keep trying for a wall before reporting ready without one. A
  // character that cannot find a wall must not hold the whole fleet's update hostage —
  // and standing still in the open is still strictly better than being stopped mid-fight
  // there, because a parked keeper is awake and a stopped one is not.
  static PARK_GRACE_MS = 90_000;
  // @end 1
}
