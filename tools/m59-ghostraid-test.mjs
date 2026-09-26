#!/usr/bin/env node
// Offline tests for the ghost raid's arithmetic: roles, hammer matching, reagent planning, the
// barrier, and the survival report. Opens no socket and touches no roster.
//
//   node tools/m59-ghostraid-test.mjs
import { hammerNeed, matchHammers, reagentShortfall, planReagents, assignRoles, countFamily,
         expect, barrier, leave, resetBarriers, survivalReport, reportMarkdown, GHOST_ROOM,
         isHammer, isBlunt, blessAssignments, buddyAssignments, spawnBlockers, THRONE_GENERATORS,
         nextGhostWindow, valveStep, GHOST_CYCLE_S } from './m59-ghostraid-lib.mjs';

let pass = 0, fail = 0;
{
  // Spawn blocking: the throne room's six generator squares (throne1.kod:61), held healers first.
  const ok0 = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
  ok0(THRONE_GENERATORS.length === 6 && THRONE_GENERATORS[0][0] === 5 && THRONE_GENERATORS[0][1] === 3, 'six spawn squares, [row, col], r5c3 first');
  const b = spawnBlockers(['a', 'b', 'c', 'd', 'light', 'h'], { lightbearer: 'light', healers: ['h'],
    maxHealth: { a: 75, b: 55, c: 60, d: 70, h: 66 }, count: 3 });
  ok0(Object.keys(b).join() === 'h,b,c', 'healers first, then the weakest by max health, never the light-bearer');
  ok0(b.h.row === 5 && b.h.col === 3 && b.c.row === 13 && b.c.col === 3, 'each holder gets its own square, in order');
  ok0(Object.keys(spawnBlockers(['a', 'b'], { count: 6 })).length === 2, 'never more holders than raiders');
  ok0(Object.keys(spawnBlockers(['a', 'b'], { count: 0 })).length === 0, 'count 0 is off');
  ok0(b.h.index === 0 && b.c.index === 2, 'holders carry the order in which the valve opens their squares');

  // The ghost's clock: 7200 s x 90-110 % from a SEEN spawn (throne1.kod:18, :102).
  const w = nextGhostWindow(0);
  ok0(GHOST_CYCLE_S === 7200 && w.lo === 6480_000 && w.hi === 7920_000, 'next ghost 108-132 minutes after a seen spawn');

  // The valve: arm at everyone >= 50 %, open while the room is cleared, close under pressure.
  const cfg = { startAt: 0.5, closeBelow: 0.35, stepMs: 60_000 };
  let v = valveStep({ open: 0, armed: false, changedAt: 0 }, { minFrac: 0.4, monsters: 0, now: 1000, squares: 6 }, cfg);
  ok0(!v.armed && v.open === 0, 'not armed while anyone is under half health');
  v = valveStep(v, { minFrac: 0.6, monsters: 0, now: 2000, squares: 6 }, cfg);
  ok0(v.armed && v.open === 0, 'arms once everyone is at half or better');
  v = valveStep(v, { minFrac: 0.8, monsters: 0, now: 30_000, squares: 6 }, cfg);
  ok0(v.open === 0, 'waits a whole step before opening');
  v = valveStep(v, { minFrac: 0.8, monsters: 0, now: 70_000, squares: 6 }, cfg);
  ok0(v.open === 1, 'opens one square when the room is empty and everyone is healthy');
  v = valveStep(v, { minFrac: 0.8, monsters: 1, now: 140_000, squares: 6 }, cfg);
  ok0(v.open === 2, 'and another while the fleet keeps up (one alive)');
  v = valveStep(v, { minFrac: 0.8, monsters: 7, now: 150_000, squares: 6 }, cfg);
  ok0(v.open === 1, 'closes one when more are alive than it can take (> 2 x open + 2)');
  v = valveStep(v, { minFrac: 0.3, monsters: 0, now: 160_000, squares: 6 }, cfg);
  ok0(v.open === 0, 'closes one when a raider is low');
  let full = { open: 6, armed: true, changedAt: 0 };
  full = valveStep(full, { minFrac: 0.9, monsters: 0, now: 1e9, squares: 6 }, cfg);
  ok0(full.open === 6, 'never opens more squares than there are holders');
}
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
ok(countFamily(pack, 'mushroom') === 3, 'a reagent is ONE class: a red mushroom pays for no bless (bless.kod:68)');
ok(countFamily([{ name: 'herbs', amount: 4 }, { name: 'orc teeth', amount: 2 }, { name: 'elderberries', amount: 1 }], 'herb') === 4
   && countFamily([{ name: 'orc teeth', amount: 2 }], 'orc tooth') === 2
   && countFamily([{ name: 'elderberries', amount: 1 }], 'elderberry') === 1, 'plurals still count');
