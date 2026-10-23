import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pullBowArrows,bowTrainingIntent} from './m59-bow-supply.mjs';
const dir=fs.mkdtempSync(join(tmpdir(),'m59-bow-supply-'));
try{
 assert(bowTrainingIntent({trainingWeapon:'practice bow'}));assert(bowTrainingIntent({}, {plan:{learning_target:'archery'}}));assert(!bowTrainingIntent({trainingWeapon:'hammer'}));
 assert(bowTrainingIntent({}, {plan:{learning_target:{track:'archery'}}}));
 const packs={archer:[],farmer:[{id:1,name:'silver arrows',amount:100},{id:2,name:'herb',amount:40},{id:3,name:'practice bow',amount:0}]};let offers=0;
 const status=agent=>({in_game:true,connected:true,room:{num:827},equipment_items:agent==='farmer'?[{id:3}]:[],autopilot_status:{policy:{},loadout_retention:{carry_floors:{'silver arrows':20,herb:20}}}});
 const call=async(name,a)=>{
  if(name==='inventory')return{items:structuredClone(packs[a.agent]),ids_as_of:{at:Date.now()}};
  if(name==='status')return status(a.agent);
  assert.equal(name,'supply');offers++;assert.equal(a.stationary,true);assert.equal(a.who_travels,'neither');
  for(const gift of a.what){const i=packs[a.from].find(i=>i.id===gift.id);i.amount-=gift.amount;packs[a.to].push({...i,amount:gift.amount});}
  return{supplied:true,amounts:a.what.map(i=>({asked:i.amount,giver_lost:i.amount,received:i.amount}))};
 };
 const ctx={agent:'archer',fleet:'fixture',call};
 const result=await pullBowArrows(ctx,{donors:['farmer'],target:80,stock:{herb:20,'practice bow':1},room:827,journal:join(dir,'confirmed.json')});
 assert.equal(result.arrows,80);assert.equal(packs.farmer.find(i=>i.id===1).amount,20);assert.equal(packs.farmer.find(i=>i.id===2).amount,20);assert(!packs.archer.some(i=>i.name==='practice bow'),'worn donor bow never moves');assert.equal(offers,1);
 packs.archer=[];packs.farmer.find(i=>i.id===1).amount=100;const ambiguous=join(dir,'unknown.json');const bad={...ctx,call:async(n,a)=>n==='supply'?(offers++,Promise.reject(Error('socket lost'))):call(n,a)};
 await assert.rejects(pullBowArrows(bad,{donors:['farmer'],target:160,journal:ambiguous}),/socket lost/);
 const before=offers;await assert.rejects(pullBowArrows(ctx,{donors:['farmer'],journal:ambiguous}),/unresolved/);assert.equal(offers,before);
 const absent=await pullBowArrows({...ctx,call:async(n,a)=>n==='status'?{...status(a.agent),room:{num:a.agent==='farmer'?826:827}}:call(n,a)},{donors:['farmer'],journal:join(dir,'away.json')});assert.equal(absent.received,0);assert.equal(offers,before);
 const stopped=await pullBowArrows({...ctx,shouldStop:()=>true},{donors:['farmer'],journal:join(dir,'stopped.json')});assert.equal(stopped.received,0);assert.equal(offers,before);
 const refused=join(dir,'notready.json');await pullBowArrows({...ctx,call:async(n,a)=>n==='supply'?{supplied:false,reason:'stationary body not ready: recovery'}:call(n,a)},{donors:['farmer'],journal:refused});assert.equal(JSON.parse(fs.readFileSync(refused)).phase,'unsubmitted');
 const unknownFloors=await pullBowArrows({...ctx,call:async(n,a)=>n==='status'?{...status(a.agent),autopilot_status:{policy:{}}}:call(n,a)},{donors:['farmer'],journal:join(dir,'floors.json')});assert.equal(unknownFloors.received,0);assert.equal(offers,before);
 const fast=await pullBowArrows({...ctx,readActor:async a=>({...status(a),room:{num:826}}),call:async(n,a)=>{assert.notEqual(n,'status','native read must avoid repeated game stats polls');return call(n,a);}},{donors:['farmer'],room:827,journal:join(dir,'native.json')});assert.equal(fast.received,0);
 await assert.rejects(pullBowArrows({...ctx,verifyActors:async()=>{throw Error('human-piloted');}},{donors:['farmer'],journal:join(dir,'pilot.json')}),/human-piloted/);assert.equal(offers,before);
 console.log('PASS stationary bow resupply preserves donor floors/worn kit, confirms actual gifts, ignores other rooms and never replays an ambiguous offer');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
