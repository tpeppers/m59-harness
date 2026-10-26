// FOLLOWING, BEING OUTSIDE, AND EATING BEFORE A JOURNEY.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 5 methods: passFollow, passOutside, settleErrandsBeforeJourney, eatBeforeTravel, eatToFloor
import { behindBy, dropCrumb, exitTakenFrom, heardOrder, nextStep } from '../m59-follow.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import * as skills from '../m59-skills.mjs';
import { stationaryTradeActive } from '../m59-stationary-trade.mjs';
import { SWARM_MIN_MAX_HEALTH } from '../m59-swarm-follow.mjs';
import { Autopilot, CONTINUE, HANDLED, REST_VIGOR_CAP, STRATEGIES, overdriveReachable, overdriveSettings, pct } from '../m59-autopilot.mjs';

export class PassOutsidePart {
  // @part 1

  // ── passOutside: extracted from pass() ────────────────────────────────
  // ── passFollow: walk where a person walked ───────────────────────────────────────────
  //
  // Say "follow me" while piloting one of your own and every fleet member in the room walks
  // your trail until you say stop. It is for leading a group through doors the router keeps
  // getting wrong -- the Cragged Mountains pocket whose only exit has failed 21 crossings,
  // the Ukgoth wedge where a body can step four ways and none is the one it wants. A person
  // threading that solves it by knowing where to put their feet; this copies the feet.
  //
  // ONLY OUR OWN PEOPLE MAY GIVE THE ORDER. `prod` is a shared server and this moves twenty
  // bodies at once, so `heardOrder` checks the speaker against the ROSTER, not against the
  // text. See m59-follow.mjs and the assertions in m59-follow-test.mjs.
  async passFollow(ctx) {
    if (stationaryTradeActive(this.s)) { this.doing = 'stationary cargo exchange'; return HANDLED; }
    const { s, c } = ctx;
    // A separate cursor from the social responder's: both read `said` and consuming the
    // stream out from under the other would make each one intermittently deaf.
    const evs = c.eventsSince(this.followCursor || 0).filter(e => e.kind === 'said');
    this.followCursor = c.evSeq;
    const order = heardOrder(evs, {
      isOurs: name => party.isFleetmate(name),
      self: c.selfId,
    });
    if (order?.order === 'stop' && this.follow) {
      this.note('told to hold', { by: order.leaderName, walked_behind_for_s:
        Math.round((Date.now() - this.follow.since) / 1000) });
      this.follow = null;
    } else if (order?.order === 'follow' &&
               !(Number(c.vitals?.()?.health?.max) >= SWARM_MIN_MAX_HEALTH)) {
      // UNDER 30 MAXIMUM HEALTH DOES NOT FOLLOW (operator, 2026-10-06: "I'd like the swarm to not
      // include characters below 30 HP"). Said after a "follow me" walked Loial (20) off his post,
      // Marco Polo (20) across town and Raphael (25) out into the Twisted Wood. Maximum, not
      // current: the same rule as the swarm and as lockdown's hall, one constant for all three.
      this.note('heard "follow me" and stayed', { by: order.leaderName,
        why: `max health ${c.vitals?.()?.health?.max ?? 'unread'} is under ${SWARM_MIN_MAX_HEALTH}` });
    } else if (order?.order === 'follow') {
      this.follow = { leaderId: order.leaderId, leaderName: order.leaderName,
                      trail: [], since: Date.now(), missing: 0 };
      this.note('following', { leader: order.leaderName,
        how: 'walking the squares they stood on, oldest first, rather than walking at them' });
    }
    if (!this.follow) return CONTINUE;

    const me = c.self;
    if (!me) return CONTINUE;
    // Where is the leader? Absent is not the same as gone: a leader who has stepped through a
    // door leaves a trail whose last crumbs ARE the approach to it, so walking them takes us
    // through. That is why this keeps going for a while rather than giving up at once.
    const leader = c.room?.objects?.get?.(this.follow.leaderId) ?? null;
    if (leader) {
      this.follow.missing = 0;
      // WHERE THEY WERE LAST SEEN, kept separately from the trail. The trail is consumed as
      // it is walked, so by the time a follower needs to ask "which door did they take" the
      // crumb that would have answered is gone.
      this.follow.lastSeen = { row: leader.row, col: leader.col };
      dropCrumb(this.follow.trail, { row: leader.row, col: leader.col, at: Date.now() });
    } else {
      this.follow.missing++;
    }

    const aim = nextStep(this.follow.trail, me);
    if (!aim) {
      // Caught up. Standing still next to the leader is the correct behaviour for a follower,
      // and it is also how a group stays together while the leader picks a door.
      if (leader) { this.progress('following ' + this.follow.leaderName + ' — caught up'); return HANDLED; }

      // THE TRAIL IS WALKED OUT AND THE LEADER IS NOT HERE, so they left the map. Take the
      // door nearest to where they were last seen: they are still online, they did not
      // evaporate, and people leave a room through the exit they were standing next to.
      //
      // `exitTakenFrom` refuses when the last sighting was nowhere near a door, which is the
      // half that matters — that is not somebody who walked out, it is somebody who died or
      // logged out, and marching after them puts the group a zone away from where it belongs.
      const room = this.s.world?.room;
      const exits = [...(room?.edgeExits ?? []), ...(room?.goExits ?? [])]
        .filter(e => e && !e.locked && e.to != null && Number(e.to) !== Number(room?.num));
      // ROOM BOUNDS, because most exits out here are EDGES rather than doorways -- the
      // Cragged Mountains has five and every one is a wall you walk off. Without the bounds
      // an edge cannot be measured against a sighting at all, and `exitTakenFrom` correctly
      // refuses rather than guessing, which is exactly the "walked to the wall and stopped"
      // this fixes.
      const door = exitTakenFrom(exits, this.follow.lastSeen,
                                 { rows: Number(room?.rows), cols: Number(room?.cols) });
      if (door && !this.follow.tookDoor) {
        this.follow.tookDoor = true;      // one attempt per vanishing, not a loop at a wall
        this.note('they left the map — taking the door they were standing next to', {
          leader: this.follow.leaderName, to: door.to,
          door: { row: door.row, col: door.col },
          last_seen: this.follow.lastSeen,
          squares_from_last_sighting: door.squares_from_last_sighting,
        });
        // Walk onto the crossing point first when we know it. For an edge that is our own
        // column on that wall, and stepping onto it is what actually leaves the room --
        // walking off an edge and using a door are different actions and the wrong one
        // produces silence.
        if (door.at && Number.isFinite(door.at.row) && Number.isFinite(door.at.col))
          await this.s.walkTo(door.at.col, door.at.row, { maxSteps: 12 }).catch(() => null);
        const went = await this.s.travel(door.to, { origin: keeperOrigin('follow'), maxHops: 1 })
          .catch(e => ({ arrived: false, why: e.message }));
        if (went?.arrived || this.s.client?.room?.id !== undefined) {
          // Through, or at least moved. Start a fresh trail on the far side: the leader is
          // over there and the crumbs from the last room are no longer about this one.
          this.follow.trail = [];
          this.follow.tookDoor = false;
          this.follow.missing = 0;
          return HANDLED;
        }
        this.note('could not take the door they used', { to: door.to, why: went?.why ?? 'unknown' });
      }
      if (this.follow.missing > 20) {
        this.note('lost the lead', { leader: this.follow.leaderName,
          why: door ? 'could not follow them through the door they used'
                    : 'out of the room, out of trail, and no door near where they vanished' });
        this.follow = null;
        return CONTINUE;
      }
      this.progress('following ' + this.follow.leaderName + ' — looking for the door they used');
      return HANDLED;
    }

    const w = await s.walkTo(aim.col, aim.row, { maxSteps: 8 })
      .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    this.progress(`following ${this.follow.leaderName} — ${behindBy(this.follow.trail)} crumb(s) behind`);
    if (!w.arrived && w.left_room) {
      // Through the door after them, which is the whole trick and needs no special case.
      this.note('followed them through', { leader: this.follow.leaderName });
    }
    return HANDLED;
  }

