#!/usr/bin/env node
// DOES A TOWN STOP EVER SELL SOMETHING IT IS ABOUT TO BUY?
//
//   node tools/m59-townstop-test.mjs
//
// Offline, and BEHAVIOURAL rather than source-matching: `planTownStop` is pure arithmetic
// over its arguments, so this runs the real function on real loadouts instead of grepping
// for the shape of one. Source assertions are for code that needs a live server; this does
// not, and a test that can execute the thing should.
//
// WHY THIS FILE EXISTS. Two answers to "may this be sold" were already in the tree and did
// not agree: the loadout's per-character `carry[].min`/`max`, and `m59-sellrun.mjs`'s own
// `keep_always.reagent_floor` plus a hardcoded ['herb','elderberry']. The hardcoded pair is
// the expensive half — it protects the two reagents somebody thought of, so a character told
// to carry a third had it fenced at the first stop and bought back at the last, paying the
// merchant spread twice for no change in the pack.
//
// The invariant below is the whole point, and it should fail the day somebody makes the sell
// list outrank a floor.
import { normalise } from './m59-loadout.mjs';
// normalise() answers {loadout, problems}. Every assertion here is about the loadout.
const norm1 = (raw) => normalise(raw).loadout;
import { planTownStop, neverSellsWhatItBuys, neverSellsWhatItGives,
         alliesInRoom, DEFAULTS } from './m59-townstop.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

const pack = (o) => Object.entries(o).map(([name, amount]) => ({ name, amount }));
const sellOf = (p, item) => p.sell.find(s => s.item.toLowerCase() === item.toLowerCase());
const buyOf = (p, item) => p.buy.find(b => b.item.toLowerCase() === item.toLowerCase());

// A character told to carry two reagents and to fight with a mace, holding a pile of loot.
const LOADOUT = norm1({
  format: 'm59-loadout/1', character: 'Tester',
  gear: { weapon: ['mace', 'hammer'], slots: { body: ['leather armor'] } },
  carry: [
    { item: 'elderberry', min: 20, max: 40, kind: 'reagent' },
    { item: 'herb', min: 20, max: 40, kind: 'reagent' },
    { item: 'inky cap', min: 2, max: 6, kind: 'potion' },
  ],
  sell: ['long sword'],
  keep: ['guild token'],
});

console.log('the invariant: never sell what this same stop would buy');
{
  // Short of herbs, swimming in elderberry — the exact shape that used to sell the herbs.
  const p = planTownStop(LOADOUT, {
    items: pack({ herb: 3, elderberry: 111, mushroom: 240, sapphire: 38, shilling: 400 }),
    equipped: ['mace'],
  });
  ok('a plan came back', !!p);
  ok('herbs are being bought', !!buyOf(p, 'herb') && buyOf(p, 'herb').short === 17);
  ok('and herbs are NOT in the sell list', !sellOf(p, 'herb'));
  const inv = neverSellsWhatItBuys(p);
  ok('the invariant holds', inv.ok, `both: ${inv.both.join(', ')}`);
}

console.log('\nbut everything else still goes');
{
  const p = planTownStop(LOADOUT, {
    items: pack({ herb: 3, elderberry: 111, mushroom: 240, sapphire: 38, shilling: 400 }),
    equipped: ['mace'],
  });
  ok('loot the loadout has never heard of is sold', !!sellOf(p, 'mushroom') && !!sellOf(p, 'sapphire'));
  ok('and all of it, since nothing asked for any', sellOf(p, 'mushroom').amount === 240);
  ok('money is never offered', !sellOf(p, 'shilling'));
  ok('what is WORN is never offered', !sellOf(p, 'mace'));
  ok('the reason is recorded, not just the verdict',
     /loadout has no opinion/.test(sellOf(p, 'sapphire').why));
}

console.log('\na reagent over its ceiling is kept, and the ceiling says so out loud');
{
  const p = planTownStop(LOADOUT, {
    items: pack({ elderberry: 111, herb: 60 }), equipped: [],
  });
  // never_sell_kinds includes 'reagent' by default, so `max: 40` does not apply to these.
  ok('elderberry is not sold despite being 71 over its ceiling', !sellOf(p, 'elderberry'));
  const w = p.withheld.find(x => x.item === 'elderberry');
  ok('and the withholding is REPORTED rather than silent', !!w && w.over === 71,
     JSON.stringify(p.withheld));
  ok('the report names the setting that did it', !!w && /never_sell_kinds/.test(w.why));
  // A number that stops applying and says nothing is the failure this repo keeps paying for.
  ok('a non-reagent over its ceiling IS still sold',
     !!sellOf(planTownStop(LOADOUT, { items: pack({ 'inky cap': 20 }) }), 'inky cap'));
}

