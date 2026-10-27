// HUNT BOOKKEEPING: kills, activity, drop specs, the hunt matcher, blockers, door escapes, health since full.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 10 methods: killsSince, activity, dropSpec, huntMatch, capBlockers, planRecoveryDoorEscape,
//   escapeThroughDoor, searchSafeSpot, trackSinceFull, sinceFullHealth
import { describeCommitment } from '../m59-commitment.mjs';
import { OF, dropSpec as dropSpecFor } from '../m59-parse.mjs';
import { planDoorEscape, recoveryRefugeReach } from '../m59-recovery-refuge.mjs';
import { nearestSafeSpot, reachableFrom } from '../m59-safespots.mjs';
import { creatureByName, huntLabel, huntMatcher, karmaSafe, loadSpawns, roomCap } from '../m59-spawns.mjs';
import { traceRefuge, traceSurvival, traceSurvivalOperation } from '../m59-survival-trace.mjs';
import { sameRoomDoors } from '../m59-world.mjs';
import { SPAWN_FILE, engagementRefusal, lastRoom, snapshotSpotClaims, spotClaimedByAnotherExclusive, spotTakenByAnother } from '../m59-autopilot.mjs';

export class HuntBooksPart {
  // @part 1

  // How many kills inside the last `ms`. Survives a keeper restart no better than the
  // total does — the array lives on the keeper — but the WINDOW is what saves it: a
  // restart five minutes ago and an idle hour both read as a low number, and both mean
  // "this character is not earning right now", which is the same answer.
  killsSince(ms) {
    const from = Date.now() - ms;
    return (this.killTimes || []).filter(t => t >= from).length;
  }

  activity() {
    if (!this.running) return 'stopped';
    // A keeper whose session died keeps looping and keeps reporting whatever it was
    // last doing, which is how twenty-five logged-out characters showed up on the
    // board as sixteen of them holding walls. The loop is running; the character is
    // not there.
    if (!this.s?.live) return 'NOT IN GAME';
    // BEFORE ANYTHING ELSE IT WOULD OTHERWISE CLAIM TO BE DOING. An inert keeper still
    // holds a safe spot, a mode and a hunt, and reporting any of those on the board would
    // say a character is working when something else is walking it across the world.
    if (this.inert) return `inert — ${this.inert.why || 'something else is driving'}`;
    if (this.parking)
      return this.parking.ready
        ? (this.hold ? 'parked behind a wall, ready for the update' : 'parked in the open, ready for the update')
        : 'parking — getting behind a wall before the update';
    if (this.frozenUntil && Date.now() < this.frozenUntil) return 'playing dead';
    if (this.hold) {
      const proven = this.holdWorks() ? 'proven' : 'untested';
      if (this.spotTest) return 'testing a safe spot';
      if (this.doing === 'fighting') return `fighting from a ${proven} safe spot`;
      if (this.doing === 'pulling') return `pulling quarry to a ${proven} safe spot`;
      if (this.doing === 'waiting') return `waiting at a ${proven} safe spot`;
      return `holding a ${proven} safe spot`;
    }
    // One wording for the errand, shared with the commitment the board greys rows on —
    // a character described as "loot run for Rowlf" in one place and "an errand" in the
    // other is two facts where there is one.
    if (this.errand)
      return describeCommitment({ errand: this.errand })?.label ?? 'on an errand';
    if (this.mode === 'idle') return 'idle';
    // Why a healthy character is sitting in an inn. Only while the rung is actually holding —
    // a character working the room it is already in is described by what it is doing.
    if (this.pvpHoldingNow) {
      const pvp = this.pvpReturnHold();
      if (pvp) return `holding off the farm after a PvP death by ${pvp.killer ?? 'a player'} — ` +
                      `${Math.ceil(pvp.remaining_s / 60)}m left`;
    }
    if (this.doing === 'travelling') return 'travelling';
    if (this.doing === 'zoning') return 'changing map';
    if (this.doing === 'trading') return 'trading';
    if (this.doing === 'recovering') return this.climbing ? 'eating to raise vigor' : 'resting';
    if (this.doing === 'pulling') return 'pulling quarry into position';
    if (this.doing === 'waiting') return 'waiting for quarry contact';
    if (this.mode === 'farm') {
      const g = this.farmStrategyGate?.();
      if (g?.blocked) return g.blocked.by === 'requires' ? g.blocked.why : `farm ${g.blocked.why}`;
    }
    if (this.mode === 'farm' && this.policy.hunt) {
      // A ROOM THAT CANNOT PRODUCE THE QUARRY OUTRANKS EVERY OTHER THING THIS LINE CAN SAY,
      // because it is the only one where no pass can ever succeed. "This prey pays nothing" is
      // an argument about value; "there is no prey here" is an argument about arithmetic, and
      // it was the commonest state in the fleet while being the only one with no name.
      const dryRoom = this.huntRoomCheck();
      if (dryRoom?.dry) return `stranded in ${dryRoom.room}: no ${huntLabel(this.policy.hunt)} here`;

      // A keeper earning nothing must not describe itself the same way as one that is.
      // This string is what the fleet board renders, and it is where the afternoon of
      // worthless grinding would have been visible had there been anything to see.
      const y = this.yieldCheck();
      if (!y || y.paying) return `hunting: ${huntLabel(this.policy.hunt)}`;
      // FINISHED IS NOT THE SAME FAILURE AS FUTILE, and rendering them with one string
      // would undo the point of the check. A character whose list is complete has done
      // what it was sent to do and wants re-tasking; one grinding prey that can never
      // drop what it needs is burning an afternoon. Both are "not paying"; only the
      // second is bad news.
      return y.done
        ? `hunting: ${huntLabel(this.policy.hunt)} — list complete, nothing left to fetch`
        : `hunting: ${huntLabel(this.policy.hunt)} — PAYS NOTHING for ${this.policy.purpose}`;
    }
    return this.stalledSince ? `stuck: ${this.stalledWhy}` : 'waiting';
  }

