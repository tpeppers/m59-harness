// SAFE SPOTS: taking a wall, the survival decision's continuation, and recovery walls.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 18 methods: onwardExit, restBeforeBlink, takeSafeSpot, replacementSurvivalChoice,
//   clearSurvivalJam, survivalJam, rememberSurvivalJam, cancelForSurvival,
//   recoverFromTravelFallback, recordSurvivalPath, currentRecoveryWall, adoptRecoveryWall,
//   continueSurvivalDecision, continueSurvivalDecisionStep, blinkPastSurvivalJam, takeRecoverySpot,
//   watchRecoveryApproach, takeSafeSpotObserved
import { keeperOrigin, liveMoveOrder } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import { affordableHeal, castRecoveryHeal } from '../m59-recovery-heal.mjs';
import { REFUGE_PROGRESS_MS, observeRefugeProgress, recoveryOccupiedSquares, recoveryRefugeReach, recoveryUnderPressure } from '../m59-recovery-refuge.mjs';
import { activeRoutes, anchorFor } from '../m59-routes.mjs';
import { coarseCombatReachFrom } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision, finishSurvivalDecision, observeSurvivalDecision, updateSurvivalDecision } from '../m59-survival-decision.mjs';
import { JAM_MEASURE_MS, JAM_TTL_MS, REPLAN_MS, jamObservation, recoveryObservationKey, validJamOwner } from '../m59-survival-jam.mjs';
import { traceBody, traceRefuge, traceSurvival, traceSurvivalOperation } from '../m59-survival-trace.mjs';
import { recordTactic } from '../m59-tactics.mjs';
import { sameRoomIslandBridgePlan } from '../m59-world.mjs';
import { REST_VIGOR_CAP, TRAVEL_FORWARD_BIAS, UNREACHABLE_SPOT_MS, claimExclusiveSpot, claimSpot, farmVigorWorkReady, pct, releaseSpot, rememberSpotClaimPartner, scriptedWalkDefersVigorRest, spotOccupancy, vigorOf, vigorPct } from '../m59-autopilot.mjs';

export class SafeSpotsPart {
  // @part 1

  // Go and stand somewhere defensible, preferring somewhere we have already proved —
  // and somewhere the fight can actually be brought to.
  // `source` is what will be written into the safe-spot book alongside any verdict this
  // hold produces — 'fight' by default, 'travel' when the hold is a pause part-way through
  // a journey. A failure still discredits the square permanently either way: a blow that
  // got through is a bad square however we came to be standing on it. The tag is so the
  // travel-only rejections can be told apart afterwards without reconstructing anything.
  /**
   * THE SQUARE THIS JOURNEY LEAVES THE ROOM BY, or null when there is no journey to speak
   * of. Read from the route the world would take to the destination — its first hop names
   * the next room and the bake names that door's anchor — so it is answerable at a hop
   * boundary, before any plan for the crossing exists. Mid-crossing the plan's own last
   * step is the same square and `activeShelter.onward` carries it.
   */
  onwardExit(roomNum, destination, { cachedOnly = false } = {}) {
    try {
      const planned = this.s.activeShelter?.onward;
      if (planned && Number.isFinite(planned.row) && Number.isFinite(planned.col)) return planned;
      if (roomNum == null || destination == null || Number(roomNum) === Number(destination)) return null;
      // MEMOISED, because `world.route()` runs the room's exits flood and can block the loop
      // for seconds (see m59-exit-atlas.mjs); the survival ladder must not add such calls.
      // One answer per room and destination, kept for a minute.
      const memoKey = `${roomNum}:${destination}`;
      const memo = (this._onwardMemo ??= new Map()).get(memoKey);
      if (memo && Date.now() - memo.at < 60_000) return memo.value;
      // ASK ONLY WHAT IS ALREADY PAID FOR. `cachedOnly` callers are on the survival ladder,
      // where a blocking call is the injury rather than the remedy: `world.route()` runs the
      // room's exits flood, which m59-world.mjs:601 measures at 10-20 SECONDS on a ~2000
      // square room, on the one event loop 21 characters share — and a 1.2s stall once took
      // twelve of twenty-one out of the world in five minutes.
      //
      // The memo cannot be relied on to have the answer: its TTL is 60s and
      // WEDGE_GIVEUP_HOLD_MS is 120s, so on consecutive give-ups at the same place it is
      // GUARANTEED cold. Declining is therefore the common case by design, and the rung that
      // asks must be written to be skipped. In practice `activeShelter.onward` above answers
      // a body wedged mid-crossing, which is the case the rung is for.
      if (cachedOnly) return null;
      const route = this.s.world?.route?.(destination);
      const hop = route?.found ? route.hops?.[0] : null;
      if (!hop) return null;
      const answer = hop.stand_on && Number.isFinite(hop.stand_on.row)
        ? { row: hop.stand_on.row, col: hop.stand_on.col }
        : (() => { const a = anchorFor(activeRoutes(), roomNum, hop.to); return a && Number.isFinite(a.row) ? { row: a.row, col: a.col } : null; })();
      this._onwardMemo.set(memoKey, { at: Date.now(), value: answer });
      return answer;
    } catch { return null; }
  }

  /**
   * SIT DOWN AND GET YOUR LEGS BACK BEFORE DOING SOMETHING THAT MOVES YOU.
   *
   * The caller has already taken a safe spot; this is the rest that belongs on it. It exists
   * for the blink escape and the rule it enforces is a MECHANIC rather than a preference:
   * RUNNING NEEDS AT LEAST 10 VIGOR, and blink drops the body on a fixed square the room's
   * kod declares, with no promise about what is standing there. Arriving unable to run is
   * arriving with the only thing that makes a bad landing survivable already spent — and the
   * stall that prompted the blink is itself what spends it. Beaker, 2026-09-03: found
   * oscillating in the Cragged Mountains at vigor ONE and full health, in a room holding
   * sixty bodies.
   *
   * `REST_VIGOR_CAP` and not more: RestTimer stops awarding vigor at 80 of 200, so a request
   * above the cap is a request to sit until the timeout. Everything above it has to be eaten,
   * which is a supply problem and not something to wait out here.
   *
   * `abortOnDamage` is left on. A wall that is being hit is not a wall, and the caller is
   * better off told that than sat out — it can still cast, it simply casts tired.
   */
  async restBeforeBlink(why, { maxSeconds = 90, mana = 0 } = {}) {
    const before = vigorPct(this.s.client?.vitals?.());
    const manaBefore = pct(this.s.client?.vitals?.()?.mana);
    // MANA IS THE ONE THAT DECIDES WHETHER THE SPELL HAPPENS AT ALL, and unlike vigor it
    // genuinely refills by sitting. Animal was found in room 567 with NINE mana against a
    // fifteen-mana blink — the strategy asked, the predicate said yes, and the cast could
    // not happen. Waiting for mana is a wait that ends; waiting for vigor above the resting
    // cap is not, which is why the two are asked for differently.
    if ((before ?? 1) >= REST_VIGOR_CAP && (manaBefore ?? 1) >= mana)
      return { rested: false, note: 'already at the resting cap', vigor_pct: before, mana_pct: manaBefore };
    this.doing = 'recovering';
    const r = await skills.restUntil(this.s, {
      // HEALTH IS NOT THE POINT HERE AND MUST NOT HOLD THE CAST UP. A stalled crossing is
      // usually at full health — being hurt is what the survival ladder is for, and it runs
      // on its own clock. Asking for health too would sit a healthy character down for
      // nothing and a hurt one down for the wrong reason.
      health: 0, vigor: REST_VIGOR_CAP, mana, maxSeconds, abortOnDamage: true,
    }).catch(e => ({ error: e.message }));
    const after = vigorPct(this.s.client?.vitals?.());
    const manaAfter = pct(this.s.client?.vitals?.()?.mana);
    this.ledgerEvent('blink_rest', {
      why, vigor_before: before, vigor_after: after,
      mana_before: manaBefore, mana_after: manaAfter, mana_wanted: mana,
      hit_while_resting: r?.interrupted_by_damage ?? null,
      note: r?.error ?? r?.note ?? null,
    });
    return { rested: !r?.error, vigor_pct: after, before, mana_pct: manaAfter,
             interrupted: r?.interrupted_by_damage ?? false,
             ...(r?.error ? { why: r.error } : {}) };
  }

