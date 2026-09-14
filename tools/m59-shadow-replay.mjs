// One isolated shadow character, real Session/Autopilot, and the shared scene loader.
// No production RPC. Credentials are read locally, never emitted or put in a bundle.
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
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
import {verifyServerSave} from './runtime/server-save-set.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fileURLToPath(new URL('../',import.meta.url));
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
  let serverAttestation=null,nativeSave=null;
  let claim=null,leases=null,s=null,k=null,task=null,variantControl=null,staged=null;
  const assumedHealth=new Map();let trialSequence=0;
  async function acquire() {
    if(claim)return;
    const status=await dm(['show status'],{env});
    if(containerLab) {
      const [info]=JSON.parse(execFileSync('docker',['inspect','m59-replay-lab'],{encoding:'utf8'}));
      const ports=info.NetworkSettings.Ports;
      if(info.Config.Labels?.['org.openai.m59.scene-lab']!=='true'||
        !ports['5959/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='17959')||
        !ports['9998/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort==='17998')||
        !/Clients on port 5959, maintenance on port 9998/.test(status))throw Error('isolated scene container identity/ports did not attest');
      serverAttestation={image_id:info.Image,source_commit:info.Config.Labels?.['org.openai.m59.scene-hold.source-commit']??null,
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
    configureLabEnvironment(selection,process.env,{scope:`replay-${process.pid}`});
    process.env.M59_SURVIVAL_DECISION_DIR=path.join(process.env.M59_LAB_RUNTIME_DIR,'decisions');
    process.env.M59_REPLAY_DIR=path.join(process.env.M59_LAB_RUNTIME_DIR,'replays');
    installLabGameGlobals(selection);
  }
  async function stopTrial() {
    variantControl?.restore();variantControl=null;
    if(k)k.stop('replay trial ended',{hard:true});
    s?.cancelMovement?.(null,'replay trial ended',{replacement:{strategy:'yield_to_controller',status:'yielded'}});
    let done=true;
    if(task&&!terminateAfterTrial) {
      done=await Promise.race([task.then(()=>true,()=>true),sleep(12000).then(()=>false)]);
    }
    if(s){s.client?.stopKeepalive?.();s.client?.sock?.destroy?.();s.recorder?.stop?.();await s.replayRecorder?.close?.();}
    if(k){const {dropAutopilot}=await import('./m59-autopilot.mjs');dropAutopilot(config.agent);}
    s=null;k=null;task=null;
    await staged?.cleanup();staged=null;
    if(!done)throw Error('previous trial did not stop; socket closed and refusing further trials');
  }
  async function resetNativeWorld() {
    if(!config.native_snapshot)return;
    if(!containerLab)throw Error('native world reset is limited to the owned isolated scene container');
    const snapshot=path.resolve(path.dirname(configFile),config.native_snapshot);nativeSave=verifyServerSave(snapshot);
    // acquire() has attested the exact container/port mapping before this point.
    await dm(['terminate save'],{env});
    execFileSync('docker',['wait','m59-replay-lab'],{timeout:20000,stdio:'pipe'});
    execFileSync(process.execPath,[path.join(root,'tools/m59-scene-server-save.mjs'),'restore',snapshot,'--container','m59-replay-lab'],{timeout:30000,stdio:'pipe'});
    execFileSync('docker',['start','m59-replay-lab'],{timeout:20000,stdio:'pipe'});
    execFileSync('docker',['exec','--user','root','m59-replay-lab','chown','-R','blak:blak','/m59/savegame'],{timeout:10000,stdio:'pipe'});
    for(let i=0;i<30;i++) {
      try{if((await dm(['show status'],{env,timeoutMs:1000})).includes('System Status'))return;}catch{}
      await sleep(200);
    }
    throw Error('isolated server did not return after native world restore');
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
    async run({scene,variant,horizonMs,frame,onPrepared,onStarted}) {
      await acquire();await stopTrial();await resetNativeWorld();trialSequence++;
      const {Session}=await import('./m59-game.mjs');
      const {autopilotFor}=await import('./m59-autopilot.mjs');
      const skills=await import('./m59-skills.mjs');
      s=new Session(config.agent);await s.join(entry.credentials);await s.firstAbilityRead;
      s.replayServerAttestation=serverAttestation;
      k=autopilotFor(s);k.mode=scene.controller?.mode??'survive';
      Object.assign(k.policy,structuredClone(scene.controller?.policy??{}));
      k.applyLoadoutPolicyOverlay=()=>null; // the saved effective policy is this trial's input
      const decisions=[],suppressed=[],assumptions=[];
      attachSurvivalDecisions(s,{epoch:scene.provenance?.harness?.commit??null,
        onCancel:(why,d)=>k.replacementSurvivalChoice(why,d),record:r=>{decisions.push(r);s.replayRecorder?.decision(r);}});
      const input=structuredClone(scene);
      const player_state=comparePlayerState(input.actors.find(a=>a.mine),captureCachedScene(s,k).actors.find(a=>a.mine));
      if(!player_state.ok)return {outcome:'invalid_player_state',player_state,decisions,assumptions};
      for(const actor of input.actors) {
        const key=actor.key??actor.name;
        if(actor.vitals?.hp?.how==='unknown'&&assumedHealth.has(key))actor.vitals.hp={v:assumedHealth.get(key),how:'estimated'};
      }
      staged=await prepareScene(input,{env,classes:config.classes,options:variant.reload??{},
        requireNativeHold:config.require_native_hold===true,resolveActor:async actor=>{
          if(actor.mine)return s.client.selfId;
          if(actor.kind!=='player')return null;
          const name=config.players?.[actor.name];
          if(!name)throw Error(`player ${actor.name} needs an explicit shadow stand-in`);
          assumptions.push('other player bodies restored; their future inputs are unknown');
          return (await resolve([name],{env}))[name];
        }});
      const {scene:prepared,bindings,loaded}=staged;
      for(const actor of prepared.actors)if(actor.vitals?.hp?.how==='estimated')assumedHealth.set(actor.key??actor.name,actor.vitals.hp.v);
      assumptions.push(...loaded.preparation.assumptions);
      if(!loaded.ok)return {outcome:'invalid_load',loaded,decisions,assumptions};
      await s.pacer.submit('read',()=>s.client.roomContents());
      await s.pacer.submit('read',()=>s.client.stats(1));await sleep(250);
      // These are known omissions, never silently promoted into an exact server save.
      assumptions.push('server RNG and timer phases not restored; scene actors are released onto new timers');
      let before=Date.now();const delta=before-(frame?.at??before),control=prepared.controller??{};
      k.hold=rebaseReplayTimes(control.hold??null,delta);
      k.inert=rebaseReplayTimes(control.inert??null,delta);
      k.suspendedJourney=rebaseReplayTimes(control.suspended_journey??null,delta);
      k.turnedAt=control.turned_at?control.turned_at+delta:null;
      k.frozenUntil=control.frozen_until?control.frozen_until+delta:null;
      k.freezeSample=structuredClone(control.freeze_sample??null);
      restoreSurvivalDecisionForReplay(s,control.decision,{capturedAt:frame?.at??before});
      variantControl=installReplayVariant(k,variant,{onEvent:r=>suppressed.push(r)});
      k.replayStartActions=(control.start_actions??[]).map(action=>({...action,actor_key:`body-${bindings.get(action.actor_key)}`}));
      await onPrepared?.(s,k,staged);
      const release=await staged.start();
      if(!release.ok)return {outcome:'invalid_release',loaded,release,decisions,assumptions};
      await onStarted?.(s,k);
      before=release.at;
      let lastRoom=scene.room.num,outcome='survived_window',elapsed=null,error=null;
      const execute=async()=>{
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
        const destination=control.inert?.travelling?control.inert.to:control.suspended_journey?.to;
        k.running=true;k.stopping=false;k.startedAt=Date.now();k.startWatchdog();
        if(destination!=null&&!currentSurvivalDecision(s)) {
          k.goTravelling(control.inert?.why??'replayed journey',{to:destination});
          const travel=s.travel(destination);await travel;
        }
        await k.loop();
      };
      task=execute().catch(e=>{error=e.message;});
      const deaths=k.tally.deaths??0;
      while(Date.now()-before<horizonMs) {
        const room=s.world?.room?.num,hp=s.client?.vitals?.()?.health;
        if(room===1||hp?.value===0||(k.tally.deaths??0)>deaths){outcome='died';elapsed=Date.now()-before;break;}
        if(room!=null)lastRoom=room;
        if(error)break;
        await sleep(100);
      }
      elapsed??=Date.now()-before;
      const hp=s.client?.vitals?.()?.health;
      if(outcome!=='died'&&decisions.some(r=>r.event==='finished'&&r.decision.outcome==='recovered'))outcome='recovered';
      const result={outcome: error?'error':outcome,error,elapsed_ms:elapsed,death_room:outcome==='died'?lastRoom:null,
        final_hp:hp,loaded,player_state,decisions:structuredClone(decisions),suppressed,assumptions,trial_sequence:trialSequence,
        server_attestation:serverAttestation,native_save:nativeSave?{stamp:nativeSave.stamp,files:nativeSave.files}:null,
        intervention_applied:variant.kind==='disable'||variant.kind==='continue'?suppressed.length>0:
          variant.kind==='enable'?decisions.some(r=>r.decision?.activated_at!=null):true};
      await stopTrial();return result;
    },
    async close(){try{await stopTrial();}finally{leases?.releaseAll();claim?.release();claim=null;}},
  };
}