  // DROPPING A STACK NEEDS THE QUANTITY, or the server refuses and says nothing useful.
  //
  // The cost was not one item. makeRoom returns from the pass as soon as it has "made
  // room", so a character whose overflow was a stack dropped nothing, stayed over the
  // limit, and returned at the top of every pass for ever. Beaker did it 14 passes
  // running -- "bags full - dropped red mushroom x20", still carrying 15 of 14 -- and
  // never reached the hunting code at all.
  //
  // The rule itself now lives beside encodeIdList in m59-parse.mjs, because this was the
  // third copy of it and the fourth site -- the broker's `act` -- had no copy at all and
  // was still sending bare ids. See dropSpec there for what the server actually does.
  dropSpec(o, want = null) { return dropSpecFor(o, want); }

  // "IS THIS THING WHAT WE WERE SENT FOR" — ONE ANSWER, FOR EVERY PLACE THAT ASKS.
  //
  // Five places asked it and four of them spelt it `name.includes(hunt)`: the in-room
  // prey check, capBlockers twice, the bystander test, and findCreature. `ant` therefore
  // sent a keeper to rooms full of giANT rats, and yieldCheck — which had already been
  // fixed to prefer an exact name — was judging a creature the character was not
  // fighting. Every one of those is the same question, so it goes through the same
  // resolution: see huntMatcher in m59-spawns.mjs for why an exact answer wins outright
  // and why the substring family survives for `soldier`.
  //
  // Cheap enough for the hot path: loadSpawns is cached on mtime, and the catalogue is
  // resolved once here and then asked per object.
  huntMatch(want = this.policy.hunt) {
    return huntMatcher(loadSpawns(SPAWN_FILE), want);
  }

