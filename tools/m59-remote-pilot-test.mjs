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
import { newPilotLease, pilotLeaseMs, renewPilotLease, createLeaseGraveyard, pilotHeld }
  from './runtime/pilot-lease.mjs';
import { createHold } from './m59-remote-pilot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// ---------------------------------------------------------------- in process, every platform
//
// The real hold loop (createHold), against a broker model built from the broker's own lease
// functions, with the client and the clock injected. `graveyard: false` is a broker that predates
// the record of ended leases -- it answers a released lease "not claimed, reclaim" -- which is what
// prod ran on 2026-10-02 and what a Deck may still meet.
function brokerModel({ graveyard = true, pid = 4242 } = {}) {
  const claims = new Map(), graves = createLeaseGraveyard(), calls = [];
  const m = {
    pid, claims, calls,
    restart() { m.pid += 1; claims.clear(); },
    release(agent, why = 'released by request') {
      const p = claims.get(agent);
      if (!p) return false;
      claims.delete(agent);
      if (graveyard && p.lease) graves.bury(agent, p.lease, why, Date.now());
      return true;
    },
    async health() { return { ok: true, fleet: 'prod', pid: m.pid }; },
    async rpc(name, a) {
      calls.push({ ...a, at: Date.now() });
      if (a.action === 'claim') {
        const held = claims.get(a.agent);
        if (held && pilotHeld(held, { now: Date.now(), pidAlive: () => false }).held && held.lease.holder !== a.holder)
          return { error: `${a.agent} is already held by a remote lease from ${held.lease.holder}` };
        const lease = newPilotLease({ holder: a.holder, ms: 60_000, now: Date.now() });
        if (graveyard && held?.lease) graves.bury(a.agent, held.lease, 'superseded', Date.now());
        claims.set(a.agent, { pid: null, lease });
        return { claimed: true, lease_id: lease.id };
      }
      if (a.action === 'renew')
        return renewPilotLease(claims.get(a.agent), { id: a.lease_id, now: Date.now(),
          ended: graveyard ? graves.find(a.agent, a.lease_id, Date.now()) : null });
      if (a.action === 'release') {
        const held = claims.get(a.agent);
        if (a.lease_id && held && held.lease?.id !== a.lease_id) return { released: false, note: 'not that lease' };
        return { released: m.release(a.agent, 'released by its holder') };
      }
      return { error: `unknown action ${a.action}` };
    },
  };
  return m;
}
const tick = (ms = 4) => new Promise(r => setTimeout(r, ms));
function holdIn(b, agent, { clients = new Set([agent]), beat = 5, waitMs = 5000, holder = 'steamdeck m59-tui' } = {}) {
  const lines = [];
  const h = createHold({ agent, holder, leaseMs: 60_000, waitMs, beat }, {
    rpc: (name, a) => b.rpc(name, a), health: () => b.health(),
    findClient: (acct) => clients.has(acct) ? { pid: 1000 + acct.length, account: acct } : null,
    pidAlive: () => clients.has(agent), sleep: tick, log: (...m) => lines.push(m.join(' ')),
  });
  const done = h.run();
  return { h, done, lines, clients };
}
const beatsFor = (b, agent, after = 0) => b.calls.filter(c => c.agent === agent && c.action === 'renew' && c.at > after).length;
const claimsFor = (b, agent, after = 0) => b.calls.filter(c => c.agent === agent && c.action === 'claim' && c.at > after).length;
const until = async (pred, ms = 2000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) return false; await tick(); } return true; };

await ok('(c) a release by request STOPS the heartbeat: the "released" reply ends the loop, nothing re-claims', async () => {
  const b = brokerModel();
  const { done, lines } = holdIn(b, 'hk3');
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 2), 'heartbeating while held');
  b.release('hk3');                                   // the operator's `pilot release hk3`
  const at = Date.now();
  const r = await Promise.race([done, tick(1500).then(() => null)]);
  assert.ok(r, `the loop ended (log: ${lines.join(' | ')})`);
  assert.equal(r.code, 0);
  assert.equal(claimsFor(b, 'hk3', at), 0, 'Raphael, 2026-10-02: the next heartbeat re-claimed him');
  assert.equal(b.claims.has('hk3'), false);
  const after = beatsFor(b, 'hk3');
  await tick(60);
  assert.equal(beatsFor(b, 'hk3'), after, 'no further heartbeats for that agent');
  assert.ok(!b.calls.some(c => c.action === 'release' && c.at > at), 'nothing of ours left to release');
});

await ok('(c) against a broker with NO record of ended leases, a release by the SAME broker still stops it', async () => {
  const b = brokerModel({ graveyard: false });         // answers "not claimed, reclaim: true"
  const { done } = holdIn(b, 'hk3');
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 2));
  b.release('hk3');
  const at = Date.now();
  const r = await Promise.race([done, tick(1500).then(() => null)]);
  assert.ok(r, 'the loop ended');
  assert.equal(claimsFor(b, 'hk3', at), 0, 'same broker pid: that was a release, not a restart');
  assert.equal(b.claims.has('hk3'), false);
});

