#!/usr/bin/env node
// Disk-backed beliefs about KOD piNodelist, scoped by game server and character.
// read --server host:port --character name; set --mask 0x1f --reason ...;
// forget --mask 0x1f --reason ... removes certainty, not server mana or node bits.
import {mkdir,readFile,writeFile,open,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {STONES} from './m59-stones.mjs';
// kod/include/blakston.khd, Nodes enum. Never derive these from itinerary order.
export const NODE_BITS=Object.freeze({NODE_H9:1,NODE_G9:2,NODE_VICTORIA:4,NODE_BADLANDS:8,
  NODE_ORCCAVES:16,NODE_A5:32,NODE_ICECAVE1:64,NODE_CORPSENODE:128,NODE_I9:256,
  NODE_FAERIE:512,NODE_GUEST:1024,NODE_Q:2048,NODE_AVAR:4096});
export const ALL_NODE_BITS=8191;
export const nodeBit=node=>NODE_BITS[STONES[node]?.node??node]??0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const defaultDir=()=>process.env.M59_NODE_MEMORY_DIR??fileURLToPath(new URL('../substrate/node-memory/',import.meta.url));
function identity({server,character}){
  if(typeof server!=='string'||!server.trim()||typeof character!=='string'||!character.trim())throw Error('node memory requires server and character');
  return {server:server.trim().toLowerCase(),character:character.trim().toLowerCase()};
}
function mask(n){if(!Number.isInteger(n)||n<0||n>ALL_NODE_BITS)throw Error('invalid KOD node mask');return n;}
export function memoryPath(who,dir=defaultDir()){
  const key=createHash('sha256').update(JSON.stringify(identity(who))).digest('hex');return join(dir,key+'.json');
}
export async function readNodeMemory(who,{dir=defaultDir()}={}){
  const id=identity(who);let r;
  try{r=JSON.parse(await readFile(memoryPath(who,dir),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
    return {format:'m59-node-memory/1',...id,mask:0,known_mask:0,observations:{},revision:0,history:[]};}
  if(r.format!=='m59-node-memory/1'||r.server!==id.server||r.character!==id.character||!Number.isInteger(r.revision)||!r.observations||!Array.isArray(r.history))throw Error('invalid node memory');
  mask(r.mask);mask(r.known_mask);if((r.mask&r.known_mask)!==r.mask)throw Error('node belief outside known mask');return r;
}
export async function updateNodeMemory(who,event,{dir=defaultDir()}={}){
  const file=memoryPath(who,dir);await mkdir(dirname(file),{recursive:true});
  let lock;const until=Date.now()+5000;
  while(!lock){try{lock=await open(file+'.lock','wx');}catch(e){if(e.code!=='EEXIST'||Date.now()>=until)throw e;await sleep(25);}}
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{
    const r=await readNodeMemory(who,{dir}),at=event.at??new Date().toISOString();
    if(!Number.isFinite(Date.parse(at))||!event.evidence)throw Error('node observation needs timestamp and evidence');
    if(event.kind==='observe'){
      const bit=nodeBit(event.node);if(!bit)throw Error('unknown KOD node');
      if(!['melded','already','lost'].includes(event.status))throw Error('unconfirmed node outcome');
      if((Date.parse(r.observations[bit]?.at) || 0)>Date.parse(at))return r;
      r.known_mask|=bit;r.mask=event.status==='lost'?r.mask&~bit:r.mask|bit;
      r.observations[bit]={at,status:event.status,evidence:event.evidence};
    }else if(event.kind==='set'){
      r.mask=mask(event.mask);r.known_mask=ALL_NODE_BITS;
      for(const bit of Object.values(NODE_BITS))r.observations[bit]={at,status:r.mask&bit?'present':'lost',evidence:event.evidence};
    }else if(event.kind==='forget'){
      const bits=mask(event.mask);r.mask&=~bits;r.known_mask&=~bits;
      for(const bit of Object.values(NODE_BITS))if(bits&bit)r.observations[bit]={at,status:'unknown',evidence:event.evidence};
    }else throw Error('unknown node memory operation');
    r.revision++;r.updated_at=at;r.history.push({...event,at});
    await writeFile(tmp,JSON.stringify(r,null,2)+'\n');
    for(let i=0;;i++){try{await rename(tmp,file);break;}catch(e){if(i>=20||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;await sleep(50);}}
    return r;
  }finally{try{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}finally{await lock.close();await unlink(file+'.lock');}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [action,...args]=process.argv.slice(2),a={};for(let i=0;i<args.length;i+=2)a[args[i].replace(/^--/,'')]=args[i+1];
  const who={server:a.server,character:a.character},opts=a.dir?{dir:a.dir}:{};
  if(action==='read')console.log(JSON.stringify(await readNodeMemory(who,opts),null,2));
  else if(['set','forget'].includes(action)&&a.reason)console.log(JSON.stringify(await updateNodeMemory(who,{kind:action,mask:Number(a.mask),evidence:a.reason},opts),null,2));
  else throw Error('Usage: read|set|forget --server host:port --character name [--mask 0x1f --reason evidence] [--dir path]');
}
