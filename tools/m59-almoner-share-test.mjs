#!/usr/bin/env node
// OFFLINE TEST FOR THE ALMONER'S SHARING RULES. Opens no socket, touches no roster.
//
//   node tools/m59-almoner-share-test.mjs
//
// Every assertion here is a bug that reached prod. The two that cost a pass on 2026-09-05 are
// "spreads across donors standing in the same room" and "deals the densest food first".
import { foodDensity, orderLarder, dealShare, chooseDonor, planFoodHandovers, alreadyStocked,
         invisibleFoodNames, splitRoomsAmong } from './m59-almoner-share.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
                              `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const PORK = { name: 'slice of pork', nutrition: 9, filling: 20 };
const EYE = { name: 'spider eye', nutrition: 9, filling: 20 };
const INKY = { name: 'inky-cap mushroom', nutrition: 50, filling: 25 };
const SKIN = { name: 'water skin', nutrition: 3, filling: 6 };

// ---------------------------------------------------------------- density and ordering
ok('inky-cap outranks pork per unit of stomach', foodDensity(INKY) > foodDensity(PORK));
ok('a zero-filling food does not divide by zero', Number.isFinite(foodDensity({ nutrition: 200, filling: 0 })));
eq('larder orders densest first',
   orderLarder([{ id: 1, amount: 5, food: PORK }, { id: 2, amount: 5, food: INKY },
                { id: 3, amount: 5, food: SKIN }]).map(s => s.id),
   [2, 3, 1]);

// ---------------------------------------------------------------- dealing a share
{
  // The bug this pins: dealing in pack order handed over the water skins and left the
  // inky-caps behind, which is 15 vigor instead of 200 over the same stomach.
  const { give, dealt } = dealShare([{ id: 7, amount: 4, food: SKIN },
                                     { id: 8, amount: 10, food: INKY }], 6, 0);
  eq('deals the dense stack first', give, [{ id: 8, amount: 6 }]);
  eq('deals exactly what was asked', dealt, 6);
}
{
  const { give, dealt } = dealShare([{ id: 1, amount: 3, food: PORK },
                                     { id: 2, amount: 4, food: PORK }], 6, 0);
  eq('spans stacks when one is not enough', give, [{ id: 1, amount: 3 }, { id: 2, amount: 3 }]);
  eq('spanning still deals the whole share', dealt, 6);
}
{
  // Handing away the last of it just moves the problem — the courier has to eat too.
  const { give, dealt } = dealShare([{ id: 1, amount: 12, food: PORK }], 20, 10);
  eq('keeps the keep-back and deals the rest', give, [{ id: 1, amount: 2 }]);
  eq('a short larder deals what it can', dealt, 2);
}
eq('nothing to spare deals nothing', dealShare([{ id: 1, amount: 8, food: PORK }], 20, 10).give, []);
eq('a stack with no id is not offered', dealShare([{ id: null, amount: 99, food: PORK }], 5, 0).give, []);

// ---------------------------------------------------------------- who gives
const hops = (a, b) => (a === b ? 0 : Math.abs(a - b) > 100 ? Infinity : 1);
const donor = (agent, room, meals) => ({ agent, character: agent, room, meals });
const eater = (agent, room, vigor = 80) => ({ agent, character: agent, room, meals: 0, vigor, target: 80 });

{
  // THE COMPARATOR BUG, IN ONE ASSERTION. Two donors, both standing in the recipient's room,
  // one holding materially more. On prod this planned all seven hand-overs out of the smaller
  // larder because the same-room clause short-circuited before the stock tie-break was read.
  const donors = [donor('big', 39, 224), donor('small', 39, 191)];
  const pick = chooseDonor(donors, eater('hungry', 39), {
    left: new Map([['big', 224], ['small', 191]]), trips: new Map([['big', 0], ['small', 0]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  eq('picks the fuller of two donors in the same room', pick.agent, 'big');
}
{
  const donors = [donor('far', 70, 900), donor('near', 39, 100)];
  const pick = chooseDonor(donors, eater('hungry', 39), {
    left: new Map([['far', 900], ['near', 100]]), trips: new Map([['far', 0], ['near', 0]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  eq('a room-mate beats a richer donor a walk away', pick.agent, 'near');
}
{
  // The locality cap is about walks. A donor that has already made its two trips must still be
  // allowed to hand food to somebody standing next to it.
  const donors = [donor('d', 39, 900)];
  const pick = chooseDonor(donors, eater('hungry', 39), {
    left: new Map([['d', 900]]), trips: new Map([['d', 5]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  ok('a spent donor still feeds its own room', pick?.agent === 'd');
}
{
  const donors = [donor('d', 70, 900)];
  const pick = chooseDonor(donors, eater('hungry', 39), {
    left: new Map([['d', 900]]), trips: new Map([['d', 2]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  ok('but it will not be sent on a third walk', pick === undefined);
}
{
  const donors = [donor('d', 900, 900)];
  const pick = chooseDonor(donors, eater('hungry', 39), {
    left: new Map([['d', 900]]), trips: new Map([['d', 0]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  ok('an unreachable donor is not asked', pick === undefined);
}
{
  const donors = [donor('self', 39, 900)];
  const pick = chooseDonor(donors, { agent: 'self', room: 39, meals: 900, vigor: 80 }, {
    left: new Map([['self', 900]]), trips: new Map([['self', 0]]),
    foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  ok('nobody supplies themselves', pick === undefined);
}

// ---------------------------------------------------------------- the whole round
{
  const larders = [
    { agent: 'big', character: 'Fozzie', room: 39, meals: 224, nutrition: 2016, vigor: 173, target: 200 },
    { agent: 'small', character: 'Kermit', room: 39, meals: 191, nutrition: 1719, vigor: 142, target: 200 },
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(n =>
      ({ agent: n, character: n, room: 39, meals: 0, nutrition: 0, vigor: 80, target: 80 })),
  ];
  const { donors, hungry, plan } = planFoodHandovers({
    larders, foodAmount: 20, keepFood: 10, floor: 140, maxHops: 2, maxDeliveries: 2, hops });
  eq('both surpluses are donors', donors.map(d => d.agent), ['big', 'small']);
  eq('all eight empty packs are hungry', hungry.length, 8);
  eq('a free room feeds everyone in one pass', plan.length, 8);
  ok('and spreads the load across both larders',
     new Set(plan.map(p => p.from.agent)).size === 2,
     `all from ${[...new Set(plan.map(p => p.from.agent))]}`);
  ok('every hand-over in one room is walk-free', plan.every(p => p.sameRoom));
  // The donors must not be dealt past their keep-back, however many room-mates are starving.
  for (const d of donors) {
    const given = plan.filter(p => p.from.agent === d.agent).length * 20;
    ok(`${d.character} keeps something back`, d.meals - given >= 10, `left ${d.meals - given}`);
  }
}
{
  // A character whose own target has been dropped to the resting cap still reads as hungry,
  // because the test is the floor this run intends to give it.
  const larders = [{ agent: 'x', character: 'x', room: 39, meals: 0, nutrition: 0, vigor: 80, target: 80 }];
  eq('a satisfied-looking 80/80 is hungry against a floor of 140',
     planFoodHandovers({ larders, foodAmount: 20, keepFood: 10, floor: 140,
                         maxHops: 2, maxDeliveries: 2, hops }).hungry.length, 1);
}

// ---------------------------------------------------------------- the free vigor
{
  const larders = [
    { agent: 'gonzo', character: 'Gonzo', room: 953, meals: 100, nutrition: 900, vigor: 114, target: 80 },
    { agent: 'scooter', character: 'Scooter', room: 39, meals: 140, nutrition: 1260, vigor: 80, target: 80 },
    { agent: 'fed', character: 'Pepe', room: 39, meals: 130, nutrition: 1170, vigor: 112, target: 200 },
    { agent: 'empty', character: 'Piggy', room: 950, meals: 0, nutrition: 0, vigor: 61, target: 80 },
    { agent: 'thin', character: 'Robin', room: 39, meals: 2, nutrition: 18, vigor: 80, target: 80 },
  ];
  const found = alreadyStocked(larders, 140).map(h => h.agent);
  eq('finds the stocked characters pinned at a low floor', found, ['gonzo', 'scooter']);
  ok('leaves alone one whose floor is already high', !found.includes('fed'));
  ok('does not promise an empty pack a climb it cannot make', !found.includes('empty'));
  ok('nor one holding less than the climb costs', !found.includes('thin'));
}


// ------------------------------------------------- food the harness cannot see
// `foodValue` is a raw lowercase lookup, so a plural wire name misses it, `larderOf` returns
// nothing and `has_food` reads false while the pack is full. The floor then collapses to 80
// and the character never eats. Prod, 2026-09-05: Scooter carrying 86 spider eyes at 80/80.
{
  const larders = [
    { agent: 'a', character: 'Scooter', meals: 86, harnessSeesFood: false, alive: true,
      stacks: [{ id: 1, name: 'spider eye', amount: 86, food: EYE }] },
    { agent: 'b', character: 'Bunsen', meals: 20, harnessSeesFood: false, alive: true,
      stacks: [{ id: 2, name: 'water skin', amount: 6, food: SKIN },
               { id: 3, name: 'spider eye', amount: 14, food: EYE }] },
    { agent: 'c', character: 'Fozzie', meals: 228, harnessSeesFood: true, alive: true,
      stacks: [{ id: 4, name: 'slice of pork', amount: 228, food: PORK }] },
    // The innocent case: mid-rejoin, no client, so larderOf honestly returns nothing.
    { agent: 'd', character: 'Sweetums', meals: 9, harnessSeesFood: false, alive: false,
      stacks: [{ id: 5, name: 'slice of pork', amount: 9, food: PORK }] },
  ];
  const bad = invisibleFoodNames(larders);
  eq('names the food the harness cannot resolve', [...bad].sort(), ['spider eye', 'water skin']);
  ok('does not indict pork on a mid-rejoin row', !bad.has('slice of pork'));
}
{
  // A donor holding both deals the pork first, even though the two are equally dense —
  // because only one of them will make the recipient's floor hold.
  const suspect = new Set(['spider eye']);
  const stacks = [{ id: 1, name: 'spider eye', amount: 50, food: EYE },
                  { id: 2, name: 'slice of pork', amount: 50, food: PORK }];
  eq('deals food the harness can see first', dealShare(stacks, 20, 0, suspect).give,
     [{ id: 2, amount: 20 }]);
  // But it is still food. With nothing better, hand it over rather than starve them.
  eq('still deals invisible food when there is nothing else',
     dealShare([stacks[0]], 20, 0, suspect).give, [{ id: 1, amount: 20 }]);
  // And density still decides among the visible ones.
  eq('visible-first does not override density among the visible',
     orderLarder([{ id: 1, name: 'slice of pork', amount: 5, food: PORK },
                  { id: 2, name: 'inky-cap mushroom', amount: 5, food: INKY },
                  { id: 3, name: 'spider eye', amount: 5, food: EYE }], suspect).map(s => s.id),
     [2, 1, 3]);
}


{
  // Raising a floor and handing over food are alternatives, not both. Prod, 10:50 pass: the only
  // two hand-overs planned went to characters that same pass had just raised, and both failed.
  const larders = [
    { agent: 'rich', character: 'Kermit', room: 39, meals: 191, nutrition: 1719, vigor: 150, target: 200 },
    // Can already climb to 140 on its own larder — raised, not fed.
    { agent: 'stocked', character: 'Robin', room: 39, meals: 7, nutrition: 350, vigor: 80, target: 80 },
    // Genuinely empty.
    { agent: 'empty', character: 'Zoot', room: 39, meals: 0, nutrition: 0, vigor: 80, target: 80 },
  ];
  const handled = new Set(alreadyStocked(larders, 140).map(h => h.agent));
  eq('the stocked one is the one that gets raised', [...handled], ['stocked']);
  const { hungry, plan } = planFoodHandovers({
    larders, foodAmount: 20, keepFood: 10, floor: 140, maxHops: 2, maxDeliveries: 2, hops,
    alreadyHandled: handled });
  eq('a character raised this pass is not also fed', hungry.map(h => h.agent), ['empty']);
  eq('and the exchange goes to the empty pack instead', plan.map(p => p.to.agent), ['empty']);
  // Without the exclusion both would have been planned, which is the bug.
  eq('unfiltered, both would have been queued',
     planFoodHandovers({ larders, foodAmount: 20, keepFood: 10, floor: 140,
                         maxHops: 2, maxDeliveries: 2, hops }).hungry.length, 2);
}


// ------------------------------------------------- a room number is not a place
// Room 39 is 17x48 and its walkable area is two components — cols 1-24 and cols 27-47 — each
// owning one of the two doorways to room 38. Two characters "in 39" may be unable to reach each
// other. The fleet row carries no coordinates, so which half is unknowable; the tool must stop
// treating the pair as free rather than pretend to know.
{
  const split = new Set([39]);
  const donors = [donor('d', 39, 900)];
  const opts = (trips) => ({ left: new Map([['d', 900]]), trips: new Map([['d', trips]]),
                             foodAmount: 20, keepFood: 10, maxHops: 2, maxDeliveries: 2, hops });
  // In an ordinary room a spent donor still feeds its own room for free.
  ok('unsplit: a spent donor still feeds its own room',
     chooseDonor(donors, eater('h', 39), { ...opts(5) })?.agent === 'd');
  // In a split room the same donor is subject to the walk cap, because it may have to walk.
  ok('split: a spent donor is NOT given another free same-room delivery',
     chooseDonor(donors, eater('h', 39), { ...opts(5), splitRooms: split }) === undefined);
  ok('split: it is still chosen while under the cap',
     chooseDonor(donors, eater('h', 39), { ...opts(0), splitRooms: split })?.agent === 'd');
}
{
  // The whole round: one donor, four empty room-mates, in a split room. Unsplit it feeds all
  // four for free; split it is held to the delivery cap.
  const larders = [
    { agent: 'rich', character: 'Fozzie', room: 39, meals: 400, nutrition: 3600, vigor: 180, target: 200 },
    ...['a','b','c','d'].map(n => ({ agent: n, character: n, room: 39, meals: 0, nutrition: 0, vigor: 80, target: 80 })),
  ];
  const base = { larders, foodAmount: 20, keepFood: 10, floor: 140, maxHops: 2, maxDeliveries: 2, hops };
  eq('unsplit: one donor feeds the whole room in a pass',
     planFoodHandovers(base).plan.length, 4);
  const p = planFoodHandovers({ ...base, splitRooms: new Set([39]) }).plan;
  eq('split: held to the walk cap instead', p.length, 2);
  ok('and every such pair is flagged as possibly the far half', p.every(x => x.maybeFarHalf && !x.free));
}
{
  // Derived from the bake, not hard-coded. A room with one walkable blob is not split; slivers
  // below minPart do not count, or every outdoor room would be.
  const fakeGeo = (rows, cols, solidCols) => ({
    rows, cols, walkable: (r, c) => !solidCols.includes(c),
  });
  const map = { rooms: { '1': { roo: {} }, '2': { roo: {} } } };
  const two = splitRoomsAmong([1], { map, geometryFor: () => fakeGeo(10, 20, [10, 11]) });
  eq('a wall down the middle is two pieces', [...two], [1]);
  const one = splitRoomsAmong([1], { map, geometryFor: () => fakeGeo(10, 20, []) });
  eq('an open room is one piece', [...one], []);
  const sliver = splitRoomsAmong([1], { map, geometryFor: () => fakeGeo(10, 20, [19]) });
  eq('a one-column sliver is not a half', [...sliver], []);
  eq('a room with no baked geometry is skipped',
     [...splitRoomsAmong([9], { map, geometryFor: () => fakeGeo(10, 20, [10]) })], []);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
