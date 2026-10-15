// Client heights use 1024 units per square. move.h starts an ordinary fall at
// -FINENESS * 2 / 3; gravity only speeds it up. Retain a 500ms grace and use that
// slow initial rate as an upper-height envelope, rather than an exact z guess.
const FINENESS=1024,RATE=FINENESS/1500,GRACE=500;
export function verticalMotionRange(vertical,roomId,now=Date.now()){
 if(!vertical||vertical.roomId!==roomId||!(vertical.settleAt>now)||
   ![vertical.min,vertical.max].every(Number.isFinite))return null;
 if(vertical.mode!=='walk'||!Number.isFinite(vertical.updatedAt)||!Number.isFinite(vertical.graceUntil))
  return {min:vertical.min,max:vertical.max};
 const elapsed=Math.max(0,now-Math.max(vertical.updatedAt,vertical.graceUntil));
 return {min:vertical.min,max:Math.max(vertical.min,vertical.max-elapsed*RATE)};
}
export function nextVerticalMotion(existing,roomId,source,destinationFloor,now=Date.now(),{normalWalk=true}={}){
 if(!Number.isFinite(destinationFloor))return existing;
 const lo=Number.isFinite(source?.min)?source.min:Number.isFinite(source)?source:destinationFloor;
 const hi=Number.isFinite(source?.max)?source.max:Number.isFinite(source)?source:destinationFloor;
 const active=verticalMotionRange(existing,roomId,now);
 const min=Math.min(lo,hi,destinationFloor,...(active?[active.min]:[]));
 const max=Math.max(lo,hi,destinationFloor,...(active?[active.max]:[]));
 if(max-min<=1e-6)return null;
 // A timed jump/fall or a range from older code has no ordinary-fall clock.
 // Preserve that uncertainty until its original window ends. Repeated packets
 // on the same floor must not continually renew an unmodelled flight either.
 if(active&&existing.mode!=='walk'){
  if(existing.lastFloor===destinationFloor&&min>=existing.min&&max<=existing.max)return existing;
  normalWalk=false;
 }
 const continuous=normalWalk&&existing?.mode==='walk'&&active&&max<=active.max+1e-6;
 const graceUntil=continuous?existing.graceUntil:now+GRACE;
 const settleMs=Math.min(5000,Math.max(0,graceUntil-now)+Math.ceil((max-min)/RATE));
 return {roomId,min,max,lastFloor:destinationFloor,updatedAt:now,graceUntil,
  mode:normalWalk?'walk':'unmodelled',settleAt:now+settleMs};
}
