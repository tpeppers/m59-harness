import {continuingProvenRefugeLeg} from './m59-refuge-leg.mjs';
// A long farm pull must yield before its ordinary deadline when the body is hurt.
// Invalidating this invocation also fences callbacks already waiting in the pacer.
export function watchFarmDanger(ap,stage,token,onDanger,{intervalMs=100}={}) {
 if(stage!=='passFarm')return()=>{};
 const s=ap.s,c=s?.client,room=c?.room?.id,self=c?.selfId;
 let previous=c?.vitals?.()?.health?.value;
 const timer=setInterval(()=>{
  const h=c?.vitals?.()?.health;
  if(s.client!==c||c?.room?.id!==room||c?.selfId!==self||!c?.combatReady&&c?.combatReady!==undefined||ap.stopping){clearInterval(timer);return;}
  if(s.combat?.active||ap.inert||ap.facultyHeld?.('survival'))return;
  // The farm rung may already be walking to cover. A short, confirmed,
  // progressing refuge leg must finish; stale or blocked proof releases it.
  if(continuingProvenRefugeLeg(s))return;
  const lost=Number.isFinite(previous)&&h?.value<previous; previous=h?.value;
  if(!(h?.value>0&&h.max>0&&h.value/h.max<ap.safety().fleeAt&&(lost||ap.mortalDanger?.())))return;
  token.cancelled=true;clearInterval(timer);
  if(ap.farmCombat?.pending)ap.farmCombat={...ap.farmCombat,pending:false,interrupted_at:Date.now(),reason:"survival preemption"};
  const cancelled=s.cancelMovement?.(null,'farm action yielded to survival');
  onDanger({health:{...h},fleeAt:ap.safety().fleeAt,cancelled});
 },intervalMs);
 return()=>clearInterval(timer);
}
