#!/usr/bin/env node
// m59-bt-flee.mjs -- behavior-tree nodes for the keeper's flee/rest pass.
//
// Decomposes the ~650-line sequential passFleeAndRest() into a tree of
// small, testable nodes. Each node has a clear precondition and a single
// effect. The tree is ticked in priority order (selector): the highest-
// priority concern that applies this pass wins.
//
// Priority order (highest first):
//   1. doomed         -- below 2 hits with something adjacent
//   2. flee_threshold -- below fleeBelow with something adjacent
//   3. sanctuary_settle -- arrived at safe room, not at full
//   4. get_a_wall     -- hurt in combat/spawn zone, no wall
//   5. vigor_walk     -- hurt, combat zone, too much vigor for waiting
//   6. leave_room     -- health below retreat line, combat zone, no wall
//   7. rest           -- safe to sit down, heal and recover
//
// Each node is a factory: it takes a keeper reference and returns a BT node.
// The blackboard (bb) carries the live session state, refreshed by
// updateBlackboard() before each tick.
//
// No broker, no I/O -- the nodes call keeper methods that do the I/O.

import {
  Selector, Sequence, Condition, Action,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';
import { updateBlackboard } from './m59-bt-nodes.mjs';
import { lootRecoveryNode } from './m59-bt-recover.mjs';

// ---------------------------------------------------------------------------
// Helper: read vitals from the blackboard
// ---------------------------------------------------------------------------

function vitals(bb) {
  return bb.session?.s?.client?.vitals?.() ?? {};
}
function hpFrac(bb) {
  const v = vitals(bb);
  return v.health?.max ? v.health.value / v.health.max : null;
}
function vigorOf(bb) {
  const v = vitals(bb);
  return v.vigor?.value ?? null;
}

// ---------------------------------------------------------------------------
// AsyncAction (same pattern as m59-bt-farm.mjs)
// ---------------------------------------------------------------------------

class AsyncAction {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `aa_${Math.random().toString(36).slice(2, 10)}`;
    this._name = opts.name || 'AsyncAction';
  }
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.done) { delete bb._bt[this.key]; return slot.result; }
    if (slot && slot.promise) return RUNNING;
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      bb._bt[this.key] = { promise: p, done: false, result: null };
      p.then(r => { bb._bt[this.key].done = true; bb._bt[this.key].result = r; },
             e => { bb._bt[this.key].done = true; bb._bt[this.key].result = FAILURE; });
      return RUNNING;
    }
    return p ?? FAILURE;
  }
  async tickAsync(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.promise) {
      try {
        const result = await slot.promise;
        delete bb._bt[this.key];
        return result;
      } catch {
        delete bb._bt[this.key];
        return FAILURE;
      }
    }
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      try { return await p; } catch { return FAILURE; }
    }
    return p ?? FAILURE;
  }
}

const asyncAction = (fn, opts) => new AsyncAction(fn, opts);

// ---------------------------------------------------------------------------
// Node: doomed (below 2 hits with something adjacent)
// ---------------------------------------------------------------------------

