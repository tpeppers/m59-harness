import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {fineRefugeReach,planRecoveryApproach,planNearbyFineRefuge} from './m59-fine-refuge-reach.mjs';
import {planBodyDetour,blockingBodySnapshot} from './m59-body-detour.mjs';
import {protocolToClient} from './m59-roo.mjs';
import {OF,MOVEON} from './m59-parse.mjs';
import {recoveryRefugeReach,observeRefugeProgress,recoveryOccupiedSquares} from './m59-recovery-refuge.mjs';
import {nearestSafeSpot} from './m59-safespots.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
import {cutFineRailAsync} from './m59-fine-rail.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/konima-recovery-2505.json',import.meta.url)));
const geo=roomGeometry(fixture.room),from=fixture.from,objects=new Map(fixture.bodies.map(o=>[o.id,o]));
assert.equal(geo.path(from.row,from.col,22,63,{avoid:recoveryOccupiedSquares(objects,from.id),clearance:0,goalExempt:false}).found,false);
const reach=fineRefugeReach(geo,from,objects,from.id),r=reach(63,22);
assert(r.reachable&&r.fine_proved&&r.returnable);assert(r.steps<=8);
assert.equal(Math.floor(r.fine.x/64),63);assert.equal(Math.floor(r.fine.y/64),22);
assert.equal(reach(63,22),r,'one scan caches identical candidate proofs');
assert.equal(reach(67,24).reachable,false,'the blocked real approach is not licensed');
assert.equal(reach(60,23).reachable,false,'a fine gap does not permit an occupied refuge cell');
assert.equal(reach(63,10).reachable,false,'distant candidates keep the ordinary router');
assert.equal(fineRefugeReach(geo,{...from,predicted:true},objects,from.id)(63,22).reachable,false);
assert.equal(fineRefugeReach(geo,from,objects,from.id,{budgetMs:0})(63,22).reachable,false);
const unknown=new Map(objects);unknown.set(999,{id:999,flags:9,row:24,col:63});
assert.equal(fineRefugeReach(geo,from,unknown,from.id)(63,22).reachable,false,'missing nearby blocking-body fine coordinates are not clearance');
const recovery=recoveryRefugeReach(geo,from,objects,from.id);
assert(recovery(63,22).reachable);
assert.equal(recovery(60,23).reachable,false,'literal occupied goal remains excluded');
const selected=nearestSafeSpot(geo,from,{within:6,fineRecovery:true,reach:recovery});
assert(selected);assert.equal(selected.row,22);assert.equal(selected.col,63);assert(selected.fine);
const progress=observeRefugeProgress(null,geo,from,selected,1000);
assert(Number.isFinite(progress.best)&&progress.fineTarget);
const next=progress.fineTarget,d=Math.hypot(next.x-from.x,next.y-from.y);
const closer={...from,x:from.x+(next.x-from.x)*4/d,y:from.y+(next.y-from.y)*4/d};
observeRefugeProgress(progress,geo,closer,selected,1500);assert.equal(progress.progressedAt,1500);
observeRefugeProgress(progress,geo,from,selected,2000);assert.equal(progress.progressedAt,1500,'oscillation is not renewed progress');
const coarseMiss=Object.create(geo);coarseMiss.path=()=>({found:false});
const fineProgress=observeRefugeProgress(null,coarseMiss,from,selected,1000);
assert(Number.isFinite(fineProgress.best)&&fineProgress.fineTarget,'a coarse miss still measures a proved fine approach');
const n=fineProgress.fineTarget,d2=Math.hypot(n.x-from.x,n.y-from.y);
observeRefugeProgress(fineProgress,coarseMiss,{...from,x:from.x+(n.x-from.x)*4/d2,y:from.y+(n.y-from.y)*4/d2},selected,1500);
assert.equal(fineProgress.progressedAt,1500);
observeRefugeProgress(fineProgress,coarseMiss,{...from,predicted:true,x:n.x,y:n.y},selected,2000);
assert.equal(fineProgress.progressedAt,1500,'predictions cannot renew fine progress');
console.log('Recorded Konima recovery has a short reversible fine refuge approach; blocked, predicted, unknown-body and exhausted scans fail closed.');
const wait=planNearbyFineRefuge(geo,from,objects,from.id);
assert(wait.found&&wait.steps<=8);
assert(![...objects.values()].some(o=>o.id!==from.id&&o.row===wait.cell.row&&o.col===wait.cell.col&&
 (o.flags&(OF.ATTACKABLE|OF.PLAYER))));
