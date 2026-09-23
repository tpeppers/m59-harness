// Exact precomputed ceiling geometry, separate from legacy floor door variants.
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, applySectorHeights, STEP_MASK_VERSION } from './m59-roo.mjs';
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
  const heights = definition.doors.map(d => {
    const seen = observed.get(d.id);
    return seen?.type === 5 ? seen.height : (d.shipped ?? d.closed);
  });
  const key = heights.join(','), state = definition.states[key];
  if (!state) return null;
  let changed = false;
  if (current.get(geometry) !== key) {
    const result = applySectorHeights(geometry, state.sectors, { mask: Buffer.from(state.mask, 'base64') });
    if (result.why && result.why !== 'already at that height') return null;
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
  const door = event?.type === 5 && definition.doors.find(d => d.id === event.sector);
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
