import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {NAVMESH_FORMAT,NAVMESH_VERSION,geometryIdentity,attachNavMesh,planNavMesh,
  proveNavMeshWalk,proveNavMeshJump,navMeshExecutionAims,loadNavMeshes,resetNavMeshCache} from './m59-navmesh.mjs';
import {packNavMesh,unpackNavMesh} from './m59-navmesh-codec.mjs';
import {loadFallJumps} from './m59-falljump.mjs';
import {RoomGeometry} from './m59-roo.mjs';

function scene(){
  const sector={floorHeight:0,ceilingHeight:4096,depth:0,flags:0};
  const leaf={sectorNum:1,sector,polygon:[[0,0],[4096,0],[4096,6144],[0,6144]]};
  const geo={collisionReady:true,security:9123,rows:6,cols:4,sectors:[sector],walls:[],leaves:[leaf],
    leafAtClient:()=>leaf,floorBaseAtClient:()=>sector.floorHeight,voidSectors:()=>new Set(),
    traceFineMoveClient(x,y,tx,ty,{obstacles=[]}={}){
      const steps=Math.max(1,Math.ceil(Math.hypot(tx-x,ty-y)/16));
      for(let i=0;i<=steps;i++){
        const px=x+(tx-x)*i/steps,py=y+(ty-y)*i/steps;
        const wall=px>1450&&px<2600&&py>2300&&py<3900;
        const body=obstacles.some(o=>Math.abs(px-o.x)<256&&Math.abs(py-o.y)<256);
        if(wall||body)return {available:true,moved:false,arrived:false,blocked:true,x,y,reason:body?'object_blocked':'geometry_blocked'};
      }
      return {available:true,moved:true,arrived:true,blocked:false,x:tx,y:ty};
    }};
  const points=[{x:512,y:3072},{x:1024,y:1536},{x:3072,y:1536},{x:1024,y:4608},{x:3072,y:4608},{x:3584,y:3072}];
  const nodes=points.map(p=>({...p,floor:0,edges:[]}));
  for(const chain of [[0,1,2,5],[0,3,4,5]])for(let i=1;i<chain.length;i++){
    const a=chain[i-1],b=chain[i],proof=proveNavMeshWalk(geo,[nodes[a],nodes[b]]);assert(proof.ok);
    nodes[a].edges.push({to:b,kind:'walk',points:proof.points.map(({x,y})=>({x,y})),cost:proof.distance});
  }
  const mesh={format:NAVMESH_FORMAT,version:NAVMESH_VERSION,room:99999,identity:geometryIdentity(geo),nodes,polygons:[]};
  attachNavMesh(geo,mesh);return {geo,mesh,from:points[0],goal:points[5]};
}

