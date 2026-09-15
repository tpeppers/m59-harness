#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RoomGeometry,bindSectorServerIds} from './m59-roo.mjs';
import {Session} from './m59-game.mjs';
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
const original=map.rooms[598].roo,source=RoomGeometry.fromJSON(original);
const legacy=structuredClone(original);delete legacy.collision.sectorServerIds;delete legacy.collision.sectorServerIdsDigest;
// Explicit tag fixture on the actual collision geometry. The raw i8.roo audit
// separately verifies tag 1 belongs to BSP index 113 (one-based sector 114).
source.sectors.forEach((s,i)=>{s.serverId=i===113?1:0;});
const before=structuredClone(original),bound=bindSectorServerIds(original,source);
assert.deepEqual(original,before,'binding does not mutate the input bake');
assert.equal(bound.collision.digest,original.collision.digest,'identity metadata preserves geometry/mask identity');
const geo=RoomGeometry.fromJSON(bound);
assert.equal(geo.collisionReady,true);
assert.deepEqual(geo.sectorIndicesForServerId(1),[113]);
assert.deepEqual(geo.sectorIndicesForServerId(999),[]);
assert.equal(geo.sectorIndicesForServerId(0).length,116,'tags can name multiple BSP sectors');
assert.equal(RoomGeometry.fromJSON(legacy).sectorIndicesForServerId(1),null,'legacy metadata is unknown, not an index');
const roundtrip=RoomGeometry.fromJSON(geo.toJSON({includeSurfaces:false}));
assert.equal(roundtrip.collisionReady,true);
assert.deepEqual(roundtrip.sectorIndicesForServerId(1),[113]);
const damaged=structuredClone(bound);
const bytes=Buffer.from(damaged.collision.sectorServerIds,'base64');bytes[0]^=1;
damaged.collision.sectorServerIds=bytes.toString('base64');
assert.equal(RoomGeometry.fromJSON(damaged).collisionReady,false,'modified IDs invalidate the collision authority');
const missing=structuredClone(bound);delete missing.collision.sectorServerIds;
assert.equal(RoomGeometry.fromJSON(missing).collisionReady,false,'a half-present binding is rejected');
const shifted=RoomGeometry.fromJSON(original);shifted.sectors[0].floorHeight++;
assert.throws(()=>bindSectorServerIds(original,shifted),/differs/,'IDs cannot be bound to a different collision bake');
const stale=RoomGeometry.fromJSON(original);stale.security++;
assert.throws(()=>bindSectorServerIds(original,stale),/differs/);
const c={self:{row:1,col:1,x:96,y:96},selfId:1,
  room:{id:598,security:geo.security,objects:new Map()}};
const session={need:()=>c,world:{geometry:geo,room:map.rooms[598]},client:c};
const move=()=>Session.prototype.validateFineTarget.call(session,160,96,{slide:true});
assert.equal(move().moved,true);
c.room.collisionInvalidated={kind:'SECTOR_MOVE',sector:1,type:5,height:348,speed:64,at:Date.now(),until:Date.now()+8000};
assert.equal(move().moved,true,'the door tag does not block unrelated BSP sector 1');
c.room.collisionInvalidated.sectorIndices=[0];
assert.equal(move().reason,'collision_geometry_changed','the old tag-as-index mapping reproduces the false refusal');
delete c.room.collisionInvalidated.sectorIndices;
const doorLeaf=geo.leaves.find(l=>l.sectorNum===114),centroid={
 x:doorLeaf.polygon.reduce((n,p)=>n+p[0],0)/doorLeaf.polygon.length,
 y:doorLeaf.polygon.reduce((n,p)=>n+p[1],0)/doorLeaf.polygon.length};
const x=centroid.x/16+64,y=centroid.y/16+64;
c.self={x,y,row:Math.floor(y/64),col:Math.floor(x/64)};
const doorMove=Session.prototype.validateFineTarget.call(session,x+1,y,{slide:true});
assert.equal(doorMove.reason,'collision_geometry_changed','movement from the actual animated door remains blocked');
assert.deepEqual(doorMove.animation.sector_indices,[113]);
assert.equal(doorMove.animation.narrowed,true);
session.moveSpeed=()=>0;session.queueValidatedMove=async()=>({sent:false,validation:doorMove});
assert.deepEqual((await Session.prototype.stepFine.call(session,x+1,y)).animation,doorMove.animation,
  'the fine movement wrapper retains the animation identity in its refusal');
session.world.geometry=RoomGeometry.fromJSON(legacy);c.self={row:1,col:1,x:96,y:96};
assert.equal(move().animation.sector_identity_missing,true,'unknown tags cannot impersonate array indices');
console.log('Sector tags, geometry binding, roundtrip, corruption, legacy bakes and real-room animation scope passed');
