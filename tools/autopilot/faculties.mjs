// FACULTIES AND COMMITMENTS: inert and travelling postures, the travel guard, busy, leases.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 23 methods: goInert, revive, goTravelling, travelGuard, travelAllows, get travelling, who,
//   noteToughness, commitment, heldStatus, declareBusy, freeBusy, busyStatus, releaseCommitment,
//   inertStatus, static FACULTIES, static PROTECTED_FACULTIES, facultyOwner, facultyHeld,
//   claimFaculties, releaseFaculties, heartbeatFaculties, facultyStatus
import { describeCommitment } from '../m59-commitment.mjs';
import { claimantOrigin, keeperOrigin, liveMoveOrder } from '../m59-move-origin.mjs';
import * as party from '../m59-party.mjs';
import { recordShelterRun } from '../m59-shelter.mjs';
import * as skills from '../m59-skills.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision, finishSurvivalDecision, updateSurvivalDecision } from '../m59-survival-decision.mjs';
import { traceSurvival } from '../m59-survival-trace.mjs';
import * as uptime from '../m59-uptime.mjs';
import { Autopilot, BUSY_MAX_MS, INERT_MAX_MS, REST_VIGOR_CAP, TRAVEL_GUARD_CLOCK, TRAVEL_GUARD_DEFAULTS, TRAVEL_GUARD_KEYS, vigorPct } from '../m59-autopilot.mjs';

export class FacultiesPart {
  // @part 1

  // STOPPING IS NOT INSTANT, AND STARTING HAS TO KNOW THAT.
  //
  // stop() only sets a flag; the loop notices it when the pass it is in finishes,
  // which can be most of a minute later if that pass is walking across the world. So
  // the ordinary "stop it, move it, start it again" sequence lands its start while
  // the old loop is still winding down — and the old code took `running` at face
  // value, returned "already running", and was then switched off by the very loop it
  // had just declined to replace. The keeper reported itself started and did nothing
  // for ever after, which is exactly the silent stall the rest of this file exists to
  // prevent. Three characters were sitting in it before it was noticed.
  //
  // Cancelling the pending stop is the whole fix; loop() re-checks the flag on its way
  // out so a cancellation lands even at the last moment.
  // INERT: STILL WATCHING, JUST NOT ACTING.
  //
  // Almost every "stop the keeper" in this repository does not want the keeper gone. It
  // wants the keeper to stop DRIVING, because something else is about to — an errand
  // walking the character to a smith, a supply trade, a person taking the controls. Only
  // one thing may drive a character at a time, and that is the whole requirement.
  //
  // Stopping is a very expensive way to get it. A stopped keeper writes no frames, runs
  // no observe(), records no death and files no post-mortem — so the character keeps
  // playing and the instruments go dark, which is precisely when we most want them. It is
  // why the post-mortem carries `during_keeper_outage` at all: deaths kept happening in
  // exactly the windows we had chosen to stop looking. Three of the last fourteen death
  // records died inside one, one of them 794 seconds in, and the field exists because
  // there was nothing else to say about them.
  //
  // Inert is the same non-interference with the instruments left on. The loop keeps
  // running, so noteWhere, declareInterest, the partner register, observe(), recordFrame()
  // and the death record all keep working; everything from the first branch that would
  // MOVE, SWING, SPEAK, TRADE or CAST is skipped.
  //
  // THE ONE EXEMPTION IS DEATH, and it is not a compromise. A character in the Underworld
  // has no exits, cannot be observed and cannot be recorded — a corpse produces no
  // telemetry at all — so escaping is what makes the rest of this state worth having.
  // Whatever errand was driving has already failed by then; its travel calls are the
  // thing reporting so.
  //
  // AND IT HAS A DEADLINE, because an errand that crashes between goInert and revive
  // would otherwise leave a character watching itself for the rest of the session. Every
  // caller here restores explicitly; the deadline is for the ones that do not get to.
  // `by` IS NOT DECORATION. A keeper made inert shows up on every board as a `driven`
  // commitment, and every rule in the fleet steps over one — so an inert keeper nobody can
  // account for is 21 characters standing down with no way to tell whether the thing driving
  // them still exists. That happened: an accidental `import` of m59-allhands ran its muster,
  // made all 21 inert, and ended. The commitment then read `since: null` with no owner, a
  // peer session spent an investigation proving no such process was running, and the fleet
  // did not eat while it lasted.
  //
  // The 15-minute cap always bounded it. What was missing was the ability to ask "is this
  // still real" without waiting the cap out.
  goInert(why = null, { maxMs = INERT_MAX_MS, by = null } = {}) {
    this.clearSurvivalJam('inert handoff');
    if (this.inert) return this.inertStatus();
    this.inert = { why, at: Date.now(), maxMs, by };
    // Everything learned about which squares hold, in case the process goes away while
    // we are in this state. Same reason stop() does it.
    // The ledger gets it too, so a death in this window is attributable. Deliberately a
    // DIFFERENT event from 'stop': the whole point is that this outage is not one.
    uptime.record(this.s.name, 'inert', { why, room: this.s.world?.room?.num ?? null });
    this.note('going inert', {
      why, what_happens: 'the keeper keeps looking and keeps recording — frames, ' +
        'observations, the death record — and stops moving, swinging, speaking and trading. ' +
        'Something else is driving now',
      until: 'revive(), start(), or ' + Math.round(maxMs / 60_000) + ' minutes, whichever is first' });
    return this.inertStatus();
  }

