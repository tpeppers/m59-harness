#!/usr/bin/env node
// THE SHARED HALF OF A BOSS RAID: what to prepare, in what order, and what is still good.
//
// The two phases are fleetscripts (tools/fleetscripts/raid-prep.mjs, raid-action.mjs) and
// this is what they both read. It holds no driving logic — no travel, no combat — so that
// the ordering rules and the staging format have one home and cannot drift apart between a
// prep run and the action run that consumes it.
//
// ============================================================================
// PREP IS IDEMPOTENT, AND IT IS IDEMPOTENT BY OBSERVATION
// ============================================================================
//
// You will run prep more than once. A raid aborts and is retried four hours later; a
// preparation that lasts twenty seconds is re-cast three times while a queue of them is
// worked through. So prep never asks "did I do this already" — it asks the world "is this
// in effect", every time, and does only what is missing. There is no state file for what
// was cast, deliberately: a file would be wrong the moment a buff expired or somebody died.
//
// What the world can be asked, through tools that work on prod:
//   personal buffs  status.enchantment_observations — what is on the character right now
//   an enchanted weapon  the item's own name, once the server renames it
//   vigor, mana, reagents  status and inventory
//
// ============================================================================
// DESCENDING DURATION, AND DEFERRAL AS ITS LIMIT CASE
// ============================================================================
//
// Buffs are cast longest-lasting first (m59-buffs.mjs derives the durations from kod). The
// reason is one-directional: a long buff cast late loses a few seconds of its hours, while a
// short buff cast early is simply gone by the fight. Bless is twenty seconds at low power.
//
// Deferral is where that argument ends up. A preparation whose duration is short enough that
// prep cannot protect it is not cast during prep at all — it is STAGED, and the action phase
// casts it as its first step, in the boss's room, seconds before contact. Room enchantments
// are always staged whatever their duration, because they enchant the room they are cast in
// and prep does not happen there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buffCatalogue } from './m59-buffs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
export const STAGE_DIR = path.join(REPO, 'substrate', 'raids');

/**
 * Anything whose WORST roll is shorter than this cannot be trusted to survive a prep queue
 * and the walk to the boss, so it is staged instead.
 *
 * Three minutes, and the number is a judgement rather than a measurement: a prep queue of a
 * dozen casts plus a two-room walk is a couple of minutes, so a buff that can roll five
 * minutes will usually still be up and one that can roll forty seconds will not. Set it
 * higher for a long approach — `planPreparations(wanted, { deferUnderMs })` — and everything
 * marginal moves to the action phase, which is the safe direction: a staged buff is cast
 * seconds before contact and wastes nothing but the caster's time.
 */
export const DEFER_UNDER_MS = 3 * 60_000;

/**
 * The preparations a raid wants, in the order they must be cast.
 * `wanted` is a list of spell names; unknown names are reported, never silently dropped.
 */
export function planPreparations(wanted, { catalogue = buffCatalogue(), deferUnderMs = DEFER_UNDER_MS } = {}) {
  const byName = new Map(catalogue.map(b => [b.name, b]));
  const steps = [], unknown = [];
  for (const name of wanted) {
    const b = byName.get(String(name).toLowerCase());
    if (!b) { unknown.push(name); continue; }
    // Three reasons to defer, and the first two are not preferences:
    //   a room enchantment does nothing outside the room it is cast in
    //   a duration we could not read is treated as short (m59-buffs.mjs argues why)
    //   a duration shorter than a prep queue will not survive one
    const why = b.scope === 'room' ? 'enchants the room it is cast in'
      : b.duration_ms?.min == null ? 'duration unknown, so assumed too short to hold'
      : b.duration_ms.min < deferUnderMs ? `lasts as little as ${Math.round(b.duration_ms.min / 1000)}s`
      : null;
    steps.push({ ...b, deferred: !!why, defer_reason: why });
  }
  // Already sorted longest-first by the catalogue; keep that and split.
  return {
    now: steps.filter(s => !s.deferred),
    deferred: steps.filter(s => s.deferred),
    unknown,
  };
}

