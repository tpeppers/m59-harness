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
// A REPORT THAT THREW MUST NOT WEDGE THE ESCAPE. The task is memoised and re-returned to
// every later observer, and passUnderworld awaits it BEFORE escapeUnderworld — so if the
// rejection is allowed to survive, every later pass throws on the cached promise and the
// character never leaves. Measured on the unfixed head: escape reached on 0 of 3 passes,
// deaths 1/1/1, DOMException "() => {} could not be cloned"; on main the same throw costs
// one pass (escape reached on 2 of 3). The realistic source is `decisions` — note() spreads
// arbitrary caller payload into the journal and structuredClone throws where the previous
// shallow spread + JSON.stringify silently dropped — but ANY throw in the body does it,
// including uptime.outageAround's unguarded ledger read.
{
  const reached = [];
  const boom = Object.assign(Object.create(Autopilot.prototype), {
    s, policy: {}, tally: { deaths: 0 }, money: { carried_at_death: 0 }, lastSeenPurse: 0,
    passes: 1, passStartedAt: Date.now(), recent5: [],
    who: () => null, safety: () => ({ fleeAt: 0.4 }), recentText: () => [],
    note: () => {}, writePostMortem: () => null,
    awaitDeathBroadcast: async () => null,
    postMortem() { throw new TypeError('the post-mortem could not be built'); },
    journeyEndedInADeath() { reached.push(true); throw new Error('probe: reached the escape'); },
  });
  const underworld = { num: 1, name: 'The Underworld' };
  for (let pass = 0; pass < 3; pass++)
    await assert.rejects(boom.passUnderworld({ s, c: client, room: underworld }),
                         /probe: reached the escape/,
                         'a failed death record must still let the pass reach the escape');
  assert.equal(reached.length, 3, 'every pass reaches the escape, not just the first');
  assert.equal(boom.tally.deaths, 1, 'and the death is still counted exactly once');
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE RECORD HAS TO SAY WHETHER IT TRIED FOR A WALL, AND WHERE THE PASS STOPPED.
//
// Both were unanswerable from a postmortem until 2026-09-10. 250 of the 270 travelling deaths
// since 2026-09-01 died with no wall and no safe spot, and nothing in the file distinguished
// "tried and could not reach one" from "never looked" — the shelter counters go to the travel
// ledger at journey end, which a character that dies mid-journey never reaches. Separately,
// 93% of deaths had the pass blocked over thirty seconds and no field said blocked ON WHAT.
{
  const record = records.find(r => r?.summary);
  assert.ok(record, 'the earlier cases must have produced a real record to inspect');
  const sh = record.summary.shelter;
  assert.ok(sh && typeof sh === 'object', 'the summary carries a shelter block');
  // Every counter present even at zero: an absent field and a zero read identically to a
  // grep, and "never tried" is the finding this block exists to be able to state.
  for (const f of ['stops', 'hop_wall', 'sanctuary', 'route', 'track', 'held_ms',
                   'taken_this_room', 'budget_per_room'])
    assert.equal(typeof sh[f], 'number', `shelter.${f} is always a number, never absent`);
  assert.ok('below' in sh, 'the threshold it would have sheltered below is recorded');
  assert.ok('ordinary_wall_tried_ms_ago' in sh,
            'the ordinary ladder\'s wall attempt is recorded — it is the rung that applies '
          + 'when no journey hold is live, which was 241 of 270 deaths');
  assert.ok('blocked_in' in record.summary,
            'the summary says which pass stage was running, or null');

  // A KEEPER THAT DID SHELTER MUST LOOK DIFFERENT FROM ONE THAT DID NOT, or the block could
  // report zeroes for ever and every assertion above would still pass. So: set the counters a
  // real journey would have set, kill the character through the SAME wiring, and read the
  // record back. `postMortem()` alone cannot be used for this — it does not build `summary`;
  // `observeDeath` does, and that is the path a real death takes.
  const mine = [];
  const walled = Object.assign(Object.create(Autopilot.prototype), {
    s, policy: { travelShelterPerRoom: 4 }, tally: { deaths: 0 },
    money: { carried_at_death: 0 }, lastSeenPurse: 0,
    passes: 7, passStartedAt: Date.now() - 97_000, recent5: [],
    who: () => null, safety: () => ({ fleeAt: 0.4 }), recentText: () => [],
    note: () => {},
    writePostMortem: record => { mine.push(structuredClone(record)); return 'offline'; },
    awaitDeathBroadcast: async () => null,
    // what a journey that DID shelter would have left behind
    travelSafeStops: 3, travelHopWallStops: 2, travelSanctuaryStops: 1,
    travelRouteStops: 0, travelTrackStops: 0, travelShelterHeldMs: 41_000,
    shelterStops: { room: 599, taken: 4 }, wallTriedAt: Date.now() - 12_000,
    passStage: 'passFarm', passStageAt: Date.now() - 97_000,
  });
  await walled.passUnderworld({ s, c: client, room: { num: 1, name: 'The Underworld' } })
              .catch(() => {});
  await walled.deathReportTask;
  assert.equal(mine.length, 1, 'the instrumented death produced a record');
  const s2 = mine[0].summary.shelter;
  assert.equal(s2.stops, 3, 'shelter stops are reported');
  assert.equal(s2.hop_wall, 2, 'and which kind of stop they were');
  assert.equal(s2.sanctuary, 1, 'including a sanctuary pause');
  assert.equal(s2.held_ms, 41_000, 'and how long was spent behind cover');
  assert.equal(s2.taken_this_room, 4, 'and the per-room spend that refuses the next stop');
  assert.equal(s2.budget_per_room, 4, 'and the budget it is spent against');
  assert.equal(s2.this_room, 599, 'and which room that budget belongs to');
  assert.ok(s2.ordinary_wall_tried_ms_ago >= 12_000,
            'and how long ago the ORDINARY ladder last tried for a wall — the rung that '
          + 'applies when no journey hold is live, which was 241 of 270 deaths');
  const b2 = mine[0].summary.blocked_in;
  assert.equal(b2.stage, 'passFarm', 'the blocked pass names the stage it was sitting in');
  assert.ok(b2.in_stage_ms >= 97_000, 'and how long it had been there');
}

// AND THE FIELD HAS TO BE FED, IN THE RIGHT ORDER. `blocked_in` is worth nothing if the
// dispatcher sets it after the await: it would then always name the stage that had already
// finished, which is precisely the stage that did NOT block.
{
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.match(src,
    /this\.passStage = stage;\s*\n\s*this\.passStageAt = Date\.now\(\);\s*\n\s*const verdict = await this\[stage\]\(ctx\);/,
    'runPassLadder records the stage IMMEDIATELY BEFORE awaiting it');
}

console.log('Death observation, deduplication, evidence snapshots, session ownership, ' +
            'escape-despite-a-failed-report, the shelter record and the blocked-stage '
          + 'record passed');