console.log('\na protected KIND does not need a floor to be protected');
{
  // THE REGRESSION THIS PINS. `never_sell_kinds` was briefly gated on `floor > 0`, which on
  // the prod fleet protected nothing at all: every reagent floor there is 0, zeroed on
  // 2026-08-27 because unsatisfiable floors re-opened a town trip for ever. A setting that
  // silently does nothing on the only fleet that runs it is worse than no setting.
  const L = norm1({
    format: 'm59-loadout/1', character: 'Tester',
    carry: [{ item: 'elderberry', min: 0, max: 200, kind: 'reagent' }],
  });
  const p = planTownStop(L, { items: pack({ elderberry: 82 }) });
  ok('a floor-zero reagent is still protected', p.keep_fragments.includes('elderberry'));
  ok('and is not sold', !sellOf(p, 'elderberry'));
  const over = planTownStop(L, { items: pack({ elderberry: 250 }) });
  ok('even above its ceiling', !sellOf(over, 'elderberry'));
  ok('and the ceiling that stopped applying is reported',
     over.withheld.some(w => w.item === 'elderberry' && w.over === 50));
}

console.log('\nthe sell list never beats a floor');
{
  const L = norm1({
    format: 'm59-loadout/1', character: 'Tester',
    carry: [{ item: 'long sword', min: 1, max: 2, kind: 'weapon' }],
    sell: ['long sword'],
  });
  // HOLDING NONE IS AN ABSENT ROW, NOT A ROW OF ZERO — and this fixture said it the other
  // way, which is the only reason it ever passed.
  //
  // This used to read `pack({ 'long sword': 0 })`, meaning "holds none". On the wire that
  // shape does not occur: `amount` is the STACK COUNT, and anything that does not stack
  // reports 0 while being one real object. Measured on prod 2026-09-19 across 24 live keeper
  // packs — 13 characters held no long swords and NONE of them carried a long-sword row,
  // while 226 rows fleet-wide carried `amount: 0` and every one was an object the character
  // was really holding. A row that exists is at least one thing.
  //
  // The fixture is corrected rather than the reading, because the reading is what let 122
  // long swords, 47 flasks, 10 hammers and 9 axes sit in packs through every town stop: the
  // planner counted them as zero and the `>= min_stack` test dropped them silently.
  const p = planTownStop(L, { items: [] });
  ok('an item under its floor is bought', !!buyOf(p, 'long sword'));
  ok('and not sold, even though it is on the sell list', !sellOf(p, 'long sword'));
  ok('and the contradiction is reported as a conflict',
     p.conflicts.some(c => /sell list AND under its floor/.test(c.why)));

  // AND THE OTHER HALF OF THE SAME AMBIGUITY, so it cannot come back by either door.
  const held = planTownStop(L, { items: [{ name: 'long sword', amount: 0 }] });
  ok('one non-stackable row is ONE held, so the floor of 1 is met and nothing is bought',
     !buyOf(held, 'long sword'), JSON.stringify(held.buy));
}

console.log('\nkeep_fragments is the plan in sell_all vocabulary');
{
  const p = planTownStop(LOADOUT, { items: pack({ elderberry: 50, mushroom: 9 }), equipped: [] });
  // `sell_all` refuses to offer anything whose name CONTAINS one of these, lowercased.
  ok('every protected name is present', ['elderberry', 'herb', 'mace', 'hammer',
      'leather armor', 'guild token'].every(n => p.keep_fragments.includes(n)));
  ok('they are lowercased', p.keep_fragments.every(f => f === f.toLowerCase()));
  ok('and deduplicated', p.keep_fragments.length === new Set(p.keep_fragments).size);
  ok('loot is NOT in it', !p.keep_fragments.includes('mushroom'));
}

console.log('\nsilence means the behaviour that was already there');
{
  // AN ABSENT LOADOUT IS NOT AN EMPTY ONE. Read as "sell nothing" it makes the trip
  // pointless; read as "sell everything" it fences the fleet's reagents. Neither is safe to
  // guess, so the answer is null and the caller has to decide.
  ok('a null loadout returns null, not a plan', planTownStop(null, { items: pack({ mushroom: 5 }) }) === null);
  const empty = norm1({ format: 'm59-loadout/1', character: 'Tester' });
  const p = planTownStop(empty, { items: pack({ mushroom: 5 }) });
  ok('an empty loadout still sells loot', !!sellOf(p, 'mushroom'));
  ok('and protects nothing it was not told to', p.keep_fragments.length === 0);
}

