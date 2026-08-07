#!/usr/bin/env node
// A CAST THAT PRODUCED NOTHING IS NOT A CAST THAT WORKED. Offline, safe any time:
//
//   node tools/m59-spellaudit-test.mjs
//
// Both spells the fleet's supply loop rests on refuse SILENTLY — `create food` without
// 2 ElderBerry and 2 Herbs, `create weapon` below 15 mana. Neither sends an error, so
// the only evidence either way is whether an item appeared, and a keeper that has been
// two herbs short since lunch is indistinguishable from one having a quiet day unless
// the record keeps the OUTCOME and the REFUSAL alongside the attempt.
//
// These tests pin the three things that were easy to get wrong:
//
//   * `worked` must be produced/cast, not a count of casts — the whole point
//   * a spell that was only ever DECLINED still needs a row, with cast: 0, because
//     "the loop never started" and "the loop is failing" are different diagnoses
//   * declines are rate-limited to one line per ten minutes per reason, so their
//     `times_so_far` is a per-keeper running total. Summing the lines multiplies;
//     taking one line drops every character but the last.
//
// Uses M59_LEDGER_DIR against a scratch directory, so it never reads or writes a real
// fleet's history.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-spellaudit-test-'));
process.env.M59_LEDGER_DIR = dir;

const T0 = 1785780000000;                       // a fixed instant; nothing here is "now"
const day = new Date(T0).toISOString().slice(0, 10);

const cast = (character, t, spell, ok, extra = {}) => ({
  t, iso: new Date(t).toISOString(), type: 'event', character, kind: 'cast',
  spell, ok, why: 'the larder is empty', ...extra,
});
const declined = (character, t, spell, why, times) => ({
  t, iso: new Date(t).toISOString(), type: 'event', character, kind: 'cast_declined',
  spell, why, times_so_far: times,
});
// `item_kind`, deliberately not `kind`. `kind` on this record is the EVENT kind, and
// the first version of this helper set it to 'elderberry' — which is exactly what the
// autopilot was doing, so every purchase filed itself as an elderberry event and the
// filter for 'bought' matched nothing at all. See recordEvent.
const bought = (character, t, what, cost, itemKind) => ({
  t, iso: new Date(t).toISOString(), type: 'event', character, kind: 'bought',
  what, cost, item_kind: itemKind,
});

