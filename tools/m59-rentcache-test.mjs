#!/usr/bin/env node
// THE RENT READING HAS TO BE WRITTEN DOWN, AND SILENCE MUST NOT BE.
//
// `guildStoreAvailable` (m59-guildwants.mjs:83) gates the entire guild stockpile on a cached
// rent reading. `StorageCache.writeRent` existed, was tested, and had exactly ONE caller in
// the repository — its own test. So the gate asked for a fact no production path could
// produce, and `guildWants: {enabled: true}` on all 21 characters sat inert behind
// "nobody has asked Frular about the guild yet". The feature never failed; it declined.
//
// The half that needs a guard is the half that must NOT write. `askRent` already argues that
// speech from beyond SAY_RADIUS is dropped by SayRangeCheck and that the resulting silence is
// not evidence about the rent. Caching that silence would promote a question nobody heard
// into a durable fact — and this cache is read to decide whether the fleet has a hall at all.
//
// Offline. Writes only into a temp directory, which is why M59_STORAGE_DIR is set before the
// modules are imported: STORAGE_DIR is resolved at module load, so a static import would bind
// the repository's own substrate/storage before the first assertion ran.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-rentcache-'));
process.env.M59_STORAGE_DIR = dir;

const { guildRentStatus } = await import('./m59-tithe.mjs');

let pass = 0, fail = 0;
const ok = (what, cond) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}`); }
};

const RENT_PATH = join(dir, 'rent.json');
const rentFile = () => (existsSync(RENT_PATH) ? JSON.parse(readFileSync(RENT_PATH, 'utf8')) : null);
const clear = () => rmSync(RENT_PATH, { force: true });

// A session just complete enough to walk `guildRentStatus`. `at` is Frular's square and
// `me` is ours, in the same units withinSayRange compares.
function session({ said = [], me = { col: 10, row: 10 }, frular = { col: 10, row: 10 } } = {}) {
  const names = new Map([[1, 'Frular'], [2, 'shilling']]);
  const c = {
    self: { ...me },
    evSeq: 0,
    inventory: [{ id: 9, nameRsc: 2, amount: 250 }],
    rsc: { get: id => names.get(id) },
    me: { name: 'Camilla' },
    room: { objects: new Map([[77, { id: 77, nameRsc: 1, ...frular }]]) },
    say() {},
    async waitFor() { return { events: said.map(t => ({ text: t })) }; },
  };
  return {
    name: 'Camilla',
    need: () => c,
    pacer: { submit: async (_k, fn) => fn() },
    world: { room: { num: 700 }, approachSquare: () => null },
    walkTo: async () => ({ arrived: false, reason: 'test' }),
  };
}

console.log('\nAN ANSWER WE HEARD IS RECORDED');
{
  clear();
  const r = await guildRentStatus(session({ said: ['The Second Swines owes 4200 coins in rent.'] }));
  ok('the status reports the debt', r.due === 4200);
  ok('and says it recorded it', r.recorded === true);
  const f = rentFile();
  ok('rent.json now exists — nothing wrote one before this', !!f);
  ok('carrying the amount', f.due === 4200);
  ok('and the sign, because credit and debt are the same number twice', f.credit === -4200);
  ok('and in_guild, which is what the stockpile gate actually reads', f.in_guild === true);
  ok('and who asked', f.asked_by === 'Camilla');
}

console.log('\nA POSITIVE BALANCE IS NOT A DEBT');
{
  clear();
  await guildRentStatus(session({ said: ['The Second Swines has a positive balance of 900 shillings.'] }));
  const f = rentFile();
  ok('a credit is stored as a negative due', f.due === -900);
  ok('and a positive credit', f.credit === 900);
}

console.log('\nSILENCE FROM OUT OF EARSHOT IS NOT A RENT READING');
{
  // SAY_RADIUS is 50 and compared SQUARED (holder.kod:604), so ~7 squares. 60 apart is out.
  clear();
  const r = await guildRentStatus(session({ said: [], me: { col: 10, row: 10 },
                                            frular: { col: 70, row: 10 } }));
  ok('the status says it was out of earshot', r.out_of_earshot === true);
  ok('and that nothing was recorded', r.recorded === false);
  ok('NO FILE IS WRITTEN — a question nobody heard is not an answer', rentFile() === null);
}

console.log('\nAND NEITHER IS A REPLY WE CANNOT READ');
{
  clear();
  const r = await guildRentStatus(session({ said: ['Frular mutters something unfamiliar.'] }));
  ok('nothing parsed, so nothing is claimed', r.recorded === false);
  ok('and nothing is cached', rentFile() === null);
  ok('the refusal explains itself', /cannot read|does not|not an answer/i.test(r.why || ''));
}

console.log('\nA HEARD ANSWER REPLACES AN OLDER ONE');
{
  clear();
  await guildRentStatus(session({ said: ['The Second Swines owes 4200 coins in rent.'] }));
  await guildRentStatus(session({ said: ['The Second Swines owest no rent.'] }));
  const f = rentFile();
  ok('the newer reading wins', f.due === 0 && f.credit === 0);
  ok('and it is still a guild', f.in_guild === true);

  // BUT AN UNHEARD ONE DOES NOT CLOBBER IT. This is the case that matters operationally: a
  // character wanders out of earshot, asks, hears nothing, and the good reading must survive.
  await guildRentStatus(session({ said: [], me: { col: 10, row: 10 }, frular: { col: 70, row: 10 } }));
  ok('a later unheard question leaves the good reading alone', rentFile().due === 0);
}

console.log('\nAN ANSWER WE HEARD COUNTS, WHEREVER THE BODY DRIFTED AFTERWARDS');
{
  // MEASURED ON PROD 2026-09-12, and it cost a real reading. Frular answered — "The The Second
  // Swines owes 6547 coins in rent at this time." — and nothing was written, because
  // `out_of_earshot` is computed from a position sampled AFTER the exchange and the keeper had
  // already walked the body off. The instrument disagreed with the value and the instrument won.
  //
  // A parsed line FROM Frular is proof we were heard. The range check exists to explain a
  // silence, not to overrule speech that demonstrably arrived.
  clear();
  const r = await guildRentStatus(session({
    said: ['You say, "rent"', 'Frular says, "The The Second Swines owes 6547 coins in rent at this time."'],
    me: { col: 5, row: 17 }, frular: { col: 7, row: 5 },   // squared distance 148 vs radius 50
  }));
  ok('the answer is parsed', r.due === 6547);
  ok('the range check still reports the drift', r.out_of_earshot === true);
  ok('AND IT IS RECORDED ANYWAY', r.recorded === true);
  ok('the file carries the debt', rentFile()?.due === 6547);
  ok('and the guild flag the stockpile gate reads', rentFile()?.in_guild === true);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