test('a directed mesh returns a complete native-proved path with exact endpoints',()=>{
  const {geo,from,goal}=scene(),p=planNavMesh(geo,from,goal,{maxMs:500});
  assert(p.available&&p.found&&p.complete);assert.deepEqual(p.waypoints[0],from);assert.deepEqual(p.waypoints.at(-1),goal);
  assert(proveNavMeshWalk(geo,p.waypoints).ok);
  for(let i=1;i<p.waypoints.length;i++)assert(Math.hypot(p.waypoints[i].x-p.waypoints[i-1].x,p.waypoints[i].y-p.waypoints[i-1].y)<=128);
});
test('live bodies reroute a query and do not permanently remove a static edge',()=>{
  const {geo,from,goal}=scene(),obstacles=[{id:2,x:2048,y:1536}];
  const blocked=planNavMesh(geo,from,goal,{obstacles,maxMs:500});assert(blocked.found,blocked.reason);
  assert(blocked.waypoints.some(p=>p.y>3900));assert(proveNavMeshWalk(geo,blocked.waypoints,{obstacles}).ok);
  const clear=planNavMesh(geo,from,goal,{maxMs:500});assert(clear.found);assert(clear.waypoints.some(p=>p.y<2300));
});
test('one-way edges cannot invent the reverse crossing',()=>{
  const {geo,from,goal}=scene();assert.equal(planNavMesh(geo,goal,from,{maxMs:500}).found,false);
});
test('hard exclusions, height fences and bounds apply along every emitted segment',()=>{
  const {geo,from,goal}=scene();
  assert.equal(planNavMesh(geo,from,goal,{minimumFloor:1,maxMs:500}).found,false);
  assert.equal(planNavMesh(geo,from,goal,{bounds:{minX:0,minY:2400,maxX:4096,maxY:3800},maxMs:500}).found,false);
  const avoid=new Set(['2,2','2,3','5,2','5,3']);
  assert.equal(planNavMesh(geo,from,goal,{avoidSquares:avoid,maxMs:500}).found,false);
});
test('observed floor or ceiling changes invalidate a matching static mesh',()=>{
  const {geo,from,goal}=scene();geo.sectors[0].ceilingHeight=1024;
  const p=planNavMesh(geo,from,goal,{maxMs:500});assert.equal(p.available,false);assert.match(p.reason,/geometry_changed|state_unavailable/);
});
test('malformed points, invalid formats, stale identities and cancellation fail closed',()=>{
  const {geo,mesh,from,goal}=scene();
  assert.throws(()=>attachNavMesh(geo,{...mesh,version:2}),/unsupported/);
  assert.throws(()=>attachNavMesh(geo,{...mesh,identity:{...mesh.identity,security:-1}}),/mismatch/);
  assert.equal(planNavMesh(geo,{x:NaN,y:0},goal).found,false);
  assert.equal(proveNavMeshWalk(geo,[from,{x:Infinity,y:0}]).ok,false);
  assert.equal(planNavMesh(geo,from,goal,{cancelled:()=>true}).reason,'movement_cancelled');
  assert.equal(planNavMesh(geo,from,goal,{maxMs:0}).found,false);
});
test('packed mesh round trips checked edge points without dropping direction or floors',()=>{
  const {geo,mesh,from,goal}=scene(),decoded=unpackNavMesh(packNavMesh(mesh));
  assert.deepEqual(decoded.nodes,mesh.nodes);attachNavMesh(geo,decoded);
  const p=planNavMesh(geo,from,goal,{maxMs:500});assert(p.found);assert(proveNavMeshWalk(geo,p.waypoints).ok);
  const corrupt=packNavMesh(mesh);corrupt.edges.to='AAAA';assert.throws(()=>unpackNavMesh(corrupt),/invalid_navigation/);
});
test('small manifest loads only its matching packed room shard',()=>{
  const {geo,mesh,from,goal}=scene(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'m59-navmesh-'));
  const file=path.join(dir,'index.json.gz'),shard=path.join(dir,'room.json.gz');
  fs.writeFileSync(shard,gzipSync(JSON.stringify(packNavMesh(mesh))));
  fs.writeFileSync(file,gzipSync(JSON.stringify({format:'m59-navmesh/1',version:1,rooms:{99999:[{version:1,identity:mesh.identity,file:'room.json.gz'}]}})));
  const other={...geo};other.roomNum=99999;resetNavMeshCache();assert(loadNavMeshes({file}).book);
  assert.equal(planNavMesh(other,from,goal,{file,loadShards:false,maxMs:500}).reason,'navigation_mesh_not_loaded');
  assert(planNavMesh(other,from,goal,{file,maxMs:500}).found);
  assert(planNavMesh(other,from,goal,{file,loadShards:false,maxMs:500}).found);resetNavMeshCache();
  for(const p of [file,shard])fs.unlinkSync(p);fs.rmdirSync(dir);
});
test('execution coalescing keeps source proof and all geometric turns',()=>{
  const {geo,from,goal}=scene(),p=planNavMesh(geo,from,goal,{maxMs:500});
  const compact=navMeshExecutionAims(geo,p,{maxMs:500});assert(compact.aims.length<p.waypoints.length);
  assert.equal(compact.sourceWaypoints,p.waypoints);assert(proveNavMeshWalk(geo,compact.aims).ok);
  for(let i=1;i<compact.aims.length;i++){const a=compact.aims[i-1],b=compact.aims[i];assert(geo.traceFineMoveClient(a.x,a.y,b.x,b.y).arrived);}
});

test('only physical depth overrides change identity; ordinary room flags keep their bake',()=>{
  const {geo}=scene(),base=geometryIdentity(geo);
  assert.deepEqual(geometryIdentity(geo,{roomFlags:0x1000}),base);
  assert.deepEqual(geometryIdentity(geo,{roomFlags:1,overrideDepths:{2:20}}),base);
  assert.notEqual(geometryIdentity(geo,{roomFlags:1,overrideDepths:{1:20}}).stateFingerprint,base.stateFingerprint);
});

