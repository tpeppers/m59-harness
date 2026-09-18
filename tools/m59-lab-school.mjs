#!/usr/bin/env node
// GIVE A LAB CHARACTER ONE SCHOOL OF MAGIC, UP TO A NAMED LEVEL. LOOPBACK ONLY.
//
//   node tools/m59-lab-school.mjs --school kraanan --to 2 --ability 99 Aaaa Bbbb
//   node tools/m59-lab-school.mjs --school shalille --to 2 --fleet shadow --broker 8971 --all
//   node tools/m59-lab-school.mjs --school qor --to 2 --dry --all --fleet shadow --broker 8971
//
// WHY NOT `m59-dm.mjs kit --spells 99`. That grants EVERY spell in the game at 99, which
// makes a superman rather than a subject — and for anything that measures a GATE it destroys
// the measurement, because a character who already holds the level-3 spell answers "you have
// already been taught that" to every probe. The disciple quest is the case in point: the
// whole question is whether a priestess will sell a level-3 spell, and a character who was
// handed it cannot answer that question any more.
//
// So this grants a SLICE: one school, levels 1 to N, at one ability. Level 3 and above are
// left exactly as they were, which is what makes "she refused, and now she does not" a
// readable result.
//
// THE LAB BARGAIN (docs/m59-fleetscratch.md). This removes NOISE — it skips the twenty real
// hours of casting that would otherwise be in the way — and changes nothing being measured:
// the gate, the quest, the walk and the reach are all untouched. It refuses any host that is
// not loopback, because `m59-dm.mjs` refuses one, and that refusal is the whole safety here.
//
// A GRANT IS INVISIBLE TO `abilities` UNTIL THE KEEPER LOGS IN AGAIN, AND THE WORLD IS RIGHT
// ANYWAY. Measured 2026-09-18 on the shadow fleet: after granting Aaaa the six Kraanan spells,
// the broker's `abilities` showed only the three she ALREADY had — with `relay` correctly bumped
// 17 -> 99, which is what makes it so convincing — while the server answered
// `GetSpellAbility` 99 for all six and `HasSpell` 1 for bless. Ability levels are PUSHED to a
// client once and kept (CLAUDE.md), so a spell the server adds mid-session never enters the
// keeper's cached list. Nothing is wrong except the instrument.
//
// So `--verify` reads the abilities back over the SAME maintenance socket that wrote them,
// which is the only reading that is about the world rather than about a cache. If you need the
// keeper to agree, restart that keeper; `PlayerCanLearn`, the priestess and every quest check
// read the server's list and were never confused.
//
// WHERE THE SPELL LIST COMES FROM. `substrate/m59-merchants.json`, which carries each
// teacher's `teaches` rows with the spell's `num` (its SID), its `level` and its `kind`. That
// is the game's own answer to "what is in this school", read off the priestess who sells it,
// rather than a hand-written table that would be wrong the first time a spell moved. A school
// is therefore identified by its TEACHER, which is also how the server thinks about it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit, resolve as resolveNames, dm } from './m59-dm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// The teacher whose shop list IS the school. Same four as the disciple quests plus the two
// that have no quest, because "grant me a school" is a reasonable thing to want for those too.
export const SCHOOL_TEACHER = Object.freeze({
  kraanan: 'KraananPriestess',
  shalille: 'ShalillePriestess',
  faren: 'FarenPriestess',
  qor: 'QorPriestess',
  riija: 'RiijaMonk',
});

/** Every spell that teacher sells at level <= `to`, as `{ name, num, level }`. */
export function schoolSpells(school, to = 2, merchantsFile = null) {
  const cls = SCHOOL_TEACHER[String(school).toLowerCase()];
  if (!cls) throw new Error(
    `unknown school "${school}" — known: ${Object.keys(SCHOOL_TEACHER).join(', ')}`);
  const file = merchantsFile || join(REPO, 'substrate', 'm59-merchants.json');
  const all = JSON.parse(readFileSync(file, 'utf8')).merchants ?? [];
  const teacher = all.find(m => m.cls === cls);
  if (!teacher) throw new Error(
    `${cls} is not in ${file} — rebuild it with m59-merchants.mjs before granting a school`);
  return (teacher.teaches ?? [])
    .filter(t => t.kind === 'spell' && Number(t.level) <= Number(to) && Number.isFinite(Number(t.num)))
    .map(t => ({ name: t.spell ?? t.name, num: Number(t.num), level: Number(t.level) }))
    .sort((a, b) => a.level - b.level || a.num - b.num);
}

