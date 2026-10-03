#!/usr/bin/env node
// WHO SELLS WHAT, AND WHO IS WHO. Offline, no server, safe any time:
//
//   node tools/m59-merchants-test.mjs
//
// Three failures are pinned here, and all three were silent for the life of the
// catalogue — which is the point: none of them produced an error, a warning, or an
// empty result. They produced a confident wrong answer.
//
//   * SLOT 2 OF plFor_sale IS SKILLS and the reader took only slot 3. Every skill sold
//     by a live merchant vanished. `who-teaches block` answered with a wanderer while
//     the man who sells it was sitting in a bar, because the wanderer's entry came from
//     the source and the bar's came from the server.
//   * A NAME IS NOT A PERSON AND A CONSTANT IS NOT A NAME. Two classes sharing a name
//     resource may be one man in two coats (Jonas D'Accor) or two men with one name
//     (Fehr'loi Qan, smithing in two towns at once); the icon separates them. And
//     SKID_PROFICIENCY_MACE is called "mace fighting" — deriving names from constants
//     invents seven of the eight weapon proficiencies, which this repository has
//     already done once.
//   * CASE IS NOT DECORATIVE. `viSkill_num` against `viSkill_Num`, `SID_FORESIGHT`
//     against `SID_Foresight`, `Izzio` against `izzio_name_rsc`. Each of those cost a
//     whole category of answer to a Map keyed on the spelling it happened to see first.
//
// The parse tests run anywhere. The ones that read the game's source skip without it,
// the same way m59-roo-test skips without resource/rooms.

import fs from 'node:fs';
import path from 'node:path';

const M59_ROOT = process.env.M59_ROOT || 'C:/code/meridian59';
const haveSource = fs.existsSync(path.join(M59_ROOT, 'kod/include/blakston.khd'));

const { splitTopLevel, balanced, forSaleFromSource, resourceValue, descendsFrom, sellsFromInventory,
        priceOfLevel, readSourceClasses, readConstants, readAbilityLevels,
        enrichCatalogue } = await import('./m59-merchants.mjs');

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const skipped = (name) => { skip++; console.log('  skip ' + name); };

// ------------------------------------------------------- reading a kod list literal

console.log('\nplFor_sale is four positional slots');

ok('a bracket finds its own match, not the first one it meets',
   balanced('x = [a, [b, c], d];', 4) === 'a, [b, c], d');
ok('an unclosed bracket returns what there is rather than throwing',
   balanced('x = [a, b', 4) === 'a, b');

ok('slots split on top-level commas only',
   JSON.stringify(splitTopLevel('$, [ SKID_BLOCK ], [ SID_HASTE, SID_GLOW ]').map(s => s.trim()))
   === JSON.stringify(['$', '[ SKID_BLOCK ]', '[ SID_HASTE, SID_GLOW ]']));
ok('a comma inside a slot does not split it',
   splitTopLevel('[a, b, c], [d]').length === 2);
ok('an empty body is one empty slot, not zero', splitTopLevel('').length === 1);

// The exact shape of RebelLiege.SetForSale (rebel.kod:120).
const REBEL = `
   SetForSale()
   {
      plFor_Sale = [$,
          [ SKID_BLOCK ],
          [ SID_IDENTIFY, SID_REVEAL, SID_SHROUD,
          SID_DISPEL_ILLUSION, SID_HASTE, SID_RESIST_POISON,
          SID_GLOW, SID_FREE_ACTION,
          SID_SHATTERLOCK]];
      return;
   }
`;
{
  const got = forSaleFromSource(REBEL);
  ok('THE SKILL IN SLOT 2 IS FOUND', got.skills.includes('SKID_BLOCK'), JSON.stringify(got.skills));
  ok('and is not mistaken for a spell', !got.spells.includes('SKID_BLOCK'));
  ok('the spells in slot 3 are all found', got.spells.length === 9, String(got.spells.length));
  ok('SKID_ is not matched as SID_', !got.spells.some(s => /BLOCK/.test(s)));
}

