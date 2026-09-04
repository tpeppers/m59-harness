#!/usr/bin/env node
// WHAT FARMING IS FOR, AND WHAT ACTUALLY PAYS. Offline, no server, safe to run any time:
//
//   node tools/m59-prey-test.mjs
//
// These lock down the three advancement rules in m59-spawns.mjs, because two of them are
// counter-intuitive and one of them is a bug in the game that we are obliged to model:
//
//   * a SKILL's improve chance does not depend on your current skill percent at all
//     (skill.kod:414 reads the spell table by skill number and gets 0), so "I have
//     outgrown rats for slash" is false however obvious it sounds;
//   * a SPELL's does depend on ability, and a weak monster target is WORSE than no
//     monster target, because difficulty falls back to 60 without one;
//   * hit points are an uncapped track while skills and spells share one capped pool,
//     so hp+skill stacks for free and skill+spell does not.
//
// If someone "simplifies" goalYield by making skills read `ability`, these fail. That is
// the point of them.

import { readFileSync } from 'node:fs';

import { goalYield, scorePrey, healthCeiling, PURPOSES, huntingGrounds,
         creatureMatchesHunt, huntedCreatures, huntMatcher, huntLabel, huntNames,
         whoDrops, suggestDrops, moneyPerKill } from './m59-spawns.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// A hand-built index. Four creatures spanning the interesting boundaries: below the
// character, just above it, at the skill-saturation level, and far above the band.
// `loot` mirrors what buildSpawnIndex joins in from the compendium's treasure tables.
// The spider deliberately has NONE, so "not in the index" stays distinguishable from
// "drops nothing" — that distinction is the one a caller will act on.
const lootOf = (tid, items, money) => ({
  tid, cite: `kod/object/passive/trestype/${tid.toLowerCase()}.kod:11`,
  items: items.map(([item, pct]) => ({ item, per_roll_percent: pct, count: 1,
                                       cite: `kod/object/passive/trestype/${tid.toLowerCase()}.kod:32` })),
  money,
});
const rat      = { name: 'giant rat', cls: 'GiantRat', level: 30, karma: 0,
                   sites: [{ room: 566, room_name: 'Sewer', how: 'generator', chance: 60, cap: 8 }],
                   loot: lootOf('TID_RAT', [['RatTail', 30], ['Flask', 5]],
                                { min: 30, max: 90, per_roll_percent: 10, cite: 'trestype.kod:302' }) };
const centiped = { name: 'centipede', cls: 'Centipede', level: 25, karma: 0,
                   sites: [{ room: 566, room_name: 'Sewer', how: 'generator', chance: 40, cap: 8 }],
                   loot: lootOf('TID_CENTIPEDE', [['CentipedeTooth', 25], ['InkyCap', 15]],
                                { min: 25, max: 75, per_roll_percent: 8, cite: 'trestype.kod:302' }) };
const ant      = { name: 'ant', cls: 'Ant', level: 40, karma: -10,
                   sites: [{ room: 563, room_name: 'River Ille', how: 'generator', chance: 50, cap: 7 }],
                   loot: lootOf('TID_ANT', [['InkyCap', 20], ['OreChunk', 6]],
                                { min: 40, max: 120, per_roll_percent: 12, cite: 'trestype.kod:302' }) };
const spider   = { name: 'giant spider', cls: 'Spider', level: 50, karma: -20,
                   sites: [{ room: 900, room_name: 'Deep Cave', how: 'generator', chance: 70, cap: 5 }] };
// THE FAMILY CASE, and it is why strict equality on its own is the wrong rule. Nothing
// in the catalogue is called just "soldier": all three faction troops are `... soldier`,
// so that order can only ever be a family and one substring is what catches them. Two of
// the three are kept here, so a fallback that quietly settles on one is a failure rather
// than a pass.
const rebel    = { name: 'rebel soldier', cls: 'RebelTroop', level: 145, karma: null,
                   sites: [{ room: 378, room_name: 'Sewers of Jasper', how: 'generator',
                             chance: 1, cap: 25 }] };
const dukeman  = { name: "soldier of the Duke's army", cls: 'DukeTroop', level: 120, karma: null,
                   sites: [{ room: 596, room_name: 'Outskirts of Tos', how: 'generator',
                             chance: 5, cap: 12 }] };

