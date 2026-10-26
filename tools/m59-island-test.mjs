// Offline safety and recovery checks for the cave route and the island chalice.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cupIsFull,guardCategory,jungleStashPlan,islandRideRecovery,withStashLease,inventoryUnits,prepareIslandSip,rideIslandCup,drinkPoolOfVigor,inPool} from './m59-island-chalice.mjs';
import {ordinaryHop,readIslandJourney,withIslandSafeLegs,ISLAND_SAFE_LEGS,foreignIslandDestination,prepareIslandDeparture,reportIslandOutbound,waitIslandOutbound,releaseIslandWave} from './m59-island-route.mjs';
import {shelteredIslandAim,eatIslandAtWall,recoverIslandFineWalk,activeOwnedFineRecovery,checkIslandCancellation,islandFineStepBudget,bindIslandFinePosition,confirmIslandFineArrival,islandTrafficRefusal,cutIslandRail} from './m59-island-finewalk.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {chordWalkable,cutRail} from './m59-railcut.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {doorStates} from './m59-doorbake.mjs';
import {observeIslandTraveller,islandReadOwner,withIslandObservationDeadline} from './m59-island-observation.mjs';
import {shadowDispelResetTimers,shadowDispelIdentityMatches} from './m59-island-lab-dispel.mjs';
assert.deepEqual(shadowDispelResetTimers('Timer Remaining ms Object Message\n123 10000 1667 ReplaceIllusions\n124 20000 1667 ReplaceIllusions\n125 5000 1667 GenerateMonster\n126 5000 99 ReplaceIllusions',1667),[123,124]);
assert.throws(()=>shadowDispelResetTimers('',null),/room_unconfirmed/);
const isolatedDispelState=join(tmpdir(),'island20.json'),dispelHealth={fleet:'island20',state:isolatedDispelState,game_server:{host:'127.0.0.1',port:15959}},dispelEnv={M59_FLEET:'island20',M59_ADMIN_PORT:'19998'};
assert(shadowDispelIdentityMatches(dispelHealth,{fleet:'island20',stateFile:isolatedDispelState},dispelEnv));
assert(!shadowDispelIdentityMatches(dispelHealth,{fleet:'island20'},dispelEnv));
assert(!shadowDispelIdentityMatches({...dispelHealth,fleet:'prod'},{fleet:'prod',stateFile:isolatedDispelState},{...dispelEnv,M59_FLEET:'prod'}));
assert(!shadowDispelIdentityMatches({...dispelHealth,state:join(tmpdir(),'other.json')},{fleet:'island20',stateFile:isolatedDispelState},dispelEnv));
assert(!shadowDispelIdentityMatches({...dispelHealth,game_server:{host:'remote',port:15959}},{fleet:'island20',stateFile:isolatedDispelState},dispelEnv));
const customDispel={fleet:'island20',stateFile:isolatedDispelState,gamePort:16959,adminPort:19997};
const customDispelHealth={...dispelHealth,game_server:{host:'127.0.0.1',port:16959}};
const customDispelEnv={...dispelEnv,M59_PORT:'16959',M59_ADMIN_PORT:'19997'};
assert(shadowDispelIdentityMatches(customDispelHealth,customDispel,customDispelEnv));
for(const [h,o,e] of [[dispelHealth,customDispel,customDispelEnv],[customDispelHealth,{...customDispel,stateFile:null},customDispelEnv],
 [customDispelHealth,customDispel,dispelEnv],[customDispelHealth,{...customDispel,gamePort:5959},customDispelEnv],
 [customDispelHealth,{...customDispel,adminPort:16959},customDispelEnv],[customDispelHealth,{...customDispel,adminPort:0},customDispelEnv]])
 assert(!shadowDispelIdentityMatches(h,o,e),'a custom lab endpoint must be explicit and match its exact roster and ports');
