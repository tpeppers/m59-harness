// Ordinary player movement to Brax. Administrative setup belongs in the lab driver.
import {readFileSync,writeFileSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync,existsSync,appendFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {roomGeometry,floorAt,edgeOf} from './m59-ground.mjs';
import {railLeg,fineEdge,checkRoute,bakeOne,aimsAlong} from './m59-noderails.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {cutRail} from './m59-railcut.mjs';
import {scanKeepers,identityOf,identityMismatch} from './m59-keeper.mjs';
import {protocolToClient,clientToProtocol,squareCentreClient} from './m59-finepos.mjs';
import {applyAncientFloors,liftWaitMs} from './m59-moving-platform.mjs';
import {evidenceDirFor,resolveControlUrl} from './m59-fleetpath.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import {distanceToRail} from './m59-railfollow.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const BRAX_DESTINATION=827;
export const MAX_BRAX_GROUP=25;
export const departureSlot=index=>({x:55808+(index%2)*1024,y:14848+Math.floor(index/2)*512});
export const platformSlot=index=>{
  if(!Number.isInteger(index)||index<0||index>=25)throw Error('platform slot must be 0..24');
  return {row:[18,19,21,22,23][Math.floor(index/5)],col:[52,53,57,58,59][index%5]};
};
export const CORNERS=[{row:16,col:51,stand:{row:17,col:51}},{row:16,col:60,stand:{row:17,col:60}},
  {row:25,col:51,stand:{row:24,col:51}},{row:25,col:60,stand:{row:24,col:60}}];
export const cornerWork=(index,count)=>{
  const assignments=count===1?[[0,1,2,3]]:count===2?[[0,2],[1,3]]:count===3?[[0,1],[2],[3]]:[[0],[1],[2],[3]];
  return (assignments[index]??[]).map(i=>CORNERS[i]);
};
export function platformAims(from,to){
  const inside=p=>p.x>=50*1024&&p.x<=61*1024&&p.y>=14*1024&&p.y<=26*1024;
  if(!inside(from)||!inside(to))return [to];
  const box={x:{min:54784,max:57344},y:{min:18432,max:21504}};
  let lo=0,hi=1;
  for(const axis of ['x','y']){
    const d=to[axis]-from[axis],range=box[axis];
    if(!d){if(from[axis]<range.min||from[axis]>range.max)return [to];continue;}
    const a=(range.min-from[axis])/d,b=(range.max-from[axis])/d;
    lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
    if(lo>hi)return [to];
  }
  const inColumn=from.x>=box.x.min&&from.x<=box.x.max;
  const aisle=to.y<box.y.min?16896:24064;
  const aims=[];
  if(inColumn&&((from.y<box.y.min&&aisle===24064)||(from.y>box.y.max&&aisle===16896))){
    const side=to.x<(box.x.min+box.x.max)/2?52736:58880;aims.push({x:side,y:from.y},{x:side,y:aisle});
  }
  else aims.push({x:from.x,y:aisle});
  aims.push({x:to.x,y:aisle},to);return aims;
}
// An unrelated message (including a periodic server save) is not a lever verdict.
export async function awaitLeverConfirmation(reply,{since,waitEvent,observedRaised,now=Date.now,timeoutMs=10000}){
  const switched=value=>/You switch the lever\./.test(JSON.stringify(value));
  if(switched(reply))return true;
  const deadline=now()+timeoutMs;let cursor=since;
  while(now()<deadline){
    if(await observedRaised())return true;
    const event=await waitEvent({since:cursor,kinds:['message'],timeout_ms:Math.min(1000,deadline-now())});
    if(switched(event))return true;
    if(event.no_event_stream)return false;
    cursor=Math.max(cursor,event.cursor??cursor);
  }
  return await observedRaised();
}
export const keeperSurvivalInterruption=reply=>reply?.cancelled===true&&reply.cancelled_by_origin?.source==='keeper';
export const readyAfterSurvival=(s,minHealth=0.9)=>Number(s.hp?.value)>0&&Number(s.hp?.max)>0&&s.hp.value/s.hp.max>=minHealth&&!s.autopilot_status?.survival_decisions?.current;
export const braxArrival=s=>Number(s.room?.num)===827&&Number(s.hp?.value)>0;

// All checkouts use the same endpoint-keyed journal beside the shared evidence store.
// The short mutex is atomic (wx); no socket work occurs while it is held.
export function groupJournal(server,{directory=join(evidenceDirFor(),'brax-groups'),openMutex=openSync}={}){
  mkdirSync(directory,{recursive:true});
  const file=join(directory,createHash('sha256').update(server).digest('hex').slice(0,24)+'.json');
  return {file,async change(fn){
    const lock=file+'.mutex',until=Date.now()+10000;
    for(;;){let fd;
      try{fd=openMutex(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid}));}
      catch(e){
        // Windows can report a just-unlinked mutex as temporarily delete-pending.
        // Retry without deleting or interpreting an inaccessible owner's lock.
        if(e.code==='EPERM'||e.code==='EACCES'){
          if(Date.now()>until)throw Error('Brax journal mutex stayed inaccessible');
          await sleep(50);continue;
        }
        if(e.code!=='EEXIST')throw e;
        let held;
        try{held=JSON.parse(readFileSync(lock,'utf8'));}
        catch(readError){if(Date.now()>until)throw Error('Unreadable Brax journal mutex');await sleep(50);continue;}
        if(!Number.isSafeInteger(held.pid)||held.pid<=0)throw Error('Invalid Brax journal mutex owner');
        try{process.kill(held.pid,0);}catch(dead){if(dead.code==='ESRCH'){unlinkSync(lock);continue;}throw dead;}
        if(Date.now()>until)throw Error('Brax group journal is busy');await sleep(50);continue;}
      try{const value=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
        const next=fn(value);if(next!==undefined){const tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(next));renameSync(tmp,file);}return next??value;
      }finally{closeSync(fd);unlinkSync(lock);}
    }
  }};
}

