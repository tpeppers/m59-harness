import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
import {chooseBraxCrowdStep,chooseBraxRailStep,braxFoodShare} from './m59-brax-staging.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/brax-crowd-choke.json',import.meta.url))),geo=roomGeometry(fixture.room),objects=new Map(fixture.actors.map(o=>[o.id,{...o}])),ids=new Set(objects.keys());let moves=0;
while(moves<48){const step=chooseBraxCrowdStep(geo,objects,ids);if(!step)break;assert(step.after>step.before);assert(Math.abs(step.floor-step.height)<=384);
 const from=protocolToClient(step.from),to=protocolToClient(step.target),trace=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(objects,step.id)});assert(trace.arrived&&!trace.blocked);
 Object.assign(objects.get(step.id),step.target,{row:Math.floor(step.target.y/64),col:Math.floor(step.target.x/64)});moves++;}
assert(moves>0&&moves<48,'captured crowd disperses within bounded ordinary moves');
assert.equal(chooseBraxCrowdStep(geo,objects,new Set()),undefined,'an unselected body is never moved');
assert.equal(chooseBraxCrowdStep(geo,objects,ids,{exclude:ids}),undefined,'excluded actors remain untouched');
console.log('Brax crowd staging: '+moves+' proved walks disperse the captured crowd; foreign bodies and bounds retained');

assert.deepEqual(braxFoodShare([{id:1,name:"loaf of bread",amount:9}]),[{id:1,name:"loaf of bread",amount:5}]);
assert.deepEqual(braxFoodShare([{id:2,name:"loaf of bread",amount:4}]),[]);

const convoy=new Map(fixture.actors.map(o=>[o.id,{...o}]));let advances=0,clears=0;
for(let i=0;i<96;i++){
 const step=chooseBraxRailStep(geo,convoy,ids,fixture.railLegs)??chooseBraxCrowdStep(geo,convoy,ids);if(!step)break;
 const from=protocolToClient(step.from),to=protocolToClient(step.target),trace=geo.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(convoy,step.id)});
 assert(trace.arrived&&!trace.blocked);assert(step.height-step.floor<=384);step.railAdvance?advances++:clears++;
 Object.assign(convoy.get(step.id),step.target,{row:Math.floor(step.target.y/64),col:Math.floor(step.target.x/64)});
}
assert(advances>0,'the captured convoy advances along its real narrow staircase');
assert(advances+clears<96,'forward staging settles instead of oscillating against its own clearance moves');
assert.equal(chooseBraxRailStep(geo,convoy,new Set(),fixture.railLegs),undefined);
console.log('Brax convoy: '+advances+' forward rail moves and '+clears+' clearance walks, all body/terrain proved');

// A fresh 24-character departure also has a crowd before it reaches Ancient.
{
 const {chooseCrowdClearanceStep}=await import('./m59-rail-traffic.mjs');
 const {loadMap,roomExitSquares}=await import('./m59-map.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/road-crowd-choke.json',import.meta.url))),g=roomGeometry(f.room),people=new Map(f.actors.map(o=>[o.id,{...o}])),selected=new Set(people.keys());
 const avoidSquares=roomExitSquares(loadMap().rooms[f.room],{rows:g.rows,cols:g.cols,includeInland:true});let count=0;
 while(count<96){const step=chooseCrowdClearanceStep(g,people,selected,{avoidSquares});if(!step)break;assert(!avoidSquares.has(Math.floor(step.target.y/64)+','+Math.floor(step.target.x/64)));const a=protocolToClient(step.from),b=protocolToClient(step.target),trace=g.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:blockingBodySnapshot(people,step.id)});assert(trace.arrived&&!trace.blocked);Object.assign(people.get(step.id),step.target,{row:Math.floor(step.target.y/64),col:Math.floor(step.target.x/64)});count++;}
 assert(count>0&&count<96,'recorded Victoria crowd clears without oscillating or parking in exit triggers');
 console.log('Victoria departure crowd: '+count+' bounded ordinary spacing moves');
}

// Independent followers use a collision-proved prefix, keeping the next body's buffer.
{
 const {planRailForwardGap}=await import('./m59-rail-traffic.mjs');let advanced=0;
 for(const actor of convoy.values())for(const leg of fixture.railLegs){
  if(leg.kind!=='walk')continue;
  const gap=planRailForwardGap(geo,{...actor,predicted:false},leg,{objects:convoy,selfId:actor.id});if(!gap.found)continue;
  advanced++;assert(gap.advance>=8&&gap.advance<=96);
  const a=protocolToClient(actor),b=protocolToClient(gap.target),trace=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:blockingBodySnapshot(convoy,actor.id)});assert(trace.arrived&&!trace.blocked);
  for(const other of convoy.values())if(other.id!==actor.id)assert(Math.hypot(other.x-gap.target.x,other.y-gap.target.y)>=32);
  assert.equal(planRailForwardGap(geo,{...actor,predicted:true},leg,{objects:new Map(),selfId:actor.id}).found,false);
  assert.equal(planRailForwardGap(geo,{...actor,predicted:false},{kind:'jump'},{objects:new Map(),selfId:actor.id}).found,false);
 }
 assert(advanced>0,'the recorded convoy can independently advance after ordinary proved spacing opens a gap');
 console.log('Independent rail gaps: '+advanced+' real-geometry prefixes retain terrain and next-body clearance');
}