ok(countFamily([{ name: 'Inky-cap mushroom', amount: 9 }, { name: 'blue mushroom', amount: 88 }], 'mushroom') === 0, 'Inky-cap and blue mushrooms are not mushrooms to a spell');
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
  // split_hall: the chests are drawn from first, and nobody who can forge is sold a hammer.
  const { hallStock, allocate } = await import('./fleetscripts/ghost-outfit.mjs');
  const stock = hallStock([{ items: [{ name: "knight's shield", amount: 1 }, { name: 'chain armor', amount: 1 }, { name: 'elderberry', amount: 90 }] },
                           { items: [{ name: "Knight's shield", amount: 1 }] }]);
  ok(stock.length === 2 && stock.find(x => x.kind === 'shield').count === 2 && stock.find(x => x.kind === 'chain').count === 1,
     'hall stock: shields and chain by name, across chests; reagents are not armour');
  const split = planOutfit(needs, { budget: 100000, capacity: [{ agent: 'x', weight: 5000, bulk: 5000 }], stock, canForge: new Set(['a']) });
  ok(split.fromHall.length === 3 && split.fromHall.filter(h => h.kind === 'shield').length === 2, 'two shields and a chain come from the chests');
  ok(split.buys.length === 1 && split.buys[0].kind === 'chain', 'only the chain the chests lack is bought');
  ok(split.cut.some(c => c.kind === 'hammer' && c.why === 'forges its own') && !split.buys.some(b => b.kind === 'hammer'),
     'a raider who knows create weapon is not sold a hammer');
  ok(split.spend === 1800, 'and the bill is one chain');
  const lines = [{ agent: 'a', kind: 'shield', source: 'hall', name: "knight's shield" }, { agent: 'b', kind: 'shield' }, { agent: 'b', kind: 'chain' }];
  const al = allocate(lines, [{ id: 1, name: "Knight's shield" }, { id: 2, name: 'small round shield' }]);
  ok(al.now.length === 2 && al.now[0].id === 1 && al.now[1].id === 2 && al.later.length === 1 && al.later[0].kind === 'chain',
     'allocation: a hall line by its name, a bought line by its kind, the missing one waits');
  ok(allocate([{ agent: 'a', kind: 'shield', source: 'hall', name: "knight's shield" }], [{ id: 2, name: 'small round shield' }]).later.length === 1,
     'a small round shield does not satisfy a line for a knight’s shield');
  // The light outfit (operator 2026-09-25): leather + small round shield from the chests, chain from
  // the smith for a gap, spare hammers in the room that is left.
  ok(!outfitNeeds([{ name: 'leather armor' }], { profile: 'light' }).chain, 'light: leather is body armour');
  ok(outfitNeeds([{ name: 'leather armor' }], { profile: 'chain' }).chain, 'chain: leather is not enough');
  const lstock = hallStock([{ items: [{ name: 'leather armor', amount: 1 }, { name: 'small round shield', amount: 2 },
                                      { name: "knight's shield", amount: 4 }, { name: 'hammer', amount: 1 }] }],
                           { names: ['leather armor', 'small round shield'] });
  ok(!lstock.some(x => x.name === "knight's shield") && lstock.some(x => x.kind === 'hammer'),
     'light: only leather and small round shields are handed out; the chests’ hammers are counted for spares');
  const two = { a: { shield: true, chain: true, hammer: false }, b: { shield: true, chain: true, hammer: false } };
  const lp = planOutfit(two, { budget: 100000, capacity: [{ agent: 'x', weight: 5000, bulk: 5000 }], stock: lstock, spares: 3 });
  ok(lp.fromHall.filter(h => h.kind === 'chain' && h.name === 'leather armor').length === 1 && lp.buys.filter(b => b.kind === 'chain').length === 1,
     'one leather from the chests; the second raider gets chain from the smith');
  ok(lp.fromHall.filter(h => h.kind === 'shield').length === 2 && !lp.buys.some(b => b.kind === 'shield'), 'both shields from the chests');
  ok(lp.spare.length === 3 && lp.spare[0].source === 'hall' && lp.spare[1].source === 'smith', 'spare hammers: the chest’s first, then bought');
  ok(lp.byCarrier.x.filter(l => l.spare).every(l => l.agent == null), 'a spare belongs to nobody until the join');
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
  const all = s => Object.values(s).flat().reduce((m, w) => (m[w.item] = (m[w.item] ?? 0) + w.amount, m), {});
  ok(HALL_WANTS.every(w => all(split)[w.item] === w.amount), 'every unit of every want is dealt out, split or not');
  const reag = [{ item: 'elderberry', amount: 150 }, { item: 'herb', amount: 120 }, { item: 'mushroom', amount: 60 }];
  const tight = hallSplit(['a', 'b', 'c'], reag, weighItem, { a: 400, b: 900, c: 50 });
  const cost = a => tight[a].reduce((n, w) => n + Math.max(weighItem(w.item).weight, weighItem(w.item).bulk) * w.amount, 0);
  ok(cost('a') <= 400 && cost('b') <= 900 && cost('c') <= 50, 'no rider is dealt more than its free room (the 2026-09-25 rider got 1,500 bulk at 0 free)');
  ok(tight.b.find(w => w.item === 'elderberry') && tight.a.find(w => w.item === 'elderberry'), 'a reagent stack splits across riders');
  const over = hallSplit(['a', 'b'], [{ item: 'chain armor', amount: 4 }], weighItem, { a: 300, b: 100 });
  ok(Object.values(over).flat().reduce((n, w) => n + w.amount, 0) === 4, 'what fits nowhere is still dealt, so the draw reports it SHORT');
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

{
  const { cupHolderIn, pickRiders } = await import('./fleetscripts/provision.mjs');
  const s = new Map([['a', { items: [{ name: 'Chalice of the Rain' }], might: 50 }],
                     ['b', { items: [], might: 50 }],
                     ['c', { items: [{ name: 'pork', amount: 100 }], might: 50 }]]);
  ok(cupHolderIn(s) === 'a', 'provision: the cup holder is whoever carries the chalice');
  ok(pickRiders(s, { n: 1, holder: 'a' })[0] === 'b', 'provision: riders are the most free pack room, never the holder');
  ok(pickRiders(s, { named: ['a', 'c'], holder: 'a' }).join() === 'c', 'provision: a named holder is dropped from the riders');
  ok(cupHolderIn(new Map([['x', { items: [] }]])) === null, 'provision: no cup, no holder');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
