// Bounded cooperative staging using the same native reversible clearance proof as rails.
// readAll supplies identity-fenced native bodies; runStep owns one declared actor's
// public work lease and verifies the actual result. This helper never sends packets.
import {chooseCrowdClearanceStep} from './m59-rail-traffic.mjs';
import {loadMap,roomExitSquares} from './m59-map.mjs';
// Keep spacing inside the current map: a collision-valid floor outside its
// bounds can still activate a real room edge. Never call that a staging move.
export function roomStagingGuard(room,geometry,map=loadMap()){
 const spec=map.rooms?.[room],avoid=roomExitSquares(spec,{rows:geometry.rows,cols:geometry.cols});
 for(const e of spec?.goExits??[])if(Number.isInteger(e.row)&&Number.isInteger(e.col))avoid.add(e.row+','+e.col);
 return(from,to)=>{
  const start=Math.floor(from.y/64)+','+Math.floor(from.x/64),target=Math.floor(to.y/64)+','+Math.floor(to.x/64),inside=p=>p.x>=64&&p.y>=64&&p.x<(geometry.cols+1)*64&&p.y<(geometry.rows+1)*64;
  if(!inside(to)||avoid.has(target))return false;
  const count=Math.max(1,Math.ceil(Math.hypot(to.x-from.x,to.y-from.y)/8));let leftStart=false;
  for(let i=1;i<=count;i++){const p={x:from.x+(to.x-from.x)*i/count,y:from.y+(to.y-from.y)*i/count},key=Math.floor(p.y/64)+','+Math.floor(p.x/64);if(!inside(p))return false;if(key!==start)leftStart=true;if(avoid.has(key)&&!(key===start&&!leftStart))return false;}
  return true;
 };
}
export async function stageCrowd({room,geometry,readAll,runStep,clearance=48,maxSteps=64,timeoutMs=480000,now=Date.now,emit=()=>{},acceptStep=roomStagingGuard(room,geometry)}={}){
 if(!Number.isInteger(room)||typeof readAll!=='function'||typeof runStep!=='function')throw Error('native room staging requires readers and owned step runner');
 const deadline=now()+timeoutMs,steps=[];
 for(let attempt=0;attempt<maxSteps&&now()<deadline;attempt++){
  const rows=await readAll(),here=rows.filter(r=>r.state?.room?.num===room),ready=here.filter(({state:s})=>s.in_game===true&&s.connected===true&&s.hp?.value===s.hp?.max&&s.hp?.value>0&&!s.job?.busy&&!s.movement?.order&&!s.autopilot_status?.cast_rite?.active&&s.autopilot_status?.faculties?.work==='keeper');
  if(!here.length)return{ok:false,reason:'no_native_bodies_in_room',steps};
  const anchor=here[0].state,objects=new Map((anchor.objects??[]).map(o=>[o.id,o]));objects.set(anchor.you.id,{...anchor.you,flags:5});
  const plan=chooseCrowdClearanceStep(geometry,objects,new Set(ready.map(r=>r.state.you?.id)),{clearance,acceptStep});
  if(!plan)return{ok:true,reason:'no_further_proved_step_for_available_bodies',steps};
  const actor=ready.find(r=>r.state.you.id===plan.id),intent={at:now(),agent:actor.agent,plan};await emit({kind:'staging-step-intent',...intent});
  const result=await runStep(actor.agent,plan);steps.push({...intent,result});await emit({kind:'staging-step-result',...intent,result});
  if(!result?.ok)return{ok:false,reason:'native_step_not_verified',steps};
 }
 return{ok:true,bounded:true,reason:'staging_budget_ended',steps};
}
