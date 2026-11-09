#!/usr/bin/env node
// A FARM'S OWN TOWN. Offline, no server, no socket, safe any time:
//
//   node tools/m59-farm-town-test.mjs
//
// Operator, 2026-11-07, of the Farol mollusk farmers: "buy/sell in marion for shopping (allowed: axes & leather armor from
// colhorr, bread from tova in the inn ...)". Pins:
//   * the shape (normalizeFarmTown): whole item names, a refusal for every unrecognised key, null for "no farm town";
//   * SILENCE IS THE OLD TOWN: no policy, or no farmTown, and townTable answers exactly what it did; the island and the
//     Avar Village keep their own towns even with a farm town set;
//   * the allowlist: a kind with no counter is not bought (purchaseEnabled), a counter sells us only what it lists for IT,
//     a sale goes to the named seller, `keep` is never offered there, and no bank means a deferral, never a walk to Tos;
//   * the outfit errand's cut: axe and leather armour from Colhorr, no shield, no mace spares;
//   * the Marion strategy itself validates (and `bread` is refused for `loaf of bread`).
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Autopilot, townTable, townDestinations, purchaseEnabled, ISLAND_TOWN, VILLAGE_TOWN, MARKET_STOPS, BANKS, FOOD_SHOPS } from './m59-autopilot.mjs';
import { readToolSource } from './autopilot/source.mjs';
import { normalizeFarmTown, farmTownTable, farmTownMenu, farmTownSeller, farmTownMayBuy, farmTownKeep, farmTownOutfit,
         sellerMatches, isFarmTownBuyer, farmTownSaleLoadout } from './m59-farm-town.mjs';
import { validateStrategy } from './m59-strategy-schema.mjs';
import { resolveItemName } from './m59-items.mjs';
import { saleAllowance } from './m59-loadout.mjs';
import { wantsFor } from './m59-outfit.mjs';
import { configureInterestStore } from './m59-interest-store.mjs';
import { interest } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const throws = (f, re = null) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const resolveItem = n => resolveItemName(n);

// The operator's Marion, from the kod (towns/marntwn): Colhorr (MrSmith.kod, 201) sells mace, short sword, metal shield,
// leather armor and axe and BUYS weapons and shields; Tova (mrbart.kod, 202) sells bread and meat pie and buys nothing;
// Morrigan (mrinnk.kod, 202) buys sundries, food, reagents and wearables. No bank in Marion.
const MARION = {
  name: 'Marion',
  sell: [{ seller: 'Morrigan', room: 202 }, { seller: 'Colhorr', room: 201 }],
  buy: {
    food: [{ seller: 'Tova', room: 202, items: ['loaf of bread'] }],
    weapons: [{ seller: 'Colhorr', room: 201, items: ['axe'] }],
    armor: [{ seller: 'Colhorr', room: 201, items: ['leather armor'] }],
  },
  bank: null,
  keep: ['elderberry', 'herbs', 'edible mushroom'],
};

console.log('\nthe shape');
const town = normalizeFarmTown(MARION, { resolveItem });
{
  ok('null and undefined are "no farm town"', normalizeFarmTown(null) === null && normalizeFarmTown(undefined) === null);
  ok('Marion normalises', town && town.sell.length === 2 && town.buy.food[0].items[0] === 'loaf of bread' && town.bank === null);
  ok('herbs resolve to the game name (herb), keep stays whole names', town.keep.includes('herb') && town.keep.includes('edible mushroom'),
     JSON.stringify(town.keep));
  ok('"bread" is refused for "loaf of bread", and says so',
     throws(() => normalizeFarmTown({ ...MARION, buy: { food: [{ seller: 'Tova', room: 202, items: ['bread'] }] } }, { resolveItem }), /loaf of bread/));
  ok('a misspelt key is refused (a silent `sel:` would sell nothing for ever)', throws(() => normalizeFarmTown({ ...MARION, sel: [] })));
  ok('an unknown buy kind is refused', throws(() => normalizeFarmTown({ ...MARION, buy: { potions: [] } })));
  ok('a counter with no items is refused', throws(() => normalizeFarmTown({ ...MARION, buy: { food: [{ seller: 'Tova', room: 202, items: [] }] } })));
  ok('a room that is not a room is refused', throws(() => normalizeFarmTown({ ...MARION, sell: [{ seller: 'Morrigan', room: 'inn' }] })));
  ok('a town with no counter at all is refused', throws(() => normalizeFarmTown({ name: 'nowhere' })));
  ok('a bank may be named', normalizeFarmTown({ ...MARION, bank: { room: 54 } }).bank.room === 54);
}

