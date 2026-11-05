#!/usr/bin/env node
// PATROL FARMING: WALK THE SPAWN POINTS IN A LOOP AND KILL WHAT YOU MEET. #movement
//
//   node tools/m59-patrol-farm.mjs check --strategy icky-cave-patrol      prove every leg of a strategy's loop
//   node tools/m59-patrol-farm.mjs check --room 27 --loop r23c53 r35c58 r31c31 r32c35 r51c14 r50c34
//   node tools/m59-patrol-farm.mjs check ... --json
//
// CLI CONTRACT: `--loop` takes `rNcM` squares (r = row, c = col), the notation docs/m59-coordinates.md
// uses for humans; nothing positional. A strategy file says `{ row, col }`.
//
// THE OPERATOR, 2026-11-04, of the Icky Cave (27): "The way I see efficient farming (at least for Icky
// Cave) going is to walk across all the various spawn locations and kill any monsters seen ... those are
// the rails I'd have it take in an infinite loop, killing everything it comes across ... I'd like to see if
// you can get its kills/30m as high as a human player like mine."
//
// The keeper's farm pass already kills what it sees. What it does with NOTHING to kill is hold a wall and
// wait (passFarm's vigil: "waiting behind a wall costs nothing") -- right in a big outdoor room where the
// prey wanders to you, and the reason a cave with generators in alcoves is farmed at a fraction of a human's
// rate: the human goes to the spawn points. So a patrol changes exactly that one decision. With quarry in
// reach the farm pass runs unchanged (hunt, spare, gang-up, engagement ceiling, the wall it opens a fight
// from, survival above it all); with none, instead of holding a wall, the keeper walks the next bounded piece
// of the loop. After a fight it resumes at the nearest waypoint rather than doubling back to the one it was
// heading for when the fight started.
//
// WHERE IT IS WIRED. Every farming code path a keeper runs goes through one method, `Autopilot.passFarm`
// (tools/autopilot/pass-farm.mjs), and a farm strategy reaches it only as policy keys the engine writes
// (m59-strategy-engine.mjs). So `patrol` is a strategy field (m59-strategy-schema.mjs) -> `policy.patrol`
// -> `patrolHere` / `patrolEngageFilter` / `patrolWalk` (tools/autopilot/hunt-setup.mjs), called from the two
// places in passFarm that already answer "which quarry" and "nothing to do". OFF unless a file declares it:
// `policy.patrol` defaults to null and every helper returns the old answer for null.
//
// THIS FILE IS PURE plus a read-only CLI: the normal form, the state machine, the quarry radius, and the
// offline proof of every leg on the map the mover enforces. It opens no socket and touches no roster.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const PATROL_DEFAULTS = Object.freeze({
  // Quarry farther than this many squares from the body is left for the loop to meet. Without a radius a
  // patrol would be ordinary farming: the keeper sees the whole room and would cross it for any creature.
  engageWithin: 8,
  // A waypoint is reached within this many squares (Chebyshev), so a body nudged by a crowd still advances.
  arriveWithin: 1,
  // Steps walked per pass before the pass returns and the room is looked at again: a patrol is a walk that
  // stops to fight, so it walks in short pieces. walkTo's own budget (maxSteps).
  legSteps: 20,
  // After a fight, keep heading for the waypoint we had unless the nearest one is closer by more than this
  // many squares -- so a fight at the start of a leg does not send us back to the waypoint we just left.
  resumeSlack: 3,
});

const LIMITS = { engageWithin: [1, 40], arriveWithin: [0, 4], legSteps: [4, 120], resumeSlack: [0, 20] };

/**
 * The strategy field's normal form: `{ room, loop: [{row, col}, ...], engageWithin?, arriveWithin?, legSteps?,
 * resumeSlack? }` -> the same with every option filled in, or null. Squares are NAMED: a bare `[row, col]` is
 * refused, because docs/m59-coordinates.md forbids new two-element coordinate tuples and the operator's own
 * loop was ambiguous until he confirmed which number was the row.
 */