  // THE ROOM HAS FILLED UP WITH THINGS WE DECLINED TO KILL.
  //
  // The cap is a room-wide TOTAL (monsroom.kod:242) and the generator is gated on it
  // before it rolls the table at all, so ignoring a creature does not leave more room
  // for the one you want — it leaves less. A fleet hunting centipedes and stepping over
  // baby spiders ends up in a room of baby spiders and then a room of nothing.
  //
  // AND LEAVING DOES NOT FIX IT. This is the part that reads backwards: LastUserLeft
  // (monsroom.kod:353) starts the 3-minute reload timer ONLY when piMonster_count = 0,
  // and otherwise just deletes the generation timer. The comment says why — "to prevent
  // endless exp boosting" — the game is deliberately stopping you from resetting a room
  // by walking out of it. A room abandoned while full stays full, with the generator
  // switched off, for as long as nobody kills anything in it.
  //
  // So clearing is not an optimisation, it is the only mechanism. Leaving is what you do
  // when you CANNOT clear, and it should be understood as giving the room up rather than
  // as resetting it.
  capBlockers(room) {
    const c = this.s.client;
    const spawns = loadSpawns(SPAWN_FILE);
    const cap = roomCap(spawns, room?.num);
    if (!cap || !c?.room) return null;
    const mons = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
    const present = mons.length;
    const want = this.policy.hunt || null;
    const isPrey = want ? huntMatcher(spawns, want) : null;
    const preyPresent = isPrey
      ? mons.filter(o => isPrey(c.rsc.get(o.nameRsc) || '')).length : 0;
    const status = { cap, present, prey_present: preyPresent,
                     full: present >= cap, clearable: [], blocked: [] };
    if (!status.full) return status;

    const level = c.vitals?.()?.health?.max ?? 0;
    const ceiling = this.threatCeiling();
    const seen = new Set();
    for (const o of mons) {
      const name = c.rsc.get(o.nameRsc) || '';
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      if (isPrey?.(name)) continue;                      // our prey is not a blocker
      const info = creatureByName(spawns, name);
      const lvl = info?.level ?? null;
      const politicalTroop = info?.political_troop === true;
      const count = mons.filter(m => (c.rsc.get(m.nameRsc) || '').toLowerCase() === key).length;
      const row = { name, level: lvl, karma: info?.karma ?? null, count };
      // The two exceptions, and they are genuinely different. Karma is a decision the
      // owner made about what this character is; danger is a fact about the room.
      // A CREATURE WE HAVE NEVER HEARD OF IS DANGEROUS, NOT SAFE.
      //
      // `lvl` is null whenever the spawn table has no row for the name, and the level
      // test was written as `lvl != null && lvl > ceiling` — so an unknown creature
      // skipped the test and fell straight through to clearable. The table holds 120
      // creatures and exactly one faction soldier ("rebel soldier", level 50); there is
      // no row for "soldier of the Duke's army", so a level-27 character with a safety
      // band of 33 looked at three of them and decided to clear the room.
      //
      // That is the same shape as every other silent default in this tree: the absence
      // of information read as permission. Faction soldiers are the worst possible thing
      // to guess about — the Duke's soldiers alone account for 155 kills in the Tos
      // death record and appear in deaths that happened inside APPROVED safe squares.
      //
      // Judge through the same rating-aware predicate retaliation uses. The former
      // fallback applied even when a gentle rating was known, making this path disagree
      // with refuseEngagement() and huntingGrounds() about the same creature.
      const refused = engagementRefusal(info, { name, ceiling });
      if (!karmaSafe(info?.karma, this.policy.karma)) {
        status.blocked.push({ ...row, why: `killing it moves karma the wrong way for a ` +
                                            `${this.policy.karma} character (its karma is ${info?.karma})` });
      } else if (politicalTroop) {
        // AND THIS ONE IS AHEAD OF THE DANGER TEST ON PURPOSE. `engagementRefusal`
        // forgives anything with a gentle rating, and a troop rolls its level and
        // difficulty at creation (troop.kod:215) — so the weakest roll can come out
        // gentle and be cleared for slot-freeing. Attackability permits an initiated
        // swing; it does not make a political actor housekeeping prey.
        status.blocked.push({ ...row, rating: info?.attack_rating ?? null,
          why: 'political faction troop; attackability permits an initiated swing but does not ' +
               'prove aggression, so it is never incidental room-clearing prey' });
      } else if (refused) {
        status.blocked.push({ ...row, rating: refused.rating, why: refused.why });
      } else {
        status.clearable.push({ ...row, rating: info?.attack_rating ?? null });
      }
    }
    // Most numerous first: the point is to free slots, and eight of one thing is where
    // the slots are.
    status.clearable.sort((a, b) => b.count - a.count);
    status.blocked.sort((a, b) => b.count - a.count);

    // SHOULD WE ACTUALLY STOP AND CLEAR, or just get on with hunting?
    //
    // The first version only asked when NO prey was in the room, and that was wrong in
    // the exact case it was written for. East Merchant Way was 8 baby spiders to 2
    // centipedes at a cap of 10: prey WAS present, so the keeper hunted the two and never
    // touched the eight, and the moment it killed them the generator refilled at 65%
    // spiders. The room degrades to all-spiders whatever you do, one kill at a time.
    //
    // So the trigger is composition, not absence. A full room where the things we will
    // not hunt outnumber the things we will is a room going the wrong way, and the only
    // move that reverses it is killing them.
    const blockerCount = status.clearable.reduce((a, b) => a + b.count, 0);
    status.should_clear = status.clearable.length > 0
      && (preyPresent === 0 || blockerCount > preyPresent);
    status.why_clear = !status.should_clear ? null
      : preyPresent === 0
        ? `the room is at ${present}/${cap} and none of it is what we hunt`
        : `${blockerCount} of the ${present} here are not our prey and only ${preyPresent} ` +
          `are — at cap that composition only gets worse`;
    return status;
  }

