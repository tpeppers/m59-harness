// Offline: real pending-decision dispatcher and stationary-fight rung, no sockets.
import assert from 'node:assert/strict';
import {test} from 'node:test';
const {Autopilot}=await import(process.env.M59_TEST_AUTOPILOT || './m59-autopilot.mjs');
import {OF} from './m59-parse.mjs';
import {blockerRetaliated,lureRefugeFilter} from './m59-blocker-combat.mjs';
import {attachSurvivalDecisions,chooseSurvivalDecision,currentSurvivalDecision}
  from './m59-survival-decision.mjs';

function fixture() {
  const calls=[], health={value:50,max:55};
  const c={selfId:1,self:{id:1,row:35,col:32},state:'game',
    room:{objects:new Map()},inventory:[],rsc:{get:()=>''},
    vitals:()=>({health,vigor:{value:100}}),
    equipment:()=>({known:true,equipped:[{name:'short sword'}]})};
  const s={name:null,live:true,client:c,movementGeneration:0,
    world:{room:{num:584,name:'The Flatlands'}}};
  const k=Object.assign(Object.create(Autopilot.prototype),{s,policy:{},tally:{},passes:1,
    holdWorks:()=>false,currentRecoveryWall:()=>k.wall??null,checkFreeze:()=>false,
    facultyHeld:()=>!!k.externalOwner,safety:()=>({fleeAt:0.7}),threatCeiling:()=>60,
    wedgedInPlace:()=>({why:'pinned',for_ms:15000}),crowded:()=>true,
    threatCountHere:()=>8,note:(what,data)=>calls.push({what,data}),progress:()=>{},ledgerEvent:()=>{},
    protectedItemNames:()=>[],carryFloors:()=>({}),unreachableIn:()=>new Set(),
    takeRecoverySpot:async()=>{calls.push({what:'refuge'});return {took:false};},
    playDead:async()=>{calls.push({what:'wall'});return true;},
    fightNow:async(opts)=>{calls.push({what:'fight',id:opts.exactTargetId,opts});
      c.room.objects.delete(opts.exactTargetId);return {fought:true,killed:true};}});
  attachSurvivalDecisions(s,{record:()=>{},epoch:'test'});
  const decision=chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'blocked refuge'});
  const monster=(id,name,col=33,flags=OF.ATTACKABLE)=>{
    const o={id,name,row:35,col,flags};c.room.objects.set(id,o);return o;};
  monster(2,'spider');
  return {k,s,c,calls,health,decision,monster};
}

test('a pending decision reaches weak-blocker combat before the ordinary ladder',async()=>{
  const {k,s,calls,decision}=fixture();
  k.applyLoadoutPolicyOverlay=()=>assert.fail('pending recovery fell into ordinary work');
  await k.passOnce();
  assert.deepEqual(calls.filter(x=>x.what==='fight').map(x=>x.id),[2]);
  assert.equal(calls.some(x=>x.what==='refuge'),false);
  assert.equal(currentSurvivalDecision(s).id,decision.id,'preserve recovery intent');
  await k.continueSurvivalDecision();
  assert.equal(calls.filter(x=>x.what==='refuge').length,1,'resume refuge once blocker is gone');
});

test('an exhausted refuge loop can clear a weak blocker on the next pass',async()=>{
  const {k,s,c,calls,monster}=fixture();c.room.objects.clear();
  k.takeRecoverySpot=async()=>chooseSurvivalDecision(s,{strategy:'nearest_refuge',reason:'still blocked'});
  await k.continueSurvivalDecision();
  assert.ok(calls.some(x=>x.what==='survival alternatives exhausted for the current observation'));
  monster(2,'ant');
  await k.continueSurvivalDecision();
  assert.equal(calls.filter(x=>x.what==='fight').length,1);
});

test('a retry delay permits clearing a blocker without starting another walk',async()=>{
  const {k,calls,decision}=fixture();decision.retry_at=Date.now()+60000;
  await k.continueSurvivalDecision();
  assert.equal(calls.filter(x=>x.what==='fight').length,1);
  assert.equal(calls.some(x=>x.what==='refuge'),false);
});

