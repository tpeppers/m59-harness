#!/usr/bin/env node
import assert from 'node:assert/strict';
import { RTS_SCHEMA, buildRtsSnapshot, toNativeSnapshot } from './m59-rts-contract.mjs';
import { BrokerReader } from './m59-rts-gateway.mjs';

const snapshot = buildRtsSnapshot({
  health: { fleet: 'prod', pid: 1234 },
  fleetPayload: {
    fleet: [
      { agent: 't1', character: 'Kermit', room: 'Marion', room_num: 200, level: 3,
        last_action: 'grab nearby in room 200', took_s: 4, ok: true,
        password: 'must-not-leak' },
      { agent: 't2', character: 'Piggy', room: 'Marion', room_num: 200, level: 4,
        last_action: 'cast blink', took_s: 2, failed: 'not enough mana' },
    ],
  },
  looks: new Map([
    ['t1', {
      room: { num: 200, name: 'Marion', resource: 'marion.roo', size: { rows: 88, cols: 93 } },
      you: { object_id: 501, col: 10, row: 11, x: 672, y: 736, angle: 1024,
        appearance_revision: 12,
        facing: 'east', facing_degrees: 90, on_walkable: true,
        appearance: { icon_rsc: 950, icon_resource: 'bta.bgf', flags: 0, rarity: 4,
          light: { flags: 1, intensity: 24, color: 65535 },
          translation: 2, effect: 0, animation: { type: 1, group: 3 },
          overlays: [{ icon_rsc: 952, icon_resource: 'helm.bgf', hotspot: 3,
            translation: 7, effect: 0, animation: { type: 1, group: 1 } },
          { icon_rsc: 999, icon_resource: '<rsc 999>', hotspot: 0,
            translation: 0, effect: 0,
            animation: { type: 3, period: 200, group_low: 4, group_high: 6, group_final: 1 } }],
          motion: { translation: 4, effect: 0,
            animation: { type: 2, period: 500, group_low: 2, group_high: 6 },
            overlays: [{ icon_rsc: 953, icon_resource: 'swordov.bgf', hotspot: -2,
              translation: 0, effect: 1,
              animation: { type: 2, period: 100, group_low: 2, group_high: 6 } }] } } },
      vitals: { health: { value: 30, max: 30, pct: 100 }, mana: { value: 12, max: 21 }, vigor: { value: 101, scale_max: 200 } },
      objects: [{ id: 900, name: 'rat', col: 12, row: 11, x: 800, y: 736,
        appearance_revision: 21,
        angle: 2048, facing: 'west', facing_degrees: 180,
        can: ['attack', 'look'], reachable: true,
        appearance: { icon_rsc: 951, icon_resource: 'rat.bgf', flags: 0, rarity: 0,
          light: { flags: 0, intensity: 0, color: 0 }, translation: 0, effect: 0,
          animation: { type: 2, period: 1200, group_low: 1, group_high: 6 },
          overlays: [], motion: { translation: 0, effect: 0,
            animation: { type: 1, group: 2 }, overlays: [] } } }],
      exits: [{ kind: 'door', to: 201, to_name: 'Next room', stand_on: { col: 20, row: 21 }, reachable: true }],
    }],
    ['t2', {
      room: { num: 200, name: 'Marion', resource: 'marion.roo', size: { rows: 88, cols: 93 } },
      you: { object_id: 502, col: 14, row: 11, facing: 'west', facing_degrees: 270, on_walkable: true },
      vitals: { health: { value: 31, max: 31, pct: 100 }, mana: { value: 10, max: 20 }, vigor: { value: 99, scale_max: 200 } },
      objects: [{ id: 900, name: 'rat', col: 12, row: 11, can: ['look'], reachable: true }],
      exits: [{ kind: 'door', to: 201, to_name: 'Next room', stand_on: { col: 20, row: 21 }, reachable: true }],
    }],
  ]),
  equipment: new Map([
    ['t1', { known: true, fresh_ms: 250, equipped: [
      { id: 701, name: 'mace' }, { id: 702, name: 'leather armor' }, { id: 703, name: null },
    ] }],
    ['t2', { known: false, fresh_ms: null, equipped: [] }],
  ]),
  spells: new Map([
    ['t1', [
      { id: 801, name: 'create weapon', targets: 0, school: 0 },
      { id: 803, name: 'blink', targets: 0, school: 6 },
      { id: 804, name: 'earthquake', targets: 0, school: 4 },
      { id: 802, name: 'resist magic', targets: 1, school: 2 },
      { id: null, name: 'invalid spell', targets: 0, school: 0 },
    ]],
    ['t2', []],
  ]),
  inventory: new Map([
    ['t1', [
      { id: 701, name: 'mace', equipped: true, role: 'weapon', safe_actions: ['unuse', 'drop'] },
      { id: 702, name: 'leather armor', amount: 1, equipped: false,
        role: 'armor', safe_actions: ['use'] },
      { id: 704, name: 'bread', amount: 3, equipped: false,
        role: 'food', safe_actions: ['eat', 'use'] },
      { id: 705, name: 'odd stone', amount: 0, equipped: null,
        role: 'unknown', safe_actions: ['use', 'drop'] },
    ]],
    ['t2', [
      { id: 706, name: 'dagger', amount: 1, equipped: null,
        role: 'weapon', safe_actions: ['use'] },
    ]],
  ]),
  commander: { enabled: true, authority: 'authenticated-enabled-loopback-gateway',
    heartbeat_default_ms: 6666, lease_token: 'must-not-leak-lease' },
  control: new Map([
    ['t1', { lease_state: 'active', lease_id: 'lease-1', owner: 'boswars-native',
      expires_at_ms: 1786083620000, expires_in_ms: 20000,
      leased_faculties: ['work', 'movement', 'economy', 'social'], keeper_state: 'inert',
      lease_token: 'must-not-leak-control-lease' }],
    ['t2', { lease_state: 'blocked', leased_faculties: [], keeper_state: 'running',
      blocked_reason: 'local client holds character' }],
  ]),
  commerce: new Map([
    ['t1', {
      purse: { amount: 275, currency: 'shillings' },
      affordances: {
        buy: [{ id: 910, name: 'Rook' }], sell: [{ id: 911, name: 'Qerti' }],
        offer: [{ id: 912, name: 'Friendly Player' }],
      },
      catalog: { merchant: { id: 910, name: 'Rook' }, items: [
        { id: 920, name: 'bread', available_quantity: 12, max_quantity: 12,
          unit_price: 4, currency: 'shillings' },
      ] },
      trade: { revision: 7, role: 'recipient',
        counterparty: { id: 912, name: 'Friendly Player' },
        ours: [{ id: 701, name: 'mace', quantity: 1 }],
        theirs: [{ id: 930, name: 'ruby', quantity: 2 }], may_accept: true,
        updated_at_ms: 1786083600000, fingerprint: 'must-not-leak-fingerprint' },
      observed_at_ms: 1786083600000, refresh: 'cached_no_packet',
      quote_token: 'must-not-leak-quote', lease_token: 'must-not-leak-commerce-lease',
    }],
    ['t2', { purse: { amount: 0, currency: 'shillings' },
      affordances: { buy: [], sell: [], offer: [] }, catalog: null, trade: null,
      observed_at_ms: 1786083600000, refresh: 'cached_no_packet' }],
  ]),
  observedAt: '2026-08-07T00:00:00.000Z',
  sequence: 'fixture-1',
});

