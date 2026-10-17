import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {copyFineGeometry} from './m59-observed-geometry.mjs';
import {applySectorHeights} from './m59-roo.mjs';
import {ancientBakedMask,ANCIENT_HEIGHTS,ANCIENT_SECTOR_IDS} from './m59-moving-platform-masks.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
const base=roomGeometry(579);
for(const index of [0,1,85,170,255]){
 const g=copyFineGeometry(base),overrides=g.sectors.flatMap((s,i)=>{const n=ANCIENT_SECTOR_IDS.indexOf(s.serverId);return n<0?[]:[{index:i,floor:ANCIENT_HEIGHTS[n][(index>>n)&1]*16}];});
 const baked=ancientBakedMask(g,overrides);assert(baked,'geometry fingerprint must match');
 applySectorHeights(g,overrides,{mask:baked});assert.deepEqual(baked,g.buildStepMask(),'baked state '+index+' equals the complete native geometry rebuild');
}
const g=copyFineGeometry(base);g.buildStepMask=()=>assert.fail('live sector observations must never synchronously rebuild the room');
const apply=heights=>applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(heights).map(([k,height])=>[Number(k),{height,type:4}])),null,{geometryOf:()=>g});
const down={2:250,3:250,4:540,5:200,6:200,7:200,8:200,9:510};
assert.equal(apply(down).unbaked,false);assert(g._stepMask.some(x=>x!==0));
assert.equal(apply({...down,3:500}).unbaked,true);assert(g._stepMask.every(x=>x===0),'unknown height fails closed for coarse routing');
assert.equal(apply({...down,3:500}).unbaked,true,'unchanged unknown observations must still report the closed mask');
assert.equal(apply({...down,2:800,3:800,4:510,9:540}).unbaked,false);
const drift=copyFineGeometry(base);drift.sectors[0].floorHeight+=1;
assert.equal(ancientBakedMask(drift,drift.sectors.map((s,index)=>({index,floor:s.floorHeight}))),null,'changed geometry cannot reuse masks');
console.log('Ancient masks: reference rebuilds match, live updates never bake, unknown states and geometry drift fail closed');
