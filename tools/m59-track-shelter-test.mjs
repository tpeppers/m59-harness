// Offline track shelter integration: real rideTrack, geometry selector and keeper rest.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'm59-track-shelter-'));
process.env.M59_EVIDENCE_DIR = dir;
process.env.M59_UPTIME_FILE = path.join(dir, 'uptime.jsonl');
process.env.M59_TRACKS = path.join(dir, 'tracks.json');
process.env.M59_TRACK_STRIKES = path.join(dir, 'strikes.json');
const { Session } = await import('./m59-game.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const REST_VIGOR_CAP = 0.4; // RestTimer: 80 of 200.
const wp = col => ({ x: col * 64 + 32, y: 3 * 64 + 32 });
const geo = () => ({ rows: 5, cols: 5,
  walkable: (r, c) => r >= 1 && r <= 5 && c >= 1 && c <= 5,
  canMove: (_r, _c, _r2, _c2, options) => !!options?.fine });

function fixture({ policy = true, markers = [], geometry = geo() } = {}) {
  const track = { waypoints: [wp(2), wp(3), wp(4)], shelter: markers };
  const save = () => writeFileSync(process.env.M59_TRACKS,
    JSON.stringify({ tracks: { '584:585>596': track } }));
  save();
  const f = { hp: 60, vigor: 20, calls: [], rests: 0, stands: 0, samples: 0, track, save };
  const c = { room: { id: 1, objects: new Map() },
    self: { ...wp(2), row: 3, col: 2 }, state: 'game', selfId: 1,
    vitals: () => ({ health: { value: f.hp, max: 100 },
      vigor: { value: f.vigor, scale_max: 200 } }),
    stats() { if (f.rests) { f.samples++; f.onSample?.(); } },
    waitFor: async () => ({}), rest() { f.rests++; }, stand() { f.stands++; },
  };
  const s = Object.assign(Object.create(Session.prototype), {
    client: c, world: { room: { num: 584 }, geometry }, movementGeneration: 0,
    need: () => c, pacer: { submit: async (_lane, fn) => fn() },
    movementWasCancelled(g) { return this.movementGeneration !== g; },
    cancelMovement() { this.movementGeneration++; },
    stepFine: async (x, y) => {
      f.calls.push(['move', x, y]);
      c.self = { x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) };
      f.onMove?.(x, y);
      if (x === wp(4).x && !f.noExit) { c.room.id++; return { left_room: true }; }
      return { arrived: true };
    },
    walkFine: async (x, y) => s.stepFine(x, y),
  });
  if (policy) s.shelterPolicy = { need: () => f.hp < 95,
    onDivert: stop => f.calls.push(['divert', stop.row, stop.col]),
    onArrive: async (at, options) => {
      f.calls.push(['rest', at.row, at.col, options.source]); f.hp = 100; return true;
    } };
  return Object.assign(f, { s, c, run: () => s.rideTrack(585, 596) });
}

{
  const f = fixture();
  const r = await f.run();
  assert.equal(r.rested, 1, '60% health uses the policy, not the former 50% cutoff');
  assert.deepEqual(f.calls[1], ['divert', 3, 2], 'no saved marker needed; canonical square geometry decides');
  assert.deepEqual(f.calls[2], ['rest', 3, 2, 'track']);
  assert.equal(r.left_room, true, 'the original fine route continues after rest');
}
for (const setup of [
  f => { f.s.shelterPolicy = null; },
  f => { f.s.shelterPolicy.need = () => false; },
  f => { f.s.world.geometry = null; },
  f => { f.s.shelterPolicy.unreachable = () => new Set(['2,3', '3,3']); },
]) {
  const f = fixture({ markers: [0, 1] }); setup(f);
  assert.equal((await f.run()).rested, 0, 'markers cannot override absent/disabled policy or invalid/excluded cover');
}
{
  const f = fixture();
  f.hp = 100;
  f.onMove = x => { if (x === wp(3).x) f.hp = 60; };
  await f.run();
  assert.deepEqual(f.calls.find(c => c[0] === 'rest'), ['rest', 3, 3, 'track'], 'need is re-evaluated after each leg');
}
{
  const f = fixture();
  f.onMove = () => { f.c.self.col++; f.c.self.x += 33; };
  assert.equal((await f.run()).rested, 0, 'within the fine tolerance but in the next square is not refuge arrival');
}
for (const change of ['cancel', 'room', 'policy']) {
  const f = fixture();
  f.onMove = () => {
    if (change === 'cancel') f.s.cancelMovement();
    if (change === 'room') f.c.room.id++;
    if (change === 'policy') f.s.shelterPolicy = null;
  };
  assert.equal((await f.run()).rested, 0, 'no rest after ' + change + ' changes');
}
{
  const f = fixture();
  f.s.shelterPolicy.onArrive = async () => { f.s.cancelMovement(); return true; };
  assert.equal((await f.run()).cancelled, true);
  assert.equal(f.calls.filter(x => x[0] === 'move').length, 1, 'no next move after rest cancellation');
}
{
  const f = fixture();
  f.track.proven = false; f.track.waypoints = [wp(2)];
  f.track.walked = [wp(2), wp(3), wp(4)]; f.save();
  f.hp = 100; f.onMove = x => { if (x === wp(3).x) f.hp = 60; };
  const r = await f.run();
  assert.equal(r.fell_back_to_walked, true);
  assert.equal(r.rested, 1, 'the stitched track fallback shares the shelter lifecycle');
}

