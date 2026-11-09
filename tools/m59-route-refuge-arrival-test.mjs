import { readToolSource } from './autopilot/source.mjs';
// Offline: real route policy and room geometry at the arrival/recovery handoff.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const evidence=mkdtempSync(path.join(tmpdir(),'m59-route-arrival-'));
process.env.M59_EVIDENCE_DIR=evidence;
process.env.M59_UPTIME_FILE=path.join(evidence,'uptime.jsonl');
const {Autopilot}=await import('./m59-autopilot.mjs');
const {geometryFor}=await import('./m59-safespots.mjs');
const {attachSurvivalDecisions,currentSurvivalDecision,chooseSurvivalDecision}=await import('./m59-survival-decision.mjs');
const {withMoveOrder,keeperOrigin,liveMoveOrder}=await import('./m59-move-origin.mjs');
const map=JSON.parse(readToolSource(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
let passed=0;
async function test(name,run){await run();console.log('PASS '+name);passed++;}
function fixture({predicted=true,row=7,col=16,whole=false,room=39,prepareStop=true,leaveRoom=false}={}){
 const calls=[],events=[];
 const geometry=geometryFor(map.rooms[room]);
 const c={state:'game',selfId:1,self:{id:1,row,col,predicted},room:{id:room,security:geometry?.security,objects:new Map()},
  vitals:()=>({health:{value:whole?50:32,max:50},vigor:{value:80}}),
  rest:()=>assert.fail('route arrival must not fall back to unverified rest')};
 const s={client:c,name:null,movementGeneration:0,need:()=>c,
  world:{room:map.rooms[room],geometry,map},
  movementWasCancelled(g){return g!==this.movementGeneration;},
  cancelMovement(_token,why,{preserveId}={}){
   assert.equal(currentSurvivalDecision(s)?.id,preserveId,'replacement owns cancellation');
   calls.push('cancel');this.movementGeneration++;
  },
  confirmPosition:async()=>{calls.push('confirm');c.self.predicted=false;return {row:c.self.row,col:c.self.col};},
  pacer:{submit:async(_lane,fn)=>fn()},
 };
 const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{refugeRestSeconds:0.001},tally:{},claims:new Map(),passes:1,
  book:{save(){},get:()=>null,discredited:()=>false},note(){},sanctuary:()=>false,roomOutranksUs:()=>true,
  inertStatus(){return this.inert;},recordTravelShelterStop(source){calls.push('count:'+source);},
  playDead:async()=>{assert.ok(k.currentRecoveryWall());calls.push('logoff');return true;},
  continueSurvivalDecision:async()=>{calls.push('replacement');assert.equal(currentSurvivalDecision(s).status,'pending');return true;},
 });
 attachSurvivalDecisions(s,{record:e=>events.push(e)});
 if(leaveRoom)chooseSurvivalDecision(s,{strategy:'leave_room',status:'approaching',reason:'spent logoff',
  chosen_refuge:{row:65,col:27,room,kind:'exit',destination:544}});
 k.goTravelling('route arrival test',{to:544,origin:leaveRoom?keeperOrigin('survival_exit'):null});
 const where={row,col};
 if(prepareStop)s.shelterPolicy.onDivert(where,{source:'route',atStep:0});
 const d=currentSurvivalDecision(s),policy=s.shelterPolicy;
 return {s,c,k,calls,events,d,where,run:()=>policy.onArrive(where)};
}
await test('predicted route arrival confirms before safe-wall logoff',async()=>{
 const f=fixture();await f.run();
 assert.deepEqual(f.calls,['confirm','count:route','logoff']);
 assert.ok(f.events.some(e=>e.decision.arrived_at));
});
await test('already confirmed route arrival does not request or send movement',async()=>{
 const f=fixture({predicted:false});await f.run();
 assert.deepEqual(f.calls,['count:route','logoff']);
});
for(const failure of ['unanswered','older reply','corrected position','geometry'])await test(failure+' starts replacement without unverified rest',async()=>{
 const f=fixture(failure==='geometry'?{predicted:false,row:8}:{});
 if(failure!=='geometry')f.s.confirmPosition=async()=>{
  f.calls.push('confirm');
  if(failure==='older reply')f.c.self.predicted=false;
  if(failure==='corrected position'){f.c.self={...f.c.self,row:8,predicted:false};return {row:8,col:16};}
  return null;
 };
 await f.run();
 assert.equal(f.calls.includes('logoff'),false);assert.equal(f.calls.includes('replacement'),true);
 assert.equal(f.calls.includes('cancel'),true);assert.equal(f.k.inert,null);
 assert.equal(f.k.suspendedJourney.to,544);assert.notEqual(currentSurvivalDecision(f.s)?.id,f.d.id);
 assert.ok(!f.events.find(e=>e.decision.id===f.d.id&&e.decision.arrived_at));
 assert.equal(f.k.unreachableIn(39)?.size??0,0,'failed arrival cannot discredit valid wall geometry');
});
for(const change of ['generation','room','client','decision'])await test(change+' change during confirmation retains the newer owner',async()=>{
 const f=fixture();f.s.confirmPosition=async()=>{
  f.calls.push('confirm');f.c.self.predicted=false;
  if(change==='generation')f.s.movementGeneration++;
  if(change==='room')f.s.world.room=map.rooms[544];
  if(change==='client')f.s.client=null;
  if(change==='decision')chooseSurvivalDecision(f.s,{strategy:'nearest_refuge',reason:'new owner'});
  return {row:7,col:16};
 };
 await f.run();assert.deepEqual(f.calls,['confirm']);
});
await test('whole confirmed traveller completes the route-refuge decision',async()=>{
 const f=fixture({whole:true});await f.run();
 assert.deepEqual(f.calls,['confirm']);assert.equal(currentSurvivalDecision(f.s),null);
 assert.equal(f.events.at(-1).decision.outcome,'recovered');
});
await test('a deferred shelter note does not throw or invent a chosen refuge',async()=>{
 const f=fixture(),run=f.k.shelterRun;
 f.s.shelterPolicy.onDivert(null,{atStep:1,suppressed:'one leg of progress owed since the last refuge'});
 assert.equal(currentSurvivalDecision(f.s).id,f.d.id);assert.equal(f.k.shelterRun,run);
});
await test('a nested shelter retains its original journey issuer during suspension',async()=>{
 const f=fixture(),origin={source:'fleetscript',name:'courier',run_id:'parent-proof'};
 f.k.revive('configure parent proof');
 await withMoveOrder(f.s,{kind:'travel',to:544,origin},async()=>{
   const parent=liveMoveOrder(f.s).origin;
   f.k.goTravelling('courier destination',{to:544});
   await withMoveOrder(f.s,{kind:'shelter',to:'r7c16',origin:keeperOrigin('shelter')},async()=>{
     assert.equal(f.k.suspendJourney('nested recovery'),true);
     assert.equal(f.k.suspendedJourney.to,544);assert.deepEqual(f.k.suspendedJourney.origin,parent);
   });
 });
});
await test('the spent-session exit owns its crossing until its decision changes',async()=>{
 const f=fixture({room:552,prepareStop:false,leaveRoom:true});
 assert.equal(f.d.strategy,'leave_room');
 assert.equal(f.s.shelterPolicy.need(),false);
 chooseSurvivalDecision(f.s,{strategy:'nearest_refuge',reason:'an independent emergency'});
 assert.equal(f.s.shelterPolicy.need(),true);
});
await test('a fallback endpoint cannot become the onward exit without a live offered hop',async()=>{
 const f=fixture({room:552,row:28,col:65,prepareStop:false});
 const {s,k}=f;
 s.activeShelter={onward:{row:28,col:65}};
 s.world.exits=opts=>{assert.deepEqual(opts,{cachedOnly:true});return null;};
 s.world.route=()=>assert.fail('recovery must not price a cold exit flood');
 assert.equal(k.verifiedRouteRefugeExit(552,544),null);
 let selected;
 k.checkFreeze=()=>false;
 k.searchSafeSpot=(_geo,_me,_room,opts)=>{selected=opts.onward;return null;};
 await k.takeSafeSpotObserved('fallback',null,{source:'travel',recovery:true,recoveryRoute:true,doorCrossings:1});
 assert.equal(selected,null,'continue wall selection without a fabricated exit');
 s.world.route=()=>({found:true,hops:[{from:552,to:544}]});
 const uncertain=[
  {to:544,stand_on:{row:28,col:65},reachable:true,verified:false},
  {to:544,stand_on:{row:29,col:65},reachable:true,verified:null},
  {to:544,stand_on:{row:30,col:65},verified:true},
 ];
 s.world.exits=()=>uncertain;
 assert.equal(k.verifiedRouteRefugeExit(552,544),null);
 s.world.exits=()=>[...uncertain,{to:544,stand_on:{row:65,col:27},reachable:true,verified:true}];
 assert.deepEqual(k.verifiedRouteRefugeExit(552,544),{row:65,col:27,destination:544});
});
await test('Pepe’s confirmed covered refuge hands the walker to spent-session recovery',async()=>{
 const f=fixture({room:552,row:43,col:57,predicted:false});
 f.k.mode='farm';
 f.k.policy.molluskCoverRecovery=true;
 f.k.casterScene=()=>({complete:true,casters:[{name:'mollusk creature',row:44,col:55}]});
 f.k.playDead=async reason=>{
  f.calls.push('spent');
  chooseSurvivalDecision(f.s,{strategy:'rest_safe',status:'recovering',reason,chosen_refuge:f.k.hold});
  return false;
 };
 await f.run();
 assert.deepEqual(f.calls,['count:route','spent','cancel']);
 assert.equal(f.k.suspendedJourney.to,544);
 assert.equal(currentSurvivalDecision(f.s).strategy,'rest_safe');
});
await test('Kermit’s arrived geometric wall leaves a mollusk in throw range',async()=>{
 const f=fixture({room:552,row:61,col:30,predicted:false});
 f.k.mode='farm';
 f.k.policy.molluskCoverRecovery=true;
 f.k.casterScene=()=>({complete:true,casters:[{name:'mollusk creature',row:60,col:30}]});
 assert.equal(await f.run(),false);
 assert.deepEqual(f.calls,[]);
 assert.equal(f.events.at(-1).decision.outcome,'blocked');
 assert.equal(f.k.inert.to,544);
});
console.log(passed+' route refuge arrival scenarios passed');
