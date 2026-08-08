#!/usr/bin/env node
// WHAT EVERY ITEM WEIGHS, so the fleet can know when it is full.
//
//   node tools/m59-items.mjs build     # write substrate/m59-items.json from the kod
//   node tools/m59-items.mjs           # show what is known, and what is not
//   node tools/m59-items.mjs mace      # look one up
//
// WHY THIS EXISTS. The server refuses a pickup — and DELETES a spell-created weapon
// rather than handing it over — when `piWeight_hold + weight > GetWeightMax`, or the
// same for bulk (holder.kod:259 ReqNewHold -> :281 CanHoldWeightAndBulk). The ceiling
// is exact arithmetic on an attribute we already read:
//
//     GetWeightMax = GetBulkMax = 1700 + might * 20     player.kod:10456, :10461
//
// but the LOAD was unknowable. piWeight_hold lives on the server and is never sent, and
// no packet carries an item's weight or bulk either — so "is there room" could only be
// answered by trying and losing the mana. That cost a real afternoon: create weapon
// rolls, succeeds, builds the weapon, asks ReqNewHold, and on refusal deletes it and
// keeps the 15 mana (creaweap.kod:116-129).
//
// The weights are not secret, they are just not on the wire. Every item class declares
// viWeight and viBulk, or inherits them, and Item itself defaults both to 10
// (item.kod:66-67). So this reads them once, from the kod, and writes a table the
// broker can add up.
//
// KEYED BY NAME, BECAUSE A NAME IS ALL THE PROTOCOL GIVES US. An inventory entry is
// {id, name, amount} — the class is not in it. So the join is through vrName, the
// resource string each class names itself with, which is exactly the string the client
// resolves for display. Where two classes share a display name the heavier is kept and
// both are recorded, because guessing light is the direction that fails: it says there
// is room when there is not, which is the bug this exists to prevent.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KODDB = join(HERE, '..', 'compendium', 'data', 'koddb.json');
export const ITEMS_FILE = join(HERE, '..', 'substrate', 'm59-items.json');

// Item.viWeight / Item.viBulk (item.kod:66-67). Used when nothing in the chain says
// otherwise, which is the common case for the small stuff.
const DEFAULT_WEIGHT = 10;
const DEFAULT_BULK = 10;

// Walk the inheritance chain for the first class that declares this classvar. koddb
// resolves each chain already, most-derived first, so this is a lookup rather than a
// graph walk. Returns null when nothing in the chain declares it at all — which is
// different from "declared as 0" and must not collapse into the default silently.
function inherited(classes, chain, name) {
  for (const step of chain || []) {
    const cls = classes[String(step).toLowerCase()];
    const v = cls?.classvars?.[name];
    if (v && typeof v.value === 'number') return { value: v.value, from: cls.name };
  }
  return null;
}

// The display name a class calls itself, which is what the protocol hands us back.
//
// TWO CLASSVARS, NOT ONE. Most items name themselves with vrName, but anything whose
// identity is concealed until it is identified — rings, potions, the disguised gear —
// carries vrRealName instead and leaves vrName unset. Reading only vrName silently
// dropped every one of those from the table, and the fleet noticed: Statler's six signet
// rings came back "unweighed" and withheld its room_for, which is the honest failure but
// still a hole. SignetRing declares viWeight 2 perfectly plainly (ringsignet, :36-37).
function displayName(cls) {
  for (const key of ['vrName', 'vrRealName']) {
    const rsc = cls?.classvars?.[key]?.rsc;
    if (rsc?.kind === 'string' && typeof rsc.value === 'string') return rsc.value.trim();
  }
  return null;
}

