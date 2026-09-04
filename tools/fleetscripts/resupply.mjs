// SELL WHAT YOU CARRIED OUT, BUY WHAT YOU CAME FOR, AND SKIP THE LEG YOU DO NOT NEED.
//
// PUBLIC — the SHAPE of the errand. It hard-codes this world's towns and nothing about one
// machine's characters; a fleet that wants different destinations puts a `resupply.mjs` in
// substrate/fleetscripts/ and that one wins by name. See m59-fleetlib.mjs.
//
// The arithmetic it serves: food here is CAST, not bought. `create food` costs 2 elderberry
// AND 2 herbs, so what a character can cast is min(elder, herb) — the scarce half is the
// whole constraint. Everything above the resting cap of 80 vigor has to be eaten, so an empty
// larder pins a character at the cap however much it fights.
//
// THE ROUTE IS DECIDED BY THE PACK, not by the caller. m59-smartloot sorts what the character
// is carrying and answers one question: does anything here need a smith?
//
//   nothing does   -> TOS ONLY. Bank, apothecary and inn in one town. Short trip.
//   something does -> VIA BARLOQUE, because only a smith buys weapons and armour — and since
//                     Barloque also has the vault, the vaulting is free once the detour is
//                     forced. Same rooms, no extra stop.
//
// Deciding to go to Barloque is easy. Deciding NOT to is what saves four or five minutes each
// way, and four characters died on these roads in one night, so a needless lap is not free.
import { walk, bank, shop, sell, vault, observe, pack as readPack, purseOf } from '../m59-fleetscript.mjs';
import { classifyPack, routeFor } from '../m59-smartloot.mjs';

