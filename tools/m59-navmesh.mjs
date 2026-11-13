// Meridian navigation meshes. Runtime reader/query only: no npm, sockets or baking.
// All points are named CLIENT/BSP {x,y}, 1024 units per square. Native collision
// remains the authority; cached topology is never permission to emit a packet.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {unpackNavMesh,PACKED_NAVMESH_FORMAT} from './m59-navmesh-codec.mjs';
import {declaredJumpFor} from './m59-jump-precondition.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
import {STEP_MASK_VERSION,CLIENT_FINENESS as F,MIN_NOMOVEON,protocolToClient,clientToProtocol} from './m59-roo.mjs';

export const NAVMESH_FORMAT='m59-navmesh-room/1';
export const NAVMESH_VERSION=1;
export const NAVMESH_BOOK_FORMAT='m59-navmesh/1';
export const NAVMESH_FILE=fileURLToPath(new URL('../substrate/m59-navmesh.json.gz',import.meta.url));
const attached=new WeakMap(),identities=new WeakMap(),prepared=new WeakMap();
const roomFiles=new Map();
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const point=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y);
const copyPoint=p=>({x:p.x,y:p.y});
const gap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const wire=p=>({x:protocolToClient(Math.round(clientToProtocol(p.x))),y:protocolToClient(Math.round(clientToProtocol(p.y)))});
const square=p=>({row:Math.floor(p.y/F)+1,col:Math.floor(p.x/F)+1});
const squareKey=p=>{const s=square(p);return `${s.row},${s.col}`;};
// Visit every grid cell a segment crosses. Sampling can miss a small corner
// of a forbidden cell even when both checked endpoints are outside it.
function segmentConstraintReason(from,to,options,avoid){
  const end=square(to),blocked=options.blockedEdges;
  if(avoid.has(`${end.row},${end.col}`))return 'mandatory_avoidance';
  let {row,col}=square(from);
  if(blocked?.has?.(`${row},${col}>${end.row},${end.col}`))return 'blocked_navigation_edge';
  if(!avoid.size&&!blocked)return null;
  const dx=to.x-from.x,dy=to.y-from.y,sx=Math.sign(dx),sy=Math.sign(dy);
  let tx=dx?((sx>0?col*F:(col-1)*F)-from.x)/dx:Infinity;
  let ty=dy?((sy>0?row*F:(row-1)*F)-from.y)/dy:Infinity;
  const stepX=dx?F/Math.abs(dx):Infinity,stepY=dy?F/Math.abs(dy):Infinity;
  const limit=Math.ceil(Math.abs(dx)/F)+Math.ceil(Math.abs(dy)/F)+4;
  for(let i=0;i<limit&&Math.min(tx,ty)<1-1e-12;i++){
    const oldRow=row,oldCol=col;
    if(Math.abs(tx-ty)<1e-12){
      if(avoid.has(`${row},${col+sx}`)||avoid.has(`${row+sy},${col}`))return 'mandatory_avoidance';
      col+=sx;row+=sy;tx+=stepX;ty+=stepY;
    }else if(tx<ty){col+=sx;tx+=stepX;}else{row+=sy;ty+=stepY;}
    if(avoid.has(`${row},${col}`))return 'mandatory_avoidance';
    if(blocked?.has?.(`${oldRow},${oldCol}>${row},${col}`))return 'blocked_navigation_edge';
  }
  if(blocked?.has?.(`${row},${col}>${end.row},${end.col}`))return 'blocked_navigation_edge';
  return null;
}
const sameIdentity=(a,b)=>!!a&&!!b&&['security','rows','cols','predicateVersion','collisionDigest','stateFingerprint'].every(k=>a[k]===b[k]);

// Height/depth state is cheap to read and also catches changes made before an
// observer increments the navigation revision. Full collision serialization is
// paid once per immutable geometry state, not per candidate search edge.
export function geometryIdentity(geo,{roomFlags=0,overrideDepths=null}={}){
  if(!geo||typeof geo!=='object')return null;
  // Only the three enabled, finite depth overrides affect native geometry.
  // PK/light/etc room flags must not make every ordinary live room miss its bake.
  const activeDepths={};let physicalFlags=0;
  for(let i=1;i<=3;i++)if((roomFlags&(1<<(i-1)))&&Number.isFinite(overrideDepths?.[i])){physicalFlags|=1<<(i-1);activeDepths[i]=overrideDepths[i];}
  const stateFingerprint=digest({sectors:(geo.sectors??[]).map(s=>[s.floorHeight,s.ceilingHeight,s.depth,s.flags,s.slopedFloor,s.slopedCeiling]),voidSectors:[...(geo.voidSectors?.()??[])].sort((a,b)=>a-b),roomFlags:physicalFlags,
    overrideDepths:physicalFlags?activeDepths:null});
  const old=identities.get(geo),revision=geo._navigationRevision??0;
  if(old?.stateFingerprint===stateFingerprint&&old.revision===revision)return old.identity;
  let collision;
  if(typeof geo.toJSON==='function'){
    const json=geo.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]});
    collision=json.collision?.digest??digest(json);
  }else collision=digest({security:geo.security,rows:geo.rows,cols:geo.cols,walls:geo.walls??[],leaves:geo.leaves??[],sectors:geo.sectors??[]});
  const identity={security:geo.security??null,rows:geo.rows??null,cols:geo.cols??null,
    predicateVersion:STEP_MASK_VERSION,collisionDigest:collision,stateFingerprint};
  identities.set(geo,{stateFingerprint,revision,identity});return identity;
}