  // ONE ATTEMPT AT FINDING A SQUARE, at a given tolerance for sharing.
  //
  // Extracted from takeSafeSpot only so the search can be re-run at a higher share cap
  // without duplicating the option block — a second copy of these arguments is exactly
  // how the two would come to disagree about `los` or the book.
  // WHICH INTERNAL DOOR TO LEAVE BY WHEN THIS SIDE HAS NO WALL. Pure planning — see
  // planDoorEscape for the incident and the rule. The far-side wall is found with the same
  // recovery selector as any other (unoccupied, exclusive, a route that avoids bodies), only
  // asked from the landing square instead of from here.
  planRecoveryDoorEscape(geo, me, room, { within, los = 0 } = {}) {
    const doors = sameRoomDoors(room);
    if (!doors.length || !geo || !me) return { escape: null, counts: { doors: 0 } };
    const s = this.s;
    return planDoorEscape({
      doors,
      component: reachableFrom(geo, me),
      reach: recoveryRefugeReach(geo, me, s.client?.room?.objects, s.client?.selfId,
        s.client?.playersOnline),
      farRefuge: landing => {
        const spot = this.searchSafeSpot(geo, landing, room, { within, los, quarry: null,
          recovery: true, exclusiveClaim: true, shareCap: 1, stats: {} });
        return spot ? { spot, steps: spot.steps_away } : null;
      },
    });
  }

