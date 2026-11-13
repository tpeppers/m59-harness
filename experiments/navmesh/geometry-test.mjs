// Focused offline checks for the geometry adapter and its known headroom tradeoff.
// Run: node experiments/navmesh/geometry-test.mjs
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {floorHeightAt,CLIENT_FINENESS,protocolToClient,RoomGeometry} from '../../tools/m59-roo.mjs';
import {loadMap} from '../../tools/m59-map.mjs';
import {roomTriangles} from './geometry.mjs';
import {recastReady,buildRecastPlanner} from './recast.mjs';
import {assessPath} from './compare.mjs';

const S=CLIENT_FINENESS;
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log(`ok ${passed} - ${name}`);};
function synthetic(sectors,definitions,{voids=[]}={}){
 const leaves=definitions.map(([sectorNum,polygon],i)=>({node:i+1,sectorNum,sector:sectors[sectorNum-1],polygon}));
 return {collisionReady:true,file:'synthetic-exporter-control.roo',security:0,version:13,rows:12,cols:12,
  sectors,leaves,walls:[],voidSectors:()=>new Set(voids),
  floorBaseAtClient:(x,y,leaf)=>floorHeightAt(x,y,leaf.sector)-(leaf.sector.depth??0),
  leafAtClient:(x,y)=>leaves.find(l=>{
   const xs=l.polygon.map(p=>p[0]),ys=l.polygon.map(p=>p[1]);
   return x>=Math.min(...xs)&&x<=Math.max(...xs)&&y>=Math.min(...ys)&&y<=Math.max(...ys);
  })};
}
const square=(x0,y0,size)=>[[x0,y0],[x0+size,y0],[x0+size,y0+size],[x0,y0+size]];
const flat=(ceiling=2*S)=>({floorHeight:0,ceilingHeight:ceiling,depth:0,slopedFloor:null,slopedCeiling:null});

check('void and zero-interior sectors cannot become route surfaces',()=>{
 const geo=synthetic([flat(),flat(),flat(0)],[[1,square(0,0,4*S)],[2,square(5*S,0,4*S)],[3,square(0,5*S,4*S)]],{voids:[2]});
 const soup=roomTriangles(geo);
 assert(soup.positions.length>0);
 for(let i=0;i<soup.positions.length;i+=3){
  assert(soup.positions[i]<=4&&soup.positions[i+2]<=4,'excluded sector leaked into triangle soup');
 }
 assert.equal(soup.counts.voidLeaves,1);assert.equal(soup.counts.emptyLeaves,1);
});
check('native slope and water depth survive the axis and unit adapter',()=>{
 const sector={...flat(4*S),depth:204,slopedFloor:{a:-0.25,b:0,c:1,d:0}};
 const geo=synthetic([sector],[[1,square(0,0,4*S)]]),soup=roomTriangles(geo);
 for(let i=0;i<soup.positions.length;i+=3){
  const x=soup.positions[i]*S,z=soup.positions[i+2]*S;
  assert(Math.abs(soup.positions[i+1]*S-(floorHeightAt(x,z,sector)-204))<0.001);
 }
});

const map=loadMap(fileURLToPath(new URL('../../substrate/m59-map.json',import.meta.url)));
check('real rooms retain their source geometry and valid floor normals',()=>{
 for(const room of [535,579,2503,2505]){
  const geo=RoomGeometry.fromJSON(map.rooms[room].roo);geo.roomNum=room;
  const original=JSON.stringify({sectors:geo.sectors,leaves:geo.leaves,walls:geo.walls});
  const a=roomTriangles(geo),b=roomTriangles(geo,{profile:'conventional'});
  assert.equal(a.provenance.sourceDigest,b.provenance.sourceDigest);
  assert(b.counts.ceilingTriangles>0);
  for(const soup of [a,b]){
   assert(soup.positions.every(Number.isFinite));
   assert(soup.indices.every(i=>i<soup.positions.length/3));
   let up=0;
   for(let i=0;i<soup.indices.length;i+=3){
    const p=[0,1,2].map(k=>soup.positions.slice(soup.indices[i+k]*3,soup.indices[i+k]*3+3));
    const [v,w,t]=p,normalY=(w[2]-v[2])*(t[0]-v[0])-(w[0]-v[0])*(t[2]-v[2]);
    if(normalY>1e-9)up++;
   }
   assert.equal(up,soup.counts.floorTriangles,'obstacle caps must not invent walkable floor');
   assert(soup.bounds.max[1]-soup.bounds.min[1]<32,'wall extrusion accumulated with wall count');
  }
  assert.equal(JSON.stringify({sectors:geo.sectors,leaves:geo.leaves,walls:geo.walls}),original);
 }
});

await recastReady();
check('global ceiling profile exposes the native low-ceiling mismatch',()=>{
 // Meridian permits ordinary movement inside positive-height space; its player
 // headroom test belongs to particular wall crossings. This fixture has none.
 const geo=synthetic([flat(S/2)],[[1,square(0,0,4*S)]]);
 const from={x:S,y:S},goal={x:3*S,y:3*S};
 assert(RoomGeometry.prototype._occupiable.call(geo,from.x,from.y),'native occupancy retains the low-ceiling start');
 assert(RoomGeometry.prototype._occupiable.call(geo,goal.x,goal.y),'native occupancy retains the low-ceiling goal');
 const open=buildRecastPlanner(geo,{cs:1/8}),ceiling=buildRecastPlanner(geo,{cs:1/8,profile:'conventional'});
 try{
  assert(open.query(from,goal).found,'floor-wall mesh should retain the positive-space floor');
  assert(!ceiling.query(from,goal).found,'conventional headroom filtering should remove this half-square room');
 }finally{open.destroy();ceiling.destroy();}
});
check('genuine Recast route on room535 passes the shared native proof',()=>{
 const geo=RoomGeometry.fromJSON(map.rooms[535].roo);geo.roomNum=535;
 const from={x:protocolToClient(736),y:protocolToClient(992)},goal={x:protocolToClient(736),y:protocolToClient(2272)};
 const planner=buildRecastPlanner(geo,{cs:1/8});
 try{
  const route=planner.query(from,goal);assert(route.found);
  const proof=assessPath(geo,route.waypoints,from,goal);assert(proof.valid,JSON.stringify(proof));
 }finally{planner.destroy();}
});
console.log(`Passed ${passed} focused geometry checks`);
