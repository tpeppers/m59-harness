#!/usr/bin/env node
// WHICH SPELLS ARE ACTUALLY GOING OFF, and which are a keeper talking to itself.
//
//   node tools/m59-spellcast.mjs                   the last two hours, worst caster first
//   node tools/m59-spellcast.mjs --minutes 15      one cron tick's worth
//   node tools/m59-spellcast.mjs --character Robin just this one
//   node tools/m59-spellcast.mjs --json            the whole report, for something else
//
// Offline and safe any time: it reads the ledger and the extracted spell table, opens no
// socket and drives nobody.
//
// THE QUESTION THIS ANSWERS, AND WHY COUNTING CASTS DOES NOT.
//
// `recordCast` writes `ok` from the CALLER's judgement — an inventory diff, a stat change —
// because the server never reports a spell's failure. For a buff there is usually nothing to
// diff, so `ok` degenerates into "the call came back". And a PersonalEnchantment already on
// its target refuses inside `CanPayCosts` for FREE: no mana, no reagents, no message. A keeper
// re-blessing an already-blessed fleet-mate therefore writes a perfect record of work it is
// not doing, for as long as it stands there.
//
// Measured on prod 2026-09-12: two of the four Kraanan casters showed fourteen blesses each in
// a fifteen-minute window at `worked: 100%`. Mana sat at 33/33 and 25/25 the whole time. They
// were parked in a Barloque gem shop with only fleet-mates present. Finding that took two and
// a half minutes of live polling per character and a fleet-wide figure of "44 blesses" had
// already gone to the operator. This command is that hour, as one question.
//
// `mana_cost` is the witness — `mana_before - mana_after`, recorded only when both readings
// were real and the number went DOWN — so a measured zero on a spell that costs mana is proof
// that nothing happened. See spellReport in m59-ledger.mjs for the four buckets.
//
// IT IS A LOWER BOUND AND THE OUTPUT SAYS SO. Regeneration runs during the measurement, so a
// 6-mana bless has been recorded at 2. `landed` means mana moved; the amount is not a cost.
import { spellReport } from './m59-ledger.mjs';
import { loadSpells } from './m59-spells.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const minutes = Number(arg('minutes', 120));
const character = arg('character', null);
const asJson = argv.includes('--json');

// THE COST TABLE IS EVIDENCE ABOUT A SERVER AND MAY NOT BE HERE. It is built from the kod by
// `m59-spells.mjs` into gitignored substrate, so a fresh clone has none — and a report that
// invented costs would convict correct behaviour. Without it every zero reads `unmeasured`,
// which is the honest answer and is what spellReport does when `manaOf` returns nothing.
let mana = new Map(), kinds = new Map(), tableNote = null;
try {
  const t = loadSpells();
  for (const s of (t.spells ?? [])) if (s.name) {
    mana.set(String(s.name).toLowerCase(), s.mana);
    // `parent` is the kod class this spell descends from, and it decides what a FREE cast
    // means: on a PersonalEnchantment the target already had the buff (fine, and the fleet
    // is buffed), on a producing spell nothing came out (a supply failure).
    kinds.set(String(s.name).toLowerCase(), String(s.parent ?? s.cls ?? ''));
  }
} catch (e) {
  tableNote = `no spell cost table here (${e.code === 'ENOENT' ? 'not built' : e.message}), so ` +
              `nothing can be called a free cast — run: node tools/m59-spells.mjs`;
}
const manaOf = (spell) => mana.get(String(spell || '').toLowerCase());
const kindOf = (spell) => kinds.get(String(spell || '').toLowerCase());

const r = spellReport({ sinceMs: minutes * 60_000, character, manaOf, kindOf });
if (asJson) {
  console.log(JSON.stringify({ ...r, spell_table: tableNote ?? `${mana.size} spells` }, null, 1));
  process.exit(0);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const num = (s, n) => String(s ?? 0).padStart(n);

console.log(`\nspells over ${minutes} min${character ? ` · ${character}` : ''}` +
            `${tableNote ? '' : ` · ${mana.size} costs known`}`);
if (tableNote) console.log(`  ! ${tableNote}`);

// AN EMPTY REPORT IS TWO DIFFERENT ANSWERS. A quiet fleet and the wrong history directory
// look identical from here, and the second is the likely one whenever this runs from a clone:
// the ledger resolves its path from the CHECKOUT it was loaded in, not from --fleet.
if (!r.by_spell.length) {
  const src = r.source ?? {};
  if (!src.exists) {
    console.log(`\n  NO HISTORY AT ${src.dir}`);
    console.log('  This checkout has no ledger for this fleet, so "nothing cast" is NOT what');
    console.log('  this says — nothing was read. Point it at the fleet that is running:');
    console.log('    M59_LEDGER_DIR=<repo>/substrate/history/<fleet> node tools/m59-spellcast.mjs\n');
  } else {
    console.log(`\n  nothing cast and nothing declined in this window.`);
    console.log(`  (${src.rows} rows read from ${src.files} file(s) in ${src.dir}, so the`);
    console.log('   history is there and the window is genuinely quiet)\n');
  }
  process.exit(0);
}

console.log('\n' + pad('spell', 18) + num('cast', 5) + num('landed', 7) + num('free', 6) +
            num('unmeas', 7) + num('failed', 7) + '  worked  landed');
for (const s of r.by_spell) {
  console.log(pad(s.spell, 18) + num(s.cast, 5) + num(s.landed, 7) + num(s.free ?? 0, 6) +
              num(s.unmeasured ?? 0, 7) + num(s.nothing, 7) +
              num(s.worked ?? '-', 8) + num(s.landed_pct ?? '-', 8));
  if (s.verdict) console.log('  ! ' + s.verdict);
}

// WORST FIRST BY WHAT LANDED. A caster achieving nothing sorts to the top of this table, not
// to the top of a "busiest" one.
console.log('\n' + pad('caster', 14) + num('cast', 5) + num('landed', 7) + num('free', 6) +
            '  landed');
for (const c of r.by_character) {
  // THE FLAG HAS TO SAY WHICH KIND OF NOTHING. "landed 0" covers a caster whose targets are
  // all already buffed — which is the fleet getting what it wanted — and a caster whose
  // every attempt is failing. Printing one warning for both is how I misread this table the
  // first time I ran it.
  const note = c.cast === 0 || c.landed > 0 ? ''
    : (c.free ?? 0) >= c.cast ? '   <- every target already had it; the ability is not climbing'
    : '   <- nothing is going off';
  console.log(pad(c.character, 14) + num(c.cast, 5) + num(c.landed, 7) + num(c.free ?? 0, 6) +
              num(c.landed_pct ?? '-', 8) + note);
}

if (r.declined.length) {
  console.log('\nrefused outright (a floor: each keeper\'s own running count, reset by restarts)');
  for (const d of r.declined.slice(0, 8))
    console.log('  ' + num(d.times, 6) + '  ' + pad(d.spell, 16) + d.why);
}

console.log('\n' + r.read_this_way.replace(/(.{1,96})(\s|$)/g, '$1\n').trimEnd() + '\n');
