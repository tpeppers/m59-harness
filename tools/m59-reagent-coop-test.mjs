#!/usr/bin/env node
// Offline reagent coop capacity, quantity protocol, funding and keeper-resume tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coopConfig, COOP_REAGENTS, coopDepositPlan, coopTithePlan, coopFundingAmount,
  coopRemainingPlan, coopCount, coopKey, REAGENT_COOP_SCHEMA,
  coopSupplyOutcome, coopFallbackDecision } from './m59-reagent-coop.mjs';
import { M59Client, BP } from './m59-client.mjs';
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
const { readGuildInviteList, guildInviteOutsiders } = await import('./m59-guild-secrecy.mjs');
const { setRosterSource } = await import('./m59-party.mjs');
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
  const c = { evSeq: 0, roomContentsRequested: 0, selfId: 999, me: { id: 999, name: 'Fixture' }, events: [], self: { row: 18, col: 4 }, guild: { id: 99, rank: 2 },
    equipped: new Set(), rsc: { get: v => v }, stat: () => 40, room: { id: 100, objects: new Map(objects.map(o => [o.id, o])) },
    inventory: [...(purse ? [{ id: 1, nameRsc: 'shilling', amount: purse }] : []), ...(herbs ? [{ id: 2, nameRsc: 'herb', amount: herbs }] : [])],
    emit(kind, data = {}) { const e = { kind, seq: ++this.evSeq, ...data }; this.events.push(e); this.onEvent?.(e); },
    requestGuildInfo() { this.emit('guild', { what: 'roster' }); },
    requestInventory() { this.emit('inventory'); },
    roomContents() { const request = ++this.roomContentsRequested; this.emit('room-contents', { room: this.room.id, request, players: [...this.room.objects.values()].filter(o => o.flags & 4).map(o => ({ ...o, name: o.nameRsc })) }); return request; },
    go() { this.emit('sector-height'); },
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
    protectedItemNames: () => [], loadout: () => null, weaponPriorityNow: () => null,
    packAsItems() { return c.inventory.map(i => ({ name: i.nameRsc, amount: i.amount || 1 })); },
    purseNow() { return coopCount(this.packAsItems(), 'shilling'); },
    async sayHallPassword() { return { ok: true }; },
    note(message, data) { this.notes.push({ message, data }); },
    async travel(destination) { this.travels.push(destination); await this.s.pacer.submit('move', () => { this.s.world.room.num = destination; c.room.id = destination; });
      if (this.pauseOnReturn && destination === 100) { this.paused = true; return { arrived: false }; }
      return { arrived: true }; },
    s: { need: () => c, client: c, name: 'fixture',
      pacer: { submit: async (_kind, action) => action() }, world: { room: { num: 100 },
        approachSquare: (col, row) => ({ col, row }) },
      async walkTo(col, row) { await this.pacer.submit('move', () => { c.self = { col, row }; }); } },
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
test('chest supply stops at legal transfer range before the raised platform', async () => {
  const { k, c } = keeper({ purse: 0, boxHerbs: 6 });
  c.self = { row: 7, col: 4 };
  k.s.world.approachSquare = () => ({ row: 17, col: 3, path: [
    { row: 12, col: 4 }, { row: 13, col: 4 }, { row: 17, col: 3 } ] });
  const walk = k.s.walkTo;
  k.s.walkTo = async (col, row) => { assert.ok(row <= 13 || col > 6, 'does not try to climb the chest platform'); return walk.call(k.s, col, row); };
  const result = await runReagentCoop(k, 'supply', { plan: shopping }, 'coop-test');
  assert.deepEqual(result.took, [{ item: 'herb', amount: 6 }]);
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
test('a manual command cannot start a second pass while the keeper owns this visit', async () => {
  const { k, c } = keeper();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = c.waitFor.bind(c);
  c.waitFor = async args => { if (args.kinds.includes('guild')) await gate; return original(args); };
  const first = runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.ok((await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test')).pending);
  assert.ok(reagentCoopCommand(k, k.s, { action: 'tithe', request_id: 'overlap' }, 'coop-test').pending);
  assert.equal(k.s.job, undefined);
  release(); await first;
  assert.equal(k.purseNow(), 880);
});
test('unreadable chests cannot spend money or count as empty', async () => {
  const { k, c } = keeper(); c.contents = () => {};
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.match(result.reason, /no fresh contents/);
  assert.equal(k.purseNow(), 1000);
  assert.equal(k.s.world.room.num, 100);
});
test('banking skips a final hall tithe and deposits the full available surplus', async () => {
  const { k, c } = keeper();
  k.policy = { ...k.policy, walkingMoney: 400, buyFood: false };
  Object.assign(k, { larder: () => [], deliveryCashReserve: () => 0, tally: {}, progress() {}, tradeFact() {} });
  k.s.world.room.name = 'bank'; c.vitals = () => ({ vigor: { value: 200 } });
  let banked = 0;
  c.deposit = n => { banked += n; c.inventory.find(i => i.nameRsc === 'shilling').amount -= n; c.emit('message'); };
  await Autopilot.prototype.bankSurplus.call(k);
  assert.equal(banked, 600); assert.equal(k.purseNow(), 400); assert.deepEqual(k.travels, []);
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
    if (!opened) assert.deepEqual(c.self, { row: 3, col: 28 });
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
test('invisible outsiders at North Barloque defer without entering or spending', async () => {
  const { k, c } = keeper();
  k.s.world.room.num = c.room.id = 101;
  c.room.objects.set(77, { id: 77, nameRsc: 'Outsider', flags: 4 | 0x500000 });
  const result = await runReagentCoop(k, 'town', { bankable: 600, first: true }, 'coop-test');
  assert.equal(result.deferred, true); assert.equal(k.purseNow(), 1000);
  assert.deepEqual(k.travels, []); assert.equal(k.coopVisit, null);
});

test('a fresh invite list timeout cannot authorize hall entry', async () => {
  const { k, c } = keeper(); k.s.world.room.num = c.room.id = 101;
  c.roomContents = () => ++c.roomContentsRequested;
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.equal(result.deferred, true); assert.match(result.reason, /unavailable/);
  assert.deepEqual(k.travels, []); assert.equal(k.purseNow(), 1000);
});

test('an outsider appearing inside aborts before chest transfers and exits to the street', async () => {
  const { k, c } = keeper();
  const travel = k.travel;
  k.travel = async function(to) { const r = await travel.call(this, to);
    if (to === 714) c.room.objects.set(77, { id: 77, nameRsc: 'Invisible outsider', flags: 4 | 0x500000 });
    return r; };
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.equal(result.deferred, true); assert.equal(k.purseNow(), 1000);
  assert.equal(k.s.world.room.num, 101); assert.equal(k.coopVisit, null);
});

test('pushed arrival during a chest read stops the next transfer', async () => {
  const { k, c } = keeper(); const contents = c.contents;
  c.contents = function(id) { contents.call(this, id);
    this.room.objects.set(77, { id: 77, nameRsc: 'Outsider', flags: 4 }); this.emit('appeared', { id: 77 }); };
  const result = await runReagentCoop(k, 'tithe', { bankable: 600 }, 'coop-test');
  assert.equal(result.deferred, true); assert.equal(k.purseNow(), 1000);
  assert.equal(k.s.world.room.num, 101);
});

test('a town retry away from the North Barloque route creates no detour', async () => {
  const { k } = keeper(); k.s.world.route = () => ({ found: true, hops: [{ to: 109 }] });
  const result = await runReagentCoop(k, 'town', { nextRoom: 109, bankable: 600 }, 'coop-test');
  assert.equal(result.deferred, true); assert.deepEqual(k.travels, []);
});

test('guild invite data retains invisible players at the actual client packet seam', () => {
  const c = new M59Client({ host: '127.0.0.1', port: 1, resources: new Map([[12, 'Invisible outsider']]) });
  c.log = () => {}; let event; c.onEvent = e => { if (e.kind === 'room-contents') event = e; };
  const body = Buffer.alloc(42); let i = 0;
  const u32 = n => { body.writeUInt32LE(n, i); i += 4; }, u16 = n => { body.writeUInt16LE(n, i); i += 2; };
  const u8 = n => { body[i++] = n; };
  u32(101); u16(1); u32(77); u32(0); u32(12); u32(4 | 0x500000); u32(0);
  u16(0); u8(1); u16(0); u8(0); u16(128); u16(128); u16(0); u8(1); u16(0); u8(0);
  c.onGameMessage(BP.ROOM_CONTENTS, body.subarray(0, i));
  assert.equal(event.players.length, 1); assert.equal(event.players[0].name, 'Invisible outsider');
  assert.equal(guildInviteOutsiders(c, event.players).length, 1);
});

test('self, visible fleet and invisible fleet are allowed; outsiders are not', () => {
  const { c } = keeper(); setRosterSource(() => new Set(['Fleet Friend']));
  try {
    const players = [{ id: 999, flags: 4, name: 'Fixture' },
      { id: 2, flags: 4 | 0x500000, name: 'Fleet Friend' }, { id: 3, flags: 4, name: 'Stranger' }];
    assert.deepEqual(guildInviteOutsiders(c, players).map(p => p.id), [3]);
  } finally { setRosterSource(null); }
});

test('an old invite reply and a reply from a different room cannot certify secrecy', async () => {
  for (const wrong of ['ordinal', 'room']) {
    const { k, c } = keeper();
    c.roomContents = () => { const request = ++c.roomContentsRequested;
      c.emit('room-contents', { request: wrong === 'ordinal' ? request - 1 : request,
        room: wrong === 'room' ? 999 : c.room.id, players: [] }); return request; };
    assert.equal((await readGuildInviteList(k.s)).known, false);
  }
});

test('combined town tithe finishes on the street and pays once', async () => {
  const { k } = keeper();
  const result = await runReagentCoop(k, 'town', { first: true, bankable: 600 }, 'coop-test');
  assert.equal(result.shillings, 120, JSON.stringify(result));
  assert.equal(k.s.world.room.num, 101);
  assert.equal(k.purseNow(), 880);
});

// ---------------------------------------------------------------- the self-funding fallback
//
// The fallback SPENDS MONEY, so every gate on it is pinned here rather than left to the live
// fleet to discover. The assertion that matters most is the last one: the two triggers must
// stay countable apart, because only one of them is supposed to disappear when a code fix lands.
const outcomeRow = (agent, outcome, extra = {}) =>
  ({ agent, kind: 'coop_supply_outcome', outcome, short: 12, ...extra });

test('self_fund is off unless asked for, and only a real boolean turns it on', () => {
  assert.equal(coopConfig({ enabled: true }).self_fund, false);
  assert.equal(coopConfig({ enabled: true, self_fund: true }).self_fund, true);
  // A truthy STRING must not enable something that spends shillings — `!!raw.self_fund`
  // would have read the string "false" as yes.
  for (const bad of ['true', 'false', 1, 0, null])
    assert.throws(() => coopConfig({ enabled: true, self_fund: bad }), /self_fund/,
                  `self_fund: ${JSON.stringify(bad)} must be refused`);
});

test('a visit that never reached the chest is not evidence the chest was empty', () => {
  // THE BLAME POINT. `took: []` is identical in both cases, so the reason has to outrank the
  // arithmetic — otherwise a door failure is filed against the fleet's stock, and the ledger
  // records "nobody stocked it" about a chest holding 543 elderberry.
  const v = coopSupplyOutcome({ reason: 'guild door 59 could not be crossed', took: [],
    plan: { lines: [{ item: 'elderberry', amount: 300 }], unpriced: [] } });
  assert.equal(v.outcome, 'chest_unreachable');
  assert.equal(v.short, 300);
});

test('a chest that was read and came up short is chest_empty, partial fill included', () => {
  const none = coopSupplyOutcome({ reason: null, took: [],
    plan: { lines: [{ item: 'elderberry', amount: 300 }], unpriced: [] } });
  assert.equal(none.outcome, 'chest_empty');
  assert.equal(none.took_units, 0);
  // A partial draw still leaves the character short, and the units are recorded so that "held
  // some" and "held none" stay distinguishable in the file afterwards.
  const some = coopSupplyOutcome({ reason: null, took: [{ item: 'elderberry', amount: 40 }],
    plan: { lines: [{ item: 'elderberry', amount: 260 }], unpriced: [] } });
  assert.equal(some.outcome, 'chest_empty');
  assert.equal(some.took_units, 40);
  assert.equal(some.short, 260);
});

test('a satisfied draw is ok and nothing fires', () => {
  const v = coopSupplyOutcome({ reason: null, took: [{ item: 'elderberry', amount: 300 }],
    plan: { lines: [], unpriced: [] } });
  assert.equal(v.outcome, 'ok');
  assert.equal(coopFallbackDecision({ rows: [outcomeRow('t9', 'ok')], agent: 't9' }).fund, false);
});

test('unreachable needs three, and two is not three', () => {
  const two = ['chest_unreachable', 'chest_unreachable'].map(o => outcomeRow('t9', o));
  assert.equal(coopFallbackDecision({ rows: two, agent: 't9' }).fund, false);
  const three = [...two, outcomeRow('t9', 'chest_unreachable')];
  const d = coopFallbackDecision({ rows: three, agent: 't9' });
  assert.equal(d.fund, true);
  assert.equal(d.trigger, 'chest_unreachable');
});

test('chest_empty fires at once, because a retry cannot change the answer', () => {
  const d = coopFallbackDecision({ rows: [outcomeRow('t9', 'chest_empty')], agent: 't9' });
  assert.equal(d.fund, true);
  assert.equal(d.trigger, 'chest_empty');
});

test('one-off is one trip per episode, and a fresh episode may fire again', () => {
  const fired = { agent: 't9', kind: 'coop_self_funding', trigger: 'chest_empty' };
  assert.equal(coopFallbackDecision({ rows: [outcomeRow('t9', 'chest_empty'), fired], agent: 't9' }).fund,
               false, 'a fallback must not re-fire on the failure that caused it');
  // But it must not be suppressed FOREVER. While the chest stays broken there is never another
  // success, so suppressing until one would starve the character with the ledger reading normal.
  const again = [outcomeRow('t9', 'chest_empty'), fired, outcomeRow('t9', 'chest_empty')];
  assert.equal(coopFallbackDecision({ rows: again, agent: 't9' }).fund, true,
               'a new episode after the trip must be allowed to fund again');
});

test('a success clears the run', () => {
  const rows = [outcomeRow('t9', 'chest_unreachable'), outcomeRow('t9', 'chest_unreachable'),
                outcomeRow('t9', 'ok'), outcomeRow('t9', 'chest_unreachable')];
  const d = coopFallbackDecision({ rows, agent: 't9' });
  assert.equal(d.fund, false);
  assert.equal(d.consecutive, 1, 'the two before the success must not carry forward');
});

test('one character’s failures never fund another', () => {
  const rows = ['t1', 't2', 't3'].map(a => outcomeRow(a, 'chest_unreachable'));
  assert.equal(coopFallbackDecision({ rows, agent: 't9' }).fund, false);
  assert.equal(coopFallbackDecision({ rows, agent: 't1' }).fund, false);
});

test('THE TRIGGERS STAY COUNTABLE APART — the reason this ledger is worth keeping', () => {
  // Two unreachable and one empty is not "three failures". If they summed, the unreachable
  // trigger would fire on an episode that was mostly about stock, and — the real cost — the
  // count could never show whether a door fix worked, because it would keep moving for the
  // other reason. Rolled together, this instrument cannot answer the one question it exists for.
  const mixed = [outcomeRow('t9', 'chest_unreachable'), outcomeRow('t9', 'chest_unreachable'),
                 outcomeRow('t9', 'chest_empty')];
  const d = coopFallbackDecision({ rows: mixed, agent: 't9' });
  assert.equal(d.trigger, 'chest_empty', 'an episode containing an empty read is not an unreachable one');
  assert.equal(coopFallbackDecision({ rows: mixed.slice(0, 2), agent: 't9' }).fund, false,
               'and the two unreachable rows on their own are still only two');
});

// AND THE ROW HAS TO LAND, not merely be computable. Everything above tests the decision as a
// pure function; this drives the real runtime against a chest that holds nothing and then reads
// the file back. A recorder that is never called is a blind instrument, and this session already
// spent an hour reading a structurally-null field as a measurement.
const ledgerRows = agent => {
  const file = join(process.env.M59_COOP_DIR, 'coop-test.coop.ndjson');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.agent === agent);
};

test('an empty chest writes its outcome and fires the fallback when self_fund is on', async () => {
  const { k } = keeper({ purse: 0, boxHerbs: 0 });
  k.name = 'fallback-on';
  k.policy.reagentCoop = { ...cfg, self_fund: true };
  const result = await runReagentCoop(k, 'supply', { plan: shopping }, 'coop-test');
  assert.deepEqual(result.took, [], 'the chest held nothing to take');
  const rows = ledgerRows('fallback-on');
  const outcome = rows.find(r => r.kind === 'coop_supply_outcome');
  assert.ok(outcome, `no outcome row was written: ${JSON.stringify(rows)}`);
  assert.equal(outcome.outcome, 'chest_empty');
  assert.equal(outcome.short, 10, 'the shortfall is the herb the plan still wants');
  const fired = rows.find(r => r.kind === 'coop_self_funding');
  assert.ok(fired, 'self_fund:true must record the fallback it took');
  assert.equal(fired.trigger, 'chest_empty');
  assert.ok(result.self_funding, 'and the caller that asked for the draw must be told');
  assert.equal(k.selfFundReagents.trigger, 'chest_empty');
});

test('with self_fund off the outcome is still recorded — that is the baseline', async () => {
  const { k } = keeper({ purse: 0, boxHerbs: 0 });
  k.name = 'fallback-off';
  k.policy.reagentCoop = { ...cfg, self_fund: false };
  const result = await runReagentCoop(k, 'supply', { plan: shopping }, 'coop-test');
  const rows = ledgerRows('fallback-off');
  assert.ok(rows.some(r => r.kind === 'coop_supply_outcome' && r.outcome === 'chest_empty'),
            'the recorder runs whether or not anybody is acting on it');
  assert.equal(rows.filter(r => r.kind === 'coop_self_funding').length, 0,
               'but an opt-out character must never be sent shopping');
  assert.equal(result.self_funding, undefined);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
