#!/usr/bin/env node
// The agent's world model: everything known about where it is standing, assembled
// into one thing it can read and act from.
//
// A protocol client gives you a list of objects with coordinates. That is not enough
// to play. An agent also needs to know which of those objects it can actually reach,
// which way is out, what the room is shaped like, and — because every request costs
// a second — which of the things it might do are possible at all before it spends a
// request finding out.
//
// So this module joins three sources that live in three different places:
//
//   perception   BP_ROOM_CONTENTS etc, from m59-parse — ids, names, positions, flags
//   the graph    substrate/m59-map.json, from m59-map — which rooms connect and how
//   geometry     the .roo walkability grid, from m59-roo — what is walkable, and paths
//
// and renders the join as a minimap with everything placed on it, which is the same
// picture the human client draws in its corner and the densest single artifact either
// a person or an agent can look at.
//
// COORDINATE CONTRACT: public/perception squares use named 1-based `{col,row}`;
// positional RoomGeometry calls use `(row,col)`. Object and exit `{x,y}` fields
// are 64-units-per-square kod wire points unless explicitly labelled client/BSP.

import { sharedRoomGeometry, roomHasDeclaredFallJump } from './m59-roo.mjs';
import { exitsOf, findPath, inferredExits, codeExits, edgeExitsOf, edgeCandidatesOf, LEAVE,
         AVOID_IN_TRANSIT, selectedEdgeAt, routingRevision } from './m59-map.mjs';
import { inRegion } from './m59-codeexits.mjs';
import { affordances, OF, isTeleporter, KOD_FINENESS } from './m59-parse.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
import { observedCrossings } from './m59-crossings.mjs';
import { activeRoutes, anchorFor, sameRegion, anchorReach } from './m59-routes.mjs';
import { resolveRoomWire } from './m59-room-wire.mjs';

// Marks used on the minimap. Chosen so the picture stays readable in a terminal and
// so the important things are the ones that stand out: you, then players, then
// whatever you can fight or trade with.
const MARK = {
  self: '@',
  player: 'P',
  exit: 'X',
  locked: 'x',
};
// The flood-priced portion of exits() is identical for every World using the same shared
// map, room geometry, and origin square. Keep it at module scope so a fleet pays once, but
// let the map remain the owner: a test/alternate map gets its own LRU and can be collected.
// Dynamic portal objects are deliberately appended outside this cache below.
// A legacy keeper process has one actor and keeps its historical 24-origin memory bound.
// The lab runtime amortizes one atlas across a fleet, so its shared LRU is sized for many
// actors by default. Either profile can override the bound explicitly.
// 512 ORIGINS FOR EVERYONE. The 24-origin default meant a touring keeper missed this cache
// on nearly every room and re-ran the flood; the cost of 512 cached floods is small against
// the seconds each miss spends with the event loop blocked. M59_WORLD_EXIT_CACHE_CAP still
// overrides, and the route/exit cache suite pins the behaviour at 24 explicitly.
const defaultSharedExitCap = 512;
const configuredSharedExitCap = Number(
  process.env.M59_WORLD_EXIT_CACHE_CAP ?? defaultSharedExitCap);
const SHARED_EXIT_CACHE_CAP = Number.isSafeInteger(configuredSharedExitCap) && configuredSharedExitCap > 0
  ? configuredSharedExitCap : defaultSharedExitCap;
// Keep at most the current static result on a World for compatibility with diagnostics
// that inspect/clear `_exitCache`; the fleet-sized history lives only in the shared LRU.
const LOCAL_EXIT_CACHE_CAP = 1;
const sharedExitCacheByMap = new WeakMap();
function sharedExitCache(map) {
  if (!map || (typeof map !== 'object' && typeof map !== 'function')) return null;
  let state = sharedExitCacheByMap.get(map);
  if (!state || state.revision !== routingRevision) {
    state = { revision: routingRevision, entries: new Map() };
    sharedExitCacheByMap.set(map, state);
  }
  return state.entries;
}
function touchCache(cache, key, value, cap) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > cap) cache.delete(cache.keys().next().value);
}
function immutableExitCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableExitCopy));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = immutableExitCopy(child);
    return Object.freeze(copy);
  }
  return value;
}
// Everything else gets a letter, and the legend says what each one is.
const OBJECT_MARKS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// A portal announces itself after all: OF_MOVEON_TELEPORTER lives in the low two
// bits of the object flags (include/proto.h:417, "kod will move you elsewhere").
// That is authoritative, so the name is only used to LABEL what the flag found.
const PORTAL_NAME = /(portal|rip in space|gateway|vortex|moongate)/i;

// Exported because the broker's keeper-backed render projection has to name a facing the
// same way this file does. A second copy of the table is a second answer.
export const dirName = deg => {
  const names = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};

// The protocol object is already the renderer's authority. Keep its animation
// vocabulary intact rather than guessing a current frame: group numbers are KOD's
// 1-based BGF groups, and cycle/once animations need their whole range to reproduce
// what the native client draws.
function renderAnimation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    type: Number.isInteger(value.animation) ? value.animation : null,
    group: Number.isInteger(value.group) ? value.group : null,
    period: Number.isInteger(value.period) ? value.period : null,
    group_low: Number.isInteger(value.groupLow) ? value.groupLow : null,
    group_high: Number.isInteger(value.groupHigh) ? value.groupHigh : null,
    group_final: Number.isInteger(value.groupFinal) ? value.groupFinal : null,
  };
}

function iconResource(c, iconRsc) {
  if (iconRsc === null) return null;
  // ResourceTable.get deliberately invents a readable placeholder for unknown ids.
  // That is helpful in prose and wrong for a renderer: `<rsc 123>` is not a file.
  if (typeof c.rsc?.has === 'function' && !c.rsc.has(iconRsc)) return null;
  const value = c.rsc?.get?.(iconRsc);
  if (typeof value !== 'string' || /^<(?:rsc|dynamic)\s+\d+>$/.test(value)) return null;
  return value;
}

function renderLight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    flags: Number.isInteger(value.flags) ? value.flags : null,
    intensity: Number.isInteger(value.intensity) ? value.intensity : null,
    color: Number.isInteger(value.color) ? value.color : null,
  };
}

function renderOverlay(c, value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const iconRsc = Number.isInteger(row.iconRsc) ? row.iconRsc : null;
  return {
    icon_rsc: iconRsc,
    icon_resource: iconResource(c, iconRsc),
    // Attachment number only. Over/under ordering comes from the matching hotspot
    // sign in the selected BGF frame, so preserve this byte without interpreting it.
    hotspot: Number.isInteger(row.hotspot) ? row.hotspot : null,
    translation: Number.isInteger(row.translation) ? row.translation : null,
    effect: Number.isInteger(row.effect) ? row.effect : null,
    animation: renderAnimation(row.animate),
  };
}

function renderLayer(c, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    translation: Number.isInteger(value.translation) ? value.translation : null,
    effect: Number.isInteger(value.effect) ? value.effect : null,
    animation: renderAnimation(value.animate),
    overlays: (Array.isArray(value.overlays) ? value.overlays : []).map(row => renderOverlay(c, row)),
  };
}

export function renderState(c, value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const iconRsc = Number.isInteger(row.iconRsc) ? row.iconRsc : null;
  return {
    // Fine coordinates are the exact 1/64-square wire values. col/row remain beside
    // them for tactical code, but are too coarse for smooth isometric movement.
    x: Number.isInteger(row.x) ? row.x : null,
    y: Number.isInteger(row.y) ? row.y : null,
    angle: Number.isInteger(row.angle) ? row.angle : null,
    facing_degrees: Number.isFinite(row.degrees) ? row.degrees : null,
    // Local monotonic trigger token, not a server id or a time. A renderer resets
    // ANIMATE_ONCE only when this changes; comparing descriptors cannot distinguish
    // two identical consecutive attacks.
    appearance_revision: Number.isInteger(row.appearanceRevision) ? row.appearanceRevision : null,
    appearance: {
      icon_rsc: iconRsc,
      icon_resource: iconResource(c, iconRsc),
      flags: Number.isInteger(row.flags) ? row.flags : null,
      rarity: Number.isInteger(row.rarity) ? row.rarity : null,
      light: renderLight(row.light),
      translation: Number.isInteger(row.translation) ? row.translation : null,
      effect: Number.isInteger(row.effect) ? row.effect : null,
      animation: renderAnimation(row.animate),
      overlays: (Array.isArray(row.overlays) ? row.overlays : []).map(overlay => renderOverlay(c, overlay)),
      motion: renderLayer(c, row.motion),
    },
  };
}

// Inert furniture, as a tally rather than a list. Keeps the ids so an agent that
// wants to look at a tree still can, but spends one line on sixty plants instead
// of sixty. Only ever called with objects that have NO affordances — see snapshot.
function summariseScenery(list) {
  const kinds = {};
  for (const o of list) {
    const k = o.name || 'unknown';
    (kinds[k] ??= { count: 0, ids: [] }).count++;
    if (kinds[k].ids.length < 6) kinds[k].ids.push(o.id);
  }
  return {
    total: list.length,
    kinds: Object.fromEntries(Object.entries(kinds)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, v.count === 1 ? { id: v.ids[0] } : { count: v.count, ids: v.ids }])),
    note: 'no affordances — decoration only. Everything you can act on, every ' +
          'player, and everything holding a quantity is in `objects` above, in full.',
  };
}

// A ROOM NUMBER IS NOT NECESSARILY ONE CONNECTED FLOOR.
//
// Castle Victoria's upstairs is the worked example. The west and east wings are one
// `Room` object and one .roo file, but a solid wall separates them. A player changes
// wings by going downstairs and immediately taking the other staircase; a monster can
// never do that because monsters do not use `go` exits. Consequently `travel(39)` is
// already "done" while standing in the wrong wing, and an in-room path to a west-side
// quarry from the east side correctly says there is no route.
//
// Find the small route the room graph normally hides: current room -> bridge room ->
// the SAME room, landing in the target's connected component. This is deliberately a
// plan only. The broker remains the authority for walking through each exact doorway.
// Keeping it data-driven makes the rule useful for any other split room authored the
// same way rather than baking Castle Victoria coordinates into combat code.
// A DOOR THAT LEADS BACK INTO THE ROOM IT IS IN.
//
// `sameRoomIslandBridgePlan` above joins two parts of one room by going out through a
// NEIGHBOURING room and back. Some rooms do not need the detour, because the map authors
// wrote the shortcut directly: a `go` exit whose destination room IS this room. Castle
// Victoria has four of them (castle1.kod:88-98), each a pair -
//
//     plExits = Cons([ 9, 32, RID_CASTLE1,  7, 32, ROTATE_NONE ])   south side -> north
//     plExits = Cons([ 8, 32, RID_CASTLE1, 10, 32, ROTATE_NONE ])   north side -> south
//
// - one row either side of a wall, each landing two rows beyond it. They are doors through
// an internal wall, and they are the only way between the halves of that room.
//
// NOTHING PLANNED THROUGH THEM, because a room graph discards a self-loop. Room 38's floor
// is 23 disconnected regions; its entrances from rooms 2, 39 and 40 all land in region 0,
// and the trapdoor down to the Underbasement (41) is at r4c33 in region 3. `anchorReach`
// is false from every square in the body, and correctly so: there is no WALK. Travel to 41
// therefore had no reachable candidate for its last hop and ground against the wall until
// it timed out. Eleven rooms in this map carry a door back into themselves, four of them
// splitting anchors across regions the same way.
//
// THE COORDINATES ARE THE KOD'S OWN. `plExits = [25, 2, RID_CASTLE1, 5, 32]` in dungeon.kod
// is `{row:25, col:2, to:38, arriveRow:5, arriveCol:32}` in the bake, digit for digit, so
// there is no offset to apply here - which is worth stating because almost everything else
// about coordinates in this repository does need one.
//
// A PLAN ONLY, like its neighbour above. Walking each doorway stays with the mover.