  async takeSafeSpot(why, quarry = null, options = {}) {
    if (options.recovery) quarry = null;
    const decision = options.recovery ? (options.decisionId && currentSurvivalDecision(this.s)?.id === options.decisionId
      ? currentSurvivalDecision(this.s) : chooseSurvivalDecision(this.s, {
        strategy:options.recoveryRoute?'route_refuge':'nearest_refuge',reason:why,source:options.source })) : null;
    if (decision) options = {...options,decisionId:decision.id};
    const result = await traceSurvivalOperation(this.s, 'take_safe_spot', {
      why, quarry: traceBody(quarry), source: options.source ?? 'fight',
      nearest_only: options.nearestOnly ?? false, after_exit: options.afterExit ?? false,
      near_quarry: options.nearQuarry ?? false, destination: options.destination ?? null,
      recovery: options.recovery ?? false,
    }, () => this.takeSafeSpotObserved(why, quarry, options))
      .catch(e => ({took:false,why:e.message}));
    if (options.shouldInterrupt?.()) return {...result,took:false,cancelled:true};
    // COUNT THE SHELTER STOP, because for its whole life this counter has counted nothing.
    //
    // `shelterStops.taken` was introduced by ab4ebaf (2026-09-10) — the same commit that
    // deleted the mid-hop rung which would have incremented it — and nothing in this file has
    // ever written to it since. It is set to 0 on entering a room, read by `shelterSpent`, and
    // reported into every postmortem as `summary.shelter.taken_this_room` beside a
    // `budget_per_room: 4`. So 615 of 615 death records that carry the field read
    // `taken 0 of 4`: a live-looking instrument wired to nothing, which reads as "this
    // character never needed shelter" when it means "nobody has ever counted".
    //
    // ONLY THE SURVIVAL TAKES COUNT, which is what the budget was always about: the comment on
    // `travel_shelter_per_room` bounds repeated DETOURS during one crossing — "a character that
    // has already taken shelter twice in this room has had the benefit; a third detour is not
    // survival, it is a loop". `takeSafeSpot` is also how a hunter positions against a quarry
    // (`a new wall for the next quarry`, `a wall the quarry can be pulled to`), and counting
    // those would spend a survival budget on hunting and mean something different in every
    // postmortem. `recovery` is the existing flag that separates the two, and it is the flag
    // the travel guard's own shelter path already sets.
    //
    // THIS CANNOT SUPPRESS SHELTER, which is the only way wiring it up could do harm.
    // `shelterSpent` has exactly one reader — the `walking on` note below it — and gates no
    // action, because the rung it used to gate was the one ab4ebaf removed. And it is
    // `!inRealTrouble && taken >= budget`, so a character under `doomedInOpenBelow` is exempt
    // by construction: the doomed rush in passFleeAndRest increments this and can never be
    // refused by it.
    if(options.recovery) {
      if(result?.took)this.clearSurvivalJam('safe refuge reached');
      else if(!result?.cancelled)this.rememberSurvivalJam({failed:true});
    }
    if (result?.took && options.recovery) this.recordShelterStop();
    if (decision && currentSurvivalDecision(this.s)?.id === decision.id) {
      if (result?.took) {
        if(!decision.selected_at)this.recordSurvivalPath(decision.id,result.spot??this.hold);
        updateSurvivalDecision(this.s,decision.id,{status:options.shelterOnly?'active':'recovering',arrived_at:Date.now()});
      }
      else chooseSurvivalDecision(this.s,this.replacementSurvivalChoice(result?.why??'refuge unavailable',decision),
        {because:result?.why??'refuge unavailable',outcome:result?.cancelled?'cancelled':'blocked'});
    }
    return result;
  }

  replacementSurvivalChoice(why, previous) {
    const wall=this.currentRecoveryWall();
    if (wall?.ok) return {strategy:'logoff_safe',reason:why,reason_code:'sheltered_replacement',
      chosen_refuge:{...wall,room:this.s.world?.room?.num},mitigation:'already standing at a geometric safe wall'};
    const destination=this.inert?.to??this.suspendedJourney?.to;
    return {strategy:previous?.strategy==='logoff_open'||(previous?.replan_count??0)>=1
        ? 'logoff_open' : destination ? 'route_refuge' : 'nearest_refuge',
      replan_count:(previous?.replan_count??0)+1,
      reason:why,reason_code:'approach_interrupted',source:destination?'travel':'recovery',
      mitigation:destination?'try the onward exit or another reachable refuge toward it':'reassess from the current position'};
  }

  clearSurvivalJam(reason) {
    const e=this.survivalJamEpisode;
    this.survivalJamEpisode=null;
    this._survivalReplan=null;
    if(e) {
      if(this.watch) {this.watch.wedged=null;this.watch.pinnedSince=null;this.watch.pinnedAnchor=null;this.watch.wedgeBreak=null;}
      this.wedgeHold=null;
      this.backUps=(this.backUps??[]).filter(b=>b.jam_id!==e.id);
      this.ledgerEvent('survival_jam',{phase:'ended',episode_id:e.id,reason});
    }
  }

  survivalJam(now=Date.now()) {
    const e=this.survivalJamEpisode;
    if(e && !validJamOwner(this,e,now))this.clearSurvivalJam('position, cover, owner, generation or lifetime changed');
    return this.survivalJamEpisode??null;
  }

  rememberSurvivalJam({failed=false,now=Date.now()}={}) {
    let e=this.survivalJam(now);
    const measured=this.measuredWedgeInPlace(now);
    if(!e && (measured||failed)) {
      const o=jamObservation(this);
      if(!Number.isFinite(o.row)||!Number.isFinite(o.col))return null;
      e={...o,id:(this.s.name??'keeper')+'-'+now+'-'+(this._jamSequence=(this._jamSequence??0)+1),
        at:now,expires:now+JAM_TTL_MS,measured:!!measured,failures:0};
      if(!validJamOwner(this,e,now))return null;
      this.survivalJamEpisode=e;
      this.ledgerEvent('survival_jam',{phase:'started',episode_id:e.id,
        room:o.room,row:o.row,col:o.col,measured:!!measured});
    }
    if(e && failed) {
      e.failures++;
      if(!e.measured && e.failures>=2 && now-e.at>=JAM_MEASURE_MS) {
        e.measured=true;
        this.ledgerEvent('survival_jam',{phase:'measured',episode_id:e.id,
          failures:e.failures,for_ms:now-e.at});
      }
    }
    return e;
  }

  // Only survival call sites may transfer an episode to the new movement generation.
  cancelForSurvival(token,why,options={}) {
    const e=this.rememberSurvivalJam(),generation=this.s.movementGeneration;
    const result=this.s.cancelMovement(token,why,{...options,origin:options.origin??keeperOrigin('survival')});
    if(e && result?.cancelled && this.s.movementGeneration===generation+1) {
      e.generation=this.s.movementGeneration;
      this.ledgerEvent('survival_jam',{phase:'transferred',episode_id:e.id,
        previous_generation:generation,generation:e.generation});
    }
    return result;
  }

  async recoverFromTravelFallback({movementGeneration=this.s.movementGeneration,controlToken=null,
    why='pivot route did not reach its destination'}={}) {
    if(this.policy?.survivalEnabled===false)return false;
    const s=this.s;
    if(s.movementWasCancelled(movementGeneration,controlToken) || !this.inert?.travelling
        || !this.inert.guard?.safe_spot) return false;
    const previous=currentSurvivalDecision(s);
    // A different survival controller already owns the body; this old walker
    // cannot replace it merely because its own route failed.
    if(previous && (previous.strategy!=='route_refuge'
        || !['pending','approaching'].includes(previous.status))) return false;
    if(!previous && !s.shelterPolicy?.need?.()) return false;
    const reason=previous ? `chosen shelter approach interrupted: ${why}`
      : `shelter needed during fallback travel: ${why}`;
    // A replacement must not select the same currently blocked refuge again.
    // This is temporary local reachability evidence, not a change to safe-wall geometry.
    if (previous?.chosen_refuge && /object_blocked|off plan|no.*progress/i.test(why)) {
      const wall = previous.chosen_refuge;
      if (wall.kind !== 'exit') this.noteUnreachableSpot(s.world?.room?.num,wall.col,wall.row);
    }
    const choice=this.replacementSurvivalChoice(reason,previous);
    // A fresh recovery chooses its closest clear wall independently of quarry
    // or the onward destination. Failed approaches use the replacement ladder.
    if(!previous && choice.strategy!=='logoff_safe') Object.assign(choice,{
      strategy:'nearest_refuge',replan_count:0,reason_code:'fallback_shelter',source:'travel',
      mitigation:'recover at the closest reachable safe wall, then resume the journey'});
    const next=chooseSurvivalDecision(s,choice,{because:reason,outcome:'interrupted'});
    this.suspendJourney(reason);
    this.revive(reason);
    this.cancelForSurvival(controlToken,reason,{preserveId:next.id,origin:keeperOrigin('shelter')});
    await this.continueSurvivalDecision();
    return true;
  }

