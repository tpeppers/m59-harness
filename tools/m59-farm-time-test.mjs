import assert from'node:assert/strict';import{farmTimeCategory,integrateFarmTimes}from'./m59-farm-time.mjs';
const s={in_game:true,connected:true,room:{num:827},hp:{value:70,max:70},mana:{value:20,max:20},vigor:{value:100},autopilot_status:{ladder:{stage:'passFarm'},activity:'holding a proven safe spot'}};
assert.equal(farmTimeCategory(s).category,'healthy_wait');assert.equal(farmTimeCategory({...s,hp:null}).category,'unknown_or_disconnected');assert.equal(farmTimeCategory({...s,room:{num:1}}).category,'death_recovery');assert.equal(farmTimeCategory({...s,hp:{value:20,max:70}}).category,'recovery');assert.equal(farmTimeCategory(s,{servicePhase:'collect'}).category,'internal_hauling');assert.equal(farmTimeCategory(s,{role:'courier'}).category,'courier_service');assert.deepEqual(integrateFarmTimes({at:1000,category:'recovery'},{at:101000}),{category:'recovery',ms:30000,unknownMs:70000});console.log('PASS recovery/healthy waits/service roles and capped missing-observation gaps');

assert.equal(farmTimeCategory({...s,autopilot_status:{...s.autopilot_status,ladder:{stage:'passFleeAndRest'}}}).category,'healthy_wait','briefly evaluating the survival rung is not observed recovery');
assert.equal(farmTimeCategory({...s,autopilot_status:{...s.autopilot_status,survival_decisions:{current:{strategy:'rest',status:'recovering',ended_at:null}}}}).category,'recovery');

assert.equal(farmTimeCategory({...s,autopilot_status:{...s.autopilot_status,activity:'stationary cargo exchange'}}).category,'exchange','a healthy recipient in a trade is not idle');

assert.equal(farmTimeCategory(s,{servicePhase:'service stalled'}).category,'service_stalled');assert.equal(farmTimeCategory({...s,movement:{order:{kind:'walk'}}},{servicePhase:'service stalled'}).category,'internal_hauling');assert.equal(farmTimeCategory(s,{role:'courier',servicePhase:'needs attention'}).category,'courier_stalled');console.log('PASS ended service stalls are not counted as continuing physical travel');

assert.equal(farmTimeCategory({...s,mana:{value:65,max:25}}).category,'healthy_wait','observed mana above its reported ceiling is still available resource');
assert.equal(farmTimeCategory({...s,mana:null}).category,'other_wait','unknown mana is never evidence of full resources');
console.log('PASS resource-full waits include above-ceiling observed mana and exclude unknown mana');

for(const phase of ['waiting for upper preparation','waiting for safe exchange'])assert.equal(farmTimeCategory(s,{role:'courier',servicePhase:phase}).category,'courier_wait');
console.log('PASS courier town/readiness waits stay separate from physical service and exchange');
