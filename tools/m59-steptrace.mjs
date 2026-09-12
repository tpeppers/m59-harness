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
/**
 * THE SMALLEST STEP THE MOVER CAN TAKE, in client units, and the number two of this repository's own
 * modules disagree about.
 *
 * `walkFine` sizes each step `reach = Math.max(8, Math.min(stride, remaining))` (m59-game.mjs:5330).
 * The floor is 8 PROTOCOL units — 128 client — and it exists so a short aim does not overshoot and
 * dither. `m59-railcut` floods on a 64-client-unit lattice, so "one lattice step" is HALF of what the
 * mover can execute: asked for it, walkFine answers `arrived: true, steps: 0` and nothing moves.
 * Shared with m59-stepbench's MIN_MOVER_REACH_CLIENT, which is the same fact measured from the bench.
 */
export const MIN_MOVER_STEP = 128;

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
    ...slideShape(log),
  };
}

/**
 * WHICH WAY THE FAN KEPT TURNING — the half of a slide that a count of slides throws away.
 *
 * `slidFraction` says how often the body was deflected. It cannot say whether those deflections
 * CANCELLED or ACCUMULATED, and that is the difference between two completely different bugs:
 *
 *   ALTERNATING (+0.35, -0.35, +0.35, ...)  a zigzag. Wasteful, and it still converges.
 *   SAME SIGN   (+0.35, +0.35, +0.35, ...)  an ORBIT. It does not converge at all, because
 *                                           walkFine re-aims the base heading at the goal every
 *                                           step, so a constant offset is a constant turn.
 *
 * MEASURED on Marco's 169 logged legs across room 49, 697 steps: offset +0.35 on 72.5% of them,
 * alternation 0.15 — so 511 of 600 consecutive slides KEPT their sign — and the direct heading was
 * available on ZERO steps out of 697. Efficiency 0.07. The worst leg walked 66 steps and 11,840
 * client units for a net displacement of nothing at all, which is a closed loop rather than a
 * shuffle. Whole sessions were spent reading that as slide loss; slide loss at 0.35 rad costs 6% of
 * cross-track per step, and the measured loss was 93%.
 */
export function slideShape(log) {
  const slides = (Array.isArray(log) ? log : [])
    .map((e) => Number(e?.slid ?? 0) || 0);
  if (!slides.length) return { directTaken: null, slideAlternation: null, slideBias: null };
  const nonZero = slides.filter((s) => s !== 0);
  const signs = nonZero.map((s) => (s > 0 ? 1 : -1));
  let changes = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) changes++;
  const counts = new Map();
  for (const s of nonZero) counts.set(s, (counts.get(s) ?? 0) + 1);
  const [offset, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return {
    // HOW OFTEN THE MOVER GOT TO GO WHERE IT MEANT TO. Zero is a fact about the ground or the aim,
    // never about the fan: the fan only runs because heading 0 was refused.
    directTaken: slides.length - nonZero.length,
    slideAlternation: signs.length > 1 ? +(changes / (signs.length - 1)).toFixed(2) : null,
    slideBias: offset == null ? null
      : { offset, steps: n, share: +(n / nonZero.length).toFixed(2) },
  };
}

/**
 * Which of the four causes is this, in the analyser's own words? `unknown` is a real answer and is
 * returned rather than guessed — a verdict that cannot abstain will label noise.
 */