export function doomedNode(keeper) {
  return asyncAction(async (bb) => {
    const c = bb.client;
    const me = c.self;
    const near = keeper._btFleeNear();
    const hp = hpFrac(bb);
    const v = vitals(bb);

    if (!me || !near.length || hp === null) return FAILURE;

    const worstHit = Math.min(30, Math.floor(((v.health?.max ?? 0) + 2) / 3));
    const sheltered = keeper.holdWorks();
    const doomedAt = keeper.hold
      ? Math.round((v.health?.max ?? 0) * (keeper.policy.doomedInSpotBelow ?? 0.35))
      : worstHit * 2;

    if (v.health?.value == null || v.health.value > doomedAt) return FAILURE;

    // ONE ANSWER, NO BRANCH ON SHELTER. Operator, 2026-09-10: "implement fall throughs to the
    // singular correct behavior... the preexisting play_dead() -- it is universally the best
    // survival mechanism available... There is truly only one way: The play_dead."
    //
    // THIS NODE USED TO FORK THREE WAYS and two of them ran. Sheltered it played dead, and on a
    // refusal it abandoned the spot and ran for a town; unsheltered it went straight to the town
    // run, on the note "a freeze recovers no health and leaves us exactly where we were". Both
    // runs are dozens of seconds of being hit on the way out, through the rooms that were
    // already killing us. The logoff stops the attack at once.
    //
    // The sequential ladder in m59-autopilot.mjs was collapsed the same way in the same commit;
    // the two halves of this decision have disagreed before (that is what m59-fleeline-test
    // exists for) and the point of doing both at once is that they cannot.
    const wall = keeper.wallHere?.() ?? null;
    const result = await keeper.playDead(
      'at ' + v.health.value + ' health with ' + near.length + ' adjacent' +
      (wall?.ok ? ', behind a wall the geometry confirms'
                : ', in the open -- the logoff is what stops the attack')
    ).catch(() => false);
    if (result) return SUCCESS;

    // playDead now declines in only one state: we have already frozen here and not yet acted,
    // so freezing again would clear PFLAG_MOVED_SINCE_ENTRY and undo the healing the last one
    // bought. There is nothing better to reach for, and FAILURE is what lets the rest of the
    // tree run -- specifically `leave_room`, which crosses an exit and is real movement rather
    // than a walk across a monster room. Returning SUCCESS here would claim the tick and
    // pre-empt it, which is issue #51 in a different shape.
    keeper.note('cannot freeze again yet -- letting the tree reach the exit', {
      health: v.health.value, adjacent: near.length,
      wall_here: wall ? { attackers: wall.attackers, ok: wall.ok } : null,
      why: 'the logoff is the only thing that stops an attack outright and it has just been ' +
           'used here; the exit is the next real move, not a walk to a town',
    });
    return FAILURE;
  });
}
// ---------------------------------------------------------------------------
// Node: flee_threshold (below fleeBelow with something adjacent)
// ---------------------------------------------------------------------------

