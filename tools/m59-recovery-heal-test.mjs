import assert from 'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{affordableHeal,castRecoveryHeal}from'./m59-recovery-heal.mjs';import{publishFleetHealth,readFleetHealth}from'./m59-fleet-health.mjs';
const fixture=()=>{const names=new Map([[1,'minor heal'],[2,'major heal'],[3,'herbs']]);const vitals={health:{value:40,max:75},mana:{value:30},vigor:{value:180}};let casts=0;
 const c={stand(){this.lastPostureCommand={verb:'stand',at:Date.now(),room_object_id:this.room.id};},selfId:7,me:{name:'Patient'},self:{id:7,row:5,col:8,x:544,y:352},combatReady:true,state:'game',room:{id:10,objects:new Map()},spells:[{id:12,nameRsc:2},{id:11,nameRsc:1}],inventory:[{id:15,nameRsc:3,amount:8}],rsc:{get:k=>names.get(k)},vitals:()=>structuredClone(vitals),evSeq:4,cast(){casts++;vitals.mana.value-=3;vitals.health.value+=8;},waitFor:async()=>({events:[]})};
 const s={client:c,credentials:{host:'127.0.0.1',port:15959},world:{room:{num:827}},pacer:{submit:async(_kind,fn)=>fn()}};return{s,c,vitals,casts:()=>casts};};
test('recovery chooses affordable minor heal even when an expensive heal precedes it in the spell book',async()=>{const f=fixture();assert.equal(affordableHeal(f.c).name,'minor heal');const r=await castRecoveryHeal(f.s);assert.equal(f.casts(),1);assert.equal(r.health_gain,8);assert.equal(r.mana_spent,3);assert(r.confirmed);});
test('no unknown spell, missing herbs, unknown mana or exhausted mana produces a cast',async()=>{for(const change of[f=>f.c.spells=[],f=>f.c.inventory=[],f=>f.vitals.mana.value=undefined,f=>f.vitals.mana.value=3]){const f=fixture();change(f);assert.equal(affordableHeal(f.c),null);assert.equal((await castRecoveryHeal(f.s)).cast,false);assert.equal(f.casts(),0);}});
test('a movement takeover or changed socket while queued cancels the actual cast',async()=>{for(const socket of[false,true]){const f=fixture();let cancelled=false;f.s.pacer.submit=async(_kind,fn)=>{if(socket)f.s.client={};else cancelled=true;return fn();};assert.equal((await castRecoveryHeal(f.s,{shouldCancel:()=>cancelled})).cast,false);assert.equal(f.casts(),0);}});
test('a self heal that becomes unnecessary before send spends nothing',async()=>{const f=fixture();f.s.pacer.submit=async(_kind,fn)=>{f.vitals.health.value=75;return fn();};assert.equal((await castRecoveryHeal(f.s)).cast,false);assert.equal(f.casts(),0);});
test('ally cast records paid mana separately from unobservable recipient health',async()=>{const f=fixture();f.c.room.objects.set(22,{id:22});const r=await castRecoveryHeal(f.s,{targetId:22,targetHealth:{value:8,max:20}});assert.equal(r.health_gain,null);assert.equal(r.mana_spent,3);assert(r.paid);assert.equal(r.confirmed,false);});
test('missing target and unpaid/refused casts never claim a confirmed heal',async()=>{const f=fixture();assert.equal((await castRecoveryHeal(f.s,{targetId:22})).cast,false);f.c.cast=()=>{};const r=await castRecoveryHeal(f.s);assert.equal(r.mana_spent,0);assert.equal(r.health_gain,0);assert.equal(r.confirmed,false);});
test('health reports require matching character, endpoint, room, body and freshness',()=>{const directory=mkdtempSync(join(tmpdir(),'m59-health-'));try{const f=fixture();assert(publishFleetHealth(f.s,{directory,now:10000}));const identity={host:'127.0.0.1',port:15959,character:'PATIENT'},base={directory,now:11000,room:827,bodyId:7};assert.equal(readFleetHealth(identity,base).health.value,40);for(const patch of[{room:826},{bodyId:8},{now:16000},{now:9000}])assert.equal(readFleetHealth(identity,{...base,...patch}),null);assert.equal(readFleetHealth({...identity,port:5959},base),null);assert.equal(readFleetHealth({...identity,character:'Other'},base),null);f.c.combatReady=false;assert.equal(publishFleetHealth(f.s,{directory,now:20000}),false);}finally{rmSync(directory,{recursive:true,force:true});}});

