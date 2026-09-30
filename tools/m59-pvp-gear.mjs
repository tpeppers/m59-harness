// PVP GEAR: ITEMS A CHARACTER WEARS ONLY TO FIGHT PEOPLE, AND THE WANDS IT FIRES TOGETHER.
//
//   substrate/pvp-gear-<fleet>.json   (this machine's; gitignored -- an order, not a mechanic)
//   {
//     "format": "m59-pvp-gear/1",
//     "items":  ["shield of", "plate armor"],        // name substrings: worn ONLY in a PvP fight
//     "wands":  [{ "match": "lightning wand", "timer": true },
//                { "match": "vampiric shock", "timer": false }],
//     "volley_ms": 2000
//   }
//
// WHY TWO LISTS. Armour and shields are WORN: they go on when a PvP fight starts and come off when
// it ends, and farming must never pick them as its "best" piece (skills.armourOf / weaponRanking
// skip them unless the client is in a PvP fight). Wands are never worn -- a wand is fired from the
// PACK with BP_REQ_APPLY(wand, target) (player.kod TryApplyItem requires only IsHolding).
//
// THE TWO WANDS ARE DIFFERENT MACHINES, which is why each carries `timer`:
//   * lightning wand (Wand is SpellItem, SID_LIGHTNING_BOLT). It goes through the spell's
//     CanPayCosts, so it shares the character's ATTACK TIMER: 2s post-cast (lightnin.kod:45), and a
//     zap within that of a melee swing is refused "You point your wand but nothing happens" with no
//     charge spent. It also needs line of sight and a rough facing. 4-9 charges; deleted at 0.
//   * wand of vampiric shock (SpecialWand, vampwand.kod). No attack timer, no line of sight, no
//     facing: same room only. 10-18 charges, decremented BEFORE the effect; at 0 it is BROKEN, not
//     deleted, and every later apply is refused. Each zap heals the user and pushes its karma
//     toward -80.
// So a character holding a lightning wand does not swing between volleys (a swing would eat the
// next zap); one holding only a vampiric wand keeps swinging and zaps on the beat as well.
//
// THE BEAT. Every keeper is a process on the same machine, so the wall clock is shared: firing on
// floor(now / volley_ms) puts every character in the fight on the same 2-second beat without any
// messaging. Unidentified wands are all named just "wand" (wand.kod:19), so a wand must be
// identified before it matches here -- the operator hands out identified ones.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

export const DEFAULT_PVP_GEAR = Object.freeze({
  format: 'm59-pvp-gear/1',
  items: [],
  wands: [{ match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }],
  volley_ms: 2000,
  expect_incoming: [],
  accept_if_missing: [],
});

export const PVP_GEAR_FILE = () => {
  if (process.env.M59_PVP_GEAR_FILE) return process.env.M59_PVP_GEAR_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `pvp-gear-${name}.json` : 'pvp-gear.json');
};

let cache = { key: null, value: DEFAULT_PVP_GEAR, checked: 0 };
/** The config, mtime-cached and re-stat'ed at most every 2s. A file that will not parse keeps the last good one. */
export function pvpGearConfig() {
  const file = PVP_GEAR_FILE(), now = Date.now();
  if (cache.file === file && now - cache.checked < 2000) return cache.value;
  cache.checked = now; cache.file = file;
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.key === mtime) return cache.value;
  cache.key = mtime;
  if (!mtime) { cache.value = DEFAULT_PVP_GEAR; return cache.value; }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    cache.value = {
      ...DEFAULT_PVP_GEAR,
      items: Array.isArray(raw.items) ? raw.items.map(String).filter(Boolean) : DEFAULT_PVP_GEAR.items,
      wands: Array.isArray(raw.wands) ? raw.wands.filter(w => w?.match).map(w => ({ match: String(w.match), timer: w.timer !== false }))
                                      : DEFAULT_PVP_GEAR.wands,
      volley_ms: Number(raw.volley_ms) >= 1000 ? Number(raw.volley_ms) : DEFAULT_PVP_GEAR.volley_ms,
      expect_incoming: Array.isArray(raw.expect_incoming) ? raw.expect_incoming.map(String).filter(Boolean) : [],
      accept_if_missing: Array.isArray(raw.accept_if_missing) ? raw.accept_if_missing.map(String).filter(Boolean) : [],
    };
  } catch { /* keep the last good value */ }
  return cache.value;
}

const has = (name, pat) => String(name ?? '').toLowerCase().includes(String(pat).toLowerCase());