console.log('\nthe courier case: shed loot, carry every reagent home');
{
  // What the Valley move needs: sell the mushrooms and gems, keep all 111 elderberry.
  const p = planTownStop(LOADOUT, {
    items: pack({ elderberry: 111, herb: 14, mushroom: 240, emerald: 24, shilling: 380 }),
    equipped: ['hammer'],
    settings: { never_sell_kinds: ['reagent'] },
  });
  ok('both reagents survive', !sellOf(p, 'elderberry') && !sellOf(p, 'herb'));
  ok('the loot does not', !!sellOf(p, 'mushroom') && !!sellOf(p, 'emerald'));
  ok('and the wielded hammer is untouched', !sellOf(p, 'hammer'));
  ok('the invariant still holds', neverSellsWhatItBuys(p).ok);
}

console.log('\nthe defaults are stated, not implied');
{
  ok('reagents are the default protected kind', DEFAULTS.never_sell_kinds.includes('reagent'));
  ok('and selling the unknown is on by default', DEFAULTS.sell_unknown === true);
}


console.log('\nan ally who needs it beats a merchant who will buy it');

// Operator, 2026-09-17: a "restock-allies" town stance, so Loial can stand in Barloque
// offering reveals and never run out of orc teeth because the farmers refill him.
//
// The money argument is the one this module already makes about sell/buy, one pack over: a
// merchant buys below what it sells, so selling a reagent here and having a fleetmate buy one
// back at the next counter pays the spread TWICE and ends with the reagent in the same pack it
// could have been handed to.
{
  const { loadout } = normalise({
    character: 'Zoot',
    carry: [{ item: 'sapphire', min: 4, max: 10, kind: 'reagent' },
            { item: 'mushroom', min: 0, max: 20, kind: 'reagent' },
            { item: 'herb', min: 12, max: 60, kind: 'reagent' }],
  });
  const items = [{ name: 'sapphire', amount: 40 }, { name: 'mushroom', amount: 50 },
                 { name: 'herb', amount: 3 }, { name: 'rat pelt', amount: 9 },
                 { name: 'shilling', amount: 2000 }];
  const wants = (item, short) => [{ character: 'Loial the Ogier', wants: [{ item, short }] }];

  // SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE — the first policy rule, and the one a
  // new leg on an existing plan is most likely to break.
  const none = planTownStop(loadout, { items });
  ok('no allies changes nothing at all', Array.isArray(none.give) && none.give.length === 0);

  const one = planTownStop(loadout, { items, allies: wants('sapphire', 12) });
  ok('an ally short of a reagent is handed it out of our surplus',
     one.give.length === 1 && one.give[0].amount === 12 && one.give[0].to === 'Loial the Ogier',
     JSON.stringify(one.give));
  ok('and the give says which pile it came out of, so a reader can see what it cost',
     one.give[0].from === 'withheld');

  // THE CASE THAT MATTERS ON THIS FLEET. `never_sell_kinds: ['reagent']` protects reagents from
  // the COUNTER, and every reagent floor here is zero (deliberately, since 2026-08-27) — so the
  // withheld pile is where nearly all the spare reagents live. A give pass that only drew from
  // `sell` would find almost nothing to give on the fleet it was written for.
  const prot = planTownStop(loadout, { items, settings: { never_sell_kinds: ['reagent'] },
                                       allies: wants('mushroom', 15) });
  ok('a reagent protected from the merchant is STILL given to a fleetmate who needs it',
     prot.give.length === 1 && prot.give[0].item === 'mushroom' && prot.give[0].amount === 15,
     JSON.stringify(prot.give));
  ok('and the withheld row records how much of it went',
     prot.withheld.find(w => w.item === 'mushroom')?.given === 15);
  ok('the reason says protection from the counter is not protection from the fleet',
     /does not protect it from the fleet/.test(prot.give[0].why));

  // BEING SHORT OURSELVES OUTRANKS AN ALLY BEING SHORT. Otherwise two characters hand one herb
  // back and forth for ever, which is a supply loop rather than a supply run.
  const clash = planTownStop(loadout, { items, allies: wants('herb', 5) });
  ok('an ally is refused what we are ourselves buying', clash.give.length === 0);
  ok('...and the refusal is REPORTED rather than silent',
     clash.conflicts.some(c => c.item === 'herb' && /so are we/.test(c.why)),
     JSON.stringify(clash.conflicts));

  // The caller decides priority by the order it passes allies in; this module will not rank
  // fleetmates, because who deserves the last sapphire is a judgement about the fleet.
  const two = planTownStop(loadout, {
    items, allies: [{ character: 'Loial the Ogier', wants: [{ item: 'sapphire', short: 25 }] },
                    { character: 'Beaker', wants: [{ item: 'sapphire', short: 25 }] }] });
  ok('two allies are served in the order given, until the pile runs out',
     two.give.length === 2 && two.give[0].amount === 25 && two.give[1].amount === 5,
     JSON.stringify(two.give));

  // A PARTIAL GIVE IS CORRECT AND COSTS NOTHING. Four of nine spare pelts across, five to the
  // counter: the same ITEM in both lists and no single unit in both. The first version of
  // neverSellsWhatItGives was a name match and called this a violation, which would have
  // forced the pass to hand over a whole pile or none of it.
  const loot = planTownStop(loadout, { items, allies: wants('rat pelt', 4) });
  ok('loot the loadout has no opinion about can be given, and the remainder still sells',
     loot.give[0].amount === 4 && loot.sell.find(s => s.item === 'rat pelt')?.amount === 5,
     JSON.stringify([loot.give, loot.sell]));
  ok('and that is NOT a double promise', neverSellsWhatItGives(loot).ok,
     JSON.stringify(neverSellsWhatItGives(loot).over));

  // The invariant has to be able to fail, or it is decoration. Hand it a plan that promises
  // more than was spare.
  ok('the invariant CATCHES a genuine double promise',
     !neverSellsWhatItGives({ spare_before: { sapphire: 10 },
                              give: [{ item: 'sapphire', amount: 8 }],
                              sell: [{ item: 'sapphire', amount: 8 }] }).ok);

  ok('a give is work, so a stop that only hands things over is not `ok: true`',
     one.ok === false && /hand over/.test(one.summary), one.summary);
  ok('an ally wanting something we do not have at all is not an error',
     planTownStop(loadout, { items, allies: wants('orc tooth', 9) }).give.length === 0);
  ok('a malformed ally row is skipped rather than throwing',
     planTownStop(loadout, { items, allies: [{}, { character: 'X' },
                                             { character: 'Y', wants: [{ item: 'sapphire' }] }] })
       .give.length === 0);
}


