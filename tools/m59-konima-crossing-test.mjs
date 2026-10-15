import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {followDeclaredCrossing,followDeclaredApproach} from './m59-declared-crossing.mjs';
const geo=roomGeometry(2505),jumps=fallJumpsIn(2505),out=jumps.find(j=>j.from.col===60);
assert.equal(jumps.length,4);
for(const j of jumps)for(const dt of [8,16,33,50]){
 const t=traceFallMotion(geo,j.from_fine.x,j.from_fine.y,j.to_fine.x,j.to_fine.y,{dt,recordFrames:true});
 assert(t.arrived,JSON.stringify({from:j.from,to:j.to,dt,reason:t.reason}));
 assert(t.fall_motion.frames.every(f=>f.floor-f.z<=384));
}
const gutter={x:3808,y:2144},stage={x:3072,y:1768},clear={x:4800,y:1512};
function fixture(start=clientToProtocol(out.from_fine),mode='land'){
 let you={...start},calls=0;const walks=[];
 const read=async()=>({room:{num:2505},you:{...you},hp:{value:20,max:20},vigor:{value:200}});
 const ctx={fleet:'fixture',agent:'a',call:async(tool)=>{assert.equal(tool,'jump');calls++;you=mode==='miss'?{x:4064,y:1696}:clientToProtocol(out.to_fine);return {jumped:true};}};
 const walk=async p=>{walks.push({...p});you={...p};};
 return {ctx,read,walk,walks,get calls(){return calls;}};
}
{
 const f=fixture();const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.crossed);assert.equal(f.calls,1);assert.deepEqual(f.walks.at(-1),clear);
}
{
 const f=fixture(undefined,'miss');const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter&&!r.crossed);assert.equal(f.calls,1);assert.deepEqual(f.walks.at(-1),gutter);
 assert.equal(f.walks.filter(p=>p.x===3872&&p.y===1760).length,1,'no retry from a missed lower floor');
}
{
 const f=fixture({x:4064,y:1696});const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter);assert.equal(f.calls,0);assert.deepEqual(f.walks,[gutter]);
}
{
 const f=fixture();f.read=async()=>{throw Error('operator cancelled');};
 await assert.rejects(followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear}),/operator cancelled/);
 assert.equal(f.calls,0);assert.equal(f.walks.length,0);
}
{
 let active=0,peak=0;const fs=[fixture(),fixture()];
 for(const f of fs){const old=f.ctx.call;f.ctx.call=async(...args)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));const reply=await old(...args);active--;return reply;};}
 await Promise.all(fs.map(f=>followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear})));
 assert.equal(peak,1,'takeoff through cleared landing admits one crossing at a time');
}
console.log('Konima directional jumps retain stock gravity, confirm the landing shelf, admit one crossing, and send misses south without retrying from below.');
for(const mode of ['climb','drop']){
 let body={x:4064,y:1696};const walks=[];
 const read=async()=>({room:{num:2505},you:{...body},hp:{value:20,max:20}});
 const walk=async(target,{validatePosition}={})=>{
  walks.push({...target});
  if(target.x===stage.x){
   validatePosition?.(await read()); // an initial lower approach is legitimate
   body=clientToProtocol(out.from_fine);validatePosition?.(await read());
   body=mode==='drop'?{x:3288,y:1248}:{...stage};validatePosition?.(await read());
  }else body={...target};
 };
 const r=await followDeclaredApproach(out,{geo,read,walk,target:stage,gutter});
 assert.equal(r.gutter,mode==='drop');
 assert.deepEqual(walks,mode==='drop'?[stage,gutter]:[stage],
  'a staging walk may climb normally, but an observed later fall goes straight to its gutter');
}
{
 const f=fixture(),old=f.walk;let dropped=false;
 f.walk=async(p,{validatePosition}={})=>{
  if(!dropped){dropped=true;
   validatePosition?.({room:{num:2505},you:{x:4064,y:1696}});
   assert.fail('an observed lower approach must end before another takeoff command');
  }
  await old(p);
 };
 // The read observes the same lower native pose after the guarded walk stops.
 const read=f.read;f.read=async()=>dropped?{...(await read()),you:{x:4064,y:1696}}:read();
 const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter&&r.why==='approach_dropped');assert.equal(f.calls,0);
 assert.deepEqual(f.walks,[gutter],'recovery onto the lower floor goes south without retrying the higher takeoff');
}
{
 const f=fixture();f.walk=async()=>{throw Error('operator cancelled');};
 await assert.rejects(followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear}),/operator cancelled/);
 assert.equal(f.calls,0,'a cancellation cannot turn into a gutter walk');
}
{
 const declaration=jumps.find(j=>j.from.col===64),f=fixture(clientToProtocol(declaration.from_fine));
 let body=clientToProtocol(declaration.from_fine),calls=0;
 f.read=async()=>({room:{num:2505},you:body,hp:{value:20,max:20},vigor:{value:200}});
 f.walk=async p=>{body={...p};};
 f.ctx.call=async()=>{calls++;body={x:4064,y:1696};return {jumped:true};};
 const r=await followDeclaredCrossing(f.ctx,declaration,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter&&!r.crossed);assert.equal(calls,1);assert.deepEqual(body,gutter,'a missed landing can be higher than the intended low refuge and still requires the gutter');
}