const sectors=JSON.parse(readFileSync(new URL('../substrate/m59-variable-sectors.json',import.meta.url))).rooms.find(r=>r.room===27);
// Live ledge stop: nearest rounded seed is across collision, but a nearby seed
// on the same floor has a fully proved connection and reaches the takeoff.
const ledgeGeo=roomGeometry(2502),ledgeBody=protocolToClient({x:3413,y:2878}),ledgeGoal=protocolToClient({x:2201,y:2650});
const ledgeOptions={edge:(a,b)=>ledgeGeo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true,bounds:{w:ledgeGeo.cols*1024,h:ledgeGeo.rows*1024},floorAt:(x,y)=>floorAt(ledgeGeo,x,y),lattice:128};
assert.equal(cutRail(ledgeBody,ledgeGoal,{...ledgeOptions,alternateSeeds:false}).bridgeOk,false);
const ledgeCut=cutIslandRail(ledgeBody,ledgeGoal,ledgeOptions);
assert(ledgeCut.ok&&ledgeCut.bridgeOk&&ledgeCut.alternateSeed);
assert(chordWalkable(ledgeBody,ledgeCut.waypoints[1],ledgeOptions).ok);
assert.equal(floorAt(ledgeGeo,ledgeCut.waypoints[1].x,ledgeCut.waypoints[1].y),floorAt(ledgeGeo,ledgeBody.x,ledgeBody.y));
assert.equal(cutIslandRail({x:32,y:32},{x:512,y:512},{edge:()=>false,bounds:{w:1024,h:1024},lattice:128}).ok,false);
const waveOrigin={source:'fleetscript',name:'wave-test',run_id:'outbound'};
const waveA={agent:'a',fleet:'fixture',origin:waveOrigin,state:{islandOutboundComplete:true}};
const waveB={agent:'b',fleet:'fixture',origin:waveOrigin,state:{}};
reportIslandOutbound(waveA,['a','b'],true);
let turned=false;
const waveWait=waitIslandOutbound(waveA,['a','b'],{pollMs:1,budgetMs:1000,read:async()=>({room:{num:2000},hp:{value:20,max:20}})}).then(r=>{turned=true;return r;});
await new Promise(r=>setTimeout(r,5));assert.equal(turned,false);
releaseIslandWave(waveB,['a','b']);
assert.deepEqual((await waveWait).outbound_failed,['b']);
releaseIslandWave(waveA,['a','b']);
waveA.origin={...waveOrigin,run_id:'health'};waveB.origin=waveA.origin;
reportIslandOutbound(waveA,['a','b'],true);
let waveReads=0;
await assert.rejects(waitIslandOutbound(waveA,['a','b'],{pollMs:1,budgetMs:1000,read:async()=>({room:{num:2000},hp:{value:19,max:++waveReads===1?20:19}})}),/lost_max_health/);
releaseIslandWave(waveA,['a','b']);releaseIslandWave(waveB,['a','b']);
const open=doorStates(sectors,{includeRisk:true}).find(state=>state.length===5&&state.every(s=>s.height===24));
assert(open);assert.deepEqual(open.map(s=>s.sector),[1,2,3,4,5]);
assert(!doorStates(sectors).some(state=>state.length===5));
const routes=JSON.parse(readFileSync(new URL('../substrate/m59-routes.json',import.meta.url)));
assert(routes.rooms['27'].stepMaskVariants['sector1@24+sector2@24+sector3@24+sector4@24+sector5@24']);
assert(cupIsFull('It is filled to the brim with pure water.'));
assert(!cupIsFull('It is nearly full.'));assert(!cupIsFull('It is empty.'));
assert.equal(inventoryUnits([{name:'herb',amount:10},{name:'herb',amount:5}],{name:'herb',amount:5}),15);
assert.equal(inventoryUnits([{name:'herb',amount:15}],{name:'herb',amount:5}),15);
assert.equal(inventoryUnits([{name:'Sword'},{name:'Sword'}],{name:'Sword'}),2);
for(const chain of [['BlackDagger','Weapon'],['Torch','Shield'],['Robe','Armor'],['LightRobe','Armor'],['Circlet','Helmet'],['IvyCirclet','Helmet']])assert.equal(guardCategory(chain),null);
assert.equal(guardCategory(['NeruditeOreChunk','NumberItem']),'forbidden');assert.equal(guardCategory(['Wine'],true),'forbidden');
const swords=Array.from({length:6},(_,i)=>({id:i+1,name:'Sword'}));
const plan=jungleStashPlan(swords,{equipped:[swords[5]],classify:()=> 'weapon'});
assert.equal(plan.drop.length,4);assert(plan.keep.some(i=>i.id===6));assert(!plan.drop.some(i=>i.id===6));
assert.equal(jungleStashPlan([{id:1,name:'unidentified object'}],{classify:()=> 'unknown'}).drop.length,1);
assert.equal(islandRideRecovery({sips:[{}]},2510),'second_sip');
assert.equal(islandRideRecovery({sips:[]},2500),'not_started');
assert.equal(islandRideRecovery({sips:[],stash:{}},2013),'unobserved');
let sipWalks=0,sipReads=0;
await prepareIslandSip({agent:'fixture',call:async(name,args)=>{
 if(name==='safe_spots')return {room:{num:2500},in_a_safe_spot_now:{works:++sipReads>1},spots:[{row:42,col:38,can_reach_you:0,distance:1}]};
 if(name==='walk_to'){sipWalks++;assert.equal(args.row,42);assert.equal(args.col,38);}
 if(name==='look')return {room:{num:2500},you:{row:42,col:38},hp:{value:20,max:20}};
 return {};
}},{},()=>{});
assert.equal(sipWalks,1);
await assert.rejects(prepareIslandSip({agent:'fixture',call:async name=>name==='look'?{room:{num:2500},hp:{value:20,max:20}}:{in_a_safe_spot_now:{works:false},spots:[]}},{},()=>{}),/reachable_safe_wall/);
await assert.rejects(prepareIslandSip({agent:'fixture',call:async()=>({room:{num:2500},hp:{value:19,max:20}})},{},()=>{}),/departure_health/);
assert.equal(islandRideRecovery({sips:[{},{}]},2001),'refill');
assert.equal(islandRideRecovery({sips:[{},{}]},2008),'refill');
assert.equal(islandRideRecovery({sips:[{},{}]},2510),'unobserved');
assert.equal(islandRideRecovery({sips:[{}]},2500),'unobserved');
const dir=mkdtempSync(join(tmpdir(),'m59-island-test-'));
try{
 const make=agent=>{const r={agent,receipt:join(dir,agent+'.json'),stash:{items:[]},complete:false};writeFileSync(r.receipt,JSON.stringify(r));return r;};
 const a=make('a'),b=make('b'),order=[];
 const first=withStashLease({agent:'a'},a,async()=>{order.push('a-start');await new Promise(r=>setTimeout(r,100));order.push('a-end');});
 const second=withStashLease({agent:'b'},b,async()=>{order.push('b-start');});
 await Promise.all([first,second]);assert.deepEqual(order,['a-start','a-end','b-start']);assert(!existsSync(join(dir,'refill.lock')));
 a.stash.items=[{dropped:true,recovered:false}];writeFileSync(a.receipt,JSON.stringify(a));
 await assert.rejects(withStashLease({agent:'a'},a,async()=>{throw Error('interrupted');}),/interrupted/);
 assert(existsSync(join(dir,'refill.lock')));
 await assert.rejects(withStashLease({agent:'b'},b,async()=>{}),/unrecovered_stash_a/);
 await withStashLease({agent:'a'},a,async()=>{a.stash.items[0].recovered=true;});assert(!existsSync(join(dir,'refill.lock')));
 // A twenty-body convoy can queue longer than the former fifteen-minute cap.
 const longA=make('long-a'),longB=make('long-b');let clock=0,waits=0,release;
 const holding=withStashLease({agent:'long-a'},longA,async()=>new Promise(r=>{release=r;}));
 await withStashLease({agent:'long-b'},longB,async()=>{}, {now:()=>clock,wait:async()=>{
  clock+=1000000;if(++waits===2){release();await holding;}
 }});
 await holding;assert.equal(waits,2);assert(clock>900000);assert(!existsSync(join(dir,'refill.lock')));
 const shortA=make('short-a'),shortB=make('short-b');clock=0;
 const shortHold=withStashLease({agent:'short-a'},shortA,async()=>new Promise(r=>{release=r;}));
 try{await assert.rejects(withStashLease({agent:'short-b'},shortB,async()=>assert.fail('expired queue entered'),
  {budgetMs:1000,now:()=>clock,wait:async()=>{clock+=1500;}}),/refill_queue_budget/);}
 finally{release();await shortHold;}
 await assert.rejects(withStashLease({agent:'long-a'},longA,async()=>{}, {budgetMs:0}),/invalid_refill_queue_budget/);
 await assert.rejects(rideIslandCup({agent:'invalid',call:()=>assert.fail('invalid budget mutated the body')},{queueBudgetMs:-1}),/invalid_refill_queue_budget/);
}finally{rmSync(dir,{recursive:true,force:true});}
const look=(room,hp=20,max=20)=>({room:{num:room},you:{row:4,col:40,x:2592,y:288},hp:{value:hp,max}});
const heldOrigin={source:'fleetscript',name:'fixture',run_id:'current'},heldStatus={autopilot_status:{faculties:{movement:{owner:'fleetscript:fixture',expires_in_ms:5000}}}};
assert(islandReadOwner({origin:heldOrigin},heldStatus));
assert(!islandReadOwner({origin:heldOrigin},{autopilot_status:{faculties:{movement:{owner:'fleetscript:other',expires_in_ms:5000}}}}));
assert(!islandReadOwner({origin:heldOrigin},{autopilot_status:{faculties:{movement:{owner:'fleetscript:fixture',expires_in_ms:0}}}}));
assert(!islandReadOwner({origin:heldOrigin},{autopilot_status:{faculties:{movement:{owner:'fleetscript:other',expires_in_ms:5000}}},
 movement:{last_preempted:{by:{source:'keeper'},preempted:{ordered_by:'fleetscript:fixture#current'}}}}),
 'a stale preemption cannot overrule a live foreign movement lease');