/**
 * Is this buff on this character right now, as the world reports it?
 *
 * `true` yes, `false` no, `null` UNKNOWN — and unknown is a real answer that callers must
 * handle rather than coerce. A `false` here re-casts and burns reagents; a `null` means ask
 * somebody else.
 *
 * FOR A WEAPON, ASK BY CASTING — IT IS FREE. This answers `null` for weapon scope because
 * the server does not rename an enchanted weapon and no prod-safe read exposes its
 * ATCK_WEAP_MAGIC flag. That is not a gap to work around: every "already in effect" refusal
 * in this game is raised in `CanPayCosts`, which runs BEFORE the mana and the reagents are
 * taken, so a cast aimed at an already-enchanted weapon costs nothing and comes back with
 * "This weapon is already dedicated to Kraanan." `castVerified` classifies that as
 * `in_effect`, which makes the cast a cheaper and more authoritative test than any read.
 */
export function inEffect(status, buff) {
  if (buff.scope === 'weapon') {
    const worn = (status?.equipment ?? []).join(' ').toLowerCase();
    if (/enchant|dedicat|blessed/.test(worn)) return true;
    return null;
  }
  const entries = status?.enchantment_observations?.entries ?? [];
  if (!entries.length) return status?.enchantment_observations ? false : null;
  const want = buff.name.toLowerCase();
  return entries.some(e => String(e.name ?? e.type ?? '').toLowerCase().includes(want));
}

export function stagePath(fleet, target) {
  const safe = x => String(x).replace(/[^\w.-]+/g, '-');
  return path.join(STAGE_DIR, `staged-${safe(fleet)}-${safe(target)}.json`);
}

/**
 * WHAT PREP LEFT FOR THE ACTION PHASE TO DO. Written by prep, read by action, and carrying
 * the time it was written so a stale staging — a prep from yesterday — is visible rather
 * than silently obeyed.
 */
export function writeStaging(fleet, target, staged) {
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const file = stagePath(fleet, target);
  fs.writeFileSync(file, JSON.stringify({
    schema: 'm59-raid-staging/1', fleet, target, at: Date.now(),
    at_iso: new Date().toISOString(),
    deferred: staged.map(s => ({ name: s.name, scope: s.scope, mana: s.mana,
                                 reagents: s.reagents, why: s.defer_reason })),
  }, null, 1));
  return file;
}

export function readStaging(fleet, target) {
  try {
    const j = JSON.parse(fs.readFileSync(stagePath(fleet, target), 'utf8'));
    return { ...j, age_ms: Date.now() - (j.at ?? 0) };
  } catch { return null; }
}


const safe = x => String(x).replace(/[^\w.-]+/g, '-');
const recordFile = (fleet, target) => path.join(STAGE_DIR, `prep-${safe(fleet)}-${safe(target)}.jsonl`);

/**
 * One agent's prep outcome, appended as it finishes.
 *
 * Append rather than a fleet-wide write, because fleetScript runs agents in PARALLEL and
 * gives a script no fleet-wide hook to summarise from. The aggregate is therefore a read of
 * these records rather than something a run has to hold in memory — which also means the
 * report can be re-read hours later without re-running the prep.
 */
export function recordPrep(fleet, target, record) {
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const file = recordFile(fleet, target);
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...record }) + '\n');
  return file;
}

/**
 * WHAT EACH RAIDER'S PREPARATION LOOKS LIKE NOW — the newest record per agent, and only
 * those from the last ten minutes.
 *
 * ONE ROW PER CHARACTER, NOT ONE PER RUN. Prep is idempotent and therefore re-run, often
 * several times in a few minutes while reagents are fetched or mana comes back. The file is
 * append-only, so a naive window read counts the same character once per attempt: a fleet of
 * four casters reported as "11 raiders, 11 armed", and "7 still up, 4 failed" for a buff that
 * four characters were being asked about. Both halves of that are wrong in the flattering
 * direction, which is the worst way for a readiness report to be wrong.
 *
 * The newest record for an agent supersedes every earlier one, because that is exactly what
 * re-running prep means.
 */
