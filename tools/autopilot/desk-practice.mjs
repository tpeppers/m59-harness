// ROOM ENCHANT POSTS, PRACTICE AT A DESK, BUFFING ALLIES.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 10 methods: isRoomEnchantPost, maintainRoomEnchantPost, roomEnchantAllows, roomEnchant,
//   practiceSafeSpot, practiceSessionDue, practiceAtDesk, buffAllies, practiceBuyHere, reagentExact
import { allyVerdict } from '../m59-ally.mjs';
import { withCastRite } from '../m59-castrite.mjs';
import { castsAbove, folRoomsOf } from '../m59-chalice.mjs';
import { buyHereWants, choosePractice, deskReserve, isReagent, normalizePractice, offeredServices, pickCreatureTarget, touchedCreatures } from '../m59-deskpractice.mjs';
import { OF, affordances, buyLines } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { practiceOutcome, tranceMs } from '../m59-trance.mjs';
import { Autopilot, REST_VIGOR_CAP } from '../m59-autopilot.mjs';

// How long a practice spell whose trance was BROKEN is set aside (at least refused_ms): long enough that a leak stops
// draining reagents, short enough that one stray break does not end a night's drill.
export const PRACTICE_BROKEN_ASIDE_MS = 10 * 60_000;

export class DeskPracticePart {
  // @part 1

  isRoomEnchantPost() {
    return this.mode === 'idle' && this.policy.roomEnchant?.enabled === true
      && Number.isInteger(this.policy.assignedRoom)
      && this.s.world?.room?.num === this.policy.assignedRoom
      && !this.inert && !this.suspendedJourney && !this.busyStatus()
      && !this.facultyHeld('work') && !this.facultyHeld('movement');
  }

