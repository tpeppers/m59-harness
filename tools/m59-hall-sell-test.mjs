#!/usr/bin/env node
// HALL-SELL-MUNDANE, THE PURE HALF -- offline, no broker, no server, no roster.
//
// Pins the four decisions tools/m59-hall-sell.mjs makes for the `hall-sell-mundane` errand, in the directions that cost:
//   SELLING A MAGIC PIECE is irreversible, so every path that cannot PROVE mundane (no grade, no look text, a look that
//     answered for another id, an attribute sentence on a normal grade) must come out magic or unknown, never mundane;
//   SELLING THE OPERATOR'S KEEP LIST (bows, plate armour, helms) or something nobody sells back is the order broken;
//   DRAWING PAST THE WEAPON RESERVE leaves a farmer unable to re-arm;
//   OFFERING THE RUNNER'S OWN KIT, which the start snapshot exists to stop.
// Then the errand itself is loaded and compiled (steps only, nothing sent) against a fixture chest cache.
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as H from './m59-hall-sell.mjs';

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };
const eq = (a, b, what) => { n++; assert.deepStrictEqual(a, b, what); };

// ---- the keep list
eq(H.parseKeep(null), ['bow', 'plate armor', 'helm'], 'silence is the operator\'s keep list');
eq(H.parseKeep(''), ['bow', 'plate armor', 'helm'], 'an empty param is the default too');
eq(H.parseKeep('none'), [], '"none" keeps nothing');
eq(H.parseKeep('Bow, plate armor ,helm,nerudite'), ['bow', 'plate armor', 'helm', 'nerudite'], 'a typed list, normalised');
for (const name of ['battle bow', 'longbow', 'practice bow', 'short bow', 'long bow', 'plate armor', 'helm'])
  ok(H.isKept(name), `${name} is kept ("bows of all types, plate mail, and helms")`);
for (const name of ['long sword', 'chain armor', 'scale armor', 'small round shield', 'scimitar'])
  ok(!H.isKept(name), `${name} is not kept`);

// ---- what counts as gear, by the class's kod path
eq(H.gearKind('kod/object/item/passitem/weapon/longswrd.kod'), 'weapon', 'a weapon');
eq(H.gearKind('kod/object/item/passitem/defmod/armor/leather.kod'), 'armor', 'a body armour');
eq(H.gearKind('kod/object/item/passitem/defmod/shield/goldshld.kod'), 'shield', 'a shield ("non-magic shields also")');
eq(H.gearKind('kod/object/item/passitem/defmod/helmet/simphelm.kod'), 'helmet', 'a helmet is gear, so keep=... without helm would sell it');
eq(H.gearKind('kod/object/item/passitem/attmod/gauntlet.kod'), null, 'gauntlets are not in the order');
eq(H.gearKind('kod/object/item/passitem/numbitem/gem/emerald.kod'), null, 'a gem is not gear');
eq(H.gearKind(null), null, 'an unknown item is not gear');

// ---- the candidates
const FILES = {
  'long sword': 'kod/object/item/passitem/weapon/longswrd.kod',
  'scimitar': 'kod/object/item/passitem/weapon/scimitar.kod',
  'mystic sword': 'kod/object/item/passitem/weapon/mystswrd.kod',
  'nerudite sword': 'kod/object/item/passitem/weapon/neruswd.kod',
  'battle bow': 'kod/object/item/passitem/weapon/ranged/bow/battlbow.kod',
  'leather armor': 'kod/object/item/passitem/defmod/armor/leather.kod',
  'plate armor': 'kod/object/item/passitem/defmod/armor/plate.kod',
  'robes of the disciple': 'kod/object/item/passitem/defmod/armor/robe/robedisc.kod',
  'small round shield': 'kod/object/item/passitem/defmod/shield/smlshld.kod',
  'helm': 'kod/object/item/passitem/defmod/helmet/simphelm.kod',
  'emerald': 'kod/object/item/passitem/numbitem/gem/emerald.kod',
};
const SELLERS = new Map([['long sword', [{ merchant: 'Izzio', room: 593 }]], ['nerudite sword', [{ merchant: "Ixla cha'Totlak", room: 2003 }]],
  ['battle bow', [{ merchant: 'Ixla', room: 2003 }]], ['leather armor', [{ merchant: 'Quintor', room: 374 }]],
  ['plate armor', [{ merchant: 'Rook', room: 154 }]], ['small round shield', [{ merchant: 'Quintor', room: 374 }]],
  ['helm', [{ merchant: 'Izzio', room: 593 }]]]);
