import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export const ANCIENT_SECTOR_IDS=[2,3,4,5,6,7,8,9];
export const ANCIENT_HEIGHTS=[[250,800],[250,800],[510,540],[200,340],[200,340],[200,340],[200,340],[510,540]];
export function ancientGeometryHash(geo,base=null){
 const data=geo.toJSON({includeSurfaces:false,graphEntrySquares:[],edgeDirections:[]});
 return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
let book,bytes;
const checked=new WeakMap();
export function ancientBakedMask(geo,overrides,base){
 if(book===undefined){try{book=JSON.parse(readFileSync(new URL('./data/brax-floor-masks.json',import.meta.url),'utf8'));bytes=inflateSync(Buffer.from(book.deflatedBase64,'base64'));}catch{book=null;}}
 if(!book||book.format!=='m59-brax-floor-masks/1'||JSON.stringify(book.sectorIds)!==JSON.stringify(ANCIENT_SECTOR_IDS)||JSON.stringify(book.heights)!==JSON.stringify(ANCIENT_HEIGHTS)||book.rows!==geo.rows||book.cols!==geo.cols||bytes.length!==256*geo.rows*geo.cols)return null;
 if(!checked.has(geo))checked.set(geo,ancientGeometryHash(geo,base)===book.geometryHash);
 if(!checked.get(geo))return null;
 const seen=new Map(overrides.map(o=>[geo.sectors[o.index].serverId,o.floor]));let index=0;
 for(let i=0;i<ANCIENT_SECTOR_IDS.length;i++){
  const height=seen.get(ANCIENT_SECTOR_IDS[i])/16,bit=ANCIENT_HEIGHTS[i].indexOf(height);
  if(bit<0)return null;index|=bit<<i;
 }
 const size=geo.rows*geo.cols;return Uint8Array.from(bytes.subarray(index*size,(index+1)*size));
}
