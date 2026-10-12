// Offline guard for SMOOTH HANDOFFS between a fleetscript's walks (Session.startJob's same-issuer supersede,
// Autopilot.travelRestAtSanctuary). Opens no socket.
//
//   node tools/m59-walk-handoff-test.mjs
//
// Operator, 2026-10-12: "make it so these handoffs can be smoothly done". Twice that day a fleetscript run
// was refused by its OWN previous walk -- Zheng He "is busy: walk to South Barloque (ordered by
// fleetscript:entroot-supply ...)" -- because the arrived journey's job was still open: the last hop into a
// town room started a sanctuary rest of up to four minutes that ignored cancel_movement. Pinned: a cancelled
// job is superseded by the same issuer and still refuses anybody else; the sanctuary rest is skipped on the
// last hop and cancellable on every other.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from './m59-game.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

function session(job) {
  const s = Object.create(Session.prototype);
  s.name = 'hk2'; s.combat = null; s.job = job; s.movementGeneration = 5;
  s.runCommand = fn => Promise.resolve().then(fn);
  return s;
}
const RUN = { source: 'fleetscript', name: 'entroot-supply (local)', run_id: 'mv4rtad8-32312' };
const OTHER = { source: 'keeper', name: 'shelter' };

await ok('a cancelled job is superseded by a new one from the SAME issuer', async () => {
  const old = { kind: 'travel', label: 'walk to South Barloque', done: false, cancelled: true, origin: RUN };
  const s = session(old);
  const job = s.startJob('travel', 'walk to North Barloque', async () => 'ok', { origin: RUN });
  assert.equal(old.superseded, true);
  assert.equal(old.done, true);
  assert.equal(s.job, job);
  await job.promise.catch(() => {});
});

await ok('...but not one still running, and never by somebody else', () => {
  const running = { kind: 'travel', label: 'walk to South Barloque', done: false, origin: RUN };
  assert.throws(() => session(running).startJob('travel', 'walk to 101', async () => 1, { origin: RUN }), /is busy: walk to South Barloque/);
  const cancelled = { kind: 'travel', label: 'walk to South Barloque', done: false, cancelled: true, origin: RUN };
  assert.throws(() => session(cancelled).startJob('travel', 'walk to 101', async () => 1, { origin: OTHER }), /is busy/);
  assert.throws(() => session(cancelled).startJob('travel', 'walk to 101', async () => 1, {}), /is busy/, 'no origin, no claim');
});

await ok('the sanctuary rest: not on the last hop, and cancellable', () => {
  const t = AUTOPILOT.slice(AUTOPILOT.indexOf('  async travelRestAtSanctuary(at, arm) {'));
  const body = t.slice(0, t.indexOf('\n  }\n'));
  assert.ok(body.includes('if (at && at.remaining === 0) return;'));
  assert.ok(body.includes('shouldCancel: () => !!(this.travelInterrupted?.() || this.s.movementWasCancelled?.(restGeneration)),'));
});

console.log(`\n${n} passed`);
