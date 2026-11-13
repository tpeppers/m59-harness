// Offline enhanced-navmesh compiler. Recast is an authoring dependency only.
// Runtime artifacts contain plain CLIENT/BSP coordinates and native-proved walks.
import {init,NavMeshQuery} from 'recast-navigation';
import {generateSoloNavMesh} from 'recast-navigation/generators';
import {roomTriangles} from './geometry.mjs';
import {bakeRoom} from '../../tools/m59-finenav-bake.mjs';
import {addDeclaredNavMeshLinks} from '../../tools/m59-navmesh-actions.mjs';
import {PLAYER_RADIUS,PLAYER_HEIGHT,MAX_STEP_HEIGHT} from '../../tools/m59-roo.mjs';

const wire=p=>({x:Math.round(p.x/16)*16,y:Math.round(p.y/16)*16});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const key=p=>`${p.x}:${p.y}`;
const bucket=p=>`${Math.floor(p.x/1024)}:${Math.floor(p.y/1024)}`;

/** Emit the exact quantized <=96-client-unit sequence that the native tracer proves. */
export function proveNativeWalk(geo,aims,{roomFlags=0,overrideDepths=null,step=96}={}){
 if(!aims?.length)return null;
 const points=[wire(aims[0])];let cost=0;
 for(const aim of aims.slice(1)){
  const a=points.at(-1),b=wire(aim),n=Math.max(1,Math.ceil(distance(a,b)/step));
  for(let i=1;i<=n;i++){
   const p=wire({x:a.x+(b.x-a.x)*i/n,y:a.y+(b.y-a.y)*i/n}),prev=points.at(-1);
   if(p.x===prev.x&&p.y===prev.y)continue;
   const t=geo.traceFineMoveClient(prev.x,prev.y,p.x,p.y,{slide:false,roomFlags,overrideDepths});
   if(!t?.arrived||t.blocked===true||Math.hypot((t.x??Infinity)-p.x,(t.y??Infinity)-p.y)>.05)return null;
   cost+=distance(prev,p);points.push(p);
  }
 }
 return {points,cost};
}

/**
 * Build one observed static room state. No roster, socket, fleet or keeper is read.
 * The native footing overlay intentionally retains redundant broad-room coverage
 * in version1: pruning it before proving narrow/height-band coverage would lose
 * routes. Every overlay/mesh/gateway edge still has the same native wire proof.
 */
