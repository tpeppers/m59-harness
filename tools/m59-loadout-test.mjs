#!/usr/bin/env node
// THE LOADOUT FORMAT AND THE RECONCILER, AGAINST SCRATCH DIRECTORIES. Offline, safe any
// time — it never reads the real loadout directory, never starts a broker, and never
// touches the network:
//
//   node tools/m59-loadout-test.mjs
//
// What is pinned here is every way a loadout can look right and mean something else.
//
//   * A LOADOUT THAT SAYS NOTHING MUST CHANGE NOTHING. It is an overlay: every helper
//     returns null for an empty one, and null means "the behaviour that was already
//     there", not "protects nothing". Getting that backwards would have a character with
//     an empty loadout sell its armour the first time it stood at a counter.
//   * SUBSTRING MATCHING. This repository has paid for it twice — `keep: ['mace']`
//     protected the item literally called "broken mace", and a junk list containing
//     "mushroom" would sell the edible ones, which are food.
//   * A MAX BELOW A MIN, which is not a preference but a loop: buy up to the min, sell
//     down to the max, pay the vendor spread on every lap, for ever.
//   * A FLOOR THAT PROTECTS THE WHOLE STACK. Twelve elderberry with a floor of twelve are
//     all protected and the thirteenth is not, so the keep test has to be able to count.
//   * THE LEARNING COST WITH NO CONSTANTS. planner.json exports nulls when the source tree
//     is absent, and a planner that substitutes a plausible slope prints an authoritative
//     invented number, which is worse than printing none.
//   * A CACHE THAT DOES NOT NOTICE THE FILE CHANGED. The keeper reads this every pass; a
//     loadout edited in the planner and not picked up is indistinguishable from one that
//     was never saved.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-loadout-test-'));
process.env.M59_LOADOUT_DIR = join(root, 'loadouts');

const L = await import('./m59-loadout.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const pack = (...pairs) => pairs.map(([name, amount = 1]) => ({ name, amount }));

console.log('names on the filesystem');
{
  ok('a character name becomes a slug', L.slugOf('Kermit') === 'kermit');
  ok('spaces and punctuation fold', L.slugOf("Miss Piggy's") === 'miss-piggy-s');
  ok('A TRAVERSAL IS NOT ESCAPED, IT IS DROPPED — nothing can walk out of the directory',
     L.slugOf('../../substrate/fleets/prod') === 'substrate-fleets-prod');
  ok('a name with nothing usable in it is refused rather than defaulted',
     L.slugOf('../..') === null && L.slugOf('') === null && L.slugOf('   ') === null);
  ok('and a refused name has no path', L.loadoutPath('...') === null);
}

console.log('\nan empty loadout changes nothing');
{
  const empty = L.blank('Nobody');
  ok('there is no keep test', L.keepTest(empty) === null);
  ok('there is no sell test', L.sellTest(empty) === null);
  ok('there is no drop ranking', L.dropRank(empty) === null);
  ok('and none of them is offered for a missing loadout either',
     L.keepTest(null) === null && L.sellTest(null) === null &&
     L.dropRank(null) === null && L.reconcile(null) === null);
  const r = L.reconcile(empty, { items: pack(['mace'], ['rat pelt', 9]) });
  ok('reconciling an empty loadout asks for nothing and sheds nothing',
     r.buy.length === 0 && r.sell.length === 0 && r.ok);
}

console.log('\nmatching is exact unless it is asked not to be');
{
  ok('the display name matches itself, whatever the casing',
     L.entryMatches({ item: 'Leather Armor' }, 'leather armor'));
  ok('A BROKEN MACE IS NOT A MACE. The keep list that protected one is the reason every ' +
     'character hauled its shattered weapons around for ever',
     !L.entryMatches({ item: 'mace' }, 'broken mace'));
  ok('an edible mushroom is not a mushroom', !L.entryMatches({ item: 'mushroom' }, 'edible mushroom'));
  ok('...and the plain mushroom still is', L.entryMatches({ item: 'mushroom' }, 'mushroom'));
  ok('contains is available, and has to be asked for',
     L.entryMatches({ item: 'mushroom', match: 'contains' }, 'blue mushroom'));
  ok('prefix too', L.entryMatches({ item: 'leather', match: 'prefix' }, 'leather armor') &&
     !L.entryMatches({ item: 'armor', match: 'prefix' }, 'leather armor'));
}

console.log('\nnormalising what somebody typed');
{
  const { loadout, problems } = L.normalise({
    character: 'Kermit',
    plan: { schools: { Kraanan: 3, Riija: 'nine', Faren: 9 } },
    carry: [{ item: 'elderberry', min: 20, max: 4 }, { item: 'elderberry', min: 1 },
            { item: 'herb', min: -3 }],
    sell: ['emerald', 'herb', ''],
    keep: ['herb'],
    gear: { weapon: ['mace'], slots: { body: ['leather armor'], tail: ['a hat'] } },
  });
  const said = (re) => problems.some(p => re.test(p));
  ok('a school level that is not a number is refused', !('Riija' in loadout.plan.schools) && said(/not a level/));
  ok('a seventh school level is refused — the game has six', !('Faren' in loadout.plan.schools) && said(/the game has six/));
  ok('a real one survives', loadout.plan.schools.Kraanan === 3);
  const targeted = L.normalise({ character: 'x', plan: {
    learning_target: { track: 'Kraanan' }, abilities: [],
  } }).loadout;
  ok('the learning target is a plan field and object input normalises to its track name',
     targeted.plan.learning_target === 'Kraanan');
  const expanded = L.plannedAbilities({
    abilities: [{ name: 'dodge', kind: 'skill' }], schools: { Faren: 2 },
  }, [
    { name: 'spark', kind: 'spell', school: 'Faren', level: 1 },
    { name: 'fireball', kind: 'spell', school: 'Faren', level: 2 },
    { name: 'too far', kind: 'spell', school: 'Faren', level: 3 },
  ], [{ name: 'spark', kind: 'spell' }]);
  ok('school plans expand into their unlearned spells without losing explicit skills',
     expanded.map(row => row.name).join(',') === 'dodge,fireball', JSON.stringify(expanded));
  const weaponQueue = L.normalise({ character: 'x', plan: {
    weapon_level: 5,
    learning_queue: [
      { track: 'weaponcraft', level: 2 }, { track: 'weaponcraft', level: 3 },
      { track: 'weaponcraft', level: 4 }, { track: 'weaponcraft', level: 5 },
    ],
  } }).loadout.plan;
  const weaponExpanded = L.plannedAbilities(weaponQueue, [
    { name: 'dodge', kind: 'skill', level: 2, learnable: true, for_sale: true },
    { name: 'short sword fighting', kind: 'skill', level: 2, learnable: true, for_sale: true },
    { name: 'fencing', kind: 'skill', level: 3, learnable: true, for_sale: true },
    { name: 'archery', kind: 'skill', level: 5, learnable: true, for_sale: true },
    { name: 'thrust', kind: 'skill', level: 50, learnable: true, for_sale: false },
  ], [{ name: 'dodge', kind: 'skill' }]);
  ok('a Weaponcraft queue expands purchasable skills only, keeps exact level barriers, and skips known skills',
     weaponExpanded.map(row => `${row.name}:${row.queue_stage}`).join(',') ===
       'short sword fighting:1,fencing:2,archery:4', JSON.stringify(weaponExpanded));
  ok('queue rows with an invalid level are reported and refused', (() => {
    const r = L.normalise({ character: 'x', plan: {
      learning_queue: [{ track: 'weaponcraft', level: 9 }],
    } });
    return r.loadout.plan.learning_queue.length === 0 &&
      r.problems.some(p => /learning_queue/.test(p));
  })());
  ok('A MAX BELOW A MIN IS RAISED, not honoured — the pair cannot both be satisfied and ' +
     'the keeper would buy and sell the same item for ever',
     loadout.carry[0].max === 20 && said(/buy and sell the same item for ever/));
  ok('a duplicate is reported', said(/listed twice/));
  ok('a negative floor is read as zero', loadout.carry.find(c => c.item === 'herb').min === 0);
  ok('an empty entry in a name list is reported, not silently dropped', said(/empty entry in sell/));
  ok('sell and keep at once is reported and KEEP WINS — keeping something we should have ' +
     'sold costs a slot, selling something we meant to keep costs the item',
     said(/both the sell and keep lists — kept/));
  ok('a slot nothing here knows is carried through rather than dropped',
     loadout.gear.slots.tail?.[0] === 'a hat' && said(/slot "tail" is not one/));
  ok('a wrong format is read anyway, and said so',
     L.normalise({ format: 'something-else', character: 'x' }).problems.some(p => /format is/.test(p)));
}

console.log('\nan item nothing in the game answers to');
{
  const { problems } = L.normalise({ character: 'x', carry: [{ item: 'sword of plot armour', min: 1 }] });
  const flagged = problems.some(p => /not in the item catalogue/.test(p));
  // The catalogue is compiled from a source tree that may not be here. When it is absent
  // the check cannot run, and NOT running a check is different from passing it.
  ok(L.catalogue().size ? 'an unknown item is reported and kept anyway — the server is the ' +
       'authority, not this snapshot' : 'no catalogue here, so no name check was claimed',
     L.catalogue().size ? flagged : !flagged);
}

console.log('\nthe keep test knows how to count');
{
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 12, max: 24 }],
    keep: ['signet ring'], gear: { weapon: ['mace'], slots: { body: ['leather armor'] } } });

  const atFloor = L.keepTest(loadout, pack(['elderberry', 12]));
  ok('at the floor, the stack is protected', !!atFloor('elderberry'));
  const over = L.keepTest(loadout, pack(['elderberry', 13]));
  ok('ABOVE the floor it is not — that is what a maximum is for', !over('elderberry'));
  const blind = L.keepTest(loadout);
  ok('WITHOUT A PACK IT CANNOT COUNT, so it protects the whole stack: it declines to sell ' +
     'something it might need rather than selling something it does', !!blind('elderberry'));
  ok('the keep list is protected outright', !!blind('signet ring'));
  ok('so is the gear', !!blind('mace') && !!blind('leather armor'));
  ok('and it says why, because a protected item with no reason is unauditable',
     /keep list/.test(blind('signet ring')) && /fight with/.test(blind('mace')));
  ok('anything unmentioned is not protected here — the caller\'s own rules still apply',
     blind('rat pelt') === null);
}

