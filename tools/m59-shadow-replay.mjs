// One isolated shadow character, real Session/Autopilot, and the shared scene loader.
// No production RPC. Credentials are read locally, never emitted or put in a bundle.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {dm,resolve} from './m59-dm.mjs';
import {comparePlayerState} from './m59-scene-admin.mjs';
import {captureCachedScene} from './m59-scene-capture.mjs';
import {prepareScene} from './m59-scene-staging.mjs';
import {runtimeProvenance} from './m59-replay-worker.mjs';
import {AccountLeaseRegistry} from './runtime/account-leases.mjs';
import {claimFleetLock} from './runtime/fleet-lock.mjs';
import {configureLabEnvironment} from './runtime/lab-environment.mjs';
import {installLabGameGlobals} from './runtime/lab-game-globals.mjs';
import {attachSurvivalDecisions,currentSurvivalDecision,restoreSurvivalDecisionForReplay} from './m59-survival-decision.mjs';
import {installReplayVariant,REPLAY_STRATEGIES} from './m59-replay-variants.mjs';
import {resetNativeScene,inspectSceneContainer} from './m59-scene-reset.mjs';
import {createReplayPlayers,replayPlayerPlan} from './m59-replay-players.mjs';
import {loadoutForActor} from './m59-scene-loadout.mjs';
import {restoreReplayJourney,replayJourneyDestination,resumeReplayJourney} from './m59-replay-journey.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fileURLToPath(new URL('../',import.meta.url));
export function configureReplayEnvironment(selection,env=process.env) {
  const runtime=configureLabEnvironment(selection,env,{scope:`replay-${process.pid}`,fresh:true});
  env.M59_SURVIVAL_DECISION_DIR=path.join(runtime.runtimeDir,'decisions');
  env.M59_REPLAY_DIR=path.join(runtime.runtimeDir,'replays');
  return runtime;
}
export function replayEnvironmentReceipt(runtime,trialSequence,operationSequence) {
  return {fresh_scope:runtime.fresh,runtime_dir:runtime.runtimeDir,
    seed_inputs:structuredClone(runtime.seedInputs),seed_inputs_at:'environment_initialization',
    trial_sequence:trialSequence,operation_sequence:operationSequence,
    // Explicit in-process callers can keep module caches and learned state.
    // The default isolated adapter starts a fresh worker for every trial.
    reused_in_process:operationSequence>1};
}
export function attachReplayDecisionRecording(s,k,{execution,source,record}) {
  const code={commit:execution?.harness?.commit??null,
    source_sha256:execution?.harness?.source_sha256??null,dirty:execution?.harness?.dirty??null};
  const sourceCommit=source?.harness?.commit??null;
  // The capture identifies the old scene. New decisions belong to the code
  // executing this replay; resumed historical decisions retain their own epoch.
  attachSurvivalDecisions(s,{epoch:code.commit,
    onCancel:(why,d)=>k.replacementSurvivalChoice(why,d),
    record:event=>record({...event,replay_execution:{...code},source_scene_commit:sourceCommit})});
}
export function rebaseReplayTimes(value,delta) {
  if(Array.isArray(value))return value.map(x=>rebaseReplayTimes(x,delta));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,
    Number.isFinite(v)&&v>1e11&&/(?:at|since|until)$/i.test(key)?v+delta:rebaseReplayTimes(v,delta)]));
}
export function assertShadowReplayConfig(config,entry) {
  if(!config?.fleet_file||!config.agent)throw Error('replay config needs fleet_file and agent');
  const c=entry?.credentials;
  if(!['127.0.0.1','localhost','::1'].includes(c?.host)||![15959,17959].includes(Number(c?.port)))
    throw Error('replay refuses any roster entry outside the two explicit loopback lab ports');
  const admin=Number(c.port)===17959?17998:19998;
  if(config.admin_port!=null&&Number(config.admin_port)!==admin)throw Error('replay maintenance port must match its lab game port');
  if(config.admin_host!=null&&config.admin_host!=='127.0.0.1')throw Error('replay maintenance must be loopback');
}
export async function createShadowReplayAdapter({configFile,isolate=true,terminateAfterTrial=false}={}) {
  if(!configFile)throw Error('a shadow replay config is required; no fleet or character is chosen implicitly');
  const config=JSON.parse(await readFile(configFile,'utf8'));
  const fleetFile=path.resolve(path.dirname(configFile),config.fleet_file);
  const roster=JSON.parse(await readFile(fleetFile,'utf8')),entry=roster[config.agent];
  assertShadowReplayConfig(config,entry);
  if(isolate) {
    const {isolatedReplayAdapter}=await import('./m59-replay-isolation.mjs');
    return isolatedReplayAdapter({configFile:path.resolve(configFile),attest:()=>runtimeProvenance(root)});
  }
  const containerLab=Number(entry.credentials.port)===17959;
  const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:containerLab?'17998':'19998'};
  let serverAttestation=null,nativeSave=null,containerInfo=null,restoreReceipt=null,executionProvenance=null;
  let claim=null,leases=null,s=null,k=null,task=null,variantControl=null,staged=null,players=null,labState=null;
  const assumedHealth=new Map();let trialSequence=0,operationSequence=0,runtimeEnvironment=null;
  async function acquire() {
    operationSequence++;
    if(claim)return;
    const status=await dm(['show status'],{env});
    if(containerLab) {
      const info=containerInfo=inspectSceneContainer();
      if(!/Clients on port 5959, maintenance on port 9998/.test(status))throw Error('isolated scene maintenance endpoint did not attest');
      serverAttestation={image_id:info.Image,temporary_account_delete:info.Config.Labels?.['org.openai.m59.scene-accounts.delete']??null,
        source_commit:info.Config.Labels?.['org.openai.m59.scene-hold.source-commit']??null,
        patch_sha256:info.Config.Labels?.['org.openai.m59.scene-hold.patch-sha256']??null};
    }else if(!/Clients on port 15959, maintenance on port 19998/.test(status))throw Error('maintenance endpoint did not attest to shadow game port 15959');
    claim=claimFleetLock(fleetFile+'.lock');if(!claim.ok){claim=null;throw Error('shadow roster already owned; stop its existing owner before replaying');}
    const substrate=path.dirname(path.dirname(fleetFile));
    leases=new AccountLeaseRegistry({leaseDir:path.join(substrate,'runtime-account-leases'),
      legacyRosterRoots:[path.dirname(fleetFile)],legacyRosterPaths:[fleetFile]});
    const got=leases.acquireAll([{agent:config.agent,credentials:entry.credentials}]);
    if(!got.ok){claim.release();claim=null;throw Error('shadow account is already owned');}
    const selection={fleet:path.basename(fleetFile,'.json'),stateFile:fleetFile,
      entries:[{id:config.agent,...entry}]};
    runtimeEnvironment=configureReplayEnvironment(selection);
    labState=installLabGameGlobals(selection);
  }
  async function stopTrial() {
    players?.stop();
    s?.combat?.issue({action:'stop'});
    variantControl?.restore();variantControl=null;
    if(k)k.stop('replay trial ended',{hard:true});
    s?.cancelMovement?.(null,'replay trial ended',{replacement:{strategy:'yield_to_controller',status:'yielded'}});
    let done=true;
    if(task&&!terminateAfterTrial) {
      done=await Promise.race([task.then(()=>true,()=>true),sleep(12000).then(()=>false)]);
    }
    if(s){s.client?.stopKeepalive?.();s.client?.sock?.destroy?.();s.recorder?.stop?.();await s.replayRecorder?.close?.();await s.playerEvidence?.close?.();}
    if(k){const {dropAutopilot}=await import('./m59-autopilot.mjs');dropAutopilot(config.agent);}
    s=null;k=null;task=null;
    try {await staged?.cleanup();staged=null;}finally{await players?.close();players=null;}
    if(!done)throw Error('previous trial did not stop; socket closed and refusing further trials');
  }
  async function resetNativeWorld() {
    if(!config.native_snapshot)return;
    if(!containerLab)throw Error('native world reset is limited to the owned isolated scene container');
    const snapshot=path.resolve(path.dirname(configFile),config.native_snapshot);
    restoreReceipt=await resetNativeScene({snapshot,mode:config.native_restore??'auto',env,info:containerInfo});
    nativeSave=restoreReceipt.manifest;
    // acquire() is normally called in a fresh process. Explicit in-process callers
    // must re-attest after a cold reset rather than reusing the old start time.
    containerInfo=null;
  }
  return {
    attest:async()=>runtimeProvenance(root),
    async reset(){await acquire();await stopTrial();await resetNativeWorld();},
    async capture() {
      await acquire();await stopTrial();
      const {Session}=await import('./m59-game.mjs');s=new Session(config.agent);
      await s.join(entry.credentials);await s.firstAbilityRead;
      return captureCachedScene(s,null,{provenance:runtimeProvenance(root)});
    },
    async run({scene,variant,horizonMs,frame,onPrepared,onStarted,pvp=null}) {
      const playerOptions=pvp??config.pvp??{},playerPlan=replayPlayerPlan(scene,playerOptions);
      const timings={},began=performance.now();let checkpoint=began;
      const lap=name=>{const now=performance.now();timings[name]=now-checkpoint;checkpoint=now;};
      await acquire();lap('ownership_and_attestation_ms');
      await stopTrial();lap('previous_cleanup_ms');
      await resetNativeWorld();lap('native_restore_ms');trialSequence++;
      const runtime_environment=replayEnvironmentReceipt(runtimeEnvironment,trialSequence,operationSequence);
      const {Session}=await import('./m59-game.mjs');
      const {autopilotFor}=await import('./m59-autopilot.mjs');
      const skills=await import('./m59-skills.mjs');
      lap('engine_import_ms');
      // Cache with the imported engine, not with a later mutable checkout HEAD.
      executionProvenance??=runtimeProvenance(root);lap('execution_provenance_ms');
      s=new Session(config.agent);s.replayFastReads=containerLab&&config.fast_reads!==false;
      await s.join(entry.credentials);lap('login_and_initial_reads_ms');
      const abilityRead=await s.firstAbilityRead;
      if(!abilityRead)throw Error('replay setup did not complete the initial ability read');
      lap('ability_reads_ms');
      s.replayServerAttestation=serverAttestation;
      k=autopilotFor(s);k.mode=scene.controller?.mode??'survive';
      Object.assign(k.policy,structuredClone(scene.controller?.policy??{}));
      k.applyLoadoutPolicyOverlay=()=>null; // the saved effective policy is this trial's input
      const decisions=[],suppressed=[],assumptions=[];
      attachReplayDecisionRecording(s,k,{execution:executionProvenance,source:scene.provenance,
        record:r=>{decisions.push(r);s.replayRecorder?.decision(r);}});
      const input=structuredClone(scene);
      const victim=input.actors.find(a=>a.mine),victimLoadout=loadoutForActor(victim,playerOptions.loadouts);
      if(victimLoadout&&!config.native_snapshot)throw Error('restoring the replay victim loadout requires a native snapshot for trial reset');
      if(victimLoadout)victim.loadout=victimLoadout;
      let player_state=comparePlayerState(input.actors.find(a=>a.mine),captureCachedScene(s,k).actors.find(a=>a.mine));
      if(victimLoadout)player_state={ok:true,faithful:false,original_check:player_state,
        mode:'explicit supplied loadout; shared staging must verify before start'};
      if(!player_state.ok&&playerPlan.enabled&&playerPlan.allow_approximate_player) {
        player_state={ok:true,faithful:false,original_check:player_state,
          mode:'explicit shadow loadout approximation'};
        assumptions.push('victim inventory/equipment/abilities use the selected shadow account; captured state differs');
      }
      if(!player_state.ok)return {outcome:'invalid_player_state',player_state,decisions,assumptions,runtime_environment};
      players=await createReplayPlayers({scene:input,options:playerOptions,env,attestation:serverAttestation,
        leases,labState,Session,nativeSnapshot:!!config.native_snapshot});
      if(players)assumptions.push(...playerPlan.assumptions);
      for(const actor of input.actors) {
        const key=actor.key??actor.name;
        if(actor.vitals?.hp?.how==='unknown'&&assumedHealth.has(key))actor.vitals.hp={v:assumedHealth.get(key),how:'estimated'};
      }
      lap('controller_and_player_check_ms');
      staged=await prepareScene(input,{env,classes:config.classes,options:variant.reload??{},
        requireNativeHold:config.require_native_hold===true,resolveActor:async actor=>{
          if(actor.mine)return s.client.selfId;
          if(actor.kind!=='player')return null;
          if(players)return players.resolve(actor);
          const name=config.players?.[actor.name];
          if(!name)throw Error(`player ${actor.name} needs an explicit shadow stand-in`);
          assumptions.push('other player bodies restored; their future inputs are unknown');
          return (await resolve([name],{env}))[name];
        }});
      lap('scene_prepare_ms');
      const {scene:prepared,bindings,loaded}=staged;
      for(const actor of prepared.actors)if(actor.vitals?.hp?.how==='estimated')assumedHealth.set(actor.key??actor.name,actor.vitals.hp.v);
      assumptions.push(...loaded.preparation.assumptions);
      if(!loaded.ok)return {outcome:'invalid_load',loaded,decisions,assumptions,runtime_environment};
      await s.pacer.submit('read',()=>s.client.roomContents());
      await s.pacer.submit('read',()=>s.client.stats(1));await sleep(250);
      if(victimLoadout){s.client.abilities.clear();await (await import('./m59-abilities.mjs')).readLive(s);
        await s.pacer.submit('read',()=>s.client.requestInventory());}
      await players?.sync({target:s});
      lap('client_scene_sync_ms');
      // These are known omissions, never silently promoted into an exact server save.
      assumptions.push('server RNG and timer phases not restored; scene actors are released onto new timers');
      let before=Date.now();const delta=before-(frame?.at??before),control=prepared.controller??{};
      k.hold=rebaseReplayTimes(control.hold??null,delta);
      const controller_restore={journey:restoreReplayJourney(k,{
        inert:rebaseReplayTimes(control.inert??null,delta),
        suspendedJourney:rebaseReplayTimes(control.suspended_journey??null,delta)})};
      k.turnedAt=control.turned_at?control.turned_at+delta:null;
      k.frozenUntil=control.frozen_until?control.frozen_until+delta:null;
      k.freezeSample=structuredClone(control.freeze_sample??null);
      k.doing=control.doing??null;
      k.frozeAt=control.froze_at??null;
      k.freezesWithoutGain=control.freezes_without_gain??0;
      restoreSurvivalDecisionForReplay(s,control.decision,{capturedAt:frame?.at??before});
      variantControl=installReplayVariant(k,variant,{onEvent:r=>suppressed.push(r)});
      k.replayStartActions=(control.start_actions??[]).map(action=>({...action,actor_key:`body-${bindings.get(action.actor_key)}`}));
      await onPrepared?.(s,k,staged);
      const hpTrace=[],victimMessages=[];
      if(players) {
        const noteHealth=s.noteHealth,noteCombatLine=s.noteCombatLine;
        s.noteHealth=function(ev){
          hpTrace.push({at:ev.at??Date.now(),hp:ev.value,source:'server_push',room:this.world?.room?.num,
            row:this.client?.self?.row??null,col:this.client?.self?.col??null});
          return noteHealth.call(this,ev);
        };
        s.noteCombatLine=function(ev){victimMessages.push({at:ev.at,text:ev.text});return noteCombatLine.call(this,ev);};
      }
      await players?.verifyGuilds();
      const release=await staged.start();
      if(!release.ok)return {outcome:'invalid_release',loaded,release,decisions,assumptions,runtime_environment};
      controller_restore.pvp_survival = s.combat.restorePvPForReplay(control.pvp_survival,
        frame?.at??before, players?.playerNames());
      players?.start({target:s,horizonMs,at:release.at});
      await onStarted?.(s,k);
      lap('controller_restore_and_start_ms');
      timings.restore_to_start_ms=performance.now()-began;
      before=release.at;
      let lastRoom=scene.room.num,outcome='survived_window',elapsed=null,error=null,replayed_journey=null;
      const execute=async()=>{
        // A restored in-flight refuge approach needs its watchdog from the first
        // step, just as production did. Starting it after that await misses the
        // very cancellation and damage response the replay is meant to test.
        k.running=true;k.stopping=false;k.startedAt=Date.now();k.startWatchdog();
        for(const action of control.start_actions??[]) {
          if(action.kind!=='attack'||!bindings.has(action.actor_key))throw Error('unsupported or unbound scene start action');
          await s.pacer.submit('attack',()=>s.client.attack(bindings.get(action.actor_key)));
        }
        k.replayStartActions=null;
        if(variant.kind==='enable') {
          if(!REPLAY_STRATEGIES.includes(variant.strategy)||variant.strategy==='rest_safe')throw Error('unsupported enabled strategy; rest_safe requires an already armed recovery checkpoint');
          if(variant.strategy.startsWith('logoff'))await k.playDead('replay: enable intervention at checkpoint');
          else await k.takeRecoverySpot('replay: enable intervention at checkpoint',{route:variant.strategy==='route_refuge'});
        }
        const restored=currentSurvivalDecision(s);
        if(restored?.status==='approaching'&&restored.chosen_refuge) {
          const arrived=await skills.returnToSpot(s,restored.chosen_refuge);
          if(arrived.arrived)await k.playDead(restored.reason);
          assumptions.push('an in-flight approach was resumed from its captured refuge; JavaScript stack was not snapshotted');
        }
        const destination=replayJourneyDestination(control);
        k.running=true;k.stopping=false;k.startedAt=Date.now();k.startWatchdog();
        if(destination!=null&&!currentSurvivalDecision(s)) {
          assumptions.push('captured journey restarted through keeper travel; route replanned and per-journey stop counters restarted');
          replayed_journey=await resumeReplayJourney(k,destination,control.inert?.why);
        }
        await k.loop();
      };
      task=execute().catch(e=>{error=e.message;});
      const deaths=k.tally.deaths??0;
      while(Date.now()-before<horizonMs) {
        const room=s.world?.room?.num,hp=s.client?.vitals?.()?.health;
        if(players&&hpTrace.at(-1)?.hp!==(hp?.value??null))hpTrace.push({at:Date.now(),hp:hp?.value??null,
          room,row:s.client?.self?.row??null,col:s.client?.self?.col??null});
        if(room===1||hp?.value===0||(k.tally.deaths??0)>deaths){outcome='died';elapsed=Date.now()-before;break;}
        if(room!=null)lastRoom=room;
        if(error)break;
        await sleep(100);
      }
      elapsed??=Date.now()-before;
      const hp=s.client?.vitals?.()?.health;
      if(outcome!=='died'&&decisions.some(r=>r.event==='finished'&&r.decision.outcome==='recovered'))outcome='recovered';
      const result={outcome: error?'error':outcome,error,elapsed_ms:elapsed,death_room:outcome==='died'?lastRoom:null,
        execution_provenance:structuredClone(executionProvenance),source_scene_provenance:structuredClone(scene.provenance??null),
        final_hp:hp,loaded,release,player_state,controller_restore,replayed_journey,
        decisions:structuredClone(decisions),suppressed,assumptions,trial_sequence:trialSequence,runtime_environment,
        pvp_survival:s.combat.pvpStatus(),
        ...(players?{pvp:players.snapshot(),victim_hp_trace:hpTrace,
          victim_messages:victimMessages}:{}),
        server_attestation:serverAttestation,native_save:nativeSave?{stamp:nativeSave.stamp,files:nativeSave.files}:null,
        native_restore:restoreReceipt?{method:restoreReceipt.method,account_state:restoreReceipt.account_state}:null,
        intervention_applied:variant.kind==='disable'||variant.kind==='continue'?suppressed.length>0:
          variant.kind==='enable'?decisions.some(r=>r.decision?.activated_at!=null):true};
      lap('simulation_ms');
      await stopTrial();lap('cleanup_ms');
      timings.total_ms=performance.now()-began;result.timings=timings;return result;
    },
    async close(){try{await stopTrial();}finally{leases?.releaseAll();claim?.release();claim=null;}},
  };
}
