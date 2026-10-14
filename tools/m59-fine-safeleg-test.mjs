import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {planFineSafeLeg,normalizeSafeLegPolicy,legWalls} from './m59-safelegs.mjs';
import {validateEscape} from './m59-pocket-rails.mjs';
// Actual Ugol wall departure: the square graph calls it seven steps, but the
// body must leave south, cross west, then go north around the ledge.
const geo=roomGeometry(2500),from={x:2608,y:2352},target={row:29,col:36};
const plan=planFineSafeLeg(geo,from,target,{maxLeg:14});
assert.equal(plan.found,true,JSON.stringify(plan));
assert(plan.steps<=14);
assert.notDeepEqual({row:plan.row,col:plan.col},target);
assert(legWalls(geo).some(w=>w.row===plan.row&&w.col===plan.col));
assert(validateEscape(geo,from,plan.waypoints).ok);
assert.equal(Math.floor(plan.waypoints.at(-1).x/64),plan.col);
assert.equal(Math.floor(plan.waypoints.at(-1).y/64),plan.row);
const short=planFineSafeLeg(geo,from,target,{maxLeg:3});
assert.equal(short.found,true);assert(short.steps<=3);
assert.deepEqual({row:short.row,col:short.col},{row:37,col:38});
assert.equal(planFineSafeLeg(geo,from,target,{maxLeg:0.1}).found,false);
const held=planFineSafeLeg(geo,from,target,{maxLeg:3,occupied:new Set(['37,38'])});
assert.equal(held.found,false,'an occupied wall cannot be the next refuge');
const avoid=new Set(['37,38','39,33','39,34']),avoiding=planFineSafeLeg(geo,from,target,{maxLeg:14,avoidSquares:avoid});
if(avoiding.found)assert(validateEscape(geo,from,avoiding.waypoints,{avoidSquares:avoid}).ok);
assert.equal(normalizeSafeLegPolicy({fineLegs:true}).fineLegs,true);
assert.throws(()=>normalizeSafeLegPolicy({fineLegs:'yes'}),/fineLegs must be a boolean/);
console.log('Fine safe legs stop on collision-proved refuges within the actual distance allowance.');
