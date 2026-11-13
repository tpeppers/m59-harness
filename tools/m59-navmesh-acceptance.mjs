#!/usr/bin/env node
// Offline objective acceptance only. --list is cheap; --run explicitly compiles
// selected frozen geometry states. No broker, roster or game socket is imported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { RoomGeometry, protocolToClient } from './m59-roo.mjs';
import { blockingBodySnapshot } from './m59-body-detour.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
import { navMeshNodeObjectives, navMeshObjectiveCases, iceAcceptanceGeometry,
  objectiveGoalOptions, objectiveEndpointMatches } from './m59-navmesh-objectives.mjs';

const asPoint = (geo, p) => p.kind === 'point' ? { x: p.x, y: p.y } : geo.standPoint(p.row, p.col);
const avoidKeys = values => values.map(p => typeof p === 'string' ? p : `${p.row},${p.col}`);
const gap = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

/** Replay the returned exact proof points; resampling would change ledge phase. */
export function auditNavMeshObjectivePath(geo, result, from, goal, options = {}) {
  const legs = result.legs?.length ? result.legs : [{ kind: 'walk', waypoints: result.waypoints }];
  let at = { ...from }, checks = 0, jumps = 0;
  const avoided = new Set(options.avoidSquares ?? []);
  for (const leg of legs) {
    const legFrom = leg.from ?? leg.fromFine ?? leg.waypoints?.[0] ?? at;
    if (gap(at,legFrom) > 0.05) return { valid: false, reason: 'disconnected_leg_origin', checks };
    if (leg.kind === 'jump' || leg.kind === 'fall') {
      const to = leg.to ?? leg.toFine ?? leg.waypoints?.at(-1);
      if (!to || ![to.x,to.y].every(Number.isFinite)) return { valid:false, reason:'missing_typed_fall_endpoint',checks };
      const trace = geo.traceFineMoveClient(at.x,at.y,to.x,to.y,{slide:true,fall:true,timedFall:true,
        obstacles:options.obstacles??[],roomFlags:options.roomFlags??0}); checks++; jumps++;
      if (!trace?.arrived || trace.available === false || gap(trace,to)>0.05) return {valid:false,reason:trace?.reason??'native_fall_refused',checks};
      at = { ...to }; continue;
    }
    if (leg.kind && leg.kind !== 'walk') return {valid:false,reason:'unknown_movement_leg_'+leg.kind,checks};
    const points = leg.waypoints ?? [legFrom,leg.to];
    for (const p of points) {
      if (![p?.x,p?.y].every(Number.isFinite)) return {valid:false,reason:'invalid_proof_point',checks};
      if (gap(at,p) < 0.01) continue;
      const row=Math.floor(p.y/1024)+1,col=Math.floor(p.x/1024)+1;
      if(avoided.has(`${row},${col}`))return {valid:false,reason:'mandatory_avoidance',checks};
      const leaf=geo.leafAtClient(p.x,p.y),floor=leaf?.sector?geo.floorBaseAtClient(p.x,p.y,leaf,options):null;
      if(Number.isFinite(options.minimumFloor)&&(floor==null||floor<options.minimumFloor))return {valid:false,reason:'minimum_floor',checks};
      const trace=geo.traceFineMoveClient(at.x,at.y,p.x,p.y,{slide:false,obstacles:options.obstacles??[],roomFlags:options.roomFlags??0});checks++;
      if(!trace?.arrived||trace.blocked===true||trace.available===false||gap(trace,p)>0.05)return {valid:false,reason:trace?.reason??'native_walk_refused',checks};
      at={...p};
    }
  }
  return {valid:objectiveEndpointMatches(goal,at),reason:objectiveEndpointMatches(goal,at)?null:'wrong_objective_endpoint',checks,jumps,endpoint:at};
}

