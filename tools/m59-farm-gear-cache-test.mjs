import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BP, M59Client } from './m59-client.mjs';
import { normalizeBook } from './m59-dibs.mjs';
import { boundFarmGearPiles } from './m59-farm-gear-cache-record.mjs';
import { tryFarmGearCache } from './m59-farm-gear-cache.mjs';
import { OF } from './m59-parse.mjs';

const NOW = 1_800_000_000_000;
const AXE = 123, LEATHER = 124;
const names = new Map([[11, 'Statler'], [12, 'axe'], [13, 'leather armor']]);

function fixture() {
  let at = NOW, looked, description = 'This weapon is in flawless condition.';
  const me = { id: 21, row: 43, col: 55 };
  const holder = { id: 22, nameRsc: 11, row: 43, col: 57, flags: OF.PLAYER };
  const axe = { id: AXE, nameRsc: 12, row: 44, col: 56, amount: 0, rarity: 0, flags: OF.GETTABLE };
  const leather = { ...axe, id: LEATHER, nameRsc: 13, row: 43 };
  const v = { vigor: { value: 183 }, health: { value: 125, max: 125 } };
  const manifest = { schema: 'm59-farm-gear-cache/1', server: { host: 'offline.test', port: 5959 },
    room: 552, room_security: 7, last_save_at: NOW - 1000, observed_at: NOW - 100, expires_at: NOW + 60_000,
    holder: { ...holder, name: 'Statler' },
    items: [{ ...leather, name: 'leather armor' }, { ...axe, name: 'axe' }] };
  const sends = [], notes = [], equipped = [], arrived = [];
  const c = {
    state: 'game', combatReady: true, self: me, selfId: me.id, inventory: [],
    idGenerations: [], idsTrackedSince: NOW - 2000, me: { name: 'Bunsen' }, rsc: names,
    room: { id: 700, security: 7, objects: new Map([[holder.id, holder], [axe.id, axe], [leather.id, leather]]) },
    vitals: () => v, stat: key => key === 'might' ? 40 : null, ailments: () => [],
    equipment: () => ({ known: true, equipped }),
    idsAsOf: () => ({ inventory_at: at - 50, last_save_at: NOW - 950, last_save_began_at: NOW - 1100 }),
    look: id => { looked = id; },
    waitFor: async ({ kinds }) => ({ events: kinds.includes('look') ? [{ kind: 'look', id: looked, description }] : [] }),
    get: M59Client.prototype.get,
    send: (opcode, data) => {
      sends.push(opcode);
      const id = data.readUInt32LE(0);
      const item = c.room.objects.get(id);
      c.room.objects.delete(id);
      c.inventory.push(item);
    },
  };
  const s = {
    client: c, live: true, name: 't5', credentials: { host: 'offline.test', port: 5959 },
    world: { room: { num: 552 }, geometry: { security: 7, collisionReady: true, rows: 2, cols: 2,
      grid: Array(4), monsterGrid: Array(4) } },
    pacer: { submit: async (_verb, send) => send() },
  };
  const pilot = {
    s, mode: 'farm', policy: { assignedRoom: 552, townTrips: false },
    facultyHeld: () => false, playerThreatPresent: () => false, inReachOfUs: () => [],
    casterScene: () => ({ complete: true, casters: [] }),
    noteWeaponArrived: ids => arrived.push(...ids),
    ledgerEvent: (event, value) => notes.push([event, value]),
  };
  const run = (read = () => manifest, readClaims = () => ({ claims: [] })) =>
    tryFarmGearCache(pilot, { read, readClaims, now: () => at });
  return { c, s, pilot, manifest, axe, leather, holder, v, sends, notes, equipped, arrived, run,
    setAt: value => { at = value; }, setDescription: value => { description = value; } };
}

test('registered vendor gear is taken one exact nonstack object at a time, even with no town trips', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.sends, [BP.REQ_GET]);
  assert.deepEqual(f.c.inventory.map(x => x.id), [AXE], 'unarmed bodies choose the axe first');
  assert.deepEqual(f.arrived, [AXE]);
  assert.equal(await f.run(), false, 'the same body may only take one per interval');
  f.setAt(NOW + 16_000);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.c.inventory.map(x => x.id), [AXE, LEATHER]);
  assert.deepEqual(f.notes.map(([, note]) => note.item), ['axe', 'leather armor']);
});