let heldReads=0;
const heldCtx={agent:'fixture',origin:heldOrigin,state:{islandCancelFence:100},call:async()=>heldStatus};
assert.equal((await observeIslandTraveller(heldCtx,async()=>++heldReads<3?{hp:null}:look(2502),{pollMs:0})).room.num,2502);assert.equal(heldReads,3);
await assert.rejects(observeIslandTraveller({...heldCtx,call:async()=>({})},async()=>({hp:null}),{pollMs:0}),/health_unreadable/);
assert.equal(heldCtx.state.islandObservationFailure.owner_proved,false);
assert.equal(heldCtx.state.islandObservationFailure.reason,'traveller_health_unreadable');
await assert.rejects(observeIslandTraveller(heldCtx,async()=>({hp:null}),{deadline:0}),/recovery_budget/);
assert.equal(heldCtx.state.islandObservationFailure.owner_proved,true);
assert.equal(heldCtx.state.islandObservationFailure.reason,'traveller_health_unreadable_recovery_budget');
await assert.rejects(observeIslandTraveller(heldCtx,async()=>look(1)),/traveller_died/);
await assert.rejects(observeIslandTraveller({...heldCtx,call:async()=>({...heldStatus,movement:{last_cancel:{at:101,by:{source:'operator'},by_label:'operator:new-order'}}})},async()=>({hp:null})),/cancelled_by_operator/);
let fineRecoveryReads=0;
const confirmedFine=await observeIslandTraveller(heldCtx,async()=>({body:look(2502),position:{fresh:++fineRecoveryReads>1},snapshot:heldStatus}),
 {bodyOf:v=>v.body,statusOf:v=>v.snapshot,valid:v=>v.position.fresh===true,pollMs:0});
assert.equal(confirmedFine.position.fresh,true);assert.equal(fineRecoveryReads,2);
let leaseReads=0,bodyReads=0;
await assert.rejects(observeIslandTraveller({...heldCtx,call:async()=>++leaseReads===1?heldStatus:{}},async()=>++bodyReads===1?{hp:null}:look(2502),{pollMs:0}),/health_unreadable/);
let transportReads=0;
assert.equal((await observeIslandTraveller(heldCtx,async()=>{if(++transportReads===1)throw Error('fetch failed');return look(2502);},{pollMs:0})).room.num,2502);
await assert.rejects(observeIslandTraveller(heldCtx,async()=>{throw Error('island_keeper_identity_mismatch');}),/identity_mismatch/);
await assert.rejects(withIslandObservationDeadline(heldCtx,0,()=>observeIslandTraveller(heldCtx,async()=>({hp:null}))),/recovery_budget/,
 'an unconfirmed response cannot renew an already expired leg');
await assert.rejects(withIslandObservationDeadline(heldCtx,0,()=>withIslandObservationDeadline(heldCtx,Date.now()+60000,
 ()=>observeIslandTraveller(heldCtx,async()=>({hp:null})))),/recovery_budget/,'nested reads cannot extend the original deadline');
await assert.rejects(withIslandObservationDeadline(heldCtx,0,()=>observeIslandTraveller(heldCtx,async()=>({hp:null}),
 {deadline:Date.now()+60000})),/recovery_budget/,'an explicit nested confirmation deadline also cannot extend its parent');
const otherContext={...heldCtx,state:{}};
let scopedOtherReads=0;
assert.equal((await withIslandObservationDeadline(heldCtx,0,()=>observeIslandTraveller(otherContext,async()=>++scopedOtherReads<2?{hp:null}:look(2502),{pollMs:0}))).room.num,2502,
 'another context does not inherit an expired deadline');
