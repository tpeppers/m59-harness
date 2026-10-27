// WHAT A MERCHANT WILL ACTUALLY BUY, BEFORE YOU OFFER IT.
//
//   node tools/m59-buyers.mjs                       the whole table
//   node tools/m59-buyers.mjs Quintor               what that merchant deals in
//   node tools/m59-buyers.mjs Quintor "long sword" sapphire
//   node tools/m59-buyers.mjs --who-buys sapphire   which merchants take it
//   node tools/m59-buyers.mjs --json
//
// A MERCHANT REFUSAL IS A SENTENCE SPOKEN TO THE ROOM, NEVER AN ERROR ON THE WIRE, so
// offering a smith a mushroom is not a failed call — it is a successful call that returns
// `no counteroffer came back` after a full offer/cancel round trip and 900ms of pacing.
// `sell_all` did exactly that: it offered whatever the loadout marked sellable to whoever
// was standing there, so a town trip to Quintor's Smithy in Jasper offered him sapphires,
// mushrooms and water skins, collected three silences, and buried the one line that
// mattered under them. The fleet paid for the round trips and learned nothing.
//
// THE RULE IS `ObjectDesired`, AND IT IS PER MERCHANT CLASS. `Monster.ObjectDesired`
// (monster.kod:4707) returns TRUE — its own docstring says "This is set in individual
// buyers. It allows them to pick and choose what they want to buy." Fifteen classes in
// the tree override it, and each one is a couple of lines of category tests. That is the
// whole vocabulary, and it is small enough to write down exactly.
//
// WHY THIS IS NOT `buys_anything`. The merchant index already carries that flag and it is
// computed as "did this class override ObjectDesired" — accurate, and not the question a
// seller has. It is TRUE for the bankers, who take what you hand them and give nothing
// back. It is FALSE for every merchant that will genuinely buy something, which is all of
// them worth walking to. Read alone it inverts the answer.
//
// AND THE CATEGORIES ARE NOT THE ITEM KINDS. `IsObjectSundry` is torch, flask, mug and
// food; `IsObjectGem` includes Ring, which is why a signet ring is refused by an
// apothecary that buys every other reagent. Nothing in the item index groups them this
// way, because these groupings exist only in the buying code.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- the categories
//
// Straight out of `Monster`, one entry per `IsObject*` predicate. `classes` are tested
// with IsClass, so they match descendants too — `Armor` covers leather, chain, scale and
// plate, and `Weapon` covers every sword, axe, mace and hammer in the tree.
export const CATEGORIES = {
  weapon: {
    classes: ['Weapon'],
    cite: 'monster.kod:4142 IsObjectWeapon',
  },
  wearable: {
    classes: ['Armor', 'Helmet', 'Gauntlet', 'Necklace', 'Shield', 'Pants'],
    cite: 'monster.kod:4183 IsObjectWearable',
  },
  sundry: {
    classes: ['Torch', 'Flask', 'Mug', 'Food'],
    cite: 'monster.kod:4152 IsObjectSundry',
  },
  misc: {
    classes: ['Chalice', 'Scepter', 'SpecialWand', 'SpellItem', 'Book',
              'Arsenic', 'SpiderEgg', 'SpiderEggShell', 'Key'],
    cite: 'monster.kod:4165 IsObjectMisc',
  },
  // A GEM IS A REAGENT TOO, and three of the four apothecaries exclude it by name. Order
  // matters nowhere else in this file; here it is the whole rule.
  gem: {
    classes: ['JewelofFroz', 'Emerald', 'Ruby', 'Sapphire', 'Diamond', 'Ring'],
    cite: 'monster.kod:4198 IsObjectGem',
  },
  // The one category that is not a class list. `IsObjectReagent` asks the ITEM
  // (`IsItemType(ITEMTYPE_REAGENT)`), so it is read off the item index rather than
  // derived from where the class sits in the tree.
  reagent: {
    itemKind: 'reagent',
    cite: 'monster.kod:4213 IsObjectReagent -> IsItemType(ITEMTYPE_REAGENT)',
  },
};

