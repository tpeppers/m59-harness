#!/usr/bin/env node

// RECORD JAM'S NETWORK CONTRACT, OFFLINE. No socket, roster, broker, or keeper.
//
// Discovery must stay cheap on current keepers, preserve one narrow rolling-upgrade
// fallback, and keep enriched frames on the demand endpoint. A source-text assertion
// would prove only that the strings exist; these fake responses pin which request follows
// which result and the exact unit projection handed to the existing compressor.

import assert from 'node:assert/strict';
import { discoverKeeperAtPort, findKeepers, sampleOnce } from './m59-recordjam.mjs';

const reply = (status, value, { cancel = null } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  body: cancel ? { cancel } : undefined,
  json: async () => value,
});

function fakeFetch(routes, calls = []) {
  return async (input) => {
    const url = new URL(input);
    calls.push(url);
    const route = routes[url.pathname];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(url);
    return route ?? reply(404, { error: 'not found' });
  };
}

const LIVE = {
  schema: 'm59-keeper-live/v1', ok: true, agent: 't1', character: 'Kermit', pid: 123,
  in_game: true, connected: true, connection_revision: 7, uptime_s: 42,
};
const STATE = {
  agent: 't1', character: 'Kermit', pid: 123, in_game: true, connected: true,
  as_of_ms: 2500,
  connection_revision: 7, room: { num: 108, name: 'The Sewers of Barloque' },
  you: { id: 10, col: 43, row: 27, x: 2800, y: 1750 },
  objects: [
    { id: 20, name: 'giant rat', flags: 9, is_player: false,
      col: 43, row: 27, x: 2784, y: 1760 },
  ],
};

console.log('recordjam demand endpoints');

{
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE), '/state': reply(200, STATE) }, calls),
  });
  assert.deepEqual(found, {
    port: 9011, agent: 't1', character: 'Kermit', pid: 123,
    room: { num: 108, name: 'The Sewers of Barloque' },
  });
  assert.deepEqual(calls.map(url => url.pathname), ['/live', '/state'],
    'a current keeper is identified through /live and enriched through /state only');
  assert.equal(calls[1].searchParams.get('agent'), 't1');
  assert.equal(calls[1].searchParams.get('character'), 'Kermit');
  assert.equal(calls[1].searchParams.get('keeper_pid'), '123');
}

for (const missingStatus of [404, 405]) {
  const calls = [];
  const fetchImpl = fakeFetch({
    '/live': reply(missingStatus, { error: 'old keeper' }),
    // Rich-looking legacy health is identity only, even if its own projection is stale.
    '/health': reply(200, { ...STATE, ok: true, as_of_ms: 99_999 }),
    '/state': reply(200, STATE),
  }, calls);
  const found = await findKeepers({ base: 9011, span: 1, fetchImpl });
  assert.equal(found[0]?.agent, 't1');
  assert.equal(found[0]?.room?.num, 108);
  assert.equal(found[0]?.pid, 123);
  assert.equal(Object.hasOwn(found[0], 'legacy_health'), false);
  assert.deepEqual(calls.map(url => url.pathname), ['/live', '/health', '/state'],
    `legacy /health supplies identity after a definite ${missingStatus}, then /state supplies room`);
}

{
  const calls = [];
  const formerlyLegacyObserver = {
    port: 9011, agent: 't1', character: 'Kermit', pid: 123,
    room: STATE.room, legacy_health: true,
  };
  const sample = await sampleOnce(
    [formerlyLegacyObserver], { c1: 43, r1: 27, c2: 43, r2: 27 }, 4_000,
    { now: () => 5_000,
      fetchImpl: fakeFetch({ '/state': reply(200, STATE) }, calls) },
  );
  assert.equal(sample.units.length, 2);
  assert.deepEqual(calls.map(url => url.pathname), ['/state'],
    'even an old tagged observer records exclusively through /state');
}

for (const failure of [reply(500, { error: 'busy' }), new Error('timed out')]) {
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': failure, '/health': reply(200, LIVE) }, calls),
  });
  assert.equal(found, null);
  assert.deepEqual(calls.map(url => url.pathname), ['/live'],
    'a timeout or server failure never falls through to enriched /health');
}

{
  let cancelled = 0;
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({
      '/live': reply(404, { error: 'old keeper' }, { cancel: async () => { cancelled += 1; } }),
      '/health': reply(503, { error: 'busy' }, { cancel: async () => { cancelled += 1; } }),
    }),
  });
  assert.equal(found, null);
  assert.equal(cancelled, 2, 'every non-ok discovery response body is cancelled');
}

for (const changed of [
  { ...LIVE, in_game: false },
  { ...LIVE, ok: false },
  { ...LIVE, connected: false },
]) {
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, changed), '/state': reply(200, STATE) }, calls),
  });
  assert.equal(found, null, 'an explicitly non-live discovery frame is not an observer');
  assert.deepEqual(calls.map(url => url.pathname), ['/live']);
}

for (const changed of [
  { ...STATE, in_game: false },
  { ...STATE, ok: false },
  { ...STATE, connected: false },
]) {
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE), '/state': reply(200, changed) }, calls),
  });
  assert.equal(found, null, 'an explicitly non-live enriched discovery frame is rejected');
  assert.deepEqual(calls.map(url => url.pathname), ['/live', '/state']);
}

for (const changed of [
  { ...STATE, in_game: false },
  { ...STATE, ok: false },
  { ...STATE, connected: false },
]) {
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({
      '/live': reply(404, { error: 'old keeper' }),
      '/health': reply(200, changed),
    }, calls),
  });
  assert.equal(found, null, 'an explicitly non-live legacy health frame is rejected');
  assert.deepEqual(calls.map(url => url.pathname), ['/live', '/health']);
}

