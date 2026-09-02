#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Recorder } from './m59-recorder.mjs';

const root = mkdtempSync(join(tmpdir(), 'm59-recorder-'));
try {
  const directory = join(root, 'not-created-until-write');
  let clock = 1_000;
  let nextHandle = 0;
  const pending = new Map();
  const cleared = [];
  const recorder = new Recorder('A name/with punctuation', {
    directory,
    windowMs: 10_000,
    keep: 2,
    flushMs: 2_000,
    now: () => clock,
    setTimer: callback => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    clearTimer: handle => {
      cleared.push(handle);
      pending.delete(handle);
    },
  });

  assert.equal(existsSync(directory), false,
    'an idle recorder does not touch the filesystem');
  assert.equal(pending.size, 0, 'an idle recorder owns no timer');

  recorder.line('state', { room: 1 });
  recorder.line('state', { room: 2 });
  assert.equal(pending.size, 1, 'a burst shares one one-shot flush timer');
  assert.equal(recorder.timer, 0, 'a valid falsy timer handle is retained');
  assert.equal(existsSync(directory), false,
    'buffering still performs no filesystem work');

  const callback = pending.get(0);
  pending.delete(0);
  callback();
  assert.equal(recorder.timer, null, 'the one-shot disarms before flushing');
  assert.equal(pending.size, 0, 'idle after a flush means no timer');
  assert.equal(existsSync(directory), true, 'the first real flush creates the directory');
  const firstFile = join(directory, 'A_name_with_punctuation-0.jsonl');
  const events = readFileSync(firstFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.room), [1, 2]);

  recorder.line('state', { room: 3 });
  assert.equal(pending.size, 1, 'new work rearms one timer');
  recorder.flush();
  assert.equal(pending.size, 0, 'manual flush cancels the pending timer');
  assert.deepEqual(cleared, [1]);

  clock = 21_000;
  recorder.line('state', { room: 4 });
  recorder.flush();
  clock = 31_000;
  recorder.line('state', { room: 5 });
  recorder.flush();
  clock = 41_000;
  recorder.line('state', { room: 6 });
  recorder.flush();
  const files = readdirSync(directory).sort();
  assert.equal(files.length, 3,
    'pruning happens on rollover and retains the current file plus the previous keep files');

  const tail = recorder.tail(2, ['state']);
  assert.deepEqual(tail.map(event => event.room), [5, 6], 'tail spans recent windows');
  recorder.stop();
  recorder.stop();
  recorder.line('state', { room: 7 });
  assert.equal(pending.size, 0, 'a stopped recorder cannot rearm itself');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('event-driven recorder: PASS');
