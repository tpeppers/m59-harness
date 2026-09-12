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
//
// AND KOD IS CASE-INSENSITIVE, WHICH THE JOIN WAS NOT. `Rose` declares `rose_name_rsc`
// in its resources and refers to it as `Rose_name_rsc` in its classvars (rose.kod:20, :25);
// Stew and SwordShard do the same the other way round. The extractor matched the two
// case-sensitively, left `rsc` unset, and this function then dropped the class as
// "abstract" — so the rose, the bowl of stew and the sword shard were not in the table,
// `resolve_item_names` refused every one of them, and a vault list could not name a rose
// at all. When the join is missing, the class's own resources are searched by
// case-folded name before giving up.
function displayName(cls) {
  for (const key of ['vrName', 'vrRealName']) {
    const cv = cls?.classvars?.[key];
    let rsc = cv?.rsc;
    if (!rsc && typeof cv?.expr === 'string' && cls?.resources) {
      const want = cv.expr.trim().toLowerCase();
      const hit = Object.keys(cls.resources).find(k => k.toLowerCase() === want);
      if (hit) rsc = cls.resources[hit];
    }
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

  // UNIDENTIFIED SPELL ITEMS NAME THEMSELVES AFTER THEIR BASE CLASS, AND KODDB DROPPED IT.
  //
  // An unread scroll is "scroll" and an unidentified wand is "wand" — Scroll and Wand set
  // vrName to Scroll_name_rsc / Wand_name_rsc (scroll.kod:19,59; wand.kod:19,65) and show
  // the real label only once identified. koddb carries no vrName for either class, so the
  // loop above filed them as abstract and the table never learned the name the protocol
  // actually hands us. The cost was not a wrong weight but a refused pass: weighPack marks
  // the pack "unweighable", checkIfShouldSell turns that into an unconditional market trip,
  // and a character confined to its room re-decided that trip every second instead of
  // resting or eating — Janice at vigor 13 with 136 mushrooms aboard, 2026-08-26.
  //
  // The weights are still read off the chain, never typed here: Scroll declares 3/5
  // itself (scroll.kod:48-49) and Wand inherits SpellItem's 3/5 (spelitem.kod:61-62).
  // IDENTIFIED SPELL ITEMS CARRY THEIR NAME IN vrLabelName, NOT vrName.
  //
  // Once read, a scroll is "scroll of discord" and a wand "wand of fire": SpellItem swaps
  // vrName for vrLabelName on identification (spelitem.kod:109-116), and the subclasses
  // declare only the label. displayName() reads vrName/vrRealName, so every identified
  // scroll and wand was missing from the table — Janice's two scrolls of discord kept her
  // pack "unweighable" and her confined keeper re-deciding a refused market trip every
  // second, at vigor 10, an hour after the generic names were added. Same weights, same
  // chain, read off the kod like everything else here.
  for (const cls of Object.values(classes)) {
    const chain = (cls.chain || []).map(x => String(x).toLowerCase());
    if (!chain.includes('scroll') && !chain.includes('wand')) continue;
    const rsc = cls?.classvars?.vrLabelName?.rsc;
    const name = rsc?.kind === 'string' && typeof rsc.value === 'string' ? rsc.value.trim() : null;
    if (!name || byName.has(name.toLowerCase())) continue;
    const w = inherited(classes, cls.chain || [], 'viWeight');
    const b = inherited(classes, cls.chain || [], 'viBulk');
    if (!w || !b) defaulted++;
    considered++;
    byName.set(name.toLowerCase(), {
      name,
      weight: w?.value ?? DEFAULT_WEIGHT,
      bulk: b?.value ?? DEFAULT_BULK,
      cls: cls.name,
      declared_by: { weight: w?.from ?? 'Item (default)', bulk: b?.from ?? 'Item (default)' },
      also: [],
      identified_label: true,
    });
  }

  const GENERIC_UNIDENTIFIED = { scroll: 'scroll', wand: 'wand' };
  for (const [clsKey, name] of Object.entries(GENERIC_UNIDENTIFIED)) {
    const cls = classes[clsKey];
    if (!cls || byName.has(name)) continue;
    const chain = cls.chain || [];
    const w = inherited(classes, chain, 'viWeight');
    const b = inherited(classes, chain, 'viBulk');
    if (!w || !b) { defaulted++; }
    considered++;
    byName.set(name, {
      name,
      weight: w?.value ?? DEFAULT_WEIGHT,
      bulk: b?.value ?? DEFAULT_BULK,
      cls: cls.name,
      declared_by: { weight: w?.from ?? 'Item (default)', bulk: b?.from ?? 'Item (default)' },
      also: [],
      unidentified: true,
    });
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

  // DOES IT SURVIVE A VAULT? READ THE TIMER, NEVER THE WORD "WAND".
  //
  // Only a SpellItem carries piGoBadTime, and it rots on it: the base is GO_BAD_TIME =
  // 86,400,000ms, one day (spelitem.kod:83), and THE TIMER KEEPS RUNNING IN THE VAULT.
  // That is why the temporary attributes -- shrouded, enchanted, glowing -- are worth
  // selling rather than storing. Wand and Scroll override it to -1 (wand.kod:69,
  // scroll.kod:62) and are the only SpellItems that keep for ever.
  //
  // Anything OUTSIDE the SpellItem tree never had the property at all, so it never
  // spoils. That includes two the operator named: "gnarled staff" (StaffOfJolting is
  // SpecialWand is PassiveItem) and "relic of Qor" (Scepter is PassiveItem) -- wands in
  // every sense a player cares about, and neither one a SpellItem. Matching the word
  // "wand" would have got the staff right by luck and the relic wrong. Reading the chain
  // gets both, which is the whole reason this is derived rather than typed.
  //
  // WHAT THIS COST WITHOUT IT: VAULT_KEEP listed 'wand' and 'scroll' and explained in its
  // own comment that the families keep for ever -- but the keep predicate is EXACT
  // canonical identity, so it protected the two items literally named "wand" and "scroll"
  // (the unidentified ones) and sold the twenty and sixteen identified ones, including
  // the four wands of striking the guild plan is trying to collect.
  //
  // AND READ WHAT THIS NUMBER IS BEFORE TRUSTING IT: **it is 0 for every one of the 249
  // named items**, and that is the correct answer rather than a broken one. The timer is
  // per-INSTANCE and is gated on `labelled` -- spelitem.kod:115-118 skips StartGoBadTimer
  // outright for a labelled item, "so it's in a sales list. We don't want labelled objects
  // to go bad". An item only HAS a display name here once it is labelled, so every item
  // this table can name is one whose timer never started. The 29 Potion classes, which do
  // inherit the live 24h default, carry vrLabelName and no vrName and so are absent from
  // the table entirely -- the blind spot recorded in m59-itemcheck.mjs's header.
  //
  // Kept anyway, as the CLASS-level floor: it is cheap, it is derived, and it fires the day
  // somebody adds a class with a live timer and a name. It is not a licence to store
  // anything -- the enchantment decay that actually empties vaults (shrouded, glowing,
  // enchanted: 1-24h, and the clock runs inside the vault) is an instance property this
  // table never sees.
  //
  // The one thing it settles, and it settles it in our favour: a DISTILLED potion is created
  // #labelled=TRUE with iGoBadTime = -1 and the comment "% Potion never goes bad"
  // (distill.kod:293-296). Potions we make ourselves keep for ever, so a guild chest full of
  // them is not a chest full of sludge in a day.
  for (const entry of byName.values()) {
    const cls = byClassName.get(entry.cls);
    if (!cls) continue;
    if (!(cls.chain || []).some(x => String(x).toLowerCase() === 'spellitem')) continue;
    const ms = propOf(cls, 'piGoBadTime');
    entry.spoils_ms = (typeof ms === 'number' && ms > 0) ? ms : 0;
  }

  // THE WAND AND SCROLL FAMILIES -- AND "WAND" IS THREE DIFFERENT BRANCHES OF THE TREE.
  //
  // Kept as its own section for the same reason `food` and `weapons` are: a caller wanting
  // "the wand family" should not have to re-derive it and get a slightly different answer.
  //
  // Recognised by chain OR by name, because NEITHER ALONE GETS ALL OF THEM:
  //
  //   SlitherWand    -> Wand -> SpellItem -> PassiveItem     "wand of striking"
  //   HealWand       -> SpecialWand -> PassiveItem           "wand of healing"
  //   MysteryWand    -> PassiveItem                          "mysterious wand"
  //   StaffOfJolting -> SpecialWand -> PassiveItem           "gnarled staff"
  //
  // Three parents and one word. Chain alone misses the MysteryWand hanging straight off
  // PassiveItem; name alone misses the gnarled staff, which is a wand that does not say so.
  // The guild plan is actively collecting four of the five, so a family that drops any of
  // them is a family that sells them.
  //
  // The never-spoils property is then VERIFIED off the timer rather than assumed -- if one
  // of these ever carries a live go-bad timer it drops out of the list instead of rotting
  // in a vault. `also` is checked too: two classes can share a display name, and the
  // protocol cannot tell us which one is in the pack, so a name is only safe to keep when
  // EVERY class wearing it is safe.
  const WAND_PARENTS = new Set(['wand', 'scroll', 'specialwand']);
  const keeps = {};
  for (const entry of byName.values()) {
    if (entry.spoils_ms) continue;                    // its clock is running; do not store it
    const cls = byClassName.get(entry.cls);
    const chain = (cls?.chain || []).map(x => String(x).toLowerCase());
    const byChain = chain.some(x => WAND_PARENTS.has(x));
    const byLabel = /\b(wands?|scrolls?|staff|staves)\b/i.test(entry.name);
    if (!byChain && !byLabel) continue;
    keeps[entry.name.toLowerCase()] = {
      name: entry.name, cls: entry.cls, by: byChain ? 'chain' : 'name',
    };
  }

  return {
    builtAt: null,                              // stamped by the caller; see build()
    source: 'compendium/data/koddb.json',
    defaults: { weight: DEFAULT_WEIGHT, bulk: DEFAULT_BULK, from: 'item.kod:66-67' },
    capacity_formula: '1700 + might * 20, for weight AND bulk (player.kod:10456, :10461)',
    counts: { item_classes: considered, distinct_names: byName.size, used_defaults: defaulted,
              foods: Object.keys(food).length, weapons: Object.keys(weapons).length,
              keeps: Object.keys(keeps).length },
    items: Object.fromEntries([...byName.entries()].sort()),
    food,
    weapons,
    keeps,
  };
}

// ------------------------------------------------------------------ lookup

let cached = null;
export function loadItems(file = ITEMS_FILE) {
  if (cached) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

// ITEM IDENTITY FOR HUMAN-WRITTEN SETTINGS.
//
// Punctuation and a final plural are spelling, not identity: "inky cap mushrooms"
// should resolve to the datastore's "Inky-cap mushroom", and "arrow" to "arrows".
// Words may not be omitted, however. In particular, "mushroom" is its own item and
// must never mean every item whose longer name happens to contain that word.
const ITEM_IRREGULAR = { teeth: 'tooth', feet: 'foot', mice: 'mouse', geese: 'goose',
  leaves: 'leaf', knives: 'knife', wolves: 'wolf' };
const itemWord = word => ITEM_IRREGULAR[word]
  ?? (word.endsWith('ies') && word.length > 4 ? `${word.slice(0, -3)}y`
    : /(?:ses|xes|hes)$/.test(word) ? word.slice(0, -2)
    : word.endsWith('s') && !word.endsWith('ss') && word.length > 3 ? word.slice(0, -1)
    : word);
export const itemNameKey = name => String(name || '').toLowerCase()
  .split(/[^a-z0-9]+/).filter(Boolean).map(itemWord).join(' ');

// DID YOU MEAN — because "does not resolve" is true and useless on its own.
//
// The refusal used to say only that the name was wrong, and a wrong item name is one of the
// quietest faults here: a single unresolvable entry rejects the WHOLE autopilot order, so
// one typo threw away every station change, hunt list and weapon ban computed for sixteen
// of twenty-one characters in a night — the symptom being bans that were visibly correct in
// the orders and never reached a single hand. The name that did it was "magic wand", and the
// item is called "wand".
//
// Scored, cheapest signal first, because the mistakes people actually make are not random
// strings: a plural or a spacing slip (`herbs` -> `herb`, `elder berry`), a qualifier nobody
// dropped (`magic wand` -> `wand`), or an abbreviation (`nerudite` -> `nerudite sword`).
// Levenshtein is the last resort and is bounded, so it never proposes something unrelated
// merely because nothing else scored.
const editDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
};

export function suggestItemName(name, { file = ITEMS_FILE, limit = 3 } = {}) {
  const raw = String(name ?? '').trim();
  const key = itemNameKey(raw);
  if (!key) return [];
  const table = loadItems(file);
  if (!table?.items) return [];
  const words = key.split(' ').filter(Boolean);
  const scored = [];
  for (const item of Object.values(table.items)) {
    const cand = itemNameKey(item.name);
    if (!cand) continue;
    let score = null;
    if (cand === key) score = 0;
    else if (cand.split(' ').some(w => words.includes(w))) {
      // A SHARED WHOLE WORD IS THE STRONGEST HINT THERE IS. "magic wand" and "wand" share
      // one, and no edit distance would ever have ranked them together.
      score = 1 + Math.abs(cand.length - key.length) / 100;
    } else if (cand.startsWith(key) || key.startsWith(cand)) score = 2;
    else {
      const d = editDistance(cand, key);
      // Bounded: a third of the name may differ, no more. Without this the suggester
      // confidently proposes an unrelated item simply because nothing else scored at all,
      // which is worse than saying nothing.
      if (d <= Math.max(1, Math.floor(Math.max(cand.length, key.length) / 3))) score = 3 + d;
    }
    if (score !== null) scored.push({ name: item.name, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
               .slice(0, limit).map(x => x.name);
}

// A REPAIR IS NOT A SUGGESTION, AND MOST SUGGESTIONS MUST NEVER BE APPLIED.
//
// `suggestItemName` ranks by nearness, which is right for a human reading a refusal and
// WRONG for a machine rewriting a config. Its top answer for "gold shield" is "gold sword" —
// a different item, confidently proposed — and for "heat scroll" it is "generic scroll" while
// the real item is "scroll of heat". Applying the first suggestion would quietly change what
// the fleet is asking for, which is worse than leaving a name that visibly fails.
//
// So a repair is only offered when the two names are the SAME WORDS, and the confidence says
// which rule earned it:
//
//   exact    the word sets match once the filler ("of", "the", "a") is dropped.
//            "heat scroll" -> "scroll of heat", "ore chunk" -> "chunk of ore".
//   joined   they are identical with the punctuation and spacing taken out.
//            "knightshield" -> "knight's shield", "yrxlsap" -> "yrxl sap".
//
// Everything else — a dropped adjective, an extra noun, a near-miss spelling — is left alone
// and reported. Those are decisions about what the operator MEANT, and this cannot know.
const FILLER = new Set(['of', 'the', 'a', 'an']);
const bagOf = (key) => key.split(' ').filter(w => w && !FILLER.has(w)).sort().join(' ');
const joined = (key) => key.split(' ').join('');

export function repairItemName(name, { file = ITEMS_FILE } = {}) {
  const raw = String(name ?? '').trim();
  const key = itemNameKey(raw);
  if (!key) return null;
  const table = loadItems(file);
  if (!table?.items) return null;
  const wantBag = bagOf(key), wantJoined = joined(key);
  const exact = [], same = [];
  for (const item of Object.values(table.items)) {
    const cand = itemNameKey(item.name);
    if (!cand || cand === key) continue;
    if (bagOf(cand) === wantBag) exact.push(item.name);
    else if (joined(cand) === wantJoined) same.push(item.name);
  }
  // AMBIGUITY IS A REFUSAL. Two items with the same words is not a repair, it is a choice.
  if (exact.length === 1) return { to: exact[0], confidence: 'exact', why: 'the same words' };
  if (!exact.length && same.length === 1)
    return { to: same[0], confidence: 'joined', why: 'identical without spacing or punctuation' };
  return null;
}

/** Check a name without throwing — for a sweep over config that should report, not die. */
export function checkItemName(name, { file = ITEMS_FILE } = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) return { name: raw, ok: false, why: 'empty item name', suggestions: [] };
  try {
    const canonical = resolveItemName(raw, file);
    return { name: raw, ok: true, canonical,
             // A name that RESOLVES but is not spelled the canonical way is not an error and
             // must not be reported as one — `herbs` is a correct way to say `herb`. It is
             // still worth surfacing, because two spellings of one item in one directory is
             // how a reader concludes there are two items.
             renamed: canonical.toLowerCase() !== raw.toLowerCase() ? canonical : null,
             suggestions: [] };
  } catch (e) {
    return { name: raw, ok: false, why: e.message, suggestions: suggestItemName(raw, { file }) };
  }
}

export function resolveItemName(name, file = ITEMS_FILE) {
  const raw = String(name ?? '').trim();
  const key = itemNameKey(raw);
  if (!key) throw new Error('item name must not be empty');
  const table = loadItems(file);
  if (!table?.items) throw new Error(`local item datastore is unavailable (${file})`);
  const matches = Object.values(table.items).filter(item => itemNameKey(item.name) === key);
  if (matches.length === 1) return matches[0].name;
  if (!matches.length) {
    const near = suggestItemName(raw, { file });
    throw new Error(`item "${raw}" does not resolve to an item in the local datastore; ` +
                    'choose one complete item name, without abbreviating it' +
                    (near.length ? ` — did you mean ${near.map(n => `"${n}"`).join(', ')}?` : ''));
  }
  throw new Error(`item "${raw}" is ambiguous: ${matches.map(item => item.name).join(', ')}`);
}

export function resolveItemNames(names = [], file = ITEMS_FILE) {
  if (!Array.isArray(names)) throw new Error('items must be a list of item names');
  const resolved = names.map(name => resolveItemName(name, file));
  return [...new Map(resolved.map(name => [name.toLowerCase(), name])).values()];
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
    // A COUNT OF ZERO IS ONE ITEM, NOT NOTHING. Non-stack objects come off the wire with
    // `amount: 0` — the tag nibble carries a quantity only for stackables — and `?? 1`
    // falls back on null and undefined but NOT on 0, so every sword, shield and suit of
    // armour in a pack weighed exactly nothing. Floyd read 623 of 2700 while genuinely
    // carrying 2633, and `exact` said so with confidence because the names were all in
    // the table. Three characters were refused a reagent handover by the server's own
    // CanHoldWeightAndBulk (user.kod:5470) while this reported their packs 23% full.
    const n = it.amount > 0 ? it.amount : 1;
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

// A PLURAL ON THE WIRE IS NOT A DIFFERENT FOOD, AND THIS USED TO THINK IT WAS.
//
// This was a raw lowercase index into the table, so it hit "spider eye" and missed
// "spider eyes" — while `itemNameKey`, twelve lines up in this same file, exists precisely
// to fold that and is documented as identity-not-spelling. Every other name-keyed lookup
// for human settings goes through it; this one did not.
//
// WHAT IT COST, measured on prod 2026-09-05. `larderOf` (m59-skills.mjs) resolves names with
// this function, `has_food` on the fleet row is `larderOf(c).length > 0`, and an empty larder
// collapses the fighting floor to the resting cap — `reachableFightFloor(140, 200, 0) === 80`.
// So a character carrying nothing but spider eyes or water skins was read as having NO food,
// pinned at 80 vigor, and never told to eat the eighty-six meals in its pack. Four characters
// were in that state at once; floors set to 140 on three of them reverted to exactly 80 within
// sixty seconds and stayed there for the twenty minutes sampled. The almoner then kept dealing
// them more of the same and reporting every delivery a success.
//
// BOTH SIDES HAVE TO BE NORMALISED, WHICH IS WHY THIS IS NOT A ONE-LINE SWAP. Two of the
// table's own keys are not already canonical — "inky-cap mushroom" folds to "inky cap
// mushroom" and "bunch of grapes" to "bunch of grape" — so normalising only the ARGUMENT
// fixes spider eyes and breaks inky-caps, which are the most nutritious food the fleet
// carries. The index below folds the keys too; there are no collisions among the 22 foods.
//
// Exact-match first, so a table key stays authoritative and this can only ever ADD hits.
// `itemWord` handles regular plurals and a short irregular list, not every English plural:
// "loaves of bread" still misses (it folds to "loave"). That is the same limit every other
// caller of itemNameKey lives with, and "loaf of bread" — what the wire actually sends — works.
let foodIndexCache = null;      // reset with the table; see loadItems' `cached`
function foodIndex(t) {
  if (foodIndexCache?.for === t) return foodIndexCache.byKey;
  const byKey = new Map();
  for (const [name, value] of Object.entries(t.food)) {
    const key = itemNameKey(name);
    if (key && !byKey.has(key)) byKey.set(key, value);
  }
  foodIndexCache = { for: t, byKey };
  return byKey;
}

// What eating this is worth: {nutrition, filling}, where nutrition IS the vigor gained.
// Null for anything that is not food. Rank a shop's stock on `nutrition` — the fleet's
// constraint is the stomach and the walk to the shop, not the shillings.
/**
 * Every food this game has, by name.
 *
 * For building a keep list that cannot drift: a caller that types its own list is answering
 * a question the table already answers, and four separate hand-written lists in this
 * repository have each been wrong about a different item. The names come back exactly as the
 * table holds them, so a substring match against them is safe — `edible mushroom` and
 * `inky-cap mushroom` are here and the three reagent mushrooms are not.
 */
export function allFoodNames(file = ITEMS_FILE) {
  const t = loadItems(file);
  return Object.keys(t?.food ?? {}).sort();
}

// EVERY WAND AND SCROLL, for a keep list that means the FAMILY and not the one item whose
// name happens to be the family's word. See the derivation in buildItemTable: recognised by
// class chain or by name, because a "wand" sits on three different branches of the tree, and
// then filtered to the ones whose go-bad timer will never fire -- everything else is still
// running its clock inside the vault.
//
// Returned as DISPLAY names because that is what the protocol hands us and what the keep
// predicate compares. An empty answer means the table has not been rebuilt since this
// section was added, and a caller spreading it into a list will simply get the list it
// had before -- silence means the behaviour that was already there.
export function allWandAndScrollNames(file = ITEMS_FILE) {
  const t = loadItems(file);
  return Object.values(t?.keeps ?? {}).map(k => k.name).sort();
}

// How long until this item's CLASS says it rots, in ms. 0 means never. NULL MEANS THE TABLE
// DOES NOT KNOW, which is not the same answer and must not be read as "safe to store" -- an
// unknown item is one the extractor never saw, and guessing "never" about it is how a
// decaying item ends up in a vault it will die in.
//
// Currently 0 for every named item, for the reason argued in buildItemTable: a named item is
// a labelled one and a labelled one never starts its timer. So this answers a question about
// the CLASS and not about the object in the pack -- the enchantment decay that actually
// empties vaults is per-instance and invisible from here.
export function spoilsInMs(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t?.items) return null;
  const key = itemNameKey(name);
  if (!key) return null;
  for (const entry of Object.values(t.items))
    if (itemNameKey(entry.name) === key)
      return typeof entry.spoils_ms === 'number' ? entry.spoils_ms : 0;
  return null;
}

export function foodValue(name, file = ITEMS_FILE) {
  const t = loadItems(file);
  if (!t?.food) return null;
  const exact = t.food[String(name || '').trim().toLowerCase()];
  if (exact) return exact;
  const key = itemNameKey(name);
  return key ? (foodIndex(t).get(key) || null) : null;
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

// ---------------------------------------------------------------- rarity grades
//
// WHAT THE SERVER SAYS ABOUT AN ITEM BEFORE ANYBODY LOOKS AT IT.
//
// Every object on the wire carries a rarity grade (`extractObject`, m59-parse.mjs:245) and
// both item serializers used to drop it. It is the ONLY reliable answer to "is this worth an
// identify spell", and without it the question can only be asked by casting — which costs 3
// orc teeth a go and tells you nothing when the answer is no.
//
// GetRarity (item.kod:714-756) checks identification FIRST and short-circuits:
//
//   if NOT IsIdentified -> ITEM_RARITY_GRADE_UNIDENTIFIED   (100)
//   if IsCursed         -> ITEM_RARITY_GRADE_CURSED         (200)
//   then 1/2/4 by how many attributes it has, else the class's own viRarity
//
// So 100 does NOT mean "rare". It means the server is declining to say, because at least one
// attribute is still hidden — which is exactly the set `reveal` can act on.
// `RevealHiddenAttributes` returns TRUE only when something WAS hidden (item.kod:1331-1347),
// and that return is what gates advancement in reveal.kod, so a cast at anything not graded
// 100 spends the reagents and cannot even teach the caster anything.
//
// An item with NO attributes at all is `IsIdentified` TRUE (the loop is skipped), so plain
// gear correctly reads 0 rather than 100.
export const ITEM_RARITY = Object.freeze({
  NORMAL: 0, UNCOMMON: 1, RARE: 2, LEGENDARY: 4, UNIDENTIFIED: 100, CURSED: 200,
});

export const rarityName = (r) => {
  switch (Number(r)) {
    case ITEM_RARITY.NORMAL: return 'normal';
    case ITEM_RARITY.UNCOMMON: return 'uncommon';
    case ITEM_RARITY.RARE: return 'rare';
    case ITEM_RARITY.LEGENDARY: return 'legendary';
    case ITEM_RARITY.UNIDENTIFIED: return 'unidentified';
    case ITEM_RARITY.CURSED: return 'cursed';
    default: return null;
  }
};

// IS THERE ANYTHING HERE FOR `reveal` TO DO? Strictly the 100 grade and nothing else.
//
// Cursed (200) is deliberately NOT included even though a cursed item plainly has an
// attribute: GetRarity tests IsIdentified before IsCursed, so anything still reading 200 has
// already had its attributes revealed and there is nothing left to uncover. Treating it as
// work would burn teeth on every cursed weapon in the fleet, for ever.
export const isUnidentified = (o) => Number(o?.rarity) === ITEM_RARITY.UNIDENTIFIED;

// AND THE SAME GRADE ANSWERS "CAN THIS EVER BE PUT DOWN". `ITEM_RARITY_GRADE_CURSED` (200)
// is what the stock client colours red (color.c:583, dialog.c:701), so cursed is not an
// inference here — it is the server's own word, on the same field `reveal` already reads.
//
// Worth its own export because the consequence is unique in this game: a cursed weapon
// CANNOT be unwielded. It is the one irreversible mistake, so "is the thing in this
// character's hand cursed" is a question that has to be answerable, and until the
// equipment snapshot carried `rarity` it was not. Rizzo stalled 56 passes on one and three
// separate checks I wrote could not see it — they tested a refusals list that a keeper
// restart clears, then an equipment reply with no such field in it.
export const isCursed = (o) => Number(o?.rarity) === ITEM_RARITY.CURSED;

// FOOD ABOVE A RESERVE, which is the only part of a larder that may be dropped.
//
// Pure, and separated from the keeper's `makeRoom` for the usual reason: the decision is
// arithmetic about a pack and a fraction, and it was unpinnable while it lived on a class
// that needs a live session to construct.
//
// WHY FOOD IS DROPPABLE AT ALL. It used to be exempt outright — "the shelter's fuel and
// redistribution stock; a low vendor value must never make them look like disposable loot",
// which is true of a larder and false of a hoard. The Duke's tables produce hoards: measured
// on prod 2026-09-12, 2,700 slices of pork across 23 characters, every pack at 100%, eight of
// them between 220 and 294 slices. And the exemption was not free, because `makeRoom` still
// has to make room: with the food untouchable it worked down the ranking and shed the
// REAGENTS — 37 sapphires and 15 orc teeth off one character in 75 minutes, `mushroom` and
// `orc tooth` not being in its value regex. The fleet was dropping what it cannot replace to
// protect the one thing it gets for nothing.
//
// A FRACTION OF CAPACITY, NEVER OF WHAT IS CARRIED. A fraction of the holding ratchets —
// collect 300 and keep 60, collect 600 and keep 120 — which rewards exactly the
// over-collection this exists to stop. Of capacity it is a fixed, useful larder: 20% of a
// 2000 pack is 400, about 44 slices at weight 9, which is some 400 vigor.
//
// Returns null when nothing can be said honestly. "There is surplus" is a claim that deletes
// items, so no capacity, an inexact load, or an unweighable stack all answer null rather than
// a guess. An unweighable food counts toward NEITHER the reserve nor the surplus: its load is
// unknown in both directions.
export function foodSurplusOf({ items = [], capacity = null, fraction = 0.2 } = {}) {
  const max = Number(capacity);
  if (!Number.isFinite(max) || max <= 0) return null;
  const frac = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0.2;
  const reserve = max * frac;

  // WEIGHT AND BULK ARE SEPARATE CEILINGS AND ARE NOT INTERCHANGEABLE. An earlier draft
  // summed max(weight, bulk) per item and compared that to capacity, which is an upper bound
  // on both and therefore a load that can exceed the pack it is measured against — 294 slices
  // read as 2,646 of a 2,000 pack. It errs toward dropping more, so it would have quietly
  // under-delivered the reserve it exists to hold. Track both and let the reserve bind in
  // whichever dimension is tighter.
  const stacks = [];
  let weight = 0, bulk = 0;
  for (const it of items) {
    const name = String(it?.name ?? '');
    if (!name || !isFood(name)) continue;
    const unit = weighItem(name);
    if (!unit) continue;
    const w = Number(unit.weight) || 0, b = Number(unit.bulk) || 0;
    if (!(w > 0) && !(b > 0)) continue;
    const amount = Math.max(1, Number(it.amount) || 1);
    weight += w * amount;
    bulk += b * amount;
    stacks.push({ id: it.id ?? null, name, w, b, amount });
  }
  if (!stacks.length) return null;

  // Over the reserve in EITHER dimension is over the reserve.
  const overW = weight - reserve, overB = bulk - reserve;
  if (overW <= 0 && overB <= 0) return null;

  // The heaviest stack first: the point of a drop is relief. Only as much of it as the
  // surplus covers, so a stack far bigger than the excess does not take the reserve with it —
  // and the SMALLER of the two dimensions' allowances, so shedding for weight cannot breach
  // the bulk reserve or the other way about.
  stacks.sort((a, b2) => Math.max(b2.w, b2.b) * b2.amount - Math.max(a.w, a.b) * a.amount);
  const head = stacks[0];
  const allow = (over, per) => (per > 0 && over > 0 ? Math.floor(over / per) : Infinity);
  const units = Math.max(1, Math.min(head.amount,
                                     allow(overW, head.w), allow(overB, head.b)));
  return { id: head.id, name: head.name, units, held: head.amount,
           surplus: Math.round(Math.max(overW, overB)), reserve: Math.round(reserve),
           food_weight: Math.round(weight), food_bulk: Math.round(bulk), fraction: frac };
}


// ---------------------------------------------------------------- what the fleet does not sell
//
// THE FLEET'S DEFAULT KEEP LIST, IN THE ONE MODULE BOTH SIDES OF THE SALE CAN REACH.
//
// This lived in m59-fleetscript.mjs as VAULT_KEEP, where only a fleetscript `sell` step could
// see it — so it governed an errand somebody wrote and had NO BEARING on a keeper deciding to
// sell on its own. Two sale paths, one list, and the list was on the wrong side of the fence.
//
// It sits here because this module already owns `allWandAndScrollNames` (which the list is
// partly built from) and is imported by both m59-skills.mjs, where `sellAll` lives, and
// m59-fleetscript.mjs, which re-exports it under its old name. One definition, no cycle.
//
// TWO KINDS OF ENTRY, and the distinction is the same one allWandAndScrollNames exists for:
//
//   JUDGEMENT -- typed, one name per line. Whether a thing is worth more kept than sold is not
//   a fact the class tree carries.
//
//   FAMILY -- derived. A hand-written list of wands is wrong within a patch.
//
// Matching downstream is by SUBSTRING, so an entry must be specific enough not to catch its
// neighbours. 'orc tooth' is safe; a bare 'orc' would not be, and it is worth saying because
// checking this list with /orc/ matched "scroll of fORCes of light" and reported a protection
// that was not there.
export const FLEET_KEEP = Object.freeze([
  'herb', 'elderberry', 'Inky-cap mushroom', 'flask',
  'rose', 'ring of invisibility', 'mystic sword', 'true lute',
  'blue dragon scale', 'dark angel feather', 'shrunken head',
  'emerald', 'sapphire', 'diamond', 'ruby',
  // THE REAGENT THE FLEET'S OWN SPELLS BURN. `reveal` costs 3 and `identify` 1
  // (reveal.kod:55, identify.kod:51), they are 650 each at the only counter that sells them,
  // and nothing this fleet fights drops one. On 2026-09-12 a caster was bought 40 and his
  // keeper sold 30 on its next town trip -- correctly, because nothing protected them.
  'orc tooth',
  ...allWandAndScrollNames(),
]);
