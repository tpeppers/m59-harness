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
