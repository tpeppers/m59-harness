import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBook } from './m59-dibs.mjs';
import { FARM_SALE_CACHE_ANCHOR, FARM_SALE_CACHE_DROP, FARM_SALE_CACHE_EVENT, FARM_SALE_CACHE_WARD_SCHEMA,
  tryFarmSaleCache } from './m59-farm-sale-cache.mjs';
import { OF } from './m59-parse.mjs';
import { interest } from './m59-skills.mjs';

const start = 1_800_000_000_000;
const claim = name => ({ room: 552, item: name, source: 'ocean-sale-cache', for: ['Zheng He'],
  near: { ...FARM_SALE_CACHE_DROP, radius: 0 }, until: new Date(start + 3600000).toISOString() });

function fixture(name = 'blue mushroom', units = 120) {
  let time = start;
  const position = { ...FARM_SALE_CACHE_DROP };
  const holder = { id: 81, nameRsc: 11, flags: OF.PLAYER, ...FARM_SALE_CACHE_ANCHOR };
  const stock = { id: 41, nameRsc: 12, amount: units, tag: 1, rarity: 0 };
  const hp = { value: 122, max: 122 };
  const vigor = { value: 155 };
  const actions = [], records = [], events = [];
  const c = {
    combatReady: true, state: 'game', self: position, selfId: 21, idGenerations: [],
    me: { name: 'Bunsen' }, rsc: new Map([[11, 'Statler'], [12, name], [13, 'mollusk creature']]),
    inventory: [stock], room: { id: 51, security: 7, objects: new Map([[holder.id, holder]]) },
    vitals: () => ({ health: hp, vigor }), stat: () => 40, idsAsOf: () => ({ inventory_at: time, last_save_at: start - 1000 }),
    evSeq: 0, eventsSince: since => events.filter(event => event.seq > since), roomContents() {}, requestInventory() {},
    waitFor: async ({ kinds }) => ({ events: [{ kind: kinds[0] }] }),
    drop(specs) {
      actions.push(['drop', specs]);
      stock.amount -= specs[0].amount;
      const pile = { id: 91, nameRsc: 12, amount: specs[0].amount, flags: OF.GETTABLE, ...position };
      c.room.objects.set(pile.id, pile);
      events.push({ kind: 'appeared', id: pile.id, seq: ++c.evSeq });
    },
  };
  const geometry = { security: 7, collisionReady: true, rows: 2, cols: 2, grid: Array(4), monsterGrid: Array(4),
    inBounds: () => true, canMove: () => true, hasStepMask: true };
  const s = { name: 't5', client: c, live: true, movementGeneration: 5,
    world: { room: { num: 552 }, geometry }, pacer: { submit: async (_kind, send) => send() } };
  const row = { id: stock.id, name, amount: units, sale_amount: units, role: 'other', recommended: true, queued: true };
  const pilot = { s, mode: 'farm', policy: { assignedRoom: 552, townTrips: false },
    facultyHeld: () => false, playerThreatPresent: () => false, casterScene: () => ({ complete: true, casters: [] }),
    ownSalePlan: () => ({ items: [{ ...row, amount: stock.amount }] }), ledgerEvent: (...args) => records.push(args) };
  const pin = { schema: FARM_SALE_CACHE_WARD_SCHEMA, room: 552, room_security: 7, last_save_at: start - 1000,
    observed_at: start - 50, expires_at: start + 3600000, anchor: { id: 81, ...FARM_SALE_CACHE_ANCHOR } };
  const run = (extra = {}) => tryFarmSaleCache(pilot, { readClaims: () => normalizeBook({ claims: [claim(name)] }),
    readWard: () => structuredClone(pin), now: () => time, acquire: () => true, release: () => {}, ...extra });
  const advance = () => { time += 31000; };
  return { s, c, holder, stock, pilot, row, actions, records, hp, vigor, events, pin, run, advance };
}

test('records only the exact new sale parcel, anchored at the proven ward tile in the current save', async () => {
  const f = fixture('blue mushroom', 74);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.actions, [['drop', [{ id: 41, amount: 50 }]]]);
  assert.equal(f.stock.amount, 24);
  assert.deepEqual(f.records, [[FARM_SALE_CACHE_EVENT, {
    room: 552, room_security: 7, last_save_at: start - 1000, anchor: { id: 81, ...FARM_SALE_CACHE_ANCHOR },
    courier: 'Zheng He', item: { id: 91, name: 'blue mushroom', amount: 50, ...FARM_SALE_CACHE_DROP },
    previous_amount: 0, deposited_amount: 50, observed_at: start, expires_at: start + 300000,
  }]]);
  assert.equal(await f.run(), false, 'a pass cannot immediately deposit again');
});

