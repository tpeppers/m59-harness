#!/usr/bin/env node
// WHICH COUNTER A TOWN TRIP IS AIMED AT. Offline, no server, safe any time:
//
//   node tools/m59-townrun-test.mjs
//
// THE BUG THIS EXISTS FOR, measured on the live fleet 2026-08-16.
//
// `checkIfShouldSell` grew a `supply` trigger — "below its own reagent floor with no meals
// aboard" — long after `bankRun` learned to read that function's answer as "the pack is
// full". So a reagent shortfall was routed to a MARKET. Roq buys; he sells nothing. The
// character arrived with an empty pack, sold nothing, walked one room to the apothecary
// with the two shillings it set out with, was refused, walked back, and the shortfall that
// opened the trip was exactly as true as when it started.
//
// Fozzie made that 110 -> 104 round trip every thirty-five seconds for more than five
// hours: 155 `buy_declined` in one day, every one reading `spendable: 2`, 0 kills in the
// last half hour — while holding 27,282 shillings in the bank. Twelve of twenty-one
// characters were in the same loop and the fleet was sitting on 666,540 banked shillings.
// Nothing errored, nothing stalled, and every line of it logged as "going to the bank".
//
// Two properties are pinned here and both fail in the expensive direction if inverted:
//
//   1. A trip is aimed at a counter that can FIX the thing that opened it. Selling fixes a
//      full pack; only buying fixes a shortfall, and buying needs money.
//   2. A character that cannot pay goes to the bank FIRST. It is not poor, it is illiquid,
//      and the door for that was already built for hunger and never wired to supply.
//
// The bill arithmetic is pinned too, because the trip and the withdrawal both read it and
// two answers to "what does this errand cost" is how a character draws pocket money for an
// 8,400sh fill and is back on the road inside the hour.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scratch loadout directory, so this never reads the one a live keeper is reading on
// every pass — the same rule m59-loadout-test.mjs follows.
const dir = mkdtempSync(join(tmpdir(), 'm59-townrun-test-'));
process.env.M59_LOADOUT_DIR = dir;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const { townDestinations, Autopilot } = await import('./m59-autopilot.mjs');

const rooms = state => townDestinations(state).map(d => d.room);
const JOGUER = 104, BREAD = 103, MARKET = 113, TOS = 54, JASPER = 376;

console.log('\nwhere a town trip is aimed');
{
  // THE REGRESSION. A supply-triggered trip must not be aimed at the one counter in the
  // world that cannot sell it what it is short of.
  ok('a reagent shortfall goes to the apothecary, never to the market',
     rooms({ supplyTrip: true }).join() === String(JOGUER),
     `got ${rooms({ supplyTrip: true })}`);
  ok('and with an empty purse it goes to the bank first — illiquid, not poor',
     rooms({ supplyTrip: true, needsCashFirst: true }).join() === [TOS, JASPER].join());

  // The doors that already worked, kept working. A full pack is the case the market was
  // built for and it must not be dragged along by the fix above.
  ok('a full pack starts at the equipment specialist',
     rooms({ packFull: true }).join() === String(MARKET));
  ok('broke with goods aboard goes to the market too',
     rooms({ brokeWithGoods: true }).join() === String(MARKET));
  ok('an empty larder goes to the bread shop',
     rooms({ starving: true }).join() === String(BREAD));
  ok('a full pack sells before buying food',
     rooms({ starving: true, packFull: true }).join() === String(MARKET));

  // Money on the character is the one thing a death takes for ever.
  ok('over the banking threshold, the bank wins over every shopping door',
     rooms({ richEnoughToBank: true, supplyTrip: true, starving: true }).join() ===
     [TOS, JASPER].join());
  ok('needing cash outranks even that, because the shops come after it',
     rooms({ needsCashFirst: true, richEnoughToBank: true }).join() === [TOS, JASPER].join());
  ok('and with no door open at all the answer is still a bank, not nowhere',
     rooms({}).join() === [TOS, JASPER].join());
}

console.log('\nwhat the shortfall costs at a counter');
{
  // A bare object on the prototype: reagentGapCost reads only the loadout and the pack,
  // and constructing a real Autopilot would take a session, a client and the fleet lock.
  const bot = Object.create(Autopilot.prototype);
  // A FRESH NAME PER CASE, because loadoutFor caches on mtime and these files are written
  // inside the same millisecond — a shared name would serve the first case's list to all
  // of them and the failures would look like arithmetic bugs.
  let n = 0;
  const withPack = (carry, pack, { noLoadout = false } = {}) => {
    const who = `Tester${++n}`;
    if (!noLoadout) writeFileSync(join(dir, `${who.toLowerCase()}.json`), JSON.stringify({
      format: 'm59-loadout/1', character: who, carry }));
    bot.s = { client: { me: { name: who } } };
    bot.packAsItems = () => pack;
    return bot.reagentGapCost();
  };
  const floor = (item, min, max) => ({ item, min, max, match: 'exact', kind: 'reagent' });

  // Counter prices at Joguer: elderberry 28, herbs 14. Below the floor, the bill is what
  // it takes to reach the CEILING — the walk is the expensive part and what it carries
  // home is nearly free.
  ok('below the floor, the bill fills to the ceiling',
     withPack([floor('elderberry', 6, 200)], [{ name: 'elderberry', amount: 3 }])
       === (200 - 3) * 28);
  ok('herbs are priced as herbs, not as elderberry',
     withPack([floor('herb', 6, 200)], [{ name: 'herb', amount: 4 }]) === (200 - 4) * 14);
  ok('both halves of the recipe add up',
     withPack([floor('elderberry', 6, 200), floor('herb', 6, 200)],
              [{ name: 'elderberry', amount: 3 }, { name: 'herb', amount: 4 }])
       === (200 - 3) * 28 + (200 - 4) * 14);

  // AT OR ABOVE THE FLOOR IS NOT A TRIP. The floor is what opens the errand; topping up a
  // character that is already above it is how a fleet spends its day in town.
  ok('at the floor, there is no bill and so no errand',
     withPack([floor('elderberry', 6, 200)], [{ name: 'elderberry', amount: 6 }]) === 0);

  // A loadout may ask for anything, and being short of a spare shield is not a bank trip.
  ok('only the two halves of create food are priced',
     withPack([{ item: 'knight\'s shield', min: 2, max: 4, match: 'exact' }],
              [{ name: 'knight\'s shield', amount: 0 }]) === 0);

  // SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. No loadout is not a floor of zero
  // and it is not a floor of anything else either — it is nobody having said, and the safe
  // reading of that is a bill of nothing rather than an invented shopping list.
  ok('no loadout is no bill, never a guessed one',
     withPack([], [{ name: 'elderberry', amount: 0 }], { noLoadout: true }) === 0);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
