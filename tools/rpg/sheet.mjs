// A CHARACTER SHEET: "my buffs", "my debuffs", "my resistances", "am I cursed" -- answered the same way
// every time, from the server's own lists, with how old each answer is.
//
// Why this exists (operator, 2026-10-25): a fresh agent asked for "my current debuffs" reaches for whatever
// looks like it -- a stale status field, a journal line, a guess -- and the classic mistake is expecting a
// CURSE to be one. It is not, and the difference is why the fleet leaves free value on the table:
//
//   * A curse in Meridian 59 is a property of an ITEM WORN, not an enchantment on the wearer. Nothing
//     appears in the enchantment list. The server says so only when you try to take the item off --
//     "<item> seems to cling to your hand!" (wacursed.kod:35,97-104) -- or at the moment of pickup, when
//     a cursed item puts itself on: "As you pick the item up, you feel a will greater than your own
//     overwhelm your mind! ..." (item.kod:27-29,508-515). A cursed weapon's name reads "cursed <x>".
//   * `remove curse` (remcurse.kod; Shal'ille 2, 9 mana, one emerald) is cast ON THE PLAYER, because the
//     item cannot be unequipped to be targeted. It does not lift the curse from the item: it UNEQUIPS every
//     cursed item the target wears (player.kod RemoveCurseAllItems). Wear it again and it clings again --
//     which is how remove curse is trained to 99% with a single cursed item.
//
// So `sheet.curse` is its own answer with its own evidence, never a row in `debuffs`, and `state` says how
// much we actually know: 'cursed' (the server's word: a cursed grade, a cursed name, a cling we heard),
// 'suspected' (swaps keep being refused), 'none_known' (we have read what is worn and found nothing), or
// 'unknown' (nobody has read the body yet -- which is NOT 'none').
//
// Pure: it reads a client-shaped object and returns plain data. Nothing here asks the server anything.
import { readFileSync } from 'node:fs';
import { isCursed } from '../m59-items.mjs';

// THE RESISTANCE SOURCES, from the kod. A spell's strength is a range over spell power (0..99) because the
// caster's power is not on the wire; a ring's is fixed. ResistanceCheck takes the LARGEST same-type
// resistance (battler.kod:189-249), so two sources do not add up to more than the best of them... except
// that AddResistance does sum same-type entries (battler.kod:268-290). We report both, and conditions
// should use `resist.<element>`, the conservative figure: the strongest single source's minimum.
export const RESIST_SPELLS = Object.freeze({
  'withstand fire': { element: 'fire', min: 25, max: 74, cite: 'resfire.kod:73 power/2+25' },
  'resist shock': { element: 'shock', min: 25, max: 74, cite: 'resshock.kod:72 power/2+25' },
  'resist cold': { element: 'cold', min: 5, max: 54, cite: 'rescold.kod:72 power/2+5' },
  'resist acid': { element: 'acid', min: 15, max: 64, cite: 'resacid.kod:77 power/2+15' },
  'resist magic': { element: 'magic', min: 7, max: 40, cite: 'resmagic.kod:67 power/3+7 (ATCK_SPELL_ALL)' },
  'holy resolve': { element: 'unholy', min: 15, max: 64, cite: 'resevil.kod:73' },
  'unholy resolve': { element: 'holy', min: 15, max: 64, cite: 'resgood.kod:72' },
});
export const RESIST_ITEMS = Object.freeze({
  'ring of fire resistance': { element: 'fire', min: 50, max: 50, cite: 'firering.kod:44' },
  'ring of shock resistance': { element: 'shock', min: 50, max: 50, cite: 'shokring.kod:44' },
  'ring of cold resistance': { element: 'cold', min: 50, max: 50, cite: 'coldring.kod:44' },
  'ring of acid resistance': { element: 'acid', min: 50, max: 50, cite: 'acidring.kod:44' },
});
// Resist magic is ATCK_SPELL_ALL: it counts against every spell element.
const SPELL_ELEMENTS = ['fire', 'shock', 'cold', 'acid', 'holy', 'unholy'];

// WHAT IS A BUFF AND WHAT IS A DEBUFF is the spell catalogue's word, extracted from the kod
// (substrate/m59-spells.json, `harmful` from each spell's viHarmful), never a hand list: an enchantment
// is named for the spell that made it. The sicknesses a monster gives are not spells and are the one list
// kept here, the same five names `M59Client.ailments()` matches. A name in neither is `unknown_effects`.
export const AILMENTS = Object.freeze(['poison', 'disease', 'sickness', 'plague', 'venom']);
let catalogue = null;
export function effectKind(name) {
  const n = lower(name);
  if (AILMENTS.includes(n)) return 'debuff';
  if (!catalogue) {
    catalogue = new Map();
    try {
      const j = JSON.parse(readFileSync(new URL('../../substrate/m59-spells.json', import.meta.url), 'utf8'));
      for (const sp of Array.isArray(j) ? j : j.spells ?? Object.values(j)) if (sp?.name) catalogue.set(lower(sp.name), sp);
    } catch { /* no catalogue: every name is unknown, which is the honest answer */ }
  }
  const sp = catalogue.get(n);
  return !sp ? 'unknown' : sp.harmful ? 'debuff' : 'buff';
}

export const CURSED_NAMES = Object.freeze(['ring of lethargy', 'amulet of shadows']);
export const CLING_TEXT = /seems to cling to your hand/i;
export const CURSE_PICKUP_TEXT = /a will greater than your own overwhelm/i;
export const REMOVE_CURSE = Object.freeze({ spell: 'remove curse', school: "shal'ille", level: 2, mana: 9,
  reagents: [['emerald', 1]], karma_min: 20, target: 'player',
  effect: 'unequips every cursed item the target wears; the item stays cursed and clings again if re-worn',
  cite: 'remcurse.kod:40-104, player.kod:10076-10091' });