await ok('a broker that RESTARTED (new pid, no memory of the lease) is claimed again while the client runs', async () => {
  const b = brokerModel({ graveyard: false });
  const { h, done } = holdIn(b, 'hk3');
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 1));
  b.restart();
  assert.ok(await until(() => b.claims.has('hk3')), 're-claimed on the new broker');
  await h.stop('test over');
  await done;
});

await ok('(c) a lease that lapsed (the broker released it) is not revived by the loop', async () => {
  const b = brokerModel();
  const { done } = holdIn(b, 'hk3');
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 1));
  b.release('hk3', 'no heartbeat from steamdeck m59-tui for 61s -- the remote lease lapsed');
  const at = Date.now();
  const r = await Promise.race([done, tick(1500).then(() => null)]);
  assert.ok(r);
  assert.equal(claimsFor(b, 'hk3', at), 0);
});

await ok('(c) after the client exits: released once, then not one more heartbeat', async () => {
  const b = brokerModel();
  const { done, clients } = holdIn(b, 'hk3');
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 2));
  clients.delete('hk3');
  const r = await done;
  assert.equal(r.code, 0);
  assert.equal(b.claims.has('hk3'), false);
  const after = beatsFor(b, 'hk3');
  await tick(60);
  assert.equal(beatsFor(b, 'hk3'), after);
});

await ok('(d) two characters held, release one: only the other is heartbeated', async () => {
  const b = brokerModel();
  const clients = new Set(['hk3', 't1']);
  const raph = holdIn(b, 'hk3', { clients });
  const kermit = holdIn(b, 't1', { clients });
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 2 && beatsFor(b, 't1') >= 2));
  b.release('hk3');
  const at = Date.now();
  assert.ok(await Promise.race([raph.done, tick(1500).then(() => null)]), 'hk3 loop ended');
  const t = Date.now();
  await tick(80);
  assert.equal(beatsFor(b, 'hk3', t), 0, 'hk3 is not heartbeated any more');
  assert.ok(beatsFor(b, 't1', t) >= 2, 't1 still is');
  assert.equal(claimsFor(b, 'hk3', at), 0);
  assert.ok(b.claims.has('t1') && !b.claims.has('hk3'));
  await kermit.h.stop('test over');
  await kermit.done;
});

await ok('a holder superseded by a newer launch for the same character stops; the newer one keeps it', async () => {
  const b = brokerModel();
  const clients = new Set(['hk3']);
  const older = holdIn(b, 'hk3', { clients });
  assert.ok(await until(() => beatsFor(b, 'hk3') >= 1));
  const newer = holdIn(b, 'hk3', { clients });
  assert.ok(await Promise.race([older.done, tick(1500).then(() => null)]), 'the older holder ended');
  const t = Date.now();
  await tick(60);
  assert.ok(beatsFor(b, 'hk3', t) >= 2, 'the newer one still heartbeats');
  assert.ok(b.claims.has('hk3'));
  await newer.h.stop('test over');
  await newer.done;
  assert.equal(b.claims.has('hk3'), false, 'stop releases its own lease');
});

// ---------------------------------------------------------------- the CLI, POSIX only
if (process.platform === 'win32') {
  console.log(`\n${n} passed (the CLI cases are skipped here: the client scan under test is the /proc one)`);
  process.exit(0);
}

// A broker that speaks just enough of `pilot`: leases when `legacy` is false, pid-only when true.
function fakeBroker({ fleet = 'prod', legacy = false } = {}) {
  const calls = [];
  const claims = new Map();
  const state = { pid: process.pid };
  const server = http.createServer((req, res) => {
    const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/health') return reply({ ok: true, fleet, pid: state.pid });
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
    r({ server, calls, claims, state, url: `http://127.0.0.1:${server.address().port}/` })));
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

await ok('a broker that restarted is claimed again while the client still runs', async () => {
  const b = await fakeBroker();
  const h = holder(b.url, ['--agent', account, '--lease-ms', '900']);
  const client = fakeClient(account);
  await sleep(400);
  b.claims.clear(); b.state.pid += 1;      // the broker restarted: a new process, no memory of the lease
  await sleep(900);
  assert.ok(b.calls.filter(c => c.action === 'claim').length >= 2, 'claimed again');
  assert.equal(b.claims.size, 1);
  client.kill();
  await h.done;
  b.server.close();
});

await ok('the CLI: a release by hand on the SAME broker stops the holder -- it does not claim again', async () => {
  const b = await fakeBroker();
  const h = holder(b.url, ['--agent', account, '--lease-ms', '900']);
  const client = fakeClient(account);
  await sleep(400);
  const claimed = b.calls.filter(c => c.action === 'claim').length;
  b.claims.clear();                        // `pilot release` by hand: same broker process
  const { code, out } = await h.done;
  assert.equal(code, 0, out);
  assert.match(out, /stopping without releasing/);
  assert.equal(b.calls.filter(c => c.action === 'claim').length, claimed, 'no re-claim');
  assert.equal(b.claims.size, 0);
  client.kill();
  b.server.close();
});

console.log(`\n${n} passed`);
