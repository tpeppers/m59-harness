import assert from 'node:assert/strict';
import {confirmedRailBody,createRailObserver,refusedRailWrite} from './m59-rail-observer.mjs';
import {railBoarding,passedRailAim} from './m59-railfollow.mjs';
const s={agent:'a',character:'A',pid:4,in_game:true,room:{num:579,object_id:9},you:{id:7},position_read:{id:7,room_object_id:9,x:96,y:160,row:2,col:1}};
assert(confirmedRailBody(s));
for(const change of [{predicted:true},{id:8},{room_object_id:8},{col:2}])assert.equal(confirmedRailBody({...s,position_read:{...s.position_read,...change}}),null);
let calls=0;const k={agent:'a',character:'A',pid:4,port:1};
const read=createRailObserver({fleet:'shadow',agent:'a',discover:async()=>new Map([['a',k]]),wait:async()=>{},fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>++calls===1?{...s,position_read:null}:s})});
assert.equal((await read()).you.id,7);assert.equal(calls,2);
const bad=createRailObserver({fleet:'shadow',agent:'a',discover:async()=>new Map([['a',k]]),fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>({...s,character:'Other'})})});
await assert.rejects(bad(),/identity changed/);
const legs=[{kind:'walk',waypoints:[{x:0,y:0,f:1000},{x:100,y:0,f:1000}]},{kind:'jump'},{kind:'walk',waypoints:[{x:0,y:0,f:0},{x:100,y:0,f:0}]}];
assert.equal(railBoarding(legs,{x:50,y:0},{floor:0}).leg,2);
assert.equal(railBoarding(legs,{x:50,y:0},{floor:500}),null);
assert.equal(railBoarding(legs,{x:5000,y:0},{floor:0}),null);
console.log('rail observation: ordered own-body proof, transient retry, identity refusal and multi-leg shelf resumption passed');

assert(refusedRailWrite({error:'agent "a" is not in game — call join first'},'a'));
assert(!refusedRailWrite({error:'agent "b" is not in game — call join first'},'a'));
assert(!refusedRailWrite({_error:'timeout'},'a'));
assert(!refusedRailWrite({error:'fetch failed'},'a'));

const adjacent=[{kind:'walk',waypoints:[{x:0,y:0,f:352},{x:100,y:0,f:352}]},{kind:'walk',waypoints:[{x:0,y:10,f:0},{x:100,y:10,f:0}]}];
assert.equal(railBoarding(adjacent,{x:50,y:0},{floor:0,strictFloor:true}).leg,1,'a neighboring stair tread is not the shelf the body reached');

const dense=[{x:0,y:0,f:0},{x:100,y:0,f:0},{x:200,y:0,f:0},{x:300,y:0,f:352}];
assert(passedRailAim({sourceWaypoints:dense},dense[1],{x:200,y:0},{floor:0}));
assert(!passedRailAim({sourceWaypoints:dense},dense[2],{x:100,y:0},{floor:0}));
assert(!passedRailAim({sourceWaypoints:dense},dense[1],{x:200,y:1000},{floor:0}));
assert(!passedRailAim({sourceWaypoints:dense},dense[2],{x:300,y:0},{floor:0}));

{
 const {resumeObservedRailWalk}=await import('./m59-rail-observer.mjs');
 const body={in_game:true,hp:{value:20},room:{num:579,object_id:1552},you:{id:9},position_read:{id:9,room_object_id:1552,x:2513,y:2229,col:39,row:34}};
 let sends=0,reads=0;const initial={reason:'position_confirmation_timeout'};
 const opts={observe:async()=>{reads++;return body;},room:579,owner:'ours',since:100};
 const done=await resumeObservedRailWalk(initial,async()=>{sends++;assert.equal(reads,sends);return {arrived:true};},opts);
 assert(done.arrived);assert.equal(sends,1);
 for(const changed of [{...body,room:{num:826,object_id:1552}},{...body,hp:{value:0}},{...body,position_read:{...body.position_read,predicted:true}},{...body,movement:{last_cancel:{at:101,by:{source:'operator'},by_label:'other'}}}]){
  await assert.rejects(resumeObservedRailWalk(initial,async()=>{throw Error('must not move');},{...opts,observe:async()=>changed}),/recovery_unproved|recovery_cancelled/);
 }
 sends=0;const ambiguous={_error:'timeout'};assert.equal(await resumeObservedRailWalk(ambiguous,async()=>{sends++;},opts),ambiguous);assert.equal(sends,0,'ambiguous transport timeout cannot repeat a write');
 sends=0;await resumeObservedRailWalk(initial,async()=>{sends++;return initial;},opts);assert.equal(sends,3,'confirmation recovery stays bounded');
}