  revive(why = null) {
    // The journey is over, so the route it was diverting along is too. Left set, this would
    // offer a stop on somebody else's walk — an errand, a fight, a shopping trip — none of
    // which have a route ahead to fold one into.
    this.s.shelterPolicy = null;
    // And the stops that were worked out for it. A finished journey's fuel plan describes a
    // route nobody is on any more; left set, the mid-hop wall rung would offer a stop from
    // the last crossing on the next one.
    // A survival suspension still needs the forward refuges from this crossing.
    // Ordinary completion retires them; recovery consumes them on the next pass.
    if (!this.suspendedJourney && !this.wantsForwardShelter) this.s.activeShelter = null;
    if (!this.inert) return null;
    const held = Date.now() - this.inert.at;
    const wasTravelling = !!this.inert.travelling;
    uptime.record(this.s.name, 'revive', { why, held_ms: held });
    this.inert = null;
    this.note(wasTravelling ? 'no longer travelling' : 'no longer inert',
              { why, was_inert_for_s: Math.round(held / 1000) });
    return null;
  }

  // ---------------------------------------------------------------- travelling
  //
  // The journey's stand-down. See TRAVEL_GUARD_DEFAULTS for the whole argument; the short
  // version is that `goInert` means "stop looking at the survival question" and a journey
  // has no business asking for that. This means "stop CHOOSING WHERE TO GO — I am steering
  // — and keep every defensive faculty the roster still allows you".
  //
  // It reuses `this.inert` as its storage ON PURPOSE. Fourteen places in this file and the
  // broker read `keeper.inert` to mean "something else holds this character", and every one
  // of them is still right: the fleet board, the stall detector, the busy register, the
  // faculty ledger and the deadline all want the same answer they wanted before. Only the
  // two places that decide whether the keeper may ACT — the pass gate and the watchdog
  // rescue — look at the `travelling` marker, and that is the whole diff in behaviour.
  // `to` IS THE OBJECTIVE, AND IT IS NOT THE SAME THING AS `why`.
  //
  // `why` is prose for the record — "travelling to Castle Victoria". Until this argument
  // existed that string was the ONLY trace of where the character was going, which meant a
  // journey taken back mid-hop could not be resumed even in principle: the destination had
  // never been stored anywhere a later pass could read. `takeBack` even reported it as
  // `was_travelling_to: <the why string>`, which reads like a destination and is not one.
  goTravelling(why = null, { maxMs = INERT_MAX_MS, guard = null, to = null, attempts = 0, recoveryDetour = false, origin = null } = {}) {
    // Already travelling for this reason: refresh nothing, the deadline is the caller's.
    // A NEW JOURNEY RETIRES A SUSPENDED ONE, and this early return is why the rule below
    // could not do it. Restored after the 2026-09-04 merge dropped it.
    //
    // A keeper already walking somewhere kept its OWN suspended objective, so the next time
    // the ladder interrupted anything `resumeSuspendedJourney` brought that old objective
    // back to life underneath the new instruction. Measured 2026-09-03: a courier sent to
    // the Tos bank was found walking home to Castle Victoria instead, with the external
    // owner's movement lease held and live, having crossed the killing ground twice for
    // nothing. `passFarm` puts the resume ahead of the claim check deliberately — a resume
    // restores a decision already made rather than making a new one — and that is sound
    // only if a new travel actually retires the old decision. This is what makes it so.
    if (this.inert?.travelling) {
      if (!recoveryDetour && to != null && this.suspendedJourney && Number(to) !== Number(this.suspendedJourney.to)) {
        this.note('retired a suspended journey that a new instruction replaced', {
          was: this.suspendedJourney.to, now: Number(to),
          why: 'an older objective resuming underneath a live instruction is two directions ' +
               'on one body' });
        this.suspendedJourney = null;
      }
      return this.inertStatus();
    }
    // An ERRAND already holds this character. An errand outranks a journey — it asked for
    // silence and got it — so the journey does not get to quietly upgrade itself.
    if (this.inert) return this.inertStatus();
    const allow = this.travelGuard(guard);
    // WHICH ROOMS THIS JOURNEY CROSSES WALL TO WALL — see m59-safelegs.mjs. `safeLegs` is the
    // roster policy (`autopilot safe_legs=...`): `false` switches it off for this character,
    // `{rooms:[...]}` replaces the room list, and absent means the committed default. Handed to
    // the mover for the journey, like the shelter policy below.
    this.s.safeLegPolicy = this.policy?.safeLegs ?? null;
    // THE FUEL-STOP POLICY, HANDED TO THE MOVER FOR THE LENGTH OF THE JOURNEY.
    //
    // Without this the planner in `walkTo` is dead code — it checks `shelterPolicy` and
    // finds nothing, so no crossing ever carries its shelters and the whole point is lost.
    // Set here rather than per walk because it is a property of BEING ON A JOURNEY.
    //
    // CORRECTED 2026-09-06: this used to read "an errand, a fight or a SHOPPING TRIP has no
    // route ahead to divert along", and the shopping trip half was wrong. A supply run is
    // eleven hops out and eleven back over 599 Ukgoth and 598 The Cragged Mountains — as
    // much route ahead as any journey, and the roads that kill this fleet. It had no
    // shelters only because the keeper's own `travel` never installed this posture, which
    // it now does for every internal journey. An errand and a fight genuinely have no route,
    // and they still do not get one.
    //
    // `need()` is read by the walker between legs, so it must be cheap and must answer about
    // NOW rather than about when the journey started.
    if (allow.safe_spot) {
      this.s.shelterPolicy = {
        onFallback: context => this.recoverFromTravelFallback(context),
        unreachable: room => this.unreachableIn(room),
        // NO DISTANCE CAP BY DEFAULT (operator, 2026-09-01): a wall along the route that the
        // body can reach and leave for the door is shelter however far off the line it sits.
        within: this.policy.travelHoldWithin ?? Infinity,
        // ROUTE-ADJACENT, AND THAT IS THE WHOLE DEFINITION OF WHICH SPOT TO USE.
        //
        // Five squares off the planned path — the operator's number, 2026-08-27, and the
        // ceiling matters as much as the spot does: a wall further away than this is not
        // shelter when a full bar is nine and a half seconds, it is a longer way to die.
        // The spots themselves were worked out by `sheltersAlong` when the crossing was
        // planned, so this is a filter on a list rather than a search.
        maxDetour: this.policy.travelShelterDetour ?? Infinity,
        // A TRIP IS REFUGE TO REFUGE, AND A REST STOP IS SKIPPED WHEN IT IS NOT NEEDED.
        //
        // The operator's framing, and it is the right way round: the journey is not a
        // straight line that gets interrupted, it is a chain of walls with walking between
        // them. Passing one costs nothing. Stopping at one is a decision made when you get
        // there, not a reason to tear the crossing down from four rooms away.
        //
        // SO THIS IS NOT THE SAME NUMBER AS `travelShelterBelow`, AND THAT IS THE WHOLE FIX.
        // Both used to read it, so every moment worth a free detour was also a moment worth
        // a cancellation — and the cancellation won, because it happens in the keeper on a
        // one-second clock while the divert happens in the walker between legs. Every
        // journey of one evening ended `legs 2, planned_legs 7`, four health down, cancelled
        // by its own guard.
        //
        // DIVERTING IS CHEAP AND SHOULD BE EAGER. The wall is already on the route,
        // `shelterAhead` refuses anything behind us or more than `maxDetour` off the road,
        // and the walker splices it in as one more waypoint without stopping. So any real
        // damage is enough to want the next one.
        //
        // CANCELLING IS EXPENSIVE AND SHOULD BE RARE. It ends the crossing, and a character
        // that stops in a 750-danger room loses thirty health in eight seconds standing
        // still. That number is a property of stopping, not of the room: twenty-hitpoint
        // mules cross to Castle Victoria every day by never doing it.
        need: () => {
          const v = this.s.client?.vitals?.();
          const hp = v?.health?.max ? v.health.value / v.health.max : null;
          if (hp === null) return false;
          // NOWHERE THAT IS ALREADY SAFE. Measured on the first clean cycle, 2026-08-28: nine
          // shelter runs, and SIX of them were somewhere a wall answers nothing —
          //
          //     room 1  The Underworld     2/29, 1/33, 2/36, 2/36    all 24,10 -> 28,5
          //     room 106 Brownestone Inn   15/52                          10,11 -> 7,5
          //
          // Four dead characters in the Underworld picking the same square and never reaching
          // it, and one sitting in an inn. The Underworld has nothing to shelter FROM and the
          // answer to being in it is `escapeUnderworld`, which is a different rung; an inn is a
          // sanctuary, where the correct move is to rest exactly where you stand. Both were
          // firing because the threshold only ever asked about health, and a corpse at 7% and a
          // traveller at 7% look identical to a number.
          //
          // They also poisoned the measurement: "seven of eight runs never settled" was mostly
          // this, which reads as the doctrine failing when it is the doctrine being asked a
          // question with no answer.
          // Tested two ways, and NEITHER of them is an optional call to a method that may not
          // exist. `this.threatsHere?.()` was written into this file four hours ago, is not a
          // method on this class, and recorded `null` for every row of a whole run without
          // anything failing — optional chaining on a name that was never there is
          // indistinguishable from a true answer. The room number is the fact; the name is the
          // belt to its braces, because room 1 is also what a stub reports.
          const room = this.s.world?.room;
          if (room?.num === 1 || /underworld/i.test(room?.name ?? '')) return false;
          if (this.sanctuary(room)) return false;
          // ANY DAMAGE AT ALL — WHERE THE MAP OUTRANKS US, AND AN ORDINARY THRESHOLD ELSEWHERE.
          // See travelDivertAt: the condition is what makes the sensitive half affordable, and
          // I shipped it unconditional for one run and watched arrivals fall from 43% to 10%.
          return hp < this.travelDivertAt();
        },
        // AND SIT DOWN WHEN WE GET THERE, IF WE ARE NOT WHOLE.
        //
        // The operator's rule: stop at each safe waypoint until health and vigor are full,
        // and skip the ones you do not need. The divert alone only put the wall ON the route
        // — the walker passed straight through it, so a whole evening of journeys recorded
        // `0r` rest while crossing rooms full of perfectly good walls.
        //
        // Full health AND the resting cap of vigor, because vigor is what pays for running
        // and running is what makes the next room survivable. `restUntil` aborts the moment
        // health falls rather than sitting out a leash, so a wall that turns out to be wrong
        // costs one interrupted rest instead of a death.
        onArrive: async (where, { source = 'route',
          movementGeneration = this.s.movementGeneration, controlToken = null } = {}) => {
          const room = this.s.world?.room?.num, client = this.s.client;
          const roomId = client?.room?.id;
          const decision = currentSurvivalDecision(this.s);
          const cancelled = () => this.s.movementWasCancelled?.(movementGeneration, controlToken)
            || this.s.client !== client || this.s.world?.room?.num !== room
            || client?.room?.id !== roomId
            || currentSurvivalDecision(this.s)?.id !== decision?.id;
          const onWall = () => client?.self?.col === where.col && client?.self?.row === where.row;
          // Shared by pivots and fine tracks. A near aim is not refuge arrival.
          if (cancelled() || !onWall()) return false;
          const confirmed = await skills.confirmRefugePosition(this.s).catch(() => false);
          if (cancelled()) return false;
          const v = this.s.client?.vitals?.();
          const hp = v?.health?.max ? v.health.value / v.health.max : null;
          const vig = vigorPct(v);
          const whole = (hp === null || hp >= 1) && (vig === null || vig >= REST_VIGOR_CAP);
          // THE OUTCOME ROW, WRITTEN WHETHER OR NOT WE REST. A run that reached its wall and
          // did not need it is the good case and has to be distinguishable from one that never
          // arrived — without this row both are "a `chose` with no `settled`".
          // ARRIVED MEANS STANDING ON IT, AND THE LEDGER HAS TO CHECK RATHER THAN TRUST.
          //
          // `onArrive` is called by the walker, and one of its two call sites used to fire for
          // any proved leg that merely CONSUMED the shelter square — handing over the end of
          // the leg, up to thirteen squares past the wall. The ledger wrote `arrived: true` for
          // every one of them, so fifteen stops that lost 134 health between them read as
          // refuges that did not work. They were bodies resting in the open.
          //
          // The walker no longer does that. This checks anyway: a ledger is evidence, and
          // evidence that takes its subject's word for the one fact it exists to record is
          // decoration. `on_the_wall: false` is now a visible outcome rather than a silent one.
          const settle = (extra) => {
            if (!this.shelterRun) return;
            const at = this.s.client?.self ?? null;
            const onTheWall = !!(confirmed && at && !at.predicted && this.shelterRun.to
              && at.col === this.shelterRun.to.col && at.row === this.shelterRun.to.row);
            recordShelterRun({
              run: this.shelterRun.id, kind: 'settled', character: this.s.name,
              room: this.s.world?.room?.num ?? null, arrived: onTheWall,
              on_the_wall: onTheWall,
              rested_at: at ? { row: at.row, col: at.col } : null,
              ms: Date.now() - this.shelterRun.at,
              health: v?.health?.value ?? null, max_health: v?.health?.max ?? null,
              health_pct: hp, vigor: v?.vigor?.value ?? null,
              hp_gained: (v?.health?.value ?? null) != null && this.shelterRun.health != null
                ? (v.health.value - this.shelterRun.health) : null,
              ...extra,
            });
            this.shelterRun = null;
          };
          const replace = async (why, outcome = 'unconfirmed') => {
            settle({rested_to:null,why,arrival_confirmed:confirmed,safe_wall:false});
            const next = chooseSurvivalDecision(this.s,this.replacementSurvivalChoice(why,decision),
              {because:why,outcome});
            this.suspendJourney(why);
            this.revive(why);
            this.cancelForSurvival(null,why,{preserveId:next.id,origin:keeperOrigin('shelter')});
            await this.continueSurvivalDecision();
            return true;
          };
          if (!confirmed || !onWall())
            return replace('route refuge arrival was not confirmed at the selected square');
          if (!whole && !this.adoptRecoveryWall())
            return replace('route refuge arrival did not establish a geometric safe wall','blocked');
          if (decision) updateSurvivalDecision(this.s,decision.id,{arrived_at:Date.now()});
          if (whole) {
            if(decision) finishSurvivalDecision(this.s,decision.id,'recovered','arrived whole');
            settle({ rested_to: null, why: 'arrived whole — walked on without resting' }); return false;
          }
          // Every admitted arrival uses the existing safe logoff/turn/heal lifecycle.
          // The old passive-rest fallback skipped confirmation and left the decision
          // "approaching" even after healing and walking away from the refuge.
          settle({rested_to:null,why:'handed to logoff, turn, and recovery at this safe wall'});
          this.recordTravelShelterStop(source);
          await this.playDead('reached the chosen route refuge — logoff before recovering');
          return true;
        },
        // THE DECISION ROW — WRITTEN WHEN THE WALL IS CHOSEN, NOT WHEN IT IS REACHED.
        //
        // The operator's ask, 2026-08-27: record BOTH squares and the health at the moment of
        // the decision, so the run for cover can be recreated. A ledger written on arrival
        // cannot see the runs that never arrive, and those are the ones that end in a
        // postmortem. See tools/m59-shelter.mjs for the argument and the schema.
        onDivert: (stop, at) => {
          if (!stop) {
            const detail={why:at?.suppressed??'no route refuge selected',at_step:at?.atStep??null};
            traceSurvival(this.s,'travel_shelter_deferred',detail);
            this.note('route shelter deferred',detail);
            return;
          }
          if (stop) {
            const decision=chooseSurvivalDecision(this.s,{strategy:'route_refuge',
              reason:'shelter needed during travel',reason_code:'travel_shelter',source:at?.source??'route'});
            this.recordSurvivalPath(decision.id,stop);
          }
          const v = this.s.client?.vitals?.();
          const hp = v?.health?.max ? v.health.value / v.health.max : null;
          const me = this.s.client?.self ?? null;
          const from = me && Number.isFinite(me.row)
            ? { row: me.row, col: me.col } : null;
          // How far the character actually has to WALK, which is the number that costs health —
          // `detour` is only how far the wall sits off the planned road. Chebyshev, because
          // that is how a step moves.
          const squares = from && Number.isFinite(stop.row)
            ? Math.max(Math.abs(stop.row - from.row), Math.abs(stop.col - from.col)) : null;
          this.shelterRun = { id: `${this.s.name}-${Date.now()}`, at: Date.now(),
                              health: v?.health?.value ?? null,
                              to: { row: stop.row, col: stop.col } };
          recordShelterRun({
            run: this.shelterRun.id, kind: 'chose', character: this.s.name,
            room: this.s.world?.room?.num ?? null,
            room_name: this.s.world?.room?.name ?? null,
            health: v?.health?.value ?? null, max_health: v?.health?.max ?? null,
            health_pct: hp, vigor: v?.vigor?.value ?? null,
            health_per_second: this.healthRate?.(this.recent5 ?? []) ?? null,
            // WHAT WAS ACTUALLY STANDING THERE. This asked `this.threatsHere()`, which does
            // not exist on this class — so it silently recorded `null` for every row of the
            // first run and the "what was on it" column was blank throughout. Optional
            // chaining on a method that was never there is indistinguishable from an empty
            // room. Enumerated the same way `roomOutranksUs` does it, off the room objects.
            threats: this.namedThreatsHere().slice(0, 12),
            from, to: { row: stop.row, col: stop.col },
            detour: stop.detour ?? null, squares, proven: stop.proven ?? null,
            outranked: this.roomOutranksUs(), divert_at: this.travelDivertAt(),
            at_step: at?.atStep ?? null,
            legs_left: Number.isFinite(at?.legsLeft) ? at.legsLeft : null,
            why: 'hurt on the road — the next route-adjacent wall',
          });
          this.note('taking a wall on the way past', {
            where: { col: stop.col, row: stop.row }, from, squares_to_walk: squares,
            health: hp === null ? null : Math.round(hp * 100) + '%',
            proven: stop.proven, off_the_road: stop.detour, at_step: at?.atStep,
            why: 'hurt, and this was already on the route — no stop, no replan, one more ' +
                 'waypoint than the crossing had a moment ago',
          });
        },
      };
    }
    // `attempts` RIDES ON THE JOURNEY, and it has to. The counter cannot live only on the
    // suspended note, because resuming clears that note — so a resumed journey taken back
    // again would start counting from zero and resume for ever, which is precisely the
    // "trip that cannot fix the thing that opened it" this repository already has a rule
    // about. Carried in, incremented on take-back, carried back in on resume.
    this.inert = { why, at: Date.now(), maxMs, travelling: true, guard: allow,
                   // `Number(null)` is 0 and 0 is finite, so a plain isFinite check turns
                   // "no destination given" into "the destination is room 0" — which then
                   // suspends and tries to RESUME a journey to a room that does not exist.
                   // Room numbers are positive; anything else is absence.
                   to: (to != null && Number.isFinite(Number(to)) && Number(to) > 0)
                       ? Number(to) : null,
                   attempts: Number(attempts) || 0,
                   origin: origin ?? (Number(liveMoveOrder(this.s)?.to)===Number(to) ? liveMoveOrder(this.s)?.origin : null) };
    // A NEW JOURNEY RETIRES ANY SUSPENDED ONE. Whoever issued this said where the character
    // should be going now, and an older objective coming back to life underneath a live
    // instruction is two directions on one body — the thing this whole boundary exists to
    // prevent. Cleared here rather than at the resume site so it is true for every caller,
    // including the ones that never resume anything.
    if (!recoveryDetour) this.suspendedJourney = null;
    uptime.record(this.s.name, 'travelling',
                  { why, room: this.s.world?.room?.num ?? null, guard: allow });
    this.note('travelling — standing down from choosing, not from surviving', {
      why,
      what_happens: 'the keeper keeps looking, keeps recording, and KEEPS ITS SURVIVAL ' +
        'LADDER ARMED. It will not hunt, roam, shop or pick a room while the journey ' +
        'owns the route',
      may_still: TRAVEL_GUARD_KEYS.filter(k => allow[k]),
      switched_off: TRAVEL_GUARD_KEYS.filter(k => !allow[k]),
      mid_hop_entries_cancel_the_journey:
        // `play_dead` was removed from the key list on 2026-08-21 and this sentence went on
        // naming it. A faculty named in prose and absent from the schema is the shape of the
        // `purpose` bug this repository keeps citing, so it is named from the list instead.
        TRAVEL_GUARD_KEYS.filter(k => TRAVEL_GUARD_CLOCK[k] === 'mid-hop').join(', ') +
        ' take the character back rather than fighting the mover for it — only one thing may ' +
        'ever drive a body. Under the road doctrine the two that stay on are gated on a ' +
        'PERSON (travel_flee_from), so a monster cannot end a journey',
      until: 'revive(), start(), or ' + Math.round(maxMs / 60_000) + ' minutes, whichever is first',
    });
    return this.inertStatus();
  }

