import { readToolSource } from './autopilot/source.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {bastionHarness} from './fixtures/bastion-fallback-client.mjs';
import {ensureBraxApproach} from './m59-brax.mjs';
import {railBoarding} from './m59-railfollow.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {walkCheckedRail} from './m59-rail-walk.mjs';
const h=await bastionHarness(),{withBodyCommand}=await h.imp('m59-body-command.mjs');
const route=JSON.parse(readToolSource(ensureBraxApproach())).stones[0].routes[0],legs=route.legs;
for(const agent of ['braxshadow01','braxshadow18']){
 const capture=JSON.parse(readToolSource(new URL('./fixtures/brax-crowded-rail-entry-'+agent+'.json',import.meta.url))),f=h.fixture({from:{room:579,x:capture.from.x,y:capture.from.y}},{maxPackets:400,maxMs:30000}),geo=f.s.world.geometry;
 const point=protocolToClient(f.c.self),floor=geo.floorBaseAtClient(point.x,point.y);
 const old=railBoarding(legs,point,{floor,within:1024,strictFloor:true});assert(old,'the captured FINAL failure position already joins the rail; approach must stop once that happens');
 const board=railBoarding(legs,point,{floor,within:1024,strictFloor:true,geo});assert(board,JSON.stringify({agent,floor}));assert.equal(board.leg,0);
 const proof=geo.traceFineMoveClient(point.x,point.y,board.entry.x,board.entry.y,{slide:false});assert(proof.arrived&&!proof.blocked);
 const result=await withBodyCommand(f.s,()=>walkCheckedRail(f.s,{room:579,leg:{kind:'walk',waypoints:[board.entry]}}),'offline-clipped-entry');assert(result.arrived,JSON.stringify(result));
 console.log(agent+': captured entry joins by an ordinary ground connection, '+f.packets.length+' validated packets');
 assert(!railBoarding(legs,point,{floor:floor-5000,within:1024,strictFloor:true,geo}),'a lower gully cannot board by proximity');
 const wall={...geo,floorBaseAtClient:geo.floorBaseAtClient.bind(geo),traceFineMoveClient:()=>({arrived:false,blocked:true})};
 assert(!railBoarding(legs,point,{floor,within:1024,strictFloor:true,geo:wall}),'even a nearby same-height rail needs a wall-clear connection');
}
const capture=JSON.parse(readToolSource(new URL('./fixtures/brax-temple-entry-579.json',import.meta.url))),f=h.fixture({from:{room:579,x:capture.from.x,y:capture.from.y}},{maxPackets:512,maxMs:30000});
for(const to of[589,579]){const r=await withBodyCommand(f.s,()=>f.s.leaveViaAny(f.s.world.exits().filter(e=>e.to===to)),'offline-temple-entry-road');assert(r.left,JSON.stringify(r));}
assert.equal(f.s.world.room.num,579);assert(f.c.self.col>70);assert.equal(f.crossings.length,2);console.log('Temple western arrival completes ordinary road to589 and reenters the eastern cliff approach:',f.packets.length,'packets');
const src=readToolSource(new URL('./m59-brax.mjs',import.meta.url),'utf8');assert(!src.includes('to:589,alsoStopAt:[579]'));assert(src.includes('s.room.num!==579||s.you.col<=2'));

// The approach must stop when a fresh confirmed body already joins the rail,
// even though its old exact head is occupied by another traveler.
{
 const {createServer}=await import('node:http'),{mkdtempSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const {checkedIslandWalk}=await import('./m59-island-finewalk.mjs');
 const capture=JSON.parse(readToolSource(new URL('./fixtures/brax-crowded-rail-entry-braxshadow01.json',import.meta.url))),geo=h.fixture({from:{room:579,x:capture.from.x,y:capture.from.y}}).s.world.geometry;
 const agent='entry-fixture',pose={...capture.from,row:Math.floor(capture.from.y/64),col:Math.floor(capture.from.x/64)},room={num:579,object_id:77};let actions=0;
 const server=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({agent,in_game:true,connected:true,room,you:pose,hp:{value:77,max:77},vigor:{value:150},objects:capture.objects,
  autopilot_status:{faculties:{movement:{owner:'fleetscript:entry-fixture',expires_in_ms:120000}}},position_read:{...pose,room_object_id:77,at:Date.now()}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const previous=process.env.M59_KEEPER_BAND_REGISTRY,directory=mkdtempSync(join(tmpdir(),'m59-entry-')),registry=join(directory,'bands.json');
 writeFileSync(registry,JSON.stringify({'entry-fixture':server.address().port-99}));process.env.M59_KEEPER_BAND_REGISTRY=registry;
 try{
  const ctx={agent,fleet:'entry-fixture',origin:{source:'fleetscript',name:'entry-fixture',run_id:'fixture'},state:{},call:async()=>{actions++;throw Error('joined body must not walk backward to the occupied head');}};
  const result=await checkedIslandWalk(ctx,capture.goal,{room:579,budgetMs:5000,stopWhen:state=>{const p=protocolToClient(state.you);return railBoarding(legs,p,{floor:geo.floorBaseAtClient(p.x,p.y),within:1024,strictFloor:true,geo});}});
  assert(result.ok&&result.connected);assert.equal(result.targetReached,false);assert.equal(actions,0);console.log('captured occupied head: approach hands the already joined body to the rail with zero backward movement');
 }finally{if(previous===undefined)delete process.env.M59_KEEPER_BAND_REGISTRY;else process.env.M59_KEEPER_BAND_REGISTRY=previous;await new Promise(r=>server.close(r));}
}
{
 const {Autopilot}=await h.imp('m59-autopilot.mjs');
 const posted={mode:'idle',policy:{assignedRoom:827,roomEnchant:{enabled:true,rooms:[38]}},s:{world:{room:{num:827}}},inert:false,suspendedJourney:null,busyStatus:()=>false,facultyHeld:()=>false};
 assert(Autopilot.prototype.isRoomEnchantPost.call(posted),'the accidental destination assignment starts an unrelated room-enchantment post');
 posted.policy.assignedRoom=null;assert(!Autopilot.prototype.isRoomEnchantPost.call(posted),'completing travel with no post leaves the original enchantment policy dormant');
 assert(src.includes("mode:'idle',assigned_room:null,roam:false,town_trips:false,farm_strategy:null"));
 console.log('arrival releases travel without converting the graveyard into the mule original room-enchantment post');
}