export function attachNavMesh(geo,mesh,options={}){
  if(mesh?.format!==NAVMESH_FORMAT||mesh.version!==NAVMESH_VERSION)throw Error('unsupported_navigation_mesh');
  if(!sameIdentity(mesh.identity,geometryIdentity(geo,options)))throw Error('navigation_mesh_geometry_mismatch');
  if(!Array.isArray(mesh.nodes)||!mesh.nodes.every(n=>point(n)&&(mesh._packed||Array.isArray(n.edges))))throw Error('invalid_navigation_mesh_nodes');
  const states=attached.get(geo)??[];
  attached.set(geo,[...states.filter(m=>!sameIdentity(m.identity,mesh.identity)),mesh]);return mesh;
}

let bookCache={file:null,checked:0,mtime:null,book:null,reason:'navigation_mesh_unavailable'};
export function resetNavMeshCache(){bookCache={file:null,checked:0,mtime:null,book:null,reason:'navigation_mesh_unavailable'};roomFiles.clear();}
export function loadNavMeshes({file=process.env.M59_NAVMESH??NAVMESH_FILE,refresh=false}={}){
  const now=Date.now();if(!refresh&&bookCache.file===file&&now-bookCache.checked<1000)return bookCache;
  let stat;
  try{stat=fs.statSync(file);}catch{bookCache={file,checked:now,mtime:null,book:null,reason:'navigation_mesh_unavailable'};return bookCache;}
  if(!refresh&&bookCache.file===file&&bookCache.mtime===stat.mtimeMs){bookCache.checked=now;return bookCache;}
  try{
    if(stat.size>64*1024*1024)throw Error('navigation_mesh_file_too_large');
    const bytes=fs.readFileSync(file),book=JSON.parse((file.endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:256*1024*1024}):bytes).toString('utf8'));
    if(book.format!==NAVMESH_BOOK_FORMAT||book.version!==NAVMESH_VERSION||!book.rooms)throw Error('unsupported_navigation_mesh_book');
    bookCache={file,checked:now,mtime:stat.mtimeMs,book,reason:null};
  }catch(error){bookCache={file,checked:now,mtime:stat.mtimeMs,book:null,reason:error.message};}
  return bookCache;
}
export function navMeshFor(geo,options={}){
  const identity=geometryIdentity(geo,options),local=attached.get(geo)??[];
  const exact=local.find(m=>sameIdentity(m.identity,identity));if(exact)return {mesh:exact,identity};
  const loaded=loadNavMeshes(options);
  if(!loaded.book)return {mesh:null,identity,reason:local.length?'navigation_mesh_geometry_changed':loaded.reason};
  const room=geo.roomNum??geo.num;
  const candidates=room!=null?(loaded.book.rooms[String(room)]??[]):Object.values(loaded.book.rooms).flat();
  const list=Array.isArray(candidates)?candidates:[candidates];
  let mesh=list.find(m=>m?.version===NAVMESH_VERSION&&sameIdentity(m.identity,identity));
  if(mesh?.file){
    // The small book is an index. Only the exact current room state is read and
    // decoded; a keeper does not inflate the entire world's topology at startup.
    const base=path.dirname(path.resolve(loaded.file)),file=path.resolve(base,mesh.file);
    if(!file.startsWith(base+path.sep))return {mesh:null,identity,reason:'navigation_mesh_file_outside_book'};
    try{
      const stat=fs.statSync(file),old=roomFiles.get(file);
      if(old?.mtime===stat.mtimeMs&&old.size===stat.size)mesh=old.mesh;
      else{
        if(options.loadShards===false)return {mesh:null,identity,reason:'navigation_mesh_not_loaded'};
        if(stat.size>64*1024*1024)throw Error('navigation_mesh_file_too_large');
        const bytes=fs.readFileSync(file),body=file.endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:256*1024*1024}):bytes;
        const value=JSON.parse(body.toString('utf8'));
        mesh=value.format===PACKED_NAVMESH_FORMAT?unpackNavMesh(value):value;
        roomFiles.delete(file);roomFiles.set(file,{mtime:stat.mtimeMs,size:stat.size,mesh});
        while(roomFiles.size>1)roomFiles.delete(roomFiles.keys().next().value);
      }
    }catch(error){return {mesh:null,identity,reason:error.message};}
  }else if(mesh?.format===PACKED_NAVMESH_FORMAT){
    if(options.loadShards===false)return {mesh:null,identity,reason:'navigation_mesh_not_loaded'};
    mesh=unpackNavMesh(mesh);
  }
  if(mesh?.format!==NAVMESH_FORMAT||!sameIdentity(mesh.identity,identity))mesh=null;
  return {mesh:mesh??null,identity,reason:mesh?null:'navigation_mesh_state_unavailable'};
}

