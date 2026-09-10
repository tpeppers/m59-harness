#!/usr/bin/env node
// A ROOM REFERENCE CARRIES ITS SPACE. There are two, they are both small integers, and nothing
// about either number says which one it is.
//
//   node tools/m59-roomref.mjs 413          which space is this number in?
//   node tools/m59-roomref.mjs --collisions every number that is valid in BOTH spaces
//
//   import { roomRef, expectRoomNum, roomNumOf, objIdOf } from './m59-roomref.mjs';
//
// THE TWO SPACES:
//
//   ROOM NUMBER  the bake's key, what `travel`, `findPath`, `KNOWN_TRAPS`, every route and every
//                tool argument means by "room". Room 153 is the Cibilo Creek Inn.
//   OBJECT ID    the server's id for the room OBJECT, which is what the client's own room
//                structure calls `.id`. The Cibilo Creek Inn's is 413.
//
// WHAT IT COST, 2026-09-10. `escapeUnderworld` returned `room: now.id` — the object id — in a
// field called `room`, twice in one evening, to two different sessions:
//
//   {"left":true,"arrived_in":"Familiars","room":94}            Familiars is room 52, objId 94
//   {"left":true,"arrived_in":"Cibilo Creek Inn","room":413}    the inn is room 153, objId 413
//
// Both readers took it for a room number, because it is called `room` and it is a small integer.
// I then pinned a character's `assignedRoom` to 413 — a room that does not exist in the bake —
// which is how a keeper is told to walk a body to nowhere for ever. Caught only because the
// operator asked the right question: "They might be using object IDs instead of the correct
// roomID numbers?"
//
// It is the same failure as the coordinate spaces, and this repository already solved that one:
// `FINENESS` is 64 in kod and 1024 in the client, so `m59-coords.mjs` refuses a bare number and
// makes every boundary say `expectUnit(p, 'client', where)`. THE ANSWER HERE IS THE SAME SHAPE.
//
// AND THE MISTAKE IS DETECTABLE, which is what makes it worth a module rather than a comment.
// The two spaces barely overlap: of the numbers that are valid room numbers, only a handful are
// also valid object ids, so a number that is NOT a room number and IS an object id can be named
// as such — "413 is the object id of room 153 (Cibilo Creek Inn); did you mean 153?" — instead of
// being reported as a room that is missing from the map. `--collisions` prints the ambiguous
// ones, because those are the cases where no checker can help and only the field name can.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let _map = null;
let _byObj = null;

/** The bake, loaded at most once. Injectable so a test never touches the real map. */
export function useMap(map) { _map = map; _byObj = null; return _map; }

function theMap() {
  if (_map) return _map;
  // Imported lazily: this module is meant to be safe to require from anywhere, including
  // processes that have no business loading a 40MB collision bake.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ['m59-map.local.json', 'm59-map.json']) {
    try {
      _map = JSON.parse(readFileSync(join(here, '..', 'substrate', name), 'utf8'));
      return _map;
    } catch { /* try the next one */ }
  }
  _map = { rooms: {} };
  return _map;
}

function byObj() {
  if (_byObj) return _byObj;
  _byObj = new Map();
  for (const [num, r] of Object.entries(theMap().rooms ?? {}))
    if (r?.objId != null) {
      const k = Number(r.objId);
      // ONE OBJECT ID MAY NAME SEVERAL BAKED ROOMS, because an instanced room is baked more
      // than once — the guest Mausoleum is 1006 and 1016 off one .roo. Reported, not resolved:
      // picking one silently is how the stone census first went wrong.
      if (!_byObj.has(k)) _byObj.set(k, []);
      _byObj.get(k).push(Number(num));
    }
  return _byObj;
}

const isRoomNum = (n) => {
  const m = theMap().rooms ?? {};
  return m[Number(n)] != null || m[String(n)] != null;
};

/** Room numbers this object id belongs to (usually one, several for an instanced room). */
export function roomNumOf(objId) {
  return [...(byObj().get(Number(objId)) ?? [])];
}

/** The object id of a room number, or null when the bake does not carry one. */
export function objIdOf(roomNum) {
  const r = theMap().rooms?.[Number(roomNum)] ?? theMap().rooms?.[String(roomNum)];
  return r?.objId != null ? Number(r.objId) : null;
}

