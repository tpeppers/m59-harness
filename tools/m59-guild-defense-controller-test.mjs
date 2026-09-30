import assert from 'node:assert/strict';
import {M59Client,BP} from './m59-client.mjs';
import {loadMap} from './m59-map.mjs';
import {World} from './m59-world.mjs';
import {Autopilot,HANDLED,CONTINUE} from './m59-autopilot.mjs';
import {ensureReplayHallDoors,respondWithRecovery,observedHallSection,
  defenseAssemblyPoint,recoverGuildPassage} from './m59-guild-defense-controller.mjs';
assert.equal(observedHallSection({world:{room:{num:714}},client:{}}),null,'room packet may precede the player object');
assert.equal(observedHallSection({world:{room:{num:714}},client:{self:{row:NaN,col:8}}}),null);
assert.equal(observedHallSection({world:{room:{num:39}},client:{self:{row:7,col:8}}}),null);
assert.equal(observedHallSection({world:{room:{num:714}},client:{self:{row:2,col:32}}}),0);
assert.equal(observedHallSection({world:{room:{num:714}},client:{self:{row:7,col:8}}}),3);
const slots=Array.from({length:20},(_,i)=>defenseAssemblyPoint(i));
assert.equal(new Set(slots.map(s=>JSON.stringify(s))).size,20);
for(const self of slots)assert.equal(observedHallSection({world:{room:{num:714}},client:{self}}),2);
{
  const keeper={s:{world:{room:{num:714}},client:{self:{row:20,col:10}}}};
  let attempts=0;
  const result=await recoverGuildPassage(keeper,2,{retryMs:0,passage:async()=>{if(++attempts===1)throw Error('trigger temporarily blocked');}});
  assert.equal(result.attempts,2);
  attempts=0;
  await assert.rejects(recoverGuildPassage(keeper,2,{maxAttempts:2,retryMs:0,
    passage:async()=>{attempts++;throw Error('blocked');}}),/budget exhausted/);
  assert.equal(attempts,2);
  attempts=0;
  await assert.rejects(recoverGuildPassage(keeper,2,{stopped:()=>true,
    passage:async()=>{attempts++;}}),/stopped/);
  assert.equal(attempts,0);
}
const map=loadMap();
function session(){
  const client=new M59Client({host:'127.0.0.1',port:1,log(){}});
  client.roomNameRsc=map.rooms[714].nameRsc;client.roomRsc=map.rooms[714].roomRsc;
  return {client,world:new World(client,map)};
}
const a=session(),b=session();
assert.equal(ensureReplayHallDoors(a),true);
assert.equal(ensureReplayHallDoors(a),false);
assert.equal(a.world.geometry.path(3,28,5,28).found,false);
a.client.onGameMessage(BP.SECTOR_MOVE,Buffer.from([5,59,0,190,0,50]));
assert.equal(a.world.geometry.path(3,28,5,28).found,true);
ensureReplayHallDoors(b);
assert.equal(b.world.geometry.path(3,28,5,28).found,false);
assert.equal(a.world.geometry.path(3,28,5,28).found,true,'another actor cannot close the first actor\'s geometry');
const old=a.client, replacement=session();a.client=replacement.client;a.world=replacement.world;
assert.equal(ensureReplayHallDoors(a),true,'a reconnect installs an observer on the new client');
old.onGameMessage(BP.SECTOR_MOVE,Buffer.from([5,59,0,190,0,0]));
assert.equal(a.world.geometry.path(3,28,5,28).found,false,'old socket cannot mutate replacement geometry');
a.client.onGameMessage(BP.SECTOR_MOVE,Buffer.from([5,59,0,190,0,0]));
assert.equal(a.world.geometry.path(3,28,5,28).found,true);

function keeper(){
  const seen=[],k=Object.assign(Object.create(Autopilot.prototype),{
    s:{world:{room:{num:599}},runCommand:async f=>{seen.push('command');return f();}},
    policy:{decideMs:0},passes:0,running:true,stopping:false,tally:{deaths:0},
    goTravelling(why,{to}){this.inert={travelling:true,why,to};},
    travel:async()=>({arrived:false,reason:'survival pause'}),revive(){this.inert=null;},
    hitDamageTotal:()=>0,purseNow:()=>0,spend(){},note(){},notePassSucceeded(){},
    notePassFailed(e){throw e;},
    async pass(){seen.push('survival');await this.passFarm({});},
    async resumeSuspendedJourney(){seen.push('resume');assert.equal(this.suspendedJourney.to,714);
      this.suspendedJourney=null;this.s.world.room.num=714;return HANDLED;}
  });
  return {k,seen};
}
const f=keeper(),original=f.k.pass;
const result=await respondWithRecovery(f.k,714,{alive:()=>true,stopped:()=>false,handled:HANDLED,continueStage:CONTINUE});
assert.equal(result.arrived,true);assert.deepEqual(f.seen,['command','survival','resume']);
assert.equal(f.k.passes,1,'uses the real keeper loop and watchdog accounting');
assert.equal(f.k.pass,original);assert.equal(Object.hasOwn(f.k,'passFarm'),false);
assert.equal(f.k.stopping,false,'arrival hands control to the hall controller');
for(const cause of ['stop','death']){
  const x=keeper();let alive=true,stopped=false;
  x.k.pass=async()=>{if(cause==='stop')stopped=true;else alive=false;};
  const r=await respondWithRecovery(x.k,714,{alive:()=>alive,stopped:()=>stopped,handled:HANDLED,continueStage:CONTINUE});
  assert.equal(r.arrived,false);assert.equal(x.k.stopping,true);
  assert.equal(x.k.passes,1,'terminal state must not resume or respawn');
}
const early=keeper();early.k.travel=()=>assert.fail('stopped response dispatched movement');
await respondWithRecovery(early.k,714,{alive:()=>true,stopped:()=>true});
console.log('Guild defense: native door packets, session isolation, reconnect, recovery loop, stop/death and restoration passed');
