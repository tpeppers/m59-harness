// Behavioral adapter contracts; all scenes are synthetic, with no sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NAVMESH_FORMAT,NAVMESH_VERSION,geometryIdentity,attachNavMesh,NAVMESH_BOOK_FORMAT,planNavMesh,resetNavMeshCache} from './m59-navmesh.mjs';
import {planBodyDetour} from './m59-body-detour.mjs';
import {cutMovementRail,cutFineRailAsync} from './m59-fine-rail.mjs';
import {fineRouter} from './m59-fineroute.mjs';
import {loadFallJumps} from './m59-falljump.mjs';
import {RoomGeometry,protocolToClient,clientToProtocol} from './m59-roo.mjs';
import {MOVEON} from './m59-parse.mjs';

const kod=p=>({x:clientToProtocol(p.x),y:clientToProtocol(p.y)});
function scene({rows=2,cols=4,barrier=null,floor=()=>0,attach=true,points=[]}={}){
 const sector={floorHeight:0,ceilingHeight:10000,depth:0,flags:0};
 const leaf={node:1,sectorNum:1,sector,polygon:[[0,0],[cols*1024,0],[cols*1024,rows*1024],[0,rows*1024]]};
 const geo={collisionReady:true,security:900101,rows,cols,sectors:[sector],walls:[],leaves:[leaf],
  leafAtClient(x,y){return x>=0&&y>=0&&x<cols*1024&&y<rows*1024?leaf:null;},
  floorBaseAtClient(x,y){return this.leafAtClient(x,y)?floor(x,y):null;},
  standPoint(row,col){return {x:(col-1)*1024+512,y:(row-1)*1024+512};},
  buildStepMask(){return new Uint8Array(rows*cols);},attachStepMask(){return true;},
  traceFineMoveClient(x,y,tx,ty,{obstacles=[]}={}){
   const distance=Math.hypot(tx-x,ty-y),n=Math.max(1,Math.ceil(distance/16));
   for(let i=0;i<=n;i++){
    const p={x:x+(tx-x)*i/n,y:y+(ty-y)*i/n};
    const reason=!this.leafAtClient(p.x,p.y)||barrier?.(p)?'geometry_blocked':
     obstacles.some(o=>Math.abs(p.x-o.x)<256&&Math.abs(p.y-o.y)<256)?'object_blocked':null;
    if(reason)return {available:true,moved:false,arrived:false,blocked:true,reason,x,y};
   }
   return {available:true,moved:distance>0,arrived:true,blocked:false,x:tx,y:ty};
  }};
 const nodes=(points.length?points:[{x:512,y:512},{x:2560,y:512}]).map(p=>({...p,floor:floor(p.x,p.y),edges:[]}));
 for(let i=0;i<nodes.length;i++)for(let j=0;j<nodes.length;j++)if(i!==j)nodes[i].edges.push({to:j,kind:'walk',points:[]});
 if(attach)attachNavMesh(geo,{format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),nodes,polygons:[]});
 return geo;
}

test('local mesh adapter preserves KOD endpoints and omits the source waypoint',()=>{
 const geo=scene(),from={x:512,y:512},goal={x:2560,y:512};
 const p=planBodyDetour(geo,kod(from),kod(goal),{maxMs:500,maxNodes:10000});
 assert.equal(p.found,true);assert.equal(p.source,'navmesh');
 assert.deepEqual(p.waypoints.at(-1),kod(goal));assert.notDeepEqual(p.waypoints[0],kod(from));
 let previous=from;for(const pnt of p.waypoints){const next={x:protocolToClient(pnt.x),y:protocolToClient(pnt.y)};
  assert(geo.traceFineMoveClient(previous.x,previous.y,next.x,next.y).arrived);previous=next;}
});

