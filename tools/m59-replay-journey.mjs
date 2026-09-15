// Rebuild process-local journey callbacks from an already time-rebased snapshot.
// Copying `inert.travelling` alone makes goTravelling's idempotence guard skip them.
export function restoreReplayJourney(keeper,{inert=null,suspendedJourney=null}={}) {
  const saved=structuredClone(inert),suspended=structuredClone(suspendedJourney);
  keeper.inert=saved;
  keeper.suspendedJourney=suspended;
  if(!saved?.travelling)return {restored:false,kind:saved?'external_hold':suspended?'suspended':'none'};
  keeper.inert=null;
  keeper.s.shelterPolicy=null;
  keeper.goTravelling(saved.why,{to:saved.to,maxMs:saved.maxMs,guard:saved.guard,attempts:saved.attempts});
  if(!keeper.inert?.travelling)throw Error('replay could not restore journey ownership');
  // The initializer owns callable behavior and guard defaults. The snapshot owns
  // its original deadline, destination, retry count and other serializable state.
  keeper.inert={...keeper.inert,...saved,guard:keeper.inert.guard};
  keeper.suspendedJourney=suspended;
  const shelter=keeper.s.shelterPolicy;
  const callbacks=!!(shelter&&['need','onArrive','onDivert'].every(key=>typeof shelter[key]==='function'));
  if(keeper.inert.guard.safe_spot&&!callbacks)throw Error('replay journey has no shelter callbacks');
  return {restored:true,kind:'active',destination:keeper.inert.to,
    shelter_callbacks:callbacks,safe_spot_allowed:keeper.inert.guard.safe_spot,
    at:keeper.inert.at,max_ms:keeper.inert.maxMs,attempts:keeper.inert.attempts};
}

export function replayJourneyDestination(control) {
  const to=control?.inert?.travelling?control.inert.to:
    control?.inert?null:control?.suspended_journey?.to;
  return to!=null&&Number.isInteger(Number(to))&&Number(to)>0?Number(to):null;
}

export async function resumeReplayJourney(keeper,destination,why) {
  keeper.goTravelling(why??'replayed journey',{to:destination,
    attempts:keeper.suspendedJourney?.attempts??keeper.inert?.attempts??0});
  const owner=keeper.inert;
  if(!owner?.travelling)throw Error('replay journey is held by another controller');
  const deaths=keeper.tally?.deaths??0;let outcome=null;
  try {
    // The keeper wrapper adds hop-boundary recovery and journey accounting.
    // Calling Session.travel directly silently drops those production behaviors.
    outcome=await keeper.travel(destination);return outcome;
  }finally{
    if(keeper.inert===owner){
      const here=Number(keeper.s.world?.room?.num);
      if(!owner.cancelled&&outcome?.arrived!==true&&!outcome?.refused&&here!==1&&here!==Number(destination)
          &&!keeper.recoverUntilWhole&&(keeper.tally?.deaths??0)===deaths)
        keeper.suspendedJourney={to:destination,why:owner.why,at:Date.now(),
          trigger:outcome?.reason??'replayed journey ended short',attempts:(owner.attempts??0)+1,
          deaths_at:deaths,next_try_at:Date.now()+5000};
      keeper.revive('replayed journey finished');
    }
  }
}