assert.equal(snapshot.schema, RTS_SCHEMA);
assert.equal(snapshot.agents.length, 2);
assert.equal(snapshot.rooms.length, 1);
assert.equal(snapshot.rooms[0].entities.length, 1);
assert.deepEqual(snapshot.rooms[0].entities[0].seen_by, ['t1', 't2']);
assert.deepEqual(snapshot.rooms[0].entities[0].attackable_by, ['t1']);
assert.deepEqual(snapshot.rooms[0].exits[0].seen_by, ['t1', 't2']);
assert.deepEqual(snapshot.agents[0].equipment,
  { known: true, fresh_ms: 250, equipped: ['mace', 'leather armor'] });
assert.deepEqual(snapshot.agents[1].equipment,
  { known: false, fresh_ms: null, equipped: [] });
// EVERY SPELL THE CHARACTER KNOWS, IN THE ORDER THE FIXTURE DECLARES THEM.
//
// This expected two of the four because the retired RTS allowlist filtered the snapshot's
// spell list down to create food, create weapon and blink — so a commander client showed
// three entries however many the character really knew. The list is reported whole now and
// only a malformed row is dropped, so the assertion is simply the fixture.
//
// NOT a relaxation. `earthquake` and `resist magic` are here precisely because nothing
// filters them any more, and `targets` is carried through unchanged because packet arity
// is the one check that replaced the policy — `resist magic` keeps its 1.
assert.deepEqual(snapshot.agents[0].spells, [
  { id: 801, name: 'create weapon', targets: 0, school: 0 },
  { id: 803, name: 'blink', targets: 0, school: 6 },
  { id: 804, name: 'earthquake', targets: 0, school: 4 },
  { id: 802, name: 'resist magic', targets: 1, school: 2 },
]);
assert.deepEqual(snapshot.agents[1].spells, []);
assert.deepEqual(snapshot.agents[0].inventory, [
  { id: 701, name: 'mace', amount: 1, equipped: true,
    role: 'weapon', safe_actions: ['unuse'] },
  { id: 702, name: 'leather armor', amount: 1, equipped: false,
    role: 'armor', safe_actions: ['use'] },
  { id: 704, name: 'bread', amount: 3, equipped: false,
    role: 'food', safe_actions: ['eat'] },
  { id: 705, name: 'odd stone', amount: 1, equipped: null,
    role: 'other', safe_actions: [] },
]);
assert.deepEqual(snapshot.agents[1].inventory, [
  { id: 706, name: 'dagger', amount: 1, equipped: null,
    role: 'weapon', safe_actions: [] },
]);
assert.deepEqual({
  last_action: snapshot.agents[0].last_action,
  took_s: snapshot.agents[0].took_s,
  ok: snapshot.agents[0].ok,
  cancelled: snapshot.agents[0].cancelled,
  failed: snapshot.agents[0].failed,
}, {
  last_action: 'grab nearby in room 200', took_s: 4, ok: true,
  cancelled: null, failed: null,
});
assert.equal(snapshot.agents[0].x, 672);
assert.equal(snapshot.agents[0].angle, 1024);
assert.equal(snapshot.agents[0].appearance_revision, 12);
assert.equal(snapshot.agents[0].appearance.icon_resource, 'bta.bgf');
assert.deepEqual(snapshot.agents[0].appearance.light,
  { flags: 1, intensity: 24, color: 65535 });
