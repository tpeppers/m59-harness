// A WALL IS THREADED, NOT SLID INTO -- and a refused slide on the way to a doorway is not the end of
// leaving. Offline, real geometry from substrate/m59-map.json; no socket, no roster.
//
//   node tools/m59-wall-thread-test.mjs
//
// THE INCIDENT, 2026-10-13. After deploy-2026-10-13 (9de8c953, the large-departure-slide refusal),
// Zheng He stood at r12c4 (262,830) of Herbutte's shop (109) for four laps. Every walk to the exit
// square r13c4 aimed into the door frame, the walker's sidestep toward r12c5 was predicted to slide
// 19 of 90 units (71 off its aim, tolerance 64) and was refused, and `leaveVia` treated that refusal
// as final -- before any of its doorway fallbacks ran. He left at 20:53Z when his keeper's own resume
// pressed `go` from r12c4.
//
// Two things were wrong, and both are pinned here:
//
//   1. `threadInto` only searched for a lane when a BODY was in the way. A wall in the way returned
//      the unproved stand point and the mover slid -- which was the design ("let the ordinary
//      machinery slide, refuse and learn") until the deviation guard started refusing slides.
//      Now an unproved aim with nothing in the way runs the same bounded, clocked search against
//      the walls alone: line up along the wall, then go through, each leg a straight line.
//   2. `leaveVia`'s `go` branch returned on `movement_deviation`, so the fallbacks written for
//      exactly this ground ("a doorway is usually not walkable in the room's own grid") never ran.
//
// What this does NOT prove: that 109 is left offline. Its exit row (13) has no floor anywhere in
// the bake, so the doorway correction cannot place the body on r13c4 locally; live, the server
// accepted the `go` from r12c4. That last step needs a live or shadow trial, and says so below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'm59-wall-thread-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelters', M59_CROSSINGS_LEARNED: 'crossings.json' }))
  process.env[k] = join(scratch, v);

const { Session } = await import('./m59-game.mjs');
const { World } = await import('./m59-world.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { protocolToClient } = await import('./m59-roo.mjs');

const map = loadMap();
const geo109 = geometryFor(map.rooms[109]);
const straight = (geo, a, b) => geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
  protocolToClient(b.x), protocolToClient(b.y), { slide: false }).arrived === true;
const solver = (geo) => ({
  world: { geometry: geo }, bodiesInSquare: () => [],
  aimInto: Session.prototype.aimInto, _wallOk: Session.prototype._wallOk, _fineLattice: Session.prototype._fineLattice,
  _legIsLegal: Session.prototype._legIsLegal, _canEnter: Session.prototype._canEnter, _noteNeedleCut() {},
});

test('a wall between the body and the next square is reported, not passed off as a proved aim', () => {
  // r4c4 at (262,262) into r4c5: no straight line from there reaches any of aimInto's candidates.
  const aim = Session.prototype.aimInto.call(solver(geo109), { x: 262, y: 262, row: 4, col: 4 }, 4, 5);
  assert.equal(aim.unproved, true, JSON.stringify(aim));
});

test('threadInto lines up along the wall and goes through, every leg a straight no-slide line', () => {
  const from = { x: 262, y: 262, row: 4, col: 4 };
  const t = Session.prototype.threadInto.call(solver(geo109), from, 4, 5);
  assert.notEqual(t.blocked, true, JSON.stringify(t));
  assert.ok((t.vias ?? []).length >= 1, 'a reposition inside r4c4 first');
  let at = from;
  for (const p of [...t.vias, t.aim]) { assert.ok(straight(geo109, at, p), `leg ${JSON.stringify(at)} -> ${p.x},${p.y}`); at = p; }
  assert.equal(Math.floor(t.aim.x / 64), 5); assert.equal(Math.floor(t.aim.y / 64), 4);
});

test('an uncontested proved step is unchanged to the byte', () => {
  // r4c4's centre into r4c5's: aimInto proves a line, so threadInto must hand it straight back.
  const s = solver(geo109), from = { x: 288, y: 288, row: 4, col: 4 };
  const aim = Session.prototype.aimInto.call(s, from, 4, 5);
  if (aim.unproved) return;                         // the bake moved; the other tests still hold
  assert.deepEqual(Session.prototype.threadInto.call(s, from, 4, 5), { aim });
});

test('109: a refused slide on the approach no longer ends leaving before the doorway fallbacks', async () => {
  const packets = [], gos = [];
  const self = { id: 1, flags: 4, row: 12, col: 4, x: 262, y: 830, degrees: 0 };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(), roomNameRsc: map.rooms[109].nameRsc, roomRsc: map.rooms[109].roomRsc,
    room: { id: 109, security: geo109.security, flags: 0, objects: new Map([[1, self]]) },
    vitals: () => ({ health: { value: 20, max: 20 }, vigor: { value: 80, max: 200 } }), face() {}, roomContents() { return 1; },
    stand() { return true; }, go() { gos.push({ ...this.self }); return true; }, eventsSince: () => [],
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(x, y) { packets.push({ x, y }); this.predictSelf({ x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) }); } };
  const world = new World(c, map);
  const s = Object.assign(Object.create(Session.prototype), { client: c, world, movementGeneration: 0, name: 'offline-109',
    need: () => c, moveSpeed: () => 18, movementWasCancelled: g => g !== s.movementGeneration,
    pacer: { async submit(k, run) { return run(); } }, async confirmPosition() { c.self.predicted = false; return c.self; } });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  const exit = world.exits().find(e => Number(e.to) === 102 && e.kind === 'go');
  assert.ok(exit, 'the bake still has the go exit to South Barloque');
  const r = await s.leaveVia(exit);
  // Before: { reason: 'movement_deviation', ... } with zero packets -- the incident, exactly.
  assert.notEqual(r.reason, 'movement_deviation', JSON.stringify(r).slice(0, 300));
  assert.ok(packets.length > 0, 'the doorway approach and fallbacks actually moved');
  // KNOWN LIMIT, NOT A PASS: row 13 has no floor in the bake, so the local doorway correction cannot
  // stand on r13c4 and no `go` is sent offline. Live, `go` from r12c4 was accepted at 20:53Z.
  if (r.left !== true) console.log(`  (offline 109 still ends ${r.reason}: the exit row has no baked floor -- needs a live/shadow trial)`);
});
