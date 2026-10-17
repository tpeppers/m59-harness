import assert from 'node:assert/strict';
import{bastionHarness}from'./fixtures/bastion-fallback-client.mjs';
import{planQueuedRoomExit}from'./m59-queued-room-exit.mjs';
const h=await bastionHarness(),{preparedFineExitStage}=await h.imp('m59-session-walk.mjs'),{withBodyCommand}=await h.imp('m59-body-command.mjs');
for(const [room,to,x,y]of[[827,826,96,224],[827,826,96,238],[826,578,96,416]]){
 const f=h.fixture({from:{room,x,y}},{maxPackets:64,maxMs:15000}),body=f.c.self,exits=f.s.world.exits().filter(e=>e.to===to);
 const choice=exits.find(e=>e.fine_stand_on&&Math.hypot(e.fine_stand_on.x-x,e.fine_stand_on.y-y)<=16);
 assert(choice,'published crossing exists');assert(preparedFineExitStage(f.s.world.geometry,body,choice),'fine point is ready even when legacy coarse anchor differs');
 assert(!preparedFineExitStage(f.s.world.geometry,{...body,predicted:true},choice));assert(!preparedFineExitStage(f.s.world.geometry,{...body,row:body.row+1},choice));
 let coarse=0;f.s.walkTo=async()=>{coarse++;throw Error('redundant coarse restaging');};
 const result=await withBodyCommand(f.s,()=>f.s.leaveViaAny([choice],{exact:true}),'queued-room-exit-test');
 assert(result.left,JSON.stringify(result));assert.equal(f.s.world.room.num,to);assert.equal(coarse,0);console.log(`${room}->${to}: published fine opening crosses in ${f.packets.length} packets without coarse backtracking`);
}
for(const [room,to,x,y]of[[827,826,1470,765],[827,826,711,770],[826,578,2704,1272]]){
 const f=h.fixture({from:{room,x,y}},{maxPackets:600,maxMs:60000}),plan=planQueuedRoomExit({room:{num:room,object_id:f.c.room.id},you:f.c.self},to);
 assert(plan.found);assert(plan.leg.waypoints.length>0);console.log(`${room} return pose has ${plan.leg.waypoints.length} proved queue bends`);
}
