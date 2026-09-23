import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'m59-traffic-'));
process.env.M59_LEDGER_DIR=scratch;process.env.M59_UPTIME_FILE=join(scratch,'uptime.jsonl');
const {Session}=await import('./m59-game.mjs');
const {Autopilot}=await import('./m59-autopilot.mjs');
const {chooseTrafficBlink}=await import('./m59-blink-rung.mjs');
const {firstAnswer}=await import('./m59-strategies.mjs');
const {attachSurvivalDecisions,chooseSurvivalDecision}=await import('./m59-survival-decision.mjs');

function blinkFixture() {
  // Single-square corridor split by a body; landing and goal are on the far side.
  const room={num:584,rows:1,cols:9};
  const geo={standPoint:(r,c)=>r===1&&c>=1&&c<=9?{x:c*1024,y:1024}:null,
    moverStepLands:(r,c,tr,tc)=>r===1&&tr===1&&Math.abs(tc-c)===1};
  const bodies=[{row:1,col:5,kind:'player'}];
  const c={self:{row:1,col:2},spells:[{id:7,name:'blink'}],evSeq:0,
    vitals:()=>({health:{value:100,max:100},mana:{value:30,max:40},vigor:{value:80}}),
    cast:()=>{},waitFor:async()=>{c.self={row:1,col:7};return {events:[{kind:'moved'}]};}};
  const s=Object.assign(Object.create(Session.prototype),{name:null,client:c,world:{room,geometry:geo},
    movementGeneration:0,cancelledMovementTokens:new Set(),_tickLoop:{_frozen:false},
    _blockingBodies:()=>bodies,_blinkPointHere:()=>({row:1,col:7})});
  attachSurvivalDecisions(s,{record:()=>{}});
  const ctx={room,geo,self:c.self,bodies,blink:{row:1,col:7},goal:{row:1,col:9},
    vitals:c.vitals(),stuck_ms:20000,knowsBlink:true,from:'walker'};
  Session._strategies={strategies:[]};Session._firstAnswer=firstAnswer;
  return {s,c,ctx};
}

