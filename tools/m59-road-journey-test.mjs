import { readToolSource } from './autopilot/source.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {followRoadJourney,roadTrafficGap} from './m59-road-journey.mjs';
import {journeyTrafficWait} from './m59-trip-telemetry.mjs';
import {rtsJobReport} from './m59-rts-safety.mjs';
import {roomGeometry} from './m59-ground.mjs';
const raw={arrived:false,room:{num:39},destination:589,refusals:[{stage:'walk',why:'object_blocked',stand_on:{row:9,col:27}},{stage:'walk',why:'object_blocked',stand_on:{row:8,col:27}}]};
const traffic=journeyTrafficWait(raw);assert.deepEqual(traffic,{room:39,to:589,exits:[{row:9,col:27},{row:8,col:27}]});
for(const result of [{...raw,arrived:true},{...raw,refusals:[]},{...raw,refusals:[...raw.refusals,{stage:'walk',why:'geometry_blocked',stand_on:{row:9,col:27}}]},{...raw,refusals:raw.refusals.map(r=>({...r,crossing_packet_sent:true}))}])assert.equal(journeyTrafficWait(result),null);
const report=rtsJobReport({kind:'travel',label:'road',origin:{source:'fleetscript',name:'test',run_id:'run'},startedAt:1,finishedAt:5000,done:true,result:raw},5000);
assert.deepEqual(report.traffic_wait,{...traffic,finished_at:5000});
assert.equal(rtsJobReport({kind:'travel',label:'road',startedAt:1,finishedAt:5000,done:true,cancelled:true,result:raw},5000).traffic_wait,undefined,'cancellation never authorizes a traffic retry');
const fixture=JSON.parse(readToolSource(new URL('./fixtures/road-crowd-choke.json',import.meta.url))),geo=roomGeometry(39),you={...fixture.actors[13],predicted:false};
const blocked={room:{num:39},you,objects:[8,9].flatMap(row=>[8,24,40,56].flatMap(x=>[8,24,40,56].map(y=>({id:row*10000+x*100+y,flags:5,x:27*64+x,y:row*64+y}))))};
assert.equal(roadTrafficGap(geo,blocked,traffic),false,'occupied exit goals cannot authorize another walk');
const clear={...blocked,objects:[]};assert(roadTrafficGap(geo,clear,traffic),'the real castle geometry proves a cleared exit');
assert.equal(roadTrafficGap(geo,{...clear,you:{...you,predicted:true}},traffic),false);
assert.equal(roadTrafficGap(geo,{...clear,room:{num:38}},traffic),false);
let clock=0,departures=[];
const job={failed:'route_progressing_exits_exhausted',ordered_by:'ours',traffic_wait:{...traffic,finished_at:1}};
assert(await followRoadJourney({read:async()=>departures.length>=2?{room:{num:589}}:{...(clock<7000?blocked:clear),...(departures.length?{job}:{})},command:async(name,args)=>{assert.equal(name,'travel');departures.push({at:clock,args});return{};},owner:'ours',to:589,deadline:12000,now:()=>clock,wait:async ms=>{clock+=ms;},trafficReady:(s,t)=>roadTrafficGap(geo,s,t)}));
assert.equal(departures.length,2);assert(departures[1].at>=7000,'no duplicate retry while the next path is occupied');
assert(departures.every(d=>d.args.background===true));
clock=0;departures=[];
assert(await followRoadJourney({read:async()=>departures.length>=2?{room:{num:579}}:{room:{num:589},hp:{value:clock<4000?19:20,max:20}},command:async(name,args)=>{assert.equal(name,'travel');departures.push({at:clock,args});return departures.length===1?{started:false,refused:'too_hurt',floor:1}:{};},owner:'ours',to:579,deadline:10000,now:()=>clock,wait:async ms=>{clock+=ms;}}));
assert.equal(departures.length,2);assert(departures[1].at>=4000);assert(departures.every(d=>!('health_floor' in d.args)&&!('waiver' in d.args)),'the source health floor is waited for, never waived');
console.log('road queue: native refusal proof, real body clearance, no overlapping driver, and exact health readiness passed');

// A fine controller is not goTravelling. Its generation still must be stopped
// before an unarmed mana detour, with ownership observable until it ends.
{
 const {Autopilot}=await import('./m59-autopilot.mjs');let cancelled=0,finish;
 const k={s:{movementGeneration:7,moveOrder:{kind:'walk',origin:{source:'fleetscript'}}},inert:null,suspendedJourney:{to:827},
  cancelForSurvival:()=>{cancelled++;k.s.movementGeneration++;},ledgerEvent:()=>{},travel:async()=>await new Promise(r=>{finish=r;})};
 const pending=Autopilot.prototype.recoveryTravel.call(k,801);
 assert.equal(cancelled,1);assert.equal(k.s.movementGeneration,8);assert.equal(k.s.keeperRecoveryTravel.to,801);assert.equal(k.suspendedJourney.to,827);
 finish({arrived:true});assert((await pending).arrived);assert.equal(k.s.keeperRecoveryTravel,null);
 k.travel=async()=>{throw Error('route refused');};await assert.rejects(Autopilot.prototype.recoveryTravel.call(k,801),/route refused/);assert.equal(k.s.keeperRecoveryTravel,null,'failed trips release their own marker');
}
clock=0;departures=[];
assert(await followRoadJourney({read:async()=>departures.length?{room:{num:579}}:{room:{num:801},...(clock<1500?{autopilot_status:{recovery_travel:{id:'native-trip',to:801}},job:{busy:'keeper road',ordered_by:'keeper:recovery_detour'}}:{})},command:async()=>{departures.push(clock);return{};},owner:'ours',to:579,deadline:10000,now:()=>clock,wait:async ms=>{clock+=ms;}}));
assert.deepEqual(departures,[1500],'the public road waits for the actual protected trip rather than fighting its driver');

