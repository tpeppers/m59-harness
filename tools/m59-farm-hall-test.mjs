#!/usr/bin/env node
// A FARM TOWN'S HALL, ITS RENT, ITS CURSE ERRAND, AND THE UNCAPPED ROAD. Offline, no server, no socket, safe any time:
//
//   node tools/m59-farm-hall-test.mjs
//
// Operator, 2026-11-07, of the Farol mollusk farmers: "Uncap fights per trip, we want the max for those farmers... and let
// them deposit in the guild chest instead of banking, also set them to tithe for the guild rent"; "pick up magic weapons
// and deposit them in the guild chest if they are not cursed. If they are cursed they should go sell in Marion, then buy a
// remove curse potion from the potion shop and drop their cursed weapon before doing any buying they need and going back
// out farming"; "Make sure they don't try to sell the cursed weapon while it's equipped or it cancels the transaction".
// Pins:
//   * the road: maxPerJourney null is no cap, and a road hunt does not spend a resumed journey's attempts (roadHuntResume);
//     every other short ending still does, and the two backstops (staleness, ROAD_HUNT_PAUSE_CAP) stand;
//   * the shape: town.hall and town.uncurse, refused when misspelt; guildTithe as a strategy key;
//   * the hall: what counts as hall cargo (loot grades only, never the dedicated weapon, never what is in hand), when money
//     goes (over bank_above, everything above the keep), the hall road's rooms and its pass through the edge guard;
//   * the curse errand IN ORDER: sell, buy the potion at Lady Aftyn's, drink, drop (read back), and only then the shopping;
//     a full stomach waits rather than spending an attempt; three failures are 'stuck', never a loop;
//   * the sale: a cursed weapon in hand, the hall cargo and anything equipped are never in an offer; everything else sells;
//   * an unread weapon is never wielded while the hall takes them.
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { Autopilot } from './m59-autopilot.mjs';
import { Session } from './m59-game.mjs';
import { readToolSource } from './autopilot/source.mjs';
import { normalizeTravelHunt, travelHuntDecision, roadHuntResume, ROAD_HUNT_PAUSE_CAP, TRAVEL_HUNT_ORIGINS } from './m59-travel-hunt.mjs';
import { normalizeFarmTown, farmTownRoadRooms, isHallBoundWeapon, hallDepositPlan, curseErrandNext, CURSE_TRIES,
         NORTH_BARLOQUE, FRULAR_ROOM } from './m59-farm-town.mjs';
import { normalizeGuildTithe } from './m59-tithe.mjs';
import { hallVisitConfig } from './m59-reagent-coop-runtime.mjs';
import { validateStrategy } from './m59-strategy-schema.mjs';
import { resolveItemName } from './m59-items.mjs';
import { sellAll, weaponRanking } from './m59-skills.mjs';
import { MARKET_KEEP } from './m59-items.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const throws = (f, re = null) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const quiet = { note() {}, ledgerEvent() {}, recordFrame() {} };

const MARION = {
  name: 'Marion',
  sell: [{ seller: 'Morrigan', room: 202 }, { seller: 'Colhorr', room: 201 }],
  buy: { food: [{ seller: 'Tova', room: 202, items: ['loaf of bread'] }] },
  bank: null,
  hall: { room: 714 },
  uncurse: { seller: 'Lady Aftyn', room: 205 },
};

