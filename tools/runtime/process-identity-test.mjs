#!/usr/bin/env node
// Offline. Pins the rule that decides whether a LIVE pid is still the process that
// registered itself as a guard. Starts no processes and reads no lock: every input is
// supplied, because a test that had to recycle a real pid could not be run on demand.

import assert from 'node:assert/strict';
import {
  START_TIME_TOLERANCE_MS,
  guardStillOurs,
  isNodeProcessName,
  processStartTimes,
} from './process-identity.mjs';

let checks = 0;
const is = (actual, expected, what) => { checks++; assert.deepEqual(actual, expected, what); };
const ok = (value, what) => { checks++; assert.ok(value, what); };

// ---- what counts as one of ours
ok(isNodeProcessName('node.exe'), 'node.exe is a keeper image');
ok(isNodeProcessName('node'), 'node is a keeper image');
ok(isNodeProcessName('/usr/local/bin/node'), 'a path to node is a keeper image');
ok(isNodeProcessName('node-18'), 'a versioned node is still node');
ok(!isNodeProcessName('browserhost.exe'), 'McAfee is not a keeper image');
ok(!isNodeProcessName('chrome.exe'), 'a browser is not a keeper image');
ok(!isNodeProcessName(''), 'an empty name is not evidence of node');
ok(!isNodeProcessName(null), 'a missing name is not evidence of node');

// ---- START TIME IS IDENTITY: a recycled pid fails to match even when it IS node.
{
  const registered = 1_700_000_000_000;
  is(guardStillOurs(4242, registered, { startedAt: registered, imageName: 'node.exe' }).ours, true,
     'same pid, same start time, node: still ours');
  const recycled = guardStillOurs(4242, registered,
    { startedAt: registered + 90_000, imageName: 'node.exe' });
  is(recycled.ours, false, 'a NODE process that started later is a recycled pid');
  ok(/started .*the guard was registered at/.test(recycled.why), 'the refusal says both times');

  // Second-granular readers must not make a match look like a mismatch.
  is(guardStillOurs(4242, registered,
    { startedAt: registered + START_TIME_TOLERANCE_MS - 1, imageName: 'node.exe' }).ours, true,
     'a difference inside the tolerance is the same process');
  is(guardStillOurs(4242, registered,
    { startedAt: registered + START_TIME_TOLERANCE_MS + 1, imageName: 'node.exe' }).ours, false,
     'a difference past the tolerance is not');
}

// ---- IMAGE NAME IS THE FALLBACK, for locks written before start times were recorded.
{
  const mcafee = guardStillOurs(28016, undefined, { startedAt: null, imageName: 'browserhost.exe' });
  is(mcafee.ours, false, 'THE INCIDENT: a live guard pid running McAfee is not our keeper');
  ok(/browserhost\.exe/.test(mcafee.why), 'the refusal names what is actually running');
  is(guardStillOurs(28016, undefined, { startedAt: null, imageName: 'node.exe' }).ours, true,
     'a live node pid with no recorded identity stays ours');
}

// ---- EVERY UNCERTAIN CASE FAILS CLOSED. This is the half that must never regress: a guard
// wrongly judged recycled lets a second broker onto characters a live keeper is holding.
{
  is(guardStillOurs(7, undefined, { startedAt: null, imageName: null }).ours, true,
     'nothing known at all: the lock holds');
  is(guardStillOurs(7, 1_700_000_000_000, { startedAt: null, imageName: null }).ours, true,
     'a recorded start we cannot read back today: the lock holds');
  is(guardStillOurs(7, 1_700_000_000_000, { startedAt: null, imageName: 'node.exe' }).ours, true,
     'a recorded start we cannot read back, on a node image: the lock holds');
  is(guardStillOurs(7, 0, { startedAt: 123, imageName: 'node.exe' }).ours, true,
     'a nonsense recorded start is not evidence of anything');
  is(guardStillOurs(7, undefined, { startedAt: 1, imageName: undefined }).ours, true,
     'an undefined image is unknown, not "not node"');
}

// ---- the reader itself: shape, and that a failing probe is null rather than a throw
{
  const out = processStartTimes([11, 22], {
    exec: () => { throw new Error('no such command'); },
  });
  is([...out.entries()], [[11, null], [22, null]],
     'a probe that fails maps every pid to null rather than dropping it');
  is([...processStartTimes([]).entries()], [], 'no pids is no work');
  is([...processStartTimes([0, -3, 1.5, 'x']).entries()], [],
     'only positive integer pids are asked about');
  const deduped = processStartTimes([9, 9, 9], { exec: () => '' });
  is([...deduped.keys()], [9], 'a pid named three times is asked about once');
}

console.log(`runtime process identity: PASS (${checks} checks)`);
