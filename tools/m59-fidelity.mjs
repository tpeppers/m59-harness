#!/usr/bin/env node
// HOW MUCH OF THIS RUN WAS REAL — the modes, and the ledger of every shortcut taken.
//
//   import { fidelity, recordGap, formatGaps, gradeRun } from './m59-fidelity.mjs';
//
//   const run = fidelity('prod-faithful', { allow: ['sell-to-afford'] });
//   const run = fidelity('prepared', { prebuffed: true });
//
// ============================================================ WHY A RUN HAS A MODE
//
// The operator's three loads of the same raid script, 2026-09-11, and they are not three configs
// of one thing -- they are three different questions:
//
//   prepared        "does the FIGHT work?" Clone the fleet, DM-skip to everyone armed, buffed and
//                   standing in the hall, then run it. Fast, repeatable, and says nothing about
//                   whether we could ever get into that state on prod.
//   prod-faithful   "could we actually DO this?" Rebuild the scene and then take NO DM command at
//                   all. Slow, and the only SIMULATION whose result transfers to production.
//   prod            "whatever happens, happens." Not a simulation at all.
//   anything        the scratchpad. No claim is being made; get to the interesting part.
//
// `prod` IS DIFFERENT IN KIND FROM THE OTHER THREE, and the difference is worth the extra mode
// rather than reusing prod-faithful. On production there is no DM socket to shortcut WITH --
// m59-dm.mjs refuses a non-loopback host and always will -- so `concede` has nothing to concede
// to, and honouring it would let a caller write down an intention the world cannot carry out. A
// prod run also has nothing to transfer TO: it is the thing other runs are evidence about. So its
// grade is its own, and a shortcut appearing in a prod ledger is a bug in this file rather than a
// weakened claim.
//
// ============================================================ AND WHY THE SHORTCUTS ARE THE OUTPUT
//
// THE GAPS ARE THE ERROR BARS. A simulation that took six DM shortcuts is much weaker evidence
// than one that took none, and the difference is invisible in a combat report that only prints
// who won. The operator's ask, which is the best reason to build any of this: when it goes badly
// on prod, look back at the shortcuts and see which one you should regret.
//
// That is also how the cheap methods get TUNED rather than just distrusted. A shortcut that is
// taken fifty times and never changes an outcome is a shortcut worth keeping; one that is taken
// twice and both times the prod run diverged is one to stop taking. Neither is knowable unless
// every shortcut is written down at the moment it is used, next to the result it produced.
//
// ============================================================ WHAT COUNTS AS A GAP
//
// IN-GAME SOLUTIONS ARE NOT GAPS. DM SHORTCUTS ARE. That is the same line the lab bargain draws
// and it is the one that makes this measurable rather than a matter of taste:
//
//   selling loot to afford the weapon    costs TIME. Production could do it. Fidelity intact.
//   farming karma up to the requirement  costs TIME. Production could do it. Fidelity intact.
//   granting the weapon over the socket  costs NOTHING, and production cannot. A gap.
//   teleporting to the hall              costs NOTHING, and production cannot. A gap.
//
// So `played` strategies are free of fidelity cost however long they take, and `dm`, `scene` and
// `shadow` always carry one. An unknown that was waived with `allowUnknown` is also a gap: you
// paid for something without being able to tell whether you needed it, and if the run then
// succeeds you cannot say which.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const GAP_LOG = process.env.M59_GAP_LOG || join(REPO, 'substrate', 'gaps.jsonl');

export const MODES = Object.freeze(['prod', 'prod-faithful', 'prepared', 'anything']);

/** What each way of establishing costs in fidelity, regardless of what it costs in time. */
export const FIDELITY_COST = Object.freeze({
  played: 'none',      // the errand. Production can do this, and that is the whole point.
  dm:     'high',      // fiat. Production cannot.
  scene:  'high',      // fiat, wholesale.
  shadow: 'high',      // fiat, scoped to characters.
});

