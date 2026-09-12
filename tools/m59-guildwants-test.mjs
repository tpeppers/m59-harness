#!/usr/bin/env node
//
// Guild wants: a demand the whole fleet answers into a store no character owns.
//
// Every assertion here is a rule that fails SILENTLY and expensively if inverted — the
// fleet either walks to the hall for nothing on every sale, gives away what a caster eats
// with, or refuses to sell anything ever again.
import assert from 'node:assert/strict';
import { contributionPlan, guildKeepTest, guildShortfall, guildStoreAvailable,
         normalisePlan } from './m59-guildwants.mjs';
import { GUILD_CHEST_SLOTS, CHEST_BULK_MAX } from './m59-storage.mjs';

let n = 0;
const ok = (c, why) => { assert.ok(c, why); n++; };
const eq = (a, b, why) => { assert.deepEqual(a, b, why); n++; };

const IN_GUILD = { in_guild: true, due: 0 };
const chestsWith = (slot1 = []) => [
  { slot: 'r18c2', items: slot1 },
  { slot: 'r18c6', items: [] },
  { slot: 'r20c4', items: null, never_opened: true },
  { slot: 'r22c8', items: null, never_opened: true },
];
const PLAN = { chests: { 'r18c2': { items: [{ item: 'inky cap mushroom', target: 300 }] },
                         'r18c6': { items: [{ item: 'herb', target: 200 }] } } };

// ------------------------------------------------------------------ the gate
//
// Off is not "nothing to contribute". A fleet with no hall has nowhere to put anything, and
// the two ways of being off have different fixes — so the reason is carried, never a bare
// false.
eq(guildStoreAvailable({ rent: null, chests: chestsWith() }).ok, false);
ok(/nobody has asked Frular/.test(guildStoreAvailable({ rent: null, chests: chestsWith() }).why));
eq(guildStoreAvailable({ rent: { in_guild: false }, chests: chestsWith() }).ok, false);
ok(/no guild/.test(guildStoreAvailable({ rent: { in_guild: false }, chests: chestsWith() }).why));
eq(guildStoreAvailable({ rent: IN_GUILD, chests: [] }).ok, false,
   'belonging to a guild is not evidence of a hall');
ok(/no chest .* ever been opened/.test(guildStoreAvailable({ rent: IN_GUILD, chests: [] }).why));
eq(guildStoreAvailable({ rent: IN_GUILD, chests: chestsWith() }).ok, true,
   'one opened chest is enough evidence of a hall');
// An unparsed rent answer is not a guild. `null` in_guild must not read as membership.
eq(guildStoreAvailable({ rent: { in_guild: null }, chests: chestsWith() }).ok, false);

// A disabled store contributes nothing AND does not walk.
const off = contributionPlan({ plan: PLAN, chests: chestsWith(), pack: [{ name: 'herb', amount: 99 }],
                               rent: { in_guild: false } });
eq(off.enabled, false); eq(off.total, 0); eq(off.walk, false);

// ------------------------------------------------------------------ the plan
const bad = normalisePlan({ chests: { 'r18c2': { items: [{ item: 'herb', target: 10 },
                                                   { item: 'herb', target: 40 }] },
                                      9: { items: [{ item: 'gold', target: 5 }] },
                                      'r18c6': { items: [{ target: 3 }] } } });
eq(bad.chests.get('r18c2')[0].target, 40, 'two lines for one item is a contradiction — the larger wins');
ok(bad.problems.some(p => /twice/.test(p)), 'and the collision is reported, not silently summed');
// A CHEST IS NAMED BY ITS SQUARE. A bare number used to be the name and is now not one —
// which matters more than it sounds, because the numbered scheme's cache files are still
// on disk and must never be read back as chests.
ok(!bad.chests.has(9), 'a key that is not a square is dropped');
ok(!bad.chests.has('9'), 'and not smuggled in as a string either');
ok(bad.problems.some(p => /is not a square/.test(p)),
   'and named rather than clamped onto a chest that exists');
ok(bad.problems.some(p => /r18c2|r18c6|r20c4/.test(p)),
   'the refusal shows what a square looks like, using the ones this hall builds');
ok(bad.problems.some(p => /no item name/.test(p)));
eq(normalisePlan({ chests: { 'r18c2': { items: [{ item: 'herb', target: 0 }] } } }).chests.get('r18c2')[0].target, 0,
   'a target of zero is kept — it is how an item becomes sellable again');

// ------------------------------------------------------------------ contributing
const p = contributionPlan({ plan: PLAN, chests: chestsWith([{ name: 'inky cap mushroom', amount: 100 }]),
  pack: [{ name: 'inky cap mushroom', amount: 80 }, { name: 'herb', amount: 50 }],
  keepFloor: item => (item === 'herb' ? 20 : 0), rent: IN_GUILD });
