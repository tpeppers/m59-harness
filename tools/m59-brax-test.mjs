import {cutRail} from './m59-railcut.mjs';
import {planBodyDetour,blockingBodySnapshot} from './m59-body-detour.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {squareCentreClient} from './m59-finepos.mjs';
import {chordWalkable} from './m59-railcut.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {platformSlot,cornerWork,braxArrival,groupJournal,platformAims,CORNERS,departureSlot,keeperSurvivalInterruption,readyAfterSurvival,awaitLeverConfirmation,freePlatformStation,replaceBraxJournal,unsentBraxBodyRefusal,braxCrossingGate,travelBraxRoad} from './m59-brax.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
import {script} from './fleetscripts/walk-to-brax.mjs';
const {braxBoardingComplete}=await import('./m59-brax.mjs');
const boarding={cutoff:60000,expectedAgents:['a','b'],members:[{agent:'a',aboard:true}]};
assert(!braxBoardingComplete(boarding,100));
assert(braxBoardingComplete({...boarding,members:[...boarding.members,{agent:'b',aboard:true}]},100));
assert(!braxBoardingComplete({...boarding,members:[...boarding.members,{agent:'b',aboard:false}]},60001));
assert(braxBoardingComplete(boarding,60001));
assert(braxBoardingComplete({...boarding,expectedAgents:['a']},100),'solo requests leave as soon as boarded');
assert.equal(script.params.fragileBelow.default,1,'the public route includes 20 HP mules by default');
const geo=roomGeometry(579);
applyAncientFloors({rooms:{579:{}}},579,new Map([[2,{type:4,height:250}],[3,{type:4,height:250}]]),null,{geometryOf:()=>geo});
const slots=Array.from({length:25},(_,i)=>platformSlot(i));
assert.equal(new Set(slots.map(s=>`r${s.row}c${s.col}`)).size,25);
for(const s of slots)assert.equal(floorAt(geo,(s.col-1)*1024+512,(s.row-1)*1024+512),4000);
assert.throws(()=>platformSlot(25));
assert.throws(()=>platformSlot(-1));
for(let size=1;size<=25;size++){
  const work=Array.from({length:size},(_,i)=>cornerWork(i,size)).flat();
  assert.equal(work.length,4);assert.equal(new Set(work.map(l=>`r${l.row}c${l.col}`)).size,4);
}
assert(braxArrival({room:{num:827},hp:{value:1}}));
assert(!braxArrival({room:{num:826},hp:{value:151}}));
assert(!braxArrival({room:{num:827},hp:{value:0}}));
await assert.rejects(script.steps({agents:[]}),/1..25/);
await assert.rejects(script.steps({agents:['a','a']}),/1..25/);
await assert.rejects(script.steps({agents:Array.from({length:26},(_,i)=>'a'+i)}),/1..25/);
const directory=mkdtempSync(join(tmpdir(),'m59-brax-test-'));
const journal=groupJournal('test:15959',{directory});
const moduleURL=new URL('./m59-brax.mjs',import.meta.url).href;
const code=`import {groupJournal} from ${JSON.stringify(moduleURL)};const j=groupJournal('test:15959',{directory:process.argv[1]});for(let i=0;i<20;i++)await j.change(g=>({count:(g?.count??0)+1}));`;
await Promise.all(Array.from({length:6},()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,directory],{windowsHide:true,timeout:30000})));
assert.equal(JSON.parse(readFileSync(journal.file)).count,120,'separate group callers cannot lose journal writes');
applyAncientFloors({rooms:{579:{}}},579,new Map([[2,{type:4,height:800}],[3,{type:4,height:250}]]),null,{geometryOf:()=>geo});
for(const slot of slots)for(const goal of [...CORNERS.map(l=>l.stand),{row:22,col:55},{row:17,col:55}]){
  let body=squareCentreClient(slot.row,slot.col);
  for(const aim of platformAims(body,squareCentreClient(goal.row,goal.col))){
    assert(chordWalkable(body,aim,{edge:(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<1||geo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true}).ok,'platform path must avoid raised center spire');body=aim;
  }
}
applyAncientFloors({rooms:{579:{}}},579,new Map([[2,{type:4,height:800}],[3,{type:4,height:800}]]),null,{geometryOf:()=>geo});
const parked=new Map([[2,{id:2,flags:5,x:3424,y:1184}],[3,{id:3,flags:5,x:3680,y:1184}]]);
const from={x:3872,y:1120},goal={x:3360,y:1184},bodies=blockingBodySnapshot(parked,1);
const direct=geo.traceFineMoveClient(protocolToClient(from).x,protocolToClient(from).y,protocolToClient(goal).x,protocolToClient(goal).y,{obstacles:bodies,slide:false});
assert.equal(direct.arrived,false,'recorded direct return crosses a parked fleetmate');
const detour=planBodyDetour(geo,from,goal,{objects:parked,selfId:1,maxRangeSquares:24,marginSquares:4,maxNodes:12000,maxMs:1000});assert(detour.found);
let at=protocolToClient(from);for(const point of detour.waypoints){const next=protocolToClient(point);assert(chordWalkable(at,next,{edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{obstacles:bodies,slide:false})?.arrived===true}).ok);assert.equal(floorAt(geo,next.x,next.y),12800);at=next;}
const queues=Array.from({length:25},(_,i)=>departureSlot(i));
for(let i=0;i<queues.length;i++){
  assert.equal(floorAt(geo,queues[i].x,queues[i].y),12800);
  for(let j=0;j<i;j++)assert(Math.hypot(queues[i].x-queues[j].x,queues[i].y-queues[j].y)>=512);
}
const crowded=new Map(slots.map((slot,index)=>[index+1,{id:index+1,flags:5,...clientToProtocol(squareCentreClient(slot.row,slot.col))}]));
for(let i=0;i<25;i++){
  const slot=slots[i],route=planBodyDetour(geo,clientToProtocol(squareCentreClient(17,60)),clientToProtocol(squareCentreClient(slot.row,slot.col)),{objects:crowded,selfId:i+1,maxRangeSquares:24,marginSquares:4,maxNodes:12000,maxMs:1000});
  assert(route.found,'every station remains reachable around the other 24 players');
}
console.log('Brax: platform slots, group cap, divided lever work, objective, and atomic shared journal passed');

