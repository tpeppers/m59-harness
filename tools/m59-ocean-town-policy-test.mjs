import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.M59_LEDGER_DIR = mkdtempSync(join(tmpdir(), 'm59-ocean-town-test-'));
const { Autopilot, CONTINUE, HANDLED } = await import('./m59-autopilot.mjs');
const { usesOceanCourier } = await import('./m59-farm-town.mjs');
const { fieldFor, validateStrategy } = await import('./m59-strategy-schema.mjs');

const policy = { assignedRoom: 552, townTrips: false };
const keeper = fields => Object.assign(Object.create(Autopilot.prototype), { policy: { ...policy }, ...fields });

test('the farm strategy can apply the existing no-town order only to its Ocean fighters', () => {
  assert.equal(usesOceanCourier(policy), true);
  assert.equal(usesOceanCourier({ ...policy, neverAttack: true }), false);
  assert.equal(usesOceanCourier({ ...policy, assignedRoom: 544 }), false);
  assert.equal(usesOceanCourier({ ...policy, townTrips: true }), false);
  const checked = validateStrategy({ name: 'ocean-courier', confine: { station: 552 }, townTrips: false });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.unrecognised, []);
  assert.equal(fieldFor('townTrips').arg, 'town_trips');
  assert.equal(fieldFor('townTrips').faculty, 'economy');
});

test('routine load and strategy requests cannot open a trip but an operator request can', async () => {
  const calls = [];
  const k = keeper({ s: { name: 'ocean-town-test' }, townTripHeld: () => false,
    askTownStrategy: async () => { calls.push('strategy'); },
    openRequestedTownTrip: async () => { calls.push('operator'); return true; },
  });
  assert.equal(await k.bankRun(), false);
  k.operatorTripRequest = { by: 'strategy:town-test' };
  assert.equal(await k.bankRun(), false);
  assert.equal(k.operatorTripRequest, null);
  k.operatorTripRequest = { by: 'operator' };
  assert.equal(await k.bankRun(), true);
  assert.deepEqual(calls, ['operator']);
  assert.equal(await k.vaultRunIfPassing(), false, 'routine vault lookup also stands down');
});

test('stops only autonomous town trips and keeps an in-flight survival pause intact', async () => {
  const trips = [];
  const k = keeper({ s: {}, travelInterrupted: () => false,
    abandonTownTrip: trip => { trips.push(trip.purpose); k.townTrip = null; } });
  for (const purpose of ['sell', 'restock', 'strategy']) {
    k.townTrip = { purpose };
    k.suspendedJourney = { to: 544 };
    assert.equal(await k.continueTownTrip(), true);
    assert.equal(k.townTrip.purpose, purpose);
    k.suspendedJourney = null;
    assert.equal(await k.continueTownTrip(), false);
  }
  k.townTrip = { purpose: 'operator', nextTryAt: Date.now() + 2000 };
  assert.equal(await k.continueTownTrip(), true);
  assert.deepEqual(trips, ['sell', 'restock', 'strategy']);
});

test('a settled routine economic journey is retired without removing recovery or FleetScript objectives', async () => {
  const room = { num: 552 };
  const v = { health: { value: 90, max: 120 }, vigor: { value: 170 } };
  const origin = { source: 'keeper', name: 'town_trip' };
  const k = keeper({ s: { client: {}, world: { room } }, tally: { deaths: 0 },
    who: () => 'Ocean test', note: () => {}, releaseRestedHold: async () => {},
    resumeDeclined: () => CONTINUE });
  const suspend = value => { k.suspendedJourney = { to: 200, at: Date.now(), deaths_at: 0, origin: value }; };
  suspend(origin);
  k.hold = {};
  await k.resumeSuspendedJourney({ room, v, hp: 0.75 });
  assert.ok(k.suspendedJourney, 'the recovery hold keeps its objective until released');
  k.hold = null;
  await k.resumeSuspendedJourney({ room, v, hp: 0.75 });
  assert.equal(k.suspendedJourney, null);
  for (const protectedOrigin of [{ source: 'keeper', name: 'recovery_detour' },
    { source: 'fleetscript', name: 'explicit travel' }]) {
    suspend(protectedOrigin);
    await k.resumeSuspendedJourney({ room, v, hp: 0.75 });
    assert.equal(k.suspendedJourney?.origin, protectedOrigin);
    k.wantsForwardShelter = null;
  }
});

test('an unarmed full-pack fighter neither seeks mana nor opens a sale or stops the keeper', async () => {
  const actions = [];
  const room = { num: 552 };
  const c = { vitals: () => ({ health: { value: 124, max: 124 }, mana: { value: 32 }, vigor: { value: 106 } }),
    equipment: () => ({ known: true, equipped: [] }), inventory: [{ id: 7, nameRsc: 8, amount: 560 }],
    rsc: new Map([[8, 'red mushroom']]), stat: name => name === 'might' ? 55 : null };
  const k = keeper({ s: { client: c, world: { room } }, mode: 'farm', trainingStyleFor: () => null,
    clearRefusal: () => {}, safety: () => ({ fleeAt: 0.5 }), sweepBroken: async () => {}, sweepCursed: async () => {},
    armSelf: async () => false, knowsCreateWeapon: () => true, sanctuary: () => false,
    leaveForManaWhileUnarmed: async () => actions.push('left'), settle: async () => actions.push('rested'),
    unarmedMakeSpace: async () => { actions.push('make-space'); return false; },
    bankRun: async () => actions.push('sale-trip'), refuse: () => {}, note: () => {},
    noProgress: why => actions.push(why), stop: () => actions.push('stopped') });
  assert.equal(await k.passArm({ s: k.s, c, room }), HANDLED);
  assert.deepEqual(actions, ['make-space', 'unarmed -- 0 bulk free, needs 70 to hold one']);
  k.knowsCreateWeapon = () => false;
  k.wantsWeapon = { why: 'old outfit request' };
  assert.equal(await k.passArm({ s: k.s, c, room }), CONTINUE);
  assert.equal(k.wantsWeapon, null);
  assert.equal(actions.at(-1), 'unarmed — waiting for a ward cache weapon');
});
