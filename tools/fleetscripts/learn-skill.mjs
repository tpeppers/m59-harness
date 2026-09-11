// BUY ONE SKILL FROM THE TEACHER WHO SELLS IT, AND PROVE THE CHARACTER GOT IT.
//
// PUBLIC. This is the `--learn` half of m59-outfit.mjs, rewritten as a declaration — and it
// exists because that script broke in three separate places on 2026-09-07 and every one of
// them is a guarantee this file gets for free.
//
// WHAT WENT WRONG THERE, because it is the whole argument for this rewrite:
//
//   * ROUTE. Under the keeper-process session driver the World lives in the KEEPER and the
//     broker holds a snapshot, so `map` began answering
//     `route: {found: null, reason: "...a snapshot, not a World"}`. The script tested
//     `if (rt?.route?.found)`, read "I cannot answer" as "there is no route", and reported
//     "no teacher of punch reachable" about a stationary merchant it had just looked up.
//     Here there is no reachability pre-check at all: `walk` asks the keeper, which has the
//     World, and a walk that cannot happen fails as a walk instead of as a phantom refusal.
//
//   * WAITS. A 30-second RPC timeout was applied to a journey that takes minutes, so a walk
//     that was going fine was recorded "travel refused" — and then RE-ISSUED, twice, into a
//     journey already in flight. Guarantees 4 and 5: budgets come from the journey's own p90
//     and travel is issued once per attempt, never re-issued while walking.
//
//   * VERIFICATION. It checked once, 1.2s after the counter. A skill purchase is SILENT on
//     both paths — monster.kod:3865 adds it and says nothing, while every refusal above it
//     speaks — so the skill list is the only evidence there is, and asking once races it.
//
// AND THE ONE THING NOT FIXED HERE, stated plainly because it costs money: on 2026-09-07 a
// character standing with Rook, with punch in the live shop list at 500, was charged exactly
// 500 and never received the skill — confirmed over 100s of polling. That is unresolved and
// it is NOT a bug in the script. The `verify` step below is what turns it from "the errand
// says it worked" into "the errand says the purse moved and the skill did not", which is the
// difference between noticing it once and paying for it twenty-one times.
import { walk, learn, bank, verify } from '../m59-fleetscript.mjs';

