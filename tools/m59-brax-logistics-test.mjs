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

// Captured actual corner/interpolation refusal: retain the lock and use one dense continuation.
position={x:2098,y:2051};posts=0;observe.action=async(name,args)=>{posts++;if(posts===1)throw Error('rail action refused: movement_region: segment leaves returnable component');assert.equal(args.bodyDetour,false);assert.equal(args.leg.waypoints.length,args.leg.sourceWaypoints.length);position={...BRAX_LEDGE.courier};return{arrived:true};};assert((await runBraxLedgeLeg(ctx,{role:'courier',direction:'out',observe})).ok);assert.equal(posts,2);
position={...BRAX_LEDGE.road};posts=0;observe.action=async()=>{posts++;throw Error('rail action refused: movement_region: segment leaves returnable component');};await assert.rejects(runBraxLedgeLeg(ctx,{role:'courier',direction:'out',observe}),/boundary guard refused/);assert.equal(posts,2,'a second guard refusal must stop rather than repeat a failing route');
console.log('PASS observed safe body may switch once to dense guarded rail; repeated boundary refusal stops');

const {clearBraxLanding}=await import('./m59-brax-logistics.mjs');let lp={id:1,x:160,y:352},landingPosts=0;const lo=async()=>({...state(),room:{num:827},you:{...lp},objects:[{id:2,x:160,y:352,flags:5}]});lo.action=async(name,args)=>{landingPosts++;assert.equal(args.room,827);assert.equal(args.bodyDetour,false);const end=args.leg.waypoints.at(-1);lp={id:1,x:end.x/16+64,y:end.y/16+64};return{arrived:true};};assert((await clearBraxLanding(ctx,lo)).cleared);assert.equal(landingPosts,1);assert(Math.hypot(lp.x-160,lp.y-352)>=28);console.log('PASS returning farmer clears its own crowded landing on bidirectionally proved native terrain');
