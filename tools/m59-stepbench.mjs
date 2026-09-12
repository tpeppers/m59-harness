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
/** One lattice step, four, and eight — the same reaches m59-ground probes. */
export const DISTANCES = Object.freeze([64, 256, 512]);

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

/**
 * One cell's result, from the walk reply and the two position reads around it.
 *
 * `before`/`after` are the body's CLIENT-unit positions, read from the keeper rather than from the
 * reply — a reply's `arrived` has been wrong on this codebase eleven times in a row, and the
 * position is the receipt.
 */
export function recordStep(cell, { reply, before, after, keeperPid = null }) {
  const a = analyseLeg(reply, { requested: cell.distance,
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