  async maintainRoomEnchantPost({ acquire = false } = {}) {
    if (!this.isRoomEnchantPost()) return false;
    // A posted caster may also be the CHALICE HOLDER; a hand-off in flight outranks a recast.
    if (await this.chaliceDuty().catch(e => { this.note('chalice duty failed', { why: e.message }); return false; }))
      return true;
    if (!this.holdWorks()) {
      if (acquire && !this.hold && (!this.enchantWallTriedAt || Date.now() - this.enchantWallTriedAt > 10000)) {
        this.enchantWallTriedAt = Date.now();
        await this.takeRecoverySpot('stationary room caster needs shelter');
      }
      return true;
    }
    const v = this.s.client?.vitals?.();
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.9
        || (this.frozenUntil && Date.now() < this.frozenUntil)
        || this.threat().landing > 0) return false;
    if (this.policy.acceptDonations) await this.acceptDonations();
    await this.roomEnchant();
    // Short mana rests let the enchantment timer be checked again promptly.
    // A damaged refuge still goes through the existing rest-interruption path.
    const mana = this.s.client?.vitals?.()?.mana;
    if (this.holdWorks() && mana?.max > 0 && mana.value < mana.max * 0.95) {
      const r = await skills.restUntil(this.s, {
        health: 0.99, vigor: REST_VIGOR_CAP, mana: 0.95, maxSeconds: 5,
      });
      if (r.interrupted) await this.restBroken(this.s.world?.room, this.inReachOfUs());
    }
    return true;
  }

  // WHERE A ROOM ENCHANTMENT MAY BE CAST AT ALL. Operator, 2026-10-07: "limit Loial's forces
  // of light to only being cast in map 38". `roomEnchant.rooms` names the rooms; absent or empty
  // means any room, which is the behaviour that was already there. It binds every path that
  // casts — the posted caster, and a chalice holder's forces-of-light visit — because the gap it
  // closes is the one where the chalice config is not loaded yet (the first seconds after a
  // keeper restart) and the post's own order would light the room he waits in.
  roomEnchantAllows(room, cfg = this.policy?.roomEnchant) {
    const rooms = Array.isArray(cfg?.rooms) ? cfg.rooms.map(Number).filter(Number.isInteger) : [];
    return !rooms.length || rooms.includes(Number(room));
  }

  async roomEnchant({ remote = false } = {}) {
    const cfg = this.policy.roomEnchant;
    if (!cfg || cfg.enabled === false) return;
    const here = this.s.world?.room?.num;
    if (!this.roomEnchantAllows(here, cfg))
      return remote ? { cast: false, why: `room ${here} is not in room_enchant.rooms` } : undefined;
    // A CHALICE HOLDER WITH A FORCES-OF-LIGHT ROOM casts only there, on request, by stepping
    // in from its post (`chaliceDuty`, job `fol`). Standing at the post it casts nothing —
    // lighting the room it waits in would spend the reagents on nobody.
    const fol = this.chaliceCfg ? folRoomsOf(this.chaliceCfg).length : 0;
    if (!remote && fol && this.chaliceRole() === 'holder') return;
    // A posted caster must not spend its supplies in the room it logs into while
    // the operator is still placing it, or after survival evacuates the post.
    if (!remote && this.mode === 'idle' && this.policy.assignedRoom != null
        && this.s.world?.room?.num !== this.policy.assignedRoom) return;
    const s = this.s, c = s.need();

    const wanted = [].concat(cfg.spells ?? Autopilot.ROOM_ENCHANTS.map(e => e.name))
      .map(x => String(x).toLowerCase());
    this._enchantedAt ||= new Map();        // `${roomId}:${spell}` -> when we last cast it

    for (const ench of Autopilot.ROOM_ENCHANTS) {
      if (!wanted.includes(ench.name)) continue;
      const spell = (c.spells || [])
        .find(sp => String(c.rsc.get(sp.nameRsc) || '').toLowerCase() === ench.name);
      if (!spell) continue;                                    // not a caster of this one

      // STILL STANDING? Keyed on the ROOM, because walking into a different room means the
      // enchantment we are tracking is not the one over our head any more.
      const roomId = c.room?.id ?? c.room?.num ?? 'unknown';
      const ability = c.abilities?.get?.(spell.id)?.ability ?? cfg.assume_ability ?? 20;
      const power = Math.floor(Number(ability || 0) / 2);
      const margin = Number(cfg.margin_ms) >= 0 ? Number(cfg.margin_ms) : 8000;
      const holdMs = Math.max(5000, ench.durationMs(power) - margin);
      const last = this._enchantedAt.get(`${roomId}:${ench.name}`);
      // A REMOTE CAST WAS ASKED FOR BY SOMEBODY STANDING IN THE ROOM, whose shared clock says it
      // is dark. Our own clock is not a reason to walk in and do nothing.
      if (!remote && last && Date.now() - last < holdMs) continue;  // still up, by our own clock

      const mana = c.vitals()?.mana;
      const floor = Number(cfg.mana_floor) >= 0 ? Number(cfg.mana_floor) : ench.mana + 4;
      if (mana && mana.value < floor)
        return this.declinedCast(ench.name, 'not enough mana',
          { mana: mana.value, needs: floor });

      // REAGENTS BEFORE THE CAST. A cast that cannot pay is refused server-side and is
      // silent from here -- indistinguishable from one that worked. Report which one ran
      // out and how many are left, because the pair is unbalanced in practice and the
      // scarce half is not the one anybody watches.
      //
      // AND NOT OUT OF WHAT IS KEPT BACK. The chalice holder's last emeralds pay for the
      // Rescue that starts his supply trip; spending them on the room is what made him walk.
      const keep = this.chaliceReagentFloor();
      const short = ench.reagents.filter(([n, k]) => this.reagentOnHand(n) - (keep[n] || 0) < k);
      if (short.length) {
        const have = ench.reagents.map(([n, k]) => `${n} ${this.reagentOnHand(n)}/${k}` +
          (keep[n] ? ` (keeping ${keep[n]})` : '')).join(', ');
        const casts = castsAbove(Object.fromEntries(ench.reagents.map(([n]) => [n, this.reagentOnHand(n)])),
                                 ench.reagents, keep);
        this.declinedCast(ench.name, 'out of reagents',
          { have, casts_left: casts,
            note: 'a donation of the SHORT reagent extends this; the other half is not the limit' });
        continue;
      }

      // Resting blocks magic. Standing changes posture, not the refuge position.
      if (this.frozenUntil && Date.now() < this.frozenUntil) return;
      await skills.standToAct(s);
      const beforeReagents = ench.reagents.map(([n]) => this.reagentOnHand(n));
      // NO TARGET. This is the whole difference from buffAllies -- see ROOM_ENCHANTS.
      await withCastRite(s, { spell, targets: [], why: 'roomEnchant' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));
      await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
      const paid = ench.reagents.every(([n, k], i) => beforeReagents[i] - this.reagentOnHand(n) >= k);
      // An early renewal can be refused while the old enchantment is still up.
      // That must not start another full-duration timer and leave the room dark.
      if (!paid) {
        this._enchantedAt.set(`${roomId}:${ench.name}`, Date.now() - holdMs + 3000);
        return { cast: false, spell: ench.name, why: 'the cast did not pay — refused, or still up' };
      }
      this._enchantedAt.set(`${roomId}:${ench.name}`, Date.now());
      this.tally.room_enchants = (this.tally.room_enchants || 0) + 1;
      const left = Math.min(...ench.reagents.map(([n, k]) => Math.floor(this.reagentOnHand(n) / k)));
      this.note('room enchantment cast', { spell: ench.name, room: roomId,
        holds_for_ms: holdMs, casts_left: left });
      return { cast: true, spell: ench.name, holdMs, casts_left: left };   // one cast a pass
    }
  }

  // PRACTISE AT THE DESK, NEVER BELOW WHAT THE DESK IS OWED.
  //
  // Operator, 2026-09-25: a service character building spells in its idle time, keeping "enough
  // mana in reserve for 2x casts of its most expensive service". The reserve is DERIVED — from
  // the chalice menu this character serves and the spells it actually knows — in
  // m59-deskpractice.mjs, which is pure and pinned by m59-deskpractice-test.mjs. This half does
  // what only a keeper can: stand up, cast, and read the mana back.
  //
  // WHAT IT WILL NOT DO. It never moves the character — practice happens at the post or not at
  // all. It never casts while a desk job is in flight, an errand or journey owns the body, or
  // something is swinging. And it never trusts that a cast happened: a cast that spent no mana
  // was refused in silence (a room already lit, a heal on somebody whole, a resting caster), so
  // that spell is set aside for `refused_ms` and the next pass tries the next one.
  //
  // STAND ON A SAFE SPOT FOR A CREATURE-TARGET PRACTICE CAST, by the regular safe-spot code: a known safe
  // wall under us is adopted as the hold (adoptRecoveryWall); otherwise the nearest one is walked to
  // (takeSafeSpot, recovery, nearest only) and adopted on arrival. No play-dead -- this is a drill, not a
  // recovery. A failed walk waits 20 s before the next try, so a room with no reachable wall is not a treadmill.
  async practiceSafeSpot() {
    if (this.adoptRecoveryWall()) return true;
    if (this._practiceSpotTriedAt && Date.now() - this._practiceSpotTriedAt < 20_000) return false;
    this._practiceSpotTriedAt = Date.now();
    const generation = this.s.movementGeneration;
    const r = await this.takeSafeSpot('practice from a safe spot', null, { source: 'practice', recovery: true, nearestOnly: true })
      .catch(e => ({ took: false, why: e.message }));
    if (r?.cancelled || this.s.movementWasCancelled?.(generation)) return false;
    return !!(r?.took && this.adoptRecoveryWall());
  }

  // True only when it did something with the pass — a cast, or a short mana rest on a held
  // wall while blocked by the reserve. Every other answer hands the pass back unchanged.
  // IS A PRACTICE SESSION IN ANOTHER ROOM DUE, AND COULD IT CAST AT LEAST ONCE? The entry, or null.
  // The same reserve and the same choice the desk uses, so a session never starts that would
  // spend what the next customer is owed — it is simply the desk's practice, somewhere else.
  //
  // `ignoreMana` asks the other question — could it cast if mana were full? — which is what the
  // desk uses to decide whether to hold its mana for a `mana_full` session (practiceAtDesk).
  practiceSessionDue(now = Date.now(), { ignoreMana = false } = {}) {
    const cfg = normalizePractice(this.policy.practiceSpells);
    if (!cfg || cfg.enabled === false) return null;
    const entry = cfg.spells.find(sp => sp.room != null && sp.room !== this.hereRoom());
    if (!entry) return null;
    const c = this.s?.client;
    const v = c?.vitals?.();
    if (!ignoreMana) {
      if (entry.when === 'mana_full') {
        // FULL MEANS FULL, within a point of rounding; and a floor of 10 s between sessions so
        // a session that ended on a refusal does not walk straight back through the door.
        if (!(v?.mana?.max > 0) || v.mana.value < v.mana.max - 1) return null;
        if (this._practiceSessionAt && now - this._practiceSessionAt < 10_000) return null;
      } else if (this._practiceSessionAt && now - this._practiceSessionAt < entry.every_ms) return null;
    }
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.9) return null;
    // The pushed ability rides along so choosePractice can skip a spell already at 99.
    const spells = (c.spells || []).map(sp => ({
      id: sp.id, name: String(c.rsc.get(sp.nameRsc) || '').toLowerCase(), targets: sp.numTargets ?? 0,
      ability: c.abilities?.get?.(sp.id)?.ability ?? null }));
    const role = this.chaliceRole();
    const services = role === 'holder' || role === 'alternate' ? offeredServices(this.chaliceCfg) : [];
    const one = { ...cfg, spells: [entry] };
    const reserve = deskReserve({ practice: one, services, known: spells.map(x => x.name),
                                  keep: this.chaliceReagentFloor() });
    const mana = ignoreMana && v?.mana?.max > 0 ? { value: v.mana.max, max: v.mana.max } : v?.mana;
    const choice = choosePractice({ practice: one, spells, mana, reserve, now,
                                    have: (item) => this.reagentOnHand(item),
                                    refusedUntil: this._practiceRefused ?? new Map() });
    if (!ignoreMana) this.practiceSessionState = { at: now, entry: entry.name, room: entry.room, why: choice.why };
    return choice.cast ? entry : null;
  }

  // `session` is set only by the chalice holder's practice job (chaliceStep 'practice:cast'): the
  // body is already in the practice room on a wall, and only the entries for THIS room are cast.
  async practiceAtDesk({ session = null } = {}) {
    const loaded = normalizePractice(this.policy.practiceSpells);
    if (!loaded || loaded.enabled === false) return false;
    if (loaded.problems?.length && this._practiceProblemsSaid !== loaded.problems.join('|')) {
      this._practiceProblemsSaid = loaded.problems.join('|');
      this.note('desk practice config problems', { problems: loaded.problems });
    }
    // Somebody else, or a job of our own, has the body. A practice SESSION is itself a chalice
    // job, so it is the one caller allowed past `_chaliceServe`.
    if (this.townTrip || this.travelInterrupted?.() || this.suspendedJourney || this.errand
        || this.parking || (this.inert && !this.inert.travelling) || this.busyStatus?.()
        || (this._chaliceServe && !session) || this._holderCargo) return false;
    const now = Date.now();
    if (this.frozenUntil && now < this.frozenUntil) return false;
    if (this._practiceAt && now - this._practiceAt < loaded.gap_ms) return false;

    // WHICH ENTRIES APPLY HERE. An entry with a `room` is practised only in that room and only
    // inside a session; everything else only at the desk, as before.
    const here = this.hereRoom();
    const cfg = { ...loaded, spells: loaded.spells.filter(sp => session
      ? sp.room === here : (sp.room == null || sp.room === here)) };
    if (!cfg.spells.length) return false;
    // THE DESK HOLDS ITS MANA FOR A `mana_full` SESSION. Otherwise desk practice spends a cast
    // every gap_ms and the mana never reaches full, so the session never starts. Only while that
    // session could actually cast (reagents on hand) and only for the holder, who runs sessions;
    // out of purple mushrooms, the desk practises as before and no regeneration is wasted.
    if (!session && this.chaliceRole?.() === 'holder'
        && this.practiceSessionDue(now, { ignoreMana: true })?.when === 'mana_full') {
      this.practiceState = { at: now, last: 'holding mana for a practice session that starts at full mana' };
      return false;
    }

    const chalice = this.chaliceCfg;
    const rooms = session ? [here] : cfg.rooms.length ? cfg.rooms
      : [this.policy.assignedRoom, chalice?.post_room, chalice?.station_room]
        .map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!rooms.length)
      return this.declinedCast('practice', 'no post to practise at: set practice rooms, an assigned room, or a chalice post');
    if (!rooms.includes(here)) return false;

    const s = this.s, c = s.need();
    const v = c.vitals?.();
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.9) return false;
    if (this.threat().landing > 0) return false;
    // A POSTED CASTER PRACTISES ONLY FROM ITS WALL. `maintainRoomEnchantPost` takes shelter before
    // it casts anything, even at full health; practice must not be the one cast that happens in
    // the open — the desk this was written for is a 20-max-health body.
    if (this.isRoomEnchantPost?.() && !this.holdWorks()) return false;
    // THE PRACTICE SPOT: in its room, walk to within 2 squares of it first (one try per 30 s), and practise from the
    // next pass on, standing still as before. Not during a session elsewhere, and never at less than the 90% above.
    const spot = cfg.spot;
    if (spot && !session && spot.room === Number(here) && c.self) {
      const off = Math.max(Math.abs(c.self.row - spot.row), Math.abs(c.self.col - spot.col));
      if (off > 2) {
        if (this._practiceSpotWalkAt && Date.now() - this._practiceSpotWalkAt < 30_000) return false;
        this._practiceSpotWalkAt = Date.now();
        this.doing = 'walking to the practice spot';
        const r = await s.walkTo(spot.col, spot.row, { maxSteps: 40 }).catch(e => ({ arrived: false, reason: e.message }));
        this.movedAt = Date.now();
        if (!r?.arrived) this.note('could not reach the practice spot', { spot, why: r?.reason ?? 'no answer' });
        return true;
      }
    }

    // The pushed ability rides along so choosePractice can skip a spell already at 99.
    const spells = (c.spells || []).map(sp => ({
      id: sp.id, name: String(c.rsc.get(sp.nameRsc) || '').toLowerCase(), targets: sp.numTargets ?? 0,
      ability: c.abilities?.get?.(sp.id)?.ability ?? null }));
    const role = this.chaliceRole();
    const services = role === 'holder' || role === 'alternate' ? offeredServices(chalice) : [];
    const reserve = deskReserve({ practice: cfg, services, known: spells.map(x => x.name),
                                  keep: this.chaliceReagentFloor() });
    this._practiceRefused ||= new Map();
    // SHORT OF A REAGENT A COUNTER IN THIS ROOM SELLS: BUY IT HERE (buy_here), then practise from the next pass.
    if (!session && cfg.buy_here && await this.practiceBuyHere(cfg, spells, reserve, now)) return true;
    const choice = choosePractice({ practice: cfg, spells, mana: v?.mana, reserve, now, vigor: v?.vigor?.value ?? null,
                                    have: (item) => this.reagentOnHand(item),
                                    refusedUntil: this._practiceRefused });
    this.practiceState = { at: now, reserve: reserve.mana, reserve_why: reserve.why,
                           reagents_kept: reserve.reagents, last: choice.why };
    if (!choice.cast) {
      // A SESSION THAT CANNOT CAST AGAIN IS OVER. It does not sit down in a skeleton room to wait
      // for mana: the desk is where the mana comes back, and where a customer can find him.
      if (session) { session.done = choice.why; return false; }
      // Below the reserve and nothing else in the way: win the mana back, on a held wall only.
      if (choice.blocked === 'mana' && cfg.rest_seconds > 0 && this.holdWorks()) {
        const r = await skills.restUntil(s, { health: 0.99, vigor: REST_VIGOR_CAP, mana: 0.95,
                                              maxSeconds: cfg.rest_seconds });
        if (r.interrupted) await this.restBroken(this.s.world?.room, this.inReachOfUs());
        return true;
      }
      return this.declinedCast('practice', choice.blocked ?? 'none',
        { why: choice.why, reserve: reserve.mana, reserve_why: reserve.why });
    }

    const spell = spells.find(x => x.name === choice.cast.name);
    // A CREATURE TARGET IS PRACTISED FROM A SAFE SPOT AND NOWHERE ELSE. Operator, 2026-09-25:
    // "Have Loial practice dazzle on skeletons from safe spots" — a 20-max-health caster in
    // Castle Victoria. Casting at a skeleton invites it, so the square has to be one that
    // nothing in reach can hit. The SAME safe-spot code as resting and recovery decides that
    // (operator, 2026-10-11: "we know where safe spots are now ... use the same regular safe spot
    // code as everywhere else"): stand on a known safe wall, or walk to the nearest one. It used to
    // demand a wall a monster had PROVEN, which a character that is never attacked never gets.
    let creature = null;
    if (choice.cast.target === 'creature') {
      if (!(await this.practiceSafeSpot())) {
        this._practiceAt = now;
        return this.declinedCast('practice', 'not on a safe spot',
          { spell: choice.cast.name, why: 'a creature-target practice cast is only made from a safe spot, and none was reached' });
      }
      this._practiceTargets ||= new Map();
      // A BUDDY TAGGER WITH A TAG OUT CASTS AT THE TAG OR NOT AT ALL. The hit-point roll goes to
      // whoever's LAST target the creature was (player.kod poKill_target), so enfeeble on any other
      // skeleton while the tag is coming in would spend the tag. Operator, 2026-10-09: Robin builds
      // enfeeble in Castle Victoria while running the Qor buddy system.
      const tagId = this.buddyTag?.id ?? null;
      const objects = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && (tagId == null || o.id === tagId)).map(o => ({
        id: o.id, name: c.rsc.get(o.nameRsc) || '', row: o.row, col: o.col,
        attackable: !!(o.flags & OF.ATTACKABLE), player: !!(o.flags & OF.PLAYER) }));
      // A FRESH-ONLY DRILL REMEMBERS WHAT IT HAS SEEN TOUCHED (deskpractice `fresh`): anything near a player now
      // stays ineligible for retarget_ms, so a skeleton that walks away from a fight is not mistaken for a full one.
      const fresh = choice.cast.fresh === true;
      if (fresh) {
        this._practiceTouched ||= new Map();
        for (const id of touchedCreatures({ objects, me: c.self, clearOf: choice.cast.clear_of }))
          this._practiceTouched.set(id, now + choice.cast.retarget_ms);
      }
      creature = pickCreatureTarget({ objects, on: choice.cast.on ?? [], me: c.self,
                                      recentlyUntil: this._practiceTargets, now,
                                      ...(fresh ? { fresh, clearOf: choice.cast.clear_of, touchedUntil: this._practiceTouched } : {}) });
      if (!creature) {
        this._practiceAt = now;
        return this.declinedCast('practice', `no ${(choice.cast.on ?? []).join('/')} to practise on`,
          { spell: choice.cast.name, why: 'none in the room, or each was cast on within the last few seconds' });
      }
    }
    // A FLEET-MATE TARGET: a player in the room who is one of ours, never self, least recently cast
    // on first. Its vigor cannot be read from here, so the server answers for it — "cannot handle
    // additional vigor" costs nothing (CanPayCosts refuses before mana) and sets that one aside.
    let mate = null;
    if (choice.cast.target === 'fleetmate') {
      this._practiceTargets ||= new Map();
      const mates = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER) &&
                     allyVerdict({ name: c.rsc.get(o.nameRsc) || '', flags: o.flags }).basis === 'fleetmate')
        .map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc) || '' }))
        .filter(o => !((this._practiceTargets.get(o.id) ?? 0) > now))
        .sort((a, b) => (this._practiceTargets.get(a.id) ?? 0) - (this._practiceTargets.get(b.id) ?? 0));
      mate = mates[0] ?? null;
      if (!mate) {
        this._practiceAt = now;
        return this.declinedCast('practice', 'no fleet-mate here to practise on',
          { spell: choice.cast.name, why: 'none in the room, or each has refused within the last few minutes' });
      }
    }
    const targets = choice.cast.target === 'self' ? [c.selfId] : creature ? [creature.id] : mate ? [mate.id] : [];
    this._practiceAt = now;
    try { await skills.standToAct(s); } catch {}
    const manaBefore = c.vitals?.()?.mana?.value ?? null;
    const castAt = Date.now();
    await withCastRite(s, { spell, targets: targets, why: 'practiceAtDesk' }, () => s.pacer.submit('cast', () => c.cast(spell.id, targets), 1050));
    await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
    const manaAfter = c.vitals?.()?.mana?.value ?? null;
    const spent = manaBefore != null && manaAfter != null ? manaBefore - manaAfter : null;
    // UNKNOWN IS NOT REFUSED. Only a reading that proves nothing was spent sets the spell aside.
    const landed = spent == null ? null : spent > 0;
    // A CAST WITH A TRANCE IS NOT OVER WHEN THE MANA MOVES. The price is taken at the start and the spell happens at
    // the end, two to thirty seconds later; the session's automatic hold drops every packet that would break it in
    // between (m59-game.mjs noteCastSent). The drill used to hand the pass back on the first message -- "You focus
    // your whole will" -- and record the cast as worked, so a broken trance and a finished one read the same. Now it
    // stays for the trance, bounded at five seconds past it, and reads how it ended. A failed roll (half price) has
    // no trance to wait for.
    const tranceFor = practiceOutcome({ name: choice.cast.name, spent }) === 'completed' ? tranceMs(choice.cast.name) : 0;
    const endedSince = () => { const e = s.pacer?.lastTranceEnd; return e && e.at >= castAt ? e.why : null; };
    if (tranceFor > 0) {
      while ((Date.now() < castAt + tranceFor + 250 || s.pacer?.holdStatus?.().active)
             && Date.now() < castAt + tranceFor + 5000 && !/broken/i.test(endedSince() ?? ''))
        await new Promise(r => setTimeout(r, 100));
    }
    const outcome = practiceOutcome({ name: choice.cast.name, spent, ended: endedSince() });
    // A BROKEN TRANCE SETS THE SPELL ASIDE FOR TEN MINUTES, and says so. Something in this room or this keeper is
    // breaking it -- every break takes the full price and every reagent -- so the drill stops paying until a person or
    // the next window shows the cause is gone, rather than feeding the same leak a cast a minute.
    if (outcome === 'broken') {
      const asideMs = Math.max(cfg.refused_ms, PRACTICE_BROKEN_ASIDE_MS);
      this._practiceRefused.set(choice.cast.name, Date.now() + asideMs);
      this.tally.practice_trances_broken = (this.tally.practice_trances_broken || 0) + 1;
      this.note('practice trance broken', { spell: choice.cast.name, ended: endedSince(), set_aside_s: Math.round(asideMs / 1000),
        dropped_during_hold: s.pacer?.holdStatus?.().dropped ?? null });
    }
    if (outcome === 'completed') this.tally.practice_completed = (this.tally.practice_completed || 0) + 1;
    if (outcome === 'failed roll') this.tally.practice_failed_rolls = (this.tally.practice_failed_rolls || 0) + 1;
    // A REFUSED CREATURE CAST SETS ASIDE THE CREATURE, NOT THE SPELL: "already dazzled" and
    // "out of reach" are facts about that target, and the next skeleton may take it. A landed one
    // is set aside for the longest the effect can run (Dazzle.kod bounds it to 15 s) plus a second.
    if (creature) this._practiceTargets.set(creature.id, now + (landed === false ? 60_000
      // A fresh-only drill never hits the same creature twice inside retarget_ms: two hits are how it gets low.
      : choice.cast.fresh ? choice.cast.retarget_ms : 16_000));
    // A full fleet-mate refuses relay; set IT aside five minutes, not the spell. A landed one waits a
    // minute, so the practice spreads across whoever is in the room.
    else if (mate) this._practiceTargets.set(mate.id, now + (landed === false ? 300_000 : 60_000));
    else if (landed === false) this._practiceRefused.set(choice.cast.name, now + cfg.refused_ms);
    if (landed) this.tally.practice_casts = (this.tally.practice_casts || 0) + 1;
    this.recordCast(choice.cast.name, {
      // Worked means the spell HAPPENED: a failed roll and a broken trance both spent something and produced nothing.
      ok: landed !== false && outcome !== 'failed roll' && outcome !== 'broken',
      outcome,
      target: choice.cast.target === 'self' ? 'self' : creature ? `${creature.name} #${creature.id}` : mate ? mate.name : null,
      why: landed === false
        ? (creature ? `practice: no mana was spent on ${creature.name}; that creature is set aside 60s`
                    : `practice: no mana was spent, so the server refused it; set aside ${Math.round(cfg.refused_ms / 1000)}s`)
        : outcome === 'broken' ? `practice: the trance was broken (${endedSince()}); full price paid for nothing; set aside ${Math.round(Math.max(cfg.refused_ms, PRACTICE_BROKEN_ASIDE_MS) / 1000)}s`
        : `${choice.why}; reserve ${reserve.why}`,
      mana_before: manaBefore, mana_after: manaAfter });
    return true;
  }

  async buffAllies() {
    const cfg = this.policy.buffAllies;
    if (!cfg || cfg.enabled === false) return;
    const s = this.s, c = s.need();
    const gap = Number(cfg.gap_ms) > 0 ? Number(cfg.gap_ms) : 20_000;
    if (this.lastBuffAt && Date.now() - this.lastBuffAt < gap) return;

    // ONE OF OURS, NOT MERELY ANOTHER PLAYER. Raw room objects carry flags, not the
    // snapshot's derived booleans — the same note medic() makes, and for the same reason.
    //
    // This used to be every player-flagged object that was not us, and "another player" was
    // the whole of the ally test. 2026-10-03: Beaker blessed MORPHEUS thirty seconds after he
    // had killed six of the fleet in Castle Victoria, and the ledgers show twenty-odd strangers
    // buffed the same way, most of them in the grudge book. `allyVerdict` (m59-ally.mjs) is the
    // rule: hostile (war flag, war book, grudge book, a PvP killer) is never an ally whatever
    // else is true; then a fleet-mate or a named friend is; anybody else is not.
    const players = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
    if (!players.length) return this.declinedCast('buff', 'nobody else in the room to buff');
    const others = [], refused = [], basisOf = new Map();
    for (const o of players) {
      const name = c.rsc.get(o.nameRsc) || '';
      const v = allyVerdict({ name, flags: o.flags }, { friends: cfg.friends ?? [] });
      if (v.ally) { basisOf.set(o.id, v.basis); others.push(o); } else refused.push(`${name || '#' + o.id}: ${v.basis}`);
    }
    if (!others.length)
      return this.declinedCast('buff', 'no ally in the room to buff',
        { refused: refused.slice(0, 8), why: 'only fleet-mates and named friends are buffed; never a stranger or an enemy' });

    const wanted = [].concat(cfg.spells ?? Autopilot.BUFFS.map(b => b.name))
      .map(x => String(x).toLowerCase());
    this._buffedAt ||= new Map();          // `${targetId}:${spell}` -> when it was cast

    for (const buff of Autopilot.BUFFS) {
      if (!wanted.includes(buff.name)) continue;
      const spell = (c.spells || [])
        .find(sp => String(c.rsc.get(sp.nameRsc) || '').toLowerCase() === buff.name);
      if (!spell) continue;                                     // not a caster of this one

      const mana = c.vitals()?.mana;
      const floor = Number(cfg.mana_floor) >= 0 ? Number(cfg.mana_floor) : buff.mana + 4;
      if (mana && mana.value < floor)
        return this.declinedCast(buff.name, 'not enough mana',
          { mana: mana.value, needs: floor });

      // REAGENTS ARE CHECKED BEFORE THE CAST, NOT INFERRED FROM ITS FAILURE. A cast that
      // cannot pay its reagents is refused server-side and looks, from here, exactly like
      // a cast that landed on somebody already enchanted.
      const short = buff.reagents.filter(([n, k]) => this.reagentOnHand(n) < k);
      if (short.length) {
        this.declinedCast(buff.name, 'out of reagents',
          { needs: buff.reagents.map(([n, k]) => `${k} ${n}`).join(', '),
            missing: short.map(([n, k]) => `${n} (have ${this.reagentOnHand(n)} of ${k})`) });
        continue;
      }

      // The caster's own ability drives spell power (about half of it, spell.kod:2066),
      // which drives the duration. `c.abilities` is keyed by spell id and filled from the
      // server's stat groups, so this is the server's number, not a guess -- but it is
      // empty until the first read, hence the fallback.
      const ability = c.abilities?.get?.(spell.id)?.ability ?? cfg.assume_ability ?? 20;
      const holdMs = this.buffFloorMs(buff, ability);
      const target = others.find(o => {
        const at = this._buffedAt.get(`${o.id}:${buff.name}`);
        return !at || Date.now() - at >= holdMs;
      });
      // Everyone in the room is still inside the guaranteed window for this one. Not a
      // fault and not worth a log line every pass — try the next spell.
      if (!target) continue;

      this.lastBuffAt = Date.now();
      this._buffedAt.set(`${target.id}:${buff.name}`, Date.now());
      await withCastRite(s, { spell, targets: [target.id], why: 'buffAllies' }, () => s.pacer.submit('cast', () => c.cast(spell.id, [target.id]), 1050));
      const ev = await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 })
        .catch(() => ({ events: [] }));
      this.tally.buffs_given = (this.tally.buffs_given || 0) + 1;
      // Like a heal on somebody else, there is no inventory diff to prove it landed, so
      // `ok` means the cast went out. The reagents leaving the pack is the nearest thing
      // to a receipt and it is not read back here.
      this.recordCast(buff.name, { ok: true, target: c.rsc.get(target.nameRsc),
        why: `an ally in the room (${basisOf.get(target.id) ?? 'ally'}): buffs them, and casting is how the spell improves`,
        mana_before: mana?.value ?? null, mana_after: c.vitals?.()?.mana?.value ?? null });
      this.note('buffed an ally', {
        target: c.rsc.get(target.nameRsc), spell: buff.name,
        holds_for_s: Math.round(holdMs / 1000),
        said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2),
        why: buff.name === 'super strength'
          ? 'might is brawling’s requisite stat: raises their improvement chance and soft cap'
          : 'to-hit, so more landed swings, so the 75-swing improvement counter pays sooner' });
      this.progress(`cast ${buff.name} on an ally`);
      return;                       // one cast per pass; the pacer owns the rest
    }
  }
  // How many of exactly this reagent the pack holds: "mushroom" counts mushrooms and not blue mushrooms.
  reagentExact(name) {
    const c = this.s?.client;
    let n = 0;
    for (const o of (c?.inventory || []))
      if (isReagent(c.rsc.get(o.nameRsc), name)) n += Number(o.amount ?? 1) || 1;
    return n;
  }

  // PRACTICE'S OWN SUPPLY LINE: BUY THE SHORT REAGENTS FROM A COUNTER IN THE ROOM THE CHARACTER IS STANDING IN.
  // Operator, 2026-10-29, of Zoot holding Frisconar's Mysticals (53) for a quest: "train Bless (until it's 99), using the
  // shillings he has to buy reagents as needed ... a new 'buy reagents in the room you're in while you train' feature".
  // It never walks: only the merchants already in this room are asked, each short reagent is topped up to buy_here.casts
  // casts' worth out of the purse above keep_shillings, and what entered the pack is the evidence (buyItems completes the
  // handshake whatever the counter clamps). A reagent nobody here sells is said once per ten minutes and left alone: a
  // drill that cannot fix its shortage must not ask every pass. True when it used the pass (asked a counter).
  async practiceBuyHere(cfg, spells, reserve, now = Date.now()) {
    const buy = cfg.buy_here;
    if (!buy) return false;
    if (this._practiceBuyAt && now - this._practiceBuyAt < buy.every_ms) return false;
    const { wants, for: forSpell } = buyHereWants({ practice: cfg, spells, exact: item => this.reagentExact(item), reserve,
      refusedUntil: this._practiceRefused ?? new Map(), now });
    if (!wants.size) return false;
    this._practiceBuyAt = now;
    const s = this.s, c = s.need();
    const room = this.hereRoom();
    const sellers = [...(c.room?.objects?.values() ?? [])].filter(o => affordances(o.flags).includes('buy'));
    if (!sellers.length) {
      this.practiceBuyState = { at: now, room, wants: Object.fromEntries(wants), why: 'nobody in this room sells anything' };
      return false;
    }
    for (const word of buy.say ?? []) await s.pacer.submit('say', () => c.say(word)).catch(() => {});
    const bought = {}, notSold = new Set(wants.keys()), prices = {};
    let budget = Math.max(0, this.purseNow() - buy.keep_shillings);
    for (const seller of sellers) {
      if (![...wants.values()].some(n => n > 0)) break;
      if (this.travelInterrupted?.() || this.hereRoom() !== room) break;
      const before = c.evSeq;
      await s.pacer.submit('buy', () => c.buy(seller.id)).catch(() => {});
      const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 }).catch(() => ({ events: [] }));
      const shop = ev.events?.find(e => e.kind === 'shop');
      if (!shop?.items?.length) continue;
      for (const [item, amount] of wants) {
        if (!(amount > 0)) continue;
        const row = shop.items.find(r => isReagent(r.name, item));
        if (!row || !(Number(row.id) > 0)) continue;
        notSold.delete(item);
        const unit = Number(row.cost);
        // AN UNPRICED ROW IS NOT A FREE ONE: skipped, never bought blind against the purse.
        if (!(unit > 0)) continue;
        prices[item] = unit;
        const n = Math.min(amount, Math.floor(budget / unit));
        if (n <= 0) continue;
        const held = this.reagentExact(item);
        for (const l of buyLines([{ id: Number(row.id), amount: n }])) {
          await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [l]));
          const seq = c.evSeq;
          await s.pacer.submit('read', () => c.requestInventory());
          await c.waitFor({ since: seq, kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
        }
        const gained = Math.max(0, this.reagentExact(item) - held);
        if (gained > 0) {
          bought[item] = (bought[item] ?? 0) + gained;
          budget -= gained * unit;
          wants.set(item, amount - gained);
          this.recordPurchase?.(item, unit, { kind: 'reagent', from: seller?.nameRsc ? c.rsc.get(seller.nameRsc) : null,
            why: `practice buy_here: ${(forSpell.get(item) ?? []).join(', ')}` });
        }
      }
    }
    const short = [...wants].filter(([, n]) => n > 0).map(([item, n]) => `${item} ${n}`);
    this.practiceBuyState = { at: now, room, bought, prices, purse: this.purseNow(), still_short: short, not_sold_here: [...notSold] };
    if (Object.keys(bought).length) this.note('practice: bought reagents in this room', this.practiceBuyState);
    else if (notSold.size && (!this._practiceBuyNotSoldAt || now - this._practiceBuyNotSoldAt > 600_000)) {
      this._practiceBuyNotSoldAt = now;
      this.note('practice: a short reagent is not sold in this room', this.practiceBuyState);
    } else if (short.length) this.note('practice: could not buy the short reagents here', this.practiceBuyState);
    return true;
  }
  // @end 1
}
