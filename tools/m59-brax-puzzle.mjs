// Player-observable readiness for the unmodified g9.kod lift.
// ResetLeverStates calls SwitchLever -> SomethingChanged synchronously. Resetting
// all five DOWN levers can solve the puzzle again before the outer reset resumes.
// Thus reset at +120s schedules another reset at +240s and activation at +360s.
export const BRAX_SOLVED_RESET_MS=361000;
export const BRAX_PARTIAL_RESET_MS=421000;
export const BRAX_UNKNOWN_BASELINE_MS=241000;
export const BRAX_RESET_FLOORS={2:250,3:250,4:540,5:200,6:200,7:200,8:200,9:510};
export const braxResetBaseline=observed=>Object.entries(BRAX_RESET_FLOORS).every(([id,height])=>observed?.[id]===height);
export function braxPuzzleReadiness(group,observed,now){
 const baseline=braxResetBaseline(observed),baselineSince=baseline?(group?.baselineSince??now):null;
 const source=Number.isFinite(group?.raisedAt)?'completed-reset':group?.failure&&Number.isFinite(group?.readyAfter)?'partial-reset':'stable-baseline';
 const readyAfter=Math.max(Number.isFinite(group?.readyAfter)?group.readyAfter:0,
  source==='completed-reset'?group.raisedAt+BRAX_SOLVED_RESET_MS:
  source==='stable-baseline'&&baseline?baselineSince+BRAX_UNKNOWN_BASELINE_MS:0);
 return {ready:baseline&&now>=readyAfter,baselineSince,readyAfter,source};
}
export function braxLeverUsable(group,lever,observed){
 if(group?.failure||!Number.isFinite(group?.readiness?.verifiedAt))return false;
 if(lever.row===21&&lever.col===55)return group.phase==='center'&&braxResetBaseline(observed);
 return group.phase==='corners'&&Number.isFinite(group.centerAt)&&group.centerAt>=group.readiness.verifiedAt&&
  observed?.[2]===800&&observed?.[3]===250&&observed?.[4]===540&&observed?.[9]===510&&
  [5,6,7,8].every(id=>observed?.[id]===340);
}
export function braxFailedReadyAfter(group,now){
 if(Number.isFinite(group.raisedAt))return Math.max(group.readyAfter??0,group.raisedAt+BRAX_SOLVED_RESET_MS);
 if(Number.isFinite(group.lastTouchAttemptAt))return Math.max(group.readyAfter??0,group.lastTouchAttemptAt+BRAX_PARTIAL_RESET_MS);
 // A proved, untouched boarding cohort has not changed the mechanism.
 if(group.readiness)return group.readiness.readyAfter;
 return Math.max(group.readyAfter??0,now+458000); // legacy/unknown partial state
}
