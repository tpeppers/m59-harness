#!/usr/bin/env node
// WHAT AN UNIDENTIFIED ITEM IS, FROM ITS ICON RESOURCE ID. Exact, and it costs no charge and no cast.
//
//   node tools/m59-item-signature.mjs 30479 30440     -> HoldWand, EarthquakeScroll
//   node tools/m59-item-signature.mjs --list wand     every class whose icon is told apart this way
//
// Until it is identified every Wand is called "wand" and every Scroll "scroll" (HideHiddenAttributes
// hides the NAME only), and many share one bitmap: wand6.bgf is the icon of eleven wands, scr08.bgf of
// five scrolls. Colour narrows it (m59-pvp-gear.mjs decodePrimaryColour) but not to one: grey is the
// hold, blind, enfeeble AND swap wand.
//
// THE ICON ID IS NOT THE BITMAP, AND THAT IS THE WHOLE TRICK. blakcomp gives every class its own
// resource for `<Class>_icon_rsc` even when the file is shared -- HoldWand_icon_rsc is 30479 and
// BlindWand_icon_rsc 30476, both "wand6.bgf" (kod/kodbase.txt) -- and the server sends the class's
// vrIcon RESOURCE ID on the wire, which `inventory` already carries as `icon_rsc`. So the id names the
// class, whatever the name and colour say. Measured on prod 2026-10-11: 22 bare "wand"s at 30513
// (LightningWand_icon_rsc, and decoded colour 8 = yellow, the lightning wand's -- the two agree) and
// 27 bare "scroll"s at 30461 (MartyrScroll_icon_rsc, decoded grey, the martyr scroll's).
//
// HOW THE ID IS MAPPED, from what this machine already loads to read names: each kod file compiles to
// its own .rsc (holdw.kod -> holdw.rsc), so an id is found in exactly one resource file, that file
// names its kod file, and compendium/data/koddb.json says which class in that file has an icon whose
// string is the one at that id. A file holding two classes with the same icon string is ambiguous and
// is left out -- never guessed.
//
// WHICH CLASSES THE FLEET CALLS BY WHAT NAME is this machine's, not this file's:
// substrate/item-identification.json (shape: substrate/item-identification.example.json). With no
// such file nothing is renamed -- silence is the old behaviour.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRsc, DEFAULT_RSC_DIRS } from './m59-rsc.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const KODDB_FILE = join(REPO, 'compendium', 'data', 'koddb.json');
export const IDENTIFICATION_FILE = () => process.env.M59_ITEM_IDENTIFICATION_FILE
  || join(REPO, 'substrate', 'item-identification.json');

const lc = s => String(s ?? '').toLowerCase();
const stem = f => lc(basename(String(f ?? ''))).replace(/\.(kod|rsc)$/, '');

/**
 * id -> { class, chain, icon } for every Item class whose icon resource can be told apart.
 * `files` is [{ file, entries: [[id, string], ...] }]; `classes` is koddb's classes object.
 * Pure, so the test can hand it a fixture.
 */
export function buildIconTable(files, classes) {
  const byStem = new Map();
  for (const c of Object.values(classes ?? {})) {
    if (!(c.chain ?? []).includes('Item')) continue;
    const icon = Object.entries(c.resources ?? {}).find(([k, r]) => /_icon_rsc$/i.test(k) && r?.kind === 'file');
    if (!icon) continue;
    const s = stem(c.file);
    byStem.set(s, [...(byStem.get(s) ?? []), { class: c.name, chain: c.chain, icon: lc(icon[1].value) }]);
  }
  const table = new Map();
  for (const { file, entries } of files) {
    const owners = byStem.get(stem(file));
    if (!owners?.length) continue;
    for (const o of owners) {
      // The icon's string must occur once in the file and belong to one class there.
      const ids = entries.filter(([, s]) => lc(s) === o.icon).map(([id]) => id);
      const sharers = owners.filter(x => x.icon === o.icon);
      if (ids.length !== 1 || sharers.length !== 1) continue;
      table.set(ids[0], { class: o.class, chain: o.chain, icon: o.icon });
    }
  }
  return table;
}

let cached = null;
/** The table for this machine: the first resource directory that has .rsc files, and koddb. */
export function iconTable({ dirs = DEFAULT_RSC_DIRS, koddb = KODDB_FILE } = {}) {
  if (cached) return cached;
  let classes = {};
  try { classes = JSON.parse(readFileSync(koddb, 'utf8')).classes ?? {}; } catch { /* no koddb: empty table */ }
  let files = [];
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(d).filter(n => n.toLowerCase().endsWith('.rsc')); } catch { continue; }
    if (!names.length) continue;
    for (const n of names) {
      try { const p = parseRsc(readFileSync(join(d, n))); if (p) files.push({ file: n, entries: p.entries }); } catch { /* skip */ }
    }
    if (files.length) break;
  }
  cached = buildIconTable(files, classes);
  return cached;
}
export function resetIconTable() { cached = null; }

/** The kod class behind an icon resource id, or null. */
export const classOfIcon = (iconRsc, table = iconTable()) => table.get(Number(iconRsc)) ?? null;

/** The private naming: { ClassName: 'what the fleet calls it' }. Missing or unreadable file -> {}. */
export function identificationNames(file = IDENTIFICATION_FILE()) {
  try {
    if (!existsSync(file)) return {};
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(j?.name_unidentified_as ?? {}))
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().toLowerCase();
    return out;
  } catch { return {}; }
}

/**
 * What a pack row should be called: the configured name when its icon proves a configured class AND the
 * wire name is that class's hidden one ("wand", "scroll"); otherwise null. An identified item already
 * carries its own name and is never renamed.
 */
export function identifiedAs(row, { table = iconTable(), names = identificationNames() } = {}) {
  if (!row || row.icon_rsc == null) return null;
  const hit = classOfIcon(row.icon_rsc, table);
  if (!hit) return null;
  const as = names[hit.class];
  if (!as) return null;
  const bare = lc(row.name).trim();
  if (bare === as) return null;
  // Only the generic names an unidentified spell item wears.
  if (!['wand', 'scroll', 'wands', 'scrolls', 'potion', 'potions'].includes(bare)) return null;
  return as;
}

/** The name a script should match on: identified_as when the broker supplied one, else the name. */
export const itemName = row => String(row?.identified_as ?? row?.name ?? '');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const t = iconTable();
  if (args[0] === '--list') {
    const want = lc(args[1] ?? '');
    for (const [id, v] of [...t].sort((a, b) => a[0] - b[0]))
      if (!want || v.chain.some(c => lc(c) === want)) console.log(`${id}\t${v.class}\t${v.icon}`);
  } else {
    for (const a of args) { const v = classOfIcon(a, t); console.log(`${a}\t${v ? `${v.class}\t${v.icon}\t${v.chain.join(' < ')}` : 'unknown'}`); }
    if (!args.length) console.log(`${t.size} icon ids resolve to a class`);
  }
}