assert(keeperSurvivalInterruption({cancelled:true,cancelled_by_origin:{source:'keeper',name:'play_dead'}}));
assert(!keeperSurvivalInterruption({cancelled:true,cancelled_by_origin:{source:'fleetscript'}}));
assert(!keeperSurvivalInterruption({reason:'object_blocked'}));
assert(readyAfterSurvival({hp:{value:145,max:151},autopilot_status:{survival_decisions:{current:null}}}));
assert(!readyAfterSurvival({hp:{value:70,max:151}}));
assert(!readyAfterSurvival({hp:{value:151,max:151},autopilot_status:{survival_decisions:{current:'play_dead'}}}));
assert(!readyAfterSurvival({hp:{value:0,max:151}}));

let tick=0,seen=[];
assert(await awaitLeverConfirmation({messages:['System is saving; please wait.']},{since:10,now:()=>tick,
  observedRaised:async()=>false,waitEvent:async args=>{seen.push(args.since);tick+=1000;return tick===1000?{cursor:11,events:[{text:'An unrelated message'}]}:{cursor:12,events:[{text:'You switch the lever.'}]};}}));
assert.deepEqual(seen,[10,11]);
tick=0;
assert(!await awaitLeverConfirmation({}, {since:1,timeoutMs:2000,now:()=>tick,observedRaised:async()=>false,
  waitEvent:async()=>{tick+=1000;return {cursor:2,events:[{text:'System saved.'}]};}}));
const leaderPath=platformAims(squareCentreClient(22,55),squareCentreClient(17,51));
assert(!leaderPath.some(p=>p.x===squareCentreClient(24,51).x&&p.y===squareCentreClient(24,51).y),'north lever worker must not use the occupied south lever station as a mandatory aim');

let mutexOpenCalls=0;
const deletePending=groupJournal('windows-delete-pending',{directory,openMutex:(...args)=>{
  if(!mutexOpenCalls++)throw Object.assign(Error('delete pending'),{code:'EPERM'});
  return openSync(...args);
}});
assert.equal((await deletePending.change(()=>({count:1}))).count,1);
assert.equal(mutexOpenCalls,2,'a Windows delete-pending refusal retries without deleting an unowned lock');

// Recorded public travel arrival and a keeper refuge must both board by legal walking.
const entryGeo=roomGeometry(579),railHead={x:74880,y:38400};
for(const from of [{x:72192,y:39424},{x:47360,y:48640}]){
 const entry=cutRail(from,railHead,{edge:(a,b)=>entryGeo.traceFineMoveClient(a.x,a.y,b.x,b.y)?.arrived===true,bounds:{w:entryGeo.cols*1024,h:entryGeo.rows*1024},floorAt:(x,y)=>floorAt(entryGeo,x,y)});
 assert(entry.ok&&entry.bridgeOk,'normal entry and observed refuge must have a checked walking connector');
 assert(Math.hypot(entry.waypoints.at(-1).x-railHead.x,entry.waypoints.at(-1).y-railHead.y)<1);
}

assert.equal(freePlatformStation([],[{id:2,flags:5,...clientToProtocol(squareCentreClient(18,52))}],1),1,'a previous rider cannot be assigned to the next rider');
assert.equal(freePlatformStation([{slot:0,station:1}],[{id:2,flags:5,...clientToProtocol(squareCentreClient(18,52))}],1),2);
assert.equal(freePlatformStation(Array.from({length:25},(_,slot)=>({slot})),[],1),null);

let replaceAttempts=0,replaceClock=0;
await replaceBraxJournal('unused','unused',{rename:()=>{if(!replaceAttempts++)throw Object.assign(Error('reader sharing violation'),{code:'EPERM'});},now:()=>replaceClock,wait:async ms=>{replaceClock+=ms}});
assert.equal(replaceAttempts,2);
await assert.rejects(replaceBraxJournal('unused','unused',{rename:()=>{throw Object.assign(Error('permission denied'),{code:'EPERM'})},budgetMs:100,now:()=>replaceClock,wait:async ms=>{replaceClock+=ms}}),/permission denied/);