function jumpScene(){
  const declaration=loadFallJumps().jumps.find(j=>j.from_fine&&j.to_fine&&!j.requires?.sectors);
  assert(declaration);const from={...declaration.from_fine},goal={...declaration.to_fine};
  const sector={floorHeight:8192,ceilingHeight:20000,depth:0,flags:0},leaf={sector,sectorNum:1};
  const geo={roomNum:declaration.room,collisionReady:true,security:4321,rows:100,cols:100,sectors:[sector],walls:[],leaves:[leaf],
    leafAtClient:()=>leaf,floorBaseAtClient:()=>8192,voidSectors:()=>new Set(),
    traceFineMoveClient(x,y,tx,ty,opts={}){const arrived=(!opts.obstacles?.length&&(opts.timedFall||opts.airborne))||Math.hypot(tx-x,ty-y)<.1;
      return {available:true,arrived,moved:arrived,blocked:!arrived,x:arrived?tx:x,y:arrived?ty:y};}};
  const action={declared:true,room:declaration.room,from:declaration.from,to:declaration.to,fromFine:from,toFine:goal,
    declaredFrom:from,declaredTo:goal,requires:declaration.requires??null};
  const mesh={format:NAVMESH_FORMAT,version:NAVMESH_VERSION,room:geo.roomNum,identity:geometryIdentity(geo),polygons:[],nodes:[
    {...from,floor:8192,edges:[{to:1,kind:'jump',cost:Math.hypot(goal.x-from.x,goal.y-from.y),points:[],action}]},
    {...goal,floor:8192,edges:[]}]};
  attachNavMesh(geo,mesh);return {geo,mesh,from,goal,action};
}

test('declared falls require explicit permission and retain typed boundaries through packing',()=>{
  const {geo,mesh,from,goal}=jumpScene();
  assert.equal(planNavMesh(geo,from,goal,{maxMs:500}).found,false);
  assert.equal(planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],maxJumps:0,maxMs:500}).found,false);
  const decoded=unpackNavMesh(packNavMesh(mesh));attachNavMesh(geo,decoded);
  const result=planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],maxJumps:1,maxMs:500});
  assert(result.found,result.reason);assert.equal(result.jumps,1);assert.equal(result.waypoints,undefined);
  assert.equal(result.legs.length,1);assert.equal(result.legs[0].kind,'jump');
  assert.deepEqual(result.legs[0].from,from);assert.deepEqual(result.legs[0].to,goal);
  assert.equal(planNavMesh(geo,goal,from,{allowedKinds:['walk','jump'],maxMs:500}).found,false);
  assert.equal(planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],running:false,maxMs:500}).found,false);
  assert.equal(planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],obstacles:[{id:1,x:goal.x,y:goal.y}],maxMs:500}).found,false);
});

test('jump proofs refuse invented links, moved endpoints, stale requirements and interrupted work',()=>{
  const {geo,mesh,from,goal,action}=jumpScene();
  assert.equal(proveNavMeshJump(geo,from,goal,{...action,declared:false}).reason,'undeclared_navigation_jump');
  assert.equal(proveNavMeshJump(geo,from,goal,{...action,room:-1}).reason,'navigation_jump_room_mismatch');
  assert.equal(proveNavMeshJump(geo,from,goal,{...action,to:{row:1,col:1}}).reason,'unknown_navigation_jump');
  const moved={x:from.x+16,y:from.y};
  assert.equal(proveNavMeshJump(geo,moved,goal,{...action,fromFine:moved}).reason,'navigation_jump_declaration_mismatch');
  assert.equal(proveNavMeshJump(geo,from,goal,action,{cancelled:()=>true}).reason,'movement_cancelled');
  assert.equal(proveNavMeshJump(geo,from,goal,action,{deadline:0}).reason,'navigation_mesh_budget');
  assert.equal(proveNavMeshJump(geo,from,goal,action,{edge:()=>false}).reason,'caller_edge_refused');
  assert.equal(proveNavMeshJump(geo,from,goal,action,{maxDistance:200}).reason,'navigation_distance_limit');
  assert.equal(planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],edge:()=>false,maxMs:500}).found,false);
  assert.equal(planNavMesh(geo,from,goal,{allowedKinds:['walk','jump'],maxDistance:200,maxMs:500}).found,false);
  assert.equal(proveNavMeshJump(geo,from,goal,action,{avoidSquares:new Set([`${action.to.row},${action.to.col}`])}).reason,'mandatory_avoidance');
  mesh.nodes[0].edges[0].action={...action,declared:false};assert.throws(()=>packNavMesh(mesh),/unsupported_packed_navigation_action/);
});

