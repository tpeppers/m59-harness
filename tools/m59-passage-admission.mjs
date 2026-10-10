// #movement: admit one body to a connected narrow passage, in either direction.
// Geometry identifies candidates; collision remains the packet proof.
import {reserveFilePassage, releaseFilePassage} from './m59-spotclaims.mjs';
import {OF} from './m59-parse.mjs';
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
  cache.set(geo, {mask:geo._stepMask, zones});
  return zones;
}
const cellOf = p => key(Math.floor(p.y/64), Math.floor(p.x/64));
export function passageAlong(geo, from, target) {
  const zones = narrowPassages(geo), n = Math.max(1, Math.ceil(Math.hypot(target.x-from.x,target.y-from.y)/16));
  for (let i = 1; i <= n; i++) {
    const z = zones.get(cellOf({x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n}));
    if (z) return z;
  }
  return null;
}
const namespace = s => JSON.stringify([s.client?.host ?? s.host ?? '',s.client?.port ?? s.port ?? '',s.world?.room?.num]);
export function releaseConfirmedPassage(session) {
  const held = session._passage, me = session.client?.self;
  if (!held || !me || me.predicted) return false;
  if (session.client.room?.id === held.roomId && held.zone.cells.has(cellOf(me))) return false;
  if (held.file) releaseFilePassage(held.agent);
  else if (local.get(held.key) === session) local.delete(held.key);
  session._passage = null;
  return true;
}
export function passageExitNeedsConfirmation(session, target) {
  return !!session._passage && !session._passage.zone.cells.has(cellOf(target));
}
export function claimPassageMove(session, target) {
  releaseConfirmedPassage(session);
  const c = session.client, me = c?.self, geo = session.world?.geometry;
  if (!me || !geo?.collisionReady) return null;
  const zone = passageAlong(geo,me,target);
  if (!zone || zone.cells.has(cellOf(me))) return null; // incumbents can leave
  const refusal = extra => ({available:true,moved:false,blocked:true,reason:'object_blocked',
    traffic:'passage_admission',zone:zone.id,...extra});
  if (session._passage) return refusal({note:'the previous passage exit is not confirmed'});
  for (const o of c.room?.objects?.values?.() ?? [])
    if (o.id !== c.selfId && (o.flags & OF.PLAYER) && zone.cells.has(cellOf(o)))
      return refusal({objectId:o.id,note:'another player is still in the passage'});
  const agent = String(session.name ?? c.selfId), resource = namespace(session)+'|'+zone.id;
  const file = reserveFilePassage(agent, Number(session.world.room.num), zone.id);
  if (file && !file.ok) return refusal({note:'another keeper holds passage admission',holder:file.agent});
  if (!file) {
    const owner = local.get(resource);
    if (owner && owner !== session) return refusal({note:'another session holds passage admission'});
    local.set(resource,session);
  }
  session._passage = {zone,agent,file:!!file,key:resource,roomId:c.room.id};
  return null;
}