/**
 * The `go` exits of this room that lead back into it.
 *
 * @param {object} room  a room record from the map
 * @returns {object[]}   usable internal doors, each with its landing square
 */
export function sameRoomDoors(room) {
  const num = Number(room?.num);
  if (!Number.isFinite(num)) return [];
  return (room?.goExits ?? []).filter(e =>
    !e.locked && Number(e.to) === num &&
    Number.isFinite(e.row) && Number.isFinite(e.col) &&
    Number.isFinite(e.arriveRow) && Number.isFinite(e.arriveCol));
}

/**
 * Which internal doors join where we are standing to any of these squares.
 *
 * Returns `null` when no door is needed (a plain walk reaches one of them) and equally
 * when no sequence of doors reaches any - the two are told apart by `walkable`, because a
 * caller must never read "no doors needed" as "go and walk it" without checking.
 *
 * @param {object} map
 * @param {number} roomNum
 * @param {object} geo        room geometry, as the MOVER enforces it (step masks attached)
 * @param {{row:number,col:number}} from
 * @param {{row:number,col:number}[]} targets  any one of which is good enough
 * @param {{maxDoors?:number}} [opts]
 * @returns {{doors:object[], target:object, walkable:boolean}|null}
 */
export function sameRoomDoorPlan(map, roomNum, geo, from, targets = [], { maxDoors = 4 } = {}) {
  const room = map?.rooms?.[roomNum];
  const wanted = [].concat(targets ?? []).filter(t => Number.isFinite(t?.row) && Number.isFinite(t?.col));
  if (!room || !geo || !from || !wanted.length) return null;
  const doors = sameRoomDoors(room);
  if (!doors.length) return null;

  // SNAPPING TO THE FLOOR IS BOUNDED, and its neighbour above does not bound it.
  //
  // A `go` square is very often a pocket the coarse grid calls unwalkable — that is what
  // makes the snap necessary — but `nearestWalkable` searches until it finds something, so
  // an unreachable target does not fail, it silently becomes a DIFFERENT PLACE and the plan
  // then succeeds at going somewhere nobody asked for. A doorway pocket is one or two
  // squares from real floor; anything further away is not the square that was named.
  const SNAP = 3;
  const onFloor = p => {
    if (geo.walkable(p.row, p.col)) return { row: p.row, col: p.col };
    const near = geo.nearestWalkable(p.row, p.col);
    if (!near) return null;
    return (Math.abs(near.row - p.row) <= SNAP && Math.abs(near.col - p.col) <= SNAP)
      ? { row: near.row, col: near.col } : null;
  };
  const canWalk = (a, b) => {
    if (!a || !b) return false;
    if (a.row === b.row && a.col === b.col) return true;
    return geo.path(a.row, a.col, b.row, b.col, { fine: true }).found;
  };

  // A DOOR SQUARE IS OFTEN NOT WALKABLE IN THIS ROOM'S OWN GRID, and that must not read as
  // "cannot reach the door". It is the doorway tile - a pocket by design, which is what
  // `exits()` already says about every `go` square - and the mover leans into it from the
  // square beside it against the fine BSP. So reaching any neighbour counts as reaching it.
  const reachesDoor = (origin, door) => {
    if (canWalk(origin, { row: door.row, col: door.col })) return true;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const p = { row: door.row + dr, col: door.col + dc };
      if (geo.walkable(p.row, p.col) && canWalk(origin, p)) return true;
    }
    return false;
  };

  const start = onFloor(from);
  if (!start) return null;
  const goals = wanted.map(t => ({ want: t, at: onFloor(t) })).filter(g => g.at);
  if (!goals.length) return null;
  const arrived = origin => goals.find(g => canWalk(origin, g.at)) ?? null;

  const here = arrived(start);
  if (here) return { doors: [], target: here.want, walkable: true };

  // Breadth first over LANDINGS, so the plan that uses fewest doors wins. The state is the
  // square a door put us on; a door is never taken twice in one plan, which bounds this at
  // the number of doors in the room and stops a pair of doors facing each other looping.
  const seen = new Set();
  let frontier = [{ at: start, used: [] }];
  for (let depth = 0; depth < maxDoors && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const door of doors) {
        const key = `${door.row},${door.col}`;
        if (node.used.some(d => d.row === door.row && d.col === door.col)) continue;
        if (!reachesDoor(node.at, door)) continue;
        const landing = onFloor({ row: door.arriveRow, col: door.arriveCol });
        if (!landing) continue;
        const landKey = `${landing.row},${landing.col}`;
        if (seen.has(landKey)) continue;
        seen.add(landKey);
        const used = [...node.used, door];
        const done = arrived(landing);
        if (done) return { doors: used, target: done.want, walkable: false };
        next.push({ at: landing, used });
      }
    }
    frontier = next;
  }
  return null;
}

export function sameRoomIslandBridgePlan(map, roomNum, geo, from, target) {
  const room = map?.rooms?.[roomNum];
  if (!room || !geo || !from || !target) return null;

  const onFloor = p => {
    if (geo.walkable(p.row, p.col)) return { row: p.row, col: p.col };
    const near = geo.nearestWalkable(p.row, p.col);
    return near ? { row: near.row, col: near.col } : null;
  };
  const start = onFloor(from), goal = onFloor(target);
  if (!start || !goal) return null;
  if (geo.path(start.row, start.col, goal.row, goal.col, { fine: true }).found) return null;

  // Door squares can themselves be absent from the one-byte grid. In that case being
  // able to reach a neighbouring square is enough: leaveVia performs the final fine
  // movement/door lean and locally clips the exact point against the fine BSP.
  const routeToDoor = (origin, door) => {
    const candidates = [{ row: door.row, col: door.col }];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      candidates.push({ row: door.row + dr, col: door.col + dc });
    }
    let best = null;
    for (const p of candidates) {
      if (!geo.walkable(p.row, p.col)) continue;
      const r = geo.path(origin.row, origin.col, p.row, p.col, { fine: true });
      if (r.found && (!best || r.steps.length < best.steps))
        best = { steps: r.steps.length, approach: p };
    }
    return best;
  };

  const outward = (room.goExits || []).filter(e => !e.locked && e.to != null && e.to !== room.num);
  for (const viaNum of [...new Set(outward.map(e => e.to))]) {
    const leaveDoors = outward
      .filter(e => e.to === viaNum)
      .map(e => ({ ...e, route: routeToDoor(start, e) }))
      .filter(e => e.route)
      .sort((a, b) => a.route.steps - b.route.steps);
    if (!leaveDoors.length) continue;

    const via = map.rooms?.[viaNum];
    if (!via) continue;
    const returnDoors = (via.goExits || []).filter(e => {
      if (e.locked || e.to !== room.num || e.arriveRow == null || e.arriveCol == null) return false;
      const landing = onFloor({ row: e.arriveRow, col: e.arriveCol });
      return !!landing && geo.path(landing.row, landing.col, goal.row, goal.col, { fine: true }).found;
    });
    if (!returnDoors.length) continue;

    return {
      fromRoom: room.num,
      fromName: room.name,
      viaRoom: via.num,
      viaName: via.name,
      leaveDoors: leaveDoors.map(e => ({ row: e.row, col: e.col, to: e.to })),
      returnDoors: returnDoors.map(e => ({
        row: e.row, col: e.col, to: e.to,
        arriveRow: e.arriveRow, arriveCol: e.arriveCol,
      })),
      target: { row: goal.row, col: goal.col },
      why: 'the quarry is in another connected part of this room; players can change ' +
           'parts through the intervening room, while monsters cannot use those doors',
    };
  }
  return null;
}

export class World {
  // `client` is an M59Client; `map` is the parsed substrate/m59-map.json.
  constructor(client, map) {
    this.c = client;
    this.map = map;
  }

  // Which room are we in, as a room NUMBER? The protocol never says. BP_PLAYER
  // carries the room's name resource and room resource (User.ToCliPlayer sends
  // GetRoomResource and GetName). This legacy tactical lookup accepts either;
  // room resources do collide for guest/newbie and rentable rooms, so bound
  // provenance below requires the complete pair and a unique map row. Object ids
  // work only until the next `save game` renumbers them, hence the last fallback.
  get room() {
    if (!this.map) return null;
    const c = this.c;
    // MEMOISED on the client's room identity. This getter rebuilt the rooms array and scanned
    // it on every access, and it is on the walker's hot path: the keeper's own profiler put
    // it in every event-loop stall of 2026-09-02. The map object is part of the key, so a
    // reloaded map never serves a stale room.
    const key = `${c.roomNameRsc ?? ''}|${c.roomRsc ?? ''}|${c.room?.id ?? ''}`;
    const memo = this._roomMemo;
    if (memo && memo.map === this.map && memo.key === key) return memo.room;
    const rooms = Object.values(this.map.rooms);
    let hit = null;
    if (c.roomNameRsc) hit = rooms.find(r => r.nameRsc === c.roomNameRsc) ?? null;
    if (!hit && c.roomRsc) hit = rooms.find(r => r.roomRsc === c.roomRsc) ?? null;
    if (!hit && c.room?.id != null) hit = rooms.find(r => r.objId === c.room.id) ?? null;
    this._roomMemo = { map: this.map, key, room: hit };
    return hit;
  }

  // Bound provenance is deliberately stricter than the legacy room lookup above.
  // Tactical/display callers keep its historical fallbacks, while a renderer gets
  // a wire tuple only when the complete BP_PLAYER resource pair selects one row.
  get roomBinding() {
    const roomWire = resolveRoomWire(this.c, this.map);
    if (!roomWire) return null;
    const room = this.map.rooms[String(roomWire.resolved_room_num)];
    return room ? { room, room_wire: roomWire } : null;
  }

  get roomWire() { return this.roomBinding?.room_wire ?? null; }

  get geometry() {
    const room = this.room;
    if (!room?.roo) return null;
    return sharedRoomGeometry(room);
  }

  get self() { return this.c.self; }

  // ------------------------------------------------------------------ reach

  // Where to measure distances FROM.
  //
  // Normally that is simply where you are standing, but you can be standing
  // somewhere the movement grid calls solid rock. Arriving by teleport does it — a
  // character killed and sent to the Underworld landed on (11,32) of a 32-row room,
  // a square with no floor — and so does fine movement along a ledge, where the real
  // geometry is finer than the one-byte-per-square grid.
  //
  // A search rooted on an unwalkable square expands to nothing, so EVERY object came
  // back unreachable and the Underworld escape concluded that none of the portals
  // worked, when it had never taken a step toward one. Measuring from the nearest
  // real floor instead is honest — walkTo steps off the bad square by itself — and
  // it is what exits() has always done. Reachability of objects should not disagree
  // with reachability of exits about where the character is.
  origin() {
    const me = this.self, geo = this.geometry;
    if (!me || !geo) return me ?? null;
    if (geo.walkable(me.row, me.col)) return me;
    const near = geo.nearestWalkable(me.row, me.col);
    return near ? { ...me, row: near.row, col: near.col, offGrid: true } : me;
  }

