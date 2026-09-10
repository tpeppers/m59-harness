// FOUND A GUILD: withdraw the fee, cross to Barloque, pay Frular, read it back.
//
//   node tools/m59-fleet-repl.mjs run found-guild agent=t18 name="The Second Swines"
//
// PUBLIC. Written for "have Gonzo create The Second Swines", but the errand is general and
// the traps in it are not obvious from outside:
//
//   * THE FEE IS PAID FROM THE PURSE, NOT THE BANK (system.kod:243). A character with the
//     money banked and an empty pocket is refused with `user_no_guild_broke` — a sentence
//     spoken to the room, not an error on the wire, so it reads as success to anything that
//     only checks for a thrown error.
//   * THERE IS NO TELLER IN BARLOQUE. Banking is one system with two counters, Tos (54) and
//     Jasper (376), so the withdrawal is a separate leg of the journey and has to happen
//     BEFORE the crossing rather than on arrival.
//   * A GUILD CANNOT BE RENAMED. Disband and pay again is the only correction, which is why
//     the name and all ten rank titles are validated before anything is sent. Ten, not five:
//     five ranks times two genders, flat, in the order user.kod:1697 reads them — and the
//     wrong ORDER does not error, it gives every woman in the guild a man's title for ever.
//   * FOUNDING NEEDS `PFLAG_PKILL_ENABLE`, which base max health 30 sets. Every character in
//     this fleet is well past it, so it is checked by the server and not here.
//
// AND THE WHOLE GUILD SURFACE WAS UNREACHABLE UNTIL 2026-09-10. Every verb was called on the
// broker's emulated client, which has been a SNAPSHOT since the keeper-process migration, so
// `guild action=create` answered `c.requestGuildInfo is not a function` and founding was
// impossible fleet-wide. The seventeen verbs are now forwarded to the keeper that owns the
// socket; `m59-keeperproxy-test.mjs` is the guard that keeps them forwarded.
import { walk, bank, foundGuild, verify } from '../m59-fleetscript.mjs';

const TOS_BANK = 54;          // a teller. Jasper (376) is the other one.
const GUILDMASTER_HALL = 700; // Frular, in Barloque.
const PRICE = 5000;

export const script = {
  name: 'found-guild',
  provenance: {
    pinned: 'HEAD', verified: '2026-09-10',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs',
              'tools/m59-keeper-process.mjs', 'tools/m59-guild.mjs'],
  },
  describe: 'Found a named guild: withdraw the fee, travel to Frular, pay, verify.',
  recipe: {
    effect: 'Creates a guild with the named character as its master. Verified by reading the ' +
            'roster back off the world, never from the absence of an error — the entire ' +
            'guild command space refuses in TOTAL SILENCE (user.kod:4848).',
    run: 'found-guild agent=<slot> name="<guild name>" [withdraw=<n>] [secret=true]',
    needs: ['5,000 shillings IN THE PURSE at the moment of founding',
            'the character not already in a guild — renounce or disband first',
            'a route to 700; the fee is withdrawn at Tos (54) because Barloque has no teller'],
    cost: { time: '5-20 minutes, nearly all of it road',
            money: `${PRICE} shillings, non-refundable and unrenameable`,
            risk: 'the roads are what kills this fleet; the money is on the character for ' +
                  'the whole crossing and is lost with it on death' },
    scales: 'One character. Inducting the rest is a different operation — `guild ' +
            'action=spread`, which walks nobody and costs no travel.',
  },

  // A guild is founded once and cannot be renamed, so this refuses rather than guesses.
  args: {
    agent: { required: true, why: 'which character becomes the guild master' },
    name:  { required: true, why: 'the guild name — permanent, and it cannot be renamed' },
  },

  steps: (a) => [
    // THE MONEY FIRST, AND MORE THAN THE PRICE. Arriving at Frular a hundred short means
    // paying for the whole crossing twice. The banker names the balance when it refuses and
    // the `bank` step takes what it named, so asking high is free.
    walk(TOS_BANK, { why: 'the fee comes from the purse and Barloque has no teller' }),
    bank('withdraw', Number(a.withdraw ?? PRICE + 1000),
         { why: 'founding is paid from what the character is CARRYING (system.kod:243)' }),

    verify(async ({ call, agent }) => {
      const inv = await call('inventory', { agent }, 45_000).catch(() => null);
      const purse = (inv?.items ?? [])
        .filter(o => /shilling/i.test(o.name ?? ''))
        .reduce((t, o) => t + (o.amount || 1), 0);
      return purse >= PRICE;
    }, `carrying at least ${PRICE} before setting out — a short purse is refused by a ` +
       'sentence, not an error, and only after the whole crossing has been paid for'),

    walk(GUILDMASTER_HALL, { why: 'Frular only founds guilds in his own hall' }),

    foundGuild(a.name, { price: PRICE, ...(a.secret ? { secret: true } : {}) }),
  ],
};
