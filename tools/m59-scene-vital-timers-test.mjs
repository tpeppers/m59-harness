// Offline native-admin fixture. No broker, Docker, account, or game socket.
import assert from 'node:assert/strict';
import {armPlayerVitalTimers} from './m59-scene-staging.mjs';
const env={M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:'17998'};
const scene={actors:[{key:'self',kind:'player'},{key:'rat',kind:'monster'}]},bindings=new Map([['self',1],['rat',2]]);
function native({hp=15,maxHp=49,mana=10,maxMana=30,healthTimer=null,manaTimer=null,broken=false,missing=false,reject=false}={}){
 const state={hp,maxHp,mana,maxMana,healthTimer,manaTimer},commands=[];
 const dmFn=async cmds=>cmds.map(cmd=>{
  commands.push(cmd);let result='';
  if(cmd==='send object 1 NewHealth'){
   if(reject)return cmd+'\n: Unknown command';
   if(!broken)state.healthTimer=hp===maxHp?null:(hp>0?state.healthTimer??11:null);
  }else if(cmd==='send object 1 NewMana'){
   if(!broken)state.manaTimer=mana===maxMana?null:state.manaTimer??12;
  }else if(cmd==='show object 1'){
   result='OBJECT 1 is CLASS User\n'+(missing?'':
    `piHealth = INT ${hp}\npiMax_Health = INT ${maxHp}\npiMana = INT ${mana}\npiMax_Mana = INT ${maxMana}\n`)+
    `ptHealth = ${state.healthTimer==null?'$ 0':'TIMER '+state.healthTimer}\n`+
    `ptMana = ${state.manaTimer==null?'$ 0':'TIMER '+state.manaTimer}\n`;
  }else if(cmd==='send object 1 GetName')result='RESOURCE 10 == "fixture"';
  else throw Error('Unexpected fixture command: '+cmd);
  return cmd+'\n: '+result;
 }).join('\n');
 return {state,commands,dmFn};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
await test('wounded and mana-depleted loads get normal timers without changing values',async()=>{
 const n=native(),r=await armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn});
 assert.equal(r.ok,true);assert.equal(r.actors[0].health_armed,true);assert.equal(r.actors[0].mana_armed,true);
 assert.equal(n.state.hp,15);assert.equal(n.state.mana,10);
 assert.ok(n.commands.every(c=>!c.includes('object 2')));
 assert.ok(n.commands.every(c=>!c.startsWith('set ')&&!/GainHealth|GainMana|SetPlayerFlag/.test(c)));
});
await test('existing timers retain their identities',async()=>{
 const n=native({healthTimer:81,manaTimer:82});await armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn});
 assert.equal(n.state.healthTimer,81);assert.equal(n.state.manaTimer,82);
});
await test('full-health and full-mana loads need no regeneration timers',async()=>{
 const n=native({hp:49,mana:30,healthTimer:81,manaTimer:82}),r=await armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn});
 assert.equal(r.actors[0].health_needed,false);assert.equal(r.actors[0].mana_needed,false);
 assert.equal(n.state.healthTimer,null);assert.equal(n.state.manaTimer,null);
});
await test('dead characters are not given a health timer',async()=>{
 const n=native({hp:0,mana:30});const r=await armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn});
 assert.equal(r.actors[0].health_needed,false);assert.equal(n.state.healthTimer,null);
});
await test('silent failure to establish required timers rejects release',async()=>{
 const n=native({broken:true});await assert.rejects(()=>armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn}),/did not verify/);
});
await test('missing authoritative vitals cannot certify a release',async()=>{
 const n=native({missing:true});await assert.rejects(()=>armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn}),/lacks authoritative/);
});
await test('server refusal rejects release',async()=>{
 const n=native({reject:true});await assert.rejects(()=>armPlayerVitalTimers(scene,bindings,{env,dmFn:n.dmFn}),/rejected/);
});
await test('missing player binding refuses before sending commands',async()=>{
 const n=native();await assert.rejects(()=>armPlayerVitalTimers(scene,new Map(),{env,dmFn:n.dmFn}),/bindings/);
 assert.equal(n.commands.length,0);
});
await test('monster-only scenes need no player timer calls',async()=>{
 const n=native();await armPlayerVitalTimers({actors:[scene.actors[1]]},bindings,{env,dmFn:n.dmFn});assert.equal(n.commands.length,0);
});
console.log(`${count} player vital timer scenarios passed`);
