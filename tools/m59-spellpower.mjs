#!/usr/bin/env node
// WHAT A CHARACTER'S GEAR DOES TO ITS SPELLPOWER. Kod-derived, offline.
//
//   node tools/m59-spellpower.mjs build     write substrate/m59-spellmods.json from M59_ROOT's kod
//   node tools/m59-spellpower.mjs show      the table, worst first
//
// Spell.GetSpellPower (spell.kod:2066-2246) adds the SUM of GetSpellModifier over every item in use
// (spell.kod:2099-2104); each item answers GetBaseSpellModifier plus its item attributes
// (item.kod:1549-1570). A Kraanan spell halves a NEGATIVE item total. The result is bounded 1..99
// (blakston.khd:2089-2090). Higher spellpower shortens the trance (GetTranceTime: 149% of the
// catalogue time at 1, 51% at 99), trims a point of mana above 40 and another above 80
// (spell.kod:1563-1572), and is handed to CastSpell for each spell's own strength and duration.
//
// WHERE THE NUMBERS COME FROM, which is why this is generated rather than typed in:
//
//   WEAPONS  Weapon.GetBaseSpellModifier (weapon.kod:386): the TYPE sets it, slash -15, thrust -10,
//            bludgeon 0 (WEAPON_SPELL_*, weapon.kod:45-48), and the QUALITY moves it: low +5,
//            high -5, nerudite +5 (weapon.kod:73-75). So an axe is -15, a long sword -10, a mystic
//            sword -15, a scimitar -20, a hammer 0, and a (low-quality) MACE IS +5.
//   BOWS     RangedWeapon overrides it with viSpell_modifier (ranged.kod:209): bow -25, battle bow -30,
//            longbow -20, practice bow -10, nerudite bow 0. A bow takes BOTH hands (ranged.kod:45).
//   ARMOUR   viSpell_modifier: default -25 (armor.kod:30), plate -30, scale -20, nerudite -20,
//            chain -15, leather 0, robes +10. Helmets -5.
//   BY SCHOOL, the overrides below (SPECIAL), cited at each.
//
// Item attributes are not on the wire, so a magic item's extra modifier is unknown and counts as 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, '..', 'substrate', 'm59-spellmods.json');
const M59_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';

