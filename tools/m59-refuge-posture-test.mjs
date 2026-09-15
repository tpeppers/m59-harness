// Offline. Exercise the real refuge entry and ordered Session stand helper.
import assert from 'node:assert/strict';
import {Session} from './m59-game.mjs';
import {returnToSpot} from './m59-skills.mjs';
function fixture({row=8,col=16,x=col*64+32,y=row*64+32}={}) {
 const calls=[],c={self:{row,col,x,y},seated:true,stand(){calls.push('stand');this.seated=false;}};
 const s=Object.assign(Object.create(Session.prototype),{client:c,movementGeneration:0,
  world:{room:{num:39}},need:()=>c,pacer:{submit:async(lane,fn)=>{assert.equal(lane,'rest');return fn();}}});
 const land=(method,col,row,options={})=>{
  assert.equal(c.seated,false,'server rejects movement while seated');calls.push(method);
  Object.assign(c.self,{row,col,x:options.toX??col*64+32,y:options.toY??row*64+32});return {arrived:true};
 };
 s.approachFine=async(col,row,options)=>land('fine',col,row,options);
 s.walkTo=async(col,row)=>land('square',col,row);
 s.walkFine=async(x,y)=>land('position',(x/64)|0,(y/64)|0,{toX:x,toY:y});
 return {s,c,calls};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
await test('a seated near-refuge approach stands before the first fine packet',async()=>{
 const {s,calls}=fixture();const r=await returnToSpot(s,{row:8,col:18});
 assert.equal(r.arrived,true);assert.deepEqual(calls,['stand','fine']);
});
await test('a seated distant approach stands before the coarse mover',async()=>{
 const {s,calls}=fixture({col:2});const r=await returnToSpot(s,{row:8,col:18});
 assert.equal(r.arrived,true);assert.deepEqual(calls,['stand','square']);
});
await test('fine-only adjustment inside the same square still needs stand',async()=>{
 const {s,calls}=fixture();const r=await returnToSpot(s,{row:8,col:16,x:1050,y:545},{tolerance:2});
 assert.equal(r.arrived,true);assert.deepEqual(calls,['stand','position']);
});
await test('already at the exact refuge leaves passive recovery untouched',async()=>{
 const {s,c,calls}=fixture();const r=await returnToSpot(s,{...c.self});
 assert.equal(r.already,true);assert.equal(c.seated,true);assert.deepEqual(calls,[]);
});
await test('ordinary failed fine approach can use coarse fallback after one stand',async()=>{
 const {s,calls}=fixture();s.approachFine=async()=>{calls.push('blocked');return {arrived:false};};
 assert.equal((await returnToSpot(s,{row:8,col:18})).arrived,true);
 assert.deepEqual(calls,['stand','blocked','square']);
});
await test('cancellation during queued stand prevents every movement packet',async()=>{
 const {s,calls}=fixture();s.pacer.submit=async(_lane,fn)=>{s.movementGeneration++;fn();};
 const r=await returnToSpot(s,{row:8,col:18});assert.equal(r.cancelled,true);assert.deepEqual(calls,[]);
});
await test('room transition during stand cannot continue toward the old refuge',async()=>{
 const {s,calls}=fixture();s.pacer.submit=async(_lane,fn)=>{s.world.room.num=1;fn();};
 const r=await returnToSpot(s,{row:8,col:18});assert.equal(r.cancelled,true);assert.deepEqual(calls,[]);
});
await test('failed stand does not fall through to movement',async()=>{
 const {s,calls}=fixture();s.pacer.submit=async()=>{throw Error('socket closed');};
 await assert.rejects(()=>returnToSpot(s,{row:8,col:18}),/socket closed/);assert.deepEqual(calls,[]);
});
console.log(`${count} refuge posture scenarios passed`);
