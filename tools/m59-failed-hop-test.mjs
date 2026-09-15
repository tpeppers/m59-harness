import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
import {protocolToClient} from './m59-roo.mjs';
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
// Exercise the real fallback walker. Geometry permits the proposed line, but
// the sender can refuse a long move (for example after body/quantization checks).
function fixture({length=3,reason='geometry_blocked',success=false,collision=true,cancel=false,singleStepsOnly=false}={}){
 const route=Array.from({length},(_,i)=>({row:34,col:17+i})),calls=[],landings=[],stop=new Error('captured fallback retry');
 const geo={collisionReady:collision,num:598,standable:()=>true,path:()=>({found:true,steps:route}),
  standPoint:(row,col)=>({x:protocolToClient(col*64+32),y:protocolToClient(row*64+32)}),
  stringPull:()=>null,moverStepLands:()=>true,traceFineMoveClient:(_x,_y,x,y)=>({x,y})};
 const c={self:{row:34,col:16,x:1068,y:2198},room:{id:598,objects:new Map()},vitals:()=>({health:{value:49,max:49}})};
 const s={live:true,client:c,movementGeneration:0,world:{geometry:geo,room:{num:598}},need:()=>c,threatsHere:()=>[],
  movementWasCancelled(g){return g!==this.movementGeneration;},cancelledMovement:()=>({cancelled:true}),
  walkPivots:async()=>({done:false,legs:0,singles:0}),confirmPosition:async()=>({...c.self}),
  stepFine:async()=>{calls.push({method:'fine_detour'});throw stop;},
  step:async(col,row)=>{calls.push({method:'step',row,col});
   if(singleStepsOnly)assert.ok(calls.length<=20,'fallback must make bounded progress');
   else if(calls.length>1)throw stop;
   if(cancel)s.movementGeneration++;
   if(success||(singleStepsOnly&&Math.max(Math.abs(col-c.self.col),Math.abs(row-c.self.row))===1)){
    Object.assign(c.self,{row,col,x:col*64+32,y:row*64+32});landings.push({row,col});
    return {moved:true,position:{...c.self}};
   }
   return {moved:false,position:{...c.self},reason};}};
 return {calls,landings,run:async()=>{try{return await Session.prototype.walkTo.call(s,16+length,34);}catch(e){if(e!==stop)throw e;}}};
}
for(const length of [2,3,5])for(const reason of ['geometry_blocked','object_blocked'])
 await test(`${length}-square ${reason} restores the first swallowed waypoint`,async()=>{
  const f=fixture({length,reason});await f.run();
  assert.deepEqual(f.calls[0],{method:'step',row:34,col:16+length});
  assert.deepEqual(f.calls[1],{method:'step',row:34,col:17});
 });
for(const length of [2,3,5])await test(`${length}-square arrival counts every planned square`,async()=>{
 const f=fixture({length,success:true}),r=await f.run();assert.equal(r.arrived,true);assert.equal(r.steps,length);
});
await test('cancellation after the failed hop prevents all retries',async()=>{
 const f=fixture({cancel:true}),r=await f.run();assert.equal(r.cancelled,true);assert.equal(f.calls.length,1);
});
await test('legacy collinear fallback also retains the first waypoint',async()=>{
 const f=fixture({collision:false});await f.run();assert.deepEqual(f.calls[1],{method:'step',row:34,col:17});
});
for(const collision of [true,false])await test(`all swallowed waypoints remain walkable after repeated refusals (collision=${collision})`,async()=>{
 const f=fixture({length:5,collision,singleStepsOnly:true}),r=await f.run();
 assert.equal(r.arrived,true);
 assert.deepEqual(f.landings,Array.from({length:5},(_,i)=>({row:34,col:17+i})));
});
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