assert(unsentBraxBodyRefusal({jumped:false,mover:{moved:false,reason:'object_blocked'}}));
for(const r of [{jumped:true,mover:{moved:false,reason:'object_blocked'}},{jumped:false,mover:{moved:true,reason:'object_blocked'}},{jumped:false,cancelled:true,mover:{moved:false,reason:'object_blocked'}},{jumped:false,mover:{moved:false,reason:'geometry_blocked'}},{}])assert.equal(unsentBraxBodyRefusal(r),false);

// A body on the first fall used to select a lane into the lower gully.
// Exercise real Session.step and its timed BSP validator with a socketless client.
{
 const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness();
 const {withBodyCommand}=await h.imp('m59-body-command.mjs');
 for(const blocked of [false,true]){
  const bodies=blocked?[{id:9,flags:9,x:2125,y:2591,nameRsc:9}]:[];
  const f=h.fixture({from:{room:579,x:2168,y:2614},bodies},{bodies:true,maxMs:15000,maxPackets:32});f.c.rsc.set(9,'black spider');
  const result=await withBodyCommand(f.s,()=>f.s.step(32,40,{fall:true,timedFall:true,aimX:2083,aimY:2569}),'brax-offline-lane');
  if(blocked){assert.equal(result.moved,false);assert.equal(f.packets.length,0,'blocked declared flight cannot choose a different landing shelf');}
  else{assert(result.moved);assert.equal(f.packets.length,1);assert.deepEqual({x:f.c.self.x,y:f.c.self.y},{x:2083,y:2569});}
 }
}

{
 const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness();
 const {withBodyCommand}=await h.imp('m59-body-command.mjs');
 const bodies=[{id:9,flags:5,x:2145,y:2654,nameRsc:9}];
 const f=h.fixture({from:{room:579,x:2160,y:2648},bodies},{bodies:true,maxMs:15000,maxPackets:32});
 const result=await withBodyCommand(f.s,()=>f.s.step(32,40,{fall:true,timedFall:true,aimX:2083,aimY:2569}),'brax-neighbor-takeoff');
 assert.equal(f.packets.length,0,'a neighboring declared takeoff cannot send an unproved shifted flight');
 assert.equal(result.moved,false);assert.equal(result.reason,'fall_blocked_by_body');
}

const crossing=braxCrossingGate('offline-first-fall',{directory,alive:pid=>pid===100});
const ownerA={pid:100,token:'a'},ownerB={pid:101,token:'b'};
assert(await crossing.acquire(ownerA));assert(!await crossing.acquire(ownerB));assert(await crossing.foreign(ownerB));
assert(!await crossing.release(ownerB));assert(await crossing.release(ownerA));
assert(await crossing.acquire(ownerB));assert(await crossing.acquire(ownerA),'only a positively dead driver permits replacing its claim');
assert(await crossing.release(ownerA));

await new Promise((done,fail)=>execFile(process.execPath,['tools/m59-fineclimb.mjs','--serialize-jumps','--precise-waypoints','--help'],{cwd:process.cwd()},(error,stdout,stderr)=>error?fail(Error(stderr||error.message)):done(stdout)));

{
 let tick=0,calls=[];
 const states=[{room:{num:568},job:{busy:'previous',ordered_by:'our-run'}},{room:{num:568}},{room:{num:589},job:{busy:'finishing',ordered_by:'our-run'}},{room:{num:589},job:{ok:true}}];
 assert(await travelBraxRoad({read:async()=>states.shift(),command:async(name,args)=>{calls.push({name,args});return{};},owner:'our-run',to:589,deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}}));
 assert.equal(calls.length,1);assert.equal(calls[0].args.background,true);
 await assert.rejects(travelBraxRoad({read:async()=>({room:{num:568},job:{busy:'foreign',ordered_by:'other'}}),command:async()=>{throw Error('must not dispatch');},owner:'ours',to:589,deadline:10000,now:()=>0}),/another controller/);
}

{
 let tick=0,calls=[];
 const states=[{room:{num:801}},{room:{num:579},job:{busy:'walk to Sentinel',ordered_by:'ours'}},{room:{num:579}}];
 assert(await travelBraxRoad({read:async()=>states.shift(),command:async(name,args)=>{calls.push({name,args});return{};},owner:'ours',to:589,alsoStopAt:[579],deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}}));
 assert.deepEqual(calls.map(c=>c.name),['travel','cancel_movement'],'ordinary Temple road stops at the usable Ancient Place entrance instead of crossing it twice');
}

{
 const {planLandingClearance}=await import('./m59-rail-traffic.mjs');
 const g=roomGeometry(579);
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries({2:800,3:800,4:510,9:540}).map(([id,height])=>[Number(id),{type:4,height}])),null,{geometryOf:()=>g});
 for(const col of [55,56]){
  const body=clientToProtocol(squareCentreClient(8,col)),preferred=clientToProtocol(squareCentreClient(7,col));
  const plan=planLandingClearance(g,body,preferred);assert(plan.found);assert(plan.advance>=32);
  const a=protocolToClient(body),b=protocolToClient(plan.target);assert(g.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false}).arrived);
  assert.equal(floorAt(g,b.x,b.y),8160);
  if(col===56){const old=protocolToClient(preferred);assert(!g.traceFineMoveClient(a.x,a.y,old.x,old.y,{slide:false}).arrived,'recorded square-center clearance is blocked by the wall');assert.notDeepEqual(plan.target,preferred);}
 }
}