// ---------------------------------------------------------------- the buyers
//
// `any` — buys anything in these categories.  `not` — except these.
// `alsoClasses` — plus these named classes outright.  `notClasses` — minus these.
// `onlyClasses` — nothing but these.  `all` — the base TRUE, buys any category.
//
// `maxNumber` is a stack ceiling on NumberItem offers, not a category rule: two merchants
// refuse a stack larger than that and say nothing about it.
export const BUY_RULES = {
  // --- blacksmiths. Weapons, armour and shields; three of the six also take `misc`.
  JasperBlacksmith: { any: ['weapon', 'wearable'],
    notClasses: ['NeruditeSword', 'NeruditeArmor', 'NeruditeBow'],
    note: 'refuses island nerudite gear out loud', cite: 'jssmith.kod:93' },
  TosBlacksmith: { any: ['wearable', 'misc', 'weapon'], cite: 'TsSmith.kod:63' },
  BarloqueBlacksmith: { any: ['wearable', 'misc', 'weapon'], cite: 'bqSmith.kod:48' },
  // Weapons and SHIELDS ONLY — no body armour, which the other five take. Its own comment
  // says "Allow him to buy the weapons and shields from the nearby crypt."
  MarionBlacksmith: { any: ['weapon'], alsoClasses: ['Shield'], cite: 'MrSmith.kod:80' },
  HazarBlacksmith: { any: ['wearable', 'weapon'], cite: 'hzsmith.kod:49' },
  KocatanBlacksmith: { any: ['wearable', 'weapon'], cite: 'kcsmith.kod:73' },

  // --- apothecaries. Reagents, and three of the four refuse gems.
  TosApothecary: { any: ['reagent'], not: ['gem'], cite: 'TsApoth.kod:66' },
  BarloqueApothecary: { any: ['reagent'], not: ['gem'], cite: 'bqapoth.kod:128' },
  KocatanApothecary: { any: ['reagent'], not: ['gem'], cite: 'kcapoth.kod:49' },
  // The exception, and it is the useful one: the only apothecary that takes gems.
  HazarApothecary: { any: ['reagent', 'gem'], cite: 'hzapoth.kod:55' },

  // --- grocers, merchants, tailors.
  CornothGrocer: { any: ['reagent', 'sundry'],
    alsoClasses: ['NeruditeOreChunk', 'OrcPitBossHead'], cite: 'cngrocer.kod:84' },
  JasperMerchant: { any: ['reagent'], cite: 'jsmerch.kod:85' },
  BarloqueMerchant: { any: ['gem', 'sundry'], maxNumber: 25, cite: 'bqmerch.kod:113' },
  KocatanTailor: { any: ['gem', 'sundry'], maxNumber: 100, cite: 'kctailor.kod:250' },
  MarionInnkeeper: { any: ['sundry', 'reagent', 'wearable'], cite: 'mrinnk.kod:113' },
  // Short swords. Nothing else, from anybody.
  KocatanBartender: { onlyClasses: ['ShortSword'], cite: 'kcbart.kod:42' },
  KocatanMerchant: { all: true, cite: 'kcmerch.kod:52 returns TRUE' },

  // --- the two with a real inventory. They buy any category and run out of SHELF SPACE
  // instead — see the MAX_FORSALE note in CLAUDE.md. Category is never their reason.
  Izzio: { all: true, finiteStock: true, notClasses: ['Money'], cite: 'izzio.kod:245' },
  KocatanShopkeeper: { all: true, finiteStock: true, notClasses: ['Money'],
    cite: 'kcshopk.kod:209' },
};

