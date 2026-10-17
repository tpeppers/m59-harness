import{isActiveRecoveryDecision}from'./m59-survival-decision.mjs';
// Match the native fine-walk gate. A protected trip always owns movement;
// a finished health recovery label alone must not stop a healthy traveler.
export function fineRecoveryInterruption(state){
 const trip=state.autopilot_status?.recovery_travel;
 if(trip)return{arrived:false,reason:'keeper_recovery_trip_active',trip_id:trip.id};
 const decision=state.autopilot_status?.survival_decisions?.current,health=state.hp;
 if(isActiveRecoveryDecision(decision)&&decision.source==='keeper'&&
    Number.isFinite(health?.value)&&Number.isFinite(health?.max)&&health.max>0&&health.value<health.max)
  return{arrived:false,reason:'keeper_recovery_active',decision_id:decision.id};
 return null;
}