test('local endpoint range and zero budget remain hard limits',()=>{
 const geo=scene({cols:20}),from=kod({x:512,y:512}),goal=kod({x:12*1024+512,y:512});
 const range=planBodyDetour(geo,from,goal,{maxMs:500});
 assert.equal(range.found,false);assert.equal(range.reason,'body detour exceeds local bounds');
 const budget=planBodyDetour(geo,from,kod({x:1536,y:512}),{maxMs:0});
 assert.equal(budget.found,false);assert.equal(budget.reason,'body detour budget exhausted');
});

test('square goals accept a proved unoccupied footing rather than an occupied center',()=>{
 const geo=scene({rows:1,points:[{x:512,y:512},{x:2176,y:512},{x:2560,y:512}]}),goal={x:2560,y:512};
 const object={id:2,...kod(goal),flags:MOVEON.NO};
 const objects=new Map([[2,object]]);
 const p=planBodyDetour(geo,kod({x:512,y:512}),kod(goal),{goalSquare:{row:1,col:3},objects,selfId:1,maxMs:500,maxNodes:10000});
 assert.equal(p.found,true);assert.equal(p.source,'navmesh');
 assert.equal(Math.floor(p.waypoints.at(-1).x/64),3);
 assert.notDeepEqual(p.waypoints.at(-1),kod(goal));
});

test('mandatory avoidance and minimum floor survive mesh and native fallback',()=>{
 const geo=scene({rows:1,cols:3}),from=kod({x:512,y:512}),goal=kod({x:2560,y:512});
 const avoided=planBodyDetour(geo,from,goal,{avoidSquares:new Set(['1,2']),maxMs:200,maxNodes:20000});
 assert.equal(avoided.found,false);
 const low=planBodyDetour(geo,from,goal,{minimumFloor:1,maxMs:200,maxNodes:20000});
 assert.equal(low.found,false);
});

test('threat pricing chooses the safer side of an actual geometric obstruction',()=>{
 const points=[{x:512,y:128},{x:1024,y:128},{x:2048,y:128},{x:2560,y:128},
  {x:512,y:896},{x:1024,y:896},{x:2048,y:896},{x:2560,y:896}];
 const geo=scene({rows:1,cols:3,points,barrier:p=>p.x>1024&&p.x<2048&&p.y>384&&p.y<640});
 const p=planBodyDetour(geo,kod({x:512,y:512}),kod({x:2560,y:512}),{
  threats:[kod({x:1536,y:128})],threatWeight:10,threatRadius:1,maxMs:500,maxNodes:10000});
 assert.equal(p.found,true);assert.equal(p.source,'navmesh');
 assert(p.waypoints.some(q=>protocolToClient(q.y)>640));
});

test('missing mesh retains native local planning',()=>{
 const geo=scene({attach:false}),p=planBodyDetour(geo,kod({x:512,y:512}),kod({x:1024,y:512}),{maxMs:200});
 assert.equal(p.found,true);assert.notEqual(p.source,'navmesh');
});

test('rail adapter returns cutter shape and honors caller edge refusals',()=>{
 const geo=scene(),from={x:512,y:512},goal={x:2560,y:512};
 const settings={edge:(a,b)=>geo.traceFineMoveClient(a.x,a.y,b.x,b.y).arrived,bounds:{w:4096,h:2048},maxMs:500};
 const p=cutMovementRail(geo,from,goal,settings);
 assert.equal(p.ok,true);assert.equal(p.bridgeOk,true);assert.equal(p.source,'navmesh');
 assert.deepEqual(p.waypoints[0],{...from,f:null});assert.deepEqual(p.waypoints.at(-1),{...goal,f:null});
 const refused=cutMovementRail(geo,from,goal,{...settings,edge:()=>false,maxMs:100});
 assert.equal(refused.ok,false);
});

