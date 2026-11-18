#!/usr/bin/env node
// SECOND WIND FARMING (m59-second-wind.mjs), offline: the policy's normal form, the verdict, and the keeper's two uses
// -- no vigor floor and no meals -- on a fake keeper standing in the Icky Cave (27), whose worst spawn is a level-50
// spider. No broker, keeper process, server or roster.
//
// 'auto' is the default since 2026-11-18 and, with no ratio of its own, asks the OVERMATCH predicate (m59-overmatch.mjs;
// its own suite is m59-overmatch-test.mjs). A ratio a policy WRITES keeps the meaning it always had, and the refusals
// are unchanged: no skill, not farming, off, and nonsense.
//
//   node tools/m59-second-wind-test.mjs
import './m59-test-ledger.mjs';        // FIRST: the keeper records events (larder_empty); see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import { normSecondWindFarming, secondWindVerdict, SECOND_WIND_DEFAULTS } from './m59-second-wind.mjs';
import { overmatchVerdict } from './m59-overmatch.mjs';
import { Autopilot, MIN_FIGHT_VIGOR } from './m59-autopilot.mjs';

test('normal form: auto by default, an object without a mode is auto, booleans and strings, an object with prey_ratio and eat; nonsense is refused', () => {
  assert.deepEqual(normSecondWindFarming(undefined), SECOND_WIND_DEFAULTS);
  assert.equal(normSecondWindFarming(true).mode, 'on');
  assert.equal(normSecondWindFarming(false).mode, 'off');
  assert.equal(normSecondWindFarming('auto').mode, 'auto');
  assert.equal(normSecondWindFarming('off').mode, 'off');
  assert.equal(normSecondWindFarming(undefined).mode, 'auto');
  assert.deepEqual(normSecondWindFarming({ prey_ratio: 3, eat: true }), { mode: 'auto', preyRatio: 3, eat: true });
  for (const bad of ['sometimes', { prey_ratio: 0 }, { eat: 'yes' }, { mode: 'maybe' }, { food: 1 }, [1]])
    assert.throws(() => normSecondWindFarming(bad), undefined, JSON.stringify(bad));
});

test('verdict, a WRITTEN ratio keeps its meaning: Scooter and Zoot (120 health) against the cave (worst huntable spawn level 50) are on; stronger prey is off', () => {
  const v = secondWindVerdict({ policy: { prey_ratio: 2 }, farming: true, knows: true, maxHealth: 120, preyLevels: [45, 50] });
  assert.equal(v.active, true); assert.equal(v.eat, false); assert.equal(v.ratio, 2.4); assert.equal(v.prey_level, 50);
  assert.equal(v.prey_ratio_wanted, 2);
  const hard = secondWindVerdict({ policy: { prey_ratio: 2 }, farming: true, knows: true, maxHealth: 120, preyLevels: [45, 70] });
  assert.equal(hard.active, false); assert.match(hard.why, /prey too strong/);
  assert.equal(secondWindVerdict({ policy: { prey_ratio: 3 }, farming: true, knows: true, maxHealth: 120, preyLevels: [50] }).active, false);
  // Whatever overmatch says: a written ratio is the old question, asked the old way.
  const notOvermatched = overmatchVerdict({ policy: 'off', farming: true, maxHealth: 120, roomLevels: [50] });
  assert.equal(secondWindVerdict({ policy: { prey_ratio: 2 }, farming: true, knows: true, maxHealth: 120, preyLevels: [50],
    overmatch: notOvermatched }).active, true);
});

test("verdict, 'auto' with no ratio of its own asks the overmatch predicate: one question, one answer", () => {
  const base = { farming: true, knows: true, maxHealth: 143, preyLevels: [75, 55] };
  const yes = overmatchVerdict({ farming: true, maxHealth: 143, roomLevels: [75, 55] });
  const no = overmatchVerdict({ farming: true, maxHealth: 120, roomLevels: [75, 55] });
  for (const policy of ['auto', undefined, null, { eat: false }]) {
    const v = secondWindVerdict({ ...base, policy, overmatch: yes });
    assert.equal(v.active, true, JSON.stringify(policy)); assert.equal(v.eat, false);
    assert.equal(v.by, 'overmatch'); assert.equal(v.ratio, 1.91); assert.equal(v.prey_level, 75);
    assert.equal(v.prey_ratio_wanted, 1.8, "the ratio in force is the predicate's, not second wind's own 2");
    assert.match(v.why, /^overmatched: 143 health over the strongest thing here/);
  }
  const off = secondWindVerdict({ ...base, maxHealth: 120, policy: 'auto', overmatch: no });
  assert.equal(off.active, false); assert.equal(off.eat, true); assert.match(off.why, /^not overmatched: not overmatched: 120 health/);
  const none = secondWindVerdict({ ...base, policy: 'auto' });
  assert.equal(none.active, false); assert.match(none.why, /no overmatch verdict/);
});

