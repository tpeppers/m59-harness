#!/usr/bin/env node
// #movement: ONE ROW PER DECLARED JUMP THE MOVER ACTUALLY TRIED, SO A SUCCESS RATE IS MEASURABLE.
//
//   node tools/m59-jump-outcomes.mjs                  per declared jump: tried, sent, landed on target
//   node tools/m59-jump-outcomes.mjs --since 7d --fleet prod
//   node tools/m59-jump-outcomes.mjs --json
//
// WHY. Until this, the only declared-jump rows anywhere were `declared_jump` tactics written BEFORE
// the jump with `attempted:false` (m59-session-walk.mjs says why, at length). Whether a jump landed
// had to be reconstructed from one-second position trails that exist only for journeys that later
// failed -- a biased sample by construction: the 2026-10-31 audit could say "6 made, 32 missed" for
// Ukgoth and could not say a rate (docs/falljump-audit-2026-10-31.md).
//
// WHERE IT IS WRITTEN. Session.step, at the one place every declared fall passes through, after
// `queueValidatedMove` has either refused it or sent it -- the jump verb, the walker following a
// planned fall edge and the rail all arrive there. A refusal before sending (precondition, run,
// a body on the line, the trace) is a row too, with `sent:false`, because "the mover would not
// send it" is an outcome an operator needs to count.
//
// WHAT "LANDED" MEANS HERE. The server does not validate player geometry: it takes the position
// we send. So the landing is the point the client SENT after paying the simulated air time, and
// `landed_on_target` is that point being within 8 kod units of the aim on the target's floor
// (±64). It is not a later server re-read, and it says so in `landing.source`.
//
// `substrate/history/<fleet>/jump-outcomes-YYYY-MM-DD.jsonl`, beside the movement incidents and
// under the same `M59_LEDGER_DIR` override; gitignored with the rest of history. Never throws.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

export const FORMAT = 'm59-jump-outcome/1';
const IS_TEST = /-test\.mjs$/.test(process.argv[1] ?? '');
export const outcomeFile = (dir, t = Date.now()) =>
  join(dir, `jump-outcomes-${new Date(t).toISOString().slice(0, 10)}.jsonl`);

const KOD = 64, CLIENT = 1024;
const toClient = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: (p.x - KOD) * 16, y: (p.y - KOD) * 16 } : null;
const squareOf = c => c ? { row: Math.floor(c.y / CLIENT) + 1, col: Math.floor(c.x / CLIENT) + 1 } : null;
const round = p => p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;

/**
 * Build the row. Pure: every input is a value the caller already has. Points arrive in KOD
 * protocol units (what Session.step holds) and are recorded in CLIENT units, the space the
 * declarations use, with the square beside each.
 */
export function jumpOutcomeRow({ t = Date.now(), fleet = null, agent = null, character = null, room = null,
  declaration = null, requested = null, before = null, aim = null, queued = null, floorAt = null,
  precondition = null, refusal = null, vigor = null, trigger = 'declared' } = {}) {
  const floor = c => { try { const f = c && floorAt ? floorAt(c.x, c.y) : null; return Number.isFinite(f) ? f : null; } catch { return null; } };
  const actual = toClient(before), aimC = toClient(aim);
  const sent = !!queued?.sent;
  const landing = sent ? toClient(queued.target) : null;
  const targetFloor = declaration?.to_fine ? floor(declaration.to_fine) : floor(aimC);
  const landingFloor = floor(landing);
  const onTarget = !sent ? false
    : (landing && aimC && Math.hypot(landing.x - aimC.x, landing.y - aimC.y) <= 8 * 16 &&
       landingFloor != null && targetFloor != null && Math.abs(landingFloor - targetFloor) <= 64);
  const v = queued?.validation ?? null;
  return {
    format: FORMAT, t, iso: new Date(t).toISOString(), fleet, agent, character, room, trigger,
    jump: declaration ? { from: declaration.from, to: declaration.to } : null,
    requested: requested ?? null,
    takeoff: {
      declared: round(declaration?.from_fine ?? null),
      actual: round(actual), square: squareOf(actual), floor: floor(actual),
      off_declared: declaration?.from_fine && actual
        ? Math.round(Math.hypot(actual.x - declaration.from_fine.x, actual.y - declaration.from_fine.y)) : null,
    },
    aim: { point: round(aimC), square: squareOf(aimC), declared_landing: round(declaration?.to_fine ?? null) },
    sent,
    landing: sent ? { point: round(landing), square: squareOf(landing), floor: landingFloor, source: 'sent_after_air_time' } : null,
    target_floor: targetFloor,
    air_ms: v?.fall_motion?.elapsed_ms ?? null,
    landed_on_target: onTarget,
    reason: sent ? null : (refusal ?? v?.reason ?? 'not_sent'),
    precondition: precondition ? { ok: precondition.ok, sectors: precondition.sectors ?? [] } : { ok: true, sectors: [] },
    vigor: Number.isFinite(vigor) ? vigor : null,
  };
}

