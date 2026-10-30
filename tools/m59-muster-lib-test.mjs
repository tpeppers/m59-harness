#!/usr/bin/env node
// WHAT THIS PINS: the muster's readiness model (m59-muster-lib.mjs) — the half of a launch no script had.
//
//   node tools/m59-muster-lib-test.mjs
//
// Offline. Each case is from the prod cold state of 2026-10-29 the Avar Village launch has to start from:
// inn-locked bodies, second-wind drills leaving survival off and fight_above_vigor 0, paused tripwire jobs
// over participants, mushrooms that are reagents and not meals, and food in only two of twenty packs.
import { unitFromState, assess, planHandovers, planFood, planItem, countOf, readinessReport, DEFAULT_TARGET,
         spellReagents, needsOf, sourcesFrom, planSupply, hopsFrom } from './m59-muster-lib.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); } else { failed++; console.log(`  FAIL ${what}`); } };

const isFood = n => /^(loaf of bread|wheel of cheese)$/.test(n);
const now = 1_000_000;
const state = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true, room: { num: 2001 }, hp: { value: 100, max: 100 }, vigor: { value: 120 },
  items: [{ name: 'loaf of bread', amount: 10 }], autopilot_status: { policy: { fightAboveVigor: 60 } }, ...over,
});

console.log('\nreading a character');
{
  const u = unitFromState(state('t1', { items: [{ name: 'red mushroom', amount: 100 }, { name: 'loaf of bread', amount: 3 }, { name: 'sapphire', amount: 56 }] }),
    { jobs: [{ id: 'j1', name: 'second-wind-drill', state: 'running', agents: ['t1'] }, { id: 'j2', name: 'x', state: 'done', agents: ['t1'] },
             { id: 'j3', name: 'buy-sapphires', state: 'paused', agents: ['t17', 't20'] }], isFood, now });
  ok(u.meals === 3, 'mushrooms are reagents, not meals: only the game\'s food counts');
  ok(u.jobs.map(j => j.id).join() === 'j1', 'only LIVE jobs over THIS character are its jobs');
  ok(countOf(u.items, 'sapphires') === 56 && countOf(u.items, 'sapphire') === 56, 'a named item counts singular or plural');
  const off = unitFromState(state('t2', { autopilot_status: { policy: { survivalEnabled: false, survivalOffUntil: now + 60_000 } } }), { isFood, now });
  const lapsed = unitFromState(state('t2', { autopilot_status: { policy: { survivalEnabled: false, survivalOffUntil: now - 1 } } }), { isFood, now });
  ok(off.survivalOff && !lapsed.survivalOff, 'survival is off only while its lease runs (an expired lease is on)');
}

console.log('\nassessing');
{
  const drilled = unitFromState(state('t21', { vigor: { value: 38 }, items: [],
    autopilot_status: { policy: { survivalEnabled: false, survivalOffUntil: now + 9e5, fightAboveVigor: 0 } } }),
    { jobs: [{ id: 'j9', name: 'second-wind-drill', state: 'running', agents: ['t21'] }], postures: ['inn-lock'], isFood, now });
  const a = assess(drilled);
  const kinds = a.gaps.map(g => g.kind);
  ok(['job', 'posture', 'survival_off', 'fight_floor', 'hungry', 'tired'].every(k => kinds.includes(k)), 'a drilled, locked, hungry body has every gap named');
  ok(a.gaps.find(g => g.kind === 'posture').hazard === 'release_lockdown', 'releasing a lockdown is a named hazard');
  ok(a.gaps.find(g => g.kind === 'tired').remedy === 'rest', 'tired with no food rests; with food it eats');
  ok(assess(unitFromState(state('t6'), { isFood, now })).ready, 'a fed, rested, unlocked body in an inn is ready');
  ok(/not in game/.test(assess(unitFromState(state('t9', { in_game: false }), { isFood, now })).exclude), 'offline is excluded, not a gap');
  ok(/person/.test(assess(unitFromState(state('hk3'), { row: { piloted: true }, isFood, now })).exclude), 'piloted is excluded');
  ok(/not a no-combat room/.test(assess(unitFromState(state('t11', { room: { num: 2133 } }), { isFood, now })).exclude),
     'a body among the avars is not prepared there (Janice died at 78% in 2133, refused a walk out)');
  ok(assess(unitFromState(state('t13', { items: [{ name: 'loaf of bread', amount: 9 }, { name: 'sapphire', amount: 2 }] }), { isFood, now }),
    { ...DEFAULT_TARGET, items: { sapphire: 6 } }).gaps.some(g => g.kind === 'item_short' && g.short === 4), 'a role item short by four says four');
}

console.log('\nhand-overs');
{
  const u = (agent, room, meals) => ({ agent, room, meals, items: [] });
  const r = planFood([u('a', 1, 22), u('b', 1, 0), u('c', 1, 0), u('d', 1, 0), u('e', 1, 0), u('f', 1, 0), u('g', 2, 0)], { meals: 4, keep: 2 });
  const given = r.handovers.reduce((n, h) => n + h.amount, 0);
  ok(given === 16, 'a donor keeps its own target plus the margin and gives the rest (22 - 4 - 2)');
  ok(r.handovers.every(h => h.room === 1), 'nobody hands across rooms: a hand-over is a handshake, nobody walks for it');
  ok(r.unmet.some(x => x.agent === 'g') && r.unmet.find(x => x.agent === 'f')?.short === 4, 'who is still short is named, by how much');
  ok(planHandovers([{ agent: 'x', room: 1 }], { short: () => 3, spare: () => 3 }).handovers.length === 0, 'nobody hands to itself');
  const s = planItem([{ agent: 'jan', room: 1, items: [{ name: 'sapphire', amount: 141 }] }, { agent: 'cam', room: 1, items: [{ name: 'sapphire', amount: 2 }] }],
    'sapphire', { need: x => (x.agent === 'cam' ? 20 : 0), keep: () => 0 });
  ok(s.handovers.length === 1 && s.handovers[0].amount === 18, 'the lifter is topped up to its need, from the carrier');
}

