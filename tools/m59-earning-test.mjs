#!/usr/bin/env node
// IS THIS CHARACTER EARNING — the identity rule and the two verdicts, offline.
//
// No socket, no roster, no broker, no ledger on disk: every case here is a handful of rows
// built in the test. The first block is the one that matters most, because it pins a mistake
// that was actually made and actually reported as a measurement.
import assert from 'node:assert/strict';
import { rowIsFor, charactersIn, agentNames, earningFor, verdicts } from './m59-earning.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; console.log('  ok  ' + what); };

const T = Date.parse('2026-09-12T12:00:00Z');
const hAgo = h => T - h * 3600_000;

console.log('\nidentity — the trap this file exists to remove');

// THE INCIDENT. `killed` rows carry BOTH agent and character; `died` and `level_lost` carry
// only character. A filter spelt `r.agent || r.character` takes the agent when there is one,
// so testing it against a character name matches nothing and a busy character reports zero
// kills. Done on 2026-09-12 and reported to an operator as a measurement. The real figure was
// seventeen.
ok('a kill row is found by the character name even though it also carries an agent', () => {
  const row = { kind: 'killed', agent: 't11', character: 'Sweetums', t: T };
  assert.equal(rowIsFor(row, 'Sweetums'), true);
  assert.equal(rowIsFor(row, 'sweetums'), true, 'case must not matter');
  assert.equal(rowIsFor(row, 't11'), true, 'and the handle must work too');
});

ok('the naive `agent || character` read is what this replaces', () => {
  const row = { kind: 'killed', agent: 't11', character: 'Sweetums', t: T };
  // The bug, spelt out so nobody reintroduces it as an optimisation.
  const naive = String(row.agent || row.character).toLowerCase();
  assert.equal(naive === 'sweetums', false, 'the naive read cannot see the character name');
  assert.equal(rowIsFor(row, 'Sweetums'), true, 'this one can');
});

ok('a row with only a character still matches', () => {
  assert.equal(rowIsFor({ kind: 'died', character: 'Sweetums', t: T }, 'Sweetums'), true);
});

ok('nobody matches an empty or absent name', () => {
  assert.equal(rowIsFor({ agent: 't1', character: 'Kermit' }, ''), false);
  assert.equal(rowIsFor({ agent: 't1', character: 'Kermit' }, null), false);
  assert.equal(rowIsFor(undefined, 'Kermit'), false);
});

console.log('\nfolding handles into names — the same confusion, other direction');

// A few row kinds (`wedge_gave_up` is one) put the HANDLE in the character field. Listing
// distinct `character` values then reports one body twice, as "Kermit" and as "t1", with
// different numbers against each.
const mixed = [
  { kind: 'killed', agent: 't1', character: 'Kermit', t: T },
  { kind: 'wedge_gave_up', character: 't1', t: T },
  { kind: 'killed', agent: 'hk1', character: 'Loial the Ogier', t: T },
  { kind: 'wedge_gave_up', character: 'hk1', t: T },
];

ok('a handle in the character field folds into the real name', () => {
  assert.deepEqual(charactersIn(mixed), ['Kermit', 'Loial the Ogier']);
});

ok('the mapping is learned from the rows, not guessed', () => {
  const m = agentNames(mixed);
  assert.equal(m.get('t1'), 'Kermit');
  assert.equal(m.get('hk1'), 'Loial the Ogier');
});

ok('an unmappable handle survives rather than vanishing', () => {
  // A body seen ONLY in a wedge row cannot be resolved, and dropping it would hide it.
  assert.deepEqual(charactersIn([{ kind: 'wedge_gave_up', character: 't9' }]), ['t9']);
});

console.log('\ncounting');

const rows = [
  ...Array.from({ length: 3 }, () => ({ kind: 'killed', agent: 't11', character: 'Sweetums', t: hAgo(0.5) })),
  ...Array.from({ length: 14 }, () => ({ kind: 'killed', agent: 't11', character: 'Sweetums', t: hAgo(8) })),
  { kind: 'died', character: 'Sweetums', t: hAgo(2) },
  { kind: 'level_lost', character: 'Sweetums', from: 41, to: 40, t: hAgo(2) },
];

