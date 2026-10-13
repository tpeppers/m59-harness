import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const scratch=mkdtempSync(join(tmpdir(),'m59-rizzo-deviation-'));
for(const [k,v] of Object.entries({M59_LEDGER_DIR:'ledger',M59_TACTICS_DIR:'tactics',M59_TRAILS_DIR:'trails',M59_SPOT_CLAIMS_DIR:'claims',M59_SHELTER_DIR:'shelters',M59_CROSSINGS_LEARNED:'crossings.json'}))process.env[k]=join(scratch,v);
const {Session}=await import('./m59-game.mjs'),{geometryFor}=await import('./m59-safespots.mjs'),{planBodyDetour}=await import('./m59-body-detour.mjs');
const map=JSON.parse(fs.readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
function fixture({timeout=false,takeover=false}={}){
 const geo=geometryFor(map.rooms[578]),packets=[],reads=[];
 const self={id:1,flags:4,row:18,col:16,x:1072,y:1200,degrees:0};
 const c={selfId:1,self,evSeq:0,rsc:new Map([[2,'troll']]),room:{id:578,security:geo.security,flags:0,objects:new Map([[1,self],[2,{id:2,flags:9,nameRsc:2,row:16,col:16,x:1056,y:1053}]])},
  vitals:()=>({health:{value:76,max:76},vigor:{value:200,max:200}}),face(){},roomContents(){return 1;},
  predictSelf(p){this.self={...this.self,...p,predicted:true};this.room.objects.set(1,this.self);},
  moveTo(x,y){packets.push({x,y});this.predictSelf({x,y,row:Math.floor(y/64),col:Math.floor(x/64)});}};
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{room:{num:578},geometry:geo},movementGeneration:0,name:'offline-rizzo',
  need:()=>c,moveSpeed:()=>18,movementWasCancelled:g=>g!==s.movementGeneration,
  pacer:{async submit(k,run){if(takeover&&k==='move')s.movementGeneration++;return run();}},
  async confirmPosition(opts){reads.push(opts);if(timeout)return null;c.self.predicted=false;return c.self;}});
 Object.defineProperty(s,'live',{value:true});s.threatsHere=()=>[];
 return {s,c,geo,packets,reads};
}
test('real step refuses recorded three-square slide before a move packet and reports confirmed blockers',async()=>{
 const f=fixture(),r=await f.s.step(13,18);
 assert.equal(r.reason,'movement_deviation');assert.equal(r.refused,true);assert.equal(f.packets.length,0);
 assert.equal(r.deviation.confirmed,true);assert.deepEqual(r.deviation.position,{row:18,col:16,x:1072,y:1200});
 assert.ok(r.deviation.error_units>2*64);assert.equal(r.deviation.blockers.objects[0].name,'troll');assert.equal(f.reads[0].timeoutMs,1500);
});
test('real walker leaves the recorded pocket by a wider physics path without sending the failed westward hop',async()=>{
 const f=fixture();f.c.room.objects.delete(2);const r=await f.s.walkTo(13,1,{maxSteps:120});
 assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(r.departure_detour,true);assert.equal(f.c.self.col,13);assert.equal(f.c.self.row,1);
 assert.ok(f.packets.length>1);assert.ok(f.packets[0].x>1072,'departure should head east around the wall');
 assert.ok(!f.packets.some(p=>p.x===1044&&p.y===1223),'rejected westward slide was still sent');
 assert.equal(f.c.self.predicted,false);
});
test('missing confirmation remains unknown rather than certifying a cached pose',async()=>{
 const f=fixture({timeout:true}),r=await f.s.step(13,18);assert.equal(r.deviation.confirmed,false);assert.equal(r.deviation.position,null);assert.ok(r.deviation.last_known);assert.equal(f.packets.length,0);
});
test('send-time drift is rechecked after pacing',async()=>{
 const f=fixture();let n=0;f.s.validateFineTarget=()=>({available:true,moved:true,target:++n===1?{x:1120,y:1200}:{x:900,y:1200}});
 const r=await f.s.queueValidatedMove(1120,1200,{maxDeviation:64});assert.equal(r.sent,false);assert.equal(r.validation.reason,'movement_deviation');assert.equal(f.packets.length,0);
});
test('small allowed slides and declared falls preserve their movement contract',async()=>{
 const f=fixture();f.s.validateFineTarget=()=>({available:true,moved:true,target:{x:1100,y:1200},blocked:true,reason:'geometry_blocked'});
 assert.equal((await f.s.queueValidatedMove(1120,1200,{maxDeviation:64})).sent,true);
 f.s.validateFineTarget=()=>({available:true,moved:true,target:{x:1200,y:1200},blocked:false});
 assert.equal((await f.s.queueValidatedMove(1200,1200,{fall:true,maxDeviation:64})).sent,true);
 f.s.validateFineTarget=()=>({available:true,moved:true,target:{x:1000,y:1200},blocked:true,reason:'geometry_blocked',fall_motion:{elapsed_ms:0}});
 assert.equal((await f.s.queueValidatedMove(1200,1200,{fall:true,timedFall:true,maxDeviation:64})).sent,true);
});
test('confirmation takeover cancels the old detour before sending',async()=>{
 const f=fixture();f.s.confirmPosition=async()=>{f.s.movementGeneration++;return f.c.self;};const r=await f.s.step(13,18);
 assert.equal(r.cancelled,true);assert.equal(r.deviation.confirmed,false);assert.equal(f.packets.length,0);
});
test('mandatory avoidance constrains the wider wire route',()=>{
 const f=fixture(),r=planBodyDetour(f.geo,f.c.self,{x:832,y:96},{objects:new Map(),goalSquare:{row:1,col:13},avoidSquares:new Set(['1,13']),marginSquares:12,maxRangeSquares:24,maxNodes:100,maxMs:100});assert.equal(r.found,false);
});

test('a stale observed push corrected by the fresh read does not fail a valid move',async()=>{
 const f=fixture();f.s.confirmPosition=async()=>{f.c.self={...f.c.self,x:1120,y:1200,col:17,predicted:false};return f.c.self;};
 const r=await f.s.confirmMovementDeviation({phase:'observed',predicted:{x:1120,y:1200}});assert.equal(r.resolved,true);assert.equal(f.s.lastMovementDeviation,undefined);
});
test('a takeover during departure pacing cancels before its first packet',async()=>{
 const f=fixture({takeover:true});f.c.room.objects.delete(2);const r=await f.s.walkTo(13,1,{maxSteps:120});assert.equal(r.cancelled,true);assert.equal(f.packets.length,0);
});

test('an ordinary planner fall cannot exempt the recorded large wall slide',async()=>{
 const f=fixture(),r=await f.s.step(13,18,{fall:true});assert.equal(r.reason,'movement_deviation');assert.equal(f.packets.length,0);assert.equal(r.deviation.confirmed,true);
});

test('a caller refusal at departure send boundary retains control and sends no packet',async()=>{
 const f=fixture();f.c.room.objects.delete(2);const failure=await f.s.step(13,18,{fall:true});const r=await f.s.departureDetour(failure,{to:{row:1,col:13},maxSteps:120,beforeMutation:()=>false});assert.equal(f.packets.length,0);assert.equal(r.cancelled,true);
});