function mergeFixture() {
  const f = fixture('blue mushroom', 50);
  const pile = { id: 91, nameRsc: 12, amount: 32, flags: OF.GETTABLE, ...FARM_SALE_CACHE_DROP };
  const emit = (kind, id = pile.id) => f.events.push({ kind, id, seq: ++f.c.evSeq });
  f.c.room.objects.set(pile.id, pile);
  f.c.drop = specs => {
    f.actions.push(['drop', specs]);
    f.stock.amount -= specs[0].amount;
    pile.amount += specs[0].amount;
    emit('changed');
  };
  return { ...f, pile, emit };
}

test('receipts a native same-handle stack merge by its exact inventory and floor delta', async () => {
  const f = mergeFixture();
  assert.equal(await f.run(), true);
  assert.equal(f.stock.amount, 24);
  assert.deepEqual(f.records, [[FARM_SALE_CACHE_EVENT, {
    room: 552, room_security: 7, last_save_at: start - 1000, anchor: { id: 81, ...FARM_SALE_CACHE_ANCHOR },
    courier: 'Zheng He', item: { id: 91, name: 'blue mushroom', amount: 58, ...FARM_SALE_CACHE_DROP },
    previous_amount: 32, deposited_amount: 26, observed_at: start, expires_at: start + 300000,
  }]]);
});

test('refuses ambiguous, replaced, or unproved floor merges', async () => {
  for (const [setup, disturb] of [
    [f => f.c.room.objects.set(92, { ...f.pile, id: 92 }), f => {
      f.c.room.objects.get(92).amount++;
      f.emit('changed', 92);
    }],
    [null, f => { f.emit('vanished'); f.emit('appeared'); }],
    [null, f => { f.pile.col++; }],
    [null, f => { f.pile.amount++; }],
    [null, f => { f.stock.amount++; }],
    [f => f.emit('changed'), f => { f.events.pop(); }],
  ]) {
    const f = mergeFixture();
    setup?.(f);
    const native = f.c.drop.bind(f.c);
    f.c.drop = specs => { native(specs); disturb(f); };
    assert.equal(await f.run(), true);
    assert.deepEqual(f.records, [['farm_sale_cache_unverified', { room: 552, item: 'blue mushroom', amount: 26 }]]);
  }
});

test('keeps native sale allowance, working floors, exact fleet demand, and protected objects', async () => {
  const f = fixture('red mushroom', 150);
  f.row.sale_amount = 32;
  interest.declare('need-exact-red', { needs: new Map([['red mushrooms', 30], ['mushroom', 100]]) });
  try {
    assert.equal(await f.run(), true);
    assert.equal(f.stock.amount, 126);
    assert.deepEqual(f.actions, [['drop', [{ id: 41, amount: 24 }]]]);
  } finally { interest.forget('need-exact-red'); }
  for (const change of [
    f => f.row.blocked = 'loadout keep',
    f => f.row.merchant_only = true,
    f => f.row.equipped = true,
    f => f.pilot.heldBackIds = () => new Set([41]),
    f => f.stock.rarity = 100,
    f => f.s.lootDisposition = () => ({ action: 'keep', reason: 'operator veto' }),
  ]) {
    const g = fixture();
    change(g);
    assert.equal(await g.run(), false);
    assert.deepEqual(g.actions, []);
  }
});

test('requires a live exact courier claim, no competing pickup rights, and quiet current IDs', async () => {
  for (const claims of [[], [{ ...claim('blue mushroom'), for: ['Statler'] }],
    [{ ...claim('blue mushroom'), near: { ...FARM_SALE_CACHE_DROP, radius: 3 } }],
    [claim('blue mushroom'), { ...claim('blue mushroom'), for: ['Other'] }],
    [{ ...claim('blue mushroom'), until: new Date(start + 1000).toISOString() }]]) {
    const f = fixture();
    assert.equal(await f.run({ readClaims: () => normalizeBook({ claims }) }), false);
    assert.deepEqual(f.actions, []);
  }
  for (const change of [
    f => f.pilot.policy.townTrips = true,
    f => f.pilot.policy.neverAttack = true,
    f => f.hp.value--,
    f => f.vigor.value = 139,
    f => f.holder.col++,
    f => f.c.idsAsOf = () => ({ inventory_at: start - 1100, last_save_at: null }),
    f => f.pilot.casterScene = () => ({ complete: false, casters: [] }),
    f => f.pilot.casterScene = () => ({ complete: true, casters: [{ name: 'mollusk creature', row: 49, col: 56 }] }),
    f => f.c.room.objects.set(9, { id: 9, flags: OF.ATTACKABLE, row: 44, col: 59 }),
    f => f.pilot.facultyHeld = faculty => faculty === 'economy',
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.actions, []);
  }
});

