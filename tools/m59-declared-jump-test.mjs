// #movement: declared jumps as the live mover flies them -- preconditions, the air-span gate, the
// per-jump outcome row, and every declaration proving under every check.
//
//   node tools/m59-declared-jump-test.mjs        offline; no socket, no roster
//
// docs/falljump-audit-2026-10-31.md is the incident: seven of eighteen declarations read as refused
// offline while characters were landing them, for four different reasons, and nothing recorded
// whether a declared jump landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-declared-jump-'));
for (const [k, v] of Object.entries({ M59_LEDGER_DIR: 'ledger', M59_TACTICS_DIR: 'tactics', M59_TRAILS_DIR: 'trails',
  M59_SPOT_CLAIMS_DIR: 'claims', M59_SHELTER_DIR: 'shelter', M59_CROSSINGS_LEARNED: 'crossings.json' }))
  process.env[k] = join(scratch, v);
process.env.M59_RUNTIME_PROFILE = 'lab'; process.env.M59_EXIT_FALLBACK = '0'; process.env.M59_EXIT_DEBUG = '0';

const { loadMap } = await import('./m59-map.mjs');
const { fallJumpsIn, loadFallJumps } = await import('./m59-falljump.mjs');
const { traceFallMotion } = await import('./m59-falltrace.mjs');
const { airPhases, proveCandidateFall } = await import('./m59-fineroute.mjs');
const { maxSpan } = await import('./m59-falljump-physics.mjs');
const { proveDeclaredJump, geometryForDeclaration, sectorRequirements, livePreconditionState, declaredJumpFor, LIVE_FALL_TRACE } =
  await import('./m59-declared-jump.mjs');
const { declaredJumpNear } = await import('./m59-jump-precondition.mjs');
const { jumpOutcomeRow, recordJumpOutcome, readJumpOutcomes, summarizeJumpOutcomes } = await import('./m59-jump-outcomes.mjs');
const { isTerminalMovementReason } = await import('./m59-movement.mjs');
const { Session } = await import('./m59-game.mjs');
const { geometryFor } = await import('./m59-safespots.mjs');
const { configureSpotClaimStore } = await import('./m59-spotclaims.mjs'); configureSpotClaimStore({ enabled: false });

const map = loadMap();
const jump = (room, fr, fc, tr, tc) => {
  const j = declaredJumpFor(room, { row: fr, col: fc }, { row: tr, col: tc });
  assert.ok(j, `declared ${room} r${fr}c${fc}>r${tr}c${tc}`);
  return j;
};
const braxNorth = jump(579, 14, 55, 8, 55);

// ------------------------------------------------------------------------- preconditions

test('requires.sectors reads as kod sector id and kod height, and malformed entries are refused', () => {
  assert.deepEqual(sectorRequirements(braxNorth), [{ sector: 3, height: 800 }, { sector: 4, height: 510 }]);
  assert.deepEqual(sectorRequirements({}), []);
  assert.throws(() => sectorRequirements({ requires: { sectors: [800] } }), /object/);
  assert.throws(() => sectorRequirements({ requires: { sectors: { three: 800 } } }), /kod sector id/);
});

test('the Brax north jump proves with the lift raised and is refused on the static .roo', () => {
  const up = proveDeclaredJump(map.rooms[579], braxNorth);
  assert.equal(up.proved, true, up.reason);
  assert.deepEqual(up.applied.map(r => r.sector), [3, 4]);
  assert.equal(up.proof.from_floor_client, 800 * 16);
  assert.equal(up.proof.to_floor_client, 510 * 16);
  const { requires: { sectors, ...rest }, ...bare } = braxNorth;
  const down = proveDeclaredJump(map.rooms[579], { ...bare, requires: rest });
  assert.equal(down.proved, false, 'from the platform as shipped the north ledge is a climb');
  assert.ok(down.proof.to_floor_client > down.proof.from_floor_client);
});

test('a precondition is applied to a fresh geometry, never the shared one the router reads', () => {
  const shared = geometryForDeclaration(map.rooms[579], {}).geometry;
  const before = shared.floorBaseAtClient(braxNorth.from_fine.x, braxNorth.from_fine.y);
  const { geometry } = geometryForDeclaration(map.rooms[579], braxNorth);
  assert.notEqual(geometry, shared);
  assert.equal(geometry.floorBaseAtClient(braxNorth.from_fine.x, braxNorth.from_fine.y), 12800);
  assert.equal(shared.floorBaseAtClient(braxNorth.from_fine.x, braxNorth.from_fine.y), before);
});

