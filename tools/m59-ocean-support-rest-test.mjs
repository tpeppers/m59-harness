import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';

function support({ karma = 15, health = 23, map = 552, neverAttack = true, beforeRest = null } = {}) {
  const actions = [];
  const room = { num: map };
  const self = { id: 7081, row: 45, col: 55 };
  const mollusk = { id: 16498, row: 45, col: 53, flags: OF.ATTACKABLE };
  const vitals = {
    health: { value: health, max: 23 },
    vigor: { value: 78, scale_max: 200, rest_threshold: 80 },
  };
  const c = {
    self, selfId: self.id, room: { id: 1416, objects: new Map([[mollusk.id, mollusk]]) },
    statsById: new Map([['karma', { value: karma }]]), vitals: () => structuredClone(vitals),
    stats: () => {}, waitFor: async () => ({ events: [] }), ailments: () => [],
    rest: () => { actions.push('rest'); vitals.vigor.value = 80; },
    stand: () => actions.push('stand'),
  };
  const s = {
    name: 'ocean-support-fixture', world: { room }, client: c, need: () => c, live: true,
    pacer: { submit: async (kind, fn) => {
      if (kind === 'rest') beforeRest?.(c);
      return fn();
    } },
  };
  const no = async () => false;
  const pilot = Object.assign(Object.create(Autopilot.prototype), {
    s, mode: 'idle', tally: { rests: 0 },
    policy: { neverAttack, fleeBelow: 0.75, restBelow: 0.95, holdResumeAbove: 0.9 },
    note() {}, operatorSurvivalStandDown: () => false,
    farmBuffPass: no, escapeIfWedgedAndHurt: no, tradeInPlaceIfWedged: no,
    defensiveAnswer: no, leaveForCasters: no, eatToFloor: no,
    holdWorks: () => false, sanctuary: () => false, currentRecoveryWall: () => null,
    isRoomEnchantPost: () => false, tooTiredToTravel: () => false, travelInterrupted: () => false,
    takeRecoverySpot: async () => { actions.push('emergency shelter'); return { cancelled: true }; },
    playDead: async () => { actions.push('log off'); return true; },
  });
  const run = () => pilot.passFleeAndRest({ s, c, room, v: c.vitals(), hp: health / 23 });
  return { actions, run };
}

test('Zheng’s 23/23 HP, 78 vigor and +15 karma rest in place beside a mollusk', async () => {
  const { actions, run } = support();
  assert.equal(await run(), HANDLED);
  assert.deepEqual(actions, ['rest', 'stand']);
});

test('a positive support with a real HP deficit keeps emergency recovery', async () => {
  const { actions, run } = support({ health: 20 });
  assert.equal(await run(), HANDLED);
  assert.deepEqual(actions, ['emergency shelter']);
});

test('open support rest requires known positive karma, the Ocean and never_attack', async () => {
  for (const opts of [{ karma: -82 }, { karma: null }, { map: 535 }, { neverAttack: false }]) {
    const { actions, run } = support(opts);
    assert.equal(await run(), HANDLED);
    assert.deepEqual(actions, ['emergency shelter'], JSON.stringify(opts));
  }
});

test('a loss of positive karma while the rest packet is paced stops it before sending', async () => {
  const { actions, run } = support({ beforeRest: c => c.statsById.set('karma', { value: 0 }) });
  assert.equal(await run(), HANDLED);
  assert.deepEqual(actions, []);
});
