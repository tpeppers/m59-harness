import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
function fixture(){
  let joins=0,drops=0;
  const session=Object.create(Session.prototype),client=()=>({sock:{destroy:()=>{drops++;}}});
  Object.assign(session,{name:'offline-rejoin-fixture',credentials:{character:'Fixture'},client:client()});
  Object.defineProperty(session,'live',{value:false});
  session.join=async credentials=>{joins++;await new Promise(r=>setTimeout(r,10));session.client=client();return {credentials,attempt:joins};};
  return {session,joins:()=>joins,drops:()=>drops};
}
{
  const f=fixture(),a=f.session.rejoin('survival'),b=f.session.rejoin('controller');
  const [x,y]=await Promise.all([a,b]);
  assert.equal(x,y,'both requesters observe the same completed login');
  assert.equal(f.joins(),1);assert.equal(f.drops(),1);assert.equal(f.session.rejoinTask,null);
  await f.session.rejoin('later dropout');assert.equal(f.joins(),2);assert.equal(f.drops(),2);
}
{
  const f=fixture();let calls=0;f.session.join=async()=>{if(++calls===1)throw Error('fixture login refused');return {ok:true};};
  const results=await Promise.allSettled([f.session.rejoin('survival'),f.session.rejoin('controller')]);
  assert(results.every(r=>r.status==='rejected'&&r.reason.message==='fixture login refused'));
  assert.equal(calls,1);assert.equal(f.session.rejoinTask,null);
  assert.equal((await f.session.rejoin('retry')).ok,true);assert.equal(calls,2);
}
console.log('Session rejoin: concurrent requests share one connection, and success or failure releases the next attempt.');