console.log('\nthe same protection, flattened for a door that only takes names');
{
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 12, max: 24 }, { item: 'rat pelt', min: 0, max: 40 }],
    keep: ['signet ring'], gear: { weapon: ['mace'], slots: { body: ['leather armor'] } } });
  const names = L.protectedNames(loadout);

  ok('every source of protection is represented',
     ['signet ring', 'mace', 'leather armor', 'elderberry'].every(n => names.includes(n)));
  // A FLOOR OF ZERO IS NOT A FLOOR. Nineteen of this fleet's loadouts were zeroed for the
  // graveyard shift and `max` is not a guard, so a zero-floor entry must not arrive here
  // looking like one — it would protect the whole stack and stop the fleet selling its loot.
  ok('a floor of ZERO protects nothing, so it is not a name', !names.includes('rat pelt'));
  ok('no duplicates, whatever the casing',
     L.protectedNames(L.normalise({ character: 'x', keep: ['Mace', 'mace'],
                                    gear: { weapon: ['mace'] } }).loadout).length === 1);

  // AN EMPTY LOADOUT PROTECTS NOTHING BY NAME AND THAT IS NOT THE SAME AS "NO LOADOUT".
  // Every other helper here answers null for "say nothing"; this one cannot, because its
  // caller concatenates the result into an argument list. [] is unmisreadable; null would
  // have to be handled at every call site and one day would not be.
  ok('a missing loadout is an empty list rather than null, because the caller concatenates',
     Array.isArray(L.protectedNames(null)) && L.protectedNames(null).length === 0);
  ok('and so is one that protects nothing',
     L.protectedNames(L.normalise({ character: 'x' }).loadout).length === 0);
}

// THE BUG THIS EXISTS FOR IS AT A CALL SITE, SO THE TEST HAS TO LOOK AT ONE.
//
// m59-broker.mjs cannot be imported — importing it takes the fleet lock and starts rejoin
// timers — so this reads the source. A source assertion is a weak test and this is the case
// that earns one: `sell_all` consulted the loadout only on its in-process branch, every
// character on prod is keeper-backed, and so the feature was live exactly where nothing runs.
// Nothing about the loadout FORMAT could have caught that, and Robin sold the 16 sapphires
// and 61 mushrooms his own keep list named on 2026-09-12.
console.log('\nthe keeper-backed branch carries the loadout too');
{
  const src = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const at = src.indexOf("keeperAction(a.agent, s._index, 'sell_all'");
  ok('the keeper-backed sell_all call site is still findable', at > 0);
  ok('sell_all hands the keeper the loadout protected names, not just the caller keep list',
     src.slice(at, at + 400).includes('keep: [...(a.keep || []), ...fromLoadout]'));
  ok('and it is still possible to opt out, which is what ignore_loadout is for',
     src.includes('a.ignore_loadout || !who ? [] : protectedNames(loadoutFor(who))'));
}

console.log('\nthe sell list, and what outranks it');
{
  const { loadout } = L.normalise({ character: 'x', sell: ['emerald', 'mace'], gear: { weapon: ['mace'] } });
  const s = L.sellTest(loadout);
  ok('sell-fodder is named', !!s('emerald'));
  ok('but not when it is also the character\'s weapon', s('mace') === null);
  ok('and a loadout with no sell list has no opinion', L.sellTest(L.blank('x')) === null);
}

console.log('\nreconciling against a real pack');
{
  const { loadout } = L.normalise({ character: 'Kermit',
    carry: [{ item: 'elderberry', min: 20, max: 40 }, { item: 'herb', min: 20, max: 40 }],
    sell: ['blue mushroom'],
    gear: { weapon: ['mace', 'short sword'], slots: { body: ['leather armor'] } },
    purse: { float: 400 } });
  const items = pack(['shilling', 455], ['herb', 42], ['short sword'], ['blue mushroom', 10]);
  const r = L.reconcile(loadout, { items, equipped: [{ name: 'short sword' }] });

  ok('what is short is asked for', r.buy.some(b => b.item === 'elderberry' && b.short === 20));
  ok('what is over the ceiling is shed, down to the ceiling and no further',
     r.sell.some(s => s.item === 'herb' && s.over === 2));
  ok('sell-fodder is shed entirely', r.sell.some(s => s.item === 'blue mushroom' && s.over === 10));
  ok('HOLDING THE SECOND CHOICE IS NOT MISSING THE GEAR — it is one upgrade short, and ' +
     'reporting them alike is how an outfitting run buys a mace for somebody holding one',
     r.gear.weapon.have === 'short sword' && !r.gear.weapon.missing &&
     r.gear.weapon.upgrade_to?.[0] === 'mace');
  ok('and it knows the second choice is actually being wielded', r.gear.weapon.worn === true);
  ok('a slot with nothing in it IS missing, and lands on the buy list',
     r.gear.slots.body.missing && r.buy.some(b => b.item === 'leather armor' && b.gear));
  ok('the purse is read, and the float is not counted as spendable',
     r.purse.have === 455 && r.purse.spendable === 55);
  ok('a floor price is offered for the trip', typeof r.at_least === 'number');
  ok('and the summary does not claim to be fine', r.ok === false && /short/.test(r.summary));
}