export function fleeThresholdNode(keeper) {
  return asyncAction(async (bb) => {
    const hp = hpFrac(bb);
    const near = keeper._btFleeNear();
    const hostiles = keeper._btFleeHostiles?.() || [];
    const sheltered = keeper.holdWorks();
    const atWall = !!keeper.hold;   // any hold, proven or not

    // Below the flee threshold with something near: run or mulligan.
    // Below the flee threshold with nothing near but hostiles in the room:
    // the room is contested and healing in place is not safe.
    const threat = near.length > 0 ? near : (hostiles.length > 0 ? hostiles : []);
    if (hp === null || hp >= keeper.policy.fleeBelow || !threat.length) return FAILURE;

    if (!atWall) {
      // NO WALL IS NOT A REASON TO RUN. IT IS THE REASON TO LOG OFF.
      //
      // This node used to say "distance is the only thing that stops this" and call
      // `retreatToSafety`, which returns `{arrived:false}` whenever `retreat_to_inn` is off --
      // and it has been off on this fleet since 2026-08-27, so the strategy was decorative. Four
      // deaths came of it, every one with nought squares moved (issue #51).
      //
      // Operator, 2026-09-10: "never resting in the open: use SAFE WALLS, and log out/in if the
      // danger is immediate". Below the flee line with something adjacent IS immediate.
      const wall = keeper.wallHere?.() ?? null;
      const froze = await keeper.playDead(
        'below the flee line at ' + Math.round(hp * 100) + '% with ' + threat.length +
        ' on us, and no wall here'
      ).catch(() => false);
      if (froze) {
        keeper.tally.logoffs = (keeper.tally.logoffs || 0) + 1;
        return SUCCESS;
      }
      // Same reasoning as the doomed node: FAILURE lets `leave_room` have the tick, and
      // crossing an exit is the one movement that actually breaks contact.
      keeper.note('below the flee line, cannot freeze again -- leaving it to the exit node', {
        health: Math.round(hp * 100) + '%',
        from: threat.map(o => bb.client.rsc.get(o.nameRsc)),
        wall_here: wall ? { attackers: wall.attackers, ok: wall.ok } : null,
        why: 'deciding to run is not running; the exit is the only move that breaks contact',
      });
      return FAILURE;
    }
    // At a wall (proven or not): the wall is blocking at least one direction.
    // Only run if critically low (below 20%) or the wall is not proven AND
    // there are multiple attackers (the wall can't block them all).
    const critical = hp < 0.2;
    const unprovenCrowd = !sheltered && threat.length >= 2;
    if (critical || unprovenCrowd) {
      keeper.note(critical ? 'safe spot is not enough at this HP -- running'
                            : 'unproven wall with multiple attackers -- running', {
        health: Math.round(hp * 100) + '%',
        crowd: threat.length,
        where: { col: keeper.hold.col, row: keeper.hold.row },
        proven: sheltered,
        why: critical ? 'a proven spot holds against normal hits, but below 20% the margin is '
                        + 'gone -- one more hit and we are dead, and resting here is not safe'
                      : 'an unproven wall with two or more attackers is not a wall -- '
                        + 'they get around it, and the character is taking hits from both sides',
      });
      // THE WALL NOT BEING ENOUGH IS THE LOGOFF'S CASE, NOT A REASON TO RUN.
      //
      // This called `retreatToSafety`, which returns `{arrived:false}` whenever `retreat_to_inn`
      // is off -- and it has been off since 2026-08-27, so on this fleet the strategy has never
      // once moved a body. Both notes above end in "-- running" and nothing ran.
      //
      // Note also what "unproven" meant here: proven-by-the-BOOK. The operator retired that
      // question on 2026-09-10 -- "do *not* consult the safe spot ledger regarding safe walls, use
      // the formula" -- so whether the wall holds is asked of the geometry, and whether to log
      // off does not depend on the answer.
      const froze = await keeper.playDead(
        (critical ? 'below 20% behind a wall -- the margin is gone'
                  : 'multiple attackers and this wall is not holding them') +
        ' at ' + Math.round(hp * 100) + '% with ' + threat.length + ' on us'
      ).catch(() => false);
      if (froze) {
        keeper.tally.logoffs = (keeper.tally.logoffs || 0) + 1;
        return SUCCESS;
      }
      keeper.note('the wall is not enough and we cannot freeze again -- leaving it to the exit', {
        health: Math.round(hp * 100) + '%', crowd: threat.length,
        why: 'a refusal from playDead means we froze here and have not acted since; the exit ' +
             'node is the only thing left that moves the body out of contact',
      });
      return FAILURE;
    }

    // SHELTERED AND ABOVE CRITICAL: LOG OFF. This used to break off without moving.
    //
    // Operator, 2026-09-10: "the logoff trick makes the enemy immediately stop attacking,
    // waiting and hoping can let the enemy continue attacking for up to dozens of seconds",
    // and then: make this "identical to play_dead, such that there's no real point in having
    // flee_below".
    //
    // The old note's reasoning was that a spot which has held means "nothing can hit us
    // unless we swing first". `sheltered` is a wall the BOOK has confirmed, and the book
    // records room 39 with 132 squares tested and ZERO that held without later failing — so
    // it means the wall held BEFORE, not that it is holding now. Standing still bets on that
    // difference; the logoff does not, and on a wall that does hold it heals to full because
    // the character turns in place to re-arm regeneration.
    //
    // The ladder in m59-autopilot.mjs was changed the same way in the same commit. Both paths
    // reach for the same verb in the same state, because two survival paths that disagree is
    // how this fleet gets a decision that is correct on every pass and still fatal.
    keeper.tally.mulligans = (keeper.tally.mulligans || 0) + 1;
    if (await keeper.playDead(`at ${Math.round(hp * 100)}% with ${threat.length} adjacent, ` +
                              'behind a wall that holds').catch(() => false)) return SUCCESS;
    // playDead refused, which means the spot is no longer one that holds. Do NOT fall back to
    // standing still — that is the case the operator objected to, at its most dangerous. The
    // tick belongs to whichever node below can still move the body.
    return FAILURE; // fall through to rest
  });
}

// ---------------------------------------------------------------------------
// Node: sanctuary_settle (arrived at safe room, not at full)
// ---------------------------------------------------------------------------

