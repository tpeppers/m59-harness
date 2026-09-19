#!/usr/bin/env node
// A FULL PACK GETS THE CIRCUIT, WHATEVER SENT IT TO TOWN.
// Offline: no broker, no socket, no roster, no fleet.
//
// ======================== THE CLAIM THIS SUITE EXISTS TO PIN ========================
//
// The town trip attaches `MARKET_STOPS` — the blacksmith, the gem counter and the reagent
// counter — and walks all three. It attached them from the TRIGGER that opened the trip:
//
//     const packFull = sellCall.sell && !['broke', 'supply'].includes(sellCall.trigger);
//     marketStops: packFull || brokeWithGoods ? MARKET_STOPS... : null
//
// Two of the five triggers say no. A `supply` trip is a reagent shortfall and a `broke` trip
// is a money one; both are correct about the DESTINATION and neither is evidence about the
// PACK. So a character out of elderberry walked to Joguer's Herbs and Roots with twenty-six
// stacks aboard, bought its two reagents, sold the mushrooms Joguer buys — and came home
// still carrying twenty-one long swords, because Joguer is not a blacksmith and the circuit
// that would have walked it to one was never attached.
//
// MEASURED ON PROD 2026-09-19. Pepe and Statler both sat on `pending_trip.to = 104` with
// `market_stops: null` and 26 stacks each. Fleet-wide: 122 long swords across eleven
// characters (Pepe 22, Statler 21, Janice 16, Bunsen 15, Robin 15, Kermit 12), 47 flasks,
// 10 hammers, 9 axes. `maxWeapons: 2` was correctly set on all 24 the whole time — the plan
// was right and the offer was never made, because the only two weapon buyers on the
// allowlist (Quintor's Smithy and Fehr'loi Qan) were never visited.
//
// `packWantsMarket()` asks the PACK instead, using deliberately the same arithmetic as the
// `load` and `stacks` triggers, so a trip cannot be attached under one rule and refused
// under another.
import { Autopilot, MARKET_STOPS } from './m59-autopilot.mjs';
import * as skills from './m59-skills.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// A CLIENT THAT REALLY DRIVES `carryCapacity`, not one that looks as though it does.
//
// The first draft of this fixture handed the method a pre-baked `carry` object and all
// twelve assertions passed — on the STACK COUNT alone. `carryCapacity` reads
// `c.stat('might')` and weighs the pack from real item NAMES, so without those it answers
// `{known:false, why:'might has not been read yet'}` and the fullness half of the branch is
// never executed. A suite that cannot reach half its subject is a suite that will pass
// straight through the regression it was written for.
const rig = ({ items = [], might = 15, policy = {} } = {}) => ({
  policy,
  s: { client: {
    inventory: items.map((name, i) => ({ id: i + 1, nameRsc: i + 1, amount: 0, name })),
    rsc: { get: (k) => items[Number(k) - 1] ?? '' },
    stat: (k) => (k === 'might' ? might : null),
    vitals: () => ({}),
  } },
});
const wants = (self) => Autopilot.prototype.packWantsMarket.call(self);
const many = (name, n) => Array.from({ length: n }, () => name);

// The capacity formula is 1700 + might*20 (player.kod:10456), so might 15 is a 2000 ceiling.
// This runs FIRST and exits non-zero: if the fixture cannot drive the real function, every
// assertion below is about nothing and should say so loudly rather than pass.
{
  const probe = rig({ items: many('long sword', 2) });
  const cap = skills.carryCapacity(probe.s.client);
  if (!cap.known) { console.log('  FAIL the fixture cannot drive carryCapacity — ' + cap.why); process.exit(1); }
  console.log(`  (fixture check: capacity readable, max ${cap.weight_max}, ` +
              `2 long swords weigh ${cap.load.weight})`);
}

console.log('\nTHE STACK RULE, WITH A LIGHT ITEM SO WEIGHT CANNOT CONFOUND IT');
{
  ok('26 stacks wants the circuit', wants(rig({ items: many('herb', 26) })) === true);
  ok('3 stacks does not', wants(rig({ items: many('herb', 3) })) === false);
  ok('13 stacks is under the ceiling', wants(rig({ items: many('herb', 13) })) === false);
  ok('14 stacks is AT the ceiling and counts', wants(rig({ items: many('herb', 14) })) === true);
}

