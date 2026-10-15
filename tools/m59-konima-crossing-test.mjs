import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {traceFallMotion} from './m59-falltrace.mjs';
import {protocolToClient,clientToProtocol} from './m59-finepos.mjs';
import {followDeclaredCrossing} from './m59-declared-crossing.mjs';
const geo=roomGeometry(2505),jumps=fallJumpsIn(2505),out=jumps.find(j=>j.from.col===60);
assert.equal(jumps.length,4);
for(const j of jumps)for(const dt of [8,16,33,50]){
 const t=traceFallMotion(geo,j.from_fine.x,j.from_fine.y,j.to_fine.x,j.to_fine.y,{dt,recordFrames:true});
 assert(t.arrived,JSON.stringify({from:j.from,to:j.to,dt,reason:t.reason}));
 assert(t.fall_motion.frames.every(f=>f.floor-f.z<=384));
}
const gutter={x:3808,y:2144},stage={x:3072,y:1768},clear={x:4800,y:1512};
function fixture(start=clientToProtocol(out.from_fine),mode='land'){
 let you={...start},calls=0;const walks=[];
 const read=async()=>({room:{num:2505},you:{...you},hp:{value:20,max:20},vigor:{value:200}});
 const ctx={fleet:'fixture',agent:'a',call:async(tool)=>{assert.equal(tool,'jump');calls++;you=mode==='miss'?{x:4064,y:1696}:clientToProtocol(out.to_fine);return {jumped:true};}};
 const walk=async p=>{walks.push({...p});you={...p};};
 return {ctx,read,walk,walks,get calls(){return calls;}};
}
{
 const f=fixture();const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.crossed);assert.equal(f.calls,1);assert.deepEqual(f.walks.at(-1),clear);
}
{
 const f=fixture(undefined,'miss');const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter&&!r.crossed);assert.equal(f.calls,1);assert.deepEqual(f.walks.at(-1),gutter);
 assert.equal(f.walks.filter(p=>p.x===3872&&p.y===1760).length,1,'no retry from a missed lower floor');
}
{
 const f=fixture({x:4064,y:1696});const r=await followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter);assert.equal(f.calls,0);assert.deepEqual(f.walks,[gutter]);
}
{
 const f=fixture();f.read=async()=>{throw Error('operator cancelled');};
 await assert.rejects(followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear}),/operator cancelled/);
 assert.equal(f.calls,0);assert.equal(f.walks.length,0);
}
{
 let active=0,peak=0;const fs=[fixture(),fixture()];
 for(const f of fs){const old=f.ctx.call;f.ctx.call=async(...args)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));const reply=await old(...args);active--;return reply;};}
 await Promise.all(fs.map(f=>followDeclaredCrossing(f.ctx,out,{geo,read:f.read,walk:f.walk,gutter,stage,clear})));
 assert.equal(peak,1,'takeoff through cleared landing admits one crossing at a time');
}
console.log('Konima directional jumps retain stock gravity, confirm the landing shelf, admit one crossing, and send misses south without retrying from below.');
{
 const declaration=jumps.find(j=>j.from.col===64),f=fixture(clientToProtocol(declaration.from_fine));
 let body=clientToProtocol(declaration.from_fine),calls=0;
 f.read=async()=>({room:{num:2505},you:body,hp:{value:20,max:20},vigor:{value:200}});
 f.walk=async p=>{body={...p};};
 f.ctx.call=async()=>{calls++;body={x:4064,y:1696};return {jumped:true};};
 const r=await followDeclaredCrossing(f.ctx,declaration,{geo,read:f.read,walk:f.walk,gutter,stage,clear});
 assert(r.gutter&&!r.crossed);assert.equal(calls,1);assert.deepEqual(body,gutter,'a missed landing can be higher than the intended low refuge and still requires the gutter');
}
