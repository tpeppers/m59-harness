#!/usr/bin/env node
// THE GUARD ON THE INSTRUMENT THAT NAMES A WEDGE. Offline: no socket, no roster, no fleet.
//
// This test exists because on 2026-09-20 the prod broker wedged three times, three sessions
// read the same `loop_lag_ms` histogram, and three incompatible causes were proposed — a
// memory leak, a synchronous roster write storm, and GC thrash. All three were wrong, and
// nothing in the process could say so. `startLoopStallMonitor` is the answer to that, and an
// instrument nobody has watched fail is not an instrument.
//
// SO THE CENTRAL ASSERTION IS THE ONE THAT IS EASY TO SKIP: block the loop inside a function
// with a name of our own choosing, and require that the report NAMES IT. A monitor that
// reports "the loop was blocked" and nothing else would pass every other check here and
// would have been useless on the day it was written for.
//
// It really does block this process for about a second, several times — that is the only way
// to test it — so it takes a few seconds and cannot be made instant.

import { startLoopStallMonitor } from './runtime/loop-stalls.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// A distinctive name, because the point of the test is that this name comes back.
function theCulpritNobodyCouldName(ms) {
  const until = Date.now() + ms;
  let n = 0;
  while (Date.now() < until) n += Math.sqrt(n + 1);     // busy, not sleeping: a real block
  return n;
}

const settle = ms => new Promise(r => setTimeout(r, ms));

console.log('a blocked loop names the frame that blocked it');
{
  const lines = [];
  const mon = await startLoopStallMonitor({
    label: 'test', everyMs: 100, reportOverMs: 300,
    context: () => ({ sessions: 7 }), log: m => lines.push(m),
  });
  await settle(200);
  theCulpritNobodyCouldName(1200);
  // The profiler's own round trip is async ON PURPOSE — it must not extend the stall — so
  // the row lands a beat after the loop comes back. That is the contract, not a race.
  await settle(1200);
  const rows = mon.stalls();
  mon.stop();

  ok('the stall was reported at all', rows.length >= 1, JSON.stringify(rows));
  const worst = rows.sort((a, b) => b.blocked_ms - a.blocked_ms)[0] ?? {};
  ok('and its length is the length of the block, not the tick',
     worst.blocked_ms >= 900, `blocked_ms=${worst.blocked_ms}`);
  ok('the row carries a wall clock', typeof worst.at === 'string' && !Number.isNaN(Date.parse(worst.at ?? '')));

  // THE ONE THAT MATTERS.
  ok('the culprit is NAMED in hot', typeof worst.hot === 'string' &&
     worst.hot.includes('theCulpritNobodyCouldName'), String(worst.hot).slice(0, 160));
  // `callers:` is the half that survives a node-internal leaf: a stall inside readFileSync
  // is not a finding, readFileSync under a name of ours is.
  ok('and attributed to one of our own files',
     typeof worst.hot === 'string' && /callers:.*m59-loopstall-test\.mjs/.test(worst.hot),
     String(worst.hot).slice(0, 200));

  ok('context() is merged into the row', worst.sessions === 7);
  ok('and the log line carries the same facts', lines.length >= 1 &&
     /blocked ~\d+ms/.test(lines[0]) && lines[0].includes('theCulpritNobodyCouldName'),
     lines[0]?.slice(0, 160));
}

console.log('');
console.log('a quiet loop reports nothing, and a stall below the threshold is not a stall');
{
  const mon = await startLoopStallMonitor({ label: 'test', everyMs: 100, reportOverMs: 1500,
                                            log: () => {} });
  await settle(300);
  theCulpritNobodyCouldName(400);            // real, but under the threshold
  await settle(700);
  const rows = mon.stalls();
  mon.stop();
  // "Nothing blocked this loop" and "nobody was watching" have to look different, and the
  // difference is an empty array rather than a missing one.
  ok('no row for a short block', rows.length === 0, JSON.stringify(rows));
  ok('and the answer is an empty list, not null', Array.isArray(rows));
}

console.log('');
console.log('the instrument degrades instead of failing');
{
  // WITHOUT THE PROFILER THE REPORT STILL HAPPENS. A build with no inspector, or
  // M59_BROKER_PROFILE=0, must still say the loop stopped — losing the attribution is a
  // smaller loss than losing the stall, and conflating them is how this went unseen.
  const mon = await startLoopStallMonitor({ label: 'test', everyMs: 100, reportOverMs: 300,
                                            profile: false, log: () => {} });
  await settle(200);
  theCulpritNobodyCouldName(800);
  await settle(400);
  const rows = mon.stalls();
  mon.stop();
  ok('a stall is still reported with the profiler off', rows.length >= 1);
  ok('and hot is null rather than absent or invented',
     rows.length >= 1 && rows[0].hot === null, JSON.stringify(rows[0]));
}

console.log('');
console.log('a context() that throws loses the context, never the stall');
{
  const mon = await startLoopStallMonitor({
    label: 'test', everyMs: 100, reportOverMs: 300, profile: false,
    context: () => { throw new Error('a session map that was not ready yet'); }, log: () => {} });
  await settle(200);
  theCulpritNobodyCouldName(800);
  await settle(400);
  const rows = mon.stalls();
  mon.stop();
  ok('the stall survives a throwing context', rows.length >= 1);
  ok('and the row is still well formed',
     rows.length >= 1 && typeof rows[0].blocked_ms === 'number' && rows[0].hot === null);
}

console.log('');
console.log('the ring buffer is bounded, and stop() stops');
{
  const mon = await startLoopStallMonitor({ label: 'test', everyMs: 60, reportOverMs: 150,
                                            keep: 2, profile: false, log: () => {} });
  for (let i = 0; i < 4; i++) { theCulpritNobodyCouldName(250); await settle(120); }
  const rows = mon.stalls();
  ok('kept at most `keep` rows', rows.length <= 2, `${rows.length} rows`);
  ok('and the ones kept are the LATEST', rows.length === 0 ||
     Date.parse(rows[rows.length - 1].at) >= Date.parse(rows[0].at));

  // A returned array that is the live buffer lets a caller mutate the evidence.
  const copy = mon.stalls();
  copy.push({ at: 'forged', blocked_ms: 99999 });
  ok('stalls() hands out a copy, not the buffer', mon.stalls().length === rows.length);

  mon.stop();
  const after = mon.stalls().length;
  theCulpritNobodyCouldName(400);
  await settle(300);
  ok('nothing is recorded after stop()', mon.stalls().length === after);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