export const script = {
  name: 'resupply',
  describe: 'Sell the loot, buy reagents, come home — routing by what is in the pack.',
  params: {
    agents: { type: 'agents', required: true, describe: 'who goes' },
    each: { type: 'number', default: 150, describe: 'how many of EACH half to buy' },
    home: { type: 'number', default: 39, describe: 'room to return to' },
    // Tos is the one town with a bank AND an apothecary, so a courier short of money does
    // not need a second journey for it. That beats raw hop count.
    bankRoom: { type: 'number', default: 54 },
    shopRoom: { type: 'number', default: 53 },
    seller: { default: 'Frisconar', describe: 'the apothecary that sells the reagents' },
    // BARLOQUE: the smith and the vault, four rooms apart, which is why the detour buys both.
    //
    // TWO MERCHANTS SHARE THE NAME "Fehr'loi Qan" AND ONE OF THEM IS A GHOST. The index holds
    // `BarloqueBlacksmith` at room 113 and `TosBlacksmith` at room `None`. The second is not
    // missing data to be repaired: the smith moved from Tos to Barloque in the game's own
    // story — deliberately, to make people travel — and the old class kept his name. Route by
    // ROOM, never by name alone, or a sell can address the one that is nowhere.
    smithRoom: { type: 'number', default: 113, describe: 'the Royal Blacksmith of Barloque' },
    smith: { default: "Fehr'loi Qan", describe: 'buys weapons, armour and shields' },
    // Read off the map rather than guessed: room 114 is "Office of the Barloque Vaultman".
    // The first version of this said 112, which is a different room entirely — a vault stop
    // that walks somewhere with no vaultman in it fails quietly and looks like a refusal.
    vaultRoom: { type: 'number', default: 114, describe: 'Office of the Barloque Vaultman' },
    vaultman: { default: 'vault', describe: 'the vaultman at vaultRoom' },
    alwaysVault: { default: false, describe: 'force the Barloque leg to bank keepers' },

    // SKIP THE SMITH — FOR TIME, NOT FOR SAFETY.
    //
    // CORRECTED 2026-09-03, and the correction matters because I had the causation backwards.
    // I added this after two couriers died on the way to Barloque, reasoning that a Tos-only
    // trip was the safer road. The operator: "they're dying on the sell run because they're
    // dying when leaving CV, I don't think making the trip just-to-Tos is any safer, the
    // Cragged Mountains and Ukgoth are unavoidable on both sides of the trip." So this buys
    // no safety at all — the killing ground is the exit from Castle Victoria, which every
    // destination shares. It buys TIME, and it dodges the vault at 114 that refused three of
    // four couriers today.
    //
    // Do NOT reach for it as a response to road deaths. This machine's standing note is that
    // the sell circuit is not to be cut over travel deaths — the reagents are worth the
    // bodies, and the fix belongs in travel.
    buyOnly: { default: false, describe: 'skip the smith and vault entirely; just buy and come home' },

    // WHICH HALF THE FLEET IS SHORT OF — 'elder', 'herb', or unset to judge by this courier's
    // own pack. Unset was the original behaviour and it is wrong for a supply run: on
    // 2026-09-03 the fleet held 128 herbs against 248 elderberry while Scooter walked to the
    // shop carrying 120 elderberry and no herbs, so its own pack said "buy elderberry" and the
    // fleet needed the opposite. A courier is shopping for twenty other characters, not itself.
    scarce: { default: null, describe: "the half the FLEET is short of: 'elder' or 'herb'" },
  },

  async steps({ agent, each, home, bankRoom, shopRoom, seller,
                smithRoom, smith, vaultRoom, vaultman, alwaysVault, buyOnly, scarce,
                elderPrice = 28, herbPrice = 14 }) {
    const at = await observe(agent);
    const bill = each * elderPrice + each * herbPrice + 500;

    // The pack decides the route. Asked once, before anything walks, so the plan an operator
    // sees in `dry` is the plan that runs.
    const items = await readPack(agent);
    const pack = classifyPack(items);

    // MONEY COMES FROM THE PACK, NOT FROM `status`. This broker's `status.gold` is null for
    // every character; the shillings are a stack in the inventory. The same read that decides
    // the route answers this, so it costs nothing extra.
    const countOf = re => items.filter(i => re.test(i.name || ''))
                               .reduce((n, i) => n + (i.amount || 1), 0);
    const purse = purseOf(items);
    const haveElder = countOf(/elder/i), haveHerb = countOf(/herb/i);
    const route = routeFor(pack, { alwaysVault: alwaysVault === true || alwaysVault === 'true' });

    // EVERY TOWN STOP IS OPTIONAL AND THE ROAD HOME IS NOT.
    //
    // Zoot, 2026-09-02: the walk to the vault failed three times and took the whole errand
    // with it, leaving him in South Barloque holding seven long swords, a wand and every
    // shilling of the trip's point. The stops here are worth attempting in order and not one
    // of them is worth stranding a character in a foreign town for — the mission is reagents
    // in the pack and a body back in room 39, and a skipped vault costs nothing because
    // VAULT_KEEP already refuses to sell those items at the counter.
    const skipSmith = buyOnly === true || buyOnly === 'true';
    const barloque = (route.viaBarloque && !skipSmith) ? [
      // VAULT BEFORE SELL, always — sell_all offers the merchant everything it will take, so
      // a vault afterwards is a vault of the leftovers. fleetScript refuses the other order.
      ...(route.vaultHere
        ? [walk(vaultRoom, { optional: true }), vault(vaultman, undefined, { optional: true })]
        : []),
      walk(smithRoom, { optional: true }),
      sell(smith, { noVault: !route.vaultHere }),
    ] : [];

    return [
      ...barloque,
      walk(bankRoom, { optional: true }),
      // A banker refusal is a SENTENCE, not an error — "But you only have 393 shillings in
      // your account!" — and it must not end the trip. A courier who cannot top up can still
      // spend what it is carrying, and coming home with 40 elderberry beats coming home with
      // nothing because the bank said no. OPTIONAL for that reason, and `purse` rather than
      // `at.gold` so a character already holding the bill asks for zero and skips the stop.
      // A FUNCTION, NOT A NUMBER, because a death between here and the plan empties the
      // purse: the shillings drop with the loot. `state.purse` is refreshed on recovery,
      // so a courier that died on the road withdraws the WHOLE bill instead of the top-up
      // it needed while it was still carrying its takings.
      bank('withdraw', st => Math.max(0, bill - (st.purse ?? purse)), { optional: true }),
      walk(shopRoom),
      // The apothecary takes what the smith would not: mushrooms, spare reagents, sundries.
      // Gems are excluded on purpose — they ARE reagents and the apothecaries refuse them,
      // so they ride home to the vault at 1 bulk each.
      sell(seller, { noVault: true }),
      // THE SCARCE HALF FIRST, DECIDED PER CHARACTER RATHER THAN HARD-CODED.
      //
      // `create food` costs 2 of each, so what a character can cast is min(elder, herb) and
      // the half it has less of is the only half that buys castings. This line used to always
      // order herbs first, with a comment claiming that bought the scarce half — which was
      // true once and is now exactly backwards: the fleet holds 100 herbs and 7 elderberry,
      // so a thin purse spending herbs-first buys more of the half we already have and comes
      // home still unable to cook. Elderberry is also twice the price, which makes getting
      // the order wrong twice as expensive.
      shop(seller, (() => {
        const elderFirst = [{ match: /elder/i, amount: each }, { match: /herb/i, amount: each }];
        const herbFirst  = [{ match: /herb/i, amount: each }, { match: /elder/i, amount: each }];
        // The caller's fleet-wide reading wins when it has one; the courier's own pack is the
        // fallback for a hand-run trip where nobody has counted the fleet.
        if (scarce === 'elder') return elderFirst;
        if (scarce === 'herb') return herbFirst;
        return haveElder <= haveHerb ? elderFirst : herbFirst;
      })()),
      // ALWAYS. Whatever went wrong upstream, the character does not get left standing in a
      // town it did not start in — the roads out of Barloque and Tos are where this fleet
      // loses people, and a character parked in a foreign room is one a keeper will eventually
      // walk home anyway, unsupervised and at a moment nobody chose.
      walk(home, { always: true }),
    ];
  },
};
