import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {RoomGeometry,applySectorHeights} from './m59-roo.mjs';
import {roomGeometry} from './m59-ground.mjs';
import {ANCIENT_SECTOR_IDS,ANCIENT_HEIGHTS,ancientGeometryHash} from './m59-moving-platform-masks.mjs';
if(isMainThread){
 const geo=roomGeometry(579),size=geo.rows*geo.cols,data=geo.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]});
 console.log('baking all256 observed binary floor states off the game event loop');
 const chunks=await Promise.all(Array.from({length:8},(_,part)=>new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{data,part}});worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('bake worker exit '+code));});
 })));
 const masks=Buffer.alloc(size*256);for(const chunk of chunks)for(const [index,mask]of chunk)masks.set(mask,index*size);
 const book={format:'m59-brax-floor-masks/1',geometryHash:ancientGeometryHash(geo),rows:geo.rows,cols:geo.cols,sectorIds:ANCIENT_SECTOR_IDS,heights:ANCIENT_HEIGHTS,deflatedBase64:deflateSync(masks,{level:9}).toString('base64')};
 writeFileSync(new URL('./data/brax-floor-masks.json',import.meta.url),JSON.stringify(book)+'\n');console.log('baked256 masks, compressed bytes '+book.deflatedBase64.length);
}else{
 const geo=RoomGeometry.fromJSON(workerData.data),size=geo.rows*geo.cols,out=[];
 for(let index=workerData.part;index<256;index+=8){
  const overrides=geo.sectors.flatMap((s,sector)=>{const n=ANCIENT_SECTOR_IDS.indexOf(s.serverId);return n<0?[]:[{index:sector,floor:ANCIENT_HEIGHTS[n][(index>>n)&1]*16}];});
  const changed=applySectorHeights(geo,overrides,{mask:new Uint8Array(size)});if(changed.why)throw Error(changed.why);
  out.push([index,geo.buildStepMask()]);
 }
 parentPort.postMessage(out);
}
