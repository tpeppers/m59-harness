import assert from 'node:assert/strict';import {BRAX_LEDGE,planLedgeRail} from './m59-brax-logistics.mjs';import {roomGeometry,edgeOf} from './m59-ground.mjs';
const g=roomGeometry(578),e=edgeOf(g);
for(const [role,base]of [['farmer',BRAX_LEDGE.cavern],['courier',BRAX_LEDGE.road]])for(const [from,to]of [[base,BRAX_LEDGE[role]],[BRAX_LEDGE[role],base]]){const p=planLedgeRail(from,to,{role});assert(p.waypoints.length);assert(p.waypoints.length<=p.sourceWaypoints.length);if(role==='courier')assert(p.waypoints.length<p.sourceWaypoints.length/2,'proved level chords shorten dense lower route');for(let i=1;i<p.waypoints.length;i++){assert(e(p.waypoints[i-1],p.waypoints[i]));assert(e(p.waypoints[i],p.waypoints[i-1]));}}
assert.throws(()=>planLedgeRail(BRAX_LEDGE.farmer,BRAX_LEDGE.courier,{role:'farmer'}),/outside/);console.log('PASS exact upper/lower service routes and all reverse segments; cross-ledge route refused');

const {script}=await import('./fleetscripts/brax-ledge-leg.mjs');assert.equal(script.mode,'errand');assert.equal((await script.steps({role:'farmer',direction:'out'})).length,1);await assert.rejects(script.steps({role:'bad',direction:'out'}));
