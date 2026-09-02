#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configureLabEnvironment, LAB_MUTABLE_PATH_KEYS } from './lab-environment.mjs';

const root = mkdtempSync(join(tmpdir(), 'm59-lab-env-'));
try {
  const seeds = join(root, 'seed');
  mkdirSync(seeds);
  const seedFiles = {
    M59_SAFESPOT_FILE: join(seeds, 'safe.json'),
    M59_BAD_EXITS: join(seeds, 'bad.json'),
    M59_PREYSIDE_FILE: join(seeds, 'prey.json'),
    M59_TRACK_STRIKES: join(seeds, 'strikes.json'),
  };
  for (const [key, path] of Object.entries(seedFiles))
    writeFileSync(path, JSON.stringify({ seeded_by: key }));

  // These are configuration, generated books, or authoritative static resources that the
  // actor call surface only reads. The environment boundary must leave them shared.
  const sharedReadOnly = {
    M59_CROSSINGS: join(root, 'shared', 'm59-crossings.json'),
    M59_CROSSINGS_LEARNED: join(root, 'shared', 'm59-crossings-learned.json'),
    M59_NAV_LEARNED: join(root, 'shared', 'm59-nav-learned.json'),
    M59_LOADOUT_DIR: join(root, 'shared', 'loadouts'),
    M59_TRACKS: join(root, 'shared', 'm59-tracks.json'),
    M59_TUNING_FILE: join(root, 'shared', 'tuning.json'),
    M59_PLAYBOOK_DIR: join(root, 'shared', 'playbooks'),
    M59_MERCHANTS: join(root, 'shared', 'merchants.json'),
    M59_GUILD_PLAN: join(root, 'shared', 'guild-plan.json'),
    M59_STRATEGY_DIR: join(root, 'shared', 'strategy-ui'),
    M59_MAP: join(root, 'shared', 'm59-map.json'),
    M59_ROUTES_FILE: join(root, 'shared', 'm59-routes.json'),
    M59_RSC_DIR: join(root, 'shared', 'rsc'),
    M59_ROO_DIR: join(root, 'shared', 'roo'),
  };
  const env = {
    M59_KEEPER: '0',
    ...seedFiles,
    ...sharedReadOnly,
  };
  const result = configureLabEnvironment({ fleet: 'lab-one', stateFile: join(root, 'lab-one.json') }, env);
  assert.equal(env.M59_FLEET, 'lab-one');
  assert.equal(env.M59_STATE_FILE, join(root, 'lab-one.json'));
  assert.equal(env.M59_TIME_SCALE, '1');
  assert.equal(env.M59_KEEPER, '1');
  for (const key of LAB_MUTABLE_PATH_KEYS) {
    assert.equal(typeof env[key], 'string', `${key} must resolve to a path`);
    const fromRuntime = relative(resolve(result.runtimeDir), resolve(env[key]));
    assert.ok(fromRuntime && !fromRuntime.startsWith('..') && !isAbsolute(fromRuntime),
      `${key} escaped runtimeDir: ${env[key]}`);
  }
  assert.ok(existsSync(result.safespots));
  assert.equal(env.M59_BAD_EXITS, join(result.runtimeDir, 'm59-badexits.json'));
  assert.equal(result.badExits, env.M59_BAD_EXITS);
  assert.equal(env.M59_TRACK_STRIKES, join(result.runtimeDir, 'm59-track-strikes.json'));
  assert.equal(result.trackStrikes, env.M59_TRACK_STRIKES);
  for (const [key, source] of Object.entries(seedFiles)) {
    assert.deepEqual(JSON.parse(readFileSync(env[key], 'utf8')), { seeded_by: key });
    assert.ok(result.seeded.includes(key));
  }
  for (const [key, path] of Object.entries(sharedReadOnly))
    assert.equal(env[key], path, `${key} is an actor-read-only input and must remain shared`);
  assert.notEqual(env.M59_SAFESPOT_FILE, result.safespots.replace('.lab-runtime', 'elsewhere'));

  writeFileSync(env.M59_TRACK_STRIKES, JSON.stringify({ lab_progress: true }));
  const configuredAgain = configureLabEnvironment(
    { fleet: 'lab-one', stateFile: join(root, 'lab-one.json') }, env);
  assert.deepEqual(JSON.parse(readFileSync(env.M59_TRACK_STRIKES, 'utf8')), { lab_progress: true },
    'a later configure does not overwrite private evidence with its original seed');
  assert.equal(configuredAgain.seeded.length, 0);

  const shardEnvA = { ...seedFiles };
  const shardEnvB = { ...seedFiles };
  const shardA = configureLabEnvironment(
    { fleet: 'lab-one', stateFile: join(root, 'lab-one.json') }, shardEnvA,
    { scope: 'shard-1' });
  const shardB = configureLabEnvironment(
    { fleet: 'lab-one', stateFile: join(root, 'lab-one.json') }, shardEnvB,
    { scope: 'shard-2' });
  assert.notEqual(shardA.runtimeDir, shardB.runtimeDir,
    'replace-style evidence writers must not share a shard directory');
  assert.equal(shardA.baseRuntimeDir, shardB.baseRuntimeDir);
  assert.equal(shardA.coordinationDir, shardB.coordinationDir);
  assert.equal(shardEnvA.M59_SPOT_CLAIMS_DIR, shardEnvB.M59_SPOT_CLAIMS_DIR,
    'only the atomic coordination store is shared across shards');
  assert.equal(shardEnvA.M59_LAB_SHARDED, '1');
  assert.equal(shardEnvA.M59_LAB_RUNTIME_DIR, shardA.runtimeDir);
  for (const key of LAB_MUTABLE_PATH_KEYS) {
    const privatePath = relative(resolve(shardA.runtimeDir), resolve(shardEnvA[key]));
    assert.ok(privatePath && !privatePath.startsWith('..') && !isAbsolute(privatePath),
      `${key} escaped its shard writer tree: ${shardEnvA[key]}`);
  }
  assert.throws(() => configureLabEnvironment(
    { fleet: 'lab-one', stateFile: join(root, 'lab-one.json') }, {},
    { scope: '../escape' }), /scope/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('lab environment: PASS');
