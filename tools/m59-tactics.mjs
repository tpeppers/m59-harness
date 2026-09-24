// WHICH TACTIC, WHEN, AND DID IT ACTUALLY HELP.
//
// The walker has a handful of tactics for the moment a walk stops working, and all of them
// are real things a player does: run at the door along a line already proved clear, wiggle
// or retrace so the thing blocking you follows and comes off the gap, sidestep it, set the
// refused edges aside and plan on the coarse grid, walk the last stretch in fine units.
// Each is right in some situation and WRONG in others — and a tactic used at the wrong
// moment does not merely fail, it spends the seconds and the health that the right tactic
// needed. Backing away from something that is already swinging is a free hit and a delay.
//
// None of that was measurable. Fixes were being added by argument, one at a time, with no
// record of which tactic fired, what it was answering, what it cost, or whether the walk
// was unstuck afterwards. This is that record.
//
// THREE RULES, because each is a way the number could lie:
//
//   * A TACTIC IS SCORED AGAINST ITS TRIGGER, NEVER ON ITS OWN. "Retreat works 40% of the
//     time" is not a fact about retreating; it is an average over situations where it is
//     the obvious answer and situations where it is the worst available one. Every row
//     carries the trigger, and the summary never averages across them.
//   * THE OUTCOME IS MEASURED BY THE CALLER, NOT ASSUMED BY THE TACTIC. `worked` means the
//     thing the tactic was meant to unblock then succeeded — the next step landed, the
//     route reappeared, the door opened. A tactic that ran without error and left the walk
//     exactly as stuck is a FAILURE, and that is the commonest kind here.
//   * WHAT IT COST IS PART OF THE RESULT. A tactic that works in twelve seconds while
//     something is hitting you for nine health is not better than one that fails in one
//     second. Time and health are recorded on every row, including the successes.
//
// Written as JSONL because it is append-only evidence with no schema anyone should be
// tempted to edit, exactly like the hits and client-signal ledgers beside it. Gitignored:
// every row names a character.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName, evidenceDirFor } from './m59-fleetpath.mjs';
import { sameEpoch, epochId } from './m59-epoch.mjs';

// WHICH FLEET, ASKED THE ONE WAY THIS REPOSITORY ASKS IT.
//
// This module used to read the environment directly with a literal fallback, which is
// its own argv/env reading — the exact mistake CLAUDE.md already records against the
// tithe book, where "a broker started with no --fleet but a recorded substrate/fleet-default
// wrote default-t14 while the tool read prod-t14". It happened again here and was visible on
// disk: the prod broker is started with `--fleet prod` as a COMMAND LINE argument, not an
// environment variable, so every trail it recorded went into `default.jsonl` — 14 MB of prod
// under a name no tool would ever look for.
//
// `fleetName` is the resolver every other fleet tool uses: --fleet, then M59_FLEET, then
// substrate/fleet-default, then the unnamed fleet. One answer, one place.
const FLEET = () => fleetName() || 'default';


const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TACTICS_DIR = process.env.M59_TACTICS_DIR || path.join(evidenceDirFor(), 'tactics');

// THE CLOSED SET, so a new tactic shows up in the report the day it is added rather than
// being averaged into "other". An unrecognised name is RECORDED, never dropped — the same
// rule the commitment board follows, and for the same reason: a tactic nobody can see is
// one nobody can judge.
export const TACTICS = Object.freeze({
  string_pull: 'ran the proved straight line at the target',
  hop_coalesce: 'skipped ahead along a line the pull had already proved',
  breadcrumb_retreat: 'walked the validated trail backwards',
  needle_backoff: 'backed off a one-square doorway so the blocker would follow',
  needle_wait: 'stood and waited for a one-square doorway to clear',
  sidestep: 'stepped around the body in the way',
  drop_occupancy: 'forgot where bodies were standing and replanned',
  coarse_fallback: 'set the refused edges aside and planned on the server grid',
  fine_walk: 'walked it in fine units instead of square steps',
  floor_recovery: 'stepped back onto ground the mover believes in',
});

// WHAT THE TACTIC WAS ANSWERING. The same distinctions the walker already makes, because a
// trigger this file invents is a trigger nothing can be keyed off.
export const TRIGGERS = Object.freeze({
  body_blocked: 'something alive refused the step',
  off_plan: 'the step landed somewhere other than the planned square',
  no_route: 'the planner had nothing from here',
  off_floor: 'standing where the mover says there is no floor',
  door_refused: 'the boundary would not take us',
});