class Heap{
  constructor(){this.a=[];}
  get length(){return this.a.length;}
  push(v){const a=this.a;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(a[p].f<=v.f)break;a[i]=a[p];i=p;}a[i]=v;}
  pop(){const a=this.a,v=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let j=i*2+1;if(j+1<a.length&&a[j+1].f<a[j].f)j++;if(last.f<=a[j].f)break;a[i]=a[j];i=j;}a[i]=last;}return v;}
}

function indexMesh(mesh){
  if(prepared.has(mesh))return prepared.get(mesh);
  const bins=new Map();
  mesh.nodes.forEach((n,i)=>{const k=`${Math.floor(n.x/F)},${Math.floor(n.y/F)}`,ids=bins.get(k)??[];ids.push(i);bins.set(k,ids);});
  const index={bins};prepared.set(mesh,index);return index;
}

// This proof returns its actual checked points. Re-sampling a simplified aim
// sequence can change ledge legality after integer-wire rounding.
export function proveNavMeshWalk(geo,points,options={}){
  const now=options.now??performance.now.bind(performance),deadline=options.deadline??Infinity;
  if(!points?.length||!points.every(point))return {ok:false,reason:'invalid_navigation_points',points:[]};
  const avoid=options.avoidSquares instanceof Set?options.avoidSquares:new Set(options.avoidSquares??[]),out=[copyPoint(points[0])];
  const first=points[0];
  if(options.bounds&&(first.x<options.bounds.minX||first.x>options.bounds.maxX||first.y<options.bounds.minY||first.y>options.bounds.maxY))return {ok:false,reason:'navigation_bounds',points:out,checks:0};
  if(Number.isFinite(options.minimumFloor)){const leaf=geo.leafAtClient?.(first.x,first.y),floor=leaf?.sector?geo.floorBaseAtClient(first.x,first.y,leaf,options):null;
    if(floor==null||floor<options.minimumFloor)return {ok:false,reason:'minimum_floor',points:out,checks:0};}
  if(avoid.has(squareKey(first))&&points.every(p=>gap(p,first)<.01))return {ok:false,reason:'mandatory_avoidance',points:out,checks:0};
  let checks=0,distance=0;
  for(const target of points.slice(1)){
    const a=out.at(-1),b=wire(target),length=gap(a,b);if(length<0.01)continue;
    // Preserve already-proved wire microsteps exactly. Longer chords use a
    // smaller nominal stride so independent coordinate rounding cannot produce
    // a segment over the 128-unit proof limit.
    const stride=Number.isFinite(options.stride)&&options.stride>0?Math.min(96,options.stride):96;
    const pieces=length<=128?1:Math.ceil(length/stride);
    for(let j=1;j<=pieces;j++){
      if(now()>=deadline||options.cancelled?.())return {ok:false,reason:options.cancelled?.()?'movement_cancelled':'navigation_mesh_budget',points:out,checks};
      const p=wire({x:a.x+(b.x-a.x)*j/pieces,y:a.y+(b.y-a.y)*j/pieces}),from=out.at(-1);
      if(gap(p,from)<0.01)continue;
      const constraint=segmentConstraintReason(from,p,options,avoid);
      if(constraint)return {ok:false,reason:constraint,points:out,checks};
      if(options.bounds&&(p.x<options.bounds.minX||p.x>options.bounds.maxX||p.y<options.bounds.minY||p.y>options.bounds.maxY))return {ok:false,reason:'navigation_bounds',points:out,checks};
      const leaf=geo.leafAtClient?.(p.x,p.y),floor=leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf,options):null;
      if(Number.isFinite(options.minimumFloor)&&(floor==null||floor<options.minimumFloor))return {ok:false,reason:'minimum_floor',points:out,checks};
      const walkDrop=Math.min(options.maxDrop??Infinity,options.maxWalkDrop??Infinity);
      if(Number.isFinite(walkDrop)&&leaf?.sector){
        const prior=geo.floorBaseAtClient(from.x,from.y,geo.leafAtClient(from.x,from.y),options);
        if(prior!=null&&prior-floor>walkDrop)return {ok:false,reason:'maximum_drop',points:out,checks};
      }
      if(options.blockedEdges){const s=square(from),t=square(p),key=`${s.row},${s.col}>${t.row},${t.col}`;
        if(options.blockedEdges.has?.(key))return {ok:false,reason:'blocked_navigation_edge',points:out,checks};}
      if(typeof options.edge==='function'&&!options.edge(from,p))return {ok:false,reason:'caller_edge_refused',points:out,checks};
      const trace=geo.traceFineMoveClient(from.x,from.y,p.x,p.y,{slide:false,obstacles:options.obstacles??[],roomFlags:options.roomFlags??0,overrideDepths:options.overrideDepths??null});checks++;
      if(!trace?.arrived||trace.blocked===true||trace.available===false||!point(trace)||gap(trace,p)>0.05)
        return {ok:false,reason:trace?.reason??'native_navigation_refused',points:out,checks};
      distance+=gap(from,p);out.push(p);
    }
  }
  if(Number.isFinite(options.maxDistance)&&distance>options.maxDistance)return {ok:false,reason:'navigation_distance_limit',points:out,checks};
  return {ok:true,points:out,checks,distance};
}

