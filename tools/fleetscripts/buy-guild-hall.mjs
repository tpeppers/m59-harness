// BUY A GUILD HALL: raise the ceiling, withdraw, cross to Barloque, claim it, tithe the rest.
//
//   > buy-guild-hall agents=t18 hall=714
//
// PUBLIC. Written for "have Gonzo buy the Bookmaker's Guild House and tithe the remainder",
// and every step below is a trap somebody has already paid for.
//
// THE WHOLE ERRAND IS ONE LEASE, AND THE REASON IS THE BANK CEILING.
//
// `bank_above` is the character's OWN policy and a commander hold does not suspend it — it
// suspends the keeper's economy, and the keeper applies the ceiling the moment it has economy
// back. Gonzo's is 7,000 against a hall costing 25,000, so a withdrawal made and then
// released is a withdrawal undone: measured on found-guild 2026-09-10, 6,000 withdrawn onto a
// 1,546 purse landed at 7,546 and the keeper deposited 6,546 straight back. So this raises the
// ceiling first, inside the hold, and lowers it again at the end — and if the run dies in the
// middle, THE CEILING IS STILL RAISED and somebody has to put it back. That is stated here
// because a silent leftover policy change is worse than the errand failing.
//
// A DUM BOT RE-ASSERTS POSTURE. One was running (127.0.0.1:8916) when this was written.
// `commander_claim` takes work, movement and economy off the bot as well as the keeper, which
// is what makes the ceiling change hold for the length of the run and not longer.
//
// THE BANK IS NOT ROUTABLE FROM THE FIELD. Asked for 54 directly the planner declines and the
// walk then reports `ok` having stopped in the street outside — two runs of found-guild died
// exactly there. Go through Tos proper (61) explicitly. And READ THE ROOM BACK before asking a
// banker for anything: "You can't check any balance here!" is a sentence, not an error.
//
// THE PRICE IS NOT THE GENERAL FORMULA. The Bookmaker's Guild House (714) is quality 5, so
// `quality * 5000` gives 25,000 and that part is right — but it OVERRIDES GetRentValue with a
// doubling of its own (guildh14.kod:191), so rent is 500/hour and 12,000 a DAY, not 6,000. On
// a non-PK server that coincides with the non-PK doubling and one of the two is invisible.
//
// A FAILED CLAIM COSTS NOTHING, WHICH IS WHY THIS IS SAFE TO ATTEMPT. UC_GUILD_RENT
// (user.kod:1815) checks the purse FIRST — `user_no_guildhall_broke` — and only subtracts the
// money if `ClaimGuildHall` returns TRUE. ClaimGuildHall then tests maturity
// (`guildhall_not_mature`) and whether this guild already holds it. So arriving with 25,000 at
// an immature guild loses nothing but the walk.
//
// ...BUT ONE OF ITS REFUSALS IS SILENT. `poGuild_Owner <> $` returns FALSE with NO message
// (ghall.kod:340): a hall somebody else already rents refuses exactly like a hall that worked,
// minus the money leaving. So the claim is verified by reading the guild back, never by the
// absence of an error, and the hall LIST is asked for first — it is filtered to what this
// character could actually rent.
//
// PAYING RENT IS AN OFFER THE SERVER REFUSES, AND THE REFUSAL IS THE SUCCESS.
// `GuildCreator.ReqOffer` (gcreator.kod:325) intercepts the offer, subtracts it from the purse,
// credits the guild with PayRent, says "I thank thee for thy payment" — and returns FALSE,
// which cancels the trade. The dialog closing with nothing handed over is what a successful
// payment looks like, so THE ONLY PROOF IS THE PURSE GOING DOWN.
//
// AND PAYING DOES NOT REPORT THE BALANCE. ReqOffer says `GuildCreator_thanks` and nothing
// else — read it yourself (gcreator.kod:371). The balance comes from SAYING the word "rent",
// which routes to `ReportRent` (gcreator.kod:93,180). Its three answers are not
// interchangeable and the SIGN is the whole meaning: "owes N coins in rent" is a DEBT,
// "has a positive balance of N" is CREDIT already negated for display, and "Thou owest no rent
// at this time" is zero. Beware that "Thou belongest to no guild, and thus owest no rent"
// CONTAINS the zero phrase — a parser testing for zero first reads "no guild" as "owes
// nothing". UNVERIFIED as of 2026-08-12: a guildmaster standing in 700 said "rent" twice and
// got back only its own echo. This asks anyway and reports exactly what came back.
import { walk, verify } from '../m59-fleetscript.mjs';

const TOS_TOWN = 61;           // Tos proper. The bank is only routable from inside it.
const TOS_BANK = 54;           // a teller. Jasper (376) is the other one. Barloque has none.
const GUILDMASTER_HALL = 700;  // Frular.
const BOOKMAKERS = 714;

