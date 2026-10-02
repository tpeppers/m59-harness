#!/usr/bin/env node
// HOLD A CHARACTER FOR A CLIENT ON THIS MACHINE, AGAINST A BROKER ON ANOTHER ONE.
//
//   node tools/m59-remote-pilot.mjs hold --broker http://vecna:8901 --fleet prod --agent t5
//
// The pilot claim is what stops a keeper fighting a person for a character: Meridian allows one
// connection per character, so a client logging in bumps the broker, and without a claim the 45s
// rejoin sweep logs straight back in and bumps the person. Locally the claim is bound to the
// client's pid. From a Steam Deck playing against Vecna's broker that pid means nothing there, so
// this process holds a LEASE instead (tools/runtime/pilot-lease.mjs) and renews it for as long as
// the client runs here:
//
//   1. claim at once, BEFORE the client logs in -- the claim needs no pid, so the rejoin sweep is
//      already standing down when the client bumps the keeper;
//   2. wait for the client to appear on this machine (its /U: names the account), and give the
//      character back if it never does;
//   3. renew every third of the lease while that client process lives;
//   4. release when it exits, or when this process is told to stop.
//
// If this process dies without releasing, the lease lapses by itself and the keeper comes back
// within one lease. That is the direction to fail in.
//
// AN OLDER BROKER, with no lease support, answers "pid is required". Then the claim is ANCHORED on
// the broker's own pid -- which is alive for as long as the broker is -- and released by this
// process when the client exits. That works on a broker nobody has rolled yet, but it has no
// self-expiry: if this process is killed, the character stays parked until `pilot release`. It
// says so on every line it logs in that mode.
//
// It reaches the broker through the operator gateway (tools/m59-operator-gateway.mjs) when the
// broker is on another machine; it never starts one and never reads a password.
import process from 'node:process';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { localClients } from './m59-localclient.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const cmd = argv[0];

const log = (...m) => console.log(`[remote-pilot ${new Date().toISOString()}]`, ...m);

