// Categories are observations, never inferred proof that an attack was legal.
import {isActiveRecoveryDecision} from './m59-survival-decision.mjs';
export function farmTimeCategory(s,{role='farmer',servicePhase=null,now=Date.now()}={}){
 const a=s?.autopilot_status??{},room=s?.room?.num,hp=s?.hp,stage=a.ladder?.stage,activity=String(a.activity??''),decision=a.last_decision;
 const reason=decision&&now-decision.at<=30000?{what:decision.what,why:decision.why??decision.reason??null,stage:decision.stage}:null;
 const result=(category,detail)=>({category,reason:detail??reason,at:now,room:room??null});
 if(s?.error||s?.connected===false||s?.in_game!==true||!hp||s.as_of_ms>30000)return result('unknown_or_disconnected',s?.error??'missing/stale body or vitals');
 if(room===1||hp.value<=0)return result('death_recovery');
 if(role==='courier')return result(/needs attention|service stalled/.test(servicePhase??'')&&!s.job?.busy&&!s.movement?.order?'courier_stalled':String(servicePhase??'').startsWith('waiting for ')?'courier_wait':servicePhase==='exchange'?'courier_exchange':'courier_service',servicePhase??activity);
 if(![578,826,827].includes(room))return result('outside_lock');
 if(/stationary cargo exchange/i.test(activity))return result('exchange',activity);
 if(isActiveRecoveryDecision(a.survival_decisions?.current)||hp.value/hp.max<(a.policy?.restBelow??.6)||/resting|recovering|playing dead/i.test(activity))return result('recovery');
 if(/needs attention|service stalled/.test(servicePhase??'')&&!s.job?.busy&&!s.movement?.order)return result('service_stalled',servicePhase);
 if(servicePhase)return result(servicePhase==='exchange'?'exchange':'internal_hauling',servicePhase);
 if(room!==827)return result('outside_farming_room');
 if(s.combat?.active||/fighting/i.test(activity)||a.farm_combat?.pending&&now-a.farm_combat.at<30000)return result('combat_or_fight_attempt');
 if(a.cast_rite?.active)return result('casting');
 if(s.job?.busy||s.movement?.order||/travelling|pulling/i.test(activity))return result('movement_or_pull');
 if(Number.isFinite(hp.max)&&hp.max>0&&hp.value>=hp.max&&Number.isFinite(s.mana?.max)&&s.mana.max>0&&s.mana.value>=s.mana.max&&s.vigor?.value>=70)return result('healthy_wait',reason??'no recent explicit keeper decision');
 return result('other_wait',reason??'no recent explicit keeper decision');
}
export function integrateFarmTimes(previous,current,{maxGapMs=30000}={}){
 const dt=Math.max(0,current.at-previous.at),observed=Math.min(dt,maxGapMs);return{category:previous.category,ms:observed,unknownMs:dt-observed};
}