// Names we have actually traded with, mapped to the class whose rule they run. The
// merchant index resolves a live id to a class; this is the fallback for a name with no
// index entry, and for the allowlist in `SELL_TO` which is written in names.
//
// TWO PEOPLE CAN SHARE A NAME and the index says so — the Barloque and Tos blacksmiths
// are both "Fehr'loi Qan". Both are blacksmiths, so the rule is the same either way; a
// name that maps to classes with DIFFERENT rules is reported as ambiguous rather than
// resolved to whichever came first.
export const KNOWN_BUYERS = {
  quintor: 'JasperBlacksmith',       // Quintor's Smithy, Jasper
  joguer: 'BarloqueApothecary',      // Joguer's Herbs and Roots, Barloque
  herbutte: 'BarloqueMerchant',      // Sparkling Stone Shop, Barloque — gems
  solomon: 'CornothGrocer',          // Cor Noth
  izzio: 'Izzio',
  roq: null,                         // the assassin. Not in the merchant index at all.
  rook: null,                        // CorNothSergeant — declares no ObjectDesired
  // KO'CATAN (towns/kocatwn/), on SELL_TO since 2026-10-27. Named here so an island sale resolves its counter without
  // the merchant index. Keyed short of the apostrophe, which the wire may curl.
  'ixla cha': 'KocatanBlacksmith',   // Ixla cha'Totlak, smithy 2003 (kcsmith.kod:73)
  'pacal ix': 'KocatanShopkeeper',   // Pacal ix'Anoak, store 2004 (kcshopk.kod:209)
  'tepal ix': 'KocatanTailor',       // Tepal ix'Zonak, tailor 2006 (kctailor.kod:250)
  'zala ix': 'KocatanApothecary',    // Zala ix'Mecya, apothecary 2002 (kcapoth.kod:49)
};

// ---------------------------------------------------------------- the item index
//
// `compendium/data/planner.json` is the built item table: name, class, kind, and the kod
// FILE the class was declared in. That path is the class hierarchy — this tree is laid
// out one directory per ancestor — so `weapon/longswrd.kod` is an IsClass(&Weapon) answer
// and `defmod/shield/knhtshld.kod` is an IsClass(&Shield) one, with no separate index of
// ancestry to build or keep in step.
let ITEMS = null;
export function loadItems(file = join(HERE, '..', 'compendium', 'data', 'planner.json')) {
  if (ITEMS) return ITEMS;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    ITEMS = new Map((d.items || []).map(i => [String(i.name).toLowerCase(), i]));
  } catch { ITEMS = new Map(); }
  return ITEMS;
}
// For tests, and for a caller that has its own table.
export function setItems(rows) {
  ITEMS = new Map((rows || []).map(i => [String(i.name).toLowerCase(), i]));
  return ITEMS;
}

// Every class an item IS, cheapest source first: its own class, then each directory on
// the way down to it. Lower-cased, because class names in this tree are case-insensitive
// — the third kind of name here that is, and the one that already cost a session when
// `CornothGrocer`/`CorNothTown` were two keys in one Map.
export function ancestryOf(item) {
  if (!item) return new Set();
  const out = new Set();
  if (item.cls) out.add(String(item.cls).toLowerCase());
  for (const part of String(item.file || '').split('/')) {
    const p = part.replace(/\.kod$/, '').toLowerCase();
    if (p && p !== 'kod' && p !== 'object') out.add(p);
  }
  return out;
}

const isA = (anc, cls) => anc.has(String(cls).toLowerCase());

// WHICH CATEGORIES AN ITEM FALLS IN — all of them, because the rules test several and an
// item is routinely two (a sapphire is a reagent AND a gem, which is the whole reason the
// apothecaries name the exclusion).
export function categoriesOf(name) {
  const item = loadItems().get(String(name || '').toLowerCase()) || null;
  const anc = ancestryOf(item);
  const out = new Set();
  for (const [cat, def] of Object.entries(CATEGORIES)) {
    if (def.classes?.some(c => isA(anc, c))) out.add(cat);
    if (def.itemKind && item?.kind === def.itemKind) out.add(cat);
  }
  return { categories: out, item, known: !!item };
}

