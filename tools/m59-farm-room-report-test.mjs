import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('./m59-farm-room-report.mjs', import.meta.url));
const end = '2026-11-09T00:20:00.000Z';
const now = Date.parse(end);
const kill = (offset, fields = {}) => ({ t: now + offset, type: 'event', kind: 'killed',
  room_num: 552, character: 'Agent One', creature: 'mollusk creature', ...fields });
const sample = (character, fields = {}) => ({ t: now - 60_000, type: 'sample', room_num: 552,
  character, health: '120/120', vigor_of: '160/200', has_weapon: true,
  activity: 'holding a proven safe spot', ...fields });
const run = (dir, until = end) => spawnSync(process.execPath,
  [tool, '--fleet', '-', '--ledger-dir', dir, '--room', '552', '--end', until], { encoding: 'utf8' });

function writeDay(dir, day, rows) {
  writeFileSync(join(dir, `fleet-${day}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('counts exact-room kills and separates full health, ready proxy and stale offline observations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-farm-room-'));
  try {
    writeDay(dir, '2026-11-08', [kill(-30 * 60_000 - 1), kill(-25 * 60_000)]);
    const wall = sample('Agent One');
    writeDay(dir, '2026-11-09', [kill(-2000), kill(-1000, { human: true }),
      kill(-1000, { room_num: 544, human: true }), kill(-1000, { room_num: null }),
      kill(-3000, { character: 'Manual', human: true, creature: 'frogman' }), kill(0),
      wall, wall, sample('Low Vigor', { vigor_of: '90/200' }),
      sample('Unknown Vigor', { vigor_of: null }), sample('Offline', { activity: 'NOT IN GAME' }),
      sample('No HP', { health: null }), sample('Injured', { health: '90/120' }),
      sample('Moving', { activity: 'travelling' }), sample('Fighting', { activity: 'fighting from a proven safe spot' }),
      sample('Other Room', { room_num: 544 })]);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.kills, { recorded: 3, per_30m: 3, keeper: 2, human: 1,
      by_creature: { 'mollusk creature': 2, frogman: 1 }, unlocated_fleet_kills: 1 });
    const counts = report.observations;
    assert.equal(counts.connected, 6);
    assert.equal(counts.offline, 1);
    assert.equal(counts.health_unknown, 1);
    assert.equal(counts.full_health, 5);
    assert.equal(counts.ready_unknown, 1);
    assert.equal(counts.ready_proxy, 3);
    assert.deepEqual(counts.ready_proxy_by_activity, { 'holding a proven safe spot': 1,
      travelling: 1, 'fighting from a proven safe spot': 1 });
    assert.equal(report.characters.find(c => c.character === 'Offline').latest_room_sample.health, null);
    assert.equal(report.characters.find(c => c.character === 'Fighting').ready_proxy_wall_samples, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or stale evidence has no reported rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-farm-room-'));
  try {
    for (const source of [dir, join(dir, 'missing')]) {
      const r = run(source);
      assert.equal(r.status, 1);
      const report = JSON.parse(r.stdout);
      assert.equal(report.kills.per_30m, null);
      assert.equal(report.source.recent_evidence, false);
      assert.equal(report.source.exists, source === dir);
    }
    writeDay(dir, '2026-11-08', [kill(-25 * 60_000)]);
    const stale = run(dir);
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).kills.recorded, 1);
    assert.equal(JSON.parse(stale.stdout).kills.per_30m, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
