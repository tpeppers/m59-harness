#!/usr/bin/env node
// SECOND WIND FARMING (m59-second-wind.mjs), offline: the policy's normal form, the verdict, and the keeper's two uses
// -- no vigor floor and no meals -- on a fake keeper standing in the Icky Cave (27), whose worst spawn is a level-50
// spider. No broker, keeper process, server or roster.
//
//   node tools/m59-second-wind-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normSecondWindFarming, secondWindVerdict, SECOND_WIND_DEFAULTS } from './m59-second-wind.mjs';
import { Autopilot, MIN_FIGHT_VIGOR } from './m59-autopilot.mjs';

test('normal form: off by default, an object without a mode is auto, booleans and strings, an object with prey_ratio and eat; nonsense is refused', () => {
  assert.deepEqual(normSecondWindFarming(undefined), SECOND_WIND_DEFAULTS);
  assert.equal(normSecondWindFarming(true).mode, 'on');
  assert.equal(normSecondWindFarming(false).mode, 'off');
  assert.equal(normSecondWindFarming('auto').mode, 'auto');
  assert.deepEqual(normSecondWindFarming({ prey_ratio: 3, eat: true }), { mode: 'auto', preyRatio: 3, eat: true });
  for (const bad of ['sometimes', { prey_ratio: 0 }, { eat: 'yes' }, { mode: 'maybe' }, { food: 1 }, [1]])
    assert.throws(() => normSecondWindFarming(bad), undefined, JSON.stringify(bad));
});

test('verdict: Scooter and Zoot (120 health) against the cave (worst spawn level 50) are on; stronger prey is off', () => {
  const v = secondWindVerdict({ policy: 'auto', farming: true, knows: true, maxHealth: 120, preyLevels: [45, 50] });
  assert.equal(v.active, true); assert.equal(v.eat, false); assert.equal(v.ratio, 2.4); assert.equal(v.prey_level, 50);
  const hard = secondWindVerdict({ policy: 'auto', farming: true, knows: true, maxHealth: 120, preyLevels: [45, 70] });
  assert.equal(hard.active, false); assert.match(hard.why, /prey too strong/);
  assert.equal(secondWindVerdict({ policy: { prey_ratio: 3 }, farming: true, knows: true, maxHealth: 120, preyLevels: [50] }).active, false);
});

test('verdict: no skill, not farming, off, or nothing known about the room keep the old behaviour; on overrides the ratio', () => {
  const base = { policy: 'auto', farming: true, knows: true, maxHealth: 120, preyLevels: [50] };
  assert.equal(secondWindVerdict({ ...base, knows: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, farming: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: false }).active, false);
  assert.equal(secondWindVerdict({ ...base, preyLevels: [] }).active, false);
  assert.equal(secondWindVerdict({ ...base, policy: 'on', preyLevels: [200] }).active, true);
  assert.equal(secondWindVerdict({ ...base, policy: { eat: true } }).eat, true);
  assert.equal(secondWindVerdict({ ...base, policy: 'garbage' }).active, false, 'an unreadable policy is the old behaviour');
});

function keeper({ secondWind = true, ability = 45, maxHealth = 120, room = 27, mode = 'farm', policy = {} } = {}) {
  const rsc = new Map([[1, 'second wind'], [2, 'parry']]);
  const ate = [];
  const c = { rsc, skills: [{ nameRsc: secondWind ? 1 : 2 }], abilityOf: n => (secondWind && n === 'second wind' ? ability : null),
    vitals: () => ({ health: { value: maxHealth, max: maxHealth }, vigor: { value: 60 } }), items: [] };
  const ap = Object.assign(Object.create(Autopilot.prototype), { mode, notes: [],
    s: { client: c, world: { room: { num: room } } },
    policy: { fightAboveVigor: 95, secondWindFarming: 'auto', ...policy },
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
  for (const k of [keeper({ secondWind: false }), keeper({ policy: { secondWindFarming: false } }), keeper({ maxHealth: 80 })]) {
    assert.equal(k.ap.secondWindFarming().active, false);
    assert.ok(k.ap.fightFloor() >= Math.min(MIN_FIGHT_VIGOR, 70), `floor ${k.ap.fightFloor()}`);
  }
});

test('keeper: an unread ability falls back to the skill list; ability 0 does not count', () => {
  assert.equal(keeper({ ability: null }).ap.secondWindFarming().active, true);
  assert.equal(keeper({ ability: 0 }).ap.secondWindFarming().active, false);
});

// --- the staged rollout: off unless a strategy turns it on ------------------------------------------------------
test('OFF BY DEFAULT: no policy key means the old floor and the old meals, even for Scooter in the cave', () => {
  assert.equal(SECOND_WIND_DEFAULTS.mode, 'off');
  assert.equal(secondWindVerdict({ farming: true, knows: true, maxHealth: 120, preyLevels: [50] }).active, false);
  const { ap } = keeper({ policy: { secondWindFarming: undefined } });
  assert.equal(ap.secondWindFarming().active, false);
  assert.ok(ap.fightFloor() > 0);
  assert.equal(new Autopilot({ need() {}, client: null }, {}).policy.secondWindFarming, 'off', 'the policy default is off');
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
