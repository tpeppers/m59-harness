// Offline safety and recovery checks for the cave route and the island chalice.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cupIsFull,guardCategory,jungleStashPlan,islandRideRecovery,withStashLease,inventoryUnits,prepareIslandSip} from './m59-island-chalice.mjs';
import {ordinaryHop,withIslandSafeLegs,ISLAND_SAFE_LEGS,foreignIslandDestination,prepareIslandDeparture,reportIslandOutbound,waitIslandOutbound,releaseIslandWave} from './m59-island-route.mjs';
import {shelteredIslandAim,eatIslandAtWall,recoverIslandFineWalk,checkIslandCancellation,islandFineStepBudget,bindIslandFinePosition,confirmIslandFineArrival,islandTrafficRefusal,cutIslandRail} from './m59-island-finewalk.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {chordWalkable,cutRail} from './m59-railcut.mjs';
import {originLabel} from './m59-move-origin.mjs';
import {doorStates} from './m59-doorbake.mjs';
import {shadowDispelResetTimers} from './m59-island-lab-dispel.mjs';
assert.deepEqual(shadowDispelResetTimers('Timer Remaining ms Object Message\n123 10000 1667 ReplaceIllusions\n124 20000 1667 ReplaceIllusions\n125 5000 1667 GenerateMonster\n126 5000 99 ReplaceIllusions',1667),[123,124]);
assert.throws(()=>shadowDispelResetTimers('',null),/room_unconfirmed/);
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
}finally{rmSync(dir,{recursive:true,force:true});}
const look=(room,hp=20,max=20)=>({room:{num:room},you:{row:4,col:40,x:2592,y:288},hp:{value:hp,max}});
const fine={ok:true,fresh:true,room:2502,protocol:{x:2201,y:2650},square:{row:41,col:34}};
assert.deepEqual(bindIslandFinePosition(look(2502),fine).you,{row:41,col:34,x:2201,y:2650});
assert.throws(()=>bindIslandFinePosition(look(2502),{...fine,fresh:false}),/unconfirmed/);
assert.throws(()=>bindIslandFinePosition(look(2501),fine),/unconfirmed/);
let departureCalls=0;
await assert.rejects(prepareIslandDeparture({agent:'fixture',call:async()=>{departureCalls++;}}, {...look(27),vigor:{value:80}}),/requires_food_and_vigor/);
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
let reads=0;
const ok=await ordinaryHop({agent:'fixture',call:async(name,args)=>{
 if(name==='travel'){assert.deepEqual(args.avoid,[5,587]);assert.equal(args.run_errands,false);}
 return name==='look'?look(++reads===1?2000:2013):{};
}},2013,{pollMs:1});
assert(ok.ok);assert.equal(ok.damage,0);assert.equal(ok.lowest_hp,20);
reads=0;await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(++reads===1?2000:1,reads===1?20:0):{}},2013,{pollMs:1}),/traveller_died/);
reads=0;await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>name==='look'?look(2000,20,++reads===1?20:19):{}},2013,{pollMs:1}),/lost_max_health/);
let cancelled=false;
await assert.rejects(ordinaryHop({agent:'fixture',call:async name=>{if(name==='cancel_movement')cancelled=true;return name==='look'?look(2000,19,20):{};}},2013),/departure_health_floor/);
assert(cancelled);
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
assert.equal(islandFineStepBudget({x:0,y:0},{x:24*128,y:0}),6);
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
console.log('Island checks passed: full-cup gate, guard cargo, teleport recovery, serialized stash ownership, and death/max-HP guards.');
