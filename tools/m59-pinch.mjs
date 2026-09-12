#!/usr/bin/env node
// WHERE DOES THE MOVER ACTUALLY HAVE TO CHOOSE — the squares where a heading is refused.
//
//   node tools/m59-pinch.mjs --room 576               the whole room, most constrained first
//   node tools/m59-pinch.mjs --room 576 --at r87c59   one square: would a mover change show here?
//   node tools/m59-pinch.mjs --room 49 --json
//
// WHY THIS EXISTS, AND IT IS A QUESTION ABOUT EXPERIMENTS RATHER THAN ABOUT GEOMETRY.
//
// `walkFine` falls back to a fan of headings when the direct one is refused — nine of them, or five
// under `hold_shelf`. Everything this repository suspects about slide behaviour and wasted travel is
// suspicion about that fan. So the obvious move is to change it and measure. The trap is that ON OPEN
// GROUND THE FAN NEVER RUNS: heading zero is accepted, the first entry wins, and the other eight are
// dead code for that step. A bench sited on open ground therefore measures nothing about the fan and
// reports a clean, stable, perfectly reproducible number either side of the change.
//
// MEASURED, room 576 (The King's Way), 2026-09-12: 11,151 of 11,282 squares with a floor refuse NONE
// of the eight headings. The step bench had been sited at r87c59, one of them. Contact rate 0.00 —
// which reads as "the mover is fine here" and actually means "this square cannot answer the
// question". One hundred and thirty-one squares in the room are constrained at all.
//
// So this is the instrument that says whether a site can answer, BEFORE a run is spent on it. It is
// the complement of `m59-ground.mjs`, which answers for one square in depth; this ranks a whole room
// by how much choosing the square requires.
//
// EVERY VERDICT IS ABOUT A REACH. A square open at 128 units can be pinched at 512 — the fan fires
// per step, and a step's length is `max(8, min(stride, remaining))` in protocol units. A pinch
// reported without its reach is not a fact about the square.
//
// THE EDGE TEST IS THE MOVER'S OWN, reached through `m59-ground` so that this file holds no second
// opinion about collision. A debugging view that computes its own geometry is a different map.
import { roomGeometry, headingsFrom, floorAt, HEADINGS } from './m59-ground.mjs';
import { squareCentreClient } from './m59-finepos.mjs';

/** The reaches worth asking about: the mover's floor, a middling step, and its default stride. */
export const PINCH_REACHES = Object.freeze([128, 256, 512]);

/**
 * What a square is, for the purpose of measuring a mover change.
 *
 * `open` is the one that matters: it means a fan change is INVISIBLE here, because the fan is never
 * consulted. It is not a compliment about the ground.
 */
export function classify(refusedCount, of = 8) {
  if (refusedCount === 0) return 'open';
  if (refusedCount >= of) return 'sealed';
  if (refusedCount >= of - 2) return 'pocket';
  return 'pinch';
}

/**
 * One square, at every reach. `null` when the square has no floor under its centre — which is not the
 * same as being sealed, and `m59-routing.md` has the case: `r40c52` in the Ancient Place is walkable
 * with no floor at its centre, because the footing is a sliver.
 */
export function pinchAt(geo, row, col, { reaches = PINCH_REACHES, centre = squareCentreClient } = {}) {
  const p = centre(row, col);
  if (floorAt(geo, p.x, p.y) == null) return null;
  const byReach = headingsFrom(geo, p, { reaches }).map((e) => ({
    reach: e.reach,
    refused: e.refused,
    open: e.accepted,
    kind: classify(e.refused.length, e.refused.length + e.accepted.length),
  }));
  // THE SQUARE'S VERDICT IS ITS WORST REACH, because one pinched reach is enough for the fan to fire.
  const worst = byReach.reduce((a, b) => (b.refused.length > a.refused.length ? b : a), byReach[0]);
  return { row, col, byReach, refusedCount: worst.refused.length, kind: worst.kind,
           at: p, reach: worst.reach };
}

/** Every square with a floor, most constrained first. */
export function pinchPoints(geo, { reaches = PINCH_REACHES, centre = squareCentreClient,
                                  rows = null, cols = null } = {}) {
  const R = rows ?? geo.rows, C = cols ?? geo.cols;
  const out = [], histogram = new Map();
  let noFloor = 0;
  for (let r = 1; r <= R; r++) {
    for (let c = 1; c <= C; c++) {
      const s = pinchAt(geo, r, c, { reaches, centre });
      if (!s) { noFloor++; continue; }
      histogram.set(s.refusedCount, (histogram.get(s.refusedCount) ?? 0) + 1);
      if (s.refusedCount > 0) out.push(s);
    }
  }
  out.sort((a, b) => b.refusedCount - a.refusedCount || a.row - b.row || a.col - b.col);
  const withFloor = [...histogram.values()].reduce((a, b) => a + b, 0);
  return {
    squares: withFloor, noFloor, pinched: out.length,
    open: histogram.get(0) ?? 0,
    openFraction: withFloor ? +((histogram.get(0) ?? 0) / withFloor).toFixed(3) : null,
    histogram: [...histogram.entries()].sort((a, b) => a[0] - b[0]),
    sites: out,
  };
}

