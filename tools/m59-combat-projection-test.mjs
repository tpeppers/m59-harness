#!/usr/bin/env node

import { OF } from './m59-parse.mjs';
import { Session } from './m59-game.mjs';
import { fight, landedHitSummary, monsterConditionReport,
         combatRaceProjection } from './m59-skills.mjs';

let passed = 0, failed = 0;
function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok ${passed} - ${name}`); return; }
  failed++;
  console.error(`not ok - ${name}${detail ? ` -- ${detail}` : ''}`);
}

console.log('monster condition parser');
{
  const cases = [
    ['The slime is slightly wounded.', 'slightly_wounded', 0.6, 0.8],
    ['the SLIME is clearly injured.', 'clearly_injured', 0.4, 0.6],
    ['The slime is seriously wounded.', 'seriously_wounded', 0.2, 0.4],
    ['The slime is weak, and near death.', 'near_death', 0, 0.2],
  ];
  for (const [line, band, lower, upper] of cases) {
    const report = monsterConditionReport(line);
    ok(`${band} is parsed as the server's ${upper * 100}% upper band`,
       report?.band === band && report?.lower === lower && report?.upper === upper &&
         report?.healing === false,
       JSON.stringify(report));
  }
  const healed = monsterConditionReport(
    'The slime falls back to recover for a moment, then returns to the fight.');
  ok('the server healing line is an explicit trend invalidation',
     healed?.healing === true && /slime/i.test(healed.name), JSON.stringify(healed));
  ok('unrelated near-death prose is not a monster-health report',
     monsterConditionReport('Even things thought dead can be brought back to near death.') === null);
  ok('a condition line can reflect party damage and is not claimed as our landed hit',
     landedHitSummary(['The slime is clearly injured.'], 'slime').hits === 0);
}

console.log('\nlanded-hit parser');
{
  const liveFight = [
    ...Array.from({ length: 24 }, () => 'Your short sword pokes the fungus beast.'),
    'The fungus beast is seriously wounded.',
    'The fungus beast is weak, and near death.',
  ];
  const liveSummary = landedHitSummary(liveFight, 'fungus beast');
  ok('source battler prose counts all 24 live fungus hits without inventing damage totals',
     liveSummary.hits === 24 && liveSummary.damage === null &&
       liveSummary.damage_known_hits === 0,
     JSON.stringify(liveSummary));

  const sourceForms = landedHitSummary([
    'Your mace bashes the slime.',
    'Your sword slashes the slime.',
    'Your rapier runs through the slime.',
    'Your staff hits the slime.',
    'You hit the slime for 4 damage.',
  ], 'The slime');
  ok('generic and representative source-defined damage verbs remain positive evidence',
     sourceForms.hits === 5 && sourceForms.damage === 4 &&
       sourceForms.damage_known_hits === 1,
     JSON.stringify(sourceForms));

  const rejected = landedHitSummary([
    'Your short sword misses the fungus beast.',
    'Your short sword fails to damage the fungus beast.',
    'The fungus beast pokes you.',
    'The fungus beast is weak, and near death.',
    'MANIAC says, "Your short sword pokes the fungus beast."',
    'Your short sword pokes the slime.',
    'Your body freezes as total exhaustion grips your limbs.',
    'Your body cools noticeably as the resist cold enchantment wears off.',
    'Your weapon sears into your flesh, clinging to your hand as it burns.',
    'Your bronze room key dissolves into a strange metallic liquid, then evaporates into an orange mist and is gone.',
  ], 'fungus beast');
  ok('non-hits, another foe, and real colliding server prose stay excluded',
     rejected.hits === 0, JSON.stringify(rejected));
  ok('affirmative prose without an exact selected-foe binding fails closed',
     landedHitSummary(['Your short sword pokes the fungus beast.']).hits === 0);
}