test('Mana Node exact walking uses mesh without inventing a jump',()=>{
 const geo=scene(),R=fineRouter(9001,{geometry:geo,worldMap:{rooms:{9001:{num:9001}}},exactWalk:true});
 const p=R.planWalkToPoint({x:512,y:512},{x:2560,y:512});
 assert.equal(p.ok,true);assert.equal(p.source,'navmesh');assert.equal(p.jumps,0);assert.equal(p.all_declared,true);
 assert.deepEqual(p.legs[0].waypoints.at(-1),{x:2560,y:512,row:1,col:3});
 assert.equal(p.legs[0].walk_proof.checked,true);
});

test('Mana Node maximum walking drop uses CLIENT height units',()=>{
 const geo=scene({rows:1,cols:3,floor:x=>x<1536?512:0});
 const R=fineRouter(9002,{geometry:geo,worldMap:{rooms:{9002:{num:9002}}},exactWalk:true,maxDescend:384});
 const p=R.planWalkToPoint({x:512,y:512},{x:2560,y:512});
 assert.equal(p.ok,false);
 const shallow=scene({rows:1,cols:3,floor:x=>x<1536?256:0});
 const allowed=fineRouter(9003,{geometry:shallow,worldMap:{rooms:{9003:{num:9003}}},exactWalk:true,maxDescend:384})
  .planWalkToPoint({x:512,y:512},{x:2560,y:512});
 assert.equal(allowed.ok,true);assert.equal(allowed.source,'navmesh');
});


test('worker carries room identity into void-sector fingerprint and artifact lookup',async()=>{
 const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
 const geo=RoomGeometry.fromJSON(map.rooms[537].roo);geo.roomNum=537;
 assert(geo.voidSectors().has(1));
 let from,goal;
 for(let row=1;row<=geo.rows&&!from;row++)for(let col=1;col<=geo.cols&&!from;col++){
  const p=geo.standPoint(row,col);if(!p)continue;
  const q={x:p.x+128,y:p.y},t=geo.traceFineMoveClient(p.x,p.y,q.x,q.y,{slide:false});
  if(t.arrived===true&&t.blocked!==true){from=p;goal=q;}
 }
 assert(from&&goal,'the real bulb has a short checked interior walk');
 const mesh={format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),
  nodes:[from,goal].map(p=>({...p,floor:geo.floorBaseAtClient(p.x,p.y),edges:[]})),polygons:[]};
 const directory=mkdtempSync(join(tmpdir(),'m59-navmesh-adapter-')),file=join(directory,'mesh.json');
 const previous=process.env.M59_NAVMESH;
 try{
  writeFileSync(file,JSON.stringify({format:NAVMESH_BOOK_FORMAT,version:NAVMESH_VERSION,rooms:{537:[mesh]}}));
  process.env.M59_NAVMESH=file;
  const p=await cutFineRailAsync(geo,kod(from),kod(goal),{maxMs:1000},{timeoutMs:5000});
  assert.equal(p.ok,true,p.reason??p.why);assert.equal(p.source,'navmesh');
  assert.equal(p.navmesh_identity.stateFingerprint,mesh.identity.stateFingerprint);
 }finally{
  if(previous===undefined)delete process.env.M59_NAVMESH;else process.env.M59_NAVMESH=previous;
  rmSync(directory,{recursive:true,force:true});
 }
});