eq(p.enabled, true); eq(p.walk, true);
eq(p.chests.find(c => c.slot === 'r18c2').give[0].amount, 80, 'gives what it has toward the shortfall');
eq(p.chests.find(c => c.slot === 'r18c6').give[0].amount, 30,
   'THE CONTRIBUTOR KEEPS ITS OWN FLOOR — 50 herbs less a floor of 20 is 30 offered');
eq(p.chests.find(c => c.slot === 'r20c4')?.total ?? 0, 0);

// AN UNOPENED CHEST IS NOT AN EMPTY ONE. Reading it as empty would send the whole fleet to
// fill a chest that may already be full.
const unopened = contributionPlan({ plan: { chests: { 'r20c4': { items: [{ item: 'herb', target: 500 }] } } },
  chests: chestsWith(), pack: [{ name: 'herb', amount: 99 }], rent: IN_GUILD });
eq(unopened.total, 0, 'nothing is contributed toward a chest nobody has looked in');
eq(unopened.walk, false, 'and it is not walked to');
ok(/never been opened/.test(unopened.chests[0].why));

// A MET PLAN PRODUCES NO WORK, which is what stops a town check-in becoming a tax on
// every sale.
const met = contributionPlan({ plan: PLAN,
  chests: chestsWith([{ name: 'inky cap mushroom', amount: 300 }]),
  pack: [{ name: 'inky cap mushroom', amount: 500 }], rent: IN_GUILD });
eq(met.chests.find(c => c.slot === 'r18c2').total, 0, 'a satisfied target asks for nothing');
eq(met.walk, false, 'and with nothing else short, the walk is skipped');

// NOTHING IN THE PACK MEANS NO WALK EITHER — the case the user asked for by name.
const empty = contributionPlan({ plan: PLAN, chests: chestsWith(), pack: [], rent: IN_GUILD });
eq(empty.total, 0); eq(empty.walk, false, 'an empty pack never walks to the hall');

// TWO CHESTS WANTING THE SAME ITEM CANNOT EACH BE PROMISED THE WHOLE STACK.
const shared = contributionPlan({
  plan: { chests: { 'r18c2': { items: [{ item: 'herb', target: 100 }] },
                    'r18c6': { items: [{ item: 'herb', target: 100 }] } } },
  chests: chestsWith(), pack: [{ name: 'herb', amount: 60 }], rent: IN_GUILD });
eq(shared.total, 60, 'the stack is spent down across chests, not counted twice');

// A chest cannot take more than it holds, however much the plan asks for.
const huge = contributionPlan({
  plan: { chests: { 'r18c6': { items: [{ item: 'herb', target: 9_999_999 }] } } },
  chests: chestsWith(), pack: [{ name: 'herb', amount: 9_999_999 }], rent: IN_GUILD });
ok(huge.total > 0 && huge.total < 9_999_999, 'bounded by the chest, not by the plan');
ok(huge.total * 2 <= CHEST_BULK_MAX + 2, 'and the bound is the chest bulk ceiling');

// ------------------------------------------------------------------ the sell order
//
// pack -> own floor -> guild chests -> sold -> banked. An item is held back from the
// vendor exactly while the guild is short of it, and becomes sellable the moment the plan
// is met — otherwise a full hall would mean a fleet that can never sell anything again.
const keep = guildKeepTest({ plan: PLAN, chests: chestsWith(), rent: IN_GUILD });
eq(keep('inky cap mushroom'), true, 'held while the guild is short');
eq(keep('Inky Cap Mushroom'), true, 'and the match is case-insensitive');
eq(keep('sapphire'), false, 'nothing the plan does not name is protected');
const keptWhenMet = guildKeepTest({ plan: PLAN,
  chests: chestsWith([{ name: 'inky cap mushroom', amount: 300 }]), rent: IN_GUILD });
eq(keptWhenMet('inky cap mushroom'), false, 'AND RELEASED once the target is met — this is the overflow path');
eq(guildKeepTest({ plan: PLAN, chests: chestsWith(), rent: null })('inky cap mushroom'), false,
   'with no guild store there is nothing to hold anything for');

// An unopened chest keeps its whole target back: selling is not reversible, so "nobody has
// looked" holds the item rather than releasing it.
eq(guildKeepTest({ plan: { chests: { 'r20c4': { items: [{ item: 'herb', target: 5 }] } } },
                   chests: chestsWith(), rent: IN_GUILD })('herb'), true);

eq(guildShortfall({ plan: PLAN, chests: chestsWith(), rent: IN_GUILD })
   .map(x => x.item).sort(), ['herb', 'inky cap mushroom']);

console.log(`guild wants: ${n} assertions passed`);