let buffer = [], flushTimer = null;

export function tacticsFile(fleet = FLEET()) {
  return path.join(TACTICS_DIR, String(fleet).replace(/[^\w.-]/g, '_') + '.jsonl');
}

/**
 * Record one application of one tactic.
 *
 * FIRE AND FORGET, AND BUFFERED, because this is called from inside a walk that twenty-one
 * sessions share an event loop with. It must never throw and must never await: an
 * instrument that can break the thing it measures is worse than no instrument, and this one
 * sits on the movement path.
 */
export function recordTactic(row = {}) {
  try {
    const entry = {
      t: row.at ?? Date.now(),
      // WHICH CODE THIS ROW IS ABOUT — see tools/m59-epoch.mjs and the `#movement` tag.
      // A tactic's success rate is a statement about the walker that ran it, and the walker
      // changes; without this every summary silently averages over versions.
      epoch: epochId('movement'),
      character: row.character ?? null,
      room: row.room ?? null,
      tactic: row.tactic ?? 'unknown',
      trigger: row.trigger ?? null,
      // Chebyshev squares to the goal before and after, so "did it get us anywhere" is
      // answerable separately from "did the next step work".
      gap_before: Number.isFinite(row.gap_before) ? row.gap_before : null,
      gap_after: Number.isFinite(row.gap_after) ? row.gap_after : null,
      ms: Number.isFinite(row.ms) ? Math.round(row.ms) : null,
      hp_lost: Number.isFinite(row.hp_lost) ? row.hp_lost : 0,
      // The caller's measured answer, never the tactic's own opinion of itself.
      worked: row.worked === true,
      // AND WHETHER IT WAS EVEN TRIED. `worked` is a strict boolean and every consumer
      // counts `worked ? ok : fail`, so a row saying "we decided this tactic was not the
      // right one here" scored as a tactic that was tried and failed. The rail logs those
      // deliberately — the note at its skip site argues, correctly, that the DECISION is
      // worth recording — and the result was that Ukgoth read as an 84% rail failure while
      // seventy-one of those rows say `no rail needed, the door is 0 squares away`, which
      // is the walk going right.
      //
      // That matters beyond tidiness: this ledger is what an operator reads to choose what
      // to go and fix, so a decision counted as a failure sends somebody to repair
      // something that is working. Absent means true, so every existing row and every
      // caller that does not know about this keeps its old meaning.
      attempted: row.attempted !== false,
      ...(row.note ? { note: String(row.note).slice(0, 200) } : {}),
    };
    buffer.push(entry);
    if (buffer.length >= 64) flushTactics(row.fleet);
    else if (!flushTimer) {
      flushTimer = setTimeout(() => flushTactics(row.fleet), 5000);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    return entry;
  } catch { return null; }
}

// HOW LONG A TACTIC ROW IS EVIDENCE, AND HOW LONG IT IS JUST WEIGHT.
//
// This file was append-only for ever, and the cost of that is not disk — it is that every
// measurement taken from it silently averages over code that no longer exists. Measured on
// 2026-08-27, asking "what fraction of crossings ride a baked rail":
//
//     all time (5 days, 52,047 rows)   27.0% rode a rail, 33.2% "no baked line"
//     last 90 minutes                  48.5% rode a rail,  1.6% "no baked line"
//
// The 33.2% is a lookup bug that was fixed days ago. Reading the whole file made a solved
// problem look like the dominant one, and the number an operator would have acted on was
// wrong by a factor of two in the OTHER direction as well. Nothing in the file is false;
// all of it is stale, and stale evidence about a moving target is worse than none because
// it carries the authority of a measurement.
//
// `readTactics` already defaults to a 24h window — the consumers knew. What was missing is
// that the file itself never forgot, so any ad-hoc analysis (`cat`, a one-off script, a
// question asked in a hurry) got the whole five days by default.
//
// TRIMMED ON A BYTE THRESHOLD, NOT ON EVERY WRITE. This sits on the movement path with
// twenty-one sessions sharing an event loop, so the rewrite has to be rare and the check
// has to be a `statSync`. At 4 MB a trim is a few hundred milliseconds every few hours.
const RETAIN_HOURS = Number(process.env.M59_TACTICS_RETAIN_HOURS || 48);
const TRIM_ABOVE_BYTES = Number(process.env.M59_TACTICS_TRIM_BYTES || 4 * 1024 * 1024);

// AND A TRIM THAT DROPS NOTHING MUST NOT RUN AGAIN FIVE SECONDS LATER.
//
// The byte threshold above assumed a trim brings the file back under it. It does not when
// the rows are all from the CURRENT movement epoch, which the epoch rule keeps whatever
// their age — and on a fleet whose code has not moved, that is every row. Measured
// 2026-09-24 on the shadow lab: substrate/tactics/shadow.jsonl at 171 MB, 512,861 rows, one
// epoch, four days old. Every flush (every 5 s or 64 rows) in every keeper then read and
// JSON-parsed the whole 171 MB to drop nothing: a sampling heap profiler put 75% of a
// travelling keeper's allocation in this function, about FIVE GIGABYTES A MINUTE, and that
// churn is what walked each keeper's heap to ~900 MB between collections (live data: 211 MB).
// Forty-seven keepers at that size is what ran a 64 GB machine out of memory.
//
// So each process remembers when it last looked and what the last trim left behind, and
// looks again only when both enough time has passed AND the file has grown well past that.
const TRIM_EVERY_MS = Number(process.env.M59_TACTICS_TRIM_EVERY_MS || 30 * 60_000);
const TRIM_GROWTH = Number(process.env.M59_TACTICS_TRIM_GROWTH || 1.25);
// NOT FIXED HERE: the file itself still grows ~40 MB a day on a quiet codebase, because the
// epoch rule keeps every current-epoch row whatever its age (pinned in m59-epoch-test). That
// costs disk and every reader's time; it no longer costs every keeper's heap every 5 s.
const lastTrim = new Map();            // file -> { at, keptBytes }

/**
 * Drop rows older than the retention window. Never throws — an instrument that can break
 * the thing it measures is worse than no instrument, and that applies to its housekeeping
 * as much as to its writes.
 *
 * Returns the number of rows dropped, or 0 if nothing was done.
 */
export function trimTactics(fleet = FLEET(), { force = false } = {}) {
  const file = tacticsFile(fleet);
  try {
    if (!force) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return 0; }
      if (size < TRIM_ABOVE_BYTES) return 0;
      const last = lastTrim.get(file);
      if (last && (Date.now() - last.at < TRIM_EVERY_MS || size < last.keptBytes * TRIM_GROWTH)) return 0;
    }
    const since = Date.now() - RETAIN_HOURS * 3600000;
    const text = fs.readFileSync(file, 'utf8');
    const keep = [];
    let dropped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // A ROW THAT WILL NOT PARSE IS DROPPED, NOT KEPT FOR EVER. The writer appends whole
      // lines, so the only unparseable row is a torn last write — which `readTactics`
      // already tolerates and which nothing can use.
      let t = null, epoch = null;
      try { const r = JSON.parse(line); t = r.t ?? null; epoch = r.epoch ?? null; }
      catch { dropped++; continue; }
      // THE COMMIT DECIDES WHERE IT CAN. A row from a superseded movement epoch is not old
      // evidence, it is evidence about different code, and no window makes it relevant
      // again. The clock only rules on rows the epoch cannot speak for: written before this
      // existed, or recorded in a checkout with no git.
      const known = sameEpoch(epoch, 'movement');
      if (known === false) { dropped++; continue; }
      if (known === true) { keep.push(line); continue; }
      if (t === null || t >= since) keep.push(line); else dropped++;
    }
    lastTrim.set(file, { at: Date.now(), keptBytes: keep.reduce((n, l) => n + l.length + 1, 0) });
    if (!dropped) return 0;
    // Through a temp file, because this runs while the broker is writing: a truncate-then-
    // write leaves the ledger empty for as long as the write takes, and a crash in that
    // window loses everything rather than the old half.
    const tmp = file + '.trim';
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
    return dropped;
  } catch { return 0; }
}