export const script = {
  name: 'learn-skill',
  describe: 'Walk to a teacher, buy one skill, and verify the character actually holds it.',
  recipe: {
    effect: 'Buys ONE named ability from a named teacher and proves the character came away ' +
            'holding it. Crosses the world, withdraws the money if the purse is short, and ' +
            'comes home.',
    run: 'learn-skill agents=<a> skill="<name>" teacher=<who> teacherRoom=<room> price=<n> home=<room>',
    needs: ['the exact price and the exact skill name as the teacher lists it',
            'enough banked to cover it — it withdraws when the purse is short',
            'the character must be ALLOWED to learn it: PlayerCanLearn gates level N on the ' +
              'best THREE abilities at level N-1, and a skill you cannot learn is simply ' +
              'ABSENT from the shop list rather than refused'],
    cost: { money: 'the skill price, plus the trip', time: 'a round trip across the world',
            risk: 'ordinary road risk both ways',
            estimate: 'price is per-skill and passed in; the trip is a come-home each way' },
    scales: 'Higher-level spells cost more and gate harder. The gate is the real cost: see ' +
            'master-shalille for what it takes to become ELIGIBLE for the next level.',
  },

  // GUARANTEE 9, ON THE TASK THAT MOTIVATED IT. The keeper-process driver is exactly the
  // kind of change that breaks this errand without breaking anything visible, so the pin
  // names what this was last seen working against and what it would break WITH.
  provenance: {
    pinned: 'dbcc73e',
    verified: '2026-09-07',
    touches: [
      'tools/m59-fleetscript.mjs',   // the steps themselves
      'tools/m59-broker.mjs',        // shop/list, shop/buy, travel, abilities
      'tools/m59-keeper-process.mjs', // where the shop exchange actually happens
      'tools/m59-client.mjs',        // the wire encoding of a buy
    ],
    // Deliberately NOT refusing on drift: a teacher trip is cheap to re-run and an operator
    // who cannot get a character its skill because a comment moved in the broker is worse
    // off than one who reads a warning. The MONEY risk here is the unresolved defect above,
    // which no pin can see.
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who is learning' },
    skill: { required: true, describe: 'the ability to buy, exactly as the teacher lists it' },

    // ROUTE BY ROOM, NEVER BY NAME ALONE. Two merchants can share a name and one of them can
    // be nowhere — see the Fehr'loi Qan note in resupply.mjs. The room is the address.
    teacherRoom: { type: 'number', required: true, describe: 'the room the teacher stands in' },
    teacher: { required: true, describe: 'the teacher at teacherRoom' },

    // Cost is `250 * 2^level` (skill.kod:127-140): 500 at Weaponcraft 1, 1000 at 2, 2000 at
    // 3. Passed in rather than derived so this file holds no ability table to go stale.
    price: { type: 'number', required: true, describe: 'the exact price of the skill' },

    // The bank leg is SKIPPED when the character can already pay, which is most of them.
    // A needless town lap is not free: four characters died on these roads in one night.
    bankRoom: { type: 'number', default: 54, describe: 'bank to withdraw from if short' },
    carrying: { type: 'number', default: 0, describe: 'shillings already in the pack' },

    home: { type: 'number', required: true, describe: 'the room to return to afterwards' },
  },

  async steps({ skill, teacherRoom, teacher, price, bankRoom, carrying, home }) {
    const needsBank = Number(carrying) < Number(price);
    const rx = new RegExp(`^${String(skill).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    return [
      // EXACT FUNDING, and only when short. Withdrawing more than the errand needs means
      // walking a character to a merchant carrying money it did not have to risk.
      ...(needsBank ? [walk(bankRoom), bank('withdraw', Number(price) - Number(carrying))] : []),

      walk(teacherRoom),

      // THE `learn` VERB, NOT `shop`. A shop step is judged on whether the PACK grew, and an
      // ability never enters it -- so the purchase reads as a failure, the verify and the walk
      // home are skipped, and the character is left standing at the teacher. That is not
      // hypothetical: on 2026-09-08 Kermit and Pepe were both stranded in Cor Noth exactly
      // this way, and Scooter's punch looked lost for an hour having actually been bought.
      //
      // `learn` owns the whole exchange -- it knows an ability is invisible on the wire, polls
      // the ability list rather than the pack, and reports 'charged and not delivered' as the
      // distinct outcome it is.
      learn(teacher, skill, { retry: true }),

      // AND CHECK THE LIST ANYWAY. `learn` already polls, so this is belt and braces -- but
      // the failure it guards is the one that costs money: the sale subtracts the price
      // whether or not AddSkill did anything (monster.kod:3866-3874) and says nothing either
      // way, so the ability list is the only evidence a purchase happened at all.
      //
      // BOTH LISTS. `abilities` answers {skills, spells} and this asked only for `skills`, so
      // for a SPELL the answer could never be yes however long it polled. Measured 2026-09-11:
      // Statler bought minor heal at Priestess Xiana, the `learn` step's own poll saw it and
      // reported ok, and this step then declared "charged and never appeared in the skill
      // list" twenty-eight seconds later. It was in his spell list the whole time -- and the
      // sentence this failure prints tells an operator to go and spend the price again. A
      // belt-and-braces check that contradicts the step it is doubling is worse than no check.
      //
      // AND IT LAGS IN MINUTES, NOT SECONDS. The window was fourteen seconds; the Scooter case
      // on 2026-09-08 read `ability: null` for several minutes after a purchase that had
      // plainly worked. A slow yes costs patience, a false no costs the price.
      verify(async ({ agent, call }) => {
        const until = Date.now() + 180_000;
        for (let i = 0; Date.now() < until; i++) {
          await new Promise(r => setTimeout(r, i === 0 ? 1500 : 5000));
          const a = await call('abilities', { agent, kind: 'both', refresh: i > 0 }, 60_000)
                            .catch(() => null);
          if ([...(a?.skills ?? []), ...(a?.spells ?? [])]
                .some(s => rx.test(String(s?.name ?? '')))) return true;
        }
        return false;
      }, `the purse was charged for "${skill}" and it never appeared in the skill or spell ` +
         'list — do NOT retry in a loop, each attempt costs the price again'),

      // ALWAYS. A purchase that fails must still bring the character home; without this the
      // failure strands it wherever the teacher stands.
      { ...walk(home), always: true },
    ];
  },
};
