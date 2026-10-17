// Offline, isolated books; no connection, roster, or production mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(),'m59-travel-crowd-'));
process.env.M59_SPOT_CLAIMS_DIR=join(scratch,'claims');
process.env.M59_TRAILS_DIR=join(scratch,'trails');
process.env.M59_TACTICS_DIR=join(scratch,'tactics');
const { MonsterAttention }=await import('./m59-monster-attention.mjs');
const { planBodyDetour }=await import('./m59-body-detour.mjs');
const { protocolToClient, clientToProtocol }=await import('./m59-roo.mjs');
const { Session }=await import('./m59-game.mjs');
const { M59Client, BP }=await import('./m59-client.mjs');
const { recoveryUnderPressure }=await import('./m59-recovery-refuge.mjs');
const { captureCachedScene }=await import('./m59-scene-capture.mjs');
const { geometryFor, nearestSafeSpot }=await import('./m59-safespots.mjs');
const { recoveryRefugeReach }=await import('./m59-recovery-refuge.mjs');

function attentionFixture(extra=[]) {
 const players=new Map([[1,{id:1,flags:4,x:320,y:320,posAt:1000}],...extra]);
 const monster={id:2,flags:9,x:400,y:320,predicted:false};players.set(2,monster);
 const tracker=new MonsterAttention();
 const close=()=>{for(let i=0;i<3;i++){const before={...monster};monster.x-=8;
  tracker.move(monster,before,players,1,1000+i*300);}};
 return {tracker,players,monster,close};
}
test('repeated closing gives inferred pursuit; absence, expiry and stillness stay unknown',()=>{
 const f=attentionFixture();assert.equal(f.tracker.view(2,1,1000).aggro_any,null);
 f.close();assert.equal(f.tracker.view(2,1,1600).aggro_at_me,true);
 assert.equal(f.tracker.view(2,1,1600).confidence,'inferred');
 assert.equal(f.tracker.view(2,1,9000).aggro_any,null);
 f.tracker.move(f.monster,f.monster,f.players,1,9100);
 assert.equal(f.tracker.view(2,1,9100).aggro_at_me,null);
});
test('collinear players remain ambiguous; stale and predicted player poses prove no target',()=>{
 const f=attentionFixture([[3,{id:3,flags:4,x:300,y:320,posAt:1000}]]);f.close();
 const v=f.tracker.view(2,1,1600);assert.equal(v.aggro_any,true);assert.equal(v.aggro_at_me,null);
 assert.equal(v.players.length,2);assert.ok(v.players.every(p=>p.aggro_at_player===null));
 for(const change of [{predicted:true},{posAt:-10000}]) {
  const g=attentionFixture();Object.assign(g.players.get(1),change);g.close();
  assert.equal(g.tracker.view(2,1,1600).aggro_at_me,null);
 }
 f.tracker.remove(2);assert.equal(f.tracker.view(2,1,1600).samples,0);
});
test('movement away and recycled room identities do not retain pursuit',()=>{
 const f=attentionFixture();f.close();f.tracker.reconcile(new Map());assert.equal(f.tracker.rows.size,0);
 for(let i=0;i<3;i++){const before={...f.monster};f.monster.x+=8;
  f.tracker.move(f.monster,before,f.players,1,2000+i*300);}
 assert.equal(f.tracker.view(2,1,2600).aggro_any,null);
 f.tracker.reset();assert.equal(f.tracker.rows.size,0);
});
test('real client move packets feed the tracker without movement requests or event-ring spam',()=>{
 const c=new M59Client({resources:new Map(),verbose:false});c.selfId=1;
 const f=attentionFixture();c.room={id:5,objects:f.players};c.monsterAttention=f.tracker;
 c.send=()=>assert.fail('passive attention cannot send');c.log=()=>{};
 for(const x of [392,384,376]){const b=Buffer.alloc(9);b.writeUInt32LE(2);b.writeUInt16LE(320,4);b.writeUInt16LE(x,6);b[8]=18;c.onGameMessage(BP.MOVE,b);}
 assert.equal(c.monsterAttention.rows.get(2).samples.length,3);
 assert.ok(!c.events?.some(e=>e.kind==='monster-moved'));
 const scene=captureCachedScene({client:c,world:{room:{num:574}},name:'fixture'},null);
 assert.ok(scene.actors.find(a=>a.kind==='monster').client_attention);
 assert.equal(scene.actors.find(a=>a.kind==='monster').server_state.how,'unknown');
});

