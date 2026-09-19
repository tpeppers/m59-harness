#!/usr/bin/env node
// WHEN A CROSSING IS REFUSED, ASK WHETHER IT IS A DOOR.
//
//   node tools/m59-doorplan.mjs 714            every operable door in the room, and where to stand
//   node tools/m59-doorplan.mjs 714 r4c28      what the body standing there can work
//
// THE DECISION, AS A PURE FUNCTION, so the router can consult it and a test can check it
// without a fleet. `m59-guild-passage.mjs` already knows how to WORK a door — press, wait on
// the server's own `sector-height` event, step through — but it is reached only by an errand
// asking to visit the chests, and its door table is hand-written for one hall. This is the
// half that was missing: given a room and a body, WHICH door is in the way and how is it
// worked. With it, "operate the door" stops being something only an errand can call.
//
// WHY A REFUSAL IS NOT AN ANSWER HERE. The mover enforces one frozen sector state, so a shut
// door is `geometry_blocked` and a room of shut doors is a room with no exits. That is the
// truth about the BAKE and not about the world: room 714's six doors all open on request, and
// on 2026-09-19 three characters sat in it — two of them standing ON `r4c28`, which is
// MAIN_DOOR's trigger, with the hall's only exit two squares past it.
//
// THE PLAN THIS PRODUCES IS THREE STEPS AND A DEADLINE:
//
//   1. stand on a trigger square and attempt a `go` — `SomethingTryGo` receives the
//      character's OWN position (`user.kod:5669` sends `#row=piRow #col=piCol`), so the
//      trigger is where you ARE, not where you are heading;
//   2. WAIT FOR THE SERVER TO SAY IT MOVED, never a guessed delay. The sector animates, and a
//      geometry read taken mid-swing sees a shut door — which is the race
//      `m59-guild-passage.mjs` records as `no live path across the open door`, a sentence that
//      reads exactly like "there is no way out of this room";
//   3. step through, inside `shuts_after_ms` of the PRESS — the close timer starts when the
//      door is asked, not when it finishes opening, so the animation eats into the window.
//
// AND A GATE IS A REASON NOT TO GO AT ALL. 714's main door asks `ReqLegalEntry` and its two
// lifts ask `IsMember`; routing an outsider at one produces a body standing on a trigger that
// will never fire, which is the failure this is meant to end rather than relocate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inRegion } from './m59-codeexits.mjs';

const DOORS_FILE = fileURLToPath(new URL('../substrate/m59-doors.json', import.meta.url));

let cached;
/** The derived door table. Absent is an answer — a checkout without it simply has no doors. */
export function loadDoors(file = DOORS_FILE) {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}
/** For tests, which must not inherit another case's table. */
export function resetDoors() { cached = undefined; }

export function doorsInRoom(roomNum, table = loadDoors()) {
  return table?.rooms?.[String(roomNum)]?.doors ?? [];
}

/**
 * Every square that arms this door, inside the room's own bounds.
 *
 * `inRegion` is imported rather than reimplemented: it is the evaluator `World.exits()` uses,
 * and it reads same-axis equalities as ALTERNATIVES. A second copy of that rule is how a
 * two-square doorway once read as the impossible `row == 17 and row == 18`.
 */
export function triggerSquares(door, { rows, cols }) {
  const out = [];
  if (!(rows > 0) || !(cols > 0)) return out;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (inRegion(door.when ?? [], r, c)) out.push({ row: r, col: c });
  return out;
}

/**
 * The three-step plan for one door, with the numbers a caller has to respect.
 *
 * `wait_for` is an EVENT and not a duration on purpose — see the header. `within_ms` is the
 * whole window from the press, which is what the caller is racing.
 */
export function pressPlan(door, size) {
  return {
    sector: door.sector,
    name: door.sector_name,
    stand_on: triggerSquares(door, size),
    wait_for: { event: 'sector-height', sector: door.sector, reaches: door.open },
    within_ms: door.delay_ms ?? null,
    shuts_itself: door.delay_ms != null,
    kind: door.kind,
    from_height: door.closed, to_height: door.open,
    gate: door.gate ?? null,
  };
}

