#!/usr/bin/env node
// FLEETSCRATCH — WHERE RECORDINGS LIVE, AND WHAT SURVIVES THEM.
//
//   node tools/m59-scratch.mjs                    what is in the scratch, and how big
//   node tools/m59-scratch.mjs list --kind grind  one kind of recording
//   node tools/m59-scratch.mjs show <id>          one recording
//   node tools/m59-scratch.mjs prune              drop fine data past its window (24h)
//   node tools/m59-scratch.mjs prune --dry        say what it would drop, drop nothing
//   node tools/m59-scratch.mjs epochs             what has been measured, per movement epoch
//
// THE ASK, AND THE ONE PLACE I ARGUED WITH IT. Operator, 2026-09-11: a scratch space for
// recordings; fine data need not outlive 24 hours; *"I'd like to be able to look back at
// historical movement code / behaviors through newer analysis lenses."*
//
// Those last two pull against each other, and the resolution is the whole design of this file:
//
//   FINE DATA EXPIRES. Traces are large, they are about a moment, and keeping every position
//   sample for ever buys nothing — 24 hours by default, `--hours` to change it, and the prune
//   is a command somebody runs rather than a daemon that deletes things unattended.
//
//   AGGREGATES DO NOT EXPIRE, AND EVERY ONE IS KEYED BY THE `#movement` EPOCH. This is what
//   makes "was this worse before that commit" a lookup instead of an argument. It is the same
//   mechanism the exit-gap book uses and for the same reason: a counter that spans a rewrite of
//   the mover is a monument, not a measurement.
//
//   RECORDINGS ARE NEITHER, AND THEY ARE THE ACTUAL ANSWER TO THE ASK. A new lens cannot be
//   applied to a bucket — an aggregate only answers questions somebody thought of in advance.
//   It CAN be applied to a recording, which is why those are kept by hand, named, and exempt
//   from the prune unless explicitly dropped. "Keep more recordings" is the real answer to
//   looking back at old movement code through new eyes; the counts are only the index.
//
// NOTHING HERE IS COMMITTED, AND THAT IS DELIBERATE. `substrate/scratch/` is gitignored for the
// same reason `substrate/loadouts/` is: this is evidence about THIS machine's fleet, it names
// characters, and a repository that carried it would be handing a stranger somebody else's
// afternoon. A recording that is worth keeping for ever gets REDACTED and promoted into
// `tools/fixtures/` by hand, which is what `m59-recordjam.mjs` already does — every player
// becomes `player A`, and the file becomes a test case instead of a diary.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync,
         rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { epochFor } from './m59-epoch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRATCH = process.env.M59_SCRATCH_DIR || join(HERE, '..', 'substrate', 'scratch');
const FINE = () => join(SCRATCH, 'fine');
const KEEP = () => join(SCRATCH, 'keep');
const AGGREGATES = () => join(SCRATCH, 'aggregates.jsonl');

export const DEFAULT_HOURS = 24;

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ensure = d => { mkdirSync(d, { recursive: true }); return d; };

/**
 * Write one recording. `keep: true` puts it in the half the prune never touches.
 *
 * The id is the filename, and it carries the day so that pruning is a directory walk rather
 * than a parse of every file — a scratch that has to open ten thousand files to decide what to
 * delete is a scratch nobody prunes.
 */