export function sanctuarySettleNode(keeper) {
  return asyncAction(async (bb) => {
    const room = bb.room;
    const hp = hpFrac(bb);
    const v = vitals(bb);
    const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max : 1;

    if (!keeper.sanctuary(room) || keeper.settledIn === room?.num) return FAILURE;
    if (hp !== null && hp >= 0.95 && vigPct >= 0.4) return FAILURE;

    await keeper.settle('arrived somewhere safe and not at full strength').catch(() => {});
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: get_a_wall (hurt in combat/spawn zone, no wall)
// ---------------------------------------------------------------------------

export function getAWallNode(keeper) {
  return asyncAction(async (bb) => {
    const c = bb.client;
    const hostiles = keeper._btFleeHostiles();
    const hp = hpFrac(bb);
    const v = vitals(bb);
    const sheltered = keeper.holdWorks();
    const near = keeper._btFleeNear();

    if (!keeper.policy.useSafeSpots || keeper.hold) return FAILURE;
    if (sheltered) return FAILURE;
    if (hostiles.length === 0) return FAILURE;

    // Check cooldown
    if (keeper.wallTriedAt && Date.now() - keeper.wallTriedAt < 30_000) return FAILURE;

    const combatZone = hostiles.length > 0;
    const spawnsHere = !keeper.sanctuary();
    const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max : 1;
    const REST_VIGOR_CAP = 0.4;
    const restAt = Math.max(
      keeper.policy.restBelow,
      0,
      keeper.recoverUntilWhole && !keeper.recovered() ? 1 : 0,
      keeper.mode === 'farm' && keeper.policy.hunt && !keeper.recoverUntilWhole && keeper.armed()
        ? keeper.safety().engageAt : 0
    );
    const vigorRestAt = Math.min(keeper.policy.restBelow, REST_VIGOR_CAP);
    const hurt = (hp !== null && hp < restAt) || (vigPct !== null && vigPct < vigorRestAt);

    if (!hurt) return FAILURE;
    if (!combatZone && !spawnsHere) return FAILURE;

    keeper.wallTriedAt = Date.now();
    const got = await keeper.takeSafeSpot(
      'hurt in a room that spawns monsters -- a wall before a rest',
      near[0] ?? hostiles[0] ?? null
    ).catch(() => false);
    keeper.note('will not rest in the open here', {
      health: hp === null ? null : Math.round(hp * 100) + '%',
      monsters_in_room: hostiles.length,
      adjacent: near.length,
      got_a_wall: !!got,
      room_spawns: spawnsHere,
      why: 'resting is sitting still and not looking. Doing it where something can reach us is ' +
           'how a rest becomes a death, and an empty room that spawns is a room between spawns',
    });
    return FAILURE; // fall through to rest (the wall is a side effect)
  });
}

// ---------------------------------------------------------------------------
// Node: vigor_walk (hurt, combat zone, too much vigor for waiting)
// ---------------------------------------------------------------------------

export function vigorWalkNode(keeper) {
  return asyncAction(async (bb) => {
    const hostiles = keeper._btFleeHostiles();
    const hp = hpFrac(bb);
    const v = vitals(bb);
    const sheltered = keeper.holdWorks();
    const vigorNow = vigorOf(bb);
    const REST_VIGOR_CAP = 0.4;
    const VIGOR_MAX = 200;
    const restCeiling = REST_VIGOR_CAP * VIGOR_MAX; // 80

    if (!hostiles.length || sheltered || keeper.hold) return FAILURE;
    if (vigorNow == null || vigorNow <= restCeiling) return FAILURE;

    const restAt = Math.max(
      keeper.policy.restBelow,
      0,
      keeper.recoverUntilWhole && !keeper.recovered() ? 1 : 0,
      keeper.mode === 'farm' && keeper.policy.hunt && !keeper.recoverUntilWhole && keeper.armed()
        ? keeper.safety().engageAt : 0
    );
    const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max : 1;
    const vigorRestAt = Math.min(keeper.policy.restBelow, REST_VIGOR_CAP);
    const hurt = (hp !== null && hp < restAt) || (vigPct !== null && vigPct < vigorRestAt);

    if (!hurt) return FAILURE;

    keeper.note('not waiting this out -- moving to somewhere I can heal', {
      health: hp === null ? null : Math.round(hp * 100) + '%',
      vigor: vigorNow,
      rest_ceiling: restCeiling,
      monsters_in_room: hostiles.length,
      why: 'hurt, no wall here, and too much vigor for waiting to be worth anything -- resting ' +
           'cannot raise vigor past ' + restCeiling + ' and we are already above it, so the ' +
           'only thing standing still produces is time spent hurt in a monster room',
    });
    // SAME RUNG AS THE SEQUENTIAL LADDER'S, AND THE SAME REPLACEMENT. Hurt, no wall here, and
    // vigor already above the resting ceiling so waiting produces nothing but time spent hurt in
    // a monster room. That is the operator's "danger is immediate" case exactly, and the answer
    // is the logoff rather than a walk to an inn the fleet has had switched off for a fortnight.
    const went = await keeper.playDead(
      'hurt with no wall here and vigor above the rest ceiling'
    ).then(ok => (ok ? { arrived: true } : { arrived: false, refused: 'already frozen here' }))
     .catch(() => ({ arrived: false, refused: 'playDead threw' }));
    // The sequential ladder's version of this rung is what killed JohnsSlave four times
    // (issue #51): it reported progress on a refusal and returned HANDLED, so the
    // leave-the-room rung under it never ran. Here the same mistake is a SUCCESS that
    // ends the selector tick. Only a retreat that happened may claim either.
    if (!went?.arrived) {
      keeper.note('the retreat was refused -- not claiming the tick for it', {
        refused: went?.refused ?? 'no reason given', no_spot: went?.no_spot ?? null,
        why: 'saying we are moving is not moving, and the leave_room node below only ' +
             'gets a tick if this one gives it up' });
      return FAILURE;
    }
    keeper.progress(went.took_spot ? 'took a wall rather than waiting it out'
                                   : 'moved toward somewhere I can heal');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: leave_room (health below retreat line, combat zone, no wall)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node: tryLeave (try to leave via exit)
// ---------------------------------------------------------------------------

export function tryLeaveNode(keeper) {
  return asyncAction(async (bb) => {
    const s = bb.session.s;
    const cands = (s.world?.exits() || []).filter(e => e.to != null);
    if (!cands.length) return FAILURE;

    const r = await s.leaveViaAny(cands).catch(e => ({ left: false, reason: e.message }));
    if (!r.left) return FAILURE;

    keeper.tally.fled_rooms = (keeper.tally.fled_rooms || 0) + 1;
    keeper.fledInARow = (keeper.fledInARow || 0) + 1;
    await keeper._btFleeRestAndCook();
    keeper.progress('left a room I could neither fight nor rest in');
    await keeper.townTripIfCornered().catch(() => {});
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: breakOut (reconnect to shed aggro, then try to leave)
// ---------------------------------------------------------------------------

export function breakOutNode(keeper) {
  return asyncAction(async (bb) => {
    const s = bb.session.s;
    const broke = await keeper.breakOut('cannot walk out of a room that is killing us')
                           .catch(() => ({ did: false }));
    if (!broke.did) return FAILURE;

    keeper.note('got out after reconnecting', { crowd_before: broke.crowd });

    const cands = (s.world?.exits() || []).filter(e => e.to != null);
    if (!cands.length) return FAILURE;

    const r = await s.leaveViaAny(cands).catch(e => ({ left: false, reason: e.message }));
    if (!r.left) return FAILURE;

    keeper.tally.fled_rooms = (keeper.tally.fled_rooms || 0) + 1;
    keeper.fledInARow = (keeper.fledInARow || 0) + 1;
    await keeper._btFleeRestAndCook();
    await keeper.townTripIfCornered().catch(() => {});
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: eat (provision before declaring trapped)
// ---------------------------------------------------------------------------

export function eatNode(keeper) {
  return asyncAction(async (bb) => {
    const plan0 = keeper._btFleeStrategy();
    if (await keeper.provision(plan0, vitals(bb)).catch(() => false) === 'ate') {
      keeper.note('ate rather than reporting myself trapped', {
        why: 'could not fight, rest or leave -- and "cannot fight" here is usually vigor ' +
             'below the fight floor, which food fixes and a rescue does not',
      });
      return SUCCESS;
    }
    return FAILURE;
  });
}

// ---------------------------------------------------------------------------
// Node: declareTrapped (say what is actually needed)
// ---------------------------------------------------------------------------

export function declareTrappedNode(keeper) {
  return asyncAction(async (bb) => {
    keeper.declareInterest();
    keeper.noProgress('trapped: cannot fight, cannot rest, cannot leave -- needs food or a rescue');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: leaveRoom (composite: try to leave, break out, eat, declare trapped)
// ---------------------------------------------------------------------------

export function leaveRoomNode(keeper) {
  return asyncAction(async (bb) => {
    const hostiles = keeper._btFleeHostiles();
    const hp = hpFrac(bb);
    const sheltered = keeper.holdWorks();

    if (hostiles.length === 0 || sheltered || keeper.hold) return FAILURE;
    if (hp === null) return FAILURE;

    // Check if health is below the retreat line
    const restBelow = keeper.policy.restBelow;
    if (hp >= restBelow) return FAILURE;

    keeper.doing = 'travelling';
    const s = bb.session.s;
    const ways = (s.world?.exits() || []).filter(e => e.to != null && e.reachable !== false);
    const out = ways.sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999))[0];
    keeper.note('leaving the room to recover safely', {
      health: Math.round(hp * 100) + '%',
      monsters_in_room: hostiles.length,
      leaving_via: out?.to_name ?? 'nothing reachable',
      retreat_below: Math.round(restBelow * 100) + '%',
      why: 'health is below the configured recovery line and there is no proven wall here. ' +
           'Resting where a monster can reach us is unsafe; vigor alone never triggers this trip',
      then: 'recover health outside the monster room, then return',
    });

    // Tick the sub-nodes using Fallback logic
    const tryLeave = tryLeaveNode(keeper);
    const breakOut = breakOutNode(keeper);
    const eat = eatNode(keeper);
    const declareTrapped = declareTrappedNode(keeper);

    // Try in order: tryLeave, breakOut, eat, declareTrapped
    for (const node of [tryLeave, breakOut, eat]) {
      const r = await node.tickAsync(bb);
      if (r === SUCCESS) return SUCCESS;
    }

    // Last resort: declare trapped
    return await declareTrapped.tickAsync(bb);
  });
}

// ---------------------------------------------------------------------------
// Node: rest (safe to sit down, heal and recover)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node: arm_health (turn or nudge to arm health regeneration)
// ---------------------------------------------------------------------------

export function armHealthNode(keeper) {
  return asyncAction(async (bb) => {
    const hp = hpFrac(bb);
    const v = vitals(bb);
    const sheltered = keeper.holdWorks();

    const restAt = Math.max(
      keeper.policy.restBelow,
      sheltered ? keeper.policy.holdResumeAbove : 0,
      keeper.recoverUntilWhole && !keeper.recovered() ? 1 : 0,
      keeper.mode === 'farm' && keeper.policy.hunt && !keeper.recoverUntilWhole && keeper.armed()
        ? keeper.safety().engageAt : 0
    );

    if (hp === null || hp >= restAt) return FAILURE; // not hurt enough to need healing

    const n = keeper.hold
      ? await keeper._btFleeTurnInPlace().catch(() => ({ turned: false }))
      : await keeper._btFleeNudge().catch(() => ({ moved: false }));

    if (n.turned) keeper.turnedAt = Date.now();
    if (n.moved) keeper.movedAt = Date.now();

    if (n.moved && keeper.hold) {
      // Drifted off the safe square -- walk back
      const back = await keeper._btFleeReturnToSpot().catch(() => ({ arrived: false }));
      if (back.arrived) {
        keeper.note('drifted off the safe square and walked back', {
          where: { col: keeper.hold.col, row: keeper.hold.row },
          off_by: back.off_by ?? null,
          why: 'the square is known to hold and we are too hurt to fight in the open; ' +
               'returning is cheaper than finding another one',
        });
      } else {
        keeper.releaseHold(`moved off the square and could not get back: ${back.why || 'unknown'}`);
      }
    } else if (n.turned) {
      keeper.note('turned to arm health regeneration', {
        kept: keeper.hold ? { col: keeper.hold.col, row: keeper.hold.row } : null,
        why: 'this wakes the monsters, and in a working safe spot that costs nothing -- ' +
             'they cannot reach us, and the flag it sets is what lets health come back',
      });
    } else if (n.moved) {
      keeper.note('stepped to arm health regeneration', n);
    }

    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: heal (use flasks or wait for HealthTimer)
// ---------------------------------------------------------------------------

export function healNode(keeper) {
  return asyncAction(async (bb) => {
    const hp = hpFrac(bb);
    const sheltered = keeper.holdWorks();

    const h = await keeper._btFleeHealUp(0.95).catch(() => ({ healed: false }));
    if (h.healed) {
      keeper.note('healed', { used: h.used, health: h.health });
    } else {
      keeper.note('healing the slow way', {
        why: 'no flasks, waiting for HealthTimer',
      });
      if ((hp ?? 1) < 0.25 && !sheltered) {
        // Very hurt in the open -- this is dangerous
        keeper.note('very hurt in the open', {
          health: Math.round(hp * 100) + '%',
          why: 'below 25% outside a safe spot -- this is how characters die',
        });
      }
    }
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: rest (rest until fit)
// ---------------------------------------------------------------------------

export function restUntilNode(keeper) {
  return asyncAction(async (bb) => {
    await keeper._btFleeRestUntil().catch(() => {});
    keeper.tally.rests = (keeper.tally.rests || 0) + 1;
    keeper.progress('resting up to fighting strength');
    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// Node: rest (composite: arm health, heal, rest until fit)
// ---------------------------------------------------------------------------

export function restNode(keeper) {
  return asyncAction(async (bb) => {
    const hostiles = keeper._btFleeHostiles();
    const hp = hpFrac(bb);
    const v = vitals(bb);
    const sheltered = keeper.holdWorks();
    const near = keeper._btFleeNear();
    const combatZone = hostiles.length > 0;

    // Only rest if safe: no combat zone, or sheltered, or testing
    const testing = !sheltered && !!keeper.hold && !keeper.hold.failures &&
                    hp !== null && hp >= keeper.policy.fleeBelow;
    if (combatZone && !sheltered && !testing) return FAILURE;

    // Check if hurt
    const vigPct = v.vigor?.max ? v.vigor.value / v.vigor.max : 1;
    const restAt = Math.max(
      keeper.policy.restBelow,
      sheltered ? keeper.policy.holdResumeAbove : 0,
      keeper.recoverUntilWhole && !keeper.recovered() ? 1 : 0,
      keeper.mode === 'farm' && keeper.policy.hunt && !keeper.recoverUntilWhole && keeper.armed()
        ? keeper.safety().engageAt : 0
    );
    const REST_VIGOR_CAP = 0.4;
    const vigorRestAt = Math.min(keeper.policy.restBelow, REST_VIGOR_CAP);
    const hurt = (hp !== null && hp < restAt) || (vigPct !== null && vigPct < vigorRestAt);
    if (!hurt) return FAILURE;

    if (testing && near.length) {
      keeper.note('testing this spot the only way there is', {
        where: { col: keeper.hold.col, row: keeper.hold.row },
        crowd: near.length,
        health: Math.round(hp * 100) + '%',
        why: 'sitting still without swinging is the experiment. If nothing lands we can rest to ' +
             'full here from now on; if something does, we find out in one pass and with two ' +
             'hits of margin still in hand',
      });
    }

    keeper.doing = 'recovering';

    // Tick the sub-nodes
    const armHealth = armHealthNode(keeper);
    const heal = healNode(keeper);
    const restUntil = restUntilNode(keeper);

    for (const node of [armHealth, heal, restUntil]) {
      const r = await node.tickAsync(bb);
      if (r === FAILURE) return FAILURE;
    }

    return SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// The flee/rest tree
// ---------------------------------------------------------------------------

/**
 * Build the flee/rest behavior tree.
 *
 * @param {object} opts
 * @param {object} opts.session - the keeper instance
 * @returns {{ tick: Function, tickAsync: Function }} the flee/rest tree root
 */
export function getFleeTree(opts = {}) {
  const keeper = opts.session?.keeper;
  if (!keeper) throw new Error('getFleeTree: no keeper supplied');

  const children = [
    Object.assign(doomedNode(keeper), { _name: 'doomed' }),
    Object.assign(fleeThresholdNode(keeper), { _name: 'flee_threshold' }),
    Object.assign(lootRecoveryNode(keeper), { _name: 'loot_recovery' }),
    Object.assign(sanctuarySettleNode(keeper), { _name: 'sanctuary_settle' }),
    Object.assign(getAWallNode(keeper), { _name: 'get_a_wall' }),
    Object.assign(vigorWalkNode(keeper), { _name: 'vigor_walk' }),
    Object.assign(leaveRoomNode(keeper), { _name: 'leave_room' }),
    Object.assign(restNode(keeper), { _name: 'rest' }),
  ];

  return {
    // Exposed for the decision trace (m59-keeper-bt.mjs _traceTree).
    children,
    tick: (bb) => {
      for (const child of children) {
        const r = child.tick(bb);
        if (r === SUCCESS || r === RUNNING) return r;
      }
      return FAILURE;
    },
    tickAsync: async (bb) => {
      for (const child of children) {
        if (typeof child.tickAsync === 'function') {
          const r = await child.tickAsync(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        } else {
          const r = child.tick(bb);
          if (r === SUCCESS || r === RUNNING) return r;
        }
      }
      return FAILURE;
    },
  };
}
