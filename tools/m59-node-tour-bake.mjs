#!/usr/bin/env node
// Rebuild every fine-rail dependency of mana-node-tour. Offline; no live claims.
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {bakeNodeRails,railLeg,checkRoute,findRoute,fineEdge} from './m59-noderails.mjs';
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
for(const step of tourPlan().filter(s=>s.kind==='rail')){
  const selected=findRoute(baked,{node:step.node,direction:step.direction??'to_node',exit:step.exit??null});
  if(!selected)throw Error('Missing selected tour rail: '+JSON.stringify(step));
  const s=baked.stones.find(s=>s.node===step.node),v=checkRoute(selected,{edge:fineEdge(roomGeometry(s.room))});
  if(!v.ok||v.skipped||!selected.rail_complete)throw Error('Selected tour rail incomplete: '+JSON.stringify(step));
}
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(baked));
writeFileSync(out.replace(/\.json$/,'.badlands-proof.json'),JSON.stringify(report));
console.log(JSON.stringify({out,badlands_visited:report.visited,waypoints:route.waypoints,aims:route.aims,check}));
