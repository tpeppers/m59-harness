// A JOURNEY THAT STARTS INSIDE A ROOM STILL RIDES THE ROOM'S TRACK. Offline: real rideTrack and
// tracksLeavingBy over a temporary book; no socket, no roster.
//
// Kardde's Canyon (49), prod 2026-10-19: every re-issued or resumed walk to 45 began mid-room, so
// rideTrack was asked for `49:?>45` (no entry door), found nothing, and the crossing was planned
// bare into the fence pocket at r20-23 c17-18 — 40 to 67 minutes per character against a crossing
// the threaded 49:593>45 does in under a minute.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'm59-track-midroom-'));
process.env.M59_EVIDENCE_DIR = dir;
process.env.M59_UPTIME_FILE = path.join(dir, 'uptime.jsonl');
process.env.M59_TRACKS = path.join(dir, 'tracks.json');
process.env.M59_TRACK_STRIKES = path.join(dir, 'strikes.json');
const { Session } = await import('./m59-game.mjs');
const { tracksLeavingBy } = await import('./m59-tracks.mjs');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const wp = (col, row = 3) => ({ x: col * 64 + 32, y: row * 64 + 32 });
const geo = { rows: 9, cols: 9, walkable: (r, c) => r >= 1 && r <= 9 && c >= 1 && c <= 9,
              canMove: (_r, _c, _r2, _c2, o) => !!o?.fine };

function fixture({ tracks, strikes = {}, at = wp(2) }) {
  writeFileSync(process.env.M59_TRACKS, JSON.stringify({ tracks }));
  writeFileSync(process.env.M59_TRACK_STRIKES, JSON.stringify({ strikes }));
  const f = { moves: [] };
  const exitX = new Set(Object.values(tracks).map(t => t.waypoints.at(-1).x));
  const c = { room: { id: 1, objects: new Map() }, self: { ...at, row: Math.floor(at.y / 64), col: Math.floor(at.x / 64) },
    state: 'game', selfId: 1, vitals: () => ({ health: { value: 100, max: 100 } }),
    stats() {}, waitFor: async () => ({}), face() {} };
  const s = Object.assign(Object.create(Session.prototype), {
    client: c, world: { room: { num: 49 }, geometry: geo }, movementGeneration: 0,
    need: () => c, pacer: { submit: async (_l, fn) => fn() },
    movementWasCancelled(g) { return this.movementGeneration !== g; }, cancelledMovementTokens: new Set(),
    stepFine: async (x, y) => {
      f.moves.push([x, y]);
      c.self = { x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) };
      if (exitX.has(x)) { c.room.id++; return { left_room: true }; }
      return { arrived: true };
    },
    walkFine: async (x, y) => s.stepFine(x, y),
    walkTo: async () => ({ arrived: true }),
  });
  return { f, s };
}

// tracksLeavingBy: every door in, one door out, struck ones left out.
{
  const t = { waypoints: [wp(2), wp(4)] };
  const found = tracksLeavingBy(49, 45, { '49:593>45': t, '49:50>45': t, '49:593>50': t, '50:49>45': t, '49:?>45': t },
                                { '49:50>45': 3 });
  ok(found.map(o => o.from).sort().join() === '593,', 'only tracks in this room out by this door, struck one excluded, ? is null');
}

// The incident: no entry door, one threaded track out by 45. It is ridden, not planned bare.
{
  const { f, s } = fixture({ tracks: { '49:593>45': { waypoints: [wp(2), wp(3), wp(4)] } } });
  const r = await s.rideTrack(null, 45);
  ok(r.rode === true && r.left_room === true, `a mid-room journey rides 49:593>45: ${JSON.stringify(r)}`);
  ok(f.moves.length >= 2, 'it walked the stations');
}

// Two tracks out by the same door: the one whose stations are nearest is the one ridden.
{
  const near = { waypoints: [wp(2, 6), wp(3, 6), wp(6, 6)] };
  const far = { waypoints: [wp(8, 1), wp(8, 2), wp(7, 2)] };
  const { f, s } = fixture({ tracks: { '49:50>45': far, '49:593>45': near }, at: wp(2, 6) });
  const r = await s.rideTrack(null, 45);
  ok(r.rode === true && f.moves.at(-1)[0] === wp(6, 6).x, `the nearer track is ridden: ${JSON.stringify(f.moves)}`);
}

// A struck-out track is not ridden mid-room either — the strike still means what it meant.
{
  const { s } = fixture({ tracks: { '49:593>45': { waypoints: [wp(2), wp(3), wp(4)] } }, strikes: { '49:593>45': 3 } });
  const r = await s.rideTrack(null, 45);
  ok(r.rode === false && r.why === 'no track', `a struck track stays retired: ${JSON.stringify(r)}`);
}

// A journey that DID come in by a door still asks for its own track first.
{
  const { s } = fixture({ tracks: { '49:593>45': { waypoints: [wp(2), wp(3), wp(4)] } } });
  const r = await s.rideTrack(593, 45);
  ok(r.rode === true, 'the exact key still rides');
}

console.log(`m59-track-midroom-test: ${passed} passed`);