console.log('\nthe table');
{
  const t = farmTownTable(town);
  ok('it is townTable-shaped', ['BANKS', 'MARKET_STOPS', 'MARKETS', 'FOOD_SHOPS', 'FOOD_SHOP', 'REAGENT_SHOP'].every(k => k in t));
  ok('the sell circuit is the listed counters, in order', t.MARKET_STOPS.map(s => s.room).join() === '202,201'
     && t.MARKET_STOPS[0].seller === 'Morrigan');
  ok('the bread shop is Tova', t.FOOD_SHOPS.length === 1 && t.FOOD_SHOP.room === 202 && t.FOOD_SHOP.seller === 'Tova');
  ok('NO bank and NO apothecary: empty, never the mainland\'s', t.BANKS.length === 0 && t.REAGENT_SHOP === null);
  ok('cached per town object', farmTownTable(town) === t);
}

console.log('\nsilence is the old town');
{
  const policy = { farmTown: town };
  const old = townTable(546);
  ok('no policy: the mainland table, unchanged', old.region === 'mainland' && old.MARKET_STOPS === MARKET_STOPS && old.BANKS === BANKS
     && old.FOOD_SHOPS === FOOD_SHOPS);
  ok('a policy without farmTown: the same', townTable(546, { hunt: 'mollusk creature' }).MARKET_STOPS === MARKET_STOPS);
  ok('with farmTown on the mainland: the farm town', townTable(546, policy).region === 'farm-town');
  ok('the island keeps its own town', townTable(2115, policy) === ISLAND_TOWN);
  ok('so does the Avar Village', townTable(2154, policy) === VILLAGE_TOWN);
}

console.log('\nwhere a trip goes');
{
  const t = townTable(546, { farmTown: town });
  ok('a full pack goes to the sell counters', townDestinations({ packFull: true, table: t }).map(s => s.room).join() === '202,201');
  ok('a hungry farmer goes to Tova', townDestinations({ starving: true, table: t }).map(s => s.room).join() === '202');
  ok('a reagent trip has no destination (no apothecary) -- and does not throw', townDestinations({ supplyTrip: true, table: t }).length === 0);
  ok('a rich purse has no bank to go to', townDestinations({ richEnoughToBank: true, table: t }).length === 0);
  ok('the mainland is untouched', townDestinations({ supplyTrip: true }).length === 1);
}

console.log('\nwhat may be bought');
{
  const policy = { farmTown: town };
  ok('food: yes (Tova)', purchaseEnabled(policy, 'food'));
  ok('weapons: yes (Colhorr)', purchaseEnabled(policy, 'weapons'));
  ok('reagents: NO -- nobody is listed, so nothing is bought anywhere', !purchaseEnabled(policy, 'reagents'));
  ok('buyFood:false still wins over the town', !purchaseEnabled({ ...policy, buyFood: false }, 'food'));
  ok('no farm town: as before', purchaseEnabled({}, 'reagents') && !purchaseEnabled({ buyReagents: false }, 'reagents'));
  const shelf = [{ name: 'loaf of bread', cost: 12 }, { name: 'meat pie', cost: 30 }, { name: 'mug of ale', cost: 5 }];
  ok("at Tova's counter only the bread", farmTownMenu(town, shelf, 'Tova').map(i => i.name).join() === 'loaf of bread');
  ok('Morrigan sells herbs, and we buy none of them', farmTownMenu(town, [{ name: 'herb', cost: 7 }, { name: 'elderberry', cost: 7 }], 'Morrigan').length === 0);
  ok("Colhorr's mace is not ours to buy, his axe is", farmTownMayBuy(town, 'axe', 'Colhorr') && !farmTownMayBuy(town, 'mace', 'Colhorr'));
  ok('and bread from Colhorr would not be either', !farmTownMayBuy(town, 'loaf of bread', 'Colhorr'));
  ok('no farm town: the menu is untouched', farmTownMenu(null, shelf, 'Tova') === shelf);
}

