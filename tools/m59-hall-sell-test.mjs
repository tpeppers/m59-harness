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
// Graded rows (rarity 0 = normal), as chest readings carry them since 2026-11-19.
const N = (name, amount = 1) => ({ name, amount, rarity: 0, rarity_name: 'normal' });
const CHESTS = [
  { slot: 'r18c2', items: [N('long sword'), N('long sword'), N('Long Sword', 0),
                           N('emerald', 400), N('battle bow'), N('mystic sword')] },
  { slot: 'r18c6', items: [N('leather armor'), N('nerudite sword'), N('plate armor'),
                           N('robes of the disciple'), N('small round shield'), N('helm'),
                           N('scimitar')] },
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
// ---- `also` (operator 2026-11-19: "get rid of scimitars"): waives ONLY the can-it-be-rebought test
const also = H.selectCandidates({ chests: [...CHESTS, { slot: 'r20c4', items: [{ name: 'scimitar', amount: 1, rarity: 100, rarity_name: 'unidentified' }] }],
  sellers: SELLERS, fileOf: x => FILES[x.toLowerCase()] ?? null, buys: () => true, also: ['scimitar', 'plate armor'] });
ok(also.sell.some(r => r.item === 'scimitar' && r.amount === 1), 'also=scimitar makes the one NORMAL scimitar a candidate though nobody sells scimitars');
ok(also.excluded.graded.some(r => r.item === 'scimitar' && r.grade === 'unidentified'), 'the unidentified scimitar still stays in the chest');
ok(!also.sell.some(r => r.item === 'plate armor') && also.excluded.kept.some(r => r.item === 'plate armor'), 'the keep list still beats also');
ok(also.excluded.not_rebuyable.every(r => r.item !== 'scimitar'), 'and the scimitar is no longer reported as not rebuyable');

// ---- ONLY A NORMAL GRADE IS A CANDIDATE (2026-11-19, hall 714: an unidentified short sword drawn by name wielded itself)
const fileOf = x => FILES[x.toLowerCase()] ?? null;
const G = (name, rarity, extra = {}) => ({ name, amount: 1, ...(rarity === undefined ? {} : { rarity }), ...extra });
const MIXED = [{ slot: 'r18c2', items: [G('long sword', 0), G('long sword', 100), G('long sword', 1), G('long sword', 2),
                                        G('long sword', 4), G('long sword', 200), G('long sword', undefined), G('long sword', null),
                                        G('leather armor', undefined, { rarity_name: 'uncommon' }), G('leather armor', 0)] }];
const mx = H.selectCandidates({ chests: MIXED, sellers: SELLERS, fileOf, buys: () => true });
eq(mx.sell.map(r => [r.item, r.amount]), [['leather armor', 1], ['long sword', 1]],
   'eight long swords of mixed grades: ONE is a candidate (the normal one); a stack of one name does not collapse its grades');
const byGrade = Object.fromEntries(mx.excluded.graded.map(r => [`${r.item}/${r.grade}`, r.amount]));
eq(byGrade, { 'leather armor/uncommon': 1, 'long sword/cursed': 1, 'long sword/legendary': 1, 'long sword/rare': 1,
              'long sword/uncommon': 1, 'long sword/unidentified': 1, 'long sword/unknown': 2 },
   'every non-normal grade, and UNKNOWN (no grade recorded, or null), is excluded and counted per name and grade');
ok(mx.excluded.graded.every(r => /left in the chest/.test(r.why)), 'each says it is left in the chest');
ok(/graded unidentified: left in the chest/.test(mx.excluded.graded.find(r => r.grade === 'unidentified').why), 'in those words');
ok(/no grade recorded/.test(mx.excluded.graded.find(r => r.grade === 'unknown').why), 'unknown says why');
const oldCache = H.selectCandidates({ chests: [{ slot: 'r18c2', items: [{ name: 'long sword', amount: 1 }, { name: 'leather armor', amount: 1 }] }],
                                      sellers: SELLERS, fileOf });
eq(oldCache.total, 0, 'a cache reading from before chest rows carried grades plans NOTHING: unknown is never normal');
const kg = H.selectCandidates({ chests: [{ slot: 'x', items: [G('battle bow', 100)] }], sellers: SELLERS, fileOf });
ok(kg.excluded.kept.some(r => r.item === 'battle bow') && !kg.excluded.graded.length, 'a kept name stays "kept" whatever its grade');
const fp = H.formatPlan({ hall: 714, chests: 1, oldest_reading: null, buyer: { merchant: 'X', room: 1, source: 's' }, keep: [], ...mx });
ok(/left in the chests by grade \(8 piece\(s\), never drawn\).*1 long sword \(unidentified\)/.test(fp), 'the printed plan counts them', fp);

// ---- the ids to draw, from a FRESH reading (ids are handles: never from the cache, never across a save)
const FRESH = [{ slot: 'r18c2', items: [{ id: 51, name: 'short sword', amount: 1, rarity: 100 }, { id: 52, name: 'short sword', amount: 1, rarity: 0 },
                                        { id: 53, name: 'short sword', amount: 1, rarity: 0 }, { id: 54, name: 'short sword', amount: 1 }] }];
let si = H.selectIds({ contents: FRESH, take: [{ item: 'short sword', amount: 3 }] });
eq(si.wants, [{ id: 52, item: 'short sword', grade: 'normal' }, { id: 53, item: 'short sword', grade: 'normal' }],
   'only normal-graded ids, each carrying the name and grade the keeper must find');
eq(si.missing, [{ item: 'short sword', wanted: 3, found: 2 }], 'and says the plan wanted more than the reading has');
si = H.selectIds({ contents: FRESH, take: [{ item: 'short sword', amount: 3 }], skipIds: new Set([52]) });
eq(si.wants.map(w => w.id), [53], 'a piece this run put back is not asked for again while its id stands');
ok(H.readingHasGrades(FRESH) && !H.readingHasGrades([{ slot: 'x', items: [{ id: 1, name: 'long sword', rarity: null }] }]),
   'a reading with no grade at all is recognised (and the errand refuses the lap)');
const idr = H.idDrawnRows({ before: [{ id: 900, name: 'hammer' }], after: [{ id: 900, name: 'hammer' }, { id: 52, name: 'short sword' }, { id: 53, name: 'scimitar' }],
                            took: [{ id: 52, name: 'short sword' }, { id: 53, name: 'short sword' }, { id: 900, name: 'hammer' }] });
eq(idr.rows.map(r => r.id), [52], 'the drawn rows are the took_ids that arrived under their own name');
eq(idr.mismatched, [{ id: 53, name: 'scimitar', expected: 'short sword' }], 'one under another name is a renumbered handle, sent back');

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
  store.writeChest('r18c2', { room: 714, items: [{ id: 1, name: 'long sword', amount: 1, rarity: 0 }, { id: 2, name: 'battle bow', amount: 1, rarity: 0 },
                                                 { id: 3, name: 'mystic sword', amount: 1, rarity: 0 }, { id: 4, name: 'leather armor', amount: 1, rarity: 0 },
                                                 { id: 5, name: 'long sword', amount: 1, rarity: 100 }], by: 'test' });
  const plan = H.planHall({ hall: 714, inputs: await H.hallInputs({ hall: 714 }) });
  ok(plan.sell.some(r => r.item === 'long sword') && plan.sell.some(r => r.item === 'leather armor'), 'the real catalogues: long sword and leather armour are sold at 714');
  ok(plan.excluded.kept.some(r => r.item === 'battle bow'), 'the battle bow is kept');
  ok(plan.excluded.not_rebuyable.some(r => r.item === 'mystic sword'), 'nobody sells a mystic sword: not a candidate');
  ok(plan.sell.find(r => r.item === 'long sword')?.amount === 1 && plan.excluded.graded.some(r => r.item === 'long sword' && r.grade === 'unidentified'),
     'through the real cache: the unidentified long sword is left in the chest, the plain one planned');
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
  // ---- THE INCIDENT, DRIVEN: a chest with a plain and an unidentified short sword. A fake broker answers the lap's calls;
  // the only thing ever asked of hall_withdraw is the plain one, by id, with the read's stamp.
  const drive = async ({ rows, staleFirst = false } = {}) => {
    let chest = rows.map(r => ({ ...r })), saves = 3, staleLeft = staleFirst ? 1 : 0;
    const pack = [{ id: 900, name: 'hammer', amount: 0, rarity: 0 }], draws = [];
    const call = async (tool, a) => {
      if (tool === 'autopilot') return a.action === 'status' ? { mode: 'farm', policy: { confineRooms: [], townTrips: true } } : { ok: true };
      if (tool === 'inventory') return { items: pack.map(x => ({ ...x })) };
      if (tool === 'equipment') return { equipped: [{ id: 900, name: 'hammer' }] };
      if (tool === 'fleet') return { fleet: [{ agent: 't10', pack: { max: 3000, weight: 200, bulk: 200 } }] };
      if (tool === 'look_at') return { id: a.target, description: 'A short, sharp sword.' };
      if (tool === 'hall_withdraw') {
        const wants = a.wants ?? [];
        if (!wants.length && !(a.deposit ?? []).length)
          return { ok: true, contents: [{ slot: 'r18c2', chest_id: 2578, items: chest.map(x => ({ ...x })) }],
                   chest_ids_as_of: { read_at: 1, saves_seen: saves, saving: false } };
        draws.push(a);
        if (staleLeft-- > 0) {        // a save renumbered everything between the read and the draw
          saves++; chest = chest.map(x => ({ ...x, id: x.id + 100 }));
          return { ok: true, took_ids: [], short_ids: wants.map(w => ({ id: w.id })), chest_ids_stale: true, stopped: 'a server save has begun since the chest read' };
        }
        const took_ids = [];
        for (const w of wants) {
          const i = chest.findIndex(x => x.id === w.id && (w.grade == null || (x.rarity === 0 ? 'normal' : 'other') === w.grade));
          if (i >= 0) { const [o] = chest.splice(i, 1); pack.push(o); took_ids.push({ id: o.id, name: o.name, grade: 'normal' }); }
        }
        return { ok: true, took_ids, short_ids: [], refused_ids: [], returned_ids: [], stopped: null };
      }
      return { ok: true };
    };
    const log2 = console.log; const lines = []; console.log = (...x) => lines.push(x.join(' '));
    let res;
    try {
      const st = await script.steps({ agents: 't10', agent: 't10', hall: 714, laps: 1, keep: '', sell_at: '', drop_unsellable: 'yes', drop_room: 0, proceeds: 'hall', max_pieces: 20, home: 0 });
      await st[0].fn({ call, agent: 't10' });
      res = await st[2].fn({ call, agent: 't10' });
    } finally { console.log = log2; }
    return { draws, pack, res, lines };
  };
  const INC = [{ id: 51, name: 'short sword', amount: 1, rarity: 100, rarity_name: 'unidentified' },
               { id: 52, name: 'short sword', amount: 1, rarity: 0, rarity_name: 'normal' }];
  let dv = await drive({ rows: INC });
  ok(dv.draws.length === 1, 'one draw', JSON.stringify(dv.draws));
  eq(dv.draws[0]?.wants, [{ id: 52, item: 'short sword', grade: 'normal' }], 'THE INCIDENT: only the plain short sword is asked for, by id, never by name');
  ok(dv.draws.every(d => (d.wants ?? []).every(w => w.id != null)), 'no want by name in any draw');
  ok(dv.draws[0]?.chest_ids_as_of?.saves_seen === 3, 'with the stamp of the reading the id came from');
  ok(dv.pack.some(x => x.id === 52) && !dv.pack.some(x => x.id === 51), 'the unidentified one never leaves the chest');
  ok(dv.lines.some(l => /left in the chests by grade: 1 short sword \(unidentified\)/.test(l)), 'and the lap says it left it', dv.lines.join('\n'));
  dv = await drive({ rows: INC, staleFirst: true });
  ok(dv.draws.length === 2 && dv.draws[1].wants?.[0]?.id === 152 && dv.draws[1].chest_ids_as_of?.saves_seen === 4,
     'a save between read and draw: the chest is re-read and the piece re-selected by name and grade (new id, new stamp)', JSON.stringify(dv.draws));
  ok(!dv.draws.some(d => (d.wants ?? []).some(w => w.id === 51 || w.id === 151)), 'and the unidentified one is still never asked for');
  dv = await drive({ rows: INC.map(({ rarity, rarity_name, ...r }) => r) });
  ok(dv.draws.length === 0 && dv.res?.ok === false && /no grades/.test(dv.res.why), 'a fresh reading with no grades is refused: nothing drawn by name', JSON.stringify(dv.res));

  await assert.rejects(script.steps({ agents: 't10,t11', agent: 't10', hall: 714 }), /ONE runner/); n++;
  await assert.rejects(script.steps({ agents: 't10', agent: 't10', hall: 715 }), /no known nearest buyer/); n++;
} finally { delete process.env.M59_STORAGE_DIR; rmSync(dir, { recursive: true, force: true }); }

console.log(`m59-hall-sell: ${n} assertions passed`);