export function save(kind, data, { keep = false, at = Date.now(), label = '' } = {}) {
  const slug = String(label || '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  const name = `${kind}-${new Date(at).toISOString().replace(/[:.]/g, '-')}${slug ? '-' + slug : ''}.json`;
  const dir = keep ? ensure(KEEP()) : ensure(join(FINE(), day(at)));
  const file = join(dir, name);
  // THE EPOCH GOES IN AT WRITE TIME, NEVER AT READ TIME. Reading it later would stamp the
  // recording with whatever the mover happens to be TODAY, which is the exact confusion this
  // whole mechanism exists to prevent — and it would do it silently, to old evidence.
  const ep = epochFor('movement');
  const body = { schema: 'm59-scratch/1', kind, at, label: label || null,
                 epoch: ep?.ref ?? null, epoch_subject: ep?.subject ?? null,
                 epoch_dirty: ep?.dirty ?? null, data };
  writeFileSync(file, JSON.stringify(body, null, 2));
  return { id: name, file, epoch: body.epoch };
}

/** Every recording, newest first. Cheap: stats only, no parsing. */
export function list({ kind = null, keep = null } = {}) {
  const out = [];
  const walk = (dir, isKeep) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, isKeep); continue; }
      if (!e.name.endsWith('.json')) continue;
      if (kind && !e.name.startsWith(kind + '-')) continue;
      let st; try { st = statSync(p); } catch { continue; }
      out.push({ id: e.name, file: p, keep: isKeep, bytes: st.size, mtime: st.mtimeMs });
    }
  };
  if (keep !== false) walk(KEEP(), true);
  if (keep !== true) walk(FINE(), false);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function read(id) {
  const hit = list().find(r => r.id === id || r.file === id);
  if (!hit) return null;
  try { return JSON.parse(readFileSync(hit.file, 'utf8')); } catch { return null; }
}

/**
 * Drop fine recordings older than the window. Never touches `keep/`, never touches aggregates.
 *
 * `dry` first, because this deletes evidence and the one thing worse than a scratch that fills
 * the disk is a scratch that quietly threw away the recording somebody was about to read.
 */
