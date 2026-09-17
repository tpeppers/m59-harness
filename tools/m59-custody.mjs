#!/usr/bin/env node
// WHO IS HOLDING THE FLEET RIGHT NOW — a lease, so two machines can share it safely.
//
//   node tools/m59-custody.mjs status            # who holds it, and for how much longer
//   node tools/m59-custody.mjs watch             # the daemon: hold it, or stand by for it
//   node tools/m59-custody.mjs claim             # take it now (if it is free)
//   node tools/m59-custody.mjs release           # hand it over deliberately
//   node tools/m59-custody.mjs watch --standby-only   # never take over, only observe
//
// PROBABLY NOT THE TOOL YOU WANT. READ THIS FIRST.
//
// This solves "two machines each want to BE the fleet's home, one at a time". It needs a
// git remote, credentials on both machines, and somebody who knows what a rebase is — and
// it was rejected for the ordinary case for exactly that reason: it does not just work for
// somebody who is not a computer person.
//
// THE ORDINARY CASE IS `m59-lend.mjs`, AND IT NEEDS NO LOCK AT ALL. Keep the broker at
// home, permanently, holding the roster and the sockets; drive it from wherever you are
// through the lend door. "Who holds the fleet" never becomes a question, so there is
// nothing to arbitrate — and when the remote machine goes quiet the faculty lease simply
// lapses and the keeper resumes. No store, no push, no second copy of anything.
//
// Reach for THIS only when the fleet genuinely has to change homes: a machine being
// retired, or a home connection that will be down long enough that driving through it is
// not an option.
//
// THE PROBLEM THIS EXISTS FOR, AND WHY POLITENESS CANNOT SOLVE IT.
//
// Meridian allows ONE CONNECTION PER CHARACTER and has no notion of who owns an account.
// Whoever logs in last wins, silently, and the loser's session simply closes — so two
// machines that both believe they hold the fleet do not deadlock or error. They bump each
// other, for ever, and each one's rejoin sweep reads the other's takeover as "the fleet
// dropped, rejoin it". The fleet then spends its whole life logging in. Measured on this
// setup: 21 claimed sessions against 13 live sockets, six characters the board listed as
// present that `status` said were not in game, and neither machine reporting an error.
//
// THERE IS NOTHING TO ASK. No server-side lock, no "who has this" bit, and the only
// observation available — the who list — requires logging in, which is itself the bump.
// So the arbitration has to live outside the game, and both machines have to agree to be
// bound by it before they connect.
//
// THE LEASE. One file in the private repository, which both machines already have
// authenticated access to. A holder writes its name and an expiry and renews on a timer;
// a standby reads it and does nothing until it lapses. `git push` is the compare-and-swap
// that makes it a real lock rather than a suggestion: two machines claiming at once
// produce one accepted push and one rejection, and the rejected one re-reads and yields.
//
// THE RULE THAT MAKES IT SAFE IS THE UNCOMFORTABLE ONE: a holder that cannot RENEW must
// stop the broker, even though nothing is visibly wrong with it. Its lease will expire
// whether or not it can see the store, and the other machine will act on that expiry — so
// a holder that keeps playing through a network partition is precisely the double-holder
// this is built to prevent. Self-fencing on renew failure is not defensive coding; it is
// the property.
//
// The asymmetry is deliberate and runs the other way for the standby: it claims ONLY on a
// lease it has positively read as expired. Cannot reach the store means stand by, never
// take over. Both halves fail toward "nobody connects", because an idle fleet costs a few
// minutes of farming and a double-held one costs the afternoon.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import process from 'node:process';
import { fleetName } from './m59-fleetpath.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The private repository, beside this one. It is the only thing both machines can write.
const STORE = process.env.M59_CUSTODY_STORE || join(REPO, '..', 'm59-private');
const CUSTODY_DIR = join(STORE, 'custody');

// ---------------------------------------------------------------------------
// THE NUMBERS, AND WHY EACH IS WHAT IT IS.
// ---------------------------------------------------------------------------