const CHESTS = [
  { slot: 'r18c2', items: [{ name: 'long sword', amount: 1 }, { name: 'long sword', amount: 1 }, { name: 'Long Sword', amount: 0 },
                           { name: 'emerald', amount: 400 }, { name: 'battle bow', amount: 1 }, { name: 'mystic sword', amount: 1 }] },
  { slot: 'r18c6', items: [{ name: 'leather armor', amount: 1 }, { name: 'nerudite sword', amount: 1 }, { name: 'plate armor', amount: 1 },
                           { name: 'robes of the disciple', amount: 1 }, { name: 'small round shield', amount: 1 }, { name: 'helm', amount: 1 },
                           { name: 'scimitar', amount: 1 }] },
];
const sel = H.selectCandidates({ chests: CHESTS, sellers: SELLERS, fileOf: x => FILES[x.toLowerCase()] ?? null,
                                 buys: x => x === 'nerudite sword' ? false : true });
eq(sel.sell.map(r => [r.item, r.amount]), [['leather armor', 1], ['long sword', 3], ['small round shield', 1]],
   'sold: rebuyable mundane-by-name gear outside the keep list; an amount of 0 is one piece');
eq(sel.drop.map(r => r.item), ['nerudite sword'], 'a candidate the buyer refuses by rule is planned as a DROP');
eq(sel.excluded.kept.map(r => r.item).sort(), ['battle bow', 'helm', 'plate armor'], 'the keep list is left alone and named');
eq(sel.excluded.not_rebuyable.map(r => r.item).sort(), ['mystic sword', 'robes of the disciple', 'scimitar'],
   'what nobody sells back is NOT a candidate, and the plan names it ("that can be rebought")');
eq(sel.excluded.not_gear, 1, 'the emeralds are not gear');
eq(sel.total, 6, 'six pieces in all');
const aside = H.selectCandidates({ chests: CHESTS, sellers: SELLERS, fileOf: x => FILES[x.toLowerCase()] ?? null, setAside: { 'long sword': 2, 'leather armor': 5 } });
eq(aside.sell.map(r => [r.item, r.amount]), [['long sword', 1], ['nerudite sword', 1], ['small round shield', 1]],
   'pieces known to be magic/unsold are subtracted; a name with none left drops out of the plan');
eq(aside.excluded.set_aside, [{ item: 'leather armor', amount: 1 }, { item: 'long sword', amount: 2 }], 'and the plan says so, capped at what is there');
const none = H.selectCandidates({ chests: CHESTS, sellers: SELLERS, fileOf: x => FILES[x.toLowerCase()] ?? null, buys: () => null });
eq(none.drop.length, 0, 'CANNOT SAY IS NOT NO: an unknown buyer rule offers everything rather than dropping it');

// ---- the buyer
eq(H.buyerFor(714).merchant, "Fehr'loi Qan", '714 sells to the Royal Blacksmith');
eq(H.buyerFor(714).room, 113, 'in 113');
eq(H.buyerFor(703).merchant, 'Quintor', '703 sells in Jasper');
eq(H.buyerFor(703).cls, 'JasperBlacksmith', 'whose rule refuses nerudite');
assert.throws(() => H.buyerFor(715), /no known nearest buyer.*sell_at/); n++;
const over = H.buyerFor(714, { sellAt: 'Quintor@374', merchants: [{ name: 'Quintor', room: 374, cls: 'JasperBlacksmith' }] });
eq([over.merchant, over.room, over.cls, over.source], ['Quintor', 374, 'JasperBlacksmith', 'sell_at'], 'sell_at overrides and resolves its class');
eq(H.buyerFor(715, { sellAt: 'Somebody @ 900' }).cls, null, 'an unknown sell_at merchant has no rule: everything is offered');
assert.throws(() => H.parseSellAt('Quintor'), /merchant name.*@/); n++;