console.log('\nAND THE POLICY MOVES THEM, RATHER THAN A SECOND CONSTANT');
{
  ok('a lower maxCarry fires sooner',
     wants(rig({ items: many('herb', 8), policy: { maxCarry: 6 } })) === true);
  // sellAtLoad is raised too, or the WEIGHT rule answers and this passes for the wrong reason.
  ok('a higher maxCarry holds off',
     wants(rig({ items: many('herb', 26), policy: { maxCarry: 40, sellAtLoad: 0.99 } })) === false);
}

console.log('\nTHE WEIGHT RULE ON ITS OWN, WITH THE STACK RULE HELD OFF');
{
  // THIS IS THE HALF THE FIRST FIXTURE COULD NOT REACH. Few stacks, heavy pack: only the
  // fullness branch can answer true here, so it is the branch actually under test.
  // 80 per sword against a 2000 ceiling, so 22 clears 85% while maxCarry 100 keeps the
  // stack rule out of it. The count was 12 in the first draft and reached only 48% —
  // the fixture check above is what caught that, which is the whole reason it is there.
  const heavy = rig({ items: many('long sword', 22), policy: { maxCarry: 100 } });
  const cap = skills.carryCapacity(heavy.s.client);
  const frac = Math.max(cap.load.weight / cap.weight_max, cap.load.bulk / cap.bulk_max);
  ok('the fixture really is heavy and really is few stacks',
     cap.known && frac >= 0.85 && heavy.s.client.inventory.length < 100,
     `${Math.round(frac * 100)}% of capacity in ${heavy.s.client.inventory.length} stacks`);
  ok('a heavy pack wants the circuit on weight alone', wants(heavy) === true);
  ok('a light pack of the same stack count does not',
     wants(rig({ items: many('herb', 22), policy: { maxCarry: 100 } })) === false);
}

console.log('\nTHE STOPS THEMSELVES INCLUDE A WEAPON BUYER, WHICH IS THE WHOLE POINT');
{
  ok('there are three specialists', MARKET_STOPS.length === 3, String(MARKET_STOPS.length));
  const names = MARKET_STOPS.map(s => s.name.toLowerCase()).join(' | ');
  // Fehr'loi Qan is the Royal Blacksmith of Barloque and is on SELL_TO. Joguer alone — the
  // stop these characters were making — buys reagents and cannot take a sword.
  ok('one of them is the blacksmith', /fehr/.test(names), names);
  ok('and the reagent counter is still on the circuit', /joguer/.test(names));
  ok('every stop names a room', MARKET_STOPS.every(s => Number.isFinite(s.room)));
}

console.log('\nAN UNREADABLE PACK DOES NOT MANUFACTURE A TRIP');
{
  // carryCapacity withholds rather than guesses. A missing reading must not read as "full"
  // — that would send a character to town on no evidence, which is the mirror of the bug
  // being fixed and costs a walk every pass.
  ok('capacity unknown and few stacks: no circuit',
     wants(rig({ items: many('herb', 2), might: null })) === false);
  // ...but the stack count is still a real reading and still counts.
  ok('capacity unknown but 26 stacks: still a circuit',
     wants(rig({ items: many('herb', 26), might: null })) === true);
}


console.log('\nAND THE TRIP ACTUALLY CONSULTS IT');
{
  // A SOURCE ASSERTION, DELIBERATELY, AND THIS IS THE ARGUMENT FOR IT.
  //
  // Everything above tests the PREDICATE. Reverting the one-line wiring in the trip builder
  // leaves every assertion above green, because they call the method directly — a mutation
  // check proved exactly that. Driving the real builder needs a live-ish client, a world, a
  // route table and a shopping plan, which is the kind of rig this repository has learned to
  // distrust: it would pin the fixture rather than the behaviour.
  //
  // So this asserts the SEAM instead: the predicate exists, and the code that attaches
  // MARKET_STOPS asks it. Narrow, and it fails the day somebody deletes the call.
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the predicate is defined', /packWantsMarket\s*\(\)\s*{/.test(src));
  const at = src.indexOf('marketStops:');
  const attach = src.slice(Math.max(0, at - 900), at + 200);
  ok('and the marketStops attachment consults it, not only the trigger',
     /this\.packWantsMarket\(\)/.test(attach));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