{
 const {unsentBraxJumpRefusal}=await import('./m59-brax.mjs'),{planDeclaredTakeoff}=await import('./m59-jump-takeoff.mjs');
 const refused={jumped:false,mover:{moved:false,left_room:false,reason:'fall_changed_before_send'}};
 assert(unsentBraxJumpRefusal(refused));assert(!unsentBraxJumpRefusal({...refused,cancelled:true}));
 assert(!unsentBraxJumpRefusal({...refused,mover:{...refused.mover,moved:true}}));
 const g=roomGeometry(579);
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries({2:250,3:250,4:540,5:200,6:200,7:200,8:200,9:510}).map(([id,height])=>[Number(id),{type:4,height}])),null,{geometryOf:()=>g});
 const declaration={room:579,from:{row:32,col:55},to:{row:25,col:55},from_fine:{x:55808,y:32000},to_fine:{x:55808,y:25088}};
 const plan=planDeclaredTakeoff(g,{x:3552,y:2066},declaration);assert(plan.found,'recorded two-wire-unit takeoff correction is freshly planned before retrying an explicitly unsent fall');
}

// A completed HTTP job is stale evidence once the same keeper owns a resumed road.
{
 let tick=0,calls=[];
 const failed={failed:'route_progressing_exits_exhausted',ordered_by:'ours'};
 const states=[{room:{num:826}},{room:{num:826},job:failed},
  {room:{num:826},job:failed,movement:{order:{kind:'travel',to:39,ordered_by:'ours'}}},
  {room:{num:578},job:failed,autopilot_status:{suspended_journey:{to:39,ordered_by:'ours'}}},
  {room:{num:39},job:failed}];
 assert(await travelBraxRoad({read:async()=>states.shift(),command:async(name,args)=>{calls.push({name,args});return{};},owner:'ours',to:39,deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}}));
 assert.deepEqual(calls.map(c=>c.name),['travel'],'observing the keeper resume must not send duplicate travel');
 await assert.rejects(travelBraxRoad({read:async()=>({room:{num:826},movement:{order:{kind:'travel',to:39,ordered_by:'foreign',origin:{source:'fleetscript'}}}}),command:async()=>{throw Error('must not dispatch');},owner:'ours',to:39,deadline:10000,now:()=>0}),/another controller/);
 tick=0;let reads=0;
 await assert.rejects(travelBraxRoad({read:async()=>({room:{num:826},...(reads++?{job:failed}:{})}),command:async()=>({}),owner:'ours',to:39,deadline:10000,now:()=>tick,wait:async ms=>{tick+=ms;}}),/Brax road failed/);
 assert.equal(tick,5500,'an ended road without actual resumption fails after its bounded observation window');
 tick=0;
 await assert.rejects(travelBraxRoad({read:async()=>({room:{num:826},job:failed,movement:{order:{kind:'travel',to:39,ordered_by:'ours'}}}),command:async()=>{throw Error('must not dispatch');},owner:'ours',to:39,deadline:1000,now:()=>tick,wait:async ms=>{tick+=ms;}}),/journey timed out/);
}

{
 for(const reply of [{refused:true,reason:'health floor'},{started:false,reason:'not in game'},{cancelled:true,reason:'cancelled'}]){
  let calls=0;await assert.rejects(travelBraxRoad({read:async()=>({room:{num:52}}),command:async()=>{calls++;return reply;},owner:'ours',to:39,deadline:10000,now:()=>0}),/Brax road refused/);assert.equal(calls,1,'an explicitly unstarted road cannot become a silent twenty-minute wait');
 }
}

assert(keeperSurvivalInterruption({arrived:false,reason:'keeper_recovery_active',decision_id:'captured-native-recovery'}));
assert(!keeperSurvivalInterruption({cancelled:true,cancelled_by_origin:{source:'operator'},reason:'keeper_recovery_active',decision_id:'not-authority'}));
assert(!keeperSurvivalInterruption({reason:'keeper_recovery_active'}));

// Waiting followers each have to acquire; an empty observation grants nobody entry.
{
 const {waitForCrossing}=await import('./m59-crossing-queue.mjs');let held='leader',clock=0,checks=0;
 const gate={acquire:async owner=>{if(held)return false;held=owner.token;return true;}};
 await waitForCrossing(gate,{token:'follower'},{deadline:2000,now:()=>clock,check:async()=>checks++,wait:async ms=>{clock+=ms;held=null;}});
 assert.equal(held,'follower');assert.equal(checks,2);
 await assert.rejects(waitForCrossing(gate,{token:'second'},{deadline:1000,now:()=>clock,wait:async ms=>{clock+=ms;}}),/queue_budget/);
 assert.equal(held,'follower','a timed-out follower cannot enter another owner’s approach');
}

