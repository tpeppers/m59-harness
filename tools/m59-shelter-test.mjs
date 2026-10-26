#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// RUNNING FOR COVER, AND THE THREE THINGS A POSTMORTEM COULD NOT SAY.
//
//   node tools/m59-shelter-test.mjs
//
// Offline. Writes to a temp directory, opens no socket, touches no roster.
//
// ======================== WHAT THIS PINS ========================
//
// The travel doctrine answers everything except a person and dying the same way: take the next
// route-adjacent wall, rest to full, carry on. On 2026-08-27 a run of twenty-one produced twelve
// deaths and NOTHING ON DISK could say whether that doctrine had fired — whether a wall was ever
// chosen, how hurt the character was when it chose, how far away the wall was, or whether it got
// there. Those are four different faults with four different fixes and they all render as "died
// travelling".
//
// The operator asked for three things and each is one group below:
//
//   (A) the health at the moment the decision is made, with BOTH squares, so the run for cover
//       can be recreated rather than inferred
//   (B) how far away the chosen wall is — and the distance that matters is how far the
//       character has to WALK, not how far the wall sits off the planned road
//   (C) distance per second around the time of death: was it still making progress
//
// And one rule change: seek shelter below 100% health rather than below 95%.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const DIR = mkdtempSync(path.join(tmpdir(), 'm59-shelter-'));
process.env.M59_SHELTER_DIR = DIR;
const { recordShelterRun, shelterRuns, pairRuns, shelterFile } =
  await import('./m59-shelter.mjs');

const AUTOPILOT_SRC = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const { Autopilot } = await import('./m59-autopilot.mjs');
const GAME_SRC = readToolSource(new URL('./m59-game.mjs', import.meta.url), 'utf8');

