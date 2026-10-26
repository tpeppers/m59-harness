import { readToolSource } from './autopilot/source.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'m59-pocket-'));
for(const [k,v] of Object.entries({M59_LEDGER_DIR:'ledger',M59_TACTICS_DIR:'tactics',M59_TRAILS_DIR:'trails',M59_SPOT_CLAIMS_DIR:'claims',M59_SHELTER_DIR:'shelter',M59_CROSSINGS_LEARNED:'crossings.json'}))process.env[k]=join(scratch,v);
process.env.M59_RUNTIME_PROFILE='lab';
const {Session}=await import('./m59-game.mjs'),{geometryFor}=await import('./m59-safespots.mjs');
const {routesFor}=await import('./m59-routes.mjs');
const {pocketRailBook,planRailDeparture,validateEscape,traceWireLeg,rememberedDeparture,isFinePassageStop}=await import('./m59-pocket-rails.mjs');
const {narrowPassages,claimPassageMove,releaseConfirmedPassage}=await import('./m59-passage-admission.mjs');
const {configureSpotClaimStore}=await import('./m59-spotclaims.mjs');configureSpotClaimStore({enabled:false});
const {Autopilot}=await import('./m59-autopilot.mjs');
const map=JSON.parse(readToolSource(new URL('../substrate/m59-map.json',import.meta.url))),table=routesFor(map.geometryManifestSha256);
function fixture(room,x,y){
 const geo=geometryFor(map.rooms[room]),packets=[];
 const self={id:1,flags:4,x,y,row:Math.floor(y/64),col:Math.floor(x/64),predicted:false};
 const c={selfId:1,self,evSeq:0,rsc:new Map([[2,'quarry']]),room:{id:room,security:geo.security,flags:0,objects:new Map([[1,self]])},
  vitals:()=>({health:{value:76,max:76},vigor:{value:200,max:200}}),face(){},roomContents(){return 1;},
  predictSelf(p){this.self={...this.self,...p,predicted:true};this.room.objects.set(1,this.self);},
  moveTo(x,y){packets.push({x,y});this.predictSelf({x,y,row:Math.floor(y/64),col:Math.floor(x/64)});}};
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{map,room:map.rooms[room],geometry:geo},movementGeneration:0,name:'offline-pocket',
  need:()=>c,moveSpeed:()=>18,movementWasCancelled:g=>g!==s.movementGeneration,
  pacer:{async submit(_k,run){return run();}},async confirmPosition(){c.self.predicted=false;return c.self;}});
 Object.defineProperty(s,'live',{value:true});s.threatsHere=()=>[];
 return {s,c,geo,packets};
}
const fail=f=>({reason:'movement_deviation',deviation:{confirmed:true,from:{...f.c.self},position:{...f.c.self},requested:{row:34,col:36,x:2336,y:2208}}});
test('a planned refuge leg is not mislabeled as fallback while ordinary departure recovery retains its shelter gate',async()=>{
 const planned=fixture(2501,416,3808),p={x:416,y:3744};
 planned.s.shelterPolicy={onFallback:async()=>{throw Error('planned refuge leg is not fallback');}};
 const r=await planned.s.walkDepartureLegs([p],{row:58,col:6},{maxSteps:1,shelterFallback:false});
 assert.equal(r.arrived,true);assert.equal(planned.packets.length,1);
 const recovering=fixture(2501,416,3808);recovering.s.shelterPolicy={onFallback:async()=>true};
 assert.equal((await recovering.s.walkDepartureLegs([p],{row:58,col:6},{maxSteps:1})).cancelled,true);
 assert.equal(recovering.packets.length,0);
});

test('a refused overhang waits for the owned fall to settle and re-proves the same departure',async()=>{
 const f=fixture(2501,1170,2480),target={x:1138,y:2512};let attempts=0;
 f.s.collisionVertical={roomId:2501,min:15355,max:24000,settleAt:Date.now()+30};
 f.s.stepFine=async(x,y)=>{
  if(++attempts===1)return {moved:false,reason:'geometry_blocked'};
  assert(Date.now()>=f.s.collisionVertical.settleAt);
  f.c.predictSelf({x,y,row:Math.floor(y/64),col:Math.floor(x/64)});return {moved:true};
 };
 const r=await f.s.walkDepartureLegs([target],{row:39,col:17},{maxSteps:1});
 assert.equal(r.arrived,true);assert.equal(attempts,2);assert.equal(r.steps,1);
});
test('cancellation during fall settlement forbids the delayed departure packet',async()=>{
 const f=fixture(2501,1170,2480);let attempts=0;
 f.s.collisionVertical={roomId:2501,min:15355,max:24000,settleAt:Date.now()+50};
 f.s.stepFine=async()=>{attempts++;return {moved:false,reason:'geometry_blocked'};};
 const timer=setTimeout(()=>f.s.movementGeneration++,5);
 try{const r=await f.s.walkDepartureLegs([{x:1138,y:2512}],{row:39,col:17},{maxSteps:1});assert.equal(r.cancelled,true);assert.equal(attempts,1);}finally{clearTimeout(timer);}
});

