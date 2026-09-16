#!/usr/bin/env node
import assert from 'node:assert/strict';
import { BROKER_RTS_READ_SCHEMA, BrokerReader } from './m59-rts-gateway.mjs';

const jsonResponse = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

const fleet = {
  fleet: [
    { agent: 't1', character: 'Kermit', room: 'Marion', room_num: 200, level: 30,
      last_action: 'stand', took_s: 1, ok: true },
    { agent: 't2', character: 'Piggy', room: 'Marion', room_num: 200, level: 31 },
  ],
};
const look = (id, col) => ({
  room: { num: 200, name: 'Marion', resource: 'marion.roo' },
  you: { object_id: id, col, row: 11, facing: 'east', facing_degrees: 0 },
  vitals: { health: { value: 30, max: 30 }, vigor: { value: 100, scale_max: 200 } },
  objects: [{ id: 900, name: 'rat', col: 12, row: 11, can: ['attack'] }],
  exits: [],
});
const aggregate = {
  schema: BROKER_RTS_READ_SCHEMA,
  read_only: true,
  observed_at: '2026-08-07T00:00:00.000Z',
  sequence: '1770000000000-4321',
  health: { ok: true, pid: 4321, fleet: 'prod', sessions: ['t1', 't2'] },
  fleet,
  agents: ['t1', 't2'],
  looks: { t1: look(501, 10), t2: look(502, 14) },
  equipment: {
    t1: { known: true, fresh_ms: 20, equipped: [{ id: 701, name: 'mace' }] },
    t2: { known: false, fresh_ms: null, equipped: [] },
  },
  spells: {
    t1: [{ id: 801, name: 'create weapon', targets: 0, school: 0 }],
    t2: [{ id: 802, name: 'blink', targets: 0, school: 6 }],
  },
  inventory: {
    t1: [
      { id: 701, name: 'mace', amount: 1, equipped: true,
        role: 'weapon', safe_actions: ['unuse'] },
      { id: 704, name: 'bread', amount: 4, equipped: false,
        role: 'food', safe_actions: ['eat'] },
    ],
    t2: [
      { id: 705, name: 'mysterious orb', amount: 1, equipped: null,
        role: 'other', safe_actions: [] },
    ],
  },
  commander: { enabled: true, authority: 'authenticated-enabled-loopback-gateway',
    heartbeat_default_ms: 6666 },
  control: {
    t1: { lease_state: 'active', lease_id: 'lease-fast', owner: 'fixture',
      expires_at_ms: 1770000020000, expires_in_ms: 20000,
      leased_faculties: ['work', 'movement'], keeper_state: 'inert',
      lease_token: 'm59l_must_not_reach_snapshot' },
    t2: { lease_state: 'available', leased_faculties: [], keeper_state: 'running' },
  },
  commerce: {
    t1: { purse: { amount: 42, currency: 'shillings' },
      affordances: { buy: [], sell: [], offer: [] }, catalog: null,
      trade: { revision: 2, role: 'recipient', counterparty: { id: 99, name: 'Friend' },
        ours: [], theirs: [], may_accept: false, fingerprint: 'internal-only' },
      observed_at_ms: 1770000000000, refresh: 'cached_no_packet',
      quote_token: 'm59q_must_not_reach_snapshot' },
    t2: { purse: { amount: 0, currency: 'shillings' },
      affordances: { buy: [], sell: [], offer: [] }, catalog: null, trade: null,
      observed_at_ms: 1770000000000, refresh: 'cached_no_packet' },
  },
};

let clock = 1000;
const fastCalls = [];
const fastReader = new BrokerReader({
  now: () => clock,
  readToken: 'fixture-token',
  fetchImpl: async (url, options = {}) => {
    fastCalls.push({ url: new URL(url), options });
    return jsonResponse(200, aggregate);
  },
});
const fast = await fastReader.snapshot(['t1', 't2']);
assert.equal(fastCalls.length, 1, 'one aggregate GET crosses the broker boundary per generation');
assert.equal(fastCalls[0].url.pathname, '/rts/v1/read');
assert.deepEqual(fastCalls[0].url.searchParams.getAll('agent'), ['t1', 't2']);
assert.equal(fastCalls[0].options.method, undefined, 'the aggregate path is GET-only');
assert.equal(fastCalls[0].options.headers.authorization, 'Bearer fixture-token');
assert.equal(fast.sequence, aggregate.sequence);
assert.equal(fast.agents.length, 2);
assert.equal(fast.rooms.length, 1);
assert.deepEqual(fast.rooms[0].entities[0].seen_by, ['t1', 't2']);
assert.deepEqual(fast.agents[0].equipment,
  { known: true, fresh_ms: 20, equipped: ['mace'] });
assert.deepEqual(fast.agents[0].spells,
  [{ id: 801, name: 'create weapon', targets: 0, school: 0 }]);
assert.deepEqual(fast.agents[1].spells,
  [{ id: 802, name: 'blink', targets: 0, school: 6 }]);
