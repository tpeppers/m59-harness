// A PILOT CLAIM HELD BY A HEARTBEAT, FOR A CLIENT ON ANOTHER MACHINE.
//
// The broker's pilot claim is bound to a local process id: a client this machine spawned, still
// running, holding the only session the server permits for that character. That is the right
// proof on the machine the client runs on, and no proof at all from anywhere else -- a Steam
// Deck's pid means nothing to `process.kill(pid, 0)` on Vecna, so the claim was either refused or,
// worse, bound to whatever unrelated process happened to have that number.
//
// So a remote claim is bound to TIME instead. The machine that owns the client says "still here"
// every few seconds (tools/m59-remote-pilot.mjs does it), and the claim ends by itself when it
// stops hearing that. Failing that way round is the point: a Deck that sleeps, a TUI that is
// killed, or a tailnet that drops hands the character back to its keeper within one lease,
// rather than leaving it parked with nobody driving it -- the failure the pid binding exists to
// prevent, arriving by a different door.
//
// WHO MAY TAKE ONE. Whoever may reach the broker's control API, which is loopback -- and the
// operator gateway (tools/m59-operator-gateway.mjs), which admits only listed tailnet addresses
// and forwards to loopback. WireGuard is the identity (operator decision, 2026-10-01); there is
// deliberately no token here, because it would guard a door the gateway already guards.
//
// Pure: no clock, no process table. The broker passes both in, so this can be tested offline.
import { randomBytes } from 'node:crypto';

export const PILOT_LEASE_MIN_MS = 15_000;
export const PILOT_LEASE_MAX_MS = 300_000;
export const PILOT_LEASE_DEFAULT_MS = 60_000;

/** A lease length the broker will honour, or a thrown reason. Silence is the default, never 0. */
export function pilotLeaseMs(value) {
  if (value == null || value === true) return PILOT_LEASE_DEFAULT_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new RangeError(`lease_ms must be a number of milliseconds, not ${JSON.stringify(value)}`);
  if (ms < PILOT_LEASE_MIN_MS || ms > PILOT_LEASE_MAX_MS)
    throw new RangeError(`lease_ms must be ${PILOT_LEASE_MIN_MS}-${PILOT_LEASE_MAX_MS}; got ${ms}`);
  return Math.round(ms);
}

/** The lease half of a pilot entry. `holder` is free text for the log: which machine, which tool. */
export function newPilotLease({ holder, ms, now }) {
  const h = String(holder ?? '').trim();
  if (!h) throw new Error('holder is required for a lease claim -- say which machine is playing');
  return { id: randomBytes(9).toString('base64url'), holder: h.slice(0, 120), ms, until: now + ms, renewed: now };
}

/**
 * Is this claim still held? Exactly one of the two bindings applies: a lease is judged by the
 * clock and never by a pid, and a pid claim is judged as it always was.
 * Returns { held, why } -- `why` is the sentence the broker logs when it releases.
 */
export function pilotHeld(p, { now, pidAlive }) {
  if (!p) return { held: false, why: 'not claimed' };
  if (p.lease) {
    if (now < p.lease.until) return { held: true, why: null };
    const quiet = Math.round((now - p.lease.renewed) / 1000);
    return { held: false, why: `no heartbeat from ${p.lease.holder} for ${quiet}s -- the remote lease lapsed` };
  }
  if (pidAlive(p.pid)) return { held: true, why: null };
  return { held: false, why: `client pid ${p.pid} exited` };
}

/**
 * Renew in place. Refused for a pid claim, an unknown lease id, or one that has already lapsed --
 * a lapsed lease has been (or is about to be) released, and the keeper may already be back, so
 * the holder must CLAIM again rather than quietly resurrect it.
 */
export function renewPilotLease(p, { id, now, ms = null }) {
  if (!p) return { renewed: false, why: 'not claimed', reclaim: true };
  if (!p.lease) return { renewed: false, why: 'claimed by a local client pid, not by a lease', reclaim: false };
  if (p.lease.id !== id) return { renewed: false, why: 'a different lease holds this character', reclaim: false };
  if (now >= p.lease.until) return { renewed: false, why: 'the lease already lapsed', reclaim: true };
  if (ms != null) p.lease.ms = ms;
  p.lease.until = now + p.lease.ms;
  p.lease.renewed = now;
  return { renewed: true, until: p.lease.until };
}

/** The fields `pilot status` adds for a lease, so "who is holding Kermit, from where" has an answer. */
export function describePilotLease(p, now) {
  if (!p?.lease) return { binding: 'pid' };
  return { binding: 'lease', holder: p.lease.holder, lease_id: p.lease.id,
           expires_in_s: Math.max(0, Math.round((p.lease.until - now) / 1000)),
           last_heartbeat_s: Math.round((now - p.lease.renewed) / 1000) };
}
