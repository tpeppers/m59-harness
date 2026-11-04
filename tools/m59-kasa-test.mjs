#!/usr/bin/env node
// Offline protocol and durable alert lifecycle checks; never contacts a household bulb.
import assert from 'node:assert/strict';
import net from 'node:net';
import { encrypt, decrypt, request, LIGHT, bulbInfo, matchesBulb, resolveBulb, checkLight, restorableLight, setLight, redState } from './m59-kasa.mjs';
import { syncLights } from './m59-alert-lights.mjs';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };
const normal = { on_off: 1, hue: 42, saturation: 20, brightness: 70, color_temp: 0, mode: 'normal' };
const device = { alias: 'Example lamp', mac: 'AA:BB:CC:DD:EE:FF', model: 'KL125(US)', host: '192.168.1.9', light_state: normal };
const sysinfo = d => ({ system: { get_sysinfo: { ...d, mic_mac: d.mac } } });
await test('UDP encryption fixture and UTF8 roundtrip', () => {
  assert.equal(encrypt({}).toString('hex'), 'd0ad');
  assert.deepEqual(decrypt(encrypt({ name: 'lámpara' })), { name: 'lámpara' });
});
await test('TCP framing is length-prefixed', () => {
  const b = encrypt({ system: {} }, true);
  assert.equal(b.readUInt32BE(), b.length - 4); assert.deepEqual(decrypt(b.subarray(4)), { system: {} });
});
await test('identity match cannot silently select a different bulb', () => {
  assert(matchesBulb(device, { alias: 'example lamp', mac: 'aabbccddeeff', model: 'KL125' }));
  assert(!matchesBulb(device, { alias: 'Someone else' }));
  assert(!matchesBulb(device, { mac: '112233445566' }));
  assert.equal(bulbInfo(sysinfo(device), device.host).alias, device.alias);
});
await test('DHCP changes cause rediscovery and duplicate aliases refuse', async () => {
  const found = await resolveBulb({ alias: device.alias, host: '192.168.1.8' }, { query: async () => sysinfo({ ...device, alias: 'Other' }), scan: async () => [device] });
  assert.equal(found.host, device.host);
  await assert.rejects(resolveBulb({ alias: device.alias }, { scan: async () => [device, { ...device, mac: '112233445566' }] }), /ambiguous/);
});
await test('validation rejects bad colours, identities, and clear modes', () => {
  assert.deepEqual(checkLight({ alias: device.alias }), []);
  for (const spec of [{}, { mac: 'x' }, { alias: 'x', hue: 361 }, { alias: 'x', brightness: 0 }, { alias: 'x', saturation: 101 }, { alias: 'x', clear: 'other' }]) assert(checkLight(spec).length);
});
await test('an off bulb retains its remembered colour for restoration', () => {
  assert.deepEqual(restorableLight({ on_off: 0, dft_on_state: normal }), { ...normal, on_off: 0 });
});
async function mockServer(answer, fn) {
  const sockets = new Set();
  const server = net.createServer(s => {
    sockets.add(s); s.on('close', () => sockets.delete(s));
    s.once('data', data => answer(s, decrypt(data.subarray(4))));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); }
  finally { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); }
}
await test('real TCP reader handles fragmented frames', async () => {
  await mockServer((s, command) => {
    const b = encrypt(command, true); s.write(b.subarray(0, 2)); setTimeout(() => s.end(b.subarray(2)), 5);
  }, async port => assert.deepEqual(await request('127.0.0.1', { system: {} }, { port }), { system: {} }));
});
await test('TCP refuses device NACKs, oversized frames, truncated replies and timeouts', async () => {
  for (const [answer, pattern] of [
    [(s) => s.end(encrypt({ [LIGHT]: { transition_light_state: { err_code: -1, err_msg: 'refused' } } }, true)), /refused/],
    [(s) => { const b = Buffer.alloc(4); b.writeUInt32BE(9999999); s.end(b); }, /limit/],
    [(s) => s.end(Buffer.from([0])), /complete/],
    [() => {}, /timed out/],
  ]) await mockServer(answer, async port => assert.rejects(request('127.0.0.1', {}, { port, timeoutMs: 80 }), pattern));
});
await test('set verifies acknowledgement, identity, and actual colour', async () => {
  const target = redState({}); let calls = 0;
  await setLight(device, target, { query: async () => ++calls === 1 ? { [LIGHT]: { transition_light_state: { err_code: 0 } } } : sysinfo({ ...device, light_state: target }) });
  assert.equal(calls, 2);
  await assert.rejects(setLight(device, target, { query: async () => ({}) }), /acknowledge/);
  calls = 0;
  await assert.rejects(setLight(device, target, { query: async () => ++calls === 1 ? { [LIGHT]: { transition_light_state: { err_code: 0 } } } : sysinfo(device) }), /read back/);
});
const spec = { alias: device.alias }, tw = { a: { then: { kasa: spec } }, b: { then: { kasa: spec } } };
await test('two alerts share one light save; restart does not overwrite it; last clear restores', async () => {
  let records = {}, writes = [], snapshots = [];
  const opts = { resolve: async () => device, set: async (d, state) => writes.push(state), save: value => snapshots.push(structuredClone(value)) };
  await syncLights(tw, { a: { active: true } }, records, opts);
  assert.equal(writes.length, 1); assert.equal(snapshots[0]['alias:example lamp'].before.hue, 42);
  assert.equal(snapshots[0]['alias:example lamp'].pending, true);
  records = JSON.parse(JSON.stringify(records)); // restart
  await syncLights(tw, { a: { active: true }, b: { active: true } }, records, opts);
  await syncLights(tw, { b: { active: true } }, records, opts); assert.equal(writes.length, 1);
  await syncLights(tw, {}, records, opts); assert.deepEqual(writes.at(-1), normal); assert.deepEqual(records, {});
});
await test('bulb failure retries without losing original state or changing alert states', async () => {
  const records = {}, states = { a: { active: true } }; let attempts = 0;
  const opts = { now: 100, resolve: async () => device, set: async () => { attempts++; throw new Error('unplugged'); } };
  await syncLights(tw, states, records, opts); assert(states.a.active); assert.equal(attempts, 1);
  assert.equal(records['alias:example lamp'].before.hue, 42);
  await syncLights(tw, states, records, { ...opts, now: 200 }); assert.equal(attempts, 1);
  await syncLights(tw, states, records, { ...opts, now: 60100 }); assert.equal(attempts, 2);
});
await test('a matched trigger still lights when posture application needs retry', async () => {
  let writes = 0;
  await syncLights(tw, { a: { active: false, last_observation: { hits: 1 } } }, {}, { resolve: async () => device, set: async () => writes++ });
  assert.equal(writes, 1);
});
await test('dry mode does no discovery, mutation, or persistence', async () => {
  const no = () => { throw new Error('dry touched light'); };
  const records = {};
  await syncLights(tw, { a: { active: true } }, records, { dry: true, resolve: no, set: no, save: no });
  assert.deepEqual(records, {});
});
await test('removing an alert restores its pending light; explicit leave keeps its colour', async () => {
  const records = {}; let writes = 0;
  const opts = { resolve: async () => device, set: async () => writes++ };
  await syncLights(tw, { a: { active: true } }, records, opts);
  await syncLights({}, {}, records, opts); assert.equal(writes, 2);
  const leave = { a: { then: { kasa: { ...spec, clear: 'leave' } } } };
  await syncLights(leave, { a: { active: true } }, records, opts);
  await syncLights(leave, {}, records, opts); assert.equal(writes, 3); assert.deepEqual(records, {});
});
console.log(`${passed} passed`);