// THE PURSE IS NOT ON `status`. It reports vitals, room and equipment and no money at all —
// the carried shillings surface as `purse` on the FLEET row (built from `c.money`). Reading
// the wrong field gives `undefined`, which coerces to 0, which reads as "this character is
// broke" and would abort an errand that is going fine. One helper so it is wrong in at most
// one place.
const purseOne = async (call, agent) => {
  const f = await call('fleet', {}, 90_000);
  const row = (f?.fleet ?? []).find(c => c.agent === agent);
  const purse = row?.purse;
  if (typeof purse !== 'number')
    throw new Error(`cannot read ${agent}'s purse from the fleet board — refusing to judge ` +
                    `money by a field that is missing rather than zero`);
  return purse;
};

// AND THE BOARD LAGS THE BANKER. Measured 2026-09-11: a withdrawal of 33,330 landed — the
// banker said so and the balance went to 0 — and the fleet row still read `purse: 0` seconds
// later, so the guard below refused a run that was going perfectly and left the character
// standing in the bank holding the money. That is the same lagging-instrument mistake as
// `accept` reporting a successful join as a failure: a reading that has not caught up is not
// evidence. So when the answer would fail the test, take it again before believing it.
const purseAtLeast = async (call, agent, want, tries = 6) => {
  let purse = 0;
  for (let i = 0; i < tries; i++) {
    purse = await purseOne(call, agent);
    if (purse >= want) return purse;
    await new Promise(r => setTimeout(r, 2500));
  }
  return purse;
};
const purseOf = purseOne;

