import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'m59-optimized-crowd-'));
for(const [key,file] of Object.entries({M59_TACTICS_DIR:'tactics',M59_TRAILS_DIR:'trails',M59_LEDGER_DIR:'ledger',M59_SHELTER_DIR:'shelters',M59_SPOT_CLAIMS_DIR:'claims',M59_CROSSINGS_LEARNED:'crossings.json',M59_COLLISION_TRACE_FILE:'collision.jsonl'}))process.env[key]=join(scratch,file);
const {Session}=await import('./m59-game.mjs'),{geometryFor}=await import('./m59-safespots.mjs');
const {M59Client}=await import('./m59-client.mjs');
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
function fixture({cancel=false,late=false,cancelPaced=false}={}){
 const geo=geometryFor(map.rooms[596]),packets=[],reads=[];
 const self={id:1,flags:4,x:1406,y:1973,row:30,col:21,degrees:0};
 const worm={id:2,flags:9,x:1390,y:1962,row:30,col:21,nameRsc:2};
 const c={selfId:1,self,evSeq:0,rsc:new Map([[2,'groundworm']]),room:{id:596,security:geo.security,flags:0,objects:new Map([[1,self],[2,worm]])},
  vitals:()=>({health:{value:13,max:20},vigor:{value:80,max:200}}),face(){},userCommand(){},stand:M59Client.prototype.stand,
  predictSelf(next){this.self={...this.self,...next,predicted:true};this.room.objects.set(1,this.self);},
  roomContents(){reads.push('background');return reads.length;},
  moveTo(x,y){packets.push({x,y});this.predictSelf({x,y,row:Math.floor(y/64),col:Math.floor(x/64)});if(cancel)s.movementGeneration++;}}
 const s=Object.assign(Object.create(Session.prototype),{client:c,world:{room:{num:596},geometry:geo},movementGeneration:0,
  need:()=>c,moveSpeed:()=>18,movementWasCancelled:g=>g!==s.movementGeneration,
  pacer:{async submit(kind,invoke){if(late&&kind==='move'){worm.x=1406;worm.y=1949;}if(cancelPaced&&kind==='move')s.movementGeneration++;return invoke();}},
  async confirmPosition(){assert.ok(Math.hypot(c.self.x-worm.x,c.self.y-worm.y)>3*64,'confirmation stopped an escape while still within attack range');reads.push('confirmed');c.self.predicted=false;return c.self;}});
 Object.defineProperty(s,'live',{value:true});s.threatsHere=()=>[];
 return {s,c,geo,worm,packets,reads};
}
test('real rail / fine / validated-send path escapes Tos without waiting for periodic confirmation',async()=>{
 const f=fixture();const r=await f.s.followRail([{row:31,col:22},{row:26,col:17}],{maxSlips:2});
 assert.equal(r.railed,true,JSON.stringify(r));assert.equal(f.c.self.row,26);assert.equal(f.c.self.col,17);
 assert.ok(f.packets.length>1);assert.ok(f.reads.includes('background'),'periodic read was not issued while packets continued');
 assert.ok(f.packets.every(p=>Math.hypot(p.x-1390,p.y-1962)>=16));
});
test('real optimized walk reaches its local body route before the post-pivot confirmation',async()=>{
 const f=fixture();const r=await f.s.walkTo(17,26,{maxSteps:40});
 assert.equal(r.arrived,true,JSON.stringify(r));assert.ok(f.packets.length>1);assert.ok(f.reads.includes('confirmed'),'final arrival must still be confirmed');
});
test('a blocker entering during pacing refuses an unclipped fine packet without a read wait',async()=>{
 const f=fixture({late:true}),r=await f.s.stepFine(1406,1949,{bodyDetour:true});
 assert.equal(r.moved,false);assert.equal(r.reason,'object_blocked');assert.equal(f.packets.length,0);assert.equal(f.reads.length,0);
});
test('a replacement movement owner stops the real rail escape after its first packet',async()=>{
 const f=fixture({cancel:true}),r=await f.s.followRail([{row:31,col:22},{row:26,col:17}]);
 assert.equal(r.cancelled,true,JSON.stringify(r));assert.equal(f.packets.length,1);
});
test('passage confirmation remains mandatory for continuous fine movement',async()=>{
 const f=fixture();f.c.room.objects.delete(2);let confirmed=0;
 f.s.passageExitNeedsConfirmation=()=>true;f.s.confirmPosition=async()=>{confirmed++;return f.c.self;};
 await f.s.stepFine(1440,2016,{bodyDetour:true});assert.equal(confirmed,1);
});
test('a takeover during pacing sends no packet from the old body route',async()=>{
 const f=fixture({cancelPaced:true}),r=await f.s.followRail([{row:31,col:22},{row:26,col:17}]);
 assert.equal(r.cancelled,true,JSON.stringify(r));assert.equal(f.packets.length,0);
});
