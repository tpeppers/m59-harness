#!/usr/bin/env node
// THE OFFLINE SUITES A `#movement` COMMIT HAS TO CLEAR.
//
//   node tools/m59-movement-suite.mjs            run them all, report, exit non-zero on a REGRESSION
//   node tools/m59-movement-suite.mjs --list     what it runs and why, without running anything
//   node tools/m59-movement-suite.mjs --strict   treat the known-red baseline as failures too
//
// Every suite here is offline: no socket, no broker, no roster, no fleet. Together they take
// a couple of minutes, which is the whole argument for running them on every commit that
// carries `#movement` rather than hoping somebody remembers which one guards what.
//
// ======================= WHY A RUNNER AND NOT A LINE IN package.json =======================
//
// Because SOME OF THESE ARE ALREADY RED, and a runner that cannot say so is a runner people
// switch off in a week. `m59-travelling-test` has four failing assertions at origin/main that
// nobody introduced today; a plain `&&` chain stops at the first one and reports nothing about
// the eleven suites behind it.
//
// SO THE BASELINE IS BY NAME, NEVER BY COUNT. `KNOWN_RED` lists the exact assertion text of
// every failure that is already there. A new failure fails the run even if the TOTAL is
// unchanged — which is the trap this file exists to close, and one I walked into on
// 2026-09-18: I compared "84 passed, 2 failed" against a remembered "84 passed, 2 failed",
// concluded I had broken nothing, and had in fact swapped two of somebody else's failures for
// two of my own.
//
// AND IT REPORTS A BASELINE ENTRY THAT HAS STARTED PASSING. A known-red list nobody prunes
// becomes a list of things that are allowed to fail for ever, so a fixed one is printed as
// `FIXED` and the run tells you to delete the line. Same churn discipline as
// `UNSAFE_GUARANTEES` in m59-fleetscript.mjs: the absence of movement in the list is itself
// the finding.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// The suites, worst-consequence first, each with the question it answers. A suite that does
// not touch movement does not belong here — `npm test` is the place for the rest.
const SUITES = [
  ['m59-blockedpath-test.mjs',
   'can a weak creature indefinitely block a fully built character — the 584 southeast corridor'],
  ['m59-unarmed-blocker-test.mjs',
   'a refusal never names a precondition that is already satisfied — the seven-hour stall'],
  ['m59-clearblockers-test.mjs',
   'the rung that swings at what is in the way, and the gates that keep it from becoming "fight everything"'],
  ['m59-needle-test.mjs',
   'a one-square corridor with bodies in it is threaded by routing WITHIN squares, not around them'],
  ['m59-lane-test.mjs',
   'two characters in a one-square pipe keep right and pass instead of stalling nose to nose'],
  ['m59-wallstop-test.mjs',
   'where a journey is allowed to stop, on the wall book this fleet actually learned'],
  ['m59-collision-test.mjs',
   'every in-room move validated against the same rules the stock client enforces'],
  ['m59-routing-test.mjs',
   'the router plans on the map the mover enforces, and the bake matches it'],
  ['m59-travelling-test.mjs',
   'travel_guard: what a journey may interrupt itself for, on which clock'],
  ['m59-safespot-test.mjs',
   'a wall is the two grids disagreeing, and the spot book stays a book'],
  ['m59-impossible-test.mjs',
   'a move that cannot be validated is refused rather than retried'],
  ['m59-coords-test.mjs',
   'three coordinate spaces and the boundaries between them'],
  ['m59-recordjam-test.mjs',
   'every committed jam fixture is still roles and not player names'],
];

