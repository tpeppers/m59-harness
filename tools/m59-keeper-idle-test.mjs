#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');

assert.match(source, /new DeferredLatest\(writeStateSnapshot, \{ delayMs: 30_000 \}\)/,
  'state persistence is downstream of a reader-refreshed coalescing writer');
assert.doesNotMatch(source, /setInterval\(\s*save(?:State|FinalState)/,
  'an idle keeper has no periodic enriched-state projection');
assert.match(source, /if \(snapshot\.refreshed\) statePersistence\.push\(snapshot\.value\)/,
  'only a newly built reader snapshot enters persistence');
assert.match(source, /if \(finalStateSaved\) return false/,
  'SIGTERM/stop plus process exit cannot build the final snapshot twice');
assert.doesNotMatch(source, /initial join failed[\s\S]{0,500}setInterval/,
  'initial-join recovery does not leave a lifetime interval behind');
assert.match(source, /if \(inGame && session\.live\) return/,
  'the retry retires after proof that the session is live');
assert.match(source, /path === '\/leave'[\s\S]{0,300}changeJoinIntent\(false\)/,
  'an explicit leave invalidates pending and in-flight startup recovery');
assert.match(source, /await keeperJoinInFlight\?\.promise\?\.catch/,
  'leave waits for an already-running login to observe invalidation before replying');

console.log('keeper idle deadlines: PASS');