await assert.rejects(withIslandObservationDeadline(heldCtx,Date.now()+60000,()=>observeIslandTraveller(heldCtx,async()=>look(1))),/traveller_died/);
await assert.rejects(withIslandObservationDeadline(heldCtx,Date.now()+60000,()=>observeIslandTraveller({...heldCtx,call:async()=>({})},async()=>({hp:null}))),/health_unreadable/);
assert.throws(()=>withIslandObservationDeadline(heldCtx,Infinity,()=>{}),/finite/);
const realObservationNow=Date.now;let observationClock=realObservationNow();
try{
 Date.now=()=>observationClock;
 const began=observationClock;
 await assert.rejects(withIslandObservationDeadline(heldCtx,began+60000,()=>observeIslandTraveller(heldCtx,async()=>({hp:null}),{
  pollMs:1000,sleep:async()=>{observationClock+=2000;}})),/recovery_budget/);
 assert(observationClock-began>=15000&&observationClock-began<20000,'unknown health retains its short bound inside a longer owned leg');
 for(const unavailable of [{...heldStatus,connected:false},{...heldStatus,broker_error:'temporary keeper read error'}]){
  const start=observationClock;
  await assert.rejects(withIslandObservationDeadline(heldCtx,start+60000,()=>observeIslandTraveller(heldCtx,
   async()=>({body:look(2502),snapshot:unavailable}),{valid:()=>false,bodyOf:v=>v.body,statusOf:v=>v.snapshot,
    pollMs:1000,sleep:async()=>{observationClock+=2000;}})),/recovery_budget/);
  assert(observationClock-start>=15000&&observationClock-start<20000,'disconnected or erroneous snapshots do not extend a cached healthy body');
 }
 const foreign={autopilot_status:{faculties:{movement:{owner:'fleetscript:other',expires_in_ms:60000}}}};
 await assert.rejects(withIslandObservationDeadline(heldCtx,observationClock+60000,()=>observeIslandTraveller(heldCtx,
  async()=>({body:{hp:null},snapshot:foreign}),{bodyOf:v=>v.body,statusOf:v=>v.snapshot})),/health_unreadable/);
 const cancelledStatus={...heldStatus,movement:{last_cancel:{at:101,by:{source:'operator'},by_label:'operator:new-order'}}};
 await assert.rejects(withIslandObservationDeadline(heldCtx,observationClock+60000,()=>observeIslandTraveller(heldCtx,
  async()=>({body:{hp:null},snapshot:cancelledStatus}),{bodyOf:v=>v.body,statusOf:v=>v.snapshot})),/cancelled_by_operator/);
}finally{Date.now=realObservationNow;}
let reconnectReads=0;
const reconnectCtx={agent:'fixture',call:async name=>name==='look'?(++reconnectReads<3?{hp:null}:look(2500,13)):{movement:{last_preempted:{by:{source:'keeper'},preempted:{to:2501,ordered_by:'our-order'}}}}};
assert.equal((await readIslandJourney(reconnectCtx,{to:2501,orderedBy:'our-order',pollMs:0})).hp.value,13);
assert.equal(reconnectReads,3);
reconnectReads=0;await assert.rejects(readIslandJourney(reconnectCtx,{to:2501,orderedBy:'another-order',pollMs:0}),/health_unreadable/);
reconnectReads=0;await assert.rejects(readIslandJourney(reconnectCtx,{to:2502,orderedBy:'our-order',pollMs:0}),/health_unreadable/);
reconnectReads=0;await assert.rejects(readIslandJourney(reconnectCtx,{to:2501,orderedBy:'our-order',deadline:0,pollMs:0}),/reconnect_budget/);
let nestedReads=0;
const nested=await readIslandJourney({agent:'fixture',call:async name=>name==='look'?(++nestedReads<2?{hp:null}:look(2504,6)):
 {movement:{last_preempted:{by:{source:'keeper'},preempted:{to:'refuge',ordered_by:'keeper:safe_spot'}}},
  autopilot_status:{suspended_journey:{to:2505,ordered_by:'our-order'}}}},{to:2505,orderedBy:'our-order',pollMs:0});
assert.equal(nested.hp.value,6);assert.equal(nestedReads,2);
const fine={ok:true,fresh:true,room:2502,protocol:{x:2201,y:2650},square:{row:41,col:34}};
assert.deepEqual(bindIslandFinePosition(look(2502),fine).you,{row:41,col:34,x:2201,y:2650});
assert.throws(()=>bindIslandFinePosition(look(2502),{...fine,fresh:false}),/unconfirmed/);
assert.throws(()=>bindIslandFinePosition(look(2501),fine),/unconfirmed/);
let departureCalls=0;
// 80 TO EMBARK (operator 2026-10-26): 79 is refused, 80 sets out -- resting alone reaches 80.
await assert.rejects(prepareIslandDeparture({agent:'fixture',call:async()=>{departureCalls++;}}, {...look(27),vigor:{value:79}}),/requires_food_and_vigor_80/);
assert.equal((await prepareIslandDeparture({agent:'fixture',call:async()=>{departureCalls++;}}, {...look(27),vigor:{value:80}})).vigor.value,80);
assert.equal(departureCalls,0);
await assert.rejects(prepareIslandDeparture({agent:'fixture',call:async()=>{departureCalls++;}}, {...look(2000,19,19),vigor:{value:80}}),/max_health_floor/);
assert.equal(departureCalls,0);
let departureVigor=70,departureRests=0;
const departure=await prepareIslandDeparture({agent:'fixture',call:async name=>{
 if(name==='rest_up'){departureRests++;departureVigor=180;return {};}
 if(name==='look')return {...look(2000),vigor:{value:departureVigor}};throw Error(name);
}}, {...look(2000),vigor:{value:70}});
assert.equal(departureRests,1);assert.equal(departure.vigor.value,180);
const cancellationCtx={state:{islandCancelFence:100},origin:{source:'fleetscript',name:'fixture'}};
assert.throws(()=>checkIslandCancellation(cancellationCtx,{movement:{last_cancel:{at:101,by:{source:'operator'},by_label:'operator:stop'}}}),/cancelled_by_operator/);
checkIslandCancellation(cancellationCtx,{movement:{last_cancel:{at:101,by:{source:'keeper'},by_label:'keeper:play_dead'}}});
checkIslandCancellation(cancellationCtx,{movement:{last_cancel:{at:101,by:{source:'fleetscript'},by_label:'fleetscript:fixture'}}});
checkIslandCancellation(cancellationCtx,{movement:{last_cancel:{at:99,by:{source:'operator'},by_label:'operator:stop'}}});
let mealVigor=80,mealHandle=101,meals=[];
await eatIslandAtWall({agent:'fixture',call:async(name,args)=>{
 if(name==='look')return {...look(2013),vigor:{value:mealVigor}};
 if(name==='inventory')return {items:[{id:1,name:'red mushroom',amount:30},{id:mealHandle++,name:'loaf of bread',amount:2}]};
 if(name==='act'){meals.push(args.target);mealVigor+=40;return {};}
 throw Error(name);
}},()=>{},{settleMs:0});
assert.deepEqual(meals,[101,102]);assert.equal(mealVigor,160);
let mealReconnectReads=0,mealSamples=0;
const mealReconnect=await eatIslandAtWall({agent:'fixture',origin:heldOrigin,state:{},call:async name=>{
 if(name==='look')return ++mealReconnectReads===1?{hp:null}:{...look(2503),vigor:{value:186}};
 if(name==='status')return heldStatus;
 throw Error('unexpected meal action '+name);
}},()=>{mealSamples++;},{settleMs:0});
assert.equal(mealReconnectReads,2);assert.equal(mealSamples,1);assert.equal(mealReconnect.bites,0);
await assert.rejects(eatIslandAtWall({agent:'fixture',origin:heldOrigin,call:async name=>name==='look'?{hp:null}:
 {autopilot_status:{faculties:{movement:{owner:'fleetscript:other',expires_in_ms:5000}}}}}),/health_unreadable/);
