#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mergeTuiRow, fleetFreshness, cupsIn, cupKey, chaliceMarks, zoneLabel }
  from './m59-tui-state.mjs';

const row = {
  agent: 't15', activity: 'idle', deaths: 0, deaths_since_keeper_start: 0,
  deaths_24h: 2, deaths_in_safe_spot: 1, deaths_in_proven_safe_spot: 0,
  kills: 4, kills_30m: 3, snapshot_age_ms: 1700,
  policy: { hunt: null }, autopilot: { mode: 'farm', running: true },
  last_death: { at: 9, died_in: 'Upstairs' },
};
const keeper = {
  __port: 8938, as_of_ms: 300,
  goap: { running: true, mode: 'survive' },
  autopilot_status: {
    activity: 'holding safe spot', safe_spot: { works: true },
    did: { deaths: 1, mulligans: 2 }, policy: { hunt: 'stale hunt' },
  },
};
const merged = mergeTuiRow(row, keeper);
assert.equal(merged.ap.mode, 'survive');
assert.equal(merged.ap.activity, 'holding safe spot');
assert.equal(merged.ap.safe_spot.works, true);
assert.equal(merged.ap.did.deaths, 0);
assert.equal(merged.ap.did.deaths_24h, 2);
assert.equal(merged.ap.did.deaths_in_safe_spot, 1);
assert.equal(merged.ap.did.mulligans, 2);
assert.equal(merged.ap.did.kills_30m, 3);
assert.deepEqual(merged.ap.last_death, row.last_death);
assert.equal(merged.snapshot_age_ms, 1700);
assert.equal(merged.keeper_port, 8938);

const fresh = fleetFreshness([merged, { snapshot_age_ms: 12_000 }, {}]);
assert.equal(fresh.known, 2);
assert.equal(fresh.unknown, 1);
assert.equal(fresh.stale.length, 1);
assert.equal(fresh.max_age_ms, 12_000);

// THE CUP. The pack comes from the keeper; the name is matched exactly, so look-alikes are not cups.
assert.equal(merged.cups, null, 'no pack from the keeper is unknown, not empty');
assert.deepEqual(cupsIn([{ id: 7, name: 'Chalice of the Rain' }, { id: 8, name: 'fake chalice' },
  { id: 9, name: 'model chalice of the rain' }, { id: -1, name: 'chalice of the rain' }]), [7]);

const at = (agent, room_num, cups, extra = {}) => ({ agent, room_num, room: 'R' + room_num, in_game: true, cups, ...extra });
const levels = new Map([[cupKey('a', 1), { safe: true }], [cupKey('b', 2), { safe: false }],
  [cupKey('d', 4), { safe: true }]]);
const marks = chaliceMarks([
  at('a', 2, [1]),            // holds a safe cup in a refill room
  at('b', 2, [2]),            // holds a one-sip cup, but a holds a safe one here
  at('c', 39, []),            // nobody in 39 holds anything
  at('d', 39, [4], { in_game: false }),   // a logged-off holder does not count for c
  at('e', 50, [5]),           // its own cup has not been read yet
  at('f', 50, []),            // the only cup here is e's, unread
  at('g', 60, null),          // no pack at all
], levels);
assert.deepEqual(marks.get('a'), { cup: 'held', refill: true });
assert.deepEqual(marks.get('b'), { cup: 'room', refill: true });
assert.deepEqual(marks.get('c'), { cup: 'none', refill: false });
assert.equal(marks.get('d').cup, 'unknown');
assert.equal(marks.get('e').cup, 'unknown');
assert.equal(marks.get('f').cup, 'unknown');
assert.equal(marks.get('g').cup, 'unknown');
assert.equal(chaliceMarks([at('h', 2154, [])]).get('h').refill, true, 'Avar Village is jungle');
assert.equal(chaliceMarks([at('i', 714, [])]).get('i').refill, false, 'the hall is not');

assert.equal(zoneLabel({ room_num: 52, room: 'Familiars' }), '52 - Familiars');
assert.equal(zoneLabel({ room_num: 1, room: 'Underworld' }), '1 - Underworld');
assert.equal(zoneLabel({ room_num: null, room: null }), '—');
assert.equal(zoneLabel({ in_game: false, room_num: 2, room: 'Outside Castle Victoria' }), '—');

console.log('m59-tui-state-test: 29/29');
