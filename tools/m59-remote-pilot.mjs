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
//   4. release when it exits, or when this process is told to stop;
//   5. STOP -- without releasing, and without claiming again -- the moment the broker says the
//      lease ended: released by request or by an operator, lapsed, or superseded by a newer
//      claim. Only a broker that RESTARTED (a different pid, no memory of the lease) is claimed
//      again. Raphael, 2026-10-02: a hand release was undone by the next heartbeat.
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

/**
 * THE HOLD, for one character. Everything with a side effect is a dependency, so the offline test
 * drives the real loop in-process: `rpc(name, args, ms)`, `health()`, `findClient(account)`,
 * `pidAlive(pid)`, `sleep(ms)`, `now()`, `log(...)`. Resolves { code, why } when it stops; the CLI
 * exits with `code`. `stop(why)` (for a signal) releases and ends the loop.
 *
 * WHEN IT STOPS HEARTBEATING. Raphael (hk3), 2026-10-02: `pilot release` by hand was undone by
 * this loop's next beat, because the broker answered a released lease with `reclaim: true` and
 * this loop obeyed it. Now: a reply that says the lease ended stops the loop for good, re-claiming
 * is reserved for a broker that has NO memory of the lease (it restarted), and a re-claim that
 * itself comes back refused or released stops it as well. Holding the character again after a
 * release is a deliberate act -- press L again -- never a heartbeat's side effect.
 */
