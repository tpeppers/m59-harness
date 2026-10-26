// THREAT: ceilings, crowds, unreachable prey, strangers, fight-back and clear-path checks, mortal danger.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 31 methods: threatCeiling, namedPlayersHere, namedThreatsHere, roomOutranksUs,
//   travelShelterBelow, travelStopMaxThreats, threatCountHere, advancingThreatCountHere, crowded,
//   noteCrowdRefusal, travelDivertAt, shelterForwardAndMend, exitTest, reachTest,
//   noteUnreachableSpot, noteUnreachablePrey, unreachablePreyIn, preyAvoid, noteFailedRestSpot,
//   spotExclusions, bansDestination, unreachableIn, strangersInReach, fightBackAfterMs,
//   fightBackCheck, clearPathCheck, karmaForbids, refuseEngagement, recentText, mortalDanger,
//   healthRate
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { creatureByName, karmaSafe, loadSpawns } from '../m59-spawns.mjs';
import { recordTactic } from '../m59-tactics.mjs';
import { CLEAR_PATH_MS, FIGHT_BACK_GAP_MS, GOING_STATES, PULSE_MS, REACH, SPAWN_FILE, UNREACHABLE_SPOT_MS, advancesUs, crowdedSquares, engagementRefusal, pct } from '../m59-autopilot.mjs';

export class ThreatPart {
  // @part 1

  // IS THIS THING TOO DANGEROUS TO SWING AT — asked of ONE creature, by name.
  //
  // capBlockers answers this for a whole room and only when the room is at cap, so the
  // judgement it makes was unreachable from anywhere else. That gap is what killed
  // Waldorf. `capBlockers` correctly refused four soldiers of the Princess' army as
  // unrecognised, logged the refusal, and 1.3 seconds later the retaliation branch below
  // picked one of the same four as a `bystander` and engaged it, because that branch
  // consulted nothing. Level 27, 27/27 health, dead in thirteen seconds.
  //
  // Faction soldiers were present at 241 of the 403 attended deaths on disk. Commit
  // 7a4705c ("Absence of information is not permission") fixed the clearing half of this
  // and left the retaliating half open; this is the same rule, extracted so both halves
  // ask one question.
  //
  // Returns null when the creature is fine to fight, or a reason when it is not. Karma is
  // deliberately NOT consulted here: karma is a choice about what to hunt, and something
  // already swinging at us is not a choice.
  // THE ONE HOME OF THE ENGAGEMENT CEILING.
  //
  // It had four, all spelling the same expression, which is how this repository has always
  // ended up with two answers to one quantity — and this is the quantity that decides what
  // a character is allowed to be hit by, so a fifth copy drifting is a character dying.
  //
  // MAX HEALTH IS THE LEVEL here (101 + stamina caps it, and the game treats max health as
  // the level), so the ceiling is a proportion of it. Returns null when max health has not
  // been read: an unknown ceiling must refuse everything rather than permit everything, and
  // every caller treats null that way.
  threatCeiling() {
    const level = this.s.client?.vitals?.()?.health?.max ?? 0;
    if (!level) return null;
    const cfg = this.policy.threatCeiling;
    const value = Number(cfg?.value);
    // An unusable setting falls back to the documented default rather than to "no ceiling".
    // Defaulting open is the one direction that kills a character.
    if (!Number.isFinite(value) || value < 0) return Math.round(level * 1.5);
    return cfg?.mode === 'flat' ? level + Math.round(value) : Math.round(level * (value / 100));
  }