// ---- is this piece magic?
const row = (rarity, id = 11) => ({ id, name: 'long sword', rarity, rarity_name: null });
const look = (text, id = 11) => ({ id, description: text });
const PLAIN = 'A long, sharp sword. It is in excellent condition.';
eq(H.classifyPiece(row(100), look(PLAIN)).verdict, 'magic', 'grade 100 is unidentified: magic, whatever the look says');
eq(H.classifyPiece(row(1), look(PLAIN)).verdict, 'magic', 'an attribute grade is magic');
eq(H.classifyPiece(row(4), null).verdict, 'magic', 'a legendary grade needs no look');
eq(H.classifyPiece(row(200), look(PLAIN)).verdict, 'cursed', 'grade 200 is cursed and stops the run');
eq(H.classifyPiece(row(0), look(PLAIN)).verdict, 'mundane', 'grade normal and a clean look for THIS id: mundane');
eq(H.classifyPiece(row(0), look(PLAIN + " This weapon has been dedicated to Kraanan's glory.")).verdict, 'magic',
   'a TIMED attribute grades normal (GetRarityCountModifier 0) and only the look shows it: magic');
eq(H.classifyPiece(row(0), look('Beautiful and ornate, this weapon is obviously meant to give a moderate edge in games and tourneys.')).verdict,
   'magic', 'the ceremonial weapon (the operator\'s "tournaments" example)');
eq(H.classifyPiece(row(0), look('It would give a moderate advantage in tournaments.')).verdict, 'magic', 'the operator\'s own words');
eq(H.classifyPiece(row(0), look('The weapon is hot to the touch.')).verdict, 'magic', 'fiery');
eq(H.classifyPiece(row(0), look('A cloak of magic surrounds it.')).verdict, 'magic', 'shrouded (any item, armour too)');
eq(H.classifyPiece(row(0), look('The craftsmanship of this armor is admirable, obviously the result of hundreds of hours of work by expert hands.')).verdict,
   'magic', 'durable');
eq(H.classifyPiece(row(0), look('This bow offers the advantage of long ranged attacks.')).verdict, 'mundane',
   'a base description that says "advantage" without a power word is not an attribute');
eq(H.classifyPiece(row(0), look('Expertly carved for power, this bow gives you the envious advantage of a long ranged attack.')).verdict,
   'mundane', 'nor is "the envious advantage"');
eq(H.classifyPiece(row(0), look('It shimmers insubstantially.')).verdict, 'conjured', 'a conjured weapon is no sale: dropped');
eq(H.classifyPiece(row(null), look(PLAIN)).verdict, 'unknown', 'NO GRADE IS NOT NORMAL: a keeper that predates rarity cannot prove mundane');
eq(H.classifyPiece(row(undefined), null).verdict, 'unknown', 'no grade and no look');
eq(H.classifyPiece(row(0), null).verdict, 'unknown', 'normal grade but no look text: a timed attribute could hide there');
eq(H.classifyPiece(row(0), look(PLAIN, 12)).verdict, 'unknown', 'a look that answered for ANOTHER id is no answer');
ok(/12.*11/.test(H.classifyPiece(row(0), look(PLAIN, 12)).why), 'and says which ids disagreed');
eq(H.classifyPiece(row(null), look("It glows softly like a torch.")).verdict, 'magic', 'an attribute in the look is magic even ungraded');

