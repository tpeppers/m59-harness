#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadLabSelection,
  parseLabArgs,
  publicSelection,
  resolveLabRosterPaths,
} from './lab-config.mjs';

assert.throws(() => parseLabArgs([]), /--fleet is required/);
assert.throws(() => parseLabArgs(['--fleet', 'prod', '--check']), /production-like/);
assert.throws(() => parseLabArgs(['--fleet', '..\\prod', '--check']), /letters, digits/);
assert.throws(() => parseLabArgs(['--fleet', 'lab', '--run', '--time-scale', '10']), /requires --time-scale 1/);
assert.throws(() => parseLabArgs(
  ['--fleet', 'lab', '--run'],
  { M59_STATE_FILE: 'ambient.json' },
), /refuses ambient M59_STATE_FILE/);
assert.throws(() => parseLabArgs(
  ['--fleet', 'lab', '--run'],
  { M59_ACCOUNT_LEASE_DIR: 'partitioned-account-ownership' },
), /refuses ambient M59_ACCOUNT_LEASE_DIR/);
assert.equal(parseLabArgs(
  ['--fleet', 'lab', '--check'],
  { M59_ACCOUNT_LEASE_DIR: 'ignored-by-read-only-check' },
).action, 'check');
assert.equal(parseLabArgs(['--fleet', 'lab']).action, 'check');
assert.deepEqual(parseLabArgs(['--fleet', 'lab', '--run', '--agents', 'a,b']).agents, ['a', 'b']);
assert.equal(parseLabArgs(['--fleet', 'lab']).shards, 1);
assert.equal(parseLabArgs(['--fleet', 'lab', '--run', '--shards', '4']).shards, 4);
assert.throws(() => parseLabArgs(['--fleet', 'lab', '--shards', '0']), /integer from 1 to 32/);

const dir = mkdtempSync(join(tmpdir(), 'm59-lab-config-'));
try {
  const stateFile = join(dir, 'roster.json');
  const secret = 'do-not-print';
  writeFileSync(stateFile, JSON.stringify({
    a: { credentials: {
      account: 'a', password: secret, character: 'A', host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    } },
    b: { credentials: {
      account: 'b', password: secret, character: 'B', host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    } },
    unmarked: { credentials: {
      account: 'unused', password: secret, character: 'Unused', host: '127.0.0.1', port: 15959,
    } },
  }));
  const config = parseLabArgs(['--fleet', 'lab', '--check', '--agents', 'b']);
  const selection = loadLabSelection(config, { M59_STATE_FILE: stateFile });
  assert.equal(selection.entries.length, 1);
  assert.equal(selection.entries[0].id, 'b');
  assert.equal(selection.endpoint, '127.0.0.1:15959');
  assert.equal(JSON.stringify(publicSelection(selection)).includes(secret), false);
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--check', '--agents', 'a,b', '--shards', '3']),
    { M59_STATE_FILE: stateFile },
  ), /--shards cannot exceed the 2 selected actor/);
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--check', '--agents', 'unmarked']),
    { M59_STATE_FILE: stateFile },
  ), /not explicitly marked credentials\.lab_runtime/);
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--agents', 'missing']),
    { M59_STATE_FILE: stateFile },
  ), /unknown --agents/);

  const parseSecret = 'JSON_PARSE_SECRET_MUST_NOT_PRINT';
  writeFileSync(stateFile,
    `{"a":{"credentials":{"password":${parseSecret},"lab_runtime":true}}}`);
  let parseError;
  try {
    loadLabSelection(parseLabArgs(['--fleet', 'lab', '--check']),
      { M59_STATE_FILE: stateFile });
  } catch (error) { parseError = error; }
  assert.match(parseError?.message ?? '', /fleet roster is not valid JSON/);
  assert.equal((parseError?.message ?? '').includes(parseSecret), false,
    'malformed roster diagnostics never echo credential-bearing source context');

  writeFileSync(stateFile, JSON.stringify({
    a: { credentials: {
      account: 'a', password: secret, host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    }, autopilot: { policy: { partner: 'b' } } },
    b: { credentials: {
      account: 'b', password: secret, host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    } },
  }));
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--check', '--agents', 'a']),
    { M59_STATE_FILE: stateFile },
  ), /partner b, which is not selected/);

  writeFileSync(stateFile, JSON.stringify({
    a: { credentials: {
      account: 'a', password: secret, host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    }, autopilot: { policy: { partner: 'b' } } },
    b: { credentials: {
      account: 'b', password: secret, host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    }, autopilot: { policy: { partner: 'c' } } },
    c: { credentials: {
      account: 'c', password: secret, host: '127.0.0.1', port: 15959,
      lab_runtime: true,
    } },
  }));
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--check']),
    { M59_STATE_FILE: stateFile },
  ), /conflicting partner configuration/);

  writeFileSync(stateFile, JSON.stringify({
    a: { credentials: {
      account: ' Account ', password: secret, host: 'LOCALHOST', port: 15959,
      lab_runtime: true,
    } },
    duplicate: { credentials: {
      account: 'account', password: secret, host: 'localhost', port: 15959,
      lab_runtime: true,
    } },
  }));
  assert.throws(() => loadLabSelection(
    parseLabArgs(['--fleet', 'lab', '--check']),
    { M59_STATE_FILE: stateFile },
  ), /duplicate one normalized account\+endpoint identity/);

  const runConfig = parseLabArgs(['--fleet', 'lab-offline-exact', '--run'], {});
  assert.throws(() => loadLabSelection(runConfig, { M59_STATE_FILE: stateFile }),
    /refuses ambient M59_STATE_FILE/);
  const paths = resolveLabRosterPaths(runConfig, {});
  assert.match(paths.stateFile.replaceAll('\\', '/'),
    /\/substrate\/fleets\/lab-offline-exact\.json$/);
  assert.equal(paths.lockFile, `${paths.stateFile}.lock`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('lab config: PASS');