export function normPatrol(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('patrol must be { room, loop: [{ row, col }, ...] } or null');
  const known = new Set(['room', 'loop', ...Object.keys(PATROL_DEFAULTS)]);
  const extra = Object.keys(v).filter(k => !known.has(k));
  if (extra.length) throw new Error(`patrol has unrecognised key(s) ${extra.join(', ')}`);
  const room = Number(v.room);
  if (!Number.isInteger(room) || room <= 1) throw new Error('patrol.room must be a room number above 1');
  if (!Array.isArray(v.loop) || v.loop.length < 2 || v.loop.length > 64)
    throw new Error('patrol.loop must list 2 to 64 waypoints, each { row, col }');
  const loop = [];
  for (const q of v.loop) {
    if (Array.isArray(q)) throw new Error(`patrol waypoint ${JSON.stringify(q)} is a bare pair; write { row, col } (docs/m59-coordinates.md)`);
    const row = Number(q?.row), col = Number(q?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1)
      throw new Error(`patrol waypoint ${JSON.stringify(q)} is not a whole 1-based { row, col }`);
    const last = loop[loop.length - 1];
    if (last && last.row === row && last.col === col) continue;     // a leg that never moves
    loop.push({ row, col });
  }
  if (loop.length > 1 && loop[0].row === loop[loop.length - 1].row && loop[0].col === loop[loop.length - 1].col) loop.pop();
  if (loop.length < 2) throw new Error('patrol.loop needs at least two different waypoints');
  const out = { room, loop };
  for (const [k, d] of Object.entries(PATROL_DEFAULTS)) {
    if (v[k] === undefined || v[k] === null) { out[k] = d; continue; }
    const n = Number(v[k]), [lo, hi] = LIMITS[k];
    if (typeof v[k] === 'boolean' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`patrol.${k} must be a number from ${lo} to ${hi}`);
    out[k] = n;
  }
  return out;
}

const sq = p => `r${p.row}c${p.col}`;
/** Chebyshev distance in squares, the metric the farm pass already uses for "at" (gang-up, reach). */
export const chebyshev = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const euclid = (a, b) => Math.hypot(a.row - b.row, a.col - b.col);

/** A fresh patrol state. Kept on the keeper (`this._patrol`), never in policy, so nothing persists it. */
export function patrolState() {
  return { index: null, laps: 0, arrivals: 0, resume: true, skipped: {}, last: null };
}

/**
 * The index of the waypoint nearest `self`, among those `reachable(index)` allows, or null.
 * Ties go to the earlier waypoint in loop order, so the answer is stable.
 */
export function nearestWaypoint(loop, self, reachable = () => true) {
  let best = null, bd = Infinity;
  loop.forEach((w, i) => {
    if (!reachable(i)) return;
    const d = euclid(w, self);
    if (d < bd - 1e-9) { bd = d; best = i; }
  });
  return best;
}

/**
 * THE STATE MACHINE. One call per farm pass that found nothing to fight in the patrol room.
 *
 *   patrol     normPatrol's output
 *   state      patrolState(), mutated and returned
 *   self       { row, col } -- where the body is
 *   reachable  (index) -> boolean: can the mover walk from `self` to that waypoint right now. The keeper asks
 *              the walker's own planner; the test hands in a fake.
 *
 * Returns `{ action, target, index, why }`:
 *   'walk'   walk toward `target` (loop[index]) for one bounded piece
 *   'stuck'  no waypoint is reachable from here; the caller falls back to the ordinary empty-pass branch
 *
 * Arrival advances the index (and counts a lap on wrapping) before choosing, so standing on a waypoint walks
 * on to the next. After a fight (`state.resume`) the nearest reachable waypoint is chosen, unless the one we
 * were heading for is within `resumeSlack` of it -- the loop resumes FORWARD. An unreachable target is
 * skipped to the next reachable one and recorded in `state.skipped`.
 */