test('every baked pocket escape replays through quantized collision and finishes on its intended exit',async()=>{
 for(const [room,r] of Object.entries(pocketRailBook().rooms))for(const rail of r.rails){
  const f=fixture(Number(room),rail.from.x,rail.from.y),original={...f.c.self};
  const plan=planRailDeparture(f.geo,f.c.self,rail.exit,{room:Number(room),table,manifest:map.geometryManifestSha256,objects:f.c.room.objects,selfId:1,seedOnly:true});
  assert.equal(plan.found,true,`${room} ${rail.from.x}/${rail.from.y}`);assert.equal(plan.via,'baked_pocket_rail');
  const result=await f.s.departureDetour(fail(f),{to:rail.exit,maxSteps:160});
  assert.equal(result.arrived,true,JSON.stringify(result));assert.equal(f.c.self.row,rail.exit.row);assert.equal(f.c.self.col,rail.exit.col);
  assert.equal(f.c.self.predicted,false);assert.ok(f.packets.length>0);assert(validateEscape(f.geo,original,f.packets).ok);
 }
});

test('real long-distance walker escapes the shared west pocket without certifying a boarding point as the destination',async()=>{
 const f=fixture(598,699,1572),r=await f.s.walkTo(19,65,{maxSteps:160});
 assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(f.c.self.row,65);assert.equal(f.c.self.col,19);assert.equal(f.c.self.predicted,false);
});
test('an unchanged resumed failure reuses its proof, and a changed blocker permits departure again',async()=>{
 const f=fixture(598,2405,2122),blocking={id:2,nameRsc:2,flags:9,x:2080,y:1632,row:25,col:32};f.c.room.objects.set(2,blocking);
 const a=await f.s.departureDetour(fail(f),{to:{row:65,col:19},maxSteps:160});
 assert.equal(a.arrived,false);assert.equal(a.reason,'object_blocked');assert.equal(a.detour.blocker.id,2);assert.equal(a.deviation.departure.blocker.id,2);assert.equal(f.packets.length,0);
 for(let n=0;n<5&&!rememberedDeparture(f.s,{row:65,col:19},new Set());n++)await f.s.departureDetour(fail(f),{to:{row:65,col:19},maxSteps:160});
 assert.ok(rememberedDeparture(f.s,{row:65,col:19},new Set()),'bounded searches must retain completed candidate refusals across retries');
 const b=await f.s.walkTo(19,65,{maxSteps:160});assert.equal(b.detour.reused,true);assert.equal(f.packets.length,0);
 f.c.room.objects.delete(2);assert.equal(rememberedDeparture(f.s,{row:65,col:19},new Set()),null);
 const departed=await f.s.departureDetour(fail(f),{to:{row:65,col:19},maxSteps:160});assert.equal(departed.arrived,true);
});
test('baked departures respect mandatory avoidance, geometry provenance and paced takeovers',async()=>{
 const f=fixture(598,1036,2165),rail=pocketRailBook().rooms[598].rails.find(r=>r.from.x===1036);
 const options={room:598,table,objects:f.c.room.objects,selfId:1,seedOnly:true};
 assert.equal(planRailDeparture(f.geo,f.c.self,rail.exit,{...options,manifest:'wrong'}).found,false);
 assert.equal(planRailDeparture(f.geo,f.c.self,rail.exit,{...options,avoidSquares:new Set(['35,20'])}).found,false);
 f.s.pacer.submit=async(k,run)=>{if(k==='move')f.s.movementGeneration++;return run();};
 const r=await f.s.departureDetour(fail(f),{to:rail.exit,maxSteps:160});assert.equal(r.cancelled,true);assert.equal(f.packets.length,0);
});
test('the survival ladder can cancel a cached or newly planned departure before its first packet',async()=>{
 const f=fixture(598,1036,2165);let calls=0;f.s.shelterPolicy={onFallback:async()=>{calls++;return true;}};
 const r=await f.s.departureDetour(fail(f),{to:{row:65,col:19},maxSteps:160});assert(r.cancelled);assert.equal(calls,1);assert.equal(f.packets.length,0);
});
test('fine mountain passage admission sees the neck the coarse cells missed and lets its incumbent leave',()=>{
 const a=fixture(598,2136,1664),b=fixture(598,2080,1632);
 a.c.room.objects.set(2,{id:2,flags:13,x:2080,y:1632,row:25,col:32});
 const zones=narrowPassages(a.geo);assert.ok([...zones.values()].some(z=>z.fine?.x===2080));
 assert.equal(claimPassageMove(a.s,{x:2080,y:1632}).objectId,2);
 assert.equal(claimPassageMove(b.s,{x:2136,y:1664}),null);
 assert(isFinePassageStop(a.geo,{x:2080,y:1632}));
 a.c.room.objects.delete(2);assert.equal(claimPassageMove(a.s,{x:2080,y:1632}),null);
 a.c.self={...a.c.self,x:2136,y:1664,predicted:true};assert.equal(releaseConfirmedPassage(a.s),false);
 a.c.self.predicted=false;assert.equal(releaseConfirmedPassage(a.s),true);
});
test('a body-blocked wire trace retains the actual object handle',()=>{
 const f=fixture(598,2405,2122),rail=pocketRailBook().rooms[598].rails[0];let at={...f.c.self},blocked;
 const objects=new Map([[2,{id:2,flags:9,x:2080,y:1632}]]);
 for(const q of rail.legs){const r=traceWireLeg(f.geo,at,q,{objects,selfId:1});if(!r.ok){blocked=r;break;}at=q;}
 assert.equal(blocked?.reason,'object_blocked');assert.equal(blocked.objectId,2);
});
test('failed quarry approaches cool down without banning the room, and moving the quarry invalidates the cooldown',async()=>{
 const f=fixture(578,1072,2928),foe={id:2,nameRsc:2,flags:9,x:1056,y:2784,col:16,row:43};f.c.room.objects.set(2,foe);
 f.s.world.approachSquare=()=>({col:16,row:43,steps:2});f.s.walkTo=async()=>({arrived:false,reason:'movement_deviation',deviation:{confirmed:true}});
 const ap=Object.assign(Object.create(Autopilot.prototype),{s:f.s,policy:{},note(){},terminalMovement(){return null;}});
 const r=await ap.closeOnQuarry(foe);assert.equal(r.closed,false);assert.ok(ap.pullTargetCooling(578,2));assert.equal(ap.unreachablePreySpots,undefined);
 foe.x+=16;assert.equal(ap.pullTargetCooling(578,2),null);
});
test('departure refusals invalidate on single-unit body movement, door state, changed geometry and avoidance',async()=>{
 const {rememberDeparture}=await import('./m59-pocket-rails.mjs'),f=fixture(598,2405,2122),to={row:65,col:19};
 const body={id:2,flags:9,x:2080,y:1632};f.c.room.objects.set(2,body);
 const remember=()=>rememberDeparture(f.s,to,new Set(),fail(f));
 remember();assert(rememberedDeparture(f.s,to,new Set()));body.x++;assert.equal(rememberedDeparture(f.s,to,new Set()),null);
 remember();f.c.room.sectorHeights=new Map([[1,400]]);assert.equal(rememberedDeparture(f.s,to,new Set()),null);
 remember();assert.equal(rememberedDeparture(f.s,to,new Set(['30,21'])),null);
 f.s.world.geometry=geometryFor(map.rooms[598]);assert.equal(rememberedDeparture(f.s,to,new Set()),null);
});
test('a blocker entering after planning cannot receive a through-body packet',async()=>{
 const f=fixture(598,2405,2122),target=pocketRailBook().rooms[598].rails[0].legs[0];let injected=false;
 f.s.pacer.submit=async(k,run)=>{if(k==='move'&&!injected){injected=true;f.c.room.objects.set(2,{id:2,flags:9,...target});}return run();};
 const r=await f.s.departureDetour(fail(f),{to:{row:65,col:19},maxSteps:160});
 assert.equal(r.arrived,false);assert(injected);assert(f.packets.every(p=>Math.hypot(p.x-target.x,p.y-target.y)>=16));
});
