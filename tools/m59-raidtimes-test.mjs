#!/usr/bin/env node
// Offline tests for m59-raidtimes.mjs — percentiles, block reduction, the log fallback.
import { pct, keyOf, reduceSteps, stepsFromLog } from './m59-raidtimes.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

ok(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50) === 5 && pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9, 'nearest-rank p50/p90');
ok(pct([], 50) === null, 'no samples, no percentile');
ok(keyOf({ label: 'arm.survey', do: 'verify' }) === 'arm.survey', 'a label is the key');
ok(keyOf({ do: 'walk', to: 2 }) === 'walk:2', 'an unlabelled walk is keyed by its room');

const rows = [
  { agent: 'a', label: 'arm.pool', t0: 0, ms: 10_000, ok: true },
  { agent: 'b', label: 'arm.pool', t0: 1_000, ms: 60_000, ok: true },
  { agent: 'c', label: 'arm.pool', t0: 2_000, ms: 20_000, ok: false, dead: true },
  { agent: 'a', do: 'walk', to: 2, t0: -5_000, ms: 5_000, ok: true },
];
const { blocks, order } = reduceSteps(rows);
ok(blocks['arm.pool'].n === 3 && blocks['arm.pool'].p50 === 20_000 && blocks['arm.pool'].p90 === 60_000, 'per-agent percentiles');
ok(blocks['arm.pool'].wall === 61_000, 'wall time is first start to LAST end — the barrier waits for the slowest');
ok(blocks['arm.pool'].failed === 1 && blocks['arm.pool'].dead === 1, 'failures and deaths are counted per block');
ok(order[0] === 'walk:2', 'blocks are ordered by when they began');

const log = ['17:38:41 shadow08 walking 38 -> 2, budget 600s', '17:38:51 shadow08 step 0 (walk) ok',
             '17:44:45 shadow08 step 1 (verify) ok', '17:44:46 shadow09 step 0 (walk) ok'].join('\n');
const lr = stepsFromLog(log, { day: '2026-09-25' });
ok(lr.length === 3 && lr[1].ms === (5 * 60 + 54) * 1000 && lr[1].label === 'log#1:verify', 'the log fallback times a step from the previous line of the same agent');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
