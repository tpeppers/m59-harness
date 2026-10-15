// Offline regenerable directional walks. Jump legs remain separate declared
// affordances, and open-door walks are only usable after a live geometry proof.
import {writeFileSync} from 'node:fs';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {previewOpenedDoor} from './m59-ceiling-doors.mjs';
import {cutRail,chordWalkable} from './m59-railcut.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {STEP_MASK_VERSION} from './m59-roo.mjs';
const p=(row,col)=>({x:col*64+32,y:row*64+32});
const specs=[{room:2505,walks:[
 ['mainland_to_takeoff',p(72,2),p(27,60)],
 ['landing_to_second_takeoff',p(27,65),p(46,80)],
 ['second_landing_to_gate',p(46,84),{x:4029,y:385}],
 ['gate_to_return_takeoff',p(6,61),p(27,64),1],
 ['return_refuge_to_mainland',{x:3896,y:1472},p(72,2)],
 ['button_to_island_exit',p(6,63),p(5,57),1],
 ['island_exit_to_button',p(5,57),p(6,61)],
 ['north_gutter_to_refuge',p(26,63),p(33,59)],
 ['south_gutter_to_refuge',p(29,63),p(33,59)],
 ['gutter_refuge_to_mainland',p(33,59),p(72,2)],
 ['gutter_refuge_to_gate',p(33,59),{x:4029,y:385}],
 ]}];
const map=loadMap(),rooms={};
for(const spec of specs){const base=roomGeometry(spec.room),guides=[];
 for(const [name,from,to,door]of spec.walks){const geo=door?previewOpenedDoor(map,spec.room,door).geometry:base;
  const edge=(a,b)=>{const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});return t.arrived&&!t.blocked;};
  const a=protocolToClient(from),b=protocolToClient(to),cut=cutRail(a,b,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice:128});
  if(!cut.ok||!cut.bridgeOk)throw Error('unproved fine guide '+spec.room+' '+name);
  const end=cut.waypoints.at(-1);if(!chordWalkable(end,b,{edge,lattice:128}).ok)throw Error('unproved exact guide endpoint '+name);
  if(end.x!==b.x||end.y!==b.y)cut.waypoints.push(b);
  const waypoints=cut.waypoints.map(q=>({x:q.x,y:q.y}));guides.push({name,from,to,...(door?{requires_open_door:door}:{}),waypoints});
  console.log(JSON.stringify({room:spec.room,name,points:waypoints.length}));
 }
 rooms[spec.room]={security:base.security,rows:base.rows,cols:base.cols,guides,
  traversals:[
   {from:{row:72,col:1},to:{row:5,col:57},to_room:2000,legs:[
    {walk:'mainland_to_takeoff'},{jump:{from:{row:27,col:60},to:{row:27,col:65}},missed:'north_gutter_to_refuge'},
    {walk:'landing_to_second_takeoff'},{jump:{from:{row:46,col:80},to:{row:46,col:84}}},
    {walk:'second_landing_to_gate'},{operate_door:1},{walk:'button_to_island_exit'}]},
   {from:{row:5,col:57},to:{row:72,col:1},to_room:2504,legs:[
    {walk:'island_exit_to_button'},{operate_door:1},{walk:'gate_to_return_takeoff'},
    {jump:{from:{row:27,col:64},to:{row:23,col:60}},missed:'north_gutter_to_refuge'},{walk:'return_refuge_to_mainland'}]}
  ]};
}
writeFileSync(new URL('../substrate/m59-fine-guides.json',import.meta.url),JSON.stringify({format:'m59-fine-guides/1',coordinates:'CLIENT/BSP x,y (1024 units per square)',stepMaskVersion:STEP_MASK_VERSION,geometryManifestSha256:map.geometryManifestSha256,rooms})+'\n');