function declaredScene(){
 const d=loadFallJumps().jumps.find(j=>j.from_fine&&j.to_fine&&!j.requires?.sectors);
 const a=d.from_fine,b=d.to_fine,sector={floorHeight:8192,ceilingHeight:20000,depth:0,flags:0},leaf={sector,sectorNum:1};
 const near=(p,q)=>Math.hypot(p.x-q.x,p.y-q.y)<=384;
 const geo={roomNum:d.room,collisionReady:true,security:991144,rows:100,cols:100,sectors:[sector],walls:[],leaves:[leaf],
  leafAtClient:()=>leaf,floorBaseAtClient:()=>8192,voidSectors:()=>new Set(),
  standPoint:(row,col)=>({x:(col-1)*1024+512,y:(row-1)*1024+512}),
  buildStepMask:()=>new Uint8Array(10000),attachStepMask:()=>true,
  traceFineMoveClient(x,y,tx,ty,options={}){
   const p={x,y},q={x:tx,y:ty};
   const arrived=options.timedFall===true||options.airborne===true||near(p,a)&&near(q,a)||near(p,b)&&near(q,b);
   return {available:true,moved:arrived&&Math.hypot(tx-x,ty-y)>0,arrived,blocked:!arrived,x:arrived?tx:x,y:arrived?ty:y};
  }};
 const action={declared:true,room:d.room,from:d.from,to:d.to,fromFine:a,toFine:b,declaredFrom:a,declaredTo:b,requires:d.requires};
 const mesh={format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),polygons:[],nodes:[
  {...a,floor:8192,edges:[{to:1,kind:'jump',points:[],action}]},{...b,floor:8192,edges:[]}]};
 attachNavMesh(geo,mesh);
 const router=fineRouter(d.room,{geometry:geo,worldMap:{rooms:{[d.room]:{num:d.room}}},exactWalk:true,maxDescend:0});
 return {d,a,b,geo,mesh,router};
}

test('fineRouter retains typed walking and a real declared jump only when permitted',()=>{
 const {router,d,a}=declaredScene(),from={x:a.x-256,y:a.y};
 const p=router.plan(from,d.to,{maxJumps:1,maxMs:500});
 assert.equal(p.ok,true);assert.equal(p.source,'navmesh');assert.equal(p.jumps,1);assert.equal(p.all_declared,true);
 assert.deepEqual(p.legs.map(l=>l.kind),['walk','jump']);
 const jump=p.legs[1];assert.deepEqual(jump.from,d.from);assert.deepEqual(jump.to,d.to);
 assert.deepEqual(jump.fromFine,d.from_fine);assert.deepEqual(jump.toFine,d.to_fine);
 assert.deepEqual(jump.declared_from,d.from_fine);assert.deepEqual(jump.declared_to,d.to_fine);
 const walking=router.plan(from,d.to,{maxJumps:0,maxMs:500});assert.equal(walking.ok,false);
 const exactWalk=router.planWalkToPoint(from,d.to_fine,{maxJumps:1,maxMs:500});assert.equal(exactWalk.ok,false);
});

test('undeclared mesh action cannot become an executable invented fineRouter jump',()=>{
 const {router,mesh,d,a}=declaredScene();mesh.nodes[0].edges[0].action.declared=false;
 const p=router.plan(a,d.to,{maxJumps:1,maxMs:500});
 assert.notEqual(p.source,'navmesh');
 if(p.ok)assert(p.legs.filter(l=>l.kind==='jump').every(l=>l.declared===true),'native fallback retains its actual declarations');
});

test('real committed Ukgoth jump survives a strict walking descent fence as a typed action',()=>{
 const map=JSON.parse(readFileSync(new URL('../substrate/m59-map.json',import.meta.url),'utf8'));
 const d=loadFallJumps().jumps.find(j=>j.room===599&&j.from_fine),geo=RoomGeometry.fromJSON(map.rooms[599].roo);geo.roomNum=599;
 const a=d.from_fine,b=d.to_fine,action={declared:true,room:d.room,from:d.from,to:d.to,fromFine:a,toFine:b,
  declaredFrom:a,declaredTo:b,requires:d.requires};
 const nodes=[a,b].map(p=>({...p,floor:geo.floorBaseAtClient(p.x,p.y),edges:[]}));nodes[0].edges=[{to:1,kind:'jump',points:[],action}];
 attachNavMesh(geo,{format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),nodes,polygons:[]});
 const R=fineRouter(599,{geometry:geo,worldMap:map,exactWalk:true,maxDescend:0}),p=R.plan({...d.from,...a},d.to,{maxJumps:1,maxMs:1000});
 assert.equal(p.ok,true);assert.equal(p.source,'navmesh');assert.equal(p.jumps,1);
 const jump=p.legs.find(l=>l.kind==='jump');assert.deepEqual(jump.declared_from,a);assert.deepEqual(jump.declared_to,b);
 assert(p.legs.every(l=>l.kind==='jump'||l.walk_proof.checked));
});

