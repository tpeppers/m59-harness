#!/usr/bin/env node
// Code-defined room exits can live behind geometry narrower than the square movement
// graph. Offline, no server, safe to run any time:
//
//   node tools/m59-region-exit-test.mjs

import { readFileSync } from 'node:fs';
import { World, boundedRegionEntry } from './m59-world.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The real regression fixture. The server's OutdoorsH7.SomethingMoved sends rows
// 15..17, cols 1..6 to the Icky Cave. The square graph cannot enter that pocket from
// the outdoor floor, but it can reach squares immediately beside it. Those staging
// squares are enough for a short locally BSP-validated fine move.
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const room = map.rooms['587'];
  const c = {
    roomNameRsc: room.nameRsc,
    roomRsc: room.roomRsc,
    room: { id: room.objId, objects: new Map() },
    self: { row: 45, col: 6 },
    rsc: { get: () => '?' },
  };
  const world = new World(c, map);
  const cave = world.exits().find(exit => exit.kind === 'region' && exit.to === 27);
  ok('the Icky Cave code exit is present', !!cave, JSON.stringify(cave));
  ok('the square graph still honestly calls the target unreachable', cave?.reachable === false,
     JSON.stringify(cave));
  ok('an unreachable trigger retains a concrete target', !!cave?.stand_on, JSON.stringify(cave));
  ok('the trigger retains a reachable staging square', !!cave?.approach_on, JSON.stringify(cave));
  ok('region fallback targets are bounded', cave?.trigger_targets?.length > 1 &&
     cave.trigger_targets.length <= 8, JSON.stringify(cave?.trigger_targets));
  ok('every fallback target is inside the server predicate', cave?.trigger_targets?.every(target => {
    const { row, col } = target.stand_on;
    return row < 18 && row > 14 && col < 7;
  }), JSON.stringify(cave?.trigger_targets));
  ok('every fallback starts beside reachable ordinary floor', cave?.trigger_targets?.every(target =>
    target.approach_on && world.reach(target.approach_on.col, target.approach_on.row).reachable),
  JSON.stringify(cave?.trigger_targets));
}

function harness() {
  let seq = 0;
  const events = [], calls = [];
  const emitEntry = roomName => {
    const event = { seq: ++seq, kind: 'room-entered', roomName };
    events.push(event);
    return event;
  };
  return {
    calls, emitEntry,
    sequence: () => seq,
    eventsSince: since => events.filter(event => event.seq > since),
    waitForEntry: async since => events.find(event => event.seq > since && event.kind === 'room-entered') ?? null,
  };
}

// The old broker returned before trying either callback. A coarse refusal now reaches
// the fine fallback and believes the room-entered event emitted during that movement.
{
  const h = harness();
  let askedGo = 0;
  const result = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 3, row: 17 }, approach_on: { col: 3, row: 18 } }],
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: h.waitForEntry,
    walk: async candidate => { h.calls.push(['coarse', candidate.stand_on]);
      return { arrived: false, reason: 'no route in the square graph' }; },
    fineWalk: async candidate => { h.calls.push(['fine', candidate.stand_on]);
      h.emitEntry('A Deep, Dark, Spooky, Icky Cave'); return { arrived: false, left_room: true }; },
    askGo: async () => { askedGo++; },
  });
  ok('a fine movement room transition succeeds', result.entered?.roomName ===
     'A Deep, Dark, Spooky, Icky Cave', JSON.stringify(result));
  ok('fine movement is tried only after ordinary movement', h.calls.map(call => call[0]).join(',') ===
     'coarse,fine', JSON.stringify(h.calls));
  ok('a successful automatic trigger does not send go', askedGo === 0, String(askedGo));
}

// One bad point in a region must not condemn every other point, and every candidate is
// attempted at most once.
{
  const h = harness();
  const candidates = [
    { stand_on: { col: 4, row: 17 }, approach_on: { col: 4, row: 18 } },
    { stand_on: { col: 2, row: 17 }, approach_on: { col: 3, row: 18 } },
  ];
  const result = await boundedRegionEntry({
    candidates,
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: h.waitForEntry,
    walk: async candidate => { h.calls.push(['coarse', candidate.stand_on.col]);
      if (candidate === candidates[1]) h.emitEntry('Icky Cave');
      return candidate === candidates[1] ? { arrived: true } : { arrived: false, reason: 'blocked' }; },
    fineWalk: async candidate => { h.calls.push(['fine', candidate.stand_on.col]);
      return { arrived: false, reason: 'blocked' }; },
    askGo: async () => h.calls.push(['go']),
  });
  ok('a second trigger target can recover the first refusal', result.entered?.roomName === 'Icky Cave',
     JSON.stringify(result));
  ok('the failed target is not repeated', h.calls.map(call => call.join(':')).join(',') ===
     'coarse:4,fine:4,coarse:2', JSON.stringify(h.calls));
}