// ---- the lap's draw
const W = { 'long sword': { weight: 80, bulk: 60 }, 'leather armor': { weight: 100, bulk: 150 }, 'plate armor': { weight: 600, bulk: 600 } };
const weigh = x => W[x] ?? null;
const R = { weight: 90, bulk: 90 };
let lap = H.planLap({ candidates: [{ item: 'long sword', amount: 10 }], room: { weight: 500, bulk: 500 }, reserve: R, weigh });
eq(lap.take, [{ item: 'long sword', amount: 5, expect: 5 }], 'the reserve is kept free: (500-90)/80 = 5 swords');
lap = H.planLap({ candidates: [{ item: 'long sword', amount: 2 }], room: { weight: 500, bulk: 500 }, reserve: R, weigh, extra: { 'long sword': 2 } });
eq(lap.take, [{ item: 'long sword', amount: 4, expect: 2 }], 'two known magic swords: ask for two more, expect two mundane');
lap = H.planLap({ candidates: [{ item: 'long sword', amount: 2 }], room: { weight: 250, bulk: 250 }, reserve: R, weigh, extra: { 'long sword': 2 } });
eq(lap.take, [], 'when the known magic pieces alone fill the room nothing is drawn');
ok(/known magic/.test(lap.blocked[0]?.why ?? ''), 'and it says why (blocked, not empty)');
lap = H.planLap({ candidates: [{ item: 'leather armor', amount: 3 }, { item: 'long sword', amount: 9 }], room: { weight: 600, bulk: 600 }, reserve: R, weigh });
eq(lap.take.map(t => [t.item, t.amount]), [['long sword', 6]], 'largest pile first, until the room (less the reserve) is used');
ok(lap.room_left.bulk >= 0 && lap.room_left.weight >= 0, 'never past the reserve line');
lap = H.planLap({ candidates: [{ item: 'long sword', amount: 9 }], room: { weight: 5000, bulk: 5000 }, reserve: R, weigh, maxPieces: 4 });
eq(lap.take[0].amount, 4, 'max_pieces caps a lap');
lap = H.planLap({ candidates: [{ item: 'long sword', amount: 9 }], room: null, reserve: R, weigh });
ok(lap.take.length === 0 && /not known/.test(lap.why), 'an unknown pack is no room, said so');
lap = H.planLap({ candidates: [{ item: 'mystery', amount: 1 }], room: { weight: 900, bulk: 900 }, reserve: R, weigh });
ok(lap.take.length === 0 && /weigh/.test(lap.blocked[0].why), 'an item that cannot be weighed is not guessed');

// ---- what the draw put in the pack
const before = [{ id: 1, name: 'long sword', amount: 0 }, { id: 2, name: 'long sword', amount: 0 }, { id: 3, name: 'shilling', amount: 50 }];
const after = [...before, { id: 7, name: 'long sword', amount: 0 }, { id: 8, name: 'long sword', amount: 0 }, { id: 9, name: 'leather armor', amount: 0 }];
let d = H.drawnRows({ before, after, names: ['long sword', 'leather armor'], own: { 'long sword': 2 } });
eq(d.rows.map(r => r.id), [7, 8, 9], 'only ids that arrived in the draw; the two swords already carried are the runner\'s');
eq(d.renumbered, false, 'no renumbering');
// a save renumbered every id mid-lap: four "new" swords, but the pack gained two
const ren = [{ id: 101, name: 'long sword' }, { id: 102, name: 'long sword' }, { id: 103, name: 'long sword' }, { id: 104, name: 'long sword' }];
d = H.drawnRows({ before, after: ren, names: ['long sword'], own: { 'long sword': 2 } });
eq(d.rows.length, 2, 'a renumbered pack: the selection is capped at what the pack gained');
eq(d.renumbered, true, 'and says ids moved');
d = H.drawnRows({ before, after: [...before, { id: 7, name: 'long sword' }], names: ['long sword'], own: { 'long sword': 3 } });
eq(d.rows.length, 0, 'the own-kit floor: three swords at the start means three stay, whatever arrived');
d = H.drawnRows({ before: [{ id: 5, name: 'mace' }], after: [{ id: 5, name: 'mace' }, { id: 6, name: 'mace' }], names: ['mace'], own: {}, worn: new Set([5]) });
eq(d.rows.map(r => r.id), [6], 'a worn piece is never counted or picked');

