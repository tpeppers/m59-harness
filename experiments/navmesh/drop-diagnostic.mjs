// Reference-route-fitted diagnostic, not an independent benchmark or production link bake.
// Tests whether one native-proved directed descent explains Konima's Recast disconnect.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {init,NavMeshQuery} from 'recast-navigation';
import {generateSoloNavMesh} from 'recast-navigation/generators';
import {RoomGeometry,protocolToClient} from '../../tools/m59-roo.mjs';
import {loadMap} from '../../tools/m59-map.mjs';
import {applyCeilingDoors} from '../../tools/m59-ceiling-doors.mjs';
import {benchmarkCases} from './cases.mjs';
import {roomTriangles} from './geometry.mjs';
import {currentFineQuery} from './baseline.mjs';
import {assessPath} from './compare.mjs';

const map=loadMap(fileURLToPath(new URL('../../substrate/m59-map.json',import.meta.url))),cases=benchmarkCases(map),openCase=cases.find(c=>c.id==='konima-2505-open-gate');
const point=p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)});
const from=point(openCase.from),goal=point(openCase.goal);
const geometry=open=>{
 const g=RoomGeometry.fromJSON(map.rooms[2505].roo);g.roomNum=2505;
 if(open){const applied=applyCeilingDoors(map,2505,new Map([[1,{type:5,height:1150}]]),null,{geometryOf:()=>g});if(!applied)throw Error('Open-door state not applied');}
 return g;
};
const geo=geometry(true),floor=(g,p)=>{const leaf=g.leafAtClient(p.x,p.y);return leaf?.sector?g.floorBaseAtClient(p.x,p.y,leaf):null;};
const world=(g,p)=>({x:p.x/1024,y:floor(g,p)/1024,z:p.y/1024});
const reference=currentFineQuery(geo,from,goal);
if(!reference.found)throw Error('Native reference route unavailable');
const referenceProof=assessPath(geo,reference.waypoints,from,goal);
if(!referenceProof.valid)throw Error('Native reference route failed proof');
const drops=[];
for(let i=1;i<reference.waypoints.length;i++){
 const a=reference.waypoints[i-1],b=reference.waypoints[i],drop=floor(geo,a)-floor(geo,b);
 if(drop>384)drops.push({index:i,from:a,to:b,from_floor:floor(geo,a),to_floor:floor(geo,b),drop});
}
if(drops.length!==1)throw Error(`Expected exactly one native reference drop, found ${drops.length}`);
const drop=drops[0],config={cs:1/16,ch:1/32,walkableHeight:24,walkableClimb:12,walkableRadius:4,
 walkableSlopeAngle:89,minRegionArea:0,mergeRegionArea:0,maxSimplificationError:.5,
 maxEdgeLen:128,maxVertsPerPoly:6,detailSampleDist:6,detailSampleMaxError:1};