  // Cross it. Returns {crossed} / {cancelled} / {why}; the caller searches again from the
  // landing, because the plan's far-side wall was chosen from a square we were not on.
  async escapeThroughDoor(why, geo, me, room, { within, los, movementGeneration, interrupted }) {
    const s = this.s;
    let plan;
    try { plan = this.planRecoveryDoorEscape(geo, me, room, { within, los }); }
    catch (e) { return { why: 'internal-door escape could not be planned: ' + e.message }; }
    traceSurvival(s, 'refuge_door_planned', { escape: plan.escape ? {
      door: { row: plan.escape.door.row, col: plan.escape.door.col },
      landing: plan.escape.landing, refuge: traceRefuge(plan.escape.refuge),
      steps_to_door: plan.escape.steps_to_door, steps_beyond: plan.escape.steps_beyond,
    } : null, counts: plan.counts });
    if (!plan.escape) {
      if (!plan.counts?.doors) return {};
      return { why: `no internal door leads to a free wall (doors ${plan.counts.doors}, ` +
        `on this side ${plan.counts.on_our_side}, to new ground ${plan.counts.onto_new_ground}, ` +
        `clear to walk ${plan.counts.in_reach}, with a wall beyond ${plan.counts.with_refuge})` };
    }
    const { door, landing, refuge } = plan.escape;
    if (typeof s.crossSameRoomDoor !== 'function')
      return { why: 'this session cannot take an internal door' };
    if (this.hold) this.releaseHold('leaving through an internal door to a wall on the far side');
    this.doing = 'escaping through an internal door';
    this.note('no wall on this side — leaving through an internal door', {
      why, room: room.num,
      door: { col: door.col, row: door.row }, lands: { col: landing.col, row: landing.row },
      wall_beyond: { col: refuge.col, row: refuge.row },
      steps_to_door: plan.escape.steps_to_door, steps_beyond: plan.escape.steps_beyond,
      note: 'monsters cannot operate a same-room door, so crossing it ends the attack the way ' +
            'leaving the room does; the wall over there is where to heal',
    });
    const result = await traceSurvivalOperation(s, 'refuge_door_crossing', {
      door: { row: door.row, col: door.col }, landing,
    }, () => s.crossSameRoomDoor(door, { movementGeneration }))
      .catch(e => ({ crossed: false, reason: e.message }));
    this.movedAt = Date.now();
    if (result?.cancelled || interrupted?.()) return { cancelled: true };
    if (!result?.crossed) {
      // Not remembered as failed: a body that stood on the door square for a second is the
      // commonest reason, and trying the one way out again next pass is still an action.
      return { why: 'internal-door escape did not complete: ' + (result?.reason ?? 'no reason given') };
    }
    return { crossed: true, at: result.at };
  }

  searchSafeSpot(geo, me, room, { within, quarryReach, strictQuarryReach = false,
                                  los, quarry, stats, shareCap = 1, nearQuarry = false,
                                  exclusiveClaim = false, onward = null, forwardBias = 1,
                                  wallsAllowed = true, recovery = false, candidateFilter = null,
                                  maxApproachSteps = Infinity }) {
    const s = this.s;
    // One room search can inspect hundreds of candidate squares. Reading the shared
    // claim directory for every candidate would turn that into hundreds of lock/file
    // round-trips, so take one coherent snapshot for this selector. An atomic claim after
    // selection catches the only race a snapshot can leave, and its retry takes a fresh one.
    const spotClaims = snapshotSpotClaims();
    const recoveryReach = recovery ? recoveryRefugeReach(geo, me,
      s.client?.room?.objects, s.client?.selfId, s.client?.playersOnline) : null;
    return nearestSafeSpot(geo, me, {
      wallsAllowed, fineRecovery: recovery,
      // WHAT MAKES A SQUARE A CANDIDATE. `wall` asks for a wall to stand against and
      // ranks by how much of it there is; `disc` is the old attackers_avoided >= 20
      // gate, kept so the two can be compared rather than swapped on faith. See
      // SPOT_RULES — the disc threshold turned out to sit in a trough in the book, and
      // most of the evidence that put it there was written by a bug in restBroken.
      //
      // `los` still controls the wall's exposure model. Quarry connectivity is deliberately
      // coarse: that is the movement grid used by the production monsters.
      within, rule: this.policy.spotRule ?? 'wall', minAvoided: 20,
      // Retained in the legacy value for non-target/tie ranking. closestToToward below is
      // the hard primary order whenever a quarry exists.
      fromFightWeight: nearQuarry ? 3 : 0.3,
      // THE LEDGER IS NOT CONSULTED ABOUT WALLS. Operator, 2026-09-10: "do *not* consult the
      // safe spot ledger regarding safe walls, use the formula". It never decided CANDIDACY --
      // `safeWalls` does that from the two grids disagreeing -- but it ranked them, so a square
      // the geometry likes could be ordered behind one the book had merely seen work. A wall
      // that held before is not a wall that holds now: room 39 has 132 squares tested and zero
      // that held without later failing, 78% of the failures being the fleet crowding onto its
      // own shelter. Ordering is now geometric, which is the same authority as selection.
      book: null, room: room.num, quarryReach, strictQuarryReach, los,
      // Combat chooses the quarry first. Once eligibility is established, its distance
      // is the primary order; proof and defensibility only break equal-distance ties.
      closestToToward: !!quarry,
      onward, forwardBias,
      // The same exclusion the other three selectors apply — a wall we have just failed
      // to walk to is not a candidate, whichever rung is asking for one.
      // Recovery and pull combat use literal occupancy. A body beside a safe wall
      // need not block the actual route into it; the recovery path check decides that.
      unreachable: this.spotExclusions(room.num, { playerRadius: quarry || recovery ? 0 : 1 }),
      stats,
      toward: quarry ? { col: quarry.col, row: quarry.row } : null,
      // Skip squares already at the share cap, and squares nothing can be fetched to.
      // Both are expressed as "unreachable" because that is the question the ranking
      // already asks, and neither is worth a second mechanism.
      reach: (col, r2) => {
        if (candidateFilter && !candidateFilter(col,r2))
          return {reachable:false,reason:'outside the blocker retreat plan'};
        const claimed = exclusiveClaim
          ? spotClaimedByAnotherExclusive(this.s.name, room.num, col, r2, spotClaims)
          : spotTakenByAnother(this.s.name, room.num, col, r2, shareCap, spotClaims);
        if (claimed)
          return { reachable: false, reason: 'occupied at this share cap' };
        const route = recoveryReach ? recoveryReach(col,r2) : s.world.reach(col,r2);
        if (route?.reachable && Number.isFinite(route.steps) && route.steps > maxApproachSteps)
          return {reachable:false,reason:'longer exposed approach while under pressure'};
        return route;
      },
    });
  }

