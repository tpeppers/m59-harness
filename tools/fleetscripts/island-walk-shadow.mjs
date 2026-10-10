// #movement: lab setup and cleanup around the ordinary island-walk recipe.
import {act,verify} from '../m59-fleetscript.mjs';
import {walkIsland,MAIN_CAVES,pause,location,reportIslandOutbound,waitIslandOutbound,releaseIslandWave} from '../m59-island-route.mjs';
import {relocate,heal,dm,sendMsg} from '../m59-dm.mjs';
import {resolveRoom} from '../m59-scene.mjs';
import {readAdminRoom} from '../m59-scene-admin.mjs';
import {writeFileSync} from 'node:fs';
import {retainShadowIslandDispel} from '../m59-island-lab-dispel.mjs';
import {checkIslandCancellation} from '../m59-island-finewalk.mjs';
const sleep=pause;
let quietScene=null;
async function claimQuiet(state){
  if(!quietScene){
    const shared={refs:0,scene:[]};quietScene=shared;
    shared.ready=(async()=>{for(const room of MAIN_CAVES){
      const scene=await readAdminRoom(room),generation=scene.properties.pbgeneratemonsters?.value;
      shared.scene.push({room,generation});
      if(generation!=null)await dm([sendMsg(scene.room_object,'SetMonsterGeneration',{bValue:['INT',0]})]);
      await dm(scene.actors.filter(o=>o.properties.pihit_points!=null&&o.properties.pibehavior!=null&&!(o.properties.pibehavior.value&1)).map(o=>sendMsg(o.id,'Delete')));
    }})();
  }
  const shared=quietScene;shared.refs++;state.quietScene=shared;await shared.ready;
}
async function releaseQuiet(state){
  const shared=state.quietScene;if(!shared)return;state.quietScene=null;
  if(--shared.refs>0)return;
  for(const s of shared.scene)if(s.generation!=null)await dm([sendMsg(await resolveRoom(s.room),'SetMonsterGeneration',{bValue:['INT',s.generation]})]);
  if(quietScene===shared)quietScene=null;
}
export const script={name:'island-walk-shadow',describe:'Isolated cave/island rehearsal; quiet geometry mode is explicit',
  params:{agents:{type:'agents',required:true},direction:{type:'string',default:'out'},roundtrip:{type:'boolean',default:false},
    quiet:{type:'boolean',default:false},budgetMs:{type:'number',default:180000},stageRow:{type:'number'},stageCol:{type:'number'},
    departSpacingMs:{type:'number',default:30000},
    fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1},minVigor:{type:'number',default:120}},
  async steps(p){
    const safe=(fn,why,always=false)=>({...verify(async ctx=>{try{return await fn(ctx);}catch(e){console.log('ISLAND ERROR '+e.stack);return {ok:false,why:e.message};}},why),always});
    return [act('cancel_movement',{}),act('autopilot',{action:'busy',kind:'fleetscript',label:'island-walk-shadow',lease_ms:120000}),
      safe(async ctx=>{
        const {agent,call,state}=ctx,h=await(await fetch(process.env.M59_CONTROL_URL+'health')).json();
        if(h.fleet!=='shadow'||h.game_server.host!=='127.0.0.1'||h.game_server.port!==15959||!h.session_characters[agent])throw Error('wrong lab identity');
        const character=h.session_characters[agent];state.character=character;state.scene=[];
        if(p.quiet)await claimQuiet(state);
        const agents=Array.isArray(p.agents)?p.agents:String(p.agents).split(',');
        state.islandCancelFence=Date.now();
        const departure=Date.now()+Math.max(0,agents.indexOf(agent))*Math.max(0,p.departSpacingMs);
        while(Date.now()<departure){
          await sleep(Math.min(5000,departure-Date.now()));
          checkIslandCancellation(ctx,await call('status',{agent,brief:true}));
        }
        const room=p.direction==='back'?2000:27,row=p.stageRow??(room===27?23:41),col=p.stageCol??(room===27?16:52);
        await heal(character);await relocate(character,room,{row,col,verify:true});state.releaseDispel=await retainShadowIslandDispel();await sleep(1200);
        // Keep the permitted illusion open while this experiment runs, without changing geometry.
        state.islandSetup={quiet:p.quiet,admin_healed_before_walk:true,position:location(await call('look',{agent}))};
        return true;
      },'shadow preparation failed'),
      act('rest',{stand:true}),safe(async ctx=>{
        let first;
        try{first=await walkIsland(ctx,p);}
        finally{if(p.roundtrip){ctx.state.islandOutboundComplete=first?.ok===true;if(first?.ok)reportIslandOutbound(ctx,p.agents,true);}}
        if(!first.ok||!p.roundtrip)return first;
        await waitIslandOutbound(ctx,p.agents,{room:p.direction==='out'?2000:27,budgetMs:p.budgetMs*8,spacingMs:p.departSpacingMs});
        return walkIsland(ctx,{...p,direction:p.direction==='out'?'back':'out'});
      },'ordinary route failed'),
      safe(async({agent,call,state,fleet})=>{
        await call('cancel_movement',{agent}).catch(()=>{});
        // Park before restoring monster generation, including successful fragile
        // travelers who would otherwise remain alone in the endpoint cave.
        if(state.character){await relocate(state.character,52,{row:6,col:10,verify:true});if(!state.islandTrial?.complete)await heal(state.character);}
        if(p.roundtrip)releaseIslandWave({agent,call,state,fleet},p.agents);
        await releaseQuiet(state);
        await state.releaseDispel?.();
        if(state.islandTrialFile)writeFileSync(state.islandTrialFile.replace(/\.json$/,'-cleanup.json'),JSON.stringify({admin_rescue:!state.islandTrial?.complete,end:location(await call('look',{agent}))},null,2));
        return true;
      },'shadow cleanup failed',true)];
  }
};
