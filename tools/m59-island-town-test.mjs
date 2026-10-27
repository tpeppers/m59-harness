#!/usr/bin/env node
// TOWN TRIPS ON THE ISLAND, AND THE GUARD GATE -- offline, no socket, no roster.
//
//   node tools/m59-island-town-test.mjs
//
// Operator, 2026-10-27: island farmers sell at a full pack, and "the guard house provides unique restrictions around
// travel, and there are different shop NPCs on the island". What this pins:
//   * on the island (2000-2699) every town destination is a Ko'catan counter, never a mainland one: market (the smithy,
//     then the store, tailor, apothecary), bank (2005, a separate account), food (the inn, the tavern), reagents;
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
ok('the island sell circuit: smithy, store, tailor, apothecary', rooms(isl.MARKET_STOPS).join() === '2003,2004,2006,2002');
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
  ok('the keeper-opened trip passes the table', /richEnoughToBank: carried > above, table: townTable\(s\.world\?\.room\?\.num\)/.test(src));
  ok('a requested trip passes it too', /supplyTrip: town === 'supply',\s*table: townTable\(this\.s\.world\?\.room\?\.num\)/.test(src));
  ok('the sell circuit is the table\'s', /marketStops: wantsMarket \? townTable\(this\.s\.world\?\.room\?\.num\)\.MARKET_STOPS/.test(src));
  ok('so are the food shops', /const town = townTable\(s\.world\?\.room\?\.num\);\s*const shops = town\.FOOD_SHOPS/.test(src));
  ok('the travel gate asks the guard before walking', /const gate = this\.kocatanGateRefusal\?\.\(room\);/.test(src));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