{
 const {waitForCrossing}=await import('./m59-crossing-queue.mjs');let clock=0,claims=0;
 await waitForCrossing({acquire:async()=>{claims++;return true;}},{token:'rear'},{deadline:2000,now:()=>clock,ready:async()=>clock>=1000,wait:async ms=>{clock+=ms;}});
 assert.equal(claims,1,'a rear traveler cannot claim while a body physically ahead blocks its usable lane');assert.equal(clock,1000);
}

{
 const {keeperRecoveryTripSince}=await import('./m59-brax.mjs');
 assert(keeperRecoveryTripSince({autopilot_status:{recovery_travel:{id:'owned'}}},10));
 assert(keeperRecoveryTripSince({movement:{last_cancel:{at:11,by:{source:'keeper',name:'recovery_detour'}}}},10),'the checked entry may observe the trip only after it ended');
 for(const by of [{source:'operator',name:'recovery_detour'},{source:'keeper',name:'unrelated'}])assert(!keeperRecoveryTripSince({movement:{last_cancel:{at:11,by}}},10));
 assert(!keeperRecoveryTripSince({movement:{last_cancel:{at:9,by:{source:'keeper',name:'recovery_detour'}}}},10));
}

// Raphael was blocked walking to a fixed opposite lane, although his actual
// confirmed body could already make the legal declared fall into that lane.
{
 const {chooseBraxBoarding}=await import('./m59-brax.mjs');
 const f=JSON.parse(readFileSync(new URL('./fixtures/brax-south-queue.json',import.meta.url))),geo=roomGeometry(579),objects=new Map(f.actors.map(o=>[o.id,o])),body=objects.get(f.boarderId);
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(f.floors).map(([id,height])=>[Number(id),{height,type:4}])),null,{geometryOf:()=>geo});
 const ready=chooseBraxBoarding(geo,body,objects);assert(ready,'admit the physically usable boarding lane');
 const {bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs'),h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
 const native=h.fixture({from:{room:579,x:body.x,y:body.y},bodies:f.actors.filter(o=>o.id!==body.id).map((o,i)=>({...o,id:10+i,nameRsc:10+i}))},{bodies:true,maxMs:15000,maxPackets:60});
 // The server's own report of the floors the geometry above was set from: a declared jump with
 // `requires.sectors` checks it before flying (m59-jump-precondition.mjs).
 native.c.room.sectorHeights=new Map(Object.entries(f.floors).map(([id,height])=>[Number(id),{height,type:4}]));
 const result=await withBodyCommand(native.s,async()=>{const w=await native.s.walkFine(ready.plan.takeoff.x,ready.plan.takeoff.y,{stride:8,maxSteps:32,arriveWithin:0,exactArrival:true,holdShelf:true});assert(w.arrived,JSON.stringify(w));return native.s.step(ready.col,25,{fall:true,timedFall:true,aimX:ready.col*64+32,aimY:1632});},'actual-platform-boarding');
 assert(result.moved,JSON.stringify(result));assert.equal(native.c.self.row,25);
}

{
 const {unsentBraxJumpRefusal}=await import('./m59-brax.mjs');assert(unsentBraxJumpRefusal({jumped:false,mover:{moved:false,left_room:false,reason:'fall_blocked_by_body'}}));
 assert(!unsentBraxJumpRefusal({jumped:false,mover:{moved:true,reason:'fall_blocked_by_body'}}));
}

{
 const {releaseAfterClearance}=await import('./m59-crossing-queue.mjs');let finish,reads=0,released=false;
 const moving=new Promise(resolve=>{finish=resolve;});
 const work=releaseAfterClearance({release:async()=>{released=true;return true;}},{pid:process.pid,token:'test'},moving,{
  read:async()=>({distance:++reads*16}),clear:s=>s.distance>=32,wait:async()=>{},onClear:()=>{assert(released);finish('parked');}});
 assert.equal(await work,'parked');assert.equal(reads,2,'the first half-square remains owned; the next traveler need not wait for the rest of parking');
 let finishFailed;released=false;
 const failedWalk=new Promise(resolve=>{finishFailed=resolve;});
 await assert.rejects(releaseAfterClearance({release:async()=>{released=true;return true;}},{pid:process.pid,token:'test'},failedWalk,{
  read:async()=>{finishFailed();throw Error('own body unconfirmed');},clear:()=>true,wait:async()=>{}}),/unconfirmed/);
 assert.equal(released,false,'unconfirmed movement never releases a landing claim early');
}


{
 const {braxStoppedPlatformWalk}=await import('./m59-brax.mjs');
 assert(braxStoppedPlatformWalk({arrived:false,reason:'blocked — every heading refused, at every reach tried',last_step:{moved:false,geometry_blocked:true}}),'captured platform walk ended with a locally unsent packet, so a freshly proved detour may continue from actual partial progress');
 for(const r of [{arrived:false,error:'transport timeout'},{arrived:false,cancelled:true,reason:'object_blocked'},{arrived:false,last_step:{moved:true,geometry_blocked:true}},{arrived:true,reason:'object_blocked'}])assert(!braxStoppedPlatformWalk(r));
}


