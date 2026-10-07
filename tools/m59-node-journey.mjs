// Connected node approaches use the ordinary travel executor and fresh room/position reads.
import {protocolToClient} from './m59-finepos.mjs';
export async function runNodeJourney(s,destination,{movementGeneration=s.movementGeneration,onHop=()=>{},isInterrupted=()=>false}={}){
  if(!Number.isSafeInteger(destination)||destination<1)throw Error('invalid node journey destination');
  const began=Date.now(),hops=[];
  const pose=()=>({room:s.world.room?.num,row:s.client.self?.row,col:s.client.self?.col,
    x:s.client.self?.x,y:s.client.self?.y,hp:s.client.vitals?.()?.health?.value});
  if(isInterrupted()||s.movementWasCancelled(movementGeneration))return {arrived:false,reason:'trial_cancelled',hops};
  if(!await s.confirmPosition())return {arrived:false,reason:'journey_origin_not_confirmed',hops};
  const start=pose();let hookError=null;
  const reply=await s.travel(destination,{movementGeneration,onHop:async hop=>{
    const confirmed=!!await s.confirmPosition(),event={...hop,ms:Date.now()-began,confirmed,position:pose()};
    hops.push(event);
    if(!confirmed||event.position.room!==hop.room?.num)hookError='journey_hop_not_confirmed';
    await onHop(event);
  }});
  const confirmed=!!await s.confirmPosition(),end=pose(),at=s.client.self?protocolToClient(s.client.self):null,g=s.world.geometry;
  const cancelled=isInterrupted()||s.movementWasCancelled(movementGeneration);
  const floor=at&&g?g.floorBaseAtClient(at.x,at.y,g.leafAtClient(at.x,at.y)):null;
  return {arrived:reply.arrived===true&&confirmed&&end.room===destination&&!hookError&&!cancelled,
    reason:cancelled?'trial_cancelled':hookError??(!confirmed?'journey_endpoint_not_confirmed':reply.arrived!==true?reply.reason??'journey_not_arrived':end.room!==destination?'journey_wrong_room':null),
    start,end,floor_client:floor,destination,elapsed_ms:Date.now()-began,hops,reply};
}
