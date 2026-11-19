#!/usr/bin/env node
// SELL THE MUNDANE GEAR OUT OF A GUILD HALL'S CHESTS -- the pure half of `hall-sell-mundane`.
//
//   node tools/m59-hall-sell.mjs plan --hall 714        what would be drawn, sold, dropped and kept (reads the chest cache only)
//   node tools/m59-hall-sell.mjs plan --hall 703 --keep bow,plate armor,helm,nerudite --sell-at "Quintor@374"
//   node tools/m59-hall-sell.mjs plan --all --json
//
// Operator, 2026-11-18: "Send someone to each guildhall to go in laps and sell (or just drop, for anything not able to be
// sold quickly in the nearest town) all *non-magic* weapons and armors from the hall chests that can be rebought -- with a
// keep list of exceptions: bows of all types, plate mail, and helms ... Non-magic shields also should be included ... magic
// here refers to the 'unidentified' or with special properties ('would give a moderate advantage in tournaments', e.g. would
// count as 'magical')."
//
// THE FOUR QUESTIONS, EACH ANSWERED ONCE, HERE:
//   1. IS IT GEAR?       a weapon, a body armour, a helmet or a shield, by the kod file the class lives in (compendium
//                        planner.json: weapon/, defmod/armor/, defmod/helmet/, defmod/shield/). Not gauntlets (attmod/),
//                        a necklace or pants.
//   2. IS IT KEPT?       the keep list, case-insensitive substrings of the name: default bow, plate armor, helm.
//   3. CAN IT BE REBOUGHT?  some merchant in substrate/m59-merchants.json SELLS it (m59-chest-evict sellersByItem). A mystic
//                        sword, robes of the disciple or a herald shield nobody sells is never a candidate, and the plan
//                        names what it left out for that reason.
//   4. WHO BUYS IT HERE? the hall's town smith (HALL_BUYERS, cited), or `sell_at`; `willBuy` (m59-buyers, the kod
//                        ObjectDesired rules) says whether that smith takes the item. One that refuses it by rule is
//                        planned as a DROP rather than walked to a counter: Quintor refuses nerudite (jssmith.kod:93).
//
// AND THE FIFTH: IS THIS PIECE MAGIC? Asked TWICE. First IN THE CHEST: every object in a container comes with its rarity
// grade (GetRarity, item.kod:715-756: unidentified 100, cursed 200, attributes 1/2/4), the chest reading keeps it per
// object (gradedRow, m59-items.mjs), and only a NORMAL-graded piece is ever a candidate -- uncommon, rare, legendary,
// unidentified, cursed and UNKNOWN (a reading with no grade) stay in the chest, counted per name and grade in the plan.
// Until 2026-11-19 the reading kept names only: hall-sell asked for "short sword" by name, the chest handed over an
// unidentified one, and it wielded itself in Animal's hand, cursed (hall 714, 05:34Z). So the draw is BY ID, of pieces
// picked from a fresh reading taken in the same visit (selectIds), and the keeper refuses an id a save has renumbered.
// Then IN THE PACK, as defence in depth: the look text carries what a grade cannot -- a TIMED attribute (enchanted,
// glowing, holy, fiery, shrouded...) inherits GetRarityCountModifier 0 (itematt.kod:587), so a dedicated long sword
// grades `normal`. classifyPiece reads both, and anything it cannot read is `unknown`, which goes back to the chests.
//
// PURE except `planHall`/the CLI, which read the cache and the catalogues and write nothing.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeOf } from './m59-items.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = s => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

// The operator's keep list, 2026-11-18: "bows of all types, plate mail, and helms (keep even mundane bows ...)".
export const DEFAULT_KEEP = Object.freeze(['bow', 'plate armor', 'helm']);

/** "bow, plate armor,helm" | ['bow'] | null -> lower-case substrings; null/'' -> DEFAULT_KEEP; 'none' -> []. */
export function parseKeep(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return [...DEFAULT_KEEP];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out = list.map(norm).filter(Boolean);
  if (out.length === 1 && out[0] === 'none') return [];
  return out;
}
export const isKept = (name, keep = DEFAULT_KEEP) => keep.some(k => norm(name).includes(norm(k)));