  recordSurvivalPath(id,spot) {
    if (!id || !spot) return;
    const s=this.s,me=s.client?.self,geo=s.world?.geometry;
    let path=null;
    try { path=recoveryRefugeReach(geo,me,s.client?.room?.objects,s.client?.selfId,
      s.client?.playersOnline)(spot.col,spot.row); } catch {}
    updateSurvivalDecision(s,id,{status:'approaching',activated_at:Date.now(),selected_at:Date.now(),
      chosen_refuge:{...spot,room:s.world?.room?.num},path:path?.reachable?path.path:null,
      path_length:path?.reachable?path.steps:null,
      path_source:path?.reachable?'clear geometry plan at selection; movers may adjust around live bodies':'unavailable'});
  }

  currentRecoveryWall() {
    // Start with safeWalls membership at our current square. Recent failed recovery
    // excludes it temporarily, just as the recovery selector does. No firing-line
    // requirement: this is the square a hurt character RECOVERS on; demanding a firing
    // line from it was asking a resting spot to be a gun position, and the free shots it
    // promised were disproved in play (0.192 incoming/s while swinging from a wall, against
    // 0.067/s standing idle in the open — tools/m59-wallproof.mjs, 2026-09-20).
    if(this.s.client?.self?.predicted)return null;
    const wall=this.wallHere(),geo=this.s.world?.geometry;
    if(wall?.ok) {
      const room=this.s.world?.room?.num;
      const failed=this.failedRestSpots?.get(room)?.get(`${wall.col},${wall.row}`);
      if(failed!=null && Date.now()-failed<=(this.policy.unreachableSpotMs??UNREACHABLE_SPOT_MS))return null;
      // The exposure disc excludes its origin. A monster already on our square
      // needs no approach through the wall, so geometry alone cannot shelter us.
      for(const body of this.s.client?.room?.objects?.values?.()??[]) {
        if(body.id!==this.s.client.selfId && (body.flags&OF.ATTACKABLE) && !(body.flags&OF.PLAYER)
            && body.row===wall.row && body.col===wall.col)return null;
      }
    }
    return wall?.ok && geo?.walkable?.(wall.row,wall.col) ? wall : null;
  }

  adoptRecoveryWall() {
    const wall=this.currentRecoveryWall(),room=this.s.world?.room?.num;
    if (!wall?.ok) return false;
    this.clearSurvivalJam('safe cover');
    this.wantsForwardShelter=null;
    this.resumeShelterWaits=0;
    if (!this.hold || this.hold.room!==room || this.hold.row!==wall.row || this.hold.col!==wall.col)
      this.hold={room,row:wall.row,col:wall.col,proven:true,takenAt:Date.now(),quietMs:0,source:'recovery',quarry_id:null};
    return true;
  }

  // Runs before all planners. A cancelled approach cannot fall through into shopping,
  // quarry pursuit, or a stale journey while its replacement is waiting to execute.
  async continueSurvivalDecision() {
    if (this.s.combat?.active?.pvp) {
      await this.s.combat.tick();
      return true;
    }
    if(this.operatorSurvivalStandDown())return false;
    // A replacement is executable intent, not work to defer to the heartbeat.
    // Drain distinct alternatives serially, with fresh ownership/health checks in
    // each step. Stop when an action is stable or the same failed state recurs;
    // a cycle with no new information must not become an unbounded busy loop.
    this.observeBlockerLure();
    this.survivalJam();
    const observed=recoveryObservationKey(this);
    const d0=currentSurvivalDecision(this.s);
    const owned=d0 && d0.strategy!=='yield_to_controller' && !this.stopping
      && !(this.inert&&!this.inert.travelling)
      && !this.facultyHeld('survival') && !this.facultyHeld('recovery') && !this.facultyHeld('combat');
    if(owned && !scriptedWalkDefersVigorRest(this,this.s.client?.vitals?.()) && this._survivalReplan?.key===observed && this._survivalReplan.geometry===this.s.world?.geometry
        && Date.now()<this._survivalReplan.until)return true;
    const attempted=new Set();
    let handled=false;
    try {
      for (;;) {
        const d=currentSurvivalDecision(this.s),me=this.s.client?.self;
        if(!d || d.strategy==='yield_to_controller')return false;
        const key=JSON.stringify([d.strategy,d.status,d.phase,d.replan_count,d.chosen_refuge,
          this.s.world?.room?.num,me?.x,me?.y,me?.row,me?.col,this.s.client?.vitals?.()?.health?.value,
          [...(this.unreachableIn(this.s.world?.room?.num)??[])].sort()]);
        if(attempted.has(key)) {
          this.note('survival alternatives exhausted for the current observation',{
            decision_id:d.id,strategy:d.strategy,reason:d.reason,attempts:attempted.size});
          this._survivalReplan={key:recoveryObservationKey(this),geometry:this.s.world?.geometry,until:Date.now()+REPLAN_MS};
          return handled;
        }
        attempted.add(key);
        const before={id:d.id,status:d.status,phase:d.phase,generation:this.s.movementGeneration};
        handled=await this.continueSurvivalDecisionStep();
        if(this.s.movementGeneration!==before.generation)return true;
        const next=currentSurvivalDecision(this.s);
        if(!handled || !next || next.strategy==='yield_to_controller')return false;
        if(next.id===before.id && next.status===before.status && next.phase===before.phase)return true;
        if(next.status!=='pending' && !(next.status==='recovering'&&next.phase==='turn_required'))return true;
      }
    } finally { this._survivalDrainedDecisionId=currentSurvivalDecision(this.s)?.id; }
  }

