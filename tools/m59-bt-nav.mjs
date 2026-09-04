#!/usr/bin/env node
// m59-bt-nav.mjs -- GOAP navigation: plan a multi-room route, execute hop by hop.
//
// Exports:
//   MoveToRoomAction(toRoom)  — atomic: cross one exit boundary to reach toRoom
//   navigationActions(map, fromRoom, toRoom, session) — build the action set for plan()
//   NavigateTo(toRoom, opts)  — GoapExecutor wired for room-to-room travel

import { Action, SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import { GoapExecutor }                       from './m59-goap-planner.mjs';
import { findPath, loadMap, exitsOf,
         inferredExits, codeExits }           from './m59-map.mjs';

// ---------------------------------------------------------------------------
// MoveToRoomAction
//
// Crosses one exit boundary from the current room to toRoom.
// Uses session.leaveVia() (the broker method, which handles edge vs go exits,
// fine-unit fallback, door-lean, etc.).
//
// Pre:     at_room_<current>   (checked externally — planner enforces ordering)
// Effects: at_room_<toRoom>
// ---------------------------------------------------------------------------
export function MoveToRoomAction(toRoom) {
  const key = `at_move_room_${toRoom}`;

  const node = new Action((bb, slot) => {
    if (!slot || slot.done === undefined) {
      slot = { done: false, ok: false };
      bb._bt[key] = slot;

      const s = bb.session?.s ?? null;
      if (!s) { slot.done = true; return RUNNING; }

      Promise.resolve()
        .then(async () => {
          const currentRoom = s.world?.room?.num;
          if (currentRoom === toRoom) return true;   // already there

          // Find the exit from the current room that leads to toRoom.
          // world.exits() is enriched with stand_on and steps_away.
          const exits = s.world?.exits?.() ?? [];
          const candidates = exits.filter(e => e.to === toRoom && e.stand_on != null);

          if (!candidates.length) {
            // Fall back to map exits (no stand_on, but leaveVia can still try).
            const room = s.world?.room;
            if (!room) return false;
            const mapExits = [
              ...exitsOf(room),
              ...inferredExits(s.world?.map, room.num),
              ...codeExits(room.num),
            ].filter(e => e.to === toRoom);
            if (!mapExits.length) return false;
            candidates.push(...mapExits);
          }

          // Sort: reachable first, then by steps_away ascending.
          candidates.sort((a, b) =>
            (a.stand_on == null) - (b.stand_on == null) ||
            (a.steps_away ?? Infinity) - (b.steps_away ?? Infinity));

          for (const exit of candidates) {
            const r = await s.leaveVia(exit).catch(() => null);
            if (r?.left) {
              // Confirm we landed in the right room.
              return s.world?.room?.num === toRoom;
            }
            // Do not execute another candidate captured from the source room. A later tree
            // pass will rebuild the action from whichever logical room is now stable.
            if (r?.room_changed) return false;
          }
          return false;
        })
        .then(ok => {
          if (ok) {
            const ws = bb.ws ?? (bb.ws = {});
            ws[`at_room_${toRoom}`] = true;
          }
          slot.ok = ok;
          slot.done = true;
        })
        .catch(() => { slot.done = true; });

      return RUNNING;
    }

    if (!slot.done) return RUNNING;
    const ok = slot.ok;
    delete bb._bt[key];
    return ok ? SUCCESS : FAILURE;
  }, { key, name: `move_to_room_${toRoom}` });

  node.pre     = [];                      // planner chains these via ordering
  node.effects = [`at_room_${toRoom}`];
  return node;
}

// ---------------------------------------------------------------------------
// navigationActions
//
// Given a route (array of room numbers), builds one action per hop with
// chained pre/effects so the planner enforces ordering.
//
// rooms: [fromRoom, hop1, hop2, ..., toRoom]
//
// Hop n:
//   pre:     [at_room_<rooms[n]>]
//   effects: [at_room_<rooms[n+1]>, !at_room_<rooms[n]>]
//   cost:    1 per hop (uniform cost — the router already chose the safest path)
// ---------------------------------------------------------------------------
export function navigationActions(rooms) {
  if (rooms.length < 2) return [];
  return rooms.slice(0, -1).map((from, i) => {
    const to   = rooms[i + 1];
    const node = MoveToRoomAction(to);
    node.pre     = [`at_room_${from}`];
    node.effects = [`at_room_${to}`, `!at_room_${from}`];
    node.cost    = 1;
    return { pre: node.pre, effects: node.effects, cost: node.cost, node };
  });
}

// ---------------------------------------------------------------------------
// NavigateTo(toRoom, opts) — top-level GoapExecutor for room navigation.
//
// Finds a path from the character's current room to toRoom using findPath(),
// builds the action set, and returns a GoapExecutor node ready to tick.
//
// opts:
//   map       object  loaded map (loadMap()); if omitted, loads the default
//   key       string  blackboard slot key
// ---------------------------------------------------------------------------
export function NavigateTo(toRoom, opts = {}) {
  const map = opts.map ?? loadMap();
  const key = opts.key ?? `nav_to_${toRoom}`;

  const wsSource = bb => {
    const ws = bb.ws ?? (bb.ws = {});
    // Sync current room into ws on each read.
    const s = bb.session?.s ?? null;
    const currentRoom = s?.world?.room?.num ?? null;
    if (currentRoom != null) ws[`at_room_${currentRoom}`] = true;
    return ws;
  };

  // Build actions lazily on first plan() call inside GoapExecutor.
  // We wrap in a factory that reads the current room from bb at plan time.
  const goal = { [`at_room_${toRoom}`]: true };

  // We need to supply the action set, but it depends on the current room which
  // we only know at tick time. Solve this by making GoapExecutor call a dynamic
  // action builder: we pass a special sentinel action whose .pre is always met
  // and whose node re-derives the plan on the fly.
  //
  // Simpler: pre-compute the full action set from all possible intermediate
  // rooms — the planner's A* will ignore irrelevant actions naturally.
  const actions = _buildAllNavActions(map, toRoom);

  return GoapExecutor(actions, goal, { key, wsSource });
}

// Build one action per directed edge in the map that could be on a path to toRoom.
// This is a superset; A* will only use what's relevant.
function _buildAllNavActions(map, toRoom) {
  const actions = [];
  const rooms   = Object.values(map.rooms ?? {}).filter(r => r != null);

  for (const room of rooms) {
    const from = room.num;
    const exits = [
      ...exitsOf(room),
      ...inferredExits(map, from),
      ...codeExits(from),
    ].filter(e => e.to != null);

    for (const exit of exits) {
      const to = exit.to;
      const node = MoveToRoomAction(to);
      node.pre     = [`at_room_${from}`];
      node.effects = [`at_room_${to}`, `!at_room_${from}`];
      node.cost    = 1;
      actions.push({ pre: node.pre, effects: node.effects, cost: node.cost, node });
    }
  }

  return actions;
}
