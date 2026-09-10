// FOUND A GUILD: withdraw the fee, cross to Barloque, pay Frular, read it back.
//
//   > found-guild agents=t18              # in tools/m59-fleet-repl.mjs
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
import { walk, carryAtLeast, foundGuild } from '../m59-fleetscript.mjs';

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
    run: 'found-guild agents=<slot> [margin=<n>] — the NAME is a script default, because ' +
         'the REPL does not support quoting and a guild name has spaces in it',
    needs: ['5,000 shillings IN THE PURSE at the moment of founding',
            'the character not already in a guild — renounce or disband first',
            'a route to 700; the fee is withdrawn at Tos (54) because Barloque has no teller',
            'bank_above ABOVE the fee — the keeper re-deposits anything over it, hold or no hold'],
    cost: { time: '5-20 minutes, nearly all of it road',
            money: `${PRICE} shillings, non-refundable and unrenameable`,
            risk: 'the roads are what kills this fleet; the money is on the character for ' +
                  'the whole crossing and is lost with it on death' },
    scales: 'One character. Inducting the rest is a different operation — `guild ' +
            'action=spread`, which walks nobody and costs no travel.',
  },

  // A GUILD NAME LIVES IN THE SCRIPT, NOT ON THE PROMPT. The REPL does not support quoting
  // — "a value that needs quotes wants a script, not a prompt" (m59-fleet-repl.mjs:45) — and
  // a guild name has spaces in it. That rule is right here for a second reason: the name is
  // PERMANENT and unrenameable, so it belongs somewhere reviewable rather than typed once at
  // a prompt at two in the morning.
  params: {
    agents: { type: 'agents', required: true, describe: 'who founds it — becomes guild master' },
    name: { type: 'string', default: 'The Second Swines',
            describe: 'the guild name. PERMANENT: there is no rename, only disband and pay again' },
    margin: { type: 'number', default: 200,
              describe: 'headroom over the fee. Kept small on purpose: overshooting trips the ' +
                        "character's own bank_above and the keeper deposits it straight back" },
  },

  async steps({ name }) {
    return [
      // THE MONEY FIRST, AND SIZED SO THE KEEPER LETS HIM KEEP IT.
      //
      // The first run of this errand failed here and the failure is worth the comment. It
      // withdrew a flat 6,000 onto a purse of 1,546, landing at 7,546 — and Gonzo's own
      // policy is `bank_above: 7000, walking_money: 1000`, so his keeper deposited 6,546
      // straight back. A COMMANDER HOLD DOES NOT SUSPEND BANKING, the same way it does not
      // suspend resting: economy is held, but the ceiling is the character's own policy and
      // the keeper applies it the moment it has economy again.
      //
      // `carryAtLeast` withdraws the SHORTFALL rather than a flat sum, refuses outright when
      // `bank_above` is below what is being asked for, and reads the purse back afterwards
      // because the banker answers in prose and "You can't check any balance here!" is a
      // sentence rather than an error.
      walk(TOS_BANK, { why: 'the fee comes from the purse and Barloque has no teller' }),
      carryAtLeast(PRICE, { why: 'founding is paid from what the character is CARRYING' }),

      walk(GUILDMASTER_HALL, { why: 'Frular only founds guilds in his own hall' }),

      foundGuild(name, { price: PRICE }),
    ];
  },
};