{
  const calls = [];
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123, room: STATE.room }],
    { c1: 43, r1: 27, c2: 43, r2: 27 },
    4_000,
    { now: () => 5_000, fetchImpl: fakeFetch({ '/state': reply(200, STATE) }, calls) },
  );
  assert.equal(sample.at, 5_000);
  assert.equal(sample.t_ms, 1_000);
  assert.deepEqual(calls.map(url => url.pathname), ['/state'],
    'sample frames come only from the demand-built state endpoint');
  assert.equal(calls[0].searchParams.get('agent'), 't1');
  assert.equal(calls[0].searchParams.get('character'), 'Kermit');
  assert.equal(calls[0].searchParams.get('keeper_pid'), '123');
  assert.deepEqual(sample.units, [
    { key: 'p:kermit', name: 'Kermit', is_player: true,
      col: 43, row: 27, x: 2800, y: 1750, observer: 't1' },
    { key: 'o:20', id: 20, name: 'giant rat', is_player: false, flags: 9,
      col: 43, row: 27, x: 2784, y: 1760 },
  ], 'switching endpoints preserves the recorder unit projection');
}

{
  const wrong = { ...STATE, agent: 'somebody-else' };
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, wrong) }) },
  );
  assert.deepEqual(sample.units, [], 'a reallocated port contributes no foreign bodies');
}

{
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE),
                           '/state': reply(200, { ...STATE, pid: 999 }) }, calls),
  });
  assert.equal(found, null, 'a port rebound between identity and state reads is refused by PID');
}

for (const identity of [{ ...LIVE, pid: 0 }, { ...LIVE, pid: undefined }]) {
  const calls = [];
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, identity), '/state': reply(200, STATE) }, calls),
  });
  assert.equal(found, null, 'discovery requires positive process provenance');
  assert.deepEqual(calls.map(url => url.pathname), ['/live'],
    'a keeper without PID provenance is rejected before an enriched read');
}

for (const changed of [
  { ...STATE, pid: 999 },
  { ...STATE, character: 'Miss Piggy' },
  { ...STATE, in_game: false },
  { ...STATE, ok: false },
  { ...STATE, connected: false },
]) {
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, changed) }) },
  );
  assert.deepEqual(sample.units, [], 'a frame whose identity/session changed is skipped');
}

for (const changed of [
  { ...STATE, agent: 'somebody-else' },
  { ...STATE, pid: 999 },
  { ...STATE, character: 'Miss Piggy' },
  { ...STATE, in_game: false },
  { ...STATE, ok: false },
  { ...STATE, connected: false },
]) {
  const calls = [];
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123, legacy_health: true }],
    null, 0,
    { now: () => 1,
      fetchImpl: fakeFetch({ '/state': reply(200, changed) }, calls) },
  );
  assert.deepEqual(sample.units, [], 'all frames pass the same complete identity validation');
  assert.deepEqual(calls.map(url => url.pathname), ['/state']);
}

{
  // Pre-field keepers still prove the facts they know: absence is unknown, not false.
  const compatible = { ...STATE };
  delete compatible.ok;
  delete compatible.connected;
  const currentDiscovery = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE), '/state': reply(200, compatible) }),
  });
  const legacyDiscovery = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(404, { error: 'old keeper' }),
                           '/health': reply(200, compatible),
                           '/state': reply(200, compatible) }),
  });
  const current = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, compatible) }) },
  );
  const legacy = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123, legacy_health: true }],
    null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, compatible) }) },
  );
  assert.equal(currentDiscovery?.room?.num, 108);
  assert.equal(legacyDiscovery?.room?.num, 108);
  assert.equal(current.units.length, 2);
  assert.equal(legacy.units.length, 2,
    'absent ok/connected remains compatible while explicit false is refused');
}

for (const invalidAge of [undefined, null, -1, 2500.001, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
  const stale = { ...STATE, as_of_ms: invalidAge };
  if (invalidAge === undefined) delete stale.as_of_ms;
  const discovered = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE), '/state': reply(200, stale) }),
  });
  const sampled = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, stale) }) },
  );
  assert.equal(discovered, null, `discovery rejects invalid state age ${String(invalidAge)}`);
  assert.deepEqual(sampled.units, [], `sampling rejects invalid state age ${String(invalidAge)}`);
}

{
  const zeroAge = { ...STATE, as_of_ms: 0 };
  const found = await discoverKeeperAtPort(9011, {
    fetchImpl: fakeFetch({ '/live': reply(200, LIVE), '/state': reply(200, zeroAge) }),
  });
  assert.equal(found?.agent, 't1', 'zero-age state is inside the freshness boundary');
}

{
  let cancelled = 0;
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1,
      fetchImpl: fakeFetch({
        '/state': reply(503, { error: 'busy' }, { cancel: async () => { cancelled += 1; } }),
      }) },
  );
  assert.deepEqual(sample.units, []);
  assert.equal(cancelled, 1, 'a non-ok sample response body is cancelled');
}

{
  let probes = 0;
  const found = await findKeepers({
    fleet: '__recordjam-demand-test-missing-band__',
    fetchImpl: async () => { probes += 1; throw new Error('must not probe'); },
  });
  assert.deepEqual(found, [], 'a named fleet without a registered band has no observers');
  assert.equal(probes, 0, 'a missing named band is never guessed or scanned');
}

{
  const normalized = { ...STATE, character: '  kErMiT  ' };
  const sample = await sampleOnce(
    [{ port: 9011, agent: 't1', character: 'Kermit', pid: 123 }], null, 0,
    { now: () => 1, fetchImpl: fakeFetch({ '/state': reply(200, normalized) }) },
  );
  assert.equal(sample.units.length, 2, 'character comparison is normalized, not display-case exact');
}

console.log('recordjam demand endpoints: PASS');
