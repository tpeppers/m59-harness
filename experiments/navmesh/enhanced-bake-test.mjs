// Focused compiler integration checks. All navigation is offline; no game sockets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {loadMap} from '../../tools/m59-map.mjs';
import {RoomGeometry,applySectorHeights,protocolToClient} from '../../tools/m59-roo.mjs';
import {geometryIdentity,attachNavMesh,planNavMesh,proveNavMeshWalk} from '../../tools/m59-navmesh.mjs';
import {packNavMesh,unpackNavMesh} from '../../tools/m59-navmesh-codec.mjs';
import {buildEnhancedRoom,normalizeStoredNavMeshWalks} from './enhanced-bake.mjs';
import {assessPath} from './compare.mjs';

const map=loadMap(),doors=JSON.parse(fs.readFileSync(new URL('../../substrate/m59-ceiling-doors.json',import.meta.url)));
const geometry=(room,state=null)=>{const geo=RoomGeometry.fromJSON(map.rooms[room].roo);geo.roomNum=room;if(state){const s=doors.rooms[room].states[state];applySectorHeights(geo,s.sectors,{mask:Buffer.from(s.mask,'base64')});}return geo;};
const client=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
let checks=0;
const passed=name=>{checks++;console.log(`ok ${checks} - ${name}`);};
const compile=(geo,opts={})=>buildEnhancedRoom(geo,{room:geo.roomNum,roomDefinition:map.rooms[geo.roomNum],...opts});
const route=(geo,mesh,from,goal,options={})=>{
 attachNavMesh(geo,mesh);const a=client(from),b=client(goal),result=planNavMesh(geo,a,b,{maxMs:2000,maxNodes:100000,...options});
 if(result.found)assert(assessPath(geo,result.waypoints,a,b,options).valid,'returned route must pass the common exact native proof');
 return result;
};

const flat=geometry(535),before=geometryIdentity(flat),flatMesh=await compile(flat,{includeRibbons:false});
assert.deepEqual(geometryIdentity(flat),before,'compiler must not change native geometry');
assert(flatMesh.nodes.every(n=>n.x>=0&&n.y>=0&&n.x<flat.cols*1024&&n.y<flat.rows*1024),'padding outside canonical room bounds must not become an in-room route');
assert(route(flat,flatMesh,{x:736,y:992},{x:736,y:2272}).found);
for(const node of flatMesh.nodes.filter((_,i)=>i%97===0))for(const edge of node.edges.slice(0,2)){
 assert.equal(edge.kind,'walk');assert.deepEqual(edge.points[0],{x:node.x,y:node.y});
 assert.deepEqual(edge.points.at(-1),{x:flatMesh.nodes[edge.to].x,y:flatMesh.nodes[edge.to].y});
 for(let i=1;i<edge.points.length;i++){
  assert(Number.isInteger(edge.points[i].x/16)&&Number.isInteger(edge.points[i].y/16));
  assert(Math.hypot(edge.points[i].x-edge.points[i-1].x,edge.points[i].y-edge.points[i-1].y)<=128);
 }
 assert(proveNavMeshWalk(flat,edge.points).ok);
}
passed('generic flat graph preserves native state and stores replayable wire microsteps');
const legacyFrom={x:10752,y:14848},legacyTo={x:10880,y:14912};
const legacy=unpackNavMesh(packNavMesh({format:'m59-navmesh-room/1',version:1,room:535,identity:geometryIdentity(flat),polygons:[],provenance:{},nodes:[
 {...legacyFrom,floor:832,edges:[{to:1,kind:'walk',cost:Math.hypot(128,64),points:[legacyFrom,legacyTo]}]},
 {...legacyTo,floor:832,edges:[]}]}));
normalizeStoredNavMeshWalks(flat,legacy);
const normalized=legacy.nodes[0].edges[0].points;
assert.equal(legacy.provenance.microstepNormalization.segmentsChanged,1);
assert(normalized.slice(1).every((p,i)=>Math.hypot(p.x-normalized[i].x,p.y-normalized[i].y)<=128));
assert(proveNavMeshWalk(flat,normalized).ok);
passed('legacy lazy-codec attachments normalize without rephasing short stored steps');

