// FREEZES, COOPERATIVE LOGOFF, PLAYING DEAD, ASKING FOR HELP.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 11 methods: checkFreeze, playerThreatPresent, passCooperative, recordCooperativeKill,
//   fleetLogoff, resumeCooperativeReturn, playDead, logoffDeclined, playDeadObserved, askForHelp,
//   restockReagents
import { abortPreparingCooperativeLogoff, configureCooperativeLogoff, cooperativeAssist, cooperativeReturnRefuge, requestCooperativeLogoff } from '../m59-cooperative-logoff.mjs';
import { isFood } from '../m59-items.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF, buyLines } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { purchaseKey } from '../m59-purchase-plan.mjs';
import * as skills from '../m59-skills.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision, updateSurvivalDecision } from '../m59-survival-decision.mjs';
import { CONTINUE, DEBUG_STATES, HANDLED, LOGOFF_REFRESH_MS, LOGOFF_UNDER_ATTACK_MS, REST_VIGOR_CAP, bearingIn, pct, purchaseEnabled, vigorOf } from '../m59-autopilot.mjs';

export class CooperativePart {
  // @part 1

  // LOG OFF RATHER THAN DIE.
  //
  // This is the single most effective survival move in the game and it is not a
  // trick so much as a documented mechanic. NotifyMonstersOfPresence
  // (user.kod:3114) carries the comment: "When a player first enters the room, the
  // game will prevent AIs from attacking that player until that player takes an
  // action." That grace period is real, it applies on every entry including a
  // reconnect, and PFLAG_MOVED_SINCE_ENTRY is what ends it.
  //
  // Crucially, UC_REST goes straight to StartResting (user.kod:1480) WITHOUT calling
  // NotifyMonstersOfPresence — so resting does not wake anything. Moving, turning,
  // attacking, casting and picking things up all do.
  //
  // The honest limit, because the same flag gates two different things: HealthTimer
  // also requires PFLAG_MOVED_SINCE_ENTRY, so while frozen we recover VIGOR and not
  // health. That is still the right trade. A death costs a point of maximum health
  // permanently plus everything carried; this costs a minute and buys back the vigor
  // that sets the regeneration rate for when we do move.
  //
  // ALL OF THAT CHANGES IF WE ARE STANDING IN A SAFE SPOT, and it changes for the
  // better, because the reason to stay frozen disappears. Logging back in puts us
  // back exactly where we logged off; the walls have not moved; so the grace period
  // is no longer the thing keeping us alive — the geometry is. That means we can
  // afford to SPEND the grace period rather than hoard it: turn once, which wakes
  // everything and arms HealthTimer, and then rest to full while the things that
  // noticed us stand there unable to do anything about it.
  //
  // The frozen version buys a minute of vigor. This version buys a full heal in the
  // middle of a monster room, and it is the difference between a fight we lost and a
  // fight we get to have again.
  checkFreeze() {
    if(this.policy?.survivalEnabled===false){this.frozenUntil=null;this.freezeSample=null;return false;}
    if (!this.frozenUntil) return false;
    const c = this.s.client, me = c?.self;
    const sample = { health: c?.vitals?.()?.health?.value ?? null,
      room: this.s.world?.room?.num ?? null, col: me?.col ?? null, row: me?.row ?? null };
    const before = this.freezeSample ?? { ...sample, health: this.frozeAt ?? sample.health };
    const hurt = sample.health != null && before.health != null && sample.health < before.health;
    const moved = ['room', 'col', 'row'].some(k =>
      sample[k] != null && before[k] != null && sample[k] !== before[k]);
    const dead = sample.room === 1 || sample.health === 0;
    const expired = Date.now() >= this.frozenUntil;
    if (!hurt && !moved && !dead && !expired) { this.freezeSample = sample; return true; }
    this.frozenUntil = null;
    this.freezeSample = null;
    const why = dead ? 'dead' : hurt ? 'damage while playing dead'
      : moved ? 'moved while playing dead' : 'freeze deadline reached';
    const holding = this.hold ? { room: this.hold.room, row: this.hold.row, col: this.hold.col } : null;
    if (hurt || moved) this.wantsForwardShelter = why;
    if (hurt && !moved) {
      this.noteFailedRestSpot(before.room, before.col, before.row);
      if (this.hold) this.releaseHold('damage while playing dead');
    }
    this.note('unfreezing', { why, before, now: sample, holding });
    return false;
  }

  /**
   * IS A PERSON HERE — the only thing an open freeze works on.
   *
   * Room-wide rather than the 2-square radius the travel ladder uses for `strangers`: a
   * player closes that distance while the pass is deciding, and the question here is "is
   * this PVP", not "is it adjacent".
   *
   * IT CAN ONLY EVER SAY "SOMEBODY IS HERE", NEVER "NOBODY IS" — a room we cannot read
   * reports nobody, exactly as the wall gate above it does. That bias is the safe one for
   * the caller: an unreadable room refuses the open freeze and falls through to something
   * that MOVES.
   */
  playerThreatPresent() {
    const c = this.s?.client;
    const here = c?.room?.objects ? [...c.room.objects.values()] : [];
    return here.some(o => o.id !== c.selfId && (o.flags & OF.PLAYER)
                          && !party.isFleetmate(c.rsc?.get(o.nameRsc)));
  }

