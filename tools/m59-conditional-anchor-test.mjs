import assert from 'node:assert/strict';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
const h=await bastionHarness(),{applyAncientFloors}=await h.imp('m59-moving-platform.mjs'),{withBodyCommand}=await h.imp('m59-body-command.mjs'),{edgeConditionAllows}=await h.imp('m59-map.mjs');
const heights={2:250,3:250,4:540,5:200,6:200,7:200,8:200,9:510};
const fixture=from=>{const f=h.fixture({from:{room:579,...from}},{maxPackets:128,maxMs:20000});applyAncientFloors(h.map,579,new Map(Object.entries(heights).map(([id,height])=>[+id,{height,type:4}])),null,{geometryOf:()=>f.s.world.geometry});return f;};
for(const [type,axis,value,accepted]of [[1,'row',8,true],[2,'row',8,false],[3,'col',8,true],[4,'col',8,false]])assert.equal(edgeConditionAllows({type,threshold:7},{[axis]:value}),accepted);
for(const from of [{x:4000,y:96},{x:3528,y:504}]){
 const selected=fixture(from),candidates=selected.s.world.exits().filter(e=>e.to===578);assert(candidates.length);let first;
 selected.s.leaveVia=async exit=>{first=exit;throw Error('first-selected-only');};
 await assert.rejects(selected.s.leaveViaAny(candidates),/first-selected-only/);
 assert(first.stand_on.col>20,'an eastern col>20 crossing cannot inherit the western r1c17 anchor');assert(edgeConditionAllows(first.edge_condition,first.stand_on));
 if(from.x===3528){console.log('north-ledge candidate retains its eastern condition; the public fine approach still owns reaching the exit');continue;}
 const full=fixture(from),result=await withBodyCommand(full.s,()=>full.s.leaveViaAny(full.s.world.exits().filter(e=>e.to===578)),'conditional-branch-crossing');
 assert(result.left,JSON.stringify(result));assert.equal(full.s.world.room.num,578);assert.equal(full.crossings.length,1);assert.equal(full.crossings[0].col,48,'the eastern branch lands on the Brax-connected side');
 console.log('conditional north exit from '+JSON.stringify(from)+': '+full.packets.length+' ordinary validated packets, one crossing into the eastern Cragged component');
}
const west=fixture({x:1120,y:96}),westCandidates=west.s.world.exits().filter(e=>e.to===578);let first;west.s.leaveVia=async exit=>{first=exit;throw Error('west-anchor-only');};
await assert.rejects(west.s.leaveViaAny(westCandidates),/west-anchor-only/);assert.equal(first.stand_on.col,17);assert.equal(first.from_anchor,true,'a compatible baked anchor retains its normal preference');
console.log('compatible western anchor retained; conditional branches never mix their staging and fine crossing tuples');


{
 const {preparedFineExitStage}=await import('./m59-session-walk.mjs'),f=fixture({x:4000,y:96}),geo=f.s.world.geometry;
 const exit={stand_on:{row:1,col:62},fine_stand_on:{x:3991,y:96}},body={...f.c.self};
 assert(preparedFineExitStage(geo,body,exit),'actual prepared eastern point needs no coarse restaging');
 assert(!preparedFineExitStage(geo,{...body,predicted:true},exit));
 assert(!preparedFineExitStage(geo,{...body,row:2},exit));
 assert(!preparedFineExitStage({...geo,traceFineMoveClient:()=>({arrived:false,blocked:true})},body,exit));
 let walks=0;f.s.walkTo=async()=>{walks++;throw Error('a terrain-proved prepared stage must not be rewalked');};
 const result=await withBodyCommand(f.s,()=>f.s.leaveViaAny(f.s.world.exits().filter(e=>e.to===578)),'prepared-fine-exit');
 assert(result.left,JSON.stringify(result));assert.equal(walks,0);assert.equal(f.crossings[0].col,48);
 console.log('prepared eastern opening crosses normally with zero redundant coarse stage walks; predicted and wall-separated poses refuse the shortcut');
}
