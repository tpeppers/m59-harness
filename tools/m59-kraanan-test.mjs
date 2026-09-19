#!/usr/bin/env node
// A KRAANAN PLAN THAT NAMES A TOOL NOBODY IMPLEMENTS, OR A CAST THE KEEPER WILL REFUSE —
// offline, no socket, no roster.
//
//   node tools/m59-kraanan-test.mjs
//
// WHAT THIS PINS, and most of them are mistakes this file's subject invites.
//
// 1. THE RETIRED ALLOWLIST MUST NOT CREEP BACK. Until 2026-09-19 a fail-closed RTS allowlist
//    refused every targeted cast in practice-kraanan.mjs, and that file carried a whole gate to
//    refuse at step 0 rather than drive a character to a temple to be told no forty times. The
//    operator retired the allowlist. What is pinned now is that the gate is GONE and every plan
//    builds real steps — plus the one check that replaced it, which is packet arity, not policy.
//
// 2. A REFUSAL THAT IS TRUTHY. `verify` honours an `ok` field and otherwise falls back to
//    truthiness (m59-fleetscript.mjs:3600-3622), so a refusal shaped `{ ok: false, why }` passes
//    on the truthiness path. Every refusal in practice-kraanan.mjs must return a BARE false.
//
// 3. A BUFF ROUND BUILT AS A LIST OF act('cast') STEPS. That is the one shape that cannot work:
//    `act()` freezes its arguments when the step list is compiled, so a target resolved at build
//    time names whoever was standing there when the run was PLANNED — which for a script about
//    "anyone else passing through the room" is nobody. The round must be a single verify.
//
// 4. THE GATE TREATED AS A CONSTANT. practice-shalille.mjs says "115 for level 4" and that is a
//    measurement of one character, not the rule. The rule is a function of how many other
//    schools the character has been into, and the SHORTCUT — one spell at the level unlocks the
//    rest of the level outright — is worth more than the arithmetic.
//
// 5. A "SOLO-DRILLABLE" LIST THAT USES THE WRONG TEST. Every Kraanan buff reports targets: 1, so
//    filtering on "needs no target" marks all of them undrillable, which is wrong: self-recast
//    is legal, so the caster is a permanent target.
import { readFileSync } from 'node:fs';
import { rtsCastArityOk } from './m59-rts-safety.mjs';
import { KRAANAN, OPERATOR_TRIPLE, PRACTICE, learnGate, buffRoom, buffsAtLevel,
         weaponSpells, drillableAtLevel, durationRange, weaponCycle, trainLevel, trainLevel2,
         drill, selfTargetable, script } from './fleetscripts/practice-kraanan.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  ' + extra : ''}`); }
};

// The broker is the authority on what tools exist, and it is read rather than listed here — a
// hand-copied list of tool names is the thing this test exists to stop.
const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const TOOLS = new Set([...BROKER.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map(m => m[1]));
const ACT_VERBS = new Set(
  (BROKER.match(/verb: \{ type: 'string', enum: \[([^\]]+)\]/) ?? [, ''])[1]
    .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean));
const SRC = readFileSync(new URL('./fleetscripts/practice-kraanan.mjs', import.meta.url), 'utf8');

console.log('');
console.log('the broker and the safety module were read, not assumed');
{
  ok('the broker exposes a tool list this test could find', TOOLS.size > 50, `found ${TOOLS.size}`);
  ok('and `cast` is one of them, or nothing below means anything', TOOLS.has('cast'));
  ok('`look` is a tool — the buff round depends on it to find bystanders', TOOLS.has('look'));
  ok('there is NO bare `drop` tool — it is a verb of `act`', !TOOLS.has('drop'));
  ok("and `act`'s verb enum was found and holds drop", ACT_VERBS.has('drop'), [...ACT_VERBS].join(','));
  ok('the safety module still exports its arity check', typeof rtsCastArityOk === 'function');
}

console.log('');
console.log('THE ALLOWLIST IS RETIRED, and what replaced it is arity rather than policy');
{
  const safetySrc = readFileSync(new URL('./m59-rts-safety.mjs', import.meta.url), 'utf8');
  // CODE ONLY. The module's header deliberately DESCRIBES the retired allowlist — that is the
  // point of keeping the account — so scanning the whole file for its vocabulary would fail on
  // its own documentation. Strip the comments and look at what actually executes.
  const safetyCode = safetySrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // Read from the module, so a reinstated allowlist fails here rather than silently re-blocking
  // the whole fleet's spellbook.
  ok('a zero-target spell sent bare is well-formed', rtsCastArityOk(0, false));
  ok('and the same spell carrying a target is not', !rtsCastArityOk(0, true));
  ok('a one-target spell needs its target', rtsCastArityOk(1, true) && !rtsCastArityOk(1, false));
  ok('an unreadable arity is refused rather than guessed',
     !rtsCastArityOk(undefined, true) && !rtsCastArityOk(-1, true) && !rtsCastArityOk(1.5, true));
  // THE POINT OF THE RETIREMENT: nothing surviving inspects the target's KIND.
  ok('the safety module no longer classifies spells by name', !/SAFE_SPELLS/.test(safetyCode));
  ok('nor decides whether a target may be a player',
     !/targetIsPlayer/.test(safetyCode) && !/target_mode/.test(safetyCode));
  ok('and exports neither of the retired predicates',
     !/rtsSafeSpellRule|rtsSpellTargetAllowed/.test(safetyCode));
  ok('but it records what it used to do, so the diff is not the only account',
     /retired/i.test(safetySrc) && /WHAT WAS GIVEN UP/.test(safetySrc));
  // The separate control — may this caller drive a character at all — is NOT what was retired.
  ok('and the local-caller control is untouched',
     /requireRtsLocalCaller/.test(safetySrc) && /unauthenticated/.test(safetySrc));
}

console.log('');
console.log('so every plan now builds real steps instead of refusing at step 0');
{
  ok('the composite loop plans rather than refusing', trainLevel2({ rounds: 4 }).steps.length > 1);
  ok('the weapon cycle plans', weaponCycle({ iterations: 2 }).steps.length >= 2);
  ok('the mend flavour plans', weaponCycle({ iterations: 2, apply: 'mend' }).steps.length >= 2);
  ok('a single-spell drill plans', drill('bless', { casts: 5, target: 't6' }).steps.length > 1);
  ok('every level plans',
     [2, 3, 4].every(l => trainLevel({ level: l, rounds: 2 }).steps.length > 1));
  // The gate is GONE from the fleetscript, not merely defaulted open.
  ok('and the fleetscript carries no RTS gate any more',
     !/rtsBlocked|rtsRefusal|withGate/.test(SRC));
  ok('while its header still explains what used to block it and why it no longer does',
     /IT NO LONGER DOES/.test(SRC) && /retired that allowlist/.test(SRC));
}

console.log('');
console.log('the buff round is ONE step, because targets are not knowable at compile time');
{
  const step = buffRoom({ spell: 'bless' });
  ok('buffRoom returns a single step, not a list', !Array.isArray(step));
  ok('and it is a verify, not an act', step.do === 'verify');
  ok('so nothing in it freezes a target name at build time',
     typeof step.fn === 'function' && step.why.includes('self always'));
  // If anybody ever rewrites it as act('cast', {target}) steps, this catches it: a compiled
  // target is exactly the bug.
  ok('the source does not build cast steps with a frozen bystander target',
     !/act\('cast',\s*\{\s*spell,\s*target:\s*o\./.test(SRC));
}

console.log('');
console.log('every act() step in every plan names a real tool and a real verb');
{
  const plans = {
    'bless drill': drill('bless', { casts: 3, maxMana: 65, target: 't6' }),
    'create weapon drill': drill('create weapon', { casts: 3, maxMana: 65 }),
    'weapon cycle': weaponCycle({ iterations: 3, maxMana: 65 }),
    'composite': trainLevel2({ rounds: 3 }),
  };
  let checked = 0; const bad = [];
  for (const [name, plan] of Object.entries(plans)) {
    for (const step of plan.steps) {
      if (step.do !== 'act') continue;
      checked++;
      if (!TOOLS.has(step.tool)) bad.push(`${name}: tool "${step.tool}"`);
      if (step.tool === 'act' && step.args?.verb && !ACT_VERBS.has(step.args.verb))
        bad.push(`${name}: act verb "${step.args.verb}"`);
    }
  }
  ok('there are act() steps to check at all', checked > 0, `checked ${checked}`);
  ok('and every one addresses a real tool and a real verb', bad.length === 0, bad.join('; '));
  // The weapon cycle calls `act` through `call()` inside a verify rather than as a step, so the
  // verb has to be pinned in the source instead.
  ok("the cycle's drop goes through act's drop VERB, not a bare drop tool",
     /call\('act',\s*\{\s*agent,\s*verb:\s*'drop'/.test(SRC) && ACT_VERBS.has('drop'));
}

console.log('');
console.log('no plan asks rest() for something rest() cannot do');
{
    const all = [weaponCycle({ iterations: 8, maxMana: 65 }), drill('bless', { casts: 30, maxMana: 65 })]
    .flatMap(p => p.steps);
  const restSteps = all.filter(s => s.do === 'rest');
  ok('the plans do rest between bars', restSteps.length > 0, `${restSteps.length} rest step(s)`);
  ok('and not one passes a mana target, because rest cannot honour one',
     restSteps.every(s => s.mana === undefined));
  const src = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');
  const want = src.slice(src.indexOf("case 'rest': {"), src.indexOf("case 'rest': {") + 300);
  ok('and the rest step really does only take health and vigor, as claimed',
     /health: step\.health/.test(want) && /vigor: step\.vigor/.test(want) && !/mana/.test(want));
  ok('mana is polled instead, and reads both status shapes',
     /vitals\?\.mana\?\.value \?\? st\?\.mana\?\.value/.test(SRC));
  ok('and an unreadable mana is a refusal rather than a pass',
     /if \(m == null\) return false/.test(SRC));
}

console.log('');
console.log("the table's own shape holds, and every number carries a kod source");
{
  const all = Object.values(KRAANAN);
  ok('every entry carries a kod source', all.every(s => typeof s.src === 'string' && s.src));
  ok('every entry carries a school level 1-6', all.every(s => s.level >= 1 && s.level <= 6));
  ok('every entry carries mana and an increase chance', all.every(s => s.mana > 0 && s.inc > 0));
  ok('reagents are [name, count] pairs',
     all.every(s => s.reagents.every(r => Array.isArray(r) && r.length === 2)));
  ok('the table is frozen so a plan cannot edit the mechanics', Object.isFrozen(KRAANAN));
  ok("the operator's triple is all level 2",
     OPERATOR_TRIPLE.every(n => KRAANAN[n]?.level === 2));
  // The thing the operator's "3 skills" phrasing hides, and the reason the sets are derived.
  ok('level 2 actually holds FIVE drillable spells, not three',
     drillableAtLevel(2).length === 5, drillableAtLevel(2).join(', '));
  ok('and each level list is ordered best-odds first',
     [2, 3, 4].every(l => drillableAtLevel(l).every(
       (n, i, a) => i === 0 || KRAANAN[a[i - 1]].inc >= KRAANAN[n].inc)));
  ok('super strength has the best odds among level 2 buffs, at inc 30',
     buffsAtLevel(2)[0] === 'super strength' && KRAANAN['super strength'].inc === 30);
  ok('haste is the bench, at inc 15 and five snacks a cast',
     KRAANAN.haste.inc === 15 && KRAANAN.haste.reagents[0][0] === 'snack' &&
     KRAANAN.haste.reagents[0][1] === 5);
  // creaweap.kod:55-57 — plReagents = $. This is what makes the factory cheap.
  ok('create weapon costs NO reagents, which is what makes the factory free',
     KRAANAN['create weapon'].reagents.length === 0);
  // enchwp.kod:52 — viCast_time = 30000. The operator quoted 30s from memory and was right.
  ok('enchant weapon really does take thirty seconds', KRAANAN['enchant weapon'].castMs === 30_000);
  ok('and create weapon is effectively instant beside it', KRAANAN['create weapon'].castMs === 500);
}

console.log('');
console.log('EVERY Kraanan buff reports one target — so "needs no target" is the wrong test');
{
  // persench.kod:51,62-72: vbCanCastOnOthers defaults TRUE and no Kraanan buff overrides it, so
  // GetNumSpellTargets answers 1 for all of them. A filter on targets === 0 finds none.
  ok('bless, super strength, haste and resist poison all take a target',
     ['bless', 'super strength', 'haste', 'resist poison'].every(n => KRAANAN[n].targets === 1));
  const naive = Object.entries(KRAANAN).filter(([, s]) => s.level === 2 && s.targets === 0);
  ok('so the naive "targets === 0" test finds NO drillable level-2 spell at all', naive.length === 0);
  // The right test: can it be aimed at the caster? Self-recast is legal, so yes for the buffs.
  const solo = selfTargetable(2).map(s => s.spell);
  ok('but self-targeting finds the buffs, because self-recast is legal', solo.includes('bless'));
  ok('and super strength', solo.includes('super strength'));
  ok('and NOT enchant weapon, which needs a weapon rather than a body',
     !solo.includes('enchant weapon'));
  ok('the list is ordered best-odds first',
     selfTargetable(2).every((s, i, a) => i === 0 || a[i - 1].inc >= s.inc));
  ok('and the claim that self-recast is legal cites the setting that makes it so',
     /settings\.kod:80/.test(SRC) && /pbCanRecastSelfEnchantment/.test(SRC));
}

console.log('');
console.log('the learn gate is computed, not quoted as a constant');
{
  // A character who has only been into Kraanan, at level 2, with a level-2 weapon skill.
  const g = learnGate({ intellect: 40, kraanan: 2, weapon: 2, level: 3 });
  ok('it returns a need and the points it was derived from',
     Number.isFinite(g.need) && Number.isFinite(g.points));
  ok('and it is bounded below by MIN_NEEDED_TO_ADVANCE = 75', g.need >= 75);
  ok('it is measured against the best three, so the ceiling is 3*99', g.max === 297);
  // Intellect is a straight subtraction: (rawInt * 2 * 7)/5 = 2.8 per point.
  const dumb = learnGate({ intellect: 0, kraanan: 2, weapon: 2, level: 3 });
  const smart = learnGate({ intellect: 50, kraanan: 2, weapon: 2, level: 3 });
  ok('intellect lowers the bar', smart.need < dumb.need, `${smart.need} vs ${dumb.need}`);
  // Generalisation raises it: every school you have been into adds its level's points.
  const general = learnGate({ intellect: 40, kraanan: 2, weapon: 2, shalille: 3, qor: 2, level: 3 });
  ok('and being in other schools raises it', general.need >= g.need, `${general.need} vs ${g.need}`);
  // THE SHORTCUT, which is worth more than all of the above.
  const already = learnGate({ intellect: 40, kraanan: 3, knowsOneAtLevel: true, level: 3 });
  ok('knowing one spell at the level short-circuits the whole thing',
     /returns SUCCESS/.test(already.why));
  ok('and the shortcut is stated on every answer, not just that one',
     /unlocks/.test(g.shortcut) && /10626/.test(g.shortcut));
  ok('the recipe says so too, because it decides when to STOP drilling',
     script.recipe.notes.some(n => /only one that costs anything/i.test(n)));
}

console.log('');
console.log('the plan prices itself before anything is driven');
{
  const w = weaponCycle({ iterations: 10 });
  // 3 elderberries + 1 orc tooth per enchant (enchwp.kod:63-65); the factory half is free.
  ok('the weapon cycle prices only the enchant, since the factory is free',
     JSON.stringify(w.buy) === JSON.stringify([['elderberry', 30], ['orc tooth', 10]]),
     JSON.stringify(w.buy));
  const b = drill('bless', { casts: 10, target: 't6' });
  ok('bless prices 2 mushrooms and 2 sapphires a cast',
     JSON.stringify(b.buy) === JSON.stringify([['mushroom', 20], ['sapphire', 20]]));
  const s = drill('super strength', { casts: 10, target: 't6' });
  ok('super strength prices 2 mushrooms and an orc tooth a cast',
     JSON.stringify(s.buy) === JSON.stringify([['mushroom', 20], ['orc tooth', 10]]));
  ok('a single-target drill with no target says it needs one',
     drill('bless', { casts: 2 }).partner !== null);
  ok('and it prices and plans in the same breath, now that nothing gates it',
     b.buy.length > 0 && b.steps.length > 1);
  ok('and one with a target does not', b.partner === null);
}

console.log('');
console.log('the weapon cycle is the factory the operator described, in his order');
{
  const cycle = weaponCycle({ iterations: 3, maxMana: 65 });
  const iters = cycle.steps.filter(s => s.do === 'verify' && /^factory/.test(s.why ?? ''));
  ok('it plans one iteration per requested weapon', iters.length === 3, `${iters.length}`);
  // create -> enchant -> drop, and the enchant must aim at what was ACTUALLY made, because
  // creaweap.kod:63-110 picks the class from spellpower: mace/short sword/hammer/axe/...
  ok('the cast that makes the weapon asks the broker what it made',
     /observe_created: true/.test(SRC));
  ok('and the applied spell targets that observed name rather than a guessed one',
     /spell: apply, target: weapon/.test(SRC));
  ok('the source says why guessing is wrong, naming the spellpower table',
     /creaweap\.kod:63-110/.test(SRC));
  ok('and it drops the weapon whatever happened, since a cast-on weapon is spent for ever',
     /ATCK_WEAP_MAGIC/.test(SRC) && /mend\.kod:83-89/.test(SRC));
  // 65 mana against 15 + 17 = 32 an iteration is two iterations a bar.
  const six = weaponCycle({ iterations: 6, maxMana: 65 }).steps.filter(s => s.do === 'rest').length;
  ok('and it rests every two iterations on a 65 bar, since one costs 32 mana', six === 2, `${six}`);
}

console.log('');
console.log('the composite loop is the operator\'s, plus the step-out the cap pays for');
{
  // Build it with the allowlist bypassed so the real shape is under test rather than the refusal.
  const spells = ['bless', 'super strength'];
  const t = trainLevel2({ rounds: 3, spells, stepOut: 800, home: 801 });
  ok('it plans rather than refusing', t.steps.length > 1);
  const buffs = t.steps.filter(s => s.do === 'verify' && /buff the room/.test(s.why ?? ''));
  ok('it plans a buff round per spell per round', buffs.length === 6, `${buffs.length}`);
  const walks = t.steps.filter(s => s.do === 'walk');
  ok('and steps out and back between rounds', walks.length === 4, `${walks.length}`);
  // These hold either way, because they are about what the file SAYS.
  ok('the step-out is justified by the refund, not by taste',
     /player\.kod:1465/.test(SRC) && /refund 2 against the botting cap/.test(SRC));
  ok('and the cap is described as improves, not casts — the thing everyone gets wrong',
     /ONLY A SUCCESSFUL IMPROVE COSTS A POINT/.test(SRC) && /player\.kod:6783-6786/.test(SRC));
  ok('the default home is the Temple of Kraanan', script.params.home.default === 801);
  ok('and the temple bonus is cited where it is claimed',
     /tempkra\.kod:283-294/.test(SRC));
}

console.log('');
console.log('the venue problem is written down, because it invalidates the obvious rooms');
{
  ok('the ROOM_NO_COMBAT refusal is cited against the kod that does it',
     /persench\.kod:107-114/.test(SRC));
  ok('with the flag value, so the map can be filtered on it', /0x0002/.test(SRC));
  ok('and the count of rooms it rules out', /67 rooms/.test(SRC));
  ok('the round detects that refusal at run time and stops asking',
     /cannot cast enchantments upon others here/.test(SRC) && /roomForbidsOthers/.test(SRC));
  ok('Kraanan\'s crowd bonus is cited', /spell\.kod:2168-2170/.test(SRC));
  ok('and so is the twist that a crowd lengthens buffs and slows re-casting',
     /re-castable LESS often|re-castable less often/i.test(SRC));
}

console.log('');
console.log('the things that separate this school from Shal\'ille are stated, not assumed');
{
  ok('stamina is named as the requisite stat, with the line', /spell\.kod:392-404/.test(SRC));
  ok('the soft cap at 2*stamina-1 is cited', /SOFTCAP_PENALTY/.test(SRC) && /2\*stamina-1/.test(SRC));
  ok('and Kraanan asking no karma at all is cited',
     /spell\.kod:483-496/.test(SRC) && /NO KARMA/.test(SRC));
  ok('the shared school-cast pool is cited, with the divisor',
     /CASTS_PER_PERCENT_BONUS = 7/.test(SRC) && /spell\.kod:1441/.test(SRC));
  ok('and the conclusion drawn from it — spreading is free, not a compromise',
     /SPREADING ACROSS A LEVEL IS FREE/.test(SRC));
}

console.log('');
console.log('BOTH ENGINES ARE LEVEL-AGNOSTIC, which is the generalisation that was asked for');
{
  // The operator: "these parts will be reusable for building higher levels of kraanan ... the
  // 'buff everyone else in the room plus buff yourself'-part".
  ok('level 2 has a buff set', buffsAtLevel(2).includes('bless') &&
     buffsAtLevel(2).includes('super strength'));
  ok('and so does level 3, with the three he named',
     ['night vision', 'magic shield', 'free action'].every(n => buffsAtLevel(3).includes(n)));
  ok('and level 4, with the two he named',
     ['eagle eyes', 'deflect'].every(n => buffsAtLevel(4).includes(n)));
  // The sets are DERIVED from the kind column, so adding a spell to the table adds it everywhere.
  ok('the sets are derived from the table, never listed by hand',
     buffsAtLevel(3).every(n => KRAANAN[n].kind === 'buff' && KRAANAN[n].level === 3));
  ok('buffRoom takes any of them without knowing its level',
     ['bless', 'night vision', 'deflect'].every(n => buffRoom({ spell: n }).do === 'verify'));
  // And the composite loop is level-parameterised rather than level-2-shaped.
  ok('trainLevel builds a plan for every level that has buffs',
     [2, 3, 4].every(l => trainLevel({ level: l, rounds: 2 }).buy.length > 0));
  ok('and refuses a level that has none, rather than planning nothing',
     trainLevel({ level: 1, rounds: 2 }).steps[0].fn({}) === false);
  ok('trainLevel2 is a thin wrapper, kept because the operator named that exact set',
     trainLevel2({ rounds: 2 }).why.includes('level 2'));
}

console.log('');
console.log('THE MEND CYCLE: the same factory, a different spell cast on the weapon');
{
  // The operator: "'mend' actually has the same create-weapon-cycle as 'enchant weapon'".
  ok('mend is classed as a weapon spell, like enchant weapon and glow',
     weaponSpells().includes('mend') && weaponSpells().includes('enchant weapon') &&
     weaponSpells().includes('glow'));
  ok('and they span three different school levels through one loop',
     new Set(weaponSpells().map(n => KRAANAN[n].level)).size === 3);
  const m = weaponCycle({ iterations: 3, apply: 'mend' });
  const e = weaponCycle({ iterations: 3, apply: 'enchant weapon' });
  ok('the mend cycle plans iterations like the enchant one does',
     m.steps.filter(s => /^factory/.test(s.why ?? '')).length === 3);
  ok("and prices mend's own reagents, not the enchant's",
     JSON.stringify(m.buy) === JSON.stringify([['sapphire', 3], ['orc tooth', 3]]),
     JSON.stringify(m.buy));
  ok('while the enchant cycle prices elderberries and orc teeth',
     JSON.stringify(e.buy) === JSON.stringify([['elderberry', 9], ['orc tooth', 3]]),
     JSON.stringify(e.buy));
  ok('an unknown apply refuses and names the ones that work',
     weaponCycle({ apply: 'bless' }).steps[0].fn({}) === false);
  ok('and drilling a weapon spell alone routes to the factory, not a cast loop',
     drill('mend', { casts: 2 }).why.includes('factory'));

  // WHY IT WORKS AT ALL, and the operator's claim is the load-bearing one.
  ok('the file explains that a created weapon is ALWAYS below full hits',
     /creaweap\.kod:112-114/.test(SRC) && /SPELLPOWER_MAXIMUM. is 99/.test(SRC));
  // AND WHY IT IS ONE MEND PER WEAPON, which is the part that forces the factory.
  ok('and that mend leaves the weapon at the exact state mend refuses',
     /mend\.kod:83-89/.test(SRC) && /perfect condition/.test(SRC));
  ok('mend has the worst odds in the school, at inc 10', KRAANAN.mend.inc === 10);
  ok('but no cast time, where the enchant has thirty seconds',
     KRAANAN.mend.castMs === 0 && KRAANAN['enchant weapon'].castMs === 30000);
}

console.log('');
console.log('durations are read per spell, because the spread across them is enormous');
{
  // The operator called these "increasingly long durations". They are, and it is a COST.
  const d = (n) => durationRange(n, 30);
  ok('deflect is the short one — tens of seconds', d('deflect').maxSec <= 60);
  ok('night vision is the long one — over half an hour at the ceiling',
     d('night vision').maxSec > 1800, `${d('night vision').maxSec}s`);
  ok('and the higher level really does last longer',
     d('bless').maxSec < d('night vision').maxSec);
  // magic shield is the one that does NOT roll random(d/2, d) — mshield.kod returns it flat.
  ok('magic shield alone has no random halving, so its floor is its ceiling',
     d('magic shield').minSec === d('magic shield').maxSec);
  ok('every other buff has a floor half its ceiling',
     d('bless').minSec === Math.trunc(d('bless').maxSec / 2));
  // THE POINT: the re-ask interval comes from the spell, not from a constant.
  const short = buffRoom({ spell: 'deflect' }).why;
  const long = buffRoom({ spell: 'night vision' }).why;
  ok('so buffRoom waits a different time for a different spell',
     short !== long && /Re-ask after \d+s/.test(short) && /Re-ask after \d+s/.test(long));
  ok('and it waits longer for the long one',
     Number(long.match(/Re-ask after (\d+)s/)[1]) > Number(short.match(/Re-ask after (\d+)s/)[1]));
  ok('a spell with no duration in the table still gets a hold rather than crashing',
     /Re-ask after \d+s/.test(buffRoom({ spell: 'haste' }).why));
}

console.log('');
console.log('a shopping list has one line per reagent, because a counter is one visit');
{
  // Level 3 wants red mushrooms for BOTH magic shield and free action, and elderberries for both
  // night vision and the enchant that fills its cooldown. Two lines for one reagent is not a list.
  const t = trainLevel({ level: 3, rounds: 2 });
  const names = t.buy.map(([n]) => n);
  ok('the level-3 plan does need the same reagent for two different spells',
     KRAANAN['magic shield'].reagents.some(([n]) => n === 'red mushroom') &&
     KRAANAN['free action'].reagents.some(([n]) => n === 'red mushroom'));
  ok('and still prices it on ONE line', names.length === new Set(names).size, names.join(', '));
  ok('with the counts summed rather than one of them dropped',
     t.buy.find(([n]) => n === 'red mushroom')?.[1] === 4,
     JSON.stringify(t.buy.find(([n]) => n === 'red mushroom')));
  ok('every level prices on unique lines',
     [2, 3, 4].every(l => {
       const b = trainLevel({ level: l, rounds: 2 }).buy.map(([n]) => n);
       return b.length === new Set(b).size;
     }));
}

console.log('');
console.log('the script object is shaped like a promoted fleetscript');
{
  ok('it is named', script.name === 'practice-kraanan');
  ok('it is pinned to a commit', /^[0-9a-f]{7,40}$/.test(script.provenance?.pinned ?? ''));
  ok('and declares what it depends on', (script.provenance?.touches ?? []).length >= 2);
  ok('it names m59-rts-safety among them, since that file gates the whole script',
     (script.provenance?.touches ?? []).some(t => /rts-safety/.test(t)));
  ok('it carries a recipe with an effect, a run line and costs',
     Boolean(script.recipe?.effect && script.recipe?.run && script.recipe?.cost));
  // THE HONESTY PIN. Nothing here has been driven; the recipe must not imply it has.
  ok('and its `measured` says plainly that nothing was measured',
     /NOT MEASURED/.test(script.recipe.cost.measured));
  // The allowlist used to head this list because it blocked everything else. It is retired, so
  // the first thing a run actually needs is the spells themselves.
  ok('needs no longer leads with the retired allowlist',
     !script.recipe.needs.some(n => /allowlist/i.test(n)));
  ok('and leads with the spells being known instead',
     /already known/.test(script.recipe.needs[0]));
  ok('agents is required', script.params.agents.required === true);
  ok('spell is optional, because the composite loop is the point',
     script.params.spell.default === null);
  ok('and maxMana warns that a value read at login is WRONG',
     /ComputeMaxMana/.test(script.params.maxMana.describe));
  ok('every practisable spell has a function', Object.keys(PRACTICE).length >= 5);
}

console.log('');
console.log('an unknown spell refuses rather than planning nothing silently');
{
  const steps = drill('nonesuch', { casts: 3 }).steps;
  ok('it refuses', steps.length === 1 && steps[0].do === 'verify');
  ok('and the refusal is a bare false', steps[0].fn({}) === false);
  ok('carrying the name that was not found', /nonesuch/.test(steps[0].why));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