test('the live precondition is met, unmet or unknown from what the server has sent', () => {
  const met = livePreconditionState(braxNorth, new Map([[3, { height: 800, type: 4 }], [4, { height: 510, type: 4 }]]));
  assert.equal(met.ok, true); assert.equal(met.reason, null);
  const down = livePreconditionState(braxNorth, new Map([[3, { height: 250 }], [4, { height: 540 }]]));
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'jump_precondition_unmet: sector 3 is 250, needs 800');
  assert.equal(down.code, 'jump_precondition_unmet');
  const keeperShape = livePreconditionState(braxNorth, { 3: 800, 4: 540 });   // `/state` doors.observed
  assert.equal(keeperShape.reason, 'jump_precondition_unmet: sector 4 is 540, needs 510');
  const unknown = livePreconditionState(braxNorth, new Map([[3, { height: 800 }]]));
  assert.equal(unknown.ok, null);
  assert.match(unknown.reason, /^jump_precondition_unknown: sector 4 has not been observed/);
  assert.equal(livePreconditionState(braxNorth, null).code, 'jump_precondition_unknown');
  assert.equal(livePreconditionState(jump(599, 37, 14, 39, 12), null).ok, true, 'no requirement, nothing to observe');
  assert.ok(isTerminalMovementReason('jump_precondition_unmet') && isTerminalMovementReason('jump_precondition_unknown'));
});

test('the jump verb neighbourhood finds the declaration a step along the ledge', () => {
  assert.equal(declaredJumpNear(579, { row: 15, col: 55 }, { row: 8, col: 55 }), braxNorth, 'staged one square back');
  assert.equal(declaredJumpNear(579, { row: 16, col: 55 }, { row: 8, col: 55 }), null, 'two squares back is another place');
});

// ------------------------------------------------------------------------- Session.step

function fixture(room, x, y, { sectorHeights = undefined } = {}) {
  const geo = geometryFor(map.rooms[room]), packets = [];
  const self = { id: 1, flags: 4, x, y, row: Math.floor(y / 64), col: Math.floor(x / 64), predicted: false };
  const c = { selfId: 1, self, evSeq: 0, rsc: new Map(),
    room: { id: room, security: geo.security, flags: 0, objects: new Map([[1, self]]), ...(sectorHeights ? { sectorHeights } : {}) },
    vitals: () => ({ health: { value: 76, max: 76 }, vigor: { value: 200, max: 200 } }), face() {}, stand() {}, roomContents() { return 1; },
    async waitFor() { return { events: [] }; },
    predictSelf(p) { this.self = { ...this.self, ...p, predicted: true }; this.room.objects.set(1, this.self); },
    moveTo(x, y) { packets.push({ x, y }); this.predictSelf({ x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) }); } };
  const s = Object.assign(Object.create(Session.prototype), { client: c, world: { map, room: map.rooms[room], geometry: geo },
    movementGeneration: 0, name: 'offline-declared-jump', need: () => c, moveSpeed: () => 18,
    movementWasCancelled: g => g !== s.movementGeneration, pacer: { async submit(_k, run) { return run(); } },
    async confirmPosition() { c.self.predicted = false; return c.self; }, async _askStrategies() { return null; },
    _blinkPointHere: () => null, _blockingBodies: () => [], noteTransit() {}, planSameRoomDoors: () => null,
    async rideTrack() { return { rode: false }; } });
  Object.defineProperty(s, 'live', { value: true }); s.threatsHere = () => [];
  return { s, c, geo, packets };
}
const outcomes = () => readJumpOutcomes({ dir: process.env.M59_LEDGER_DIR, sinceMs: 3600_000 });
const takeoff = j => ({ x: j.from_fine.x / 16 + 64, y: j.from_fine.y / 16 + 64 });

