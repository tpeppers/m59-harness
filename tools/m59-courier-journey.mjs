// Observe one accepted native journey through protected recovery. Never POST
// another order merely because the first RPC returned before the destination.
export async function observeCourierJourney({agent,to,before,result,read,deadline,wait=ms=>new Promise(r=>setTimeout(r,ms)),emit=()=>{}}){
 const returnedAt=Date.now();
 for(;;){
  const s=await read(agent),a=s.autopilot_status??{},held=a.suspended_journey,move=s.movement?.order;
  await emit({kind:'courier-journey-observed',agent,to,room:s.room?.num,job:s.job,suspended:held});
  const stable=typeof before.character==='string'&&before.character.length>0&&s.character===before.character;
  if(s.you?.id!==before.you?.id&&!stable||s.pid!==before.pid||!(s.hp?.value>0)||s.room?.num===1||
    (a.last_death?.at??0)>(before.autopilot_status?.last_death?.at??0)||Number.isFinite(before.hp?.max)&&s.hp.max<before.hp.max)
   throw Error('courier body changed during town travel');
  if(s.room?.num===to)return s;
  const owner=result?.ordered_by,owns=owner&&(held?.to===to&&held.ordered_by===owner||move?.to===to&&move.ordered_by===owner);
  if(Date.now()>=deadline||!owner||!owns&&Date.now()-returnedAt>=3000)throw Error('courier journey ended before destination '+to);
  await wait(1000);
 }
}