assert.deepEqual(fast.agents[0].inventory, [
  { id: 701, name: 'mace', amount: 1, equipped: true,
    role: 'weapon', safe_actions: ['unuse'] },
  { id: 704, name: 'bread', amount: 4, equipped: false,
    role: 'food', safe_actions: ['eat'] },
]);
assert.deepEqual(fast.agents[1].inventory, [
  { id: 705, name: 'mysterious orb', amount: 1, equipped: null,
    role: 'other', safe_actions: [] },
]);
assert.equal(fast.agents[0].last_action, 'stand');
assert.equal(fast.agents[0].took_s, 1);
assert.equal(fast.agents[0].ok, true);
assert.equal(fastReader.fastPathStatus.mode, 'broker-aggregate-v1');
assert.equal(fastReader.healthCache.value.pid, 4321);
assert.equal(fast.commander.enabled, false,
  'broker support alone does not advertise commander through a read-only gateway');
assert.equal(fast.control.t1.lease_id, 'lease-fast');
assert.equal(fast.commerce.t1.purse.amount, 42);
assert.doesNotMatch(JSON.stringify(fast), /must_not_reach|lease_token|quote_token|fingerprint|internal-only/);

const legacyCalls = [];
const legacyTool = value => jsonResponse(200, {
  result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
});
const legacyFetch = async (url, options = {}) => {
  const target = new URL(url);
  legacyCalls.push({ target, options });
  if (target.pathname === '/rts/v1/read') return jsonResponse(405, { error: 'not available' });
  if (target.pathname === '/health')
    return jsonResponse(200, { ok: true, pid: 4321, fleet: 'prod', sessions: ['t1'] });
  const request = JSON.parse(options.body);
  if (request.params.name === 'fleet') return legacyTool({ fleet: [fleet.fleet[0]] });
  if (request.params.name === 'look') return legacyTool(look(501, 10));
  if (request.params.name === 'equipment')
    return legacyTool({ known: true, fresh_ms: 20, equipped: [{ id: 701, name: 'mace' }] });
  throw new Error(`unexpected legacy tool ${request.params.name}`);
};
const fallbackReader = new BrokerReader({
  fetchImpl: legacyFetch,
  now: () => clock,
  fastPathRetryMs: 30000,
});
const fallback = await fallbackReader.snapshot(['t1']);
assert.equal(fallback.agents.length, 1);
assert.deepEqual(fallback.agents[0].spells, [],
  'legacy fallback does not issue a new live spell request');
assert.deepEqual(fallback.agents[0].inventory, [],
  'legacy fallback does not issue a new live inventory request');
assert.equal(fallbackReader.fastPathStatus.mode, 'legacy-fallback');
assert.equal(legacyCalls.filter(call => call.target.pathname === '/rts/v1/read').length, 1);
assert.equal(legacyCalls.filter(call => call.options.method === 'POST').length, 3,
  'fallback retains fleet, look, and detached equipment compatibility');
await fallbackReader.equipmentCache.get('t1').pending;
await fallbackReader.snapshot(['t1']);
assert.equal(legacyCalls.filter(call => call.target.pathname === '/rts/v1/read').length, 1,
  'an old broker is not reprobed every frame');

let authPosts = 0;
const refusedReader = new BrokerReader({
  fetchImpl: async (_url, options = {}) => {
    if (options.method === 'POST') authPosts++;
    return jsonResponse(401, { error: 'token required' });
  },
});
await assert.rejects(() => refusedReader.snapshot(['t1']), /refused authorization/);
assert.equal(authPosts, 0, 'authorization refusal cannot downgrade to the broader MCP transport');

const tokenOnOldBroker = new BrokerReader({
  readToken: 'required-token',
  fetchImpl: async () => jsonResponse(405, { error: 'old broker' }),
});
await assert.rejects(() => tokenOnOldBroker.snapshot(['t1']), /token-gated aggregate endpoint/);

let failedStatusPosts = 0;
const tokenOnFailedBroker = new BrokerReader({
  readToken: 'required-token',
  fetchImpl: async (_url, options = {}) => {
    if (options.method === 'POST') failedStatusPosts++;
    return jsonResponse(500, { error: 'fixture aggregate failure' });
  },
});
await assert.rejects(() => tokenOnFailedBroker.snapshot(['t1']),
  /token-gated broker aggregate read failed closed \(HTTP 500\)/);
assert.equal(failedStatusPosts, 0,
  'a token-gated aggregate status failure cannot downgrade to MCP');

let failedFetchPosts = 0;
const tokenOnOfflineBroker = new BrokerReader({
  readToken: 'required-token',
  fetchImpl: async (_url, options = {}) => {
    if (options.method === 'POST') failedFetchPosts++;
    throw new Error('fixture aggregate offline');
  },
});
await assert.rejects(() => tokenOnOfflineBroker.snapshot(['t1']),
  /token-gated broker aggregate read failed closed: fixture aggregate offline/);