export async function runNavMeshObjectiveCase(map, c, { buildEnhancedRoom, attachNavMesh, planNavMesh, geometryIdentity, navMeshFor, artifactFile = null,
  cache = new Map(), maxMs = 2000, maxNodes = 200000, compilerOptions = {}, onProgress = () => {} } = {}) {
  let geo, state = null;
  if (c.room === 750 && c.state) {
    const ice=iceAcceptanceGeometry(map,{previewYeti:c.state==='preview-first-only',manaOpen:c.state==='mana-open'});
    geo=ice.geometry;state=ice.state;
  } else {
    geo=RoomGeometry.fromJSON(map.rooms[c.room].roo);geo.roomNum=c.room;
    if(c.doorOpen)applyCeilingDoors(map,c.room,new Map([[1,{type:5,height:1150}]]),null,{geometryOf:()=>geo});
  }
  const from=asPoint(geo,c.from), resolved=objectiveGoalOptions(geo,c.goal,from);
  if(!from||!resolved)return {id:c.id,expectation:c.expectation,status:'unresolved',reason:'objective_footing_unavailable'};
  const options={...resolved.options,maxMs,maxNodes,allowedKinds:c.allowedKinds??['walk'],maxJumps:c.maxJumps??0,minimumFloor:c.minimumFloor,avoidSquares:new Set(avoidKeys(c.avoidSquares??[])),roomFlags:c.roomFlags??0};
  const objects=new Map((c.bodies??[]).map(o=>[o.id,o]));options.obstacles=blockingBodySnapshot(objects,c.selfId);
  const identity=geometryIdentity(geo,options),key=JSON.stringify(identity);
  let mesh,buildMs=0;
  if(artifactFile){
    const loaded=navMeshFor(geo,{...options,file:artifactFile});
    if(!loaded.mesh)return {id:c.id,node:c.node,room:c.room,expectation:c.expectation,status:'artifact_unavailable',
      reason:loaded.reason,available:false,identity,state,source:c.source};
    mesh=loaded.mesh;options.mesh=mesh;
  }else{
    mesh=cache.get(key);
    if(!mesh){const start=performance.now();mesh=await buildEnhancedRoom(geo,{room:c.room,roomDefinition:map.rooms[c.room],...compilerOptions,onProgress});
      if(!mesh.provenance?.declaredActions){const {addDeclaredNavMeshLinks}=await import('./m59-navmesh-actions.mjs');addDeclaredNavMeshLinks(geo,mesh);}
      buildMs=performance.now()-start;cache.set(key,mesh);}
    attachNavMesh(geo,mesh,options);
  }
  const start=performance.now(),result=await planNavMesh(geo,from,resolved.target,options),queryMs=performance.now()-start;
  const proof=result.found&&result.complete?auditNavMeshObjectivePath(geo,result,from,c.goal,options):{valid:false,reason:result.reason};
  let status;
  if(result.found&&result.complete&&!proof.valid)status='invalid_candidate';
  else if(proof.valid)status=c.expectation==='blocked'?'unexpected_route':c.expectation==='unresolved'?'resolved_offline':'passed';
  else if(c.expectation==='blocked'&&result.available&& !/budget|deadline|unavailable|mismatch|cancel/i.test(result.reason??''))status='blocked_control_passed';
  else status=c.expectation==='unresolved'?'unresolved':'not_proved';
  return {id:c.id,node:c.node,room:c.room,expectation:c.expectation,status,conditional:!!c.conditional,state,
    from,goal:c.goal,source:c.source,startProvenance:c.startProvenance,identity,buildMs,queryMs,
    available:result.available,found:result.found,complete:result.complete,reason:result.reason,visited:result.visited,
    proof,waypoints:result.waypoints,legs:result.legs};
}

export async function comparisonObjectiveCases(map) {
  const {benchmarkCases}=await import('../experiments/navmesh/cases.mjs');
  return benchmarkCases(map).map(c=>({...c,id:'comparison-'+c.id,from:{kind:'point',x:protocolToClient(c.from.x),y:protocolToClient(c.from.y),units:'client'},
    goal:{kind:'point',x:protocolToClient(c.goal.x),y:protocolToClient(c.goal.y),units:'client'},
    expectation:c.kind==='recorded-occupied-goal'||c.id==='konima-2505-closed-gate'?'blocked':c.id==='ancient-579-ledge-walk'?'unresolved':'route'}));
}