/**
 * What is this number? Answered in both spaces at once, so a caller never has to guess.
 *
 * `{ num, objId, name, space }` where `space` is 'room' | 'object' | 'both' | 'neither'. `both`
 * is the honest answer for a number that is valid either way, and the only correct response to
 * it is to look at where the number came from.
 */
export function roomRef(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return { space: 'neither', num: null, objId: null, name: null };
  const asRoom = isRoomNum(n);
  const asObj = roomNumOf(n);
  const space = asRoom && asObj.length ? 'both' : asRoom ? 'room' : asObj.length ? 'object'
              : 'neither';
  const num = asRoom ? n : (asObj[0] ?? null);
  const rooms = theMap().rooms ?? {};
  return { space, num, objId: asRoom ? objIdOf(n) : n,
           name: num != null ? (rooms[num]?.name ?? rooms[String(num)]?.name ?? null) : null,
           ...(asObj.length > 1 ? { instances: asObj } : {}) };
}

/**
 * Is this a room number? Returns null when it is, or the sentence to refuse it with.
 *
 * The sentence is the product. "room 413 is not in the baked map" sends a reader to look for a
 * missing room; "413 is the object id of room 153 (Cibilo Creek Inn) — did you mean 153?" ends
 * the enquiry in one line, which is the difference this module exists for.
 */
export function expectRoomNum(x, where = 'here') {
  const n = Number(x);
  if (!Number.isFinite(n)) return `${where}: ${JSON.stringify(x)} is not a number, and a room ` +
                                  `reference has to be one`;
  if (isRoomNum(n)) return null;
  const rooms = roomNumOf(n);
  if (rooms.length) {
    const named = rooms.map(r => `${r} (${theMap().rooms?.[r]?.name ?? '?'})`).join(' or ');
    return `${where}: ${n} is NOT a room number — it is the OBJECT ID of room ${named}. ` +
           `Did you mean ${rooms.join(' or ')}? The client's own room structure calls the ` +
           `object id \`.id\`, and the bake's key is \`.num\`; see tools/m59-roomref.mjs`;
  }
  return `${where}: ${n} is not a room number in the baked map, and not the object id of any ` +
         `room either`;
}

/** Both numbers, named, for a reply that would otherwise carry a bare `room`. */
export function roomFields(x) {
  const ref = roomRef(x);
  return { room: ref.num, room_object_id: ref.objId, room_name: ref.name };
}

// ---------------------------------------------------------------- CLI

const IS_ENTRY = !!process.argv[1] &&
  join(process.argv[1]) === join(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  const argv = process.argv.slice(2);
  if (argv.includes('--collisions')) {
    const rooms = theMap().rooms ?? {};
    const both = Object.keys(rooms).map(Number).filter(n => roomNumOf(n).length);
    console.log('');
    console.log(`${both.length} number(s) are valid in BOTH spaces, out of ` +
                `${Object.keys(rooms).length} rooms. For these, no checker can tell you which ` +
                `space a number is in — only the field it arrived in can.`);
    for (const n of both)
      console.log(`  ${String(n).padStart(5)}  room ${JSON.stringify(rooms[n]?.name ?? null)}` +
                  `  is also the object id of room(s) ${roomNumOf(n).join(', ')}`);
    console.log('');
    process.exit(0);
  }
  const n = Number(argv.find(a => /^\d+$/.test(a)));
  if (!Number.isFinite(n)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(argv.length ? 1 : 0);
  }
  const ref = roomRef(n);
  console.log('');
  console.log(`${n} — ${ref.space === 'both' ? 'AMBIGUOUS: valid in both spaces'
    : ref.space === 'room' ? 'a ROOM NUMBER' : ref.space === 'object' ? 'an OBJECT ID'
    : 'neither a room number nor a room object id'}`);
  if (ref.num != null) {
    console.log(`  room number  ${ref.num}${ref.instances ? ` (also ${ref.instances.slice(1).join(', ')} — instanced)` : ''}`);
    console.log(`  object id    ${ref.objId}`);
    console.log(`  name         ${ref.name}`);
  }
  const why = expectRoomNum(n, 'as a room number');
  console.log(why ? `  REFUSED: ${why}` : '  usable as a room number');
  console.log('');
}
