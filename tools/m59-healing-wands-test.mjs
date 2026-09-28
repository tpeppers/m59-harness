import assert from 'node:assert/strict';
import { HealingWands, healingWandState, isHealingWand } from './m59-healing-wands.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { Session } from './m59-session.mjs';
import { normalise } from './m59-loadout.mjs';
import { TUNABLES } from './m59-tuning.mjs';
const charged = 'This wand is almost comically decorated by obviously fake gems. Still, the wand hums nearly inaudibly, and when you put your hand on it, it is warm to the touch.';
const empty = 'The once pristine wand is now a blackened mess.';
let passed=0;
async function test(name, fn) { await fn(); passed++; console.log('ok '+name); }
function fixture({ hp=40, name='wand of healing', description=charged }={}) {
  const sent=[], notes=[];
  const c={ state:'game',selfId:1,evSeq:10,inventory:[{id:2,nameRsc:2,amount:1}],
    rsc:{get:()=>name},vitals:()=>({health:{value:hp,max:100}}),
    stats:()=>{},look:id=>sent.push(['look',id]), apply:(id,target)=>sent.push(['apply',id,target]),drop:ids=>sent.push(['drop',ids]),
    waitFor:async()=>({events:[{id:2,seq:11,description}]}) };
  const s={client:c,live:true,pacer:{submit:async(kind,fn)=>fn()}};
  const w=new HealingWands();
  const tick=extra=>w.tick(s,{below:.65,note:r=>notes.push(r),...extra});
  return {c,s,w,sent,notes,tick,setHP:n=>hp=n};
}
await test('exact healing identity and definitive depletion only',()=>{
  assert(isHealingWand('wand of healing')); assert(!isHealingWand('vampiric wand')); assert(!isHealingWand('wand'));
  assert.equal(healingWandState(empty),'empty'); assert.equal(healingWandState(charged),'charged');
  assert.equal(healingWandState('The wand has no effect.'),'unknown');
});
await test('low health applies to self once, with cooldown',async()=>{
  const f=fixture(); await f.tick(); await f.tick();
  assert.deepEqual(f.sent.filter(x=>x[0]==='apply'),[['apply',2,1]]);
  assert.equal(f.notes[0].action,'apply_self');
});
await test('at threshold and healthy inspect but conserve charges',async()=>{
  for(const hp of [65,100]) { const f=fixture({hp}); await f.tick(); assert(!f.sent.some(x=>x[0]==='apply')); }
});
await test('confirmed empty healing wand dropped even while healthy',async()=>{
  const f=fixture({hp:100,description:empty}); await f.tick();
  assert(f.sent.some(x=>x[0]==='drop')); assert(!f.sent.some(x=>x[0]==='apply'));
});
await test('vampiric, unknown and other wands never used or dropped even if empty',async()=>{
  for(const name of ['vampiric wand','wand','wand of healing power','wand of lightning']) {
    const f=fixture({name,description:empty}); await f.tick(); assert.equal(f.sent.length,0);
  }
});
await test('missing, stale and unrelated LOOK cannot authorize disposal or use',async()=>{
  for(const events of [[],[{id:99,seq:11,description:empty}],[{id:2,seq:10,description:empty}],[{id:2,seq:11,description:'unknown'}]]) {
    const f=fixture(); f.c.waitFor=async()=>({events}); await f.tick(); assert.deepEqual(f.sent,[['look',2]]);
  }
});
await test('zero or invalid threshold is inert',async()=>{
  for(const below of [0,-1,2,NaN,'0.65']) { const f=fixture(); await f.tick({below}); assert.equal(f.sent.length,0); }
});
await test('death or missing health cannot spend',async()=>{
  const f=fixture({hp:0}); await f.tick(); assert.equal(f.sent.length,0);
  f.c.vitals=()=>({}); await f.tick(); assert.equal(f.sent.length,0);
});
await test('takeover, cancellation, inventory loss, recovery, reconnect during LOOK',async()=>{
  for(const change of ['takeover','cancel','missing','heal','reconnect']) {
    const f=fixture(); let allowed=true,cancel=false;
    const wait=f.c.waitFor; f.c.waitFor=async()=>{const r=await wait();
      if(change==='takeover')allowed=false; if(change==='cancel')cancel=true;
      if(change==='missing')f.c.inventory=[]; if(change==='heal')f.setHP(100);
      if(change==='reconnect')f.s.client={...f.c}; return r;
    };
    await f.tick({allowed:()=>allowed,cancelled:()=>cancel}); assert.deepEqual(f.sent,[['look',2]]);
  }
});
await test('pacer-time takeover blocks both apply and drop',async()=>{
  for(const description of [charged,empty]) { const f=fixture({description}); let allowed=true;
    f.s.pacer.submit=async(kind,fn)=>{if(kind!=='look')allowed=false; return fn();};
    await f.tick({allowed:()=>allowed}); assert.deepEqual(f.sent,[['look',2]]);
  }
});
await test('last charge is inspected and dropped on a later turn',async()=>{
  const f=fixture(); await f.tick(); f.w.nextUse=0; f.w.entries.get(2).retryAt=0;
  f.c.evSeq=12; f.c.waitFor=async()=>({events:[{id:2,seq:13,description:empty}]});
  await f.tick(); assert.deepEqual(f.sent.map(x=>x[0]),['look','apply','look','drop']);
});
await test('overlapping ticks cannot double-spend',async()=>{
  const f=fixture(); let release; f.c.waitFor=()=>new Promise(r=>release=r);
  const first=f.tick(); await new Promise(r=>setImmediate(r)); await f.tick();
  release({events:[{id:2,seq:11,description:charged}]}); await first;
  assert.equal(f.sent.filter(x=>x[0]==='apply').length,1);
});
await test('keeper ownership gates farming healing',async()=>{
  for(const override of [{inert:{}},{stopping:true},{running:false},{parking:true},{mode:'idle'},{busyStatus:()=>({})},{checkFreeze:()=>true}]) {
    const f=fixture(); const ap={s:f.s,policy:{healWandBelow:.65},healingWands:f.w,running:true,mode:'farm',busyStatus:()=>null,checkFreeze:()=>false,note:()=>{},...override};
    await Autopilot.prototype.useHealingWand.call(ap); assert.equal(f.sent.length,0);
  }
});
await test('real attack loop invokes healing before health abort and retains retreat',async()=>{
  const f=fixture(); f.c.room={objects:new Map([[3,{id:3}]])}; f.c.eventsSince=()=>[];
  f.s.need=()=>f.c; let calls=0; f.s.healingWandTick=async()=>{calls++;};
  const r=await Session.prototype.attackRounds.call(f.s,3,1,{abortBelow:.6});
  assert.equal(calls,1); assert.equal(r.aborted.at_health,.4);
});
await test('real attack loop rechecks cancellation after healing await',async()=>{
  const f=fixture(); f.c.room={objects:new Map([[3,{id:3}]])}; f.c.eventsSince=()=>[];
  f.s.need=()=>f.c; let cancelled=false; f.s.healingWandTick=async()=>{cancelled=true;};
  const r=await Session.prototype.attackRounds.call(f.s,3,1,{abortBelow:.6,shouldCancel:()=>cancelled});
  assert.equal(r.cancelled.at_swing,0);
});
await test('damage crossing the threshold gets a healing attempt before post-swing retreat',async()=>{
  const f=fixture({hp:70}); f.c.room={objects:new Map([[3,{id:3}],[1,{id:1}]])};
  f.s.need=()=>f.c; f.s.faceToward=async()=>{}; f.c.attack=()=>f.setHP(40);
  f.c.waitFor=async()=>({events:[]}); let readings=[];
  f.s.healingWandTick=async()=>{readings.push(f.c.vitals().health.value);};
  const r=await Session.prototype.attackRounds.call(f.s,3,1,{abortBelow:.6});
  assert.deepEqual(readings,[70,40]); assert.equal(r.aborted.at_health,.4);
});
await test('threshold is persisted and validated in loadouts and tuning',()=>{
  for(const value of [0,.65,1]) {
    assert.equal(normalise({policy:{heal_wand_below:value}}).loadout.policy.heal_wand_below,value);
    assert.equal(TUNABLES.heal_wand_below.check(value),value);
  }
  for(const value of [-1,65]) {
    assert.equal(normalise({policy:{heal_wand_below:value}}).loadout.policy.heal_wand_below,undefined);
    assert.equal(TUNABLES.heal_wand_below.check(value),null);
  }
});
console.log(passed + ' healing-wand tests passed');