test('uses the canonical pinned epoch despite native clock skew or a post-save keeper roll', async () => {
  for (const native of [null, start - 900]) {
    const f = fixture();
    f.c.idsAsOf = () => ({ inventory_at: start, last_save_at: native });
    assert.equal(await f.run(), true);
    assert.equal(f.records[0][1].last_save_at, f.pin.last_save_at);
  }
  for (const change of [
    f => f.pin.anchor.id++,
    f => f.pin.expires_at = start,
    f => f.pin.room_security++,
    f => f.c.idsAsOf = () => ({ inventory_at: start, last_save_at: start, last_save_began_at: start - 20 }),
    f => f.c.idsAsOf = () => ({ inventory_at: start, last_save_at: null, saving: true }),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.actions, []);
  }
});

test('refuses a sixth ward pile, concurrent deposit, or changed authorization at the packet', async () => {
  const packed = fixture();
  for (let id = 90; id < 95; id++) packed.c.room.objects.set(id, { id, flags: OF.GETTABLE, ...FARM_SALE_CACHE_DROP });
  assert.equal(await packed.run(), false);
  const other = fixture();
  assert.equal(await other.run({ acquire: () => false }), false);
  const f = fixture();
  f.s.pacer.submit = async (kind, send) => {
    if (kind === 'drop') f.hp.value--;
    return send();
  };
  assert.equal(await f.run(), false);
  const repinned = fixture();
  repinned.s.pacer.submit = async (kind, send) => {
    if (kind === 'drop') repinned.pin.observed_at++;
    return send();
  };
  assert.equal(await repinned.run(), false);
  for (const g of [packed, other, f, repinned]) assert.deepEqual(g.actions, []);
});

test('an unverified drop has no courier receipt and cannot be repeated on that handle', async () => {
  const f = fixture();
  const native = f.c.drop.bind(f.c);
  f.c.drop = specs => { native(specs); f.events.length = 0; };
  assert.equal(await f.run(), true);
  assert.equal(f.records[0][0], 'farm_sale_cache_unverified');
  f.advance();
  assert.equal(await f.run(), false);
  assert.equal(f.actions.length, 1);
});

test('approaches the exact tile only for a near-full pack and along a bounded quiet proof', async () => {
  for (const units of [100, 480]) {
    const f = fixture('blue mushroom', units);
    f.c.self.col = 54;
    const steps = [{ row: 44, col: 55 }, { ...FARM_SALE_CACHE_DROP }];
    f.s.world.geometry.path = () => ({ found: true, steps });
    f.s.walkTo = async (col, row, opts) => {
      f.actions.push(['walk', col, row]);
      for (const point of steps) {
        assert.equal(opts.beforeMutation('move', point), true);
        assert.equal(opts.beforeMutation('move', { row: point.row + 1, col: point.col }), false);
        Object.assign(f.c.self, point);
      }
    };
    assert.equal(await f.run(), units === 480);
    assert.deepEqual(f.actions.map(row => row[0]), units === 480 ? ['walk', 'drop'] : []);
  }
});

test('only a virtually full pack can take a quiet 27-step diagonal ward approach', async () => {
  for (const [units, detour, hazard, allowed] of [
    [497, false, false, true], [495, false, false, false],
    [497, true, false, false], [497, false, true, false],
  ]) {
    const f = fixture('blue mushroom', units);
    Object.assign(f.c.self, { row: 61, col: 30 });
    const steps = [{ row: 60, col: 30 }, ...Array.from({ length: 26 }, (_, i) => ({
      row: Math.max(44, 59 - i), col: 31 + i,
    }))];
    if (detour) steps.unshift({ row: 61, col: 29 }, { row: 61, col: 30 });
    if (hazard) f.c.room.objects.set(9, { id: 9, flags: OF.ATTACKABLE, row: 54, col: 38 });
    f.s.world.geometry.path = () => ({ found: true, steps });
    f.s.walkTo = async (_col, _row, opts) => {
      assert.equal(opts.maxSteps, 28);
      assert.equal(opts.hardCap, 28);
      f.actions.push(['walk']);
      for (const step of steps) {
        assert.equal(opts.beforeMutation('move', step), true);
        Object.assign(f.c.self, step);
      }
    };
    assert.equal(await f.run(), allowed);
    assert.deepEqual(f.actions.map(row => row[0]), allowed ? ['walk', 'drop'] : []);
  }
});
