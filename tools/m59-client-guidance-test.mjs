import assert from 'node:assert/strict';
import {ClientGuidance,startGuidanceServer,validateTarget} from './m59-client-guidance.mjs';
let now=100000;
const target={fleet:'fixture',broker_pid:77,agent:'t22',character:'Fixture',player_id:23,client_pid:999,
  connection_id:'ab'.repeat(16),room_object:345,room_resource_id:456,room_security_u32:0xffffffff,room_generation:1};
let live={...target,control:'human',in_game:true,observed_at:now,inventory_revision:5,
  items:[{id:44,name:'sword',purpose:'vault'}]};
const channel=new ClientGuidance({resolveRecipient:()=>live,now:()=>now});
const make=(n,body={kind:'move',row:12,col:34})=>({schema:'m59-client-guidance/1',
  request_id:n.toString(16).padStart(32,'0'),clicked_at:now,target:{...target},instruction:body});
assert.equal(validateTarget(target),target);
const first=channel.suggest(make(1));
assert.equal(first.executed,false);assert.equal(first.sequence,1);
assert.equal(channel.suggest(make(1)).duplicate,true);
assert.throws(()=>channel.suggest(make(1,{kind:'move',row:15,col:34})),/reused/);
assert.deepEqual(channel.inbox(target).messages[0].instruction,{kind:'move',row:12,col:34});
const returned=channel.inbox(target);returned.messages[0].instruction.row=999;
assert.equal(channel.inbox(target).messages[0].instruction.row,12);
assert.throws(()=>channel.suggest(make(2,{kind:'execute',command:'arbitrary'})),/unsupported/);
assert.throws(()=>channel.suggest(make(2,{kind:'move',row:1,col:1,execute:true})),/unsupported/);
assert.throws(()=>channel.suggest({...make(2),clicked_at:now-6001}),/expired/);
assert.throws(()=>channel.suggest(make(2,{kind:'move',row:0,col:1})),/destination/);
assert.throws(()=>channel.suggest(make(2,{kind:'move',row:1.5,col:1})),/destination/);
assert.throws(()=>channel.suggest({...make(2),target:{...target,character:'Other'}}),/recipient/);
assert.throws(()=>channel.suggest({...make(2),target:{...target,room_security_u32:22}}),/recipient/);
live.room_generation=2;assert.throws(()=>channel.inbox(target),/recipient/);live.room_generation=1;
assert.throws(()=>channel.suggest(make(2,{kind:'item-intent',item_id:44,item_name:'sword',purpose:'sell',revision:5})),/metadata/);
assert.equal(channel.suggest(make(2,{kind:'item-intent',item_id:44,item_name:'sword',purpose:'vault',revision:5})).executed,false);
assert.equal(channel.feedback({target,sequence:1,status:'seen'}).status,'seen');
assert.equal(channel.feedback({target,sequence:1,status:'dismissed'}).status,'dismissed');
assert.equal(channel.feedback({target,sequence:1,status:'seen'}).status,'dismissed');
assert.throws(()=>channel.feedback({target,sequence:1,status:'execute'}),/feedback/);
live={...live,control:'bot'};assert.throws(()=>channel.inbox(target),/human/);
live={...live,control:'human',observed_at:now-6001};assert.throws(()=>channel.inbox(target),/current/);
live={...live,observed_at:now};channel.disconnect(target.connection_id);
assert.equal(channel.inbox(target).messages.length,0);
channel.suggest(make(3));now+=30001;live.observed_at=now;
assert.equal(channel.inbox(target).messages.length,0);
assert.throws(()=>channel.feedback({target,sequence:3,status:'seen'}),/expired/);
// Four suggestions/second, bounded queue, no unbounded fan-out.
for(let i=10;i<14;i++)channel.suggest(make(i));
assert.throws(()=>channel.suggest(make(14)),/rate/);
now+=1000;live.observed_at=now;
for(let i=14;i<26;i++){channel.suggest(make(i));now+=1000;live.observed_at=now;}
assert.throws(()=>channel.suggest(make(26)),/full/);
channel.disconnect(target.connection_id);
const clientToken='ed'.repeat(32);
const server=await startGuidanceServer({guidance:channel,
  clientTokenFor:id=>id===target.connection_id?clientToken:null});
const base='http://127.0.0.1:'+server.port;
const post=(path,body,token=server.operatorToken,extra={})=>fetch(base+path,{method:'POST',
  headers:{'content-type':'application/json','x-m59-guidance-token':token,...extra},body:JSON.stringify(body)});
try {
  const health=await fetch(base+'/health').then(r=>r.json());
  assert.equal(health.game_writes,false);assert.equal(JSON.stringify(health).includes(server.operatorToken),false);
  assert.equal((await post('/suggest',make(30),'wrong')).status,403);
  assert.equal((await post('/suggest',make(30),clientToken)).status,403);
  assert.equal((await post('/suggest',make(30),server.operatorToken,{origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await post('/move',make(30))).status,404);
  const accepted=await post('/suggest',make(30));assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).executed,false);
  assert.equal((await post('/inbox',target,server.operatorToken)).status,403);
  const inbox=await post('/inbox',target,clientToken);
  assert.equal(inbox.status,200);assert.equal((await inbox.json()).messages.length,1);
  assert.equal((await post('/suggest',{...make(31),padding:'x'.repeat(9000)})).status,413);
  const bad=await fetch(base+'/suggest',{method:'POST',headers:{'content-type':'application/json',
    'x-m59-guidance-token':server.operatorToken},body:Buffer.from([0xff])});assert.equal(bad.status,409);
  assert.equal((await post('/inbox',{...target,connection_id:'ef'.repeat(16)},clientToken)).status,403);
  live={...live,connection_id:'cd'.repeat(16)};
  assert.equal((await post('/inbox',target,clientToken)).status,409);
} finally {server.close();}
console.log('PASS client guidance: exact human/room binding, expiry, dedup, feedback, bounds and loopback capabilities; zero gameplay execution');