console.log('\ncombat race projection');
{
  ok('one ambiguous band cannot manufacture a forecast',
     combatRaceProjection({ observations: [
       { band: 'slightly_wounded', lower: 0.6, upper: 0.8, health: 0.9, round: 1 },
     ], currentHealth: 0.8, disengageAt: 0.6, worstExchangeLoss: 0.1, round: 2 }) === null);

  ok('adjacent buckets do not pretend to prove twenty percent of progress',
     combatRaceProjection({ observations: [
       { band: 'slightly_wounded', lower: 0.6, upper: 0.8, health: 0.9, round: 1 },
       { band: 'clearly_injured', lower: 0.4, upper: 0.6, health: 0.8, round: 2 },
     ], currentHealth: 0.8, disengageAt: 0.6, worstExchangeLoss: 0.1, round: 2 }) === null);

  const winning = combatRaceProjection({ observations: [
    { band: 'slightly_wounded', lower: 0.6, upper: 0.8, health: 0.98, round: 1 },
    { band: 'seriously_wounded', lower: 0.2, upper: 0.4, health: 0.94, round: 3 },
  ], currentHealth: 0.94, disengageAt: 0.6, worstExchangeLoss: 0.02, round: 3 });
  ok('fast target progress with little self damage projects a win above reserve',
     winning?.winning === true && winning.projected_health > 0.6, JSON.stringify(winning));

  const losing = combatRaceProjection({ observations: [
    { band: 'slightly_wounded', lower: 0.6, upper: 0.8, health: 0.9, round: 1 },
    { band: 'seriously_wounded', lower: 0.2, upper: 0.4, health: 0.65, round: 3 },
  ], currentHealth: 0.65, disengageAt: 0.6, worstExchangeLoss: 0.13, round: 3 });
  ok('a losing exchange is identified while current health is still above reserve',
     losing?.winning === false && 0.65 > losing.threshold, JSON.stringify(losing));
}

console.log('\nattack transport keeps the whole exchange');
{
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 1, row: 0, nameRsc: 1 };
  const self = { id: 99, col: 0, row: 0, nameRsc: 2 };
  const weapon = { seq: 11, kind: 'message', text: 'Your mace bashes the slime.' };
  const condition = { seq: 12, kind: 'message', text: 'The slime is slightly wounded.' };
  const resisted = { seq: 13, kind: 'message', text: 'The slime shrugs off your attack.' };
  const imitation = { seq: 14, kind: 'said', text: 'The slime is weak, and near death.' };
  const events = [];
  const c = {
    evSeq: 10, selfId: 99, self, room: { objects: new Map([[1, foe], [99, self]]) },
    vitals: () => ({ health: { value: 90, max: 100 } }),
    eventsSince: since => events.filter(event => event.seq > since),
    waitFor: async () => ({ events: events.slice(-1), timedOut: false }),
    attack: () => { events.push(weapon); c.evSeq = 11; },
    // The condition is deliberately a later server post, arriving only while the
    // explicit stats barrier is being processed. An immediate post-wait snapshot
    // sees weapon prose alone and used to lose it forever.
    stats: () => { events.push(condition, resisted, imitation); c.evSeq = 14; },
  };
  const s = Object.create(Session.prototype);
  s.need = () => c;
  s.faceToward = async () => {};
  s.pacer = { submit: async (_kind, action) => action() };
  const result = await s.attackRounds(1, 1, { abortBelow: 0.35 });
  ok('an asynchronously posted health band survives the first-event waiter',
     result.messages.length === 3 && result.messages[1] === condition.text,
     JSON.stringify(result.messages));
  ok('player speech that imitates a health band never enters combat evidence',
     !result.messages.includes(imitation.text), JSON.stringify(result.messages));
}