export function flushTactics(fleet = FLEET()) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buffer.length) return 0;
  const rows = buffer; buffer = [];
  try {
    fs.mkdirSync(TACTICS_DIR, { recursive: true });
    fs.appendFileSync(tacticsFile(fleet), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    trimTactics(fleet);
    return rows.length;
  } catch { return 0; }
}

export function readTactics({ fleet = FLEET(), hours = 24 } = {}) {
  let text = '';
  try { text = fs.readFileSync(tacticsFile(fleet), 'utf8'); } catch { return []; }
  const since = Date.now() - hours * 3600000;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if ((r.t ?? 0) >= since) out.push(r); } catch { /* a torn last line */ }
  }
  return out;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Per TACTIC AND TRIGGER, never per tactic alone — see the rule at the top of the file.
 */
export function summarise(rows = []) {
  const cells = new Map();
  for (const r of rows) {
    const key = r.tactic + ' ' + (r.trigger ?? 'unknown');
    const cell = cells.get(key) ?? { tactic: r.tactic, trigger: r.trigger ?? 'unknown',
                                     used: 0, worked: 0, ms: [], hp: 0, closed: 0, rooms: new Map() };
    // NOT COUNTED AS A GO. A row the caller marked `attempted: false` is a decision not to
    // use the tactic, and folding it into `used` makes the success rate a measure of how
    // often the tactic was APPROPRIATE rather than of whether it works. Reported on its own
    // line, because "we skipped it ninety times" is worth seeing and worth explaining.
    if (r.attempted === false) { cell.skipped = (cell.skipped ?? 0) + 1; cells.set(key, cell); continue; }
    cell.used++;
    if (r.worked) cell.worked++;
    if (Number.isFinite(r.ms)) cell.ms.push(r.ms);
    cell.hp += r.hp_lost ?? 0;
    if (Number.isFinite(r.gap_before) && Number.isFinite(r.gap_after) && r.gap_after < r.gap_before)
      cell.closed++;
    if (r.room != null) cell.rooms.set(r.room, (cell.rooms.get(r.room) ?? 0) + 1);
    cells.set(key, cell);
  }
  return [...cells.values()].map(c => ({
    tactic: c.tactic, trigger: c.trigger, used: c.used, worked: c.worked,
    ...(c.skipped ? { skipped: c.skipped } : {}),
    success: c.used ? c.worked / c.used : 0,
    // Time is what a tactic costs whether or not it works, so the total is the honest
    // figure for "what did this spend of the walk" and the median for "what does one go
    // cost". Both, because one long retreat and thirty cheap ones read identically as an
    // average.
    total_ms: c.ms.reduce((a, b) => a + b, 0), median_ms: median(c.ms),
    hp_lost: c.hp,
    // Getting closer is not the same as being unstuck; a tactic can do one without the
    // other, and which one it does is the whole question for a retreat.
    closed_the_gap: c.closed,
    worst_rooms: [...c.rooms].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([room, n]) => ({ room, n })),
  })).sort((a, b) => b.total_ms - a.total_ms);
}