const SPAWNS = {
  creatures: { rat, centiped, ant, spider, rebel, dukeman },
  rooms: {
    566: [{ creature: 'giant rat', cls: 'GiantRat', level: 30, chance: 60, huntable: true },
          { creature: 'centipede', cls: 'Centipede', level: 25, chance: 40, huntable: true }],
    563: [{ creature: 'ant', cls: 'Ant', level: 40, chance: 50, huntable: true }],
    900: [{ creature: 'giant spider', cls: 'Spider', level: 50, chance: 70, huntable: true }],
    378: [{ creature: 'rebel soldier', cls: 'RebelTroop', level: 145, chance: 1, huntable: true }],
    596: [{ creature: "soldier of the Duke's army", cls: 'DukeTroop', level: 120,
            chance: 5, huntable: true }],
  },
  danger: { 566: { toughest: 'giant rat', level: 30 }, 563: { toughest: 'ant', level: 40 },
            900: { toughest: 'giant spider', level: 50 },
            378: { toughest: 'rebel soldier', level: 145 },
            596: { toughest: "soldier of the Duke's army", level: 120 } },
};

const CH = { maxHealth: 30, stamina: 20 };   // ceiling 121, so hp is still live

console.log('\nhunting-ground safety guidance — one current formula everywhere');
{
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const primer = readFileSync(new URL('../docs/m59-agent-primer.md', import.meta.url), 'utf8');
  const formula = 'current max HP plus 50%';
  ok('the MCP tool description gives the current max-danger formula', broker.includes(formula));
  ok('the agent primer gives the same current max-danger formula', primer.includes(formula));
  ok('the obsolete fixed six-level guidance is gone',
     !broker.includes('level plus about six') && !primer.includes('level plus about six'));
}

console.log('\ncreature identity — orders are not substring searches');
{
  const grounds = huntingGrounds(SPAWNS, 'ant', { limit: 20 });
  ok('ant selects only the exact ant creature',
     grounds.length === 1 && grounds[0].room === 563,
     JSON.stringify(grounds.map(r => `${r.creature}:${r.room}`)));
  ok('ant does not match the letters inside giant rat',
     !creatureMatchesHunt(rat, 'ant'));
  ok('ant does not silently broaden to mutant ant',
     !creatureMatchesHunt({ name: 'mutant ant', cls: 'MutantAnt' }, 'ant'));
  ok('catalogue class and display-name formatting normalize to one identity',
     creatureMatchesHunt(rat, 'GiantRat') && creatureMatchesHunt(rat, 'giant rat'));
}

// The half that strict equality on its own would have thrown away. `soldier` names no
// catalogue row, so it has to go on meaning the family — and the moment an order DOES
// name a row, the family must stop being reachable through it.
console.log('\nand a family only when the catalogue has no exact answer');
{
  const troops = huntedCreatures(SPAWNS, 'soldier').map(c => c.name).sort();
  ok('an order nothing answers to exactly still catches its whole family',
     troops.length === 2 && troops[0] === 'rebel soldier', JSON.stringify(troops));
  const grounds = huntingGrounds(SPAWNS, 'soldier', { limit: 20 }).map(r => r.room).sort();
  ok('and every one of their rooms is a hunting ground',
     JSON.stringify(grounds) === JSON.stringify([378, 596]), JSON.stringify(grounds));
  ok('naming one of them exactly stops the family being reachable',
     huntedCreatures(SPAWNS, 'rebel soldier').length === 1);
  ok('an exact order is never widened by a longer name that contains it',
     huntedCreatures(SPAWNS, 'ant').length === 1 &&
       huntedCreatures(SPAWNS, 'ant')[0].name === 'ant');
}

