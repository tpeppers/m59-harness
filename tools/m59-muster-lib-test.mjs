#!/usr/bin/env node
// WHAT THIS PINS: the muster's readiness model (m59-muster-lib.mjs) — the half of a launch no script had.
//
//   node tools/m59-muster-lib-test.mjs
//
// Offline. Each case is from the prod cold state of 2026-10-29 the Avar Village launch has to start from:
// inn-locked bodies, second-wind drills leaving survival off and fight_above_vigor 0, paused tripwire jobs
// over participants, mushrooms that are reagents and not meals, and food in only two of twenty packs.
import { unitFromState, assess, planHandovers, planFood, planItem, countOf, readinessReport, DEFAULT_TARGET } from './m59-muster-lib.mjs';

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

console.log('\nthe survey');
{
  const lines = readinessReport([{ agent: 'a', ready: true, gaps: [] }, { agent: 'b', exclude: 'not in game', gaps: [] },
    { agent: 'c', ready: false, gaps: [{ kind: 'hungry', why: '0 of 4' }] }]);
  ok(/OUT/.test(lines[0]) && /ready/.test(lines[2]), 'worst first: excluded, then gaps, then ready');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