// ---------------------------------------------------------------- the CLI
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const fleet = arg('--fleet') ?? FLEET();
  const hours = Number(arg('--hours') ?? 24);
  const rows = readTactics({ fleet, hours });
  const table = summarise(rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ fleet, hours, rows: rows.length, tactics: table }, null, 2));
  } else if (!rows.length) {
    console.log('no tactics recorded for fleet "' + fleet + '" in the last ' + hours + 'h');
    console.log('(' + tacticsFile(fleet) + ')');
  } else {
    console.log('fleet "' + fleet + '", last ' + hours + 'h — ' + rows.length + ' tactic application(s)\n');
    console.log('tactic              trigger          used  worked   rate    total   median    hp  closer  rooms');
    for (const c of table) {
      console.log(
        c.tactic.padEnd(19) + ' ' + c.trigger.padEnd(15) + ' ' + String(c.used).padStart(4) + ' ' +
        String(c.worked).padStart(7) + ' ' + (100 * c.success).toFixed(0).padStart(5) + '% ' +
        (c.total_ms / 1000).toFixed(0).padStart(7) + 's ' + String(c.median_ms ?? '-').padStart(6) + 'ms ' +
        String(c.hp_lost).padStart(5) + ' ' + String(c.closed_the_gap).padStart(6) + '  ' +
        c.worst_rooms.map(r => r.room + 'x' + r.n).join(' '));
    }
    const worst = table.filter(c => c.used >= 3 && c.success < 0.25);
    if (worst.length) {
      console.log('\nSPENDING TIME AND NOT WORKING (3+ goes, under 25% success):');
      for (const c of worst)
        console.log('   ' + c.tactic + ' on ' + c.trigger + ': ' + c.worked + '/' + c.used + ', ' +
                    (c.total_ms / 1000).toFixed(0) + 's and ' + c.hp_lost + 'hp spent');
    }
  }
}
