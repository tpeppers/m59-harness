// THE ONE RESHAPE FROM A KEEPER'S ROOM VIEW INTO THE RENDERER'S PROJECTION.
//
// `World.perception()` (m59-world.mjs) is what an in-process session hands a renderer:
// where this character is standing and facing, and every object in the room with its id,
// square, distance, facing and affordance list. Out-of-process keepers are now the default,
// and on that arrangement the broker holds a two-second snapshot rather than a World — so
// the same question had no answer at all. Measured on prod with twenty-one characters in
// game, `GET /rts/v1/read` returned `looks: { t1: {}, t2: {}, ... }` for the whole fleet,
// status 200, no error: a renderer got a well-formed frame in which nobody had a position.
//
// The keeper owns the socket and already publishes `/room-view` for the 3D map. This is the
// reshape from that into the projection, kept OUT of m59-broker.mjs for one reason: that
// file cannot be imported without starting a broker, so nothing in it can be tested offline.
// `m59-render-test.mjs` pins every rule below.
//
// Two rules that are not obvious and both cost something when they were absent:
//
//   AFFORDANCES COME FROM THE FLAG WORD, not from a boolean. `/room-view` used to publish
//   `is_player` and `can_attack` and nothing else, so everything that was neither read as
//   one undifferentiated bucket and a renderer could not tell a mummy from a bar stool.
//   `affordances()` in m59-parse.mjs is the one function that owns the meaning of those
//   bits; this calls it rather than re-deriving a subset.
//
//   ROOM SIZE IS THE MAP'S, NOT THE KEEPER'S. The game server never reports room
//   dimensions, so the keeper sends 50x48 for every room. A renderer that believes it draws
//   an 8x11 inn as a mostly-void field — the same fault the dashboard's 3D view already
//   corrects from the .roo. The world map wins when it has an answer, and `size_source`
//   says which one answered, because a caller comparing two frames should be able to see
//   that one of them was measured and the other defaulted.

import { affordances } from './m59-parse.mjs';
import { dirName } from './m59-world.mjs';
import { canonicalRoomWire, sameRoomWire } from './m59-room-wire.mjs';

const RENDER_INTEGER_FIELDS = Object.freeze(['x', 'y', 'angle', 'appearance_revision']);

// This is a carry boundary, not a second appearance parser. The keeper has already
// projected one synchronous protocol-cache object through World.renderState(), and the
// strict RTS contract remains the one place that normalizes the nested appearance shape.
// Preserve explicit nulls, but do not turn malformed or absent fields into renderer facts.
function renderStateFromKeeper(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const field of RENDER_INTEGER_FIELDS) {
    if (row[field] === null || Number.isInteger(row[field])) out[field] = row[field];
  }
  if (row.facing_degrees === null || Number.isFinite(row.facing_degrees))
    out.facing_degrees = row.facing_degrees;
  if (row.appearance === null ||
      (row.appearance && typeof row.appearance === 'object' && !Array.isArray(row.appearance))) {
    out.appearance = row.appearance;
  }
  return out;
}

