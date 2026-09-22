// Offline: real pending-decision dispatcher and stationary-fight rung, no sockets.
import assert from 'node:assert/strict';
import {test} from 'node:test';
const {Autopilot}=await import(process.env.M59_TEST_AUTOPILOT || './m59-autopilot.mjs');
import {OF} from './m59-parse.mjs';
import {attachSurvivalDecisions,chooseSurvivalDecision,currentSurvivalDecision}
  from './m59-survival-decision.mjs';

function fixture() {
  const calls=[], health={value:8,max:55};
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
    threatCountHere:()=>8,note:(what,data)=>calls.push({what,data}),progress:()=>{},
    protectedItemNames:()=>[],carryFloors:()=>({}),unreachableIn:()=>new Set(),
    takeRecoverySpot:async()=>{calls.push({what:'refuge'});return {took:false};},
    playDead:async()=>{calls.push({what:'wall'});return true;},
    fightInPlace:async(target)=>{calls.push({what:'fight',id:target.id});
      c.room.objects.delete(target.id);return {killed:true};}});
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

test('a retry delay permits one bounded blocker bout without starting another walk',async()=>{
  const {k,calls,decision}=fixture();decision.retry_at=Date.now()+60000;
  await k.continueSurvivalDecision();
  assert.equal(calls.filter(x=>x.what==='fight').length,1);
  assert.equal(calls.some(x=>x.what==='refuge'),false);
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
