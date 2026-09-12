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


// ---------------------------------------------------------------- ok is not "it happened"
//
// THE REAL FAILURE, and it is not a refusal — it is a success that cost nothing. A keeper
// blessing a fleet-mate who is ALREADY blessed gets a free refusal out of CanPayCosts, and
// `recordCast` sets `ok` from the caller's own judgement, which for a buff has nothing to
// diff. Measured on prod 2026-09-12: two Kraanan casters, `worked: 100%`, fourteen blesses
// each in fifteen minutes, mana sitting at 33/33 and 25/25 the whole time.
//
// `mana_cost` is the witness: `mana_before - mana_after`, written only when both readings
// were real and the value went DOWN. A measured zero on a spell that costs mana is proof.
const manaOf = (spell) => ({ bless: 6, 'create food': 5, smite: 0 })[spell];

write([
  // bless costs 6. Two moved mana; two measured zero; one could not be measured at all.
  cast('Camilla', T0 + 1000, 'bless', true, { mana_cost: 6, target: 'Beaker' }),
  cast('Camilla', T0 + 2000, 'bless', true, { mana_cost: 0, target: 'Beaker' }),
  cast('Camilla', T0 + 3000, 'bless', true, { mana_cost: 0, target: 'Beaker' }),
  cast('Camilla', T0 + 4000, 'bless', true, { mana_cost: 2, target: 'Kermit' }),
  cast('Camilla', T0 + 5000, 'bless', true, { target: 'Kermit' }),
]);
{
  const r = spellReport({ ...WINDOW, manaOf });
  const f = r.by_spell.find(s => s.spell === 'bless');
  ok('`worked` still reports what it always did, because callers read it',
     f.worked === '100%', 'got ' + f.worked);
  ok('but only the casts where mana MOVED are landed', f.landed === 2, 'got ' + f.landed);
  ok('a measured zero on a spell that costs mana is `free`, not a cast',
     f.free === 2, 'got ' + f.free);
  ok('and a cast with no reading at all is `unmeasured` — not a pass and not a failure',
     f.unmeasured === 1, 'got ' + f.unmeasured);
  ok('the four buckets account for every cast',
     f.landed + f.free + f.unmeasured + f.nothing === f.cast);
  // THE HEADLINE HAS TO SAY IT. `worked: 100%` beside `landed: 2` is the finding, and an
  // operator should not have to notice the second column to see it.
  ok('a row where the frees outnumber the lands carries a verdict in words',
     /spent no mana at all/.test(f.verdict ?? ''), 'got ' + f.verdict);
  ok('landed_pct is against every cast, so it cannot flatter', f.landed_pct === '40%',
     'got ' + f.landed_pct);
}

// A ZERO IS ONLY DAMNING FOR A SPELL THAT SHOULD HAVE COST SOMETHING. Eighteen of this
// world's spells genuinely cost no mana, and convicting those would invent a fleet-wide
// fault out of correct behaviour.
write([
  cast('Camilla', T0 + 1000, 'smite', true, { mana_cost: 0 }),
  cast('Camilla', T0 + 2000, 'smite', true, { mana_cost: 0 }),
]);
{
  const r = spellReport({ ...WINDOW, manaOf });
  const f = r.by_spell.find(s => s.spell === 'smite');
  ok('a spell that costs no mana is never convicted by a zero', f.free === undefined);
  ok('it is unmeasured instead, which is the honest answer', f.unmeasured === 2,
     'got ' + f.unmeasured);
}

// AND WITHOUT A COST TABLE IT MUST NOT GUESS. A caller that supplies no `manaOf` gets
// `unmeasured`, never `free` — inventing the verdict from a missing lookup would be the
// same class of error as the one this whole section is about.
{
  const r = spellReport(WINDOW);
  const f = r.by_spell.find(s => s.spell === 'smite');
  ok('no manaOf means no verdict, rather than a guessed one',
     f.free === undefined && f.unmeasured === 2, 'got ' + JSON.stringify(f.free));
}

// THE PER-CHARACTER TABLE SORTS BY WHAT LANDED, WORST FIRST. Sorting by attempts puts the
// caster who is achieving nothing at the top for the wrong reason: it looks like the
// busiest character in the fleet.
write([
  cast('Camilla', T0 + 1000, 'bless', true, { mana_cost: 0 }),
  cast('Camilla', T0 + 2000, 'bless', true, { mana_cost: 0 }),
  cast('Camilla', T0 + 3000, 'bless', true, { mana_cost: 0 }),
  cast('Bunsen', T0 + 4000, 'bless', true, { mana_cost: 6 }),
]);
{
  const r = spellReport({ ...WINDOW, manaOf });
  ok('the caster landing nothing is the first row even though it cast the most',
     r.by_character[0].character === 'Camilla' && r.by_character[0].landed === 0,
     'got ' + JSON.stringify(r.by_character.map(c => [c.character, c.landed])));
  ok('and the one that is working is not flagged',
     r.by_character[1].character === 'Bunsen' && r.by_character[1].landed === 1);
}

