// TAKE MONEY OUT OF THE BANK, HAND IT TO ANOTHER CHARACTER, EAT, AND GO HOME.
//
// PUBLIC, and the errand this fleet had no verb for. Loial's mastery is funded by shillings
// he does not earn — he is a 20-max-health body parked in an inn on a karma pump, and the
// money has to be carried to him by somebody who farms. Operator, 2026-09-11: "Someone needs
// to pay Loial a good amount of money, to keep funding his mastery."
//
// WHY A SCRIPT RATHER THAN FOUR TOOL CALLS. Every leg of this has bitten this repository:
//
//   the bank      THE PURSE IS THE RECEIPT, NOT THE BANKER'S SENTENCE. `bank` already waits
//                 for the shillings to arrive on the event stream — Loial's own withdrawal at
//                 the Royal Bank of Jasper read 0 for THIRTY SECONDS after Yevitan said
//                 "here are your 2500 shillings". A hand-written version reads the purse
//                 straight after the counter and concludes the withdrawal failed.
//   the hand-over `trade` is a four-step protocol needing both bodies to act, and CLAUDE.md
//                 is explicit that it lies in both directions. `supply` is the one call that
//                 does both sides AND verifies the receiver holds the goods afterwards.
//   the road      Jasper is not Castle Victoria. fleetScript refuses to start any journey
//                 below `minHealth` and treats health it cannot read as a refusal.
//
// WHERE THE MONEY IS. Sweetums banks at the Royal Bank of Jasper (room 376, banker Yevitan),
// and Loial is parked in the Yonder Inn of Jasper (room 370). Same town, which is the whole
// reason this errand is cheap. BARLOQUE HAS NO BANK — the broker's own guild-funding planner
// says so in as many words ("54 Tos or 376 Jasper — NOT Barloque, it has none"), and a
// courier sent to Barloque for money comes back with nothing and no error.
//
// THE BALANCE IS INFERRED, NOT OBSERVED. substrate/banks/<name>.json carries `observed:false`
// on a balance derived as `was - withdrew`, because a withdrawal states the amount handed
// over and never the new total. Sweetums' record said 15,130 on a 19,130 base. That is why
// the default is 14,000 rather than the 15,000 first asked for: the margin is the point, and
// `bank` reporting a short withdrawal is how the record gets corrected.
import { walk, bank, verify, act } from '../m59-fleetscript.mjs';

const JASPER_BANK = 376;      // The Royal Bank of Jasper — Yevitan
const JASPER_INN = 370;       // Yonder Inn of Jasper — where Loial is parked
const FEAST_HALL = 953;       // The Duke's Feast Hall. 951 is Blackstone Keep, which is the
                              // DOOR the door-states file keys — an easy and costly conflation.

