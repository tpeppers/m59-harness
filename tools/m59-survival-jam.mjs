// Memory belongs to the recovery owner, not to an individual refuge decision.
export const JAM_TTL_MS = 120_000, JAM_MEASURE_MS = 10_000, REPLAN_MS = 1_000;
export function sameJamPocket(a,b) {
  return !!a && !!b && a.room===b.room && Math.abs(a.row-b.row)<=2 && Math.abs(a.col-b.col)<=2;
}
export function jamObservation(k) {
  const s=k.s,c=s?.client,p=c?.self;
  return {room:s?.world?.room?.num,row:p?.row,col:p?.col,client:c,
    generation:s?.movementGeneration,deaths:k.tally?.deaths??0,lifeBoundary:s?.lifeBoundary??0};
}
export function validJamOwner(k,e,now=Date.now()) {
  const o=jamObservation(k),hp=k.s?.client?.vitals?.()?.health?.value;
  return !!e && e.client===o.client && e.generation===o.generation && e.deaths===o.deaths && e.lifeBoundary===o.lifeBoundary
    && sameJamPocket(e,o) && now<e.expires && hp!==0 && o.room!==1
    && !k.stopping && !(k.busy?.until>now) && !(k.inert&&!k.inert.travelling)
    && !k.facultyHeld('survival') && !k.facultyHeld('combat') && !k.facultyHeld('recovery')
    && !k.hold && !k.holdWorks() && !k.currentRecoveryWall();
}
// Include bodies, exits, geometry identity and damage, not changing decision IDs.
// A new route opportunity or damage bypasses the short retry delay immediately.
export function recoveryObservationKey(k) {
  const s=k.s,c=s.client,p=c?.self;
  return JSON.stringify([s.movementGeneration,s.world?.room?.num,p?.row,p?.col,p?.x,p?.y,
    c?.vitals?.()?.health,k.hitDamageTotal?.(),s.world?.geometry?.revision,
    [...(c?.room?.objects?.values?.()??[])].map(o=>[o.id,o.flags,o.row,o.col]).sort((a,b)=>a[0]-b[0]),
    s.activeShelter?.onward,s.activeShelter?.spots,s.world?.room?.edgeExits,s.world?.room?.goExits,
    [...(k.unreachableIn(s.world?.room?.num)??[])].sort()]);
}
