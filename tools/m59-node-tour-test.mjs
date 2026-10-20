import assert from 'node:assert/strict';
import {tourPlan,tourComplete,insideNode,TOUR_NODES,cutTourWalk,travelJobActive,inRoomNodePlan,railBoardingCut} from './m59-node-tour.mjs';
import {STONES} from './m59-stones.mjs';
import {roomGeometry,edgeOf} from './m59-ground.mjs';
let count=0;const test=(name,fn)=>{fn();count++;console.log('ok '+name);};
const complete=()=>({start:{room:2},end:{room:2},nodes:TOUR_NODES.map(stone=>({stone,position:STONES[stone]}))});
test('requested node order is fixed',()=>assert.deepEqual(tourPlan().filter(s=>s.kind==='meld').map(s=>s.node),['victoria','sentinel','ancient','badlands','cave']));
test('full loop requires all five actual meld boxes',()=>assert.equal(tourComplete(complete()),true));
test('stopped outbound route cannot masquerade as loop',()=>{const r=complete();r.end.room=52;assert.equal(tourComplete(r),false);});
test('a partial replay cannot become a room-2 loop',()=>{const r=complete();r.start.room=39;assert.equal(tourComplete(r),false);});
test('failure retained even when cleanup returns room 2',()=>{const r=complete();r.failure='shelf';assert.equal(tourComplete(r),false);});
test('missing node stays incomplete',()=>{const r=complete();r.nodes.pop();assert.equal(tourComplete(r),false);});
test('wrong order stays incomplete',()=>{const r=complete();r.nodes.reverse();assert.equal(tourComplete(r),false);});
test('same coordinates in wrong room are not a node arrival',()=>assert.equal(insideNode({...STONES.ancient,room:589},'ancient'),false));
test('box includes two squares on both axes',()=>assert.equal(insideNode({room:39,row:15,col:48},'victoria'),true));
test('box excludes three squares on either axis',()=>{assert.equal(insideNode({room:39,row:16,col:46},'victoria'),false);assert.equal(insideNode({room:39,row:13,col:49},'victoria'),false);});
test('ordinary route has no administrative step',()=>assert.ok(tourPlan().every(s=>['travel','rail','meld','cut','cross','walk'].includes(s.kind))));
test('loop ends with the actual room-2 transition',()=>assert.deepEqual(tourPlan().at(-1),{kind:'travel',to:2}));
test('cave exit staging is followed by a real boundary crossing',()=>{
  const plan=tourPlan(),i=plan.findIndex(s=>s.kind==='meld'&&s.node==='cave');
  assert.deepEqual(plan.slice(i+1,i+3),[{kind:'walk',row:57,col:45},{kind:'travel',to:587}]);
});
test('active broker travel is busy',()=>assert.equal(travelJobActive({busy:'walk to Tos',running_for_s:3}),true));
test('retained cancellation receipt is not an active job',()=>assert.equal(travelJobActive({last_action:'walk to Tos',took_s:4,cancelled:true}),false));
test('retained success receipt is not an active job',()=>assert.equal(travelJobActive({last_action:'walk to Tos',took_s:4}),false));
test('measured Badlands return survives the old 400k cap and reaches the exit square',()=>{
  const geo=roomGeometry(45),from={x:46080,y:64448};
  const step=tourPlan().find(s=>s.kind==='cut'&&s.room===45),{proof,points}=cutTourWalk(geo,from,step);
  assert.ok(proof.visited>400000);assert.ok(points.length>1);assert.deepEqual(points[0],from);
  const last=points.at(-1);assert.equal(Math.floor(last.x/1024)+1,53);assert.equal(Math.floor(last.y/1024)+1,1);
  const edge=edgeOf(geo);assert.ok(points.slice(1).every((p,i)=>edge(points[i],p)));
});
test('in-room Badlands plan: cut to the rail start, rail, meld, cut back to the entrance',()=>{
  const p=inRoomNodePlan('badlands');
  assert.deepEqual(p.map(s=>s.kind),['cut','rail','meld','cut']);
  assert.deepEqual(p[0],{kind:'cut',room:45,x:53856,y:992,row:1,col:53,board:'badlands'});
  assert.equal(p[1].node,'badlands');assert.equal(p[2].node,'badlands');
  assert.deepEqual(p[3],tourPlan().find(s=>s.kind==='cut'&&s.room===45));
});
test('in-room plan refuses a stone it has no measured rail start for',()=>assert.throws(()=>inRoomNodePlan('victoria'),/no_in_room_plan_for_victoria/));
test('a Badlands farmer on the common floor (r28c18) cuts to the rail start; r54c47 under the mesa does not',()=>{
  const geo=roomGeometry(45),step=inRoomNodePlan('badlands')[0],edge=edgeOf(geo);
  const farm={x:18*1024+512,y:28*1024+512},{points}=cutTourWalk(geo,farm,step);
  assert.ok(points&&points.length>1);assert.equal(points[0].x,farm.x);assert.equal(points[0].y,farm.y);
  const end=points.at(-1);assert.ok(Math.hypot(end.x-53856,end.y-992)<=64,JSON.stringify(end));assert.equal(end.f,1664); // one lattice step from the rail's first waypoint, on its floor
  assert.ok(points.slice(1).every((q,i)=>edge(points[i],q)));
  assert.equal(cutTourWalk(geo,{x:47*1024+512,y:54*1024+512},step).points,null);
});
// Two waypoints of the 2026-10-19 Badlands to_node bake: #1468 on the 2816 shelf, and the last, on the stone's mesa.
const BADLANDS_RAIL=[{x:46080,y:64448,f:4096},{x:33024,y:31808,f:2816}];
test('a body already on the Badlands rail shelf (Bunsen r37c33) boards the nearest rail waypoint, not the unreachable head',()=>{
  const geo=roomGeometry(45),step=inRoomNodePlan('badlands')[0],edge=edgeOf(geo),from={x:33024,y:37120};
  assert.equal(cutTourWalk(geo,from,step).points,null); // what body_seeded_cut_failed was, 02:49Z
  const b=railBoardingCut(geo,from,step,BADLANDS_RAIL);
  assert.ok(b.points,JSON.stringify(b.attempts));assert.equal(b.target.index,1);
  assert.deepEqual([b.target.step.row,b.target.step.col],[32,33]); // the route's `to`: fineclimb's arrival square, not the head r1c53
  const end=b.points.at(-1);assert.ok(Math.hypot(end.x-33024,end.y-31808)<=64,JSON.stringify(end));
  assert.ok(b.points.slice(1).every((q,i)=>edge(b.points[i],q)));
});
test('boarding still refuses a body under the mesa, after trying each candidate and the head',()=>{
  const geo=roomGeometry(45),step=inRoomNodePlan('badlands')[0];
  const b=railBoardingCut(geo,{x:47*1024+512,y:54*1024+512},step,[BADLANDS_RAIL[0]]);
  assert.equal(b.points,null);assert.deepEqual(b.attempts.map(a=>a.index),[0,'head']);
});
test('a body already on the rail (Robin r40c19, 0.27 squares off) gets no cut: the rail follow boards there',()=>{
  const geo=roomGeometry(45),step=inRoomNodePlan('badlands')[0];
  const b=railBoardingCut(geo,{x:18944,y:40448},step,[...BADLANDS_RAIL,{x:18752,y:40640,f:2560}]);
  assert.equal(b.onRail,true);assert.equal(b.points,null);assert.equal(b.target.index,2);assert.deepEqual(b.attempts,[]);
});
console.log(count+' tour checks passed');
