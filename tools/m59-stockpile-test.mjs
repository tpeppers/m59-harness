#!/usr/bin/env node
// THE LIVE REAGENT STOCKPILE — the decisions, offline. Opens no socket and joins nobody.
//
//   node tools/m59-stockpile-test.mjs
//
// What is pinned here, in order of what being wrong would cost:
//
//   1. THE DOOR. CanEnter (ghall.kod:1039) admits members and allies at rank >= SIR and
//      refuses apprentices by name. Getting this wrong sends a character on a walk it
//      cannot complete, and the refusal at the far end is a closed door rather than a
//      message — so it presents as a stall in Barloque.
//   2. AN UNOPENED CHEST IS NOT AN EMPTY ONE. Chest contents are never pushed, so the only
//      record is the last look. Reading "never opened" as "holds nothing" sends somebody to
//      buy what they are standing on; reading it as full sends them home with nothing.
//   3. THE SAVINGS MUST NOT FLATTER. The hall costs 12,000 a day and this ledger is the
//      evidence for or against it, so a missing price contributes ZERO and says so.
//   4. A WANT IS A SHORTFALL AGAINST THE SAME FLOOR THE DONOR PROTECTS. One quantity read
//      two ways is how a fleet ships elderberry back and forth for ever.
import assert from 'node:assert/strict';
import { reagentWants, canEnterHall, sourcePlan, savingsOf, stockpileLedger,
         paysForHall, outsiderPlan, REAGENTS } from './m59-stockpile.mjs';
import { RANK } from './m59-guild.mjs';

let n = 0;
const ok = (what, cond) => { assert.ok(cond, what); n++; };

// ---------------------------------------------------------------- the door
{
  const hall = { hallGuildId: 8248 };
  ok('a lord gets in',      canEnterHall({ ...hall, guildId: 8248, rank: RANK.LORD }).ok === true);
  ok('a master gets in',    canEnterHall({ ...hall, guildId: 8248, rank: RANK.MASTER }).ok === true);
  ok('SIR is the floor and gets in',
     canEnterHall({ ...hall, guildId: 8248, rank: RANK.SIR }).ok === true);

  // THE CASE THE SPEC MISSED, and the one nothing announces.
  const app = canEnterHall({ ...hall, guildId: 8248, rank: RANK.APPRENTICE });
  ok('AN APPRENTICE IS A MEMBER AND IS STILL REFUSED', app.ok === false);
  ok('and the refusal cites the kod and says to promote',
     /ghall\.kod:1039/.test(app.why) && /[Pp]romote/.test(app.why));

  ok('a non-member is refused', canEnterHall({ ...hall, guildId: null, rank: null }).ok === false);
  ok('another guild is refused',
     canEnterHall({ ...hall, guildId: 999, rank: RANK.MASTER }).ok === false);
  ok('an ALLY guild at rank is admitted',
     canEnterHall({ ...hall, guildId: 999, rank: RANK.LORD, allyGuildIds: [999] }).ok === true);
  ok('an ally BELOW rank is still refused',
     canEnterHall({ ...hall, guildId: 999, rank: RANK.APPRENTICE, allyGuildIds: [999] }).ok === false);
  ok('an unowned hall is open to anybody', canEnterHall({ hallGuildId: null }).ok === true);
}

// ---------------------------------------------------------------- who is short
{
  const characters = [
    { agent: 't6', character: 'Beaker', loadout: { carry: [{ item: 'elderberry', min: 20 }] },
      pack: [{ name: 'elderberry', amount: 16 }] },
    { agent: 't2', character: 'Pepe', loadout: { carry: [{ item: 'elderberry', min: 20 }] },
      pack: [{ name: 'elderberry', amount: 40 }] },                       // over its floor
    { agent: 'hk1', character: 'Loial', menagerie: true,
      loadout: { carry: [{ item: 'herbs', min: 10 }] }, pack: [] },
    { agent: 't9', character: 'Camilla', loadout: { carry: [] }, pack: [] },  // no floor, no want
  ];
  const w = reagentWants({ characters });
  ok('a character under its floor wants the difference', w.get('elderberry').want === 4);
  ok('and a character OVER its floor wants nothing',
     !w.get('elderberry').by.some(b => b.agent === 't2'));
  ok('a character with no floor declares no want', !w.get('elderberry').by.some(b => b.agent === 't9'));
  ok('THE MENAGERIE IS COUNTED FOR STORAGE', w.get('herbs').want === 10);
  ok('and is flagged as menagerie, because it cannot fetch for itself',
     w.get('herbs').by[0].menagerie === true);
  ok('an out-of-game character is skipped',
     reagentWants({ characters: [{ ...characters[0], in_game: false }] }).size === 0);
  ok('the two reagents are the default set', REAGENTS.join(',') === 'elderberry,herbs');
}

