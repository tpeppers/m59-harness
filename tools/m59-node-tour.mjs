// Five-node circuit. No maintenance calls: this module only uses ordinary movement.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {protocolToClient} from './m59-finepos.mjs';
import {roomGeometry,floorAt,edgeOf,floodReport} from './m59-ground.mjs';
import {cutRail} from './m59-railcut.mjs';
import {railLeg,checkRoute} from './m59-noderails.mjs';
import {STONES} from './m59-stones.mjs';
import {nodeReport,meldVerdict} from './m59-nodecheck.mjs';
import {epochId} from './m59-epoch.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const TOUR_NODES=['victoria','sentinel','ancient','badlands','cave'];
export const TOUR_ROOMS=[2,38,39,599,589,579,578,576,587,586,585,584,583,593,49,45,574,150,575,27,597,598];
export const hashFile=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
// look retains a completed/cancelled job as a receipt. Presence does not mean busy.
export const travelJobActive=job=>!!job?.busy;
export function tourPosition(l){
  const p=l.you,c=p?.x!=null?protocolToClient(p):null,room=l.room?.num;
  return {room,row:p?.row,col:p?.col,x_client:c?.x??null,y_client:c?.y??null,
    floor_client:c?floorAt(roomGeometry(room),c.x,c.y):null,hp:l.hp,mana:l.mana,connection_revision:l.connection_revision};
}
export function insideNode(p,node){const s=STONES[node];return p.room===s.room&&Math.abs(p.row-s.row)<3&&Math.abs(p.col-s.col)<3;}
export function tourComplete(r){return r.start?.room===2&&r.end?.room===2&&r.nodes?.length===5&&
  r.nodes.every((n,i)=>n.stone===TOUR_NODES[i]&&insideNode(n.position,n.stone))&&!r.failure;}
