// Real Session movement and committed collision geometry; no game sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
import {attachNavMesh,geometryIdentity,NAVMESH_FORMAT,NAVMESH_VERSION} from './m59-navmesh.mjs';
import {protocolToClient} from './m59-roo.mjs';
import {cutTourWalk} from './m59-node-tour.mjs';
import {claimPassageMove,releaseConfirmedPassage,narrowPassages,containsPassageBody,passagesAlong} from './m59-passage-admission.mjs';
import {configureSpotClaimStore,reserveFilePassage,reserveFilePassages,releaseFilePassage,confirmFilePassageEntry,filePassageSnapshot} from './m59-spotclaims.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const h=await bastionHarness();
const client=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
function fixture(goal={x:736,y:2272}){
 const f=h.fixture({from:{room:535,x:736,y:992}},{maxPackets:120,maxMs:20000});
 f.s.walkThroughOperableDoor=async()=>null;
 const geo=f.s.world.geometry,from=client(f.c.self),to=client(goal);
 const nodes=[from,to].map(p=>({...p,floor:geo.floorBaseAtClient(p.x,p.y),edges:[]}));
 nodes[0].edges=[{to:1,kind:'walk',points:[to]}];
 attachNavMesh(geo,{format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),nodes,polygons:[]});
 return {...f,geo,from,to,goal};
}
function forbidCoarse(f){
 const original=f.geo.path,own=Object.hasOwn(f.geo,'path');let calls=0;
 f.geo.path=()=>{calls++;throw Error('mesh execution must not restart the coarse walk');};
 return {calls:()=>calls,restore(){if(own)f.geo.path=original;else delete f.geo.path;}};
}

test('ordinary walkTo uses mesh aims through native packet execution and confirmed arrival',async()=>{
 const f=fixture(),r=await f.s.walkTo(11,35,{maxSteps:40,hardCap:40});
 assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(r.source,'navmesh');
 assert.equal(f.c.self.row,35);assert.equal(f.c.self.col,11);assert.equal(f.c.self.predicted,false);
 assert(f.packets.length<=40);assert.equal(r.steps,f.packets.length);
 assert(r.navmesh_proof_points>r.navmesh_aims*5,'dense proof is retained without making every sample a packet');
});

test('explicit fine approach retains the exact goal and original step budget',async()=>{
 const f=fixture(),r=await f.s.approachFine(11,35,{toX:736,toY:2272,maxSteps:40,movementGeneration:0});
 assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(r.source,'navmesh');
 assert.equal(f.c.self.x,736);assert.equal(f.c.self.y,2272);assert.equal(f.c.self.predicted,false);
 assert(f.packets.length<=40);
});

test('door actions keep priority over mesh planning',async()=>{
 const f=fixture();let queried=0;
 f.s.walkThroughOperableDoor=async()=>({arrived:false,reason:'timed_door_required'});
 f.s.walkViaNavMesh=async()=>{queried++;return null;};
 const r=await f.s.walkTo(11,35,{maxSteps:40});
 assert.equal(r.reason,'timed_door_required');assert.equal(queried,0);assert.equal(f.packets.length,0);
});

test('oversized aims, off-map exits and shelter detours stay with their native controller',async()=>{
 const f=fixture();
 assert.equal(await f.s.walkViaNavMesh(f.goal,{goalSquare:{row:35,col:11},maxSteps:1,hardCap:1}),null);
 assert.equal(await f.s.walkViaNavMesh({x:736,y:0},{maxSteps:40}),null);
 f.s.shelterPolicy={need:()=>true};
 assert.equal(await f.s.walkViaNavMesh(f.goal,{maxSteps:40}),null);
 assert.equal(f.packets.length,0);
});

test('mandatory squares and remembered refused edges constrain the full mesh route',async()=>{
 const f=fixture();
 const square=await f.s.walkViaNavMesh(f.goal,{maxSteps:40,avoidSquares:new Set(['25,11'])});
 assert.equal(square,null);assert.equal(f.packets.length,0);
 const edge=await f.s.walkViaNavMesh(f.goal,{maxSteps:40,blockedEdges:new Set(['24,11>25,11'])});
 assert.equal(edge,null);assert.equal(f.packets.length,0);
});