console.log('\nwhat the fleet\'s interest board is told');
{
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 20, max: 40 }, { item: 'herb', min: 20, max: 40 }] });
  const w = L.wantsOf(loadout, pack(['herb', 60], ['elderberry', 2]));
  ok('what is short is a want', w.wants.includes('elderberry'));
  ok('what is over the ceiling is spare, by the amount over it', w.spare.get('herb') === 20);
  ok('and something between the two is neither',
     L.wantsOf(loadout, pack(['herb', 30])).wants.length === 1 &&
     L.wantsOf(loadout, pack(['herb', 30])).spare.size === 0);
}

console.log('\nthe order things are given up in');
{
  const { loadout } = L.normalise({ character: 'x', sell: ['blue mushroom'],
    carry: [{ item: 'elderberry', min: 12 }], gear: { weapon: ['mace'] } });
  const rank = L.dropRank(loadout, pack(['elderberry', 12]));
  ok('sell-fodder goes first, ahead of anything the caller had in mind', rank('blue mushroom') === -1);
  ok('protected things go last', rank('elderberry') === 3 && rank('mace') === 3);
  ok('AND SILENCE IS AN ANSWER: anything unmentioned returns null so the keeper\'s own ' +
     'ranking decides, rather than being flattened to the middle of this one',
     rank('rat pelt') === null);
}

console.log('\nthe learning cost');
{
  const none = L.learnCost({ school: 'Qor', level: 2, intellect: 30, constants: {} });
  ok('WITH NO CONSTANTS IT REFUSES TO PRODUCE A NUMBER — an invented cost curve reads as ' +
     'authoritative and is worse than none', none.need === null && /not resolved/.test(none.why));

  // The server's own arithmetic (player.kod:10837): iNeed = iPoints*7 + (297-16*7)
  // - int*14/5, floored at 75.
  const C = { points_slope: 7, min_needed_to_advance: 75, max_learn_points: 16,
              level_points: [1, 2, 4, 6, 8, 10] };
  const a = L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1,
                          intellect: 30, knowOneAtLevel: true, constants: C });
  ok('one level-1 school known is one point: 7 + 185 - 84 = 108', a.need === 108, `got ${a.need}`);
  const b = L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1,
                          intellect: 30, knowOneAtLevel: false, constants: C });
  ok('entering a level nothing is known at yet costs the difference up front — 1 more ' +
     'point, so 7 more', b.need === 115, `got ${b.need}`);
  ok('THE SEVENTH TRACK IS THE WEAPON SKILLS and it is charged like a school',
     L.learnCost({ trackLevels: { weapon: 2, Kraanan: 1 }, school: 'Qor', level: 1,
                   intellect: 30, knowOneAtLevel: true, constants: C }).need === 108 + 2 * 7);
  // Measured somewhere the floor is not in the way. At one point of track the whole cost
  // is under MIN_NEEDED_TO_ADVANCE by 50 intellect, so the difference there is the floor's
  // and not intellect's — which is exactly the reading a planner must not print.
  const deep = { trackLevels: { Kraanan: 3, Qor: 3 }, school: 'Faren', level: 1,
                 knowOneAtLevel: true, constants: C };
  ok('intellect buys the cost down, 14/5 a point',
     L.learnCost({ ...deep, intellect: 30 }).need - L.learnCost({ ...deep, intellect: 50 }).need
       === Math.trunc(50 * 14 / 5) - Math.trunc(30 * 14 / 5),
     `${L.learnCost({ ...deep, intellect: 30 }).need} vs ${L.learnCost({ ...deep, intellect: 50 }).need}`);
  ok('...and once the floor is reached, more intellect buys nothing — a planner that ' +
     'reports the difference there is reporting the bound, not the stat',
     L.learnCost({ trackLevels: { Kraanan: 1 }, school: 'Qor', level: 1, intellect: 50,
                   knowOneAtLevel: true, constants: C }).need === 75);
  ok('and the floor holds it above MIN_NEEDED_TO_ADVANCE',
     L.learnCost({ trackLevels: {}, school: 'Qor', level: 1, intellect: 99,
                   knowOneAtLevel: true, constants: C }).need === 75);
  const scarce = L.learnCost({ trackLevels: { Qor: 1 }, school: 'Qor', level: 2, intellect: 30,
                               knowOneAtLevel: true, prevLevelCount: 1, constants: C });
  const full = L.learnCost({ trackLevels: { Qor: 1 }, school: 'Qor', level: 2, intellect: 30,
                             knowOneAtLevel: true, prevLevelCount: 3, constants: C });
  ok('a thin level below eases the cost to a third (player.kod:10915)',
     scarce.need === Math.trunc(full.need / 3), `${scarce.need} vs ${full.need}`);
  ok('level 1 is measured against the maximum outright, so it says so',
     L.learnCost({ trackLevels: {}, school: 'Qor', level: 1, intellect: 30, constants: C }).have_max === 297);

  // assess, thrust and kick declare viSkill_level = 50 on a table with six entries. The
  // server asks Nth(vlLevelPoints, 50), which falls off the end and returns NIL
  // (blakserv/list.c:178), so they cost nothing — and because iWeapon is a MAX, knowing one
  // HIDES the proficiency levels the character would otherwise be charged for.
  ok('A LEVEL PAST THE END OF THE TABLE IS FREE, not clamped to the last entry',
     L.levelPointsAt(C.level_points, 50) === 0 && L.levelPointsAt(C.level_points, 6) === 10);
  ok('...so a character that knows thrust pays nothing for its weapon track, and the ' +
     'proficiency it also knows disappears into the same max',
     L.learnCost({ trackLevels: { weapon: 50, Kraanan: 1 }, school: 'Qor', level: 1,
                   intellect: 30, knowOneAtLevel: true, constants: C }).need === 108);
  ok('and level 0 — nothing known in that track — is free too',
     L.levelPointsAt(C.level_points, 0) === 0);
}

console.log('\ncan this character learn it');
{
  const C = { points_slope: 7, min_needed_to_advance: 75, max_learn_points: 16,
              level_points: [1, 2, 4, 6, 8, 10] };
  ok('level 1 is reachable from nothing, because iHave is 297 flat there',
     L.canLearn({ have: 0, trackLevels: {}, school: 'Qor', level: 1, intellect: 30,
                  knowOneAtLevel: true, constants: C }).can === true);
  const hard = { have: 60, trackLevels: { Qor: 1, Kraanan: 3 }, school: 'Qor', level: 2,
                 intellect: 10, knowOneAtLevel: false, constants: C };
  ok('a higher level is not, until the abilities below it are good enough',
     L.canLearn(hard).can === false && L.canLearn(hard).short > 0);
  ok('...and it says how far short, which is the number that decides what to grind',
     L.canLearn(hard).short === L.canLearn(hard).need - 60);
  ok('with no constants it will not claim either way',
     L.canLearn({ have: 200, school: 'Qor', level: 2, constants: {} }).can === null);
}