test('sustain the exact weak target beyond three swings, then clear the next blocker',async()=>{
  const {k,c,calls,monster}=fixture();
  monster(3,'ant',32);
  const ids=[];
  k.fightNow=async opts=>{
    ids.push(opts.exactTargetId);
    assert.equal(opts.disengageAt,0.7);
    assert.equal(opts.holdPosition,true);
    assert.equal(opts.loot,false);
    if(ids.length===1) monster(4,'ant',32); // new closer target must not steal focus
    const killed=ids.length===7 || ids.length===8;
    if(killed)c.room.objects.delete(opts.exactTargetId);
    return {fought:true,killed,landed_hits:1};
  };
  await k.continueSurvivalDecision();
  assert.equal(ids.length,7);
  assert.ok(ids.every(id=>id===3));
  await k.continueSurvivalDecision();
  assert.equal(ids[7],4);
});

test('low health during a productive fight retreats before another swing',async()=>{
  const {k,calls,health}=fixture();
  let swings=0;
  k.fightNow=async()=>{swings++;health.value=20;return {fought:true,landed_hits:1};};
  k.takeRecoverySpot=async()=>{calls.push({what:'refuge'});return {took:true};};
  await k.continueSurvivalDecision();
  assert.equal(swings,1);
  assert.equal(calls.filter(x=>x.what==='refuge').length,1);
});

test('already hurt: try reachable recovery before a weak defensive swing',async()=>{
  const {k,calls,health}=fixture();health.value=8;
  k.takeRecoverySpot=async()=>{calls.push({what:'refuge'});return {took:true};};
  await k.continueSurvivalDecision();
  assert.equal(calls.some(x=>x.what==='fight'),false);
  assert.equal(calls.filter(x=>x.what==='refuge').length,1);
});

test('already hurt and refuge refused: one weak swing, with another survival assessment next pass',async()=>{
  const {k,calls,health}=fixture();health.value=8;
  await k.continueSurvivalDecision();
  assert.equal(calls.filter(x=>x.what==='refuge').length,1);
  assert.equal(calls.find(x=>x.what==='fight').opts.disengageAt,0);
});

test('ownership changing between swings ends the operation',async()=>{
  const {k}=fixture();let swings=0;
  k.fightNow=async()=>{swings++;k.externalOwner=true;return {fought:true,landed_hits:1};};
  await k.continueSurvivalDecision();
  assert.equal(swings,1);
});

test('movement cancellation during a swing prevents both another swing and a retreat',async()=>{
  const {k,s,calls}=fixture();let swings=0;
  s.movementWasCancelled=g=>g!==s.movementGeneration;
  k.fightNow=async()=>{swings++;s.movementGeneration++;return {fought:true,landed_hits:1};};
  await k.continueSurvivalDecision();
  assert.equal(swings,1);assert.equal(calls.some(x=>x.what==='refuge'),false);
});

test('strong blocker reaches flee line before retaliation: leave without waiting for aggro proof',async()=>{
  const {k,c,monster,health}=fixture();c.room.objects.clear();monster(2,'troll');
  let swings=0,retreated=0;
  k.planBlockerLure=()=>({spot:{row:35,col:26},filter:()=>true});
  k.fightNow=async()=>{swings++;health.value=15;return {fought:true,landed_hits:1,combat:[]};};
  k.takeSafeSpot=async()=>{retreated++;return {took:true};};
  await k.continueSurvivalDecision();
  assert.equal(swings,1);assert.equal(retreated,1);
});

test('equal-sized blocker takes the lure branch even when the farming band permits it',async()=>{
  const {k,health,calls}=fixture();health.max=50;health.value=50;
  let planned=0;k.planBlockerLure=()=>{planned++;return null;};
  await k.continueSurvivalDecision();
  assert.equal(planned,1);assert.equal(calls.some(x=>x.what==='fight'),false);
});

test('a blocker moving out of reach ends stationary combat without pursuit',async()=>{
  const {k,c}=fixture();let swings=0;
  k.fightNow=async()=>{swings++;c.room.objects.get(2).col=40;return {fought:true,landed_hits:1};};
  await k.continueSurvivalDecision();assert.equal(swings,1);
});

test('larger blocker is provoked until retaliation, then retreats to the prevalidated refuge',async()=>{
  const {k,c,monster}=fixture();c.room.objects.clear();monster(2,'troll');
  const spot={row:35,col:26};let swings=0,retreated=0;
  k.planBlockerLure=()=>({spot,filter:(col,row)=>col===26&&row===35});
  k.fightNow=async opts=>{
    assert.equal(opts.exactTargetId,2);assert.equal(opts.disengageAt,0.7);
    return {fought:true,landed_hits:1,combat:++swings===5?["You dodge the troll's attack."]:[]};
  };
  k.takeSafeSpot=async(why,quarry,opts)=>{
    retreated++;assert.equal(quarry,null);assert.equal(opts.recovery,true);
    assert.equal(opts.candidateFilter(26,35),true);
    assert.equal(opts.candidateFilter(32,35),false);
    return {took:true};
  };
  await k.continueSurvivalDecision();
  assert.equal(swings,5);assert.equal(retreated,1);
});

