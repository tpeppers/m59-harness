import fs from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Autopilot } from './m59-autopilot.mjs';
import { roomGeometry } from './m59-ground.mjs';
import { attachSurvivalDecisions, chooseSurvivalDecision, currentSurvivalDecision, observeSurvivalDecision } from './m59-survival-decision.mjs';
const { mayLogoff, noteLogoff, readSession, SESSION_MIN_MS } = await import('./m59-healing-session.mjs');
const healingDir=fs.mkdtempSync(join(tmpdir(),'m59-safe-logoff-rearm-'));
process.env.M59_HEALING_DIR=healingDir;
let id=0, now=90_000_000, checks=0;
const realNow=Date.now;
Date.now=()=>now;
const ok=(label,fn)=>{fn();checks++;console.log('ok '+label);};
function fixture({pre=91,post=91,room=552,idAfter=4460,roomObjectAfter=1416,preAilment=false,postAilment=false,failReconnect=false}={}){
 const hold={room,row:6,col:74,proven:true,ok:true,takenAt:now-1000};
 let health=pre, ailments=preAilment?[{name:'poison'}]:[], wall=true, turns=0;
 const client=(bodyId,roomId)=>({state:'game',combatReady:true,selfId:bodyId,
   self:{id:bodyId,row:6,col:74,x:4768,y:416,degrees:135},room:{id:roomId,objects:new Map()},
   vitals:()=>({health:{value:health,max:122},vigor:{value:200,max:200}}),ailments:()=>ailments,
   face(degrees){turns++;this.self.degrees=degrees;}});
 const s={name:'victim-'+(++id),live:true,client:client(4460,1416),lifeBoundary:7,movementGeneration:29,damagedAt:now-1000,
   world:{room:{num:room,name:'The Great Ocean'},geometry:roomGeometry(552)},confirmFinePosition:async()=>({...s.client.self}),
   pacer:{submit:async(_kind,fn)=>fn()},need:()=>s.client,cancelMovement:()=>{s.movementGeneration++;}};
 attachSurvivalDecisions(s,{epoch:'fixture-epoch'});
 const k=Object.assign(Object.create(Autopilot.prototype),{
  s,hold,mode:'farm',policy:{molluskCoverRecovery:true},tally:{},passes:5,rejoinedAt:0,
  currentRecoveryWall:()=>wall?hold:null,adoptRecoveryWall:()=>wall,holdWorks:()=>wall,
  oceanRangedRecoveryEnabled:()=>room===552,operatorSurvivalStandDown:()=>false,
  logoffDeclined:()=>null,suspendJourney:()=>{},tellPilot:async()=>{},note:()=>{},noProgress:()=>{},
  reconnect:async()=>{
   if(failReconnect)return {ok:false,why:'fixture'};
   now+=1000;k.rejoinedAt=now;
   health=post;ailments=postAilment?[{name:'poison'}]:[];s.client=client(idAfter,roomObjectAfter);
   observeSurvivalDecision(s,health);return {ok:true};
  },
 });
 const start=()=>{chooseSurvivalDecision(s,{strategy:'logoff_safe',reason:'fixture',chosen_refuge:hold});return k.playDead('fixture');};
 const complete=async()=>{now+=25000;health=122;observeSurvivalDecision(s,health);return k.continueSurvivalDecisionStep();};
 const hit=()=>{now+=1000;health=86;s.damagedAt=now;observeSurvivalDecision(s,health);};
 return {s,k,start,complete,hit,getTurns:()=>turns,setWall:()=>{wall=false;},setAilment:()=>{ailments=[{name:'poison'}];}};
}
try{
 const valid=fixture(), a=valid.s.name;
 assert.equal(await valid.start(),true);
 ok('a real safe-wall reconnect retains the exact recovery decision and below-full return',()=>{
  const d=currentSurvivalDecision(valid.s);
  assert.equal(valid.getTurns(),1);assert.equal(d.strategy,'logoff_safe');assert.equal(d.phase,'reconnected_turn_and_heal');
  assert.equal(valid.k._safeLogoffRecovery.returnedHealth.value,91);assert.equal(mayLogoff(a,{afterRecovery:true}),false);
 });
 await valid.complete();
 ok('monotonic 91 to 122 on the same wall re-arms cooperation within the five-minute hold',()=>{
  const s=readSession(a);assert.equal(s.logoffs,1);assert.ok(now-s.last_logoff_at<SESSION_MIN_MS);
  assert.equal(mayLogoff(a,{afterRecovery:true}),true);assert.equal(mayLogoff(a),false);
  assert.equal(valid.k._safeLogoffRecovery,null);
 });
 noteLogoff(a,{room:552,cooperative:true});
 ok('one cooperative request consumes the receipt without permitting routine relogs',()=>{
  assert.equal(mayLogoff(a,{afterRecovery:true}),false);assert.equal(mayLogoff(a),false);
 });
 for(const [label,options] of [
  ['full throughout',{pre:122,post:122}],['returned already full',{post:122}],
  ['changed body ID',{idAfter:4461}],['changed room object',{roomObjectAfter:1417}],
  ['before poison',{preAilment:true}],['after poison',{postAilment:true}],
  ['fell lower on reconnect',{post:90}],['other room',{room:546}],
 ]){
  const f=fixture(options);await f.start();await f.complete();
  ok(label+' cannot arm cooperation',()=>assert.equal(mayLogoff(f.s.name,{afterRecovery:true}),false));
 }
 const failed=fixture({failReconnect:true});
 assert.equal(await failed.start(),false);
 ok('failed reconnect cannot supply a proof',()=>assert.equal(failed.k._safeLogoffRecovery,null));
 for(const [label,mutate] of [
  ['later loss of health',f=>f.hit()],['later poison',f=>f.setAilment()],['lost wall proof',f=>f.setWall()],
  ['later client replacement',f=>{f.s.client={...f.s.client};}],['new life',f=>{f.s.lifeBoundary++;}],
  ['new movement authority',f=>{f.s.movementGeneration++;}],['different square',f=>{f.s.client.self.row++;}],
  ['new reconnect timestamp',f=>{f.k.rejoinedAt++;}],['changed epoch',f=>{currentSurvivalDecision(f.s).epoch='other';}],
  ['same room but new recovery decision',f=>{chooseSurvivalDecision(f.s,{strategy:'logoff_safe',status:'recovering',chosen_refuge:f.k.hold});}],
 ]){
  const f=fixture();await f.start();mutate(f);await f.complete();
  ok(label+' cannot reuse the old proof',()=>assert.equal(mayLogoff(f.s.name,{afterRecovery:true}),false));
 }
 console.log(checks+' checks passed');
}finally{
 Date.now=realNow;
}