  // THE GUARD IN FORCE, most explicit first: what this call asked for, then what the
  // character's policy says, then the defaults.
  //
  // AN UNRECOGNISED KEY IS NEVER SILENTLY DROPPED — see docs/m59-policy.md. It is refused
  // by the tool that sets it and ignored here rather than being merged into a shape the
  // rest of the file would then read as a real faculty.
  travelGuard(override = null) {
    if(this.policy?.survivalEnabled===false)return Object.fromEntries(TRAVEL_GUARD_KEYS.map(k=>[k,false]));
    const from = source => {
      if (!source || typeof source !== 'object') return {};
      const out = {};
      for (const k of TRAVEL_GUARD_KEYS)
        if (source[k] !== undefined) out[k] = !!source[k];
      return out;
    };
    return { ...TRAVEL_GUARD_DEFAULTS, ...from(this.policy?.travelGuard), ...from(override) };
  }

  // MAY THE KEEPER DO THIS RIGHT NOW.
  //
  // True when nothing is holding the character — the ordinary case, and the reason every
  // call site can be a plain `&&` without a second branch for "not travelling". While a
  // journey holds it, the answer is that entry's switch. While an ERRAND holds it, the
  // answer is no: an errand asked for silence, which is the state it still gets.
  travelAllows(faculty) {
    if (!this.inert) return true;
    if (!this.inert.travelling) return false;
    return this.inert.guard?.[faculty] !== false;
  }

