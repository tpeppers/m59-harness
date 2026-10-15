// Offline integration with a local keeper endpoint; no game server or roster.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {originLabel} from './m59-move-origin.mjs';
import {checkedIslandWalk,activeOwnedFineRecovery,recoverIslandFineWalk,walkHollowsOut,confirmIslandFineArrival} from './m59-island-finewalk.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {roomGeometry} from './m59-ground.mjs';
const scratch=mkdtempSync(join(tmpdir(),'m59-fine-recovery-'));
const oldRegistry=process.env.M59_KEEPER_BAND_REGISTRY;
const origin={source:'fleetscript',name:'fine-recovery',run_id:'fixture'},label=originLabel(origin);
const agent='fine-recovery-fixture',room={num:2502,object_id:777},vigor={value:200};
let pose={id:1,x:2152,y:1392,row:21,col:33},hp={value:20,max:20},pre=null,moves=0,rests=0,proactive=false;
const recovery=()=>proactive?{faculties:{movement:{owner:'fleetscript:fine-recovery',expires_in_ms:10000}},
 survival_decisions:{current:{source:'keeper',strategy:'nearest_refuge',status:hp.value<20?'approaching':'ended',ended_at:hp.value<20?null:Date.now()}},
 safe_spot:{works:true,at:{row:pose.row,col:pose.col}}}:undefined;
const server=createServer((request,response)=>{
 if(!request.url.startsWith('/state')&&!['/live','/health'].includes(request.url)){response.writeHead(404);response.end();return;}
 response.setHeader('content-type','application/json');
 response.end(JSON.stringify({agent,in_game:true,room,you:pose,hp,vigor,objects:[],autopilot_status:recovery(),
   position_read:{...pose,at:Date.now(),room_object_id:room.object_id},movement:{last_preempted:pre}}));
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
 const map=loadMap(),hollows=roomExitSquares(map.rooms[2502],{includeInland:true});
 assert(hollows.has('1,41')&&hollows.has('2,41')&&hollows.has('47,78'));
 const merb=roomExitSquares(map.rooms[2502],{to:2503,includeInland:true});
 assert(merb.has('1,41')&&!merb.has('10,78')&&merb.has('47,78'));
 assert(!roomExitSquares(map.rooms[27],{to:2500}).has('11,1'));
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
}finally{
 await new Promise(resolve=>server.close(resolve));
 if(oldRegistry==null)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=oldRegistry;
 rmSync(scratch,{recursive:true,force:true});
}