export function cutTourWalk(geo,from,step){
  const edge=edgeOf(geo);
  const proof=step.boxFlood?floodReport(geo,from,{row:step.row,col:step.col},{lattice:64,cap:1500000,box:0}):
    cutRail(from,step,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
  let points=step.boxFlood?proof.path:(proof.ok&&proof.bridgeOk?proof.waypoints:null);
  if(points&&(points[0].x!==from.x||points[0].y!==from.y))points=[from,...points];
  return {proof,points};
}
export function tourPlan(){return [
  {kind:'travel',to:38},{kind:'travel',to:39},
  {kind:'rail',node:'victoria',exit:'go:38:r8c27'}, {kind:'meld',node:'victoria'},
  {kind:'rail',node:'victoria',direction:'to_exit',exit:'go:38:r9c27'},
  {kind:'travel',to:38},{kind:'travel',to:2},{kind:'travel',to:599},{kind:'travel',to:589},
  {kind:'rail',node:'sentinel',exit:'edge:599:r18c46'},{kind:'meld',node:'sentinel'},
  {kind:'rail',node:'sentinel',direction:'to_exit',exit:'edge:579:r43c1'},
  {kind:'travel',to:579},
  {kind:'rail',node:'ancient',exit:'edge:589:r38c74'},{kind:'meld',node:'ancient'},
  {kind:'rail',node:'ancient',direction:'to_exit',exit:'edge:578:r1c17'},
  ...[578,576,587,586,585,584,583,593,49].map(to=>({kind:'travel',to})),
  {kind:'cut',room:49,x:19488,y:26656,row:27,col:20},
  {kind:'cross',row:28,col:20,to:45},
  {kind:'rail',node:'badlands'},{kind:'meld',node:'badlands'},
  {kind:'cut',room:45,boxFlood:true,row:1,col:53},{kind:'cross',row:0,col:53,to:49},
  {kind:'cut',room:49,x:20544,y:512,row:1,col:21},{kind:'cross',row:0,col:21,to:593},
  ...[583,584,574,150,575,576,587,27].map(to=>({kind:'travel',to})),
  {kind:'walk',row:23,col:53},{kind:'meld',node:'cave'},
  {kind:'walk',row:57,col:45},
  ...[587,576,587,597,598,599,2].map(to=>({kind:'travel',to})),
];}

export async function runTour(ctx,{railFile='substrate/node-tour-rails.json',evidenceDir='substrate/node-tours',fromStep=0}={}){
  fromStep=Number(fromStep);
  if(!Number.isInteger(fromStep)||fromStep<0||fromStep>=tourPlan().length)throw Error('invalid_tour_start_step');
  const {agent,call,state}=ctx,out=resolve(root,evidenceDir);mkdirSync(out,{recursive:true});
  const health=await(await fetch(new URL('health',process.env.M59_CONTROL_URL))).json();
  const first=await call('look',{agent});
  if(fromStep===0&&first.room?.num!==2)throw Error('tour_start_requires_room_2');
  const id='five-node-'+Date.now(),record={format:'m59-node-tour/1',id,at:new Date().toISOString(),agent,
    fleet:health.fleet,checkout_sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
    broker_sha:process.env.M59_TRIAL_BROKER_SHA??'unknown',broker_pid:health.pid,movement_epoch:epochId(),
    recipe_sha256:hashFile(fileURLToPath(import.meta.url)),rail_sha256:hashFile(resolve(root,railFile)),
    setup:state.tourSetup??null,scene_ref:state.tourSceneRef??null,from_step:fromStep,start:tourPosition(first),nodes:[],legs:[],complete:false};
  record.rail_ref=id+'-rails.json';writeFileSync(join(out,record.rail_ref),readFileSync(resolve(root,railFile)));
  state.tour=record;state.tourFile=join(out,id+'.json');
  const save=()=>writeFileSync(state.tourFile,JSON.stringify(record,null,2));
  const read=async()=>{const l=await call('look',{agent});if(l.hp?.value<=0)throw Error('tour_character_died');return l;};
  const command=async(name,args,label,stopRoom=null)=>{
    const before=tourPosition(await read());let reply,done=false,crossed=false,watchError=null;
    const watcher=stopRoom==null?null:(async()=>{
      while(!done){const l=await read();
        appendFileSync(join(out,id+'-positions.jsonl'),JSON.stringify({at:new Date().toISOString(),label,...tourPosition(l)})+'\n');
        if(l.room.num===stopRoom){crossed=true;await call('cancel_movement',{agent});return;}
        await sleep(300);
      }
    })().catch(async e=>{watchError=e;done=true;try{await call('cancel_movement',{agent});}catch{}});
    try{reply=await call(name,{agent,...args});}catch(e){reply={error:e.message};}
    finally{done=true;if(watcher)await watcher;}
    if(watchError)throw watchError;
    const after=tourPosition(await read());
    appendFileSync(join(out,id+'-commands.jsonl'),JSON.stringify({at:new Date().toISOString(),label,name,args,before,reply,after,
      ...(stopRoom==null?{}:{stop_on_room:stopRoom,crossing_observed:crossed})})+'\n');
    return reply;
  };
  const travel=async(to,label)=>{
    if((await read()).room.num===to)return;
    const reply=await command('travel',{to,max_hops:1,background:true,run_errands:false},label);
    const until=Date.now()+240000;let seenJob=false;
    while(Date.now()<until){const l=await read();
      appendFileSync(join(out,id+'-positions.jsonl'),JSON.stringify({at:new Date().toISOString(),label,...tourPosition(l)})+'\n');
      if(l.room.num===to){await command('cancel_movement',{},label+'-arrived');return;}
      seenJob ||= travelJobActive(l.job);
      if(!travelJobActive(l.job)&&(seenJob||Date.now()>until-234000))throw Error('travel_stopped_before_room_'+to+': '+JSON.stringify({issued:reply,terminal_job:l.job}));
      await sleep(1000);
    }
    await command('cancel_movement',{},label+'-timeout');throw Error('travel_timeout_room_'+to);
  };
  const follow=async(step,label,file=railFile)=>{
    const args=['tools/m59-fineclimb.mjs','--fleet',health.fleet,'--port',String(new URL(process.env.M59_CONTROL_URL).port),
      '--agent',agent,'--rail',step.node,'--rail-file',resolve(root,file),'--direction',step.direction??'to_node','--no-hop',
      ...(step.exit?['--exit',step.exit]:[])];
    for(const dry of [true,false]){
      const extra=dry?['--dry-run']:['--receipt',join(out,id+'-'+label+'-commands.jsonl')];
      const result=await new Promise(done=>execFile(process.execPath,[...args,...extra],{cwd:root,timeout:900000,maxBuffer:8000000,windowsHide:true},
        (error,stdout,stderr)=>done({code:error?(error.code??'terminated'):0,signal:error?.signal,stdout,stderr})));
      writeFileSync(join(out,id+'-'+label+(dry?'-dry':'-follow')+'.txt'),result.stdout+'\n'+result.stderr);
      console.log(result.stdout.slice(-1400));
      if(result.code!==0)throw Error((dry?'rail_dry_refused':'rail_follow_stopped')+': '+label);
    }
  };
  try{
    const plan=tourPlan();
    for(let i=fromStep;i<plan.length;i++){
      const step=plan[i],label=String(i).padStart(2,'0')+'-'+step.kind+'-'+(step.node??step.to??step.room??'point');
      const leg={index:i,label,step,start:tourPosition(await read()),at:new Date().toISOString()};record.legs.push(leg);save();
      console.log('TOUR LEG '+JSON.stringify(leg));
      if(step.kind==='travel')await travel(step.to,label);
      else if(step.kind==='rail')await follow(step,label);
      else if(step.kind==='cut'){
        const p=tourPosition(await read());if(p.room!==step.room)throw Error('cut_wrong_room');
        const geo=roomGeometry(p.room),edge=edgeOf(geo),from={x:p.x_client,y:p.y_client};
        const {proof,points}=cutTourWalk(geo,from,step);
        if(!points){leg.cut=proof;throw Error('body_seeded_cut_failed');}
        writeFileSync(join(out,id+'-'+label+'-cut.json'),JSON.stringify(proof));
        const walk=railLeg({waypoints:points},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
        const route={ok:true,rail_complete:walk.unvalidated===0,direction:'to_node',exit:'body-cut',exit_label:'body-cut',
          from:`r${p.row}c${p.col}`,to:`r${step.row}c${step.col}`,legs:[walk],jumps:0,all_declared:true,waypoints:walk.waypoints.length,
          confidence:'body-seeded exact-endpoint walk, checked before following'};
        leg.check=checkRoute(route,{edge});if(!leg.check.ok||leg.check.skipped||!route.rail_complete)throw Error('cut_check_failed');
        const file=join(out,id+'-'+label+'-rail.json');writeFileSync(file,JSON.stringify({stones:[{node:'cut',room:p.room,routes:[route]}]}));
        leg.rail_ref=file;leg.rail_sha256=hashFile(file);await follow({node:'cut'},label,file);
      }else if(step.kind==='walk'||step.kind==='cross'){
        if(step.to&&(await read()).room.num===step.to){leg.already_in_room=true;}
        else await command('walk_to',{row:step.row,col:step.col,fine:false,max_steps:step.kind==='cross'&&step.to!==587?8:80,arrive_within:3},label,step.to??null);
        await command('cancel_movement',{},label+'-settle');await sleep(500);
        if(step.to&&(await read()).room.num!==step.to)throw Error('crossing_failed_room_'+step.to);
      }else if(step.kind==='meld'){
        const l=await read(),p=tourPosition(l);if(!insideNode(p,step.node))throw Error('outside_meld_box_'+step.node);
        const node=l.objects.find(o=>/mana node/i.test(o.name));if(!node)throw Error('node_not_visible_'+step.node);
        const before=await call('status',{agent}),activation=await command('act',{verb:'activate',target:node.id},label);
        // A short act response can precede its message. Read only events after this
        // room look; never search old history for an already-bonded sentence.
        const observation=meldVerdict(JSON.stringify(activation)).verdict==='unrelated'&&Number.isFinite(l.ev_seq)
          ?await call('wait_for_event',{agent,since:l.ev_seq,kinds:['message'],timeout_ms:3000}):null;
        await sleep(3000);const after=await call('status',{agent});await sleep(1500);const stable=await call('status',{agent});
        const verdict=meldVerdict(JSON.stringify({activation,observation}));
        const grant=before.connection_revision===after.connection_revision&&after.connection_revision===stable.connection_revision&&
          Number.isFinite(before.mana?.max)&&after.mana?.max>before.mana.max&&stable.mana?.max===after.mana.max;
        const objective={stone:step.node,position:p,node_state:nodeReport({objects:l.objects,you:l.you}),activation,observation,observed_since:l.ev_seq,verdict,
          before:before.mana,after:after.mana,stable:stable.mana,grant,connection_revision:before.connection_revision,
          status:verdict.verdict==='melded'||grant?'melded':verdict.verdict==='already'?'already':verdict.verdict==='dead'?'dead_node':'unknown'};
        record.nodes.push(objective);console.log('TOUR NODE '+JSON.stringify(objective));
      }
      leg.end=tourPosition(await read());leg.completed_at=new Date().toISOString();save();
    }
    record.end=tourPosition(await read());record.complete=fromStep===0&&tourComplete(record);
    record.partial_complete=fromStep>0;return record.complete||record.partial_complete;
  }catch(e){record.failure=String(e.stack??e);console.log('TOUR STOP '+e.message);return false;}
  finally{
    await call('cancel_movement',{agent});record.end=tourPosition(await call('look',{agent}));save();
    appendFileSync(join(out,'tours.jsonl'),JSON.stringify(record)+'\n');console.log('TOUR RECEIPT '+state.tourFile+' complete='+record.complete);
  }
}