assert.equal(planNearbyFineRefuge(geo,{...from,predicted:true},objects,from.id).found,false);
assert.equal(planNearbyFineRefuge(geo,from,objects,from.id,{budgetMs:0}).found,false);
assert.equal(planNearbyFineRefuge(geo,null,objects,from.id).found,false);
const hg=roomGeometry(2502),covered={id:1,x:2176,y:2552,row:39,col:34};
const held=planNearbyFineRefuge(hg,covered,new Map(),covered.id);
assert(held.found);assert.deepEqual(held.point,{x:covered.x,y:covered.y});
assert.equal(held.steps,0,'an already covered body keeps its real zero-length refuge');

// Populated Hollows travel: the keeper chose r42c42 from this upper ledge,
// then its centre-directed recovery walked west into the lower cavern. The
// same cell has a reversible entry only eight wire units from the real body.
const ledge={id:4282,row:42,col:43,x:2752,y:2744};
assert(hg.path(42,43,42,42,{clearance:0}).found,'the misleading coarse edge really exists');
const ledgeReach=recoveryRefugeReach(hg,ledge,new Map(),ledge.id)(42,42);
assert(ledgeReach.reachable&&ledgeReach.fine_proved&&ledgeReach.returnable);
assert.deepEqual(ledgeReach.fine,{x:2744,y:2744});
assert.equal(ledgeReach.steps,0.125);
const chooseLedge=returnable=>nearestSafeSpot(hg,ledge,{within:6,fineRecovery:true,
 reach:(col,row)=>col===42&&row===42?{...ledgeReach,returnable}:{reachable:false}});
assert.deepEqual(chooseLedge(true)?.fine,ledgeReach.fine,'the selected refuge retains its actual footing');
assert.equal(chooseLedge(false),null,'coarse reverse/onward membership cannot excuse a fine one-way refuge');

// Native Merb death scene: a clear four-square refuge was abandoned after the
// exposure optimizer ran out of time. Keep that feasible approach, while still
// refusing actual body obstruction and preserving the exhaustive nearest choice.
const merb=JSON.parse(readFileSync(new URL('./fixtures/merb-recovery-2503.json',import.meta.url)));
const mg=roomGeometry(merb.room),mb=new Map(merb.bodies.map(o=>[o.id,o]));
const choose=fineRecovery=>{let calls=0;const reach=recoveryRefugeReach(mg,merb.from,mb,merb.from.id);
 const picked=nearestSafeSpot(mg,merb.from,{within:Math.max(mg.rows,mg.cols),fineRecovery,
  reach:(col,row)=>{calls++;return reach(col,row);}});return {picked,calls};};
const exhaustive=choose(false),bounded=choose(true);
assert.deepEqual({row:bounded.picked.row,col:bounded.picked.col},{row:42,col:54});
assert(exhaustive.picked,'the legacy exhaustive scan still finds cover');
assert(bounded.calls<exhaustive.calls/2,'farther walls cannot delay an already better checked refuge');
const mo={objects:mb,selfId:merb.from.id,goalSquare:{row:42,col:54},marginSquares:4,
 maxRangeSquares:8,maxNodes:6000,maxMs:80,threatWeight:6,threatRadius:4,
 threats:merb.bodies.filter(o=>(o.flags&OF.ATTACKABLE)&&!(o.flags&OF.PLAYER))};
