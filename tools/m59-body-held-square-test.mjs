#!/usr/bin/env node
// m59-body-held-square-test.mjs -- A BODY ON THE STAND POINT DOES NOT CLOSE THE SQUARE.
//
// Ukgoth (599), 2026-10-18: Rowlf stood forty minutes at r19c35, a wall pocket whose only
// mover step out is r20c34, with the Guardian of Zjiria five units from r20c34's stand point.
// walkTo aimed at that point, the body detour to it was refused inside the Guardian's
// MIN_NOMOVEON zone, and every exit candidate came back object_blocked. A fine line past the
// Guardian's edge was clear the whole time. enterBodyHeldSquare asks for the SQUARE.
//
// Offline: real 599 geometry from substrate/m59-map.json, live positions from that incident.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'm59-body-held-'));
process.env.M59_LEDGER_DIR = scratch; process.env.M59_UPTIME_FILE = join(scratch, 'uptime.jsonl');
const { Session } = await import('./m59-game.mjs');
const { loadMap } = await import('./m59-map.mjs');
const { sharedRoomGeometry } = await import('./m59-roo.mjs');
const { planBodyDetour } = await import('./m59-body-detour.mjs');

const map = loadMap();
const geo = sharedRoomGeometry(map.rooms[599]);
const ROWLF = { x: 2242, y: 1278, row: 19, col: 35 };
const HELD = { row: 20, col: 34 };
const GUARDIAN = { id: 16001, flags: 10485769, x: 2203, y: 1313, row: 20, col: 34 };
const inSquare = (p, sq) => Math.floor(p.y / 64) === sq.row && Math.floor(p.x / 64) === sq.col;

test('the pocket: r19c35 has one mover step out, onto the Guardian\'s square', () => {
  const out = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]
    .filter(([dr, dc]) => geo.moverStepLands(19, 35, 19 + dr, 35 + dc)).map(([dr, dc]) => `r${19 + dr}c${35 + dc}`);
  assert.deepEqual(out, ['r20c34']);
});

test('the stand point is inside the body; the point detour is refused, the square detour is not', () => {
  const sp = geo.standPointWire(HELD.row, HELD.col);
  assert(Math.hypot(sp.x - GUARDIAN.x, sp.y - GUARDIAN.y) < 16, 'stand point inside MIN_NOMOVEON');
  const objects = new Map([[GUARDIAN.id, GUARDIAN]]);
  assert.equal(planBodyDetour(geo, ROWLF, sp, { objects, selfId: 1 }).found, false);
  const plan = planBodyDetour(geo, ROWLF, sp, { objects, selfId: 1, goalSquare: HELD,
    marginSquares: 2, maxRangeSquares: 8, spacingUnits: 8, refine: true, maxNodes: 3000, maxMs: 2000 });
  assert.equal(plan.found, true, JSON.stringify(plan));
  const end = plan.waypoints.at(-1);
  assert(inSquare(end, HELD), `landing ${JSON.stringify(end)} is in r20c34`);
  assert(Math.hypot(end.x - GUARDIAN.x, end.y - GUARDIAN.y) >= 16, 'landing is clear of the Guardian');
});

function fixture({ cancelled = false } = {}) {
  const c = { self: { ...ROWLF, predicted: false }, selfId: 4462,
    room: { id: 1590, flags: 0, overrideDepths: null, objects: new Map([[GUARDIAN.id, GUARDIAN]]) } };
  const walked = [];
  const s = Object.assign(Object.create(Session.prototype), {
    name: 'fixture', client: c, world: { geometry: geo, room: { num: 599 } },
    movementGeneration: 0, cancelledMovementTokens: new Set(),
    need: () => c, hazardSquares: () => [],
    movementWasCancelled: () => cancelled,
    async walkDepartureLegs(waypoints, square, opts) { walked.push({ waypoints, square, opts });
      const at = waypoints.at(-1); c.self = { ...c.self, x: at.x, y: at.y, row: square.row, col: square.col };
      return { arrived: true, steps: waypoints.length }; },
  });
  return { s, c, walked };
}

test('enterBodyHeldSquare walks a proved line into the held square and says how', async () => {
  const { s, c, walked } = fixture();
  const r = await s.enterBodyHeldSquare(HELD, { maxSteps: 24, avoidSquares: new Set(['20,34']) });
  assert.equal(r.arrived, true); assert.equal(r.via, 'body_held_square');
  assert.equal(walked.length, 1); assert.deepEqual(walked[0].square, HELD);
  assert(inSquare(walked[0].waypoints.at(-1), HELD));
  assert.equal(c.self.row, 20); assert.equal(c.self.col, 34);
});

test('enterBodyHeldSquare sends nothing once the walk is cancelled', async () => {
  const { s, walked } = fixture({ cancelled: true });
  const r = await s.enterBodyHeldSquare(HELD, { maxSteps: 24 });
  assert.notEqual(r.arrived, true); assert.equal(walked.length, 0);
});

test('a square no point of which is reachable stays object_blocked', async () => {
  const { s, walked } = fixture();
  const r = await s.enterBodyHeldSquare({ row: 18, col: 36 }, { maxSteps: 24 });   // behind wall 266/267
  assert.equal(r.arrived, false); assert.equal(r.reason, 'object_blocked'); assert.equal(walked.length, 0);
});
