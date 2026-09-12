#!/usr/bin/env node
// WHICH REALITY IS THIS SERVER RUNNING IN, AND WHAT DID THE SCENE DO ACROSS SEVERAL.
//
//   node tools/m59-reality.mjs which                 ask the server what seed it booted with
//   node tools/m59-reality.mjs survey <survey.json>  the distribution, with seeds and SHAs
//
// ============================================================ AN UNPATCHED SERVER IS NOT AN ERROR
//
// This is the first rule and it shapes the whole module. The stock blakserv never calls `srand`,
// so its `rand()` stream is the same sequence on every boot: **there is exactly one reality, and
// it is a perfectly good one.** A harness that demanded the seed patch in order to function would
// have made every stock server useless for no gain.
//
// So `readSeed()` asks `show simseed` and treats not knowing the command as an ANSWER --
// `{ patched: false, seed: 0 }` -- rather than a failure. Everything downstream degrades to "one
// reality, unseeded", which is honest, and a survey across one reality is still a survey; it just
// cannot vary the thing it would have liked to vary, and says so.
//
// ============================================================ WHAT A SEED BUYS
//
// server-patches/deterministic-seed adds `[SimSeed] Enabled/Seed` and one `srand(N)` immediately
// after LoadConfig, before anything can draw. That makes the reality SELECTABLE, which is what
// turns "it worked when I tried it" into "it worked in 5 of 10 realities" -- a far more useful
// sentence, and the only one that distinguishes a close fight from a reliable one.
//
// It does NOT make a run reproducible on its own. One global stream is shared by every consumer,
// so a wandering monster or a second login consumes draws and shifts everything downstream. Seeds
// select the stream; quiescing the room is what keeps two runs on the same part of it.
import { readFileSync, existsSync } from 'node:fs';
import { dm, adminTarget, isLoopbackHost } from './m59-dm.mjs';

export const SEED_COMMAND = 'show simseed';
export const UNSEEDED = 0;

/**
 * Ask the server which reality it is in. Never throws for an unpatched server.
 *
 * `{ patched, seed, why }` — `patched:false, seed:0` is the stock server and a complete answer.
 */
export async function readSeed({ dmFn = dm, env = process.env } = {}) {
  const t = adminTarget(env);
  if (!isLoopbackHost(t.host))
    return { patched: false, seed: UNSEEDED, reachable: false,
             why: `no admin socket here (${t.host}) — production is never seeded, and asking it ` +
                  `would mean opening a DM socket to somebody else's server` };
  let out = '';
  try { out = String(await dmFn([SEED_COMMAND], { env })); }
  catch (e) {
    return { patched: false, seed: UNSEEDED, reachable: false,
             why: `could not reach the admin socket: ${e.message}` };
  }
  const m = /\bseeded\s+(-?\d+)/i.exec(out);
  if (!m)
    // THE UNPATCHED PATH, AND IT IS A RESULT. An older server answers its ordinary
    // unknown-command error, which tells us exactly what we wanted to know.
    return { patched: false, seed: UNSEEDED, reachable: true,
             why: 'this server does not know `show simseed`, so it is unpatched — one reality, ' +
                  'the stock rand() stream, identical every boot' };
  const seed = Number(m[1]);
  return { patched: true, seed, reachable: true,
           why: seed === UNSEEDED
             ? 'patched, but seeding is off — the stock stream, identical every boot'
             : `patched and seeded with ${seed}` };
}

export const realityLabel = (s) =>
  !s.patched ? 'unseeded (stock stream)'
  : s.seed === UNSEEDED ? 'unseeded (patch present, seeding off)'
  : `seed ${s.seed}`;

// ------------------------------------------------------------------ the survey
//
// PURE OVER RUNS THAT ALREADY HAPPENED. Booting a server N times with N seeds is orchestration
// that belongs with the docker build (see m59-sim-server.mjs); what lives here is the part that
// turns those runs into a sentence, and it is testable with no server at all.

/**
 * Fold a list of `{ seed, outcome }` into a distribution.
 *
 * `outcome` is whatever the scenario calls its result -- 'fleet', 'ghost', 'timeout'. This does
 * not know what any of them mean and deliberately does not rank them.
 */
