#!/usr/bin/env node
// TUNE-FARMING — change one thing, predict what it will do, and let the clock decide.
//
//   node tools/m59-tune-farming.mjs status
//   node tools/m59-tune-farming.mjs measure [--minutes 30]
//   node tools/m59-tune-farming.mjs propose --why "..." --change "..." --predict 1.4 \
//        [--agents t1,t2] [--force] [--supersede]
//   node tools/m59-tune-farming.mjs applied
//   node tools/m59-tune-farming.mjs verdict
//   node tools/m59-tune-farming.mjs log
//
// WHY THIS EXISTS, and it is a confession rather than a design note.
//
// On 2026-09-18 this repository's farming rate went from ~2.4 kills/min to 0.57 over three hours
// while a session — me — "optimised" it. Four things went wrong and every one of them is a rule
// below:
//
//   * I measured a baseline in a window POLLUTED by my own errands, then read every later number
//     as progress against it. The fleet's real rate was never 0.87; that was the damage.
//   * I changed several things at once — a hunt list, a vigor gate, a station roster — and then
//     could not attribute the result to any of them.
//   * I restarted DUM four times in three hours, which drops leases mid-work, and did not count
//     the restarts themselves as a variable.
//   * I reported "fixed" twice on values that were being silently overwritten a minute later.
//
// None of that was a missing fact. It was the absence of a procedure. So this tool is the
// procedure, and its refusals are the product:
//
//   1. A CHANGE NEEDS A NUMBER. `propose` demands a predicted kills/min. An experiment without a
//      falsifiable prediction is a change with a story attached, and a story always wins.
//   2. ONE CHANGE PER WINDOW. `propose` refuses within MIN_GAP_MS of the last applied change.
//      Two changes in one window is two variables and no experiment.
//   3. A MEASUREMENT MAY NOT SPAN A CHANGE. `measure` refuses a window containing an applied
//      change unless asked to, because that number describes two configurations at once.
//   4. THE WINDOW GROWS WITH EVERY CHANGE. Each applied change adds GROW_MS to how long the
//      review runs, which is the operator's own rule: earn your reading time.
//   6. A FLEET TOTAL IS NOT THE EXPERIMENT. Added after change #2 missed on 2026-09-18: nine
//      blocked characters were unblocked, five of them became earners for the first time in the
//      session -- and the fleet rate FELL, because the baseline window was 28% one character
//      (Scooter, 29 of 102 kills) who was hurt in a far room for unrelated reasons. A rate one
//      character can carry by a quarter has a noise floor wider than most changes worth making.
//      So `propose --agents` names who the change touches and the verdict reports THOSE
//      characters before and after, with the fleet total kept only as context.
//
//   5. A VERDICT NEEDS A SAMPLE. `verdict` refuses before MIN_VERDICT_MS and below
//      MIN_VERDICT_KILLS, because a rate computed off three kills in one minute is noise
//      wearing a decimal point — and it will read as HELD about as often as not. `--anyway`
//      gets it, and the record then carries `provisional: true` for ever, because the whole
//      failure this tool exists for is a confident number nobody could challenge later.
//
// KILLS COME FROM THE LEDGER, NEVER FROM A KEEPER'S TALLY. `Autopilot.tally.kills` resets in the
// constructor and keepers restart about once a minute, so it answers "since the last restart" and
// cannot answer "is this working". This reads `kind: "killed"` rows, whose timestamp field is `t`.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet, ledgerDirFor } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const MIN_GAP_MS = 15 * 60_000;   // no second change inside this
export const GROW_MS = 30 * 60_000;      // every applied change buys this much more review
export const MIN_VERDICT_MS = 15 * 60_000;  // a verdict before this is a coin toss with a decimal
export const MIN_VERDICT_KILLS = 30;        // ...and so is one off a handful of kills

const { fleet: FLEET } = resolveFleet();
const STATE = process.env.M59_TUNE_FILE || join(REPO, 'substrate', `tune-farming-${FLEET || 'default'}.json`);

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes('--' + n);
const ago = (ms) => ms == null ? '—' : `${Math.round(ms / 60000)}m`;

