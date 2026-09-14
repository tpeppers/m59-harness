import {currentSurvivalDecision,finishSurvivalDecision,setSurvivalReplayControl} from './m59-survival-decision.mjs';

export const REPLAY_STRATEGIES=['nearest_refuge','route_refuge','logoff_safe','logoff_open','rest_safe'];
export function installReplayVariant(k,variant,{onEvent=()=>{}}={}) {
  const s=k.s,disabled=new Set(variant.kind==='disable'?variant.strategies:[]),undo=[];
  for(const strategy of disabled)if(!REPLAY_STRATEGIES.includes(strategy))throw Error(`unsupported replay strategy ${strategy}`);
  setSurvivalReplayControl(s,null); // endpoint guard before altering even one method
  k.replayVariant=variant;
  const suppress=strategy=>{
    if(!disabled.has(strategy))return false;
    onEvent({event:'intervention_suppressed',strategy,at:Date.now()});
    const d=currentSurvivalDecision(s);if(d?.strategy===strategy)finishSurvivalDecision(s,d.id,'disabled_in_replay');
    return true;
  };
  const wrap=(object,name,make)=>{const previous=object[name];object[name]=make(previous.bind(object));undo.push(()=>{object[name]=previous;});};
  wrap(k,'playDead',original=>async why=>{
    const wall=k.currentRecoveryWall();
    const armed=wall&&k.hold?.reclaimed&&k.turnedAt>=k.hold.takenAt&&!(s.damagedAt>k.turnedAt);
    const strategy=armed?'rest_safe':wall?'logoff_safe':'logoff_open';
    if(blocksReplacement(strategy)&&!k.currentRecoveryWall())return false;
    if(suppress(strategy))return false;
    return original(why);
  });
  wrap(k,'takeRecoverySpot',original=>async(why,options={})=>{
    const strategy=options.route?'route_refuge':'nearest_refuge';
    if(blocksReplacement(strategy,true))return {took:false,disabled_in_replay:true};
    if(suppress(strategy))return {took:false,disabled_in_replay:true};
    return original(why,options);
  });
  wrap(k,'takeSafeSpot',original=>async(why,quarry,options={})=>{
    if(options.recovery&&blocksReplacement(options.recoveryRoute?'route_refuge':'nearest_refuge',true))return {took:false,disabled_in_replay:true};
    if(options.recovery&&suppress(options.recoveryRoute?'route_refuge':'nearest_refuge'))return {took:false,disabled_in_replay:true};
    return original(why,quarry,options);
  });
  wrap(k,'continueSurvivalDecision',original=>async()=>{
    const d=currentSurvivalDecision(s);
    if(d&&suppress(d.strategy)){k.frozenUntil=null;k.freezeSample=null;return false;}
    return original();
  });
  if(typeof k.checkFreeze==='function')wrap(k,'checkFreeze',original=>()=>{
    const d=currentSurvivalDecision(s);
    if(d&&disabled.has(d.strategy)&&k.frozenUntil) {
      suppress(d.strategy);k.frozenUntil=null;k.freezeSample=null;return false;
    }
    return original();
  });
  const wrappedPolicies=new WeakSet();
  const shelter=()=>{if(s.shelterPolicy&&disabled.has('route_refuge')&&!wrappedPolicies.has(s.shelterPolicy)) {
    const policy=s.shelterPolicy,need=policy.need;wrappedPolicies.add(policy);
    policy.need=(...args)=>{
      if(need.apply(policy,args))onEvent({event:'intervention_suppressed',strategy:'route_refuge',at:Date.now()});
      return false;
    };
    undo.push(()=>{policy.need=need;});
  }};
  wrap(k,'goTravelling',original=>(...args)=>{const r=original(...args);shelter();return r;});shelter();
  // Only automatic replacements are suppressed, for a bounded trial. Operator stop,
  // explicit ownership handoff, death and successful completion remain terminal.
  let pinned=null;
  const matches=d=>variant.kind==='continue'&&d&&d.strategy===variant.decision.strategy
    &&d.reason_code===variant.decision.reason_code
    &&(d.source??'keeper')===(variant.decision.source??'keeper')
    &&(!d.chosen_refuge||!variant.decision.chosen_refuge||['room','row','col'].every(key=>d.chosen_refuge[key]===variant.decision.chosen_refuge[key]));
  const keep=(d,spec)=>{
    if(spec?.strategy==='yield_to_controller')return false;
    if(k.currentRecoveryWall()&&spec?.strategy==='logoff_safe')return false;
    if(!pinned&&matches(d))pinned=d.id;
    return !!pinned&&d?.id===pinned;
  };
  const blocksReplacement=(strategy,newApproach=false)=>{
    const d=currentSurvivalDecision(s);
    if(!keep(d,{strategy})||variant.kind!=='continue')return false;
    if(strategy!==d.strategy||newApproach&&d.status==='approaching') {
      onEvent({event:'replacement_executor_suppressed',strategy,id:d.id,at:Date.now()});return true;
    }
    return false;
  };
  if(variant.kind==='continue') {
    setSurvivalReplayControl(s,{keepDecision:(d,spec,why)=>{
      if(!keep(d,spec))return false;
      onEvent({event:'replacement_suppressed',id:d.id,why,at:Date.now()});return true;
    }});
    wrap(s,'cancelMovement',original=>(token,why,options={})=>{
      if(options.replacement?.strategy!=='yield_to_controller'&&keep(currentSurvivalDecision(s),options.replacement)) {
        onEvent({event:'movement_cancellation_suppressed',why,at:Date.now()});
        return {cancelled:false,replay_continuation:true};
      }
      return original(token,why,options);
    });
  }
  return {suppressed:disabled,restore(){setSurvivalReplayControl(s,null);undo.reverse().forEach(fn=>fn());delete k.replayVariant;}};
}
