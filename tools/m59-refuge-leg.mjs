// A proved route to cover remains useful after an incoming hit. This record
// never licenses a packet; the ordinary sender still checks every step.
import {liveMoveOrder,originLabel} from './m59-move-origin.mjs';

export function rememberRefugePosition(s,pose){
  const prior=s.refugePosition,same=prior?.client===s.client&&prior.id===pose.id&&prior.room_object_id===pose.room_object_id&&prior.generation===s.movementGeneration;
  const changed=!same||Math.hypot(prior.x-pose.x,prior.y-pose.y)>=2;
  s.refugePosition={...pose,client:s.client,generation:s.movementGeneration,
    changed_at:changed?pose.at:prior.changed_at,
    previous:same?(changed?{x:prior.x,y:prior.y,at:prior.at}:prior.previous):null};
}
export async function withProvenRefugeLeg(s,waypoints,goal,{movementGeneration,controlToken}={},run){
  const parent=s.provenRefugeLeg,client=s.client,from=client?.self,order=liveMoveOrder(s);
  const leg={client,self_id:client?.self?.id,room_object_id:client?.room?.id,generation:movementGeneration,controlToken,
    owner:order?.origin?originLabel(order.origin):null,started_at:Date.now(),
    from:{x:from?.x,y:from?.y},waypoints,goal:{row:goal.row,col:goal.col},next_index:0,blocked:false};
  s.provenRefugeLeg=leg;
  try{return await run(leg);}finally{if(s.provenRefugeLeg===leg)s.provenRefugeLeg=parent??null;}
}
export function continuingProvenRefugeLeg(s,{now=Date.now(),maxAgeMs=2500,maxRemainingSquares=20}={}){
  const leg=s?.provenRefugeLeg,pose=s?.refugePosition,client=s?.client,order=liveMoveOrder(s);
  if(!leg||leg.blocked||s.live!==true||client?.state!=='game'||leg.client!==client||!Number.isInteger(leg.self_id)||leg.self_id<=0||leg.self_id!==client?.self?.id||leg.room_object_id!==client?.room?.id||
    ![leg.from?.x,leg.from?.y].every(Number.isFinite)||
    !Number.isInteger(leg.generation)||leg.generation!==s.movementGeneration||
    s.movementWasCancelled?.(leg.generation,leg.controlToken)||!leg.owner||originLabel(order?.origin)!==leg.owner)return false;
  if(!pose||pose.client!==client||pose.id!==leg.self_id||pose.room_object_id!==leg.room_object_id||pose.generation!==leg.generation||
    !pose.previous||pose.at<leg.started_at||pose.changed_at<leg.started_at||now-pose.at<0||now-pose.at>maxAgeMs||
    now-pose.changed_at>maxAgeMs||Math.hypot(pose.x-leg.from.x,pose.y-leg.from.y)<2)return false;
  const health=client?.vitals?.()?.health;if(!Number.isFinite(health?.value)||health.value<=0)return false;
  let distance=0,previous=pose;
  for(const p of leg.waypoints.slice(leg.next_index)){distance+=Math.hypot(p.x-previous.x,p.y-previous.y)/64;previous=p;}
  return distance>0&&distance<=maxRemainingSquares;
}
