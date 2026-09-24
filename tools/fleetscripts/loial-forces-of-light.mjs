// POST A CASTER IN CASTLE VICTORIA AND LEAVE THE ROOM LIT BEHIND YOU.
//
// PUBLIC. Stock one character with the reagents for a room enchantment, walk it to the room,
// set the post, and hand the body back to its keeper.
//
// WHAT THE ROOM GETS. `forces of light` is a ROOM enchantment (forceslt.kod): +50 to +150 on
// the hit roll of every good-karma player standing in it, renewed for as long as the caster
// can pay, and — the part that makes a POST worth more than a visit — it covers whoever walks
// in NEXT. Castle Victoria is the hall this fleet crosses on its way to the undead upstairs,
// so one character standing still there raises the earning rate of everyone who passes.
//
// ---------------------------------------------------------------- what this is NOT
//
// THIS IS THE PLACEMENT, NOT THE BEHAVIOUR. It runs once. The standing arrangement — noticing
// the reagents have run out, going to buy more, coming back — is a DUM doctrine
// (`room_caster` in meridian59-dum-bot), because "he is out of gems and should go shopping"
// is a minutes decision with no single right answer, which is the bot's half of the boundary.
//
// Use this script when DUM is not running, to bootstrap a post before it is, or to put the
// caster back after something took him off it. Running both is harmless: DUM re-asserts the
// same posture and agrees on the first pass.
//
// ---------------------------------------------------------------- the one trap in it
//
// THE LAST THING `post()` DOES IS GIVE THE BODY BACK, AND THAT IS THE STEP.
// `Autopilot.isRoomEnchantPost` runs the renewal loop only while
// `!facultyHeld('work') && !facultyHeld('movement')` — the keeper does not maintain a post
// that something else is steering. A version of this script that set the posture and kept the
// lease would report success on every call and light nothing.
import { walk, shop, post, verify } from '../m59-fleetscript.mjs';

// WHAT ONE THROW COSTS, READ OFF THE KOD RATHER THAN REMEMBERED. forceslt.kod:54-61.
// The pair is UNBALANCED in practice and the scarce half is not the one anybody watches: the
// field refills elderberries for nothing and every emerald has to be bought.
const PER_CAST = [{ match: 'elder\\s?berr', per_cast: 2 }, { match: 'emerald', per_cast: 1 }];

