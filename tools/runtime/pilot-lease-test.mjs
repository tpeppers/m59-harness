// Offline guard for tools/runtime/pilot-lease.mjs: a remote pilot claim is held by a heartbeat
// and lapses by itself, and a local pid claim is judged exactly as it always was.
//
//   node tools/runtime/pilot-lease-test.mjs
import assert from 'node:assert/strict';
import {
  PILOT_LEASE_DEFAULT_MS, PILOT_LEASE_MIN_MS, PILOT_LEASE_MAX_MS,
  pilotLeaseMs, newPilotLease, pilotHeld, renewPilotLease, describePilotLease,
  createLeaseGraveyard, claimLeaseRefusal, PILOT_TOMBSTONE_MS,
} from './pilot-lease.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };
const dead = () => false, alive = () => true;

ok('lease length: silence is the default, out-of-range and non-numbers are refused', () => {
  assert.equal(pilotLeaseMs(undefined), PILOT_LEASE_DEFAULT_MS);
  assert.equal(pilotLeaseMs(PILOT_LEASE_MIN_MS), PILOT_LEASE_MIN_MS);
  assert.throws(() => pilotLeaseMs(0), /lease_ms/, 'zero is not "no lease"');
  assert.throws(() => pilotLeaseMs(PILOT_LEASE_MAX_MS + 1));
  assert.throws(() => pilotLeaseMs('soon'));
});

ok('a lease needs a holder, because "who is playing Kermit" must have an answer', () => {
  assert.throws(() => newPilotLease({ holder: ' ', ms: 60_000, now: 0 }), /holder/);
  const l = newPilotLease({ holder: 'steamdeck m59-tui', ms: 60_000, now: 1000 });
  assert.equal(l.until, 61_000);
  assert.ok(l.id.length >= 10);
});

ok('a lease is judged by the clock and NEVER by a pid -- a Deck pid means nothing here', () => {
  const p = { pid: null, lease: newPilotLease({ holder: 'deck', ms: 30_000, now: 0 }) };
  // pidAlive would throw on null in the broker's real check; it must not even be asked.
  const ask = () => { throw new Error('pidAlive consulted for a lease claim'); };
  assert.equal(pilotHeld(p, { now: 29_999, pidAlive: ask }).held, true);
  const lapsed = pilotHeld(p, { now: 30_000, pidAlive: ask });
  assert.equal(lapsed.held, false);
  assert.match(lapsed.why, /no heartbeat from deck for 30s/);
});

ok('a pid claim is unchanged: alive while the pid is', () => {
  assert.equal(pilotHeld({ pid: 42 }, { now: 0, pidAlive: alive }).held, true);
  assert.match(pilotHeld({ pid: 42 }, { now: 0, pidAlive: dead }).why, /client pid 42 exited/);
  assert.equal(pilotHeld(null, { now: 0, pidAlive: alive }).held, false);
});

ok('renewal extends from NOW, and only for the lease that holds the character', () => {
  const p = { pid: null, lease: newPilotLease({ holder: 'deck', ms: 30_000, now: 0 }) };
  const r = renewPilotLease(p, { id: p.lease.id, now: 20_000 });
  assert.equal(r.renewed, true);
  assert.equal(p.lease.until, 50_000);
  assert.equal(pilotHeld(p, { now: 45_000, pidAlive: dead }).held, true, 'held past the first lease');
  const stranger = renewPilotLease(p, { id: 'someone-else', now: 21_000 });
  assert.equal(stranger.renewed, false);
  assert.equal(stranger.reclaim, false, 'a second machine must not take over by renewing');
});

ok('a lapsed lease is not resurrected by a late heartbeat, and the holder is told to STOP', () => {
  const p = { pid: null, lease: newPilotLease({ holder: 'deck', ms: 30_000, now: 0 }) };
  const r = renewPilotLease(p, { id: p.lease.id, now: 30_000 });
  assert.equal(r.renewed, false);
  assert.equal(r.released, true);
  assert.equal(r.reclaim, false, 'a lapse is an end, not an invitation to claim again');
  assert.equal(p.lease.until, 30_000, 'not extended');
});

ok('a broker with NO memory of the lease (it restarted) still says reclaim', () => {
  const r = renewPilotLease(undefined, { id: 'x', now: 0, ended: createLeaseGraveyard().find('t1', 'x', 0) });
  assert.equal(r.reclaim, true, 'broker restarted: claim again');
  assert.notEqual(r.released, true);
});

// The broker's sequence, with the broker's own pieces: `piloted` is a Map, releasePilot deletes the
// entry and buries the lease, `renew` passes the graveyard's answer to renewPilotLease. (Importing
// m59-broker.mjs runs it, so the wiring itself is pinned by the source check below.)
function brokerModel() {
  const piloted = new Map(), graves = createLeaseGraveyard();
  return {
    piloted, graves,
    claim(agent, holder, now) {
      const prior = piloted.get(agent);
      const lease = newPilotLease({ holder, ms: 60_000, now });
      if (prior?.lease) graves.bury(agent, prior.lease, `superseded by a newer claim from ${holder}`, now);
      piloted.set(agent, { pid: null, lease });
      return lease.id;
    },
    release(agent, why, now) {
      const p = piloted.get(agent);
      if (!p) return false;
      piloted.delete(agent);
      if (p.lease) graves.bury(agent, p.lease, why, now);
      return true;
    },
    watch(now) {
      for (const [agent, p] of [...piloted]) {
        const h = pilotHeld(p, { now, pidAlive: dead });
        if (!h.held) this.release(agent, h.why, now);
      }
    },
    renew(agent, id, now) {
      return renewPilotLease(piloted.get(agent), { id, now, ended: graves.find(agent, id, now) });
    },
  };
}