ok('windows are cumulative, not buckets', () => {
  const e = earningFor(rows, 'Sweetums', { now: T });
  assert.equal(e.kills_by_window['1h'], 3);
  assert.equal(e.kills_by_window['6h'], 3);
  assert.equal(e.kills_by_window['12h'], 17);   // the real figure, not the false zero
  assert.equal(e.kills_by_window['24h'], 17);
});

ok('hours since the last kill, from the newest row', () => {
  const e = earningFor(rows, 'Sweetums', { now: T });
  assert.equal(e.hours_since_kill, 0.5);
});

// Null, not 0 and not Infinity. Zero would read as "killed something just now", which is the
// opposite of the truth, and an alert comparing `>= 3` would never fire.
ok('never having killed is null, not zero', () => {
  const e = earningFor([{ kind: 'died', character: 'Loial the Ogier', t: hAgo(1) }],
                       'Loial the Ogier', { now: T });
  assert.equal(e.hours_since_kill, null);
  assert.equal(e.kills_by_window['24h'], 0);
});

console.log('\nthe ratchet');

ok('levels lost against levels gained, netted', () => {
  const e = earningFor(rows, 'Sweetums', { now: T });
  assert.equal(e.levels_lost, 1);
  assert.equal(e.levels_gained, 0);
  assert.equal(e.net_levels, -1);
});

// THE DISTINCTION THE WHOLE VERDICT EXISTS FOR. Dying a lot is ordinary on this fleet and the
// operator has said so. Dying a lot and never climbing back is a one-way street that ends at a
// body too small to fight, and nothing on any board tells the two apart — both show deaths.
ok('dying and climbing back is NOT a ratchet', () => {
  const busy = [
    ...Array.from({ length: 5 }, () => ({ kind: 'level_lost', character: 'Camilla', t: hAgo(5) })),
    ...Array.from({ length: 6 }, () => ({ kind: 'level_up', character: 'Camilla', t: hAgo(4) })),
    { kind: 'killed', agent: 't9', character: 'Camilla', t: hAgo(0.1) },
  ];
  const e = earningFor(busy, 'Camilla', { now: T });
  assert.equal(e.net_levels, 1);
  assert.deepEqual(verdicts(e).map(v => v.code), []);
});

ok('dying without climbing back IS a ratchet', () => {
  const e = earningFor(rows, 'Sweetums', { now: T });
  assert.deepEqual(verdicts(e).map(v => v.code), ['RATCHET']);
});

console.log('\nzero yield is about DURATION');

ok('a busy character is not flagged', () => {
  const e = earningFor(rows, 'Sweetums', { now: T });
  assert.equal(verdicts(e).some(v => v.code === 'ZERO_YIELD'), false);
});

// The whole point: `kills_30m` reads 0 both for a character between respawns and for one that
// stopped earning yesterday, and those need different actions.
ok('a quiet moment is not a stall, but a quiet half-day is', () => {
  const quiet = [{ kind: 'killed', agent: 't5', character: 'Bunsen', t: hAgo(1) }];
  assert.equal(verdicts(earningFor(quiet, 'Bunsen', { now: T })).some(v => v.code === 'ZERO_YIELD'),
               false, 'killed something an hour ago');
  const stale = [{ kind: 'killed', agent: 't5', character: 'Bunsen', t: hAgo(20) }];
  assert.equal(verdicts(earningFor(stale, 'Bunsen', { now: T })).some(v => v.code === 'ZERO_YIELD'),
               true, 'and nothing for twenty hours');
});

ok('a character that has never earned anything says so distinctly', () => {
  const e = earningFor([{ kind: 'died', character: 'Marco Polo', t: hAgo(1) }], 'Marco Polo', { now: T });
  const v = verdicts(e).find(x => x.code === 'ZERO_YIELD');
  assert.ok(v, 'flagged');
  assert.match(v.why, /nothing at all/, 'and distinguishable from one that stopped');
});

ok('the idle threshold is a parameter, not a constant', () => {
  const stale = [{ kind: 'killed', agent: 't5', character: 'Bunsen', t: hAgo(4) }];
  const e = earningFor(stale, 'Bunsen', { now: T });
  assert.equal(verdicts(e, { idleHours: 8 }).some(v => v.code === 'ZERO_YIELD'), false);
  assert.equal(verdicts(e, { idleHours: 2 }).some(v => v.code === 'ZERO_YIELD'), true);
});

console.log(`\n${n} assertions, all offline.\n`);