{
 const {runInNewContext}=await import('node:vm'),{resumeObservedRailWalk}=await import('./m59-rail-observer.mjs');
 const source=readFileSync(new URL('./m59-brax.mjs',import.meta.url),'utf8'),begin=source.indexOf('  const rawWalkPoint=async('),stop=source.indexOf('  const walkPoint=async(',begin);assert(begin>=0&&stop>begin);
 let sends=0,reads=0,pose={id:7,x:3382,y:1494,row:23,col:52,room_object_id:9};const target={x:3360,y:1440},events=[];
 const run=runInNewContext('(function(){'+source.slice(begin,stop)+'return rawWalkPoint;})()',{
  end:Date.now()+90000,start:Date.now(),ctx:{origin:{}},currentCallOrigin:()=>({}),originLabel:()=> 'ours',Date,Error,Math,
  clientToProtocol,squareCentreClient,position:s=>protocolToClient(s.you),resumeObservedRailWalk,keeperSurvivalInterruption,recoverIslandFineWalk:async()=>{throw Error('unexpected recovery');},sleep:async()=>{},log:(...args)=>events.push(args),
  command:async()=>{sends++;if(sends===1)return{arrived:false,reason:'position_confirmation_timeout'};assert(reads>0,'the first stopped packet must be observed before another move');pose={...pose,...target,row:22,col:52};return{arrived:true};},
  read:async()=>{reads++;return{in_game:true,hp:{value:20,max:20},room:{num:579,object_id:9},you:pose,position_read:pose};}
 });
 await run(protocolToClient(target));assert.equal(sends,2);assert.equal(events.filter(e=>e[0]==='point-confirmation-recovered').length,1);
 console.log('platform point walk: the actual Brax branch observes its stopped packet before continuing after confirmation timeout');
}


{
 const {runInNewContext}=await import('node:vm'),{resumeObservedRailWalk}=await import('./m59-rail-observer.mjs');
 const source=readFileSync(new URL('./m59-brax.mjs',import.meta.url),'utf8'),begin=source.indexOf('  const rawWalkPoint=async('),stop=source.indexOf('  const walkPoint=async(',begin);
 let sends=0,recoveries=0,pose={id:7,x:3472,y:1408,row:22,col:54,room_object_id:9},hp=19;const target={x:3360,y:1376};
 const read=async()=>({in_game:true,hp:{value:hp,max:20},room:{num:579,object_id:9},you:pose,position_read:pose});
 const run=runInNewContext('(function(){'+source.slice(begin,stop)+'return rawWalkPoint;})()',{
  end:Date.now()+180000,start:Date.now(),ctx:{origin:{}},currentCallOrigin:()=>({}),originLabel:()=> 'ours',Date,Error,Math,
  clientToProtocol,squareCentreClient,position:s=>protocolToClient(s.you),resumeObservedRailWalk,keeperSurvivalInterruption,read,sleep:async()=>{},log:()=>{},
  recoverIslandFineWalk:async(_ctx,options)=>{recoveries++;assert(options.active);assert(options.deadline<=Date.now()+180000);assert.equal((await options.read()).l.hp.value,19);hp=20;return true;},
  command:async()=>{sends++;if(sends===1)return{arrived:false,cancelled:true,cancelled_by_origin:{source:'keeper',name:'shelter'}};assert.equal(hp,20,'no script move races the keeper shelter cycle');pose={...pose,...target,row:21,col:52};return{arrived:true};}
 });
 await run(protocolToClient(target));assert.equal(sends,2);assert.equal(recoveries,1);
 console.log('platform survival: the captured 20-HP shelter interruption finishes under the original bounded deadline before parking continues');
}


{
 const {braxAdmissionGroup}=await import('./m59-brax.mjs'),{BRAX_RESET_FLOORS}=await import('./m59-brax-puzzle.mjs');
 const failed={id:'old',phase:'boarding',requestKey:'request-a',failure:'member did not finish',members:[],baselineSince:1,readyAfter:1,readiness:{verifiedAt:1,readyAfter:1}};
 assert.throws(()=>braxAdmissionGroup({...failed},BRAX_RESET_FLOORS,{now:1000,requestKey:'request-a'}),/member did not finish/,'late members cannot turn their failed request into a second small lever run');
 const renewed=braxAdmissionGroup({...failed},BRAX_RESET_FLOORS,{now:1000,requestKey:'request-b',id:()=> 'new'});assert.equal(renewed.phase,'boarding');assert.equal(renewed.requestKey,'request-b');assert.equal(renewed.failure,undefined);
 const partial=braxAdmissionGroup({...failed,lastTouchAttemptAt:900,readyAfter:421900},BRAX_RESET_FLOORS,{now:1000,requestKey:'request-b'});assert.equal(partial.phase,'waiting-reset');assert.equal(partial.requestKey,'request-a');assert.equal(partial.id,'old');assert.equal(partial.readyAfter,421900,'a new request still waits through a known partial-puzzle cooldown');
 console.log('Brax request fence: a failed cohort cannot create additional late elevator runs; new requests retain full puzzle readiness');
}