export function readPrepRecords(fleet, target) {
  let lines = [];
  try {
    lines = fs.readFileSync(recordFile(fleet, target), 'utf8')
      .split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
  if (!lines.length) return [];
  const newest = Math.max(...lines.map(l => l.at ?? 0));
  const recent = lines.filter(l => (newest - (l.at ?? 0)) < 10 * 60_000);
  const latest = new Map();
  for (const r of recent) {
    const who = r.agent ?? r.row?.character ?? JSON.stringify(r);
    const prev = latest.get(who);
    if (!prev || (r.at ?? 0) >= (prev.at ?? 0)) latest.set(who, r);
  }
  return [...latest.values()];
}

const human = ms => ms == null ? 'unknown'
  : ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h`
  : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/** The end-of-prep report: what is ready, what was redone, and what went wrong. */
export function prepReport({ target, rows, results, staged, warnings, unknown }) {
  const out = [];
  out.push(`RAID PREPARATION — ${target}`);
  out.push('');
  const byBuff = new Map();
  for (const r of results) {
    const k = r.buff;
    const g = byBuff.get(k) ?? { still: 0, cast: 0, failed: 0, skipped: 0 };
    g[r.outcome] = (g[r.outcome] ?? 0) + 1;
    byBuff.set(k, g);
  }
  out.push('PREPARED');
  if (!byBuff.size) out.push('  nothing was asked for');
  for (const [name, g] of byBuff)
    out.push(`  ${name.padEnd(20)} ${String(g.still ?? 0).padStart(2)} still up, ` +
             `${String(g.cast ?? 0).padStart(2)} cast now, ${String(g.failed ?? 0).padStart(2)} failed` +
             `${g.skipped ? `, ${g.skipped} skipped` : ''}`);
  out.push('');
  out.push('STAGED FOR THE ACTION PHASE — cast in the boss room, not here');
  if (!staged.length) out.push('  nothing deferred');
  for (const s of staged)
    out.push(`  ${s.name.padEnd(20)} ${human(s.duration_ms?.min)}-${human(s.duration_ms?.max)}   ${s.defer_reason}`);
  out.push('');
  out.push('FLEET');
  const armed = rows.filter(r => r.wielded).length;
  out.push(`  ${rows.length} raider(s), ${armed} armed, ` +
           `${rows.filter(r => (r.mana ?? 0) >= 17).length} with mana for another enchant`);
  if (warnings.length) {
    out.push('');
    out.push('WARNINGS');
    for (const w of warnings) out.push(`  ${w}`);
  }
  if (unknown.length) {
    out.push('');
    out.push(`NOT IN THE CATALOGUE: ${unknown.join(', ')} — check the spelling against ` +
             '`node tools/m59-buffs.mjs`; nothing was cast for these.');
  }
  return out.join('\n');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'm59-raid.mjs') {
  if (process.argv.includes('--report')) {
    const [fleet, target] = process.argv.slice(2).filter(x => !x.startsWith('--'));
    if (!fleet || !target) { console.error('usage: m59-raid.mjs --report <fleet> <target>'); process.exit(2); }
    const recs = readPrepRecords(fleet, target);
    if (!recs.length) { console.error(`no prep records for ${fleet}/${target}`); process.exit(1); }
    const staging = readStaging(fleet, target);
    console.log(prepReport({
      target,
      rows: recs.map(r => r.row).filter(Boolean),
      results: recs.flatMap(r => r.results ?? []),
      staged: (staging?.deferred ?? []).map(d => ({ ...d, defer_reason: d.why, duration_ms: null })),
      warnings: recs.flatMap(r => r.warnings ?? []),
      unknown: [],
    }));
    const age = staging ? Math.round((Date.now() - staging.at) / 60_000) : null;
    if (age != null) console.log(`\nstaging written ${age} minute(s) ago` +
      (age > 60 ? ' — long enough that the prep buffs may have lapsed; re-run raid-prep' : ''));
    process.exit(0);
  }
  const wanted = process.argv.slice(2).filter(x => !x.startsWith('--'));
  const plan = planPreparations(wanted.length ? wanted : ['enchant weapon', 'super strength', 'bless', 'forces of light']);
  console.log('CAST DURING PREP, longest-lasting first:');
  for (const s of plan.now) console.log(`  ${s.name.padEnd(20)} ${human(s.duration_ms?.min)}-${human(s.duration_ms?.max)}`);
  console.log('STAGED for the action phase:');
  for (const s of plan.deferred) console.log(`  ${s.name.padEnd(20)} ${s.defer_reason}`);
  if (plan.unknown.length) console.log(`not in the catalogue: ${plan.unknown.join(', ')}`);
}
