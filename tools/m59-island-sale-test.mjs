#!/usr/bin/env node
// A SELL TRIP ON KO'CATAN SELLS THE ISLAND REAGENTS -- offline, no socket, no roster.
//
//   node tools/m59-island-sale-test.mjs
//
// Prod 2026-10-27: island farmers' packs filled with dragonfly eyes, rainbow ferns, web moss and seraphym until they could
// not receive a weapon, conjure one or loot. Their own sell trips walked home with the eyes, ferns and seraphym, and later
// trips were dropped as "pack full of kept stock"; sold by hand at Zala ix'Mecya (2002) the same goods were worth 15,000
// and 17,000 shillings. Three holds, every one on the sale plan (m59-island-sale.mjs has the argument):
//   * rainbow fern scored as a WEAPON (/bow/ in "rainbow"), kept as "best spare weapon within max_weapons";
//   * the guild plan's `everyone` dispel reagents (dragonfly eye, uncut seraphym) held whole, by name, for a mainland
//     hall chest a few short -- a deposit no islander can make;
//   * a mainland dispeller's declared shortfall held them as "wanted by the fleet".
// What this pins:
//   * weaponScore: rainbow fern (and five other misnamed items) is not a weapon; real weapons still are;
//   * on the island, a sale plan sells the island reagents' surplus and routes it to Zala (2002), the store last;
//   * a caster keeps a few casts' worth of what it casts with; the character's own protect list, loadout keep list and
//     carry rows always win;
//   * on the mainland nothing changed: same terms, same plan;
//   * a pack 90% full by BULK with light weight opens a sell trip, so does 90% by WEIGHT with low bulk; 89% does not
//     (operator 2026-10-27: "go at hitting 90% full of either bulk/weight"), and on the island that trip is no longer
//     dropped as "full of kept stock";
//   * the sale at Zala's counter really offers and sells them, and the smithy is never offered a reagent.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-island-sale-'));
process.env.M59_LEDGER_DIR ??= join(scratch, 'ledger');
process.env.M59_GUILD_PLAN = join(scratch, 'no-guild-plan.json');      // the rig stubs the guild's wants itself
process.env.M59_STORAGE_DIR = join(scratch, 'storage');
process.env.M59_INVENTORY_INTENT_DIR = join(scratch, 'intent');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? ' -- ' + detail : ''}`);
};

const A = await import('./m59-autopilot.mjs');
const S = await import('./m59-skills.mjs');
const B = await import('./m59-buyers.mjs');
const I = await import('./m59-items.mjs');
const IS = await import('./m59-island-sale.mjs');

console.log('a rainbow fern is not a bow');
ok('weaponScore("rainbow fern") is 0 (it was 3: /bow/ in "rainbow")', S.weaponScore('rainbow fern') === 0);
ok('nor are the other five real items with a weapon word in their name',
   ['bowl of soup', 'bowl of stew', 'notice of delinquent taxes', 'shard of a sword', 'gnarled staff'].every(n => S.weaponScore(n) === 0));
ok('real weapons still score: long sword 7, practice bow 3, hammer > 0, axe 5',
   S.weaponScore('long sword') === 7 && S.weaponScore('practice bow') === 3 && S.weaponScore('hammer') > 0 && S.weaponScore('axe') === 5);
ok('a name the index does not know is still the word list\'s ("cursed long sword" scores)', S.weaponScore('cursed long sword') === 7);
ok('isKnownNonWeapon: fern yes, long sword no, an unknown name no',
   I.isKnownNonWeapon('rainbow fern') && !I.isKnownNonWeapon('long sword') && !I.isKnownNonWeapon('cursed long sword'));

console.log('the island reagents, and who buys them');
ok('the eight island reagents from the treasure tables', IS.ISLAND_REAGENTS.length === 8 &&
   ['dragonfly eye', 'rainbow fern', 'web moss', 'kriipa claw', 'yrxl sap', 'uncut seraphym'].every(n => IS.ISLAND_REAGENTS.includes(n)));
ok('the spell catalogue\'s "yrxlsap" is the pack\'s "yrxl sap"', IS.islandReagent('yrxlsap') === 'yrxl sap' && IS.islandReagent('herb') === null);
ok('Zala (KocatanApothecary) buys every one of them -- seraphym is a reagent, not a gem',
   IS.ISLAND_REAGENTS.every(n => B.willBuy('KocatanApothecary', n).buys === true));
ok('the smithy buys none of them', IS.ISLAND_REAGENTS.every(n => B.willBuy('KocatanBlacksmith', n).buys === false));
ok('the four counters resolve by name without the merchant index',
   ["Ixla cha'Totlak", "Zala ix'Mecya", "Tepal ix'Zonak", "Pacal ix'Anoak"].map(n => B.classOf({ name: n }).cls).join() ===
   'KocatanBlacksmith,KocatanApothecary,KocatanTailor,KocatanShopkeeper');
const stops = A.ISLAND_TOWN.MARKET_STOPS;
ok('the island circuit offers the specialists first and the finite-shelf store last',
   stops.map(s => s.room).join() === '2003,2002,2006,2004');
const routeOf = name => stops.find(st => B.partition([{ name }], { name: st.name.split(',')[0] }).offer.length)?.room ?? null;
ok('dragonfly eye / rainbow fern / web moss / kriipa claw / yrxl sap are first bought at Zala (2002)',
   ['dragonfly eye', 'rainbow fern', 'web moss', 'kriipa claw', 'yrxl sap'].every(n => routeOf(n) === 2002),
   JSON.stringify(['dragonfly eye', 'rainbow fern', 'web moss', 'kriipa claw', 'yrxl sap'].map(n => [n, routeOf(n)])));
ok('a spare long sword still goes to the smithy (2003)', routeOf('long sword') === 2003);

// ------------------------------------------------------------------------------------------------- the keeper rig
// The guild plan's `everyone` hold is stubbed exactly as prod read it (dispel reagents short in a hall chest), and a
// mainland dispeller declares a shortfall on the fleet board.
S.interest.declare('dispeller', { wants: ['dragonfly eye', 'uncut seraphym'], room: 27, character: 'Dispeller' });
const LOADOUT = { character: 'Islander', keep: ['relic of Qor'], sell: ['long sword'], gear: { weapon: ['axe'], slots: {} },
  carry: [{ item: 'elderberry', min: 0, max: 40, match: 'exact' }] };
const PACK = [
  ['axe', 0], ['shield of the rebel militia', 0], ['shilling', 2254], ['Chalice of the Rain', 0], ['relic of Qor', 0],
  ['elderberry', 18], ['dragonfly eye', 300], ['rainbow fern', 200], ['web moss', 150], ['kriipa claw', 60],
  ['yrxl sap', 5], ['uncut seraphym', 100], ['long sword', 0],
];
function rig({ room = 2125, pack = PACK, policy = {}, loadout = LOADOUT, spells = [], guild = ['dragonfly eye', 'uncut seraphym', 'vial of solagh'],
               might = 55, merchants = [] } = {}) {
  const notes = [], sold = [];
  const inventory = pack.map(([name, amount], i) => ({ id: 100 + i, nameRsc: name, amount }));
  const objects = new Map(merchants.map((name, i) => [990001 + i, { id: 990001 + i, nameRsc: name, flags: 0xffffffff }]));
  const c = {
    inventory, rsc: { get: x => x }, stat: k => (k === 'might' ? might : null),
    using: new Set(inventory.filter(o => ['axe', 'shield of the rebel militia'].includes(o.nameRsc)).map(o => o.id)),
    spells: spells.map(name => ({ nameRsc: name })), room: { objects },
    requestInventory: () => {}, waitFor: async () => ({ events: [] }),
  };
  const s = {
    name: 'islander', client: c, need: () => c, world: { room: { num: room } },
    pacer: { submit: async (_k, f) => f() },
    // A MOB_BUYER counter-offers 60% of value; the accept moves the goods. Records who bought what.
    sellOne: async (merchant, offer, accept) => {
      const who = c.room.objects.get(Number(merchant))?.nameRsc ?? '?';
      if (!accept) return { offered_price: 10 * (offer.amount || 1) };
      const live = c.inventory.find(o => o.id === offer.id);
      const n = offer.amount || 1;
      if (live) { if ((live.amount || 0) > n) live.amount -= n; else c.inventory.splice(c.inventory.indexOf(live), 1); }
      sold.push({ who, name: live?.nameRsc ?? offer.nameRsc, amount: n });
      return { sold: true, offered_price: 10 * n };
    },
  };
  const k = Object.assign(Object.create(A.Autopilot.prototype), {
    s, name: 'islander', policy: { maxWeapons: 1, minSellTripValue: 0, maxCarry: 50, ...policy }, tally: {},
    note: (what, d) => notes.push({ what, ...d }), tradeFact: () => {}, progress: () => {},
    loadout: () => loadout, weaponPriorityNow: () => ['axe'], rouletteTarget: () => null, heldBackIds: () => new Set(),
    guildWantedNames: () => guild, chestSourcedNames: () => [],
    standingOrderUnstarted: () => null, overfarmHoldsTrip: () => null, supplyShortfall: () => ({ short: false }),
  });
  return { k, c, s, notes, sold };
}
const planOf = k => S.inventorySalePlan(k.s, { keep: I.MARKET_KEEP, protect: k.islandSaleRelease(k.protectedItemNames()),
  loadout: k.saleLoadout(), maxWeapons: k.policy.maxWeapons, weaponPriority: k.weaponPriorityNow() });
const row = (plan, name) => plan.items.find(i => i.name === name);
const selling = (plan, name) => { const r = row(plan, name); return r?.state === 'sell' ? r.sale_amount : 0; };

console.log("on Ko'catan, the sale plan sells the island reagents");
{
  const { k } = rig();
  const plan = planOf(k);
  const want = { 'dragonfly eye': 300, 'rainbow fern': 200, 'web moss': 150, 'kriipa claw': 60, 'yrxl sap': 5, 'uncut seraphym': 100 };
  for (const [name, n] of Object.entries(want))
    ok(`${name}: all ${n} for sale`, selling(plan, name) === n, JSON.stringify(row(plan, name)));
  ok('the dispel reagents are no longer "protected item" on the island (the hall is on the mainland)',
     !k.islandSaleRelease(k.protectedItemNames()).includes('dragonfly eye'));
  ok('and the island release keeps every other name: the guild\'s vial of solagh is not an island reagent',
     k.islandSaleRelease(k.protectedItemNames()).includes('vial of solagh'));
  ok('the worn axe and the shield are never for sale', row(plan, 'axe')?.state !== 'sell' && row(plan, 'shield of the rebel militia')?.state !== 'sell');
  ok('the chalice, money and the loadout\'s keep list stay', row(plan, 'shilling')?.state !== 'sell' && row(plan, 'relic of Qor')?.state !== 'sell');
  ok('elderberry under its carry ceiling (18 of 40) stays', selling(plan, 'elderberry') === 0);
}

console.log('a caster keeps a few casts; the character\'s own orders always win');
{
  const { k } = rig({ spells: ['morph'] });                          // morph: 3 web moss, 2 dragonfly eye (kod morph)
  const plan = planOf(k);
  ok('knowing morph keeps 30 web moss and 20 dragonfly eyes (ten casts), sells the rest',
     selling(plan, 'web moss') === 120 && selling(plan, 'dragonfly eye') === 280,
     JSON.stringify([row(plan, 'web moss'), row(plan, 'dragonfly eye')]));
  ok('the reserve comes from the spell catalogue', JSON.stringify(IS.islandCastReserve(['morph'], { cost: (await import('./m59-deskpractice.mjs')).spellCost }))
     === JSON.stringify({ 'web moss': 30, 'dragonfly eye': 20 }));
}
{
  const { k } = rig({ policy: { protectedItems: ['dragonfly eye', 'uncut seraphym'] } });
  const plan = planOf(k);
  ok('protect_items naming dragonfly eye and uncut seraphym: never for sale, on the island too',
     selling(plan, 'dragonfly eye') === 0 && selling(plan, 'uncut seraphym') === 0 && row(plan, 'dragonfly eye')?.blocked === 'protected item');
  ok('...while the fern beside them still sells', selling(plan, 'rainbow fern') === 200);
}
{
  const { k } = rig({ policy: { vaultItems: ['web moss'] }, loadout: { ...LOADOUT, keep: [...LOADOUT.keep, 'kriipa claw'],
    carry: [...LOADOUT.carry, { item: 'rainbow fern', min: 0, max: 50, match: 'exact' }] } });
  const plan = planOf(k);
  ok('vault_items web moss: kept', selling(plan, 'web moss') === 0);
  ok('the loadout\'s keep list (kriipa claw): kept', selling(plan, 'kriipa claw') === 0);
  ok('the loadout\'s own carry row for rainbow fern (max 50) wins over the island ceiling: 150 sold, 50 kept',
     selling(plan, 'rainbow fern') === 150, JSON.stringify(row(plan, 'rainbow fern')));
}

console.log('on the mainland nothing changed');
{
  const { k } = rig({ room: 599 });
  ok('saleLoadout() is the character\'s own loadout, the very object', k.saleLoadout() === LOADOUT);
  const names = k.protectedItemNames();
  ok('islandSaleRelease is the identity', k.islandSaleRelease(names) === names);
  const plan = planOf(k);
  const old = S.inventorySalePlan(k.s, { keep: I.MARKET_KEEP, protect: k.protectedItemNames(), loadout: k.loadout(),
    maxWeapons: k.policy.maxWeapons, weaponPriority: k.weaponPriorityNow() });
  ok('the plan with the new terms is the plan with the old ones', JSON.stringify(plan) === JSON.stringify(old));
  ok('the guild\'s dispel reagents stay held there, as before', row(plan, 'dragonfly eye')?.blocked === 'protected item'
     && row(plan, 'uncut seraphym')?.blocked === 'protected item');
  ok('and the fern sells there too now that it is not a weapon', selling(plan, 'rainbow fern') === 200);
}

console.log('the sell trigger: 90% of either weight or bulk');
{
  ok('the default is 0.9 (SELL_AT_LOAD), the fuller of weight and bulk', A.SELL_AT_LOAD === 0.9);
  // might 55 -> 2800 of each. An axe is 90/90, a dragonfly eye weight 2 bulk 3, a kriipa claw weight 4 bulk 2.
  const bulky = rig({ pack: [['axe', 0], ['dragonfly eye', 810]] });                 // bulk 2520 = 90%, weight 1710 = 61%
  const b = bulky.k.checkIfShouldSell();
  ok('90% BULK with 60% weight opens a sell trip (load)', b.sell === true && b.trigger === 'load' && b.fullness >= 0.9, JSON.stringify(b));
  const heavy = rig({ pack: [['axe', 0], ['kriipa claw', 608]] });                   // weight 2522 = 90%, bulk 1306 = 47%
  const h = heavy.k.checkIfShouldSell();
  ok('90% WEIGHT with 47% bulk opens one too', h.sell === true && h.trigger === 'load', JSON.stringify(h));
  const under = rig({ pack: [['axe', 0], ['dragonfly eye', 806]] });                 // bulk 2508 = 89.6%
  const u = under.k.checkIfShouldSell();
  ok('89.6% does not (the default is no longer 0.85)', u.sell === false, JSON.stringify(u));
  const set = rig({ pack: [['axe', 0], ['dragonfly eye', 806]], policy: { sellAtLoad: 0.7 } });
  ok('a strategy\'s sellAtLoad still decides (0.7 opens it)', set.k.checkIfShouldSell().sell === true);
  // The prod pack: everything held. On the island it now goes; on the mainland, same holds, it is "full of kept stock".
  const prodPack = [['axe', 0], ['dragonfly eye', 579], ['rainbow fern', 205]];       // bulk 90+1737+820 = 2647 = 95%
  const isl = rig({ pack: prodPack }).k.checkIfShouldSell();
  ok('Sweetums\' pack on the island: the trip opens, the relief is real', isl.sell === true && isl.trigger === 'load', JSON.stringify(isl));
  const main = rig({ room: 599, pack: [['axe', 0], ['dragonfly eye', 853]] });
  const m = main.k.checkIfShouldSell();
  ok('the same held eyes on the mainland: still "pack full of kept stock" (mainland unchanged)', m.sell === false &&
     main.notes.some(n => n.what === 'sell trip held: the pack is full of what it keeps'), JSON.stringify(m));
  const unarmed = rig({ pack: [['dragonfly eye', 840]] });
  ok('an unarmed islander at 90% bulk opens it too (the conjure deadlock calls bankRun -> this)', unarmed.k.checkIfShouldSell().sell === true);
}

console.log("at the counters: Zala buys, the smithy is never offered a reagent");
{
  const { k, sold } = rig({ room: 2002, merchants: ["Zala ix'Mecya"] });
  const r = await k.sellInTown();
  const names = new Set(sold.map(x => x.name));
  ok('sellInTown at 2002 sells every island reagent to Zala',
     ['dragonfly eye', 'rainbow fern', 'web moss', 'kriipa claw', 'yrxl sap', 'uncut seraphym'].every(n => names.has(n))
     && sold.every(x => x.who === "Zala ix'Mecya"), JSON.stringify({ sold, r }));
  ok('and nothing it does not buy is offered to it (the spare long sword waits for the smithy)', !names.has('long sword')
     && r.not_offered?.some(x => x.name === 'long sword'));
  ok('the worn axe, the chalice and the relic are still in the pack',
     ['axe', 'Chalice of the Rain', 'relic of Qor'].every(n => k.s.client.inventory.some(o => o.nameRsc === n)));
}
{
  const { k, sold } = rig({ room: 2003, merchants: ["Ixla cha'Totlak"] });
  const r = await k.sellInTown();
  ok('at the smithy (2003) only the spare long sword is sold; every island reagent is "not offered"',
     sold.map(x => x.name).join() === 'long sword' &&
     ['dragonfly eye', 'rainbow fern', 'web moss'].every(n => r.not_offered?.some(x => x.name === n)), JSON.stringify({ sold, r: r?.not_offered }));
}

console.log('the guild hall is not a stop on an island trip');
{
  const { k } = rig();
  const r = await k.contributeGuildWants({ duringTownTrip: true });
  ok('contributeGuildWants on the island: skipped, no walk to the mainland hall', r?.skipped === true && /mainland/.test(r.why), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