// ---------------------------------------------------------------- cli
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes(n);

  const school = arg('--school');
  const to = Number(arg('--to', 2));
  const ability = Number(arg('--ability', 99));
  const dry = has('--dry');
  const host = arg('--host', '127.0.0.1');
  const port = Number(arg('--port', 19998));
  const brokerPort = Number(arg('--broker', 8971));

  if (!school) {
    console.error('usage: m59-lab-school.mjs --school <kraanan|shalille|faren|qor|riija> ' +
                  '[--to 2] [--ability 99] [--dry] [--broker 8971] <Name...>|--all');
    return 2;
  }

  const spells = schoolSpells(school, to);
  console.log(`${school} to level ${to}: ${spells.length} spell(s) at ability ${ability}`);
  for (const s of spells) console.log(`   L${s.level} ${s.name} (SID ${s.num})`);
  if (!spells.length) { console.error('nothing to grant'); return 1; }

  // Names come from the command line, or from whatever the named broker is holding. Asking
  // the broker is the convenient path and it is also the one that cannot name a character on
  // a different fleet by accident.
  const TAKES_VALUE = new Set(['--school', '--to', '--ability', '--host', '--port', '--broker']);
  let names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (TAKES_VALUE.has(argv[i])) i++; continue; }
    names.push(argv[i]);
  }
  if (has('--all')) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                  params: { name: 'fleet', arguments: {} } });
    const r = await fetch(`http://127.0.0.1:${brokerPort}/`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const f = JSON.parse((await r.json()).result.content[0].text);
    names = (f.fleet ?? []).map(c => c.character).filter(Boolean);
  }
  names = [...new Set(names)].filter(Boolean);
  if (!names.length) { console.error('no characters named'); return 1; }
  console.log(`\n${names.length} character(s): ${names.join(', ')}`);

  if (dry) { console.log('\n[dry] nothing sent'); return 0; }

  const ids = spells.map(s => s.num);
  let ok = 0, bad = 0;
  for (const name of names) {
    // `kit` resolves the name inside the same batch it uses the id in — object ids are
    // renumbered on every save, so a cached one names a different object within the hour.
    const r = await kit(name, { spells: ability, spell_ids: ids }, { host, port })
      .catch(e => ({ ok: false, why: e.message }));
    if (!r.ok) { bad++; console.log(`  ${name}: FAILED — ${r.why}`); continue; }
    ok++;
    // READ IT BACK OFF THE SERVER, not off the broker. `AddSpell` returns FALSE both when it
    // refused and when the character already held the spell at that ability, so the return
    // value cannot tell success from no-op — and the broker's cached list cannot see a
    // mid-session grant at all.
    if (!has('--verify')) {
      console.log(`  ${name}: ${r.commands} command(s), ${r.rejected?.length ?? 0} rejected`);
      continue;
    }
    const ids2 = await resolveNames([name], { host, port });
    const obj = ids2[name];
    const out = await dm(spells.map(s => `send object ${obj} GetSpellAbility spell_num INT ${s.num}`),
                         { host, port, timeoutMs: 30000 }).catch(() => '');
    const got = [...String(out).matchAll(/MESSAGE GetSpellAbility \(\d+\)\r?\n: INT (-?\d+)/g)]
      .map(m => Number(m[1]));
    const short = spells.filter((s, i) => (got[i] ?? -1) < ability);
    if (short.length) { bad++; ok--; console.log(
      `  ${name}: NOT AT ${ability} — ${short.map((s, i) => `${s.name}=${got[spells.indexOf(s)]}`).join(', ')}`); }
    else console.log(`  ${name}: all ${spells.length} at ${ability}, read back off the server`);
  }
  console.log(`\n${ok} granted, ${bad} failed`);
  if (ok && !has('--verify'))
    console.log('note: pass --verify to read the abilities back — the broker\'s `abilities` ' +
                'will NOT show a mid-session grant until that keeper logs in again');
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href)
  process.exit(await main());