// A synthetic flat pocket with the same body radius as the client trace. The
// real mover remains covered by collision-test; these tests exercise routing/control.
function flatGeometry({closed=false}={}) {
 return {collisionReady:true,traceFineMoveClient(x0,y0,x1,y1,{obstacles=[]}={}) {
  const a={x:clientToProtocol(x0),y:clientToProtocol(y0)},b={x:clientToProtocol(x1),y:clientToProtocol(y1)};
  let blocked=closed&&(b.y<96||b.y>104);
  for(const o of obstacles){const ox=clientToProtocol(o.x),oy=clientToProtocol(o.y);
   const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((ox-a.x)*dx+(oy-a.y)*dy)/(dx*dx+dy*dy||1)));
   if(Math.hypot(a.x+t*dx-ox,a.y+t*dy-oy)<16)blocked=true;}
  return blocked?{x:x0,y:y0,moved:false,reason:'object_blocked'}:{x:x1,y:y1,moved:true};
 }};
}
const body={id:2,flags:9,x:140,y:100,row:1,col:2};
test('fine routes price live threat exposure and retain that avoidance while pulling bends',()=>{
 const from={x:100,y:100},goal={x:180,y:100},danger={x:140,y:100};
 const plain=planBodyDetour(flatGeometry(),from,goal,{maxMs:500,maxNodes:16000});
 const safer=planBodyDetour(flatGeometry(),from,goal,{threats:[danger],threatWeight:10,threatRadius:0.5,maxMs:500,maxNodes:16000});
 assert(plain.found&&safer.found);assert(plain.waypoints.every(p=>p.y===100));
 let at=from,closest=Infinity;
 for(const p of safer.waypoints){
  const dx=p.x-at.x,dy=p.y-at.y,t=Math.max(0,Math.min(1,((danger.x-at.x)*dx+(danger.y-at.y)*dy)/(dx*dx+dy*dy)));
  closest=Math.min(closest,Math.hypot(at.x+t*dx-danger.x,at.y+t*dy-danger.y));at=p;
 }
 assert(closest>=24,`pulled route cut through the threat: ${closest}`);
 assert.deepEqual(at,goal);
});
test('local pour rounds a body, while an impassable crowd and search exhaustion refuse',()=>{
 const plan=planBodyDetour(flatGeometry(),{x:100,y:100},{x:180,y:100},{objects:new Map([[2,body]]),selfId:1});
 assert.equal(plan.found,true);assert.ok(plan.waypoints.some(p=>Math.abs(p.y-100)>=16));
 assert.equal(plan.waypoints.at(-1).x,180);
 const blocked=planBodyDetour(flatGeometry({closed:true}),{x:100,y:100},{x:180,y:100},{objects:new Map([[2,body]])});
 assert.equal(blocked.found,false);
 assert.equal(planBodyDetour(flatGeometry(),{x:100,y:100},{x:180,y:100},{maxNodes:1}).found,false);
 const avoid=new Set(['1,2']);
 assert.equal(planBodyDetour(flatGeometry(),{x:100,y:100},{x:180,y:100},{avoidSquares:avoid}).found,false);
});
function approachFixture(closed=false) {
 const geo=flatGeometry({closed}),calls=[],self={id:1,flags:4,x:100,y:100,row:1,col:1};
 geo.finePathProtocol=()=>({found:true,waypoints:[{x:220,y:100}]});
 const c={selfId:1,self,room:{id:5,objects:new Map([[1,self],[2,{...body}]]),flags:0},
  userCommand(){},stand:M59Client.prototype.stand};
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{room:{num:574},geometry:geo},movementGeneration:0,
  need:()=>c,movementWasCancelled:g=>g!==s.movementGeneration,
  pacer:{async submit(_kind,invoke){return invoke();}},
  validateFineTarget(x,y){const t=geo.traceFineMoveClient(protocolToClient(c.self.x),protocolToClient(c.self.y),protocolToClient(x),protocolToClient(y),
    {obstacles:[{id:2,x:protocolToClient(body.x),y:protocolToClient(body.y)}]});return t;},
  async stepFine(x,y){const r=this.validateFineTarget(x,y);calls.push({x,y,...r});if(r.moved)Object.assign(c.self,{x,y,row:Math.floor(y/64),col:Math.floor(x/64)});return r;},
  walkFine:()=>assert.fail('blocked body routes cannot fall into the stationary fan')});
 return {s,c,calls};
}
test('fine approach proactively detours, spending no refused move or waiting fan',async()=>{
 const {s,calls}=approachFixture();const r=await s.approachFine(3,1,{maxSteps:24});
 assert.equal(r.arrived,true);assert.ok(calls.length>1);assert.ok(calls.every(c=>c.moved));
});
test('sealed body approach returns immediately; takeover cannot send a later detour step',async()=>{
 const f=approachFixture(true);const r=await f.s.approachFine(3,1,{maxSteps:24});
 assert.equal(r.reason,'object_blocked');assert.equal(f.calls.length,0);
 const g=approachFixture();g.s.stepFine=async()=>{g.calls.push('step');g.s.movementGeneration++;return {moved:true};};
 assert.equal((await g.s.approachFine(3,1)).cancelled,true);assert.equal(g.calls.length,1);
});
test('ordinary fine travel rounds live bodies before a heading fan; closed crowds return',async()=>{
 for(const closed of [false,true]) {
  const {s,c,calls}=approachFixture(closed);delete s.walkFine;
  const r=await s.walkFine(220,100,{maxSteps:24,arriveWithin:1,exactArrival:true});
  assert.equal(r.arrived,!closed);assert.equal(c.lastPostureCommand?.verb,'stand','the ordinary fine mover stands through the actual client method');
  if(closed){assert.equal(r.reason,'object_blocked');assert.equal(calls.length,0);}
  else {assert.equal(c.self.x,220);assert.ok(calls.every(v=>v.moved));assert.ok(r.log.some(v=>v.body_detour));}
 }
});
test('coalesced square travel hands off before repeatedly clipping on an intermediate monster',async()=>{
 for(const late of [false,true]) {
 const f=approachFixture(),route=[{row:1,col:2},{row:1,col:3}];
 Object.assign(f.s.world.geometry,{num:574,standable:()=>true,moverStepLands:()=>true,
  path:()=>({found:true,steps:route}),standPoint:(row,col)=>({x:protocolToClient(col*64+32),y:protocolToClient(row*64+32)}),
  stringPull:()=>null});
 const calls=[];Object.defineProperty(f.s,'live',{value:true});f.s.threatsHere=()=>[];
 f.s.walkPivots=async()=>({done:false,legs:0,singles:0});
 f.s.confirmPosition=async()=>f.c.self;
 let packets=0;
 f.s.step=async()=>{if(!late||++packets>1)assert.fail('coarse endpoint must not be repeatedly driven through the body');
  f.c.self.x+=5;return {moved:true,reason:'object_blocked'};};
 if(late)f.s.validateFineTarget=()=>({reason:null,moved:true});
 f.s.walkFine=async(x,y,options)=>{calls.push(options);Object.assign(f.c.self,{x,y,row:Math.floor(y/64),col:Math.floor(x/64)});return {arrived:true,steps:3};};
 const r=await f.s.walkTo(3,1,{maxSteps:24});
 assert.equal(r.arrived,true,JSON.stringify({r,calls}));assert.equal(calls.length,1);assert.equal(calls[0].exactArrival,true);
 assert.equal(calls[0].movementGeneration,0);
 assert.equal(packets,late?1:0);
 }
});
test('pressure uses fresh damage/pursuit and preserves healthy forward travel',()=>{
 const c={vitals:()=>({health:{value:16,max:20}}),room:{objects:new Map()}};
 assert.equal(recoveryUnderPressure(c,9500,{now:10000}),true);
 assert.equal(recoveryUnderPressure(c,0,{now:10000}),false);
 assert.equal(recoveryUnderPressure(c,null,{now:10000,failed:true}),true);
 c.vitals=()=>({health:{value:20,max:20}});assert.equal(recoveryUnderPressure(c,9500,{now:10000}),false);
});
test('Cor Noth actual geometry: exposed exit preference yields to a short previous-wall option',()=>{
 const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
 const geo=geometryFor(map.rooms[574]),from={row:24,col:3},onward={row:39,col:11};
 const reach=recoveryRefugeReach(geo,from,new Map(),1);
 const forward=nearestSafeSpot(geo,from,{onward,forwardBias:8,within:Math.max(geo.rows,geo.cols),reach});
 assert.equal(forward.kind,'exit');
 const nearest=nearestSafeSpot(geo,from,{within:Math.max(geo.rows,geo.cols),reach});
 assert.ok(nearest.steps_away<=6);
 const limited=nearestSafeSpot(geo,from,{onward,forwardBias:8,within:Math.max(geo.rows,geo.cols),reach:(col,row)=>{
   const r=reach(col,row);return r.steps>nearest.steps_away+3?{reachable:false}:r;}});
 assert.notEqual(limited.kind,'exit');assert.ok(limited.steps_away<=nearest.steps_away+3);
});