// The guidance has to name the trap, or the next person reads `worked` and stops.
{
  const r = spellReport(WINDOW);
  ok('read_this_way points at `landed` rather than `worked`',
     /READ `landed`, NOT `worked`/.test(r.read_this_way));
  ok('and warns that mana_spent is a floor, because regeneration masks part of the drain',
     /FLOOR/.test(r.read_this_way));
}


// A FREE CAST MEANS DIFFERENT THINGS FOR DIFFERENT SPELLS, and calling both a refusal reads
// as a fault in the case where the fleet got exactly what it wanted. On a PersonalEnchantment
// a free cast is the target ALREADY HAVING the buff; on a spell that makes an item it is
// nothing coming out. I misread my own first run of m59-spellcast this way inside a minute:
// 14 of 14 super strengths free looked like the reagent delivery had failed, and it meant
// every farmer was already strengthened.
const kindOf = (spell) => ({ bless: 'PersonalEnchantment', 'create food': 'Spell' })[spell];

write([
  cast('Camilla', T0 + 1000, 'bless', true, { mana_cost: 0 }),
  cast('Camilla', T0 + 2000, 'bless', true, { mana_cost: 0 }),
  cast('Camilla', T0 + 3000, 'bless', true, { mana_cost: 6 }),
]);
{
  const r = spellReport({ ...WINDOW, manaOf, kindOf });
  const f = r.by_spell.find(s => s.spell === 'bless');
  ok('an enchantment is told it is already up, not that it refused',
     /ALREADY HAD IT/.test(f.verdict) && !/supply/.test(f.verdict.split('not a supply')[0]),
     'got ' + f.verdict);
  ok('and the cost is named as IMPROVEMENT, which is the thing actually being lost',
     /ability only rolls on a cast that happens/.test(f.verdict));
  ok('it quotes the landed count as the learning rate, not the attempt count',
     /so 1 is the rate it is learning at, not 3/.test(f.verdict), 'got ' + f.verdict);
}

write([
  cast('Kermit', T0 + 1000, 'create food', true, { mana_cost: 0 }),
  cast('Kermit', T0 + 2000, 'create food', true, { mana_cost: 0 }),
]);
{
  const r = spellReport({ ...WINDOW, manaOf, kindOf });
  const f = r.by_spell.find(s => s.spell === 'create food');
  ok('a producing spell is told nothing came out, and where to look',
     /nothing coming out/.test(f.verdict) && /reagents and the pack space/.test(f.verdict),
     'got ' + f.verdict);
}

// WITHOUT `kindOf` IT MUST NOT PICK ONE. The generic wording names both possibilities rather
// than asserting the wrong half.
{
  const r = spellReport({ ...WINDOW, manaOf });
  const f = r.by_spell.find(s => s.spell === 'create food');
  ok('no kind table means a verdict that commits to neither reading',
     /already enchanted, or nothing here needed it/.test(f.verdict), 'got ' + f.verdict);
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

// AN ABSENT HISTORY IS NOT A QUIET FLEET. The ledger resolves its directory from the checkout
// it was loaded in, so a report run from a clone against another checkout's fleet reads a path
// that is not there and used to answer "nothing cast in this window" — confidently, wrongly,
// and with something about to be decided on it.
{
  const r = spellReport(WINDOW);
  ok('every report says which directory it read', typeof r.source?.dir === 'string');
  ok('and whether that directory exists at all', r.source.exists === true);
  ok('and how much it actually read, so an empty answer can be told from an unread one',
     r.source.rows > 0 && r.source.files > 0,
     'got ' + JSON.stringify(r.source));
}
{
  const { readLedger } = await import('./m59-ledger.mjs');
  const r = readLedger({ sinceMs: 1000 });
  ok('readLedger carries the same source, because every caller needs the distinction',
     r.source.dir === process.env.M59_LEDGER_DIR && r.source.exists === true);
  // `rows` counts what was ON DISK; `events` counts what survived the window. They have to be
  // separate numbers, because "the file is empty" and "the window excluded everything" are
  // different diagnoses and only the first is a broken ledger. (An earlier row here is written
  // through recordEvent at the real clock, so a short window keeps some of them — which is
  // exactly why the assertion is a comparison and not a zero.)
  ok('rows counts what was on disk, not what survived the window',
     r.source.rows > r.events.length + r.samples.length,
     `rows ${r.source.rows} events ${r.events.length} samples ${r.samples.length}`);
}

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