ok('(a) claim, RELEASE BY REQUEST, heartbeat with the old lease_id: refused as released, never reclaim', () => {
  const b = brokerModel();
  const id = b.claim('hk3', 'steamdeck m59-tui', 0);
  assert.equal(b.renew('hk3', id, 10_000).renewed, true);
  assert.ok(b.release('hk3', 'released by request', 12_000));
  const r = b.renew('hk3', id, 20_000);
  assert.equal(r.renewed, false);
  assert.equal(r.released, true, 'the client can recognise it');
  assert.equal(r.reclaim, false, 'Raphael, 2026-10-02: this said reclaim:true and the Deck re-claimed him');
  assert.match(r.why, /released by request/);
  assert.equal(b.piloted.has('hk3'), false, 'not re-claimed');
  // ...and it keeps saying so, however late the next one arrives.
  assert.equal(b.renew('hk3', id, 3 * 60 * 60_000).reclaim, false);
});

ok('(a) a released lease named on a CLAIM is not revived either; a claim without one is explicit and works', () => {
  const b = brokerModel();
  const id = b.claim('hk3', 'deck', 0);
  b.release('hk3', 'released by an operator', 1000);
  const ref = claimLeaseRefusal(b.piloted.get('hk3'), { leaseId: id, now: 2000, ended: b.graves.find('hk3', id, 2000) });
  assert.equal(ref?.released, true);
  assert.match(ref.error, /ended: released by an operator/);
  assert.equal(claimLeaseRefusal(undefined, { leaseId: undefined, now: 2000, ended: null }), null, 'a fresh claim is allowed');
  const live = b.claim('hk3', 'deck', 3000);
  assert.equal(claimLeaseRefusal(b.piloted.get('hk3'), { leaseId: live, now: 4000, ended: null }), null,
               'naming the LIVE lease is a no-op continuation, not a refusal');
});

ok('(b) a lease that EXPIRED is not revived by a heartbeat after the watch released it', () => {
  const b = brokerModel();
  const id = b.claim('hk3', 'deck', 0);
  b.watch(61_000);                                   // the pilot watch notices the lapse
  assert.equal(b.piloted.has('hk3'), false);
  const r = b.renew('hk3', id, 62_000);
  assert.equal(r.renewed, false);
  assert.equal(r.released, true);
  assert.equal(r.reclaim, false);
  assert.match(r.why, /lapsed/);
  assert.equal(b.piloted.has('hk3'), false, 'not revived');
});

ok('a superseded lease is told it ended; the newer one renews; releasing one character leaves the other', () => {
  const b = brokerModel();
  const old = b.claim('hk3', 'deck', 0);
  const now = b.claim('hk3', 'deck', 1000);
  const kermit = b.claim('t1', 'deck', 1000);
  assert.equal(b.renew('hk3', old, 2000).released, true);
  assert.equal(b.renew('hk3', now, 2000).renewed, true);
  b.release('hk3', 'released by deck', 3000);
  assert.equal(b.renew('t1', kermit, 4000).renewed, true, 'the other character is untouched');
  assert.equal(b.renew('hk3', now, 4000).released, true);
});

ok('the graveyard is bounded by age and by count', () => {
  const g = createLeaseGraveyard({ ttlMs: 1000, perAgent: 2 });
  g.bury('a', { id: 'x' }, 'one', 0);
  assert.equal(g.find('a', 'x', 999)?.why, 'one');
  assert.equal(g.find('a', 'x', 1001), null, 'aged out');
  g.bury('a', { id: '1' }, 'w', 0); g.bury('a', { id: '2' }, 'w', 0); g.bury('a', { id: '3' }, 'w', 0);
  assert.equal(g.find('a', '1', 0), null, 'oldest dropped past the count');
  assert.ok(g.find('a', '3', 0));
  g.bury('a', null, 'pid claim', 0);                 // nothing to bury, and no throw
  assert.equal(PILOT_TOMBSTONE_MS >= 60 * 60_000, true, 'remembers for hours, not a lease length');
});

ok('the broker is wired to it: release buries, renew asks the graveyard, a claim names no dead lease', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'm59-broker.mjs'), 'utf8');
  const rel = src.slice(src.indexOf('function releasePilot('), src.indexOf('function releasePilot(') + 800);
  assert.match(rel, /pilotGraveyard\.bury\(agent, p\.lease/, 'releasePilot remembers every ended lease');
  assert.match(src, /renewPilotLease\(piloted\.get\(a\.agent\),[\s\S]{0,200}ended: pilotGraveyard\.find\(a\.agent, a\.lease_id/,
               'renew passes what the broker remembers');
  assert.match(src, /claimLeaseRefusal\(held,/, 'a lease claim checks a named lease_id');
});

ok('a pid claim cannot be renewed into a lease', () => {
  const r = renewPilotLease({ pid: 42 }, { id: 'x', now: 0 });
  assert.equal(r.renewed, false);
  assert.equal(r.reclaim, false);
});

ok('status says which binding holds a character, and for how long', () => {
  assert.deepEqual(describePilotLease({ pid: 42 }, 0), { binding: 'pid' });
  const p = { lease: newPilotLease({ holder: 'deck', ms: 60_000, now: 0 }) };
  const d = describePilotLease(p, 15_000);
  assert.equal(d.binding, 'lease');
  assert.equal(d.expires_in_s, 45);
  assert.equal(d.last_heartbeat_s, 15);
});

console.log(`\n${n} passed`);