const lower = s => String(s ?? '').trim().toLowerCase();
const nameOf = (c, o) => lower(o?.name ?? c?.rsc?.get?.(o?.nameRsc));

/**
 * The sheet. `c` is a client or a keeper proxy; `extra` carries what only the keeper knows:
 *   curseSuspect  the keeper's own `_curseSuspect` ({ name, certain, said, since })
 *   heard         recent server lines [{ text, at }] (a cling, a pickup curse)
 */
export function sheetOf(c, { now = Date.now(), curseSuspect = null, heard = [] } = {}) {
  const v = safe(() => c.vitals?.()) ?? {};
  const health = v.health ?? null, mana = v.mana ?? null;
  const enchantments = safe(() => c.enchantments?.()) ?? null;
  const enchStatus = safe(() => c.enchantmentStatus?.()) ?? null;
  const mine = (enchantments ?? []).filter(e => e.type == null || e.type === 1);
  const buffs = [], debuffs = [], unknown = [];
  for (const e of mine) {
    const n = lower(e.name);
    const row = { name: n || `effect ${e.id}`, id: e.id ?? null, seen_at: e.at ?? null, age_ms: e.at ? now - e.at : null };
    const kind = RESIST_SPELLS[n] ? 'buff' : effectKind(n);
    (kind === 'debuff' ? debuffs : kind === 'buff' ? buffs : unknown).push(row);
  }
  const room = (enchantments ?? []).filter(e => e.type === 2).map(e => lower(e.name));

  const eq = safe(() => c.equipment?.()) ?? null;
  const inv = Array.isArray(c?.inventory) ? c.inventory : [];
  const byId = new Map(inv.map(o => [o.id, o]));
  const wearing = (eq?.equipped ?? []).map(e => ({ id: e.id, name: lower(e.name ?? nameOf(c, byId.get(e.id))),
    rarity: byId.get(e.id)?.rarity ?? e.rarity ?? null }));
  const carrying = inv.map(o => nameOf(c, o)).filter(Boolean);

  // RESISTANCES: enchantments we hold plus rings we wear (a ring in the pack resists nothing).
  const resist = {}, resistSources = {};
  const add = (element, src, how) => {
    (resistSources[element] ??= []).push({ source: src, how, min: how.min, max: how.max });
    resist[element] = Math.max(resist[element] ?? 0, how.min);
  };
  for (const b of buffs) {
    const r = RESIST_SPELLS[b.name]; if (!r) continue;
    if (r.element === 'magic') for (const el of SPELL_ELEMENTS) add(el, b.name, r); else add(r.element, b.name, r);
  }
  for (const w of wearing) { const r = RESIST_ITEMS[w.name]; if (r) add(r.element, w.name, r); }

  // THE CURSE, from the server's own evidence only.
  const evidence = [];
  for (const w of wearing) {
    if (isCursed(w)) evidence.push({ signal: 'cursed_grade', item: w.name, detail: 'item rarity 200 (ITEM_RARITY_GRADE_CURSED)' });
    else if (/^cursed /.test(w.name) || CURSED_NAMES.includes(w.name)) evidence.push({ signal: 'cursed_name', item: w.name, detail: 'its name is a cursed item\'s' });
  }
  for (const h of heard ?? []) {
    if (CLING_TEXT.test(h.text ?? '')) evidence.push({ signal: 'clings', detail: h.text, at: h.at ?? null });
    else if (CURSE_PICKUP_TEXT.test(h.text ?? '')) evidence.push({ signal: 'cursed_on_pickup', detail: h.text, at: h.at ?? null });
  }
  if (curseSuspect?.certain) evidence.push({ signal: 'clings', item: lower(curseSuspect.name), detail: curseSuspect.said ?? curseSuspect.why ?? 'keeper heard it cling' });
  const certain = evidence.length > 0;
  const curse = {
    state: certain ? 'cursed' : curseSuspect ? 'suspected' : eq?.known ? 'none_known' : 'unknown',
    items: [...new Set(evidence.map(e => e.item).filter(Boolean).concat(curseSuspect && !certain ? [lower(curseSuspect.name)] : []))],
    evidence, cure: REMOVE_CURSE,
    note: 'A curse is not an enchantment: it is an item worn that will not come off. It is never in `debuffs`. ' +
          'Remove curse is cast on the PLAYER and unequips the cursed items; re-wearing one re-curses.',
  };

  return {
    health: health?.value ?? null, max_health: health?.max ?? null, health_pct: health?.pct ?? null,
    mana: mana?.value ?? null, max_mana: mana?.max ?? null, mana_pct: mana?.pct ?? null,
    buffs, debuffs, unknown_effects: unknown, room_effects: room,
    buff_names: buffs.map(b => b.name), debuff_names: debuffs.map(b => b.name),
    resist, resist_sources: resistSources,
    wearing: wearing.map(w => w.name), carrying,
    curse,
    // FRESHNESS. An empty list is not "no buffs" until the list has been heard at least once.
    known: { enchantments: enchantments != null && (enchStatus?.as_of ?? enchStatus?.asOf ?? 1) > 0,
             equipment: !!eq?.known, inventory: inv.length > 0 },
    as_of: { enchantments_ms: enchStatus?.age_ms ?? null, equipment_ms: eq?.fresh_ms ?? null },
  };
}

function safe(f) { try { return f(); } catch { return null; } }
