// OFFLINE. Pins the guild-hall deposit run: leaving the foyer before speaking, waiting for
// the slow door, and recording the run either side.
//
// THE INCIDENT, 2026-09-17. Three guild chests sat at 3394/4570/305 bulk, unchanged for days,
// while the contribution planner asked for 45 orc teeth into the first of them on every town
// trip. Nothing on disk could say why, because `this.note()` writes to a keeper's in-memory
// status buffer and keepers restart about once a minute. The operator spotted it from the raw
// bulk numbers, not from any report — "I suspect the guild hall drop-offs are just universally
// low% success rate... people appeared to be getting stuck in the foyer."
//
// They were. `InFoyer` (ghall.kod:896-913) refuses the door for anyone inside a declared box
// AND muffles speech across it; the Bookmaker's box is rows 2-3, cols 26-39
// (guildh14.kod:145-148) and the chests are at rows 18-20. `sayHallPassword` detected this
// and returned `{ok:false, why:'in the foyer'}` — and the caller threw the result away with
// `.catch(() => {})`, read an empty room, and recorded a tidy "no chest stands on that square"
// for each chest.
//
// `node tools/m59-hallrun-test.mjs`
import { readFileSync } from 'node:fs';
import { inFoyer, BOOKMAKERS_FOYER } from './m59-hallsecret.mjs';
import { BOOKMAKERS_CHEST_SQUARES, chestFullness } from './m59-storage.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = s => console.log(`\n${s}`);

const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

section('the foyer is a real place and the chests are not in it');
{
  // The whole bug in two assertions: arrivals land in the box, the chests are far outside it.
  ok(inFoyer(2, 30) === true, 'a square inside the declared box reads as foyer');
  ok(inFoyer(3, 39) === true, 'the box includes its own corner');
  ok(inFoyer(4, 30) === false, 'one row south is out of it');
  eq(inFoyer(null, 30), null, 'an unreadable position is null, NOT false — unknown is not outside');
  for (const sq of BOOKMAKERS_CHEST_SQUARES) {
    const m = /^r(\d+)c(\d+)$/.exec(sq);
    ok(inFoyer(Number(m[1]), Number(m[2])) === false, `chest square ${sq} is outside the foyer`);
  }
  eq(BOOKMAKERS_FOYER.south + 1, 4, 'the first row south of the box is row 4');
}

section('the run leaves the foyer before it speaks');
{
  ok(/async reachHallChests\(\)/.test(src), 'there is a reachHallChests step');
  ok(/const hall = await this\.reachHallChests\(\)/.test(src),
     'and contributeGuildWants goes through it');
  ok(!/await this\.sayHallPassword\(\)\.catch\(\(\) => \{\}\);\n\s*await s\.pacer\.submit\('read', \(\) => c\.roomContents\(\)\)/.test(src),
     'the old bare say-then-read, whose result was thrown away, is gone');
  ok(/step: 'leave_foyer'/.test(src), 'leaving the foyer is its own recorded step');
  // BOTH PATHS, and this counts occurrences rather than checking absence once. Two places
  // open this door -- the DEPOSIT (contributeGuildWants) and the WITHDRAW
  // (withdrawFromStockpile) -- with byte-identical say-then-read blocks. A single string
  // replace fixed the first and left the one that mattered, and the recorder in the deposit
  // path then referenced a `hall` variable that did not exist in its scope.
  eq((src.match(/const hall = await this.reachHallChests/g) ?? []).length, 2,
     'BOTH the deposit and the withdraw path go through reachHallChests');
  eq(src.split(String.raw`await this.sayHallPassword().catch(() => {})`).length - 1, 0,
     'and no call site throws the password result away any more');
  ok(/BOOKMAKERS_FOYER\.south \+ 1/.test(src), 'and it steps to the first row south of the box');
  // If it cannot get out, it must NOT speak: the word would be muffled and overheard.
  ok(/could not leave the guild hall foyer/.test(src),
     'a failure to leave is reported rather than followed by a useless say');
}

section('the door is slow, and the wait is named rather than borrowed');
{
  ok(/HALL_DOOR_MS/.test(src), 'there is a named door wait');
  ok(/M59_HALL_DOOR_MS/.test(src), 'overridable for a hall that behaves differently');
  ok(/step: 'read_room'/.test(src), 'the room read is a recorded step');
  ok(/chests_visible/.test(src), 'and it records how many chests it could actually see');
}

section('the run is recorded either side, always');
{
  ok(/recordHallRun\(\{/.test(src), 'there is a recorder');
  ok(/pack_before/.test(src) && /pack_after/.test(src), 'pack snapshots both sides');
  ok(/chests_before/.test(src) && /chests_after/.test(src), 'chest snapshots both sides');
  ok(/pack_delta/.test(src) && /chest_delta/.test(src), 'and the deltas, so a reader need not derive them');
  ok(/moved_nothing/.test(src), 'a run that planned something and moved nothing says so in a field');
  // A trip that never arrived is the case the operator could not see. It must record too.
  ok(/recordHallRun\(\{ before, after: before, want, contributed: 0/.test(src),
     'a run that could not reach the hall is still recorded');
  const stats = readFileSync(new URL('./m59-strategy-stats.mjs', import.meta.url), 'utf8');
  ok(/category === 'guild_chest' \? policy\?\.guildWants\?\.enabled/.test(stats),
     'and the category records whenever guild_wants is on, not only under the broad switch');
}

section('the snapshot cannot break the deposit it describes');
{
  // THE BUG THIS NEARLY SHIPPED. The first version called `chestBulk(...)`, which does not
  // exist, from outside any try — so every deposit would have thrown on its first snapshot.
  ok(!/chestBulk\(/.test(src), 'the helper that never existed is gone');
  ok(/chestFullness\(ch\.items \?\? \[\]\)\.bulk/.test(src), 'it uses the real one');
  ok(/const snapshot = \(\) => \{ try \{ return \{/.test(src), 'and the snapshot is wrapped in a try');
  ok(/catch \(e\) \{ return \{ at: Date\.now\(\), error:/.test(src),
     'which returns an error field rather than throwing');
  // Prove the real helper answers, so the assertion above is about a function that works.
  eq(chestFullness([]).bulk, 0, 'chestFullness reports 0 bulk for an empty chest');
  ok(chestFullness([{ name: 'orc tooth', amount: 10 }]).bulk > 0, 'and more than 0 for a full one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