  // IS THE GROUND WE ARE STANDING ON ABOVE WHAT WE WOULD FIGHT?
  //
  // `threatCeiling` already answers that about ONE creature, and the ordinary ladder uses it
  // to decide what to swing at. Nothing asked it about a room a character is merely WALKING
  // THROUGH — and walking through is exactly when it matters most, because the character has
  // no intention of fighting and therefore no rung that consults the ceiling at all.
  //
  // A traveller in a zone it would never choose to fight is not in an ordinary amount of
  // danger and must not use the ordinary shelter threshold. Measured: a level-33 character
  // rested at a wall in the Cragged Mountains back to 33 of 33, walked on, and was dead
  // twenty seconds later — it lost twenty-two health in the time it takes to cross two
  // squares. Waiting for it to fall through 80% before looking for a wall spends most of the
  // margin it had.
  //
  // TRUE means "any damage at all is a reason to take a wall". That is the operator's rule
  // and it is only defensible BECAUSE it is conditional: in a zone the character would
  // happily fight in, the ordinary threshold still applies and a journey is not stopped by a
  // scratch.
  //
  // CACHED FOR A SECOND, because this is asked once per walk leg and the answer cannot
  // change faster than the room does. `loadSpawns` memoises the table, so the cost is the
  // room scan rather than the file.
  // The PEOPLE in the room, by name — the other half of "was this death PVP".
  namedPlayersHere() {
    const c = this.s?.client;
    if (!c?.room?.objects) return [];
    const out = [];
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!(o.flags & OF.PLAYER)) continue;
      const name = c.rsc?.get?.(o.nameRsc);
      // A NAME THE RESOURCE TABLE COULD NOT RESOLVE IS NOT A PERSON.
      //
      // `rsc.get` answers `<dynamic 1000081>` for an id it has no string for, and that is a
      // truthy string. Counting it made a death surrounded by six trolls read as PVP —
      // Uuuu, 2026-08-28 — which is exactly backwards for the one column that decides whether
      // a wall failed. An unresolved id is unknown, and unknown must not read as a person.
      if (name && !/^<.*>$/.test(name)) out.push(name);
    }
    return out;
  }

  // The attackable non-players in the room, by name. One enumeration, two callers — the
  // ledger wants the list and `roomOutranksUs` wants to know whether any of them outranks us.
  namedThreatsHere() {
    const c = this.s?.client;
    if (!c?.room?.objects) return [];
    const out = [];
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!(o.flags & OF.ATTACKABLE) || (o.flags & OF.PLAYER)) continue;
      const name = c.rsc?.get?.(o.nameRsc);
      if (name) out.push(name);
    }
    return out;
  }

  roomOutranksUs(ttlMs = 1000) {
    const now = Date.now();
    if (this._outranksAt && now - this._outranksAt < ttlMs) return this._outranks;
    this._outranksAt = now;
    this._outranks = false;
    const c = this.s?.client;
    if (!c?.room?.objects) return false;
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!(o.flags & OF.ATTACKABLE) || (o.flags & OF.PLAYER)) continue;
      const name = c.rsc?.get?.(o.nameRsc);
      if (!name) continue;
      // `refuseEngagement` returns a refusal object when the creature is over the ceiling,
      // and null when it is fair game. One over-ranked thing in the room is enough: it is
      // the one that will do the killing.
      if (this.refuseEngagement(name)) { this._outranks = true; break; }
    }
    return this._outranks;
  }

  // The shelter threshold in force RIGHT HERE, which is not a constant. See roomOutranksUs.
  //
  // A SCRATCH DOES NOT STOP A CROSSING. MOVING IS HOW YOU SURVIVE THESE ROOMS.
  //
  // ===================== CORRECTED 2026-08-23, WITH EVIDENCE =====================
  //
  // This was 1 — shelter at any damage at all — for most of an evening, on the reasoning
  // below, which was sound about the COST OF A STOP and silent about the cost of stopping
  // OFTEN. The transit book says what that cost was:
  //
  //     587 -> 597  FAIL  movement cancelled by a travel guard rung taking the character back
  //     598 -> 599  FAIL  movement cancelled by the watchdog pulling us out of a blind walk
  //     587 -> 597  FAIL  movement cancelled by a travel guard rung taking the character back
  //
  // and the journey ledger says it in one number, on every single journey of the evening:
  //
  //     legs 2, planned_legs 7      hp 33 -> 29
  //     legs 2, planned_legs 7      hp 20 -> 15
  //     legs 2, planned_legs 7      hp 33 -> 29
  //
  // TWO LEGS OF SEVEN, EVERY TIME, having lost four health. Nothing was killing these
  // characters. Our own guard was ending the crossing over a scratch, and then they stood
  // idle in a 750-danger room until something did kill them. Measured on one:
  //
  //     act=idle | hp 3/33 | for 8s | walked 5.4 | net 2.8 | shelter_after None | rooms [598]
  //
  // Thirty health in eight seconds — WHILE STATIONARY. I read that rate as a property of
  // the Cragged Mountains and concluded the room was unsurvivable. The operator's
  // correction is the whole of it: twenty-hitpoint mules cross to Castle Victoria daily.
  // The rate is a property of STANDING STILL. A moving character outpaces most of what
  // chases it, and a thing that never catches you never hits you.
  //
  // So the damage rate is an OUTPUT of stopping, not an input that stopping answers — and a
  // trigger that stops on any scratch is a machine for producing it.
  //
  // Mid-hop is now for real trouble only: half health, a little earlier where the room
  // outranks the character, and `wouldPlayDead` regardless. Everything above that keeps
  // walking, and the HOP BOUNDARY — where a pause costs nothing because the mover is
  // between rooms and the journey pauses rather than ending — is where an ordinary shelter
  // belongs. That distinction is what TRAVEL_GUARD_CLOCK exists to record, and it was right
  // before I traded it away for sensitivity.
  //
  // The reasoning that produced the 1, kept because the half of it that is true is why the
  // number is 0.5 rather than back where it started:
  //
  // This has been 1 before and it was a disaster then, so the change of mind needs its
  // reasons written down rather than just its new number. It produced
  //
  //     586  cancelled at 0 of 40 by a travel guard rung taking the character back
  //     587  cancelled at 6 of 65 by a travel guard rung taking the character back
  //
  // thirty laps of stop-and-restart in one leg. I read that as "1 is not a threshold" and
  // moved the wall to the hop boundary. THAT WAS THE WRONG LESSON. What made a trigger
  // unaffordable was never its sensitivity — it was that the shelter it triggered NEVER
  // COMPLETED. Three things have changed since, and each of them was a real bug:
  //
  //   THE SPOT IS A WALL NOW.  The search only ever considered coarse-walkable squares, so
  //     every "safe spot" in this fleet's book was ordinary floor — 15 recorded squares in
  //     the Cragged Mountains against 1,778 real walls in the room, and not one of the 15
  //     was one. Standing on grass does not stop anything, so a stop bought nothing and the
  //     rung fired again immediately.
  //   THE SPOT IS NEAR NOW.  Eighteen steps across open ground became 2.2 squares onto a
  //     fully enclosed wall. Most of the cost of a stop was the walk to it.
  //   THE CANCEL KEEPS THE ROAD NOW.  f245be5 and a4bb63f — a journey that ends short keeps
  //     its destination and the rung that resumes it actually runs.
  //
  // So the trade has inverted. A stop costs a few seconds and returns the character to full
  // health on a square nothing can path to; not stopping risks the whole trip and the max
  // health a death costs. With rooms crossing in fifteen to twenty-five seconds, a few
  // seconds of resting is cheap against any chance of dying.
  //
  // `travel_shelter_per_room` remains the loop guard, and it is what makes a sensitive
  // trigger safe rather than the threshold doing that job badly.
  travelShelterBelow() {
    return this.roomOutranksUs()
      ? (this.policy.travelWallBelowOutranked ?? 0.55)
      : (this.policy.travelWallBelow ?? 0.5);
  }

  // WHEN A FREE DETOUR IS WORTH TAKING, AND IT IS NOT ONE NUMBER EITHER.
  //
  // The operator's rule, 2026-08-27: **any damage at all is a reason to take a wall when the
  // map holds things stronger than us, and only then.** A hundred-hitpoint character nicked by
  // a baby spider does not need to sit down, and a rule that makes it sit down is a rule that
  // turns every crossing of a safe wood into a series of stops.
  //
  // I had this at a flat 1 for one run and it cost 33 percentage points of arrival — 43% down
  // to 10% on the same seed, with fourteen of twenty-one parked in inns at full health. The
  // reasoning was that diverting is free, and it IS free per detour; what is not free is
  // taking one every time anything scratches you across a road with twenty-six hops.
  //
  // So it is conditioned on the same question the cancel threshold already asks. This is the
  // pair `travelShelterBelow` above has, and deliberately the same shape: in a zone the
  // character would happily fight in, an ordinary threshold; in a zone it would refuse to
  // engage anything in, the first scratch is the warning it gets.
  // Legacy name retained for stored policy compatibility. This threshold only gates
  // aggressive quarry pulls and trading melee blows in place. It does not gate
  // taking, selecting or recovering at a travel refuge. Monster bodies matter to a
  // refuge through obstruction of its actual approach, not their number in the room.
  // Policy travelStopMaxThreats, input travel_stop_max_threats, environment
  // M59_TRAVEL_STOP_MAX_THREATS; default 6, 0 disables those combat guards.
  travelStopMaxThreats() {
    const p = Number(this.policy?.travelStopMaxThreats);
    if (Number.isFinite(p)) return p;
    const e = Number(process.env.M59_TRAVEL_STOP_MAX_THREATS);
    return Number.isFinite(e) ? e : 6;
  }
  // Count attackable monster bodies, including those whose names have not resolved.
  threatCountHere() {
    const c = this.s?.client;
    if (!c?.room?.objects) return 0;
    let n = 0;
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!(o.flags & OF.ATTACKABLE) || (o.flags & OF.PLAYER)) continue;
      n++;
    }
    return n;
  }
  /**
   * The same count, minus everything in the room that cannot advance this body.
   *
   * Operator, 2026-09-21: "the fight your way out should not block/skip because of other
   * monsters being nearby if they're lower level (no advancement)".
   *
   * MEASURED, and this is why it is a live suppressor rather than a nicety. `crowd_combat_refusal`
   * has fired 162 times, and it was still firing while this was written — Waldorf in room 39,
   * Marco in 534 — under the trigger "pulling quarry to the wall". That refusal is the keeper
   * declining to GO AND FIGHT. Bunsen's 8 "threats" in the Flatlands were spider, ant, spider,
   * ant, spider, spider: levels 40 and 50 against his 53 max health, so not one of them could
   * raise anything, and together they talked him out of fighting his way off the square he died
   * on. Room 39 is the mixed case — the battered skeleton at 60 still counts for a 58-max body,
   * the zombie at 55 no longer does.
   *
   * UNKNOWN CREATURES STILL COUNT (`advancesUs` returns true when the table has no row), because
   * this decides who may be IGNORED and an unidentifiable body is exactly what a crowd guard is
   * for. Players are already excluded by `threatCountHere`, and nothing here changes that.
   */
  advancingThreatCountHere() {
    const c = this.s?.client;
    if (!c?.room?.objects) return 0;
    const maxHealth = c?.vitals?.()?.health?.max ?? null;
    if (!Number.isFinite(maxHealth) || maxHealth <= 0) return this.threatCountHere();
    let n = 0;
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!(o.flags & OF.ATTACKABLE) || (o.flags & OF.PLAYER)) continue;
      const name = o.name ?? c?.rsc?.get?.(o.nameRsc) ?? null;
      if (advancesUs(name, maxHealth)) n++;
    }
    return n;
  }
  /**
   * `forFighting` counts only what can advance us; the default counts every body.
   *
   * THE SPLIT IS PROSPECTIVE, AND SAYING SO IS THE POINT. Both of this method's callers today
   * are combat gates — the pull refusal and the trade-in-place veto — and both now pass
   * `forFighting: true`, so the advancing-only count is in practice the only one used. The
   * parameter exists because the threshold is called `travelStopMaxThreats` and CLAUDE.md
   * describes a journey that "makes no stops" and a retreat that "considers only the exit" at
   * or above it: if that rule is ever wired through here, it must NOT inherit this filter. Six
   * weak things in a doorway are still six things between a body and the road, and that rule
   * was written from 57 road deaths in one day. Deciding whether to SWING is a different
   * question from deciding whether to WALK, and only the first one is being changed.
   */
  crowded({ forFighting = false } = {}) {
    const cap = this.travelStopMaxThreats();
    if (!(cap > 0)) return false;
    let n = 0;
    try { n = forFighting ? this.advancingThreatCountHere() : this.threatCountHere(); }
    catch { return false; }
    return n >= cap;
  }
  // One ledger row per room per minute when a combat crowd guard fires.
  noteCrowdRefusal(what) {
    const room = Number(this.s?.world?.room?.num ?? 0);
    const now = Date.now();
    const key = `${room}:${what}`;
    this._crowdNoted ??= new Map();
    if ((this._crowdNoted.get(key) ?? 0) > now - 60_000) return;
    this._crowdNoted.set(key, now);
    let n = 0; try { n = this.threatCountHere(); } catch { /* counted as unknown */ }
    try {
      recordTactic({ character: this.s?.client?.me?.name ?? this.s?.name ?? null, room,
                     tactic: 'crowd_combat_refusal', trigger: what, worked: true, ms: 0, hp_lost: 0, attempted: true,
                     note: `${n} threats in the room (cap ${this.travelStopMaxThreats()}): refused ${what}; shelter remains available` });
    } catch { /* evidence, not a dependency */ }
  }
  travelDivertAt() {
    return this.roomOutranksUs()
      ? (this.policy.travelDivertBelowOutranked ?? 1)
      : (this.policy.travelDivertBelow ?? 0.95);
  }

  /**
   * TAKE A WALL THAT IS FORWARD ON THE ROUTE, AND MEND THERE BEFORE GOING ON.
   *
   * The recovery stop a journey needs, as opposed to the brief pause a hop boundary takes.
   * Two things ask for it and both were losing characters without it:
   *
   *   - the watchdog rescuing a stalled driver, which used to hand the body to the ordinary
   *     ladder and leave it IDLE in whatever room it was dying in. Aaaa: journey ended at two
   *     legs, idle at +81s, dead at 201s.
   *   - poison, which drains a character below any threshold it can fight at and then makes
   *     it rest to full anyway once the enchantment ends. Bbbb reached the Cragged Mountains
   *     at 13 of 20, poisoned, and died there.
   *
   * FORWARD, because the room is what is dangerous: a wall behind us pays the exposure twice
   * and a wall ahead is shelter and a hop of progress at once. `sheltersAlong` worked these
   * out when the crossing was planned and `shelterAhead` returns the next one still in front.
   *
   * The objective is KEPT. Resting here is part of the journey, not the end of it, and the
   * resume already waits while health is climbing and goes when it stops.
   */
  async shelterForwardAndMend(why) {
    // Legacy entry point for an interrupted journey. Select once, through the
    // recovery selector; takeSafeSpot logs the target it actually claims and walks to.
    // A route-adjacent preview used to announce one wall and then discard its identity.
    const took = await this.takeRecoverySpot(why, { source: 'travel' })
                           .catch(() => ({ took: false }));
    // Cancellation handled this pass too: the caller must not start a fallback
    // walk with a fresh generation after an outside owner stopped this one.
    return !!(took?.took || took?.cancelled);
  }

  // A WALL WE CANNOT PATH TO IS NOT A CANDIDATE, AND THE SELECTOR CAN BE TOLD SO.
  //
  // `nearestSafeSpot` takes a `reach` predicate and NOBODY PASSED ONE, so every wall it
  // scored read as reachable and the first anyone discovered otherwise was when the walk
  // failed — one square per attempt, at a wall, in whatever room this is.
  //
  // Ukgoth has no shortage of walls: 1,136 of its 4,686 standable squares are places the two
  // grids disagree, and the selector finds one within 7 to 11 steps of every door. The book
  // is not hiding them either — sixteen squares recorded there, and the same spot comes back
  // with the book and without it. What was failing was the WALK, every time, and nothing
  // asked beforehand.
  //
  // NO OPINION MEANS CARRY ON. A room with no geometry, or a pathfinder that throws, answers
  // reachable — the same rule the step mask follows, because a bake must never be the thing
  // that makes a wall disappear.
  // CAN WE GET OUT AGAIN. The other half of `reachTest`, and the half that was missing.
  //
  // One mover step is the whole bar. Not two, not a path back to the road: a safe spot is
  // meant to be hemmed in — that is what makes it safe — and demanding room to manoeuvre
  // would refuse the good ones along with the fatal ones. A square with ZERO ways out is a
  // different thing from a tight one, and it is the only thing refused here.
  //
  // exitTest and reachTest return selector callbacks in public 1-based (col,row) order.
  // Their RoomGeometry calls intentionally swap those arguments to positional (row,col).
  exitTest() {
    const geo = this.s?.world?.geometry;
    if (!geo || typeof geo.moverStepLands !== 'function') return null;
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    return (col, row) => {
      try {
        for (const [dr, dc] of DIRS)
          if (geo.moverStepLands(row, col, row + dr, col + dc) === true) return true;
        return false;
      } catch { return true; }   // no opinion means carry on
    };
  }

  reachTest() {
    const geo = this.s?.world?.geometry;
    const me = this.s?.client?.self;
    if (!geo || !me || typeof geo.path !== 'function') return null;
    return (col, row) => {
      try {
        const p = geo.path(me.row, me.col, row, col);
        return { reachable: !!p?.found, steps: p?.steps?.length ?? null };
      } catch { return { reachable: true, steps: null }; }
    };
  }

  // A WALL WE COULD NOT WALK TO IS NOT SHELTER, AND OFFERING IT AGAIN IS A LOOP.
  //
  // Distinct from the safe-spot BOOK, which records squares that failed to HOLD — that is a
  // fact about the wall and it is permanent. This is a fact about the WALK, and it is
  // usually temporary: something was standing in the doorway, or the body was on the wrong
  // side of a ledge. So it lives on the keeper for a few minutes rather than in the book for
  // ever, and a square gets another chance once the reason has had time to move.
  //
  // Measured in the Western border of the Twisted Wood, from a dead character's own decision
  // trail: "could not reach the safe spot" / "will not rest in the open here" / "leaving the
  // room to recover safely" / "could not leave" — then it died. Nothing recorded the failure,
  // so every pass made the identical choice, and the crossing was never allowed to proceed.
  // Per-room exclusion keys below preserve the selector's 1-based "col,row" order.
  noteUnreachableSpot(room, col, row) {
    if (room == null) return;
    const per = (this.unreachableSpots ??= new Map());
    const forRoom = per.get(room) ?? per.set(room, new Map()).get(room);
    // Bounded, because a long session in a bad room must not grow this without limit.
    if (forRoom.size > 256) forRoom.clear();
    forRoom.set(`${col},${row}`, Date.now());
  }

  // PREY WE HAVE PROVED WE CANNOT WALK TO, REMEMBERED BY SQUARE.
  //
  // `closeOnQuarry` already DETECTS this and then forgets it, which is the whole defect: a
  // null `approachSquare` returns "no square beside it that we can reach", the next pass
  // ranks the same creature nearest again, and the keeper walks at it for ever. Measured on
  // prod 2026-09-18, a character in the Mausoleum (1016) with mummies behind a locked-off
  // corner: `stuck` repeats 23, lever null, "broke off without a landed hit or a kill",
  // twenty-five minutes, zero kills and zero damage TAKEN -- it never got close enough to be
  // hit. It escalated to STALL_NO_LEVER, which is correct and useless, because the only
  // lever is "stop choosing that one" and nothing could express it.
  //
  // THE KEY IS THE SQUARE, NOT THE OBJECT, and that is the whole reason this works. An
  // object id is a temporary handle -- renumbered on every system save, recycled within
  // hours -- so a remembered id would name a different monster by morning AND would miss the
  // replacement that spawns in the same corner thirty seconds later. The corner is the
  // durable fact. Keyed "col,row" per room, exactly like noteUnreachableSpot above.
  //
  // AND IT EXPIRES, for the reason the critic rubric insists on: "unreachable" is a fact
  // about our model of the world, never about the world. A door opens, a body moves, a jump
  // gets declared -- so this is a few minutes of local memory and not a verdict. Same TTL as
  // the spot memory, and a square gets another chance once the reason has had time to move.
  noteUnreachablePrey(room, col, row) {
    if (room == null || col == null || row == null) return;
    const per = (this.unreachablePreySpots ??= new Map());
    const forRoom = per.get(room) ?? per.set(room, new Map()).get(room);
    if (forRoom.size > 256) forRoom.clear();
    forRoom.set(`${col},${row}`, Date.now());
  }

  /** Squares in this room where prey has recently proved unreachable, or null. */
  unreachablePreyIn(room) {
    const ttl = this.policy.unreachableSpotMs ?? UNREACHABLE_SPOT_MS;
    const now = Date.now();
    const forRoom = this.unreachablePreySpots?.get(room);
    if (!forRoom) return null;
    const live = new Set();
    for (const [k, at] of forRoom) {
      if (now - at <= ttl) live.add(k);
      else forRoom.delete(k);
    }
    if (!forRoom.size) this.unreachablePreySpots.delete(room);
    return live.size ? live : null;
  }

  // The predicate `skills.fight` takes. Null when there is nothing to avoid, so the common
  // case adds no filter at all rather than an always-true one.
  //
  // DELIBERATELY NOT FOLDED INTO `unreachableIn`. That set feeds the safe-spot selector, and
  // "a square I could not walk to" and "a square something I cannot reach is standing on"
  // are different claims -- the second square may be perfectly good to stand on. Same shape,
  // same TTL, separate stores, because merging them would quietly shrink the wall book.
  preyAvoid(room) {
    if (this.policy.ignoreUnreachablePrey === false) return null;
    const bad = this.unreachablePreyIn(room);
    if (!bad) return null;
    return o => o?.col != null && o?.row != null && bad.has(`${o.col},${o.row}`);
  }

  // A failed rest must choose somewhere else on the next attempt. This is local,
  // temporary recovery state, not a verdict from the historical safe-spot ledger:
  // poison, other players, and changed room contents can all defeat a rest.
  noteFailedRestSpot(room, col, row) {
    if (room == null || col == null || row == null) return;
    const per = (this.failedRestSpots ??= new Map());
    const forRoom = per.get(room) ?? per.set(room, new Map()).get(room);
    if (forRoom.size > 256) forRoom.clear();
    forRoom.set(`${col},${row}`, Date.now());
  }

  /**
   * Everything the spot selector must skip this pass: squares we recently failed to reach or rest in
   * (remembered, with a TTL) plus squares another player is standing on or next to
   * (never remembered — asked fresh every time). One set, because nearestSafeSpot takes one.
   */
  spotExclusions(room, { playerRadius = 1 } = {}) {
    const stale = this.unreachableIn(room);
    const c = this.s?.client;
    const crowd = crowdedSquares(c?.room?.objects, c?.selfId,
      { radius: playerRadius, playersOnline: c?.playersOnline });
    if (!crowd.size) return stale;
    const out = new Set(stale ?? []);
    for (const k of crowd) out.add(k);
    return out;
  }

  /** Has the operator banned this room as a destination for this character? See policy.bannedDestinations. */
  bansDestination(room) {
    const list = this.policy?.bannedDestinations;
    if (!Array.isArray(list) || !list.length || room == null) return false;
    return list.some(r => Number(r) === Number(room));
  }

  /** Recently unavailable squares, including this keeper's failed rest attempts. */
  unreachableIn(room) {
    const ttl = this.policy.unreachableSpotMs ?? UNREACHABLE_SPOT_MS;
    const now = Date.now();
    const live = new Set();
    for (const per of [this.unreachableSpots, this.failedRestSpots]) {
      const forRoom = per?.get(room);
      if (!forRoom) continue;
      for (const [k, at] of forRoom) {
        if (now - at <= ttl) live.add(k);
        else forRoom.delete(k);
      }
      if (!forRoom.size) per.delete(room);
    }
    return live.size ? live : null;
  }

  // WHO IN THIS ROOM IS A PERSON AND NOT ONE OF OURS.
  //
  // The same filter was written out by hand in three places before this — the travel guard,
  // the PvP detector and the hold rung — and they must not be allowed to drift, because the
  // whole survival ladder now turns on the difference between a creature and a person.
  //
  // BOTH FLAGS. The room filter asks for PLAYER and ATTACKABLE together: `PF_*` is an ENUM
  // rather than a bitmask, and a Dungeon Master carries flags that make a naive test true.
  // `party.isFleetmate` tells one of ours from a stranger, and a keeper that has not had a
  // pass yet is ABSENT from that roster — so this can call a fleetmate a stranger for a few
  // seconds after a restart. Being wrong that way costs a walk, never a fight, which is the
  // cheap direction and the reason the answers built on it are withdrawals.
  strangersInReach(reach = REACH) {
    const c = this.s?.client;
    const me = c?.self;
    if (!me || !c?.room?.objects) return [];
    return [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE) &&
      !party.isFleetmate(c.rsc?.get(o.nameRsc)) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= reach);
  }

  // ---------------------------------------------------------- the fight-back edict
  //
  // "IF DITHERING AND BEING ATTACKED FOR MORE THAN TEN SECONDS, FIGHT BACK IF IT IS
  // SMALLER THAN YOU." An operator's standing order, 2026-08-27, after watching six
  // characters in the Valley of Ileria stand in one corner being chewed on: each keeper was
  // inside a walk it could not finish — an approach the fine grid refused, a pull, a wall it
  // had just been told to leave — and the "hitting back" branch in passFarm, which is the
  // right answer, was never reached because the pass never ended. Measured on Lew: 482
  // pulse wedges in 460 passes, five kills in two and a half hours, `landed_hits: 0`.
  //
  // Two halves, on the two clocks this repository already keeps apart:
  //
  //   `fightBackCheck` runs on the WATCHDOG (every 500ms) and DECIDES NOTHING. It keeps an
  //   attack episode — health going down while something attackable is within reach — and
  //   when the episode is older than the edict, once per pass, it pulls the same handbrake
  //   the other two arms pull, so the blind await ends and a pass can answer.
  //
  //   `passFightBack` runs on the PASS and answers: the nearest thing in reach that the
  //   fleet's own band would let this character fight is the target, now, before any wall
  //   or pull or walk. Below the flee line it steps aside — the survival ladder is next.
  //
  // OFF UNLESS ASKED FOR. `fightBackAfterMs` is unset by default and silence means the
  // behaviour that was already there. Pushed live with `fight_back_after_s` (the `autopilot`
  // tool, or `substrate/tuning.json`), zero switches it off again.
  //
  // "SMALLER THAN YOU" IS THE ENGAGEMENT BAND, NOT THE LEVEL. A creature's level is not how
  // dangerous it is — `viDifficulty` is, and a level-50 fungus beast is the safer fight for a
  // level-45 character (docs/m59-combat.md). `refuseEngagement` already encodes that
  // judgement with the operator's own ceiling, so the edict asks it rather than growing a
  // second opinion. What it refuses, the ordinary ladder still walks away from.
  fightBackAfterMs() {
    const v = Number(this.policy?.fightBackAfterMs);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  fightBackCheck(w, hp, now, lost) {
    if (!w) return null;
    // THE EPISODE. A blow is health going down with something attackable in reach; falling
    // off a ledge or a poison tick with nothing near is not an attack and starts nothing.
    if (lost > 0 && (this.inReachOfUs?.() ?? []).length) {
      if (!w.attack) w.attack = { since: now, hits: 0, lost: 0, lastHitAt: now };
      w.attack.hits++; w.attack.lost += lost; w.attack.lastHitAt = now;
    } else if (w.attack && now - w.attack.lastHitAt > FIGHT_BACK_GAP_MS) {
      w.attack = null;
    }
    const edict = this.fightBackAfterMs();
    if (!edict || !w.attack) return null;
    if (now - w.attack.since < edict) return null;
    // Already swinging is not dithering; an errand owns the body; once per pass.
    if (this.doing === 'fighting' || this.inert) return null;
    if (w.fightBackPass === this.passes) return null;
    const frac = pct(hp);
    // Below the flee line the other arms and the ladder own this — running, not swinging.
    if (frac === null || frac < this.safety().fleeAt) return null;
    w.fightBackPass = this.passes;
    this.tally.fight_back_interrupts = (this.tally.fight_back_interrupts || 0) + 1;
    this.fightBackDue = { since: w.attack.since, hits: w.attack.hits, lost: w.attack.lost, at: now };
    // END THE BLIND AWAIT, if there is one. A pass inside a walk cannot answer; the cancel
    // is the same single action the handbrake takes, and the answer belongs to the pass.
    const blocked = this.passStartedAt ? now - this.passStartedAt : 0;
    let broke = null;
    if (blocked >= PULSE_MS) {
      try { broke = this.s.cancelMovement(null, 'under attack and not swinging — the fight-back edict',
                                               { origin: keeperOrigin('fight_back') }); }
      catch (e) { broke = { cancelled: false, why: e.message }; }
    }
    this.note('WATCHDOG — under attack for ' + Math.round((now - w.attack.since) / 1000) +
              's and not swinging', {
      hits_taken: w.attack.hits, lost: w.attack.lost,
      health: hp ? `${hp.value}/${hp.max}` : null, doing: this.doing ?? null,
      pass_blocked_for_s: Math.round(blocked / 1000), interrupted: broke?.interrupted ?? null,
      why: 'the fight-back edict: being hit for longer than ' + Math.round(edict / 1000) +
           's while not swinging. The walk is cancelled so the next pass can fight back — ' +
           'this keeper decides nothing here',
    });
    return this.fightBackDue;
  }

  // A CREATURE STANDING IN THE WALK IS A REASON TO SWING, AND IT IS THE ONLY ONE.
  //
  // The sibling of `fightBackCheck` above, and it exists because that one is armed by DAMAGE.
  // See `clear_path` in TRAVEL_GUARD_DEFAULTS for the operator's report and for why neither
  // `fight_back`, `capBlockers` nor the needle covers this.
  //
  // THE TRIGGER IS COVERING NO GROUND, NOT BEING HURT. `w.pinnedSince` is already maintained
  // by the watchdog — displacement from an anchor, which is the measure that survives a
  // two-square shuffle where stillness does not — so this asks a question the file can
  // already answer and adds no new bookkeeping.
  //
  // FIVE GATES, AND EVERY ONE OF THEM IS HERE TO STOP THIS BECOMING "FIGHT EVERYTHING ON THE
  // ROAD", which is the doctrine this repository has spent months removing:
  //   * only while a JOURNEY is what is moving us — GOING, never standing at a counter;
  //   * only once the body has been pinned for CLEAR_PATH_MS, so a creature we walked past
  //     is not a blocker and a momentary slide is not a jam;
  //   * only ABOVE the flee line — below it, running is the answer and the ladder owns it;
  //   * only something in MELEE REACH, which is what "in the way" means to a mover that
  //     cannot get past it;
  //   * and the target is chosen by `passFightBack`, which already applies the engagement
  //     band and the refusal list. This rung picks nothing; it only says "now".
  //
  // It hands to `fightBackDue` on purpose: one consumer, one target chooser, one set of
  // safety rules. A second path would drift from the first, which is how this file grew two
  // height rules and four copies of the fall physics.
  clearPathCheck(w, hp, now) {
    if (!w) return null;
    if (!this.travelAllows('clear_path')) return null;
    // A BLOCKED JOURNEY STOPS SAYING "travelling" LONG BEFORE IT STOPS BEING ONE, AND THIS GATE
    // WAS READING THE WORD RATHER THAN THE COMMITMENT.
    //
    // `GOING_STATES` is travelling/pulling/converging/zoning. A body that has been stopped by
    // something for long enough degrades to `doing: "stalled"` — so the population this rung
    // exists for had already left the state it requires, and clear_path refused exactly the
    // characters it was written to rescue.
    //
    // MEASURED over 48 hours of prod post-mortems, 2026-09-20:
    //
    //     The Flatlands, killed by a spider   24 deaths   20 `stalled`, 4 GOING, 24 suspended
    //     The Flatlands, killed by an ant      4 deaths    4 `stalled`, 0 GOING,  4 suspended
    //     Ukgoth, killed by a troll           22 deaths    2 `stalled`, 20 GOING
    //
    // 24 of 28 in the Flatlands — 86% — were in the one state this returned null for, and ALL
    // 28 still carried a suspended journey. Ukgoth is the control: those bodies were GOING, so
    // the rung armed and the engagement band correctly declined to pick a fight with a troll.
    //
    // THE SUSPENDED JOURNEY IS THE COMMITMENT, and it is what makes this narrow rather than
    // "fight when stuck": the body is between travelling states and still owes a destination.
    // Nothing else is relaxed — an errand still owns the body through `inert`, a swing already
    // in progress still short-circuits, the six-second pin still applies, the flee line still
    // applies, the target is still chosen by `passFightBack`'s engagement band, and `near` is
    // still filtered of players by its caller. A troll does not become fightable because the
    // body stopped moving.
    //
    // Operator, 2026-09-20: "we want those battered skeletons and the icky spiders to be
    // active for the 'fight your way out' strategy if possible".
    const blockedMidJourney = this.doing === 'stalled' && !!this.suspendedJourney;
    if (!GOING_STATES.includes(this.doing ?? null) && !blockedMidJourney) return null;
    // Already swinging is not a jam; an errand owns the body; once per pass.
    if (this.doing === 'fighting' || this.inert) return null;
    if (w.clearPathPass === this.passes) return null;
    // AND THE DURATION HAS TO COME FROM SOMEWHERE THE WATCHDOG HAS NOT ALREADY NULLED.
    //
    // `w.pinnedSince` is maintained by the watchdog under the SAME GOING assumption this rung
    // used to carry — `m59-watchdog.mjs`: `const eligible = GOING.includes(host.doing) && ...;
    // if (!eligible) { w.pinnedSince = null; }`. So widening the arming gate above achieved
    // nothing on its own: the rung armed for a stalled body and then failed here, because the
    // signal it measures is cleared by the transition into `stalled`.
    //
    // MEASURED, and this is why it is worth the second fix rather than a claim. After rolling
    // all 24 prod keepers onto the widened gate, `clear_path_interrupts` was ZERO across the
    // fleet at 14 minutes average uptime — and Bunsen died in the Flatlands at 03:46:07 with
    // `doing: "stalled"`, `suspended_journey: {to: 38, attempts: 2}`, `clear_path: true`, a
    // spider on him, and health falling 35 -> 4 over thirty seconds on ONE SQUARE (r35c32,
    // `squares_per_second_at_the_end: 0`). Every gate passed except this one.
    //
    // THE SUSPENDED JOURNEY ALREADY CARRIES ITS OWN CLOCK, so nothing new is bookkept: `at`
    // is when the ladder took the body off the road. Bunsen's read 58 seconds at death. The
    // watchdog's own measure is still preferred when it has one — this is a floor under it for
    // exactly the state the watchdog declines to measure, not a replacement.
    //
    // Deliberately NOT widening `eligible` in the watchdog: `pinnedSince` is also what the
    // wedge ladder and `wedgedInPlace` read, and those cancel movement and count breaks at a
    // place. Changing the meaning of one signal for four consumers to fix one of them is how
    // this file grew two height rules.
    const suspendedFor = blockedMidJourney && Number.isFinite(this.suspendedJourney?.at)
      ? now - this.suspendedJourney.at : 0;
    const pinnedFor = Math.max(w.pinnedSince ? now - w.pinnedSince : 0, suspendedFor);
    if (pinnedFor < CLEAR_PATH_MS) return null;
    const frac = pct(hp);
    if (frac === null || frac < this.safety().fleeAt) return null;
    // A POLITE BUMP ON THE ROAD MUST NOT START A WAR, and this is the line that guarantees it.
    //
    // `inReachOfUs()` filters `!(o.flags & OF.PLAYER)`, so a person can neither ARM this rung
    // nor be chosen by it — including a murderer, which is stricter than the operator asked for
    // and is the safe direction. It matters because the trigger is "something is in my way",
    // and on a shared server with real people that is exactly what another player standing in a
    // doorway looks like. Twenty-one characters deciding to clear a person out of a corridor is
    // not a mistake anybody gets to take back afterwards.
    //
    // Do NOT "simplify" this to room.objects: the player exclusion is the entire safety case,
    // and m59-travelling-test pins it behaviourally — three players in reach must not arm it.
    // A SPARED BODY IS NOT A REASON TO STOP THE WALK: passFightBack will never swing at it, so arming
    // the rung for one cancelled a journey to pick a fight that could not happen (`lureSparedBlocker`
    // is the answer to a spared blocker, and it is the wedge ladder's, not this rung's).
    const near = (this.inReachOfUs?.() ?? []).filter(o => !this.sparedHere(o));
    if (!near.length) return null;

    w.clearPathPass = this.passes;
    this.tally.clear_path_interrupts = (this.tally.clear_path_interrupts || 0) + 1;
    // `reason` is what lets passFightBack tell this apart from the damage edict — it must run
    // for a blocked character whose `fight_back_after_s` is 0, because the two are different
    // permissions and an operator may want one without the other.
    this.fightBackDue = { since: w.pinnedSince, hits: 0, lost: 0, at: now, reason: 'blocked' };
    // END THE BLIND AWAIT so the next pass can answer. Identical to the fight-back edict's
    // single action, and for the identical reason: a pass inside a walk cannot decide.
    const blocked = this.passStartedAt ? now - this.passStartedAt : 0;
    let broke = null;
    if (blocked >= PULSE_MS) {
      try { broke = this.s.cancelMovement(null, 'a creature is blocking the walk — clear_path',
                                               { origin: keeperOrigin('clear_path') }); }
      catch (e) { broke = { cancelled: false, why: e.message }; }
    }
    this.note('WATCHDOG — covered no ground for ' + Math.round(pinnedFor / 1000) +
              's with something in reach', {
      pinned_for_s: Math.round(pinnedFor / 1000),
      in_reach: near.length,
      health: hp ? `${hp.value}/${hp.max}` : null, doing: this.doing ?? null,
      pass_blocked_for_s: Math.round(blocked / 1000), interrupted: broke?.interrupted ?? null,
      why: 'a journey that is covering no ground with a creature inside melee reach is being ' +
           'BLOCKED, not merely travelling slowly. The walk is cancelled so the next pass can ' +
           'kill what is in the way — this keeper picks no target and decides nothing here',
    });
    return this.fightBackDue;
  }

  // A KARMA-STRICT CHARACTER NEVER STRIKES WHAT WOULD MOVE ITS KARMA THE WRONG WAY — not even
  // something hitting it. Operator, 2026-09-28, of two Qor disciples killing living trees for
  // negative karma in a forest full of spiders: "it will also have to avoid (and not kill!) the
  // spiders when being run for -karma goals". `policy.karma` alone only ever narrowed what to
  // HUNT and CLEAR (karmaSafe in capBlockers); hitting back, fighting back, the lone-attacker
  // rung and a wedged swing all ignored it on purpose — "something already swinging at us is
  // not a choice" — and one spider kill (karma -30) undoes several trees. So this is opt-in,
  // per character, and the price is named: an attacker we may not strike is left to the
  // survival ladder (the flee line still fires) and to whoever is clearing the room for us.
  // Returns null, or a refusal shaped like engagementRefusal's.
  karmaForbids(name) {
    if (!this.policy?.karmaStrict || !this.policy?.karma || !name) return null;
    const info = creatureByName(loadSpawns(SPAWN_FILE), name);
    if (info?.karma == null) return null;
    if (karmaSafe(info.karma, this.policy.karma)) return null;
    return { name, level: info.level ?? null, rating: info.attack_rating ?? null, karma_strict: true,
             why: `karma_strict: killing a ${name} (karma ${info.karma}) moves a ${this.policy.karma} ` +
                  "character's karma the wrong way" };
  }

  refuseEngagement(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    const karma = this.karmaForbids(name);
    if (karma) return karma;
    const spawns = loadSpawns(SPAWN_FILE);
    const info = creatureByName(spawns, name);
    const ceiling = this.threatCeiling();
    return engagementRefusal(info, { name, ceiling });
  }

  // ------------------------------------------------------------------ post-mortem
  //
  // WHAT WAS HAPPENING WHEN IT DIED, written down while it is still true.
  //
  // `lastDeath` already said where and to what. It could not say WHY, because the two
  // things that answer why were never joined to it: the text the server sent — which is
  // where "you are hit for 11 damage" and "your sword shatters into pieces" live — and
  // the keeper's own decisions, which is where "gave up the safe spot" lives. Both were
  // being kept, in separate buffers, and neither survived the process.
  //
  // Nothing here is gathered specially. The client already keeps its last 500 events and
  // the keeper already keeps 200 journal entries; this is a join and a file.

  // The last N lines of text the server actually sent us, newest last. `said` is speech,
  // `message` is everything else — combat, refusals, the weapon breaking.
  recentText(limit = 30) {
    const evs = this.s.client?.events || [];
    const out = [];
    for (let i = evs.length - 1; i >= 0 && out.length < limit; i--) {
      const e = evs[i];
      if (e.kind === 'said' && e.text) out.push({ at: e.at, kind: 'said', who: e.name ?? null,
                                                  channel: e.type ?? null, text: e.text });
      else if (e.kind === 'message' && e.text) out.push({ at: e.at, kind: 'message', text: e.text });
    }
    return out.reverse();
  }

  // How fast health was going, in points per second, over the frames we have. Negative
  // means losing. A death at -0.3/s is attrition somebody should have withdrawn from;
  // a death at -4/s was not survivable by fleeing and the mistake was earlier.
  // IS THIS BODY DYING RIGHT NOW? Cheap, allocation-free, no I/O — it is called at the top
  // of every pass.
  //
  // Two conditions, and BOTH are required. Below the flee line alone is an ordinary state
  // that a resting character sits in for minutes; losing health alone is an ordinary fight.
  // Together they are the shape every death in this fleet has: a body under the line with
  // the bar still moving down.
  //
  // `fleeAt` rather than a new number, because inventing a second threshold would mean two
  // answers to "when is this character in trouble" and the keeper already has one.
  mortalDanger() {
    let frac = null, rate = null;
    try { frac = pct(this.s?.client?.vitals?.()?.health); } catch { return null; }
    if (frac === null) return null;
    let fleeAt = null;
    try { fleeAt = this.safety().fleeAt; } catch { return null; }
    if (!(frac < fleeAt)) return null;
    // Over the frame ring, so a single unlucky sample cannot trigger it and a steady
    // grind does. Negative is losing.
    try { rate = this.healthRate(this.recent5 ?? []); } catch { rate = null; }
    if (rate == null || rate >= 0) return null;
    return { frac, fleeAt, rate };
  }

  healthRate(frames) {
    const f = (frames || []).filter(x => x.health != null && x.at);
    if (f.length < 2) return null;
    const dt = (f[f.length - 1].at - f[0].at) / 1000;
    if (dt <= 0) return null;
    return +(((f[f.length - 1].health - f[0].health) / dt).toFixed(2));
  }
  // @end 1
}