test('verdict: no skill, not farming, off, or nothing known about the room keep the old behaviour; on overrides the ratio', () => {
  const base = { policy: { prey_ratio: 2 }, farming: true, knows: true, maxHealth: 120, preyLevels: [50] };
  assert.equal(secondWindVerdict({ ...base, knows: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, farming: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: 'off' }).active, false);
  assert.equal(secondWindVerdict({ ...base, preyLevels: [] }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: 'on', preyLevels: [200] }).active, true);
  assert.equal(secondWindVerdict({ ...base, policy: { prey_ratio: 2, eat: true } }).eat, true);
  assert.equal(secondWindVerdict({ ...base, policy: 'garbage' }).active, false, 'an unreadable policy is the old behaviour');
  // The same refusals under the default: an overmatched farmer without the skill, or not farming, or switched off.
  const om = overmatchVerdict({ farming: true, maxHealth: 120, roomLevels: [50] });
  assert.equal(om.active, true);
  assert.equal(secondWindVerdict({ ...base, policy: 'auto', overmatch: om, knows: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: 'auto', overmatch: om, farming: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: 'off', overmatch: om }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: { eat: true }, overmatch: om }).eat, true);
});

function keeper({ secondWind = true, ability = 45, maxHealth = 120, room = 27, mode = 'farm', policy = {} } = {}) {
  const rsc = new Map([[1, 'second wind'], [2, 'parry']]);
  const ate = [];
  const c = { rsc, skills: [{ nameRsc: secondWind ? 1 : 2 }], abilityOf: n => (secondWind && n === 'second wind' ? ability : null),
    vitals: () => ({ health: { value: maxHealth, max: maxHealth }, vigor: { value: 60 } }), items: [],
    selfId: 1, room: { objects: new Map() } };
  const ap = Object.assign(Object.create(Autopilot.prototype), { mode, notes: [],
    s: { name: 'swtest', client: c, world: { room: { num: room } } },
    // A farmer with orders: 'auto' asks the overmatch predicate, and a keeper with nothing to hunt is not farming.
    policy: { hunt: ['orc', 'spider'], fightAboveVigor: 95, secondWindFarming: 'auto', ...policy },
    vigor: { starved_passes: 0 }, note(what, detail) { this.notes.push({ what, detail }); } });
  return { ap, ate };
}

test('keeper: in the cave with Second Wind the fight floor is 0 and provision eats nothing', async () => {
  const { ap } = keeper();
  assert.equal(ap.secondWindFarming().active, true);
  assert.equal(ap.fightFloor(), 0);
  assert.equal(await ap.provision({}, { vigor: { value: 60 } }), null);
  assert.ok(ap.notes.some(n => n.what === 'not eating: second wind is the vigor supply here'));
  assert.ok(ap.notes.some(n => n.what === 'second wind farming: no meals, no vigor floor'));
});

test('keeper: without the skill, or with it off, the floor is the old one', () => {
  // Overmatch is switched off here so that the floor under test is second wind's alone; 80 health against the cave's
  // level-50 spider is not overmatched in the first place (1.6).
  for (const k of [keeper({ secondWind: false, policy: { overmatch: 'off' } }),
                   keeper({ policy: { secondWindFarming: false, overmatch: 'off' } }), keeper({ maxHealth: 80 })]) {
    assert.equal(k.ap.secondWindFarming().active, false);
    assert.ok(k.ap.fightFloor() >= Math.min(MIN_FIGHT_VIGOR, 70), `floor ${k.ap.fightFloor()}`);
  }
  // And an overmatched farmer WITHOUT the skill is not second-wind farming: it keeps its meals, and its floor is the
  // one no ordinary activity crosses (m59-overmatch.mjs), not second wind's zero.
  const plain = keeper({ secondWind: false });
  assert.equal(plain.ap.secondWindFarming().active, false);
  assert.equal(plain.ap.overmatch().active, true);
  assert.equal(plain.ap.fightFloor(), 20);
});

test('keeper: an unread ability falls back to the skill list; ability 0 does not count', () => {
  assert.equal(keeper({ ability: null }).ap.secondWindFarming().active, true);
  assert.equal(keeper({ ability: 0 }).ap.secondWindFarming().active, false);
});

// --- the default: auto since 2026-11-18 ("rely on second wind"); it was off, a staged rollout, before that ---------
test('AUTO BY DEFAULT: no policy key is Scooter in the cave fighting on the skill; an explicit off is the old floor and the old meals', () => {
  assert.equal(SECOND_WIND_DEFAULTS.mode, 'auto');
  assert.equal(new Autopilot({ need() {}, client: null }, {}).policy.secondWindFarming, 'auto', 'the policy default is auto');
  const { ap } = keeper({ policy: { secondWindFarming: undefined } });
  assert.equal(ap.secondWindFarming().active, true);
  assert.equal(ap.fightFloor(), 0);
  for (const off of ['off', false]) {
    const k = keeper({ policy: { secondWindFarming: off, overmatch: 'off' } });
    assert.equal(k.ap.secondWindFarming().active, false);
    assert.ok(k.ap.fightFloor() > 0);
  }
});

test('a farm strategy turns both on: icky-cave-patrol carries secondWind and chaseOnFoot, and they validate', async () => {
  const { validateStrategy } = await import('./m59-strategy-schema.mjs');
  const s = (await import('../substrate/farm-strategies.example/icky-cave-patrol.mjs')).default;
  const r = validateStrategy(s);
  assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.deepEqual(r.unrecognised, []);
  assert.equal(r.strategy.desired.secondWindFarming, 'auto');
  assert.equal(r.strategy.desired.chaseOnFoot, true);
  assert.equal(validateStrategy({ ...s, secondWind: 'sometimes' }).ok, false, 'a bad value is refused at load');
});
