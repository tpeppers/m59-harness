#!/usr/bin/env node
// THE ICKY CAVE CHALICE ERRAND, PINNED. Offline: no broker, no server, no socket.
//
//   node tools/m59-icky-chalice-test.mjs
//
// substrate/fleetscripts.example/icky-chalice.mjs is the committed shape of the errand (operator,
// 2026-10-02 and 2026-10-04): clearers hold room 27 orc-free with ten spiders, the caster fetches one
// cast of dispel illusion reagents from the guild chests or the Barloque vault if the pack lacks them,
// dispels the illusion and takes the Chalice of the Rain inside the 30 s window. Three groups:
//
//   1. THE KOD. Every number the errand acts on is read back out of the kod here — reagents, mana, the
//      30 s timer, the orc check, the chalice square, the 7-square get, the refusal sentence — because
//      a second transcription in a test only proves two transcriptions agree. SKIPPED where no tree.
//   2. THE DECISIONS. Where the reagents come from (pack, hall, vault, both, neither) and whether the
//      cave is held (an empty or foreign reading is never held).
//   3. THE COMPILE. Both roles compile, the run-time walks declare their candidates and pass the trap
//      check, they resolve to the right rooms for each source, and the tidy-up steps are `always`.
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-icky-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_LEDGER_DIR = join(LOCK_DIR, 'ledger');
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached
const BAND_DIR = mkdtempSync(join(tmpdir(), 'm59-icky-band-'));
writeFileSync(join(BAND_DIR, 'keeper-bands.json'), JSON.stringify({ testfleet: 19900 }));
process.env.M59_KEEPER_BAND_REGISTRY = join(BAND_DIR, 'keeper-bands.json');

const { trapCheck, resolveStep } = await import('./m59-fleetscript.mjs');
const { applyDefaults, checkParams } = await import('./m59-fleetlib.mjs');
const ex = await import('../substrate/fleetscripts.example/icky-chalice.mjs');
const { script, CAVE, DISPEL, CHALICE_RX, CLINGS_RX, countOf, castsIn, shortfall, reagentSource, caveState } = ex;

let pass = 0, fail = 0, skip = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const skipped = why => { skip++; console.log(`  skip ${why}`); };