{
 const {waitForConfirmedRailLanding}=await import('./m59-rail-observer.mjs');let tick=0,reads=0;
 const state=(x,y,room=579)=>({in_game:true,hp:{value:20},room:{num:room,object_id:1552},you:{id:9},position_read:{id:9,room_object_id:1552,x,y,col:Math.floor(x/64),row:Math.floor(y/64)}});
 const options={room:579,target:{x:1024,y:1024},floorAt:()=>7040,owner:'ours',since:100,now:()=>tick,wait:async ms=>{tick+=ms;}};
 const landing=state(128,128),start=state(200,128);
 const result=await waitForConfirmedRailLanding({...options,read:async()=>++reads===1?start:landing});
 assert(result.ok);assert.equal(tick,100,'a positively observed landing does not pay a fixed 5.5 second queue delay');
 const changed=await waitForConfirmedRailLanding({...options,read:async()=>state(128,128,826)});assert(!changed.ok);
 tick=0;const timeout=await waitForConfirmedRailLanding({...options,read:async()=>start,timeoutMs:300});assert(!timeout.ok);assert.equal(tick,300);
 await assert.rejects(waitForConfirmedRailLanding({...options,read:async()=>({...landing,movement:{last_cancel:{at:101,by:{source:'operator'},by_label:'other'}}})}),/cancelled/);
}

{
 const {unsentRailJumpRefusal}=await import('./m59-rail-observer.mjs');
 for(const reason of ['object_blocked','fall_blocked_by_body','fall_changed_before_send'])assert(unsentRailJumpRefusal({jumped:false,mover:{moved:false,reason}}));
 for(const r of [{jumped:true,mover:{moved:false,reason:'object_blocked'}},{jumped:false,cancelled:true,mover:{moved:false,reason:'object_blocked'}},{jumped:false,mover:{moved:true,reason:'object_blocked'}},{jumped:false,mover:{moved:false,reason:'geometry_blocked'}},{error:'transport timeout'}])assert.equal(unsentRailJumpRefusal(r),false);
}

{
 let action;
 const read=createRailObserver({fleet:'shadow',agent:'a',discover:async()=>new Map([['a',k]]),fetchImpl:async(_url,opts)=>{
  if(opts?.method==='POST'){action=JSON.parse(opts.body);return{ok:true,headers:new Headers(),json:async()=>({arrived:true})};}
  return{ok:true,headers:new Headers(),json:async()=>s};
 }});
 assert((await read.action('walk_rail',{room:579,leg:{kind:'walk'}})).arrived);
 assert.equal(action.agent,'a');assert.equal(action.character,'A');assert.equal(action.keeper_pid,4);assert.equal(action.name,'walk_rail');
 let writes=0;
 const ambiguous=createRailObserver({fleet:'shadow',agent:'a',discover:async()=>new Map([['a',k]]),fetchImpl:async(_url,opts)=>{
  if(opts?.method==='POST'){writes++;throw Error('timeout');}return{ok:true,headers:new Headers(),json:async()=>s};
 }});
 await assert.rejects(ambiguous.action('walk_rail',{}),/timeout/);assert.equal(writes,1,'an ambiguous native command never repeats');
}


