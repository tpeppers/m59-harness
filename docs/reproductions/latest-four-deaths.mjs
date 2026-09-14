// Offline reproductions of the September 14 death mechanisms. No game sockets.
// Run from the repository root: node docs/reproductions/latest-four-deaths.mjs
// These measure decisions/cancellation, not counterfactual lives saved.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const scratch = mkdtempSync(path.join(tmpdir(), 'm59-four-deaths-'));
for (const key of ['M59_EVIDENCE_DIR', 'M59_LEDGER_DIR']) process.env[key] = scratch;
process.env.M59_UPTIME_FILE = path.join(scratch, 'uptime.jsonl');
const { Autopilot } = await import('../../tools/m59-autopilot.mjs');
const { returnToSpot } = await import('../../tools/m59-skills.mjs');
const { RoomGeometry } = await import('../../tools/m59-roo.mjs');
const { nearestSafeSpot, safeWalls } = await import('../../tools/m59-safespots.mjs');
const { attachStepMasks } = await import('../../tools/m59-routes.mjs');
const { movementMapFile } = await import('../../tools/m59-map-path.mjs');
const results = { scope: 'offline production-method probes, not survival trials' };

// A cancellation returned by the first approach must not be mistaken for a
// geometric failure requiring a second, newly owned walk. Measure current behavior.
results.cancelledApproach = [];
for (const distance of [2, 12]) {
  const calls = [];
  const client = { self: { row: 10, col: 10 } };
  const session = { need: () => client, movementGeneration: 0 };
  const move = name => async (_col, _row, options) => {
    calls.push({ name, generation: session.movementGeneration, options });
    if (calls.length === 1) {
      session.movementGeneration++;
      return { arrived: false, cancelled: true, reason: 'watchdog cancelled this approach' };
    }
    return { arrived: false, reason: 'fallback also failed' };
  };
  session.walkTo = move('walkTo'); session.approachFine = move('approachFine');
  const outcome = await returnToSpot(session, { row: 10, col: 10 + distance });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].generation, 1);
  assert.equal(calls[1].options.movementGeneration, undefined);
  results.cancelledApproach.push({ distance, calls, outcome,
    finding: 'the cancelled first approach is followed by another movement call' });
}

// Call the actual watchdog with a pass blocked below the flee line. Other
// independently tested watchdog branches are held constant in this fixture.
results.blindWalkWatchdog = [];
for (const enabled of [false, true]) {
  const notes = [], cancels = [], now = Date.now();
  const k = Object.assign(Object.create(Autopilot.prototype), {
    policy: enabled ? { blindWalkWatchdog: true } : {}, passes: 9,
    passStartedAt: now - 37000, lastFrameAt: now, doing: 'travelling', tally: {},
    watch: { ticks: 0, frames: 0, interrupts: 0, longest_block_ms: 0,
      lastHealth: 20, lastPulseAt: now,
      pulses: [{ at: now, room: 39, row: 8, col: 18 }] },
    note: (what, detail) => notes.push({ what, detail }), progress() {},
    recordFrame() {}, checkFreeze: () => false, fightBackCheck() {}, clearPathCheck() {},
    facultyHeld: () => false, safety: () => ({ fleeAt: 0.68 }),
    s: { live: true, client: { state: 'game', vitals: () => ({ health: { value: 20, max: 50 } }) } },
  });
  k.s.cancelMovement = (_token, why) => { cancels.push(why); return { cancelled: true }; };
  k.watchdogTick();
  assert.equal(cancels.length, enabled ? 1 : 0);
  results.blindWalkWatchdog.push({ enabled, cancels, notes });
}

// The named forward refuge is only tested for existence, then discarded. Capture
// the actual arguments given to the second selector.
{
  let called;
  const notes = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    policy: {}, unreachableIn: () => new Set(), exitTest: () => null,
    s: { world: { room: { num: 598 } }, client: { vitals: () => ({ health: { value: 33, max: 50 } }) },
      activeShelter: { atStep: 0, maxDetour: 10,
        spots: [{ row: 51, col: 22, atStep: 5, detour: 5, proven: true }] } },
    note: (what, detail) => notes.push({ what, detail }),
    takeSafeSpot: async (...args) => { called = args; return { took: true }; },
  });
  const handled = await k.shelterForwardAndMend('reproduce forward recovery');
  assert.equal(handled, true);
  assert.ok(called);
  assert.deepEqual(called[2], { source: 'travel' });
  results.forwardSelection = { notes, actualSelectorArguments: called,
    finding: 'the announced row/col is not passed to takeSafeSpot' };
}

// Evaluate the same baked geometry used by this checkout, without live creatures,
// reservations, failed-approach exclusions, or an assertion that a wall was vacant.
const mapPath = movementMapFile();
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const geometries = new Map();
attachStepMasks(map, { geometryOf(room) {
  if (!geometries.has(room)) geometries.set(room, RoomGeometry.fromJSON(room.roo));
  return geometries.get(room);
} });
const summarize = spot => spot ? { row: spot.row, col: spot.col, kind: spot.kind ?? 'wall',
  steps_away: spot.steps_away, progress: spot.progress } : null;
results.geometry = [];
for (const spec of [
  { label: 'Janice', room: 597, from: { row: 23, col: 16 }, onward: { row: 50, col: 31 }, named: { row: 24, col: 18 } },
  { label: 'Floyd', room: 598, from: { row: 40, col: 23 }, onward: { row: 65, col: 19 }, named: { row: 51, col: 22 } },
  { label: 'Gonzo', room: 598, from: { row: 31, col: 14 }, onward: { row: 65, col: 19 }, named: { row: 38, col: 21 } },
  { label: 'Robin', room: 39, from: { row: 8, col: 18 }, named: { row: 10, col: 41 } },
]) {
  const geo = geometries.get(map.rooms[String(spec.room)]);
  const walls = safeWalls(geo);
  const namedWall = walls.find(x => x.row === spec.named.row && x.col === spec.named.col);
  const walk = geo.path(spec.from.row, spec.from.col, spec.named.row, spec.named.col);
  const options = { within: Math.max(geo.rows, geo.cols), onward: spec.onward, forwardBias: 8 };
  results.geometry.push({ ...spec, stepMask: !!geo.hasStepMask, safeWalls: walls.length,
    namedIsGeometryWall: !!namedWall, namedPathFound: walk.found, namedPathSteps: walk.steps?.length,
    withExit: summarize(nearestSafeSpot(geo, spec.from, options)),
    withoutExit: summarize(nearestSafeSpot(geo, spec.from, { ...options, allowExit: false })),
    nearestWithoutForwardBias: summarize(nearestSafeSpot(geo, spec.from, { ...options, onward: null, forwardBias: 1 })),
  });
}
const output = process.argv[2];
if (output) writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
