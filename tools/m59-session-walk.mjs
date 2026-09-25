#!/usr/bin/env node
// HOW A BODY WALKS. Extracted from m59-game.mjs so that movement can be worked on in
// units a person can hold in their head.
//
// WHY IT IS A SEPARATE FILE. m59-game.mjs was 12,664 lines and roughly half of them were
// these twenty-nine methods: walkPivots, step, walkFine, walkTo, railAcross, followRail,
// leaveVia, leaveViaAny and the rest. `walkTo` alone is 1,827 lines. Movement is also the
// part of this repository under active churn — it is the subsystem with its own commit tag
// (#movement) and its own evidence epochs — so it is the worst possible thing to have
// buried in the middle of the largest file in the tree.
//
// WHY A MIXIN AND NOT FREE FUNCTIONS. Every one of these methods is written against `this`
// and calls dozens of its siblings. Rewriting them to take a session would have meant
// touching seven thousand lines of the code that walks live characters, to gain nothing a
// reader can see. So the method bodies moved VERBATIM, as a class body, and their prototype
// is copied onto Session's. Not one line inside a method changed in the move, which is the
// property that made the move reviewable.
//
// WHY A FACTORY. These methods read module-scope constants that live in m59-game.mjs
// (MOVE_INTERVAL_MS, RUN_VIGOR_FLOOR, the crossing and rail budgets) and a few of its
// helpers. Importing them back would be a cycle. Instead they are PARAMETERS: destructured
// here, they become ordinary closure variables, so every name inside the methods still
// resolves lexically and no body needed editing. m59-game.mjs passes them in when it
// installs the mixin.
//
// THE SEAM is deliberate and narrow: everything from walkPivots to leaveViaAny, ending
// where attackRounds begins. Combat, looting, trade and the session lifecycle stayed put.

import { readFileSync } from 'node:fs';
import { KOD_FINENESS } from './m59-client.mjs';
import { OF, blocksMovement } from './m59-parse.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
// `physics as fallPhysics` — the ALIAS matters: m59-falljump.mjs exports it as `physics`,
// and the name the method bodies use is the alias m59-game.mjs gave it.
import { traversable as fallJumpTraversable, physics as fallPhysics } from './m59-falljump.mjs';
import { clientToProtocol, CLIENT_FINENESS, elideLoops, protocolToClient } from './m59-roo.mjs';
import { fineRouteDetour, pullFine, pointOfSquare } from './m59-finepath.mjs';
import { traceMove } from './m59-collision-trace.mjs';
import { recordTactic } from './m59-tactics.mjs';
import { recordEvent } from './m59-ledger.mjs';
import { chooseTrafficBlink } from './m59-blink-rung.mjs';
import { recallTrack, strikeTrack, clearStrikes, loadTracks } from './m59-tracks.mjs';
import { sheltersAlong, shelterAhead } from './m59-safespots.mjs';
import { planSafeLegs, safeLegsFor, trackCorridor, SAFE_LEG_DEFAULTS } from './m59-safelegs.mjs';
const SAFE_LEG_CORRIDORS = new Map();
import { activeRoutes, anchorFor, bakedPath } from './m59-routes.mjs';
import { autopilotIfAny } from './m59-autopilot.mjs';

/**
 * Build the walking half of a Session. Returns a prototype whose methods m59-game.mjs
 * copies onto Session.prototype.
 *
 * Every dependency is named rather than imported, so this file cannot reach back into
 * m59-game.mjs and there is no import cycle to reason about.
 */
import { boundedRegionEntry, boundedSilentGo, distinctStagesFirst, spreadEdges } from './m59-world.mjs';

import { forgetInferredExit } from './m59-map.mjs';

import * as exitgap from './m59-exitgap.mjs';
// The door table and the decision about which door is in the way. Pure and file-backed; it
// answers empty when a checkout has no table, so this is inert wherever there are no doors.
import { doorsFor } from './m59-doorplan.mjs';
import { waitForDoorOpen, refusedToGo } from './m59-door-wait.mjs';
import { guildPassage, guildSection } from './m59-guild-passage.mjs';

export function sessionWalkPrototype(deps) {
  const {
    ATTACK_INTERVAL_MS,
    BLINK_EVADE_MS,
    COMBAT_FACE_HOLD_MS,
    CROSSING_ASK_EVERY_MS,
    CROSSING_DISTINCT,
    CROSSING_PINNED_MS,
    CROSSING_STALL_MS,
    CROSSING_WINDOW,
    DOOR_SETTLE_MS,
    EDGE_CONFIRM_MS,
    EDGE_CROSSING_WAIT_MS,
    EDGE_NUDGE_MAX_STEPS,
    EDGE_NUDGE_WITHIN,
    EDGE_STEP_IN_WITHIN,
    FACE_EPS,
    FINE_CONFIRM_EVERY,
    FINE_STRIDE,
    FINE_STRIDE_MAX,
    INLAND_MARGIN_SQUARES,
    LEAVE_VIA_CLEARANCE,
    MOVE_HOP_MAX_SQUARES,
    MOVE_INTERVAL_MS,
    OFF_PLAN_STEP_BUDGET,
    PIVOT_ARRIVE_WITHIN,
    PROVED_HOP_MAX_SQUARES,
    Pacer,
    QUEUE_PATIENCE,
    RAIL_SKIP_WITHIN_SQUARES,
    RAIL_STALL_JUMP,
    RAIL_STALL_WAYPOINTS,
    ROOM_RESYNC_MS,
    RUN_VIGOR_FLOOR,
    SHELTER_HIT_WINDOW_MS,
    Session,
    WALK_STALL_STEPS,
    atEdgeOpening,
    bodyWalkArrives,
    declaredJumpNeedsRun,
    orderExits,
    provedSquares,
    resources,
    squaresPerSecond,
    MAX_STEP_HEIGHT,
    MIN_NOMOVEON,
    lanePastBodies,
    perpWalkPastBodies,
    sameRoomDoorPlan,
  } = deps;

  // The class exists only to hold the methods in the syntax they were written in. It is
  // never instantiated: its prototype is copied onto Session's.
  class SessionWalk {
  // WALK THE ROUTE THAT WAS PROVED, NOT THE LATTICE IT WAS DERIVED FROM.
  //
  // THIS IS THE ANSWER TO "WHY DOES THE FLEET DEVIATE FROM ITS PLAN AT ALL". Almost
  // nothing about a room changes: walls, floor heights, slopes and water depth are in the
  // `.roo` and are the same today as yesterday. So which straight lines a body can actually
  // complete is a fact that can be — and already IS — computed offline. `stringPull` reaches
  // as far along a route as the line still ARRIVES with sliding off, and the bake has used
  // it since routes were first baked: the crossing of room 598 from its Twisted Wood
  // doorway to its Ukgoth doorway is 64 squares and SEVEN proved legs of 20, 3, 9, 1, 1, 7
  // and 23 squares, with zero unverified.
  //
  // The walker never used any of it. It re-derived a square lattice at runtime and aimed at
  // each square's stand point in turn — and a stand point in the MIDDLE of a proved leg is
  // not a point the proof says anything about. `moverStepLands` clears it centre to centre,
  // the body is not on a centre after the first slide, the move clips, and the walker
  // replans from a square it never chose. That is every "kept ending up somewhere other
  // than the planned square" in the ledger, and it is self-inflicted.
  //
  // So: aim at the PIVOTS. One move per proved leg, paced by the leg's own length, with the
  // position predicted rather than read — which is exactly what the proof licenses, because
  // a line that arrives arrives. Sixty-four squares becomes seven moves and about thirteen
  // seconds at a run, against a measured median of eighty-five and a worst of 1,778.
  //
  // WHAT IT DOES NOT AND CANNOT PRE-COMPUTE, because the answer to "why not zero deviations"
  // has to be honest and short:
  //
  //   * A BODY IN THE WAY. `blocksMovement` is the one collision that is not in the .roo,
  //     and a troll standing on a pivot is not knowable in advance. A refused leg drops
  //     straight back to the square walker, which already knows how to go round one.
  //   * A ROOM THAT ANIMATES. m59-mutable.mjs names them, and 598 is on the list — the
  //     Temple of Qor door cycles faster than the eight-second collision-invalidation
  //     window. A moving sector genuinely changes the geometry the proof was taken against.
  //   * WHERE THE BODY IS WHEN IT ARRIVES. The proof is anchored at a point; a character
  //     dropped somewhere else by a death, a rescue or a boundary that lands wide has to
  //     walk onto the spine first, and that first stretch is unproved.
  //
  // Everything else — every wall, every ledge, every slope this fleet has ever slid on — is
  // static and was already computed. This just uses it.
  // `shelter` is the fuel-stop contract, and it is the whole of the change: { spots, need,
  // maxDetour, onDivert }. `spots` came from `sheltersAlong` when this crossing was PLANNED,
  // `need()` says whether the character wants one now, and when both are true the next
  // shelter ahead is spliced into the route rather than searched for.
  //
  // Nothing stops. No replan, no handing the character back, no asking the room where the
  // walls are from a standstill — the walker aims at one more waypoint than it did before
  // and carries on. That matters because health leaves at a median of 4.7 a second once
  // something starts, and the average maximum on this fleet is 45: nine and a half seconds
  // from full to dead, and the braking version spent most of it thinking.
  async walkPivots(planSteps, geo, { movementGeneration = this.movementGeneration,
                                    controlToken = null, maxMoves = null,
                                    shelter = null } = {}) {
    const c = this.need();
    const roomId = c.room.id;
    let legs = 0, singles = 0;
    let divertedTo = null, diverted = 0;
    // ONE LEG OF ACTUAL PROGRESS BEFORE THE NEXT DIVERT, AND IT IS A LIVE-LOCK GUARD.
    //
    // Making the divert immediate on damage (see the hit clamp below) makes this necessary
    // rather than merely tidy. A character that rests to full, steps off the wall, is hit
    // once, and re-asks the question in the same second will pick the wall it is standing
    // next to — it is by definition the nearest one — walk back onto it, rest, step off,
    // and do it again for as long as anything in the room keeps swinging. The journey never
    // advances and every lap reports success, which is this repository's oldest failure
    // shape and the one hardest to see from outside.
    //
    // Infinity to start, so the FIRST leg of a fresh crossing may divert normally — the
    // guard is about leaving shelter, not about setting out. Zeroed on arrival at a refuge,
    // and one completed leg is the whole of the debt.
    //
    // The worst case this buys is a crossing made entirely of wall-to-wall hops with a rest
    // at each, which is slow and finishes. The worst case it replaces is a character that
    // never leaves one square. Nothing here touches the survival ladder: fleeing, the
    // watchdog and the protected faculties run on their own one-second clock and are not
    // suppressed by this — only the decision to go and sit somewhere is.
    let legsSinceShelter = Infinity;
    const budget = maxMoves ?? (planSteps.length + 20);
    const half = KOD_FINENESS >> 1;
    const ptOf = st => geo.standPoint?.(st.row, st.col)
      ?? { x: protocolToClient(st.col * KOD_FINENESS + half),
           y: protocolToClient(st.row * KOD_FINENESS + half) };
    let remaining = planSteps.slice();

    // PUBLISHED SO THE KEEPER CAN ASK THE SAME QUESTION THE WALKER ASKS.
    //
    // The fuel stops are worked out here, when the crossing is planned, and until now they
    // never left this function — so the keeper's mid-hop wall rung had no way to see them
    // and searched the room from wherever the body happened to be standing instead. That is
    // the braking version this whole mechanism exists to replace, and it was still running
    // one layer up. `atStep` is kept current per leg so `shelterAhead` can refuse anything
    // already passed; behind is where the character has already been bitten.
    // `onward` is the last planned step — the square this crossing leaves by — so the
    // survival ladder can judge a refuge against the door rather than against where the body
    // happens to be standing. Kept even when the route offers no shelter of its own.
    const onward = planSteps.length ? { row: planSteps[planSteps.length - 1].row, col: planSteps[planSteps.length - 1].col } : null;
    this.activeShelter = shelter?.spots?.length
      ? { spots: shelter.spots, maxDetour: shelter.maxDetour ?? 5, atStep: 0, onward }
      : (onward ? { spots: [], maxDetour: shelter?.maxDetour ?? 5, atStep: 0, onward } : null);

    while (remaining.length && legs + singles < budget) {
      if (this.activeShelter) this.activeShelter.atStep = planSteps.length - remaining.length;
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return { done: false, legs, singles, cancelled: true };

      // THE FUEL STOP. Checked before each leg, which is where a route can still be changed
      // cheaply — the walker is between aims rather than mid-slide.
      //
      // AND AGAIN THE MOMENT A HIT LANDS, which is the half that was missing. See the
      // clamp below: a leg is short while a hit is recent, so "before each leg" becomes
      // "about once a second" exactly when it matters, and the divert stops being decided
      // twenty points of health after the threshold it is supposed to defend.
      if (shelter?.spots?.length && !divertedTo && typeof shelter.need === 'function') {
        let wants = false;
        try { wants = !!shelter.need(); } catch { wants = false; }
        if (wants && legsSinceShelter < 1) {
          // Just off a wall and already wanting another. Say so in the record rather than
          // silently walking on: a suppressed divert and a divert that found nowhere to go
          // look identical from the outside, and they are different rooms.
          try { shelter.onDivert?.(null, { atStep: planSteps.length - remaining.length,
                                           suppressed: 'one leg of progress owed since the last refuge' }); }
          catch { /* a note that cannot be written does not stop the walk */ }
        }
        if (wants && legsSinceShelter >= 1) {
          // How far along we are: the plan minus what is left. `shelterAhead` refuses
          // anything behind that, because a character got hurt somewhere and walking back
          // through it to a wall it has already passed is a longer way to die.
          const at = planSteps.length - remaining.length;
          const stop = shelterAhead(shelter.spots, at, { maxDetour: shelter.maxDetour ?? 5 });
          if (stop) {
            divertedTo = stop; diverted++;
            // ONE MORE WAYPOINT, NOT A NEW PLAN. The rest of the route is untouched and is
            // walked afterwards exactly as it would have been.
            remaining.unshift({ row: stop.row, col: stop.col, shelter: true });
            try { shelter.onDivert?.(stop, { atStep: at, remaining: remaining.length }); }
            catch { /* a note that cannot be written does not stop the walk */ }
          }
        }
      }
      if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
      const me = c.self;
      if (!me || !Number.isFinite(me.x))
        return { done: false, legs, singles, why: 'own_position_unknown' };

      // RE-PROVE FROM WHERE THE BODY ACTUALLY IS, EVERY TIME IT IS NOT ON A PIVOT.
      //
      // This is the difference between a proof and a plan. From room 598's own doorway the
      // pull proves all nine legs — `111111111` — and the crossing is nine moves. From an
      // interior square a character was dropped on, the FIRST leg is routinely unproved
      // (`011`, `011111`), and a walker that gives up there gets no benefit from any of it.
      // So an unproved leg is walked as one ordinary step and the route is re-proved from
      // wherever that lands: one `stringPull`, a handful of traces, not a whole replan.
      const pull = (() => {
        try {
          return geo.stringPull([{ x: protocolToClient(me.x), y: protocolToClient(me.y) },
                                 ...remaining.map(ptOf)]);
        } catch { return null; }
      })();
      if (!pull || !pull.points || pull.points.length < 2)
        return { done: false, legs, singles, why: 'the route could not be pulled' };

      if (!(pull.proved && pull.proved[0])) {
        // The one square the pull could not prove: hand it to the ordinary step, which has
        // the aim correction, the slide and the edge learning. Then re-prove.
        const target = remaining[0];
        const advances = me.col !== target.col || me.row !== target.row;
        // A FALL IS ALWAYS "UNPROVED" TO THE PULL, because the pull traces in walk mode —
        // which is precisely the predicate that refuses a fall. So it lands here, and here
        // is where the flag has to be passed on.
        const r = await this.step(target.col, target.row, { fall: !!target.fall });
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        singles++;
        if (r.left_room) return { done: false, legs, singles, left_room: true };
        if (isTerminalMovementReason(r.reason)) return { done: false, legs, singles, ...r };
        const now = c.self;
        if (!now) return { done: false, legs, singles, why: 'own_position_unknown' };
        if (now.col === target.col && now.row === target.row) {
          if (advances) legsSinceShelter++;
          // ARRIVED AT A REFUGE. SIT DOWN IF WE ARE NOT WHOLE.
          //
          // The operator's rule: stop at each safe waypoint until health and vigor are full,
          // and skip the ones you do not need. Until now the fuel stop put the wall on the
          // route and WALKED THROUGH IT — the comment above says "nothing stops", which is
          // right about not cancelling the crossing and wrong about not resting. A refuge you
          // pass at 40% health is a square, not a refuge.
          //
          // This is NOT a cancellation. The mover keeps the body, the route behind this
          // waypoint is untouched, and the walk continues from here the moment the rest is
          // done. That is the whole difference between a pause and an ending.
          if (target.shelter && typeof shelter?.onArrive === 'function') {
            try { await shelter.onArrive({ col: target.col, row: target.row },
              { movementGeneration, controlToken }); }
            catch { /* a rest that cannot happen must not strand the crossing */ }
            if (this.movementWasCancelled(movementGeneration, controlToken))
              return { done: false, legs, singles, cancelled: true };
            if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
          }
          remaining.shift();
          if (target.shelter) { divertedTo = null; legsSinceShelter = 0; }
          continue;
        }
        return { done: false, legs, singles, why: 'an unproved step landed off plan' };
      }

      // A RECENT HIT ENDS THE COALESCING, AND THAT IS WHAT MAKES THE DIVERT IMMEDIATE.
      //
      // A proved leg is ONE move covering up to twenty-three squares, paced by its own
      // length — several seconds during which the shelter question is not asked, because it
      // is asked at the top of this loop and the loop is not coming round. That is the
      // whole of the latency: 42% of diverts fired more than 25 points below their own
      // threshold, and every one of the ten latest fired at `at_step 0`, i.e. only once the
      // walk it was on had ended and a new one begun.
      //
      // So while a hit is recent the leg is one square. The check at the top then runs at
      // the pace the game actually moves at — about once a second — and the character
      // decides to run for cover while it still can. The proof is not thrown away: the same
      // squares are walked, through the mover that can thread them, and full-length legs
      // come back as soon as nothing has hit us for `SHELTER_HIT_WINDOW_MS`.
      //
      // Only when a shelter policy is in force, so an errand, a fight or a shopping trip
      // pays nothing for this. Being hurt is not the trigger — being hurt is a state and
      // could last a whole crossing; being HIT is an event, and it is the event that means
      // the number the last check read is already out of date.
      if (shelter?.need && this.damagedAt
          && Date.now() - this.damagedAt < SHELTER_HIT_WINDOW_MS
          && remaining.length > 1) {
        const one = remaining[0];
        const advances = me.col !== one.col || me.row !== one.row;
        const r = await this.step(one.col, one.row, { fall: !!one.fall });
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        singles++;
        if (r.left_room) return { done: false, legs, singles, left_room: true };
        if (isTerminalMovementReason(r.reason)) return { done: false, legs, singles, ...r };
        if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
        const now2 = c.self;
        if (now2 && now2.col === one.col && now2.row === one.row) {
          if (advances) legsSinceShelter++;
          if (one.shelter && typeof shelter?.onArrive === 'function') {
            try { await shelter.onArrive({ col: one.col, row: one.row },
              { movementGeneration, controlToken }); }
            catch { /* a rest that cannot happen must not strand the crossing */ }
            if (this.movementWasCancelled(movementGeneration, controlToken))
              return { done: false, legs, singles, cancelled: true };
            if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
          }
          remaining.shift();
          if (one.shelter) { divertedTo = null; legsSinceShelter = 0; }
        }
        continue;
      }

      // A PROVED LEG: one move, aimed at the pivot, paced by its own length.
      const aim = pull.points[1];
      // `let`, because a refused pivot may be retried at another point in the SAME square —
      // see the refusal below. The square is the plan; the point is a choice within it.
      let target = { x: clientToProtocol(aim.x), y: clientToProtocol(aim.y) };
      // BUT A PROOF ABOUT WALLS IS NOT A PROOF ABOUT BODIES.
      //
      // The pull proved this line against the .roo, offline, in an empty room — and a body is
      // the one collision that is not in the .roo. So a leg that is geometrically perfect can
      // still run straight into something standing on it, and this is the path that does it:
      // `step()` threads past bodies through `aimInto`, and a proved leg never calls `step()`.
      //
      // Watched live on 2026-08-27 in the corridor at row 29 of the Western border of the
      // Twisted Wood, with eight bodies parked one per square: the walker covered 29,40 to
      // 29,43 in ONE move and stopped at x=2768 against a body at x=2784 — sixteen units
      // short, which is one body radius. It had aimed through it, been clipped, and then
      // bounced. Threading the aim was useless here because the aim was never asked for.
      //
      // So a leg with something on it is given back to the square walker, which knows how to
      // go past one body at a time. The proof is not discarded — the same squares are walked,
      // one at a time, through the mover that can thread them. Only the coalescing is given
      // up, and only for the legs that need it.
      const legBodies = typeof this.bodiesInSquare === 'function'
        ? this.bodiesInSquare(Math.floor(target.y / KOD_FINENESS),
                              Math.floor(target.x / KOD_FINENESS), 2) : [];
      if (legBodies.length
          && !bodyWalkArrives(me.x, me.y, target.x, target.y, legBodies,
                               { wallOk: this._wallOk() })) {
        const nextSq = remaining[0];
        if (nextSq) {
          const advances = me.col !== nextSq.col || me.row !== nextSq.row;
          const r = await this.step(nextSq.col, nextSq.row, { fall: !!nextSq.fall });
          if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
          if (r?.left_room || c.room.id !== roomId)
            return { done: false, legs, singles, left_room: true };
          singles++;
          if (isTerminalMovementReason(r.reason)) return { done: false, legs, singles, ...r };
          if (c.self && c.self.col === nextSq.col && c.self.row === nextSq.row) {
            if (advances) legsSinceShelter++;
            if (nextSq.shelter && typeof shelter?.onArrive === 'function') {
              try { await shelter.onArrive({col:nextSq.col,row:nextSq.row},
                {movementGeneration,controlToken}); }
              catch { /* the keeper records a failed recovery handoff */ }
              if (this.movementWasCancelled(movementGeneration,controlToken))
                return {done:false,legs,singles,cancelled:true};
              if (c.room.id !== roomId) return {done:false,legs,singles,left_room:true};
            }
            remaining.shift();
            if (nextSq.shelter) { divertedTo = null; legsSinceShelter = 0; }
          }
          continue;
        }
      }
      const dist = Math.max(Math.abs(target.x - me.x), Math.abs(target.y - me.y)) / KOD_FINENESS;
      // A twenty-three square move landing a fifth of a second after a one-square one is
      // the shape user.kod:3049 logs as a speedhacker; covering the ground at a run takes
      // the time it takes either way, so the wait is honest as well as safe.
      const speed = this.moveSpeed();
      const owed = Math.round(1000 * dist / squaresPerSecond(speed));
      const deg = (Math.atan2(target.y - me.y, target.x - me.x) * 180 / Math.PI + 360) % 360;
      await this.pacer.submit('turn', () => (c.room.id === roomId ? c.face(deg) : false));
      let queued = await this.queueValidatedMove(target.x, target.y,
        { speed, slide: false, minGap: Math.max(this._moveGapMs ?? MOVE_INTERVAL_MS, owed),
          expectedRoomId: roomId });
      // Traced at the CALL SITE, never inside `queueValidatedMove` — that method is lifted
      // out of this file by text and evaluated by m59-collision-test.mjs, so anything it
      // calls has to exist in that scope too. Off unless M59_COLLISION_TRACE=1.
      traceMove({ agent: this.name, room: this.world?.room?.num ?? null, kind: 'pivot',
                  to: { x: target.x, y: target.y }, sent: !!queued.sent,
                  reason: queued.validation?.reason ?? null });
      if (!queued.sent) {
        // A PIVOT IS A SQUARE, AND A STAND POINT IS ONE POINT IN IT.
        //
        // This gave up on the whole proved leg the moment the pivot's stand point was refused,
        // and a stand point is refusable while the square is perfectly enterable — it is one
        // point of a 64-unit square, chosen for openness, not for reachability FROM HERE.
        //
        // Measured on the shadow fleet, 2026-08-28, room 578 stepping 47,14 -> 46,15, by asking
        // the body to aim at each lattice point in turn:
        //
        //     992,2976  the stand point          geometry_blocked
        //     992,2992                           MOVED, landed in 46,15
        //     976,2992 and 1008,2992             MOVED, landed in 46,15
        //
        // Three of nine points work and the one this aimed at is not one of them. So the baked
        // route was right that the step exists, the square walker's `aimInto` would have found
        // it, and only the pivot walker could not — it is the one path that never asks. The
        // operator watched characters sit in that room for minutes on a route that was correct.
        //
        // `aimInto` is exactly the question worth asking here and it is already written: same
        // square, other points, each proved by the same trace. One retry, and on failure the
        // leg gives up as before and the square walker takes over below.
        const other = typeof this.aimInto === 'function'
          ? this.aimInto(me, Math.floor(target.y / KOD_FINENESS),
                             Math.floor(target.x / KOD_FINENESS))
          : null;
        const retry = other && (other.x !== target.x || other.y !== target.y)
          ? await this.queueValidatedMove(other.x, other.y,
              { speed, slide: false, minGap: Math.max(this._moveGapMs ?? MOVE_INTERVAL_MS, owed),
                expectedRoomId: roomId }).catch(() => null)
          : null;
        if (!retry?.sent)
          return { done: false, legs, singles, why: queued.validation?.reason ?? 'refused',
                   note: queued.validation?.note };
        queued = retry;
        target = other;
      }
      this._moveGapMs = owed;
      legs++;
      legsSinceShelter++;   // progress since the last refuge — see the live-lock guard
      // PREDICTED, WHICH IS WHAT THE PROOF IS FOR. `slide: false` means the move either
      // lands on the pivot or is not sent at all, so there is nothing to read back — and
      // reading back is a 1.2-5.6s round trip that would cost more than the leg.
      c.predictSelf({ x: queued.target.x, y: queued.target.y,
                      col: Math.floor(queued.target.x / KOD_FINENESS),
                      row: Math.floor(queued.target.y / KOD_FINENESS) });
      // Drop every planned square the leg just covered. The pivot IS one of them, so the
      // route is consumed up to and including it.
      const at = c.self;
      let cut = remaining.findIndex(st => st.col === at.col && st.row === at.row);
      if (cut < 0) cut = 0;
      // A PROVED LEG CAN SWALLOW THE REFUGE, AND BEING PAST IT IS NOT BEING AT IT.
      //
      // This used to call `onArrive({ col: at.col, row: at.row })` for any leg whose consumed
      // squares included a shelter — `at` being where the LEG ENDED, which on a proved leg is
      // up to thirteen squares beyond the wall. So the character sat down wherever the pivot
      // put it, in the open, and rested there.
      //
      // Measured on the shadow fleet, 2026-08-27: of 41 shelter stops that reported arriving,
      // fifteen LOST health — 134 points given away at places the ledger called refuges — and
      // 598 51,22 alone took 92 of that across eight characters. The operator's correction is
      // what identified it: those squares are valid safe spots, and a character that reaches
      // one is safe on it. They were not reaching them. The wall was never the problem, and a
      // ledger that says `arrived: true` for a body standing somewhere else is worse than no
      // ledger, because it moves the blame onto the geometry.
      //
      // So a swallowed refuge is PUT BACK rather than counted. The walker's next iteration
      // aims at it as an ordinary waypoint and the other call site — which checks the position
      // before resting — does the honours. The cost is one short leg backwards; the thing it
      // buys is that "arrived" means arrived.
      const swallowed = remaining.slice(0, cut + 1).filter(st => st.shelter);
      const onIt = swallowed.some(st => st.col === at.col && st.row === at.row);
      remaining = remaining.slice(cut + 1);
      if (swallowed.length && !onIt) {
        // Nearest first: a leg can swallow more than one, and the one worth turning back for
        // is the one we are closest to.
        const back = swallowed.reduce((best, st) =>
          !best || Math.max(Math.abs(st.col - at.col), Math.abs(st.row - at.row))
                 < Math.max(Math.abs(best.col - at.col), Math.abs(best.row - at.row)) ? st : best, null);
        remaining.unshift(back);
        continue;                                  // aim at it properly, then rest on it
      }
      if (onIt && typeof shelter?.onArrive === 'function') {
        try { await shelter.onArrive({ col: at.col, row: at.row },
          { movementGeneration, controlToken }); }
        catch { /* a rest that cannot happen must not strand the crossing */ }
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return { done: false, legs, singles, cancelled: true };
        if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
        divertedTo = null; legsSinceShelter = 0;
      }
    }
    return { done: remaining.length === 0, legs, singles,
             ...(remaining.length ? { why: 'ran out of moves before the route ended' } : {}) };
  }

  /**
   * WHERE TO AIM A DECLARED JUMP, GIVEN WHO IS STANDING IN THE WAY.
   *
   * Extracted so the walker and the rail share one implementation. It was written for the
   * rail and only ever ran there — and the rail is not how this fleet takes the jump, so
   * every measurement below was being paid for and thrown away. Two homes for one
   * heuristic is how they drift; this is the one home.
   *
   * Sixty-eight measured jumps, every one a real attempt:
   *
   *     declared landing always   31/35 = 89%   clear 29/29 = 100%   blocked 2/6 = 33%
   *     always re-aim             29/33 = 88%   clear 27/30 =  90%   blocked 2/3 = 67%
   *
   * The same overall, and opposite where it matters. The declared landing is the one
   * somebody walked, and on a clear line it does not miss. Re-aiming trades a little of
   * that for the only thing that helps when something is on the line. So there is nothing
   * to choose between them: keep the declared line while it is clear, and go looking only
   * when it is not.
   *
   * A falling body is clipped by anything in a square it passes THROUGH, which is why
   * distance is measured to the SEGMENT from the take-off rather than to the landing.
   * Candidates are the declared landing's own shelf — neighbours on the same floor — so
   * this stays a variation on a walked jump rather than a new claim about the map.
   */
  clearestLanding(here, target, geo) {
    if (!here || !target || !geo) return target;
    const CLEAR = 1.5;                       // squares; below this something is on the line
    try {
      const floorAt = (r, c) => { const sp = geo.standPoint?.(r, c);
                                  return sp ? (geo.floorBaseAtClient?.(sp.x, sp.y) ?? null) : null; };
      // WHERE THE JUMP IS MEANT TO END UP. Not the aim — the FLOOR the aim is for. Ukgoth's
      // shelf is 3840 and the gulley beside it is 3200, and an aim is only worth considering
      // if the arc it produces finishes on the first.
      const wantFloor = (() => {
        const a = fallPhysics(here, target, floorAt);
        return a?.ok ? floorAt(a.lands.row, a.lands.col) : floorAt(target.row, target.col);
      })();
      if (wantFloor == null) return target;

      const bodies = [...(this.client?.room?.objects?.values?.() ?? [])]
        .filter(o => blocksMovement(o.flags ?? 0) && o.id !== this.client?.selfId
                     && Number.isFinite(o.row) && Number.isFinite(o.col));
      const gapTo = (cand) => {
        if (!bodies.length) return Infinity;
        const vx = cand.col - here.col, vy = cand.row - here.row;
        const len2 = vx * vx + vy * vy;
        return Math.min(...bodies.map(o => {
          const wx = o.col - here.col, wy = o.row - here.row;
          const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
          return Math.hypot(here.col + t * vx - o.col, here.row + t * vy - o.row);
        }));
      };
      if (gapTo(target) >= CLEAR) return target;

      // THREAD THE NEEDLE, BUT ONLY THROUGH AIMS THE BODY CAN ACTUALLY REACH.
      //
      // The first version of this picked whichever square was furthest from the blockers and
      // scored 1/10 against 5/10, because on this cliff that is always the aim furthest out
      // of reach — it chose 38,8, an 8.2-square jump from a ledge with about 3.8 squares of
      // carry. Distance from a troll is not the constraint; the arc is.
      //
      // So every candidate is put through the same ballistics the operator's own jump was
      // measured with, and kept only if it FINISHES ON THE SAME FLOOR the declared jump
      // finishes on. Measured offline from 36,16: aiming at 39,12 lands 39,12 on the shelf,
      // aiming at 38,13 lands 38,12 on the shelf, and the declared 38,10 lands 37,13 on an
      // intermediate ledge — so there are genuinely several ways down, and only some of them
      // are reachable. Among those, the clearest line wins; ties keep the declared aim.
      let best = { cand: target, gap: gapTo(target) };
      for (let dr = -1; dr <= 1; dr++) for (let dc = -3; dc <= 3; dc++) {
        const cand = { row: target.row + dr, col: target.col + dc };
        if (!dr && !dc) continue;
        if (geo.walkable(cand.row, cand.col) !== true) continue;
        const arc = fallPhysics(here, cand, floorAt);
        if (!arc?.ok) continue;
        const lands = floorAt(arc.lands.row, arc.lands.col);
        if (lands == null || Math.abs(lands - wantFloor) > 96) continue;   // not our shelf
        const gap = gapTo(cand);
        if (gap > best.gap + 0.01) best = { cand, gap };
      }
      return best.cand;
    } catch { return target; }
  }

  // COORDINATE CONTRACT: this movement API is `(col,row)`; geometry calls inside
  // it deliberately adapt to `(row,col)`.
  // A STEP THAT SENT NOTHING MUST NOT CHAIN INTO THE NEXT ONE WITHOUT A REAL YIELD. A refused
  // step returns through a settled await, which is a microtask and not a turn of the event
  // loop; a loop of them starves the keepalive, the HTTP server and the stall monitor for as
  // long as the loop runs (45 s measured on 2026-09-02 with every needle inside it clocked
  // at 400 ms). One macrotask yield per packetless result is the difference. Guarded by
  // `typeof` at every call site, because the fixtures lift those loops by text.
  async _yieldIfPacketless(r) {
    if (r?.moved || r?.left_room || (r?.travelled ?? 0) > 0 || r?.reason === 'raw_move_rejected') return;
    await new Promise(res => setTimeout(res, 25));
  }
  // `aimX`/`aimY` OVERRIDE THE SQUARE CENTRE, in kod protocol units, and a declared jump is
  // why they exist. The landing below is computed as `col * KOD_FINENESS + 32` — the middle of
  // the square — and on the ground jumps are declared over, the middle of the square is the
  // WRONG WORLD: r40c32 in the Ancient Place spans 3200 to 10880, its centre is the gully, and
  // the shelf the operator lands on is a third of a square north of it. Watched live: a
  // character climbed the entire spiral, jumped, overshot the shelf and came down in the
  // gully — aimed, faithfully, at the middle of the right square.
  //
  // `substrate/m59-falljumps.json` already carries `to_fine` for exactly this reason. Nothing
  // was reading it.
  async step(col, row, { confirm = false, beforeMutation = null, fall = false,
                         aimX = null, aimY = null } = {}) {
    const c = this.need();
    const roomId = c.room.id;
    const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
    // NO RE-AIM HERE, AND THE MEASUREMENT IS WHY.
    //
    // A re-aim was wired in at this exact point and made things strictly worse: ten trials
    // from the same square at the same vigor went 9 into the gulley and 1 dead, against
    // 3 for 3 landing cleanly without it. The telemetry says what it chose — "line to 38,10
    // was blocked; aiming 38,8 instead" — and 38,8 is a LONGER jump than the declared one,
    // 8.2 squares against 6.3 from a take-off whose ballistic reach is about 3.8 before the
    // intermediate shelves are counted. `clearestLanding` maximises distance from bodies
    // and knows nothing about whether the body can physically arrive, so on this cliff its
    // best answer is always the one furthest out of reach.
    //
    // The declared landing is the square an operator actually walked to. Until a re-aim can
    // be told what is REACHABLE as well as what is clear, holding that line beats guessing:
    // 3/3 against 1/10, measured the same afternoon on the same character.
    // A DECLARED JUMP THE BODY CANNOT RUN IS REFUSED HERE, BECAUSE HERE IS THE ONLY PLACE
    // EVERY FALL PASSES THROUGH.
    //
    // The first attempt at this gate went into `followRail`, and it never fired once: the
    // fleet reached Ukgoth 9 times out of 9 and then failed 599 -> 2 sixteen times with
    // `every square for that exit refused`, which comes from `leaveViaAny`. The jump is
    // taken by the ORDINARY WALKER following a planned fall edge, not by the rail. Putting
    // the check on the primitive covers the walker, the rail, the planner's waypoints and
    // anything added later, which is the whole argument for choosing a choke point over a
    // call site.
    //
    // REFUSE, DO NOT REST. Resting is a minute of blocking work and this is a primitive
    // that callers expect to return in milliseconds; `followRail` still owns sitting down
    // on the ledge. What this must guarantee is only that a body which cannot run never
    // LEAVES the ledge, because the gulley it lands in has no exit.
    // DECLARED OUT HERE, BECAUSE THE AIM IS READ OUT HERE.
    //
    // This was `let laneAim` INSIDE the block below, and the fall's aim is chosen a hundred
    // lines further down in the enclosing scope -- so every fall that reached the aim threw
    // `laneAim is not defined`. A ReferenceError in the mover is not a refused step: the pass
    // dies, the keeper's whole tick dies with it, and the character stands there. Seen in
    // PRODUCTION as `pass failed  why: laneAim is not defined`, and it killed somebody.
    //
    // `node --check` cannot see this -- the code is syntactically perfect -- and the dependency
    // guard in m59-collision-test only knows about MODULE-scope names, so a local declared in
    // the wrong block passes both. The test below pins the position rather than the spelling.
    let laneAim = null;   // set by laneClearing; the fall aims here when it exists
    if (fall && before) {
      const vig = (() => { try { return c.vitals?.()?.vigor?.value ?? null; } catch { return null; } })();
      const isDeclared = declaredJumpNeedsRun(this.world?.room?.num, before, { row, col });
      if (Number.isFinite(vig) && vig < RUN_VIGOR_FLOOR && isDeclared) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'declared_jump', trigger: 'refused_no_run', worked: false,
                       ms: 0, hp_lost: 0, attempted: true,
                       note: `from ${before.row},${before.col} to ${row},${col} at vigor ${vig}` });
        return { moved: false, left_room: false, position: before,
                 reason: 'jump_needs_run',
                 note: `this declared jump needs a run and vigor is ${vig} against a floor of ` +
                       `${RUN_VIGOR_FLOOR}; refusing rather than falling short of the landing` };
      }
      // EVERY FALL STEP LEAVES A RECORD, AND THAT INCLUDES THE ONES THAT WORK.
      //
      // Three rounds were spent arguing about this jump from the outside, off transit rows
      // that only ever say the HOP failed. What nobody could see was the attempt itself:
      // where the body left from, what its vigor was at that instant, and what was standing
      // in the line. A falling body is clipped by whatever it passes THROUGH — which is why
      // waiting and jumping blind both go 0 against a blocker — so the neighbours matter as
      // much as the vigor.
      //
      // Recorded on every fall rather than only on declared ones: a fall the table does not
      // describe is exactly the case worth seeing, and `worked` is left false because this
      // side cannot yet know where the body ends up. The landing is read off position by
      // whoever is watching; this row says what was attempted.
      // THE GAP TO THE FLIGHT LINE, NOT THE DISTANCE TO THE JUMPER.
      //
      // The first version of this logged everything within three squares of the take-off and
      // therefore flagged all twelve attempts, successes and failures alike — an indicator
      // that fires every time separates nothing. What matters is how close a body is to the
      // LINE the falling character travels along, because that is what clips it.
      //
      // BLOCKERS ONLY, decided by the server's own MOVEON bits. A corpse that the server
      // marks walk-through is not an obstacle and must not delay or divert anybody; the
      // operator is explicit that dead bodies do not block, and `blocksMovement` is where
      // that question is already answered for movement, so it is the same answer here.
      // READ THE RAW ROOM OBJECTS, NOT `world.objects()`.
      //
      // `World.objects()` returns a PROJECTION — id, name, col, row, can, is_player — and
      // it does not carry `flags`. So `blocksMovement(o.flags ?? 0)` asked MOVEON of zero,
      // which is MOVEON_YES, which is "walk through", for every object in the room. The
      // filter therefore emptied the list and the sensor reported `linegap clear` on
      // sixteen consecutive jumps taken past three Guardians of Zjiria standing beside the
      // landing. An indicator that can only say one thing is worse than none, because it
      // gets believed: it very nearly produced the finding "a clear line lands 16/16".
      //
      // `c.room.objects` is where the flags live, and it is the same source
      // `queueValidatedMove` filters for real collision — so the answer here and the answer
      // the mover enforces come from one place.
      // A BODY IN A GULLY IS NOT ON THE LINE. IT IS UNDER IT.
      //
      // This measured distance from `o.col`/`o.row` alone — squares, flat — so anything sharing
      // a square with the arc counted as blocking it however far below it stood. A fall-jump is
      // the one move where that is routinely wrong: the whole point of it is that the ground in
      // between is at a different height.
      //
      // The Sewers of Barloque, row 27, is the case that makes it undeniable
      // (tools/fixtures/sewers-108-row27.json):
      //
      //     28,43  floor 2304      the take-off
      //     27,43  floor  820      the gully — six giant rats standing in it, one per square
      //     26,43  floor 1920      the landing
      //
      // The arc runs 2304 -> 1920 and the rats are ELEVEN HUNDRED UNITS BELOW IT. Flat, the rat
      // at 27,43 reads as gap 0 and the jump can never be taken; it waits three times, re-aims,
      // logs, and repeats for as long as the rat stands there — which is for ever, because the
      // rats in that fixture never moved across seventy seconds of observation.
      //
      // The rule is the same one CLAUDE.md puts in capitals about floor, applied to bodies: a
      // square is a summary. A body can only clip a jump if it is at a height the jump passes
      // through, and `PLAYER_HEIGHT` is the client's own figure for how tall one is. Anything
      // more than that below the LOWER end of the arc is under the traveller's feet.
      //
      // Conservative in the direction that matters: an unknown floor counts as ON the line, so
      // a body we cannot place is still respected. Only a body we can prove is beneath the arc
      // is discounted.
      // THERE IS NO JUMPING OVER ANYTHING. Corrected 2026-08-29, from the operator, who has
      // played this client: "Meridian 59 is merciless on enforcing collisions regardless of
      // vertical disparities. There is no jumping over anything except the parts of the world
      // that exist in the .roo files."
      //
      // What was here discounted any body more than PLAYER_HEIGHT below the arc -- so the
      // giant rats standing in the gully at 27,43, 1484 units beneath a jump that leaves from
      // 2304, read as not being there at all. That is a rule for a game with ballistic arcs
      // and this is not one: a body in a square you pass through clips you whatever its floor
      // is. The exemption is gone, which makes this STRICTER, and the lane below pays for it.
      //
      // AND THE GAP IS MEASURED IN FINE UNITS, NOT SQUARES.
      //
      // `DECLARED_CLEAR` was 1.5 SQUARES and the old measure differenced `o.col` against
      // `before.col`, so a rat at the CENTRE of a square the line crosses measured zero and
      // the jump was refused outright. That is the error this file warns about in capitals:
      // a square is a summary, and on interesting ground a false one. The real question is
      // whether a body of MIN_NOMOVEON clears, and at column 43 of the Sewers it does -- 16
      // units west of a centred rat, 20 east, both with take-off and landing floor beneath
      // them. The operator's framing: a stationary blocker is the BEST case, because nothing
      // has to be timed, you just pick a side.
      const NOMOVEON_KOD = MIN_NOMOVEON / (CLIENT_FINENESS / KOD_FINENESS);   // 16, in wire units
      const bodyPoints = () => { try {
        return [...c.room.objects.values()]
          .filter(o => blocksMovement(o.flags ?? 0) && o.id !== c.selfId
                       && (Number.isFinite(o.x) || Number.isFinite(o.col)))
          .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                       y: o.y ?? (o.row * KOD_FINENESS + 32),
                       name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      } catch { return []; } };
      const gapAlong = (ax, ay, bx, by, bodies) => {
        if (!bodies.length) return { gap: Infinity, who: [] };
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
        let best = Infinity, who = [];
        for (const o of bodies) {
          const t = len2 ? Math.max(0, Math.min(1, ((o.x - ax) * vx + (o.y - ay) * vy) / len2)) : 0;
          const d = Math.hypot(ax + t * vx - o.x, ay + t * vy - o.y);
          if (d < best) { best = d; who = [o.name]; } else if (d < best + 0.01) who.push(o.name);
        }
        return { gap: best, who };
      };
      const fromX = before.x ?? (before.col * KOD_FINENESS + 32);
      const fromY = before.y ?? (before.row * KOD_FINENESS + 32);
      const toXc = aimX != null ? aimX : col * KOD_FINENESS + 32,
            toYc = aimY != null ? aimY : row * KOD_FINENESS + 32;
      const measureLineGap = () => gapAlong(fromX, fromY, toXc, toYc, bodyPoints());

      // A LANE IS THE SAME JUMP, SHIFTED SIDEWAYS. Same take-off square, same landing square,
      // same distance -- so it cannot repeat the 1/10 result recorded below, which came from
      // choosing a FURTHER landing the body could not reach. Only the line moves.
      //
      // Offsets are tried nearest-first, and a candidate is kept only if both ends still have
      // floor: a lane that leaves the take-off ledge or misses the landing shelf is not a
      // lane, it is a fall.
      const laneClearing = () => {
        const g = this.world?.geometry;
        if (typeof g?.floorBaseAtClient !== 'function') return null;
        const bodies = bodyPoints();
        if (!bodies.length) return null;
        const dx = toXc - fromX, dy = toYc - fromY;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        const hasFloor = (x, y) => { try {
          return Number.isFinite(g.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
        } catch { return false; } };
        let best = null;
        for (let off = 4; off <= 28; off += 2) {
          for (const sign of [1, -1]) {
            const ox = px * off * sign, oy = py * off * sign;
            const ax = Math.round(fromX + ox), ay = Math.round(fromY + oy);
            const bx = Math.round(toXc + ox), by = Math.round(toYc + oy);
            if (!hasFloor(ax, ay) || !hasFloor(bx, by)) continue;
            const m = gapAlong(ax, ay, bx, by, bodies);
            if (!(m.gap >= NOMOVEON_KOD)) continue;
            if (!best || m.gap > best.gap) best = { x: bx, y: by, gap: m.gap, off: off * sign };
          }
          if (best) break;
        }
        return best;
      };
      const lineGap = measureLineGap();
      // WAIT FOR THE LINE, RATHER THAN RE-AIMING AROUND IT.
      //
      // Re-aiming was tried here and measured 1/10 against 5/10: `clearestLanding` picks the
      // square furthest from bodies and knows nothing about reach, so on this cliff it chose
      // 38,8 — a longer jump than the declared one — and fell short every time. The other
      // half of the same old measurement is the one that survives: a CLEAR LINE lands 29/29,
      // and waiting scored 100% on a clear line where jumping blind scored 50%.
      //
      // So the aim never moves. What changes is WHEN. A falling body is clipped by anything
      // in a square it passes through, monsters wander, and a second or two is cheap against
      // a gulley that costs a lap of Ukgoth to escape.
      //
      // 1.5 squares is not a new number: it is `DECLARED_CLEAR`, from the 68-jump study
      // already in this file. Bounded hard — this is a primitive, callers expect it back
      // quickly, and a doorway held by something that never moves must still end the walk.
      const JUMP_WAITS = Number(process.env.M59_JUMP_WAITS || 3);
      const JUMP_WAIT_MS = Number(process.env.M59_JUMP_WAIT_MS || 1200);
      let waited = 0, gapNow = lineGap;
      if (isDeclared) {
        while (Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD && waited < JUMP_WAITS) {
          await new Promise(r => setTimeout(r, JUMP_WAIT_MS));
          waited++;
          gapNow = measureLineGap();
        }
        if (waited) {
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                         tactic: 'declared_jump', trigger: 'waited_for_line',
                         worked: !(Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD),
                         ms: waited * JUMP_WAIT_MS, hp_lost: 0, attempted: true,
                         note: `line was ${Number(lineGap.gap).toFixed(2)}; after ${waited} wait(s) ` +
                               `it is ${gapNow.gap === Infinity ? 'clear' : Number(gapNow.gap).toFixed(2)}` });
        }
        // WAITING FIRST, THREADING SECOND — because a blocker that wanders costs nothing to
        // outlast and the aim that worked is the one somebody walked. But some of them do
        // not wander: measured here, `line was 0.95; after 3 wait(s) it is 0.95` twelve
        // times running, all twelve into the gulley. Against a troll that has decided to
        // stand there, waiting is just a slower way to jump blind.
        //
        // So once the line has failed to clear, look for another aim — and `clearestLanding`
        // now only offers aims whose ARC finishes on the same shelf, so this cannot repeat
        // the 1/10 mistake of choosing a landing the body cannot reach.
      }
      // THE LANE IS FOR EVERY FALL, NOT ONLY A DECLARED ONE.
      //
      // Everything above sat behind `isDeclared`, and the traffic does not. Twelve characters
      // staged into the Cragged Mountains produced 1,103 fall attempts in nine minutes -- every
      // one an `undeclared_fall`, every blocker one of our own bots standing on the line
      // (`linegap 1.00 (Llll)`, `linegap 0.00 (Hhhh)`) -- and not one reached a wait, a lane
      // or a re-aim, because none of that runs for an ordinary fall. They retried until the
      // run ended.
      //
      // The lane costs one pass over the blockers and no waiting, so there is no reason it was
      // ever the privilege of a declared jump. The WAIT stays declared-only (three seconds on
      // every ordinary fall is not affordable) and so does `clearestLanding`, which moves the
      // destination and is the one that measured 1/10.
        // A LANE FIRST, AND ONLY THEN A DIFFERENT LANDING. Shifting the line sideways keeps
        // the declared take-off and landing, so reach is unchanged by construction -- which is
        // why the 1/10 result below does not apply to it. Changing WHERE you land is the thing
        // that fell short; changing which side of the blocker you pass is not.
        if (Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
          const lane = laneClearing();
          if (lane) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'declared_jump', trigger: 'lane', worked: true, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `line to ${row},${col} was ${Number(gapNow.gap).toFixed(1)} `
                                 + `(${gapNow.who.join(', ')}); took the lane ${lane.off > 0 ? '+' : ''}${lane.off} `
                                 + `for ${lane.gap.toFixed(1)} of clearance` });
            laneAim = { x: lane.x, y: lane.y };
            gapNow = { gap: lane.gap, who: [] };
          }
        }
        if (isDeclared && Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
          const threaded = this.clearestLanding(before, { row, col }, this.world?.geometry);
          if (threaded && (threaded.row !== row || threaded.col !== col)) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'declared_jump', trigger: 'threaded', worked: false, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `line to ${row},${col} stayed at ${Number(gapNow.gap).toFixed(2)}; ` +
                                 `threading to ${threaded.row},${threaded.col} instead` });
            row = threaded.row; col = threaded.col;
            gapNow = measureLineGap();
          }
        }
      // AN ORDINARY FALL THE LANE COULD NOT CLEAR IS A REFUSAL, NOT A RETRY.
      //
      // A declared jump has somewhere else to go from here -- it waits, and it re-aims. An
      // ordinary fall has neither, and without this it returned an unremarkable failure that
      // the walker replanned and tried again, at about twelve attempts a second per character.
      // `fall_blocked_by_body` is terminal, so the caller stops and the road is reported shut
      // rather than being hammered. Both sides of the blocker have already been tried by the
      // time this is reached.
      if (!isDeclared && Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'fall', trigger: 'blocked_no_lane', worked: false, ms: 0,
                       hp_lost: 0, attempted: false,
                       note: `${before.row},${before.col} -> ${row},${col} line ${Number(gapNow.gap).toFixed(1)} `
                             + `(${gapNow.who.join(', ')}); no lane clears it` });
        return { moved: false, left_room: false, position: before,
                 reason: 'fall_blocked_by_body',
                 note: `something is on the line of this fall and neither side of it clears; `
                       + `waiting is a declared jump's remedy, not an ordinary fall's` };
      }
      // WHAT THIS ROW IS, AND WHY IT IS NOT A FAILURE.
      //
      // It is written BEFORE the jump is attempted — it records the line as measured, so that a
      // jump that goes wrong can be read against what was known at the time. `worked: false`
      // was hardcoded here, and the ledger has no other state for "not an outcome", so this
      // became the largest entry in the whole book and the largest entry in its
      // SPENDING TIME AND NOT WORKING section:
      //
      //     declared_jump on undeclared_fall: 0/1616 (prod), 0/5524 (shadow)
      //
      // Nothing was failing. It is one row per candidate landing per evaluation — thirteen of
      // them share a single timestamp in Rowlf's log, and the row immediately after is a rail
      // boarded successfully — so the count is the number of aims considered, not attempts, and
      // the 0% is a constant. Read as a tactic it says the fleet cannot jump; read correctly it
      // says nothing at all about outcomes.
      //
      // It cost an hour of this session: 244 rows from one square read as 244 stuck attempts,
      // and a character that had already moved on read as pinned. The ledger is what every
      // movement question gets asked of, so a row that cannot be right is worse than no row.
      //
      // `attempted: false` is the honest label. `recordTactic` scores `worked ? ok : fail` and
      // the ledger's own note says a row for a DECISION rather than an attempt is what made
      // Ukgoth read as an 84% rail failure — the same mistake, already written down.
      recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                     tactic: 'declared_jump', trigger: isDeclared ? 'declared' : 'undeclared_fall',
                     worked: false, ms: 0, hp_lost: 0, attempted: false,
                     note: `line as measured, before the jump: ` +
                           `${before.row},${before.col} -> ${row},${col} vigor ${vig ?? '?'} ` +
                           `linegap ${gapNow.gap === Infinity ? 'clear' : Number(gapNow.gap).toFixed(2)}` +
                           (gapNow.who.length ? ` (${gapNow.who.slice(0, 2).join(', ')})` : '') +
                           (waited ? ` after ${waited} wait(s)` : '') });
    }
    // Turn to face the destination first. It costs nothing, it is what a player
    // does, and several things in this game care about facing.
    //
    // FACE COALESCING (the packet-throttle fix, docs/packet-throttle.md). The session used to
    // send a turn packet BEFORE EVERY move, so a walk produced a turn+move pair every tick
    // (~4-6/s) which tripped the server's 5/s throttle. A player only turns when the heading
    // actually changes. Compare the requested heading against our current facing (c.self.degrees,
    // kept up to date by server pushes) and only send a turn when it differs by more than
    // FACE_EPS. This drops turn production from ~4/s to near zero while tracking.
    if (before && (before.col !== col || before.row !== row)) {
      const deg = (Math.atan2(row - before.row, col - before.col) * 180 / Math.PI + 360) % 360;
      const curDeg = c.self?.degrees;
      // COMBAT-FACING LOCK. If the combat controller just faced a target (to swing), do NOT
      // re-face to the movement heading. Re-facing to the walk direction overrode the combat
      // facing, making the character oscillate between the target and the heading, so every
      // melee swing landed on a target behind the facing line (rejected by the server's
      // view-cone check, player.kod ~4185). Honor the combat face for COMBAT_FACE_HOLD_MS.
      const cf = c._combatFacing;
      const combatHolding = cf && (Date.now() - cf.at) < COMBAT_FACE_HOLD_MS;
      const facingChanged = !combatHolding && (curDeg == null ||
        (() => { const a = ((curDeg % 360) + 360) % 360, b = ((deg % 360) + 360) % 360;
                 const d = Math.abs(a - b); return Math.min(d, 360 - d) > FACE_EPS; })());
      if (facingChanged) {
        await this.pacer.submit('turn', () => {
          if (c.room.id !== roomId) return false;
          if (typeof beforeMutation === 'function') beforeMutation('turn', { col, row });
          return c.face(deg);
        });
      }
    }
    if (c.room.id !== roomId) return {
      moved: false, position: c.self ? { x: c.self.x, y: c.self.y,
        col: c.self.col, row: c.self.row } : null,
      left_room: true, reason: 'room_changed_before_move',
    };
    const speed = this.moveSpeed();
    // PACE BY DISTANCE, NOT BY PACKET. A hop may now cover several squares, so a fixed
    // gap between packets would make a five-square hop arrive five times too early —
    // which is the actual definition of speedhacking, and would be visible as such.
    //
    // The gap owed is for the hop just SENT, and `minGapForKind` is applied against the
    // previous send of this kind, so it is carried on the session rather than computed
    // here from the current hop. A single square at a run is 200ms; five squares is a
    // full second. Both are the same 5 squares/second.
    const gap = this._moveGapMs ?? MOVE_INTERVAL_MS;
    const dist = before ? Math.max(Math.abs(col - before.col), Math.abs(row - before.row)) : 1;
    // AND A LONG HOP WAITS FOR ITS OWN LENGTH AS WELL AS FOR THE ONE BEFORE IT.
    //
    // The gap owed is computed from the hop just SENT, which keeps the average rate honest
    // and says nothing about a single packet. user.kod:3049 checks the single packet:
    // `iSquaredDistance >= 200` with under three seconds since the last update is logged as
    // a possible speedhacker and charged exertion. So a thirteen-square hop arriving a fifth
    // of a second after a one-square one is exactly the shape that trips it. Waiting this
    // hop's own duration first is also simply true — a body cannot cross thirteen squares
    // in less time than it takes to run them.
    const owed = Math.round(1000 * dist / squaresPerSecond(speed));
    // THE ONE PLACE A PLANNED SQUARE BECOMES A PACKET, so it is the one place the aim can
    // diverge from the plan. `moverStepLands` decides what to plan by tracing between the
    // two squares' STAND POINTS; if this kept aiming at centres, the router would be
    // authorising steps against one point and the mover attempting them against another —
    // the exact split this whole subsystem exists to close.
    //
    // For every square whose centre is floor `standPointWire` returns `col * KOD_FINENESS
    // + half` exactly, so ordinary movement is unchanged to the byte and only a square a
    // wall cuts in half moves at all. Measured in Western border of the Twisted Wood: 1406
    // squares identical to their centre — precisely the count the coarse grid calls
    // walkable — and 299 moved, none of which the grid had accepted.
    //
    // Falls back to the centre when there is no geometry, which is both the honest answer
    // for a room with no collision payload and what keeps this method liftable: it had no
    // dependency on `this.world` at all before, and one of its test fixtures has none.
    // AND FROM WHERE WE ACTUALLY ARE. See aimInto: the stand point is what the router
    // priced, and it is not always reachable from a body that has slid off one.
    //
    // NOT FOR A FALL, THOUGH. `fallTargets` proved this exact pair of stand points and
    // nothing else, so hunting for a different point inside the landing square would be
    // asking a question nobody answered — and every one of those nine traces is in walk
    // mode, which is the predicate that refuses a fall in the first place.
    const half = KOD_FINENESS >> 1;
    // `laneAim` is the same landing square entered on the side that clears the blocker --
    // see laneClearing. Null when nothing was in the way, so an unobstructed jump aims at the
    // stand point exactly as before and is unchanged to the byte.
    // THE DECLARED LANDING POINT OUTRANKS THE SQUARE'S STAND POINT, AND THIS IS THE LINE THAT
    // DECIDES WHERE A JUMP GOES.
    //
    // `aimX`/`aimY` were added for exactly this and were plumbed into `toXc`/`toYc` — which
    // feed the gap measurement and the lane clearing, and NOT the packet. So a jump carrying a
    // declared `to_fine` still went to `standPointWire(row, col)`, one point per square, and
    // on r40c32 — which spans 3200 to 10880 — that is the gully. Watched live: the character
    // climbed the whole staircase, jumped, and the mover reported `position {x:2080,y:2592}`,
    // which is `col*64+32, row*64+32` to the byte. The square centre, faithfully.
    //
    // `laneAim` still wins, and must: it is the same landing entered from the side that clears
    // a body in the way, and with monster collision being height-agnostic something standing
    // in the gully below is a wall. Order is therefore: dodge a blocker, else the point the
    // operator actually landed on, else the square's stand point, else its middle.
    let aim = fall
      ? (laneAim
         ?? ((aimX != null && aimY != null) ? { x: aimX, y: aimY } : null)
         ?? this.world?.geometry?.standPointWire?.(row, col)
         ?? { x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half })
      : null;

    // A LANE CHANGE IS A STEP OF ITS OWN. `threadInto` decides whether this one needs one and
    // returns both halves; the argument, the measurements and why a diagonal cannot do it are
    // on the method. A fall never asks — it is already leaving the floor.
    if (!fall) {
      const threaded = this.threadInto(before, row, col);
      aim = threaded.aim;
      // A squeeze can cost more than one packet. Each waypoint is a proved leg from the last, so
      // they go in order; the first that does not send stops the sequence rather than skipping
      // ahead, because a leg whose start never happened proves nothing about the leg after it.
      let last = null;
      for (const via of threaded.vias ?? []) {
        const stepped = await this.queueValidatedMove(via.x, via.y,
          { speed, slide: true, minGap: MOVE_INTERVAL_MS, expectedRoomId: c.room.id })
          .catch(() => null);
        if (!stepped?.sent) break;
        last = via;
      }
      // Re-aim from where the body ACTUALLY ended up, not from where it was sent: a leg that
      // clipped short leaves the next one starting somewhere else, and aiming from the intended
      // point is how a walk drifts off a proof it still believes in.
      if (last) aim = this.aimInto(c.self ?? last, row, col);
    }
    // SLIDING STAYS ON FOR A FALL TOO. The flag that matters is `fall`, which is what lets
    // a body leave a ledge at all; `slide` only decides whether an endpoint the trace
    // cannot reach exactly is clipped back or refused outright. Turning it off made a fall
    // all-or-nothing from a body that is rarely exactly on the take-off stand point the
    // router priced — measured: Ukgoth 2,27 -> 71,2 went from 1.04x to bouncing on 12 of 13
    // steps. Both `{ slide: true, fall: true }` and `{ slide: false, fall: true }` arrive on
    // the step that started this; only the missing `fall` ever refused one.
    const queued = await this.queueValidatedMove(aim.x, aim.y, { speed, slide: true, fall,
        beforeMutation: typeof beforeMutation === 'function'
          ? () => beforeMutation('move', { col, row }) : null,
        minGap: Math.max(gap, owed), expectedRoomId: roomId });
    // `col`/`row` are `step`'s ARGUMENTS, which are where it is going — not where it is.
    // The first cut of this called them `from`, and a trace of an oscillating walk then read
    // as a character teleporting between two distant squares. Both ends are recorded now:
    // `at` is the body, `target` is the aim, and a loop is the pair repeating.
    traceMove({ agent: this.name, room: this.world?.room?.num ?? null, kind: 'step',
                square: c.self ? { col: c.self.col, row: c.self.row } : null,
                target: { col, row }, to: { x: aim.x, y: aim.y }, sent: !!queued.sent,
                reason: queued.validation?.reason ?? null });
    if (!queued.sent) {
      const validation = queued.validation ?? {};
      const leftRoom = c.room.id !== roomId;
      const at = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : before;
      return { moved: false, position: at, left_room: leftRoom,
               geometry_blocked: validation.blocked !== false,
               ...(validation.animation ? { animation: validation.animation } : {}),
               reason: validation.reason ?? 'geometry_blocked', note: validation.note };
    }
    this._moveGapMs = owed;
    // Predict, the way the real client does.
    const target = queued.target;
    c.predictSelf({ x: target.x, y: target.y,
                    col: Math.floor(target.x / KOD_FINENESS),
                    row: Math.floor(target.y / KOD_FINENESS) });
    // AND RESYNC ON A CLOCK, AT MOST — BUT DO NOT STAND STILL FOR IT.
    //
    // This awaited the reply, and the reply is a 1.2-5.6s round trip. So a walk ran for
    // six seconds, froze for one to five, ran for six. That is the visible jerk, and it
    // is the reason a fleet character does not move like a person even when every other
    // number is right: the pauses are not pacing, they are us waiting.
    //
    // Nothing in the next step needs the answer. Position is dead-reckoned and the
    // server does not echo our own moves, so the re-read is for the OBJECT MAP —
    // furniture, monsters, loot — and the walker only consults that when it replans.
    // The reply lands on the event stream and updates the room whenever it arrives,
    // which is exactly as good a few hundred milliseconds later.
    //
    // So it is fired and not awaited. `confirm: true` still blocks, because the one
    // caller that passes it genuinely needs to know where it ended up — and
    // confirmPosition(), before crossing out of a room, is the other place we still pay
    // for the truth on purpose.
    if (confirm) {
      const confirmed = await this.confirmPosition();
      if (!confirmed) return { moved: false, position: null, left_room: false,
                               reason: 'position_confirmation_timeout', predicted: true };
    } else if (Date.now() - (this.lastRoomRead ?? 0) >= ROOM_RESYNC_MS) {
      this.lastRoomRead = Date.now();
      // Not awaited. A failure here is not a movement failure — the walk carries on
      // with a slightly older object map, which is the state it was already in.
      this.pacer.submit('read', () => c.roomContents()).catch(() => {});
    }
    const after = c.self;
    return {
      moved: !!after && (!before || after.x !== before.x || after.y !== before.y),
      position: after ? { x: after.x, y: after.y, col: after.col, row: after.row } : null,
      // Still honest without a re-read: crossing a boundary brings a fresh BP_PLAYER and
      // the client rebuilds the room, so our own id is genuinely absent from the new one
      // until contents land. That is the answer this wants.
      left_room: !c.room.objects.has(c.selfId),
      // So a caller can tell a confirmed position from a predicted one rather than having
      // to know this function's internals.
      predicted: !confirm && !!after?.predicted,
      locally_validated: true,
      ...(queued.validation.blocked ? { geometry_blocked: true,
        clipped: queued.target, requested: queued.validation.requested,
        reason: queued.validation.reason } : {}),
    };
  }

  // ------------------------------------------------------- fine movement
  //
  // THE SQUARE GRID CANNOT DESCRIBE A LEDGE, AND MERIDIAN HAS MANY.
  //
  // The .roo carries movement as one byte per SQUARE — eight direction bits, 64
  // fine units to the square. A walkable strip narrower than one square has
  // nowhere to live in that structure, so the square reads solid and the ordinary
  // pathfinder refuses the route before sending a packet. The cliff path in
  // Kardde's Canyon that is the only way into the Badlands is exactly this: present
  // in the fine BSP, absent from the grid.
  //
  // The server does not use that grid — or validate player geometry at all. The real
  // client clips movement against the fine BSP before it sends a position. We must do
  // the same locally; asking the server to judge is precisely how a bot crosses walls.
  //
  // Two rules make it work, and both were learned the hard way:
  //
  //  * VALIDATE BEFORE SENDING. The server accepts player coordinates; a room read is
  //    confirmation of state, never a collision oracle.
  //  * WHEN BLOCKED, SLIDE. A locally clipped step usually means the straight line touched
  //    rock, not that the way is shut. Fanning the heading out to either side is
  //    what "hugging the wall" actually is, and it is how a human gets along a
  //    ledge without falling off it.
  // COORDINATE CONTRACT: `(x,y)` is a fine point in kod wire units.
  async stepFine(x, y) {
    const c = this.need();
    const startRoom = c.room.id;
    if (this.finePositionUnknown) {
      const recovered = await this.confirmPosition();
      if (!recovered) return { moved: false, left_room: false,
        reason: 'position_confirmation_timeout',
        note: 'no further fine packet was sent because its starting point is unknown' };
      this.finePositionUnknown = false;
    }
    const p0 = c.self;
    const before = p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null;
    if (!before) return { moved: false, left_room: false, reason: 'own_position_unknown' };
    const queued = await this.queueValidatedMove(x, y,
      { speed: this.moveSpeed(), slide: true, minGap: MOVE_INTERVAL_MS });
    const validation = queued.validation ?? {};
    if (!queued.sent) {
      // Return the collision refusal to the walker so it can fan or replan.
      // Keeper processes use the same local geometry contract as direct sessions.
      return {
        moved: false, position: p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null,
        left_room: c.room.id !== startRoom,
        geometry_blocked: validation.blocked !== false,
        reason: validation.reason,
        ...(validation.animation ? { animation: validation.animation } : {}),
        ...(validation.objectId != null ? { objectId: validation.objectId } : {}),
        note: validation.note ?? 'local client collision rejected this move before any packet was sent',
      };
    }
    const target = queued.target;
    // THIS USED TO BLOCK ON EVERY STEP, and it was the most expensive thing in the file.
    //
    // The old note said fine movement may clip or slide to a sub-square point, so prediction
    // cannot establish the starting point for the next local collision pass. That is the
    // right worry and the wrong conclusion: `validateFineTarget` COMPUTES the slide, the
    // packet carries `validation.target` — the already-clipped point — and the server takes
    // the coordinates it is sent. The endpoint is known before the packet leaves.
    //
    // See FINE_CONFIRM_EVERY for the measurement. Briefly: the read costs 203ms and, worse,
    // doubles the packet rate into a server that drops anything over five a second.
    //
    // A STEP THAT COULD HAVE GONE SOMEWHERE UNEXPECTED IS STILL READ BACK, IMMEDIATELY.
    // Prediction is only safe where this side already knows the answer, so anything that
    // means it might not — a room that changed under us, a clipped endpoint, a fall, or
    // simply too many predictions in a row — takes the round trip.
    const roomChanged = c.room.id !== startRoom;
    const clipped = validation.blocked === true
      || target.x !== Math.round(x) || target.y !== Math.round(y);
    this._finePredicted = (this._finePredicted ?? 0) + 1;
    const mustConfirm = roomChanged || clipped
      || this._finePredicted >= FINE_CONFIRM_EVERY
      || FINE_CONFIRM_EVERY <= 1;

    if (!mustConfirm) {
      // The same call the pivot walk and the breadcrumb retreat already make. `predicted`
      // is set on the object, and the client clears it the moment the server says anything
      // about us — so a caller that genuinely needs to know whether a step HAPPENED can
      // still tell that it has not been told.
      c.predictSelf({ x: target.x, y: target.y,
                      col: Math.floor(target.x / KOD_FINENESS),
                      row: Math.floor(target.y / KOD_FINENESS) });
      const sentFrom0 = queued.before ?? before;
      return { moved: target.x !== sentFrom0.x || target.y !== sentFrom0.y,
               position: { x: target.x, y: target.y,
                           col: Math.floor(target.x / KOD_FINENESS),
                           row: Math.floor(target.y / KOD_FINENESS) },
               left_room: false, locally_validated: true, predicted: true,
               travelled: Math.hypot(target.x - sentFrom0.x, target.y - sentFrom0.y) };
    }

    const tFine = Date.now();
    const confirmed = await this.confirmPosition();
    Pacer.note('step_fine', 'blocked', Date.now() - tFine);
    this._finePredicted = 0;
    if (!confirmed) {
      this.finePositionUnknown = true;
      return { moved: false, position: null, left_room: c.room.id !== startRoom,
        locally_validated: true, reason: 'position_confirmation_timeout',
        note: 'the endpoint was safe, but no further fine move is allowed until position is re-observed' };
    }
    this.finePositionUnknown = false;
    const p1 = c.self;
    const sentFrom = queued.before ?? before;
    const after = p1 ? { x: p1.x, y: p1.y, col: p1.col, row: p1.row } : null;
    const moved = !!(sentFrom && after && (after.x !== sentFrom.x || after.y !== sentFrom.y));
    return { moved, position: after,
             left_room: c.room.id !== startRoom || !c.room.objects.has(c.selfId),
             travelled: moved ? Math.hypot(after.x - sentFrom.x, after.y - sentFrom.y) : 0,
             locally_validated: true,
             ...(validation.blocked ? { geometry_blocked: true, clipped: target,
                                         requested: validation.requested,
                                         reason: validation.reason } : {}) };
  }

  // Walk to a fine coordinate without consulting the square grid at all.
  // `stride` is how far to reach per request; a short stride hugs geometry more
  // closely but costs a second per step, since the move rate is one per second.
  // THE LAST MILE INTO A SAFE SPOT, AND THE TOOL IS NOT THE ONE YOU WOULD PICK.
  //
  // A SAFE WALL *IS* THE TWO GRIDS DISAGREEING. That is the entire mechanism and the reason
  // the fleet seeks these squares out: the coarse grid calls the square open, the BSP hems
  // it in, and a monster's pathing cannot follow. So the obvious conclusion is that the
  // square router — which plans stand point to stand point — is the wrong tool for the
  // approach, and that the fine grid should own the last mile.
  //
  // MEASURED, AND THAT CONCLUSION IS WRONG. Across 107 approaches to nominated safe spots
  // in the eleven rooms this fleet uses, from ordinary floor within ten squares:
  //
  //     walkTo    91/107   85%   the square lattice
  //     walkFine  74/107   69%   a greedy fan of nine headings that slides on purpose
  //     finePath  25/107   23%   A* on the quarter-square lattice
  //
  // The square walker is the BEST of the three, and `finePath` — the tool that looks most
  // like "plan the last mile properly" — is by far the worst. The reason is one line of it:
  // `moveLands` rejects any move whose slide ends more than ARRIVE_WITHIN from where it was
  // aimed, because an edge that goes somewhere else is not the edge being put in the graph.
  // That is correct for a route across open floor and fatal here, because a pocket the BSP
  // hems in is a place where EVERY move slides. The fine lattice is STRICTER than the square
  // walker, not more capable, and it has no edges at all in exactly the squares that make a
  // safe spot safe.
  //
  // So this is `walkFine`, which slides on purpose, and it is a FALLBACK rather than a
  // replacement: it is worse on average and it reaches two walls in the Cragged Mountains
  // that the square walker loses, which is the room the whole road turns on. Second, never
  // first, and free when the square walk works.
  //
  // (Widening or narrowing the search radius was tried too and is a wash in the wrong
  // direction: a nearer wall is reached more reliably — 88% at four squares against 83% at
  // ten — but is found so much less often that the share of characters that end up on a
  // wall at all falls from 68% to 51%. `travel_hold_within` stays at ten.)
  // COORDINATE CONTRACT: the destination square is `(col,row)`; optional `toX/toY`
  // are a named fine point in kod wire units.
  async approachFine(col, row, { toX = null, toY = null, maxSteps = 60, stride = 48,
                                 movementGeneration = this.movementGeneration,
                                 controlToken = null } = {}) {
    const c = this.need();
    const geo = this.world?.geometry;
    const me = c.self ?? await this.selfOrResync();
    if (!me || !Number.isFinite(me.x))
      return { arrived: false, reason: 'own_position_unknown' };
    if (!geo?.collisionReady)
      return { arrived: false, reason: 'collision_geometry_unavailable' };

    // The remembered fine position if there is one — it is a record of where a body
    // actually stood — otherwise the square's own stand point.
    const goal = (Number.isFinite(toX) && Number.isFinite(toY))
      ? { x: toX, y: toY }
      : (geo.standPointWire?.(row, col)
         ?? { x: col * KOD_FINENESS + (KOD_FINENESS >> 1),
              y: row * KOD_FINENESS + (KOD_FINENESS >> 1) });

    // A WALL SQUARE IS ONE THE MOVER REFUSES TO ENTER FROM ITS COARSE NEIGHBOURS. That is
    // not an obstacle to the safe-spot search, it is the DEFINITION of what it looks for
    // (safeSpots: coarseRefusesIt; gridDisagreementAt: refused approaches). So the straight
    // line into such a square, from a square the coarse grid offers, is precisely the step
    // the geometry declines — and walkFine's fan slides along the face instead of finding
    // the way round. Measured 2026-08-27 in the Valley of Ileria: 506 grid-disagreement
    // walls in the room, one of them a single square from Zoot, and every approach ended
    // "could not walk back to the square — ran out of steps" while the keeper's own
    // /findpath found the way in with a waypoint.
    //
    // TWO FINE A*s LIVE HERE AND ONLY ONE OF THEM CAN SEE A WALL SQUARE. walkTo's lattice
    // detour (`finePath`, 256-unit steps) answered "no fine route" for every wall next to
    // Zoot; the geometry's own `finePathProtocol` — step 8, the one /findpath and combat
    // use — found each of them in five to seven waypoints. A wall square is standable only
    // in a sliver, and the coarser lattice cannot land on a sliver. So this asks the fine
    // one, in protocol units end to end, and follows its waypoints with stepFine. A body on
    // a waypoint is not this walk's problem — it drops through to the line-walk, whose
    // body rule reports it.
    if (typeof geo.finePathProtocol === 'function') {
      const path = geo.finePathProtocol(me.x, me.y, goal.x, goal.y,
        { step: 8, margin: 4 * KOD_FINENESS, maxNodes: 4000 });
      if (path?.found && Array.isArray(path.waypoints) && path.waypoints.length) {
        let taken = 0;
        for (const wp of path.waypoints) {
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return this.cancelledMovement({ steps: taken, log: [] });
          const step = await this.stepFine(wp.x, wp.y).catch(() => null);
          taken++;
          if (step?.left_room) return { arrived: false, left_room: true, steps: taken };
          if (step?.reason === 'object_blocked') break;
          const at = c.self;
          if (at && at.col === col && at.row === row)
            return { arrived: true, steps: taken, via: 'fine path',
                     position: { col: at.col, row: at.row } };
        }
      }
    }
    const r = await this.walkFine(goal.x, goal.y,
      { maxSteps, stride, arriveWithin: KOD_FINENESS >> 1, movementGeneration, controlToken })
      .catch(e => ({ arrived: false, reason: e.message }));
    if (r?.left_room) return { arrived: false, left_room: true, steps: r.steps ?? 0 };
    const at = c.self;
    // ON THE SQUARE IS THE ONLY THING THAT COUNTS. `walkFine` answers "as close as fine
    // movement gets", which is the right answer to its own question and not to this one:
    // the hold belongs to a square, and `observe()` revokes one taken on the wrong square
    // a pass later.
    const landed = !!at && at.col === col && at.row === row;
    return { arrived: landed, steps: r?.steps ?? 0,
             position: at ? { col: at.col, row: at.row } : null,
             ...(landed ? {} : { reason: r?.reason ?? 'fine approach ended off the square' }) };
  }

  // COORDINATE CONTRACT: `(destX,destY)` is a fine point in kod wire units.
  async walkFine(destX, destY, {
    // SQUARES THIS WALK MAY NOT ENTER, as `row,col` strings. The coarse walker has honoured
    // these since the split-boundary fix; the FINE walker never saw them, and it is the one
    // that actually reaches a boundary. See wrongExitSquares.
    avoidSquares = null,
    maxSteps = 120,
    stride = FINE_STRIDE,
    // THE CEILING THE STRIDE MAY GROW TO, and it is deliberately NOT `stride` for the
    // default caller and exactly `stride` for everyone else. Three sites pass 24, 32 and 40
    // on purpose — the last mile into a safe spot, an edge nudge, a two-step recovery — and
    // those are small because the ground is delicate, so raising their ceiling would make
    // every careful walk careless. A caller that took the default gets to run.
    strideMax = stride >= FINE_STRIDE ? Math.max(FINE_STRIDE_MAX, stride) : stride,
    arriveWithin = 40,
    // DO NOT WALK OFF THE SHELF YOU ARE ON. OFF BY DEFAULT, AND THAT IS DELIBERATE.
    //
    // The fan exists to find a way round geometry, and it is judged purely on DISTANCE: the
    // first heading that moves and gets closer wins. On flat ground that is right. On a ledge
    // it is how a body leaves one: a fanned heading slides off the tread, the step lands a few
    // units nearer the destination, and the walk counts it as progress while the character is
    // now in the gully five thousand units below the route.
    //
    // Measured on the Ancient Place staircase, following a plan that was correct: asked for
    // r42c47 at floor 5856, arrived in THAT SAME SQUARE at 4672, and every later waypoint was
    // then walked along the valley underneath the climb. The treads rise 352 a step against a
    // MAX_STEP_HEIGHT of 384, so there is no margin for a heading that wanders.
    //
    // Every other caller of this function walks ordinary ground where descending is fine and
    // often necessary, so this stays OFF unless asked. `m59-fineroute.mjs` plans routes that
    // only make sense on one shelf, and that is who turns it on.
    holdShelf = false,
    movementGeneration = this.movementGeneration,
    controlToken,
  } = {}) {
    const c = this.need();
    const startRoom = c.room.id;
    let me = c.self ?? await this.selfOrResync();
    if (!me) return { arrived: false, reason: 'own_position_unknown',
                      note: 'own position is unknown and a re-read did not recover it' };

    const log = [];
    let stalls = 0, lastStep = null;
    let closest = Infinity, sinceCloser = 0;
    const geometryRejections = new Set();
    // Floors, asked in CLIENT units. `me.x`/`aimX` here are kod PROTOCOL units — the same
    // space `walk_to`'s col/row path builds with `col * KOD_FINENESS + half` — and the
    // geometry is in client units, so everything must go through `protocolToClient`.
    const shelfGeo = holdShelf ? (this.world?.geometry ?? null) : null;
    // A GUARD THAT CANNOT RUN MUST SAY SO. Asking for `holdShelf` in a session with no geometry
    // left it silently off — the failure this file keeps writing down, where a caller believes
    // a guard is on and walks a ledge unprotected.
    const shelfUnavailable = holdShelf && !shelfGeo;
    const point = (px, py) => {
      try {
        const cx = protocolToClient(px), cy = protocolToClient(py);
        const leaf = shelfGeo.leafAtClient(cx, cy);
        return leaf?.sector ? shelfGeo.floorBaseAtClient(cx, cy, leaf) : null;
      } catch { return null; }
    };
    // WHAT A BODY STANDS ON IS THE HIGHEST FLOOR UNDER ITS FOOTPRINT, NOT ONE SAMPLE AT ITS
    // CENTRE.
    //
    // This asked a single point, and on a ledge a single point is a coin toss: the 7040 band
    // through the Ancient Place is 260 units wide at its narrowest against a body 496 across,
    // so the centre sample sits over the gully while the body is on the shelf, or the reverse.
    // Both directions are wrong — one refuses a legal step, the other lets a 3648-unit fall
    // through as level ground, which is what it did at r37c34.
    //
    // `PLAYER_RADIUS` is 248 client units, 15.5 kod. Corners and centre, the same thing
    // `standAt` does in m59-fineroute.mjs and for the same reason.
    // THE CENTRE DECIDES WHAT YOU STAND ON; THE FOOTPRINT ONLY DECIDES WHETHER YOU FIT.
    //
    // Taking the highest floor under the footprint was the previous attempt at this and it is
    // too permissive at exactly the edge it guards: a step whose centre goes over the drop
    // still has a corner overlapping the shelf, so the predicted landing read 6208 while the
    // body came to rest on 4672 — `shelf_refusals: 0`, and a 1536-unit fall waved through.
    // The radius is for walls (move.c uses it for collision); the height under you comes from
    // where your centre is.
    //
    // The footprint is kept only as a RESCUE for an unreadable centre: a point over the void
    // answers null, and null used to turn the guard off at the lip.
    const RAD = 15;                                  // kod units, ~PLAYER_RADIUS
    const floorOf = (px, py) => {
      if (!shelfGeo) return null;
      const middle = point(px, py);
      if (middle != null) return middle;
      let best = null;
      for (const dx of [-RAD, 0, RAD]) for (const dy of [-RAD, 0, RAD]) {
        const h = point(px + dx, py + dy);
        if (h != null && (best == null || h > best)) best = h;
      }
      return best;
    };
    const destFloor = floorOf(destX, destY);
    const startFloor = floorOf(me.x, me.y);
    let shelfRefusals = 0;
    // Headings to try, in order: straight at it, then fanned out to either side.
    // The wide angles are what carry you along a wall rather than into it.
    const FAN = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];
    // A BODY ON THE DIRECT LINE IS NOT A WALL, AND FANNING AROUND IT IS NOT A WALK.
    //
    // The fan exists for geometry: nine headings and a slide find the gap in a wall the
    // straight line missed. Against a BODY it does something else — the slid step counts
    // as "progress" (a few units closer), the next iteration re-aims through the same
    // body, slides the other way, and the character shuffles two squares for the whole
    // step budget. Measured 2026-08-26 in Castle Victoria: six fleet characters stacked
    // in a 2x3 block at 45-46,3-5, every one "travelling — NOT MOVING" for a quarter of
    // an hour, each one's direct heading refused by a fleetmate.
    //
    // walkTo already treats a body as the caller's problem ("a person is not a hole in
    // the map"): it refunds the step and never persists the refusal. This does the same,
    // faster: once the direct heading has been object_blocked for BODY_BLOCK_STREAK
    // iterations without half a square of net progress, hand it back as object_blocked
    // so the caller can pick another square or wait, instead of spending the budget here.
    const BODY_BLOCK_STREAK = 3;
    let bodyStreak = 0, bodyStart = null, baseReason = null, baseBlockedId = null;

    for (let i = 0; i < maxSteps; i++) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: i, log });
      me = c.self ?? await this.selfOrResync();
      if (!me) return { arrived: false, reason: 'own_position_unknown',
                        note: 'lost own-position while walking; a re-read did not recover it', log };
      const dx = destX - me.x, dy = destY - me.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= arriveWithin)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
               ...(shelfUnavailable ? { shelf_guard: 'REQUESTED BUT UNAVAILABLE — no geometry in this session; the walk was NOT guarded' } : {}),
                 steps: i, log };

      const base = Math.atan2(dy, dx);
      // DO NOT STRIDE PAST THE TARGET. A fixed 48-unit step aimed at a point 20 units away
      // overshoots, the next step overshoots back, and a two-square walk dithers until it
      // runs out of steps — which is what happened the moment the skid fix let short walks
      // reach their target at all. The step is capped at what is left.
      const reach = Math.max(8, Math.min(stride, remaining));
      // AND CLOSE ENOUGH IS ARRIVED. Position is confirmed by the server and our own moves
      // are still settling, so the last few units cannot be closed by aiming harder. If the
      // walk has stopped improving on its closest approach and that approach is inside a
      // square, it is there — the alternative is spending the whole step budget shaving
      // units off a number that a body's own width makes meaningless.
      if (remaining < closest - 1) { closest = remaining; sinceCloser = 0; }
      else if (++sinceCloser >= 4 && closest <= KOD_FINENESS)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 steps: i, log, note: 'as close as fine movement gets — ' +
                   Math.round(closest) + ' units, inside one square' };
      let progressed = false;

      // HAVE WE ALREADY FALLEN? ASKED OF A SETTLED POSITION, WHICH IS THE ONLY KIND WORTH
      // ASKING.
      //
      // The check right after `stepFine` reads `client.self`, and that is the PREDICTED
      // position — the same lag the jump verb pays: the body is where we said it would be, and
      // the drop appears when the server's word arrives. So a step that walked off the shelf
      // was measured before it had happened and passed. Measured on the Ancient Place: three
      // headings correctly refused, a fourth allowed, `shelf_refusals: 3`, and the walk
      // returned `arrived: true` from the gully 1536 units below the route.
      //
      // At the top of the next iteration `me` has been re-read, so the floor under it is real.
      // A body more than a step below the destination's shelf, having started on it, has come
      // off — stop, rather than walking on underneath the route.
      if (shelfGeo && destFloor != null && i > 0) {
        const nowFloor = floorOf(me.x, me.y);
        if (nowFloor != null && destFloor - nowFloor > MAX_STEP_HEIGHT &&
            startFloor != null && startFloor - nowFloor > MAX_STEP_HEIGHT)
          return { arrived: false, reason: 'left the shelf',
                   note: `standing on ${nowFloor} with the route on ${destFloor} (started on ` +
                         `${startFloor}); stopped rather than walking on below it`,
                   shelf_refusals: shelfRefusals, dest_floor: destFloor,
                   position: { col: me.col, row: me.row, x: me.x, y: me.y },
                   steps: i, log };
      }

      // A NARROW FAN ON A LEDGE. The wide angles exist to carry a body ALONG a wall, and on
      // flat ground they are what makes this function work at all. On a tread 352 units above
      // the gully they are how it leaves: a heading 1.2 radians off course swings the body
      // sideways past the edge, the step lands a little nearer the goal, and the walk counts
      // it as progress. Measured on stair four — three headings correctly refused by the
      // shelf guard and the fourth, a wide one, allowed.
      //
      // So when the caller says it is on a shelf, it may look a fifth of a turn either way and
      // no further. If that finds nothing the walk stops, which is the right answer on a
      // staircase: there is one way up and it is forward.
      // NARROWED, NOT CRIPPLED. At [0, ±0.35] the body stopped falling and also stopped
      // climbing: from the 5856 tread every one of three headings led down, twelve refusals a
      // call, because the way up a spiral staircase TURNS. The wide angles (±1.2, ±1.7) are
      // the ones that swing a body off a ledge; ±0.75 is still a step along it.
      const fan = holdShelf ? [0, 0.35, -0.35, 0.75, -0.75] : FAN;
      for (const off of fan) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return this.cancelledMovement({ steps: i, log });
        const a = base + off;
        const aimX = me.x + Math.cos(a) * reach, aimY = me.y + Math.sin(a) * reach;
        // DO NOT DRAG ONTO A SQUARE THAT FIRES THE WRONG DOOR.
        //
        // This is where the Western border of the Twisted Wood was losing every crossing. The
        // rail wants WEST — seven south-west steps and then a long west run before it turns
        // south and finally east to the door at 46,67. When the rail stopped, the fine
        // fallback aimed straight at that door, which is EAST and ON the boundary, and every
        // refusal nudged the body a few fine units along the wall:
        //
        //   3936 -> 3974 -> 4012 -> 4050 -> 4088 -> 4126 -> 4164 -> 4202
        //   15,61   15,62   15,63   15,64   15,65   14,65   ...
        //
        // Four hundred and thirty refused fine moves, creeping east until it reached column
        // 66 at row 14 — inside the `row < 19` band — and the server sent it back to the Main
        // gate to the city of Tos. Dragging along a wall, back out the entrance it came in by.
        if (avoidSquares?.size) {
          const col = Math.floor(aimX / KOD_FINENESS), row = Math.floor(aimY / KOD_FINENESS);
          if (avoidSquares.has(`${row},${col}`)) continue;
        }
        // THE SHELF GUARD. A heading that drops off the ledge is refused before it is sent,
        // not judged afterwards by whether it happened to get closer.
        //
        // Descending ONTO THE DESTINATION'S OWN SHELF is still allowed — the route may
        // legitimately end lower than it starts, and a rule that forbade that would refuse
        // the last step of every climb down. What is refused is leaving the shelf for
        // somewhere that is neither where we are nor where we are going.
        if (shelfGeo) {
          // A BODY OVER THE VOID READS `null`, AND THAT TURNED THE GUARD OFF for exactly the
          // step where it matters most — the one taken from the lip of a ledge. The route is a
          // shelf, so when the body's own floor cannot be read, judge against the destination's.
          const hereFloor = floorOf(me.x, me.y) ?? destFloor;
          if (hereFloor != null) {
            // ASK WHERE THE BODY WOULD LAND, NOT WHERE IT IS AIMED. The move slides, and on a
            // ledge the slide is the whole danger: checking the aim point passed a heading
            // whose aim was on the tread and whose SLID ENDPOINT was over the edge. Measured
            // on stair four — three headings correctly refused, the fourth allowed, and the
            // body 1536 units down in the gully with the walk reporting `arrived: true`.
            // WITH THE BODIES IN IT, BECAUSE MONSTER COLLISION IS HEIGHT-AGNOSTIC AND THE
            // GEOMETRY IS NOT.
            //
            // The operator's rule: every monster is infinitely tall. A hop or a step whose
            // geometry is clear — 5000 down to 4000 over a gully at 0 — is still blocked by
            // something standing in that gully, which the height model says is far below the
            // arc. So a trace WITHOUT obstacles predicts a landing the body will not reach:
            // the real move is blocked, slides somewhere else, and on a tread "somewhere
            // else" is off it.
            //
            // That is also the only thing here that can vary between two runs of identical
            // code, and it did: the same climb walked all 47 waypoints once and fell at 15
            // the next time. Geometry does not move. Monsters do.
            const bodies = [...(c.room?.objects?.values?.() ?? [])]
              .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0) &&
                           Number.isFinite(o.x) && Number.isFinite(o.y))
              .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
            // A TRACE THAT SAYS THE BODY WILL NOT MOVE IS A REFUSAL, NOT A REASON TO GUESS.
            //
            // This fell back to judging the AIM whenever the trace reported no movement, and
            // the aim is the permissive case: on a tread it is the tread, so the heading was
            // allowed, the real move slid, and the body left the shelf. Adding the obstacle
            // list made that worse rather than better — a blocked step is exactly when the
            // trace reports no movement — so the climb went from occasionally working to
            // falling every time at the same tread. If the mover says this heading goes
            // nowhere, take the next heading.
            let landX = aimX, landY = aimY, traced = false;
            try {
              const t = shelfGeo.traceFineMoveClient(
                protocolToClient(me.x), protocolToClient(me.y),
                protocolToClient(aimX), protocolToClient(aimY),
                { slide: true, obstacles: bodies, roomFlags: c.room?.flags ?? 0,
                  overrideDepths: c.room?.overrideDepths ?? null });
              if (t) {
                traced = true;
                if (!t.moved) { shelfRefusals++; continue; }
                landX = clientToProtocol(t.x); landY = clientToProtocol(t.y);
              }
            } catch { traced = false; /* no trace at all: judge the aim and hope */ }
            void traced;
            const landFloor = floorOf(landX, landY);
            if (landFloor != null &&
                hereFloor - landFloor > MAX_STEP_HEIGHT &&
                (destFloor == null || Math.abs(landFloor - destFloor) > MAX_STEP_HEIGHT)) {
              shelfRefusals++;
              continue;
            }
          }
        }
        const r = await this.stepFine(aimX, aimY);
        // AND CHECK WHERE IT ACTUALLY WENT. The trace is a model and the body is the fact: if
        // this step has put us off the shelf, stop here. Walking on is how one missed tread
        // becomes thirty-five waypoints walked along the valley underneath the climb, with the
        // caller told it arrived.
        if (shelfGeo && r?.moved) {
          const now = this.client?.self;
          const nowFloor = now ? floorOf(now.x, now.y) : null;
          const wasFloor = floorOf(me.x, me.y) ?? destFloor;
          if (nowFloor != null && wasFloor != null &&
              wasFloor - nowFloor > MAX_STEP_HEIGHT &&
              (destFloor == null || Math.abs(nowFloor - destFloor) > MAX_STEP_HEIGHT))
            return { arrived: false, reason: 'left the shelf',
                     note: `stepped from floor ${wasFloor} to ${nowFloor} on the way to a ` +
                           `destination at ${destFloor}; stopped rather than walking on below the route`,
                     shelf_refusals: shelfRefusals, dest_floor: destFloor,
                     position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
                     steps: i + 1, log };
        }
        if (off === 0) {
          baseReason = r.reason ?? null;
          baseBlockedId = r.reason === 'object_blocked' ? (r.objectId ?? null) : null;
        }
        // THE FINE WALK IS WHERE THE TRACE USED TO GO DARK.
        //
        // `traceMove` sat on the two square-step call sites only, so every fine move was
        // invisible — and fine movement is exactly what carries a body across the seam where
        // the coarse grid stops. In room 587 the baked line's sixth square, 16,60, is
        // fine-grid-only (coarse says no, the BSP says yes), and the trace ends at the square
        // before it every single time: five squares recorded, then sixty-two moves with no
        // position at all, then a reading of the room we came from.
        //
        // Whether that reading is real is the open question, and it cannot be answered from
        // a record that stops at the seam. So the fine walk records too: the same fields, plus
        // the FINE coordinates, because a square number is exactly the resolution that hides
        // what happens inside one.
        traceMove({ agent: this.name, room: this.world?.room?.num, kind: 'fine',
                    square: c.self ? { col: c.self.col, row: c.self.row } : null,
                    fine: { x: Math.round(me.x), y: Math.round(me.y) },
                    aimed: { x: Math.round(me.x + Math.cos(a) * reach),
                             y: Math.round(me.y + Math.sin(a) * reach) },
                    sent: !!r.moved, reason: r.reason ?? null,
                    left_room: !!r.left_room });
        lastStep = { aimed: { x: Math.round(me.x + Math.cos(a) * reach), y: Math.round(me.y + Math.sin(a) * reach) },
                     from: { x: me.x, y: me.y }, reach,
                     moved: r.moved, travelled: r.travelled, reason: r.reason ?? null,
                     locally_validated: r.locally_validated ?? null,
                     geometry_blocked: r.geometry_blocked ?? null,
                     position: r.position ?? null, note: (r.note ?? '').slice(0, 90) };
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: this.world?.room?.num ?? null,
                   room_object_id: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room while following the fine route' };
        }
        if (r.reason) geometryRejections.add(r.reason);
        if (isTerminalMovementReason(r.reason))
          return { arrived: false, reason: r.reason, note: r.note,
                   position: r.position, steps: i, log };
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: this.world?.room?.num ?? null,
                   room_object_id: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room — for an edge exit that IS arriving' };
        }
        // PROGRESS IS GROUND GAINED ON THE TARGET, NOT A POSITION COMPARISON THAT RACES
        // PREDICTION.
        //
        // `r.moved` is only `after !== queued.before`; it says the body changed position,
        // not that it got nearer this target. In room 578 every blocked northward request
        // slid sideways, so `moved` stayed true and reset the stall counter for eighteen
        // minutes while the distance never improved. Conversely, paced dead reckoning can
        // make a genuinely forward step report `moved: false` when `queued.before` was read
        // after the prior prediction advanced. Neither boolean answers this question.
        //
        // Distance to the destination cannot be fooled that way: it is measured from the
        // position the server confirmed, against a target that does not move.
        const now = c.self;
        const gained = now ? remaining - Math.hypot(destX - now.x, destY - now.y) : 0;
        if (gained > 1) {
          progressed = true;
          // A step that gained ground gets a LONGER stride, not merely the one it started
          // with. The halving below is for a body wedged in a gap; a step that just gained
          // ground is not wedged, and on open floor there is no reason to keep asking for
          // three quarters of a square at a time. Capped at `strideMax` — see FINE_STRIDE_MAX
          // for why that number is a client's pace rather than a preference.
          stride = Math.min(stride * 2, strideMax);
          if (off !== 0) log.push({ step: i, slid: Number(off.toFixed(2)), to: r.position });
          break;
        }
      }

      if (!progressed) {
        stalls++;
        // Nine headings refused in a row sent nothing; let the timers and the HTTP server run.
        await new Promise(res => setTimeout(res, 40));
        // Halve the reach and try again: a tight gap may only admit a short step.
        // Floor at 24 (37% of a cell) — below that the walk burns steps
        // without meaningful progress, and the budget was calculated for
        // the initial stride.
        stride = Math.max(24, Math.round(stride / 2));
        if (stalls >= 4)
          return { arrived: false, reason: 'blocked — every heading refused, at every reach tried',
                   ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
               ...(shelfUnavailable ? { shelf_guard: 'REQUESTED BUT UNAVAILABLE — no geometry in this session; the walk was NOT guarded' } : {}),
                   // WHAT THE LAST REFUSAL ACTUALLY SAID. Without this the caller is told
                   // "every heading refused" and cannot tell a wall from a rate limit from a
                   // move the server simply ignored — which is exactly the wall this
                   // investigation hit.
                   last_step: lastStep,
                   position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
                   steps: i, log, geometry_rejections: [...geometryRejections],
                   note: geometryRejections.has('geometry_blocked')
                     ? 'local BSP collision rejected the requested headings; no endpoint was sent through the obstacle'
                     : undefined };
      } else stalls = 0;

      if (baseReason === 'object_blocked') {
        const now = c.self ?? me;
        const nowRemaining = now ? Math.hypot(destX - now.x, destY - now.y) : remaining;
        if (!bodyStart || bodyStart.remaining - nowRemaining > (KOD_FINENESS >> 1)) {
          bodyStart = { remaining: nowRemaining };
          bodyStreak = 1;
        } else bodyStreak++;
        if (bodyStreak >= BODY_BLOCK_STREAK)
          return { arrived: false, reason: 'object_blocked', objectId: baseBlockedId,
                   position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
                   steps: i + 1, log, geometry_rejections: [...geometryRejections],
                   note: 'something is standing on the direct line and ' + bodyStreak +
                         ' fans of headings around it gained under half a square. A body ' +
                         "is the caller's to wait for or route around, not a wall to feel along" };
      } else { bodyStreak = 0; bodyStart = null; }
    }
    me = c.self;
    return { arrived: false, reason: 'ran out of steps',
             ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
               ...(shelfUnavailable ? { shelf_guard: 'REQUESTED BUT UNAVAILABLE — no geometry in this session; the walk was NOT guarded' } : {}),
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null, log,
             geometry_rejections: [...geometryRejections] };
  }

  // THE WAY OUT OF A POCKET IS THE WAY IN, WALKED BACKWARDS.
  //
  // Called when the router says there is no route from here — which, in this world, far
  // more often means "here is one of the 17,402 squares the collision view considers cut
  // off from the rest of its room" than it means the destination is unreachable. The
  // character walked in, so a walk out exists; the router simply cannot see it, because
  // the pocket is a pocket to the model and not to the world.
  //
  // Every step replayed was accepted by the fine validator on the way in, so this CANNOT
  // INVENT AN IMPOSSIBLE TRAVERSAL — it can only undo one. If a character reached a pocket
  // by a traversal that should never have been legal, the breadcrumbs walk it back out the
  // same way rather than widening the hole. That is why this, and not a coarse-grid escape
  // hatch: the grid disagrees with the BSP exactly where the cliff climbs and the boundary
  // crossings live, and relaxing collision there is the failure we are protecting.
  //
  // `until` is asked after every crumb, so the caller stops the moment its route reappears
  // rather than unwinding the whole trail — the goal is to get out of the pocket, not to
  // undo the journey.
  async retreatAlongBreadcrumbs({ maxCrumbs = 12, until = null,
    movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const crumbs = this.breadcrumbs ?? [];
    // TRIM THE LOOPS OUT OF THE TRAIL BEFORE WALKING IT BACKWARDS.
    //
    // The trail is what the character actually did, and what it actually did includes the
    // bouncing that got it into trouble — `4,15 -> 5,15` / `5,15 -> 4,16`, over and over.
    // Replaying that in reverse spends the crumb budget re-doing a round trip that arrived
    // exactly where it started. `maxCrumbs` is 12, so a single eight-step bounce can eat
    // the whole retreat and leave the character in the pocket it was trying to leave.
    //
    // Nothing here can be invented by removing a cycle, because both ends of a cycle are
    // THE SAME SQUARE: the join is "X, then whatever followed X the last time", which is a
    // pair the trail already contained. And every step is still put through the validator
    // on the way back out, so a one-way ledge still stops the retreat rather than being
    // teleported over — see the note below about a refused reverse step.
    //
    // Measured over the recorded walks: 41% of per-room runs contain a loop, and across
    // all of them 47% of the squares visited are revisits. Some of that is a person
    // exploring on purpose; none of it is worth undoing.
    if (crumbs.length > 2) {
      // Keyed on the EXACT landing point, which is what keeps the chain joinable — see
      // elideLoops. A crumb is a validated move, not a square.
      const trimmed = elideLoops(crumbs, cr => `${cr.roomId}:${cr.to.x},${cr.to.y}`);
      if (trimmed.length < crumbs.length) crumbs.length = 0, crumbs.push(...trimmed);
    }
    const roomId = c.room?.id;
    let steps = 0, blocked = null;
    while (steps < maxCrumbs && crumbs.length) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps });
      const crumb = crumbs[crumbs.length - 1];
      const me = c.self;
      if (!me) { blocked = 'own_position_unknown'; break; }
      // A crumb from another room, or one that does not START where we are standing, is
      // not a step we can undo: something moved us since, and reversing it would be a
      // guess about geometry rather than a replay of it. Drop the whole trail rather
      // than skipping — the crumbs below it are no more connected to us than this one.
      if (crumb.roomId !== roomId || crumb.to.x !== me.x || crumb.to.y !== me.y) {
        crumbs.length = 0; blocked = 'breadcrumb_trail_broken'; break;
      }
      const back = await this.queueValidatedMove(crumb.from.x, crumb.from.y,
        { slide: true, expectedRoomId: roomId });
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps });
      if (roomId != null && c.room?.id !== roomId)
        return { moved: steps > 0, steps, crumbs_left: crumbs.length,
                 room_changed: true,
                 reason: 'room identity changed during breadcrumb retreat' };
      if (!back.sent) { blocked = back.validation?.reason ?? 'geometry_blocked'; break; }
      // The crumb this move just recorded is the retreat itself; drop both, or the trail
      // grows a there-and-back pair and the next retreat undoes the undo.
      if (crumbs[crumbs.length - 1] !== crumb) crumbs.pop();
      const idx = crumbs.lastIndexOf(crumb);
      if (idx >= 0) crumbs.splice(idx, 1);
      steps++;
      c.predictSelf({ x: back.target.x, y: back.target.y,
                      col: Math.floor(back.target.x / KOD_FINENESS),
                      row: Math.floor(back.target.y / KOD_FINENESS) });
      if (typeof until === 'function' && until()) break;
    }
    const me = c.self;
    return { moved: steps > 0, steps, crumbs_left: crumbs.length,
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
             ...(blocked ? { reason: blocked } : {}) };
  }

  /**
   * WALK THE TRAIL BACK UNTIL YOU ARE ON THE RAIL AGAIN.
   *
   * The retreat above undoes the last few steps and stops counting. That is right for an
   * ordinary bounce and blind to the thing that actually went wrong on a long trip: the
   * character left the baked lane, wandered, and is now somewhere the router cannot plan out
   * of — with a perfectly good rail two or three squares behind it.
   *
   * WHY BREADCRUMBS AND NOT A FRESH WALK TO THE RAIL. The crumbs are squares this body has
   * already stood on, so replaying them backwards inherits the whole safety argument of rung
   * 1: no relaxed collision, no guessing, nothing the validator has not already passed. A
   * fresh walk at the rail is what the mover was already failing to do.
   *
   * WHY THE RAIL AND NOT THE DOOR WE CAME IN BY (rung 2). The entry square is somewhere we
   * know connects to the last room; the rail is where the PLAN said to be. Rejoining it
   * continues the journey, where rung 2 restarts it — which is why this sits between them.
   *
   * `until` is re-evaluated after every reversed step, so this stops the moment the body is
   * back on the lane rather than spending the whole budget.
   *
   * Measured 2026-09-05 over 1,238 travel deaths carrying `ms_since_moved`: the MEDIAN
   * character had not moved for 86 seconds when it died, p25 was 22s. Whatever the trigger,
   * the margin is enormous — the rung existing at all is worth more than its threshold.
   */
  async retreatToRail({ toSquare = null, maxCrumbs = 24, nearSquares = 2,
    movementGeneration = this.movementGeneration, controlToken } = {}) {
    const rail = toSquare ? this.railAcross(toSquare) : null;
    if (!rail?.squares?.length) return { moved: false, reason: 'no rail to rejoin' };

    // Squares, not fine units. `client.self` carries col/row already, and the bake's lane is
    // in the same space — mixing those two is the standing trap in this codebase.
    const near = (sq) => !!sq && rail.squares.some(r =>
      Math.abs(Number(r.row) - sq.row) <= nearSquares &&
      Math.abs(Number(r.col) - sq.col) <= nearSquares);
    const here = () => {
      const me = this.client?.self;
      return me && Number.isFinite(me.col) && Number.isFinite(me.row)
        ? { col: Math.floor(me.col), row: Math.floor(me.row) } : null;
    };

    const start = here();
    if (near(start))
      return { moved: false, reason: 'already on the rail', rail_squares: rail.squares.length };

    const out = await this.retreatAlongBreadcrumbs({
      maxCrumbs, movementGeneration, controlToken, until: () => near(here()),
    });
    const end = here();
    return { ...out, rejoined: near(end), rail_squares: rail.squares.length,
             rail_from: rail.from ? { col: rail.from.col, row: rail.from.row } : null };
  }

  // LEAVE A SAFE-WALL POCKET FOR THE ROOM'S MAIN BODY.
  //
  // Runtime geometry carries no region labels — only the bake does, and only on exit ANCHORS
  // (m59-routes.json: each anchor has `region` and `from_body`; the room has `main_region`). A
  // go-door anchor is itself a one-square pocket (room 39's anchors are region 7/0, not its main
  // region 21), but `from_body:true` means the room's main body was PROVEN able to walk to it —
  // which is exactly the square that re-enables the first hop, because reach() is 0 steps from a
  // square you are standing on and exits() then offers that crossing. Walk to the nearest such
  // anchor; walkTo's walkFine fallback does the BSP crossing out of the pocket. This is the escape
  // for a character PARKED on a safe wall, where retreatAlongBreadcrumbs (which needs a fresh trail
  // in) cannot help. Not lifted by any test, so it may use module-scope `activeRoutes` freely.
  async escapeToMainRegion({ movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const geo = this.world?.geometry, me = c.self;
    const roomNum = Number(this.world?.room?.num ?? NaN);
    if (!geo || !me || !Number.isFinite(roomNum)) return { moved: false, reason: 'no geometry/self/room' };
    const table = activeRoutes();
    const baked = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
    const targets = (baked?.anchors ?? [])
      .filter(a => a.from_body && Number.isFinite(a.row) && Number.isFinite(a.col))
      .map(a => ({ col: a.col, row: a.row, d: Math.hypot(a.col - me.col, a.row - me.row) }))
      .sort((x, y) => x.d - y.d);
    if (!targets.length) return { moved: false, reason: 'no from_body anchor to aim for' };
    const startKey = `${me.col},${me.row}`;
    for (const t of targets) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement({});
      if (`${t.col},${t.row}` === startKey) continue;   // already standing on it
      const walk = await this.walkTo(t.col, t.row, { movementGeneration, controlToken, maxSteps: 60 })
        .catch(() => null);
      if (walk?.cancelled) return this.cancelledMovement({});
      const now = c.self;
      if (now && `${now.col},${now.row}` !== startKey)
        return { moved: true, steps: walk?.steps ?? null, arrived: !!walk?.arrived,
                 target: { col: t.col, row: t.row }, position: { col: now.col, row: now.row } };
    }
    return { moved: false, reason: 'could not walk to any main-body anchor' };
  }

  // Walk to a square along a route computed through the real geometry, rather than
  // pushing blindly toward it. Both halves matter: the route lets an agent round a
  // corner it would otherwise stall against, and the pacing keeps the session from
  // being logged as a speedhacker.
  //
  // With no geometry it fails closed. Player movement is not checked by the server,
  // so sign-stepping without a map is an unchecked coordinate write, not navigation.
  // GO ROUND A BODY, NOT ROUND THE ROOM.
  //
  // Pure, and it takes the geometry rather than reading `this`, so the decision can be
  // tested without a session. Returns `{ back, through }` — the square to retreat to
  // first (may be null when standing still already opens the angle) and the square to
  // pass through — or null when neither side is available.
  //
  // THE TWO SIDES ARE THE PERPENDICULARS OF THE STEP WE WERE REFUSED, which is what makes
  // this cheap: one body occupies one square, so the detour is one square wide and the
  // router never has to be consulted. Both are checked against the SAME things the walker
  // already knows — the mover's step relation, the edges it has been refused, and the
  // squares it has seen bodies on — so a sidestep cannot propose a traversal the ordinary
  // path would reject.
  /**
   * THE LANE PAST A BODY, FOR AN ORDINARY STEP -- the same move, shifted sideways.
   *
   * `sidestepAround` above is the walker's answer to something in the way and it thinks in
   * SQUARES: try the one either side, then give the square up. In a corridor ONE SQUARE WIDE
   * there is no side, so it returns null and the walk marks the square taken and replans --
   * which in a corridor is the long way or no way.
   *
   * The pass is not a different square. It is a different fine `y` inside the same one.
   * Measured on the recorded jam (tools/fixtures/sewers-108-row27.json, and see
   * m59-lane-test.mjs): a rat on the centre line of a one-square corridor leaves half a unit
   * of room on each side, and because the wire carries integers there is EXACTLY ONE aim
   * point per side. Six rats stood one per square there for seventy seconds and three
   * characters oscillated in the gaps without one of them getting past.
   *
   * IT IS AN AIM, NOT A PROMISE. `stepFine` still has to land it, and a refused lane costs
   * one step. Tried ONCE per blocked square, because a lane that does not work will not work
   * on the second ask either and the fall-through below is the real recovery.
   */
  laneAroundBody(was, blocked, geo, c) {
    try {
      if (typeof geo?.floorBaseAtClient !== 'function') return null;
      const me = c?.self;
      if (!me) return null;
      const to = geo.standPointWire?.(blocked.row, blocked.col);
      if (!to) return null;
      const bodies = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0)
                     && (Number.isFinite(o.x) || Number.isFinite(o.col)))
        .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                     y: o.y ?? (o.row * KOD_FINENESS + 32),
                     name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      if (!bodies.length) return null;
      const hasFloor = (x, y) => { try {
        return Number.isFinite(geo.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
      } catch { return false; } };
      return lanePastBodies({
        fromX: me.x ?? (me.col * KOD_FINENESS + 32),
        fromY: me.y ?? (me.row * KOD_FINENESS + 32),
        toX: to.x, toY: to.y, bodies, hasFloor,
      });
    } catch { return null; }
  }


  /**
   * THE PERP WALK, FOR THE SAME BLOCKED STEP — see perpWalkPastBodies. The axis is the
   * direction of the blocked step, extended three squares so a picket just beyond the
   * blocked square is measured with it; the bodies are everything in the room that blocks
   * movement; the floor test is the room's own BSP at a point.
   */
  perpWalkAroundBodies(was, blocked, geo, c) {
    try {
      if (typeof geo?.floorBaseAtClient !== 'function') return null;
      const me = c?.self;
      if (!me) return null;
      const to = geo.standPointWire?.(blocked.row, blocked.col);
      if (!to) return null;
      const fromX = me.x ?? (me.col * KOD_FINENESS + 32), fromY = me.y ?? (me.row * KOD_FINENESS + 32);
      const dx = to.x - fromX, dy = to.y - fromY, len = Math.hypot(dx, dy) || 1;
      const reach = Math.max(len, 3 * KOD_FINENESS);
      const toX = fromX + dx / len * reach, toY = fromY + dy / len * reach;
      const bodies = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0)
                     && (Number.isFinite(o.x) || Number.isFinite(o.col)))
        .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                     y: o.y ?? (o.row * KOD_FINENESS + 32),
                     name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      if (!bodies.length) return null;
      const hasFloor = (x, y) => { try {
        return Number.isFinite(geo.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
      } catch { return false; } };
      // THE PRECHECK IS THE MOVER'S OWN TRACER, walls and bodies both, in client units. A
      // line it refuses here would have been refused on the wire; asking first costs nothing
      // and saves the packet — and the ledger still records the refusal as a perp_walk row.
      const obstacles = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0) && Number.isFinite(o.x) && Number.isFinite(o.y))
        .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
      const segmentClear = typeof geo.traceFineMoveClient === 'function'
        ? (ax, ay, bx, by) => {
            const r = geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                              protocolToClient(bx), protocolToClient(by),
                                              { slide: false, obstacles, roomFlags: c.room?.flags ?? 0,
                                                overrideDepths: c.room?.overrideDepths ?? null });
            if (!r || r.available === false) return null;          // no opinion: carry on
            return { ok: !!r.arrived && !r.blocked, reason: r.reason ?? null };
          }
        : null;
      return perpWalkPastBodies({ fromX, fromY, toX, toY, bodies, hasFloor, segmentClear });
    } catch { return null; }
  }

  sidestepAround(was, blocked, { blockedEdges, occupied, geo, prefer = 0,
                                 blockerIsPlayer = false }) {
    if (!was || !blocked || !geo) return null;
    const dr = Math.sign(blocked.row - was.row), dc = Math.sign(blocked.col - was.col);
    if (!dr && !dc) return null;
    // Perpendiculars of the refused direction. For a diagonal step these are the two
    // cardinals it decomposes into, which is the right answer for the same reason.
    let sides = (dr && dc) ? [{ dr, dc: 0 }, { dr: 0, dc }]
                           : [{ dr: dc, dc: dr }, { dr: -dc, dc: -dr }];
    // CLOCKWISE FIRST, THEN COUNTERCLOCKWISE. The operator's rule, and the reason it is a
    // fixed order rather than a preference is that a detour round a MONSTER has no second
    // party to deadlock with — the thing in the way is not also running this function.
    //
    // Clockwise in room coordinates, where row increases DOWNWARD: rotating a heading right
    // takes east to south, south to west, west to north. The cross product `dr*s.dc -
    // dc*s.dr` is negative for exactly those, which is the test used here rather than a
    // table, so it is right for the diagonal decompositions too.
    const clockwise = s2 => (dr * s2.dc - dc * s2.dr) < 0;
    sides = [...sides.filter(clockwise), ...sides.filter(s2 => !clockwise(s2))];

    // AND THE OBJECT-ID TIE-BREAK SURVIVES, FOR PLAYERS ONLY.
    //
    // Two CHARACTERS meeting head-on both run this identical function, so a fixed order
    // makes them both dodge the same way, collide, both dodge back, and mirror each other
    // indefinitely — watched live and described exactly: "like two people stuck in a
    // hallway, I'll go left, no you go left, no my left, no your left". Ordering by the
    // mover's own object id makes them prefer opposite sides by construction.
    //
    // That argument is entirely about a blocker that is ALSO dodging. A troll is not, so
    // applying it there bought nothing and cost the fixed order the operator asked for —
    // half the fleet would take the long way round the same body for no reason. So the
    // swap is now conditional on what is actually in the way.
    if (blockerIsPlayer && (prefer & 1)) sides = [sides[1], sides[0]];
    // `standable`: somewhere to step round a body is somewhere a body can BE, which is a
    // question about floor rather than about the server's byte. `moverStepLands` still has
    // to authorise the step itself, so this only widens the candidates, never the rules.
    const free = (r, c) => geo.standable(r, c) && !occupied.has(`${r},${c}`);
    const canStep = (fr, fc, tr, tc) =>
      !blockedEdges.has(`${fr},${fc}>${tr},${tc}`) && geo.moverStepLands(fr, fc, tr, tc);

    for (const s of sides) {
      const tr = was.row + s.dr, tc = was.col + s.dc;
      if (!free(tr, tc) || !canStep(was.row, was.col, tr, tc)) continue;
      // From the side square, can we reach the square BEYOND the blocker — i.e. carry on
      // in the direction we were going? That is the whole point; stepping aside and back
      // again achieves nothing.
      const br = blocked.row + dr, bc = blocked.col + dc;
      if (free(br, bc) && canStep(tr, tc, br, bc))
        return { back: null, through: { row: tr, col: tc }, beyond: { row: br, col: bc } };
      // Otherwise settle for reaching the blocked square itself from the side, which is
      // the case where the body is standing in a doorway we can enter at an angle.
      if (canStep(tr, tc, blocked.row, blocked.col))
        return { back: null, through: { row: tr, col: tc } };
    }

    // NOTHING WORKED FROM HERE, SO BACK UP AND TRY AGAIN — the operator's own suggestion,
    // and the reason it is second rather than first is that retreating costs a step and
    // is usually unnecessary. Standing hard against a body the diagonal past it is often
    // refused for clearance; one square back it is not.
    const br0 = was.row - dr, bc0 = was.col - dc;
    if (!free(br0, bc0) || !canStep(was.row, was.col, br0, bc0)) return null;
    for (const s of sides) {
      const tr = br0 + s.dr, tc = bc0 + s.dc;
      if (!free(tr, tc) || !canStep(br0, bc0, tr, tc)) continue;
      if (canStep(tr, tc, blocked.row, blocked.col) ||
          (free(blocked.row + dr, blocked.col + dc) &&
           canStep(tr, tc, blocked.row + dr, blocked.col + dc)))
        return { back: { row: br0, col: bc0 }, through: { row: tr, col: tc } };
    }
    return null;
  }

  // COORDINATE CONTRACT: this public movement API is `(col,row)`. Named position
  // objects remain `{ col, row }`; geometry adapters below reverse positional calls.
  async walkTo(col, row, {
    maxSteps = 120,
    hardCap = 400,
    movementGeneration = this.movementGeneration,
    controlToken,
    beforeMutation = null,
    // Squares to route around, as `row,col` strings. See the note beside `occupied`.
    avoidSquares = null,
    // KEEP OFF THE WALLS ON THE WAY PAST THEM — OPT IN, AND OFF BY DEFAULT.
    //
    // See RoomGeometry.clearanceField. It is right for CROSSING a room and wrong for a
    // walk to a square somebody has already chosen tactically: a safe wall is a tight
    // square BY DEFINITION — that is the whole mechanism, the coarse grid and the BSP
    // disagreeing — and the fleet must not be taught to shy away from the thing the game
    // is balanced around. `leaveVia` turns it on, because walking to a boundary is the
    // long routing where a slid step starts the bounce. A pull, a melee approach and a
    // walk back to a held wall all leave it off and plan exactly as they did before it
    // existed.
    clearance = 0,
  } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me0 = c.self ?? await this.selfOrResync();
    if (!me0) return { arrived: false, reason: 'own_position_unknown',
                       note: 'own position is unknown and a re-read did not recover it' };
    // "ALREADY THERE" IS A SUCCESS REPORT, SO IT HAS TO BE CHECKED LIKE ONE.
    //
    // `c.self` is a belief. `predictSelf` writes to it after every proved leg without a
    // read-back, and a DM relocate moves the body on the server with the client learning only
    // when the next room read lands — so there are two ordinary ways for it to be stale, and
    // both of them end here returning `arrived: true, steps: 0` for a body somewhere else.
    //
    // Seen immediately after the false-arrival fix below, 2026-08-28: a walk that had wrongly
    // predicted 46,15 left the belief there; the body was relocated to 47,14; `/state` said
    // 47,14 and this said "already there". A zero-step success is exactly the shape a caller
    // cannot argue with — no steps taken, nothing refused, nothing to retry.
    //
    // One read, and only on this path: every other route through `walkTo` does real work and
    // pays for its own confirmation at the end.
    if (me0.col === col && me0.row === row) {
      // Optional, for the reason `aimInto` guards its own calls: this method is lifted out of
      // this file by text and run against fixtures that have only what they inject, and a bare
      // call is a TypeError rather than a missing confirmation. `confirmPosition` IS on the
      // real prototype — this is not a call to a name that never existed, which is the other
      // failure this repository has had today and a different thing entirely.
      // Same rule as the proved-route return below: an unconfirmed position cannot certify
      // that we are already somewhere. This site was added to CATCH a false arrival and
      // repeated the cause -- it awaited the confirmation and then read the prediction.
      const ok0 = await this.confirmPosition?.().catch(() => null);
      const now0 = ok0 ?? c.self ?? me0;
      if (ok0 && now0.col === col && now0.row === row)
        return { arrived: true, position: { col, row }, steps: 0, note: 'already there' };
      // The belief was stale. Carry on and walk it properly from where we actually are.
      me0.col = now0.col; me0.row = now0.row; me0.x = now0.x; me0.y = now0.y;
    }

    if (!geo) {
      return { arrived: false, steps: 0, reason: 'collision_geometry_unavailable',
               position: { col: me0.col, row: me0.row },
               note: 'no movement packet was sent because the server does not validate player geometry' };
    }

    // If something has parked us on a square with no floor, no route exists from it at
    // all. The server does not check walls for players, so we can simply step onto
    // solid ground and carry on — but it has to be done deliberately, because from
    // here the pathfinder has nothing to say.
    //
    // `standable`, NOT `walkable`, AND THIS ONE IS LOAD-BEARING. Asked the coarse grid's
    // way, a character standing in a diagonal corridor square that the grid rounds down to
    // wall — 137 such positions are recorded in the operator's own walk logs — reads as
    // "parked off the floor" and gets DRAGGED to `nearestWalkable` before the walk even
    // begins. That is the opposite of the repair: it takes a character that is standing
    // somewhere perfectly legitimate and moves it, every walk, for ever.
    if (!geo.standable(me0.row, me0.col)) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      const spot = geo.nearestWalkable(me0.row, me0.col);
      if (!spot) {
        // TWO VERY DIFFERENT FAILURES USED TO SHARE ONE NAME, and the common one is not
        // the one the name describes.
        //
        // `nearestWalkable` searches out to twelve squares. Cibilo Creek Inn is TEN ROWS
        // BY THIRTEEN COLUMNS — that radius covers the whole room twice over, and every
        // square in it and around it resolves to floor — and yet `start_has_no_floor` was
        // the single commonest travel failure on the shadow fleet: 1,535 of 2,361 hop
        // failures in fourteen hours, 404 of them on one character, ALL of them leaving
        // room 153. A character genuinely parked in solid rock cannot produce that.
        //
        // What produces it is the position and the geometry belonging to DIFFERENT ROOMS.
        // 153's only real exit declares `arriveRow: 11, arriveCol: 59` in room 150; read
        // those coordinates against 153's thirteen columns and the character is forty-six
        // squares outside the map, so every ring of the search is empty and the answer is
        // null. The character is not off the floor. The floor is the wrong floor.
        //
        // So the two are named apart. This changes no behaviour — both still refuse, and
        // `TERMINAL_MOVEMENT_REASONS` covers both — but a refusal that names the right
        // condition is the difference between a fixable bug and 1,535 rows of noise. The
        // bounds are reported with it so the next reader does not have to re-derive them.
        const rows = Number(geo.rows), cols = Number(geo.cols);
        const outside = Number.isFinite(rows) && Number.isFinite(cols) &&
          (me0.row < 0 || me0.col < 0 || me0.row > rows + 1 || me0.col > cols + 1);
        if (outside)
          return { arrived: false, reason: 'position_outside_room_geometry',
                   note: 'the character is standing outside the bounds of the room geometry ' +
                         'loaded for it — the two are almost certainly different rooms, which ' +
                         'is a room-change race and not a hole in the map',
                   position: { col: me0.col, row: me0.row },
                   geometry: { rows, cols, room: this.world?.room?.num ?? null,
                               name: this.world?.room?.name ?? null } };
        return { arrived: false, reason: 'start_has_no_floor',
                 note: 'standing off the floor with no walkable square anywhere near',
                 position: { col: me0.col, row: me0.row },
                 geometry: { rows: Number.isFinite(rows) ? rows : null,
                             cols: Number.isFinite(cols) ? cols : null } };
      }
      // CONFIRMED, because this is the one place the ANSWER is the question. Everywhere
      // else `step` is asked "where am I now" and prediction answers it; here it is asked
      // "did that work", and a predicted yes would report solid ground under a character
      // still standing off the floor — from which no route exists at all.
      const half = KOD_FINENESS >> 1;
      const targetX = spot.col * KOD_FINENESS + half, targetY = spot.row * KOD_FINENESS + half;
      const r = await this.stepFine(targetX, targetY);
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, position: r.position ?? { col: me0.col, row: me0.row } };

      // ONE STEP IS NOT ENOUGH TO GET OFF THE GRID, AND FINE MOVEMENT IS THE STRICTER
      // TOOL RATHER THAN THE LOOSER ONE.
      //
      // Measured 2026-08-17: characters really do end up on squares the bake calls
      // unwalkable — Bravo standing at 30,30 in room 587 and Charlie at 25,25 in 566,
      // both `walkable: false`, both perfectly upright on the server, and from there
      // `walkTo` cannot plan at all. `stepFine` asks for ONE clipped step at the nearest
      // floor square, and when the pocket is deeper than one step, or that particular
      // endpoint is refused, the walk ends here with `could not step back onto solid
      // ground` — which is what the three broken boundaries on the Tos-Jasper corridor
      // came down to.
      //
      // `walkFine` is the same collision rules applied up to 120 times with sliding, so
      // it can work its way out where a single step cannot. It is NOT the coarse-grid
      // escape hatch this repository considered and rejected: that one FELL BACK to the
      // server's one-byte grid and relaxed collision, which is the mechanism that let
      // bots climb cliffs. This clips every endpoint against the same BSP the stock
      // client enforces — walls, step heights, slopes, ceilings and the 248-unit player
      // radius — so it is strictly more conservative than the router it is rescuing, and
      // cannot authorise a traversal a person could not make.
      //
      // Second, and only on failure, because it costs packets and the single step is
      // usually enough.
      if (!r.moved) {
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const fine = await this.walkFine(targetX, targetY,
          { maxSteps: 40, movementGeneration, controlToken }).catch(() => null);
        if (isTerminalMovementReason(fine?.reason))
          return { arrived: false, ...fine, position: fine.position ?? { col: me0.col, row: me0.row } };
        const now = c.self;
        // Same question as above — did we reach ground a player can occupy — so it has to
        // be the same predicate, or the recovery declares failure while standing on floor.
        if (!now || !geo.standable(now.row, now.col))
          return { arrived: false, reason: 'could not step back onto solid ground',
                   position: now ?? r.position,
                   recovered_by: 'neither one clipped step nor fine walking reached floor',
                   note: r.note ?? r.reason ?? 'local collision found no safe recovery path' };
      }
    }

    let from = c.self ?? me0;
    // Route round what can see us, at a cost rather than a prohibition — see
    // threatsHere(). Computed once per walk rather than per step: monsters wander, but
    // re-deriving a whole field every square would cost more than the detour saves,
    // and the replan below picks up anything that has moved into the way since.
    const threats = this.threatsHere();
    // THE MASK MAY ONLY EVER PREFER, AND THAT HAS TO HOLD AT PLAN TIME TOO.
    //
    // The replan inside the walk already falls back to the coarse grid when the collision
    // view runs out of routes; the FIRST plan did not, so a goal the model dislikes was
    // refused before a single packet — which is the same silent refusal this whole path
    // exists to remove, just arriving earlier. It bites hardest at doors: an exit anchor
    // for a `go` exit is the door tile itself, a pocket by design, and 346 of the 383
    // anchors this bake cannot reach from their room's body are exactly those. Exempting
    // the last step into the goal recovers 57 of them; the other 326 have the whole
    // approach refused, and for those the answer is to plan on the grid and let the mover
    // clip each step for real — which is what `leaveVia` then finishes with fine
    // positioning.
    //
    // Only when the COLLISION view is what refused. A coarse-grid "no route" is the room
    // telling us something, and re-asking it the same question would just be slower.
    const blockedEdges = new Set();
    // One re-centre per square per walk. Standing in the middle either helps or it does not;
    // trying it twice from the same square is the dither this is meant to remove.
    const recentredAt = new Set();
    // The closest this walk has ever been to its target, and how long since that improved.
    let bestGap = Infinity, sinceCloser = 0;
    // Where the body has already been. A dither revisits; a detour walks new ground.
    const seenSquares = new Set();
    const edgeKey = (fr, fc, tr, tc) => `${fr},${fc}>${tr},${tc}`;
    // AN EDGE THE MOVER CANNOT WALK IS A FACT ABOUT THE MAP, NOT ABOUT THIS WALK.
    //
    // `blockedEdges` is built fresh on every call, so everything the walker learns dies with
    // the walk and is re-learned from nothing on the next replan. For a body in the way that
    // is correct — it will have moved. For GEOMETRY it is amnesia, and it is expensive:
    // measured in room 50, the single step 54,40 -> 53,40 was refused ONE HUNDRED AND
    // THIRTY-FIVE times in one two-character run, 135 of that room's 145 refusals. Offline,
    // `moverStepLands(54,40 -> 53,40)` is false. Both squares are walkable and the step
    // between them is not, so the mover was right every time and the walker asked anyway.
    //
    // Nothing reaches the wire — the local validator refuses first — so this is pure thrash
    // that spends the step budget and the clock while every instrument reports a healthy
    // character with somewhere to be.
    //
    // Where it comes from is the deliberate escape hatch above: when the collision-aware
    // pathfinder finds no route, `replan` re-asks with `collision: false`. That plan is
    // allowed to contain edges the mover refuses — the point is that fine positioning
    // usually rescues them — but the ones that are geometrically impossible have to be
    // learned ONCE and remembered, or the same blind plan comes back unchanged.
    //
    // Only provable impossibility is kept. `object_blocked` is never persisted: a troll
    // moves, and remembering it would carve permanent holes in a room over a long session.
    const roomNow = Number(geo?.num ?? this.world?.room?.num ?? NaN);
    const impossibleHere = Number.isFinite(roomNow)
      ? ((this.impossibleEdges ??= new Map()).get(roomNow)
         ?? this.impossibleEdges.set(roomNow, new Set()).get(roomNow))
      : null;
    if (impossibleHere) for (const e of impossibleHere) blockedEdges.add(e);

    // BLOCKED EDGES GO INTO THE FIRST QUESTION, NOT ONLY THE LATER ONES.
    //
    // The re-plan twenty lines down has always passed `blockedEdges`; the OPENING plan never
    // did, so every walk began blind to everything the walker already knew. That was
    // invisible while the set was rebuilt empty on each call — there was nothing to be blind
    // to. The moment the room's impossible edges survive a walk, the opening plan is the one
    // place they have to be honoured, or they are learned for ever and consulted never.
    //
    // It matters most for the `collision: false` fallback: that plan is ALLOWED to contain
    // edges the mover refuses, which is the whole point of it, and the blocked set is the
    // only thing that stops it proposing the same refused edge on every attempt.
    // PATH JITTER, re-applied onto upstream's replan. A small per-agent cost bias on
    // intermediate cells, so two characters walking to the same place take slightly
    // different routes instead of stacking on each other. THE GOAL IS NEVER JITTERED --
    // only the ground between start and goal -- so the character still arrives exactly
    // where it was sent. It rides on `extraCost`, which is why that parameter was kept
    // alongside upstream's `clipCost` when the two collided in m59-roo.mjs's A*.
    let jitterCost = null;
    if (this.name && Math.abs(from.row - row) + Math.abs(from.col - col) > 3) {
      let h = 0;
      for (const ch of this.name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      jitterCost = (r, c) => {
        // Only bias cells that are already walkable -- never penalise the only viable
        // cell in a corridor, which would turn a preference into a refusal.
        if (!geo.standable(r, c)) return 0;
        const v = ((r * 7919 + c * 104729 + h) & 0xff) / 255;
        return v > 0.7 ? 0.3 : 0;
      };
    }
    const replan = (r, cc) => {
      const avoid = new Set([...(avoidSquares ?? []), ...(this.hazardSquares?.() ?? [])]);
      let p = geo.path(r, cc, row, col, { avoid, blockedEdges, threats, clearance, extraCost: jitterCost });
      if (!p.found && p.collision_view)
        p = geo.path(r, cc, row, col, { avoid, blockedEdges, threats, clearance, collision: false, extraCost: jitterCost });
      return p;
    };
    let plan = replan(from.row, from.col);
    // NO ROUTE FROM HERE USUALLY MEANS "HERE IS A POCKET", NOT "THERE IS UNREACHABLE".
    //
    // Both are refusals of the same shape and only one of them is about the destination.
    // A character standing on a safe wall is standing where the coarse grid and the BSP
    // disagree — that is what a safe wall IS — and to the collision view that square is
    // frequently cut off from its own room's exits. Walking the breadcrumbs back undoes
    // whatever got it in there, and the plan is re-asked from wherever that lands.
    let escaped = 0;
    if (!plan.found && !plan.stuck) {
      const out = await this.retreatAlongBreadcrumbs({
        movementGeneration, controlToken,
        until: () => replan(c.self?.row ?? -1, c.self?.col ?? -1).found,
      });
      if (out.cancelled) return out;
      escaped = out.steps ?? 0;
      if (out.moved) {
        from = c.self ?? from;
        plan = replan(from.row, from.col);
      }
    }
    if (!plan.found) {
      // COARSE GRID FOUND NO ROUTE — TRY THE FINE GRID. The coarse grid is a
      // 1-byte-per-square projection of the BSP. A square it calls unwalkable
      // (step height, ledge, diagonal wall, or a gap between polygons) may be
      // perfectly fine at the fine resolution. walkFine navigates using BSP
      // collision directly and can find routes the coarse grid cannot see.
      // This is the last resort: the fine grid is slower (one confirmed step
      // per second) but more accurate.
      const half = KOD_FINENESS >> 1;
      const destX = col * KOD_FINENESS + half;
      const destY = row * KOD_FINENESS + half;
      if (process.env.M59_EXIT_DEBUG !== '0')
        console.error(`[walkTo] ${this.name ?? '?'} coarse grid failed (${plan.reason}), trying fine grid to (${destX},${destY}) [fine x,y in kod units; requested square r${row}c${col}]`);
      // `arriveWithin: 100` WAS A TOLERANCE OF ONE AND A HALF SQUARES, AND IT REPORTED
      // ARRIVAL WITHOUT MOVING.
      //
      // KOD_FINENESS is 64, so 100 kod units is 1.56 squares: any target inside that reads
      // as reached from where the body already stands. Measured on prod 2026-09-10, trying
      // to walk Beaker out of Kardde's Canyon (room 49) across its north edge to 593. He
      // stood at x1348 y124; aiming one square PAST the boundary at r0c21 computes
      // destX 1376, destY 32, and hypot(28, 92) = 96.2 < 100 — so:
      //
      //     r0c21  ->  { arrived: true, steps: 0, position: { col: 21, row: 1 } }
      //
      // A false success on the exact manoeuvre that crosses a room boundary, which is
      // "walk one square outward". Anything trying to leave a room that way is told it
      // worked and has not moved, and the room it wanted is one hop away for ever. Aiming
      // at r-1c21 instead DID cross — and returned `arrived: false, "goal is outside the
      // room grid"`, so the reply was wrong in both directions at the same boundary.
      //
      // Half a square (32) is inside one square, so a neighbouring target now requires
      // real movement to satisfy. And the SQUARE IS CHECKED, not just the distance: a
      // tolerance is a claim about proximity and `arrived` is a claim about a square, and
      // conflating them is what made a 0-step walk a success. Same rule as everywhere else
      // here — verify the value, not the instrument.
      const fine = await this.walkFine(destX, destY, {
        maxSteps: Math.max(60, Math.ceil(Math.hypot(col - from.col, row - from.row) * 2)),
        stride: 48, arriveWithin: half,
        movementGeneration, controlToken,
      }).catch(e => ({ arrived: false, reason: e.message }));
      const landedOn = fine.position && Number.isFinite(fine.position.col)
        ? { col: fine.position.col, row: fine.position.row } : null;
      const onTheSquare = !landedOn || (landedOn.col === col && landedOn.row === row);
      if (fine.arrived && onTheSquare)
        return { arrived: true, steps: fine.steps, position: fine.position,
                 note: 'coarse grid found no route; fine grid walked it' };
      if (fine.arrived && !onTheSquare)
        // Inside the tolerance and on the WRONG SQUARE. Reported rather than rounded off,
        // because the caller asked for a square and a boundary crossing depends on which
        // one the body is standing on.
        return { arrived: false, reason: 'the fine walk stopped inside its tolerance but on ' +
                   `r${landedOn.row}c${landedOn.col}, not the r${row}c${col} that was asked for`,
                 position: fine.position, steps: fine.steps,
                 note: 'a tolerance is a claim about distance; `arrived` is a claim about a square' };
      return { arrived: false, reason: plan.reason, position: { col: from.col, row: from.row },
               ...(plan.stuck ? { nearest_floor: plan.nearest_floor } : {}),
               ...(escaped ? { retreated: escaped } : {}),
               fine_reason: fine.reason,
               note: escaped
                 ? 'no route even after walking the breadcrumbs back out of the pocket'
                 : 'the geometry says there is no route to that square from here' };
    }

    // If a route exists, walking it is what was asked for. Refusing partway because of
    // a caller's default budget is a silent failure dressed as a limit — so the plan
    // itself raises the ceiling, and only a genuinely runaway walk is capped.
    //
    // AND THE PLAN LENGTH IS NOT THE STEP COUNT, IN THE ROOMS WHERE THIS MATTERS.
    //
    // `plan.steps.length + 10` assumes one packet per planned square. That holds in open
    // ground and fails exactly where the fleet gets stuck: the router validates a step
    // centre-to-centre and the mover SLIDES, so after the first slide the body is never on
    // a centre again and a planned step lands next door instead. Each of those costs a
    // replan and another packet, and none of them is a wasted step — the walk is learning
    // the edge or gaining ground.
    //
    // Measured offline against the real baked geometry, driving the real `path`,
    // `standPoint` and `traceFineMoveClient` with the fine position carried forward, over
    // walks from random floor to the room's own baked exit anchors (12 per room, only
    // starts the router says are routable):
    //
    //                                    plan-length budget    x3
    //   598 The Cragged Mountains              4/12          6/12
    //   599 Ukgoth                             3/12          5/12
    //   575 The King's Way                     5/12          8/12
    //   all 21 cycle rooms                  203/252       211/252
    //   of which failed on the step budget      33             8
    //
    // The rooms that do not slide are unaffected — 587, 597, 576, 50, 150 and the Barloque
    // pair all measure a steps/plan ratio of 1.00 — so this is not a blanket loosening: it
    // is a ceiling that stops binding in the four rooms where the plan was never the number
    // of packets. `hardCap` (400) still bounds the whole walk, and the REPLAN budget still
    // ends a walk that is neither learning nor closing, which is the one that is actually
    // going nowhere.
    const budget = plan.steps.length * OFF_PLAN_STEP_BUDGET + 10;
    if (budget > maxSteps) maxSteps = Math.min(budget, hardCap);

    // WALK THE PROVED ROUTE FIRST — see walkPivots, and the argument there for why this is
    // the whole fix rather than another reaction to a deviation. The pull is taken from
    // where the body ACTUALLY is, not from the middle of its square, because that is the
    // line that will be walked.
    //
    // Everything below is untouched and is what runs when this cannot finish the job: a
    // leg the pull could not prove, a refused move, a body in the way, a room that animated
    // under it. Falling through costs one plan and loses nothing — which is the property
    // that makes it safe to put in front of a walker this fleet depends on.
    let pivotLegs = 0, fallbackWhy = 'route uses the fallback walker';
    if (geo.collisionReady && typeof geo.stringPull === 'function' && plan.steps.length > 1
        && !this.movementWasCancelled(movementGeneration, controlToken)) {
      const here = c.self;
      const startPt = here && Number.isFinite(here.x)
        ? { x: protocolToClient(here.x), y: protocolToClient(here.y) } : null;
      const half2 = KOD_FINENESS >> 1;
      const ptOf = st => geo.standPoint?.(st.row, st.col)
        ?? { x: protocolToClient(st.col * KOD_FINENESS + half2),
             y: protocolToClient(st.row * KOD_FINENESS + half2) };
      if (startPt) {
        // THE STOPS ARE WORKED OUT NOW, WHILE THE ROUTE IS BEING PLANNED, AND NOT LATER FROM
        // A STANDSTILL. `this.shelterPolicy` is set by whoever asked for the walk — the
        // keeper, during a journey — and is absent for every other caller, so an ordinary
        // walk pays nothing for this beyond one pass over the plan.
        const sp = this.shelterPolicy;
        const shelter = sp?.need
          ? { spots: sheltersAlong(geo, plan.steps,
                                   { book: sp.book ?? null, room: c.room?.num ?? null,
                                     unreachable: sp.unreachable?.(c.room?.num) ?? null,
                                     within: sp.within ?? 6 }),
              need: sp.need, maxDetour: sp.maxDetour ?? 5, onDivert: sp.onDivert ?? null,
              onArrive: sp.onArrive ?? null }
          : null;
        const ran = await this.walkPivots(plan.steps, geo,
                                          { movementGeneration, controlToken, shelter });
        fallbackWhy = ran.why ?? 'pivot route did not reach its destination';
        pivotLegs = (ran.legs ?? 0) + (ran.singles ?? 0);
        if (ran.cancelled) return this.cancelledMovement({ steps: pivotLegs });
        if (ran.left_room)
          return { arrived: false, left_room: true, steps: pivotLegs,
                   note: 'a proved leg crossed the room edge' };
        if (pivotLegs) {
          // ONE READ AFTER THE RUN, NOT ONE PER LEG. The prediction is what the proof
          // licenses; this is the single confirmation that the world agrees, and it is the
          // same trade `step` makes across a whole hop rather than per square.
          // A CONFIRMATION THAT TIMED OUT IS NOT A CONFIRMATION, AND THIS IS WHERE THAT
          // COST THE MOST.
          //
          // `confirmPosition` answers null when the room-contents read does not land inside
          // its 8s deadline -- its own comment says callers "already treat an unknown
          // position as a wrong one", and this caller did not: it threw the verdict away and
          // read `c.self`, which after a proved leg is the DEAD-RECKONED PREDICTION of the
          // target. So `at.col === col && at.row === row` was true by construction, and every
          // timed-out confirm became `arrived: true, note: 'walked the proved route'` on a
          // walk that moved nobody.
          //
          // Measured on the shadow fleet in The Flatlands, 2026-08-28: 35,29 -> asked for
          // 35,35 -> still 35,29, no damage taken, and the mover reported success. A room
          // busy enough to delay a read -- spiders, ants, other characters -- is exactly the
          // room where this fires, which is why it looked like a corridor that could not be
          // threaded rather than a lie about having threaded it.
          const confirmed = await this.confirmPosition();
          const at = confirmed ?? c.self ?? await this.selfOrResync();
          if (confirmed && at.col === col && at.row === row)
            return { arrived: true, position: { col, row }, steps: pivotLegs, replans: 0,
                     pivots: pivotLegs, note: 'walked the proved route' };
          // Not there: re-plan from wherever the proved part left us and carry on below.
          if (at) {
            from = at;
            const again = replan(at.row, at.col);
            if (again.found) plan = again;
          }
        }
      }
    }

    let queue = plan.steps.slice();
    let taken = pivotLegs, replans = 0;
    // ITERATIONS THAT SENT NOTHING. A step the validator refuses returns in a tenth of a
    // millisecond with no packet; a replan costs a few; and `learned` — a newly blamed edge
    // — exempts the iteration from the replan budget. In a room with thousands of edges that
    // is a loop that runs at hundreds of iterations a second, sends nothing, and never
    // yields, so the keepalive timer and the HTTP server starve, the server logs the session
    // out at 30 s of silence, and the journey is lost. Measured on 2026-09-01 in the Sewers
    // of Barloque: four keepers at r59c35, 99% of a core each, sent_per_sec 0, and no
    // ledger rows because none of these branches writes one. Two bars: yield to the event
    // loop every few packetless iterations so the timers run, and give up out loud after a
    // few hundred, because a walk that has not sent a packet in that long is not walking.
    let packetless = 0;
    // A STEP A MONSTER REFUSED IS NOT A STEP THE ROUTE SPENT.
    //
    // `maxSteps` exists to stop a walk that is going nowhere. A body in the way is going
    // nowhere for a completely different reason, and the walk's own reply already says so
    // — "N monster collision(s) during travel ate the budget; the route itself was not
    // refused" — while nothing acted on it. So a busy doorway exhausted the budget before
    // the geometry ever got a fair try, and the walker reported a wall.
    //
    // Traced live crossing the Western border of the Twisted Wood, a room whose west door
    // is one body wide: 14 and then 19 monster collisions inside a 40-step budget, seven
    // stumbles, five minutes, and 6-17 health lost per attempt. That is the room's 19 prod
    // deaths in eight hours, and the geometry was never the thing that ran out.
    //
    // Refunded, not waived — and the refund is bounded by the budget itself, so a walk can
    // be pushed through traffic at most twice over and a corridor that is permanently
    // plugged still ends. The damage checks above are untouched: a character being HIT
    // still gives up early, because bleeding out in a doorway is the failure this is meant
    // to prevent, not one to be patient about.
    let refunded = 0;
    // How much fine threading one walk may spend. Each is a bounded A* plus a few validated
    // moves; the cap is what stops a genuinely sealed pocket paying for it over and over.
    let fineDetours = 0;
    const FINE_DETOUR_MAX = Number(process.env.M59_FINE_DETOURS || 12);
    const FINE_DETOUR_NODES = Number(process.env.M59_FINE_DETOUR_NODES || 4000);
    const FINE_DETOUR_MARGIN = Number(process.env.M59_FINE_DETOUR_MARGIN || 4);
    // AND A REPLAN THAT GOT US CLOSER IS NOT A WASTED REPLAN.
    //
    // `replanBudget` is 8 plus a tenth of the plan, so a 65-step crossing gets about 14.
    // That is a fine allowance for "the route was stale" and far too small for what these
    // rooms actually do: the mover SLIDES, so a walk lands off its planned square
    // constantly, replans from where it really is, and carries on — measured offline
    // against the real geometry, Western border of the Twisted Wood arrives at 5.35x the
    // planned step count and The Cragged Mountains at 6.58x. A budget of 14 cannot reach
    // the end of either, so the walk was guaranteed to report "kept ending up somewhere
    // other than the planned square" no matter how well it was going.
    //
    // Traced live on 587 after the monster refund above: two collisions, three health, and
    // still no arrival — the budget ran out while the character was making ground.
    //
    // So the budget is spent on replans that get us NO CLOSER, which is the thing it was
    // always meant to catch. Distance is Chebyshev to the target square, the same metric
    // the router's heuristic uses. A walk that keeps closing the gap keeps its allowance;
    // one that is genuinely going nowhere still ends after the same fourteen tries.
    let closest = Infinity;
    // THE SHORTEST ROUTE SEEN, WHICH IS WHAT PROGRESS ACTUALLY MEANS IN A ROOM THAT BENDS.
    // See the replan budget below: crow-fly distance is the wrong measure the moment the
    // way out goes AWAY from the goal first, and the Cragged Mountains does exactly that.
    let shortestRoute = Infinity;
    // AND ROUTING ROUND A LIVE OBSTACLE COSTS REPLANS THAT THE ROUTE DID NOT.
    //
    // The budget is an allowance for the MAP being wrong. A monster in the way is not the
    // map being wrong — it is the map being briefly occupied, and getting round it is
    // exactly the work we want the walker to do. Charging that to the same purse means a
    // busy corridor spends the allowance meant for genuine dead ends, and the walk reports
    // a route failure for what was traffic.
    //
    // Worth knowing what this refund is trusting. `object_blocked` is OUR pass, in
    // m59-roo.mjs, and the RULE is not a guess: it reproduces the server's own
    // MoveObjectAllowed — obstacle as a square, one coordinate pushed to its edge, the
    // modified point taken only if walls allow it. What it cannot be sure of is WHERE the
    // obstacle is, because positions arrive on the server's push and a moving monster's
    // can be a second stale. So the refund is bounded rather than open: a real wall
    // misreported as a body would otherwise buy itself unlimited retries.
    let collisionReplans = 0;
    const collisionReplanMax = Number(process.env.M59_COLLISION_REPLANS || 12);
    // SQUARES SOMETHING IS STANDING ON. The geometry models walls and knows nothing
    // about occupancy, and these rooms cap at seven to twelve monsters — so the common
    // reason a step does not happen is that something is in the way.
    const occupied = new Set();
    // SQUARES THAT WOULD FIRE THE WRONG DOOR. A boundary is not one exit: the server picks
    // between the exits on an edge by evaluating a condition on the crossing square, so on a
    // split edge some of that boundary leads somewhere we are not going. Standing there and
    // sliding one square is how `587 -> 597` reported the crossing and landed in 586 THIRTEEN
    // TIMES in one leg — a hundred and eighty seconds in one room without leaving it.
    //
    // Passed in rather than derived here, because only the caller knows which door it wants.
    for (const sq of (avoidSquares ?? [])) occupied.add(sq);
    for (const sq of (this.hazardSquares?.() ?? [])) occupied.add(sq);
    // AND EDGES THE MOVER WILL NOT CROSS, WHICH IS A DIFFERENT FACT AND WAS NOT RECORDED
    // AT ALL. A monster moves; a wall does not. Blaming the SQUARE for a wall between two
    // squares removes a perfectly good place to stand that other neighbours still reach,
    // and — much worse — a step that SLID and landed one square sideways recorded nothing
    // whatever, so the replan from the new position produced the same step and the walker
    // bounced along the wall until its replan budget ran out.
    //
    // Measured offline against the baked geometry, on the twelve boundaries the exit-gap
    // record complains about most: 249 of 422 walks to an exit — 59% — died exactly that
    // way, with trails reading `4,15->5,15=5,15` / `5,15->4,16=4,15` over and over. Nobody
    // was trapped: the same rooms are 96-100% connected to their own exits when the mover's
    // edges are the ones being walked. The walker simply never learned.
    // LONG HOPS THAT WERE SENT, MOVED THE BODY, AND DID NOT ARRIVE.
    //
    // Not a blocked edge: nothing refused it, and a single step along the same line is
    // usually fine — it is the LENGTH that fails, because the move slides and lands
    // somewhere the plan did not ask for. `blockedEdges` records refusals and so never
    // learns this, and the reach collapse below is undone by the next arrival.
    //
    // Which is how a character with 200 health, taking no damage at all, spent sixty
    // seconds inside three squares of the Cragged Mountains: 30,33 -> 36,34 slides to
    // 30,32; 30,32 -> 31,35 slides to 29,34; 29,34 -> 30,33 ARRIVES, which restores the
    // full reach — and the six-square hop that never works is offered again. Thirty-two
    // moves sent, none refused, no progress.
    const missedHops = new Set();
    let stalledOn = null, stalledTimes = 0;
    // THE SQUARE WE WERE IN BEFORE THE ONE WE ARE IN NOW. A refused FALL is a bad approach
    // rather than a bad ledge, and blaming it needs the step before last — see the learning
    // block below.
    let prevSquare = null;
    // MONSTER COLLISION DURING TRAVEL, kept as its own fact. See the block below that
    // increments these: a body is not a wall, it moves, and a walk that failed because of
    // one has a completely different remedy from a walk the geometry refused.
    let monsterBlocks = 0;
    // ONCE PER WALK. Backing up to make an attacker follow is the last tier and it costs
    // ground; doing it repeatedly is how a character walks backwards out of a corridor it
    // was trying to cross. If one retreat does not free the square, the ordinary occupancy
    // replan below is the honest answer.
    let retreatedFromBodies = false, bodyRetreats = 0;
    const blockedBy = new Set();       // squares a body was standing on
    const sidestepped = new Set();     // squares we have already tried to go round, once each
    const lanedPast = new Set();
    const perpWalked = new Set();
    const blinkAsked = new Set();
    const killTried = new Set();
    const blockedSince = new Map();      // squares we have already tried to thread past, once each
    // HOW OFTEN THE MOVER PUT US SOMEWHERE THE PLAN DID NOT ASK FOR. See the note where
    // this is incremented; past a handful it means the square-by-square plan is not the
    // thing being walked, and continuing to replan it is how a room takes three minutes.
    let offPlan = 0, wentFine = false;
    // HOW FAR ONE MOVE MAY REACH, WHICH IS NOT A CONSTANT ONCE A LONG ONE HAS FAILED.
    //
    // Coalescing turns a walk into a few long moves, which is the whole point of proving a
    // route once. It also means a move that fails costs its whole length: measured in
    // Outskirts of Tos, a character sat on one square for 106 counted steps — about fifteen
    // identical seven-square attempts — because a failed hop is retried as the SAME hop,
    // and every retry billed seven. Single steps from that square worked in all four
    // directions the entire time.
    //
    // So the reach collapses to one after a long move fails and climbs back on success. A
    // walk can still be long-legged where the ground allows it and always has the single
    // step to fall back on, which is the move the geometry was actually asked about.
    let hopLimit = MOVE_HOP_MAX_SQUARES;
    // The current plan's pulled proof, or null when it has none. `undefined` means "not
    // computed for this queue yet"; every place that REPLACES the queue resets it.
    let pulled;
    // Health across the walk, so a body in the way can be told from a body that is EATING
    // us. See the under-fire note in the blocked branch below.
    let hpAtLastBlock = c.vitals?.()?.health?.value, damageWhileBlocked = 0, underFire = false;
    while (queue.length && taken < maxSteps) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: taken, replans });
      // A fallback still belongs to the journey's survival policy. Transfer to
      // its recovery controller before another step, retaining explicit intent.
      if (await this.shelterPolicy?.onFallback?.({movementGeneration,controlToken,why:fallbackWhy}))
        return this.cancelledMovement({steps:taken,replans});
      if (this.movementWasCancelled(movementGeneration,controlToken))
        return this.cancelledMovement({steps:taken,replans});
      // ONE PACKET, SEVERAL SQUARES — as long as they are in a STRAIGHT LINE.
      //
      // The planned route is a list of adjacent squares, and sending one packet per
      // square is what made us four times slower than a person while sending four
      // times as many packets. A real client reports a position about once a second
      // and the ground it crossed in between is never transmitted at all.
      //
      // Collinear only, and that restriction is the whole safety argument: every
      // square between here and the far end is a square the router already accepted,
      // so the line we skip along is the line we planned. Coalescing across a TURN
      // would cut the corner — through whatever the turn was avoiding — which is the
      // one way this could put a character through a wall on purpose.
      // AND COLLINEAR IS TOO NARROW A TEST ON GEOMETRY THAT IS NOT AXIS-ALIGNED.
      //
      // The paragraph above is right that coalescing across a turn could cut a corner —
      // IF the only thing known about the skipped ground is that the router accepted the
      // squares. But there is a stronger check available and it is the one the mover
      // itself uses: trace the straight line and require it to ARRIVE, with `slide:false`.
      // A line that arrives without sliding has not clipped anything, whatever direction
      // it runs, so the corner-cutting argument does not apply to it.
      //
      // This matters because the rooms are not boxes. Room 587's wall length is 54.9% NOT
      // axis-aligned; the exit to the Twisted Wood is a 45 degree run. Measured there,
      // stepping centre-to-centre along a grid route fails 218 of 311 steps, and 200 of
      // those 218 — 92% — do not move the character AT ALL. Collinear coalescing cannot
      // help with any of them, because the refused step is a single step.
      //
      // Same six routes, reaching as far as the line still clears: 311 grid steps become
      // 66 pivots. See RoomGeometry.stringPull and m59-stringpull-test.mjs.
      let next = queue.shift();
      let hop = 1;
      // A HOP THAT MISSED FROM A GIVEN SQUARE IS NOT TRIED FROM THAT SQUARE AGAIN.
      // Declared outside the loop — see `missedHops` above the loop.
      // THE SQUARES A COALESCED HOP SWALLOWED, kept so they can be given back if it misses.
      // See the `hop > 1` branch below: without these, collapsing the reach to one achieves
      // nothing, because the only square left on the queue is the far end of the hop that
      // just failed.
      const skipped = [];
      const from0 = c.self ? { col: c.self.col, row: c.self.row, x:c.self.x, y:c.self.y } : null;
      // THE SECOND AIM, AND IT HAS TO MATCH THE FIRST. This traces a straight line across
      // several squares to decide which of them may be skipped, so if it measured that
      // line between CENTRES while `step` sends stand points, the line proved clear is not
      // the line walked. `standPoint` is the centre for every ordinary square, so this is
      // unchanged wherever the old aim was right.
      const half0 = KOD_FINENESS >> 1;
      const fineOf = s => geo.standPoint?.(s.row, s.col)
                       ?? { x: protocolToClient(s.col * KOD_FINENESS + half0),
                            y: protocolToClient(s.row * KOD_FINENESS + half0) };
      const arrives = (a, b) => {
        const t = geo.traceFineMoveClient?.(a.x, a.y, b.x, b.y, { slide: false });
        return !!t && Math.hypot(t.x - b.x, t.y - b.y) <= PIVOT_ARRIVE_WITHIN;
      };
      // THE PULL, IF THE CURRENT PLAN HAS ONE. Recomputed only when the queue was
      // replaced (a new plan), never per step — that is the entire point.
      // OVER THE WHOLE PLAN, INCLUDING THE SQUARE ALREADY SHIFTED OFF. `next` came out of
      // the queue a few lines above, so pulling `queue` alone proves a line that starts one
      // square further on — and then the very first thing asked, "is `next` on a proved
      // leg", is false about a square the pull never saw. Measured: the proof was perfect
      // offline (30 steps -> 2 pivots, one proved leg, 30 of 31 squares) and did nothing at
      // all live, 26 steps before and 26 after.
      if (pulled === undefined)
        pulled = provedSquares(geo, from0 ?? me0, next ? [next, ...queue] : queue);
      if (from0 && geo.collisionReady) {
        // FROM WHERE THE CHARACTER ACTUALLY IS, NOT FROM THE MIDDLE OF ITS SQUARE.
        //
        // This trace decides which squares may be SKIPPED, so the line it proves clear has
        // to be the line that gets walked — the same "second aim has to match the first"
        // argument as the comment above, applied to its other end. `fineOf(from0)` is the
        // stand point of the square we are IN, and after the first slide the walker is not
        // standing there: `offPlan` below exists precisely because "after the first slide
        // the walker is never at a centre again". So the coalescer was clearing a run from
        // a point the character had already left, then sending a multi-square hop along it
        // — which slides, lands off-plan, and costs a replan that re-plans the same route.
        //
        // The server pushes our fine position and `walkFine` already steers by it, so this
        // is the authoritative answer rather than a better guess. Falling back to the stand
        // point keeps a client that has not reported one behaving exactly as before.
        const here = Number.isFinite(c.self?.x) && Number.isFinite(c.self?.y)
          ? { x: protocolToClient(c.self.x), y: protocolToClient(c.self.y) }
          : fineOf(from0);
        // FURTHEST FIRST, so a long clear run costs one trace rather than one per square.
        // Bounded by the same hop ceiling as before, so the packet a walk sends is no
        // bigger than it ever was — this changes WHICH squares may be skipped, not how
        // many.
        // A PROVED LEG MAY REACH FURTHER THAN AN UNPROVED ONE — see PROVED_HOP_MAX_SQUARES.
        // The lookahead is only a candidate list; `took` below still refuses anything the
        // pull did not prove, so widening it cannot lengthen an unproved hop.
        const onProof = pulled && next && pulled.squares.has(`${next.row},${next.col}`);
        const cap = hopLimit >= MOVE_HOP_MAX_SQUARES && onProof
          ? PROVED_HOP_MAX_SQUARES : hopLimit;
        const reach = [];
        for (let i = 0; i < queue.length && reach.length < Math.max(1, cap) - 1; i++) {
          const s = queue[i];
          if (occupied.has(`${s.row},${s.col}`)) break;
          reach.push(s);
        }
        // Membership in a proved route does not prove a direct line from the
        // current body: the squares may be on different legs around a corner,
        // or the body may have slid since that proof. Trace each proposed hop
        // from the actual fine position. A long clear run still costs one trace.
        let took = -1;
        const hereSq = c.self ?? from0;
        for (let i = reach.length - 1; i >= 0; i--) {
          const target = reach[i];
          if (i + 2 > hopLimit && !pulled?.squares.has(`${target.row},${target.col}`)) continue;
          if (hereSq && missedHops.has(edgeKey(hereSq.row,hereSq.col,target.row,target.col))) continue;
          if (arrives(here,fineOf(target))) { took = i; break; }
        }
        if (took >= 0) {
          // `next` was removed before lookahead. It is still the first
          // waypoint to restore if this coalesced move misses.
          skipped.push(next);
          for (let k = 0; k <= took; k++) {
            const s = queue.shift();
            if (k < took) skipped.push(s);   // everything between here and the far end
            next = s;
            hop++;
          }
        }
      } else {
        // Without a collision model, coalesce only collinear steps. Honor the
        // same shortened retry and failed-hop memory as the traced branch.
        const dc0 = Math.sign(next.col - (c.self?.col ?? next.col));
        const dr0 = Math.sign(next.row - (c.self?.row ?? next.row));
        while (hop < hopLimit && queue.length) {
          const peek = queue[0];
          if (Math.sign(peek.col - next.col) !== dc0 || Math.sign(peek.row - next.row) !== dr0) break;
          if (occupied.has(`${peek.row},${peek.col}`)) break;
          if (blockedEdges.has(edgeKey(next.row, next.col, peek.row, peek.col))) break;
          if (from0 && missedHops.has(edgeKey(from0.row, from0.col, peek.row, peek.col))) break;
          skipped.push(next);
          next = queue.shift(); hop++;
        }
      }
      const was = c.self ? { col: c.self.col, row: c.self.row } : null;
      // A FALL IS A DIFFERENT KIND OF STEP AND THE MOVER HAS TO BE TOLD. `neighbors` marks
      // it; `fallTargets` proved it in fall mode; without the flag the same two squares are
      // refused by an ordinary wall trace. See validateFineTarget.
      // A DECLARED JUMP RE-AIMS AROUND WHATEVER IS ON THE LINE — HERE, WHERE IT IS TAKEN.
      //
      // `clearestLanding` was written for the rail and only ever ran there, and the rail is
      // not how this fleet crosses Ukgoth: the walker takes the jump as an ordinary planned
      // fall edge, right here. So sixty-eight jumps' worth of measurement sat on a path
      // nobody used while the fleet jumped blind into a queue of trolls — 38% blind against
      // 79% re-aimed, and 0 against a blocker either way if you do not move the aim.
      //
      // Only for a DECLARED fall. An ordinary detected fall has no shelf to choose from and
      // no operator behind it, and re-aiming one would be inventing a landing.
      // The re-aim used to be duplicated here. `step` owns it now — it is the primitive every
      // fall passes through, and two homes for one heuristic is how they drift apart.
      const r = await this.step(next.col, next.row, { beforeMutation, fall: !!next.fall });
      // Every packetless result yields (see _yieldIfPacketless): the guard below yields every
      // twenty-fifth, which was tuned for refusals of a tenth of a millisecond — with a clocked
      // needle in each one, twenty-five is ten seconds without a turn of the event loop.
      if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
      if (r?.moved || r?.reason === 'raw_move_rejected' || (r?.travelled ?? 0) > 0) packetless = 0;
      else {
        packetless++;
        if (packetless % 25 === 0) await new Promise(res => setTimeout(res, 60));
        if (packetless >= 400) {
          try {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                           room: Number(this.world?.room?.num ?? 0),
                           tactic: 'walk_spin', trigger: 'no_packets', worked: false, ms: 0, hp_lost: 0,
                           attempted: false,
                           note: `${packetless} consecutive step attempts refused locally without a packet at ` +
                                 `${next.row},${next.col} (last reason ${r?.reason ?? '?'}); walk abandoned` });
          } catch { /* evidence, not a dependency */ }
          return { arrived: false, reason: 'spinning_without_packets',
                   blocked_at: { col: next.col, row: next.row }, steps: taken, replans,
                   note: `${packetless} consecutive step attempts refused locally without a packet — ` +
                         'the room refuses every move from here; let the caller re-plan from a different square' };
        }
      }
      taken += hop;
      if (r.left_room)
        return { arrived: false, left_room: true, steps: taken, note: 'a step crossed the room edge' };
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, steps: taken, replans };
      // ASK BEFORE GIVING UP. This is the site that ended 17 of 21 journeys on one run:
      // the step landed, the room was rebuilt, our own object had not come back yet, and
      // the walk was abandoned rather than waiting for a read already on its way.
      const now = c.self ?? await this.selfOrResync();
      // EVERY SQUARE THIS BODY LANDS ON, whether the plan asked for it or not. Recorded here
      // rather than where a step is REQUESTED, because the off-plan slide is the thing worth
      // counting: a loop made of steps the mover kept redirecting looks like progress at the
      // request site and like a shuffle here. See `_crossingOscillation`.
      // Guarded the way `_blockingBodies` and `_blinkPointHere` are guarded a few lines
      // below: `walkTo` is lifted out of this class and run against hand-built sessions by
      // m59-collision-test.mjs, and a fixture is not obliged to carry the whole Session.
      if (now && typeof this._noteCrossingSquare === 'function')
        this._noteCrossingSquare(now.row, now.col);
        if (!now)
          return { arrived: false, reason: 'own_position_unknown',
                   note: 'lost authoritative own-position state while walking, and a ' +
                         'position re-read did not bring it back',
                   steps: taken, replans };
      // GROUND ALREADY MADE IS NOT GIVEN BACK — the rail's rule, which the ordinary walker
      // never had.
      //
      // The existing `gainedGround` test only runs when a step MISSES, and the dither is made
      // of steps that land exactly where they were aimed, on a plan that keeps changing. So it
      // was invisible. Measured crossing The Streets of Tos — open town floor, nothing in the
      // way:
      //
      //   43,24 -> 42,31 -> 43,24 -> 42,31 -> 43,24 -> 42,31 -> 43,24
      //   37,27 -> 41,28 -> 37,27 -> 41,28 -> 37,27
      //
      // 324 moves over 164 seconds, 184 distinct positions, for a crossing 24 squares long —
      // 1.12 squares a second against the five a player does, and the same diagonal walked
      // three times over.
      //
      // Measured on the TARGET rather than on the plan, because the plan is what is wrong: how
      // far is the body from where it is going, and has that number moved. Bounded, not
      // forbidden — going around something legitimately costs ground, and a walk that is
      // genuinely progressing resets this on every improvement.
      //
      // A BODY IN THE WAY IS NOT A DITHER. Standing still because something is standing on
      // the next square is a fight or a wait, it has its own budget below, and it reports its
      // own facts — how many bodies, where, and the health lost to them. Counting it here
      // would swallow all of that and call it a bad plan.
      // AND IT HAS TO BE A DITHER, NOT MERELY A DETOUR.
      //
      // The first version of this counted steps that did not get closer, and that is not the
      // same thing: walking round a building legitimately loses ground for a while. It cost a
      // character its whole leg — Bbbb spent THREE HUNDRED AND EIGHTY SECONDS in The Streets
      // of Tos and never left, because the guard fired, `walkTo` handed back a failure, and
      // `leaveViaAny` read that as `every square for that exit refused (2 tried)`. A dither
      // became an unreachable door.
      //
      // The signature of a dither is REVISITING: 43,24 -> 42,31 -> 43,24 -> 42,31. A detour
      // walks new ground even while the gap grows. So the count only advances when the body
      // lands somewhere it has already been AND the walk is no closer than its best.
      const gapNow = Math.max(Math.abs(now.row - row), Math.abs(now.col - col));
      const hereKey = `${now.row},${now.col}`;
      const revisited = seenSquares.has(hereKey);
      seenSquares.add(hereKey);
      if (gapNow < bestGap) { bestGap = gapNow; sinceCloser = 0; }
      else if (r.reason === 'object_blocked') { /* the body path owns this one */ }
      else if (revisited && ++sinceCloser > WALK_STALL_STEPS)
        return { arrived: false, steps: taken, replans,
                 blocked_at: { col: now.col, row: now.row },
                 reason: 'no_ground_gained',
                 note: `${sinceCloser} revisited squares without getting closer than ` +
                       `${bestGap} — this is a dither, not a walk. The plan is what is wrong, ` +
                       'so the caller gets it back rather than another lap of the same two ' +
                       'squares.' };
      if (now.col === next.col && now.row === next.row) {
        // It landed where it was aimed, so the reach it used is one the ground supports.
        if (was && (was.col !== now.col || was.row !== now.row)) prevSquare = was;
        hopLimit = MOVE_HOP_MAX_SQUARES;
        stalledOn = null; stalledTimes = 0; continue;
      }
      if (was && (was.col !== now.col || was.row !== now.row)) prevSquare = was;
      // A LONG MOVE THAT MISSED SAYS NOTHING ABOUT A SHORT ONE. Shorten before blaming the
      // route, the edge or the body in the way: those verdicts are all about a step, and
      // what just failed was several.
      if (hop > 1) {
        hopLimit = 1;
        // REMEMBERED, so the next arrival cannot hand this same hop back. `hopLimit` alone
        // is not enough: it climbs back to full on the first step that lands where it was
        // aimed, and in a cycle that step comes round every three moves.
        if (was) missedHops.add(edgeKey(was.row, was.col, next.row, next.col));
        // AND GIVE BACK EVERY SQUARE THE HOP SWALLOWED, not just its far end.
        //
        // Collapsing the reach to one is the right instinct and it did nothing, because the
        // coalescer SHIFTS the intermediate squares off the queue and keeps only the far
        // endpoint. Re-queueing that endpoint alone leaves the walker with a single plan
        // entry thirteen squares away — so "retry as single steps" has no single steps to
        // take, and the next attempt is the identical long move.
        //
        // Measured in the Cragged Mountains, one character, traced move by move:
        //
        //   at 7,14 -> target 7,27   sent      (slides to 8,15 instead of arriving)
        //   at 8,15 -> target 7,27   REFUSED   geometry_blocked
        //   at 8,15 -> target 7,14   sent      (walks back to the proof line)
        //   at 7,14 -> target 7,27   sent      ...and round again, seven times, until dead
        //
        // Twenty-five seconds inside two squares while things ate it. The operator ran the
        // same room by hand in under twenty seconds. Putting the swallowed squares back is
        // what turns the retry into an actual walk.
        queue.unshift(next);
        if (skipped.length) queue.unshift(...skipped);
        taken -= hop - 1;
        continue;
      }

      // LANDED SOMEWHERE ELSE — counted, because the RATE is the diagnosis.
      //
      // The router validates a step centre-to-centre (`moverStepLands` asks "from the
      // CENTRE of A, can I land in B"), and after the first slide the walker is never at
      // a centre again. Simulated on room 587's approach to its western gap with the real
      // fine position carried forward: 4 of 9 planned steps land off-plan from one start
      // and 24 of 42 from another, while the model calls every one of them legal.
      //
      // Each of those costs a replan, and the replan produces the same square-to-square
      // plan that just failed — which is why crossing one room took 88-208s against 15s
      // for a direct walk to the same gap, and why a four-square doorway becomes a
      // pile-up as soon as a second character wants it.
      offPlan++;

      // DID NOT MOVE AT ALL vs ENDED UP SOMEWHERE ELSE. These were treated the same and
      // they need opposite responses. Ending up elsewhere means the route is stale, so
      // replanning from the new position is right. NOT MOVING means the next square is
      // occupied — and replanning from an unchanged position returns the identical
      // route, so the walker spent its three replans re-deciding to walk into the same
      // monster and then reported "kept ending up somewhere other than the planned
      // square" about a character that had not moved at all.
      const didNotMove = was && now.col === was.col && now.row === was.row;

      // A MONSTER MOVES AND A WALL DOES NOT, SO THEY GET OPPOSITE TREATMENT — and the
      // server already tells us which it was. `object_blocked` is the obstacle arm of the
      // local collision pass; every other refusal is geometry. Waiting 700ms for a wall to
      // wander off was pure cost, and it was paid on every lap of the bounce above.
      const hitSomething = r.reason === 'object_blocked';
      if (hitSomething && refunded < maxSteps) { taken -= hop; refunded++; }

      // THE WALL-HUG RECOVERY BELONGS HERE TOO, NOT ONLY ON A RAIL.
      //
      // `recentreInSquare` was added to `followRail` and cut room 586's geometry refusals
      // from 144 to 21 in a measured pair of runs. The ordinary walker never got it, and it
      // is the same failure: the bake traces centre to centre, the mover traces from where
      // the body actually is, and a body slid against a wall inside its own square is refused
      // a step the geometry plainly allows.
      //
      // 586's row-47 corridor is where this still shows: `47,14 -> 47,13` refused eight
      // times, `48,15 -> 47,13` twelve, with the body sending from 47,11, 47,12 and 48,12
      // over and over. Every one of those squares is walkable and every step between them
      // answers `moverStepLands` true.
      //
      // Once per square, and only for a geometry refusal that did not move the body: a
      // refusal that survives standing in the middle is a real one, and the blame below is
      // then the right answer. Guarded because `walkTo` is lifted out of this file by text.
      if (!hitSomething && didNotMove && r.reason === 'geometry_blocked'
          && was && !recentredAt.has(`${was.row},${was.col}`)
          && typeof this.recentreInSquare === 'function') {
        recentredAt.add(`${was.row},${was.col}`);
        if (await this.recentreInSquare().catch(() => false)) continue;
      }

      // THE EDGE THAT REFUSED IS THE ONE WE ASKED FOR, AND IT IS NAMED FROM WHERE WE
      // ASKED IT — not from where we ended up. That distinction is the whole of this fix.
      // A slid step leaves the character at neither end of the step it requested, so
      // blaming the edge out of the LANDING square blames an edge nobody tried: measured,
      // the two-square bounce simply carried on, alternating between the refused edge and
      // an unblocked twin. `was -> was + one step in the requested direction` is exactly
      // what the mover was asked to do and exactly what a replan would ask again.
      //
      // A coalesced hop covers several squares and only names its first, so when one fails
      // this attributes the first rather than the guilty one. That is deliberate and it is
      // the safe direction: the cost of blocking a good edge is a slightly longer route,
      // the replan re-asks from nearer, and the real blocker is found on the next lap.
      const bdr = Math.sign(next.row - (was?.row ?? next.row));
      const bdc = Math.sign(next.col - (was?.col ?? next.col));
      // A REFUSED FALL IS A BAD APPROACH, NOT A BAD LEDGE.
      //
      // `fallTargets` proved this drop from the take-off square's STAND POINT and the proof
      // still holds: measured in room 578, 36 of the 64 points sampled inside 45,16 make
      // the fall to 43,16 land correctly. A body that slid into one of the other 28 is
      // wedged against the cliff — no point in the landing square works from there, no
      // neighbouring landing works, and `finePath` cannot even reach the take-off point.
      //
      // Blaming the ledge is what learning `45,16 > 43,16` does, and it deletes the only
      // way down: 578 has no other, so the walk bounced 45,16 <-> 45,17 until its budget
      // ran out, every single crossing. Blaming the APPROACH sends the router at the same
      // ledge from a different neighbour, which puts the body on a different fine point,
      // and most of them work. Offline, that alone turns the crossing from "bouncing" into
      // an arrival.
      const blamed = next.fall && prevSquare
        ? edgeKey(prevSquare.row, prevSquare.col, was?.row ?? next.row, was?.col ?? next.col)
        : (was ? edgeKey(was.row, was.col, was.row + bdr, was.col + bdc) : null);
      let learned = false;
      if (!hitSomething && was && blamed && (bdr || bdc || next.fall)) {
        if (!blockedEdges.has(blamed)) { blockedEdges.add(blamed); learned = true; }
        // AND REMEMBERED PAST THIS WALK, but only when the geometry says so outright.
        //
        // `moverStepLands` asked from the square we actually stood on is the same question
        // the mover just answered, so a `false` here is proof rather than inference — the
        // one thing worth carrying into the next replan. A refusal we cannot corroborate
        // (a slide, a fall, an unbaked room) stays local and is forgotten as before.
        //
        // Bounded, because a session is long and a map is not: past the cap the room stops
        // learning rather than growing without limit.
        if (impossibleHere && !next.fall && (bdr || bdc)
            && typeof geo?.moverStepLands === 'function'
            && impossibleHere.size < 4096) {
          const tr = was.row + bdr, tc = was.col + bdc;
          try {
            if (!geo.moverStepLands(was.row, was.col, tr, tc)) impossibleHere.add(blamed);
          } catch { /* a geometry that cannot answer teaches nothing, which is the old behaviour */ }
        }
      }

      // HALF OF WHAT THE SQUARE LATTICE CALLS A WALL IS A SLIDE THAT LANDED NEXT DOOR.
      //
      // `moverStepLands` asks whether a step from one stand point ARRIVES IN the target
      // square. Around the Cibilo Creek Inn's porch — where prod characters pile up, 295
      // samples on one square — five of the eight steps out of 8,58 are "refused", and only
      // two of those are walls: the rest MOVE the body and simply land in a neighbouring
      // square. A lattice cannot express that, so the walker learns an edge, replans, and
      // meets the same lip from the next square along.
      //
      // Fine positioning can: `finePath` searches a quarter-square lattice, validating every
      // move with the same trace the mover enforces, and raycasts the result down to the
      // corners the geometry actually requires. On this porch it threads 8,58 to the inn
      // door in 56 nodes and 25ms, and pulls to a SINGLE straight move.
      //
      // Local, and only after a refusal. A fine search across a whole outdoor room is tens
      // of thousands of nodes and is not what this is for — the coarse plan is good at
      // "which way round", and this is good at "and now through the gap".
      // FIRE ON ANY GEOMETRY-CAUSED OFF-PLAN LANDING, NOT ONLY ON A NEW REFUSED EDGE.
      //
      // Gating this on `learned` was too narrow, and the Cibilo Creek porch is exactly why:
      // walking from the inn door to Cor Noth's north gate the walker takes 38 steps,
      // learns only TWO edges, and ends at 8,58 — the square 295 prod samples pile up on.
      // The steps are not being refused; they MOVE the body and land somewhere the plan did
      // not expect, which is what a slide off a fenced lip does. So the detour has to answer
      // the landing, not the refusal.
      if (!hitSomething && was && geo.collisionReady && fineDetours < FINE_DETOUR_MAX) {
        // CLIENT UNITS ON BOTH ENDS. `finePath` searches the client lattice — 1024 to the
        // square — while `c.self` is the WIRE position at 64 to the square. Handing it wire
        // coordinates starts the search a twentieth of the way across the room from where
        // the body is, which finds nothing and costs a search to find it. The same mixing
        // this repository already warns about for traces.
        const here = Number.isFinite(c.self?.x) && Number.isFinite(c.self?.y)
          ? { x: protocolToClient(c.self.x), y: protocolToClient(c.self.y) } : null;
        const goal = pointOfSquare(geo, next.row, next.col);
        if (here && goal) {
          fineDetours++;
          const found = fineRouteDetour(geo, here, [next, ...queue.slice(0, 4)],
            { margin: FINE_DETOUR_MARGIN, maxNodes: FINE_DETOUR_NODES });
          if (found?.found) {
            const rejoin = found.target;
            const legs = pullFine(geo, here, found.points);
            let threaded = false;
            for (const leg of legs) {
              if (this.movementWasCancelled(movementGeneration, controlToken)) break;
              const step = await this.stepFine(clientToProtocol(leg.x), clientToProtocol(leg.y))
                .catch(() => null);
              if (step?.left_room)
                return { arrived: false, left_room: true, steps: taken,
                         note: 'a fine detour crossed the room edge' };
              const at = c.self;
              if (at && at.row === rejoin.row && at.col === rejoin.col) { threaded = true; break; }
            }
            const at = c.self;
            if (threaded || (at && at.row === rejoin.row && at.col === rejoin.col)) {
              queue.splice(0, found.index);
              // Through the gap. The edge we blamed was never the problem, so unlearn it —
              // leaving it would push every later replan away from a way that works.
              // Local only. If `moverStepLands` called this edge impossible it is in the
              // room's memory too, and threading PAST it in fine units does not make the
              // square-to-square step walkable — that is the distinction the persistent set
              // exists to keep.
              if (learned && blamed && !impossibleHere?.has(blamed)) blockedEdges.delete(blamed);
              recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: geo?.num ?? null,
                             tactic: 'fine_walk', trigger: 'off_plan', worked: true,
                             note: `threaded ${legs.length} fine leg(s) past a lattice refusal` });
              continue;
            }
          }
        }
      }

      // A BODY THAT IS HITTING US IS NOT GOING TO WANDER OFF.
      //
      // The retry below is built on "monsters wander, so one retry costs a second and
      // often clears it". That is true of a monster that has not noticed us and false of
      // the only case that kills anybody: one that is ENGAGED. An engaged monster stays
      // exactly where it is, because we are what it is standing there for — so every
      // patient 500-1000ms lap is damage taken for nothing, and the walker takes them one
      // after another while its keeper is inert by design for the length of the errand.
      //
      // Measured on prod, deaths in one two-hour window: 5 of the 18 that recorded hits in
      // their last minute took EVERY one of them on a single square. Kermit stood on one
      // square in Main gate to Cor Noth for 118 seconds and took 23 hits; Beaker and
      // Statler each lost 47-51 health in 9 seconds without moving. Those are not walks
      // that were too slow, they are walks that stood still and were eaten.
      //
      // So being hit does not end the trip — doctrine is explicit that a planned journey
      // completes, and two attempts to bail out on health were tried here and reverted —
      // it just stops us WAITING. Under fire the polite lap is skipped and the walker goes
      // straight to the moves that change something: round the body, or a replan that
      // treats its square as taken.
      const hpNow = c.vitals?.()?.health?.value;
      if (Number.isFinite(hpNow)) {
        if (!Number.isFinite(hpAtLastBlock)) hpAtLastBlock = hpNow;
        if (hpNow < hpAtLastBlock) { damageWhileBlocked += hpAtLastBlock - hpNow; underFire = true; }
        else if (hpNow > hpAtLastBlock) underFire = false;   // healed or disengaged
        hpAtLastBlock = hpNow;
      }

      if (didNotMove && hitSomething) {
        // COUNTED, BECAUSE A WALK EATEN BY BODIES USED TO BE INDISTINGUISHABLE FROM A
        // WALK WITH TOO SMALL A BUDGET. Both returned `stopped after N steps` with
        // `replans: 0` — the zero because adding an occupied square sets `learned`, and
        // `learned` suppresses the replan counter below. Measured live in the King's Way:
        // the same 3-step walk read `steps: 40, replans: 0` with eleven rats plugging a
        // two-wide corridor and `steps: 3, arrived` once they moved. Nothing in the reply
        // named a monster, so this read as a routing fault for as long as anyone looked
        // at it — which is how it got attributed to the safe-wall geometry it happened to
        // be near. It is a different bug and it needs a different word.
        monsterBlocks++;
        blockedBy.add(`${next.row},${next.col}`);

        // Monsters wander. One retry costs a second and often clears it, which is
        // cheaper and less disruptive than routing the long way round.
        // PATIENCE IS FOR PLAYERS. A MONSTER IS AN OBSTACLE; A PLAYER IS A QUEUE.
        //
        // One patient lap, then mark the square occupied and replan -- which is right for a rat
        // and wrong for the commonest blocker on a travelled road, which is another character
        // walking the same road. A player is going SOMEWHERE. It vacates on its own, and the
        // only thing needed is to not give up in the second before it does.
        //
        // AND IN A ONE-SQUARE CORRIDOR GIVING UP IS UNRECOVERABLE. The escalation is a sidestep,
        // there is no side, so the square goes into `occupied` for the rest of the walk and A*
        // is asked for a route through a pipe with a hole punched in it. Room 108's sewer pipe
        // (row 35, col 47) is exactly one square wide and is the only way to the jump take-off:
        // one bot crosses 108 -> 110 four times out of four, and six bots at once crossed it
        // none out of six, each having poisoned the corridor for itself against bodies that
        // were merely passing through.
        //
        // So a player blocker buys laps instead of a verdict. The wait below is already jittered,
        // so the queue does not move in lockstep, and `underFire` still overrides everything --
        // a body that is HITTING us is not queuing, and waiting on it is how characters die on
        // one square. Monsters are unchanged at one lap.
        //
        // Escalation is not abandoned, only deferred: after this many laps the sidestep, the
        // retreat and the replan all run exactly as before.
        const blockerIsPlayer = !!(c.room?.objects && [...c.room.objects.values()].some(o =>
          o.id !== c.selfId && o.col === next.col && o.row === next.row && (o.flags & OF.PLAYER)));
        const patience = (blockerIsPlayer && !underFire) ? QUEUE_PATIENCE : 1;
        if (underFire || (stalledOn === `${next.row},${next.col}` && stalledTimes >= patience)) {
          // GO ROUND IT RATHER THAN ROUND THE ROOM. Marking the square occupied and
          // replanning is correct and expensive: A* re-solves the whole route, and in a
          // corridor the only answer it can find is the long way, which is how a
          // three-step walk becomes forty. A body is one square wide — the cheap move is
          // to try the two squares either side of it first.
          //
          // BACK UP FIRST, and that is the part that is not obvious. Standing next to the
          // blocker, the diagonal past it is frequently refused by the mover as well:
          // squeezing between a body and a wall is exactly the clearance the player disc
          // does not have. Retreating one square opens the angle, which is what a person
          // does without thinking about it.
          //
          // It is only ever a PREFERENCE. If neither side works the ordinary occupancy
          // path below runs exactly as it did before, so this can cost a couple of steps
          // and cannot cost the walk.
          // WHAT IS IN THE WAY DECIDES WHICH ORDER TO TRY THE SIDES IN. A player is also
          // dodging and needs the id tie-break; a monster is not, and gets the fixed
          // clockwise-first order. Read off the room rather than assumed: `blockedBy` only
          // records the square.
          const side = this.sidestepAround(was, next,
            { blockedEdges, occupied, geo, prefer: Number(c.self?.id ?? 0), blockerIsPlayer });
          if (side && !sidestepped.has(`${next.row},${next.col}`)) {
            sidestepped.add(`${next.row},${next.col}`);
            queue.unshift(next);
            queue.unshift(side.through);
            if (side.back) queue.unshift(side.back);
            // A SIDESTEP IS OFF THE PULLED LINE. Its squares were never proved, and the
            // one behind us is deliberately backwards, so drop the proof rather than let
            // the coalescer jump along a leg nobody traced.
            pulled = null;
            stalledOn = null; stalledTimes = 0;
            continue;
          }
          // NO SIDE TO STEP TO IS NOT THE SAME AS NO WAY PAST. See laneAroundBody: in a
          // one-square corridor the pass is a different fine y inside the SAME square, which
          // nothing above can express. Tried once per blocked square, before the square is
          // written off, and a refusal simply falls through to the recovery below.
          let laneTried = false, laneMoved = false;
          if (!lanedPast.has(`${next.row},${next.col}`)) {
            lanedPast.add(`${next.row},${next.col}`);
            const lane = this.laneAroundBody(was, next, geo, c);
            if (lane) {
              laneTried = true;
              const moved = await this.stepFine(lane.x, lane.y).catch(() => null);
              laneMoved = !!moved?.moved;
              recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                             room: Number(this.world?.room?.num ?? 0),
                             tactic: 'body_lane', trigger: 'no_side_to_step_to',
                             worked: !!moved?.moved, ms: 0, hp_lost: 0, attempted: true,
                             note: `threaded ${next.row},${next.col} at offset ${lane.off} ` +
                                   `for ${lane.gap.toFixed(1)} of clearance` });
              if (moved?.moved) {
                pulled = null; stalledOn = null; stalledTimes = 0;
                queue.unshift(next);
                continue;
              }
            }
          }
          // THE PERP WALK, when the lane found nothing or its one step was refused. Tried once
          // per blocked square, like the lane, and every attempt is a `perp_walk` row in the
          // tactics ledger — side, offset, slack, how far it got — because the operator asked
          // for this as an experiment with telemetry, and an experiment that cannot be read
          // back is an opinion. See perpWalkPastBodies for the geometry.
          if (!laneMoved && !perpWalked.has(`${next.row},${next.col}`)) {
            perpWalked.add(`${next.row},${next.col}`);
            const perp = this.perpWalkAroundBodies(was, next, geo, c);
            const who = this.client?.me?.name ?? this.name ?? null;
            const roomNum = Number(this.world?.room?.num ?? 0);
            if (perp?.points?.length === 2) {
              const t0 = Date.now();
              const hpNow = () => { try { return c.vitals?.()?.health?.value ?? null; } catch { return null; } };
              const hp0 = hpNow();
              const [p0, p1] = perp.points;
              const on = await this.stepFine(p0.x, p0.y).catch(e => ({ moved: false, reason: e.message }));
              const ran = on?.moved
                ? await this.walkFine(p1.x, p1.y, { maxSteps: 16, stride: 32, arriveWithin: 12,
                                                    movementGeneration, controlToken })
                        .catch(e => ({ arrived: false, reason: e.message }))
                : null;
              const worked = !!ran?.arrived;
              const hp1 = hpNow();
              recordTactic({ character: who, room: roomNum,
                             tactic: 'perp_walk', trigger: laneTried ? 'lane_refused' : 'no_lane',
                             worked, ms: Date.now() - t0, attempted: true,
                             hp_lost: (hp0 != null && hp1 != null) ? Math.max(0, hp0 - hp1) : 0,
                             note: `side ${perp.side > 0 ? '+' : '-'} offset ${perp.offset.toFixed(1)} ` +
                                   `slack ${perp.slack.toFixed(2)} past ${perp.bodies} body(ies) ` +
                                   `${p0.x},${p0.y} -> ${p1.x},${p1.y}: ` +
                                   (worked ? `arrived in ${ran.steps ?? '?'} step(s)`
                                           : on?.moved ? `walk stopped: ${ran?.reason ?? ran?.note ?? 'did not arrive'}`
                                                       : `sidestep refused: ${on?.reason ?? 'no reason'}`) });
              if (worked) {
                // Squares the walk has already passed are not aimed at again: anything whose
                // centre projects behind the body along the walk axis is dropped, and the
                // ordinary walker carries on from the far point toward what is left.
                const meNow = c.self;
                const ahead = sq => meNow
                  ? ((sq.col * KOD_FINENESS + 32) - meNow.x) * perp.axis.ux
                    + ((sq.row * KOD_FINENESS + 32) - meNow.y) * perp.axis.uy
                  : 0;
                pulled = null; stalledOn = null; stalledTimes = 0;
                if (ahead(next) > -(KOD_FINENESS >> 1)) queue.unshift(next);
                while (queue.length > 1 && ahead(queue[0]) < -(KOD_FINENESS >> 1)) queue.shift();
                continue;
              }
            } else if (perp?.why) {
              recordTactic({ character: who, room: roomNum, tactic: 'perp_walk',
                             trigger: laneTried ? 'lane_refused' : 'no_lane',
                             worked: false, ms: 0, hp_lost: 0, attempted: false,
                             note: `${perp.bodies} body(ies) in the way; ${perp.why}` });
            }
          }
          // BLINK, FROM THE BLOCKED STEP. The strategies were only ever asked from the
          // room-crossing give-up, which a jam in the middle of a route never reaches — tour 5
          // walked through the 584 pipe with blink enabled for everyone and produced no
          // blink_escape row at all. So the same question is put here, once per blocked
          // square, after the sidestep, the lane and the perp walk have all had their turn and
          // the square has held us for the strategy's own patience. The answer's need_safe_spot
          // is honoured (a wall first, via the keeper's ladder), and a teleport that lands is
          // followed by a REPLAN from where the body now is, not by the old queue.
          const stuckKey = `${next.row},${next.col}`;
          if (!blockedSince.has(stuckKey)) blockedSince.set(stuckKey, Date.now());
          // ONCE PER SQUARE IS THE WRONG BUDGET FOR A LOOP, and it is why a shuffle could
          // never get an answer out of this site. `blinkAsked` stops us re-asking about the
          // same blocked square, which is right for a body pushing at one obstacle. A body
          // going round in circles visits four or five squares in turn, banks an ask against
          // each of them within the first few seconds, and is then silent for the rest of the
          // crossing — the longer it goes on, the more certainly every square in the loop is
          // already in the set. So a crossing that is past the stall clock AND oscillating
          // asks again regardless, on its own cooldown rather than per square.
          const oscillating = typeof this._crossingOscillation === 'function'
            ? this._crossingOscillation() : null;
          const crossingMs = typeof this._crossingMs === 'function' ? this._crossingMs() : 0;
          const stalledCrossing = crossingMs >= CROSSING_STALL_MS && !!oscillating;
          const askAgain = stalledCrossing &&
                           Date.now() - (this._lastBlinkAskAt ?? 0) >= CROSSING_ASK_EVERY_MS;
          if ((!blinkAsked.has(stuckKey) || askAgain) && typeof this._askStrategies === 'function') {
            if (askAgain) this._lastBlinkAskAt = Date.now();
            const stuckMs = Date.now() - blockedSince.get(stuckKey);
            const answer = await this._askStrategies('whenStuck', {
              room: this.world?.room ?? null, geo, self: c.self ?? null,
              goal: { row, col },
              route: [next, ...queue].filter(Boolean).map(sq => ({ row: sq.row, col: sq.col })),
              bodies: typeof this._blockingBodies === 'function' ? this._blockingBodies() : [],
              blink: typeof this._blinkPointHere === 'function' ? this._blinkPointHere() : null,
              vitals: c.vitals?.() ?? null, stuck_ms: stuckMs, underFire: !!underFire,
              agent: this.name ?? this.client?.me?.name ?? null, from: 'walker',
              // THE CROSSING'S OWN HISTORY, which is the only thing that can contradict a
              // reachability flood. `stalled` carries the evidence sentence, not a boolean,
              // so the observation store says WHY the usual decline was overridden.
              crossing_ms: crossingMs, oscillating,
              stalled: stalledCrossing
                ? `${Math.round(crossingMs / 1000)}s in this room, ${oscillating}` : null,
            }).catch(() => null);
            if (answer?.answer?.do === 'blink') {
              blinkAsked.add(stuckKey);
              const who2 = this.client?.me?.name ?? this.name ?? null;
              let wall = null;
              if (answer.answer.need_safe_spot) {
                const pilot = autopilotIfAny(this.name);
                wall = pilot && typeof pilot.takeSafeSpot === 'function'
                  ? await pilot.takeSafeSpot('a wall to blink from', null, { source: 'travel' })
                               .catch(e => ({ took: false, why: e.message }))
                  : { took: false, why: 'no autopilot to take a wall with' };
              }
              // The nearest wall may have been the exit (see takeSafeSpot): then we are in
              // another room, every attacker is behind us, and there is nothing to cast for.
              if (wall?.via === 'exit' || wall?.crossed) {
                recordTactic({ character: who2, room: Number(this.world?.room?.num ?? 0),
                               tactic: 'blink_escape', trigger: `${answer.strategy} (walker)`,
                               worked: true, ms: 0, hp_lost: 0, attempted: false,
                               note: `blocked at ${next.row},${next.col} for ${Math.round(stuckMs / 1000)}s; ` +
                                     `the nearest wall was the exit and it was taken; no cast needed` });
                try { answer.answer.settled?.(true, 'took the exit instead', null); } catch { /* evidence, not a dependency */ }
                return { arrived: false, left_room: true, reason: 'took_the_exit',
                         blocked_at: { col: next.col, row: next.row }, steps: taken, replans };
              }
              // NO WALL IS NOT A REASON TO STAY STUCK. THE OPERATOR, 2026-09-03.
              //
              // This refused the cast whenever `takeSafeSpot` came back empty, and on the
              // day the stall fix shipped that is what it did to Kermit — twice in two
              // minutes in room 567, on the GENUINE blocked verdict: "blocked from here (24
              // squares) and clear from the blink point (826 squares); no wall (nothing in
              // this room is more defensible)". Twenty-four squares against eight hundred
              // and twenty-six, the one spell that crosses that gap known and afforded, and
              // the answer was to stand there because the room had nowhere tidy to sit.
              //
              // A wall is preparation, not permission. Where there is none the cast still
              // happens; what changes is only what we do first:
              //
              //   not under fire   cast now — nothing is swinging, the wall bought nothing
              //   under fire       back off along proven crumbs for up to five seconds to
              //                    break contact, then cast anyway
              //
              // Breadcrumbs rather than any free square, for the reason the body-retreat a
              // few lines down gives: every crumb is a move the validator already accepted,
              // so backing up cannot open a hole the collision rules would refuse. Bounded
              // by a deadline AND by crumbs, and it stops early the moment nothing that
              // blocks movement is adjacent — the goal is to break contact, not to undo the
              // journey.
              let evaded = null;
              if (!wall?.took && underFire && typeof this.retreatAlongBreadcrumbs === 'function') {
                const deadline = Date.now() + BLINK_EVADE_MS;
                const adjacent = () => !!(c.room?.objects && [...c.room.objects.values()].some(o =>
                  o.id !== c.selfId && blocksMovement(o.flags ?? 0) && c.self &&
                  Math.max(Math.abs(o.row - c.self.row), Math.abs(o.col - c.self.col)) <= 1));
                evaded = await this.retreatAlongBreadcrumbs({
                  maxCrumbs: Number(process.env.M59_BLINK_EVADE_CRUMBS || 4),
                  until: () => Date.now() >= deadline || !adjacent(),
                  movementGeneration, controlToken,
                }).catch(() => null);
              }
              // GET THE LEGS BACK BEFORE THE CAST, NOT AFTER. Blink lands the body on a
              // fixed square the room's kod declares and promises nothing about what is
              // standing on it; running needs at least 10 vigor, and the shuffle that
              // prompted the blink is exactly what grinds vigor away. So the wall we just
              // took is sat on first. Advisory in every direction: no autopilot, no rest,
              // and a rest that is interrupted by damage still casts — tired is worse than
              // still going round in circles.
              //
              // ONLY ON A WALL. The rest was asked for as "rest to vigor IN A SAFE SPOT";
              // sitting down in the open next to whatever we just failed to get away from
              // is not the same thing and is not what it is for. With no wall we cast tired.
              let rested = null;
              if (wall?.took && (answer.answer.rest_to_vigor || answer.answer.rest_to_mana)) {
                const pilot = autopilotIfAny(this.name);
                rested = pilot && typeof pilot.restBeforeBlink === 'function'
                  ? await pilot.restBeforeBlink('vigor and mana before a blink out of a stalled crossing',
                                                { mana: Number(answer.answer.rest_to_mana ?? 0) })
                               .catch(e => ({ rested: false, why: e.message }))
                  : { rested: false, why: 'no autopilot to rest with' };
              }
              const out = await this.blinkOut({ expect: answer.answer.expect, movementGeneration, controlToken }).catch(() => null);
              recordTactic({ character: who2, room: Number(this.world?.room?.num ?? 0),
                             tactic: 'blink_escape', trigger: `${answer.strategy} (walker)`,
                             // ALWAYS TRUE NOW: nothing left can turn this into a decision
                             // rather than an attempt. This read `castable` until that
                             // variable was deleted, leaving a ReferenceError AFTER the
                             // await — the spell went off and the walk then threw.
                             worked: !!out?.arrived, ms: out?.ms??0, hp_lost: 0, attempted: !!out?.cast,
                             note: `blocked at ${next.row},${next.col} for ${Math.round(stuckMs / 1000)}s; ${answer.answer.why}; ` +
                                   (answer.answer.need_safe_spot
                                     ? (wall?.took ? 'took a wall first; '
                                        : `no wall (${wall?.why ?? '?'}) — casting anyway; `) : '') +
                                   (evaded ? `backed off ${evaded.steps ?? 0} crumb(s) to break contact first; ` : '') +
                                   (rested ? (rested.rested
                                     ? `rested vigor ${Math.round((rested.before ?? 0) * 100)}% -> ${Math.round((rested.vigor_pct ?? 0) * 100)}%` +
                                       `${rested.interrupted ? ' (cut short by damage)' : ''}; `
                                     : `did not rest (${rested.why ?? '?'}); `) : '') +
                                   `${out?.why ?? 'no result'}` });
              try { answer.answer.settled?.(!!out?.arrived, out?.why ?? null, out?.at ?? null); } catch { /* evidence, not a dependency */ }
              if (out?.arrived) {
                const here = c.self;
                const re = here ? geo.path(here.row, here.col, row, col,
                                           { blockedEdges, threats: this.threatsHere(), clearance }) : null;
                if (re?.found) {
                  queue = re.steps.slice();
                  pulled = undefined; stalledOn = null; stalledTimes = 0;
                  continue;
                }
              }
            }
          }
          // KILL AND CONTINUE, THE LAST RESORT. A monster standing on the next square that the
          // character outranks — the same engagement rule the hunt uses, `refuseEngagement`
          // answering null — is fought from here, in the keeper's own bounded rounds, and the
          // square is tried again when it falls or moves. Never a player, never above the
          // flee line, never twice for the same square, and every attempt is a
          // kill_and_continue row: what stood there, how many rounds, whether it cleared.
          // A BLOCKER IS ANYTHING ON THE NEXT FEW SQUARES, NOT ONLY THE VERY NEXT ONE.
          //
          // This looked at `next` alone, and on a tight path that is the wrong question: the
          // thing wedging you is often two squares up the line, not one. Measured on prod
          // 2026-09-11, Robin stood at r35c34 in The Flatlands for 101 seconds with spider
          // #16980 at r35c32 — blocking the ROUTE and never once being the NEXT SQUARE, so this
          // search returned null and the rung was unreachable. That is the known "584 row-35
          // pipe wedge", and it is why the tactics ledger has five kill_and_continue rows, all
          // in room 39, and none in the room where the wedges actually happen.
          //
          // `queue` still holds the steps after `next`, so the upcoming squares are already
          // here. Melee is a disc of 2-3 squares and `holdPosition` means we will not walk, so
          // a blocker is only worth swinging at if it is ALREADY within reach — otherwise
          // `fight` correctly answers out_of_reach and the bout is wasted.
          const MELEE_REACH = 3;                       // matches the autopilot's REACH
          const AHEAD = 3;                             // next + the two after it
          const ahead = [next, ...queue.slice(0, AHEAD - 1)];
          const me4 = c.self;
          const reachable = (o) => !me4
            || Math.hypot((o.col ?? 0) - me4.col, (o.row ?? 0) - me4.row) <= MELEE_REACH;
          const bodies = [...(c.room?.objects?.values?.() ?? [])].filter(o =>
            o.id !== c.selfId && blocksMovement(o.flags ?? 0) && !(o.flags & OF.PLAYER));
          // Nearest square on the line first, so we clear the thing in front before the thing
          // beyond it rather than swinging past a body we are touching.
          let blocker = null, blockerAt = null;
          for (const sqr of ahead) {
            const hit = bodies.find(o => o.col === sqr.col && o.row === sqr.row && reachable(o));
            if (hit) { blocker = hit; blockerAt = sqr; break; }
          }
          // KEYED ON THE BLOCKER'S SQUARE, not on `next`. Keying the one-attempt guard to the
          // square we are standing against would burn the single attempt on the wrong body when
          // the real obstruction is further up the line.
          const killKey = blockerAt ? `${blockerAt.row},${blockerAt.col}` : stuckKey;
          if (!killTried.has(killKey)) {
            const pilot = blocker ? autopilotIfAny(this.name) : null;
            if (blocker && pilot && typeof pilot.fightInPlace === 'function') {
              killTried.add(killKey);
              const name = c.rsc?.get?.(blocker.nameRsc) ?? blocker.name ?? null;
              const who3 = this.client?.me?.name ?? this.name ?? null;
              const roomNum3 = Number(this.world?.room?.num ?? 0);
              const refusal = typeof pilot.refuseEngagement === 'function' ? pilot.refuseEngagement(name) : { why: 'no engagement rule' };
              const hpFrac = () => { const v = c.vitals?.(); return v?.health?.max ? v.health.value / v.health.max : null; };
              const fleeAt = (() => { try { return pilot.safety?.().fleeAt ?? 0.4; } catch { return 0.4; } })();
              if (refusal || (hpFrac() ?? 0) < fleeAt) {
                recordTactic({ character: who3, room: roomNum3, tactic: 'kill_and_continue', trigger: 'blocked_by_monster',
                               worked: false, ms: 0, hp_lost: 0, attempted: false,
                               note: `${name ?? 'a monster'} on ${next.row},${next.col}: ` +
                                     (refusal ? `not fightable — ${refusal.why}` : `health ${Math.round((hpFrac() ?? 0) * 100)}% is under the flee line`) });
              } else {
                const t0 = Date.now(), hp0 = c.vitals?.()?.health?.value ?? null;
                let rounds = 0, killed = false, cleared = false, bouts = 0;
                // WHY THE SWING DID OR DID NOT HAPPEN, KEPT. `fight` answers
                // `{fought, out_of_reach, reason, nearest}` and this loop kept only `killed`,
                // so a refusal — "holding position and nothing matching is within reach" —
                // was recorded as a fight that failed to kill. Five rows in the prod ledger
                // read "9 round(s), still standing there" and NOT ONE of them says whether a
                // blow was ever struck. `hp_lost` is our own health delta, so it is 0 both
                // when nothing hit us and when nothing happened at all.
                // `fight` returns `landed_hits` and `damage_dealt` on every fought pass, which is
                // the difference between "swung and missed", "swung and it is too tough" and
                // "never swung". Without them the only honest reading of a failed row was
                // "something did not work".
                let lastWhy = null, everFought = false, outOfReach = false, hits = 0, dmg = 0;
                for (let bout = 0; bout < 3; bout++) {
                  if (this.movementWasCancelled(movementGeneration, controlToken)) break;
                  const f = await pilot.fightInPlace(blocker, name).catch(e => ({ fought: false, killed: false, reason: e.message }));
                  bouts++;
                  // ROUNDS ARE COUNTED ONLY WHEN A FIGHT HAPPENED. `rounds += 3` ran
                  // unconditionally, so "9 round(s)" was three bouts times an ASSUMED three
                  // rounds and never a measurement. A counter that cannot come down is a
                  // monument; one that counts work nobody did is worse.
                  if (f?.fought) {
                    everFought = true;
                    rounds += Number(f.rounds ?? 0);
                    hits += Number(f.landed_hits ?? 0);
                    dmg += Number(f.damage_dealt ?? 0);
                  }
                  if (f?.out_of_reach) outOfReach = true;
                  if (f?.reason) lastWhy = f.reason;
                  killed = !!f?.killed;
                  const still = [...(c.room?.objects?.values?.() ?? [])].some(o =>
                    o.id === blocker.id && o.col === blockerAt.col && o.row === blockerAt.row);
                  cleared = killed || !still;
                  if (cleared || (hpFrac() ?? 0) < fleeAt) break;
                  // A refusal will not fix itself by being repeated with identical inputs —
                  // that is the wedge lesson. Stop after the first out_of_reach rather than
                  // spending two more bouts on it.
                  if (f?.out_of_reach) break;
                }
                const hp1 = c.vitals?.()?.health?.value ?? null;
                recordTactic({ character: who3, room: roomNum3, tactic: 'kill_and_continue', trigger: 'blocked_by_monster',
                               worked: cleared, ms: Date.now() - t0, attempted: true,
                               hp_lost: (hp0 != null && hp1 != null) ? Math.max(0, hp0 - hp1) : 0,
                               note: `${name ?? 'a monster'} on ${blockerAt.row},${blockerAt.col}` +
                                     (blockerAt === next ? '' : ` (${ahead.indexOf(blockerAt)} square(s) up the line)`) +
                                     `: ${everFought ? `${rounds} round(s)` : 'NO SWING SENT'}` +
                                     `${bouts === 1 ? '' : ` over ${bouts} bout(s)`}, ` +
                                     (killed ? 'killed it'
                                      : cleared ? 'it moved off the square'
                                      : outOfReach ? `out of reach — ${lastWhy ?? 'no reason given'}`
                                      : !everFought ? `no fight — ${lastWhy ?? 'no reason given'}`
                                      : `still standing there (${hits} hit(s) landed for ${dmg} damage)`) });
                if (cleared) {
                  pulled = null; stalledOn = null; stalledTimes = 0;
                  queue.unshift(next);
                  continue;
                }
              }
            }
          }
          // NEITHER SIDE WORKED. BACK UP THE WAY WE CAME AND LET IT FOLLOW US.
          //
          // The third tier, and the operator's: a monster that is attacking will step
          // FORWARD into the square we vacate, which moves the body that is blocking us and
          // opens the ground it was standing on. Retreating is not an escape here — it is a
          // way of making the obstacle move, which is the one thing a sidestep cannot do
          // when every square around us is occupied.
          //
          // ONLY UNDER FIRE, and that is the whole justification. A body that is merely in
          // the way will drift off on its own and the polite wait above is cheaper; a body
          // that is EATING us will not, and the trace that prompted this recorded seventy-
          // five refusals in ten seconds with zero packets sent while health fell from 33 to
          // 4. Standing still there is certain; backing up is merely uncertain.
          //
          // Breadcrumbs rather than any free square, because every crumb is a move the
          // validator already accepted — so the retreat cannot open a hole the collision
          // rules would refuse, which is the property that makes this safe to do at all.
          // `until` stops it the moment the blocked square frees up: the goal is to make the
          // thing move, not to undo the journey.
          if (underFire && !retreatedFromBodies && typeof this.retreatAlongBreadcrumbs === 'function') {
            retreatedFromBodies = true;
            // A BODY, not any object: a logoff ghost is an ActiveObject with the kod's default
            // flags (MOVEON_YES — no collision in the client), and so is an item on the ground.
            // Counting them here made a mushroom on the next square look like a crowd that
            // never left, and the walker backed off three crumbs for it every time.
            const stillThere = () => !!(c.room?.objects && [...c.room.objects.values()].some(o =>
              o.id !== c.selfId && o.col === next.col && o.row === next.row && blocksMovement(o.flags ?? 0)));
            const back = await this.retreatAlongBreadcrumbs({
              maxCrumbs: Number(process.env.M59_BODY_RETREAT_CRUMBS || 3),
              until: () => !stillThere(),
              movementGeneration, controlToken,
            }).catch(() => null);
            if (back?.steps) {
              bodyRetreats++;
              queue.unshift(next);       // and try the same square again from further back
              pulled = null;
              stalledOn = null; stalledTimes = 0;
              continue;
            }
          }
          occupied.add(`${next.row},${next.col}`);
          stalledOn = null; stalledTimes = 0; learned = true;
        } else {
          stalledOn = `${next.row},${next.col}`;
          stalledTimes++;
          queue.unshift(next);                       // try the same square once more
          // JITTERED, TO BREAK LOCKSTEP IN TIME AS WELL AS IN SPACE.
          //
          // Two characters that meet head-on retry on the same 700ms cadence, so they
          // step, collide, wait, and step again in perfect unison — and a side preference
          // alone does not help if both are always deciding at the same instant. A few
          // hundred milliseconds of spread means one of them acts while the other is
          // still waiting, which is how two people actually get past each other.
          //
          // THE JITTER IS ON THE WAIT AND NEVER ON THE CHOICE. Randomising which side to
          // try would make the walker unreproducible, and every routing test here depends
          // on the same inputs giving the same route; a timing difference changes when a
          // decision happens, not what it is.
          // The wait is for a body that might drift off its square. Under fire it will
          // not, so the second spent here is simply a hit taken — skip it and let the
          // branch above route round on the very next lap.
          if (!underFire)
            await new Promise(res => setTimeout(res, 500 + Math.floor(Math.random() * 500)));
          continue;
        }
      }

      // A REPLAN THAT LEARNED SOMETHING IS NOT THE ONE THIS BUDGET IS FOR. The cap exists
      // to stop an endless loop, and a loop is precisely a replan that discovers nothing:
      // every walk of a wall of any length would otherwise exhaust eight tries and report a
      // room impassable. So an informative failure is free — the edge set is finite and
      // shrinks the search each time — and only a repeat burns the budget. `hardCap` still
      // bounds the whole walk in steps, so this cannot run away.
      // AND THE BUDGET HAS TO SCALE WITH THE ROUTE, FOR THE SAME REASON `maxSteps` DOES.
      //
      // Eight was a fixed number against a route of any length, and the step budget ten
      // lines above already scales (`plan.steps.length + 10`) — that asymmetry was
      // arbitrary and it is what ends long walks. The King's Way is 129x88 with 8,639
      // walkable squares and its east boundary is a median 91 steps away; in geometry
      // where ~70% of steps land off-plan, eight uninformative replans are gone in the
      // first quarter of the walk.
      //
      // Measured, with an operator watching the character it happened to: Western border
      // of the Twisted Wood -> The Twisted Wood failed six times over 40s, every attempt
      // reporting "kept ending up somewhere other than the planned square" — this exact
      // message — against the SAME staging square, which it then re-planned and tried
      // again. The character was standing on a square with seven of seven mover
      // neighbours and an eighteen-step route to the boundary.
      //
      // One extra replan per ten planned steps, so a short walk is unchanged (a 9-step
      // route still gets 8) and a 91-step crossing gets 17. `hardCap` still bounds the
      // whole walk at 400 steps, so this cannot run away — the cap that actually stops a
      // runaway is the step count, not this.
      const replanBudget = 8 + Math.floor((plan.steps?.length ?? 0) / 10);
      // THE REPLAN IS COMPUTED HERE, BEFORE THE BUDGET DECIDES, BECAUSE IT IS THE EVIDENCE.
      //
      // It used to be computed twenty lines below, after the budget had already ended the
      // walk — so the one number that says whether the walk is going anywhere was not
      // available to the decision about whether the walk is going anywhere. The same call,
      // moved, and reused below: no extra A*.
      const re = geo.path(now.row, now.col, row, col,
        { avoid: occupied, blockedEdges, threats: this.threatsHere(), clearance });

      // AND "GAINED GROUND" IS MEASURED ON THE ROUTE, NOT ON THE CROW FLY.
      //
      // `gap` is Chebyshev distance to the goal, and it is the wrong measure the moment the
      // way out goes AWAY from the goal first — which is what a mountain room IS. Traced
      // offline in the Cragged Mountains from 30,24 to the Ukgoth doorway, the walk that
      // arrives runs 33,35 -> 32,36 -> 31,35 -> 30,34 -> ... -> 26,23 before turning: nine
      // consecutive steps that are all further from the goal and all correct. Every one of
      // them read as "no ground gained", and eleven of those exhaust the budget.
      //
      // Live, that is exactly what happened: `walk_to` gave up after 38 steps with
      // `refused_edges: 1` and `routed_around: []` — nothing in the way, one wall learned,
      // and the walk abandoned in a room the same route completes offline in 93 steps.
      //
      // The route's own length is the honest measure: a shorter plan than any seen means
      // the walk is closer to done however the crow flies. Both are kept, because either
      // one improving is progress.
      const gap = Math.max(Math.abs(now.row - row), Math.abs(now.col - col));
      const routeLeft = re.found ? (re.steps?.length ?? Infinity) : Infinity;
      const gainedGround = gap < closest || routeLeft < shortestRoute;
      if (gap < closest) closest = gap;
      if (routeLeft < shortestRoute) shortestRoute = routeLeft;
      // A body in the way buys its own replan, up to a bound.
      const bodyPaid = hitSomething && collisionReplans < collisionReplanMax
        ? (collisionReplans++, true) : false;
      if (!learned && !gainedGround && !bodyPaid && ++replans > replanBudget)
        return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                 routed_around: [...occupied], refused_edges: blockedEdges.size,
                 ...(monsterBlocks ? { monster_blocked: monsterBlocks,
                                       blocked_by_bodies_at: [...blockedBy] } : {}),
                 ...(damageWhileBlocked ? { damage_while_blocked: damageWhileBlocked } : {}),
                 note: damageWhileBlocked
                   ? `kept ending up somewhere other than the planned square, and lost ` +
                     `${damageWhileBlocked} health to whatever is standing in the way`
                   : 'kept ending up somewhere other than the planned square' };
      // A SWITCH TO FINE MOVEMENT HERE WAS TRIED, AND ITS MEASUREMENT WAS INVALID.
      //
      // The idea was to hand the remainder of a walk to `walkFine` once `offPlan` passed
      // a threshold. It A/B'd at 1/5 against 4/5 for the plain square walk, which looked
      // decisive — and was not: a second agent was committing to this same file between
      // the two arms (5421a69, a4d4c71), so the arms differed by more than the change
      // under test. The comparison is withdrawn rather than reported.
      //
      // It is still not reinstated, for a reason that survives the bad measurement: those
      // two commits found the actual causes of the same symptom — the outward step past a
      // boundary was clipped and never sent, and `neighbors()` was gating every step on
      // the monster grid — and both are upstream of the off-plan rate this was trying to
      // paper over. Fixing a rate is the wrong move when the thing generating it has just
      // been fixed properly.
      //
      // `offPlan` is kept as TELEMETRY only. It costs an integer, it is the number that
      // would say whether the remaining slide still matters, and nothing acts on it.
      // `re` was computed above, before the budget, because the budget needs it — see the
      // note there. A replan is exactly when something has moved into the way, so its
      // threat field is re-read at that point rather than reused from the top of the walk.
      if (!re.found) {
        // RELAX IN THE ORDER THE FACTS DECAY. Occupancy is a guess about where something
        // was standing a moment ago and is dropped first; a refused edge is a wall and is
        // kept. Only if that still fails is the collision model itself set aside — being
        // wrong about a wall costs a walk, and refusing costs the errand, so the last try
        // is the coarse grid we planned on before any of this existed.
        let open = occupied.size
          ? geo.path(now.row, now.col, row, col,
              { blockedEdges, threats: this.threatsHere(), clearance })
          : re;
        if (open.found) occupied.clear();
        else if (blockedEdges.size) {
          // NOT CLEARED, ONLY SET ASIDE FOR THIS ONE PLAN. Forgetting the refusals would
          // re-enter the same bounce with the same enthusiasm; keeping them means the hop
          // coalescer still steps over them and the next replan still knows. If the coarse
          // plan's own first step is one of them we fail again, learn nothing new, and the
          // budget above ends the walk honestly instead of grinding.
          open = geo.path(now.row, now.col, row, col, { collision: false });
          if (open.found) occupied.clear();
        }
        // AND THE POCKET CAN BE WALKED INTO MID-WALK, not only stood in at the start —
        // a slid step lands where it lands, and where it lands can be cut off. Same
        // escape, once per walk: undoing the trail twice would unwind the journey.
        if (!open.found && !escaped) {
          const out = await this.retreatAlongBreadcrumbs({
            movementGeneration, controlToken,
            until: () => geo.path(c.self?.row ?? -1, c.self?.col ?? -1, row, col,
              { blockedEdges }).found,
          });
          if (out.cancelled) return out;
          escaped = Math.max(1, out.steps ?? 0);
          const at = c.self;
          if (out.moved && at) open = geo.path(at.row, at.col, row, col, { blockedEdges });
        }
        if (!open.found)
          return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                   refused_edges: blockedEdges.size, reason: open.reason,
                   ...(escaped ? { retreated: escaped } : {}) };
        queue = open.steps.slice();
        pulled = undefined;      // a new plan needs its own proof
        continue;
      }
      queue = re.steps.slice();
      pulled = undefined;          // a new plan needs its own proof
    }
    // ARRIVED IS A FACT ABOUT THE WORLD, AND `c.self` IS A BELIEF ABOUT IT.
    //
    // This read `c.self` directly, and `predictSelf` writes to `c.self` after every proved leg
    // WITHOUT a read-back — that is the whole point of a proof, and it is the right trade per
    // leg. What it is not is evidence at the end. When a prediction is wrong the belief is
    // wrong, `arrived` is computed from the wrong belief, and the walk reports success for a
    // step the body never made.
    //
    // Measured on the shadow fleet, 2026-08-28, with the keeper held so nothing else could move
    // the character, twice in a row:
    //
    //     walk 47,14 -> 46,15 in room 578
    //     reply  { arrived: true, position: { col: 15, row: 46 }, steps: 1, replans: 0 }
    //     server  47,14, fine 928,3040 — the exact centre of the take-off square
    //
    // That is the operator's "the baked route goes through a wall", seen from the inside: the
    // planner believes the step exists, the mover believes it happened, and the body has not
    // moved. It is why characters sat in the Cragged Mountains at full health with live jobs
    // and NOTHING logged a failure — every leg reported success — and why `baked_rail` rows
    // read OK for crossings that never happened. I spent an hour comparing step predicates
    // because they were measurable; the thing to measure was whether the body moved.
    //
    // ONE READ, AT THE END. The same trade the proved-route path above already makes at
    // `confirmPosition()` — one round trip per walk, not per step. A walk is seconds of work
    // and this is 1.2 to 5.6s at worst on a bad link; reporting a false arrival costs a leg,
    // and silently, which is far more expensive.
    // AND THE FINAL VERDICT, WHICH HAS TO BE THE STRICTEST OF THE THREE. Unconfirmed is
    // not arrived: the whole point of this read is that dead reckoning cannot be trusted to
    // mark its own homework, and `arrived` here is what a journey counts a leg by.
    const okEnd = await this.confirmPosition?.().catch(() => null);
    const me = okEnd ?? c.self ?? await this.selfOrResync?.().catch(() => null) ?? null;
    const arrived = !!okEnd && !!me && me.col === col && me.row === row;
    // MONSTER COLLISION DURING TRAVEL IS NAMED, EVERY TIME, INCLUDING ON SUCCESS.
    //
    // The failure this repairs was not that the walk stopped — it was that the reply
    // said `stopped after 40 steps` and nothing else, so an operator watching a bot
    // shuffle in a corridor had no way to tell a plugged corridor from a wall, and the
    // fault was filed against the geometry it happened to be standing near. A count and
    // the squares are enough to tell them apart at a glance, and reporting it on a
    // SUCCESSFUL walk matters just as much: that is how "this route is fine but it costs
    // us thirty steps whenever the rats are out" becomes visible at all.
    const bodies = monsterBlocks
      ? { monster_blocked: monsterBlocks, blocked_by_bodies_at: [...blockedBy],
          ...(sidestepped.size ? { sidestepped: sidestepped.size } : {}),
          // WHAT IT COST, NOT JUST THAT IT HAPPENED. "11 monster collisions" reads as
          // traffic; "11 monster collisions and 33 health" reads as the thing that killed
          // the character, and only the second tells an operator which rooms are eating
          // the fleet. Absent when nothing was lost, so a quiet block stays quiet.
          ...(damageWhileBlocked ? { damage_while_blocked: damageWhileBlocked } : {}) }
      : {};
    return { arrived, position: me && { col: me.col, row: me.row }, steps: taken, replans,
             ...bodies,
             ...(taken >= maxSteps
                 ? { note: monsterBlocks
                       ? `stopped after ${maxSteps} steps — ${monsterBlocks} monster collision(s) ` +
                         'during travel ate the budget; the route itself was not refused' +
                         (damageWhileBlocked ? `, and it lost ${damageWhileBlocked} health standing there` : '')
                       : 'stopped after ' + maxSteps + ' steps' }
                 : {}) };
  }

  // Leave the room. The tool picks the mechanism, because using the wrong one
  // produces no reply at all:
  //   an edge exit -> walk to the boundary square, then one more step outward
  //   a `go` exit  -> stand on EXACTLY the exit square, then BP_REQ_GO
  // ================== THE RAIL: A BAKED CROSSING, FOLLOWED RATHER THAN REPLANNED ==================
  //
  // WHY THIS EXISTS. Whether a character is "on the coarse grid" or "on the fine grid" it is
  // always walking the fine one — the coarse square is a handle, a short name for a stand
  // point. The trouble is that the PLANNER re-derives its route from wherever the body
  // actually is, and inside terrain the coarse grid cannot express, every move slides. So
  // the walker lands off-plan, replans, produces a route that slides again, and thrashes:
  // measured in the Cragged Mountains, one character aimed at the same grid-solid square
  // sixty-one times in seventy seconds while holding a live order to cross the room.
  //
  // The routes for exactly this were baked long ago and never driven. `bakedPath` returns
  // the square-by-square crossing between two exit anchors — 64 steps for 598's north exit
  // to its south one — and `m59-routes.mjs --verify` already re-walks every one of them.
  // The only caller in the tree was a COMMENT explaining why something else asked a
  // different question. The permission to leave the grid got wired in; the path did not.
  //
  // Three parts, and the middle one is the whole point:
  //
  //   1. GET ON    an ordinary walk to the entry anchor, over ground the grid does express
  //   2. FOLLOW    the baked squares in order, re-aiming at the SAME square when a move
  //                slides, and never replanning — a replan is what loses the line
  //   3. COME OFF  arrive at the far anchor and hand back to ordinary travel
  //
  // It is advisory. Every failure returns null or a reason and the caller walks as it always
  // did, so a room with no baked route, a stale table, or a rail that cannot be joined costs
  // nothing but the attempt.
  railAcross(toSquare) {
    const table = activeRoutes();
    const room = Number(this.world?.room?.num ?? NaN);
    const r = table?.rooms?.[room] ?? table?.rooms?.[String(room)];
    if (!r?.anchors?.length || !toSquare) return null;
    const me = this.client?.self;
    if (!me) return null;
    // A GUTTER HEAD IS A BOARDABLE START, AND FOR A YEAR IT WAS NOT.
    //
    // The bake writes two kinds of line into `routes`: anchor-to-anchor, and one per GUTTER
    // — a place the room drops you into and does not walk you out of. The gutter half was
    // built for exactly the character this function serves, is keyed into `routes` the same
    // way, and `bakedPath` looks a line up BY KEY and never asks whether its start is an
    // exit. Only this candidate list did, and it read `r.anchors` alone. So every gutter
    // rail ever baked — 578's two, and the four the operator DECLARED in
    // substrate/m59-gutters.json after Ukgoth killed seven characters in thirty minutes —
    // was written to disk, verified by `--verify`, and never once offered to anybody.
    //
    // Measured in the Cragged Mountains, which is what sent me here. 217 of its squares
    // need 45+ steps to reach ANY exit; the worst needs 64. The north-east lobe of that
    // pocket (rows 2-18, cols 30-37) contains r10c33, where the operator reports characters
    // piling up, and it had no head at all: the detector's one head for the whole 776-square
    // group went to 20,48, in the EASTERN lobe. From r10c33 the north exit is 21.9 away by
    // crow and 60 steps by mover, and the nearest waypoint of the line that actually leaves
    // — 12,29 on the column-29 leg — is 4.5 by crow and FORTY-ONE steps to walk to, because
    // a cliff runs between them. One column west, r10c32 is nineteen steps from the same
    // exit. That is the whole shape of the trap, and a rail is the mechanism for it.
    //
    // Additive and inert where the bake found none: a room with no `gutters` gets exactly
    // the candidate list it got before. A head is not an exit, so `onBoundary` below leaves
    // interior heads alone and still steps the one boundary gutter (9,50) inland.
    const heads = [...r.anchors.map(a => ({ ...a, gutter: false })),
                   ...(Array.isArray(r.gutters) ? r.gutters : []).map(a => ({ ...a, gutter: true }))];
    // The entry anchor is whichever baked start actually has a line to where we are going.
    // Nearest first, because getting on is an ordinary walk and a shorter one is cheaper.
    const starts = heads
      .filter(a => !(a.row === toSquare.row && a.col === toSquare.col))
      .sort((a, b) => (Math.hypot(a.col - me.col, a.row - me.row))
                    - (Math.hypot(b.col - me.col, b.row - me.row)));
    for (const a of starts) {
      let squares = null;
      try { squares = bakedPath(table, room, { row: a.row, col: a.col }, toSquare); }
      catch { squares = null; }
      if (Array.isArray(squares) && squares.length) {
        // DO NOT GET ON AT A LIVE DOORWAY TO SOMEWHERE ELSE.
        //
        // `railAcross` picks the nearest OTHER anchor as the line's start, and an anchor is
        // by definition a crossing square — standing on it and slipping one square outward
        // leaves the room. Where the boundary carries more than one exit, that is not merely
        // a wasted step, it goes to the WRONG ROOM.
        //
        // The Western border of the Twisted Wood is exactly that shape. Its east edge is
        // split by a row condition, from the map's own data:
        //
        //     east -> 586 (Main gate to the city of Tos)  when row < 19
        //     east -> 597 (The Twisted Wood)              when row > 20
        //
        // The line to 597 is baked from the 586 anchor at 9,67 — on the boundary, row 9,
        // inside the `row < 19` zone. So the walk to GET ON the rail ends with the character
        // standing in the doorway back to Tos, and the transit book fills with "crossed into
        // 586 instead of 597". Measured: every journey paid ~46s reaching 587 and ~11s
        // failing there before rerouting, on a crossing that is perfectly good.
        //
        // The anchor is still the right place to CROSS FROM at the far end; it is the wrong
        // place to STAND at the near end. The line's first square is one step inland, so get
        // on there instead and let the walk approach the boundary only where the line does.
        const geo = this.world?.geometry;
        const onBoundary = (sq) => geo && sq
          && (sq.row === 1 || sq.col === 1
              || sq.row === Number(geo.rows) || sq.col === Number(geo.cols));
        if (onBoundary(a)) {
          let n = 0;
          while (n < squares.length - 1 && onBoundary(squares[n])) n++;
          if (n < squares.length - 1)
            return { from: squares[n], squares: squares.slice(n + 1), steppedOffBoundary: true,
                     gutter: a.gutter === true };
        }
        return { from: a, squares, gutter: a.gutter === true };
      }
    }
    return null;
  }

  /**
   * STEP OFF THE DOORWAY YOU JUST CAME THROUGH.
   *
   * A crossing lands the body ON the far room's boundary — that is what a boundary is — and
   * the very next movement is then one square from leaving again. Where the edge carries
   * more than one exit that is not a wasted step, it is the WRONG ROOM; and where it carries
   * one, it is straight back where we came from.
   *
   * Measured: `587 -> 597 OK` immediately followed by `587 -> 597 FAIL crossed into 586`.
   * The first crossing genuinely succeeded — the check verifies the room number — and then
   * the character drifted west out of 597's arrival anchor at 5,1, which sits on 597's own
   * west boundary, and was back in 587. The same shape as boarding a rail at a live doorway,
   * one room later.
   *
   * One square inland, onto ground the mover already agrees is standable, and only when the
   * body is actually on a boundary. If it fails, nothing is worse than it was.
   */
  async stepInland(margin = INLAND_MARGIN_SQUARES) {
    const geo = this.world?.geometry;
    if (!geo) return false;
    const rows = Number(geo.rows), cols = Number(geo.cols);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return false;
    let moved = false;
    // At most one step per axis per call: this is a nudge off a doorway, not a walk.
    for (let n = 0; n < 2; n++) {
      const me = this.client?.self;
      if (!me) break;
      // How far from each boundary, and which way is inland from the nearest one.
      const dr = me.row <= margin ? 1 : me.row > rows - margin ? -1 : 0;
      const dc = me.col <= margin ? 1 : me.col > cols - margin ? -1 : 0;
      if (!dr && !dc) break;                          // clear of every edge; nothing to do
      const tries = [{ dr, dc }, { dr, dc: 0 }, { dr: 0, dc }].filter(t => t.dr || t.dc);
      let stepped = false;
      for (const t of tries) {
        const r = me.row + t.dr, c = me.col + t.dc;
        if (typeof geo.standable === 'function' && !geo.standable(r, c)) continue;
        if (typeof geo.moverStepLands === 'function' && !geo.moverStepLands(me.row, me.col, r, c)) continue;
        const out = await this.step(c, r).catch(() => null);
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(out);
        if (out?.left_room) return moved;             // it went out anyway; nothing to add
        const now = this.client?.self;
        if (now && now.row === r && now.col === c) { stepped = true; moved = true; break; }
      }
      if (!stepped) break;                            // nowhere inland from here; leave it
    }
    return moved;
  }

  /**
   * PUT THE BODY BACK IN THE MIDDLE OF THE SQUARE IT IS ALREADY STANDING ON.
   *
   * THE BAKE TRACES CENTRE TO CENTRE. THE MOVER TRACES FROM WHERE THE BODY ACTUALLY IS.
   * Those are different questions and the gap between them is a wall.
   *
   * Measured in room 586: the body sat on square 47,14 and every westward target from 47,13
   * out to 47,5 was refused `geometry_blocked` — eighteen times for the adjacent one alone.
   * Offline, from the CENTRE of 47,14, `moverStepLands` and `stepAllowedByCollision` both
   * say 47,13 is fine, and both squares are walkable and standable. Nothing was wrong with
   * the line. The body had slid to a fine position inside its own square, hard against a
   * wall, and from there the fine trace west hits that wall immediately.
   *
   * That is the whole of "people get caught on the wall half way through and just stand
   * there": nine consecutive waypoints refused, the rail abandoned, and every instrument
   * reporting a healthy character with somewhere to be.
   *
   * A step of at most half a square, onto ground the mover has already agreed is standable,
   * and it is the body's OWN square so there is no boundary to cross. If it fails, nothing
   * is worse than it was.
   */
  async recentreInSquare() {
    const geo = this.world?.geometry;
    const me = this.client?.self;
    if (!geo || !me || typeof geo.standPointWire !== 'function'
        || typeof this.walkFine !== 'function') return false;
    if (typeof geo.standable === 'function' && !geo.standable(me.row, me.col)) return false;
    // `walkFine` and `client.self` use protocol/wire coordinates. `standPoint` is in
    // client units (16x finer), so passing it here aims almost sideways at a point far
    // outside the room instead of back into this square.
    const pt = geo.standPointWire(me.row, me.col);
    if (!pt) return false;
    const r = await this.walkFine(pt.x, pt.y, { maxSteps: 3, stride: 24 }).catch(() => null);
    return !!(r?.arrived ?? r?.moved);
  }

  /**
   * Walk a baked line square by square. NO REPLANNING — that is the contract.
   *
   * A slide re-aims at the SAME square rather than asking the router where to go from the
   * new position, because the router's answer inside fine-only ground is what produced the
   * thrash this replaces. `maxSlips` bounds how long one square may be insisted on, so a
   * rail that genuinely cannot be walked gives up and lets the ordinary walk try.
   */
  async followRail(squares, { movementGeneration = this.movementGeneration,
                              controlToken = null, maxSlips = 4, maxSkips = 8,
                              avoidSquares = null } = {}) {
    let walked = 0, skipped = 0, skippedInARow = 0, missed = 0;
    // GROUND ALREADY MADE IS NOT GIVEN BACK.
    //
    // A rail is an ordered line, so "how far along are we" is a NUMBER, and the walker never
    // consulted it. Measured in the Cragged Mountains: the body reached waypoint 24 at
    // col 23 row 26, slid back to col 22 row 26 — which is not on the line at all — and then
    // ping-ponged between the two while trolls hit it. Fifty seconds in that room, nine
    // squares of net progress, against a human who crosses it in about five squares a second.
    //
    // The slide itself is ordinary and unavoidable: a step lands where the geometry puts it,
    // not where it was aimed. What turned a slide into a dither is that the next aim was taken
    // from wherever the body ended up, with no memory that it had already been further on. So
    // it walked the same two squares over and over, each attempt perfectly reasonable.
    //
    // `furthest` is the highest waypoint index the body has actually stood on. Aiming never
    // goes behind it, and when the line stops yielding it jumps AHEAD rather than retrying the
    // neighbour — a line that cannot be walked one square at a time from here is frequently
    // rejoinable a few squares on, and every second spent proving otherwise is a second in the
    // room.
    let furthest = -1, sinceProgress = 0;
    const onLine = (at) => {
      if (!at) return -1;
      for (let n = squares.length - 1; n >= 0; n--)
        if (squares[n].row === at.row && squares[n].col === at.col) return n;
      return -1;
    };
    for (let i = 0; i < squares.length; i++) {
      // NEVER AIM BEHIND. If a slide put us further along than the cursor, take the credit;
      // re-walking ground we are already past is the dither itself.
      const standingAt = onLine(this.client?.self);
      if (standingAt > furthest) { furthest = standingAt; sinceProgress = 0; }
      if (furthest >= i) { i = furthest; continue; }
      const target = squares[i];
      // THE RAIL IS WALKED AS BAKED, AND GOING PAST WHAT IS ON IT IS `aimInto`'S JOB.
      //
      // A first attempt at this re-planned any contested waypoint through the threat-aware
      // router and spliced a square-level detour into the line. That was the wrong
      // resolution and it is worth saying why, because it is the mistake CLAUDE.md warns
      // about in capitals: THE FINE GRID IS THE REALITY, A SQUARE IS A SUMMARY. Reasoning in
      // squares says a one-square corridor with a spider in it is closed. It is not — a
      // square is 64 kod units and a body is about 31 across, so two of them pass inside one
      // square with room to spare, which is exactly how a person walks the pinch at cols
      // 44-46 of the Western border of the Twisted Wood.
      //
      // So there is no detour here at all. The line stays the line, and the threading happens
      // one level down, where the aim point inside each square is chosen — see `aimInto` and
      // `bodiesInSquare`.
      let slips = 0, gaveUpOnThisSquare = false, recentred = false;
      for (;;) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          // NAMED, BECAUSE AN UNNAMED CANCELLATION READS AS A REFUSAL. This is the only
          // exit from the follow loop that carried no `reason`, so the ledger printed
          // "slipped at 16 of 65: undefined" — which looks exactly like the mover rejecting
          // a baked square, and sent me looking for a bad bake. It is the opposite: the
          // squares were fine and something took the body away mid-line.
          return { railed: false, cancelled: true, reason: 'movement_cancelled', at: i, walked,
                   // WHO, not just THAT. The rail dies at the same index every lap and the
                   // ledger could only say "something took the body off the line".
                   cancelled_by: this.lastMovementCancel?.why ?? 'unattributed',
                   cancelled_ms_ago: this.lastMovementCancel
                     ? Date.now() - this.lastMovementCancel.at : null };
        const here = this.client?.self;
        if (here && here.col === target.col && here.row === target.row) break;
        // FINE GROUND IS WALKED FINELY. THIS IS THE WHOLE REASON THE RAIL EXISTS.
        //
        // A rail crosses terrain the coarse grid cannot express — that is what it is for —
        // and `step` aims at a square's stand point as a COARSE move, which is the thing
        // that slides in exactly this ground. Measured: the rail carried a character 24 of
        // 64 squares and gave up at the boundary where the line enters fine-only floor
        // (index 26 onward reads walkable=false the whole way).
        //
        // So where the grid does not admit the square, hand the step to the fine mover and
        // aim at the same stand point in wire units. The square is still the handle; the
        // walk underneath it is the fine one it always really was.
        const geo = this.world?.geometry;
        const fineOnly = geo && typeof geo.walkable === 'function'
          && !geo.walkable(target.row, target.col);
        // `walkFine` consumes protocol/wire coordinates; `standPoint` is client-space.
        // The wrong unit here turns a diagonal fine-only rail into an almost-horizontal
        // aim at a point roughly sixteen times farther away.
        const pt = fineOnly && typeof geo.standPointWire === 'function'
          ? geo.standPointWire(target.row, target.col) : null;
        // A DECLARED FALL-JUMP IS NOT A WALK, AND WALKING IT IS HOW UKGOTH STRANDS PEOPLE.
        //
        // `m59-falljumps.json` says it outright: the mover's one vertical rule gates
        // climbing, so "none of these can be expressed as a step". `step()` has taken
        // `{ fall: true }` since fallTargets landed, and the planner's own waypoints carry a
        // `fall` flag which its walkers honour. The RAIL never did — it reaches every
        // waypoint with `walkFine`, which has no way to be told that this one is a drop.
        //
        // Ukgoth's jump, 36,16 -> 38,10, through the mover's own predicate. Same pair, same
        // slide, only the flag differs:
        //
        //     fall=false  slide=true    ends 38.1,12.3   destinationFloor 3200
        //     fall=true   slide=true    ends 38.1,10.3   destinationFloor 3840
        //
        // 3840 is the shelf the jump is for. 3200 is the floor of the gulley, and the way
        // out of the gulley does not exist: 38,13 -> 38,12 is 640 units of rise against a
        // MAX_STEP_HEIGHT of 384 and traces `geometry_blocked` under every combination of
        // slide and fall. From inside that pocket the strict geometry reaches 681 squares,
        // and neither Castle Victoria nor the Cragged Mountains is among them.
        //
        // Only a DECLARED jump takes this path. That is the whole safeguard: the table is
        // operator-supplied and walked, never derived, so this cannot become a general
        // licence to move through geometry the mover refuses.
        const declaredJumpHere = (here && geo && typeof geo.declaredFallJumps === 'function')
          ? geo.declaredFallJumps(here.row, here.col)
              // declaredFallJumps returns the LANDING as {row, col, dir:'fall', distance},
              // not a nested {to:{...}} — reading it as the latter is a check that silently
              // never fires, which is the failure mode this repository keeps meeting.
              .some(j => j.row === target.row && j.col === target.col)
          : false;
        // A BAKED ROUTE'S OWN DROP IS A FALL TOO, EVEN WHEN NOBODY DECLARED IT.
        //
        // The declared table describes ONE jump in Ukgoth, 36,16 -> 38,10. The baked route
        // the fleet actually rides does not use it: its tail is 34,19 -> 38,15 -> 38,12,
        // and 38,15 is floor 6080 while 38,12 is 3840. That step is a 2240-unit drop, and
        // because it is not in the table `jumpHere` was false, so the rail reached it with
        // `walkFine` — and this file already measured what that does:
        //
        //     fall=false  slide=true   ends 38.1,12.3   destinationFloor 3200   the gulley
        //     fall=true   slide=true   ends 38.1,10.3   destinationFloor 3840   the shelf
        //
        // So the rail was walking off the drop instead of falling down it, landing in the
        // hole every time, and every jump fix in this file applied only to a pair the route
        // never takes. The operator saw it from inside the room before the ledger did: "the
        // jumps I'm watching just don't look like they're trying the right thing".
        //
        // THIS IS NOT A NEW CLAIM ABOUT THE MAP, which is the line the declared table
        // exists to hold. The waypoint pair comes from the route bake, which computed it on
        // the mover's own geometry and stored it; all that is added here is sending it with
        // the flag that matches what it IS. Only downward, only along a baked rail, and only
        // past MAX_STEP_HEIGHT — a step the mover could walk needs no special handling.
        const bakedDropHere = (() => {
          if (declaredJumpHere || !here || !geo || !target) return false;
          try {
            const a = geo.standPoint(here.row, here.col);
            const b = geo.standPoint(target.row, target.col);
            if (!a || !b) return false;
            const fa = geo.floorBaseAtClient(a.x, a.y), fb = geo.floorBaseAtClient(b.x, b.y);
            if (!Number.isFinite(fa) || !Number.isFinite(fb)) return false;
            return (fa - fb) > MAX_STEP_HEIGHT;
          } catch { return false; }
        })();
        const jumpHere = declaredJumpHere || bakedDropHere;
        // AND AIM THE JUMP AT WHICHEVER LANDING IS CLEAREST, NOT ALWAYS THE DECLARED ONE.
        //
        // Measured over 54 attempts in Ukgoth with the fleet running a circuit through the
        // room, so the traffic was real rather than staged:
        //
        //     re-aim by clearance   15/19 = 79%   clear line 81%   BLOCKED line 2/3 = 67%
        //     wait, then jump        5/8  = 63%   clear line 100%  blocked line 0/3
        //     jump blind             9/24 = 38%   clear line 50%   blocked line 0/6
        //
        // Re-aiming is the only response that ever beats a blocker. Waiting and jumping blind
        // both go 0 against one, because the line from the ledge passes directly over the pit
        // and a falling body is clipped by anything in a square it passes THROUGH — every such
        // attempt ends in the gulley on top of whatever stopped it.
        //
        // The candidates are the landings the declared jump's own shelf offers: the declared
        // one and its neighbours ON THE SAME FLOOR, which is what keeps this a variation of a
        // walked jump rather than a new claim about the map. Ties go to the declared landing.
        // QUEUE FOR THE LEDGE RATHER THAN CROWDING IT.
        //
        // A fall-jump take-off is one square, and the approach to it is a ledge one or two
        // squares wide. When several characters want it at once they stand on each other,
        // push each other off, and the ones waiting become the obstacle the jumper is trying
        // to avoid — measured as 'left the ledge before jumping' becoming the commonest
        // outcome, and as a room in which nobody could reach the take-off at all.
        //
        // So a character that finds one of its own already at the ledge does not join it. It
        // falls back to the nearest covered square that is FARTHER from the take-off than
        // whoever is there — a queue by distance, formed without anybody coordinating — and
        // tries again on the next pass. Waiting costs seconds; the pit costs a lap of Ukgoth,
        // which is the arithmetic that makes this worth doing at all.
        // A JUMP AT A WALK IS A FALL INTO THE GULLEY, AND NOTHING WAS CHECKING.
        //
        // `m59-falljumps.json` declares `requires: {running: true}` for this jump, and
        // `traversable()` in m59-falljump.mjs is the function that honours it -- its own
        // docstring says why: "at a walk you do not clear the gap... falling into a gulley
        // is not a cheap mistake". That module was imported by NOBODY. The gate has never
        // run, so a character below the run threshold committed to the jump exactly as one
        // that could run, fell short, and landed in the pit at 3200 where the only ways out
        // are 640 units of rise against a MAX_STEP_HEIGHT of 384.
        //
        // AND THE ANSWER IS TO SIT DOWN, NOT TO GIVE UP. The take-off ledge is above the
        // jump by construction -- reaching it is what makes `jumpHere` true -- so the place
        // to wait is where the character already stands. Resting here costs a minute and
        // saves the character; refusing outright would send the journey round a route that
        // does not exist, and jumping anyway is what has been happening.
        //
        // Bounded, and it gives up rather than sitting on a ledge for ever. Health falling
        // means this is not a safe place to sit after all, and the survival ladder owns that
        // decision -- so this stops and lets the caller replan rather than resting into a
        // death.
        if (jumpHere) {
          const vitalsNow = () => { try { return this.client?.vitals?.() ?? null; } catch { return null; } };
          const vigorNow = () => vitalsNow()?.vigor?.value ?? null;
          const declared = (() => {
            try { return geo.declaredFallJumps(here.row, here.col)
              .find(j => j.row === target.row && j.col === target.col) ?? null; } catch { return null; }
          })();
          const needsRun = declared ? (declaredJumpNeedsRun(this.world?.room?.num, here, target) !== false) : false;
          if (needsRun && Number.isFinite(vigorNow()) && vigorNow() < RUN_VIGOR_FLOOR) {
            const c2 = this.client;
            const startedAt = Date.now();
            const waitMs = Number(process.env.M59_JUMP_REST_MS || 120000);
            const hp0 = vitalsNow()?.health?.value ?? null;
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'jump_rest', trigger: 'vigor_below_run', worked: false, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `vigor ${vigorNow()} is under the run floor ${RUN_VIGOR_FLOOR}; ` +
                                 `resting on the take-off ledge at ${here.row},${here.col}` });
            await this.pacer.submit('rest', () => c2.rest()).catch(() => null);
            let rested = false;
            while (Date.now() - startedAt < waitMs) {
              if (this.movementWasCancelled(movementGeneration, controlToken)) break;
              await new Promise(r => setTimeout(r, 3000));
              const v = vigorNow();
              if (Number.isFinite(v) && v >= RUN_VIGOR_FLOOR) { rested = true; break; }
              const hp = vitalsNow()?.health?.value ?? null;
              // Being hit while sitting on a ledge is not resting, it is dying slowly.
              if (Number.isFinite(hp) && Number.isFinite(hp0) && hp < hp0) break;
            }
            await this.pacer.submit('move', () => c2.stand()).catch(() => null);
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'jump_rest', trigger: 'vigor_below_run', worked: rested,
                           ms: Date.now() - startedAt, hp_lost: 0, attempted: true,
                           note: rested ? `vigor reached ${vigorNow()}, taking the jump`
                                        : `still ${vigorNow()} after ${Math.round((Date.now() - startedAt) / 1000)}s` });
            if (!rested) {
              // REFUSED, NOT ATTEMPTED. This is the whole point of the gate: the character
              // stays on the ledge it can stand on rather than in the hole it cannot leave.
              return { railed: false, reason: 'jump_needs_run', at: i, walked,
                       note: `this jump needs a run and vigor is ${vigorNow() ?? '?'} ` +
                             `against a floor of ${RUN_VIGOR_FLOOR}; rested on the ledge and it did not recover` };
            }
          }
          const others = (() => { try { return this.world?.objects?.() ?? []; } catch { return []; } })()
            .filter(o => o.is_player && o.id !== this.client?.selfId);
          const atLedge = others.filter(o =>
            Math.max(Math.abs(o.row - here.row), Math.abs(o.col - here.col)) <= 2);
          if (atLedge.length) {
            // Somebody else is on the ledge. Stand off, behind cover if there is any, farther
            // back than they are, and let them go first.
            const backoff = [];
            for (let r = here.row - 6; r <= here.row + 6; r++)
              for (let c = here.col - 6; c <= here.col + 6; c++) {
                if (geo.walkable(r, c) !== true) continue;
                let same = false;
                try {
                  const a = geo.standPoint(here.row, here.col), b = geo.standPoint(r, c);
                  same = a && b && Math.abs(geo.floorBaseAtClient(a.x, a.y) - geo.floorBaseAtClient(b.x, b.y)) <= 64;
                } catch {}
                if (!same) continue;
                const d = Math.max(Math.abs(r - here.row), Math.abs(c - here.col));
                if (d < 3 || d > 6) continue;
                if (others.some(o => o.row === r && o.col === c)) continue;
                let cover = 0;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                  if (!dr && !dc) continue;
                  if (geo.walkable(r + dr, c + dc) !== true) cover++;
                }
                backoff.push({ row: r, col: c, d, cover });
              }
            backoff.sort((a, b) => b.cover - a.cover || a.d - b.d);
            const spot = backoff[0];
            if (spot) {
              await this.walkTo(spot.col, spot.row, { maxSteps: 12 }).catch(() => null);
              return { railed: false, reason: 'queued_for_the_jump', at: i, walked,
                       queued_behind: atLedge.length, waiting_at: `${spot.row},${spot.col}` };
            }
          }
        }

        let jumpTo = target;
        if (jumpHere) {
          const shelf = [];
          for (let dr = -1; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) {
            const cand = { row: target.row + dr, col: target.col + dc };
            if (geo.walkable(cand.row, cand.col) !== true) continue;
            let a = null, b = null;
            try {
              const pa = geo.standPoint(target.row, target.col);
              const pb = geo.standPoint(cand.row, cand.col);
              a = pa && geo.floorBaseAtClient(pa.x, pa.y);
              b = pb && geo.floorBaseAtClient(pb.x, pb.y);
            } catch {}
            if (a == null || b == null || Math.abs(a - b) > 64) continue;
            shelf.push(cand);
          }
          const bodies = (() => { try { return this.world?.objects?.() ?? []; } catch { return []; } })();
          if (shelf.length > 1 && bodies.length) {
            const gapTo = (cand) => Math.min(...bodies.map(o => {
              const vx = cand.col - here.col, vy = cand.row - here.row;
              const wx = o.col - here.col, wy = o.row - here.row;
              const len2 = vx * vx + vy * vy;
              const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
              return Math.hypot(here.col + t * vx - o.col, here.row + t * vy - o.row);
            }));
            // KEEP THE DECLARED LINE WHEN IT IS CLEAR; RE-AIM ONLY WHEN IT IS NOT.
            //
            // Sixty-eight measured jumps, every one of them a real attempt:
            //
            //     declared landing always   31/35 = 89%   clear 29/29 = 100%   blocked 2/6 = 33%
            //     always re-aim             29/33 = 88%   clear 27/30 =  90%   blocked 2/3 = 67%
            //
            // The same overall, and opposite where it matters. The declared landing is the one
            // somebody walked, and on a clear line it does not miss — twenty-nine for
            // twenty-nine. Re-aiming trades a little of that for the only thing that helps
            // when something is standing on the line, where it is twice as good.
            //
            // So there is no reason to choose between them: take the declared line whenever it
            // is clear, and go looking for a better one only when it is not.
            const DECLARED_CLEAR = 1.5;              // squares; below this something is on it
            const declaredGap = gapTo(target);
            if (declaredGap < DECLARED_CLEAR) {
              let best = { cand: target, gap: declaredGap };
              for (const cand of shelf) {
                const gap = gapTo(cand);
                if (gap > best.gap + 0.01) best = { cand, gap };
              }
              jumpTo = best.cand;
            }
          }
        }
        const r = jumpHere
          ? await this.step(jumpTo.col, jumpTo.row, { fall: true })
              .catch(e => ({ moved: false, reason: e.message }))
          : (pt && typeof this.walkFine === 'function')
          ? await this.walkFine(pt.x, pt.y, { maxSteps: 6, stride: 40, avoidSquares })
              .then(w => ({ ...w, moved: w?.arrived ?? w?.moved }))
              .catch(e => ({ moved: false, reason: e.message }))
          : await this.step(target.col, target.row);
          if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        if (r.left_room) return { railed: true, left_room: true, at: i, walked };
        if (isTerminalMovementReason(r.reason))
          return { railed: false, reason: r.reason, at: i, walked };
        const now = this.client?.self;
        // ON THIS WAYPOINT *OR FURTHER ALONG* IS PROGRESS, AND BOTH END THE RETRY.
        //
        // This asked only "did we land exactly on the square we aimed at", so a step that
        // OVERSHOT — landed further down the same line, which a slide does routinely — read
        // as a miss and the retry re-aimed at a waypoint the body was already past. That is
        // the dither, and it is invisible from inside the loop: every individual aim is
        // correct, and the body walks backwards to collect a square it does not need.
        const landed = onLine(now);
        if (landed >= i) break;
        // SLID. Aim at the same square again rather than re-deriving the route.
        // A WAYPOINT IS NOT THE LINE. Missing one square does not invalidate the other
        // sixty-three, and abandoning the whole rail for it is how a crossing that was
        // three-quarters done went back to the thrash: measured, the follower gave up at
        // index 24 of 64 — on ORDINARY floor — four runs in a row. Skip the square and aim
        // at the next one; the line ahead is still the line. Consecutive skips are bounded,
        // because a rail nothing can be hit on is a rail worth leaving.
        // ONE RE-CENTRE BEFORE GIVING UP ON A SQUARE, AND ONLY FOR A GEOMETRY REFUSAL.
        //
        // `geometry_blocked` from a square the bake calls walkable means the BODY is in the
        // wrong part of its own square, not that the line is wrong — see recentreInSquare.
        // Tried once per waypoint: if standing in the middle does not help, the square is
        // genuinely refused and the skip below is the right answer.
        if (slips === 1 && r.reason === 'geometry_blocked' && !recentred) {
          recentred = true;
          if (await this.recentreInSquare()) continue;
        }
        // A refused step costs no packet and no time; without this the slip loop is a spin.
        if (!r?.moved && !r?.left_room) await new Promise(res => setTimeout(res, 30));
        if (++slips > maxSlips) {
          skipped++; missed++;
          // CONSECUTIVE, WHICH IS WHAT THE PARAGRAPH ABOVE ALWAYS CLAIMED IT WAS.
          //
          // `skipped` was declared once outside this loop and never reset, so it counted
          // every miss on the whole line. On a 65-square rail through the Twisted Wood that
          // is the difference between "this line cannot be walked" and "nine monsters stood
          // on it at some point during a two-minute crossing" — and the second is the
          // ordinary case, not a failure. Measured: room 586's rail died at index 35 of 40
          // seven times running, having walked the first 34 perfectly; every one of those 40
          // squares answers `moverStepLands` TRUE, so the line was never the problem.
          //
          // A rail is worth leaving when it cannot hit ANY of its next several waypoints —
          // that means the body is somewhere the line does not describe. Scattered misses
          // mean something was standing there, and the answer to that is the next square.
          if (++skippedInARow > maxSkips)
            return { railed: false, reason: 'slipped_off_rail', at: i, walked, skipped,
                     note: `${skippedInARow} waypoints missed in a row` };
          gaveUpOnThisSquare = true;
          break;
        }
      }
      if (!gaveUpOnThisSquare) skippedInARow = 0;
      walked++;
      // DID THAT WAYPOINT BUY ANYTHING? Measured on the line rather than on the cursor: the
      // cursor advances whether or not the body did, which is exactly how the dither stayed
      // invisible to every counter here.
      const after = onLine(this.client?.self);
      if (after > furthest) { furthest = after; sinceProgress = 0; }
      else if (++sinceProgress >= RAIL_STALL_WAYPOINTS) {
        // The line is not yielding from here. Jump ahead rather than grinding: a rail that
        // cannot be walked square by square at this point is usually rejoinable further on,
        // and `walkFine` covers the gap. Bounded by the same skip budget, so a rail nothing
        // can be hit on still gives up rather than skimming to the end.
        sinceProgress = 0;
        skipped += RAIL_STALL_JUMP;
        if (++skippedInARow > maxSkips)
          return { railed: false, reason: 'slipped_off_rail', at: i, walked, skipped,
                   note: `no forward progress on the line after ${maxSkips} jumps` };
        i += RAIL_STALL_JUMP;
      }
    }
    // A LINE THE BODY NEVER ADVANCED ON WAS NOT RIDDEN.
    //
    // The stall-jump above moves the CURSOR three waypoints at a time so a rail that cannot
    // be walked from here can be rejoined further on. On a short rail that runs the cursor
    // off the end in four jumps with the body still standing at the boarding square — and
    // this returned `railed: true`. The ledger then read "boarded at 1 of 11, followed 6 of
    // 10, skipped 12 ... ok" forty-six times in room 585 and five times in 578 on the day
    // the 578 line went straight over a ridge and killed everyone who boarded it; the
    // evidence said the rail worked and the wall face said otherwise. `furthest` is the
    // highest waypoint the body actually stood on: index 0 is where it got on, so anything
    // above that is progress and nothing above it is a slip, whatever the cursor did. The
    // caller's behaviour is unchanged either way — the ordinary crossing walk still follows —
    // only the verdict is now the body's rather than the cursor's.
    if (furthest <= 0 && squares.length > 1)
      return { railed: false, reason: 'slipped_off_rail', at: Math.min(furthest + 1, squares.length - 1),
               walked, skipped, missed, note: `the body never stood on a waypoint past the boarding square (cursor skipped ${skipped})` };
    return { railed: true, walked, skipped, missed };
  }

  // UPSTREAM'S leaveVia, TAKEN WHOLE.
  //
  // This method is where upstream did most of its movement work, and its terminal-
  // propagation test pins that control flow exactly. Ours had grown a staging
  // approach, exit-debug logging and a raw-grid fallback on top of the old shape, and
  // the hybrid failed their test in three different places -- each fix revealing the
  // next. Patching a control flow to satisfy a test written for a different control
  // flow is how both end up wrong, so this takes theirs entire.
  //
  // What that gives up, deliberately: the M59_EXIT_DEBUG traces and the distToStaging
  // fine-direct approach (whose `> 0` condition never matched its own comment), and
  // the raw-grid fallback, which was a beeline in a 50-second loop around an await.
  // COORDINATE CONTRACT: exit squares are named `{col,row}`; `fine_stand_on`,
  // `edge_target`, and fine-path points are named `{x,y}` in kod wire units.
  // TAKE A DOOR THAT LEADS BACK INTO THE ROOM IT IS IN.
  //
  // This is `leaveVia`'s twin for the one exit kind that does not leave. Castle Victoria
  // (castle1.kod:88-98) carries four of them, each a pair of squares one row either side
  // of an internal wall, and they are the only way between the halves of that room.
  //
  // IT CANNOT BE `leaveVia`, AND THE REASON IS IN UtilGoToSquare (util.kod:116). A `go`
  // ends in `UtilGoNearSquare`, which branches on whether the destination room is the one
  // the body is already in:
  //
  //     if Send(what,@GetOwner) = where     -> Send(where,@SomethingMoved, ...)
  //     else                                -> Send(where,@NewHold, ...)
  //
  // Only the second is a room change. A same-room door takes the first branch, so no
  // room-entered ever arrives - and `leaveVia` waits for exactly that, with a 4s timeout.
  // It would have called a door that worked a door that failed, every time.
  //
  // So this confirms by POSITION, and it confirms LOOSELY on purpose: the server does not
  // put the body on the square the exit names. `UtilGoNearSquare` spirals outward from it
  // and takes the first square that accepts, which is the same reason CLAUDE.md says that
  // call never says no. Landing within two squares of the stated arrival is the door
  // having worked; landing where we started is it not having fired.
  //
  // The walk onto the door square is `walkTo` plus a fine lean, the same shape `leaveVia`
  // uses and for the same reason: `SomethingTryGo` (room.kod:2777) matches piRow/piCol
  // against plExits with `=`, so it is that exact square or nothing, and a `go` exit's own
  // square is very often a pocket the coarse grid calls unreachable.
  async crossSameRoomDoor(door, { movementGeneration = this.movementGeneration,
                                  controlToken } = {}) {
    const c = this.need();
    const cancelled = () => this.movementWasCancelled(movementGeneration, controlToken);
    const cancellation = () => ({ crossed: false, cancelled: true, reason: 'movement cancelled by a newer command' });
    if (cancelled()) return cancellation();
    const roomBefore = Number(this.world?.room?.num ?? NaN);
    const before = await this.confirmPosition();
    if (cancelled()) return cancellation();
    const walked = await this.walkTo(door.col, door.row,
                                     { movementGeneration, controlToken, clearance: 1 })
                             .catch(error => ({ arrived: false, reason: error.message }));
    if (cancelled() || walked?.cancelled) return cancellation();
    if (walked?.left_room)
      return { crossed: false, reason: 'the room changed while walking to the internal door' };
    if (isTerminalMovementReason(walked?.reason))
      return { crossed: false, reason: walked.reason, note: walked.note };

    let at = await this.confirmPosition();
    if (cancelled()) return cancellation();
    if (at && (at.col !== door.col || at.row !== door.row)) {
      const half = KOD_FINENESS >> 1;
      const lean = await this.stepFine(door.col * KOD_FINENESS + half,
                                       door.row * KOD_FINENESS + half)
                             .catch(error => ({ moved: false, reason: error.message }));
      if (cancelled() || lean?.cancelled) return cancellation();
      if (isTerminalMovementReason(lean?.reason))
        return { crossed: false, reason: lean.reason, note: lean.note };
      at = await this.confirmPosition();
      if (cancelled()) return cancellation();
    }
    if (!at) return { crossed: false, reason: 'position_confirmation_timeout',
                      note: 'no `go` was sent, because the square under the body was unknown' };
    if (at.col !== door.col || at.row !== door.row)
      return { crossed: false, reason: 'not_on_door_square',
               note: `stood at r${at.row}c${at.col}, and the door is matched on exactly ` +
                     `r${door.row}c${door.col}` };

    if (this.movementWasCancelled(movementGeneration, controlToken))
      return { crossed: false, cancelled: true };
    const since = c.evSeq;
    // A same-room door is still `UserGo`, so it is still refused while seated. This sender
    // postdates d263bf0 and never had the call; see the note in `leaveVia`.
    await this.standBeforeGo();
    if (cancelled()) return cancellation();
    await this.pacer.submit('move', () =>
      this.movementWasCancelled(movementGeneration, controlToken) ? false : c.go());
    // The door announces itself - room.kod sends room_door_was_opened before it moves the
    // body - but the announcement is not the move, and a refusal (user_cant_go) is a
    // message too. The position is the fact; the sentences are evidence for a refusal.
    await new Promise(resolve => setTimeout(resolve, DOOR_SETTLE_MS));
    if (cancelled()) return cancellation();
    const after = await this.confirmPosition();
    if (cancelled()) return cancellation();
    const said = c.eventsSince(since).filter(e => e.text).map(e => String(e.text)).slice(0, 4);
    const roomAfter = Number(this.world?.room?.num ?? NaN);
    if (Number.isFinite(roomBefore) && Number.isFinite(roomAfter) && roomAfter !== roomBefore)
      return { crossed: false, left_room: true, said,
               reason: `an internal door moved the body to room ${roomAfter}`,
               note: 'the map calls this exit same-room; it is not, and the bake is wrong' };
    if (!after) return { crossed: false, reason: 'position_confirmation_timeout', said,
                         note: 'the `go` was sent and where it left the body is unknown' };
    const near = Math.abs(after.row - door.arriveRow) <= 2 &&
                 Math.abs(after.col - door.arriveCol) <= 2;
    const goMoved = after.row !== at.row || after.col !== at.col;
    if (near && goMoved) return { crossed: true, at: { row: after.row, col: after.col }, said };
    const moved = !before || after.row !== before.row || after.col !== before.col;
    return { crossed: false, at: { row: after.row, col: after.col }, said,
             reason: moved ? 'landed_off_target' : 'go_did_nothing',
             note: moved
               ? `expected to land near r${door.arriveRow}c${door.arriveCol}`
               : 'the body did not move; a refused `go` says so in prose and nothing else' };
  }

  /**
   * OPEN A DOOR THIS ROOM WILL OPEN FOR US — the half that was only ever reachable by an errand.
   *
   * `m59-guild-passage.mjs` worked this out on a live fleet and does it well, but it walks the
   * Bookmakers hall's five sections against a hand-written table, and the only callers are the
   * chest errand and the co-op runtime. So a character that merely wanted to LEAVE fell through
   * to the ordinary router, which plans on the frozen bake, finds a hall of welded doors and
   * says `route_progressing_exits_exhausted`. Zoot and Statler spent hours in 714 standing ON
   * `r4c28`, which is MAIN_DOOR's trigger, with the exit two squares past it.
   *
   * THIS ONE NEEDS NO TOPOLOGY, AND THAT IS THE WHOLE DIFFERENCE. guildPassage has to know
   * which square is on the far side because it is walking a fixed chain of sections. Opening a
   * door does not: once the sector has moved the LIVE geometry changes, so the caller simply
   * re-plans and the way through is there. That is what makes this composable with the router
   * rather than a second router.
   *
   * THE FOUR THINGS THAT WERE LEARNED THE EXPENSIVE WAY, kept exactly:
   *
   *   * the trigger is where the body IS — `SomethingTryGo` receives `piRow`/`piCol`
   *     (`user.kod:5669`), so this walks ONTO the door square and presses from there;
   *   * the press is a bare `go`, and the wait is for the SERVER's `sector-height` event.
   *     Never a duration: a geometry read taken mid-swing sees a shut door, which is the race
   *     guild-passage records as `no live path across the open door` — a sentence that reads
   *     exactly like "there is no way out of this room";
   *   * the settle follows this door's height span and the server's animation speed;
   *     slow guild doors must not inherit a fixed 2.2s cap or another sector's timer;
   *   * a second `go` while the door is already open does NOT restart its timer, so a retry
   *     waits the cycle out first.
   *
   * AND A SILENT PRESS ON A GATED DOOR IS A REFUSAL, NOT A SLOW DOOR. 714's main door asks
   * `ReqLegalEntry` and its lifts ask `IsMember`; a character without the right is answered
   * with nothing at all, which is this game's whole idiom. Retrying that is three wasted
   * five-second cycles, so a gated door that produces no event is abandoned after one attempt
   * and SAYS which gate refused it.
   *
   * Returns `{ opened, sector, reason }` and never throws — the caller records it.
   */
  async exitGuildHall({ movementGeneration = this.movementGeneration, controlToken } = {}) {
    if (Number(this.world?.room?.num) !== 714) return { attempted: false };
    const c = this.need();
    if (guildSection(c.self.row, c.self.col) === 0) return { attempted: false };
    const cancelled = () => this.movementWasCancelled(movementGeneration, controlToken);
    const keeper = autopilotIfAny(this.name);
    try {
      await guildPassage({ s: this,
        note: (what, facts) => keeper?.note(what, facts),
        sayHallPassword: () => keeper?.sayHallPassword() ?? { ok: false },
      }, 0, cancelled);
      return { attempted: true, crossed: !cancelled() && guildSection(c.self.row, c.self.col) === 0 };
    } catch (e) {
      return { attempted: true, crossed: false, reason: e.message, cancelled: cancelled() };
    }
  }

  async openOperableDoor({ movementGeneration = this.movementGeneration, controlToken,
                           isInterrupted = () => false } = {}) {
    const c = this.need?.();
    const cancelled = () => this.movementWasCancelled?.(movementGeneration, controlToken) || isInterrupted();
    if (!c) return { opened: false, reason: 'no client' };
    const roomNum = Number(this.world?.room?.num ?? NaN);
    if (!Number.isFinite(roomNum)) return { opened: false, reason: 'room unknown' };

    let plan = null;
    try { plan = doorsFor(roomNum, { row: c.self?.row, col: c.self?.col }); }
    catch { return { opened: false, reason: 'door table unreadable' }; }
    if (!plan || (!plan.on.length && !plan.others.length))
      return { opened: false, reason: 'this room has no door anybody can operate' };

    // Standing on one already is the case that matters. Otherwise take the nearest trigger —
    // Chebyshev, the metric the server's own range tests use.
    const here = { row: c.self?.row, col: c.self?.col };
    const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    const pick = plan.on[0] ?? [...plan.others]
      .map(p => ({ p, sq: p.stand_on.filter(s => Number.isFinite(here.row))
        .sort((x, y) => cheb(x, here) - cheb(y, here))[0] }))
      .filter(x => x.sq).sort((a, b) => cheb(a.sq, here) - cheb(b.sq, here))[0]?.p;
    if (!pick) return { opened: false, reason: 'no trigger square this body could aim at' };
    const target = plan.on.includes(pick)
      ? pick.stand_on.find(s => s.row === here.row && s.col === here.col)
      : pick.stand_on.slice().sort((x, y) => cheb(x, here) - cheb(y, here))[0];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancelled() || isInterrupted())
        return { opened: false, sector: pick.sector, reason: 'movement cancelled' };
      if (c.self?.row !== target.row || c.self?.col !== target.col) {
        const walked = await this.walkTo(target.col, target.row,
          { movementGeneration, controlToken }).catch(e => ({ arrived: false, reason: e.message }));
        if (cancelled() || walked?.cancelled)
          return { opened: false, sector: pick.sector, reason: 'movement cancelled' };
        await this.confirmPosition?.();
        if (c.self?.row !== target.row || c.self?.col !== target.col)
          return { opened: false, sector: pick.sector,
                   reason: `could not reach the trigger r${target.row}c${target.col}` +
                           (walked?.reason ? ` (${walked.reason})` : '') };
      }

      // Stand first: a seated press is refused before the room ever hears it (see
      // standBeforeGo, and m59-guild-passage's standUp for the 2026-09-24 incident).
      if (this.standBeforeGo)
        await this.standBeforeGo({ shouldCancel: () => cancelled() || isInterrupted() }).catch(() => null);
      const since = c.evSeq;
      await (this.pacer?.submit ? this.pacer.submit('move', () => c.go()) : c.go())
        .catch(() => {});
      const opening = await waitForDoorOpen(c, pick, { since, cancelled });
      if (cancelled()) return { opened: false, sector: pick.sector, reason: 'movement cancelled' };
      if (!opening.opened && refusedToGo(c, since))
        opening.reason = 'the server refused the press: "You are unable to go anywhere." ' +
                         '(seated, held or webbed), not a door that stayed shut';
      if (opening.opened) {
        return { opened: true, sector: pick.sector, name: pick.name, at: target,
                 animation_ms: opening.animation_ms,
                 shuts_after_ms: pick.within_ms,
                 reason: `sector ${pick.sector} moved; the live geometry has changed and the ` +
                         'route can be planned again' };
      }
      if (pick.gate)
        return { opened: false, sector: pick.sector, gate: pick.gate,
                 reason: `${opening.reason}; this door asks ${pick.gate}. ` +
                         'The opening was not verified; access or an existing door cycle may be responsible' };
      if (attempt < 2) {
        // A `go` while it is already open does not restart the five-second timer.
        const retryAt = Date.now() + 5200;
        while (Date.now() < retryAt && !isInterrupted() && !cancelled())
          await new Promise(r => setTimeout(r, 100));
      }
    }
    return { opened: false, sector: pick.sector,
             reason: 'pressed three times and no sector moved' };
  }

  // WHICH INTERNAL DOOR, IF ANY, JOINS US TO ONE OF THESE SQUARES. Thin: the search is
  // `sameRoomDoorPlan` in m59-world.mjs, which is pure and tested offline. This only
  // supplies the three live things it needs - the map, the geometry the MOVER enforces,
  // and where the body actually is.
  planSameRoomDoors(targets) {
    try {
      const room = this.world?.room;
      const geo = this.world?.geometry;
      const me = this.client?.self ?? this.c?.self ?? null;
      if (!room || !geo || !me) return null;
      return sameRoomDoorPlan(this.world.map, Number(room.num), geo,
                              { row: me.row, col: me.col, x: me.x, y: me.y }, targets);
    } catch { return null; }
  }

  async leaveVia(exit, { movementGeneration = this.movementGeneration, controlToken,
                         expectedRoomId = null } = {}) {
    // ROUTE AROUND THE PART OF THIS BOUNDARY THAT LEADS SOMEWHERE ELSE.
    //
    // Computed once, here, because BOTH movers need it and they are used in different
    // branches below. The coarse walker has honoured it since the split-boundary fix; the
    // fine walker is the one that actually reaches a boundary, and it was dragging along the
    // wall into the wrong door — four hundred and thirty refused fine moves creeping east
    // until the server sent the character back to the Main gate to the city of Tos.
    //
    // Guarded because `leaveVia` is lifted out of this file by text and evaluated against a
    // fake world that has no such method.
    const wrongDoor = typeof this.world?.wrongExitSquares === 'function'
      ? this.world.wrongExitSquares(exit) : null;
    const c = this.need();
    // A caller may have selected this exit before another movement finished changing rooms.
    // Pin that caller's protocol room, or the room visible on entry for direct callers:
    // applying source-room coordinates after any await in the new room is movement with the
    // wrong map, not another attempt at the same door.
    const selectedRoomId = expectedRoomId ?? c.room?.id ?? null;
    const selectedRoomNum = Number(this.world?.room?.num ?? NaN);
    const leftExpectedRoom = () => selectedRoomId != null && c.room?.id !== selectedRoomId;
    const staleExit = async () => {
      // The protocol identity is the immediate stop signal. Ask the server for BP_PLAYER
      // before calling it a successful crossing; that packet is the authoritative source of
      // both the room object and the logical room resources. Extracted/offline fixtures do
      // not expose refreshRoomIdentity, so they use a bounded stable-read fallback.
      let confirmed = false;
      if (typeof this.refreshRoomIdentity === 'function') {
        const refreshed = await this.refreshRoomIdentity().catch(() => null);
        confirmed = refreshed?.confirmed === true;
      } else {
        let room0 = Number(this.world?.room?.num ?? NaN);
        let roomId0 = c.room?.id ?? null;
        let stable = 0;
        for (let sample = 0; sample < 3 && stable < 2; sample++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          const nextRoom = Number(this.world?.room?.num ?? NaN);
          const nextRoomId = c.room?.id ?? null;
          if (nextRoom === room0 && nextRoomId === roomId0) stable++;
          else { room0 = nextRoom; roomId0 = nextRoomId; stable = 0; }
        }
        confirmed = stable >= 2;
      }
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement();
      const room = Number(this.world?.room?.num ?? NaN);
      if (confirmed && Number.isFinite(selectedRoomNum) && Number.isFinite(room)
          && room !== selectedRoomNum)
        return { left: true, late: true, confirmed_room_change: true,
                 arrived_in: this.world?.room?.name ?? String(room),
                 note: 'the source-room exit stopped when the room identity changed; ' +
                       'the logical room then confirmed the crossing' };
      return { left: false, room_changed: true, late: true,
        reason: 'room identity changed after this exit was selected',
        note: 'the source-room exit is stale, so none of its remaining coordinates were used' };
    };
    // A newer control order outranks evidence from the stale one, even when that order also
    // changed rooms (survival movement is the ordinary example).
    const stopAfterAwait = () => {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement();
      if (leftExpectedRoom()) return staleExit();
      return null;
    };
    const stoppedBeforeStart = await stopAfterAwait();
    if (stoppedBeforeStart) return stoppedBeforeStart;

    // RESTING IS A MOVEMENT LOCK, SO CLEAR IT BEFORE THE APPROACH, NOT AT THE DOOR.
    //
    // Player.ResetFlags sets PFLAG_NO_MOVE while seated. The server then refuses every
    // ordinary move on the way to an exit, which means a stand sent immediately before
    // `go` is too late and an edge crossing never reaches its outward packet at all. The
    // same ordering matters for a baked rail: boarding it is movement too. `stand` is safe
    // and deliberately unconditional (see standBeforeGo), and the shared pacer/socket keeps
    // it ordered ahead of every movement branch below.
    await this.standBeforeGo();
    const stoppedAfterStand = await stopAfterAwait();
    if (stoppedAfterStand) return stoppedAfterStand;

    // Budget every walk by the ROUTE length, never by a fixed cap. Outdoor rooms here
    // are up to 80x80, so a boundary square can be well over a hundred steps away —
    // and a cap turns a perfectly good exit into a hop that "fails" for no stated
    // reason, which is exactly the silent failure this broker exists to remove.
    // THE BUDGET HAS TO PAY FOR THE WALK, NOT FOR THE PLAN.
    //
    // `steps_away` counts PLANNED squares, and a plan is not what a walk costs here: the
    // mover slides, so the walker lands off its planned square, replans from where it
    // really is, and carries on. Measured offline against the real geometry, an arriving
    // walk costs 0.87-1.04x its plan in the easy rooms and 2.40x in the Badlands, 5.35x in
    // the Western border of the Twisted Wood and 6.58x in the Cragged Mountains — which
    // are precisely the rooms where the fleet dies. `plan + 20` therefore ran out before
    // arrival by construction in the only rooms that needed it, and the walk reported
    // `stopped after 40 steps` about a route that was working.
    //
    // Doubled, with a floor that covers a short approach that goes badly. This is a
    // ceiling on effort, not a promise to spend it: a walk that arrives spends what it
    // needs, and the monster refund and the progress rule above already stop a walk that
    // is going nowhere from reaching this number at all.
    const budget = e => Math.max(60, (e.steps_away ?? 0) * 2 + 20);

    // ---- THE RAIL, TRIED FIRST AND NEVER INSISTED ON. See railAcross / followRail.
    //
    // Only where the ordinary walk is known to struggle: a crossing whose far end is an exit
    // anchor with a baked line to it. Getting ON is an ordinary walk to the entry anchor over
    // ground the coarse grid does express; the crossing itself is then replayed rather than
    // re-planned, which is the difference between arriving and thrashing.
    //
    // Every failure below falls through to exactly the walk this function always did, so a
    // room with no baked route, a stale table, or a rail that cannot be joined costs one
    // attempt and nothing else. `M59_RAIL=0` switches it off for comparison.
    if (process.env.M59_RAIL !== '0' && exit.to != null) {
      // ASKED BY DESTINATION, NOT BY THE SQUARE THIS EXIT HAPPENS TO OFFER.
      //
      // `exit.stand_on` is one crossable square among many on a boundary — 598's west edge
      // alone offers eight. The baked routes are keyed on the ANCHOR, one per declared exit,
      // so looking a rail up by `stand_on` finds nothing and the whole mechanism silently
      // never runs. It did exactly that: zero `baked_rail` rows in the ledger after a full
      // crossing attempt. `anchorFor` is the accessor that cannot express the mistake.
      const railTable = activeRoutes();
      const railRoom = Number(this.world?.room?.num ?? NaN);
      const target = anchorFor(railTable, railRoom, Number(exit.to));
      let rail = target ? this.railAcross({ row: target.row, col: target.col }) : null;
      let railSkipped = false;
      const me0 = this.client?.self;
      // DO NOT RAIL ACROSS A ROOM TO REACH A DOOR THAT IS FOUR SQUARES AWAY.
      //
      // `railAcross` excludes the target anchor from its candidate starts — a line has to
      // begin somewhere else — and then picks the start NEAREST the body. When the body has
      // just arrived beside the door it wants, the nearest remaining anchor is somewhere
      // else entirely, and the rail becomes a tour of the room to reach a square it could
      // have stepped onto.
      //
      // The Western border of the Twisted Wood is the measured case, and it is worse than a
      // detour. A character crossing in from 586 arrives at 41,63 or 44,66 — within a few
      // squares of the 597 door at 46,67. The nearest other anchor is 9,67, which is
      // thirty-five squares north AND IS THE DOORWAY BACK INTO 586. So the walk to get on
      // the rail ends with the character standing on a live exit to the room it just left,
      // and the transit book fills up with
      //
      //   587 -> 597  FAIL  crossed into 586 instead of 597
      //
      // Six of those in one two-character run, against a door it began four squares from.
      //
      // So when the door is already close, there is nothing for a rail to add: the ordinary
      // crossing walk below is a short approach over ground the coarse grid expresses, which
      // is exactly the case it has always been good at. The rail is for crossing a ROOM.
      // HOW FAR IT REALLY IS, WHICH IN THESE ROOMS IS NOT HOW FAR IT LOOKS.
      //
      // Every decision below used `Math.hypot` — the crow line — to judge a walk, in the
      // three rooms whose entire character is that the crow line is a cliff. Measured with
      // the fleet's own step masks:
      //
      //     Ukgoth   13,35 -> the Castle Victoria door   crow 14.4   mover 126
      //     Ukgoth   22,29 -> the same door              crow 21.1   mover 113
      //     535      49,30 -> its east door              crow 28.3   mover  78
      //
      // Up to 8.75x out. So "the door is eight squares away, a rail would be a detour" was
      // being said about a hundred-step climb around a one-way cycle, and the boarding walk
      // was then budgeted for the crow line too and ran out — `could not get on at 49,30
      // (nearest of 13, 6.7 away): stopped after 60 steps`, which is `max(60, 6.7*2+20)`
      // exactly. The rail is the mechanism that crosses this ground and it was being thrown
      // away precisely where it is the only thing that works.
      //
      // `path` is an array index once a step mask is attached, so asking is cheap. Three
      // answers, and they are not the same: a number is the route, `Infinity` is the mover
      // saying there is NO route (never skip the rail for that), and null is a room with no
      // collision model, which must behave exactly as it always did.
      //
      // SWITCHABLE, BECAUSE THE FIRST FLEET-SCALE MEASUREMENT OF IT WENT THE WRONG WAY.
      // `M59_RAIL_MEASURE=crow` restores the old straight-line judgement exactly. The
      // five-inn pilgrimage went 12/21 arrived and 6 dead before this change and 2/21 and
      // 12 dead after it — one run each, and confounded (the second fleet set off battered
      // from the first), which is precisely why the comparison has to be runnable rather
      // than argued. The mechanism to suspect is that both sites here REMOVE A BRAKE: a
      // boarding walk budgeted by a 126-step route will spend 272 packets where it used to
      // give up at 60, and every one of those is a second standing in the room.
      const measure = process.env.M59_RAIL_MEASURE || 'route';
      const routeSteps = (fromRow, fromCol, toRow, toCol) => {
        if (measure === 'crow') return null;            // null == no opinion == the crow line
        const g = this.world?.geometry;
        if (!g || typeof g.path !== 'function') return null;
        try {
          const p = g.path(fromRow, fromCol, toRow, toCol, { collision: true });
          if (!p) return null;
          return p.found ? (p.steps?.length ?? p.path?.length ?? null) : Infinity;
        } catch { return null; }
      };
      if (rail && me0 && target) {
        const crow = Math.hypot(target.col - me0.col, target.row - me0.row);
        const route = routeSteps(me0.row, me0.col, target.row, target.col);
        const away = route ?? crow;
        if (away <= RAIL_SKIP_WITHIN_SQUARES) {
          // A DECISION, NOT A FAILED ATTEMPT — and the ledger has to be able to tell them
          // apart. `worked:false` here counted as "the rail was tried and it did not work",
          // and Ukgoth therefore read as an 84% rail failure with seventy-one of the rows
          // saying the door was already 0 squares away. That is the walk going RIGHT, and
          // an operator reading the ledger to pick what to fix was being sent at it.
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                         tactic: 'baked_rail', trigger: 'exit_crossing',
                         worked: false, attempted: false, ms: 0, hp_lost: 0,
                         // BOTH NUMBERS, ALWAYS. The whole defect was a skip decided on the
                         // crow line, and a ledger that prints one distance cannot show that
                         // it happened. `route` is what decided; `crow` is what used to.
                         note: `no rail needed — the door at ${target.row},${target.col} is ` +
                               `${Math.round(away)} step(s) away ` +
                               `(route ${route ?? 'unknown'}, crow ${crow.toFixed(1)}) ` +
                               `and the line starts at ${rail.from.row},${rail.from.col}` });
          rail = null;
          railSkipped = true;
        } else {
          // AND NEVER WALK FURTHER TO GET ON A LINE THAN TO REACH THE DOOR ITSELF.
          //
          // The candidate starts are ranked by the CROW line (see `railAcross`), in rooms
          // whose entire character is that the crow line is a cliff — the same mistake this
          // block was written to fix for the skip decision, still uncorrected one function
          // away. Adding gutter heads makes it bite: a head is deliberately placed in the
          // worst-served pocket of a room, so it is close to the squares nobody can leave
          // AND close, as the crow flies, to squares on the other side of the wall that are
          // a few steps from the exit.
          //
          // Measured in the Cragged Mountains for the new head at 8,33: of the 29 cheap
          // squares that would rank it their nearest start, r6c24 is 9.2 away by crow and
          // FORTY-SIX steps to walk to, while its own door is thirteen. Boarding there is an
          // eightfold detour to reach a line whose whole purpose is to be quicker.
          //
          // So: compare the two walks that are actually on offer. If getting ON costs more
          // than getting THERE, the rail cannot pay for itself whatever it does afterwards,
          // and this declines it — leaving exactly the ordinary walk that runs today.
          // Twenty-four of those 29 squares are cut by this and every square the gutter was
          // added for is kept, because in a gutter the head is a handful of steps away and
          // the door is fifty: r10c33 boards at 2 against a door 60 away.
          //
          // NOT A COMPARISON OF TOTAL LENGTH. `board + ride` against `route` would decline
          // the corner too — 2 + 63 against 60 — and be wrong, because a rail is not bought
          // for being shorter. It is bought because the ordinary walk SLIDES and replans and
          // does not arrive, which is the premise this whole mechanism rests on.
          const board = rail.from ? routeSteps(me0.row, me0.col, rail.from.row, rail.from.col) : null;
          if (board != null && Number.isFinite(route) && board > route) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: false, attempted: false, ms: 0, hp_lost: 0,
                           note: `rail declined — getting on at ${rail.from.row},${rail.from.col} is ` +
                                 `${board === Infinity ? 'unreachable' : `${board} step(s)`} away and the door at ` +
                                 `${target.row},${target.col} is only ${route}` });
            rail = null;
            railSkipped = true;
          }
        }
      }
      // LOGGED EVEN WHEN NOTHING HAPPENS. The first two attempts at this wrote a ledger row
      // only after the character had got onto the rail, so a run that found no rail at all
      // and a run where `leaveVia` was never reached produced the same evidence — nothing —
      // and there was no way to tell which. The decision is the thing worth recording.
      // ONCE, NOT TWICE. The skip above sets `rail = null`, which then fell into this block
      // and wrote a SECOND row for the same moment — so one deliberate skip appeared in the
      // ledger as two rail failures. That is why 'no rail needed ... 1,66' and 'no baked
      // line to the anchor 1,66' have nearly the same count: they are largely the same
      // events, counted again.
      if (!rail && !railSkipped) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'baked_rail', trigger: 'exit_crossing',
                       worked: false, attempted: false, ms: 0, hp_lost: 0,
                       note: target ? `no baked line to the anchor ${target.row},${target.col}`
                                    : `no anchor for room ${exit.to}` });
      }
      if (rail && me0) {
        // JOIN THE LINE WHERE WE ARE STANDING, NOT WHERE IT STARTS.
        //
        // A crossing gets interrupted — that is the ordinary condition of travel here, and
        // the survival ladder is SUPPOSED to interrupt it. `travelShelterBelow` returns 1
        // (any damage at all) in a zone that outranks the character, which the Twisted Wood
        // does for every character this fleet has, so a scratch takes a wall and the journey
        // resumes a moment later. That is all correct.
        //
        // What was not correct is where it resumed. Getting on always walked back to the
        // ENTRY ANCHOR, so six squares of progress were thrown away every time and the body
        // re-walked the same six. Measured: thirty-two laps of the first six squares of a
        // sixty-five square rail in room 587, six refusals in two hundred and thirty
        // attempts. Nothing was blocked; it was being sent back to the start.
        //
        // If the body is already on or beside a square of this line, that square is where
        // the line is joined. Beside as well as on, because a shelter detour ends a step or
        // two off the road and walking back to the anchor to recover one square is the
        // behaviour this replaces.
        // NEAREST, NOT FURTHEST. A body beside the first two points of a diagonal line is
        // closer to the first; scanning backwards chose the second and then skipped it,
        // turning a one-square join into a two-row jump. Room 578 repeated that jump for
        // eighteen minutes at the foot of its cliff.
        let joinAt = -1, joinDistance = Infinity, exactlyOnJoin = false;
        for (let n = 0; n < rail.squares.length; n++) {
          const sq = rail.squares[n];
          const dr = Math.abs(sq.row - me0.row), dc = Math.abs(sq.col - me0.col);
          if (dr > 1 || dc > 1) continue;
          const distance = Math.hypot(dr, dc);
          if (distance < joinDistance || (distance === joinDistance && n > joinAt)) {
            joinAt = n;
            joinDistance = distance;
            exactlyOnJoin = distance === 0;
          }
        }
        const rejoinAttempted = joinAt >= 0;
        if (rejoinAttempted) {
          // Standing ON a waypoint has already earned it; standing BESIDE one has not. In
          // the latter case it must be the first target, or rejoin skips the very move that
          // puts the body onto the proved line.
          const ahead = rail.squares.slice(joinAt + (exactlyOnJoin ? 1 : 0));
          if (ahead.length) {
            const ran = await this.followRail(ahead, { movementGeneration, controlToken,
                                     avoidSquares: wrongDoor?.size ? wrongDoor : null })
              .catch(e => ({ railed: false, reason: e.message }));
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: !!ran?.railed, ms: 0, hp_lost: 0,
                           note: `rejoined at ${joinAt} of ${rail.squares.length} — ` +
                                 (ran?.railed ? `followed ${ran.walked} of ${ahead.length} remaining`
                                              : `${ran?.cancelled ? 'cancelled' : 'slipped'} at ${ran?.at}` +
                                                (ran?.cancelled_by ? ` by ${ran.cancelled_by}` : '')) });
            const stoppedAfterRailRejoin = await stopAfterAwait();
            if (stoppedAfterRailRejoin) return stoppedAfterRailRejoin;
            if (ran?.left_room)
              return { left: true, via: 'rail', rail: { steps: ran.walked, rejoined: joinAt } };
          }
        }
        // A failed rejoin leaves the body at a newer, real position. Do not use stale
        // pre-rail `me0` to walk back to the entrance and replay the same failed line in
        // this call; the ordinary exit walk below continues from where the body really is.
        if (!rejoinAttempted) {
          // BOARD AT THE NEAREST POINT OF THE LINE, NOT AT ITS BEGINNING.
          //
          // The join above only looks one square out, so a body that is genuinely off the
          // road â€” thrown there by a flee, or walked there by the ordinary exit walk after
          // an earlier rail failure â€” falls through to here and is sent to `rail.from`,
          // which is the ENTRY ANCHOR and therefore about the furthest point of the line
          // from anywhere else in the room.
          //
          // In Ukgoth that is fatal rather than merely wasteful. Measured 2026-08-24 over
          // three characters: 342 moves in the room, 301 of them refused, and 244 of the
          // refusals on 50,23 / 50,24 / 50,25. Those are ordinary walkable squares â€” but
          // their step masks are E, SE, S, SW, W and NOTHING ELSE. There is no northward
          // move from any of them; they are cliff top. The entry anchor is at row 1, so the
          // walk to it asks for north, the room has no north to give, and the body grinds
          // against the cliff until `no_ground_gained` fires or a troll finishes it. The
          // same walk is what `no_ground_gained` was refusing at 3,61 and 5,65.
          //
          // Ukgoth is a CYCLE â€” which is why its fall-jumps had to be declared at all â€” and
          // "walk back to the start" is not a move a cycle supports. So board at the
          // nearest square of the line and follow from there. It may be behind us or ahead
          // of us; both are ground the bake proved, and either is nearer than the anchor.
          // NEAREST IS NOT THE SAME AS REACHABLE, AND IN THIS ROOM IT IS USUALLY NOT.
          //
          // Picking the closest square by straight line asks the crow. Ukgoth is a cycle
          // with one-way cliffs — forward and reverse reachability differ by hundreds of
          // squares — so the nearest point of the line is regularly on the far side of a
          // drop, and `walkTo` cannot get there from here at any price. Nothing noticed,
          // because the next call recomputed the SAME nearest square and tried again.
          // Eleven minutes of it, one character, on one crossing:
          //
          //   17:11:30  could not get on at 38,15 (nearest of 38, 15.6 away)
          //   17:12:39  could not get on at 38,15 (nearest of 38, 15.6 away)
          //   17:13:49  could not get on at 38,15 (nearest of 38, 16.4 away)
          //   ... unchanged until 17:22:15 ...
          //
          // The distance alternating between two values and never falling IS the dithering
          // an operator sees from inside the room: a character shuffling between two
          // squares, fifteen away from a line it will never reach, while a troll eats it.
          //
          // So candidates are tried nearest-first and each is ASKED whether it can be
          // walked to before it is committed to. Bounded, because this runs on the keeper's
          // clock: the ten nearest are enough when the line has 38 squares, and a room that
          // answers "no" ten times has told us what we needed to know.
          //
          // AND A SQUARE THAT FAILED IS NOT OFFERED AGAIN. Reachability says whether a path
          // exists; it does not say whether the walk survives contact with whatever is
          // standing on it. Remembering the failures is what turns a loop into a search —
          // per room, and cleared when the room changes, because this is a fact about one
          // crossing rather than about the map.
          const boardKey = Number(this.world?.room?.num ?? 0);
          if (this._railBoardFailed?.room !== boardKey)
            this._railBoardFailed = { room: boardKey, squares: new Set() };
          const tried = this._railBoardFailed.squares;
          const geoNow = this.world?.geometry;
          // AND KEEP WHAT THE PROBE ALREADY WORKED OUT. This asks the mover for a PATH and
          // then threw everything but its boolean away, so the budget below was taken from
          // the crow line — which is how boarding a square "6.7 away" died `stopped after 60
          // steps` against a 78-step route. The length is free here and it is exactly the
          // number the walk is about to be judged by.
          //
          // Three answers again, and the middle one is the one that matters: a number is the
          // route, `false` is the mover saying there is no way there at all, and null is a
          // room with no collision model — which keeps the old "no opinion: carry on".
          let boardRoute = null;
          const walkCost = (sq) => {
            if (!geoNow || typeof geoNow.path !== 'function') return null;  // no opinion: carry on
            try {
              const p = geoNow.path(me0.row, me0.col, sq.row, sq.col);
              if (!p?.found) return false;
              // Under `M59_RAIL_MEASURE=crow` the reachability answer is still used — it is
              // what stops a body being sent at a square across a one-way drop — but the
              // LENGTH is withheld, so the budget below falls back to the crow line exactly
              // as it did before. That is what makes the A/B a clean one-variable change.
              return measure === 'crow' ? null : (p.steps?.length ?? p.path?.length ?? null);
            } catch { return null; }
          };
          const ranked = rail.squares
            .map((sq, n) => ({ sq, n, d: Math.hypot(sq.row - me0.row, sq.col - me0.col) }))
            .sort((a, b) => a.d - b.d);
          let boardAt = -1, boardDistance = Infinity, probed = 0;
          for (const cand of ranked) {
            if (tried.has(`${cand.sq.row},${cand.sq.col}`)) continue;
            if (probed++ >= 10) break;
            const cost = walkCost(cand.sq);
            if (cost === false) continue;               // the mover says there is no way there
            boardAt = cand.n; boardDistance = cand.d; boardRoute = cost; break;
          }
          // Everything near is unreachable or already failed. Fall back to the old answer
          // rather than refusing the crossing — the ordinary exit walk below is still there,
          // and one more honest attempt beats a silent skip.
          if (boardAt < 0) {
            const first = ranked.find(c => !tried.has(`${c.sq.row},${c.sq.col}`)) ?? ranked[0];
            boardAt = first.n; boardDistance = first.d;
          }
          const board = rail.squares[boardAt] ?? rail.from;
          const onIt = me0.col === board.col && me0.row === board.row;
          // 1. GET ON â€” skipped when we are already standing on the boarding square.
          // BUDGETED BY THE ROUTE THE MOVER WILL WALK, not by the line the crow would fly.
          const boardCrow = Math.hypot(board.col - me0.col, board.row - me0.row);
          const boardAway = Number.isFinite(boardRoute) ? boardRoute : boardCrow;
          const got = onIt ? { arrived: true } : await this.walkTo(board.col, board.row,
            { maxSteps: budget({ steps_away: boardAway }) })
            .catch(e => ({ arrived: false, reason: e.message }));
          const stoppedAfterRailBoard = await stopAfterAwait();
          if (stoppedAfterRailBoard) return stoppedAfterRailBoard;
          if (got?.left_room)
            return { left: true, via: 'rail', rail: { boarded: boardAt } };
          if (!got?.arrived) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing', worked: false, ms: 0, hp_lost: 0,
                           // A NET, SO NO BOARDING FAILURE CAN BE SILENT AGAIN. `walkTo`
                           // returns down several paths and not all of them carry a
                           // `reason`; 64 of 183 failures in Ukgoth were recorded as `?`
                           // and were indistinguishable from each other. Whatever is
                           // present gets written â€” where it stopped, how far it got,
                           // whether it left the room â€” because a third of the evidence
                           // arriving as one character is how this stayed unexplained.
                           note: `could not get on at ${board.row},${board.col}` +
                                 ` (nearest of ${rail.squares.length}, ${boardDistance.toFixed(1)} away,` +
                                 ` route ${boardRoute ?? 'unknown'}, budget ${budget({ steps_away: boardAway })}): ` +
                                 (got?.reason
                                  ?? (got?.left_room ? 'left the room while walking to the rail'
                                      : got?.note ? String(got.note).slice(0, 60)
                                      : `no reason given (steps ${got?.steps ?? 0}` +
                                        `${got?.blocked_at ? `, blocked at ${got.blocked_at.row},${got.blocked_at.col}` : ''}` +
                                        `${got?.replans != null ? `, replans ${got.replans}` : ''})`)) });
            // Do not offer this square again for this room. See the note above the ranking.
            this._railBoardFailed.squares.add(`${board.row},${board.col}`);
          }
          if (got?.arrived) {
            // 2. FOLLOW â€” from where we joined, not from the anchor.
            const ahead = rail.squares.slice(boardAt);
            const ran = await this.followRail(ahead, { movementGeneration, controlToken,
                                        avoidSquares: wrongDoor?.size ? wrongDoor : null })
              .catch(e => ({ railed: false, reason: e.message }));
            const stoppedAfterRail = await stopAfterAwait();
            if (stoppedAfterRail) return stoppedAfterRail;
            if (ran?.left_room)
              return { left: true, via: 'rail', rail: { steps: ran.walked, boarded: boardAt } };
            // 3. COME OFF â€” at the far anchor, so the ordinary crossing below is a step, not
            //    a room-crossing. A rail that slipped leaves the body somewhere real and the
            //    walk below simply carries on from there.
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: !!ran?.railed, ms: 0, hp_lost: 0,
                           note: ran?.railed ? `boarded at ${boardAt} of ${rail.squares.length}, followed ${ran.walked} of ${ahead.length}, skipped ${ran.skipped ?? 0}`
                                             : ran?.cancelled
                                               ? `cancelled at ${ran?.at} of ${ahead.length} by ` +
                                                 `${ran?.cancelled_by} (${ran?.cancelled_ms_ago}ms ago)`
                                               : `slipped at ${ran?.at} of ${ahead.length}: ${ran?.reason ?? 'unknown'}` });
          }
        }
      }
    }

    const stoppedAfterRailAttempt = await stopAfterAwait();
    if (stoppedAfterRailAttempt) return stoppedAfterRailAttempt;
    if (exit.kind === 'go') {
      // CLEARANCE ON, because this is the long routing: crossing a whole room to a
      // boundary square is exactly where hugging the wall makes a step slide, the mover
      // land off plan, and the walker start the bounce. See walkTo's `clearance`.
      let walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                   { maxSteps: budget(exit), movementGeneration, controlToken,
                                     clearance: LEAVE_VIA_CLEARANCE });
      const stoppedAfterWalk = await stopAfterAwait();
      if (stoppedAfterWalk) return stoppedAfterWalk;
      if (walk?.left_room)
        return { left: true, note: 'the room changed while approaching the doorway' };
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };

      // COARSE "UNREACHABLE" IS NOT THE SAME AS IMPOSSIBLE.
      //
      // The movement grid is one byte per square; the world underneath it is BSP
      // geometry at 64 fine units to the square. Anything narrower than a square —
      // a ledge, a gap between pillars, the diagonal slot through a crypt — exists
      // in the geometry and simply cannot be represented in the grid, so the
      // pathfinder reports no route to somewhere you can plainly walk.
      //
      // Six characters sat in the Marion crypt for half an hour because of this.
      // The grid said the way back was unreachable; stepping there in fine units
      // worked first time. So when coarse pathing fails, try fine before believing
      // it — the cost is one more attempt and the alternative is a permanent trap.
      if (!walk.arrived) {
        // walkFine works in fine units, not squares — the centre of a square is
        // col*64 + 32. Passing square coordinates walks to the top-left corner of
        // the map instead, which looks like a wildly broken pathfinder.
        const half = KOD_FINENESS >> 1;
        // THE FINE WALK GETS THE SAME AVOID SET AS THE COARSE ONE. It is the mover that
        // actually reaches a boundary, and it was dragging along the wall into the wrong door.
        const fine = await this.walkFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half,
                                         { maxSteps: budget(exit), movementGeneration, controlToken,
                                           avoidSquares: wrongDoor?.size ? wrongDoor : null }).catch(() => null);
        const stoppedAfterFineApproach = await stopAfterAwait();
        if (stoppedAfterFineApproach) return stoppedAfterFineApproach;
        if (fine?.left_room)
          return { left: true, note: 'the room changed during the fine doorway approach' };
        if (isTerminalMovementReason(fine?.reason))
          return { left: false, stage: 'walk', ...fine };
        if (fine?.arrived) walk = { ...fine, via: 'fine movement after coarse pathing failed' };
      }
      let leaned = false;

      // A DOORWAY IS USUALLY NOT WALKABLE IN THE ROOM'S OWN GRID.
      //
      // The square Room.SomethingTryGo matches on is frequently drawn as wall, and
      // the direction bits of the square beside it do not open onto it — so the
      // pathfinder correctly reports "no route" to a square that is nonetheless
      // the only way out. The Royal Bank of Jasper is the clean example: its exit
      // sits at (9,6) in a column the grid seals off completely, and an agent that
      // trusts the route planner is simply stuck in the bank forever.
      //
      // The server does not require you to STAND on it. Movement is in fine units
      // — 64 to the square — and the real client clips a requested point to the
      // closest legal position. Do that collision pass locally, which can slide us
      // hard up against the doorway without ever sending an endpoint through it.
      if (!walk.arrived) {
        let spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
        // WHERE WE ARE STANDING CAN BE THE WHOLE PROBLEM.
        //
        // approachSquare answers from the square we occupy, and some squares simply have
        // no path to the doorway even though the room does. Cibilo Creek Inn is the case:
        // a character at (2,3) has every direction in can_step except the one the exit is
        // in, and both walk_to and go_through fail on it — while a character at (5,5) in
        // the same room walks out on the first try. Four characters sat in two taverns on
        // squares like that, reporting the room unleavable, and it was only ever the spot.
        //
        // So before giving up, step somewhere else and ask again. Anywhere reachable will
        // do; the middle of the room is the likeliest to see the door.
        if (!spot) {
          const rows = this.world?.room?.size?.rows ?? 0, cols = this.world?.room?.size?.cols ?? 0;
          for (const [c2, r2] of [[Math.floor(cols / 2), Math.floor(rows / 2)],
                                  [Math.floor(cols / 3), Math.floor(rows / 2)],
                                  [Math.floor(cols / 2), Math.floor(rows / 3)]]) {
            if (!(c2 > 0 && r2 > 0)) continue;
            // KEEP OFF THE WALLS HERE TOO. This is a CROSSING — a third of the way across
            // the room, to a point nobody chose tactically — which is precisely the case
            // `clearance` is for, and it was the one long walk in `leaveVia` that did not
            // ask for it. It runs only after the direct walk to the exit has already
            // failed, so it is the route a character takes WHILE it is milling: planning
            // it flat threads the recovery along the same walls that caused the failure.
            const step = await this.walkTo(c2, r2, { maxSteps: 30, movementGeneration, controlToken,
                                                     clearance: LEAVE_VIA_CLEARANCE })
                                   .catch(() => ({ arrived: false }));
            const stoppedAfterRecoveryStep = await stopAfterAwait();
            if (stoppedAfterRecoveryStep) return stoppedAfterRecoveryStep;
            if (step?.left_room)
              return { left: true, note: 'the room changed during doorway recovery' };
            if (isTerminalMovementReason(step.reason))
              return { left: false, stage: 'walk', ...step };
            if (!step.arrived) continue;
            spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
            if (spot) break;
          }
        }
        if (!spot) return { left: false, stage: 'walk', ...walk,
                            note: 'no path to the doorway from here, and moving elsewhere in the ' +
                                  'room did not find one either' };
        if (spot.steps > 0) {
          // Same again: the SQUARE was chosen tactically, the WALK to it is a crossing.
          // `clearance` prices the route and exempts the destination, so asking for it
          // here keeps the approach off the walls without shying away from the doorway
          // itself — which is the distinction the whole setting turns on.
          const near = await this.walkTo(spot.col, spot.row,
                                         { maxSteps: Math.max(40, spot.steps + 20), movementGeneration, controlToken,
                                           clearance: LEAVE_VIA_CLEARANCE });
          const stoppedAfterNearWalk = await stopAfterAwait();
          if (stoppedAfterNearWalk) return stoppedAfterNearWalk;
          if (near?.left_room)
            return { left: true, note: 'the room changed during doorway recovery' };
          if (!near.arrived) return { left: false, stage: 'walk', ...near };
        }
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        const stoppedAfterLean = await stopAfterAwait();
        if (stoppedAfterLean) return stoppedAfterLean;
        if (lean?.left_room)
          return { left: true, note: 'the room changed while leaning into the doorway' };
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
      }

      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      // Where the server thinks we are, before asking it to let us out. If prediction
      // drifted, lean again from the position we are ACTUALLY on — the first lean was
      // aimed from a square we may never have reached.
      let at = await this.confirmPosition();
      const stoppedAfterConfirm = await stopAfterAwait();
      if (stoppedAfterConfirm) return stoppedAfterConfirm;
      if (!at) {
        this.finePositionUnknown = true;
        return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                 note: 'the server position could not be confirmed, so no doorway correction or go was sent' };
      }
      if (at && (Math.abs(at.col - exit.stand_on.col) > 1 || Math.abs(at.row - exit.stand_on.row) > 1)) {
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        const stoppedAfterCorrectionLean = await stopAfterAwait();
        if (stoppedAfterCorrectionLean) return stoppedAfterCorrectionLean;
        if (lean?.left_room)
          return { left: true, note: 'the room changed while correcting the doorway approach' };
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
        at = await this.confirmPosition();
        const stoppedAfterCorrectionConfirm = await stopAfterAwait();
        if (stoppedAfterCorrectionConfirm) return stoppedAfterCorrectionConfirm;
        if (!at) {
          this.finePositionUnknown = true;
          return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                   note: 'the corrected doorway position could not be confirmed, so go was not sent' };
        }
      }

      // THE LAST SQUARE IS THE ONE THE GRID CANNOT SEE, AND IT IS THE ONLY ONE THAT
      // COUNTS. `UserGo` passes the server's own piRow/piCol and `SomethingTryGo`
      // (room.kod:2777) matches them against plExits with `=`. Not a radius, not a
      // facing cone — that exact square or nothing.
      //
      // And the way IN is not the way OUT. Measured in the Brownestone Inn with the
      // operator standing in it: the door from North Barloque delivers you to (12,16),
      // the door back out is at (12,17), and row 17 is walkable floor that the coarse
      // grid marks unreachable from every square touching it. So a character walks in,
      // lands one square short of the way home, and the router refuses to try before
      // sending a single packet. Camilla sat there failing 29 crossings in five minutes.
      //
      // Fine movement can cross its legal low step even though the square grid cannot
      // represent it, because it checks the fine BSP instead. So when the
      // square-based approach has left us anywhere but the exit square, fall through to
      // it rather than issuing a `go` that cannot possibly be accepted.
      // AN UNKNOWN POSITION IS NOT A CORRECT ONE. `at` is null when the confirming read
      // timed out, and both corrections below were guarded on `at` being truthy — so a
      // failed read skipped them BOTH and sent `go` blind, then reported the result as
      // "stood on the exit square and nothing happened", which is a claim we had no
      // evidence for. Treat unknown like wrong: request the square in fine units and
      // let the local collision pass cross or clip it before anything is sent.
      if (at.col !== exit.stand_on.col || at.row !== exit.stand_on.row) {
        const half = KOD_FINENESS >> 1;
        const correction = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                                exit.stand_on.row * KOD_FINENESS + half)
                                     .catch(error => ({ moved: false, reason: error.message }));
        const stoppedAfterDoorCorrection = await stopAfterAwait();
        if (stoppedAfterDoorCorrection) return stoppedAfterDoorCorrection;
        if (correction?.left_room)
          return { left: true, note: 'the room changed on the doorway correction step' };
        if (isTerminalMovementReason(correction.reason))
          return { left: false, stage: 'walk', reason: correction.reason, note: correction.note };
        const corrected = correction.position;
        if (!corrected || corrected.col !== exit.stand_on.col || corrected.row !== exit.stand_on.row)
          return { left: false, stage: 'walk', reason: correction.reason ?? 'geometry_blocked',
                   note: correction.note ?? 'local collision could not place the character on the exact exit square' };
        leaned = true;
      }
      // Wait for the ROOM CHANGE specifically. A door announces itself first —
      // "You open the door and walk through." arrives as a message a beat before
      // BP_PLAYER reports the new room — and waitFor returns on the first match of
      // ANY listed kind. Listening for 'message' too therefore returned the
      // announcement of success and called it a failure, every single time.
      const go = await boundedSilentGo({
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        stillCurrent: () => !leftExpectedRoom(),
        // The pacer may wait before invoking its callback. Re-check at emission time too,
        // otherwise a room handoff during that wait sends `go` inside the destination room.
        // STAND UP FIRST. `Player.ResetFlags` (player.kod:1162) sets PFLAG_NO_MOVE the
        // moment IsResting is true, and `UserGo` (user.kod:5657) refuses on that flag with
        // "You are unable to go anywhere." — 589 of 700 failed hops when it was measured.
        //
        // This was fixed once, in d263bf0, with three calls: this one, `askGo` below, and
        // the broker's `act verb=go`. `leaveVia` then moved from m59-broker.mjs to this
        // file with the keeper-process split and BOTH of its calls were dropped in the
        // move. The method survived; its callers did not, and nothing noticed because a
        // seated character's refusal is identical to a door that does not work.
        //
        // Per ATTEMPT, not once per crossing: the character can sit back down between
        // tries, and a redundant stand costs one packet against a whole lost journey.
        send: async () => {
          await this.standBeforeGo();
          return this.pacer.submit('move', () =>
            (this.movementWasCancelled(movementGeneration, controlToken) || leftExpectedRoom())
              ? false : c.go(), DOOR_SETTLE_MS);
        },
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
      });
      const stoppedAfterGo = await stopAfterAwait();
      if (stoppedAfterGo)
        return { ...stoppedAfterGo, go_attempts: go.attempts };
      if (go.cancelled)
        return this.cancelledMovement({ go_attempts: go.attempts,
                                        crossing_packet_sent: go.attempts > 0 });
      if (go.unconfirmed_transition) return staleExit();
      const entered = go.entered, messages = go.messages, goAttempts = go.attempts;
      // SAY WHETHER A PACKET ACTUALLY WENT OUT. `boundedSilentGo` counts its `send()`
      // calls, so this is knowable and was simply never reported: the field was set only
      // on the edge path, and every go-door refusal came back `crossing_packet_sent: null`
      // — which reads as "we never tried" and is the opposite of the truth when the server
      // has answered `user_cant_go`. An operator lost an hour to that reading.
      return { left: !!entered, arrived_in: entered ? entered.roomName : null,
               go_attempts: goAttempts,
               crossing_packet_sent: goAttempts > 0,
               ...(leaned && entered
                   ? { note: 'the exit square is not walkable in this room\'s grid, so this ' +
                             'leaned into the doorway from the square beside it' } : {}),
               ...(entered ? {} : {
                 reason: messages.length ? messages.join('; ')
                       : leaned ? `leaned into (${exit.stand_on.col},${exit.stand_on.row}) from beside ` +
                                  `it and the server did not open a door there after ${goAttempts} attempts`
                       : `sent go ${goAttempts} time${goAttempts === 1 ? '' : 's'} and the server ` +
                         'answered nothing at all — no room change and no refusal' }),
               messages };
    }

    if (exit.kind === 'edge') {
      // Graph hops carry the abstract edge; the live world attaches an exact
      // BSP-validated inside point, the minimum out-of-bounds target, and (when
      // needed) a short fine route from a coarse staging square.
      if (!exit.fine_stand_on || !exit.edge_target) {
        const enriched = this.world.exits().find(candidate => candidate.kind === 'edge'
          && candidate.to === exit.to && candidate.direction === exit.direction);
        if (enriched) exit = { ...exit, ...enriched };
      }
      if (!exit.stand_on || !exit.fine_stand_on || !exit.edge_target)
        return { left: false, stage: 'walk',
                 reason: `no BSP-valid crossing on the ${exit.direction} boundary` };
      const edgeStartRoom = c.room.id;
      // No reachable boundary square, says the square grid — the same verdict it
      // gives for a cliff ledge, and wrong for the same reason. Pick the nearest
      // floor square actually on that boundary and walk to it with fine BSP collision.
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: LEAVE_VIA_CLEARANCE,
                                       avoidSquares: wrongDoor?.size ? wrongDoor : null });
      const stoppedAfterEdgeWalk = await stopAfterAwait();
      if (stoppedAfterEdgeWalk) return stoppedAfterEdgeWalk;
      if (walk.left_room)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed while approaching the boundary' };
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };
      // ARRIVING ON *A* CROSSING SQUARE IS ARRIVING. THE EXACT ONE DOES NOT MATTER.
      //
      // This used to demand the walk finish on the one anchor `exits()` picked, and give
      // up otherwise — without ever attempting the crossing. That produced the dance an
      // operator watched and described exactly: a character walks to one opening, does
      // not cross, walks all the way across the room to the other opening, does not
      // cross, and comes back. `travel` re-plans after each refusal and picks a different
      // candidate, so the two openings alternate for ever.
      //
      // It is also unnecessary, and `exits()` says so twenty lines away: "the boundary is
      // one exit and any square on it crosses". Measured on the west wall of Main gate to
      // the city of Tos, which has two separate openings at rows 20-23 and 43-48: a
      // character teleported onto 20,1 and onto 47,1 crossed in ZERO seconds from both.
      // The crossing was never the problem — landing on one exact square was.
      //
      // So when the walk ends somewhere else, look for where we ACTUALLY are among this
      // boundary's crossing squares and use that one's own fine target. Only if we are on
      // none of them is the walk a failure.
      if (!walk.arrived) {
        const me = c.self;
        const crossings = [{ col: exit.stand_on.col, row: exit.stand_on.row,
                             fine_stand_on: exit.fine_stand_on, edge_target: exit.edge_target,
                             fine_path: exit.fine_path },
                           ...(exit.alternates ?? [])];
        const here = me && crossings.find(a => a.col === me.col && a.row === me.row
                                            && a.fine_stand_on && a.edge_target);
        if (!here) return { left: false, stage: 'walk', ...walk };
        exit = { ...exit, stand_on: { col: here.col, row: here.row },
                 fine_stand_on: here.fine_stand_on, edge_target: here.edge_target,
                 fine_path: here.fine_path,
                 crossed_from_alternate: true };
      }
      // THE OPENING THE BODY IS STANDING IN, NOT THE ONE THE PLAN NAMED.
      //
      // `atEdgeOpening` permits one square of drift ALONG the boundary, measured from the
      // single opening `exits()` ranked first — and a boundary publishes many. Ukgoth's
      // north edge offers x=1736 and x=1773 inside column 27 alone, and which one is
      // chosen is decided by a one-step difference in the approach walk. Measured from the
      // valley, the ranking picks 1736, which sits EIGHT fine units from the solid rock of
      // square 26 and therefore admits a body only from square 27 exactly:
      //
      //     standing on 1,27  x=1760   |1760-1736| =  24   within one square
      //     standing on 1,28  x=1824   |1824-1736| =  88   REFUSED
      //
      // So a character that climbs the whole cliff and arrives on 1,28 — on the boundary
      // row, in the doorway, one column east of the anchor — is told `not_at_edge_opening`
      // and the outward packet is never sent at all. `leaveViaAny` then walks it across the
      // room to the next candidate and the lap repeats: the exit-gap ledger reads 182
      // refusals and ZERO crossings on this boundary, while a body teleported onto 1,27
      // crosses in three seconds.
      //
      // The plan-time choice is a guess about where the body will end up, and the body has
      // now stopped somewhere. So re-ask: of the crossings this boundary publishes for THIS
      // exit, which is nearest along the edge to where we are actually standing. The
      // `edge_target` moves with it, because the outward packet has to leave from the
      // opening we are in rather than aim diagonally across a wall at another one.
      //
      // This can only ever reduce the distance the gate measures — a strictly-nearer test,
      // and no change at all when the ranked opening already is the nearest. `wrongDoor` is
      // the same set the approach walk avoids, so a split boundary cannot be re-anchored
      // onto a crossing that fires the other room.
      const reanchorToNearestOpening = () => {
        const me = c.self;
        if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.y)) return;
        let published = null;
        try { published = this.world?.geometry?.edgeApproachCandidates?.(exit.direction) ?? null; }
        catch { published = null; }
        if (!Array.isArray(published) || !published.length) return;
        const horizontal = exit.direction === 'north' || exit.direction === 'south';
        const along = pt => (horizontal ? pt.x : pt.y);
        let best = null, bestGap = Math.abs(along(exit.fine_stand_on) - along(me));
        for (const cand of published) {
          if (!cand?.fine_stand_on || !cand?.edge_target) continue;
          const row = Math.floor(cand.fine_stand_on.y / KOD_FINENESS);
          const col = Math.floor(cand.fine_stand_on.x / KOD_FINENESS);
          if (wrongDoor?.has?.(`${row},${col}`)) continue;      // fires the other exit
          const gap = Math.abs(along(cand.fine_stand_on) - along(me));
          if (gap < bestGap) { bestGap = gap; best = cand; }
        }
        if (!best) return;
        exit = { ...exit, fine_stand_on: best.fine_stand_on, edge_target: best.edge_target,
                 fine_path: [best.fine_stand_on], reanchored_to_nearest_opening: true };
      };
      reanchorToNearestOpening();

      const finePath = exit.fine_path?.length ? exit.fine_path : [exit.fine_stand_on];
      // ALREADY IN THE DOORWAY SQUARE? THEN DO NOT WIGGLE AT ALL — STEP OUT.
      //
      // The note below already argues the precision is not load-bearing: the crossing is
      // triggered by the OUTWARD step, not by where you stood, and two characters teleported
      // onto different openings crossed in zero seconds from both. If that is true — and it
      // is — then a character that has ALREADY been walked into the exit square has nothing
      // left to gain here, and something real to lose.
      //
      // What it loses is the character. Ukgoth's Castle Victoria doorway sits on a finger of
      // cliff top three squares wide at row 1 and narrowing to two by row 4, with a drop on
      // every other side. `walkFine` fans NINE headings and slides, and the floors on that
      // finger differ by exactly 384 in places — MAX_STEP_HEIGHT — so each slid step down is
      // individually legal while the sequence of them walks off the edge. The operator
      // watched a production character make the jump, cross the whole room, reach the door,
      // wiggle, and put itself off the cliff.
      //
      // AND A CHARACTER ONE SQUARE SHORT WALKS FORWARD, IT DOES NOT FAN.
      //
      // The operator's account of how these exits work is the whole design note: "the player
      // knows just keep going forward into the narrowing spur, because that's how these
      // exits work". A boundary crossing is a WALK OFF THE EDGE, so the move that gets you
      // there is a step in the direction of the edge — not a nine-heading search for a point
      // inside the doorway square.
      //
      // So the skip widens by a square, and it widens by STEPPING rather than by ignoring
      // the gap. `step` is the mover's own square primitive: one validated move, no fan, no
      // slide-until-something-sticks. If it lands us in the opening the nudge has nothing
      // left to do; if it does not, the fine path is still there and behaves exactly as it
      // did. What is removed is the case that killed characters — being one square off a
      // two-wide spur and searching for the doorway by feel.
      // AND THE DOORWAY IS THE CROSSING SQUARE, NEVER THE STAGING SQUARE.
      //
      // `stand_on` is where the room can be WALKED TO; `fine_stand_on` is where the boundary
      // can be CROSSED, and on a boundary approached from inland they are different squares.
      // Ukgoth's north exit stages on row 2 and crosses on row 1 — so arriving at `stand_on`
      // set `atDoor`, which skips the fine nudge below, which was the only thing left that
      // would have moved the body onto the crossing row. The gate then measured the body
      // against an opening one row in front of it and refused, having spent the entire
      // approach getting there. Every mechanism agreed the walk had succeeded and no packet
      // was ever sent.
      //
      // So both the test and the step aim at the square the crossing is actually in. That
      // also makes the step-in do what its own note says it should — "keep going forward
      // into the narrowing spur" is a step toward the EDGE, and the staging square is the
      // one place on the approach that is not toward the edge.
      const doorSquare = {
        col: Math.floor(exit.fine_stand_on.x / KOD_FINENESS),
        row: Math.floor(exit.fine_stand_on.y / KOD_FINENESS),
      };
      let atDoor = (() => {
        const me = c.self;
        return !!(me && me.col === doorSquare.col && me.row === doorSquare.row);
      })();
      if (!atDoor) {
        const me = c.self;
        const away = me ? Math.max(Math.abs(me.row - doorSquare.row),
                                   Math.abs(me.col - doorSquare.col)) : Infinity;
        if (away <= EDGE_STEP_IN_WITHIN) {
          for (let n = 0; n < EDGE_STEP_IN_WITHIN && !atDoor; n++) {
            const r = await this.step(doorSquare.col, doorSquare.row,
                                      { movementGeneration, controlToken })
              .catch(() => null);
            const stoppedAfterEdgeStep = await stopAfterAwait();
            if (stoppedAfterEdgeStep) return stoppedAfterEdgeStep;
            if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
            if (r?.left_room || c.room.id !== edgeStartRoom)
              return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                       note: 'stepped straight out of the room while closing on the opening' };
            const now = c.self;
            atDoor = !!(now && now.col === doorSquare.col && now.row === doorSquare.row);
            if (!r?.moved) break;                 // refused: let the fine path try instead
          }
        }
      }
      for (const point of (atDoor ? [] : finePath)) {
        // A SHORT NUDGE, NOT A SEARCH — AND THIS IS THE WIGGLE AT THE DOOR.
        //
        // `arriveWithin: 1` asks to land within ONE fine unit, a 64th of a square, and
        // `walkFine` pursues that by fanning nine headings and re-stepping until its
        // budget runs out. On a boundary square that budget was the whole ROUTE length —
        // forty-plus packets — so a character that was already standing at the opening
        // spent half a minute shuffling a few units back and forth in front of the exit
        // before the outward step it actually needed. Watched from the client that is
        // exactly what it looks like: stopping in front of the door and wiggling.
        //
        // The precision was never load-bearing, and the comment below already says so:
        // the crossing is triggered by the OUTWARD step, not by where you stood, and two
        // characters teleported onto different openings crossed in zero seconds from
        // both. Nor can loosening it change WHICH exit fires — an edge condition is on
        // the row/col, and every point here is inside the same square we already walked
        // to, so this only moves us within that one square.
        //
        // So: land near the opening if a few steps get us there, and otherwise press. A
        // miss still falls through to the edge step exactly as before, which is the half
        // that does the work.
        const fine = await this.walkFine(point.x, point.y, {
          maxSteps: EDGE_NUDGE_MAX_STEPS, stride: 32, arriveWithin: EDGE_NUDGE_WITHIN,
          movementGeneration, controlToken,
          // The nudge stays inside the square we already walked to, so this can only ever
          // refuse a fine point that is already over the wrong door.
          avoidSquares: wrongDoor?.size ? wrongDoor : null,
        });
        const stoppedAfterEdgeNudge = await stopAfterAwait();
        if (stoppedAfterEdgeNudge) return stoppedAfterEdgeNudge;
        if (fine.left_room)
          return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                   note: 'crossed the boundary while fine-positioning at its opening' };
        if (isTerminalMovementReason(fine.reason))
          return { left: false, stage: 'walk', ...fine };
        // NOT ARRIVING EXACTLY IS NOT YET A REASON TO GIVE UP.
        //
        // `arriveWithin: 1` above asks to land within ONE fine unit — a 64th of a square
        // — and returning here when it does not is the machinery refusing to press into
        // the wall. The operator's rule, and it is simply how the game works: for every
        // exit that is not a door or a portal, leaving ALWAYS requires one more step
        // toward the edge, and that edge is an invisible wall you run into. There is no
        // version of it where precision at the opening matters, because the thing that
        // triggers `Room.StandardLeaveDir` is the outward step, not where you stood.
        //
        // Proved by teleport: a character placed on 20,1 and on 47,1 of Main gate to the
        // city of Tos — different openings, neither the blessed anchor — both crossed in
        // ZERO seconds. What has been failing is never the crossing; it is everything
        // this function does before allowing itself to attempt one.
        //
        // A fine-positioning miss falls through to the boundary-position gate below. The
        // server does not validate player geometry, so the outward packet cannot be used
        // as the test: sent from inside the room it can cross the intervening wall.
        if (!fine.arrived) break;
      }
      // Dead reckoning is appropriate across a room and insufficient at the one packet the
      // server will accept without any geometry check. Refresh the server's position before
      // authorizing the edge; the paced callback below still re-proves whatever live position
      // exists at the exact instant of send.
      const confirmedEdge = await this.confirmPosition().catch(() => null);
      const stoppedAfterEdgeConfirm = await stopAfterAwait();
      if (stoppedAfterEdgeConfirm) return stoppedAfterEdgeConfirm;
      if (!confirmedEdge) {
        this.finePositionUnknown = true;
        return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                 note: 'the edge position could not be confirmed, so no outward packet was sent' };
      }
      // AND ASK ONE LAST TIME WHICH OPENING WE ARE IN, now that the position is the
      // server's rather than dead reckoning. The step-in and the nudge both move the body,
      // and `confirmPosition` is the first moment this function knows where it really is —
      // which is exactly the moment to decide which opening it is standing in. Re-anchoring
      // is strictly-nearer, so this can only shrink the distance the gate is about to
      // measure; where the ranked opening was already the nearest it changes nothing.
      reanchorToNearestOpening();

      // THE OUTWARD PACKET IS AUTHORIZED ONLY FROM THE PROVED OPENING.
      //
      // `offMap` selects the separately-authorized boundary branch; it does not bypass
      // collision. A bot in room 536 failed every fine nudge toward the north opening,
      // remained on row 2 at (1125,178), and was nevertheless allowed to send the target
      // (1120,63). The server accepted it and moved the bot to room 535 through geometry
      // the client had just refused. The server is not a collision oracle, so the queue
      // rechecks this proximity and replays the exact packet through BSP at send time.
      //
      // Permit the ordinary sub-square wiggle along an opening, but require the body to
      // be on its boundary row/column and within one fine square of this exact candidate.
      // Along-edge coarse squares may legitimately differ at a square boundary, so do not
      // require both coarse coordinates to equal the candidate's.
      const opening = exit.fine_stand_on;
      const meAtEdge = c.self;
      if (!atEdgeOpening(meAtEdge, opening, exit.direction))
        return { left: false, stage: 'walk', reason: 'not_at_edge_opening',
                 note: 'the outward edge packet was refused because the character did not reach ' +
                       'the BSP-proved boundary opening' };
      // One more step OUTWARD, past the grid. Nothing else triggers
      // Room.StandardLeaveDir. `offMap` keeps this transition out of the in-room breadcrumb
      // chain while the queue still requires the baked outside coordinate to validate.
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      const edgeMove = await this.queueValidatedMove(
        exit.edge_target.x, exit.edge_target.y,
        // Stock UserMovePlayer sends speed zero for the one StandardLeaveDir
        // out-of-room request; it is not a run/vigor-bearing in-room step.
        { speed: 0, slide: false, minGap: MOVE_INTERVAL_MS,
          expectedRoomId: edgeStartRoom,
          offMap: { opening: exit.fine_stand_on, direction: exit.direction } });
      const stoppedAfterEdgePacket = await stopAfterAwait();
      if (stoppedAfterEdgePacket) return stoppedAfterEdgePacket;
      if (!edgeMove.sent) return {
        left: false, stage: 'edge',
        crossing_packet_sent: false,
        reason: edgeMove.validation?.reason ?? 'geometry_blocked',
        note: edgeMove.validation?.note ??
          'the outward edge packet could not be sent at all — not a collision refusal',
      };
      const tGo = Date.now();
      // THE CROSSING IS SLOW WHEN THE SERVER IS BUSY, AND IT STILL WORKS.
      //
      // The operator's description of playing this by hand: you stop dead against the
      // invisible wall, and a beat later it jumps you to the next map. So a late
      // `room-entered` is the ORDINARY case under load, not a failure — and at 4s we
      // were giving up on crossings that were still in flight and recording them as
      // "stepping past the edge did nothing", which is the one reading that makes a
      // working exit look like a phantom.
      const ev = await c.waitFor({ since: edgeMove.eventSeq, kinds: ['room-entered'],
                                   timeoutMs: EDGE_CROSSING_WAIT_MS });
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement();
      Pacer.note('go', 'blocked', Date.now() - tGo);
      let entered = ev.events.find(e => e.kind === 'room-entered');
      // ASK THE WORLD, NOT ONLY THE EVENT RING. The event can be missed — evicted, or
      // arriving on a rejoined client — while the character is demonstrably somewhere
      // else. Having crossed is a fact about where we are standing.
      //
      // AND ASK IT MORE THAN ONCE, BECAUSE THE ALTERNATIVE IS ANOTHER WALK ACROSS THE ROOM.
      //
      // A single look the instant the event wait expires makes the whole crossing a race
      // against one deadline: land at 10.5s and it reads as "stepping past the edge did
      // nothing", `leaveViaAny` moves to the next square, and confirming that costs a full
      // crossing of the room — which in The King's Way is a minute and a half. The exit-gap
      // record says plainly that this is what has been happening: the dominant row is a
      // delta of (0,0) with 72 sightings across rooms 150, 586, 574, 587 and 382. The model
      // named the RIGHT square, the character was standing on it, and the crossing was
      // recorded as refused anyway — 342 times on 587's west boundary alone.
      //
      // So the confirmation is a short poll rather than a single glance. It costs at most a
      // couple of seconds on a genuinely dead edge and saves a room crossing on every late
      // one, and the two are not close.
      if (!entered && c.room.id === edgeStartRoom) {
        const until = Date.now() + EDGE_CONFIRM_MS;
        while (Date.now() < until && c.room.id === edgeStartRoom) {
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return this.cancelledMovement();
          await new Promise(r => setTimeout(r, 400));
          const stoppedDuringEdgeConfirm = await stopAfterAwait();
          if (stoppedDuringEdgeConfirm) return stoppedDuringEdgeConfirm;
        }
      }
      if (!entered && leftExpectedRoom()) return staleExit();
      if (!entered) {
        // If this was an edge we INFERRED rather than one the room declared, the
        // inference was simply wrong — drop it so neither the planner nor anything
        // else keeps routing through a boundary that does not exist.
        if (exit.inferred && this.world?.room?.num != null && exit.to != null) {
          forgetInferredExit(this.world.room.num, exit.to);
          return { left: false, stage: 'edge', crossing_packet_sent: true,
                   reason: 'stepping past the edge did nothing',
                   note: 'this exit was inferred from the other room declaring an edge into here, and the ' +
                         'server refused it — the inference is now dropped and routes will avoid it' };
        }
        return { left: false, stage: 'edge', crossing_packet_sent: true,
                 reason: 'stepping past the edge did nothing',
                 note: 'that boundary may have no plEdge_Exits entry, or a condition on it excludes where we crossed' };
      }
      return { left: true, arrived_in: entered.roomName };
    }

    // A region exit needs nothing but arriving on the square: the room's own
    // SomethingMoved fires as we land and moves us across. So walk, then confirm by
    // the room having changed rather than by any reply, because there is not one.
    if (exit.kind === 'region') {
      const candidates = Array.isArray(exit.trigger_targets) && exit.trigger_targets.length
        ? exit.trigger_targets
        : exit.stand_on ? [{ stand_on: exit.stand_on, steps_away: exit.steps_away,
                             reachable: exit.reachable, approach_on: exit.approach_on }] : [];
      if (!candidates.length)
        return { left: false, reason: 'no walkable square or reachable approach for the trigger region',
                 note: 'the region is ' + exit.trigger + ' — it may really be walled off from here' };

      const result = await boundedRegionEntry({
        candidates,
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        stillCurrent: () => !leftExpectedRoom(),
        walk: candidate => this.walkTo(candidate.stand_on.col, candidate.stand_on.row,
          { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: LEAVE_VIA_CLEARANCE }),
        fineWalk: async candidate => {
          // Get as close as the square graph knows how before bypassing it. Fine movement
          // is deliberately expensive — every step is confirmed by a room read — and from
          // across an outdoor map it is both slow and needlessly risky. The staging square
          // makes this a short locally validated crossing of the disputed geometry.
          const target = candidate.stand_on;
          const knownApproach = candidate.approach_on;
          const computedApproach = this.world.approachSquare(target.col, target.row);
          const approach = knownApproach ?? (computedApproach && {
            col: computedApproach.col, row: computedApproach.row,
          });
          let staged = null;
          if (approach) {
            staged = await this.walkTo(approach.col, approach.row,
              { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: LEAVE_VIA_CLEARANCE });
            if (staged.left_room || (!staged.arrived &&
                !(c.self && c.self.col === approach.col && c.self.row === approach.row)))
              return { arrived: false, ...(staged.left_room ? { left_room: true } : {}),
                       reason: staged.reason ?? 'could not reach the square beside the trigger', staged };
            if (this.movementWasCancelled(movementGeneration, controlToken))
              return { arrived: false, cancelled: true, reason: 'movement cancelled during staging' };
            if (leftExpectedRoom())
              return { arrived: false, room_changed: true,
                       reason: 'room identity changed during region staging' };
          }
          const half = KOD_FINENESS >> 1;
          const fine = await this.walkFine(target.col * KOD_FINENESS + half,
                                           target.row * KOD_FINENESS + half,
                                           { maxSteps: 40, movementGeneration, controlToken })
                                 .catch(error => ({ arrived: false, reason: error.message }));
          return { ...fine, ...(staged ? { staged } : {}) };
        },
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
        // A genuine region fires merely by arriving. Asking to go is retained as one
        // bounded compatibility probe for map entries that are really doors in disguise.
        askGo: async () => {
          await this.standBeforeGo();          // same PFLAG_NO_MOVE gate as `send` above
          await this.pacer.submit('move', () =>
            (this.movementWasCancelled(movementGeneration, controlToken) || leftExpectedRoom())
              ? false : c.go(), DOOR_SETTLE_MS);
        },
      });
      const regionAttempts = result.tried.length;
      if (result.cancelled || this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ region_attempts: regionAttempts });
      // A room-entered event is authoritative evidence that this source-room region
      // succeeded. Checking leftExpectedRoom() first mistakes that success for a stale
      // exit and used to leak the numeric attempt count through array-valued `tried`.
      if (result.entered) {
        const successful = result.tried[result.tried.length - 1] ?? {};
        return { left: true, arrived_in: result.entered.roomName,
                 via: successful.asked_go ? 'region trigger, after asking to go'
                      : successful.fine ? 'region trigger via fine movement' : 'region trigger',
                 trigger_target: successful.candidate?.stand_on ?? null,
                 region_attempts: regionAttempts };
      }
      const stoppedAfterRegion = await stopAfterAwait();
      if (stoppedAfterRegion)
        return { ...stoppedAfterRegion, region_attempts: regionAttempts };
      if (result.terminal)
        return { left: false, stage: 'walk', ...result.terminal,
                 region_attempts: regionAttempts };
      if (result.unconfirmed_transition)
        return { ...(await staleExit()), region_attempts: regionAttempts };

      const tried = result.tried.map(attempt => ({
        stand_on: attempt.candidate.stand_on,
        approach_on: attempt.candidate.approach_on ?? null,
        coarse: attempt.coarse?.reason ?? (attempt.coarse?.arrived ? 'arrived' : null),
        fine: attempt.fine?.reason ?? (attempt.fine?.arrived ? 'arrived' : null),
        asked_go: !!attempt.asked_go,
      }));
      const reached = result.tried.some(attempt => attempt.coarse?.arrived || attempt.fine?.arrived);
      return { left: false,
               reason: reached
                 ? 'reached the trigger region but neither automatic entry nor `go` changed rooms'
                 : `could not reach any of ${candidates.length} bounded trigger-region target(s)`,
               tried, region_attempts: regionAttempts,
               note: 'the trigger is ' + exit.trigger };
    }

    // THE SQUARE WE ACTUALLY STOOD ON. Recorded on `this` rather than written anywhere,
    // because this method is lifted out of this file by text and evaluated by
    // m59-collision-test — it may touch nothing but `this`, its injected dependencies and
    // built-ins. A non-lifted caller flushes it; see flushExitGaps.
    this.lastExitStand = c.self ? { col: c.self.col, row: c.self.row } : null;

    if (exit.kind === 'portal') {
      // Nothing to send: Portal.SomethingMoved fires on arrival at its square and
      // teleports whatever is standing there. So walking IS the action.
      const before = c.evSeq;
      const portalStartRoom = c.room.id;
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: LEAVE_VIA_CLEARANCE });
      const stoppedAfterPortalWalk = await stopAfterAwait();
      if (stoppedAfterPortalWalk) return stoppedAfterPortalWalk;
      if (walk?.left_room)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc), via: 'portal' };
      if (isTerminalMovementReason(walk.reason) && c.room.id === portalStartRoom)
        return { left: false, stage: 'walk', ...walk };
      const tGo = Date.now();
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement();
      Pacer.note('go', 'blocked', Date.now() - tGo);
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (!entered && leftExpectedRoom()) return staleExit();
      if (!entered)
        return { left: false, stage: walk.arrived ? 'stood on it' : 'walk', ...walk,
                 reason: walk.arrived ? 'standing on it did nothing — it may not be a portal after all' : undefined };
      return { left: true, arrived_in: entered.roomName, via: 'portal' };
    }

    return { left: false, reason: 'cannot leave through a ' + exit.kind };
  }

  /**
   * THE LAST RESORT AT A DOORWAY THE MODEL CANNOT DESCRIBE — bounded, counted, and only
   * ever reached once the ordinary path has spent its bounded candidate budget.
   *
   * #18 made the harness enforce collision the way the stock client does, which was right:
   * the server accepts whatever coordinates you send, so nothing else was enforcing it and
   * bots crossed walls. But the approach model is incomplete at some doorways, and a
   * doorway the model cannot describe became a doorway nothing could use — ten of
   * twenty-one characters could not reach a bank, which is the same blockage that starves
   * the whole fleet of reagents.
   *
   * So where the model has refused every square the bounded budget attempted, take the one step it would
   * not, onto a square IT ITSELF published as crossing that boundary. That is far narrower
   * than "movement without validation": the target is the model's own answer, and every
   * step up to it was fully validated.
   *
   * Recorded every time, with the square the model believed in beside the square that
   * actually worked — a bypass nobody measures is a bypass that becomes permanent.
   * This deliberately relaxes collision and is OFF by default. `M59_EXIT_FALLBACK=1`
   * enables it explicitly for diagnosing a known model gap; normal travel fails closed.
   */
  async leaveViaUnvalidated(exit, { movementGeneration = this.movementGeneration,
                                    controlToken } = {}) {
    const c = this.need();
    const target = exit?.stand_on;
    if (!target || !Number.isInteger(target.col) || !Number.isInteger(target.row))
      return { left: false, reason: 'no square to fall back to' };
    if (this.movementWasCancelled(movementGeneration, controlToken))
      return this.cancelledMovement({});
    const before = c.evSeq, startRoom = c.room.id;
    const half = KOD_FINENESS >> 1;
    const x = target.col * KOD_FINENESS + half, y = target.row * KOD_FINENESS + half;
    if (!Number.isInteger(x) || x < 0 || x > 0xffff ||
        !Number.isInteger(y) || y < 0 || y > 0xffff)
      return { left: false, reason: 'fallback target is off the wire grid' };
    this.exitFallbacks = (this.exitFallbacks || 0) + 1;
    // AN EDGE IS LEFT BY STEPPING PAST IT, NOT ONTO IT — and this fallback stepped onto
    // it. `Room.SomethingMoved` only reaches StandardLeaveDir when the new row or col is
    // OUT of the room (room.kod:2232-2258), so moving to the boundary square is an
    // ordinary in-room step and can never cross. For a region exit arriving is the whole
    // trigger, which is why this went unnoticed: the fallback worked for the kind of exit
    // that needs no outward step, and silently could not work for the kind that does.
    //
    // Measured before this: 587 -> 576 reported "every square for that exit refused"
    // even though the outward step had been fixed, because every square WAS refused and
    // then the fallback took the one step that cannot cross either.
    // AND IT MUST ALREADY BE AT THE OPENING. This is the dangerous half, and without the
    // guard the fix above is worse than the bug it repairs.
    //
    // The server does no geometry check on a player move, so an unvalidated packet aimed
    // off the map from ANYWHERE in the room would cross — straight through whatever
    // stands between here and the boundary. Meridian has one-way overland links that are
    // one-way precisely because of terrain near the seam: 589 -> 599 -> 598 is walkable
    // westward and not eastward, because eastward you would have to climb the cliffs you
    // drop off going the other way. The boundary openings are wide (30 and 40 squares);
    // it is the APPROACH that is impossible, and this fallback firing from mid-room would
    // step straight over it and call a one-way link two-way.
    //
    // That is the same failure the breadcrumb note below warns about — relaxing collision
    // exactly where the two views disagree is what let bots climb cliffs no client can.
    // So: only when we are already standing within a square of the published opening,
    // which means the approach succeeded and the only thing left is the step the model
    // will not take.
    const outward = exit?.edge_target;
    const opening = exit?.fine_stand_on;
    const near = Number.isFinite(c.self?.x) && Number.isFinite(opening?.x)
      && Math.abs(c.self.x - opening.x) <= KOD_FINENESS
      && Math.abs(c.self.y - opening.y) <= KOD_FINENESS;
    const useOutward = exit?.kind === 'edge' && outward
      && Number.isFinite(outward.x) && Number.isFinite(outward.y) && near;
    if (exit?.kind === 'edge' && !useOutward)
      return { left: false, reason: 'not at the opening',
               note: 'the unvalidated outward step is only taken from the boundary itself — ' +
                     'firing it from mid-room would cross terrain the approach could not' };
    const fallbackTo = useOutward
      ? { x: Math.round(outward.x), y: Math.round(outward.y) }
      : { x, y };
    const fallbackSpeed = useOutward ? 0 : 18;
    const wireFrom = c.self ? { x: c.self.x, y: c.self.y } : null;
    try {
      c.moveTo(fallbackTo.x, fallbackTo.y, fallbackSpeed, startRoom);
      this.recordUnsafeWireMove?.({
        client: c,
        roomId: startRoom,
        from: wireFrom,
        requested: fallbackTo,
        to: fallbackTo,
        speed: fallbackSpeed,
        offMap: useOutward,
        unsafeReason: 'exit_unvalidated_fallback',
      });
    } catch (e) { return { left: false, reason: e.message }; }
    const ev = await c.waitFor({ since: before, kinds: ['room-entered'],
                                 timeoutMs: EDGE_CROSSING_WAIT_MS })
                      .catch(() => ({ events: [] }));
    if (this.movementWasCancelled(movementGeneration, controlToken))
      return this.cancelledMovement({});
    const entered = ev.events?.find(e => e.kind === 'room-entered');
    if (entered) return { left: true, arrived_in: entered.roomName, via: 'exit-fallback',
                          stood_on: { col: target.col, row: target.row } };
    // The room is the authority on having left, not the event — see the same argument
    // at the end of leaveVia.
    if (c.room.id !== startRoom)
      return { left: true, arrived_in: c.rsc.get(c.roomNameRsc), via: 'exit-fallback',
               stood_on: { col: target.col, row: target.row },
               note: 'the room changed but no room-entered event was seen' };
    return { left: false, reason: 'the unvalidated step did not change rooms either' };
  }

  // One doorway is often published as several squares, and they are NOT
  // interchangeable: in the Royal Bank of Jasper (9,7) has a brazier standing on
  // it and refuses, while (9,6) one square north opens. Which is which is not in
  // the protocol, so the only honest thing is to try them in a sensible order and
  // report what each said.
  /**
   * Ride a learned track across this room, or say why not.
   *
   * THE MONORAIL. A track is the quickest crossing anybody has actually made of this room
   * between these two doors, straightened against the baked BSP — so it is made of accepted
   * moves and cannot contain a step the mover refuses, which is the failure mode of planning
   * on square stand points a body never occupies.
   *
   * IT BOARDS COARSELY AND RIDES FINELY. The stations are the waypoints the SQUARE router
   * can reach; the tight ones between them are exactly what the coarse grid cannot deliver
   * you to, which is the same fact that makes them safe walls. So getting on is an ordinary
   * walk and only the ride is fine.
   *
   * NULL-ISH IS "PLAN IT THE WAY YOU ALWAYS DID". Every refusal here returns `rode: false`
   * and moves nothing that matters, because a book with one observation per key must never
   * be able to make travel worse than not having it.
   */
  // CROSS THIS ROOM WALL TO WALL, AND DO THE THINKING ON A WALL. See m59-safelegs.mjs for the
  // mechanism and docs/m59-routing.md ("Safe-spot legs") for the argument and the measurement.
  //
  // Called by `travel` for one hop, before the track and the exit walk, with the exit it chose.
  // Returns null when this room is not one to cross by legs (the ordinary walk runs exactly as
  // before), otherwise a record of what it did. It never takes the last step: the final leg is
  // left to `leaveViaAny`, which owns crossing a boundary and everything learned about doing so.
  //
  // THE STOP IS BOUNDED TO THE PLANNING. Standing on a wall, it reads the room's threats, plans
  // the chain from here (`planSafeLegs`, budgeted by `deadlineMs`, yielding to the event loop
  // between attempts so the keeper's socket and survival clock keep ticking), and walks the
  // first leg at once. It rests on a wall only when the journey's shelter policy says the body
  // needs it — the same `need()`/`onArrive()` the fuel-stop divert already uses — so a whole
  // character never waits, and a hurt one mends somewhere nothing can reach it.
  //
  // IT NEVER STRANDS THE HOP. No chain, a chain much longer than the road, a spent budget or
  // three legs it could not walk all end the legs and hand the rest of the crossing to the
  // ordinary walker, from wherever the body is — which, after any completed leg, is a wall.
  async crossBySafeLegs(exit, { movementGeneration = this.movementGeneration, controlToken,
                                policy = this.safeLegPolicy ?? null,
                                fromRoom = null, toRoom = exit?.to ?? null } = {}) {
    const c = this.need();
    const room = this.world?.room;
    const geo = this.world?.geometry;
    const goal = exit?.stand_on;
    if (!room || !geo?.collisionReady || !goal || !safeLegsFor(room.num, policy)) return null;
    const opts = { ...(policy && typeof policy === 'object' ? policy : {}) };
    const roomId = c.room?.id;
    const started = Date.now();
    const out = { ran: true, room: room.num, legs: 0, walls: [], plans: 0, plan_ms_max: 0,
                  plan_ms_total: 0, failed: 0, rested: 0, fallback: null, handed_over: false };
    const unreachable = new Set();
    const visited = new Set();
    const maxLegs = Number(opts.maxLegs ?? 24);
    // THE WALKED CORRIDOR, WHEN THERE IS ONE. See trackCorridor: in Ukgoth the router believes in
    // ground by the 598 door that no body has crossed, and a baked track is the evidence of where
    // one has. EVERY track in this room to this exit, and struck ones too: a strike says riding
    // that track end to end failed, not that nobody walked it — and the first live run lost its
    // corridor exactly that way, three strikes on 599:598>2 leaving only a track that starts
    // forty squares from the door, so no leg could begin. A corridor that does not reach the
    // body is no corridor; the plan then says `no_chain` and the ordinary walk runs.
    let corridor = null, avoid = null;
    try {
      const radius = Number(opts.corridorRadius ?? SAFE_LEG_DEFAULTS.corridorRadius);
      const ck = `${room.num}>${toRoom}|${radius}`;
      if (toRoom != null && !SAFE_LEG_CORRIDORS.has(ck)) {
        const book = loadTracks() ?? {};
        const set = new Set();
        for (const [k, t] of Object.entries(book)) {
          if (!k.startsWith(`${room.num}:`) || !k.endsWith(`>${toRoom}`) || !(t?.waypoints?.length >= 2)) continue;
          for (const sq of trackCorridor(t.waypoints, { radius, rows: geo.rows, cols: geo.cols })) set.add(sq);
        }
        const off = [];
        if (set.size) for (let r = 1; r <= geo.rows; r++) for (let cc = 1; cc <= geo.cols; cc++)
          if (!set.has(`${r},${cc}`)) off.push(`${r},${cc}`);
        SAFE_LEG_CORRIDORS.set(ck, set.size ? { set, off } : null);
      }
      const hit = SAFE_LEG_CORRIDORS.get(ck) ?? null;
      if (hit) { corridor = hit.set; avoid = hit.off; out.corridor = corridor.size; }
    } catch { corridor = null; avoid = null; }
    const note = () => {
      out.ms = Date.now() - started;
      console.log(`[safe-legs] ${c.me?.name ?? this.name ?? '?'} room ${room.num} done: ${out.legs} leg(s) ` +
        `${out.walls.join(' ')}, ${out.failed} failed, ${out.rested} rest(s), worst plan ${out.plan_ms_max}ms, ` +
        `${out.handed_over ? 'handed to the exit walker' : out.left_room ? 'left the room' : 'fell back: ' + out.fallback}` +
        ` after ${Math.round(out.ms / 1000)}s`);
      try {
        recordTactic({ character: c.me?.name ?? this.name ?? null, room: Number(room.num),
                       tactic: 'safe_legs', trigger: `exit to ${exit.to ?? '?'}`,
                       worked: out.handed_over || !!out.left_room, ms: out.ms,
                       hp_lost: 0, attempted: true,
                       note: `${out.legs} leg(s) ${out.walls.join(' ')}; ${out.plans} plan(s), worst ` +
                             `${out.plan_ms_max}ms; ${out.failed} failed; ${out.rested} rest(s)` +
                             (out.fallback ? `; fell back: ${out.fallback}` : '') });
      } catch { /* evidence, not a dependency */ }
      return out;
    };
    for (let n = 0; n < maxLegs; n++) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return { ...out, cancelled: true };
      if (roomId != null && c.room?.id !== roomId) { out.left_room = true; return note(); }
      const me = c.self;
      if (!me) { out.fallback = 'own position unknown'; break; }
      // WHAT IS IN THE ROOM NOW, read from the client's memory — the object list, not a view.
      let threats = [];
      try { threats = this.threatsHere() ?? []; } catch { threats = []; }
      // A WALL ALREADY STOOD ON IS NOT THE NEXT STOP. Threat-priced re-planning can flip between
      // two walls as a troll moves — measured live, r15c7 r17c8 r15c7 r17c8 — so a wall this
      // crossing has used may still be passed through but may not be walked back to.
      const occupied = new Set(visited);
      for (const o of (c.room?.objects?.values?.() ?? [])) {
        if (o.id === c.selfId || !blocksMovement(o.flags)) continue;
        if (Number.isFinite(o.row) && Number.isFinite(o.col)) occupied.add(`${o.row},${o.col}`);
      }
      // BOUNDED WORK PER TICK. The floods a plan builds are cached per geometry, so a plan cut
      // off by its deadline leaves the next attempt less to do; between attempts the event loop
      // runs. Four attempts is the whole allowance, then the direct walk.
      let plan = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        plan = planSafeLegs(geo, { row: me.row, col: me.col }, { row: goal.row, col: goal.col },
                            { ...opts, threats, occupied, unreachable, corridor });
        out.plans++;
        out.plan_ms_total = Math.round(out.plan_ms_total + (plan.ms ?? 0));
        out.plan_ms_max = Math.max(out.plan_ms_max, plan.ms ?? 0);
        if (plan.reason !== 'deadline') break;
        await new Promise(r => setImmediate(r));
      }
      // ONE LINE PER DECISION IN THE KEEPER LOG, because a crossing that goes wrong is read
      // afterwards from there and the ledger row only says how it ended.
      console.log(`[safe-legs] ${c.me?.name ?? this.name ?? '?'} room ${room.num} at r${me.row}c${me.col} -> ` +
        `r${goal.row}c${goal.col}: ${plan?.found ? `${plan.legs.length} leg(s), next ${plan.legs[0].kind} ` +
        `r${plan.legs[0].row}c${plan.legs[0].col}/${plan.legs[0].steps}` : `no plan (${plan?.reason})`} ` +
        `in ${plan?.ms}ms, ${threats.length} threat(s)`);
      if (!plan?.found) { out.fallback = plan?.reason ?? 'no plan'; out.direct_steps ??= plan?.direct_steps ?? null; break; }
      if (n === 0) { out.planned_legs = plan.legs.length; out.planned_steps = plan.steps; out.direct_steps = plan.direct_steps; }
      const next = plan.legs[0];
      // The last leg is the exit's, and the exit walker owns it.
      if (next.kind === 'exit') { out.handed_over = true; break; }
      // Kept inside the corridor too: the walker plans its own route to the wall, and without
      // this it plans the same unwalked shortcut the corridor exists to keep the legs off.
      // `walkTo` relaxes occupancy before it gives up, so this can cost a detour and never a walk.
      const walked = await this.walkTo(next.col, next.row,
        { maxSteps: Math.max(20, next.steps * 2), movementGeneration, controlToken,
          ...(avoid ? { avoidSquares: avoid } : {}) })
        .catch(e => ({ arrived: false, reason: e.message }));
      if (this.movementWasCancelled(movementGeneration, controlToken)) return { ...out, cancelled: true };
      if (walked?.left_room || (roomId != null && c.room?.id !== roomId)) { out.left_room = true; return note(); }
      let at = c.self;
      // A WALL IS A POCKET, AND THE LAST STEP INTO ONE IS THE FINE GRID'S. See the handover in
      // m59-skills.mjs: the square walker is best for the haul and worst for the last squares.
      if (!(walked?.arrived && at?.row === next.row && at?.col === next.col)
          && at && Math.max(Math.abs(at.row - next.row), Math.abs(at.col - next.col)) <= 3
          && typeof this.approachFine === 'function') {
        await this.approachFine(next.col, next.row, { movementGeneration, controlToken }).catch(() => null);
        if (this.movementWasCancelled(movementGeneration, controlToken)) return { ...out, cancelled: true };
        at = c.self;
      }
      if (!(at?.row === next.row && at?.col === next.col)) {
        console.log(`[safe-legs] ${c.me?.name ?? this.name ?? '?'} did not reach r${next.row}c${next.col} ` +
          `(at r${at?.row}c${at?.col}): ${walked?.reason ?? walked?.note ?? 'no reason'}`);
        unreachable.add(`${next.row},${next.col}`);
        out.failed++;
        if (out.failed >= 3) { out.fallback = 'three legs could not be walked'; break; }
        continue;          // re-plan from wherever that left us, without the wall it missed
      }
      out.legs++;
      out.walls.push(`r${next.row}c${next.col}`);
      visited.add(`${next.row},${next.col}`);
      // ON A WALL. Mend here only if the journey's own shelter policy says the body needs it.
      const sp = this.shelterPolicy;
      let wants = false;
      try { wants = !!sp?.need?.(); } catch { wants = false; }
      if (wants && typeof sp.onArrive === 'function') {
        const rested = await sp.onArrive({ col: next.col, row: next.row },
          { source: 'safe_leg', movementGeneration, controlToken }).catch(() => false);
        if (rested) out.rested++;
        if (this.movementWasCancelled(movementGeneration, controlToken)) return { ...out, cancelled: true };
      }
    }
    return note();
  }

  async rideTrack(fromRoom, toRoom, { movementGeneration = this.movementGeneration, controlToken,
                                      // Ride even a struck track. Only `travel` passes it, and only
                                      // after safe legs have brought the body to its last wall —
                                      // see the note there.
                                      ignoreStrikes = false } = {}) {
    const c = this.need();
    const here = Number(this.world?.room?.num ?? NaN);
    if (!Number.isFinite(here) || !Number.isFinite(Number(toRoom))) return { rode: false, why: 'no room' };
    if (this.movementWasCancelled(movementGeneration, controlToken))
      return { rode: false, left_room: false, cancelled: true, why: 'movement cancelled' };
    // Pin the protocol room as well as the graph room. `stepFine` deliberately predicts a
    // locally-proved move instead of waiting for every server acknowledgement; on the final
    // track station that move can be the boundary packet itself. The room-entered event may
    // therefore arrive just after stepFine reports `left_room:false`.
    const roomId = c.room?.id;
    const leftTheRoom = () => roomId != null && c.room?.id !== roomId;
    const track = ignoreStrikes
      ? recallTrack(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom), loadTracks(), {})
      : recallTrack(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
    if (!track?.waypoints?.length) return { rode: false, why: 'no track' };
    // AN UNPROVEN STITCH IS TRIED ONCE, WITH THE WALKED ROUTE STILL UNDERNEATH IT.
    //
    // `waypoints` may be a route sewn from several walks: every leg raycast-proved, and the
    // whole thing never ridden. `walked` is the real crossing it was built to beat. Ride the
    // stitch — that is how it becomes proven — but if it does not get us out of the room,
    // fall back to the route something has actually walked rather than reporting the
    // crossing shut.
    const sewn = track.proven === false && Array.isArray(track.walked) && track.walked.length >= 2
      ? track.walked : null;
    const geo = this.world?.geometry ?? null;
    const me0 = c.self;
    if (!me0) return { rode: false, why: 'own position unknown' };
    const JOIN_WITHIN = Number(process.env.M59_TRACK_JOIN_WITHIN || 640);
    let joinAt = -1, joinDist = Infinity;
    for (let i = 0; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      const row = Math.floor(wp.y / KOD_FINENESS) + 1, col = Math.floor(wp.x / KOD_FINENESS) + 1;
      if (geo && typeof geo.walkable === 'function' && !geo.walkable(row, col)) continue;
      const d = Math.hypot(wp.x - me0.x, wp.y - me0.y);
      if (d < joinDist) { joinDist = d; joinAt = i; }
    }
    if (joinAt < 0) return { rode: false, why: 'no station reachable on the coarse grid' };
    if (joinDist > JOIN_WITHIN) return { rode: false, why: 'not on this track', off_by: Math.round(joinDist) };
    const started = Date.now();
    if (joinDist > KOD_FINENESS) {
      const wp = track.waypoints[joinAt];
      const board = await this.walkTo(Math.floor(wp.x / KOD_FINENESS) + 1,
                                      Math.floor(wp.y / KOD_FINENESS) + 1,
                                      { maxSteps: 60, movementGeneration, controlToken }).catch(() => null);
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return { rode: false, left_room: false, cancelled: true, boarded: false,
                 why: 'movement cancelled', ms: Date.now() - started };
      if (board?.left_room) {
        clearStrikes(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
        return { rode: true, left_room: true, boarded: false, ms: Date.now() - started };
      }
      if (leftTheRoom())
        return { rode: true, left_room: false, room_changed: true, boarded: false,
                 ms: Date.now() - started };
      if (!board?.arrived) return { rode: false, why: 'could not reach the station', off_by: Math.round(joinDist) };
    }
    // Use the route policy and the same live geometry/exclusion search as walkTo.
    // A track's fine aims remain its route: only actual stations are rest stops.
    // The persisted `track.shelter` indexes used a legacy +1 square conversion and
    // a different wall predicate; they are not authority for where to rest today.
    const policy = this.shelterPolicy;
    const planShelters = waypoints => {
      const steps = waypoints.map(wp => ({ row: Math.floor(wp.y / KOD_FINENESS),
                                         col: Math.floor(wp.x / KOD_FINENESS) }));
      const spots = policy?.need && typeof policy.onArrive === 'function'
        ? sheltersAlong(geo, steps, { within: 0, limit: steps.length,
            book: policy.book ?? null, room: here,
            unreachable: policy.unreachable?.(here) ?? null }) : [];
      const plan = { spots, maxDetour: 0, atStep: 0, onward: steps.at(-1) ?? null };
      this.activeShelter = plan;
      return plan;
    };
    const shelter = planShelters(track.waypoints);
    const visitedShelters = new Set();
    const restAtStation = async (wp, index, plan) => {
      this.activeShelter = plan;
      plan.atStep = index;
      if (this.movementWasCancelled(movementGeneration, controlToken) || leftTheRoom()
          || this.shelterPolicy !== policy) return;
      let wants = false;
      try { wants = !!policy?.need?.(); } catch { /* same refusal as walkPivots */ }
      if (!wants) return;
      const stop = plan.spots.find(spot => spot.atStep === index);
      if (!stop) return;
      const key = `${stop.col},${stop.row}`;
      if (visitedShelters.has(key) || policy.unreachable?.(here)?.has(key)) return;
      const at = c.self;
      // Near a fine aim can still be the next square: resting requires THIS refuge.
      if (!at || at.row !== stop.row || at.col !== stop.col
          || Math.hypot(at.x - wp.x, at.y - wp.y) > 48) return;
      visitedShelters.add(key);
      try { policy.onDivert?.(stop, { atStep: index, source: 'track' }); } catch {}
      if (this.movementWasCancelled(movementGeneration, controlToken) || leftTheRoom()
          || this.shelterPolicy !== policy) return;
      const restStarted = Date.now();
      let didRest = false;
      try {
        didRest = await policy.onArrive({ row: stop.row, col: stop.col },
          { source: 'track', movementGeneration, controlToken });
      } catch { /* the shared rest failed; the next guarded leg can still proceed */ }
      if (didRest) { rested++; restedMs += Date.now() - restStarted; }
    };
    let rested = 0, restedMs = 0;
    let reached = 0, blocked = 0, bodiesInTheWay = 0;
    const crossed = (extra = {}) => {
      clearStrikes(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
      return { rode: true, left_room: true, reached, blocked, rested, rested_ms: restedMs,
               ms: Date.now() - started, ...extra };
    };
    const roomChanged = (extra = {}) => ({
      rode: true, left_room: false, room_changed: true, reached, blocked, rested, rested_ms: restedMs,
      ms: Date.now() - started, ...extra,
    });
    const cancelledRide = (extra = {}) => ({
      rode: false, left_room: false, cancelled: true, reached, blocked, rested, rested_ms: restedMs,
      why: 'movement cancelled', ms: Date.now() - started, ...extra,
    });
    for (let i = joinAt; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      if (this.movementWasCancelled(movementGeneration, controlToken)) return cancelledRide();
      if (leftTheRoom()) return roomChanged({ late_room_change: true });
      // RIDE A LEG THE WAY IT WAS PROVED.
      //
      // A track's legs are proved by `straighten`, which asks `traceFineMoveClient` whether
      // ONE slide from here to there lands within a body's width of the target. Riding them
      // with `walkFine` asks a different question entirely — 48-unit steps with a fan of
      // headings, groping toward a point — and a leg that is a single clean slide is not
      // something that gropes well. Measured on the Tos gate track: three of four legs came
      // back "blocked, every heading refused, at every reach tried", on a route a body had
      // actually walked and a raycast had re-proved.
      //
      // So the leg is sent as the single validated move it was proved to be. walkFine stays
      // as the fallback for the leg that really does need feeling out, which is the job it
      // is good at.
      let r = await this.stepFine(wp.x, wp.y).catch(() => null);
      if (this.movementWasCancelled(movementGeneration, controlToken)) return cancelledRide();
      if (r?.left_room) return crossed();
      if (leftTheRoom()) return roomChanged({ late_room_change: true });
      const arrivedNear = () => { const p = c.self;
        return p && Math.hypot(p.x - wp.x, p.y - wp.y) <= 48; };
      if (!r?.left_room && !arrivedNear())
        r = await this.walkFine(wp.x, wp.y, { maxSteps: 40, movementGeneration, controlToken })
          .catch(() => null) ?? r;
      if (this.movementWasCancelled(movementGeneration, controlToken)) return cancelledRide();
      if (r?.left_room) return crossed();
      if (leftTheRoom()) return roomChanged({ late_room_change: true });
      // WAS ANYTHING ALIVE IN THE WAY? This is the whole of the strike rule: a ride that
      // fails while a body is standing on it says nothing about the route.
      if (r?.reason === 'object_blocked' || (r?.monster_blocked ?? 0) > 0
          || (Array.isArray(r?.blocked_by_bodies_at) && r.blocked_by_bodies_at.length))
        bodiesInTheWay++;
      const now = c.self;
      const near = now && Math.hypot(now.x - wp.x, now.y - wp.y) <= 48;
      if (near) reached++;
      else {
        blocked++;
        // The next leg was proved from this waypoint, not from wherever the body stopped.
        // End the replay at the first broken proof boundary and let the normal fallback act.
        break;
      }
      await restAtStation(wp, i, shelter);
      if (this.movementWasCancelled(movementGeneration, controlToken)) return cancelledRide();
      if (leftTheRoom()) return roomChanged({ late_room_change: true });
    }
    // The stitch did not get us out. Try the route that has actually been walked before
    // giving the crossing back to the planner.
    if (sewn) {
      // JOIN THE WALKED ROUTE WHERE THE STITCH LEFT US, NOT BACK AT ITS ENTRANCE.
      //
      // The stitched and walked routes have different numbers of stations, so their array
      // indices do not describe the same progress. Project the CURRENT position onto the
      // walked polyline instead: an interior projection has already passed that leg's first
      // station, hence the next station is the earliest non-regressive join. Among viable
      // stations at or beyond there, take the nearest one.
      //
      // This is not just an optimisation. In The King's Way an unproven 587>575 stitch got
      // most of the way north, missed its final long leg, then spent ten minutes driving
      // south into a wall because the fallback restarted at walked[0].
      const now = c.self;
      const finitePoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.y);
      const viableStation = i => {
        const wp = sewn[i];
        if (!finitePoint(wp)) return false;
        if (!geo || typeof geo.standable !== 'function') return true;
        return geo.standable(Math.floor(wp.y / KOD_FINENESS),
                             Math.floor(wp.x / KOD_FINENESS));
      };
      let progressAt = 0;
      if (finitePoint(now)) {
        let projectionDist = Infinity;
        for (let i = 0; i + 1 < sewn.length; i++) {
          const a = sewn[i], b = sewn[i + 1];
          if (!finitePoint(a) || !finitePoint(b)) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const length2 = dx * dx + dy * dy;
          if (!(length2 > 0)) continue;
          const t = Math.max(0, Math.min(1,
            ((now.x - a.x) * dx + (now.y - a.y) * dy) / length2));
          const d = Math.hypot(now.x - (a.x + t * dx), now.y - (a.y + t * dy));
          const ahead = t > 0 ? i + 1 : i;
          if (d < projectionDist || (d === projectionDist && ahead > progressAt)) {
            projectionDist = d;
            progressAt = ahead;
          }
        }
      }
      let fallbackAt = -1, fallbackDist = Infinity;
      for (let i = progressAt; i < sewn.length; i++) {
        if (!viableStation(i)) continue;
        const d = finitePoint(now) ? Math.hypot(sewn[i].x - now.x, sewn[i].y - now.y) : i;
        if (d < fallbackDist) { fallbackDist = d; fallbackAt = i; }
      }
      const fallback = fallbackAt < 0 ? [] : sewn.slice(fallbackAt);
      const fallbackShelter = planShelters(fallback);
      for (const [i, wp] of fallback.entries()) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return cancelledRide({ fell_back_to_walked: true });
        if (leftTheRoom())
          return roomChanged({ fell_back_to_walked: true, late_room_change: true });
        const r = await this.walkFine(wp.x, wp.y, { maxSteps: 60, movementGeneration, controlToken })
          .catch(() => null);
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return cancelledRide({ fell_back_to_walked: true });
        if (r?.left_room) return crossed({ fell_back_to_walked: true });
        if (leftTheRoom())
          return roomChanged({ fell_back_to_walked: true, late_room_change: true });
        await restAtStation(wp, i, fallbackShelter);
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return cancelledRide({ fell_back_to_walked: true });
        if (leftTheRoom())
          return roomChanged({ fell_back_to_walked: true, late_room_change: true });
      }
    }
    // THE RIDE DID NOT GET US OUT. Whose fault was it?
    //
    // Nothing living in the way means the route is wrong, and three of those in a row
    // retires it. A body in the way means traffic, which is exactly what a monorail is for
    // and says nothing about the line — so it is not counted, or every busy corridor would
    // strike out its own best route.
    if (this.movementWasCancelled(movementGeneration, controlToken)) return cancelledRide();
    if (leftTheRoom()) return roomChanged({ late_room_change: true });
    const struck = bodiesInTheWay === 0
      ? strikeTrack(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom))
      : 0;
    return { rode: true, left_room: false, reached, blocked, rested, rested_ms: restedMs,
             ms: Date.now() - started,
             waypoints: track.waypoints.length - joinAt, track_best_ms: track.ms,
             bodies_in_the_way: bodiesInTheWay,
             ...(struck ? { strikes: struck,
                            retired: struck >= 3 ? 'this track will not be offered again' : undefined }
                        : {}),
             ...(sewn ? { stitch_unproven: true } : {}),
             ...(shelter.spots.length ? { shelter_stations: shelter.spots.length } : {}) };
  }

  // `exact` — THE CALLER'S DOOR SET IS THE WHOLE PERMITTED SET, not a starting suggestion.
  // Off by default, so every ordinary crossing keeps the anchor-first, spread-wide
  // behaviour that makes a wide wall reliable. See the block below for what it turns off
  // and the measurement that made it necessary.
  /**
   * THE PRIVATE STRATEGIES, LOADED ONCE PER PROCESS AND NEVER RE-READ.
   *
   * Cached deliberately: this is asked on a stuck walk, and a directory scan plus a set of
   * dynamic imports on that path would add latency exactly where the character is already in
   * trouble. A changed strategy therefore takes effect when the KEEPER restarts, which is the
   * same rule as every other piece of code here (see CLAUDE.md on keeper restarts) and means
   * an edit cannot half-apply to a fleet mid-journey.
   *
   * NEVER THROWS AND NEVER BLOCKS THE MOVER. A missing directory, a broken strategy, an
   * import that fails -- all of them resolve to "no answer", which is the behaviour the fleet
   * had before any of this existed.
   */
  async _askStrategies(hook, ctx) {
    try {
      if (Session._strategies === undefined) {
        Session._strategies = null;
        const mod = await import('./m59-strategies.mjs');
        Session._strategies = await mod.load();
        Session._firstAnswer = mod.firstAnswer;
        const problems = Session._strategies?.problems ?? [];
        if (problems.length)
          console.error('[strategies] ' + problems.map(p => `${p.file}: ${p.why}`).join('; '));
      }
      const answer = await Session._firstAnswer?.(Session._strategies, hook, ctx,
        { onError: e => console.error(`[strategies] ${e.strategy} threw: ${e.why}`) });
      if (hook !== 'whenStuck') return answer ?? null;
      const privateBlink = Session._strategies?.strategies?.find(s=>s.name==='blink-escape');
      const blinkLoadError=Session._strategies?.problems?.some(p=>p.file==='blink-escape.mjs');
      const full = this._trafficBlinkContext(ctx);
      const candidate = chooseTrafficBlink(full);
      // Explicit local policy retains precedence, even when it is disabled or
      // declines. Never turn an allow-list refusal into a built-in permission.
      const selected = answer ?? (!privateBlink && !blinkLoadError && candidate.can
        ? {strategy:'builtin-blink-escape',answer:candidate.answer} : null);
      this._recordBlinkRung({phase:'decision',from:ctx.from,reason:blinkLoadError && !answer
        ? 'private_policy_load_error' : privateBlink && !answer
        ? (privateBlink.enabled?'private_policy_declined':'private_policy_disabled') : candidate.reason,
        selected:selected?.answer?.do==='blink',goal:ctx.goal,landing:ctx.blink,
        position:ctx.self?{row:ctx.self.row,col:ctx.self.col}:null,bodies:ctx.bodies??[],
        verdict:candidate.verdict??null});
      if (selected?.answer?.do==='blink') {
        this._blinkProposal={ctx:full,generation:this.movementGeneration,room:this.world?.room?.num,
          client:this.client,life:this.lifeBoundary??0};
      }
      return selected;
    } catch (e) {
      this._recordBlinkRung({phase:'decision',reason:'strategy_error',why:e.message,selected:false});
      return null;
    }
  }

  _trafficBlinkContext(ctx) {
    const c=this.client;
    return {...ctx,knowsBlink:(c?.spells??[]).some(sp=>
      String(c.rsc?.get?.(sp.nameRsc)??sp.name??'').toLowerCase()==='blink'),
      disabled:process.env.M59_TRAFFIC_BLINK==='0',
      cooldown:Date.now()-(this._lastTrafficBlinkAt??0)<30000};
  }

  _recordBlinkRung(event) {
    const stats=this.blinkRungStats??={decisions:0,selected:0,casts:0,arrivals:0,refusals:{},cast_refusals:{}};
    if(event.phase==='decision') {
      stats.decisions++; if(event.selected)stats.selected++;
      else stats.refusals[event.reason]=(stats.refusals[event.reason]??0)+1;
    }
    if(event.phase==='outcome') {
      if(event.cast)stats.casts++;
      else stats.cast_refusals[event.reason]=(stats.cast_refusals[event.reason]??0)+1;
      if(event.arrived)stats.arrivals++;
    }
    stats.last={at:Date.now(),...event};
    // Count every ask, persist identical refusals at most every 30 seconds.
    const key=JSON.stringify([this.world?.room?.num,event.phase,event.reason,event.goal]);
    if(event.phase==='decision'&&!event.selected&&this._blinkReceipt?.key===key
        &&Date.now()-this._blinkReceipt.at<30000)return;
    this._blinkReceipt={key,at:Date.now()};
    recordEvent(this.client?.me?.name??this.name,'blink_rung',{
      room:this.world?.room?.num??null,...event,counts:{decisions:stats.decisions,
        selected:stats.selected,casts:stats.casts,arrivals:stats.arrivals}});
  }

  /** Bodies in this room that block movement, as squares — the shape a strategy expects. */
  _blockingBodies() {
    try {
      const c = this.need();
      return [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0))
        .map(o => ({
          row: o.row ?? (Number.isFinite(o.y) ? Math.floor(o.y / KOD_FINENESS) : null),
          col: o.col ?? (Number.isFinite(o.x) ? Math.floor(o.x / KOD_FINENESS) : null),
          kind: (o.flags & OF.PLAYER) ? 'player' : 'monster',
          name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? null,
        }))
        .filter(b => Number.isFinite(b.row) && Number.isFinite(b.col));
    } catch { return []; }
  }

  /**
   * This room's blink point, from the bake, or null.
   *
   * Read from substrate/m59-blink.json once. A room with no entry is a room where blink is
   * not an option, and that has to reach the strategy as an ABSENCE rather than as a guess —
   * room.kod:789 simply does not move you when the room declares no teleport pair, while
   * blink.kod still prints its success line, so a guessed point would read as a working
   * escape that never moved anybody.
   */
  _blinkPointHere() {
    try {
      const num = Number(this.world?.room?.num ?? 0);
      if (!num) return null;
      if (Session._blinkPoints === undefined) {
        Session._blinkPoints = null;
        const url = new URL('../substrate/m59-blink.json', import.meta.url);
        const raw = readFileSync(url, 'utf8');
        Session._blinkPoints = JSON.parse(raw)?.rooms ?? null;
      }
      const p = Session._blinkPoints?.[String(num)];
      return p && Number.isFinite(p.row) && Number.isFinite(p.col)
        ? { row: p.row, col: p.col } : null;
    } catch { return null; }
  }


  /**
   * CAST BLINK AND FIND OUT WHETHER IT MOVED US. The primitive; the decision is elsewhere.
   *
   * A CAST NEEDS CONCENTRATION and the tick driver sends move/turn at 10Hz, so any packet we
   * send while the spell is charging kills it. The keeper's own `/action cast` solved this
   * already -- freeze the loop, cast, wait for the server's `moved` event rather than a fixed
   * hold -- and this is that logic, reachable from the mover. Blink is `viCast_time = 10000`,
   * so the wait is seconds, not the ~1s an attack takes.
   *
   * THE SERVER'S SENTENCE IS NOT EVIDENCE. `blink.kod` prints "You find yourself realigned
   * with your surroundings." whether or not the room declares a teleport point (room.kod:789
   * moves you only `if GetTeleportRow <> $ AND GetTeleportCol <> $`), so a strategy that
   * believed the message would report success in every room that has no blink point at all.
   * What is believed here is the `moved` EVENT and the position read back after it.
   */
  async blinkOut({ expect = null, holdMs = 15000,
                   movementGeneration = this.movementGeneration, controlToken = null } = {}) {
    const c=this.client, proposal=this._blinkProposal;
    this._blinkProposal=null;
    const finish=out=>{this._recordBlinkRung({phase:'outcome',...out});return out;};
    const cancelled=()=>this.client!==c || c!==proposal?.client
      || this.movementWasCancelled?.(movementGeneration,controlToken)
      || (this.lifeBoundary??0)!==proposal?.life
      || this.world?.room?.num!==proposal?.room || !(c?.vitals?.()?.health?.value>0);
    if(!c || !proposal || proposal.generation!==movementGeneration || cancelled())
      return finish({cast:false,arrived:false,reason:'ownership_or_life_changed',why:'stale blink proposal'});
    const ctx=this._trafficBlinkContext({...proposal.ctx,self:c.self,room:this.world?.room,
      geo:this.world?.geometry,bodies:this._blockingBodies(),vitals:c.vitals?.(),
      underFire:proposal.ctx.underFire || Date.now()-(this.damagedAt??0)<5000});
    const gate=chooseTrafficBlink(ctx);
    if(!gate.can)return finish({cast:false,arrived:false,reason:gate.reason,why:gate.reason});
    const spell=(c.spells??[]).find(sp=>String(c.rsc?.get?.(sp.nameRsc)??sp.name??'').toLowerCase()==='blink');
    const loop=this._tickLoop, frozen=loop?._frozen, since=c.evSeq, from={...c.self},
      started=Date.now(), room=this.world?.room?.num;
    let cast=false, waited=null;
    const freezeLease={loop,generation:movementGeneration,frozen};
    try {
      if(loop) {this._blinkFreeze=freezeLease;loop._frozen=true;}
      if(cancelled())return finish({cast:false,arrived:false,reason:'cancelled',why:'cancelled before cast'});
      c.cast(spell.id,[]);cast=true;this._lastTrafficBlinkAt=Date.now();
      do {
        waited=await c.waitFor({since,kinds:['moved'],timeoutMs:Math.min(500,holdMs-(Date.now()-started))});
      } while(!cancelled() && !(waited?.events??[]).some(e=>e.kind==='moved') && Date.now()-started<holdMs);
      const at=c.self?{row:c.self.row,col:c.self.col}:null;
      const relocated=!cancelled() && (waited?.events??[]).some(e=>e.kind==='moved') && !!at
        && (at.row!==from.row || at.col!==from.col);
      const arrived=relocated && !!expect && at.row===expect.row && at.col===expect.col;
      return finish({cast,relocated,arrived,at,expect,room,ms:Date.now()-started,
        reason:cancelled()?'cancelled':arrived?'landed':relocated?'unexpected_landing':'no_displacement',
        why:arrived?'blinked to the room teleport point':'blink did not verify the expected relocation'});
    } catch(e) { return finish({cast,arrived:false,reason:'cast_error',why:e.message}); }
    finally {
      // Restore the pre-cast pause only while still owning this exact driver.
      if(this._blinkFreeze===freezeLease) {
        if(loop && this._tickLoop===loop)loop._frozen=frozen;
        this._blinkFreeze=null;
      }
    }
  }

  // WHERE THIS BODY HAS ACTUALLY BEEN DURING THIS CROSSING, and whether that is a walk.
  //
  // A STALL DETECTOR THAT ASKS "HAVE YOU STOPPED" CANNOT SEE THIS ONE. The commonest way to
  // get nowhere here is a two-square shuffle, which resets every stillness timer it meets
  // and keeps `ms_since_moved` honest and useless — the same trap already written down for
  // the keeper's own clock. So this counts GROUND COVERED instead: the last `WINDOW` squares
  // the body has occupied, and how many of them are distinct. Twenty-four moves that visited
  // four squares is an oscillation whatever the timers say, and it is exactly what the
  // Cragged Mountains produced (r15c29 <-> r15c30 for two minutes).
  //
  // Bounded, cheap, and reset per crossing in `leaveViaAny`.
  _noteCrossingSquare(row, col) {
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const fp = (this._crossingFootprint ??= []);
    const key = `${row},${col}`;
    this._crossingLastAt ??= Date.now();
    if (fp[fp.length - 1] === key) return;          // a repeat is not a move
    fp.push(key);
    this._crossingLastAt = Date.now();
    if (fp.length > CROSSING_WINDOW) fp.shift();
  }

  /**
   * Is this crossing going round in circles? `null` when there is not enough history to say.
   *
   * Returns the sentence that goes in the ledger, because "oscillating: true" is not
   * something an operator can check afterwards and "24 moves over 4 squares" is.
   */
  _crossingOscillation() {
    const fp = this._crossingFootprint ?? [];
    // PINNED IS THE OTHER WAY OF COVERING NO GROUND, and leaving it to "the stillness
    // detector" was a guess that the evidence did not support. Floyd sat on r9c14 in room
    // 567 for five minutes without moving one square, with mana to spare and a blink point
    // that opens 835 squares; Scooter did the same on r8c14 while firing 102 rail attempts
    // in six minutes. Neither is an oscillation, so neither got a `stalled` signal, so
    // neither was ever offered the spell — while Janice and Piggy, who happened to shuffle,
    // both got out. A body that has not changed square in a minute is not less stuck than
    // one bouncing between four; it is more.
    if (this._crossingLastAt && Date.now() - this._crossingLastAt >= CROSSING_PINNED_MS)
      return `pinned on ${fp[fp.length - 1] ?? 'one square'} for ` +
             `${Math.round((Date.now() - this._crossingLastAt) / 1000)}s`;
    if (fp.length < CROSSING_WINDOW) return null;
    const distinct = new Set(fp).size;
    if (distinct > CROSSING_DISTINCT) return null;
    return `${fp.length} moves over ${distinct} square(s)`;
  }

  /** How long this room crossing has been going, in ms. */
  _crossingMs() { return Date.now() - (this._crossingStartedAt ?? Date.now()); }

  // COORDINATE CONTRACT: every candidate follows leaveVia's named square/fine schema.
  async leaveViaAny(candidates, { movementGeneration = this.movementGeneration, controlToken,
                                  exact = false } = {}) {
    // WHEN THIS CROSSING BEGAN, because `stuck_ms` is the only thing standing between a
    // strategy and firing on every boundary that refuses once. Nothing set it, so the value
    // read below was always 0 and `min_stuck_ms` would have declined for ever -- a strategy
    // switched on, loaded, asked, and silently never firing, which is the failure mode this
    // repository has paid for before (`purpose` missing from a schema, every audit off).
    this._crossingStartedAt = Date.now();
    this._crossingFootprint = [];
    this._lastBlinkAskAt = 0;
    const tried = [];
    const skipped = [];
    let attempts = 0;
    // `tried` contains evidence about calls that happened. Keep candidates rejected by the
    // room-walk budget separate, and carry the actual invocation count on every result so a
    // caller never has to reconstruct it from a mixture of failures, successes and skips.
    const finish = result => ({ ...result, attempts,
      ...(skipped.length ? { skipped } : {}) });
    const refusal = (exit, result, extra = {}) => ({
      stand_on: exit?.stand_on,
      stage: result?.stage ?? null,
      crossing_packet_sent: result?.crossing_packet_sent ?? null,
      why: result?.reason || result?.note || 'no reason reported',
      ...extra,
    });
    // Captured before the first attempt, because a successful crossing changes the room out
    // from under us and the book has to be told which room the door was IN.
    const roomBefore = Number(this.world?.room?.num ?? this.client?.room?.id ?? NaN);
    const roomBeforeId = this.client?.room?.id ?? null;
    const roomStillCurrent = () => {
      if (roomBeforeId != null) return this.client?.room?.id === roomBeforeId;
      const roomNow = Number(this.world?.room?.num ?? NaN);
      if (Number.isFinite(roomBefore)) return Number.isFinite(roomNow) && roomNow === roomBefore;
      // Legacy/direct harness callers that never expose a room identity cannot be pinned;
      // preserve their old behavior. Once an identity was captured, unknown is not same.
      return true;
    };
    // A changed live identity is enough to stop old coordinates, but not enough to call a
    // hop successful: the room resource can blink for one observation. `travel` settles and
    // confirms the logical room before counting this as a crossing.
    const staleBatch = async (exit = null) => {
      let confirmed = false;
      if (typeof this.refreshRoomIdentity === 'function') {
        const refreshed = await this.refreshRoomIdentity().catch(() => null);
        confirmed = refreshed?.confirmed === true;
      } else {
        let room0 = Number(this.world?.room?.num ?? NaN);
        let roomId0 = this.client?.room?.id ?? null;
        let stable = 0;
        for (let sample = 0; sample < 3 && stable < 2; sample++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          const nextRoom = Number(this.world?.room?.num ?? NaN);
          const nextRoomId = this.client?.room?.id ?? null;
          if (nextRoom === room0 && nextRoomId === roomId0) stable++;
          else { room0 = nextRoom; roomId0 = nextRoomId; stable = 0; }
        }
        confirmed = stable >= 2;
      }
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return finish(this.cancelledMovement({ tried }));
      const room = Number(this.world?.room?.num ?? NaN);
      const common = {
        late: true,
        ...(exit ? { used_exit: exit } : {}),
        ...(tried.length ? { tried } : {}),
      };
      if (confirmed && Number.isFinite(roomBefore) && Number.isFinite(room) && room !== roomBefore)
        return finish({ ...common, left: true, confirmed_room_change: true,
          arrived_in: this.world?.room?.name ?? String(room),
          note: 'stopped before source-room recovery, then confirmed the logical crossing' });
      return finish({ ...common, left: false, room_changed: true,
        reason: 'room identity changed while source-room exit candidates were active',
        note: 'stopped before any further source-room recovery or exit coordinates were used' });
    };
    // HOW MANY FULL ROOM-WALKS ONE DOORWAY IS WORTH.
    //
    // Every candidate after the first is another walk across the room to another square on
    // the same wall, and in the big outdoor rooms that is minutes each. Measured over three
    // hours: the hops that cost 5-16 MINUTES are precisely the ones that worked through 5,
    // 6, 7, 13 and 14 squares, while a hop that takes its first or second square costs
    // seconds. Fourteen attempts never once found a square the first two did not.
    //
    // So a boundary gets a bounded number of tries and the journey then REPLANS — which is
    // the cheaper answer by a wide margin, because `travel`'s stumble already re-reads the
    // room and can pick a different way round entirely. This is a budget on how long to
    // insist, not a claim that the wall is shut: `spreadEdges` still offers every square,
    // ordering still puts the best first, and an explicitly enabled diagnostic fallback can
    // still be used to investigate a known model gap.
    const budget = Number(process.env.M59_EXIT_CANDIDATES || 3);
    let spent = 0;
    // A NEEDLE WANTS PATIENCE, NOT BREADTH — AND SPENDING BREADTH ON ONE IS HOW A FLEET
    // QUEUES AT A DOOR AND CALLS IT A WALL.
    //
    // The budget above buys tries at DIFFERENT squares on the same wall, and its whole
    // argument is that a refusal is usually local: something is standing there, so ask
    // somewhere else. That argument needs somewhere else to exist. Measured across the
    // world, 13 of 280 declared exits offer two or fewer distinct staging squares, and
    // Western border of the Twisted Wood's west door is one of them: three published
    // crossings, all staging on 5,2, spread over 32 fine units — half a square, one body
    // wide. Watched live, five runners sent through it took 35-124 seconds each, one never
    // made it, and every retry in the log reads `stand_on: {col:2,row:5}` because there is
    // no other square to name.
    //
    // Re-asking the same square three times is not three tries, it is one try repeated
    // instantly. So when the candidates collapse to a single staging square AND the
    // refusal was a BODY rather than geometry, wait and ask again — the same distinction
    // `walkTo` already makes about `object_blocked`: a monster moves and a wall does not.
    // Bounded, because a door held by something that never moves must still end the walk
    // and let `travel` route round.
    const narrowWaits = Number(process.env.M59_NARROW_WAITS || 3);
    const narrowWaitMs = Number(process.env.M59_NARROW_WAIT_MS || 1200);
    // Far enough that a chasing monster has to come out of the gap to follow, short enough
    // that the re-approach is a few seconds rather than a second crossing of the room.
    const narrowBackoffCrumbs = Number(process.env.M59_NARROW_BACKOFF_CRUMBS || 4);
    // THE BAKED ANCHOR IS THE DOORWAY; THE EDGE SCAN IS A GUESS ABOUT WHERE ONE MIGHT BE.
    //
    // `exits()` publishes crossing squares by walking the room's declared edge openings, and
    // for Ukgoth's north edge it offers 1,62 / 1,63 / 1,64 / 1,66 and never 1,27. The route
    // bake, which planned a path somebody can walk, says the anchor for room 2 IS 1,27 — and
    // `substrate/m59-falljumps.json` wrote down why a year of this went wrong:
    //
    //   "The ONLY doorway to Outside Castle Victoria is at row 1, col 27, on the cliff top
    //    this reaches; the eastern crossing the router used instead (row 1, col 62) goes
    //    through solid rock."
    //
    // So the fleet crossed the whole room — 'followed 37 of 38' eighteen times, jump and all —
    // and then walked thirty-five columns east to try a wall. Measured over an hour: 599 -> 2
    // failed 15 times out of 15, every one of them 'every square for that exit refused', and
    // the four squares tried were 1,62 / 1,63 / 1,64 / 1,66. Never the door.
    //
    // The anchor goes in front. It is not a replacement — the scanned squares stay as
    // fallbacks, because a stale bake should degrade rather than strand anybody — but a
    // square the bake proved walkable is a better first guess than a square the edge scan
    // merely found floor on.
    const spread = spreadEdges(candidates);
    // SAY WHY, WHEN IT DOES NOT HAPPEN. Two attempts at this fix looked applied and were not —
    // the injection ran and the transit log still showed the same four eastern squares — so
    // the reasons are named out loud rather than inferred from a count that did not move.
    // WHEN THE CALLER PICKED THE DOORS ON PURPOSE, DO NOT PICK DIFFERENT ONES.
    //
    // Everything below this line exists to WIDEN a boundary: spreadEdges offers every
    // square that crosses it, and the anchor is unshifted to the front because the bake
    // planned a walkable line to it and a scanned square only has floor on it. Both are
    // right when the question is "get me through that wall" and the crossings are
    // alternatives.
    //
    // They are not alternatives when the destination is SPLIT, and then this widening is
    // the bug. Measured on prod 2026-08-27: `crossSameRoomIsland` filtered room 38's four
    // doors down to the TWO that land on the quarry's island (23,8) — and the baked anchor
    // for 38 -> 39 is door (19,2), which lands on the OTHER one (28,8). `orderExits` ranks
    // `from_anchor` above everything, so the anchor won, the character crossed by the wrong
    // door, and the keeper reported "returned to the room, but not to the quarry's connected
    // side" — a perfect round trip back to where it started. Three of six characters did
    // that in one window; the whole group killed nothing all night.
    //
    // So `exact` narrows the spread back to the squares the caller actually named and skips
    // the anchor injection entirely. IT NARROWS ONLY WHEN SOMETHING SURVIVES: an empty
    // result means the published exits and the caller's list disagree, and crossing by the
    // wrong door beats standing at a boundary refusing to cross at all — the same argument
    // the door-choice in `travel` makes.
    const exactSquares = exact
      ? new Set((candidates || []).filter(e => e?.stand_on)
          .map(e => `${e.stand_on.col},${e.stand_on.row}`))
      : null;
    if (exactSquares?.size) {
      const kept = spread.filter(e => e.stand_on &&
        exactSquares.has(`${e.stand_on.col},${e.stand_on.row}`));
      if (kept.length) { spread.length = 0; spread.push(...kept); }
    }
    const anchorTrace = [];
    for (const e of (exact ? [] : (candidates || []))) {
      if (e?.to == null) { anchorTrace.push('candidate with no `to`'); continue; }
      let anchor = null, why = null;
      try {
        const table = activeRoutes();
        const from = Number(this.world?.room?.num);
        if (!table) why = 'no routing table loaded';
        else if (!Number.isFinite(from)) why = `current room unknown (${this.world?.room?.num})`;
        else {
          anchor = anchorFor(table, from, Number(e.to));
          if (!anchor) why = `no baked anchor ${from} -> ${e.to}`;
        }
      } catch (err) { why = `anchorFor threw: ${err.message}`; }
      if (!anchor || anchor.row == null) { anchorTrace.push(why ?? `anchor had no row for ${e.to}`); continue; }
      const already = spread.some(x => Number(x.to) === Number(e.to) &&
                                       x.stand_on?.row === anchor.row && x.stand_on?.col === anchor.col);
      if (already) continue;
      const me = this.client?.self;
      spread.unshift({ ...e, stand_on: { col: anchor.col, row: anchor.row },
                       steps_away: me ? Math.max(Math.abs(anchor.row - me.row), Math.abs(anchor.col - me.col)) : 0,
                       alternates: undefined, from_anchor: true });
      anchorTrace.push(`injected ${anchor.row},${anchor.col} for ${e.to} [row,col; r${anchor.row}c${anchor.col}]`);
    }
    if (process.env.M59_EXIT_DEBUG !== '0' && anchorTrace.length)
      console.error(`[exit] room ${this.world?.room?.num}: ${anchorTrace.join('; ')}`);
    const stagingSquares = new Set(spread.map(e => `${e.stand_on?.col},${e.stand_on?.row}`));
    const isNeedle = stagingSquares.size <= 1 && spread.length > 0;
    let waited = 0;
    // ONE RE-CENTRE PER SQUARE, AND A CAP FOR THE WHOLE BOUNDARY. See the branch that uses
    // these: a geometry refusal before the crossing packet is sent is usually the body
    // standing off-centre, which is worth correcting once and is not worth insisting on.
    const recentred = new Set();
    let recentres = 0;
    const edgeRecentres = Number(process.env.M59_EDGE_RECENTRES || 2);
    // A cycling door is worth a handful of asks; a room whose geometry really has changed
    // is not. Both bounds matter — the count stops the loop, the per-wait cap stops one ask
    // swallowing the whole errand.
    let animationWaits = 0;
    const ANIMATION_MAX_WAITS = Number(process.env.M59_ANIMATION_WAITS || 6);
    const ANIMATION_WAIT_MS = Number(process.env.M59_ANIMATION_WAIT_MS || 2500);
    // spreadEdges turns each declared edge into one candidate per square that crosses
    // that boundary — see m59-world.mjs. Without it this tried the nearest square and
    // called the whole wall refused.
    // Indexed rather than for-of, so the needle wait below can ask the SAME candidate
    // again. `continue` in a for-of advances to the next one, which is not a retry — and
    // on a needle publishing a single square there is no next one, so the wait would have
    // been a no-op in exactly the case it exists for.
    //
    // AND ONE SQUARE PER PLACE AT THE HEAD OF IT, so the bounded budget below buys three
    // different squares rather than one square asked three times. See distinctStagesFirst
    // for the measurement; the duplicates are moved to the tail, not removed, so nothing
    // that was reachable before is unreachable now.
    const ordered = distinctStagesFirst(orderExits(spread));
    for (let index = 0; index < ordered.length; index++) {
      const exit = ordered[index];
      if (spent >= budget) {
        skipped.push({ stand_on: exit.stand_on,
                       why: `not tried — this boundary had already cost ${budget} walks across the room` });
        break;
      }
      spent++;
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return finish(this.cancelledMovement({ tried }));
      if (!roomStillCurrent()) return staleBatch(exit);
      const askedAt = Date.now();
      attempts++;
      const r = await this.leaveVia(exit, { movementGeneration, controlToken,
                                            expectedRoomId: roomBeforeId });
      if (r?.cancelled || this.movementWasCancelled(movementGeneration, controlToken))
        return finish(this.cancelledMovement({ tried }));

      // WE ARE THROUGH. STOP. DO NOT RUN A RECOVERY.
      //
      // Every tactic below exists to get an unstuck walk moving again, and every one of
      // them is movement — a retreat, a wait, another approach. Run after the crossing has
      // ALREADY happened, they are movement in the wrong room, and the character is
      // standing a step from the boundary it just came through, so the cheapest of them
      // walks it straight back. Watched live: a subject wiggled its way through the
      // entrance to The Flatlands, kept wiggling because nothing told it to stop, and
      // zoned back into Main gate to Cor Noth — undoing the only thing that had worked.
      //
      // THE ROOM IS THE AUTHORITY, NOT `r.left`. `leaveVia` reports what its own last move
      // saw, and a transition that lands a beat late reads as a refusal; asking the session
      // which room it is in cannot be late in that way, because the server pushed it. So
      // the check is against the room we started in, and it runs before anything else can
      // move the character.
      if (!r.left && (r.room_changed || !roomStillCurrent())) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                       tactic: 'needle_backoff', trigger: 'door_refused', worked: false,
                       ms: Date.now() - askedAt,
                       note: 'the room identity changed while the crossing reported failure — ' +
                             'stopped; the caller must confirm where it landed' });
        return staleBatch(exit);
      }
      if (r.left) {
        // THE DOOR HAS NOT MOVED, SO IT SHOULD BE WRITTEN DOWN — AND THIS IS NOT YET THE
        // PLACE THAT CAN DO IT HONESTLY.
        //
        // `exits()` already ranks a square somebody was OBSERVED crossing at above every
        // derived candidate, and nothing but a human's proxy walk log has ever written to
        // that book — so the fleet crosses these boundaries hundreds of times a day and
        // re-derives the door on every one of them. Recording its own successes is exactly
        // the right idea.
        //
        // The first attempt at it was WRONG and is left here as a warning rather than as
        // code. Recording at this point produced pairs like `574>574` and `587>587`, and a
        // square of 115,88 in a room that is 55x67 — the ARRIVAL coordinate in the room we
        // had just entered. By the time a crossing has succeeded, both the room and the
        // position have moved on, so this site can see neither the door it used nor the
        // side it used it from. Being wrong here is not a wasted walk: the learned book is
        // merged into the operator's observed evidence and OUTRANKS every derived
        // candidate, so a fictitious door would be preferred over the real one for ever.
        //
        // What it needs is the room and the crossing square captured BEFORE the move, by
        // the code that actually sends it — `leaveVia` — and confirmed against the room we
        // land in, which is the same discipline `m59-crossings.json` already applies to the
        // operator's logs. Until then the fleet re-derives, which is slow and correct.
        if (tried.length)
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore ?? null,
                         tactic: 'needle_backoff', trigger: 'door_refused', worked: true,
                         ms: Date.now() - askedAt,
                         note: `crossed on attempt ${attempts}` });
        return finish({ ...r, used_exit: exit, stood_on: this.lastExitStand ?? null,
                        ...(tried.length ? { tried } : {}) });
      }
      // AN ANIMATING DOOR IS A TEMPORARY OBSTACLE WEARING A TERMINAL REASON'S CLOTHES.
      //
      // `collision_geometry_changed` is on the terminal list for a good reason: the room's
      // geometry moved, we cannot mutate our BSP the way the stock client does, and a
      // refusal that loops is how a bad route gets learned. But the thing that fires it
      // most is a DOOR, and a door opens again — the Temple of Qor's lives in room 598 and
      // cycles faster than the 8s invalidation window, which is why it sits exactly on the
      // Cragged Mountains -> Ukgoth crossing on the road to Castle Victoria. Measured
      // there: seven refusals in thirty-five seconds and the Tos -> Castle Victoria leg
      // never once completed, 0 of 3 in a grand tour.
      //
      // Abandoning the boundary is the worst response available, because the next attempt
      // walks the whole room again and arrives at a fresh random phase of the same cycle.
      // Standing at the door and asking again costs nothing and is what a person does.
      // Bounded in tries AND in total time, so a genuine geometry change — the case the
      // terminal list is really for — still ends the walk rather than pinning a character
      // at a wall for ever.
      if (r.reason === 'collision_geometry_changed' && animationWaits < ANIMATION_MAX_WAITS) {
        animationWaits++; spent--;
        const gap = Number.isFinite(r.animation?.expires_in_ms)
          ? Math.min(ANIMATION_WAIT_MS, Math.max(250, r.animation.expires_in_ms + 250))
          : ANIMATION_WAIT_MS;
        tried.push(refusal(exit, r, {
          waited_for_the_animation_ms: gap,
          ...(r.animation ? { animation: r.animation } : {}),
          note: `a live animation holds this doorway — waiting at it rather than ` +
                `walking the room again (${animationWaits}/${ANIMATION_MAX_WAITS})`,
        }));
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                       tactic: 'animation_wait', trigger: 'door_refused', worked: false,
                       ms: gap, note: r.animation?.sector != null
                         ? `sector ${r.animation.sector}` : 'whole room refused' });
        await new Promise(resolve => setTimeout(resolve, gap));
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return finish(this.cancelledMovement({ tried }));
        if (!roomStillCurrent()) return staleBatch(exit);
        index--;                        // the same door, one cycle later
        continue;
      }
      if (isTerminalMovementReason(r.reason)) {
        tried.push(refusal(exit, r));
        return finish({ ...r, left: false, used_exit: exit, tried });
      }
      // A GEOMETRY REFUSAL AT A DOORWAY IS USUALLY THE BODY IN THE WRONG PART OF ITS OWN
      // SQUARE, AND THAT IS NOT A REASON TO GIVE THE SQUARE UP.
      //
      // This is the same finding `followRail` already acts on — "geometry_blocked from a
      // square the bake calls walkable means the BODY is in the wrong part of its own
      // square, not that the line is wrong" — where adding `recentreInSquare` cut room
      // 586's geometry refusals. The crossing path never learned it, and the crossing is
      // where it matters most, because a refused hop is not a skipped waypoint: it deletes
      // the edge from the journey's route for the rest of the journey.
      //
      // THE EVIDENCE THAT THIS IS POSITION AND NOT A WALL. Outskirts of Barloque -> Main
      // gate of Barloque refuses `geometry_blocked` with `crossing_packet_sent: false` —
      // the outward packet was never even sent — and yet the same boundary carries 431
      // successful crossings against 395 failures. A wall does not pass 52% of the time.
      // What varies between the two is where in the square the body came to rest, which is
      // exactly what this puts right, and it costs at most three fine steps.
      //
      // IT DOES NOT CONSUME THE BUDGET, for the same reason the needle wait does not: the
      // budget counts walks across the room to DIFFERENT squares, and this is the same
      // square with the body standing properly on it. Bounded twice over — once per
      // candidate, and a cap for the whole crossing — because a square that will not take
      // a crossing from its own centre is genuinely refusing, and the caller has a wall to
      // route around rather than a pose to correct.
      const reapproachable = r.crossing_packet_sent !== true
        && (r.reason === 'geometry_blocked' || r.reason === 'not_at_edge_opening');
      if (reapproachable && recentres < edgeRecentres && !recentred.has(index)
          && typeof this.recentreInSquare === 'function') {
        recentred.add(index);
        const centreRefusal = refusal(exit, r, {
          note: `refused before the crossing packet was sent — re-centring in the square and ` +
                `asking the same square again (${recentres + 1}/${edgeRecentres})`,
        });
        tried.push(centreRefusal);
        recentres++; spent--;
        if (!roomStillCurrent()) return staleBatch(exit);
        const centred = await this.recentreInSquare().catch(() => false);
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return finish(this.cancelledMovement({ tried }));
        if (!roomStillCurrent()) return staleBatch(exit);
        centreRefusal.recentred = !!centred;
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                       tactic: 'edge_recentre', trigger: 'door_refused',
                       // Not known to have worked yet — the NEXT attempt says that. A tactic
                       // that reports its own success is the failure the ledger exists to
                       // make visible; see the needle backoff above.
                       worked: false, ms: Date.now() - askedAt, hp_lost: 0,
                       note: `${r.reason} at r${exit.stand_on?.row}c${exit.stand_on?.col}; ` +
                             (centred ? 're-centred' : 'could not re-centre') });
        // A re-centre that moved nothing has not changed the question, so do not ask it
        // again — fall through to the next candidate with the budget slot restored.
        if (!centred) { spent++; continue; }
        index--;                        // the same square, standing properly on it
        continue;
      }
      // BLOCKED BY A BODY AT A ONE-SQUARE DOOR: the next candidate is this candidate, so
      // waiting is the only thing that can change the answer. It does not consume the
      // budget, because it is not another square — it is the same square, later.
      const bodyBlocked = (r.monster_blocked ?? 0) > 0
        || (Array.isArray(r.blocked_by_bodies_at) && r.blocked_by_bodies_at.length > 0)
        || r.reason === 'object_blocked';
      if (isNeedle && bodyBlocked && waited < narrowWaits) {
        const bodyRefusal = refusal(exit, r, {
          waited_for_the_doorway_ms: narrowWaitMs,
          note: `one-square doorway held by a body — waiting rather than asking the same square again (${waited + 1}/${narrowWaits})`,
          ...(r.monster_blocked ? { monster_blocked: r.monster_blocked } : {}),
          ...(r.damage_while_blocked ? { damage_while_blocked: r.damage_while_blocked } : {}),
        });
        tried.push(bodyRefusal);
        // A CHARACTER BEING HIT IN A DOORWAY DOES NOT STAND THERE COUNTING. The whole
        // reason to wait is that the blocker is expected to wander off; taking damage says
        // it has noticed us instead, and this repository has already paid for confusing
        // those two — see the note on `object_blocked` in walkTo.
        // BACK UP, SO THE THING IN THE WAY FOLLOWS AND LEAVES THE DOORWAY.
        //
        // Standing at a one-body door waiting for a monster to wander off is the wrong
        // model of a monster: it is not wandering, it is coming for us, and coming for us
        // is exactly what makes it useful. A monster that chases vacates the choke point,
        // and the door we could not squeeze past is then open. That is the ordinary way a
        // person plays this — pull the blocker off the gap and go round it — and it is
        // strictly better than the wait, which asks the same question with the same body
        // in the same square.
        //
        // Retreat along BREADCRUMBS rather than picking a direction. Every crumb was
        // authorised by the fine validator on the way in, so backing up cannot invent a
        // traversal — it can only undo one — which matters here more than anywhere else,
        // because the squares behind a needle are the tight ones. See the breadcrumb note
        // in walkTo for why a coarse-grid escape hatch was rejected for this job.
        //
        // Still bounded, and still NOT done while we are being hit: a blocker that is
        // already swinging is not going to be pulled anywhere, and the character needs to
        // leave rather than to keep dancing at the gap. That is the one case where giving
        // up quickly is the survival answer, and it is the case that kills characters in
        // the Western border of the Twisted Wood.
        if (r.damage_while_blocked) {
          bodyRefusal.note = 'one-square doorway, and we are being hit in it — not waiting';
        } else {
          waited++; spent--;
          if (!roomStillCurrent()) return staleBatch(exit);
          const backed = await this.retreatAlongBreadcrumbs(
            { maxCrumbs: narrowBackoffCrumbs, movementGeneration, controlToken }).catch(() => null);
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return finish(this.cancelledMovement({ tried }));
          if (backed?.room_changed || !roomStillCurrent()) return staleBatch(exit);
          bodyRefusal.backed_off = backed?.steps ?? 0;
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                         tactic: 'needle_backoff', trigger: 'body_blocked',
                         // Not known to have worked yet — the NEXT attempt says that, and a
                         // tactic that reports its own success is the failure this ledger
                         // exists to make visible.
                         worked: false, ms: narrowWaitMs,
                         hp_lost: r.damage_while_blocked ?? 0,
                         note: `backed off ${backed?.steps ?? 0} crumb(s)` });
          await new Promise(resolve => setTimeout(resolve, narrowWaitMs));
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return finish(this.cancelledMovement({ tried }));
          if (!roomStillCurrent()) return staleBatch(exit);
          index--;                      // the same square, later — that is the whole point
          continue;
        }
        // This call is already represented by bodyRefusal. Move to the next candidate
        // without appending the same failure a second time below.
        continue;
      }
      tried.push(refusal(exit, r));
    }
    // EVERY SQUARE REFUSED. Normal travel reports the refusal and replans. An operator may
    // explicitly enable the unvalidated diagnostic below to test a known model gap, but
    // nothing inferred from an ordinary refusal grants that movement authority.
    // A BODY IS NOT A GAP IN THE MODEL, SO IT DOES NOT EARN THE UNVALIDATED STEP.
    //
    // The explicit diagnostic override exists for one situation: our collision model refuses
    // a square that people demonstrably walk on, so the model is wrong and the door is real.
    // Every word of that argument is about GEOMETRY.
    //
    // It said nothing about bodies, and `object_blocked` is not terminal — so a doorway held
    // by players refused every attempted square, fell through here, and forced a crossing anyway. That
    // is walking through a person: the one thing the whole collision subsystem exists to
    // stop, arriving through the door reserved for admitting the subsystem is wrong.
    //
    // And it is not even the same bet. A wall the model invented will be there next time; a
    // body will not. The honest answer to a door full of people is that the crossing cannot
    // be made right now, which sends the journey to the OTHER door — or, if that is held
    // too, reports a refusal the caller can act on.
    //
    // Found by the operator's own negative case: four characters shoulder to shoulder across
    // a doorway, and the test asked what happens when both ways in are shut.
    const everyRefusalWasABody = tried.length > 0 &&
      tried.every(t => /object_blocked|body_blocked/i.test(String(t.why ?? '')));
    if (everyRefusalWasABody)
      return finish({ left: false, tried, blocked_by_bodies: true,
                      reason: 'object_blocked',
                      note: 'every attempted square on this boundary had somebody standing on it. Not using ' +
                            'the explicit diagnostic override: a person is not a hole in the map' });
    if (tried.length && process.env.M59_EXIT_FALLBACK === '1') {
      const best = ordered[0] ?? null;
      if (best) {
        if (!roomStillCurrent()) return staleBatch(best);
        attempts++;
        const forced = await this.leaveViaUnvalidated(best, { movementGeneration, controlToken });
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return finish(this.cancelledMovement({ tried }));
        if (!forced.left && !roomStillCurrent()) return staleBatch(best);
        if (forced.left) return finish({ ...forced, used_exit: best, fallback: true, tried });
        tried.push(refusal(best, forced, { fallback: true }));
      }
    }
    // LAST, AND ONLY WITH SOMETHING PRIVATE LOADED. Every ordinary answer has now been
    // tried: each candidate square, the queue behind a player, the fine lane past a body,
    // the sidestep, the retreat. This is the moment the crossing is about to be reported
    // shut, and it is the only honest place to ask a strategy whether it has one more idea.
    //
    // A CLONE HAS NO STRATEGIES AND THEREFORE NO CHANGE IN BEHAVIOUR. `m59-strategies.load`
    // returns an empty set when substrate/strategies/ does not exist, `firstAnswer` returns
    // null, and the return below runs exactly as it did before. Silence is the behaviour
    // that was already there.
    // DECLARED HERE, NOT BORROWED FROM BELOW. `offered` is defined further down as part of
    // the gap report, and reaching forward to it threw `Cannot access 'offered' before
    // initialization` -- the same shape as the `laneAim` crash that killed a character in
    // prod, caught this time by the dependency suite rather than by a death.
    const bestExit = ordered[0] ?? null;
    // Guarded like `_blockingBodies` below: `leaveViaAny` is lifted out of this class and run
    // against hand-built sessions by m59-collision-test.mjs.
    const crossingMs = typeof this._crossingMs === 'function' ? this._crossingMs() : 0;
    const crossingLoop = typeof this._crossingOscillation === 'function'
      ? this._crossingOscillation() : null;
    const stuckAnswer = await this._askStrategies('whenStuck', {
      room: this.world?.room ?? null,
      geo: this.world?.geometry ?? null,
      self: this.client?.self ?? null,
      goal: bestExit?.stand_on ?? null,
      route: tried.map(t => t.stand_on).filter(Boolean),
      bodies: this._blockingBodies(),
      blink: this._blinkPointHere(),
      vitals: this.client?.vitals?.() ?? null,
      stuck_ms: crossingMs,
      underFire: !!this._underFireDuringCrossing,
      agent: this.name ?? this.client?.me?.name ?? null,
      // The same two signals the walker's ask carries. Reaching the give-up at all means the
      // boundary refused every candidate, so this is usually already past the stall clock —
      // but it is passed rather than assumed, because a first-try refusal reaches here too.
      crossing_ms: crossingMs, oscillating: crossingLoop,
      stalled: crossingMs >= CROSSING_STALL_MS && crossingLoop
        ? `${Math.round(crossingMs / 1000)}s in this room, ${crossingLoop}` : null,
    }).catch(() => null);
    if (this.movementWasCancelled(movementGeneration, controlToken))
      return finish(this.cancelledMovement({ tried }));
    if (!roomStillCurrent()) return staleBatch(bestExit);
    if (stuckAnswer?.answer?.do === 'blink') {
      // A WALL BEFORE THE CAST, WHEN THE ANSWER ASKS FOR ONE. `need_safe_spot` was in every
      // strategy's answer and nothing ever read it, so a character being hit was either
      // refused outright or asked to stand still for ten seconds in the open. A safe wall is
      // a square nothing attacks until you attack first: take one, then cast from it. If no
      // wall can be taken, there is no cast — the ledger says so rather than the Underworld.
      let wall = null;
      if (stuckAnswer.answer.need_safe_spot) {
        const pilot = autopilotIfAny(this.name);
        wall = pilot && typeof pilot.takeSafeSpot === 'function'
          ? await pilot.takeSafeSpot('a wall to blink from', null, { source: 'travel' })
                       .catch(e => ({ took: false, why: e.message }))
          : { took: false, why: 'no autopilot to take a wall with' };
      }
      // The wall may have been the EXIT (see takeSafeSpot): then we are in another room and
      // there is nothing to cast for; the room-changed guard below reports it.
      const tookTheExit = !!(wall?.via === 'exit' || wall?.crossed);
      // THE SAME RULE AS THE WALKER'S SITE, AND IT HAD TO BE SAID TWICE BECAUSE THERE ARE
      // TWO OF THEM. This give-up fires when every candidate on a boundary has been refused,
      // and on the day the wall-less cast shipped it was still gating on a wall — so Animal
      // sat in room 567's 17-square pocket writing `no wall (nothing in this room is more
      // defensible)` every forty seconds, while Kermit, whose walk went through the walker's
      // site, blinked out and reached Castle Victoria. A wall is preparation, not permission.
      //
      // TAKING THE EXIT IS STILL A REASON NOT TO CAST, and the only one left: we are in
      // another room and there is nothing to cast for.
      let evaded = null;
      if (!tookTheExit && !wall?.took && this._underFireDuringCrossing &&
          typeof this.retreatAlongBreadcrumbs === 'function') {
        const deadline = Date.now() + BLINK_EVADE_MS;
        evaded = await this.retreatAlongBreadcrumbs({
          maxCrumbs: Number(process.env.M59_BLINK_EVADE_CRUMBS || 4),
          until: () => Date.now() >= deadline,
          movementGeneration, controlToken,
        }).catch(() => null);
      }
      let rested = null;
      if (!tookTheExit && wall?.took && (stuckAnswer.answer.rest_to_vigor || stuckAnswer.answer.rest_to_mana)) {
        const pilot = autopilotIfAny(this.name);
        rested = pilot && typeof pilot.restBeforeBlink === 'function'
          ? await pilot.restBeforeBlink('vigor and mana before a blink out of a stalled crossing',
                                        { mana: Number(stuckAnswer.answer.rest_to_mana ?? 0) })
                       .catch(e => ({ rested: false, why: e.message }))
          : { rested: false, why: 'no autopilot to rest with' };
      }
      const out = !tookTheExit
        ? await this.blinkOut({ expect: stuckAnswer.answer.expect, movementGeneration, controlToken }).catch(() => null)
        : { cast: false, arrived: false, why: 'did not cast: the nearest wall was the exit and it was taken' };
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return finish(this.cancelledMovement({ tried }));
      if (!roomStillCurrent()) return staleBatch(bestExit);
      recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                     room: Number(this.world?.room?.num ?? 0),
                     tactic: 'blink_escape', trigger: stuckAnswer.strategy,
                     worked: !!out?.arrived, ms: out?.ms??0, hp_lost: 0, attempted: !!out?.cast,
                     note: `${stuckAnswer.answer.why}; ` +
                           (stuckAnswer.answer.need_safe_spot
                              ? (wall?.took ? 'took a wall first; '
                                 : `no wall (${wall?.why ?? '?'}) — casting anyway; `) : '') +
                           (evaded ? `backed off ${evaded.steps ?? 0} crumb(s) first; ` : '') +
                           (rested ? (rested.rested ? 'rested to the cap first; '
                                                    : `did not rest (${rested.why ?? '?'}); `) : '') +
                           `${out?.why ?? 'no result'}` });
      // E, AND IT IS THE STRATEGY'S OWN CALLBACK. The predicate recorded what it saw; only
      // the caller knows what happened next, and 'the spell never fizzles' is not the same
      // claim as 'the character is now unstuck'.
      try { stuckAnswer.answer.settled?.(!!out?.arrived, out?.why ?? null, out?.at ?? null); }
      catch { /* the record is evidence, not a dependency */ }
      if (out?.arrived) {
        // One more go at the SAME boundary from where we now stand. Not a recursion into
        // leaveViaAny -- that would re-ask the strategy from the new position and could
        // blink twice -- just the best candidate, once.
        if (bestExit) attempts++;
        const again = bestExit ? await this.leaveVia(bestExit, { movementGeneration, controlToken,
                                                                  expectedRoomId: roomBeforeId })
                               : null;
        if (again?.cancelled || this.movementWasCancelled(movementGeneration, controlToken))
          return finish(this.cancelledMovement({ tried }));
        if (again && !again.left && (again.room_changed || !roomStillCurrent()))
          return staleBatch(bestExit);
        if (again?.left)
          return finish({ ...again, used_exit: bestExit, after_blink: true, tried });
        if (again) tried.push(refusal(bestExit, again, { after_blink: true }));
      }
    }
    // THE EVIDENCE FOR A GAP REPORT, carried out rather than filed here. What makes a
    // refusal actionable is not that it happened but WHAT THE MODEL BELIEVED — the best
    // square it could offer — so that it can be set against the square a character is
    // standing on when the same door works. See m59-exitgap.mjs.
    const last = tried[tried.length - 1];
    const offered = ordered[0] ?? null;
    return finish({ left: false, outcome: 'exit_candidates_exhausted', tried,
                    gap: { believed: offered?.stand_on
                             ? { col: offered.stand_on.col, row: offered.stand_on.row } : null,
                           direction: offered?.direction ?? candidates?.[0]?.direction ?? null,
                           offered: attempts,
                           ...(skipped.length ? { skipped: skipped.length } : {}) },
                    reason: attempts > 1
                      ? `every square for that exit refused (${attempts} tried)`
                      : (last ? last.why : 'no exit to try') });
  }
  }

  return SessionWalk.prototype;
}
