#!/usr/bin/env node
// EVERY BUFF THE GAME HAS, WITH WHAT IT COSTS AND HOW LONG IT LASTS.
//
//   node tools/m59-buffs.mjs                 the table, longest-lasting first
//   node tools/m59-buffs.mjs --room          just the room enchantments
//   node tools/m59-buffs.mjs --json
//
// Parsed from the kod the local server was built from, not hand-listed, because a
// hand-written table of this is wrong the day somebody adds a spell and nobody notices —
// the same argument as the food list in m59-fleetscript.mjs, which was wrong in four places
// at once and about the same item each time.
//
// ============================================================================
// WHY DURATION IS THE ORDERING KEY
// ============================================================================
//
// Raid preparation is a queue of spells and the only thing that decides their order is how
// long each one lasts. `enchant weapon` is `(random(1,4) + power/3)` HOURS (enchwp.kod:141);
// `bless` is `(40 + power*6) * 1000` milliseconds halved-randomly, so twenty seconds to
// about ten minutes (bless.kod:91). Cast in the wrong order the second has expired before
// the fight starts and the first was never at risk. So: longest first, and the short ones
// as late as possible — which for the shortest means not during prep at all, but staged and
// cast at the head of the action phase.
//
// ROOM ENCHANTMENTS ARE ALWAYS DEFERRED, and not as a policy choice. They enchant the room
// they are cast in, so casting one anywhere but the boss's room does nothing for the fight
// no matter how long it lasts. `scope: 'room'` therefore implies `deferred: true` and
// nothing may override it.
//
// ============================================================================
// THE UNITS ARE NOT WRITTEN DOWN AND THEY ARE NOT THE SAME
// ============================================================================
//
// GetDuration returns milliseconds in some spells, seconds in others, and minutes in at
// least one, and the kod says so only in a comment when it says so at all:
//
//     bless        (40 + (iSpellPower*6)) * 1000            -> ms, explicit
//     strength     300 + (iSpellpower * 6)                  -> seconds, bare
//     haste        5 + ((15 * iSpellPower) / 100)           -> minutes, per its own comment
//     enchwp       (random(1,4) + power/3) * 1000 * 60 * 60 -> ms, hours' worth
//
// So the unit is INFERRED and the inference is shown, never hidden: `* 1000` means the
// expression is already milliseconds, an explicit `* 60 * 60` means hours, and a trailing
// comment naming minutes or seconds is believed over a guess. Anything still unresolved is
// reported `unknown` — and an unknown duration sorts as SHORT, deliberately, because
// casting a long buff late costs a few seconds and casting a short one early wastes it
// entirely. The asymmetry decides the default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';

/** kod constants, so SID_/SPELLPOWER_ names in an expression resolve. */
function constants(root) {
  const out = new Map();
  const dir = path.join(root, 'kod', 'include');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.khd'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of txt.matchAll(/^\s*([A-Z][A-Z_0-9]*)\s*=\s*(\d+)\s*$/gm)) out.set(m[1], Number(m[2]));
  }
  return out;
}

/**
 * Evaluate a kod duration expression at a given spell power. Returns null when anything in
 * it is not arithmetic we can do — a call into another object, a property we cannot see.
 * A null is an honest "unknown", which the ordering treats as short.
 */
