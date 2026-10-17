// Independently continue one owned road journey; queue on positively observed body refusals.
// Every retry starts only after the old driver ended and a fresh path is proved clear.
import {planBodyDetour} from './m59-body-detour.mjs';
import {squareCentreClient,clientToProtocol} from './m59-finepos.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function roadTrafficGap(geo,state,traffic){
 if(!geo?.collisionReady||state?.you?.predicted||state?.room?.num!==traffic?.room||!Array.isArray(traffic.exits))return false;
 if(![state.you?.x,state.you?.y].every(Number.isFinite))return false;
 const objects=new Map((state.objects??[]).map(o=>[o.id,o]));
 for(const exit of traffic.exits){
  if(!Number.isInteger(exit.row)||!Number.isInteger(exit.col))continue;
  const goal=clientToProtocol(squareCentreClient(exit.row,exit.col));
  const distance=Math.hypot(goal.x-state.you.x,goal.y-state.you.y);
  const plan=planBodyDetour(geo,state.you,goal,{refine:true,goalSquare:exit,objects,selfId:state.you.id,maxRangeSquares:Math.min(64,Math.max(4,distance/64+2)),maxGoalRangeSquares:64,marginSquares:6,maxNodes:6000,maxMs:300});
  if(plan.found)return true;
 }
 return false;
}
export async function followRoadJourney({read,confirmArrival=null,command,owner,to,maxHops,alsoStopAt=[],deadline,now=Date.now,wait=sleep,trafficReady=null,onWait=()=>{}}){
 let requested=false,cancelled=false,endedShortAt=null,healthFloor=null,waitKey=null;
 for(;;){
  if(now()>=deadline)throw Error('Brax road journey timed out');
  const s=await read(),order=s.movement?.order,held=s.autopilot_status?.suspended_journey;
  if(s.autopilot_status?.recovery_travel){onWait({kind:'keeper-recovery-trip',to:s.autopilot_status.recovery_travel.to});await wait(500);continue;}
  const resumed=order?.kind==='travel'&&Number(order.to)===Number(to)&&order.ordered_by===owner;
  const recovering=Number(held?.to)===Number(to)&&held?.ordered_by===owner;
  const busy=s.job?.busy||resumed||recovering;
  if(s.job?.busy&&s.job.ordered_by!==owner||order&&order.ordered_by!==owner&&order.origin?.source!=='keeper')throw Error('Brax road owned by another controller');
  // The HTTP job can retain its failed receipt while the keeper is already
  // resuming this exact journey. A live order/owned suspension is authoritative.
  if(busy)endedShortAt=null;
  const reached=s.room.num===to||alsoStopAt.includes(s.room.num);
  const notify=(kind,key,detail={})=>{if(waitKey!==key){waitKey=key;onWait({kind,...detail});}};
  if(healthFloor!=null&&!busy&&!reached){
   if(!(s.hp?.max>0&&s.hp.value/s.hp.max>=healthFloor)){notify('health','health:'+healthFloor,{floor:healthFloor,hp:s.hp});await wait(500);continue;}
   healthFloor=null;waitKey=null;
  }
  if(reached&&!busy){
   // A cached room projection may predate the final road/recovery handoff.
   // Advance to a fine leg only after an ordered actual arrival agrees.
   const actual=confirmArrival?await confirmArrival():s,a=actual.movement?.order,h=actual.autopilot_status?.suspended_journey;
   if((actual.room.num===to||alsoStopAt.includes(actual.room.num))&&!actual.job?.busy&&!actual.autopilot_status?.recovery_travel&&
      !(a?.kind==='travel'&&a.ordered_by===owner)&&!(h?.ordered_by===owner))return true;
   await wait(500);continue;
  }
  if(reached&&busy&&s.room.num!==to&&!cancelled){
   await command('cancel_movement');cancelled=true;
  }else if(!busy&&!requested){
   const reply=await command('travel',{to,background:true,...(maxHops==null?{}:{max_hops:maxHops}),run_errands:false});
   if(reply.started===false&&reply.refused==='too_hurt'&&Number.isFinite(reply.floor)&&reply.floor>0&&reply.floor<=1){healthFloor=reply.floor;continue;}
   if(reply.error||reply.refused||reply.cancelled===true||reply.started===false)throw Error('Brax road refused: '+(reply.error??reply.why??reply.reason??reply.refused??reply.note??'not started'));
   requested=true;
  }else if(requested&&!busy&&s.job?.ordered_by===owner&&(s.job?.failed||s.job?.cancelled)){
   // Give the keeper one bounded observation window to publish its handoff.
   // This sends no retry and cannot extend the enclosing route deadline.
   endedShortAt??=now();
   if(now()-endedShortAt>=5000){
    const traffic=s.job.traffic_wait;
    if(!s.job.cancelled&&trafficReady&&traffic?.room===s.room.num&&traffic.to===to){
     notify('traffic','traffic:'+traffic.finished_at,{room:s.room.num,exits:traffic.exits});
     if(await trafficReady(s,traffic)){requested=false;endedShortAt=null;waitKey=null;onWait({kind:'traffic-gap-opened',room:s.room.num});}
    }else throw Error('Brax road failed: '+(s.job.failed??'journey cancelled without an owned continuation'));
   }
  }
  await wait(500);
 }
}