let mealReads=0;
await assert.rejects(eatIslandAtWall({agent:'fixture',call:async name=>{
 if(name==='look')return {...look(2013,20,++mealReads===1?20:19),vigor:{value:80}};
 if(name==='inventory')return {items:[{id:2,name:'loaf of bread'}]};return {};
}},()=>{},{settleMs:0}),/lost_max_health/);
const recoveryCtx={agent:'fixture',origin:{source:'fleetscript',name:'island',run_id:'fixture'},call:async name=>{
 if(name==='status')return {movement:{last_preempted:{by:{source:'keeper'},preempted:{ordered_by:'fleetscript:island#fixture'}}},autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}}}};
 if(name==='look')return {...look(2013),vigor:{value:200}};return {};
}};
assert(await recoverIslandFineWalk(recoveryCtx,{deadline:Date.now()+1000,read:async()=>({l:look(2013)})}));
assert(!await recoverIslandFineWalk({...recoveryCtx,origin:{source:'mcp',name:'operator'}},{deadline:Date.now()+1000,read:async()=>({l:look(2013)})}));
const completedRecovery={hp:{value:20,max:20},vigor:{value:200},movement:{order:null},
 autopilot_status:{faculties:{movement:{owner:'fleetscript:island',expires_in_ms:1000}},
  survival_decisions:{current:{source:'keeper',strategy:'nearest_refuge',status:'recovering',ended_at:null}}}};
for(let i=0;i<4;i++)assert.equal(activeOwnedFineRecovery(recoveryCtx,completedRecovery),false,
 'an observed healthy/rested body cannot burn its recovery attempts on a completed decision label');
assert.equal(activeOwnedFineRecovery(recoveryCtx,{...completedRecovery,hp:{value:19,max:20}}),true);
assert.equal(activeOwnedFineRecovery(recoveryCtx,{...completedRecovery,vigor:{value:70}}),true);
assert.equal(activeOwnedFineRecovery(recoveryCtx,{...completedRecovery,hp:null}),true,'unknown health is not recovered');
assert.equal(activeOwnedFineRecovery(recoveryCtx,{...completedRecovery,autopilot_status:{...completedRecovery.autopilot_status,
 survival_decisions:{current:{...completedRecovery.autopilot_status.survival_decisions.current,status:'approaching'}}}}),true,
 'an actual keeper approach retains its control until it ends');