test('Session.step refuses a declared jump whose sector is unobserved or wrong, by name, and records it', async () => {
  const at = takeoff(braxNorth);
  const unknown = fixture(579, at.x, at.y);
  const r1 = await unknown.s.step(55, 8, { fall: true });
  assert.equal(r1.reason, 'jump_precondition_unknown'); assert.equal(unknown.packets.length, 0);
  assert.match(r1.detail, /sector 3 has not been observed/);
  const down = fixture(579, at.x, at.y, { sectorHeights: new Map([[3, { height: 250, type: 4 }], [4, { height: 540, type: 4 }]]) });
  const r2 = await down.s.step(55, 8, { fall: true, timedFall: true });
  assert.equal(r2.reason, 'jump_precondition_unmet'); assert.equal(r2.detail, 'sector 3 is 250, needs 800');
  assert.equal(down.packets.length, 0);
  const rows = outcomes().filter(r => r.room === 579 && r.jump?.from.row === 14);
  assert.equal(rows.length, 2);
  const last = rows.at(-1);
  assert.equal(last.sent, false); assert.equal(last.reason, 'jump_precondition_unmet');
  assert.equal(last.precondition.ok, false);
  assert.deepEqual(last.precondition.sectors.map(s => [s.sector, s.observed, s.height]), [[3, 250, 800], [4, 540, 510]]);
  assert.equal(last.trigger, 'jump_verb');
});

test('a flown declared jump writes one outcome row: identity, take-off, aim, landing, floor, air time', async () => {
  const uk = jump(599, 37, 14, 39, 12), at = takeoff(uk);
  const f = fixture(599, at.x, at.y);
  const r = await f.s.step(12, 39, { fall: true });
  assert.equal(f.packets.length, 1, JSON.stringify(r));
  const row = outcomes().filter(x => x.room === 599).at(-1);
  assert.deepEqual(row.jump, { from: { row: 37, col: 14 }, to: { row: 39, col: 12 } });
  assert.equal(row.sent, true); assert.equal(row.landed_on_target, true);
  assert.deepEqual(row.takeoff.declared, uk.from_fine); assert.equal(row.takeoff.off_declared, 0);
  assert.equal(row.landing.floor, 3840); assert.equal(row.target_floor, 3840);
  assert.ok(row.air_ms > 500 && row.air_ms < 2000, String(row.air_ms));
  assert.deepEqual(row.landing.square, { row: 39, col: 12 });
  assert.equal(row.precondition.ok, true); assert.equal(row.trigger, 'declared');
});

test('the outcome row is pure, and the reader turns rows into a rate', () => {
  const declaration = jump(599, 37, 14, 39, 12);
  const base = { declaration, room: 599, before: { x: 952, y: 2416 }, aim: { x: 792, y: 2536 }, floorAt: () => 3840 };
  const made = jumpOutcomeRow({ ...base, t: 1, queued: { sent: true, target: { x: 792, y: 2536 }, validation: { fall_motion: { elapsed_ms: 976 } } } });
  const short = jumpOutcomeRow({ ...base, t: 2, floorAt: (x, y) => x > 12000 ? 3200 : 3840,
    queued: { sent: true, target: { x: 900, y: 2480 }, validation: { fall_motion: { elapsed_ms: 400 } } } });
  const refused = jumpOutcomeRow({ ...base, t: 3, queued: null, refusal: 'jump_needs_run' });
  assert.equal(made.landed_on_target, true); assert.equal(made.air_ms, 976);
  assert.equal(short.landed_on_target, false, 'a landing off the aim is not on target');
  assert.equal(refused.sent, false); assert.equal(refused.reason, 'jump_needs_run'); assert.equal(refused.landing, null);
  const dir = mkdtempSync(join(scratch, 'rows-'));
  for (const r of [made, short, refused]) assert.equal(recordJumpOutcome({ ...r, t: Date.now() }, { dir }), true);
  const [s] = summarizeJumpOutcomes(readJumpOutcomes({ dir }));
  assert.deepEqual({ tried: s.tried, sent: s.sent, landed: s.landed, rate: s.landed_rate }, { tried: 3, sent: 2, landed: 1, rate: 0.5 });
  assert.deepEqual(s.refused, { jump_needs_run: 1 });
  assert.ok(readdirSync(dir).every(f => /^jump-outcomes-\d{4}-\d\d-\d\d\.jsonl$/.test(f)));
});

// ------------------------------------------------------------------------- the air-span gate

test('the span gate measures the air, from where the body leaves the floor', () => {
  // Level run of 3000, then 1000 of air dropping 1000: the old chord gate saw 4000 against
  // maxSpan(1000); the air phase is 1000 of it.
  const frames = [];
  for (let x = 82; x <= 3000; x += 82) frames.push({ ms: frames.length * 16, x, y: 0, z: 2000, floor: 2000 });
  for (let x = 3082, z = 2000; x <= 4000; x += 82) { z -= 100; frames.push({ ms: frames.length * 16, x, y: 0, z, floor: z > 1000 ? 1000 : 1000 }); }
  frames.push({ ms: frames.length * 16, x: 4000, y: 0, z: 1000, floor: 1000 });
  const [phase] = airPhases({ x: 0, y: 0, z: 2000 }, frames);
  assert.ok(phase, 'one air phase');
  assert.ok(phase.leave.x >= 2900 && phase.leave.x <= 3000, JSON.stringify(phase.leave));
  assert.ok(phase.span <= 1100); assert.equal(phase.drop, 1000);
  assert.ok(4000 > maxSpan(1000), 'the chord alone would have been refused');
  assert.ok(phase.span <= phase.max_span + phase.slack, 'the air alone is inside the budget');
});

