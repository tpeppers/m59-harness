// Run the real broker/keeper handler bodies without importing the live broker.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exactDrop,executeExactDrop} from './m59-inventory-drop.mjs';
const broker=readFileSync(new URL('./m59-broker.mjs',import.meta.url),'utf8');
const keeper=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const start=keeper.indexOf("case 'rts_inventory_drop_intent':"),end=keeper.indexOf("case 'rts_context_intent':",start);
assert.ok(start>keeper.indexOf("if (req.method === 'POST' && path === '/action')")&&end>start);
const route=new AsyncFunction('name','args','session','requireKeeperRtsAuthority','json','executeExactDrop',
  'switch(name){'+keeper.slice(start,end)+"default:throw Error('missing route');}");
let owned=true,capability=1,posted=0,packets=0;
const c={selfId:17,evSeq:0,rsc:new Map([[200,'herb']]),inventory:[{id:31,nameRsc:200,amount:17}],
  drop:()=>{packets++;c.inventory[0].amount-=4;},waitFor:async()=>({events:[]})};
const session={pacer:{submit:async(_,fn)=>fn()}};
const authority=args=>{assert.equal(args.commander_owner,'fixture-owner');assert.equal(args.room_object_id,222);
  if(!owned)throw Error('lease lost');return c;};
const methodStart=broker.indexOf('  async rtsIntent(kind, args = {}) {');
const methodEnd=broker.indexOf('\n  async cancelRtsAction',methodStart);
const method=broker.slice(methodStart,methodEnd).trim();
const keeperAction=async(_name,_index,name,args,options)=>{
  try{options.beforeSend?.({inventory_drop:capability});posted++;let result;
    await route(name,args,session,authority,value=>{result=value;},executeExactDrop);return result;
  }catch(e){return {error:e.message};}
};
const KeeperProxy=Function('keeperAction','return class KeeperProxy {need(){return this.client;} '+method+'}')(keeperAction);
const proxy=new KeeperProxy();proxy.client=c;
const b=broker.indexOf("name: 'inventory_drop'"),run=broker.indexOf('run: async (a,caller)=>{',b),finish=broker.indexOf('\n    },',run);
const handler=Function('session','KeeperProxy','COMMANDER_FLEET','process','controlToken','requireControlSession','exactRosterAuthority',
  'requireRtsRoom','exactDrop','executeExactDrop','return async(a,caller)=>{'+broker.slice(run+'run: async (a,caller)=>{'.length,finish)+'}')(
  ()=>proxy,KeeperProxy,'fixture',{pid:77},x=>x,(_s,caller)=>{assert.equal(caller.local,true);if(!owned)throw Error('lease lost');return {lease:{record:{owner:'fixture-owner'}}};},
  (_s,row)=>assert.equal(row.character,'Fixture'),(_s,room)=>{assert.equal(room,39);return {room_object_id:222};},exactDrop,executeExactDrop);
const args={fleet:'fixture',broker_pid:77,agent:'t1',character:'Fixture',room:39,player_id:17,item:31,expected_item_name:'herb',
  expected_amount:17,amount:4,deadline_at:Date.now()+6000,control_token:'routing-drop-1',lease_token:'lease',server_host:'fixture.invalid',server_port:5959};
capability=0;await assert.rejects(handler(args,{local:true}),/does not support/);assert.equal(posted,0);assert.equal(packets,0);
capability=1;assert.equal((await handler(args,{local:true})).confirmed,true);assert.equal(posted,1);assert.equal(packets,1);
c.inventory[0].amount=17;await assert.rejects(handler(args,{local:true}),/consumed/);assert.equal(packets,1);
for(const change of [{fleet:'wrong'},{broker_pid:78},{player_id:18},{item:33},{expected_amount:18}])
  await assert.rejects(handler({...args,...change,control_token:'routing-drop-2'},{local:true}));
owned=false;await assert.rejects(handler({...args,control_token:'routing-drop-3'},{local:true}),/lease/);assert.equal(packets,1);
console.log('Drop routing tests passed: real broker/proxy/keeper handlers, per-keeper capability gate, identity refusal, one-shot packet and lease loss.');
