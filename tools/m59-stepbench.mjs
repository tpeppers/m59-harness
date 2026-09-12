// CONTACT AS A PROPERTY OF ONE STEP, SAMPLED — the bench walkFine needs and has never had.
//
//   import { stepMatrix, recordStep, summariseBench, compareBenches } from './m59-stepbench.mjs';
//
// WHY THIS EXISTS. On prod, 76 legs of fine walking measured out of the mover's own step log:
// SEVENTY-TWO PER CENT OF STEPS HIT SOMETHING, three legs at 100%, mean slide fraction 0.84.
// `move.c` slides along the first blocker rather than refusing, so every contact deflects the body
// off the line it had just validated — net progress 4.5 client units per leg against a 4,958-unit
// crossing, which is about 1,100 legs. Twelve caller-side defects are fixed; the thirteenth is
// inside walkFine's heading fan and slide handling.
//
// THAT CANNOT BE ATTACKED ON PROD. Each measurement costs a forty-minute run, the road kills the
// subject, spawns change the room underneath, and a body cannot be put back on the same square. So
// the bench belongs on the lab server, where `stageAt` puts a body on one square as often as you
// like and `spawnsOff` stops the room breeding — the latter for reproducibility rather than quiet,
// because the server has ONE global rand() stream and a spawn tick shifts everything downstream.
//
// WHAT A BENCH RUN IS. A MATRIX: from one staged square, one single step in each of eight headings
// at each of several distances, repeated N times. Each cell asks one question — "does a step this
// way, this far, from here, make contact?" — and the answer is a rate rather than an anecdote.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not walk anywhere, plan anything, or judge the mover.
// It records what a step did and reduces it to rates. The judgement is `compareBenches`, which says
// whether two matrices differ by more than their own noise, and abstains when they do not — because
// the whole point of a bench is to stop crediting a change that did nothing.
import { analyseLeg } from './m59-steptrace.mjs';