console.log('\nwho a sale goes to');
{
  ok('the seller name matches the NPC by words, case-blind', sellerMatches('Morrigan', 'morrigan')
     && sellerMatches('Colhorr the blacksmith', 'Colhorr') && !sellerMatches('Colhorrson', 'Colhorr'));
  const room = [{ name: 'Tova' }, { name: 'Morrigan' }];
  ok("the stop's own seller is chosen, not the first buyer in the room", farmTownSeller({ seller: 'Morrigan' }, room)?.name === 'Morrigan');
  ok('a stop whose seller is absent sells to nobody', farmTownSeller({ seller: 'Colhorr' }, room) === null);
  ok('Morrigan and Colhorr are the farm town\'s buyers; Tova is not', isFarmTownBuyer(town, 'Morrigan') && !isFarmTownBuyer(town, 'Tova'));
  ok('keep joins the sale protection at those counters', farmTownKeep(town, ['wand']).includes('herb') && farmTownKeep(town, ['wand']).includes('wand'));
  ok('and nothing is added without a farm town', farmTownKeep(null, ['wand']).join() === 'wand');
}

console.log('\nbounded sale stock');
{
  const limited = normalizeFarmTown({ ...MARION, keep: [...MARION.keep, 'inky-cap mushroom'],
    sellReserve: { mushroom: 48, 'red mushroom': 24 } }, { resolveItem });
  ok('different mushroom names keep different reserves',
     limited.sellReserve.mushroom === 48 && limited.sellReserve['red mushroom'] === 24);
  ok('negative and fractional sale reserves are refused',
     throws(() => normalizeFarmTown({ ...MARION, sellReserve: { mushroom: -1 } })) &&
     throws(() => normalizeFarmTown({ ...MARION, sellReserve: { mushroom: 1.5 } })));
  ok('food and reagent names cannot be abbreviated or confused',
     throws(() => normalizeFarmTown({ ...MARION, sellReserve: { edible: 2 } }, { resolveItem })));
  const personal = { keep: [], sell: [], gear: { weapon: [], slots: {} },
    carry: [{ item: 'mushroom', min: 0, max: 60 }] };
  const loadout = farmTownSaleLoadout(limited, personal, new Map([['red mushroom', 30]]));
  const pack = [{ name: 'mushroom', amount: 90 }, { name: 'red mushroom', amount: 33 },
    { name: 'edible mushroom', amount: 100 }];
  ok('only exact surplus is available after the higher personal or spell reserve',
     saleAllowance(loadout, 'mushroom', pack).amount === 30 &&
     saleAllowance(loadout, 'red mushroom', pack).amount === 3 &&
     saleAllowance(loadout, 'edible mushroom', pack).amount === Infinity);
  ok('there is no sale override for towns that omit the reserve', farmTownSaleLoadout(town, personal) === personal);

  const k = Object.create(Autopilot.prototype);
  const c = { inventory: [{id: 31, nameRsc: 1, amount: 40}, {id: 32, nameRsc: 1, amount: 25},
    {id: 33, nameRsc: 2, amount: 80}, {id: 34, nameRsc: 3, amount: 1}],
    rsc: new Map([[1, 'mushroom'], [2, 'edible mushroom'], [3, 'axe']]), using: new Set() };
  Object.assign(k, { policy: { farmTown: limited, maxWeapons: 0 },
    s: { name: 'fixture', client: c, world: { room: { num: 552 } }, need: () => c },
    saleLoadout: () => null, weaponPriorityNow: () => [], saleProtectedNames: () => [],
    heldBackIds: () => new Set([34]), saleExcludeIds: () => new Set() });
  const rows = k.ownSalePlan().items;
  ok('the actual keeper plan limits sales across duplicate stacks',
     rows.filter(r => r.name === 'mushroom' && r.state === 'sell').reduce((sum, r) => sum + r.sale_amount, 0) === 17);
  ok('the actual keeper plan holds edible mushrooms and the reserved axe',
     rows.find(r => r.id === 33).state !== 'sell' && rows.find(r => r.id === 34).state !== 'sell');
}