/**
 * CAN A MOVER-FAN CHANGE BE MEASURED AT THIS SQUARE? The question a bench has to ask before it runs,
 * and the answer is frequently no.
 */
export function canMeasureFanAt(geo, row, col, opts = {}) {
  const s = pinchAt(geo, row, col, opts);
  if (!s)
    return { ok: false, verdict: 'NO FLOOR',
             why: `r${row}c${col} has no floor under its centre, so nothing can be staged on it — ` +
                  `note this is NOT the same as unwalkable, the footing may be a sliver off-centre` };
  if (s.kind === 'sealed')
    return { ok: false, verdict: 'SEALED', square: s,
             why: `every heading is refused at reach ${s.reach}, so no step happens at all — a bench ` +
                  `here measures nothing, and a contact rate of zero would be a body that never moved` };
  if (s.refusedCount === 0)
    return { ok: false, verdict: 'OPEN', square: s,
             why: `all 8 headings are accepted at every reach tried (${PINCH_REACHES.join(', ')}), so ` +
                  `walkFine takes heading 0 every time and never consults the fan. A change to the ` +
                  `fan is INVISIBLE here: the bench will report a clean stable number either side of ` +
                  `it and that number will be about nothing` };
  return { ok: true, verdict: s.kind.toUpperCase(), square: s,
           why: `${s.refusedCount} of 8 headings refused at reach ${s.reach} ` +
                `(${s.byReach.find((b) => b.reach === s.reach).refused.join(',')}), so the direct ` +
                `heading can be refused and the fan is consulted — a fan change can show here` };
}

export function formatRoom(r, { room, limit = 20 } = {}) {
  const lines = [
    `room ${room}: ${r.squares} square(s) with a floor, ${r.noFloor} without`,
    `  ${r.open} OPEN (${r.openFraction != null ? Math.round(r.openFraction * 100) : '?'}%) — ` +
    `a mover-fan change cannot be measured on any of them`,
    `  ${r.pinched} constrained, and those are the only sites that can answer`,
    `  refused headings -> squares: ${r.histogram.map(([k, v]) => `${k}:${v}`).join(' ')}`,
  ];
  for (const s of r.sites.slice(0, limit))
    lines.push(`    r${s.row}c${s.col}  ${s.kind.padEnd(7)} ${s.refusedCount}/8 refused at ` +
               `reach ${s.reach}: ${s.byReach.find((b) => b.reach === s.reach).refused.join(',')}`);
  if (r.sites.length > limit) lines.push(`    ... and ${r.sites.length - limit} more`);
  return lines.join('\n');
}

async function main(argv) {
  const arg = (k, d = null) => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? true) : d;
  };
  const room = Number(arg('--room', 0));
  if (!room) {
    console.log('usage: node tools/m59-pinch.mjs --room <num> [--at rNcM] [--json] [--limit N]');
    process.exitCode = 2; return;
  }
  const geo = roomGeometry(room);
  if (!geo) { console.log(`no baked geometry for room ${room} in substrate/m59-map.json`); process.exitCode = 1; return; }
  const at = arg('--at');
  const json = argv.includes('--json');
  if (at) {
    const m = /^r(\d+)c(\d+)$/i.exec(String(at));
    if (!m) { console.log('--at wants rNcM, in row,col order'); process.exitCode = 2; return; }
    const v = canMeasureFanAt(geo, Number(m[1]), Number(m[2]));
    if (json) { console.log(JSON.stringify({ room, at, ...v }, null, 2)); return; }
    console.log(`${at} of room ${room}: ${v.verdict}`);
    console.log(`  ${v.why}`);
    if (v.square) for (const b of v.square.byReach)
      console.log(`  reach ${String(b.reach).padStart(4)}: ${b.kind.padEnd(7)} ` +
                  `refused ${b.refused.join(',') || '-'}`);
    process.exitCode = v.ok ? 0 : 1;      // non-zero: this site cannot answer the question
    return;
  }
  const r = pinchPoints(geo);
  console.log(json ? JSON.stringify({ room, ...r }, null, 2)
                   : formatRoom(r, { room, limit: Number(arg('--limit', 20)) }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('m59-pinch.mjs'))
  main(process.argv.slice(2));

export { HEADINGS };