function combat(sequence, { start = 1, threshold = 0.6 } = {}) {
  let health = start, calls = 0;
  const names = new Map([[1, 'slime'], [2, 'Tester'], [3, 'Arena']]);
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 1, row: 0, nameRsc: 1 };
  const self = { id: 99, col: 0, row: 0, nameRsc: 2 };
  const objects = new Map([[1, foe], [99, self]]);
  const c = {
    selfId: 99, self, room: { objects }, roomNameRsc: 3, inventory: [], evSeq: 0,
    rsc: { get: id => names.get(id) ?? '?' }, lookup: id => names.get(id) ?? '?',
    vitals: () => ({ health: { value: Math.round(health * 100), max: 100 },
                     vigor: { value: 100, scale_max: 200 } }),
    stats: () => {}, waitFor: async () => ({ events: [], timedOut: true }),
    roomContents: () => {}, face: async () => {},
  };
  const s = {
    need: () => c,
    pacer: { submit: async (_kind, action) => action() },
    world: { approachSquare: () => null },
    async attackRounds(id) {
      const step = sequence[calls++] ?? { health, messages: [] };
      health = step.health;
      if (step.kill) objects.delete(id);
      return { messages: step.messages ?? [], vitals: c.vitals(), aborted: step.aborted ?? null };
    },
    async lootFloor() { return { taken: [], refused: [], carrying: [] }; },
  };
  return {
    calls: () => calls,
    run: () => fight(s, { target: 'slime', preferId: 1, rounds: sequence.length,
      disengageAt: threshold, loot: false, equip: false, holdPosition: true, reach: 3 }),
  };
}

console.log('\nadaptive fight integration');
{
  const favorable = combat([
    { health: 0.98, messages: ['Your short sword pokes the slime.',
      'The slime is slightly wounded.'] },
    { health: 0.96, messages: ['Your short sword pokes the slime.',
      'The slime is clearly injured.'] },
    { health: 0.94, messages: ['Your short sword pokes the slime.',
      'The slime is seriously wounded.'] },
    { health: 0.92, messages: ['Your short sword pokes the slime.',
      'The slime is weak, and near death.'] },
    { health: 0.90, messages: [], kill: true },
  ]);
  const won = await favorable.run();
  ok('a favorable race keeps swinging continuously through the kill',
     won.killed === true && favorable.calls() === 5 && won.projection?.winning === true &&
       won.landed_hits === 4,
     JSON.stringify(won));

  const unfavorable = combat([
    { health: 0.90, messages: ['The slime is slightly wounded.'] },
    { health: 0.78, messages: ['The slime is clearly injured.'] },
    { health: 0.65, messages: ['The slime is seriously wounded.'] },
  ]);
  const withdrew = await unfavorable.run();
  ok('a losing race exits early while still above the hard floor',
     withdrew.disengaged?.early === true && unfavorable.calls() === 3 &&
       withdrew.health.after.value === 65 && withdrew.health.after.value / 100 > 0.6,
     JSON.stringify(withdrew));

  const ambiguous = combat([
    { health: 0.90, messages: ['The slime is slightly wounded.'] },
    { health: 0.80, messages: [] },
    { health: 0.75, messages: [], kill: true },
  ]);
  const ambiguousResult = await ambiguous.run();
  ok('one band falls back to the hard-floor behavior instead of guessing',
     ambiguousResult.killed === true && ambiguous.calls() === 3 && !ambiguousResult.projection,
     JSON.stringify(ambiguousResult));

  const healed = combat([
    { health: 0.98, messages: ['The slime is slightly wounded.'] },
    { health: 0.96, messages: ['The slime is clearly injured.'] },
    { health: 0.90, messages: [
      'The slime falls back to recover for a moment, then returns to the fight.',
    ] },
    { health: 0.82, messages: ['The slime is seriously wounded.'] },
    { health: 0.78, messages: [], kill: true },
  ]);
  const healedResult = await healed.run();
  ok('healing invalidates the old rate and requires two fresh bands',
     healedResult.killed === true && healed.calls() === 5 && !healedResult.projection,
     JSON.stringify(healedResult));

  const hardFloor = combat([
    { health: 0.80, messages: ['The slime is seriously wounded.'] },
    { health: 0.30, messages: ['The slime is weak, and near death.'],
      aborted: { at_health: 0.30, swing: 1 } },
  ], { threshold: 0.35 });
  const hardResult = await hardFloor.run();
  ok('the hard per-swing floor overrides even a near-death target',
     hardResult.disengaged?.mid_round === true && !hardResult.disengaged?.early &&
       hardFloor.calls() === 2,
     JSON.stringify(hardResult));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