  async continueSurvivalDecisionStep() {
    const s=this.s,d=currentSurvivalDecision(s);
    if (!d || d.strategy==='yield_to_controller') return false;
    observeSurvivalDecision(s);
    const v=s.client?.vitals?.(),hp=pct(v?.health);
    if (s.world?.room?.num===1 || hp===0) {
      this.clearSurvivalJam('death');
      finishSurvivalDecision(s,d.id,'died','entered the Underworld');return false;
    }
    const scriptedReady=scriptedWalkDefersVigorRest(this,v),farmReady=farmVigorWorkReady(this,v);
    if (d.status==='recovering' && hp!=null && hp>=1 && (vigorOf(v)??0)>=80 || scriptedReady || farmReady) {
      finishSurvivalDecision(s,d.id,'recovered',farmReady?'healthy farm ready above its effective fighting vigor floor':scriptedReady?'scripted journey health and road vigor restored':'health and resting vigor restored');return false;
    }
    // A director leases movement for its entire run, while survival/recovery remain
    // with this keeper. Busy announces the holder's errand; it does not lease
    // these protected faculties. Its initial declaration already cancels old
    // movement. Only inert/human control or an explicit protected handoff yields
    // the replacement recovery; renewing an errand must not strand it.
    if (this.stopping || (this.inert && !this.inert.travelling)
        || this.facultyHeld('survival') || this.facultyHeld('recovery') || this.facultyHeld('combat')) {
      chooseSurvivalDecision(s,{strategy:'yield_to_controller',reason:'survival control explicitly handed to another controller',
        reason_code:'controller_ownership',status:'yielded'},{because:'external control takes precedence'});return false;
    }
    // Pending recovery runs before passFleeAndRest. Without its blocker rung,
    // a pinned body can exhaust refuge alternatives forever without reaching
    // the ordinary ladder's stationary fight. Keep the recovery intent and
    // enter the same health-aware blocker operation as an ordinary jam.
    // This also gives a blocked retry delay useful work without another walk.
    this.rememberSurvivalJam();
    // Ask the measured jam's useful Blink before walking another retreat.
    // Spell, health, damage and landing guards still apply; skill-less couriers skip it.
    if(d.status==='pending' && !this.currentRecoveryWall() && !this.checkFreeze()
        && await this.blinkPastSurvivalJam())return true;
    if(d.status==='pending' && !this.currentRecoveryWall() && !this.checkFreeze()
        && await this.escapeIfWedgedAndHurt({near:this.inReachOfUs(),v}))return true;
    // A spared blocker needs no weapon to be lured, so it is not behind the armed gate.
    if (d.status==='pending' && !this.currentRecoveryWall() && !this.checkFreeze()
        && await this.lureSparedBlocker({near:this.inReachOfUs(),v}).catch(()=>false))
      return true;
    if (d.status==='pending' && !this.currentRecoveryWall() && !this.checkFreeze()
        && this.armedForSure()
        && await this.tradeInPlaceIfWedged({near:this.inReachOfUs(),v}))
      return true;
    if (d.retry_at && Date.now()<d.retry_at) return true;
    if (d.status==='recovering') {
      if (this.checkFreeze()) return true;
      if (!this.currentRecoveryWall()) {
        chooseSurvivalDecision(s,this.replacementSurvivalChoice('recovery is no longer at a safe wall',d),
          {because:'recovery position changed'});return true;
      }
      this.doing='recovering';
      if(d.phase==='turn_required') {
        const turned=await skills.turnInPlace(s,{verify:false}).catch(e=>({turned:false,why:e.message}));
        if(currentSurvivalDecision(s)?.id!==d.id)return true;
        if(turned.turned) {
          this.turnedAt=Date.now();updateSurvivalDecision(s,d.id,{phase:'reconnected_turn_and_heal'});
        } else chooseSurvivalDecision(s,{strategy:'logoff_safe',reason:'turn did not arm healing',
          reason_code:'turn_failed',mitigation:turned.why},{because:'stationary healing was not established',outcome:'failed'});
        return true;
      }
      const generation=s.movementGeneration,client=s.client;
      const cancelled=()=>currentSurvivalDecision(s)?.id!==d.id || s.client!==client
        || s.movementWasCancelled?.(generation) || !this.currentRecoveryWall();
      // The active recovery path used to bypass healUp and wait on vigor alone.
      // Keep the same wall, movement generation and decision while casting one heal.
      if(hp!=null&&hp<0.99&&Date.now()-(this._recoveryHealAt??0)>=3000&&affordableHeal(client)){
        this._recoveryHealAt=Date.now();
        const healing=await castRecoveryHeal(s,{shouldCancel:cancelled});
        this.note('recovery heal',healing);
        if(healing.cast)this.recordCast(healing.spell,{ok:healing.confirmed,...healing});
        if(cancelled())return true;
        if(pct(client.vitals()?.health)>=1)return true;
      }
      const r=await skills.restUntil(s,{health:1,vigor:REST_VIGOR_CAP,maxSeconds:8,
        shouldCancel:cancelled,
        beforeMutation:()=>{if(cancelled())throw Error('survival recovery interrupted');},
        beforeCleanup:()=>{if(currentSurvivalDecision(s)?.id!==d.id || s.movementWasCancelled?.(generation))throw Error('survival ownership changed');}});
      observeSurvivalDecision(s);
      if(r?.interrupted && currentSurvivalDecision(s)?.id===d.id) {
        if(s.client?.self)this.noteFailedRestSpot(s.world?.room?.num,s.client.self.col,s.client.self.row);
        chooseSurvivalDecision(s,this.replacementSurvivalChoice('recovery interrupted: '+r.interrupted,d),{because:'rest interrupted'});
      }
      return true;
    }
    if (d.status!=='pending') return false;
    if (this.currentRecoveryWall() || d.strategy==='logoff_safe' || d.strategy==='logoff_open') {
      await this.playDead(d.reason);return true;
    }
    await this.takeRecoverySpot(d.reason,{source:d.strategy==='route_refuge'?'travel':d.source,
      route:d.strategy==='route_refuge',decisionId:d.id});
    return true;
  }

  async blinkPastSurvivalJam() {
    const s=this.s,e=this.survivalJam();
    if(!e || !this.wedgedInPlace() || !s._askStrategies || !s.blinkOut
        || Date.now()<(this._nextSurvivalBlinkAsk??0))return false;
    this._nextSurvivalBlinkAsk=Date.now()+5000;
    const generation=s.movementGeneration,d=currentSurvivalDecision(s);
    const goal=this.onwardExit(s.world?.room?.num,this.suspendedJourney?.to,{cachedOnly:true});
    const answer=await s._askStrategies('whenStuck',{room:s.world?.room,geo:s.world?.geometry,
      self:s.client?.self,goal,bodies:s._blockingBodies?.()??[],blink:s._blinkPointHere?.(),
      vitals:s.client?.vitals?.(),stuck_ms:Date.now()-e.at,
      underFire:Date.now()-(s.damagedAt??0)<5000,healthFloor:this.safety().fleeAt,
      from:'pending_survival',agent:s.name});
    if(answer?.answer?.do!=='blink')return false;
    if(currentSurvivalDecision(s)?.id!==d?.id || s.movementWasCancelled?.(generation)
        || this.checkFreeze() || this.currentRecoveryWall())return false;
    const out=await s.blinkOut({expect:answer.answer.expect,proposalId:answer.answer.proposalId,movementGeneration:generation});
    this.ledgerEvent('survival_blink',{episode_id:e.id,resume_to:this.suspendedJourney?.to??null,...out});
    this.survivalJam(); // actual relocation invalidates the old pocket; no invented clearance
    return !!out?.cast;
  }

  // Healing chooses the shortest clear approach to an exclusive local wall. Combat
  // later binds a quarry to its own wall through the ordinary target-first selector.
  async takeRecoverySpot(why, { source = 'recovery', route=false, decisionId=null, preparedRefuge=null } = {}) {
    // Cancel the old script's paced packets before this keeper starts its approach.
    // Replacing the visible move order alone leaves both walkers on one generation.
    const order=liveMoveOrder(this.s);
    if(order?.kind==='walk'&&order.origin?.source==='fleetscript'){
      const handoff=this.s.cancelMovement?.(null,'keeper recovery preempts the script walk',
        {origin:keeperOrigin('shelter'),preserveId:decisionId??currentSurvivalDecision(this.s)?.id});
      if(!handoff?.cancelled)return {took:false,cancelled:true,why:'script walk recovery handoff refused'};
    }
    if (this.adoptRecoveryWall()) {
      const did=await this.playDead(why);
      return {took:!!did || !!this.hold,spot:this.hold,via:'logoff_at_safe_wall'};
    }
    const generation=this.s.movementGeneration;
    const result=await this.takeSafeSpot(why,null,{source,recovery:true,nearestOnly:!route,recoveryRoute:route,decisionId,preparedRefuge});
    if(result?.cancelled || this.s.movementWasCancelled?.(generation))
      return {...result,took:false,cancelled:true};
    if (result?.took && this.adoptRecoveryWall()) await this.playDead(why);
    return result;
  }