{
 const {waitForRailState,waitForRailGeometry,unsentRailAnimationRefusal}=await import('./m59-rail-observer.mjs');
 const live={...s,hp:{value:20,max:20},connected:true};let tick=0,reads=0;
 const ready=await waitForRailState(async()=>{reads++;return tick<3500?{...live,in_game:false,connected:false,position_read:null}:live;},{fine:false,deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}});
 assert.equal(ready,live);assert.equal(tick,3500);assert.equal(reads,8,'a normal reconnect longer than two seconds is observed without any movement retry');
 tick=0;await assert.rejects(waitForRailState(async()=>({...live,position_read:null}),{deadline:1500,now:()=>tick,wait:async ms=>{tick+=ms;}}),/readiness timed out/);assert.equal(tick,1500,'unconfirmed waiting spends the original caller budget');
 await assert.rejects(waitForRailState(async()=>({...live,hp:{value:0,max:20}}),{deadline:10000,now:()=>0,check:state=>{if(state.hp.value<=0)throw Error('died');}}),/died/);
 tick=0;const body={...live,doors:{settling_until:6845}};
 assert.equal((await waitForRailGeometry(async()=>body,{room:579,deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}})).you.id,body.you.id);assert.equal(tick,6845,'the captured CHANGE_TEXTURE readiness is awaited before attempting another flight');
 tick=0;await assert.rejects(waitForRailGeometry(async()=>body,{room:579,deadline:1000,now:()=>tick,wait:async ms=>{tick+=ms;}}),/wait_exhausted/);assert.equal(tick,1000);
 assert(unsentRailAnimationRefusal({jumped:false,mover:{moved:false,left_room:false,reason:'collision_geometry_changed'}}));
 for(const r of [{jumped:true,mover:{moved:false,reason:'collision_geometry_changed'}},{jumped:false,mover:{moved:true,reason:'collision_geometry_changed'}},{jumped:false,mover:{moved:false,left_room:true,reason:'collision_geometry_changed'}},{jumped:false,cancelled:true,mover:{moved:false,reason:'collision_geometry_changed'}},{error:'timeout'}])assert(!unsentRailAnimationRefusal(r));
 console.log('rail readiness: bounded survival reconnects and captured animation waits retain own-body and explicitly-unsent flight requirements');
}


{
 let tick=0,reads=0;
 const observer=createRailObserver({fleet:'shadow',agent:'a',now:()=>tick,wait:async ms=>{tick+=ms;},discover:async()=>new Map([['a',k]]),fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>{reads++;return tick<3500?{...s,connected:false,position_read:null}:s;}})});
 assert.equal((await observer()).you.id,7);assert.equal(tick,3500);assert.equal(reads,8,'the actual CLI observer retains its living body through the captured reconnect interval');
}


{
 const {readRailMoveCheck,provedRailMove,unsentRailGeometryRefusal}=await import('./m59-rail-observer.mjs');let asked;
 const target={x:3616,y:1632},validation={available:true,moved:true,arrived:true,blocked:false,target};
 const data=await readRailMoveCheck(k,target,{slide:true,fall:true,timedFall:true},{fetchImpl:async(u,options)=>{asked=new URL(u);assert(!options.method||options.method==='GET');return{ok:true,headers:new Headers(),json:async()=>({agent:'a',character:'A',pid:4,validation})};}});
 assert.equal(asked.pathname,'/movecheck');for(const key of ['slide','fall','timed_fall'])assert.equal(asked.searchParams.get(key),'1');assert.equal(asked.searchParams.get('keeper_pid'),'4');assert(provedRailMove(data,target));
 for(const changed of [{moved:false},{arrived:false},{blocked:true},{target:{x:3552,y:1632}}])assert(!provedRailMove({validation:{...validation,...changed}},target));
 await assert.rejects(readRailMoveCheck(k,target,{}, {fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>({character:'Other',validation})})}),/refused/);
 assert(unsentRailGeometryRefusal({jumped:false,mover:{moved:false,left_room:false,reason:'geometry_blocked',validation:{available:true,moved:false}}}));
 for(const r of [{jumped:false,mover:{moved:false,reason:'geometry_blocked'}},{jumped:false,mover:{moved:true,reason:'geometry_blocked',validation:{available:true,moved:false}}},{error:'timeout'}])assert(!unsentRailGeometryRefusal(r));
 console.log('native flight readiness: read-only identity proof requires exact live validation; ambiguous or uncaptured refusals cannot repeat a flight');
}


