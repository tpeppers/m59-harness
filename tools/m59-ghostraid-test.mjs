#!/usr/bin/env node
// Offline tests for the ghost raid's arithmetic: roles, hammer matching, reagent planning, the
// barrier, and the survival report. Opens no socket and touches no roster.
//
//   node tools/m59-ghostraid-test.mjs
import { hammerNeed, matchHammers, reagentShortfall, planReagents, assignRoles, countFamily,
         expect, barrier, leave, resetBarriers, survivalReport, reportMarkdown, GHOST_ROOM,
         isHammer, isBlunt, blessAssignments, buddyAssignments } from './m59-ghostraid-lib.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- weapons
ok(isHammer('hammer') && !isHammer('spiritual hammer'), 'a spiritual hammer is not a hammer to hand around');
ok(isBlunt('mace') && !isBlunt('long sword'), 'mace is blunt, a long sword thrusts');

const need = hammerNeed('a', { wielding: 'long sword', items: [{ id: 1, name: 'long sword' }, { id: 2, name: 'hammer' }] });
ok(need.has === 'carrying' && need.spares.length === 0, 'the only hammer carried is not a spare');
const rich = hammerNeed('b', { wielding: 'hammer', items: [{ id: 3, name: 'hammer' }, { id: 4, name: 'hammer' }, { id: 5, name: 'hammer' }] });
ok(rich.has === 'wielding' && rich.spares.length === 2, 'wielding one of three leaves two spares');

const m = matchHammers([
  rich, need,
  hammerNeed('c', { wielding: 'scimitar', items: [{ id: 6, name: 'scimitar' }] }),
  hammerNeed('d', { wielding: null, items: [] }),
  hammerNeed('e', { wielding: null, items: [] }),
]);
ok(m.transfers.length === 2 && m.transfers.every(t => t.from === 'b'), 'spares go from the donor');
ok(m.transfers[0].to === 'c' && m.transfers[1].to === 'd', 'needs are served in name order');
ok(m.short.length === 1 && m.short[0] === 'e', 'the unserved raider is named');
ok(JSON.stringify(matchHammers([need, rich, ...[]])) === JSON.stringify(matchHammers([rich, need])),
   'the match does not depend on the order the survey arrived in');

// ---- reagents
const pack = [{ name: 'elderberry', amount: 5 }, { name: 'red mushroom', amount: 2 }, { name: 'mushroom', amount: 3 }];
ok(countFamily(pack, 'mushroom') === 5, 'mushroom is a family of stacks');
const sf = reagentShortfall([{ name: 'elderberry', amount: 5 }], { elderberry: 3, 'orc tooth': 1 }, 3);
ok(sf.elderberry === 4 && sf['orc tooth'] === 3, 'shortfall is per reagent for N casts');

const plan = planReagents(
  [{ agent: 'caster', short: { elderberry: 6, 'orc tooth': 2 } }, { agent: 'light', short: { emerald: 3 } }],
  { caster: [], light: [], rich: [{ name: 'elderberry', amount: 4 }, { name: 'orc tooth', amount: 40 }],
    richer: [{ name: 'elderberry', amount: 10 }, { name: 'emerald', amount: 1 }] });
ok(plan.moves.find(x => x.to === 'caster' && x.what === 'elderberry')?.from === 'richer', 'the biggest donor gives first');
ok(plan.moves.filter(x => x.to === 'caster' && x.what === 'elderberry').reduce((n, x) => n + x.amount, 0) === 6, 'the need is met exactly');
ok(plan.unmet.length === 1 && plan.unmet[0].what === 'emerald' && plan.unmet[0].amount === 2, 'what the fleet lacks is reported, not invented');
const selfish = planReagents([{ agent: 'x', short: { elderberry: 3 } }, { agent: 'y', short: { elderberry: 3 } }],
  { x: [{ name: 'elderberry', amount: 2 }], y: [{ name: 'elderberry', amount: 2 }] });
ok(selfish.moves.length === 0 && selfish.unmet.length === 2, 'a caster short of X never donates X');

// ---- roles
const spells = {
  s1: ['enchant weapon', 'bless'], s2: ['minor heal'], s3: ['minor heal'], s4: ['minor heal'], s5: ['minor heal'],
  s6: [], s20: ['forces of light', 'minor heal'],
};
const roles = assignRoles(Object.keys(spells), spells);
ok(roles.lightbearer === 's20', 'the light-bearer is whoever knows forces of light');
ok(!roles.healers.includes('s20') && roles.healers.length === 3, 'three healers, not the light-bearer');
ok(roles.dedicators.includes('s1') && roles.raiders.includes('s1'), 'a dedicator still fights');
ok(!roles.raiders.includes('s20'), 'the light-bearer is not in the melee');
ok(assignRoles(Object.keys(spells), spells, { healers: 's6' }).healers.join() === 's6', 'named healers win');

