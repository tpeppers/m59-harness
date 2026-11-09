import assert from 'node:assert/strict';
import { test } from 'node:test';
import { M59Client } from './m59-client.mjs';
import { tryFarmFoodCache } from './m59-farm-food-cache.mjs';
import { foodValue } from './m59-items.mjs';
import { OF } from './m59-parse.mjs';

const now = 1_800_000_000_000;

function fixture() {
  const me = { id: 21, row: 43, col: 55 };
  const holder = { id: 22, name: 'Statler', nameRsc: 11, row: 43, col: 57, flags: OF.PLAYER };
  const pile = { id: 123, name: 'loaf of bread', nameRsc: 12, row: 44, col: 56, amount: 20, flags: OF.GETTABLE };
  const v = { vigor: { value: 142, rest_threshold: 94 }, health: { value: 125, max: 125 } };
  const manifest = { schema: 'm59-farm-food-cache/1', server: { host: 'offline.test', port: 5959 },
    room: 552, room_security: 7, observed_at: now - 100, expires_at: now + 60_000,
    holder: { ...holder }, item: { ...pile } };
  const sends = [], notes = [];
  const c = {
    state: 'game', combatReady: true, self: me, selfId: me.id, inventory: [],
    idGenerations: [], idsTrackedSince: now - 2000, me: { name: 'Bunsen' },
    room: { id: 700, security: 7, objects: new Map([[holder.id, holder], [pile.id, pile]]) },
    rsc: new Map([[11, holder.name], [12, pile.name]]), vitals: () => v,
    idsAsOf: () => ({ inventory_at: now - 50, last_save_at: now - 1000, last_save_began_at: now - 1100 }),
    stat: key => key === 'might' ? 40 : null, ailments: () => [],
    waitFor: async () => ({ events: [] }),
    containerObject: M59Client.prototype.containerObject,
    getFromContainer: M59Client.prototype.getFromContainer,
    send: (opcode, data) => {
      sends.push([opcode, data.toString('hex')]);
      pile.amount--;
      c.inventory.push({ id: 733, nameRsc: 12, amount: 1 });
    },
  };
  const s = {
    client: c, live: true, name: 't5', credentials: { host: 'offline.test', port: 5959 },
    world: { room: { num: 552 }, geometry: { security: 7, collisionReady: true, rows: 2, cols: 2,
      grid: Array(4), monsterGrid: Array(4) } },
    pacer: { submit: async (_verb, send) => send() },
  };
  const pilot = {
    s, mode: 'farm', policy: { assignedRoom: 552, relayBeforeRest: true },
    facultyHeld: () => false, playerThreatPresent: () => false, inReachOfUs: () => [],
    stomach: { roomFor: () => true }, larder: () => [], casterScene: () => ({ complete: true, casters: [] }),
    ledgerEvent: (event, value) => notes.push([event, value]),
  };
  const run = (read = () => manifest) => tryFarmFoodCache(pilot, { read, now: () => now });
  return { c, s, pilot, v, manifest, pile, holder, sends, notes, run };
}

test('takes exactly one portion with the existing native count opcode and leaves the pile in place', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.sends, [[239, '7b00001001000000']]);
  assert.equal(f.pile.amount, 19);
  assert.equal(f.c.room.objects.get(f.pile.id), f.pile);
  assert.deepEqual(f.notes, [['farm_food_cache_withdrawal', { room: 552, item: 'loaf of bread', amount: 1 }]]);
  assert.equal(await f.run(), false, 'the same keeper cannot immediately withdraw another');
});

test('leaves Relay and rest first and preserves personal food, stomach and pack room', async () => {
  for (const change of [
    f => f.v.vigor.value = 93,
    f => f.v.vigor.value = 181,
    f => f.pilot.secondWindFarming = () => ({ active: true, eat: false }),
    f => f.pilot.stomach.roomFor = () => false,
    f => f.pilot.larder = () => [{ name: 'loaf of bread', food: foodValue('loaf of bread') }],
    f => f.pilot.notOursToEat = () => ['loaves of bread', 'loaf of bread'],
    f => f.c.inventory.push({ id: 44, nameRsc: 12, amount: 1 }),
    f => f.c.inventory.push({ id: 44, nameRsc: 55, amount: 1 }),
    f => f.pilot.policy.neverAttack = true,
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.sends, []);
  }
});

test('refuses missing or stale exact cache evidence and rechecks danger at the paced packet', async () => {
  const noManifest = fixture();
  assert.equal(await noManifest.run(() => null), false);
  for (const change of [
    f => f.manifest.server.port++,
    f => f.manifest.expires_at = now,
    f => f.manifest.observed_at = now - 301_000,
    f => f.c.idsAsOf = () => ({ saving: true }),
    f => f.c.idsTrackedSince = now,
    f => f.pile.col++,
    f => f.holder.row++,
    f => f.c.self.col -= 4,
    f => f.s.moveOrder = { kind: 'travel' },
    f => f.pilot.casterScene = () => ({ complete: false, casters: [] }),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.sends, []);
  }

  const f = fixture();
  f.s.pacer.submit = async (_verb, send) => {
    f.pilot.playerThreatPresent = () => true;
    return send();
  };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.sends, []);
});

test('an unconfirmed server pickup is neither counted nor immediately retried', async () => {
  const f = fixture();
  f.c.send = () => f.sends.push('sent');
  assert.equal(await f.run(), false);
  assert.equal(await f.run(), false);
  assert.deepEqual(f.sends, ['sent']);
  assert.deepEqual(f.notes, []);
});
