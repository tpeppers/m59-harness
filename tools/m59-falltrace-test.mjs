import assert from 'node:assert/strict';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
const geo=roomGeometry(579),from={x:30720,y:38400},to={x:30320,y:42000};
const frozen=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{fall:true});
assert.equal(frozen.arrived,false);assert.equal(frozen.wallIndex,407);
let checks=2;
for(const dt of [8,16,33,50]){
 const r=traceFallMotion(geo,from.x,from.y,to.x,to.y,{dt,recordFrames:true});
 assert.equal(r.arrived,true);assert.equal(r.destinationFloor,4800);
 assert.equal(r.motionZ.max,4800);assert.ok(r.fall_motion.elapsed_ms>=1000);
 assert.ok(r.fall_motion.frames.some(f=>f.wall===407&&f.z>5312));
 assert.ok(r.fall_motion.frames.every(f=>f.floor-f.z<=384));checks+=6;
}
const stoneWall=traceFallMotion(geo,30720,38400,30208,38400);
assert.equal(stoneWall.arrived,false);assert.equal(stoneWall.moved,false);checks+=2;
const rise=traceFallMotion(geo,30720,40000,30720,38400);
assert.equal(rise.arrived,false);assert.equal(rise.moved,false);checks+=2;
const body=traceFallMotion(geo,from.x,from.y,to.x,to.y,{obstacles:[{id:1,x:30320,y:41800}]});
assert.equal(body.arrived,false);assert.equal(body.moved,false);checks+=2;
const unsettled=traceFallMotion(geo,from.x,from.y,to.x,to.y,{motionZ:{min:8000,max:10880}});
assert.equal(unsettled.reason,'fall_start_unsettled');checks++;
const airborne=geo.traceFineMoveClient(30720,40000,30720,40064,{fall:true,airborne:true,motionZ:{min:7000,max:7000}});
assert.equal(airborne.motionZ.min,7000);assert.equal(floorAt(geo,30720,40000),3200);checks+=2;
console.log(`m59-falltrace: ${checks} assertions passed`);
