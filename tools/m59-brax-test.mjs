import {planBodyDetour,blockingBodySnapshot} from './m59-body-detour.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {squareCentreClient} from './m59-finepos.mjs';
import {chordWalkable} from './m59-railcut.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {platformSlot,cornerWork,braxArrival,groupJournal,platformAims,CORNERS,departureSlot,keeperSurvivalInterruption,readyAfterSurvival} from './m59-brax.mjs';
import {roomGeometry,floorAt} from './m59-ground.mjs';
import {applyAncientFloors} from './m59-moving-platform.mjs';
import {script} from './fleetscripts/walk-to-brax.mjs';
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