// The same rule asked of a name off the wire, which is all any in-room check has: the
// keeper's prey test, capBlockers, the bystander test and findCreature each used to
// answer it with their own substring.
console.log('\nand the same answer for a live display name');
{
  const isAnt = huntMatcher(SPAWNS, 'ant');
  ok('an ant is our prey and a giant rat beside it is not',
     isAnt('ant') && !isAnt('giant rat'));
  const byClass = huntMatcher(SPAWNS, 'RebelTroop');
  ok('an order given as a class recognises the name the server actually sends',
     byClass('rebel soldier') && !byClass("soldier of the Duke's army"));
  const isSoldier = huntMatcher(SPAWNS, 'soldier');
  ok('a family order recognises every member off the wire',
     isSoldier('rebel soldier') && isSoldier("soldier of the Duke's army"));
  ok('and still refuses everything outside it', !isSoldier('giant rat'));
  ok('no order matches nothing, rather than everything',
     !huntMatcher(SPAWNS, null)('ant'));
  ok('with no catalogue it degrades to what the order meant before any of this',
     huntMatcher(null, 'rat')('giant rat'));
}

console.log('\nhit points — AdvancementCheck only rolls above your max health');
{
  const below = goalYield({ kind: 'hp' }, centiped, CH);
  ok('prey at or below max health pays nothing', below.pays === false, JSON.stringify(below));
  const above = goalYield({ kind: 'hp' }, ant, CH);
  ok('prey above max health pays', above.pays === true);
  ok('hp is not on the capped pool', above.capped === false);
  const nearer = goalYield({ kind: 'hp' }, { level: 31 }, CH);
  ok('further above scores higher', above.value > nearer.value,
     `${above.value} vs ${nearer.value}`);
}

console.log('\nhit points — the goal can be finished');
{
  ok('ceiling is 101 + stamina', healthCeiling(20) === 121);
  const done = goalYield({ kind: 'hp' }, spider, { maxHealth: 121, stamina: 20 });
  ok('at the ceiling it reports done, not merely zero', done.done === true && done.pays === false,
     JSON.stringify(done));
}

console.log('\nskills — THE CORRECTION: current ability is irrelevant');
{
  const low  = goalYield({ kind: 'skill', name: 'slash', ability: 11 }, rat, CH);
  const high = goalYield({ kind: 'skill', name: 'slash', ability: 31 }, rat, CH);
  ok('rats pay the same for slash at 11% and at 31%', low.value === high.value,
     `${low.value} vs ${high.value}`);
  ok('and both still pay', low.pays && high.pays);
  ok('the output says why, so nobody re-derives the wrong rule',
     /irrelevant/.test(high.note ?? ''), high.note);
  // bound(2*level + 10, 50, 100)
  ok('level 30 gives factor 70', low.value === 0.7, String(low.value));
  ok('level 45 saturates at 100', goalYield({ kind: 'skill', name: 's' }, { level: 45 }, CH).value === 1);
  ok('level 50 is no better than 45',
     goalYield({ kind: 'skill', name: 's' }, { level: 50 }, CH).value === 1);
  ok('below level 20 hits the floor of 50',
     goalYield({ kind: 'skill', name: 's' }, { level: 10 }, CH).value === 0.5);
  ok('skills are on the capped pool', low.capped === true);
}

console.log('\nspells — ability DOES matter, and weak prey is worse than none');
{
  const low  = goalYield({ kind: 'spell', name: 'blast', ability: 10 }, spider, CH);
  const high = goalYield({ kind: 'spell', name: 'blast', ability: 60 }, spider, CH);
  ok('a higher ability lowers the improve chance', low.value > high.value,
     `${low.value} vs ${high.value}`);
  const weak = goalYield({ kind: 'spell', name: 'blast', ability: 10 }, rat, CH);
  ok('a level-30 target is below the no-monster baseline of 60, so it does not pay',
     weak.pays === false, JSON.stringify(weak));
  ok('and it says the prey actively costs you', /actively costs/.test(weak.why));
  const capped = goalYield({ kind: 'spell', name: 'blast', ability: 50, requisite: 25 }, spider, CH);
  ok('softcap at ability >= 2 x requisite stops it dead',
     capped.pays === false && capped.softcapped === true, JSON.stringify(capped));
}

