#!/usr/bin/env node
// What a spell costs, what it needs, and whether this character may cast it at all.
//
//   node tools/m59-spells.mjs build          write substrate/m59-spells.json
//   node tools/m59-spells.mjs show <name>
//   node tools/m59-spells.mjs castable <karma> [--school qor]
//   node tools/m59-spells.mjs reagents <name>
//
// NONE of this is on the wire. BP_SPELLS gives an object plus two bytes — how many
// targets the spell takes and which school it belongs to (module/merintr/merintr.c
// ExtractNewSpell). Mana cost, reagents, spell level and the karma requirement are
// declared in kod and never sent. A caster that only reads the protocol knows the
// name of a spell and nothing about whether it can afford it.
//
// So the catalogue is compiled from the source, where all four are plain class
// variables:
//
//   viSpell_num     the SID_ number, which is what BP_REQ_CAST sends
//   viSchool        SS_SHALILLE, SS_QOR, SS_KRAANAN, SS_FAREN, SS_RIIJA, SS_JALA
//   viSpell_level   1..6ish, and the thing karma scales against
//   viMana          mana per cast
//   ResetReagents() Cons([&Class, count], ...) — the physical ingredients consumed
//
// KARMA is the part that surprises people, and it is not stored anywhere: it is
// DERIVED from school and level (Spell.GetRequiredKarma, spell.kod:482).
//
//   SS_QOR       requires karma <= level * -10      (you must be that evil)
//   SS_SHALILLE  requires karma >= level * +10      (you must be that good)
//   everything else has no karma requirement
//
// and KarmaCheck (spell.kod:456) refuses the cast when you are on the wrong side of
// the line. Karma runs -100..+100 in natural units (GetKarma returns piKarma/100,
// clamped to +/-10000 in hundredths), so a level-6 Qor spell needs karma at or below
// -60 — more than half way to the floor. The consequence worth understanding before
// building a character: the two schools pull in opposite directions, and a caster who
// wants deep Qor spells cannot also hold the karma for deep Shal'ille ones. Killing
// shifts karma by the negative of the victim's karma, so what you fight is what you
// become.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const M59_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';
const HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.M59_SPELLS || path.join(here, '..', 'substrate', 'm59-spells.json');

// kod/include/blakston.khd:2027
export const SCHOOLS = {
  '-1': 'inaccessible', 0: 'none', 1: 'Shal\u2019ille', 2: 'Qor', 3: 'Kraanan',
  4: 'Faren', 5: 'Riija', 6: 'Jala', 7: 'DM command',
};
export const SS = { SHALILLE: 1, QOR: 2, KRAANAN: 3, FAREN: 4, RIIJA: 5, JALA: 6, DM: 7 };

// Spell.GetRequiredKarma, spell.kod:482. Positive means "you must be at least this
// good"; negative means "at least this evil"; zero means no requirement.
export function requiredKarma(school, level) {
  if (school === SS.QOR) return level * -10;
  if (school === SS.SHALILLE) return level * 10;
  return 0;
}

// Spell.KarmaCheck, spell.kod:456.
export function karmaAllows(school, level, karma) {
  const need = requiredKarma(school, level);
  if (need === 0) return true;
  if (need > 0) return karma >= need;
  return karma <= need;
}

// ------------------------------------------------------------------ compile

// kod identifiers are CASE-INSENSITIVE, and the tree uses that freely: blakston.khd
// declares SID_FORESIGHT while forsight.kod writes SID_Foresight. A case-sensitive
// lookup silently drops those spells from the catalogue, which is worse than failing
// — the spell simply appears not to exist.
function constantTable() {
  const nums = new Map();
  try {
    const khd = fs.readFileSync(path.join(M59_ROOT, 'kod/include/blakston.khd'), 'utf8');
    for (const m of khd.matchAll(/^\s*((?:SID|SKID|SS)_\w+)\s*=\s*(-?\d+)/gm))
      nums.set(m[1].toUpperCase(), Number(m[2]));
  } catch { /* without it, numbers stay symbolic */ }
  return { get: k => nums.get(String(k).toUpperCase()),
           has: k => nums.has(String(k).toUpperCase()),
           entries: () => nums.entries(),
           [Symbol.iterator]: () => nums[Symbol.iterator]() };
}

