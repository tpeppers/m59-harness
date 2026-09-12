#!/usr/bin/env node
// WHO IS WORKING ON WHAT, BEFORE THE FILE EXISTS.
//
//   node tools/m59-intent.mjs nearby "a repl for iterating on fleet errands"
//   node tools/m59-intent.mjs claim  "fleetscratch pads" --by "me" --why "scratchpad tooling"
//   node tools/m59-intent.mjs list
//   node tools/m59-intent.mjs release "fleetscratch pads"
//   node tools/m59-intent.mjs check
//
// ============================================================ WHY THIS IS NOT THE CORK BOARD
//
// The board lists PADS, and the index lists TOOLS, and on 2026-09-11/12 neither would have helped:
// two sessions built a tool called FleetScratch, from one operator ask, all night, and found each
// other only because a third session happened to be talking to both. The deaths-analysis session
// put the reason better than I had:
//
//     "A board of tools would still be a board of things already written. What would actually
//      have saved us is an INTENT — 'I am about to build X' — which is a different artifact from
//      a listing, and it is closer to the run lock than to the index: a claim with a holder and a
//      timestamp that expires."
//
// So this registers the thing that does not exist yet. Same shared directory as the cork board,
// same cross-checkout caveat and same resolution.
//
// ============================================================ IT REPORTS. IT DOES NOT REFUSE.
//
// AN INTENT IS A NOTICE, NOT A LOCK, and that is a deliberate choice rather than a soft start.
// What went wrong was invisibility, not collision — and two sessions on one topic is frequently
// the RIGHT state, because that is where feedback comes from. The rail session and this one were
// on adjacent problems all night and both were better for it; a registry that had refused the
// second claim would have prevented nothing worth preventing and cost the collaboration.
//
// The board refuses an unpinned pad because running one moves a fleet. Nothing moves when you
// declare an intent, so nothing here refuses. `nearby` answers "who should I talk to", which is
// the question that was actually unanswerable.
//
// ============================================================ AND IT EXPIRES, TWO WAYS
//
// An abandoned claim that blocks for ever is worse than no registry, so a claim dies of either:
//
//   the TTL      — declared up front, default 8 hours, because a session is a working day at most
//   its HOLDER   — pid plus process start time, the same checksum m59-runlock.mjs uses. A pid
//                  alone is not enough: pids recycle, and a live process wearing a dead claim's
//                  number is the exact bug this repository has already been bitten by twice.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { boardDir } from './m59-board.mjs';
import { readProcessStartMs } from './m59-runlock.mjs';

export const INTENT_SCHEMA = 'm59-intent-registry/v1';
export const DEFAULT_TTL_HOURS = 8;

export function intentFile(env = process.env) {
  const { dir, by } = boardDir(env);
  return { path: join(dir, 'intents.json'), dir, by };
}

export function readIntents(env = process.env) {
  const { path, dir, by } = intentFile(env);
  if (!existsSync(path)) return { schema: INTENT_SCHEMA, claims: [], path, dir, by, fresh: true };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return { ...doc, claims: doc.claims ?? [], path, dir, by, fresh: false };
  } catch (e) {
    // An unreadable registry is not an empty one — same rule as the board and the policy files.
    return { schema: INTENT_SCHEMA, claims: null, path, dir, by,
             why: `the intent registry will not parse (${e.message}) — UNREADABLE, not empty` };
  }
}

export function writeIntents(doc, env = process.env) {
  const { path, dir } = intentFile(env);
  mkdirSync(dir, { recursive: true });
  const { path: _p, dir: _d, by: _b, fresh: _f, why: _w, ...out } = doc;
  writeFileSync(path, JSON.stringify({ ...out, schema: INTENT_SCHEMA }, null, 2));
  return path;
}

// ------------------------------------------------------------------ is a claim still alive?
export const LIVE = 'live', EXPIRED = 'expired', ABANDONED = 'abandoned';
const START_TOLERANCE_MS = 2000;

/**
 * `live`, `expired` (the TTL ran out) or `abandoned` (the holder is gone).
 *
 * Abandoned is the interesting one: a session that crashed leaves a claim that looks exactly like
 * a session still thinking. Checking the pid AND its start time is what tells them apart, and a
 * pid alone would pass a recycled number.
 */
