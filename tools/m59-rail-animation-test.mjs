import assert from 'node:assert/strict';
import {waitForRailAnimation} from './m59-railfollow.mjs';
let time=0,calls=0;
const options={room:579,readRoom:async()=>579,now:()=>time,wait:async ms=>{time+=ms;}};
const success={arrived:true,position:{row:38,col:74}};
assert.equal(await waitForRailAnimation(async()=>++calls<4?{reason:'collision_geometry_changed'}:success,options),success);
assert.equal(calls,4);assert.equal(time,3000);
calls=0;time=0;
const bounded=await waitForRailAnimation(async()=>{calls++;return {reason:'collision_geometry_changed'};},{...options,timeoutMs:2000});
assert.equal(bounded.animation_timeout,true);assert.equal(calls,3);assert.equal(time,2000);
calls=0;time=0;
const changed=await waitForRailAnimation(async()=>{calls++;return {reason:'collision_geometry_changed'};},{...options,readRoom:async()=>578});
assert.equal(changed.reason,'left_room');assert.equal(calls,1);assert.equal(time,0);
for(const reason of ['cancelled','object_blocked','geometry_blocked','unknown_position']){
  calls=0;const reply={reason};assert.equal(await waitForRailAnimation(async()=>{calls++;return reply;},options),reply);assert.equal(calls,1);
}
console.log('rail animation: same aim, bounded wait, room change, cancellation and collision refusals passed');

let clock=0,bodyCalls=0;
const bodyWait=await waitForRailAnimation(async()=>++bodyCalls===1?{arrived:false,reason:'object_blocked'}:{arrived:true},{room:579,readRoom:async()=>579,retryBodies:true,now:()=>clock,wait:async ms=>{clock+=ms}});
assert.equal(bodyCalls,2);assert(bodyWait.arrived);