assert.equal(snapshot.agents[0].appearance.motion.overlays[0].icon_resource, 'swordov.bgf');
assert.equal(snapshot.agents[0].appearance.overlays[1].icon_resource, null,
  'an unresolved RSC placeholder is not exposed as a filename');
assert.equal(snapshot.rooms[0].entities[0].x, 800);
assert.equal(snapshot.rooms[0].entities[0].appearance_revision, 21);
assert.equal(snapshot.rooms[0].entities[0].appearance.icon_resource, 'rat.bgf');
assert.equal(snapshot.rooms[0].entities[0].appearance.animation.period, 1200);
assert.doesNotMatch(JSON.stringify(snapshot), /must-not-leak|password|lease_token|quote_token|fingerprint/i);
assert.deepEqual(snapshot.commander, {
  enabled: true, authority: 'authenticated-enabled-loopback-gateway', heartbeat_ms: 6666,
});
assert.deepEqual(snapshot.control.t1, {
  lease_state: 'active', lease_id: 'lease-1', owner: 'boswars-native',
  expires_at_ms: 1786083620000, expires_in_ms: 20000,
  faculties: ['work', 'movement', 'economy', 'social'], keeper_state: 'inert', blocked_reason: null,
});
assert.equal(snapshot.commerce.t1.catalog.items[0].unit_price, 4);
assert.deepEqual(snapshot.commerce.t1.trade.theirs,
  [{ id: 930, name: 'ruby', quantity: 2 }]);

