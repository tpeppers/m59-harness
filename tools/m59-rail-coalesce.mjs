import{protocolToClient}from'./m59-finepos.mjs';import{floorAt}from'./m59-ground.mjs';import{quantizeRailPoint}from'./m59-railfollow.mjs';
// Coalesce only same-height, stock-traceable chords within one walking leg.
// Dense source points remain available for rail boarding/clearance; jumps and
// strict queues keep their own operation boundaries and live body checks.
export function coalesceCheckedRailLeg(geo,leg,{lookAhead=16,maxDistance=512,floorTolerance=16,avoidSquares=null}={}){
 if(!(avoidSquares instanceof Set)||!geo?.collisionReady||leg?.kind!=='walk'||!Array.isArray(leg.waypoints)||leg.waypoints.length<3)return leg;
 const points=leg.waypoints,out=[points[0]],floor=(x,y)=>floorAt(geo,x,y);
 for(let from=0;from<points.length-1;){let next=from+1;const a=points[from],z=floor(a.x,a.y);
  for(let i=Math.min(points.length-1,from+lookAhead);i>from+1;i--){const b=points[i];if(Math.hypot(b.x-a.x,b.y-a.y)>maxDistance*16||!Number.isFinite(z))continue;
   if(points.slice(from+1,i+1).some(p=>!Number.isFinite(floor(p.x,p.y))||Math.abs(floor(p.x,p.y)-z)>floorTolerance))continue;
   const trace=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});if(!trace?.arrived||trace.blocked)continue;
   let level=true;const n=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/64);for(let k=1;k<=n;k++){const h=floor(a.x+(b.x-a.x)*k/n,a.y+(b.y-a.y)*k/n);if(!Number.isFinite(h)||Math.abs(h-z)>floorTolerance||avoidSquares.has((Math.floor((a.y+(b.y-a.y)*k/n)/1024)+1)+','+(Math.floor((a.x+(b.x-a.x)*k/n)/1024)+1))){level=false;break;}}if(!level)continue;
   const wire=quantizeRailPoint(b,{floorAt:floor,edge:(p,q)=>geo.traceFineMoveClient(p.x,p.y,q.x,q.y,{slide:false})?.arrived===true});if(!wire.ok)continue;
   const wireClient=protocolToClient(wire.protocol);if(!geo.traceFineMoveClient(a.x,a.y,wireClient.x,wireClient.y,{slide:false})?.arrived)continue;
   next=i;break;
  }
  out.push(points[next]);from=next;
 }
 return{...leg,sourceWaypoints:leg.sourceWaypoints??points,waypoints:out,coalesced_from:points.length};
}