// ---- buffs: bless shares, and self + one buddy
const fleet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'light'];
const shares = blessAssignments(fleet, ['c', 'a'], { lightbearer: 'light' });
const blessed = Object.values(shares).flat();
ok(blessed.length === 7 && new Set(blessed).size === 7, 'everyone but the light-bearer is blessed exactly once');
ok(shares.a[0] === 'a' && shares.c[0] === 'c', 'a blesser blesses itself first');
const buddies = buddyAssignments(fleet, ['a', 'b'], { lightbearer: 'light' });
ok(buddies.a.join() === 'a,c' && buddies.b.join() === 'b,d', 'a self-buffer also buffs one buddy who cannot');
const many = buddyAssignments(['a', 'b', 'c'], ['a', 'b'], {});
ok(many.a.length === 2 && many.b.length === 1, 'when buddies run out a caster buffs only itself');
const roles2 = assignRoles(['k', 'm', 'h1', 'h2', 'h3', 'l'], {
  k: ['bless', 'super strength', 'enchant weapon'], m: ['minor heal'],
  h1: ['minor heal'], h2: ['minor heal'], h3: ['minor heal'], l: ['forces of light', 'minor heal'] }, { healers: 'h1,h2,h3' });
ok(roles2.medics.join() === "m" && roles2.blessers.join() === "k" && roles2.strongmen.join() === 'k',
   'a fighter who knows minor heal is a medic; Kraanan casters bless and strengthen');

// ---- barrier
resetBarriers();
expect('door', 3);
const fake = [];
const sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 5)));
const p1 = barrier('door', 'a', { ms: 2000, sleep });
const p2 = barrier('door', 'b', { ms: 2000, sleep });
leave('door', 'c');
const [r1, r2] = await Promise.all([p1, p2]);
ok(r1.opened && r2.opened, 'a raider who will never arrive does not hold the door');
resetBarriers();
expect('door', 2);
const lone = await barrier('door', 'a', { ms: 30, sleep });
ok(!lone.opened, 'a barrier is bounded, and says it did not open');
const late = await barrier('door', 'z', { ms: 5000, sleep });
ok(late.opened && late.waited_ms < 100, 'a door that has released lets a late arrival straight through');

// ---- the report
const t0 = 1_000_000_000_000;
const participants = [
  { agent: 'a', character: 'Aaaa', role: 'raider' },
  { agent: 'b', character: 'Bbbb', role: 'raider' },
  { agent: 'l', character: 'Loial', role: 'light' },
];
const samples = [];
for (let s = 0; s <= 31 * 60; s += 15)
  for (const p of participants) samples.push({ t: t0 + 90_000 + s * 1000, agent: p.agent, character: p.character,
                                                room_num: p.agent === 'l' ? 38 : GHOST_ROOM, hp: 40, max: 50 });
const rep = survivalReport({
  participants, startAt: t0, killAt: t0 + 90_000, windowMin: 30, samples,
  died: [
    { t: t0 + 30_000, character: 'Aaaa', killed_by: 'ghost of Far\'Nohl' },       // during the fight
    { t: t0 + 90_000 + 10 * 60_000, character: 'Bbbb', killed_by: 'tusked skeleton' },
    { t: t0 + 90_000 + 40 * 60_000, character: 'Bbbb', killed_by: 'troll' },       // after the window
    { t: t0 + 90_000 + 5 * 60_000, character: 'Stranger', killed_by: 'x' },       // not ours
  ],
  killed: [
    { t: t0 + 100_000, agent: 'a', creature: 'tusked skeleton' },
    { t: t0 + 200_000, character: 'Bbbb', creature: 'zombie' },
    { t: t0 + 50_000, agent: 'a', creature: 'tusked skeleton' },                   // before the kill
  ],
});
ok(rep.ghost_killed && rep.fight_seconds === 90, 'the fight is timed from entry to the kill');
ok(rep.deaths_in_fight === 1, 'a death before the kill is a fight death');
ok(rep.deaths_in_window === 1 && rep.survivors === 2 && rep.survival_rate === 0.667,
   'survival counts the window only, and only our characters');
ok(rep.rows.find(r => r.agent === 'b').first_death_min === 10, 'first death is minutes into the window');
ok(rep.kills_in_window === 2 && rep.kills_by_creature['tusked skeleton'] === 1, 'kills are counted in the window, by creature');
ok(rep.rows.find(r => r.agent === 'l').time_in_throne_room === 0, 'the light-bearer waits outside');
ok(rep.window_coverage === 1, 'a fully sampled window says so');
const blind = survivalReport({ participants, startAt: t0, killAt: t0 + 90_000, windowMin: 30, samples: [], endAt: t0 + 90_000 });
ok(blind.survival_rate === null && blind.deaths_per_raider_hour === null, 'an unobserved window is null, never a perfect score');
const none = survivalReport({ participants, startAt: t0, killAt: null, windowMin: 30, samples });
ok(!none.ghost_killed && none.fight_seconds === null, 'no kill is reported as no kill');
ok(/survival, 30 min after the kill/.test(reportMarkdown(rep, { fleet: 'shadow' })), 'the markdown carries the headline');

