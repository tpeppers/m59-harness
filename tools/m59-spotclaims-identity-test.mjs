import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{configureSpotClaimStore,reconcileDeadSpotClaims}from'./m59-spotclaims.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-claim-identity-'));try{
 const cfg=configureSpotClaimStore({directory:dir,namespace:'fixture'}),put=(name,record)=>{const path=join(cfg.path,name);writeFileSync(path,JSON.stringify(record));return path;};
 const old=put('passage-7001-old.json',{agent:'old',pid:7001,updated_at:10000}),valid=put('passage-7002-valid.json',{agent:'live',pid:7002,updated_at:40000}),unknown=put('passage-7003-unknown.json',{agent:'unknown',pid:7003,updated_at:10000}),absent=put('claim-7004-absent.json',{agent:'dead',pid:7004,updated_at:10000});
 const traversal=put('traversal-7004-protected.json',{agent:'retained',pid:7004,updated_at:10000});
 let calls=0;const report=reconcileDeadSpotClaims({now:50000,live:pid=>pid!==7004,starts:pids=>{calls++;assert.deepEqual(pids.sort(),[7001,7002,7003]);return new Map([[7001,30000],[7002,20000],[7003,null]]);}});
 assert.equal(calls,1);assert(!existsSync(old));assert(!existsSync(absent));assert(existsSync(valid));assert(existsSync(unknown));assert.equal(report.removed.length,2);assert(existsSync(traversal),'dead-driver traversal receipts retain their separate confirmed-exit contract');assert.equal(report.unknown.length,1);
 // A writer may replace its record while the process query runs; never remove
 // that new record based on evidence about the old bytes.
 const race=put('passage-7005-race.json',{agent:'race',pid:7005,updated_at:10000});
 reconcileDeadSpotClaims({now:60000,live:()=>true,starts:()=>{writeFileSync(race,JSON.stringify({agent:'race',pid:7005,updated_at:55000}));return new Map([[7002,20000],[7003,null],[7005,40000]]);}});
 assert.equal(JSON.parse(readFileSync(race)).updated_at,55000);
 console.log('PASS one batched process query removes only absent/recycled ownership; live, unknown and concurrently replaced records remain protected');
}finally{configureSpotClaimStore({enabled:false});rmSync(dir,{recursive:true,force:true});}
