// Offline integration with a local keeper endpoint; no game server or roster.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {originLabel} from './m59-move-origin.mjs';
import {checkedIslandWalk,activeOwnedFineRecovery} from './m59-island-finewalk.mjs';
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
 console.log('Fine walk survives an offline action reply, rests under its fresh keeper receipt, and confirms the original goal.');
}finally{
 await new Promise(resolve=>server.close(resolve));
 if(oldRegistry==null)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=oldRegistry;
 rmSync(scratch,{recursive:true,force:true});
}
