// WHAT THE MOVER DID, STEP BY STEP — read out of the reply it already sends.
//
//   import { analyseLeg, summariseLegs, verdictOf } from './m59-steptrace.mjs';
//   node tools/m59-steptrace.mjs <legs.jsonl>        analyse a captured run
//
// `walkFine` returns a `log` of steps — `{ step, slid, to: { x, y, col, row } }` — and every rail
// follower in this repository has thrown it away, mine included, for a whole night of debugging.
// `arrived` and `reason` are a two-word summary of forty steps. The log is the forty steps.
//
// WHAT IT ANSWERS THAT THE REPLY DOES NOT.
//
//   "ran out of steps" is one reason with at least four causes, and they want different fixes:
//     BLOCKED      almost every step slid and the body barely moved -> the heading is wrong
//     GRINDING     steps gained ground then gave it back -> oscillation, the shuffle this repo
//                  has warned about for months with nothing measuring it
//     SLOW         steps gained ground steadily and the budget was simply too small -> raise it
//     TELEPORTED   the body jumped further than a step can carry it -> a fall, or another writer
//
//   Without the log those four are indistinguishable, which is why "ran out of steps" was read as
//   a wall, then as a timeout, then as a wedge, on three consecutive nights.
//
// UNITS. `to` is in KOD PROTOCOL units, as the wire speaks. Distances are reported in CLIENT units
// (x16) because the geometry and every rail in `substrate/` are client units, and mixing the two
// has cost this repository two commits. `slid` is RADIANS of heading rotation: move.c slides along
// the first blocker rather than refusing, so a slid step is the mover feeling a wall.
export const PROTOCOL_TO_CLIENT = 16;
/** A step cannot legitimately carry a body further than this in client units (run pace, one tick). */
export const MAX_PLAUSIBLE_STEP = 320;

const dist = (a, b) => Math.hypot((b.x - a.x), (b.y - a.y)) * PROTOCOL_TO_CLIENT;

/**
 * Turn one leg's reply into per-step numbers.
 *
 * `requested` is the client-unit distance the caller asked for, so "slow" can be told from
 * "blocked" — without it, a leg that moved 200 of 2496 units looks the same as one that moved 200
 * of 210.
 */