test('room-local mesh queries refuse off-map endpoints even with positive padded BSP floors',()=>{
  const {geo,from}=scene();
  assert.equal(planNavMesh(geo,from,{x:geo.cols*1024+16,y:from.y}).reason,'navigation_bounds');
});

test('region goals include reachable shelves beyond the representative-point shortlist',()=>{
  const sector={floorHeight:0,ceilingHeight:4096,depth:0,flags:0},leaf={sector};
  const geo={collisionReady:true,rows:6,cols:4,security:7788,sectors:[sector],leaves:[leaf],walls:[],voidSectors:()=>new Set(),
    leafAtClient:()=>leaf,floorBaseAtClient:()=>0,
    traceFineMoveClient(x,y,tx,ty){const arrived=(x<2000)===(tx<2000);return {available:true,arrived,blocked:!arrived,x:arrived?tx:x,y:arrived?ty:y};}};
  const from={x:512,y:512},shelf={x:512,y:4608},goal={x:3584,y:1280};
  const nodes=[{...from,floor:0,edges:[{to:1,kind:'walk',points:[],cost:4096}]},{...shelf,floor:0,edges:[]},
    ...Array.from({length:36},(_,i)=>({x:3504,y:1104+i*16,floor:0,edges:[]}))];
  attachNavMesh(geo,{format:NAVMESH_FORMAT,version:NAVMESH_VERSION,identity:geometryIdentity(geo),nodes,polygons:[]});
  const result=planNavMesh(geo,from,goal,{goalSquares:[{row:2,col:4},{row:5,col:1}],maxMs:500});
  assert(result.found,result.reason);assert.deepEqual(result.waypoints.at(-1),shelf);
  assert(proveNavMeshWalk(geo,result.waypoints).ok);
});

test('already inside a goal region cannot bypass the required floor or excluded goal',()=>{
  const {geo,from}=scene(),goalSquare={row:4,col:1};
  assert.equal(planNavMesh(geo,from,from,{goalSquare,minimumFloor:1000}).reason,'minimum_floor');
  assert.equal(planNavMesh(geo,from,from,{minimumFloor:1000}).found,false);
  assert.equal(proveNavMeshWalk(geo,[from],{minimumFloor:1000}).reason,'minimum_floor');
  assert.equal(planNavMesh(geo,from,from,{goalSquare,avoidSquares:new Set(['4,1'])}).reason,'mandatory_avoidance');
});

test('small forbidden cell corners cannot hide between exact wire proof endpoints',()=>{
  const {geo}=scene(),points=[{x:1008,y:1056},{x:1056,y:1008}];
  assert(proveNavMeshWalk(geo,points).ok);
  assert.equal(proveNavMeshWalk(geo,points,{avoidSquares:new Set(['2,2'])}).reason,'mandatory_avoidance');
  assert.equal(proveNavMeshWalk(geo,points,{blockedEdges:new Set(['2,1>2,2'])}).reason,'blocked_navigation_edge');
});

test('real declared falls obey continuous cell exclusions and their actual sliding frame path',()=>{
  const map=JSON.parse(fs.readFileSync(new URL('../substrate/m59-map.json',import.meta.url)));
  const check=(room,fromRow,fromCol,toRow,toCol,options={})=>{
    const d=loadFallJumps().jumps.find(j=>j.room===room&&j.from.row===fromRow&&j.from.col===fromCol&&j.to.row===toRow&&j.to.col===toCol);
    assert(d);const geo=RoomGeometry.fromJSON(map.rooms[room].roo);geo.roomNum=room;
    const a=d.from_fine,b=d.to_fine,action={declared:true,room,from:d.from,to:d.to,fromFine:a,toFine:b,declaredFrom:a,declaredTo:b,requires:d.requires};
    return proveNavMeshJump(geo,a,b,action,options);
  };
  assert(check(589,35,16,38,19).ok);
  assert.equal(check(589,35,16,38,19,{avoidSquares:new Set(['36,18'])}).reason,'mandatory_avoidance');
  assert(check(579,38,31,42,30).ok);
  const fence=(_a,p)=>Math.abs(-400*(p.y-38400)-3600*(p.x-30720))/Math.hypot(400,3600)<=16;
  assert.equal(check(579,38,31,42,30,{edge:fence}).reason,'caller_edge_refused');
});