// ---------------------------------------------------------------- the record

export function load(file = STATE) {
  if (!existsSync(file)) return { version: 1, started_at: null, experiments: [], source: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { version: raw.version ?? 1, started_at: raw.started_at ?? null,
             experiments: Array.isArray(raw.experiments) ? raw.experiments : [], source: file };
  } catch (e) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. Treating it as empty would silently
    // reset the rate limit, which is the one thing this tool is for.
    throw new Error(`the tuning record at ${file} will not parse (${e.message}). Fix or move it; ` +
                    'refusing to continue, because an unreadable record reads as "no changes yet" ' +
                    'and would hand back the rate limit it exists to enforce');
  }
}

export function save(rec, file = STATE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, started_at: rec.started_at,
                                       experiments: rec.experiments }, null, 1));
  return file;
}

/** The last change actually applied to the fleet, or null. */
export const lastApplied = (rec) =>
  [...(rec.experiments ?? [])].filter(e => e.applied_at).sort((a, b) => b.applied_at - a.applied_at)[0] ?? null;

/** The experiment proposed but not yet applied, or null. */
export const openProposal = (rec) =>
  (rec.experiments ?? []).find(e => !e.applied_at && !e.abandoned) ?? null;

/** The experiment applied but not yet judged, or null. */
export const openExperiment = (rec) =>
  [...(rec.experiments ?? [])].filter(e => e.applied_at && !e.verdict)
    .sort((a, b) => b.applied_at - a.applied_at)[0] ?? null;

/**
 * HOW LONG THE REVIEW RUNS. The operator's rule: a change buys another GROW_MS of watching.
 * Stated as a function rather than a stored number so it cannot drift from the history.
 */
export function reviewWindow(rec, now = Date.now()) {
  const applied = (rec.experiments ?? []).filter(e => e.applied_at);
  const base = rec.started_at ?? now;
  const ends = base + GROW_MS + applied.length * GROW_MS;
  return { started_at: base, ends_at: ends, remaining_ms: Math.max(0, ends - now),
           changes: applied.length };
}

/** May a change be proposed right now? The refusal carries the wait. */
export function mayChange(rec, now = Date.now()) {
  const last = lastApplied(rec);
  if (!last) return { ok: true, why: 'no change has been applied yet' };
  const since = now - last.applied_at;
  if (since >= MIN_GAP_MS) return { ok: true, why: `${ago(since)} since the last change` };
  return { ok: false, wait_ms: MIN_GAP_MS - since,
           why: `only ${ago(since)} since "${last.change}" — one change per ${ago(MIN_GAP_MS)} ` +
                `window, so wait ${ago(MIN_GAP_MS - since)}. Two changes in one window is two ` +
                'variables and no experiment' };
}

// ---------------------------------------------------------------- the measurement