// jGeneral.kod declares two variants, one with shatterlock and one without.
{
  const got = forSaleFromSource(`
      SetForSaleWithShatterlock()
      { plFor_Sale = [$, [ SKID_BLOCK ], [ SID_GLOW, SID_SHATTERLOCK ]]; }
      SetForSaleNoShatterlock()
      { plFor_Sale = [$, [ SKID_BLOCK ], [ SID_GLOW ]]; }
  `);
  ok('several for-sale variants are unioned, not overwritten',
     got.spells.includes('SID_SHATTERLOCK') && got.spells.includes('SID_GLOW') && got.spells.length === 2);
  ok('and the skill is not duplicated', got.skills.length === 1);
}

ok('a merchant with no for-sale list yields nothing rather than throwing',
   forSaleFromSource('Whatever is Monster\n').skills.length === 0);
ok('the property name is matched whatever its casing',
   forSaleFromSource('plFor_sale = [$, [ SKID_BLOCK ], []];').skills.length === 1);
ok('a constant written in mixed case is normalised',
   forSaleFromSource('plFor_Sale = [$, [], [ SID_Foresight ]];').spells[0] === 'SID_FORESIGHT');

// ------------------------------------------------------------------- what it costs

console.log('\nthe price of an ability is its level and nothing else');

ok('a level 1 skill is 500, not 250', priceOfLevel(1) === 500);
ok('level 2 doubles', priceOfLevel(2) === 1000);
ok('level 5 is 8000', priceOfLevel(5) === 8000);
ok('an unknown level has no price rather than a wrong one', priceOfLevel(null) === null);
ok('level 0 is not a free skill', priceOfLevel(0) === null);

// ------------------------------------------------------------------ who somebody is

console.log('\na name resource is followed, not guessed');

ok('the reference is followed to the string it points at',
   resourceValue('   izzio_name_rsc = "Izzio"\n   vrName = Izzio_name_rsc\n', 'Izzio', 'vrName') === 'Izzio');
ok('a resource named after the class still works with no vrName line',
   resourceValue('   Block_name_rsc = "block"\n', 'Block', 'vrName') === 'block');
ok('the class casing is not assumed',
   resourceValue('   qorpriestess_name_rsc = "Priestess Zuxana"\n   vrName = qorpriestess_name_rsc\n',
                 'QorPriestess', 'vrName') === 'Priestess Zuxana');
ok('an unquoted resource reads as a bare token',
   resourceValue('   X_icon_rsc = wngenera.bgf\n   vrIcon = X_icon_rsc\n', 'X', 'vrIcon', false) === 'wngenera.bgf');
ok('a missing resource is null rather than the reference name',
   resourceValue('nothing here\n', 'X', 'vrName') === null);

{
  const classes = new Map([
    ['Wanderer', { cls: 'Wanderer', parent: 'Towns' }],
    ['JealousGeneral', { cls: 'JealousGeneral', parent: 'Wanderer' }],
    ['Izzio', { cls: 'Izzio', parent: 'Wanderer' }],
    ['RebelLiege', { cls: 'RebelLiege', parent: 'Factions' }],
    ['Factions', { cls: 'Factions', parent: 'Monster' }],
  ]);
  ok('a direct child of Wanderer wanders', descendsFrom(classes, 'JealousGeneral', 'Wanderer'));
  ok('a merchant on another branch does not', !descendsFrom(classes, 'RebelLiege', 'Wanderer'));
  ok('an unknown class does not wander by default', !descendsFrom(classes, 'Nobody', 'Wanderer'));
  // A parent that points back at its child would spin for ever on a malformed tree.
  const loop = new Map([['A', { parent: 'B' }], ['B', { parent: 'A' }]]);
  ok('a cycle in the parent chain terminates', descendsFrom(loop, 'A', 'Wanderer') === false);
}

// ------------------------------------------------- a merchant that can run out, or fill up