// FAILURES THAT ARE ALREADY THERE, BY EXACT ASSERTION TEXT.
//
// Recorded 2026-09-19 against origin/main. Each one is somebody's open problem, not a licence:
// if you are touching the code a line here guards, fix it and delete the line.
const KNOWN_RED = {
  'm59-needle-test.mjs': [
    "and PLAYER_HEIGHT is still the client's own figure, imported rather than written out",
    "clearance is measured against MIN_NOMOVEON in wire units, not 1.5 squares",
    "a blocked line tries a lane before it tries a different landing",
    "and a lane is only taken when both of its ends still have floor",
    "the lane is what the fall actually aims at",
    "the lane search exists",
    "and it is OUTSIDE the declared-jump gate, so an ordinary fall reaches it",
    "the WAIT stays declared-only \u2014 three seconds on every fall is not affordable",
    "and so does clearestLanding, which moves the destination and measured 1/10",
    "a blocked ordinary fall refuses with a named reason",
    "the refusal is only raised after the lane has been tried",
    "it is recorded, so \"nothing happened\" can be told from \"it was refused\"",
  ],
  'm59-travelling-test.mjs': [
    'and one that is not rests to FULL health and the resting cap',
    'bounded, so a refuge that cannot heal cannot hold a crossing for ever',
    'and it says both arriving and leaving, so a long leg can be read afterwards',
    'and the refuge mend already asked for the cap unconditionally',
  ],
};

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');

if (argv.includes('--list')) {
  console.log('\nOffline suites a #movement commit has to clear:\n');
  for (const [file, why] of SUITES) {
    const red = KNOWN_RED[file]?.length ?? 0;
    console.log('  ' + file.padEnd(30) + why + (red ? `   [${red} known-red]` : ''));
  }
  console.log('\n--strict fails the run on the known-red baseline too.\n');
  process.exit(0);
}

// Both failure shapes this repository writes: `  FAIL <what>` and `  NO   <what>`.
const failureNames = (out) => out.split('\n')
  .map(l => {
    const m = /^\s*(?:FAIL|NO)\s+(.+?)\s*$/.exec(l);
    if (!m) return null;
    // Detail is appended after two spaces by several suites; the assertion text is the stable part.
    return m[1].split('  ')[0].trim();
  })
  .filter(Boolean);

console.log('\n=== #movement suites ===\n');
let regressions = 0, fixed = 0, missing = 0, ran = 0;
const summary = [];

for (const [file, why] of SUITES) {
  const path = 'tools/' + file;
  if (!existsSync(path)) {
    console.log('  ????  ' + file.padEnd(30) + 'NOT FOUND — a suite named here must exist');
    missing++; summary.push([file, 'MISSING', '']); continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 300_000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  ran++;
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const names = failureNames(out);
  const known = KNOWN_RED[file] ?? [];
  const isKnown = (n) => known.some(k => n === k || n.startsWith(k) || k.startsWith(n));
  const newFails = names.filter(n => !isKnown(n));
  const nowFixed = known.filter(k => !names.some(n => n === k || n.startsWith(k) || k.startsWith(n)));

  // A suite that died without printing a failure line — a throw, a timeout, a missing import —
  // is a regression too, and the exit code is the only thing that catches it.
  const crashed = names.length === 0 && r.status !== 0;

  let verdict;
  if (crashed) { verdict = 'CRASHED'; regressions++; }
  else if (newFails.length) { verdict = 'REGRESSED'; regressions++; }
  else if (strict && names.length) { verdict = 'RED (strict)'; regressions++; }
  else if (names.length) verdict = `ok (${names.length} known-red)`;
  else verdict = 'ok';

  const mark = verdict.startsWith('ok') ? '  ok  ' : '  XX  ';
  console.log(mark + file.padEnd(30) + verdict.padEnd(20) + secs + 's');
  for (const n of newFails) console.log('          NEW FAILURE: ' + n);
  if (crashed) {
    console.log('          exit ' + r.status + (r.error ? ' — ' + r.error.message : ''));
    console.log('          ' + out.trim().split('\n').slice(-3).join('\n          '));
  }
  for (const k of nowFixed) { console.log('          FIXED, delete it from KNOWN_RED: ' + k); fixed++; }
  summary.push([file, verdict, why]);
}

console.log('\n' + '-'.repeat(72));
console.log(`${ran} suite(s) run, ${regressions} regressed, ${fixed} baseline entr(ies) now passing` +
            (missing ? `, ${missing} missing` : ''));
if (fixed) console.log('Prune KNOWN_RED — a baseline nobody prunes becomes a permission slip.');
if (regressions) {
  console.log('\nA #movement commit does not land with a regression here. The suites above name ' +
              'the assertion, and each one is a measured incident rather than a style rule.');
}
process.exit(regressions ? 1 : 0);