console.log('\nresources: what a muster needs, from the game');
{
  const spells = [{ name: 'discordance', cls: 'Discordance', reagents: [{ item: 'Sapphire', count: 2 }] },
                  { name: 'create food', cls: 'CreateFood', reagents: [{ item: 'ElderBerry', count: 2 }, { item: 'Herbs', count: 2 }] }];
  ok(JSON.stringify(spellReagents('Discordance', spells)) === '[{"class":"Sapphire","count":2}]', 'a spell\'s reagents come from the spell table, by name or class');
  ok(spellReagents('no such spell', spells) === null, 'a spell nobody has is null, not "no reagents"');
  const spec = { target: { meals: 4 }, casts: { discordance: 10, 'create food': 3 } };
  const camilla = { agent: 't9', spells: ['discordance'], items: [] };
  const n = needsOf(camilla, spec, { spells });
  ok(n.find(x => x.key === 'Sapphire')?.amount === 20 && !n.some(x => x.key === 'Herbs'), 'reagents only for spells THIS character knows: 10 discordance = 20 sapphires, no herbs');
  ok(n.find(x => x.key === 'meal')?.amount === 4, 'and the meals everyone needs');
  let threw = false; try { needsOf(camilla, { casts: { discordence: 1 } }, { spells, knows: () => true }); } catch { threw = true; }
  ok(threw, 'a misspelled spell in a muster spec is an error, not zero reagents');
}
{
  // classOf/isFood stand in for the kod tables: a red mushroom is a reagent, bread is food.
  const classOf = n => ({ 'loaf of bread': 'Bread', sapphire: 'Sapphire', 'red mushroom': 'RedMushroom' }[n] ?? n);
  const isFood = n => n === 'loaf of bread';
  const graph = new Map([[2001, new Set([2000])], [2000, new Set([2001, 2005])], [2005, new Set([2000])], [114, new Set()]]);
  const distance = (a, b) => hopsFrom(graph, a).get(Number(b)) ?? Infinity;
  ok(distance(2001, 2005) === 2 && distance(2001, 114) === Infinity, 'hops over the room graph (inn -> square -> vault is two)');
  const units = [{ agent: 'a', character: 'A', room: 2001, items: [{ name: 'loaf of bread', amount: 22 }] },
                 { agent: 'b', character: 'B', room: 2001, items: [{ name: 'red mushroom', amount: 100 }] },
                 { agent: 'c', character: 'C', room: 2001, items: [] }];
  const vaults = [{ character: 'C', room: 2005, items: [{ name: 'loaf of bread', amount: 3 }] },
                  { character: 'B', room: 114, items: [{ name: 'loaf of bread', amount: 99 }] }];
  const needs = { a: [{ key: 'meal', amount: 4 }], b: [{ key: 'meal', amount: 4 }], c: [{ key: 'meal', amount: 4 }] };
  const plan = planSupply(needs, units, sourcesFrom({ units, vaults }), { classOf, isFood, distance, maxHops: 3, keep: (s, k) => (s.kind === 'pack' && k === 'meal' ? 2 : 0) });
  ok(!plan.transfers.some(t => t.name === 'red mushroom'), 'a hundred mushrooms feed nobody');
  const toC = plan.transfers.filter(t => t.to === 'c');
  ok(toC[0]?.from === 'vault:C' && toC[0].amount === 3, 'a character draws on its OWN vault first, two rooms away');
  ok(!plan.transfers.some(t => t.from === 'vault:B'), 'a vault on the mainland is out of reach, however full');
  const given = plan.transfers.filter(t => t.from === 'pack:a').reduce((s, t) => s + t.amount, 0);
  ok(given === 5, 'the donor gives only what is short (4 to b, 1 to c after its own vault)');
  const tight = planSupply({ b: [{ key: 'meal', amount: 20 }] }, units, sourcesFrom({ units }),
    { classOf, isFood, distance, keep: (s, k) => (s.kind === 'pack' && k === 'meal' ? 2 : 0) });
  ok(tight.transfers.reduce((s, t) => s + t.amount, 0) === 20 && tight.shortfalls.length === 0 &&
     planSupply({ a: [{ key: 'meal', amount: 4 }], b: [{ key: 'meal', amount: 40 }] }, units, sourcesFrom({ units }),
       { classOf, isFood, distance, keep: () => 2 }).shortfalls[0]?.short === 40 - (22 - 4 - 2),
     'a donor never gives away its own need or its margin; what is left short is named');
  ok(plan.shortfalls.length === 0, 'everybody covered');
}

console.log('\nthe survey');
{
  const lines = readinessReport([{ agent: 'a', ready: true, gaps: [] }, { agent: 'b', exclude: 'not in game', gaps: [] },
    { agent: 'c', ready: false, gaps: [{ kind: 'hungry', why: '0 of 4' }] }]);
  ok(/OUT/.test(lines[0]) && /ready/.test(lines[2]), 'worst first: excluded, then gaps, then ready');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