export function buildItemTable(koddbFile = KODDB) {
  const db = JSON.parse(readFileSync(koddbFile, 'utf8'));
  const classes = db.classes || {};
  const byName = new Map();
  let considered = 0, defaulted = 0;

  for (const cls of Object.values(classes)) {
    // Items only. Anything whose chain does not pass through Item has no weight that
    // matters here — creatures, rooms, spells and the rest are never in a pack.
    const chain = cls.chain || [];
    if (!chain.some(x => String(x).toLowerCase() === 'item')) continue;
    const name = displayName(cls);
    if (!name) continue;                       // abstract classes name nothing
    considered++;

    const w = inherited(classes, chain, 'viWeight');
    const b = inherited(classes, chain, 'viBulk');
    if (!w || !b) defaulted++;
    const entry = {
      name,
      weight: w?.value ?? DEFAULT_WEIGHT,
      bulk: b?.value ?? DEFAULT_BULK,
      cls: cls.name,
      declared_by: { weight: w?.from ?? 'Item (default)', bulk: b?.from ?? 'Item (default)' },
    };

    const key = name.toLowerCase();
    const prev = byName.get(key);
    // KEEP THE HEAVIER. Two classes can share a display name, and the protocol cannot
    // tell us which one is in the pack. Underestimating says there is room when there
    // is not, and that is the failure this table exists to prevent; overestimating only
    // makes a character shed something early.
    if (!prev) byName.set(key, { ...entry, also: [] });
    else {
      const keep = entry.weight > prev.weight ? entry : prev;
      const other = entry.weight > prev.weight ? prev : entry;
      byName.set(key, { ...keep, also: [...(prev.also || []), { cls: other.cls, weight: other.weight, bulk: other.bulk }] });
    }
  }

  // WHAT COUNTS AS FOOD, taken from the class tree rather than from a word list.
  //
  // This matters more than it looks. Resting stops awarding vigor at 80 of 200
  // (REST_VIGOR_CAP), so everything above that has to be EATEN — food is not a
  // convenience here, it is the only route to the vigor a character needs to fight well.
  // And the fleet had never bought any: restockReagents filtered every shop list through
  // shareKind, which matches elderberry and herbs and nothing else, so a character could
  // stand in a shop selling bread and buy nothing. Ten characters sat at exactly 80 for
  // an entire session because of it.
  //
  // Anything descending from Food is food. Guessing by name would have missed "Inky-cap
  // mushroom" and "goblet of ale" and included the mushrooms that are reagents.
  //
  // HOW MUCH each food is worth, which turns out to be the whole question.
  //
  // viNutrition converts one-for-one into vigor: eating sends AddExertion(-10000 *
  // nutrition), and vigor moves by exertion/10000 (player.kod:1277-1278). viFilling is
  // what it costs to eat, against a stomach bounded at 100 that drains at FOOD_USE_RATE
  // 12 per 100 ticks — about 7 a minute, so a full stomach clears in a quarter of an hour.
  //
  // Without these numbers the fleet ranked food by price and bought the cheapest, which
  // is a water skin: THREE vigor. A character needing to climb from the resting cap of
  // 80 to 180 would need thirty-four of them, and m59-feed.mjs bought six, reported
  // success, and moved Rizzo by eighteen. A cheese is thirty for forty filling — the
  // same trip, one item.
  //
  // Not in koddb's classvars, which carries only the vr* resource vars; these are
  // integer properties. The Food base's own 10/50 does not survive extraction either,
  // so the chain is walked and the kod's defaults stand in at the end, cited rather
  // than guessed.
  const FOOD_DEFAULT = { nutrition: 10, filling: 50, from: 'food.kod:32-33' };
  const byClassName = new Map(Object.values(classes).map(c => [c.name, c]));
  const propOf = (cls, key) => {
    for (let c = cls, guard = 0; c && guard < 24; guard++) {
      const v = c.properties?.[key]?.value;
      if (typeof v === 'number') return v;
      c = byClassName.get(c.parent);
    }
    return null;
  };

  const food = {};
  for (const cls of Object.values(classes)) {
    if (!(cls.chain || []).some(x => String(x).toLowerCase() === 'food')) continue;
    const name = displayName(cls);
    if (!name) continue;
    const nutrition = propOf(cls, 'viNutrition');
    const filling = propOf(cls, 'viFilling');
    food[name.toLowerCase()] = {
      name, cls: cls.name,
      nutrition: nutrition ?? FOOD_DEFAULT.nutrition,
      filling: filling ?? FOOD_DEFAULT.filling,
      ...(nutrition == null || filling == null ? { assumed: FOOD_DEFAULT.from } : {}),
    };
  }

  // EVERY WEAPON'S NAME, so that no real one can score zero.
  //
  // weaponScore ranks on a word list, which is fine for ordering and wrong as a
  // membership test: it wanted "war hammer" and the server says "hammer", so a hammer
  // scored zero — the same answer as a helmet. Clifford carried one for an entire
  // session and punched monsters, and equip_best reported "nothing wieldable in the
  // pack" while holding it. Three of the game's twenty-one named weapons were invisible
  // this way: hammer, spiritual hammer, and the Dark Blade of Roq.
  //
  // The word list keeps the ordering, because which weapon is BETTER is a judgement the
  // class tree does not carry. This only decides what counts as one at all.
  const weapons = {};
  for (const cls of Object.values(classes)) {
    if (!(cls.chain || []).some(x => String(x).toLowerCase() === 'weapon')) continue;
    const name = displayName(cls);
    if (name) weapons[name.toLowerCase()] = { name, cls: cls.name };
  }

  return {
    builtAt: null,                              // stamped by the caller; see build()
    source: 'compendium/data/koddb.json',
    defaults: { weight: DEFAULT_WEIGHT, bulk: DEFAULT_BULK, from: 'item.kod:66-67' },
    capacity_formula: '1700 + might * 20, for weight AND bulk (player.kod:10456, :10461)',
    counts: { item_classes: considered, distinct_names: byName.size, used_defaults: defaulted,
              foods: Object.keys(food).length, weapons: Object.keys(weapons).length },
    items: Object.fromEntries([...byName.entries()].sort()),
    food,
    weapons,
  };
}