test('paced movement takeover revokes the mesh before its first packet',async()=>{
 const f=fixture(),original=f.s.pacer.submit;
 f.s.pacer.submit=async function(kind,run,...rest){if(kind==='move')f.s.movementGeneration++;return original.call(this,kind,run,...rest);};
 const r=await f.s.walkTo(11,35,{maxSteps:40,hardCap:40,movementGeneration:0});
 assert.equal(r.arrived,false);assert.equal(r.cancelled,true);assert.equal(f.packets.length,0);
});

test('failure after a mesh packet propagates without a fresh coarse replay',async()=>{
 const f=fixture(),guard=forbidCoarse(f),step=f.s.stepFine;let calls=0;
 f.s.stepFine=async function(...args){if(++calls===2)return {moved:false,reason:'object_blocked'};return step.apply(this,args);};
 try{
  const r=await f.s.walkTo(11,35,{maxSteps:40,hardCap:40});
  assert.equal(r.arrived,false);assert.equal(r.source,'navmesh');assert.equal(r.reason,'object_blocked');
  assert.equal(f.packets.length,1);assert.equal(guard.calls(),0);
 }finally{guard.restore();}
});

test('a new live body at paced send cannot be bypassed by a cached mesh',async()=>{
 const f=fixture(),guard=forbidCoarse(f),submit=f.s.pacer.submit;
 f.s.pacer.submit=async function(kind,run,...rest){
  if(kind==='move')f.c.room.objects.set(2,{id:2,flags:9,x:736,y:1056,row:16,col:11});
  return submit.call(this,kind,run,...rest);
 };
 try{
  const r=await f.s.walkTo(11,35,{maxSteps:40,hardCap:40});
  assert.equal(r.arrived,false);assert.equal(r.source,'navmesh');assert.equal(guard.calls(),0);
  assert(f.packets.length<=1,'native clipping may move to the blocker but cannot replay another route');
 }finally{guard.restore();}
});

test('an unconfirmed final body cannot report mesh arrival',async()=>{
 const f=fixture({x:736,y:1024});f.s.confirmPosition=async()=>null;
 const r=await f.s.walkViaNavMesh(f.goal,{maxSteps:4,hardCap:4});
 assert.equal(r.arrived,false);assert.equal(r.source,'navmesh');assert.equal(f.packets.length,1);
 assert.match(r.reason,/unconfirmed|confirmation/);
});

test('finePathProtocol exposes separate mesh aims and exact source proof without moving',()=>{
 const f=fixture(),p=f.geo.finePathProtocol(736,992,736,2272,{maxMs:100,maxWaypoints:40});
 assert.equal(p.found,true);assert.equal(p.source,'navmesh');
 assert.deepEqual(p.waypoints.at(-1),f.goal);assert(p.sourceWaypoints.length>p.waypoints.length*5);
 assert.equal(f.packets.length,0);
});

test('Mana Node tour cuts use the same mesh and retain exact CLIENT proof points',()=>{
 const f=fixture(),p=cutTourWalk(f.geo,f.from,{...f.to,row:35,col:11});
 assert(p.points);assert.equal(p.proof.source,'navmesh');assert.deepEqual(p.points[0],{...f.from,f:f.geo.floorBaseAtClient(f.from.x,f.from.y)});
 assert.deepEqual(p.points.at(-1),{...f.to,f:f.geo.floorBaseAtClient(f.to.x,f.to.y)});assert.equal(f.packets.length,0);
 const box=cutTourWalk(f.geo,f.from,{row:35,col:11,boxFlood:true});
 assert.equal(box.proof.source,'navmesh');assert.deepEqual(box.points.at(-1),f.to);
});


test('walkTo mesh costs retain threat, clearance and per-character jitter fields',async()=>{
 const f=fixture(),threats=[{row:25,col:11,vision:4,reach:2}],calls={threat:0,clearance:0,jitter:0};
 const originalThreat=f.geo.threatField,originalClear=f.geo.clearanceField;
 f.geo.threatField=seen=>{assert.deepEqual(seen,threats);return ()=>{calls.threat++;return 2;};};
 f.geo.clearanceField=options=>{assert.equal(options.weight,3);return ()=>{calls.clearance++;return 1;};};
 try{
  const r=await f.s.walkViaNavMesh(f.goal,{goalSquare:{row:35,col:11},maxSteps:40,
   squareCosts:{threats,clearance:3,extraCost:()=>{calls.jitter++;return .3;}}});
  assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(r.source,'navmesh');
  assert(calls.threat>0);assert(calls.clearance>0);assert(calls.jitter>0);
 }finally{delete f.geo.threatField;delete f.geo.clearanceField;}
});

