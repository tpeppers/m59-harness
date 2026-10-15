// Offline: actual Session stand, refuge return and Pacer, no socket or roster.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Session} from './m59-game.mjs';
import {returnToSpot} from './m59-skills.mjs';
import {chooseSurvivalDecision} from './m59-survival-decision.mjs';
import {withBodyCommand,withRecoveryCommand,bodyAuthority} from './m59-body-command.mjs';
import {bindPacketScope} from './m59-packet-scope.mjs';
const source=readFileSync(new URL('./m59-game.mjs',import.meta.url),'utf8');
const begin=source.indexOf('const CONCENTRATION_SAFE ='),end=source.indexOf('// ---------------------------------------------------------------- session',begin);
const Pacer=Function('bindPacketScope','PACKETS_PER_SECOND','DOOR_SETTLE_MS','remainingDoorSettle',
 source.slice(begin,end)+'; return Pacer;')(bindPacketScope,5,300,()=>0);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){
 const calls=[],c={state:'game',self:{id:1,row:8,col:16,x:1056,y:544,predicted:false},room:{id:123,objects:new Map()},
  seated:true,stand(){calls.push({kind:'stand',at:Date.now()});this.seated=false;},
  vitals:()=>({health:{value:6,max:20},vigor:{value:200}})};
 const s=Object.assign(Object.create(Session.prototype),{client:c,combatEpoch:0,movementGeneration:0,
  world:{room:{num:39}},need:()=>c,pacer:new Pacer()});
 s.pacer.authority=()=>bodyAuthority(s);
 s.walkTo=async(col,row)=>s.pacer.submit('move',()=>{
  assert.equal(c.seated,false);calls.push({kind:'move',at:Date.now()});Object.assign(c.self,{row,col,x:col*64+32,y:row*64+32});return {arrived:true};
 });
 return {s,c,calls};
}
async function backlog(f,n=30){
 // One read has just consumed a real pacing slot, then thirty are queued.
 await f.s.pacer.submit('read',()=>f.calls.push({kind:'read-first',at:Date.now()}));
 const jobs=Array.from({length:n},()=>f.s.pacer.submit('read',()=>f.calls.push({kind:'read',at:Date.now()})).catch(e=>({error:e.code})));
 return jobs;
}
async function drain(s,jobs){s.pacer.minGapMs=0;s.pacer.wake?.();await Promise.all(jobs);while(s.pacer.running)await pause(1);}
{
 const f=fixture(),jobs=await backlog(f);
 chooseSurvivalDecision(f.s,{source:'travel',strategy:'nearest_refuge',reason:'recorded read backlog under attack'});
 const r=await returnToSpot(f.s,{row:8,col:18},{routeFirst:true});
 assert.equal(r.arrived,true);
 const sent=f.calls.filter(c=>c.kind!=='read-first');
 assert.deepEqual(sent.slice(0,2).map(c=>c.kind),['stand','move'],'the real refuge approach must get past the pending read queue');
 assert(f.calls[1].at-f.calls[0].at>=180,'recovery still waits for the normal five-packet pacing slot');
 assert(f.calls[2].at-f.calls[1].at>=180,'the move retains pacing after stand');
 assert.equal(bodyAuthority(f.s).priority,0,'priority does not leak into later background work');
 await drain(f.s,jobs);
}
{
 const f=fixture(),jobs=await backlog(f,3);
 const r=await returnToSpot(f.s,{row:8,col:18},{routeFirst:true});assert(r.arrived);
 assert.deepEqual(f.calls.slice(1,4).map(c=>c.kind),['read','read','read'],'an ordinary return does not claim emergency priority');
 await drain(f.s,jobs);
}
{
 const f=fixture(),jobs=await backlog(f);
 chooseSurvivalDecision(f.s,{source:'travel',strategy:'nearest_refuge'});
 const pending=returnToSpot(f.s,{row:8,col:18},{routeFirst:true});
 await pause(10);f.s.movementGeneration++;
 const r=await pending;assert(r.cancelled);assert(!f.calls.some(c=>['stand','move'].includes(c.kind)),'a paced recovery cancelled by its movement owner sends nothing');
 await drain(f.s,jobs);
}
{
 const f=fixture(),jobs=await backlog(f);
 const pending=withBodyCommand(f.s,async()=>{
  f.s.combatEpoch++;
  return withRecoveryCommand(f.s,()=>f.s.pacer.submit('rest',()=>f.calls.push({kind:'STALE',at:Date.now()})));
 });
 await assert.rejects(pending,/combat override/,'recovery priority cannot renew an enclosing stale epoch');
 assert(!f.calls.some(c=>c.kind==='STALE'));await drain(f.s,jobs);
}
{
 const f=fixture();f.s.combat={active:{id:'combat'}};
 await assert.rejects(withRecoveryCommand(f.s,()=>f.s.pacer.submit('rest',()=>assert.fail('foreign recovery got combat authority'))),/combat override/);
 assert.equal(withBodyCommand(f.s,()=>withRecoveryCommand(f.s,()=>bodyAuthority(f.s).priority),'combat'),2);
 const other={combatEpoch:0};
 assert.equal(withRecoveryCommand(f.s,()=>bodyAuthority(other).priority),0,'recovery priority is confined to its own Session');
}
{
 const f=fixture();f.s.pacer.holdForCast(10000);
 const held=await withRecoveryCommand(f.s,()=>f.s.pacer.submit('move',()=>assert.fail('concentration guard bypassed')));
 assert(held.held);f.s.pacer.releaseCastHold();
}
console.log('Recovery packet scheduling passes real refuge/stand pacing, read backlog, ordinary return, cancelled movement, stale authority, combat, session isolation and concentration guards.');