console.log('\nwho else is standing here, and what are they short of');

{
  const lo = (character, carry) => norm1({ character, carry });
  const subject = { character: 'Zoot', room: 106 };
  const others = [
    { agent: 'hk1', character: 'Loial the Ogier', room: 106,
      items: [{ name: 'orc tooth', amount: 2 }],
      loadout: lo('Loial the Ogier', [{ item: 'orc tooth', min: 12, kind: 'reagent' }]) },
    { agent: 't6', character: 'Beaker', room: 106, items: [],
      loadout: lo('Beaker', [{ item: 'sapphire', min: 4, kind: 'reagent' }]) },
    { agent: 't9', character: 'Camilla', room: 39, items: [],
      loadout: lo('Camilla', [{ item: 'sapphire', min: 40, kind: 'reagent' }]) },
  ];

  const found = alliesInRoom(subject, others);
  ok('only the ones in THIS room are allies',
     found.every(a => a.character !== 'Camilla'), JSON.stringify(found.map(a => a.character)));
  ok('a want is a carry floor that is not met, counted off its own pack',
     found.find(a => a.character === 'Loial the Ogier').wants[0].short === 10,
     JSON.stringify(found.find(a => a.character === 'Loial the Ogier')?.wants));
  // NEEDIEST FIRST, so a pile that cannot serve everyone serves whoever is worst off. The
  // order is the caller's to change; planTownStop honours what it is given and ranks nobody.
  ok('the neediest is first', found[0].character === 'Loial the Ogier',
     JSON.stringify(found.map(a => a.character)));

  ok('the subject is never its own ally',
     alliesInRoom({ character: 'Zoot', room: 106 },
                  [{ agent: 't17', character: 'Zoot', room: 106, items: [],
                     loadout: lo('Zoot', [{ item: 'herb', min: 9 }]) }]).length === 0);
  // SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. A character with no orders wants
  // nothing; an absent loadout has never meant "give it everything".
  ok('a character with no loadout wants nothing',
     alliesInRoom(subject, [{ agent: 'x', character: 'Nobody', room: 106, items: [],
                              loadout: null }]).length === 0);
  // A FLOOR OF ZERO IS NOT A FLOOR — nineteen of this fleet's loadouts were zeroed for the
  // graveyard shift, so a pass that read them as wants would try to fill the whole fleet.
  ok('a floor of ZERO is not a want',
     alliesInRoom(subject, [{ agent: 'x', character: 'Zero', room: 106, items: [],
                              loadout: lo('Zero', [{ item: 'herb', min: 0, max: 60 }]) }])
       .length === 0);
  ok('an unknown room proves nobody is here, rather than everybody',
     alliesInRoom({ character: 'Zoot', room: null }, others).length === 0);
  ok('and a row with no room of its own is skipped rather than assumed present',
     alliesInRoom(subject, [{ agent: 'x', character: 'Ghost', room: null, items: [],
                              loadout: lo('Ghost', [{ item: 'herb', min: 9 }]) }]).length === 0);
  ok('a satisfied floor is not a want',
     alliesInRoom(subject, [{ agent: 'x', character: 'Full', room: 106,
                              items: [{ name: 'herb', amount: 50 }],
                              loadout: lo('Full', [{ item: 'herb', min: 9 }]) }]).length === 0);

  // THE POINT OF THE WHOLE THING, end to end: a courier with spare teeth, standing next to a
  // caster that is short of them, hands them over instead of selling them.
  const { loadout: courier } = normalise({
    character: 'Zoot', carry: [{ item: 'orc tooth', min: 2, max: 4, kind: 'reagent' }] });
  const plan = planTownStop(courier, {
    items: [{ name: 'orc tooth', amount: 24 }],
    settings: { never_sell_kinds: ['reagent'] },
    allies: alliesInRoom(subject, others),
  });
  ok('the courier hands the caster its teeth rather than parking them',
     plan.give.length === 1 && plan.give[0].to === 'Loial the Ogier'
       && plan.give[0].amount === 10, JSON.stringify(plan.give));
  ok('...out of the pile that was protected from the counter', plan.give[0].from === 'withheld');
  ok('and nothing is promised twice', neverSellsWhatItGives(plan).ok);
}


