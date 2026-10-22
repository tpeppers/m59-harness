import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const identity=await import(process.env.M59_PROCESS_IDENTITY_MODULE??'./runtime/process-identity.mjs');
const {withStashLease}=await import(process.env.M59_CHALICE_MODULE??'./m59-island-chalice.mjs');
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
const original=childProcess.execFileSync;
let calls=0;
childProcess.execFileSync=()=>{calls++;throw Error('a self-identity check must not start an OS query');};
syncBuiltinESMExports();
try{
 await test('the default self identity is known without an OS process',()=>{
  calls=0;const first=identity.processStartedAt(process.pid),second=identity.processStartedAt(process.pid);
  assert.ok(Number.isSafeInteger(first));assert.equal(first,second);assert.equal(calls,0);
  assert.ok(Math.abs(first-(Date.now()-process.uptime()*1000))<=identity.START_TIME_TOLERANCE_MS);
 });
 await test('an explicit query fixture can still override the self PID',()=>{
  let queried=0;assert.equal(identity.processStartedAt(process.pid,{exec:()=>{queried++;return '';}}),null);assert.equal(queried,1);
 });
 await test('twenty queued real stash leases leave the owning event loop free of self queries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'m59-stash-selftest-')),done=[];calls=0;
  try{
   const records=Array.from({length:20},(_,i)=>({agent:'courier'+i,receipt:join(dir,'courier'+i+'.json'),stash:{items:[]},complete:false}));
   for(const r of records)writeFileSync(r.receipt,JSON.stringify(r));
   await Promise.all(records.map((r,i)=>withStashLease({agent:r.agent},r,async()=>{
    if(i===0)await new Promise(resolve=>setImmediate(resolve));
    done.push(r.agent);
   })));
   assert.equal(done.length,20);assert.equal(new Set(done).size,20);assert.equal(calls,0);
   assert.equal(existsSync(join(dir,'refill.lock')),false);
  }finally{
   assert.ok(resolve(dir).toLowerCase().startsWith((resolve(tmpdir())+sep).toLowerCase()));
   rmSync(dir,{recursive:true,force:true});
  }
 });
 const foreign=process.pid+100000,stamp=Date.UTC(2021,5,2,14,36,5),queries=[];
 childProcess.execFileSync=(bin,args)=>{queries.push({bin,args});return process.platform==='win32'?`${foreign} ${BigInt(stamp)*10000n+621355968000000000n}\n`:`${foreign} Wed Jun  2 14:36:05 2021\n`;};
 syncBuiltinESMExports();
 await test('mixed process reads query foreign PIDs once and retain the local identity',()=>{
  const result=identity.processStartTimes([process.pid,foreign]);
  assert.ok(Number.isSafeInteger(result.get(process.pid)));assert.equal(result.get(foreign),stamp);assert.equal(queries.length,1);
  if(process.platform==='win32')assert.ok(!new RegExp('ProcessId='+process.pid+'(?:\\D|$)').test(queries[0].args.join(' ')));
  else assert.equal(queries[0].args.at(-1),String(foreign));
 });
}finally{childProcess.execFileSync=original;syncBuiltinESMExports();}
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
