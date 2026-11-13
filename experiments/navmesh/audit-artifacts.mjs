// Audit the final offline artifact inventory and (with --native) every stored
// ordinary walk segment. No broker, roster, socket, movement or node activation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {RoomGeometry,applySectorHeights} from '../../tools/m59-roo.mjs';
import {geometryIdentity,proveNavMeshJump} from '../../tools/m59-navmesh.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),args=process.argv.slice(2);
const value=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
const index=path.resolve(value('--artifact',path.join(root,'substrate/m59-navmesh.json.gz')));
const out=path.resolve(value('--out',path.join(root,'experiments/navmesh/artifact-audit.json')));
const nativeAll=args.includes('--native'),nativeActions=args.includes('--native-actions'),native=nativeAll||nativeActions,hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>{const bytes=fs.readFileSync(file);return {bytes,data:JSON.parse((file.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'))};};
const relative=file=>path.relative(root,file).replaceAll('\\','/');
const inventory=file=>{const bytes=fs.readFileSync(file);return {file:relative(file),bytes:bytes.length,sha256:hash(bytes)};};
const mapFile=path.join(root,'substrate/m59-map.json'),map=read(mapFile).data;
const ceiling=read(path.join(root,'substrate/m59-ceiling-doors.json')).data;
const routes=read(path.join(root,'substrate/m59-routes.json')).data;
const loaded=read(index),book=loaded.data;
if(book.format!=='m59-navmesh/1'||book.version!==1)throw Error('Unsupported index');
try{os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
const report={format:'m59-navmesh-artifact-audit/1',createdAt:new Date().toISOString(),native,nativeMode:nativeAll?'all-stored-walks':nativeActions?'declared-actions-and-incident-walks':'structural-only',
 scope:'Offline static artifact and stored-walk validation only. No execution, activation, combat, acquisition or survival evidence.',
 index:inventory(index),artifacts:[],sources:[],inputs:[],failures:[],totals:{rooms:Object.keys(book.rooms).length,states:0,nodes:0,edges:0,walks:0,jumps:0,storedPoints:0,diskBytes:loaded.bytes.length,nativeSegments:0,cachedSegments:0,maxStride:0,segmentsOver128:0}};
const fail=(entry,reason,detail)=>{entry.errors??=[];if(entry.errors.length<10)entry.errors.push({reason,...detail});report.failures.push({file:entry.file,reason,...detail});};
const same=(a,b)=>['security','rows','cols','predicateVersion','collisionDigest','stateFingerprint'].every(k=>a[k]===b[k]);
const sourceSet=new Set();
for(const folder of ['tools','experiments/navmesh'])for(const name of fs.readdirSync(path.join(root,folder))){
 if(!name.endsWith('.mjs'))continue;const file=path.join(root,folder,name),body=fs.readFileSync(file,'utf8');
 if(folder==='experiments/navmesh'||name.startsWith('m59-navmesh')||body.includes('m59-navmesh'))sourceSet.add(file);
}
const queue=[...sourceSet];
for(let i=0;i<queue.length;i++){
 const file=queue[i],body=fs.readFileSync(file,'utf8');
 for(const match of body.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+\.mjs)['"]/g)){
  const dependency=path.resolve(path.dirname(file),match[1]);if(!dependency.startsWith(root)||!fs.existsSync(dependency)||sourceSet.has(dependency))continue;
  sourceSet.add(dependency);queue.push(dependency);
 }
}
const physicsSourceBefore=inventory(path.join(root,'tools/m59-roo.mjs'));
const baselineFile=value('--baseline',null);if(baselineFile){const baseline=read(path.resolve(baselineFile)).data;if(baseline.failures?.length||baseline.physicsSource?.sha256!==physicsSourceBefore.sha256)throw Error('Baseline native audit is invalid or uses different collision source');report.baselineAudit=inventory(path.resolve(baselineFile));}
for(const [room,descriptors]of Object.entries(book.rooms))for(const descriptor of descriptors){
 const file=path.resolve(path.dirname(index),descriptor.file);
 if(!file.startsWith(path.dirname(index)+path.sep))throw Error('Shard escapes index directory');
 const {bytes,data:p}=read(file),entry={...inventory(file),room:Number(room),state:p.provenance?.stateName,identity:p.identity,recastFailure:p.provenance?.recastFailure??null};
 if(!same(descriptor.identity,p.identity))fail(entry,'descriptor_identity_mismatch');
 const geo=RoomGeometry.fromJSON(map.rooms[room].roo);geo.roomNum=Number(room);
 if(entry.state&&entry.state!=='shipped'){
  const state=ceiling.rooms?.[room]?.states?.[entry.state]??routes.rooms?.[room]?.stepMaskVariants?.[entry.state];
  if(!state)throw Error(`Unknown room ${room} state ${entry.state}`);
  applySectorHeights(geo,state.sectors??[],state.mask?{mask:Buffer.from(state.mask,'base64')}:{});
 }
 const physical={roomFlags:p.provenance?.source?.roomFlags??0,overrideDepths:p.provenance?.source?.overrideDepths??null};
 if(!same(geometryIdentity(geo,physical),p.identity))fail(entry,'current_geometry_identity_mismatch');
 if(!p.provenance?.canonicalBounds||!p.provenance?.declaredActions)fail(entry,'unfinished_compiler_artifact');
 const buffer=(group,name)=>Buffer.from(p[group][name],'base64');
 const nx=buffer('nodes','x'),ny=buffer('nodes','y'),offset=buffer('edges','offsets'),targets=buffer('edges','to'),pointOffset=buffer('edges','pointOffsets');
 const px=buffer('points','x'),py=buffer('points','y'),kinds=p.edges.kind?buffer('edges','kind'):Buffer.alloc(targets.length/4);
 const nodes=nx.length/4,edges=targets.length/4,pointCount=px.length/4,width=p.identity.cols*1024,height=p.identity.rows*1024;
 const inside=(x,y)=>x>=0&&y>=0&&x<width&&y<height;
 let invalidNodes=0,invalidPoints=0,endpointErrors=0,walks=0,jumps=0,nativeSegments=0,cachedSegments=0,maxStride=0,segmentsOver128=0;
 for(let i=0;i<nodes;i++){const x=nx.readInt32LE(i*4),y=ny.readInt32LE(i*4);if(!inside(x,y)||x%16||y%16)invalidNodes++;}
 for(let i=0;i<pointCount;i++){const x=px.readInt32LE(i*4),y=py.readInt32LE(i*4);if(!inside(x,y)||x%16||y%16)invalidPoints++;}
 const cache=new Map();let firstNativeFailure=null;
 const actionNodes=new Set();for(let n=0;n<nodes;n++)for(let e=offset.readUInt32LE(n*4);e<offset.readUInt32LE((n+1)*4);e++)if(kinds[e]===1){actionNodes.add(n);actionNodes.add(targets.readUInt32LE(e*4));}
 for(let node=0;node<nodes;node++){
  for(let e=offset.readUInt32LE(node*4);e<offset.readUInt32LE((node+1)*4);e++){
   const target=targets.readUInt32LE(e*4),start=pointOffset.readUInt32LE(e*4),end=pointOffset.readUInt32LE((e+1)*4);
   if(kinds[e]===1){jumps++;if(p.edges.actions?.[e]?.declared!==true)fail(entry,'undeclared_jump',{edge:e});else if(native){const a={x:nx.readInt32LE(node*4),y:ny.readInt32LE(node*4)},b={x:nx.readInt32LE(target*4),y:ny.readInt32LE(target*4)},proof=proveNavMeshJump(geo,a,b,p.edges.actions[e],physical);if(!proof.ok)fail(entry,'native_declared_jump_refused',{edge:e,detail:proof.reason});}continue;}
   walks++;
   if(end<=start||px.readInt32LE(start*4)!==nx.readInt32LE(node*4)||py.readInt32LE(start*4)!==ny.readInt32LE(node*4)||px.readInt32LE((end-1)*4)!==nx.readInt32LE(target*4)||py.readInt32LE((end-1)*4)!==ny.readInt32LE(target*4))endpointErrors++;
   for(let j=start+1;j<end;j++){
    const a={x:px.readInt32LE((j-1)*4),y:py.readInt32LE((j-1)*4)},b={x:px.readInt32LE(j*4),y:py.readInt32LE(j*4)},stride=Math.hypot(b.x-a.x,b.y-a.y);
    maxStride=Math.max(maxStride,stride);if(stride>128+.001)segmentsOver128++;
    if(!native||nativeActions&&!actionNodes.has(node)&&!actionNodes.has(target))continue;
    const key=`${a.x}:${a.y}>${b.x}:${b.y}`;let valid=cache.get(key);
    if(valid===undefined){const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false,...physical});valid=t?.arrived===true&&t.blocked!==true&&Math.hypot((t.x??Infinity)-b.x,(t.y??Infinity)-b.y)<.05;cache.set(key,valid);nativeSegments++;}
    else cachedSegments++;
    if(!valid&&!firstNativeFailure)firstNativeFailure={node,edge:e,from:a,to:b};
   }
  }
 }
 if(invalidNodes)fail(entry,'out_of_bounds_or_nonwire_nodes',{count:invalidNodes});
 if(invalidPoints)fail(entry,'out_of_bounds_or_nonwire_points',{count:invalidPoints});
 if(endpointErrors)fail(entry,'edge_endpoint_mismatch',{count:endpointErrors});
 if(firstNativeFailure)fail(entry,'native_walk_refused',firstNativeFailure);
 Object.assign(entry,{nodes,edges,walks,jumps,storedPoints:pointCount,maxStride,segmentsOver128,nativeSegments,cachedSegments});
 report.artifacts.push(entry);report.totals.states++;report.totals.diskBytes+=bytes.length;
 for(const key of ['nodes','edges','walks','jumps','storedPoints','nativeSegments','cachedSegments','segmentsOver128'])report.totals[key]+=entry[key];
 report.totals.maxStride=Math.max(report.totals.maxStride,maxStride);
 console.log(JSON.stringify({room:Number(room),state:entry.state,nodes,edges,nativeSegments,errors:entry.errors?.length??0,segmentsOver128}));
}
report.sources=[...sourceSet].sort().map(inventory);
for(const name of ['m59-map.json','m59-routes.json','m59-ceiling-doors.json','m59-falljumps.json','m59-standpoints.json','m59-void-sectors.json','m59-fine-guides.json']){
 const file=path.join(root,'substrate',name);if(fs.existsSync(file))report.inputs.push(inventory(file));
}
report.inputs.push(inventory(path.join(root,'experiments/navmesh/package.json')),inventory(path.join(root,'experiments/navmesh/package-lock.json')));
for(const name of ['@recast-navigation/generators/dist/index.mjs','@recast-navigation/core/dist/index.mjs','@recast-navigation/wasm/dist/recast-navigation.wasm-compat.js','@recast-navigation/wasm/dist/recast-navigation.wasm.wasm']){
 const file=path.join(root,'experiments/navmesh/node_modules',name);if(fs.existsSync(file))report.inputs.push(inventory(file));
}
report.evidence=[];
for(const name of fs.readdirSync(path.join(root,'experiments/navmesh'))){
 if(['enhanced-native-results.json','shipped-acceptance.json'].includes(name)||/^worker-memory-\d+\.json$/.test(name))report.evidence.push(inventory(path.join(root,'experiments/navmesh',name)));
}
report.physicsSource=physicsSourceBefore;
if(inventory(path.join(root,'tools/m59-roo.mjs')).sha256!==physicsSourceBefore.sha256)report.failures.push({reason:'physics_source_changed_during_audit'});
report.memory=process.memoryUsage();report.maxRssKiB=process.resourceUsage().maxRSS;
fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,failures:report.failures.length,totals:report.totals,maxRssKiB:report.maxRssKiB}));
if(report.failures.length)process.exitCode=1;