{
 const near={x:3552,y:1632},first=freePlatformStation([],[],1,near),p=platformSlot(first);
 assert(Math.hypot(p.col*64+32-near.x,p.row*64+32-near.y)<=3*64,'a new rider parks near the south landing instead of crossing the whole platform');
 const current=platformSlot(18),body={x:current.col*64+32,y:current.row*64+32};assert.equal(freePlatformStation([],[],1,body),18,'an existing rider keeps its own clear station');
 assert.notEqual(freePlatformStation([{station:18}],[],1,body),18,'nearby choice cannot reuse a reserved station');
 assert.notEqual(freePlatformStation([],[{id:2,flags:5,...body}],1,body),18,'nearby choice cannot occupy another body');
 console.log('platform parking: nearest clear reserved-grid station shortens boarding and avoids reshuffling existing riders');
}

// The actual raised platform supports progressive queue movement, with the
// same whole-body trace used by the mover. No rider must wait at its old spot.
{
 const {planLineQueueAdvance}=await import('./m59-rail-traffic.mjs');
 const geo=roomGeometry(579);
 applyAncientFloors({rooms:{579:{}}},579,new Map([[2,{type:4,height:800}],[3,{type:4,height:800}],[4,{type:4,height:510}]]),null,{geometryOf:()=>geo});
 const body={id:101,flags:5,x:3552,y:1120},head={x:3552,y:992};
 const next={id:102,flags:5,x:3552,y:1056};
 let objects=new Map([[body.id,body],[next.id,next]]);
 let step=planLineQueueAdvance(geo,body,head,{predecessor:next,objects});
 assert(step.found,JSON.stringify(step));assert.equal(step.target.y,1088);
 assert.equal(step.floor,12800);assert.equal(step.advance,32);
 const touching={...next,y:1088};assert(!planLineQueueAdvance(geo,body,head,{predecessor:touching,objects:new Map([[body.id,body],[next.id,touching]])}).found,'closed gap waits');
 const ahead={...next,y:1024};step=planLineQueueAdvance(geo,body,head,{predecessor:ahead,objects:new Map([[body.id,body],[next.id,ahead]])});
 assert(step.found);assert.equal(step.target.y,1056,'the next opening is filled without waiting for the predecessor to finish its trip');
 assert(!planLineQueueAdvance(geo,body,head,{predecessor:{...next,x:3616},objects}).found,'another lane cannot provide ordering proof');
 assert(!planLineQueueAdvance(geo,{...body,predicted:true},head,{predecessor:next,objects}).found);
 const jam={id:103,flags:5,x:3552,y:1096};objects.set(jam.id,jam);
 step=planLineQueueAdvance(geo,body,head,{predecessor:next,objects});assert(!step.found,'a physical blocker inside the gap prevents an advance');
 // Both lanes keep their order as the head clears. The complete segment of
 // every prefix is checked against the current bodies, not only its endpoint.
 for(const lane of [0,1]){
  const actors=Array.from({length:12},(_,i)=>({id:200+i,flags:5,x:3552+lane*64,y:992+i*32}));
  actors.shift();const objects=new Map(actors.map(o=>[o.id,o]));
  let moved=0;
  for(let i=0;i<actors.length;i++){
   const actor=actors[i],predecessor=i?actors[i-1]:{x:actor.x,y:960};
   const step=planLineQueueAdvance(geo,actor,{x:actor.x,y:992},{predecessor,objects});
   assert(step.found,JSON.stringify({lane,i,actor,step}));assert.equal(step.advance,32);
   Object.assign(actor,step.target);moved++;
  }
  assert.equal(moved,11);
 }
 console.log('raised-platform queue: both lanes fill free prefixes while their leaders continue; body, floor and ordering guards retained');
}

{
 const {rollingGatherCutoff}=await import('./m59-crossing-queue.mjs');
 let cutoff=60000;const hardCutoff=180000,idleMs=60000;
 for(const at of [5000,17000,58710,62973])cutoff=rollingGatherCutoff({cutoff,hardCutoff,idleMs},at);
 assert.equal(cutoff,122973,'q07 fifth traveler three seconds past the old window joins the still progressing group');
 for(const at of [100000,150000,175000])cutoff=rollingGatherCutoff({cutoff,hardCutoff,idleMs},at);
 assert.equal(cutoff,180000,'stragglers cannot extend the assembly indefinitely');
 assert.equal(rollingGatherCutoff({cutoff:60000,hardCutoff,idleMs},60001),60000,'a closed window cannot be reopened');
 assert(braxBoardingComplete({cutoff,expectedAgents:['a','b'],members:[{agent:'a',aboard:true},{agent:'b',aboard:true}]},1),'a complete requested cohort still departs immediately');
 console.log('rolling assembly: captured arrival just beyond sixty seconds is included; hard bound, closure and immediate complete-cohort departure retained');
}
{
 const f=JSON.parse(readFileSync(new URL('./fixtures/brax-platform-occupied-pivot.json',import.meta.url))),geo=roomGeometry(579);
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(f.floors).map(([i,height])=>[+i,{height,type:4}])),null,{geometryOf:()=>geo});
 const objects=new Map(f.objects.map(o=>[o.id,o])),options={objects,selfId:f.body.id,minimumFloor:3984,maxRangeSquares:24,marginSquares:4,maxNodes:12000,maxMs:1000};
 assert(!planBodyDetour(geo,f.body,f.wrong_pivot,options).found,'the captured pivot is occupied by a correctly parked fleetmate');
 const route=planBodyDetour(geo,f.body,f.goal,options);assert(route.found,JSON.stringify(route));
 let previous=protocolToClient(f.body);for(const p of route.waypoints){const next=protocolToClient(p),trace=geo.traceFineMoveClient(previous.x,previous.y,next.x,next.y,{slide:false,obstacles:blockingBodySnapshot(objects,f.body.id)});assert(trace.arrived&&!trace.blocked);assert(floorAt(geo,next.x,next.y)>=3984);previous=next;}
 assert(Math.hypot(route.waypoints.at(-1).x-f.goal.x,route.waypoints.at(-1).y-f.goal.y)<=3);
 console.log('captured platform jam: route to the NW lever is proved around an occupied guide without moving the parked character or relaxing floor/body checks');
}