// How long a lease is good for without a renewal. This is the WORST-CASE takeover delay
// when a machine vanishes without warning — the case the whole thing is for, since a
// laptop lid or a power cut runs no shutdown hook. Five minutes of an idle fleet is a
// cheap price for never double-holding; shorter starts making an ordinary network hiccup
// look like a death.
export const LEASE_MS = 5 * 60_000;

// Renew at a third of the lease, so two consecutive failures are survivable before the
// holder has to fence itself. A renewal that only happens at the last moment turns every
// transient git error into a handover.
export const RENEW_MS = LEASE_MS / 3;

// How long after expiry a standby waits before claiming. Long enough that a holder whose
// renewal was merely slow gets to win the race rather than being displaced mid-fight.
export const GRACE_MS = 30_000;

export const identity = () => `${hostname()}#${process.pid}`;
export const machine = () => hostname();

const leasePath = (fleet) => join(CUSTODY_DIR, `${fleet}.json`);

const git = (args, opts = {}) => execFileSync('git', args, { windowsHide: true,
  cwd: STORE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
}).trim();

// ---------------------------------------------------------------------------
// THE DECISION, AS A PURE FUNCTION.
//
// Kept separate from the git and the process control so it can be tested against a clock
// rather than against two machines and a network. Everything that decides whether this
// machine may connect to the game is in here.
// ---------------------------------------------------------------------------

/**
 * @param {object|null} lease  what the store says, or null if there is none
 * @param {string} me          this machine's identity
 * @param {number} now
 * @param {object} opts        { standbyOnly, storeReadable }
 * @returns {{action:'hold'|'renew'|'claim'|'standby'|'fence', why:string}}
 *
 *   hold     we hold it and the lease is comfortable — keep running
 *   renew    we hold it and the lease needs refreshing
 *   claim    it is free or expired past the grace — take it and start
 *   standby  somebody else holds it — do not connect
 *   fence    WE thought we held it but can no longer prove it — STOP THE BROKER
 */
export function decide(lease, me, now = Date.now(), opts = {}) {
  const { standbyOnly = false, storeReadable = true } = opts;

  // A HOLDER THAT CANNOT READ THE STORE MUST FENCE ITSELF. Its lease is expiring in real
  // time whatever it can see, and the other machine will act on that. This is the branch
  // that makes the whole scheme safe and it is the one that feels wrong to write.
  if (!storeReadable) {
    if (lease && lease.holder === me)
      return { action: 'fence', why: 'cannot reach the custody store to renew — the lease ' +
        'expires whether or not we can see it, so the other machine may already be taking over' };
    return { action: 'standby', why: 'cannot reach the custody store; never claim blind' };
  }

  const held = lease && lease.holder && !lease.released;
  const expired = held ? now >= lease.expires_at : true;

  if (held && lease.holder === me) {
    if (expired)
      // Ours, but we let it lapse. Do not assume it is still ours — somebody may have
      // taken it in the gap. Re-claim explicitly through the CAS.
      return { action: 'claim', why: 'our own lease lapsed; re-claiming through the store' };
    return now >= lease.expires_at - (LEASE_MS - RENEW_MS)
      ? { action: 'renew', why: 'ours, and due for renewal' }
      : { action: 'hold', why: `ours until ${new Date(lease.expires_at).toISOString().slice(11, 19)}` };
  }

  if (held && !expired)
    return { action: 'standby', why: `${lease.holder} holds it until ` +
      `${new Date(lease.expires_at).toISOString().slice(11, 19)}` };

  // Free, released, or expired.
  if (standbyOnly)
    return { action: 'standby', why: 'the lease is available but --standby-only was given' };

  if (held && expired && now < lease.expires_at + GRACE_MS)
    return { action: 'standby', why: 'lease just expired — waiting out the grace in case ' +
      'the holder is merely slow' };

  return { action: 'claim', why: !lease ? 'no lease exists'
    : lease.released ? `${lease.holder} released it`
    : `${lease.holder}'s lease expired ${Math.round((now - lease.expires_at) / 1000)}s ago` };
}