/**
 * Declare what this run is claiming to be.
 *
 * `allow` names in-game solvers the caller is buying into -- "you may sell loot to afford it",
 * "you may farm karma". Those cost time and not fidelity, so they are permitted in every mode;
 * naming them is how the caller says which gap-closing they are willing to WAIT for.
 *
 * `concede` is the deliberate exception: a named fidelity-costing shortcut the caller accepts in
 * a faithful run. It is separate from `allow` on purpose -- one is "spend time", the other is
 * "weaken the claim", and a single list would have hidden the difference at exactly the moment it
 * mattered.
 */
export function fidelity(mode = 'anything', { allow = [], concede = [], prebuffed = false } = {}) {
  if (!MODES.includes(mode))
    throw new Error(`unknown fidelity mode "${mode}". Known: ${MODES.join(', ')}`);
  if (mode === 'prod' && concede.length)
    throw new Error(
      `a prod run cannot concede anything: there is no DM socket on production to take a shortcut ` +
      `with, so concede[${concede.join(', ')}] names intentions the world cannot carry out. If you ` +
      `meant a rehearsal, that is 'prod-faithful'.`);
  if (mode === 'prod' && prebuffed)
    throw new Error(`a prod run cannot be prebuffed — buffs on production are cast, not granted`);
  if (prebuffed && mode === 'prod-faithful')
    throw new Error(
      `prebuffed is a DM preparation and cannot be combined with prod-faithful — that mode's ` +
      `whole claim is that no DM command was used after the scene loaded. Use 'prepared', or ` +
      `concede: ['prebuffed'] if you mean to weaken the claim on purpose and say so in the report.`);
  return Object.freeze({ mode, allow: Object.freeze([...allow]),
                         concede: Object.freeze([...concede]), prebuffed });
}

/**
 * May this run establish a checkpoint that way, and what does it cost the claim?
 *
 * Returns `{ ok, cost, boughtIn, why }`. A refusal here is the point of prod-faithful: the run
 * says no rather than quietly teleporting and reporting a success that does not transfer.
 */
export function permits(run, strategy, { label = null } = {}) {
  const cost = FIDELITY_COST[strategy] ?? 'high';
  if (cost === 'none') return { ok: true, cost, boughtIn: true, why: null };

  // PROD REFUSES ABSOLUTELY, AND THERE IS NO WAY THROUGH. Not because the rule is stricter but
  // because the capability is absent: the socket is not there to be used.
  if (run.mode === 'prod')
    return { ok: false, cost, boughtIn: false,
             why: `this is a production run and "${strategy}" is a DM shortcut. There is no ` +
                  `admin socket on production to take it with, and no concession that would ` +
                  `create one. Solve it in game or do not do it.` };

  if (run.mode !== 'prod-faithful') return { ok: true, cost, boughtIn: false, why: null };

  const named = label && run.concede.includes(label);
  if (named || run.concede.includes(strategy) || run.concede.includes('*'))
    return { ok: true, cost, boughtIn: true,
             why: `conceded: "${named ? label : strategy}" was named in concede[]` };
  return { ok: false, cost, boughtIn: false,
           why: `this run is prod-faithful, and "${strategy}"${label ? ` (${label})` : ''} is a ` +
                `DM shortcut production cannot take. Either solve it in game — see allow[] — or ` +
                `concede it by name and accept that the result no longer transfers.` };
}

/** One shortcut, written down at the moment it was taken. */
export function recordGap(ledger, { checkpoint, strategy, label = null, cost, boughtIn,
                                    why = null, unknownWaived = false } = {}) {
  const gap = { at: new Date().toISOString(), checkpoint, strategy, label,
                cost: cost ?? FIDELITY_COST[strategy] ?? 'high',
                boughtIn: !!boughtIn, unknownWaived: !!unknownWaived, why };
  ledger.push(gap);
  return gap;
}

/**
 * What the run is allowed to claim, given the shortcuts it took.
 *
 * DELIBERATELY NOT A SCORE. A number would get compared between runs that were asking different
 * questions, and the useful output is the LIST -- which shortcut, on which checkpoint. The grade
 * only answers "does this transfer to production", which has three honest answers.
 */