{
 const {runInNewContext}=await import('node:vm'),source=readFileSync(new URL('./m59-brax.mjs',import.meta.url),'utf8'),begin=source.indexOf('  const follow=async('),end=source.indexOf('  const cut=async(',begin);
 for(const [owned,recovery,expected]of [[true,false,1],[false,false,0],[true,true,0]]){
  let cancels=0;const owner='ours',failure=Object.assign(Error('child failed'),{code:1});
  const follow=runInNewContext('(function(){'+source.slice(begin,end)+'return follow;})()',{
   state:{braxConvoyCharacters:['Test']},keeper:{character:'Test'},fleet:'shadow',controlURL:{port:'8991'},agent:'a',ctx:{origin:{}},currentCallOrigin:()=>({}),originLabel:()=>owner,join:(...s)=>s.join('/'),out:'/evidence',id:'a-1',root:'/',process:{execPath:'node'},end:Date.now()+10000,Date,Math,JSON,Error,
   execFile:(_node,_args,_options,done)=>done(failure,'','HeadersTimeoutError UND_ERR_HEADERS_TIMEOUT'),writeFileSync:()=>{},existsSync:()=>true,readFileSync:()=>JSON.stringify({kind:'jump',reply:{jumped:true}}),keeperSurvivalInterruption:()=>false,
   read:async()=>({pid:4,room:{num:579},you:{id:7},movement:{order:{ordered_by:owned?owner:'another'},rail:{phase:'waiting-body'}},autopilot_status:{recovery_travel:recovery?{}:null}}),
   command:async name=>{assert.equal(name,'cancel_movement');cancels++;},log:()=>{}
  });
  await assert.rejects(follow('/route','cliffs'),error=>error.outcome.stderr.includes('UND_ERR_HEADERS_TIMEOUT')&&error.interruption===null&&!error.survival);
  assert.equal(cancels,expected,'a lost child response cancels only its positively observed owned operation, preserving foreign and recovery movement');
 }
 console.log('rail child failure: actual transport cause and native activity are retained; successful old jump replies cannot masquerade as the cause');
}

{
 const {ownedBraxRoadRecovery}=await import('./m59-brax.mjs'),{originLabel}=await import('./m59-move-origin.mjs');
 const origin={source:'fleetscript',name:'walk-to-brax (public)',run_id:'captured'};
 const state={hp:{value:19,max:20},room:{num:589},autopilot_status:{faculties:{movement:{owner:'fleetscript:'+origin.name,expires_in_ms:30000}}},movement:{last_cancel:{at:3000,by:{source:'fleetscript'}},last_preempted:{at:2000,by:{source:'keeper',name:'play_dead'},preempted:{ordered_by:originLabel(origin)}}}};
 assert(ownedBraxRoadRecovery(state,origin,1000),'an exact-run native recovery is retained after the CLI own later cancellation');
 assert(!ownedBraxRoadRecovery(state,origin,2500));assert(!ownedBraxRoadRecovery(state,{...origin,run_id:'another'},1000));
 assert(!ownedBraxRoadRecovery({...state,hp:{value:0,max:20}},origin,1000));
 assert(!ownedBraxRoadRecovery({...state,autopilot_status:{faculties:{movement:{owner:'someone-else',expires_in_ms:30000}}}},origin,1000));
 console.log('captured recovery handoff: only a living exact-run keeper preemption under the current lease permits ordinary road resumption');
}

{
 const {braxLandingProof}=await import('./m59-brax.mjs'),f=JSON.parse(readFileSync(new URL('./fixtures/brax-connected-platform-arrival.json',import.meta.url))),geo=roomGeometry(579),to={row:25,col:56,x:56832,y:25088};
 applyAncientFloors({rooms:{579:{}}},579,new Map(Object.entries(f.observed).map(([id,height])=>[+id,{type:4,height}])),null,{geometryOf:()=>geo});
 assert(braxLandingProof(geo,f,to,4000),'the actual confirmed connected platform is success without re-demanding its old landing cell');
 assert(!braxLandingProof(geo,{...f,you:{...f.you,predicted:true}},to,4000));
 assert(!braxLandingProof(geo,{...f,room:{num:578}},to,4000));
 assert(!braxLandingProof(geo,f,to,12800),'a lower shelf cannot stand in for a raised platform');
 assert(!braxLandingProof(geo,{...f,you:{...f.you,x:100,y:100}},to,4000));
 console.log('captured connected platform arrival: actual floor and ordinary component proof, no exact-cell requirement, predictions and wrong shelves refused');
}
