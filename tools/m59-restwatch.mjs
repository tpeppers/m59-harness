#!/usr/bin/env node
// IS OUR UNDERSTANDING OF A SAFE WALL ACTUALLY CORRECT? A LEDGER THAT ONLY ASKS THAT.
//
//   node tools/m59-restwatch.mjs --report            what the evidence says so far
//   node tools/m59-restwatch.mjs --report --all      including epochs before this one
//   node tools/m59-restwatch.mjs --report --json
//
// THIS LEDGER MAY NEVER BE READ BY ANYTHING THAT CHOOSES A SQUARE. That is not a style
// note, it is the entire reason this file exists rather than a column being added to the
// old book. `substrate/m59-safespots.json` failed at precisely this: it began as a record
// of what happened, became an input to selection, and once it was an input its own errors
// fed back into the squares it was measuring. `m59-restwatch-test.mjs` asserts that no
// module which picks a spot imports this one, so the separation is enforced rather than
// remembered.
//
// WHAT COUNTS AS DISPROOF, AND WHY IT IS ONLY ONE THING.
//
// The mechanic is that in a working safe wall nothing can hit you UNLESS YOU SWING FIRST —
// a monster retaliates only while standing still, so if you stop swinging the damage stops.
// It follows that exactly one observation can falsify it:
//
//     damage taken, while resting, while NOT swinging, after settling, not from an ailment.
//
// Every other unhappy thing that can happen on a wall is consistent with the wall being
// perfect, and the old book recorded all of them as failures anyway — 78% of its 6,652
// failure events are `failed_via: "fight"`, which is the mechanic working. So the four
// qualifiers above are not hedges; each one names a category that previously produced a
// false failure, and each is recorded as its own outcome rather than being dropped:
//
//   swung            we chose to trade blows. Not evidence about the wall.
//   settling         a blow resolved before we arrived. See SETTLE_GRACE_MS.
//   ailing           poison ticks through any wall ever built.
//   clean            rested, took nothing. THE CASE THE DEFINITION PREDICTS.
//   violation        the only row that disproves anything.
//
// A LEDGER THAT CANNOT COME DOWN IS A MONUMENT, NOT A MEASUREMENT. Rows carry the
// `safespots` epoch, and `--report` counts only the current one by default: when the
// definition of a safe wall changes, every row before it is about a different question and
// no quantity of them adds up to an answer about this one. That is the same rule the
// movement ledgers got after Ukgoth's north door read `refused 182, crossings 0` on a day
// it was crossing six times out of six.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { epochFor, sameEpoch } from './m59-epoch.mjs';
import { SAFE_WALL_RULE, PREDICATE_NAMES } from './m59-safewall.mjs';

export const RESTWATCH_FILE = process.env.M59_RESTWATCH_FILE
  ?? fileURLToPath(new URL('../substrate/restwatch.jsonl', import.meta.url));

// Damage inside this window of sitting down is attributed to the approach, not to the wall.
// The old book had no such grace and retired 519 squares that had held, on a point or two
// of damage from a blow already in flight when the character arrived.
export const SETTLE_GRACE_MS = 2500;

export const OUTCOMES = Object.freeze(['clean', 'violation', 'swung', 'settling', 'ailing']);

/**
 * Which of the five outcomes an observation is. Pure, so the test can enumerate it and so
 * two readers of the ledger cannot disagree about what a row means.
 *
 * ORDER MATTERS AND IS THE ARGUMENT. Swinging is checked before damage because a character
 * that swung has forfeited the claim regardless of what happened next; ailment before
 * damage for the same reason. Only what survives all four qualifiers can be a violation.
 */
export function classify({ damage = 0, swung = false, ailing = false,
                           rested_ms = 0, settle_grace_ms = SETTLE_GRACE_MS } = {}) {
  if (swung) return 'swung';
  if (ailing) return 'ailing';
  if (damage > 0 && rested_ms < settle_grace_ms) return 'settling';
  if (damage > 0) return 'violation';
  return 'clean';
}

/**
 * Record one rest episode.
 *
 * Never throws: this runs on the keeper's path and a ledger that can take a character down
 * is worse than no ledger. Returns the row it wrote, or null.
 */
export function recordRest({ agent = null, room = null, verdict = null,
                             damage = 0, swung = false, ailing = false, rested_ms = 0,
                             file = RESTWATCH_FILE } = {}) {
  try {
    const outcome = classify({ damage, swung, ailing, rested_ms });
    const row = {
      at: new Date().toISOString(),
      epoch: epochFor('safespots')?.id ?? null,
      rule: verdict?.rule ?? SAFE_WALL_RULE,
      agent, room,
      col: verdict?.measured?.col ?? null,
      row: verdict?.measured?.row ?? null,
      is_wall: verdict?.is_wall ?? null,
      // EVERY CANDIDATE READING, NOT JUST THE ONE IN FORCE. A rest cannot be re-run later
      // to ask what its square looked like, and recording only the rule that was live is
      // how the last book became unable to answer the question it was built to answer.
      predicates: verdict?.predicates ?? null,
      measured: verdict?.measured ?? null,
      outcome, damage, swung, ailing, rested_ms,
    };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + '\n');
    return row;
  } catch { return null; }
}

