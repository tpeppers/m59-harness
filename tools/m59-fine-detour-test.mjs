import assert from 'node:assert/strict';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry, protocolToClient } from './m59-roo.mjs';
import { finePath, fineRouteDetour, pointOfSquare, boundsAround } from './m59-finepath.mjs';
const map=loadMap(); attachStepMasks(map);
const geo=sharedRoomGeometry(map.rooms[537]);
const from={row:38,col:16};
const here={x:protocolToClient(1056),y:protocolToClient(2464)};
const blocked={row:36,col:12}, onward={row:36,col:11};
assert.equal(finePath(geo,here,pointOfSquare(geo,blocked.row,blocked.col),
  {bounds:boundsAround([from,blocked],4),maxNodes:4000}).found,false);
const detour=fineRouteDetour(geo,here,[blocked,onward]);
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
assert.equal(fineRouteDetour(geo,here,[blocked,onward],{maxAhead:0}).found,false);
assert.equal(fineRouteDetour(geo,here,[{...blocked,fall:true},onward]).found,false);
console.log('fine detours bypass an unreachable intermediate stand point using validated ground');
