import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
import {walkCheckedRail} from './m59-rail-walk.mjs';
import {planLandingClearance,planQueuedEgress} from './m59-rail-traffic.mjs';
import {planDeclaredTakeoff} from './m59-jump-takeoff.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
import {protocolToClient} from './m59-finepos.mjs';
const h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
const capture=JSON.parse(readFileSync(new URL('./fixtures/brax-north-departure-reset.json',import.meta.url)));
assert(capture.events.filter(e=>e.event==='departure-advance'&&e.reply?.steps===0).length>=6);
const raised=geo=>applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(capture.observed).map(([id,height])=>[Number(id),{type:4,height}])),null,{geometryOf:()=>geo});
const declaration=col=>{const x=(col-1)*1024+512;return {room:579,from:{row:15,col},to:{row:8,col},from_fine:{x,y:14848},to_fine:{x,y:7680}};};
// A usable current flight waits for a northbound body rather than crossing lanes.
{
 const f=h.fixture({from:{room:579,x:3552,y:992},bodies:[{id:9,flags:5,x:3552,y:704}]},{bodies:true});raised(f.s.world.geometry);
 const d=declaration(55),body=f.c.self,objects=f.c.room.objects;
 assert(planDeclaredTakeoff(f.s.world.geometry,body,d).found);
 const blocked=planDeclaredTakeoff(f.s.world.geometry,body,d,{objects,selfId:1,stayInLane:true});
 assert.equal(blocked.found,false);assert.equal(blocked.reason,'declared_lane_occupied');assert.equal(f.packets.length,0);
 objects.delete(9);assert.deepEqual(planDeclaredTakeoff(f.s.world.geometry,body,d,{objects,selfId:1,stayInLane:true}).takeoff,{x:3552,y:992});
}

// Preserve the real aftermath: a follower occupied the predecessor's exact
// 32-unit clearance target, while the latter still had to plan the onward bend.
{
 const jam=JSON.parse(readFileSync(new URL('./fixtures/brax-north-passage-jam.json',import.meta.url))),geo=h.fixture({from:{room:579,...jam.from}}).s.world.geometry;
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(jam.observed).map(([id,height])=>[+id,{type:4,height}])),null,{geometryOf:()=>geo});
 raised(geo); // the completed flight/clearance happened before the timed lift reset
 const follower=jam.objects.find(o=>o.name==='Brax Xxxx');assert(follower);
 const old=planLandingClearance(geo,{...follower,x:3616,y:544,predicted:false},{x:3616,y:480});assert(old.found);assert(Math.hypot(old.target.x-jam.from.x,old.target.y-jam.from.y)<4,'old exact clearance target is occupied by a still-present traveler');
 const proof=planQueuedEgress(geo,{...jam.from,predicted:false},{x:4000,y:96});assert(proof.found);assert(proof.leg.waypoints.length>1);
 assert(!planQueuedEgress(geo,{...jam.from,predicted:true},{x:4000,y:96}).found);
 console.log('captured live north jam retains the occupied clearance endpoint and complete onward terrain proof');
}

// Twenty-five real Session movers share one body field. Both lanes advance in
// one native order each, with actual fine movement, gravity and final-send guards.
const count=25,actors=Array.from({length:count},(_,i)=>({id:100+i,name:'convoy-'+i,flags:5,x:3552+(i%2)*64,y:992+Math.floor(i/2)*32}));
// `sectorHeights` is what the server reported and what the raised geometry stands for; a declared
// jump with `requires.sectors` checks it before flying (m59-jump-precondition.mjs).
const observedHeights=()=>new Map(Object.entries(capture.observed).map(([id,height])=>[Number(id),{type:4,height}]));
const clients=actors.map(actor=>{const f=h.fixture({from:{room:579,x:actor.x,y:actor.y},bodies:actors.filter(b=>b.id!==actor.id)},{bodies:true,wireNames:true,maxPackets:300,maxMs:100000});raised(f.s.world.geometry);f.c.room.sectorHeights=observedHeights();return f;});
clients.forEach((f,index)=>{const base=f.c.moveTo.bind(f.c);f.c.moveTo=(x,y)=>{base(x,y);Object.assign(actors[index],{x,y,row:Math.floor(y/64),col:Math.floor(x/64)});for(const [j,other]of clients.entries())if(j!==index&&other.c.room.objects.has(100+index))other.c.room.objects.set(100+index,other.roomObject(actors[index]));};});
const began=Date.now(),outcomes=[];
await Promise.all(clients.map(async(f,index)=>withBodyCommand(f.s,async()=>{
 f.s.name=actors[index].name;
 const col=55+index%2,d=declaration(col),a={...protocolToClient(f.c.self),f:12800},b={...d.from_fine,f:12800};
 const result=await walkCheckedRail(f.s,{room:579,leg:{kind:'walk',waypoints:[b],sourceWaypoints:[a,b]},nextJump:d,stayInLane:true,timeoutMs:90000});
 assert(result.arrived||result.joined_takeoff,JSON.stringify({index,result}));
 const deadline=Date.now()+90000;
 for(;;){
  assert(Date.now()<deadline,'queued flight deadline');
  const plan=planDeclaredTakeoff(f.s.world.geometry,f.c.self,d,{objects:f.c.room.objects,selfId:1,stayInLane:true});
  if(!plan.found){await new Promise(r=>setTimeout(r,20));continue;}
  if(plan.takeoff.x!==f.c.self.x||plan.takeoff.y!==f.c.self.y){const align=await f.s.walkFine(plan.takeoff.x,plan.takeoff.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true});assert(align.arrived,JSON.stringify(align));continue;}
  const jump=await f.s.step(col,8,{fall:true,timedFall:true,aimX:col*64+32,aimY:544});
  if(jump.moved)break;
  assert(['object_blocked','fall_blocked_by_body','fall_changed_before_send'].includes(jump.reason),JSON.stringify(jump));await new Promise(r=>setTimeout(r,20));
 }
 assert.equal(f.c.self.row,8);
 await f.s.confirmPosition();
 const plan=planQueuedEgress(f.s.world.geometry,f.c.self,{x:4000,y:96});assert(plan.found,JSON.stringify({index,plan}));
 const egress=await walkCheckedRail(f.s,{room:579,leg:plan.leg,queuePath:true,exit:{to:578,row:1,col:62},convoy:{key:'offline-full-egress',characters:actors.map(a=>a.name)},timeoutMs:80000});assert(egress.arrived,JSON.stringify({index,egress}));
 assert.equal(f.s.world.room.num,578);assert(egress.crossing.left);
 // Bodies remain visible throughout the landing AND north passage, and leave
 // the shared collision field only after their ordinary declared map crossing.
 for(const [j,other]of clients.entries())if(j!==index)other.c.room.objects.delete(100+index);
 outcomes.push({index,elapsed:Date.now()-began,packets:f.packets.length});
},'offline-queued-departure')));
assert.equal(outcomes.length,count);assert(Date.now()-began<90000,'all twenty-five enter Cragged Mountains within the bounded socketless trial');
console.log('25 native queued departures enter Cragged Mountains with persistent body/floor/gravity proofs:',Date.now()-began,'ms;',outcomes.reduce((n,r)=>n+r.packets,0),'ordinary packets');


