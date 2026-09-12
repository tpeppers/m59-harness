// BUY ORC TEETH FROM PADDOCK, WHOSE SHELF DOES NOT LIST THEM UNTIL YOU ASK.
//
// PUBLIC. Orc teeth are the reagent for both identification spells — `identify` burns 1 and
// `reveal` burns 3 (identify.kod:51, reveal.kod:55) — so they are the entire running cost of
// the fleet's reveal service. See m59-reveal.mjs.
//
// WHY THIS NEEDS A SCRIPT AT ALL, AND WHY `merchants` WILL TELL YOU IT IS IMPOSSIBLE.
//
// `merchants sells:"orc tooth"` returns NOTHING, and that is a gap in the tool rather than a
// fact about the world. The tool indexes `plFor_sale`, which is the shelf a merchant is born
// with. Paddock's teeth are not on it: `InitCondSale` (TsInnK.kod:111-114) registers them in
// the MOB LIBRARY as a `LIBACT_CONDITIONAL` keyed on a trigger word, and only when somebody
// says that word does `AddToConditionalList` (monster.kod:4725-4745) push `[object, price]`
// onto slot 4 of `plFor_sale`, where an ordinary buy can reach it.
//
// So the sequence is SAY THEN BUY, in that order, and a buy on its own fails against a shelf
// that genuinely does not have the row. Three merchants do this with teeth and Paddock is not
// the cheapest — Marion's elder sells 4 for 350 (MrElder.kod:82-85) against Paddock's 2 for
// 650, and Ko'catan's weapons master is worse again at 2 for 750 (kcweapon.kod:70-73). Paddock
// is the default because Tos is where this fleet already banks and sells; `seller`, `room`,
// `trigger`, `price` and `each` are all parameters so the cheaper counter is one argument away.
//
// THE TRIGGER IS THE PLURAL, AND THAT IS NOT A STYLE CHOICE. The trigger is registered as
// `Send(oObj,@GetName)` on an OrcTooth stack created with `#number=2`, and a NumberItem
// answers GetName with its plural above one (orctooth.kod:19-32). So the word is "orc teeth".
// "orc tooth" is a different string and matches nothing.
//
// AND SPEECH TO A MERCHANT IS RANGE-LIMITED AND SILENT ABOUT IT. `SayRangeCheck`
// (holder.kod:604) drops the line when the squared distance exceeds 50 and sends nothing back,
// so standing across the bar is indistinguishable from a merchant who does not sell teeth.
// `say(..., { to })` is a movement step for exactly this reason — it walks into earshot first.
// That fact cost this repository a month on the guild rent balance; it is not going to cost it
// an evening on teeth.
// HE RUNS OUT, AND SIX TEETH IS THE WHOLE VISIT. Measured on prod 2026-09-12, first live
// run: Gonzo said the word and bought at rounds 1, 2 and 3 — `+2/2` each — and round 4
// answered "nothing entered the pack". 1,950 shillings for six teeth, and then the counter is
// dry however many more times you say it.
//
// So `rounds` is a CEILING and not an order, and the stopping is the ordinary step failure
// rather than anything clever: the empty round fails its `shop` check, the errand unwinds, and
// only the `always` steps run — which is why the walk home is one of them. An operator asking
// for 10,000 shillings of teeth (about thirty, at 325 each) cannot have them from one visit.
//
// THAT IS THE ARGUMENT FOR FARMING THEM. An orc drops one on a 40% roll (orctres.kod:32) and
// room 27 is half orcs, so a station there out-supplies every counter in the world put
// together — see the orc school in prod-weaponcraft-training.jsonc. Buying is the bootstrap
// that gets the first casts done; it is not the supply.
import { walk, bank, shop, say, verify } from '../m59-fleetscript.mjs';

