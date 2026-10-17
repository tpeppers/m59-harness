// Offline integration with a local keeper endpoint; no game server or roster.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {originLabel} from './m59-move-origin.mjs';
import {checkedIslandWalk,activeOwnedFineRecovery,recoverIslandFineWalk,walkHollowsOut,confirmIslandFineArrival,readIslandOccupancy,readIslandFinePosition} from './m59-island-finewalk.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {applyDoorState} from './m59-routes.mjs';
import {copyFineGeometry} from './m59-observed-geometry.mjs';
const scratch=mkdtempSync(join(tmpdir(),'m59-fine-recovery-'));
const oldRegistry=process.env.M59_KEEPER_BAND_REGISTRY;
const origin={source:'fleetscript',name:'fine-recovery',run_id:'fixture'},label=originLabel(origin);
const agent='fine-recovery-fixture',room={num:2502,object_id:777},vigor={value:200};
let pose={id:1,x:2152,y:1392,row:21,col:33},hp={value:20,max:20},pre=null,moves=0,rests=0,proactive=false,recoverySource='keeper',positionId=null,livePid=null;
const recovery=()=>proactive?{faculties:{movement:{owner:'fleetscript:fine-recovery',expires_in_ms:10000}},
 survival_decisions:{current:{source:recoverySource,strategy:'nearest_refuge',status:hp.value<20?'approaching':'ended',ended_at:hp.value<20?null:Date.now()}},
 safe_spot:{works:true,at:{row:pose.row,col:pose.col}}}:undefined;
