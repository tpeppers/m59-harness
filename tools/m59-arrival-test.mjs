import assert from 'node:assert/strict';
import {arrivalOptions,estimateRoute,transitEvidence} from './m59-arrival-model.mjs';
import {loadMap} from './m59-map.mjs';
import {predictedRescueRoom} from './m59-rescue.mjs';
import {affordableRescue,rescueTravelPolicy} from './m59-rescue-travel.mjs';
const map=loadMap();
const one=estimateRoute([{kind:'chalice',action_ms:0}]);assert(Math.abs(one.p90_ms-23963)<400);
const two=estimateRoute([{kind:'chalice',action_ms:0},{kind:'chalice',action_ms:0}]);assert(Math.abs(two.p90_ms-45454)<700);assert(two.p90_ms<2*one.p90_ms);
const args={map,from:39,to:202,guildHall:714,homeRoom:202,methods:[{kind:'chalice',uses:2}],staging:false};
const options=arrivalOptions(args);assert(options.some(p=>p.legs.filter(l=>l.kind==='chalice').length===2));
assert(!arrivalOptions({...args,methods:[{kind:'chalice',uses:1}]}).some(p=>p.legs.filter(l=>l.kind==='chalice').length===2));
assert(!arrivalOptions({...args,homeRoom:null}).some(p=>p.legs.filter(l=>l.kind==='chalice').length===2));
assert(!arrivalOptions({...args,blocked:[714]}).some(p=>p.legs.some(l=>l.kind==='chalice')));
assert(!arrivalOptions({...args,confine:[39,202]}).some(p=>p.legs.some(l=>l.kind==='chalice')));
const island=arrivalOptions({...args,from:2500,to:2001});assert(island.some(p=>p.legs.filter(l=>l.kind==='chalice').map(l=>l.to).join(',')==='2510,2001'));
assert.equal(predictedRescueRoom(714,{guildHall:714,homeRoom:202}),202);
const e=transitEvidence([{transits:[{at:1,room:39,to:2,ok:true,ms:1},{at:3,room:39,to:2,ok:false,ms:100}]}],{since:2});assert.equal(e.get('39>2').times.length,0);assert.equal(e.get('39>2').failed,1);
assert.equal(estimateRoute([{kind:'walk',hops:[{from:39,to:2}]}],e,{fallbackMs:30000}).p90_ms,30000);
const c={spells:[{id:1,name:'rescue'}],inventory:[{name:'emerald',amount:2}],stat:()=>({value:30}),vitals:()=>({mana:{value:32}})};assert.equal(affordableRescue(c,2).uses,2);assert.equal(affordableRescue({...c,stat:()=>({value:-50})}),null);assert.equal(affordableRescue({...c,stat:()=>null}),null);
console.log('Arrival model: timer distributions, chained destinations, resource limits, missing hometown, bans, confinement, epoch exclusion and karma passed.');

const policy=await rescueTravelPolicy({character:'test'},{loaded:{strategies:[{name:'fixture',enabled:true,rescueTravel:()=>({enabled:true,double:true})}]}});assert.equal(policy.enabled,true);assert.equal(policy.double,true);

assert.equal(predictedRescueRoom(59,{guildHall:714,homeRoom:202}),2001);assert.equal(predictedRescueRoom(2001,{guildHall:705,homeRoom:202}),705);assert.equal(predictedRescueRoom(705,{guildHall:705,homeRoom:202}),2001);

assert.equal(arrivalOptions({...args,from:202,overheadMs:5000})[0].p90_ms,0);
