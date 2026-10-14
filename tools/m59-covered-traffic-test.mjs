import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {planFineRailRefugeAsync} from './m59-fine-rail.mjs';
import {sessionWalkPrototype} from './m59-session-walk.mjs';
import {validateEscape} from './m59-pocket-rails.mjs';
import {legWalls} from './m59-safelegs.mjs';
import {blockingBodySnapshot} from './m59-body-detour.mjs';
const f=JSON.parse(readFileSync(new URL('./fixtures/ugol-covered-body-traffic.json',import.meta.url))),geo=roomGeometry(f.room);
const objects=new Map(f.bodies.map(o=>[o.id,o]));
const blocked=await planFineRailRefugeAsync(geo,f.from,f.goal,{maxLeg:28,objects,selfId:1,maxMs:4000});
assert(blocked.found&&blocked.alternative_refuge&&blocked.steps<=28);
assert.notDeepEqual({row:blocked.row,col:blocked.col},{row:8,col:3});
assert(validateEscape(geo,f.from,blocked.waypoints,{obstacles:blockingBodySnapshot(objects,1)}).ok);
const waiting=await planFineRailRefugeAsync(geo,f.from,f.goal,{maxLeg:28,objects,selfId:1,maxMs:4000,
 occupied:new Set(legWalls(geo).map(w=>w.row+','+w.col))});
assert.equal(waiting.found,false);assert.deepEqual(waiting.waiting_refuge,{row:8,col:3});
const clear=await planFineRailRefugeAsync(geo,f.from,f.goal,{maxLeg:28,maxMs:4000});
assert(clear.found&&clear.steps<=28);assert(validateEscape(geo,f.from,clear.waypoints).ok);
// The actual required executor takes another proved refuge lane, then uses a
// fresh scene there. No refused path is walked and no refuge is repeated.
let turns=0,walks=0,reads=0;
const c={state:'game',self:{...f.from,degrees:0},room:{id:77,objects,flags:0},me:{name:'offline courier'},
 vitals:()=>({health:{value:20,max:20}}),face:()=>{turns++;}};
const s={client:c,live:true,need:()=>c,world:{geometry:geo,room:loadMap().rooms[f.room],map:loadMap()},movementGeneration:4,
 movementWasCancelled:()=>false,threatsHere:()=>[],pacer:{submit:async(_kind,fn)=>fn()},
 confirmFinePosition:async()=>({...c.self,room_object_id:77,at:Date.now()}),
 confirmPosition:async()=>{reads++;return c.self;},
 walkDepartureLegs:async points=>{walks++;
  assert(validateEscape(geo,c.self,points,{obstacles:blockingBodySnapshot(c.room.objects,1)}).ok);const p=points.at(-1);Object.assign(c.self,p,{row:Math.floor(p.y/64),col:Math.floor(p.x/64)});
  c.room.objects=new Map();return {arrived:true};}};
const r=await sessionWalkPrototype({}).crossBySafeLegs.call(s,{stand_on:f.goal,to:2501},
 {policy:{rooms:[2500],required:true,fineLegs:true,maxLeg:28}});
assert(r.handed_over);assert(walks>1);assert.equal(new Set(r.walls).size,r.walls.length);assert.equal(r.failed,0);
console.log('The required executor takes a collision-proved alternative refuge; exhausted alternatives retain a covered wait.');