const server=createServer((request,response)=>{
 if(!request.url.startsWith('/state')&&!['/live','/health'].includes(request.url)){response.writeHead(404);response.end();return;}
 response.setHeader('content-type','application/json');
 response.end(JSON.stringify({agent,character:'fine-recovery-fixture',pid:request.url==='/live'?(livePid??process.pid):process.pid,in_game:true,room,you:pose,hp,vigor,objects:[],autopilot_status:recovery(),
   position_read:{...pose,id:positionId??pose.id,at:Date.now(),room_object_id:room.object_id},movement:{last_preempted:pre}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const registry=join(scratch,'bands.json');writeFileSync(registry,JSON.stringify({'fine-recovery-test':port-99}));
process.env.M59_KEEPER_BAND_REGISTRY=registry;
try{
 const ctx={agent,fleet:'fine-recovery-test',origin,state:{},call:async(name,args)=>{
  if(name==='walk_to'){
   assert(args.avoid_squares.some(p=>p.row===1&&p.col===41),'the north side exit reaches the movement request');
   assert(!args.avoid_squares.some(p=>p.row===Math.floor(args.y/64)&&p.col===Math.floor(args.x/64)));
   if(proactive)assert.equal(hp.value,20,'no fine command before owned recovery completes');
   if(++moves===1&&!proactive){hp={value:14,max:20};pre={at:Date.now(),by:{source:'keeper'},preempted:{kind:'walk',ordered_by:label}};
    return {error:`agent "${agent}" is not in game — call join first`};}
   pose={...pose,x:args.x,y:args.y,row:Math.floor(args.y/64),col:Math.floor(args.x/64)};return {arrived:true};
  }
  if(name==='status')return {movement:{last_preempted:pre},autopilot_status:recovery()??{safe_spot:{works:true,at:{row:pose.row,col:pose.col}}}};
  if(name==='look')return {room,you:pose,hp,vigor};
  if(name==='rest_up'){rests++;hp={value:20,max:20};return {};}
  if(name==='rest')return {};
  throw Error('unexpected fixture call '+name);
 }};
 const result=await checkedIslandWalk(ctx,{x:2410,y:1062},{room:2502,budgetMs:60000});
 assert.equal(result.ok,true);assert.equal(rests,1);assert(moves>1);
 assert.equal(hp.value,20);assert(Math.hypot(pose.x-2410,pose.y-1062)<=8);
 proactive=true;pre=null;moves=0;rests=0;pose={id:1,x:2152,y:1392,row:21,col:33};hp={value:14,max:20};
 assert(activeOwnedFineRecovery(ctx,{autopilot_status:recovery()}));
 assert(!activeOwnedFineRecovery({...ctx,origin:{...origin,name:'foreign'}},{autopilot_status:recovery()}));
 const cooperative=await checkedIslandWalk(ctx,{x:2410,y:1062},{room:2502,budgetMs:60000});
 assert.equal(cooperative.ok,true);assert.equal(rests,1);assert(moves>0);
 for(const source of ['recovery','travel','practice']){
  recoverySource=source;pre=null;moves=0;rests=0;pose={id:1,x:2152,y:1392,row:21,col:33};hp={value:14,max:20};
  assert(activeOwnedFineRecovery(ctx,{autopilot_status:recovery()}),'the keeper context '+source+' is not a different movement owner');
  const resumed=await checkedIslandWalk(ctx,{x:2410,y:1062},{room:2502,budgetMs:60000});
  assert(resumed.ok);assert.equal(rests,1);assert(moves>0,'the original fine goal resumes only after owned recovery');
 }
 recoverySource='keeper';
 const map=loadMap(),hollows=roomExitSquares(map.rooms[2502],{includeInland:true});
 assert(hollows.has('1,41')&&hollows.has('2,41')&&hollows.has('47,78'));
 const merb=roomExitSquares(map.rooms[2502],{to:2503,includeInland:true});
 assert(merb.has('1,41')&&!merb.has('10,78')&&merb.has('47,78'));
 assert(!roomExitSquares(map.rooms[27],{to:2500}).has('11,1'));
 {
  const geo=copyFineGeometry(roomGeometry(27)),from={row:58,col:44,x:2872,y:3712};
  applyDoorState({rooms:{27:{num:27}}},27,{1:24,2:24,3:24,4:24,5:24},{geometryOf:()=>geo});
  const options={rows:geo.rows,cols:geo.cols,to:2500,includeInland:true};
  const legacy=roomExitSquares(map.rooms[27],options),actual=roomExitSquares(map.rooms[27],{...options,includeInland:false});
  assert(legacy.has('58,44'),'the recorded native arrival lies on the guarded edge');
  const departed=roomExitSquares(map.rooms[27],{...options,from:{...from,confirmed:true}});
  assert(!departed.has('57,44'),'the inward buffer no longer traps the observed edge arrival');
  for(const cell of actual)assert(departed.has(cell),'every actual wrong exit remains forbidden');
  for(const pose of [from,{...from,confirmed:true,predicted:true},{row:56,col:46,confirmed:true}])
   assert.deepEqual(roomExitSquares(map.rooms[27],{...options,from:pose}),legacy,'unknown, predicted or cleared arrivals retain the full buffer');
  legacy.delete('58,44');departed.delete('58,44'); // the existing current-cell departure allowance
  const trapped=await cutFineRailAsync(geo,from,{x:96,y:736},{avoidSquares:legacy,maxMs:4000});
  assert(!trapped.ok||!trapped.bridgeOk,'the old guard actually reproduces the recorded refusal');
  const escaped=await cutFineRailAsync(geo,from,{x:96,y:736},{avoidSquares:departed,maxMs:4000});
  assert(escaped.ok&&escaped.bridgeOk,'the same geometry has a complete departure without crossing a wrong exit');
  for(const point of escaped.waypoints){const cell=(Math.floor(point.y/1024)+1)+','+(Math.floor(point.x/1024)+1);
   assert(cell==='58,44'||!actual.has(cell),'departure never reaches another wrong-exit cell');}
 }
 const forbidden=await cutFineRailAsync(roomGeometry(2502),{x:2152,y:1392,row:21,col:33},{x:2656,y:96},
  {avoidSquares:hollows,maxMs:2000});
 assert(!forbidden.ok||!forbidden.bridgeOk,'a blocked edge exit cannot become a proved fine goal');
 await assert.rejects(cutFineRailAsync(roomGeometry(2502),pose,{x:2410,y:1062},{avoidSquares:['1,41']}),/must be a Set/);
 // A fresh keeper episode can end while an ailment leaves health below full.
 // The initial owned observation licenses recovery only at that same actual
 // refuge under the controller's still-live lease, never at a foreign body.
 const ownLease={owner:'fleetscript:fine-recovery',expires_in_ms:10000};
 const initial={room:{num:2502,object_id:777},you:{id:1,x:2083,y:1466,row:22,col:32},hp:{value:13,max:20},
  autopilot_status:{faculties:{movement:ownLease},survival_decisions:{current:{source:'keeper',strategy:'rest_safe',status:'recovering',ended_at:null}}}};
 async function completedEpisode({lease=ownLease,you=initial.you,cancel=null,attacked=false,initialHealth=13}={}){
  let health=initialHealth,restCount=0,stands=0;
  const x={...ctx,state:{islandCancelFence:1},call:async name=>{
   if(name==='status')return {movement:{last_cancel:cancel},autopilot_status:{faculties:{movement:lease},survival_decisions:{current:null}}};
   if(name==='look')return {room:initial.room,you,hp:{value:health,max:20},vigor};
   if(name==='rest_up'){restCount++;health=restCount===1?18:20;return attacked?{interrupted:'attacked while resting'}:{};}
   if(name==='rest'){stands++;return {};}
   throw Error('unexpected recovery request '+name);
  }};
  const ok=await recoverIslandFineWalk(x,{initial,active:true,deadline:Date.now()+10000,
   read:async()=>({l:{room:initial.room,you,hp:{value:health,max:20},vigor}})});
  return {ok,restCount,stands};
 }
 assert.deepEqual(await completedEpisode(),{ok:true,restCount:2,stands:1});
 assert.deepEqual(await completedEpisode({initialHealth:20,you:{...initial.you,x:initial.you.x+8}}),{ok:true,restCount:0,stands:0});
 assert.deepEqual(await completedEpisode({initialHealth:20,you:{...initial.you,id:2}}),{ok:false,restCount:0,stands:0});
 assert.deepEqual(await completedEpisode({attacked:true}),{ok:false,restCount:1,stands:0});
 for(const options of [{lease:{...ownLease,owner:'fleetscript:foreign'}},{lease:{...ownLease,expires_in_ms:0}},
  {you:{...initial.you,id:2}},{you:{...initial.you,x:initial.you.x+8}}])
  assert.deepEqual(await completedEpisode(options),{ok:false,restCount:0,stands:0});
 await assert.rejects(completedEpisode({cancel:{at:2,by:{source:'operator'}}}),/cancelled_by_operator/);
 async function replacedApproach({foreignAfterHit=false,cancelAfterHit=false,expired=false}={}){
  let health=13,statusReads=0,rests=0,stands=0;
  const x={...ctx,state:{islandCancelFence:1},call:async name=>{
   if(name==='status'){
    statusReads++;const afterHit=rests>0;
    return {hp:{value:health,max:20},vigor,movement:afterHit&&cancelAfterHit?{last_cancel:{at:2,by:{source:'operator'}}}:{},
     autopilot_status:{faculties:{movement:afterHit&&foreignAfterHit?{...ownLease,owner:'fleetscript:foreign'}:ownLease},
      safe_spot:{works:true,at:{row:initial.you.row,col:initial.you.col}},
      survival_decisions:{current:{source:'keeper',strategy:'nearest_refuge',status:
       statusReads%3===0?'recovering':statusReads%3===1?'pending':'approaching',ended_at:null,
       chosen_refuge:{room:initial.room.num,row:initial.you.row,col:initial.you.col+(statusReads%3===0?0:1)}}}}};
   }
   if(name==='rest_up'){
    assert.equal(statusReads%3,0,'rest waits for the active refuge approach to finish');rests++;
    if(rests===1){health=12;return {interrupted:'attacked while resting'};}
    health=20;return {};
   }
   if(name==='look')return {room:initial.room,you:initial.you,hp:{value:health,max:20},vigor};
   if(name==='rest'){stands++;return {};}
   throw Error('unexpected replacement request '+name);
  }};
  const ok=await recoverIslandFineWalk(x,{initial,active:true,pollMs:1,deadline:Date.now()+(expired?-1:1000),
   read:async()=>({l:{room:initial.room,you:initial.you,hp:{value:health,max:20},vigor}})});
  return {ok,rests,stands,statusReads};
 }
 assert.deepEqual(await replacedApproach(),{ok:true,rests:2,stands:1,statusReads:7});
 assert.deepEqual(await replacedApproach({foreignAfterHit:true}),{ok:false,rests:1,stands:0,statusReads:4});
 assert.deepEqual(await replacedApproach({expired:true}),{ok:false,rests:0,stands:0,statusReads:0});
 await assert.rejects(replacedApproach({cancelAfterHit:true}),/cancelled_by_operator/);
 // The body/lease/recovery read is current while the broker snapshot lacks
 // that lease; the older mixed-snapshot implementation returned false at once.
 async function nativeRecovery({foreignAfterRest=false,cancelAfterRest=false,changedBodyAfterRest=false}={}){
  let health=13,rests=0;const nativeStatus=()=>({room:initial.room,you:changedBodyAfterRest&&rests?{...initial.you,id:2}:initial.you,hp:{value:health,max:20},vigor,
    movement:{},autopilot_status:{faculties:{movement:ownLease},safe_spot:{works:true,at:{row:initial.you.row,col:initial.you.col}},survival_decisions:{current:{source:'keeper',strategy:'logoff_safe',status:'recovering',ended_at:null}}}});
  const x={...ctx,state:{islandCancelFence:1},call:async name=>{
   if(name==='status')return {movement:cancelAfterRest&&rests?{last_cancel:{at:2,by:{source:'operator'}}}:{},autopilot_status:{faculties:foreignAfterRest&&rests?{movement:{...ownLease,owner:'fleetscript:foreign'}}:{}}};
   if(name==='rest_up'){rests++;health=20;return {interrupted:'normal keeper recovery stage changed'};}
   throw Error('unexpected native snapshot request '+name);
  }};
  const ok=await recoverIslandFineWalk(x,{initial:nativeStatus(),active:true,deadline:Date.now()+1000,pollMs:1,read:async()=>({l:nativeStatus()})});
  return {ok,rests,reason:x.state.islandRecoveryFailure?.reason};
 }
 assert.deepEqual(await nativeRecovery(),{ok:true,rests:1,reason:undefined},'a completed healthy owned recovery may resume even when its rest result was interrupted');
 assert.deepEqual(await nativeRecovery({foreignAfterRest:true}),{ok:false,rests:1,reason:'foreign_broker_lease'});
 assert.deepEqual(await nativeRecovery({changedBodyAfterRest:true}),{ok:false,rests:1,reason:'interrupted_without_owned_recovery'});
 await assert.rejects(nativeRecovery({cancelAfterRest:true}),/cancelled_by_operator/);
 console.log('native recovery snapshot: stale broker absence cannot end a current owned recovery; completed interrupted rest keeps its actor, cancellation and lease fences');
 console.log('Fine recovery retains its confirmed refuge across completed keeper episodes and rejects foreign, expired, moved, reused and cancelled ownership.');
 proactive=false;pre=null;pose={id:1,x:2112,y:3080,row:48,col:33};hp={value:20,max:20};
 const beforeLower=moves;
 await assert.rejects(walkHollowsOut(ctx,{budgetMs:10000}),/hollows_lower_escape_unproved/);
 assert.equal(moves,beforeLower,'an unproved lower Hollows escape cannot become an uphill movement command');
 pose={id:1,x:1744,y:2814,row:43,col:27};
 let landingCommands=0;
 await assert.rejects(walkHollowsOut({...ctx,call:async(name,args)=>{
  if(name==='walk_to'){
   landingCommands++;assert(Math.hypot(args.x-1750,args.y-2824)<=8,
    'a resumed short landing completes the shelf before any staging walk');
   throw Error('fixture_landing_completion_observed');
  }
  assert.notEqual(name,'jump','resuming on the landing shelf needs no new jump');
  return ctx.call(name,args);
 }},{budgetMs:10000}),/fixture_landing_completion_observed/);
 assert.equal(landingCommands,1);
 let exactReads=0;
 const exact=await confirmIslandFineArrival(async()=>({body:{x:++exactReads===1?108:100,y:100}}),
  {x:100,y:100},{attempts:2,settleMs:1,tolerance:1.6});
 assert.equal(exactReads,2,'exact takeoff confirmation cannot accept the ordinary eight-KOD tolerance');
 assert.equal(exact.error,0);
 // Two native Konima stops: an actual script preemption was followed by a
 // keeper-to-keeper refuge replacement. The original issuer disappeared from
 // last_preempted while the same leased body's recovery was still active.
 for(const retained of [
  {stage:{x:3272,y:1712,row:26,col:51},cover:{x:3256,y:1792,row:28,col:50}},
  {stage:{x:3536,y:1616,row:25,col:55},cover:{x:3512,y:1592,row:24,col:54}},
 ])for(const leaseKind of ['own','foreign','expired','unproved','substituted']){
  room.num=2505;pose={id:1,...retained.stage,predicted:false};hp={value:10,max:20};proactive=false;
  let statuses=0,meals=0;const beforeRests=rests;
  const handoff={...ctx,call:async(name,args)=>{
   if(name==='status'){
    const first=++statuses===1;if(!first)pose={id:leaseKind==='substituted'?2:1,...retained.cover,predicted:false};
    return {hp,vigor,movement:{last_preempted:{at:Date.now(),by:{source:'keeper'},
     preempted:{ordered_by:first&&leaseKind!=='unproved'?label:'keeper:shelter'}}},autopilot_status:{
     faculties:{movement:{owner:first||leaseKind!=='foreign'?'fleetscript:fine-recovery':'fleetscript:foreign',expires_in_ms:!first&&leaseKind==='expired'?0:10000}},
     survival_decisions:{current:{id:first?'first':'replacement',source:'travel',strategy:first?'nearest_refuge':'rest_safe',status:first?'approaching':'recovering',chosen_refuge:{...retained.cover,room:2505}}}}};
   }
   if(name==='use')meals++;
   return ctx.call(name,args);
  }};
  const completed=await recoverIslandFineWalk(handoff,{deadline:Date.now()+5000,pollMs:1,active:false,
   read:async()=>({l:{room,you:pose,hp,vigor}})});
  assert.equal(completed,leaseKind==='own','a proved recovery follows its keeper replacement only under the same live movement lease');
  if(leaseKind==='own'){assert.equal(hp.value,20);assert.equal(rests,beforeRests+1);assert(statuses>=2);}
  else assert.equal(rests,beforeRests,'foreign and expired control cannot authorize rest');
  assert.equal(meals,0,'full vigor does not need an invented healing item');
 }
 room.num=1;pose={id:1,x:796,y:1134,row:17,col:12,predicted:false};hp={value:1,max:20};
 await assert.rejects(readIslandFinePosition(ctx),/traveller_died/,'own travel still refuses the Underworld');
 const outside=await readIslandOccupancy(ctx);
 assert.equal(outside.agent,agent);assert.equal(outside.room,1);assert.equal(outside.confirmed,true);assert.equal(outside.body_id,1);
 assert.equal(outside.keeper_pid,process.pid);assert(Date.now()-outside.at<3000);
 positionId=2;await assert.rejects(readIslandOccupancy(ctx),/occupancy_unconfirmed/,'a mismatched body cannot release a reservation');
 positionId=null;livePid=process.pid+1;await assert.rejects(readIslandOccupancy(ctx),/occupancy_keeper_changed/);
 livePid=null;pose.predicted=true;await assert.rejects(readIslandOccupancy(ctx),/occupancy_unconfirmed/);
}finally{
 await new Promise(resolve=>server.close(resolve));
 if(oldRegistry==null)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=oldRegistry;
 rmSync(scratch,{recursive:true,force:true});
}