// ---------------------------------------------------------------------------
// THE STORE. git pull / write / commit / push, where the push IS the lock.
// ---------------------------------------------------------------------------

export function readLease(fleet, { pull = true } = {}) {
  try {
    if (pull) git(['pull', '--rebase', '--quiet']);
  } catch (e) {
    return { unreachable: true, why: e.message.split('\n')[0] };
  }
  const p = leasePath(fleet);
  if (!existsSync(p)) return { lease: null };
  try { return { lease: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch { return { lease: null }; }
}

/**
 * Write a lease and push. THE PUSH IS THE COMPARE-AND-SWAP: if the other machine claimed
 * between our pull and our push, git rejects the push as non-fast-forward and we report
 * that we lost, rather than overwriting somebody else's claim.
 */
export function writeLease(fleet, lease) {
  mkdirSync(CUSTODY_DIR, { recursive: true });
  writeFileSync(leasePath(fleet), JSON.stringify(lease, null, 2) + '\n');
  try {
    git(['add', `custody/${fleet}.json`]);
    git(['-c', 'core.autocrlf=false', 'commit', '--quiet', '-m',
         `custody: ${lease.released ? 'release' : 'hold'} ${fleet} by ${lease.holder}`]);
  } catch { /* nothing changed; still try to push in case a previous push failed */ }
  try {
    git(['push', '--quiet']);
    return { ok: true };
  } catch (e) {
    // Lost the race, or offline. Either way we do NOT hold it.
    try { git(['reset', '--hard', 'origin/HEAD', '--quiet']); } catch { /* best effort */ }
    return { ok: false, why: e.message.split('\n')[0] };
  }
}

export const makeLease = (fleet, me, now = Date.now()) => ({
  format: 'm59-custody/1',
  fleet, holder: me, machine: machine(), pid: process.pid,
  claimed_at: now, renewed_at: now, expires_at: now + LEASE_MS,
  released: false,
});

// ---------------------------------------------------------------------------
// PROCESS CONTROL. Deliberately narrow: this starts and stops the broker and nothing else.
// ---------------------------------------------------------------------------

const service = (verb, fleet) => {
  try {
    return execFileSync(process.execPath,
      [join(REPO, 'tools', 'm59-service.mjs'), verb, '--fleet', fleet],
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return `service ${verb} failed: ${String(e.stdout || e.message).slice(0, 200)}`; }
};

const brokerUp = async (port = 8901) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    return (await r.json())?.ok === true;
  } catch { return false; }
};

// ---------------------------------------------------------------------------

// IMPORTING THIS MUST NOT RUN IT. The test imports `decide` for the safety argument, and
// without this guard that import took a git lock, read the lease and printed a status
// report as a side effect — the same trap m59-broker.mjs carries, where importing the
// module resumes a fleet.
const IS_MAIN = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const has = (n) => argv.includes(n);
const FLEET = fleetName(argv);
const ME = identity();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function tick({ standbyOnly = false, apply = true } = {}) {
  const read = readLease(FLEET);
  const d = decide(read.lease ?? null, ME, Date.now(),
                   { standbyOnly, storeReadable: !read.unreachable });
  const up = await brokerUp();

  if (!apply) return { ...d, brokerUp: up, lease: read.lease ?? null };

  switch (d.action) {
    case 'hold':
      // Holding the lease is not the same as running. If the broker died under us, bring
      // it back — that is the other half of "seamless".
      if (!up) { log(`holding the lease but the broker is down — starting it`); service('start', FLEET); }
      break;
    case 'renew': {
      const l = makeLease(FLEET, ME);
      l.claimed_at = read.lease?.claimed_at ?? l.claimed_at;
      const w = writeLease(FLEET, l);
      if (!w.ok) { log(`RENEW LOST (${w.why}) — fencing`); if (up) service('stop', FLEET); }
      else if (!up) { log('renewed; broker was down, starting'); service('start', FLEET); }
      break;
    }
    case 'claim': {
      const w = writeLease(FLEET, makeLease(FLEET, ME));
      if (!w.ok) { log(`claim lost to another machine (${w.why}) — standing by`); if (up) service('stop', FLEET); break; }
      log(`CLAIMED ${FLEET} — ${d.why}`);
      if (!up) log(service('start', FLEET).split('\n').filter(Boolean).slice(0, 3).join(' | '));
      break;
    }
    case 'standby':
      if (up) { log(`standing by (${d.why}) — stopping our broker`); service('stop', FLEET); }
      break;
    case 'fence':
      log(`FENCING: ${d.why}`);
      if (up) service('stop', FLEET);
      break;
  }
  return { ...d, brokerUp: up };
}

if (!IS_MAIN) {
  // imported for its pure parts; do nothing
} else if (cmd === 'status') {
  const read = readLease(FLEET);
  const d = decide(read.lease ?? null, ME, Date.now(), { storeReadable: !read.unreachable });
  console.log(`fleet   ${FLEET}`);
  console.log(`me      ${ME}`);
  console.log(`store   ${STORE}${read.unreachable ? `  UNREACHABLE (${read.why})` : ''}`);
  if (read.lease) {
    const l = read.lease;
    const left = Math.round((l.expires_at - Date.now()) / 1000);
    console.log(`holder  ${l.holder}${l.holder === ME ? '  (us)' : ''}${l.released ? '  RELEASED' : ''}`);
    console.log(`expires ${new Date(l.expires_at).toISOString().slice(11, 19)}Z  ` +
                `(${left > 0 ? left + 's left' : Math.abs(left) + 's ago'})`);
  } else console.log('holder  nobody');
  console.log(`broker  ${await brokerUp() ? 'up here' : 'down here'}`);
  console.log(`\nwould: ${d.action} — ${d.why}`);

} else if (cmd === 'claim' || cmd === 'release' || cmd === 'once') {
  if (cmd === 'release') {
    const read = readLease(FLEET);
    if (read.lease?.holder !== ME && !has('--force')) {
      console.error(`we do not hold ${FLEET} (${read.lease?.holder ?? 'nobody'} does). --force to write anyway.`);
      process.exit(2);
    }
    if (await brokerUp()) { console.log(service('stop', FLEET).split('\n')[0]); }
    const w = writeLease(FLEET, { ...(read.lease ?? makeLease(FLEET, ME)),
                                  released: true, released_at: Date.now(), holder: ME });
    console.log(w.ok ? `released ${FLEET} — the other machine may take it` : `release push failed: ${w.why}`);
  } else {
    console.log(JSON.stringify(await tick({ standbyOnly: has('--standby-only') }), null, 2));
  }

} else if (cmd === 'watch') {
  const standbyOnly = has('--standby-only');
  console.log(`custody watch: fleet ${FLEET}, me ${ME}`);
  console.log(`  lease ${LEASE_MS / 60000}min, renew every ${Math.round(RENEW_MS / 1000)}s, ` +
              `grace ${GRACE_MS / 1000}s${standbyOnly ? ', STANDBY ONLY' : ''}`);
  console.log('  a machine that cannot renew stops its own broker. Ctrl-C to stop watching.\n');
  // Release on the way out, so a deliberate shutdown hands over in seconds rather than
  // making the other machine wait out the whole lease.
  let stopping = false;
  const bye = async () => {
    if (stopping) return; stopping = true;
    try {
      const read = readLease(FLEET, { pull: false });
      if (read.lease?.holder === ME) {
        log('releasing the lease on the way out');
        if (await brokerUp()) service('stop', FLEET);
        writeLease(FLEET, { ...read.lease, released: true, released_at: Date.now() });
      }
    } catch { /* best effort — the lease expires on its own */ }
    process.exit(0);
  };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  for (;;) {
    try { const r = await tick({ standbyOnly }); log(`${r.action}: ${r.why}`); }
    catch (e) { log(`tick failed: ${e.message}`); }
    await new Promise(r => setTimeout(r, RENEW_MS));
  }

} else {
  console.error(`unknown command "${cmd}". Try: status | watch | claim | release | once`);
  process.exit(2);
}
