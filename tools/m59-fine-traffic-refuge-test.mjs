import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {roomGeometry} from './m59-ground.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {checkedIslandWalk} from './m59-island-finewalk.mjs';
import {legWalls} from './m59-safelegs.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {protocolToClient} from './m59-finepos.mjs';
const failed={id:1,x:3072,y:2736,row:42,col:48},target={x:2201,y:2650},geo=roomGeometry(2502);
const wall=legWalls(geo).sort((a,b)=>Math.hypot(a.row-failed.row,a.col-failed.col)-Math.hypot(b.row-failed.row,b.col-failed.col))[0];
const from={id:1,...geo.standPointWire(wall.row,wall.col),row:wall.row,col:wall.col};
assert.equal(Math.floor(from.x/64),wall.col);assert.equal(Math.floor(from.y/64),wall.row);
const crowd=[];let id=900;
for(let dx=-64;dx<=64;dx+=16)for(let dy=-64;dy<=64;dy+=16)if(dx||dy)crowd.push({id:++id,x:from.x+dx,y:from.y+dy,flags:9});
const options={objects:new Map(crowd.map(o=>[o.id,o])),selfId:from.id,bodyRangeSquares:10,
 allowBodyPrefix:true,prefixSquares:4,requirePrefixRefuge:true,maxMs:2000};
const refused=await cutFineRailAsync(geo,from,target,options);
assert(!refused.ok,'the scene must actually block the body route');
assert.equal(refused.traffic_blocked,true);assert.deepEqual(refused.waiting_refuge,{row:wall.row,col:wall.col});
const clear=await cutFineRailAsync(geo,from,target,{maxMs:2000});assert(clear.ok&&clear.bridgeOk);
// The observed failure stopped one cell short of cover. A westward body
// barrier must produce a real short refuge approach, not a wait in that cell.
const barrier=[];let actor=2000;
for(let dx=-128;dx<=-64;dx+=16)for(let dy=-128;dy<=128;dy+=16)barrier.push({id:++actor,x:failed.x+dx,y:failed.y+dy,flags:9});
const barrierObjects=new Map(barrier.map(o=>[o.id,o]));
const retreat=await cutFineRailAsync(geo,failed,target,{objects:barrierObjects,selfId:1,bodyRangeSquares:10,
 allowBodyPrefix:true,prefixSquares:4,requirePrefixRefuge:true,maxMs:2000});
assert(retreat.ok&&retreat.partial&&retreat.refuge);assert.equal(retreat.waiting_refuge,undefined);
assert(legWalls(geo).some(w=>w.row===retreat.refuge.row&&w.col===retreat.refuge.col));
let previous=protocolToClient(failed),travelled=0;const obstacles=blockingBodySnapshot(barrierObjects,1);
for(const p of retreat.waypoints.slice(1)){const t=geo.traceFineMoveClient(previous.x,previous.y,p.x,p.y,{slide:false,obstacles});
 assert(t.arrived&&!t.blocked,'every retreat chord retains live-body proof');travelled+=Math.hypot(p.x-previous.x,p.y-previous.y)/1024;previous=p;}
assert(travelled<=6);assert(Math.hypot(previous.x-protocolToClient(target).x,previous.y-protocolToClient(target).y)>128,'cover is not a false final goal');
const scratch=mkdtempSync(join(tmpdir(),'m59-fine-traffic-')),old=process.env.M59_KEEPER_BAND_REGISTRY;
const agent='fine-traffic-fixture',room={num:2502,object_id:77};let pose={...from},reads=0,moves=0;
const server=createServer((request,response)=>{
 const blocked=++reads<=20;response.setHeader('content-type','application/json');
 response.end(JSON.stringify({agent,in_game:true,room,you:pose,hp:{value:20,max:20},vigor:{value:200},objects:blocked?crowd:[],
  position_read:{...pose,at:Date.now(),room_object_id:77}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const registry=join(scratch,'bands.json');writeFileSync(registry,JSON.stringify({'fine-traffic-test':server.address().port-99}));process.env.M59_KEEPER_BAND_REGISTRY=registry;
try{
 const ctx={agent,fleet:'fine-traffic-test',origin:{source:'fleetscript',name:'traffic',run_id:'fixture'},state:{},call:async(name,args)=>{
  if(name==='walk_to'){assert(reads>20,'no packet may leave while the scene remains blocked');moves++;
   pose={...pose,x:args.x,y:args.y,row:Math.floor(args.y/64),col:Math.floor(args.x/64)};return {arrived:true};}
  throw Error('unexpected action '+name);
 }};
 const result=await checkedIslandWalk(ctx,target,{room:2502,budgetMs:90000});
 assert(result.ok);assert(moves>0);assert(Math.hypot(pose.x-target.x,pose.y-target.y)<=8);
 console.log('A body-blocked geometry route waits at the actual Hollows refuge, then moves only after the scene clears.');
}finally{await new Promise(r=>server.close(r));if(old==null)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=old;rmSync(scratch,{recursive:true,force:true});}