let reads=0;
{
let entryRoom=2501,entryBlocked=false,backedOut=false;
const entryOrders=[];
const entryCtx={agent:'entry-fixture',state:{},call:async(name,args)=>{
 if(name==='look')return {...look(entryRoom),you:{...look(entryRoom).you,id:1,predicted:false},
  objects:[{id:2,x:2592,y:300,flags:9}]};
 if(name==='travel'){
  entryOrders.push(args.to);
  if(args.to===27&&!backedOut)entryBlocked=true;
  else {entryRoom=args.to;if(args.to===2501)backedOut=true;entryBlocked=false;}
  return {ordered_by:'entry-test'};
 }
 if(name==='status')return {busy:false,failed:entryBlocked?'safe_legs_required':undefined,
  job:{ordered_by:'entry-test'},movement:{order:null}};
 return {};
}};
assert((await ordinaryHop(entryCtx,2500,{pollMs:1,idleGraceMs:0,budgetMs:1000})).ok);
assert.equal(entryCtx.state.islandEntry.from,2501);
const recoveredEntry=await ordinaryHop(entryCtx,27,{pollMs:1,idleGraceMs:0,budgetMs:1000,entryWaitMs:1});
assert(recoveredEntry.ok);assert.equal(recoveredEntry.end.room,27);
assert.deepEqual(entryOrders,[2500,27,2501,2500,27]);
assert.equal(recoveredEntry.entry_recovery.attempts.length,1);
assert.equal(recoveredEntry.damage,0);
}
const ok=await ordinaryHop({agent:'fixture',call:async(name,args)=>{
 if(name==='travel'){assert.deepEqual(args.avoid,[5,587]);assert.equal(args.run_errands,false);}
 return name==='look'?look(++reads===1?2000:2013):{};
}},2013,{pollMs:1});
assert(ok.ok);assert.equal(ok.damage,0);assert.equal(ok.lowest_hp,20);
// A declared town corridor tolerates an alternate door route. One-hop cave
// callers and undeclared intermediate rooms still fail closed.
async function corridorFixture(options={},middle=72){
 let bodyReads=0,requests=0,cancelled=0;
 const result=await ordinaryHop({agent:'corridor-fixture',call:async(name,args)=>{
  if(name==='look')return look(cancelled?middle:[71,middle,73][Math.min(bodyReads++,2)]);
  if(name==='travel'){requests++;assert.equal(args.max_hops,options.maxHops??1);return {ordered_by:'corridor-owner'};}
  if(name==='status')return {busy:true,movement:{order:{kind:'travel',to:73,ordered_by:'corridor-owner'}}};
  if(name==='cancel_movement')cancelled++;
  return {};
 }},73,{pollMs:1,budgetMs:1000,...options});
 return {result,requests,cancelled};
}
const detour=await corridorFixture({maxHops:3,intermediateRooms:[72]});
assert(detour.result.ok);assert.equal(detour.requests,1);assert.equal(detour.cancelled,0);
const strictHop=await corridorFixture();
assert(!strictHop.result.ok);assert.equal(strictHop.result.reason,'unexpected_room_72');assert.equal(strictHop.cancelled,1);
const outsideCorridor=await corridorFixture({maxHops:3,intermediateRooms:[72]},74);
assert(!outsideCorridor.result.ok);assert.equal(outsideCorridor.result.reason,'unexpected_room_74');
for(const options of [{maxHops:0},{maxHops:13},{maxHops:1.5},{intermediateRooms:[1]},{intermediateRooms:'72'}]){
 let commands=0;
 await assert.rejects(ordinaryHop({agent:'invalid-corridor',call:async()=>{commands++;}},73,options),/invalid_hop_corridor/);
 assert.equal(commands,0);
}
let directCancelCleanups=0;
const directCancel={agent:'fixture',origin:{source:'fleetscript',name:'direct-hop',run_id:'fixture'},call:async name=>{
 if(name==='look')return look(2000);
 if(name==='status')return {movement:{last_cancel:{at:directCancel.state.islandCancelFence+1,
  by:{source:'operator'},by_label:'operator:cancel'}}};
 if(name==='cancel_movement')directCancelCleanups++;
 return {};
}};
await assert.rejects(ordinaryHop(directCancel,2013,{pollMs:1,budgetMs:100,idleGraceMs:2}),/cancelled_by_operator/);
const directFence=directCancel.state.islandCancelFence;
await assert.rejects(ordinaryHop(directCancel,2013,{pollMs:1,budgetMs:100,idleGraceMs:2}),/cancelled_by_operator/);
assert.equal(directCancel.state.islandCancelFence,directFence,'another hop in the same cancelled controller cannot refresh its fence');
assert.equal(directCancelCleanups,2);
reads=0;await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(++reads===1?2000:1,reads===1?20:0):{}},2013,{pollMs:1}),/traveller_died/);
reads=0;await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(2000,20,++reads===1?20:19):{}},2013,{pollMs:1}),/lost_max_health/);
let cancelled=false;
await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>{if(name==='cancel_movement')cancelled=true;return name==='look'?look(2000,19,20):{};}},2013),/departure_health_floor/);
assert(cancelled);
let entryRoom=2000,entryHealth=17,entryRests=0;
const entryRecovered=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return look(entryRoom,entryHealth);
 if(name==='status')return {autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}}}};
 if(name==='rest_up'){entryRests++;entryHealth=20;return {};}
 if(name==='travel'){assert.equal(entryHealth,20);entryRoom=2013;return {};}
 return {};
}},2013,{pollMs:1,recoverAtEntry:true});
assert(entryRecovered.ok&&entryRecovered.entry_recovered);assert.equal(entryRests,1);
let missingStatusReads=0,missingBodyReads=0,missingTravels=0;
const statusRecovered=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return look(++missingBodyReads>=4?2013:2000);
 if(name==='travel'){missingTravels++;return {ordered_by:'owned-status-recovery'};}
 if(name==='status')return ++missingStatusReads===1?{broker_error:true,error:'keeper did not provide a fresh state snapshot'}:
 {busy:true,movement:{order:{kind:'travel',to:2013,ordered_by:'owned-status-recovery'}}};
 return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(statusRecovered.ok);assert.equal(missingTravels,1);assert.equal(missingStatusReads,2);
let racedStatuses=0,racedTravels=0,racedRoom=2000;
const racedOwner={source:'fleetscript',name:'status-race',run_id:'one'},racedLabel=originLabel(racedOwner);
const raced=await ordinaryHop({agent:'fixture',origin:racedOwner,call:async name=>{
 if(name==='look')return look(racedRoom);
 if(name==='travel'){racedTravels++;return {ordered_by:racedLabel};}
 if(name==='status'){
  if(++racedStatuses===1)return {connected:false,in_game:true,hp:null,movement:{order:null,
   last_preempted:{by:{source:'keeper'},preempted:{to:2013,ordered_by:racedLabel}}}};
  racedRoom=2013;return {busy:true,movement:{order:{kind:'travel',to:2013,ordered_by:racedLabel}}};
 }
 return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(raced.ok);assert.equal(racedTravels,1);assert.equal(racedStatuses,2);
await assert.rejects(ordinaryHop({agent:'fixture',origin:racedOwner,call:async name=>{
 if(name==='look')return look(2000);if(name==='travel')return {ordered_by:racedLabel};
 if(name==='status')return {connected:false,movement:{last_preempted:{by:{source:'keeper'},preempted:{to:2013,ordered_by:'foreign'}}}};
 return {};
}},2013,{pollMs:1,idleGraceMs:0}),/traveller_health_unreadable/);
await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(2000):name==='status'?{room:{num:1},hp:{value:0,max:20}}:{}},2013,{pollMs:1}),/traveller_died/);
assert(!foreignIslandDestination({kind:'shelter',to:'r18c14'},2500));
assert(foreignIslandDestination({kind:'travel',to:2000},2500));
assert(!foreignIslandDestination({kind:'travel',to:2500},2500));
let resumeReads=0,resumeTravels=0;
const resumed=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return look(++resumeReads>=4?2013:2000);
 if(name==='travel'){resumeTravels++;return {ordered_by:'fixture-order'};}
 if(name==='status')return {busy:false,movement:{order:{kind:'travel',to:2013,ordered_by:'fixture-order',since_s:0}}};
 return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(resumed.ok);assert.equal(resumeTravels,1);