// A crowded terminal has a proved queue state distinct from exact arrival.
{
 const {railEndQueueReady}=await import('./m59-rail-traffic.mjs'),{applyAncientFloors}=await import('./m59-moving-platform.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/brax-south-queue.json',import.meta.url))),g=roomGeometry(f.room),people=new Map(f.actors.map(o=>[o.id,o]));
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(f.floors).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>g});
 const body=f.actors[0],leg={kind:'walk',waypoints:[f.goal]},options={objects:people,selfId:body.id};
 assert(railEndQueueReady(g,body,leg,options).ready,'a body-blocked traveler can join the queue without walking onto its predecessor');
 assert(!railEndQueueReady(g,{...body,predicted:true},leg,options).ready);
 assert(!railEndQueueReady(g,body,leg,{objects:new Map()}).ready,'an empty endpoint does not excuse an unrelated geometry failure');
 assert(!railEndQueueReady(g,{...body,x:body.x+256},leg,options).ready,'queue admission remains near the checked endpoint');
}


// Exercise the real preparation coordinator while the first crowd walk is still
// pending: a clear traveler must already be free to leave and never be moved again.
{
 const {prepareBraxGroup}=await import('./m59-brax-staging.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/road-crowd-choke.json',import.meta.url)));
 const people=new Map(f.actors.map(o=>[o.id,{...o,name:'actor'+o.id,is_player:true}])),members=f.actors.map(o=>'staging'+o.id),released=new Set();
 let unblock,started;const moving=new Promise(r=>{unblock=r;}),firstWalk=new Promise(r=>{started=r;});let moves=0;
 const origin={source:'fleetscript',name:'progressive-stage-test',run_id:'isolated'},contexts=members.map((agent,i)=>({agent,fleet:'test-progressive',origin,state:{},call:async(name,args)=>{
  if(name==='inventory')return{items:[]};assert.equal(name,'walk_to');assert(!released.has(agent),'a released actor belongs to its onward driver');moves++;if(moves===1){started();await moving;}
  Object.assign(people.get(i+1),{x:args.x,y:args.y,row:Math.floor(args.y/64),col:Math.floor(args.x/64)});return {arrived:true};
 }}));
 const roomOf=id=>({2:38,3:826,4:827,5:833}[id]??39);
 const observerOf=({agent})=>async()=>{const id=members.indexOf(agent)+1,you=people.get(id);assert(you,'staging read must not follow an actor that has left');return{character:'actor'+id,room:{num:roomOf(id)},you,hp:{value:20,max:20},vigor:{value:200},objects:[...people.values()].filter(o=>o.id!==id&&roomOf(o.id)===roomOf(id)),autopilot_status:{faculties:{movement:{owner:'fleetscript:progressive-stage-test',expires_in_ms:30000}}}};};
 const work=contexts.map(ctx=>prepareBraxGroup(ctx,members,{observerOf}).then(ok=>{released.add(ctx.agent);people.delete(members.indexOf(ctx.agent)+1);return ok;}));
 try{await Promise.race([firstWalk,new Promise((_,reject)=>setTimeout(()=>reject(Error('crowd movement did not start')),3000))]);
  assert(released.has('staging2'),'a clear traveler in another room leaves before a crowded room finishes its first spacing walk');assert(released.size<members.length,'crowded actors still wait for their own preparation');
 }finally{unblock();}
 assert((await Promise.all(work)).every(Boolean));assert.equal(released.size,24);assert(moves<48);
 const expected=members.filter((_,i)=>![826,827,833].includes(roomOf(i+1)));
 for(const ctx of contexts)assert.deepEqual(ctx.state.braxExpectedLiftAgents,expected,'only travelers who need the lift participate in its completion barrier');
 console.log('progressive departure: clear travelers leave during pending crowd work, and released actors are never staged again');
 // A later preparation phase in the same errand must re-observe its own room
 // instead of reusing the resolved outbound cohort.
 for(const o of f.actors)people.set(o.id,{...o,name:'actor'+o.id,is_player:true});released.clear();const before=moves;
 assert((await Promise.all(contexts.map(ctx=>prepareBraxGroup(ctx,members,{scope:'return-preparation',observerOf}).then(ok=>{released.add(ctx.agent);people.delete(members.indexOf(ctx.agent)+1);return ok;})))).every(Boolean));
 assert(moves>before,'a separately scoped phase does actual fresh crowd work');assert.equal(released.size,24);
}


{
 const {chooseCrowdClearanceStep,crowdDepartureReady}=await import('./m59-rail-traffic.mjs'),{loadMap,roomExitSquares}=await import('./m59-map.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/brax-return-entry-crowd.json',import.meta.url))),geo=roomGeometry(f.room),objects=new Map([...f.objects,f.body].map(o=>[o.id,{...o}])),selected=new Set([...objects.values()].filter(o=>o.flags&4).map(o=>o.id));
 const avoidSquares=roomExitSquares(loadMap().rooms[f.room],{rows:geo.rows,cols:geo.cols,includeInland:true});let walks=0,released=0;
 for(let i=0;i<96&&selected.size;i++){
  for(const id of crowdDepartureReady(objects,selected)){selected.delete(id);objects.delete(id);released++;}
  if(!selected.size)break;const step=chooseCrowdClearanceStep(geo,objects,selected,{avoidSquares});assert(step,'the actual overlapped entry crowd has a proved ordinary clearance');
  const a=protocolToClient(step.from),b=protocolToClient(step.target),proof=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:blockingBodySnapshot(objects,step.id)});assert(proof.arrived&&!proof.blocked);assert(!avoidSquares.has(Math.floor(step.target.y/64)+','+Math.floor(step.target.x/64)));
  Object.assign(objects.get(step.id),step.target,{row:Math.floor(step.target.y/64),col:Math.floor(step.target.x/64)});walks++;
 }
 assert.equal(selected.size,0);assert(walks>0&&walks<96);console.log('captured Cragged return-entry stack: '+walks+' collision-proved walks release '+released+' selected travelers independently');
}
