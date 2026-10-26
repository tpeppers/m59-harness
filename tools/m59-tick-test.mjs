#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// THE REAL-TIME CONTRACT — offline tests for m59-tick.mjs.
//
//   node tools/m59-tick-test.mjs
//
// Every one of these pins a rule that is easy to undo by accident, and each undoing
// puts the fleet back in the model this replaced: a blocking script whose sense rate is
// decided by how long its last action took.
import { Sensor, Actuator, TickLoop } from './m59-tick.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A session whose pacer records what was submitted and resolves LATE, so a caller that
// awaits it would visibly stall. That lateness is the instrument: it is how these tests
// can tell "sent" from "waited for".
function fakeSession({ sendDelayMs = 200, live = true } = {}) {
  const submitted = [];
  const me = { col: 5, row: 5, x: 352, y: 352, predicted: false };
  const client = {
    state: 'game', selfId: 1, evSeq: 0,
    me: { name: 'Tester' },
    room: { id: 7, num: 7, objects: new Map([[1, me]]) },
    self: me,
    vitals: () => ({ health: { value: 20, max: 20 }, vigor: { value: 80 } }),
    inventory: [{ id: 4, name: 'bread' }],
    equipment: () => ({ known: true, equipped: [] }),
    moveToSquare: (c, r) => { me.col = c; me.row = r; },
    face: () => {}, go: () => {}, attack: () => {}, use: () => {}, unuse: () => {},
    get: () => {}, drop: () => {}, apply: () => {}, cast: () => {},
    buy: () => {}, offer: () => {}, acceptOffer: () => {},
    requestInventory: () => {}, roomContents: () => {},
  };
  return {
    name: 't1', live, client, submitted, me,
    pacer: {
      depth: 0,
      submit(kind, fn, gap = 0) {
        submitted.push({ kind, gap, at: Date.now() });
        return new Promise(res => setTimeout(() => res(fn()), sendDelayMs));
      },
    },
  };
}

console.log('the sensor is free and sends nothing');
{
  const s = fakeSession();
  const sensor = new Sensor(s);
  const t0 = Date.now();
  const f = sensor.read();
  ok('a frame is synchronous — not a promise', typeof f.then !== 'function');
  ok('and immediate', Date.now() - t0 < 5);
  ok('it put nothing on the wire', s.submitted.length === 0,
     'a sensor that sends is a request, and a request is what this model removes');
  ok('it carries the pushed position', f.position.col === 5 && f.position.row === 5);
  ok('and says whether that position is the server\'s word or our guess',
     f.position.predicted === false);
  ok('vitals come straight off the pushed state', f.vitals.health.value === 20);

  const dead = new Sensor(fakeSession({ live: false }));
  ok('not in game reads as not in game, rather than throwing', dead.read().in_game === false);
}

console.log('\nthe actuator fires and forgets');
{
  const s = fakeSession({ sendDelayMs: 300 });
  const a = new Actuator(s);
  const t0 = Date.now();
  const rec = a.step(6, 5);
  const elapsed = Date.now() - t0;
  ok('sending a step returns immediately', elapsed < 5, `${elapsed}ms`);
  ok('even though the pacer will take 300ms to get to it', s.submitted.length === 1);
  ok('what comes back is a record of what was SENT, not what happened',
     rec.kind === 'move' && rec.ok === null,
     'rule 3: whether it worked is answered by the next frame, not by a return value');
  await sleep(350);
  ok('and the record is filled in later, for the log only', rec.ok === true);
}

console.log('\nrequests are commands, not questions');
{
  const s = fakeSession();
  const a = new Actuator(s);
  const t0 = Date.now();
  a.requestInventory();
  a.requestRoom();
  ok('asking the server for something does not block either', Date.now() - t0 < 5);
  ok('both went out', s.submitted.filter(x => x.kind === 'read').length === 2,
     'the reply arrives as pushed state and a later tick reads it');
}

console.log('\nthe per-kind pacing the server needs is preserved');
{
  const s = fakeSession();
  const a = new Actuator(s);
  a.step(6, 5); a.swing(9); a.cast(3, []);
  const gaps = Object.fromEntries(s.submitted.map(x => [x.kind, x.gap]));
  ok('a move carries the move interval', gaps.move === 250);
  // The swing bypasses the pacer entirely (direct c.attack call). No 'attack'
  // entry in the pacer's submitted list. The CombatController paces at SWING_MS.
  ok('a swing bypasses the pacer (not in submitted list)', gaps.attack === undefined);
  ok('a cast uses the pacer with 1050ms gap', gaps.cast === 1050);
}

console.log('\nthe loop ticks at a fixed rate regardless of the server');
{
  const s = fakeSession({ sendDelayMs: 500 });   // every command is slow
  let ticks = 0;
  const loop = new TickLoop({ session: s, hz: 50,
    decide: (frame, act) => { ticks++; act.step(frame.position.col + 1, frame.position.row); } });
  loop.start();
  await sleep(260);
  loop.stop();
  ok('it ticked many times while commands were still in flight', ticks > 5, `${ticks} ticks`);
  ok('which is the whole point: latency changes when a command lands, never how often we look',
     s.submitted.length === ticks);
}

