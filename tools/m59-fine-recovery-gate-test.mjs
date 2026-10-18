import assert from'node:assert/strict';import{test}from'node:test';import{fineRecoveryInterruption}from'./m59-fine-recovery-gate.mjs';
const sample=()=>({hp:{value:74,max:74},vigor:{value:80},autopilot_status:{survival_decisions:{current:{id:'51532-1792258821230-6',source:'keeper',status:'recovering',strategy:'rest_safe'}}}});
test('captured full-health post-recovery label permits the next fine-walk observation',()=>{assert.equal(fineRecoveryInterruption(sample()),null);});
test('a wounded active keeper recovery still holds movement',()=>{const s=sample();s.hp.value=73;assert.equal(fineRecoveryInterruption(s)?.reason,'keeper_recovery_active');});
test('full-health keeper trip still holds movement independently of recovery labels',()=>{const s=sample();s.autopilot_status.recovery_travel={id:'protected-trip'};assert.deepEqual(fineRecoveryInterruption(s),{arrived:false,reason:'keeper_recovery_trip_active',trip_id:'protected-trip'});});
test('ended decisions and unrelated sources do not create an active keeper health gate',()=>{for(const patch of[{status:'ended',ended_at:Date.now()},{source:'other'}]){const s=sample();s.hp.value=73;Object.assign(s.autopilot_status.survival_decisions.current,patch);assert.equal(fineRecoveryInterruption(s),null);}});

test('actual fineclimb observation wrapper agrees with native healthy movement permission',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('./m59-fineclimb.mjs',import.meta.url),'utf8');const start=source.indexOf('const checkObserved=s=>'),end=source.indexOf('const observe=observeRaw?',start),receipts=[];
 const check=Function('fineRecoveryInterruption','receipt',source.slice(start,end)+';return checkObserved;')(fineRecoveryInterruption,e=>receipts.push(e));const healthy=sample();assert.equal(check(healthy),healthy);assert.equal(receipts.length,0);
 const wounded=sample();wounded.hp.value=73;assert.throws(()=>check(wounded),/keeper_recovery_active/);assert.equal(receipts.at(-1).reply.decision_id,wounded.autopilot_status.survival_decisions.current.id);
 healthy.autopilot_status.recovery_travel={id:'active-trip'};assert.throws(()=>check(healthy),/keeper_recovery_trip_active/);
});
