import assert from'node:assert/strict';import fs from'node:fs';import{roomGeometry}from'./m59-ground.mjs';import{copyFineGeometry}from'./m59-observed-geometry.mjs';import{applyAncientFloors}from'./m59-moving-platform.mjs';import{planDeclaredTakeoff as candidate}from'./m59-jump-takeoff.mjs';import{protocolToClient}from'./m59-finepos.mjs';import{blockingBodySnapshot}from'./m59-body-detour.mjs';
const scene=JSON.parse(fs.readFileSync(new URL('./fixtures/brax-north-npc-flight.json',import.meta.url))),s={you:scene.body,objects:scene.objects},geo=copyFineGeometry(roomGeometry(579)),heights=scene.heights;
applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(heights).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
const declaration={room:579,from:{row:15,col:55},to:{row:8,col:55},from_fine:{x:55808,y:14848},to_fine:{x:55808,y:7680}},objects=new Map(s.objects.map(o=>[o.id,o])),opts={objects,selfId:s.you.id,stayInLane:true},after=candidate(geo,s.you,declaration,opts);
console.log(JSON.stringify({note:scene.note,after}));
assert(after.found);assert.equal(Math.floor(after.takeoff.x/64),55);assert(Math.hypot(after.takeoff.x-s.you.x,after.takeoff.y-s.you.y)<=16);assert(after.alignment?.npc_blockers.includes(8056));
const a=protocolToClient(s.you),b=protocolToClient(after.takeoff),obstacles=blockingBodySnapshot(objects,s.you.id);assert(geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles}).arrived);assert(geo.traceFineMoveClient(b.x,b.y,declaration.to_fine.x,declaration.to_fine.y,{slide:false,obstacles,fall:true,timedFall:true}).arrived);
assert(!candidate(geo,s.you,declaration,{...opts,actualOnly:true}).found);
const playerObjects=new Map(objects);playerObjects.set(8056,{...objects.get(8056),flags:525});const playerWait=candidate(geo,s.you,declaration,{...opts,objects:playerObjects});assert(!playerWait.found);assert.equal(playerWait.reason,'declared_lane_occupied');
console.log('known NPC obstruction permits a proved quarter-square adjustment inside the same lane; player and actual-only flight blockers still wait; no object removed or vertical-collision waiver');

assert(!candidate(geo,{...s.you,x:3616,col:56},declaration,opts).found,'a neighboring queue cannot be treated as this lane');