// Refined takeoffs retain live bodies, ordinary recovery and lower escape.
const hg=roomGeometry(2502),hd=fallJumpsIn(2502)[0],ha={x:2201,y:2650},hs={x:2305,y:2714},hc={x:1344,y:3076},hl={x:2241,y:2322};
for(const mode of ['traffic','recovery','health_wait','lower','cancel']){
 let body=mode==='health_wait'?{x:2176,y:2552}:{...ha},hp=mode==='health_wait'?15:20,jumps=0,waits=0,restored=0,cancelled=false;
 let objects=mode==='traffic'?[{id:2,flags:525,row:39,col:34,x:2176,y:2552}]:[];
 const read=async()=>{
  if(cancelled)throw Error('cancelled_by_operator');
  return {room:{num:2502},you:{id:1,...body,row:Math.floor(body.y/64),col:Math.floor(body.x/64)},hp:{value:hp,max:20},vigor:{value:200},objects};
 };
 const walks=[];
 const walk=async(point,{validatePosition}={})=>{body={...point};walks.push({...point});validatePosition?.(await read());};
 const ctx={fleet:'refined-fixture',agent:'a',state:{},call:async()=>{
  jumps++;
  if(mode==='cancel'){cancelled=true;return {error:'interrupted'};}
  if(mode==='recovery'&&jumps===1){body={x:2176,y:2552};hp=12;return {error:'keeper recovery owns the body'};}
  body=clientToProtocol(hd.to_fine);return {jumped:true};
 }};
 const run=()=>followDeclaredCrossing(ctx,hd,{geo:hg,read,walk,gutter:mode==='lower'?hl:hc,clear:hc,stage:hs,
  refineTakeoff:true,approachPoint:ha,budgetMs:10000,
  walkTakeoff:async(point,{validatePosition}={})=>{
   assert.equal(hp,20,'an injured body recovers at cover before another takeoff approach');
   if(mode==='health_wait')assert(Math.hypot(point.x-2176,point.y-2552)<=16,'use the proved takeoff next to the actual recovery body');
   if(mode==='lower'){body={x:2096,y:2920};validatePosition?.(await read());assert.fail('a lower approach must stop');}
   await walk(point,{validatePosition});
  },
  waitAtCover:async()=>{waits++;objects=[];if(mode==='health_wait')hp=20;else body={...hs};},
  recover:async({since,initial})=>{
   assert(Number.isFinite(since));
   if(mode==='recovery'&&initial.hp.value===12){restored++;hp=20;return true;}
   return false;
  },
 });
 if(mode==='cancel'){await assert.rejects(run(),/cancelled_by_operator/);assert.equal(restored,0);assert.equal(jumps,1);continue;}
 const result=await run();
 assert.equal(result.gutter,mode==='lower'?true:undefined);
 assert.deepEqual(walks.at(-1),mode==='lower'?hl:hc);
 if(mode==='traffic'){assert.equal(waits,1);assert.equal(jumps,1);assert(ctx.state.declaredCrossingFailure.terrain_proved);}
 if(mode==='recovery'){
  assert.equal(restored,1);assert.equal(jumps,2);
  assert(!walks.some(p=>p.x===hs.x&&p.y===hs.y),'healthy keeper recovery does not retreat into a follower staging cell');
  assert(!walks.some(p=>p.x===ha.x&&p.y===ha.y),'a proved takeoff at the recovery body does not backtrack through the old approach');
 }
 if(mode==='health_wait'){assert.equal(waits,1);assert.equal(jumps,1);}
 if(mode==='lower')assert.equal(jumps,0,'lower Hollows approach uses the checked gutter, never another takeoff');
}
console.log('Refined crossings wait for fresh body clearance, resume verified keeper recovery, retain cancellation, and route lower approaches through their ordinary gutter.');
{
 const f=fixture(),unknown=Object.create(geo);unknown.floorBaseAtClient=()=>null;
 await assert.rejects(followDeclaredCrossing(f.ctx,out,{geo:unknown,read:f.read,walk:f.walk,gutter,stage,clear}),/floor_unavailable/);
 assert.equal(f.calls,0);assert.equal(f.walks.length,0,'unknown floors do not claim or dispatch a crossing');
}
