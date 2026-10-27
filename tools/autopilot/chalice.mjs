// THE CHALICE: duty, rides, the desk, cargo and money.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 58 methods: get chaliceCfg, refreshChaliceConfig, chaliceStore, chaliceTopUp, chaliceRefillTrip, chaliceRole, chaliceDutyEligible,
//   chalicePoolCheckIn, chaliceInPack, chalicesInPack, chaliceCarryCheckIn, chaliceCarriers,
//   offerWouldDoubleChalice, chaliceOnFloor, chaliceGuard, lootIgnoreList, hallShillings,
//   chaliceHandInMoney, chaliceDepositMoney, playerHere, hereRoom, hopsTo, activeChaliceRide,
//   chaliceRideNow, chaliceBusy, standingOrderReserve, standingOrderUnstarted, fundStandingOrder,
//   chaliceCursedWorn, chaliceUnrevealed, chaliceAskServices, chaliceDonation, chaliceSpecs,
//   chaliceTakeCargo, chaliceTownCargo, chaliceBuyCargo, chaliceDeliverCargo, chaliceCast,
//   chaliceServeServices, chaliceServeTicket, chaliceFleetOnly, chaliceHumanServer, chaliceTell,
//   chalicePublishDesk, notePlayerSwing, lastPlayerSwingAt, chaliceFit, chaliceReagentFloor,
//   chaliceFolWatch, chaliceCastsLeft, chaliceEvent, chaliceGive, chaliceRide, chaliceDuty,
//   chaliceNextJob, chaliceParked, chaliceStep, chaliceMakeRoom
import { withCastRite } from '../m59-castrite.mjs';
import { rideChaliceNow } from '../m59-chalice-ride.mjs';
import { CHALICE, GUILD_HALL_ROOM, REFILL_ROOMS, SIP_REFUSED_PVP, SIP_TOOK, actingDesk, cargoWants, carriesCup, castsAbove, chaliceStoreFor, depositPlan, deskMenu, donationPlan, draftAlternate, dutyEligible, folRoomsOf, folWanted, holderShortfall, humanMark, moneyExcess, normalizeChalice, passTo, rideBudget, sipsAfterRide, CUP_MIN_SIPS, refillCandidates, refillDue, planRoom, reagentFloor, restockBuyPlan, roleOf, sameName, serviceReplyText, serviceTellText, servingDesk, servingOrHolder, shouldRide, sipVerdict, sweepVerdict, tipPlan } from '../m59-chalice.mjs';
import { isWeaponName } from '../m59-items.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF, buyLines, dropSpec as dropSpecFor } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { deskRoom } from '../m59-desk-follow.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { SPAWN_FILE } from '../m59-autopilot.mjs';
import * as skills from '../m59-skills.mjs';
import { orderPrice, orderSkills, pendingOrderFor, writeState as writeOrderState } from '../m59-standing-orders.mjs';
import { BOOKMAKERS_HALL_ROOM, StorageCache } from '../m59-storage.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Autopilot, REAGENT_TARGET_BY_KIND, TITHE_FLEET, purchaseEnabled, reagentTargetFor } from '../m59-autopilot.mjs';

export class ChalicePart {
  // @part 1

  // ================================================================== CHALICE FARMING
  //
  // A free Rescue home for every town trip that starts near the station. The protocol, the
  // roles and why the station must be a refill room are in tools/m59-chalice.mjs; this is
  // the half that talks to the game. The configuration comes from a PRIVATE strategy's
  // `chalice` hook, because it names characters.
  //
  // Everything here is a RESUMABLE STAGE MACHINE that does one short step per pass and
  // returns, so the survival ladder above keeps its turn between steps — a hand-off takes
  // a minute and a character that could not flee for a minute is how this fleet dies.

  /** The configuration, refreshed from the strategies at most every 30s. Sync to read. */
  get chaliceCfg() {
    const cfg = this._chaliceCfg?.enabled ? this._chaliceCfg : null;
    if (!cfg?.follows_holder) return cfg;
    // A DESK THAT FOLLOWS ITS HOLDER (m59-desk-follow.mjs): the station is wherever the holder stands. The holder reads
    // its own room; everyone else reads the holder's published desk record, and a stale one is "no station known".
    const now = Date.now(), here = this.hereRoom?.() ?? null;
    if (this._chaliceFollow && now - this._chaliceFollow.at < 3_000 && this._chaliceFollow.here === here
        && this._chaliceFollow.base === cfg) return this._chaliceFollow.cfg;
    const isServer = roleOf(this.who(), cfg) === 'holder';
    let record = null;
    if (!isServer) { try { record = this.chaliceStore().desk()?.[String(cfg.holder ?? '').trim().toLowerCase()] ?? null; } catch {} }
    const station = deskRoom({ follows: true, isServer, here, record, now });
    let disabled = null;
    try { disabled = this.chaliceStore().cup()?.disabled?.why ?? null; } catch {}
    const out = { ...cfg, station_room: station, ...(disabled ? { desk_disabled: disabled } : {}) };
    this._chaliceFollow = { at: now, here, base: cfg, cfg: out };
    return out;
  }

  async refreshChaliceConfig(now = Date.now()) {
    if (this._chaliceCfgAt && now - this._chaliceCfgAt < 30_000) return this.chaliceCfg;
    this._chaliceCfgAt = now;
    let answer = null;
    try {
      answer = await this.s?._askStrategies?.('chalice', { agent: this.s?.name ?? null, character: this.who() });
    } catch { answer = null; }
    const cfg = answer?.answer ? normalizeChalice(answer.answer) : null;
    const said = JSON.stringify(cfg?.problems ?? []);
    if (cfg?.problems?.length && said !== this._chaliceProblemsSaid) {
      this._chaliceProblemsSaid = said;
      this.note('chalice farming configuration problems', { strategy: answer.strategy, problems: cfg.problems });
    }
    this._chaliceCfg = cfg;
    this._chaliceStrategy = answer?.strategy ?? null;
    return this.chaliceCfg;
  }

  chaliceStore() { return (this._chaliceStoreObj ??= chaliceStoreFor({ fleet: TITHE_FLEET })); }

  // A FOLLOWING DESK GOES AND REFILLS BETWEEN USES. Operator, 2026-10-27: "seek out the nearest/safest refresh room between
  // uses capped at the safe maximum so it never gets emptied, and mark itself 'disabled' if it can't refresh until it
  // can". When the count is short or unknown and no ride it can still serve is waiting, the holder walks to the nearest
  // refill room that is safe enough (refillCandidates: nothing spawning there over refill.max_spawn_level, the Lake of
  // Jala's Song being the operator's example), tops the cup up there, and walks back to its post. No safe room in reach,
  // or the walk failing `fail_limit` times, marks the desk DISABLED (on the desk record, so travellers decline it) and
  // retries after `retry_ms`. The journey is an ordinary keeper travel: the survival ladder and travel_guard stay armed.
  async chaliceRefillTrip(cfg, role, cup, store, now = Date.now()) {
    const rf = cfg?.refill;
    if (!cfg?.follows_holder || role !== 'holder' || !cup || !rf?.roam) return false;
    const here = this.hereRoom();
    if (REFILL_ROOMS.has(here)) return false;                     // chaliceTopUp's job
    let cupState = {};
    try { cupState = store.cup() ?? {}; } catch {}
    if (Number(cupState.sips) >= CUP_MIN_SIPS) {
      if (cupState.disabled) try { store.setCupDisabled(null); } catch {}
      return false;
    }
    let pending = 0;
    try { pending = (store.read().tickets ?? []).filter(t => t.kind === 'ride' && !['done', 'abandoned'].includes(t.status)).length; } catch {}
    const budget = rideBudget({ room: here, sips: cupState.sips, reserve: cfg.cup_reserve });
    const due = refillDue({ sips: cupState.sips, pendingRides: pending, budgetOk: budget.ok });
    if (!due.due) return false;
    if (now < (this._chaliceRefillRetryAt ?? 0)) return false;
    if (this.facultyHeld?.('movement')) return false;             // somebody else holds the legs
    const disable = (why) => {
      this._chaliceRefillRetryAt = Date.now() + rf.retry_ms;
      try { store.setCupDisabled(why); } catch {}
      this.chaliceEvent('desk_disabled', { why, retry_in_ms: rf.retry_ms });
    };
    const confine = Array.isArray(this.policy?.confineRooms) && this.policy.confineRooms.length ? this.policy.confineRooms.map(Number) : null;
    const allowExit = cfg.allow_exit_confinement_for_refresh ?? null;
    const cands = refillCandidates({ refill: rf, spawns: loadSpawns(SPAWN_FILE), hopsTo: r => this.hopsTo(r), here, confine, allowExit });
    if (!cands.length) {
      disable(confine && !allowExit
        ? `confined to ${JSON.stringify(confine)} with no refill room inside it (allow_exit_confinement_for_refresh lets a refill trip out)`
        : `no refill room within ${rf.max_hops} hops spawns nothing over level ${rf.max_spawn_level}${confine ? ` (confined; may leave for ${JSON.stringify(allowExit)})` : ''}`);
      return false;
    }
    const target = cands[0];
    this.doing = 'travelling';
    this.chaliceEvent('refill_trip', { from: here, to: target.room, hops: target.hops, max_level: target.max_level,
      creatures: target.creatures, why: due.why });
    // ALLOWED OUT OF THE CONFINEMENT FOR THIS ROOM ONLY: travel's chalice exception names it (travel.mjs chaliceRooms).
    const leaves = confine && !confine.includes(target.room);
    const went = await this.travel(target.room, { origin: keeperOrigin('chalice_refill'), maxHops: target.hops + 4,
      ...(leaves ? { chalice: true, chaliceRoom: target.room } : {}) })
      .catch(e => ({ arrived: false, reason: e.message }));
    if (went?.confined) {
      // THE CONFINEMENT IS THE OPERATOR'S AND OUTRANKS THE ERRAND (travel.mjs). Said at once, not retried twice.
      disable(`confined to ${JSON.stringify(this.policy?.confineRooms ?? [])}: a refill trip cannot leave it (lift confine_rooms; assigned_room/post_room is where it returns)`);
      return true;
    }
    if (!went?.arrived) {
      this._chaliceRefillFails = (this._chaliceRefillFails ?? 0) + 1;
      this.chaliceEvent('refill_trip_failed', { to: target.room, why: went?.reason ?? 'did not arrive', fails: this._chaliceRefillFails });
      if (this._chaliceRefillFails >= rf.fail_limit) { this._chaliceRefillFails = 0; disable(`could not reach a refill room (${went?.reason ?? 'did not arrive'})`); }
      else this._chaliceRefillRetryAt = Date.now() + 60_000;
      return true;
    }
    this._chaliceRefillFails = 0;
    this._chaliceTopUpAt = 0;                                      // the trip IS the reason: no rate limit here
    const inPack = this.chaliceInPack();
    if (inPack) await this.chaliceTopUp(cfg, role, inPack, store, Date.now());
    let after = null;
    try { after = store.cup()?.sips ?? null; } catch {}
    if (Number(after) < CUP_MIN_SIPS || after == null) {
      this._chaliceRefillRetryAt = Date.now() + 2 * 60_000;       // a stranger in the room, or the cup not back yet
      this.chaliceEvent('refill_trip_no_refill', { room: target.room, why: 'arrived but the top-up did not complete; trying again shortly' });
      return true;
    }
    try { store.setCupDisabled(null); } catch {}
    const home = rf.return !== false ? cfg.post_room : null;
    if (home != null && this.hereRoom() !== Number(home))
      await this.travel(Number(home), { origin: keeperOrigin('chalice_refill_return'), maxHops: rf.max_hops + 4, chalice: true })
        .catch(() => null);
    this.chaliceEvent('refill_trip_done', { refilled_at: target.room, back_at: this.hereRoom(), sips: after });
    return true;
  }

  // A FOLLOWING DESK REFILLS ITS CUP ON THE WAY: a holder standing in a Shal'ille room with the cup short (or its sips
  // unknown) drops it and picks it straight back up, which refills it (chalice.kod ReqNewOwner). Never with a stranger in
  // the room: a cup on the floor is anybody's. At most once every two minutes.
  async chaliceTopUp(cfg, role, cup, store, now = Date.now()) {
    if (!cfg?.follows_holder || role !== 'holder' || !cup) return false;
    const here = this.hereRoom();
    if (!REFILL_ROOMS.has(here)) return false;
    let sips = null;
    try { sips = store.cup()?.sips ?? null; } catch {}
    if (Number(sips) >= CUP_MIN_SIPS) return false;
    if (now - (this._chaliceTopUpAt ?? 0) < 120_000) return false;
    const c = this.s?.client;
    if (!c?.room?.objects) return false;
    const players = [...c.room.objects.values()].filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
    if (players.some(o => !party.isFleetmate(c.rsc?.get(o.nameRsc) || ''))) return false;
    this._chaliceTopUpAt = now;
    await this.s.pacer.submit('act', () => c.drop([cup.id])).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    const floor = this.chaliceOnFloor();
    if (floor) {
      await this.s.lootFloor({ ids: [floor.id], maxItems: 1, overfarm: null }).catch(() => {});
      await this.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await new Promise(r => setTimeout(r, 800));
    }
    const back = !!this.chaliceInPack();
    if (back) try { store.setCup(CUP_MIN_SIPS, `refilled by a drop in room ${here}`); } catch {}
    this.chaliceEvent(back ? 'cup_refilled' : 'cup_refill_not_back', { room: here, sips_before: sips,
      why: back ? 'a following desk tops its cup up whenever it passes a Shal\'ille room'
                : 'dropped to refill and not yet picked back up: the floor sweep takes it next' });
    return true;
  }

  // A CHARACTER RUNNING THE DESK IN THE HOLDER'S ABSENCE IS THE ALTERNATE, for as long as the duty
  // record says so (actingDesk). Read at most every five seconds: every keeper asks this.
  chaliceRole() {
    const me = this.who(), r = roleOf(me, this.chaliceCfg);
    if (r !== 'traveller') return r;
    const now = Date.now();
    if (!this._chaliceActing || now - this._chaliceActing.at > 5_000) {
      let d = null;
      try { d = this.chaliceStore().duty(); } catch {}
      this._chaliceActing = { at: now, yes: sameName(actingDesk(d), me) || sameName(d?.drafted, me) };
    }
    // Only a duty-pool member: a stale record naming a farmer (Janice) does not draft it.
    return this._chaliceActing.yes && this.chaliceDutyEligible() ? 'alternate' : r;
  }

  /** Holder, alternate, or max health under duty_max_health (dutyEligible). */
  chaliceDutyEligible() {
    const max = this.s?.client?.vitals?.()?.health?.max ?? null;
    return dutyEligible({ name: this.who(), maxHealth: max, cfg: this.chaliceCfg });
  }

  // THE POOL REGISTERS ITSELF: no keeper can read another character's max health, so each one
  // under duty_max_health says so on the store (and withdraws when it is not). Every 5 minutes.
  chalicePoolCheckIn(now = Date.now()) {
    if (!this.chaliceCfg || (this._chalicePoolAt && now - this._chalicePoolAt < 5 * 60_000)) return;
    const max = this.s?.client?.vitals?.()?.health?.max ?? null;
    if (!Number.isFinite(Number(max)) || Number(max) <= 0) return;
    this._chalicePoolAt = now;
    const member = this.chaliceDutyEligible();
    if (!member && !this._chalicePoolMember) return;
    this._chalicePoolMember = member;
    try { this.chaliceStore().setPool(this.who(), member ? { max_health: Number(max) } : null, now); } catch {}
  }