export const HEADINGS = Object.freeze([
  ['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1],
  ['S', 0, 1], ['SW', -1, 1], ['W', -1, 0], ['NW', -1, -1],
]);
/**
 * THE MOVER CANNOT TAKE A STEP SMALLER THAN THIS, so a bench cell below it measures dither.
 *
 * `walkFine` sizes each step `reach = Math.max(8, Math.min(stride, remaining))` (m59-game.mjs:5330).
 * The `Math.max(8, …)` is a FLOOR in protocol units — 128 client units — and it is there on purpose:
 * the comment above it explains that a fixed stride aimed at a point 20 units away overshoots, so the
 * step is capped at what is left. The cap has a floor, and below the floor the overshoot is back.
 *
 * MEASURED, room 576, 2026-09-12, the first baseline run of this bench. Cells aimed 64 client units
 * on the four diagonals: contact 1.0, mean movement 193 units against a 64-unit request, mean
 * deflection 1.512 rad — EIGHTY-SIX DEGREES off the heading asked for. Not geometry. The aim is
 * 90.5 units away, `reach` floors at 128, so the step overshoots, the next step overshoots back, and
 * with a four-step budget the body dithers 193 units sideways. The four cardinal cells at the same
 * distance came back clean — contact 0, exactly 64 units moved, deflection 0 — because a cardinal
 * 64-unit aim is 4 protocol units and lands inside the same dither differently. One number, two
 * grids: 64 is one step of the FLOOD LATTICE (`m59-railcut.LATTICE`) and half of one step of the
 * MOVER. The bench inherited it from the flood and applied it to the mover.
 *
 * Sixth threshold artefact in this codebase, same shape as the other five: a constant that stopped
 * meaning what it meant when a scale changed.
 */
export const MIN_MOVER_REACH_CLIENT = 128;
/** `FINE_STRIDE` (48 protocol) — the largest step the mover takes without being asked to. */
export const MAX_MOVER_REACH_CLIENT = 768;

/**
 * The floor, two steps, and four — every one a distance the mover can actually travel in ONE step.
 *
 * Was `[64, 256, 512]`, and the 64 could not be measured: see MIN_MOVER_REACH_CLIENT.
 */
export const DISTANCES = Object.freeze([128, 256, 512]);

/**
 * Every cell of a bench, in order. Deterministic, so two runs are comparable cell by cell and a
 * disagreement is about the mover rather than about which cells happened to run.
 */
export function stepMatrix({ headings = HEADINGS, distances = DISTANCES, repeats = 3 } = {}) {
  const cells = [];
  for (const [name, dx, dy] of headings)
    for (const d of distances)
      for (let r = 0; r < repeats; r++)
        cells.push({ heading: name, dx, dy, distance: d, repeat: r });
  return cells;
}

/** How far this cell actually asks the body to travel. A diagonal cell asks for `distance` on EACH
 *  axis, so it is `distance * sqrt(2)` — 1.41x the nominal. Naming it stops the two being confused. */
export const cellReach = (cell) => Math.hypot(cell.dx * cell.distance, cell.dy * cell.distance);

/**
 * IS THIS CELL MEASURABLE AT ALL? Returns null when it is, or the reason it is not.
 *
 * A bench that reports a rate for a cell the mover cannot execute is worse than one that skips it,
 * because the rate looks like evidence about geometry.
 */
export function checkCell(cell) {
  const reach = cellReach(cell);
  if (reach < MIN_MOVER_REACH_CLIENT)
    return `aims ${Math.round(reach)} client units, below the mover's ${MIN_MOVER_REACH_CLIENT}-unit ` +
           `minimum step (walkFine's reach floors at 8 protocol units) — the step overshoots and the ` +
           `body dithers, so this measures the fan searching and not contact`;
  if (reach > MAX_MOVER_REACH_CLIENT)
    return `aims ${Math.round(reach)} client units, past the mover's ${MAX_MOVER_REACH_CLIENT}-unit ` +
           `default stride — it takes more than one step, so this is a walk and not a step`;
  return null;
}

/**
 * THE WALK ARGUMENTS FOR ONE CELL. In this module because the request and the recording have to
 * agree about what a cell means, and when they lived apart they did not.
 *
 * TWO SETTINGS ARE LOAD-BEARING AND BOTH WERE WRONG IN THE FIRST BASELINE RUN.
 *
 * `max_steps: 1`. More than one step is not a measurement of a step, it is a SEARCH. This bench's
 * first run passed `max(4, ceil(distance/64) + 2)`, so every cell got at least four steps; walkFine
 * spends a budget it is given by fanning headings and re-stepping (m59-game.mjs:9503 — "asks to land
 * within ONE fine unit … and `walkFine` pursues that by fanning nine headings and re-stepping until
 * its budget runs out"), and the result was 193 units of travel at 86 degrees off a 64-unit request.
 * The codebase had this trap written down, in the mover, next to the line that causes it.
 *
 * `arrive_within: 1`, and it is in KOD units — 16 client units, a 16x trap of its own. It must be
 * strictly SMALLER than the aim or walkFine returns `arrived: true, steps: 0` without moving
 * (m59-game.mjs:5319), which `recordStep` then correctly flags as a false arrival — a bench that
 * manufactures its own headline finding. The default is 40 KOD = 640 CLIENT units, which would make
 * every cell here vacuous. With one step allowed the tolerance cannot cause dither, so the smallest
 * honest value is the right one.
 */
export function stepRequest(cell, fromClient, { holdShelf = true } = {}) {
  const bad = checkCell(cell);
  if (bad) return { ok: false, why: bad, cell };
  const aimClient = { x: fromClient.x + cell.dx * cell.distance,
                      y: fromClient.y + cell.dy * cell.distance };
  // client -> protocol, inline rather than imported: this module stays pure so its test needs no
  // socket, and m59-finepos drags node:http in behind it.
  const toProtocol = (p) => ({ x: Math.round(p.x / 16 + 64), y: Math.round(p.y / 16 + 64) });
  const aim = toProtocol(aimClient);
  return {
    ok: true, cell, aimClient, requested: cellReach(cell),
    args: { x: aim.x, y: aim.y, hold_shelf: holdShelf, arrive_within: 1, max_steps: 1 },
  };
}

/**
 * One cell's result, from the walk reply and the two position reads around it.
 *
 * `before`/`after` are the body's CLIENT-unit positions, read from the keeper rather than from the
 * reply — a reply's `arrived` has been wrong on this codebase eleven times in a row, and the
 * position is the receipt.
 */
export function recordStep(cell, { reply, before, after, keeperPid = null }) {
  // THE TRUE REACH, not the nominal one. `analyseLeg` judges BLOCKED relatively — min(128,
  // requested * 0.4) — so handing it 64 for a diagonal cell that actually asked for 90.5 moved the
  // threshold by 1.41x on exactly half the matrix.
  const a = analyseLeg(reply, { requested: cellReach(cell),
                                from: before ? { x: Math.round(before.x / 16 + 64),
                                                 y: Math.round(before.y / 16 + 64) } : null });
  const movedBy = before && after
    ? Math.round(Math.hypot(after.x - before.x, after.y - before.y)) : null;
  // THE INTENDED DIRECTION VERSUS THE ACTUAL ONE. A slide is a deflection, so the angle between
  // what was asked and what happened is the thing the fan is getting wrong — and it is invisible
  // in a distance-only measurement.
  let deflection = null;
  if (before && after && movedBy && movedBy > 0) {
    const want = Math.atan2(cell.dy, cell.dx);
    const got = Math.atan2(after.y - before.y, after.x - before.x);
    let d = Math.abs(want - got);
    while (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
    deflection = +d.toFixed(3);
  }
  return {
    ...cell,
    movedBy, deflection,
    contacted: (a.slid ?? 0) > 0 || (reply?.shelf_refusals ?? 0) > 0,
    slid: a.slid ?? 0, stepsLogged: a.stepsLogged ?? 0,
    shelfRefusals: reply?.shelf_refusals ?? 0,
    arrived: reply?.arrived ?? null, reason: reply?.reason ?? null,
    // A STEP THAT MOVED NOTHING IS NOT THE SAME AS ONE THAT WAS REFUSED, and `arrived: true` with
    // zero movement is the shape this codebase keeps believing.
    falseArrival: reply?.arrived === true && movedBy === 0,
    keeperPid,
  };
}

/** Rates per cell group, and the numbers a mover change would have to move. */
export function summariseBench(rows) {
  if (!rows?.length) return { cells: 0 };
  const by = new Map();
  for (const r of rows) {
    const k = `${r.heading}@${r.distance}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const groups = [...by.entries()].map(([key, rs]) => {
    const moved = rs.filter((r) => (r.movedBy ?? 0) > 0);
    return {
      key, n: rs.length,
      contactRate: +(rs.filter((r) => r.contacted).length / rs.length).toFixed(2),
      falseArrivals: rs.filter((r) => r.falseArrival).length,
      movedRate: +(moved.length / rs.length).toFixed(2),
      meanMoved: moved.length ? Math.round(moved.reduce((t, r) => t + r.movedBy, 0) / moved.length) : 0,
      meanDeflection: moved.filter((r) => r.deflection != null).length
        ? +(moved.filter((r) => r.deflection != null)
              .reduce((t, r) => t + r.deflection, 0) / moved.filter((r) => r.deflection != null).length).toFixed(3)
        : null,
    };
  }).sort((a, b) => b.contactRate - a.contactRate);
  const all = rows.length;
  return {
    cells: all,
    contactRate: +(rows.filter((r) => r.contacted).length / all).toFixed(2),
    falseArrivals: rows.filter((r) => r.falseArrival).length,
    movedRate: +(rows.filter((r) => (r.movedBy ?? 0) > 0).length / all).toFixed(2),
    keeperPids: [...new Set(rows.map((r) => r.keeperPid).filter(Boolean))],
    groups,
  };
}

/**
 * Did a mover change actually change anything? Abstains unless the difference exceeds what repeats
 * of the SAME build already disagree by — because crediting a change that did nothing is the
 * failure this whole bench exists to prevent, and a bench that always finds an improvement is a
 * press release.
 */
export function compareBenches(before, after, { minDelta = 0.1 } = {}) {
  if (!before?.cells || !after?.cells)
    return { verdict: 'unknown', why: 'one of the two benches has no cells' };
  if (before.keeperPids?.length && after.keeperPids?.length &&
      before.keeperPids.some((p) => after.keeperPids.includes(p)))
    return { verdict: 'SAME BUILD?', why: `both benches share keeper pid(s) ` +
             `${before.keeperPids.filter((p) => after.keeperPids.includes(p)).join(',')} — a keeper ` +
             `respawn is what loads new mover code, so without one these may be the same build` };
  const d = +(before.contactRate - after.contactRate).toFixed(2);
  if (Math.abs(d) < minDelta)
    return { verdict: 'NO DIFFERENCE', delta: d,
             why: `contact rate moved ${d} (${before.contactRate} -> ${after.contactRate}), inside ` +
                  `the ${minDelta} band this bench treats as noise — claim nothing` };
  return { verdict: d > 0 ? 'BETTER' : 'WORSE', delta: d,
           why: `contact rate ${before.contactRate} -> ${after.contactRate}, a change of ${Math.abs(d)}` };
}

export function formatBench(s) {
  if (!s?.cells) return 'no cells';
  const head = `${s.cells} cell(s): contact ${s.contactRate}, moved ${s.movedRate}, ` +
               `${s.falseArrivals} false arrival(s), keeper pid(s) ${s.keeperPids.join(',') || '?'}`;
  const worst = s.groups.slice(0, 8).map((g) =>
    `    ${g.key.padEnd(8)} contact ${g.contactRate}  moved ${g.movedRate} (mean ${g.meanMoved}u)` +
    `  deflection ${g.meanDeflection ?? '-'}`);
  return [head, ...worst].join('\n');
}