// ---------------------------------------------------------------- the question
//
// WILL THIS MERCHANT BUY THIS ITEM. Answers `null` for "cannot say", never false — an
// unknown merchant class or an item missing from the index is not evidence of a refusal,
// and treating it as one would silently stop the fleet selling anything the index has not
// caught up with. Every caller reads null as "offer it and find out", which is exactly
// what the code did before this module existed.
export function willBuy(merchantClass, itemName) {
  const rule = BUY_RULES[merchantClass];
  if (!rule) return { buys: null, why: `no buying rule known for ${merchantClass || 'this merchant'}` };

  const { categories: cats, item, known } = categoriesOf(itemName);
  const anc = ancestryOf(item);

  if (rule.notClasses?.some(c => isA(anc, c)))
    return { buys: false, why: `${merchantClass} refuses ${itemName} by class`, cite: rule.cite };
  if (rule.onlyClasses)
    return rule.onlyClasses.some(c => isA(anc, c))
      ? { buys: true, why: `${merchantClass} buys ${rule.onlyClasses.join('/')} only`, cite: rule.cite }
      : { buys: false, why: `${merchantClass} buys nothing but ${rule.onlyClasses.join('/')}`, cite: rule.cite };
  if (rule.alsoClasses?.some(c => isA(anc, c)))
    return { buys: true, why: `${merchantClass} takes ${itemName} by class`, cite: rule.cite };
  if (rule.all)
    return { buys: true, why: `${merchantClass} buys any category`, cite: rule.cite,
             ...(rule.finiteStock ? { caveat: 'holds a real inventory — can refuse for shelf space' } : {}) };

  // An item the index does not know cannot be categorised, and "no categories" would read
  // as a refusal from every merchant. Say so instead.
  if (!known) return { buys: null, why: `${itemName} is not in the item index`, cite: rule.cite };

  if (rule.not?.some(c => cats.has(c)))
    return { buys: false, cite: rule.cite,
             why: `${merchantClass} buys ${rule.any.join('/')} but not ${rule.not.join('/')}` };
  if (rule.any?.some(c => cats.has(c)))
    return { buys: true, why: `${merchantClass} buys ${rule.any.join('/')}`, cite: rule.cite };

  return { buys: false, cite: rule.cite,
           why: `${merchantClass} deals in ${rule.any.join(', ')} — ${itemName} is ` +
                (cats.size ? [...cats].join('/') : 'none of those') };
}

// A NAME IS NOT A CLASS, and resolving one is where this gets it wrong if anywhere. In
// order: an explicit class, the live merchant index by object id, the index by name, then
// the hand-written table. Object ids are renumbered on every server save, so the id is
// tried first but never trusted alone — a stale id in the index is why the name and the
// table are behind it rather than in front.
export function classOf({ cls = null, id = null, name = null, index = null } = {}) {
  if (cls && BUY_RULES[cls]) return { cls, how: 'given' };
  const rows = index?.merchants || index || [];
  if (id != null) {
    const hit = rows.find(m => m.id === id);
    if (hit?.cls && BUY_RULES[hit.cls]) return { cls: hit.cls, how: 'merchant index, by object id' };
  }
  if (name) {
    const n = String(name).toLowerCase();
    const byName = rows.filter(m => String(m.name || '').toLowerCase() === n && BUY_RULES[m.cls]);
    const distinct = [...new Set(byName.map(m => m.cls))];
    // Two classes with the same rule are not an ambiguity worth refusing over; two with
    // different rules are, and guessing would be the failure this whole file is about.
    if (distinct.length === 1) return { cls: distinct[0], how: 'merchant index, by name' };
    if (distinct.length > 1) {
      // Compare what the rule DOES, not where it is written down: two blacksmiths in two
      // towns are two files and two citations, and folding them on the whole object would
      // call every such pair ambiguous and refuse to sell to either.
      const shape = (c) => JSON.stringify(['any', 'not', 'alsoClasses', 'notClasses', 'onlyClasses',
                                           'all', 'maxNumber'].map(k => BUY_RULES[c][k] ?? null));
      const same = distinct.every(c => shape(c) === shape(distinct[0]));
      if (same) return { cls: distinct[0], how: `merchant index, by name (${distinct.length} classes, same rule)` };
      return { cls: null, how: `ambiguous name — ${distinct.join(' or ')}`, ambiguous: distinct };
    }
    for (const [key, c] of Object.entries(KNOWN_BUYERS))
      if (n.includes(key)) return c ? { cls: c, how: 'known buyer table' }
                                    : { cls: null, how: `${key} has no ObjectDesired override — buys any category` };
  }
  return { cls: null, how: 'unresolved' };
}