test('a carried axe and sound worn armour are enough, and unrelated floor twins remain unrelated', async () => {
  const f = fixture();
  f.c.inventory.push({ id: 33, nameRsc: 12, rarity: 0 });
  f.equipped.push({ id: 33, name: 'axe' }, { id: 34, name: 'chain armor' });
  f.c.room.objects.set(AXE + 5, { ...f.axe, id: AXE + 5 });
  assert.deepEqual(boundFarmGearPiles(f.s, f.c, f.manifest, NOW).map(x => x.id), [LEATHER, AXE]);
  assert.equal(await f.run(), false);
  assert.deepEqual(f.sends, []);
});

test('fresh exact condition and native rarity, room/save and danger are required at the send', async () => {
  for (const change of [
    f => f.setDescription('This axe has been shattered by a powerful blow.'),
    f => f.setDescription('Axe with an unread condition.'),
    f => { f.axe.rarity = 100; },
    f => { f.c.self.row -= 10; },
    f => { f.c.idsAsOf = () => ({ inventory_at: NOW, last_save_began_at: NOW - 75 }); },
    f => { f.c.idsAsOf = () => ({ inventory_at: NOW - 2000, last_save_at: null }); },
    f => { f.holder.row++; },
    f => { f.v.health.value--; },
    f => { f.pilot.policy.neverAttack = true; },
    f => { f.pilot.casterScene = () => ({ complete: false, casters: [] }); },
    f => { f.s.pacer.submit = async (verb, send) => {
      if (verb === 'get') f.pilot.playerThreatPresent = () => true;
      return send();
    }; },
    f => { f.s.pacer.submit = async (verb, send) => {
      if (verb === 'get') f.c.idGenerations = [];
      return send();
    }; },
  ]) {
    const f = fixture();
    f.manifest.items = f.manifest.items.filter(x => x.id === AXE);
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.sends, []);
  }
});

test('the ward stash authorizes exact access without overriding another claim or inventing a pickup', async () => {
  const stash = { room: 552, item: 'axe', for: ['Statler'], source: 'floor-cache',
    near: { row: 43, col: 57, radius: 3 } };
  const allowed = fixture();
  assert.equal(await allowed.run(undefined, () => normalizeBook({ claims: [stash] })), true);
  const denied = fixture();
  denied.manifest.items = denied.manifest.items.filter(x => x.id === AXE);
  assert.equal(await denied.run(undefined, () => normalizeBook({ claims: [stash, { ...stash, source: 'operator' }] })), false);
  assert.deepEqual(denied.sends, []);
  const uncertain = fixture();
  uncertain.c.send = opcode => uncertain.sends.push(opcode);
  assert.equal(await uncertain.run(), false);
  assert.equal(await uncertain.run(), false);
  assert.deepEqual(uncertain.sends, [BP.REQ_GET]);
  assert.deepEqual(uncertain.notes, []);
});

test('a bad condition read on one object does not strand other registered gear', async () => {
  const f = fixture();
  f.setDescription('This axe has been shattered by a powerful blow.');
  assert.equal(await f.run(), false);
  f.setAt(NOW + 16_000);
  f.setDescription('This armor is in flawless condition.');
  assert.equal(await f.run(), true);
  assert.deepEqual(f.c.inventory.map(o => o.id), [LEATHER]);
  assert.equal(f.pilot.dressedAt, 0, 'the next native dressing check can equip the replacement');
});

test('a post-save keeper without a local save timestamp can use a later registration', async () => {
  const f = fixture();
  f.c.idsTrackedSince = NOW - 600;
  f.c.idsAsOf = () => ({ inventory_at: NOW - 50, last_save_at: null, last_save_began_at: null });
  assert.equal(await f.run(), true);
  assert.deepEqual(f.c.inventory.map(o => o.id), [AXE]);
});