  chaliceInPack() {
    const c = this.s?.client;
    return (c?.inventory || []).find(o => CHALICE.match.test(String(c.rsc.get(o.nameRsc) || ''))) ?? null;
  }

  chalicesInPack() {
    const c = this.s?.client;
    return (c?.inventory || []).filter(o => CHALICE.match.test(String(c.rsc.get(o.nameRsc) || ''))).length;
  }

  // THE CARRIER REGISTER, kept by every keeper for itself: written the pass the count changes and
  // refreshed every two minutes while it holds one. Read by everybody choosing whom to give a cup.
  chaliceCarryCheckIn(now = Date.now()) {
    if (!this.chaliceCfg || !this.s?.client?.inventory) return;
    const cups = this.chalicesInPack();
    const last = this._chaliceCarrySaid;
    if (last && last.cups === cups && (cups === 0 || now - last.at < 2 * 60_000)) return;
    try { this.chaliceStore().setCarrying(this.who(), cups, now); this._chaliceCarrySaid = { cups, at: now }; } catch {}
  }

  chaliceCarriers(now = Date.now()) {
    try { return this.chaliceStore().carriers(now); } catch { return []; }
  }

  /** Would accepting this trade put a second chalice in our pack? Then it must be refused. */
  offerWouldDoubleChalice(t) {
    return !!this.chaliceInPack()
      && (t?.theirs || []).some(i => CHALICE.match.test(String(i?.name || '')));
  }

  chaliceOnFloor() {
    const c = this.s?.client;
    return [...(c?.room?.objects?.values?.() ?? [])].find(o => (o.flags & OF.GETTABLE) && !(o.flags & OF.PLAYER)
      && CHALICE.match.test(String(c.rsc.get(o.nameRsc) || ''))) ?? null;
  }

  // A CUP ON THE FLOOR IS PICKED UP AT ONCE, BY WHOEVER THE DUTY RECORD SAYS — ANY KEEPER OF OURS.
  //
  // Operator, 2026-09-28: "grab it from the ground immediately if someone sees it, especially if
  // any non-fleet players are in the room. 'Who's on [x]-duty' is a broker/roster question ...
  // not by waiting to see if someone picks it up. Other players can steal it."
  //
  // History, so nobody puts a grace back: the first sweep (2026-09-27) waited 30 s so the ride's
  // own server went first — and a cup left in room 2 for 40 minutes is what it was fixing. Then it
  // re-lifted a cup that provision's cupRide had dropped for a rider (22:54Z), and the first fix
  // for THAT waited 180 s. Both waited to see who would pick it up. A hand-off is now REGISTERED
  // on the chalice store by whoever drops the cup (ChaliceStore.setHandoff), and sweepVerdict
  // reads the register: its rider takes it, nobody else; no hand-off, the holder, the alternate,
  // anybody; a stranger in the room, whoever is nearest, NOW.
  //
  // Runs on EVERY keeper, every pass, before the ladder: it costs one scan of the room when
  // there is no cup. Returns true only when it spent the pass acting.
  async chaliceGuard(now = Date.now()) {
    const cfg = this.chaliceCfg;
    const c = this.s?.client;
    if (!cfg || !c?.room?.objects) return false;
    this.chalicePoolCheckIn(now);
    this.chaliceCarryCheckIn(now);
    // A TRAVELLER MID-RIDE IS THE RIDE CODE'S: it was handed the cup, drinks it, drops it for its
    // server and is rescued out of the room. Taking it back would carry it to Barloque.
    const ride = this.activeChaliceRide();
    if (ride && !['decide', 'off', 'done'].includes(ride.stage)) return false;
    // A server's own ride pickup takes it itself, with the ticket bookkeeping.
    if (this._chaliceServe?.kind === 'ride' && this._chaliceServe.stage === 'pickup') return false;
    // A CARRIER NEVER SWEEPS A SECOND CUP. This used to ignore the cup in the pack whenever one lay
    // on the floor and grab it — which pours the floor cup into ours and deletes it (chalice.kod
    // NewOwner). It is left for somebody with empty hands; ours is handled as if the floor were bare.
    const held = this.chaliceInPack();
    const floor = held ? null : this.chaliceOnFloor();
    const cup = floor ? null : held;
    if (!cup) this._chaliceOffDutySaid = false;
    if (!floor && !cup) { this._chaliceFloorSince = null; return false; }
    const me = this.who();
    const players = [...c.room.objects.values()].filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
    const nameOf = o => c.rsc?.get(o.nameRsc) || '';
    // A fleetmate the roster has not caught up with reads as a stranger for a few seconds after
    // a restart; that costs a grab we would have made anyway, the cheap direction.
    const fleetHere = players.map(nameOf).filter(n => party.isFleetmate(n));
    const strangers = players.length - fleetHere.length;
    const store = this.chaliceStore();

    if (cup) {
      // WE ARE CARRYING IT AND ARE NOT ON DUTY: give it to whoever is, when they are here and
      // nobody else is. Dropped, with the hand-off registered first, so only they may lift it.
      // A fleetscript holding the body may be about to drink it (cupRide): not ours to move.
      if (this.chaliceRole() !== 'traveller' || strangers || this.busyStatus?.() || this.inert) return false;
      // A RETURN THAT WAS NOT TAKEN IS NOT TRIED AGAIN FOR A WHILE. On prod 2026-09-28 01:19-01:31 the
      // holder stood in room 2 with its keeper held by a fleetscript: every drop for it lay 20 s,
      // expired, and was picked up and dropped again. The cup was on the floor more than it was in
      // a pack. After one failed return this character keeps it for ten minutes, then tries again.
      const backoff = now < (this._chaliceReturnBackoffUntil ?? 0);
      // HAND IT BACK TO THE DESK RUNNER; NEVER BECOME THE DESK. Operator, 2026-10-06: "people not
      // running the service desk ... just hand the chalice back to the desk runner if the person
      // holding the chalice isn't taking a ride and the service desk manager is available in the
      // map." This used to register whoever picked the cup up as the ACTING DESK when nobody on duty
      // was beside it, which parked them at the station as the alternate: Janice swept it off the
      // floor and stood in room 2 for seven hours instead of practising hold. Drafting an alternate
      // is the HOLDER's decision, made when it has to leave on an errand (chaliceNextJob, relief).
      let duty = {};
      try { duty = store.duty(); } catch {}
      const carriers = this.chaliceCarriers(now);
      const to = backoff ? null : passTo({ cfg, fleetHere, duty, carriers });
      if (!to) {
        // A SECOND CUP DOES NOT TAKE OVER THE DUTY RECORD. When whoever the record says has the cup
        // still has one, ours is an extra: keep it, and leave `with` naming the desk's cup.
        const deskHas = servingDesk(duty, cfg, now, null)?.server ?? duty?.with;
        const deskCup = !sameName(deskHas, me) && carriesCup(carriers, deskHas);
        if (!deskCup && (sameName(duty?.acting, me) || !sameName(duty?.with, me))) {
          try { store.setDuty({ with: me, acting: null, lost: false }); } catch {}
          this._chaliceActing = null;
        }
        if (!this._chaliceOffDutySaid) {
          this._chaliceOffDutySaid = true;
          this.chaliceEvent('carrying_off_duty', { room: this.hereRoom(), by: me,
            why: 'nobody running the desk is here; kept safe and handed back when they are' });
        }
        return false;
      }
      if (this._chaliceReturnedAt && now - this._chaliceReturnedAt < 30_000) return false;
      this._chaliceReturnedAt = now;
      this._chaliceReturnedTo = { to, at: now };
      try { store.setHandoff({ rider: to, by: me, why: 'returned to duty' }); } catch { return false; }
      await this.s.pacer.submit('act', () => c.drop([cup.id])).catch(() => {});
      this.chaliceEvent('returned_to_duty', { room: this.hereRoom(), to });
      return true;
    }

    const key = `${this.hereRoom()}:${floor.id}`;
    if (this._chaliceFloorSince?.key !== key) this._chaliceFloorSince = { key, at: now };
    const lyingMs = now - this._chaliceFloorSince.at;
    let handoff = null;
    try { handoff = store.handoff(now); } catch {}
    const v = sweepVerdict({ me, cfg, handoff, fleetHere, strangers, lyingMs });
    if (!v.grab) return false;
    // A CUP THE SERVER WILL NOT LET GO OF IS NOT A CUP ON THE FLOOR. The Icky Cave (27) keeps
    // the original Chalice of the Rain on its altar, GETTABLE on the wire and refused by
    // OkayToGetChalice while the illusion stands or any orc lives ("it mystically clings to the
    // stone altar"). A failed grab used to return true, which spends the pass BEFORE the ladder:
    // Fozzie stood on the altar square at 2/60 with a 0.67 flee line, never fled, never swung,
    // and died to orcs twice on 2026-10-06. So a refused grab backs off that object (60s, doubling
    // to 10 min) and falls through to the ladder; when the altar does open, the next try takes it.
    const refused = this._chaliceRefused?.key === key ? this._chaliceRefused : null;
    if (refused && now < refused.until) return false;
    if (this.chaliceRole() === 'alternate') await this.chaliceMakeRoom();
    await this.s.lootFloor({ ids: [floor.id], maxItems: 1, overfarm: null }).catch(() => {});
    await this.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    if (!this.chaliceInPack()) {
      const n = (refused?.n ?? 0) + 1;
      this._chaliceRefused = { key, n, until: now + Math.min(60_000 * 2 ** (n - 1), 10 * 60_000) };
      if (n === 1) this.chaliceEvent('grab_refused', { room: this.hereRoom(), backoff_s: 60 });
      return false;
    }
    this._chaliceRefused = null;
    // Whoever lifts it is who has it; an acting desk it ended is over (the next pass
    // re-registers one if this character is to run the desk).
    try { store.setDuty({ with: me, lost: false, acting: null,
      ...(this.chaliceRole() === 'holder' ? { drafted: null } : {}) }); } catch {}
    this._chaliceActing = null;
    if (handoff && sameName(handoff.rider, me)) try { store.clearHandoff(me); } catch {}
    const unreturned = this._chaliceReturnedTo && now - this._chaliceReturnedTo.at < 120_000;
    if (unreturned) {
      this._chaliceReturnBackoffUntil = now + 10 * 60_000;
      this.chaliceEvent('return_not_taken', { room: this.hereRoom(), to: this._chaliceReturnedTo.to });
      this._chaliceReturnedTo = null;
    }
    this.chaliceEvent('swept', { room: this.hereRoom(), by: me, why: v.why, strangers,
      seen_on_floor_ms: lyingMs, ...(handoff ? { handoff_rider: handoff.rider } : {}) });
    this._chaliceFloorSince = null;
    return true;
  }

  // THE FLEET LOOT-IGNORE LIST: policy.lootIgnore when a character has its own, else the operator's
  // fleet file substrate/loot-ignore.json ({ignore: [{name, unless_unworn}]}), re-read at most every
  // minute. Missing or unreadable is an empty list: loot exactly as before.
  lootIgnoreList(now = Date.now()) {
    if (Array.isArray(this.policy?.lootIgnore)) return this.policy.lootIgnore;
    if (this._lootIgnoreAt && now - this._lootIgnoreAt < 60_000) return this._lootIgnoreCache ?? [];
    this._lootIgnoreAt = now;
    try {
      const f = fileURLToPath(new URL('../../substrate/loot-ignore.json', import.meta.url));
      const j = JSON.parse(readFileSync(f, 'utf8'));
      this._lootIgnoreCache = Array.isArray(j?.ignore) ? j.ignore : [];
    } catch { this._lootIgnoreCache = []; }
    return this._lootIgnoreCache;
  }

  // ------------------------------------------------------------------ money home by the desk

  /** Shillings in the guild hall's chests, from the latest readings; null when none was ever read. */
  hallShillings() {
    try {
      const chests = new StorageCache().allChests().filter(ch => Number(ch.room) === BOOKMAKERS_HALL_ROOM);
      if (!chests.length) return null;
      return chests.reduce((n, ch) => n + (ch.items ?? []).filter(i => /^shillings?$/i.test(String(i.name ?? '')))
        .reduce((m, i) => m + (Number(i.amount) || 0), 0), 0);
    } catch { return null; }
  }

  /**
   * HAND THE EXCESS TO THE DESK. Anyone of ours standing in the station room, not serving it, with
   * more than its keep + money_min, offers the excess to whoever servingDesk() says is on the desk
   * (whose social() counters a gift on its next pass). At most every three minutes.
   */
  async chaliceHandInMoney(now = Date.now()) {
    const cfg = this.chaliceCfg;
    if (!cfg?.money_flow || this.hereRoom() !== cfg.station_room) return false;
    if (this.chaliceRole() !== 'traveller' || this._chaliceServe || this.busyStatus?.() || this.inert) return false;
    // NOT WHILE SOMEBODY ELSE HOLDS THE PURSE. An errand that took `economy` is carrying money for
    // a reason: 2026-09-28 Kermit was funded 700 for a 1000-shilling spell and handed it straight to
    // the desk five seconds before learn-skill's hold landed, then walked for the bank in Barloque.
    if (this.facultyHeld?.('economy')) return false;
    const ride = this.activeChaliceRide();
    if (ride && !['decide', 'off', 'done'].includes(ride.stage)) return false;
    if (now - (this._moneyHandInAt ?? 0) < 3 * 60_000) return false;
    const keep = Math.max(this.walkingFloat(), this.shoppingPlan?.().required_purse ?? 0);
    const amount = moneyExcess({ purse: this.purseNow(), keep, min: cfg.money_min });
    if (!amount) return false;
    const store = this.chaliceStore();
    let desk = null;
    try { desk = servingDesk(store.duty(), cfg, now, store.read().human); } catch {}
    if (!desk?.server || desk.human || !this.playerHere(desk.server)) return false;
    this._moneyHandInAt = now;
    const c = this.s.client;
    const coins = (c.inventory || []).find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
    if (!coins) return false;
    const before = this.purseNow();
    const r = await this.chaliceGive(desk.server, [{ id: coins.id, amount }], { stillHave: () => this.purseNow() >= before, counterMs: 20_000 });
    this.chaliceEvent('money_handed_in', { to: desk.server, amount: r.gave ? before - this.purseNow() : 0, offered: amount,
      purse_before: before, purse_after: this.purseNow(), room: this.hereRoom(), ...(r.gave ? {} : { why: r.why }) });
    return !!r.gave;
  }

  /**
   * DEPOSIT AT THE HALL LANDING, up to the chests' target; the overflow is kept for the rider's own
   * banking. The whole stack goes in and the keep is drawn back in the same visit (a deposit takes
   * whole stacks). Verified by the purse, and the chest count before is on the ledger.
   */
  async chaliceDepositMoney(cfg) {
    if (!cfg?.money_flow) return false;
    const keep = Math.max(this.walkingFloat(), this.shoppingPlan?.().required_purse ?? 0);
    const purse = this.purseNow();
    const excess = moneyExcess({ purse, keep, min: cfg.money_min });
    if (!excess) return false;
    const chest = this.hallShillings();
    const plan = depositPlan({ excess, chest, target: cfg.hall_shilling_target });
    if (plan.deposit < (cfg.money_min ?? 0)) {
      this.chaliceEvent('money_deposited', { amount: 0, chest_before: chest, target: cfg.hall_shilling_target,
        overflow_kept: excess, why: plan.why ?? `under money_min (${plan.deposit})` });
      return false;
    }
    const drawBack = purse - plan.deposit;
    const r = await this.hallWithdraw(drawBack > 0 ? [{ item: 'shilling', amount: drawBack }] : [], { deposit: ['shilling'] });
    const after = this.purseNow();
    this.chaliceEvent('money_deposited', { amount: purse - after, planned: plan.deposit, chest_before: chest,
      target: cfg.hall_shilling_target, overflow_kept: plan.overflow, purse_before: purse, purse_after: after,
      ok: r?.ok !== false, ...(r?.ok === false ? { why: r.why } : {}) });
    if (after < keep) this.note('MONEY: the deposit left less than the keep', { purse: after, keep, drew_back: r?.took ?? null });
    return r?.ok !== false;
  }