for (const reason of ['no refuge','duplicate name','already hurt']) {
  test('do not provoke a stronger blocker: '+reason,async()=>{
    const {k,c,monster,calls,health}=fixture();c.room.objects.clear();monster(2,'troll');
    k.planBlockerLure=()=>reason==='no refuge'?null:{spot:{row:35,col:26},filter:()=>true};
    if(reason==='duplicate name')monster(3,'troll',34);
    if(reason==='already hurt')health.value=8;
    await k.continueSurvivalDecision();
    assert.equal(calls.some(x=>x.what==='fight'),false);
  });
}

test('retaliation accepts hits and misses, rejects poison, wrong and ambiguous attackers',()=>{
  assert.equal(blockerRetaliated(['The troll wounds you with its attack.'],'troll',['troll']),true);
  assert.equal(blockerRetaliated(["You dodge the troll's attack."],'troll',['troll']),true);
  assert.equal(blockerRetaliated(['Fresh poison courses through your veins.'],'troll',['troll']),false);
  assert.equal(blockerRetaliated(['The ant wounds you with its attack.'],'troll',['troll','ant']),false);
  assert.equal(blockerRetaliated(["You dodge the troll's attack."],'troll',['troll','troll']),false);
});

test('lure refuge must be behind the jam and have broad connected monster staging',()=>{
  const geo={walkable:()=>true,openDirections:()=>[
    {dr:1,dc:0},{dr:-1,dc:0},{dr:0,dc:1},{dr:0,dc:-1}]};
  const reach=(col,row)=>({reachable:true,attack_position:{row,col:col+1}});
  const filter=lureRefugeFilter(geo,{row:35,col:32},{row:35,col:33},reach);
  assert.equal(filter(26,35),true);
  assert.equal(filter(38,35),false,'forward is not a retreat');
  assert.equal(filter(31,35),false,'still in the jam');
  geo.walkable=row=>row===35;
  assert.equal(filter(26,35),false,'one-cell needle');
  geo.walkable=()=>true;geo.openDirections=()=>[{dr:0,dc:1}];
  assert.equal(filter(26,35),false,'one-way pocket');
});

for(const reason of ['no wedge','wall','unarmed','unknown weapon','player','out of reach',
                     'strong target','unknown target','disabled','handoff','crowd veto','stopping']) {
  test('pending recovery does not add combat: '+reason,async()=>{
    const {k,c,calls,monster}=fixture();
    if(reason==='no wedge')k.wedgedInPlace=()=>null;
    if(reason==='wall')k.wall={row:35,col:32};
    if(reason==='unarmed')c.equipment=()=>({known:true,equipped:[]});
    if(reason==='unknown weapon')c.equipment=()=>({known:false});
    if(reason==='player'){c.room.objects.clear();monster(2,'spider',33,OF.ATTACKABLE|OF.PLAYER);}
    if(reason==='out of reach'){c.room.objects.clear();monster(2,'spider',45);}
    if(reason==='strong target')k.refuseEngagement=()=>({why:'above engagement ceiling'});
    if(reason==='unknown target'){c.room.objects.clear();monster(2,'unknown test creature');}
    if(reason==='disabled')k.policy.tradeInPlaceWhenWedged=false;
    if(reason==='handoff')k.externalOwner=true;
    if(reason==='crowd veto'){k.policy.tradeInPlaceWhenCrowded=false;k.noteCrowdRefusal=()=>{};}
    if(reason==='stopping')k.stopping=true;
    await k.continueSurvivalDecision();
    assert.equal(calls.some(x=>x.what==='fight'),false);
  });
}

test('select an allowed weak monster even when a refused target is closer',async()=>{
  const {k,c,calls,monster}=fixture();
  monster(3,'unknown dangerous monster',32);
  await k.continueSurvivalDecision();
  assert.deepEqual(calls.filter(x=>x.what==='fight').map(x=>x.id),[2]);
  assert.ok(c.room.objects.has(3));
});
