import assert from 'node:assert/strict';
import {verticalMotionRange,nextVerticalMotion,waitForVerticalSettlement} from './m59-vertical-motion.mjs';
import {roomGeometry} from './m59-ground.mjs';
let v=nextVerticalMotion(null,7,15200,14000,0);
assert.deepEqual(verticalMotionRange(v,7,400),{min:14000,max:15200});
const at1=verticalMotionRange(v,7,1000);assert(at1.max<15200&&at1.max>14000);
v=nextVerticalMotion(v,7,at1,13500,1000);assert.equal(v.graceUntil,500);assert(v.max<15200);
const at2=verticalMotionRange(v,7,2000);v=nextVerticalMotion(v,7,at2,12391,2000);
assert.equal(v.graceUntil,500);assert(v.max<14500);
const at3=verticalMotionRange(v,7,3000);assert(at3.max<v.max);
assert.equal(verticalMotionRange(v,8,3000),null);assert.equal(verticalMotionRange(v,7,v.settleAt),null);
const old={roomId:7,min:12391,max:15200,settleAt:10000};
assert.deepEqual(verticalMotionRange(old,7,9000),{min:12391,max:15200});
const airborne=nextVerticalMotion(null,7,15200,12391,0,{normalWalk:false});
assert.deepEqual(verticalMotionRange(airborne,7,2000),{min:12391,max:15200});
assert.equal(nextVerticalMotion(airborne,7,verticalMotionRange(airborne,7,2000),12391,2000),airborne);
assert.equal(nextVerticalMotion(old,7,verticalMotionRange(old,7,9000),old.lastFloor??12391,9000).mode,'unmodelled');
const rising=nextVerticalMotion(v,7,at3,16000,3000);assert.equal(rising.max,16000);assert.equal(rising.graceUntil,3500);
// The actual rejected Konima chord: floor-only planning proved it, while a
// repeatedly renewed high range refused it after the normal body had fallen.
const geo=roomGeometry(2505),from={x:3857,y:1618},goal={x:3897,y:1570},p=x=>(x-64)*16;
const fall=nextVerticalMotion(null,7,15200,12391,0);
const trace=z=>geo.traceFineMoveClient(p(from.x),p(from.y),p(goal.x),p(goal.y),{slide:false,motionZ:z});
assert(trace({min:12391,max:15200}).blocked);
assert(trace(verticalMotionRange(fall,7,3500)).arrived);
console.log('Normal walking fall ranges age monotonically across floor changes; the real Konima chord opens after settling without a fabricated z or packet.');
{
 let now=0;const active=nextVerticalMotion(null,7,16000,15200,now),original={...active};
 const from={x:60928,y:27136},to={x:66048,y:27136};
 const trace=()=>geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,fall:true,timedFall:true,motionZ:verticalMotionRange(active,7,now)});
 assert.equal(trace().reason,'fall_start_unsettled','normal approach height uncertainty can temporarily refuse the known native jump');
 const waited=await waitForVerticalSettlement(()=>active,{roomId:7,now:()=>now,sleep:async ms=>{now+=ms;}});
 assert(waited.ok&&waited.waited_ms>0&&waited.waited_ms<=5000);assert.deepEqual(active,original,'waiting never rewrites the physical envelope');
 assert(trace().arrived,'the unchanged stock timed tracer admits the crossing after the clock settles');
}
for(const cancelAfter of [0,100]){
 let now=0,cancelled=false;const active=nextVerticalMotion(null,7,16000,15200,0);
 const result=await waitForVerticalSettlement(()=>active,{roomId:7,now:()=>now,cancelled:()=>cancelled||now>=cancelAfter,sleep:async ms=>{now+=ms;}});
 assert(!result.ok&&result.reason==='movement_cancelled');assert(now<=100,'a new controller/body/room can interrupt within one observation interval');
}
{
 const tooLong={roomId:7,min:12000,max:16000,settleAt:10000};
 const r=await waitForVerticalSettlement(()=>tooLong,{roomId:7,now:()=>0,sleep:async()=>assert.fail('unbounded flight must not wait or clear uncertainty')});
 assert.equal(r.reason,'fall_start_unsettled');assert.equal(tooLong.settleAt,10000);
}
