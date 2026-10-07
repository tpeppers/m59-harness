// Exact precomputed ceiling geometry, separate from legacy floor door variants.
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, applySectorHeights, STEP_MASK_VERSION, RoomGeometry, exitSquaresOf } from './m59-roo.mjs';
import { forgetReach, applyDoorState, noteDoorState } from './m59-routes.mjs';

const table = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)));
const current = new WeakMap();
const animations = new WeakMap();
// M59Client publishes onEvent; it is not a Node EventEmitter. Optional `.on`
// calls silently did nothing, leaving every keeper on its original door mask.
export function installDoorObserver(client, map, roomNumber, report = () => {}) {
  const previous = client.onEvent;
  const update = event => {
    const num = Number(roomNumber());
    if (!Number.isFinite(num)) return;
    if (event.kind === 'room-entered') {
      applyCeilingDoors(map, num, new Map());
      applyDoorState(map, num, new Map());
      return;
    }
    if (event.kind !== 'sector-height') return;
    const ceiling = applyCeilingDoors(map, num, client.room.sectorHeights ?? new Map(), event);
    const invalidated = client.room.collisionInvalidated;
    if (ceiling?.settledAt != null && invalidated?.sector === event.sector) {
      invalidated.until = ceiling.settledAt;
      invalidated.sectorIndices = ceiling.sectorIndices;
    }
    const result = ceiling ?? applyDoorState(map, num, client.room.sectorHeights ?? new Map());
    report(num, result);
  };
  client.onEvent = event => { previous?.(event); update(event); };
  update({ kind: 'room-entered' });
  // join has already received the room's replay before this observer attaches.
  for (const [sector, data] of client.room.sectorHeights ?? []) update({ kind: 'sector-height', sector, ...data });
}
export function applyCeilingDoors(map, roomNum, observed, event = null, { geometryOf, now = Date.now() } = {}) {
  const definition = table.version === STEP_MASK_VERSION && table.rooms[roomNum];
  if (!definition) return null;
  const room = map.rooms[roomNum], geometry = geometryOf ? geometryOf(room) : sharedRoomGeometry(room);
  if (!geometry || geometry.security !== definition.security) return null;
  // A DOOR WE HAVE NOT SEEN MOVE IS WHERE THE .roo SHIPS IT, WHICH IS NOT ALWAYS SHUT.
  // The room replay carries the sectors that have moved, so on entry most doors are unknown
  // and this fallback decides the whole state. Room 714 ships all five shut, which is why
  // `d.closed` looked right; rooms 380, 598 and one of 750's two ship OPEN, and assuming shut
  // there applies a sealed mask to a standing-open passage — the router then calls it no
  // route, which is the exact failure this table exists to prevent. `shipped` is read off the
  // .roo by the bake; `?? d.closed` keeps a table baked before it worked as it did.
  //
  // A DOOR THAT IS A RUN OF SECTORS (`ids`, the Wryn's Keep entrance: 1, 2, 3 raised one second
  // apart) is at a height only when EVERY sector of the run has been seen there. Part-way
  // through the run the passage is still shut by the sectors that have not moved, so anything
  // short of all of them reads as the resting height — never as open.
  const heights = definition.doors.map(d => {
    const seen = (d.ids ?? [d.id]).map(id => observed.get(id));
    const h = seen[0]?.type === 5 ? seen[0].height : null;
    return h != null && seen.every(x => x?.type === 5 && x.height === h) ? h : (d.shipped ?? d.closed);
  });
  const key = heights.join(','), state = definition.states[key];
  if (!state) return null;
  let changed = false;
  if (current.get(geometry) !== key) {
    const mask = Buffer.from(state.mask, 'base64');
    const result = applySectorHeights(geometry, state.sectors, { mask });
    if (result.why && result.why !== 'already at that height') return null;
    // A fresh per-client geometry can already have these heights without a
    // routing mask. applySectorHeights returns early in that case.
    if (!geometry.attachStepMask(mask)) return null;
    changed = result.moved > 0; current.set(geometry, key);
    if (changed) forgetReach(roomNum);
  }
  // RECORDED WHERE THE REST OF THE SYSTEM LOOKS. `current` is a WeakMap private to this file,
  // so until now nothing outside could tell that a ceiling room had a state applied at all.
  // Two things read `doorStates()` and both were getting `null` for every one of these rooms:
  // the keeper's `doors.applied` report, and — the one that costs a walk — the gate in
  // `reachableByDoor` that decides whether to ask the LIVE geometry or fall back to the baked,
  // doors-shut answer. Set unconditionally rather than only on `changed`, because "the room is
  // in this state" is true whether or not this call is what put it there.
  noteDoorState(roomNum, key);
  const door = event?.type === 5 && definition.doors.find(d => (d.ids ?? [d.id]).includes(event.sector));
  // Stock client MoveSector: duration = abs(dest-source) / speed seconds.
  // Use the full open/closed span even for a reversal part way through a lift.
  const settledAt = door && Number.isFinite(event.speed) && event.speed >= 0
    ? now + (event.speed === 0 ? 0 : Math.ceil(Math.abs(door.open - door.closed) * 1000 / event.speed) + 100)
    : null;
  const active = event ? (animations.get(geometry) ?? new Map()) : new Map();
  for (const [id, animation] of active) if (animation.until <= now) active.delete(id);
  if (settledAt != null) active.set(event.sector, { until: settledAt, indices: door.indices });
  animations.set(geometry, active);
  return { changed, state: key,
    settledAt: settledAt == null ? null : Math.max(settledAt, ...[...active.values()].map(a => a.until)),
    sectorIndices: [...new Set([...active.values()].flatMap(a => a.indices))] };
}

