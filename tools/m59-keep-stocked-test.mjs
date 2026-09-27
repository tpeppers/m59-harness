#!/usr/bin/env node
// THE RESTOCK DECISIONS, OFFLINE.   node tools/m59-keep-stocked-test.mjs
//
// m59-keep-stocked.mjs keeps one character (the stage-room dedicator) stocked from the guild chest
// on somebody else's legs. What it fetches, when, and who goes are pure functions; pinned here.
import { parseCounts, carriedCounts, restockPlan, pickRider } from './m59-keep-stocked.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                                         else { failed++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); } };

const want = parseCounts('elderberry:300,orc tooth:100');
ok('counts parse, names with spaces included', want.elderberry === 300 && want['orc tooth'] === 100);
const low = parseCounts('elderberry:60,orc tooth:25');

const row = { pack_items: [{ name: 'elderberry', amount: 40 }, { name: 'orc tooth', amount: 90 }] };
const have = carriedCounts(row, Object.keys(want));
ok('carried counts read the pack summary', have.elderberry === 40 && have['orc tooth'] === 90);

const plan = restockPlan(have, want, low, 5000);
ok('one item under its low mark triggers a trip', !!plan && plan.short.join() === 'elderberry');
ok('and the trip fills EVERY item back to its want',
   plan.wants.find(w => w.item === 'elderberry')?.amount === 260 &&
   plan.wants.find(w => w.item === 'orc tooth')?.amount === 10, JSON.stringify(plan));
ok('with the money first', plan.wants[0].item === 'shilling' && plan.wants[0].amount === 5000);
ok('nothing under a low mark: no trip', restockPlan({ elderberry: 100, 'orc tooth': 50 }, want, low, 5000) === null);

const rows = [
  { agent: 'hk3', room_num: 2, health: '25/25' },
  { agent: 't1', room_num: 2, health: '75/75', pack: { percent: 40 }, autopilot: { mode: 'idle' } },
  { agent: 't5', room_num: 2, health: '75/75', pack: { percent: 20 }, autopilot: { mode: 'idle' } },
  { agent: 't19', room_num: 2, health: '75/75', pack: { percent: 5 }, autopilot: { mode: 'idle' } },
  { agent: 't7', room_num: 599, health: '75/75', pack: { percent: 1 }, autopilot: { mode: 'farm' } },
  { agent: 't9', room_num: 2, health: '61/61', pack: { percent: 1 }, autopilot: { mode: 'idle' } },
  { agent: 't8', room_num: 2, health: '40/75', pack: { percent: 1 }, autopilot: { mode: 'idle' } },
  { agent: 't2', room_num: 2, health: '75/75', pack: { percent: 1 }, piloted: true },
];
const r = pickRider(rows, { room: 2, target: 'hk3', exclude: ['hk1', 't19'] });
ok('the rider is the idle full-sized one with the most free pack', r?.agent === 't5', JSON.stringify(r));
ok('never the target, an excluded cup holder, a small, a hurt or a piloted one',
   !['hk3', 't19', 't9', 't8', 't2'].includes(r?.agent));
ok('nobody suitable: no rider', pickRider(rows, { room: 38, target: 'hk3' }) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
