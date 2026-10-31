#!/usr/bin/env node
// TOWN TRIPS ON THE ISLAND, AND THE GUARD GATE -- offline, no socket, no roster.
//
//   node tools/m59-island-town-test.mjs
//
// Operator, 2026-10-27: island farmers sell at a full pack, and "the guard house provides unique restrictions around
// travel, and there are different shop NPCs on the island". What this pins:
//   * on the island (2000-2699) every town destination is a Ko'catan counter, never a mainland one: market (the smithy,
//     then the apothecary, the tailor, and the store last), bank (2005, a separate account), food (the inn, the tavern), reagents;
//   * on the mainland nothing changes;
//   * a journey from town into the jungle across the East Tower (2013 -> 2115) is refused when the guard would refuse
//     the pack (three weapons, two armours...), naming what; a legal pack, or a route that does not cross, goes;
//   * a strategy can say sellAtLoad; island-arrive carries one spare weapon at most.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const A = await import('./m59-autopilot.mjs');

console.log('the counters for where you stand');
const isl = A.townTable(2115), main = A.townTable(599);
ok('2115 is the island; 599 is not', isl.region === 'island' && main.region === 'mainland' && A.onIsland(2001) && !A.onIsland(1999));
const rooms = list => list.map(x => x.room);
ok('a full pack on the island goes to the Ko\'catan smithy first', rooms(A.townDestinations({ packFull: true, table: isl })).join() === '2003');
// The store (Pacal, finite shelf) is the catch-all, last: until 2026-10-27 it stood second and took the reagents Zala buys.
ok('the island sell circuit: smithy, apothecary, tailor, and the store last', rooms(isl.MARKET_STOPS).join() === '2003,2002,2006,2004');
ok('money on the island goes to Huital (2005)', rooms(A.townDestinations({ richEnoughToBank: true, table: isl })).join() === '2005');
ok('food on the island: the inn, then the tavern', rooms(A.townDestinations({ starving: true, table: isl })).join() === '2001,2008');
ok('reagents on the island: Zala (2002)', rooms(A.townDestinations({ supplyTrip: true, table: isl })).join() === '2002');
ok('NOTHING on the island table is off the island', [...isl.BANKS, ...isl.MARKET_STOPS, ...isl.FOOD_SHOPS, isl.REAGENT_SHOP].every(x => A.onIsland(x.room)));
ok('the mainland is unchanged', rooms(A.townDestinations({ packFull: true })).join() === rooms(A.MARKETS).join()
   && rooms(A.townDestinations({ richEnoughToBank: true, table: main })).join() === rooms(A.BANKS).join());