{
 const {planBodyDetour}=await import('./m59-body-detour.mjs');
 const {clientToProtocol,squareCentreClient}=await import('./m59-finepos.mjs');
 const f=JSON.parse(readToolSource(new URL('./fixtures/road-distant-traffic.json',import.meta.url))),g=roomGeometry(f.room),e=f.traffic.exits[0],goal=clientToProtocol(squareCentreClient(e.row,e.col));
 assert.equal(planBodyDetour(g,f.you,goal,{objects:new Map(),maxRangeSquares:64}).reason,'body detour exceeds local bounds','ordinary local planner retains its default scope');
 assert(roadTrafficGap(g,{room:{num:f.room},you:f.you,objects:f.objects},f.traffic),'a distant exit cannot make a physically clear road wait forever behind the local planner limit');
 const blockers=f.traffic.exits.flatMap((e,i)=>[8,24,40,56].flatMap(x=>[8,24,40,56].map(y=>({id:100000+i*10000+x*100+y,flags:5,x:e.col*64+x,y:e.row*64+y}))));
 assert(!roadTrafficGap(g,{room:{num:f.room},you:f.you,objects:[...f.objects,...blockers]},f.traffic),'distant planning still cannot admit occupied exit footprints');
 console.log('road admission: captured distant cavern exit is checked within explicit bounded scope; local default and live bodies remain guarded');
}

{
 const {planBodyDetour}=await import('./m59-body-detour.mjs'),{clientToProtocol,squareCentreClient,protocolToClient}=await import('./m59-finepos.mjs');
 const {blockingBodySnapshot}=await import('./m59-body-detour.mjs');
 const f=JSON.parse(readToolSource(new URL('./fixtures/road-narrow-body-gap.json',import.meta.url))),g=roomGeometry(f.room),e=f.traffic.exits[1],goal=clientToProtocol(squareCentreClient(e.row,e.col)),objects=new Map(f.objects.map(o=>[o.id,o]));
 const options={goalSquare:e,objects,selfId:f.you.id,maxRangeSquares:12,marginSquares:4,maxNodes:6000,maxMs:300};
 assert.equal(planBodyDetour(g,f.you,goal,options).found,false,'ordinary default retains the captured eight-unit lattice and refusal contract');
 const plan=planBodyDetour(g,f.you,goal,{...options,refine:true});assert(plan.found);assert.equal(plan.refinedSpacingUnits,4);assert(plan.nodes<=6000);
 let from=protocolToClient(f.you);for(const point of plan.waypoints){const to=protocolToClient(point),trace=g.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(objects,f.you.id)});assert(trace.arrived&&!trace.blocked);from=to;}
 assert(roadTrafficGap(g,{room:{num:f.room},you:f.you,objects:f.objects},f.traffic),'admission uses the same refined physical proof');
 console.log('road narrow gap: finer search resolves the captured worm crowd, with every emitted segment retaining stock body and wall checks');
}


{
 const f=JSON.parse(readToolSource(new URL('./fixtures/road-switchback-traffic.json',import.meta.url))),g=roomGeometry(f.room);
 const {planBodyDetour,blockingBodySnapshot}=await import('./m59-body-detour.mjs'),{protocolToClient}=await import('./m59-finepos.mjs');
 const e=f.traffic.exits[0],goal={x:e.col*64+32,y:e.row*64+32};
 assert(!planBodyDetour(g,f.you,goal,{goalSquare:e,objects:new Map(),maxRangeSquares:8,marginSquares:3,maxNodes:6000,maxMs:300}).found,'captured short-distance search box excludes the legal switchback');
 assert(roadTrafficGap(g,{room:{num:f.room},you:f.you,objects:f.objects},f.traffic),'an empty Victoria exit cannot wait forever because the path first bends away from its goal');
 const plan=planBodyDetour(g,f.you,goal,{goalSquare:e,objects:new Map(),maxRangeSquares:8,marginSquares:6,maxNodes:6000,maxMs:300});assert(plan.found);assert(plan.nodes<=6000);
 let from=protocolToClient(f.you);for(const p of plan.waypoints){const to=protocolToClient(p),trace=g.traceFineMoveClient(from.x,from.y,to.x,to.y,{slide:false,obstacles:blockingBodySnapshot(new Map(),f.you.id)});assert(trace.arrived&&!trace.blocked);from=to;}
 console.log('road switchback: captured Victoria holdout uses a wider bounded search without changing collision rules');
}

// A cached arrival cannot hand the character to a fine controller while its
// ordered actual position still belongs to the previous room.
{
 let clock=0,reads=0,commands=0;
 assert(await followRoadJourney({read:async()=>({room:{num:589}}),confirmArrival:async()=>{reads++;return {room:{num:clock<1500?579:589}};},command:async()=>{commands++;throw Error('do not duplicate an existing arrival');},owner:'ours',to:589,deadline:5000,now:()=>clock,wait:async ms=>{clock+=ms;}}));
 assert.equal(commands,0);assert(reads>=4);assert(clock>=1500);
 console.log('road-to-fine handoff requires an ordered actual arrival, preserving single dispatch');
}