export async function buildEnhancedRoom(geo,{room=geo?.roomNum,roomDefinition=null,cs=1/16,ch=1/32,
 roomFlags=0,overrideDepths=null,includeNative=true,pitch=256,refine=64,includeRibbons=true,ribbonPitch=64,
 gatewayStride=512,gatewayOffsets=[],gatewayAttachRange=1536,
 onProgress=()=>{}}={}){
 const began=performance.now();
 if(!geo?.collisionReady)throw Error('Enhanced bake requires complete native collision geometry');
 const {geometryIdentity}=await import('../../tools/m59-navmesh.mjs');
 await init();
 const nodes=[],polygons=[],byPoint=new Map(),buckets=new Map(),edgeMaps=[];
 const counts={recastPolygons:0,recastEdges:0,nativeFootings:0,nativeEdges:0,
  gateways:0,gatewayEdges:0,ribbonNodes:0,ribbonEdges:0,attachmentEdges:0,rejectedEdges:0};
 const proofOptions={roomFlags,overrideDepths};
 const floor=p=>{const leaf=geo.leafAtClient(p.x,p.y);return leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf,proofOptions):null;};
 const canStand=p=>{
  if(!geo._occupiable(p.x,p.y)||!Number.isFinite(floor(p)))return false;
  return [[16,0],[-16,0],[0,16],[0,-16]].every(([dx,dy])=>{
   const t=geo.traceFineMoveClient(p.x,p.y,p.x+dx,p.y+dy,{slide:false,...proofOptions});return t?.arrived&&t.blocked!==true;
  });
 };
 function addNode(point,extra={}){
  const p=wire(point),k=key(p);if(byPoint.has(k))return byPoint.get(k);
  const h=floor(p);if(!Number.isFinite(h))return null;
  const id=nodes.length;nodes.push({...p,floor:h,...extra,edges:[]});edgeMaps.push(new Map());byPoint.set(k,id);
  const bk=bucket(p);if(!buckets.has(bk))buckets.set(bk,[]);buckets.get(bk).push(id);return id;
 }
 function addEdge(from,to,aims,category){
  if(from==null||to==null||from===to)return false;
  const existing=edgeMaps[from].get(to);
  if(existing){let lower=0;for(let i=1;i<aims.length;i++)lower+=distance(aims[i-1],aims[i]);if(existing.cost<=lower)return true;}
  const proof=proveNativeWalk(geo,aims,proofOptions);
  if(!proof){counts.rejectedEdges++;return false;}
  if(existing&&existing.cost<=proof.cost)return true;
  const edge={to,kind:'walk',points:proof.points,cost:proof.cost};edgeMaps[from].set(to,edge);
  counts[category]++;return true;
 }
 const soup=roomTriangles(geo,{profile:'floor-wall',roomFlags,overrideDepths});
 const config={cs,ch,walkableHeight:Math.ceil(PLAYER_HEIGHT/1024/ch),walkableClimb:Math.floor(MAX_STEP_HEIGHT/1024/ch),
  walkableRadius:Math.ceil(PLAYER_RADIUS/1024/cs),walkableSlopeAngle:89,minRegionArea:0,mergeRegionArea:0,
  maxSimplificationError:.5,maxEdgeLen:Math.round(8/cs),maxVertsPerPoly:6,detailSampleDist:6,detailSampleMaxError:1};
 onProgress({phase:'recast',room});
 const result=generateSoloNavMesh(soup.positions,soup.indices,config);
 if(!result.success&&!includeNative)throw Error(`Recast room ${room}: ${result.error}`);
 const nav=result.success?result.navMesh:{getMaxTiles:()=>0,destroy(){}},query=result.success?new NavMeshQuery(nav,{maxNodes:16384}):{findNearestPoly:()=>({nearestRef:0}),destroy(){}};
 const polyNodes=new Map(),tilePolys=[];
 try{
  // Detour convex polygons become dependency-free geometry and graph anchors.
  for(let tileIndex=0;tileIndex<nav.getMaxTiles();tileIndex++){
   const tile=nav.getTile(tileIndex),header=tile.header();if(!header)continue;
   const base=nav.getPolyRefBase(tile);
   for(let i=0;i<header.polyCount();i++){
    const poly=tile.polys(i);if(poly.getType()!==0)continue;
    const vertices=[];
    for(let j=0;j<poly.vertCount();j++){
     const v=poly.verts(j);vertices.push({x:tile.verts(v*3)*1024,y:tile.verts(v*3+2)*1024});
    }
    const id=polygons.length,center=wire({x:vertices.reduce((s,p)=>s+p.x,0)/vertices.length,y:vertices.reduce((s,p)=>s+p.y,0)/vertices.length});
    const candidates=[center,...vertices.map(v=>wire({x:(v.x+center.x)/2,y:(v.y+center.y)/2}))];
    const anchor=candidates.find(canStand),node=anchor?addNode(anchor,{polygon:id,source:'recast'}):null;
    polygons.push({vertices,...(node!=null?{node}:{})});
    polyNodes.set(base+i,node);tilePolys.push({tileIndex,index:i,base,id,node,vertices});counts.recastPolygons++;
   }
  }
  for(const record of tilePolys){
   if(record.node==null)continue;
   const tile=nav.getTile(record.tileIndex),poly=tile.polys(record.index);
   for(let e=0;e<poly.vertCount();e++){
    const neighbour=poly.neis(e);if(!neighbour||(neighbour&0x8000))continue;
    const target=polyNodes.get(record.base+neighbour-1);if(target==null)continue;
    const a=record.vertices[e],b=record.vertices[(e+1)%record.vertices.length],portal=wire({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    addEdge(record.node,target,[nodes[record.node],portal,nodes[target]],'recastEdges');
   }
  }
  const attachToMesh=(id)=>{
   const n=nodes[id],nearest=query.findNearestPoly({x:n.x/1024,y:n.floor/1024,z:n.y/1024},{halfExtents:{x:.75,y:.2,z:.75}});
   const target=polyNodes.get(nearest.nearestRef);if(target==null||target===id)return;
   const projected=wire({x:nearest.nearestPoint.x*1024,y:nearest.nearestPoint.z*1024});
   addEdge(id,target,[n,projected,nodes[target]],'attachmentEdges');
   addEdge(target,id,[nodes[target],projected,n],'attachmentEdges');
  };
  if(includeNative){
   onProgress({phase:'native-footings',room});
   const footing=bakeRoom({...roomDefinition,num:room,edgeExits:roomDefinition?.edgeExits??[],goExits:roomDefinition?.goExits??[]},geo,{pitch,refine});
   const ids=footing.footings.map(f=>addNode(f.rep,{source:'native-footing'}));counts.nativeFootings=ids.length;
   for(const f of footing.footings){
    const source=ids[f.id];if(source==null)continue;
    for(const edge of f.edges){
     // Ordinary walks and slide candidates are retained ONLY if their explicit
     // landing/via chain also proves as an ordinary no-slide walk. Fall/jump
     // actions remain owned by the declared-action planner, never guessed here.
     if(edge.kind>1)continue;
     const destination=ids[edge.to];if(destination==null)continue;
     const aims=[nodes[source],...(edge.via??[]),...(edge.land?[edge.land]:[]),nodes[destination]];
     addEdge(source,destination,aims,'nativeEdges');
    }
    attachToMesh(source);
   }
  }
  if(includeRibbons){
   onProgress({phase:'native-ribbons',room});
   const selected=new Map(),pitch=ribbonPitch;
   const nativeFloor=p=>geo._occupiable(p.x,p.y)?floor(p):null;
   const select=p=>{if(p.x<0||p.y<0||p.x>geo.cols*1024||p.y>geo.rows*1024)return;const h=nativeFloor(p);if(Number.isFinite(h))selected.set(key(p),{...p,floor:h});};
   for(let y=pitch;y<geo.rows*1024;y+=pitch)for(let x=pitch;x<geo.cols*1024;x+=pitch){
    const p={x,y},h=nativeFloor(p);if(!Number.isFinite(h))continue;
    let seam=false;
    for(const [dx,dy]of [[pitch,0],[-pitch,0],[0,pitch],[0,-pitch]]){
     const other=nativeFloor({x:x+dx,y:y+dy});if(Number.isFinite(other)&&Math.abs(other-h)>=128){seam=true;break;}
    }
    let missing=false;
    if(!seam){
     const nearest=query.findNearestPoly({x:x/1024,y:h/1024,z:y/1024},{halfExtents:{x:.125,y:.125,z:.125}});
     missing=!polyNodes.has(nearest.nearestRef)||!nearest.nearestRef||Math.hypot(nearest.nearestPoint.x*1024-x,nearest.nearestPoint.z*1024-y)>64;
     if(missing&&!canStand(p))missing=false;
    }
    if(!seam&&!missing)continue;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)select({x:x+dx*pitch,y:y+dy*pitch});
   }
   const entries=new Map(),explicit=new Set(),baseCount=nodes.length;
   const staysHigh=(proof,h)=>proof&&proof.points.every(p=>floor(p)>=h-1);
   for(const p of selected.values()){
    const cx=Math.floor(p.x/1024),cy=Math.floor(p.y/1024),candidates=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const id of buckets.get(`${cx+dx}:${cy+dy}`)??[]){
     if(id>=baseCount||nodes[id].source!=='native-footing')continue;
     const n=nodes[id],d=distance(n,p);if(d<=768&&n.floor>=p.floor-1&&n.floor<=p.floor+384)candidates.push({id,d});
    }
    candidates.sort((a,b)=>a.d-b.d);let entry=null;
    for(const {id}of candidates.slice(0,4)){
     const toAnchor=proveNativeWalk(geo,[p,nodes[id]],proofOptions);
     if(!staysHigh(toAnchor,p.floor))continue;
     const fromAnchor=proveNativeWalk(geo,[nodes[id],p],proofOptions);
     if(!staysHigh(fromAnchor,p.floor))continue;
     entry={id,point:p,toAnchor:toAnchor.points,fromAnchor:fromAnchor.points};break;
    }
    if(!entry){const id=addNode(p,{source:'native-ribbon'});if(id==null)continue;explicit.add(id);entry={id,point:p,toAnchor:[p],fromAnchor:[p]};}
    entries.set(key(p),entry);
   }
   counts.ribbonSamples=entries.size;counts.ribbonNodes=explicit.size;
   for(const entry of entries.values()){
    const {point:p,id}=entry;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
     if(!dx&&!dy)continue;const other=entries.get(key({x:p.x+dx*pitch,y:p.y+dy*pitch}));
     if(!other||other.id===id)continue;
     addEdge(id,other.id,[...entry.fromAnchor,other.point,...other.toAnchor.slice(1)],'ribbonEdges');
    }
   }
   for(const id of explicit){
    attachToMesh(id);
    const n=nodes[id],cx=Math.floor(n.x/1024),cy=Math.floor(n.y/1024),near=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const to of buckets.get(`${cx+dx}:${cy+dy}`)??[]){
     if(to===id||nodes[to].source==='native-ribbon')continue;const d=distance(n,nodes[to]);if(d<=1024)near.push({to,d});
    }
    near.sort((a,b)=>a.d-b.d);
    for(const {to}of near.slice(0,2)){addEdge(id,to,[n,nodes[to]],'attachmentEdges');addEdge(to,id,[nodes[to],n],'attachmentEdges');}
   }
  }
  // Sample collision seams generically. This covers directed descents, wading
  // banks and one-sided texture gates without embedding reference-route points.
  onProgress({phase:'native-gateways',room});
  const gateways=new Set();
  for(const wall of geo.walls){
   const sides=[wall.posSidedefRec,wall.negSidedefRec].filter(Boolean);
   if(!sides.length||sides.every(s=>!(s.flags&4)))continue;
   const dx=wall.x1-wall.x0,dy=wall.y1-wall.y0,length=Math.hypot(dx,dy);if(!length)continue;
   const nx=-dy/length,ny=dx/length,steps=Math.max(1,Math.ceil(length/gatewayStride));
   for(let i=0;i<steps;i++){
    const t=(i+.5)/steps,p={x:wall.x0+dx*t,y:wall.y0+dy*t};
    for(const offset of gatewayOffsets){
     const a=wire({x:p.x+nx*offset,y:p.y+ny*offset}),b=wire({x:p.x-nx*offset,y:p.y-ny*offset});
     if(!canStand(a)||!canStand(b))continue;
     const forward=proveNativeWalk(geo,[a,b],proofOptions),reverse=proveNativeWalk(geo,[b,a],proofOptions);
     if(!forward&&!reverse)continue;
     const from=addNode(a,{source:'native-gateway'}),to=addNode(b,{source:'native-gateway'});
     gateways.add(from);gateways.add(to);
     if(forward)addEdge(from,to,forward.points,'gatewayEdges');
     if(reverse)addEdge(to,from,reverse.points,'gatewayEdges');
    }
   }
  }
  counts.gateways=gateways.size;
  for(const id of gateways){
   attachToMesh(id);
   const n=nodes[id],cx=Math.floor(n.x/1024),cy=Math.floor(n.y/1024),range=Math.ceil(gatewayAttachRange/1024),near=[];
   for(let dx=-range;dx<=range;dx++)for(let dy=-range;dy<=range;dy++)for(const target of buckets.get(`${cx+dx}:${cy+dy}`)??[]){
    if(target===id)continue;const d=distance(n,nodes[target]);if(d>gatewayAttachRange)continue;near.push({target,d});
   }
   near.sort((a,b)=>a.d-b.d);
   // Keep several native-footing/recast attachments even when dense samples
   // occupy the nearest neighbourhood; otherwise a seam can become an island.
   const selected=[...near.slice(0,4),...near.filter(p=>nodes[p.target].source!=='native-gateway').slice(0,2)];
   for(const {target} of selected){addEdge(id,target,[n,nodes[target]],'attachmentEdges');addEdge(target,id,[nodes[target],n],'attachmentEdges');}
  }
 }finally{query.destroy();nav.destroy();}
 for(let i=0;i<nodes.length;i++)nodes[i].edges=[...edgeMaps[i].values()];
 const identity=geometryIdentity(geo,{roomFlags,overrideDepths});
 const mesh={format:'m59-navmesh-room/1',version:1,room:Number(room),identity,nodes,polygons,
  provenance:{compiler:'enhanced-native-recast/1',recastPackage:'recast-navigation@0.44.0',config,
   source:soup.provenance,recastFailure:result.success?null:result.error,nativeOverlay:'multi-footing backbone plus generic seam gateways',pitch,refine,ribbonPitch,includeRibbons,gatewayStride,gatewayOffsets,
   counts,edges:nodes.reduce((n,p)=>n+p.edges.length,0),buildMs:performance.now()-began,
   limitations:['Static observed geometry state only; live bodies and constraints are query-time checks.',
    'Walks and existing native-proved declared jumps only; door operations remain external.',
    'Finite native samples are coverage evidence, not proof that a missing route is impossible.']}};
 addDeclaredNavMeshLinks(geo,mesh);filterNavMeshBounds(mesh);
 mesh.provenance.buildMs=performance.now()-began;return mesh;
}
/** Upgrade legacy attachment segments without rephasing already proved short steps. */
export function normalizeStoredNavMeshWalks(geo,mesh,options={}){
 const cache=new Map(),stats={edgesChanged:0,segmentsChanged:0};
 const width=mesh.identity.cols*1024,height=mesh.identity.rows*1024;
 const inside=p=>p.x>=0&&p.y>=0&&p.x<width&&p.y<height;
 const exact=(a,b)=>{const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,...options});return t?.arrived&&t.blocked!==true&&Math.hypot((t.x??Infinity)-b.x,(t.y??Infinity)-b.y)<.05;};
 for(const node of mesh.nodes)for(const [edgeIndex,edge]of node.edges.entries()){
  if(edge.kind!=='walk'||edge.points.length<2)continue;
  let changed=false;const points=[edge.points[0]];
  for(const b of edge.points.slice(1)){
   const a=points.at(-1);
   if(distance(a,b)<=128+.001){points.push(b);continue;}
   const k=`${a.x}:${a.y}>${b.x}:${b.y}`;let replacement=cache.get(k);
   if(!replacement){
    const direct=proveNativeWalk(geo,[a,b],options);
    if(direct&&direct.points.slice(1).every((p,i)=>distance(p,direct.points[i])<=128+.001))replacement=direct.points.slice(1);
    if(!replacement){
     const middle=wire({x:(a.x+b.x)/2,y:(a.y+b.y)/2}),candidates=[];
     for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)candidates.push({x:middle.x+16*dx,y:middle.y+16*dy});
     candidates.sort((p,q)=>distance(p,middle)-distance(q,middle));
     const c=candidates.find(p=>inside(p)&&distance(a,p)<=128&&distance(p,b)<=128&&exact(a,p)&&exact(p,b));
     if(c)replacement=[c,b];
    }
    if(!replacement)throw Error(`Cannot preserve a legacy native attachment within128clientunits at x=${a.x} y=${a.y}`);
    cache.set(k,replacement);
   }
   points.push(...replacement);changed=true;stats.segmentsChanged++;
  }
  if(changed){node.edges[edgeIndex]={...edge,points,cost:points.slice(1).reduce((n,p,i)=>n+distance(points[i],p),0)};stats.edgesChanged++;}
 }
 mesh.provenance={...mesh.provenance,microstepNormalization:stats};return mesh;
}