  // Can we get there, and in how many steps? This is the question the raw protocol
  // cannot answer and an agent most needs answered, because the cost of finding out
  // by walking is one second per step and a wrong guess is a wasted minute.
  // COORDINATE CONTRACT: this movement-facing API is `(col,row)`; the call to
  // RoomGeometry.path below deliberately adapts it to geometry `(row,col)`.
  reach(toCol, toRow) {
    const me = this.origin(), geo = this.geometry;
    if (!me) return { reachable: null, why: 'own position unknown' };
    if (!geo) return { reachable: null, why: 'no geometry for this room' };
    if (me.col === toCol && me.row === toRow) return { reachable: true, steps: 0, path: [] };
    // NO CLEARANCE PREFERENCE HERE, AND THE SAFE-SPOT RANKING IS WHY.
    //
    // `path`'s clearance cost keeps LONG routes off the walls, which is right for crossing
    // a room and wrong for this: `nearestSafeSpot` ranks candidates at -0.5 per step of
    // whatever this returns, so a preference that lengthens the approach quietly becomes a
    // penalty ON THE SPOT ITSELF. Measured against the recorded book: 36.7% of walks to a
    // held safe wall came back longer, worst case +9 steps — 4.5 points against a proof
    // bonus of 20 — and it fell hardest on the walls that are hardest to walk into, which
    // are the best ones. A SAFE WALL IS A TIGHT SQUARE BY DEFINITION; the fleet must not
    // be taught to shy away from the thing the game is balanced around.
    //
    // So this answers the tactical question — how far is that square, really — exactly as
    // it did before clearance existed. Crossing the room is `walkTo`'s business.
    const r = geo.path(me.row, me.col, toRow, toCol, { clearance: 0 });
    if (!r.found) return { reachable: false, verified: false, why: r.reason };
    // REACHABLE, AND SEPARATELY, WALKABLE ALL THE WAY.
    //
    // `path` will plan a final step into the goal that the MOVER refuses rather than delete
    // a doorway the model dislikes — 346 of the exit anchors this bake cannot reach are
    // `go` exits whose square IS the door tile — and it flags such a route `goal_exempt`.
    // That flag has to survive to here, because "there is a route" and "the mover will walk
    // every step of it" are different answers and only the second predicts arrival.
    //
    // REPORTED BESIDE `reachable`, NEVER INSTEAD OF IT. Every tactical consumer should go on
    // treating the doorway as offered and attempt it — being wrong about one step costs a
    // packet and a fine correction, which `leaveVia` already does. What this lets a caller
    // do is stop PLANNING A JOURNEY through a door whose last step is a known disagreement,
    // which is the difference between a longer route and eighty seconds of failing at a wall.
    return { reachable: true, verified: r.goal_exempt !== true,
             steps: r.steps.length, path: r.steps.map(s => ({ col: s.col, row: s.row, dir: s.dir })),
             ...(me.offGrid ? { from_nearest_floor: { col: me.col, row: me.row },
                                note: 'you are standing off the movement grid; steps are counted from the nearest floor square' }
                            : {}) };
  }

