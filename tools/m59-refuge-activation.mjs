// Normal native activation: a turn at confirmed cover wakes the room and
// permits health regeneration after reconnect, without leaving the refuge.
import {safeSpots,hasAnyFooting} from './m59-safespots.mjs';
export function knownRefugeCell(geo,pose){
 if(!geo?.collisionReady||pose?.predicted||![pose?.x,pose?.y,pose?.row,pose?.col].every(Number.isFinite)||
   Math.floor(pose.x/64)!==pose.col||Math.floor(pose.y/64)!==pose.row)return null;
 if(!hasAnyFooting(geo,pose.row,pose.col)||!safeSpots(geo,{limit:Infinity}).some(w=>!w.rim&&w.row===pose.row&&w.col===pose.col))return null;
 const x=(pose.x-64)*16,y=(pose.y-64)*16,leaf=geo.leafAtClient(x,y);
 if(!leaf?.sector||!Number.isFinite(geo.floorBaseAtClient(x,y,leaf)))return null;
 return {row:pose.row,col:pose.col};
}
// A normal walk's distance tolerance can stop across the boundary of a partial
// refuge square. Finish only that short, already planned approach, then prove
// the actual covered cell; a successful movement reply alone is not arrival.
export async function confirmRefugeCellArrival(geo,refuge,{read,finish,attempts=4,settleMs=100}={}){
 let finished=false,pose;
 for(let n=0;n<attempts;n++){
  pose=await read();
  if(pose?.row===refuge.cell.row&&pose?.col===refuge.cell.col&&knownRefugeCell(geo,pose))
   return {arrived:true,pose,finished};
  if(pose?.predicted||![pose?.x,pose?.y].every(Number.isFinite)||
    Math.hypot(pose.x-refuge.point.x,pose.y-refuge.point.y)>8)
   return {arrived:false,pose,reason:'refuge approach not confirmed'};
  if(!finished){
   const result=await finish(refuge.point);finished=true;
   if(result?.cancelled)return {arrived:false,pose,cancelled:true,reason:'refuge approach cancelled'};
  }
  if(n+1<attempts&&settleMs>0)await new Promise(resolve=>setTimeout(resolve,settleMs));
 }
 return {arrived:false,pose,finished,reason:'refuge cell not observed'};
}
export async function turnAtProvedRefuge(s,{shouldCancel=null,beforeMutation=null}={}){
 const c=s?.client,generation=s?.movementGeneration,room=c?.room?.id;
 if(s?.combat?.active||c?.pvpGearActive)return {sent:false,reason:'PvP recovery retains activation control'};
 if(!c||s.live!==true||c.state!=='game'||!Number.isInteger(generation)||typeof s.confirmFinePosition!=='function')return {sent:false,reason:'refuge activation unavailable'};
 const pose=await s.confirmFinePosition({timeoutMs:1500}),refuge=knownRefugeCell(s.world?.geometry,pose);
 if(!refuge||!Number.isInteger(pose?.id)||pose.id<=0||pose.id!==c.self?.id)return {sent:false,reason:'refuge not confirmed'};
 const valid=()=>s.client===c&&c.state==='game'&&c.room?.id===room&&c.self?.id===pose.id&&
  !s.movementWasCancelled?.(generation)&&!(typeof shouldCancel==='function'&&shouldCancel())&&
  Math.hypot((c.self?.x??Infinity)-pose.x,(c.self?.y??Infinity)-pose.y)<=1;
 const sent=await s.pacer.submit('turn',()=>{
  if(!valid()||(typeof beforeMutation==='function'&&beforeMutation('turn')===false))return false;
  return c.face(Math.round(((c.self.degrees??0)+90)%360));
 });
 return {sent:sent!==false,refuge,reason:'normal turn at confirmed cover; subsequent health gain remains observed'};
}