  playerHere(name) {
    const c = this.s?.client;
    if (!name) return null;
    return [...(c?.room?.objects?.values?.() ?? [])].find(o => (o.flags & OF.PLAYER)
      && sameName(c.rsc.get(o.nameRsc) || '', name)) ?? null;
  }

  hereRoom() { return Number(this.s?.world?.room?.num ?? this.s?.client?.room?.num ?? NaN); }

  // `World.route` answers `hops` as the LIST of hops, not a count. This read `Number.isFinite`
  // of that array, which is false for every route there is, so the chalice's `shouldRide`
  // declined every ride on prod as "no route to the station" — ~120 declines in two days,
  // Castle Victoria (38) to the station next door (2) among them, and not one ride. The flow
  // test stubs this method with a number, which is the only reason it ever passed.
  hopsTo(room) {
    try {
      const r = this.s.world.route(Number(room));
      if (r?.found === false) return null;
      if (Array.isArray(r?.hops)) return r.hops.length;
      return Number.isFinite(r?.hops) ? r.hops : null;
    } catch { return null; }
  }

  /** The ride stage machine in flight: a town trip's, or one asked for on demand. */
  activeChaliceRide() { return this.townTrip?.chalice ?? this._rideNow?.chalice ?? null; }

  /**
   * RIDE THE CHALICE NOW, outside a town trip (operator, 2026-10-03). The same stage machine,
   * driven to a landing or a refusal; the decisions and the loop are in m59-chalice-ride.mjs.
   */
  chaliceRideNow(opts = {}) { return rideChaliceNow(this, opts); }

  /** Is a chalice step in flight? Read by `commitment()` so DUM steps over the character. */
  chaliceBusy() {
    const trip = this.activeChaliceRide();
    // A holder WAITING for its cup back is not busy — the post keeps casting meanwhile.
    const serving = this._chaliceServe && this._chaliceServe.kind !== 'reclaim';
    // AND THE ALTERNATE WHILE IT CARRIES THE CUP: it is standing in for the holder, and a
    // doctrine that re-stationed it to hunt would take the fleet's only server with it.
    const onDuty = this.chaliceRole() === 'alternate' && !!this.chaliceInPack();
    return !!(serving || onDuty || (trip && !['off', 'done'].includes(trip.stage)));
  }

  // ================================================================== STANDING ORDERS
  //
  // One-time tasks for the next town stop (tools/m59-standing-orders.mjs). The keeper's half
  // is the money: keep the price back from the bank and top the purse up from the guild's
  // chests. The teacher leg is the learn-skill FleetScript, run by `m59-standing-orders watch`.

  standingOrderReserve() {
    try { const p = pendingOrderFor(this.who()); return p ? orderPrice(p.order) : 0; }
    catch { return 0; }
  }

  /** An order nobody has taken a town trip for yet — the trigger that opens one. */
  standingOrderUnstarted() {
    try { const p = pendingOrderFor(this.who()); return p && !p.state?.status ? p.order : null; }
    catch { return null; }
  }

  async fundStandingOrder() {
    const p = (() => { try { return pendingOrderFor(this.who()); } catch { return null; } })();
    if (!p) return;
    const { order } = p;
    const price = orderPrice(order);
    const want = price + this.walkingFloat();
    const need = want - this.purseNow();
    if (need > 0) {
      await this.withdrawFromStockpile([{ item: 'shilling', amount: need }]).catch(e =>
        this.note('standing order: could not draw from the guild chest', { why: e.message }));
      if (this.travelInterrupted()) return { pending: true };
    }
    const purse = this.purseNow();
    // THE BANK COUNTS. The teacher leg is the learn-skill FleetScript, which walks to a bank
    // and withdraws `price - carrying` itself, so a character with the money banked is funded
    // whatever the guild chest held. This used to be purse-only and parked Statler as
    // `unfunded` for good with 1,289 in hand after an empty chest.
    const banked = Number(this.s.bankKnown?.()?.balance) || 0;
    const funded = purse >= price || purse + banked >= price;
    const what = orderSkills(order).join(', ');
    writeOrderState(this.who(), order.id, funded
      ? { status: 'funded', purse, banked, why: `carrying ${purse}${banked ? ` (+${banked} banked)` : ''} for ${what} (${price})` }
      : { status: 'unfunded', purse, banked, why: `only ${purse} (+${banked} banked) after the chest; ${what} costs ${price}` });
    try { recordEvent(this.who(), 'standing_order', { id: order.id, funded, purse, banked, price, drew: Math.max(0, need) }); } catch {}
    this.note(funded ? 'standing order funded' : 'standing order still short',
      { id: order.id, learn: order.learn, teacher: order.teacher, purse, price });
  }

  /** Worn items the server grades cursed (rarity 200), or that this session learned are. */
  chaliceCursedWorn() {
    const c = this.s?.client;
    const worn = new Set((c?.equipment?.()?.equipped ?? []).map(e => e.id));
    return (c?.inventory || []).filter(o => worn.has(o.id) &&
      (Number(o.rarity) === 200 || skills.isCursedItem(c, o)));
  }

  /** Unrevealed single items (rarity 100), at most `max`. Weapons first. */
  chaliceUnrevealed(max) {
    const rows = skills.unrevealedHeldBack(this.s?.client);
    rows.sort((a, b) => Number(!isWeaponName(a.name)) - Number(!isWeaponName(b.name)));
    return rows.slice(0, max);
  }

  // ASK ONLY FOR WHAT THE SERVER CAN DO, AND ONLY WHAT A PERSON CAN FINISH.
  //
  // Prod, 2026-09-25 18:24-18:26Z, with the operator playing Loial: Rowlf and Zoot each took
  // the cup, dropped their unrevealed items (a wand; three scrolls) and asked for reveal — from
  // a Loial holding ONE orc tooth, whose own published menu said `Reveal (-Req. reagents)`. The
  // cast could never happen, a person has no way to close a reveal ticket but typing "done",
  // and the tell did not say so; each stood holding the fleet's cup until the operator logged
  // in as them to drink it. Now:
  //   - a service the server's menu marks unavailable is not asked for (no menu: asked, as before);
  //   - a person serving is never asked for reveal: it means dropping the pack's items on a
  //     public floor for a cast nobody can verify, and it waits for the keeper instead.
  chaliceAskServices(cfg, store, me, { server = null, human = false } = {}) {
    const asked = [], dropped = [], skipped = [];
    const menu = (() => { try { return store.desk()?.[String(server ?? '').trim().toLowerCase()]?.menu ?? null; } catch { return null; } })();
    const unavailable = (kind) => {
      const m = Array.isArray(menu) ? menu.find(x => x.kind === kind) : null;
      return m && m.ok === false ? `${server} cannot: ${m.why ?? 'unavailable'}` : null;
    };
    if (cfg.uncurse && this.chaliceCursedWorn().length) {
      const no = unavailable('uncurse');
      if (no) skipped.push({ service: 'uncurse', why: no });
      else {
        store.request(me, { room: cfg.station_room, kind: 'uncurse' });
        asked.push('uncurse');
      }
    }
    let unread = cfg.reveal ? this.chaliceUnrevealed(cfg.reveal_max) : [];
    if (unread.length && human) {
      skipped.push({ service: 'reveal', why: 'a person is serving — reveal waits for the keeper' });
      unread = [];
    }
    if (unread.length && unavailable('reveal')) {
      skipped.push({ service: 'reveal', why: unavailable('reveal') });
      unread = [];
    }
    if (unread.length) {
      const c = this.s.client;
      try { c.drop(unread.map(u => u.id)); } catch {}
      dropped.push(...unread.map(u => u.id));
      store.request(me, { room: cfg.station_room, kind: 'reveal', items: unread.map(u => ({ id: u.id, name: u.name })) });
      asked.push('reveal');
    }
    return { asked, dropped, skipped, droppedIn: dropped.length ? this.hereRoom() : null, at: Date.now() };
  }

  /** What this character can spare toward the holder's supply, from its own spares. */
  chaliceDonation(store) {
    const cfg = this.chaliceCfg;
    if (!cfg || !Object.keys(cfg.holder_supply ?? {}).length) return {};
    const short = holderShortfall(store.supply(), { except: this.who() });
    const floors = { ...this.carryFloors() };
    // Our own casting floor where we have one (elderberry, herb); everything else is kept only
    // to the loadout's own `carry` minimum.
    for (const k of Object.keys(short))
      if (k in REAGENT_TARGET_BY_KIND)
        floors[k] = Math.max(floors[k] ?? 0, Number(reagentTargetFor(k, this.policy.reagentTarget)) || 0);
    const have = Object.fromEntries(Object.keys(short).map(k => [k, this.reagentOnHand(k)]));
    return donationPlan({ have, floors, shortfall: short });
  }

  /** Trade specs for `{item: amount}` out of this pack, stack-aware. */
  chaliceSpecs(gift) {
    const c = this.s.client, specs = [];
    for (const [item, amount] of Object.entries(gift)) {
      let left = amount;
      for (const o of (c.inventory || []).filter(x => this.matchesKind(c.rsc.get(x.nameRsc) || '', item))) {
        if (left <= 0) break;
        const n = Math.min(left, Number(o.amount) || 1);
        specs.push(dropSpecFor(o, n));
        left -= n;
      }
    }
    return specs;
  }

  // THE RESTOCK: pledge part of the holder's shortfall, draw it from the guild's chests (we
  // are standing beside them), and carry it back through the station.
  async chaliceTakeCargo(cfg, store) {
    if (!Object.keys(cfg.holder_supply ?? {}).length) return;
    if (!this.policy.guildWants?.enabled && !this.policy.reagentCoop?.enabled) return;
    const supply = store.supply();
    const short = holderShortfall(supply, { except: this.who() });
    const wants = cargoWants({ shortfall: short, target: supply.target ?? cfg.holder_supply, cfg });
    if (!Object.keys(wants).length) return;
    const granted = store.pledge(this.who(), wants);
    if (!Object.keys(granted).length) return;
    // A PLEDGE THAT OUTLIVES A FAILED DRAW STARVES THE HOLDER FOR AN HOUR. `holderShortfall`
    // subtracts every live pledge, so on 2026-09-25 one crashed draw that pledged 29 orc teeth
    // told every other traveller Loial needed none -- and he sat on one tooth all day. So the
    // pledge is released on EVERY way out that carries nothing, a throw included, and the
    // reason is a ledger row rather than a note that scrolls away.
    const before = Object.fromEntries(Object.keys(granted).map(k => [k, this.reagentOnHand(k)]));
    let drew = null, failed = null;
    try {
      drew = await this.withdrawFromStockpile(Object.entries(granted).map(([item, amount]) => ({ item, amount })));
    } catch (e) { failed = e?.message ?? String(e); }
    const got = Object.fromEntries(Object.keys(granted)
      .map(k => [k, Math.max(0, this.reagentOnHand(k) - before[k])]).filter(([, n]) => n > 0));
    if (!Object.keys(got).length) {
      try { store.unpledge(this.who()); } catch {}
      this.chaliceEvent(failed ? 'cargo_draw_failed' : 'cargo_none',
        { wanted: granted, why: failed ?? drew?.why ?? 'the chests gave nothing' });
      return;
    }
    store.pledge(this.who(), got);
    this._holderCargo = { items: got, at: Date.now(), tries: 0 };
    this.chaliceEvent('cargo_taken', { items: got });
    this.note('carrying the holder\'s restock back', { items: got });
  }

  // DRAW THE HOLDER'S RESTOCK FROM THE GUILD CHEST ON AN ORDINARY TRIP HOME. Operator,
  // 2026-09-26: "Resources for the chalice holder shouldn't only be replenished on chalice ride".
  // `chaliceTakeCargo` ran only for a traveller that rode the cup and landed in the hall, and
  // rides rarely complete — so the chest (which holds the teeth no merchant sells) was almost
  // never drawn for him. Now every town trip that passes near the hall draws his shortfall, at
  // least `restock_min_fraction` of his target per item, and hands it over at the station on
  // the way home through the same `_holderCargo` delivery. Before the buying step: the chest
  // is free, and a pledge here shrinks what the counter is asked for.
  async chaliceTownCargo() {
    const cfg = this.chaliceCfg;
    if (!cfg?.enabled || this.chaliceRole() !== 'traveller' || this._holderCargo) return;
    if (!Object.keys(cfg.holder_supply ?? {}).length) return;
    const store = this.chaliceStore();
    if (!Object.keys(holderShortfall(store.supply(), { except: this.who() })).length) return;
    const hops = this.hereRoom() === GUILD_HALL_ROOM ? 0 : this.hopsTo(GUILD_HALL_ROOM);
    if (!Number.isFinite(hops) || hops > cfg.chest_detour_hops) {
      this.chaliceEvent('cargo_chest_skipped', { hops: Number.isFinite(hops) ? hops : null,
        limit: cfg.chest_detour_hops, why: 'the guild hall is too far from this town trip' });
      return;
    }
    await this.chaliceTakeCargo(cfg, store);
  }