  // Is a journey — rather than an errand — what is holding this character.
  get travelling() { return this.inert?.travelling ? this.inert : null; }

  // The name the world knows this character by, falling back to the agent name before
  // login has answered. Everything keyed per character — the feed, the gains, the hits
  // book — has to agree on this or it silently keeps two sets of books.
  who() { return this.s.client?.me?.name ?? this.s.name ?? null; }

  // Session has already persisted the announcement at the packet boundary.
  // React without polling the disposable client event ring.
  noteToughness(gain) {
    if (!gain) return;
    this.tally.toughened = (this.tally.toughened || 0) + 1;
    this.progress('gained a point of maximum health');
    this.note('TOUGHER', { now: gain.to, room: gain.room,
      why: 'the server announced a maximum-health gain' });
    this.pendingImprovement = { what: 'max_health', from: gain.from, to: gain.to,
      hunting: this.policy?.hunt ?? null, room: gain.room_num };
  }

  // WHAT THE FLEET IS USING THIS CHARACTER FOR, if anything. One place, because two
  // things ask it — the keeper's own status, and the terminal that greys the row and
  // steps over it — and an operation the board misses is one somebody takes a character
  // out of without knowing there was another end to it.
  commitment() {
    return describeCommitment({
      // The director must also leave the keeper's own shopping operation alone
      // between travel legs, while it quotes, trades, banks and restocks.
      errand: this.errand ?? (this.chaliceBusy?.() ? { kind: 'chalice hand-off',
        at: this._chaliceServe?.since ?? this.townTrip?.startedAt ?? Date.now() } : null)
        ?? (this.townTrip ? { kind: 'selling and restocking',
        at: this.townTrip.startedAt } : null),
      inert: this.inertStatus(),
      parked: this.parkStatus(),
      partner: this.policy?.partner ?? null,
      // THE TWO HALVES OF "SOMETHING OUTSIDE IS DRIVING THIS", kept apart on purpose —
      // see the long note in m59-commitment.mjs. `held` is ownership and is takeable;
      // `busy` is an operation in flight and is not.
      held: this.heldStatus(),
      busy: this.busyStatus(),
    });
  }

