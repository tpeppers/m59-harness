// Experimental Recast/Detour backend. Never imported by production navigation.
import {init, NavMeshQuery, exportNavMesh} from 'recast-navigation';
import {generateSoloNavMesh} from 'recast-navigation/generators';
import {roomTriangles} from './geometry.mjs';

export const recastReady=init;
export function buildRecastPlanner(geo,{profile='floor-wall',cs=0.0625,ch=0.03125,radius=248/1024}={}){
  const started=performance.now(),soup=roomTriangles(geo,{profile});
  const config={cs,ch,walkableHeight:Math.ceil((768/1024)/ch),walkableClimb:Math.floor((384/1024)/ch),
    walkableRadius:Math.ceil(radius/cs),walkableSlopeAngle:89,minRegionArea:0,mergeRegionArea:0,
    maxSimplificationError:0.5,maxEdgeLen:Math.round(8/cs),maxVertsPerPoly:6,
    detailSampleDist:6,detailSampleMaxError:1};
  const result=generateSoloNavMesh(soup.positions,soup.indices,config);
  const stats={build_ms:performance.now()-started,config,source:soup.counts,provenance:soup.provenance};
  if(!result.success)return {stats:{...stats,error:result.error},query:()=>({found:false,reason:'bake_failed'}),destroy(){}};
  const nav=result.navMesh,q=new NavMeshQuery(nav,{maxNodes:16384});
  stats.bytes=exportNavMesh(nav).byteLength;stats.polygons=0;
  for(let i=0;i<nav.getMaxTiles();i++)stats.polygons+=nav.getTile(i).header()?.polyCount()??0;
  const position=p=>{
    const leaf=geo.leafAtClient(p.x,p.y),floor=leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf):null;
    return floor==null?null:{x:p.x/1024,y:floor/1024,z:p.y/1024};
  };
  return {stats,query(from,to){
    const a=position(from),b=position(to);if(!a||!b)return {found:false,reason:'endpoint_has_no_floor'};
    // Tight vertical extent prevents snapping a goal onto another shelf.
    const opts={halfExtents:{x:0.5,y:0.2,z:0.5}};
    const s=q.findNearestPoly(a,opts),e=q.findNearestPoly(b,opts);
    if(!s.success||!e.success||!s.nearestRef||!e.nearestRef)return {found:false,reason:'endpoint_not_on_mesh'};
    const corridor=q.findPath(s.nearestRef,e.nearestRef,s.nearestPoint,e.nearestPoint,{maxPathPolys:4096});
    try{
      if(!corridor.success||corridor.polys.size===0)return {found:false,reason:'no_mesh_path',status:corridor.status};
      // Detour can return success for a partial path. Full destination is mandatory here.
      if(corridor.polys.get(corridor.polys.size-1)!==e.nearestRef)return {found:false,reason:'partial_mesh_path',status:corridor.status};
      const line=q.findStraightPath(s.nearestPoint,e.nearestPoint,corridor.polys,{maxStraightPathPoints:4096});
      try{
        if(!line.success)return {found:false,reason:'straight_path_failed',status:line.status};
        if(line.straightPathCount===0 || (line.straightPathFlags.get(line.straightPathCount-1)&2)===0)return {found:false,reason:'truncated_straight_path'};
        const lastIndex=(line.straightPathCount-1)*3;
        if(Math.hypot(line.straightPath.get(lastIndex)-e.nearestPoint.x,line.straightPath.get(lastIndex+1)-e.nearestPoint.y,line.straightPath.get(lastIndex+2)-e.nearestPoint.z)>0.01)return {found:false,reason:'incomplete_straight_endpoint'};
        const points=[{...from}];
        for(let i=0;i<line.straightPathCount;i++)points.push({x:line.straightPath.get(i*3)*1024,y:line.straightPath.get(i*3+2)*1024});
        points.push({...to});
        return {found:true,waypoints:points,corridor_polys:corridor.polys.size,
          endpoint_projection_squares:{from:Math.hypot(s.nearestPoint.x-a.x,s.nearestPoint.z-a.z),to:Math.hypot(e.nearestPoint.x-b.x,e.nearestPoint.z-b.z)}};
      }finally{line.straightPath.destroy();line.straightPathFlags.destroy();line.straightPathRefs.destroy();}
    }finally{corridor.polys.destroy();}
  },destroy(){q.destroy();nav.destroy();}};
}