export function prune({ hours = DEFAULT_HOURS, dry = false, now = Date.now() } = {}) {
  const cutoff = now - hours * 3600_000;
  const doomed = list({ keep: false }).filter(r => r.mtime < cutoff);
  let bytes = 0;
  for (const r of doomed) {
    bytes += r.bytes;
    if (!dry) { try { rmSync(r.file); } catch { /* already gone is fine */ } }
  }
  // Empty day directories are swept too, so `fine/` does not become a list of every day the
  // fleet has ever run.
  if (!dry && existsSync(FINE())) {
    for (const e of readdirSync(FINE(), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(FINE(), e.name);
      try { if (readdirSync(p).length === 0) rmSync(p, { recursive: true }); } catch { /* fine */ }
    }
  }
  return { dropped: doomed.length, bytes, hours, dry, kept: list({ keep: true }).length };
}

/**
 * Append roll-ups to the permanent record. One line per bucket, never rewritten.
 *
 * APPEND-ONLY BECAUSE A REWRITTEN TOTAL CANNOT BE AUDITED. If a number changes, the way to see
 * that it changed is to have both lines — the same argument `substrate/log.jsonl` makes in the
 * parent repository, where nothing is edited in place because the record of how the
 * understanding moved IS the finding.
 */
export function roll(buckets = [], { at = Date.now() } = {}) {
  if (!buckets.length) return { written: 0 };
  ensure(SCRATCH);
  const lines = buckets.map(b => JSON.stringify({ at, ...b })).join('\n') + '\n';
  appendFileSync(AGGREGATES(), lines);
  return { written: buckets.length, file: AGGREGATES() };
}

/** Every roll-up ever written, optionally for one epoch. */
export function aggregates({ epoch = null } = {}) {
  if (!existsSync(AGGREGATES())) return [];
  const out = [];
  for (const line of readFileSync(AGGREGATES(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (epoch && o.epoch !== epoch) continue;
    out.push(o);
  }
  return out;
}

/** What has been measured, grouped by the movement epoch that produced it. */
export function byEpoch() {
  const m = new Map();
  for (const a of aggregates()) {
    const k = a.epoch ?? 'unknown';
    let e = m.get(k);
    if (!e) { e = { epoch: k, buckets: 0, count: 0, ms_total: 0, first: a.at, last: a.at }; m.set(k, e); }
    e.buckets += 1; e.count += a.count ?? 0; e.ms_total += a.ms_total ?? 0;
    e.first = Math.min(e.first, a.at); e.last = Math.max(e.last, a.at);
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

// ---------------------------------------------------------------- cli
const mins = ms => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h`
                  : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const mb = b => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.round(b / 1000)}KB`);

function main(argv) {
  const cmd = argv.find(a => !a.startsWith('--')) || 'status';
  const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes('--' + n);

  if (cmd === 'prune') {
    const r = prune({ hours: Number(flag('hours', DEFAULT_HOURS)), dry: has('dry') });
    console.log(`${r.dry ? 'would drop' : 'dropped'} ${r.dropped} fine recording(s), ${mb(r.bytes)}` +
                `, older than ${r.hours}h; ${r.kept} kept recording(s) untouched`);
    return 0;
  }
  if (cmd === 'list') {
    const rows = list({ kind: flag('kind') });
    if (!rows.length) { console.log('scratch is empty'); return 0; }
    for (const r of rows.slice(0, Number(flag('limit', 40))))
      console.log(`  ${r.keep ? 'KEEP' : 'fine'}  ${mb(r.bytes).padStart(7)}  ` +
                  `${new Date(r.mtime).toISOString().slice(0, 16)}  ${r.id}`);
    console.log(`\n${rows.length} recording(s)`);
    return 0;
  }
  if (cmd === 'show') {
    const id = argv.find(a => !a.startsWith('--') && a !== 'show');
    const r = read(id);
    if (!r) { console.error(`no recording "${id}"`); return 1; }
    console.log(JSON.stringify(r, null, 2).slice(0, Number(flag('bytes', 4000))));
    return 0;
  }
  if (cmd === 'epochs') {
    const rows = byEpoch();
    if (!rows.length) { console.log('nothing rolled up yet'); return 0; }
    console.log('  epoch     buckets  episodes  total     first seen        last seen');
    for (const e of rows)
      console.log(`  ${String(e.epoch).slice(0, 9).padEnd(9)} ${String(e.buckets).padStart(7)} ` +
                  `${String(e.count).padStart(9)}  ${mins(e.ms_total).padStart(7)}  ` +
                  `${new Date(e.first).toISOString().slice(0, 16)}  ${new Date(e.last).toISOString().slice(0, 16)}`);
    console.log('\nEach row is one version of the movement code. Comparing two of them is the ' +
                'whole point;\ncomparing across a `#movement` commit without noticing is how a ' +
                'counter becomes a monument.');
    return 0;
  }

  // status
  const all = list();
  const fine = all.filter(r => !r.keep), kept = all.filter(r => r.keep);
  const bytes = all.reduce((n, r) => n + r.bytes, 0);
  const ep = epochFor('movement');
  console.log(`FleetScratch  ${SCRATCH}`);
  console.log(`  recordings   ${fine.length} fine (expire after ${DEFAULT_HOURS}h), ` +
              `${kept.length} kept (never pruned)`);
  console.log(`  on disk      ${mb(bytes)}`);
  console.log(`  aggregates   ${aggregates().length} bucket-row(s) across ${byEpoch().length} epoch(s) — kept for ever`);
  console.log(`  this epoch   ${ep?.ref ? String(ep.ref).slice(0, 9) : 'unknown'}` +
              `${ep?.dirty ? ' (DIRTY — uncommitted movement code is its own epoch)' : ''}` +
              `${ep?.subject ? `  ${String(ep.subject).slice(0, 60)}` : ''}`);
  const oldest = fine.length ? Math.min(...fine.map(r => r.mtime)) : null;
  if (oldest && Date.now() - oldest > DEFAULT_HOURS * 3600_000)
    console.log(`\n  ${fine.filter(r => Date.now() - r.mtime > DEFAULT_HOURS * 3600_000).length} ` +
                `fine recording(s) are past the window — \`prune --dry\` to see them`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  process.exit(main(process.argv.slice(2)));
