import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{test}from'node:test';import{planQueuedRoomExitAsync}from'./m59-queued-room-exit.mjs';import{roomGeometry}from'./m59-ground.mjs';import{copyFineGeometry}from'./m59-observed-geometry.mjs';import{applyAncientFloors}from'./m59-moving-platform.mjs';import{BRAX_RESET_FLOORS}from'./m59-brax-puzzle.mjs';
test('captured platform-to-eastern-north searches leave timers responsive and retain the terrain refusal',async()=>{
 const scene=JSON.parse(readFileSync(new URL('./fixtures/brax-platform-return-planning.json',import.meta.url))),geo=copyFineGeometry(roomGeometry(579));
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(BRAX_RESET_FLOORS).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
 let previous=performance.now(),maxGap=0,pulses=0;const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;pulses++;},10);
 // This is the eastern north shelf needed by the Brax route. Generic room578
 // searches may instead find a separately published western opening; that does
 // not prove access to Brax's isolated eastern mountain component.
 try{const started=performance.now(),results=await Promise.all(scene.poses.map(p=>planQueuedRoomExitAsync({room:{num:579},you:p.position},578,{geometry:geo,branch:{row:1,col:62},timeoutMs:90000})));assert.equal(results.length,22);assert(results.every(p=>!p.found&&p.reason==='published_exit_route_unproved'),JSON.stringify(results));assert(pulses>20);assert(maxGap<1500,'controller heartbeat stalled '+Math.round(maxGap)+'ms');console.log(JSON.stringify({searches:results.length,elapsedMs:Math.round(performance.now()-started),pulses,maxHeartbeatGapMs:Math.round(maxGap)}));}finally{clearInterval(timer);}
});
test('queued planning deadlines send no game actions and leave later requests usable',async()=>{
 const expired=await planQueuedRoomExitAsync({room:{num:2},you:{id:1,x:1138,y:770,row:12,col:17}},599,{timeoutMs:1});assert.equal(expired.found,false);assert.equal(expired.reason,'exit_planner_deadline');
 const next=await planQueuedRoomExitAsync({room:{num:39},you:{id:1,x:1762,y:594,row:9,col:27}},38);assert(next.found,JSON.stringify(next));
});