  async passOutside(ctx) {
    // AN OUTSIDE OPERATION OWNS EVERYTHING DIRECTIONAL FROM HERE DOWN.
    //
    // Keep this below death, danger and recovery: those are the keeper's protected
    // faculties and an errand must not be able to turn them off. Keep it above parking,
    // keeper errands, banking and farming: each of those moves, trades, swings or changes
    // the character while the outside operation is trying to do the same thing. The first
    // declaration also cancels a pass already blocked in movement; this gate handles every
    // pass that begins afterwards.
    const outside = this.busyStatus();
    if (outside) {
      // ONLY THE OWNER'S OWN LEG. A journey suspended BEFORE the outside operation began was the
      // keeper's, not the owner's: on the 2026-09-25 rehearsal the light-bearer, held by the raid
      // and holding the chalice in the stage room, resumed its own pre-raid town trip, walked
      // toward the apothecary and ended in the Cragged Mountains — and both riders who needed the
      // cup it dropped there went without. `busy.at` is the start of this holder's operation
      // (kept across renewals); an older suspension is dropped, with a note, and the keeper
      // plans afresh when the lease ends.
      if (this.suspendedJourney?.at != null && Number(this.suspendedJourney.at) < Number(outside.at ?? 0)) {
        this.note('a journey from before the outside operation is not resumed while it runs', {
          to: this.suspendedJourney.to, why_it_was_travelling: this.suspendedJourney.why ?? null,
          busy: outside.label ?? outside.kind ?? null,
          why: 'the holder decides where this body goes; the keeper re-plans when it is released' });
        this.suspendedJourney = null;
      }
      // An interrupted leg is still the outside owner's destination. Blocking
      // its resume here strands a busy town runner before passFarm can reach it.
      if (this.suspendedJourney
          && await this.resumeSuspendedJourney(ctx) === HANDLED) return HANDLED;
      this.progress(`busy -- ${outside.label ?? outside.kind ?? 'something else is driving'}`);
      return HANDLED;
    }

    // PARKED. This is the point the keeper would otherwise choose a new action — the
    // errand, the roam, the fight — and it is past death, danger and rest, so a parked
    // character has already handled anything that was happening to it. See park().
    //
    // Deliberately ABOVE the errand branch: an errand is a multi-minute walk across the
    // world, which is the worst possible thing to be half-way through when the broker
    // goes down. A character that is already on one finishes nothing and stands still;
    // the errand is still in `this.errand` and the keeper on the far side of the restart
    // picks it up from the roster.
    if (this.parking) {
      // Recompute hostiles here: the parking check needs to know what is in the room.
      const c = this.s.client;
      const hostiles = [...c.room.objects.values()].filter(o =>
        o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
      const p = this.parking;
      // Somewhere hostile? Get a wall. `takeSafeSpot` is the same call the rest gate
      // uses, so a parked character ends up in exactly the state resting requires.
      //
      // `hostiles` is the whole room, not `near` — the same distinction the rest gate
      // makes and for the same reason: a room with four monsters in it and none beside
      // us right now is not a place to sit out an outage. And a room that merely SPAWNS
      // counts too, because an empty spawn room is a room between spawns.
      const wantWall = !this.hold &&
                       (hostiles.length > 0 || !this.sanctuary());
      if (wantWall && !p.ready) {
        p.tries++;
        await this.takeSafeSpot('parking for a fleet update — a wall before the outage',
                                hostiles[0] ?? null).catch(() => false);
      }
      // READY WHEN WE ARE BEHIND SOMETHING, or when we have spent long enough failing to
      // find one that holding up the fleet costs more than the wall is worth. Reporting
      // ready without a wall is honest rather than convenient: parkStatus() carries
      // `holding: null` and the orchestrator prints it, so the operator sees which
      // characters are about to take the outage standing in the open.
      const graceUp = Date.now() - p.at > Autopilot.PARK_GRACE_MS;
      if (!p.ready && (this.hold || !wantWall || graceUp)) {
        p.ready = true; p.since = Date.now();
        this.note('parked and ready for the update', {
          holding: this.hold ? { col: this.hold.col, row: this.hold.row, proven: this.holdWorks() } : null,
          attempts: p.tries,
          why: this.hold ? 'behind a wall, taking no new fights until the update is done'
             : !wantWall ? 'nothing here spawns or threatens, so a wall buys nothing'
             : 'could not find a wall in ' + Math.round(Autopilot.PARK_GRACE_MS / 1000) + 's — ' +
               'reporting ready rather than holding the whole fleet up, and saying so' });
      }
      // Rest while we wait, but only where resting is legal — the same rule the rest
      // gate applies, and for the same reason. Free health for the far side of the
      // restart when it is safe, and nothing at all when it is not.
      if (this.holdWorks() || !hostiles.length) {
        const hp = pct(this.s.client?.vitals?.health);
        if (hp !== null && hp < 0.95) {
          this.doing = 'recovering';
          await skills.restUntil(this.s, { health: 0.99, vigor: REST_VIGOR_CAP, maxSeconds: 20 })
                      .catch(() => {});
        }
      }
      return HANDLED;
    }
    return CONTINUE;
  }

  // ── passErrand: extracted from pass() ────────────────────────────────
  /**
   * THE ERRANDS, DONE ONCE, BEFORE SETTING OFF.
   *
   * The operator's shape, and it is the right one: most of the time a character sent across
   * the world should bank its takings and top up its food FIRST, and then go — not discover
   * halfway through the Twisted Wood that it wants to visit a bank. So the errands are not
   * abolished under a journey, they are MOVED IN FRONT OF IT.
   *
   * `run_errands: false` on the journey skips this, which is what a measurement wants (the
   * road is the thing being timed) and what an emergency wants (go now, bank later).
   *
   * BOUNDED, AND FAILURES DO NOT STOP THE JOURNEY. An errand that cannot be finished is not
   * a reason to refuse to travel — that would turn a full pack or a shut shop into a
   * character that never leaves town, which is the "a trip that cannot fix the thing that
   * opened it will run for ever" trap this repository already documents. Each step gets one
   * attempt, whatever happens the road follows.
   */
  async settleErrandsBeforeJourney({ where = null } = {}) {
    const did = [];
    const tryStep = async (name, fn) => {
      try { if (await fn()) did.push(name); }
      catch (e) { did.push(`${name} failed: ${e.message}`); }
    };
    await tryStep('banked what was on us', async () => { await this.bankSurplus(); return false; });
    await tryStep('went to a vault we were passing', () => this.vaultRunIfPassing());
    await tryStep('went to the bank', () => this.bankRun());
    await tryStep('handed over farm supplies', () => this.deliverFarmSupplies());
    this.note('did the errands before setting off', {
      to: where, did: did.length ? did : 'nothing was outstanding',
      why: 'a character sent across the world should bank and stock up first rather than ' +
           'discover halfway through that it wants to. run_errands:false skips this',
    });
    return did;
  }

  // EATING OUTSIDE FARM MODE, WHEN SOMEBODY ASKED FOR A FLOOR ABOVE THE REST CAP.
  //
  // provision() — the only thing that eats — ran only inside passFarm's farm block, and an idle
  // character returns from passErrand before passFarm while a survive-mode one skips that block.
  // So a floor of 160 was an order nothing could carry out: 2026-09-27, the Ukgoth troll crew
  // staged idle at room 2 and Raphael (survive, the stage-room dedicator) each sat at 80 of 200
  // with food in their packs and a floor of 160 (operator: "troll hunters should be keeping 160+
  // vigor being fed off inky-cap mushrooms, meat pies, and bread"). Gated on a floor above the
  // cap so the rest of the fleet, whose floor is the cap or below, behaves exactly as before.
  // EAT BEFORE SETTING OUT, SO THE STOMACH DIGESTS ON THE ROAD (operator, 2026-09-27: "keepers
  // eat before travel if they expect to want to have eaten on the other side ... get their stomachs
  // digesting by eating before"). A sitting is capped by the stomach, not the vigor: from 80, one
  // sitting of bread reaches about 120 and the next waits for 100 filling to drain at 0.12/s
  // (vigor-food-and-rest report). A walk is that wait, spent. And walking costs vigor: each moving
  // second adds EXERTION_PER_MOVE * (5/6 speed)^2 exertion (user.kod:3013-3033), so a meal eaten
  // first covers the road as well.
  //
  // Only for a character that wants vigor above the rest cap (the same gate as eatToFloor), and
  // never in danger: nothing in reach, health at or above the rest line. A retreat does not stop
  // to eat. One sitting, as far as the stomach allows. Never throws; travel always goes ahead.
  async eatBeforeTravel(dest = null) {
    try {
      const p = this.policy ?? {};
      const floor = Number(p.vigorFloor ?? p.fightAboveVigor) || 0;
      if (floor <= REST_VIGOR_CAP * 200) return null;
      const c = this.s?.client, v = c?.vitals?.();
      const vigor = v?.vigor?.value;
      if (!Number.isFinite(vigor)) return null;
      const ceiling = Number(p.vigorCeiling) || 200;
      if (vigor >= Math.min(ceiling, 200) - 10) return null;
      const hp = v?.health?.max ? v.health.value / v.health.max : null;
      if (hp === null || hp < (p.restBelow ?? 0.85)) return null;
      if (this.inReachOfUs?.()?.length) return null;
      const larder = this.larder(c);
      if (!larder.length) return null;
      // travel() is called often; ask the server for nothing when our own stomach says no room.
      const smallest = Math.min(...larder.map(x => Number(x.food?.filling) || 0));
      if (this.stomach && !this.stomach.roomFor(smallest)) return null;
      // A WHOLE SITTING. `skills.eat` takes one mouthful per stack per call, so one call of a
      // single bread stack is one loaf and the stomach sets out mostly empty. Keep going until the
      // stomach refuses, the ceiling is reached, or nothing more is eaten (at most 6 rounds).
      const e = { ate: [], vigor: { before: vigor, after: vigor } };
      // OVERDRIVE BEFORE A JOURNEY: not one sitting but a climb to the target, waiting out the stomach
      // between sittings — bounded by maxMinutes and abandoned the moment anything is in reach.
      const od = overdriveSettings(p);
      const reach = od ? overdriveReachable(od.target, larder) : null;
      if (od && vigor < reach - 5) {
        this.startOverdrive(od, vigor, `setting out for ${dest ?? 'a journey'}`);
        const until = Date.now() + od.maxMinutes * 60_000;
        let now = vigor;
        while (Date.now() < until && now < overdriveReachable(od.target, this.larder(c)) - 5 && !this.stopping && !this.inReachOfUs?.()?.length) {
          const r = await skills.eat(this.s, { stomach: this.stomach, upToVigor: od.target,
                                               exclude: this.notOursToEat() }).catch(() => null);
          if (r?.ate?.length) { e.ate.push(...r.ate); now = r.vigor?.after ?? now; this.tally.meals = (this.tally.meals || 0) + 1; continue; }
          if (!this.larder(c).length) break;
          const wait = Math.min(60, Math.max(5, this.stomach?.secondsUntilRoomFor?.(smallest) ?? 30));
          await new Promise(res => setTimeout(res, wait * 1000));
          now = this.s?.client?.vitals?.()?.vigor?.value ?? now;
        }
        e.vigor.after = now;
        this.endOverdrive(now, now >= overdriveReachable(od.target, this.larder(c)) - 5 ? 'reached the target' : 'set out before the target');
        if (e.ate.length) { this.recordAte(e, 'overdrive before travel'); return 'ate'; }
        return null;
      }
      for (let round = 0; round < 6; round++) {
        const r = await skills.eat(this.s, { stomach: this.stomach, upToVigor: ceiling,
                                             exclude: this.notOursToEat() });
        if (!r?.ate?.length) break;
        e.ate.push(...r.ate);
        e.vigor.after = r.vigor?.after ?? e.vigor.after;
        if (r.tooFull || (e.vigor.after ?? 0) >= ceiling || !this.stomach?.roomFor(smallest)) break;
      }
      if (!e.ate.length) return null;
      this.tally.meals = (this.tally.meals || 0) + 1;
      this.recordAte(e, 'before travel');
      this.note('ate before setting out', { ate: e.ate, vigor: e.vigor, to: dest,
        stomach: Math.round(this.stomach?.level ?? 0),
        why: 'the stomach empties on the road, so there is room to eat again on arrival, and the ' +
             'walk itself costs vigor' });
      return 'ate';
    } catch { return null; }
  }

  async eatToFloor(ctx) {
    const floor = Number(this.policy?.fightAboveVigor) || 0;
    if (floor <= REST_VIGOR_CAP * 200) return null;       // the cap is a fraction of 200: 80
    const plan = STRATEGIES[this.policy.strategy] || STRATEGIES.baseline;
    const v = ctx?.v ?? this.s?.client?.vitals?.() ?? {};
    return await this.provision(plan, v).catch(() => null);
  }
  // @end 1
}
