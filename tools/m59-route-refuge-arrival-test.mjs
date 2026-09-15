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
const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
let passed=0;
async function test(name,run){await run();console.log('PASS '+name);passed++;}
function fixture({predicted=true,row=7,col=16,whole=false}={}){
 const calls=[],events=[];
 const c={state:'game',selfId:1,self:{id:1,row,col,predicted},room:{id:39,objects:new Map()},
  vitals:()=>({health:{value:whole?50:32,max:50},vigor:{value:80}}),
  rest:()=>assert.fail('route arrival must not fall back to unverified rest')};
 const s={client:c,name:null,movementGeneration:0,need:()=>c,
  world:{room:map.rooms[39],geometry:geometryFor(map.rooms[39]),map},
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
 k.goTravelling('route arrival test',{to:544});
 const where={row,col};s.shelterPolicy.onDivert(where,{source:'route',atStep:0});
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
console.log(passed+' route refuge arrival scenarios passed');