// WHAT TO OFFER, AND WHAT NOT TO CARRY TO THE COUNTER AT ALL. The shape the seller wants:
// one pass, two lists, and every exclusion carries the reason and its citation so a bot
// can act on it rather than re-deriving it from a silence.
export function partition(items, merchant = {}) {
  const { cls, how, ambiguous } = classOf(merchant);
  const rule = cls ? BUY_RULES[cls] : null;
  const offer = [], notOffered = [];
  for (const it of items) {
    const name = it.name ?? it;
    const v = willBuy(cls, name);
    // null is "cannot say" and it means OFFER — see willBuy.
    if (v.buys === false) notOffered.push({ name, amount: it.amount ?? 1, why: v.why, cite: v.cite });
    else offer.push(it);
  }
  return {
    offer, not_offered: notOffered,
    merchant: {
      name: merchant.name ?? null, class: cls, resolved_by: how,
      ...(ambiguous ? { ambiguous } : {}),
      buys: rule ? (rule.all ? ['any category'] : [...(rule.any || []), ...(rule.onlyClasses || [])]) : null,
      ...(rule?.not ? { but_not: rule.not } : {}),
      ...(rule?.finiteStock ? { finite_stock: true } : {}),
      cite: rule?.cite ?? null,
    },
  };
}

// The other direction, which is the one worth asking BEFORE the walk: given something in
// the pack, who takes it. A bot that knows this routes one trip instead of three.
export function whoBuys(itemName) {
  const out = [];
  for (const cls of Object.keys(BUY_RULES)) {
    const v = willBuy(cls, itemName);
    if (v.buys === true) out.push({ class: cls, why: v.why, cite: v.cite });
  }
  return { item: itemName, categories: [...categoriesOf(itemName).categories], buyers: out };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const rest = argv.filter(a => a !== '--json');
  let index = null;
  try { index = JSON.parse(readFileSync(join(HERE, '..', 'substrate', 'm59-merchants.json'), 'utf8')); } catch {}

  if (rest[0] === '--who-buys') {
    const r = whoBuys(rest.slice(1).join(' '));
    if (jsonOut) console.log(JSON.stringify(r, null, 1));
    else {
      console.log(`${r.item} — categories: ${r.categories.join(', ') || 'none known'}`);
      for (const b of r.buyers) console.log(`  ${b.class.padEnd(20)} ${b.cite}`);
      if (!r.buyers.length) console.log('  nobody in the table buys it');
    }
  } else if (!rest.length) {
    const rows = Object.entries(BUY_RULES).map(([cls, r]) => ({
      class: cls, buys: r.all ? 'any category' : [...(r.any || []), ...(r.onlyClasses || [])].join(', '),
      but_not: (r.not || []).join(', '), cite: r.cite }));
    if (jsonOut) console.log(JSON.stringify(rows, null, 1));
    else {
      console.log('merchant class      buys                              not        source');
      for (const r of rows)
        console.log(r.class.padEnd(20), r.buys.padEnd(33), (r.but_not || '—').padEnd(10), r.cite);
    }
  } else {
    const [who, ...items] = rest;
    const { cls, how } = classOf({ name: who, index });
    if (!items.length) {
      const rule = cls ? BUY_RULES[cls] : null;
      const r = { merchant: who, class: cls, resolved_by: how,
                  buys: rule ? (rule.all ? ['any category'] : [...(rule.any || []), ...(rule.onlyClasses || [])]) : null,
                  but_not: rule?.not ?? null, cite: rule?.cite ?? null };
      console.log(jsonOut ? JSON.stringify(r, null, 1)
        : `${who} -> ${cls || 'unknown'} (${how})\n  buys: ${r.buys?.join(', ') || 'cannot say'}` +
          (r.but_not ? `\n  but not: ${r.but_not.join(', ')}` : '') + (r.cite ? `\n  ${r.cite}` : ''));
    } else {
      const p = partition(items.map(name => ({ name })), { name: who, index });
      if (jsonOut) console.log(JSON.stringify(p, null, 1));
      else {
        console.log(`${who} -> ${p.merchant.class || 'unknown'} (${p.merchant.resolved_by})`);
        for (const o of p.offer) console.log(`  OFFER      ${o.name}`);
        for (const n of p.not_offered) console.log(`  keep back  ${n.name} — ${n.why}`);
      }
    }
  }
}