const ancient=geometry(579),ancientMesh=await compile(ancient);
for(const [from,goal]of [[{x:2083,y:2569},{x:2117,y:2461}],[{x:2077,y:2416},{x:2255,y:2416}]]){
 assert(route(ancient,ancientMesh,from,goal,{minimumFloor:7040}).found,'native64 ribbons must preserve both recorded Ancient height-band walks');
}
passed('generic native ribbons preserve long Ancient approach and narrow upper band');

const open=geometry(2505,'1150'),closed=geometry(2505,'1060'),openMesh=await compile(open),closedMesh=await compile(closed);
const gateFrom={x:3808,y:416},gateGoal={x:160,y:4640};
assert(route(open,openMesh,gateFrom,gateGoal).found,'open Konima must connect through derived native gateways');
assert(!route(closed,closedMesh,gateFrom,gateGoal).found,'closed Konima must not inherit open passage');
assert.throws(()=>attachNavMesh(closed,openMesh),/geometry_mismatch/);
passed('generic Konima topology respects open versus closed observed state');

assert(ancientMesh.provenance.declaredActions.considered>0,'compiler must inspect the existing Ancient declarations');
const jumps=ancientMesh.nodes.flatMap(n=>n.edges).filter(e=>e.kind==='jump');
assert(jumps.every(e=>e.action?.declared===true&&e.action?.room===579));
const packed=packNavMesh(ancientMesh),roundTrip=unpackNavMesh(packed);
assert.equal(roundTrip.nodes.flatMap(n=>n.edges).filter(e=>e.kind==='jump').length,jumps.length,'typed declared jumps must round-trip without becoming walks');
assert(route(ancient,roundTrip,{x:2083,y:2569},{x:2117,y:2461},{minimumFloor:7040}).found);
passed('compact lazy transport retains the same native-proved route');

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'m59-enhanced-navmesh-test-'));
try{
 const shard=path.join(temporary,'room.json.gz'),book=path.join(temporary,'index.json.gz');
 fs.writeFileSync(shard,gzipSync(Buffer.from(JSON.stringify(packed))));
 fs.writeFileSync(book,gzipSync(Buffer.from(JSON.stringify({format:'m59-navmesh/1',version:1,rooms:{579:[{version:1,identity:ancientMesh.identity,file:'room.json.gz'}]}}))));
 const root=new URL('../../',import.meta.url);
 const source=`import{RoomGeometry,protocolToClient}from${JSON.stringify(new URL('tools/m59-roo.mjs',root).href)};import{loadMap}from${JSON.stringify(new URL('tools/m59-map.mjs',root).href)};import{planNavMesh}from${JSON.stringify(new URL('tools/m59-navmesh.mjs',root).href)};const g=RoomGeometry.fromJSON(loadMap().rooms[579].roo);g.roomNum=579;const p=a=>({x:protocolToClient(a.x),y:protocolToClient(a.y)}),r=planNavMesh(g,p({x:2083,y:2569}),p({x:2117,y:2461}),{file:${JSON.stringify(book)},maxMs:2000,maxNodes:100000,minimumFloor:7040});if(!r.found)throw Error(r.reason);console.log(JSON.stringify(process.memoryUsage()));`;
 const output=execFileSync(process.execPath,['--max-old-space-size=256','--input-type=module','--eval',source],{encoding:'utf8',windowsHide:true});
 const memory=JSON.parse(output.trim());console.log(`  bounded worker heap ${Math.round(memory.heapUsed/1048576)} MiB, RSS ${Math.round(memory.rss/1048576)} MiB`);
 passed('packed artifact loads and routes within a 256 MiB standalone heap');
}finally{
 const target=path.resolve(temporary),parent=path.resolve(os.tmpdir());
 if(path.dirname(target)!==parent||!path.basename(target).startsWith('m59-enhanced-navmesh-test-'))throw Error('Unexpected test cleanup path');
 fs.rmSync(target,{recursive:true,force:true});
}
console.log(`Passed ${checks} enhanced compiler checks`);
