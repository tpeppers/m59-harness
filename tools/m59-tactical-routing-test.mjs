// Exercise the production broker -> keeper switch -> real job boundary offline.
// Loading the broker module would open sockets; extract only the installed handlers.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {startTacticalJob,tacticalJobStatus} from './m59-tactical-job.mjs';
import {bindPacketScope} from './m59-packet-scope.mjs';
import {OF} from './m59-parse.mjs';
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const broker=read('m59-broker.mjs'),keeper=read('m59-keeper-process.mjs');
const begin=keeper.indexOf("case 'rts_tactical_intent':");
const end=keeper.indexOf("case 'rts_move_intent':",begin);
assert.ok(begin>keeper.indexOf("if (req.method === 'POST' && path === '/action')")&&end>begin);
assert.equal(keeper.indexOf("case 'rts_tactical_intent':",begin+1),-1);
const route=Function('name','args','session','autopilot','requireKeeperRtsAuthority','json',
  'startTacticalJob','tacticalJobStatus','credHost','credPort',
  'switch(name){'+keeper.slice(begin,end)+"default:throw Error('unrouted');}");
let owned=true,packets=0,endpointChecks=0,rosterChecks=0;
const c={selfId:101,self:{nameRsc:10,col:3,row:3},roomRsc:91,
  room:{id:200,security:93,objects:new Map()},
  rsc:{get:id=>({10:'Example',20:'Creature'})[id]},
  vitals:()=>({health:{value:100,max:100}}),
  attack:id=>{packets++;c.room.objects.delete(id);}};
const exit={kind:'edge',to:8,stand_on:{col:4.125,row:7.25},how:'walk',trigger:''};
const session={name:'unit1',client:c,need:()=>c,world:{room:{num:7},exits:()=>[exit]},
  movementWasCancelled:()=>false,
  pacer:{submit:async(kind,fn)=>{await Promise.resolve();return bindPacketScope(kind,fn)();}},
  standBeforeGo:async()=>{},faceToward:async()=>{},
  leaveVia:async()=>{await session.pacer.submit('move',()=>{packets++;c.room.id=201;session.world.room.num=8;});return {left:true};},
  startJob(kind,label,fn,opts){
    const job=this.job={kind,label,...opts,generation:0,startedAt:Date.now(),done:false};
    job.promise=fn(0).then(result=>{job.result=result;},e=>{job.error=e.message;}).finally(()=>{job.done=true;});
    return job;
  }};
const authority=(args)=>{
  assert.equal(args.commander_owner,'fixture-owner');
  assert.equal(args.room,7);assert.equal(args.room_object_id,200);
  if(!owned)throw Error('lease expired');return c;
};
function keeperAction(name,args){let result;
  route(name,args,session,{policy:{}},()=>authority(args),v=>{result=v;},
    startTacticalJob,tacticalJobStatus,'example.invalid',5959);return result;
}
class KeeperProxy {
  rtsIntent(kind,args){return keeperAction('rts_'+kind+'_intent',args);}
  tacticalStatus(args){return keeperAction('rts_tactical_status',args);}
}
const proxy=new KeeperProxy();
function brokerHandler(name){
  const from=broker.indexOf("name: '"+name+"'");assert.ok(from>0);
  const run=broker.indexOf('run: async (a, caller) => {',from);
  const to=broker.indexOf('\n    },',run);assert.ok(to>run);
  const body=broker.slice(run+'run: async (a, caller) => {'.length,to);
  return Function('session','KeeperProxy','requireControlSession','COMMANDER_FLEET','process',
    'exactRosterAuthority','requireRtsRoom','controlToken','requireRtsLocalCaller','requireControlEndpoint',
    'return async(a,caller)=>{'+body+'}')(a=>{assert.equal(a,'unit1');return proxy;},KeeperProxy,
    ()=>{endpointChecks++;if(!owned)throw Error('lease expired');return {lease:{record:{owner:'fixture-owner'}}};},
    'fixture',{pid:12},(_s,row)=>{rosterChecks++;assert.equal(row.character,'Example');},
    ()=>({room_object_id:c.room.id}),v=>v,caller=>assert.equal(caller.local,true),()=>{endpointChecks++;});
}
const start=brokerHandler('tactical_intent'),status=brokerHandler('tactical_status');
const base={agent:'unit1',order_id:'a'.repeat(32),control_token:'a'.repeat(32),lease_token:'fixture-capability',
  server_host:'example.invalid',server_port:5959,binding:{agent:'unit1',character:'Example',fleet:'fixture',
  broker_pid:12,player_id:101,room:7,room_resource_id:91,room_security_u32:93}};
for(const action of ['attack','exit']){
  c.room.id=200;session.world.room.num=7;
  c.room.objects.set(202,{id:202,nameRsc:20,flags:OF.ATTACKABLE,col:4,row:3});
  const args={...base,action,target:action==='attack'?{object_id:202,name:'Creature'}:
    {kind:'edge',destination_room:8,col:4.125,row:7.25,how:'walk',trigger:''}};
  const receipt=await start(args,{local:true});assert.equal(receipt.accepted,true);
  await session.job.promise;assert.equal(session.job.error,undefined);
  const checked={...base,started_at:receipt.started_at};
  assert.equal((await status(checked,{local:true})).state,'completed');
  await assert.rejects(status({...checked,started_at:receipt.started_at+1},{local:true}),/exact accepted/);
  await assert.rejects(status({...checked,server_host:'wrong.invalid'},{local:true}),/server mismatch/);
}
assert.equal(packets,2);assert.ok(endpointChecks>=2&&rosterChecks===2);
owned=false;
await assert.rejects(start({...base,action:'attack',target:{object_id:202,name:'Creature'}},{local:true}),/expired/);
assert.equal(packets,2,'lost authority does not reach a packet');
console.log('PASS actual broker/keeper routing: attack, exact exit, correlated status, endpoint and lease refusal; no sockets');