export const script = {
  name: 'fund-loial',
  provenance: {
    pinned: '910fc23', verified: '2026-09-11',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-loadout.mjs'],
  },
  describe: 'Withdraw shillings, carry them to another character, restock food, go home.',
  recipe: {
    effect: 'Moves banked money from a farming character into another character\'s purse, ' +
            'reads back that the RECEIVER holds it, then feeds the courier and returns it ' +
            'to its station. The read-back is the point: a hand-over that completes the ' +
            'handshake and moves nothing is the documented failure here.',
    run: 'fund-loial agents=<courier> to=<agent> amount=<shillings>',
    needs: ['the sender to have the money BANKED, at Tos 54 or Jasper 376 — Barloque has none',
            'the receiver to be somewhere the sender can walk to',
            'full health to set out; the roads are what kills this fleet'],
    cost: { time: '5-20 minutes, most of it road',
            risk: 'the courier crosses open country carrying the money. Everything it is ' +
                  'holding drops where it falls, so a death loses the whole withdrawal',
            measured: 'not yet run — this is its first outing' },
    scales: 'One courier, one receiver. Funding several characters is several runs; the ' +
            'broker\'s guild planner exists for the many-holders case.',
    notes: ['The courier is taken off its keeper for the whole errand, so it stops farming.',
            'The feast hall is FREE FOOD on the floor, not a merchant — it is a `loot`, not ' +
            'a `shop`, and it is only there while the feast runs.'],
  },
  params: {
    // NAMED `agents` AND NOT `from`, WHICH IS NOT COSMETIC. The runner takes the agent list
    // from the parameter called exactly that — `asAgents(params.agents)` in m59-fleet-repl.mjs
    // — so a script that names its courier anything else compiles perfectly, prints its whole
    // step list, and runs against NOBODY. The dry run said "0 agent(s)" and every step still
    // rendered, which is precisely the kind of confident-looking nothing this repository keeps
    // being caught by.
    agents: { type: 'agents', required: true, describe: 'the courier, who must have it banked' },
    to: { type: 'string', required: true, describe: 'agent receiving the money' },
    amount: { type: 'number', default: 14000, describe: 'shillings to withdraw and hand over' },
    // Default ON, because the operator asked for the town trip as part of this. Skippable so
    // the errand can be just the money when the feast is not running.
    feast: { type: 'boolean', default: true, describe: 'restock free food at the Feast Hall' },
    // SO A HALF-FINISHED RUN CAN BE FINISHED RATHER THAN REPEATED. The first outing delivered
    // the money and then failed on a broken read, which left the courier fed nothing and
    // standing in an inn. Re-running the whole script to walk it home would have withdrawn a
    // SECOND 14,000. Money already moved stays moved, so the resume has to be expressible.
    fund: { type: 'boolean', default: true, describe: 'do the bank and hand-over legs at all' },
    home: { type: 'number', default: 39, describe: 'where the courier returns to' },
  },
  async steps({ to, amount, feast, home, fund }) {
    // A BOOLEAN PARAMETER CANNOT BE TURNED OFF FROM THE REPL, SO DO NOT TRUST ONE.
    //
    // `parseArgs` in m59-fleet-repl.mjs stores every `k=v` value as a STRING and nothing
    // coerces it afterwards, so `fund=false` arrives as the string "false" — which is truthy.
    // Typing the switch off does exactly nothing and the dry run prints the full step list as
    // though it had worked, which is how I nearly withdrew a second 14,000 to walk a character
    // home. This affects every boolean param in every script here, not just these two.
    //
    // Coerced at the point of use rather than reported and worked around, because a script
    // that silently ignores its own switches is worse than one that never had them.
    const on = v => !(v === false || v === 'false' || v === '0' || v === 'no' || v === 0);
    feast = on(feast); fund = on(fund);
    return [
      ...(fund ? [
      walk(JASPER_BANK),
      bank('withdraw', amount),

      walk(JASPER_INN),

      // THE HAND-OVER, AS A `verify` RATHER THAN AN `act`, AND NOT FOR TIDINESS.
      //
      // `act` freezes its arguments when the step list is built, and the shilling stack does
      // not exist until the withdrawal lands — a stack id resolved before the bank leg names
      // nothing. `verify` is handed `call` at RUN time, so the id is read from the purse that
      // actually arrived. It is also the only step shape that can do the thing and read it
      // back in one place, which is what this particular errand needs: `supply` reports what
      // it believes it handed over, and CLAUDE.md's rule is that a hand-over which completes
      // the handshake and moves nothing is the ordinary failure, not the exotic one.
      verify(async ({ agent, call }) => {
        const inv = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
        const purse = (inv.items || []).filter(i => /shilling/i.test(i.name || ''));
        const held = purse.reduce((n, i) => n + (i.amount || 1), 0);
        if (held < amount) return false;          // the withdrawal did not arrive in full

        // THE PURSE IS READ FROM `inventory`, NEVER FROM `status`.
        //
        // This read `status.gold` and it is ALWAYS NULL — the field exists in the projection
        // and is never populated. The first run of this script therefore handed over 14,000
        // shillings successfully, compared `0 >= 14000`, polled for two minutes and reported
        // `step 3 (verify) failed`. The money was in Loial's purse the whole time; only the
        // instrument was broken, so the errand stopped three steps early and left the courier
        // in an inn instead of feeding it and sending it home.
        //
        // That is this repository's own standing warning — verify the VALUE, not the
        // instrument — committed by the verification step itself, which is the one place it
        // costs the most. Shillings are ordinary inventory objects; `inventory` is where they
        // are, and it is the same call this step already makes for the sender four lines up.
        const purseOfAgent = async (who) => {
          const inv = await call('inventory', { agent: who }, 60_000).catch(() => ({ items: [] }));
          return (inv.items || [])
            .filter(i => /shilling/i.test(i.name || ''))
            .reduce((n, i) => n + (i.amount || 1), 0);
        };
        const had = await purseOfAgent(to);

        const r = await call('supply', {
          from: agent, to,
          what: purse.map(i => ({ id: i.id, amount: Math.min(amount, i.amount || 1) })),
        }, 120_000).catch(e => ({ error: e.message }));
        if (r?.error) return false;

        // READ THE RECEIVER, NOT THE REPLY. Shillings arrive on an event exactly like a bank
        // withdrawal, so the first read can legitimately be of the past — poll rather than
        // conclude, and let the step's own failure be the timeout.
        for (let i = 0; i < 20; i++) {
          if (await purseOfAgent(to) >= had + amount) return true;
          await new Promise(r2 => setTimeout(r2, 1500));
        }
        return false;
      }, `hand ${amount} shillings to ${to} and read it back off the RECEIVER`),
      ] : []),

      // FREE FOOD, WHILE THE FEAST LASTS. Vigor above 80 cannot be rested for and has to be
      // eaten, so this is the only leg that raises the ceiling rather than refilling under it.
      ...(feast ? [walk(FEAST_HALL), act('loot', { only: 'pork', max_items: 12 })] : []),

      walk(home),
    ];
  },
};