let handoffRoom=2000,handoffTravels=0,handoffCancels=0;
const handoffOrigin={source:'fleetscript',name:'handoff-test',run_id:'own'},handoffLabel=originLabel(handoffOrigin);
const handed=await ordinaryHop({agent:'fixture',origin:handoffOrigin,call:async name=>{
 if(name==='look')return look(handoffRoom);
 if(name==='travel'){
  if(++handoffTravels===1)return {ordered_by:handoffLabel,error:'fixture is busy: walk to 2000 (ordered by '+handoffLabel+')'};
  handoffRoom=2013;return {ordered_by:handoffLabel};
 }
 if(name==='status')return {busy:false,movement:{order:null}};
 if(name==='cancel_movement')handoffCancels++;return {};
}},2013,{pollMs:1});
assert(handed.ok);assert.equal(handoffTravels,2);assert.equal(handed.handoff_waits,1);assert.equal(handoffCancels,0);
let longRoom=2000,longTravels=0,longCancels=0;
const longHandoff=await ordinaryHop({agent:'fixture',origin:handoffOrigin,call:async name=>{
 if(name==='look')return look(longRoom);
 if(name==='travel'){
  if(++longTravels<=12)return {ordered_by:handoffLabel,error:'fixture is busy: walk to 2000 (ordered by '+handoffLabel+')'};
  longRoom=2013;return {ordered_by:handoffLabel};
 }
 if(name==='status')return {busy:false,movement:{order:null}};
 if(name==='cancel_movement')longCancels++;return {};
}},2013,{pollMs:1,idleGraceMs:0,budgetMs:2000});
assert(longHandoff.ok);assert.equal(longTravels,13);assert.equal(longHandoff.handoff_waits,12);assert.equal(longCancels,0);
let boundedTravels=0,boundedCancels=0;
const boundedHandoff=await ordinaryHop({agent:'fixture',origin:handoffOrigin,call:async name=>{
 if(name==='look')return look(2000);
 if(name==='travel'){boundedTravels++;return {ordered_by:handoffLabel,error:'fixture is busy: walk to 2000 (ordered by '+handoffLabel+')'};}
 if(name==='status')return {busy:false,movement:{order:null}};
 if(name==='cancel_movement')boundedCancels++;return {};
}},2013,{pollMs:1,idleGraceMs:0,budgetMs:20});
assert(!boundedHandoff.ok);assert.equal(boundedHandoff.reason,'budget');assert(boundedTravels>0);assert.equal(boundedCancels,1);
let foreignBusyTravels=0;
const foreignBusy=await ordinaryHop({agent:'fixture',origin:handoffOrigin,call:async name=>{
 if(name==='look')return look(2000);
 if(name==='travel'){foreignBusyTravels++;return {ordered_by:'operator:other',error:'fixture is busy: walk to 2000 (ordered by operator:other)'};}
 if(name==='status')return {busy:false,movement:{order:null}};
 return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(!foreignBusy.ok);assert.equal(foreignBusyTravels,1);assert.equal(foreignBusy.handoff_waits,undefined);
let recoveryReads=0,recoveryTravels=0,recoveryRests=0;
const recovered=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return {...look(++recoveryReads>=6?2013:2000),vigor:{value:recoveryReads>=3?80:50}};
 if(name==='travel'){recoveryTravels++;return {ordered_by:'fixture-order'};}
 if(name==='status')return {busy:false,autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}},suspended_journey:{to:2013,ordered_by:'fixture-order'}}};
 if(name==='rest_up'){recoveryRests++;return {};}
 return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(recovered.ok);assert.equal(recoveryTravels,2);assert.equal(recoveryRests,1);assert.equal(recovered.damage,0);