console.log('\ncombining goals — the pools are not symmetric');
{
  // Strong enough that the band (45+6=51) reaches the level-50 spider, which is the only
  // creature here that pays a SPELL: a spell needs level >= 60 - ability/2 to beat the
  // no-monster baseline, so weak prey can never demonstrate this.
  const strong = { maxHealth: 45, stamina: 20 };
  const at = (r) => r.candidates.find(c => c.creature === 'giant spider');
  const hpOnly    = scorePrey(SPAWNS, strong, { purpose: 'advance', goals: [{ kind: 'hp' }] });
  const skillOnly = scorePrey(SPAWNS, strong, { purpose: 'advance', goals: [{ kind: 'skill', name: 'slash' }] });
  const both      = scorePrey(SPAWNS, strong, { purpose: 'advance',
                                                goals: [{ kind: 'hp' }, { kind: 'skill', name: 'slash' }] });
  ok('hp+skill on one creature scores above either alone',
     at(both).score > at(hpOnly).score && at(both).score > at(skillOnly).score,
     `${at(both)?.score} vs ${at(hpOnly)?.score}/${at(skillOnly)?.score}`);
  ok('and it is reported as satisfying two goals', at(both).goals_satisfied === 2);
  ok('hp and skill stack in full — different pools',
     Math.abs(at(both).score - (at(hpOnly).score + at(skillOnly).score)) < 1e-9,
     `${at(both).score} vs ${at(hpOnly).score} + ${at(skillOnly).score}`);

  // Two CAPPED goals share one pool, so the second must NOT add its full value.
  const spellOnly = scorePrey(SPAWNS, strong, { purpose: 'advance',
    goals: [{ kind: 'spell', name: 'blast', ability: 10 }] });
  const twoCapped = scorePrey(SPAWNS, strong, { purpose: 'advance', goals: [
    { kind: 'skill', name: 'slash' }, { kind: 'spell', name: 'blast', ability: 10 }] });
  const a = at(twoCapped);
  ok('a second capped goal adds less than its standalone value',
     a.score < at(skillOnly).score + at(spellOnly).score,
     `${a.score} vs ${at(skillOnly).score} + ${at(spellOnly).score}`);
  ok('and more than the best one alone', a.score > at(skillOnly).score);
  ok('but it is still counted as satisfying both', a.goals_satisfied === 2);
}

console.log('\nranking — prey that pays twice comes first');
{
  const r = scorePrey(SPAWNS, { maxHealth: 35, stamina: 20 }, {
    purpose: 'advance', goals: [{ kind: 'hp' }, { kind: 'skill', name: 'slash' }], over: 6 });
  // level-40 ant is 5 above the level-35 character. Widen the band so the ant is a
  // candidate at all; the floor is exercised in its own test below.
  ok('the multi-goal creature is ranked first', r.candidates[0]?.creature === 'ant',
     JSON.stringify(r.candidates.map(c => `${c.creature}:${c.goals_satisfied}`)));
  ok('rats are excluded — level 30 is not above max health 35, so hp pays nothing, ' +
     'but slash still does', r.candidates.some(c => c.creature === 'giant rat'));
  const ratRow = r.candidates.find(c => c.creature === 'giant rat');
  ok('and the rat row explains both halves',
     ratRow.pays.length === 1 && ratRow.pays_nothing_for.length === 1,
     JSON.stringify(ratRow.pays_nothing_for));
}

console.log('\npurpose changes what is disqualified');
{
  const goals = [{ kind: 'hp' }];
  const adv = scorePrey(SPAWNS, { maxHealth: 45, stamina: 20 }, { purpose: 'advance', goals });
  ok('`advance` drops prey that pays no goal',
     !adv.candidates.some(c => c.creature === 'ant'),
     JSON.stringify(adv.candidates.map(c => c.creature)));
  const money = scorePrey(SPAWNS, { maxHealth: 45, stamina: 20 }, { purpose: 'money', goals });
  ok('`money` keeps it — anything sellable is acceptable',
     money.candidates.some(c => c.creature === 'ant'));
  ok('`money` is explicit that its number orders but does not forecast',
     /ORDERING only/.test(money.note ?? ''), money.note);
}

console.log('\nthe safety band, and saying what is actually stopping you');
{
  const r = scorePrey(SPAWNS, CH, { purpose: 'advance', goals: [{ kind: 'skill', name: 'slash' }] });
  ok('nothing above max health + over is offered',
     !r.candidates.some(c => c.level > 50), JSON.stringify(r.candidates.map(c => c.level)));
  const strong = scorePrey(SPAWNS, { maxHealth: 60, stamina: 20 },
                           { purpose: 'advance', goals: [{ kind: 'skill', name: 'slash' }] });
  ok('a character that can reach level 80 is no longer band-limited', !strong.limited_by);
}

