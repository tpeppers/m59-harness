// Explicit lab preparation around the ordinary tour. Never imported by the public route.
import {act,verify} from '../m59-fleetscript.mjs';
import {runTour,TOUR_ROOMS,tourPosition} from '../m59-node-tour.mjs';
import {readAdminRoom} from '../m59-scene-admin.mjs';
import {relocate,heal,dm,sendMsg} from '../m59-dm.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const script={name:'mana-node-tour-shadow',describe:'Quiet local-shadow preparation, then the ordinary five-node tour',
  params:{agents:{type:'agents',required:true},railFile:{type:'string',default:'substrate/node-tour-rails.json'},
    evidenceDir:{type:'string',default:'substrate/node-tours'},fromStep:{type:'number',default:0},
    stageRoom:{type:'number',default:2},stageRow:{type:'number',default:21},stageCol:{type:'number',default:3},
    minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20}},
  async steps(params){
    const safe=(fn,why,always=false)=>({...verify(async ctx=>{try{return await fn(ctx);}catch(e){console.log('SHADOW TOUR ERROR '+e.stack);return false;}},why),always});
    return [act('cancel_movement',{}),act('autopilot',{action:'busy',kind:'fleetscript',label:'mana-node-tour-shadow',lease_ms:120000}),
      safe(async({agent,call,state})=>{
        const h=await(await fetch(new URL('health',process.env.M59_CONTROL_URL))).json();
        if(agent!=='shadow22'||h.session_characters?.[agent]!=='Vvvv'||h.game_server?.host!=='127.0.0.1'||h.game_server?.port!==15959)throw Error('Wrong shadow identity');
        state.shadowAuthorized=true;state.scenes=[];
        const out=resolve(root,params.evidenceDir);mkdirSync(out,{recursive:true});
        state.tourSceneRef=join(out,'quiet-scene-'+Date.now()+'.json');
        for(const room of TOUR_ROOMS){
          const before=await readAdminRoom(room),generation=before.properties?.pbgeneratemonsters?.value;
          state.scenes.push({room,before,generation});
          if(generation!=null)await dm([sendMsg(before.room_object,'SetMonsterGeneration',{bValue:['INT',0]})]);
          await dm(before.actors.filter(o=>o.properties?.pihit_points!=null&&o.properties?.pibehavior!=null&&!(o.properties.pibehavior.value&1)).map(o=>sendMsg(o.id,'Delete')));
          state.scenes.at(-1).after=await readAdminRoom(room);
        }
        await heal('Vvvv');
        await relocate('Vvvv',params.stageRoom,{row:params.stageRow,col:params.stageCol,verify:true});await sleep(1000);
        state.tourSetup={procedure:'quiet scene, existing-ceiling heal and entrance placement BEFORE route; restore generation afterward',
          independent_reset:true,quiet:true,start:tourPosition(await call('look',{agent}))};
        writeFileSync(state.tourSceneRef,JSON.stringify({setup:state.tourSetup,rooms:state.scenes},null,2));
        return params.fromStep>0||state.tourSetup.start.room===2;
      },'shadow preparation failed'),act('rest',{stand:true}),
      safe(ctx=>runTour(ctx,params),'node tour stopped; inspect receipt'),
      safe(async({agent,call,state})=>{
        if(!state.shadowAuthorized)return true;
        await call('cancel_movement',{agent});
        for(const s of state.scenes??[])if(s.generation!=null){
          const current=await readAdminRoom(s.room);await dm([sendMsg(current.room_object,'SetMonsterGeneration',{bValue:['INT',s.generation]})]);
        }
        if(!state.tour?.complete){await relocate('Vvvv',52,{row:6,col:10,verify:true});await heal('Vvvv');}
        await sleep(1000); // Allow the post-relocation room frame to carry its position.
        const recovery={kind:state.tour?.complete?'finished_in_room_2':state.tour?.partial_complete?'admin_rescue_after_partial_replay':'admin_rescue_after_failed_route',position:tourPosition(await call('look',{agent}))};
        if(state.tourFile)writeFileSync(state.tourFile.replace(/\.json$/,'-cleanup.json'),JSON.stringify(recovery,null,2));
        console.log('TOUR CLEANUP '+JSON.stringify(recovery));return true;
      },'shadow cleanup failed',true)];
  }
};