const native = toNativeSnapshot(snapshot);
assert.match(native, /^M59RTS\t7\tfixture-1\t/);
assert.match(native, /\nCOMMANDER\t1\tauthenticated-enabled-loopback-gateway\t6666\n/);
assert.match(native, /\nCONTROL\tt1\tactive\tlease-1\tboswars-native\t1786083620000\t20000\twork%2Cmovement%2Ceconomy%2Csocial\tinert\t\n/);
assert.match(native, /\nCOMMERCE\tt1\t275\tshillings\n/);
assert.match(native, /\nCOMMERCE_TARGET\tt1\t200\t910\tRook\t1\t0\t0\n/);
assert.match(native, /\nCATALOG\tt1\t910\tRook\t1786083600000\n/);
assert.match(native, /\nCATALOG_ITEM\tt1\t910\t920\tbread\t12\t12\t4\tshillings\n/);
assert.match(native, /\nTRADE\tt1\t7\trecipient\t912\tFriendly%20Player\t1\t1786083600000\n/);
assert.match(native, /\nTRADE_ITEM\tt1\ttheirs\t930\truby\t2\n/);
assert.doesNotMatch(native, /must-not-leak|lease_token|quote_token|fingerprint/i);
assert.match(native, /\nAGENT\tt1\tKermit\t200\tMarion\tmarion\.roo\t3\t501\t10\t11\teast\t90\t30\t30/);
const nativeAgent = native.split('\n').find(line => line.startsWith('AGENT\tt1\t'));
assert.equal(nativeAgent.split('\t').length, 23, 'native v2+ keeps exactly three equipment AGENT fields');
assert.deepEqual(nativeAgent.split('\t').slice(-3), ['1', '250', 'mace%2Cleather%20armor']);
const nativeSpells = native.split('\n').filter(line => line.startsWith('SPELL\tt1\t'));
// THE NATIVE WIRE CARRIES THE WHOLE SPELL LIST TOO, FOR THE SAME REASON THE SNAPSHOT DOES.
//
// These two assertions were the last of the retired allowlist, and they are the pair worth
// reading rather than skimming, because the one below USED to make a safety claim:
// "unsafe zero-target and unaudited target spells are omitted from action exposure".
//
// That claim is gone, deliberately and by the operator's decision — see the header of
// m59-kraanan-test.mjs, landed in this same commit: "The operator retired the allowlist.
// What is pinned now is that the gate is GONE ... plus the one check that replaced it,
// which is packet arity, not policy." A filter that dropped everything but create food,
// create weapon and blink did not make a commander client safe; it made it WRONG, showing
// three spells to a character that knew a dozen and refusing every targeted cast a Kraanan
// drill needs.
//
// So what replaces the claim is narrower and honest: the wire reports what the character
// knows, and `rtsCastArityOk` refuses a cast whose target count does not match the spell's
// own arity. `resist magic` keeps its `1` here, and that 1 is the whole of the remaining
// gate — a packet-shape rule rather than a judgement about which spells a commander may be
// told to cast.
assert.deepEqual(nativeSpells, [
  'SPELL\tt1\t801\tcreate%20weapon\t0\t0',
  'SPELL\tt1\t803\tblink\t0\t6',
  'SPELL\tt1\t804\tearthquake\t0\t4',
  'SPELL\tt1\t802\tresist%20magic\t1\t2',
]);
assert.match(native, /\nSPELL\tt1\t804\tearthquake\t0\t4\n/,
  'a zero-target spell the old allowlist hid is now exposed, and its arity is 0');
