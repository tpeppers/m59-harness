import assert from'node:assert/strict';import{farmObservationDetails,observeFarmHealthCeiling}from'./m59-farm-observation.mjs';
const state=()=>({in_game:true,connected:true,combat_ready:true,room:{num:827},you:{id:1,x:1000,y:1000,predicted:false},hp:{value:75,max:75},mana:{value:21,max:21},vigor:{value:100},autopilot_status:{mode:'farm',activity:'idle',faculties:{work:'keeper',movement:'keeper'},recent:[{at:1,what:'hunt choice',why:'eligible',speech:'secret'}]},objects:[...Array.from({length:12},(_,i)=>({id:10+i,name:'orc',flags:9,x:1000+i,y:1000})),{id:99,name:'Daemon Skeleton',flags:9,x:1192,y:1000}]});
let s=state(),r=farmObservationDetails(s);assert(r.idleCandidate.candidate);assert.equal(r.requestedTargets[0].id,99,'requested target beyond the nearest12 generic bodies is retained');assert.equal(r.requestedTargets[0].distance,3);assert(!JSON.stringify(r).includes('secret'));
for(const change of[s=>s.you.predicted=true,s=>s.combat_ready=false,s=>s.room.num=578,s=>s.hp.value=74,s=>s.mana.value=20,s=>s.vigor.value=69,s=>s.job={busy:true},s=>s.movement={order:{}},s=>s.combat={active:true},s=>s.autopilot_status.cast_rite={active:true},s=>s.autopilot_status.faculties.work={owner:'script',expires_in_ms:1},s=>s.autopilot_status.survival_decisions={current:{status:'recovering',strategy:'logoff_safe'}}]){s=state();change(s);assert(!farmObservationDetails(s).idleCandidate.candidate);}
s=state();s.autopilot_status.survival_decisions={current:{status:'yielded',strategy:'yield_to_controller'}};assert(farmObservationDetails(s).idleCandidate.candidate);
s=state();s.objects[12].x=2000;r=farmObservationDetails(s);assert.equal(r.requestedTargets.length,1);assert(!r.idleCandidate.candidate,'visible far targets are retained without implying a nearby opportunity');
console.log('requested prey beyond nearest12 retained; sampled idle candidates distinguish movement, casting, recovery, predicted positions, protected work and depleted resources without asserting reachability');

s=state();delete s.you.predicted;r=farmObservationDetails(s);assert.equal(r.positionPrediction,'unreported');assert(r.idleCandidate.candidate,'a cached potential candidate is retained without claiming position confirmation');

const history=new Map();assert.equal(observeFarmHealthCeiling(history,{agent:'a',error:'socket offline'}),null);
const sample={agent:'a',pid:12,connectionRevision:1,hp:{value:67,max:67}};
assert.equal(observeFarmHealthCeiling(history,sample).count,1);assert.equal(observeFarmHealthCeiling(history,sample).count,2);
assert.equal(observeFarmHealthCeiling(history,{agent:'a',error:'timeout'}),null);assert.equal(observeFarmHealthCeiling(history,sample).count,1);
assert.equal(observeFarmHealthCeiling(history,{...sample,connectionRevision:2}).count,1);
assert.equal(observeFarmHealthCeiling(history,{...sample,pid:13}).count,1);
console.log('a missing first health sample cannot crash the hour; outages and new sockets/keepers break the ceiling-confirmation streak');

s=state();s.as_of_ms=17;r=farmObservationDetails(s);assert.equal(r.stateAgeMs,17,'native as_of_ms is cache age, not an epoch timestamp');assert(!('stateAsOf' in r));

s=state();s.autopilot_status.survival_decisions={current:{status:'active',strategy:'logoff_safe',ended_at:null}};assert(!farmObservationDetails(s).idleCandidate.candidate,'an actual active keeper recovery is protected work, not an unexplained farming idle');
