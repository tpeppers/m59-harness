// Convert a saved exact-endpoint ground flood into a checked noderails candidate.
// Offline only. No claim about a live body or a meld.
// node tools/m59-node-rail-import.mjs flood.json badlands output.json
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {roomGeometry,floorAt,edgeOf} from './m59-ground.mjs';
import {railLeg,checkRoute,NODERAIL_VERSION} from './m59-noderails.mjs';
import {STONES} from './m59-stones.mjs';
const [input,node,output]=process.argv.slice(2);
if(!input||!STONES[node]||!output)throw Error('Need flood.json, stone key, output.json');
const raw=readFileSync(input),report=JSON.parse(raw),stone=STONES[node],geo=roomGeometry(stone.room);
if(!report.reached||report.lattice!==64||!report.path?.length)throw Error('Need a successful 64-client-unit exact-endpoint flood');
const first=report.path[0],from=report.from;
const waypoints=(from.x===first.x&&from.y===first.y)?report.path:[from,...report.path];
const edge=edgeOf(geo),leg=railLeg({waypoints},{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},floorAt:(x,y)=>floorAt(geo,x,y)});
const sq=p=>`r${Math.floor(p.y/1024)+1}c${Math.floor(p.x/1024)+1}`;
const route={direction:'to_node',exit:'strict-flood',exit_label:'strict-flood',from:sq(from),to:`r${stone.row}c${stone.col}`,
  ok:true,rail_complete:leg.unvalidated===0,legs:[leg],jumps:0,all_declared:true,confidence:'offline exact-endpoint flood candidate',
  waypoints:leg.waypoints.length,aims:leg.aims.length,unvalidated:leg.unvalidated,committing_drops:leg.committing_drops.length};
const check=checkRoute(route,{edge});
if(!check.ok||check.skipped||!route.rail_complete)throw Error('Candidate did not validate: '+JSON.stringify(check));
const result={version:NODERAIL_VERSION,at:new Date().toISOString(),source:{input,sha256:createHash('sha256').update(raw).digest('hex')},
  stones:[{node,room:stone.room,stone:{row:stone.row,col:stone.col},routes:[route]}]};
writeFileSync(output,JSON.stringify(result));console.log(JSON.stringify({output,waypoints:route.waypoints,aims:route.aims,check}));