{
 const {readFileSync}=await import('node:fs'),{runInNewContext}=await import('node:vm');
 const source=readFileSync(new URL('./m59-fineclimb.mjs',import.meta.url),'utf8'),start=source.indexOf('    if(observe){\n      const target=clientToProtocol(declaration.to_fine),probe='),end=source.indexOf("    const j = await call('jump'",start);assert(start>=0&&end>start);
 let probes=0;const code=source.slice(start,end),execute=runInNewContext('(async function(){while(true){'+code+'return true;}})',{observe:async()=>({}),observeRaw:{probeMove:async()=>{probes++;return{};}},clientToProtocol:p=>p,declaration:{to_fine:{x:1,y:2}},provedRailMove:()=>true});
 assert(await execute());assert.equal(probes,1,'the executable CLI branch uses its native observer, retaining methods across the survival-check wrapper');
}


{
 const urls=[];const observer=createRailObserver({fleet:'shadow',agent:'a',discover:async()=>new Map([['a',k]]),fetchImpl:async url=>{urls.push(new URL(url));return{ok:true,headers:new Headers(),json:async()=>s};}});
 await observer();for(let i=0;i<5;i++)await observer.cached();
 assert.equal(urls.filter(u=>u.searchParams.get('position')==='1').length,1,'five queued hints send no ordered game-room reads');
 assert.equal(urls.filter(u=>!u.searchParams.has('position')).length,5);
}

{
 const {createRailDiscovery}=await import('./m59-rail-observer.mjs');let scans=0,release;
 const shared=createRailDiscovery(async({fleet})=>{scans++;await new Promise(r=>release=r);return new Map([['a',{...k,pid:scans,fleet}]]);});
 const calls=Array.from({length:24},()=>shared('shadow'));await Promise.resolve();assert.equal(scans,1,'24 initial observers must not launch 2400 keeper probes');release();
 const maps=await Promise.all(calls);assert(maps.every(m=>m===maps[0]));
 const next=shared('shadow');await Promise.resolve();assert.equal(scans,2,'a later scan must not reuse old process identities');release();assert.equal((await next).get('a').pid,2);
 let attempts=0,clock=0;
 const observer=createRailObserver({agent:'a',fleet:'shadow',discover:async()=>++attempts===1?new Map():new Map([['a',k]]),now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>s})});
 assert.equal((await observer()).you.id,7);assert(attempts>1,'an empty transient scan is retried under the original readiness deadline');
 let absentCalls=0;
 await assert.rejects(createRailObserver({agent:'a',fleet:'shadow',discover:async()=>{absentCalls++;return new Map();},now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async()=>{throw Error('must not fetch unknown keeper');}})(),/keeper absent/);
 assert(absentCalls<=8,'absence cannot cause an unbounded retry or an unaddressed read');
 console.log('cohort discovery: 24 observers share one in-flight scan, later scans refresh PIDs, and transient absence is bounded');
}

{
 let cachedCalls=0,clock=0,writes=0;
 const observer=createRailObserver({agent:'a',fleet:'shadow',discover:async()=>new Map([['a',k]]),now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async(url,options)=>{
  assert(!options.method||options.method==='GET');if(!new URL(url).searchParams.has('position')&&++cachedCalls===1)throw TypeError('fetch failed');return{ok:true,headers:new Headers(),json:async()=>s};}});
 await observer();assert.equal((await observer.cached()).agent,'a');assert.equal(cachedCalls,2,'a failed read retries; no action is dispatched');
 const bad=createRailObserver({agent:'a',fleet:'shadow',discover:async()=>new Map([['a',k]]),fetchImpl:async url=>({ok:true,headers:new Headers(),json:async()=>new URL(url).searchParams.has('position')?s:{...s,pid:99}})});
 await bad();await assert.rejects(bad.cached(),/identity\/read changed/);
 console.log('cached road/queue reads: transient transport failure retries within the original limit; identity changes remain terminal');
}
