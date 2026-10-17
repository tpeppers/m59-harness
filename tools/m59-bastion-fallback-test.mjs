#!/usr/bin/env node
// BASTION FALLBACK TESTS: recent PvP death/stuck origins must reach Castle Victoria (38).
// Real Session.travel/leaveVia/walkers/collision and committed geometry; socketless replies
// model declared KOD crossings. No fleet, server, combat damage or claim of historical survival.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';

const corpus=JSON.parse(readFileSync(new URL('./fixtures/bastion-fallbacks.json',import.meta.url)));
const h=await bastionHarness();
const {planRailDeparture,validateEscape,pocketRailBook}=await h.imp('m59-pocket-rails.mjs');
const {activeRoutes}=await h.imp('m59-routes.mjs');
const {CombatMode}=await h.imp('m59-combat-mode.mjs');
const {withBodyCommand}=await h.imp('m59-body-command.mjs');
const here=(room,x,y)=>h.fixture({from:{room,x,y}});

test('bastion corpus covers each death, distinguishes missing fine poses and contains no actor identity',()=>{
  assert.equal(new Set(corpus.cases.map(c=>c.death_case)).size,corpus.capture.pvp_deaths);
  assert.equal(new Set(corpus.cases.map(c=>c.id)).size,corpus.cases.length);
  for(const c of corpus.cases){
    assert.equal(c.to,38);assert.equal(c.from.row,Math.floor(c.from.y/64));assert.equal(c.from.col,Math.floor(c.from.x/64));
    assert.ok(['cached_fine','predicted_cached_fine','incident_fine','square_center_synthetic'].includes(c.position_quality));
    if(c.position_quality==='square_center_synthetic')assert.equal(c.basis,'death_square_center_fine_unknown');
    assert.deepEqual(Object.keys(c).sort(),['id','death_case','basis','position_quality','from','to','bodies'].sort());
    for(const b of c.bodies)assert.ok(Object.keys(b).every(k=>['id','flags','x','y','row','col'].includes(k)));
  }
});

// Identical body-free starts have identical contracts. Reuse their completed run, while
// retaining a named regression assertion for EVERY death and each of its observed origins.
// Correctly releasing confirmed passage exits permits the full legal south
// detour from the lower Ukgoth shelf. Current and baseline runtimes both replay
// that route identically in411 packets under the corrected model; the old384
// cap depended on stale harness admission. Retain a bounded512 packet corpus
// budget,60s per scene and the independent repeated-pose grinding assertion.
const CORPUS_PACKET_LIMIT=512;
const escapes=new Map();
await test('recorded bastion fallback routes',{concurrency:4},async t=>{
await Promise.all(corpus.cases.map(entry=>t.test(`bastion fallback ${entry.id}: ${entry.basis}, ${entry.from.room} r${entry.from.row}c${entry.from.col} -> 38`,async()=>{
  const key=JSON.stringify(entry.from);
  if(!escapes.has(key))escapes.set(key,(async()=>{
    const f=h.fixture(entry,{maxPackets:CORPUS_PACKET_LIMIT,maxMs:60000});
    const result=await f.s.travel(38,{maxHops:16,maxStumbles:2});
    return {f,result};
  })());
  const {f,result}=await escapes.get(key);
  assert.equal(result.arrived,true,JSON.stringify({id:entry.id,result,asks:f.asks,pose:f.c.self}));
  assert.equal(f.s.world.room.num,38);assert.equal(f.c.self.predicted,false);
  assert.ok(f.packets.length<CORPUS_PACKET_LIMIT,`${entry.id}: bounded escape, ${f.packets.length} packets`);
  if(entry.from.room!==38)assert.equal(f.crossings.at(-1)?.to,38,'the real doorway flow must receive a modeled declared crossing');
  const counts=new Map();for(const p of f.packets){const k=`${p.room}/${p.x}/${p.y}`;counts.set(k,(counts.get(k)??0)+1);}
  assert.ok(Math.max(0,...counts.values())<=8,'no repeated fine-pose grinding');
})));
});

test('the actual bastion flight calls the router under its owner and holds only after room 38 arrival',async()=>{
  const f=here(599,3680,352),holds=[],stops=[],tokens=[];
  const o={id:'offline-bastion-flight',flight:{room:38,hold_ms:10000,hold_orders:true,strategy:'bastion',threat:'opponent'}};
  const mode=Object.assign(Object.create(CombatMode.prototype),{s:f.s,active:o,now:Date.now,
    async stand(){},armTimer(){},guard(q){assert.equal(q,this.active);},
    setStrategyHold(hold){assert.equal(f.s.world.room.num,38);holds.push(hold);},stop(why){stops.push(why);this.active=null;}});
  f.s.combat=mode;
  const travel=f.s.travel;
  f.s.travel=async function(to,opts){tokens.push(opts.controlToken);return travel.call(this,to,opts);};
  await withBodyCommand(f.s,()=>mode.advanceFlight(o),o.id);
  assert.deepEqual(tokens,[o.id]);assert.equal(f.s.world.room.num,38);
  assert.equal(holds.length,1);assert.equal(holds[0].strategy,'bastion');assert.equal(holds[0].hold_orders,true);
  assert.deepEqual(stops,['PvP strategy flight reached 38']);assert.ok(o.flight.arrived_at);
});

test('a rail square accepts its proved edge instead of grinding at an inaccessible stand point',async()=>{
  const f=here(599,3168,1760),square={row:28,col:49};
  const result=await f.s.walkRailSquare(square);
  assert.equal(result.arrived,true);assert.equal(f.c.self.predicted,false);
  assert.equal(f.c.self.row,28);assert.equal(f.c.self.col,49);assert.ok(f.packets.length<=2);
  assert.notEqual(f.c.self.y,f.s.world.geometry.standPointWire(28,49).y,'arrival need not occupy the nominal stand point');
});

