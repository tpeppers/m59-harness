import assert from 'node:assert/strict';
import { PolicyControls, reflectPolicy, validateValue } from './m59-policy-controls.mjs';
import { ControlDraft } from './m59-control-client.mjs';
import { ChatControls, tellChunks } from './m59-chat-controls.mjs';

const fields = [
  { id: 'order.no_food_vigor_floor', title: 'no food vigor floor', type: 'number', minimum: 0, maximum: 80 },
  { id: 'order.buy_food', title: 'buy food', type: 'boolean' },
  { id: 'room_lock', title: 'room lock', type: 'boolean' },
];
const snapshot = { fleet: 'fixture', pid: 12, revision: 'r1', agents: ['unit-a'], fields, templates: [],
  rows: { 'unit-a': { current: { 'order.no_food_vigor_floor': 70, 'order.buy_food': true }, restart: { 'order.no_food_vigor_floor': 65 } } } };
const draft = new ControlDraft(snapshot);
assert.equal(draft.assignment('no food vigor floor 70').id, fields[0].id);
draft.assignment('buy food off'); assert.equal(draft.patch['order.buy_food'], false);
draft.assignment('no_food_vigor_floor=0'); assert.equal(draft.patch[fields[0].id], 0);
assert.throws(() => draft.assignment('no food vigor floor 81'), /range/);
assert.throws(() => draft.assignment('room lock maybe'), /expected boolean/);
draft.inheritField('buy food'); assert.deepEqual(draft.inherit, ['order.buy_food']);
assert.ok(!Object.hasOwn(draft.patch, 'order.buy_food'));
draft.reset(snapshot); assert.deepEqual(draft.patch, {}); assert.deepEqual(draft.inherit, []);
assert.ok(draft.describe(fields[0]).join(' ').includes('restart=65'));
assert.throws(() => validateValue({ type: 'object' }, JSON.parse('{"__proto__":{}}')), /reserved/);
assert.throws(() => validateValue({ type: 'array', items: { type: 'integer' } }, [1.5]), /expected/);

const rows = { 'unit-a': { keeper_pid: 3, live: { mode: 'goap', policy: { noFoodVigorFloor: 70, buyFood: true } }, restart: { mode: 'goap', policy: { noFoodVigorFloor: 65, buyFood: true } } } };
const tool = { schema: { properties: { no_food_vigor_floor: { type: 'number', maximum: 80 }, buy_food: { type: 'boolean' }, agent: { type: 'string' }, action: { type: 'string' } } }, run() {} };
assert.equal(reflectPolicy(tool, [rows['unit-a'].live.policy]).length, 2);
let writes = 0;
const service = new PolicyControls({ fleet: 'fixture', pid: 10, agents: () => ['unit-a'], tool: () => tool,
  read: async a => structuredClone(rows[a]), write: async (a, patch) => { writes++; Object.assign(rows[a].live.policy, { buyFood: patch.buy_food }); rows[a].restart.policy = { ...rows[a].live.policy }; } });
const before = await service.snapshot(['unit-a']); assert.equal(writes, 0);
assert.equal(before.rows['unit-a'].restart.values.no_food_vigor_floor, 65);
await assert.rejects(service.save({ agents: ['unit-a'], patch: { buy_food: false }, expected_revision: 'stale' }), /changed/);
assert.equal(writes, 0);
const saved = await service.save({ agents: ['unit-a'], patch: { buy_food: false }, expected_pid: 10, expected_fleet: 'fixture', expected_revision: before.revision });
assert.equal(saved.rows['unit-a'].live.values.buy_food, false); assert.equal(writes, 1);
await assert.rejects(service.snapshot(['stranger']), /existing/);

let pilot = { agent: 'operator', pid: 44, objectId: 80 }, now = 100, saves = 0;
const replies = [];
const chat = new ChatControls({ authenticate: id => id === 80 ? pilot : null, now: () => now,
  client: async () => ({ read: async () => structuredClone(snapshot), save: async d => { saves++; assert.equal(d.patch[fields[0].id], 70); return { ...snapshot, ok: true }; } }),
  reply: async (...args) => replies.push(args) });
const say = (text, speaker = 80) => chat.handle('unit-a', { speaker, text });
assert.equal(await say('control', 99), false); assert.equal(replies.length, 0);
await say('control'); assert.equal(saves, 0);
assert.equal(await say('no food vigor floor 70'), false);
await say('confirm unit-a'); await say('no food vigor floor 70'); assert.equal(saves, 0);
await say('save to live fleet'); assert.equal(saves, 1);
pilot = { ...pilot, pid: 45 }; assert.equal(await say('save'), false); assert.equal(saves, 1);
await say('control'); await say('confirm unit-a'); now += 600001; assert.equal(await say('save'), false);
pilot = null; const count = replies.length; await say('control'); assert.equal(replies.length, count);
assert.ok(tellChunks('x'.repeat(2000)).every(c => Buffer.byteLength(c) <= 210));
assert.equal(chat.chains.size, 0);
console.log('Human controls: live/restart isolation, stale saves, schema reflection, parsing, operator auth, expiry and chunking passed.');