// `rv` is the keeper's /room-view body. `mapRoom` is `worldMap.rooms[rv.room_num]` or null.
export function renderProjection(rv, mapRoom = null) {
  // NO `room` AND NO `you` KEY AT ALL, rather than either of them set to null. The broker
  // folds this projection OVER the keeper's own state, and that state does know which room
  // the character is in — a null here would overwrite a true answer with a false one, which
  // is a worse failure than the missing position this whole file is about.
  if (!rv || rv.error) {
    return {
      objects: [], exits: [], projection: 'render',
      render_note: rv?.error ? `keeper room view: ${rv.error}` : 'keeper room view unavailable',
    };
  }

  const measured = mapRoom && mapRoom.rows && mapRoom.cols;
  const candidateWire = canonicalRoomWire(rv.room_wire);
  // A filename is a local map fact, never part of BP_PLAYER. Attach it only
  // after the live resource tuple selects this exact map row; an unbound legacy
  // projection keeps its previous room shape.
  const boundMapRoom = !!candidateWire &&
    rv.room_num === candidateWire.resolved_room_num &&
    mapRoom?.num === candidateWire.resolved_room_num &&
    mapRoom?.roomRsc === candidateWire.room_resource_id &&
    typeof mapRoom?.rooFile === 'string' && mapRoom.rooFile.length > 0 &&
    Number.isInteger(mapRoom?.rows) && mapRoom.rows > 0 &&
    Number.isInteger(mapRoom?.cols) && mapRoom.cols > 0;
  const size = measured
    ? { rows: mapRoom.rows, cols: mapRoom.cols }
    : { rows: rv.rows ?? null, cols: rv.cols ?? null };

  const me = rv.self && Number.isFinite(rv.self.col) && Number.isFinite(rv.self.row)
    ? rv.self : null;

  const objects = (Array.isArray(rv.objects) ? rv.objects : [])
    .filter(o => o && !o.is_self && Number.isFinite(o.col) && Number.isFinite(o.row))
    .map(o => {
      // An older keeper sends no flag word. Say what those two booleans support and no
      // more — a missing bit must not read as "the server refuses that", which is what an
      // invented affordance list would claim.
      const flags = Number.isInteger(o.flags) ? o.flags : null;
      const can = flags != null ? affordances(flags)
        : [...(o.can_attack ? ['attack'] : []), 'look'];
      const out = {
        id: o.id,
        name: o.name ?? '',
        col: o.col, row: o.row,
        distance: me ? Math.round(Math.hypot(o.col - me.col, o.row - me.row)) : null,
        facing: o.degrees != null ? dirName(o.degrees) : null,
        can,
        is_player: !!o.is_player,
        ...renderStateFromKeeper(o),
        ...(flags == null ? { affordances_source: 'two booleans from an older keeper' } : {}),
      };
      if (o.amount) out.amount = o.amount;
      return out;
    })
    .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));

  return {
    room: {
      num: rv.room_num ?? null,
      name: rv.room_name ?? null,
      size,
      size_source: measured ? 'world map .roo' : 'keeper default — the server does not report room size',
      ...(boundMapRoom ? { resource: mapRoom.rooFile } : {}),
    },
    you: me
      ? {
          object_id: me.object_id ?? null,
          col: me.col, row: me.row,
          facing: me.degrees != null ? dirName(me.degrees) : null,
          facing_degrees: me.degrees ?? null,
          ...renderStateFromKeeper(me),
        }
      : { note: 'the keeper has not placed this character in its room yet — it has just arrived, or it is dead' },
    objects,
    // Exits and reachability need a World, and a World needs the live position and geometry
    // the keeper process owns. Empty and SAID OUT LOUD rather than absent, because a
    // renderer asking for exits and quietly getting none is the failure this file exists
    // to undo, one layer along.
    exits: [],
    projection: 'render',
    topology_note: 'exits and reachability belong to the tactical look, which lives in the ' +
      'keeper process — move with walk_to/go_through rather than inferring an exit from this',
    target: rv.target ?? null,
    ...(boundMapRoom ? { room_wire: candidateWire } : {}),
    ...(rv.room_wire != null && !boundMapRoom
      ? { room_binding_note: 'room_wire did not select this exact configured map row; ' +
          'bound provenance and room resource withheld' }
      : {}),
  };
}

// ---------------------------------------------------------------- the composed view