export function proveNavMeshJump(geo,from,to,action,options={}){
  const now=options.now??performance.now.bind(performance);
  if(options.cancelled?.())return {ok:false,reason:'movement_cancelled'};
  if(now()>=(options.deadline??Infinity))return {ok:false,reason:'navigation_mesh_budget'};
  if(action?.declared!==true)return {ok:false,reason:'undeclared_navigation_jump'};
  if(geo.roomNum!=null&&Number(action.room)!==Number(geo.roomNum))return {ok:false,reason:'navigation_jump_room_mismatch'};
  const declaration=declaredJumpFor(action.room,action.from,action.to);
  if(!declaration)return {ok:false,reason:'unknown_navigation_jump'};
  const a=declaration.from_fine??geo.standPoint?.(declaration.from.row,declaration.from.col);
  const b=declaration.to_fine??geo.standPoint?.(declaration.to.row,declaration.to.col);
  if(!point(a)||!point(b)||!point(action.declaredFrom)||!point(action.declaredTo)||gap(a,action.declaredFrom)>.05||gap(b,action.declaredTo)>.05||
     !point(action.fromFine)||!point(action.toFine)||gap(from,action.fromFine)>.05||gap(to,action.toFine)>.05||
     gap(from,wire(a))>.05||gap(to,wire(b))>.05)
    return {ok:false,reason:'navigation_jump_declaration_mismatch'};
  if(options.running===false)return {ok:false,reason:'jump_needs_run'};
  if(Number.isFinite(options.maxDistance)&&gap(from,to)>options.maxDistance)return {ok:false,reason:'navigation_distance_limit'};
  for(const [id,height]of Object.entries(declaration.requires?.sectors??{}))
    if(!geo.sectors?.some(s=>s.serverId===Number(id)&&s.floorHeight===Number(height)*16))return {ok:false,reason:'jump_precondition_unmet'};
  const avoid=options.avoidSquares instanceof Set?options.avoidSquares:new Set(options.avoidSquares??[]);
  const count=Math.max(1,Math.ceil(gap(from,to)/128));
  for(let i=1;i<=count;i++){
    if(options.cancelled?.())return {ok:false,reason:'movement_cancelled'};
    if(now()>=(options.deadline??Infinity))return {ok:false,reason:'navigation_mesh_budget'};
    const p={x:from.x+(to.x-from.x)*i/count,y:from.y+(to.y-from.y)*i/count};
    const prior={x:from.x+(to.x-from.x)*(i-1)/count,y:from.y+(to.y-from.y)*(i-1)/count};
    const constraint=segmentConstraintReason(prior,p,options,avoid);
    if(constraint)return {ok:false,reason:constraint};
    if(options.bounds&&(p.x<options.bounds.minX||p.x>options.bounds.maxX||p.y<options.bounds.minY||p.y>options.bounds.maxY))return {ok:false,reason:'navigation_bounds'};
    if(options.blockedEdges){const prior={x:from.x+(to.x-from.x)*(i-1)/count,y:from.y+(to.y-from.y)*(i-1)/count},s=square(prior),t=square(p);
      if(options.blockedEdges.has?.(`${s.row},${s.col}>${t.row},${t.col}`))return {ok:false,reason:'blocked_navigation_edge'};}
    if(typeof options.edge==='function'){const prior={x:from.x+(to.x-from.x)*(i-1)/count,y:from.y+(to.y-from.y)*(i-1)/count};
      if(!options.edge(prior,p))return {ok:false,reason:'caller_edge_refused'};}
  }
  const leaf=geo.leafAtClient(to.x,to.y),floor=leaf?.sector?geo.floorBaseAtClient(to.x,to.y,leaf,options):null;
  if(Number.isFinite(options.minimumFloor)&&(floor==null||floor<options.minimumFloor))return {ok:false,reason:'minimum_floor'};
  if(Number.isFinite(options.maxDrop)){const source=geo.floorBaseAtClient(from.x,from.y,geo.leafAtClient(from.x,from.y),options);
    if(source!=null&&floor!=null&&source-floor>options.maxDrop)return {ok:false,reason:'maximum_drop'};}
  const trace=traceFallMotion(geo,from.x,from.y,to.x,to.y,{slide:true,recordFrames:true,
    obstacles:options.obstacles??[],roomFlags:options.roomFlags??0,overrideDepths:options.overrideDepths??null});
  if(!trace?.arrived||trace.available===false||!point(trace)||gap(trace,to)>.05)return {ok:false,reason:trace?.reason??'native_jump_refused'};
  let previous=from;
  for(const p of trace.fall_motion?.frames??[]){
    if(options.cancelled?.())return {ok:false,reason:'movement_cancelled'};
    if(now()>=(options.deadline??Infinity))return {ok:false,reason:'navigation_mesh_budget'};
    const constraint=segmentConstraintReason(previous,p,options,avoid);
    if(constraint)return {ok:false,reason:constraint};
    if(options.bounds&&(p.x<options.bounds.minX||p.x>options.bounds.maxX||p.y<options.bounds.minY||p.y>options.bounds.maxY))return {ok:false,reason:'navigation_bounds'};
    if(typeof options.edge==='function'&&!options.edge(previous,p))return {ok:false,reason:'caller_edge_refused'};
    previous=p;
  }
  if(options.cancelled?.())return {ok:false,reason:'movement_cancelled'};
  if(now()>=(options.deadline??Infinity))return {ok:false,reason:'navigation_mesh_budget'};
  return {ok:true,trace,declaration};
}

