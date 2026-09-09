import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Session} from './m59-game.mjs';
import {inventorySalePlan} from './m59-skills.mjs';
import {setIntent} from './m59-inventory-intent.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-sale-race-test-')),old=process.env.M59_INVENTORY_INTENT_DIR;
process.env.M59_INVENTORY_INTENT_DIR=dir;
const identity={server:'fixture.invalid:5959',account:'fixture',character:'Fixture',player_id:17};
try {
  const c={me:{id:17,name:'Fixture'},inventory:[{id:31,nameRsc:1,amount:2},{id:32,nameRsc:2,amount:1}],
    rsc:new Map([[1,'herb'],[2,'loaf of bread']]),using:new Set(),statsById:new Map(),evSeq:0,
    eventsSince:()=>[],trade:{theirs:[{amount:10}]}};
  let accepted=0,cancelled=0;
  c.offer=()=>{};c.cancelOffer=()=>cancelled++;c.acceptOffer=()=>accepted++;
  const s={name:'fixture',client:c,credentials:{host:'fixture.invalid',port:5959,account:'fixture'},
    need:()=>c,pacer:{submit:async(kind,fn)=>fn()}};
  const plan=inventorySalePlan(s);
  assert.equal(plan.items.find(i=>i.id===32).role,'food');
  c.waitFor=async()=>{
    // The operator veto arrives AFTER the offer, while waiting for its quote.
    setIntent(identity,{id:31,name:'herb'},{dir,state:'keep'});
    return {events:[{kind:'countered'}]};
  };
  const result=await Session.prototype.sellOne.call(s,99,{id:31,amount:2},true);
  assert.equal(result.sold,false);assert.match(result.note,/veto/);assert.equal(accepted,0);assert.equal(cancelled,1);
  setIntent(identity,{id:31,name:'herb'},{dir,state:'sell'});
  c.waitFor=async()=>{c.rsc.set(1,'different object');return {events:[{kind:'countered'}]};};
  const changed=await Session.prototype.sellOne.call(s,99,{id:31,amount:2},true);
  assert.equal(changed.sold,false);assert.match(changed.note,/changed/);assert.equal(accepted,0);assert.equal(cancelled,2);
  console.log('sale race tests passed: actual planner, late veto, item identity changed before accept; no game connection');
} finally {
  if(old===undefined)delete process.env.M59_INVENTORY_INTENT_DIR;else process.env.M59_INVENTORY_INTENT_DIR=old;
  rmSync(dir,{recursive:true,force:true});
}