export function makeBraxApproach(source){
  if(!source?.ok||!source?.rail_complete)throw Error('missing checked Ancient approach');
  const geo=roomGeometry(579),edge=fineEdge(geo),opts={edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)};
  const r=structuredClone(source);r.legs=r.legs.slice(0,3);
  const points=r.legs[2].waypoints,target={x:37632,y:38272};
  const index=points.reduce((best,p,i)=>Math.hypot(p.x-target.x,p.y-target.y)<Math.hypot(points[best].x-target.x,points[best].y-target.y)?i:best,0);
  r.legs[2].waypoints=points.slice(0,index+1);
  r.legs[2].aims=aimsAlong(r.legs[2].waypoints,{edge});
  for(const goal of [{x:37376,y:39424},{x:55808,y:32000}]){
    const from=r.legs.at(-1).waypoints.at(-1),cut=cutRail(from,goal,{...opts,edge:edgeOf(geo)});
    if(!cut.ok||!cut.bridgeOk)throw Error('Brax shelf cut refused');
    r.legs.push(railLeg({waypoints:cut.waypoints},{...opts,edge:edgeOf(geo)}));
  }
  r.exit='brax-south';r.exit_label='brax-south';r.to='r32c55';r.jumps=1;
  r.waypoints=r.legs.reduce((n,l)=>n+(l.waypoints?.length??0),0);
  r.rail_complete=r.legs.filter(l=>l.kind==='walk').every(l=>!l.unvalidated);
  if(!r.rail_complete||!checkRoute(r,{edge}).ok)throw Error('Brax approach rail check refused: '+JSON.stringify({legs:r.legs.map(l=>l.unvalidated),check:checkRoute(r,{edge})}));
  return r;
}
export function ensureBraxApproach({sourceFile=join(root,'substrate/node-tour-rails.json'),out=join(root,'substrate/brax-rails.json')}={}){
  let source;
  if(existsSync(sourceFile))source=JSON.parse(readFileSync(sourceFile)).stones?.find(s=>s.node==='ancient')?.routes?.find(r=>r.direction==='to_node'&&r.exit==='edge:589:r38c74');
  if(!source){
    const router=fineRouter(579),geo=router.geo;
    source=bakeOne(router,{row:38,col:74},{row:52,col:30},{maxJumps:3,edge:fineEdge(geo),bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
  }
  const route=makeBraxApproach(source);
  mkdirSync(dirname(out),{recursive:true});
  const temporary=out+'.'+randomUUID();writeFileSync(temporary,JSON.stringify({stones:[{node:'brax',room:579,routes:[route]}]}));renameSync(temporary,out);return out;
}

export async function runBrax(ctx,{gatherMs=60000,timeoutMs=1200000,approachFile=join(root,'substrate/brax-rails.json'),resumeRaisedAt=null,resumeNorthLedge=false}={}){
  const {agent,fleet,call,state}=ctx,start=Date.now(),end=start+timeoutMs;
  const control=resolveControlUrl();if(!control.url)throw Error(control.why);
  const controlURL=new URL(control.url);
  const out=join(root,'substrate/brax-attempts');mkdirSync(out,{recursive:true});
  const id=agent+'-'+Date.now(),receipt=join(out,id+'.jsonl');state.brax={id,receipt,success:false};
  const log=(event,data={})=>{appendFileSync(receipt,JSON.stringify({at:new Date().toISOString(),agent,event,...data})+'\n');console.log('BRAX '+agent+' '+event);};
  let keeper,ticket,journal,batchId;
  const read=async()=>{
    if(Date.now()>end)throw Error('Brax route time budget exhausted');
    for(let attempt=0;!keeper&&attempt<3;attempt++){
      keeper=(await scanKeepers({fleet,timeoutMs:5000})).get(agent);
      if(!keeper)await sleep(500);
    }
    if(!keeper)throw Error('Brax requires a verified keeper');
    for(let attempt=0;attempt<3;attempt++){
      const url=new URL(`http://127.0.0.1:${keeper.port}/state`);
      for(const [key,value]of Object.entries({position:1,agent,character:keeper.character,keeper_pid:keeper.pid}))url.searchParams.set(key,String(value));
      let response,s;
      try{response=await fetch(url,{signal:AbortSignal.timeout(Math.max(1,Math.min(30000,end-Date.now())))});s=await response.json();}
      catch(error){
        if(attempt===2||Date.now()>end)throw error;
        log('keeper-read-retry',{attempt,reason:error.message});
        const next=(await scanKeepers({fleet,timeoutMs:5000})).get(agent);
        if(next&&next.character!==keeper.character)throw Error('Brax keeper character changed');
        if(next)keeper=next;
        await sleep(500);continue;
      }
      if(!response.ok||identityMismatch(keeper,identityOf(response.headers,s)))throw Error('Brax keeper identity changed');
      if(s.hp?.value<=0||s.room?.num===1)throw Error('Brax character died');
      const pose=s.position_read;
      if(pose&&pose.id===s.you?.id&&pose.room_object_id===s.room?.object_id)return {...s,you:{...s.you,...pose}};
      log('position-read-unconfirmed',{attempt});await sleep(500);
    }
    throw Error('Brax actual position could not be confirmed');
  };
  const command=async(name,args={})=>{
    for(let attempt=0;attempt<3;attempt++){
      const reply=await call(name,{agent,...args});log('command',{name,args,reply});
      if(!String(reply?.error??'').includes('keeper identity could not be verified; refusing write')||attempt===2)return reply;
      await read();await sleep(1000);
    }
  };
  const until=async(test,why,budget=180000)=>{const deadline=Math.min(end,Date.now()+budget);for(;;){const result=await test();if(result)return result;if(Date.now()>deadline)throw Error(why);await sleep(500);}};
  const position=s=>({...protocolToClient(s.you),row:s.you.row,col:s.you.col});
  const rawWalkPoint=async(point,room=579)=>{
    const aim=point.x==null?squareCentreClient(point.row,point.col):point;
    let reply;
    const deadline=Date.now()+45000;
    do{
      reply=await command('walk_to',{...clientToProtocol(aim),fine:true,max_steps:180,stride:48,arrive_within:4,exact_arrival:true,hold_shelf:true});
      if(reply.reason!=='collision_geometry_changed')break;
      if(Date.now()>deadline)throw Error('Brax room animation did not settle');
      await sleep(1000);
    }while(true);
    const s=await read(),p=position(s);
    if(s.room.num!==room||Math.hypot(p.x-aim.x,p.y-aim.y)>128)throw Object.assign(Error('Brax fine walk stopped before its target'),{reply});
  };
  const walkPoint=async(point,room=579)=>{
    const aim=point.x==null?squareCentreClient(point.row,point.col):point;
    const current=await read(),from=position(current);
    const flatTop=current.doors.observed?.[2]===800&&current.doors.observed?.[3]===800;
    for(const target of room===579&&!flatTop?platformAims(from,aim):[aim]){
      try{await rawWalkPoint(target,room);}
      catch(error){
        if(room!==579||error.reply?.reason!=='object_blocked')throw error;
        let complete=false;
        for(let attempt=0;attempt<3&&!complete;attempt++){
          const s=await read(),geo=roomGeometry(room);
          applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
          const plan=planBodyDetour(geo,s.you,clientToProtocol(target),{
            objects:new Map(s.objects.map(o=>[o.id,o])),selfId:s.you.id,maxRangeSquares:24,marginSquares:4,maxNodes:12000,maxMs:1000});
          log('body-detour',{found:plan.found,reason:plan.reason,nodes:plan.nodes});
          if(!plan.found)throw error;
          try{for(const point of plan.waypoints)await rawWalkPoint(protocolToClient(point),room);complete=true;}
          catch(next){if(next.reply?.reason!=='object_blocked')throw next;error=next;}
        }
        if(!complete)throw error;
      }
    }
  };
  const follow=async(file,label)=>{
    const args=['tools/m59-fineclimb.mjs','--fleet',fleet,'--port',controlURL.port,'--agent',agent,'--rail','brax','--rail-file',file,'--no-hop','--receipt',join(out,id+'-'+label+'-commands.jsonl')];
    const commandsFile=join(out,id+'-'+label+'-commands.jsonl');
    const result=await new Promise(done=>execFile(process.execPath,args,{cwd:root,timeout:900000,maxBuffer:8e6,windowsHide:true},(error,stdout,stderr)=>done({error,stdout,stderr})));
    writeFileSync(join(out,id+'-'+label+'.txt'),result.stdout+'\n'+result.stderr);
    if(result.error){
      const rows=existsSync(commandsFile)?readFileSync(commandsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
      const last=rows.filter(row=>row.kind==='walk').at(-1)?.reply;
      throw Object.assign(Error('Brax '+label+' rail follower stopped'),{survival:keeperSurvivalInterruption(last),interruption:last});
    }
  };
  const cut=async(to,label)=>{
    const s=await read(),geo=roomGeometry(s.room.num);
    if(s.room.num===579)applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
    const from=position(s),edge=edgeOf(geo);
    const proof=cutRail(from,to,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
    if(!proof.ok||!proof.bridgeOk)throw Error('Brax '+label+' exact route not proved');
    const leg=railLeg({waypoints:proof.waypoints},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
    const route={ok:true,rail_complete:!leg.unvalidated,direction:'to_node',exit:label,exit_label:label,from:`r${s.you.row}c${s.you.col}`,to:`r${Math.floor(to.y/1024)+1}c${Math.floor(to.x/1024)+1}`,legs:[leg],jumps:0,all_declared:true,waypoints:leg.waypoints.length};
    if(!route.rail_complete||!checkRoute(route,{edge}).ok)throw Error('Brax '+label+' cut check refused');
    const file=join(out,id+'-'+label+'.json');writeFileSync(file,JSON.stringify({stones:[{node:'brax',room:s.room.num,routes:[route]}]}));await follow(file,label);
  };
  const jump=async(to,expectedFloor)=>{
    await command('rest',{stand:true});await command('jump',{to_row:to.row,to_col:to.col});
    // The existing mover may choose a body-clearing lane within this square.
    // Accept that legal adjustment, then independently require the expected shelf below.
    const landed=await until(async()=>{const s=await read(),p=position(s);return s.room.num===579&&s.you.row===to.row&&s.you.col===to.col&&Math.hypot(p.x-to.x,p.y-to.y)<=512?s:null;},'Brax fall landing not observed',12000);
    const s=await read(),p=position(s),geo=roomGeometry(579);
    applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([k,height])=>[Number(k),{height,type:4}])),null,{geometryOf:()=>geo});
    const actualFloor=floorAt(geo,p.x,p.y);
    if(!Number.isFinite(actualFloor)||Math.abs(actualFloor-expectedFloor)>1)throw Error('Brax landed on wrong shelf');
    log('landing',{position:p,floor_client:expectedFloor});return landed;
  };
  const update=fn=>journal.change(g=>{if(g?.id!==batchId)throw Error('Brax batch was replaced');fn(g);return g;});
  const phase=async(wanted)=>until(async()=>{let g=await update(g=>{});if(g.failure)throw Error(g.failure);return wanted.includes(g.phase)?g:null;},'Brax group phase timed out',240000);
  const pull=async(lever)=>{
    await walkPoint(lever.stand);const l=await call('look',{agent});
    const found=l.objects.filter(o=>/lever/i.test(o.name)&&o.row===lever.row&&o.col===lever.col);
    if(found.length!==1)throw Error('Brax lever not uniquely visible');
    const since=(await read()).ev_seq;
    const reply=await command('act',{verb:'activate',target:found[0].id});
    const confirmed=await awaitLeverConfirmation(reply,{since,
      waitEvent:args=>command('wait_for_event',args),observedRaised:async()=>(await read()).doors.observed?.[3]===800});
    if(!confirmed)throw Error('Brax lever switch was not confirmed');
    log('lever',{row:lever.row,col:lever.col,id:found[0].id});
    if((await read()).doors.observed?.[3]===800)await update(g=>{g.raisedAt??=Date.now();});
  };
  const cross=async(row,col,to)=>{
    await command('walk_to',{row,col,max_steps:12,arrive_within:2});
    await until(async()=>{const s=await read();return s.room.num===to?s:null;},'Brax room crossing failed',12000);
    await command('cancel_movement');log('entered',{room:to});
  };
  const northFall=async(col)=>{
    const p=position(await read());
    // At full height the center spire and platform share one floor.
    const x=(col-1)*1024+512;await walkPoint({x,y:14848});
    await jump({row:8,col,x,y:7680},8160);await walkPoint({row:7,col});
  };
  const onward=async(room,to,label,row,col,next)=>{
    for(let attempt=0;attempt<3;attempt++){
      const s=await read();if(s.room.num===next)return;
      if(s.room.num!==room)throw Error('Brax '+label+' unexpected recovery room');
      try{await cut(to,label+'-'+attempt);await cross(row,col,next);return;}
      catch(error){
        if(!error.survival||attempt===2)throw error;
        log('survival-interruption',{label,attempt,reply:error.interruption});
        let stableSince=0,lastHP=0;
        await until(async()=>{
          const s=await read();
          if(s.room.num!==room)throw Error('Brax survival changed rooms');
          if(!readyAfterSurvival(s,Math.max(0.9,ctx.minHealth??0.9))||s.hp.value<lastHP)stableSince=0;
          else stableSince ||= Date.now();
          lastHP=s.hp.value;
          return stableSince&&Date.now()-stableSince>=8000?s:null;
        },'Brax keeper recovery timed out',180000);
        log('survival-recovered',{label,attempt,position:position(await read())});
      }
    }
  };
  const finish=async()=>{
    await onward(579,{x:62976,y:512},'north-exit',0,62,578);
    await onward(578,{x:50176,y:27136},'cragged-east',27,51,826);
    await onward(826,{x:44544,y:18944},'caverns-east',19,45,827);
    const s=await read();state.brax.success=braxArrival(s);log('objective',{success:state.brax.success,room:s.room,you:s.you,hp:s.hp});
    if(!state.brax.success)throw Error('Ancient Graveyard of Brax not reached');
    await command('autopilot',{action:'set',mode:'idle',assigned_room:827,roam:false});return true;
  };
  try{
    let s=await read();log('start',{room:s.room,you:s.you,hp:s.hp});
    if(braxArrival(s)){state.brax.success=true;return true;}
    if(resumeNorthLedge){
      const p=position(s);
      if(s.room.num!==579||s.you.row!==7||![55,56].includes(s.you.col)||floorAt(roomGeometry(579),p.x,p.y)!==8160)throw Error('Brax continuation requires the actual north shelf');
      log('north-shelf-continuation',{position:p});return await finish();
    }
    // Explicit measured continuation: no placement and no inferred lift timing.
    if(resumeRaisedAt!=null){
      if(!Number.isFinite(resumeRaisedAt)||Date.now()>resumeRaisedAt+100000||s.room.num!==579||s.doors.observed?.[3]!==800)throw Error('Brax lift continuation is not current');
      log('continuation',{raised_at:resumeRaisedAt});await sleep(Math.max(0,resumeRaisedAt+liftWaitMs()-Date.now()));
      await northFall(55);return await finish();
    }
    if(s.room.num!==579){
      await command('travel',{to:589,run_errands:false});
      await until(async()=>{const t=await read();return t.room.num===589?t:null;},'Brax approach did not reach Sentinel',600000);
      await command('travel',{to:579,max_hops:1,run_errands:false});
      await until(async()=>{const t=await read();return t.room.num===579?t:null;},'Brax east entrance not reached',240000);
    }
    await command('cancel_movement');await command('rest',{stand:true});
    // Ordinary travel lands beside the eastern exit, not at the recorded rail head.
    // Survival may also have moved us to cover. Prove a walk from the actual body.
    const approach=JSON.parse(readFileSync(approachFile,'utf8')).stones.find(stone=>stone.node==='brax')?.routes[0];
    const head=approach?.legs[0]?.waypoints[0];if(!head)throw Error('Brax approach rail has no head');
    s=await read();const here=position(s),geo=roomGeometry(579);
    applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(s.doors.observed).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
    const floor=floorAt(geo,here.x,here.y);
    const alreadyOnRail=approach.legs.filter(l=>l.kind==='walk').some(l=>{const near=distanceToRail(l.waypoints,here,{floor});return near.onShelf&&near.d<=1024;});
    if(!alreadyOnRail)await cut(head,'rail-entry');
    await follow(approachFile,'cliffs');
    s=await read();if(s.room.num!==579||Math.hypot(position(s).x-55808,position(s).y-32000)>160)throw Error('Brax south takeoff not reached');
    const server=(await(await fetch(new URL('health',controlURL))).json()).game_server;
    journal=groupJournal(`${server.host}:${server.port}`);
    ticket=agent+'-'+randomUUID();
    await until(async()=>{
      s=await read();if(s.doors.observed?.[3]!==250)return false;
      let accepted=false;
      const g=await journal.change(g=>{
        const now=Date.now();
        if(!g||((g.phase==='departed'||g.failure)&&now>=g.readyAfter))g={id:randomUUID(),phase:'boarding',cutoff:now+gatherMs,readyAfter:now+480000,members:[]};
        if(g.phase!=='boarding'||now>g.cutoff||g.members.length>=25)return g;
        const m={ticket,agent,character:keeper.character,pid:process.pid,slot:g.members.length,aboard:false,corners:false,gone:false};
        g.members.push(m);accepted=true;return g;
      });
      if(accepted){batchId=g.id;return true;}return false;
    },'Brax lift unavailable for a new group',600000);
    let g=await update(g=>{}),me=g.members.find(m=>m.ticket===ticket);
    // One boarding trajectory at a time keeps the common landing clear.
    const lane=me.slot%2,col=55+lane,x=55808+lane*1024;
    await until(async()=>{const g=await update(g=>{});if(g.failure)throw Error(g.failure);return g.members.slice(0,me.slot).filter(m=>m.slot%2===lane).every(m=>m.aboard);},'Brax preceding boarder did not clear landing',240000);
    await walkPoint({x,y:32000});
    await jump({row:25,col,x,y:25088},4000);await walkPoint(platformSlot(me.slot));
    await update(g=>{g.members.find(m=>m.ticket===ticket).aboard=true;});log('aboard',{batch:batchId,slot:me.slot});
    g=await until(async()=>{const g=await update(g=>{if(g.phase==='boarding'&&(Date.now()>=g.cutoff||g.members.length===25)&&g.members.every(m=>m.aboard))g.phase='center';});if(g.failure)throw Error(g.failure);return g.phase!=='boarding'?g:null;},'Brax group did not assemble',300000);
    if(me.slot===0){
      await pull({row:21,col:55,stand:{row:22,col:55}});
      await until(async()=>(await read()).doors.observed?.[2]===800,'Brax center lever effect missing',8000);
      await update(g=>{g.phase='corners';});
    }
    g=await phase(['corners']);
    for(const lever of cornerWork(me.slot,g.members.length))await pull(lever);
    await walkPoint(platformSlot(me.slot));await update(g=>{g.members.find(m=>m.ticket===ticket).corners=true;});
    g=await until(async()=>{let g=await update(g=>{});if(g.failure)throw Error(g.failure);return g.members.every(m=>m.corners)?g:null;},'Brax corner work incomplete',120000);
    if(me.slot===0){
      await until(async()=>(await read()).doors.observed?.[3]===800,'Brax puzzle did not raise lift',10000);
      await update(g=>{g.phase='rising';g.raisedAt??=Date.now();g.readyAfter=g.raisedAt+240000+1000;});
    }
    g=await phase(['rising','leaving','departed']);
    // Full 550/15 seconds plus margin, then validate the packet and floor.
    await sleep(Math.max(0,g.raisedAt+liftWaitMs()-Date.now()));
    s=await read();if(s.room.num!==579||s.doors.observed?.[3]!==800||s.doors.observed?.[4]!==510)throw Error('Brax lift height did not validate');
    await update(g=>{if(g.phase==='rising')g.phase='leaving';});
    // Assemble two half-square-spaced queues before waiting for the preceding fall.
    // Successive riders then advance half a square, rather than walking from a distant station.
    await walkPoint(departureSlot(me.slot));log('departure-queue',{slot:me.slot});
    await until(async()=>{let g=await update(g=>{});if(g.failure)throw Error(g.failure);return g.members.slice(0,me.slot).filter(m=>m.slot%2===lane).every(m=>m.gone);},'Brax preceding jumper did not clear north ledge',80000);
    await northFall(col);
    // Walk off the landing before the next member uses the same trajectory.
    await update(g=>{g.members.find(m=>m.ticket===ticket).gone=true;if(g.members.every(m=>m.gone))g.phase='departed';});
    return await finish();
  }catch(e){log('failure',{reason:e.message});state.brax.failure=e.message;
    if(journal&&batchId)await update(g=>{
      // After a member has cleared the landing, its onward travel cannot abort riders.
      if(g.members.find(m=>m.ticket===ticket)?.gone)return;
      g.failure=e.message;
      g.readyAfter=g.raisedAt?g.raisedAt+241000:Math.max(g.readyAfter,Date.now()+458000);
    }).catch(()=>{});
    return {ok:false,why:e.message};
  }
}
