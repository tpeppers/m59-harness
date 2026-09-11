#!/usr/bin/env node
// THE HALL PASSWORD: WHERE IT LIVES, AND EVERY WAY IT IS REFUSED IN SILENCE.
//
// Offline. Writes only into a temp directory, and the password used here is a FAKE — the
// real one belongs in substrate/fleets/<fleet>.secrets.json, which is gitignored, and a test
// is a tracked file. That is the whole point of the module and it would be a strange thing
// to break in its own test.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hallPassword, describe as describeSecret, setHallPassword, secretsPathFor,
         inFoyer, BOOKMAKERS_FOYER, SAID_NOTE } from './m59-hallsecret.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'm59-hallsecret-'));
const FAKE = 'not-the-real-one';

console.log('\nWHERE IT LIVES — a sidecar, never the roster');
{
  // A ROSTER KEY WOULD BECOME A PHANTOM CHARACTER. Every top-level key in a roster is an
  // agent: the broker builds fleetState from them, saveFleetState carries forward every key
  // it did not load, and the 45s sweep respawns keepers from the roster. So the secret goes
  // beside the roster, in a file whose name has a DOT in it and therefore cannot be passed
  // to --fleet (NAME_OK is /^[A-Za-z0-9][A-Za-z0-9_-]*$/, m59-fleetpath.mjs:55).
  const p = secretsPathFor('prod', dir);
  ok('the sidecar sits beside the roster, not inside it', p.endsWith('prod.secrets.json'));
  ok('and its name carries a dot, so --fleet can never address it',
     /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test('prod.secrets') === false);

  ok('no file means no password, rather than a throw', hallPassword('prod', { dir }) === null);
  const before = describeSecret('prod', { dir });
  ok('and describe() says so plainly', before.has_password === false && before.file_present === false);
}

console.log('\nRECORDING IT');
{
  const out = setHallPassword('prod', FAKE, { dir, room: 714 });
  ok('the password reads back exactly', hallPassword('prod', { dir }) === FAKE);
  ok('the hall room is kept beside it', out.hall_room === 714);

  // THE SECRET NEVER APPEARS IN WHAT IS SAFE TO PRINT. `describe` is what goes in a note, a
  // page or a transcript, so it must carry the shape and never the value.
  const shown = JSON.stringify(describeSecret('prod', { dir }));
  ok('describe() reports THAT there is one', describeSecret('prod', { dir }).has_password === true);
  ok('describe() never contains the password itself', !shown.includes(FAKE));
  ok('and neither does its length field alone identify it',
     describeSecret('prod', { dir }).length === FAKE.length);
  ok('the fixed say-note carries no secret', !SAID_NOTE.includes(FAKE));

  // Two fleets are two files. A machine holding both must never hand one the other's word.
  setHallPassword('shadow', 'a-different-fake', { dir });
  ok('each fleet gets its own sidecar', hallPassword('prod', { dir }) === FAKE);
  ok('and one fleet never answers with another fleet\'s word',
     hallPassword('shadow', { dir }) === 'a-different-fake');
}

console.log('\nA FILE THAT WILL NOT PARSE IS NOT A FLEET WITHOUT A PASSWORD');
{
  // Returning null for "unreadable" is correct, but it must be DISTINGUISHABLE from "none
  // recorded" — otherwise a corrupted file sends a character to Barloque to stand in front
  // of a wall it had the key to.
  writeFileSync(secretsPathFor('broken', dir), '{ not json');
  ok('an unparseable sidecar yields no password', hallPassword('broken', { dir }) === null);
  const d = describeSecret('broken', { dir });
  ok('and says the file is THERE but unreadable', d.file_present === true && !!d.unreadable);
  ok('which is not the same answer as "none recorded"', d.has_password === false && !!d.unreadable);
}

console.log('\nTHE FOYER, WHERE THE PASSWORD IS REFUSED WITHOUT A WORD');
{
  // ghall.kod:963-970 refuses the door for anyone InFoyer, and ghall.kod:896 is a plain
  // rectangle. guildh14.kod:145-148 declares 2/3/26/39 for the Bookmaker's hall.
  const f = BOOKMAKERS_FOYER;
  ok('the foyer box matches the kod', f.north === 2 && f.south === 3 && f.west === 26 && f.east === 39);
  ok('dead centre of the foyer is inside', inFoyer(2, 30) === true);
  ok('both row edges are inside — it is inclusive', inFoyer(2, 26) === true && inFoyer(3, 39) === true);
  ok('one row south of it is the hall proper', inFoyer(4, 30) === false);
  ok('one column west of it is outside', inFoyer(2, 25) === false);

  // WHERE THE CHESTS ARE, which is nowhere near the foyer (guildh14.kod:518-522).
  for (const [r, c] of [[20, 4], [18, 2], [18, 6]])
    ok(`the chest at r${r}c${c} is outside the foyer`, inFoyer(r, c) === false);

  // UNKNOWN IS NOT "OUTSIDE". A thin snapshot with no position must not be read as a licence
  // to assume the say will work — the caller decides what to do, but it has to be told.
  ok('an unreadable position answers null, not false', inFoyer(null, null) === null);
  ok('and so does a half-known one', inFoyer(5, undefined) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
