#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'm59-intel-runtime-'));
try {
  process.env.M59_INTEL_DIR = root;
  process.env.M59_FLEET = 'lab-test';
  const intel = await import('./m59-intel.mjs');
  const seenPath = join(root, 'players-seen.json');

  intel.recordSightings('Observer', [
    { id: 1, name: 'Observer' }, { id: 2, name: 'Fleet Mate' },
  ], null, name => name === 'Fleet Mate');
  assert.equal(existsSync(seenPath), false, 'an all-fleetmate frame performs no disk write');

  intel.recordSightings('Observer', [{ id: 3, name: 'Stranger' }], null, () => false);
  assert.equal(existsSync(seenPath), true, 'a real stranger creates the isolated index');
  const seen = JSON.parse(readFileSync(seenPath, 'utf8'));
  assert.equal(seen.Stranger.last_seen_by, 'Observer');
  assert.equal(seen.Stranger.total_sightings, 1);
  assert.equal(existsSync(join(root, 'player-history', 'Stranger.jsonl')), true);

  const unchanged = readFileSync(seenPath, 'utf8');
  intel.recordSightings('Observer', [{ id: 3, name: 'Stranger' }], null, () => false);
  assert.equal(readFileSync(seenPath, 'utf8'), unchanged,
    'an unchanged encounter performs no index rewrite');

  intel.recordSightings('Observer', [], null, () => false);
  assert.equal(readFileSync(seenPath, 'utf8'), unchanged,
    'an empty frame retires the encounter without touching disk');
  intel.recordSightings('Observer', [{ id: 3, name: 'Stranger' }], null, () => false);
  const reentered = JSON.parse(readFileSync(seenPath, 'utf8'));
  assert.equal(reentered.Stranger.total_sightings, 2,
    'leave and re-entry records one new encounter');

  intel.recordSightings('Observer', [{ id: 3, name: 'Stranger' }], 2, () => false);
  const moved = JSON.parse(readFileSync(seenPath, 'utf8'));
  assert.equal(moved.Stranger.total_sightings, 3,
    'a room transition records one new sighting even with the same object id');
  assert.equal(intel.conflictsPath().startsWith(root), true, 'conflicts share the isolated intel root');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('intel runtime isolation: PASS');