export const script = {
  name: 'loial-forces-of-light',
  // GUARANTEE 9. Narrow on purpose: a pin that watches the whole tree cries wolf on every
  // commit and gets ignored. `post()` and the keeper's own post loop are what this depends on.
  provenance: {
    pinned: '039a61e', verified: '2026-09-23',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-autopilot.mjs', 'tools/m59-broker.mjs'],
  },
  describe: 'Stock a caster, walk it to a room, and post it keeping a room enchantment up.',
  recipe: {
    effect: 'Leaves ONE character standing in one room with `forces of light` renewing itself ' +
            'from a safe spot, its reagents protected from the next sell pass, and its keeper ' +
            'holding the body. Everyone who fights in that room hits more often, including ' +
            'whoever arrives after the cast.',
    run: 'loial-forces-of-light agents=<a> room=38',
    needs: ['a caster that KNOWS the enchantment — a spell it does not have is silence, not ' +
            'an error',
            'reagents for at least `minCasts` throws, or the money and the counters below',
            'full health to set out, because every leg of this is a journey'],
    cost: { time: '2-20 minutes: two counters in Barloque and the road to the castle',
            risk: 'the road. A 20-max-health caster is the body least able to survive one, ' +
                  'which is the whole argument for buying deep and going rarely',
            measured: '2026-09-23 — 124 casts aboard at the post, about two hours of casting' },
    scales: 'One character. A second caster in the same room is wasted: the enchantment is on ' +
            'the ROOM and `CanPayCosts` refuses a recast while it is still up (forceslt.kod:75).',
    notes: ['`buy_reagents` is deliberately left OFF. The keeper\'s own reagent buying goes to ' +
            'one apothecary for elderberry and herbs and never buys a gem, so leaving it on ' +
            'sends the caster on a trip that cannot fix what opened it.',
            'The two halves of this spell are not sold by the same merchant: Joguer has the ' +
            'berries, Herbutte has the gem, and a trip to one of them comes home able to cast ' +
            'exactly as often as it left.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the caster — exactly one' },
    room: { type: 'number', required: true, describe: 'the room to stand in and light' },
    enchant: { type: 'string', default: 'forces of light', describe: 'which room enchantment' },
    // BUY FIRST, THEN WALK. Barloque is where the counters are and the castle is where the
    // post is, so the shopping is free if it happens on the way out and a second journey if
    // it does not. Set `buy=false` for a caster that is already carrying enough.
    buy: { type: 'boolean', default: true, describe: 'stop at the two counters on the way' },
    casts: { type: 'number', default: 60, describe: 'how many throws to stock up to' },
    minCasts: { type: 'number', default: 5,
                describe: 'refuse the post below this many payable casts — a caster that ' +
                          'cannot pay is a character standing in a room' },
    // A rest line for a body whose whole job is casting: PFLAG_NO_MAGIC is set while resting,
    // so a farmer's threshold would leave it sitting through the enchantment's duration.
    restBelow: { type: 'number', default: 0.5, describe: 'rest under this fraction of health' },
    fleeBelow: { type: 'number', default: 0.9, describe: 'leave under this fraction of health' },
    manaFloor: { type: 'number', default: 19, describe: 'never spend the last mana on the room' },
    marginMs: { type: 'number', default: 8000, describe: 'recast this long before it lapses' },
  },
  async steps({ room, enchant, buy, casts, minCasts, restBelow, fleeBelow, manaFloor, marginMs }) {
    // THE REPL HANDS EVERY VALUE OVER AS A STRING, and `checkParams` only type-checks
    // `number` and `agents`. So `buy=false` arrives as the STRING "false", which is truthy —
    // the switch that turns the shopping off would have turned it on. Coerced here rather
    // than discovered as a caster taking a detour to two counters it did not need.
    const shopping = buy !== false && String(buy).toLowerCase() !== 'false';
    const stock = Math.max(1, Number(casts) || 60);
    const want = n => Math.max(1, Math.round(stock * n));
    return [
      // THE COUNTERS, IN THE ORDER THE ROOMS ARE IN. Both are in Barloque, where this fleet
      // already does its town stops — so a farmer passing through can hand the caster reagents
      // instead, which is what `accept` below turns on.
      ...(shopping ? [
        walk(104),
        shop('Joguer', [{ match: /elder\s?berr/i, amount: want(2) }]),
        walk(109),
        shop('Herbutte', [{ match: /emerald/i, amount: want(1) }]),
      ] : []),
      walk(Number(room)),
      // AND THE POST ITSELF, WHICH ENDS BY HANDING THE BODY BACK. See the note at the top.
      post(Number(room), {
        enchant, marginMs: Number(marginMs), manaFloor: Number(manaFloor),
        restBelow: Number(restBelow), fleeBelow: Number(fleeBelow), minCasts: Number(minCasts),
        needs: PER_CAST,
        // The other supply route, and the cheaper one: a fleetmate already walking past
        // pushes the goods across and leaves, with nobody agreeing a moment.
        accept: ['elderberry', 'emerald'],
        // AND WHAT MUST NOT BE SOLD OR SHED. A sell pass takes the gems first — they are a
        // stack with a price on them — and the gems are the half that has to be bought.
        protect: ['elderberry', 'emerald'],
      }),
      // RULE 6: READ IT BACK FROM THE WORLD. `post()` already refuses on the keeper's own
      // policy; this is the outside check that the character is where the orders say, because
      // a post set for a room the caster is not standing in lights nothing at all.
      verify(async ({ observe, agent }) => {
        const at = await observe(agent);
        return Number(at?.room) === Number(room);
      }, `standing in ${room} with the post set`),
    ];
  },
};