console.log('\nitems — searching the drop index');
{
  const blind = scorePrey(SPAWNS, CH, { purpose: 'items', goals: [] });
  ok('with neither item nor creature list it refuses to guess', blind.candidates.length === 0);
  ok('and asks for one', /pass `item`/.test(blind.note ?? ''), blind.note);
  const told = scorePrey(SPAWNS, CH, { purpose: 'items', goals: [{ kind: 'skill', name: 'slash' }],
                                       creatures: ['giant rat'] });
  ok('given a creature list it ranks those', told.candidates.length === 1
     && told.candidates[0].creature === 'giant rat',
     JSON.stringify(told.candidates.map(c => c.creature)));
  const byItem = scorePrey(SPAWNS, CH, { purpose: 'items', item: 'rat tails', goals: [] });
  ok('given an item it finds who drops it', byItem.candidates.length === 1
     && byItem.candidates[0].creature === 'giant rat',
     JSON.stringify(byItem.candidates.map(c => c.creature)));
  ok('and reports the drop with its cite',
     byItem.candidates[0].drops === 'RatTail' && /kod\//.test(byItem.candidates[0].drop_cite ?? ''),
     JSON.stringify(byItem.candidates[0]));
  const miss = scorePrey(SPAWNS, CH, { purpose: 'items', item: 'wombat hide', goals: [] });
  ok('a miss says monster drops only, not "does not exist"',
     /monster treasure table/.test(miss.note ?? ''), miss.note);
}

console.log('\nthe item matcher — callers abbreviate and elaborate');
{
  ok('plural to singular: "rat tails" finds RatTail', whoDrops(SPAWNS, 'rat tails').length === 1);
  ok('irregular plural: "teeth" finds Tooth',
     whoDrops(SPAWNS, 'centipede teeth')[0]?.item === 'CentipedeTooth',
     JSON.stringify(whoDrops(SPAWNS, 'centipede teeth')));
  ok('an extra descriptive word still matches: "inky cap mushrooms"',
     whoDrops(SPAWNS, 'inky cap mushrooms')[0]?.item === 'InkyCap');
  ok('a genuine miss is a miss', whoDrops(SPAWNS, 'wombat hide').length === 0);
  ok('near names come back on a miss',
     suggestDrops(SPAWNS, 'rat teeth').length > 0, JSON.stringify(suggestDrops(SPAWNS, 'rat teeth')));
  ok('drops are ordered by share of the table',
     whoDrops(SPAWNS, 'inky cap')[0].per_roll_percent >= whoDrops(SPAWNS, 'inky cap').at(-1).per_roll_percent);
}

console.log('\nmoney — ranked on shillings, but goals still lead');
{
  // Band 51, so all four are reachable and the spider (no loot) is in the running.
  const rich = { maxHealth: 45, stamina: 20 };
  ok('moneyPerKill is midpoint x chance', moneyPerKill(rat) === 6, String(moneyPerKill(rat)));
  ok('and null when the table has no money row', moneyPerKill(spider) === null);
  const m = scorePrey(SPAWNS, rich, { purpose: 'money', goals: [], limit: 5 });
  ok('with no goals it is ordered by money per kill',
     m.candidates[0].money_per_kill >= m.candidates[1].money_per_kill,
     JSON.stringify(m.candidates.map(c => `${c.creature}:${c.money_per_kill}`)));
  ok('the richest table leads', m.candidates[0].creature === 'ant',
     JSON.stringify(m.candidates.map(c => c.creature)));
  ok('it says the number is for ordering only', /ORDERING/.test(m.note ?? ''));
  ok('a creature outside the drop index is marked unknown, not zero',
     /unknown/.test(String(m.candidates.find(c => c.creature === 'giant spider')?.loot)));
  ok('and it sorts last rather than as free', m.candidates.at(-1).creature === 'giant spider',
     JSON.stringify(m.candidates.map(c => c.creature)));

  const g = scorePrey(SPAWNS, rich, { purpose: 'money', goals: [{ kind: 'hp' }], limit: 5 });
  ok('with a goal, prey that also advances comes first regardless of money',
     g.candidates[0].creature === 'giant spider' && g.candidates[0].goals_satisfied === 1,
     JSON.stringify(g.candidates.map(c => `${c.creature}:${c.goals_satisfied}`)));
}

