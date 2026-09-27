#!/usr/bin/env node
// OFFLINE. The training ledger's aggregate (summarizeTraining) and its improve detection — no broker,
// no socket, no roster. These are the numbers an operator compares runs by, so each case below is a
// way the report could read plausibly and be wrong.
import { summarizeTraining, improvesBetween } from './m59-training-ledger.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const T = 1_000_000;
const code = { tool: 'fleetscripts/disciple-drill.mjs', git_sha: 'abc1234', dirty: false, file_sha1: 'f00d' };
const ev = [
  { t: T, run: 'r1', kind: 'run_start', code, snapshot: { abilities: { 'holy symbol': 10, 'detect evil': 10 } } },
  { t: T + 10_000, run: 'r1', kind: 'cast', spell: 'holy symbol', school: "Shal'ille", outcome: 'success' },
  { t: T + 20_000, run: 'r1', kind: 'cast', spell: 'holy symbol', school: "Shal'ille", outcome: 'fizzle' },
  { t: T + 30_000, run: 'r1', kind: 'cast', spell: 'detect evil', school: "Shal'ille", outcome: 'refused' },
  { t: T + 40_000, run: 'r1', kind: 'improve', spell: 'holy symbol', from: 10, to: 11 },
  { t: T + 50_000, run: 'r1', kind: 'restock', item: 'elderberry', qty: 50, source: 'bought', cost: 1400 },
  { t: T + 51_000, run: 'r1', kind: 'restock', item: 'inky-cap mushroom', qty: 30, source: 'chest' },
  { t: T + 60_000, run: 'r1', kind: 'run_end', rooms_travelled: 4, snapshot: { abilities: { 'holy symbol': 11, 'detect evil': 10 } } },
  // An hour of NOTHING between the runs — idle, not practice.
  { t: T + 3_660_000, run: 'r2', kind: 'run_start', code: { ...code, git_sha: 'def5678' } },
  { t: T + 3_690_000, run: 'r2', kind: 'restock', item: 'fairy wing', qty: 23, source: 'bought', cost: null },
  { t: T + 3_720_000, run: 'r2', kind: 'cast', spell: 'minor heal', school: "Shal'ille", outcome: 'success' },
  // r2 never wrote run_end (killed): its duration runs to its last event.
];
const s = summarizeTraining(ev);
ok(s.runs === 2, `two runs (${s.runs})`);
ok(s.wall_clock_s === 60 + 60, `wall clock sums RUNS, not the idle hour between them (${s.wall_clock_s}s)`);
ok(s.casts['holy symbol'].success === 1 && s.casts['holy symbol'].fizzle === 1, 'successes and fizzles per spell');
ok(s.totals.refused === 1 && s.totals.success === 2, `totals (${JSON.stringify(s.totals)})`);
ok(s.improves['holy symbol'].improves === 1, 'improves counted from improve events');
ok(s.money_spent_bought === 1400, `money counts BOUGHT only, not chest draws (${s.money_spent_bought})`);
const wings = s.restock.find(r => r.item === 'fairy wing');
ok(wings && wings.costKnown === false, 'an unread cost is flagged unknown, never summed as 0');
ok(s.restock.find(r => r.source === 'chest')?.qty === 30, 'chest draws are recorded by source');
ok(s.rooms_travelled === 4, 'rooms travelled come from run_end');
ok(s.code.length === 2 && s.code.some(c => c.includes('def5678')), `each run's code identity is kept (${s.code})`);
ok(s.ability_span?.['holy symbol']?.to === 11, 'the ability span reads first and last snapshot');
const since = summarizeTraining(ev, { since: T + 3_000_000 });
ok(since.runs === 1 && !since.casts['holy symbol'], '--since drops earlier runs');
const kr = summarizeTraining([...ev, { t: T + 1, run: 'r1', kind: 'cast', spell: 'bless', school: 'Kraanan', outcome: 'success' }], { school: 'shalille' });
ok(!kr.casts.bless, 'the school filter drops another school (and matches "Shal\'ille" to "shalille")');

ok(improvesBetween({ abilities: { a: 5, b: 9 } }, { abilities: { a: 7, b: 9 } }).length === 1, 'improve between snapshots');
ok(improvesBetween({ abilities: null }, { abilities: { a: 7 } }).length === 0, 'an unread snapshot yields nothing, not a jump from 0');
ok(improvesBetween({ abilities: { a: null } }, { abilities: { a: 7 } }).length === 0, 'an unread ability is not an improve');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
