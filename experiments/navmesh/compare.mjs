// Offline route comparison. Imports geometry/planners only; opens no game sockets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {RoomGeometry,sharedRoomGeometry,protocolToClient,clientToProtocol,STEP_MASK_VERSION} from '../../tools/m59-roo.mjs';
import {attachStepMasks} from '../../tools/m59-routes.mjs';
import {cutFineRailAsync} from '../../tools/m59-fine-rail.mjs';
import {blockingBodySnapshot,planBodyDetour} from '../../tools/m59-body-detour.mjs';
import {applyCeilingDoors} from '../../tools/m59-ceiling-doors.mjs';
import {benchmarkCases} from './cases.mjs';
import {recastReady,buildRecastPlanner} from './recast.mjs';
import {buildPortalPlanner} from './portal.mjs';
import {currentFineQuery} from './baseline.mjs';
import {execFileSync} from 'node:child_process';

export function assessPath(geo,points,from,goal,{obstacles=[],avoidSquares=[],minimumFloor,roomFlags=0,overrideDepths}={}){
  if(!points?.length)return {valid:false,reason:'empty_path'};
  if(![from,goal,...points].every(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y)))return {valid:false,reason:'invalid_point'};
  const wire=p=>({x:Math.round(p.x/16)*16,y:Math.round(p.y/16)*16});
  const avoid=new Set(avoidSquares),out=[{...from}],end=points.at(-1);
  if(Math.hypot(end.x-goal.x,end.y-goal.y)>128)return {valid:false,reason:'incomplete_endpoint'};
  // Every backend must bridge from the actual body and to the identical exact goal.
  const route=[from,...points,goal];let checks=0,distance=0;
  for(let i=1;i<route.length;i++){
    const a=out.at(-1),b=wire(route[i]),len=Math.hypot(b.x-a.x,b.y-a.y);
    if(len<0.01)continue;
    // A long clear chord is insufficient proof in this geometry. Reproduce one-eighth-square
    // steps, quantize the exact points to the wire, and retain the actual confirmed start.
    const n=Math.max(1,Math.ceil(len/128));
    for(let j=1;j<=n;j++){
      const p=wire({x:a.x+(b.x-a.x)*j/n,y:a.y+(b.y-a.y)*j/n});
      const prev=out.at(-1);if(p.x===prev.x&&p.y===prev.y)continue;
      const square={row:Math.floor(clientToProtocol(p.y)/64),col:Math.floor(clientToProtocol(p.x)/64)};
      if(avoid.has(`${square.row},${square.col}`))return {valid:false,reason:'mandatory_avoidance',checks,at:p};
      if(Number.isFinite(minimumFloor)){
        const leaf=geo.leafAtClient(p.x,p.y),h=leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf,{roomFlags,overrideDepths}):null;
        if(h==null||h<minimumFloor)return {valid:false,reason:'minimum_floor',checks,at:p};
      }
      const t=geo.traceFineMoveClient(prev.x,prev.y,p.x,p.y,{slide:false,obstacles,roomFlags,overrideDepths});checks++;
      if(!t?.arrived||t.blocked===true||Math.hypot((t.x??Infinity)-p.x,(t.y??Infinity)-p.y)>0.05)
        return {valid:false,reason:t?.reason??'native_trace_refused',checks,at:p,from:prev};
      distance+=Math.hypot(p.x-prev.x,p.y-prev.y)/1024;out.push(p);
    }
  }
  return {valid:true,checks,distance_squares:distance,wire_points:out.length};
}
const quantile=(xs,p)=>{if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y);return a[Math.ceil(p*a.length)-1];};
const timing=xs=>({median_ms:quantile(xs,0.5),p95_ms:quantile(xs,0.95),min_ms:Math.min(...xs),samples:xs.length});

