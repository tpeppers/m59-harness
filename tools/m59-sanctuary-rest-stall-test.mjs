import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';
import { loadMap } from './m59-map.mjs';
import { OF } from './m59-parse.mjs';
import { World } from './m59-world.mjs';

function keeper(situation) {
  const map = loadMap(), room = map.rooms[situation === 'Ocean' ? 552 : 714];
  const self = { id: 7082, row: 20, col: 10, flags: OF.PLAYER };
  const actions = [];
  const health = { value: situation === 'hurt' ? 29 : 30, max: 30 };
  const v = { health, vigor: { value: situation === 'Raphael' ? 76 : 79, scale_max: 200, rest_threshold: 80 } };
  const c = {
    state: 'game', combatReady: true, selfId: self.id, self, evSeq: 0, events: [], rsc: new Map(),
    roomRsc: room.roomRsc, roomNameRsc: room.nameRsc,
    room: { id: 2568, security: room.roo.security, objects: new Map([[self.id, self]]) },
    statsById: new Map(), vitals: () => structuredClone(v), ailments: () => [],
    stats() {
      if (situation !== 'stale health') this.statsById.set('health', { observed_at: Date.now() });
      if (situation === 'Raphael' && actions.includes('rest')) v.vigor.value = 79;
    },
    waitFor: async () => ({ events: [] }),
    rest() { actions.push('rest'); },
    stand() {
      actions.push('stand');
      if (situation === 'late monster') this.room.objects.set(9, { id: 9, flags: OF.ATTACKABLE });
      if (situation === 'late player') this.room.objects.set(9, { id: 9, flags: OF.PLAYER });
      if (situation === 'recent damage') s.damagedAt = Date.now();
      if (situation === 'missed swing') s.lastCombatLine = { at: Date.now(), who: 'giant rat' };
      if (situation === 'unready') this.combatReady = false;
      if (situation === 'unknown room') this.roomRsc = null;
      if (situation === 'room changed') this.room.id++;
      if (situation === 'PvP') s.combat = { active: { pvp: true } };
    },
  };
  const s = {
    name: 'hk3-fixture', world: new World(c, map), client: c, need: () => c, live: true, damagedAt: 0,
    pacer: { submit: async (_lane, fn) => fn() },
  };
  const no = async () => false;
  const pilot = Object.assign(Object.create(Autopilot.prototype), {
    s, mode: 'survive', tally: { rests: 0 },
    policy: { fleeBelow: 0.7, restBelow: 0.8, holdResumeAbove: 0.9 },
    hold: { room: room.num, row: self.row, col: self.col, proven: true },
    note() {}, operatorSurvivalStandDown: () => false,
    farmBuffPass: no, escapeIfWedgedAndHurt: no, tradeInPlaceIfWedged: no, defensiveAnswer: no,
    leaveForCasters: no, eatToFloor: no, releaseRestedHold: no, healObservedFleetmate: no,
    holdWorks: () => true, currentRecoveryWall: () => null, isRoomEnchantPost: () => false,
    tooTiredToTravel: () => false, travelInterrupted: () => false,
    restBroken: async (_room, _near, opts) => actions.push(opts?.interruptedByAttack ? 'hit' : 'no progress'),
  });
  if (situation === 'hit prose') c.stats = function () {
    this.statsById.set('health', { observed_at: Date.now() });
    if (actions.includes('rest')) this.events.push({
      kind: 'message', at: Date.now(), seq: ++this.evSeq, text: 'The skeleton stabs you with its attack.',
    });
  };
  return { actions, run: () => pilot.passFleeAndRest({ s, c, room, v: c.vitals(), hp: health.value / health.max }) };
}

test('only a quiet, ready sanctuary ignores a sheltered full-health vigor stall', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  for (const situation of ['Raphael', 'hit prose', 'recent damage', 'missed swing', 'late monster',
    'late player', 'unready', 'stale health', 'unknown room', 'room changed', 'hurt', 'PvP', 'Ocean']) {
    const { actions, run } = keeper(situation);
    let done = false;
    const result = run().finally(() => { done = true; });
    for (let step = 0; step < 10 && !done; step++) { await immediate(); t.mock.timers.tick(3000); }
    await immediate();
    assert.ok(done, situation);
    assert.equal(await result, HANDLED, situation);
    const recovery = situation === 'Raphael' ? [] : [situation === 'hit prose' ? 'hit' : 'no progress'];
    assert.deepEqual(actions, ['rest', 'stand', ...recovery], situation);
  }
});