/** Append one row. `dir` defaults to this fleet's history directory; tests must pass one. */
export function recordJumpOutcome(row, { dir = null, fleet = null } = {}) {
  try {
    if (IS_TEST && !dir && !process.env.M59_LEDGER_DIR) return false;
    const d = dir ?? ledgerDirFor(fleet ?? row?.fleet ?? fleetName());
    mkdirSync(d, { recursive: true });
    appendFileSync(outcomeFile(d, row?.t ?? Date.now()), JSON.stringify(row) + '\n');
    return true;
  } catch { return false; }   // never let the record break the jump it is recording
}

export function readJumpOutcomes({ dir = null, fleet = null, sinceMs = 7 * 86400_000, now = Date.now() } = {}) {
  const d = dir ?? ledgerDirFor(fleet ?? fleetName());
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d).filter(f => /^jump-outcomes-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.format === FORMAT && r.t >= now - sinceMs) out.push(r); } catch { /* skip */ }
    }
  }
  return out;
}

/** Per declared jump: rows, sent, landed on target, and the refusal reasons. */
export function summarizeJumpOutcomes(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.jump ? `${r.room} r${r.jump.from.row}c${r.jump.from.col}>r${r.jump.to.row}c${r.jump.to.col}` : `${r.room} undeclared`;
    const s = by.get(k) ?? { jump: k, tried: 0, sent: 0, landed: 0, refused: {} };
    s.tried++;
    if (r.sent) s.sent++;
    if (r.landed_on_target) s.landed++;
    if (!r.sent) s.refused[r.reason ?? '?'] = (s.refused[r.reason ?? '?'] ?? 0) + 1;
    by.set(k, s);
  }
  return [...by.values()].map(s => ({ ...s, landed_rate: s.sent ? +(s.landed / s.sent).toFixed(3) : null }));
}

if ((process.argv[1] ?? '').replaceAll('\\', '/').endsWith('/m59-jump-outcomes.mjs')) {
  const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
  const since = arg('since'), m = since && /^(\d+)([hd])$/.exec(since);
  const sinceMs = m ? Number(m[1]) * (m[2] === 'h' ? 3600_000 : 86400_000) : 7 * 86400_000;
  const rows = readJumpOutcomes({ fleet: arg('fleet'), sinceMs });
  const sum = summarizeJumpOutcomes(rows);
  if (process.argv.includes('--json')) console.log(JSON.stringify(sum, null, 1));
  else if (!sum.length) console.log('no jump outcomes recorded in that window');
  else for (const s of sum) console.log(`${s.jump}: tried ${s.tried}, sent ${s.sent}, landed on target ${s.landed}` +
    (s.landed_rate != null ? ` (${Math.round(s.landed_rate * 100)}%)` : '') +
    (Object.keys(s.refused).length ? `; refused ${Object.entries(s.refused).map(([k, n]) => `${k}×${n}`).join(', ')}` : ''));
}
