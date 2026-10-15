#!/usr/bin/env node
// Socketless real movement/collision, plus explicit range-only attack replies.
// No broker, keeper process, server, combat damage or claim of native survival.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
const entry=JSON.parse(fs.readFileSync(new URL('./fixtures/cragged-combat-approach.json',import.meta.url)));
const h=await bastionHarness(),{fight}=await h.imp('m59-skills.mjs'),{Autopilot}=await h.imp('m59-autopilot.mjs');
const {planBodyDetour}=await h.imp('m59-body-detour.mjs');

function fixture({captured=true}={}){
  const f=h.fixture(entry,{bodies:captured,maxPackets:384,maxMs:60000});
  if(!captured)f.c.room.objects.set(10,{id:10,flags:9,row:30,col:36,x:2336,y:1952,name:'troll'});
  for(const b of f.c.room.objects.values())if(b.id!==1){b.nameRsc=b.id;f.c.rsc.set(b.id,b.name??'troll');}
  f.c.stats=()=>{};f.c.equipment=()=>({equipped:[]});
  const swings=[];f.s.attackRounds=async id=>{
    const me=f.c.self,foe=f.c.room.objects.get(id),distance=Math.hypot(me.row-foe.row,me.col-foe.col);
    swings.push({distance,position:{...me}});
    return {messages:[distance<=2?'You hit the troll.':'The troll is too far away.'],vitals:f.c.vitals()};
  };
  return {...f,swings};
}

test('Cragged blocked coarse approach returns confirmed position and bodies without grinding or swinging',async()=>{
  const f=fixture(),coarse=f.s.world.approachSquare(33,35);
  assert.deepEqual({row:coarse.row,col:coarse.col},{row:34,col:34});
  const r=await fight(f.s,{target:'troll',exactTargetId:entry.target_id,reach:2,equip:false,loot:false});
  assert.equal(r.fought,false);assert.equal(r.reason,'combat_approach_blocked');assert.equal(r.approach_blocked,true);
  assert.deepEqual(r.position,{row:33,col:34,x:2224,y:2170});assert.ok(r.blockers.some(b=>b.id===entry.target_id));
  assert.equal(f.packets.length,0);assert.equal(f.swings.length,0);assert.equal(f.c.self.predicted,false);
});

test('one fine pour accepts a reachable melee square when the adjacent stand point is blocked',()=>{
  const f=fixture({captured:false}),geo=f.s.world.geometry;
  const p=planBodyDetour(geo,f.c.self,{x:2208,y:2208},{goalSquares:[{row:34,col:34},{row:32,col:36}],
    objects:f.c.room.objects,selfId:1,maxNodes:3000,maxMs:200});
  assert.equal(p.found,true,JSON.stringify(p));
  const end=p.waypoints.at(-1);assert.equal(Math.floor(end.y/64),32);assert.equal(Math.floor(end.x/64),36);
});

test('a reachable local target is approached under real collision checks and then hit',async()=>{
  const f=fixture({captured:false});
  const r=await fight(f.s,{target:'troll',exactTargetId:10,reach:2,equip:false,loot:false});
  assert.equal(r.fought,true,JSON.stringify(r));assert.equal(r.landed_hits,3);
  assert.ok(f.packets.length>0&&f.packets.length<16);assert.equal(f.c.self.predicted,false);
  assert.ok(f.swings.every(x=>x.distance<=2));
});

test('blocked combat choices rotate briefly, retain threat, and retry a moved quarry or immediate melee contact',async()=>{
  const f=fixture(),notes=[],ap=Object.assign(Object.create(Autopilot.prototype),{s:f.s,policy:{},foeId:entry.target_id,note:(what,detail)=>notes.push({what,detail})});
  const foe=f.c.room.objects.get(entry.target_id),r=await fight(f.s,{target:'troll',exactTargetId:foe.id,reach:2,equip:false,loot:false});
  assert.equal(ap.deferBlockedCombatApproach(r),true);assert.equal(ap.foeId,null);
  assert.equal(ap.combatApproachCooling(598,foe),true);assert.equal(ap.unreachablePreySpots,undefined);
  assert.ok(ap.inReachOfUs().some(o=>o.id===foe.id),'cooldown never removes a monster from threat');
  const previous={...f.c.self};Object.assign(f.c.self,{row:33,col:33,x:2144,y:2144});
  assert.equal(ap.combatApproachCooling(598,foe),false,'a target we can now hit remains urgent');
  Object.assign(f.c.self,previous);foe.x++;
  assert.equal(ap.pullTargetCooling(598,foe.id),null,'even one fine unit of quarry movement reopens planning');
  ap.deferBlockedCombatApproach(r);const record=ap.pullTargetCooling(598,foe.id);
  assert.equal(ap.pullTargetCooling(598,foe.id,record.until+1),null);
  assert.equal(notes.length,2);
});

