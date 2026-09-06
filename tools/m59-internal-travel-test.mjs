#!/usr/bin/env node
// Offline: hold the real keeper travel await open and tick its real travel guard.
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { freshState } from './m59-watchdog.mjs';

const fixture = (policy = {}) => {
  let finish, fail, entered;
  const ready = new Promise(r => { entered = r; });
  const moving = new Promise((r, j) => { finish = r; fail = j; });
  let health = 21, crowd = false, cancels = 0;
  const objects = new Map();
  const k = Object.assign(Object.create(Autopilot.prototype), {
    policy, doing: 'travelling', tally: {}, watch: freshState(), passes: 93,
    passStartedAt: Date.now() - 10_000, claims: new Map(),
    note() {}, progress() {}, ledgerEvent() {}, detailEvent() {}, recordFrame() {},
    hitDamageTotal: () => 0, answerWedge: async () => null,
    restBeforeSettingOut: async () => {}, travelHold: async () => {},
    book: { save() {} }, sanctuary: () => false, crowded: () => crowd,
    noteCrowdRefusal() {}, armed: () => true, safety: () => ({ fleeAt: 0.4 }),
    travelDivertAt: () => 1, travelShelterBelow: () => 1,
    fightBackCheck() {}, pulsePosition() {},
    s: {
      name: null, live: true,
      world: { room: { num: 584, name: 'The Flatlands' },
               route: () => ({ found: true, hops: [{}, {}] }) },
      client: { state: 'game', selfId: 1, self: { row: 35, col: 27 },
                room: { objects },
                vitals: () => ({ health: { value: health, max: 21 },
                                 vigor: { value: 80, scale_max: 200 } }) },
      travel: async () => { entered(); return moving; },
      cancelMovement: () => { cancels++; return { cancelled: true }; },
    },
  });
  return { k, ready, finish, fail, objects, cancels: () => cancels,
           hurt: n => { health = n; }, crowd: value => { crowd = value; } };
};

const f = fixture();
const trip = f.k.travel(104, {});
await f.ready;
assert.equal(f.k.inert, undefined, 'an internal trip must not yield keeper ownership');
assert.equal(typeof f.k.s.shelterPolicy?.need, 'function', 'the mover receives route protection');
assert.equal(f.k.internalTravel?.to, 104);
assert.equal(f.k.travelling?.to, 104, 'diagnostics and wedge recovery can name the internal route');
assert.equal(f.k.s.shelterPolicy.need(), false, 'full health needs no shelter');
f.hurt(13);
assert.equal(f.k.s.shelterPolicy.need(), true, 'damage is noticed during the blocked await');
f.crowd(true);
assert.equal(f.k.s.shelterPolicy.need(), false, 'the existing crowd rule is preserved');
f.crowd(false);
f.objects.set(2, { id: 2, flags: OF.ATTACKABLE, row: 35, col: 27 });
f.hurt(3);
f.k.watchdogTick();
assert.equal(f.cancels(), 0, 'monster damage alone does not abandon a default journey');
assert.equal(f.k.internalTravel.to, 104, 'the shop destination is retained');
f.objects.set(3, { id: 3, flags: OF.ATTACKABLE | OF.PLAYER, row: 35, col: 27 });
f.k.watchdogTick();
assert.equal(f.cancels(), 1, 'the real guard answers PVP before the blocked pass returns');
f.k.watchdogTick();
assert.equal(f.cancels(), 1, 'a cancelled internal journey cannot trigger the guard again');
f.finish({ arrived: false, reason: 'cancelled' });
await trip;
assert.equal(f.k.internalTravel, null);
assert.equal(f.k.s.shelterPolicy, null);
assert.equal(f.k.watch.lastError, undefined);

for (const throws of [false, true]) {
  const g = fixture({ travelGuard: { safe_spot: false, flee: false, fight_back: false } });
  const journey = g.k.travel(104, {});
  await g.ready;
  assert.equal(g.k.s.shelterPolicy, null, 'safe_spot off means no route shelter');
  g.objects.set(3, { id: 3, flags: OF.ATTACKABLE | OF.PLAYER, row: 35, col: 27 });
  g.hurt(3); g.k.watchdogTick();
  assert.equal(g.cancels(), 0, 'explicit guard switches still control PVP');
  assert.equal(g.k.watch.lastError, undefined);
  if (throws) {
    g.fail(new Error('synthetic travel failure'));
    await assert.rejects(journey, /synthetic travel failure/);
  } else {
    g.finish({ arrived: true });
    assert.equal((await journey).arrived, true);
  }
  assert.equal(g.k.internalTravel, null);
  assert.equal(g.k.s.shelterPolicy, undefined, 'the original policy is restored on every exit');
}

for (const held of [false, true]) {
  const g = fixture();
  const policy = { owner: 'existing driver' };
  g.k.s.shelterPolicy = policy;
  if (held) g.k.inert = { why: 'an external errand', at: Date.now() };
  const journey = g.k.travel(104, {});
  await g.ready;
  assert.equal(g.k.s.shelterPolicy, policy, 'an existing policy is not replaced');
  if (held) assert.equal(g.k.internalTravel, undefined, 'an errand gains no internal guard');
  const replacement = { owner: 'newer driver' };
  g.k.s.shelterPolicy = replacement;
  g.finish({ arrived: false }); await journey;
  assert.equal(g.k.s.shelterPolicy, replacement, 'cleanup cannot erase a newer driver');
}
{
  const g = fixture({ travelGuard: { arm: true } });
  const journey = g.k.travel(104, {}); await g.ready;
  g.k.armed = () => false;
  g.k.s.world.room = { num: 1, name: 'The Underworld' };
  g.k.watchdogTick();
  assert.equal(g.cancels(), 0, 'the travel guard must not interrupt the mortality escape');
  g.finish({ arrived: false }); await journey;
}

{
  const g = fixture();
  const journey = g.k.travel(104, { holdBetweenRooms: false }); await g.ready;
  assert.equal(g.k.internalTravel, undefined, 'an explicit retreat keeps its existing controls');
  assert.equal(g.k.s.shelterPolicy, undefined);
  g.finish({ arrived: true }); await journey;
}
console.log('Internal travel protection, doctrine, switches and lifecycle passed');
