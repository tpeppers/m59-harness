import assert from'node:assert/strict';import{test}from'node:test';import{queuedRoomExit}from'./m59-queued-room-exit.mjs';
const fixture=first=>{const origin={source:'fleetscript',name:'queued-exit-fixture',run_id:'test',at:Date.now()},ctx={fleet:'offline',agent:'actor',state:{},origin};let calls=0,across=false;
 const state=()=>({agent:'actor',character:'Actor',room:{num:across?826:827,object_id:3319},you:{id:7,x:96,y:224,row:3,col:1},hp:{value:75,max:75},movement:{},autopilot_status:{faculties:{movement:{owner:'fleetscript:queued-exit-fixture',expires_in_ms:60000}}}});
 const observe=async()=>state();observe.action=async()=>{calls++;if(calls===1){if(first instanceof Error)throw first;return first;}across=true;return{arrived:true};};return{ctx,observe,calls:()=>calls};};
test('a returned native reconnect error continues only after a fresh owned observation',async()=>{const f=fixture(Error('rail action refused: agent "actor" is not in game — call join first'));assert((await queuedRoomExit(f.ctx,826,{observe:f.observe})).arrived);assert.equal(f.calls(),2);});
test('an explicitly ended position confirmation failure can resume from a fresh body',async()=>{const f=fixture({arrived:false,reason:'position_confirmation_timeout',operationEnded:true});assert((await queuedRoomExit(f.ctx,826,{observe:f.observe})).arrived);assert.equal(f.calls(),2);});
for(const reason of['The operation was aborted due to timeout','rail action refused: agent "someone-else" is not in game — call join first','HTTP connection reset'])test('no retry for '+reason,async()=>{const f=fixture(Error(reason));await assert.rejects(queuedRoomExit(f.ctx,826,{observe:f.observe}));assert.equal(f.calls(),1);});
test('a foreign movement lease ends before any exit action',async()=>{const f=fixture({});const read=f.observe;f.observe=Object.assign(async()=>{const s=await read();s.autopilot_status.faculties.movement.owner='somebody-else';return s;},{action:read.action});await assert.rejects(queuedRoomExit(f.ctx,826,{observe:f.observe}),/owner_changed/);assert.equal(f.calls(),0);});


test('six positively ended confirmation failures stay within the original finite continuation budget',async()=>{const f=fixture({});let calls=0;const original=f.observe.action;f.observe.action=async(...args)=>{calls++;if(calls<=6)return{arrived:false,reason:'position_confirmation_timeout',operationEnded:true};await original(...args);return original(...args);};assert((await queuedRoomExit(f.ctx,826,{observe:f.observe,timeoutMs:30000})).arrived);assert.equal(calls,7);});

for(const startsBeforeAction of[true,false])test('full-health provisioning trip '+(startsBeforeAction?'before action':'refuses unsent action')+' finishes before queue continuation',async()=>{
 const f=fixture({}),read=f.observe,action=f.observe.action;let trip=startsBeforeAction?3:0,first=true,actions=0;
 f.observe=async()=>{const s=await read();if(trip>0){trip--;s.autopilot_status.recovery_travel={id:'native-trip',to:2,origin:{source:'keeper'}};}return s;};
 f.observe.action=async(...args)=>{assert.equal(trip,0,'no commands while keeper trip owns movement');actions++;if(!startsBeforeAction&&first){first=false;trip=3;return{arrived:false,reason:'keeper_recovery_trip_active',trip_id:'native-trip'};}await action(...args);return action(...args);};
 assert((await queuedRoomExit(f.ctx,826,{observe:f.observe,recoveryPollMs:1})).arrived);assert.equal(actions,startsBeforeAction?1:2);
});
test('waiting for a keeper trip never survives a foreign lease takeover',async()=>{
 const f=fixture({}),read=f.observe;let reads=0;
 f.observe=async()=>{const s=await read();s.autopilot_status.recovery_travel={id:'native-trip'};if(++reads>1)s.autopilot_status.faculties.movement.owner='fleetscript:other';return s;};
 await assert.rejects(queuedRoomExit(f.ctx,826,{observe:f.observe,recoveryPollMs:1}),/recovery_owner_changed/);assert.equal(f.calls(),0);
});

test('historical keeper preemption at full health is not an active recovery lock',async()=>{
 const {recoverIslandFineWalk}=await import('./m59-island-finewalk.mjs');const {originLabel}=await import('./m59-move-origin.mjs');const f=fixture({}),s=await f.observe();
 s.movement.last_preempted={at:Date.now(),by:{source:'keeper'},preempted:{kind:'walk',ordered_by:originLabel(f.ctx.origin)}};
 f.ctx.call=async name=>{assert.equal(name,'status','no rest or movement during completed recovery');return s;};
 assert.equal(await recoverIslandFineWalk(f.ctx,{deadline:Date.now()+1000,since:Date.now()-100,initial:s,active:true,read:async()=>({l:s}),pollMs:1,allowRecoveryRoomChanges:true}),true);
});

test('a foreign lease acquired while the worker plans prevents the actual movement send',async()=>{
 const f=fixture({}),read=f.observe;let reads=0;f.observe=Object.assign(async()=>{const s=await read();if(++reads>1)s.autopilot_status.faculties.movement.owner='fleetscript:other';return s;},{action:read.action});await assert.rejects(queuedRoomExit(f.ctx,826,{observe:f.observe}),/owner_changed/);assert.equal(f.calls(),0);
});
