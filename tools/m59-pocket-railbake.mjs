#!/usr/bin/env node
// Offline, deterministic fine escape proofs; no broker, sockets or roster.
import fs from 'node:fs';
import {loadMap} from './m59-map.mjs';
import {sharedRoomGeometry,STEP_MASK_VERSION} from './m59-roo.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import {routesFor,bakedPath} from './m59-routes.mjs';
import {fineChokeWidth,validateEscape} from './m59-pocket-rails.mjs';
const map=loadMap(),rooms={},table=routesFor(map.geometryManifestSha256);
const seeds=[
 [598,2405,2122,30,21,1,18,65,19], [598,2428,2116,30,21,1,18,65,19],
 [598,2267,2122,30,21,1,18,65,19], [598,699,1572,25,21,1,18,65,19],
 [598,1036,2165,35,20,1,18,65,19],
 [578,1072,2928,44,19,49,12,1,13], [578,880,2480,24,25,49,44,1,13],
];
for(const [room,x,y,row,col,lr,lc,er,ec] of seeds) {
 const geo=sharedRoomGeometry(map.rooms[room]),from={x,y,row:Math.floor(y/64),col:Math.floor(x/64)},board={row,col};
 const plan=planBodyDetour(geo,from,geo.standPointWire(row,col),{goalSquare:board,marginSquares:12,
   maxRangeSquares:24,spacingUnits:16,maxNodes:30000,maxMs:10000});
 if(!plan.found||!validateEscape(geo,from,plan.waypoints).ok)throw Error(`Unproved pocket escape in room ${room} from r${from.row}c${from.col}`);
 const lineFrom={row:lr,col:lc},exit={row:er,col:ec},line=bakedPath(table,room,lineFrom,exit);
 const index=line?.findIndex(q=>q.row===row&&q.col===col);if(index==null||index<0)throw Error('Boarding point is not on its rail');
 const legs=[...plan.waypoints];let at=legs.at(-1)??from;
 // Continue from the ACTUAL fine landing, not the square's nominal stand point.
 // Every suffix bend is baked with the same quantized microstep predicate.
 for(const next of line.slice(index+1)){
   const part=planBodyDetour(geo,at,geo.standPointWire(next.row,next.col),{goalSquare:next,
     marginSquares:12,maxRangeSquares:24,spacingUnits:16,maxNodes:30000,maxMs:10000});
   if(!part.found)throw Error(`Unproved onward leg in ${room} to r${next.row}c${next.col}`);
   legs.push(...part.waypoints);at=legs.at(-1)??at;
 }
 if(!validateEscape(geo,from,legs).ok)throw Error('Full fine escape failed validation');
 const r=rooms[room]??= {security:geo.security,rows:geo.rows,cols:geo.cols,rails:[],chokes:[]};
 r.rails.push({from,boarding:board,board:exit,line_from:lineFrom,exit,legs});
}
for(const p of [{room:598,x:2080,y:1632},{room:598,x:1502,y:1707}]) {
 const {room,...point}=p,proof=fineChokeWidth(sharedRoomGeometry(map.rooms[room]),point);
 if(!proof?.narrow)throw Error(`Unproved fine choke in ${room}: ${JSON.stringify(proof)}`);
 rooms[room].chokes.push({...point,...{row:Math.floor(point.y/64),col:Math.floor(point.x/64)},clearance:proof});
}
const file=new URL('../substrate/m59-pocket-rails.json',import.meta.url);
fs.writeFileSync(file,JSON.stringify({format:'m59-pocket-rails/1',geometryManifestSha256:map.geometryManifestSha256,
 stepMaskVersion:STEP_MASK_VERSION,units:'KOD/protocol fine units; 64 per square',rooms},null,2)+'\n');
console.log(JSON.stringify({file:file.pathname,rooms:Object.keys(rooms),rails:seeds.length,chokes:2}));
