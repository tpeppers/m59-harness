import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {planFineRailRefugeAsync} from './m59-fine-rail.mjs';
import {sessionWalkPrototype} from './m59-session-walk.mjs';
import {validateEscape} from './m59-pocket-rails.mjs';
const f=JSON.parse(readFileSync(new URL('./fixtures/ugol-covered-body-traffic.json',import.meta.url))),geo=roomGeometry(f.room);
const objects=new Map(f.bodies.map(o=>[o.id,o]));
const blocked=await planFineRailRefugeAsync(geo,f.from,f.goal,{maxLeg:28,objects,selfId:1,maxMs:4000});
assert.equal(blocked.found,false);assert.deepEqual(blocked.waiting_refuge,{row:8,col:3});
const clear=await planFineRailRefugeAsync(geo,f.from,f.goal,{maxLeg:28,maxMs:4000});
assert(clear.found&&clear.steps<=28);assert(validateEscape(geo,f.from,clear.waypoints).ok);
// The actual required executor waits at cover, wakes the room through a normal
// turn, then re-proves the route from a new scene. No refused path is walked.
let turns=0,walks=0,reads=0;
const c={state:'game',self:{...f.from,degrees:0},room:{id:77,objects,flags:0},me:{name:'offline courier'},
 vitals:()=>({health:{value:20,max:20}}),face:()=>{turns++;}};
const s={client:c,live:true,need:()=>c,world:{geometry:geo,room:loadMap().rooms[f.room],map:loadMap()},movementGeneration:4,
 movementWasCancelled:()=>false,threatsHere:()=>[],pacer:{submit:async(_kind,fn)=>fn()},
 confirmFinePosition:async()=>({...c.self,room_object_id:77,at:Date.now()}),
 confirmPosition:async()=>{reads++;if(turns)c.room.objects=new Map();return c.self;},
 walkDepartureLegs:async points=>{assert(turns===1&&reads>0,'no walk before waking and re-observing the room');walks++;
  assert(validateEscape(geo,c.self,points).ok);const p=points.at(-1);Object.assign(c.self,p,{row:Math.floor(p.y/64),col:Math.floor(p.x/64)});return {arrived:true};}};
const r=await sessionWalkPrototype({}).crossBySafeLegs.call(s,{stand_on:f.goal,to:2501},
 {policy:{rooms:[2500],required:true,fineLegs:true,maxLeg:28}});
assert(r.handed_over);assert.equal(turns,1);assert(walks>0);assert(r.refuge_traffic_waits>0);assert.equal(r.failed,0);
console.log('The real required safe-leg executor wakes and waits at actual Ugol cover, then walks only a freshly proved route.');