// Two separate narrow passages reproduce a prediction that cleared the first
// claim before the following entry. These are real Session primitives and the
// ordinary atomic admission callback, with only collision and wire I/O faked.
function twoPassages(mode='confirmed',{fileDirectory=null}={}){
 configureSpotClaimStore(fileDirectory?{directory:fileDirectory,namespace:'replacement'}:{enabled:false});
 const geo={rows:5,cols:15,collisionReady:true,walkable:(r,c)=>
  r>=2&&r<=4&&((c>=1&&c<=3)||(c>=7&&c<=9)||(c>=13&&c<=15))||r===3&&c>=4&&c<=12};
 const point=(col,predicted=false)=>({x:col*64+32,y:224,row:3,col,predicted});
 const packets=[],name='passage-fixture-'+mode;
 const c={selfId:name,host:name,port:9,self:point(3),room:{id:991,flags:0,objects:new Map()},
  moveTo(x,y){packets.push({x,y});this.server={...this.self,x,y,col:Math.floor(x/64),row:Math.floor(y/64),predicted:false};},
  predictSelf(p){this.self={...this.self,...p,predicted:true};}};
 c.room.objects.set(name,c.self);
 const s=Object.assign(Object.create(h.Session.prototype),{name,client:c,world:{room:{num:991},geometry:geo},movementGeneration:0,
  need:()=>c,moveSpeed:()=>18,pacer:{submit:async(_kind,run)=>run()},
  movementWasCancelled:g=>g!==s.movementGeneration,groundEffectBlock:()=>null,recordValidatedWireMove:()=>{},
  validateFineTarget:(x,y)=>({available:true,moved:true,arrived:true,target:{x:Math.round(x),y:Math.round(y)}}),reads:0,
  async confirmPosition(){
   this.reads++;
   if(mode==='timeout')return null;
   if(mode==='generation')this.movementGeneration++;
   if(mode==='room')c.room.id++;
   c.self={...(c.server??c.self),predicted:false};return c.self;
  }});
 assert.equal(claimPassageMove(s,point(4)),null);
 const first=s._passage;
 c.self=point(9,true);c.server=point(9);
 return {s,c,geo,packets,first,target:point(10)};
}

test('a pending passage exit is confirmed before fine movement claims the next narrow zone',async()=>{
 const f=twoPassages();
 const before=f.s.claimPassageMove(f.target);
 assert.equal(before.traffic,'passage_admission');assert.match(before.note,/previous passage exit/);
 const r=await f.s.stepFine(f.target.x,f.target.y,{movementGeneration:0});
 assert.equal(r.moved,true);assert.equal(f.packets.length,1);assert.equal(f.s.reads,2);
 assert.notEqual(f.s._passage.zone,f.first.zone);assert.equal(f.s._passage.entryPending,false);
 f.c.self={...f.c.self,x:14*64+32,col:14,predicted:false};releaseConfirmedPassage(f.s);
});

test('passage refresh preserves an opposing admission after confirming its own prior exit',async()=>{
 const f=twoPassages('opponent'),peer={name:'opposing',client:{host:f.c.host,port:9,selfId:'opposing',self:{x:864,y:224,col:13,row:3},room:{id:991,objects:new Map()}},world:f.s.world};
 assert.equal(claimPassageMove(peer,{x:800,y:224}),null);
 const r=await f.s.stepFine(f.target.x,f.target.y,{movementGeneration:0});
 assert.equal(r.moved,false);assert.equal(r.traffic,'passage_admission');assert.equal(f.packets.length,0);
 assert.equal(f.s._passage,null);assert(peer._passage);
 peer.client.self={x:608,y:224,col:9,row:3,predicted:false};releaseConfirmedPassage(peer);
});

for(const mode of ['timeout','generation','room'])test('passage refresh sends no packet on '+mode,async()=>{
 const f=twoPassages(mode),r=await f.s.stepFine(f.target.x,f.target.y,{movementGeneration:0});
 assert.equal(r.moved,false);assert.equal(f.packets.length,0);assert.equal(f.s._passage,f.first);
 if(mode==='timeout')assert.equal(r.reason,'position_confirmation_timeout');
 if(mode==='generation')assert.equal(r.cancelled,true);
 if(mode==='room')assert.equal(r.left_room,true);
 f.c.self.predicted=false;f.c.room.id=991;releaseConfirmedPassage(f.s);
});

