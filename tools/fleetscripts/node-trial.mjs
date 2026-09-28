// #movement: one bounded lab trial, with setup/route/rescue recorded separately.
// Run through FleetScript. The recipe makes NO reliability claim; read attempts.jsonl.
import { act, verify } from '../m59-fleetscript.mjs';
import { relocate, heal, dm, sendMsg } from '../m59-dm.mjs';
import { readAdminRoom } from '../m59-scene-admin.mjs';
import { STONES } from '../m59-stones.mjs';
import { nodeReport, meldVerdict } from '../m59-nodecheck.mjs';
import { protocolToClient } from '../m59-finepos.mjs';
import { roomGeometry, floorAt, edgeOf } from '../m59-ground.mjs';
import { cutRail } from '../m59-railcut.mjs';
import { railLeg, checkRoute } from '../m59-noderails.mjs';
import { epochId } from '../m59-epoch.mjs';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=new URL('../../substrate/node-attempts/20260928/',import.meta.url);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hostile=o=>o.properties?.pihit_points!=null && o.properties?.pibehavior!=null && !(o.properties.pibehavior.value&1);
const sha=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const hash=p=>createHash('sha256').update(readFileSync(new URL(p,import.meta.url))).digest('hex');
function position(l) {
  const p=l.you??l.self;
  const c=p?.x!=null?protocolToClient(p):null, room=l.room?.num;
  return {room,row:p?.row,col:p?.col,x_client:c?.x??null,y_client:c?.y??null,
    floor_client:c?floorAt(roomGeometry(room),c.x,c.y):null,hp:l.hp,mana:l.mana,connection_revision:l.connection_revision};
}
async function child(args,file,timeout=360000) {
  const r=await new Promise(resolve=>execFile(process.execPath,args,
    {cwd:root,timeout,maxBuffer:8000000,windowsHide:true},
    (error,stdout,stderr)=>resolve({code:error?(error.code??'terminated'):0,signal:error?.signal,stdout,stderr})));
  writeFileSync(new URL(file,out),r.stdout+'\n'+r.stderr);
  console.log(r.stdout.slice(-2200)); return {code:r.code,signal:r.signal,evidence:file};
}
export const script={
  name:'node-trial',describe:'Bounded loopback node experiment with explicit setup and rescue receipts',
  params:{agents:{type:'agents',required:true},node:{type:'string',required:true},
    row:{type:'number',required:true},col:{type:'number',required:true},room:{type:'number'},
    route:{type:'string',default:'rail'},exit:{type:'string'},quiet:{type:'boolean',default:true},
    fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1}},
  async steps({node,row,col,room,route,exit,quiet}) {
    const stone=STONES[node]; if(!stone)throw Error('Unknown stone');
    const stageRoom=Number(room??stone.room);
    if(stageRoom===stone.room&&Math.abs(row-stone.row)<3&&Math.abs(col-stone.col)<3)throw Error('Setup cannot place inside meld box');
    const safe=(fn,why,always=false)=>({...verify(async ctx=>{try{return await fn(ctx);}catch(e){
      if(ctx.state.attempt)ctx.state.attempt.failure=String(e.stack??e);console.log('TRIAL ERROR '+e.message);return false;
    }},why),always});
    return [act('cancel_movement',{}),act('autopilot',{action:'busy',kind:'fleetscript',label:'node-trial',lease_ms:120000}),
      safe(async({agent,call,state})=>{
        if(agent!=='shadow22')throw Error('This measured recipe is scoped to Marco clone shadow22');
        const health=await (await fetch(process.env.M59_CONTROL_URL+'health')).json();
        if(health.session_characters?.[agent]!=='Vvvv'||health.game_server?.host!=='127.0.0.1'||health.game_server?.port!==15959)throw Error('Wrong shadow identity');
        mkdirSync(out,{recursive:true});
        const id=node+'-'+Date.now();state.id=id;
        state.attempt={format:'m59-node-attempt/1',at:new Date().toISOString(),stone:node,room:stone.room,
          agent,fleet:health.fleet,checkout_sha:sha(),broker_sha:process.env.M59_TRIAL_BROKER_SHA??'unknown',
          broker_pid:health.pid,movement_epoch:epochId(),scene_ref:id+'-scene.json',route_ref:{route,exit,
          fineclimb_sha256:hash('../m59-fineclimb.mjs'),recipe_sha256:hash('./node-trial.mjs')},
          navigation:{status:'stopped',last_leg:null,predicate:null},objective:{status:'untried',evidence:id+'-objective.json'}};
        state.attempt.route_ref.railfollow_sha256=hash('../m59-railfollow.mjs');
        const rooms=route==='cave-entry'?[576,587,27]:route==='badlands-canyon'?[49,45]:[stageRoom];
        state.scenes=[];
        for(const number of rooms){
          const before=await readAdminRoom(number);state.scenes.push({room:number,before,generation:before.properties?.pbgeneratemonsters?.value});
          if(quiet===true||quiet==='true'){
            if(before.properties?.pbgeneratemonsters!=null)await dm([sendMsg(before.room_object,'SetMonsterGeneration',{bValue:['INT',0]})]);
            await dm(before.actors.filter(hostile).map(o=>sendMsg(o.id,'Delete')));
          }
        }
        await heal('Vvvv');
        state.attempt.setup={procedure:'heal to existing ceiling; UtilGoNearSquare BEFORE trial; read actual position',requested:{room:stageRoom,row,col},quiet};
        await relocate('Vvvv',stageRoom,{row:Number(row),col:Number(col),verify:true});await sleep(1500);
        const l=await call('look',{agent});
        state.attempt.start=position(l);
        state.attempt.independent_reset=true;
        state.attempt.discovery=null;
        for(const scene of state.scenes)scene.after=await readAdminRoom(scene.room);
        writeFileSync(new URL(id+'-scene.json',out),JSON.stringify({at:new Date().toISOString(),rooms:state.scenes,
          objects:l.objects,node:nodeReport({objects:l.objects,you:l.you})},null,2));
        console.log('TRIAL START '+JSON.stringify(state.attempt));
        return l.room?.num===stageRoom&&l.hp?.value===l.hp?.max;
      },'setup did not verify'),act('rest',{stand:true}),
      safe(async({agent,call,state})=>{
        const a=state.attempt,id=state.id;
        const base=['tools/m59-fineclimb.mjs','--fleet','shadow-mana','--port','8971','--agent',agent,'--no-hop'];
        state.record=async(name,args,label,stopRoom=null)=>{
          let done=false,cancelled=false;
          const sample=(async()=>{while(!done){const l=await call('look',{agent});appendFileSync(new URL(id+'-positions.jsonl',out),JSON.stringify({at:new Date().toISOString(),label,...position(l)})+'\n');
            if(stopRoom!=null&&l.room?.num===stopRoom&&!cancelled){cancelled=true;await call('cancel_movement',{agent});}
            await sleep(300);}})();
          let reply;try{reply=await call(name,{agent,...args});}catch(e){reply={error:e.message};}finally{done=true;await sample;}
          appendFileSync(new URL(id+'-commands.jsonl',out),JSON.stringify({at:new Date().toISOString(),label,name,args,reply})+'\n');
          a.navigation.last_leg=label;return reply;
        };
        if(route==='cave-entry'){
          for(const to of [587,27]){
            await state.record('travel',{to,max_hops:1,run_errands:false},'enter-'+to,to);
            const l=await call('look',{agent});if(l.room?.num!==to){a.navigation.predicate='entry_transition_failed';return true;}
          }
        }
        if(route==='coarse'||route==='cave-entry'){
          const reply=await state.record('walk_to',{row:stone.row,col:stone.col,fine:false,max_steps:80,arrive_within:3},'walk-to-node');
          a.navigation.predicate=reply.reason??reply.note??null;
        }else{
          const follow=async(args,label)=>{
            a.navigation.last_leg=label;
            a.dry_run=await child([...args,'--dry-run'],id+'-'+label+'-dry.txt');
            if(a.dry_run.code!==0){a.navigation.predicate='dry_run_refused';return false;}
            a.command=await child([...args,'--receipt',fileURLToPath(new URL(id+'-'+label+'-commands.jsonl',out))],id+'-'+label+'-follow.txt',900000);
            if(a.command.code!==0)a.navigation.predicate='fine_follower_stopped';
            return a.command.code===0;
          };
          if(route==='badlands-canyon'){
            const l=await call('look',{agent}),p=position(l),geo=roomGeometry(49),edge=edgeOf(geo);
            if(p.room!==49)throw Error('Canyon approach requires room 49');
            const cut=cutRail({x:p.x_client,y:p.y_client},{x:19488,y:26656},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
            if(!cut.ok||!cut.bridgeOk){a.navigation.predicate='canyon_cut_failed';a.cut=cut;return true;}
            const leg=railLeg({waypoints:cut.waypoints},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
            const r={ok:true,direction:'to_node',exit:'body-cut',exit_label:'body-cut',from:`r${p.row}c${p.col}`,to:'r27c20',legs:[leg],jumps:0,all_declared:true,rail_complete:leg.unvalidated===0,waypoints:leg.waypoints.length,confidence:'body-seeded exact-endpoint flood'};
            const check=checkRoute(r,{edge});a.canyon_check=check;
            if(!check.ok||check.skipped||!r.rail_complete){a.navigation.predicate='canyon_rail_incomplete';return true;}
            const file=fileURLToPath(new URL(id+'-canyon-rail.json',out));writeFileSync(file,JSON.stringify({stones:[{node:'canyon',room:49,routes:[r]}]}));
            if(!await follow([...base,'--rail','canyon','--rail-file',file],'canyon'))return true;
            await state.record('walk_to',{row:28,col:20,max_steps:8},'exit-canyon');
            const next=await call('look',{agent});if(next.room?.num!==45){a.navigation.predicate='canyon_exit_failed';return true;}
            await follow([...base,'--rail','badlands','--rail-file',fileURLToPath(new URL('badlands-strict-rail.json',out))],'badlands');
          }else{
            const args=route==='rail'?[...base,'--rail',node,...(exit?['--exit',exit]:[])]:[...base,'--to',`${stone.row},${stone.col}`];
            await follow(args,'node');
          }
        }
        await call('cancel_movement',{agent});await sleep(500);return true;
      },'bounded route failed'),
      safe(async({agent,call,state})=>{
        const a=state.attempt,l=await call('look',{agent});a.end=position(l);
        const box=l.room?.num===stone.room&&Math.abs(l.you.row-stone.row)<3&&Math.abs(l.you.col-stone.col)<3;
        a.navigation.status=box?'reached_box':l.hp?.value<=0?'died':l.room?.num!==stageRoom?'left_room':'stopped';
        const nodeState=nodeReport({objects:l.objects,you:l.you});
        let activation=null,before=await call('status',{agent}),after=null,stable=null;
        if(box){const object=l.objects.find(o=>/mana node/i.test(o.name));if(object)activation=await call('act',{agent,verb:'activate',target:object.id});}
        await sleep(3000);after=await call('status',{agent});await sleep(1500);stable=await call('status',{agent});
        const verdict=meldVerdict(JSON.stringify(activation));
        const grant=before.connection_revision===after.connection_revision&&after.connection_revision===stable.connection_revision&&
          Number.isFinite(before.mana?.max)&&after.mana?.max>before.mana.max&&stable.mana?.max===after.mana.max;
        a.objective.status=verdict.verdict==='melded'||grant?'melded':verdict.verdict==='already'?'already':verdict.verdict==='dead'?'dead_node':box?'unknown':'untried';
        const authoritative=await readAdminRoom(l.room.num);
        writeFileSync(new URL(a.objective.evidence,out),JSON.stringify({nodeState,activation,verdict,before:position(before),after:position(after),stable:position(stable),grant,authoritative},null,2));
        console.log('TRIAL OUTCOME '+JSON.stringify(a));return true;
      },'objective read failed'),
      safe(async({agent,call,state})=>{
        if(route!=='cave-entry'||state.attempt.navigation.status!=='reached_box')return true;
        await state.record('walk_to',{row:57,col:45,fine:false,max_steps:80,arrive_within:3},'escape-south-door',587);
        for(const to of [587,576]){
          if((await call('look',{agent})).room?.num!==to)await state.record('travel',{to,max_hops:1,run_errands:false},'escape-'+to,to);
          const l=await call('look',{agent});
          if(l.room?.num!==to){state.attempt.escape={verified:false,failed_room:to,position:position(l)};return true;}
        }
        state.attempt.escape={verified:true,position:position(await call('look',{agent}))};return true;
      },'scripted escape failed'),
      safe(async({agent,call,state})=>{
        await call('cancel_movement',{agent});
        if(state.attempt&&!state.attempt.end)state.attempt.end=position(await call('look',{agent}));
        for(const scene of state.scenes??[])if(scene.generation!=null)await dm([sendMsg(scene.before.room_object,'SetMonsterGeneration',{bValue:['INT',scene.generation]})]);
        // Rescue is explicitly OUTSIDE the measured route, never counted as an escape pass.
        await relocate('Vvvv',52,{row:6,col:10,verify:true});await heal('Vvvv');
        const l=await call('look',{agent});
        if(state.attempt){state.attempt.recovery={kind:'admin_rescue_after_trial',verified:l.room?.num===52,position:position(l)};
          appendFileSync(new URL('attempts.jsonl',out),JSON.stringify(state.attempt)+'\n');}
        return l.room?.num===52;
      },'recovery failed',true)];
  }
};
