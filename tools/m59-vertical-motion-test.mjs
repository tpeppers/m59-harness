import assert from 'node:assert/strict';
import {verticalMotionRange,nextVerticalMotion} from './m59-vertical-motion.mjs';
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