console.log('\nwho keeps a real pack, and who assembles a list');
{
  // Declared-or-null, never false-by-default: a class that says nothing is answering
  // with its parent's answer, and flattening that to `false` here would make an
  // unresolvable chain indistinguishable from a merchant that cannot run out.
  const classes = new Map([
    ['Monster', { cls: 'Monster', parent: 'Object', sellsFromInventoryDeclared: false, maxForSale: null }],
    ['Towns', { cls: 'Towns', parent: 'Monster', sellsFromInventoryDeclared: null, maxForSale: null }],
    ['Wanderer', { cls: 'Wanderer', parent: 'Towns', sellsFromInventoryDeclared: null, maxForSale: null }],
    ['Izzio', { cls: 'Izzio', parent: 'Wanderer', sellsFromInventoryDeclared: true, maxForSale: 25 }],
    ['BarloqueApothecary', { cls: 'BarloqueApothecary', parent: 'Towns', sellsFromInventoryDeclared: null, maxForSale: null }],
    ['Orphan', { cls: 'Orphan', parent: 'NotInTheTree', sellsFromInventoryDeclared: null, maxForSale: null }],
    ['LittleIzzio', { cls: 'LittleIzzio', parent: 'Izzio', sellsFromInventoryDeclared: null, maxForSale: null }],
  ]);
  ok('a class that declares it is finite, and says how much it holds',
     sellsFromInventory(classes, 'Izzio').finite === true &&
     sellsFromInventory(classes, 'Izzio').max_for_sale === 25);
  // THE REASON THIS IS A CHAIN WALK AND NOT A FIELD READ.
  ok('AND SO IS A SUBCLASS THAT NEVER MENTIONS IT — the flag is inherited',
     sellsFromInventory(classes, 'LittleIzzio').finite === true,
     JSON.stringify(sellsFromInventory(classes, 'LittleIzzio')));
  ok('an ordinary counter resolves to Monster\'s FALSE and cannot run out',
     sellsFromInventory(classes, 'BarloqueApothecary').finite === false);
  ok('and says which class answered, so the reading can be checked',
     sellsFromInventory(classes, 'BarloqueApothecary').from === 'Monster');
  // "We could not tell" must not render as "it cannot run out": the two lead to
  // different decisions at a counter. This is the case CorNothTown produced for real.
  ok('A CHAIN THAT BREAKS IS UNKNOWN, NOT FALSE',
     sellsFromInventory(classes, 'Orphan').finite === null,
     JSON.stringify(sellsFromInventory(classes, 'Orphan')));
  const loop = new Map([['A', { cls: 'A', parent: 'B', sellsFromInventoryDeclared: null }],
                        ['B', { cls: 'B', parent: 'A', sellsFromInventoryDeclared: null }]]);
  ok('a cycle terminates rather than spinning', sellsFromInventory(loop, 'A').finite === null);
}

// KOD CLASS NAMES ARE CASE-INSENSITIVE AND THE TREE USES THAT. `crnthtwn.kod` declares
// `CorNothTown`; `cngrocer.kod` says `CornothGrocer is CornothTown`. A plain Map made
// those two different classes and every walk up that chain stopped at the first hop —
// silently, and in the direction that looks like a legitimate "no".
console.log('\nthe parent chain survives the tree disagreeing with itself about case');
if (!haveSource) {
  skipped('the real class map (needs M59_ROOT)');
} else {
  const classes = readSourceClasses();
  ok('the town class is declared with the tree\'s own spelling',
     !!classes.get('CorNothTown'), 'CorNothTown missing from the source read');
  ok('AND IS FOUND UNDER THE SPELLING ITS CHILD USES',
     classes.get('CornothTown')?.cls === 'CorNothTown',
     JSON.stringify(classes.get('CornothTown')?.cls));
  ok('so a merchant behind that hop resolves instead of coming back unknown',
     sellsFromInventory(classes, 'CornothGrocer').finite === false,
     JSON.stringify(sellsFromInventory(classes, 'CornothGrocer')));
  // Iteration keeps the file's own spelling — build() rebuilds a Map from these entries.
  ok('iterating still yields the canonical name, not a lowercased one',
     [...classes.keys()].includes('CorNothTown'));
  ok('the two merchants that keep a real pack are the only two',
     [...classes.values()].filter(c => c.sellsFromInventoryDeclared === true)
       .map(c => c.cls).sort().join(',') === 'Izzio,KocatanShopkeeper',
     [...classes.values()].filter(c => c.sellsFromInventoryDeclared === true).map(c => c.cls).join(','));
  ok('and neither of the counters the reagent errand uses is one of them',
     sellsFromInventory(classes, 'MarionInnkeeper').finite === false &&
     sellsFromInventory(classes, 'BarloqueApothecary').finite === false);
}