await init();
function query(g,link){
 const soup=roomTriangles(g),began=performance.now();
 const result=generateSoloNavMesh(soup.positions,soup.indices,{...config,...(link?{offMeshConnections:[link]}:{})});
 if(!result.success)return {found:false,reason:'bake_failed',error:result.error};
 const nav=result.navMesh,q=new NavMeshQuery(nav,{maxNodes:16384}),buildMs=performance.now()-began;
 try{
  const s=q.findNearestPoly(world(g,from),{halfExtents:{x:.5,y:.2,z:.5}}),e=q.findNearestPoly(world(g,goal),{halfExtents:{x:.5,y:.2,z:.5}});
  if(!s.nearestRef||!e.nearestRef)return {found:false,reason:'endpoint_not_on_mesh',build_ms:buildMs};
  const connected=(a,b)=>{
   if(!a.nearestRef||!b.nearestRef)return {complete:false,reason:'endpoint_not_on_mesh',start_ref:a.nearestRef,end_ref:b.nearestRef};
   const p=q.findPath(a.nearestRef,b.nearestRef,a.nearestPoint,b.nearestPoint,{maxPathPolys:4096});
   try{return {complete:!!p.success&&p.polys.size>0&&p.polys.get(p.polys.size-1)===b.nearestRef,start_ref:a.nearestRef,end_ref:b.nearestRef,polys:p.polys.size};}finally{p.polys.destroy();}
  };
  let attachment=null;
  if(link){
   const start=q.findNearestPoly(link.startPosition,{halfExtents:{x:link.radius,y:.2,z:link.radius}});
   const end=q.findNearestPoly(link.endPosition,{halfExtents:{x:link.radius,y:.2,z:link.radius}});
   let offmesh_count=0;for(let i=0;i<nav.getMaxTiles();i++)offmesh_count+=nav.getTile(i).header()?.offMeshConCount()??0;
   attachment={offmesh_count,start_nearest:start,end_nearest:end,approach:connected(s,start),across:connected(start,end),departure:connected(end,e)};
  }
  const corridor=q.findPath(s.nearestRef,e.nearestRef,s.nearestPoint,e.nearestPoint,{maxPathPolys:4096});
  try{
   const last=corridor.polys.size?corridor.polys.get(corridor.polys.size-1):null;
   if(!corridor.success||last!==e.nearestRef)return {found:false,reason:'partial_mesh_path',last_ref:last,goal_ref:e.nearestRef,corridor_polys:corridor.polys.size,build_ms:buildMs,attachment};
   const line=q.findStraightPath(s.nearestPoint,e.nearestPoint,corridor.polys,{maxStraightPathPoints:4096});
   try{
    if(!line.success||!line.straightPathCount)return {found:false,reason:'straight_path_failed',build_ms:buildMs};
    const flags=Array.from({length:line.straightPathCount},(_,i)=>line.straightPathFlags.get(i));
    if(!(flags.at(-1)&2))return {found:false,reason:'incomplete_straight_path',flags,build_ms:buildMs};
    const waypoints=[from];
    for(let i=0;i<line.straightPathCount;i++)waypoints.push({x:line.straightPath.get(i*3)*1024,y:line.straightPath.get(i*3+2)*1024});
    waypoints.push(goal);
    return {found:true,corridor_polys:corridor.polys.size,last_ref:last,goal_ref:e.nearestRef,flags,
     proof:assessPath(g,waypoints,from,goal),waypoints,build_ms:buildMs};
   }finally{line.straightPath.destroy();line.straightPathFlags.destroy();line.straightPathRefs.destroy();}
  }finally{corridor.polys.destroy();}
 }finally{q.destroy();nav.destroy();}
}
const output={source_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),map_sha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('../../substrate/m59-map.json',import.meta.url))).digest('hex'),schema:'m59-single-drop-diagnostic/1',created_at:new Date().toISOString(),room:2505,
 caveat:'One directed link is fitted using a known native route. Diagnostic explains a representation gap; it is not unbiased benchmark improvement.',
 config,from,goal,reference:{proof:referenceProof,waypoints:reference.waypoints.length,drops},baseline:query(geo,null),closed_baseline:query(geometry(false),null),trials:[]};
const variants=[];
for(const before of [0,2,4,8])for(const after of [0,2,4,8]){
 const a=reference.waypoints[Math.max(0,drop.index-1-before)],b=reference.waypoints[Math.min(reference.waypoints.length-1,drop.index+after)];
 const proof=assessPath(geo,[a,b],a,b);if(!proof.valid)continue;
 for(const radius of [.5,1])variants.push({a,b,before,after,radius,proof});
}
for(const v of variants.slice(0,Number(process.env.DROP_DIAGNOSTIC_LIMIT??variants.length))){
 const link={startPosition:world(geo,v.a),endPosition:world(geo,v.b),radius:v.radius,bidirectional:false,flags:1,area:0,userId:2505001};
 const trial={before:v.before,after:v.after,radius:v.radius,link,native_link_proof:v.proof,open:query(geo,link)};
 if(output.trials.length===0)trial.closed_control=query(geometry(false),link);
 output.trials.push(trial);
 console.log(JSON.stringify({before:v.before,after:v.after,radius:v.radius,found:trial.open.found,proof:trial.open.proof?.valid,reason:trial.open.proof?.reason??trial.open.reason}));
 if(trial.open.found&&trial.open.proof?.valid){trial.closed_control=query(geometry(false),link);output.success=trial;break;}
}
const destination=new URL('./drop-diagnostic.json',import.meta.url);
fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({success:!!output.success,closed_found:output.success?.closed_control.found,closed_valid:output.success?.closed_control.proof?.valid,trials:output.trials.length,saved:destination.pathname}));
