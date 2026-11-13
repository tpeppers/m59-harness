#!/usr/bin/env node
// Offline authoring CLI. npm/Recast is loaded only by this explicit bake command;
// runtime movement reads the resulting dependency-free artifact.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {loadMap} from './m59-map.mjs';
import {RoomGeometry,applySectorHeights} from './m59-roo.mjs';
import {packNavMesh,unpackNavMesh} from './m59-navmesh-codec.mjs';
import {addDeclaredNavMeshLinks} from './m59-navmesh-actions.mjs';
import {geometryIdentity} from './m59-navmesh.mjs';

export async function main(argv=process.argv.slice(2)){
 const value=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
 const roomsArg=value('--rooms',null);if(!roomsArg)throw Error('Use --rooms all or --rooms 535,579,750,2505');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const out=path.resolve(value('--out',path.join(root,'substrate/m59-navmesh.json.gz')));
 const mapFile=value('--map',null),map=loadMap(mapFile??undefined);
 const rooms=roomsArg==='all'?Object.keys(map.rooms).map(Number).filter(n=>map.rooms[n]?.roo):roomsArg.split(',').map(Number);
 if(rooms.some(n=>!Number.isInteger(n)||!map.rooms[n]?.roo))throw Error('Every requested room must have baked geometry');
 const cs=Number(value('--cs',1/16)),pitch=Number(value('--pitch',256)),refine=Number(value('--refine',64));
 if(!(cs>0)||![64,128,256,512].includes(pitch)||![16,32,64,128].includes(refine))throw Error('Invalid cs, pitch or refine');
 const states=value('--states','all');
 if(Number(value('--jobs',1))>1)console.log('Enhanced bake runs sequentially; no more than one authoring worker uses CPU.');
 try{os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
 let compiler;
 try{compiler=await import('../experiments/navmesh/enhanced-bake.mjs');}
 catch(error){if(error.code==='ERR_MODULE_NOT_FOUND')throw Error('Offline Recast authoring dependencies are missing; run npm install --prefix experiments/navmesh. '+error.message);throw error;}
 const ceilingTable=JSON.parse(fs.readFileSync(new URL('../substrate/m59-ceiling-doors.json',import.meta.url),'utf8'));
 const routeTable=JSON.parse(fs.readFileSync(new URL('../substrate/m59-routes.json',import.meta.url),'utf8'));
 let book={format:'m59-navmesh/1',version:1,rooms:{}};
 try{const bytes=fs.readFileSync(out),existing=JSON.parse((out.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8'));if(existing.format===book.format&&existing.version===1)book=existing;}catch(error){if(error.code!=='ENOENT')throw error;}
 const save=()=>{
  if(argv.includes('--check'))return;
  fs.mkdirSync(path.dirname(out),{recursive:true});const body=Buffer.from(JSON.stringify(book)),tmp=out+`.${process.pid}.tmp`;
  fs.writeFileSync(tmp,out.endsWith('.gz')?gzipSync(body,{level:6}):body);fs.renameSync(tmp,out);
 };
 for(const room of rooms){
  const definition=map.rooms[room],available=new Map([['shipped',null]]);
  for(const [name,state]of Object.entries(ceilingTable.rooms?.[room]?.states??{}))available.set(name,state);
  for(const [name,state]of Object.entries(routeTable.rooms?.[room]?.stepMaskVariants??{}))available.set(name,state);
  const selected=states==='all'?[...available.keys()]:states.split(';');
  if(selected.some(name=>!available.has(name)))throw Error(`Room ${room} has no state ${selected.filter(n=>!available.has(n)).join(';')}; available: ${[...available.keys()].join(';')}`);
  const compiled=[...(book.rooms[room]??[])],seenStates=new Set();
  for(const stateName of selected){
   const geo=RoomGeometry.fromJSON(definition.roo);geo.roomNum=room;
   const state=available.get(stateName);
   if(state){const moved=applySectorHeights(geo,state.sectors??[],state.mask?{mask:Buffer.from(state.mask,'base64')}:{});if(moved.why&&moved.why!=='already at that height')throw Error(`Room ${room} state ${stateName}: ${moved.why}`);}
   const stateIdentity=geometryIdentity(geo);if(seenStates.has(stateIdentity.stateFingerprint)){console.log(`Skipping duplicate room ${room} state ${stateName}`);continue;}seenStates.add(stateIdentity.stateFingerprint);
   console.log(`Baking room ${room} state ${stateName}`);
   let mesh;
   if(argv.includes('--actions-only')){
    const existing=compiled.find(m=>m.identity.stateFingerprint===stateIdentity.stateFingerprint&&m.identity.collisionDigest===stateIdentity.collisionDigest);
    if(!existing)throw Error(`No matching baked room ${room} state ${stateName} to enrich`);
    if(existing.file){
     const file=path.resolve(path.dirname(out),existing.file),within=path.resolve(path.dirname(out))+path.sep;
     if(!file.startsWith(within))throw Error('Mesh descriptor leaves the artifact directory');
     const raw=fs.readFileSync(file),data=JSON.parse((file.endsWith('.gz')?gunzipSync(raw):raw).toString('utf8'));
     mesh=data.format==='m59-navmesh-packed-room/1'?unpackNavMesh(data):data;
    }else mesh=existing;
    mesh.nodes=mesh.nodes.map(node=>({...node,edges:node.edges.filter(e=>e.kind!=='jump')}));
    compiler.normalizeStoredNavMeshWalks(geo,mesh);addDeclaredNavMeshLinks(geo,mesh);compiler.filterNavMeshBounds(mesh);
   }else mesh=await compiler.buildEnhancedRoom(geo,{room,roomDefinition:definition,cs,pitch,refine,ribbonPitch:Number(value('--ribbon-pitch',64)),gatewayStride:Number(value('--gateway-stride',512)),gatewayOffsets:argv.includes('--gateways')?[128,384]:[],
    onProgress:p=>console.log(`  ${p.phase}`)});
   mesh.provenance.stateName=stateName;
   const relativeFile=`navmesh/${room}-${mesh.identity.stateFingerprint}.json.gz`;
   const shard=path.join(path.dirname(out),relativeFile);
   if(!argv.includes('--check')){
    fs.mkdirSync(path.dirname(shard),{recursive:true});const tmp=shard+`.${process.pid}.tmp`;
    fs.writeFileSync(tmp,gzipSync(Buffer.from(JSON.stringify(packNavMesh(mesh))),{level:6}));fs.renameSync(tmp,shard);
   }
   const descriptor={version:1,identity:mesh.identity,file:relativeFile};
   const previous=compiled.findIndex(m=>m.identity.stateFingerprint===mesh.identity.stateFingerprint);
   if(previous>=0)compiled[previous]=descriptor;else compiled.push(descriptor);
   console.log(`  ${mesh.nodes.length} nodes, ${mesh.provenance.edges} edges, ${Math.round(mesh.provenance.buildMs)} ms`);
  }
  book.rooms[room]=compiled;book.updatedAt=new Date().toISOString();book.geometryManifestSha256=map.geometryManifestSha256;save();
 }
 console.log(argv.includes('--check')?'Check complete; no artifact written':`Saved ${out}`);
 return book;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.stack??error.message);process.exitCode=1;});