// ---------------------------------------------------------------- take, or buy
{
  const chests = [{ slot: 1, items: [{ name: 'elderberry', amount: 300 }] },
                  { slot: 2, items: [{ name: 'herbs', amount: 5 }] }];

  let p = sourcePlan({ need: [{ item: 'elderberry', amount: 60 }], chests });
  ok('a stocked chest is used instead of buying',
     p.fromChest.length === 1 && p.fromChest[0].amount === 60 && !p.toBuy.length);

  p = sourcePlan({ need: [{ item: 'herbs', amount: 40 }], chests });
  ok('a partly stocked chest covers what it can', p.fromChest[0].amount === 5);
  ok('and only the REMAINDER is bought', p.toBuy[0].amount === 35);

  p = sourcePlan({ need: [{ item: 'sapphire', amount: 3 }], chests });
  ok('an item no chest holds is simply bought', !p.fromChest.length && p.toBuy[0].amount === 3);

  // ONE POOL. Two claims on the same stack cannot both be promised it.
  p = sourcePlan({ need: [{ item: 'herbs', amount: 3 }, { item: 'herbs', amount: 9 }], chests });
  const took = p.fromChest.reduce((s, f) => s + f.amount, 0);
  ok('a stack cannot be promised twice', took === 5);
  ok('and the rest of the second claim is bought',
     p.toBuy.reduce((s, b) => s + b.amount, 0) === 7);

  // AN UNOPENED CHEST IS UNKNOWN, NOT EMPTY.
  p = sourcePlan({ need: [{ item: 'elderberry', amount: 10 }],
                   chests: [{ slot: 1, never_opened: true }] });
  ok('an unopened chest is not counted as holding anything', !p.fromChest.length);
  ok('so the shortfall is BOUGHT rather than assumed', p.toBuy[0].amount === 10);
  ok('and it says the chest was never opened', /never been opened/.test(p.why));
  ok('the unopened slot is named', p.unknown.includes(1));

  // A store that is not available buys everything and says it did not look.
  p = sourcePlan({ need: [{ item: 'elderberry', amount: 10 }], chests, available: false,
                   why: 'the guild owes rent' });
  ok('an unavailable store does not pretend to have looked', p.consulted === false);
  ok('and everything is bought', p.toBuy[0].amount === 10 && !p.fromChest.length);
}

// ---------------------------------------------------------------- what it saved
{
  const s = savingsOf({ item: 'elderberry', amount: 10, buyPrice: 12, sellPrice: 4 });
  ok('the saving is the SPREAD, both halves', s.saved === 160);
  ok('the buy avoided is counted', s.buy_avoided === 120);
  ok('and the sale forgone too', s.sell_forgone === 40);
  ok('a fully priced move is not flagged unpriced', s.unpriced === false);

  // A LEDGER THAT GUESSED WOULD ALWAYS JUSTIFY THE HALL.
  const u = savingsOf({ item: 'herbs', amount: 10, buyPrice: null, sellPrice: 4 });
  ok('a missing price contributes ZERO, never a guess', u.buy_avoided === 0);
  ok('the known half still counts', u.sell_forgone === 40 && u.saved === 40);
  ok('and it is marked unpriced with the reason', u.unpriced === true && /guess/.test(u.why));

  const led = stockpileLedger([s, u]);
  ok('the ledger sums the moves', led.moves === 2 && led.units === 20);
  ok('and the saving', led.saved === 200);
  ok('it counts how many moves were unpriced, so the total can be discounted',
     led.unpriced_moves === 1);
  ok('and breaks down by item', led.by_item.elderberry.saved === 160);

  const verdict = paysForHall({ saved: 200, days: 1 });
  ok('200 a day does NOT cover a 12,000 hall', verdict.covers === false);
  ok('and it says by how much', verdict.shortfall_per_day === 11_800);
  ok('a hall IS covered when the saving beats the rent',
     paysForHall({ saved: 24_000, days: 1 }).covers === true);
}

// ---------------------------------------------------------------- Help_Outsider
{
  const chests = [{ slot: 1, items: [{ name: 'elderberry', amount: 50 },
                                     { name: 'herbs', amount: 2 }] }];
  const requests = [{ agent: 'hk1', character: 'Loial', item: 'elderberry', amount: 20 },
                    { agent: 'hk2', character: 'Marco Polo', item: 'herbs', amount: 10 }];
  const lord = { agent: 't2', guildId: 8248, rank: RANK.LORD, hallGuildId: 8248 };

  const p = outsiderPlan({ requests, couriers: [lord], chests });
  ok('a courier who can get in is chosen', p.courier === 't2');
  ok('a request the chest can fill is served', p.served.find(x => x.agent === 'hk1').give === 20);
  ok('a request it can only part-fill is part-served',
     p.served.find(x => x.agent === 'hk2').give === 2);
  ok('and the remainder is reported unserved rather than bought',
     p.unserved.find(x => x.agent === 'hk2').short === 8);
  ok('the errand never justifies a trip of its own', /never justifies a trip/.test(p.note));

  // A FLEET OF APPRENTICES CAN SERVE NOBODY, and it must say so rather than going quiet.
  const app = outsiderPlan({ requests, chests,
    couriers: [{ agent: 't5', guildId: 8248, rank: RANK.APPRENTICE, hallGuildId: 8248 }] });
  ok('no admissible courier serves nobody', app.served.length === 0);
  ok('and it names the door as the reason', /door/.test(app.why));
  ok('every request is reported unserved', app.unserved.length === 2);
  ok('the refused courier is still listed, with why', app.couriers.unable[0].agent === 't5');

  ok('no couriers at all is stated plainly',
     /no couriers offered/.test(outsiderPlan({ requests, couriers: [], chests }).why));
}

console.log(`\n${n} passed, 0 failed\n`);
