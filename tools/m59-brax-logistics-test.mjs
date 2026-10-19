import assert from 'node:assert/strict';import {BRAX_LEDGE,planLedgeRail,runBraxLedgeLeg} from './m59-brax-logistics.mjs';import {roomGeometry,edgeOf} from './m59-ground.mjs';
const g=roomGeometry(578),e=edgeOf(g);
for(const [role,base]of [['farmer',BRAX_LEDGE.cavern],['courier',BRAX_LEDGE.road]])for(const [from,to]of [[base,BRAX_LEDGE[role]],[BRAX_LEDGE[role],base]]){const p=planLedgeRail(from,to,{role});assert(p.waypoints.length);assert(p.waypoints.length<=p.sourceWaypoints.length);if(role==='courier')assert(p.waypoints.length<p.sourceWaypoints.length/2,'proved level chords shorten dense lower route');for(let i=1;i<p.waypoints.length;i++){assert(e(p.waypoints[i-1],p.waypoints[i]));assert(e(p.waypoints[i],p.waypoints[i-1]));}}
assert.throws(()=>planLedgeRail(BRAX_LEDGE.farmer,BRAX_LEDGE.courier,{role:'farmer'}),/outside/);console.log('PASS exact upper/lower service routes and all reverse segments; cross-ledge route refused');

const {script}=await import('./fleetscripts/brax-ledge-leg.mjs');assert.equal(script.mode,'errand');assert.equal((await script.steps({role:'farmer',direction:'out'})).length,1);await assert.rejects(script.steps({role:'bad',direction:'out'}));

// Native rail input must retain the public owner. Only known-ended replies replan.
const origin={source:'fleetscript',name:'ledge-test',run_id:'offline'},ctx={agent:'a',fleet:'shadow',origin,state:{}};
let position={...BRAX_LEDGE.road},posts=0;const state=()=>({room:{num:578},you:{id:1,...position},hp:{value:80,max:80},job:{},movement:{},autopilot_status:{faculties:{movement:{owner:'fleetscript:ledge-test',expires_in_ms:100000}}}});
const observe=async()=>state();observe.action=async(name,args)=>{posts++;assert.deepEqual(args.origin,origin);if(posts===1)throw Error('rail action refused: rail_position_confirmation_timeout');position={...BRAX_LEDGE.courier};return{arrived:true};};
assert.equal((await runBraxLedgeLeg(ctx,{role:'courier',direction:'out',observe})).ok,true);assert.equal(posts,2);
position={...BRAX_LEDGE.road};posts=0;observe.action=async()=>{posts++;throw Error('unknown transport disconnect after POST');};await assert.rejects(runBraxLedgeLeg(ctx,{role:'courier',direction:'out',observe}),/unknown transport/);assert.equal(posts,1);
console.log('PASS public rail origin retained; known-ended confirmation re-observed; ambiguous transport never retried');