/** Every kill row in the window, read from the ledger this fleet actually writes. */
export function killsIn(fromMs, toMs, { dir = null } = {}) {
  const d = dir || ledgerDirFor(FLEET);
  const out = [];
  const days = new Set();
  for (let t = fromMs; t <= toMs + 86400000; t += 86400000)
    days.add(new Date(t).toISOString().slice(0, 10));
  for (const day of days) {
    const f = join(d, `fleet-${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"killed"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.kind !== 'killed') continue;
      const t = r.t ?? 0;
      if (t < fromMs || t > toMs) continue;
      out.push(r);
    }
  }
  return out;
}

export function summarise(rows, minutes) {
  const byRoom = {}, byChar = {}, byCreature = {};
  for (const r of rows) {
    byRoom[r.room_num] = (byRoom[r.room_num] || 0) + 1;
    byChar[r.character] = (byChar[r.character] || 0) + 1;
    byCreature[r.creature] = (byCreature[r.creature] || 0) + 1;
  }
  return { kills: rows.length, minutes,
           kpm: minutes > 0 ? rows.length / minutes : 0,
           rooms: byRoom, characters: byChar, creatures: byCreature };
}

const sortDesc = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

// ---------------------------------------------------------------- cli

const isMain = !!process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (isMain) {
  const cmd = process.argv[2] || 'status';
  const rec = load();
  const now = Date.now();

  if (cmd === 'status') {
    const w = reviewWindow(rec, now);
    const gate = mayChange(rec, now);
    const open = openExperiment(rec);
    const prop = openProposal(rec);
    console.log(`tune-farming · fleet "${FLEET}" · record ${rec.source ?? '(none yet)'}`);
    console.log(`  review     ${w.changes} change(s) applied → window ends in ${ago(w.remaining_ms)}`);
    console.log(`  may change ${gate.ok ? 'YES' : 'NO'} — ${gate.why}`);
    if (prop) console.log(`  PROPOSED   "${prop.change}" (predict ${prop.predict_kpm}/min) — not yet applied`);
    if (open) console.log(`  OPEN       "${open.change}" applied ${ago(now - open.applied_at)} ago, ` +
                          `predicted ${open.predict_kpm}/min, no verdict yet`);
    if (!prop && !open) console.log('  nothing open — propose a change, or just measure');
  }

  else if (cmd === 'measure') {
    const minutes = Number(arg('minutes', 30));
    const to = now, from = now - minutes * 60_000;
    // RULE 3: a window that spans a change describes two configurations at once.
    const spanned = (rec.experiments ?? []).filter(e => e.applied_at >= from && e.applied_at <= to);
    if (spanned.length && !has('anyway')) {
      console.log(`refusing: this ${minutes}m window contains ${spanned.length} applied change(s):`);
      for (const e of spanned) console.log(`   ${ago(now - e.applied_at)} ago — ${e.change}`);
      console.log('That number would describe two configurations at once, which is how a fleet');
      console.log('gets "tuned" into the ground. Wait, shorten --minutes, or pass --anyway.');
      process.exit(2);
    }
    const s = summarise(killsIn(from, to), minutes);
    console.log(`${s.kills} kills in ${minutes}m = ${s.kpm.toFixed(2)}/min`);
    console.log('  by room     ' + (sortDesc(s.rooms).map(([k, v]) => `${k}:${v}`).join('  ') || '—'));
    console.log('  by creature ' + (sortDesc(s.creatures).map(([k, v]) => `${k}:${v}`).join('  ') || '—'));
    const chars = sortDesc(s.characters);
    console.log(`  earners     ${chars.length}`);
    for (const [c, n] of chars) console.log(`     ${String(c).padEnd(16)} ${n}`);
  }

  else if (cmd === 'propose') {
    const why = arg('why'), change = arg('change'), predict = Number(arg('predict', NaN));
    if (!why || !change || !Number.isFinite(predict)) {
      console.error('propose needs --why "<the theory>" --change "<what you will do>" ' +
                    '--predict <kills/min you expect>');
      console.error('A prediction is mandatory. Without a number this is a change with a story ' +
                    'attached, and the story always wins.');
      process.exit(2);
    }
    const gate = mayChange(rec, now);
    if (!gate.ok && !has('force')) { console.error('refused: ' + gate.why); process.exit(3); }
    if (gate.ok === false && has('force')) console.log('(forced past the rate limit — say so in the verdict)');

    // A SECOND PROPOSAL IS AN EDIT, NOT AN EXPERIMENT. Without this, two proposals sat open at
    // once on 2026-09-18 and `applied` marked the FIRST of them — so the record would have
    // named a change nobody made. Say `--supersede` and mean it.
    const already = openProposal(rec);
    if (already && !has('supersede')) {
      console.error(`refused: #${already.id} is already proposed and not yet applied:`);
      console.error(`   "${already.change}" (predict ${already.predict_kpm}/min)`);
      console.error('Apply it, or pass --supersede to abandon it for this one.');
      process.exit(3);
    }
    if (already) { already.abandoned = true; already.abandoned_why = 'superseded at propose time'; }

    // THE BASELINE MUST NOT SPAN A CHANGE EITHER — `measure` refuses one and it would be
    // incoherent for the number an experiment is JUDGED against to be held to a looser standard.
    // So the baseline runs back only as far as the last applied change.
    const last = lastApplied(rec);
    const span = Math.max(1, Math.min(30, last ? Math.round((now - last.applied_at) / 60_000) : 30));
    const before = summarise(killsIn(now - span * 60_000, now), span);
    const agents = String(arg('agents', '') || '').split(/[\s,]+/).filter(Boolean);

    rec.started_at = rec.started_at ?? now;
    rec.experiments.push({ id: rec.experiments.length + 1, proposed_at: now, why, change,
                           predict_kpm: predict, baseline_kpm: Number(before.kpm.toFixed(3)),
                           baseline_kills: before.kills, baseline_minutes: span,
                           agents: agents.length ? agents : undefined,
                           baseline_by_character: before.characters,
                           forced: has('force') || undefined });
    console.log(`proposed #${rec.experiments.length}: ${change}`);
    console.log(`  theory     ${why}`);
    console.log(`  baseline   ${before.kpm.toFixed(2)}/min over ${span}m` +
                (span < 30 ? ` (shortened: a change landed ${ago(now - last.applied_at)} ago)` : ''));
    if (agents.length) console.log(`  touches    ${agents.join(' ')}`);
    console.log(`  predicting ${predict}/min`);
    console.log(`  -> make the change, then: m59-tune-farming.mjs applied`);
    console.log(save(rec));
  }

  else if (cmd === 'applied') {
    const prop = openProposal(rec);
    if (!prop) { console.error('nothing proposed — propose first, so the prediction predates the change'); process.exit(2); }
    prop.applied_at = now;
    const w = reviewWindow(rec, now);
    console.log(`#${prop.id} applied: ${prop.change}`);
    console.log(`  review window now ends in ${ago(w.remaining_ms)} (${w.changes} change(s) × ${ago(GROW_MS)})`);
    console.log(`  next change allowed in ${ago(MIN_GAP_MS)}`);
    console.log(save(rec));
  }

  else if (cmd === 'verdict') {
    const open = openExperiment(rec);
    if (!open) { console.error('no applied experiment is waiting for a verdict'); process.exit(2); }
    const since = now - open.applied_at;
    const minutes = Math.max(1, Math.round(since / 60000));
    const after = summarise(killsIn(open.applied_at, now), minutes);

    // RULE 5. Measured 2026-09-18 while exercising this tool: one minute after `applied`, a
    // window holding three kills answered "prediction HELD" against a prediction of 3.1 — a
    // ratio that lands inside the 20% band by accident roughly as often as not. A verdict that
    // can be reached in a minute is a verdict that will be reached in a minute, by a session in
    // a hurry, and then quoted for the rest of the day.
    const thin = [];
    if (since < MIN_VERDICT_MS) thin.push(`only ${ago(since)} since the change (need ${ago(MIN_VERDICT_MS)})`);
    if (after.kills < MIN_VERDICT_KILLS) thin.push(`only ${after.kills} kill(s) in it (need ${MIN_VERDICT_KILLS})`);
    if (thin.length && !has('anyway')) {
      console.error(`refusing a verdict on #${open.id}: ${thin.join(', ')}.`);
      console.error(`A rate off this little is noise with a decimal point. Wait, or pass --anyway`);
      console.error(`and the record will carry it as provisional for ever.`);
      process.exit(3);
    }

    open.verdict = {
      at: now, minutes, measured_kpm: Number(after.kpm.toFixed(3)), kills: after.kills,
      provisional: thin.length ? thin.join('; ') : undefined,
      predicted_kpm: open.predict_kpm, baseline_kpm: open.baseline_kpm,
      // HELD, not "worked". A prediction that lands within 20% is a model that is working;
      // one that does not is the interesting case and must not be quietly rounded into success.
      held: Math.abs(after.kpm - open.predict_kpm) <= 0.2 * Math.max(0.01, open.predict_kpm),
      better_than_baseline: after.kpm > open.baseline_kpm,
    };
    open.verdict.by_character = after.characters;
    const v = open.verdict;
    console.log(`#${open.id} ${open.change}`);
    console.log(`  predicted ${v.predicted_kpm}/min · measured ${v.measured_kpm}/min over ${minutes}m ` +
                `· baseline was ${v.baseline_kpm}/min`);
    console.log(`  prediction ${v.held ? 'HELD' : 'MISSED'} · ` +
                `${v.better_than_baseline ? 'better' : 'NOT better'} than baseline`);
    if (v.provisional) console.log(`  PROVISIONAL — ${v.provisional}. Do not quote this as a result.`);
    // RULE 6. The characters the change TOUCHED are the experiment; the fleet total is context.
    // Without this, change #2 read as a clean failure while five of its nine subjects went from
    // zero to earning for the first time all session.
    const touched = open.agents ?? [];
    const namesOf = (o) => Object.keys(o ?? {});
    // A MISSING BASELINE IS NOT A BASELINE OF ZERO, and this is rule 6 failing in its own first
    // use. Experiment #3 predated `baseline_by_character`, so the per-character table printed
    // `0.00 -> 0.52` for eight characters, every one of which had been earning perfectly well
    // before the change. A table of fabricated gains is worse than no table: it is the confident
    // wrong number this whole tool exists to make unsayable.
    const haveBaseline = !!open.baseline_by_character;
    const b = open.baseline_by_character ?? {}, a2 = after.characters ?? {};
    const everyone = [...new Set([...namesOf(b), ...namesOf(a2)])].sort();
    const perMin = (n, m) => m > 0 ? n / m : 0;
    const moved = everyone
      .map(n => ({ n, was: perMin(b[n] ?? 0, open.baseline_minutes ?? 30), now: perMin(a2[n] ?? 0, minutes) }))
      .map(r => ({ ...r, d: r.now - r.was }))
      .sort((x, y) => y.d - x.d);
    if (!haveBaseline) {
      console.log('  no per-character baseline was recorded for this experiment, so there is ' +
                  'nothing to compare against. Every row would read as a gain from zero, which ' +
                  'is a fabricated number, so none is printed.');
      console.log('  after, kills/min: ' +
                  (Object.entries(a2).sort((x, y) => y[1] - x[1]).slice(0, 6)
                    .map(([n, k]) => `${n} ${(k / minutes).toFixed(2)}`).join('  ') || '—'));
    } else if (moved.length) {
      console.log('  per character, kills/min, biggest gain first:');
      for (const r of moved.slice(0, 6).concat(moved.slice(-3)).filter((x, i, arr) => arr.indexOf(x) === i))
        console.log(`     ${r.n.padEnd(16)} ${r.was.toFixed(2)} -> ${r.now.toFixed(2)}  ${r.d >= 0 ? '+' : ''}${r.d.toFixed(2)}`);
    }
    if (touched.length)
      console.log(`  NOTE this change declared it touches ${touched.join(' ')} — judge it on those ` +
                  `rows, not on the fleet total, which one character can carry by a quarter`);
    else
      console.log('  this change declared no --agents, so there is nothing to judge it on except ' +
                  'the fleet total — which is exactly the reading that misled #2');
    if (!v.held) console.log('  a missed prediction is the useful one — write what the model got ' +
                             'wrong into the next --why, or the next change repeats it');
    console.log(save(rec));
  }

  else if (cmd === 'log') {
    if (!rec.experiments.length) { console.log('no experiments yet'); process.exit(0); }
    for (const e of rec.experiments) {
      const v = e.verdict;
      console.log(`#${e.id} ${e.applied_at ? 'applied' : 'proposed'} — ${e.change}`);
      console.log(`    why       ${e.why}`);
      console.log(`    baseline  ${e.baseline_kpm}/min · predicted ${e.predict_kpm}/min` +
                  (v ? ` · measured ${v.measured_kpm}/min over ${v.minutes}m` : ' · (no verdict)'));
      if (v) console.log(`    verdict   ${v.held ? 'HELD' : 'MISSED'}, ` +
                         `${v.better_than_baseline ? 'better' : 'not better'} than baseline`);
    }
  }

  else {
    console.log(readFileSync(new URL(import.meta.url)).toString()
      .split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  }
}
