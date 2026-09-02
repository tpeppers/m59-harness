#!/usr/bin/env node
// Loopback-only RuntimeControlServer tests. Offline; binds only an ephemeral 127.0.0.1 port.
//
//   node tools/runtime/control-server-test.mjs

import assert from 'node:assert/strict';
import http from 'node:http';

import { RuntimeControlServer, createControlServer } from './control-server.mjs';
import { AcknowledgedTransitionStream } from './state/index.mjs';

let defaultToken = null;
function request({ port, path, method = 'GET', body = null, headers = {}, token = defaultToken }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const outgoing = http.request({
      host: '127.0.0.1', port, path, method, agent: false,
      headers: {
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...(typeof token === 'string' ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    outgoing.on('error', reject);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

async function until(predicate, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition did not settle');
}

const transitions = new AcknowledgedTransitionStream({
  streamId: 'control-test/animal/transitions',
  now: () => 1234,
});
transitions.publish('room-left', { room: 1 });
transitions.publish('room-entered', { room: 2 });

let snapshotCalls = 0;
let statsReads = 0;
const cachedState = Object.freeze({
  schema: 'fake-fleet-state/v1',
  lifecycle: 'running',
  actors: Object.freeze([{ id: 'animal', status: 'running' }]),
});
const runtime = {
  lifecycle: 'running',
  get stats() {
    statsReads++;
    return { total: 1, decisions: 7 };
  },
  snapshot() {
    snapshotCalls++;
    return cachedState;
  },
  streamsFor(agent) {
    return agent === 'animal' ? { transitions } : null;
  },
};

let stopCalls = 0;
const control = createControlServer({
  runtime,
  onStop: async () => { stopCalls++; },
  maxBodyBytes: 48,
  maxTransitionLimit: 10,
  memoryUsage: () => ({ rss: 100, heapUsed: 20 }),
});
assert.equal(control instanceof RuntimeControlServer, true);
assert.match(control.token, /^[A-Za-z0-9_-]{43}$/);
const otherToken = createControlServer({ runtime, onStop() {} });
assert.notEqual(otherToken.token, control.token);
await otherToken.close();
defaultToken = control.token;
await assert.rejects(control.listen({ port: 0, host: '0.0.0.0' }), /loopback/);
await assert.rejects(control.listen({ port: 0, host: '192.168.1.10' }), /loopback/);

const address = await control.listen({ port: 0 });
assert.equal(address.address, '127.0.0.1');
assert.equal(address.port > 0, true);
assert.equal(control.listening, true);
assert.equal(await control.listen({ port: 12345 }), address, 'listen is idempotent once bound');

{
  const missing = await request({ port: address.port, path: '/health', token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, 'unauthorized');
  assert.equal(missing.headers['www-authenticate'], 'Bearer');
  const wrong = await request({ port: address.port, path: '/health', token: 'not-the-token' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'unauthorized');
  const origin = await request({
    port: address.port, path: '/health', headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(origin.status, 403);
  assert.equal(origin.json.error.code, 'cross_site_forbidden');
  const fetchSite = await request({
    port: address.port, path: '/health', headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(fetchSite.status, 403);
  assert.equal(fetchSite.json.error.code, 'cross_site_forbidden');
  const badHost = await request({
    port: address.port, path: '/health', headers: { Host: 'attacker.example' },
  });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.json.error.code, 'invalid_host');
}

{
  const response = await request({ port: address.port, path: '/health' });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.lifecycle, 'running');
  assert.deepEqual(response.json.stats, { total: 1, decisions: 7 });
  assert.deepEqual(response.json.memory, { rss: 100, heapUsed: 20 });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.text.includes(control.token), false);
  assert.equal(statsReads, 1);
  assert.equal(snapshotCalls, 0, 'health never asks for actor/fleet snapshots');
}

{
  const response = await request({ port: address.port, path: '/state' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, cachedState);
  assert.equal(snapshotCalls, 1);
}

{
  const first = await request({
    port: address.port,
    path: '/transitions?agent=animal&after=0&limit=1',
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.transitions.map(row => row.type), ['room-left']);
  assert.equal(first.json.stream_id, transitions.streamId);

  const ack = await request({
    port: address.port,
    path: '/transitions/ack',
    method: 'POST',
    body: JSON.stringify({ agent: 'animal', sequence: 1 }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.acknowledged_through, 1);
  assert.equal(transitions.pendingCount, 1);

  const second = await request({
    port: address.port,
    path: '/transitions?agent=animal&after=1&limit=10',
  });
  assert.deepEqual(second.json.transitions.map(row => row.type), ['room-entered']);
}

{
  const missing = await request({ port: address.port, path: '/transitions' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'missing_agent');
  const unknown = await request({ port: address.port, path: '/transitions?agent=nobody' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'agent_not_found');
  const invalid = await request({ port: address.port, path: '/transitions?agent=animal&after=-1' });
  assert.equal(invalid.status, 400);
  const excessive = await request({ port: address.port, path: '/transitions?agent=animal&limit=11' });
  assert.equal(excessive.status, 400);
}

{
  const invalidJson = await request({
    port: address.port, path: '/transitions/ack', method: 'POST', body: '{broken',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, 'invalid_json');
  const oversized = await request({
    port: address.port, path: '/transitions/ack', method: 'POST', body: 'x'.repeat(49),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'body_too_large');
}

{
  const wrongMethod = await request({ port: address.port, path: '/health', method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, 'method_not_allowed');
  const missing = await request({ port: address.port, path: '/does-not-exist' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
}

{
  const denied = await request({
    port: address.port, path: '/stop', method: 'POST', token: null,
  });
  assert.equal(denied.status, 401);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopCalls, 0, 'an unauthenticated mutation never reaches onStop');
  const accepted = await request({ port: address.port, path: '/stop', method: 'POST' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.status, 'accepted');
  const again = await request({ port: address.port, path: '/stop', method: 'POST' });
  assert.equal(again.status, 202);
  assert.equal(again.json.status, 'already-accepted');
  await until(() => stopCalls === 1);
  assert.equal(stopCalls, 1);
}

const firstClose = control.close();
const secondClose = control.close();
assert.equal(firstClose, secondClose, 'close is idempotent while pending');
assert.equal(await firstClose, true);
assert.equal(await control.close(), true, 'close remains idempotent after completion');
assert.equal(control.listening, false);
await assert.rejects(control.listen({ port: 0 }), /closed permanently/);

// Closing during the initial asynchronous bind cannot leave a listener behind.
{
  const racing = new RuntimeControlServer({ runtime, onStop() {} });
  const listening = racing.listen({ port: 0 });
  const closing = racing.close();
  const [bound, didClose] = await Promise.all([listening, closing]);
  assert.equal(bound.port > 0, true);
  assert.equal(didClose, true);
  assert.equal(racing.listening, false);
}

console.log('runtime control server: PASS');