// A class variable, as declared in the class's own file. Values may be a literal or a
// named constant, so both are resolved.
function classVar(text, name, consts) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(-?\\w+)`, 'm').exec(text);
  if (!m) return null;
  const raw = m[1];
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return consts.has(raw) ? consts.get(raw) : raw;
}

// Reagents are built imperatively, one Cons per ingredient:
//   plReagents = Cons([&ShamanBlood,1], plReagents);
// so read the ResetReagents body rather than looking for a table.
function reagentsOf(text) {
  const i = text.indexOf('   ResetReagents(');
  if (i < 0) return [];
  const rest = text.slice(i);
  const end = /\r?\n {3}\}\r?\n/.exec(rest);
  const body = end ? rest.slice(0, end.index) : rest.slice(0, 1500);
  return [...body.matchAll(/Cons\(\s*\[\s*&(\w+)\s*,\s*(\d+)\s*\]/g)]
    .map(m => ({ item: m[1], count: Number(m[2]) }));
}

// Prerequisites are declared the same way: [spell number, ability needed].
function prereqsOf(text, consts) {
  const i = text.indexOf('   ResetPrereqs(');
  if (i < 0) return [];
  const rest = text.slice(i);
  const end = /\r?\n {3}\}\r?\n/.exec(rest);
  const body = end ? rest.slice(0, end.index) : rest.slice(0, 1500);
  return [...body.matchAll(/Cons\(\s*\[\s*([A-Za-z_]\w*|\d+)\s*,\s*(\d+)\s*\]/g)]
    .map(m => ({ spell: /^\d+$/.test(m[1]) ? Number(m[1]) : (consts.get(m[1]) ?? m[1]), ability: Number(m[2]) }));
}

// A spell's CanPayCosts is an override like a merchant's ObjectDesired: an arbitrary
// rule that no table can capture. Kept verbatim when present.
function canPayCosts(text) {
  const i = text.indexOf('   CanPayCosts(');
  if (i < 0) return null;
  const rest = text.slice(i);
  const end = /\r?\n {3}\}\r?\n/.exec(rest);
  return (end ? rest.slice(0, end.index + end[0].length) : rest.slice(0, 1500)).trimEnd();
}

function compile() {
  const consts = constantTable();
  const spells = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.kod')) continue;
      const text = fs.readFileSync(full, 'utf8');
      const head = /^(\w+)\s+is\s+(\w+)/m.exec(text);
      if (!head) continue;
      const num = classVar(text, 'viSpell_num', consts);
      if (num === null || typeof num !== 'number') continue;

      const school = classVar(text, 'viSchool', consts);
      const level = classVar(text, 'viSpell_level', consts);
      const mana = classVar(text, 'viMana', consts);
      const schoolNum = typeof school === 'number' ? school : null;
      const levelNum = typeof level === 'number' ? level : null;

      spells.push({
        num, cls: head[1], parent: head[2],
        file: path.relative(M59_ROOT, full).split(path.sep).join('/'),
        school: schoolNum, school_name: schoolNum != null ? SCHOOLS[schoolNum] ?? String(school) : null,
        level: levelNum,
        mana: typeof mana === 'number' ? mana : null,
        min_hit_points: classVar(text, 'piMinHitPoints', consts) || 0,
        reagents: reagentsOf(text),
        prerequisites: prereqsOf(text, consts),
        // Derived, not declared — see the header.
        required_karma: (schoolNum != null && levelNum != null) ? requiredKarma(schoolNum, levelNum) : 0,
        extra_cost_rule: canPayCosts(text),
      });
    }
  };
  walk(path.join(M59_ROOT, 'kod/object/passive/spell'));

  // Names come from the same SID_ constants the merchant catalogue uses, so a spell
  // found here lines up with a merchant that teaches it.
  const byNum = new Map();
  for (const [k, v] of consts) if (k.startsWith('SID_')) byNum.set(v, k.slice(4).toLowerCase().replace(/_/g, ' '));
  for (const sp of spells) sp.name = byNum.get(sp.num) ?? sp.cls.toLowerCase();

  spells.sort((a, b) => (a.school ?? 99) - (b.school ?? 99) || (a.level ?? 99) - (b.level ?? 99) || a.num - b.num);
  return spells;
}

// Cross-check against the running server: SYS holds every spell object, so a count
// mismatch means the source walk missed a directory.
function adminOnce(cmd, quietMs = 1200) {
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, HOST);
    let buf = '', t;
    const fin = () => { clearTimeout(t); s.destroy(); resolve(buf); };
    s.on('connect', () => { s.write(cmd + '\r\n'); t = setTimeout(fin, quietMs); });
    s.on('data', d => { buf += d; clearTimeout(t); t = setTimeout(fin, quietMs); });
    s.on('error', e => { clearTimeout(t); reject(e); });
  });
}

export function loadSpells(file = OUT) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ------------------------------------------------------------------ cli

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'build') {
    const spells = compile();
    let live = null;
    try {
      const sys = await adminOnce('show object 0');
      const listId = /plSpells\s+= LIST (\d+)/.exec(sys)?.[1];
      if (listId) {
        const dump = await adminOnce(`show list ${listId}`, 1800);
        live = new Set([...dump.matchAll(/OBJECT (\d+)/g)].map(m => Number(m[1]))).size;
      }
    } catch { /* the catalogue stands on its own; this is only a cross-check */ }

    const data = { builtAt: new Date().toISOString(), spells };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
    console.log(`wrote ${OUT}`);
    console.log(`${spells.length} spells compiled from the source`);
    if (live !== null) console.log(`${live} spell objects in the running world` +
      (live === spells.length ? ' — matches' : `  <- DIFFERS by ${Math.abs(live - spells.length)}; the source walk may have missed a directory`));
    console.log(`${spells.filter(s => s.reagents.length).length} need physical reagents`);
    console.log(`${spells.filter(s => s.required_karma !== 0).length} have a karma requirement`);
    console.log(`${spells.filter(s => s.extra_cost_rule).length} override CanPayCosts with a rule of their own`);
    const noSchool = spells.filter(s => s.school == null);
    if (noSchool.length) console.log(`${noSchool.length} without a readable school: ${noSchool.slice(0, 6).map(s => s.cls).join(', ')}`);
    process.exit(0);
  }

  const data = loadSpells();
  const find = q => data.spells.filter(s =>
    s.name.includes(q.toLowerCase()) || s.cls.toLowerCase().includes(q.toLowerCase()) || String(s.num) === q);

  if (cmd === 'show') {
    const hits = find(rest.join(' '));
    if (!hits.length) { console.error(`no spell matches "${rest.join(' ')}"`); process.exit(1); }
    for (const s of hits.slice(0, 4)) {
      console.log(`\n${s.name} (SID ${s.num}) — ${s.school_name} level ${s.level ?? '?'}`);
      console.log(`  mana ${s.mana ?? '?'}${s.min_hit_points ? `, needs ${s.min_hit_points}+ hit points` : ''}`);
      console.log(`  reagents: ${s.reagents.length ? s.reagents.map(r => `${r.count} x ${r.item}`).join(', ') : 'none'}`);
      if (s.prerequisites.length) console.log(`  prerequisites: ${s.prerequisites.map(p => `spell ${p.spell} at ability ${p.ability}`).join(', ')}`);
      console.log(`  karma: ${s.required_karma === 0 ? 'no requirement'
        : s.required_karma > 0 ? `must be at least +${s.required_karma} (good)` : `must be at most ${s.required_karma} (evil)`}`);
      if (s.extra_cost_rule) console.log(`  it also overrides CanPayCosts (${s.file}):\n${s.extra_cost_rule.split('\n').slice(0, 14).join('\n')}`);
    }
    process.exit(0);
  }

  if (cmd === 'reagents') {
    const q = rest.join(' ').toLowerCase();
    const hits = data.spells.filter(s => s.reagents.some(r => r.item.toLowerCase().includes(q)));
    console.log(hits.length ? `${hits.length} spell(s) consume something matching "${q}":` : `nothing consumes "${q}"`);
    for (const s of hits) console.log(`  ${s.name.padEnd(24)} ${s.school_name} L${s.level}  ${s.reagents.map(r => `${r.count}x${r.item}`).join(', ')}`);
    process.exit(0);
  }

  if (cmd === 'castable') {
    const karma = Number(rest[0]);
    if (!Number.isFinite(karma)) { console.error('usage: castable <karma, -100..100>'); process.exit(1); }
    const school = rest.includes('--school') ? rest[rest.indexOf('--school') + 1]?.toLowerCase() : null;
    let list = data.spells.filter(s => s.school != null && s.school !== SS.DM);
    if (school) list = list.filter(s => (s.school_name || '').toLowerCase().includes(school));
    const yes = list.filter(s => karmaAllows(s.school, s.level ?? 0, karma));
    const no = list.filter(s => !karmaAllows(s.school, s.level ?? 0, karma));
    console.log(`at karma ${karma}: ${yes.length} castable, ${no.length} blocked by karma`);
    const blockedBySchool = {};
    for (const s of no) blockedBySchool[s.school_name] = (blockedBySchool[s.school_name] || 0) + 1;
    for (const [k, n] of Object.entries(blockedBySchool)) console.log(`  blocked: ${n} in ${k}`);
    console.log('\nthe nearest ones you cannot yet cast:');
    for (const s of no.sort((a, b) => Math.abs(a.required_karma - karma) - Math.abs(b.required_karma - karma)).slice(0, 8))
      console.log(`  ${s.name.padEnd(22)} ${s.school_name} L${s.level}  needs ${s.required_karma > 0 ? '>= +' : '<= '}${s.required_karma}`);
    process.exit(0);
  }

  console.error('usage: m59-spells.mjs build | show <name> | reagents <item> | castable <karma> [--school x]');
  process.exit(1);
}