  // ------------------------------------------------------------------- outside owners
  //
  // WHO IS DRIVING, derived from the faculty claims rather than stored a second time. A
  // second field would be a second answer, and the two would disagree the first time a
  // lease expired — `facultyOwner` already drops an expired claim on read, so deriving it
  // means the ownership line goes away exactly when the ownership does.
  heldStatus() {
    const held = [];
    let by = null, at = null;
    for (const f of Autopilot.FACULTIES) {
      const c = this.claims?.get(f);
      if (!c || c.until <= Date.now()) continue;
      held.push(f); by ??= c.owner; at ??= c.at ?? null;
    }
    return held.length ? { by, faculties: held, at } : null;
  }

  /**
   * A CLAIM HOLDER SAYS IT IS MID-OPERATION.
   *
   * This is the field that was missing, and its absence had a specific cost: an external
   * errand walks a character with the keeper inert by design, so every stall detector in
   * the fleet reads `ms_since_moved` — which measures the KEEPER — as a character standing
   * still, and restarts it out from under the errand. There was no way to say "this is
   * supposed to look like that."
   *
   * IT IS LEASED, like the claim it rides on, and for the same reason: a bot that dies
   * mid-errand must not leave a character marked busy for ever, with every supervisor in
   * the fleet politely stepping over a keeper that has genuinely stopped. An expired busy
   * is not busy, checked on read rather than on a timer so there is no window.
   *
   * ONLY THE HOLDER MAY SET IT. Being able to mark somebody else's character hands-off is
   * the same authority as taking it.
   */
  declareBusy({ by = null, kind = null, label = null, detail = null, leaseMs = 300_000 } = {}) {
    const held = this.heldStatus();
    if (!held) return { busy: null, refused: 'nothing is claimed on this character — claim a ' +
                                             'faculty first, so that "busy" has an owner and a lease' };
    if (by && held.by !== by)
      return { busy: null, refused: `${held.by} holds this character, not ${by}` };
    // A CEILING, BECAUSE THE LEASE IS THE ONLY THING PROTECTING THE FLEET FROM A BOT THAT
    // STOPPED ANSWERING. A holder asks for the window its errand expects and extends as it
    // goes — that is the intended shape and it is why the number varies — but "an hour"
    // from a process that then crashed is an hour of a character every stall detector
    // steps politely over. Clamped rather than refused, and SAID SO, because refusing
    // would leave the errand unannounced, which is the worse of the two.
    const asked = Math.max(1_000, leaseMs);
    const ms = Math.min(BUSY_MAX_MS, asked);
    const wasActive = this.busy && this.busy.until > Date.now();
    const beginning = !wasActive || this.busy.by !== held.by;
    const at = (!beginning && this.busy.by === held.by) ? this.busy.at : Date.now();
    this.busy = { by: held.by, kind, label, detail, at, until: Date.now() + ms };
    // TAKE THE STEERING WHEEL AT THE BOUNDARY, not one server step later by accident.
    //
    // `busy` used to be visible only to the supervisor. The keeper never read it, so an
    // external errand and the keeper could both move one character: the crate runner
    // walked onto Castle Victoria's basement exit while the keeper swung at a skeleton,
    // and the server quite correctly answered the resulting GO with "unable to go
    // anywhere". Bumping the movement generation interrupts the keeper's current walk
    // within its next paced step; the pass-level gate below keeps the next one from
    // starting. Do this only when the operation BEGINS. A lease extension between errand
    // steps must not cancel movement belonging to the errand itself.
    // AND SAY WHO TOOK IT. This call had no arguments at all, so `why` defaulted to null, the
    // broker omitted it, and the keeper stamped the ledger with its own endpoint name. It was
    // the single largest anonymous source of cancelled journeys — 72 in two hours on
    // 2026-09-05, against an operator who had issued no orders and could not find out what
    // had. The claimant was in `held.by` the whole time: a cancel that cannot say who asked
    // for it is the commonest way a journey ends here, and this one always knew.
    // THE ACTION FIRST, THE HOLDER LAST, because 80 characters is the budget and the holder
    // name is the least useful half of it. Measured on the first deploy of this line: a real
    // holder is `dum/prod two bands (max health picks the room)@pid-11220` — 55 characters —
    // which left "declaring busy: return-" truncated mid-word. What a reader needs is WHAT
    // was claimed and WHY; which pid claimed it only matters once that is known.
    const doing = `${kind ?? 'a claim'}${label && label !== kind ? ` (${label})` : ''}`;
    const claimant = `busy: ${doing} — ${held.by ?? 'an unnamed holder'}`.slice(0, 80);
    const interrupted = beginning
      ? (() => {
          try { return this.s?.cancelMovement?.(null, claimant, { origin: claimantOrigin(held.by) }) ?? null; }
          catch (e) { return { cancelled: false, why: e.message }; }
        })()
      : null;
    this.note('declared busy', { by: held.by, kind, label, lease_ms: ms,
      asked_for_ms: asked !== ms ? asked : undefined,
      clamped: asked !== ms ? `asked for ${Math.round(asked / 60000)}m, capped at ` +
                              `${Math.round(BUSY_MAX_MS / 60000)}m` : undefined,
      interrupted: interrupted?.interrupted ?? undefined,
      note: 'the keeper keeps death, danger and recovery, then yields directional action; ' +
            'stall detectors step over this character until it is freed or the lease lapses' });
    return { busy: this.busyStatus(), interrupted };
  }