test('a displaced Cragged body boards a proved baked suffix beyond the original start radius',()=>{
  const f=here(598,2170,2103),goal={row:65,col:19};
  assert.ok(pocketRailBook().rooms[598].rails.every(r=>Math.hypot(r.from.x-f.c.self.x,r.from.y-f.c.self.y)>64));
  const p=planRailDeparture(f.s.world.geometry,f.c.self,goal,{room:598,table:activeRoutes(),
    manifest:h.map.geometryManifestSha256,objects:f.c.room.objects,selfId:1,seedOnly:true});
  assert.equal(p.found,true);assert.equal(p.via,'baked_pocket_rail');
  assert.ok(Math.hypot(p.waypoints[0].x-f.c.self.x,p.waypoints[0].y-f.c.self.y)<=64);
  assert.equal(validateEscape(f.s.world.geometry,f.c.self,p.waypoints).ok,true);
  assert.deepEqual(p.square,goal);
});

test('rail square planning preserves mandatory avoidance, unknown position and geometry refusal',async()=>{
  const square={row:28,col:49},blocked=here(599,3168,1760);
  assert.equal((await blocked.s.walkRailSquare(square,{avoidSquares:new Set(['28,49'])})).moved,false);
  assert.equal(blocked.packets.length,0);
  const unknown=here(599,3168,1760);unknown.c.self.predicted=true;
  unknown.s.confirmPosition=async()=>null;
  assert.equal((await unknown.s.walkRailSquare(square)).reason,'own_position_unknown');assert.equal(unknown.packets.length,0);
  const unavailable=here(599,3168,1760);Object.defineProperty(unavailable.s.world,'geometry',{value:null});
  assert.equal((await unavailable.s.walkRailSquare(square)).reason,'collision_geometry_unavailable');assert.equal(unavailable.packets.length,0);
});

for(const change of ['generation','token','room','body'])test(`a paced ${change} change revokes a planned rail square before its packet`,async()=>{
  const f=here(599,3168,1760),submit=f.s.pacer.submit;
  f.s.pacer.submit=async(kind,run)=>{
    if(kind==='move'){
      if(change==='generation')f.s.movementGeneration++;
      if(change==='token')f.s.cancelledMovementTokens.add('flight');
      if(change==='room')f.c.room.id++;
      if(change==='body')f.c.room.objects.set(2,{id:2,flags:9,x:3168,y:1792,row:28,col:49});
    }
    return submit(kind,run);
  };
  const r=await f.s.walkRailSquare({row:28,col:49},{controlToken:'flight'});
  assert.equal(r.moved,false);assert.equal(f.packets.length,0);
  if(change==='body'){assert.equal(r.reason,'object_blocked');assert.equal(r.objectId,2);}
  if(change==='room')assert.equal(r.left_room,true);
});

test('an unconfirmed rail endpoint cannot certify square arrival',async()=>{
  const f=here(599,3168,1760);f.s.confirmPosition=async()=>null;
  const r=await f.s.walkRailSquare({row:28,col:49});
  assert.equal(r.arrived,false);assert.equal(r.moved,false);assert.equal(r.reason,'departure arrival unconfirmed');
});

test('a predicted rail start is refreshed before planning, and a takeover during that read sends nothing',async()=>{
  const f=here(599,3168,1760);f.c.self.predicted=true;
  assert.equal((await f.s.walkRailSquare({row:28,col:49})).arrived,true);
  const revoked=here(599,3168,1760);revoked.c.self.predicted=true;
  revoked.s.confirmPosition=async()=>{revoked.s.movementGeneration++;return revoked.c.self;};
  assert.equal((await revoked.s.walkRailSquare({row:28,col:49})).cancelled,true);assert.equal(revoked.packets.length,0);
});

test('a cancelled token is rechecked inside an ordinary step packet, not just at rail entry',async()=>{
  const f=here(2,672,1312),submit=f.s.pacer.submit;
  f.s.pacer.submit=async(kind,run)=>{if(kind==='move')f.s.cancelledMovementTokens.add('flight');return submit(kind,run);};
  const r=await f.s.step(11,20,{controlToken:'flight'});
  assert.equal(r.moved,false);assert.equal(r.reason,'movement_cancelled');assert.equal(f.packets.length,0);
});

await test('captured bastion traffic',{concurrency:4},async t=>{
await Promise.all(['bastion-01-1','bastion-20-1','bastion-22-2','bastion-23-1','bastion-27-2','bastion-32-1','bastion-34-1','bastion-37-1'].map(id=>
t.test(`bastion frozen-body escape ${id}`,async()=>{
  const f=h.fixture(corpus.cases.find(c=>c.id===id),{bodies:true,maxPackets:384,maxMs:60000}),falls=[];
  const step=f.s.step;
  f.s.step=async function(col,row,opts){if(opts?.fall)falls.push({from:{row:f.c.self.row,col:f.c.self.col},to:{row,col}});return step.call(this,col,row,opts);};
  const r=await f.s.travel(38,{maxHops:16,maxStumbles:2});
  assert.equal(r.arrived,true,JSON.stringify({id,r,pose:f.c.self}));assert.equal(f.s.world.room.num,38);
  assert.equal(f.c.self.predicted,false);assert.ok(f.packets.length<384);
  if(id==='bastion-27-2'){
    assert.ok(falls.some(j=>j.from.row===36&&j.from.col===16&&j.to.row===38&&j.to.col===10),'retain the declared Ukgoth shelf landing');
    assert.ok(!falls.some(j=>j.from.row===36&&j.from.col===16&&j.to.row===38&&j.to.col===8),'clearance alone cannot choose a longer undeclared jump');
  }
})));
});
