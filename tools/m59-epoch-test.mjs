#!/usr/bin/env node
// THE CODE EPOCH, AND THE TWO LEDGERS KEYED ON IT.
//
//   node tools/m59-epoch-test.mjs
//
// Offline. Opens no socket, touches no roster, and writes only under a temp directory.
//
// WHAT THIS IS GUARDING. The mechanism's whole job is to throw evidence away, so every way
// it can be wrong is expensive in one direction or the other: too eager and a fortnight of
// good measurement disappears, too shy and a solved problem goes on being the top of the
// report. The three answers matter more than the two — `null` means "this checkout cannot
// say", and a caller that reads it as "stale" deletes the ledger on every clone that has
// no `.git`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (detail ? '  ' + detail : '')); }
};
const section = t => console.log('\n' + t);

const { epochFor, epochId, sameEpoch, DOMAINS } = await import('./m59-epoch.mjs');

section('THE EPOCH ITSELF');
const now = epochFor('movement');
ok('this checkout can name its movement epoch',
   typeof now.id === 'string' && now.id.length >= 12, JSON.stringify(now));
ok('and says which commit declared it', !!now.ref, JSON.stringify(now));
ok('a dirty working tree gets its own id, suffixed by the content of the owned files',
   !now.dirty || /^[0-9a-f]{12}\+[0-9a-f]{8}$/.test(now.id), JSON.stringify(now));
ok('a clean tree is just the ref', now.dirty || /^[0-9a-f]{12}$/.test(now.id), JSON.stringify(now));
ok('the movement domain owns the mover, the collision model and the route table',
   ['tools/m59-game.mjs', 'tools/m59-roo.mjs', 'tools/m59-routes.mjs', 'tools/m59-world.mjs']
     .every(f => DOMAINS.movement.files.includes(f)));
ok('the tag is the thing a commit message carries', DOMAINS.movement.tag === '#movement');

const unknown = epochFor('no-such-domain');
ok('an unknown domain cannot say, and says why', unknown.id === null && !!unknown.why,
   JSON.stringify(unknown));

section('THREE ANSWERS, NOT TWO');
ok('a row from this epoch is current', sameEpoch(epochId('movement'), 'movement') === true);
ok('a row from another epoch is superseded', sameEpoch('0000000000aa', 'movement') === false);
ok('a row with NO epoch answers "cannot say", never "stale"',
   sameEpoch(null, 'movement') === null);
ok('and so does a domain nothing can answer for',
   sameEpoch('anything', 'no-such-domain') === null);

section('THE EXIT-GAP BOOK RESETS ON A CODE CHANGE, NOT ON A CLOCK');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
  process.env.M59_EXITGAP_FILE = path.join(dir, 'exit-gaps.json');
  const { noteRefused } = await import('./m59-exitgap.mjs');
  const read = k => JSON.parse(fs.readFileSync(process.env.M59_EXITGAP_FILE, 'utf8')).gaps[k];
  const day = 864e5, t0 = Date.now();

  // Ukgoth's north door, as it actually read: 182 refusals under code that has since changed.
  for (let i = 0; i < 182; i++) noteRefused(599, 'north', { believed: { col: 27, row: 1 }, at: t0 - 5 * day });
  const before = read('599:north');
  ok('the book counts refusals while the code is unchanged', before.refused === 182);

  // Rewrite the row's epoch to a superseded one, then touch it again.
  const raw = JSON.parse(fs.readFileSync(process.env.M59_EXITGAP_FILE, 'utf8'));
  raw.gaps['599:north'].epoch = '0000000000aa';
  fs.writeFileSync(process.env.M59_EXITGAP_FILE, JSON.stringify(raw));
  noteRefused(599, 'north', { believed: { col: 27, row: 1 }, at: t0 });
  const after = read('599:north');
  ok('a refusal from superseded movement code does not carry over', after.refused === 1,
     JSON.stringify(after));
  ok('it says the CODE changed, not that the doorway went quiet',
     after.reset_because === 'movement code changed', JSON.stringify(after));
  ok('and keeps the history as history — first sighting and the old count',
     after.first === t0 - 5 * day && after.previously_refused === 182, JSON.stringify(after));

  // THE POINT OF THE WHOLE EXERCISE: age alone must not reset a row whose code still stands.
  for (let i = 0; i < 40; i++) noteRefused(577, 'east', { at: t0 - 14 * day });
  const ancient = read('577:east');
  ok('a fortnight-old row from the CURRENT epoch is kept — the clock does not overrule the commit',
     ancient.refused === 40 && !ancient.reset_because, JSON.stringify(ancient));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.M59_EXITGAP_FILE;
}