  freeBusy({ by = null } = {}) {
    if (!this.busy) return { busy: null, was: null };
    // A null `by` is an operator taking it back, which is always allowed — the same rule
    // releaseFaculties uses for a bot that is gone.
    if (by && this.busy.by !== by) return { busy: this.busyStatus(), refused: `${this.busy.by} owns it` };
    const was = this.busyStatus();
    this.busy = null;
    this.note('no longer busy', { was: was?.label ?? was?.kind ?? null, by });
    return { busy: null, was };
  }

  busyStatus() {
    if (!this.busy) return null;
    if (this.busy.until <= Date.now()) { this.busy = null; return null; }
    return { ...this.busy, for_s: Math.round((Date.now() - this.busy.at) / 1000),
             expires_in_ms: this.busy.until - Date.now() };
  }

  // RELEASE IT, whatever is holding it. The override key on the fleet board is the only
  // caller, and it is an emergency key: a character is about to die on a loot run, or the
  // person wants it NOW. So this is deliberately blunt — cancel the errand, drop the
  // pairing on this side, revive an inert keeper — and it reports each thing it undid so
  // the terminal can say what it just cost. It does not touch the OTHER end of a pairing:
  // that character's keeper finds its partner gone on its next pass and goes back to
  // fighting alone, which is the behaviour it already has for a partner that logs out.
  releaseCommitment(why = 'an operator took this character back') {
    const was = this.commitment();
    const undone = [];
    if (this.errand) {
      undone.push(`cancelled the ${this.errand.kind || 'errand'}`);
      this.note('errand cancelled by an operator', { was: was?.label, why });
      this.errand = null;
    }
    if (this.policy?.partner) {
      undone.push(`unpaired from ${this.policy.partner}`);
      party.unpair(this.name ?? this.s?.name);
      this.policy.partner = null;
    }
    // THE OVERRIDE KEY HAS TO REACH THE OUTSIDE OWNERS TOO, or it stops being an override.
    // Both are dropped, not just `busy`: leaving the claim in place means the bot's next
    // heartbeat renews a character an operator has just taken back, and the row goes grey
    // again within thirty seconds with nothing to show why.
    if (this.busy) { undone.push(`cancelled ${this.busy.by}'s operation`); this.busy = null; }
    const held = this.heldStatus();
    if (held) {
      undone.push(`took ${held.faculties.join(', ')} back from ${held.by}`);
      this.releaseFaculties({ faculties: null, by: null });
    }
    if (this.inert) { undone.push('revived the keeper'); this.revive(why); }
    return { released: !!was, was, undone };
  }