assert.match(native, /\nSPELL\tt1\t802\tresist%20magic\t1\t2\n/,
  'a targeted spell the old allowlist hid is now exposed, and its arity is 1 — which is ' +
  'the only thing still gating the cast');
assert.equal(native.split('\n').findIndex(line => line.startsWith('SPELL\tt1\t')),
  native.split('\n').findIndex(line => line.startsWith('AGENT\tt1\t')) + 1,
  'native spell records immediately follow their owning agent');
const nativeItems = native.split('\n').filter(line => line.startsWith('ITEM\tt1\t'));
assert.deepEqual(nativeItems, [
  'ITEM\tt1\t701\tmace\t1\t1\tweapon\tunuse',
  'ITEM\tt1\t702\tleather%20armor\t1\t0\tarmor\tuse',
  'ITEM\tt1\t704\tbread\t3\t0\tfood\teat',
  'ITEM\tt1\t705\todd%20stone\t1\t\tother\t',
]);
assert.equal(nativeItems[0].split('\t').length, 8,
  'native v7 preserves the v6 ITEM eight-field shape');
assert.match(native, /\nITEM\tt2\t706\tdagger\t1\t\tweapon\t\n/,
  'unknown equipment state remains empty and grants no use action');
assert.match(native, /\nACTION\tt1\tgrab%20nearby%20in%20room%20200\t4\t1\t\t\n/);
const nativeAction = native.split('\n').find(line => line.startsWith('ACTION\tt1\t'));
assert.equal(nativeAction.split('\t').length, 7,
  'native v7 preserves the v6 ACTION seven-field shape');
assert.match(native, /\nACTION\tt2\tcast%20blink\t2\t\t\tnot%20enough%20mana\n/,
  'native v7 preserves a cached failed job outcome without inventing booleans');
const selfAppearance = native.split('\n').find(line => line.startsWith('APPEARANCE\t200\t501\t'));
assert.equal(selfAppearance.split('\t').length, 31, 'native v3 APPEARANCE has a fixed field count');
assert.deepEqual(selfAppearance.split('\t').slice(1, 10),
  ['200', '501', '12', '672', '736', '1024', '90', '950', 'bta.bgf']);
assert.deepEqual(selfAppearance.split('\t').slice(10, 17), ['0', '4', '1', '24', '65535', '2', '0']);
const baseOverlay = native.split('\n').find(line => line.startsWith('OVERLAY\t200\t501\tbase\t'));
const motionOverlay = native.split('\n').find(line => line.startsWith('OVERLAY\t200\t501\tmotion\t'));
const unknownOverlay = native.split('\n').find(line => line.startsWith('OVERLAY\t200\t501\tbase\t1\t'));
assert.equal(baseOverlay.split('\t').length, 16, 'native v3 OVERLAY has a fixed field count');
assert.deepEqual(baseOverlay.split('\t').slice(3, 10),
  ['base', '0', '952', 'helm.bgf', '3', '7', '0']);
assert.deepEqual(motionOverlay.split('\t').slice(3, 10),
  ['motion', '0', '953', 'swordov.bgf', '-2', '0', '1']);
assert.equal(unknownOverlay.split('\t')[6], '', 'unknown native icon_resource is an empty field');
assert.deepEqual(unknownOverlay.split('\t').slice(10), ['3', '', '200', '4', '6', '1']);
assert.match(native, /\nAPPEARANCE\t200\t900\t21\t800\t736\t2048\t180\t951\trat\.bgf\t/);
assert.match(native, /\nENTITY\t200\t900\trat\t12\t11\t\twest\t/);
assert.match(native, /attack%2Clook\tt1%2Ct2/);
const nativeEntity = native.split('\n').find(line => line.startsWith('ENTITY\t200\t900\t'));
assert.equal(nativeEntity.split('\t').length, 18,
  'native v4 ENTITY appends actor-specific attackable_by');
