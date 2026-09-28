#!/usr/bin/env node
// Rebuild every fine-rail dependency of mana-node-tour. Offline; no live claims.
import {writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {bakeNodeRails,railLeg,checkRoute,findRoute,fineEdge,bakeOne,exactFloor} from './m59-noderails.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {epochId} from './m59-epoch.mjs';
import {CIRCUIT_NODES,CIRCUIT_REVISION} from './m59-node-circuit.mjs';
import {roomGeometry,floorAt,edgeOf,floodReport} from './m59-ground.mjs';
import {tourPlan} from './m59-node-tour.mjs';
const args=process.argv.slice(2),out=resolve(args[args.indexOf('--out')+1]&&args.includes('--out')?args[args.indexOf('--out')+1]:'substrate/node-tour-rails.json');
const baked=bakeNodeRails({only:'victoria,sentinel,ancient',onProgress:({node,direction,result})=>console.log(node,direction,result?.ok?'candidate':'no candidate')});
console.log('Badlands exact-endpoint flood at 64 client units (cap 1,500,000)');
const geo=roomGeometry(45),edge=edgeOf(geo),start={x:53856,y:992};
const report=floodReport(geo,start,{row:63,col:46},{lattice:64,cap:1500000,box:0});
if(!report.reached||!report.path?.length)throw Error('Badlands flood: '+report.predicate);
const points=report.path[0].x===start.x&&report.path[0].y===start.y?report.path:[start,...report.path];
const leg=railLeg({waypoints:points},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
const route={direction:'to_node',exit:'strict-flood',exit_label:'strict-flood',from:'r1c53',to:'r63c46',ok:true,
  rail_complete:leg.unvalidated===0,legs:[leg],jumps:0,all_declared:true,waypoints:leg.waypoints.length,aims:leg.aims.length,unvalidated:leg.unvalidated};
const check=checkRoute(route,{edge});if(!check.ok||check.skipped||!route.rail_complete)throw Error('Badlands candidate incomplete');
baked.stones.push({node:'badlands',room:45,routes:[route]});
// Sentinel's walking exit crosses Ancient Place even when its stone is cached.
// Bake the passage itself, without routing through the skipped stone's shelf.
const transitRouter=fineRouter(579),transitGeo=transitRouter.geo;
const transit={direction:'to_node',exit:'east-to-north',from:'r39c71',to:'r1c17',
  ...bakeOne(transitRouter,{x:72192,y:39424},{row:1,col:17},{edge:fineEdge(transitGeo),
    floorAt:exactFloor(transitGeo),bounds:{w:transitRouter.room.cols*1024,h:transitRouter.room.rows*1024}})};
baked.stones.push({node:'ancient-transit',room:579,routes:[transit]});
const selections=Array.from({length:1<<CIRCUIT_NODES.length},(_,mask)=>CIRCUIT_NODES.filter((_,i)=>mask&(1<<i)));
for(const step of selections.flatMap(tourPlan).filter(s=>s.kind==='rail')){
  const selected=findRoute(baked,{node:step.node,direction:step.direction??'to_node',exit:step.exit??null});
  if(!selected)throw Error('Missing selected tour rail: '+JSON.stringify(step));
  const s=baked.stones.find(s=>s.node===step.node),v=checkRoute(selected,{edge:fineEdge(roomGeometry(s.room))});
  if(!v.ok||v.skipped||!selected.rail_complete)throw Error('Selected tour rail incomplete: '+JSON.stringify(step));
}
baked.tour={format:'m59-node-circuit-rails/1',catalog_revision:CIRCUIT_REVISION,movement_epoch:epochId(),
  validation:'offline geometry only; subset connectors need live trials'};
mkdirSync(dirname(out),{recursive:true});const temporary=out+'.'+process.pid+'.tmp';
writeFileSync(temporary,JSON.stringify(baked));renameSync(temporary,out);
writeFileSync(out.endsWith('.json')?out.replace(/\.json$/,'.badlands-proof.json'):out+'.badlands-proof.json',JSON.stringify(report));
console.log(JSON.stringify({out,badlands_visited:report.visited,waypoints:route.waypoints,aims:route.aims,check}));