async function main(){
  const args=process.argv.slice(2),value=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const mapFile=path.resolve(value('--map',path.join(root,'substrate/m59-map.json')));
  const mapBytes=fs.readFileSync(mapFile),map=JSON.parse(mapBytes),maskSummary=attachStepMasks(map);
  const cases=benchmarkCases(map).filter(c=>!value('--case',null)||c.id.includes(value('--case',null)));
  const rounds=Number(value('--rounds','3')),queryRounds=Number(value('--query-rounds','25'));
  if(!Number.isInteger(rounds)||rounds<1||!Number.isInteger(queryRounds)||queryRounds<1)throw Error('positive rounds required');
  const output=path.resolve(value('--out',path.join(root,'experiments/navmesh/results.json')));
  const result={source_revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),schema:'m59-navmesh-comparison/1',created_at:new Date().toISOString(),node:process.version,
    platform:`${os.platform()} ${os.arch()}`,cpu:os.cpus()[0]?.model,rounds,query_rounds:queryRounds,
    map:{file:mapFile,sha256:crypto.createHash('sha256').update(mapBytes).digest('hex'),geometryManifestSha256:map.geometryManifestSha256,step_mask_version:STEP_MASK_VERSION,mask_attachment:maskSummary},
    experiment_sources:Object.fromEntries(['compare.mjs','recast.mjs','geometry.mjs','portal.mjs','baseline.mjs','cases.mjs','package-lock.json'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(new URL(name,import.meta.url))).digest('hex')])),
    dependency:{name:'recast-navigation',version:'0.44.0'},
    methodology:{query:'One untimed warm-up before in-process fine, portal and Recast queries. Existing fine worker additionally measures full invocation including snapshot/startup. No threat costs or refuge selection in any arm.',
      validation:'Same native no-slide microstep trace at <=128 client units, after wire quantization, from exact start to exact goal; live bodies, minimum floor, mandatory exclusions.',
      limits:'Offline geometry evidence only; no game packets or survival measurements. Static Recast has no body detour or threat-cost adapter. Portal graph is a sampled prototype.'},cases:[],bakes:[]};
  await recastReady();
  const bakes=new Map(),portals=new Map();
  const variants=[{id:'recast-1/8',cs:1/8},{id:'recast-1/16',cs:1/16},{id:'recast-ceilings-1/16',cs:1/16,profile:'conventional'}];
  if(args.includes('--fine-resolution'))variants.push({id:'recast-1/32',cs:1/32});
  if(args.includes('--point-diagnostic'))variants.push({id:'recast-point-1/16',cs:1/16,radius:0});
  for(const c of cases){
    console.log(`case ${c.id}`);
    const geo=RoomGeometry.fromJSON(map.rooms[c.room].roo);geo.roomNum=c.room;
    // Attach the exact same step mask as the committed-map reference to every arm.
    const cached=sharedRoomGeometry(map.rooms[c.room]);
    if(cached?._stepMask)geo.attachStepMask(cached._stepMask);
    if(c.doorOpen)applyCeilingDoors(map,c.room,new Map([[1,{type:5,height:1150}]]),null,{geometryOf:()=>geo});
    const objects=new Map((c.bodies??[]).map(o=>[o.id,o]));
    const obstacles=blockingBodySnapshot(objects,c.selfId),from={x:protocolToClient(c.from.x),y:protocolToClient(c.from.y)},goal={x:protocolToClient(c.goal.x),y:protocolToClient(c.goal.y)};
    const options={obstacles,avoidSquares:c.avoidSquares??[],minimumFloor:c.minimumFloor,roomFlags:c.roomFlags??0};
    const row={...c,bodies:undefined,body_count:objects.size,collision_manifest:geo.collisionManifest??null,
      endpoints_client:{from,goal},arms:[]};
    const nativeTimes=[],nativeValid=[],nativeRuns=[];
    for(let i=0;i<rounds;i++){
      const started=performance.now();
      const p=await cutFineRailAsync(geo,c.from,c.goal,{objects,selfId:c.selfId,avoidSquares:new Set(c.avoidSquares??[]),minimumFloor:c.minimumFloor,
        roomFlags:c.roomFlags??0,maxMs:10000},{timeoutMs:12000});
      nativeTimes.push(performance.now()-started);
      const proof=p.ok&&p.bridgeOk&&!p.partial?assessPath(geo,p.waypoints,from,goal,options):{valid:false,reason:p.why??p.reason??'native_no_complete_route'};
      nativeValid.push(proof.valid);nativeRuns.push({found:!!(p.ok&&p.bridgeOk&&!p.partial),reason:p.why??p.reason,visited:p.visited,waypoints:p.waypoints?.length,proof});
    }
    row.arms.push({id:'existing-fine-worker',timing:timing(nativeTimes),valid_runs:nativeValid.filter(Boolean).length,runs:nativeRuns});
    currentFineQuery(geo,from,goal,options);
    const searchTimes=[];let current;
    for(let i=0;i<rounds;i++){const started=performance.now();current=currentFineQuery(geo,from,goal,options);searchTimes.push(performance.now()-started);}
    const checkStart=performance.now(),currentProof=current.found?assessPath(geo,current.waypoints,from,goal,options):{valid:false,reason:current.reason};
    row.arms.push({id:'existing-fine-search',timing:timing(searchTimes),validation_ms:performance.now()-checkStart,
      found:current.found,proof:currentProof,visited:current.visited,guide:current.guide,waypoints:current.waypoints?.length,reason:current.reason});
    if(Math.max(Math.abs(c.goal.x-c.from.x),Math.abs(c.goal.y-c.from.y))<=8*64){
      const localQuery=()=>planBodyDetour(geo,c.from,c.goal,{objects,selfId:c.selfId,avoidSquares:new Set(c.avoidSquares??[]),minimumFloor:c.minimumFloor,roomFlags:c.roomFlags??0});
      localQuery();const localTimes=[];let local;
      for(let i=0;i<rounds;i++){const started=performance.now();local=localQuery();localTimes.push(performance.now()-started);}
      const points=(local.waypoints??[]).map(p=>({x:protocolToClient(p.x),y:protocolToClient(p.y)}));
      const proofStart=performance.now(),proof=local.found?assessPath(geo,points,from,goal,options):{valid:false,reason:local.reason};
      row.arms.push({id:'existing-local-search',timing:timing(localTimes),validation_ms:performance.now()-proofStart,
        found:local.found,proof,nodes:local.nodes,waypoints:points.length,reason:local.reason});
    }
    const key=`${c.room}:${!!c.doorOpen}`;
    if(!portals.has(key)){
      const started=performance.now(),planner=buildPortalPlanner(geo);portals.set(key,planner);
      result.bakes.push({id:'bsp-portals',room:c.room,door_open:!!c.doorOpen,build_ms:performance.now()-started,...planner.stats});
    }
    for(const variant of [{id:'bsp-portals'},...variants]){
      let planner;
      if(variant.id==='bsp-portals')planner=portals.get(key);
      else{
        const bakeKey=`${key}:${variant.id}`;
        if(!bakes.has(bakeKey)){
          console.log(`  building ${variant.id}`);planner=buildRecastPlanner(geo,variant);bakes.set(bakeKey,planner);
          result.bakes.push({id:variant.id,room:c.room,door_open:!!c.doorOpen,...planner.stats});
        }else planner=bakes.get(bakeKey);
      }
      planner.query(from,goal,options);
      const times=[];let p;
      for(let i=0;i<(variant.id==='bsp-portals'?rounds:queryRounds);i++){const started=performance.now();p=planner.query(from,goal,options);times.push(performance.now()-started);}
      const proofStart=performance.now(),proof=p.found?assessPath(geo,p.waypoints,from,goal,options):{valid:false,reason:p.reason};
      row.arms.push({id:variant.id,timing:timing(times),validation_ms:performance.now()-proofStart,found:!!p.found,
        proof,waypoints:p.waypoints?.length,path:p.waypoints,reason:p.reason,endpoint_projection_squares:p.endpoint_projection_squares});
    }
    // Grid search is timed separately: it returns square aims, not a proved continuous path.
    const gridTimes=[];let grid;
    for(let i=0;i<queryRounds;i++){const started=performance.now();grid=geo.path(Math.floor(c.from.y/64),Math.floor(c.from.x/64),Math.floor(c.goal.y/64),Math.floor(c.goal.x/64));gridTimes.push(performance.now()-started);}
    row.grid_context={collision_mask:geo.hasStepMask,timing:timing(gridTimes),found:!!grid?.found,steps:grid?.steps?.length,note:'Square search only; excludes fine following, bodies and packet proof.'};
    result.cases.push(row);
    fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
    console.log(`  existing ${nativeRuns[0].proof.valid?'valid':nativeRuns[0].proof.reason}; `+row.arms.slice(1).map(a=>`${a.id} ${a.proof.valid?'valid':a.proof.reason}`).join('; '));
  }
  for(const p of bakes.values())p.destroy();
  console.log(`saved ${output}`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
