import assert from 'node:assert/strict';
import { leasedFleetWalk } from './m59-fleetscript.mjs';
const fixture=()=>{
  let at={ok:true,room:38,health:1,dead:false},held=true;const calls=[];
  const control={check(){if(!held)throw Error('lease lost');},observe:async()=>({...at}),
    route:async to=>({found:true,hops:[{from:38,to}]}),estimate:async()=>({ms:1000}),
    travel:async(to,opts)=>{calls.push({to,opts});at.room=to;return{arrived:true};}};
  return{at,calls,control,lose(){held=false;}};
};
let f=fixture();let result=await leasedFleetWalk({agent:'fixture',to:39,control:f.control});
assert.equal(result.ok,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0].opts.minHealth,1);assert.equal(f.calls[0].opts.budgetMs,180000);
for(const health of [null,.4]){f=fixture();f.at.health=health;result=await leasedFleetWalk({agent:'fixture',to:39,control:f.control});assert.equal(result.ok,false);assert.equal(f.calls.length,0);}
f=fixture();result=await leasedFleetWalk({agent:'fixture',to:599,control:f.control});assert.equal(result.ok,false);assert.equal(f.calls.length,0);
f=fixture();f.control.travel=async()=>{f.calls.push(1);return{arrived:false,reason:'blocked exit'};};
result=await leasedFleetWalk({agent:'fixture',to:39,control:f.control});assert.equal(result.ok,false);assert.match(result.why,/blocked exit/);assert.equal(f.calls.length,1);
f=fixture();f.control.estimate=async()=>{f.lose();return null;};await assert.rejects(leasedFleetWalk({agent:'fixture',to:39,control:f.control}),/lease lost/);assert.equal(f.calls.length,0);
f=fixture();f.control.travel=async()=>{f.lose();return{arrived:true};};await assert.rejects(leasedFleetWalk({agent:'fixture',to:39,control:f.control}),/lease lost/);
await assert.rejects(leasedFleetWalk({agent:'fixture',to:39,control:{}}),/missing leased/);
console.log('Leased FleetScript: shared compiler, health/trap gates, budget, no retry, lost capability: PASS');