/** Canonical in-room topology only. Declared off-map exits remain external actions. */
export function filterNavMeshBounds(mesh){
 const width=mesh.identity.cols*1024,height=mesh.identity.rows*1024;
 const inside=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>=0&&p.y>=0&&p.x<width&&p.y<height;
 const old=mesh.nodes,remap=new Int32Array(old.length).fill(-1),nodes=[];
 for(let i=0;i<old.length;i++)if(inside(old[i])){remap[i]=nodes.length;nodes.push({...old[i],edges:[]});}
 let removedEdges=0;
 for(let i=0;i<old.length;i++){
  if(remap[i]<0){removedEdges+=old[i].edges.length;continue;}
  for(const edge of old[i].edges){
   if(remap[edge.to]<0||!edge.points?.every(inside)){removedEdges++;continue;}
   nodes[remap[i]].edges.push({...edge,to:remap[edge.to]});
  }
 }
 mesh.nodes=nodes;
 mesh.polygons=(mesh.polygons??[]).map(p=>{const copy={...p};if(p.node!=null){if(remap[p.node]>=0)copy.node=remap[p.node];else delete copy.node;}return copy;});
 mesh.provenance={...mesh.provenance,canonicalBounds:{nodesRemoved:old.length-nodes.length,edgesRemoved:removedEdges},edges:nodes.reduce((n,p)=>n+p.edges.length,0)};
 return mesh;
}
export const bakeEnhancedRoom=buildEnhancedRoom;