function routeCost(points,options){
  let total=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],distance=gap(a,b);
    if(typeof options.cost==='function'){const c=options.cost(a,b);if(!Number.isFinite(c)||c<0)return Infinity;total+=c;continue;}
    let pressure=0;
    if(options.threatWeight>0&&options.threatRadius>0)for(const t of options.threats??[])
      pressure+=Math.max(0,1-gap(b,t)/options.threatRadius)*options.threatWeight;
    total+=distance*(1+pressure);
  }return total;
}

// Transport aims are separate from geometry proof. Same-height chords must pass
// both the whole stock trace and the exact wire microsteps, with unchanged hard
// constraints and no increase in the caller's threat price. Jumps are never
// coalesced by this walking helper.
export function navMeshExecutionAims(geo,plan,options={}){
  const points=plan?.waypoints??[],now=options.now??performance.now.bind(performance);
  const deadline=Math.min(options.deadline??Infinity,now()+(options.maxMs??25));
  if(points.length<3)return {aims:points.map(p=>({...p})),sourceWaypoints:points,coalesced_from:points.length};
  const floor=p=>{const leaf=geo.leafAtClient(p.x,p.y);return leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf,options):null;};
  const aims=[{...points[0]}],maximum=options.maxDistance??1024,heightDelta=options.maxFloorDelta??16;
  for(let at=0;at<points.length-1;){
    let next=at+1;const a=points[at],z=floor(a);
    if(now()<deadline&&Number.isFinite(z)){
      let end=at+1;
      while(end+1<points.length&&end-at<64&&gap(a,points[end+1])<=maximum&&Math.abs(floor(points[end+1])-z)<=heightDelta)end++;
      for(let candidate=end;candidate>at+1&&now()<deadline;candidate--){
        const b=points[candidate];
        if(points.slice(at+1,candidate+1).some(p=>!Number.isFinite(floor(p))||Math.abs(floor(p)-z)>heightDelta))continue;
        const proof=proveNavMeshWalk(geo,[a,b],{...options,deadline});if(!proof.ok)continue;
        if(proof.points.some(p=>!Number.isFinite(floor(p))||Math.abs(floor(p)-z)>heightDelta))continue;
        const whole=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,obstacles:options.obstacles??[],roomFlags:options.roomFlags??0,overrideDepths:options.overrideDepths??null});
        if(!whole?.arrived||whole.blocked||gap(whole,b)>.05)continue;
        if(routeCost(proof.points,options)>routeCost(points.slice(at,candidate+1),options)+.01)continue;
        next=candidate;break;
      }
    }
    aims.push({...points[next]});at=next;
  }
  return {aims,sourceWaypoints:points,coalesced_from:points.length};
}

