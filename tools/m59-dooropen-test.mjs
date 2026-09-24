#!/usr/bin/env node
// OPENING A DOOR THE ROOM WILL OPEN FOR US — offline, no fleet, no kod.
//
//   node tools/m59-dooropen-test.mjs
//
// The mechanics here were worked out on a live fleet in m59-guild-passage.mjs and each one is
// a five-second window somebody lost: the press is a `go` from the square the body is ON, the
// wait is the SERVER's `sector-height` event and never a duration, the settle is capped below
// the door's own close timer, and a retry waits the cycle out because a second `go` does not
// restart it. A generic executor that quietly dropped any one of them would look like it
// worked and strand the next character.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitForDoorOpen, refusedToGo } from './m59-door-wait.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};

// EXTRACTED BY NAME, AND THE EXTRACTION IS CHECKED. m59-innerdoor-crossing-test.mjs did this
// against a file the method had moved out of: `indexOf` returned -1, `slice(-1,-1)` returned
// '', and it built a class with no methods — passing its own import and failing only when a
// case called the thing. A test that slices source cannot tell "this changed" from "this is
// not here" unless it asks.
const source = readFileSync(new URL('./m59-session-walk.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async openOperableDoor(');
const end = source.indexOf('\n  // WHICH INTERNAL DOOR', start);
assert.ok(start >= 0, 'openOperableDoor is not in m59-session-walk.mjs — this test is stale');
assert.ok(end > start, 'the end marker after openOperableDoor moved — this test is stale');
const body = source.slice(start, end);
assert.ok(/waitForDoorOpen/.test(body), 'the extracted body is not the door opener');

const DOORS = {
  rooms: { 714: { name: 'hall', rows: 40, cols: 40, doors: [
    { sector: 59, sector_name: 'MAIN_DOOR', kind: 'ceiling', open: 190, closed: 100,
      delay_ms: 5000, gate: 'ReqLegalEntry',
      when: [{ axis: 'row', op: '==', value: 4 }, { axis: 'col', op: '==', value: 28 }] },
    { sector: 55, sector_name: 'HALL_DOOR', kind: 'ceiling', open: 230, closed: 160,
      delay_ms: 5000, gate: null,
      when: [{ axis: 'row', op: '==', value: 18 }, { axis: 'col', op: '==', value: 10 }] },
  ] } },
};
const { doorsFor } = await import('./m59-doorplan.mjs');
const scopedDoorsFor = (room, at) => doorsFor(room, at, { table: DOORS });

let clock = 0;
const sleep = async ms => { clock += ms; };
const Session = new Function('doorsFor', 'setTimeout', 'Date', 'waitForDoorOpen', 'refusedToGo',
  `return class { ${body} }`)(scopedDoorsFor, (fn, ms) => { clock += ms; fn(); },
    { now: () => clock }, (c, p, opts) => waitForDoorOpen(c, p, { ...opts, now: () => clock, sleep }),
    refusedToGo);

/** A body in room 714, with every live thing the opener touches and nothing else. */
function body714({ at = { row: 4, col: 28 }, sectorMoves = true, cancel = false,
                   invalidatedFor = 0 } = {}) {
  const s = new Session();
  const seen = { go: 0, walks: [], waited: 0 };
  let pos = { ...at };
  s.movementGeneration = 1;
  s.world = { room: { num: 714 } };
  s.movementWasCancelled = () => cancel;
  s.pacer = { submit: async (_k, fn) => fn() };
  s.confirmPosition = async () => ({ ...pos });
  s.walkTo = async (col, row) => { seen.walks.push({ row, col }); pos = { row, col }; return { arrived: true }; };
  s.need = () => ({
    get self() { return pos; },
    evSeq: 0,
    room: { id: 2572, collisionInvalidated: { until: clock + invalidatedFor } },
    go: async () => { seen.go++; },
    waitFor: async ({ timeoutMs }) => { seen.waited++;
      if (!sectorMoves) { clock += timeoutMs; return { events: [], timedOut: true }; }
      const sector = pos.row === 18 ? 55 : 59;
      return { events: [{ sector, height: sector === 55 ? 230 : 190, speed: 50, at: clock }] };
    },
  });
  return { s, seen, where: () => pos };
}

console.log('\nstanding on the trigger already');
{
  const b = body714();
  const r = await b.s.openOperableDoor();
  ok('the door opens', r.opened === true, JSON.stringify(r));
  ok('and it names the sector that moved', r.sector === 59);
  // The body was already on r4c28; walking anywhere would be a wasted second of a five-second
  // window, and could step it OFF the trigger it was standing on.
  ok('it does not walk anywhere first', b.seen.walks.length === 0, JSON.stringify(b.seen.walks));
  ok('it presses exactly once', b.seen.go === 1, String(b.seen.go));
  ok('and it waited on the server rather than a timer', b.seen.waited === 1);
  ok('the reason says the geometry changed, which is what the caller acts on',
     /live geometry has changed/.test(r.reason), r.reason);
}

console.log('\nstanding somewhere else in the room');
{
  const b = body714({ at: { row: 18, col: 12 } });
  const r = await b.s.openOperableDoor();
  ok('it walks to a trigger first', b.seen.walks.length === 1, JSON.stringify(b.seen.walks));
  // Chebyshev from r18c12: HALL_DOOR's r18c10 is 2 away, MAIN_DOOR's r4c28 is 16.
  ok('and picks the NEAREST one rather than the first in the table',
     b.seen.walks[0].row === 18 && b.seen.walks[0].col === 10, JSON.stringify(b.seen.walks[0]));
  ok('then opens that door', r.opened === true && r.sector === 55, JSON.stringify(r));
}

console.log('\na press that moves nothing');
{
  // A GATED DOOR ANSWERS WITH SILENCE. Three attempts is three five-second cycles spent on a
  // refusal this character will never pass, so it stops after one and says which gate.
  const gated = body714({ sectorMoves: false });
  const r = await gated.s.openOperableDoor();
  ok('a gated door is abandoned after ONE press', gated.seen.go === 1, String(gated.seen.go));
  ok('and the reason names the gate rather than blaming the door',
     r.opened === false && /ReqLegalEntry/.test(r.reason), r.reason);
  ok('and carries it as a field a caller can branch on', r.gate === 'ReqLegalEntry');

  // An UNGATED door that does not answer may simply have been mid-cycle, so it is retried.
  const ungated = body714({ at: { row: 18, col: 10 }, sectorMoves: false });
  const r2 = await ungated.s.openOperableDoor();
  ok('an ungated door is pressed three times before giving up',
     ungated.seen.go === 3, String(ungated.seen.go));
  ok('and says so plainly', r2.opened === false && /three times/.test(r2.reason), r2.reason);
}

console.log('\nthe settle is capped below the door\'s own window');
{
  // A generic collision invalidation can run to eight seconds. The door shuts five seconds
  // after the PRESS, so waiting that out would miss the window every time.
  const b = body714({ invalidatedFor: 60_000 });
  const began = Date.now();
  const r = await b.s.openOperableDoor();
  const took = Date.now() - began;
  ok('it opens', r.opened === true);
  ok('and does not wait out a 60s invalidation', took < 4000, took + 'ms');
  ok('it reports the window the caller is racing', r.shuts_after_ms === 5000);
}

console.log('\nthe refusals that must stay refusals');
{
  const cancelled = body714({ cancel: true });
  const r = await cancelled.s.openOperableDoor();
  ok('a cancelled movement opens nothing', r.opened === false && /cancelled/.test(r.reason));
  ok('and presses nothing', cancelled.seen.go === 0);

  const elsewhere = new Session();
  elsewhere.world = { room: { num: 39 } };
  elsewhere.need = () => ({ self: { row: 1, col: 1 }, evSeq: 0, go: async () => {}, waitFor: async () => {} });
  elsewhere.movementWasCancelled = () => false;
  const r2 = await elsewhere.openOperableDoor();
  ok('a room with no operable door says exactly that',
     r2.opened === false && /no door anybody can operate/.test(r2.reason), r2.reason);

  const roomless = new Session();
  roomless.need = () => ({ self: {}, evSeq: 0 });
  roomless.world = {};
  roomless.movementWasCancelled = () => false;
  ok('and an unknown room is a question, not a door',
     (await roomless.openOperableDoor()).reason === 'room unknown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
