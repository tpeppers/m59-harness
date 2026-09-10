#!/usr/bin/env node
// A PRACTICE PLAN THAT NAMES A TOOL NOBODY IMPLEMENTS — offline, no socket, no roster.
//
//   node tools/m59-practice-test.mjs
//
// WHAT THIS PINS, and every one of them is a mistake made while writing the file it guards.
//
// 1. A STEP THAT NAMES A TOOL THAT DOES NOT EXIST. `practice-shalille.mjs` was written with
//    `act('stand')`, `act('drop')` and `rest({ mana })`. None of the three exists: standing is
//    a BOOLEAN FLAG on the `rest` tool, dropping is a VERB of the tool confusingly also called
//    `act` (use/unuse/get/drop/activate/eat/go), and nothing in this repository waits on mana
//    at all. All three would have been discovered by driving a character across a town and
//    watching a step fail — which is the expensive way to find out that a name is wrong.
//
//    This is the same shape as m59-keeperaddress-test.mjs: a LINT over the call sites rather
//    than a behaviour test at one of them. 154 offline assertions stayed green through
//    `routeTrapAhead` sending `agent: undefined` for weeks, because not one of them asked
//    whether a call was ADDRESSED. Not one here asked whether a tool was NAMED.
//
// 2. A REFUSAL THAT IS TRUTHY. `verify` scores its step as `Boolean(v)` (m59-fleetscript.mjs),
//    so a refusal shaped like the rest of this codebase's return values — `{ ok: false, why }`
//    — PASSES, because an object is truthy. Both refusal steps in the file were written that
//    way, which would have turned "cure disease cannot be practised" into a silent success and
//    then reported a run of casts that never happened. The reason belongs in verify's second
//    argument, and the function must return a bare false.
//
// 3. A SPELL LISTED AS SOLO-DRILLABLE THAT IS NOT. The list is DERIVED from the gate column
//    rather than hand-written, so correcting one spell's gate in one place removes it from
//    every answer. Rescue is the case that makes this worth pinning: it needs no target, which
//    is the property people look for, and it is still gated — on a held Token, a pending
//    rescue, and a recent player attack.
import { readFileSync } from 'node:fs';
import { SHALILLE, PRACTICE, soloDrillable, rescue, spiritualHammer, hospice, identify,
         cureDisease, holyResolve, holyWeapon, script } from './fleetscripts/practice-shalille.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  ' + extra : ''}`); }
};

// The broker is the authority on what tools exist, and it is read rather than listed here —
// a hand-copied list of tool names is the thing this test exists to stop.
const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
const TOOLS = new Set([...BROKER.matchAll(/^\s*name: '([a-z_]+)',$/gm)].map(m => m[1]));
// `act`'s own verbs come out of its schema enum for the same reason.
const ACT_VERBS = new Set(
  (BROKER.match(/verb: \{ type: 'string', enum: \[([^\]]+)\]/) ?? [, ''])[1]
    .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean));

console.log('');
console.log('the broker was read, not assumed');
{
  ok('the broker exposes a tool list this test could find', TOOLS.size > 50, `found ${TOOLS.size}`);
  ok('and `cast` is one of them, or nothing below means anything', TOOLS.has('cast'));
  ok('`rest` is a tool', TOOLS.has('rest'));
  ok('there is NO `stand` tool — it is a flag on rest', !TOOLS.has('stand'));
  ok('there is NO bare `drop` tool — it is a verb of `act`', !TOOLS.has('drop'));
  ok("and `act`'s verb enum was found and holds drop", ACT_VERBS.has('drop'), [...ACT_VERBS].join(','));
}

console.log('');
console.log('every act() step in every practice plan names a tool that exists');
{
  // Build one of every plan, with a patient/item supplied so the loop-bearing branch is the
  // one under test rather than the refusal branch.
  const plans = {
    rescue: rescue({ casts: 3, maxMana: 65 }),
    'spiritual hammer': spiritualHammer({ casts: 3, maxMana: 65 }),
    hospice: hospice({ casts: 3, maxMana: 65, patient: 't6' }),
    identify: identify({ casts: 3, maxMana: 65, item: 'long sword' }),
    'holy resolve': holyResolve({ casts: 3, maxMana: 65 }),
    'holy weapon': holyWeapon({ casts: 3, maxMana: 65 }),
  };
  let checked = 0, bad = [];
  for (const [name, plan] of Object.entries(plans)) {
    for (const step of plan.steps) {
      if (step.do !== 'act') continue;
      checked++;
      if (!TOOLS.has(step.tool)) bad.push(`${name}: tool "${step.tool}"`);
      // A step calling the `act` tool must name a verb that tool accepts.
      if (step.tool === 'act' && step.args?.verb && !ACT_VERBS.has(step.args.verb))
        bad.push(`${name}: act verb "${step.args.verb}"`);
    }
  }
  ok('there are act() steps to check at all', checked > 0, `checked ${checked}`);
  ok('and every one of them addresses a real tool and a real verb',
     bad.length === 0, bad.join('; '));
}

console.log('');
console.log('no plan asks rest() for something rest() cannot do');
{
  // `rest` waits on health and vigor. There is no mana target anywhere in the harness, so a
  // `rest({ mana })` silently waits for the WRONG THING and returns when health is fine.
  // ENOUGH CASTS TO CROSS A BAR. At 3 casts nothing rests -- 65 mana buys 4 rescues -- so the
  // first version of this assertion failed on its own fixture and said the code had no rests.
  const all = [rescue({ casts: 12 }), spiritualHammer({ casts: 12 }), hospice({ casts: 12, patient: 't6' }),
               identify({ casts: 12 }), holyResolve({ casts: 40 })].flatMap(p => p.steps);
  const restSteps = all.filter(s => s.do === 'rest');
  ok('the plans do rest between bars', restSteps.length > 0, `${restSteps.length} rest step(s)`);
  ok('and not one of them passes a mana target, because rest cannot honour one',
     restSteps.every(s => s.mana === undefined));
  const src = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');
  const want = src.slice(src.indexOf("case 'rest': {"), src.indexOf("case 'rest': {") + 300);
  ok("and the rest step really does only take health and vigor, as claimed",
     /health: step\.health/.test(want) && /vigor: step\.vigor/.test(want) && !/mana/.test(want));
  // So the wait is polled instead. That poll must read BOTH status shapes.
  const psrc = readFileSync(new URL('./fleetscripts/practice-shalille.mjs', import.meta.url), 'utf8');
  ok('mana is polled instead, and reads both status shapes',
     /vitals\?\.mana\?\.value \?\? st\?\.mana\?\.value/.test(psrc));
  ok('and an unreadable mana is a refusal rather than a pass',
     /if \(m == null\) return false/.test(psrc));
}

console.log('');
console.log('a refusal is FALSY, or it is a silent success');
{
  ok('cure disease refuses', cureDisease().steps.length === 1);
  ok('and its verify returns a bare false, not an object',
     cureDisease().steps[0].fn({}) === false);
  ok('and carries the reason where verify actually reports it',
     /cdisease\.kod/.test(cureDisease().steps[0].why));
  const noPatient = hospice({ casts: 5 });
  ok('hospice with no patient refuses instead of planning casts',
     noPatient.steps.length === 1 && noPatient.steps[0].do === 'verify');
  ok('and that refusal is falsy too', noPatient.steps[0].fn({}) === false);
  ok('and it names the line that refuses', /hospice\.kod:88/.test(noPatient.steps[0].why));
  // The dispatcher's own miss has to refuse the same way.
  ok('an unknown spell refuses rather than planning nothing silently',
     script.params.spell.required === true);
}

console.log('');
console.log('the solo-drillable list is derived from the gates, not asserted');
{
  const solo = soloDrillable(3).map(s => s.spell);
  ok('spiritual hammer is solo-drillable — no gate at all', solo.includes('spiritual hammer'));
  ok('holy resolve is too', solo.includes('holy resolve'));
  // THE CASE THAT MAKES THIS WORTH A TEST. Rescue takes no target, which is the property
  // people search for, and it is still gated on the caster's own state.
  ok('rescue is NOT, despite needing no target — it is gated on Token/pending/recent-attack',
     !solo.includes('rescue') && SHALILLE.rescue.targets === 0 && SHALILLE.rescue.gate !== null);
  ok('hospice is not, because it needs a wounded body', !solo.includes('hospice'));
  ok('cure disease is not', !solo.includes('cure disease'));
  ok('and the list is ordered best-odds first',
     soloDrillable(3).every((s, i, a) => i === 0 || a[i - 1].inc >= s.inc));
  ok('every practisable spell has a function', Object.keys(PRACTICE).length >= 6);
}

console.log('');
console.log("the table's own shape holds");
{
  ok('every entry carries a kod source', Object.values(SHALILLE).every(s => typeof s.src === 'string' && s.src));
  ok('every entry carries a school level 1-6',
     Object.values(SHALILLE).every(s => s.level >= 1 && s.level <= 6));
  ok('every entry carries mana and an increase chance',
     Object.values(SHALILLE).every(s => s.mana > 0 && s.inc > 0));
  ok('reagents are [name, count] pairs',
     Object.values(SHALILLE).every(s => s.reagents.every(r => Array.isArray(r) && r.length === 2)));
  ok('the table is frozen so a plan cannot edit the mechanics', Object.isFrozen(SHALILLE));
  // The three the operator picked, by name, so a later edit that drops one is visible.
  ok("the operator's level-3 triple is all present",
     ['rescue', 'spiritual hammer', 'hospice'].every(n => SHALILLE[n]?.level === 3));
  ok('rescue is the cheapest of the three to stock and the slowest to advance',
     SHALILLE.rescue.inc < SHALILLE['spiritual hammer'].inc &&
     SHALILLE.rescue.reagents.length === 1);
}

console.log('');
console.log('the plan prices itself before anything is driven');
{
  const r = rescue({ casts: 10 });
  ok('rescue prices 1 emerald a cast',
     JSON.stringify(r.buy) === JSON.stringify([['emerald', 10]]));
  const h = spiritualHammer({ casts: 10 });
  ok('hammer prices 2 emeralds and an orc tooth a cast',
     JSON.stringify(h.buy) === JSON.stringify([['emerald', 20], ['orc tooth', 10]]));
  ok('hospice prices 3 herbs a cast',
     JSON.stringify(hospice({ casts: 10, patient: 't6' }).buy) === JSON.stringify([['herb', 30]]));
  ok('and each plan says whether it needs a second body',
     r.partner === null && h.partner === null && hospice({ casts: 1, patient: 't6' }).partner === 't6');
}

console.log('');
console.log('THE FACTORY: a weapon is single-use, so the loop manufactures one per cast');
{
  const f = holyWeapon({ casts: 3, maxMana: 65 });
  const casts = f.steps.filter(s => s.do === 'act' && s.tool === 'cast');
  const made = casts.filter(s => s.args.spell === 'spiritual hammer').length;
  const blessed = casts.filter(s => s.args.spell === 'holy weapon').length;
  const dropped = f.steps.filter(s => s.tool === 'act' && s.args?.verb === 'drop').length;
  ok('it makes one weapon per iteration', made === 3, `made ${made}`);
  ok('blesses each one exactly once', blessed === 3, `blessed ${blessed}`);
  // THE REASON THE DROP IS NOT OPTIONAL HOUSEKEEPING. holywp.kod refuses a weapon that
  // already carries ATCK_SPELL_HOLY (`holyweapon_already_done`), so a blessed hammer can
  // never be practice again. Keeping it fills a pack with things that cannot be used.
  ok('and drops each spent one, because a blessed weapon is refused for ever after',
     dropped === 3, `dropped ${dropped}`);
  ok('the enchant names its target — a spell with one target needs one',
     casts.filter(s => s.args.spell === 'holy weapon').every(s => s.args.target === 'spiritual hammer'));
  // The chain only works because the factory's product IS a weapon.
  ok('the factory spell and the enchant are different school LEVELS, so one loop feeds two gates',
     SHALILLE['spiritual hammer'].level === 3 && SHALILLE['holy weapon'].level === 2);
  ok('it prices all three reagents, the factory feedstock included',
     JSON.stringify(f.buy) === JSON.stringify([['emerald', 6], ['orc tooth', 6], ['fairy wing', 9]]));
  // 65 mana against 15 + 17 = 32 an iteration is two iterations a bar.
  const six = holyWeapon({ casts: 6, maxMana: 65 }).steps.filter(s => s.do === 'rest').length;
  ok('and rests every two iterations on a 65 bar, since one costs 32 mana', six === 2, `rested ${six}`);
}

console.log('');
console.log('mana sizes the rest interval rather than being ignored');
{
  // 65 mana / 16 a cast = 4 casts a bar, so 8 casts must contain exactly one rest block.
  const eight = rescue({ casts: 8, maxMana: 65 }).steps.filter(s => s.do === 'rest').length;
  ok('8 rescues on a 65 bar rest once', eight === 1, `rested ${eight}`);
  // A tiny ceiling must not divide to zero and loop forever.
  const tiny = rescue({ casts: 3, maxMana: 4 });
  ok('a mana ceiling below one cast still plans, one cast at a time',
     tiny.steps.filter(s => s.do === 'act' && s.tool === 'cast').length === 3);
  ok('and the recipe warns that maxMana read at login is WRONG',
     /ComputeMaxMana/.test(script.params.maxMana.describe));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