  watchRecoveryApproach(spot) {
    const s=this.s,client=s.client,room=s.world?.room?.num,decision=currentSurvivalDecision(s);
    const generation=s.movementGeneration,life=s.lifeBoundary??0,bodyId=client.self?.id,roomId=client.room?.id;
    if (!decision || typeof s.cancelMovement!=='function') return ()=>{};
    let memory=this.refugeApproachProgress;
    if (!memory || memory.client!==client || memory.room!==room || memory.life!==life
        || memory.episode!==decision.episode_id) {
      memory=this.refugeApproachProgress={client,room,life,episode:decision.episode_id,targets:new Map()};
    }
    const key=`${spot.row},${spot.col}`,now=Date.now();
    let progress=memory.targets.get(key);
    if(progress && now-progress.startedAt>120000)progress=null;
    progress=observeRefugeProgress(progress,s.world?.geometry,client.self,spot,now);
    if(memory.targets.size>=32 && !memory.targets.has(key))memory.targets.delete(memory.targets.keys().next().value);
    memory.targets.set(key,progress);
    let closed=false,confirming=false,guard;
    const stillOwned=()=>!closed && s.keeperRecoveryApproach===guard && s.client===client && s.world?.room?.num===room
      && client.self?.id===bodyId && client.room?.id===roomId
      && s.movementGeneration===generation && (s.lifeBoundary??0)===life
      && currentSurvivalDecision(s)?.id===decision.id && !this.stopping
      && !s.combat?.active?.pvp && !(this.inert&&!this.inert.travelling)
      && !this.facultyHeld('survival') && !this.facultyHeld('recovery') && !this.facultyHeld('combat');
    const close=()=>{closed=true;clearInterval(timer);if(s.keeperRecoveryApproach===guard)delete s.keeperRecoveryApproach;};
    guard={generation,progress,isCurrent:stillOwned};
    s.keeperRecoveryApproach=guard;
    const assess=position=>{
      if(!stillOwned()){close();return;}
      observeRefugeProgress(progress,s.world?.geometry,position,spot);
      if(position && !position.predicted && position.row===spot.row && position.col===spot.col){close();return;}
      const noProgressMs=recoveryUnderPressure(client,s.damagedAt)?2000:REFUGE_PROGRESS_MS;
      if(Date.now()-progress.progressedAt<noProgressMs)return;
      close();
      this.noteUnreachableSpot(room,spot.col,spot.row);
      this.rememberSurvivalJam({failed:true});
      const why='shelter approach made no confirmed route progress';
      this.note(why,{to:{row:spot.row,col:spot.col},room,
        stalled_ms:Date.now()-progress.progressedAt,remaining_steps:progress.best});
      this.cancelForSurvival(null,why,{origin:keeperOrigin('shelter')});
    };
    const timer=setInterval(()=>{
      if(!stillOwned()){close();return;}
      observeRefugeProgress(progress,s.world?.geometry,client.self,spot);
      const at=client.self,noProgressMs=recoveryUnderPressure(client,s.damagedAt)?2000:REFUGE_PROGRESS_MS;
      if((at && !at.predicted && at.row===spot.row && at.col===spot.col)
          || Date.now()-progress.progressedAt<noProgressMs){assess(at);return;}
      if(at?.predicted && typeof s.confirmFinePosition==='function'){
        if(confirming)return;
        confirming=true;
        // Prediction is neither progress nor a proved jam. Read the actual body
        // once before cancelling a short escape; no packet is licensed by it.
        void s.confirmFinePosition({timeoutMs:1000}).then(p=>{
          confirming=false;
          if(!stillOwned()){close();return;}
          const valid=p && !p.predicted && Number.isInteger(p.id) && p.id>0
            && p.id===client.self?.id && p.room_object_id===client.room?.id
            && [p.row,p.col,p.x,p.y].every(Number.isFinite);
          assess(valid?p:client.self);
        }).catch(()=>{confirming=false;assess(client.self);});
        return;
      }
      assess(at);
    },500);
    timer.unref?.();
    return ()=>{
      close();
      const at=client.self;
      if(at && !at.predicted && at.row===spot.row && at.col===spot.col)memory.targets.delete(key);
    };
  }