function iceHandoff(){
 configureSpotClaimStore({enabled:false});
 const f=h.fixture({from:{room:750,x:2656,y:904}},{maxPackets:4,maxMs:20000}),geo=f.s.world.geometry;
 const set=(x,y,predicted=false)=>f.c.room.objects.set(f.c.selfId,{...f.c.self,x,y,col:Math.floor(x/64),row:Math.floor(y/64),predicted});
 assert.equal(claimPassageMove(f.s,{x:2750,y:904}),null);
 assert.equal(f.s._passage.zone.id,'14,42');
 set(2800,904);releaseConfirmedPassage(f.s);assert.equal(f.s._passage.entryPending,false);
 return {...f,geo,set,old:f.s._passage,target:{x:2827,y:883}};
}

test('real Ice diagonal neck keeps both admissions until the confirmed body clears the old zone',async()=>{
 const f=iceHandoff(),a=client(f.c.self),b=client(f.target),zones=narrowPassages(f.geo),old=zones.get('14,42'),next=zones.get('11,44');
 assert.equal(f.geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false})?.arrived,true);
 assert(containsPassageBody(old,f.c.self));assert(!containsPassageBody(next,f.c.self));
 assert.deepEqual(new Set(passagesAlong(f.geo,f.c.self,f.target).map(z=>z.id)),new Set(['14,42','11,44']));
 f.s.confirmPosition=async()=>null;
 const r=await f.s.stepFine(f.target.x,f.target.y,{movementGeneration:0});
 assert.equal(f.packets.length,1);assert.equal(r.reason,'position_confirmation_timeout');
 assert.equal(f.s._passage.zone.id,'11,44');assert.equal(f.s._passage.previous[0],f.old);
 assert.equal(f.c.self.predicted,true);assert.equal(releaseConfirmedPassage(f.s),false);
 // This observed point is physically in both expanded masks. Neither claim is released.
 f.set(2814,893);assert(containsPassageBody(old,f.c.self));assert(containsPassageBody(next,f.c.self));
 assert.equal(releaseConfirmedPassage(f.s),false);assert.equal(f.s._passage.previous[0],f.old);assert.equal(f.s._passage.entryPending,false);
 f.set(2827,883);assert.equal(releaseConfirmedPassage(f.s),true);assert.equal(f.s._passage.zone.id,'11,44');assert.equal(f.s._passage.previous,undefined);
 f.set(3000,1000);releaseConfirmedPassage(f.s);
});

test('real Ice handoff cannot bypass an opposing or human admission at either stride',()=>{
 for(const target of [{x:2812,y:894},{x:2827,y:883}]){
  const f=iceHandoff(),peer={name:'Ice-other-'+target.x,client:{host:f.c.host,port:f.c.port,selfId:'peer',self:{x:2912,y:800},room:{id:f.c.room.id,objects:new Map()}},world:f.s.world};
  // The peer enters the new neck from its far side.
  assert.equal(claimPassageMove(peer,{x:2870,y:800}),null);assert(peer._passage);
  const r=claimPassageMove(f.s,target);assert.equal(r.traffic,'passage_admission');assert.equal(r.zone,'11,44');
  assert.equal(f.s._passage,f.old);assert.equal(f.s._passage.previous,undefined);assert.equal(f.packets.length,0);
  peer.client.self={x:3100,y:1000,predicted:false};releaseConfirmedPassage(peer);
  f.c.room.objects.set(222,{id:222,flags:4,x:2827,y:883});
  assert.equal(claimPassageMove(f.s,target).objectId,222);assert.equal(f.s._passage,f.old);
  f.c.room.objects.delete(222);f.set(3000,1000);releaseConfirmedPassage(f.s);
 }
});

