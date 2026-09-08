#!/usr/bin/env node
// OFFLINE. Opens no socket, touches no roster, moves nobody. Safe any time.
//
//   node tools/m59-ledger-space-test.mjs
//
// A LEDGER FIELD HAS TO MEAN ONE THING, AND NOTHING ELSE IN THIS SUITE ASSERTS THAT.
//
// 2026-09-08: the `looted` emitter shipped writing `room: c.room?.id` — the SERVER'S ROOM
// OBJECT ID — into a field every consumer reads as a MAP NUMBER. The Valley of Ileria is
// object 1386 and room 544. Twenty-five production rows said 1386.
//
// Four hundred and four offline assertions were green throughout, and would have been green
// for every version of that bug, because not one of them asks what a ledger field MEANS.
// Five separate human-shaped checks also passed it:
//
//   * "is the field populated?"            -- it was, with the wrong number
//   * "is the line present in the tree?"   -- it was, and it was wrong
//   * "did the book stop repeating?"       -- the book could not express the difference
//   * "does the file have a convention?"   -- grep hard-coded the receiver
//   * "no, here is the real convention"    -- grep hard-coded the line anchor
//
// So this file exists to make the machine ask the question none of those did. It is a LINT
// over the source rather than a behavioural test, deliberately: the failure is a category
// error at the call site, it is invisible at runtime, and by the time a row is written the
// two spaces look identical -- both are small positive integers.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (what, cond, saw) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${saw === undefined ? '' : ` — ${saw}`}`); }
};

// COMMENTS ARE NOT CODE, and the first run of this proved it needs saying: the failure
// message quoted a sentence out of the comment ABOVE the fixed line, because the scan was
// reading prose that discusses the bug as though it were the bug. A lint that greps its own
// documentation will fail forever once somebody writes down what it looks for.
//
// Blanked rather than deleted, so every line number still matches the real file.
const stripComments = (src) => src.split('\n')
  .map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.replace(/\/\/.*$/, '')))
  .join('\n');

const sources = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'fixtures') walk(p); continue; }
    if (f.endsWith('.mjs') && !f.endsWith('-test.mjs'))
      sources.push([p, stripComments(readFileSync(p, 'utf8'))]);
  }
})(HERE);

console.log(`scanning ${sources.length} source file(s)\n`);