  // ONE FRAME. Extracted from the pass so a JOURNEY CAN LEAVE A TRAIL.
  //
  // Frames were written once per pass and nowhere else, and travel is a single await
  // INSIDE a pass — so a character that set off across four rooms and died on the way
  // recorded nothing between the room it left and the Underworld. The post-mortem then
  // reconstructed the death from "the last frame that was not the Underworld", which was
  // the room it had left minutes earlier.
  //
  // Janice is the worked example: her record says she died in the Brownestone Inn at
  // 30/30 health, with `threats: 0`. Her last decision there was "this room cannot
  // produce our prey — leaving now, going to Valley of Ileria", and 92 seconds later a
  // frogman killed her. Inns have no frogmen and nobody dies at full health; every field
  // in that record was true about somewhere she was no longer standing.
  //
  // 16% of attended records show full health at death, which is this shape.
  //
  // `why` is kept on the frame so the trail says what it is: a frame written because we
  // arrived somewhere is a different observation from the pass's regular sample, and a
  // reader that cannot tell them apart will read a travel trail as a stall.
  // WHAT THE BODY HAS DONE SINCE IT WAS LAST WHOLE.
  //
  // Health falling is the easy half and every instrument here already has it. The question
  // that matters while it falls is what the character is DOING about it, and the honest
  // answer is not a position or a heading — it is whether the moving is going anywhere.
  //
  // So the number this exists for is PATH against NET. A character that walked forty squares
  // and ended two from where it started is not travelling, it is dithering — and that is
  // indistinguishable from good progress in every other reading we have, because both show
  // movement, both reset a stillness timer, and both burn the same seconds. The 22<->23
  // oscillation, the drag along a wall back out the entrance, the two-square shuffle that
  // reset every stall detector it met: all of them are a low ratio here and nothing else.
  //
  // Reset by being FULL rather than on a timer, because the interesting window is exactly
  // one bleed. Once whole there is nothing to review.
  trackSinceFull(at, hp) {
    const value = hp?.value ?? null, max = hp?.max ?? null;
    if (value === null || max === null || !(max > 0)) return;
    if (value >= max) { this.sinceFull = null; return; }

    const f = this.sinceFull;
    if (!f || f.room == null) {
      this.sinceFull = {
        at: at.at, room: at.room, col: at.col, row: at.row,
        anchorCol: at.col, anchorRow: at.row,
        healthFrom: value, max, path: 0, roomChanges: 0,
        rooms: [at.room], lastCol: at.col, lastRow: at.row,
        low: value, safeSpotAt: null, doing: at.doing ?? null,
      };
      return;
    }

    // ACROSS A ROOM BOUNDARY, DISTANCE IN SQUARES IS MEANINGLESS — the coordinate system
    // starts again. A room change is progress of a different kind and is counted as its own
    // thing, and the net anchor restarts so the ratio describes THIS room's walking.
    if (at.room !== f.lastRoom && at.room !== f.rooms[f.rooms.length - 1]) {
      f.rooms.push(at.room);
      if (f.rooms.length > 24) f.rooms.shift();
      f.roomChanges++;
      f.anchorCol = at.col; f.anchorRow = at.row;
    } else if (Number.isFinite(at.col) && Number.isFinite(f.lastCol)) {
      const d = Math.hypot(at.col - f.lastCol, at.row - f.lastRow);
      // A sample that did not move adds nothing; a teleport is not walking either.
      if (d > 0 && d < 12) f.path += d;
    }
    f.lastRoom = at.room; f.lastCol = at.col; f.lastRow = at.row; f.lastAt = at.at;
    f.low = Math.min(f.low ?? value, value);
    f.doing = at.doing ?? f.doing;
    // WHETHER IT GOT WHERE IT WAS TRYING TO GO. On a journey while taking damage, reaching a
    // wall IS the correct outcome, so the time from the first drop to the shelter is the
    // number worth having — and a null here after a long bleed is its own finding.
    if (f.safeSpotAt === null && /safe spot|shelter|resting/i.test(String(at.doing ?? '')))
      f.safeSpotAt = at.at;
  }