export function verdictOf(a, { blockedTravelled = 128, grindWaste = 256, slowAbove = 0.8,
                               orbitEfficiency = 0.3, orbitAlternation = 0.35,
                               orbitMinSlides = 4 } = {}) {
  if (!a) return { verdict: 'unknown', why: 'no analysis to read' };
  // AN EMPTY LOG WITH REFUSALS IS NOT "UNKNOWN" — IT IS THE GUARD SPEAKING.
  //
  // walkFine logs steps it took, so a leg where every heading was refused logs NOTHING. Scoring
  // that as unknown throws away the loudest signal in the reply. Measured 2026-09-12: twenty legs
  // of twenty-two came back with `log: 0 entries` and `shelf_refusals: 70..72`, which is not an
  // absence of data — it is the shelf guard refusing seventy headings because the aim was across
  // off-shelf ground. The aim was wrong; the guard was right; the log was empty for a reason.
  if (a.stepsMeasured === 0 && (a.shelfRefusals ?? 0) > 0)
    return { verdict: 'GUARD-REFUSED', why: `no step was taken and the shelf guard refused ` +
             `${a.shelfRefusals} heading(s) — the aim crosses ground off the destination's shelf, ` +
             `so the guard is right and the AIM is what needs fixing` };
  // AN EMPTY LOG WITH `arrived: true` IS THE LOUDEST SIGNAL IN THE REPLY, NOT AN ABSENCE OF ONE.
  //
  // walkFine returns `{ arrived: true, steps: 0, log: [] }` the moment `remaining <= arriveWithin`
  // (m59-game.mjs:5319). So the mover is not refusing and it is not failing — it is being asked to
  // walk somewhere it is already standing, and it is answering correctly. The CALLER is the bug.
  //
  // MEASURED on Marco's 169 legs in room 49: FIFTY-THREE of them, 31%, were this — and 41 of the 53
  // asked for less than 128 client units, which is `walkFine`'s own minimum step
  // (`reach = max(8, min(stride, remaining))`, 8 protocol units). Requested distances of 16, 32 and
  // 93 client units, over and over.
  //
  // THE MECHANISM, and it is a unit mismatch between two of this repository's own modules.
  // `m59-railcut` floods and cuts rails on a 64-client-unit LATTICE, and `furthestTraceable` falls
  // back to "aiming one lattice step" whenever no longer chord is walkable. One lattice step is 64
  // units. The mover cannot take a step smaller than 128. So a follower in that fallback asks for a
  // step that does not exist, is told it has already arrived, advances its waypoint index, and
  // repeats — which is net progress of a few units per leg against a 4,958-unit crossing, with every
  // single call reporting success. Filed as `unknown` it read as missing telemetry; it is the
  // loudest thing in the file.
  if (a.stepsMeasured === 0 && a.arrived === true)
    return { verdict: 'ALREADY-THERE', why: `no step was taken and the mover reported arrived: the ` +
             `aim was already inside arriveWithin` +
             (a.requested != null
               ? `, ${a.requested} client units away` +
                 (a.requested < MIN_MOVER_STEP
                   ? ` — BELOW the mover's ${MIN_MOVER_STEP}-unit minimum step, so no step this ` +
                     `close can ever be taken and re-issuing it will not help. The AIM is the bug: ` +
                     `aim at least ${MIN_MOVER_STEP} units ahead, skipping waypoints until it clears`
                   : '')
               : '') };
  if (a.stepsMeasured === 0)
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
  // BLOCKED IS RELATIVE TO WHAT WAS ASKED FOR, NOT AN ABSOLUTE. A constant floor of 128 client
  // units labelled every step-mode leg BLOCKED — 39 of 49 — because a leg that REQUESTS 64 units
  // and travels 35 of them trips an absolute threshold designed for legs requesting thousands.
  // That is the fifth threshold this repository has had stop meaning what it meant when a scale
  // changed around it (the stall high-water mark, cross-track as a fraction of the budget,
  // arrive_within, the 64-unit movement floor, and this). A threshold has to name what it is
  // relative to, or it silently becomes a different test.
  const floor = a.requested != null ? Math.min(blockedTravelled, a.requested * 0.4) : blockedTravelled;
  if (a.travelled <= floor)
    return { verdict: 'BLOCKED', why: `${a.slid} of ${a.stepsLogged} step(s) slid and the body ` +
             `travelled ${a.travelled} client units against ${a.requested ?? '?'} requested — it ` +
             `barely moved, so the heading is wrong, not the budget` };
  // AN ORBIT IS NOT A GRIND, AND `GRINDING` CANNOT SEE IT — it requires a revisited protocol point,
  // and a body circling at any radius need never land on one twice. So the worst legs this repository
  // has ever logged fell through to MIXED, which reads as "a bit of everything" rather than as the
  // single most expensive mechanism in the mover.
  //
  // THE MECHANISM. walkFine re-aims the base heading at the goal on every step and then adds the fan
  // offset. A constant offset is therefore a constant TURN relative to the goal, which is a circle
  // around it — the body is always walking twenty degrees to one side of where it means to go, and
  // arrives nowhere however long it walks. Alternating offsets cancel and still converge; same-sign
  // offsets do not. That distinction is invisible in a slide COUNT, which is all this tool used to
  // report.
  //
  // Marco, room 49, 169 legs and 697 steps: +0.35 on 72.5% of steps, alternation 0.15, the direct
  // heading taken ZERO times, efficiency 0.07. One leg: 66 steps, 11,840 client units, net zero.
  if (a.efficiency != null && a.efficiency <= orbitEfficiency &&
      a.slideAlternation != null && a.slideAlternation <= orbitAlternation &&
      (a.slideBias?.steps ?? 0) >= orbitMinSlides)
    return { verdict: 'ORBIT', why: `${a.slideBias.steps} step(s) slid ${a.slideBias.offset > 0 ? '+' : ''}` +
             `${a.slideBias.offset} rad (${Math.round(a.slideBias.share * 100)}% of slides) with ` +
             `alternation ${a.slideAlternation} — the deflections KEPT their sign rather than ` +
             `cancelling, and walkFine re-aims at the goal every step, so a constant offset is a ` +
             `constant turn: the body circled. ${a.travelled} client units travelled for ${a.net} ` +
             `net (efficiency ${a.efficiency})` +
             (a.directTaken === 0 ? `, and the direct heading was available on NONE of the ` +
              `${a.stepsLogged} logged steps — the aim is the thing to fix, not the fan` : '') };
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
