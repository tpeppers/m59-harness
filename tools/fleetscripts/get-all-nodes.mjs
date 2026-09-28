// Acquire the promoted node-runner circuit's missing/unknown nodes, then return to room 2.
import {act,verify,holdKeeper} from '../m59-fleetscript.mjs';
import {asAgents} from '../m59-fleetlib.mjs';
import {runTour} from '../m59-node-tour.mjs';
import {booleanOption,selectCircuitNodes} from '../m59-node-circuit.mjs';
import {readNodeMemory} from '../m59-node-memory.mjs';
import {railIdentityProblem} from '../m59-node-tour-policy.mjs';
import {rosterGameEndpoint,stateFileFor} from '../m59-fleetpath.mjs';
import {ensureNodeKeeperBuild} from '../m59-node-keeper-build.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const checked=(fn,why,always=false)=>({...verify(async ctx=>{
  try{return await fn(ctx);}catch(e){ctx.state.nodeFailure=e.message;console.error('GET ALL NODES: '+e.message);return false;}
},why),...(always?{always:true}:{})});
export const nodeCircuitScript=name=>({name,describe:'From room 2, acquire missing/unknown supported nodes and return; getAll=true ignores cache skips',
  params:{agents:{type:'agents',required:true},getAll:{type:'boolean',default:false},
    expectedGame:{type:'string'},railFile:{type:'string',default:'substrate/node-tour-rails.json'},
    evidenceDir:{type:'string',default:'substrate/node-tours'},minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20}},
  async steps(params){
    if(asAgents(params.agents).length!==1)throw Error('get-all-nodes takes one character at a time; use the serial campaign for a fleet');
    const options={...params,getAll:booleanOption(params.getAll),useCache:true};
    return [checked(async({agent,call,state})=>{
      const l=await call('look',{agent});if(l.room?.num!==2)throw Error('get-all-nodes starts in room 2');
      const h=await(await fetch(new URL('health',process.env.M59_CONTROL_URL))).json();
      const problem=railIdentityProblem({fleet:h.fleet,agent,health:h,expectedGame:options.expectedGame,
        rostered:rosterGameEndpoint(stateFileFor(h.fleet)),checkedRail:true});
      if(problem)throw Error(problem);
      const server=h.session_game_servers?.[agent]??h.game_server;
      const memory=await readNodeMemory({server:server.host+':'+server.port,character:h.session_characters?.[agent]});
      state.nodeSetupReady=true;
      if(!selectCircuitNodes(memory,{getAll:options.getAll}).selected.length)return true;
      const build=await ensureNodeKeeperBuild({fleet:h.fleet,agent,character:h.session_characters?.[agent],call,
        expectedSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()});
      if(build.reloaded){state.nodeReplacementHold=await holdKeeper({name:name+' (public)',log:console.log},agent,h.fleet);
        if(!state.nodeReplacementHold.ok)throw Error('replacement_keeper_lease_refused');}
      state.nodeSetupReady=true;return true;
    },'node circuit preparation failed'),
    act('rest',{stand:true}),
    checked(async ctx=>{const ok=await runTour(ctx,options);ctx.state.nodeAcquisition=ctx.state.tour;return ok;},'selected node circuit stopped; inspect receipt'),
    checked(async ctx=>{
      if(!ctx.state.nodeSetupReady)return true;
      const l=await ctx.call('look',{agent:ctx.agent});
      if(l.room?.num===2)return true;
      return runTour(ctx,{...options,recovery:true});
    },'node circuit return failed; inspect recovery receipt',true),
    checked(async({state})=>{await state.nodeReplacementHold?.release();return true;},'keeper lease release failed',true)];
  }
});
export const script=nodeCircuitScript('get-all-nodes');
