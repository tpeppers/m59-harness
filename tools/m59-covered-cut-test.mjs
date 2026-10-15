import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {cutFineRailAsync,fineRefugeReturnable} from './m59-fine-rail.mjs';
import {blockingBodySnapshot,planBodyDetour} from './m59-body-detour.mjs';
import {knownRefugeCell} from './m59-refuge-activation.mjs';
import {protocolToClient} from './m59-finepos.mjs';
const f=JSON.parse(readFileSync(new URL('./fixtures/konima-covered-cut-2505.json',import.meta.url))),geo=roomGeometry(f.room);
const objects=new Map(f.bodies.map(o=>[o.id,o]));
const options={maxMs:4000,objects,selfId:f.from.id,bodyRangeSquares:10,
 allowBodyPrefix:true,prefixSquares:4,requirePrefixRefuge:true,excludedPrefixStops:new Set(['31,57'])};
const p=await cutFineRailAsync(geo,f.from,f.target,options);
assert(p.ok&&p.partial&&p.refuge,JSON.stringify(p));
assert.deepEqual(p.refuge,{row:31,col:54});
assert.equal(p.refuge_return_proved,true);
let previous=protocolToClient(f.from),distance=0;
const bodies=blockingBodySnapshot(objects,f.from.id);
for(const q of p.waypoints){const t=geo.traceFineMoveClient(previous.x,previous.y,q.x,q.y,{slide:false,obstacles:bodies});
 assert(t.arrived&&!t.blocked);distance+=Math.hypot(q.x-previous.x,q.y-previous.y)/1024;previous=q;}
assert(distance<=6);assert.equal(Math.floor(previous.x/1024)+1,54);assert.equal(Math.floor(previous.y/1024)+1,31);
const excluded=await cutFineRailAsync(geo,f.from,f.target,{...options,excludedPrefixStops:new Set(['31,57','31,54'])});
assert(!excluded.refuge||excluded.refuge.row!==31||excluded.refuge.col!==54,'an excluded stop cannot reappear as an alternative');
console.log('A covered fine-cut traffic wait first tries the recorded three-square alternative refuge with live-body proof and visited-stop exclusions.');
// A real Hollows wall can be entered by an ordinary one-way descent, but it
// cannot return to this takeoff rail. It is not a traffic waiting alternative.
const hg=roomGeometry(2502),anchor={x:2201,y:2650},lower={x:2241,y:2322,row:36,col:35};
assert(knownRefugeCell(hg,lower));
const bounds={marginSquares:4,maxRangeSquares:8,maxNodes:10000,maxMs:1000};
assert(planBodyDetour(hg,anchor,lower,bounds).found,'the covered lower wall is ordinarily reachable');
assert.equal(fineRefugeReturnable(hg,lower,anchor,bounds),false,'a one-way covered drop cannot strand a traffic detour below its rail');