console.log('\nOcean sale overflow');
{
  const overflow = normalizeFarmTown({ ...MARION, keep: [...MARION.keep, 'edible mushroom', 'inky-cap mushroom'],
    sellReserve: { mushroom: 48, 'red mushroom': 24, 'blue mushroom': 10 },
    sellOverflow: ['mushroom', 'red mushroom', 'blue mushroom'] }, { resolveItem });
  ok('only named reserves can be opted into fleet-want overflow',
     throws(() => normalizeFarmTown({ ...MARION, sellReserve: { mushroom: 48 }, sellOverflow: ['blue mushroom'] })));
  const directory = mkdtempSync(join(tmpdir(), 'm59-ocean-overflow-'));
  const reserveFile = join(directory, 'reserve.json'), oldReserveFile = process.env.M59_REAGENT_RESERVE_FILE;
  process.env.M59_REAGENT_RESERVE_FILE = reserveFile;
  writeFileSync(reserveFile, JSON.stringify({
    default: { spells: { zap: 7, 'super strength': 5 }, items: { 'red mushroom': 3 } },
    training: { Fixture: { zap: 11, 'super strength': 35 } },
  }));
  configureInterestStore({ enabled: false });
  const buyerWant = 'fixture-other-caster';
  const nameRsc = ['blue mushroom', 'mushroom', 'red mushroom', 'edible mushroom', 'inky-cap mushroom'];
  interest.declare(buyerWant, { wants: nameRsc, wantMatches: new Map(nameRsc.map(n => [n, 'exact'])) });
  try {
    const c = { inventory: [60, 100, 70, 15, 8].map((amount, i) => ({ id: i + 1, nameRsc: i, amount })),
      rsc: new Map(nameRsc.map((name, i) => [i, name])), using: new Set(),
      spells: [{ name: 'zap' }, { name: 'super strength' }] };
    const k = Object.assign(Object.create(Autopilot.prototype), {
      s: { name: 'fixture', client: c, need: () => c, world: { room: { num: 552 } },
        reserveWho: { fleet: 'fixture', agent: 'fixture', character: 'Fixture' } },
      policy: { farmTown: overflow },
      loadout: () => null, saleProtectedNames: () => [], weaponPriorityNow: () => [],
      heldBackIds: () => new Set(), saleExcludeIds: () => new Set(),
    });
    const rows = () => new Map(k.ownSalePlan().items.map(row => [row.name, row]));
    const released = rows();
    ok('Ocean sells only exact excess over summed PvP and training casts even when the fleet wants it',
      released.get('blue mushroom').state === 'sell' && released.get('blue mushroom').sale_amount === 42 &&
      released.get('mushroom').state === 'sell' && released.get('mushroom').sale_amount === 20 &&
      released.get('red mushroom').state === 'sell' && released.get('red mushroom').sale_amount === 46);
    const merchantOnly = k.salePlanView().rows.find(row => row.name === 'blue mushroom');
    ok('the same plan shows fleet-wanted overflow for sale and excludes it from emergency drops',
      merchantOnly.state === 'sell' && merchantOnly.sale_amount === 42 && !merchantOnly.droppable &&
      merchantOnly.drop_block === 'fleet-wanted overflow is for merchant sale');
    ok('the edible and inky-cap lanes retain their existing protections',
      released.get('edible mushroom').state !== 'sell' && released.get('inky-cap mushroom').state !== 'sell');
    c.inventory.unshift({ id: 21, nameRsc: 0, amount: 2 });
    const soldBlue = k.ownSalePlan().items.filter(row => row.name === 'blue mushroom' && row.state === 'sell');
    ok('a wholly sold stack does not count as one remaining unit toward another stack',
      soldBlue.reduce((sum, row) => sum + row.sale_amount, 0) === 44);
    c.inventory.shift();
    c.spells = [];
    ok('an unobserved spell list conservatively retains all configured spell stock', rows().get('blue mushroom').sale_amount === 42);
    c.spells = [{ name: 'zap' }];
    k.s.reserveWho.character = 'Other';
    ok('the Ocean profile alone keeps ten blue mushrooms for Zap', rows().get('blue mushroom').sale_amount === 50);
    k.s.reserveWho.character = 'Fixture';
    k.loadout = () => ({ keep: ['mushroom'], sell: [], gear: { weapon: [], slots: {} },
      carry: [{ item: 'blue mushroom', min: 27, max: 32, match: 'exact' }] });
    k.saleProtectedNames = () => ['red mushroom'];
    const protectedRows = rows();
    ok('personal carry ceilings and both personal and guild hard keeps still win',
      protectedRows.get('blue mushroom').sale_amount === 28 &&
      protectedRows.get('mushroom').state !== 'sell' && protectedRows.get('red mushroom').blocked === 'protected item');
    ok('a pre-existing finite personal ceiling still allows an emergency drop',
      k.salePlanView().rows.find(row => row.name === 'blue mushroom').droppable);
    k.heldBackIds = () => new Set([1]);
    ok('exact held cargo is excluded even above the configured ceiling',
      rows().get('blue mushroom').blocked === 'held out of the offer by the caller');
    k.heldBackIds = () => new Set();
    k.loadout = () => null;
    k.saleProtectedNames = () => [];
    k.policy.farmTown = normalizeFarmTown({ ...MARION, sellReserve: { 'blue mushroom': 10 } });
    ok('another town with sale reserves retains ordinary fleet wants',
      rows().get('blue mushroom').blocked === 'wanted by the fleet');
  } finally {
    interest.forget(buyerWant);
    if (oldReserveFile === undefined) delete process.env.M59_REAGENT_RESERVE_FILE;
    else process.env.M59_REAGENT_RESERVE_FILE = oldReserveFile;
    unlinkSync(reserveFile);
    rmdirSync(directory);
  }
}