export function evalDuration(expr, power, K) {
  if (typeof expr !== 'string' || !expr.trim()) return null;
  let e = expr.replace(/%.*$/, '').trim().replace(/;$/, '');
  // random(a,b) and Random(a,b) — take the LOW end, because a plan must not be built on a
  // roll going well. bound(x,lo,hi) keeps its middle argument's range the same way.
  e = e.replace(/\b[Rr]andom\s*\(([^,()]+),([^()]+)\)/g, '($1)');
  e = e.replace(/\bbound\s*\(([^,()]+),([^,()]+),([^()]+)\)/g, '($1)');
  e = e.replace(/\biSpell[Pp]ower\b/g, String(power));
  for (const [name, value] of K) if (e.includes(name)) e = e.replaceAll(name, String(value));
  if (/[A-Za-z_]/.test(e)) return null;                     // something unresolved is left
  if (!/^[\d\s+\-*/().]+$/.test(e)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${e});`)();
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/**
 * A COMMENT THAT STATES A RANGE IS DESCRIBING THE RESULT, NOT THE NUMBER'S UNIT.
 *
 * detinvis says `iDuration = 2400 * (100 + iSpellPower)` with `% 4 - 8 minutes max`. Read as
 * "this number is in minutes" that is 240000 * 60000 — and the first version of this table
 * duly printed `detect invisible ... 4000.0h-8000.0h`, which is four and a half months and
 * is obviously wrong the moment a human looks at it. The comment is the ANSWER: four to
 * eight minutes. So a range in the comment wins outright over any inference from the
 * expression.
 */
export function commentRange(comment) {
  const m = /(\d+)\s*(?:-|to)\s*(\d+)\s*(second|minute|hour)/i.exec(String(comment ?? ''));
  if (!m) return null;
  const scale = { second: 1000, minute: 60_000, hour: 3600_000 }[m[3].toLowerCase()];
  return { min: Number(m[1]) * scale, max: Number(m[2]) * scale, from: 'the kod comment' };
}

/** Milliseconds, given the raw number and whatever the source says about its unit. */
export function toMs(value, { expr = '', comment = '' } = {}) {
  if (value == null) return null;
  if (/\*\s*1000/.test(expr)) return { ms: value, from: 'explicit *1000 in the expression' };
  const src = `${expr} ${comment}`.toLowerCase();
  // A bare number with a unit WORD nearby, and no range to contradict it.
  if (/\bminute/.test(src)) return { ms: value * 60_000, from: 'a "minutes" comment' };
  if (/\bsecond/.test(src)) return { ms: value * 1000, from: 'a "seconds" comment' };
  // A bare number with nothing to say. Seconds is the common kod convention for a duration
  // that is not scaled — strength is `300 + power*6` and is five to fifteen minutes — but it
  // is a HEURISTIC and is labelled as one, because the alternative is discarding a real
  // number and sorting a fifteen-minute buff as if it were unknown.
  if (value >= 30 && value <= 100_000) return { ms: value * 1000, from: 'assumed seconds (bare expression)' };
  return null;
}

const NAME_RE = /^\s*(\w+_name_rsc)\s*=\s*"([^"]+)"/m;

function parseSpellFile(file, K, scope) {
  const t = fs.readFileSync(file, 'utf8');
  const numM = /vi(?:Spell|Skill)_num\s*=\s*([A-Z][A-Za-z_0-9]*)/i.exec(t);
  const nameRes = /vrName\s*=\s*(\w+)/.exec(t);
  const lit = nameRes ? new RegExp('^\\s*' + nameRes[1] + '\\s*=\\s*"([^"]+)"', 'mi').exec(t) : NAME_RE.exec(t);
  const name = lit ? (lit[2] ?? lit[1]) : null;
  if (!name) return null;
  const num = numM ? (K.get(numM[1].toUpperCase()) ?? null) : null;
  const mana = Number((/viMana\s*=\s*(\d+)/.exec(t) ?? [])[1] ?? NaN);
  // HOW LONG THE CASTER MUST STAND PERFECTLY STILL. `viCast_time` is a CASTING TRANCE
  // (trance.kod): the cost is taken up front, the caster is frozen for this long, and
  // EVENT_RUN, EVENT_REST, EVENT_USE, EVENT_ATTACK, EVENT_CAST, EVENT_DAMAGE or
  // EVENT_NEWOWNER during it all break the trance — half the mana comes back, the reagents
  // do not, and the spell does nothing.
  //
  // WHAT IT COST TO NOT HAVE THIS, 2026-09-11. `enchant weapon` is 30 SECONDS, and every
  // cast of it on this fleet fizzled inside two seconds: the cast drops ~19 vigor, that put
  // the character under its keeper's `vigorFloor`, and the keeper's own one-second pass sat
  // it down to recover — EVENT_REST. Nothing reported a failure. The reagents were gone and
  // the mana was half gone, so a verifier reading the COST called it a success, three times
  // over, and the fleet walked at a boss that resists mundane weapons 90% believing its
  // weapons were enchanted. The server had said so plainly the whole time:
  // "Your concentration is broken and the enchant weapon spell fizzles."
  const castTime = Number((/viCast_time\s*=\s*(\d+)/.exec(t) ?? [])[1] ?? NaN);
  const reagents = [...t.matchAll(/Cons\(\[&(\w+),\s*(\d+)\]/g)]
    .map(m => ({ item: m[1], count: Number(m[2]) }));
  // The duration line and any comment trailing it on the same line.
  const durLine = (/iDuration\s*=\s*([^\n]*)/.exec(t) ?? [])[1] ?? '';
  const expr = durLine.split('%')[0].trim().replace(/;$/, '');
  const comment = durLine.includes('%') ? durLine.slice(durLine.indexOf('%')) : '';
  // A trailing `iDuration = iDuration * 1000 * 60 * 60` (enchwp) is a second line; fold it in.
  const scale = /iDuration\s*=\s*iDuration\s*\*([^\n;]*)/.exec(t);
  const scaleExpr = scale ? scale[1] : '';
  const stated = commentRange(comment);
  const at = power => {
    const base = evalDuration(expr, power, K);
    if (base == null) return null;
    const scaled = scaleExpr ? evalDuration(`(${base})*${scaleExpr}`, power, K) : base;
    return toMs(scaled, { expr: expr + (scaleExpr ? ` * ${scaleExpr}` : ''), comment });
  };
  const lo = at(0), hi = at(100);
  const duration = stated ? { min: stated.min, max: stated.max, from: stated.from }
    : (lo || hi) ? { min: lo?.ms ?? null, max: hi?.ms ?? null, from: (lo ?? hi).from }
    : null;
  return Object.freeze({
    name: String(name).toLowerCase(), num, scope,
    mana: Number.isFinite(mana) ? mana : null,
    cast_time_ms: Number.isFinite(castTime) ? castTime : 0,
    reagents: Object.freeze(reagents),
    duration_ms: duration ? Object.freeze(duration) : null,
    duration_source: expr || null,
    // Room enchantments enchant the room they are cast in, so there is no useful moment to
    // cast one except inside the boss's room. Not a preference and not overridable.
    deferred: scope === 'room',
    file: path.basename(file),
  });
}

let CACHE = null;
export function buffCatalogue(root = DEFAULT_ROOT) {
  if (CACHE) return CACHE;
  const K = constants(root);
  const out = [];
  for (const [dir, scope] of [['persench', 'personal'], ['roomench', 'room']]) {
    const d = path.join(root, 'kod', 'object', 'passive', 'spell', dir);
    let files = [];
    try { files = fs.readdirSync(d).filter(f => f.endsWith('.kod')); } catch { continue; }
    for (const f of files) {
      const row = parseSpellFile(path.join(d, f), K, scope);
      if (row) out.push(row);
    }
  }
  // `enchant weapon` is an item enchantment and lives outside both directories, but it is
  // the single most valuable preparation in the game against anything with
  // [90, ATCK_WEAP_NONMAGIC] — so it is catalogued with the rest rather than special-cased
  // by every caller.
  const ench = path.join(root, 'kod', 'object', 'passive', 'spell', 'enchwp.kod');
  if (fs.existsSync(ench)) {
    const row = parseSpellFile(ench, K, 'weapon');
    if (row) out.push(Object.freeze({ ...row, deferred: false }));
  }
  CACHE = Object.freeze(sortByDurationDescending(out));
  return CACHE;
}

/**
 * LONGEST FIRST, AND UNKNOWN COUNTS AS SHORT. Sorting by the MINIMUM is deliberate: the
 * question a raid asks is "will this still be up when the fight starts", and the answer is
 * governed by the worst roll, not the average one.
 */
export function sortByDurationDescending(rows) {
  const key = r => (r.duration_ms?.min ?? r.duration_ms?.max ?? -1);
  return [...rows].sort((a, b) => key(b) - key(a));
}

const human = ms => ms == null ? 'unknown'
  : ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h`
  : ms >= 60_000 ? `${Math.round(ms / 60_000)}m`
  : `${Math.round(ms / 1000)}s`;

if (process.argv[1] && path.basename(process.argv[1]) === 'm59-buffs.mjs') {
  const argv = process.argv.slice(2);
  let rows = buffCatalogue();
  if (argv.includes('--room')) rows = rows.filter(r => r.scope === 'room');
  if (argv.includes('--personal')) rows = rows.filter(r => r.scope === 'personal');
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  console.log(`${rows.length} buff(s), longest-lasting first — cast in this order\n`);
  console.log('  name                 scope     mana  lasts (min-max)      reagents');
  for (const r of rows)
    console.log(`  ${r.name.padEnd(20)} ${r.scope.padEnd(9)} ${String(r.mana ?? '?').padStart(4)}  ` +
      `${(human(r.duration_ms?.min) + '-' + human(r.duration_ms?.max)).padEnd(20)} ` +
      `${r.reagents.map(x => `${x.count} ${x.item}`).join(', ') || '—'}` +
      `${r.deferred ? '   [DEFERRED: enchants the room it is cast in]' : ''}`);
  if (argv.includes('--why'))
    for (const r of rows)
      console.log(`  ${r.name.padEnd(20)} ${r.duration_ms?.from ?? 'no duration found'}` +
        `${r.duration_source ? `   <- ${r.duration_source}` : ''}`);
  console.log('\nUnknown durations sort as SHORT on purpose: casting a long buff late costs');
  console.log('seconds, casting a short one early wastes it entirely.');
}