console.log('\nremaining required to learn new skills');
{
  const C = { points_slope: 7, min_needed_to_advance: 75, max_learn_points: 16,
              level_points: [1, 2, 4, 6, 8, 10] };
  const catalogue = [
    { name: 'foundation a', kind: 'skill', discipline: 'fencing', level: 1, for_sale: true },
    { name: 'foundation b', kind: 'skill', discipline: 'fencing', level: 1, for_sale: true },
    { name: 'foundation c', kind: 'skill', discipline: 'fencing', level: 1, for_sale: true },
    { name: 'advanced guard', kind: 'skill', discipline: 'fencing', level: 2, for_sale: true },
  ];
  const known = [
    { name: 'foundation a', kind: 'skill', ability: 40 },
    { name: 'foundation b', kind: 'skill', ability: 35 },
    { name: 'foundation c', kind: 'skill', ability: 20 },
  ];
  const r = L.RemainingRequiredToLearnNewSkills({
    known, catalogue, intellect: 30, constants: C, name: 'advanced guard', kind: 'skills',
  });
  const target = r.candidates[0];
  ok('the Gilroy chart and the server formula agree: intellect 30, first track level 2 needs 115',
     target.need === 115, JSON.stringify(target));
  ok('it sums the best prior-level percentages and reports the exact remainder',
     target.have === 95 && target.remaining_required === 20 && target.can_learn === false,
     JSON.stringify(target));
  ok('the aggregate says how far the nearest new ability is',
     r.can_learn_any === false && r.remaining_required_to_any === 20, JSON.stringify(r));

  const fourKnown = [...known, { name: 'foundation d', kind: 'skill', discipline: 'fencing',
                                 level: 1, ability: 99 }];
  const fourCatalogue = [...catalogue,
    { name: 'foundation d', kind: 'skill', discipline: 'fencing', level: 1, for_sale: true }];
  const top = L.RemainingRequiredToLearnNewSkills({
    known: fourKnown, catalogue: fourCatalogue, intellect: 30, constants: C,
    name: 'advanced guard', kind: 'skills',
  }).candidates[0];
  ok('only the best three percentages count',
     top.have === 99 + 40 + 35 && top.previous_level_best_three.length === 3,
     JSON.stringify(top));

  const peerCatalogue = [...catalogue,
    { name: 'peer guard', kind: 'skill', discipline: 'fencing', level: 3, for_sale: true },
    { name: 'other guard', kind: 'skill', discipline: 'fencing', level: 3, for_sale: true }];
  const shortcut = L.RemainingRequiredToLearnNewSkills({
    known: [{ name: 'peer guard', kind: 'skill', ability: 1 }], catalogue: peerCatalogue,
    intellect: 1, constants: C, name: 'other guard', kind: 'skills',
  }).candidates[0];
  ok('at level 3+, knowing one peer at that level is the server\'s immediate-success shortcut',
     shortcut.can_learn === true && shortcut.remaining_required === 0 && /enough/.test(shortcut.shortcut),
     JSON.stringify(shortcut));

  const thinCatalogue = [
    { name: 'only base', kind: 'spell', school: 'Tiny', level: 1 },
    { name: 'next spell', kind: 'spell', school: 'Tiny', level: 2 },
  ];
  const thin = L.RemainingRequiredToLearnNewSkills({
    known: [{ name: 'only base', kind: 'spell', ability: 30 }], catalogue: thinCatalogue,
    intellect: 30, constants: C, name: 'next spell', kind: 'spells',
  }).candidates[0];
  ok('scarcity uses abilities existing in the game, not how many this character happens to know',
     thin.previous_level_abilities_in_game === 1 && thin.need === Math.trunc(115 / 3),
     JSON.stringify(thin));

  const noBase = L.RemainingRequiredToLearnNewSkills({
    known: [], catalogue, intellect: 30, constants: C,
    name: 'advanced guard', kind: 'skills',
  }).candidates[0];
  ok('no prior-level foundation is a named blocker rather than a mysterious percentage',
     noBase.can_learn === false && noBase.blocked_by.some(x => /knows nothing/.test(x)),
     JSON.stringify(noBase));

  const qorCatalogue = [
    { name: 'evil base', kind: 'spell', school: 'Qor', level: 1, required_karma: -10 },
    { name: 'evil next', kind: 'spell', school: 'Qor', level: 2, required_karma: -20 },
  ];
  const karma = L.RemainingRequiredToLearnNewSkills({
    known: [{ name: 'evil base', kind: 'spell', ability: 99 }], catalogue: qorCatalogue,
    intellect: 50, karma: 0, constants: C, name: 'evil next', kind: 'spells',
  }).candidates[0];
  ok('karma is reported separately from the ability remainder',
     karma.can_learn === false && karma.blocked_by.some(x => /karma/.test(x)), JSON.stringify(karma));

  const levelOne = L.RemainingRequiredToLearnNewSkills({
    known, catalogue: [...catalogue,
      { name: 'first light', kind: 'spell', school: 'Shalille', level: 1 }],
    intellect: 30, constants: C, name: 'first light', kind: 'spells',
  }).candidates[0];
  ok('level 1 has the server\'s flat 297 baseline, not one 99-point previous-level slot',
     levelOne.can_learn === true && !levelOne.impossible && levelOne.have === 297,
     JSON.stringify(levelOne));

  const already = L.RemainingRequiredToLearnNewSkills({
    known, catalogue, intellect: 30, constants: C, name: 'foundation a', kind: 'skills',
  });
  ok('an already-known target has no "remaining to any new ability" number',
     already.candidates[0].already_known === true && already.remaining_required_to_any === null,
     JSON.stringify(already));

  const auto = L.PointsToNextLevelOfTarget({ known, catalogue, intellect: 30, constants: C });
  ok('without a plan target, the fleet row advances weaponcraft one level',
     auto.target === 'weaponcraft' && auto.current_level === 1 && auto.next_level === 2 &&
     auto.points === 20, JSON.stringify(auto));
  const spellCatalogue = [...catalogue,
    { name: 'faren spark', kind: 'spell', school: 'Faren', level: 1 },
    { name: 'jala note', kind: 'spell', school: 'Jala', level: 1 }];
  const maxWeaponKnown = [{ name: 'weapon six', kind: 'skill', discipline: 'fencing',
                            level: 6, ability: 1 }];
  const maxWeaponCatalogue = [...spellCatalogue,
    { name: 'weapon six', kind: 'skill', discipline: 'fencing', level: 6, for_sale: true }];
  const fallback = L.PointsToNextLevelOfTarget({
    known: maxWeaponKnown, catalogue: maxWeaponCatalogue, intellect: 30, constants: C,
  });
  ok('at weaponcraft 6, the automatic target falls through spell schools alphabetically',
     fallback.target === 'Faren' && fallback.next_level === 1, JSON.stringify(fallback));
  const plannedTarget = L.PointsToNextLevelOfTarget({
    known: maxWeaponKnown, catalogue: maxWeaponCatalogue, intellect: 30, constants: C,
    plan: { learning_target: 'Jala' },
  });
  ok('a character-plan target overrides the automatic order',
     plannedTarget.target === 'Jala' && plannedTarget.source === 'plan', JSON.stringify(plannedTarget));
}

console.log('\nschools, read off a character sheet');
{
  const sheet = { character: 'x', spells: [
    { name: 'create food', school: 'Kraanan', level: 1 },
    { name: 'shield of the fallen', school: 'Kraanan', level: 3 },
    { name: 'blink', school: 'Riija', level: 1 },
    { name: 'a spell nobody has heard of', school: 'Qor' },
  ] };
  const s = L.schoolLevels(sheet, []);
  ok('the highest level in each school is what counts', s.Kraanan === 3);
  ok('BLINK IS NOT COUNTED — the server excludes it from a school\'s level ' +
     '(player.kod:10735) so a planner may not count it either', !('Riija' in s));
  ok('a spell with no level contributes nothing rather than a guessed one', !('Qor' in s));
}