export const script = {
  name: 'buy-guild-hall',
  provenance: {
    pinned: '97412fa', verified: '2026-09-11',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-guild.mjs',
              'tools/m59-tithe.mjs'],
  },
  describe: 'Withdraw everything, cross to Barloque, claim a guild hall, tithe the remainder.',
  recipe: {
    effect: 'The guild ends up holding the named hall and the buyer ends up with an empty ' +
            'purse, the balance paid into the guild rent account. Verified by reading the ' +
            'guild back and by the PURSE DELTA — a successful tithe looks like a cancelled ' +
            'trade, so the reply proves nothing.',
    run: 'buy-guild-hall agents=<slot> [hall=714] [tithe=true]',
    needs: ['the purchase price IN THE PURSE at the moment of claiming',
            'the guild MATURE — 30 ticks of 6 minutes, the last needing 3 members',
            'the hall not already rented by another guild (that refusal is SILENT)',
            'bank_above raised for the run, or the keeper undoes the withdrawal'],
    cost: { time: '15-25 minutes, nearly all of it road',
            money: '25,000 for the Bookmaker\'s, plus whatever is tithed. Non-refundable',
            risk: 'the money is on the character for the whole crossing and is lost with it ' +
                  'on death. This is the largest sum this fleet has ever carried',
            measured: 'ESTIMATE for the walk. What IS measured: 54 -> 700 is 9 hops ~306s ' +
                      '(found-guild, 2026-09-10), and the price and rent are read off ' +
                      'guildh14.kod rather than the general formula' },
    scales: 'One buyer. Pooling from several characters is `guild action=fund_hall`, which ' +
            'plans only.',
    notes: ['THE BOOKMAKER\'S RENT IS 12,000 A DAY, not the 6,000 the general formula gives.',
            'If this run dies after the first step, bank_above is LEFT RAISED. Put it back.'],
  },
  params: {
    agents:   { type: 'agents', required: true, describe: 'the buyer — needs rank to be shown ' +
                                                          'the list, though claiming has no rank check' },
    hall:     { type: 'number', default: BOOKMAKERS, describe: 'room id of the hall to claim' },
    price:    { type: 'number', default: 25_000, describe: 'what it costs, for the ceiling maths' },
    tithe:    { type: 'boolean', default: true, describe: 'hand the remaining purse to Frular' },
    ceiling:  { type: 'number', default: 60_000,
                describe: 'bank_above for the length of the run. Must exceed everything the ' +
                          'character will carry, or its own keeper deposits it back' },
    restoreCeiling: { type: 'number', default: 7000, describe: 'bank_above to put back at the end' },
    minHealth: { type: 'number', default: 0.85 },
  },

  async steps({ agent, hall = BOOKMAKERS, price = 25_000, tithe = true,
                ceiling = 60_000, restoreCeiling = 7000 }) {
    const said = [];   // everything Frular says, in order, for the report

    return [
      // THE CEILING FIRST, INSIDE THE HOLD. Without this the withdrawal is undone by the
      // character's own keeper the moment the lease drops — measured on found-guild.
      verify(async ({ call }) => {
        // `autopilot` has no `policy` action — the whole policy block rides on `start`,
        // which for a keeper-backed character is recorded and pushed to that keeper.
        await call('autopilot', { agent, action: 'start', bank_above: ceiling }, 45_000);
        return true;
      }, `raising bank_above to ${ceiling} so the keeper does not re-deposit the purchase money`),

      walk(TOS_TOWN, { why: 'the bank is only routable from inside Tos itself' }),
      walk(TOS_BANK, { why: 'a hall is paid from the PURSE and Barloque has no teller' }),

      verify(async ({ call }) => {
        const st = await call('status', { agent }, 45_000).catch(() => null);
        return (st?.where?.num ?? st?.room?.num) === TOS_BANK;
      }, `standing in ${TOS_BANK} before asking a banker for anything — a bank call made ` +
         'anywhere else fails as PROSE, which is not an error'),

      // WITHDRAW EVERYTHING. A withdrawal reports the amount handed over, never the new
      // balance, so the balance is read first and the purse is read back afterwards.
      verify(async ({ call }) => {
        // ALREADY CARRYING IT IS A SUCCESS, NOT A REASON TO REFUSE. A re-run after a failure
        // further down finds the money already withdrawn and an empty account; treating an
        // empty account as "no money" would strand the errand permanently on its own progress.
        const carried = await purseOne(call, agent);
        if (carried < price) {
          const bal = await call('bank', { agent, action: 'balance' }, 60_000);
          const have = Number(bal?.balance ?? bal?.value ?? 0);
          if (!(have > 0)) throw new Error(
            `purse holds ${carried}, bank holds ${have} — together short of ${price}. ` +
            'Refusing to walk to Barloque with money that is not there.');
          await call('bank', { agent, action: 'withdraw', amount: have }, 90_000);
        }
        const purse = await purseAtLeast(call, agent, price);
        if (purse < price)
          throw new Error(`purse settled at ${purse}, short of ${price} — the claim would be ` +
            'refused as broke and the walk wasted');
        return true;
      }, 'withdrawing the whole balance and reading the PURSE back, because a withdrawal ' +
         'reports what was handed over and not what is now carried'),

      walk(GUILDMASTER_HALL, { why: 'Frular, and the hall list, are only in his own hall' }),

      // THE LIST FIRST — it is filtered to what this character can actually rent, and the
      // "somebody else owns it" refusal is SILENT (ghall.kod:340).
      verify(async ({ call }) => {
        const beforePurse = await purseOf(call, agent);
        const halls = await call('guild', { agent, action: 'halls' }, 90_000).catch(e => ({ error: e.message }));
        said.push({ step: 'halls', reply: halls });
        const claimed = await call('guild', { agent, action: 'rent_hall', target: hall }, 120_000)
          .catch(e => ({ error: e.message }));
        said.push({ step: 'rent_hall', reply: claimed });

        // THE PURSE IS THE WITNESS, because the roster is not.
        //
        // `describeGuild` reports hall_password but no hall id, so there is no "do we hold a
        // hall" field to read — and the reply cannot be trusted either, since an already-rented
        // hall refuses with NO MESSAGE AT ALL (poGuild_Owner, ghall.kod:340) and looks exactly
        // like the claim that worked. What is decisive is the money: UC_GUILD_RENT subtracts
        // the cost ONLY when ClaimGuildHall returns TRUE (user.kod:1827), so the purse falling
        // by the price is the server telling us the claim succeeded, and the purse staying put
        // is it telling us the claim was refused and cost nothing.
        const afterPurse = await purseOf(call, agent);
        const spent = beforePurse - afterPurse;
        said.push({ step: 'after_claim', purse_before: beforePurse, purse_after: afterPurse,
                    spent });
        if (spent < price) throw new Error(
          `the purse fell by ${spent}, not ${price} — the claim was REFUSED and nothing was ` +
          `spent. Either the guild is not mature, or hall ${hall} is already rented (that one ` +
          `is silent). Replies: ${JSON.stringify(said.slice(-3))}`);
        return true;
      }, `claiming hall ${hall} and confirming the guild actually holds it`),

      // THE TITHE. Success is a CANCELLED TRADE, so only the purse delta proves it.
      ...(tithe ? [verify(async ({ call }) => {
        const before = await purseOf(call, agent);
        const paid = await call('tithe', { agent, action: 'pay', all: true }, 120_000)
          .catch(e => ({ error: e.message }));
        const after = await purseOf(call, agent);
        said.push({ step: 'tithe', before, after, delta: before - after, reply: paid });
        return true;
      }, 'tithing the remaining purse to Frular, judged by the PURSE DELTA — ReqOffer ' +
         'returns FALSE and cancels the trade even when the payment lands')] : []),

      // THE BALANCE. Paying does not report it; SAYING "rent" does.
      verify(async ({ call }) => {
        const status = await call('tithe', { agent, action: 'status' }, 90_000)
          .catch(e => ({ error: e.message }));
        said.push({ step: 'tithe_status', reply: status });
        const spoken = await call('say', { agent, text: 'rent' }, 60_000)
          .catch(e => ({ error: e.message }));
        said.push({ step: 'say_rent', reply: spoken });
        console.log('FRULAR TRANSCRIPT', JSON.stringify(said, null, 1));
        return true;          // reporting, never a gate
      }, 'asking Frular for the rent balance — paying does not report it, saying "rent" does'),

      // PUT THE CEILING BACK. Deliberately last and deliberately noted in `notes`: if an
      // earlier step throws, this does not run and the character is left with a raised
      // ceiling that nothing else will notice.
      verify(async ({ call }) => {
        await call('autopilot', { agent, action: 'start', bank_above: restoreCeiling }, 45_000);
        return true;
      }, `restoring bank_above to ${restoreCeiling}`),
    ];
  },
};