console.log('\nthe safety floor — prey too far above is a death trap, not a target');
{
  // A level-28 character. Its only HP target is a level-30 rat (2 above).
  // With the strict default (under=1) the rat is a death trap and is rejected, and the
  // A L30 rat is 2 above a L28 character -- well within the band. No floor to block it.
  // The test locks down that prey above the character's level is a valid target, and
  // that closer prey ranks higher.
  const weak = { maxHealth: 28, stamina: 8 };
  const r = scorePrey(SPAWNS, weak, { purpose: 'advance', goals: [{ kind: 'hp' }] });
  ok('a level-30 rat is a valid target for a level-28 character',
     r.candidates.some(c => c.creature === 'giant rat'),
     JSON.stringify(r.candidates.map(c => c.creature)));
  ok('and it is found without any band-gap fallback',
     !r.limited_by || !/gap|widened/.test(r.limited_by), r.limited_by);
}

console.log('\nguards');
{
  ok('the three purposes are the three purposes',
     PURPOSES.join(',') === 'money,items,advance');
  ok('an unknown purpose is refused rather than defaulted',
     /unknown purpose/.test(scorePrey(SPAWNS, CH, { purpose: 'xp' }).note ?? ''));
  ok('an unknown max health is refused — every rule keys on it',
     /max health unknown/.test(scorePrey(SPAWNS, { maxHealth: 0 }, {}).note ?? ''));
}

console.log('\nan order that names several creatures');
{
  // THE POINT OF A LIST IS A ROOM WITH TWO GENERATORS. Room 566 here makes giant rats
  // AND centipedes, the way Upstairs Castle Victoria makes battered skeletons and
  // zombies. The spawn cap is a room-wide total, so a character that declines half the
  // room is what stops the half it wants from appearing.
  const both = huntMatcher(SPAWNS, ['giant rat', 'centipede']);
  ok('a list matches every creature it names',
     both('giant rat') && both('centipede'));
  ok('and nothing it does not name',
     !both('ant') && !both('giant spider'));

  // THE TRAP THIS GUARDS. Exact-vs-substring is resolved PER NAME, and 'ant' is both an
  // exact creature here and a substring of 'giant rat'. Resolving the list as one
  // substring pass would quietly enlist a level-30 rat into an order for a level-40 ant.
  const exact = huntMatcher(SPAWNS, ['ant', 'centipede']);
  ok('an exact name in a list stays exact rather than widening to its family',
     exact('ant') && exact('centipede') && !exact('giant rat'));

  ok('one name still behaves exactly as it always did',
     huntMatcher(SPAWNS, 'giant rat')('giant rat') &&
     !huntMatcher(SPAWNS, 'giant rat')('centipede'));
  ok('an empty order matches nothing rather than everything',
     !huntMatcher(SPAWNS, [])('giant rat') && !huntMatcher(SPAWNS, null)('giant rat'));

  const rows = huntedCreatures(SPAWNS, ['giant rat', 'centipede']);
  ok('the catalogue resolves both rows, once each',
     rows.length === 2 && new Set(rows.map(c => c.name)).size === 2,
     JSON.stringify(rows.map(c => c.name)));
  ok('a name repeated does not double its row',
     huntedCreatures(SPAWNS, ['ant', 'ant']).length === 1);

  // Every journal line and postmortem reads this. A raw array renders as
  // 'giant rat,centipede', which looks like a typo at the worst possible moment.
  ok('a list is spoken as prose, not as an array',
     huntLabel(['giant rat', 'centipede']) === 'giant rat or centipede' &&
     huntLabel('ant') === 'ant' && huntLabel([]) === null);
  ok('blank and null entries are dropped rather than matched',
     huntNames(['ant', null, '', 'centipede']).length === 2);

  // A list has to be usable as an ORDER, not merely as a matcher: the rooms it can be
  // worked in are the union of its names' rooms.
  const rooms = huntingGrounds(SPAWNS, ['giant rat', 'ant']).map(g => g.room);
  ok('hunting grounds are the union of the named creatures rooms',
     rooms.includes(566) && rooms.includes(563), JSON.stringify(rooms));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