  async passCooperative() {
    try { return await cooperativeAssist(this) ? HANDLED : CONTINUE; }
    catch(e) { this.note('cooperative assistance unavailable',{why:e.message}); return CONTINUE; }
  }

  recordCooperativeKill(f,request) {
    if(!f?.killed)return;
    this.tally.kills=(this.tally.kills??0)+1;
    this.killTimes?.push(Date.now());
    if(this.killTimes?.length>500)this.killTimes.shift();
    this.ledgerEvent('killed',{creature:f.target,room_num:request.room,rounds:f.rounds,
      cooperative_distraction:true,request_id:request.id,from_safe_spot:!!this.currentRecoveryWall()});
    this.farmStrategyHook('onKill',{creature:f.target,room:request.room,looted:[]});
  }

  async fleetLogoff(why) {
    const s=this.s,offered=await configureCooperativeLogoff(this,'request');
    const request=offered&&requestCooperativeLogoff(this,offered);
    if(!request)return false;
    const decision=chooseSurvivalDecision(s,{strategy:'logoff_open',reason:why,
      reason_code:'cooperative_logoff',status:'active',mitigation:'wait offline for confirmed fleetmate distraction hits'},
      {because:'private cooperative strategy and a controlled fleetmate in this room'});
    this.note('cooperative logoff requested',{request_id:request.id,helpers:request.helpers,targets:request.targets});
    this.tally.logoffs=(this.tally.logoffs??0)+1;
    this.survivalInterruptedPass=this.passes;
    s.cancelMovement?.(null,'cooperative logoff',{preserveId:decision.id,origin:keeperOrigin('cooperative_logoff',{run_id:request.id})});
    const result=await this.reconnect('cooperative logoff: wait for distraction');
    if(result.ok){
      this.frozenUntil=null;this.freezeSample=null;
      this.note('cooperative logoff returned',{request_id:request.id,receipt:s.cooperativeLogoffReturn});
      await this.resumeCooperativeReturn({decisionId:decision.id});
    }else {
      this.note('cooperative logoff remains unresolved',{request_id:request.id,why:result.why});
      if(abortPreparingCooperativeLogoff(s,request.id,result.why))return false;
    }
    return true;
  }

  async resumeCooperativeReturn({decisionId=null}={}) {
    const s=this.s,r=s.cooperativeLogoffReturn,current=currentSurvivalDecision(s);
    if(!r||r.cover_attempted_at||!s.live||s.client?.combatReady!==true||this.stopping||
      this.operatorSurvivalStandDown()||s.combat?.active?.pvp||
      ['movement','survival','recovery','combat'].some(k=>this.facultyHeld(k))||
      (decisionId?current?.id!==decisionId:current&&current.reason_code!=='cooperative_logoff'))return false;
    r.cover_attempted_at=Date.now();this.frozenUntil=null;this.freezeSample=null;
    const decision=chooseSurvivalDecision(s,{strategy:'nearest_refuge',
      reason:'fleetmate landed the distraction hits; return to cover',reason_code:'cooperative_return'},
      {because:'confirmed cooperative distraction',outcome:'arrived'});
    const preparedRefuge=cooperativeReturnRefuge(s);
    this.note('cooperative immediate return to cover',{request_id:r.request_id,prepared:!!preparedRefuge,
      login_ready_at:s.client.loginReadyAt??null,released_at:r.released_at});
    r.cover_result=await this.takeRecoverySpot(decision.reason,{decisionId:decision.id,preparedRefuge});
    return true;
  }