  // BUY THE HOLDER'S RESTOCK WITH THE MONEY THIS TRIP JUST MADE, and carry it back as the tip.
  //
  // The operator's order, 2026-09-24. `chaliceTakeCargo` above draws the same goods from the
  // guild chest for nothing, and is the better source -- but it runs at exactly ONE moment: a
  // traveller that rode the chalice and landed in the hall. Measured that day, the chest held
  // 4,551 elderberries and 2,028 emeralds and had been drawn from ZERO times, because the
  // service had never completed a ride. The holder's supply was gated behind the very service
  // his supply keeps running, and he ran down to nine castings while the fleet stood on 4,551.
  //
  // So this is the source that needs no ride: every town trip that sells something can spend a
  // little of it at a counter it is already near. It runs AFTER the sale and after the trip's
  // own restocking, out of what is left over -- the character's own food and reagents are a
  // floor, not a share -- and it hands over through the same `_holderCargo` path the chest
  // draw uses, so there is one delivery and one place it can go wrong.
  async chaliceBuyCargo() {
    const cfg = this.chaliceCfg;
    if (!cfg?.enabled) return;
    // THE SERVER DOES NOT TIP ITSELF. A holder or an on-duty alternate buying its own restock
    // is just a supply trip, and the supply trip is the thing this exists to make unnecessary.
    if (this.chaliceRole() !== 'traveller') return;
    if (!Object.keys(cfg.holder_supply ?? {}).length) return;
    if (!Object.keys(cfg.supply_shops ?? {}).length) return;
    const store = this.chaliceStore();
    const short = holderShortfall(store.supply(), { except: this.who() });
    if (!Object.keys(short).length) return;
    // SAID ON THE LEDGER: a holder going short while every trip quietly declined to buy is
    // exactly the state that took a day to notice on 2026-09-25.
    if (!purchaseEnabled(this.policy, 'reagents')) {
      this.chaliceEvent('cargo_buy_skipped', { short, why: 'this character may not buy reagents' });
      return;
    }

    // WHAT IS LEFT AFTER THIS CHARACTER'S OWN NEEDS, and the order of subtraction is the
    // point: walking money and the trip's own shopping come out first, and the holder gets
    // what survives. A fleet that tips itself broke stops farming, and a holder with no
    // farmers has nothing to serve.
    const ownPlan = this.shoppingPlan();
    const keep = Math.max(this.walkingFloat(), Number(ownPlan.required_purse) || 0);
    let budget = Math.min(Number(cfg.restock_budget) || 0, Math.max(0, this.purseNow() - keep));
    if (budget <= 0) {
      this.note('nothing to spare for the holder this trip',
        { purse: this.purseNow(), keeping: keep, short });
      this.chaliceEvent('cargo_buy_skipped', { short, why: 'nothing to spare after own needs',
        purse: this.purseNow(), keeping: keep });
      return;
    }

    const stops = restockBuyPlan({ shortfall: short, cfg });
    if (!stops.length) return;
    const pledged = store.pledge(this.who(),
      Object.fromEntries(stops.flatMap(st => st.lines.map(l => [l.item, l.amount]))));
    if (!Object.keys(pledged).length) return;

    const s = this.s, c = s.need();
    const got = {};
    try {
      for (const stop of stops) {
        if (this.travelInterrupted() || this.suspendedJourney) break;
        if (budget <= 0) break;
        if (this.hereRoom() !== stop.room) {
          const walked = await this.travel(stop.room, { origin: keeperOrigin('chalice_cargo_buy'), maxHops: 12 })
            .catch(error => ({ arrived: false, reason: error.message }));
          if (!walked?.arrived) {
            this.note('could not reach a counter for the holder', { room: stop.room, why: walked?.reason });
            continue;
          }
        }
        await this.makeRoomToBuy(null, { wantSlots: Math.max(4, stop.lines.length * 2) }).catch(() => {});
        const before = c.evSeq;
        const pick = await this.sellerHere({ want: new RegExp(stop.lines.map(l => l.match).join('|'), 'i') })
          .catch(() => null);
        if (!pick) { this.note('nobody at that counter opened a list', { room: stop.room, seller: stop.seller }); continue; }
        await s.pacer.submit('buy', () => c.buy(pick.seller.id ?? pick.seller));
        const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 })
          .catch(() => ({ events: [] }));
        const shop = ev.events?.find(e => e.kind === 'shop');
        if (!shop) { this.note("no shop list for the holder's restock", { room: stop.room }); continue; }
        for (const line of stop.lines) {
          if (budget <= 0) break;
          const row = (shop.items ?? []).find(i => new RegExp(line.match, 'i').test(String(i.name ?? '')));
          // NOT A FAILURE. The two halves are sold by different people, so "this counter does not
          // stock it" is the ordinary case at either one.
          if (!row || !(Number(row.id) > 0)) continue;
          const unit = Number(row.cost) || 0;
          // AN UNPRICED ROW IS NOT A FREE ONE. Skipped rather than bought blind: the clamp below
          // is the only thing standing between a tip and this character's own food money.
          if (!(unit > 0)) continue;
          const amount = Math.min(line.amount, Math.floor(budget / unit));
          if (amount <= 0) continue;
          const held = this.countOfKind(line.item);
          for (const l of buyLines([{ id: Number(row.id), amount }])) {
            await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [l]));
            const seq = c.evSeq;
            await s.pacer.submit('read', () => c.requestInventory());
            await c.waitFor({ since: seq, kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
          }
          // RULE 6: WHAT ENTERED THE PACK. `buyItems` completes the handshake whether or not the
          // purse could cover it -- the counter clamps and says so -- so the gain is the evidence
          // and the reply is not.
          const gained = Math.max(0, this.countOfKind(line.item) - held);
          if (gained > 0) {
            got[line.item] = (got[line.item] ?? 0) + gained;
            budget -= gained * unit;
          }
        }
      }

    } catch (e) {
      // THE SAME RULE AS THE CHEST DRAW: a throw must not leave a pledge standing in for goods.
      this.chaliceEvent('cargo_buy_failed', { why: e?.message ?? String(e), got });
      if (!Object.keys(got).length) { try { store.unpledge(this.who()); } catch {} return; }
    }
    if (!Object.keys(got).length) {
      store.unpledge(this.who());
      this.chaliceEvent('cargo_buy_skipped', { short, why: 'the counters sold nothing within budget' });
      return;
    }
    // Merge rather than replace: a traveller may already be carrying a chest draw, and the
    // delivery path hands over whatever is in `_holderCargo` in one trade.
    const carrying = this._holderCargo?.items ?? {};
    const items = { ...carrying };
    for (const [k, n] of Object.entries(got)) items[k] = (items[k] ?? 0) + n;
    store.pledge(this.who(), items);
    this._holderCargo = { items, at: Date.now(), tries: this._holderCargo?.tries ?? 0 };
    this.tally.chalice_restock_bought = (this.tally.chalice_restock_bought || 0) + 1;
    this.chaliceEvent('cargo_bought', { items: got, spent: (cfg.restock_budget || 0) - budget });
    this.note("bought the holder's restock to tip on the way home",
      { items: got, left_to_spend: budget });
  }

  /**
   * DELIVER THE RESTOCK on the way back to the castle. Runs after the town trip is over;
   * the station is on the road from the hall to Castle Victoria, so this is a stop, not a trip.
   */
  async chaliceDeliverCargo() {
    const cfg = this.chaliceCfg, cargo = this._holderCargo;
    if (!cfg || !cargo || this.townTrip) return false;
    const store = this.chaliceStore();
    const give = Object.fromEntries(Object.entries(cargo.items)
      .map(([k, n]) => [k, Math.min(n, this.reagentOnHand(k))]).filter(([, n]) => n > 0));
    const drop = () => { this._holderCargo = null; try { store.unpledge(this.who()); } catch {} return false; };
    if (!Object.keys(give).length || Date.now() - cargo.at > 60 * 60_000 || cargo.tries > 6) return drop();
    const humans = store.humans();
    const server = servingOrHolder(store.duty(), cfg, humans);
    // A PERSON AT THE SERVER'S CONTROLS WOULD HAVE TO COUNTER A TRADE NOBODY ASKED THEM FOR,
    // inside eight seconds, six times over. The cargo keeps for an hour; it is delivered when
    // the keeper is back rather than spent as `tries` against somebody playing.
    if (humanMark(humans, server)) {
      if (!cargo.humanSaid) {
        cargo.humanSaid = true;
        this.chaliceEvent('cargo_held', { to: server, why: 'the server is played by a person — delivering once the keeper is back' });
      }
      return false;
    }
    const hops = this.hereRoom() === cfg.station_room ? 0 : this.hopsTo(cfg.station_room);
    if (!Number.isFinite(hops) || hops > cfg.max_detour_hops + 8) return false;   // not on our road yet
    if (hops > 0) {
      const r = await this.travel(cfg.station_room, { origin: keeperOrigin('chalice_delivery'), maxHops: hops + 4 }).catch(e => ({ arrived: false }));
      if (!r.arrived) { cargo.tries++; return true; }
    }
    if (!this.playerHere(server)) { cargo.tries++; return false; }
    const before = Object.fromEntries(Object.keys(give).map(k => [k, this.reagentOnHand(k)]));
    const r = await this.chaliceGive(server, this.chaliceSpecs(give),
      { stillHave: () => Object.keys(give).every(k => this.reagentOnHand(k) >= before[k]) });
    cargo.tries++;
    if (r.gave) {
      this.chaliceEvent('cargo_delivered', { to: server, items: give });
      this.note('restocked the holder', { to: server, items: give });
      return drop() || true;
    }
    return true;
  }

  /** Cast one targeted spell by name. `{cast, why}`; verified by the caller. */
  async chaliceCast(name, targetId) {
    const s = this.s, c = s.need();
    const spell = (c.spells || []).find(sp => String(c.rsc.get(sp.nameRsc) || '').toLowerCase() === name);
    if (!spell) return { cast: false, why: `does not know ${name}` };
    try { await skills.standToAct(s); } catch {}
    await withCastRite(s, { spell, targets: [targetId], why: 'chaliceCast' }, () => s.pacer.submit('cast', () => c.cast(spell.id, [targetId]), 1050));
    await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
    return { cast: true };
  }

  /** Serve one traveller's uncurse and reveal tickets. True while there is work left. */
  async chaliceServeServices(traveller, store) {
    const open = store.openFrom(traveller, ['uncurse', 'reveal']);
    if (!open.length) return false;
    await this.chaliceServeTicket(open[0], store);
    return true;
  }

  /** Cast one uncurse or reveal ticket for whoever filed it, and close it. */
  async chaliceServeTicket(t, store) {
    const traveller = t.traveller;
    const them = this.playerHere(traveller);
    if (t.kind === 'uncurse') {
      if (them && this.reagentOnHand('emerald') >= 1)
        for (let i = 0; i < 3; i++) await this.chaliceCast('remove curse', them.id);
      store.mark(t.id, 'done', { note: them ? 'cast remove curse x3' : 'traveller not here' });
      this.chaliceEvent('uncursed', { for: traveller, cast: !!them, ...(t.human ? { human: true } : {}) });
      return;
    }
    // MEND, like reveal, reaches only the caster's pack or its own floor (mend.kod:106-110), so the
    // traveller dropped what it wants mended here. A sapphire and an orc tooth a cast
    // (mend.kod:55-56). The server checks nothing about the item: mend.kod refuses a broken one
    // and a full one before any reagent is spent, and the requester reads the condition back.
    if (t.kind === 'mend') {
      const floorNow = [...(this.s.client?.room?.objects?.values?.() ?? [])];
      const onFloor = new Set(floorNow.map(o => o.id));
      // A PERSON'S TICKET NAMES NOTHING: they said "mend" and dropped it. Anything gettable on
      // the floor is a candidate, nearest the server's own reach of `mend_max`.
      const items = t.items ?? floorNow
        .filter(o => (o.flags & OF.GETTABLE) && !(o.flags & OF.PLAYER))
        .slice(0, this.chaliceCfg?.mend_max ?? 3)
        .map(o => ({ id: o.id, name: this.s.client?.rsc?.get?.(o.nameRsc) ?? '' }));
      const keep = this.chaliceReagentFloor();
      let done = 0;
      for (const item of items.slice(0, this.chaliceCfg?.mend_max ?? 3)) {
        if (!onFloor.has(item.id)) continue;
        if (this.reagentOnHand('sapphire') - (keep['sapphire'] ?? 0) < 1) break;
        if (this.reagentOnHand('orc tooth') - (keep['orc tooth'] ?? 0) < 1) break;
        const r = await this.chaliceCast('mend', item.id);
        if (r.cast) done++;
      }
      store.mark(t.id, 'done', { note: `mend cast on ${done} of ${items.length}`, mended: done });
      this.chaliceEvent('mended', { for: traveller, cast_on: done, asked: items.length,
        ...(t.human ? { human: true } : {}) });
      return;
    }
    // REVEAL reaches only the caster's own pack or the floor it stands on (reveal.kod:94), so
    // the traveller dropped the items here. Three orc teeth and thirty mana each.
    //
    // A PERSON'S TICKET NAMES NO ITEMS — they said "reveal" and dropped things. So the floor is
    // read for what is still unrevealed (rarity 100 travels on every object, m59-items.mjs),
    // which also means nothing already identified costs a tooth.
    const floor = [...(this.s.client?.room?.objects?.values?.() ?? [])];
    const floorIds = new Set(floor.map(o => o.id));
    const items = t.items ?? floor
      .filter(o => (o.flags & OF.GETTABLE) && !(o.flags & OF.PLAYER) && skills.isUnrevealed(o))
      .slice(0, this.chaliceCfg?.reveal_max ?? 3)
      .map(o => ({ id: o.id, name: this.s.client?.rsc?.get?.(o.nameRsc) ?? '' }));
    let done = 0;
    // THE HOLDER'S KEEP IS NOT THE DESK'S TO SPEND (`holder_keep`, e.g. teeth for a raid).
    const keepTeeth = this.chaliceReagentFloor()['orc tooth'] ?? 0;
    for (const item of items) {
      if (!floorIds.has(item.id)) continue;
      if (this.reagentOnHand('orc tooth') - keepTeeth < 3) break;
      const r = await this.chaliceCast('reveal', item.id);
      if (r.cast) done++;
    }
    store.mark(t.id, 'done', { note: `reveal cast on ${done} of ${items.length}` });
    this.chaliceEvent('revealed', { for: traveller, cast_on: done, asked: items.length,
      ...(t.human ? { human: true } : {}) });
  }

  // ------------------------------------------------------------------ the human desk
  //
  // Operator, 2026-09-25 (m59-research design/research-spec-human-service-bot.md). When a PERSON is
  // playing the server, a request goes to them as a tell rather than waiting for a keeper the
  // login displaced. Every tell is a ledger row — `desk_tell`, with whether the server echoed
  // it — because "is the operator still blocking the fleet" is answered from those rows.

  /**
   * A ticket a PERSON filed is served only for a fleetmate. The broker already refuses anyone
   * else; this is the server's own check, so a ticket that got into the store some other way
   * is closed with a reason instead of served. Keeper-filed tickets pass untouched.
   */
  chaliceFleetOnly(t, store) {
    if (!t || !t.human || party.isFleetmate(t.traveller)) return t;
    try { store.mark(t.id, 'abandoned', { note: `${t.traveller} is not a fleetmate` }); } catch {}
    this.chaliceEvent('desk_refused', { ticket: t.id, for: t.traveller, service: t.kind,
      why: 'not a fleetmate', human: true });
    return null;
  }

  /** The live human mark for the character serving, or null. */
  chaliceHumanServer(store, server) {
    const cfg = this.chaliceCfg;
    if (!cfg || cfg.human_desk === false || !server) return null;
    try { return humanMark(store.humans(), server); } catch { return null; }
  }

  /**
   * `~B~k[Service Request] ~b <what>` to `to`, by name. A tell costs one mana and a refusal
   * is prose, so `echoed` is the only evidence it went. Never throws.
   */
  async chaliceTell(to, what, detail = {}, { reply = false } = {}) {
    const s = this.s, c = s?.client;
    const text = reply ? serviceReplyText(what) : serviceTellText(what);
    const record = (sent, why = null) => {
      this.chaliceEvent('desk_tell', { to, said: what, sent, ...(reply ? { reply: true } : {}), ...(why ? { why } : {}), ...detail });
      return { sent, why };
    };
    if (!c?.sayGroup) return record(false, 'no client to speak with');
    // FLEETMATES ONLY (operator, 2026-09-25): a service tell goes to one of our own characters
    // or nowhere. Every recipient here comes from the store, never from what somebody said,
    // and this says so in code rather than trusting that it always will.
    if (!party.isFleetmate(to)) return record(false, `${to} is not a fleetmate`);
    try {
      const asked = c.evSeq;
      await s.pacer.submit('read', () => c.players());
      await c.waitFor({ since: asked, kinds: ['who'], timeoutMs: 3000 }).catch(() => {});
      const hit = [...(c.playersOnline?.values?.() ?? [])].find(p => sameName(p.name, to));
      if (!hit) return record(false, `${to} is not on the who list`);
      const sent = c.evSeq;
      await s.pacer.submit('say', () => c.sayGroup([hit.id], text));
      const ev = await c.waitFor({ since: sent, kinds: ['said', 'message'], timeoutMs: 2500 })
        .catch(() => ({ events: [] }));
      const echoed = (ev.events ?? []).some(e => e.kind === 'said' && e.speaker === c.selfId);
      if (echoed) return record(true);
      const said = (ev.events ?? []).find(e => e.kind === 'message' && e.text)?.text;
      return record(false, said ? `server said: ${String(said).slice(0, 120)}` : 'not echoed — short of mana?');
    } catch (e) { return record(false, e.message); }
  }

  /**
   * THE SERVER'S MENU, written where the broker can read it. The broker answers a person's
   * "services?" from this, so the answer comes from the facts of the body that serves —
   * reagents, the rescue floor, whether it holds the cup — and not from a copy of them.
   */
  chalicePublishDesk(cfg, store, me, cup, now = Date.now()) {
    // A FOLLOWING DESK PUBLISHES AT ONCE WHEN ITS HOLDER CHANGES ROOM: travellers find it by this record.
    const moved = cfg.follows_holder && this._chaliceDeskSaidRoom !== this.hereRoom();
    if (!moved && this._chaliceDeskSaidAt && now - this._chaliceDeskSaidAt < (cfg.follows_holder ? 30_000 : 60_000)) return;
    this._chaliceDeskSaidAt = now;
    this._chaliceDeskSaidRoom = this.hereRoom();
    const floor = this.chaliceReagentFloor();
    const have = Object.fromEntries(['emerald', 'orc tooth', 'elderberry', 'sapphire'].map(k => [k, this.reagentOnHand(k)]));
    const c = this.s?.client;
    const knows = { mend: (c?.spells ?? []).some(sp => String(c?.rsc?.get?.(sp.nameRsc) ?? '').toLowerCase() === 'mend') };
    let menu = deskMenu({ cfg, have, floor, casts: this.chaliceCastsLeft(), cup: !!cup, knows });
    if (cfg.follows_holder && cup) {
      const b = rideBudget({ room: this.hereRoom(), sips: store.cup?.()?.sips, reserve: cfg.cup_reserve });
      const off = store.cup?.()?.disabled?.why;
      if (off) menu = menu.map(m => (m.kind === 'ride' ? { ...m, ok: false, why: 'desk disabled: cannot refill' } : m));
      else if (!b.ok) menu = menu.map(m => (m.kind === 'ride' ? { ...m, ok: false, why: 'cup needs a refill' } : m));
    }
    const limits = Object.fromEntries(['human_hold_ms', 'human_max_wait_ms', 'ticket_ttl_ms']
      .map(k => [k, cfg[k]]));
    try { store.setDesk(me, { menu, room: cfg.post_room ?? cfg.station_room, fol_room: folRoomsOf(cfg)[0] ?? null, limits }, now); } catch {}
  }

  /**
   * Fit to leave the post for a forces-of-light cast: the doctrine's own flee line (0.9 of a
   * 20-health body), mana for the cast, and a cast's worth of reagents.
   */
  // WHEN THIS CHARACTER LAST SWUNG AT A PLAYER, and why anything keeps it.
  //
  // The server bans teleporting for ten minutes after that (util/settings.kod:88), and the
  // chalice obeys the same clock (chalice.kod:168) — so a traveller that fought somebody on
  // the way to town will be refused the sip at the END of the whole detour: after walking,
  // waiting for the hand-over, and paying the tip. `GetLastPlayerAttackTime` is server-side
  // and nothing sends it to us, so the only way to know is to remember our own swing.
  //
  // ROUGH ON PURPOSE. It is stamped where we ISSUE the attack, not where the server confirms
  // one landed, so it can be a little early and can record a swing that missed. Both errors
  // are in the safe direction: the ban starts at the attack whether or not it connected, and
  // being a second early costs nothing. It lives on the SESSION as well as on `this` because
  // combat mode drives some swings through its own module and shares only the session.
  notePlayerSwing(now = Date.now()) {
    this._lastPlayerAttackAt = now;
    if (this.s) this.s.lastPlayerAttackAt = now;
  }

  /** The stamp above, from wherever it was written. null when we have never swung at one. */
  lastPlayerSwingAt() {
    const mine = Number(this._lastPlayerAttackAt);
    const theirs = Number(this.s?.lastPlayerAttackAt);
    const best = [mine, theirs].filter(Number.isFinite);
    return best.length ? Math.max(...best) : null;
  }

  chaliceFit() {
    const v = this.s?.client?.vitals?.();
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.9) return false;
    const ench = Autopilot.ROOM_ENCHANTS.find(e => e.name === 'forces of light');
    if (v.mana && v.mana.value < (Number(this.policy.roomEnchant?.mana_floor) || ench.mana)) return false;
    return this.chaliceCastsLeft() >= 1;
  }

  /** Reagents this character keeps back from its own spells — the holder's Rescue emeralds. */
  chaliceReagentFloor() {
    return this.chaliceCfg ? reagentFloor(this.chaliceCfg, this.chaliceRole()) : {};
  }

  /**
   * ANYONE STANDING IN THE FORCES-OF-LIGHT ROOM ASKS FOR IT when the shared clock says it has
   * lapsed. Cheap: one file read every ten seconds, and a request at most every thirty.
   */
  chaliceFolWatch(now = Date.now()) {
    const cfg = this.chaliceCfg;
    // ANY ROOM THE HOLDER LIGHTS, each on its own clock and its own tickets (fol_rooms).
    const here = this.hereRoom();
    if (!cfg || !folRoomsOf(cfg).includes(here)) return;
    if (this._folLookedAt && now - this._folLookedAt < 10_000) return;
    this._folLookedAt = now;
    const store = this.chaliceStore();
    if (!folWanted({ cfg, here, fol: store.folFor(here), now, role: this.chaliceRole() })) return;
    if (this._folAskedAt && now - this._folAskedAt < 30_000) return;
    this._folAskedAt = now;
    // A PERSON SERVING IS TOLD, ONCE PER `human_tell_gap_ms` FOR THE WHOLE FLEET. Everybody in
    // 38 files a ticket; `claimTell` decides which one of them speaks.
    const desk = (() => { try { return servingDesk(store.duty(), cfg, now, store.humans()); } catch { return null; } })();
    const human = !!desk?.human && cfg.human_desk !== false;
    try {
      store.request(this.who(), { room: here, kind: 'fol', ttlMs: 120_000,
                                  ...(human ? { server: desk.server } : {}) });
    } catch {}
    if (human) {
      let speak = false;
      try { speak = store.claimTell(`fol:${desk.server.toLowerCase()}`, cfg.human_tell_gap_ms, now); } catch {}
      if (speak) {
        const waiting = (() => { try { return store.read().tickets.filter(t => t.kind === 'fol' && t.status === 'open' && (t.room == null || Number(t.room) === here)).length; } catch { return 1; } })();
        this.chaliceTell(desk.server, `forces of light (${here}) — ${waiting} waiting`, { service: 'fol', human: true })
          .catch(() => {});
      }
    }
  }

  /** Forces-of-light casts on hand, the holder's own supply clock. */
  // COUNTED ABOVE THE RESCUE FLOOR, so the hand-off to the alternate and the supply trip
  // both happen while the holder can still Rescue out rather than walk.
  chaliceCastsLeft() {
    const ench = Autopilot.ROOM_ENCHANTS.find(e => e.name === 'forces of light');
    const have = Object.fromEntries(ench.reagents.map(([n]) => [n, this.reagentOnHand(n)]));
    return castsAbove(have, ench.reagents, this.chaliceReagentFloor());
  }

  chaliceEvent(what, detail = {}) {
    try { recordEvent(this.who(), 'chalice', { what, room: this.hereRoom(), ...detail }); } catch {}
  }

  // THE TWO-SIDED GIFT. Offer, wait for the other keeper's empty counter (social() makes it,
  // and acceptDonations lets a chalice and shillings through), accept, read the pack back.
  // Verified by what LEFT the pack, never by the handshake: a trade that completes and moves
  // nothing reads exactly like one that worked.
  // `counterMs`: a keeper counters inside a second, a PERSON has to find the window — see
  // `human_offer_ms`.
  async chaliceGive(toName, items, { stillHave, counterMs = 8000 }) {
    const s = this.s, c = s.need();
    const them = this.playerHere(toName);
    if (!them) return { gave: false, why: `${toName} is not in the room` };
    // NEVER A CUP TO SOMEBODY ALREADY CARRYING ONE. Every hand-off of the cup comes through here
    // (relief, return, ride, reclaim), so this is the one gate: chalice.kod NewOwner pours ours into
    // theirs and deletes it. Their own keeper refuses the offer too (offerWouldDoubleChalice).
    const ids = new Set([].concat(items).map(i => Number(i?.id ?? i)));
    const givingCup = (c.inventory || []).some(o => ids.has(Number(o.id)) && CHALICE.match.test(String(c.rsc.get(o.nameRsc) || '')));
    if (givingCup && carriesCup(this.chaliceCarriers(), toName)) {
      const said = this._chaliceSecondCupSaid;
      if (!said || !sameName(said.to, toName) || Date.now() - said.at > 5 * 60_000) {
        this._chaliceSecondCupSaid = { to: toName, at: Date.now() };
        this.chaliceEvent('give_refused_second_cup', { to: toName });
      }
      return { gave: false, code: 'second_cup', why: `${toName} already carries a chalice — a second would be poured in and destroyed` };
    }
    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, items));
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: counterMs })
      .catch(() => ({ events: [] }));
    if (!ev.events?.some(e => e.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      return { gave: false, why: `${toName} never countered — busy, full, or not running` };
    }
    const accepting = c.evSeq;
    await s.pacer.submit('trade', () => c.acceptOffer());
    await c.waitFor({ since: accepting, kinds: ['trade-ended'], timeoutMs: 4000 }).catch(() => {});
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    return stillHave() ? { gave: false, why: 'the handshake ended and nothing left the pack' } : { gave: true };
  }

  // ------------------------------------------------------------------ the traveller

  /**
   * RIDE THE CHALICE HOME. Called from `continueTownTrip` before the outbound walk.
   *
   * Returns `{pending}` to hold the trip for another pass, `{done}` once the character has
   * landed (the walk that follows plans from wherever that is), or `{skip}` — which is never
   * a failure of the trip, only a return to walking it.
   */
  async chaliceRide(trip) {
    const cfg = this.chaliceCfg;
    if (!cfg) return { skip: true, why: 'chalice farming is off' };
    const st = (trip.chalice ??= { stage: 'decide', at: Date.now() });
    const now = Date.now();
    const store = this.chaliceStore();
    const me = this.who();
    const skip = (why, detail = {}) => {
      if (st.ticket) try { store.mark(st.ticket, 'abandoned', { note: why }); } catch {}
      st.stage = 'off'; st.why = why;
      if (detail.code) st.code = detail.code;
      this.note('chalice ride skipped — walking instead', { why, ...detail });
      this.chaliceEvent('ride_skipped', { why, ...detail, ...(trip.onDemand ? { on_demand: true } : {}) });
      return { skip: true, why, ...(detail.code ? { code: detail.code } : {}) };
    };
    const pending = (ms = 1500) => { trip.nextTryAt = now + ms; return { pending: true }; };

    switch (st.stage) {
      case 'off': case 'done': return { skip: true, why: 'already decided' };

      case 'decide': {
        // AN ON-DEMAND RIDE IS A DEPARTURE TOO: the wands go to the bank before the cup. (A town
        // trip has already done this in continueTownTrip, before it got here.)
        if (trip.onDemand && !trip.wandDropoffDone && this.wandDutyCfg) {
          const w = await this.wandDropoff(trip).catch(e => ({ skip: true, why: e.message }));
          if (w.pending) return { pending: true };
          trip.wandDropoffDone = true;
        }
        const stationHops = this.hereRoom() === cfg.station_room ? 0 : this.hopsTo(cfg.station_room);
        // A RIDE ASKED FOR ON DEMAND (m59-chalice-ride.mjs) has no town to compare the station
        // with, and carries its own detour limit; a town trip is decided exactly as before.
        const d = shouldRide({ cfg: trip.onDemand ? { ...cfg, max_detour_hops: trip.maxHops ?? cfg.max_detour_hops } : cfg,
          role: this.chaliceRole(), stationHops,
          targetHops: trip.onDemand ? null : this.hopsTo(trip.target.room), carrying: !!this.chaliceInPack(),
          lastPlayerAttackAt: this.lastPlayerSwingAt(),
          duty: store.duty(), humans: store.humans(), now, carriers: this.chaliceCarriers(now) });
        if (!d.ride) {
          // SAY SO. This used to be the one decision in the whole sequence that left no trace:
          // every later stage reports through `skip()`, but a decline HERE set the stage to
          // 'off' and returned in silence — so the ledger could not tell "checked the chalice
          // and correctly walked" from "never checked at all", and 105 chalice events in a day
          // contained not one ride decision. Which is the shape this game fails in anyway, and
          // not one a bot should add to.
          st.stage = 'off'; st.why = d.why; st.code = d.code ?? null;
          this.note('chalice ride declined — walking instead', { why: d.why, station_hops: stationHops });
          this.chaliceEvent('ride_declined', { why: d.why, station_hops: stationHops,
            target_room: trip.target?.room ?? null, ...(trip.onDemand ? { on_demand: true } : {}),
            ...(d.wait_ms ? { wait_ms: Math.round(d.wait_ms) } : {}) });
          return { skip: true, why: d.why, code: d.code ?? null };
        }
        if (d.returning) {
          st.returning = true;
          st.stage = 'to_station';
          this.note('taking the fleet\'s chalice back to the station', { why: d.why, station_hops: stationHops });
          this.chaliceEvent('returning', { why: d.why, station_hops: stationHops });
          return pending(0);
        }
        st.server = d.server;
        st.human = !!d.human;
        st.stage = 'to_station';
        this.note('riding the chalice home', { server: d.server, station: cfg.station_room, why: d.why,
          ...(d.human ? { human: true } : {}) });
        return pending(0);
      }

      case 'to_station': {
        const next = st.returning ? 'return' : 'room';
        if (this.hereRoom() === cfg.station_room) { st.stage = next; return pending(0); }
        // A RETURN IS NOT A DETOUR. The cup is the fleet's, so the walk back is not capped at the
        // ride's detour budget, and a failed walk is tried again rather than skipped — a skip
        // would walk the town trip with the cup still in the pack, which is the whole bug.
        const r = await this.travel(cfg.station_room,
          st.returning ? { origin: keeperOrigin('chalice_ride') } : { origin: keeperOrigin('chalice_ride'), maxHops: (trip.maxHops ?? cfg.max_detour_hops) + 2 })
          .catch(e => ({ arrived: false, reason: e.message }));
        if (r.arrived) { st.stage = next; return pending(0); }
        if (r.paused || r.cancelled || this.travelInterrupted()) return pending(5000);
        if (st.returning) return pending(30_000);
        return skip('could not reach the station', { reason: r.reason ?? r.why ?? null });
      }

      case 'return': {
        const cup = this.chaliceInPack();
        if (!cup) { st.stage = 'off'; return { skip: true, why: 'the chalice is no longer in the pack' }; }
        const desk = servingDesk(store.duty(), cfg, now, store.humans());
        const to = desk?.server ?? cfg.holder;
        const r = await this.chaliceGive(to, [cup.id], { stillHave: () => !!this.chaliceInPack() })
          .catch(e => ({ gave: false, why: e.message }));
        if (r.gave) {
          st.stage = 'off';
          this.note('handed the fleet\'s chalice back', { to });
          this.chaliceEvent('returned', { to });
          return { skip: true, why: `returned the chalice to ${to}; walking the trip` };
        }
        st.returnTries = (st.returnTries ?? 0) + 1;
        if (st.returnTries === 1 || st.returnTries % 10 === 0)
          this.chaliceEvent('return_waiting', { to, tries: st.returnTries, why: r.why ?? null });
        return pending(15_000);
      }

      case 'room': {
        // MAKE ROOM BEFORE ASKING. After an overfarm lap the pack is full by design, and an
        // enfeeble can shrink it further on the way here.
        const c = this.s.client;
        const cap = skills.carryCapacity(c);
        const worn = new Set((c.equipment?.()?.equipped ?? []).map(e => e.id));
        const pack = (c.inventory || []).map(o => ({ id: o.id, amount: o.amount,
          name: c.rsc.get(o.nameRsc) || '', equipped: worn.has(o.id) }));
        const plan = planRoom({ pack, roomFor: cap?.room_for ?? null, protect: this.protectedItemNames(),
          policy: this.policy.overfarm ?? undefined });
        if (plan.enough === false) return skip('no room for the chalice and nothing cheap enough to drop');
        if (plan.drops.length) {
          for (const d of plan.drops) {
            const o = (c.inventory || []).find(x => x.id === d.id);
            if (o) await this.s.pacer.submit('act', () => c.drop([dropSpecFor(o, d.partial ? d.amount : null)])).catch(() => {});
          }
          this.note('made room for the chalice', { dropped: plan.drops.map(d => `${d.name} x${d.amount}`),
            why: 'the cheapest loot by the overfarm ranking; the chalice is 20 weight and 20 bulk' });
          this.chaliceEvent('made_room', { dropped: plan.drops.map(d => ({ name: d.name, amount: d.amount })) });
        }
        // WHO IS SERVING IS ASKED AGAIN HERE, not carried from `decide`: the walk takes a
        // minute and a person can log in or out of the holder in that minute.
        const desk = servingDesk(store.duty(), cfg, now, store.humans());
        st.human = !!desk?.human;
        if (desk?.server) st.server = desk.server;
        const t = store.request(me, { room: cfg.station_room, ttlMs: cfg.ticket_ttl_ms,
                                      ...(st.human ? { server: st.server } : {}) });
        st.ticket = t.id;
        st.requestedAt = now;
        st.deadline = now + (st.human ? cfg.human_wait_ms : cfg.wait_ms);
        st.stage = 'wait';
        this.chaliceEvent('requested', { ticket: t.id, server: st.server, ...(st.human ? { human: true } : {}) });
        if (st.human) await this.chaliceTell(st.server, 'chalice', { service: 'ride', ticket: t.id, human: true });
        return pending(1000);
      }

      case 'wait': {
        if (this.chaliceInPack()) {
          st.gotAt = now;
          st.stage = 'services';
          this.chaliceEvent('received', { ticket: st.ticket, waited_ms: now - (st.requestedAt ?? now),
            ...(st.human ? { human: true, holds: store.ticket(st.ticket)?.holds ?? 0 } : {}) });
          return pending(0);
        }
        const t = store.ticket(st.ticket);
        if (!t || t.status === 'abandoned') {
          // A PERSON SAYING "NOT NOW" IS THE FAST PATH HOME, and is recorded as theirs.
          const declined = !!t?.closed_by;
          return skip(declined ? `${t.closed_by} said not now` : 'the ticket was dropped',
            { note: t?.note ?? null, ...(st.human ? { human: true, declined } : {}) });
        }
        if (st.human) {
          // "HOLD ON" MOVES THE DEADLINE, never past `human_max_wait_ms` from the request.
          const cap = (st.requestedAt ?? now) + cfg.human_max_wait_ms;
          const held = Math.min(Number(t.hold_until) || 0, cap);
          if (held > st.deadline) {
            st.deadline = held;
            this.chaliceEvent('desk_held', { ticket: st.ticket, server: st.server, holds: t.holds ?? 1,
              waited_ms: now - (st.requestedAt ?? now), until_ms: held - now });
          }
          // THE PERSON LOGGED OUT: the keeper takes the body back and claims the ticket like
          // any other, so this waits as for a keeper from here on.
          if (!this.chaliceHumanServer(store, st.server)) {
            st.human = false;
            st.deadline = Math.max(st.deadline, (st.requestedAt ?? now) + cfg.wait_ms);
            this.chaliceEvent('desk_human_left', { ticket: st.ticket, server: st.server });
          }
        }
        if (now > st.deadline) {
          const waited = Math.round((now - (st.requestedAt ?? now)) / 1000);
          return skip(st.human ? `${st.server} (played by a person) did not hand the chalice over in ${waited}s`
                               : `nobody brought the chalice in ${Math.round(cfg.wait_ms / 1000)}s`,
            st.human ? { human: true, waited_ms: now - (st.requestedAt ?? now), holds: t.holds ?? 0 } : {});
        }
        if (this.hereRoom() !== cfg.station_room) { st.stage = 'to_station'; return pending(0); }
        return pending(1500);
      }

      case 'services': {
        // WHILE THE HOLDER IS STANDING HERE ANYWAY: uncurse what we wear, reveal what we
        // cannot read. Asked once; waited for up to serve_ms; never a reason not to ride.
        const svc = (st.svc ??= this.chaliceAskServices(cfg, store, me, { server: st.server, human: st.human }));
        // A PERSON IS TOLD HOW LONG, AND HOW TO LET US GO SOONER. Only remove curse reaches
        // here for a person (see chaliceAskServices), and it is checked on our own body.
        const patience = st.human ? cfg.human_service_ms : cfg.serve_ms;
        if (st.human && svc.asked.length && !svc.told) {
          svc.told = true;
          const what = svc.asked.map(k => (k === 'uncurse' ? 'remove curse'
            : `reveal ${svc.dropped?.length ?? 0} item(s) at your feet`)).join(', ');
          await this.chaliceTell(st.server, `${what} — I drink in ${Math.round(patience / 1000)}s; ` +
            '"done" or "not now" to go sooner', { service: 'services', ticket: st.ticket, human: true });
        }
        // A PERSON NEVER CLOSES A TICKET BY CASTING, so the uncurse is checked on our own body:
        // nothing cursed worn is the service delivered, whoever delivered it.
        if (st.human && !this.chaliceCursedWorn().length)
          for (const t of store.openFrom(me, ['uncurse']))
            try { store.mark(t.id, 'done', { note: 'verified: nothing cursed is worn' }); } catch {}
        const open = store.openFrom(me, ['uncurse', 'reveal']);
        if (open.length && now - svc.at < patience) return pending(1500);
        if (svc.dropped?.length) {
          // PICK UP ONLY WHERE WE DROPPED. A keeper displaced mid-wait (the operator logging in
          // as the traveller to finish the ride) resumes this stage wherever it landed; looting
          // "those ids" from the guild hall floor finds nothing and reads as done.
          if (svc.droppedIn == null || this.hereRoom() === svc.droppedIn) {
            await this.s.lootFloor({ ids: svc.dropped, maxItems: svc.dropped.length, overfarm: null }).catch(() => {});
            await this.s.pacer.submit('read', () => this.s.client.requestInventory()).catch(() => {});
          } else {
            this.note('ITEMS LEFT ON THE STATION FLOOR', { room: svc.droppedIn, ids: svc.dropped, now_in: this.hereRoom() });
            this.chaliceEvent('services_items_left', { left_in: svc.droppedIn, ids: svc.dropped });
          }
        }
        for (const t of open) try { store.mark(t.id, 'abandoned', { note: 'the traveller moved on' }); } catch {}
        if (svc.asked.length || svc.skipped?.length)
          this.chaliceEvent('services', { asked: svc.asked, unserved: open.map(t => t.kind),
            ...(svc.skipped?.length ? { skipped: svc.skipped } : {}), ...(st.human ? { human: true } : {}),
            waited_ms: now - svc.at,
            still_cursed: this.chaliceCursedWorn().length, still_unrevealed: this.chaliceUnrevealed(99).length });
        st.stage = 'donate';
        return pending(0);
      }

      case 'donate': {
        st.stage = 'tip';
        // A PERSON SERVING IS NOT OFFERED ANYTHING BACK. The operator's sequence is "they offer
        // nothing back, I accept" — a tip or a donation is a second trade window for a person to
        // find and counter, and it would cost them more than it pays. Both wait for the keeper.
        if (st.human) {
          this.chaliceEvent('donated', { to: st.server, gave: {}, human: true,
            why: 'the server is played by a person — nothing offered back' });
          return pending(0);
        }
        const giver = store.ticket(st.ticket)?.by ?? st.server;
        const gift = this.chaliceDonation(store);
        if (!Object.keys(gift).length || !this.playerHere(giver)) return pending(0);
        const specs = this.chaliceSpecs(gift);
        const before = Object.fromEntries(Object.keys(gift).map(k => [k, this.reagentOnHand(k)]));
        const r = await this.chaliceGive(giver, specs,
          { stillHave: () => Object.keys(gift).every(k => this.reagentOnHand(k) >= before[k]) });
        this.chaliceEvent('donated', { to: giver, gave: r.gave ? gift : {}, why: r.why ?? null });
        return pending(0);
      }

      case 'tip': {
        st.stage = 'drink';
        if (st.human) {
          this.chaliceEvent('tip', { amount: 0, to: st.server, human: true,
            why: 'the server is played by a person — offer-nothing' });
          return pending(0);
        }
        const giver = store.ticket(st.ticket)?.by ?? st.server;
        const plan = tipPlan({ purse: this.purseNow(), cfg,
          keep: Math.max(this.walkingFloat(), this.shoppingPlan().required_purse ?? 0) });
        if (!plan.amount || !this.playerHere(giver)) {
          this.chaliceEvent('tip', { amount: 0, to: giver, why: plan.why });
          return pending(0);
        }
        const c = this.s.client;
        const coins = (c.inventory || []).find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
        if (!coins) return pending(0);
        const before = this.purseNow();
        const r = await this.chaliceGive(giver, [{ id: coins.id, amount: plan.amount }],
          { stillHave: () => this.purseNow() >= before });
        this.chaliceEvent('tip', { amount: r.gave ? plan.amount : 0, to: giver, why: r.gave ? plan.why : r.why });
        return pending(0);
      }

      case 'drink': {
        const c = this.s.client;
        // DROP IT WHETHER OR NOT THE SIP TOOK. The cup is the fleet's, not this trip's: on
        // the floor the holder picks it up (and the pick-up refills it); in this pack it
        // would ride home with a farmer and the station would have nothing to hand out.
        const putDown = async () => {
          const still = this.chaliceInPack();
          // REGISTERED FIRST, so every keeper that sees it lying there leaves it for our server.
          if (still) {
            let server = null;
            try { server = store.ticket(st.ticket)?.by ?? null; } catch {}
            try { store.setHandoff({ rider: server ?? cfg.holder, by: me, why: 'drunk' }); } catch {}
            await this.s.pacer.submit('act', () => c.drop([still.id])).catch(() => {});
          }
          return still;
        };
        // NEVER A SECOND SIP INSIDE THE LANDING WINDOW. A Rescue is pending 15-25s after a sip that
        // took, and another sip then spends a charge for nothing (StartRescueTimer refuses a second
        // timer). A pass that threw after the apply re-enters this stage: it puts the cup down if it
        // is still in hand, and goes on to wait.
        if (st.sippedAt && Date.now() - st.sippedAt < cfg.landing_ms) {
          await putDown();
          try { store.mark(st.ticket, st.human ? 'done' : 'dropped'); } catch {}
          st.drankAt ??= st.sippedAt; st.stage = 'landing';
          this.chaliceEvent('drank', { ticket: st.ticket, resumed: true, why: 'the sip was already sent; not sipping twice' });
          return pending(1000);
        }
        const cup = this.chaliceInPack();
        if (!cup) return skip('the chalice left the pack before it was drunk');
        // RESTING SETS PFLAG_NO_FIGHT, AND THE CHALICE REFUSES A CHARACTER WITH IT SET
        // (chalice.kod:166), silently. Stand first.
        try { c.stand(); } catch {}
        await new Promise(r => setTimeout(r, 400));
        const heardFrom = c.evSeq;
        st.sippedAt = Date.now();
        await this.s.pacer.submit('act', () => c.apply(cup.id, c.selfId));
        // WHAT THE CUP SAID (sipVerdict): the sip, or the PvP lockout's refusal. Waited for up to
        // 2.5s rather than slept a flat 1.2s, so a refusal is known HERE and not 45s from now.
        const heard = await c.waitFor?.({ since: heardFrom, kinds: ['message'], timeoutMs: 2500,
          match: e => SIP_TOOK.test(String(e?.text ?? '')) || SIP_REFUSED_PVP.test(String(e?.text ?? '')) })
          ?.catch?.(() => null);
        const sip = sipVerdict(heard?.events ?? []);
        if (sip === 'unknown') await new Promise(r => setTimeout(r, 400));
        const still = await putDown();
        // A KEEPER CLOSES ITS TICKET WHEN IT PICKS THE CUP UP. A person does not close anything,
        // so a person's ticket is closed here, or it would expire and read as a failure.
        try { store.mark(st.ticket, st.human ? 'done' : 'dropped',
                         st.human ? { note: 'drunk and dropped for the person to pick up' } : {}); } catch {}
        if (sip === 'refused_pvp') {
          // THE SERVER SAID NO, so this is a refusal now — not a landing that never comes.
          this._lastPlayerAttackAt = Math.max(Number(this._lastPlayerAttackAt) || 0, Date.now() - 60_000);
          return skip('the chalice refused the sip: "Only those who have walked the path of peace ' +
                      'may partake" — attacked a player inside the PvP lockout (chalice.kod:175)',
                      { code: 'pvp', sip });
        }
        st.drankAt = Date.now();
        st.stage = 'landing';
        this.chaliceEvent('drank', { ticket: st.ticket, cup_left_pack: !still || !this.chaliceInPack(), sip,
          ...(st.human ? { human: true } : {}) });
        return pending(1000);
      }

      case 'landing': {
        const here = this.hereRoom();
        if (Number.isFinite(here) && here !== cfg.station_room) {
          st.stage = 'done';
          const ms = Date.now() - st.drankAt;
          // THE TOWN WAS RANKED FROM THE FARM. Re-rank the leg from where we stand now.
          const hops = this.hopsTo(trip.target.room);
          if (Number.isFinite(hops)) trip.target = { ...trip.target, hops };
          this.tally.chalice_rides = (this.tally.chalice_rides || 0) + 1;
          this.note('landed by chalice', { landed_in: here, ms, onward_hops: hops ?? null,
            to: trip.target.room });
          this.chaliceEvent('landed', { ticket: st.ticket, landed_in: here, ms, guild_hall: here === GUILD_HALL_ROOM,
            ...(st.human ? { human: true } : {}) });
          // STANDING BESIDE THE GUILD'S CHESTS: take on part of what the holder is short of.
          // NOT FOR A RIDE ON DEMAND: there is no trip home to carry the cargo to the holder, and
          // no town stop whose standing order needs funding.
          if (here === GUILD_HALL_ROOM && !trip.onDemand) await this.chaliceTakeCargo(cfg, store).catch(e =>
            this.note('could not draw the holder\'s restock', { why: e.message }));
          // AND A STANDING ORDER'S MONEY, WHILE THE CHESTS ARE A FEW STEPS AWAY. The town trip
          // funds it again later, but by then the character is in Barloque and the chests are
          // a walk back across the city: Rowlf's order of 2026-09-25 landed here and was left
          // unfunded there. The later call draws only if still short, so this cannot double.
          if (here === GUILD_HALL_ROOM && !trip.onDemand) await this.fundStandingOrder().catch(e =>
            this.note('could not fund the standing order at the hall', { why: e.message }));
          if (here === GUILD_HALL_ROOM) await this.chaliceDepositMoney(cfg).catch(e =>
            this.note('could not deposit money at the hall', { why: e.message }));
          return { done: true, landed: here };
        }
        if (Date.now() - st.drankAt > cfg.landing_ms)
          return skip(`no landing ${Math.round(cfg.landing_ms / 1000)}s after the sip — refused ` +
                      '(recent PvP, or resting) or cancelled by an attack');
        return pending(1000);
      }
    }
    return { skip: true, why: `unknown stage ${st.stage}` };
  }

  // ------------------------------------------------------------------ the holder and alternate

  /**
   * THE SERVING SIDE. Called at the top of `passErrand` and of the room-caster post. Returns
   * true when it did something this pass (the caller then treats the pass as handled).
   */
  async chaliceDuty() {
    const cfg = this.chaliceCfg;
    const role = this.chaliceRole();
    if (!cfg || (role !== 'holder' && role !== 'alternate')) return false;
    if (this.townTrip || this.travelInterrupted() || this.suspendedJourney) return false;
    const store = this.chaliceStore();
    // SOMEBODY ELSE OWNS THE BODY — an operation IN FLIGHT, not merely a bot that owns the
    // character: finish a step already started, never start a new one, and say so on the duty
    // record so travellers walk at once instead of waiting out `wait_ms` for a server who is
    // not coming.
    //
    // THIS USED TO READ `facultyHeld('work') || facultyHeld('movement')`, AND THAT DISABLED THE
    // ALTERNATE COMPLETELY. m59-commitment.mjs states the distinction it got wrong, in its own
    // header: "OWNING A CHARACTER AND BEING BUSY WITH IT ARE DIFFERENT FACTS, AND CONFLATING
    // THEM DEADLOCKS THE BOT THAT ASKED FOR THIS. A directional bot claims `work` and
    // `movement` on every character it manages and holds them for its whole run."
    //
    // Which is exactly what this fleet's own DUM does: `work: bot, movement: bot` on all
    // twenty-one farmers, heartbeated for the life of the process. So `taken` was permanently
    // true for the ALTERNATE, `chaliceNextJob` never ran for it, and it could not claim a
    // relief ticket — ever. Measured on prod 2026-09-24: the holder raised one relief ticket at
    // 17:23:20Z, nothing ever claimed it, it timed out at `await`, and nine minutes later the
    // holder's own supply trip left the castle CARRYING THE FLEET'S ONLY CHALICE — the one
    // thing `handover_below_casts` exists to prevent. The alternate's whole keeper state did
    // not contain the word "chalice" once.
    //
    // A raid that posts the holder elsewhere is still caught, because a raid is a fleetscript
    // and a fleetscript declares `busy` before its first step; so is the holder's own supply
    // trip, for the same reason. What is no longer caught is mere OWNERSHIP — which is what the
    // board calls `takeable`, and what this harness has always said may be taken.
    //
    // AND IT IS BUILT FROM THE PRIMITIVES RATHER THAN FROM `commitment()`, WHICH SELF-DEADLOCKS.
    // `commitment()` folds `chaliceBusy()` in as an errand called "chalice hand-off" — so
    // asking it whether somebody else owns the body answers YES while WE are the ones using
    // it, and the alternate on duty stands itself down every pass. Six flow tests caught it.
    // "Somebody ELSE" is the whole predicate, so the chalice's own state may not be in it.
    //
    // `townTrip`, `travelInterrupted` and `suspendedJourney` are already refused above.
    const taken = !!(
      this.busyStatus?.()                        // an outside operation declared itself
      || this.errand                             // a keeper errand of our own: loot run, signet
      || this.parking                            // getting behind a wall for a fleet update
      || (this.inert && !this.inert.travelling)  // something else has the controls
    );
    // THE PAUSE FLAG LIVES IN A SHARED FILE AND THE "ALREADY SAID IT" FLAG LIVED IN THIS
    // PROCESS. A keeper that restarted between the two therefore left `paused: true` on disk
    // with nothing left in memory to clear it, and `servingCharacter` reads that as nobody on
    // duty — for ever. Both directions now compare against the RECORD, which is the thing that
    // outlives the keeper.
    const paused = store.duty()?.paused === true;
    if (!this._chaliceServe && taken) {
      if (!paused) { try { store.setDuty({ paused: true }); } catch {} }
      return false;
    }
    if (paused) { try { store.setDuty({ paused: false }); } catch {} }
    const me = this.who();
    const now = Date.now();
    const cup = this.chaliceInPack();

    // WHO HAS IT, kept current by whoever carries it — the travellers read this to decide
    // whether anybody is serving at all.
    if (cup && (!this._chaliceDutySaidAt || now - this._chaliceDutySaidAt > 60_000)) {
      this._chaliceDutySaidAt = now;
      // `room`: where the desk actually is, so a ride on demand can refuse a desk that is away.
      try { store.setDuty({ with: me, lost: false, holder_away: role === 'alternate', room: this.hereRoom(), room_by: me }); } catch {}
    }
    if (role === 'holder' && Object.keys(cfg.holder_supply ?? {}).length
        && (!this._chaliceSupplySaidAt || now - this._chaliceSupplySaidAt > 60_000)) {
      this._chaliceSupplySaidAt = now;
      const have = Object.fromEntries(Object.keys(cfg.holder_supply).map(k => [k, this.reagentOnHand(k)]));
      try { store.setSupply({ have, target: cfg.holder_supply }); } catch {}
    }
    if (role === 'holder' || cup) this.chalicePublishDesk(cfg, store, me, cup, now);

    let st = this._chaliceServe;
    if (st && now > st.expires) {
      this.note('chalice duty step timed out', { kind: st.kind, stage: st.stage });
      if (st.ticket) try { store.mark(st.ticket, 'abandoned', { note: `timed out at ${st.stage}` }); } catch {}
      st = this._chaliceServe = null;
      this._chaliceCooldownUntil = now + 30_000;
    }
    if (!st) {
      if (now < (this._chaliceCooldownUntil ?? 0)) return this.chaliceParked(cfg, role, cup);
      if (await this.chaliceTopUp(cfg, role, cup, store, now)) return true;
      if (await this.chaliceRefillTrip(cfg, role, cup, store, now)) return true;
      st = this.chaliceNextJob(cfg, role, cup, store, me, now);
      if (!st) return this.chaliceParked(cfg, role, cup);
      this._chaliceServe = st;
    }
    return this.chaliceStep(cfg, st, store, me);
  }

  chaliceNextJob(cfg, role, cup, store, me, now) {
    const ttl = { ttlMs: cfg.ticket_ttl_ms };
    // A PERSON'S TICKET GETS A PERSON'S PATIENCE: they were told where to come, and walking
    // there takes them longer than it takes a keeper already standing at the station.
    const job = (kind, stage, ticket = null, extra = {}) =>
      ({ kind, stage, ticket: ticket?.id ?? null, traveller: ticket?.traveller ?? null,
         room: ticket?.room ?? null, back: this.hereRoom(),
         ...(ticket?.human ? { human: true } : {}),
         expires: now + (ticket?.human ? cfg.human_max_wait_ms + cfg.serve_ms : cfg.serve_ms * 2), ...extra });
    if (cup) {
      // THE HOLDER IS ABOUT TO LEAVE: hand the cup over first, at the holder's own post.
      // With no alternate configured the holder DRAFTS one from the duty pool (under
      // duty_max_health), preferring one standing here; nobody in the pool, it keeps the cup.
      // A HOLDER THAT CANNOT LEAVE DOES NOT HAND OVER (operator, 2026-10-06). The low-supply test is a
      // proxy for "about to leave on a supply run", and a holder confined to its post or with
      // policy.townTrips false is not going anywhere: Loial, confined to room 2 with no elderberries,
      // drafted an alternate and filed a relief ticket on every job pick for a departure that could
      // never happen. It keeps the cup and says once that it is short.
      // UNLESS A BOT HOLDS ITS MOVEMENT OR ECONOMY: the holder's supply run starts with a Rescue that
      // DUM casts (caster-rescue-to-shop), which no confinement stops, and then the cup must not leave.
      const botMayMove = this.facultyHeld?.('movement') || this.facultyHeld?.('economy');
      const stays = !botMayMove && (this.policy.townTrips === false
        || (Array.isArray(this.policy.confineRooms) && this.policy.confineRooms.length > 0));
      if (role === 'holder' && this.chaliceCastsLeft() <= cfg.handover_below_casts && stays) {
        if (!this._chaliceShortNoted) {
          this._chaliceShortNoted = true;
          this.chaliceEvent('short_staying', { casts_left: this.chaliceCastsLeft(),
            why: 'low on forces of light reagents, but confined to the post or no town trips: keeping the cup' });
        }
      } else this._chaliceShortNoted = false;
      if (role === 'holder' && this.chaliceCastsLeft() <= cfg.handover_below_casts && !stays) {
        let pool = [], humans = null;
        try { pool = store.pool(now); } catch {}
        try { humans = store.humans(); } catch {}
        const c = this.s?.client;
        const fleetHere = [...(c?.room?.objects?.values?.() ?? [])]
          .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER)).map(o => c.rsc?.get(o.nameRsc) || '');
        const alt = draftAlternate({ cfg, pool, fleetHere, humans, now, carriers: this.chaliceCarriers(now) });
        if (alt) {
          if (!cfg.alternate) {
            try { store.setDuty({ drafted: alt, drafted_at: now }); } catch {}
            this.chaliceEvent('drafted', { alternate: alt, casts_left: this.chaliceCastsLeft() });
          }
          const t = store.request(me, { room: this.hereRoom(), kind: 'relief', ...ttl });
          return job('relief', 'await', t, { alt });
        }
      }
      // THE HOLDER IS BACK: the alternate returns the cup to it.
      if (role === 'alternate') {
        const back = store.claimNext(me, { kind: 'return', ...ttl });
        if (back) return job('return', 'go', back);
      }
      // A FOLLOWING DESK RATIONS THE CUP: outside a Shal'ille room every ride costs a sip and the last one deletes it.
      // A ride it cannot afford is left waiting on the board (another server, or this one after a refill), never served.
      const budget = cfg.follows_holder ? rideBudget({ room: this.hereRoom(), sips: store.cup?.()?.sips, reserve: cfg.cup_reserve }) : { ok: true };
      if (!budget.ok && this._chaliceBudgetSaid !== budget.why) {
        this._chaliceBudgetSaid = budget.why;
        this.chaliceEvent('rides_paused', { room: this.hereRoom(), why: budget.why });
      } else if (budget.ok) this._chaliceBudgetSaid = null;
      const t = budget.ok ? this.chaliceFleetOnly(store.claimNext(me, { kind: 'ride', ...ttl }), store) : null;
      if (t) return job('ride', 'go', t);
    }
    // FORCES OF LIGHT, AFTER ANY RIDE: a traveller at the station is waiting on us now; an
    // unlit room is costing the fleet accuracy, which is real but not a person standing there.
    if (role === 'holder' && folRoomsOf(cfg).length && this.chaliceFit()) {
      const t = store.claimNext(me, { kind: 'fol', ...ttl });
      if (t) return job('fol', 'go', t, { attempts: 0 });
    }
    // A PERSON ASKED FOR A CAST BY TELL (the broker filed it). A keeper's own uncurse and
    // reveal are served inside its ride; these have no ride, so they are jobs of their own.
    if (role === 'holder') {
      for (const kind of ['uncurse', 'reveal']) {
        const t = this.chaliceFleetOnly(store.claimNext(me, { kind, humanOnly: true, ...ttl }), store);
        if (t) return job('desk', 'go', t, { service: kind });
      }
      // MEND HAS NO RIDE TO RIDE INSIDE: an archer walks here with a worn bow, drops it and files
      // the ticket (tools/fleetscripts/practice-bow.mjs), so a KEEPER-filed mend is a job too.
      if (cfg.mend !== false) {
        const t = this.chaliceFleetOnly(store.claimNext(me, { kind: 'mend', ...ttl }), store);
        if (t) return job('desk', 'go', t, { service: 'mend' });
      }
    }
    // PRACTICE IN ANOTHER ROOM, LAST OF ALL. Only when no ride, no forces of light and no desk
    // ticket is waiting, the body is fit, and one cast is affordable above the desk's reserve.
    // Operator, 2026-09-25: Loial keeps the chalice at 2 and practises dazzle on 38's skeletons
    // in between. The session is short and bounded, and the cast stage abandons it the moment
    // anybody asks for the desk, so a rider waits at most one step through the door.
    if (role === 'holder' && this.chaliceFit()) {
      const entry = this.practiceSessionDue(now);
      if (entry) {
        this._practiceSessionAt = now;
        return job('practice', 'go', null, { room: entry.room, spell: entry.name,
          until: now + entry.session_ms, expires: now + entry.session_ms + 120_000 });
      }
    }
    if (cup) return null;
    if (role === 'alternate') {
      const relief = store.claimNext(me, { kind: 'relief', ...ttl });
      if (relief) return job('take', 'go', relief);
      return null;
    }
    // A HOLDER WITHOUT THE CUP, BACK AND STOCKED, ASKS FOR IT. Once per minute at most.
    const duty = store.duty();
    if (role === 'holder' && ((cfg.alternate && sameName(duty.with, cfg.alternate)) || actingDesk(duty)
        || (duty.drafted && sameName(duty.with, duty.drafted)))
        && this.chaliceCastsLeft() > cfg.handover_below_casts
        && (cfg.post_room == null || this.hereRoom() === cfg.post_room)
        && (!this._chaliceAskedAt || now - this._chaliceAskedAt > 60_000)) {
      this._chaliceAskedAt = now;
      const t = store.request(me, { room: this.hereRoom(), kind: 'return', ...ttl });
      return job('reclaim', 'await', t);
    }
    return null;
  }

  // THE ALTERNATE ON DUTY DOES NOT FARM AND DOES NOT GO TO TOWN. It waits somewhere safe
  // near the station until the holder is back — the operator's order, 2026-09-23: two
  // characters away from the castle at once is a fleet with no chalice.
  async chaliceParked(cfg, role, cup) {
    if (role !== 'alternate' || !cup) return false;
    const park = cfg.post_room ?? cfg.station_room;
    if (this.hereRoom() !== park) {
      await this.travel(park, { origin: keeperOrigin('chalice_park'), maxHops: 6, chalice: true }).catch(() => {});
      return true;
    }
    if (!this.hold) await this.takeRecoverySpot('on chalice duty while the holder is away').catch(() => {});
    return true;
  }

  async chaliceStep(cfg, st, store, me) {
    const now = Date.now();
    const done = (status = 'done', extra = {}) => {
      if (st.ticket) try { store.mark(st.ticket, status, extra); } catch {}
      this._chaliceServe = null;
      return true;
    };
    const goto = async (room, next) => {
      if (this.hereRoom() === Number(room)) { st.stage = next; st.since = now; return true; }
      const r = await this.travel(Number(room), { origin: keeperOrigin('chalice'), maxHops: 8, chalice: true, chaliceRoom: Number(room) })
        .catch(e => ({ arrived: false, reason: e.message }));
      if (r.arrived) { st.stage = next; st.since = Date.now(); }
      else if (!(r.paused || r.cancelled)) {
        this.note('chalice duty could not walk', { to: room, why: r.reason ?? r.why ?? null });
        return done('abandoned', { note: `could not reach ${room}` });
      }
      return true;
    };

    switch (`${st.kind}:${st.stage}`) {
      // ---- forces of light: in the door, cast until it pays, straight back out
      case 'fol:go':
        if (!this.chaliceFit()) { st.stage = 'back'; return true; }
        // THE ROOM THE TICKET NAMES, when it is one this holder lights; otherwise fol_room. A
        // person's "fol in 39" must not walk a 20-health caster somewhere nobody configured.
        st.folRoom = folRoomsOf(cfg).includes(Number(st.room)) ? Number(st.room) : cfg.fol_room;
        // NOR A ROOM HIS OWN ORDERS FORBID. The walk is the risk and the cast would be refused
        // on arrival, so the visit is never started (roomEnchantAllows).
        if (!this.roomEnchantAllows(st.folRoom)) {
          this.chaliceEvent('fol_refused', { room: st.folRoom, why: 'not in room_enchant.rooms' });
          return done('abandoned', { note: `room ${st.folRoom} is not in this caster's room_enchant.rooms` });
        }
        return goto(st.folRoom, 'cast');
      case 'fol:cast': {
        // HURT IS OUT. The post is the refuge; a second cast is never worth a death.
        if (!this.chaliceFit()) { st.stage = 'back'; return true; }
        const r = await this.roomEnchant({ remote: true }).catch(e => ({ cast: false, why: e.message }));
        if (r?.cast) {
          try { store.litFol({ room: st.folRoom ?? cfg.fol_room, until: Date.now() + r.holdMs, by: me }); } catch {}
          this.chaliceEvent('fol_lit', { holds_ms: r.holdMs, casts_left: r.casts_left, attempts: st.attempts + 1 });
          st.ticket = null; st.stage = 'back';
          return true;
        }
        // NOTHING PAID. Declined before casting (mana, reagents: `r` is empty) or refused by
        // the server — and the commonest refusal is "already infused", which means lit. After
        // four tries, say lit-for-a-while on the shared clock so the occupants stop calling a
        // 20-health character into the room every few seconds, and go back out.
        if (++st.attempts >= 4) {
          try { store.litFol({ room: st.folRoom ?? cfg.fol_room, until: Date.now() + 60_000, by: me }); } catch {}
          this.chaliceEvent('fol_unpaid', { why: r?.why ?? 'declined before casting', attempts: st.attempts });
          st.ticket = null; st.stage = 'back';
        }
        return true;
      }
      case 'fol:back': case 'fol:home': {
        const home = cfg.post_room ?? st.back;
        if (this.hereRoom() === Number(home)) return done();
        return goto(home, 'home');
      }
      // ---- a practice session: through the door, onto a wall, cast, straight back
      case 'practice:go':
        if (!this.chaliceFit()) { st.stage = 'back'; return true; }
        return goto(st.room, 'wall');
      case 'practice:wall': {
        if (!this.chaliceFit() || now > st.until) { st.stage = 'back'; return true; }
        if (!(this.hold && this.holdWorks())) {
          await this.takeRecoverySpot(`practising ${st.spell} in ${st.room}`).catch(() => null);
          if (!(this.hold && this.holdWorks())) {
            // No proven wall to be had: a creature-target cast is never made in the open.
            if (Date.now() - (st.since ?? now) > 20_000) {
              this.chaliceEvent('practice_no_wall', { room: st.room, spell: st.spell });
              st.stage = 'back';
            }
            return true;
          }
        }
        st.stage = 'cast'; st.since = Date.now();
        return true;
      }
      case 'practice:cast': {
        // THE DESK COMES FIRST. Anybody waiting — a ride, forces of light, a desk service, a
        // relief — ends the session on the spot; so does a hurt body, a lost wall or the clock.
        const waiting = ['ride', 'fol', 'uncurse', 'reveal', 'mend', 'relief', 'return']
          .reduce((n, k) => n + (store.openCount?.(k) ?? 0), 0);
        if (!this.chaliceFit() || now > st.until || waiting > 0 || !(this.hold && this.holdWorks())) {
          st.stage = 'back';
          return true;
        }
        await this.practiceAtDesk({ session: st }).catch(() => false);
        // Out of castable mana or reagents: home to refill, where the desk can be found.
        if (st.done) {
          this.chaliceEvent('practice_session_done', { room: st.room, spell: st.spell, why: st.done });
          st.stage = 'back';
        }
        return true;
      }
      case 'practice:back': case 'practice:home': {
        const home = cfg.post_room ?? st.back;
        if (this.hereRoom() === Number(home)) return done();
        return goto(home, 'home');
      }
      // ---- a traveller wants a ride
      case 'ride:go': return goto(cfg.station_room, 'offer');
      case 'ride:offer': {
        const patience = st.human ? cfg.human_max_wait_ms : cfg.serve_ms;
        if (!this.playerHere(st.traveller)) {
          if (now - (st.since ?? now) > patience) {
            st.stage = 'back';
            if (st.ticket) try { store.mark(st.ticket, 'abandoned', { note: 'traveller never arrived' }); } catch {}
            this.chaliceEvent('desk_unserved', { ticket: st.ticket, for: st.traveller, service: 'ride',
              why: 'never arrived at the station', ...(st.human ? { human: true } : {}) });
            st.ticket = null;
          }
          return true;
        }
        const cup = this.chaliceInPack();
        if (!cup) { st.stage = 'back'; return true; }
        // A PERSON IS TOLD WHAT TO DO WITH THE WINDOW THAT IS ABOUT TO OPEN, once.
        if (st.human && !st.toldOffer) {
          st.toldOffer = true;
          await this.chaliceTell(st.traveller, 'offering you the chalice — counter with nothing; ' +
            'then use it and drop it here', { service: 'ride', ticket: st.ticket, human: true }, { reply: true });
        }
        // THE SERVER'S OWN EXCESS RIDES WITH THE CUP to be deposited at the hall (operator, 2026-09-28).
        // Never to a person: their pack is not ours to bank from.
        const give = [cup.id];
        let passOn = 0;
        if (cfg.money_flow && !st.human) {
          passOn = moneyExcess({ purse: this.purseNow(), keep: this.walkingFloat() + cfg.money_float, min: cfg.money_min });
          const coins = passOn ? (this.s.client.inventory || []).find(o => /shilling/i.test(this.s.client.rsc.get(o.nameRsc) || '')) : null;
          if (coins) give.push({ id: coins.id, amount: passOn }); else passOn = 0;
        }
        const purseBefore = this.purseNow();
        const r = await this.chaliceGive(st.traveller, give, { stillHave: () => !!this.chaliceInPack(),
          counterMs: st.human ? cfg.human_offer_ms : 8000 });
        if (r.gave && passOn) this.chaliceEvent('money_handed_on', { to: st.traveller, amount: purseBefore - this.purseNow(),
          purse_before: purseBefore, purse_after: this.purseNow(), ticket: st.ticket });
        if (!r.gave) { this.note('chalice hand-off did not complete', { to: st.traveller, why: r.why }); return true; }
        try { store.mark(st.ticket, 'handed'); } catch {}
        this.chaliceEvent('handed', { ticket: st.ticket, to: st.traveller, ...(st.human ? { human: true } : {}) });
        st.stage = 'pickup'; st.since = Date.now();
        return true;
      }

      // ---- a person asked for remove curse or reveal: wait at the station for them, cast
      // A MEND TICKET NAMES THE ROOM ITS FILER IS STANDING IN: the desk's published room, which
      // is the post room when one is set and not necessarily the chalice station.
      case 'desk:go': return goto(st.service === 'mend' && Number.isFinite(Number(st.room)) && Number(st.room) > 0
        ? Number(st.room) : cfg.station_room, 'serve');
      case 'desk:serve': {
        if (!this.playerHere(st.traveller)) {
          if (now - (st.since ?? now) > cfg.human_max_wait_ms) {
            if (st.ticket) try { store.mark(st.ticket, 'abandoned', { note: 'requester never arrived' }); } catch {}
            this.chaliceEvent('desk_unserved', { ticket: st.ticket, for: st.traveller, service: st.service,
              why: 'never arrived at the station', ...(st.human ? { human: true } : {}) });
            st.ticket = null; st.stage = 'back';
          }
          return true;
        }
        const t = store.ticket(st.ticket);
        if (!t || ['done', 'abandoned'].includes(t.status)) { st.ticket = null; st.stage = 'back'; return true; }
        await this.chaliceServeTicket(t, store);
        this.chaliceEvent('desk_served', { ticket: st.ticket, for: st.traveller, service: st.service,
          waited_ms: Date.now() - (t.at ?? Date.now()), ...(t.human ? { human: true } : {}) });
        st.ticket = null; st.stage = 'back';
        return true;
      }
      case 'desk:back': case 'desk:home': {
        const home = cfg.post_room ?? st.back;
        if (!Number.isFinite(Number(home)) || this.hereRoom() === Number(home)) return done();
        return goto(home, 'home').then(() => (st.stage === 'home' ? done() : true));
      }
      case 'ride:pickup': {
        // THE TRAVELLER'S SERVICES FIRST: it is holding the cup and will not drink until
        // these are answered or it gives up waiting. Each one restarts the pickup clock.
        if (await this.chaliceServeServices(st.traveller, store)) { st.since = Date.now(); return true; }
        // ALREADY HOLDING A CUP (a second one came our way while the rider drank): the dropped one is
        // left for an empty-handed fleetmate's sweep, never lifted into ours to be poured away.
        if (this.chaliceInPack()) {
          this.chaliceEvent('second_cup_left', { ticket: st.ticket, for: st.traveller });
          if (st.ticket) try { store.mark(st.ticket, 'done', { note: 'server already holds a cup; the dropped one is left for a sweep' }); } catch {}
          st.ticket = null; st.stage = 'back';
          return true;
        }
        const floor = this.chaliceOnFloor();
        if (floor) {
          await this.chaliceMakeRoom();
          await this.s.lootFloor({ ids: [floor.id], maxItems: 1, overfarm: null }).catch(() => {});
          await this.s.pacer.submit('read', () => this.s.client.requestInventory()).catch(() => {});
          await new Promise(r => setTimeout(r, 800));
          if (this.chaliceInPack()) {
            try { store.setDuty({ with: me, lost: false }); } catch {}
            this.tally.chalice_served = (this.tally.chalice_served || 0) + 1;
            this.chaliceEvent('picked_up', { ticket: st.ticket, for: st.traveller, refilled: REFILL_ROOMS.has(this.hereRoom()) });
            // THE CUP'S SIPS: refilled by the drop in a Shal'ille room, one fewer anywhere else (rideBudget).
            try { store.setCup(sipsAfterRide(store.cup()?.sips, this.hereRoom()), `ride for ${st.traveller}`); } catch {}
            if (st.ticket) try { store.mark(st.ticket, 'done'); } catch {}
            st.ticket = null;
            st.stage = 'back';
          }
          return true;
        }
        if (now - (st.since ?? now) > (st.human ? cfg.human_max_wait_ms : cfg.serve_ms)) {
          // THE CUP DID NOT COME BACK. Said loudly: the fleet has one, and a traveller that
          // walked off with it — or a stranger who picked it up — is the whole service gone.
          try { store.setDuty({ with: st.traveller, lost: !this.playerHere(st.traveller) }); } catch {}
          this.note('THE CHALICE DID NOT COME BACK', { from: st.traveller, ticket: st.ticket,
            why: 'handed over and never dropped where this character could see it' });
          this.chaliceEvent('lost', { ticket: st.ticket, traveller: st.traveller });
          if (st.ticket) try { store.mark(st.ticket, 'abandoned', { note: 'cup never came back' }); } catch {}
          st.ticket = null;
          st.stage = 'back';
        }
        return true;
      }
      case 'ride:back': {
        const home = cfg.post_room ?? st.back;
        if (!Number.isFinite(Number(home)) || this.hereRoom() === Number(home)) return done();
        return goto(home, 'home').then(() => (st.stage === 'home' ? done() : true));
      }

      // ---- the holder is leaving: give the cup to the alternate, here
      case 'relief:await': {
        const t = store.ticket(st.ticket);
        if (!t || t.status === 'abandoned') return done('abandoned');
        const alt = st.alt ?? cfg.alternate;
        if (!this.playerHere(alt)) return true;
        const cup = this.chaliceInPack();
        if (!cup) return done();
        const r = await this.chaliceGive(alt, [cup.id], { stillHave: () => !!this.chaliceInPack() });
        if (!r.gave) return true;
        try { store.setDuty({ with: alt, holder_away: true }); } catch {}
        this.chaliceEvent('relieved', { to: alt, casts_left: this.chaliceCastsLeft() });
        this.note('handed the chalice to the alternate before the supply trip', { to: alt });
        return done();
      }
      // ---- the alternate goes to the holder to take the cup
      case 'take:go': return goto(st.room, 'await');
      case 'take:await':
        if (this.chaliceInPack()) {
          try { store.setDuty({ with: me, holder_away: true }); } catch {}
          this.chaliceEvent('on_duty', { from: st.traveller });
          return done();
        }
        return true;
      // ---- the alternate returns the cup to the holder
      case 'return:go': return goto(st.room, 'offer');
      case 'return:offer': {
        if (!this.playerHere(cfg.holder)) return true;
        const cup = this.chaliceInPack();
        if (!cup) return done();
        const r = await this.chaliceGive(cfg.holder, [cup.id], { stillHave: () => !!this.chaliceInPack() });
        if (!r.gave) return true;
        try { store.setDuty({ with: cfg.holder, holder_away: false, acting: null, drafted: null }); } catch {}
        this._chaliceActing = null;
        this.chaliceEvent('returned', { to: cfg.holder });
        return done();
      }
      // ---- the holder waits for its cup
      case 'reclaim:await':
        if (this.chaliceInPack()) {
          try { store.setDuty({ with: me, holder_away: false, drafted: null, acting: null }); } catch {}
          this.chaliceEvent('reclaimed', {});
          return done();
        }
        // Nothing to do but wait; the post keeps casting meanwhile.
        return false;
    }
    this._chaliceServe = null;
    return false;
  }
  // @end 1

  // @part 2

  async chaliceMakeRoom() {
    if (this.chaliceRole() !== 'alternate') return;
    const c = this.s.client;
    const cap = skills.carryCapacity(c);
    const worn = new Set((c.equipment?.()?.equipped ?? []).map(e => e.id));
    const pack = (c.inventory || []).map(o => ({ id: o.id, amount: o.amount, name: c.rsc.get(o.nameRsc) || '',
      equipped: worn.has(o.id) }));
    const plan = planRoom({ pack, roomFor: cap?.room_for ?? null, protect: this.protectedItemNames(),
      policy: this.policy.overfarm ?? undefined });
    for (const d of plan.drops) {
      const o = (c.inventory || []).find(x => x.id === d.id);
      if (o) await this.s.pacer.submit('act', () => c.drop([dropSpecFor(o, d.partial ? d.amount : null)])).catch(() => {});
    }
  }
  // @end 2
}
