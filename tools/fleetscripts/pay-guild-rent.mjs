// PUT SHILLINGS ON THE GUILD'S RENT ACCOUNT, FROM THE BANK.
//
// PUBLIC. The Bookmaker's hall costs 12,000 a day (guildh14.kod:191 — quality 5, rent doubled)
// and Frular evicts a guild that falls behind. The money is in the bank and the rent is paid
// in Barloque, so this is a three-town errand: Tos for the teller, Barloque for Frular.
//
// THE THREE THINGS THAT MAKE THIS A SCRIPT RATHER THAN THREE TOOL CALLS.
//
// 1. `bank_above` IS THE CHARACTER'S OWN POLICY AND A COMMANDER HOLD DOES NOT SUSPEND IT.
//    Withdraw 35,000 onto a character that banks anything over 7,000 and its keeper deposits
//    34,600 straight back the moment the lease drops — measured on found-guild. So the ceiling
//    is raised INSIDE the hold and put back at the end. `autopilot` has no `policy` action:
//    the whole policy block rides on `start`.
//
// 2. THE BANK IS TWO HOPS. The planner will not route to room 54 from the field; it reports
//    success having stopped in the street outside. Walk to Tos proper first, then the bank.
//
// 3. PAYING IS A CANCELLED TRADE. `GuildCreator.ReqOffer` (gcreator.kod:325) takes the money,
//    credits the guild, says "I thank thee for thy payment" and then returns FALSE — so the
//    offer dialog closing with nothing handed over is exactly what SUCCESS looks like, and the
//    only proof is the purse going down. Every judgement here is a purse delta.
//
// AND THE BALANCE IS NOT REPORTED BY PAYING. Frular tells you what is owed only when you SAY
// "rent" to him, from inside SAY_RADIUS — which is why the last step asks rather than assumes.
import { walk, verify } from '../m59-fleetscript.mjs';

const TOS_TOWN = 61;           // Tos proper. The bank is only routable from inside it.
const TOS_BANK = 54;           // a teller. Jasper (376) is the other one. Barloque has none.
const GUILDMASTER_HALL = 700;  // Frular.

// THE PURSE IS NOT ON `status`. It reports vitals, room and equipment and no money at all —
// carried shillings surface as `purse` on the FLEET row. Reading the wrong field gives
// undefined, which coerces to 0, which reads as "this character is broke" and would abort an
// errand that is going fine.
const purseOne = async (call, agent) => {
  const f = await call('fleet', {}, 90_000);
  const row = (f?.fleet ?? []).find(c => c.agent === agent);
  const purse = row?.purse;
  if (typeof purse !== 'number')
    throw new Error(`cannot read ${agent}'s purse from the fleet board — refusing to judge ` +
                    'money by a field that is missing rather than zero');
  return purse;
};

// AND THE BOARD LAGS THE BANKER. Measured 2026-09-11: a withdrawal of 33,330 landed and the
// fleet row still read `purse: 0` seconds later, refusing a run that was going perfectly. A
// reading that has not caught up is not evidence, so take it again before believing it.
const purseAtLeast = async (call, agent, want, tries = 6) => {
  let purse = 0;
  for (let i = 0; i < tries; i++) {
    purse = await purseOne(call, agent);
    if (purse >= want) return purse;
    await new Promise(r => setTimeout(r, 2500));
  }
  return purse;
};