console.log('\nreading and writing');
{
  const res = L.writeLoadout('Kermit', { character: 'Kermit', carry: [{ item: 'herb', min: 5 }] });
  ok('it lands under the slug', existsSync(join(process.env.M59_LOADOUT_DIR, 'kermit.json')));
  ok('and is stamped', !!res.loadout.updated);
  ok('no half-written file is left behind',
     !existsSync(join(process.env.M59_LOADOUT_DIR, 'kermit.json.tmp')));
  const back = L.readLoadout('Kermit');
  ok('it reads back the same', back.loadout.carry[0].min === 5);
  ok('a name with nothing usable in it is refused rather than written somewhere else',
     (() => { try { L.writeLoadout('../..', {}); return false; } catch { return true; } })());
  ok('A TRAVERSAL CANNOT ESCAPE — it is flattened into the directory, not resolved',
     L.loadoutPath('../../prod') === join(process.env.M59_LOADOUT_DIR, 'prod.json'));
  ok('TWO NAMES THAT SLUG TO ONE FILE DO NOT SILENTLY OVERWRITE EACH OTHER',
     (() => { try { L.writeLoadout('Kermit!', { character: 'Kermit!' }); return false; }
              catch (e) { return /already holds "Kermit"/.test(e.message); } })());
  ok('...while a difference the slug keeps is a different character and a different file',
     L.loadoutPath('Kermit the Frog') !== L.loadoutPath('Kermit'));
  ok('...and case alone is the SAME character, not a collision to refuse',
     (() => { try { L.writeLoadout('KERMIT', { character: 'KERMIT' }); return true; } catch { return false; } })());
  ok('...unless that is what was meant',
     (() => { try { L.writeLoadout('Kermit', { character: 'Kermit', carry: [{ item: 'herb', min: 5 }] },
                                   { force: true }); return true; } catch { return false; } })());
  ok('reading one that is not there is null, not a throw', L.readLoadout('Nobody') === null);
  ok('listing finds it', L.listLoadouts().some(r => r.loadout?.character === 'Kermit'));

  writeFileSync(join(process.env.M59_LOADOUT_DIR, 'broken.json'), '{ not json');
  const rows = L.listLoadouts();
  ok('AND A BROKEN FILE IS LISTED AS BROKEN rather than taking the listing down with it',
     rows.some(r => r.loadout === null && r.problems.length) &&
     rows.some(r => r.loadout?.character === 'Kermit'));
}

console.log('\nthe cache the keeper leans on');
{
  const p = join(process.env.M59_LOADOUT_DIR, 'kermit.json');
  ok('the first read finds it', L.loadoutFor('Kermit')?.carry[0].min === 5);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  raw.carry[0].min = 99;
  writeFileSync(p, JSON.stringify(raw));
  // mtime resolution is coarse enough on some filesystems that a write inside the same
  // millisecond leaves it unchanged, which would make this test pass for the wrong reason.
  const later = new Date(Date.now() + 4000);
  utimesSync(p, later, later);
  ok('A CHANGE IS PICKED UP. A loadout edited in the planner and not noticed is ' +
     'indistinguishable from one that was never saved', L.loadoutFor('Kermit')?.carry[0].min === 99);
  writeFileSync(p, '{ still not json');
  utimesSync(p, new Date(Date.now() + 8000), new Date(Date.now() + 8000));
  ok('and a file that goes bad returns null rather than throwing into the keeper\'s pass',
     L.loadoutFor('Kermit') === null);
  ok('a character with no loadout is null every time', L.loadoutFor('Nobody') === null);
}

console.log('\nwhat actually reaches the counter');
{
  // The composed decision the keeper runs, in the order it runs it. This is the one that
  // can lose a character its armour, so each rule is pinned against the rule below it.
  const S = await import('./m59-skills.mjs');
  const KEEP = /shilling|coin|diamond|ruby|emerald|sapphire|armor|armour|shield|sword|mace|hammer|axe|bow|helm|gauntlet/i;
  const { loadout } = L.normalise({ character: 'x',
    carry: [{ item: 'elderberry', min: 12, max: 24 }],
    sell: ['emerald', 'short sword'], keep: ['orc tooth'],
    gear: { weapon: ['mace'] } });
  const pack = pack1();
  function pack1() {
    return [{ name: 'elderberry', amount: 12 }, { name: 'emerald', amount: 6 },
            { name: 'short sword', amount: 1 }, { name: 'orc tooth', amount: 3 },
            { name: 'rat pelt', amount: 9 }, { name: 'leather armor', amount: 1 }];
  }
  const ask = (name, worn = false) => S.sellable({ name, worn, keepRe: KEEP, loadout, pack });

  ok('WORN BEATS EVERY LIST — nothing can sell the shield off your arm',
     ask('emerald', true).sell === false && /worn or wielded/.test(ask('emerald', true).why));
  ok('a floor protects the stack up to the floor',
     ask('elderberry').sell === false && /loadout/.test(ask('elderberry').why));
  ok('THE SELL LIST BEATS THE NAME GUARD — this is the only way to shed gems and spare ' +
     'weapons without editing a regex twenty-one characters share',
     ask('emerald').sell === true && ask('short sword').sell === true);
  ok('the keep list protects something the name guard never would',
     ask('orc tooth').sell === false);
  ok('the character\'s own weapon is protected even though it is not on the keep list',
     ask('mace').sell === false);
  ok('the name guard still protects armour nobody mentioned', ask('leather armor').sell === false);
  ok('and ordinary loot still goes', ask('rat pelt').sell === true);

  // The overlay property, stated as a test rather than as a comment: with no loadout, the
  // answer is exactly the pre-loadout answer.
  const bare = (name) => S.sellable({ name, worn: false, keepRe: KEEP, loadout: null, pack });
  ok('WITH NO LOADOUT NOTHING CHANGES: the gems and the sword are protected again, and ' +
     'the loot still goes',
     bare('emerald').sell === false && bare('short sword').sell === false &&
     bare('elderberry').sell === true && bare('rat pelt').sell === true);
  ok('above the floor the surplus is sellable, which is what a ceiling is for',
     S.sellable({ name: 'elderberry', worn: false, keepRe: KEEP, loadout,
                  pack: [{ name: 'elderberry', amount: 30 }] }).sell === true);
}

console.log('\nwhat an outfitting run goes shopping for');
{
  const O = await import('./m59-outfit.mjs');
  const fleetDefault = O.wantsFor(null);
  ok('NO LOADOUT IS THE FLEET DEFAULT, unchanged — a mace, leather and a shield',
     fleetDefault.length === 3 && fleetDefault.some(w => w.what === 'a mace'));
  ok('and so is a loadout that says nothing about gear',
     O.wantsFor(L.normalise({ character: 'x', carry: [{ item: 'herb', min: 5 }] }).loadout)
       === fleetDefault);

  const { loadout } = L.normalise({ character: 'x',
    gear: { weapon: ['war hammer', 'mace'], slots: { body: ['leather armor'] } } });
  const w = O.wantsFor(loadout);
  ok('a loadout replaces it with this character\'s own list',
     w.length === 2 && w[0].what === 'war hammer' && w[1].what === 'leather armor');
  ok('AN ITEM NAME IS DATA, NOT A REGEX. An apostrophe or a bracket in a name would ' +
     'otherwise compile to something that matches nothing while looking like it should',
     O.wantsFor(L.normalise({ character: 'x', gear: { weapon: ["wizard's staff (+1)"] } }).loadout)[0]
       .re.test("Wizard's Staff (+1)"));
  ok('the second choice satisfies the want — a character holding a mace is not missing ' +
     'its weapon just because a war hammer was listed first',
     w[0].fallback.test('mace') && w[0].fallback.test('war hammer'));
  ok('...and something in neither list does not', !w[0].fallback.test('rat pelt'));
  // The bug this replaced: widening a loadout's fallback to the slot's FAMILY made every
  // loadout mean what the fleet default means. Kermit, whose list says short sword and
  // whose pack holds a mace, reported "already stocked".
  const named = O.wantsFor(L.normalise({ character: 'x',
    gear: { weapon: ['short sword'] } }).loadout)[0];
  ok('A NAMED WANT IS NOT SATISFIED BY THE FAMILY. Getting back to the weapon the list ' +
     'names is the thing the list is for',
     !named.fallback.test('mace') && named.fallback.test('short sword'));
  ok('...while the fleet default still means "some weapon", because one answer for ' +
     'twenty-one characters cannot be fussier than that',
     fleetDefault.find(x => x.slot === 'weapon').fallback.test('long sword'));
}

