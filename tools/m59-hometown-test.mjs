#!/usr/bin/env node
// WHERE A CHARACTER IS FROM — the nine sentences, offline. No socket, no roster, no broker.
//
// This matters more than a string table usually would: the home room is where `rescue` puts a
// character by default (rescue.kod:114-167), so getting it wrong sends somebody to plan a
// journey around a teleport that lands somewhere else. Every phrase here is copied from
// player.kod:270-278 and every room id from blakston.khd.
import assert from 'node:assert/strict';
import { HOMETOWNS, hometownFrom } from './m59-describe.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; console.log('  ok  ' + what); };

console.log('\nthe nine sentences, as the server actually assembles them');

// THE LIVE SHAPE. The resource is a fragment; the server prepends the pronoun and appends a
// tenure clause, so nothing may match on the whole string. This is the exact text read off
// prod for Loial on 2026-09-12.
ok('the real reply parses to a town and a room', () => {
  const got = hometownFrom('He has been a Barloquan less than a year.\r\n' +
                           'This soul is new to the lands of Meridian 59.');
  assert.deepEqual(got, { town: 'Barloque', room: 106, said: 'Barloquan' });
});

// EVERY ONE IS WORDED DIFFERENTLY, which is the whole reason this is a table. There is no
// shared "resident of"-style phrase to regex against — searching the kod for one finds nothing.
ok('all eight named towns map to their inn room', () => {
  const cases = [
    ['He has been a Barloquan for a year.', 'Barloque', 106],
    ['She has been a citizen of Tos for two years.', 'Tos', 52],
    ['He hailed from Cor Noth for six years.', 'Cor Noth', 153],
    ['She has called Jasper home for eight years.', 'Jasper', 370],
    ['He has been a Marionite for three years.', 'Marion', 202],
    ['She is of Raza less than a year.', 'Raza', 1011],
    ['He is of Hazar less than a year.', 'Hazar', 1001],
    ["She has lived in Ko'catan for four years.", "Ko'catan", 2001],
  ];
  for (const [text, town, room] of cases) {
    const got = hometownFrom(text);
    assert.ok(got, `no match for ${town}`);
    assert.equal(got.town, town);
    assert.equal(got.room, room, `${town} room`);
  }
});

// "has wandered" is the SERVER's fallback for a home room it does not recognise. It is an
// answer, and it must not be confused with our own failure to parse one.
ok('"has wandered" is a town of null, not a parse failure', () => {
  const got = hometownFrom('He has wandered for years.');
  assert.deepEqual(got, { town: null, room: null, said: 'has wandered' });
});

// UNKNOWN MUST NOT READ AS WANDERING. A DM has no residency line at all, and a look that never
// came back has no text — both are "we do not know", which is a different fact from the server
// telling us it does not recognise the room.
ok('no residency line at all is null, which is not the same answer', () => {
  assert.equal(hometownFrom('This soul is new to the lands of Meridian 59.'), null);
  assert.equal(hometownFrom(''), null);
  assert.equal(hometownFrom(null), null);
  assert.equal(hometownFrom(undefined), null);
});

console.log('\nthe table itself');

ok('every named town carries a room and they are all distinct', () => {
  const named = HOMETOWNS.filter(h => h.town !== null);
  assert.equal(named.length, 8);
  for (const h of named) assert.ok(Number.isFinite(h.room), `${h.town} has no room`);
  assert.equal(new Set(named.map(h => h.room)).size, 8, 'two towns share a room');
});

// Tos is 52 and Barloque is 106 — both rooms this fleet actually stations characters in, so a
// transposition here would be invisible in prose and wrong in every journey plan.
ok('the two rooms the fleet uses are not transposed', () => {
  assert.equal(HOMETOWNS.find(h => h.town === 'Tos').room, 52);
  assert.equal(HOMETOWNS.find(h => h.town === 'Barloque').room, 106);
});

// The random assignment on leaving Raza can only produce three of these (user.kod:7001-7023),
// so anything else was set deliberately at the Hall of Genealogy. Worth pinning: it is the
// reason a Barloque hometown is evidence of an operator decision rather than luck.
ok('the three rooms SetRandomHomeroom can produce are all in the table', () => {
  for (const room of [202 /* Marion */, 370 /* Jasper */, 153 /* Cor Noth */])
    assert.ok(HOMETOWNS.some(h => h.room === room), `random target ${room} missing`);
});

console.log(`\n${n} assertions, all offline.\n`);
