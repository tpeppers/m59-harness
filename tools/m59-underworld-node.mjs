#!/usr/bin/env node
// Underworld brazier solver and checked Session runner; ordinary player actions only.
// Offline: --mask 27. Native lab: explicit --config FILE --scene FILE --out DIR [--initial-mask N].
import {fineRouter} from './m59-fineroute.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {quantizeRailPoint} from './m59-railfollow.mjs';
import {auditNodeWalk} from './m59-node-route-audit.mjs';
import {meldVerdict} from './m59-nodecheck.mjs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
export const UNDERWORLD_BRAZIERS=Object.freeze([
  {index:1,row:4,col:7},{index:2,row:2,col:23},{index:3,row:20,col:29},
  {index:4,row:31,col:15},{index:5,row:20,col:2}
]);
export const BRAZIER_FLIPS=Object.freeze([13,26,21,11,22]);
export const UNDERWORLD_TELEPORTERS=Object.freeze([
  {row:3,col:7},{row:2,col:25},{row:21,col:30},{row:32,col:16},{row:21,col:2},{row:10,col:6}
]);
const square=p=>({row:Math.floor(p.y/1024)+1,col:Math.floor(p.x/1024)+1});
const maskOk=mask=>Number.isInteger(mask)&&mask>=0&&mask<=31;
export function solveBraziers(mask,{last=null}={}){
  if(!maskOk(mask))throw Error('flame mask must be 0..31');
  if(last!=null&&(!Number.isInteger(last)||last<1||last>5))throw Error('invalid final brazier');
  if(mask===31)return [];
  const queue=[{mask,steps:[]}],seen=new Set();
  for(let i=0;i<queue.length;i++){
    const at=queue[i];if(at.mask===31){if(last==null||at.steps.at(-1)===last)return at.steps;continue;}
    if(seen.has(at.mask))continue;seen.add(at.mask);
    for(let j=0;j<5;j++)if(!(at.mask&(1<<j)))queue.push({mask:at.mask^BRAZIER_FLIPS[j],steps:[...at.steps,j+1]});
  }
  throw Error('no unlit-only sequence found');
}
export function flameState(object){
  const a=object?.animate??object?.appearance?.animation;
  const type=a?.animation??a?.type,group=a?.group,low=a?.groupLow??a?.group_low;
  if(type===1&&group===1)return false;
  if(type===2&&Number.isInteger(low)&&low>=2)return true;
  return null;
}
export function readBrazierMask(objects,nameOf=o=>o.name){
  let mask=0;const braziers=[];
  for(const b of UNDERWORLD_BRAZIERS){
    const found=objects.filter(o=>/^brazier$/i.test(nameOf(o)??'')&&o.row===b.row&&o.col===b.col);
    if(found.length!==1)throw Error('missing_or_ambiguous_brazier_'+b.index);
    const lit=flameState(found[0]);if(lit==null)throw Error('unknown_flame_state_'+b.index);
    if(lit)mask|=1<<(b.index-1);braziers.push({...b,id:found[0].id,lit});
  }
  return {mask,braziers};
}
// A trigger-square exclusion, not a second terrain model. Walls/floors stay in RoomGeometry.
export function crossesTrigger(a,b,trigger){
  const lo={x:(trigger.col-1)*1024,y:(trigger.row-1)*1024},hi={x:trigger.col*1024-1e-6,y:trigger.row*1024-1e-6};
  let enter=0,leave=1;
  for(const axis of ['x','y']){
    const delta=b[axis]-a[axis];
    if(!delta){if(a[axis]<lo[axis]||a[axis]>hi[axis])return false;continue;}
    const t0=(lo[axis]-a[axis])/delta,t1=(hi[axis]-a[axis])/delta;
    enter=Math.max(enter,Math.min(t0,t1));leave=Math.min(leave,Math.max(t0,t1));
    if(enter>leave)return false;
  }
  return true;
}
export function avoidUnderworldTriggers(geo,{allowCentral=false}={}){
  const triggers=allowCentral?UNDERWORLD_TELEPORTERS:[...UNDERWORLD_TELEPORTERS,{row:16,col:16}];
  return new Proxy(geo,{get(target,key){
    if(key==='traceFineMoveClient')return (ax,ay,bx,by,options)=>{
      const trace=target.traceFineMoveClient(ax,ay,bx,by,options);
      const hit=trace.arrived&&triggers.find(t=>crossesTrigger({x:ax,y:ay},{x:trace.x,y:trace.y},t));
      return hit?{...trace,moved:false,arrived:false,blocked:true,reason:'underworld_portal_trigger',trigger:hit}:trace;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}
export function underworldRegionPlan(geo,worldMap,from,target,range,{allowCentral=false,returnTo=null,returnWaypointBudget=45}={}){
  const safe=avoidUnderworldTriggers(geo,{allowCentral}),R=fineRouter(1,{geometry:safe,worldMap,exactWalk:true});
  const seen=R.closure(from),cost=new Map();
  // Closure insertion follows its parent, so retain the actual route distance to each shelf.
  for(const [key,p] of seen){const parent=p.from==null?null:seen.get(p.from);
    cost.set(key,parent?(cost.get(p.from)??0)+Math.hypot(p.x-parent.x,p.y-parent.y):0);}
  const returnFloor=returnTo?R.floorAt((returnTo.col-.5)*1024,(returnTo.row-.5)*1024):null;
  const candidates=[...seen.values()].filter(p=>{
    const s=square(p);return Math.abs(s.row-target.row)<=range&&Math.abs(s.col-target.col)<=range;
  }).sort((a,b)=>(returnFloor==null?0:Math.abs(R.floorAt(a.x,a.y)-returnFloor)-Math.abs(R.floorAt(b.x,b.y)-returnFloor))||cost.get(R.key(a.x,a.y))-cost.get(R.key(b.x,b.y)));
  for(const p of candidates){
    // Keep the reachable fine point: a coarse square can contain several shelves.
    const plan=R.planWalkToPoint(from,p);if(!plan.ok)continue;
    const audit=auditNodeWalk(plan,safe);if(!audit.ok)continue;
    let returnRoute=null;
    if(returnTo){
      returnRoute=underworldRegionPlan(geo,worldMap,p,returnTo,0,{allowCentral:true});
      if(!returnRoute.audit.ok||returnRoute.plan.legs[0].waypoints.length>returnWaypointBudget)continue;
    }
    return {plan,audit,geometry:safe,return_route:returnRoute};
  }
  return {plan:{ok:false,why:'no_checked_activation_region',room:1,target,range,walking_points:seen.size},audit:{ok:false}};
}
export async function underworldPositionSnapshot(s,{allowExit=false}={}){
  if(!await s.confirmPosition())throw Error('underworld_position_not_confirmed');
  const room=s.world.room.num,c=s.client,pose={row:c.self.row,col:c.self.col,x:c.self.x,y:c.self.y};
  if(room!==1){if(allowExit)return {room,pose};throw Error('underworld_left_before_completion');}
  return {room,objects:[...c.room.objects.values()],at:protocolToClient(c.self),pose};
}
export async function runUnderworldNode(s,{maxMs=900000,exit=true,onEvent=()=>{},isInterrupted=()=>false}={}){
  if(s.world?.room?.num!==1)throw Error('underworld_node_requires_existing_room_1');
  const began=Date.now(),generation=s.movementGeneration,c=s.client;
  const check=()=>{if(isInterrupted()||s.movementWasCancelled(generation))throw Error('underworld_trial_cancelled');if(Date.now()-began>maxMs)throw Error('underworld_trial_timeout');};
  const emit=(kind,data)=>onEvent({kind,at:Date.now(),ms:Date.now()-began,...data});
  const snapshot=async options=>{check();return underworldPositionSnapshot(s,options);};
  const name=o=>c.rsc.get(o.nameRsc)??o.name;
  const walk=async(target,range,label,{escaping=false,prepared=null,startIndex=0,stopInRange=false,returnTo=null}={})=>{
    const snap=await snapshot(),g=s.world.geometry;
    const route=prepared??underworldRegionPlan(g,s.world.map,snap.at,target,range,{allowCentral:escaping,returnTo});
    emit('route',{label,from:snap.pose,target,range,plan:route.plan,audit:route.audit});
    if(!route.audit.ok)throw Error('underworld_'+label+'_route_not_proved');
    let nextIndex=startIndex;
    for(const [index,p] of route.plan.legs[0].waypoints.entries()){
      if(index<startIndex)continue;
      if(stopInRange&&Math.abs(c.self.row-target.row)<=range&&Math.abs(c.self.col-target.col)<=range)break;
      check();if(s.world.room.num!==1){if(escaping)return {escaped:true,room:s.world.room.num};throw Error('unexpected_underworld_exit');}
      if(escaping&&![...c.room.objects.values()].some(o=>o.row===16&&o.col===16&&/^rip in space$/i.test(name(o)??'')))throw Error('corpse_node_window_expired');
      const wire=quantizeRailPoint(p,{floorAt:(x,y)=>g.floorBaseAtClient(x,y,g.leafAtClient(x,y)),edge:(a,b)=>route.geometry.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true});
      if(!wire.ok)throw Error(wire.reason);
      const reply=await s.walkFine(wire.protocol.x,wire.protocol.y,{maxSteps:10,stride:32,arriveWithin:3,exactArrival:true,holdShelf:true,movementGeneration:generation});
      emit('waypoint',{label,index,target_client:p,target_protocol:wire.protocol,reply,endpoint_validation:reply.arrived?null:s.validateFineTarget(wire.protocol.x,wire.protocol.y,{slide:true}),collision_vertical:s.collisionVertical??null,position:{row:c.self?.row,col:c.self?.col,x:c.self?.x,y:c.self?.y}});
      if(s.world.room.num!==1&&escaping)return {escaped:true,room:s.world.room.num};
      if(!reply.arrived)throw Error('underworld_'+label+'_waypoint_'+index+'_'+(reply.reason??'not_arrived'));
      nextIndex=index+1;
    }
    const end=await snapshot({allowExit:escaping});
    if(escaping&&end.room!==1)return {escaped:true,room:end.room};
    if(Math.abs(end.pose.row-target.row)>range||Math.abs(end.pose.col-target.col)>range)throw Error('activation_box_not_confirmed');
    return {arrived:true,pose:end.pose,next_index:nextIndex};
  };
  let solved=false,solvedAt=null,centralRoute=null;
  for(let attempt=0;attempt<12;attempt++){
    const snap=await snapshot(),state=readBrazierMask(snap.objects,name),steps=solveBraziers(state.mask,{last:4});
    emit('puzzle',{mask:state.mask,steps,position:snap.pose});
    if(!steps.length){solved=true;break;}
    const index=steps[0],b=UNDERWORLD_BRAZIERS[index-1],final=(state.mask^BRAZIER_FLIPS[index-1])===31;
    await walk(b,3,'brazier-'+index,{returnTo:final?{row:16,col:16}:null});
    const fresh=await snapshot(),before=readBrazierMask(fresh.objects,name);
    if(before.mask!==state.mask){emit('state_changed',{expected:state.mask,actual:before.mask});continue;}
    if((before.mask^BRAZIER_FLIPS[index-1])===31){
      // Finish at the southern brazier and prove the full timed approach/return BEFORE lighting it.
      centralRoute=underworldRegionPlan(s.world.geometry,s.world.map,fresh.at,{row:16,col:16},0,{allowCentral:true});
      emit('timed_return_prepared',{from:fresh.pose,plan:centralRoute.plan,audit:centralRoute.audit});
      if(!centralRoute.audit.ok||centralRoute.plan.legs[0].waypoints.length>45)throw Error('timed_corpse_return_exceeds_waypoint_budget');
    }
    const seq=c.evSeq,id=before.braziers[index-1].id;
    await s.pacer.submit('act',()=>c.activate(id));await new Promise(r=>setTimeout(r,400));
    const after=readBrazierMask((await snapshot()).objects,name);
    emit('activate_brazier',{index,before:before.mask,expected:before.mask^BRAZIER_FLIPS[index-1],after:after.mask,messages:c.eventsSince(seq).filter(e=>e.kind==='message').map(e=>e.text)});
    if(after.mask===before.mask)throw Error('brazier_activation_no_change');
    if(after.mask===31){solved=true;solvedAt=Date.now();break;}
  }
  if(!solved)throw Error('brazier_activation_budget');
  if(!centralRoute){const at=await snapshot();centralRoute=underworldRegionPlan(s.world.geometry,s.world.map,at.at,{row:16,col:16},0,{allowCentral:true});}
  const staging=await walk({row:16,col:16},2,'central-rip-approach',{prepared:centralRoute,stopInRange:true});
  const snap=await snapshot(),rip=snap.objects.filter(o=>o.row===16&&o.col===16&&/^rip in space$/i.test(name(o)??''));
  if(rip.length!==1)throw Error('central_corpse_node_not_present');
  const before=c.vitals()?.mana?.max,seq=c.evSeq;
  await s.pacer.submit('act',()=>c.activate(rip[0].id));await new Promise(r=>setTimeout(r,1000));await snapshot();
  const messages=c.eventsSince(seq).filter(e=>e.kind==='message').map(e=>e.text),verdict=meldVerdict(messages.join('\n'));
  const after=c.vitals()?.mana?.max;
  emit('activate_node',{id:rip[0].id,before_max_mana:before,after_max_mana:after,verdict,messages,elapsed_since_solved:solvedAt?Date.now()-solvedAt:null});
  if(!['melded','already'].includes(verdict.verdict))throw Error('corpse_node_activation_unconfirmed');
  if(verdict.verdict==='melded'&&!(Number.isFinite(before)&&after>before))throw Error('corpse_node_mana_grant_not_observed');
  let escaped=null;if(exit)escaped=await walk({row:16,col:16},0,'central-rip-exit',{escaping:true,prepared:centralRoute,startIndex:staging.next_index});
  if(exit&&!escaped?.escaped)throw Error('corpse_node_exit_not_confirmed');
  return {complete:true,puzzle_solved:true,status:verdict.verdict,mana_grant:after-before,escaped:escaped?.escaped??false,exit_room:escaped?.room??null,elapsed_ms:Date.now()-began};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),has=k=>args.includes('--'+k),flag=k=>args[args.indexOf('--'+k)+1];
  if(has('help')){console.log('--mask N (offline); or explicit --config FILE --scene FILE --out DIR [--initial-mask N] [--horizon-ms N] [--stay]');process.exit(0);}
  if(has('mask')){console.log(JSON.stringify({mask:Number(flag('mask')),sequence:solveBraziers(Number(flag('mask')))}));process.exit(0);}
  for(const k of ['config','scene','out'])if(!has(k))throw Error('--'+k+' required');
  const scene=JSON.parse(readFileSync(flag('scene'),'utf8'));if(scene.room?.num!==1)throw Error('authored scene must start in Underworld');
  const maxMs=Number(has('horizon-ms')?flag('horizon-ms'):900000);if(!Number.isInteger(maxMs)||maxMs<1||maxMs>1800000)throw Error('invalid horizon');
  const initialMask=has('initial-mask')?Number(flag('initial-mask')):null;if(initialMask!=null&&!maskOk(initialMask))throw Error('invalid initial mask');
  const out=resolve(flag('out'));mkdirSync(out,{recursive:true});
  const receipt={format:'m59-underworld-node-lab/1',at:new Date().toISOString(),authored_initial_mask:initialMask,events:[],finished:false};
  const {createShadowReplayAdapter}=await import('./m59-shadow-replay.mjs');
  const {readAdminRoom,readAdminObjects}=await import('./m59-scene-admin.mjs');
  const {dm,setProp,sendMsg}=await import('./m59-dm.mjs');
  let adapter,aborted=false;
  try{
    const env={...process.env,M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
    // The replay config must select the owned container lab, never the shared shadow server.
    const config=JSON.parse(readFileSync(flag('config'),'utf8'));
    const roster=JSON.parse(readFileSync(resolve(resolve(flag('config'),'..'),config.fleet_file),'utf8'));
    if(Number(roster[config.agent]?.credentials?.port)!==17959)throw Error('underworld puzzle lab requires isolated 17959 container');
    adapter=await createShadowReplayAdapter({configFile:resolve(flag('config')),isolate:false,terminateAfterTrial:true,engineRoot:resolve(fileURLToPath(new URL('..',import.meta.url)))});
    receipt.trial=await adapter.run({scene,frame:{at:Date.now(),scene},horizonMs:maxMs,
      variant:{id:'underworld-node',kind:'baseline',reload:{labScenery:true,exactMonsterPlacement:true,noMonsters:true}},
      onPrepared:async(s,k)=>{
        k.startWatchdog=()=>{};k.loop=()=>new Promise(()=>{});
        if(initialMask!=null){const room=await readAdminRoom(1,{env});
          await dm(['A','B','C','D','E'].map((v,i)=>setProp(room.room_object,'pbLit'+v,(initialMask>>i)&1)).concat(sendMsg(room.room_object,'SetPortals')),{env});
          const check=await readAdminRoom(1,{env});
          const observed=['a','b','c','d','e'].reduce((m,v,i)=>m|(check.properties['pblit'+v]?.value?1<<i:0),0);
          if(observed!==initialMask)throw Error('authored_brazier_mask_not_applied');receipt.authored_mask_verified=observed;}
        receipt.before_admin=(await readAdminObjects([s.client.selfId],{env})).map(p=>({node_mask:p.properties.pinodelist?.value,mana:p.mana,hp:p.hp}));
      },
      onStarted:async s=>{await s.confirmPosition();
        receipt.observed_initial_mask=readBrazierMask([...s.client.room.objects.values()],o=>s.client.rsc.get(o.nameRsc)??o.name).mask;
        if(initialMask!=null&&receipt.observed_initial_mask!==initialMask)throw Error('authored_flame_wire_state_not_observed');
        runUnderworldNode(s,{maxMs,exit:!has('stay'),isInterrupted:()=>aborted,onEvent:e=>{receipt.events.push(e);if(e.kind!=='waypoint')console.log(JSON.stringify({...e,plan:e.plan?{ok:e.plan.ok,waypoints:e.plan.legs?.[0]?.waypoints.length,why:e.plan.why}:undefined}));}})
        .then(async r=>{receipt.result=r;receipt.after_admin=(await readAdminObjects([s.client.selfId],{env})).map(p=>({node_mask:p.properties.pinodelist?.value,mana:p.mana,hp:p.hp}));if(!(Number(receipt.after_admin[0]?.node_mask)&128))throw Error('corpse_node_bit_not_observed');receipt.finished=true;})
        .catch(e=>{receipt.error=e.stack;receipt.finished=true;});},
      onStopping:()=>{aborted=true;},shouldStop:()=>receipt.finished});
  }catch(e){receipt.error=e.stack;}
  finally{aborted=true;try{await adapter?.reset();receipt.baseline_restored=!!adapter;}catch(e){receipt.cleanup_error=e.message;}try{await adapter?.close();}catch(e){receipt.close_error=e.message;}}
  const file=join(out,'underworld-node-'+Date.now()+'.json');writeFileSync(file,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({file,result:receipt.result,error:receipt.error,outcome:receipt.trial?.outcome,baseline_restored:receipt.baseline_restored},null,2));
  process.exitCode=receipt.result?.complete&&!receipt.error&&!receipt.cleanup_error&&!receipt.close_error?0:2;
}
