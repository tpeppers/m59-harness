import{coalesceCheckedRailLeg}from'./m59-rail-coalesce.mjs';
import{protocolToClient,clientToProtocol,squareCentreClient}from'./m59-finepos.mjs';
import{preparedFineExitStage}from'./m59-session-walk.mjs';
import{planBodyDetour,blockingBodySnapshot}from'./m59-body-detour.mjs';
import{loadMap,edgeCandidatesOf,roomExitSquares}from'./m59-map.mjs';
import{planQueuedEgress}from'./m59-rail-traffic.mjs';
import{roomGeometry}from'./m59-ground.mjs';
export function planQueuedRoomExit(state,to,{map=loadMap(),geometry=roomGeometry(state.room?.num),branch=null}={}){
 const room=map.rooms[state.room?.num],body=state.you;
 if(!room||!body||body.predicted)return {found:false,reason:'exit_body_unconfirmed'};
 // Consume already validated physical boundary tuples. World.exits() performs
 // origin flood fills for every destination; doing that here can starve leases.
 const candidates=room.edgeExits.filter(e=>e.to===to).flatMap(edge=>edgeCandidatesOf(room,edge).filter(c=>c.fine_stand_on).map(c=>({stand_on:{row:c.row,col:c.col},fine_stand_on:c.fine_stand_on,edge_target:c.edge_target})));
 for(const exit of room.goExits??[]){if(exit.to===to&&!exit.locked&&Number.isInteger(exit.row)&&Number.isInteger(exit.col)){candidates.push({kind:'go',stand_on:{row:exit.row,col:exit.col},fine_stand_on:clientToProtocol(squareCentreClient(exit.row,exit.col))});}}
 const candidatesTried=[];
 const selected=branch?candidates.filter(c=>c.stand_on.row===branch.row&&c.stand_on.col===branch.col):candidates;
 const objects=blockingBodySnapshot(new Map((state.objects??[]).map(o=>[o.id,o])),body.id);
 const blocked=exit=>{const goal=protocolToClient(exit.fine_stand_on);return objects.some(o=>Math.hypot(o.x-goal.x,o.y-goal.y)<28*16);};
 const ready=exit=>preparedFineExitStage(geometry,body,exit);
 // Prefer the published opening already occupied by our confirmed body. An
 // arbitrary leftmost opening can make the head reverse into its followers or
 // wait on a stationary monster while an adjacent legal boundary stays clear.
 const distance=exit=>Math.hypot(body.x-exit.fine_stand_on.x,body.y-exit.fine_stand_on.y);
 for(const exit of selected.sort((a,b)=>Number(ready(b)&&(b.kind==='go'||!blocked(b)))-Number(ready(a)&&(a.kind==='go'||!blocked(a)))||(distance(a)+(blocked(a)?128:0))-(distance(b)+(blocked(b)?128:0))||a.fine_stand_on.x-b.fine_stand_on.x).slice(0,4)){
  const candidateStarted=performance.now();let plan;
  if(exit.kind==='go'){
   const route=planBodyDetour(geometry,body,exit.fine_stand_on,{goalSquare:exit.stand_on,objects:new Map(),selfId:body.id,refine:true,maxRangeSquares:64,maxGoalRangeSquares:64,marginSquares:6,maxNodes:12000,maxMs:750});
   if(route.found){const points=[body,...route.waypoints].map(protocolToClient);plan={found:true,leg:{kind:'walk',sourceWaypoints:points,waypoints:points}};}
   else plan={found:false,reason:route.reason};
  }else plan=planQueuedEgress(geometry,body,exit.fine_stand_on,{maxMs:1500});
  candidatesTried.push({stand:exit.stand_on,fine:exit.fine_stand_on,found:plan.found,reason:plan.reason??null,elapsedMs:Math.round(performance.now()-candidateStarted)});
  if(plan.found)return {...plan,candidatesTried,leg:coalesceCheckedRailLeg(geometry,plan.leg,{avoidSquares:roomExitSquares(room,{rows:geometry.rows,cols:geometry.cols,includeInland:true})}),room:state.room.num,exit:{to,row:exit.stand_on.row,col:exit.stand_on.col},target:exit.fine_stand_on};
 }
 return {found:false,reason:'published_exit_route_unproved',candidatesTried,candidates:candidates.map(e=>({stand:e.stand_on,fine:e.fine_stand_on}))};
}
