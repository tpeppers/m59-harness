// Offline guard for tools/runtime/pilot-lease.mjs: a remote pilot claim is held by a heartbeat
// and lapses by itself, and a local pid claim is judged exactly as it always was.
//
//   node tools/runtime/pilot-lease-test.mjs
import assert from 'node:assert/strict';
import {
  PILOT_LEASE_DEFAULT_MS, PILOT_LEASE_MIN_MS, PILOT_LEASE_MAX_MS,
  pilotLeaseMs, newPilotLease, pilotHeld, renewPilotLease, describePilotLease,
} from './pilot-lease.mjs';

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

ok('a lapsed lease is not resurrected by a late heartbeat -- the holder claims again', () => {
  const p = { pid: null, lease: newPilotLease({ holder: 'deck', ms: 30_000, now: 0 }) };
  const r = renewPilotLease(p, { id: p.lease.id, now: 30_000 });
  assert.equal(r.renewed, false);
  assert.equal(r.reclaim, true);
  assert.equal(renewPilotLease(undefined, { id: 'x', now: 0 }).reclaim, true, 'broker restarted: claim again');
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