export function claimState(claim, { now = Date.now(), startOf = readProcessStartMs } = {}) {
  if (now > (claim.until ?? 0)) return { state: EXPIRED, why: `the TTL ran out` };
  const pid = claim.pid;
  if (!Number.isInteger(pid) || pid <= 0)
    return { state: LIVE, why: 'no pid was recorded, so only the TTL can retire this one' };
  const started = startOf(pid);
  if (started === null) return { state: ABANDONED, why: `pid ${pid} is not running` };
  if (Number.isFinite(claim.startedAt) && Math.abs(started - claim.startedAt) > START_TOLERANCE_MS)
    return { state: ABANDONED, why: `pid ${pid} was recycled — it started ` +
                                    `${new Date(started).toISOString()}, the claim says ` +
                                    `${new Date(claim.startedAt).toISOString()}` };
  return { state: LIVE, why: null };
}

// ------------------------------------------------------------------ finding the neighbours
//
// TERM OVERLAP, NOT TAGS. Nobody agrees on tags, and the incident this exists for is two sessions
// using THE SAME WORD without finding each other — so an exact-match scheme would have failed at
// exactly the moment it was needed. Overlap is scored both ways because "pads" should find
// "fleetscratch pads" and vice versa, and a long claim should not win on length alone.
const STOP = new Set(['a', 'an', 'the', 'for', 'and', 'or', 'of', 'to', 'in', 'on', 'with', 'is',
                      'it', 'that', 'this', 'from', 'by', 'at', 'as', 'be', 'are', 'my', 'our']);

/**
 * Words that describe almost everything in this repository, so sharing one means nothing.
 *
 * Without this list a ratio is the only signal, and A RATIO FAILS THE CASE THIS FILE EXISTS FOR.
 * Measured against the real collision: "FleetScratch pads and the errand compiler" against
 * "FleetScratch: a REPL toolkit and debugging tools for fleet issues" shares exactly one term —
 * `fleetscratch` — for a ratio of 1/7, well under any floor worth having. The one shared word was
 * the entire signal, and scoring by proportion threw it away.
 */
export const COMMON = new Set([
  'fleet', 'fleets', 'tool', 'tools', 'test', 'tests', 'character', 'characters', 'agent',
  'agents', 'broker', 'keeper', 'keepers', 'server', 'room', 'rooms', 'run', 'running', 'work',
  'code', 'file', 'files', 'data', 'report', 'reports', 'session', 'sessions', 'harness',
  'm59', 'meridian', 'thing', 'things', 'some', 'about', 'into', 'they', 'them', 'when', 'what',
  'which', 'while', 'would', 'could', 'should', 'make', 'making', 'build', 'building', 'using',
]);

export const terms = (s) => [...new Set(String(s ?? '').toLowerCase()
  .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)))];

/** A term nobody else would have used by accident. */
export const isDistinctive = (w) => !COMMON.has(w) && w.length > 3;

/**
 * How near are these two topics, and WHY.
 *
 * Two rules, because one of them fails the motivating case:
 *
 *   ratio        the share of the smaller side. Catches paraphrases of one idea.
 *   distinctive  ANY shared term that is not a repository-common word. Catches the case that
 *                actually happened — two sessions reaching for the same unusual noun.
 *
 * `by` names which rule fired, so a reader can see whether a match is a real neighbour or two
 * long descriptions brushing past each other.
 */
export function overlap(a, b) {
  const A = terms(a), B = terms(b);
  if (!A.length || !B.length) return { score: 0, shared: [], distinctive: [], matchedBy: 'nothing' };
  const shared = A.filter(w => B.includes(w));
  const distinctive = shared.filter(isDistinctive);
  const ratio = shared.length / Math.min(A.length, B.length);
  return {
    score: distinctive.length ? Math.max(ratio, 1) : ratio,
    ratio, shared, distinctive,
    // NAMED `matchedBy`, NOT `by`: a claim already has a `by` — the person to talk to — and
    // spreading an overlap over a claim silently replaced the author with the match reason.
    matchedBy: distinctive.length ? `shared distinctive term(s): ${distinctive.join(', ')}`
      : shared.length ? `${Math.round(ratio * 100)}% term overlap`
      : 'nothing',
  };
}