test('real active recovery heals itself before passive rest and finishes with full health',async()=>{
 const {Autopilot}=await import('./m59-autopilot.mjs');const {attachSurvivalDecisions,chooseSurvivalDecision}=await import('./m59-survival-decision.mjs');
 const f=fixture();f.vitals.health.value=67;f.s.movementGeneration=0;f.s.movementWasCancelled=()=>false;attachSurvivalDecisions(f.s);chooseSurvivalDecision(f.s,{strategy:'nearest_refuge',status:'recovering',phase:'reconnected_turn_and_heal',reason:'hurt at safe wall'});
 const a=Object.assign(Object.create(Autopilot.prototype),{s:f.s,policy:{},currentRecoveryWall:()=>true,checkFreeze:()=>false,facultyHeld:()=>false,rememberSurvivalJam:()=>{},note:()=>{},recordCast:()=>{}});
 assert.equal(await a.continueSurvivalDecisionStep(),true);assert.equal(f.casts(),1);assert.equal(f.vitals.health.value,75);
});

test('actual farm and idle healers treat fresh fleetmates without requiring coop strategy',async()=>{
 const {Autopilot}=await import('./m59-autopilot.mjs');const {setRosterSource}=await import('./m59-party.mjs');const {createHash}=await import('node:crypto');const {unlinkSync}=await import('node:fs');
 const f=fixture(),patient=fixture(),name='Offline Healing Fixture Patient',port=65530;
 patient.c.me.name=name;patient.c.selfId=22;patient.c.self.id=22;patient.vitals.health={value:8,max:20};patient.s.credentials.port=port;
 f.s.credentials.port=port;f.vitals.health.value=75;f.c.rsc.get=id=>id===99?name:({1:'minor heal',2:'major heal',3:'herbs'})[id];f.c.room.objects.set(22,{id:22,nameRsc:99,flags:5});f.s.movementGeneration=0;f.s.movementWasCancelled=()=>false;
 const file=new URL('../substrate/fleet-health/'+createHash('sha256').update(JSON.stringify(['127.0.0.1',port,name.toLowerCase()])).digest('hex')+'.json',import.meta.url);
 try{setRosterSource(()=>new Set([name]));assert(publishFleetHealth(patient.s));const notes=[],evidence=[];f.c.observeSessionEvidence=e=>evidence.push(e);const a=Object.assign(Object.create(Autopilot.prototype),{s:f.s,mode:'farm',policy:{strategy:'fieldrest'},facultyHeld:()=>false,checkFreeze:()=>false,note:(...v)=>notes.push(v),recordCast:()=>{}});assert.equal(await a.healObservedFleetmate(),true);assert.equal(f.casts(),1);assert.equal(notes[0][1].target,name);const result=JSON.parse(evidence.find(e=>e.opcode==='HEAL_RESULT').reason);assert.equal(result.trigger,'observed_fleetmate');assert.equal(result.self,false);assert.deepEqual(result.target_health_before,patient.s.client.vitals().health);assert(result.target_report_before_at>0);assert.equal(result.mana_spent,3);assert.equal(await a.healObservedFleetmate(),false,'one cast per short cooldown');a._observedAllyHealAt=0;
 patient.vitals.health={value:17,max:20};await new Promise(r=>setTimeout(r,510));assert(publishFleetHealth(patient.s));a.mode='idle';assert.equal(await a.healObservedFleetmate(),true,'idle support may finish an85-percent ally toward the90-percent readiness gate');assert.equal(f.casts(),2);a._observedAllyHealAt=0;patient.vitals.health={value:18,max:20};await new Promise(r=>setTimeout(r,510));assert(publishFleetHealth(patient.s));assert.equal(await a.healObservedFleetmate(),false,'a ready ally missing fewer than three HP is not wastefully healed');patient.vitals.health={value:8,max:20};await new Promise(r=>setTimeout(r,510));assert(publishFleetHealth(patient.s));
 a.mode='train';assert.equal(await a.healObservedFleetmate(),false,'unrequested work modes do not become healers');a.mode='farm';
 a.facultyHeld=kind=>kind==='work';assert.equal(await a.healObservedFleetmate(),false,'leased work retains ownership');a.facultyHeld=()=>false;

 const send=f.s.pacer.submit;f.s.pacer.submit=async(kind,fn)=>{f.c.room.objects.set(22,{id:22,nameRsc:100,flags:5});return send(kind,fn);};
 assert.equal(await a.healObservedFleetmate(),false,'a recycled target ID cannot heal a different player');assert.equal(f.casts(),2);
 f.c.room.objects.set(22,{id:22,nameRsc:99,flags:5});f.s.pacer.submit=send;a._observedAllyHealAt=0;f.s.client=f.c;f.vitals.health.value=30;assert.equal(await a.healObservedFleetmate(),false,'a wounded caster protects its own health');}
 finally{setRosterSource(null);try{unlinkSync(file);}catch{}}
});