let poisonWaits=0,poisonTravels=0,poisonRoom=2000;
const poisonRecovery=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return {...look(poisonRoom,poisonTravels===0||poisonWaits>=4?20:12),vigor:{value:180}};
 if(name==='travel'){if(++poisonTravels===2)poisonRoom=2013;return {ordered_by:'poison-journey'};}
 if(name==='status')return {busy:false,autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}},
  suspended_journey:{to:2013,ordered_by:'poison-journey'}}};
 if(name==='rest_up'){poisonWaits++;return {};}
 return {};
}},2013,{pollMs:1,idleGraceMs:0,recoverAtEntry:true});
assert(poisonRecovery.ok);assert.equal(poisonWaits,4);
assert.equal(poisonTravels,2);assert.equal(poisonRecovery.recoveries,4);
assert.equal(poisonRecovery.recovery_restarts,1,'waiting at the same wall does not consume departure retries');
let endlessTravels=0;
const boundedRecovery=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return {...look(2000,endlessTravels?12:20),vigor:{value:180}};
 if(name==='travel'){endlessTravels++;return {ordered_by:'bounded-recovery'};}
 if(name==='status')return {busy:false,autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}},
  suspended_journey:{to:2013,ordered_by:'bounded-recovery'}}};
 return {};
}},2013,{pollMs:1,idleGraceMs:0,budgetMs:30});
assert(!boundedRecovery.ok);assert.equal(boundedRecovery.reason,'budget');
assert.equal(endlessTravels,1,'an unfinished bounded recovery sends no new departure');
let automaticRoom=2000,automaticTravels=0;
const automatic=await ordinaryHop({agent:'fixture',call:async name=>{
 if(name==='look')return {...look(automaticRoom),vigor:{value:80}};
 if(name==='travel'){automaticTravels++;return {ordered_by:'our-journey'};}
 if(name==='status')return {busy:false,autopilot_status:{safe_spot:{works:true,at:{row:4,col:40}},suspended_journey:{to:2013,ordered_by:'our-journey'}}};
 if(name==='rest_up'){automaticRoom=2013;return {};}
 if(name==='inventory')throw Error('meal after arrival');return {};
}},2013,{pollMs:1,idleGraceMs:0});
assert(automatic.ok);assert.equal(automaticTravels,1);assert.equal(automatic.recoveries,1);
await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(2000,19,19):{}},2013),/max_health_floor/);
cancelled=false;await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>{if(name==='cancel_movement')cancelled=true;return name==='look'?{room:{num:2000},you:{}}:{};}},2013),/health_unreadable/);assert(cancelled);
let policy={safeLegs:{rooms:[599,38],maxLeg:10}};
const policyCtx={agent:'fixture',call:async(name,args)=>{assert.equal(name,'autopilot');if(args.action==='start')policy={safeLegs:args.safe_legs};return {policy};}};
await withIslandSafeLegs(policyCtx,async()=>{assert(policy.safeLegs.rooms.includes(38));assert(ISLAND_SAFE_LEGS.rooms.every(r=>policy.safeLegs.rooms.includes(r)));assert.equal(policy.safeLegs.maxLeg,10);});
assert.deepEqual(policy.safeLegs,{rooms:[599,38],maxLeg:10});
await withIslandSafeLegs(policyCtx,async()=>{assert.equal(policy.safeLegs.required,true);},{required:true});
assert.deepEqual(policy.safeLegs,{rooms:[599,38],maxLeg:10});
await assert.rejects(withIslandSafeLegs(policyCtx,async()=>{throw Error('crossing failed');}),/crossing failed/);assert.deepEqual(policy.safeLegs,{rooms:[599,38],maxLeg:10});
await withIslandSafeLegs(policyCtx,async()=>{policy={safeLegs:false};});assert.equal(policy.safeLegs,false);
const waypoints=[{x:512,y:512},{x:1536,y:512},{x:2560,y:512}],body=waypoints[0],aim={...waypoints[2],i:2},squares=new Set(['1,2']);
assert.equal(islandFineStepBudget({x:0,y:0},{x:24*128,y:24*128}),8);
assert.equal(islandFineStepBudget({x:0,y:0},{x:24*128,y:0}),8);
assert.equal(islandFineStepBudget({x:8320,y:8192},{x:8448,y:8576},{stride:128}),8);
assert.equal(islandFineStepBudget({x:0,y:0},{x:6144,y:0},{stride:16}),26);
assert(islandTrafficRefusal({reason:'ran out of steps',shelf_refusals:11,geometry_rejections:['object_blocked']}));
assert(!islandTrafficRefusal({reason:'ran out of steps',geometry_rejections:['geometry_blocked']}));
let confirmationReads=0;
const corrected=await confirmIslandFineArrival(async()=>({l:{},body:{x:++confirmationReads===1?0:512,y:0}}),{x:512,y:0},{settleMs:0});
assert.equal(confirmationReads,2);assert.equal(corrected.error,0);
confirmationReads=0;
const unconfirmed=await confirmIslandFineArrival(async()=>{confirmationReads++;return {l:{},body:{x:0,y:0}};},{x:512,y:0},{settleMs:0});
assert.equal(confirmationReads,3);assert.equal(unconfirmed.error,512);
const shelter=shelteredIslandAim(waypoints,body,{aim,squares,edge:()=>true});assert.equal(shelter.i,1);assert(shelter.sheltered);
assert.deepEqual(shelteredIslandAim(waypoints,body,{aim,squares,edge:()=>false}),aim);
// THE POOL OF VIGOR (operator, 2026-10-23): drink on the first landing until 200 or a full stomach; never fail the ride.
{
  const pool=({room=2510,at={row:29,col:9},reach=true,vigor=60,full=999,fail=null}={})=>{
    let you={...at},v=vigor,drinks=0;const sent=[];
    return {sent,ctx:{agent:'fixture',call:async(name,args)=>{
      sent.push(name);if(fail&&name===fail)throw Error('boom');
      if(name==='look')return {room:{num:room},vigor:{value:v},hp:{value:90,max:90},you};
      if(name==='walk_to'){if(reach)you={row:args.row,col:args.col};return {arrived:reach};}
      if(name==='act'&&args.verb==='go'){if(drinks>=full)return {messages:[]};drinks++;v=Math.min(200,v+40);
        return {messages:['You drink from the life-giving waters, and feel refreshed!']};}
      throw Error('unexpected '+name);}}};};
  const rec=()=>({});
  let f=pool(),r=rec();let e=await drinkPoolOfVigor(f.ctx,r,()=>{});
  assert.equal(e.drinks,4);assert.equal(e.after,200);assert.equal(r.pool,e);
  f=pool({full:2});e=await drinkPoolOfVigor(f.ctx,rec(),()=>{});
  assert.equal(e.drinks,2);assert.match(e.stopped,/stomach full/);assert.equal(e.after,140);
  f=pool({room:2001});assert.equal(await drinkPoolOfVigor(f.ctx,rec(),()=>{}),null);assert(!f.sent.includes('act'));
  f=pool({reach:false});e=await drinkPoolOfVigor(f.ctx,rec(),()=>{});assert.equal(e.skipped,'could_not_stand_in_the_pool');assert(!f.sent.includes('act'));
  f=pool({fail:'walk_to'});e=await drinkPoolOfVigor(f.ctx,rec(),()=>{});assert.equal(e.failure,'boom');
  f=pool({vigor:200,at:{row:44,col:22}});e=await drinkPoolOfVigor(f.ctx,rec(),()=>{});assert.equal(e.drinks,0);assert(!f.sent.includes('walk_to'));
  assert(inPool({row:42,col:19})&&inPool({row:46,col:25})&&!inPool({row:41,col:22})&&!inPool({row:44,col:26}));
}
console.log('Island checks passed: full-cup gate, guard cargo, teleport recovery, serialized stash ownership, and death/max-HP guards.');