// Some code-exit catalogue entries are actually doors. Preserve the one bounded `go`
// probe only after movement has reached the nominated square.
{
  const h = harness();
  const result = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 8, row: 9 } }],
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: h.waitForEntry,
    walk: async () => ({ arrived: true }),
    fineWalk: async () => { throw new Error('fine movement should not run after arrival'); },
    askGo: async () => { h.calls.push(['go']); h.emitEntry('Shop'); },
  });
  ok('a reached region retains the door-compatible go probe', result.entered?.roomName === 'Shop' &&
     result.tried[0].asked_go === true, JSON.stringify(result));
  ok('the compatibility go is sent once', h.calls.length === 1, JSON.stringify(h.calls));
}

// If movement says it left but the room-entered event never arrives, stop. Continuing
// with another target would issue coordinates from the old room inside the new one.
{
  const h = harness();
  let secondTried = false;
  const result = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 1, row: 1 } }, { stand_on: { col: 2, row: 2 } }],
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: h.waitForEntry,
    walk: async candidate => {
      if (candidate.stand_on.col === 2) secondTried = true;
      return { arrived: false, left_room: true };
    },
    fineWalk: async () => ({ arrived: false }),
    askGo: async () => {},
  });
  ok('an unconfirmed room transition stops blind movement', result.unconfirmed_transition === true,
     JSON.stringify(result));
  ok('no old-room coordinates are sent after that transition', secondTried === false);
}

// A mover can publish the new room a beat after returning left_room:false. The live room
// identity closes that gap: no fine fallback and no second source-room candidate may run.
{
  const h = harness();
  let current = true;
  const calls = [];
  const result = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 1, row: 1 } }, { stand_on: { col: 2, row: 2 } }],
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: h.waitForEntry,
    stillCurrent: () => current,
    walk: async candidate => {
      calls.push(`coarse:${candidate.stand_on.col}`);
      current = false;
      return { arrived: false, left_room: false };
    },
    fineWalk: async candidate => { calls.push(`fine:${candidate.stand_on.col}`); return { arrived: false }; },
    askGo: async () => { calls.push('go'); },
  });
  ok('a delayed live room change is an unconfirmed transition',
     result.unconfirmed_transition === true, JSON.stringify(result));
  ok('no fine or later candidate coordinates run after that change',
     JSON.stringify(calls) === JSON.stringify(['coarse:1']), JSON.stringify(calls));
}

// Reaching a trigger normally earns one compatibility `go`. If the room changed while its
// entry wait was outstanding, that probe belongs to the old room and must not be sent.
{
  const h = harness();
  let current = true, askedGo = 0;
  const result = await boundedRegionEntry({
    candidates: [{ stand_on: { col: 8, row: 9 } }],
    sequence: h.sequence,
    eventsSince: h.eventsSince,
    waitForEntry: async () => { current = false; return null; },
    stillCurrent: () => current,
    walk: async () => ({ arrived: true, left_room: false }),
    fineWalk: async () => { throw new Error('fine movement should not run after arrival'); },
    askGo: async () => { askedGo++; },
  });
  ok('a room change during the entry wait suppresses the compatibility go',
     result.unconfirmed_transition === true && askedGo === 0,
     JSON.stringify({ result, askedGo }));
}

// The exits() cache: repeated calls from the same origin return the cached result
// (the flood fills are the expensive part and were the cold-start stall); a different
// origin recomputes; and the cached result is correct (matches an uncached compute).
{
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url), 'utf8'));
  const room = map.rooms['587'];
  const makeClient = (row, col) => ({
    roomNameRsc: room.nameRsc,
    roomRsc: room.roomRsc,
    room: { id: room.objId, objects: new Map() },
    self: { row, col },
    rsc: { get: () => '?' },
  });
  const world = new World(makeClient(45, 6), map);
  const first = world.exits();
  ok('exits() returns a result', Array.isArray(first) && first.length > 0, `len=${first?.length}`);
  // Same origin, same world: the second call is the cached object (reference-identical).
  const second = world.exits();
  ok('same origin returns the cached result', second === first);
  // A different origin (the character moved) recomputes: a fresh array, possibly different
  // stand_on squares, but still a valid exits list.
  world.c.self = { row: 20, col: 30 };
  const third = world.exits();
  ok('a different origin recomputes (not the same cached object)', third !== first);
  ok('the recomputed result is still a valid exits list', Array.isArray(third) && third.length > 0);
  // Correctness: the cached result and a fresh compute from the same origin agree.
  world.c.self = { row: 45, col: 6 };
  world._exitCache = null;  // clear to force a fresh compute
  const fresh = world.exits();
  ok('a fresh compute from the same origin matches the cached answer (same exits)',
     JSON.stringify(fresh.map(e => ({ to: e.to, kind: e.kind }))) ===
     JSON.stringify(first.map(e => ({ to: e.to, kind: e.kind }))),
     `fresh=${fresh?.length} cached=${first?.length}`);
  // The cache is bounded: more distinct origins than the cap evict the oldest without error.
  for (let i = 0; i < 30; i++) { world.c.self = { row: (i % 30) + 1, col: (i % 40) + 1 }; world.exits(); }
  ok('the origin cache is bounded (no unbounded growth)', world._exitCache.size <= 24,
     `size=${world._exitCache.size}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