test('clean checkout selects the shipped blink rung across an actual blocked corridor',async()=>{
  const {s,ctx}=blinkFixture(),a=await s._askStrategies('whenStuck',ctx);
  assert.equal(a.strategy,'builtin-blink-escape');
  const out=await s.blinkOut({expect:a.answer.expect});
  assert.equal(out.arrived,true);assert.equal(s._tickLoop._frozen,false);
  assert.equal(s.blinkRungStats.casts,1);assert.equal(s.blinkRungStats.arrivals,1);
});
for(const [reason,change] of [
  ['spell_unknown',x=>x.knowsBlink=false],['under_fire',x=>x.underFire=true],
  ['low_health',x=>x.vitals.health.value=65],['low_mana',x=>x.vitals.mana.value=14],
  ['low_vigor',x=>x.vitals.vigor.value=10],['cooldown',x=>x.cooldown=true],
  ['disabled',x=>x.disabled=true],['missing_geometry_or_goal',x=>x.goal=null],
  ['jam_not_measured_long_enough',x=>x.stuck_ms=200],
  ['landing_occupied',x=>x.bodies.push({row:1,col:7})],
  ['already_at_landing',x=>x.self={...x.blink}],
  ['no_reachable_gain',x=>x.blink={row:1,col:3}],
])test('blink refuses '+reason,()=>{
  const {ctx}=blinkFixture();change(ctx);assert.equal(chooseTrafficBlink(ctx).reason,reason);
  assert.equal(chooseTrafficBlink(ctx).can,false);
});
test('all asks are counted even when identical refusal receipts are throttled',async()=>{
  const {s,c,ctx}=blinkFixture();c.spells=[];
  for(let i=0;i<3;i++)assert.equal(await s._askStrategies('whenStuck',ctx),null);
  assert.equal(s.blinkRungStats.refusals.spell_unknown,3);
});
for(const enabled of [false,true])test('explicit private '+(enabled?'decline':'disable')+' cannot be bypassed',async()=>{
  const {s,ctx}=blinkFixture();
  Session._strategies={strategies:[{name:'blink-escape',enabled,whenStuck:()=>null}]};
  assert.equal(await s._askStrategies('whenStuck',ctx),null);
  assert.equal(s.blinkRungStats.last.reason,enabled?'private_policy_declined':'private_policy_disabled');
});
test('a broken private blink policy fails closed instead of activating a fallback',async()=>{
  const {s,ctx}=blinkFixture();
  Session._strategies={strategies:[],problems:[{file:'blink-escape.mjs',why:'syntax error'}]};
  assert.equal(await s._askStrategies('whenStuck',ctx),null);
  assert.equal(s.blinkRungStats.last.reason,'private_policy_load_error');
});
for(const mode of ['new owner before cast','death before cast','new damage','landing filled','death and respawn','new owner during cast','no displacement'])
test('blink does not credit '+mode,async()=>{
  const {s,c,ctx}=blinkFixture();const a=await s._askStrategies('whenStuck',ctx);
  let casts=0;c.cast=()=>casts++;
  if(mode==='new owner before cast')s.cancelMovement(null,'test replacement');
  if(mode==='death before cast')s.lifeBoundary=1;
  if(mode==='new damage')s.damagedAt=Date.now();
  if(mode==='landing filled')ctx.bodies.push({row:1,col:7});
  c.waitFor=async()=>{
    if(mode==='death and respawn')s.lifeBoundary=1;
    if(mode==='new owner during cast') {
      s.cancelMovement(null,'new owner');assert.equal(s._tickLoop._frozen,false);
      s._tickLoop._frozen=true; // this pause now belongs to the replacement
    }
    if(mode!=='no displacement')c.self={row:1,col:7};
    return {events:[{kind:'moved'}]};
  };
  const out=await s.blinkOut({expect:a.answer.expect,movementGeneration:0});
  assert.equal(out.arrived,false);assert.equal(s.blinkRungStats.arrivals,0);
  if(['new owner before cast','death before cast','new damage','landing filled'].includes(mode))assert.equal(casts,0);
  if(mode==='new owner during cast')assert.equal(s._tickLoop._frozen,true);
  else assert.equal(s._tickLoop._frozen,false);
});
function keeperFixture() {
  const {s,c,ctx}=blinkFixture();
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{deaths:0},
    claims:new Map(),passes:1,watch:{pulses:[]},note:()=>{},ledgerEvent:()=>{},
    recordFrame:()=>{},progress:()=>{},who:()=>null,currentRecoveryWall:()=>null,
    checkFreeze:()=>false,safety:()=>({fleeAt:0.7}),facultyHeld:()=>false});
  return {s,c,k,ctx};
}
test('recovery detour preserves a journey through the real travelling posture and resumes its original goal',async()=>{
  const {k,s}=keeperFixture();
  k.goTravelling('tour',{to:110});const destinations=[];
  k.travel=async(to,opts)=>{
    destinations.push(to);k.goTravelling('detour',{to,recoveryDetour:opts.recoveryDetour});
    assert.equal(k.inert.guard.safe_spot,true);
    if(to===153) {
      assert.equal(k.suspendedJourney.to,110);
      k.suspendJourney('detour interrupted');assert.equal(k.suspendedJourney.to,110);
    }
    s.world.room.num=to;k.revive('arrived');return {arrived:true};
  };
  await k.recoveryTravel(153);
  assert.equal(k.suspendedJourney.to,110);
  await k.resumeSuspendedJourney({s,c:s.client,room:s.world.room,v:s.client.vitals(),hp:1});
  assert.deepEqual(destinations,[153,110]);assert.equal(k.suspendedJourney,null);
});
test('ordinary keeper travel to a vendor cannot erase its suspended tour',async()=>{
  const {k,s}=keeperFixture();
  k.suspendedJourney={to:110,at:Date.now(),attempts:1,deaths_at:0};
  k.answerWedge=async()=>null;k.restBeforeSettingOut=async()=>{};
  k.hitDamageTotal=()=>0;k.detailEvent=()=>{};
  s.world.route=()=>({found:true,hops:[{to:153},{to:109}]});
  s.travel=async to=>{
    assert.equal(k.inert.to,109);assert.equal(k.inert.guard.safe_spot,true);
    assert.equal(k.suspendedJourney.to,110);s.world.room.num=to;return {arrived:true};
  };
  assert.equal((await k.travel(109)).arrived,true);
  assert.equal(k.suspendedJourney.to,110);assert.equal(k.inert,null);
});
for(const mode of ['replacement','cancel','death'])test('recovery detour never resurrects a '+mode+' journey',async()=>{
  const {k,s}=keeperFixture();k.goTravelling('tour',{to:110});
  k.travel=async()=>{
    if(mode==='replacement')k.goTravelling('new order',{to:39});
    if(mode==='cancel')k.cancelJourney('stop');
    if(mode==='death'){k.tally.deaths++;k.suspendedJourney=null;}
    return {arrived:false};
  };
  await k.recoveryTravel(153);assert.equal(k.suspendedJourney,null);
  if(mode==='replacement')assert.equal(k.inert.to,39);
});
test('real pending dispatcher reaches blink after doing=null and retains the destination',async()=>{
  const {k,s,c,ctx}=keeperFixture();k.doing=null;k.suspendedJourney={to:110};
  const episode={id:'jam',at:Date.now()-20000};
  k.survivalJam=()=>episode;k.wedgedInPlace=()=>true;k.rememberSurvivalJam=()=>episode;
  k.onwardExit=()=>ctx.goal;k.inReachOfUs=()=>[];k.escapeIfWedgedAndHurt=async()=>false;
  k.tradeInPlaceIfWedged=()=>assert.fail('combat before blink');
  chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'blocked'});
  assert.equal(await k.continueSurvivalDecisionStep(),true);
  assert.equal(s.blinkRungStats.arrivals,1);assert.equal(k.suspendedJourney.to,110);
});
