import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {roomGeometry} from './m59-ground.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {checkedIslandWalk,readIslandFinePosition} from './m59-island-finewalk.mjs';
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
const queue=JSON.parse(readFileSync(new URL('./fixtures/konima-occupied-stage-2505.json',import.meta.url)));
const qgeo=roomGeometry(queue.room),qobjects=new Map(queue.bodies.map(o=>[o.id,o]));
const qopts={objects:qobjects,selfId:queue.from.id,bodyRangeSquares:10,allowBodyPrefix:true,
 prefixSquares:4,requirePrefixRefuge:true,avoidSquares:new Set(queue.avoid_squares),maxMs:4000};
const waiting=await cutFineRailAsync(qgeo,queue.from,queue.target,qopts);
assert(!waiting.ok&&waiting.traffic_blocked,'a covered follower waits for the occupied exact goal');
assert.deepEqual(waiting.waiting_refuge,{row:queue.from.row,col:queue.from.col});
const incumbent=queue.bodies.find(o=>o.x===queue.target.x&&o.y===queue.target.y);
assert(incumbent,'the captured staging point is occupied by another player');
const onlyIncumbent=new Map([[incumbent.id,incumbent]]);
const sameWait=await cutFineRailAsync(qgeo,queue.from,queue.target,{...qopts,objects:onlyIncumbent});
assert(!sameWait.ok&&sameWait.traffic_blocked,'an otherwise clear room does not make another refuge free this goal');
const freed=await cutFineRailAsync(qgeo,queue.from,queue.target,{...qopts,objects:new Map()});
assert(freed.ok&&freed.bridgeOk,'the same route becomes available after the incumbent leaves');
const scratch=mkdtempSync(join(tmpdir(),'m59-fine-traffic-')),old=process.env.M59_KEEPER_BAND_REGISTRY;
const jam=JSON.parse(readFileSync(new URL('./fixtures/hollows-occupied-guide-2502.json',import.meta.url)));
const agent='fine-traffic-fixture',room={num:2502,object_id:77};let pose={...from},reads=0,moves=0,guideMode=false;
let confirmationMode=false,confirmationReads=0,simulatedTime=null;const wallNow=Date.now;
let recoveryMode=false,recoveryHP=10,recoveryStands=0,recoveryRests=0;
const recoverySnapshot=()=>({agent,in_game:true,connected:true,room,you:pose,hp:{value:recoveryHP,max:20},vigor:{value:200},objects:[],
 autopilot_status:{faculties:{movement:{owner:'fleetscript:traffic',expires_in_ms:120000}},
  safe_spot:{works:true,at:{row:pose.row,col:pose.col}},
  survival_decisions:{current:{status:recoveryStands<4?'recovering':'completed',strategy:'seek_refuge'}}}});