export function createHold({ agent, account = agent, holder, leaseMs = 60_000, waitMs = 180_000, beat }, deps) {
  const { rpc, health, findClient, pidAlive, sleep, now = Date.now, log = () => {} } = deps;
  let mode = 'lease', leaseId = null, anchorPid = null;
  // The broker process our lease was granted by. "Not claimed, reclaim" means a RESTART only if
  // that process is gone; from the same process it means somebody released the character -- which
  // is all an older broker (no record of ended leases) can say, so this check is what keeps a
  // release a release against a broker that has not been rolled yet.
  let grantedBy = null;
  let stopping = false, finish = null;
  const ended = new Promise(r => { finish = r; });
  const end = (code, why) => { if (!stopping) stopping = true; finish({ code, why }); return { code, why }; };

  const claim = async () => {
    const pidNow = async () => { try { return (await health())?.pid ?? null; } catch { return null; } };
    const r = await rpc('pilot', { action: 'claim', agent, lease_ms: leaseMs, holder });
    if (!r.error) { mode = 'lease'; leaseId = r.lease_id; grantedBy = await pidNow(); return r; }
    if (!brokerLacksLeases(r)) return r;
    // An unrolled broker: anchor on its own pid. See the header for what that costs.
    const hh = await health();
    const a = await rpc('pilot', { action: 'claim', agent, pid: hh.pid });
    if (!a.error) { mode = 'anchored'; anchorPid = hh.pid; leaseId = null; }
    return a;
  };
  const release = async (why) => {
    try {
      const r = await rpc('pilot', { action: 'release', agent, ...(leaseId ? { lease_id: leaseId } : {}) }, 8000);
      log(`released ${agent} (${why}): ${r.error ?? (r.released ? 'ok' : r.note)}`);
    } catch (e) {
      log(`release of ${agent} FAILED (${why}): ${e.message}` +
          (mode === 'lease' ? ' -- the lease lapses on its own' : ' -- ANCHORED: run `pilot release` for it by hand'));
    }
  };

  async function run() {
    const first = await claim();
    if (first.error) { log(`claim of ${agent} refused: ${first.error}`); return end(1, 'claim refused'); }
    log(mode === 'lease'
      ? `claimed ${agent} by lease ${leaseId} (${leaseMs / 1000}s, renewed every ${beat / 1000}s) for ${holder}`
      : `claimed ${agent} ANCHORED on broker pid ${anchorPid} -- that broker predates leases, so ` +
        'this claim does not expire: if this process is killed, `pilot release` it by hand');

    const started = now();
    let clientPid = null;
    for (;;) {
      await sleep(beat);
      if (stopping) return ended;
      // IS THE PERSON STILL HERE? Once seen, the pid is watched directly -- a signal 0, not a scan.
      if (clientPid == null) {
        const c = await Promise.resolve().then(() => findClient(account)).catch(() => null);
        if (c) { clientPid = c.pid; log(`client for ${account} is pid ${clientPid}`); }
        else if (now() - started > waitMs) {
          await release(`no client for ${account} appeared within ${Math.round(waitMs / 1000)}s`);
          return end(1, 'no client appeared');
        }
      } else if (!pidAlive(clientPid)) {
        // A Proton relaunch can hand the account to a new pid; look once before letting go.
        const again = await Promise.resolve().then(() => findClient(account)).catch(() => null);
        if (again && again.pid !== clientPid) { clientPid = again.pid; log(`client for ${account} is now pid ${clientPid}`); }
        else { await release(`client pid ${clientPid} exited`); return end(0, 'client exited'); }
      }
      if (stopping) return ended;
      try {
        if (mode === 'lease') {
          const r = await rpc('pilot', { action: 'renew', agent, lease_id: leaseId });
          if (r.renewed) continue;
          if (!r.error && r.reclaim === true && r.released !== true) {
            // The broker has no memory of this lease at all. If it is the SAME broker process that
            // granted it, the lease was released (an older broker cannot say so) -- stop.
            let pidThen = grantedBy, pidNowV = null;
            try { pidNowV = (await health())?.pid ?? null; } catch { /* cannot tell: treat as a restart */ }
            if (pidThen != null && pidNowV != null && pidThen === pidNowV) {
              log(`lease ended: ${r.why} by the same broker (pid ${pidNowV}) that granted it, so it was ` +
                  `released, not lost -- no longer holding ${agent}; stopping without releasing`);
              return end(0, 'released by the broker');
            }
            // It restarted. Claim again, once per beat.
            const c = await claim();
            if (c.error || c.released) {
              log(`re-claim of ${agent} refused: ${c.error ?? c.why} -- stopping without releasing`);
              return end(1, 're-claim refused');
            }
            log(`re-claimed ${agent} after: ${r.why}`);
            continue;
          }
          // Released by request, by an operator, by lapsing, or superseded by a newer claim: this
          // lease is OVER. Stop heartbeating, and do not release -- nothing of ours is left to end.
          log(`${r.released ? 'lease ended' : 'renewal refused for good'}: ${r.why ?? r.error} -- ` +
              `no longer holding ${agent}; stopping without releasing`);
          return end(r.released ? 0 : 1, r.released ? 'released by the broker' : 'renewal refused');
        } else {
          // Anchored: a broker restart drops the claim along with its pid, so claim again on the new one.
          const hh = await health();
          if (hh.pid !== anchorPid) {
            const c = await claim();
            log(c.error ? `broker restarted; re-claim refused: ${c.error}` : `broker restarted; re-claimed ${agent} (${mode})`);
          }
        }
      } catch (e) { log(`broker unreachable (${e.message}) -- will keep trying while the client runs`); }
    }
  }

  return {
    run,
    /** End the hold from outside (a signal): release our own lease, and stop beating. */
    async stop(why) {
      if (stopping) return ended;
      stopping = true;
      await release(why);
      return end(0, why);
    },
    get leaseId() { return leaseId; },
  };
}

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

  const held = createHold({ agent, account, holder, leaseMs, waitMs, beat }, {
    rpc: (name, args, ms) => rpc(broker, name, args, ms),
    health: () => health(broker),
    findClient: clientFor,
    pidAlive,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: (...m) => log(`[${broker}]`, ...m),
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
    await held.stop(`this holder got ${sig}`); process.exit(0);
  });
  const { code } = await held.run();
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cmd === 'hold') await hold();
  else { console.error('usage: m59-remote-pilot.mjs hold --broker <url> --agent <agent> [...]'); process.exit(2); }
}
