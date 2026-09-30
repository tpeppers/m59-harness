// Decisions use teammates' reported progress, never privileged enemy/room state.
// Experimental lab policy: a timed shield-reset squad, including a chalice relay.
export const RESCUE_CARRIERS=['t16','t5'];
export const RESCUE_RELAYS={t16:'t7',t5:'t3'};
export const RESCUE_RESPONDERS=[...RESCUE_CARRIERS,...Object.values(RESCUE_RELAYS)];
export const RUNNER_SPACING_MS=1000;
export function rescueDefenseDecision(actors,{breached=false,elapsedMs=0}={}){
  const live=actors.filter(a=>a.alive),foyer=live.filter(a=>a.foyer),
    runners=foyer.filter(a=>!RESCUE_RESPONDERS.includes(a.key)),
    carriers=foyer.filter(a=>RESCUE_RESPONDERS.includes(a.key)),
    staged=live.filter(a=>a.staged),rescue=live.filter(a=>RESCUE_RESPONDERS.includes(a.key));
  return {
    cast:elapsedMs>=480000,
    assemble:breached||foyer.length>=2||(elapsedMs>=555000&&foyer.length>=1),
    breach:breached||(elapsedMs>=480000&&staged.length>=4&&rescue.every(a=>a.staged))
      ||(elapsedMs>=555000&&staged.length>=2)||(elapsedMs>=570000&&staged.length>=1),
    runner_count:runners.length,carrier_count:carriers.length,fighter_count:staged.length,
    rescue_staged:rescue.filter(a=>a.staged).length,rescue_living:rescue.length,
  };
}
