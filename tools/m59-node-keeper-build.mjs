// Reload only a selected, leased character at room 2. By HANDOFF when memory allows (the broker's
// war_restart: a replacement keeper logs in, nobody leaves the world); otherwise, said out loud,
// by the old addressed /stop, after which the broker's rejoin sweep respawns the keeper.
import {resolveKeeperBand,discoverKeeperStates,keeperIdentityHeaders} from './runtime/keeper-discovery.mjs';
import {decideRestartMode} from './m59-keeper-restart.mjs';
import {brokerLacksHandoff} from './m59-war-restart.mjs';
import {stateFileFor} from './m59-fleetpath.mjs';
export function keeperReloadProblem({position,identity,agent,character}) {
  if(position?.room!==2)return 'keeper_reload_requires_room2';
  if(!identity||identity.agent!==agent||identity.character!==character)return 'keeper_reload_identity_mismatch';
  return null;
}
export async function ensureNodeKeeperBuild({fleet,agent,character,expectedSha,call,log=console.log,
  timeoutMs=180000}) {
  const build=async()=> (await call('autopilot',{agent,action:'status'})).replay_capture?.provenance?.harness;
  const before=await build();
  if(before?.commit===expectedSha&&!before.dirty)return {reloaded:false,before,after:before};
  const band=resolveKeeperBand(fleet);
  const discover=()=>discoverKeeperStates({band,expectedAgents:[agent]});
  const found=await discover(),identity=found.identities.get(agent);
  const l=await call('look',{agent});
  const problem=keeperReloadProblem({position:{room:l.room?.num},identity,agent,character});
  if(problem)throw Error(problem);
  log(`reloading only ${agent} at room 2 to load ${expectedSha.slice(0,8)}`);
  const decision=decideRestartMode({concurrency:1});
  log(decision.message);
  if(decision.mode==='handoff'){
    let handed=null;
    try{handed=await call('war_restart',{fleet_state:stateFileFor(fleet),agents:[agent],concurrency:1,timeout_ms:90000});}
    catch(e){if(!brokerLacksHandoff(e))throw e;log(`LOGOFF RESTART: no keeper handoff on this broker (${e.message}); using stop-and-sweep`);}
    if(handed){
      const row=handed.results?.find(x=>x.agent===agent);
      if(!row?.ok)throw Error('selected_keeper_handoff_failed: '+(row?.why??'no result'));
      const after=await build().catch(()=>null);
      if(after?.commit===expectedSha&&!after.dirty)return {reloaded:true,mode:'handoff',old_pid:row.old_pid,new_pid:row.pid,before,after};
      throw Error('replacement_keeper_build_mismatch');
    }
  }
  const response=await fetch(`http://127.0.0.1:${identity.port}/stop`,{
    method:'POST',headers:{...keeperIdentityHeaders(identity),'content-type':'application/json'},
    body:JSON.stringify({agent,character,keeper_pid:identity.pid}),signal:AbortSignal.timeout(15000)});
  const stopped=await response.json();
  if(!response.ok||stopped.ok!==true)throw Error('selected_keeper_stop_refused');
  // The existing broker's normal rejoin sweep is the sole owner of respawning.
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    await new Promise(r=>setTimeout(r,5000));
    const fresh=(await discover()).identities.get(agent);
    if(!fresh||fresh.pid===identity.pid||fresh.character!==character)continue;
    const after=await build().catch(()=>null);
    if(after?.commit===expectedSha&&!after.dirty)
      return {reloaded:true,mode:'logoff',old_pid:identity.pid,new_pid:fresh.pid,before,after};
    if(after?.commit&&after.commit!==before?.commit)throw Error('replacement_keeper_build_mismatch');
  }
  throw Error('selected_keeper_reload_timeout');
}