assert.equal(nativeEntity.split('\t').at(-1), 't1');
assert.match(native, /\nEND\n$/);

const boundedInventory = buildRtsSnapshot({
  health: { fleet: 'fixture', pid: 1234 },
  fleetPayload: { fleet: [{ agent: 'cap', character: 'Cap' }] },
  looks: new Map([['cap', {
    room: { num: 200, name: 'Marion' },
    you: { object_id: 599, col: 1, row: 1 }, vitals: {}, objects: [], exits: [],
  }]]),
  equipment: new Map(),
  spells: new Map(),
  inventory: new Map([['cap', Array.from({ length: 513 }, (_, index) => ({
    id: 1000 + index, name: `item ${index}`, amount: 1, equipped: null,
    role: 'other', safe_actions: [],
  }))]]),
});
assert.equal(boundedInventory.agents[0].inventory.length, 512,
  'the renderer contract independently bounds every cached inventory');

let clock = 10000;
const brokerCalls = [];
const response = value => ({ ok: true, status: 200, json: async () => value });
const toolResponse = value => response({
  result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
});
const fetchImpl = async (url, options = {}) => {
  const target = new URL(url);
  if (target.pathname === '/health') return response({ fleet: 'prod', pid: 4321 });
  const request = JSON.parse(options.body);
  const name = request.params.name;
  const args = request.params.arguments;
  brokerCalls.push({ name, args });
  if (name === 'fleet') return toolResponse({ fleet: [
    { agent: 't1', character: 'Kermit', room: 'Marion', room_num: 200, level: 3 },
  ] });
  if (name === 'look') return toolResponse({
    room: { num: 200, name: 'Marion', resource: 'marion.roo' },
    you: { object_id: 501, col: 10, row: 11 },
    vitals: {}, objects: [], exits: [],
  });
  if (name === 'equipment') return toolResponse({
    known: true, fresh_ms: 100, equipped: [{ id: 701, name: 'mace' }],
  });
  throw new Error(`unexpected broker tool ${name}`);
};
const reader = new BrokerReader({ fetchImpl, now: () => clock, equipmentCacheMs: 5000 });
const first = await reader.snapshot(['t1']);
assert.deepEqual(first.agents[0].equipment,
  { known: null, fresh_ms: null, equipped: [] },
  'the first render generation does not wait for hero-panel equipment');
await reader.equipmentCache.get('t1').pending;
clock += 250;
const cached = await reader.snapshot(['t1']);
assert.equal(brokerCalls.filter(call => call.name === 'equipment').length, 1,
  'rapid reconciliation reuses the equipment read');
assert.equal(cached.agents[0].equipment.fresh_ms, 350,
  'server freshness continues to age while cached');
clock += 5001;
const stale = await reader.snapshot(['t1']);
const equipmentCalls = brokerCalls.filter(call => call.name === 'equipment');
assert.equal(equipmentCalls.length, 2, 'equipment is read again after the five-second cache window');
assert.deepEqual(equipmentCalls.map(call => call.args), [
  { agent: 't1', refresh: false }, { agent: 't1', refresh: false },
]);
assert.equal(stale.agents[0].equipment.fresh_ms, 5351,
  'a stale known value remains visible while its detached refresh runs');
await reader.equipmentCache.get('t1').pending;
const refreshed = await reader.snapshot(['t1']);
assert.equal(refreshed.agents[0].equipment.fresh_ms, 100,
  'the next generation observes the completed background refresh');

console.log('m59 RTS native v7 commander/commerce, inventory/actions, appearance, and cache passed');