test('delayed self healing observes beyond the first mana payment without sending another cast',async()=>{const f=fixture();let reads=0;f.c.cast=()=>{f.vitals.mana.value-=3;};f.c.waitFor=async()=>{reads++;if(reads===2)f.vitals.health.value+=8;return{events:[{seq:4+reads,kind:'stat',name:reads===1?'mana':'health'}]};};const r=await castRecoveryHeal(f.s);assert.equal(reads,2);assert.equal(r.mana_spent,3);assert.equal(r.health_gain,8);assert(r.confirmed);});
test('paid failed spells retain the server verdict and never claim a confirmed heal',async()=>{const f=fixture();f.c.cast=()=>{f.vitals.mana.value-=2;};f.c.waitFor=async()=>({events:[{seq:5,kind:'message',text:'You were unsuccessful in casting minor heal.'}]});const r=await castRecoveryHeal(f.s);assert.equal(r.server_outcome,'failed');assert(r.paid);assert.equal(r.health_gain,0);assert.equal(r.confirmed,false);});
test('critical self healing can spend its last three mana while ordinary recovery keeps its reserve',async()=>{const f=fixture();f.vitals.health.value=1;f.vitals.mana.value=3;assert.equal(affordableHeal(f.c).name,'minor heal');assert((await castRecoveryHeal(f.s)).confirmed);assert.equal(f.vitals.mana.value,0);});

test('unpaid coincident health regeneration is not reported as a confirmed own healing spell',async()=>{const f=fixture();f.c.cast=()=>{f.vitals.health.value+=4;};const r=await castRecoveryHeal(f.s);assert.equal(r.mana_spent,0);assert.equal(r.health_gain,4);assert.equal(r.paid,false);assert.equal(r.confirmed,false);});


test('an explicit failed spell cannot be confirmed by coincident paid-mana regeneration',async()=>{const f=fixture();f.c.cast=()=>{f.vitals.mana.value-=2;f.vitals.health.value+=2;};f.c.eventsSince=()=>[{seq:5,kind:'message',text:'You were unsuccessful in casting minor heal.'}];const r=await castRecoveryHeal(f.s);assert(r.paid);assert.equal(r.health_gain,2);assert.equal(r.server_outcome,'failed');assert.equal(r.confirmed,false);});

test('heal_spells: only the allowed heals are ever chosen, by every recovery path',async()=>{
 // Pepe, 2026-10-26: practising hospice on himself, his keeper healed him with minor heal a dozen times an hour.
 const f=fixture();
 assert.equal(affordableHeal(f.c,{allow:['major heal']}).name,'major heal','an allowed dearer heal is chosen over a cheaper forbidden one');
 assert.equal(affordableHeal(f.c,{allow:['Minor Heal']}).name,'minor heal','names match without case');
 assert.equal(affordableHeal(f.c,{allow:['hospice']}),null,'an allowed heal the character does not know is no heal at all');
 assert.equal(affordableHeal(f.c,{allow:[]}),null,'an empty list allows nothing');
 assert.equal(affordableHeal(f.c,{allow:null}).name,'minor heal','null keeps the old behaviour');
 const r=await castRecoveryHeal(f.s,{allow:['hospice']});assert.equal(r.cast,false);assert.equal(f.casts(),0);
 const {Autopilot}=await import('./m59-autopilot.mjs');const {attachSurvivalDecisions,chooseSurvivalDecision}=await import('./m59-survival-decision.mjs');
 const g=fixture();g.vitals.health.value=67;g.s.movementGeneration=0;g.s.movementWasCancelled=()=>false;attachSurvivalDecisions(g.s);
 chooseSurvivalDecision(g.s,{strategy:'nearest_refuge',status:'recovering',phase:'reconnected',reason:'test'});
 const a=Object.assign(Object.create(Autopilot.prototype),{s:g.s,policy:{healSpells:['hospice']},currentRecoveryWall:()=>true,checkFreeze:()=>false,facultyHeld:()=>false,rememberSurvivalJam:()=>{},note:()=>{},recordCast:()=>{}});
 await a.continueSurvivalDecisionStep().catch(()=>null);
 assert.equal(g.casts(),0,'the recovery rung casts no minor heal when only hospice is allowed');
});
