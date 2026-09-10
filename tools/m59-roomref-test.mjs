#!/usr/bin/env node
// A ROOM REFERENCE CARRIES ITS SPACE — offline, no broker, no server, no roster.
//
//   node tools/m59-roomref-test.mjs
//
// THE INCIDENT, 2026-09-10. `escapeUnderworld` returned the client room's `.id` — an OBJECT ID —
// in a field called `room`, twice in one evening to two different readers:
//
//   {"left":true,"arrived_in":"Familiars","room":94}          Familiars is room 52, objId 94
//   {"left":true,"arrived_in":"Cibilo Creek Inn","room":413}  the inn is room 153, objId 413
//
// Both took it for a room number. One then set a keeper's `assignedRoom` to 413 — a room that
// does not exist in the bake — which is how a body is told to walk to nowhere for ever.
//
// The operator named it from the shape alone: "They might be using object IDs instead of the
// correct roomID numbers?.. we should try to make that an impossible mistake to make."
//
// Impossible is the goal and detectable is what is achievable, so this pins the detection AND
// the case where detection cannot work: a handful of numbers are valid in BOTH spaces, and for
// those only the field name can say which is meant. The assertions below are the two halves.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomRef, expectRoomNum, roomNumOf, objIdOf, roomFields, useMap } from './m59-roomref.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra !== undefined ? '  — ' + extra : ''}`); }
};

// A fixture rather than the real bake: the point is the DECISION, and a test that needs a 40MB
// collision map to check an integer is a test nobody runs.
useMap({ rooms: {
  52:   { name: 'Familiars',         objId: 94 },
  153:  { name: 'Cibilo Creek Inn',  objId: 413 },
  536:  { name: 'Forest of Farol',   objId: 1366 },
  376:  { name: 'Jasper bank',       objId: 593 },
  593:  { name: 'Main gate of Barloque', objId: 7777 },   // valid in BOTH spaces
  1006: { name: 'Mausoleum',         objId: 2125 },
  1016: { name: 'Mausoleum',         objId: 2125 },       // instanced: one objId, two rooms
} });

console.log('');
console.log('WHICH SPACE IS THIS NUMBER IN');
{
  ok('a room number says so', roomRef(153).space === 'room');
  ok('an object id says so', roomRef(413).space === 'object');
  ok('and resolves to its room', roomRef(413).num === 153 && roomRef(413).name === 'Cibilo Creek Inn');
  ok('a room number carries its object id too', roomRef(153).objId === 413);
  ok('a number in neither space says that', roomRef(999999).space === 'neither');
  ok('and so does something that is not a number', roomRef('west').space === 'neither');
}

console.log('');
console.log('THE REFUSAL IS THE PRODUCT — it has to name the confusion, not report a missing room');
{
  ok('a room number is accepted', expectRoomNum(153, 'travel') === null);
  const why = expectRoomNum(413, 'travel');
  ok('an object id is refused', typeof why === 'string');
  ok('and the refusal names the room it IS the id of',
     /OBJECT ID of room 153 \(Cibilo Creek Inn\)/.test(why ?? ''), why);
  ok('and asks the question that ends the enquiry', /Did you mean 153\?/.test(why ?? ''), why);
  // "room 413 is not in the baked map" is a true sentence that sends a reader looking for a
  // missing room. That is the failure mode being fixed, so it must not be the message.
  ok('and does NOT say the room is missing from the map',
     !/not in the baked map/.test(why ?? ''), why);
  ok('a number in neither space gets the other sentence',
     /not the object id of any room/.test(expectRoomNum(999999, 'travel') ?? ''));
  ok('a non-number is refused as a non-number',
     /is not a number/.test(expectRoomNum('west', 'travel') ?? ''));
  ok('the refusal names where it came from', /^travel:/.test(expectRoomNum(413, 'travel') ?? ''));
}

console.log('');
console.log('WHERE NO CHECKER CAN HELP, AND THE HONEST ANSWER IS "AMBIGUOUS"');
{
  // 593 is the Main gate of Barloque AND the object id of the Jasper bank. A checker that
  // guessed here would be worse than none: it would silently rewrite one town into another.
  const both = roomRef(593);
  ok('a number valid in both spaces is called ambiguous', both.space === 'both', both.space);
  ok('and it is still usable as a room number, because it IS one',
     expectRoomNum(593, 'travel') === null);
  ok('while still knowing which room it is the id of', roomNumOf(593).includes(376));
  // This is the argument for naming the field rather than checking the value.
  ok('the room it names and the room it is the id of are different places',
     both.num === 593 && roomNumOf(593)[0] === 376);
}

