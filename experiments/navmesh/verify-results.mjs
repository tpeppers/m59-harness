// Replay saved candidate paths against the unchanged native collision geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {RoomGeometry} from '../../tools/m59-roo.mjs';
import {applyCeilingDoors} from '../../tools/m59-ceiling-doors.mjs';
import {blockingBodySnapshot} from '../../tools/m59-body-detour.mjs';
import {benchmarkCases} from './cases.mjs';
import {assessPath} from './compare.mjs';
const result=JSON.parse(fs.readFileSync(new URL('./results.json',import.meta.url)));
const bytes=fs.readFileSync(new URL('../../substrate/m59-map.json',import.meta.url)),map=JSON.parse(bytes);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),result.map.sha256,'map changed since measurement');
for(const [name,digest] of Object.entries(result.experiment_sources))
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(name,import.meta.url))).digest('hex'),digest,`${name} changed since measurement`);
const cases=benchmarkCases(map),byId=new Map(cases.map(c=>[c.id,c]));
assert.equal(result.cases.length,cases.length);assert.equal(new Set(result.cases.map(c=>c.id)).size,cases.length);
let replayed=0;
for(const saved of result.cases){
 const c=byId.get(saved.id);assert(c);
 const g=RoomGeometry.fromJSON(map.rooms[c.room].roo);g.roomNum=c.room;
 if(c.doorOpen)applyCeilingDoors(map,c.room,new Map([[1,{type:5,height:1150}]]),null,{geometryOf:()=>g});
 const obstacles=blockingBodySnapshot(new Map(c.bodies.map(o=>[o.id,o])),c.selfId);
 for(const arm of saved.arms){
  if(!arm.path)continue;
  const proof=assessPath(g,arm.path,saved.endpoints_client.from,saved.endpoints_client.goal,
   {obstacles,minimumFloor:c.minimumFloor,avoidSquares:c.avoidSquares??[],roomFlags:c.roomFlags??0});
  assert.equal(proof.valid,arm.proof.valid,`${c.id}/${arm.id} replay changed`);replayed++;
 }
 if(c.kind==='recorded-occupied-goal'||c.id==='konima-2505-closed-gate')
  for(const arm of saved.arms)assert(!arm.proof?.valid&&!arm.valid_runs,`${c.id}/${arm.id} falsely accepted blocked goal`);
}
console.log(`Verified map/source hashes and replayed ${replayed} candidate paths across ${cases.length} cases; blocked controls remain refused`);