// ------------------------------------------------- one man in two coats, and two men

console.log('\nthe same name is not the same person');

// enrichCatalogue reads the real source for levels and constants, so this needs it.
if (!haveSource) {
  skipped('the catalogue enrichment (needs M59_ROOT)');
} else {
  const classes = readSourceClasses();
  const { rooms: RID, abilities: CONST } = readConstants();
  const levels = readAbilityLevels();

  ok('the source knows Jonas D\'Accor under both of his classes',
     classes.get('RebelLiege')?.name === "Jonas D'Accor" &&
     classes.get('JealousGeneral')?.name === "Jonas D'Accor");
  ok('and draws him the same way in both', classes.get('RebelLiege')?.icon &&
     classes.get('RebelLiege').icon === classes.get('JealousGeneral')?.icon);
  ok('while the two Fehr\'loi Qans are drawn differently',
     classes.get('BarloqueBlacksmith')?.name === classes.get('TosBlacksmith')?.name &&
     classes.get('BarloqueBlacksmith')?.icon !== classes.get('TosBlacksmith')?.icon);

  ok('the rebel liege really does sell block in slot 2',
     classes.get('RebelLiege')?.skills.includes('SKID_BLOCK'));
  ok('SKID_BLOCK is 404', CONST.get('SKID_BLOCK') === 404);
  ok('RID_JAS_BAR is room 371', RID.get('RID_JAS_BAR') === 371);
  ok('block is a level 1 skill', levels.get('SKID_BLOCK')?.level === 1);
  ok('and the game calls it "block"', levels.get('SKID_BLOCK')?.name === 'block');

  // THE NAMES THE REPOSITORY ONCE INVENTED. Taken from WEAPON_PROFICIENCY in
  // m59-skills.mjs, which cites the kod file for each.
  ok('the mace proficiency is called "mace fighting", not "proficiency mace"',
     levels.get('SKID_PROFICIENCY_MACE')?.name === 'mace fighting');
  ok('the sword one is called "fencing"',
     levels.get('SKID_PROFICIENCY_SWORD')?.name === 'fencing');
  ok('a class whose num constant is capitalised differently is still found',
     levels.get('SID_FORESIGHT')?.level > 0);

  // A catalogue in the shape the old, slot-blind build produced: the rebel liege with
  // his spells and no skills at all.
  const stale = { merchants: [
    { seen: true, id: 3551, cls: 'RebelLiege', room: 371, markup: null, sells: [],
      teaches: [{ num: 116, spell: 'haste' }], buying_rule: null, buys_anything: true },
    { seen: false, id: null, cls: 'JealousGeneral', room: null, markup: null, sells: [],
      teaches: [], buying_rule: null, buys_anything: true },
    { seen: true, id: 1, cls: 'BarloqueBlacksmith', room: 113, markup: null, sells: [],
      teaches: [], buying_rule: null, buys_anything: true },
    { seen: false, id: null, cls: 'TosBlacksmith', room: null, markup: null, sells: [],
      teaches: [], buying_rule: null, buys_anything: true },
  ] };
  const out = enrichCatalogue(structuredClone(stale));
  const rebel = out.merchants.find(m => m.cls === 'RebelLiege');
  const general = out.merchants.find(m => m.cls === 'JealousGeneral');
  const bqsmith = out.merchants.find(m => m.cls === 'BarloqueBlacksmith');

  const block = rebel.teaches.find(t => t.skill === 'block');
  ok('THE SKILL THE OLD BUILD DROPPED COMES BACK WITHOUT A SERVER', !!block, JSON.stringify(rebel.teaches));
  ok('and is marked a skill', block?.kind === 'skill');
  ok('and priced at 500', block?.price === 500);
  ok('and flagged as a lead rather than an observation', block?.from === 'source');
  ok('while what the server really said keeps its provenance',
     rebel.teaches.find(t => t.num === 116)?.from === 'server');
  ok('a spell recorded as a bare number gets its kind from its own class',
     rebel.teaches.find(t => t.num === 116)?.kind === 'spell');

  ok('the stationary liege is not marked a wanderer', rebel.wanders === false);
  ok('and carries no circuit', rebel.circuit === undefined);
  ok('the general wanders', general.wanders === true);
  ok('and his circuit is rooms, not constants',
     general.circuit?.includes(371) && general.circuit.every(n => typeof n === 'number'));

  ok('THE TWO ARE LINKED AS ONE MAN', rebel.also?.[0]?.cls === 'JealousGeneral' &&
     rebel.also[0].same_person === true);
  // The link is what turns "the only seller wanders" into "his other self is in a bar".
  ok('and from the wanderer\'s side the link carries the room to walk to',
     general.also?.[0]?.cls === 'RebelLiege' && general.also[0].room === 371 &&
     general.also[0].wanders === false);
  ok('the two smiths are linked but NOT called the same man',
     bqsmith.also?.[0]?.cls === 'TosBlacksmith' && bqsmith.also[0].same_person === false);
  ok('and the note says why', /different person/.test(bqsmith.also_note ?? ''));

  ok('enriching twice is the same as enriching once',
     JSON.stringify(enrichCatalogue(structuredClone(out)).merchants)
     === JSON.stringify(out.merchants));

  // The whole reason any of this exists: ask for block, get the man in the bar first.
  const sellers = out.merchants.filter(m => m.teaches.some(t => t.skill === 'block'))
                               .sort((a, b) => (a.wanders ? 1 : 0) - (b.wanders ? 1 : 0));
  ok('both Jonases sell block', sellers.length === 2);
  ok('AND THE ONE WHO STANDS STILL IS OFFERED FIRST',
     sellers[0].cls === 'RebelLiege' && sellers[0].room === 371);
}