  inertStatus() {
    if (!this.inert) return null;
    // `inert: true` stays true for BOTH states, because everything reading this asks the
    // same question — is somebody else holding this character — and for that the answer is
    // yes either way. What the travelling state adds is what it is still allowed to do,
    // which is the thing an operator wants when a character dies on a road.
    return { inert: true, why: this.inert.why,
             // WHEN, ABSOLUTELY, AND NOT ONLY AS AN ELAPSED COUNT. `for_s` answers "how long"
             // and every reader that wants to know "since when" — the commitment board above
             // all — had to invent it or report null. It reported null.
             at: this.inert.at,
             by: this.inert.by ?? null,
             for_s: Math.round((Date.now() - this.inert.at) / 1000),
             gives_up_after_s: Math.round(this.inert.maxMs / 1000),
             // The moment it stops being true on its own, so a reader can tell a live hold
             // from one that is about to lapse without doing the arithmetic.
             expires_at: this.inert.at + this.inert.maxMs,
             ...(this.inert.travelling ? {
               state: 'travelling',
               guard: this.inert.guard,
               may_still: TRAVEL_GUARD_KEYS.filter(k => this.inert.guard?.[k]),
               // BOTH HALVES, NOW THAT THE DEFAULTS ARE NOT UNIFORM. `may_still` alone was
               // enough to read when every faculty was on and the only interesting fact was
               // which one somebody had turned off. Under the road doctrine `arm` is off by
               // DEFAULT, so "what is not permitted here" is a fact about the shipped
               // behaviour rather than about this operator, and a post-mortem that cannot
               // see it cannot explain why a journey carried on unarmed.
               switched_off: TRAVEL_GUARD_KEYS.filter(k => !this.inert.guard?.[k]),
               note: 'the survival ladder is still armed — this is a journey steering, not ' +
                     'an errand holding. See TRAVEL_GUARD_DEFAULTS',
             } : { state: 'inert' }) };
  }