// AN UNIDENTIFIED WAND CAN STILL BE NAMED FROM THE WIRE. Until identified every `Wand` subclass is
// called just "wand" (wand.kod:19 HideHiddenAttributes hides the NAME only) and shares one icon,
// wand6.bgf -- but each keeps its own palette translation, which the server sends per object and
// m59-parse.mjs extracts as `translation`. Among everything named "wand" on the wand6 icon:
//   LightningWand  viColor = XLAT_TO_YELLOW (0x08)   lightngw.kod:28   <- the only yellow one
//   IdentifyWand   XLAT_TO_BLUE (0x06); the Qor wands gray; brittle/shatter orange; forget,
//   dement, slither, seduce purple; purify, hospice sky; mark of dishonor red; SpellWand (the
//   SpecialWand fireball, also named "wand") red.
// So a "wand" whose translation is 0x08 is a lightning wand, and in particular is NOT a wand of
// identification. The wand of vampiric shock always shows its own name (vampwand.kod, wand3.bgf).
export const XLAT_TO_YELLOW = 0x08;
export const UNIDENTIFIED_SIGNATURES = Object.freeze([
  { as: 'lightning wand', name: 'wand', translation: XLAT_TO_YELLOW },
]);

/** The name this item should be treated as: its own, or what its wire signature proves it is. */
export function effectiveName(c, o) {
  const name = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
  const bare = name.trim().toLowerCase();
  for (const sig of UNIDENTIFIED_SIGNATURES)
    if (bare === sig.name && Number(o.translation) === sig.translation) return sig.as;
  return name;
}

/** Is this item one the character wears ONLY in a PvP fight? */
export const isPvpOnly = (name, cfg = pvpGearConfig()) => !!name && cfg.items.some(p => has(name, p));

const nameOf = (c, o) => c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';

/** PvP-only items in the pack, with whether each is worn now. */
export function pvpItemsIn(c, cfg = pvpGearConfig()) {
  const worn = c.using ?? new Set();
  return (c.inventory ?? []).map(o => ({ o, name: nameOf(c, o) }))
    .filter(r => isPvpOnly(r.name, cfg)).map(r => ({ ...r, worn: worn.has(r.o.id) }));
}

/** Volley wands in the pack, in config order (so a lightning wand is preferred when listed first). */
export function volleyWandsIn(c, { spent = new Set(), cfg = pvpGearConfig() } = {}) {
  const out = [];
  for (const w of cfg.wands) for (const o of c.inventory ?? []) {
    const name = effectiveName(c, o);
    if (!spent.has(o.id) && has(name, w.match) && !out.some(x => x.o.id === o.id))
      out.push({ o, name, timer: w.timer });
  }
  return out;
}

export const beatOf = (now, ms = pvpGearConfig().volley_ms) => Math.floor(now / ms);

// EXPECTED INCOMING: what a character should accept when somebody hands it over, without asking.
// The operator's rule, 2026-09-30: "always accept being handed anything from the PVP gear list (or
// any expected incoming list), with the remaining elements from the PvP gear list always expected
// unless already carried" -- so the operator can offer a character its kit and it takes it.
//   * every PvP item and volley wand the character is NOT already carrying (a pattern already
//     satisfied by something in the pack is not expected again: one shield, one lightning wand);
//   * everything in the config's `expect_incoming` list, always.
export function expectedIncoming(c, { cfg = pvpGearConfig() } = {}) {
  const carried = (c?.inventory ?? []).map(o => effectiveName(c, o));
  // `accept_if_missing`: ordinary gear (not PvP-only -- farming wears it too) that a character
  // should still take when it has none, e.g. a shield.
  const missing = [...cfg.items, ...cfg.wands.map(w => w.match), ...(cfg.accept_if_missing ?? [])]
    .filter(p => !carried.some(n => has(n, p)));
  return [...new Set([...missing, ...(cfg.expect_incoming ?? [])])];
}

/**
 * Is every item in this offer expected? Offered items are {name, translation?} as the trade
 * window reports them; an unidentified yellow "wand" counts as the lightning wand it must be.
 */
export function offerIsExpected(c, offered, { cfg = pvpGearConfig() } = {}) {
  if (!offered?.length) return false;
  const expected = expectedIncoming(c, { cfg });
  const as = i => effectiveName({ rsc: { get: () => i.name } }, { nameRsc: 0, translation: i.translation });
  return offered.every(i => expected.some(p => has(as(i), p)));
}