// -------------------------------------------------- what an errand asks the catalogue

console.log('\nnaming what to learn');

// The errand imports cleanly because m59-outfit guards its main loop on being the entry
// point — importing it must not walk the fleet across the world to find that out.
const { abilityWanted } = await import('./m59-outfit.mjs');

const CAT = { merchants: [
  { cls: 'RebelLiege', teaches: [
    { num: 404, kind: 'skill', skill: 'block', price: 500 },
    { num: 130, kind: 'spell', spell: 'resist poison', price: 1000 }] },
  { cls: 'FarenPriestess', teaches: [
    { num: 100, kind: 'spell', spell: 'resist fire', price: 1000 },
    { num: 101, kind: 'spell', spell: 'resist cold', price: 1000 }] },
  { cls: 'CorNothSergeant', teaches: [
    { num: 415, kind: 'skill', skill: 'mace fighting', price: 500 }] },
] };

ok('a name resolves to its kind, number and price',
   JSON.stringify(abilityWanted('block', CAT)) ===
   JSON.stringify({ name: 'block', kind: 'skill', num: 404, price: 500, ambiguous: null }));
ok('the game\'s own name for a proficiency works',
   abilityWanted('mace fighting', CAT).num === 415);
ok('AND THE NAME THIS REPOSITORY ONCE INVENTED DOES NOT SILENTLY MATCH SOMETHING ELSE',
   abilityWanted('proficiency mace', CAT).ambiguous?.length === 0);
ok('an exact name wins over the things it is a prefix of',
   abilityWanted('resist poison', CAT).num === 130);
ok('AN AMBIGUOUS NAME IS REPORTED, NOT GUESSED AT',
   abilityWanted('resist', CAT).ambiguous?.length === 3, JSON.stringify(abilityWanted('resist', CAT)));
ok('and buying nothing is the outcome of an ambiguous name',
   abilityWanted('resist', CAT).price === null);
ok('an unknown name is reported as taught by nobody',
   abilityWanted('telekinesis', CAT).ambiguous?.length === 0);
ok('a missing catalogue does not throw', abilityWanted('block', null).ambiguous?.length === 0);
ok('case does not matter', abilityWanted('BLOCK', CAT).num === 404);