// ---------------------------------------------------------------- 1. the kod
console.log('the kod');
const KOD = join(process.env.M59_ROOT || 'C:/code/Meridian59', 'kod');
const read = rel => { const f = join(KOD, rel); return existsSync(f) ? readFileSync(f, 'utf8') : null; };
const spell = read('object/passive/spell/dispillu.kod');
const cave = read('object/active/holder/room/monsroom/objroom/cave2.kod');
const chalice = read('object/item/passitem/chalice.kod');
const user = read('object/active/holder/nomoveon/battler/player/user.kod');
if (!spell || !cave || !chalice || !user) skipped(`no kod tree under ${KOD} (set M59_ROOT)`);
else {
  const reag = [...spell.matchAll(/Cons\(\[&(\w+),(\d+)\],plReagents\)/g)].map(m => [m[1], Number(m[2])]);
  const want = { DragonflyEye: 1, UncutSeraphym: 1, Solagh: 2 };
  ok('dispillu.kod: 1 dragonfly eye, 1 uncut seraphym, 2 solagh — and DISPEL says the same',
     reag.length === 3 && reag.every(([k, n]) => want[k] === n)
     && DISPEL.reagents.map(r => r.per).join() === '1,1,2', JSON.stringify(reag));
  ok('dispillu.kod: viMana 20, no target (the room is dispelled)', /viMana = 20\b/.test(spell)
     && DISPEL.mana === 20 && /GetNumSpellTargets\(\)\s*\{\s*return 0;/.test(spell));
  const castermsg = (spell.match(/dispelillusion_castermsg_rsc = \\\s*"([^"]+)"\s*"([^"]+)"/) ?? []).slice(1).join('');
  ok('the caster\'s sentence is what DISPEL.said listens for', DISPEL.said.test(castermsg), castermsg);
  ok('dispillu.kod: Kraanan, level 4', /viSchool = SS_KRAANAN/.test(spell) && /viSpell_level = 4\b/.test(spell));
  ok('cave2.kod: one chalice, GEN_ONE, at r23c11 — CAVE.chalice', /\[ &Chalice, GEN_ONE, 0, 23, 11,/.test(cave)
     && CAVE.chalice.row === 23 && CAVE.chalice.col === 11);
  ok('cave2.kod: the illusion opens for 30000 ms — CAVE.windowMs', /createtimer\(self,@ReplaceIllusions,30000\)/.test(cave)
     && CAVE.windowMs === 30_000);
  ok('cave2.kod: OkayToGetChalice refuses while the illusion stands AND while any orc is in plActive',
     /OkayToGetChalice\(\)[\s\S]{0,200}if ptIllusionResetTimer = \$\s*\{\s*return FALSE;/.test(cave)
     && /isClass\(each_obj,&orc\)\s*\{\s*return FALSE;/.test(cave));
  ok('cave2.kod: orc 50 / spider 50 is the whole spawn table', /plMonsters = \[ \[&Orc, 50\], \[&Spider, 50\] \];/.test(cave));
  ok('cave2.kod: the teleport square r23c16 is where the caster stands', /viTeleport_row = 23/.test(cave)
     && /viTeleport_col = 16/.test(cave) && CAVE.stand.row === 23 && CAVE.stand.col === 16);
  const cantGet = (chalice.match(/chalice_cant_get = "([^"]+)"/) ?? [])[1] ?? '';
  ok('chalice.kod: the refusal sentence is what CLINGS_RX listens for', CLINGS_RX.test(cantGet), cantGet);
  ok('chalice.kod: the name CHALICE_RX finds', CHALICE_RX.test((chalice.match(/chalice_name_rsc = "([^"]+)"/) ?? [])[1] ?? ''));
  ok('chalice.kod: never vaulted, and a held full chalice refuses a second', /CanBeStoredInVault\(\)\s*\{\s*return FALSE;/.test(chalice)
     && /FindHolding, #class=&Chalice, #sequence=1\)/.test(chalice));
  ok('user.kod UserGet: a get reaches Manhattan 7 — the stand square is inside it',
     /if \(iRow_dist \+ iCol_dist\) > 7/.test(user) && CAVE.getReach === 7
     && Math.abs(CAVE.stand.row - CAVE.chalice.row) + Math.abs(CAVE.stand.col - CAVE.chalice.col) <= 7);
  ok('user.kod: a vault withdrawal is the same @Buy as a purchase (why `shop` takes it out)',
     /UserWithdrawalItems\(what = \$, item_list = \$, number_list = \$\)[\s\S]{0,400}Send\(what,@Buy,#what=self/.test(user));
}

// ---------------------------------------------------------------- 2. the decisions
console.log('the decisions');
{
  const one = [{ name: 'dragonfly eye', amount: 1 }, { name: 'uncut seraphym', amount: 1 }, { name: 'vial of solagh', amount: 2 }];
  ok('countOf: plural names and stacks', countOf([{ name: 'dragonfly eyes', amount: 3 }, { name: 'Dragonfly eye' }], DISPEL.reagents[0].rx) === 4);
  ok('castsIn: the scarcest reagent decides (solagh is two a cast)', castsIn(one) === 1
     && castsIn([...one, { name: 'dragonfly eye', amount: 5 }, { name: 'uncut seraphym', amount: 5 }]) === 1
     && castsIn([]) === 0);
  ok('shortfall: exactly what is missing for N casts',
     JSON.stringify(shortfall(one, 2)) === JSON.stringify([{ item: 'dragonfly eye', amount: 1 },
       { item: 'uncut seraphym', amount: 1 }, { item: 'vial of solagh', amount: 2 }]) && shortfall(one, 1).length === 0);

  const chests = [{ items: [{ name: 'vial of solagh', amount: 12 }, { name: 'dragonfly eye', amount: 9 }, { name: 'uncut seraphym', amount: 3 }] }];
  const vault = { character: 'camilla', items: [{ name: 'uncut seraphym', amount: 14 }, { name: 'dragonfly eye', amount: 14 }, { name: 'vial of solagh', amount: 28 }] };
  ok('reagentSource: the pack first — no walk at all', reagentSource({ pack: one, chests, vault, casts: 1 }).from === 'pack');
  const h = reagentSource({ pack: [], chests, vault, casts: 2 });
  ok('reagentSource: the hall chests when they hold the whole shortfall, asking for EXACTLY it',
     h.from === 'hall' && JSON.stringify(h.hall) === JSON.stringify(shortfall([], 2)), JSON.stringify(h));
  const v = reagentSource({ pack: [], chests: [{ items: [{ name: 'vial of solagh', amount: 1 }] }], vault, casts: 2 });
  ok('reagentSource: the vault when the chests are short and it is not', v.from === 'vault' && v.vault.length === 3, JSON.stringify(v));
  ok('reagentSource: the vault when the caster cannot use the hall (under 30 max hp)',
     reagentSource({ pack: [], chests, vault, casts: 1, hallOk: false }).from === 'vault');
  const hv = reagentSource({ pack: [], chests: [{ items: [{ name: 'dragonfly eye', amount: 2 }, { name: 'uncut seraphym', amount: 2 }] }],
    vault: { items: [{ name: 'vial of solagh', amount: 4 }] }, casts: 2 });
  ok('reagentSource: the chests and then the vault for the remainder', hv.from === 'hall+vault'
     && hv.hall.length === 2 && JSON.stringify(hv.vault) === '[{"item":"vial of solagh","amount":4}]', JSON.stringify(hv));
  const none = reagentSource({ pack: [], chests: [], vault: null, casts: 1 });
  ok('reagentSource: neither — refused, and the reason says which readings were missing',
     none.from === null && /nobody has opened a chest/.test(none.why) && /never been read/.test(none.why), none.why);

  const m = (name, extra = {}) => ({ name, can: ['look', 'attack'], is_player: false, row: 30, col: 30, ...extra });
  const spiders = n => Array.from({ length: n }, () => m('spider'));
  const room = (objects, num = 27) => ({ room: { num }, objects });
  const chaliceObj = { name: 'Chalice of the Rain', can: ['look', 'get'], is_player: false, row: 23, col: 11 };
  const held = caveState(room([...spiders(10), chaliceObj, { name: 'Kermit', can: ['look', 'attack'], is_player: true }]));
  ok('caveState: ten spiders, no orc, chalice on view — HELD (players are not monsters)',
     held.held && held.state === 'held' && held.spiders === 10 && held.monsters === 10 && held.chalice, JSON.stringify(held));
  ok('caveState: one orc is CLEARING whatever else is there', caveState(room([...spiders(9), m('orc')])).state === 'clearing');
  ok('caveState: no orc below the cap is OPEN, not held', caveState(room(spiders(7))).state === 'open');
  ok('caveState: an empty reading is never held', !caveState(room([])).held && !caveState(null).held);
  ok('caveState: a reading from another room is ELSEWHERE', caveState(room(spiders(12), 587)).state === 'elsewhere');
  ok('caveState: "orc" is a whole word — an orc shaman counts, a "sorcerer" does not',
     caveState(room([...spiders(10), m('orc shaman')])).orcs === 1 && caveState(room([...spiders(10), m('sorcerer')])).orcs === 0);
}

// ---------------------------------------------------------------- 3. the compile
console.log('the compile');
{
  const params = applyDefaults(script, { agents: 't9,t16' });
  ok('the defaults check: agents is the only thing a caller must give', checkParams(script, params).length === 0
     && checkParams(script, applyDefaults(script, {})).length === 1);
  ok('the caster defaults to t9 (Camilla) and the strategy to the example', params.caster === 't9'
     && params.strategy === 'icky-cave-orc-clear');
  const casterPlan = await script.steps({ ...params, agent: 't9', agents: ['t9', 't16'] });
  const clearerPlan = await script.steps({ ...params, agent: 't16', agents: ['t9', 't16'] });
  ok('a clearer walks to 27 and takes the posture, and its steps END (the lease goes back)',
     clearerPlan.length === 2 && clearerPlan[0].do === 'walk' && clearerPlan[0].to === 27
     && clearerPlan[1].do === 'verify' && clearerPlan[1].label === 'posture');
  const labels = casterPlan.map(s => s.label ?? s.do);
  ok('the caster: ready, source, walk, hall, walk, reagents, held, spare, walk 27, stand, chalice, tidy',
     JSON.stringify(labels) === JSON.stringify(['ready', 'source', 'walk', 'hall', 'walk', 'reagents', 'held',
       'caster-spare', 'walk', 'walk_to', 'chalice', 'caster-unspare', 'release']), JSON.stringify(labels));
  ok('the run-time walks declare their candidates, and the plan passes the trap check',
     casterPlan.filter(s => s.do === 'walk' && typeof s.to === 'function').every(s => Array.isArray(s.candidates))
     && trapCheck(casterPlan) === null && trapCheck(clearerPlan) === null, trapCheck(casterPlan) ?? '');
  ok('the stand square is optional (the loot walk reaches the chalice anyway) and in room 27',
     casterPlan[9].optional === true && casterPlan[9].room === 27 && casterPlan[9].col === 16 && casterPlan[9].row === 23);
  ok('the tidy-up runs even after a failure', casterPlan.slice(-2).every(s => s.always === true));
  const homePlan = await script.steps({ ...applyDefaults(script, { agents: 't9', home: 39 }), agent: 't9', agents: ['t9'] });
  ok('home > 0 adds an always walk home; no clearers is allowed', homePlan.at(-1).do === 'walk' && homePlan.at(-1).to === 39
     && homePlan.at(-1).always === true);
  const noSpare = await script.steps({ ...applyDefaults(script, { agents: 't9', spareOnCaster: 'false' }), agent: 't9', agents: ['t9'] });
  ok('spareOnCaster=false drops the spare step', !noSpare.some(s => s.label === 'caster-spare'));
  const stray = await script.steps({ ...applyDefaults(script, { agents: 't16', caster: 't9' }), agent: 't16', agents: ['t16'] });
  ok('a caster who is not among the agents is refused, not silently skipped',
     stray.length === 1 && stray[0].label === 'caster-missing');

  const [w1, w2] = casterPlan.filter(s => s.do === 'walk' && typeof s.to === 'function');
  const to = (step, icky) => resolveStep(step, { icky }).to;
  ok('pack: neither walk leaves the room the caster is in', to(w1, { first: 52 }) === 52 && to(w2, { first: 52 }) === 52);
  ok('hall: 714, and stays there when the chests paid', to(w1, { first: 714 }) === 714
     && to(w2, { first: 714, at: 714, needVault: false }) === 714);
  ok('hall short: 714, then on to the vault at 114', to(w2, { first: 714, at: 714, needVault: true }) === 114);
  ok('vault: 114 both times', to(w1, { first: 114 }) === 114 && to(w2, { first: 114, needVault: true }) === 114);
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