export const script = {
  name: 'buy-orc-teeth',
  describe: 'Buy orc teeth from a merchant who only lists them after you say the word.',
  recipe: {
    effect: 'Walks to Paddock in Familiars (52), says "orc teeth" to make him list them, buys ' +
            'them, and proves the pack actually grew. Withdraws first when the purse is short.',
    run: 'buy-orc-teeth agents=hk1 rounds=4 home=106',
    needs: ['the money — 650 per 2 teeth at Paddock, and the bank leg covers a short purse',
            'pack room: teeth are light but a caster full of pork answers receiver_full to ' +
              'everything, so shed before a big order'],
    cost: { money: '325 a tooth at Paddock, 87 at Marion', time: 'a town round trip',
            risk: 'ordinary road risk; Tos is a city and the counter itself is safe',
            estimate: 'rounds x price, plus the trip' },
    scales: 'One `reveal` is 3 teeth, one `identify` is 1. A round of 2 teeth is therefore ' +
            'two identifies or two thirds of a reveal.',
  },

  provenance: {
    pinned: '7a7f3c5',
    verified: '2026-09-12',
    touches: [
      'tools/m59-fleetscript.mjs',    // walk/say/shop/bank/verify
      'tools/m59-broker.mjs',         // shop list + buy, and the inventory read verify uses
      'tools/m59-keeper-process.mjs', // where the shop exchange happens
    ],
    // The say-then-buy order is a fact about the SERVER, not about our code, so drift in our
    // tree does not invalidate it. A warning is the right level.
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who is doing the shopping' },
    seller: { default: 'Paddock', describe: 'the merchant with the conditional listing' },
    room: { type: 'number', default: 52, describe: 'the room the seller stands in (Familiars)' },
    trigger: { default: 'orc teeth', describe: 'the word that makes the row appear — the PLURAL' },
    each: { type: 'number', default: 2, describe: 'teeth per listing (Paddock 2, Marion 4)' },
    price: { type: 'number', default: 650, describe: 'cost of one listing' },
    rounds: { type: 'number', default: 1, describe: 'how many listings to buy' },
    bankRoom: { type: 'number', default: 54, describe: 'First Royal Bank of Tos, for a short purse' },
    carrying: { type: 'number', default: 0, describe: 'shillings already in the pack' },
    home: { type: 'number', required: true, describe: 'the room to return to afterwards' },
  },

  async steps({ seller, room, trigger, each, price, rounds, bankRoom, carrying, home }) {
    const want = Math.max(1, Number(rounds));
    const total = want * Number(price);
    const needsBank = Number(carrying) < total;
    const match = /orc (teeth|tooth)/i;

    return [
      // Fund the whole order in one withdrawal rather than one per round: each bank leg is
      // another walk across a town, and this fleet loses people on town roads.
      ...(needsBank ? [walk(bankRoom), bank('withdraw', total - Number(carrying))] : []),

      walk(room),

      // ONE SAY PER ROUND, NOT ONE FOR THE WHOLE ORDER. `AddToConditionalList` refuses to add
      // an object already on the list (monster.kod:4734-4740), so a second say while the row
      // is still standing is harmless — but a row that has just been BOUGHT is gone, and the
      // next buy needs it put back. Saying it again each round is the cheap way to be right
      // in both cases; the alternative is a purchase that silently buys nothing on round two.
      ...Array.from({ length: want }).flatMap(() => [
        say(trigger, { to: seller }),
        shop(seller, [{ match, amount: each }]),
      ]),

      // RULE 6, AND IT IS NOT DECORATION HERE. The `shop` step already checks the pack grew,
      // but it checks per round and a partly-filled order still reads as success. This asks
      // the only question that matters at the end: are there teeth aboard, and how many.
      verify(async ({ agent, call }) => {
        const inv = await call('inventory', { agent }, 60_000).catch(() => null);
        const teeth = (inv?.items ?? [])
          .filter(i => match.test(String(i.name ?? '')))
          .reduce((n, i) => n + (i.amount || 1), 0);
        return teeth > 0 ? { ok: true, teeth } : { ok: false, why: 'no orc teeth in the pack' };
      }, 'the pack holds orc teeth'),

      walk(home, { always: true }),
    ];
  },
};
