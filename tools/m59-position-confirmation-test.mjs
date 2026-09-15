// Offline: real request numbering and Session confirmation, with delayed snapshots.
import assert from 'node:assert/strict';
import {M59Client} from './m59-client.mjs';
import {Session} from './m59-game.mjs';
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function fixture(requested,received){
 const c=Object.assign(Object.create(M59Client.prototype),{
  roomContentsRequested:requested,roomContentsReceived:received,evSeq:0,selfId:1,
  room:{objects:new Map([[1,{row:24,col:45,x:2897,y:1586}]])},send(){}});
 const s=Object.assign(Object.create(Session.prototype),{need:()=>c,pacer:{submit:async(_kind,fn)=>fn()}});
 return {c,s};
}
await test('unsolicited snapshots cannot satisfy a new position read',async()=>{
 const {c,s}=fixture(5,7);let waited=0;
 c.waitFor=async()=>{
  waited++;assert.equal(c.roomContentsRequested,8);
  c.roomContentsReceived=8;c.room.objects.set(1,{row:22,col:44,x:2863,y:1455});
  return {seq:1};
 };
 assert.deepEqual(await s.confirmPosition(),{row:22,col:44});assert.equal(waited,1);
});
await test('older outstanding replies still cannot satisfy the new read',async()=>{
 const {c,s}=fixture(5,4);let waited=0;
 c.waitFor=async()=>{waited++;c.roomContentsReceived++;return {seq:waited};};
 await s.confirmPosition();assert.equal(waited,2);assert.equal(c.roomContentsRequested,6);
});
await test('timeout after surplus snapshots reports unknown and the next read recovers',async()=>{
 const {c,s}=fixture(5,7);c.waitFor=async()=>({timedOut:true});
 assert.equal(await s.confirmPosition(),null);assert.equal(c.roomContentsLost,1);
 c.waitFor=async()=>{c.roomContentsReceived++;return {seq:1};};
 assert.deepEqual(await s.confirmPosition(),{row:24,col:45});assert.equal(c.roomContentsRequested,9);
});
await test('failed socket write does not consume a request ordinal',()=>{
 const {c}=fixture(5,7);c.send=()=>{throw Error('closed');};
 assert.throws(()=>c.roomContents(),/closed/);assert.equal(c.roomContentsRequested,5);
});
await test('posture telemetry records sent commands without calling them confirmed state',()=>{
 const {c}=fixture(0,0);const sent=[];c.userCommand=n=>sent.push(n);
 c.rest();assert.equal(c.lastPostureCommand.verb,'rest');
 c.stand();assert.equal(c.lastPostureCommand.verb,'stand');assert.equal(sent.length,2);
 c.userCommand=()=>{throw Error('closed');};
 assert.throws(()=>c.rest(),/closed/);assert.equal(c.lastPostureCommand.verb,'stand');
});
console.log(`${passed} position confirmation scenarios passed`);