/** Every row on disk. A malformed line is skipped, never fatal. */
export function readRows(file = RESTWATCH_FILE) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn append is not a crisis */ }
  }
  return out;
}

/**
 * What the evidence says about each candidate predicate.
 *
 * For every predicate, over the rows where it was TRUE: how many rests were clean and how
 * many were violations. A predicate that is a correct description of safety has zero
 * violations, and that is the whole test — there is nothing statistical about it. A hold
 * RATE would be the wrong instrument, because a wall that is fought from constantly and a
 * wall that is rested on twice are not comparable and the old book averaged them.
 */
export function summarise(rows, { rule = SAFE_WALL_RULE } = {}) {
  const usable = rows.filter(r => r.outcome === 'clean' || r.outcome === 'violation');
  const per = {};
  for (const name of PREDICATE_NAMES) {
    const held = usable.filter(r => r.predicates?.[name] === true);
    per[name] = {
      observations: held.length,
      clean: held.filter(r => r.outcome === 'clean').length,
      violations: held.filter(r => r.outcome === 'violation').length,
      // Where the predicate was FALSE and nothing hit us anyway. Not a fault — it is how
      // you tell a predicate that is correct from one that is merely conservative. A rule
      // true of every square in the world would have zero violations and be worthless.
      clean_without: usable.filter(r => r.predicates?.[name] === false
                                     && r.outcome === 'clean').length,
    };
  }
  const counts = Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length]));
  return { rows: rows.length, usable: usable.length, rule, counts, predicates: per,
           violations: usable.filter(r => r.outcome === 'violation') };
}

// ------------------------------------------------------------------------------ the report
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
    || process.argv[1]?.endsWith('m59-restwatch.mjs')) {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const epoch = epochFor('safespots');
  let rows = readRows();
  const before = rows.length;
  if (!all) rows = rows.filter(r => sameEpoch(r.epoch, 'safespots'));

  const s = summarise(rows);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ epoch, ...s }, null, 2));
  } else if (!before) {
    console.log('restwatch: nothing recorded yet.\n');
    console.log(`  the ledger starts empty on purpose. ${RESTWATCH_FILE}`);
    console.log(`  epoch ${epoch?.id ?? '(unknown)'} — rows from a different definition are not counted.`);
  } else {
    console.log(`restwatch — is a safe wall what we think it is?\n`);
    console.log(`  epoch ${epoch?.id ?? '(unknown)'}${epoch?.dirty ? ' (tree has drifted since)' : ''}`);
    console.log(`  rule in force: ${s.rule}`);
    console.log(`  ${s.rows} row(s)${all ? '' : ` of ${before} on disk (rest are older epochs)`}, `
              + `${s.usable} of them decisive\n`);
    console.log('  outcomes: ' + OUTCOMES.map(o => `${o} ${s.counts[o]}`).join(', '));
    console.log('    (only `clean` and `violation` say anything about a wall; the other three');
    console.log('     are the categories the old book miscounted as failures)\n');
    const w = Math.max(...PREDICATE_NAMES.map(n => n.length));
    console.log('  ' + 'predicate'.padEnd(w) + '   seen   clean   VIOLATIONS   clean-without');
    for (const name of PREDICATE_NAMES) {
      const p = s.predicates[name];
      console.log('  ' + name.padEnd(w)
        + String(p.observations).padStart(7) + String(p.clean).padStart(8)
        + String(p.violations).padStart(13) + String(p.clean_without).padStart(16)
        + (name === s.rule ? '   <- in force' : ''));
    }
    if (s.violations.length) {
      console.log(`\n  ${s.violations.length} violation(s) — a wall that was hit while nobody swung:`);
      for (const v of s.violations.slice(0, 12))
        console.log(`    ${v.at}  room ${v.room} r${v.row}c${v.col}  ${v.damage} damage`
          + `  after ${v.rested_ms}ms  (attackers ${v.measured?.attackers}, `
          + `refused ${v.measured?.refused_approaches}/${v.measured?.offered_approaches})`);
      console.log('\n  EACH OF THESE IS A REPRODUCTION TARGET. m59-roomview.mjs <room> draws the');
      console.log('  square; if the geometry says nothing can reach it, the predicate is wrong.');
    } else if (s.usable) {
      console.log('\n  No violations. Every decisive rest on a square the rule called safe was clean.');
    }
    if (s.usable < 30)
      console.log('\n  TOO EARLY TO CONCLUDE ANYTHING. A day of fleet resting is a few hundred rows.');
  }
}