// THE FIRST VERSION OF THIS LINT OVER-CLAIMED, WHICH IS THE SAME SIN IT EXISTS TO CATCH.
// Flagging every `room:` taking a `.id` found thirteen sites and called them all bugs. They
// are not. The client has NO MAP -- object ids are its only room identity, so `room:
// this.room.id` in m59-client.mjs is that file speaking its native space correctly. A GOAP
// debug ring buffer, an in-memory "did we leave the room" comparison, and the kod extractor
// (which stores `objId` and `num` side by side) are all transient or already labelled.
//
// What actually cost something was neither: it was an object id written into a DURABLE
// LEDGER under a field called `room`, twice -- the `looted` emitter and `noteBanker`. A row
// outlives the process, gets compared against other rows, and gets read by somebody who was
// not there. And object ids are renumbered by `save game`, so the column's meaning drifts.
//
// So the hard failure is scoped to durable records, and everything else is an inventory
// pinned by an allowlist: a NEW transient one shows up as an unexplained entry and has to be
// justified in one line, rather than being silently normal.
const DURABLE = /(?:recordEvent|recordSample|recordTactic|noteTransit|\w*book\.record)\s*\(/g;

console.log('a DURABLE ledger field named `room` must never hold an object id');

// RECEIVER- AND FORMATTING-AGNOSTIC ON PURPOSE. The two greps that argued about this bug
// each missed cases the other caught: one hard-coded the receiver (`c.` but not
// `this.client.`), the other anchored on `^\s+room: ` and skipped every inline occurrence.
// A grep is an instrument and its pattern is the hypothesis, so this one is deliberately
// loose about everything except the two things that matter: the field is called exactly
// `room`, and the value ends in `.id`.
const OFFENDER = /\broom:\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\??\.id\b/g;

// `room: { id: ..., name: ... }` is FINE — the id is labelled inside the struct, which is
// the convention working rather than failing. Only a bare `room:` taking an id is the bug.
const LABELLED = /\broom:\s*\{/;

// Transient sites, each with the reason it is not the bug. A site NOT on this list is a
// failure — the point is that adding one costs a sentence of justification.
const TRANSIENT_OK = new Map([
  ['m59-client.mjs', 'the client has no map; object ids are its only room identity'],
  ['m59-keeper-goap.mjs', 'a debug frame ring buffer, 64 deep, never persisted'],
  ['m59-merchants.mjs', 'kod extraction, which stores objId and num side by side'],
  ['m59-skills.mjs', 'in-memory "did we leave the room" comparison, not a record'],
  ['m59-game.mjs', 'drift diagnostic and walk returns; transient, and the ledger writes here are checked below'],
  ['m59-broker.mjs', 'a refusal payload returned to the caller, not written down'],
]);

const durableOffenders = [], transient = [], unexplained = [];
for (const [path, src] of sources) {
  const file = path.slice(HERE.length + 1).replace(/\\/g, '/');
  const base = file.split('/').pop();
  // Every durable-record call, and the argument object that follows it.
  // SPAN TO THE CALL'S ACTUAL CLOSE, NOT A FIXED WINDOW. A 1200-character window missed the
  // very bug this file was written for: the `looted` emitter carries a long comment between
  // `recordEvent(` and its `room:` line, so the field sat outside the window and the durable
  // check passed on code that was wrong. Balance the parens instead — the argument list ends
  // where it ends.
  const durableSpans = [];
  DURABLE.lastIndex = 0;
  for (let m; (m = DURABLE.exec(src));) {
    let depth = 0, end = m.index;
    for (let i = m.index + m[0].length - 1; i < src.length && i < m.index + 20000; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    durableSpans.push([m.index, end]);
  }

  const lines = src.split('\n');
  let offset = 0;
  lines.forEach((line, i) => {
    const at = offset; offset += line.length + 1;
    if (LABELLED.test(line)) return;
    OFFENDER.lastIndex = 0;
    if (!OFFENDER.test(line)) return;
    const row = `${file}:${i + 1}  ${line.trim().slice(0, 74)}`;
    if (durableSpans.some(([a, b]) => at >= a && at <= b)) durableOffenders.push(row);
    else if (TRANSIENT_OK.has(base)) transient.push(row);
    else unexplained.push(row);
  });
}

ok('no DURABLE record writes `room:` from a `.id`', durableOffenders.length === 0,
   durableOffenders.length ? `\n      ${durableOffenders.join('\n      ')}` : undefined);
ok('every transient site is one we have justified', unexplained.length === 0,
   unexplained.length
     ? `\n      new site(s) with no entry in TRANSIENT_OK — add one with a reason, or fix it:\n      ${unexplained.join('\n      ')}`
     : undefined);
console.log(`  --   ${transient.length} transient site(s), all accounted for`);

console.log('\nthe two spaces are named apart where both are carried');
const game = sources.find(([p]) => p.endsWith('m59-game.mjs'))?.[1] ?? '';
ok('confirmPosition still returns room_id AND room_num side by side',
   /room_id:\s*c\.room\?\.id/.test(game) && /room_num:\s*Number\(this\.world\?\.room\?\.num/.test(game),
   'the one call site that had both values and refused to choose — the convention, written out');

console.log('\nthe `looted` emitter, specifically');
const looted = game.match(/recordEvent\([^,]+,\s*'looted',\s*\{[\s\S]{0,2000}?\n\s*\}\);/);
ok('the emitter is still there', !!looted);
if (looted) {
  ok('...and takes its room from the MAP, not from the client object',
     /room:\s*this\.world\?\.room\?\.num/.test(looted[0]),
     looted[0].match(/room:.*/)?.[0]);
  ok('...and does not reach for c.room at all',
     !/room:\s*c\.room/.test(looted[0]));
}

// A number is not a room. If the bake is here, the value has to resolve in it — this is the
// check that turns "populated" into "correct", and it is the one that was missing.
console.log('\na room number has to exist in the bake');
let map = null;
try { map = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-map.json'), 'utf8')); } catch { /* optional */ }
if (!map?.rooms) {
  console.log('  --   no baked map here; skipping (this check needs substrate/m59-map.json)');
} else {
  const rooms = map.rooms;
  ok('room 544 is Valley of Ileria', (rooms['544']?.name ?? '').includes('Valley of Ileria'),
     rooms['544']?.name);
  // The exact pair that caused this. 1386 is object id, 544 is map number; if a future
  // change ever makes them the same thing, this test should be revisited rather than deleted.
  ok('...and 1386 is its OBJECT id, not a room number',
     Number(rooms['544']?.objId) === 1386 && !rooms['1386'],
     `objId=${rooms['544']?.objId}, rooms['1386']=${rooms['1386'] ? 'exists' : 'absent'}`);
  ok('the two spaces are genuinely disjoint here — an object id is not a valid room key',
     !rooms[String(rooms['544']?.objId ?? '')]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
