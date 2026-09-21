#!/usr/bin/env node
// A TRACK LOOKUP MUST NOT READ TWO FILES OFF DISK. Offline: no socket, no broker, no fleet.
//
// THE DEFECT, 2026-09-20. `recallTrack(room, from, to, tracks = loadTracks(), strikes =
// loadStrikes())` evaluates both default parameters every time a caller omits them, and the
// broker's only call site omits them. So a crossing lookup — which reads nothing, writes
// nothing and decides one thing — was a synchronous read and a full JSON.parse of two files,
// on the broker's event loop, once per call. A default parameter reads as a fallback and is
// a function call, which is exactly why nobody saw it.
//
// THIS IS NOT THE WEDGE AND THE TEST SAYS SO. The books are 0.18 MB and 0.01 MB; the broker's
// read storm is ~86 MB/s from a caller still unattributed. Fixing this does not close that.
// It is pinned here because it is real, cheap and independently true.
//
// `node tools/m59-trackbook-test.mjs`
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

const root = mkdtempSync(join(tmpdir(), 'm59-trackbook-'));
const tracksFile = join(root, 'tracks.json');
const strikesFile = join(root, 'strikes.json');
writeFileSync(tracksFile, JSON.stringify({ tracks: { '108:?>377': [{ row: 1, col: 1 }] } }));
writeFileSync(strikesFile, JSON.stringify({ strikes: {} }));

const { loadTracks, loadStrikes, recallTrack, strikeTrack, clearStrikes } =
  await import('./m59-tracks.mjs');

// COUNT THE READS RATHER THAN TIME THEM. A timing assertion on a 0.18 MB file is a flake on a
// busy machine; the claim is "it stops going to disk", so count the trips.
const fs = await import('node:fs');
const realRead = fs.default.readFileSync;
let reads = 0;
const countFrom = () => { reads = 0; };
fs.default.readFileSync = function (...args) {
  if (String(args[0]).endsWith('.json')) reads++;
  return realRead.apply(this, args);
};

console.log('--- a repeated lookup reads the books once, not once per call ---');
{
  loadTracks(tracksFile); loadStrikes(strikesFile);     // warm, as the first caller would
  countFrom();
  for (let i = 0; i < 50; i++) {
    loadTracks(tracksFile);
    loadStrikes(strikesFile);
  }
  ok('fifty lookups cause zero re-reads', reads === 0,
     `${reads} read(s) — before this change it was 100`);
}

console.log('\n--- but an edit on disk is still picked up ---');
{
  // Cached on path+mtime+size, the same way loadMap already does it. A cache that cannot see
  // an external edit is a different bug, and a worse one: the fleet would ride a stale book.
  writeFileSync(tracksFile, JSON.stringify({ tracks: { '108:?>377': [{ row: 9, col: 9 }] } }));
  const after = loadTracks(tracksFile);
  ok('a rewritten book is re-read', after['108:?>377']?.[0]?.row === 9,
     JSON.stringify(after['108:?>377']));
}

console.log('\n--- a writer must not edit what every reader is holding ---');
{
  // `strikeTrack` and `clearStrikes` mutate the object `loadStrikes` hands back. Sharing a
  // cached object made that a write into everybody's copy — and if `saveStrikes` then failed
  // (it swallows its own errors) the cache would hold a count that is not on disk.
  const before = loadStrikes(strikesFile);
  strikeTrack(108, null, 377, { file: strikesFile });
  ok('the previously-returned object is unchanged', before['108:?>377'] === undefined,
     `got ${JSON.stringify(before['108:?>377'])}`);
  ok('and the strike really landed on disk',
     JSON.parse(readFileSync(strikesFile, 'utf8')).strikes['108:?>377'] === 1);
  ok('a fresh read sees it', loadStrikes(strikesFile)['108:?>377'] === 1);
}

console.log('\n--- clearing is a read when there is nothing to clear ---');
{
  countFrom();
  const n = clearStrikes(108, null, 999, { file: strikesFile });
  ok('a no-op clear writes nothing and returns 0', n === 0);
  ok('...and does not re-read either', reads === 0, `${reads} read(s)`);
  clearStrikes(108, null, 377, { file: strikesFile });
  ok('a real clear does remove it',
     JSON.parse(readFileSync(strikesFile, 'utf8')).strikes['108:?>377'] === undefined);
}

console.log('\n--- an absent book is still an empty book, not a throw ---');
{
  ok('missing tracks file', JSON.stringify(loadTracks(join(root, 'nope.json'))) === '{}');
  ok('missing strikes file', JSON.stringify(loadStrikes(join(root, 'nope2.json'))) === '{}');
  writeFileSync(join(root, 'torn.json'), '{"tracks": {');
  ok('an unparseable book is empty rather than fatal',
     JSON.stringify(loadTracks(join(root, 'torn.json'))) === '{}');
}

console.log('\n--- recallTrack still answers the same question ---');
{
  writeFileSync(tracksFile, JSON.stringify({ tracks: { '108:?>377': [{ row: 4, col: 4 }] } }));
  const got = recallTrack(108, null, 377, loadTracks(tracksFile), loadStrikes(strikesFile));
  ok('a known crossing returns its track', got?.[0]?.row === 4, JSON.stringify(got));
  ok('an unknown crossing returns null',
     recallTrack(999, null, 1, loadTracks(tracksFile), loadStrikes(strikesFile)) === null);
}

fs.default.readFileSync = realRead;
rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