export function surveyOutcomes(runs = []) {
  const byOutcome = new Map();
  const seeds = [];
  for (const r of runs) {
    const o = String(r.outcome ?? 'unknown');
    if (!byOutcome.has(o)) byOutcome.set(o, []);
    byOutcome.get(o).push(r.seed);
    seeds.push(r.seed);
  }
  const total = runs.length;
  const rows = [...byOutcome.entries()]
    .map(([outcome, s]) => ({ outcome, count: s.length, seeds: s,
                              share: total ? s.length / total : 0 }))
    .sort((a, b) => b.count - a.count || String(a.outcome).localeCompare(String(b.outcome)));

  // REALITIES, NOT RUNS. Ten runs on one seed is one reality sampled ten times, which answers a
  // different question and must not be reported as breadth.
  const realities = new Set(seeds.map(s => (s == null ? UNSEEDED : s))).size;
  const decided = rows.length === 1;
  return { total, realities, rows, decided,
           closest: rows.length > 1 ? Math.abs(rows[0].share - rows[1].share) : 1 };
}

/**
 * The sentence the operator asked for, with everything needed to re-run it.
 *
 * The SHAs are not decoration: a distribution without the code that produced it is a story. Three
 * repositories decide what happens, and the server is the one people forget because it is the one
 * nobody edits during a session.
 */
export function formatSurvey({ scenario = 'the scenario', runs = [], provenance = null,
                               seeded = true } = {}) {
  const s = surveyOutcomes(runs);
  const out = [];
  if (!s.total) return `${scenario}: no runs.`;

  const pct = n => `${Math.round(n * 100)}%`;
  const lead = s.decided
    ? `${scenario}: ${s.rows[0].outcome} every time — ${s.rows[0].count} of ${s.total}.`
    : `${scenario}: ${s.rows[0].outcome} won ${s.rows[0].count} of ${s.total}` +
      (s.closest <= 0.2 ? ` — A CLOSE ONE.` : `.`);
  out.push(lead);
  out.push('');
  for (const r of s.rows)
    out.push(`  ${String(r.count).padStart(3)}/${s.total}  ${pct(r.share).padStart(4)}  ` +
             `${r.outcome}   seeds: ${r.seeds.join(', ')}`);
  out.push('');

  // THE BREADTH CAVEAT, WHICH IS THE ONE THAT GETS DROPPED.
  if (!seeded)
    out.push(`  ONE REALITY. This server is unseeded, so every run drew from the same stream — ` +
             `${s.total} samples of one reality rather than ${s.total} realities. Build ` +
             `server-patches/deterministic-seed to vary it.`);
  else if (s.realities < s.total)
    out.push(`  ${s.realities} realit${s.realities === 1 ? 'y' : 'ies'} across ${s.total} runs — ` +
             `some seeds were sampled more than once, which is depth rather than breadth.`);
  else
    out.push(`  ${s.realities} realities, one run each.`);

  if (provenance) {
    out.push('');
    out.push('  git sha:');
    for (const [which, v] of Object.entries(provenance))
      out.push(`    ${which.padEnd(8)} ${v?.commit ? v.commit.slice(0, 12) : 'UNPINNED'}` +
               `${v?.dirty ? '  DIRTY — nobody else can check this out' : ''}` +
               `${v?.why ? `  (${v.why})` : ''}`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ CLI
import { basename } from 'node:path';
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]).replace(/\.mjs$/, '') === 'm59-reality';
if (invokedDirectly) {
  const [action, target] = process.argv.slice(2);
  try {
    if (action === 'which') {
      const s = await readSeed();
      console.log(`${realityLabel(s)}`);
      console.log(`  ${s.why}`);
      if (!s.patched && s.reachable)
        console.log('  (this is not a problem — it is one reality, and a perfectly good one)');
    } else if (action === 'survey') {
      if (!target || !existsSync(target)) throw new Error('usage: m59-reality.mjs survey <file.json>');
      const doc = JSON.parse(readFileSync(target, 'utf8'));
      console.log(formatSurvey(doc));
    } else {
      console.log('usage: m59-reality.mjs which | survey <file.json>');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`m59-reality: ${e.message}`);
    process.exitCode = 1;
  }
}
