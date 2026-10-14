import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
const confirm=Session.prototype.confirmFinePosition;
const pose={x:640,y:4440,row:69,col:10,predicted:false};
const client=()=>({state:'game',room:{id:2815},self:{...pose}});
let release;
const c=client(),s={client:c,confirmPosition:({timeoutMs})=>{assert.equal(timeoutMs,3000);return new Promise(r=>{release=r;});}};
let done=false;const waiting=confirm.call(s).then(r=>{done=true;return r;});
await Promise.resolve();assert.equal(done,false);release({row:69,col:10});
const observed=await waiting;assert.equal(observed.x,640);assert.equal(observed.y,4440);assert.equal(observed.room_object_id,2815);
assert.equal(s.refugePosition.x,640,'only the confirmed read records refuge progress');
for(const change of ['room','client','predicted','disconnected','timeout']){
 const c=client(),s={client:c,confirmPosition:async()=>{
  if(change==='room')c.room.id=6;
  if(change==='client')s.client=client();
  if(change==='predicted')c.self.predicted=true;
  if(change==='disconnected')c.state='closed';
  return change==='timeout'?null:{row:69,col:10};
 }};
 assert.equal(await confirm.call(s),null,change+' cannot certify this fine position');
 assert.equal(s.refugePosition,undefined,change+' cannot certify refuge progress');
}
console.log('Fine position waits for the server read and refuses room/client changes, predictions, disconnects and timeouts.');