// ------------------------------------------------------------------ 1. what kind of gear, from the class's kod file
// `file` is planner.json's kod path, e.g. kod/object/item/passitem/defmod/shield/goldshld.kod. The tree is one directory
// per ancestor, so the path IS the IsClass answer (the same argument m59-buyers ancestryOf makes).
export function gearKind(file) {
  const f = String(file ?? '').toLowerCase().replace(/\\/g, '/');
  if (!f) return null;
  if (/\/passitem\/weapon\//.test(f)) return 'weapon';
  if (/\/defmod\/shield\//.test(f)) return 'shield';
  if (/\/defmod\/armor\//.test(f)) return 'armor';
  // A helmet is armour in the operator's sense ("keep ... plate mail, and helms" names it as an exception), so it is gear
  // and the default keep list is what spares it. Gauntlets live under attmod/ (attack modifiers) and are not in the order.
  if (/\/defmod\/helmet\//.test(f)) return 'helmet';
  return null;
}

// ------------------------------------------------------------------ 4. who buys it at this hall
// THE NEAREST SMITH TO EACH SURVEYED HALL (m59-guild-passage SURVEYED_HALLS). A fact about the map, not an order:
//   714 The Bookmaker's Guild House, Barloque -> Fehr'loi Qan, the Royal Blacksmith (113), two doors away. bqSmith.kod:48
//       buys wearable, misc and weapon from an on-demand list that never fills. (hall-sell-gear sold ~128 pieces there.)
//   703 The Den of Shadows, off the forest road (guildh3.kod exits to RID_F8) -> Jasper: Quintor's Smithy (374).
//       jssmith.kod:93 buys weapon and wearable, and refuses NeruditeSword/Armor/Bow out loud. (Zhieu B'hob @373 is
//       a JasperMerchant and buys reagents only, jsmerch.kod:85.)
//   713 The Hall of the Slaughtered Command, Ko'catan (guildh13.kod exits to RID_KOC_SOUTH) -> Ixla cha'Totlak's
//       smithy (2003), kcsmith.kod:73: weapon and wearable, nerudite included.
// A hall not here has no default: the errand refuses without `sell_at` rather than guessing a town.
export const HALL_BUYERS = Object.freeze({
  714: Object.freeze({ merchant: "Fehr'loi Qan", room: 113, cls: 'BarloqueBlacksmith', town: 'Barloque', cite: 'bqSmith.kod:48' }),
  703: Object.freeze({ merchant: 'Quintor', room: 374, cls: 'JasperBlacksmith', town: 'Jasper', cite: 'jssmith.kod:93' }),
  713: Object.freeze({ merchant: "Ixla cha'Totlak", room: 2003, cls: 'KocatanBlacksmith', town: "Ko'catan", cite: 'kcsmith.kod:73' }),
});

/** "Quintor@374" -> {merchant, room}; throws on anything else. */
export function parseSellAt(v) {
  const m = /^\s*(.+?)\s*@\s*(\d+)\s*$/.exec(String(v ?? ''));
  if (!m) throw new Error(`sell_at must be "<merchant name>@<room>", e.g. "Quintor@374"; got ${JSON.stringify(v)}`);
  return { merchant: m[1], room: Number(m[2]) };
}

/**
 * The buyer for this hall: `sellAt` when given (its class looked up by name in `merchants`, null when unknown -- then
 * every item is offered, because CANNOT SAY IS NOT NO), else HALL_BUYERS. Throws, with the reason, when there is neither.
 */
export function buyerFor(hall, { sellAt = null, merchants = [] } = {}) {
  if (sellAt != null && String(sellAt).trim()) {
    const b = parseSellAt(sellAt);
    const row = merchants.find(m => norm(m.name) === norm(b.merchant) && Number(m.room) === b.room)
             ?? merchants.find(m => norm(m.name) === norm(b.merchant));
    return { ...b, cls: row?.cls ?? null, town: null, cite: row ? `m59-merchants.json ${row.cls}` : null, source: 'sell_at' };
  }
  const d = HALL_BUYERS[Number(hall)];
  if (!d) throw new Error(`hall ${hall} has no known nearest buyer for weapons and armour (only ${Object.keys(HALL_BUYERS).join(', ')} ` +
                          'are mapped in m59-hall-sell HALL_BUYERS): pass sell_at="<merchant>@<room>"');
  return { ...d, source: 'hall default' };
}

// ------------------------------------------------------------------ the candidates
/**
 * chests: [{slot, items: [{name, amount, rarity?, rarity_name?}]}]   (StorageCache.allChests rows for ONE hall, or a
 *          fresh hall_withdraw `contents` reading)
 * sellers: Map(nameLower -> [{merchant, room}])   (m59-chest-evict sellersByItem)
 * fileOf(name) -> planner.json kod path or null;  buys(name) -> true | false | null  (the buyer's willBuy)
 * setAside: {nameLower: n} NORMAL-graded pieces of that name known to be in the chests and NOT for sale (returned for a
 *           look-text attribute, unknown, unsold) -- subtracted, so a later lap does not plan the same piece again.
 * ONLY A NORMAL GRADE IS A CANDIDATE. Rows are counted per NAME AND GRADE (eight long swords of mixed grades are not one
 * row), and every non-normal or unknown grade is `excluded.graded` with its reason: left in the chest, never drawn.
 * Returns { sell: [{item, amount, unit}], drop: [...], excluded: {kept, not_rebuyable, not_gear, set_aside, graded}, total }.
 */
export function selectCandidates({ chests = [], keep = DEFAULT_KEEP, sellers = new Map(), fileOf = () => null,
                                   buys = () => null, setAside = {}, also = [] } = {}) {
  // `also`: names the operator wants gone even though no merchant SELLS them (2026-11-19: "get rid of scimitars"). They are
  // still normal-grade only and still lose to the keep list; only the "can it be rebought" test is waived for them.
  const alsoSet = new Set((also ?? []).map(norm).filter(Boolean));
  const counts = new Map(), graded = new Map();
  for (const ch of chests) for (const it of ch.items ?? []) {
    const k = norm(it.name);
    if (!k) continue;
    const n = Number(it.amount) > 0 ? Number(it.amount) : 1;
    const g = gradeOf(it);
    if (g !== 'normal') {
      const gk = `${k}\u0000${g}`;
      const gp = graded.get(gk) ?? { k, name: it.name, grade: g, amount: 0 };
      gp.amount += n;
      graded.set(gk, gp);
      continue;
    }
    const prev = counts.get(k) ?? { name: it.name, amount: 0 };
    prev.amount += n;
    counts.set(k, prev);
  }
  const sell = [], drop = [];
  const excluded = { kept: [], not_rebuyable: [], not_gear: 0, set_aside: [], graded: [] };
  // THE GRADED PIECES, by name and grade, said out loud. Only gear is listed (a stack of herbs with no grade is not news).
  for (const { name, grade, amount } of [...graded.values()].sort((a, b) => a.k.localeCompare(b.k) || a.grade.localeCompare(b.grade))) {
    const kind = gearKind(fileOf(name));
    if (!kind) { excluded.not_gear++; continue; }
    if (isKept(name, keep)) { excluded.kept.push({ item: name, amount, kind, grade }); continue; }
    excluded.graded.push({ item: name, amount, kind, grade,
      why: grade === 'unknown' ? 'no grade recorded for it (a reading from before chests carried grades): left in the chest'
                               : `graded ${grade}: left in the chest` });
  }
  for (const [k, { name, amount }] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const kind = gearKind(fileOf(name));
    if (!kind) { excluded.not_gear++; continue; }
    if (isKept(name, keep)) { excluded.kept.push({ item: name, amount, kind }); continue; }
    const who = sellers.get(k) ?? [];
    if (!who.length && !alsoSet.has(k)) { excluded.not_rebuyable.push({ item: name, amount, kind }); continue; }
    const aside = Math.max(0, Number(setAside[k]) || 0);
    const left = amount - aside;
    if (aside) excluded.set_aside.push({ item: name, amount: Math.min(aside, amount) });
    if (left <= 0) continue;
    const row = { item: name, amount: left, kind, rebuy_from: who.slice(0, 3) };
    if (buys(name) === false) drop.push({ ...row, why: 'the buyer refuses this class by rule' });
    else sell.push(row);
  }
  return { sell, drop, excluded, total: sell.reduce((n, r) => n + r.amount, 0) + drop.reduce((n, r) => n + r.amount, 0) };
}

// ------------------------------------------------------------------ is this piece magic?
// The attribute sentences a look text gains, from the kod resources (object/passive/itematt/**). Any one of them means a
// special property, whatever the grade says. The "a <power> advantage/edge/bonus" phrase is the operator's example: the
// power words are weapatt.kod:38-47 and the endings wacerem.kod:32 (" edge in games and tourneys"), waexpert.kod:29,
// wapunish.kod:33, wafactn.kod:36-40, waghall.kod (" bonus in the defense of that hall").
export const ATTRIBUTE_DESC = Object.freeze([
  /\b(?:a|an) (?:slight|small|swift|moderate|damaging|solid|potent|severe|enormous|crushing) (?:advantage|edge|bonus)\b/i,
  /dedicated to Kraanan'?s glory/i,                       // waench.kod (enchanted: timed, grades normal)
  /glows with a pale red aura/i,                          // wacursed.kod
  /glows softly like a torch/i,                           // waglow.kod
  /glows with a (?:soft|pure), white light/i,             // iatransc.kod, waspellt.kod holy
  /reek of malevolence|hot to the touch|icy cold to the touch|nearly invisible currents|thin coating of acid/i, // waspellt.kod
  /unholy glow/i,                                         // wavamper.kod
  /zjiriaesqe/i,                                          // waparal.kod
  /insignia is emblazoned|signature flamboyantly emblazons|signature is engraved|sign of psychochild|'GMT' is stamped/i,
  /emblem of a fist holding an ankh/i,                    // wapunish.kod
  /mystical energy flits/i,                               // waspell.kod
  /beautiful and ornate/i,                                // wacerem.kod
  /is inscribed on the hilt/i,                            // waghall.kod
  /(?:sigil|family crest|army flag) is embossed/i,        // wafactn.kod
  /cloak of magic surrounds it/i,                         // iashroud.kod
  /an illusion has been cast on this item/i,              // iamisdir.kod
  /are delicately engraved on the edge/i,                 // iaengrav.kod
  /is admirable, obviously the result of hundreds of hours/i, // iadurabl.kod
]);
export const MADE_DESC = /shimmers insubstantially/i;     // iamade.kod: conjured; item.kod:1110-1126, no NPC takes it

const GRADE = { NORMAL: 0, UNIDENTIFIED: 100, CURSED: 200 };

/**
 * One drawn piece. `row` is its inventory row ({rarity, rarity_name, unidentified}); `look` is look_at's reply for the
 * SAME id ({id, description}) or null. Returns { verdict: 'mundane'|'magic'|'unknown'|'conjured'|'cursed', why }.
 *   cursed     grade 200: it would have wielded itself on entering the pack (item.kod:508-514); never sold, never dropped
 *   magic      grade 100 (unidentified), any attribute grade (1/2/4), or an attribute sentence in the look text
 *   conjured   "shimmers insubstantially": no merchant takes it, it is dropped
 *   unknown    no grade (a keeper too old to send it) or no look text for this id: returned, never sold
 *   mundane    grade 0 AND a look text for this id with no attribute sentence
 */
export function classifyPiece(row, look = null) {
  const r = row?.rarity;
  const graded = r !== null && r !== undefined && r !== '' && Number.isFinite(Number(r));
  if (graded && Number(r) === GRADE.CURSED) return { verdict: 'cursed', why: 'graded cursed (200)' };
  if (graded && Number(r) === GRADE.UNIDENTIFIED) return { verdict: 'magic', why: 'unidentified (grade 100)' };
  if (graded && Number(r) !== GRADE.NORMAL) return { verdict: 'magic', why: `graded ${row?.rarity_name ?? r} (attributes)` };
  // A REPLY ABOUT ANOTHER OBJECT IS NO REPLY (look_at's own rule, CLAUDE.md "look_at sometimes answers with the previous
  // call's object"). The id must match the row's.
  const sameId = look && row && Number(look.id) === Number(row.id);
  const text = sameId ? String(look.description ?? '') : '';
  if (text) {
    const hit = ATTRIBUTE_DESC.find(re => re.test(text));
    if (hit) return { verdict: 'magic', why: `look text: "${(text.match(hit) ?? [''])[0]}"` };
    if (MADE_DESC.test(text)) return { verdict: 'conjured', why: 'conjured ("shimmers insubstantially"): no merchant takes it' };
  }
  if (!graded) return { verdict: 'unknown', why: 'no rarity grade on the row (keeper predates it)' + (text ? '' : ', and no look text') };
  if (!text) return { verdict: 'unknown', why: look && !sameId ? `look_at answered for ${look.id}, not ${row?.id}` : 'no look text came back' };
  return { verdict: 'mundane', why: 'grade normal, no attribute in the look text' };
}

// ------------------------------------------------------------------ the lap's draw
/**
 * How many of each candidate to draw this lap. `room` is free {weight, bulk} (freeRoom), `reserve` the weapon reserve
 * kept free ({weight, bulk}), `weigh(name)` -> {weight, bulk}|null. `extra[nameLower]` is how many pieces of that name
 * are known to sit in the chests as magic/unknown: hall_withdraw takes by NAME, so it may hand those back first, and the
 * lap asks for that many more. A name whose known extras alone fill the room cannot make progress: `blocked`.
 * Returns { take: [{item, amount, expect}], blocked: [{item, why}], room_left }.
 */
export function planLap({ candidates = [], room = null, reserve = { weight: 0, bulk: 0 }, weigh = () => null,
                          extra = {}, maxPieces = Infinity } = {}) {
  const take = [], blocked = [];
  if (!room) return { take, blocked, room_left: null, why: "the runner's pack load is not known" };
  let w = room.weight - (reserve?.weight ?? 0), b = room.bulk - (reserve?.bulk ?? 0), pieces = 0;
  for (const c of [...candidates].sort((x, y) => y.amount - x.amount || x.item.localeCompare(y.item))) {
    if (!(c.amount > 0)) continue;
    const u = weigh(c.item);
    if (!u || !Number.isFinite(u.weight) || !Number.isFinite(u.bulk)) { blocked.push({ item: c.item, why: 'cannot weigh it' }); continue; }
    const fit = Math.min(u.weight > 0 ? Math.floor(Math.max(0, w) / u.weight) : Infinity,
                         u.bulk > 0 ? Math.floor(Math.max(0, b) / u.bulk) : Infinity, maxPieces - pieces);
    const ex = Math.max(0, Number(extra[norm(c.item)]) || 0);
    const n = Math.min(c.amount + ex, fit);
    if (n <= ex) {
      if (fit > 0 || ex > 0) blocked.push({ item: c.item, why: ex ? `${ex} known magic/unsold piece(s) would fill the room first` : 'no room' });
      continue;
    }
    take.push({ item: c.item, amount: n, expect: n - ex });
    w -= n * u.weight; b -= n * u.bulk; pieces += n;
  }
  return { take, blocked, room_left: { weight: w, bulk: b } };
}

// ------------------------------------------------------------------ which objects, by id, from a fresh reading
/**
 * Does a fresh hall_withdraw reading carry grades at all? A keeper from before graded chest rows answers every row with
 * `rarity: null` (or no field); then nothing in it can be called mundane and the lap is refused.
 */
export const readingHasGrades = (contents = []) =>
  contents.some(ch => (ch.items ?? []).some(r => r?.rarity !== null && r?.rarity !== undefined && Number.isFinite(Number(r.rarity))));

/** A hall_withdraw `contents` reading as planHall's `chests`. */
export const contentsAsChests = (contents = [], at = null) =>
  contents.map(ch => ({ slot: ch.slot, items: ch.items ?? [], observed_at: at }));

/**
 * THE IDS TO DRAW: for each `take` row, that many objects of that name graded NORMAL in the FRESH reading `contents`
 * (ids from hall_withdraw's own reply, stamped `chest_ids_as_of`; never from the cache, which keeps none). `skipIds` are
 * objects this run already put back (a look-text attribute, unread): not asked for again while their id stands.
 * Returns { wants: [{id, item, grade: 'normal'}], missing: [{item, wanted, found}] }.
 */
export function selectIds({ contents = [], take = [], skipIds = new Set() } = {}) {
  const used = new Set(), wants = [], missing = [];
  for (const t of take) {
    const k = norm(t.item);
    let n = 0;
    for (const ch of contents) for (const r of ch.items ?? []) {
      if (n >= t.amount) break;
      const id = Number(r?.id);
      if (!(id > 0) || used.has(id) || skipIds.has(id) || norm(r.name) !== k || gradeOf(r) !== 'normal') continue;
      used.add(id); n++;
      wants.push({ id, item: r.name, grade: 'normal' });
    }
    if (n < t.amount) missing.push({ item: t.item, wanted: t.amount, found: n });
  }
  return { wants, missing };
}

/**
 * The rows an ID draw added: `took` is the keeper's took_ids ([{id, name, grade}], each already checked in the pack by
 * id, name and grade). Re-read here: a row is a drawn piece only if it is in `after`, was not in `before`, and still
 * carries the drawn name. One that is there under ANOTHER name is `mismatched` (a handle renumbered between the keeper's
 * check and this read) and goes back unsold. Returns { rows, mismatched: [{id, name, expected}] }.
 */
export function idDrawnRows({ before = [], after = [], took = [] } = {}) {
  const had = new Set(before.map(o => Number(o.id)));
  const rows = [], mismatched = [];
  for (const t of took) {
    const o = after.find(x => Number(x.id) === Number(t.id));
    if (!o || had.has(Number(o.id))) continue;
    if (t.name && norm(o.name) !== norm(t.name)) { mismatched.push({ id: o.id, name: o.name, expected: t.name }); continue; }
    rows.push(o);
  }
  return { rows, mismatched };
}

// ------------------------------------------------------------------ what this lap's draw put in the pack
/**
 * The rows the draw ADDED, by id: in `after`, named like a drawn item, and not in `before`. Ids are handles (renumbered
 * by a system save), so the count per name is capped by what the pack actually gained, and the runner's own carried
 * count of that name (`own`, from the start snapshot) is never dipped below: if a save renumbered the pack mid-lap the
 * cap keeps the selection to the number that arrived, and the floor keeps the runner's own spare.
 * Returns { rows, renumbered }.
 */
export function drawnRows({ before = [], after = [], names = [], own = {}, worn = new Set() } = {}) {
  const want = new Set(names.map(norm));
  const had = new Set(before.map(o => Number(o.id)));
  const count = (list, k) => list.filter(o => norm(o.name) === k && !worn.has(Number(o.id)))
    .reduce((n, o) => n + (Number(o.amount) > 0 ? Number(o.amount) : 1), 0);
  const rows = [];
  let renumbered = false;
  for (const k of want) {
    const gained = Math.max(0, count(after, k) - count(before, k));
    const spare = Math.max(0, count(after, k) - (Number(own[k]) || 0));
    const fresh = after.filter(o => norm(o.name) === k && !had.has(Number(o.id)) && !worn.has(Number(o.id)));
    if (fresh.length > gained) renumbered = true;
    rows.push(...fresh.slice(0, Math.min(gained, spare)));
  }
  return { rows, renumbered };
}

// ------------------------------------------------------------------ the report
export function newTally() { return { by: {}, earned: 0, given_away: [], notes: [] }; }
export function bump(tally, name, field, n = 1) {
  const k = norm(name);
  const row = tally.by[k] ??= { item: name, drawn: 0, sold: 0, dropped: 0, returned_magic: 0, returned_unknown: 0, returned_unsold: 0, carried: 0 };
  row[field] = (row[field] ?? 0) + n;
  return row;
}
export function formatTally(tally) {
  const rows = Object.values(tally.by).sort((a, b) => a.item.localeCompare(b.item));
  const lines = rows.map(r => `  ${r.item.padEnd(20)} drawn ${String(r.drawn).padStart(3)}  sold ${String(r.sold).padStart(3)}  dropped ${String(r.dropped).padStart(3)}` +
    `  magic back ${r.returned_magic}  unknown back ${r.returned_unknown}${r.returned_unsold ? `  unsold back ${r.returned_unsold}` : ''}${r.carried ? `  STILL CARRIED ${r.carried}` : ''}`);
  return [...lines, `  shillings earned: ${tally.earned}`, ...tally.given_away.map(g => `  GIVEN AWAY (left the pack, no money): ${g}`)].join('\n');
}

// ------------------------------------------------------------------ the live inputs (read-only)
/** Everything planHall needs, read from a checkout's substrate (the chest cache, the catalogues). Writes nothing. */
export async function hallInputs({ root = join(HERE, '..'), hall } = {}) {
  const { StorageCache } = await import('./m59-storage.mjs');
  const { sellersByItem, DEFAULTS } = await import('./m59-chest-evict.mjs');
  const { categoriesOf, willBuy } = await import('./m59-buyers.mjs');
  const { weighItem } = await import('./m59-items.mjs');
  const merchants = JSON.parse(readFileSync(join(root, 'substrate', 'm59-merchants.json'), 'utf8')).merchants ?? [];
  const items = JSON.parse(readFileSync(join(root, 'substrate', 'm59-items.json'), 'utf8')).items ?? {};
  const chests = new StorageCache({ dir: process.env.M59_STORAGE_DIR || join(resolve(root), 'substrate', 'storage') })
    .allChests({ room: Number(hall) });
  return { chests, merchants, sellers: sellersByItem({ merchants, items, blocked: DEFAULTS.blocked_merchants }),
           fileOf: n => categoriesOf(n).item?.file ?? null, willBuy, weigh: weighItem };
}

/** The plan for one hall from those inputs. Pure given them. */
export function planHall({ hall, inputs, keep = DEFAULT_KEEP, sellAt = null, setAside = {}, also = [] }) {
  const buyer = buyerFor(hall, { sellAt, merchants: inputs.merchants });
  const buys = name => (buyer.cls ? inputs.willBuy(buyer.cls, name).buys : null);
  const sel = selectCandidates({ chests: inputs.chests, keep, sellers: inputs.sellers, fileOf: inputs.fileOf, buys, setAside, also });
  const oldest = inputs.chests.reduce((m, c) => Math.min(m, Number(c.observed_at) || Infinity), Infinity);
  return { hall: Number(hall), buyer, keep, ...sel, chests: inputs.chests.length,
           oldest_reading: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null };
}

export function formatPlan(plan) {
  const out = [`hall ${plan.hall}: ${plan.chests} chest reading(s), oldest ${plan.oldest_reading ?? 'never'}; buyer ${plan.buyer.merchant} @${plan.buyer.room}` +
               ` (${plan.buyer.source}${plan.buyer.cite ? `, ${plan.buyer.cite}` : ''}); keep: ${plan.keep.join(', ') || 'nothing'}`];
  for (const r of plan.sell) out.push(`  SELL ${String(r.amount).padStart(4)} ${r.item.padEnd(20)} ${r.kind}`);
  for (const r of plan.drop) out.push(`  DROP ${String(r.amount).padStart(4)} ${r.item.padEnd(20)} ${r.kind}  (${r.why}; rebought from ${r.rebuy_from.map(s => `${s.merchant} @${s.room}`).join(', ')})`);
  if (!plan.sell.length && !plan.drop.length) out.push('  nothing to sell or drop');
  if (plan.excluded.kept.length) out.push(`  kept: ${plan.excluded.kept.map(r => `${r.amount} ${r.item}`).join(', ')}`);
  if (plan.excluded.not_rebuyable.length) out.push(`  not rebuyable (no merchant sells it, left in the chests): ${plan.excluded.not_rebuyable.map(r => `${r.amount} ${r.item}`).join(', ')}`);
  if (plan.excluded.set_aside.length) out.push(`  set aside (known magic/unsold): ${plan.excluded.set_aside.map(r => `${r.amount} ${r.item}`).join(', ')}`);
  if (plan.excluded.graded?.length) {
    const n = plan.excluded.graded.reduce((s, r) => s + r.amount, 0);
    out.push(`  left in the chests by grade (${n} piece(s), never drawn): ${plan.excluded.graded.map(r => `${r.amount} ${r.item} (${r.grade})`).join(', ')}`);
  }
  out.push(`  ${plan.total} piece(s) planned, normal grade only; drawn by id from a fresh reading, then classified in the pack before ` +
           'they are sold, and magic or unread ones go back.');
  return out.join('\n');
}

// ------------------------------------------------------------------ CLI (read-only)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  if (argv[0] !== 'plan') { console.log('usage: plan --hall <703|713|714> | --all [--keep a,b] [--sell-at "Name@room"] [--root <checkout>] [--json]'); process.exit(2); }
  const halls = argv.includes('--all') ? Object.keys(HALL_BUYERS).map(Number) : [Number(arg('hall'))];
  const out = [];
  for (const hall of halls) {
    try {
      const plan = planHall({ hall, inputs: await hallInputs({ root: arg('root') ?? join(HERE, '..'), hall }),
                              keep: parseKeep(arg('keep')), sellAt: arg('sell-at') });
      out.push(plan);
      if (!argv.includes('--json')) console.log(formatPlan(plan) + '\n');
    } catch (e) { console.log(`hall ${hall}: REFUSED -- ${e.message}\n`); }
  }
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
}