export const NEARBY_FLOOR = 0.34;

/**
 * Who else is near this topic, live claims first.
 *
 * Returns everything above the floor with its score and shared terms, so a caller can see WHY
 * something matched rather than trusting a number. Dead claims are returned too, marked — because
 * "somebody tried this last week and stopped" is useful, and hiding it would lose it.
 */
export function nearby(doc, topic, { now = Date.now(), floor = NEARBY_FLOOR,
                                     startOf = readProcessStartMs } = {}) {
  if (doc.claims === null) return { ok: false, why: doc.why, hits: [] };
  const hits = [];
  for (const c of doc.claims) {
    const o = overlap(topic, `${c.topic} ${c.why ?? ''}`);
    if (o.score < floor) continue;
    const st = claimState(c, { now, startOf });
    hits.push({ ...c, ...o, state: st.state, stateWhy: st.why });
  }
  hits.sort((a, b) => (a.state === LIVE ? 0 : 1) - (b.state === LIVE ? 0 : 1) || b.score - a.score);
  return { ok: true, hits, live: hits.filter(h => h.state === LIVE) };
}

/**
 * Record an intent.
 *
 * `pid` IS OPT-IN, AND THE DEFAULT IS NOT `process.pid`. It was, and a smoke test caught what that
 * means: `m59-intent.mjs claim "..."` is a one-shot process that exits the instant it has written
 * the file, so the claim it just made was ABANDONED before anyone could read it — the holder check
 * is honest, and it was checking a process that had already gone. A pid is a promise that
 * something is still sitting there, and only a long-lived caller can make it: the FleetScratch
 * session passes its own, a keeper would pass its own, a CLI invocation has nobody to offer. With
 * no pid a claim can still only die one way, on its TTL, which is the right death for "I am
 * working on this today" typed at a prompt.
 */
export function claim(doc, { topic, by, why = null, files = [], ttlHours = DEFAULT_TTL_HOURS,
                             now = Date.now(), pid = null,
                             startOf = readProcessStartMs } = {}) {
  if (!topic) throw new Error('an intent needs a topic — the thing you are about to work on');
  if (!by) throw new Error('an intent needs `by` — who to talk to is the entire point of this file');
  const claims = (doc.claims ?? []).filter(c => !(c.topic === topic && c.by === by));
  claims.push({ topic, by, why, files: [].concat(files).filter(Boolean),
                at: new Date(now).toISOString(), until: now + ttlHours * 3600_000,
                ...(Number.isInteger(pid) && pid > 0
                    ? { pid, startedAt: startOf(pid) } : {}) });
  return { ...doc, claims };
}

export function release(doc, topic, by = null) {
  const before = (doc.claims ?? []).length;
  const claims = (doc.claims ?? []).filter(c => !(c.topic === topic && (!by || c.by === by)));
  if (claims.length === before)
    throw new Error(`no live intent on "${topic}"${by ? ` by ${by}` : ''} — check \`list\``);
  return { ...doc, claims };
}

/** Retire what is dead. Returns the doc and what it dropped, so the drop is reportable. */
export function sweep(doc, { now = Date.now(), startOf = readProcessStartMs } = {}) {
  const kept = [], dropped = [];
  for (const c of doc.claims ?? []) {
    const st = claimState(c, { now, startOf });
    (st.state === LIVE ? kept : dropped).push({ ...c, state: st.state, stateWhy: st.why });
  }
  return { doc: { ...doc, claims: kept }, dropped };
}