test('file passage handoff atomically retains all old zones and rejects an occupied batch',()=>{
 const directory=mkdtempSync(join(tmpdir(),'m59-handoff-'));
 configureSpotClaimStore({directory,namespace:'offline-handoff'});
 try{
  assert.equal(reserveFilePassage('owner',750,'A',{entryPending:true}).ok,true);
  assert.equal(reserveFilePassage('owner',750,'B').ok,false,'single-zone callers cannot silently replace their claim');
  assert.equal(reserveFilePassages('owner',750,[{zone:'B',entryPending:true}],{handoffFrom:[{room:750,zone:'A'}]}).ok,false,'unconfirmed entry cannot extend its ownership');
  assert.equal(confirmFilePassageEntry('owner',750,'A'),true);
  assert.equal(reserveFilePassage('other',750,'C').ok,true);
  const old=[{room:750,zone:'A'}];
  assert.equal(reserveFilePassages('owner',750,[{zone:'B',entryPending:true},{zone:'C',entryPending:true}],{handoffFrom:old}).ok,false);
  assert.deepEqual(filePassageSnapshot().filter(p=>p.agent==='owner').map(p=>p.zone),['A'],'a denied batch acquired nothing');
  releaseFilePassage('other');
  assert.equal(reserveFilePassages('owner',750,[{zone:'B',entryPending:true},{zone:'C',entryPending:true}],{handoffFrom:old}).ok,true);
  assert.deepEqual(new Set(filePassageSnapshot().filter(p=>p.agent==='owner').map(p=>p.zone)),new Set(['A','B','C']));
  assert.equal(reserveFilePassage('other',750,'A').ok,false);assert.equal(reserveFilePassage('other',750,'B').ok,false);
  assert.equal(confirmFilePassageEntry('owner',750,'B'),true);
  releaseFilePassage('owner',{room:750,zone:'A'});
  assert.equal(reserveFilePassage('other',750,'A').ok,true);assert.equal(reserveFilePassage('other',750,'B').ok,false);
  assert.deepEqual(new Set(filePassageSnapshot().filter(p=>p.agent==='owner').map(p=>p.zone)),new Set(['B','C']));
  releaseFilePassage('owner');releaseFilePassage('other');
 }finally{configureSpotClaimStore({enabled:false});rmSync(directory,{recursive:true,force:true});}
});

test('same-room geometry replacement retains one resource ticket and both physical masks',()=>{
 const directory=mkdtempSync(join(tmpdir(),'m59-passage-replacement-'));
 try{
  const f=twoPassages('replacement',{fileDirectory:directory}),held=f.first;
  f.c.self={...f.c.self,x:416,col:6,predicted:false};releaseConfirmedPassage(f.s);
  assert.equal(held.entryPending,false);assert.equal(held.file,true);
  const original=f.geo.walkable;
  // A refreshed coarse view omits the body's old cell, while native movement
  // may still prove its fine line. The same admission resource is not acquired
  // twice merely because the regenerated zone is a different object.
  f.s.world.geometry={...f.geo,walkable:(r,c)=>!(r===3&&c===6)&&original(r,c)};
  const regenerated=narrowPassages(f.s.world.geometry).get('3,4');
  assert.notEqual(regenerated,held.zone);assert.equal(regenerated.id,held.zone.id);
  assert(!containsPassageBody(regenerated,f.c.self));assert(containsPassageBody(held.zone,f.c.self));
  assert.equal(claimPassageMove(f.s,{x:352,y:224}),null);
  assert.equal(f.s._passage,held);assert.equal(held.previous,undefined);assert.equal(held.entryPending,false);
  assert.equal(filePassageSnapshot().filter(r=>r.agent===f.s.name).length,1);
  assert.equal(releaseConfirmedPassage(f.s),false,'the original physical mask still protects the confirmed body');
  // A following refresh expands that same resource. Retain its newly protected
  // area too, so observing an exit from the old mask alone cannot drop the claim.
  f.s.world.geometry={...f.geo,walkable:(r,c)=>
   r>=2&&r<=4&&((c>=1&&c<=3)||(c>=8&&c<=10)||(c>=13&&c<=15))||r===3&&c>=4&&c<=12};
  f.c.self={...f.c.self,x:480,col:7,predicted:false};
  assert(!containsPassageBody(held.zone,f.c.self));assert.equal(releaseConfirmedPassage(f.s),false,'the fresh geometry is reconciled before any confirmed release');
  assert.equal(claimPassageMove(f.s,{x:480,y:224}),null);
  assert.equal(filePassageSnapshot().filter(r=>r.agent===f.s.name).length,1);
  f.c.self={...f.c.self,x:608,col:9,predicted:false};assert.equal(releaseConfirmedPassage(f.s),true);
  assert.equal(f.s._passage,null);assert.equal(filePassageSnapshot().filter(r=>r.agent===f.s.name).length,0);
 }finally{configureSpotClaimStore({enabled:false});rmSync(directory,{recursive:true,force:true});}
});
