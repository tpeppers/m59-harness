import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NODE_BITS,ALL_NODE_BITS,nodeBit,readNodeMemory,updateNodeMemory,memoryPath} from './m59-node-memory.mjs';
import {nodeEnum} from './m59-stones.mjs';
const dir=await mkdtemp(join(tmpdir(),'m59-node-memory-')),opts={dir},who={server:'test:5959',character:'Example'};
let count=0;async function test(name,fn){await fn();console.log('ok '+name);count++;}
try{
await test('bits exactly match KOD authority',()=>assert.deepEqual(NODE_BITS,Object.fromEntries(nodeEnum().map(n=>[n.node,n.bit]))));
await test('new identity is unknown, not known absent',async()=>{const r=await readNodeMemory(who,opts);assert.equal(r.known_mask,0);assert.equal(r.mask,0);});
await test('concurrent first meld and already bonded persist across reads',async()=>{
 await Promise.all(['victoria','sentinel','ancient','badlands','cave'].map(node=>updateNodeMemory(who,{kind:'observe',node,status:node==='victoria'?'melded':'already',evidence:'receipt'},opts)));
 const r=await readNodeMemory(who,opts);assert.equal(r.mask,31);assert.equal(r.known_mask,31);assert.equal(r.revision,5);
});
await test('same character on another server has independent memory',async()=>assert.equal((await readNodeMemory({...who,server:'shadow:15959'},opts)).mask,0));
await test('masks cannot wrap through 32-bit arithmetic',async()=>assert.rejects(updateNodeMemory(who,{kind:'set',mask:4294967296,evidence:'invalid'},opts),/invalid KOD/));
await test('identity casing is stable',async()=>assert.equal((await readNodeMemory({server:'TEST:5959',character:'example'},opts)).mask,31));
await test('dead node and silence never create or clear a bit',async()=>{for(const status of ['dead_node','unknown','out_of_range'])await assert.rejects(updateNodeMemory(who,{kind:'observe',node:'peak',status,evidence:'receipt'},opts),/unconfirmed/);assert.equal((await readNodeMemory(who,opts)).mask,31);});
await test('explicit loss clears a bit and a later grant restores it',async()=>{await updateNodeMemory(who,{kind:'observe',node:'ancient',status:'lost',evidence:'operator correction'},opts);assert.equal((await readNodeMemory(who,opts)).mask,29);await updateNodeMemory(who,{kind:'observe',node:'ancient',status:'melded',evidence:'new receipt'},opts);assert.equal((await readNodeMemory(who,opts)).mask,31);});
await test('forget invalidates certainty without asserting server loss',async()=>{const r=await updateNodeMemory(who,{kind:'forget',mask:nodeBit('cave'),evidence:'external reset suspected'},opts);assert.equal(r.mask,15);assert.equal(r.known_mask,15);});
await test('authoritative replacement can add and remove outside tour',async()=>{const r=await updateNodeMemory(who,{kind:'set',mask:128,evidence:'operator observed full KOD mask'},opts);assert.equal(r.mask,128);assert.equal(r.known_mask,ALL_NODE_BITS);});
await test('older receipt cannot undo newer loss',async()=>{await updateNodeMemory(who,{kind:'observe',node:'victoria',status:'lost',at:'2030-01-01T00:00:00Z',evidence:'new'},opts);const r=await updateNodeMemory(who,{kind:'observe',node:'victoria',status:'already',at:'2020-01-01T00:00:00Z',evidence:'old'},opts);assert.equal(r.mask&4,0);});
await test('corrupt disk record fails visibly',async()=>{await writeFile(memoryPath(who,dir),'broken');await assert.rejects(readNodeMemory(who,opts));});
console.log(count+' node memory checks passed');
}finally{await rm(dir,{recursive:true,force:true});}
