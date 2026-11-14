import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Autopilot, HANDLED } from './m59-autopilot.mjs';
import { publishFleetHealth } from './m59-fleet-health.mjs';
import { setRosterSource } from './m59-party.mjs';
import { OF } from './m59-parse.mjs';
import { relayFarmPeerEvidence } from './m59-relay-farming.mjs';
import { Stomach } from './m59-skills.mjs';

const room = { num: 552 };
const positions = new Map([
  [1, { id: 1, nameRsc: 101, row: 16, col: 16, flags: OF.PLAYER }],
  [2, { id: 2, nameRsc: 102, row: 16, col: 17, flags: OF.PLAYER }],
]);
const names = new Map([[101, 'Donor'], [102, 'Peer'], [103, 'relay'], [104, 'edible mushroom']]);

function session(id, vigor, restCap, directory) {
  const records = [];
  const vitals = {
    health: { value: 100, max: 100 },
    vigor: { value: vigor, scale_max: 200, rest_threshold: restCap },
    mana: { value: 30, max: 30 },
  };
  const self = positions.get(id);
  const c = {
    state: 'game', combatReady: true, selfId: id, self, me: { name: names.get(self.nameRsc) },
    room: { id: 1552, objects: new Map(positions) },
    rsc: names, vitals: () => structuredClone(vitals), ailments: () => [], evSeq: 0,
    inventoryAt: Date.now(),
    inventory: [{ id: 10, name: 'edible mushroom', nameRsc: 104, amount: 1 }],
    equipment: () => ({ known: true, equipped: [{ name: 'axe' }] }),
    spells: [{ id: 77, name: 'relay', nameRsc: 103 }],
    stats: () => {},
    waitFor: async () => ({ events: [] }),
    stand: () => { c.lastPostureCommand = { verb: 'stand', room_object_id: c.room.id }; },
    cast: (_spell, targets) => {
      assert.deepEqual(targets, [2]);
      records.push('relay');
      vitals.vigor.value = 60;
      return true;
    },
    rest: () => { records.push('rest'); vitals.vigor.value = restCap; },
  };
  const s = {
    name: id === 1 ? 't1' : 't2', client: c, need: () => c, live: true, world: { room },
    credentials: { host: 'offline.test', port: 5959 },
    fleetStateFile: join(directory, 'roster.json'),
    faceToward: async () => {},
    pacer: { submit: async (_kind, fn) => fn() },
  };
  const p = Object.assign(Object.create(Autopilot.prototype), {
    s, mode: 'farm', running: true, tally: {}, passes: 1, hold: { proven: true },
    policy: {
      hunt: ['mollusk creature', 'frogman'], assignedRoom: room.num,
      relayBeforeRest: true, strategy: 'baseline', fleeBelow: 0.5,
      restBelow: 0.65, holdResumeAbove: 0.9,
    },
    note: () => {}, progress: () => {},
    recordCast: () => {},
    operatorSurvivalStandDown: () => false,
    farmBuffPass: async () => false,
    escapeIfWedgedAndHurt: async () => false,
    tradeInPlaceIfWedged: async () => false,
    defensiveAnswer: async () => false,
    leaveForCasters: async () => false,
    holdWorks: () => true,
    sanctuary: () => false,
    currentRecoveryWall: () => false,
    releaseRestedHold: async () => false,
    healObservedFleetmate: async () => false,
    isRoomEnchantPost: () => false,
    tooTiredToTravel: () => false,
    travelInterrupted: () => false,
    checkFreeze: () => false,
    facultyHeld: () => false,
    threat: () => ({ landing: 0 }),
    armedForSure: () => true,
    safety: () => ({ engageAt: 0.9, fleeAt: 0.5 }),
    eatToFloor: async () => { records.push('eat'); return 'ate'; },
  });
  s.relayFarmEvidence = v => relayFarmPeerEvidence(p, v);
  const ctx = () => ({ s, c, room, v: c.vitals(), hp: 1 });
  return { p, s, c, ctx, records };
}

test('real survival pass spends one Relay, rests past 80 to the personal cap, then provisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'm59-relay-sequence-'));
  const old = process.env.M59_FLEET_HEALTH_DIR;
  process.env.M59_FLEET_HEALTH_DIR = directory;
  setRosterSource(() => new Set(['Donor', 'Peer']));
  try {
    const donor = session(1, 89, 94, directory);
    const peer = session(2, 115, 80, directory);
    donor.p.hold = null;
    donor.p.holdWorks = () => !!donor.p.hold;
    donor.p.takeSafeSpot = async () => {
      donor.records.push('shelter');
      donor.p.hold = { proven: true };
      return { took: true };
    };
    assert(publishFleetHealth(peer.s));
    assert.equal(await donor.p.passFleeAndRest(donor.ctx()), HANDLED);
    assert.deepEqual(donor.records, ['shelter', 'relay']);

    publishFleetHealth(peer.s);
    assert.equal(await donor.p.passFleeAndRest(donor.ctx()), HANDLED);
    assert.deepEqual(donor.records, ['shelter', 'relay', 'rest']);
    assert.equal(donor.c.vitals().vigor.value, 94);

    assert.equal(await donor.p.passFleeAndRest(donor.ctx()), HANDLED);
    assert.deepEqual(donor.records, ['shelter', 'relay', 'rest', 'eat']);

    const solo = session(1, 89, 94, directory);
    solo.c.room.objects.delete(2);
    assert.equal(await solo.p.passFleeAndRest(solo.ctx()), HANDLED);
    assert.deepEqual(solo.records, ['eat'], 'a solo farmer uses ordinary provisioning');
  } finally {
    if (old == null) delete process.env.M59_FLEET_HEALTH_DIR;
    else process.env.M59_FLEET_HEALTH_DIR = old;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('optional Ocean top-offs keep edible mushrooms for Relay', async () => {
  const donor = session(1, 198, 94, 'fixture');
  donor.p.policy.vigorCeiling = 200;
  donor.p.stomach = new Stomach();
  donor.p.fightFloor = () => 140;
  donor.p.poorFarmingActive = () => false;
  donor.p.warnedThroughput = true;
  donor.p.notOursToEat = () => [];
  donor.p.recordAte = () => {};
  donor.c.requestInventory = () => {};
  donor.c.apply = id => donor.records.push(id);
  await donor.p.provision({}, donor.c.vitals());
  assert.deepEqual(donor.records, []);
  donor.s.world.room = { num: 544 };
  await donor.p.provision({}, donor.c.vitals());
  // 2026-11-14 (reagentFoodNames): a character that KNOWS a spell eating this food keeps it through every optional
  // top-off, in or out of the Relay room -- 2,087 edible mushrooms were eaten fleet-wide in a day.
  assert.deepEqual(donor.records, [], 'outside the Relay room a Relay caster still keeps its reagent from a top-off');
  donor.c.spells = [];
  donor.p._reagentFood = null;
  await donor.p.provision({}, donor.c.vitals());
  assert.deepEqual(donor.records, [10], 'a character with no spell that uses it eats it like any food');
});