export const script = {
  name: 'pay-guild-rent',
  provenance: {
    pinned: '5c5bc98', verified: '2026-09-12',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-tithe.mjs'],
  },
  describe: 'Withdraw shillings and put them on the guild rent account, judged by purse delta.',
  recipe: {
    effect: 'Moves money from a character\'s BANK to the guild\'s rent credit. Nothing else ' +
            'here pays rent: the fleet tithes from sale proceeds in dribs, and a hall that ' +
            'falls behind is repossessed.',
    run: 'pay-guild-rent agents=<a,b> amount=35000',
    needs: ['the amount actually in the bank — the account is read before the withdrawal',
            'bank_above raised for the run, which this does, or the keeper undoes the ' +
            'withdrawal the moment the lease drops',
            'guild membership; Frular answers a non-member "thou owest not any guild rent"'],
    cost: { time: '5-20 minutes a character — Tos for the teller, then the road to Barloque',
            risk: 'the road, and it is carried in CASH. A character killed between the bank ' +
                  'and Frular drops the lot where it fell',
            measured: '2026-09-12 — rent stood at 6,547 owed before this ran' },
    scales: 'Per character, and they are independent: two characters paying 35,000 each is ' +
            'two errands, not a bigger one. The guild credit is shared.',
    notes: ['Paying does NOT report the balance. Frular states it only when you say "rent", ' +
            'and only from inside SAY_RADIUS — so the closing step asks.',
            'IF THIS RUN DIES AFTER THE FIRST STEP, bank_above IS LEFT RAISED. Nothing else ' +
            'notices. Put it back: autopilot action=start bank_above=7000.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who pays' },
    amount: { type: 'number', default: 35_000, describe: 'shillings to put on the rent account' },
    ceiling: { type: 'number', default: 60_000,
               describe: 'bank_above for the length of the run. Must exceed what is carried, ' +
                         'or the character\'s own keeper banks it back' },
    restoreCeiling: { type: 'number', default: 7000, describe: 'bank_above to put back at the end' },
    minHealth: { type: 'number', default: 0.85 },
  },

  async steps({ agent, amount = 35_000, ceiling = 60_000, restoreCeiling = 7000 }) {
    const said = [];

    return [
      // THE CEILING FIRST, INSIDE THE HOLD.
      verify(async ({ call }) => {
        await call('autopilot', { agent, action: 'start', bank_above: ceiling }, 45_000);
        return true;
      }, `raising bank_above to ${ceiling} so the keeper does not re-deposit the rent money`),

      walk(TOS_TOWN, { why: 'the bank is only routable from inside Tos itself' }),
      walk(TOS_BANK, { why: 'rent is paid from the PURSE and Barloque has no teller' }),

      // ARRIVING IS A SEPARATE OBSERVATION FROM BEING SENT. A bank call made anywhere else
      // fails as PROSE — "You can't check any balance here!" — which is not an error.
      verify(async ({ call }) => {
        const st = await call('status', { agent }, 45_000).catch(() => null);
        return (st?.where?.num ?? st?.room?.num) === TOS_BANK;
      }, `standing in room ${TOS_BANK} before asking a banker for anything`),

      // THE WITHDRAWAL, SIZED TO WHAT IS THERE AND READ BACK OFF THE PURSE.
      verify(async ({ call }) => {
        const carried = await purseOne(call, agent);
        if (carried < amount) {
          // ALREADY CARRYING IT IS A SUCCESS, NOT A REASON TO REFUSE — a re-run after a
          // failure further down finds the money already withdrawn and an empty account.
          const bal = await call('bank', { agent, action: 'balance' }, 60_000)
            .catch(e => ({ error: e.message }));
          const have = Number(bal?.balance ?? bal?.value ?? 0);
          said.push({ step: 'balance', carried, banked: have, reply: bal });
          const short = amount - carried;
          if (have < short) throw new Error(
            `purse holds ${carried} and the bank holds ${have} — together short of ${amount}. ` +
            'Refusing to carry cash to Barloque for a payment that cannot be made.');
          // A withdrawal reports the amount HANDED OVER, never the new balance.
          await call('bank', { agent, action: 'withdraw', amount: short }, 90_000);
        }
        const purse = await purseAtLeast(call, agent, amount);
        said.push({ step: 'withdrawn', purse });
        if (purse < amount) throw new Error(
          `purse settled at ${purse}, short of ${amount} — the walk to Barloque would carry ` +
          'less than the payment being attempted');
        return true;
      }, `withdrawing up to ${amount} and reading the PURSE back, because a withdrawal ` +
         'reports what was handed over and not what is now carried'),

      walk(GUILDMASTER_HALL, { why: 'Frular takes guild rent only in his own hall' }),

      // THE PAYMENT. Success is a CANCELLED TRADE, so the purse delta is the only witness.
      verify(async ({ call }) => {
        const before = await purseOne(call, agent);
        const paid = await call('tithe', { agent, action: 'pay', amount }, 120_000)
          .catch(e => ({ error: e.message }));
        const after = await purseOne(call, agent);
        const delta = before - after;
        said.push({ step: 'pay', before, after, delta, reply: paid });
        if (delta <= 0) throw new Error(
          `the purse did not move, so nothing was paid whatever was said. Frular refuses with ` +
          `"Thou owest not any guild rent" (no guild), "Thou hast not N shillings to give me!" ` +
          `(over the purse) or "Thou canst pay thy rent only with shillings!". ` +
          `Replies: ${JSON.stringify(said.slice(-2))}`);
        return true;
      }, `handing ${amount} to Frular and judging it by the PURSE DELTA`),

      // THE BALANCE. Paying does not report it; saying "rent" does, from inside earshot.
      verify(async ({ call }) => {
        const status = await call('tithe', { agent, action: 'status' }, 120_000)
          .catch(e => ({ error: e.message }));
        said.push({ step: 'rent_after', reply: status });
        console.log('RENT TRANSCRIPT', agent, JSON.stringify(said, null, 1));
        return true;          // reporting, never a gate
      }, 'asking Frular what the guild owes now — paying does not report it'),

      // PUT THE CEILING BACK. Last, and noted in `notes`: if an earlier step throws this does
      // not run and the character is left carrying a raised ceiling nothing else will notice.
      verify(async ({ call }) => {
        await call('autopilot', { agent, action: 'start', bank_above: restoreCeiling }, 45_000);
        return true;
      }, `restoring bank_above to ${restoreCeiling}`),
    ];
  },
};
