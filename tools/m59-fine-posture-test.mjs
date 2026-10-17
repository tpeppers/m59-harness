// Real fine walker and packet validator; only KOD's resting rejection is modelled.
import assert from 'node:assert/strict';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
import {protocolToClient} from './m59-finepos.mjs';
const h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
const {geometryFor}=await h.imp('m59-safespots.mjs'),geo=geometryFor(h.map.rooms[2]);let from;
for(let row=3;row<geo.rows-3&&!from;row++)for(let col=3;col<geo.cols-3&&!from;col++){
 const p={x:col*64+32,y:row*64+32},a=protocolToClient(p),b=protocolToClient({x:p.x+32,y:p.y});
 if(geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false}).arrived)from={room:2,...p};
}
assert(from,'real geometry has a legal test stride');
function fixture(){const f=h.fixture({from});let resting=true,stands=0,refused=0;const move=f.c.moveTo.bind(f.c);
 f.c.lastPostureCommand={verb:'rest',room_object_id:f.c.room.id};
 f.c.stand=()=>{resting=false;stands++;f.c.lastPostureCommand={verb:'stand',room_object_id:f.c.room.id};};
 f.c.moveTo=(x,y)=>{if(resting){refused++;return;}move(x,y);};
 return{...f,get stands(){return stands;},get refused(){return refused;},sit(){resting=true;f.c.lastPostureCommand={verb:'rest',room_object_id:f.c.room.id};}};
}
const f=fixture();const walk=x=>withBodyCommand(f.s,()=>f.s.walkFine(x,from.y,{stride:8,maxSteps:8,arriveWithin:0,exactArrival:true}),'offline-fine-posture');
assert((await walk(from.x+8)).arrived);assert.equal(f.refused,0);assert.equal(f.stands,1);assert.equal(f.c.self.x,from.x+8);
assert((await walk(from.x+16)).arrived);assert.equal(f.stands,1,'closely queued waypoints do not pay redundant stand packets');
f.sit();assert((await walk(from.x+24)).arrived);assert.equal(f.stands,2,'a subsequent ordinary rest requires a new stand');
const cancelled=fixture(),submit=cancelled.s.pacer.submit.bind(cancelled.s.pacer);
cancelled.s.pacer.submit=async(kind,run,...args)=>{if(kind==='rest')cancelled.s.movementGeneration++;return submit(kind,run,...args);};
const result=await withBodyCommand(cancelled.s,()=>cancelled.s.walkFine(from.x+8,from.y,{stride:8,maxSteps:8,arriveWithin:0,exactArrival:true}),'offline-fine-posture-cancel');
assert(result.cancelled);assert.equal(cancelled.stands,0,'a takeover while the stand is queued must send neither stand nor move');assert.equal(cancelled.packets.length,0);
console.log('fine posture: seated movement, packet reuse, renewed rest and queued cancellation passed');