console.log('\nthe road: uncapped, and a road hunt is not an attempt');
{
  const cfg = normalizeTravelHunt({ maxPerJourney: null });
  ok('maxPerJourney null is no cap', cfg.maxPerJourney === null);
  ok('a JSON round trip keeps it uncapped (Infinity would not survive one)',
     normalizeTravelHunt(JSON.parse(JSON.stringify(cfg))).maxPerJourney === null);
  const base = { cfg, journey: { travelling: true, origin: { source: 'keeper', name: 'town_trip' }, to: 202, room: 545 },
    health: { frac: 1, fleeAt: 0.3, engageAt: 0.7 }, vigor: { value: 150, floor: 60 },
    candidates: [{ id: 1, name: 'baby spider', d: 2 }], threats: 1 };
  ok('the hundredth fight on one road is still taken', travelHuntDecision({ ...base, budget: { fights: 100, lastAt: 0 } }).hunt);
  ok('a numeric cap still stops at the cap', !travelHuntDecision({ ...base, cfg: normalizeTravelHunt({ maxPerJourney: 3 }),
    budget: { fights: 3, lastAt: 0 } }).hunt);
  ok('the hall road is a work journey that may hunt', TRAVEL_HUNT_ORIGINS.includes('hall_deposit') && TRAVEL_HUNT_ORIGINS.includes('guild_tithe'));

  const j = { to: 546, at: 1000, attempts: 4, deaths_at: 0 };
  const hunted = roadHuntResume(j, { roadHunted: true, now: 5000 });
  ok('a resume a road hunt stopped keeps its attempts', hunted.attempts === 4 && hunted.road_hunt_pauses === 1);
  ok('... and keeps the first suspension\'s clock (the 30-minute staleness backstop)', hunted.at === 1000);
  ok('... and waits 5 s like any re-suspension', hunted.next_try_at === 10_000);
  const short = roadHuntResume(j, { roadHunted: false, trigger: 'no route', now: 5000 });
  ok('every other short ending still counts as an attempt', short.attempts === 5 && short.trigger === 'no route');
  let k = j;
  for (let i = 0; i < 40; i++) k = roadHuntResume(k, { roadHunted: true });
  ok('forty road fights on one resumed journey: still under the resume cap of 12', k.attempts === 4 && k.road_hunt_pauses === 40);
  const capped = roadHuntResume({ ...j, road_hunt_pauses: ROAD_HUNT_PAUSE_CAP }, { roadHunted: true });
  ok(`past ROAD_HUNT_PAUSE_CAP (${ROAD_HUNT_PAUSE_CAP}) a road hunt counts again (a runaway, not a road)`, capped.attempts === 5);
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the resume re-suspends through roadHuntResume, judged on a road hunt since THIS resume set out',
     /const resumedAt = Date\.now\(\);[\s\S]{0,4000}roadHuntResume\(j, \{\s*roadHunted: Number\(this\.travelHuntRoad\?\.lastAt \?\? 0\) >= resumedAt/.test(src));
  ok('no other attempts + 1 is left on the resume path', !/this\.suspendedJourney = \{ \.\.\.j, attempts: \(j\.attempts \?\? 0\) \+ 1/.test(src));
}

console.log('\nthe shape');
{
  const t = normalizeFarmTown(MARION, { resolveItem: resolveItemName });
  ok('hall defaults: magic weapons on, three open a trip', t.hall.room === 714 && t.hall.magicWeapons === true && t.hall.weaponsTripAt === 3);
  ok('uncurse defaults to the remove curse potion', t.uncurse.item === 'remove curse potion' && t.uncurse.room === 205);
  ok('silence: no hall, no uncurse', normalizeFarmTown({ sell: [{ seller: 'Morrigan', room: 202 }] }).hall === null);
  ok('a misspelt hall key is refused', throws(() => normalizeFarmTown({ ...MARION, hall: { room: 714, magicWeapon: true } }), /unrecognised/));
  ok('a misspelt uncurse key is refused', throws(() => normalizeFarmTown({ ...MARION, uncurse: { seller: 'Lady Aftyn', rom: 205 } })));
  ok('a hall alone is a town', normalizeFarmTown({ hall: { room: 714 } }).hall.room === 714);
  ok('guildTithe: a number, or { dailyAmount }', normalizeGuildTithe(800).daily_amount === 800
     && normalizeGuildTithe({ dailyAmount: 500 }).daily_amount === 500 && normalizeGuildTithe(null) === null);
  ok('guildTithe refuses a misspelt key and a zero', throws(() => normalizeGuildTithe({ daily: 5 })) && throws(() => normalizeGuildTithe(0)));
  const v = validateStrategy({ name: 'x', town: MARION, guildTithe: 800, travelHunt: { maxPerJourney: null } }, { resolveItem: resolveItemName });
  ok('a strategy carries all three, onto policy.farmTown / guildTithe / travelHunt', v.ok && v.strategy.desired.farmTown.hall.room === 714
     && v.strategy.desired.guildTithe.daily_amount === 800 && v.strategy.faculties.guildTithe === 'economy'
     && v.strategy.desired.travelHunt.maxPerJourney === null, v.why);
}

console.log('\nthe hall');
{
  const t = normalizeFarmTown(MARION);
  ok('the hall road: the public door, the hall, Frular', JSON.stringify(farmTownRoadRooms(t)) === JSON.stringify([NORTH_BARLOQUE, 714, FRULAR_ROOM]));
  ok('no hall, no road', farmTownRoadRooms(normalizeFarmTown({ sell: [{ seller: 'Morrigan', room: 202 }] })).length === 0);
  const isWeapon = n => /sword|axe|mace|hammer/.test(n);
  const row = (id, rarity, extra = {}) => ({ o: { id, rarity, amount: 0 }, name: 'long sword', isWeapon, equipped: new Set([99]), ...extra });
  ok('an unidentified weapon (100) is hall cargo', isHallBoundWeapon(row(1, 100)));
  ok('an identified magic grade (1, 2, 4) is hall cargo', [1, 2, 4].every(r => isHallBoundWeapon(row(1, r))));
  ok('a mundane weapon, and every Kraanan dedication (grade 0), is not', !isHallBoundWeapon(row(1, 0)));
  ok('a graded-cursed one (200) is not: it is the curse errand\'s', !isHallBoundWeapon(row(1, 200)));
  ok('never what is in hand', !isHallBoundWeapon(row(99, 100)));
  ok('never one the server called cursed', !isHallBoundWeapon(row(1, 100, { cursed: true })));
  ok('never one this keeper holds back (its dedicated weapon)', !isHallBoundWeapon(row(1, 1, { held: new Set([1]) })));
  ok('never its own conjured weapon', !isHallBoundWeapon(row(1, 100, { ownSummon: true })));
  ok('never something that is not a weapon', !isHallBoundWeapon({ ...row(1, 100), name: 'gold ring' }));
  ok('under bank_above with no weapons: no visit', !hallDepositPlan(t, { purse: 4000, keep: 400, bankAbove: 5000 }).go);
  const rich = hallDepositPlan(t, { purse: 6200, keep: 400, bankAbove: 5000 });
  ok('over bank_above: everything above the keep goes in', rich.go && rich.shillings === 5800);
  ok('bank_above 0 or null never sends money', !hallDepositPlan(t, { purse: 99999, keep: 0, bankAbove: 0 }).go);
  ok('two weapons wait, three go on their own', !hallDepositPlan(t, { purse: 0, bankAbove: 5000, weapons: 2 }).go
     && hallDepositPlan(t, { purse: 0, bankAbove: 5000, weapons: 3 }).go);
  ok('magicWeapons:false carries none', !hallDepositPlan(normalizeFarmTown({ ...MARION, hall: { room: 714, magicWeapons: false } }),
     { purse: 0, bankAbove: 5000, weapons: 9 }).go);
  const coopSrc = (await import('node:fs')).readFileSync(new URL('./m59-reagent-coop-runtime.mjs', import.meta.url), 'utf8');
  ok('the hall cargo goes in one weapon at a time, by id, judged by the id leaving the pack AND the chest gaining one',
     /for \(const id of state\.depositIds \?\? \[\]\)[\s\S]{0,600}depositOne\(k, b, live, cfg, receipt\)/.test(coopSrc)
     && /const moved = gone && intoBox >= 1 \? 1 : 0;/.test(coopSrc));
  ok('a resumed hall visit keeps its own config and road', /k\.coopVisit\?\.cfg \?\? options\.config \?\? coopConfig/.test(coopSrc)
     && /if \(!journey && state\?\.journey\) journey = state\.journey;/.test(coopSrc));
  const cfg = hallVisitConfig(714);
  ok('the hall visit is the coop\'s verified deposit, at 100% of the bank-bound money', cfg.shilling_tithe_pct === 100
     && cfg.hall_room === 714 && cfg.chest_keys.length >= 1);
}

console.log('\nthe hall road through the edge guard');
{
  const now = Date.now();
  const s = Object.assign(Object.create(Session.prototype), { movementGeneration: 7, world: { room: { num: 545 } },
    edgePass: { to: 101, rooms: [554, 564, 101], generation: 7, until: now + 60_000 } });
  ok('a crossing into a room on the road is let out, from whichever confined room', s.edgePassAllows(554));
  ok('a crossing anywhere else is still refused', !s.edgePassAllows(544) && s.edgeIntoRefused(544, [545, 546]));
  s.movementGeneration = 8;
  ok('a new movement generation ends the pass', !s.edgePassAllows(554));
  const old = Object.assign(Object.create(Session.prototype), { movementGeneration: 1, world: { room: { num: 2115 } },
    edgePass: { to: 2124, from: 2115, generation: 1, until: now + 60_000 } });
  ok('the survival exit\'s one-crossing pass is unchanged', old.edgePassAllows(2124) && !old.edgePassAllows(2133));
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('travel lets the hall road out of the confinement only when the caller says townRoad',
     /const hallRoadRooms = townRoad \? farmTownRoadRooms\(this\.policy\?\.farmTown\) : \[\];/.test(src)
     && /&& !approachRoom && !survivalExitLeg && !hallRoad\)/.test(src));
  ok('... and hands the step guard the road\'s rooms', /hallEdgePass \? \{ edgePass: hallEdgePass \}/.test(src));
  ok('the rent walk uses the hall road when the farm town has a hall',
     /travel\(700, \{ origin: keeperOrigin\('guild_tithe'\),[\s\S]{0,160}townRoad: true/.test(src));
}

console.log('\nthe curse errand, in the operator\'s order');
{
  const cursed = { id: 10, name: 'long sword', wielded: true };
  ok('no curse: nothing to do', curseErrandNext({}).step === 'none');
  ok('first the sale', curseErrandNext({ cursed, sold: false }).step === 'sell');
  ok('then the potion', curseErrandNext({ cursed, sold: true, potions: 0 }).step === 'buy_potion');
  ok('then the drink', curseErrandNext({ cursed, sold: true, potions: 1 }).step === 'drink');
  ok('then the drop, once the hand let go', curseErrandNext({ cursed: { ...cursed, wielded: false }, sold: true }).step === 'drop');
  ok('done when it is gone from the pack', curseErrandNext({ cursed, sold: true, inPack: false }).step === 'done');
  ok(`${CURSE_TRIES} failed drinks are stuck, never a loop`, curseErrandNext({ cursed, sold: true, potions: 1, tries: { drink: CURSE_TRIES } }).step === 'stuck');
  ok('no potion to be had is stuck', curseErrandNext({ cursed, sold: true, potions: 0, tries: { buy: CURSE_TRIES } }).step === 'stuck');
  ok('a drop that never takes is stuck', curseErrandNext({ cursed: { ...cursed, wielded: false }, sold: true, tries: { drop: CURSE_TRIES } }).step === 'stuck');

  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const steps = src.indexOf("['guild contribution', () =>");
  const at = n => src.indexOf(`['${n}', `, steps);
  ok('the trip runs sell, then the curse, then the rent and the hall, then the buying',
     at('sell') > 0 && at('sell') < at('lift the curse') && at('lift the curse') < at('guild tithe')
     && at('guild tithe') < at('hall deposit') && at('hall deposit') < at('buy food') && at('lift the curse') < at('restock here'),
     JSON.stringify(['sell', 'lift the curse', 'guild tithe', 'hall deposit', 'buy food'].map(at)));
}

// A FAKE BODY: a cursed long sword in hand (clings), a pack, Lady Aftyn's counter in 205, the potion and the drop.
function curseKeeper({ full = 0 } = {}) {
  const log = [];
  const rsc = new Map([[1, 'long sword'], [2, 'axe'], [3, 'remove curse potion'], [4, 'mollusk gem']]);
  const c = {
    selfId: 1000, evSeq: 0, rsc,
    inventory: [{ id: 10, nameRsc: 1, rarity: 100 }, { id: 11, nameRsc: 2, rarity: 0 }, { id: 12, nameRsc: 4, amount: 5 }],
    using: new Set([10]), _cursedItemIds: new Set([10]), purse: 500,
    messages: [],
    requestInventory() {}, buy() { log.push(['open shop', k.s.world.room.num]); },
    buyItems(_seller, lines) { log.push(['buy', k.s.world.room.num, lines]); c.inventory.push({ id: 600 + log.length, nameRsc: 3, amount: 0 }); c.purse -= 60; },
    apply(id) {
      if (full-- > 0) { c.messages.push('You are too full to drink anything else.'); log.push(['too full']); return; }
      log.push(['drink', id]); c.inventory = c.inventory.filter(o => o.id !== id); c.using.delete(10);
      c.messages.push('Your long sword loses its ominous luster.');
    },
    drop(specs) { for (const sp of specs) { const id = typeof sp === 'object' ? sp.id : sp; if (!c.using.has(id)) { log.push(['drop', id]); c.inventory = c.inventory.filter(o => o.id !== id); } } },
    async waitFor({ kinds }) {
      if (kinds.includes('shop')) return { events: [{ kind: 'shop', sellerId: 77, items: [{ id: 500, name: 'remove curse potion', cost: 60 }] }] };
      if (kinds.includes('message')) { const m = c.messages.splice(0); return { events: m.map(text => ({ kind: 'message', text })) }; }
      return { events: [{ kind: 'inventory' }] };
    },
  };
  const k = Object.assign(Object.create(Autopilot.prototype), quiet, {
    policy: { farmTown: normalizeFarmTown(MARION) },
    s: { name: 'fixture', client: c, need: () => c, world: { room: { num: 202 } }, pacer: { submit: async (_k, fn) => fn() } },
    travelInterrupted: () => false,
    purseNow: () => c.purse,
    async travel(room) { log.push(['walk', room]); this.s.world.room.num = room; return { arrived: true }; },
    async sellerHere({ named }) { log.push(['ask', named, this.s.world.room.num]); return { seller: { id: 77 }, items: [{ id: 500, name: 'remove curse potion', cost: 60 }] }; },
    recordPurchase() {},
  });
  return { k, c, log };
}

console.log('\nthe curse errand, on a body');
{
  const { k, c, log } = curseKeeper();
  ok('the wielded cursed sword is the one found', k.cursedWeaponCarried(c)?.id === 10 && k.cursedWeaponCarried(c).wielded);
  ok('the sale holds it out (saleExcludeIds)', k.saleExcludeIds().has(10));
  const trip = { startedAt: 1 };
  const r = await k.farmTownCurseErrand(trip);
  const kinds = log.map(a => a[0]);
  ok('it finishes (the trip goes on to the shopping)', r === null && trip.curse.finished, JSON.stringify(log));
  ok('walk to Lady Aftyn (205), buy there, then drink, then drop',
     kinds.indexOf('walk') < kinds.indexOf('buy') && kinds.indexOf('buy') < kinds.indexOf('drink') && kinds.indexOf('drink') < kinds.indexOf('drop')
     && log.find(a => a[0] === 'walk')[1] === 205 && log.find(a => a[0] === 'buy')[1] === 205, JSON.stringify(log));
  ok('asked the named counter for the potion', log.some(a => a[0] === 'ask' && a[1] === 'Lady Aftyn'));
  ok('the cursed sword is gone from the pack, the axe is not', !c.inventory.some(o => o.id === 10) && c.inventory.some(o => o.id === 11));
  ok('one potion, one drink, one drop', kinds.filter(x => x === 'buy').length === 1 && kinds.filter(x => x === 'drink').length === 1
     && kinds.filter(x => x === 'drop').length === 1);
  ok('a finished errand does nothing more', (await k.farmTownCurseErrand(trip)) === null && log.length === kinds.length);

  const full = curseKeeper({ full: 1 });
  const t2 = { startedAt: 2 };
  const first = await full.k.farmTownCurseErrand(t2);
  ok('too full to drink: wait, without spending a drink attempt', first?.pending === true && (t2.curse.tries.drink ?? 0) === 0
     && t2.curse.fullUntil > Date.now());
  t2.curse.fullUntil = 0;
  ok('... and the next pass drinks and drops', (await full.k.farmTownCurseErrand(t2)) === null && !full.c.inventory.some(o => o.id === 10));

  const clean = curseKeeper(); clean.c.using = new Set([11]); clean.c._cursedItemIds = new Set();
  clean.c.inventory[0].rarity = 0;
  ok('no curse: the step is a no-op', (await clean.k.farmTownCurseErrand({ startedAt: 3 })) === null && clean.log.length === 0);
}

console.log('\nthe sale never offers a cursed weapon in hand, the hall cargo, or anything equipped');
{
  const rsc = new Map([[1, 'long sword'], [2, 'axe'], [3, 'mace'], [4, 'mollusk gem'], [5, 'leather armor'], [6, 'dragon scale']]);
  const c = { rsc, statsById: new Map(), _cursedItemIds: new Set([10]),
    inventory: [{ id: 12, nameRsc: 4, amount: 5 }, { id: 10, nameRsc: 1, rarity: 100 }, { id: 11, nameRsc: 2, rarity: 0 },
                { id: 13, nameRsc: 3, rarity: 100 }, { id: 14, nameRsc: 5, rarity: 0 }, { id: 15, nameRsc: 6, amount: 2 }],
    using: new Set([10, 14]), requestInventory() {}, waitFor: async () => ({ events: [{ kind: 'inventory' }] }) };
  const offers = [];
  const s = { name: 'fixture', need: () => c, client: c, pacer: { submit: async (_k, fn) => fn() },
    async sellOne(_m, item, confirm) {
      offers.push({ id: item.id, confirm });
      if (confirm) c.inventory = c.inventory.filter(o => o.id !== item.id || (o.amount -= item.amount) > 0);
      return { sold: confirm, offered_price: 10 };
    } };
  const r = await sellAll(s, { merchant: { id: 99, name: 'Fixture' }, keep: MARKET_KEEP, maxWeapons: 0, exclude: new Set([10, 13]) });
  const offered = new Set(offers.map(o => o.id));
  ok('the sale completes and sells the rest', r.total_received > 0 && offered.has(12) && offered.has(15), JSON.stringify(offers));
  ok('the cursed sword in hand is never in an offer', !offered.has(10));
  ok('the hall cargo is never in an offer', !offered.has(13));
  ok('worn armour is never in an offer', !offered.has(14));

  // A HAND CAN CHANGE BETWEEN THE PLAN AND THE COUNTER: the per-offer check reads the use list again.
  c.inventory = [{ id: 21, nameRsc: 4, amount: 3 }, { id: 22, nameRsc: 2, rarity: 0 }];
  c.using = new Set();
  offers.length = 0;
  s.sellOne = async (_m, item, confirm) => {
    offers.push({ id: item.id, confirm });
    if (item.id === 21 && confirm) { c.inventory = c.inventory.filter(o => o.id !== 21); c.using.add(22); }   // wielded meanwhile
    return { sold: confirm, offered_price: 10 };
  };
  const r2 = await sellAll(s, { merchant: { id: 99, name: 'Fixture' }, keep: MARKET_KEEP, maxWeapons: 0 });
  ok('an item equipped between plan and counter is refused at the counter, not offered',
     !offers.some(o => o.id === 22) && r2.refused.some(x => /equipped/.test(x.why)), JSON.stringify({ offers, refused: r2.refused }));
}

console.log('\nan unread weapon is cargo, never wielded, while the hall takes them');
{
  const rsc = new Map([[1, 'mace'], [2, 'axe']]);
  const c = { rsc, statsById: new Map(), inventory: [{ id: 1, nameRsc: 1, rarity: 100 }, { id: 2, nameRsc: 2, rarity: 0 }], using: new Set() };
  ok('without the hall an unread mace is a candidate (operator 2026-10-23)', weaponRanking(c).some(r => r.o.id === 1));
  c._noUnreadWield = true;
  ok('with it, it is not', !weaponRanking(c).some(r => r.o.id === 1) && weaponRanking(c).some(r => r.o.id === 2));
  const k = Object.assign(Object.create(Autopilot.prototype), quiet, {
    policy: { farmTown: normalizeFarmTown(MARION) }, s: { name: 'fixture', client: c },
    weaponMagicBook: () => ({ reconcile() {}, keepIds: () => [2] }), packWeapons: () => [] });
  ok('the hall cargo is the unread mace, not the dedicated axe', JSON.stringify(k.hallBoundWeaponIds(c)) === '[1]');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper sets the flag from the farm town when it ranks', /c\._noUnreadWield = this\.policy\?\.farmTown\?\.hall\?\.magicWeapons === true;/.test(src));
  ok('the hall cargo is held back from the field cap, sharing and the loot count', /hallBoundWeaponIds\?\.\(c, new Set\(out\)\)/.test(src));
}

console.log('\nwhat opens a trip');
{
  const k = Object.assign(Object.create(Autopilot.prototype), quiet, {
    policy: { farmTown: normalizeFarmTown(MARION) }, walkingFloat: () => 400,
    cursedWeaponCarried: () => ({ id: 10, name: 'long sword', wielded: true }), hallBoundWeaponIds: () => [] });
  ok('a cursed weapon opens a trip', k.farmTownErrand(100, 5000)?.trigger === 'curse');
  k._curseTripAt = Date.now();
  ok('... once per 15 minutes', k.farmTownErrand(100, 5000) === null);
  k.cursedWeaponCarried = () => null;
  ok('money over bank_above opens a hall trip', k.farmTownErrand(6000, 5000)?.trigger === 'hall');
  k._hallTripAt = Date.now();
  ok('... once per 30 minutes', k.farmTownErrand(6000, 5000) === null);
  k.policy = { farmTown: null };
  ok('silence: no farm town, no errand', k.farmTownErrand(99999, 5000) === null);
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the bank run aims a farm errand at the town\'s counters (sell first)', /packFull: packFull \|\| !!farmErrand/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