console.log('every town-trip site reads the table for where it stands');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper-opened trip passes the table', /richEnoughToBank: carried > above[^\n]*\n\s*table: townTable\(s\.world\?\.room\?\.num\)/.test(src));
  ok('a requested trip passes it too', /supplyTrip: town === 'supply',\s*table: townTable\(this\.s\.world\?\.room\?\.num\)/.test(src));
  ok('the sell circuit is the table\'s', /marketStops: wantsMarket \? townTable\(this\.s\.world\?\.room\?\.num\)\.MARKET_STOPS/.test(src));
  ok('so are the food shops', /const town = townTable\(s\.world\?\.room\?\.num\);\s*const shops = town\.FOOD_SHOPS/.test(src));
  ok('the travel gate asks the guard before walking', /let gate = this\.kocatanGateRefusal\?\.\(room\);/.test(src));
  ok('and clears the pack (sell / vault / drop) before refusing, at most every ten minutes, then asks again',
     /this\.policy\.kocatanGateClear !== false && !this\.townTrip\s*&& Date\.now\(\) - \(this\._gateClearAt \?\? 0\) > 600_000\)[\s\S]{0,300}await this\.kocatanGateClear\?\.\(\{ trigger: 'gate refusal', room \}\)[\s\S]{0,200}gate = this\.kocatanGateRefusal\?\.\(room\);/.test(src));
  ok('an island town trip ends by clearing the gate', /\["clear the Ko'catan gate", \(\) => this\.kocatanGateClear\(\{ trigger: 'town trip' \}\)/.test(src));
  ok('and a refusal opens a sell trip at the island counters (at most every ten minutes) so the next walk passes',
     /this\.operatorTripRequest = \{ town: 'market', why: `the Ko'catan gate refuses the pack/.test(src) && /!this\.operatorTripRequest && Date\.now\(\) - askedAt > 600_000/.test(src));
}

console.log('the guard gate');
{
  function keeper(items, { here = 2003, route = [{ from: 2003, to: 2000 }, { from: 2000, to: 2013 }, { from: 2013, to: 2115 }], worn = [] } = {}) {
    const c = { inventory: items.map((n, i) => ({ id: 10 + i, nameRsc: n, amount: 0 })), rsc: { get: k => k },
                equipment: () => ({ known: true, equipped: worn.map(i => ({ id: 10 + i, name: items[i] })) }) };
    return Object.assign(Object.create(A.Autopilot.prototype), { s: { client: c, world: { room: { num: here }, route: () => ({ found: true, hops: route }) } } });
  }
  const three = keeper(['long sword', 'axe', 'hammer'], { worn: [0] }).kocatanGateRefusal(2115);
  ok('three weapons across the gate: refused, naming the extra weapon', /refuses .*\(weapon\)/.test(three?.why ?? '') && three.over.length === 1, JSON.stringify(three));
  ok('two weapons pass', keeper(['long sword', 'axe'], { worn: [0] }).kocatanGateRefusal(2115) === null);
  ok('two suits of armour: refused', /armor/.test(keeper(['leather armor', 'chain armor'], { worn: [0] }).kocatanGateRefusal(2115)?.why ?? ''));
  ok('a route that does not cross the East Tower is not the guard\'s business',
     keeper(['long sword', 'axe', 'hammer'], { route: [{ from: 2003, to: 2000 }, { from: 2000, to: 2011 }, { from: 2011, to: 2120 }] }).kocatanGateRefusal(2120) === null);
  ok('a journey inside the town is not either', keeper(['long sword', 'axe', 'hammer']).kocatanGateRefusal(2005) === null);
  ok('from the jungle back to town (no gate on the way in): not checked', keeper(['long sword', 'axe', 'hammer'], { here: 2115 }).kocatanGateRefusal(2003) === null);
}

console.log('the strategy and the arrival');
{
  const { validateStrategy } = await import('./m59-strategy-schema.mjs');
  const v = validateStrategy({ name: 'x', hunt: 'troll', sellAtLoad: 1 });
  ok('a strategy can say "sell at a full pack"', v.ok && v.strategy.desired.sellAtLoad === 1, v.why);
  ok('and a nonsense fullness is refused', !validateStrategy({ name: 'x', hunt: 'troll', sellAtLoad: 2 }).ok);
  const arrive = readFileSync(new URL('./fleetscripts/island-arrive.mjs', import.meta.url), 'utf8');
  ok('island-arrive carries one spare weapon at most (the guard passes two in all)', /max_weapons: 1,/.test(arrive));
}

console.log('the avars by every clan name, and a cup that cannot go home');
{
  const { loadSpawns, creatureByName, huntMatcher } = await import('./m59-spawns.mjs');
  const sp = loadSpawns(A.SPAWN_FILE);
  ok('"kyip-kyip-kreeet avar warrior" is the Avar, level 120 (half of 2115 was "nothing is known about it")',
     creatureByName(sp, 'kyip-kyip-kreeet avar warrior')?.cls === 'Avar' && creatureByName(sp, 'kyip-kyip-kreeet avar warrior')?.level === 120);
  ok('so is the bone faction\'s "chyup-tewee faction warrior"', creatureByName(sp, 'chyup-tewee faction warrior')?.cls === 'Avar');
  ok('a hunt for the warrior takes both clans, and not their shamans',
     huntMatcher(sp, 'peet-seeeep avar warrior')('kyip-kyip-kreeet avar warrior') && !huntMatcher(sp, 'peet-seeeep avar warrior')('kyip-kyip-kreeet avar shaman'));
  const keeper = (here, confine = null) => Object.assign(Object.create(A.Autopilot.prototype),
    { s: { world: { room: { num: here } } }, policy: { confineRooms: confine }, hereRoom: () => here });
  ok('on the island, a mainland station is out of reach: the cup is not walked back (zero kills, 2026-10-27)',
     keeper(2115).chaliceStationOutOfReach({ station_room: 370 }) === true);
  ok('confined away from the station: out of reach', keeper(599, [599]).chaliceStationOutOfReach({ station_room: 370 }) === true);
  ok('on the mainland, unconfined: the cup goes home as before', keeper(599).chaliceStationOutOfReach({ station_room: 370 }) === false);
}

console.log('the island counters buy, and a stop that cannot sell does not hold the trip');
{
  // Prod, 2026-10-27: every island sell trip stood at Ixla's smithy for ever -- no Ko'catan counter was on SELL_TO, so
  // sellInTown answered null and the circuit returned pending every five seconds.
  const S = await import('./m59-skills.mjs');
  ok("the four Ko'catan counters are trusted buyers",
     ["Ixla cha'Totlak", "Pacal ix'Anoak", "Tepal ix'Zonak", "Zala ix'Mecya"].every(n => S.trustedBuyer(n)));
  ok("and the island's banker and vaultman are not", !S.trustedBuyer("Huital ko'Nosak") && !S.trustedBuyer("Itzal cha'Nosak vaultman"));
  function circuit(sales, { buyerHere = false } = {}) {
    const notes = [], visited = [];
    const objects = new Map(buyerHere ? [[5, { id: 5, nameRsc: "Ixla cha'Totlak", flags: 0xffffffff }]] : []);
    const k = Object.assign(Object.create(A.Autopilot.prototype), {
      s: { world: { room: { num: 2003 } }, client: { room: { objects }, rsc: { get: x => x } } },
      note: (w, d) => notes.push({ w, d }), travelInterrupted: () => false, suspendedJourney: null,
      travel: async room => { k.s.world.room.num = room; visited.push(room); return { arrived: true }; },
      sellInTown: async () => sales.shift() ?? null });
    return { k, notes, visited };
  }
  const trip = { marketStops: [{ room: 2003 }, { room: 2004 }] };
  const a = circuit([null, { sold: [{ name: 'mace' }], total_received: 40 }]);
  const r = await a.k.sellMarketCircuit(trip);
  ok('no trusted buyer at a stop: "sold nothing", and the circuit goes on to the next', !r.pending && trip.marketIndex === 2
     && a.visited.join() === '2004' && r.total_received === 40 && a.notes.some(n => n.w === 'sold nothing at this stop, moving on'),
     JSON.stringify({ r, visited: a.visited }));
  const t2 = { marketStops: [{ room: 2003 }] };
  const b = circuit([{ error: 'timeout' }, { error: 'timeout' }], { buyerHere: true });
  const first = await b.k.sellMarketCircuit(t2);
  const second = await b.k.sellMarketCircuit(t2);
  ok('a buyer here but a failed sale: retried once, then the stop ends', first.pending === true && !second.pending && t2.marketIndex === 1,
     JSON.stringify({ first, second }));
}

console.log('the gate as a loot cap, and the vault when selling did not clear it');
{
  // Operator 2026-10-27: "Handle the armors too". Island farmers looted a second armour off avar kills and the East Tower
  // guard refused them the jungle. Ixla's smithy sells chain and nerudite armour, so a spare is not worth a stranding.
  const k = Object.create(A.Autopilot.prototype);
  const cap = k.gateLootCap();
  ok('the guard\'s own classes: chain armor is armour, a long sword a weapon, an apple nothing',
     cap.classify('chain armor') === 'armor' && cap.classify('long sword') === 'weapon' && cap.classify('apple') === null);
  const { gateCapFilter } = await import('./m59-game.mjs');
  const inv = [{ name: 'leather armor' }, { name: 'long sword' }];
  const floor = [{ name: 'chain armor' }, { name: 'scale armor' }, { name: 'gold round shield' }, { name: 'long sword' }, { name: 'apple' }];
  const r = gateCapFilter(floor, inv, o => o.name, cap);
  ok('wearing leather: no armour from the floor; the first shield yes; weapons and food are not this rule\'s',
     r.keep.map(o => o.name).join() === 'gold round shield,long sword,apple' && r.skipped.join() === 'chain armor,scale armor', JSON.stringify(r));
  const bare = gateCapFilter([{ name: 'chain armor' }, { name: 'scale armor' }], [], o => o.name, cap);
  ok('an unarmoured farmer takes ONE armour, not two', bare.keep.length === 1 && bare.skipped.length === 1);
  ok('off the island, no cap', gateCapFilter(floor, inv, o => o.name, null).keep.length === floor.length);
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper hands the looter the cap where gateCapApplies says', /s\.setGateCap\?\.\(gateCapApplies\(s\.world\?\.room\?\.num\) \? this\.gateLootCap\(\) : null\)/.test(src));
  ok("the cap: Ko'catan and the near jungle yes; the trading post's rooms (2101, 2143, 2144, 2154) and the mainland no",
     A.gateCapApplies(2001) && A.gateCapApplies(2133) && A.gateCapApplies(2115)
     && !A.gateCapApplies(2101) && !A.gateCapApplies(2143) && !A.gateCapApplies(2144) && !A.gateCapApplies(2154) && !A.gateCapApplies(599));
  ok('a refusal within the hour after the sell trip vaults the excess', /askedAt && Date\.now\(\) - askedAt > 180_000 && Date\.now\(\) - askedAt < 3_600_000[\s\S]{0,200}this\.kocatanGateVault/.test(src));

  // The vault deposit: exact ids, the worn piece never.
  const calls = [];
  const objects = new Map([[7, { id: 7, nameRsc: "Itzal cha'Nosak", flags: 0 }]]);
  const v = Object.assign(Object.create(A.Autopilot.prototype), {
    s: { world: { room: { num: 2005 } }, client: { room: { objects }, rsc: { get: x => x } } }, note: () => {} });
  const S = await import('./m59-skills.mjs');
  const real = S.depositInVault;
  const gate = { over: [{ id: 41, name: 'chain armor', category: 'armor', was_equipped: false },
                        { id: 40, name: 'chain armor', category: 'armor', was_equipped: true }] };
  // depositInVault is called through the skills namespace; record its arguments with a fake session underneath.
  v.s.need = () => ({ inventory: [{ id: 40, nameRsc: 'chain armor' }, { id: 41, nameRsc: 'chain armor' }], rsc: { get: x => x },
    requestInventory: () => {}, waitFor: async () => ({}), evSeq: 0, depositItems: (who, specs) => calls.push({ who, specs }) });
  v.s.pacer = { submit: async (_k, f) => f() };
  await v.kocatanGateVault(gate).catch(() => {});
  ok('the vault gets the spare by id (41), never the worn chain armor (40)', calls.length === 1 && JSON.stringify(calls[0].specs) === '[41]' && calls[0].who === 7,
     JSON.stringify(calls));
}

console.log('a confined journey keeps to the confinement on the way, not only at the end');
{
  // Prod 2026-10-27: Lew, confined to the town, 2013, 2115 and 2125, sent from 2124 to the smithy -- his keeper planned
  // through 2133 (eight avars) and he played dead at 52/90.
  const M = await import('./m59-map.mjs');
  const map = M.loadMap();
  const confine = [2125, 2115, 2013, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2008, 2009];
  const k = (here, extra = {}) => Object.assign(Object.create(A.Autopilot.prototype),
    { s: { world: { map, room: { num: here } } }, policy: { confineRooms: confine, ...extra } });
  const inside = k(2013).confinementAvoid(2003);
  ok('from inside: every room outside the confinement is avoided (2133 and 2124 among them), none inside',
     inside?.includes(2133) && inside.includes(2124) && !inside.includes(2000) && !inside.includes(2003));
  const outside = k(2124).confinementAvoid(2003);
  ok('from OUTSIDE (Lew in 2124): the confined road home is used when the graph has one',
     outside?.includes(2133) && !outside.includes(2124));
  ok('and that road goes back through 2115, not deeper into the jungle',
     M.findPath(map, 2124, 2003, { avoid: new Set(outside) })?.hops?.map(h => h.to).join() === '2115,2013,2000,2009,2003');
  ok('a destination outside the confinement is the gate\'s business, not this', k(2013).confinementAvoid(2133) === null);
  ok('no confinement, no avoid', Object.assign(k(2013), { policy: {} }).confinementAvoid(2003) === null);
  ok('chalice duty keeps its exemption', k(2013).confinementAvoid(2003, { chalice: true }) === null);
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper passes it to the session travel', /const confinedAvoid = this\.confinementAvoid\?\.\(room[\s\S]{0,300}avoid: \[\.\.\.new Set\(\[\.\.\.\(sessionOpts\.avoid/.test(src));
}

console.log('the Ko\'catan bank banks, reads it back, and a visit that banked nothing does not reopen');
{
  // Prod 2026-10-27: Scooter (25,113 in his purse, bank_above 25,000) opened a bank trip to 2005 every two minutes. Neither
  // "The Hungry Vaults" nor "Huital ko'Nosak" says "bank", so bankSurplus returned before depositing, silently.
  function banker({ pays = true, purse = 25113 } = {}) {
    const deposits = [], notes = [];
    const inv = [{ id: 1, nameRsc: 'shillings', amount: purse }];
    const c = { room: { objects: new Map([[9, { id: 9, nameRsc: "Huital ko'Nosak", flags: 0 }]]) }, rsc: { get: x => x },
      inventory: inv, requestInventory: () => {}, waitFor: async () => ({ events: [] }), vitals: () => ({ vigor: { value: 150 } }),
      deposit: n => { deposits.push(n); if (pays) inv[0].amount -= n; } };
    const k = Object.assign(Object.create(A.Autopilot.prototype), {
      s: { need: () => c, client: c, world: { room: { num: 2005, name: 'The Hungry Vaults' } }, pacer: { submit: async (_k, f) => f() } },
      policy: {}, tally: {}, note: (w, d) => notes.push({ w, d }), progress: () => {}, tradeFact: () => {},
      walkingFloat: () => 400, larder: () => [], deliveryCashReserve: () => 0, standingOrderReserve: () => 0,
      purseNow: () => inv[0].amount });
    return { k, deposits, notes, inv };
  }
  const a = banker();
  await a.k.bankSurplus();
  ok("in Ko'catan's bank, Huital takes the surplus", a.deposits.length === 1 && a.inv[0].amount === 400 && a.notes.some(n => n.w === 'banked the surplus'),
     JSON.stringify({ d: a.deposits, notes: a.notes.map(n => n.w) }));
  const b = banker({ pays: false });
  await b.k.bankSurplus();
  ok('a deposit that moves nothing is read back as a failure', b.notes.some(n => n.w === 'could not bank') && b.k._bankedNothingAt > 0);
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('and the next bank trip waits half an hour', /richEnoughToBank: carried > above && !\(Date\.now\(\) - \(this\._bankedNothingAt \?\? 0\) < 1_800_000\)/.test(src));
}

console.log('leaving town with a pack the guard passes: sell, vault, drop (operator 2026-10-29)');
{
  // Prod 2026-10-29: Robin's conjured long sword was protected (not sold) and conjured (the vaultman refused it), so the
  // refusal ladder had no last rung and he stood in town six hours.
  const G = await import('./m59-kocatan-gate.mjs');
  const plan = G.gateClearPlan([
    { id: 1, name: 'nerudite sword', rarity: 0 }, { id: 2, name: 'long sword', rarity: 0 },
    { id: 3, name: 'scimitar', rarity: 2 }, { id: 4, name: 'chain armor', was_equipped: true }], { protect: ['Long Sword'] });
  ok('plain loot is sold; protected and unidentified/magic go to the vault; worn is left alone',
     plan.sell.map(i => i.id).join() === '1' && plan.vault.map(i => i.id).join() === '2,3', JSON.stringify(plan));
  ok('the station is the assigned jungle room, else the first confined one past the gate',
     G.gateStation({ assignedRoom: 2125 }) === 2125 && G.gateStation({ assignedRoom: 2005, confineRooms: [2005, 2115] }) === 2115
     && G.gateStation({ assignedRoom: 2005, confineRooms: [2005] }) === null);

  function clearer({ policy = { assignedRoom: 2115 }, vaultTakes = false, smithBuys = true } = {}) {
    const names = ['long sword', 'axe', 'hammer', 'nerudite sword'];
    const inv = names.map((n, i) => ({ id: 10 + i, nameRsc: n, amount: 0, rarity: 0 }));
    const log = { sold: [], vaulted: [], dropped: [], walked: [], notes: [] };
    const smith = { id: 7, nameRsc: "Ixla cha'Totlak", flags: 0 };
    const c = { inventory: inv, rsc: { get: k => k }, using: new Set([10]), room: { objects: new Map([[7, smith]]) },
      equipment: () => ({ known: true, equipped: [{ id: 10, name: 'long sword' }] }),
      requestInventory: () => {}, waitFor: async () => ({}),
      drop: specs => { for (const sp of specs) { const id = typeof sp === 'object' ? sp.id : sp; const at = inv.findIndex(o => o.id === id);
                                                  if (at >= 0) { log.dropped.push(inv[at].nameRsc); inv.splice(at, 1); } } } };
    const room = { num: 2005 };
    const k = Object.assign(Object.create(A.Autopilot.prototype), {
      policy, note: (w, d) => log.notes.push({ w, d }), tradeFact: () => {}, saleProtectedNames: () => ['hammer'],
      s: { client: c, need: () => c, pacer: { submit: async (_k, f) => f() },
           world: { room, route: () => ({ found: true, hops: [{ from: room.num, to: 2000 }, { from: 2000, to: 2013 }, { from: 2013, to: 2115 }] }) },
           sellOne: async (_m, offer, confirm) => {
             if (!smithBuys) return { offered_price: null };
             if (confirm) { const at = inv.findIndex(o => o.id === offer.id); log.sold.push(inv[at].nameRsc); inv.splice(at, 1); return { sold: true, offered_price: 40 }; }
             return { offered_price: 40 };
           } },
      travel: async to => { log.walked.push(to); room.num = to; return { arrived: true }; },
      kocatanGateVault: async gate => {
        if (!vaultTakes) return { vaulted: false };
        for (const o of gate.over.filter(o => !o.was_equipped)) { const at = inv.findIndex(x => x.id === o.id); log.vaulted.push(inv[at].nameRsc); inv.splice(at, 1); }
        return { vaulted: true, result: { deposited: log.vaulted.map(name => ({ name, amount: 1 })) } };
      } });
    return { k, inv, log };
  }
  const a = clearer();
  const ra = await a.k.kocatanGateClear();
  ok('three spare weapons: the plain one sold at the smithy (2003), the protected one the vaultman refused is DROPPED, the worn one kept',
     ra.cleared && a.log.walked.join() === '2003' && a.log.sold.join() === 'nerudite sword' && a.log.dropped.join() === 'hammer'
     && a.inv.map(o => o.nameRsc).join() === 'long sword,axe', JSON.stringify({ ra, log: a.log }));
  const b = clearer({ vaultTakes: true, smithBuys: false });
  const rb = await b.k.kocatanGateClear();
  ok('when the smithy will not buy, the vault takes it, and nothing is dropped',
     rb.cleared && b.log.sold.length === 0 && b.log.vaulted.length === 2 && b.log.dropped.length === 0, JSON.stringify(b.log));
  const off = clearer({ policy: { assignedRoom: 2115, kocatanGateClear: false } });
  const ro = await off.k.kocatanGateClear();
  ok('policy kocatanGateClear:false does nothing', !ro.cleared && off.log.walked.length + off.log.sold.length + off.log.dropped.length === 0);
  const magic = clearer();
  magic.inv[2].rarity = 2;   // the hammer is unidentified/magic: vaulted if he takes it, never dropped
  const rm = await magic.k.kocatanGateClear();
  ok('unread magic the vaultman refuses is kept and named, not dropped', !rm.cleared && rm.left.includes('hammer')
     && !magic.log.dropped.includes('hammer') && magic.log.sold.join() === 'nerudite sword', JSON.stringify(rm));
  const town = clearer({ policy: { assignedRoom: 2005, confineRooms: [2005] } });
  const rt = await town.k.kocatanGateClear();
  ok('a farm that is not past the gate: nothing to clear', /no farm past the gate/.test(rt.why ?? '') && town.inv.length === 4);
}

console.log('the Avar Village: the trading post is its town and its safe room (operator 2026-10-29)');
{
  const v = A.townTable(2154), post = A.townTable(2101), clearing = A.townTable(2144);
  ok('2154, 2144 and 2101 read the village table; 2133 (the road) and 2115 do not',
     v.region === 'avar-village' && post.region === 'avar-village' && clearing.region === 'avar-village'
     && A.townTable(2133).region === 'island' && A.townTable(2115).region === 'island');
  ok('a full pack in the village sells at Wulfgang (2101); food and supplies are his too',
     rooms(A.townDestinations({ packFull: true, table: v })).join() === '2101'
     && rooms(A.townDestinations({ starving: true, table: v })).join() === '2101'
     && rooms(A.townDestinations({ supplyTrip: true, table: v })).join() === '2101');
  ok('no bank in the village: a bank trip has nowhere to go (and so is not opened)',
     A.townDestinations({ richEnoughToBank: true, table: v }).length === 0);
  const S = await import('./m59-skills.mjs');
  ok("Wulfgang zax'Ak is a trusted buyer (a quoted sale), the bankers still are not",
     S.trustedBuyer("Wulfgang zax'Ak") && !S.trustedBuyer("Huital ko'Nosak"));
  const hops = { 2144: 1, 2101: 2 };
  const k = Object.assign(Object.create(A.Autopilot.prototype), { note: () => {}, policy: { confineRooms: [2154, 2144, 2101] },
    s: { world: { room: { num: 2154 }, route: to => hops[to] ? { found: true, hops: Array(hops[to]).fill({}) } : { found: false } } } });
  const best = k.nearestSanctuary({ maxHops: 3 });
  ok('from the village the safe room is the trading post (2101), not the nearer quiet clearing (2144)',
     best?.room === 2101 && best.isInn === true, JSON.stringify(best));
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the long eat-and-wait before a journey happens only in a no-combat room, waiting in one-second slices',
     /const safeRoom = isNoCombatRoom\(/.test(src) && /if \(od && vigor < reach - 5 && safeRoom\)/.test(src)
     && /setTimeout\(res, 1000\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