const deadline={now:()=>0,plan:(g,f,t,o)=>o.threatWeight>0?
 {found:false,reason:'body detour budget exhausted'}:planBodyDetour(g,f,t,{...o,maxMs:500})};
const escape=planRecoveryApproach(mg,merb.from,mg.standPointWire(42,54),mo,deadline);
assert(escape.found&&escape.checked_short_fallback);
let at=merb.from;
for(const point of escape.waypoints){
 const check=mg.traceFineMoveClient(protocolToClient(at.x),protocolToClient(at.y),
  protocolToClient(point.x),protocolToClient(point.y),{slide:false,obstacles:blockingBodySnapshot(mb,merb.from.id)});
 assert(check.moved&&check.blocked!==true);at=point;
}
assert.equal(Math.floor(at.y/64),42);assert.equal(Math.floor(at.x/64),54);
const occupied=new Map(mb);occupied.set(99999,{id:99999,flags:MOVEON.NO|OF.ATTACKABLE,
 row:42,col:54,x:at.x,y:at.y});
assert.equal(planRecoveryApproach(mg,merb.from,mg.standPointWire(42,54),{...mo,objects:occupied},deadline).found,false,
 'a priced-search deadline never permits walking through a blocking body');
const noRoute={...deadline,plan:(g,f,t,o)=>o.threatWeight>0?
 {found:false,reason:'no clear local body route'}:planBodyDetour(g,f,t,{...o,maxMs:500})};
assert.equal(planRecoveryApproach(mg,merb.from,mg.standPointWire(42,54),mo,noRoute).found,false,
 'a fresh terrain/body refusal is not a price deadline');
console.log('Recorded Merb recovery retains a collision-checked short escape after an exposure-price deadline and prunes only farther nearest-refuge candidates.');

// Populated convoy 28: Obfal's arrival is beside a broad exit trigger. The
// geometrically nearest refuge was r81c65, which the executing walker forbids.
const og=roomGeometry(2504),arrival={id:1,row:81,col:64,x:4128,y:5216};
const excludedRefuges=roomExitSquares(loadMap().rooms[2504],{rows:og.rows,cols:og.cols,includeInland:true});
const naive=planNearbyFineRefuge(og,arrival,new Map(),arrival.id);
assert(naive.found&&excludedRefuges.has(naive.cell.row+','+naive.cell.col),'the recorded nearest candidate is an exit');
const avoidSquares=new Set(excludedRefuges);avoidSquares.delete(arrival.row+','+arrival.col);
const constraints={avoidSquares,excludedRefuges};
assert.equal(fineRefugeReach(og,arrival,new Map(),arrival.id,constraints)(65,81).reachable,false);
assert.equal(fineRefugeReach(og,arrival,new Map(),arrival.id,{...constraints,
 excludedRefuges:new Set([arrival.row+','+arrival.col])})(arrival.col,arrival.row).reachable,false,
 'permission to leave an arrival cell does not make it a queue destination');
const queued=planNearbyFineRefuge(og,arrival,new Map(),arrival.id,constraints);
assert(queued.found&&queued.steps<=8&&!excludedRefuges.has(queued.cell.row+','+queued.cell.col));
const executable=await cutFineRailAsync(og,arrival,queued.point,{avoidSquares,objects:new Map(),selfId:arrival.id,maxMs:4000});
assert(executable.ok&&executable.bridgeOk,'the queue refuge satisfies the actual walker exit contract');
assert.equal(fineRefugeReach(og,arrival,new Map(),arrival.id,{...constraints,minimumFloor:100000})(queued.cell.col,queued.cell.row).reachable,false,
 'nearby refuge proof retains the executing floor constraint');
console.log('Recorded Obfal queue refuses exit-trigger parking and proves a short executable refuge under the same exit and floor constraints.');