  // Adjacent to a target rather than on top of it: the square next to it that is
  // cheapest to reach. Melee needs this — you cannot stand where the monster is.
  // COORDINATE CONTRACT: this movement-facing API is `(col,row)`; returned square
  // positions use named `{col,row}` fields.
  approachSquare(toCol, toRow) {
    const me = this.origin(), geo = this.geometry;
    if (!me || !geo) return null;
    // MEMOISED FOR 750 ms FROM WHERE WE STAND. Up to eight A* searches per object, and the
    // snapshot asks for every object on every walker iteration: the keeper's own profiler
    // put it in every stall left once the needle had its clock (2026-09-02). Keyed on our
    // square and the room, so a step or a crossing empties it.
    const now = Date.now();
    const originKey = `${this.room?.num ?? '?'}|${me.row},${me.col}`;
    const memo = this._approachMemo;
    if (!memo || memo.originKey !== originKey || now - memo.at > 750)
      this._approachMemo = { originKey, at: now, by: new Map() };
    const targetKey = `${toRow},${toCol}`;
    if (this._approachMemo.by.has(targetKey)) return this._approachMemo.by.get(targetKey);
    const answer = this._approachSquareUncached(me, geo, toCol, toRow);
    this._approachMemo.by.set(targetKey, answer);
    return answer;
  }
  _approachSquareUncached(me, geo, toCol, toRow) {
    let best = null;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = toRow + dr, c = toCol + dc;
      if (!geo.walkable(r, c)) continue;
      if (me.row === r && me.col === c) return { col: c, row: r, steps: 0, path: [] };
      // Same as reach(): this is melee range, not a journey. The square next to a monster
      // is frequently a tight one, and choosing between the eight of them on a preference
      // meant for crossing rooms picks the roomy side rather than the near one.
      const p = geo.path(me.row, me.col, r, c, { clearance: 0 });
      if (!p.found) continue;
      if (!best || p.steps.length < best.steps) best = { col: c, row: r, steps: p.steps.length, path: p.steps };
    }
    return best;
  }

  // ------------------------------------------------------------------ exits

  // Every way out, with what it costs to get to it from here. An edge exit is
  // reached by walking to the boundary square and stepping past it; a `go` exit
  // requires standing on an EXACT square (Room.SomethingTryGo matches row and col
  // exactly), which is why the square is reported rather than a direction.
  exits() {
    const room = this.room, geo = this.geometry, me = this.self;
    if (!room) return [];
    const origin = this.origin();
    // CACHE THE FLOOD FILLS. The two flood fills below (and the codeExits reach loop) are
    // the expensive part — on a ~2000-square room they take 10-20s, which was the cold-start
    // stall on the first tick after entering a room. The result is a pure function of the
    // room and the origin square, so repeated calls from the same origin (the router, the
    // broker, and the autopilot all call exits() while the character is standing still) all
    // get the same answer. Key by (room, geometry, origin square); the character moving to
    // a new square changes the key and recomputes, which is correct. Bounded LRU because the
    // origin changes as the character walks, so only the recent squares are worth keeping.
    //
    // The cache lives once per shared map, rather than once per World/character. Its routing
    // revision changes when an inferred edge is retired, and the key still carries room.num
    // + room.roo as a guard against a World being reused across rooms. Portal objects are
    // per-client observations and are appended after the cached static result.
    if (origin && Number.isFinite(origin.row) && Number.isFinite(origin.col)) {
      const key = `${room.num}|${room.roo ?? ''}|${origin.row},${origin.col}`;
      const shared = sharedExitCache(this.map);
      // Existing offline fixtures clear `_exitCache` explicitly to force one fresh compute.
      // Preserve that hook without clearing the fleet-wide cache for every other World.
      const force = Object.hasOwn(this, '_exitCache') && this._exitCache === null;
      if (!(this._exitCache instanceof Map) || this._exitCacheRevision !== routingRevision) {
        this._exitCache = new Map();
        this._exitCacheRevision = routingRevision;
      }
      const localHit = force ? undefined : this._exitCache.get(key);
      if (localHit !== undefined) {
        touchCache(this._exitCache, key, localHit, LOCAL_EXIT_CACHE_CAP);
        if (shared?.has(key)) touchCache(shared, key, localHit, SHARED_EXIT_CACHE_CAP);
        const portals = this._dynamicPortalExits(geo, me);
        return portals.length ? [...localHit, ...portals] : localHit;
      }
      const sharedHit = force ? undefined : shared?.get(key);
      if (sharedHit !== undefined) {
        touchCache(shared, key, sharedHit, SHARED_EXIT_CACHE_CAP);
        touchCache(this._exitCache, key, sharedHit, LOCAL_EXIT_CACHE_CAP);
        const portals = this._dynamicPortalExits(geo, me);
        return portals.length ? [...sharedHit, ...portals] : sharedHit;
      }
      const result = immutableExitCopy(this._computeExits(room, geo, me, origin));
      if (shared) touchCache(shared, key, result, SHARED_EXIT_CACHE_CAP);
      touchCache(this._exitCache, key, result, LOCAL_EXIT_CACHE_CAP);
      const portals = this._dynamicPortalExits(geo, me);
      return portals.length ? [...result, ...portals] : result;
    }
    const result = immutableExitCopy(this._computeExits(room, geo, me, origin));
    const portals = this._dynamicPortalExits(geo, me);
    return portals.length ? [...result, ...portals] : result;
  }

  // The static work from the old exits() body. `exits()` is the caching wrapper and appends
  // client-local portal observations after this shared projection.
  _computeExits(room, geo, me, origin) {
    const out = [];

    // PRICE THIS ORIGIN ONCE, NOT ONCE PER EDGE EXIT.  The distance to a square is a
    // property of (geometry, origin, collision mode); the destination selected by a room
    // edge has no bearing on the flood.  Keeping the pair lazy preserves the old cheap path
    // for rooms with no edge exits, while a room with seven declarations now walks its grid
    // twice rather than fourteen times.  The maps intentionally retain the old string keys
    // and breadth-first ordering so this is a scheduling change only: every exit sees the
    // exact same stages and distances it did when it owned an identical private flood.
    let originFloods = null;
    const exitFloods = () => {
      if (originFloods) return originFloods;
      const flood = collision => {
        const reachable = [{ row: origin.row, col: origin.col, steps: 0 }];
        const seen = new Set([`${origin.row},${origin.col}`]);
        for (let index = 0; index < reachable.length; index++) {
          const at = reachable[index];
          // NO FINE WIDENING HERE. This flood decides which exits are OFFERED, and
          // widening it into fine-open cells is how room 27 came to offer the stranded
          // 2500 boundary and then plan an eight-hop route through it. The fine view is
          // the MOVER's (roo's `fineNav`), asked for where a body is actually walked;
          // asking for it while deciding what is reachable invents roads.
          for (const next of geo.neighbors(at.row, at.col, { collision })) {
            // OFFERING A DOOR IS NOT CROSSING ONE, AND CLIP STEPS BELONG TO THE SECOND.
            //
            // `moverStepLands` allows a destination the coarse grid calls SOLID whenever
            // fine floor exists there (see CLIP_STEPS). That permission is deliberate and
            // stays: turning it off globally cut the Cragged Mountains' walkable body from
            // 2450 squares to 672, because that room is largely ground the coarse grid
            // cannot express. The mover keeps it.
            //
            // But this flood is not walking anywhere. It decides which exits are OFFERED,
            // and an optimistic answer here does not cost a step, it costs a journey: in
            // Ukgoth from the gutter at 61,27 the clip-allowed flood reaches 4,237 squares
            // and the Castle Victoria door at 1,27; refuse the clips and it reaches 338 and
            // does not. So the router planned a single hop 599 -> 2 at a door on top of a
            // cliff, sent the body to walk at it, and seven of thirteen deaths in one run
            // were in that room. The way out is a ROUTE, through 589 and round.
            //
            // Only the destination is filtered, and only on the strict pass -- the coarse
            // pass below is already the permissive one and is what still offers a door when
            // this refuses everything.
            if (collision && !geo.walkable(next.row, next.col)) continue;
            const key = `${next.row},${next.col}`;
            if (seen.has(key)) continue;
            seen.add(key);
            reachable.push({ row: next.row, col: next.col, steps: at.steps + 1 });
          }
        }
        return new Map(reachable.map(stage => [`${stage.col},${stage.row}`, stage]));
      };
      const coarseBySquare = flood(false);
      originFloods = {
        coarseBySquare,
        moverBySquare: geo.hasStepMask ? flood(true) : coarseBySquare,
      };
      return originFloods;
    };
    const nearestIn = (by, stages) => stages
      .map(stage => by.get(`${stage.col},${stage.row}`))
      .filter(Boolean)
      .sort((a, b) => a.steps - b.steps)[0] ?? null;

    // Include the reverse of edge exits that only the other side declares. The
    // planner already routes through these (see inferredExits); without them here
    // the EXECUTOR cannot walk what the planner just planned, and travel reports
    // "cannot find the exit to X from here" one hop into a perfectly good route.
    // That is worse than not knowing the route at all, because it looks like a
    // geometry problem rather than a bookkeeping one.
    const inferred = this.map ? inferredExits(this.map, room.num) : [];
    for (const e of [...edgeExitsOf(room),
                     ...inferred.map(x => ({ leave: x.leave, to: x.to, leaveName: x.direction,
                                             arriveRow: null, arriveCol: null, inferred: true }))]) {
      // The boundary square to aim for. Walking past row 0 or piRows+1 is what
      // triggers StandardLeaveDir, so the target is one step outside the grid, and
      // the square to stand on first is the last one inside it.
      let approach = null, alternates = [], viableCount = 0;
      const precise = [];
      if (geo && me && origin) {
        // One flood fill prices every staging square. Running a fresh A* for every
        // sub-square opening made a single exits() call take tens of seconds.
        //
        // TWO FLOODS, AND THE MASK MAY ONLY EVER PREFER. The first walks the edges the
        // MOVER will actually take (free where the room has a baked step mask, and
        // identical to the second where it does not); the second is the coarse grid as it
        // always was. Preferring the first is what stops a character being sent to a
        // staging square it will bounce off a wall trying to reach — which is where 59% of
        // walks to an exit died, measured.
        //
        // But the mask is a MODEL of somebody else's server and it is stricter than the
        // world: on room 579's north boundary it offers no reachable stage at all for 19
        // of 35 starting squares. If that were the last word, the exit would not appear in
        // this list, `travel` would report "cannot find the exit to X from here", and a
        // doorway people walk through would have been deleted by a bake. So a crossing
        // with no mover-reachable stage falls back to a coarse-reachable one and is
        // flagged rather than dropped. Being wrong about a wall costs a walk; refusing
        // costs the errand, and does it silently.
        const { coarseBySquare, moverBySquare } = exitFloods();
        // AND THE COARSE FALLBACK IS OFF WHERE THE ROOM HAS A ONE-WAY DROP IN IT.
        //
        // The same argument the `from_body` fallback below already makes, arriving by a
        // different road. The coarse grid has no falls and no heights -- it is symmetric, so
        // it will always claim you can walk back up a cliff you fell off. Measured in Ukgoth
        // from the gutter at 61,27: the MOVER flood reaches 319 squares and NOT the Castle
        // Victoria door at 1,27; the COARSE flood reaches 4,673 and does. So the fallback
        // re-offered the exact crossing the mover had correctly refused, `exits()` published
        // it, and the router planned a single direct hop 599 -> 2 at a door on top of a cliff
        // the character cannot climb. Seven of thirteen deaths in one run were in this room.
        //
        // Where the model CAN express the question its answer stands. `roomHasDeclaredFallJump`
        // marks a room where it cannot, and there the honest answer is that this exit is not
        // offered from here: the way out is a ROUTE -- through 589 and round -- not a crossing
        // of this room. 567 has no declared jump and keeps its fallback; 599 has two.
        const oneWayDropHere = roomHasDeclaredFallJump(Number(room?.num ?? 0));
        for (const crossing of edgeCandidatesOf(room, e, null, { live: true })) {
          let bestStage = nearestIn(moverBySquare, crossing.stages);
          const onlyCoarse = !bestStage;
          if (onlyCoarse && oneWayDropHere) continue;
          if (onlyCoarse) bestStage = nearestIn(coarseBySquare, crossing.stages);
          if (!bestStage) continue;
          const fineSteps = Math.ceil(Math.hypot(
            crossing.fine_stand_on.x - (bestStage.col * KOD_FINENESS + (KOD_FINENESS >> 1)),
            crossing.fine_stand_on.y - (bestStage.row * KOD_FINENESS + (KOD_FINENESS >> 1))) / 48);
          precise.push({ col: bestStage.col, row: bestStage.row,
            fine_stand_on: crossing.fine_stand_on, edge_target: crossing.edge_target,
            fine_path: [crossing.fine_stand_on], steps: bestStage.steps + fineSteps,
            ...(onlyCoarse ? { grid_only: true } : {}) });
        }
      }
      // AN EXIT THE BAKE PROVED IS NOT DELETED BECAUSE TODAY'S FLOOD CANNOT REACH IT.
      //
      // `continue` here removes the crossing from the room entirely, and the note on the
      // two floods above already warns what that costs: `travel` then says "cannot find the
      // exit to X from here" about a doorway people walk through. The coarse fallback
      // covers one flood failing. It does not cover BOTH failing, and both do.
      //
      // Room 567 is where it was measured. Its north door to 566 is baked at 1,45 with
      // `from_body`, `anchorReach` joins it to the south door, and there is a 22-step baked
      // path between them — so the bake walked this crossing offline. Live, neither flood
      // reaches any staging square on that boundary from where a character stands, so the
      // exit vanished, `candidates` came back empty, and the anchor injection in
      // `leaveViaAny` — the fix that repaired Ukgoth's 599 -> 2 — had no candidate to go in
      // front of. Across a whole fleet run the trace reads `injected 49,14 for 568`
      // seventeen times and never once mentions 566.
      //
      // The cost of that was directional and large. One character alone, undamaged, with
      // nothing else moving: 566 -> 568 crossed in 45s, and 568 -> 566 gave up after 400s
      // inside the room having lost 27% of its health. Same room, same body, same minute.
      //
      // So a boundary with no flood-reachable stage falls back to the anchor's own crossing
      // rather than disappearing. It is the LAST resort and it is flagged: `from_bake`
      // marks a square this room was proven able to walk to offline but that today's model
      // says it cannot, which is a claim worth being able to see in a refusal. Bounded to
      // crossings within two squares of the anchor, because an anchor that matches nothing
      // on this boundary is a stale bake, and inventing a door is worse than not offering
      // one — a stale map should degrade, not hallucinate.
      if (!precise.length) {
        // `from_body` IS THE WHOLE DISCRIMINATOR, and without it this resurrects the one
        // thing the bake exists to rule out. Room 27's west boundary to 2500 IS stranded —
        // the bake says so (`stranded_exits: 1`), the anchor carries `from_body: false` and
        // `region: 0`, and m59-routing-test pins that room 27 must not offer it, because
        // offering it once produced an eight-hop route through a door no body can reach.
        // 567's north door to 566 carries `from_body: true` in the same room-body region as
        // its south door. So the fallback below is only ever taken for a crossing the
        // bake's flood reached FROM THE ROOM'S OWN BODY: proven walkable offline, and
        // merely unreachable by today's live flood.
        // AND NOT IN A ROOM WITH A ONE-WAY DROP IN IT, which is where this fallback would do
        // real harm rather than none.
        //
        // `from_body` means the bake's flood reached the crossing from the room's body. That
        // flood is UNDIRECTED, and a fall is the one thing that makes a room directed: in
        // Ukgoth the Castle Victoria door at 1,27 is `from_body: true` measured from the
        // cliff top, and a character that missed the jump is standing at the bottom where it
        // cannot be reached at all. The live flood correctly refuses to offer it from down
        // there — and this fallback would put it straight back, sending a body to walk at a
        // cliff face for ever. The only way up is out through the Sentinel or the Cragged
        // Mountains and round, which is a ROUTE, not a crossing of this room.
        //
        // So a declared drop disables the fallback for the whole room. That is coarse on
        // purpose: it costs nothing where the model is right and refuses to guess where the
        // model cannot express the question. 567 has no declared jump; 599 has two.
        const oneWayInHere = roomHasDeclaredFallJump(Number(room?.num ?? 0));
        const baked = oneWayInHere ? null
          : anchorFor(activeRoutes(), Number(room?.num ?? 0), Number(e.to));
        if (baked?.from_body === true && Number.isFinite(baked.row) && Number.isFinite(baked.col)) {
          let best = null, bestAway = Infinity;
          for (const crossing of edgeCandidatesOf(room, e, null, { live: true })) {
            const cr = Math.floor(crossing.fine_stand_on.y / KOD_FINENESS);
            const cc = Math.floor(crossing.fine_stand_on.x / KOD_FINENESS);
            const away = Math.max(Math.abs(cr - baked.row), Math.abs(cc - baked.col));
            if (away < bestAway) { bestAway = away; best = crossing; }
          }
          const stage = bestAway <= 2 ? best?.stages?.[0] : null;
          if (stage) precise.push({
            col: stage.col, row: stage.row,
            fine_stand_on: best.fine_stand_on, edge_target: best.edge_target,
            fine_path: [best.fine_stand_on],
            // Sorts last among equals, which costs nothing: it is only ever reached when
            // it is the only entry there is.
            steps: 9999, grid_only: true, from_bake: true });
        }
      }
      if (!precise.length) continue;
      // A SQUARE THE MOVER CAN REACH BEATS A NEARER ONE IT CANNOT, and distance only
      // decides between equals. Sorting on steps alone put the whole fleet at the nearest
      // opening on the wall whether or not it could be walked to, and that nearest opening
      // is exactly where the bounce happened.
      // AND A SQUARE A REAL PLAYER HAS ACTUALLY CROSSED FROM BEATS BOTH.
      //
      // The two keys above are both about the MODEL — is the mover happy, is it near —
      // and the model is what has been wrong. Measured across 18 boundary pairs in
      // recorded operator walks, the observed crossing square is almost always somewhere
      // in this list already; it simply is not the one distance picks. So the failure was
      // never coverage, it was CHOICE, and the cheapest correction is to let an
      // observation outrank a derivation.
      //
      // The evidence costs the operator nothing but playing: `m59-proxy.mjs` logs every
      // move packet, so a room change in that log brackets the crossing exactly — which
      // matters because it cannot be reported by hand. In the operator's words: "the
      // moment I touch it, I'm teleported, far before I'd be able to react". The recorded
      // square is OFF THE MAP, because that outward step is the trigger, so the book
      // stores it pulled back one square to where a character stands.
      //
      // NO BOOK MEANS THE ORDER THAT WAS ALWAYS USED. A fresh clone has never watched
      // anybody play and must behave exactly as it did.
      const observed = observedCrossings(Number(room?.num ?? 0), Number(e.to));
      const seenAt = new Map(observed.map(o => [o.row + ',' + o.col, o.seen]));
      // AGAINST THE CROSSING SQUARE, NOT THE STAGING SQUARE. A `precise` entry carries the
      // staging square in col/row and the crossing it stages for in `fine_stand_on`, and
      // the book records where a player actually CROSSED. Comparing the two silently
      // matched nothing: on Western border of the Twisted Wood -> The Twisted Wood the
      // book holds row 47 and the entry chosen staged at 66,45, so the preference had no
      // effect at all while appearing to work.
      const witness = c => seenAt.get(Math.floor(c.fine_stand_on.y / KOD_FINENESS) + ',' +
                                      Math.floor(c.fine_stand_on.x / KOD_FINENESS)) ?? 0;
      // THE BAKED ANCHOR IS THE THIRD OPINION, AND IT RANKS BELOW AN OBSERVATION ON
      // PURPOSE. The bake is a flood over the room's own body, so an anchor is a crossing
      // square this room was PROVEN able to walk to offline — which is the question
      // `steps` only guesses at, since a nearer square hemmed in by geometry is a worse
      // answer than a further one on open floor. But it is still derived from the same
      // .roo the candidates came from, while the crossing book is a record of a real
      // client actually arriving somewhere, so a witness keeps the last word.
      //
      // ASKED BY DESTINATION. Both of Western border of the Twisted Wood's east exits sit
      // on one wall, split `row<19` / `row>20`; asking the table by direction would hand
      // the same square to both and send a character to the wrong room while every leg
      // reported success. `anchorFor` is the accessor that cannot express that mistake.
      //
      // NO TABLE, OR A ROOM IT DOES NOT COVER, MEANS THE ORDER THAT WAS ALWAYS USED.
      const anchor = anchorFor(activeRoutes(), Number(room?.num ?? 0), Number(e.to));
      const anchored = c => anchor
        && ((c.row === anchor.row && c.col === anchor.col)
            || (Math.floor(c.fine_stand_on.y / KOD_FINENESS) === anchor.row
                && Math.floor(c.fine_stand_on.x / KOD_FINENESS) === anchor.col)) ? 1 : 0;
      precise.sort((a, b) => (witness(b) - witness(a))
                          || (anchored(b) - anchored(a))
                          || (!!a.grid_only - !!b.grid_only)
                          || (a.steps - b.steps));
      approach = precise[0];
      const MIN_FINE_APART = 4 * KOD_FINENESS, MAX_FINE_CANDIDATES = 8;
      const fineAlong = candidate => (e.leave === LEAVE.NORTH || e.leave === LEAVE.SOUTH)
        ? candidate.fine_stand_on.x : candidate.fine_stand_on.y;
      const precisePicked = [approach];
      for (const candidate of precise) {
        if (precisePicked.length >= MAX_FINE_CANDIDATES) break;
        if (precisePicked.some(other => Math.abs(fineAlong(other) - fineAlong(candidate)) < MIN_FINE_APART)) continue;
        precisePicked.push(candidate);
      }
      for (const candidate of precise) {
        if (precisePicked.length >= MAX_FINE_CANDIDATES) break;
        if (!precisePicked.includes(candidate)) precisePicked.push(candidate);
      }
      alternates = precisePicked.slice(1);
      viableCount = precise.length;
        // KEEP THE WHOLE BOUNDARY, NOT JUST THE NEAREST SQUARE.
        //
        // This found every viable square along the edge and then threw all but one
        // away. StandardLeaveDir fires on crossing the boundary ANYWHERE the condition
        // allows, so the discarded ones were not worse routes — they were equally good
        // doors. With two declared exits to a destination that meant exactly two squares
        // were ever tried, and "every square for that exit refused (2 tried)" was the
        // commonest way a multi-room errand died: the outfitting trip, four money
        // transfers and the reagent bridging all failed on it in one afternoon, against
        // boundaries fifty squares wide.
        //
        // A refusal is usually LOCAL — something standing on the square, or no floor on
        // the far side of that column — so the alternates are SPREAD along the boundary
        // rather than taken in distance order. Trying (1,5) then (1,6) then (1,7) mostly
        // re-asks the same question; sampling across the width asks a different one.
        // Nearest first — it is still the cheapest thing to try — then a spread of the
        // rest, each at least MIN_APART from everything already chosen so the tries are
        // genuinely different parts of the wall. Capped because each attempt is a walk.
        // Anything left over is still better than giving up, so keep them as a tail in
        // distance order for the case where the spread found nothing.
      out.push({
        kind: 'edge',
        direction: e.leaveName,
        to: e.to,
        to_name: this.map.rooms[e.to]?.name ?? `room ${e.to}`,
        stand_on: { col: approach.col, row: approach.row },
        fine_stand_on: approach.fine_stand_on,
        edge_target: approach.edge_target,
        fine_path: approach.fine_path,
        steps_away: approach.steps,
        // OTHER WAYS THROUGH THE SAME WALL. Not second-best routes — the boundary is
        // one exit and any square on it crosses. leaveViaAny works through these when
        // the nearest is blocked, which is what makes a wide edge reliable instead of a
        // coin flip on whichever square happened to be closest.
        ...(alternates.length ? { alternates } : {}),
        ...(viableCount ? { standable_on_this_boundary: viableCount } : {}),
        how: approach
          ? `walk_to {"col":${approach.col},"row":${approach.row}} (r${approach.row}c${approach.col}), fine-position at ` +
            `x=${approach.fine_stand_on.x}, y=${approach.fine_stand_on.y} in KOD units, then cross ${e.leaveName}` +
            (alternates.length ? ` — ${alternates.length} other square(s) on that boundary also cross` : '')
          : `walk ${e.leaveName} past the room edge`,
        condition: e.condition ? `${e.condition.name}${e.condition.threshold}` : null,
        reachable: true,
        // THE MOVER'S FLOOD ALREADY ANSWERED THIS. `grid_only` means no staging square for
        // this crossing was reachable under collision and the coarse grid was used instead
        // — which is exactly "offered, but do not build a journey on it".
        verified: !approach.grid_only,
        // Flagged so leaveVia can tell a declared boundary from a guessed one, and
        // retire the guess when the server refuses it.
        ...(e.inferred ? { inferred: true } : {}),
        ...(e.synthetic ? { synthetic: true } : {}),
        ...(e.dynamic ? { dynamic_destination: true } : {}),
      });
    }

    // Exits the room class implements in code: walking into a region of the floor
    // makes the room hand you across. Nothing to press, and no way to see it at
    // runtime — see m59-codeexits.mjs. Turn the coordinate test into a concrete
    // square by asking the geometry for the nearest walkable one that satisfies it,
    // because "row > 83 and col > 48" is not something a caller can walk to.
    for (const ce of codeExits(room.num)) {
      const direct = [], staged = [];
      if (geo && me) {
        for (let r = 1; r <= geo.rows; r++) {
          for (let c = 1; c <= geo.cols; c++) {
            if (!inRegion(ce.when, r, c) || !geo.walkable(r, c)) continue;
            const p = this.reach(c, r);
            if (p.reachable) {
              direct.push({ col: c, row: r, steps: p.steps, reachable: true,
                            verified: p.verified !== false });
              continue;
            }

            // A code trigger can sit behind a gap narrower than one square. The .roo
            // direction grid cannot express that gap, but the fine BSP geometry can.
            // Keep a square beside the trigger that the ordinary walker CAN reach;
            // leaveVia stages there and locally validates the final fine steps.
            //
            // Western Border of the Twisted Wood -> the Icky Cave is the worked example:
            // every square satisfying row 15..17, col 1..6 is disconnected in the square
            // graph, while passable half-square wall segments lead into it. Throwing these
            // candidates away produced a local refusal before one packet reached the server.
            const approach = this.approachSquare(c, r);
            if (approach)
              staged.push({ col: c, row: r, steps: approach.steps + 1, reachable: false,
                            verified: false,
                            approach_on: { col: approach.col, row: approach.row } });
          }
        }
      }
      const ranked = (direct.length ? direct : staged).sort((a, b) => a.steps - b.steps);
      // Region predicates can cover a large piece of a room. Retain a small spread rather
      // than returning hundreds of equivalent targets or betting forever on one blocked
      // point. The nearest is cheapest; separation makes each fallback geometrically new.
      const targets = [];
      for (const candidate of ranked) {
        if (targets.length >= 8) break;
        if (targets.length && targets.some(other =>
          Math.max(Math.abs(other.col - candidate.col), Math.abs(other.row - candidate.row)) < 2)) continue;
        targets.push(candidate);
      }
      for (const candidate of ranked) {
        if (targets.length >= 8) break;
        if (!targets.includes(candidate)) targets.push(candidate);
      }
      const best = targets[0] ?? null;
      out.push({
        kind: 'region',
        to: ce.to,
        to_name: this.map.rooms[ce.to]?.name ?? `room ${ce.to}`,
        stand_on: best ? { col: best.col, row: best.row } : null,
        steps_away: best ? best.steps : null,
        reachable: best ? best.reachable : (geo && me ? false : null),
        verified: best ? best.verified === true : (geo && me ? false : null),
        ...(best?.approach_on ? { approach_on: best.approach_on } : {}),
        ...(targets.length ? { trigger_targets: targets.map(target => ({
          stand_on: { col: target.col, row: target.row },
          steps_away: target.steps,
          reachable: target.reachable,
          ...(target.approach_on ? { approach_on: target.approach_on } : {}),
        })) } : {}),
        how: best?.reachable
          ? `walk_to {"col":${best.col},"row":${best.row}} (r${best.row}c${best.col}) — the room moves you across as you arrive`
          : ce.how,
        trigger: ce.when.map(x => `${x.axis} ${x.op} ${x.value}`).join(' and '),
      });
    }

    for (const g of room.goExits) {
      const rr = (geo && me && !g.locked) ? this.reach(g.col, g.row) : { reachable: null };
      out.push({
        kind: g.locked ? 'locked_door' : 'go',
        to: g.locked ? null : g.to,
        to_name: g.locked ? null : (this.map.rooms[g.to]?.name ?? `room ${g.to}`),
        stand_on: { col: g.col, row: g.row },
        steps_away: rr.steps ?? null,
        reachable: rr.reachable,
        // A `go` exit's square IS the door tile, which is a pocket by design and exactly
        // the case `path`'s goal exemption exists for — so this is very often `false` here
        // and that is correct. It must never be read as "do not offer this door".
        verified: rr.verified ?? null,
        how: g.locked
          ? `locked door at r${g.row}c${g.col} (row=${g.row}, col=${g.col})`
          : `walk_to EXACTLY {"col":${g.col},"row":${g.row}} (r${g.row}c${g.col}), then act go — the match is on that one square`,
      });
    }
    return out;
  }

  // Portal objects are runtime perception, not a property of the shared static map. They
  // must be re-read for each client even when the expensive room flood is shared: otherwise
  // one actor could inherit another actor's stale object id or resource-table label.
  _dynamicPortalExits(geo, me) {
    const out = [];
    for (const o of this.c.room?.objects?.values?.() ?? []) {
      if (o.id === this.c.selfId) continue;
      const name = this.c.rsc.get(o.nameRsc);
      if (!isTeleporter(o.flags)) continue;
      const rr = (geo && me) ? this.reach(o.col, o.row) : { reachable: null };
      out.push({
        kind: 'portal',
        to: null,
        to_name: null,
        name,
        id: o.id,
        stand_on: { col: o.col, row: o.row },
        steps_away: rr.steps ?? null,
        reachable: rr.reachable,
        verified: rr.verified ?? null,
        // The flag is certain; where it goes is not. Some portals are fixed and some
        // change their destination on a timer, and the only way to find out is to
        // look at it — the description names the place in prose.
        destination_known: false,
        how: `walk_to {"col":${o.col},"row":${o.row}} (r${o.row}c${o.col}) — stepping onto this square teleports you. ` +
             `Use look_at first: a shifting portal describes where it currently leads.`,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ objects

  objects({ includeAppearance = false } = {}) {
    const c = this.c, me = this.self;
    const list = [...c.room.objects.values()].filter(o => o.id !== c.selfId);
    return list.map(o => {
      const straight = me ? Math.round(Math.hypot(o.col - me.col, o.row - me.row)) : null;
      const can = affordances(o.flags);
      const out = {
        id: o.id,
        name: c.rsc.get(o.nameRsc),
        col: o.col, row: o.row,
        // AND WHERE IN THE SQUARE, WHICH IS THE ONLY RESOLUTION THAT CAN ANSWER "CAN I GET
        // PAST IT". This projection stopped at col/row, and everything downstream inherited
        // that — `threatsHere` builds a threat list of squares, the router penalises squares,
        // and the conclusion "this corridor is one square wide, therefore it is blocked" is
        // reached without anyone ever asking where the body actually is.
        //
        // It is wrong for the reason CLAUDE.md puts in capitals: THE FINE GRID IS THE
        // REALITY, A SQUARE IS A SUMMARY. A square is 64 kod units across and a body is
        // PLAYER_RADIUS = 248 client units, which is 15.5 kod — about 31 across. Two of them
        // fit side by side inside one square with half a body's width to spare. A spider
        // standing on the north side of 29,44 leaves the south side of 29,44 free, and that
        // is how a person walks the one-square corridor in the Western border of the Twisted
        // Wood that this fleet has been dying in.
        //
        // The wire has carried this the whole time — `extractCoordinates` returns y and x in
        // kod fine units and both BP_CREATE and BP_MOVE spread them onto the stored object.
        // Only the projection threw them away.
        x: o.x, y: o.y,
        distance: straight,
        facing: o.degrees != null ? dirName(o.degrees) : null,
        can,
        is_player: !!(o.flags & OF.PLAYER),
        teleporter: isTeleporter(o.flags) || undefined,
        ...(includeAppearance ? renderState(c, o) : {}),
      };
      if (o.amount) out.amount = o.amount;
      if (o.flags & OF.PLAYER) {
        // Who is safe to be near. These bits come straight from the server's own
        // view of the relationship, so they are more trustworthy than a name.
        out.relation = (o.flags & OF.ENEMY) ? 'enemy'
          : (o.flags & OF.GUILDMATE) ? 'guildmate'
          : (o.flags & OF.FRIEND) ? 'friend' : 'neutral';
        out.safety_on = !!(o.flags & OF.SAFETY);
      }
      return out;
    }).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }

  // ------------------------------------------------------------------ minimap

  // The whole state as one picture. Objects are placed on the walkability grid, so a
  // glance answers "is that monster behind a wall", "which way is out", and "can I
  // get there" — none of which the object list alone can tell you.
  minimap({ path = null, maxWidth = 200 } = {}) {
    const geo = this.geometry;
    if (!geo) return { text: null, legend: {}, note: 'no geometry for this room' };
    const me = this.self;
    const marks = [];
    const legend = {};

    // Exits first, so an object standing in a doorway does not hide the way out
    // — later marks win, and objects are added after.
    for (const e of this.exits()) {
      if (!e.stand_on) continue;
      const ch = e.kind === 'locked_door' ? MARK.locked : MARK.exit;
      marks.push({ row: e.stand_on.row, col: e.stand_on.col, ch });
      legend[ch] = e.kind === 'locked_door' ? 'locked door' : 'exit (stand here)';
    }

    // A planned route, if the caller has one, so the agent can see its own plan.
    if (path) for (const s of path) marks.push({ row: s.row, col: s.col, ch: ':' });
    if (path?.length) legend[':'] = 'planned route';

    // Objects, nearest first so the interesting ones get the early letters.
    let next = 0;
    for (const o of this.objects()) {
      const ch = o.is_player ? MARK.player : OBJECT_MARKS[next++ % OBJECT_MARKS.length];
      marks.push({ row: o.row, col: o.col, ch });
      const desc = `${o.name} (id ${o.id})${o.can.length ? ' [' + o.can.filter(x => x !== 'look').join('/') + ']' : ''}`;
      legend[ch] = legend[ch] && legend[ch] !== desc ? `${legend[ch]}; ${desc}` : desc;
    }

    if (me) { marks.push({ row: me.row, col: me.col, ch: MARK.self }); legend[MARK.self] = 'you'; }

    // Two pictures, because they answer different questions and neither subsumes
    // the other. The GRID map is the movement graph — one character per square, and
    // what it calls floor is what you can stand on. The WALL map is what the client
    // actually draws (clientd3d/map.c): line segments at twice the resolution, so a
    // wall BETWEEN two floor squares is visible, and doorways are distinguishable
    // from walls. An agent deciding where to step wants the first; an agent working
    // out the shape of the place wants the second.
    const walls = geo.walls?.length ? geo.renderWalls({ marks }) : null;
    return {
      text: geo.render({ marks, legend: false }),
      walls,
      legend,
      key: '# no floor   . floor   + floor with no exits',
      walls_key: walls ? '| - / \ wall   · doorway you can walk through   . floor' : undefined,
      size: { rows: geo.rows, cols: geo.cols, walkable: geo.walkableCount },
      wall_summary: geo.wallSummary || undefined,
      truncated: geo.cols > maxWidth,
    };
  }

  // ------------------------------------------------------------------ snapshot

  // The renderer's hot path. This deliberately does no A*, boundary scanning, or
  // minimap rendering: every field below is already in the protocol client's memory
  // and changes can therefore be projected at packet speed. `snapshot()` remains the
  // tactical query for deciding whether and how an order can be executed.
  perception() {
    const c = this.c, binding = this.roomBinding;
    const room = binding?.room ?? this.room;
    const roomWire = binding?.room_wire ?? null;
    const geo = room?.roo ? sharedRoomGeometry(room) : null;
    const me = this.self;
    return {
      room: room
        ? { num: room.num, name: room.name, size: { rows: room.rows, cols: room.cols },
            resource: room.rooFile, object_id: c.room.id }
        : { num: null, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null,
            object_id: c.room.id,
            note: 'this room is not in substrate/m59-map.json — rebuild the map' },
      you: me
        ? { object_id: c.selfId, col: me.col, row: me.row,
            facing: dirName(me.degrees ?? 0), facing_degrees: me.degrees,
            ...renderState(c, me),
            on_walkable: geo ? geo.walkable(me.row, me.col) : null }
        : { object_id: c.selfId, note: 'not present in room contents yet — call look' },
      vitals: c.vitals(),
      carrying: c.inventory.length,
      objects: this.objects({ includeAppearance: true }),
      exits: [],
      projection: 'render',
      topology_note: 'exits and reachability belong to the tactical look/room scene, not the render hot path',
      ...(roomWire ? { room_wire: roomWire } : {}),
    };
  }

  // One call, everything. This is what an agent should read at the start of a turn.
  //
  // THE MINIMAP IS OPT-IN. It is two full ASCII pictures of the room — the
  // walkability grid and the wall map at double resolution — and for a big outdoor
  // room that is ~8KB, which dwarfs everything else in the reply. It answers
  // "is that behind a wall" and "what shape is this place", which are real
  // questions, but not ones an agent asks on most turns. Ask for it when you need
  // it; do not pay for it when you do not.
  snapshot({ includeMinimap = false, plannedPath = null } = {}) {
    const c = this.c, room = this.room, geo = this.geometry, me = this.self;
    const all = this.objects();
    const allExits = this.exits();

    // Locked doors get the same treatment as scenery, for the same reason: a town
    // can publish seventeen of them, each a full record naming a destination it does
    // not know and a square you cannot use, and none of it is actionable. Keep the
    // squares — a key changes the answer — but say it in one line.
    const exits = allExits.filter(e => e.kind !== 'locked_door');
    const locked = allExits.filter(e => e.kind === 'locked_door');

    // SCENERY IS SUMMARISED. NOTHING THAT COULD MATTER IS EVER DROPPED.
    //
    // A town room returns eighty-odd objects and most of them are browncorn plants
    // and dung: no affordances, nothing you can do with them, pure furniture. They
    // are worth a count, not a paragraph each.
    //
    // But this must NEVER become a cap on the list, and the reason is specific:
    // everything dies onto the floor in this game, so the rooms where the object
    // list is longest are exactly the dangerous ones — a battlefield thick with
    // corpses and their loot. A truncated list there would omit the loot you came
    // for, or the murderer walking in behind it. So the split is by AFFORDANCE, not
    // by count: anything with something you can do to it, anything holding a
    // quantity, every player, and every teleporter is reported in full however many
    // there are. Only the genuinely inert collapses.
    const inert = o => !o.is_player && !o.teleporter && o.amount == null
                       && (!o.can || o.can.length === 0);
    const objects = all.filter(o => !inert(o));
    const scenery = all.filter(inert);

    // Reachability is an A* per object, so it is budgeted rather than unconditional —
    // but the budget is generous, because "can I get to that" is the question an
    // agent most often needs answered and guessing wrong costs a minute of walking.
    // Nearest first, so if the budget runs out it runs out on the far things.
    const REACH_BUDGET = 40;
    for (const o of objects.slice(0, REACH_BUDGET)) {
      const a = this.approachSquare(o.col, o.row);
      o.reachable = a ? true : (geo && me ? false : null);
      if (a) { o.steps_to_reach = a.steps; o.stand_on = { col: a.col, row: a.row }; }
      // A portal is a THIRD way out of a room, and nothing in the protocol says so:
      // Portal.SomethingMoved fires when your square equals its square and teleports
      // you (kod/object/active/portal.kod:97). It carries no distinguishing object
      // flag — the Underworld's read `can: ["look"]` like scenery — so the only
      // signal available to a client is the name. Flagged as a GUESS, because that
      // is what it is; walking onto the square is how you find out.
      if (o.teleporter) {
        o.how = `walk_to {"col":${o.col},"row":${o.row}} (r${o.row}c${o.col}) — stepping onto this square teleports you elsewhere.`;
      }
    }

    return {
      room: room
        ? { num: room.num, name: room.name, size: { rows: room.rows, cols: room.cols },
            resource: room.rooFile, object_id: c.room.id }
        : { num: null, name: c.roomNameRsc ? c.rsc.get(c.roomNameRsc) : null, object_id: c.room.id,
            note: 'this room is not in substrate/m59-map.json — rebuild the map' },
      you: me
        ? { object_id: c.selfId, col: me.col, row: me.row,
            facing: dirName(me.degrees ?? 0), facing_degrees: me.degrees,
            on_walkable: geo ? geo.walkable(me.row, me.col) : null,
            can_step: geo ? geo.openDirections(me.row, me.col).map(d => d.name) : null }
        : { object_id: c.selfId, note: 'not present in room contents yet — call look' },
      vitals: c.vitals(),
      carrying: c.inventory.length,
      objects,
      ...(scenery.length ? { scenery: summariseScenery(scenery) } : {}),
      exits,
      // SERIALIZED CONTRACT: these legacy square strings are `"col,row"`.
      ...(locked.length ? { locked_doors: {
        count: locked.length,
        squares: locked.map(e => `${e.stand_on.col},${e.stand_on.row}`),
        note: 'shut to you now; listed in case you find a key',
      } } : {}),
      ...(includeMinimap ? { minimap: this.minimap({ path: plannedPath }) } : {})
      ,
      ...(includeMinimap ? {} : { minimap_note: 'omitted — pass minimap:true for the room picture' }),
    };
  }

  // ------------------------------------------------------------------ travel

  /**
   * Can `room` be WALKED from the door you came in by to the door you want? `null` when
   * the table cannot say, and every caller must read that as "carry on".
   *
   * The router has always planned over rooms, which assumes any two doors of a room are
   * joined by floor. Often they are not. The Cragged Mountains basin reaches exactly one
   * of its five exits on foot. West Merchant Way is the same shape inverted — the operator
   * walked it: you come in from Marion at the TOP, walk down, and cannot climb back, and
   * blink does not help either. A route planned in ignorance of that is not a long route,
   * it is a plan that puts a character in a hole it cannot leave.
   *
   * The answer is already baked: every anchor in substrate/m59-routes.json carries the
   * strongly-connected region of the room's floor it stands in.
   *
   * IT ONLY EVER REFUSES ON EVIDENCE. No table, no masks, an unbaked room, an anchor that
   * is not there, or a region of -1 all return null rather than false — the same rule the
   * step mask follows, and for the same reason: a bake must never be the thing that makes
   * a doorway disappear.
   */
  transitOk() {
    const table = activeRoutes();
    if (!table) return null;
    return (room, cameFrom, goingTo) => {
      const inA = anchorFor(table, room, cameFrom);
      const outA = anchorFor(table, room, goingTo);
      if (!inA || !outA) return null;
      // DIRECTED, BECAUSE THE QUESTION IS. `sameRegion` asks whether two doors are in the
      // same strongly connected component — whether each can reach the OTHER — and that is
      // a stricter thing than "can I get from the door I came in by to the one I want".
      // Where a room contains a one-way drop the two answers differ, and the mutual one is
      // wrong in the direction that matters: measured in Ukgoth, the Castle Victoria door
      // reaches the Sentinel door in 136 steps while the reverse has no route at all, so
      // the components differ and `sameRegion` refused a transit the fleet makes.
      //
      // The bake already holds the directed answer. It is one BFS per anchor square,
      // written per ORDERED pair, so a yes in the table is a yes in that direction.
      // Absent, fall through to the component test rather than to nothing: for a pair the
      // bake never covered, mutual reachability is still evidence, and `null` still means
      // carry on.
      //
      // ASK `anchorReach`, NOT `bakedPath`. The question here is "is there a way", and
      // `bakedPath` answers "here are the squares" — which is null whenever the route
      // contains a FALL, because the step string is one letter per unit direction and a
      // fall is one move of two or three squares. Ukgoth's Castle Victoria doorway reaches
      // the Sentinel doorway in 83 steps whose FIRST move is a fall, so the crossing the
      // fleet makes every lap was refused by a table that had walked it.
      if (anchorReach(table, room, inA, outA)) return true;
      const joined = sameRegion(table, room, inA, outA);
      if (joined !== false) return joined;
      // A ROOM WITH A DOOR INTO ITSELF IS ONE THE BAKE CANNOT ANSWER FOR.
      //
      // The flood that assigns regions walks the floor. An internal `go` exit is not floor
      // - it is a teleport from one square to another inside the same room - so the two
      // halves of Castle Victoria are two regions in the table and joined in the world.
      // `false` here is therefore a refusal on the strength of a model that does not
      // represent the mechanism, and it is the strongest possible refusal: it removes the
      // room from the route graph, so `travel(41)` answered "no route" about a basement
      // people walk to, and the mover never got the chance to open the door.
      //
      // `null` is this module's word for "the table cannot say", it is already what an
      // unbaked room and a missing anchor return, and the rule beside them is the one that
      // applies here too: a bake must never be the thing that makes a doorway disappear.
      // The mover then plans the door for real, against live geometry, in
      // `planSameRoomDoors` - which can fail, and fails having tried.
      //
      // Narrow on purpose. It only softens the answer for a room that actually declares a
      // door back into itself (eleven in this map) and only for a pair the region test
      // just refused; every other room keeps the hard `false` the bake earned.
      const here = this.map?.rooms?.[room];
      return sameRoomDoors(here).length ? null : false;
    };
  }

  /**
   * THE SQUARES ON THIS EXIT'S BOUNDARY THAT WOULD FIRE A DIFFERENT EXIT.
   *
   * A boundary is not one door. The server picks between the exits on an edge by evaluating
   * a condition on the crossing square, and `selectedEdgeAt` simulates that ordered scan
   * exactly — it is the same question the server answers when the body crosses.
   *
   * The Western border of the Twisted Wood is the measured case. Its east edge is split by a
   * row threshold:
   *
   *     east -> 586  Main gate to the city of Tos   when row < 19
   *     east -> 597  The Twisted Wood               when row > 20
   *
   * A character entering from Tos lands at row 8, column 66 — one square from that boundary,
   * inside the FIRST band. Every walk toward the Twisted Wood door at row 46 begins beside
   * the door back to Tos, and one slide east takes it. Measured: thirteen consecutive
   * attempts at `587 -> 597`, each reporting the crossing and then landing in 586, a hundred
   * and eighty seconds in one room without leaving it.
   *
   * Keeping AWAY from a boundary was the wrong shape of fix, because the arrival square is
   * already beside it. The right one is to refuse the squares that fire the wrong door: they
   * are known before the walk starts, they are few, and the router can simply route around
   * them. The strip one square inland goes too, because that is where a slide starts.
   *
   * Empty whenever the edge carries only one exit, which is nearly always — this costs
   * nothing on an ordinary boundary.
   */
  wrongExitSquares(exit, { includeInland = false } = {}) {
    // SERIALIZED CONTRACT: this legacy Set contains `"row,col"` geometry keys.
    const out = new Set();
    const room = this.room && this.map?.rooms?.[this.room.num];
    const dir = exit?.direction ?? exit?.leaveName;
    if (!room || !dir || exit?.to == null) return out;
    const edges = (room.edgeExits ?? []).filter(e => (e.leaveName ?? '') === dir);
    if (edges.length < 2) return out;                 // one door on this edge: nothing to avoid
    const geo = this.geometry;
    const rows = Number(geo?.rows ?? room.rows), cols = Number(geo?.cols ?? room.cols);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return out;
    const want = Number(exit.to);
    const along = (dir === 'east' || dir === 'west')
      ? { count: rows, at: (n) => ({ row: n, col: dir === 'east' ? cols : 1 }), inland: dir === 'east' ? -1 : 1, axis: 'col' }
      : { count: cols, at: (n) => ({ row: dir === 'south' ? rows : 1, col: n }), inland: dir === 'south' ? -1 : 1, axis: 'row' };
    for (let n = 1; n <= along.count; n++) {
      const sq = along.at(n);
      const fires = selectedEdgeAt(room, dir, sq);
      if (!fires || Number(fires.to) === want) continue;
      out.add(`${sq.row},${sq.col}`);
      // THE STRIP ONE SQUARE INLAND IS WHERE A SLIDE STARTS — and it is also where the baked
      // rail runs, because a line leaving this room hugs the edge before it turns away.
      // Blocking it would make the crossing unplannable, which is a worse failure than the
      // one being fixed, so it is off by default and available to a caller that wants it.
      if (includeInland) {
        if (along.axis === 'col') out.add(`${sq.row},${sq.col + along.inland}`);
        else out.add(`${sq.row + along.inland},${sq.col}`);
      }
    }
    return out;
  }

  /**
   * HOW MANY SQUARES IT IS ACROSS A ROOM, door to door. Same shape as `transitOk`, and from
   * the same baked table: that one answers whether a crossing is possible, this one what it
   * costs. Used only to choose between routes of equal ROOM COUNT, so it can never make a
   * journey longer — and `null` whenever the table cannot say, which the planner charges as
   * an ordinary crossing rather than as free.
   *
   * The measured case is Tos to Castle Victoria. Both ways are seven rooms; via the Western
   * border of the Twisted Wood is 310 baked steps and via the Outskirts of Tos is 298, and
   * the second is shorter on every leg where they differ. The planner counted rooms, could
   * not see any of that, and picked the longer one by accident.
   */
  crossCost() {
    const table = activeRoutes();
    if (!table) return null;
    return (room, cameFrom, goingTo) => {
      const inA = anchorFor(table, room, cameFrom);
      const outA = anchorFor(table, room, goingTo);
      if (!inA || !outA) return null;
      if (inA.row === outA.row && inA.col === outA.col) return 0;
      const r = table.rooms?.[room] ?? table.rooms?.[String(room)];
      const path = r?.routes?.[`${inA.row},${inA.col}>${outA.row},${outA.col}`];
      return typeof path === 'string' ? path.length : null;
    };
  }

  // A route to another room, expressed as things to do rather than rooms to be in.
  // Each leg says which square to stand on and which mechanism to use, because the
  // two mechanisms are not interchangeable and getting it wrong produces silence.
  /**
   * @param blockedHops  Hops this CALLER has learned are unusable, as `"from>to"` room
   *   numbers. Merged with the ones derived from `exits()` below rather than replacing
   *   them. A hop is the right unit for a learned failure and a room is not: the room a
   *   character cannot cross from THIS door it can usually cross from another, and the
   *   destination is frequently somewhere it must still be able to arrive at.
   */
  route(toRoomNum, { avoid = null, blockedHops: learned = null } = {}) {
    const room = this.room;
    if (!room) return { found: false, reason: 'current room is not in the graph' };
    // A CALLER MAY ADD TO THE AVOID SET, NEVER REPLACE IT. `AVOID_IN_TRANSIT` is this
    // repository's standing opinion about the world; a caller's set is what THIS character
    // has learned the hard way — a doorway the server actually refused it. Overwriting the
    // first with the second would quietly route the fleet back through the rooms the map
    // module exists to keep it out of.
    const merged = avoid?.size
      ? new Set([...AVOID_IN_TRANSIT, ...avoid])
      : AVOID_IN_TRANSIT;

    // AND THE FIRST HOP, WHICH `transitOk` CANNOT SEE.
    //
    // The transit predicate asks "can this room be crossed from the door I came in by",
    // and the room we are STANDING IN has no such door — so leaving it was the one hop
    // planned with no idea whether its exit can be walked to. That is not a corner case:
    // a character already inside West Merchant Way, asked to go anywhere through Deep
    // Forest of Farol, planned straight at a doorway on the far side of a 1664-unit face
    // and failed with "every square for that exit refused" every single time. Measured on
    // the arena fleet, that one shape was four of nine torture-run failures.
    //
    // For the first hop the question is not about anchors at all — it is where this
    // character is standing right now, which `exits()` already answers per exit. A raw
    // graph destination that is absent from that authoritative offered list is not
    // somewhere we can set off for.
    //
    // NOT A PREFERENCE. The graph's permissive transit pass exists because an offline bake
    // may be stricter than the server. A raw destination that is absent from an
    // AUTHORITATIVE live exit list is different: the executor has no action it can take for
    // that hop. Falling back through it plans a journey whose first instruction cannot be
    // executed. Room 27 is the measured case: the raw graph declares west -> 2500, but that
    // boundary is a stranded collision pocket and `exits()` correctly offers only 587 and
    // 5; the permissive pass nevertheless planned west and stopped in the cave.
    //
    // CONSTRAIN THE FIRST EXPANSION, NOT THE ROOM. A later route may legitimately re-enter
    // this room through another door, from another position, and the live answer observed
    // here says nothing about that later state.
    let availableFirstHops = null;
    const blockedHops = new Set();
    try {
      const geometry = this.geometry;
      const self = this.self;
      const origin = geometry && self ? this.origin() : null;
      // `origin()` deliberately falls back to `self` when it cannot reconcile that
      // position to a floor. That is useful to callers, but it is not authority for a
      // HARD absence claim: ROOM_CONTENTS can briefly describe the previous room and put
      // self outside this geometry. Fail open unless both the raw position and reconciled
      // origin are actually in the current room's bounds.
      if (geometry && self && origin
          && typeof geometry.inBounds === 'function'
          && geometry.inBounds(self.row, self.col)
          && geometry.inBounds(origin.row, origin.col)) {
        // CACHE THE ONE LIVE READ. `exits()` is expensive and, more importantly, a second
        // read can observe a different ROOM_CONTENTS generation. Every offered non-null
        // destination counts, including `reachable:false` / `verified:false`: those are
        // soft model warnings and the executor still has a concrete action to attempt.
        const offered = this.exits();
        availableFirstHops = new Set(offered
          .filter(e => e.to != null && Number.isFinite(Number(e.to)))
          .map(e => Number(e.to)));

        // ABSENCE IS HARD; AN OFFERED BUT UNVERIFIED EXIT IS STILL SOFT. Preserve the
        // existing preference against a destination whose every offered action is known
        // unreachable/unverified, using this SAME snapshot. `findPath` drops blockedHops
        // on its permissive pass but retains availableFirstHops, so the exit is avoided
        // when another executable route exists and still attempted when it is the only one.
        const byDest = new Map();
        for (const exit of offered) {
          if (exit.to == null || !Number.isFinite(Number(exit.to))) continue;
          const to = Number(exit.to);
          const usable = exit.reachable !== false && exit.verified !== false;
          byDest.set(to, byDest.get(to) === true ? true : usable);
        }
        for (const [to, usable] of byDest)
          if (!usable) blockedHops.add(`${room.num}>${to}`);
      }
    } catch { /* no authoritative geometry/self means no first-hop constraint */ }
    // AND WHAT THE CALLER HAS ACTUALLY WATCHED FAIL. `exits()` is a model, and a model that
    // says a hop is fine is not evidence that it is: the Western border of the Twisted Wood
    // publishes a perfectly reachable crossing to The Twisted Wood, and taking it lands the
    // character in the Main gate to the city of Tos instead, because both exits share one
    // boundary. Nothing in the model can see that. A journey that has watched it happen can.
    if (learned) for (const h of learned) blockedHops.add(h);
    const r = findPath(this.map, room.num, toRoomNum,
                       { avoid: merged, transitOk: this.transitOk(),
                         blockedHops: blockedHops.size ? blockedHops : null,
                         crossCost: this.crossCost(),
                         availableFirstHops });
    if (!r.found) return r;
    return {
      found: true,
      hops: r.hops.map(h => ({
        from: h.from, from_name: h.fromName, to: h.to, to_name: h.toName,
        kind: h.kind,
        // For an edge hop the square to aim for depends on which room you are in at
        // the time, so only the first leg can be resolved to a square here. The rest
        // are resolved as the agent arrives.
        stand_on: h.kind === 'go' ? { col: h.col, row: h.row } : null,
        direction: h.direction ?? null,
        how: h.how,
      })),
    };
  }
}

// A convenience for the broker: the shared map, loaded once.
let sharedMap = null;
export function sharedWorldMap(loader) {
  if (sharedMap === null) {
    try { sharedMap = loader(); } catch { sharedMap = false; }
  }
  return sharedMap || null;
}

// EXPAND EACH EDGE INTO EVERY SQUARE THAT CROSSES IT.
//
// An edge exit is a whole boundary, not a doorway: StandardLeaveDir fires wherever the
// condition allows you to step past it, so every standable square on that wall is the
// same exit. exits() reports the ones it used to discard as `alternates`; this turns
// each into a candidate of its own, so a caller working through a list tries the wall
// rather than one square of it.
//
// Kept here, beside the code that builds the alternates, so it can be tested — importing
// the broker starts a broker.
export function spreadEdges(candidates) {
  const out = [];
  for (const e of candidates || []) {
    out.push(e);
    for (const alt of e.alternates || [])
      out.push({ ...e, stand_on: { col: alt.col, row: alt.row }, steps_away: alt.steps,
                 fine_stand_on: alt.fine_stand_on ?? e.fine_stand_on,
                 edge_target: alt.edge_target ?? e.edge_target,
                 fine_path: alt.fine_path ?? e.fine_path,
                 alternates: undefined, from_alternate: true });
  }
  return out;
}

// A `go` sent immediately after the last movement update can disappear without either
// a refusal or a room transition. Retry only that silent case, once by default. A
// spoken refusal or a room change is authoritative, and the bound prevents a dead exit
// from becoming a loop.
export const DEFAULT_DOOR_SETTLE_MS = 500;

export function doorSettleMs(value = undefined) {
  if (value === undefined || value === null || value === '') return DEFAULT_DOOR_SETTLE_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DOOR_SETTLE_MS;
}

export function remainingDoorSettle({ lastMovementAt = 0, now = Date.now(), settleMs = DEFAULT_DOOR_SETTLE_MS } = {}) {
  return Math.max(0, Number(lastMovementAt) + doorSettleMs(settleMs) - Number(now));
}

export function retrySilentGo({ attempt = 0, maxAttempts = 2, entered = false, messages = [] } = {}) {
  return entered !== true && (!Array.isArray(messages) || messages.length === 0)
    && attempt < maxAttempts;
}

// Run the complete bounded request sequence without owning any broker state. Keeping
// the sequencing here makes the late-entry and cancellation races executable in the
// offline suite instead of leaving them as comments around Session.goThrough.
export async function boundedSilentGo({
  sequence,
  eventsSince,
  send,
  waitForEntry,
  cancelled = () => false,
  // Optional because this helper predates source-room pinning. A caller that can observe
  // the live room should supply a predicate captured against the room that chose the door.
  stillCurrent = () => true,
  maxAttempts = 2,
} = {}) {
  if (![sequence, eventsSince, send, waitForEntry, cancelled, stillCurrent]
      .every(fn => typeof fn === 'function'))
    throw new TypeError('boundedSilentGo requires sequence, eventsSince, send, waitForEntry, ' +
                        'cancelled, and stillCurrent functions');
  const before = sequence();
  let attempts = 0, entered = null;
  const messages = [];
  while (attempts < maxAttempts) {
    if (cancelled())
      return { cancelled: true, entered: null, messages, attempts };
    // An entry can land after the prior wait timed out but before the retry. Observe
    // the whole request window here; never send a second go after a late success.
    const lateEntry = eventsSince(before).find(event => event.kind === 'room-entered');
    if (lateEntry) { entered = lateEntry; break; }
    // A room transition whose event was missed is still authoritative. In particular, do
    // not send the bounded retry in the destination room merely because the event ring is
    // silent. The caller will re-read and re-plan from the newly published room.
    if (!stillCurrent())
      return { cancelled: false, entered: null, messages, attempts,
               unconfirmed_transition: true };

    const attemptBefore = sequence();
    await send();
    attempts++;
    entered = await waitForEntry(attemptBefore) ?? null;
    // Only messages produced after this go count. A stand-up acknowledgement or
    // unrelated event before the request must not suppress the one allowed retry.
    const attemptMessages = eventsSince(attemptBefore)
      .filter(event => event.text)
      .map(event => event.text);
    messages.push(...attemptMessages);
    if (!entered && !stillCurrent())
      return { cancelled: false, entered: null, messages, attempts,
               unconfirmed_transition: true };
    if (!retrySilentGo({
      attempt: attempts,
      maxAttempts,
      entered: !!entered,
      messages: attemptMessages,
    })) break;
  }
  return { cancelled: false, entered, messages, attempts };
}

// Enter a code-defined floor region without trusting the square grid to be the final
// authority. Each candidate is tried once: ordinary walking first, then a caller-supplied
// fine movement fallback, and finally `go` only when we actually reached the region but
// its automatic SomethingMoved hook did not fire. Keeping this orchestration independent
// of Session makes the no-packet false refusal, late room entry, and retry bound testable.
export async function boundedRegionEntry({
  candidates,
  sequence,
  eventsSince,
  walk,
  fineWalk,
  waitForEntry,
  askGo,
  cancelled = () => false,
  // See boundedSilentGo. Region candidates are coordinates in the source room, so a
  // missed room-entered event must stop the sequence before another candidate is touched.
  stillCurrent = () => true,
} = {}) {
  if (![sequence, eventsSince, walk, fineWalk, waitForEntry, askGo, cancelled, stillCurrent]
      .every(fn => typeof fn === 'function'))
    throw new TypeError('boundedRegionEntry requires sequence, eventsSince, walk, fineWalk, ' +
                        'waitForEntry, askGo, cancelled, and stillCurrent functions');

  const targets = (Array.isArray(candidates) ? candidates : []).filter(candidate =>
    candidate?.stand_on && Number.isFinite(candidate.stand_on.col) && Number.isFinite(candidate.stand_on.row));
  const tried = [];
  const enteredSince = since => eventsSince(since).find(event => event.kind === 'room-entered') ?? null;

  for (const candidate of targets) {
    if (cancelled()) return { cancelled: true, entered: null, tried };
    if (!stillCurrent())
      return { cancelled: false, entered: null, unconfirmed_transition: true, tried };
    const before = sequence();
    const coarse = await walk(candidate);
    let entered = enteredSince(before);
    if (!entered && (coarse?.arrived || coarse?.left_room)) entered = await waitForEntry(before);
    if (entered) return { cancelled: false, entered, tried: [...tried, { candidate, coarse }] };
    if (coarse?.left_room)
      return { cancelled: false, entered: null, unconfirmed_transition: true,
               tried: [...tried, { candidate, coarse }] };
    if (!stillCurrent())
      return { cancelled: false, entered: null, unconfirmed_transition: true,
               tried: [...tried, { candidate, coarse }] };
    if (isTerminalMovementReason(coarse?.reason))
      return { cancelled: false, entered: null, terminal: coarse,
               tried: [...tried, { candidate, coarse }] };

    let fine = null;
    if (!coarse?.arrived) {
      if (cancelled()) return { cancelled: true, entered: null, tried };
      fine = await fineWalk(candidate);
      entered = enteredSince(before);
      if (!entered && (fine?.arrived || fine?.left_room)) entered = await waitForEntry(before);
      if (entered)
        return { cancelled: false, entered, tried: [...tried, { candidate, coarse, fine }] };
      if (fine?.left_room)
        return { cancelled: false, entered: null, unconfirmed_transition: true,
                 tried: [...tried, { candidate, coarse, fine }] };
      if (!stillCurrent())
        return { cancelled: false, entered: null, unconfirmed_transition: true,
                 tried: [...tried, { candidate, coarse, fine }] };
      if (isTerminalMovementReason(fine?.reason))
        return { cancelled: false, entered: null, terminal: fine,
                 tried: [...tried, { candidate, coarse, fine }] };
    }

    const reached = !!(coarse?.arrived || fine?.arrived);
    let askedGo = false;
    if (reached) {
      if (cancelled()) return { cancelled: true, entered: null, tried };
      if (!stillCurrent())
        return { cancelled: false, entered: null, unconfirmed_transition: true,
                 tried: [...tried, { candidate, coarse, fine }] };
      const beforeGo = sequence();
      await askGo(candidate);
      askedGo = true;
      entered = enteredSince(before) ?? await waitForEntry(beforeGo);
      if (entered)
        return { cancelled: false, entered,
                 tried: [...tried, { candidate, coarse, fine, asked_go: true }] };
      if (!stillCurrent())
        return { cancelled: false, entered: null, unconfirmed_transition: true,
                 tried: [...tried, { candidate, coarse, fine, asked_go: true }] };
    }
    tried.push({ candidate, coarse, fine, ...(askedGo ? { asked_go: true } : {}) });
  }
  return { cancelled: false, entered: null, tried };
}
