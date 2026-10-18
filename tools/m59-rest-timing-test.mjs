import assert from'node:assert/strict';import{restUntil,normalizeRestTargets}from'./m59-skills.mjs';
async function run({healthAt=()=>12,manaAt=()=>10,health=.9,mana=0,vigor=.4,maxSeconds=90,events=[]}={}){let clock=0,stands=0;const c={evSeq:1,events,vitals:()=>({health:{value:healthAt(clock),max:20},mana:{value:manaAt(clock),max:20},vigor:{value:80,scale_max:200}}),stats:async()=>{},waitFor:async()=>{},rest:async()=>{},stand:async()=>{stands++;}};const s={need:()=>c,pacer:{submit:async(_k,f)=>f()}};const result=await restUntil(s,{health,mana,vigor,maxSeconds,now:()=>clock,wait:async ms=>{clock+=ms;}});assert.equal(stands,1);return result;}
const slow=await run({healthAt:t=>t>=60000?20:12});assert.equal(slow.reached_target,true);assert.equal(slow.seconds,60);
const mana=await run({health:0,mana:.9,manaAt:t=>t>=60000?20:10});assert.equal(mana.reached_target,true);
const ceiling=await run({health:0,vigor:1});assert(ceiling.seconds<=15);assert.equal(ceiling.reached_target,false);
const blocked=await run();assert(blocked.seconds>=65&&blocked.seconds<=72);assert.equal(blocked.reached_target,false);
const bounded=await run({maxSeconds:15});assert.equal(bounded.seconds,15);
const damage=await run({healthAt:t=>t>=6000?11:12});assert(damage.interrupted);assert(damage.seconds<=6);
console.log('6 ordinary rest timing cases pass: 60s HP/mana ticks, vigor ceiling, genuine stall, deadline, damage');

const defaults=normalizeRestTargets();assert.equal(defaults.vigor,0.4);assert.equal(defaults.mana,0);assert.equal(normalizeRestTargets({vigor:80,mana:.8}).vigor,0.4);assert.equal(normalizeRestTargets({vigor:.4,mana:.8}).mana,.8);assert.equal(normalizeRestTargets({to_vigor:60,to_mana:.75}).vigor,.3);assert.equal(normalizeRestTargets({vigor:NaN}).vigor,.4);console.log('native rest boundary accepts absolute80 or fractional0.4 vigor and preserves requested mana');
