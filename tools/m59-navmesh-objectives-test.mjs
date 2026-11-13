#!/usr/bin/env node
// Fast offline invariants; no fleet, game connection or graph flood.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STONES } from './m59-stones.mjs';
import { attachNavMesh, geometryIdentity, planNavMesh } from './m59-navmesh.mjs';
import { navMeshNodeObjectives, navMeshObjectiveCases, navMeshObjectiveGate,
  iceAcceptanceGeometry, objectiveGoalOptions, objectiveEndpointMatches } from './m59-navmesh-objectives.mjs';
let count = 0;
const test = (name, fn) => { fn(); console.log('ok ' + name); count++; };
const catalog = navMeshNodeObjectives(), byKey = new Map(catalog.map(o => [o.key, o]));
test('all thirteen source node bits have explicit route and acquisition semantics', () => {
  assert.deepEqual([...byKey.keys()].sort(), Object.keys(STONES).sort()); assert.equal(catalog.length, 13);
  for (const o of catalog) {
    assert.equal(o.room, STONES[o.key].room); assert.equal(o.node, STONES[o.key].node);
    assert.deepEqual(o.nodeSquare, { kind: 'square', row: STONES[o.key].row, col: STONES[o.key].col });
    assert.equal(o.acquisitionGoal.within, 2); assert(o.source); assert(o.routeStatus); assert(Array.isArray(o.requirements));
  }
});
test('catalog coverage does not promote conditional or unresolved nodes into acquisition', () => {
  assert.deepEqual(catalog.filter(o => o.promoted).map(o => o.key).sort(), ['ancient','badlands','cave','sentinel','victoria']);
  assert.equal(byKey.get('peak').routeStatus, 'quiet-native-entrance-round-trip'); assert.equal(byKey.get('peak').promoted,false);
  assert.equal(byKey.get('martyr').routeStatus, 'normal-approach-unresolved');
  assert.equal(byKey.get('mausoleum').routeStatus, 'guest-only-by-design');
});
test('Ice approach names the actual chamber, and Vale preserves the exact source spawn', () => {
  assert.deepEqual(byKey.get('ice').approachGoal, { kind: 'square', row: 25, col: 20 });
  assert.deepEqual(byKey.get('fey').approachGoal, { kind: 'point', x: 29696, y: 22528, units: 'client' });
  assert.equal(objectiveEndpointMatches(byKey.get('ice').approachGoal, {x:19968,y:20992}), false);
  assert.equal(objectiveEndpointMatches(byKey.get('ice').approachGoal, {x:19968,y:25088}), true);
});
test('catalog callers receive independent mutable data without changing the source census', () => {
  catalog[0].requirements.push('test'); catalog[0].nodeSquare.row = 999;
  assert(!navMeshNodeObjectives()[0].requirements.includes('test')); assert.notEqual(navMeshNodeObjectives()[0].nodeSquare.row, 999);
});
test('all executable cases have unique ids, explicit coordinates and evidence status', () => {
  const cases = navMeshObjectiveCases(); assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  for(const c of cases){ assert(byKey.has(c.node)); assert(c.source); assert(['route','blocked','unresolved'].includes(c.expectation));
    for(const p of [c.from,c.goal]){assert(['point','square','range'].includes(p.kind));
      if(p.kind==='point'){assert.equal(p.units,'client');assert(Number.isFinite(p.x)&&Number.isFinite(p.y));}
      else assert(Number.isInteger(p.row)&&Number.isInteger(p.col));}}
  assert.equal(cases.find(c=>c.id==='node-peak-entry').expectation,'route');
  assert.deepEqual(cases.find(c=>c.id==='node-ancient-entry').allowedKinds,['walk','jump']);
  assert.equal(cases.find(c=>c.id==='node-ancient-entry').maxJumps,4);
  assert.deepEqual(cases.find(c=>c.id==='node-peak-entry').allowedKinds,['walk','jump']);
  assert.equal(cases.find(c=>c.id==='node-peak-entry').maxJumps,2);
  assert.equal(cases.find(c=>c.id==='node-peak-upper-section').maxJumps,1);
});
test('guest restriction cannot be bypassed by broad user-intent metadata', () => {
  assert.equal(navMeshObjectiveGate('mausoleum',{allNodes:true,authorized:true}).available,false);
  assert.equal(navMeshObjectiveGate('mausoleum',{guest:true}).available,true);
});
test('faction, portal and Relic gates remain distinct from spawn access', () => {
  assert.equal(navMeshObjectiveGate('fey',{}, {purpose:'approach'}).available,true);
  assert.equal(navMeshObjectiveGate('fey',{}).available,false);
  assert.equal(navMeshObjectiveGate('fey',{extremeKarmaAligned:true,nodeObserved:true}).available,true);
  assert.equal(navMeshObjectiveGate('martyr',{nodeObserved:true}).available,false);
  assert.equal(navMeshObjectiveGate('avar',{nodeValue:2000,nodeObserved:true}).available,false);
  assert.equal(navMeshObjectiveGate('avar',{nodeValue:2001,nodeObserved:true}).available,true);
  assert.equal(navMeshObjectiveGate('ukgoth',{gameHour:1,nodeObserved:true,relicDoorOpeningObserved:true}).available,false);
  const relic={gameHour:0,nodeObserved:true,relicDoorOpeningObserved:true,relicDoorOpenedAt:1000};
  assert.equal(navMeshObjectiveGate('ukgoth',relic,{now:10999}).available,true);
  assert.equal(navMeshObjectiveGate('ukgoth',relic,{now:11000}).available,false);
  assert.equal(navMeshObjectiveGate('unknown').available,false);
});
test('Ice actual-node gate requires a fresh non-node yeti kill plus independent sector2 evidence', () => {
  const good={yetiKillObserved:true,yetiKilledByNode:false,yetiKilledAt:9000,sectorHeights:new Map([[2,{type:5,height:510}]])};
  assert.equal(navMeshObjectiveGate('ice',good,{now:10000}).available,true);
  for(const change of [{yetiKillObserved:false},{yetiKilledByNode:true},{yetiKilledByNode:undefined},
    {yetiKilledAt:8000},{yetiKilledAt:10001},{sectorHeights:new Map([[1,{type:5,height:448}]])}])
    assert.equal(navMeshObjectiveGate('ice',{...good,...change},{now:10000}).available,false);
  assert.equal(navMeshObjectiveGate('ice',{}, {purpose:'approach'}).available,true);
});
test('Underworld requires an existing body and live solved rip without requesting death', () => {
  assert.equal(navMeshObjectiveGate('corpse',{brazierMask:31,ripObserved:true,ripAppearedAt:0},{now:1000}).available,false);
  const good={alreadyInUnderworld:true,brazierMask:31,ripObserved:true,ripAppearedAt:1000};
  assert.equal(navMeshObjectiveGate('corpse',good,{now:60000}).available,true);
  assert.equal(navMeshObjectiveGate('corpse',good,{now:61000}).available,false);
  assert.equal(navMeshObjectiveGate('corpse',{...good,brazierMask:30},{now:2000}).available,false);
});
test('square and range goals retain their regions instead of claiming a representative center', () => {
  const geo={rows:10,cols:10,standPoint:(row,col)=>({x:(col-.5)*1024,y:(row-.5)*1024})};
  const s=objectiveGoalOptions(geo,{kind:'square',row:3,col:5});assert.deepEqual(s.options.goalSquare,{row:3,col:5});
  const r=objectiveGoalOptions(geo,{kind:'range',row:3,col:5,within:2});assert.equal(r.options.goalSquares.length,25);
  assert(objectiveEndpointMatches({kind:'range',row:3,col:5,within:2},{x:6.5*1024,y:4.5*1024}));
  assert(!objectiveEndpointMatches({kind:'point',x:100,y:100},{x:101,y:100}));
});
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
test('both Ice gates are explicitly closed despite shipped mana-ceiling geometry',()=>{
  const s=iceAcceptanceGeometry(map);assert.equal(s.state,'380,380');
  assert.equal(s.geometry.sectors[171].ceilingHeight,6080);assert.equal(s.geometry.sectors[176].ceilingHeight,6080);
});
test('private first-door preview opens only448/380 and leaves observed geometry closed',()=>{
  const s=iceAcceptanceGeometry(map,{previewYeti:true});assert.equal(s.state,'448,380');assert.equal(s.conditional,true);
  assert.equal(s.geometry.sectors[171].ceilingHeight,7168);assert.equal(s.geometry.sectors[176].ceilingHeight,6080);
  assert.equal(s.closedGeometry.sectors[171].ceilingHeight,6080);assert.equal(s.closedGeometry.sectors[176].ceilingHeight,6080);
  assert.equal(s.observed.get(1).height,380);assert.equal(s.observed.get(2).height,380);
});
test('a first-door preview cannot make the separate closed mana ring pass native collision',()=>{
  const s=iceAcceptanceGeometry(map,{previewYeti:true}),a={x:19968,y:25088},b={x:22016,y:25088};
  const closed=s.geometry.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});assert.notEqual(closed.arrived,true);
  const open=iceAcceptanceGeometry(map,{manaOpen:true});assert.equal(open.state,'380,510');
  const trace=open.geometry.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});assert.equal(trace.arrived,true);
});
test('runtime keeps the closed mana ring blocked and accepts the independently opened direct footing',()=>{
  const closed=iceAcceptanceGeometry(map,{previewYeti:true}),open=iceAcceptanceGeometry(map,{manaOpen:true});
  const from={x:19968,y:25088},goal={x:22016,y:25088};
  for(const s of [closed,open])attachNavMesh(s.geometry,{format:'m59-navmesh-room/1',version:1,
    identity:geometryIdentity(s.geometry),nodes:[],polygons:[]});
  const refused=planNavMesh(closed.geometry,from,goal,{maxMs:100});
  assert.equal(refused.available,true);assert.equal(refused.found,false);
  const accepted=planNavMesh(open.geometry,from,goal,{maxMs:100});
  assert.equal(accepted.found,true);assert.equal(accepted.complete,true);assert(objectiveEndpointMatches({kind:'point',...goal},accepted.waypoints.at(-1)));
});
test('an open mana mesh cannot be attached to the closed observed geometry',()=>{
  const closed=iceAcceptanceGeometry(map),open=iceAcceptanceGeometry(map,{manaOpen:true});
  const mesh={format:'m59-navmesh-room/1',version:1,identity:geometryIdentity(open.geometry),nodes:[],polygons:[]};
  assert.throws(()=>attachNavMesh(closed.geometry,mesh),/geometry_mismatch/);
});
console.log(count+' offline navmesh objective checks passed');
