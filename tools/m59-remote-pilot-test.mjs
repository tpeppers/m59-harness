// Offline guard for tools/m59-remote-pilot.mjs: the real holder, against a fake broker on loopback
// and a stand-in client process whose command line names a Meridian.exe and a /U: account. Opens no
// game connection and touches no roster. POSIX only (the client scan reads /proc).
//
//   node tools/m59-remote-pilot-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPilotLease, pilotLeaseMs, renewPilotLease } from './runtime/pilot-lease.mjs';

if (process.platform === 'win32') { console.log('skipped: the client scan under test is the /proc one'); process.exit(0); }
const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// A broker that speaks just enough of `pilot`: leases when `legacy` is false, pid-only when true.
function fakeBroker({ fleet = 'prod', legacy = false } = {}) {
  const calls = [];
  const claims = new Map();
  const server = http.createServer((req, res) => {
    const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/health') return reply({ ok: true, fleet, pid: process.pid });
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const a = JSON.parse(body).params.arguments;
      calls.push(a);
      let out;
      if (a.action === 'claim' && a.lease_ms != null && !legacy) {
        const lease = newPilotLease({ holder: a.holder, ms: pilotLeaseMs(Math.max(15_000, a.lease_ms)), now: Date.now() });
        claims.set(a.agent, { lease });
        out = { claimed: true, lease_id: lease.id };
      } else if (a.action === 'claim') {
        out = a.pid ? (claims.set(a.agent, { pid: a.pid }), { claimed: true, pid: a.pid })
                    : { error: 'pid is required for claim — the claim is the process, not the name' };
      } else if (a.action === 'renew') {
        out = renewPilotLease(claims.get(a.agent), { id: a.lease_id, now: Date.now() });
      } else if (a.action === 'release') {
        out = { released: claims.delete(a.agent) };
      }
      reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () =>
    r({ server, calls, claims, url: `http://127.0.0.1:${server.address().port}/` })));
}

// A process whose command line carries a Meridian.exe argument and a /U:, like a Proton wrapper.
const fakeClient = (account) =>
  spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1e6)', '/games/m59/Meridian.exe', `/U:${account}`], { stdio: 'ignore' });

function holder(url, extra) {
  const p = spawn(process.execPath, [join(HERE, 'm59-remote-pilot.mjs'), 'hold', '--broker', url, ...extra],
    { env: { ...process.env, M59_REMOTE_PILOT_MIN_BEAT_MS: '300' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const done = new Promise(r => p.on('exit', code => r({ code, out })));
  return { p, done, out: () => out };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const account = `zt${process.pid}`;   // unique, so a real client on this machine is never matched

await ok('lease: claims BEFORE the client exists, renews while it runs, releases its own lease when it exits', async () => {
  const b = await fakeBroker();
  const h = holder(b.url, ['--agent', account, '--fleet', 'prod', '--lease-ms', '900', '--holder', 'test deck']);
  await sleep(200);
  assert.equal(b.calls[0]?.action, 'claim', 'claimed with no client running yet');
  assert.equal(b.calls[0].holder, 'test deck');
  const client = fakeClient(account);
  await sleep(1500);
  assert.ok(b.calls.filter(c => c.action === 'renew').length >= 2, 'renewed while the client ran');
  client.kill();
  const { code, out } = await h.done;
  assert.equal(code, 0, out);
  const rel = b.calls.find(c => c.action === 'release');
  assert.ok(rel?.lease_id, 'release names its lease, so a newer holder is not ended by a stale one');
  assert.equal(b.claims.size, 0);
  b.server.close();
});

await ok('an unrolled broker: anchored on the broker pid, says so, and still releases on exit', async () => {
  const b = await fakeBroker({ legacy: true });
  const h = holder(b.url, ['--agent', account, '--lease-ms', '900']);
  const client = fakeClient(account);
  await sleep(1200);
  assert.equal(b.calls.filter(c => c.action === 'claim').at(-1).pid, process.pid, 'anchored on /health pid');
  assert.match(h.out(), /ANCHORED/);
  client.kill();
  const { code } = await h.done;
  assert.equal(code, 0);
  assert.equal(b.claims.size, 0);
  b.server.close();
});

await ok('the wrong fleet is refused before anything is claimed', async () => {
  const b = await fakeBroker({ fleet: 'shadow' });
  const { code, out } = await holder(b.url, ['--agent', account, '--fleet', 'prod']).done;
  assert.equal(code, 1);
  assert.match(out, /holding fleet "shadow", not "prod"/);
  assert.equal(b.calls.length, 0);
  b.server.close();
});

await ok('no client ever appears: the character is given back', async () => {
  const b = await fakeBroker();
  const { code, out } = await holder(b.url, ['--agent', account, '--lease-ms', '900', '--wait-ms', '500']).done;
  assert.equal(code, 1);
  assert.match(out, /no client for .* appeared/);
  assert.equal(b.claims.size, 0);
  b.server.close();
});

await ok('a lapsed lease is claimed again while the client still runs', async () => {
  const b = await fakeBroker();
  const h = holder(b.url, ['--agent', account, '--lease-ms', '900']);
  const client = fakeClient(account);
  await sleep(400);
  b.claims.clear();                        // the broker restarted, or the lease lapsed
  await sleep(900);
  assert.ok(b.calls.filter(c => c.action === 'claim').length >= 2, 'claimed again');
  assert.equal(b.claims.size, 1);
  client.kill();
  await h.done;
  b.server.close();
});

console.log(`\n${n} passed`);