console.log('');
console.log('AN INSTANCED ROOM HAS ONE OBJECT ID AND SEVERAL NUMBERS');
{
  ok('both rooms are found', roomNumOf(2125).join(',') === '1006,1016');
  ok('and the ambiguity is reported rather than resolved by insertion order',
     JSON.stringify(roomRef(2125).instances) === '[1006,1016]');
  ok('the refusal offers both', /1006 or 1016/.test(expectRoomNum(2125, 'travel') ?? ''),
     expectRoomNum(2125, 'travel'));
  ok('objIdOf is the other direction', objIdOf(1016) === 2125 && objIdOf(153) === 413);
  ok('and answers null for a room with no id', objIdOf(999999) === null);
}

console.log('');
console.log('THE REPLY SHAPE — a bare `room` is what caused this, so both are named');
{
  const f = roomFields(413);
  ok('room is the ROOM NUMBER', f.room === 153);
  ok('room_object_id is the id', f.room_object_id === 413);
  ok('and the name rides along, which is what a reader checks against', f.room_name === 'Cibilo Creek Inn');
  // Handed a room number it must not swap the fields round.
  const g = roomFields(153);
  ok('given a room number it still reports the room number as `room`', g.room === 153);
  ok('and finds the object id', g.room_object_id === 413);
}

console.log('');
console.log('AND NO NEW SITE MAY PUT AN OBJECT ID IN A FIELD CALLED `room`');
{
  // THE GUARD THAT MAKES IT HARD TO REINTRODUCE. The module and the named fields fix the three
  // sites that were found; this stops a fourth appearing quietly. It scans the source for a
  // REPLY field named `room` (or `room_num`) assigned from an object id — `<x>.room.id`, or the
  // `now.id` idiom the escape used — and fails when there are more than the known ones.
  //
  // COMPARISONS ARE FINE AND ARE NOT MATCHED: `c.room.id !== startRoom` is an id against an id,
  // which is correct and appears dozens of times. The boundary is the REPLY, which is the only
  // place the number leaves the process that knows which space it is in.
  //
  // The count is pinned rather than driven to zero because the remaining sites are in files
  // another session is working in right now, and editing those to make a test green is how a
  // shared checkout gets someone else's work committed under the wrong name. They are named
  // here so the debt is legible instead of forgotten.
  // FOUR, not the three I first wrote down — the scan found one I had missed by reading,
  // which is the whole argument for scanning rather than reading.
  // DRIVEN TO ZERO, 2026-09-10. Operator: "I think we should actually go through and just try to
  // remove anywhere the code reports the objectID that could confuse it with room number, I
  // don't think we ever want an Object ID for a room?" — right, for REPORTS. Comparisons of an
  // id to an id are correct and stay. The four sites this list used to name are fixed:
  //
  //   m59-client.mjs   the raw client has no bake, so it cannot know a room number and no
  //                    longer uses the word: `room_object_id`, and the prose says "room object"
  //   m59-game.mjs     three replies now carry the NUMBER as `room` plus `room_object_id`
  //   m59-merchants.mjs an intermediate called `room` that held an id is now `roomObjId`
  //   m59-autopilot.mjs the Underworld test compared one mixed-space variable against 6
  const KNOWN = [];
  const dir = dirname(fileURLToPath(import.meta.url));
  const hits = [];
  for (const f of readdirSync(dir).filter(f => /^m59-.*\.mjs$/.test(f) &&
                                                !/-test\.mjs$/.test(f) &&
                                                f !== 'm59-roomref.mjs')) {
    const src = readFileSync(join(dir, f), 'utf8').split('\n');
    src.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;               // never match the prose
      if (/\broom(_num)?:\s*[A-Za-z_$][\w$.]*\.room\.id\b/.test(line) ||
          /\broom(_num)?:\s*now\.id\b/.test(line))
        hits.push(`${f}:${i + 1}`);
    });
  }
  ok(`no NEW site reports an object id as a room (${hits.length} known: ${hits.join(', ')})`,
     hits.length <= KNOWN.length, hits.join(', '));
  // And the three that were fixed must stay fixed: the escape's replies go through roomFields.
  const skills = readFileSync(join(dir, 'm59-skills.mjs'), 'utf8');
  const escapes = (skills.match(/roomFields\(now\.id\)/g) ?? []).length;
  ok('all three escapeUnderworld replies name both numbers', escapes === 3, String(escapes));
  ok('and none of them still returns a bare `room: now.id`',
     !/\broom:\s*now\.id\b/.test(skills.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