test('missing mesh lookup time is charged to the original local fallback deadline',()=>{
 const geo=scene({attach:false});let clock=0,traces=0;
 geo.toJSON=()=>{clock+=1000;return {collision:{digest:'slow-absent-mesh'}};};
 geo.traceFineMoveClient=()=>{traces++;throw Error('expired fallback cannot start a fresh native search');};
 const p=planBodyDetour(geo,kod({x:512,y:512}),kod({x:2560,y:512}),{maxMs:35,now:()=>clock});
 assert.equal(p.found,false);assert.equal(p.reason,'body detour budget exhausted');assert.equal(traces,0);
 const invalid=planBodyDetour(geo,{x:NaN,y:0},kod({x:512,y:512}),{maxMs:0});assert.equal(invalid.reason,'own_position_unknown');
 const far=planBodyDetour(geo,kod({x:512,y:512}),kod({x:20*1024,y:512}),{maxMs:0});assert.equal(far.reason,'body detour exceeds local bounds');
});


test('local detours skip cold shard decoding and can reuse a mesh warmed by a room query',()=>{
 const geo=scene({attach:false});geo.roomNum=9001;
 const from={x:512,y:512},goal={x:2560,y:512},identity=geometryIdentity(geo);
 const mesh={format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity,polygons:[],nodes:[
  {...from,floor:0,edges:[{to:1,kind:'walk',points:[]}]},{...goal,floor:0,edges:[]}]};
 const directory=mkdtempSync(join(tmpdir(),'m59-navmesh-cold-')),file=join(directory,'book.json'),previous=process.env.M59_NAVMESH;
 try{
  writeFileSync(join(directory,'room.json'),JSON.stringify(mesh));
  writeFileSync(file,JSON.stringify({format:NAVMESH_BOOK_FORMAT,version:NAVMESH_VERSION,
   rooms:{9001:[{version:NAVMESH_VERSION,identity,file:'room.json'}]}}));
  process.env.M59_NAVMESH=file;resetNavMeshCache();
  const cold=planBodyDetour(geo,kod(from),kod(goal),{maxMs:500});
  assert.equal(cold.found,true);assert.notEqual(cold.source,'navmesh');
  assert.equal(planNavMesh(geo,from,goal,{maxMs:500}).found,true);
  const warm=planBodyDetour(geo,kod(from),kod(goal),{maxMs:500});
  assert.equal(warm.found,true);assert.equal(warm.source,'navmesh');
 }finally{
  if(previous===undefined)delete process.env.M59_NAVMESH;else process.env.M59_NAVMESH=previous;
  resetNavMeshCache();rmSync(directory,{recursive:true,force:true});
 }
});

test('fineRouter refuses a mesh walking proof that its rounded node-rail spans cannot reproduce',()=>{
 const geo=scene(),native=geo.traceFineMoveClient;
 geo.traceFineMoveClient=function(x,y,tx,ty,options){
  if(x===512&&y===512&&Math.hypot(tx-x,ty-y)>0&&Math.hypot(tx-x,ty-y)<=64)return {available:true,moved:false,arrived:false,blocked:true,x,y};
  return native.call(this,x,y,tx,ty,options);
 };
 // The fixture's geometry changed before attachment; keep the explicit identity current.
 const nodes=[{x:512,y:512,floor:0,edges:[{to:1,kind:'walk',points:[]}]},{x:2560,y:512,floor:0,edges:[]}];
 attachNavMesh(geo,{format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),nodes,polygons:[]});
 const R=fineRouter(9004,{geometry:geo,worldMap:{rooms:{9004:{num:9004}}},exactWalk:true});
 const p=R.planWalkToPoint({x:512,y:512},{x:2560,y:512});
 assert.notEqual(p.source,'navmesh');
});
