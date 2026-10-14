import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {planDeclaredTakeoff,declaredJumpMoveOptions} from './m59-jump-takeoff.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
const geo=roomGeometry(2502),declaration=fallJumpsIn(2502).find(j=>j.to.row===44&&j.to.col===27),body={x:2200,y:2648};
const from=protocolToClient(body),landing=declaration.to_fine;
assert.equal(traceFallMotion(geo,from.x,from.y,landing.x,landing.y).arrived,false,'the old approximate takeoff is not a timed flight proof');
const p=planDeclaredTakeoff(geo,body,declaration);
assert(p.found,JSON.stringify(p));
assert(Math.abs(Math.floor(p.takeoff.y/64)-declaration.from.row)<=1);
assert(Math.abs(Math.floor(p.takeoff.x/64)-declaration.from.col)<=1);
const takeoff=protocolToClient(p.takeoff);
assert.equal(geo.traceFineMoveClient(from.x,from.y,takeoff.x,takeoff.y,{slide:false}).arrived,true);
for(const dt of [8,16,33,50]){
 const flight=traceFallMotion(geo,takeoff.x,takeoff.y,landing.x,landing.y,{dt,recordFrames:true});
 assert.equal(flight.arrived,true);assert.equal(flight.destinationFloor,8000);
 assert(flight.fall_motion.frames.every(f=>f.floor-f.z<=384));
}
assert.equal(declaredJumpMoveOptions(null,200).ok,false);
for(const vigor of [undefined,null,NaN,0,11])assert.equal(declaredJumpMoveOptions(declaration,vigor).ok,false);
assert.deepEqual(declaredJumpMoveOptions(declaration,12).options,{fall:true,timedFall:true,aimX:1750,aimY:2824});
assert.equal(planDeclaredTakeoff(geo,{x:1891,y:2589},declaration).reason,'declared_takeoff_wrong_shelf');
assert.equal(planDeclaredTakeoff(geo,body,declaration,{maxMs:0}).reason,'takeoff_search_budget');
const blocked=planDeclaredTakeoff(geo,body,declaration,{objects:new Map([[9,{id:9,flags:9,x:1750,y:2824}]])});
assert.equal(blocked.found,false,'an occupied landing cannot be planned as clear');
console.log('Declared takeoffs refine on the same ledge, retain running guards, and pass stock gravity at four frame intervals.');