console.log('\nseeding one from a sheet');
{
  const sheet = { character: 'Piggy', agent: 't2',
    equipment: { worn: [{ name: 'leather armor' }, { name: 'mace' }] },
    spells: [{ name: 'create food', school: 'Kraanan', level: 1 }] };
  const l = L.starterFrom(sheet);
  ok('it is the character, not a template', l.character === 'Piggy' && l.agent === 't2');
  ok('worn gear becomes the gear it is meant to get back to',
     l.gear.weapon.includes('mace') && l.gear.slots.body?.includes('leather armor'));
  ok('the two reagents the whole fleet turns on are seeded',
     l.carry.some(c => c.item === 'elderberry') && l.carry.some(c => c.item === 'herb'));
  ok('and it says it is an observation rather than a plan', /not a plan yet/.test(l.note));
}

// THE ONE PART OF A LOADOUT THAT IS ABOUT THE FLEET RATHER THAN ABOUT A CHARACTER, and the
// only write in this repository that touches twenty-one files at once. What is pinned is
// that it touches exactly one field of them.
console.log('\none plan\'s gear, given to every character');
{
  const gear = { weapon: ['short sword', 'mace'], slots: { body: ['leather armor'] } };

  // A character somebody has already planned by hand, in full.
  L.writeLoadout('Gonzo', {
    character: 'Gonzo',
    note: 'the one with the nose', carry: [{ item: 'elderberry', min: 24, max: 40 }],
    sell: ['sapphire'], keep: ['signet ring'], purse: { float: 200, bank_above: 1000 },
    plan: { schools: { Kraanan: 2 }, abilities: [{ name: 'block' }] },
    gear: { weapon: ['mace'], slots: {} },
  });
  const before = L.readLoadout('Gonzo').loadout;

  const fleet = [{ character: 'Gonzo', agent: 't5' }, { character: 'Rowlf', agent: 't6' }];

  const plan = L.applyGearToAll(gear, fleet, { from: 'Kermit' });
  ok('a plan writes nothing at all',
     !existsSync(join(root, 'loadouts', 'rowlf.json')) &&
     JSON.stringify(L.readLoadout('Gonzo').loadout) === JSON.stringify(before));
  ok('and it says what each character would get',
     plan.counts.total === 2 && plan.counts.changed === 2 && plan.counts.created === 1);
  ok('a character with no loadout is reported as getting its first one',
     plan.rows[1].created === true && plan.rows[1].had === false);

  const done = L.applyGearToAll(gear, fleet, { from: 'Kermit', apply: true });
  const after = L.readLoadout('Gonzo').loadout;
  ok('applying gives everyone the gear',
     after.gear.weapon.join() === 'short sword,mace' &&
     L.readLoadout('Rowlf').loadout.gear.slots.body.join() === 'leather armor');
  ok('THE PLAN AND THE WRITE AGREE, because they are the same function',
     JSON.stringify(plan.rows.map(r => [r.character, r.changed, r.created])) ===
     JSON.stringify(done.rows.map(r => [r.character, r.changed, r.created])));

  // THE PROPERTY THE WHOLE THING TURNS ON. A fleet-wide write that quietly took anything
  // else with it would empty twenty carry lists at once, and the only place that shows up
  // is a keeper deciding it has nothing to protect.
  ok('and it changes NOTHING else about a loadout somebody wrote by hand',
     after.note === before.note &&
     JSON.stringify(after.carry) === JSON.stringify(before.carry) &&
     JSON.stringify(after.sell) === JSON.stringify(before.sell) &&
     JSON.stringify(after.keep) === JSON.stringify(before.keep) &&
     JSON.stringify(after.plan) === JSON.stringify(before.plan) &&
     JSON.stringify(after.purse) === JSON.stringify(before.purse));
  ok('a character that had no loadout gets one that is otherwise blank',
     L.readLoadout('Rowlf').loadout.carry.length === 0 &&
     L.readLoadout('Rowlf').loadout.agent === 't6');
  ok('the file records where its gear came from', /Kermit/.test(after.gear.from ?? ''));

  const again = L.applyGearToAll(gear, fleet, { from: 'Kermit', apply: true });
  ok('running it twice changes nobody the second time',
     again.counts.changed === 0 && again.counts.unchanged === 2);

  // ORDER IS THE PREFERENCE, so the same two names the other way round is a different
  // instruction. Reporting that as "no change" would swallow the only edit somebody made.
  const swapped = L.applyGearToAll({ weapon: ['mace', 'short sword'], slots: { body: ['leather armor'] } },
                                   fleet, { from: 'Kermit' });
  ok('reordering a preference list is a change, not a no-op', swapped.counts.changed === 2);
  ok('and provenance alone is not', L.sameGear({ weapon: ['mace'], slots: {}, from: 'a' },
                                               { weapon: ['mace'], slots: {}, from: 'b' }));

  // AN EMPTY GEAR IS THE ORDINARY STATE OF A LOADOUT NOBODY HAS FILLED IN. Applied across a
  // fleet it would clear every character's weapon preference and report success.
  ok('an empty gear list is refused rather than applied',
     (() => { try { L.applyGearToAll({ weapon: [], slots: {} }, fleet, { apply: true }); return false; }
              catch { return true; } })());
  ok('...unless somebody says they mean it',
     (() => { try { return L.applyGearToAll({ weapon: [], slots: {} }, fleet,
                                            { allowEmpty: true }).counts.changed === 2; }
              catch { return false; } })());
  ok('and gearIsEmpty knows the difference between no list and an empty one',
     L.gearIsEmpty({ weapon: [], slots: { body: [] } }) && !L.gearIsEmpty({ weapon: [], slots: { body: ['x'] } }));

  // A FILE THAT WILL NOT PARSE IS LEFT ALONE, not replaced with one holding only gear — the
  // carry list that went missing would look like something nobody ever wrote.
  writeFileSync(join(root, 'loadouts', 'scooter.json'), '{ this is not json');
  const broken = L.applyGearToAll(gear, [{ character: 'Scooter' }], { apply: true });
  ok('an unreadable loadout is reported and left where it is',
     broken.counts.failed === 1 && /could not be read/.test(broken.rows[0].error) &&
     readFileSync(join(root, 'loadouts', 'scooter.json'), 'utf8') === '{ this is not json');
  ok('a name that cannot be a filename is refused rather than flattened',
     L.applyGearToAll(gear, [{ character: '../..' }], { apply: true }).rows[0].error !== null);

  // The same normalise() every other write goes through, so a fleet-wide one cannot mean
  // something a single save would not.
  const odd = L.applyGearToAll({ weapon: ['mace'], slots: { hat: ['helmet'] } }, fleet, {});
  ok('an unknown slot is carried through and said out loud',
     odd.gear.slots.hat.join() === 'helmet' && odd.problems.some(p => /slot "hat"/.test(p)));
}