// Windows scanners/readers can briefly lock a report target. Preserve the last
// complete file and publish via same-directory rename; use a unique recovery
// path if the requested target remains locked, without dropping the run.
export async function writeAcceptanceReport(file, report) {
  const temporary=file+'.'+process.pid+'.'+Date.now()+'.tmp',body=JSON.stringify(report,null,2)+'\n';
  let written=false,last;
  for(let attempt=0;attempt<8&&!written;attempt++)try{fs.writeFileSync(temporary,body);written=true;}catch(error){last=error;await new Promise(r=>setTimeout(r,50*(attempt+1)));}
  if(!written)throw last;
  for(let attempt=0;attempt<8;attempt++)try{fs.renameSync(temporary,file);return file;}catch(error){last=error;await new Promise(r=>setTimeout(r,50*(attempt+1)));}
  const recovered=file.replace(/\.json$/,'')+'.recovered-'+process.pid+'-'+Date.now()+'.json';
  try{fs.renameSync(temporary,recovered);return recovered;}catch(error){error.message+='; complete report retained at '+temporary;throw error;}
}

async function main() {
  const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
  const mapFile=path.resolve(value('--map',fileURLToPath(new URL('../substrate/m59-map.json',import.meta.url))));
  const bytes=fs.readFileSync(mapFile),map=JSON.parse(bytes);
  let cases=navMeshObjectiveCases();if(args.includes('--comparison'))cases.push(...await comparisonObjectiveCases(map));
  if(value('--case',null))cases=cases.filter(c=>c.id.includes(value('--case',null)));
  if(value('--room',null))cases=cases.filter(c=>c.room===Number(value('--room',null)));
  const artifactFile=value('--artifact',null)?path.resolve(value('--artifact',null)):null;
  if(!args.includes('--run')&&!artifactFile){console.log(JSON.stringify({scope:'offline catalog; no routes compiled',nodes:navMeshNodeObjectives(),cases},null,2));return;}
  if(!args.includes('--all')&&!value('--case',null)&&!value('--room',null))throw Error('Select --case/--room or explicit --all for offline compilation');
  const runtime=await import('./m59-navmesh.mjs');
  const buildEnhancedRoom=artifactFile?null:(await import('../experiments/navmesh/enhanced-bake.mjs')).buildEnhancedRoom;
  let output=path.resolve(value('--out',fileURLToPath(new URL('../experiments/navmesh/objective-results.json',import.meta.url))));
  const report={format:'m59-navmesh-objective-acceptance/1',createdAt:new Date().toISOString(),mapFile,mapSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    mode:artifactFile?'artifact-only':'compile-and-query',artifactFile,
    scope:'Offline static geometry and conditional state acceptance. No movement execution, node activation, acquisition, combat or survival claim.',
    catalog:navMeshNodeObjectives(),cases:[]};
  report.sourceHashes=Object.fromEntries(['tools/m59-navmesh.mjs','tools/m59-navmesh-codec.mjs',
    'tools/m59-navmesh-objectives.mjs','tools/m59-navmesh-acceptance.mjs','tools/m59-jump-precondition.mjs',
    'tools/m59-falljump.mjs','tools/m59-roo.mjs','substrate/m59-falljumps.json'].map(file=>
    [file,crypto.createHash('sha256').update(fs.readFileSync(new URL('../'+file,import.meta.url))).digest('hex')]));
  const cache=new Map(),compilerOptions={cs:Number(value('--cs',1/16)),pitch:Number(value('--pitch',256)),refine:Number(value('--refine',64))};
  for(const c of cases){console.log('Checking '+c.id);const result=await runNavMeshObjectiveCase(map,c,{buildEnhancedRoom,...runtime,cache,artifactFile,
    maxMs:Number(value('--max-ms',2000)),maxNodes:Number(value('--max-nodes',200000)),compilerOptions,onProgress:p=>console.log('  '+JSON.stringify(p))});
    report.cases.push(result);output=await writeAcceptanceReport(output,report);console.log('  '+result.status+': '+(result.reason??'proved'));}
  console.log('Saved '+output);
  if(report.cases.some(c=>['invalid_candidate','unexpected_route','not_proved','artifact_unavailable'].includes(c.status)))process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
