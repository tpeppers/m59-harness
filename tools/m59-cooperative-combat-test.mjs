import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CooperativeCombat,CooperationStore,refreshCooperation,cooperativePass} from './m59-cooperative-combat.mjs';
import {M59Client,BP} from './m59-client.mjs';
import {OF} from './m59-parse.mjs';
import {Autopilot,PASS_STAGES} from './m59-autopilot.mjs';
import {setRosterSource} from './m59-party.mjs';
let clock=10000;
function fixture({decide=ctx=>({target_id:200,hold:ctx.me.tag?.landed===true}),proof=()=>true,store=null}={}) {
  const records=new Map();store??={write:r=>records.set(r.agent,structuredClone(r)),read:()=>[...records.values()]};
  const c=new M59Client({verbose:false,resources:new Map([[1,'Farmer'],[2,'skeleton'],[3,'zombie'],[4,'Ally']])});
  c.selfId=100;c.room={id:500,objects:new Map([[100,{id:100,nameRsc:1,flags:OF.PLAYER,row:30,col:61,x:3936,y:1952}],
    [200,{id:200,nameRsc:2,flags:OF.ATTACKABLE,row:30,col:62,x:4000,y:1952}],
    [201,{id:201,nameRsc:3,flags:OF.ATTACKABLE,row:31,col:62}]])};
  let hp=70,events=[],packets=[];
  c.vitals=()=>({health:{value:hp,max:70}});c.evSeq=0;
  c.eventsSince=cursor=>events.filter(e=>e.seq>cursor);c.send=(...args)=>packets.push(args);
  const ap={s:{name:'t1',live:true,client:c,world:{room:{num:39},geometry:{collisionReady:true}}},
    running:true,mode:'farm',policy:{hunt:['skeleton']},passStage:'passCooperativeCombat',
    safety:()=>({fleeAt:.35}),facultyOwner:()=> 'keeper',who:()=> 'Farmer',
    huntMatch:()=>name=>name==='skeleton',refuseEngagement:()=>null,tally:{},note:()=>{}};
  const co=new CooperativeCombat(ap,{store,decide,now:()=>clock,proof});ap.cooperation=co;
  c.cooperativeAttackVeto=id=>co.veto(id);c.cooperativeAttackSent=id=>co.sent(id);
  c.cooperativeCastVeto=ids=>co.castVeto(ids);c.cooperativeCastSent=ids=>co.castSent(ids);
  const line=(text,kind='message')=>events.push({seq:++c.evSeq,kind,text});
  return {ap,c,co,packets,line,records,hp:value=>hp=value};
}
test('the real attack packet is sent once, a damaging line holds repeats and retargets',()=>{
  const f=fixture();f.c.attack(200);assert.equal(f.packets.length,1);
  f.line('Your mace wounds the skeleton.');assert.equal(f.c.attack(200),false);assert.equal(f.co.commitment.landed,true);
  assert.equal(f.c.attack(201),false);assert.equal(f.packets.length,1);
});
for(const text of ['You miss the skeleton.','The skeleton is too far away.','You fail to hurt the skeleton.','The skeleton shrugs off your attack.','The skeleton laughs off your pitiful blow.'])
test(`non-damaging reply does not tag: ${text}`,()=>{
  const f=fixture();f.c.attack(200);f.line(text);f.c.attack(200);
  assert.equal(f.co.commitment.landed,false);assert.equal(f.packets.length,2);
});
test('chat quoting a hit cannot earn a tag',()=>{
  const f=fixture();f.c.attack(200);f.line('Your mace wounds the skeleton.','said');f.co.update();assert.equal(f.co.commitment.landed,false);
});
for(const change of ['room','client','body','save','quarry','name'])test(`${change} invalidates a commitment`,()=>{
  const f=fixture();f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  if(change==='room')f.c.room.id++;
  if(change==='client')f.ap.s.client={...f.c};
  if(change==='body')f.c.selfId++;
  if(change==='save')f.c.saveCount++;
  if(change==='quarry')f.c.room.objects.delete(200);
  if(change==='name')f.c.room.objects.get(200).nameRsc=3;
  f.co.update();assert.equal(f.co.commitment,null);
});
for(const change of ['low hp','PvP','fight back','inert','foreign owner','survival stage'])test(`${change} can attack despite an earned tag`,()=>{
  const f=fixture();f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  if(change==='low hp')f.hp(35);
  if(change==='PvP')f.ap.s.combat={active:{}};
  if(change==='fight back')f.ap.fightBackDue={};
  if(change==='inert')f.ap.inert={};
  if(change==='foreign owner')f.ap.facultyOwner=()=> 'human';
  if(change==='survival stage')f.ap.passStage='passFightBack';
  f.c.attack(201);assert.equal(f.packets.length,2);assert.equal(f.co.commitment,null);
});
test('self buffs remain usable; ordinary untargeted and other-target spells cannot erase a tag',()=>{
  const f=fixture();f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  f.c.cast(999,[100]);assert.equal(f.packets.length,2);
  assert.equal(f.c.cast(999,[201]),false);assert.equal(f.c.cast(999,[]),false);
  f.hp(20);f.c.cast(999,[201]);assert.equal(f.packets.length,3);assert.equal(f.co.commitment,null);
});
test('a player attack is never held by cooperation',()=>{
  const f=fixture();f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  f.c.room.objects.set(300,{id:300,flags:OF.PLAYER|OF.ATTACKABLE,nameRsc:4});
  f.c.attack(300);assert.equal(f.packets.length,2);assert.equal(f.co.commitment,null);
});
test('unreachable, out of band, wrong hunt and unknown-health candidates are excluded',()=>{
  const f=fixture({proof:()=>false});assert.deepEqual(f.co.snapshot().candidates,[]);
  f.co.proof=()=>true;assert.deepEqual(f.co.snapshot().candidates.map(o=>o.id),[200]);
  f.ap.refuseEngagement=()=>({why:'unsafe'});assert.deepEqual(f.co.snapshot().candidates,[]);
  f.hp(null);assert.equal(f.co.snapshot().eligible,false);
});
test('cross-process records are atomic, scoped to exact roster and expire; future records are refused',()=>{
  const dir=mkdtempSync(join(tmpdir(),'m59-coop-test-'));
  try{const a=join(dir,'a.json'),b=join(dir,'b.json');writeFileSync(a,'{}');writeFileSync(b,'{}');
    const x=new CooperationStore(a),y=new CooperationStore(b);
    x.write({agent:'t1',at:100});assert.equal(x.read(101).length,1);assert.equal(y.read(101).length,0);
    assert.equal(x.read(6101).length,0);assert.equal(x.read(99).length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('only fresh, visible, positively identified automated allies are offered to private policy',()=>{
  const f=fixture();setRosterSource(()=>new Set(['Farmer','Ally']));
  f.c.room.objects.set(300,{id:300,nameRsc:4,flags:OF.PLAYER,row:30,col:60});
  f.records.set('t2',{agent:'t2',character:'Ally',eligible:true,room:39,room_id:500,body:300,at:clock});
  assert.equal(f.co.context().members.length,2);
  f.records.get('t2').body=301;assert.equal(f.co.context().members.length,1);
  f.records.get('t2').body=300;f.records.get('t2').eligible=false;assert.equal(f.co.context().members.length,1);
  setRosterSource(()=>new Set());
});
test('missing or broken policy falls back to ordinary combat without holding packets',()=>{
  const f=fixture({decide:()=>null});f.c.attack(201);assert.equal(f.packets.length,1);
  f.co.decide=()=>{throw new Error('bad policy');};f.c.attack(201);assert.equal(f.packets.length,2);
});
test('keeper rung sits below survival, PvP, errands and buddy; missing strategy is inert',async()=>{
  assert.ok(PASS_STAGES.indexOf('passCooperativeCombat')>PASS_STAGES.indexOf('passFleeAndRest'));
  assert.ok(PASS_STAGES.indexOf('passCooperativeCombat')<PASS_STAGES.indexOf('passFarm'));
  assert.equal(await cooperativePass({s:{}}),false);
  const ap={s:{_askStrategies:async()=>null}};await refreshCooperation(ap);assert.equal(ap.cooperation,undefined);
  assert.equal(typeof Autopilot.prototype.passCooperativeCombat,'function');
});

test('a policy decline never turns an ordinary solo hit into a cooperative commitment',()=>{
  const f=fixture({decide:()=>null});f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  assert.equal(f.co.commitment,null);
});
test('passive protection cannot start an attack before farm readiness; it can preserve an earned tag',async()=>{
  const f=fixture();let attacks=0;f.ap.fightNow=()=>{attacks++;};
  assert.equal(await cooperativePass(f.ap,{passiveOnly:true}),false);assert.equal(attacks,0);
  f.c.attack(200);f.line('Your mace wounds the skeleton.');
  assert.equal(await cooperativePass(f.ap,{passiveOnly:true}),true);assert.equal(attacks,0);
});
test('self healing item use preserves a tag; ordinary damaging item use is held',()=>{
  const f=fixture();f.c.cooperativeApplyVeto=id=>id!==f.c.selfId&&!!f.co.commitment&&f.co.veto(id);
  f.c.attack(200);f.line('Your mace wounds the skeleton.');f.co.update();
  f.c.apply(999,100);assert.equal(f.co.commitment.landed,true);assert.equal(f.packets.length,2);
  assert.equal(f.c.apply(999,201),false);assert.equal(f.packets.length,2);
});
test('predicted positions, a foreign station and fixed buddies cannot enlist',()=>{
  const f=fixture();f.c.self.predicted=true;assert.equal(f.co.snapshot().eligible,false);
  f.c.self.predicted=false;f.ap.policy.assignedRoom=544;assert.equal(f.co.snapshot().eligible,false);
  f.ap.policy.assignedRoom=39;f.ap.policy.buddy={};assert.equal(f.co.snapshot().eligible,false);
});
test('real room geometry rejects the captured blocked approach and admits a reachable local quarry',async()=>{
  const {readFileSync}=await import('node:fs'),{bastionHarness}=await import('./fixtures/bastion-fallback-client.mjs');
  const {localMeleeProof}=await import('./m59-cooperative-combat.mjs');
  const entry=JSON.parse(readFileSync(new URL('./fixtures/cragged-combat-approach.json',import.meta.url)));
  const h=await bastionHarness(),blocked=h.fixture(entry,{bodies:true});
  assert.equal(localMeleeProof(blocked.s,blocked.c.room.objects.get(entry.target_id)),false);
  const open=h.fixture(entry,{bodies:false}),o={id:10,flags:OF.ATTACKABLE,row:30,col:36,x:2336,y:1952};
  open.c.room.objects.set(10,o);assert.equal(localMeleeProof(open.s,o),true);
});

test('active sharing preserves exact quarry and weapon preparation and honors the buff veto',async()=>{
  const f=fixture(),calls=[],hooks=[];f.ap.farmStrategyHook=(...args)=>hooks.push(args);
  f.ap.trainingStyleFor=()=> 'unarmed';f.ap.prepareTrainingStyle=async()=>({ready:true,equip:false});
  f.ap.fightNow=async opts=>{calls.push(opts);f.c.attack(opts.exactTargetId);return {fought:true};};
  f.ap.farmBuffAsk=async()=>({no_engage:true});
  assert.equal(await cooperativePass(f.ap),true);assert.equal(calls.length,0);
  f.ap.farmBuffAsk=async()=>null;assert.equal(await cooperativePass(f.ap),true);
  assert.equal(calls.length,1);assert.equal(calls[0].exactTargetId,200);
  assert.equal(calls[0].rounds,1);assert.equal(calls[0].equip,false);
  assert.ok(hooks.some(h=>h[0]==='beforeSwing'&&h[1].target_id===200));
});
for(const change of ['room','body','save','movement','fight','health'])test(`preparation ${change} changes prevent an old cooperative swing`,async()=>{
  const f=fixture();let attacks=0;
  f.ap.trainingStyleFor=()=> 'unarmed';f.ap.fightNow=async()=>{attacks++;return {fought:true};};
  f.ap.prepareTrainingStyle=async()=>{
    if(change==='room')f.c.room.id++;
    if(change==='body')f.c.selfId++;
    if(change==='save')f.c.saveCount++;
    if(change==='movement')f.ap.s.movementGeneration=1;
    if(change==='fight')f.ap.s.fightGeneration=1;
    if(change==='health')f.hp(20);
    return {ready:true,equip:false};
  };
  assert.equal(await cooperativePass(f.ap),true);assert.equal(attacks,0);
});
test('cooperative quarry admission retains normal karma, quorum, avoidance and hunt-area rules',()=>{
  const f=fixture(),ap=Object.assign(Object.create(Autopilot.prototype),{s:f.ap.s,policy:{},
    karmaForbids:()=>false,gangUpBars:()=>null,preyAvoid:()=>null,huntAreaHere:()=>null});
  const o=f.c.room.objects.get(200);assert.equal(ap.cooperativeTargetAllowed(o),true);
  ap.karmaForbids=()=>true;assert.equal(ap.cooperativeTargetAllowed(o),false);ap.karmaForbids=()=>false;
  ap.gangUpBars=()=>({met:false});assert.equal(ap.cooperativeTargetAllowed(o),false);ap.gangUpBars=()=>null;
  ap.preyAvoid=()=>()=>true;assert.equal(ap.cooperativeTargetAllowed(o),false);ap.preyAvoid=()=>null;
  ap.huntAreaHere=()=>new Set(['1,2']);assert.equal(ap.cooperativeTargetAllowed(o),false);
});
test('quarry admission changing after a tag holds the target rather than allowing another attack',()=>{
  const f=fixture({decide:()=>({target_id:200,hold:false})});f.c.attack(200);
  f.line('Your mace wounds the skeleton.');f.co.update();f.ap.cooperativeTargetAllowed=()=>false;
  assert.equal(f.c.attack(200),false);assert.equal(f.packets.length,1);
});

// Prod 2026-10-29: a Windows rename over a record another keeper is reading throws EPERM; that reached fail() in 18 of
// 21 keepers and switched sharing off for good. A transient rename error is retried, then the write is skipped.
test('a transient rename error is retried, then skipped -- the store never throws it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'coop-eperm-')),fleet=join(dir,'fleet.json');writeFileSync(fleet,'{}');
  try {
    let calls=0;const eperm=()=>Object.assign(new Error('EPERM: operation not permitted, rename'),{code:'EPERM'});
    const flaky=new CooperationStore(fleet,{rename:()=>{if(++calls<3)throw eperm();},pause:()=>{}});
    assert.equal(flaky.write({agent:'t1',at:1}),true);assert.equal(calls,3);
    const removed=[];
    const stuck=new CooperationStore(fleet,{rename:()=>{throw eperm();},remove:f=>removed.push(f),pause:()=>{}});
    assert.equal(stuck.write({agent:'t2',at:1}),false);assert.equal(stuck.skipped,1);assert.equal(removed.length,1);
    const broken=new CooperationStore(fleet,{rename:()=>{throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});},pause:()=>{}});
    assert.throws(()=>broken.write({agent:'t3',at:1}),/ENOSPC/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