  /** The reviewable summary, for `status` and for the ladder trace. Null while whole. */
  sinceFullHealth() {
    const f = this.sinceFull;
    if (!f) return null;
    // MEASURED BETWEEN OBSERVATIONS, NOT AGAINST THE WALL CLOCK. The window is first drop to
    // last sample, and every number derived from it — the rate above all — has to divide by
    // the time actually watched. `Date.now()` would keep the denominator growing through any
    // gap in sampling, so a keeper that stopped pulsing would report a bleed slowing down at
    // exactly the moment it stopped being able to see one.
    const now = f.lastAt ?? f.at;
    const secs = Math.max(0, Math.round((now - f.at) / 1000));
    const net = Number.isFinite(f.lastCol) && Number.isFinite(f.anchorCol)
      ? Math.hypot(f.lastCol - f.anchorCol, f.lastRow - f.anchorRow) : null;
    const lost = f.healthFrom - (f.low ?? f.healthFrom);
    return {
      for_s: secs,
      health_from: f.healthFrom, health_low: f.low, of_max: f.max,
      losing_per_s: secs > 0 ? Math.round((lost / secs) * 100) / 100 : null,
      rooms: [...f.rooms],
      room_changes: f.roomChanges,
      squares_walked: Math.round(f.path * 10) / 10,
      net_from_start_of_this_room: net === null ? null : Math.round(net * 10) / 10,
      // THE ONE TO READ. 1.0 is a straight line; near 0 is a body moving and getting
      // nowhere, which is what every dithering bug in this repository has looked like.
      // Null rather than a fabricated 0 when nothing has been walked yet.
      progress_ratio: f.path > 0 && net !== null ? Math.round((net / f.path) * 100) / 100 : null,
      reached_shelter_after_s: f.safeSpotAt === null ? null
        : Math.max(0, Math.round((f.safeSpotAt - f.at) / 1000)),
      doing: f.doing ?? null,
    };
  }
  // @end 1
}