export function patrolNext(patrol, state, self, reachable = () => true) {
  const n = patrol.loop.length;
  const ok = i => { try { return reachable(i) !== false; } catch { return false; } };
  if (state.resume || state.index == null) {
    const near = nearestWaypoint(patrol.loop, self, ok);
    if (near == null) return { action: 'stuck', target: null, index: state.index, why: 'no waypoint is reachable from ' + sq(self) };
    const cur = state.index;
    const keep = cur != null && ok(cur)
      && euclid(patrol.loop[cur], self) <= euclid(patrol.loop[near], self) + patrol.resumeSlack;
    state.index = keep ? cur : near;
    state.resume = false;
  }
  // Arrived: advance (possibly several times, when consecutive waypoints are within reach of one square).
  for (let k = 0; k < n && chebyshev(patrol.loop[state.index], self) <= patrol.arriveWithin; k++) {
    state.arrivals++;
    const next = (state.index + 1) % n;
    if (next === 0) state.laps++;
    state.index = next;
  }
  // Skip what cannot be walked to from here, in loop order.
  for (let k = 0; k < n; k++) {
    if (ok(state.index)) {
      const target = patrol.loop[state.index];
      state.last = { index: state.index, target: { ...target }, at: Date.now() };
      return { action: 'walk', target, index: state.index, why: `heading for waypoint ${state.index + 1}/${n} ${sq(target)}` };
    }
    const t = patrol.loop[state.index];
    state.skipped[sq(t)] = (state.skipped[sq(t)] ?? 0) + 1;
    const next = (state.index + 1) % n;
    if (next === 0) state.laps++;
    state.index = next;
  }
  return { action: 'stuck', target: null, index: state.index, why: 'no waypoint is reachable from ' + sq(self) };
}

/**
 * THE QUARRY A PATROL ENGAGES: everything within `engageWithin` squares of the body, plus whatever we are
 * already fighting or pulling (`keepIds`) wherever it is. The rest is left for the loop to meet. Applied after
 * every other filter in passFarm (confinement, avoid, hunt area, gang-up) and before the ranking, so it only
 * ever narrows the choice those made.
 */
export function engageFilter(found, self, patrol, keepIds = []) {
  if (!patrol || !self || !Array.isArray(found)) return { kept: found, dropped: 0 };
  const keep = new Set(keepIds.filter(x => x != null));
  const kept = found.filter(o => keep.has(o.id) || euclid(o, self) <= patrol.engageWithin);
  return { kept, dropped: found.length - kept.length };
}

// ------------------------------------------------------------------------------------------------------------
// THE OFFLINE PROOF OF A LOOP. Each leg is planned with the walker's own planner (`geometry.path`, which is
// what Session.walkTo calls first) and then replayed step by step on the mover's predicate: `moverStepLands`,
// except for a pair in the DECLARED jump table, which is how the bake (m59-routebake.mjs walksOnTheMover) and
// the live step treat a fall. The baked route table is reported beside it, because that is what the operator
// was reading when he said a leg was "missing from the bake".

/** Replay a planned leg on the mover. Returns { walks, refused: 'rArcB->rCcD' | null, jumps: [...] }. */
export function replayOnMover(geometry, from, steps) {
  let prev = from;
  const jumps = [];
  for (const s of steps) {
    const big = Math.abs(s.row - prev.row) > 1 || Math.abs(s.col - prev.col) > 1;
    const declared = typeof geometry.declaredFallJumps === 'function'
      && geometry.declaredFallJumps(prev.row, prev.col).some(j => j.row === s.row && j.col === s.col);
    if (declared) jumps.push(`${sq(prev)}->${sq(s)}`);
    else if (big || !geometry.moverStepLands(prev.row, prev.col, s.row, s.col))
      return { walks: false, refused: `${sq(prev)}->${sq(s)}`, jumps };
    prev = s;
  }
  return { walks: true, refused: null, jumps };
}

/**
 * Prove every leg of a loop (closed: the last waypoint leads back to the first).
 * `routesRoom` is that room's entry in substrate/m59-routes.json, or null.
 */
export function validatePatrol(patrol, geometry, { routesRoom = null } = {}) {
  const legs = [];
  const n = patrol.loop.length;
  for (let i = 0; i < n; i++) {
    const a = patrol.loop[i], b = patrol.loop[(i + 1) % n];
    const leg = { index: i, from: sq(a), to: sq(b) };
    leg.from_walkable = geometry.walkable(a.row, a.col) !== false;
    leg.to_walkable = geometry.walkable(b.row, b.col) !== false;
    const plan = geometry.path(a.row, a.col, b.row, b.col);
    leg.planned = !!plan?.found;
    leg.steps = plan?.found ? plan.steps.length : null;
    if (plan?.found) Object.assign(leg, replayOnMover(geometry, a, plan.steps));
    else { leg.walks = false; leg.refused = plan?.reason ?? 'no route'; leg.jumps = []; }
    const key = `${a.row},${a.col}>${b.row},${b.col}`;          // m59-routes/1's serialized row,col key
    leg.baked = routesRoom ? !!routesRoom.routes?.[key] : null;
    leg.baked_reach = routesRoom ? !!routesRoom.reach?.[key] : null;
    leg.pivots = routesRoom?.pivots?.[key]?.squares?.map(([row, col]) => sq({ row, col })) ?? null;
    leg.unverified_pivot_legs = routesRoom?.pivots?.[key]?.unverified ?? null;
    leg.ok = leg.from_walkable && leg.to_walkable && leg.walks === true;
    legs.push(leg);
  }
  return { room: patrol.room, ok: legs.every(l => l.ok), legs };
}