test('coarse square rejection cannot veto a collision-proved fine melee position',async()=>{
  const f=fixture({captured:false}),geo=f.s.world.geometry,walkable=geo.walkable;
  try{
    geo.walkable=()=>false;
    const r=await f.s.walkToMeleeRange(10,{reach:2});
    assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(f.c.self.predicted,false);
    const foe=f.c.room.objects.get(10);assert.ok(Math.hypot(foe.row-f.c.self.row,foe.col-f.c.self.col)<=2);
  }finally{geo.walkable=walkable;}
});

for(const change of ['generation','token','room','body','quarry'])test(`paced ${change} changes revoke the combat approach before its first packet`,async()=>{
  const f=fixture({captured:false}),submit=f.s.pacer.submit;
  f.s.pacer.submit=async(kind,run)=>{
    if(kind==='move'){
      if(change==='generation')f.s.movementGeneration++;
      if(change==='token')f.s.cancelledMovementTokens.add('flight');
      if(change==='room')f.c.room.id++;
      if(change==='body')f.c.room.objects.set(20,{id:20,flags:9,x:2256,y:2128,row:33,col:35});
      if(change==='quarry')f.c.room.objects.get(10).row--;
    }
    return submit(kind,run);
  };
  const r=await f.s.walkToMeleeRange(10,{reach:2,controlToken:'flight'});
  assert.equal(r.arrived,false,JSON.stringify(r));assert.equal(f.packets.length,0);
});

for(const reason of ['movement_deviation','room_changed_before_move','own_position_unknown','cancelled'])test(`legacy combat fallback preserves ${reason} and sends no further move or attack`,async()=>{
  const f=fixture({captured:false}),calls=[];
  f.s.walkToMeleeRange=undefined;
  f.s.world.approachSquare=()=>({row:31,col:36,steps:3});
  const deviation={confirmed:true,position:{row:33,col:34,x:2224,y:2170},blockers:{objects:[{id:10}]}};
  f.s.walkTo=async(_col,_row,opts)=>{calls.push(opts);return {arrived:false,reason,deviation,...(reason==='cancelled'?{cancelled:true}:{})};};
  f.s.walkFine=async()=>{throw Error('must not fall through to fine movement');};
  const r=await fight(f.s,{target:'troll',exactTargetId:10,reach:2,equip:false,loot:false,controlToken:'flight'});
  assert.equal(r.fought,false);assert.equal(r.reason,reason);assert.deepEqual(r.deviation,deviation);
  assert.equal(calls.length,1);assert.equal(calls[0].controlToken,'flight');assert.equal(calls[0].movementGeneration,0);
  assert.equal(f.swings.length,0);
});

test('an unconfirmed body cannot plan a combat approach',async()=>{
  const f=fixture({captured:false});f.c.self.predicted=true;f.s.confirmPosition=async()=>null;
  const r=await f.s.walkToMeleeRange(10,{reach:2});assert.equal(r.reason,'own_position_unknown');assert.equal(f.packets.length,0);
});

test('the keeper reports stopped approaches before swing accounting and does not mistake misses for blocked paths',()=>{
  const f=fixture(),notes=[],stalls=[],ap=Object.assign(Object.create(Autopilot.prototype),{s:f.s,policy:{},swungAt:123,
    note:(...args)=>notes.push(args),noProgress:reason=>stalls.push(reason)});
  const failure={fought:false,reason:'movement_deviation',deviation:{confirmed:true,position:entry.from}};
  assert.equal(ap.finishFailedCombatApproach(failure),true);assert.equal(ap.swungAt,123);
  assert.equal(ap.pullTargetCooldowns,undefined);assert.equal(stalls.length,1);assert.equal(notes[0][1].deviation,failure.deviation);
  assert.equal(ap.finishFailedCombatApproach({fought:true,landed_hits:0}),false);
  assert.equal(ap.finishFailedCombatApproach({fought:false,cancelled:true,reason:'cancelled'}),true);
  assert.equal(ap.pullTargetCooldowns,undefined,'ownership cancellation must not blacklist prey');
});

test('hold-position combat retains its wall and never calls the approach planner',async()=>{
  const f=fixture();f.s.walkToMeleeRange=async()=>{throw Error('must retain held position');};
  const r=await fight(f.s,{target:'troll',exactTargetId:entry.target_id,reach:2,holdPosition:true,equip:false,loot:false});
  assert.equal(r.out_of_reach,true);assert.equal(f.packets.length,0);
});

test('the captured farming pocket still reaches Castle Victoria with frozen bodies under Bastion routing',async()=>{
  const f=fixture(),r=await f.s.travel(38,{maxHops:16,maxStumbles:2});
  assert.equal(r.arrived,true,JSON.stringify(r));assert.equal(f.s.world.room.num,38);
  assert.equal(f.c.self.predicted,false);assert.ok(f.packets.length<384);
});