function write(rows) {
  writeFileSync(join(dir, `fleet-${day}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Import AFTER the env var is set: the ledger resolves its directory once, at load.
const { spellReport } = await import('./m59-ledger.mjs');
const WINDOW = { sinceMs: Date.now() - T0 + 3600_000 };

// ---------------------------------------------------------------- the core question

// Kermit casts create food four times. Two produce a meal; two are the silent refusal.
write([
  cast('Kermit', T0 + 1000, 'create food', true, { made: ['a loaf of bread'], mana_cost: 5 }),
  cast('Kermit', T0 + 2000, 'create food', false, { mana_cost: 5 }),
  cast('Kermit', T0 + 3000, 'create food', true, { made: ['a loaf of bread'], mana_cost: 5 }),
  cast('Kermit', T0 + 4000, 'create food', false, { mana_cost: 5 }),
]);
{
  const r = spellReport(WINDOW);
  const f = r.by_spell.find(s => s.spell === 'create food');
  ok('counts every cast', f.cast === 4, 'got ' + f.cast);
  ok('separates the ones that produced something', f.produced === 2, 'got ' + f.produced);
  ok('and the ones that silently did not', f.nothing === 2, 'got ' + f.nothing);
  ok('`worked` is produced over cast, not a count', f.worked === '50%', 'got ' + f.worked);
  ok('mana is summed only from real readings', f.mana_spent === 20, 'got ' + f.mana_spent);
  ok('per-character rollup agrees', r.by_character[0].worked === '50%', 'got ' + r.by_character[0].worked);
}

// The failure this whole file exists to prevent: every cast refused, which a count of
// casts alone reports as a busy, healthy keeper.
write([
  cast('Kermit', T0 + 1000, 'create food', false),
  cast('Kermit', T0 + 2000, 'create food', false),
  cast('Kermit', T0 + 3000, 'create food', false),
]);
{
  const r = spellReport(WINDOW);
  const f = r.by_spell.find(s => s.spell === 'create food');
  ok('a wholly failing loop still shows its casts', f.cast === 3, 'got ' + f.cast);
  ok('but `worked` reports it as 0%', f.worked === '0%', 'got ' + f.worked);
}

// ---------------------------------------------------------------- the refusals

// A spell that was never cast at all, only declined. This row must exist: without it
// the report is silent about the case where the supply loop never started.
write([
  declined('Kermit', T0 + 1000, 'create weapon', 'not enough mana', 5),
  declined('Kermit', T0 + 700_000, 'create weapon', 'not enough mana', 40),
]);
{
  const r = spellReport(WINDOW);
  const w = r.by_spell.find(s => s.spell === 'create weapon');
  ok('a never-cast spell still gets a row', !!w);
  ok('with cast: 0 rather than being absent', w.cast === 0, 'got ' + w?.cast);
  ok('and `worked` is null, not 0%', w.worked === null, 'got ' + w?.worked);
  ok('the reason is carried', r.declined[0].why === 'not enough mana', 'got ' + r.declined[0].why);
  ok('and the count is the keeper\'s running total, not the line count',
     r.declined[0].times === 40, 'got ' + r.declined[0].times);
}

// Two keepers, each with its own running count. Summing the lines would give 3+9+4+11
// = 27; taking the last line would give 11. The answer is 9 + 11 = 20.
write([
  declined('Kermit', T0 + 1000, 'create food', 'not enough reagents', 3),
  declined('Kermit', T0 + 700_000, 'create food', 'not enough reagents', 9),
  declined('Piggy', T0 + 2000, 'create food', 'not enough reagents', 4),
  declined('Piggy', T0 + 800_000, 'create food', 'not enough reagents', 11),
]);
{
  const r = spellReport(WINDOW);
  const d = r.declined.find(x => x.why === 'not enough reagents');
  ok('per-character maximum, then summed across characters', d.times === 20, 'got ' + d.times);
  ok('and it says how many keepers it covers', d.characters === 2, 'got ' + d.characters);
}

// A keeper restart resets its own counter, so a later line can be SMALLER than an
// earlier one. Taking the max per character is what keeps that from being read as a
// keeper that un-declined things.
write([
  declined('Kermit', T0 + 1000, 'create food', 'not enough reagents', 30),
  declined('Kermit', T0 + 700_000, 'create food', 'not enough reagents', 2),
]);
{
  const r = spellReport(WINDOW);
  ok('a restart mid-window does not lose the earlier count',
     r.declined[0].times === 30, 'got ' + r.declined[0].times);
}

// ---------------------------------------------------------------- the money

// The question underneath: is it buying the meal, or the two things it casts the meal
// from? Reagents only is the fleet's intended shape.
write([
  bought('Kermit', T0 + 1000, 'ElderBerry', 12, 'elderberry'),
  bought('Kermit', T0 + 2000, 'Herbs', 8, 'herb'),
  bought('Piggy', T0 + 3000, 'ElderBerry', 12, 'elderberry'),
]);
{
  const r = spellReport(WINDOW);
  ok('total spend is summed', r.purchases.total_spent === 32, 'got ' + r.purchases.total_spent);
  ok('reagent buying is reported as a fact', r.purchases.bought_reagents === true);
  ok('and food buying as its absence', r.purchases.bought_food === false);
  ok('the kinds are broken out', r.purchases.by_kind.find(k => k.kind === 'elderberry').items === 2);
  ok('per-character spend is attributed',
     r.by_character.find(c => c.character === 'Kermit').spent === 20,
     'got ' + r.by_character.find(c => c.character === 'Kermit')?.spent);
}

// THE BUG THAT WROTE THIS TEST. recordEvent spreads its detail over the record, so a
// detail field named `kind` used to replace the event's own — and a purchase carrying
// `kind: 'elderberry'` filed itself as an elderberry event, invisible to everything
// looking for a 'bought'. The write succeeded and the record was silently wrong, which
// is the same failure shape as the emit(kind, data) bug in the client.
{
  const { recordEvent } = await import('./m59-ledger.mjs');
  const rows = [];
  const orig = console.error;
  console.error = () => {};
  try {
    writeFileSync(join(dir, `fleet-${new Date().toISOString().slice(0, 10)}.jsonl`), '');
    recordEvent('Gonzo', 'bought', { what: 'Herbs', cost: 8, kind: 'herb' });
    const { readLedger } = await import('./m59-ledger.mjs');
    rows.push(...readLedger({ sinceMs: 3600_000 }).events);
  } finally { console.error = orig; }
  const mine = rows.filter(e => e.character === 'Gonzo');
  ok('a detail field cannot overwrite the event kind',
     mine.length === 1 && mine[0].kind === 'bought', 'got ' + mine[0]?.kind);
}

// ---------------------------------------------------------------- narrowing

// One character, asked for by name. The other one's casts must not leak in.
write([
  cast('Kermit', T0 + 1000, 'create food', true, { made: ['bread'] }),
  cast('Piggy', T0 + 2000, 'create food', true, { made: ['bread'] }),
  cast('Piggy', T0 + 3000, 'create weapon', false),
]);
{
  const r = spellReport({ ...WINDOW, character: 'Kermit' });
  ok('narrowing to one character keeps only its casts',
     r.by_spell.length === 1 && r.by_spell[0].cast === 1);
  ok('and is case-insensitive about the name',
     spellReport({ ...WINDOW, character: 'kermit' }).by_spell[0].cast === 1);
}

// ------------------------------------------------- the guard, end to end

// A TEST MUST NOT BE ABLE TO WRITE INTO A REAL FLEET'S HISTORY, and the only way to
// check that is from a process that has NOT set M59_LEDGER_DIR — which this one has.
// So: a child, named like a test, pointed at a throwaway fleet rather than at prod.
//
// Pointed at a throwaway fleet ON PURPOSE. A guard test that exercises the failure
// against the real directory would corrupt the record precisely when it is broken,
// which is the one moment it must not. If the guard fails here, a junk directory
// appears and is removed; nothing real is touched either way.
{
  // spawnSync, not execFileSync: the guard REFUSES and exits 0, so the stderr we are
  // asserting on only exists on the success path, which execFileSync does not hand back.
  const { spawnSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const fixture = join(dir, 'm59-guard-test.mjs');       // the name is the point
  // pathToFileURL, not the bare path: on Windows `C:/...` in an import specifier is
  // read as the URL scheme `c:` and throws ERR_UNSUPPORTED_ESM_URL_SCHEME — which
  // would make this test pass for the wrong reason, the child having died before it
  // ever reached the guard.
  writeFileSync(fixture,
    `import { recordEvent } from ${JSON.stringify(pathToFileURL(join(here, 'm59-ledger.mjs')).href)};\n` +
    `recordEvent('Tester', 'cast', { spell: 'create weapon', ok: false });\n`);
  const guardDir = join(here, '..', 'substrate', 'history', 'guardtest');
  const run = spawnSync(process.execPath, [fixture], {
    env: { ...process.env, M59_LEDGER_DIR: '', M59_FLEET: 'guardtest' },
    encoding: 'utf8',
  });
  const stderr = String(run.stderr || '');
  const wrote = existsSync(guardDir);
  ok('a test process cannot write into a fleet history directory', !wrote,
     wrote ? 'it created ' + guardDir : '');
  ok('and it says so on stderr rather than failing silently', /REFUSING to write/.test(stderr),
     JSON.stringify(stderr.slice(0, 120)));
  if (wrote) rmSync(guardDir, { recursive: true, force: true });
}

// An empty window is a real answer, not a crash.
write([{ t: T0, type: 'sample', character: 'Kermit', level: 20 }]);
{
  const r = spellReport(WINDOW);
  ok('no casts at all reports empty rather than throwing', r.by_spell.length === 0);
  ok('and still says nothing can buy food', /SHAREABLE/.test(r.purchases.never_offered_food));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
