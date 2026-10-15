import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {previewOpenedDoor} from './m59-ceiling-doors.mjs';
import {fineGuideBook,findFineGuide} from './m59-fine-guides.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {planRefugeStage} from './m59-fine-refuge-reach.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {knownRefugeCell} from './m59-refuge-activation.mjs';
const geo=roomGeometry(2505),book=fineGuideBook(),room=book.rooms[2505];
const edgeFor=(g,objects)=>{const obstacles=blockingBodySnapshot(objects);return (a,b)=>{const t=g.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles});return t.arrived&&!t.blocked;};};
for(const guide of room.guides){
 const g=guide.requires_open_door?previewOpenedDoor(loadMap(),2505,guide.requires_open_door).geometry:geo;
 const r=findFineGuide(g,protocolToClient(guide.from),protocolToClient(guide.to),{edge:edgeFor(g)});
 assert(r?.ok,guide.name);assert.equal(r.guide,guide.name);
}
const guide=room.guides.find(g=>g.name==='south_gutter_to_refuge'),from=protocolToClient(guide.from),to=protocolToClient(guide.to);
assert.equal(findFineGuide({...geo,security:-1},from,to,{edge:edgeFor(geo)}),null);
assert.equal(findFineGuide(geo,from,to,{edge:edgeFor(geo),book:{...book,stepMaskVersion:-1}}),null);
assert.equal(findFineGuide(geo,{x:100,y:100},to,{edge:edgeFor(geo)}),null,'a distant route head cannot teleport the body onto the guide');
const blocked=edgeFor(geo,new Map([[99,{id:99,flags:9,x:4096,y:2048}]]));
assert.equal(findFineGuide(geo,from,to,{edge:blocked}),null,'live bodies cannot be waived by a baked walk');
const gate=room.guides.find(g=>g.name==='gate_to_return_takeoff');
assert.equal(findFineGuide(geo,protocolToClient(gate.from),protocolToClient(gate.to),{edge:edgeFor(geo)}),null,'a conditional open-door guide is refused by the current closed geometry');
assert.equal(findFineGuide(geo,from,to,{edge:()=>false}),null,'mandatory avoidance can reject every guide segment');
console.log('Fine guides require current compatible geometry, a checked boarding chord and endpoint, and clear live bodies; closed doors remain closed.');
const hollows=roomGeometry(2502),anchor={x:2201,y:2650},staging=planRefugeStage(hollows,anchor,{row:42,col:36});
assert(staging.found);assert.notDeepEqual(staging.point,{x:2336,y:2720},'the safe-cell centre is not enterable footing');
assert(knownRefugeCell(hollows,{...staging.point,row:42,col:36,predicted:false}));
const a=protocolToClient(staging.point),b=protocolToClient(anchor);
assert(hollows.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false}).arrived,'waiting refuge can return to the approach');
assert.equal(planRefugeStage(hollows,anchor,{row:41,col:34}).found,false,'an enterable ordinary cell is not waiting cover');
for(const from of [{x:4960,y:3104},{x:3360,y:3168}]){
 const broken=await cutFineRailAsync(hollows,from,{x:2336,y:2720},{maxMs:4000});
 assert.equal(broken.ok,false,'real entry/logon cannot reach the old centre target');
 const fixed=await cutFineRailAsync(hollows,from,staging.point,{maxMs:4000});
 assert(fixed.ok&&fixed.bridgeOk,'entry/logon reaches the generated fine footing');
 assert(findFineGuide(hollows,protocolToClient(from),protocolToClient(staging.point),{edge:edgeFor(hollows)})?.ok,
  'the shared walker can use a baked approach from either native starting point');
}
console.log('Hollows entry and login approaches reach actual reversible refuge footing instead of an unreachable cell centre.');
