#!/usr/bin/env node
// PUTTING THE PACK DOWN IN THE STREET — offline, no server, no broker.
//
//   node tools/m59-dropall-test.mjs
//
// A character on a route that passes no merchant is hauling loot it will never sell, and on
// the feast run that is eleven hops out and eleven back in a pack whose whole purpose is to
// come home full of the Duke's food. So it goes in the Streets of Tos, and the character
// yells about it — on a shared server a pile of free equipment in a public street is a gift
// rather than litter. Operator's call, 2026-09-05.
//
// WHAT IS PINNED HERE IS THE THREE THINGS THAT MUST NEVER GO, because this is the one
// irreversible verb on the whole surface. A vault deposit costs a retrieval fee to undo; a
// drop costs everything, and the character walks away.
import { dropAllExcept } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

// A session with just enough of the shape `dropAllExcept` reads. `using` is the equipment
// set and `null` there means UNKNOWN, which is the case the first block is about.
function fakeSession({ items = [], using = new Set(), refuse = new Set() } = {}) {
  const names = new Map(items.map((it, i) => [i + 1, it.name]));
  let inv = items.map((it, i) => ({ id: i + 1, amount: it.amount ?? 1, nameRsc: i + 1,
                                    tag: it.tag ?? null }));
  const dropped = [];
  const c = {
    get inventory() { return inv; },
    using,
    rsc: { get: rsc => names.get(rsc) ?? '' },
    requestInventory() {},
    waitFor: async () => ({ events: [] }),
    drop(specs) {
      for (const spec of [].concat(specs)) {
        const id = typeof spec === 'object' ? spec.id : spec;
        if (refuse.has(id)) continue;              // the server kept it, silently
        dropped.push(names.get(id));
        inv = inv.filter(o => o.id !== id);
      }
    },
  };
  return { need: () => c, pacer: { submit: async (_k, fn) => fn() }, dropped, client: c };
}

console.log('\nunknown equipment refuses the whole operation');
{
  // THE ONE THAT MATTERS MOST. What you CARRY and what you are WEARING are two different
  // lists, and `using` is the only answer to the second. When it is null it means the
  // question has not been answered — not that nothing is equipped — and a drop planned
  // against that puts the character's own armour in the road. There is no safe partial
  // answer, so it refuses rather than proceeding carefully.
  const s = fakeSession({ items: [{ name: 'ring mail' }, { name: 'wand' }], using: null });
  const r = await dropAllExcept(s, { keep: [] });
  ok('it refuses', r.refused === true);
  ok('and says why in terms somebody can act on', /unknown is not permission/.test(r.why ?? ''),
     r.why);
  ok('and nothing was sent', s.dropped.length === 0);
  ok('and nothing is reported as dropped', (r.dropped ?? []).length === 0);
}

console.log('\nworn armour stays on, whatever the keep list says');
{
  const s = fakeSession({
    items: [{ name: 'ring mail' }, { name: 'battle axe' }, { name: 'rusty dagger' }],
    using: new Set([1, 2]),
  });
  const r = await dropAllExcept(s, { keep: [] });
  ok('the worn pieces are kept', !s.dropped.includes('ring mail') && !s.dropped.includes('battle axe'));
  ok('and the loose one goes', s.dropped.includes('rusty dagger'));
  ok('the reason is recorded per item',
     (r.kept ?? []).filter(k => k.why === 'equipped').length === 2, JSON.stringify(r.kept));
}

console.log('\nmoney is a floor, not a list entry');
{
  // A purse in the street is gone and no caller ever means it, so shillings are withheld
  // whatever `keep` says. The caller that forgets is exactly the case a floor exists for —
  // and the giveaway's own keep list deliberately does NOT name money, to prove this works.
  const s = fakeSession({
    items: [{ name: '250 shillings', amount: 250 }, { name: 'emerald' }],
    using: new Set(),
  });
  const r = await dropAllExcept(s, { keep: [] });
  ok('the money stays', !s.dropped.some(n => /shilling/i.test(n)), JSON.stringify(s.dropped));
  ok('and is recorded as money rather than as an oversight',
     (r.kept ?? []).some(k => k.why === 'money'));
  ok('the loot goes', s.dropped.includes('emerald'));
}

console.log('\nthe keep list is substrings, case-insensitively');
{
  const s = fakeSession({
    items: [{ name: 'slice of pork', amount: 40 }, { name: 'Inky-cap mushroom', amount: 3 },
            { name: 'herb', amount: 20 }, { name: 'red mushroom', amount: 12 },
            { name: 'battered helmet' }],
    using: new Set(),
  });
  await dropAllExcept(s, { keep: ['slice of pork', 'inky', 'herb'] });
  ok('the food stays', !s.dropped.includes('slice of pork'));
  ok('and matches regardless of case', !s.dropped.includes('Inky-cap mushroom'));
  ok('the create-food reagents stay', !s.dropped.includes('herb'));
  // A REAGENT THAT IS NOT ON THE LIST GOES, which is the point of naming them rather than
  // matching a family: four of this world's five mushrooms are reagents and only two are
  // food, and "mushroom" as a keep entry would have held all five.
  ok('a reagent nobody named goes', s.dropped.includes('red mushroom'));
  ok('and so does the loot', s.dropped.includes('battered helmet'));
}

console.log('\nit is judged by what LEFT the pack');
{
  // A drop is fire-and-forget on the wire and a refusal is prose or silence, so the sent
  // list is not the answer. Item 2 is refused by the server and stays in the pack.
  const s = fakeSession({
    items: [{ name: 'emerald' }, { name: 'cursed blade' }, { name: 'old boot' }],
    using: new Set(), refuse: new Set([2]),
  });
  const r = await dropAllExcept(s, { keep: [] });
  ok('what went is reported as dropped',
     r.dropped.map(d => d.name).sort().join(',') === 'emerald,old boot',
     JSON.stringify(r.dropped));
  ok('what would not go is reported as refused',
     (r.refused_items ?? []).includes('cursed blade'), JSON.stringify(r.refused_items));
  ok('offered counts what was tried', r.offered === 3);
}

console.log('\nnothing to drop is an outcome, not a failure');
{
  const s = fakeSession({ items: [{ name: 'ring mail' }, { name: '10 shillings', amount: 10 }],
                          using: new Set([1]) });
  const r = await dropAllExcept(s, { keep: [] });
  ok('it says so plainly', r.nothing_to_drop === true);
  ok('it is not a refusal', !r.refused);
  ok('and nothing was sent', s.dropped.length === 0);
}

console.log('\nthe batch is bounded');
{
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `trinket ${i}` }));
  const s = fakeSession({ items: many, using: new Set() });
  const r = await dropAllExcept(s, { keep: [], max: 5 });
  ok('only the cap is offered', r.offered === 5, String(r.offered));
  ok('and the rest is reported rather than silently left', r.not_offered === 15,
     String(r.not_offered));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
