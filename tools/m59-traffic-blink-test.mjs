import assert from 'node:assert/strict';
import {noteTrafficJam,trafficBlinkAdvice,waitForBlinkCast} from './m59-traffic-blink.mjs';
import {originLabel} from './m59-move-origin.mjs';
const {Autopilot}=await import(process.env.M59_AUTOPILOT_MODULE??'./m59-autopilot.mjs');
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
const place={room:27,row:18,col:8},origin={source:'fleetscript',name:'courier',run_id:'one'},owner=originLabel(origin);
const blocked={arrived:false,reason:'route_progressing_exits_exhausted',room:{num:27},destination:52,
 refusals:[{stage:'walk',why:'object_blocked',crossing_packet_sent:false,stand_on:{row:57,col:45}}]};
const note=(previous,now,extra={})=>noteTrafficJam(previous,{outcome:blocked,place,to:52,owner,now,...extra});
await test('repeated unsent body refusals retain their age across short jobs',()=>{
 const a=note(null,1000),b=note(a,8000);assert.equal(b.since,1000);assert.equal(b.attempts,2);
 assert.equal(trafficBlinkAdvice(b,{place,to:52,owner,now:10999}),null);
 assert.equal(trafficBlinkAdvice(b,{place,to:52,owner,now:11000}).wedged_for_ms,10000);
});
await test('unknown, geometry, mixed and cancelled refusals cannot arm a traffic escape',()=>{
 for(const outcome of [null,{...blocked,arrived:true},{...blocked,cancelled:true},{...blocked,reason:'movement cancelled'},
  {...blocked,refusals:[{...blocked.refusals[0],why:'geometry_blocked'}]},
  {...blocked,refusals:[{...blocked.refusals[0],crossing_packet_sent:true}]},
  {...blocked,refusals:[...blocked.refusals,{...blocked.refusals[0],why:'wall'}]}])assert.equal(note(null,1000,{outcome}),null);
});
await test('another owner, goal, room, displacement or stale retry starts a new episode',()=>{
 const a=note(null,1000);
 for(const extra of [{owner:'other'},{to:53},{place:{...place,col:20}},{place:{...place,room:28}}]){
  const b=note(a,12000,extra);assert.ok(!b||b.since===12000);
  assert.equal(trafficBlinkAdvice(a,{place,to:52,owner,now:12000,...extra}),null);
 }
 assert.equal(note(a,40000).since,40000);assert.equal(trafficBlinkAdvice(a,{place,to:52,owner,now:40000}),null);
});
function routingHost(change={}){
 let calls=0;
 const c={self:{row:18,col:8},room:{id:27},vitals:()=>({health:{value:87,max:87},mana:{value:50,max:50}}),
  spells:[{id:4,nameRsc:9}],rsc:{get:()=> 'blink'}};
 const s={name:'Offline courier',client:c,world:{room:{num:27},map:{rooms:{27:{goExits:[]}}}},movementGeneration:1,movementWasCancelled:g=>g!==s.movementGeneration};
 const h={s,policy:{},tally:{},passes:1,travelGuard:()=>({safe_spot:false}),pvpReturnGate:()=>null,travelInterrupted:()=>false,
  eatBeforeTravel:async()=>{},wedgePlace:()=>({room:s.world.room.num,...c.self}),doorNear:Autopilot.prototype.doorNear,
  wedgeBlink:Autopilot.prototype.wedgeBlink,answerWedge:async()=>({refused:true}),takeRecoverySpot:async()=>({took:true}),revive(){this.inert=null;},note(){},
  blinkFree:async()=>{calls++;c.self={row:30,col:30};return {moved:true,to:{room:27,...c.self}};}};
 h.trafficJam=note(note(null,Date.now()-12000),Date.now()-1000);change(h,c,s);
 return {h,c,s,calls:()=>calls};
}
await test('the real travel entry escapes a driver-owned short-job traffic jam before replanning',async()=>{
 const f=routingHost(()=>{});await Autopilot.prototype.travel.call(f.h,52,{origin});
 assert.equal(f.calls(),1);assert.equal(f.h.trafficJam,null);assert.equal(f.h.tally.traffic_blinks,1);assert.equal(f.c.self.row,30);
});
for(const [name,change] of [
 ['no failed road',h=>h.trafficJam=null],['another owner',h=>h.trafficJam.owner='foreign'],
 ['not yet ten seconds',h=>h.trafficJam.since=Date.now()-1000],
 ['an unlocked door',(h,c,s)=>s.world.map.rooms[27].goExits=[{to:28,row:18,col:9}]],
 ['low mana',(h,c)=>c.vitals=()=>({health:{value:87,max:87},mana:{value:14}})],
 ['hurt',(h,c)=>c.vitals=()=>({health:{value:20,max:87},mana:{value:50}})],
 ['combat',(h,c,s)=>s.combat={active:true}],['unknown Blink',(h,c)=>c.spells=[]],
 ['policy off',h=>h.policy.blinkWhenWedged=false]])await test(name+' retains the ordinary road without an escape cast',async()=>{
 const f=routingHost(change);await Autopilot.prototype.travel.call(f.h,52,{origin});assert.equal(f.calls(),0);
});
await test('cancellation during recovery cannot issue a replacement journey',async()=>{
 const f=routingHost((h,c,s)=>h.blinkFree=async()=>{s.movementGeneration++;return {moved:false,cancelled:true};});
 f.h.answerWedge=()=>assert.fail('cancelled journey reached replanning');
 const r=await Autopilot.prototype.travel.call(f.h,52,{origin});assert.equal(r.cancelled,true);
});
for(const kind of ['delayed landing','no effect','same-square room change','missing hold instrumentation','cancelled trance'])await test('real blinkFree: '+kind,async()=>{
 let now=1000000,castAt=null,holdUntil=0,casts=0;
 const realNow=Date.now,realTimeout=globalThis.setTimeout;
 Date.now=()=>now;
 globalThis.setTimeout=(fn,ms)=>{now+=ms;queueMicrotask(fn);return {unref(){}};};
 try{
  const c={self:{row:18,col:8},spells:[{id:4,nameRsc:9}],rsc:{get:()=> 'blink'},vitals:()=>({mana:{value:50}}),requestSpells(){},
   cast(){casts++;castAt=now;holdUntil=now+10000;c.lastCastSent={at:now};},
   roomContents(){if(now>=holdUntil&&kind!=='no effect'){if(kind==='same-square room change')s.world.room.num=59;else c.self={row:30,col:30};}},waitFor:async()=>({})};
  const s={client:c,world:{room:{num:27}},movementGeneration:1,
   movementWasCancelled:()=>kind==='cancelled trance'&&castAt!=null&&now-castAt>=4000,
   pacer:{submit:async(k,fn)=>fn(),...(kind==='missing hold instrumentation'?{}:{holdStatus:()=>({active:now<holdUntil})})}};
  const h={s,wantsBlink:{why:'captured traffic jam'},tally:{},note(){},progress(){}};
  const r=await Autopilot.prototype.blinkFree.call(h);assert.equal(casts,1);
  if(kind==='cancelled trance'){assert.equal(r.cancelled,true);assert.ok(now-castAt<10000);}
  else {assert.ok(now-castAt>=10000,'judged the cast before its ten-second trance');assert.equal(r.moved,kind!=='no effect');}
 }finally{Date.now=realNow;globalThis.setTimeout=realTimeout;}
});
await test('an unending cast hold has a bounded confirmation budget',async()=>{
 let now=0;const r=await waitForBlinkCast({holdStatus:()=>({active:true})},{now:()=>now,wait:async ms=>{now+=ms;},budgetMs:30000});
 assert.equal(r.quiet,false);assert.equal(now,30000);
});
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