// Captured Brax cavern refusal reproduced with the real casting pacer: it used
// to return the identical blank geometry error after dropping all twenty moves.
{
 const {Pacer}=await h.imp('m59-game.mjs'),{bodyAuthority}=await h.imp('m59-body-command.mjs');
 const {readFileSync}=await import('node:fs'),capture=JSON.parse(readFileSync(new URL('./fixtures/brax-cavern-cast-hold.json',import.meta.url)));
 assert.equal(capture.returned_failure.last_step.reason,null);assert.deepEqual(capture.target,{x:592,y:600});
 const make=()=>{const f=h.fixture({from:{room:capture.room,...capture.start}});f.s.pacer=new Pacer();f.s.pacer.authority=()=>bodyAuthority(f.s);f.c.lastPostureCommand={verb:'stand',room_object_id:f.c.room.id};return f;};
 const f=make();f.s.pacer.holdForCast(300,'casting create food',{auto:true,spell:'create food'});
 const run=()=>withBodyCommand(f.s,()=>f.s.walkFine(592,600,{stride:128,maxSteps:8,arriveWithin:3,exactArrival:true,holdShelf:true}),'recorded-cavern-cast');
 let r=await run();assert(r.arrived,JSON.stringify(r));assert.equal(f.s.pacer.holdStatus().dropped.move??0,0);assert(f.packets.length>0);
 const during=make(),submit=during.s.pacer.submit.bind(during.s.pacer);let injected=false;
 during.s.pacer.submit=(kind,...args)=>{if(kind==='move'&&!injected){injected=true;during.s.pacer.holdForCast(300,'casting create food',{auto:true,spell:'create food'});}return submit(kind,...args);};
 r=await withBodyCommand(during.s,()=>during.s.walkFine(592,600,{stride:128,maxSteps:1,arriveWithin:3,exactArrival:true,holdShelf:true}),'cast-between-proof-and-send');
 assert(r.arrived,JSON.stringify(r));assert.equal(during.s.pacer.holdStatus().dropped.move,1,'a hold that begins at the send boundary is returned explicitly and does not spend the sole step');
 const cancelled=make();cancelled.s.pacer.holdForCast(300,'casting create food',{auto:true,spell:'create food'});
 setTimeout(()=>cancelled.s.movementGeneration++,40);
 r=await withBodyCommand(cancelled.s,()=>cancelled.s.walkFine(592,600,{maxSteps:8,exactArrival:true}),'cancelled-cast-wait');
 assert(r.cancelled);assert.equal(cancelled.packets.length,0);
 console.log('real cavern casting hold: existing and newly started casts wait without consuming steps; takeover still cancels with no packets');
}

// A cast can begin AFTER the declared-flight proof, at its final paced send.
// The same real native queue must label that unsent action for every mover.
{
 const {Pacer}=await h.imp('m59-game.mjs'),{bodyAuthority}=await h.imp('m59-body-command.mjs'),{prepareDeclaredJump}=await h.imp('m59-jump-takeoff.mjs');
 const {applyAncientFloors}=await h.imp('m59-moving-platform.mjs');
 const {readFileSync}=await import('node:fs'),capture=JSON.parse(readFileSync(new URL('./fixtures/brax-boarding-cast-race.json',import.meta.url)));
 assert.deepEqual(capture.reply.mover.validation,{});
 const f=h.fixture({from:{room:capture.room,...capture.from}});
 applyAncientFloors({rooms:{579:{}}},579,new Map([[2,{height:250,type:4}],[3,{height:250,type:4}],[4,{height:540,type:4}],[5,{height:200,type:4}],[6,{height:200,type:4}],[7,{height:200,type:4}],[8,{height:200,type:4}],[9,{height:510,type:4}]]),null,{geometryOf:()=>f.s.world.geometry});
 f.s.pacer=new Pacer();f.s.pacer.authority=()=>bodyAuthority(f.s);let inject=true;
 const submit=f.s.pacer.submit.bind(f.s.pacer);f.s.pacer.submit=(kind,...args)=>{if(kind==='move'&&inject){inject=false;f.s.pacer.holdForCast(150,'casting create food',{auto:true,spell:'create food'});}return submit(kind,...args);};
 const options={fall:true,timedFall:true,aimX:3552,aimY:1632};
 const first=await withBodyCommand(f.s,()=>f.s.step(55,25,options),'recorded-boarder-cast');
 assert.equal(first.moved,false);assert.equal(first.reason,'casting_hold');assert.equal(first.geometry_blocked,false);assert.equal(f.packets.length,0);
 const {unsentRailJumpRefusal}=await h.imp('m59-rail-observer.mjs');assert(unsentRailJumpRefusal({jumped:false,mover:first}));
 const second=await withBodyCommand(f.s,async()=>{
  assert((await prepareDeclaredJump(f.s)).ok);await f.s.confirmPosition();
  const proof=f.s.validateFineTarget(3552,1632,{slide:true,fall:true,timedFall:true});assert(proof.available&&proof.moved&&proof.arrived&&!proof.blocked,'a fresh full flight proof is required after the hold');
  return f.s.step(55,25,options);
 },'freshly-proved-boarder');
 assert(second.moved,JSON.stringify(second));assert.equal(f.packets.length,1,'the suppressed attempt sent no flight; the fresh attempt sends exactly one');
 console.log('shared paced queue: recorded boarding cast race reports an unsent hold; fresh proof then one legal flight, without a collision waiver');
}
