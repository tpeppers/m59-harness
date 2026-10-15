import assert from 'node:assert/strict';
import {entryTrafficCandidate,reversibleEntry,retreatAndRetryEntry} from './m59-entry-recovery.mjs';
import {OF,MOVEON} from './m59-parse.mjs';
const entry={room:2500,from:2501,position:{x:1760,y:96},maxHp:20};
const body={room:{num:2500},you:{id:1,x:1760,y:96},hp:{value:20,max:20},
 objects:[{id:2,x:1752,y:105,flags:OF.ATTACKABLE|MOVEON.NO}]};
const status={failed:'safe_legs_required',job:{ordered_by:'ours'}};
const map={rooms:{2500:{edgeExits:[{to:2501}]},2501:{edgeExits:[{to:2500}]}}};
assert(reversibleEntry(map,entry));
assert(!reversibleEntry({rooms:{2500:map.rooms[2500]}},entry));
const candidate=(b=body,s=status,e=entry)=>entryTrafficCandidate(e,b,s,27,{canReturn:reversibleEntry(map,e),orderedBy:'ours'});
assert(candidate());
for(const changed of [{...body,you:{...body.you,predicted:true}},
 {...body,you:{...body.you,x:2000}}, {...body,hp:{value:19,max:20}},
 {...body,hp:{value:19,max:19}}, {...body,objects:[]},
 {...body,objects:[{id:2,x:1752,y:105,flags:0}]}])assert(!candidate(changed));
for(const changed of [{...status,busy:true},{...status,movement:{order:{kind:'travel'}}},
 {...status,failed:'geometry_unavailable'},{...status,job:{ordered_by:'foreign'}}])assert(!candidate(body,changed));
assert(!entryTrafficCandidate(entry,body,status,entry.from,{canReturn:true}));
assert(!entryTrafficCandidate(entry,body,status,27,{canReturn:false}));
let time=0,room=2500,checks=0,reads=0;
const order=[];
const settings={entry,to:27,deadline:100000,now:()=>time,waitMs:30000,pollMs:1000,
 check:async()=>{checks++;},read:async()=>{reads++;return {room:{num:room},hp:{value:20,max:20}};},
 sleep:async ms=>{time+=ms;},
 hop:async(to,budget)=>{assert(budget>0);order.push(to);room=to;time+=1000;return {ok:true,end:{room:to}};}};
const passed=await retreatAndRetryEntry(settings);
assert(passed.ok);assert.deepEqual(order,[2501,2500,27]);assert.equal(reads,30);assert(checks>=33);
assert.equal(time,33000);assert.equal(passed.attempts.length,1);
const tight=await retreatAndRetryEntry({...settings,deadline:time+30000});
assert(!tight.ok);assert.equal(tight.reason,'entry_recovery_budget');assert.equal(tight.attempts.length,0);
await assert.rejects(retreatAndRetryEntry({...settings,deadline:time+100000,
 check:async()=>{throw Error('operator cancelled');}}),/operator cancelled/);
const failed=await retreatAndRetryEntry({...settings,deadline:time+100000,
 hop:async()=>({ok:false,reason:'body blocked',end:{room:2500}})});
assert.equal(failed.reason,'entry_retreat_failed');assert.equal(failed.attempts.length,1);
let tries=0;
const exhausted=await retreatAndRetryEntry({...settings,deadline:time+1000000,maxAttempts:2,
 hop:async to=>{tries++;return {ok:to!==27,reason:to===27?'entry_traffic_blocked':undefined,end:{room:to===27?2500:to}};}});
assert.equal(exhausted.reason,'entry_recovery_exhausted');assert.equal(tries,6);
const cancelledOrders=[];
await assert.rejects(retreatAndRetryEntry({...settings,deadline:time+100000,
 check:async()=>{if(cancelledOrders.length===2)throw Error('cancelled after reentry');},
 hop:async to=>{cancelledOrders.push(to);return {ok:true,end:{room:to}};}}),/cancelled after reentry/);
assert.deepEqual(cancelledOrders,[2501,2500],'cancellation after reentry sends no retry movement');
let budgetClock=0;const budgetOrders=[];
const atDeadline=await retreatAndRetryEntry({...settings,now:()=>budgetClock,deadline:1000,waitMs:0,
 check:async()=>{},hop:async to=>{budgetOrders.push(to);if(to===2500)budgetClock=1000;return {ok:true,end:{room:to}};}});
assert.equal(atDeadline.reason,'entry_recovery_budget');
assert.deepEqual(budgetOrders,[2501,2500],'an exhausted reentry deadline sends no retry movement');
console.log('Entry recovery retains confirmed healthy footing, a reversible border, body evidence, ownership, bounded ordinary retries and cancellation.');
