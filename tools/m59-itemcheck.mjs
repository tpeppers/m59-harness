#!/usr/bin/env node
// EVERY ITEM NAME THIS MACHINE HAS WRITTEN DOWN, CHECKED AGAINST THE GAME'S OWN TABLE.
//
//   node tools/m59-itemcheck.mjs            # report, exit 1 if anything is unresolvable
//   node tools/m59-itemcheck.mjs --warn     # report, always exit 0
//   node tools/m59-itemcheck.mjs --strict   # ALSO fail on names that resolve but are not
//                                           # spelled canonically (herbs -> herb)
//   node tools/m59-itemcheck.mjs --fix      # rewrite ONLY the unambiguous repairs, in place
//
// `--fix` APPLIES REPAIRS, NEVER SUGGESTIONS, and the difference is the whole safety of it.
// A suggestion is ranked by nearness and its top answer for "gold shield" is "gold sword" — a
// different item. A repair is offered only when the two names are the SAME WORDS once filler
// is dropped ("heat scroll" -> "scroll of heat") or identical without spacing ("yrxlsap" ->
// "yrxl sap"), and never when two items could both match. Everything else is left exactly as
// it is and printed, because what the operator MEANT is not something this can know. A name
// that visibly fails is better than a name quietly changed to the wrong item.
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
// THE TABLE IS NOT THE GAME, AND THIS TOOL CANNOT SEE THE DIFFERENCE.
//
// substrate/m59-items.json holds 249 items and the kod holds more. The clearest gap is
// potions: the table carries THREE (brown, mysterious, potion of forgetfulness) while
// object/item/passitem/spelitem/potion/ has TWENTY-NINE classes. The missing twenty-six are
// made by players with the Distil spell rather than dropped by monsters, so nothing has ever
// observed one and written it down -- and unidentified ones carry a fake name until
// identified anyway (DenialPotion_fake_name_rsc).
//
// So "does not resolve" means "not in the local table", NEVER "not in the game". A real
// haste potion reported here is a gap in the table, not a typo in the config. Do not rename
// one to something that does resolve: that would trade a name nothing can match for a name
// matching the WRONG item, which is the only outcome worse than the original.
//
// This checks the FILES, not the fleet: it opens no socket and needs no broker.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkItemName, repairItemName } from './m59-items.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
// WHICH substrate. Config is per-checkout and machine-local, so the one that matters is not
// always the one beside this file — the fleet reads prod-deploy's while development happens
// elsewhere, and they are different files with different contents.
const flag = (f, fallback) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
// Normalised to this platform's separators: a flag typed with forward slashes must strip
// from paths built with backslashes, or every file silently fails to be found again.
const SUBSTRATE = resolve(flag('--substrate',
  fileURLToPath(new URL('../substrate/', import.meta.url)))) + sep;

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

// A rewrite walks the SAME parsed object the check walked, so the two can never disagree
// about which strings are item names — the alternative is a regex over the file, which would
// happily rewrite a name inside a `why` note or a character's own name.
function rewriteNames(node, repair, log) {
  if (Array.isArray(node)) { for (const v of node) rewriteNames(v, repair, log); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'item' && typeof v === 'string') {
      const r = repair(v);
      if (r) { node[k] = r.to; log.push({ from: v, to: r.to, confidence: r.confidence }); }
    } else rewriteNames(v, repair, log);
  }
}

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

if (has('--fix')) {
  const files = [...new Set(bad.map(r => r.file))];
  let fixed = 0, left = 0;
  for (const rel of files) {
    const full = join(SUBSTRATE, rel);
    const j = readJson(full);
    if (!j) { console.log(`  ${rel}: could not be parsed, left alone`); continue; }
    const log = [];
    rewriteNames(j, (name) => {
      const c = checkItemName(name);
      return c.ok ? null : repairItemName(name);
    }, log);
    if (log.length) {
      // The backup is not optional: this rewrites a file the fleet reads, and the previous
      // contents are the only record of what was asked for before anyone guessed.
      const backup = `${full}.before-itemfix-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      if (!existsSync(backup)) writeFileSync(backup, readFileSync(full));
      writeFileSync(full, JSON.stringify(j, null, 2) + '\n');
      console.log(`\n${rel}: ${log.length} repaired (backup ${backup.replace(SUBSTRATE, '')})`);
      for (const e of log) console.log(`  "${e.from}" -> "${e.to}"  [${e.confidence}]`);
      fixed += log.length;
    }
  }
  left = bad.length - fixed;
  console.log(`\n${fixed} repaired, ${left} left alone — those need a person, not a rule.`);
  if (left) {
    console.log('still unresolved:');
    for (const r of bad) {
      const c = checkItemName(r.name);
      if (!c.ok && !repairItemName(r.name))
        console.log(`  ${r.file} [${r.at}] "${r.name}"` +
          (r.suggestions?.length ? `  — candidates: ${r.suggestions.map(x => `"${x}"`).join(', ')}` : ''));
    }
  }
  process.exit(0);
}

const failing = bad.length || (has('--strict') && renamed.length);
process.exit(has('--warn') ? 0 : (failing ? 1 : 0));
