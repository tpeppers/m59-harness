import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, protocolToClient } from './m59-roo.mjs';
import { finePath, fineRouteDetour, pointOfSquare, boundsAround, squareOf, ARRIVE_WITHIN } from './m59-finepath.mjs';
const map=loadMap(); attachStepMasks(map);
const geo=sharedRoomGeometry(map.rooms[537]);
const from={row:38,col:16};
const here={x:protocolToClient(1056),y:protocolToClient(2464)};
const blocked={row:36,col:12}, onward={row:36,col:11};
assert.equal(finePath(geo,here,pointOfSquare(geo,blocked.row,blocked.col),
  {bounds:boundsAround([from,blocked],4),maxNodes:4000}).found,false);
const edgeArrival=fineRouteDetour(geo,here,[blocked]);
assert.equal(edgeArrival.found,true, 'the square can be reached even though its center cannot');
assert.deepEqual(squareOf(edgeArrival.points.at(-1).x,edgeArrival.points.at(-1).y),blocked);
const center=pointOfSquare(geo,blocked.row,blocked.col);
assert.ok(Math.hypot(edgeArrival.points.at(-1).x-center.x,edgeArrival.points.at(-1).y-center.y)>ARRIVE_WITHIN);
const solid={row:35,col:12};
const detour=fineRouteDetour(geo,here,[solid,onward]);
assert.equal(detour.found,true);
assert.equal(detour.index,1);
assert.deepEqual(detour.target,onward);
assert.ok(detour.nodes <= 4000);
let start=here;
for (const p of detour.points) {
  const landed=geo.traceFineMoveClient(start.x,start.y,p.x,p.y,{slide:true});
  assert.ok(landed && Math.hypot(landed.x-p.x,landed.y-p.y)<256);
  start=p;
}
assert.equal(fineRouteDetour(geo,here,[solid,onward],{maxAhead:0}).found,false);
assert.equal(fineRouteDetour(geo,here,[{...blocked,fall:true},onward]).found,false);
assert.equal(fineRouteDetour(geo,here,[solid,{...onward,fall:true}],{maxNodes:4000}).found,false,
  'lookahead cannot skip over a fall later in the prefix');
const doorway={row:6,col:13};
const byDoor={x:protocolToClient(898),y:protocolToClient(728)};
const doorCenter=pointOfSquare(geo,doorway.row,doorway.col);
assert.equal(finePath(geo,byDoor,doorCenter,{maxNodes:4000}).found,false);
const doorPath=finePath(geo,byDoor,doorCenter,{maxNodes:4000,goalSquare:doorway});
assert.equal(doorPath.found,true, 'the Faronath door has a reachable edge, not a reachable center');
assert.deepEqual(squareOf(doorPath.points.at(-1).x,doorPath.points.at(-1).y),doorway);
console.log('fine detours reach usable square edges and bypass solid intermediate squares using validated ground');