export const DISCIPLE_ROBE = /\brobes? of the disciples?\b/i;
export const isDiscipleRobe = (name) => DISCIPLE_ROBE.test(String(name ?? ''));
export const ROBE_SCHOOL_LOOK = /insignia of\s+([A-Za-z'’ ]+?)\s+and will give bonuses/i;
export const normSchool = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, '');

// THE ITEMS WHOSE MODIFIER DEPENDS ON THE SPELL. Keyed by kod class; `at` answers for a spell school.
export const SPECIAL = Object.freeze({
  // robedisc.kod:137-145: bound(4 * piLevel, 0, 20) in its own school (piLevel = the wearer's highest
  // known spell level there, :203-215), 5 otherwise. Its school is only in the look text.
  disciplerobe: { cites: 'robedisc.kod:137', at: (school, o) =>
    o.robeSchool && school && normSchool(o.robeSchool) === normSchool(school)
      ? Math.max(0, Math.min(20, 4 * (Number(o.schoolLevel) || 0))) : 5 },
  // riijaswd.kod:192: +10 for Riija spells (and it mends the sword), -10 for everything else.
  riijasword: { cites: 'riijaswd.kod:192', at: (school) => normSchool(school) === 'riija' ? 10 : -10 },
  // ivycircl.kod:83: Shal'ille +15, Qor -15, else 0.
  ivycirclet: { cites: 'ivycircl.kod:83', at: (school) => ({ shalille: 15, qor: -15 })[normSchool(school)] ?? 0 },
  // orcshld.kod:72: Qor +15, Shal'ille -15, else 0.
  orcshield: { cites: 'orcshld.kod:72', at: (school) => ({ qor: 15, shalille: -15 })[normSchool(school)] ?? 0 },
  // torch.kod:295: Faren +10, else 0.
  torch: { cites: 'torch.kod:295', at: (school) => normSchool(school) === 'faren' ? 10 : 0 },
  // guilshld.kod:564: +10 when the insignia matches the school. The insignia is not read here: 0.
  guildshield: { cites: 'guilshld.kod:564', at: () => 0 },
  // dukeshld.kod:153: 15 * faction rank / 10. The rank is not read here: 0, never overrated.
  dukeshield: { cites: 'dukeshld.kod:153', at: () => 0 },
  // spirhamm.kod:163: conjured and temporary, no penalty.
  spiritualhammer: { cites: 'spirhamm.kod:163', at: () => 0 },
});

// ---------------------------------------------------------------------------------- build
function classVar(text, name) {
  const m = new RegExp('^\\s*' + name + '\\s*=\\s*([-\\w]+)', 'mi').exec(text);
  return m ? m[1] : null;
}
function constants(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(-?\d+)/gm)) out.set(m[1], Number(m[2]));
  return out;
}
/** Compile the table from the kod. Pure: returns the rows. */
export function compile(root = M59_ROOT) {
  const base = path.join(root, 'kod', 'object', 'item');
  const rows = new Map();
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.kod')) continue;
      const t = fs.readFileSync(full, 'latin1');
      const head = /^(\w+)\s+is\s+(\w+)/m.exec(t);
      if (!head) continue;
      const nameRes = /vrName\s*=\s*(\w+)/.exec(t);
      const lit = nameRes ? new RegExp('^\\s*' + nameRes[1] + '\\s*=\\s*"([^"]*)"', 'mi').exec(t) : null;
      rows.set(head[1].toLowerCase(), { cls: head[1].toLowerCase(), parent: head[2].toLowerCase(),
        name: lit ? lit[1] : null, file: path.relative(root, full).split(path.sep).join('/'),
        sm: classVar(t, 'viSpell_modifier'), wt: classVar(t, 'viWeaponType'), wq: classVar(t, 'viWeaponQuality'),
        hands: classVar(t, 'viUse_amount'), override: /^\s*GetBaseSpellModifier\s*\(/m.test(t), text: t });
    }
  };
  walk(base);
  const weaponK = constants(rows.get('weapon')?.text ?? '');
  const chain = (c) => { const out = [], seen = new Set(); while (rows.has(c) && !seen.has(c)) { seen.add(c); out.push(c); c = rows.get(c).parent; } return out; };
  const up = (c, k) => { for (const x of chain(c)) if (rows.get(x)[k] != null) return rows.get(x)[k]; return null; };
  const num = (v) => (v == null ? null : /^-?\d+$/.test(v) ? Number(v) : weaponK.get(v) ?? null);
  const typeMod = { WEAPON_TYPE_SLASH: 'WEAPON_SPELL_LOW', WEAPON_TYPE_THRUST: 'WEAPON_SPELL_MID', WEAPON_TYPE_BLUDGEON: 'WEAPON_SPELL_HIGH' };
  const qualMod = { WEAPON_QUALITY_LOW: 'WEAPON_LOW_QUALITY_SPELL', WEAPON_QUALITY_HIGH: 'WEAPON_HIGH_QUALITY_SPELL', WEAPON_NERUDITE: 'WEAPON_NERUDITE_SPELL' };
  const out = [];
  for (const [cls, r] of rows) {
    if (!r.name) continue;
    const ch = chain(cls);
    const slot = ch.includes('weapon') ? 'weapon' : ch.includes('shield') ? 'shield'
      : ch.includes('armor') ? 'armour' : ch.includes('helmet') ? 'helm' : null;
    if (!slot) continue;
    const owner = ch.find(x => rows.get(x).override) ?? null;     // whose GetBaseSpellModifier answers
    let mod, how;
    if (SPECIAL[owner]) { mod = null; how = `by school (${SPECIAL[owner].cites})`; }
    else if (owner === 'weapon') {
      const wt = up(cls, 'wt'), wq = up(cls, 'wq');
      mod = (weaponK.get(typeMod[wt]) ?? 0) + (weaponK.get(qualMod[wq]) ?? 0);
      how = `${wt} ${wq} (weapon.kod:386)`;
    } else {
      mod = num(up(cls, 'sm')) ?? 0;
      how = owner ? `viSpell_modifier via ${owner}` : 'viSpell_modifier';
    }
    out.push({ name: r.name, cls, slot, hands: slot === 'weapon' ? (num(up(cls, 'hands')) ?? 1) : slot === 'shield' ? 1 : 0,
               mod, special: SPECIAL[owner] ? owner : null, how, file: r.file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// -------------------------------------------------------------------------------- runtime
let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  try { TABLE = JSON.parse(fs.readFileSync(OUT, 'utf8')).items ?? []; }
  catch { TABLE = []; }
  TABLE = TABLE.map(r => ({ ...r, lower: String(r.name).toLowerCase() }));
  return TABLE;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROW_CACHE = new Map();
/** The table row an item name falls under (longest whole-word match), or null. */
export function itemRow(name) {
  const n = String(name ?? '').toLowerCase().trim();
  if (!n) return null;
  if (ROW_CACHE.has(n)) return ROW_CACHE.get(n);
  let best = null;
  for (const r of table()) {
    if (r.lower === n) { best = r; break; }
    if (new RegExp('\\b' + esc(r.lower) + '\\b').test(n) && (!best || r.lower.length > best.lower.length)) best = r;
  }
  if (!best && isDiscipleRobe(n)) best = table().find(r => r.cls === 'disciplerobe') ?? { name: 'robes of the disciple', cls: 'disciplerobe', slot: 'armour', hands: 0, mod: null, special: 'disciplerobe' };
  ROW_CACHE.set(n, best);
  return best;
}

/**
 * One item's spellpower modifier for one spell.
 *   spellSchool    the spell's school name (catalogue `school_name`)
 *   robeSchool     a disciple robe's school, when known from its look text; null when unknown
 *   schoolLevel    the wearer's highest known spell level in the robe's school
 * Unknown school-dependent facts answer the WORSE case, so nothing overrates an item.
 */
export function itemSpellModifier(name, { spellSchool = null, robeSchool = null, schoolLevel = 0 } = {}) {
  const r = itemRow(name);
  if (!r) return 0;
  if (r.special) return SPECIAL[r.special]?.at(spellSchool, { robeSchool, schoolLevel }) ?? 0;
  return Number(r.mod) || 0;
}
/** 'weapon' | 'shield' | 'armour' | 'helm' | null, and how many hands. */
export const itemSlot = (name) => itemRow(name)?.slot ?? null;
export const itemHands = (name) => itemRow(name)?.hands ?? 0;

/** The sum over worn items, with the Kraanan halving of a negative total. */
export function gearSpellModifier(names, opts = {}) {
  let total = 0;
  for (const n of names ?? []) total += itemSpellModifier(n, { ...opts, robeSchool: opts.robeSchoolOf?.(n) ?? opts.robeSchool ?? null });
  if (total < 0 && normSchool(opts.spellSchool) === 'kraanan') total = Math.trunc(total / 2);
  return total;
}

/** A robe's school, read from its look text, or null. */
export function robeSchoolFromLook(description) {
  const m = ROBE_SCHOOL_LOOK.exec(String(description ?? ''));
  return m ? m[1].trim() : null;
}

// ------------------------------------------------------------------------------------ cli
if (import.meta.filename === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    const items = compile();
    if (!items.length) { console.error(`no items compiled from ${M59_ROOT}/kod — set M59_ROOT`); process.exit(2); }
    fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: 'kod/object/item', items }, null, 1));
    console.log(`wrote ${OUT}: ${items.length} wearable items`);
  } else {
    for (const r of table().slice().sort((a, b) => (a.mod ?? 0) - (b.mod ?? 0)))
      console.log(`${String(r.mod ?? 'school').padStart(7)}  ${r.slot.padEnd(6)} ${r.hands === 2 ? '2h' : '  '} ${r.name}  — ${r.how}`);
  }
}