// WHICH DOOR FIRST, WHEN SEVERAL STAND BETWEEN A BODY AND WHERE IT IS GOING.
//
// The Wryn's Keep (704) has an entrance run and four inner doors. A body in the master's wing
// is behind MASTERDOOR and the entrance, and "the nearest trigger it can walk to" opened the
// ASSISTDOOR beside it instead: reachable, and useless. This answers with the first door of the
// SHORTEST chain whose opening makes one of `targets` reachable. It asks the baked states in
// this table on a PRIVATE copy of the room, so the live geometry is never touched. Each node is
// a set of open doors plus the square the body would be standing on; a door is a step only if
// its trigger can be walked to in that node's state. `plans` are m59-doorplan press plans;
// `observed` is the live sector heights, so a door already up counts as open. Returns
// `{ sector, at, chain }`, `{ already: true }` when nothing need open, or null when this table
// cannot say (no room, wrong version, or no chain within `maxDepth`).
const PRIVATE_GEOMETRY = new WeakMap();
export function planDoorChain(map, roomNum, from, targets, plans,
                              { observed = new Map(), maxDepth = 3 } = {}) {
  const def = table.version === STEP_MASK_VERSION && table.rooms[roomNum];
  const room = map?.rooms?.[roomNum];
  if (!def || !room?.roo || !targets?.length || !plans?.length || !from) return null;
  let g = PRIVATE_GEOMETRY.get(room.roo);
  if (!g) {
    g = RoomGeometry.fromJSON(room.roo);
    g.roomNum = Number(roomNum);
    g.exitSquares = exitSquaresOf(room);
    PRIVATE_GEOMETRY.set(room.roo, g);
  }
  if (g.security !== def.security) return null;
  const doorOf = sector => def.doors.find(d => (d.ids ?? [d.id]).includes(Number(sector)));
  const setState = open => {
    const st = def.states[def.doors.map(d => open.has(d.id) ? d.open : (d.shipped ?? d.closed)).join(',')];
    if (!st) return false;
    const mask = Buffer.from(st.mask, 'base64');
    const r = applySectorHeights(g, st.sectors, { mask });
    if (r.why && r.why !== 'already at that height') return false;
    return g.attachStepMask(mask);
  };
  const reach = (a, b) => !!g.path(a.row, a.col, b.row, b.col)?.found;
  const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
  const initial = new Set(def.doors.filter(d => (d.ids ?? [d.id]).every(id => {
    const h = observed?.get?.(id);
    return h?.type === 5 && h.height === d.open;
  })).map(d => d.id));
  const queue = [{ open: initial, at: { row: from.row, col: from.col }, chain: [] }];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    const key = `${[...node.open].sort((a, b) => a - b)}|${node.at.row},${node.at.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!setState(node.open)) continue;
    if (targets.some(t => reach(node.at, t)))
      return node.chain.length ? { ...node.chain[0], chain: node.chain } : { already: true };
    if (node.chain.length >= maxDepth) continue;
    for (const p of plans) {
      const d = doorOf(p.sector);
      if (!d || node.open.has(d.id)) continue;
      const sq = (p.stand_on ?? []).slice().sort((x, y) => cheb(x, node.at) - cheb(y, node.at))
        .find(s => reach(node.at, s));
      if (!sq) continue;
      queue.push({ open: new Set([...node.open, d.id]), at: sq,
                   chain: [...node.chain, { sector: p.sector, at: sq }] });
    }
  }
  return null;
}
/** Prepare a private, conditional door state without changing the live room. */
export function previewOpenedDoor(map, roomNum, sector, { observed = new Map() } = {}) {
  const def = table.version === STEP_MASK_VERSION && table.rooms[roomNum],room=map?.rooms?.[roomNum];
  if(!def||!room?.roo)return null;
  const selected=def.doors.find(d=>(d.ids??[d.id]).includes(Number(sector)));if(!selected)return null;
  const heights=def.doors.map(d=>{
    if(d===selected)return d.open;
    const seen=(d.ids??[d.id]).map(id=>observed.get(id));
    return seen[0]?.type===5&&seen.every(x=>x?.type===5&&x.height===seen[0].height)?seen[0].height:(d.shipped??d.closed);
  });
  const key=heights.join(','),state=def.states[key];if(!state)return null;
  const geometry=RoomGeometry.fromJSON(room.roo);if(geometry.security!==def.security)return null;
  geometry.roomNum=Number(roomNum);geometry.exitSquares=exitSquaresOf(room);
  const mask=Buffer.from(state.mask,'base64'),result=applySectorHeights(geometry,state.sectors,{mask});
  if(result.why&&result.why!=='already at that height')return null;
  if(!geometry.attachStepMask(mask))return null;
  return {geometry,state:key,sector:Number(sector),conditional:true,
    requires:'matching normal server opening and live collision checks before each move'};
}