// Ordinary route arrivals must retain the original movement owner too.
{
  const f = fixture();
  f.s.movementGeneration = 7;
  f.s.step = async () => ({ arrived: true });
  f.s._yieldIfPacketless = async () => {};
  let arrivedWith;
  const r = await f.s.walkPivots([{ row: 3, col: 2, shelter: true }], {
    stringPull: points => ({ points, proved: [false] }),
  }, { movementGeneration: 7, controlToken: 'route-owner', maxMoves: 1,
    shelter: { async onArrive(_where, options) {
      arrivedWith = options;
      f.s.cancelMovement();
    } },
  });
  assert.deepEqual(arrivedWith, { movementGeneration: 7, controlToken: 'route-owner' });
  assert.equal(r.cancelled, true, 'route arrival preserves and checks its original owner');
}

// Install the real keeper policy. Accelerate only restUntil's three-second waits.
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 3000 ? 0 : ms, ...args);
try {
  for (const outcome of ['recovered', 'damage', 'cancel']) {
    const f = fixture();
    const k = Object.assign(Object.create(Autopilot.prototype), {
      s: f.s, policy: {}, book: { save() {}, recall() { return new Map(); } }, tally: {},
      note(what, detail) { f.calls.push(['note', what, detail]); }, sanctuary: () => false, roomOutranksUs: () => false,
      inertStatus() { return this.inert; },
      recordTravelShelterStop(source) { f.calls.push(['count', source]); },
    });
    k.goTravelling('test', { to: 596 });
    f.s.shelterPolicy.onDivert = () => {};
    f.onMove = x => { if (outcome === 'damage' && x === wp(3).x) { f.hp = 100; f.vigor = 200; } };
    f.onSample = () => {
      if (outcome === 'recovered') {
        f.hp = f.samples === 1 ? 80 : 100;
        f.vigor = f.samples < 3 ? 60 : REST_VIGOR_CAP * 200;
      } else if (outcome === 'damage') { f.hp = 59; }
      else { f.s.cancelMovement(); }
    };
    const r = await f.run();
    assert.equal(f.rests, 1, JSON.stringify({outcome, calls:f.calls}));
    assert.deepEqual(f.calls.filter(x => x[0] === 'count'), [['count', 'track']], 'one metric per actual stop');
    if (outcome === 'recovered') {
      assert.equal(f.hp, 100); assert.equal(f.vigor, REST_VIGOR_CAP * 200);
      assert.equal(f.samples, 3, 'both full health and restable vigor are required');
      assert.equal(f.stands, 1); assert.equal(r.left_room, true);
    } else if (outcome === 'damage') {
      assert.equal(f.samples, 1, 'damage aborts the shared rest at its next observation');
      assert.ok(k.unreachableIn(584).has('2,3'), 'failed refuge excluded from subsequent searches');
      assert.equal(f.stands, 1);
    } else {
      assert.equal(r.cancelled, true);
      assert.equal(f.stands, 0, 'an invalidated movement owner cannot stand the character');
      assert.equal(f.calls.filter(x => x[0] === 'move').length, 1);
    }
  }
} finally { globalThis.setTimeout = timer; }
console.log('track shelter integration passed: shared policy, geometry, arrival, health/vigor, damage, cancellation, fallback and counting');
