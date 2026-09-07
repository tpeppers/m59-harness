#!/usr/bin/env node
// Offline: the actual packet callback and death recorder, with movement held pending.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { M59Client } from './m59-client.mjs';

const records = [], notes = [], broadcasts = [];
const client = Object.assign(Object.create(M59Client.prototype), {
  evSeq: 0, events: [], maxEvents: 100, waiters: [], inventory: [],
  vitals: () => ({ health: { value: 1, max: 20 } }),
});
const s = { name: null, client, recorder: { line() {} }, hits: { segments: [] } };
const k = Object.assign(Object.create(Autopilot.prototype), {
  s, policy: {}, tally: { deaths: 0 }, money: { carried_at_death: 0 }, lastSeenPurse: 400,
  passes: 93, passStartedAt: Date.now() - 60_000,
  recent5: [{ at: Date.now(), room: 'The Flatlands', num: 584,
              row: 35, col: 27, health: 3, max: 21, doing: 'travelling', threats: ['ant'] }],
  who: () => null, safety: () => ({ fleeAt: 0.4 }), recentText: () => [],
  note: (what, detail) => notes.push({ what, detail }),
  writePostMortem: record => { records.push(structuredClone(record)); return 'offline-record'; },
  awaitDeathBroadcast: () => new Promise(resolve => broadcasts.push(resolve)),
});

// Run the actual joinOnce event wiring, not a hand-written stand-in for the hook.
const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const start = source.indexOf('    c.onEvent = ev => {', source.indexOf('  async joinOnce('));
const end = source.indexOf('    if (character)', start);
assert.ok(start >= 0 && end > start, 'the production event callback must be found');
new Function('c', 'autopilotIfAny', source.slice(start, end)).call(s, client, () => k);

client.emit('room-entered', { room: 999, roomName: 'The Underworld' });
assert.equal(k.tally.deaths, 1, 'death is counted before the travel await can resume');
assert.equal(k.lastDeath.room_num, 584);
assert.equal(k.money.carried_at_death, 400);
const first = k.deathReportTask;
client.emit('room-entered', { room: 1000, roomName: 'The Underworld' });
assert.equal(k.observeDeath(), first, 'the ordinary pass joins the same report');
assert.equal(k.tally.deaths, 1, 'renumbering/repeated Underworld entry is not another death');
client.emit('room-entered', { room: 1001, roomName: null });
assert.equal(k.observeDeath(), first, 'unknown room names cannot clear the death episode');

// Escape occurs before reporting finishes, without a normal keeper pass seeing death.
client.emit('room-entered', { room: 6, roomName: 'Yonder Inn' });
assert.equal(k.tally.deaths, 1, 'wire object id 6 alone does not mean Underworld');
k.recent5[0].room = 'Yonder Inn'; k.recent5[0].num = 370;
broadcasts.shift()({ killer: 'ant', text: '### Test was just killed by an ant.', how: 'killed' });
await first;
assert.equal(records.length, 1);
assert.equal(records[0].where.num, 584, 'the pre-wait death evidence survives escape');
assert.equal(records[0].summary.room_num, 584);
assert.deepEqual(records[0].summary.killed_by, ['ant']);
assert.equal(k.lastDeath.post_mortem, 'offline-record');
assert.equal(k.pendingDeath.killed_by, 'ant');

// A second death re-arms recording. A later record finishing first must remain current.
client.emit('room-entered', { room: 1002, roomName: 'The Underworld' });
const second = k.deathReportTask;
client.emit('room-entered', { room: 1003, roomName: 'An Inn' });
client.emit('room-entered', { room: 1004, roomName: 'The Underworld' });
const third = k.deathReportTask;
const resolveSecond = broadcasts.shift(), resolveThird = broadcasts.shift();
resolveThird({ killer: 'rat', text: '### Test was just killed by a rat.' }); await third;
const newest = k.lastPostMortem;
resolveSecond(null); await second;
assert.equal(k.tally.deaths, 3);
assert.equal(k.money.carried_at_death, 1200);
assert.equal(records.length, 3);
assert.equal(k.lastPostMortem, newest, 'an older completion cannot overwrite the current report');
assert.equal(k.pendingDeath.killed_by, 'rat');
assert.equal(records.at(-1).summary.killed_by_is_a_guess, true);

// The fallback pass still detects a corpse if the keeper attached after the event.
k.reportedDeath = false;
k.journeyEndedInADeath = () => { throw new Error('stop before escape'); };
const room = { num: 1, name: 'The Underworld' };
const fallback = k.passUnderworld({ s, c: client, room });
broadcasts.shift()(null);
await assert.rejects(fallback, /stop before escape/);
assert.equal(k.tally.deaths, 4);
assert.equal(records.length, 4);
await assert.rejects(k.passUnderworld({ s, c: client, room }), /stop before escape/);
assert.equal(k.tally.deaths, 4, 'repeated failed escapes are still one death');

// A callback from an old client or a different session cannot record this keeper's death.
s.client = {};
client.emit('room-entered', { roomName: 'The Underworld' });
s.client = client; k.s = {};
client.emit('room-entered', { roomName: 'The Underworld' });
assert.equal(k.tally.deaths, 4);
assert.equal(notes.filter(n => n.what === 'DIED').length, 4);
console.log('Death observation, deduplication, evidence snapshots and session ownership passed');
