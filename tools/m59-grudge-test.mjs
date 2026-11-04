#!/usr/bin/env node
// WHO THE FLEET MAY SWING BACK AT. Offline, no server, safe any time:
//
//   node tools/m59-grudge-test.mjs
//
// This is the contract test for the only code in this repository that can make one of
// our characters attack a real person, so the assertions are written around the ways it
// could be wrong in that direction rather than around the happy path.
//
// The one that would be worst, and the one the whole design turns on: PF_* is an
// ENUMERATED FIELD, not independent bits, and PF_DM is exactly PF_KILLER | PF_OUTLAW.
// A bit test rather than an equality test opens fire on every Dungeon Master on the
// server. There is an assertion for that below and it should never be deleted.
//
// Uses M59_GRUDGE_FILE against a scratch path, so it never reads or writes the fleet's.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-grudge-test-'));
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const { recordAttack, grudgeAgainst, mayReturnFire, activeGrudges, forgive, clearAll,
        GRUDGE_MS, normName } = await import('./m59-grudge.mjs');
const { PF, OF, playerClass, playerClassName, isKiller, isOutlaw, flaggedAggressor } =
  await import('./m59-parse.mjs');

const PLAYER = OF.PLAYER | OF.ATTACKABLE;
const target = (name, cls, extra = 0) => ({ name, flags: (PLAYER | cls | extra) >>> 0 });

console.log('\nreading the red name off the flags');
{
  ok('a killer is a killer', isKiller(PLAYER | PF.KILLER));
  ok('an outlaw is an outlaw', isOutlaw(PLAYER | PF.OUTLAW));
  ok('an ordinary player is neither', !isKiller(PLAYER) && !isOutlaw(PLAYER));

  // THE ASSERTION THIS FILE EXISTS FOR. PF.DM === PF.KILLER | PF.OUTLAW (0xC000), so a
  // bit test reads every DM on the server as a murderer AND as an outlaw. Equality on
  // the masked field is the only correct read, and it is what the game's own client does
  // (a switch, clientd3d/color.c:619).
  ok('PF.DM really is KILLER|OUTLAW — the trap is real, not theoretical',
     PF.DM === (PF.KILLER | PF.OUTLAW));
  ok('a DM is NOT read as a killer', !isKiller(PLAYER | PF.DM));
  ok('a DM is NOT read as an outlaw', !isOutlaw(PLAYER | PF.DM));
  ok('a DM is not a valid target for self-defence', !flaggedAggressor(PLAYER | PF.DM));
  ok('and a naive bit test WOULD have hit them — this is what we avoided',
     ((PLAYER | PF.DM) & PF.KILLER) !== 0);

  ok('a creator is not a target', !flaggedAggressor(PLAYER | PF.CREATOR));
  ok('a super is not a target', !flaggedAggressor(PLAYER | PF.SUPER));
  ok('an event character is not a target', !flaggedAggressor(PLAYER | PF.EVENTCHAR));
  ok('an ordinary player is not a target', !flaggedAggressor(PLAYER));
  ok('a killer is', flaggedAggressor(PLAYER | PF.KILLER));
  ok('an outlaw is', flaggedAggressor(PLAYER | PF.OUTLAW));

  // A MONSTER'S FLAGS CAN CARRY ANYTHING IN THOSE BITS. The predicate takes the whole
  // word so OF.PLAYER cannot be forgotten by a caller.
  ok('a non-player with killer bits set is not a flagged aggressor',
     !flaggedAggressor(OF.ATTACKABLE | PF.KILLER));
  ok('the class has a readable name', playerClassName(PLAYER | PF.KILLER) === 'killer');
  ok('an unknown class does not throw', typeof playerClassName(PLAYER | 0x18000) === 'string');
}

console.log('\nthe memory');
{
  clearAll();
  ok('nobody to begin with', activeGrudges().length === 0);
  ok('and no grudge against a stranger', grudgeAgainst('Nobody') === null);

  const t0 = 1_700_000_000_000;
  recordAttack('Griefer', { who: 'Kermit', room: 108, at: t0 });
  const g = grudgeAgainst('Griefer', { now: t0 + 1000 });
  ok('an attack is remembered', !!g);
  ok('and it remembers who was hit', g.victims.includes('Kermit'));

  // FOLDED, because a name off the wire has whatever spacing and case its owner chose.
  ok('the name is matched case-insensitively', !!grudgeAgainst('griefer', { now: t0 + 1000 }));
  ok('and with sloppy whitespace', !!grudgeAgainst('  GRIEFER ', { now: t0 + 1000 }));
  ok('normName folds both', normName('  Foo   Bar ') === 'foo bar');

  // RE-DATING MOVES `at` AND NEVER `first`. "Started on us forty minutes ago" and "hit us
  // once just now" are different situations, and re-dating the start on every repeat is
  // how a campaign is made to look like an incident for ever — the same mistake the
  // loyalty warning is written to avoid.
  recordAttack('Griefer', { who: 'Piggy', room: 110, at: t0 + 600_000 });
  const g2 = grudgeAgainst('Griefer', { now: t0 + 600_000 });
  ok('a second attack does not move the start', g2.first === t0);
  ok('but it does move the last-seen', g2.at === t0 + 600_000);
  ok('it counts the blows', g2.hits === 2);
  ok('and it accumulates victims, without duplicating', g2.victims.length === 2);
  recordAttack('Griefer', { who: 'Piggy', at: t0 + 600_001 });
  ok('the same victim twice is still one victim',
     grudgeAgainst('Griefer', { now: t0 + 600_001 }).victims.length === 2);

  // THE WINDOW IS THE POINT. A murderer who left us alone for an hour is not a standing
  // target for the rest of the day.
  // Measured from the LAST blow, which the duplicate-victim write above moved forward.
  // Reading it back rather than recomputing it is the point: the window is relative to
  // `at`, and a test that hard-codes when `at` "should" be is testing its own arithmetic.
  const last = grudgeAgainst('Griefer', { now: t0 + 600_001 }).at;
  ok('inside the hour it holds', !!grudgeAgainst('Griefer', { now: last + GRUDGE_MS - 1 }));
  ok('past the hour it lapses', grudgeAgainst('Griefer', { now: last + GRUDGE_MS + 1 }) === null);
  ok('and a lapsed grudge is not listed as active',
     activeGrudges({ now: last + GRUDGE_MS + 1 }).length === 0);
}