export function analyseLeg(reply, { requested = null, from = null } = {}) {
  const log = Array.isArray(reply?.log) ? reply.log : [];
  const points = [];
  if (from) points.push({ step: -1, ...from });
  for (const e of log) if (e?.to && Number.isFinite(e.to.x)) points.push({ step: e.step, ...e.to });

  // THE LOG IS SAMPLED, SO A GAP BETWEEN ENTRIES IS NOT ONE STEP.
  //
  // walkFine logs notable steps, not every step: a real reply reads `step 0, step 2, step 4`. So
  // the distance between consecutive ENTRIES covers as many steps as their numbers are apart, and
  // judging it against one step's worth of travel invents teleports. Measured 2026-09-12: the
  // first live run of this analyser reported TELEPORTED on four of seven legs, all of them
  // ordinary walking, because of exactly that. `spanned` is how many steps an entry accounts for.
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    const a = Number(points[i - 1].step), b = Number(points[i].step);
    const spanned = Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, b - a) : 1;
    steps.push({ step: points[i].step, gained: Math.round(d), spanned,
                 perStep: Math.round(d / spanned),
                 slid: Number(log.find((e) => e.step === points[i].step)?.slid ?? 0) || 0,
                 at: { x: points[i].x, y: points[i].y, col: points[i].col, row: points[i].row } });
  }
  const slidCount = log.filter((e) => Number(e?.slid ?? 0) !== 0).length;
  const net = points.length > 1 ? Math.round(dist(points[0], points[points.length - 1])) : 0;
  const travelled = steps.reduce((n, s) => n + s.gained, 0);
  // REVISITS ARE THE SHUFFLE. A body that returns to a protocol point it has already occupied is
  // grinding, and every stillness-based stall detector reads that as healthy movement.
  const seen = new Map();
  for (const p of points) {
    const k = `${p.x},${p.y}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const revisits = [...seen.values()].filter((n) => n > 1).reduce((n, v) => n + v - 1, 0);
  // Judged PER STEP, not per log entry — see the note on sampling above.
  const teleports = steps.filter((s) => s.perStep > MAX_PLAUSIBLE_STEP);

  return {
    arrived: reply?.arrived ?? null, reason: reply?.reason ?? null,
    stepsLogged: log.length, stepsMeasured: steps.length,
    slid: slidCount,
    slidFraction: log.length ? +(slidCount / log.length).toFixed(2) : null,
    net, travelled,
    // WASTE is the number that matters: ground covered that did not get you anywhere.
    waste: Math.max(0, travelled - net),
    efficiency: travelled > 0 ? +(net / travelled).toFixed(2) : null,
    requested, shortfall: requested != null ? Math.max(0, requested - net) : null,
    revisits, teleports, steps,
    shelfRefusals: reply?.shelf_refusals ?? null,
    geometryRejections: reply?.geometry_rejections ?? null,
  };
}

/**
 * Which of the four causes is this, in the analyser's own words? `unknown` is a real answer and is
 * returned rather than guessed — a verdict that cannot abstain will label noise.
 */
export function verdictOf(a, { blockedTravelled = 128, grindWaste = 256, slowAbove = 0.8 } = {}) {
  if (!a || a.stepsMeasured === 0)
    return { verdict: 'unknown', why: 'the reply carried no usable step log — nothing to read' };
  if (a.teleports.length)
    return { verdict: 'TELEPORTED', why: `${a.teleports.length} step(s) covered more than ` +
             `${MAX_PLAUSIBLE_STEP} client units EACH, which a walk cannot: a fall, or another ` +
             `writer moved the body mid-leg` };
  // ORDER MATTERS AND THE TESTS SETTLED IT. `BLOCKED` means the body COULD NOT MOVE — travelled
  // almost nothing, whatever its efficiency ratio says. `GRINDING` means it moved plenty and
  // arrived nowhere. The first cut checked efficiency first, so an out-and-back leg that covered
  // 3200 client units of real ground was labelled BLOCKED because its NET was zero, and the
  // genuinely immobile case fell through to MIXED because travelled:0 makes efficiency null.
  // Those are different bugs wanting different fixes, so they get different tests.
  if (a.travelled <= blockedTravelled)
    return { verdict: 'BLOCKED', why: `${a.slid} of ${a.stepsLogged} step(s) slid and the body ` +
             `travelled ${a.travelled} client units in total — it could not move at all, so the ` +
             `heading is wrong, not the budget` };
  if (a.waste >= grindWaste && a.revisits > 0)
    return { verdict: 'GRINDING', why: `${a.waste} client units of travel gained nothing and the ` +
             `body revisited ${a.revisits} point(s) — this is the shuffle, and a stillness-based ` +
             `stall detector reads it as healthy` };
  if (a.efficiency != null && a.efficiency >= slowAbove && a.shortfall > 0)
    return { verdict: 'SLOW', why: `the body moved efficiently (${a.efficiency}) and still fell ` +
             `${a.shortfall} client units short — the budget was too small, nothing is blocking` };
  return { verdict: 'MIXED', why: `efficiency ${a.efficiency}, waste ${a.waste}, ` +
           `${a.revisits} revisit(s), ${a.slid} slid of ${a.stepsLogged}` };
}

/** Across many legs: where the ground is actually being lost. */
export function summariseLegs(analyses) {
  const n = analyses.length;
  if (!n) return { legs: 0 };
  const sum = (f) => analyses.reduce((t, a) => t + (f(a) || 0), 0);
  const byVerdict = new Map();
  for (const a of analyses) {
    const v = verdictOf(a).verdict;
    byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
  }
  return {
    legs: n,
    netTotal: sum((a) => a.net), travelledTotal: sum((a) => a.travelled),
    wasteTotal: sum((a) => a.waste),
    wasteFraction: sum((a) => a.travelled) > 0
      ? +(sum((a) => a.waste) / sum((a) => a.travelled)).toFixed(2) : null,
    revisitsTotal: sum((a) => a.revisits),
    slidFractionMean: +(sum((a) => a.slidFraction ?? 0) / n).toFixed(2),
    verdicts: [...byVerdict.entries()].sort((x, y) => y[1] - x[1]).map(([v, c]) => ({ verdict: v, legs: c })),
  };
}

export function formatLeg(a) {
  const v = verdictOf(a);
  return `${v.verdict.padEnd(10)} net ${String(a.net).padStart(5)}u of ${String(a.travelled).padStart(5)}u ` +
         `travelled (waste ${a.waste}u, eff ${a.efficiency ?? '-'}), ` +
         `${a.slid}/${a.stepsLogged} slid, ${a.revisits} revisit(s)` +
         (a.reason ? `  [${a.reason}]` : '') + `\n            ${v.why}`;
}

async function main(argv) {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { console.log('usage: node tools/m59-steptrace.mjs <legs.jsonl>'); return 2; }
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const analyses = rows.map((r) => analyseLeg(r.reply ?? r, { requested: r.requested ?? null,
                                                              from: r.from ?? null }));
  analyses.forEach((a, i) => console.log(`leg ${String(i).padStart(3)}  ${formatLeg(a)}`));
  console.log('\n' + JSON.stringify(summariseLegs(analyses), null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('m59-steptrace.mjs'))
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