// ------------------------------------------------------------------ lookup

let cached = null;
export function loadItems(file = ITEMS_FILE) {
  if (cached) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

// What one item weighs, by the name the protocol gave us. Returns null for anything the
// table does not know — the caller has to decide what to do about that, and every
// caller here treats it as "unknown", never as zero.
export function weighItem(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t) return null;
  const hit = t.items[String(name || '').trim().toLowerCase()];
  return hit ? { weight: hit.weight, bulk: hit.bulk, cls: hit.cls } : null;
}

// ADD UP A PACK, and say how much of it we could not account for.
//
// `unknown` is the number that decides whether the total means anything. A load of 900
// with three unknown items is not a load of 900; it is a lower bound. Callers that use
// this to answer "is there room" must treat any unknown as a reason to make room rather
// than to conclude there is some.
export function weighPack(items, file = ITEMS_FILE) {
  let weight = 0, bulk = 0;
  const unknown = [];
  for (const it of items || []) {
    const n = it.amount ?? 1;
    const w = weighItem(it.name, file);
    if (!w) { unknown.push(it.name); continue; }
    weight += w.weight * n;
    bulk += w.bulk * n;
  }
  return { weight, bulk, unknown, exact: unknown.length === 0 };
}

// ------------------------------------------------------------------- cli

function build() {
  const table = buildItemTable();
  table.builtAt = new Date().toISOString();
  writeFileSync(ITEMS_FILE, JSON.stringify(table, null, 1));
  console.log(`wrote ${ITEMS_FILE}`);
  console.log(`  ${table.counts.item_classes} item classes -> ${table.counts.distinct_names} distinct names`);
  console.log(`  ${table.counts.used_defaults} fell back to Item's 10/10`);
  const heavy = Object.values(table.items).sort((a, b) => b.weight - a.weight).slice(0, 5);
  console.log('  heaviest:', heavy.map(h => `${h.name} ${h.weight}`).join(', '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === 'build') build();
  else if (arg) {
    const w = weighItem(arg);
    console.log(w ? `${arg}: weight ${w.weight}, bulk ${w.bulk} (${w.cls})` : `${arg}: not in the table`);
  } else {
    const t = loadItems();
    if (!t) { console.log('no table yet — run: node tools/m59-items.mjs build'); process.exit(1); }
    console.log(`${t.counts.distinct_names} items, built ${t.builtAt}`);
    console.log(`${t.counts.used_defaults} used Item's default 10/10`);
    console.log(t.capacity_formula);
  }
}

// Is this item food — i.e. does eating it raise vigor past the resting cap of 80?
// Answered from the Food class tree, not from a word list. Unknown names are NOT food:
// buying something that turns out to be scenery wastes money the fleet does not have.
export function isFood(name, file = ITEMS_FILE) {
  return !!foodValue(name, file);
}

// What eating this is worth: {nutrition, filling}, where nutrition IS the vigor gained.
// Null for anything that is not food. Rank a shop's stock on `nutrition` — the fleet's
// constraint is the stomach and the walk to the shop, not the shillings.
export function foodValue(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t?.food) return null;
  return t.food[String(name || '').trim().toLowerCase()] || null;
}

// The stomach admits 100 and drains ~7.2 a minute (FOOD_USE_RATE 12, player.kod:51,1347).
// So this is how many of a food a character can actually get through in one sitting —
// buying more than this is buying it for later, which is fine, but reporting it as
// vigor now is not.
// Is this the name of a real weapon class? Membership only — weaponScore still decides
// which of two is better. Taken from the Weapon chain rather than guessed at.
export function isWeaponName(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t?.weapons) return false;
  return !!t.weapons[String(name || '').trim().toLowerCase()];
}

export const STOMACH_MAX = 100;
export function servingsAtOnce(name, file = ITEMS_FILE) {
  const f = foodValue(name, file);
  if (!f) return 0;
  return Math.max(1, Math.floor(STOMACH_MAX / Math.max(1, f.filling)));
}