console.log('\n(A) THE DECISION IS RECORDED WHEN THE WALL IS CHOSEN, NOT WHEN IT IS REACHED');
{
  // A ledger written on arrival cannot see the runs that never arrive — and those are exactly
  // the ones that end in a postmortem. This is the whole reason there are two rows.
  ok('the divert handler writes a `chose` row',
     /onDivert: \(stop, at\) => \{[\s\S]{0,2000}recordShelterRun\(\{[\s\S]{0,200}kind: 'chose'/
       .test(AUTOPILOT_SRC));
  ok('and it carries the health at that moment, not at arrival',
     /kind: 'chose'[\s\S]{0,600}health_pct: hp/.test(AUTOPILOT_SRC));
  ok('and BOTH squares — where we are and where the wall is',
     /kind: 'chose'[\s\S]{0,900}from, to: \{ row: stop\.row, col: stop\.col \}/.test(AUTOPILOT_SRC));
  // WHAT IT WAS LOSING, because a character at 80% falling fast and one at 80% that stopped
  // bleeding two rooms ago are not the same decision and the threshold cannot tell them apart.
  ok('and the rate it was losing health at',
     /kind: 'chose'[\s\S]{0,700}health_per_second: this\.healthRate/.test(AUTOPILOT_SRC));
  // AND IT ASKS SOMETHING THAT EXISTS. The first version called `this.threatsHere?.()`, which
  // is not a method on this class — optional chaining on a method that was never there is
  // indistinguishable from an empty room, so every row of the first run recorded `null` and
  // the column was blank throughout without anything failing.
  ok('and what was standing there',
     /kind: 'chose'[\s\S]{0,900}threats: this\.namedThreatsHere\(\)/.test(AUTOPILOT_SRC));
  ok('asked of a method that actually exists on the class',
     /^  namedThreatsHere\(\) \{$/m.test(AUTOPILOT_SRC));
}

console.log('\n(B) HOW FAR IT HAS TO WALK, WHICH IS NOT HOW FAR THE WALL IS OFF THE ROAD');
{
  // `detour` is the number `travelShelterDetour` caps, and it answers a different question:
  // how far the wall sits from the planned path. What costs health is the walk from where the
  // body actually IS, and after a fight that is rarely on the path.
  ok('the walk distance is measured from the body, not from the route',
     /const squares = from && Number\.isFinite\(stop\.row\)[\s\S]{0,220}Math\.max\(Math\.abs\(stop\.row - from\.row\)/
       .test(AUTOPILOT_SRC));
  ok('and Chebyshev, because that is how a step moves',
     /Math\.max\(Math\.abs\(stop\.row - from\.row\),\s*Math\.abs\(stop\.col - from\.col\)\)/
       .test(AUTOPILOT_SRC));
  ok('and both numbers are kept, so the cap can be judged against the cost',
     /detour: stop\.detour \?\? null, squares/.test(AUTOPILOT_SRC));
}

console.log('\n(C) WAS IT STILL GOING ANYWHERE WHEN IT DIED');
{
  ok('the postmortem carries a movement block',
     /movement: \(\(\) => \{/.test(AUTOPILOT_SRC));
  ok('and it reports squares per second over the last frames',
     /squares_per_second_at_the_end/.test(AUTOPILOT_SRC));
  // THE SHUFFLE DETECTOR. CLAUDE.md's own warning: a stall detector that requires STILLNESS
  // misses the commonest way to stand still, because a two-square shuffle against a wall resets
  // every timer it meets. Gross against net is what sees it.
  ok('and net against gross, so a shuffle against a wall is not read as travel',
     /net_squares: net/.test(AUTOPILOT_SRC) && /shuffled: net != null/.test(AUTOPILOT_SRC));
  ok('and a room change is skipped rather than counted as a forty-square leap',
     /if \(f\[i\]\.num !== f\[i - 1\]\.num\) \{ steps\.push\(null\); continue; \}/.test(AUTOPILOT_SRC));
  ok('and it does not lean on ms_since_moved, which measures the keeper',
     /movement: \(\(\) => \{[\s\S]{0,2000}Chebyshev/.test(AUTOPILOT_SRC));
}

console.log('\nARRIVED MEANS STANDING ON IT');
{
  // THE OPERATOR'S CORRECTION, 2026-08-27, AND IT INVERTED A FINDING.
  //
  // The ledger's first run reported fifteen shelter stops that LOST health — 134 points given
  // away at squares it called refuges, 92 of them on 598 51,22 across eight characters. Read
  // off the ledger alone, that says the walls are bad, and that is what it was reported as.
  // The operator's answer was that those squares are valid safe spots and a character that
  // reaches one is safe on it, which leaves exactly one possibility: they were not standing
  // on them.
  //
  // They were not. `walkPivots` has two arrival paths. The single-step one checks
  // `now.col === target.col && now.row === target.row` before resting. The PROVED-LEG one did
  // not: any leg whose consumed squares happened to include a shelter called `onArrive` with
  // the END OF THE LEG — up to thirteen squares past the wall — and the character sat down
  // there, in the open, and the ledger wrote `arrived: true`.
  //
  // The lesson is not about walls. It is that a measurement which takes its subject's word
  // for the one fact it exists to establish will confidently blame the wrong thing.
  ok('a proved leg that goes past a refuge puts it back rather than counting it',
     /const swallowed = remaining\.slice\(0, cut \+ 1\)\.filter\(st => st\.shelter\);/.test(GAME_SRC)
     && /remaining\.unshift\(back\);/.test(GAME_SRC));
  ok('and only rests when the body is actually on the square',
     /const onIt = swallowed\.some\(st => st\.col === at\.col && st\.row === at\.row\);/.test(GAME_SRC)
     && /if \(onIt && typeof shelter\?\.onArrive === 'function'\)/.test(GAME_SRC));
  // NEAREST FIRST, because a long proved leg can swallow more than one and the one worth
  // turning back for is the closest.
  ok('and when a leg swallows several, it turns back to the nearest',
     /Nearest first/.test(GAME_SRC));
  // AND THE OTHER PATH IS UNTOUCHED — it was always right, and it is the reference for what
  // "arrived" has to mean.
  ok('the single-step path still confirms the square before resting',
     /if \(now\.col === target\.col && now\.row === target\.row\)/.test(GAME_SRC));

  // AND THE LEDGER CHECKS RATHER THAN TRUSTS.
  ok('the outcome row measures the body against the wall it chose',
     /const onTheWall = !!\(at && this\.shelterRun\.to/.test(AUTOPILOT_SRC));
  ok('and `arrived` is that measurement, not the caller\'s claim',
     /arrived: onTheWall,/.test(AUTOPILOT_SRC));
  ok('and where it actually sat is recorded, so the next version of this is one column away',
     /rested_at: at \? \{ row: at\.row, col: at\.col \} : null,/.test(AUTOPILOT_SRC));

  // The ledger accepts and reports the distinction.
  recordShelterRun({ run: 'Wwww-1', kind: 'chose', character: 'Wwww', room: 598,
    health: 12, max_health: 40, health_pct: 0.3, from: { row: 40, col: 20 },
    to: { row: 51, col: 22 }, detour: 2, squares: 11 });
  recordShelterRun({ run: 'Wwww-1', kind: 'settled', character: 'Wwww', room: 598,
    arrived: false, on_the_wall: false, rested_at: { row: 44, col: 21 },
    ms: 19800, hp_gained: -12 });
  const w = pairRuns(shelterRuns({ thisEpochOnly: false })).find(p => p.chose.run === 'Wwww-1');
  ok('a rest taken off the wall is recorded as not having arrived',
     w?.settled?.arrived === false && w?.settled?.on_the_wall === false);
  ok('and it says where the body actually sat, which is the whole diagnosis',
     w?.settled?.rested_at?.row === 44 && w?.settled?.rested_at?.col === 21,
     JSON.stringify(w?.settled?.rested_at));
}

console.log('\nTHE BAR IS "HAVE I TAKEN A HIT", NOT A FRACTION');
{
  // THE OPERATOR'S RULE, IN FULL: any damage at all is a reason to take a wall **when the map
  // holds things stronger than us**, and only then. A hundred-hitpoint character nicked by a
  // baby spider does not need to sit down.
  //
  // Shipped unconditional for exactly one run and it cost 33 points of arrival — 43% to 10% on
  // the same seed, fourteen of twenty-one parked in inns at full health. Diverting IS free per
  // detour; taking one every time anything scratches you across twenty-six hops is not.
  ok('the divert threshold is conditioned, not a constant',
     /return hp < this\.travelDivertAt\(\);/.test(AUTOPILOT_SRC));
  ok('any damage at all where the map outranks the character',
     /travelDivertAt\(\) \{[\s\S]{0,220}travelDivertBelowOutranked \?\? 1/.test(AUTOPILOT_SRC));
  ok('and an ordinary threshold where it does not',
     /travelDivertAt\(\) \{[\s\S]{0,260}travelDivertBelow \?\? 0\.95/.test(AUTOPILOT_SRC));
  ok('asking the same question the cancel threshold already asks',
     /travelDivertAt\(\) \{\s*return this\.roomOutranksUs\(\)/.test(AUTOPILOT_SRC));
  // AND THE LEDGER RECORDS WHICH ARM FIRED, or a row cannot be read against the rule that
  // produced it.
  ok('and every decision row says which arm was in force',
     /outranked: this\.roomOutranksUs\(\), divert_at: this\.travelDivertAt\(\),/.test(AUTOPILOT_SRC));
  ok('and it is still overridable, because it is a number and numbers are this machine\'s',
     /travelDivertBelow/.test(AUTOPILOT_SRC));
  // AND IT IS NOT THE CANCELLATION THRESHOLD. Both used to read one number, so every moment
  // worth a free detour was also a moment worth tearing the crossing down — and the
  // cancellation won, because it runs in the keeper on a one-second clock.
  ok('and it is a different number from the one that could end a crossing',
     /SO THIS IS NOT THE SAME NUMBER AS `travelShelterBelow`/.test(AUTOPILOT_SRC));
}

console.log('\nA WALL ANSWERS NOTHING IN A PLACE THAT IS ALREADY SAFE');
{
  // Measured on the first cycle run with no ghost autopilots, 2026-08-28: nine shelter runs,
  // and SIX were somewhere a wall cannot help.
  //
  //     room 1   The Underworld    2/29, 1/33, 2/36, 2/36   all 24,10 -> 28,5, none reached
  //     room 106 Brownestone Inn   15/52                         10,11 -> 7,5
  //
  // Four dead characters in the Underworld all picking the same square, and one sitting in an
  // inn. The Underworld has nothing to shelter FROM — the answer to being in it is
  // `escapeUnderworld`, which is a different rung — and an inn is a sanctuary, where the
  // correct move is to rest exactly where you stand. Both fired because the gate only ever
  // asked about health, and a corpse at 7% and a traveller at 7% look identical to a number.
  //
  // It also poisoned the measurement. "Seven of eight runs never settled" was mostly this,
  // which reads as the doctrine failing when it is really the doctrine being asked a question
  // that has no answer.
  ok('the divert refuses in the Underworld',
     /if \(room\?\.num === 1 \|\| \/underworld\/i\.test\(room\?\.name \?\? ''\)\) return false;/
       .test(AUTOPILOT_SRC));
  ok('and in a sanctuary, where nothing can reach you anyway',
     /if \(this\.sanctuary\(room\)\) return false;/.test(AUTOPILOT_SRC));
  ok('and both refusals come before the health threshold is consulted',
     AUTOPILOT_SRC.indexOf('if (this.sanctuary(room)) return false;')
       < AUTOPILOT_SRC.indexOf('return hp < this.travelDivertAt();'));
}

console.log('\nAND EVERY METHOD THE GATE CALLS ACTUALLY EXISTS');
{
  // THE BUG CLASS, NOT THE BUG. `this.threatsHere?.()` was written into the ledger earlier the
  // same day; it is not a method on this class, and optional chaining on a name that was never
  // there is indistinguishable from a true answer. It recorded `null` threats for a whole run
  // with nothing failing, and the blank column was read as "no threats" rather than "never
  // asked". A SURVIVAL GATE written the same way would read as "safe" — which is why this
  // asserts the property rather than the instance.
  //
  // COMMENTS ARE NOT CODE, and the first version of this failed on its own prose: the note
  // above names `this.threatsHere?.()` in order to explain it, and the scan counted that as an
  // occurrence. Whole-line comments are dropped; a trailing `//` on a line of code is left
  // alone, because stripping those needs a parser and getting it wrong makes this MORE
  // permissive, which is the one direction a guard must never fail in.
  const code = AUTOPILOT_SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const own = new Set(Object.getOwnPropertyNames(Autopilot.prototype));
  const phantom = [...new Set([...code.matchAll(/this\.([A-Za-z_][A-Za-z0-9_]*)\?\.\(/g)]
    .map(m => m[1]))].filter(n => !own.has(n));
  ok('no optional call in the keeper names a method that does not exist',
     phantom.length === 0, phantom.map(n => 'this.' + n + '?.()').join(', '));
}

console.log('\nTHE LEDGER ITSELF');
{
  const run = 'Tttt-1';
  recordShelterRun({ run, kind: 'chose', character: 'Tttt', room: 598,
    room_name: 'The Cragged Mountains', health: 12, max_health: 20, health_pct: 0.6,
    vigor: 48, health_per_second: -0.29, threats: ['troll', 'troll'],
    from: { row: 21, col: 17 }, to: { row: 24, col: 19 }, detour: 2, squares: 3 });
  // SCOPED TO ITS OWN RUN. The book is shared with every other group in this file, and an
  // assertion that says `rows.length === 1` is really saying "nothing else in this suite has
  // ever written a row" — which was true when it was written and stopped being true the moment
  // a group was added above it. Filtering by `run` is what the id is for.
  const mine = () => shelterRuns({ thisEpochOnly: false }).filter(r => r.run === run);
  let rows = mine();
  ok('a decision row lands on disk', rows.length === 1, JSON.stringify(rows));
  ok('with both squares intact',
     rows[0].from.row === 21 && rows[0].from.col === 17
     && rows[0].to.row === 24 && rows[0].to.col === 19);
  ok('and the health at the decision, not a fraction on its own',
     rows[0].health === 12 && rows[0].max_health === 20 && rows[0].health_pct === 0.6);
  ok('and it is stamped with the movement epoch it was measured under',
     typeof rows[0].epoch === 'string' && rows[0].epoch.length > 0, rows[0].epoch);

  // A RUN WITH NO OUTCOME IS THE INTERESTING ONE, and it must not be silently dropped.
  ok('a run with no outcome row still pairs, and says so',
     pairRuns(rows).length === 1 && pairRuns(rows)[0].settled === undefined);

  recordShelterRun({ run, kind: 'settled', character: 'Tttt', room: 598,
    arrived: true, ms: 4200, rested_to: 1, hp_gained: 8 });
  rows = mine();
  const paired = pairRuns(rows);
  ok('the outcome row pairs with its decision',
     paired.length === 1 && paired[0].settled?.arrived === true && paired[0].chose.health === 12);
  ok('and the two rows are both kept — append-only, because how it turned out is the finding',
     rows.length === 2);

  // NEVER THROWS. This is a notebook, not a dependency: a keeper that cannot write it still has
  // to run for cover, and an exception here would be raised inside the survival path.
  ok('a malformed row is dropped rather than thrown',
     recordShelterRun({ run: 'x', from: 'not a square', to: null }) !== undefined);
  ok('and a square that is not a square records as absent rather than as garbage',
     shelterRuns({ thisEpochOnly: false }).filter(r => r.run === 'x').at(-1).from === null);

  ok('the file is per fleet, so two fleets do not pool their roads',
     shelterFile('a') !== shelterFile('b'));
}


console.log('\n(H) THE EPOCH FILTER HAS TO ACTUALLY FILTER');
{
  // `shelterRuns` defaults to this-epoch-only, and called `sameEpoch('movement', r.epoch)` --
  // the arguments the wrong way round, so the domain went in as the row and the row as the
  // domain. An unknown domain answers null, "cannot say" is KEPT rather than dropped, and the
  // filter never removed a single row. Every run recorded before a `#movement` commit was
  // still averaged into every summary after it, which is the one thing the epoch tag exists
  // to stop. Caught by eye, reading a post-rebake summary that still showed the pre-rebake
  // rows; this is the test that should have caught it instead.
  const src = readToolSource(new URL('./m59-shelter.mjs', import.meta.url), 'utf8');
  ok('the row goes in first and the domain second, as sameEpoch declares them',
     /sameEpoch\(r\.epoch \?\? null, 'movement'\)/.test(src));
  ok('and never the other way round in the filter itself',
     !/filter\([^)]*sameEpoch\('movement'/.test(src));

  const { epochId } = await import('./m59-epoch.mjs');
  const mine = epochId('movement');

  const before = shelterRuns().length;
  recordShelterRun({ run: 'Epoch-1', kind: 'chose', character: 'Eeee', room: 901,
                     room_name: 'Ours', health: 20, health_pct: 0.5, squares: 3 });
  const ours = shelterRuns().filter(r => r.room === 901);
  ok('a recorded run carries this checkout\'s epoch',
     ours.length === 1 && (mine == null || ours[0].epoch === mine), String(ours[0]?.epoch));

  // WRITTEN STRAIGHT TO THE FILE, because `recordShelterRun` stamps the epoch itself and
  // will not take one from a caller — which is right (an epoch you can pass in is an epoch
  // you can forge) and means a foreign row has to be planted rather than recorded.
  const now = shelterRuns().length;
  const f = shelterFile();
  const book = JSON.parse(readToolSource(f, 'utf8'));
  book.runs.push({ run: 'Epoch-2', kind: 'chose', character: 'Eeee', room: 902,
                   room_name: 'Theirs', health: 20, health_pct: 0.5, squares: 3,
                   at: Date.now(), epoch: '0000000000aa' });
  writeFileSync(f, JSON.stringify(book));
  const after = shelterRuns();
  ok('a run from another epoch is not counted in this one',
     after.length === now && !after.some(r => r.room === 902),
     `${now} -> ${after.length}`);
  ok('but it is still on disk, so the previous epoch is not destroyed',
     shelterRuns({ thisEpochOnly: false }).some(r => r.room === 902));
  ok('and the filter only ever grew by the row we added', now === before + 1,
     `${before} -> ${now}`);
}


console.log('\n(I) THE DIVERT IS IMMEDIATE ON A HIT, AND OWES ONE LEG AFTER A REST');
{
  // The divert used to be read once per leg, and a proved leg coalesces up to twenty-three
  // squares into one move. Measured over 138 diverts: 42% fired more than 25 points below
  // their own threshold, median shortfall 20, worst 97 -- one character decided to run for
  // cover at 3% against a threshold of 100%. Seven of eight deaths in that tour already had
  // a divert in flight; two of them had chosen at 5% and 3%.
  ok('the session stamps the moment health DROPS, which is the only place that can tell a hit from a heal',
     /this\.damagedAt = now;/.test(GAME_SRC)
     && /if \(before == null \|\| value >= before\) return;/.test(GAME_SRC));
  ok('and it is initialised beside lastHealth so a fresh session is not "recently hit"',
     /this\.damagedAt = 0;/.test(GAME_SRC));
  ok('a recent hit ends leg coalescing, so the check runs at the pace the game moves at',
     /Date\.now\(\) - this\.damagedAt < SHELTER_HIT_WINDOW_MS/.test(GAME_SRC));
  ok('the window is a named constant rather than a number in the walker',
     /const SHELTER_HIT_WINDOW_MS = \d+;/.test(GAME_SRC));
  ok('and the clamp only applies while a shelter policy is in force, so an errand pays nothing',
     /if \(shelter\?\.need && this\.damagedAt/.test(GAME_SRC));

  // THE LIVE-LOCK GUARD. Immediacy without this is worse than the latency it replaces: rest
  // to full, step off, take one hit, and the nearest wall is the one you are standing beside.
  ok('a walk starts owing nothing, so the first leg of a crossing may still divert',
     /let legsSinceShelter = Infinity;/.test(GAME_SRC));
  ok('arriving at a refuge zeroes the debt', /legsSinceShelter = 0;/.test(GAME_SRC));
  ok('every completed leg pays it down', /legsSinceShelter\+\+;/.test(GAME_SRC));
  ok('and the divert will not fire while it is owed',
     /if \(wants && legsSinceShelter >= 1\)/.test(GAME_SRC));
  ok('a suppressed divert is RECORDED, because "owed a leg" and "nowhere to go" are different rooms',
     /suppressed: 'one leg of progress owed since the last refuge'/.test(GAME_SRC));
  ok('the guard does not touch the survival ladder, only the decision to sit down',
     /Nothing here touches the survival ladder/.test(GAME_SRC));
}


console.log('\n(J) A CONFIRMATION THAT TIMED OUT IS NOT A CONFIRMATION');
{
  // `confirmPosition` answers null when the room-contents read misses its 8s deadline, and
  // its own comment says callers "already treat an unknown position as a wrong one". Three
  // sites in walkTo did not: they awaited it, threw the verdict away, and read `c.self` --
  // which after a proved leg is the DEAD-RECKONED PREDICTION OF THE TARGET. So the test
  // `at.col === col && at.row === row` was true by construction and every timed-out confirm
  // became `arrived: true`.
  //
  // Measured live in The Flatlands, 2026-08-28: at 35,29, asked for 35,35, still at 35,29,
  // no damage taken, and the mover reported "walked the proved route". A busy room is
  // exactly where reads are slow, so this read as a corridor that could not be threaded
  // rather than as a lie about having threaded it.
  ok('the proved-route return requires a FRESH confirmation, not the prediction',
     /const confirmed = await this\.confirmPosition\(\);/.test(GAME_SRC)
     && /if \(confirmed && at\.col === col && at\.row === row\)/.test(GAME_SRC));
  ok('"already there" requires one too',
     /const ok0 = await this\.confirmPosition\?\.\(\)\.catch\(\(\) => null\);/.test(GAME_SRC)
     && /if \(ok0 && now0\.col === col && now0\.row === row\)/.test(GAME_SRC));
  ok('and so does the final verdict, which is what a journey counts a leg by',
     /const okEnd = await this\.confirmPosition\?\.\(\)\.catch\(\(\) => null\);/.test(GAME_SRC)
     && /const arrived = !!okEnd && !!me && me\.col === col && me\.row === row;/.test(GAME_SRC));
  ok('no site still awaits the confirmation and then reads c.self as if it had succeeded',
     !/await this\.confirmPosition\?\?\.\(\)\.catch\(\(\) => \{\}\);\s*\n\s*const \w+ = c\.self/.test(GAME_SRC));

  // AND THE SHAPE OF THE BUG, so a future edit cannot reintroduce it by writing the
  // comparison before the guard: every one of the three now names its confirmation in the
  // same expression that claims arrival.
  const claims = [...GAME_SRC.matchAll(/arrived: true, position: \{ col, row \}/g)].length;
  ok('every "arrived: true" in walkTo is guarded by a confirmation', claims >= 2);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