/**
 * What can a body standing here work?
 *
 * `on` is the door whose trigger this square already is — the case that matters, because a
 * character that has walked to the door and stopped is standing on the button. `reachable`
 * is everything else in the room, for a caller that can walk first.
 */
export function doorsFor(roomNum, at, { size, table = loadDoors() } = {}) {
  const doors = doorsInRoom(roomNum, table);
  const room = table?.rooms?.[String(roomNum)];
  const dims = size ?? { rows: room?.rows, cols: room?.cols };
  const plans = doors.map(d => pressPlan(d, dims));
  const here = (p) => at && p.stand_on.some(s => s.row === at.row && s.col === at.col);
  return {
    room: roomNum,
    on: plans.filter(here),
    others: plans.filter(p => !here(p)),
    // A CALLER THAT CANNOT PASS THE GATE SHOULD NOT BE SENT AT THE DOOR. Reported rather than
    // filtered, because whether this character is a member is not this function's to know.
    gated: plans.filter(p => p.gate).map(p => ({ sector: p.sector, gate: p.gate })),
  };
}

/**
 * THE ROUTER'S QUESTION: this room refused every exit — is that because of a door?
 *
 * Returns null when the room has no operable doors, so a caller can keep its existing verdict
 * unchanged. Anything else is a reason not to call the room sealed.
 */
export function operableDoorsBlocking(roomNum, at, opts = {}) {
  const f = doorsFor(roomNum, at, opts);
  if (!f.on.length && !f.others.length) return null;
  return {
    room: roomNum,
    standing_on: f.on.map(p => p.sector),
    doors: [...f.on, ...f.others].map(p => ({
      sector: p.sector, name: p.name, gate: p.gate,
      stand_on: p.stand_on.slice(0, 8).map(s => `r${s.row}c${s.col}`),
      shuts_after_ms: p.within_ms,
    })),
    why: f.on.length
      ? `the body is standing ON the trigger for sector ${f.on.map(p => p.sector).join(', ')} — ` +
        'a `go` from here opens it. The exits are not exhausted, they are shut'
      : `this room has ${f.others.length} operable door(s); the bake holds them in one state, ` +
        'so "no exit progresses" is a fact about that state and not about the room',
  };
}

if (process.argv[1]?.endsWith('m59-doorplan.mjs')) {
  const room = Number(process.argv[2]);
  const m = /^r(\d+)c(\d+)$/.exec(process.argv[3] ?? '');
  const at = m ? { row: Number(m[1]), col: Number(m[2]) } : null;
  const table = loadDoors();
  if (!table) { console.error('no substrate/m59-doors.json — run: node tools/m59-doors.mjs --write'); process.exit(1); }
  if (!Number.isFinite(room)) { console.error('usage: m59-doorplan.mjs <room> [rNcM]'); process.exit(2); }
  const r = table.rooms[String(room)];
  if (!r) { console.log(`room ${room} has no operable doors in the table`); process.exit(0); }
  console.log(`room ${room} — ${r.name}`);
  const f = doorsFor(room, at, { table });
  if (at) console.log(`  a body at r${at.row}c${at.col} is standing on: ` +
                      (f.on.length ? f.on.map(p => `${p.sector} ${p.name}`).join(', ') : 'no trigger'));
  for (const p of [...f.on, ...f.others]) {
    console.log(`\n  sector ${p.sector} ${p.name}${p.gate ? '  [' + p.gate + ']' : ''}`);
    console.log(`    1. stand on any of: ${p.stand_on.map(s => `r${s.row}c${s.col}`).join(' ') || '(none in bounds)'} and attempt a go`);
    console.log(`    2. wait for ${p.wait_for.event} on sector ${p.sector} reaching ${p.wait_for.reaches}` +
                ` — the event, not a delay: a read mid-swing sees a shut door`);
    console.log(`    3. step through within ${p.within_ms ?? '(it does not shut itself)'}` +
                `${p.within_ms ? 'ms of the PRESS' : ''}`);
  }
}