test('a run-up take-off proves on air span where the chord gate refused it (2505 r27c60 > r27c65)', () => {
  const j = jump(2505, 27, 60, 27, 65);
  const chord = Math.hypot(j.to_fine.x - j.from_fine.x, j.to_fine.y - j.from_fine.y);
  const r = proveDeclaredJump(map.rooms[2505], j);
  assert.ok(chord > r.proof.max_span_client, 'the straight line is over budget');
  assert.equal(r.proved, true, r.reason);
  assert.ok(r.proof.span_client <= r.proof.max_span_client + 82);
});

test('a jump whose AIR is too long is still refused', () => {
  // The Hollows' old declaration: the same 8000 floor both ends, through the 4800 pit.
  const geo = geometryForDeclaration(map.rooms[2502], {}).geometry;
  const p = proveCandidateFall(geo, { fromFine: { x: 34192, y: 41376 }, toFine: { x: 26976, y: 44160 } });
  assert.equal(p.model_proved, false);
});

// ------------------------------------------------------------------------- every declaration

test('every declared jump proves the way the mover flies it: live options, wire rounding, air span, preconditions', () => {
  const all = loadFallJumps().jumps;
  assert.equal(all.length, 18);
  for (const j of all) {
    const r = proveDeclaredJump(map.rooms[j.room], j);
    assert.equal(r.proved, true, `${j.room} r${j.from.row}c${j.from.col}>r${j.to.row}c${j.to.col}: ${r.reason}`);
  }
});

test('the jumps moved on 2026-10-31 also prove with slide off, on real floor, inside their squares', () => {
  const moved = [jump(2502, 40, 33, 40, 29), jump(579, 47, 39, 49, 36), jump(599, 37, 14, 39, 12),
                 jump(579, 14, 55, 8, 55), jump(579, 14, 56, 8, 56)];
  for (const j of moved) {
    const { geometry } = geometryForDeclaration(map.rooms[j.room], j);
    const a = j.from_fine, b = j.to_fine, name = `${j.room} r${j.from.row}c${j.from.col}`;
    for (const slide of [false, true]) assert.equal(traceFallMotion(geometry, a.x, a.y, b.x, b.y, { slide }).arrived, true, `${name} slide:${slide}`);
    assert.ok(Number.isFinite(geometry.floorBaseAtClient(a.x, a.y)) && Number.isFinite(geometry.floorBaseAtClient(b.x, b.y)), name);
    assert.deepEqual({ row: Math.floor(a.y / 1024) + 1, col: Math.floor(a.x / 1024) + 1 }, j.from, `${name} take-off square`);
    assert.deepEqual({ row: Math.floor(b.y / 1024) + 1, col: Math.floor(b.x / 1024) + 1 }, j.to, `${name} landing square`);
  }
});

test('the two Ancient climb jumps the lab landed 3/3 keep their points and prove on the live options', () => {
  for (const j of [jump(579, 40, 33, 40, 32), jump(579, 38, 31, 42, 30)]) {
    const { geometry } = geometryForDeclaration(map.rooms[579], j);
    const live = geometry.traceFineMoveClient(j.from_fine.x, j.from_fine.y, j.to_fine.x, j.to_fine.y, LIVE_FALL_TRACE);
    assert.equal(live.arrived, true, `r${j.from.row}c${j.from.col}`);
  }
  assert.deepEqual(jump(579, 38, 31, 42, 30).to_fine, { x: 30320, y: 42000 });
});

test('the router offers the re-keyed Ukgoth jump and not the old pair', () => {
  const geo = geometryForDeclaration(map.rooms[599], {}).geometry;
  assert.deepEqual(geo.declaredFallJumps(37, 14).map(j => [j.row, j.col]), [[39, 12]]);
  assert.deepEqual(geo.declaredFallJumps(36, 16), []);
  assert.equal(fallJumpsIn(599).some(j => j.from.row === 36 && j.from.col === 16), false);
});
