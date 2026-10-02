// Offline guard for the operator gateway (tools/m59-operator-gateway.mjs) and its access file
// (tools/runtime/operator-access.mjs). Runs a fake surface on 127.0.0.1 and the real gateway on
// 127.0.0.2; opens no game connection and touches no fleet.
//
//   node tools/m59-operator-gateway-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.M59_OPERATOR_GATEWAY_CONTROL_PORT = '18931';
process.env.M59_OPERATOR_GATEWAY_LOG = join(tmpdir(), 'm59-opgw-test.log');
const { admit, rewriteLoopbackUrls, runGateway } = await import('./m59-operator-gateway.mjs');
const { loadOperatorAccess, operatorFor, isLoopbackAddress } = await import('./runtime/operator-access.mjs');

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const dir = mkdtempSync(join(tmpdir(), 'm59-opgw-'));
const file = body => { const f = join(dir, `a${n}.json`); writeFileSync(f, JSON.stringify(body)); return f; };
const CFG = { listen: ['100.114.254.65'], ports: [8901, 8902, 3000],
  operators: [{ name: 'steamdeck', addresses: ['100.117.223.33'] }] };

await ok('the access file: loads, and refuses a wildcard, a loopback or a non-address listener', () => {
  const good = loadOperatorAccess(file({ format: 'm59-operator-access/1', listen: { addresses: ['100.114.254.65'] },
    operators: [{ name: 'steamdeck', addresses: ['100.117.223.33'] }] }));
  assert.deepEqual(good.ports, [8901, 8902, 3000], 'default ports');
  for (const bad of ['0.0.0.0', '127.0.0.1', 'vecna'])
    assert.throws(() => loadOperatorAccess(file({ format: 'm59-operator-access/1', listen: { addresses: [bad] }, operators: [] })));
  assert.throws(() => loadOperatorAccess(file({ format: 'something-else' })));
  assert.equal(loadOperatorAccess(join(dir, 'absent.json')), null, 'absent is "nothing configured", not an error');
});

await ok('admission: only a listed operator address, IPv4-mapped or not; loopback is not "listed"', () => {
  assert.equal(operatorFor(CFG, '::ffff:100.117.223.33')?.name, 'steamdeck');
  assert.equal(operatorFor(CFG, '100.64.0.9'), null, 'another tailnet device');
  assert.equal(operatorFor(CFG, '192.168.1.20'), null, 'the LAN');
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  const r = admit(CFG, { remoteAddress: '192.168.1.20', headers: { host: 'vecna:8902' }, port: 8902 });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
});

await ok('headers: Host becomes loopback; a same-origin Origin is rewritten; a foreign Origin is REFUSED', () => {
  const same = admit(CFG, { remoteAddress: '100.117.223.33', port: 8902,
    headers: { host: 'vecna:8902', origin: 'http://vecna:8902', referer: 'http://vecna:8902/fleet?x=1' } });
  assert.equal(same.ok, true);
  assert.equal(same.headers.host, '127.0.0.1:8902');
  assert.equal(same.headers.origin, 'http://127.0.0.1:8902');
  assert.equal(same.headers.referer, 'http://127.0.0.1:8902/fleet?x=1');
  const forged = admit(CFG, { remoteAddress: '100.117.223.33', port: 8902,
    headers: { host: 'vecna:8902', origin: 'http://evil.example' } });
  assert.equal(forged.ok, false, 'a page on another site cannot drive the fleet through the operator\'s browser');
  const otherPort = admit(CFG, { remoteAddress: '100.117.223.33', port: 8902,
    headers: { host: 'vecna:8902', origin: 'http://vecna:3000' } });
  assert.equal(otherPort.ok, false, 'another of our own ports is still another origin');
});

await ok('responses: loopback links on our ports point at the host the browser used, others untouched', () => {
  const html = '<a href="http://127.0.0.1:8902/fleet">x</a> <a href="http://localhost:3000/">y</a> http://127.0.0.1:9999/';
  assert.equal(rewriteLoopbackUrls(html, [8901, 8902, 3000], 'vecna'),
    '<a href="http://vecna:8902/fleet">x</a> <a href="http://vecna:3000/">y</a> http://127.0.0.1:9999/');
});

await ok('end to end: an admitted request reaches the surface as a loopback caller, HTML rewritten', async () => {
  const PORT = 18942;
  let seen = null;
  const surface = http.createServer((req, res) => {
    seen = { host: req.headers.host, remote: req.socket.remoteAddress, origin: req.headers.origin ?? null };
    if (req.url === '/go') { res.writeHead(302, { location: `http://127.0.0.1:${PORT}/fleet` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<a href="http://127.0.0.1:${PORT}/x">x</a>`);
  });
  await new Promise(r => surface.listen(PORT, '127.0.0.1', r));
  const cfg = { file: 'test', listen: ['127.0.0.2'], ports: [PORT],
    operators: [{ name: 'test-operator', addresses: ['127.0.0.1'] }] };
  const gw = await runGateway(cfg);
  try {
    const page = await fetch(`http://127.0.0.2:${PORT}/fleet`).then(r => r.text());
    assert.equal(seen.host, `127.0.0.1:${PORT}`, 'the surface sees a loopback Host');
    assert.match(String(seen.remote), /127\.0\.0\.1/, 'and a loopback caller');
    assert.equal(page, `<a href="http://127.0.0.2:${PORT}/x">x</a>`, 'links follow the browser');
    const redirect = await fetch(`http://127.0.0.2:${PORT}/go`, { redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), `http://127.0.0.2:${PORT}/fleet`);
    const forged = await fetch(`http://127.0.0.2:${PORT}/control/stop`, { method: 'POST', headers: { origin: 'http://evil.example' } });
    assert.equal(forged.status, 403, 'a cross-origin write never reaches the surface');
  } finally {
    for (const s of gw.servers) s.close();
    gw.control.close();
    surface.close();
  }
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} passed`);