export async function rpc(broker, name, args, ms = 10_000) {
  const r = await fetch(broker.replace(/\/?$/, '/'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(ms),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  if (j.error || j.result?.isError) return { error: j.error?.message ?? text };
  try { return JSON.parse(text); } catch { return { error: `unreadable reply: ${text.slice(0, 200)}` }; }
}

export async function health(broker, ms = 8000) {
  const r = await fetch(broker.replace(/\/?$/, '/') + 'health', { signal: AbortSignal.timeout(ms) });
  return r.json();
}

/** Did the broker refuse a lease because it predates them? Its reply asks for a pid. */
export const brokerLacksLeases = (r) => /pid is required/i.test(String(r?.error ?? ''));

/** The local client playing this account, or null. Matching is by /U:, case-insensitively. */
async function clientFor(account) {
  const want = String(account).toLowerCase();
  const all = await localClients({ ttlMs: 0 });
  return all.find(c => String(c.account ?? '').toLowerCase() === want) ?? null;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function hold() {
  const broker = arg('--broker', process.env.M59_BROKER_URL);
  const agent = arg('--agent');
  const account = arg('--account', agent);
  const fleet = arg('--fleet');
  const holder = arg('--holder', `${hostname()} m59-remote-pilot`);
  const leaseMs = Number(arg('--lease-ms', 60_000));
  const waitMs = Number(arg('--wait-ms', 180_000));
  if (!broker || !agent) {
    console.error('usage: m59-remote-pilot.mjs hold --broker http://<host>:8901 --agent <agent> ' +
                  '[--account <account>] [--fleet <name>] [--holder <text>] [--lease-ms 60000] [--wait-ms 180000]');
    process.exit(2);
  }
  // The floor is overridable only so the offline test does not take minutes.
  const beat = Math.max(Number(process.env.M59_REMOTE_PILOT_MIN_BEAT_MS || 5000), Math.floor(leaseMs / 3));

  // THE RIGHT FLEET, OR NOTHING. A claim on the wrong broker parks a stranger's character.
  let h;
  try { h = await health(broker); } catch (e) { log(`broker ${broker} did not answer /health: ${e.message}`); process.exit(1); }
  if (fleet && h.fleet !== fleet) {
    log(`REFUSED: ${broker} is holding fleet "${h.fleet}", not "${fleet}" -- nothing claimed`);
    process.exit(1);
  }

  let mode = 'lease', leaseId = null, anchorPid = null;
  const claim = async () => {
    const r = await rpc(broker, 'pilot', { action: 'claim', agent, lease_ms: leaseMs, holder });
    if (!r.error) { mode = 'lease'; leaseId = r.lease_id; return r; }
    if (!brokerLacksLeases(r)) return r;
    // An unrolled broker: anchor on its own pid. See the header for what that costs.
    const hh = await health(broker);
    const a = await rpc(broker, 'pilot', { action: 'claim', agent, pid: hh.pid });
    if (!a.error) { mode = 'anchored'; anchorPid = hh.pid; leaseId = null; }
    return a;
  };
  const release = async (why) => {
    try {
      const r = await rpc(broker, 'pilot', { action: 'release', agent, ...(leaseId ? { lease_id: leaseId } : {}) }, 8000);
      log(`released ${agent} (${why}): ${r.error ?? (r.released ? 'ok' : r.note)}`);
    } catch (e) {
      log(`release of ${agent} FAILED (${why}): ${e.message}` +
          (mode === 'lease' ? ' -- the lease lapses on its own' : ' -- ANCHORED: run `pilot release` for it by hand'));
    }
  };

  const first = await claim();
  if (first.error) { log(`claim of ${agent} refused: ${first.error}`); process.exit(1); }
  log(mode === 'lease'
    ? `claimed ${agent} on ${broker} by lease ${leaseId} (${leaseMs / 1000}s, renewed every ${beat / 1000}s) for ${holder}`
    : `claimed ${agent} on ${broker} ANCHORED on broker pid ${anchorPid} -- that broker predates leases, so ` +
      'this claim does not expire: if this process is killed, `pilot release` it by hand');

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
    if (stopping) return; stopping = true;
    await release(`this holder got ${sig}`); process.exit(0);
  });

  const started = Date.now();
  let clientPid = null;
  for (;;) {
    await new Promise(r => setTimeout(r, beat));
    if (stopping) return;
    // IS THE PERSON STILL HERE? Once seen, the pid is watched directly -- a signal 0, not a scan.
    if (clientPid == null) {
      const c = await clientFor(account).catch(() => null);
      if (c) { clientPid = c.pid; log(`client for ${account} is pid ${clientPid}`); }
      else if (Date.now() - started > waitMs) {
        await release(`no client for ${account} appeared within ${Math.round(waitMs / 1000)}s`);
        process.exit(1);
      }
    } else if (!pidAlive(clientPid)) {
      // A Proton relaunch can hand the account to a new pid; look once before letting go.
      const again = await clientFor(account).catch(() => null);
      if (again && again.pid !== clientPid) { clientPid = again.pid; log(`client for ${account} is now pid ${clientPid}`); }
      else { await release(`client pid ${clientPid} exited`); process.exit(0); }
    }
    try {
      if (mode === 'lease') {
        const r = await rpc(broker, 'pilot', { action: 'renew', agent, lease_id: leaseId });
        if (r.renewed) continue;
        if (!r.reclaim) { log(`renewal refused for good: ${r.why ?? r.error} -- stopping without releasing`); process.exit(1); }
        const c = await claim();
        log(c.error ? `re-claim of ${agent} refused: ${c.error}` : `re-claimed ${agent} after: ${r.why}`);
      } else {
        // Anchored: a broker restart drops the claim along with its pid, so claim again on the new one.
        const hh = await health(broker);
        if (hh.pid !== anchorPid) {
          const c = await claim();
          log(c.error ? `broker restarted; re-claim refused: ${c.error}` : `broker restarted; re-claimed ${agent} (${mode})`);
        }
      }
    } catch (e) { log(`broker unreachable (${e.message}) -- will keep trying while the client runs`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'hold') await hold();
  else { console.error('usage: m59-remote-pilot.mjs hold --broker <url> --agent <agent> [...]'); process.exit(2); }
}