// ---------------------------------------------------------------------------------------
// A MERCHANT IS ASKED FOR BY HIS NAME. 2026-10-03, prod: `merchants {show:"Morrigan"}` and
// `{show:"Frisconar"}` answered "no merchant matches" while the committed catalogue held
// both, because the lookup read `cls` and the room only. And `{here:true}` in 202 reported
// Tova twice — `inRoom[0]` attached to every object, then its name overwrote the live one.
console.log('\na merchant is found by the name people use, and the room maps each person to their own row');
{
  const { findMerchants, sellersOf, stockMatching, merchantForObject, loadMerchants } =
    await import('./m59-merchants.mjs');
  const { withShopsSeen, recordShopSeen, loadShopsSeen } = await import('./m59-shops-seen.mjs');
  const { fileURLToPath } = await import('node:url');
  const all = loadMerchants(path.join(path.dirname(fileURLToPath(import.meta.url)),
                                      '..', 'substrate', 'm59-merchants.json')).merchants;

  const morrigan = findMerchants(all, 'Morrigan')[0];
  ok('Morrigan is found by name', morrigan?.name === 'Morrigan', JSON.stringify(morrigan?.cls));
  ok('...standing in the Limping Toad, room 202', morrigan?.room === 202);
  ok('...selling herbs and elderberry',
     stockMatching(morrigan, 'herb').length > 0 && stockMatching(morrigan, 'elderberry').length > 0);
  const fris = findMerchants(all, 'frisconar')[0];
  ok('Frisconar is found by name, case-insensitively', fris?.name === 'Frisconar' && fris?.room === 53);
  ok('...and sells herbs', stockMatching(fris, 'herbs').length > 0);
  ok('the class name still works', findMerchants(all, 'MarionInnkeeper')[0]?.name === 'Morrigan');
  ok('and a room number still works', findMerchants(all, '202').length === 2);
  ok('a name nobody has is still nobody', findMerchants(all, 'Zzyzx').length === 0);

  const herbSellers = sellersOf(all, 'herb').map(m => m.name);
  ok('who sells herb names Morrigan AND Frisconar, not only Ravi and Joguer',
     herbSellers.includes('Morrigan') && herbSellers.includes('Frisconar') &&
     herbSellers.includes('Joguer'), herbSellers.join(', '));
  ok('a display name finds a class name ("red mushroom" -> RedMushroom)',
     sellersOf(all, 'red mushroom').some(m => m.name === 'Frisconar'));

  const in202 = all.filter(m => m.room === 202);
  ok('Morrigan\'s live object maps to Morrigan, not to the first row in 202',
     merchantForObject(in202, 'Morrigan')?.cls === 'MarionInnkeeper');
  ok('and Tova\'s to Tova', merchantForObject(in202, 'Tova')?.cls === 'MarionBartender');
  ok('a live merchant the catalogue lacks maps to NOBODY, not to a neighbour',
     merchantForObject(in202, 'Somebody New') === null);

  // A shop seen at the counter is folded in: a match is marked, a stranger is added.
  const tmp = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', `m59-shops-seen-test-${process.pid}.json`);
  try { fs.unlinkSync(tmp); } catch {}
  recordShopSeen({ name: 'Morrigan', room: 202, items: [{ name: 'herb', cost: 20, amount: 5 }] }, { file: tmp });
  recordShopSeen({ name: 'Ottoline', room: 999, items: [{ name: 'sapphire', cost: 300 }] }, { file: tmp });
  ok('an unnamed seller is not recorded', recordShopSeen({ name: '', room: 1, items: [{ name: 'x' }] }, { file: tmp }) === null);
  const merged = withShopsSeen(all, loadShopsSeen(tmp));
  ok('the catalogue row Morrigan matches is marked seen live',
     !!findMerchants(merged, 'Morrigan')[0]?.seen_live);
  ok('a merchant only ever seen live is found by name after one shop opening',
     findMerchants(merged, 'Ottoline')[0]?.room === 999);
  ok('...and by what she sells', sellersOf(merged, 'sapphire').some(m => m.name === 'Ottoline'));
  ok('the built catalogue is not mutated', !all.some(m => m.seen_live));
  try { fs.unlinkSync(tmp); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
