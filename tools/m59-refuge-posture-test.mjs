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
await test('an unanswered confirmation cannot turn a predicted match into arrival',async()=>{
 const {s,c,calls}=fixture();c.self.predicted=true;
 s.confirmPosition=async()=>null;
 const r=await returnToSpot(s,{row:c.self.row,col:c.self.col});
 assert.equal(r.arrived,false);assert.equal(r.unconfirmed,true);
 assert.deepEqual(calls,[],'no stand or movement while the position read is unanswered');
});
await test('an older reply clearing prediction cannot substitute for the requested confirmation',async()=>{
 const {s,c,calls}=fixture();c.self.predicted=true;
 s.confirmPosition=async()=>{c.self.predicted=false;return null;};
 const r=await returnToSpot(s,{row:c.self.row,col:c.self.col});
 assert.equal(r.arrived,false);assert.equal(r.unconfirmed,true);
 assert.deepEqual(calls,[]);
});
await test('a predicted arrival after movement still requires confirmation',async()=>{
 const {s,c}=fixture();s.approachFine=async(col,row)=>{
  Object.assign(c.self,{row,col,predicted:true});return {arrived:true};
 };
 s.confirmPosition=async()=>null;
 const r=await returnToSpot(s,{row:8,col:18});
 assert.equal(r.arrived,false);assert.equal(r.unconfirmed,true);
});
await test('cancellation during confirmation keeps its ownership result',async()=>{
 const {s,c,calls}=fixture();c.self.predicted=true;
 s.confirmPosition=async()=>{s.movementGeneration++;return null;};
 const r=await returnToSpot(s,{row:8,col:18});
 assert.equal(r.cancelled,true);assert.deepEqual(calls,[]);
});
await test('losing the client during confirmation cancels arrival on the old connection',async()=>{
 const {s,c,calls}=fixture();c.self.predicted=true;
 s.confirmPosition=async()=>{s.client=null;c.self.predicted=false;return {row:8,col:16};};
 const r=await returnToSpot(s,{row:8,col:16});
 assert.equal(r.cancelled,true);assert.deepEqual(calls,[]);
});
await test('ordinary failed fine approach can use coarse fallback after one stand',async()=>{
 const {s,calls}=fixture();s.approachFine=async()=>{calls.push('blocked');return {arrived:false};};
 assert.equal((await returnToSpot(s,{row:8,col:18})).arrived,true);
 assert.deepEqual(calls,['stand','blocked','square']);
});
await test('monster cover routes around occupied squares before the nearby fine fan',async()=>{
 const {s,calls}=fixture(),walk=s.walkTo,avoidSquares=new Set(['8,17']);
 s.walkTo=async(col,row,options)=>{assert.equal(options.avoidSquares,avoidSquares);return walk(col,row);};
 const r=await returnToSpot(s,{row:5,col:17},{routeFirst:true,avoidSquares});
 assert.equal(r.arrived,true);assert.deepEqual(calls,['stand','square']);
});
await test('routed monster cover retains the fine fallback for a wall pocket',async()=>{
 const {s,calls}=fixture();s.walkTo=async()=>{calls.push('blocked');return {arrived:false};};
 assert.equal((await returnToSpot(s,{row:5,col:17},{routeFirst:true})).arrived,true);
 assert.deepEqual(calls,['stand','blocked','fine']);
});
await test('cancelled monster cover cannot start its fine fallback',async()=>{
 const {s,calls}=fixture();s.walkTo=async()=>{calls.push('cancelled');s.movementGeneration++;return {arrived:false};};
 const r=await returnToSpot(s,{row:5,col:17},{routeFirst:true});
 assert.equal(r.cancelled,true);assert.deepEqual(calls,['stand','cancelled']);
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