  async playDead(why) {
    if (this.s.combat?.active?.pvp) { await this.s.combat.tick(); return true; }
    if(this.operatorSurvivalStandDown())return false;
    this.suspendJourney(why);
    const s=this.s,atWall=this.adoptRecoveryWall();
    // THE OPEN FREEZE IS REFUSED AGAINST MONSTERS. Operator, 2026-09-18: "the open freeze
    // should be removed as a tactic or only ever done in PvP, it will not save you from
    // monsters."
    //
    // THIS REVERSES THE 2026-09-10 INSTRUCTION QUOTED IN `playDeadObserved`, and that
    // argument is left in place rather than deleted, because the reversal is about one of
    // its premises and not about its logic. It reasoned that off a wall the choice is not
    // healing-versus-not-healing but "an attack that ends now against one that continues".
    // That is only worth having if the bought seconds are spent on something. They are not:
    //
    //   Animal, 2026-09-17, room 599, in_safe_spot false, hold null. Frozen twelve seconds
    //   at 4/55 with vigor at 135 — never the constraint. Unfroze `before {health: 4} ->
    //   now {health: 4}`: ZERO health across the whole freeze, because a freeze recovers
    //   vigor and never health and there was no wall to turn at. Then "logoff did not
    //   establish recovery", reached for a spot five steps away, and died 1.4s later.
    //
    // And the measurement the ORIGINAL refusal was written from still stands: 2026-08-21,
    // three characters froze at 4, 10 and 13 health in a room of twelve to fifteen monsters
    // and all three died. The 2026-09-10 counter-case concedes its own characters "had no
    // way out either way" — which is an argument that the refusal did not kill them, not an
    // argument that the freeze saves anybody.
    //
    // A WALL IS STILL FINE, because there the freeze is half of a real sequence: reconnect,
    // TURN to set PFLAG_MOVED_SINCE_ENTRY, and heal. Off a wall there is no second half.
    if(!atWall){
      try { if(typeof this.fleetLogoff==='function'&&await this.fleetLogoff(why))return true; }
      catch(e) { this.note('cooperative logoff unavailable',{why:e.message}); }
    }
    if (!atWall && !this.playerThreatPresent()) {

      this.note('refusing to play dead in the open — it does not work on monsters', {
        why, health: s.client?.vitals?.()?.health?.value ?? null,
        at_wall: false, players_here: false,
        note: 'a freeze recovers vigor and never health, and off a wall there is no turn to ' +
              'arm regeneration with. The ladder falls through to something that MOVES',
      });
      // AND IT MUST LEAVE AN ACTIONABLE DECISION BEHIND, which the first version of this did
      // not. A caller that has already chosen `logoff_open` gets `false` back, and if nothing
      // replaces that decision the character sits on a strategy we have just refused to carry
      // out — refusing the freeze and then stranding the body is worse than freezing. The
      // failed-logoff path below chooses exactly this replacement; a refusal is a failure that
      // happened earlier, so it gets the same treatment.
      chooseSurvivalDecision(s, {
        strategy: 'nearest_refuge',
        reason: 'the open freeze does not work on monsters',
        reason_code: 'open_freeze_refused',
        mitigation: 'find a wall the formula accepts, or leave the room',
      }, { because: 'playing dead off a wall recovers vigor and never health', outcome: 'failed' });
      return false;
    }
    const journey=this.inert;
    if(journey?.travelling && !journey.cancelled && journey.to!=null && !this.suspendedJourney)
      this.suspendedJourney={to:journey.to,why:journey.why,at:Date.now(),trigger:why,
        attempts:(journey.attempts??0)+1,deaths_at:this.tally.deaths??0};
    if (atWall && this.hold?.reclaimed && this.turnedAt>=this.hold.takenAt
        && !(s.damagedAt>this.turnedAt)) {
      const active=currentSurvivalDecision(s);
      if (active?.strategy!=='rest_safe') chooseSurvivalDecision(s,{strategy:'rest_safe',reason:why,
        reason_code:'healing_already_armed',status:'recovering',chosen_refuge:this.hold,
        mitigation:'already logged back in and turned at this wall; preserve the running health timer'},
        {because:'logoff already accomplished; continue healing'});
      this.survivalInterruptedPass=this.passes;
      s.cancelMovement?.(null,'continue healing at the safe wall',{preserveId:currentSurvivalDecision(s)?.id,origin:keeperOrigin('play_dead')});
      return false;
    }
    const declined=this.logoffDeclined(why,atWall);
    if (declined) {
      const active=currentSurvivalDecision(s);
      if (active?.strategy!=='rest_safe') chooseSurvivalDecision(s,{strategy:'rest_safe',reason:why,
        reason_code:declined.code,status:'recovering',chosen_refuge:this.hold,
        mitigation:declined.why},{because:'a logoff would buy nothing here; rest at the wall'});
      // A reconnect clears PFLAG_MOVED_SINCE_ENTRY and only a turn sets it again; if the
      // last thing we did here was come back, the turn is still owed before rest pays.
      const rest=currentSurvivalDecision(s);
      if (rest?.strategy==='rest_safe' && this.rejoinedAt>(this.turnedAt??0))
        updateSurvivalDecision(s,rest.id,{phase:'turn_required'});
      this.survivalInterruptedPass=this.passes;
      s.cancelMovement?.(null,'rest at the safe wall instead of logging off',{preserveId:currentSurvivalDecision(s)?.id,origin:keeperOrigin('play_dead')});
      return false;
    }
    let d=currentSurvivalDecision(s);
    const strategy=atWall?'logoff_safe':'logoff_open';
    if (!d || d.strategy!==strategy || d.status!=='pending') d=chooseSurvivalDecision(s,{
      strategy,reason:why,reason_code:atWall?'safe_wall_top_priority':'break_engagement',
      chosen_refuge:atWall?this.hold:null},
      {because:atWall?'logoff is the first choice at the current safe wall':why,
        outcome:d?.arrived_at?'arrived':'cancelled'});
    updateSurvivalDecision(s,d.id,{status:'active',activated_at:Date.now(),path:[],path_length:0,
      path_source:'stationary logoff/reconnect',selected_at:Date.now()});
    let did=false;
    try { did=await this.playDeadObserved(why,d.id); }
    catch(e) { this.note('play dead failed',{why:e.message}); }
    if(currentSurvivalDecision(s)?.id===d.id) {
      if(did) updateSurvivalDecision(s,d.id,{status:'recovering',
        phase:this.frozenUntil>Date.now()?'frozen_without_action'
          :atWall?(this.turnedAt>=this.hold?.takenAt?'reconnected_turn_and_heal':'turn_required'):'frozen_without_action'});
      else {
        chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'logoff did not establish recovery',
          reason_code:'logoff_failed',mitigation:'seek another refuge before retrying'},
          {because:'logoff failed or made no progress',outcome:'failed'});
        // The failed logoff does not make a different refuge action unsafe to try.
        // continueSurvivalDecision drains this replacement in the current pass.
      }
    }
    return did;
  }

  // WHETHER A LOGOFF AT THIS WALL WOULD BUY ANYTHING. See LOGOFF_UNDER_ATTACK_MS for the
  // server's side of the bargain. Returns null to allow it, or {code, why} to rest instead.
  //
  // Only ever consulted AT a wall: the open freeze is already refused against monsters above,
  // and with a player in the room a logoff is the answer to a person, so both of those pass.
  // Below the flee line the "is anything hitting us" window is wider, because a body that
  // hurt should not bet on a quiet six seconds — but even there, nothing hitting us at a
  // wall that holds is a character that should be resting, not reconnecting.
  logoffDeclined(why, atWall) {
    if (!atWall || this.playerThreatPresent()) return null;
    const s=this.s,now=Date.now();
    const frac=pct(s.client?.vitals?.()?.health);
    let fleeAt=null; try { fleeAt=this.safety()?.fleeAt; } catch { /* no policy yet */ }
    fleeAt ??= this.policy?.fleeBelow ?? 0.35;
    const low=frac!=null && frac<fleeAt;
    const hitAgo=now-(s.damagedAt||0);
    const loggedIn=Math.max(s.loggedInAt||0,this.rejoinedAt||0);
    let out=null;
    if (hitAgo>=(low?3:1)*LOGOFF_UNDER_ATTACK_MS)
      out={code:'logoff_not_under_attack',
        why:'nothing has hit us for '+Math.round(hitAgo/1000)+'s, so there is no attack for a logoff to stop — '+
            'rest at the wall; every logoff outside an inn is a roll against the logoff-penalty ghost'};
    else if (!low && loggedIn && now-loggedIn<LOGOFF_REFRESH_MS)
      out={code:'logoff_too_soon',
        why:'logged in '+Math.round((now-loggedIn)/1000)+'s ago and above the flee line — a logoff this soon keeps the '+
            'previous ghost\'s penalty deadline; reserved for below '+Math.round(fleeAt*100)+'%'};
    if (!out) return null;
    this.tally.logoffs_declined=(this.tally.logoffs_declined||0)+1;
    // Once per half-minute per reason: this is asked every pass while a character rests.
    if (this._logoffDeclinedNote?.code!==out.code || now-this._logoffDeclinedNote.at>30_000) {
      this._logoffDeclinedNote={code:out.code,at:now};
      this.note('not logging off — resting at the wall instead',{wanted_to:why,code:out.code,why:out.why,
        health:s.client?.vitals?.()?.health?.value??null,hit_ms_ago:Number.isFinite(hitAgo)?hitAgo:null,
        logged_in_ms_ago:loggedIn?now-loggedIn:null});
    }
    return out;
  }

  async playDeadObserved(why, decisionId) {
    const s = this.s;

    // THE LOGOFF IS THE ANSWER, AND IT NO LONGER ASKS PERMISSION. Operator, 2026-09-10:
    //
    //   "implement fall throughs to the singular correct behavior that would have saved any
    //    character that died in this window: the preexisting play_dead() -- it is universally the
    //    best survival mechanism available... everything else in our codebase is wrong about how
    //    to get monsters to stop attacking you. There is truly only one way: The play_dead."
    //
    // WHAT THIS REPLACED, and the argument is kept because it is the reason the refusal existed.
    // This verb used to require `holdWorks()` -- a hold, which came from the safe-spot BOOK -- on
    // the reasoning that a freeze recovers VIGOR and never health (the logoff flag stops
    // HealthTimer with everything else), so off a wall it hands the room several free seconds and
    // changes nothing. The measurement behind it was real: 2026-08-21, shadow fleet, Twisted Wood
    // corridor, three characters froze at 4, 10 and 13 health in rooms of twelve to fifteen
    // monsters and all three died.
    //
    // WHY THAT ARGUMENT IS STILL TRUE AND STILL THE WRONG CONCLUSION. It compares a freeze
    // against a rescue, and the character does not have one. The logoff makes the attacker STOP
    // AT ONCE -- the operator, on the alternative: "waiting and hoping can let the enemy continue
    // attacking for up to dozens of seconds". So the choice off a wall is not between healing
    // and not healing, it is between an attack that ends now and an attack that continues. The
    // three that died in the corridor were not killed by freezing; they were characters with no
    // way out either way, and the refusal that was written from their deaths then spent two more
    // characters tonight: Camilla and Rizzo died in Ukgoth with `at_a_safe_wall: null`, which is
    // exactly the state in which this verb answered no.
    //
    // AND THE LEDGER IS OUT OF IT ENTIRELY. Operator, same message: "do *not* consult the safe
    // spot ledger regarding safe walls, use the formula". A hold proved from the book is a claim
    // that a square held BEFORE, which is not a claim that it holds now -- room 39 has 132 squares
    // tested and zero that held without later failing. Whether a square shelters is geometry, and
    // geometry is answered by `safeWalls`/`exposureAt` at the moment of asking.
    //
    // The one guard that remains is below and is about our OWN state, not about permission: a
    // reconnect clears PFLAG_MOVED_SINCE_ENTRY, so freezing again from a spot we have already
    // come back to and armed would undo the only thing making the last freeze worth anything.
    // WE ARE ALREADY BEHIND THE WALL WITH THE CLOCK RUNNING. DO NOT STOP IT.
    //
    // A reconnect clears PFLAG_MOVED_SINCE_ENTRY, so freezing again from a spot we have
    // already come back to and turned on would UNDO the one thing that made the last
    // freeze worth anything — we would go back to unreachable-and-healing-at-zero, which
    // is the state this whole branch exists to get out of.
    //
    // The livelock guard below catches this eventually, but only on the third attempt and
    // only by counting failures. This catches it on the first, and for the right reason:
    // there is nothing left for a freeze to buy here. Nothing can reach the square, and
    // the health timer is armed. Resting is strictly better, because it actually heals.
    if (this.hold?.reclaimed && this.turnedAt && this.turnedAt >= this.hold.takenAt
        && !(s.damagedAt>this.turnedAt)) {
      this.note('not freezing again — we are on the spot and already healing', {
        health: s.client?.vitals?.()?.health?.value ?? null,
        where: { col: this.hold.col, row: this.hold.row },
        armed_ms_ago: Date.now() - this.turnedAt,
        why: 'logging off would clear the moved-since-entry flag this spot was reclaimed to ' +
             'set, and playing dead recovers vigor and never health. Rest here instead.' });
      return false;      // the caller falls through to resting, which is what we want
    }

    // A FREEZE THAT CHANGED NOTHING MUST NOT BE REPEATED.
    //
    // Freezing buys safety by not acting, and the same flag that keeps the monsters
    // off also keeps HealthTimer off — so it recovers vigor and NEVER health. That is
    // the right trade exactly once. Do it twice from the same health and it is a
    // livelock: wake, see the same danger, freeze again, for ever, at four health,
    // reporting a sensible-looking journal line every eight seconds.
    //
    // So: remember the health we last froze at. If we are back here no better off,
    // the freeze is not working and the answer has to be something that moves.
    const nowHp = s.client?.vitals?.()?.health?.value ?? null;
    if (this.frozeAt != null && nowHp != null && nowHp <= this.frozeAt && !this.currentRecoveryWall()) {
      this.freezesWithoutGain = (this.freezesWithoutGain || 0) + 1;
      if (this.freezesWithoutGain >= 2) {
        this.note('refusing to freeze again — it is not helping', {
          health: nowHp, froze_at: this.frozeAt, times: this.freezesWithoutGain,
          why: 'playing dead recovers vigor and never health, so repeating it from the same ' +
               'health cannot ever end. Something that moves has to happen instead.' });
        return false;      // the caller falls through to withdrawing or resting
      }
    } else this.freezesWithoutGain = 0;
    this.frozeAt = nowHp;

    // TELL THE PILOT NOW, BEFORE THE RECONNECT — this is the only free moment there is.
    //
    // Speaking is not unconditionally an action. UserSayGroup, the handler behind a tell,
    // opens with:
    //
    //   % User took an action!  Wake any AIs in the room to the user's presence!
    //   if NOT (piFlags & PFLAG_MOVED_SINCE_ENTRY)
    //   { Send(self,@NotifyMonstersOfPresence); }        user.kod:4171
    //
    // The wake is GATED on the grace-period flag being clear. Right here the character
    // has been walking and swinging for minutes, so the flag is already set and the
    // branch does not run: the tell costs a point of mana and nothing else.
    //
    // Two lines further down, reconnect() re-enters the world and CLEARS that flag, and
    // from then until the unfreeze every word is a wake-up call to the whole room. So
    // "during the freeze" is precisely the window where a tell would kill the character
    // it is reporting on — and this, the moment the decision is taken, is both free and
    // the earliest the news can possibly travel. The character then sits still for ninety
    // seconds, which is time enough to walk over and watch it.
    this.debug = {
      what: 'frozen', label: DEBUG_STATES['frozen'], at: Date.now(), pass: this.passes,
      room: this.s.world?.room?.name ?? null, room_num: this.s.world?.room?.num ?? null,
      col: s.client?.self?.col ?? null, row: s.client?.self?.row ?? null,
      grid: this.s.world?.geometry ? { rows: this.s.world.geometry.rows, cols: this.s.world.geometry.cols } : null,
      bearing: this.s.world?.geometry && s.client?.self
        ? bearingIn(s.client.self.row, s.client.self.col,
                    this.s.world.geometry.rows, this.s.world.geometry.cols) : null,
      doing: 'about to play dead', mode: this.mode, hunting: this.policy.hunt ?? null,
      health: nowHp, health_max: s.client?.vitals?.()?.health?.max ?? null,
      vigor: vigorOf(s.client?.vitals?.() ?? {}), rest_ceiling: REST_VIGOR_CAP * skills.VIGOR_MAX,
      monsters: s.client?.room ? [...s.client.room.objects.values()].filter(o =>
        o.id !== s.client.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)).length : null,
      detail: { why, freeze_s: Math.round((this.policy.freezeMs ?? 90_000) / 1000),
                froze_at: this.frozeAt, times: this.freezesWithoutGain ?? 0,
                note: 'sent BEFORE the logoff — during the freeze a tell would wake the room' },
    };
    await this.tellPilot(this.debug).catch(() => {});
    // Keep our own copy: rejoin() renumbers everything, and observe() will not have
    // run again by the time we need to know where we were standing.
    const spot = this.hold ? { ...this.hold } : null;
    const inSpot = this.holdWorks();
    this.note('LOGGING OFF TO AVOID DYING', {
      why, health: s.client?.vitals?.()?.health,
      in_safe_spot: inSpot || undefined,
      how: inSpot
        ? 'disconnect, reconnect, and then deliberately turn — we come back standing in a spot ' +
          'nothing can reach us in, so waking the room costs nothing and buys the health timer'
        : 'disconnect, wait, reconnect, and then do NOTHING that counts as an action' });
    this.tally.logoffs = (this.tally.logoffs || 0) + 1;
    this.doing = 'recovering';
    // Invalidate the outstanding walk BEFORE reconnecting. Otherwise its next leg
    // immediately wakes the monsters the reconnect just put to sleep.
    this.survivalInterruptedPass = this.passes;
    s.cancelMovement?.(null, 'playing dead to avoid dying', {preserveId:decisionId,origin:keeperOrigin('play_dead')});

    const came = await this.reconnect('logging off rather than dying');
    if (!came.ok) {
      this.note('reconnect after logoff failed', { why: came.why });
      return false;
    }

    if (spot) {
      const me = s.client?.self;
      const back = me && me.col === spot.col && me.row === spot.row
        && s.world?.room?.num === spot.room && this.currentRecoveryWall();
      if (back) {
        this.hold = { ...spot, takenAt: Date.now(), quietMs: 0, reclaimed: true };
        this.tally.mulligans = (this.tally.mulligans || 0) + 1;

        // TURN. NOW. THIS IS THE WHOLE REASON A SAFE SPOT IS WORTH ANYTHING.
        //
        // A reconnect is a fresh entry into the room, so PFLAG_MOVED_SINCE_ENTRY comes
        // back CLEAR and HealthTimer awards nothing until something sets it again
        // (player.kod:5613). That is the same trade playing dead already made — safety
        // bought by not acting — and out in the open there is no way out of it, because
        // the only thing that arms the timer is moving and moving is what gets you hit.
        //
        // On a safe spot there is a way out, and it is the entire point of the spot: a
        // TURN sets the flag and gives up no ground. Nothing can reach this square, so
        // waking the room costs exactly nothing and buys the health timer. Standing here
        // unarmed is being unreachable and healing at zero — which looks identical to
        // working, and is how a character sits behind a wall that holds perfectly at four
        // health until something eventually changes around it.
        //
        // It happens HERE rather than being left to the rest branch on some later pass,
        // because there is no later pass at this health: playing dead recovers vigor and
        // never health, so the next round is still doomed and still sheltered and logs
        // off again. The turn only ever arrived on the third attempt, after
        // freezesWithoutGain tripped — two wasted logoffs at the health that could least
        // afford them.
        //
        // verify:false on purpose. The verifying path sleeps 300ms and then round-trips
        // room-contents, and comparing a position across up to 2.3 seconds of live combat
        // is what once reported a turn had "moved us off the square" and cost Animal a
        // proven spot he was standing on. We do not need the answer: REQ_TURN carries no
        // coordinates, and the next observe() reads the position anyway.
        const armed = await skills.turnInPlace(this.s, { verify: false })
                                  .catch(e => ({ turned: false, why: e.message }));
        if (armed.turned) this.turnedAt = Date.now();

        this.note('back on the safe spot', {
          where: { col: spot.col, row: spot.row }, proven: spot.proven,
          turned: armed.turned, facing: armed.to ?? null,
          plan: armed.turned
            ? 'health regeneration is armed and nothing can reach this square — rest to full here'
            : 'REST WILL PAY NOTHING until something sets the moved-since-entry flag',
          why: armed.turned
            ? 'a reconnect clears PFLAG_MOVED_SINCE_ENTRY, and a turn is the only thing that ' +
              'sets it again without giving up the square the walls are protecting'
            : 'the turn did not go through: ' + (armed.why || 'unknown') });
        // A turn that did not go through leaves us unreachable and healing at zero, which
        // is not a state to sit in quietly. Say so, and let the rest branch try again.
        if (!armed.turned) this.noProgress('back on the safe spot but could not turn to arm healing');
        return true;
      }
      // We came back somewhere else. Say so rather than carry on believing in a
      // square we are not standing on — every branch above trusts this flag.
      this.hold = null;
      this.note('did not come back on the safe spot', {
        expected: { col: spot.col, row: spot.row },
        actually: me ? { col: me.col, row: me.row } : null,
        why: 'falling back to staying completely still, which needs no geometry to work' });
    }

    // Frozen. Rest only — no movement, no turning, no looking around, and in
    // particular no room-contents request, because anything that reads as an action
    // hands the grace period back.
    this.frozenUntil = Date.now() + (this.policy.freezeMs ?? 90_000);
    this.freezeSample = { health: s.client?.vitals?.()?.health?.value ?? null,
      room: s.world?.room?.num ?? null,
      col: s.client?.self?.col ?? null, row: s.client?.self?.row ?? null };
    this.note('playing dead', {
      until_s: Math.round((this.frozenUntil - Date.now()) / 1000),
      note: 'monsters cannot attack until this character acts; resting is not an action' });
    return true;
  }

  // Ask other players for what the game will not give us.
  //
  // Rate-limited hard, because a broadcast costs a share of max mana and a keeper
  // loops every eight seconds; unthrottled this would be indistinguishable from
  // spam, and would empty the mana bar of the very character that needs it.
  //
  // AND OFF UNLESS ASKED FOR, since 2026-08-27. Twenty-one characters on a shared server,
  // each entitled to one "if anyone can spare a flask or cast a heal on me I would be in
  // your debt" every five minutes, is a fleet begging in public — the operator saw it from
  // the other side and ordered it stopped. Everything this does BEFORE the plea (re-equip,
  // conjure a blade) still runs: those fix the post-death case by themselves and cost
  // nobody anything. Only the asking is gated, on `askForHelp: true`.
  async askForHelp(reason = null) {
    const s = this.s, c = s.need();
    const PLEA_GAP_MS = 5 * 60 * 1000;
    if (this.lastPleaAt && Date.now() - this.lastPleaAt < PLEA_GAP_MS) return;

    // NOBODY NEEDS RESCUING IN AN INN.
    //
    // Being hurt is not being in danger, and broadcasting as though it were is both
    // embarrassing and expensive — it costs a share of maximum mana and it spends
    // other players' attention on a character that is in no trouble whatsoever.
    // Isolde did it from the middle of the Limping Toad, where monsters cannot attack
    // at all. The remedy there is entirely in our own hands: move, which is what arms
    // the regeneration timer, then sit down. That reaches full health and the 80
    // vigor that resting can reach, without anybody being asked for anything.
    //
    // (The pedantic exception is an assassin's game blade, which can strike you in an
    // inn — but it costs no health, no stats and no inventory, so it is not a reason
    // to call for help either.)
    //
    // Being unarmed after a death is different and still worth asking about: no
    // amount of resting produces a sword.
    const hurtOnly = /hurt|heal|flask/i.test(reason || '');
    if (hurtOnly && this.sanctuary()) {
      if (!this.quietedPleaIn || this.quietedPleaIn !== this.s.world?.room?.num) {
        this.quietedPleaIn = this.s.world?.room?.num ?? null;
        this.note('not asking for help — we are somewhere safe', {
          room: this.s.world?.room?.name, reason,
          why: 'nothing can attack us here, so being hurt is a wait rather than an emergency: ' +
               'moving arms the health timer and resting does the rest' });
      }
      return;
    }

    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

    let eq = await skills.equipBest(s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => null);
    // Before asking a stranger for a blade, try the one we can make. Charity is slow,
    // uncertain, and costs another player something; the spell costs 15 mana.
    if (!eq?.wielding && await this.makeWeapon('the alternative was begging a stranger for a blade')
                                  .catch(() => false))
      eq = await skills.equipBest(s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => eq);
    const armed = !!eq?.wielding;
    const where = c.rsc.get(c.roomNameRsc) || 'somewhere';
    const hurt = /hurt|heal|flask/i.test(reason || '');
    this.note(hurt ? 'asking for a heal' : 'recovering after death',
              { armed, wielding: eq?.wielding, room: where, reason });

    // Rearming solves the post-death case by itself; being hurt never does.
    if (armed && !hurt) { this.progress('rearmed after dying'); return; }

    // THE PLEA ITSELF IS OPT-IN. Same five-minute cadence as a plea would have had, so the
    // rearm attempts above stay as far apart as they always were; and said once in the
    // journal rather than never, because "why did nobody ask" is a question somebody will
    // put to this instrument.
    if (this.policy.askForHelp !== true) {
      this.lastPleaAt = Date.now();
      this.note('not asking for help — broadcasts are off', {
        reason, armed, room: where,
        why: 'askForHelp is not set on this character, and the default since 2026-08-27 is ' +
             'silence: a fleet on a shared server does not beg in public',
      });
      this.noProgress(hurt ? 'hurt with no way to heal — regenerating on the vigor timer, not broadcasting'
                           : 'dead broke and unarmed — not broadcasting for charity; passArm buys or conjures');
      return;
    }

    const v = c.vitals()?.health;
    const name = c.me?.name || 'a traveller';
    // PLAIN HYPHENS, NOT DASHES. The wire is Latin-1 (pstr in m59-client.mjs), and
    // Buffer.from(s, 'latin1') keeps the low byte of anything it cannot encode, so an
    // em-dash (U+2014) went out as 0x14 -- a control character in the middle of the one
    // sentence other players were asked to read.
    const plea = hurt
      ? `${name} here at ${where} - I am down to ${v ? `${v.value} of ${v.max}` : 'almost no'} health ` +
        `and I have nothing to heal with. Resting brings health back slowly in these lands. ` +
        `If anyone can spare a flask or cast a heal on me I would be in your debt.`
      : `${name} here - I was killed and lost everything. I am at ${where} with no weapon ` +
        `or armour. If anyone can spare a blade or a few shillings I would be grateful, ` +
        `and I will pay it forward once I am on my feet.`;
    this.lastPleaAt = Date.now();
    try {
      await s.pacer.submit('say', () => c.broadcast(plea));
      this.note('asked for help', { channel: 'broadcast', room: where });
    } catch (e) {
      // Broadcast costs a share of max mana and is refused when squelched; the
      // room is free and someone may well be standing in the inn.
      try { await s.pacer.submit('say', () => c.say(plea)); this.note('asked for help', { channel: 'say', room: where }); }
      catch { this.note('could not ask for help', { why: e.message }); }
    }
    this.noProgress(hurt ? 'hurt with no way to heal — waiting on a passer-by'
                         : 'dead broke and unarmed — waiting on charity');
  }

  // BUY THE INGREDIENTS, NOT THE MEAL, and only while we are already at a counter.
  //
  // Buying from a vendor pays their spread, which is why this is a top-up rather than
  // the supply plan: the fleet's own herbs are free and are handled by not selling them
  // in the first place. But `create food` refuses silently without 2 ElderBerry and 2
  // Herbs, and a character stuck at 80 vigor for want of four items is losing far more
  // than the markup. Bounded by reagentTarget and by walkingMoney, so it can never eat
  // the money a character needs to get home.
  async restockReagents(seller) {
    const s = this.s, c = s.need();
    if (!purchaseEnabled(this.policy, 'food') && !purchaseEnabled(this.policy, 'reagents')) return [];
    const pending = (reason, got = []) => Object.assign(got, { pending: true, reason });
    await this.makeRoomToBuy(seller?.id ?? seller).catch(() => {});
    if (this.travelInterrupted()) return pending('paused for survival');
    const before = c.evSeq;
    await s.pacer.submit('buy', () => c.buy(seller.id ?? seller));
    const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 });
    const shop = ev.events?.find(e => e.kind === 'shop');
    if (!shop) return pending('waiting for merchant prices');
    this.purchasePrices ??= new Map();
    for (const item of shop.items ?? [])
      if (Number.isFinite(item.cost) && item.cost >= 0)
        this.purchasePrices.set(purchaseKey(item.name), item.cost);
    const plan = this.shoppingPlan({ kind: 'restock', items: shop.items ?? [] });
    this.postShoppingPlan(plan);
    if (plan.unpriced.length) return pending('merchant price unreadable');
    if (!plan.lines.length) return [];
    const room = s.world?.room?.num;
    const funded = await this.ensurePurchaseFunds(plan);
    // Leaving the shop invalidates its seller and item IDs. Retry this purchase
    // after returning and reading a fresh quote, even if the bank supplied all cash.
    if (!funded.ready || funded.moved) return pending(funded.reason ?? 'return to merchant after banking');
    const count = name => this.packAsItems().filter(i => purchaseKey(i.name) === purchaseKey(name))
      .reduce((n, i) => n + i.amount, 0);
    const got = [];
    const byId = new Map(plan.lines.map(l => [Number(l.id), l]));
    for (const line of buyLines(plan.lines.map(l => ({ id: l.id, amount: l.amount })))) {
      if (this.travelInterrupted() || s.world?.room?.num !== room)
        return pending('purchase interrupted', got);
      const item = byId.get(line.id);
      if (this.purseNow() < item.unit_cost * line.amount + plan.reserve)
        return pending('purchase funding changed', got);
      const held = count(item.item);
      const purchaseBefore = c.evSeq;
      await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [line]));
      const inventoryBefore = c.evSeq;
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ since: inventoryBefore, kinds: ['inventory'], timeoutMs: 3000 });
      const gained = Math.min(line.amount, Math.max(0, count(item.item) - held));
      for (let n = 0; n < gained; n++) {
        got.push(`${item.item} @${item.unit_cost}`);
        this.recordPurchase(item.item, item.unit_cost, {
          kind: skills.shareKind(item.item) || (isFood(item.item) ? 'food' : null),
          from: seller?.nameRsc ? c.rsc.get(seller.nameRsc) : null,
          why: 'the posted shopping list, funded before purchase' });
      }
      if (gained < line.amount) {
        const refusal = (c.eventsSince?.(purchaseBefore) ?? []).find(e =>
          (e.kind === 'message' || (e.kind === 'said' && e.speaker === shop.sellerId)) &&
          /unable to give you[\s\S]*perhaps you carry too much/i.test(e.text ?? ''));
        if (refusal) {
          // Pending repeats this step every five seconds with the same full pack.
          // A confirmed capacity refusal ends this visit; missing receipts still retry.
          this.note('shopping stopped — merchant refused the carried load', { item: item.item, said: refusal.text });
          return got;
        }
        return pending('merchant did not deliver the requested quantity', got);
      }
    }
    this.postShoppingPlan(this.shoppingPlan());
    if (got.length) this.note('restocked from the funded shopping list', { bought: got });
    return got;
  }
  // @end 1
}
