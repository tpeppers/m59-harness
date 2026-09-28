// #movement: escape-only shadow experiment. This never counts as a node approach.
import {act,verify} from '../m59-fleetscript.mjs';
import {relocate,heal,dm,sendMsg} from '../m59-dm.mjs';
import {readAdminRoom} from '../m59-scene-admin.mjs';
import {roomGeometry,floorAt,edgeOf,floodReport} from '../m59-ground.mjs';
import {cutRail} from '../m59-railcut.mjs';
import {railLeg,checkRoute} from '../m59-noderails.mjs';
import {protocolToClient,clientToProtocol} from '../m59-finepos.mjs';
import {epochId} from '../m59-epoch.mjs';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=new URL('../../substrate/node-attempts/20260928/',import.meta.url);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const position=l=>{const p=protocolToClient(l.you);return {room:l.room.num,row:l.you.row,col:l.you.col,
  x_client:p.x,y_client:p.y,floor_client:floorAt(roomGeometry(l.room.num),p.x,p.y),hp:l.hp,mana:l.mana};};
async function child(args,path){
  const result=await new Promise(resolve=>execFile(process.execPath,args,{cwd:root,windowsHide:true,timeout:900000,maxBuffer:8000000},
    (error,stdout,stderr)=>resolve({code:error?.code??0,stdout,stderr})));
  writeFileSync(path,result.stdout+'\n'+result.stderr);console.log(result.stdout.slice(-1500));return result.code===0;
}
export const script={name:'node-escape',describe:'Measured Badlands escape, separate from approach and meld trials',
  params:{agents:{type:'agents',required:true},fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1}},
  async steps(){
    const safe=(fn,why,always=false)=>({...verify(async ctx=>{try{return await fn(ctx);}catch(e){
      if(ctx.state.receipt)ctx.state.receipt.failure=String(e.stack??e);console.log(e.message);return false;}},why),always});
    return [act('cancel_movement',{}),
      safe(async({agent,call,state})=>{
        const h=await(await fetch(process.env.M59_CONTROL_URL+'health')).json();
        if(agent!=='shadow22'||h.session_characters?.[agent]!=='Vvvv'||h.game_server?.host!=='127.0.0.1'||h.game_server?.port!==15959)throw Error('Wrong shadow identity');
        state.authorized=true;
        mkdirSync(out,{recursive:true});state.id='badlands-escape-'+Date.now();state.scenes=[];
        state.receipt={format:'m59-node-escape/1',at:new Date().toISOString(),stone:'badlands',agent,fleet:h.fleet,
          checkout_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
          broker_sha:process.env.M59_TRIAL_BROKER_SHA??'unknown',broker_pid:h.pid,movement_epoch:epochId(),
          recipe_sha256:hash(new URL(import.meta.url)),scene_ref:state.id+'-scene.json',legs:[],verified:false,
          setup:'quiet rooms 45/49/593; square placement and bounded fine alignment to recorded approach endpoint BEFORE escape; no activation; never an inbound-route trial'};
        for(const room of [45,49,593]){
          const before=await readAdminRoom(room),generation=before.properties?.pbgeneratemonsters?.value;
          state.scenes.push({room,before,generation});
          if(generation!=null)await dm([sendMsg(before.room_object,'SetMonsterGeneration',{bValue:['INT',0]})]);
          await dm(before.actors.filter(o=>o.properties?.pihit_points!=null&&o.properties?.pibehavior!=null&&!(o.properties.pibehavior.value&1)).map(o=>sendMsg(o.id,'Delete')));
        }
        await heal('Vvvv');
        const target=clientToProtocol({x:46080,y:64448});
        // Use the successfully exercised setup; broker look.you has no object id.
        // Placement and this bounded alignment precede the measured escape.
        state.receipt.placement=await relocate('Vvvv',45,{row:63,col:46,verify:true});
        await sleep(1000);
        state.receipt.setup_alignment=await call('walk_to',{agent,...target,arrive_within:0,max_steps:12,hold_shelf:true});
        state.receipt.start=position(await call('look',{agent}));
        for(const s of state.scenes)s.after=await readAdminRoom(s.room);
        writeFileSync(new URL(state.receipt.scene_ref,out),JSON.stringify(state.scenes,null,2));
        console.log('ESCAPE START '+JSON.stringify(state.receipt));
        const start=state.receipt.start;
        return start.room===45&&start.x_client===46080&&start.y_client===64448&&start.floor_client===4096;
      },'escape setup failed'),act('rest',{stand:true}),
      safe(async({agent,call,state})=>{
        for(const [room,row,col,next] of [[45,1,53,49],[49,1,21,593]]){
          const start=position(await call('look',{agent}));if(start.room!==room)throw Error('Wrong escape room');
          const geo=roomGeometry(room),edge=edgeOf(geo),from={x:start.x_client,y:start.y_client};
          let points,proof;
          if(room===45){proof=floodReport(geo,from,{row,col},{lattice:64,box:0});points=proof.path;
            if(points&&(points[0].x!==from.x||points[0].y!==from.y))points=[from,...points];
          }else{proof=cutRail(from,{x:20544,y:512},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});points=proof.ok&&proof.bridgeOk?proof.waypoints:null;}
          const label=state.id+'-'+room;
          writeFileSync(new URL(label+'-cut.json',out),JSON.stringify(proof));
          if(!points)throw Error('escape_cut_failed_room_'+room);
          const leg=railLeg({waypoints:points},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
          const route={ok:true,rail_complete:leg.unvalidated===0,direction:'to_exit',from:`r${start.row}c${start.col}`,to:`r${row}c${col}`,
            exit:'escape',exit_label:'escape',legs:[leg],jumps:0,all_declared:true,waypoints:leg.waypoints.length,confidence:'body-seeded strict return rail'};
          const check=checkRoute(route,{edge});if(!check.ok||check.skipped||!route.rail_complete)throw Error('escape_rail_incomplete_room_'+room);
          const file=fileURLToPath(new URL(label+'-rail.json',out));writeFileSync(file,JSON.stringify({stones:[{node:'escape',room,routes:[route]}]}));
          const record={room,start,check,rail_ref:label+'-rail.json',rail_sha256:hash(file)};state.receipt.legs.push(record);
          const args=['tools/m59-fineclimb.mjs','--fleet','shadow-mana','--port','8971','--agent',agent,'--rail','escape','--direction','to_exit','--rail-file',file,'--no-hop'];
          if(!await child([...args,'--dry-run'],new URL(label+'-dry.txt',out)))throw Error('escape_dry_failed_room_'+room);
          if(!await child([...args,'--receipt',fileURLToPath(new URL(label+'-commands.jsonl',out))],new URL(label+'-follow.txt',out)))throw Error('escape_follow_failed_room_'+room);
          record.edge=await call('walk_to',{agent,row:0,col,max_steps:8});await call('cancel_movement',{agent});await sleep(500);
          record.end=position(await call('look',{agent}));
          if(record.end.room!==next)throw Error('escape_edge_failed_room_'+room);
        }
        state.receipt.end=position(await call('look',{agent}));state.receipt.authoritative=await readAdminRoom(593);
        state.receipt.verified=state.receipt.end.room===593;return state.receipt.verified;
      },'bounded escape failed'),
      safe(async({agent,call,state})=>{
        if(!state.authorized)return true;
        await call('cancel_movement',{agent});
        if(state.receipt&&!state.receipt.end)state.receipt.end=position(await call('look',{agent}));
        for(const s of state.scenes??[])if(s.generation!=null)await dm([sendMsg(s.before.room_object,'SetMonsterGeneration',{bValue:['INT',s.generation]})]);
        await relocate('Vvvv',52,{row:6,col:10,verify:true});await heal('Vvvv');
        const l=await call('look',{agent});state.receipt.recovery={kind:'admin_rescue_after_escape',position:position(l)};
        appendFileSync(new URL('escapes.jsonl',out),JSON.stringify(state.receipt)+'\n');
        console.log('ESCAPE OUTCOME '+JSON.stringify({...state.receipt,authoritative:undefined}));return l.room?.num===52;
      },'escape rescue failed',true)];
  }
};