console.log('\nselling without a banking threshold');
{
  const limited = normalizeFarmTown({ ...MARION, sellReserve: { mushroom: 48 },
    uncurse: { seller: 'Lady Aftyn', room: 205, item: 'remove curse potion' },
    hall: { room: 714, magicWeapons: true, weaponsTripAt: 3 } });
  const run = async (farmTown, trigger, { curse = false, hallCargo = 0 } = {}) => {
    const c = { inventory: curse ? [{ id:15687, nameRsc:12, rarity:100 }] : [],
      rsc: new Map([[12, 'mace']]), requestInventory() {}, async waitFor() {} };
    const k = Object.create(Autopilot.prototype);
    const trip = [];
    Object.assign(k, { policy: { farmTown, bankAbove: null, townTrips: true },
      s: { client: c, need: () => c, pacer: { submit: async (_kind, fn) => fn() },
        world: { room: { num: 552 }, route: room => ({ found: true, hops: [room] }) } },
      askTownStrategy: async () => null, poorFarmingActive: () => false,
      checkIfShouldSell: () => ({ sell: !!trigger, trigger }),
      _curseSuspect: curse ? { id:15687, certain:true } : null,
      hallBoundWeaponIds: () => Array(hallCargo).fill(1),
      reagentCount: () => ({}), wantedFightFloor: () => 140,
      bansDestination: () => false, prepareFarmDelivery: () => {},
      farmCleanupBeforeSale: async () => {}, packWantsMarket: () => true, note: () => {},
      shoppingPlan: () => ({}), postShoppingPlan: () => {},
      openTownTrip: (target, options) => { trip.push({ target, options }); },
      continueTownTrip: async () => true,
    });
    return { handled: await k.bankRun(), trip };
  };
  const market = await run(limited, 'load');
  ok('a loaded farmer with a configured sale reserve opens Marion market with banking disabled',
     market.handled === true && market.trip[0]?.target.room === 202 && market.trip[0]?.options.wantsMarket === true);
  ok('the opt-in leaves bank-disabled legacy strategies and supply triggers alone',
     (await run(town, 'load')).handled === false && (await run(limited, 'supply')).handled === false);
  const curse = await run(limited, null, { curse:true });
  ok('a server-confirmed curse opens a Marion market trip with no load or banking trigger',
     curse.handled === true && curse.trip[0]?.target.room === 202 &&
     curse.trip[0]?.options.sellCall.trigger === 'curse' && curse.trip[0]?.options.wantsMarket === true);
  const curseWithShortage = await run(limited, 'supply', { curse:true });
  ok('a concurrent supply shortage cannot redirect the market-only curse trip',
     curseWithShortage.trip[0]?.options.sellCall.trigger === 'curse' &&
     !curseWithShortage.trip[0]?.options.supplyTrip && !curseWithShortage.trip[0]?.options.needsCashFirst);
  ok('hall cargo alone cannot open a market-only trip',
     (await run(limited, null, { hallCargo:3 })).handled === false);
}

