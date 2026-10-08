// The /players page off the event loop, and the history reads that made it slow. Offline: a temp
// M59_INTEL_DIR, no socket, no roster.
//
//   node tools/m59-players-worker-test.mjs
//
// What it pins (2026-10-08: one /players render blocked the prod broker ~100 s, every two minutes):
//   * readHistory extends a cached file from its tail: an append is seen, a half-written last line is
//     NOT (until it is finished), and a file that shrank is read again from the start;
//   * followingDetection on the compact index answers exactly what the old full-read version answered,
//     on random data, both with a name and with an array for the fleet side;
//   * the worker renders the page, concurrent requests share one render, and a finished page is reused;
//   * the broker's /players route awaits the worker and no longer imports renderPlayers at all.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'm59-players-'));
process.env.M59_INTEL_DIR = dir;
mkdirSync(join(dir, 'player-history'), { recursive: true });
const intel = await import('./m59-intel.mjs');
const file = n => join(dir, 'player-history', `${n.replace(/[^a-zA-Z0-9_\-. ]/g, '_')}.jsonl`);
const line = r => JSON.stringify(r) + '\n';

let tests = 0;
const test = async (name, fn) => { await fn(); tests++; console.log(`ok ${name}`); };

try {
  await test('readHistory: newest first, then an append is seen without re-reading the start', () => {
    writeFileSync(file('Ann'), line({ room: 1, at: 1 }) + line({ room: 2, at: 2 }));
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [2, 1]);
    appendFileSync(file('Ann'), line({ room: 3, at: 3 }));
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [3, 2, 1]);
  });

  await test('readHistory: a half-written last line waits until it is finished', () => {
    appendFileSync(file('Ann'), '{"room":4,"at":4');
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [3, 2, 1]);
    appendFileSync(file('Ann'), '}\n');
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [4, 3, 2, 1]);
  });

  await test('readHistory: a file that shrank is read again from the start', () => {
    writeFileSync(file('Ann'), line({ room: 9, at: 9 }));
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [9]);
  });

  await test('readHistory: each call returns a fresh array (callers may not corrupt the cache)', () => {
    const a = intel.readHistory('Ann'); a.push({ at: 99 });
    assert.deepEqual(intel.readHistory('Ann').map(r => r.at), [9]);
    assert.deepEqual(intel.readHistory('Nobody'), []);
  });

  // The algorithm as it was before the compact index, kept here as the reference.
  const reference = (player, fleet) => {
    const by = {};
    for (const r of player) if (r.room != null && r.at != null) (by[r.room] ??= []).push(r.at);
    for (const k of Object.keys(by)) by[k].sort((a, b) => a - b);
    let matches = 0; const evidence = [];
    for (const f of fleet) {
      if (f.room == null || f.at == null) continue;
      const hit = (by[f.room] ?? []).find(t => Math.abs(t - f.at) <= 60_000);
      if (hit != null) { matches++; if (evidence.length < 10) evidence.push({ at: hit, room: f.room, fleet_at: f.at }); }
    }
    const fleet_moves = fleet.filter(f => f.room != null && f.at != null).length;
    const confidence = fleet_moves > 0 ? matches / fleet_moves : 0;
    return { following: confidence > 0.3 && matches >= 3, confidence: Number(confidence.toFixed(3)), matches, fleet_moves, evidence };
  };
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const trail = (n, t0) => Array.from({ length: n }, (_, i) => ({ room: 500 + rnd(6), at: t0 + i * 45_000 + rnd(30_000) }));

  await test('followingDetection: the compact index answers what the full read did (random trails)', () => {
    for (let k = 0; k < 20; k++) {
      const p = trail(80 + rnd(80), 1_000_000), f = trail(60 + rnd(60), 1_000_000);
      writeFileSync(file(`P${k}`), p.map(line).join(''));
      writeFileSync(file(`F${k}`), f.map(line).join(''));
      // On disk the files are oldest first; readHistory and the old code walked them newest first.
      const want = reference([...p].reverse(), [...f].reverse());
      assert.deepEqual(intel.followingDetection(`P${k}`, `F${k}`), want, `trail ${k} by name`);
      assert.deepEqual(intel.followingDetection(`P${k}`, [...f].reverse()), want, `trail ${k} by array`);
    }
  });

  await test('followingDetection: the index follows an append (and a follower is found)', () => {
    const f = Array.from({ length: 10 }, (_, i) => ({ room: 600 + i, at: 5_000_000 + i * 120_000 }));
    writeFileSync(file('Fleet'), f.map(line).join(''));
    writeFileSync(file('Shadow'), '');
    assert.equal(intel.followingDetection('Shadow', 'Fleet').matches, 0);
    appendFileSync(file('Shadow'), f.map(r => line({ room: r.room, at: r.at + 20_000 })).join(''));
    const r = intel.followingDetection('Shadow', 'Fleet');
    assert.equal(r.matches, 10); assert.equal(r.following, true);
  });

  await test('worker: renders the page, shares one render between concurrent requests, reuses it', async () => {
    const { renderPlayersOffThread } = await import('./m59-players-worker.mjs');
    const a = renderPlayersOffThread(), b = renderPlayersOffThread();
    assert.equal(a, b, 'a second request while one runs gets the same promise');
    const html = await a;
    assert.match(html, /<html|<!doctype/i);
    assert.equal(await renderPlayersOffThread(), html, 'reused inside the cache window');
  });

  await test('broker: /players awaits the worker and does not import renderPlayers', () => {
    const src = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
    assert.match(src, /import \{ renderPlayersOffThread \} from '\.\/m59-players-worker\.mjs';/);
    assert.doesNotMatch(src, /\brenderPlayers\(/);
    const at = src.indexOf("url.pathname === '/players'");
    assert.match(src.slice(at, at + 900), /renderPlayersOffThread\(\)\.then\(/);
  });
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${tests} passed, 0 failed`);
process.exit(0);