// Gear and desired inventory can also be one shared answer for a checked group or the
// whole fleet. Character-specific fields must survive exactly as they do in the gear-only
// compatibility path above.
console.log('\none inventory plan, given to several characters');
{
  const shared = {
    gear: { weapon: ['mace'], slots: { body: ['leather armor'] } },
    carry: [
      { item: 'elderberry', min: 20, max: 40, why: 'shared reagent target' },
      { item: 'herb', min: 10, max: 20 },
    ],
  };
  L.writeLoadout('Beaker', {
    character: 'Beaker', note: 'do not replace this note',
    carry: [{ item: 'herb', min: 2, max: 4 }],
    sell: ['sapphire'], keep: ['signet ring'], purse: { float: 333, bank_above: 999 },
    plan: { schools: { Faren: 3 }, abilities: [{ name: 'dodge' }] },
    gear: { weapon: ['short sword'], slots: {} },
  });
  const before = L.readLoadout('Beaker').loadout;
  const group = [{ character: 'Beaker', agent: 't7' }, { character: 'Bunsen', agent: 't8' }];

  const preview = L.applyInventoryToAll(shared, group, { from: 'Kermit' });
  ok('the shared preview writes nothing',
     !existsSync(join(root, 'loadouts', 'bunsen.json')) &&
     JSON.stringify(L.readLoadout('Beaker').loadout) === JSON.stringify(before));
  ok('it reports gear and carry changes separately',
     preview.rows[0].gear_changed && preview.rows[0].carry_changed &&
     preview.counts.changed === 2 && preview.counts.created === 1);

  const done = L.applyInventoryToAll(shared, group, { from: 'Kermit', apply: true });
  const after = L.readLoadout('Beaker').loadout;
  const fresh = L.readLoadout('Bunsen').loadout;
  ok('applying gives every target the desired gear and carry list',
     after.gear.weapon.join() === 'mace' && fresh.gear.slots.body.join() === 'leather armor' &&
     after.carry.map(c => c.item).join() === 'elderberry,herb' && fresh.carry[0].min === 20);
  ok('the preview and write select the same rows and sections',
     JSON.stringify(preview.rows.map(r => [r.character, r.changed, r.gear_changed, r.carry_changed])) ===
     JSON.stringify(done.rows.map(r => [r.character, r.changed, r.gear_changed, r.carry_changed])));
  ok('and every character-specific field survives the shared write',
     after.note === before.note && JSON.stringify(after.sell) === JSON.stringify(before.sell) &&
     JSON.stringify(after.keep) === JSON.stringify(before.keep) &&
     JSON.stringify(after.plan) === JSON.stringify(before.plan) &&
     JSON.stringify(after.purse) === JSON.stringify(before.purse));
  ok('sameCarry treats ordering as part of the plan',
     L.sameCarry(shared.carry, shared.carry) && !L.sameCarry(shared.carry, [...shared.carry].reverse()));

  ok('an entirely empty shared plan is refused without an explicit force',
     (() => { try { L.applyInventoryToAll({ gear: {}, carry: [] }, group); return false; }
              catch { return true; } })());
  const cleared = L.applyInventoryToAll({ carry: [] }, [{ character: 'Beaker' }],
                                        { apply: true, allowEmpty: true });
  ok('an explicit carry-only clear leaves gear and all other fields alone',
     cleared.rows[0].carry_changed && L.readLoadout('Beaker').loadout.carry.length === 0 &&
     L.readLoadout('Beaker').loadout.gear.weapon.join() === 'mace' &&
     L.readLoadout('Beaker').loadout.note === before.note);
}

// ------------------------------------------------- is this run closing the gear gap?
//
// `purpose: 'equip'` protects a run that earns kit rather than levels — ten characters are
// at the level cap and cannot advance on a fungus beast, which does not make their day
// worthless. What must NOT happen is that declaring it becomes an excuse that can never be
// wrong: before this existed, yieldCheck returned null for every purpose except 'advance',
// so `equip` would have protected the run by turning the instrument off.
{
  console.log('\nthe equip yield');

  // A faction soldier, as m59-spawns.mjs now records one: TID_NONE (the treasure table
  // genuinely says it drops nothing) plus the carried-gear drop the extractor never saw.
  const soldier = {
    name: "soldier of the Duke's army",
    loot: { tid: 'TID_NONE', items: [] },
    equipment_drops: { items: [
      { item: 'LeatherArmor', slot: 'armour', carried_percent: 35, per_kill_percent: 7 },
      { item: 'ShortSword',   slot: 'weapon', carried_percent: 15, per_kill_percent: 3 },
      { item: 'Shield',       slot: 'shield', carried_percent: 100, per_kill_percent: 0,
        never_drops: true },
    ] },
  };
  const fungus = {
    name: 'fungus beast',
    loot: { tid: 'TID_MEDIUM', items: [{ item: 'ElderBerry', per_roll_percent: 30 }] },
  };

  ok('a creature with no row at all is no opinion, never "fine"',
     L.equipYield({ buy: [{ item: 'leather armor', short: 1, gear: true }] }, null) === null);

  // THE SHIELD IS THE ONE THAT MATTERS. Every soldier carries one and none can ever be
  // collected, so a gap listing a shield must not read as satisfied by going to Tos.
  const drops = L.droppablesOf(soldier).map(d => d.item);
  ok('a never-dropped item is not offered as droppable',
     !drops.includes('Shield') && drops.includes('LeatherArmor'), drops.join());
  ok('a treasure share is kept under its own name, not passed off as per-kill',
     L.droppablesOf(fungus)[0].per_roll_percent === 30 &&
     L.droppablesOf(fungus)[0].per_kill_percent === undefined);

  {
    // Kod class name against display name, and the two spellings of armour.
    const y = L.equipYield({ buy: [{ item: 'leather armour', short: 1, gear: true }] }, soldier);
    ok('a soldier pays a character short of leather', y.pays === true);
    ok('and says how often, per kill', y.for[0].per_kill_percent === 7);
  }

  {
    const y = L.equipYield({ buy: [{ item: 'leather armor', short: 1, gear: true }] }, fungus);
    ok('a fungus beast does NOT pay for leather', y.pays === false);
    ok('and names what it drops instead of just refusing',
       /drops none of/.test(y.why) && y.drops.includes('ElderBerry'), y.why);
  }

  // FINISHED AND FUTILE ARE BOTH "NOT PAYING" AND ONLY ONE IS BAD NEWS.
  {
    const y = L.equipYield({ buy: [] }, soldier);
    ok('a complete list is not paying', y.pays === false);
    ok('but is marked done rather than wasted', y.done === true);
  }

  // A gap the creature cannot fill, when it can fill nothing at all.
  {
    const bare = { name: 'training dummy' };
    const y = L.equipYield({ buy: [{ item: 'leather armor', short: 1 }] }, bare);
    ok('a creature that leaves nothing behind says so specifically',
       y.pays === false && /leaves\s+nothing behind/.test(y.why), y.why);
    ok('and does not invent a drop list', y.drops === null);
  }
}

// ------------------------------------------------------------------ the policy block
//
// WHAT A LOADOUT MAY SET ABOUT THE KEEPER, AND WHEN IT WINS.
//
// The overlay exists because a broker restart builds every keeper from defaults, so a
// character somebody had aimed at a room comes back hunting whatever its level implies.
// The trap is the obvious fix: re-applying the file on every pass silently reverts
// `m59-supervise.mjs` and the `autopilot` tool within a second, and the operator watches
// their own setting vanish with nothing saying why. So the file wins when the FILE
// CHANGES, and a runtime set stands in between.