console.log('\nthe outfit errand');
{
  const plan = farmTownOutfit(town, wantsFor(null));
  ok('armour becomes leather armor, at Colhorr', plan.wants.find(w => w.slot === 'armour')?.what === 'leather armor' && plan.room === 201);
  ok('the weapon becomes the axe (the fleet default was a mace)', plan.wants.find(w => w.slot === 'weapon')?.what === 'axe'
     && plan.wants.find(w => w.slot === 'weapon').fallback.test('axe') && !plan.wants.find(w => w.slot === 'weapon').fallback.test('mace'));
  ok('no shield is listed, so none is bought', !plan.wants.some(w => w.slot === 'shield') && plan.dropped.some(d => d.slot === 'shield'));
  ok('no farm town: no plan, the old errand', farmTownOutfit(null, wantsFor(null)) === null);
  const src = readToolSource(new URL('./m59-outfit.mjs', import.meta.url), 'utf8');
  ok('the errand reads the policy and shops at the farm counter', /farmTownOutfit\(purchaseStatus\?\.policy\?\.farmTown/.test(src)
     && /let shopRoom = AT \?\? farmPlan\?\.room/.test(src));
  ok('and buys no mace spares for a town that lists no weapon', /!farmPlan \|\| wants\.some\(w => w\.slot === 'weapon'\)/.test(src));
}

console.log('\nthe keeper, on the real prototype');
{
  // A plan at Tova's counter: the shelf is cut to bread before the food gap picks the cheapest vigor.
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { policy: { farmTown: town }, purchasePrices: null, pendingFarmDelivery: null,
    purchaseRequests: () => [], purchaseFoodGap: () => 60, guildStores: () => ({ plan: null }) });
  const shelf = [{ name: 'loaf of bread', cost: 12, id: 1 }, { name: 'meat pie', cost: 30, id: 2 }, { name: 'apple', cost: 2, id: 3 }];
  const atTova = k.shoppingPlan({ kind: 'food', items: shelf, seller: 'Tova' });
  ok("a food plan at Tova's buys bread only (apples are cheaper vigor and are not allowed)",
     atTova.lines.length === 1 && atTova.lines[0].item === 'loaf of bread', JSON.stringify(atTova.lines));
  const atMorrigan = k.shoppingPlan({ kind: 'food', items: shelf, seller: 'Morrigan' });
  ok("the same shelf at Morrigan's buys nothing", atMorrigan.lines.length === 0);
  const plain = Object.create(Autopilot.prototype);
  Object.assign(plain, { policy: {}, purchasePrices: null, pendingFarmDelivery: null,
    purchaseRequests: () => [], purchaseFoodGap: () => 60, guildStores: () => ({ plan: null }) });
  ok('without a farm town the cheapest vigor wins, as before', plain.shoppingPlan({ kind: 'food', items: shelf }).lines[0]?.item === 'apple');

  // No bank: a purchase the purse cannot cover is DEFERRED, never a walk to the Royal Bank of Tos.
  const walked = [];
  const f = Object.create(Autopilot.prototype);
  Object.assign(f, { policy: { farmTown: town }, purchaseFunding: {}, townTrip: { target: { room: 202 } }, notes: [],
    note: (what, d) => f.notes.push({ what, ...d }), travel: async (r) => { walked.push(r); return { arrived: true }; },
    postShoppingPlan: () => ({ shortfall: 40, purse: 20, required_purse: 60 }), poorFarmingActive: () => false,
    travelInterrupted: () => false, suspendedJourney: null, purseNow: () => 20, bansDestination: () => false,
    s: { world: { room: { num: 202 }, route: () => ({ found: true, hops: [1, 2] }) }, bankKnown: () => null,
         pacer: { submit: async (_k, fn) => fn() },
         need: () => ({ evSeq: 0, requestInventory: () => {}, waitFor: async () => ({ events: [] }) }) } });
  const r = await f.ensurePurchaseFunds({ required_purse: 60, expected_cost: 60, reserve: 0, lines: [] });
  ok('no bank in the farm town: unaffordable is returned and nothing walks', r.unaffordable === true && walked.length === 0, JSON.stringify(r));
  ok('the trip is kept for when the purse can pay', f.deferredShoppingTrip?.target?.room === 202 && f.townTrip === null);
  ok('and the note says why', f.notes.some(n => /no bank/.test(n.what)));
}

