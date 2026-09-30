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
    };
  } catch { /* keep the last good value */ }
  return cache.value;
}

const has = (name, pat) => String(name ?? '').toLowerCase().includes(String(pat).toLowerCase());

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
    const name = nameOf(c, o);
    if (!spent.has(o.id) && has(name, w.match) && !out.some(x => x.o.id === o.id))
      out.push({ o, name, timer: w.timer });
  }
  return out;
}

export const beatOf = (now, ms = pvpGearConfig().volley_ms) => Math.floor(now / ms);