  async takeSafeSpotObserved(why, quarry = null, { source = 'fight', islandCrossings = 0, nearQuarry = false,
                                           nearestOnly = false, afterExit = false, recovery = false,
                                           recoveryRoute = false, decisionId = null, shouldInterrupt = null, shelterOnly = false,
                                           onward: onwardGiven = null, destination: destinationGiven = null,
                                           candidateFilter = null, doorCrossings = 0, preparedRefuge = null } = {}) {
    const s = this.s, c = s.client;
    const movementGeneration = s.movementGeneration;
    let claimedHere = false;
    // The old travel stack remains cancelled for this pass. A replacement survival
    // decision owns a fresh generation and can move now without reviving that stack.
    const interrupted = () => shouldInterrupt?.() || (recovery ? this.checkFreeze() : this.travelInterrupted())
      || !!s.movementWasCancelled?.(movementGeneration)
      || (decisionId && currentSurvivalDecision(s)?.id!==decisionId);
    const cancelled = () => {
      if (claimedHere) releaseSpot(s.name);
      return { took: false, cancelled: true, why: 'shelter movement interrupted — reassess survival' };
    };
    if (interrupted()) return cancelled();
    const room = s.world?.room, geo = s.world?.geometry, me = c?.self;
    if (!geo || !me || !room) return { took: false, why: 'no geometry for this room' };
    // A journey's refuge is judged against the door it is heading for. `onward` is null for
    // a fight or a rest, and then nothing below changes.
    // `nearestOnly` is the search on the far side of a crossing: the first available wall,
    // ranked by distance alone, and never the next exit — a stopover, not the destination.
    const onward = source === 'travel' && !nearestOnly && (!recovery || recoveryRoute)
      ? (onwardGiven ?? this.onwardExit(room.num, destinationGiven ?? this.inert?.to ?? this.suspendedJourney?.to ?? null)) : null;
    // Once several independently tested walls have all failed, continuing to scan the
    // room is research, not survival. `noWallRooms` feeds the already-bounded choice
    // below between a safe open fight and relocating; it does not block the strategic
    // goal and is cleared with the keeper process.
    const roomWallDecision = source === 'fight' && !recovery ? this.noWallRooms?.get(room.num) : null;
    if (roomWallDecision)
      return { took: false, unreachable_terrain: true, why: roomWallDecision };

    // PLAYER REACH AND MONSTER REACH ARE DIFFERENT GRAPHS WHEN A ROOM HAS DOORS.
    //
    // If the quarry is across an internal wall, selecting a wall from our current
    // component guarantees the pull will never convert; selecting one from its component
    // and calling walkTo guarantees the player will report it unreachable. Neither says
    // anything bad about the wall. Take the two-door player route first, then run the
    // ordinary selector from the correct side. The quarry stays behind because monsters
    // cannot operate the doors, which is exactly the invariant this route relies on.
    const bridge = quarry?.col != null && quarry?.row != null
      ? sameRoomIslandBridgePlan(s.world.map, room.num, geo, me, quarry)
      : null;
    if (bridge) {
      if (islandCrossings >= 1)
        return { took: false, why: 'changed rooms once but still did not land on the quarry\'s side' };
      const crossed = await traceSurvivalOperation(s, 'refuge_island_crossing', {
        from_room: bridge.fromRoom, via_room: bridge.viaRoom, target: traceBody(bridge.target),
      }, () => this.crossSameRoomIsland(bridge));
      if (interrupted()) return cancelled();
      if (!crossed.arrived) {
        // SAY WHY, BECAUSE THIS FAILED EIGHTEEN TIMES IN SILENCE.
        //
        // The reason was returned as a value and swallowed by the caller, so the journal
        // showed "changing sides of a split room" once per pass and never an arrival or a
        // failure. Measured on prod 2026-08-27: Bunsen at (27,9) — itself a door square to
        // Castle Victoria — planned the crossing on every pass for four minutes, took it
        // never, and reported nothing either way. "No error" is not success anywhere in
        // this game and least of all here.
        //
        // Rate-limited to one note per reason per room: the loop is per-pass, and a note
        // per pass would bury the journal it is meant to explain.
        const key = `${bridge.fromRoom}:${crossed.reason || 'unknown'}`;
        if (this._lastBridgeFailure !== key) {
          this._lastBridgeFailure = key;
          this.note('could not change sides of the room', {
            room: bridge.fromName, via: bridge.viaName,
            quarry: { col: bridge.target.col, row: bridge.target.row },
            standing_at: me ? { col: me.col, row: me.row } : null,
            leave_doors: bridge.leaveDoors?.length ?? 0,
            return_doors: bridge.returnDoors?.length ?? 0,
            reason: crossed.reason || 'no reason given',
            why: 'the quarry is on the other island and the two-door route out and back ' +
                 'did not complete — without this line the retry looks like a decision',
          });
        }
        return { took: false, why: crossed.reason || 'could not change sides of this room' };
      }
      this._lastBridgeFailure = null;
      // Re-entering replaces the room object map. Use the live quarry instance rather
      // than carrying its pre-door coordinates and identity through the trip.
      const liveQuarry = quarry.id != null ? c.room?.objects?.get(quarry.id) : quarry;
      if (!liveQuarry)
        return { took: false, why: 'the quarry was gone when we reached its side' };
      return this.takeSafeSpot(why, liveQuarry, { source, islandCrossings: islandCrossings + 1, nearQuarry });
    }
    // Can the thing we came to fight actually get to fighting distance of the square?
    const los = this.policy.los ?? 0;                       // LOS_OLD, the server default
    // PICK A WALL THE SELECTED QUARRY CAN ACTUALLY FIGHT AT.
    //
    // Straight-line distance was only a ranking hint. In a split room, across a cliff, or
    // behind a one-way edge, a wall can be visually close while living in a different
    // monster component. Flood the stock server's coarse monster grid from the quarry and
    // require it to reach at least one square inside our two-square melee disc around the
    // wall. The monster never has to occupy the safe square itself.
    const quarryReach = quarry?.col != null && quarry?.row != null
      ? coarseCombatReachFrom(geo, quarry)
      : null;
    if (quarry && !quarryReach)
      return { took: false, why: 'could not validate the quarry on the coarse movement grid' };
    // Self-room `go` exits are player-operated doors between monster partitions.
    // Castle Victoria's small chambers all remain room 38 for a player, but a monster
    // cannot cross those transitions. In that authored shape the monster grid is the
    // component boundary, so a wall the quarry cannot reach is in the wrong chamber,
    // not an uncertain ledge prediction worth live-testing.
    // This is now a hard combat invariant everywhere, not merely in authored split rooms:
    // an unreachable pull position cannot become reachable by trying it live for a minute.
    const strictQuarryReach = !!quarryReach;
    // SEARCH THE WHOLE ROOM. A RADIUS IS THE WRONG SHAPE OF ANSWER.
    //
    // `within` was a flat 12 squares from wherever the character happened to be
    // standing — a fact about the character, not about the room. Measured against the
    // live fleet, the rooms it was declaring wall-less hold 210 to 549 defensible
    // squares each, of which 124 to 206 are plain wall edges, and the book had tried
    // between 60 and 129. Nothing was exhausted. The search simply was not looking:
    // "found no wall" meant "did not walk far enough to see one".
    //
    // For a pull, NEAR THE SELECTED QUARRY IS THE PRIMARY ORDER. The wall's proof,
    // defensibility and player-walk distance only break ties between equally-near valid
    // squares. For rest/travel calls with no quarry, the established quality ranking stays
    // unchanged. Searching wide changes what is considered; the target-first comparator
    // decides what combat chooses.
    //
    // Bounded by the room's own dimensions, so this is one pass over the floor.
    const within = Math.max(geo.rows ?? 0, geo.cols ?? 0) || 64;
    const spotStats = {};
    // FILL EVERY WALL ONCE BEFORE ANY WALL TAKES A SECOND.
    //
    // The search is run with a share cap and re-run one step higher when it finds
    // nothing, so the first keepers into a room take squares nobody is on, and only once
    // every square is occupied does anyone accept a neighbour. Four walls and eight
    // characters settle at two apiece without anybody computing that; four walls and four
    // characters still get one each, which is the old behaviour exactly.
    //
    // Cheap because the expensive part is per-candidate pathfinding inside
    // nearestSafeSpot, and a re-run only happens when the first pass rejected everything
    // — which in an uncrowded room never occurs.
    // A quarry-bound pull wall is exclusive: the user asked for a spot with no other
    // person in it, and concurrent selectors must not both reserve the same empty square.
    // Recovery also requires an unoccupied square, even when sharing is configured.
    const exclusiveClaim = !!quarry || recovery;
    const configuredShareCap = exclusiveClaim ? 1
      : Number.isFinite(this.policy.maxBotsPerSafeSpot) && this.policy.maxBotsPerSafeSpot > 0
        ? Math.max(1, Math.floor(this.policy.maxBotsPerSafeSpot)) : null;
    // With spreading off there is one unbounded search. With it on, retain the existing
    // fair fill: try one per wall, then two, up to the configured maximum.
    rememberSpotClaimPartner(this.s.name, this.policy.partner ?? null);
    let spot = null, shareCap = configuredShareCap == null ? Infinity : 1;
    let claimCollisions = 0;
    // A peer planned this wall while we were offline. It is only a search hint:
    // the normal selector rechecks our actual body, geometry, occupancy, failed
    // approaches and exclusive claims. Failure falls through in this same call.
    if(recovery&&preparedRefuge){
      spot=this.searchSafeSpot(geo,me,room,{within,quarryReach,strictQuarryReach,los,quarry,
        stats:spotStats,shareCap:1,exclusiveClaim:true,recovery:true,onward:null,
        candidateFilter:(col,row)=>col===preparedRefuge.col&&row===preparedRefuge.row&&(!candidateFilter||candidateFilter(col,row))});
      if(spot&&claimExclusiveSpot(s.name,room.num,spot.col,spot.row))claimedHere=true;
      else spot=null;
      this.note('cooperative prepared refuge checked',{accepted:!!spot,to:{row:preparedRefuge.row,col:preparedRefuge.col}});
    }
    spotSearch:
    for (; !claimedHere&&(configuredShareCap == null || shareCap <= configuredShareCap); shareCap++) {
      // Selection and walking are separated by an await. A second process may reserve
      // our choice in that gap between the read and this process's atomic claim, so retry
      // from a fresh snapshot a few times before raising the share cap. The claim itself
      // is the authority; the snapshot only keeps the room-sized search cheap.
      // A production fleet is normally 21 characters. Thirty-two collisions is enough
      // for every other one to win a distinct wall ahead of us while keeping a broken or
      // adversarial claim store from turning one decision into an unbounded loop.
      for (let attempt = 0; attempt < 32; attempt++) {
        for (const k of Object.keys(spotStats)) delete spotStats[k]; // stats describe LAST attempt
        // Monster count does not invalidate collision-tested cover. A crowded road is
        // precisely where a hurt traveller needs a refuge; the geometry still decides
        // whether the square is defensible and reachable.
        const wallsAllowed = true;
        let maxApproachSteps = Infinity;
        if (recovery && onward && recoveryUnderPressure(c,s.damagedAt,
            {failed:(currentSurvivalDecision(s)?.replan_count??0)>0})) {
          const nearest = this.searchSafeSpot(geo,me,room,{within,quarryReach,strictQuarryReach,los,quarry,
            stats:{},shareCap,nearQuarry,exclusiveClaim,recovery,onward:null,forwardBias:1,wallsAllowed,candidateFilter});
          if (nearest && Number.isFinite(nearest.steps_away)) maxApproachSteps = nearest.steps_away + 3;
        }
        spot = this.searchSafeSpot(geo, me, room, {
          within, quarryReach, strictQuarryReach, los, quarry,
          stats: spotStats, shareCap, nearQuarry, exclusiveClaim, recovery,
          onward, forwardBias: onward ? TRAVEL_FORWARD_BIAS : 1, wallsAllowed, candidateFilter, maxApproachSteps });
        if (!spot) break;
        const claimed = exclusiveClaim
          ? claimExclusiveSpot(this.s.name, room.num, spot.col, spot.row)
          : claimSpot(this.s.name, room.num, spot.col, spot.row,
                      { cap: shareCap, partner: this.policy.partner ?? null });
        if (claimed) {
          claimedHere = true;
          break spotSearch;
        }
        claimCollisions++;
        spot = null;                  // another process won it; refresh and search again
      }
      if (configuredShareCap == null) break;
    }
    traceSurvival(s, 'refuge_selected', { selected: traceRefuge(spot), source,
      quarry: traceBody(quarry), onward: traceRefuge(onward), nearest_only: nearestOnly,
      after_exit: afterExit, share_cap: shareCap, claim_collisions: claimCollisions,
      recovery, search_counts: spotStats });
    if (spot && Number.isFinite(shareCap) && shareCap > 1)
      this.note('sharing a wall rather than standing in the open', {
        with: spotOccupancy(this.s.name, room.num, spot.col, spot.row), at: { col: spot.col, row: spot.row },
        why: `every wall in this room already had ${shareCap - 1} on it, and two to a wall ` +
             'beats one on a wall and one in the open' });
    if (!spot) {
      if (quarry && (spotStats.partition_rejected ?? 0) > 0) {
        return {
          took: false, unreachable_terrain: true,
          why: 'no unoccupied safe spot lets this quarry reach combat distance on the coarse grid',
        };
      }
      // THERE IS NO SUCH THING AS A SAFE WALL THAT DOES NOT WORK, so nothing here decides
      // that a room's walls have been used up.
      //
      // What stood at this spot was `allEmpiricallyBarren`: when every eligible square had
      // failed repeated pulls, the room came back `unreachable_terrain: true` and the keeper
      // stopped looking for a wall in it. Removed with the rest of `barrenSpots` on the
      // operator's instruction, 2026-08-27. The reasoning is the same one that has been right
      // about this room every time: a wall is a wall, and a pull that does not convert is a
      // fact about the pull — about where the quarry was and what lay between — not a verdict
      // on the square somebody was standing on.
      // NO WALL ON THIS SIDE IS NOT NO WALL. In a room split by its own `go` doors the search
      // above sees only the chamber the body is standing in, and a monster cannot follow
      // through the door — so the door is the refuge and the wall beyond it is where to heal.
      // See planDoorEscape. One crossing per take: a second empty side is a different room's
      // problem, and a chain of doors under attack is a walk, not a retreat.
      let doorWhy = '';
      if (recovery && doorCrossings < 1) {
        const escaped = await this.escapeThroughDoor(why, geo, me, room,
          { within, los, movementGeneration, interrupted });
        if (escaped.cancelled) return cancelled();
        if (escaped.crossed) {
          // The blocker retreat's filter and any onward exit were drawn for the side we just
          // left; both are recomputed (or dropped) from the landing.
          return this.takeSafeSpotObserved(why, null, { source, nearQuarry, nearestOnly, afterExit,
            recovery, recoveryRoute, decisionId, shouldInterrupt, shelterOnly,
            destination: destinationGiven, doorCrossings: doorCrossings + 1,
            candidateFilter: null, onward: null });
        }
        if (escaped.why) doorWhy = '; ' + escaped.why;
      }
      const c = spotStats;
      const counted = Number.isFinite(c.considered)
        ? ` (walls considered ${c.considered}, reachable from here ${Math.max(0, (c.considered ?? 0) - (c.unreachable_to_us ?? 0))}, ` +
          `one-way ${c.one_way ?? 0}, eligible ${c.eligible ?? 0})`
        : '';
      return { took: false, why: 'nothing in this room is more defensible than open floor' + counted + doorWhy };
    }

    if (spot.predicted_unreachable_by_quarry)
      this.note('testing a wall the room grid doubts', {
        at: { col: spot.col, row: spot.row },
        quarry: quarry ? { col: quarry.col, row: quarry.row } : null,
        prediction: spot.quarry_prediction,
        why: 'the coarse movement grid is useful for ranking, but only repeated pulls can ' +
             'prove that a live quarry cannot fight here' });

    if (claimCollisions)
      this.note('another keeper reserved a wall while we were choosing', {
        collisions: claimCollisions,
        settled_on: { col: spot.col, row: spot.row },
        why: 'wall reservations are atomic across keeper processes; the losing selector ' +
             'refreshes the room and takes another square instead of walking into the winner',
      });

    // THE EXIT AS A WALL. The search ranked the journey's own exit above every wall here
    // (see nearestSafeSpot): crossing breaks every attack, so take it — one hop on the
    // journey's own machinery — and then mend at the FIRST AVAILABLE wall on the far side,
    // nearest by distance, no forward bias, no exit (the far-side search withholds it, so a
    // retreat cannot chain room to room). Operator, 2026-09-01. If the crossing does not
    // happen the answer is a refusal that says so, never a hold on a square in another room.
    if (spot.kind === 'exit') {
      const roomBefore = room.num;
      const destination = destinationGiven ?? this.inert?.to ?? this.suspendedJourney?.to ?? null;
      const route = destination != null ? this.s.world?.route?.(destination) : null;
      const hop = route?.found ? route.hops?.[0] : null;
      if (!hop) {
        releaseSpot(this.s.name);
        return { took: false, why: 'the exit ranked as the nearest wall, but no hop toward the destination could be planned from here' };
      }
      this.recordSurvivalPath(decisionId,{...spot,destination:hop.to});
      this.doing = 'travelling';
      this.note('taking the exit as the nearest wall', {
        at: { col: spot.col, row: spot.row }, to: hop.to, steps_away: spot.steps_away ?? null,
        why: 'crossing breaks every attack; the first wall in the next room is where the mending happens' });
      // THE LEASE IS REFRESHED AROUND THE CROSSING. The journey's control lease
      // (inert.at + maxMs) is never touched while it runs; a one-hop crossing inside the
      // ladder can push it past its deadline, and then "reviving myself — nobody came back"
      // takes the controls back mid-hop (tour 15, the sewers). The ladder IS the keeper.
      if (this.inert) this.inert.at = Date.now();
      // The exit is also a refuge approach. A short geometric path can stall on
      // a live crowd just like a wall approach; retain the same confirmed-progress
      // memory and cancellation lease instead of spending an entire escape on it.
      const stopProgressWatch = recovery || source === 'travel'
        ? this.watchRecoveryApproach(spot) : () => {};
      const crossed = await traceSurvivalOperation(s, 'refuge_exit', { destination: hop.to,
        selected: traceRefuge(spot) }, () => this.s.travel(hop.to, { origin: keeperOrigin('safe_spot'), maxHops: 1 }))
                                .catch(e => ({ arrived: false, why: e.message }))
                                .finally(stopProgressWatch);
      if (interrupted()) return cancelled();
      if (this.inert) this.inert.at = Date.now();
      this.movedAt = Date.now();
      releaseSpot(this.s.name);
      const roomAfter = this.s.world?.room?.num ?? null;
      try {
        recordTactic({ character: this.s.client?.me?.name ?? this.s.name ?? null, room: Number(roomBefore),
                       tactic: 'exit_as_wall', trigger: source, worked: roomAfter != null && Number(roomAfter) !== Number(roomBefore),
                       ms: 0, hp_lost: 0, attempted: true,
                       note: `the exit toward ${hop.to} ranked as the nearest wall (${spot.steps_away ?? '?'} squares); ` +
                             (roomAfter != null && Number(roomAfter) !== Number(roomBefore) ? `crossed into ${roomAfter}` : `did not cross: ${crossed?.why ?? crossed?.reason ?? '?'}`) });
      } catch { /* evidence, not a dependency */ }
      if (roomAfter == null || Number(roomAfter) === Number(roomBefore)) {
        return { took: false, exit_refused: true,
                 why: `could not take the exit toward ${hop.to}: ${crossed?.why ?? crossed?.reason ?? 'the crossing did not happen'}` };
      }
      const far = await this.takeSafeSpot(`${why} — the first wall after the exit`, null,
                                          { source, nearestOnly: true, afterExit: true, recovery, decisionId })
                            .catch(e => ({ took: false, why: e.message }));
      if (far?.took) return { ...far, via: 'exit', crossed_from: roomBefore };
      return { took: false, crossed: true, via: 'exit', room: roomAfter,
               why: `crossed into room ${roomAfter}, which broke every attack; ${far?.why ?? 'no wall from here'}` };
    }
    // A zero-length plan from a predicted position is not a confirmed arrival.
    // Use the same arrival boundary even when the planner thinks we are there;
    // otherwise recovery reports "took" and immediately abandons the unconfirmed wall.
    if ((spot.steps_away ?? 99) > 0 || c.self?.predicted) {
      this.doing = 'travelling';
      this.recordSurvivalPath(decisionId,spot);
      this.note('taking the selected safe spot', {
        to: { col: spot.col, row: spot.row }, steps_away: spot.steps_away ?? null,
        source, recovery, why });
      // THE SQUARE IS THE WHOLE MECHANIC. THERE IS NOTHING FINER TO STAND ON.
      //
      // This used to aim 24 of the 64 fine units toward the wall on the theory that the
      // real physics was finer than the movement grid, so a spot that worked by hugging
      // a wall would be most of a square off centre and a first visit conducted from the
      // middle of the floor would manufacture a false failure. The theory was wrong, and
      // the server says so plainly. Being hit is two tests and neither of them can see a
      // fine coordinate:
      //
      //   SquaredDistanceTo = (piRow-row)^2 + (piCol-col)^2         nomoveon.kod:121
      //   CanReach          = that <= range^2, then LineOfSight     monster.kod:1736
      //
      // Both read piRow/piCol, which are SQUARE coordinates. piFine_row and piFine_col do
      // exist on every object, and the only thing in the game that reads them is
      // MonsterOrient, to choose the angle a monster is DRAWN facing (monster.kod:2189).
      // So the offset could not have helped at any size, and 1 or 0 would have been no
      // better than 24 — the lever was not connected to anything.
      //
      // The book agrees, having accidentally run the experiment: of 411 recorded
      // positions the 72 taken at a hugged offset held 52% of the time against 87% for
      // the 339 taken at the square centre, and the gap survives excluding the retests.
      // It was not merely inert either — returnToSpot arrives within 12 fine units, so a
      // target 24 off centre costs up to six extra move packets shuffling at the wall,
      // can finish out of tolerance, and then releases the claim and reports a perfectly
      // good square unreachable.
      //
      // A REMEMBERED position is still honoured: it is a record of where we actually
      // stood, it costs nothing to reuse, and returning to it is free of the above
      // because we were demonstrably able to stand there. Only the synthesis is gone.
      const fine = spot.fine;
      // BUDGETED BY THE ROUTE, NOT BY A FLAT NUMBER. A wall thirty squares up the road is
      // now a legitimate choice, and `walkTo` only raises a caller's cap to the plan's own
      // length once it has planned — so hand it a cap that already fits the walk asked for.
      const walkBudget = Math.max(24, Math.ceil((spot.steps_away ?? 0) * 2) + 12);
      const approachOptions = { maxSteps: walkBudget, routeFirst: recovery || shelterOnly, checkedApproach: recovery || shelterOnly,
        avoidSquares: recovery || shelterOnly ? recoveryOccupiedSquares(c.room?.objects,c.selfId,c.playersOnline) : null,
        // Fine movement uses the actual body discs, so a legal sub-square gap
        // is not removed along with the body's entire occupied coarse square.
        fineAvoidSquares: null };
      const stopProgressWatch=recovery?this.watchRecoveryApproach(spot):()=>{};
      const arrival = fine
        ? await skills.returnToSpot(s, { col: spot.col, row: spot.row, ...fine }, approachOptions)
                      .catch(e => ({ arrived: false, why: e.message })).finally(stopProgressWatch)
        // Claiming a safe square is a correctness boundary, just like returning to one
        // after a pull. A plain walk can finish on a predicted position which a delayed
        // server update revokes on the next pass; use the shared confirmed arrival
        // contract for both remembered and newly-derived spots.
        : await skills.returnToSpot(s, { col: spot.col, row: spot.row }, approachOptions)
                      .catch(e => ({ arrived: false, why: e.message })).finally(stopProgressWatch);
      if (arrival?.cancelled || interrupted()) return cancelled();
      this.movedAt = Date.now();
      if (!arrival.arrived) {
        releaseSpot(this.s.name);      // hand the reservation back
        // REMEMBERED, so the next pass picks a different one — or none, and gets on with
        // whatever it was doing. This is the line whose absence killed two characters.
        if (!arrival.unconfirmed) this.noteUnreachableSpot(room?.num ?? null, spot.col, spot.row);
        this.note('could not reach the safe spot', {
          spot: { col: spot.col, row: spot.row }, why: arrival.why || arrival.reason,
          ...(arrival.fine_tried ? { fine_tried: arrival.fine_tried } : {}) });
        // `fine_tried` says what the sliding-fan approach answered once the square walk had
        // already failed. Without it "could not walk back to the square" cannot distinguish
        // a fallback that ran and lost from one that never ran at all, and that is the whole
        // question about the last mile into a wall.
        return { took: false, why: arrival.why || arrival.reason || 'could not get there',
                 ...(arrival.unconfirmed ? { unconfirmed: true } : {}),
                 ...(arrival.fine_tried ? { fine_tried: arrival.fine_tried } : {}) };
      }
    }

    const now = c.self;
    // GEOMETRY DECIDES, AND NOTHING ELSE DOES. THE LEDGER IS GONE.
    //
    // This used to read a per-square history — `book.get()`, then `book.discredited()` — and
    // the belief was walked back by inches over four separate corrections until it could no
    // longer condemn anything the geometry called unreachable. It is now removed outright,
    // for a reason stronger than "nothing depends on it any more": IT COULD NEVER HAVE BEEN
    // RIGHT. The writer recorded `this.hold.col/row` — the square this keeper had RESERVED,
    // not the square the body was standing on when the blow landed. Of ten deaths reviewed
    // on 2026-09-20, nine had the body between 5 and 68 squares from the hold it was filed
    // against. Every failure row is a statement about a square the character may never have
    // occupied, so the column cannot be repaired, only retired.
    //
    // AND THE QUESTION IT EXISTED TO ARBITRATE IS SETTLED. It was kept because nobody knew
    // which mechanism actually protects a body. tools/m59-wallproof.mjs answered it in play:
    // 1,290 seconds on `attackers === 0` across 19 squares, not swinging, with a
    // non-poisoning monster in reach and visibly moving, took ZERO attacks — against 0.067/s
    // on open ground under the identical rule. Two squares were observed in BOTH states,
    // which holds room, geometry and monsters constant:
    //
    //     516:1,31   0 attacks / 965s not swinging   vs   17 attacks / 79s swinging
    //     516:1,28   0 attacks / 128s not swinging   vs    4 attacks / 70s swinging
    //
    // So a wall does not have a per-square reliability to look up. It has a CONTRACT, and
    // the contract is about what this body does, not about what the square did last Tuesday:
    // nothing can reach you here until you swing. `proven` below is therefore a statement of
    // that contract rather than an inherited belief, and the disproof path at `THIS IS NOT A
    // SAFE SPOT` still clears it the instant something lands a blow while we sit — which,
    // per the run above, is the signature of having swung, not of a bad square.
    this.hold = {
      source,
      room: room.num, col: spot.col, row: spot.row,
      // The wall was selected only after this quarry was selected and its coarse
      // component was validated. A later target gets its own closest wall.
      quarry_id: quarry?.id ?? null,
      x: now?.x ?? null, y: now?.y ?? null,
      takenAt: Date.now(), quietMs: 0, damageWhileIdle: 0, failures: 0, mostAttackers: 0,
      // Walls do not move and they are not remembered — they are COMPUTED, from the same
      // two grids the mover enforces, and the live proof says an offered one holds without
      // exception while the body does not swing. There is nothing to inherit and nothing to
      // look up, so this is trusted on arrival, full stop.
      proven: true, inherited: false, provenAt: Date.now(),
      canReachYou: spot.can_reach_you, freeShots: spot.free_shots, backCover: spot.back_cover,
      // THE NUMBERS THIS DECISION WAS MADE WITH, carried so the outcome can be recorded
      // against them. Re-measuring at the moment of the outcome would record a different
      // reading from the one that was acted on, and the gap between those two is exactly
      // where the interesting bugs are. See verdictFromRow in m59-safewall.mjs.
      refusedApproaches: spot.refused_approaches ?? null,
      offeredApproaches: spot.offered_approaches ?? null,
    };
    // Tell the other keepers this one is taken, so the next of them to look at this
    // room ranks it out instead of walking into us.
    if (exclusiveClaim) claimExclusiveSpot(this.s.name, room.num, spot.col, spot.row);
    else claimSpot(this.s.name, room.num, spot.col, spot.row,
                   { cap: shareCap, partner: this.policy.partner ?? null });
    this.note('took a safe spot', {
      where: { col: spot.col, row: spot.row }, why,
      can_reach_you: spot.can_reach_you, back_cover: spot.back_cover,
      // WHAT A READER OF THIS LINE USED TO BE TOLD, AND WHY IT IS GONE.
      //
      // This reported a per-square history, and at its worst a perfectly good square
      // announced itself as "DISCREDITED — failed 319 time(s) here ... should not have been
      // offered" in every postmortem it appeared in. It is the first thing a reader sees and
      // it pointed at the wrong culprit: it sent one whole session hunting a bug in the
      // offering code that does not exist, while the actual killer — an unguarded `pull` in
      // a crowd — sat two lines further down the same trail.
      //
      // The tally was never a fact about the square. It was filed against the keeper's HOLD,
      // which in nine of ten reviewed deaths was 5 to 68 squares from where the body actually
      // was. So there is no history to report, and inventing one is worse than silence.
      // What is true of this square is true of every offered wall, and it is a contract
      // rather than a reputation:
      proven_before: 'not applicable — walls are computed, not remembered',
      note: 'nothing within reach has line of sight to this square, so nothing can attack ' +
            'the body standing on it UNTIL IT SWINGS. Measured 2026-09-20: 1,290s across 19 ' +
            'such squares with monsters in reach and moving took 0 attacks, while swinging ' +
            'from the same squares drew 0.192/s. Swinging is what ends it, not the square.',
    });
    return { took: true, spot: this.hold };
  }
  // @end 1
}
