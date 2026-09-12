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
// that genuinely does not have the row.
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
//
// ---------------------------------------------------------------- ONE SAY, ONE BUY
//
// THE `x2` ON THE SHELF IS A LABEL, NOT A LIMIT, AND PADDOCK NEVER RUNS OUT.
//
// The listing reads `orc tooth, cost 650, amount 2` because the object registered against the
// trigger was created with `#number=2`. The first version of this file read that as the unit
// of sale, bought two at a time in a loop, and then reported the merchant "dry at six teeth"
// when a round came back empty. Both halves were wrong, and the operator corrected them:
//
//   * YOU CAN BUY AS MANY AS YOU CAN PAY FOR. Measured 2026-09-12 with Loial at the counter:
//     asked for 20 in ONE call, got 19, purse 12,400 -> 50. Nineteen teeth, one transaction,
//     no repetition. The shelf quantity clamped nothing.
//   * 650 IS THE PRICE PER TOOTH. 12,350 for 19 is exactly 650 each, not 650 for a pair. The
//     old default under-funded every order by half.
//
// The empty round was the PURSE, and the reply said so under `clamped.limited_by` while this
// script threw it away. m59-fleetscript.mjs's `shop` step now names that cause in its own
// failure sentence instead of saying "nothing entered the pack" for both cases. Its own
// comment had already warned that a listed quantity is not stock; I did not read it.
//
// So: one `say`, one `shop` line for the whole order, and let the broker clamp it.
//
// ONE TRAP THAT IS NOT ABOUT THIS MERCHANT. A keeper banks its surplus down to
// `walking_money` (default 400), so a character that withdraws and then walks to the counter
// can arrive holding 400 shillings and no explanation. Inside this script that cannot happen —
// the errand holds `economy` under the lease for its whole length — but it is what defeated
// two hand-driven attempts before this was written, and `bank_above: null` does NOT prevent
// it. Raise `walking_money` first if you are doing this by hand.
import { walk, bank, shop, say, verify } from '../m59-fleetscript.mjs';

export const script = {
  name: 'buy-orc-teeth',
  describe: 'Buy orc teeth from a merchant who only lists them after you say the word.',
  recipe: {
    effect: 'Walks to Paddock in Familiars (52), says "orc teeth" to make him list them, buys ' +
            'the whole order in one transaction, and proves the pack actually grew. Withdraws ' +
            'first when the purse is short.',
    run: 'buy-orc-teeth agents=hk1 teeth=20 home=52',
    needs: ['the money — 650 PER TOOTH at Paddock, and the bank leg covers a short purse',
            'pack room: teeth are light, but a caster full of pork answers receiver_full to ' +
              'everything, so shed before a big order'],
    cost: { money: '650 a tooth at Paddock, ~88 at Marion', time: 'a town round trip',
            risk: 'ordinary road risk; Tos is a city and the counter itself is safe',
            measured: '19 teeth for 12,350 in one transaction, 2026-09-12' },
    scales: 'One `reveal` is 3 teeth, one `identify` is 1. The merchant does not run out, so ' +
            'the only ceiling is the purse — and the bank leg raises that.',
  },

  provenance: {
    pinned: '26e287f',
    verified: '2026-09-12',
    touches: [
      'tools/m59-fleetscript.mjs',    // walk/say/shop/bank/verify, and the clamp reporting
      'tools/m59-broker.mjs',         // shop list + buy, and the inventory read verify uses
      'tools/m59-keeper-process.mjs', // where the shop exchange happens
    ],
    // The say-then-buy order and the per-tooth price are facts about the SERVER, not about our
    // code, so drift in our tree does not invalidate them. A warning is the right level.
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who is doing the shopping' },
    seller: { default: 'Paddock', describe: 'the merchant with the conditional listing' },
    room: { type: 'number', default: 52, describe: 'the room the seller stands in (Familiars)' },
    trigger: { default: 'orc teeth', describe: 'the word that makes the row appear — the PLURAL' },
    // THE ORDER IS IN TEETH, because that is the unit the caller thinks in and the unit the
    // spells burn. `each`/`rounds` used to be the interface and encoded the shelf label as a
    // batch size, which is the misreading this script was rewritten to remove.
    teeth: { type: 'number', default: 20, describe: 'how many teeth to buy, in one transaction' },
    price: { type: 'number', default: 650, describe: 'cost PER TOOTH (Paddock 650, Marion ~88)' },
    bankRoom: { type: 'number', default: 54, describe: 'First Royal Bank of Tos, for a short purse' },
    carrying: { type: 'number', default: 0, describe: 'shillings already in the pack' },
    home: { type: 'number', required: true, describe: 'the room to return to afterwards' },
  },

  async steps({ seller, room, trigger, teeth, price, bankRoom, carrying, home }) {
    const want = Math.max(1, Math.floor(Number(teeth)));
    const total = want * Number(price);
    const needsBank = Number(carrying) < total;
    const match = /orc (teeth|tooth)/i;

    return [
      // Fund the WHOLE order in one withdrawal. Each bank leg is another walk across a town,
      // and this fleet loses people on town roads.
      ...(needsBank ? [walk(bankRoom), bank('withdraw', total - Number(carrying))] : []),

      walk(room),

      // One say to put the row on the shelf, one buy for the entire order. `AddToConditionalList`
      // refuses to add an object already listed (monster.kod:4734-4740), so saying it again when
      // it is already there is harmless — but it is also unnecessary, which is the point.
      say(trigger, { to: seller }),
      shop(seller, [{ match, amount: want }]),

      // RULE 6. The `shop` step checks the pack grew; this says by how much, because a clamped
      // order is the ordinary outcome of a thin purse and the caller needs the number rather
      // than a boolean. A short delivery is NOT a failure here — the teeth that arrived are real.
      verify(async ({ agent, call }) => {
        const inv = await call('inventory', { agent }, 60_000).catch(() => null);
        const got = (inv?.items ?? [])
          .filter(i => match.test(String(i.name ?? '')))
          .reduce((n, i) => n + (i.amount || 1), 0);
        return got > 0
          ? { ok: true, teeth: got, asked: want }
          : { ok: false, why: 'no orc teeth in the pack after buying. The shop step above names ' +
                              'whether the purse, the weight or the bulk cut the order — if it ' +
                              'says none of them did, the trigger word did not land and the row ' +
                              'was never on the shelf' };
      }, 'the pack holds orc teeth'),

      // ALWAYS. Whatever went wrong upstream, the character does not get left standing in a
      // town it did not start in — that is how this fleet loses people, and it is what left a
      // courier in a Tos bar on 2026-09-12 after an errand that had actually worked.
      walk(home, { always: true }),
    ];
  },
};
