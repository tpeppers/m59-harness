import assert from 'node:assert/strict';
import { RoomGeometry } from './m59-navgeom.mjs';
const make = allowed => ({ collisionReady: true, standable: () => true,
  fineWalkable: () => true, inBounds: (r,c) => r >= 1 && r <= 4 && c >= 1 && c <= 5,
  moverStepLands: allowed });
const plan = (g, fr, fc, tr, tc) => RoomGeometry.prototype._finePathProtocolImpl.call(g,
  fc*64+32, fr*64+32, tc*64+32, tr*64+32, { maxNodes: 100 });
const ledge = make((r,c,rr,cc) => r === rr && cc === c + 1);
assert.equal(plan(ledge,2,2,2,3).found,true);
assert.equal(plan(ledge,2,3,2,2).found,false, 'a forward trace cannot authorize a reverse climb');
const wall = make((r,c,rr,cc) => Math.max(Math.abs(r-rr),Math.abs(c-cc)) === 1
  && !(r === 2 && rr === 2 && Math.min(c,cc) === 2));
const around = plan(wall,2,2,2,4);
assert.equal(around.found,true);
assert.ok(around.waypoints.length > 1);
assert.ok(around.waypoints.every(p => p.x % 64 === 32 && p.y % 64 === 32),
  'square paths emit actual protocol centers');
console.log('navigation preserves direction and emits protocol centers');
