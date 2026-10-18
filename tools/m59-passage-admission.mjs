// #movement: admit one body to a connected narrow passage, in either direction.
// Geometry identifies candidates; collision remains the packet proof.
import {reserveFilePassage, releaseFilePassage, retagOwnFilePassage} from './m59-spotclaims.mjs';
import {OF} from './m59-parse.mjs';
import {fineChokesFor} from './m59-pocket-rails.mjs';
const cache = new WeakMap(), local = new Map();
const key = (row, col) => row + ',' + col;
export function narrowPassages(geo) {
  const previous = cache.get(geo);
  if (previous && previous.mask === geo._stepMask) return previous.zones;
  const thin = new Set(), zones = new Map();
  const open = (r,c) => r >= 1 && c >= 1 && r <= geo.rows && c <= geo.cols && geo.walkable(r,c);
  for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
    if (!open(r,c)) continue;
    let wide = false;
    for (const dr of [-1,1]) for (const dc of [-1,1])
      if (open(r+dr,c) && open(r,c+dc) && open(r+dr,c+dc)) wide = true;
    if (!wide) thin.add(key(r,c));
  }
  while (thin.size) {
    const seed = thin.values().next().value, cells = new Set([seed]), queue = [seed];
    thin.delete(seed);
    for (let i = 0; i < queue.length; i++) {
      const [r,c] = queue[i].split(',').map(Number);
      for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const k = key(r+dr,c+dc);
        if (thin.delete(k)) { cells.add(k); queue.push(k); }
      }
    }
    if (cells.size < 2) continue; // isolated wall pockets are stops
    const zone = {id:[...cells].sort()[0], cells};
    for (const k of cells) zones.set(k, zone);
  }
  // Some mountain necks lie inside cells the coarse grid calls wide open.
  // Only published, clearance-checked fine necks receive this extra admission.
  for(const p of fineChokesFor(geo)){
    const cells=new Set();
    for(let r=Math.floor((p.y-32)/64);r<=Math.floor((p.y+32)/64);r++)
      for(let c=Math.floor((p.x-32)/64);c<=Math.floor((p.x+32)/64);c++)cells.add(key(r,c));
    const zone={id:`fine:${p.x}:${p.y}`,cells,fine:p};
    for(const k of cells)if(!zones.has(k))zones.set(k,zone);
  }
  cache.set(geo, {mask:geo._stepMask, zones});
  return zones;
}
const cellOf = p => key(Math.floor(p.y/64), Math.floor(p.x/64));
export function passageAlong(geo, from, target) {
  const zones = narrowPassages(geo), n = Math.max(1, Math.ceil(Math.hypot(target.x-from.x,target.y-from.y)/16));
  for (let i = 1; i <= n; i++) {
    const z = zones.get(cellOf({x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n}));
    if (z&&contains(z,{x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n})) return z;
  }
  return null;
}
const namespace = s => JSON.stringify([s.client?.host ?? s.host ?? '',s.client?.port ?? s.port ?? '',s.world?.room?.num]);
const contains=(zone,p)=>zone.fine?Math.abs(p.x-zone.fine.x)<=32&&Math.abs(p.y-zone.fine.y)<=32:zone.cells.has(cellOf(p));
export function releaseConfirmedPassage(session) {
  const held = session._passage, me = session.client?.self;
  if (!held || !me || me.predicted) return false;
  if (session.client.room?.id === held.roomId && contains(held.zone,me)) return false;
  if (held.file) releaseFilePassage(held.agent);
  else {const members=local.get(held.key);members?.delete(session);if(members?.size===0)local.delete(held.key);}
  session._passage = null;
  return true;
}
export function adoptPassageConvoy(session){
 const held=session._passage,c=session.client,me=c?.self,convoy=session.passageConvoy;
 if(!held||!convoy?.flow)return{adopted:false,reason:'no_owned_passage_or_convoy'};
 const name=c.me?.name??me?.name??c.rsc?.get?.(me?.nameRsc);
 if(!me||me.predicted||c.room?.id!==held.roomId||!contains(held.zone,me)||!convoy.characters?.includes(name))return{adopted:false,reason:'incumbent_body_or_membership_unconfirmed'};
 if(held.file){const reply=retagOwnFilePassage(held.agent,Number(session.world.room.num),held.zone.id,convoy.flow);if(!reply?.ok)return{adopted:false,reason:reply?.reason??'claim_unavailable'};}else{const members=local.get(held.key);if(!members?.has(session))return{adopted:false,reason:'local_claim_not_held'};members.set(session,convoy.flow);}
 held.flow=convoy.flow;return{adopted:true,zone:held.zone.id,flow:convoy.flow};
}
export function passageExitNeedsConfirmation(session, target) {
  return !!session._passage && !contains(session._passage.zone,target);
}
export function claimPassageMove(session, target) {
  releaseConfirmedPassage(session);
  const c = session.client, me = c?.self, geo = session.world?.geometry;
  if (!me || !geo?.collisionReady) return null;
  const zone = passageAlong(geo,me,target);
  if (!zone || contains(zone,me)) return null; // incumbents can leave
  const refusal = extra => ({available:true,moved:false,blocked:true,reason:'object_blocked',
    traffic:'passage_admission',zone:zone.id,...extra});
  if (session._passage) return refusal({note:'the previous passage exit is not confirmed'});
  for (const o of c.room?.objects?.values?.() ?? [])
    if (o.id !== c.selfId && (o.flags & OF.PLAYER) && contains(zone,o)&&!session.passageConvoy?.characters?.includes(typeof o.name==='string'?o.name:c.rsc?.get?.(o.nameRsc)))
      return refusal({objectId:o.id,note:'another player is still in the passage'});
  const agent = String(session.name ?? c.selfId), resource = namespace(session)+'|'+zone.id;
  const flow=session.passageConvoy?.flow??null;
  const file = reserveFilePassage(agent, Number(session.world.room.num), zone.id,{flow});
  if (file && !file.ok) return refusal({note:'another keeper holds passage admission',holder:file.agent,admission_reason:file.reason??'conflicting_flow'});
  if (!file) {
    const members=local.get(resource)??new Map();
    if([...members].some(([owner,heldFlow])=>owner!==session&&!(flow&&heldFlow===flow)))return refusal({note:'another session holds passage admission'});
    members.set(session,flow);local.set(resource,members);
  }
  session._passage = {zone,agent,file:!!file,key:resource,roomId:c.room.id,flow};
  return null;
}
