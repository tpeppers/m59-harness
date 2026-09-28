// Pure identity and sequencing checks for explicitly authorized remote node tours.
export const endpointName=s=>s&&`${String(s.host).toLowerCase()}:${s.port}`;
export function railIdentityProblem({fleet,agent,rostered,health,expectedGame=null,checkedRail=false,candidates=false}){
  const live=health?.session_game_servers?.[agent]??health?.game_server;
  if(!rostered||!live||health?.fleet!==fleet||endpointName(live)!==endpointName(rostered))return 'fleet_or_game_endpoint_mismatch';
  if(!health.session_characters?.[agent])return 'agent_not_in_verified_fleet';
  const local=['127.0.0.1','localhost','::1'].includes(rostered.host.toLowerCase());
  if(!local&&(!expectedGame||expectedGame.toLowerCase()!==endpointName(rostered)))return 'remote_requires_exact_expected_game';
  if(!local&&(!checkedRail||candidates))return 'remote_requires_checked_declared_rail';
  return null;
}
export function availableForTour(row){
  return !!row&&!row.piloted&&!row.parked&&(!row.committed||row.committed.takeable===true);
}
export function tourObjectiveComplete(r){return r?.complete===true&&r.nodes?.length===5&&r.nodes.every(n=>['melded','already'].includes(n.status));}
export function atPost(p,post){return p?.room===post.room&&Math.abs(p.row-post.row)<=2&&Math.abs(p.col-post.col)<=2;}
// Both live failure recoveries exercised FleetScript's heal-then-walk from 38.
// Do not substitute an ordinary route for the special exits of node trap rooms.
export const deskRecoveryAllowed=room=>room===2||room===38;
export function stableNodeGrant(before,after,stable){
  return Number.isInteger(before?.pid)&&before.pid===after?.pid&&after.pid===stable?.pid&&
    Number.isInteger(before.connection_revision)&&before.connection_revision===after.connection_revision&&
    after.connection_revision===stable.connection_revision&&Number.isFinite(before.mana?.max)&&
    after.mana?.max>before.mana.max&&stable.mana?.max===after.mana.max;
}
// holdKeeper consults this shared marker before cancelling a walk on lease retake.
// Fineclimb runs in a child process, so its parent must keep the marker alive.
export async function withTourWalkOwnership(agent,fn){
  const walks=globalThis.__m59OwnWalks??=new Map(),prior=walks.get(agent);
  const renew=()=>walks.set(agent,Date.now()+60000);
  renew();const timer=setInterval(renew,10000);timer.unref?.();
  try{return await fn();}finally{clearInterval(timer);if(prior==null)walks.delete(agent);else walks.set(agent,prior);}
}
