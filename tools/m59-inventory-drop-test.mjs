import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkedDrop,dropOnce,exactDrop,executeExactDrop} from './m59-inventory-drop.mjs';
import {setIntent} from './m59-inventory-intent.mjs';
const dir=mkdtempSync(join(tmpdir(),'m59-drop-test-'));
const now=Date.now(),identity={server:'fixture.invalid:5959',account:'fixture',character:'Fixture',player_id:17};
const item={id:31,name:'mushroom',amount:17,equipped:false};
const binding={fleet:'fixture',broker_pid:77};
try {
  setIntent(identity,item,{dir,state:'keep',revision:0});
  const plan={agent:'fixture',identity,room:39,at:now,revision:1,items:[item]};
  const body={...binding,agent:'fixture',player_id:17,character:'Fixture',revision:1,item_id:31,item_name:item.name,
    state:'drop',location:'pack',source:'operator',clicked_at:now,amount:4,expected_amount:17};
  const target=checkedDrop([plan],body,binding,{dir,now});
  for(const change of [{amount:0},{amount:-1},{amount:18},{amount:1.5},{amount:'1'},{expected_amount:16},
    {fleet:'other'},{broker_pid:78},{source:'ai'},{location:'vault'},{revision:0},{item_id:32},{item_name:'sword'},
    {player_id:18},{character:'Other'},{clicked_at:now-6001},{clicked_at:now+1001}])
    assert.throws(()=>checkedDrop([plan],{...body,...change},binding,{dir,now}));
  for(const change of [{paused:true},{at:now-6001},{room:0},{items:[]}])assert.throws(()=>checkedDrop([{...plan,...change}],body,binding,{dir,now}));
  const calls=[];let mode='confirmed';
  const rpc=async(name,args)=>{calls.push({name,args});if(name==='commander_lease')return args.action==='acquire'?{lease_token:'fixture-lease'}:{};
    if(mode==='timeout')throw Error('lost response');return {requested:true,confirmed:mode==='confirmed'};};
  const options={rpc,currentPlan:()=>plan,now:()=>now};
  assert.equal((await dropOnce(target,binding,options)).dropped,true);
  assert.deepEqual(calls.map(c=>c.name),['commander_lease','inventory_drop','commander_lease']);
  assert.equal(calls[1].args.amount,4);assert.equal(calls[1].args.expected_amount,17);assert.equal(calls[2].args.action,'release');
  for(mode of ['unconfirmed','timeout']){calls.length=0;assert.equal((await dropOnce(target,binding,options)).dropped,false);
    assert.equal(calls.filter(c=>c.name==='inventory_drop').length,1);assert.equal(calls.at(-1).args.action,'release');}
  calls.length=0;await assert.rejects(dropOnce(target,binding,{...options,currentPlan:()=>({...plan,items:[{...item,amount:16}]})}));
  assert.deepEqual(calls.map(c=>c.args.action),['acquire','release']);
  calls.length=0;await assert.rejects(dropOnce(target,binding,{...options,rpc:async()=>({})}));assert.equal(calls.length,0);

  const args={item:31,player_id:17,expected_item_name:'mushroom',expected_amount:17,amount:4,deadline_at:now+5000,control_token:'fixture-drop-1'};
  const make=()=>{const c={selfId:17,evSeq:10,rsc:new Map([[200,'mushroom']]),inventory:[{id:31,nameRsc:200,amount:17,tag:1,iconRsc:6}],packets:[]};
    c.drop=wire=>{c.packets.push(wire);};return c;};
  let c=make();assert.deepEqual(exactDrop(c,args,{now}).wire,{id:31,amount:4});
  c.inventory[0].amount=1;assert.deepEqual(exactDrop(c,{...args,expected_amount:1,amount:1},{now}).wire,{id:31,amount:1});
  c.inventory[0].amount=0;c.inventory[0].tag=0;assert.equal(exactDrop(c,{...args,expected_amount:1,amount:1},{now}).wire,31);
  for(const change of [{amount:0},{amount:18},{expected_amount:16},{player_id:19},{item:33},{deadline_at:now-1},{deadline_at:now+8000}]){
    c=make();assert.throws(()=>exactDrop(c,{...args,...change},{now}));assert.equal(c.packets.length,0);}
  for(const mutation of [x=>x.inventory=[],x=>x.inventory[0].amount--,x=>x.inventory[0].nameRsc=201,x=>x.selfId=18,x=>x.inventory[0].iconRsc=7]){
    c=make();const session={pacer:{submit:async(_,fn)=>{mutation(c);return fn();}}};
    await assert.rejects(executeExactDrop(session,args,{authority:()=>c,now:()=>now}));assert.equal(c.packets.length,0);
  }
  c=make();let clock=now;const delayed={pacer:{submit:async(_,fn)=>{clock=now+6000;return fn();}}};
  await assert.rejects(executeExactDrop(delayed,args,{authority:()=>c,now:()=>clock}));assert.equal(c.packets.length,0);
  c=make();let allowed=true;const lost={pacer:{submit:async(_,fn)=>{allowed=false;return fn();}}};
  await assert.rejects(executeExactDrop(lost,args,{authority:()=>{if(!allowed)throw Error('lease lost');return c;},now:()=>now}));assert.equal(c.packets.length,0);
  c=make();const session={pacer:{submit:async(_,fn)=>fn()}};
  const observed=await executeExactDrop(session,args,{authority:()=>c,now:()=>now,wait:async()=>{c.inventory[0].amount=13;}});
  assert.equal(observed.confirmed,true);assert.equal(c.packets.length,1);
  c.inventory[0].amount=17;await assert.rejects(executeExactDrop(session,args,{authority:()=>c,now:()=>now}));assert.equal(c.packets.length,1);
  c=make();const unconfirmed=await executeExactDrop({pacer:{submit:async(_,fn)=>fn()}},args,{authority:()=>c,now:()=>now,wait:async()=>{}});
  assert.equal(unconfirmed.confirmed,false);assert.equal(c.packets.length,1);
  c=make();await assert.rejects(executeExactDrop({job:{done:false}},args,{authority:()=>c,now:()=>now}));assert.equal(c.packets.length,0);
  c=make();const full=await executeExactDrop({pacer:{submit:async(_,fn)=>fn()}},{...args,amount:17},
    {authority:()=>c,now:()=>now,wait:async()=>{c.inventory=[];}});assert.equal(full.confirmed,true);
  c=make();let bound=true;const disconnected=await executeExactDrop({pacer:{submit:async(_,fn)=>fn()}},{...args,amount:17},
    {authority:()=>{if(!bound)throw Error('offline');return c;},now:()=>now,wait:async()=>{c.inventory=[];bound=false;}});assert.equal(disconnected.confirmed,false);
  const broker=readFileSync(new URL('./m59-broker.mjs',import.meta.url),'utf8'),keeper=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
  assert.match(broker,/name !== 'inventory_drop'/); // no automatic ID substitution
  assert.match(broker,/s\.rtsIntent\('inventory_drop'/);assert.match(keeper,/case 'rts_inventory_drop_intent'/);
  assert.match(keeper,/executeExactDrop\(session,args,\{authority:\(\)=>requireKeeperRtsAuthority\(args,'drop'\)\}\)/);
  console.log('Inventory drop tests passed: exact identity/count, partial/full/single stacks, confirmation expiry, human refusal, lease release, packet-time guards, no replay/retry, passive confirmation.');
}finally{rmSync(dir,{recursive:true,force:true});}