export function formatNearby(res, topic) {
  if (!res.ok) return `  ${res.why}`;
  if (!res.hits.length)
    return `  nobody is working on "${topic}" that this registry can see.\n` +
           `  If another checkout is in it, both must point at one directory — see \`list\`.`;
  const out = [`  ${res.live.length} live and ${res.hits.length - res.live.length} finished ` +
               `claim(s) near "${topic}":`];
  for (const h of res.hits) {
    const mark = h.state === LIVE ? 'LIVE ' : `${h.state.slice(0, 5)}`;
    out.push(`    ${mark} ${h.by} — ${h.topic}`);
    if (h.why) out.push(`           ${h.why}`);
    out.push(`           matched on ${h.matchedBy}` +
             (h.state === LIVE ? '' : `   (${h.stateWhy})`));
    if (h.files?.length) out.push(`           files: ${h.files.join(', ')}`);
  }
  if (res.live.length)
    out.push('', '  These are people to TALK TO, not a refusal. Two sessions on one topic is ' +
                 'where feedback', '  comes from — the failure this registry exists for was ' +
                 'not knowing they were there.');
  return out.join('\n');
}

export function formatIntents(doc, { now = Date.now(), startOf = readProcessStartMs } = {}) {
  const out = [`intent registry`, `  ${doc.path}`, `  (location chosen by: ${doc.by})`];
  if (doc.claims === null) { out.push('', `  ${doc.why}`); return out.join('\n'); }
  if (!doc.claims.length) {
    out.push('', '  nothing is claimed HERE — which is not the same as nothing being claimed.',
             '  Two checkouts coordinate only if both point at one directory:',
             '    M59_BOARD_DIR=<shared>   (or share M59_RUNLOCK_DIR, which this falls back to)');
    return out.join('\n');
  }
  out.push('');
  for (const c of doc.claims) {
    const st = claimState(c, { now, startOf });
    const left = Math.round((c.until - now) / 3600_000);
    out.push(`  ${st.state === LIVE ? 'LIVE ' : st.state.slice(0, 5)} ${c.by} — ${c.topic}`);
    if (c.why) out.push(`         ${c.why}`);
    out.push(`         ${st.state === LIVE ? `${left}h left` : st.why}`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ CLI
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]).replace(/\.mjs$/, '') === 'm59-intent';
if (invokedDirectly) {
  const [action, target, ...rest] = process.argv.slice(2);
  const arg = (k, d = null) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? (rest[i + 1] ?? true) : d;
  };
  try {
    let doc = readIntents();
    if (action === 'nearby') {
      if (!target) throw new Error('usage: m59-intent.mjs nearby "<what you are about to build>"');
      console.log(formatNearby(nearby(doc, target), target));
    } else if (action === 'claim') {
      const swept = sweep(doc);
      // --pid binds the claim to a process, so it dies when that process does. Typed at a
      // prompt there is no such process, and the claim lives on its TTL alone.
      const boundPid = arg('pid') ? Number(arg('pid')) : null;
      doc = claim(swept.doc, { topic: target, by: arg('by'), why: arg('why'), pid: boundPid,
                               files: String(arg('files', '')).split(/[\s,]+/).filter(Boolean),
                               ttlHours: Number(arg('hours', DEFAULT_TTL_HOURS)) });
      console.log(`claimed "${target}" in ${writeIntents(doc)}`);
      const near = nearby(doc, target);
      const others = { ...near, hits: near.hits.filter(h => h.by !== arg('by')) };
      others.live = others.hits.filter(h => h.state === LIVE);
      if (others.hits.length) { console.log(''); console.log(formatNearby(others, target)); }
      for (const d of swept.dropped) console.log(`  (retired ${d.by}'s "${d.topic}" — ${d.stateWhy})`);
    } else if (action === 'release') {
      doc = release(doc, target, arg('by'));
      console.log(`released "${target}" in ${writeIntents(doc)}`);
    } else if (action === 'list' || !action) {
      console.log(formatIntents(doc));
    } else if (action === 'check') {
      const swept = sweep(doc);
      console.log(formatIntents(doc));
      if (swept.dropped.length) {
        console.log('');
        for (const d of swept.dropped) console.log(`  retire: ${d.by} "${d.topic}" — ${d.stateWhy}`);
        writeIntents(swept.doc);
      }
    } else {
      console.log('usage: m59-intent.mjs nearby <topic> | claim <topic> --by W --why X ' +
                  '[--hours N] [--files a,b] | release <topic> | list | check');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`m59-intent: ${e.message}`);
    process.exitCode = 1;
  }
}
