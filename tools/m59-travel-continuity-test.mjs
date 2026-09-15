import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
import {Autopilot,HANDLED} from './m59-autopilot.mjs';
import {protocolToClient} from './m59-roo.mjs';
import {attachSurvivalDecisions,currentSurvivalDecision,chooseSurvivalDecision} from './m59-survival-decision.mjs';
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
const clientPoint=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
function walkFixture({proved=false,bend=false}={}){
 const from={row:34,col:16,x:1068,y:2198},traces=[],pulls=[],steps=[];
 const route=bend?[{row:34,col:17},{row:35,col:17},{row:36,col:17}]:[{row:34,col:17},{row:34,col:18},{row:34,col:19}];
 const geo={collisionReady:true,num:598,standable:()=>true,
  path:()=>({found:true,steps:route}),standPoint:(row,col)=>clientPoint({x:col*64+32,y:row*64+32}),
  stringPull:points=>{pulls.push(points);return proved?{points,proved:points.slice(1).map(()=>true)}:null;},
  moverStepLands:()=>true,
  traceFineMoveClient:(x,y,tx,ty)=>{traces.push({from:{x,y},to:{x:tx,y:ty}});
    return bend&&ty!==protocolToClient(34*64+32)?{x,y}:{x:tx,y:ty};}};
 const c={self:{...from},room:{id:598,objects:new Map()},vitals:()=>({health:{value:49,max:49}})};
 const stop=new Error('stop before packet');
 const s={live:true,client:c,movementGeneration:0,world:{geometry:geo,room:{num:598}},need:()=>c,
  threatsHere:()=>[],movementWasCancelled(g){return g!==this.movementGeneration;},
  cancelledMovement:()=>({cancelled:true}),walkPivots:async()=>({done:false,legs:0,singles:0}),
  step:async(col,row)=>{steps.push({row,col});throw stop;}};
 return {s,c,geo,from,traces,pulls,steps,run:async()=>{try{await Session.prototype.walkTo.call(s,17,36);}catch(e){if(e!==stop)throw e;}}};
}
await test('fallback line traces use client units from the actual body',async()=>{
 const f=walkFixture();await f.run();assert.ok(f.traces.length);assert.deepEqual(f.traces[0].from,clientPoint(f.from));
});
await test('fallback route proof starts at the actual fine position',async()=>{
 const f=walkFixture();await f.run();assert.ok(f.pulls.length);assert.deepEqual(f.pulls[0][0],clientPoint(f.from));
});
await test('a fine-position change in the same square cannot reuse the origin proof',async()=>{
 const f=walkFixture();await f.run();f.c.self.x+=3;await f.run();
 assert.equal(f.pulls.length,2);assert.deepEqual(f.pulls[1][0],clientPoint(f.c.self));
});
await test('proved squares on different legs cannot license a corner-cutting hop',async()=>{
 const f=walkFixture({proved:true,bend:true});await f.run();assert.deepEqual(f.steps[0],{row:34,col:17});
});
await test('fallback checks shelter before sending another movement',async()=>{
 const f=walkFixture();let handoffs=0;f.s.shelterPolicy={onFallback:async()=>{handoffs++;f.s.movementGeneration++;return true;}};
 await f.run();assert.equal(handoffs,1);assert.equal(f.steps.length,0);
});
for(const proved of [false,true])await test((proved?'proved hit-clamped':'unproved')+' steps do not invent a previous refuge',async()=>{
 const events=[],route=Array.from({length:6},(_,i)=>({row:10,col:11+i}));
 const c={self:{row:10,col:10,x:672,y:672},room:{id:598}};
 const geo={standPoint:(row,col)=>clientPoint({x:col*64+32,y:row*64+32}),
  stringPull:points=>({points,proved:points.slice(1).map(()=>proved)})};
 let cancelled=false,asked=0;
 const s={client:c,live:true,movementGeneration:0,need:()=>c,damagedAt:Date.now(),movementWasCancelled:()=>cancelled,
  step:async(col,row)=>{events.push({kind:'step',row,col});Object.assign(c.self,{row,col,x:col*64+32,y:row*64+32});return {moved:true};}};
 const shelter={spots:[{row:10,col:13,atStep:2,detour:0}],maxDetour:5,need:()=>++asked>1,
  onDivert:(stop)=>events.push({kind:'divert',stop}),onArrive:async where=>{events.push({kind:'arrive',where});cancelled=true;}};
 await Session.prototype.walkPivots.call(s,route,geo,{shelter,maxMoves:5});
 assert.equal(events.filter(e=>e.kind==='arrive').length,1);assert.equal(events.filter(e=>e.kind==='divert'&&e.stop).length,1);
});
function keeperFixture(){
 const notes=[],events=[],work=[],s={name:null,movementGeneration:0,world:{room:{num:598}},
  client:{self:{row:33,col:15},room:{id:598,objects:new Map()},vitals:()=>({health:{value:49,max:49},vigor:{value:80,scale_max:200}})},
  movementWasCancelled(g){return g!==this.movementGeneration;}};
 const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{deaths:0},claims:new Map(),passes:17,mode:'farm',hold:null,
  suspendedJourney:{to:39,at:Date.now(),attempts:2,deaths_at:0},wantsForwardShelter:'old shelter request',
  note:(what,detail)=>notes.push({what,...detail}),releaseRestedHold:async()=>false,
  facultyOwner:()=> 'keeper',provision:async()=>{work.push('provision');return {ate:true};},
 });
 attachSurvivalDecisions(s,{record:e=>events.push(e)});
 const v=s.client.vitals();return {s,k,notes,events,work,ctx:{s,c:s.client,room:s.world.room,v,hp:1}};
}
await test('a body-clamped pivot still hands off arrival at the refuge it steps onto',async()=>{
 const c={self:{row:10,col:10,x:672,y:672},room:{id:598}},route=[{row:10,col:12},{row:10,col:15}];
 const geo={standPoint:(row,col)=>clientPoint({x:col*64+32,y:row*64+32}),
  stringPull:points=>({points:[points[0],points.at(-1)],proved:[true]})};
 let cancelled=false,arrivals=0;
 const s={client:c,need:()=>c,movementGeneration:0,movementWasCancelled:()=>cancelled,
  bodiesInSquare:()=>[{x:864,y:672}],_wallOk:()=>()=>true,
  step:async(col,row)=>{assert.deepEqual({row,col},{row:10,col:11});c.self={row,col,x:736,y:672};return {moved:true};}};
 const shelter={spots:[{row:10,col:11,atStep:0,detour:0}],need:()=>true,onArrive:async()=>{arrivals++;cancelled=true;}};
 const r=await Session.prototype.walkPivots.call(s,route,geo,{shelter,maxMoves:2});
 assert.equal(arrivals,1);assert.equal(r.cancelled,true);
});
await test('a real refuge requires actual onward progress before another routine diversion',async()=>{
 const events=[],route=Array.from({length:5},(_,i)=>({row:10,col:11+i}));
 const c={self:{row:10,col:10,x:672,y:672},room:{id:598}};
 const geo={standPoint:(row,col)=>clientPoint({x:col*64+32,y:row*64+32}),
  stringPull:points=>({points,proved:points.slice(1).map(()=>false)})};
 let cancelled=false;
 const s={client:c,need:()=>c,movementGeneration:0,movementWasCancelled:()=>cancelled,
  step:async(col,row)=>{events.push('step '+col);c.self={row,col,x:col*64+32,y:row*64+32};return {moved:true};}};
 const shelter={spots:[{row:10,col:11,atStep:0,detour:0}],need:()=>true,
  onDivert:stop=>events.push(stop?'divert '+stop.col:'deferred'),onArrive:async where=>{
   events.push('arrive '+where.col);
   if(where.col===11)shelter.spots=[{row:10,col:13,atStep:2,detour:0}];else cancelled=true;
  }};
 await Session.prototype.walkPivots.call(s,route,geo,{shelter,maxMoves:7});
 assert.deepEqual(events.slice(0,9),['divert 11','step 11','arrive 11','deferred','step 11','deferred','step 12','divert 13','step 13']);
 assert.equal(events.at(-1),'arrive 13');
});
for(const waiting of ['shelter','backoff'])await test('farming cannot replace a journey waiting for '+waiting,async()=>{
 const f=keeperFixture();if(waiting==='backoff')f.k.suspendedJourney.next_try_at=Date.now()+5000;
 assert.equal(await f.k.passFarm(f.ctx),HANDLED);assert.deepEqual(f.work,[]);assert.equal(f.k.suspendedJourney.to,39);
});
await test('adopting a confirmed safe wall fulfils the old shelter request',async()=>{
 const f=keeperFixture();f.k.currentRecoveryWall=()=>({ok:true,row:33,col:15});
 assert.equal(f.k.adoptRecoveryWall(),true);assert.equal(f.k.wantsForwardShelter,null);
 assert.equal(f.k.resumeShelterWaits,0);
});
await test('an unverified wall cannot fulfil a shelter request',async()=>{
 const f=keeperFixture();f.k.currentRecoveryWall=()=>null;
 assert.equal(f.k.adoptRecoveryWall(),false);assert.equal(f.k.wantsForwardShelter,'old shelter request');
});
await test('ordinary work resumes after the pending destination is explicitly retired',async()=>{
 const f=keeperFixture();f.k.suspendedJourney=null;
 assert.equal(await f.k.passFarm(f.ctx),HANDLED);assert.deepEqual(f.work,['provision']);
});
await test('fallback recovery replaces intent and acts before returning',async()=>{
 const f=keeperFixture();f.k.inert={travelling:true,to:39,guard:{safe_spot:true},attempts:1};f.k.suspendedJourney=null;
 f.s.shelterPolicy={need:()=>true};f.k.currentRecoveryWall=()=>null;
 const original=chooseSurvivalDecision(f.s,{strategy:'route_refuge',reason:'original route shelter'}),calls=[];
 f.k.suspendJourney=()=>{calls.push('suspend');f.k.suspendedJourney={to:39};};
 f.k.revive=()=>{calls.push('revive');f.k.inert=null;};
 f.s.cancelMovement=(_token,_why,{preserveId})=>{assert.equal(preserveId,currentSurvivalDecision(f.s).id);calls.push('cancel');f.s.movementGeneration++;};
 f.k.continueSurvivalDecision=async()=>{calls.push('execute');assert.equal(currentSurvivalDecision(f.s).status,'pending');return true;};
 assert.equal(await f.k.recoverFromTravelFallback({movementGeneration:0,why:'pivot approach failed'}),true);
 assert.deepEqual(calls,['suspend','revive','cancel','execute']);assert.notEqual(currentSurvivalDecision(f.s).id,original.id);
 assert.equal(currentSurvivalDecision(f.s).previous_decision_id,original.id);assert.equal(f.k.suspendedJourney.to,39);
});
await test('a stale fallback cannot take a newer mover',async()=>{
 const f=keeperFixture();f.k.inert={travelling:true,to:39,guard:{safe_spot:true}};f.s.movementGeneration=2;
 f.k.continueSurvivalDecision=()=>assert.fail('stale recovery ran');
 assert.equal(await f.k.recoverFromTravelFallback({movementGeneration:1}),false);
});
for(const mode of ['no need','disabled','other survival owner','already recovering'])await test('fallback preserves '+mode,async()=>{
 const f=keeperFixture();f.k.inert={travelling:true,to:39,guard:{safe_spot:mode!=='disabled'}};
 f.s.shelterPolicy={need:()=>mode!=='no need'};
 if(mode==='other survival owner')chooseSurvivalDecision(f.s,{strategy:'logoff_safe',reason:'other survival'});
 if(mode==='already recovering')chooseSurvivalDecision(f.s,{strategy:'route_refuge',status:'recovering',reason:'at wall'});
 const previous=currentSurvivalDecision(f.s);
 f.k.continueSurvivalDecision=()=>assert.fail('unexpected recovery');
 assert.equal(await f.k.recoverFromTravelFallback(),false);assert.equal(currentSurvivalDecision(f.s),previous);
});
for(const wall of [false,true])await test('fresh fallback chooses '+(wall?'safe logoff on its current wall':'nearest clear refuge'),async()=>{
 const f=keeperFixture();f.k.inert={travelling:true,to:39,guard:{safe_spot:true},attempts:1};
 f.s.shelterPolicy={need:()=>true};f.k.currentRecoveryWall=()=>wall?{ok:true,row:33,col:15}:null;
 f.k.revive=()=>{f.k.inert=null;};
 f.s.cancelMovement=()=>{f.s.movementGeneration++;};f.k.continueSurvivalDecision=async()=>true;
 assert.equal(await f.k.recoverFromTravelFallback(),true);
 assert.equal(currentSurvivalDecision(f.s).strategy,wall?'logoff_safe':'nearest_refuge');
 assert.equal(f.k.suspendedJourney.to,39);
});
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