console.log('\nwhat counts as a town stop');

{
  const { townStopReason } = await import('./m59-townstop-watch.mjs');
  const keeper = (agent, character, room) =>
    [agent, { character, room: room == null ? null : { num: room, name: 'somewhere' },
              items: [], __identity: { agent, character } }];

  const withCounter = new Map([keeper('t6', 'Beaker', 104)]);
  const merchants = new Map([[104, ['Joguer']]]);

  ok('a counter in the room is a town stop, and the reason NAMES it',
     (() => { const r = townStopReason('t6', withCounter, merchants);
              return !!r && r.merchant === 'Joguer' && /counter/.test(r.why); })());

  // A CHARACTER IN A ROOM WITH NOTHING IN IT IS NOT AT A TOWN STOP. Firing there would spend a
  // pass per tick to be told there is nothing to do, and the log would fill with non-events.
  ok('a room with no counter and nobody short of anything is NOT a stop',
     townStopReason('t6', withCounter, new Map()) === null);

  // NO VERIFIED KEEPER IS NOT OUR BUSINESS. `discoverKeeperStates` proves identity before it
  // reports state, and a row without that proof is a port that answered, not a character.
  ok('a state with no verified identity is skipped rather than acted on',
     townStopReason('t6', new Map([['t6', { character: 'Beaker', room: { num: 104 } }]]),
                    merchants) === null);

  // AN UNKNOWN ROOM PROVES NOTHING IS HERE, rather than everything — the same rule
  // alliesInRoom follows, and for the same reason.
  ok('an unknown room is not a stop',
     townStopReason('t6', new Map([keeper('t6', 'Beaker', null)]), merchants) === null);

  ok('an agent nobody discovered is not a stop',
     townStopReason('t99', withCounter, merchants) === null);

  // THE REASON IS RETURNED RATHER THAN A BOOLEAN, because "the driver fired and the stop
  // declined" and "the driver never fired" are different faults. A watcher that logged only the
  // second could not tell them apart, which is the failure the whole tool exists to end.
  ok('the reason carries enough to explain itself in a log',
     (() => { const r = townStopReason('t6', withCounter, merchants);
              return r.agent === 't6' && r.character === 'Beaker' && r.room === 104
                     && Array.isArray(r.allies) && typeof r.why === 'string'
                     && r.why.length > 0; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