assert.equal(failedFetchPosts, 0,
  'a token-gated aggregate fetch failure cannot downgrade to MCP');

let disabledFastPathCalls = 0;
const tokenWithoutFastPath = new BrokerReader({
  readToken: 'required-token', fastPath: false,
  fetchImpl: async () => { disabledFastPathCalls++; return jsonResponse(200, aggregate); },
});
await assert.rejects(() => tokenWithoutFastPath.snapshot(['t1']),
  /read token requires the broker aggregate endpoint/);
assert.equal(disabledFastPathCalls, 0,
  'a read token cannot be configured with a legacy-only read path');

const wrongFleetReader = new BrokerReader({
  fetchImpl: async () => jsonResponse(200, {
    ...aggregate,
    health: { ...aggregate.health, fleet: 'other' },
  }),
});
await assert.rejects(() => wrongFleetReader.snapshot(['t1']), /expected prod/);

const malformedReader = new BrokerReader({
  fetchImpl: async () => jsonResponse(200, { ...aggregate, read_only: false }),
});
await assert.rejects(() => malformedReader.snapshot(['t1']), /invalid or non-read-only/);

const boundLook = {
  ...look(501, 10),
  room: { num: 200, name: 'Marion', resource: 'marion.roo',
    size: { rows: 88, cols: 93 } },
  room_wire: {
    resolved_room_num: 200,
    room_resource_id: 22001,
    room_security_u32: 4294967294,
  },
};
const boundGeneration = {
  map_build_identity: `M59ATLAS/1:${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}`,
  getRoomBinding: room => room === 200
    ? { room_num: 200, room_resource_id: 22001, roo_file: 'marion.roo', rows: 88, cols: 93 }
    : null,
};
const boundAggregate = {
  ...aggregate,
  agents: ['t1'],
  fleet: { ...fleet, agents: 1, fleet: [fleet.fleet[0]] },
  health: { ...aggregate.health, sessions: ['t1'] },
  looks: { t1: boundLook },
  equipment: { t1: aggregate.equipment.t1 },
  spells: { t1: aggregate.spells.t1 },
  inventory: { t1: aggregate.inventory.t1 },
  control: { t1: aggregate.control.t1 },
  commerce: { t1: aggregate.commerce.t1 },
};
const boundReader = new BrokerReader({
  fetchImpl: async () => jsonResponse(200, boundAggregate),
});
const boundSnapshot = await boundReader.snapshotV8(['t1'], boundGeneration);
assert.equal(boundSnapshot.schema, 'm59-rts/v2');
await assert.rejects(() => boundReader.snapshotV8(['not!valid'], boundGeneration),
  /simple identifiers/);

const overbroadBoundReader = new BrokerReader({
  fetchImpl: async () => jsonResponse(200, {
    ...boundAggregate,
    agents: ['t1', 't2'],
    fleet,
    health: aggregate.health,
    looks: { t1: boundLook, t2: { ...boundLook, you: { ...boundLook.you, object_id: 502 } } },
    equipment: aggregate.equipment,
    spells: aggregate.spells,
    inventory: aggregate.inventory,
    control: aggregate.control,
    commerce: aggregate.commerce,
  }),
});
await assert.rejects(() => overbroadBoundReader.snapshotV8(['t1'], boundGeneration),
  /does not exactly match/);

const duplicateBoundReader = new BrokerReader({
  fetchImpl: async () => jsonResponse(200, { ...boundAggregate, agents: ['t1', 't1'] }),
});
await assert.rejects(() => duplicateBoundReader.snapshotV8(['t1'], boundGeneration),
  /invalid or duplicate agent set/);

console.log('m59 RTS broker aggregate fast-path and fail-closed safety passed');

let release,calls=0;
const coalesced=new BrokerReader({fetchImpl:async()=>{calls++;await new Promise(r=>{release=r;});return jsonResponse(200,aggregate);}});
const first=coalesced.aggregateState(['t1','t2']),second=coalesced.aggregateState(['t2','t1']);
assert.equal(calls,1);release();assert.deepEqual(await first,await second);
assert.equal(coalesced.aggregatePending.size,0);
let fail=true,attempts=0,recoverClock=1000;
const recovering=new BrokerReader({now:()=>recoverClock,fetchImpl:async(_url,opts)=>{
  assert.notEqual(opts?.method,'POST','transient outage must not fan out to MCP');attempts++;
  if(fail)throw Error('temporary timeout');return jsonResponse(200,aggregate);
}});
await assert.rejects(()=>recovering.snapshot(['t1']),/temporary timeout/);
await assert.rejects(()=>recovering.snapshot(['t1']),/recovering/);assert.equal(attempts,1);
recoverClock+=1001;fail=false;assert.equal((await recovering.snapshot(['t1'])).sequence,aggregate.sequence);
assert.equal(attempts,2);assert.equal(recovering.fastPathStatus.mode,'broker-aggregate-v1');
console.log('aggregate coalescing and short transient recovery passed');