const server=createServer((request,response)=>{
 const blocked=++reads<=20;response.setHeader('content-type','application/json');
 if(recoveryMode){response.end(JSON.stringify({...recoverySnapshot(),position_read:{...pose,at:Date.now(),room_object_id:77}}));return;}
 if(confirmationMode){confirmationReads++;simulatedTime+=2000;}
 response.end(JSON.stringify({agent,in_game:true,room,you:pose,hp:{value:20,max:20},vigor:{value:200},objects:guideMode?jam.bodies:blocked?crowd:[],
  autopilot_status:{faculties:{movement:{owner:'fleetscript:traffic',expires_in_ms:120000}}},
  position_read:{...pose,at:Date.now()-(confirmationMode&&confirmationReads<=10?5000:0),room_object_id:77}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const registry=join(scratch,'bands.json');writeFileSync(registry,JSON.stringify({'fine-traffic-test':server.address().port-99}));process.env.M59_KEEPER_BAND_REGISTRY=registry;
try{
 const ctx={agent,fleet:'fine-traffic-test',origin:{source:'fleetscript',name:'traffic',run_id:'fixture'},state:{},call:async(name,args)=>{
  if(recoveryMode){
   if(name==='status'||name==='look')return recoverySnapshot();
   if(name==='rest_up'){recoveryRests++;recoveryHP=20;return {rested:true};}
   if(name==='rest'&&args.stand){recoveryStands++;recoveryHP=recoveryStands<4?10:20;return {standing:true};}
  }
  if(name==='walk_to'){assert(reads>20,'no packet may leave while the scene remains blocked');moves++;
   if(guideMode){const a=protocolToClient(pose),b=protocolToClient(args),obstacles=blockingBodySnapshot(new Map(jam.bodies.map(o=>[o.id,o])),pose.id);
    const traced=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles});
    assert(traced.arrived&&!traced.blocked,'the controller must re-prove each emitted chord against the unchanged native creatures');}
   pose={...pose,x:args.x,y:args.y,row:Math.floor(args.y/64),col:Math.floor(args.x/64)};return {arrived:true};}
  throw Error('unexpected action '+name);
 }};
 const result=await checkedIslandWalk(ctx,target,{room:2502,budgetMs:90000});
 assert(result.ok);assert(moves>0);assert(Math.hypot(pose.x-target.x,pose.y-target.y)<=8);
 console.log('A body-blocked geometry route waits at the actual Hollows refuge, then moves only after the scene clears.');
 guideMode=true;pose={...jam.from};moves=0;ctx.state={};
 const advanced=await checkedIslandWalk(ctx,jam.goal,{room:2502,budgetMs:90000,guideNext:jam.next});
 assert(advanced.ok);assert(moves>0);assert(Math.hypot(pose.x-jam.next.x,pose.y-jam.next.y)<=8);
 assert(Math.hypot(pose.x-jam.goal.x,pose.y-jam.goal.y)>64,'advancing a soft point must not be reported as reaching its occupied exact location');
 assert.equal(ctx.state.islandGuideAdvances.length,1);assert.deepEqual(ctx.state.islandGuideAdvances[0].to,jam.next);
 console.log('The controller follows the proved next authored guide point while the native shadowbeast remains in place; every emitted chord retains collision proof.');
 // A caller's ninety-second leg must not fail at the nested reader's default
 // fifteen seconds. Simulated elapsed time avoids a slow wall-clock test.
 confirmationMode=true;simulatedTime=wallNow();Date.now=()=>simulatedTime;
 await assert.rejects(readIslandFinePosition(ctx),/unconfirmed_recovery_budget/);
 assert(confirmationReads<=10,'the standalone read retains its short default budget');
 confirmationReads=0;simulatedTime=wallNow();const began=simulatedTime;moves=0;
 const recovered=await checkedIslandWalk(ctx,{x:pose.x,y:pose.y},{room:2502,budgetMs:90000});
 assert(recovered.ok);assert(simulatedTime-began>15000);assert.equal(moves,0,'unconfirmed position must never authorize a movement packet');
 assert(confirmationReads>10,'the scoped reader waits for actual ordered confirmation');
 console.log('A confirmed body wait beyond fifteen simulated seconds spends its existing leg deadline; standalone reads stay bounded and no unconfirmed movement is emitted.');
 Date.now=wallNow;confirmationMode=false;guideMode=false;recoveryMode=true;pose={...from};ctx.state={};moves=0;
 const repeated=await checkedIslandWalk(ctx,{x:pose.x,y:pose.y},{room:2502,budgetMs:90000});
 assert(repeated.ok);assert.equal(recoveryRests,4);assert.equal(recoveryStands,4);assert.equal(moves,0);
 assert.equal(ctx.state.islandRecoveryFailure,undefined);
 console.log('Four positively owned recovery cycles retain the original fine goal and leg budget; a fixed three-attempt cap cannot strand the fourth living recovery.');
}finally{Date.now=wallNow;await new Promise(r=>server.close(r));if(old==null)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=old;rmSync(scratch,{recursive:true,force:true});}