console.log('\nmarket cooldown when purchases defer');
{
  function marketTrip(purse) {
    const calls = [];
    const client = {
      inventory: [{ id: 1, nameRsc: 1, amount: 350 }, { id: 2, nameRsc: 2, amount: 1 },
        { id: 3, nameRsc: 3, amount: purse }],
      rsc: new Map([[1, 'blue mushroom'], [2, 'long sword'], [3, 'shilling']]),
      stat: name => name === 'might' ? 15 : null,
      evSeq: 0, requestInventory: () => {}, waitFor: async () => ({ events: [] }),
    };
    const world = { room: { num: 202 } };
    const trip = { target: { room: 202 }, purpose: 'sell', trigger: 'load', nextService: 1, marketStops: town.sell };
    const k = Object.create(Autopilot.prototype);
    Object.assign(k, {
      policy: { farmTown: town, maxCarry: 100 }, townTrip: trip,
      s: { world, client, need: () => client, bankKnown: () => null, pacer: { submit: async (_kind, fn) => fn() } },
      travelInterrupted: () => false, note: () => {}, standingOrderUnstarted: () => null,
      overfarmHoldsTrip: () => null, supplyShortfall: () => ({ short: false }),
      ownSalePlan: () => ({ items: [{ id: 2, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell' }] }),
      minSellTripValue: () => 0,
      travel: async room => { calls.push(`walk ${room}`); world.room.num = room; return { arrived: true }; },
      sellInTown: async ({ seller }) => { calls.push(`sell ${seller}`); return { sold: [], total_received: 0 }; },
      shoppingPlan: () => ({ lines: [{ item: 'loaf of bread', amount: 1, cost: 60 }],
        unpriced: [], required_purse: 60, expected_cost: 60, reserve: 0 }),
      farmTownCurseErrand: async () => {}, guildTitheFromSale: async () => {}, farmTownHallVisit: async () => {},
      bankSurplus: async () => {}, fundStandingOrder: async () => {},
      restockInTown: async () => { calls.push('restock'); },
      buyFoodInTown: async () => { calls.push('buy food'); },
      buyReagentsInTown: async () => { calls.push('buy reagents'); },
      chaliceTownCargo: async () => {}, chaliceBuyCargo: async () => {}, buyFarmDeliveryCargo: async () => {},
      gatherTownFavors: async () => {}, vaultRunIfPassing: async () => {}, kocatanGateClear: async () => {},
      progress: () => { calls.push('finished'); },
    });
    return { k, trip, calls };
  }

  const poor = marketTrip(20);
  ok('the same pack would open a new load sale before visiting the counters',
     poor.k.checkIfShouldSell().trigger === 'load');
  const deferred = await poor.k.continueTownTrip();
  ok('an empty circuit defers only at no-bank purchase funding, after both normal counters',
     deferred === false && poor.k.townTrip === null && poor.k.deferredShoppingTrip === poor.trip &&
     poor.trip.nextService === 7 && poor.calls.join('|') === 'sell Morrigan|walk 201|sell Colhorr');
  ok('the completed market respects the existing cooldown while purchases are deferred',
     Number.isFinite(poor.k.lastMarketServiceAt) && poor.k.lastTownServiceAt == null &&
     poor.k.checkIfShouldSell().sell === false);

  const funded = marketTrip(100);
  const completed = await funded.k.continueTownTrip();
  ok('a funded circuit still buys and completes in the usual order',
     completed === true && funded.k.townTrip === null && !funded.k.deferredShoppingTrip &&
     funded.calls.join('|') === 'sell Morrigan|walk 201|sell Colhorr|restock|buy food|buy reagents|finished');
  ok('normal completion still starts the market cooldown from the full service stamp',
     Number.isFinite(funded.k.lastTownServiceAt) && funded.k.lastMarketServiceAt === funded.k.lastTownServiceAt);
}

console.log('\nwired in');
{
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/townTable\(([^)]*)\)/g)].map(m => m[1]).filter(a => a && !/^(room(, policy = null)?|null)$/.test(a));   // the definition, and townDestinations' default
  const bare = calls.filter(a => !/this\.policy/.test(a));
  ok('every keeper townTable call passes the policy', bare.length === 0, JSON.stringify(bare));
  ok('the sell circuit hands the stop\'s seller to the sale', /sellInTown\(\{ maxStack: stop\.maxStack, seller: stop\.seller \?\? null \}\)/.test(src));
  ok('a named sale never goes to a NEVER_SELL_TO name', /NEVER_SELL_TO\.some\(re => re\.test/.test(src));
  ok('the food counter is the named one', /named: town\.farmTown \? \(shopHere\(\)\?\.seller \?\? null\) : null/.test(src));
  ok('restock passes the counter name to the plan', /shoppingPlan\(\{ kind: 'restock', items: shop\.items \?\? \[\], seller: sellerName \}\)/.test(src));
  ok('the policy key exists on the keeper', /\n\s+farmTown: null,/.test(src));
  const v = validateStrategy({ name: 'x', town: MARION }, { resolveItem });
  ok('a strategy may set it (economy), landing on policy.farmTown', v.ok && v.strategy.desired.farmTown?.sell?.length === 2
     && v.strategy.faculties.farmTown === 'economy', v.why);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
process.exit(fail ? 1 : 0);