console.log('\nthe policy block a loadout may carry');
{
  const { loadout, problems } = L.normalise({
    character: 'Kermit',
    policy: { hunt: 'skeleton', assigned_room: 70, use_bt: true, karma: -5 },
  });
  ok('a policy block survives normalise', loadout.policy.hunt === 'skeleton' &&
     loadout.policy.assigned_room === 70 && loadout.policy.use_bt === true);
  ok('and it is clean', problems.length === 0, JSON.stringify(problems));
}
{
  // A CLOSED SET, like the playbook's verbs. A key nobody implements must be REPORTED,
  // never carried through: a setting that silently does nothing is how `purpose` sat
  // outside the autopilot schema for a year with every keeper's audit switched off.
  const { loadout, problems } = L.normalise({
    character: 'Kermit', policy: { flee_below: 0.9, hnut: 'skeleton' },
  });
  ok('an unrecognised policy key is dropped', loadout.policy.flee_below === undefined &&
     loadout.policy.hnut === undefined);
  ok('and named, both of them', problems.filter(p => /policy\./.test(p)).length === 2,
     JSON.stringify(problems));
  ok('a survival threshold is specifically not settable here',
     /flee_below/.test(problems.join(' ')));
}
{
  // AN UNUSABLE VALUE IS DROPPED RATHER THAN COERCED. `karma: "no"` becoming 0 is a
  // policy nobody wrote, and 0 is a real karma setting.
  const { loadout, problems } = L.normalise({
    character: 'Kermit', policy: { karma: 'no', use_bt: 'yes', hunt: '' },
  });
  ok('a non-number is not coerced to zero', loadout.policy.karma === undefined);
  ok('a non-boolean is not coerced to true', loadout.policy.use_bt === undefined);
  ok('an empty string is silence, not a setting', loadout.policy.hunt === undefined);
  ok('and the two bad values are reported by name',
     problems.some(p => /policy\.karma/.test(p)) && problems.some(p => /policy\.use_bt/.test(p)),
     JSON.stringify(problems));
}
{
  // SILENCE MEANS CARRY ON AS BEFORE — the rule the whole overlay rests on.
  const { loadout } = L.normalise({ character: 'Kermit' });
  ok('no policy block at all normalises to an empty one, never to defaults',
     loadout.policy && Object.keys(loadout.policy).length === 0);
}
{
  // WHETHER IT MAY BEG IN PUBLIC IS A STANDING PREFERENCE, so a loadout may set it, by the
  // name the `autopilot` tool and tuning.json already use. Off by default since 2026-08-27
  // (askForHelp in m59-autopilot.mjs); a loadout that says true is the opt-in that survives
  // a broker restart, which a runtime set does not.
  const { loadout, problems } = L.normalise({ character: 'Kermit', policy: { ask_for_help: true } });
  ok('ask_for_help is a setting a loadout may make', loadout.policy.ask_for_help === true &&
     problems.length === 0, JSON.stringify(problems));
  ok('and it lands on the keeper as askForHelp, the key the gate reads',
     L.POLICY_KEYS.ask_for_help?.type === 'boolean' && L.POLICY_KEYS.ask_for_help?.as === 'askForHelp');
  const bad = L.normalise({ character: 'Kermit', policy: { ask_for_help: 'yes' } });
  ok('and "yes" is not true', bad.loadout.policy.ask_for_help === undefined &&
     bad.problems.some(p => /policy\.ask_for_help/.test(p)), JSON.stringify(bad.problems));
}

console.log('\nthe file wins when the file changes');
{
  mkdirSync(process.env.M59_LOADOUT_DIR, { recursive: true });
  const path = join(process.env.M59_LOADOUT_DIR, 'gonzo.json');
  writeFileSync(path, JSON.stringify({ character: 'Gonzo', policy: { hunt: 'spider' } }));
  L.forgetLoadouts();

  const before = L.loadoutMtime('Gonzo');
  ok('a written loadout has an mtime', before > 0);
  ok('and a character with no file has none', L.loadoutMtime('Nobody') === 0);

  // The overlay is a method on the keeper, so what is pinned here is the rule it turns
  // on: that the mtime moves when somebody saves, and only then.
  utimesSync(path, new Date(), new Date(before + 5000));
  L.forgetLoadouts();
  ok('saving the file moves the mtime, which is what re-imposes the plan',
     L.loadoutMtime('Gonzo') !== before);
  ok('and the policy is what the file says', L.loadoutFor('Gonzo').policy.hunt === 'spider');
  rmSync(path, { force: true });
  L.forgetLoadouts();
}

console.log('\nbuying into a school this character does not cast');
{
  const CF = { name: 'create food',   kind: 'spell', school: 'Kraanan', level: 1 };
  const CW = { name: 'create weapon', kind: 'spell', school: 'Kraanan', level: 1 };
  const HEAL = { name: 'heal', kind: 'spell', school: "Shal'ille", level: 1 };
  const FENCE = { name: 'fencing', kind: 'skill', level: 1 };
  const catalogue = [CF, CW, HEAL, FENCE];
  const queueFor = (name) => ({ learning_queue: [{ name }] });

  // create food is the case this exists for: the planner's only route to vigor_ok is
  // `cast create food -> eat`, so a character that lacks the spell has no plan at all,
  // and buying it the spell is the obvious-looking next move. It is refused.
  const none = L.plannedAbilities(queueFor('create food'), catalogue, []);
  ok('A CHARACTER THAT CASTS NOTHING MAY NOT BUY ITS WAY INTO A SCHOOL',
     none.length === 0);
  ok('...and the refusal says which school and what to do about it',
     none.refusals.length === 1 &&
     /Kraanan spell/.test(none.refusals[0].why) &&
     /plan\.schools/.test(none.refusals[0].why));

  // The distinction is the school, not "has any magic at all" -- a healer is still not
  // a Kraanan caster, and this is the case a looser rule would let through.
  ok('A CASTER OF ANOTHER SCHOOL IS STILL NOT A CASTER OF THIS ONE',
     L.plannedAbilities(queueFor('create food'), catalogue,
                        [{ kind: 'spell', school: "Shal'ille", name: 'heal' }]).length === 0);

  ok('an existing Kraanan caster may of course learn more Kraanan',
     L.plannedAbilities(queueFor('create food'), catalogue,
                        [{ kind: 'spell', school: 'Kraanan', name: 'blink' }])
       .map(r => r.name).join() === 'create food');

  // THE EXPLICIT PLAN IS THE OPT-IN, and it must stay one: refusing here too would make
  // it impossible to start a school deliberately, which is not what the rule is for.
  ok('naming the school in plan.schools is an operator deciding on purpose, and is honoured',
     L.plannedAbilities({ schools: { Kraanan: 1 } }, catalogue, [])
       .map(r => r.name).sort().join() === 'create food,create weapon');

  ok('A SKILL HAS NO SCHOOL AND IS NEVER REFUSED FOR ONE',
     L.plannedAbilities(queueFor('fencing'), catalogue, [])
       .map(r => r.name).join() === 'fencing');

  // Unknown school is not the same fact as a school this character lacks, and guessing
  // either way is worse than leaving a row alone.
  ok('a spell whose school nothing recorded is left alone rather than guessed at',
     L.plannedAbilities(queueFor('mystery'),
                        [{ name: 'mystery', kind: 'spell', school: null, level: 1 }], [])
       .map(r => r.name).join() === 'mystery');

  ok('crossSchoolRefusals reports the same decision without building a queue',
     L.crossSchoolRefusals({}, [CF], []).length === 1 &&
     L.crossSchoolRefusals({}, [CF], [{ kind: 'spell', school: 'Kraanan', name: 'x' }]).length === 0);

  ok('knowsSchool is the one definition both of them run on',
     L.knowsSchool([{ kind: 'spell', school: 'Kraanan', name: 'blink' }], 'kraanan') === true &&
     L.knowsSchool([{ kind: 'skill', name: 'fencing' }], 'Kraanan') === false);
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
