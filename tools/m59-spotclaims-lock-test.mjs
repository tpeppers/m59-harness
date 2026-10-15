// Exercise actual lock acquisition under Windows sharing errors; no live store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {configureSpotClaimStore,claimFileSpot,releaseFileSpot} from './m59-spotclaims.mjs';
const scratch=mkdtempSync(join(tmpdir(),'m59-claim-lock-'));
const platform=Object.getOwnPropertyDescriptor(process,'platform'),originalOpen=fs.openSync;
let failures=0,code='EPERM',opens=0;
Object.defineProperty(process,'platform',{value:'win32'});
fs.openSync=function(path,...args){
 if(basename(String(path))==='.claims.lock'){
  opens++;if(failures-->0)throw Object.assign(Error('injected sharing denial'),{code});
 }
 return originalOpen.call(this,path,...args);
};
syncBuiltinESMExports();
try{
 for(code of ['EPERM','EACCES','EBUSY']){
  const cfg=configureSpotClaimStore({directory:scratch,namespace:code});
  failures=3;opens=0;
  assert.equal(claimFileSpot('fixture',2505,54,24,{cap:1}),true);
  assert.equal(opens,4,'transient acquisition errors retry without entering early');
  assert.equal(existsSync(join(cfg.path,'.claims.lock')),false);
  assert.equal(claimFileSpot('competitor',2505,54,24,{cap:1}),false,'the actual reservation still excludes competitors');
  releaseFileSpot('fixture');
 }
 const cfg=configureSpotClaimStore({directory:scratch,namespace:'live-owner'});
 const path=join(cfg.path,'.claims.lock'),owner=JSON.stringify({pid:process.pid,process_started_at:Date.now()});
 writeFileSync(path,owner);code='EPERM';failures=2;
 assert.throws(()=>claimFileSpot('competitor',2505,54,24,{cap:1}),/stayed locked/);
 assert.equal(readFileSync(path,'utf8'),owner,'a transient permission error cannot authorize removing a live owner');
 fs.unlinkSync(path);
 configureSpotClaimStore({directory:scratch,namespace:'permanent-permission'});
 code='EPERM';failures=10000;
 assert.throws(()=>claimFileSpot('fixture',2505,54,24,{cap:1}),/stayed locked/,'a persistent denial fails closed within the existing deadline');
 code='ENOSPC';failures=1;opens=0;
 assert.throws(()=>claimFileSpot('fixture',2505,54,24,{cap:1}),/injected/);assert.equal(opens,1);
 console.log('Claim lock: transient Windows acquisition races retry, live locks remain untouched, persistent and non-sharing failures refuse.');
}finally{
 fs.openSync=originalOpen;syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);
 configureSpotClaimStore({enabled:false});rmSync(scratch,{recursive:true,force:true});
}