  // ------------------------------------------------------------------------- faculties
  //
  // `inert` IS ALL-OR-NOTHING, AND THAT IS THE ONE THING WRONG WITH IT.
  //
  // goInert() is the right primitive and its reasoning is exactly right: a STOPPED keeper
  // writes no frames, runs no observe(), records no death and files no post-mortem, so the
  // character keeps playing while the instruments go dark — which is precisely when they
  // are wanted. `during_keeper_outage` exists on the post-mortem because deaths kept
  // happening in the windows this file had chosen to stop looking.
  //
  // What it cannot express is PART of a character. `meridian59-dum-bot` needs to say "I
  // own what to hunt and which room to stand in; you keep survival, resting, re-arming and
  // the Underworld", and there was no way to say it. So ownership becomes per faculty.
  //
  // THREE PROPERTIES MATTER MORE THAN THE SHAPE:
  //
  //  1. `inert` is exactly `claim(['work','movement','economy','social'])`. Every existing
  //     caller — the errands, the supply hold, the pilot claim, the supervisor — keeps
  //     working unchanged, because this is a refactor with a compatibility alias and not a
  //     second concept sitting beside the first.
  //  2. LEASES FAIL BACK TO THE KEEPER, NEVER OPEN. A bot that crashes, is Ctrl-C'd, or was
  //     never started must leave a character that still defends itself. INERT_MAX_MS
  //     already encodes this instinct and its note is the right one: an unattended
  //     character is worse than a contested one. An expired claim is not a claim, and the
  //     check is on every read rather than on a timer, so there is no window where a dead
  //     bot still owns something.
  //  3. SURVIVAL AND MORTALITY ARE NOT YIELDABLE unless the roster says so. An operator may
  //     hand a bot the survival floor; a bot must not be able to take it silently. That is
  //     the single guarantee keeping "unattended and safe" true as behaviour migrates out.
  static FACULTIES = ['identity', 'mortality', 'survival', 'recovery',
                      'work', 'movement', 'economy', 'social'];
  // The four the keeper will not give up without explicit consent recorded against the
  // roster. Everything else is the carve-out and is freely claimable.
  static PROTECTED_FACULTIES = ['identity', 'mortality', 'survival', 'recovery'];

  facultyOwner(faculty) {
    if (this.s?.combat?.active && !Autopilot.PROTECTED_FACULTIES.includes(faculty))
      return `combat:${this.s.combat.active.id}`;
    // `inert` is the legacy whole-character claim and still answers first, so a caller
    // that never learned about faculties sees exactly what it always saw.
    if (this.inert && !Autopilot.PROTECTED_FACULTIES.includes(faculty))
      return this.inert.why ? `inert:${this.inert.why}` : 'inert';
    const c = this.claims?.get(faculty);
    if (!c) return 'keeper';
    if (c.until <= Date.now()) { this.claims.delete(faculty); return 'keeper'; }
    return c.owner;
  }

  // Does something other than the keeper own this right now? The keeper asks this before
  // acting on a directional branch; it never asks it about a protected one.
  facultyHeld(faculty) { return this.facultyOwner(faculty) !== 'keeper'; }

  claimFaculties({ faculties = [], by = null, leaseMs = 120_000, why = null,
                   mayYield = [] } = {}) {
    const want = (Array.isArray(faculties) ? faculties : [faculties]).filter(Boolean);
    const granted = [], refused = [];
    for (const f of want) {
      if (!Autopilot.FACULTIES.includes(f)) { refused.push({ faculty: f, why: 'no such faculty' }); continue; }
      if (Autopilot.PROTECTED_FACULTIES.includes(f) && !mayYield.includes(f)) {
        refused.push({ faculty: f,
          why: 'this faculty keeps the character alive and is not yielded by default; ' +
               'the roster must name it in may_yield' });
        continue;
      }
      // `at` is when this owner FIRST took it, not when the lease was last pushed out. A
      // heartbeat every thirty seconds would otherwise make every claim look ten seconds
      // old for ever, and "who has been driving this character for the last two hours" is
      // the question the board is actually asked.
      const prev = this.claims?.get(f);
      if(['movement','survival','recovery','combat'].includes(f)
          && (!prev || prev.owner!==(by||'unnamed') || prev.until<=Date.now())) {
        this._survivalOwnerRevision=(this._survivalOwnerRevision??0)+1;
        this.pendingBlockerLure=null;
        this.clearSurvivalJam('faculty handoff: '+f);
      }
      (this.claims ??= new Map()).set(f, {
        owner: by || 'unnamed', until: Date.now() + Math.max(1_000, leaseMs), why,
        at: (prev && prev.owner === (by || 'unnamed') && prev.until > Date.now())
              ? (prev.at ?? Date.now()) : Date.now() });
      granted.push(f);
    }
    if (granted.length) this.note('faculties claimed', {
      granted, refused: refused.length ? refused : undefined, by, lease_ms: leaseMs, why,
      note: 'the keeper keeps everything not listed, and takes these back when the lease ' +
            'expires without a heartbeat' });
    return { granted, refused, faculties: this.facultyStatus() };
  }

  releaseFaculties({ faculties = null, by = null } = {}) {
    const all = faculties == null;
    const list = all ? [...(this.claims?.keys() ?? [])]
                     : (Array.isArray(faculties) ? faculties : [faculties]);
    const released = [];
    for (const f of list) {
      const c = this.claims?.get(f);
      if (!c) continue;
      // Only the holder may release, or anyone may release everything on a null list —
      // an operator taking a character back from a bot that is gone.
      if (by && c.owner !== by && !all) continue;
      this.claims.delete(f); released.push(f);
      if(['movement','survival','recovery','combat'].includes(f)) {
        this._survivalOwnerRevision=(this._survivalOwnerRevision??0)+1;
        this.pendingBlockerLure=null;
        this.clearSurvivalJam('faculty released: '+f);
      }
    }
    if (released.length) this.note('faculties released', { released, by });
    return { released, faculties: this.facultyStatus() };
  }

  // Push the lease out. A bot that is alive says so; one that is not, does not.
  heartbeatFaculties({ by = null, leaseMs = 120_000 } = {}) {
    const renewed = [];
    for (const [f, c] of (this.claims?.entries() ?? [])) {
      if (by && c.owner !== by) continue;
      c.until = Date.now() + Math.max(1_000, leaseMs); renewed.push(f);
    }
    return { renewed, faculties: this.facultyStatus() };
  }

  facultyStatus() {
    const out = {};
    for (const f of Autopilot.FACULTIES) {
      const owner = this.facultyOwner(f);
      if (owner === 'keeper') { out[f] = 'keeper'; continue; }
      const c = this.claims?.get(f);
      out[f] = c ? { owner: c.owner, expires_in_ms: Math.max(0, c.until - Date.now()), why: c.why }
                 : { owner, expires_in_ms: null, why: this.inert?.why ?? null };
    }
    return out;
  }
  // @end 1
}