// Recover the actual five-person post-reset jam with the same ordinary spacing
// and native egress used by the public route. No actor vanishes at a short goal.
{
 const jamHarness=await bastionHarness(); // a separate recorded keeper-world scenario
 const {chooseBraxCrowdStep}=await import('./m59-brax-staging.mjs');
 const jam=JSON.parse(readFileSync(new URL('./fixtures/brax-north-passage-jam.json',import.meta.url)));
 const actors=[{...jam.from,flags:5,name:'Brax Pppp'},...jam.objects.filter(o=>o.is_player&&o.row===7&&o.col>=55&&o.col<=56).map(o=>({...o}))];
 const clients=actors.map(a=>{const f=jamHarness.fixture({from:{room:579,x:a.x,y:a.y},bodies:jam.objects.filter(o=>o.id!==a.id).concat(a.id===jam.from.id?[]:[{...jam.from,flags:5,name:'Brax Pppp'}])},{bodies:true,wireNames:true,maxPackets:512,maxMs:45000});
  f.s.name='captured-'+a.id;applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(jam.observed).map(([id,height])=>[+id,{type:4,height}])),null,{geometryOf:()=>f.s.world.geometry});return f;});
 clients.forEach((f,i)=>{const base=f.c.moveTo.bind(f.c);f.c.moveTo=(x,y)=>{base(x,y);Object.assign(actors[i],{x,y,row:Math.floor(y/64),col:Math.floor(x/64)});for(const[j,other]of clients.entries())if(i!==j&&other.c.room.objects.has(actors[i].id))other.c.room.objects.set(actors[i].id,other.roomObject(actors[i]));};});
 const people=new Map([...jam.objects,{...jam.from,flags:5,name:'Brax Pppp'}].map(o=>[o.id,{...o}])),ids=new Set(actors.map(a=>a.id));let staged=0;
 for(let n=0;n<48;n++){const step=chooseBraxCrowdStep(clients[0].s.world.geometry,people,ids);if(!step)break;
  const i=actors.findIndex(a=>a.id===step.id),f=clients[i],r=await withBodyCommand(f.s,()=>f.s.walkFine(step.target.x,step.target.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true}),'offline-jam-spacing');assert(r.arrived,JSON.stringify(r));Object.assign(people.get(step.id),actors[i]);staged++;}
 await Promise.all(clients.map((f,i)=>withBodyCommand(f.s,async()=>{
  await f.s.confirmPosition();const plan=planQueuedEgress(f.s.world.geometry,f.c.self,{x:4000,y:96});assert(plan.found,JSON.stringify(plan));
  const result=await walkCheckedRail(f.s,{room:579,leg:plan.leg,queuePath:true,exit:{to:578,row:1,col:62},convoy:{key:'captured-north-egress',characters:actors.map(a=>a.name)},timeoutMs:40000});assert(result.arrived,JSON.stringify({i,result}));
  assert(result.crossing.left,JSON.stringify({i,result}));assert.equal(f.s.world.room.num,578);
  for(const[j,other]of clients.entries())if(i!==j)other.c.room.objects.delete(actors[i].id);
 },'offline-captured-north-egress')));
 assert(staged>0&&staged<48);console.log('actual five-person north jam: '+staged+' ordinary spacing walks, all five legally enter Cragged Mountains with shared convoy admission');
}
