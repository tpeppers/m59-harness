import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {previewOpenedDoor} from './m59-ceiling-doors.mjs';
import {fineGuideBook,findFineGuide} from './m59-fine-guides.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {planRefugeStage} from './m59-fine-refuge-reach.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
import {knownRefugeCell} from './m59-refuge-activation.mjs';
import {floorConstraintAllows,planBodyDetour} from './m59-body-detour.mjs';
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
const opened=previewOpenedDoor(loadMap(),2505,gate.requires_open_door).geometry;
const doorClear=protocolToClient({x:4456,y:416}),returnStage=protocolToClient({x:4840,y:1472});
const doorPrefix=findFineGuide(opened,protocolToClient(gate.from),doorClear,{edge:edgeFor(opened)});
assert(doorPrefix?.ok&&doorPrefix.guide===gate.name,'the return clears the door on its own corridor');
assert.equal(findFineGuide(geo,protocolToClient(gate.from),doorClear,{edge:edgeFor(geo)}),null,
 'an interior guide endpoint cannot bypass a closed door');
const interior=findFineGuide(opened,doorClear,returnStage,{edge:edgeFor(opened)});
assert(interior?.ok&&interior.guide===gate.name,'the shared cutter can stop at an interior staging point');
assert(interior.waypoints.length<gate.waypoints.length,'the interior segment stops before the jump');
const death=JSON.parse(readFileSync(new URL('./fixtures/konima-return-approach-2505.json',import.meta.url)));
const bad={x:4062,y:1600}; // native sent move immediately before the r25c64 fall
assert.equal(floorConstraintAllows(geo,bad,death.minimumFloor),false);
assert.equal(planBodyDetour(geo,{x:4176,y:1648},bad,{minimumFloor:death.minimumFloor,maxMs:100}).found,false);
const bounded=await cutFineRailAsync(geo,death.from,death.target,{minimumFloor:death.minimumFloor,
 objects:new Map(death.bodies.map(o=>[o.id,o])),selfId:death.from.id,maxMs:4000,
 threats:death.bodies.filter(o=>(o.flags&8)&&!(o.flags&4)),threatWeight:12});
assert(bounded.ok&&bounded.bridgeOk,'the captured return approach retains a route on the takeoff shelf');
for(const p of bounded.waypoints)assert(floorConstraintAllows(geo,clientToProtocol(p),death.minimumFloor),
 'no planned chord endpoint may enter the fatal lower floor');
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

const western=book.rooms[2502].guides.filter(g=>g.name.startsWith('western_out_'));
assert.equal(western.length,6,'the ordinary western chain remains separate from the declared jump');
for(const guide of western){
 const from=protocolToClient(guide.from),to=protocolToClient(guide.to);
 const r=findFineGuide(hollows,from,to,{edge:edgeFor(hollows)});
 assert(r?.ok&&r.guide===guide.name,guide.name+' retains its checked ordinary endpoint');
 const shared=await cutFineRailAsync(hollows,guide.from,guide.to,{maxMs:4000});
 assert(shared.ok&&shared.guide===guide.name&&shared.visited===0,'the general cutter reuses '+guide.name);
}
const passage=western[3],middle=clientToProtocol(passage.waypoints[Math.floor(passage.waypoints.length/2)]);
assert.equal(findFineGuide(hollows,protocolToClient(passage.from),protocolToClient(passage.to),{
 edge:edgeFor(hollows,new Map([[999,{id:999,flags:9,...middle}]]))}),null,
 'a body in the western passage invalidates the baked walk');
const drop=western[4],source=protocolToClient(drop.from),minimum=hollows.floorBaseAtClient(source.x,source.y)-384;
assert.equal(findFineGuide(hollows,source,protocolToClient(drop.to),{edge:(a,b)=>
 floorConstraintAllows(hollows,clientToProtocol(b),minimum)&&edgeFor(hollows)(a,b)}),null,
 'a shelf-bound caller cannot use a western drop to bypass its floor fence');
console.log('The shared fine cutter reuses all six ordinary western Hollows links; live bodies and shelf constraints still reject them.');

// Native r50c21 wait: a shadowbeast occupies an interior human guide point.
// The corridor and the following point remain reachable with that body present.
const jam=JSON.parse(readFileSync(new URL('./fixtures/hollows-occupied-guide-2502.json',import.meta.url)));
const bodyOptions={objects:new Map(jam.bodies.map(o=>[o.id,o])),selfId:jam.from.id,
 bodyRangeSquares:10,allowBodyPrefix:true,requirePrefixRefuge:true,prefixSquares:4,maxMs:4000};
const exact=await cutFineRailAsync(hollows,jam.from,jam.goal,bodyOptions);
assert.equal(exact.ok,false);assert.equal(exact.traffic_blocked,true);
assert.deepEqual(exact.waiting_refuge,{row:50,col:21});
assert.equal(exact.guide_advance,undefined,'an exact occupied destination remains exact');
const advanced=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:jam.next});
assert(advanced.ok&&advanced.bridgeOk&&!advanced.partial,'only a complete proved next leg advances the guide');
assert.deepEqual(advanced.guide_advance,{from:jam.goal,to:jam.next,reason:'occupied_guide_waypoint'});
const bodyEdge=edgeFor(hollows,bodyOptions.objects),end=advanced.waypoints.at(-1);
assert(Math.hypot(end.x-protocolToClient(jam.next).x,end.y-protocolToClient(jam.next).y)<=128);
for(let i=1;i<advanced.waypoints.length;i++)assert(bodyEdge(advanced.waypoints[i-1],advanced.waypoints[i]),
 'every advanced chord still respects actual geometry and the captured creatures');
const clear=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,objects:new Map(),guideNext:jam.next});
assert(clear.ok&&clear.bridgeOk);assert.equal(clear.guide_advance,undefined,'a clear optional point is still visited');
const near={x:967,y:3351},blockedNext=new Map([...bodyOptions.objects,[4,{id:4,flags:9,...near}]]);
const occupiedNext=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,objects:blockedNext,guideNext:near});
assert.equal(occupiedNext.ok,false);assert.equal(occupiedNext.guide_advance,undefined,'an occupied next target grants no bypass');
const forbidden=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:near,avoidSquares:new Set(['52,15'])});
assert.equal(forbidden.ok,false);assert.equal(forbidden.guide_advance,undefined,'mandatory avoidance also fences look-ahead');
const below=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:jam.next,minimumFloor:1000000});
assert.equal(below.ok,false);assert.equal(below.guide_advance,undefined,'a guide hint cannot waive a caller floor fence');
const outside=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:{x:-64,y:-64}});
assert.equal(outside.ok,false);assert.equal(outside.guide_advance,undefined,'unreachable geometry cannot be skipped through');
await assert.rejects(()=>cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:{x:NaN,y:0}}),/finite protocol point/);
const cancelled=await cutFineRailAsync(hollows,jam.from,jam.goal,{...bodyOptions,guideNext:jam.next},{cancelled:()=>true});
assert.equal(cancelled.cancelled,true);assert.equal(cancelled.guide_advance,undefined);
console.log('Occupied optional guide points may advance only along a complete current body-safe route; exact, occupied-next, forbidden, floor, geometry and cancellation cases stay fenced.');
