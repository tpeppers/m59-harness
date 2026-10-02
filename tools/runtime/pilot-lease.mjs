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
 * Renew in place. Refused for a pid claim, an unknown lease id, or one that has already lapsed.
 *
 * `ended` is what the broker remembers about THIS lease id having ended (createLeaseGraveyard):
 * released by its holder, by request, by an operator, by lapsing, or by being superseded. An
 * ended lease is never renewed and never answered `reclaim: true` -- the holder must stop, and
 * holding the character again takes an explicit claim. Prod, 2026-10-02: `pilot release hk3` was
 * answered by the Deck's next heartbeat re-claiming Raphael within seconds, because a released
 * claim left no record, "no record" read as "the broker restarted", and that case says claim
 * again. Only a lease the broker has NO memory of -- a genuine restart -- may still say reclaim.
 */
export function renewPilotLease(p, { id, now, ms = null, ended = null }) {
  const live = !!p?.lease && p.lease.id === id && now < p.lease.until;
  if (!live && ended) return { renewed: false, released: true, reclaim: false,
                               why: `that lease ended: ${ended.why}` };
  if (!p) return { renewed: false, why: 'not claimed', reclaim: true };
  if (!p.lease) return { renewed: false, why: 'claimed by a local client pid, not by a lease', reclaim: false };
  if (p.lease.id !== id) return { renewed: false, why: 'a different lease holds this character', reclaim: false };
  // A lapse is an END, the same as a release: the pilot watch is releasing it (or already has),
  // and the keeper may be back. A late heartbeat neither resurrects it nor re-claims.
  if (now >= p.lease.until) return { renewed: false, released: true, reclaim: false,
                                     why: 'the lease already lapsed' };
  if (ms != null) p.lease.ms = ms;
  p.lease.until = now + p.lease.ms;
  p.lease.renewed = now;
  return { renewed: true, until: p.lease.until };
}

// HOW LONG THE BROKER REMEMBERS THAT A LEASE ENDED. Longer than any heartbeat gap worth
// worrying about: a Deck that slept through a release and wakes hours later must still be told
// "released", not "not claimed" -- the second one is what makes a holder claim again.
export const PILOT_TOMBSTONE_MS = 6 * 60 * 60_000;
const TOMBSTONES_PER_AGENT = 8;

/**
 * The record of leases that have ENDED, per agent: lease id -> { why, at, holder }. Bounded by
 * age and by count, so it cannot grow without limit on a broker that runs for weeks. It is in
 * memory on purpose: a broker restart forgets it, and "not claimed, reclaim" is then the truth.
 */
export function createLeaseGraveyard({ ttlMs = PILOT_TOMBSTONE_MS, perAgent = TOMBSTONES_PER_AGENT } = {}) {
  const graves = new Map();     // agent -> Map(id -> { why, at, holder })
  const prune = (agent, now) => {
    const g = graves.get(agent);
    if (!g) return null;
    for (const [id, t] of g) if (now - t.at > ttlMs) g.delete(id);
    while (g.size > perAgent) g.delete(g.keys().next().value);
    if (!g.size) { graves.delete(agent); return null; }
    return g;
  };
  return {
    /** Remember that `lease` (of `agent`) ended, and why. A pid claim has no lease: nothing to bury. */
    bury(agent, lease, why, now) {
      if (!lease?.id) return;
      const g = graves.get(agent) ?? new Map();
      g.delete(lease.id);
      g.set(lease.id, { why: String(why ?? 'ended'), at: now, holder: lease.holder ?? null });
      graves.set(agent, g);
      prune(agent, now);
    },
    /** The ending of this lease id, or null if the broker has no memory of it ending. */
    find(agent, id, now) {
      if (id == null) return null;
      return prune(agent, now)?.get(id) ?? null;
    },
  };
}

/**
 * A CLAIM THAT NAMES A LEASE ID is asking to continue that lease, and an ended lease is not
 * continued -- not by a renewal, and not by a claim either. Returns a refusal, or null when the
 * claim may proceed: no lease id at all (a fresh, explicit claim), or the id of the one live lease.
 */
export function claimLeaseRefusal(p, { leaseId, ended, now }) {
  if (leaseId == null || leaseId === '') return null;
  if (p?.lease && p.lease.id === leaseId && now < p.lease.until) return null;
  return { error: `lease ${leaseId} ${ended ? `ended: ${ended.why}` : 'is not a live lease on this character'}` +
                  ' -- claim WITHOUT a lease_id to hold it again', released: true, reclaim: false };
}

/** The fields `pilot status` adds for a lease, so "who is holding Kermit, from where" has an answer. */
export function describePilotLease(p, now) {
  if (!p?.lease) return { binding: 'pid' };
  return { binding: 'lease', holder: p.lease.holder, lease_id: p.lease.id,
           expires_in_s: Math.max(0, Math.round((p.lease.until - now) / 1000)),
           last_heartbeat_s: Math.round((now - p.lease.renewed) / 1000) };
}