// WHAT `look` RETURNS ON A KEEPER-BACKED BROKER, AND WHY IT IS ASSEMBLED HERE.
//
// `KeeperProxy.view()` holds two caches on two different clocks: the keeper's `/state`, and
// the keeper's `/room-view`. Composing them has now gone wrong twice in different
// directions, and both failures were one property deep:
//
//   * an ASYNC view() — `arrivalReport` in m59-game.mjs calls `s.view()` without awaiting
//     it, so `v.objects.filter(...)` threw on a promise and every `travel`, `go_through`
//     and `leave` died with "Cannot read properties of undefined". Not a movement bug.
//   * a view() that spread the raw room view and then overwrote `you` and `objects` from a
//     state that never carries either — so it was well-formed, synchronous, and empty.
//
// So the composition is a pure function with a test, rather than an expression inside a
// class that cannot be imported. `mapRoomFor(num)` looks a room up in the world map;
// it may return null.
export function keeperView(state, roomView, mapRoomFor = () => null) {
  const s = state ?? {};
  const stateRoom = s.room ? { num: s.room.num, name: s.room.name } : null;
  const rv = roomView && !roomView.error ? roomView : null;
  const stateWire = canonicalRoomWire(s.room_wire);
  const roomViewWire = canonicalRoomWire(rv?.room_wire);

  // TWO CLOCKS, RECONCILED RATHER THAN MERGED. Right after a hop the state can already name
  // the new room while the room view still describes the old one. A position from a room the
  // character has LEFT is worse than no position: it is an arrival report describing what is
  // standing next to you somewhere else. So the projection is used only when the two agree,
  // and `stale_render` says so when they do not.
  const agrees = !!rv && !!stateRoom && (rv.room_num == null || rv.room_num === stateRoom.num);
  const projection = agrees
    ? renderProjection(rv, mapRoomFor(rv.room_num ?? stateRoom.num))
    : null;
  const projectionWire = canonicalRoomWire(projection?.room_wire);
  const boundAgrees = !!stateWire && !!roomViewWire && !!projectionWire &&
    sameRoomWire(stateWire, roomViewWire) && sameRoomWire(stateWire, projectionWire) &&
    stateRoom?.num === stateWire.resolved_room_num &&
    rv?.room_num === stateWire.resolved_room_num;

  // Never let a tuple from only one cache escape through either spread below.
  // Likewise, a resource filename is part of the complete bound look and is
  // withheld when the independently sampled state and room view do not agree.
  const { room_wire: _stateWire, ...stateOut } = s;
  const { room_wire: _projectionWire, room_binding_note: projectionBindingNote,
          ...projectionOut } = projection ?? {};
  const projectionRoom = projection?.room
    ? (boundAgrees ? projection.room : (() => {
        const { resource: _resource, ...legacyRoom } = projection.room;
        return legacyRoom;
      })())
    : null;

  let roomBindingNote = null;
  if (!boundAgrees) {
    if (stateWire && roomViewWire && !sameRoomWire(stateWire, roomViewWire))
      roomBindingNote = 'keeper state and room view carry different room_wire tuples; bound provenance withheld';
    else if (!stateWire && !roomViewWire)
      roomBindingNote = 'keeper state and room view do not carry complete room_wire provenance';
    else if (!stateWire)
      roomBindingNote = 'keeper state does not carry complete room_wire provenance';
    else if (!roomViewWire)
      roomBindingNote = 'keeper room view does not carry complete room_wire provenance';
    else if (projectionBindingNote)
      roomBindingNote = projectionBindingNote;
    else
      roomBindingNote = 'room_wire does not agree with the room clocks; bound provenance withheld';
  }

  return {
    ...stateOut,
    ...(projection ? projectionOut : {}),
    room: projectionRoom ?? stateRoom,
    you: projection?.you ?? null,
    // The shape `arrivalReport` reads, and the shape a real `World.snapshot()` returns.
    vitals: { health: s.hp ?? null, mana: s.mana ?? null, vigor: s.vigor ?? null },
    objects: projection?.objects ?? [],
    // The tactical scene's exits need a World, which lives in the keeper process. ALWAYS an
    // array: `arrivalReport` reads `v.exits.length` without a guard.
    exits: [],
    // AND IT HAS TO SAY THAT THE EMPTY ARRAY IS AN ABSENCE, NOT A MEASUREMENT.
    //
    // `arrivalReport` turned this into `exits: 0` — a NUMBER, which reads as a count somebody
    // took. Read off the code rather than from a sighting: this line is unconditional, and
    // `arrivalReport` did `exits: v.exits.length` with no guard, so EVERY keeper-backed arrival
    // report — which is every character in a running fleet — said a room had no exits. West
    // Jasper declares thirty-five.
    //
    // (A session did report seeing exactly that on 2026-09-10 and then WITHDREW it, having
    // traced its own reading to a broken helper. The withdrawal is why the citation here is the
    // code path and not their observation — but the defect is in the two lines, so it stands
    // whether or not anyone had seen it yet.)
    //
    // Same family as the instrument failures that filled that day: one that cannot produce the
    // value which would show the problem produces a confident wrong one instead. So the absence
    // is FLAGGED, and every reader that turns this into a scalar has to check it.
    exits_unknown: true,
    exits_note: 'the broker holds a keeper SNAPSHOT and tactical exits need the live World — ' +
                'ask the keeper (/action look), or `node tools/m59-exits.mjs <room>` for every ' +
                'way in and out of the room with its provenance',
    scenery: { total: 0 },
    as_of_ms: s.as_of_ms ?? null,
    ...(rv && !agrees
      ? { stale_render: `the keeper's room view is for room ${rv.room_num ?? '?'} and this ` +
                         `character is in ${stateRoom?.num ?? '?'} — positions withheld` }
      : {}),
    ...(boundAgrees ? { room_wire: stateWire } : { room_binding_note: roomBindingNote }),
    source: projection
      ? "keeper snapshot, plus the keeper's own room view"
      : 'keeper snapshot — /room-view on the keeper has the room contents',
  };
}
