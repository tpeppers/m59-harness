#!/usr/bin/env node
// EVERY ITEM NAME THIS MACHINE HAS WRITTEN DOWN, CHECKED AGAINST THE GAME'S OWN TABLE.
//
//   node tools/m59-itemcheck.mjs            # report, exit 1 if anything is unresolvable
//   node tools/m59-itemcheck.mjs --warn     # report, always exit 0
//   node tools/m59-itemcheck.mjs --strict   # ALSO fail on names that resolve but are not
//                                           # spelled canonically (herbs -> herb)
//
// A WRONG ITEM NAME IS THE QUIETEST FAULT IN THIS REPOSITORY, because it is not rejected
// where it is written — it is rejected where it is USED, and it takes everything around it
// with it. One unresolvable entry rejects the WHOLE autopilot order: on 2026-09-10 the single
// name "magic wand" (the item is "wand") threw away every station change, hunt list and
// weapon ban computed for sixteen of twenty-one characters, all night. The symptom was bans
// that were visibly correct in the orders and never reached a single hand.
//
// AND THE NEAR MISS IS WORSE THAN THE MISS, because nothing fails at all. `herb` and `herbs`
// BOTH resolve — `itemNameKey` folds the plural — so substrate/loadouts/ currently holds
// eighteen files saying `herb` and one saying `herbs` for the same item, and every one of
// them works. What does not work is a reader, or a tally keyed on the string: a fleet row
// keyed `herbs` against a loadout saying `herb` reads undefined -> 0 on all twenty-one rows
// and looks exactly like a fleet with no reagents. That is why `--strict` exists.
//
// This checks the FILES, not the fleet: it opens no socket and needs no broker.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItemName } from './m59-items.mjs';

const SUBSTRATE = fileURLToPath(new URL('../substrate/', import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

// WHERE A NAME CAN BE WRITTEN. Each source says how to pull item names out of its own shape,
// because a loadout, a guild plan and a policy all spell "a list of items" differently and
// guessing generically is how half of them get skipped in silence.
const SOURCES = [
  { what: 'loadout', dir: join(SUBSTRATE, 'loadouts'), each: (j) => [
      ...(j.carry ?? []).map(r => ({ name: r.item, at: 'carry' })),
      ...(j.vault ?? []).map(r => ({ name: r.item ?? r, at: 'vault' })),
      ...(j.protect ?? []).map(r => ({ name: r.item ?? r, at: 'protect' })),
      ...(j.banned_weapons ?? j.bannedWeapons ?? []).map(r => ({ name: r, at: 'banned_weapons' })),
    ] },
  { what: 'guild-plan', file: join(SUBSTRATE, 'guild-plan.json'), each: (j) => {
      const out = [];
      for (const [slot, block] of Object.entries(j.chests ?? {})) {
        // A slot is an OBJECT carrying an items list, not the list itself. Guessing the
        // shape is how a whole source gets skipped in silence, which is the failure this
        // tool exists to catch -- so it reads the real one.
        const items = Array.isArray(block) ? block : (block?.items ?? []);
        for (const row of items) out.push({ name: row?.item ?? row, at: `chest ${slot}` });
      }
      return out;
    } },
];

const rows = [];
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

for (const src of SOURCES) {
  const files = src.dir
    ? (existsSync(src.dir) ? readdirSync(src.dir).filter(f => f.endsWith('.json'))
                                                 .map(f => join(src.dir, f)) : [])
    : (existsSync(src.file) ? [src.file] : []);
  for (const file of files) {
    const j = readJson(file);
    if (!j) { rows.push({ file, what: src.what, at: '-', name: '(file)', ok: false,
                          why: 'could not be parsed', suggestions: [] }); continue; }
    for (const { name, at } of src.each(j)) {
      if (name == null || name === '') continue;
      rows.push({ file: file.replace(SUBSTRATE, ''), what: src.what, at, ...checkItemName(name) });
    }
  }
}

const bad = rows.filter(r => !r.ok);
const renamed = rows.filter(r => r.ok && r.renamed);

if (!rows.length) {
  console.log('no item names found under substrate/ — nothing to check');
  process.exit(0);
}

console.log(`checked ${rows.length} item name(s) across ${new Set(rows.map(r => r.file)).size} file(s)\n`);

if (bad.length) {
  console.log(`${bad.length} DO NOT RESOLVE — these reject the whole order they appear in:`);
  for (const r of bad)
    console.log(`  ${r.file} [${r.at}] "${r.name}"` +
                (r.suggestions?.length ? `  — did you mean ${r.suggestions.map(s => `"${s}"`).join(', ')}?`
                                       : '  — nothing close enough to suggest'));
  console.log('');
}

if (renamed.length) {
  // Grouped, because the interesting fact is never one file — it is that a directory
  // disagrees with itself about what one item is called.
  const byItem = new Map();
  for (const r of renamed) {
    const row = byItem.get(r.canonical) ?? { canonical: r.canonical, spellings: new Map() };
    row.spellings.set(r.name, (row.spellings.get(r.name) ?? 0) + 1);
    byItem.set(r.canonical, row);
  }
  console.log(`${renamed.length} resolve but are NOT spelled the canonical way:`);
  for (const [canonical, row] of byItem)
    console.log(`  "${canonical}" is also written as ` +
                [...row.spellings].map(([s, n]) => `"${s}" (${n}x)`).join(', ') +
                ` — both work, but a tally keyed on the string does not`);
  console.log('');
}

if (!bad.length && !renamed.length) console.log('every item name resolves, and every one is canonical.');
else if (!bad.length) console.log('every item name resolves.');

const failing = bad.length || (has('--strict') && renamed.length);
process.exit(has('--warn') ? 0 : (failing ? 1 : 0));