/** `r23c53` -> { row: 23, col: 53 }. Only this spelling: it names its axes. */
export function parseSquare(s) {
  const m = /^r(\d+)c(\d+)$/i.exec(String(s).trim());
  if (!m) throw new Error(`"${s}" is not an rNcM square (r = row, c = col)`);
  return { row: Number(m[1]), col: Number(m[2]) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes('--json');
  if (argv[0] !== 'check') {
    console.log('usage: node tools/m59-patrol-farm.mjs check (--strategy <name> | --room <n> --loop rNcM rNcM ...) [--json]');
    process.exit(argv[0] ? 2 : 0);
  }
  let patrol;
  if (val('--strategy')) {
    // Not through m59-strategy-engine.mjs: it imports the schema, which imports this file, and a top-level
    // await across that cycle never settles. The same search order, read here (docs/m59-strategies.md).
    const name = val('--strategy');
    const here = dirname(fileURLToPath(import.meta.url)), sub = join(here, '..', 'substrate');
    let listed = [];
    try { listed = JSON.parse(readFileSync(join(sub, 'farm-strategy-dirs.json'), 'utf8'))?.dirs ?? []; } catch { listed = []; }
    const dirs = [process.env.M59_FARM_STRATEGY_DIR || join(sub, 'farm-strategies'),
      ...String(process.env.M59_FARM_STRATEGY_PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean),
      ...listed, join(sub, 'farm-strategies.example')];
    const candidates = dirs.map(d => join(d, `${name}.mjs`));
    let mod = null;
    for (const f of candidates) { try { mod = (await import(pathToFileURL(f).href)).default; break; } catch { /* next */ } }
    if (!mod) { console.error(`no strategy file named ${name}`); process.exit(2); }
    patrol = normPatrol(mod.patrol);
    if (!patrol) { console.error(`${name} declares no patrol`); process.exit(2); }
  } else {
    const i = argv.indexOf('--loop');
    const loop = i >= 0 ? argv.slice(i + 1).filter(a => !a.startsWith('--')).map(parseSquare) : [];
    patrol = normPatrol({ room: Number(val('--room')), loop });
  }
  const { loadMap } = await import('./m59-map.mjs');
  const { attachStepMasks } = await import('./m59-routes.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const map = loadMap();
  attachStepMasks(map);
  const room = map.rooms[String(patrol.room)];
  if (!room) { console.error(`room ${patrol.room} is not in the map`); process.exit(2); }
  let routesRoom = null;
  try {
    const t = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-routes.json'), 'utf8'));
    routesRoom = t.rooms?.[String(patrol.room)] ?? null;
  } catch { routesRoom = null; }
  const report = validatePatrol(patrol, sharedRoomGeometry(room), { routesRoom });
  if (json) console.log(JSON.stringify(report, null, 1));
  else {
    console.log(`room ${patrol.room}: ${patrol.loop.length} waypoints, engage within ${patrol.engageWithin} squares`);
    for (const l of report.legs)
      console.log(`  ${l.ok ? 'ok  ' : 'FAIL'} ${l.from} -> ${l.to}: ${l.planned ? `${l.steps} steps planned` : 'no plan'}` +
        `, mover ${l.walks ? 'walks it' : 'REFUSES ' + l.refused}${l.jumps?.length ? ` (declared jump ${l.jumps.join(', ')})` : ''}` +
        `; bake ${l.baked == null ? 'n/a' : l.baked ? `route, ${l.pivots?.length ?? 0} pivots (${l.unverified_pivot_legs} unverified)` : (l.baked_reach ? 'reach only, NO ROUTE' : 'no route')}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