// ---- the armorers
{
  const { outfitNeeds, planOutfit, packRoom } = await import('./fleetscripts/ghost-outfit.mjs');
  const bare = outfitNeeds([{ name: 'long sword' }, { name: 'leather armor' }]);
  ok(bare.shield && bare.chain && bare.hammer, 'a swordsman in leather needs shield, chain and a hammer');
  const set = outfitNeeds([{ name: 'mace' }, { name: 'small round shield' }, { name: 'chain armor' }]);
  ok(!set.shield && !set.chain && !set.hammer, 'a mace counts as blunt; a worn shield and chain need nothing');
  ok(outfitNeeds([{ name: 'leather armor' }, { name: 'blue dragon scale' }]).chain, 'a blue dragon scale is a reagent, not body armour');
  ok(!outfitNeeds([{ name: 'scale armor' }]).chain, 'scale armor counts as chain or better');
  const needs = { a: { shield: true, chain: true, hammer: true }, b: { shield: true, chain: true, hammer: false } };
  const rich = planOutfit(needs, { budget: 100000, capacity: [{ agent: 'x', weight: 5000, bulk: 5000 }] });
  ok(rich.buys.length === 5 && rich.spend === 2 * 288 + 2 * 1800 + 810, 'with enough money and room, everything is bought');
  ok(rich.buys[0].kind === 'shield' && rich.buys[1].kind === 'shield', 'shields for everyone come first');
  const poor = planOutfit(needs, { budget: 288 * 2 + 1800, capacity: [{ agent: 'x', weight: 5000, bulk: 5000 }] });
  ok(poor.buys.filter(b => b.kind === 'shield').length === 2 && poor.buys.filter(b => b.kind === 'chain').length === 1,
     'short of money: every shield, then chain until it runs out');
  ok(poor.cut.some(c => c.why === 'money'), 'and what was cut is said, with why');
  const tight = planOutfit(needs, { budget: 100000, capacity: [{ agent: 'x', weight: 300, bulk: 400 }] });
  ok(tight.buys.length === 3 && tight.cut.filter(c => c.why === 'pack').length === 2, 'the pack caps it: two shields and a hammer fit, two chain do not');
  ok(packRoom(50, [{ name: 'hammer' }]).weight === 1700 + 1000 - 80, 'pack room: 1700 + 20 x might, less what is carried');
}

{
  const { hallSplit, HALL_WANTS } = await import('./fleetscripts/ghost-outfit.mjs');
  const { weighItem } = await import('./m59-items.mjs');
  const crew = ['a', 'b', 'c', 'd'];
  const split = hallSplit(crew, HALL_WANTS, weighItem);
  ok(Object.values(split).flat().length === HALL_WANTS.length, 'the hall split hands out every want exactly once');
  ok(hallSplit(crew, [{ item: 'shilling', amount: 5 }, { item: 'orc tooth', amount: 3 }], weighItem).a.some(w => w.item === 'shilling'), 'money weighs nothing and goes to the first rider');
  const load = a => split[a].reduce((n, w) => n + (weighItem(w.item)?.weight ?? 0) * w.amount, 0);
  ok(Math.max(...crew.map(load)) <= 1200, 'no rider carries more than 1200 weight of the default draw');
  ok(crew.every(a => split[a].length), 'all four riders carry something');
  ok(Object.keys(hallSplit([], HALL_WANTS, weighItem)).length === 0, 'no crew, no split');
  const { chestPlan, raidNeeds } = await import('./m59-ghostraid-lib.mjs');
  const cp = chestPlan({ needs: { 'orc tooth': 30, elderberry: 10 }, fleet: { 'orc tooth': 10, elderberry: 20 },
    chests: [{ slot: 'r1c1', items: [{ name: 'orc tooth', amount: 162 }, { name: 'purple mushroom', amount: 9 }] }], weigh: weighItem });
  const t = cp.rows.find(r => r.item === 'orc tooth');
  ok(t.short === 20 && t.draws[0].take === 162 && t.surplus === 142, 'a whole-stack draw takes the stack and counts the surplus home');
  ok(cp.chests[0].reserve === 142 * 3, 'and reserves the bulk to put it back in the chest it came from');
  ok(cp.rows.find(r => r.item === 'elderberry').draws.length === 0, 'nothing is drawn for an item the fleet already carries');
  ok(chestPlan({ needs: { mushroom: 5 }, chests: [{ slot: 'x', items: [{ name: 'purple mushroom', amount: 9 }] }] }).rows[0].unmet === 5,
     'a purple mushroom is not a mushroom');
  const need = raidNeeds(['a', 'b', 'L'], { lightbearer: 'L', healers: ['a'] }, { lightCasts: 2, herbsEach: 5 });
  ok(need['orc tooth'] === 2 && need.elderberry === 2 * 3 + 2 * 2 && need.herb === 10, 'raid needs: a dedication per raider, the light, herbs per heal caster');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