export function planNavMesh(geo,from,goal,options={}){
  const now=options.now??performance.now.bind(performance),started=now();
  const deadline=Math.min(options.deadline??Infinity,started+(options.maxMs??100));
  const finish=(found,reason,extra={})=>({available:true,found,complete:found,reason,source:'navmesh',ms:now()-started,...extra});
  if(!geo?.collisionReady||typeof geo.traceFineMoveClient!=='function')return {...finish(false,'collision_geometry_unavailable'),available:false};
  if(!point(from)||!point(goal))return {...finish(false,'invalid_navigation_endpoint'),available:false};
  if(options.cancelled?.())return finish(false,'movement_cancelled',{cancelled:true});
  const loaded=options.mesh?{mesh:options.mesh,identity:geometryIdentity(geo,options)}:navMeshFor(geo,options);
  const mesh=loaded.mesh;
  if(!mesh)return {...finish(false,loaded.reason),available:false,identity:loaded.identity};
  if(!sameIdentity(mesh.identity,loaded.identity))return {...finish(false,'navigation_mesh_geometry_mismatch'),available:false,identity:loaded.identity};
  if(!Array.isArray(mesh.nodes)||!mesh.nodes.every(n=>point(n)&&(mesh._packed||Array.isArray(n.edges))))return {...finish(false,'invalid_navigation_mesh'),available:false,identity:loaded.identity};
  const canonical=Number.isFinite(geo.cols)&&Number.isFinite(geo.rows)?{minX:0,minY:0,maxX:geo.cols*F-1,maxY:geo.rows*F-1}:null;
  const bounds=canonical&&options.bounds?{minX:Math.max(canonical.minX,options.bounds.minX),minY:Math.max(canonical.minY,options.bounds.minY),maxX:Math.min(canonical.maxX,options.bounds.maxX),maxY:Math.min(canonical.maxY,options.bounds.maxY)}:options.bounds??canonical;
  const within=p=>!bounds||(p.x>=bounds.minX&&p.y>=bounds.minY&&p.x<=bounds.maxX&&p.y<=bounds.maxY);
  if(!within(from)||!within(goal))return finish(false,'navigation_bounds',{identity:loaded.identity});
  const opts={...options,bounds,deadline,now},nodes=mesh.nodes,index=indexMesh(mesh);
  const avoid=options.avoidSquares instanceof Set?options.avoidSquares:new Set(options.avoidSquares??[]);
  const acceptable=options.goalSquares??(options.goalSquare?[options.goalSquare]:null);
  const goalCells=acceptable?new Set(acceptable.map(s=>`${s.row},${s.col}`)):null;
  const goals=[wire(goal)];
  if(goalCells){
    for(const cell of acceptable){const stand=geo.standPoint?.(cell.row,cell.col);if(point(stand))goals.push(wire(stand));}
    for(const n of nodes)if(goalCells.has(squareKey(n)))goals.push(n);
    goals.sort((a,b)=>gap(a,goal)-gap(b,goal));
  }
  const uniqueGoals=[...new Map(goals.filter(p=>!goalCells||goalCells.has(squareKey(p))).map(p=>[`${p.x},${p.y}`,p])).values()];
  if(goalCells?.has(squareKey(from))){
    if(avoid.has(squareKey(from)))return finish(false,'mandatory_avoidance',{identity:loaded.identity});
    const leaf=geo.leafAtClient(from.x,from.y),floor=leaf?.sector?geo.floorBaseAtClient(from.x,from.y,leaf,opts):null;
    if(Number.isFinite(options.minimumFloor)&&(floor==null||floor<options.minimumFloor))return finish(false,'minimum_floor',{identity:loaded.identity});
    return finish(true,null,{waypoints:[copyPoint(from)],legs:[],visited:0,identity:loaded.identity,distance:0});
  }
  if(!uniqueGoals.length)return finish(false,'navigation_goal_unavailable',{identity:loaded.identity});
  // An exact checked direct walk also retains native ribbons narrower than a
  // Recast polygon. It never grants a closed-door or wrong-floor exception.
  for(const end of uniqueGoals.slice(0,8)){
    if(now()>=deadline)break;
    const proof=proveNavMeshWalk(geo,[from,end],opts);
    if(proof.ok&&(!(options.threatWeight>0)&&typeof options.cost!=='function'))
      return finish(true,null,{waypoints:proof.points,legs:[{kind:'walk',from:copyPoint(from),to:copyPoint(end),waypoints:proof.points}],visited:0,identity:loaded.identity,distance:proof.distance});
  }
  const nearest=p=>{
    const cx=Math.floor(p.x/F),cy=Math.floor(p.y/F),all=[];
    for(let radius=0;radius<=3;radius++){
      for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++){
        if(radius&&Math.max(Math.abs(dx),Math.abs(dy))!==radius)continue;
        for(const id of index.bins.get(`${cx+dx},${cy+dy}`)??[])if(within(nodes[id]))all.push({id,d:gap(p,nodes[id])});
      }
      if(all.length>=24)break;
    }
    return all.sort((a,b)=>a.d-b.d).slice(0,options.maxConnections??24);
  };
  const startConnections=[],goalConnections=new Map();
  for(const c of nearest(from)){
    if(now()>=deadline)break;
    const proof=proveNavMeshWalk(geo,[from,nodes[c.id]],opts);
    if(proof.ok)startConnections.push({...c,points:proof.points,cost:routeCost(proof.points,opts)});
  }
  for(const end of uniqueGoals.slice(0,16))for(const c of nearest(end)){
    if(now()>=deadline)break;
    const proof=proveNavMeshWalk(geo,[nodes[c.id],end],opts);
    if(proof.ok){const cost=routeCost(proof.points,opts),old=goalConnections.get(c.id);if(!old||cost<old.cost)goalConnections.set(c.id,{points:proof.points,cost,end});}
  }
  // A region is a set of acceptable footings, not a shortlist around one
  // representative point. Every mesh node in that region can terminate a route;
  // the selected incoming edge and final path still receive native body proof.
  if(goalCells)for(let id=0;id<nodes.length;id++)if(within(nodes[id])&&goalCells.has(squareKey(nodes[id]))&&!avoid.has(squareKey(nodes[id]))&&
    (!Number.isFinite(options.minimumFloor)||nodes[id].floor>=options.minimumFloor))
    goalConnections.set(id,{points:[copyPoint(nodes[id])],cost:0,end:nodes[id]});
  if(!startConnections.length||!goalConnections.size)return finish(false,now()>=deadline?'navigation_mesh_budget':'navigation_endpoint_disconnected',{visited:0,identity:loaded.identity});
  const best=new Map(),parents=new Map(),open=new Heap(),edgeProofs=new Map();
  const allowedKinds=new Set(options.allowedKinds??['walk']),maxJumps=allowedKinds.has('jump')?(options.maxJumps??4):0;
  const stateKey=(id,jumps)=>`${id}@${jumps}`;
  const obstructed=points=>{
    if(!options.obstacles?.length)return false;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    return options.obstacles.some(o=>{const radius=o.radius??MIN_NOMOVEON;return o.x+radius>=minX&&o.x-radius<=maxX&&o.y+radius>=minY&&o.y-radius<=maxY;});
  };
  const heuristic=id=>{
    if(typeof options.cost==='function')return 0;
    const p=nodes[id];
    if(!acceptable)return gap(p,goal);
    let best=Infinity;
    for(const cell of acceptable){const dx=Math.max((cell.col-1)*F-p.x,0,p.x-cell.col*F),dy=Math.max((cell.row-1)*F-p.y,0,p.y-cell.row*F);best=Math.min(best,Math.hypot(dx,dy));}
    return best;
  };
  for(const c of startConnections){const key=stateKey(c.id,0);if(c.cost<(best.get(key)??Infinity)){best.set(key,c.cost);parents.set(key,{start:c});open.push({id:c.id,key,jumps:0,g:c.cost,f:c.cost+heuristic(c.id)});}}
  let visited=0,bestGoal=null,bestGoalCost=Infinity;
  while(open.length&&visited<(options.maxNodes??20000)){
    if(now()>=deadline||options.cancelled?.())return finish(false,options.cancelled?.()?'movement_cancelled':'navigation_mesh_budget',{visited,identity:loaded.identity});
    const state=open.pop();if(state.g!==best.get(state.key))continue;
    if(state.f>=bestGoalCost)break;
    visited++;
    if(goalConnections.has(state.id)){
      const ending=goalConnections.get(state.id),cost=state.g+ending.cost;
      if(cost<bestGoalCost){bestGoal={id:state.id,key:state.key,ending};bestGoalCost=cost;}
    }
    const node=nodes[state.id];
    for(const [edgeIndex,edge] of node.edges.entries()){
      const key=`${state.id}>${edgeIndex}`;
      const kind=edge.kind??'walk',jumps=state.jumps+(kind==='jump'?1:0),nextKey=stateKey(edge.to,jumps);
      if(!Number.isInteger(edge.to)||!nodes[edge.to]||!within(nodes[edge.to])||!allowedKinds.has(kind)||!['walk','jump'].includes(kind)||jumps>maxJumps)continue;
      const dynamic=typeof options.cost==='function'||typeof options.edge==='function'||options.threatWeight>0||options.obstacles?.length||avoid.size||Number.isFinite(options.minimumFloor)||Number.isFinite(options.maxDrop)||Number.isFinite(options.maxWalkDrop)||options.bounds||options.blockedEdges;
      const points=dynamic?[node,...(edge.points??[]),nodes[edge.to]]:null;
      const cost=!dynamic&&Number.isFinite(edge.cost)?edge.cost:routeCost(points??[node,...(edge.points??[]),nodes[edge.to]],opts),g=state.g+cost;
      if(!Number.isFinite(g)||g>=(best.get(nextKey)??Infinity))continue;
      if(kind==='jump'){
        if(!edgeProofs.has(key))edgeProofs.set(key,proveNavMeshJump(geo,node,nodes[edge.to],edge.action,opts).ok);
        if(!edgeProofs.get(key))continue;
        best.set(nextKey,g);parents.set(nextKey,{from:state.id,fromKey:state.key,edge,key});
        open.push({id:edge.to,key:nextKey,jumps,g,f:g+heuristic(edge.to)});continue;
      }
      // Cheap mandatory constraints during expansion. Geometry and live bodies
      // are proved when the candidate chain is materialized below.
      if(avoid.size&&points.some(p=>avoid.has(squareKey(p))))continue;
      if(Number.isFinite(options.minimumFloor)&&nodes[edge.to].floor<options.minimumFloor)continue;
      // Only potentially affected edges pay for a live trace during expansion.
      // The broad-phase body box is not collision authority: it merely asks the
      // native tracer when an obstacle could touch an already-proved static edge.
      if(points&&(obstructed(points)||typeof options.edge==='function'||avoid.size||Number.isFinite(options.minimumFloor)||Number.isFinite(options.maxDrop)||Number.isFinite(options.maxWalkDrop)||options.bounds||options.blockedEdges)){
        if(!edgeProofs.has(key))edgeProofs.set(key,proveNavMeshWalk(geo,points,opts).ok);
        if(!edgeProofs.get(key))continue;
      }
      best.set(nextKey,g);parents.set(nextKey,{from:state.id,fromKey:state.key,edge,key});open.push({id:edge.to,key:nextKey,jumps,g,f:g+heuristic(edge.to)});
    }
  }
  if(!bestGoal)return finish(false,open.length?'navigation_mesh_node_budget':'navigation_mesh_disconnected',{visited,identity:loaded.identity});
  const pieces=[{kind:'walk',points:bestGoal.ending.points}];let id=bestGoal.id,key=bestGoal.key;
  while(parents.has(key)){
    const parent=parents.get(key);
    if(parent.start){pieces.push({kind:'walk',points:parent.start.points});break;}
    pieces.push({kind:parent.edge.kind??'walk',action:parent.edge.action,
      points:[nodes[parent.from],...(parent.edge.points??[]),nodes[id]]});id=parent.from;key=parent.fromKey;
  }
  pieces.reverse();
  if(pieces.some(p=>p.kind==='jump')){
    const legs=[];let walking=[],distance=0,jumps=0;
    const flush=()=>{
      if(!walking.length)return true;const proof=proveNavMeshWalk(geo,walking,opts);walking=[];
      if(!proof.ok)return false;distance+=proof.distance;
      if(proof.points.length>1)legs.push({kind:'walk',from:copyPoint(proof.points[0]),to:copyPoint(proof.points.at(-1)),waypoints:proof.points});return true;
    };
    for(const piece of pieces){
      if(piece.kind==='walk'){walking.push(...piece.points);continue;}
      if(!flush())return finish(false,'native_navigation_refused',{visited,identity:loaded.identity});
      const a=piece.points[0],b=piece.points.at(-1),proof=proveNavMeshJump(geo,a,b,piece.action,opts);
      if(!proof.ok)return finish(false,proof.reason,{visited,identity:loaded.identity});
      legs.push({kind:'jump',from:copyPoint(a),to:copyPoint(b),fromFine:copyPoint(a),toFine:copyPoint(b),declared:true,
        fromSquare:piece.action.from,toSquare:piece.action.to,declaredFrom:piece.action.declaredFrom,declaredTo:piece.action.declaredTo,requires:piece.action.requires??null});
      jumps++;distance+=gap(a,b);
    }
    if(!flush())return finish(false,'native_navigation_refused',{visited,identity:loaded.identity});
    if(Number.isFinite(options.maxDistance)&&distance>options.maxDistance)return finish(false,'navigation_distance_limit',{visited,identity:loaded.identity});
    const end=legs.at(-1)?.to??from;
    if(goalCells?!goalCells.has(squareKey(end)):gap(end,wire(goal))>0.01)return finish(false,'navigation_incomplete_goal',{visited,identity:loaded.identity});
    if(!sameIdentity(loaded.identity,geometryIdentity(geo,options)))return finish(false,'navigation_geometry_changed',{visited,identity:loaded.identity});
    return finish(true,null,{legs,jumps,visited,identity:loaded.identity,distance,cost:bestGoalCost});
  }
  const raw=pieces.flatMap(p=>p.points),proof=proveNavMeshWalk(geo,raw,opts);
  if(!proof.ok)return finish(false,proof.reason,{visited,identity:loaded.identity,blocked:true});
  if(!sameIdentity(loaded.identity,geometryIdentity(geo,options)))return finish(false,'navigation_geometry_changed',{visited,identity:loaded.identity});
  const end=proof.points.at(-1);
  if(goalCells?!goalCells.has(squareKey(end)):gap(end,wire(goal))>0.01)return finish(false,'navigation_incomplete_goal',{visited,identity:loaded.identity});
  return finish(true,null,{waypoints:proof.points,legs:[{kind:'walk',from:copyPoint(from),to:copyPoint(end),waypoints:proof.points}],visited,
    identity:loaded.identity,distance:proof.distance,cost:bestGoalCost});
}