export function gradeRun(run, ledger) {
  const costly = ledger.filter(g => g.cost !== 'none');
  const waived = ledger.filter(g => g.unknownWaived);

  // A PROD RUN IS NOT EVIDENCE ABOUT PRODUCTION, IT IS PRODUCTION. Grading it against itself
  // would be a category error, and a fidelity-costing gap in its ledger means this module let
  // through something the world could not have done — which is a defect here, not a caveat there.
  if (run.mode === 'prod')
    return costly.length
      ? { grade: 'impossible',
          why: `${costly.length} DM shortcut(s) are recorded against a PRODUCTION run. There is ` +
               `no admin socket there — this is a bug in the harness, not a weakened result.` }
      : { grade: 'is-production', why: 'this is the real thing; there is nothing to transfer to' };

  if (!costly.length && !waived.length)
    return { grade: 'transfers', why: 'no DM shortcut was taken and nothing unknown was waived — ' +
                                      'every gap was closed the way production would have to' };
  if (run.mode === 'prod-faithful')
    return { grade: 'transfers-with-exceptions',
             why: `${costly.length} conceded shortcut(s) and ${waived.length} waived unknown(s); ` +
                  `the result holds only where those would also hold on production` };
  return { grade: 'does-not-transfer',
           why: `${costly.length} DM shortcut(s) were used, so this says the fight works FROM THAT ` +
                `STATE and nothing about whether production can reach it` };
}

export function formatGaps(run, ledger, { grade = null } = {}) {
  const g = grade ?? gradeRun(run, ledger);
  const out = [
    `GAPS — ${ledger.length} shortcut(s) taken. These are the error bars on this result.`,
    `  mode: ${run.mode}` +
      (run.allow.length ? `   allow: ${run.allow.join(', ')}` : '') +
      (run.concede.length ? `   concede: ${run.concede.join(', ')}` : ''),
    `  verdict: ${g.grade.toUpperCase()} — ${g.why}`,
  ];
  if (!ledger.length) {
    out.push('  (nothing was shortcut)');
    return out.join('\n');
  }
  out.push('');
  const mark = c => (c === 'none' ? 'time' : c.toUpperCase());
  for (const x of ledger) {
    out.push(`  ${mark(x.cost).padEnd(5)} ${x.checkpoint}` +
             `  — closed by ${x.strategy}${x.label ? ` (${x.label})` : ''}` +
             `${x.boughtIn ? ', bought in' : ''}${x.unknownWaived ? ', UNKNOWN WAIVED' : ''}`);
    if (x.why) out.push(`        ${x.why}`);
  }
  out.push('');
  out.push('  Read this next to the production outcome. A shortcut taken fifty times that never');
  out.push('  changed a result is one worth keeping; one taken twice where prod then diverged is');
  out.push('  one to stop taking. Neither is knowable unless it was written down here.');
  return out.join('\n');
}

/** Append a finished run's gaps, so the fifty-times question is answerable later. */
export function appendGapLog(run, ledger, { scenario = null, outcome = null,
                                            file = GAP_LOG } = {}) {
  if (!ledger.length && !outcome) return null;
  const row = { at: new Date().toISOString(), scenario, mode: run.mode,
                allow: run.allow, concede: run.concede,
                grade: gradeRun(run, ledger).grade, outcome, gaps: ledger };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(row) + '\n', { flag: 'a' });
    return file;
  } catch { return null; }     // a failed write must never stop a run
}

/** Every run recorded so far, for asking whether a shortcut has ever mattered. */
export function readGapLog(file = GAP_LOG) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Has this shortcut ever been followed by a production run that diverged?
 *
 * The question the log exists for. Returns counts rather than a verdict, because "taken 3 times,
 * diverged once" is a different decision for a raid than for a supply run and this module does not
 * get to make it.
 */
export function shortcutHistory(label, file = GAP_LOG) {
  const rows = readGapLog(file);
  let taken = 0, diverged = 0, matched = 0;
  for (const r of rows)
    for (const g of r.gaps ?? []) {
      if (g.label !== label && g.strategy !== label) continue;
      taken++;
      if (r.outcome === 'diverged') diverged++;
      else if (r.outcome === 'matched') matched++;
    }
  return { label, taken, diverged, matched,
           unknown: taken - diverged - matched };
}
