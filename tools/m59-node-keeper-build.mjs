// Reload only a selected, leased character at room 2; the broker respawns its keeper.
import {resolveKeeperBand,discoverKeeperStates,keeperIdentityHeaders} from './runtime/keeper-discovery.mjs';
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
      return {reloaded:true,old_pid:identity.pid,new_pid:fresh.pid,before,after};
    if(after?.commit&&after.commit!==before?.commit)throw Error('replacement_keeper_build_mismatch');
  }
  throw Error('selected_keeper_reload_timeout');
}