section('THE TACTICS LEDGER TRIMS BY EPOCH, AND BY THE CLOCK ONLY WHERE IT MUST');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-'));
  process.env.M59_TACTICS_DIR = dir;
  const { trimTactics, tacticsFile } = await import('./m59-tactics.mjs');
  const file = tacticsFile('t');
  const day = 864e5, t0 = Date.now();
  const mine = epochId('movement');
  fs.writeFileSync(file, [
    // Current epoch, and ancient. Must survive: the code it measures is the code in play.
    JSON.stringify({ t: t0 - 30 * day, epoch: mine, tactic: 'current-but-ancient' }),
    // Superseded epoch, and recorded seconds ago. Must go: no window makes it relevant.
    JSON.stringify({ t: t0 - 1000, epoch: '0000000000aa', tactic: 'fresh-but-superseded' }),
    // No epoch at all — written before this existed. The clock rules on these alone.
    JSON.stringify({ t: t0 - 30 * day, tactic: 'no-epoch-ancient' }),
    JSON.stringify({ t: t0 - 1000, tactic: 'no-epoch-fresh' }),
    'a torn last write',
  ].join('\n') + '\n');

  trimTactics('t', { force: true });
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l).tactic);
  ok('a row from the current epoch survives any age',
     kept.includes('current-but-ancient'), JSON.stringify(kept));
  ok('a row from superseded code is dropped however recent it is',
     !kept.includes('fresh-but-superseded'), JSON.stringify(kept));
  ok('an epoch-less row is still judged by the clock',
     !kept.includes('no-epoch-ancient') && kept.includes('no-epoch-fresh'), JSON.stringify(kept));
  ok('and a torn write is dropped rather than kept for ever', kept.length === 2, JSON.stringify(kept));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.M59_TACTICS_DIR;
}

section('A TRIM THAT DROPS NOTHING DOES NOT RUN AGAIN ON THE NEXT FLUSH');
{
  // 2026-09-24: a 171 MB all-current-epoch ledger was re-read and re-parsed on EVERY flush in
  // every keeper — 5 GB/min of allocation each, and the reason 47 keepers ran a 64 GB box dry.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tac2-'));
  process.env.M59_TACTICS_DIR = dir;
  process.env.M59_TACTICS_TRIM_BYTES = '1000';
  const { trimTactics, tacticsFile } = await import('./m59-tactics.mjs?throttle');
  const file = tacticsFile('u');
  const mine = epochId('movement');
  const rows = n => Array.from({ length: n }, (_, i) => JSON.stringify({ t: Date.now(), epoch: mine, tactic: 'x' + i })).join('\n') + '\n';
  fs.writeFileSync(file, rows(200));
  ok('the first look over the threshold drops nothing from a current-epoch ledger', trimTactics('u') === 0);
  // Poison the file: if the next call reads it, the torn line gets dropped and the file changes.
  fs.appendFileSync(file, 'a torn write\n');
  const before = fs.readFileSync(file, 'utf8');
  trimTactics('u');
  ok('and the next flush does NOT re-read it', fs.readFileSync(file, 'utf8') === before);
  ok('force still trims regardless of the throttle', trimTactics('u', { force: true }) === 1);
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.M59_TACTICS_DIR;
  delete process.env.M59_TACTICS_TRIM_BYTES;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
