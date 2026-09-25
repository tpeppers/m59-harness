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

section('the run uses the passage routine that was measured, not a fresh guess');
{
  // ANOTHER AGENT ALREADY SOLVED THIS DOOR, on a live fleet, over two days of guild-hall
  // defence drills -- m59-guild-passage.mjs. It knows the hall's sections, walks to each
  // door's exact trigger square, waits on the server's own sector-height events rather than a
  // guessed delay (a guild door ANIMATES, and a read taken mid-swing sees a shut door),
  // retries three times a leg, and speaks the password only at the secret door's trigger.
  //
  // The first version of this fix was a one-row-south walk and an invented 4s wait, written
  // without looking for what existed. CLAUDE.md's index rule is exactly this: ask first.
  ok(/guildPassage\(this, GUILD_CHEST_SECTION/.test(src), 'the run goes through guildPassage');
  ok(/const GUILD_CHEST_SECTION = 4/.test(src), 'aiming at the chest section the coop also uses');
  ok(!/HALL_DOOR_MS/.test(src), 'the invented door delay is gone');
  ok(!/step: 'leave_foyer'/.test(src), 'and so is the hand-rolled foyer walk');
  eq((src.match(/const hall = await this.reachHallChests/g) ?? []).length, 3,
     'the deposit, the withdraw AND the errand withdrawal (hallWithdraw) all go through it');
  // Measured on prod 2026-09-25, first probe after the deploy: `this.world` does not exist on the
  // Autopilot, so the room read NaN and every hall withdrawal refused "not in the hall".
  const hw = src.slice(src.indexOf('async hallWithdraw('), src.indexOf('async hallWithdraw(') + 2500);
  ok(/s\.world\?\.room\?\.num/.test(hw) && !/this\.world\?\.room/.test(hw),
     'hallWithdraw reads the room off the session world, not this.world');
  eq(src.split(String.raw`await this.sayHallPassword().catch(() => {})`).length - 1, 0,
     'and no call site throws the password result away');
}

section('a stack needs a drop spec -- a bare id moves nothing');
{
  // THE ACTUAL CAUSE of the orc teeth never arriving, and the coop runtime states the rule in
  // as many words: "Bare IDs are only for non-stackables." contributeGuildWants passed
  // item.id. So the chests filled with a shield, a helm, a hammer, an axe, two scimitars and a
  // scroll -- every one a single non-stackable -- and never with orc teeth, which come off an
  // orc in stacks of 3 and 6. The put completes its handshake and moves nothing, which is the
  // shape docs/m59-economy.md already records: "a hand-over that completes the handshake and
  // moves nothing is usually a malformed id list".
  ok(!/c\.put\(item\.id, target\.id\)/.test(src), 'the bare-id put is gone');
  ok(/const spec = this\.dropSpec\(item, Math\.min\(left, item\.amount \|\| 1\)\)/.test(src),
     'a drop spec is built for the amount actually being moved');
  ok(/c\.put\(spec, target\.id\)/.test(src), 'and the spec is what is put');
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