console.log('\nthe three conditions, together');
{
  clearAll();
  const t0 = 1_700_000_000_000;
  const now = t0 + 60_000;
  recordAttack('Griefer', { who: 'Kermit', room: 108, at: t0 });

  ok('grudged AND flagged -> return fire',
     mayReturnFire(target('Griefer', PF.KILLER), { now }).engage === true);
  ok('an outlaw counts too',
     mayReturnFire(target('Griefer', PF.OUTLAW), { now }).engage === true);

  // EACH CONDITION ALONE IS NOT ENOUGH, and these three are the whole safety argument.
  ok('grudged but NO LONGER FLAGGED -> hold fire (they cleared it; so do we)',
     mayReturnFire(target('Griefer', PF.NORMAL), { now }).engage === false);
  ok('flagged but NOT grudged -> hold fire (a murderer is not by itself our business)',
     mayReturnFire(target('Someone Else', PF.KILLER), { now }).engage === false);
  ok('grudged, flagged, but the grudge has lapsed -> hold fire',
     mayReturnFire(target('Griefer', PF.KILLER), { now: t0 + GRUDGE_MS + 1 }).engage === false);

  // A DM WHO HAS SOMEHOW EARNED A GRUDGE IS STILL NOT A TARGET.
  recordAttack('Staff', { who: 'Kermit', at: t0 });
  ok('a grudged DM is still never a target',
     mayReturnFire(target('Staff', PF.DM), { now }).engage === false);

  // OURS, NEVER.
  ok('a fleetmate is refused before anything else is even asked',
     mayReturnFire(target('Griefer', PF.KILLER), { now, fleetmate: true }).engage === false);

  // Shape of the refusal: every branch says why, because a defensive rule that declines
  // silently is indistinguishable from one that never ran.
  ok('every refusal carries a reason',
     ['Griefer', 'Someone Else'].every(n =>
       typeof mayReturnFire(target(n, PF.NORMAL), { now }).why === 'string'));
  ok('and so does the engagement',
     /attacked|flagged/.test(mayReturnFire(target('Griefer', PF.KILLER), { now }).why));

  // Not a player, not attackable: both refused rather than reaching the class test.
  ok('a non-player object is refused',
     mayReturnFire({ name: 'Griefer', flags: PF.KILLER }, { now }).engage === false);
  ok('an unattackable player is refused',
     mayReturnFire({ name: 'Griefer', flags: (OF.PLAYER | PF.KILLER) >>> 0 }, { now }).engage === false);
  ok('a missing target does not throw', mayReturnFire(null, { now }).engage === false);
  ok('a nameless target does not engage',
     mayReturnFire({ flags: (PLAYER | PF.KILLER) >>> 0 }, { now }).engage === false);
}

console.log('\nforgiving');
{
  clearAll();
  recordAttack('Griefer', { who: 'Kermit' });
  ok('forgive removes it', forgive('Griefer') === true && grudgeAgainst('Griefer') === null);
  ok('forgiving a stranger is not an error', forgive('Nobody') === false);
  recordAttack('A', { who: 'Kermit' }); recordAttack('B', { who: 'Piggy' });
  clearAll();
  ok('clear empties the list', activeGrudges().length === 0);
}

console.log('\nnever one of ours (2026-11-04: 18 fleet characters were in the prod book)');
{
  const party = await import('./m59-party.mjs');
  clearAll();
  party.setRosterSource(() => new Set(['Lew', 'Fozzie']));
  ok('a fleet-mate is refused', recordAttack('Lew', { who: 'Kermit', room: 2143 }) === null && grudgeAgainst('Lew') === null);
  ok('case and spacing do not get one of ours in', recordAttack('  fozzie ', { who: 'Statler' }) === null && grudgeAgainst('Fozzie') === null);
  ok('a stranger is still recorded', recordAttack('Griefer', { who: 'Kermit' }) !== null && grudgeAgainst('Griefer') !== null);
  party.setRosterSource(null);
  clearAll();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
