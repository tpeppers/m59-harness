#!/usr/bin/env node
// Offline reagent coop capacity, quantity protocol, funding and keeper-resume tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coopConfig, COOP_REAGENTS, coopDepositPlan, coopTithePlan, coopFundingAmount,
  coopRemainingPlan, coopCount, coopKey, REAGENT_COOP_SCHEMA } from './m59-reagent-coop.mjs';
import { M59Client } from './m59-client.mjs';
import { weighItem } from './m59-items.mjs';
import { reflectPolicy, validateValue } from './m59-policy-controls.mjs';

// Set every runtime output path before importing the keeper, then register tests.
const root = mkdtempSync(join(tmpdir(), 'm59-coop-test-'));
process.env.M59_COOP_DIR = join(root, 'book');
process.env.M59_STORAGE_DIR = join(root, 'storage');
process.env.M59_EVIDENCE_DIR = join(root, 'evidence');
process.env.M59_UPTIME_FILE = join(root, 'uptime.jsonl');
process.env.M59_FLEET = 'coop-test';
process.env.M59_FLEETS_DIR = join(root, 'fleets');
mkdirSync(process.env.M59_FLEETS_DIR);
writeFileSync(join(process.env.M59_FLEETS_DIR, 'coop-test.secrets.json'), JSON.stringify({ guild_hall: { password: 'fixture' } }));
const { runReagentCoop, reagentCoopCommand } = await import('./m59-reagent-coop-runtime.mjs');
const { claimFleetLock } = await import('./runtime/fleet-lock.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const cfg = coopConfig({ enabled: true });
test('all spell reagent classes have an equal, weighable reservation', () => {
  const db = JSON.parse(readFileSync(new URL('../compendium/data/koddb.json', import.meta.url)));
  const classes = Object.values(db.classes), byName = new Map(classes.map(c => [c.name.toLowerCase(), c]));
  const names = new Set();
  for (const c of classes) for (const m of c.messages ?? []) if (m.name === 'ResetReagents') {
    for (const [, name] of m.body.matchAll(/\[\s*&([A-Za-z0-9_]+)/g)) {
      const item = byName.get(name.toLowerCase());
      names.add(coopKey(item.classvars.vrName.rsc.value));
    }
  }
  assert.deepEqual([...names].sort(), [...COOP_REAGENTS].sort());
  assert.equal(COOP_REAGENTS.length, 27);
  for (const name of COOP_REAGENTS) assert.ok(weighItem(name).bulk > 0, name);
});

test('per-type reserves preserve own floor, fill each chest, and sell overflow', () => {
  const config = coopConfig({ enabled: true, reagents: ['herbs', 'elderberries'] });
  const result = coopDepositPlan({ config,
    chests: config.chest_keys.map(slot => ({ slot, items: [{ name: 'herb', amount: 2690 }] })),
    pack: [{ name: 'herbs', amount: 150 }], saleItems: [{ name: 'herb', amount: 150 }], keepFloor: () => 40 });
  assert.equal(result.per_type_bulk, 10800);
  assert.deepEqual(result.plan.map(p => p.amount), [10, 10, 10]);
  assert.deepEqual(result.overflow, [{ item: 'herb', amount: 80 }]);
});
test('default 27-way allocation is 800 bulk and never rounds above it', () => {
  const result = coopDepositPlan({ config: cfg, chests: [{ slot: 'r18c2', items: [] }],
    pack: COOP_REAGENTS.map(name => ({ name, amount: 10000 })),
    saleItems: COOP_REAGENTS.map(name => ({ name, amount: 10000 })) });
  assert.equal(result.per_type_bulk, 800);
  assert.equal(result.plan.length, 27);
  for (const line of result.plan) assert.ok(line.amount * weighItem(line.item).bulk <= 800);
  assert.ok(result.plan.reduce((n, l) => n + l.amount * weighItem(l.item).bulk, 0) <= 21600);
});
test('unknown bulk, existing excess and non-sale items are never deposited', () => {
  for (const items of [[{ name: 'unrecognized object', amount: 1 }], [{ name: 'herb', amount: 250 }]]) {
    const result = coopDepositPlan({ config: cfg, chests: [{ slot: 'r18c2', items }],
      pack: [{ name: 'herb', amount: 500 }], saleItems: [{ name: 'herb', amount: 500 }] });
    assert.equal(result.plan.length, 0);
  }
  assert.equal(coopDepositPlan({ config: cfg, chests: [{ slot: 'r18c2', items: [] }],
    pack: [{ name: 'herb', amount: 500 }], saleItems: [] }).plan.length, 0);
});
test('cash tithe is 20%, rounds up, shares a global cap, and subtracts receipts', () => {
  assert.deepEqual(coopTithePlan({ config: cfg, bankable: 1001, stored: 0 }), { target: 201, amount: 201 });
  assert.equal(coopTithePlan({ config: cfg, bankable: 1000, stored: 74950 }).amount, 50);
  assert.equal(coopTithePlan({ config: cfg, bankable: 1000, stored: 75000 }).amount, 0);
  assert.equal(coopTithePlan({ config: cfg, bankable: 1000, stored: 80000 }).amount, 0);
  assert.equal(coopTithePlan({ config: cfg, bankable: 800, stored: 200, target: 200, paid: 200 }).amount, 0);
});
const shopping = { lines: [ { item: 'herb', amount: 10, unit_cost: 14, cost: 140 },
  { item: 'loaf of bread', amount: 2, unit_cost: 108, cost: 216 } ], unpriced: [], reserve: 100,
  known_cost: 356, expected_cost: 356, required_purse: 456 };
test('shared cash funds only the outstanding reagent bill, after free supplies', () => {
  const plan = coopRemainingPlan(shopping, [{ item: 'herbs', amount: 6 }]);
  assert.equal(plan.required_purse, 372);
  assert.equal(coopFundingAmount(plan, 0, cfg), 56);
  assert.equal(coopFundingAmount(plan, 350, cfg), 22);
  assert.equal(coopFundingAmount(plan, 999, cfg), 0);
  assert.equal(coopFundingAmount(coopRemainingPlan(plan, [{ item: 'herb', amount: 4 }]), 0, cfg), 0);
});
test('protocol sends tagged partial stacks, and plain non-stackables', () => {
  const sent = [], client = Object.create(M59Client.prototype);
  client.send = (op, ...buffers) => sent.push([op, Buffer.concat(buffers)]);
  client.put({ id: 123, amount: 17 }, 456);
  assert.equal(sent[0][0], 112);
  assert.equal(sent[0][1].toString('hex'), '7b00001011000000c8010000');
  client.getFromContainer({ id: 123, amount: 4 });
  assert.equal(sent[1][0], 239);
  assert.equal(sent[1][1].toString('hex'), '7b00001004000000');
  client.put(123, 456);
  assert.equal(sent[2][1].toString('hex'), '7b000000c8010000');
  client.getFromContainer(123);
  assert.equal(sent[3][1].toString('hex'), '7b000000');
  assert.throws(() => client.put({ id: 123, amount: 0 }, 456));
});
test('schema reflects into every human control without separate option lists', () => {
  const fields = reflectPolicy({ schema: { properties: { reagent_coop: REAGENT_COOP_SCHEMA } },
    run: function (p, a) { p.policy.reagentCoop = coopConfig(a.reagent_coop); } });
  assert.equal(fields[0].policy, 'reagentCoop');
  validateValue(fields[0], cfg);
  assert.throws(() => coopConfig({ enabled: true, shilling_cap: 75001 }));
  assert.throws(() => coopConfig({ enabled: true, reagents: [] }));
  assert.throws(() => coopConfig({ enabled: true, reagents: ['plate armor'] }));
  assert.equal(coopConfig(null), null);
  assert.equal(coopConfig({ enabled: false }), null);
});

// Runtime tests use a simulated server; no sockets or live roster are touched.
function keeper({ purse = 1000, herbs = 0, stored = [0, 0, 0], boxHerbs = 0 } = {}) {
  let nextId = 2000;
  const objects = cfg.chest_keys.map((slot, index) => {
    const [, row, col] = slot.match(/^r(\d+)c(\d+)$/);
    return { id: index + 10, nameRsc: 'chest', row: +row, col: +col };
  });
  const boxes = new Map(objects.map((o, i) => [o.id, [
    ...(stored[i] ? [{ id: nextId++, name: 'shilling', amount: stored[i] }] : []),
    ...(i === 0 && boxHerbs ? [{ id: nextId++, name: 'herb', amount: boxHerbs }] : []),
  ]]));
  const c = { evSeq: 0, events: [], self: { row: 18, col: 4 }, guild: { id: 99, rank: 2 },
    rsc: { get: v => v }, stat: () => 40, room: { objects: new Map(objects.map(o => [o.id, o])) },
    inventory: [...(purse ? [{ id: 1, nameRsc: 'shilling', amount: purse }] : []), ...(herbs ? [{ id: 2, nameRsc: 'herb', amount: herbs }] : [])],
    emit(kind, data = {}) { this.events.push({ kind, seq: ++this.evSeq, ...data }); },
    requestGuildInfo() { this.emit('guild', { what: 'roster' }); },
    requestInventory() { this.emit('inventory'); },
    roomContents() { this.emit('room-contents'); },
    contents(id) { this.emit('container', { id, items: structuredClone(boxes.get(id)) }); },
    async waitFor({ since, kinds }) { return { events: this.events.filter(e => e.seq > since && kinds.includes(e.kind)) }; },
    put(spec, into) { move(this.inventory, boxes.get(into), spec, 'deposit'); },
    getFromContainer(spec) { for (const items of boxes.values())
      if (items.some(i => i.id === (spec.id ?? spec))) { move(items, this.inventory, spec, 'withdraw'); break; } },
  };
  function move(from, to, spec, direction) {
    const item = from.find(i => i.id === (spec.id ?? spec));
    const amount = spec.amount ?? 1, name = item.name ?? item.nameRsc;
    assert.ok(amount > 0 && amount <= (item.amount || 1));
    item.amount -= amount;
    if (!item.amount) from.splice(from.indexOf(item), 1);
    let target = to.find(i => (i.name ?? i.nameRsc) === name);
    if (!target) { target = { id: nextId++, amount: 0, [direction === 'deposit' ? 'name' : 'nameRsc']: name }; to.push(target); }
    target.amount += amount;
  }
  const k = { name: 'fixture', policy: { reagentCoop: cfg }, townTrip: { startedAt: nextId },
    paused: false, notes: [], travels: [],
    travelInterrupted() { return this.paused; },
    packAsItems() { return c.inventory.map(i => ({ name: i.nameRsc, amount: i.amount || 1 })); },
    purseNow() { return coopCount(this.packAsItems(), 'shilling'); },
    async sayHallPassword() { return { ok: true }; },
    note(message, data) { this.notes.push({ message, data }); },
    async travel(destination) { this.travels.push(destination); this.s.world.room.num = destination;
      if (this.pauseOnReturn && destination === 100) { this.paused = true; return { arrived: false }; }
      return { arrived: true }; },
    s: { need: () => c, client: c, name: 'fixture',
      pacer: { submit: async (_kind, action) => action() }, world: { room: { num: 100 },
        approachSquare: (col, row) => ({ col, row }) },
      async walkTo(col, row) { c.self = { col, row }; } },
  };
  return { k, c, boxes };
}
test('runtime withdraws exact need before buying, then only missing reagent cash', async () => {
  const { k, boxes } = keeper({ purse: 0, boxHerbs: 6, stored: [500, 500, 500] });
  const result = await runReagentCoop(k, 'supply', { plan: shopping }, 'coop-test');
  assert.deepEqual(result.took, [{ item: 'herb', amount: 6 }], JSON.stringify(result));
  assert.equal(result.shillings, 56);
  assert.equal(coopCount(k.packAsItems(), 'herb'), 6);
  assert.equal(k.purseNow(), 56);
  assert.equal([...boxes.values()].reduce((n, items) => n + coopCount(items, 'shilling'), 0), 1444);
  assert.equal(k.s.world.room.num, 100);
  const again = await runReagentCoop(k, 'supply', { plan: result.plan }, 'coop-test');
  assert.ok(again.skipped);
});
test('runtime cap counts every chest and repeated tithe does not charge again', async () => {
  const { k, boxes } = keeper({ stored: [24990, 24990, 24990] });
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.equal(result.shillings, 30);
  assert.equal(k.purseNow(), 970);
  assert.equal([...boxes.values()].reduce((n, items) => n + coopCount(items, 'shilling'), 0), 75000);
  assert.ok((await runReagentCoop(k, 'tithe', { bankable: 570 }, 'coop-test')).skipped);
});
test('return interruption resumes without a second withdrawal or tithe', async () => {
  const { k } = keeper(); k.pauseOnReturn = true;
  assert.ok((await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test')).pending);
  assert.equal(k.purseNow(), 880);
  assert.equal(k.coopVisit.stage, 'return');
  k.paused = false; k.pauseOnReturn = false;
  const done = await runReagentCoop(k, 'tithe', {}, 'coop-test');
  assert.equal(done.shillings, 120); assert.equal(k.purseNow(), 880);
});
test('a live coop lock prevents another keeper from reading or transferring', async () => {
  const { k } = keeper();
  mkdirSync(process.env.M59_COOP_DIR, { recursive: true });
  const lock = claimFleetLock(join(process.env.M59_COOP_DIR, 'coop-test.coop.lock'), { subject: 'test' });
  assert.ok(lock.ok);
  try {
    assert.ok((await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test')).pending);
    assert.equal(k.purseNow(), 1000);
  } finally { lock.release(); }
  assert.equal((await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test')).shillings, 120);
});
test('unreadable chests cannot spend money or count as empty', async () => {
  const { k, c } = keeper(); c.contents = () => {};
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.match(result.reason, /no fresh contents/);
  assert.equal(k.purseNow(), 1000);
  assert.equal(k.s.world.room.num, 100);
});
test('real banking step resumes its hall return and banks only the post-tithe surplus', async () => {
  const { k, c, boxes } = keeper();
  k.policy = { ...k.policy, walkingMoney: 400, buyFood: false };
  Object.assign(k, { larder: () => [], deliveryCashReserve: () => 0, tally: {}, progress() {}, tradeFact() {} });
  k.s.world.room.name = 'bank';
  c.vitals = () => ({ vigor: { value: 200 } });
  let banked = 0;
  c.deposit = n => { banked += n; c.inventory.find(i => i.nameRsc === 'shilling').amount -= n; c.emit('message'); };
  k.pauseOnReturn = true;
  assert.ok((await Autopilot.prototype.bankSurplus.call(k)).pending);
  assert.equal(k.purseNow(), 880);
  k.s.world.room.num = 714; // survival paused the return before reaching the bank
  k.pauseOnReturn = false; k.paused = false;
  await Autopilot.prototype.bankSurplus.call(k);
  assert.equal(k.purseNow(), 400); assert.equal(banked, 480);
  assert.equal([...boxes.values()].reduce((n, items) => n + coopCount(items, 'shilling'), 0), 120);
});
test('real funding step checks the coop before declaring a poor bot unaffordable', async () => {
  const { k } = keeper({ purse: 0, boxHerbs: 10 });
  let poorChecked = 0;
  Object.assign(k, { postShoppingPlan: () => ({}), poorFarmingActive: () => { poorChecked++; return true; } });
  const result = await Autopilot.prototype.ensurePurchaseFunds.call(k, shopping);
  assert.equal(coopCount(k.packAsItems(), 'herb'), 10);
  assert.ok(result.moved); assert.equal(poorChecked, 0);
});
test('DUM command polls one job and returns the same tithe receipt without charging twice', async () => {
  const { k } = keeper();
  k.shoppingPlan = () => ({ required_purse: 0 });
  k.goTravelling = () => { k.inert = { travelling: true }; };
  k.revive = () => { k.inert = null; };
  k.s.movementGeneration = 1;
  k.s.startJob = (kind, label, run) => {
    const job = k.s.job = { kind, label, generation: 1, done: false };
    job.promise = Promise.resolve().then(() => run(1)).then(result => { job.result = result; })
      .finally(() => { job.done = true; });
    return job;
  };
  const args = { action: 'tithe', request_id: 'trip-1', keep: 400 };
  assert.ok(reagentCoopCommand(k, k.s, args, 'coop-test').pending);
  assert.ok(reagentCoopCommand(k, k.s, args, 'coop-test').pending);
  await k.s.job.promise;
  assert.equal(reagentCoopCommand(k, k.s, args, 'coop-test').shillings, 120);
  assert.equal(reagentCoopCommand(k, k.s, args, 'coop-test').shillings, 120);
  assert.equal(k.purseNow(), 880);
});
test('closed guild entrance is opened from its foyer-side trigger before leaving', async () => {
  const { k, c } = keeper();
  c.self = { row: 2, col: 32 };
  let opened = false;
  c.go = () => {
    assert.deepEqual(c.self, { row: 3, col: 28 });
    opened = true; c.emit('sector-height');
  };
  k.s.walkTo = async (col, row) => {
    if (row > 3 && !opened) return { arrived: false, reason: 'closed entrance' };
    c.self = { row, col }; return { arrived: true };
  };
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.equal(opened, true);
  assert.equal(result.shillings, 120);
});
test.after(() => rmSync(root, { recursive: true, force: true }));