console.log('\na slow decide SKIPS rather than queueing');
{
  const s = fakeSession();
  let entered = 0;
  const loop = new TickLoop({ session: s, hz: 100, decide: () => {
    entered++;
    const until = Date.now() + 60;            // overrun several intervals
    while (Date.now() < until) { /* spin */ }
  } });
  loop.start();
  await sleep(250);
  loop.stop();
  // A SYNCHRONOUS decide cannot be re-entered: it blocks the event loop, so the timer
  // physically cannot fire again underneath it and `skipped` stays 0. Overrun shows up
  // as COALESCED ticks instead -- node drops the fires it missed. That is the property
  // worth pinning, and it is the same guarantee by a different mechanism: at 100hz over
  // 250ms with a 60ms decide, a backlog would be ~25 ticks and no backlog is ~4.
  ok('overrunning ticks do not accumulate a backlog', entered <= 6,
     `${entered} ticks in 250ms — a backlog would be ~25`);
  ok('and the loop kept its own count honestly', loop.stats.ticks === entered);
  // The `busy` guard is still the belt: it is what stops re-entry if a decide ever
  // yields, which is exactly the case rule 1 forbids and this cannot rely on nobody
  // doing.
  ok('the re-entry guard exists for the case rule 1 forbids', loop.busy === false);
  ok('the longest decide is recorded', loop.stats.longest_decide_ms >= 55);
}

console.log('\nA TICK MUST NOT AWAIT — enforced, not trusted');
{
  const s = fakeSession();
  const loop = new TickLoop({ session: s, hz: 100, decide: async () => { await sleep(5); } });
  loop.start();
  await sleep(60);
  loop.stop();
  ok('an async decide is reported rather than silently awaited', loop.stats.awaited > 0);
  ok('and named, so it is fixable', /must not await/.test(loop.stats.lastError ?? ''),
     'awaiting it here would restore the blocking loop while every counter still said "tick"');
}

console.log('\na throwing decide does not kill the loop');
{
  const s = fakeSession();
  let seen = 0;
  const loop = new TickLoop({ session: s, hz: 100, onError: () => { seen++; },
                              decide: () => { throw new Error('bad decision'); } });
  loop.start();
  await sleep(80);
  loop.stop();
  ok('the timer survived', loop.stats.ticks > 2);
  ok('the error was counted and reported', loop.stats.errors > 2 && seen > 2);
  ok('and the last one is readable', /bad decision/.test(loop.stats.lastError ?? ''),
     'a guard that dies silently is worse than no guard');
}

console.log('\nthe legacy driver is untouched');
{
  const src = await import('node:fs').then(fs =>
    readToolSource(new URL('./m59-tick.mjs', import.meta.url), 'utf8'));
  // The prose discusses the old model at length; what matters is that nothing IMPORTS
  // it. Testing for the string alone would forbid explaining what this replaced.
  ok('nothing here imports the autopilot',
     !/^\s*import[^\n]*m59-autopilot/m.test(src),
     'this is a second driver alongside the first, not a change to it');
  ok('and nothing here reaches for a keeper', !/\bkeeper\./.test(src));
}

console.log('\nthe liveness guard flags a ghost (no server data while in game)');
{
  const session = fakeSession();
  // A live session has recent data; a ghost does not.
  session.client.lastRxAt = Date.now();
  let deadCalled = null;
  const loop = new TickLoop({
    session, hz: 50,
    decide: () => {},
    onSessionDead: (info) => { deadCalled = info; },
  });
  // Simulate: in game, but no server data for 60s (a ghost).
  session.client.lastRxAt = Date.now() - 60000;
  loop.tick();  // should flag dead, not decide
  ok('onSessionDead was called', deadCalled != null, JSON.stringify(deadCalled));
  ok('it reports how stale', deadCalled && deadCalled.staleMs > 45000, JSON.stringify(deadCalled));
  // A fresh session does NOT flag.
  deadCalled = null;
  session.client.lastRxAt = Date.now();
  loop._livenessFlagged = false;
  loop.tick();
  ok('a live session is not flagged', deadCalled == null, JSON.stringify(deadCalled));
  // No data ever seen (lastRxAt=0) is NOT flagged (can't tell fresh from dead).
  deadCalled = null;
  session.client.lastRxAt = 0;
  loop._livenessFlagged = false;
  loop.tick();
  ok('no-data-yet is not flagged', deadCalled == null, JSON.stringify(deadCalled));
  loop.stop();
}

console.log('\nposition recovery fires even when the self id is lost');
{
  // The recovery gate was `frame.selfId != null && !frame.position` — it only recovered
  // the "have the id, lost the position" case. A character can lose BOTH the id and the
  // position (a room transition that resets the self reference), and then the guard
  // never fired and the character sat positionless forever. Now it recovers whenever we
  // are in-game with a room but no position, whether or not the self id survived.
  let roomCalls = 0;
  const session = fakeSession();
  session.client.roomContents = () => { roomCalls++; };
  // In-game, has a room, but NO position and NO self id (full self loss).
  session.client.self = null;
  session.client.selfId = null;
  session.client.lastRxAt = Date.now();
  const loop = new TickLoop({ session, hz: 50, decide: () => {} });
  loop._lastPosRecovery = 0;
  loop.tick();
  ok('roomContents re-requested when the self id is lost', roomCalls >= 1, `calls=${roomCalls}`);
  // A position-less frame with NO room at all (not yet in a room) does not spam recovery.
  roomCalls = 0;
  session.client.room = { id: null, num: null, objects: new Map() };
  loop._lastPosRecovery = 0;
  loop.tick();
  ok('no recovery when there is no room', roomCalls === 0, `calls=${roomCalls}`);
  loop.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