// ---- the report
const t = H.newTally();
H.bump(t, 'long sword', 'drawn', 3); H.bump(t, 'long sword', 'sold', 2); H.bump(t, 'Long Sword', 'returned_magic'); t.earned = 140;
eq(t.by['long sword'], { item: 'long sword', drawn: 3, sold: 2, dropped: 0, returned_magic: 1, returned_unknown: 0, returned_unsold: 0, carried: 0 },
   'one row per name, case-folded');
ok(/drawn   3  sold   2.*magic back 1/.test(H.formatTally(t)) && /earned: 140/.test(H.formatTally(t)), 'the report line says it all');

// ---- the errand, compiled against a fixture cache (nothing is sent)
const dir = mkdtempSync(join(tmpdir(), 'hall-sell-'));
try {
  process.env.M59_STORAGE_DIR = dir;
  const { StorageCache } = await import('./m59-storage.mjs');
  const store = new StorageCache({ dir });
  store.writeChest('r18c2', { room: 714, items: [{ id: 1, name: 'long sword', amount: 1 }, { id: 2, name: 'battle bow', amount: 1 },
                                                 { id: 3, name: 'mystic sword', amount: 1 }, { id: 4, name: 'leather armor', amount: 1 }], by: 'test' });
  const plan = H.planHall({ hall: 714, inputs: await H.hallInputs({ hall: 714 }) });
  ok(plan.sell.some(r => r.item === 'long sword') && plan.sell.some(r => r.item === 'leather armor'), 'the real catalogues: long sword and leather armour are sold at 714');
  ok(plan.excluded.kept.some(r => r.item === 'battle bow'), 'the battle bow is kept');
  ok(plan.excluded.not_rebuyable.some(r => r.item === 'mystic sword'), 'nobody sells a mystic sword: not a candidate');
  const { script } = await import('./fleetscripts/hall-sell-mundane.mjs');
  const log = console.log; console.log = () => {};
  let steps;
  try { steps = await script.steps({ agents: 't10', agent: 't10', hall: 714, laps: 3, keep: '', sell_at: '', drop_unsellable: 'yes', drop_room: 0, proceeds: 'hall', max_pieces: 20, home: 0 }); }
  finally { console.log = log; }
  eq(steps.length, 1 + 3 * 5 + 3 + 1, 'lift the orders, five steps a lap (walk, draw, walk, sell, drop), three at the end, restore the orders');
  ok(steps.filter(s => s.do === 'walk' && typeof s.to === 'function').every(s => Array.isArray(s.candidates) && s.candidates.includes(113)),
     'every run-time walk declares its candidate rooms');
  ok(steps[0].do === 'verify' && !steps[0].always, 'the first step lifts the runner\'s confinement (2026-11-19: confined runners skipped every walk)');
  eq(steps[1].to(), 714, 'the first lap walks to the hall');
  eq(steps[3].to(), 113, 'then to the smith');
  ok(steps.at(-1).always && steps.at(-1).do === 'verify', 'the runner\'s orders are restored whatever happened');
  ok(steps.at(-2).always && steps.at(-3).always, 'the leftovers/proceeds and the report always run');
  await assert.rejects(script.steps({ agents: 't10,t11', agent: 't10', hall: 714 }), /ONE runner/); n++;
  await assert.rejects(script.steps({ agents: 't10', agent: 't10', hall: 715 }), /no known nearest buyer/); n++;
} finally { delete process.env.M59_STORAGE_DIR; rmSync(dir, { recursive: true, force: true }); }

console.log(`m59-hall-sell: ${n} assertions passed`);
