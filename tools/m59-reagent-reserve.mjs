// THE PVP REAGENT RESERVE -- WHAT FARMING MAY NOT SPEND, BECAUSE A FIGHT WITH PLAYERS WILL NEED IT.
//
// Operator, 2026-10-29: "if people are training spells while they farm, or casting buffs on their allies against
// monsters, they will surely run out of the non-renewable reagents before the morning battles ... we need reserved
// reagents ... for: deflect, bless, super strength, magic shield, and dispel illusion."
//
// Nothing else could hold that line. A practice drill has its own `keep`, a desk its `reserve_casts`, a loadout's
// `carry.min` stops a reagent being GIVEN away -- and each guards only its own caller. A coordinator that casts
// Discordance at a sandstorm, a trainer script, a strategy's rite: every one of them reaches the wire through
// `client.cast`, so the reserve is checked THERE (`c.castVeto`, installed per client by the session beside
// `attackVeto`). A cast outside a PvP fight that would take a reserved reagent below its floor is not sent.
// Inside a PvP fight -- return fire, a war engagement, assisting, standing to -- the reserve is what it is FOR, and
// nothing is refused.
//
// THE ORDERS ARE THIS MACHINE'S (gitignored, like the PvP strategy assignment): substrate/reagent-reserve-<fleet>.json,
// or M59_REAGENT_RESERVE_FILE. Re-read when its mtime moves, at most every 2 s; no restart.
//
//   { "default":    { "spells": { "bless": 4, "magic shield": 4 }, "items": { "sapphire": 2 } },
//     "agents":     { "t8": { "spells": { "deflect": 8 } } },
//     "characters": { "Zoot": null } }
//
// `spells` is CASTS to keep of each spell -- counted only for a spell this character KNOWS, and turned into reagents
// with the kod's own costs (m59-deskpractice.mjs spellCost). `items` is a floor in units. Most specific wins per key
// (character, then agent, then default); `null` there means no reserve at all. No file -- every fresh clone -- is no
// reserve and nothing is ever refused.
//
// A PACK NAME IS MATCHED EXACTLY, not by substring: `mushroom` is the plain mushroom, never the red, purple or edible
// one, and a reserve of plain mushrooms must not be counted out of a stack of red ones. Plurals and "vial(s) of" fold.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spellCost } from './m59-deskpractice.mjs';

const SUBSTRATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate');
export const RESERVE_RECHECK_MS = 2000;
export const VETO_NOTE_MS = 60_000;

export const reserveFile = (fleet, env = process.env) => env.M59_REAGENT_RESERVE_FILE
  || join(SUBSTRATE, fleet && fleet !== 'default' ? `reagent-reserve-${fleet}.json` : 'reagent-reserve.json');

const lc = s => String(s ?? '').trim().toLowerCase();
/** A pack name or a reagent name, folded: "vials of solagh" -> "solagh", "herbs" -> "herb". */
export const reagentKey = s => lc(s).replace(/^vials? of /, '').replace(/(?<=[a-z])s$/, '');

let cache = { file: null, checked: -Infinity, mtime: null, book: null, error: null };
/** The reserve book, or null. Never throws: a file that will not parse keeps the last good book and says so. */
export function readReserve(file, now = Date.now()) {
  if (cache.file === file && now - cache.checked < RESERVE_RECHECK_MS) return cache.book;
  let mtime = null;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : null; } catch { mtime = null; }
  if (cache.file === file && cache.mtime === mtime) { cache.checked = now; return cache.book; }
  let book = null, error = null;
  if (mtime != null) {
    try { book = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { error = `${file}: ${e.message}`; book = cache.file === file ? cache.book : null; }
  }
  cache = { file, checked: now, mtime, book, error };
  return book;
}
export const reserveError = () => cache.error;

/** This character's reserve: { spells: { name: casts }, items: { key: n } }, or null for none. */
export function resolveReserve(book, { agent = null, character = null } = {}) {
  if (!book || typeof book !== 'object') return null;
  const pick = (table, key) => {
    if (!table || typeof table !== 'object' || key == null) return undefined;
    const hit = Object.keys(table).find(k => lc(k) === lc(key));
    return hit === undefined ? undefined : table[hit];
  };
  const layers = [book.default, pick(book.agents, agent), pick(book.characters, character)];
  if (layers.some(l => l === null)) return null;
  const out = { spells: {}, items: {} };
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    for (const [k, v] of Object.entries(l.spells ?? {})) out.spells[lc(k)] = Math.max(0, Number(v) || 0);
    for (const [k, v] of Object.entries(l.items ?? {})) out.items[reagentKey(k)] = Math.max(0, Number(v) || 0);
  }
  return Object.values(out.spells).some(Boolean) || Object.values(out.items).some(Boolean) ? out : null;
}

/** Reagent floors for a reserve and the spells this character knows: Map reagentKey -> units. */
export function floorsFor(reserve, known = []) {
  const floors = new Map();
  if (!reserve) return floors;
  const knows = new Set(known.map(lc));
  for (const [spell, casts] of Object.entries(reserve.spells)) {
    if (!casts || !knows.has(spell)) continue;
    for (const [item, n] of spellCost(spell)?.reagents ?? [])
      floors.set(reagentKey(item), (floors.get(reagentKey(item)) ?? 0) + casts * n);
  }
  for (const [item, n] of Object.entries(reserve.items)) if (n) floors.set(item, (floors.get(item) ?? 0) + n);
  return floors;
}

/** Units of `key` in a pack of { name, amount } rows (pack names folded exactly). */
export function countReagent(pack, key) {
  return (pack ?? []).filter(r => reagentKey(r.name) === key).reduce((a, r) => a + (Number(r.amount) || 1), 0);
}

/**
 * Would casting `spell` now break the reserve? Pure. Returns null (cast it) or { spell, reagent, have, need, floor }.
 */
export function reserveBreach({ spell, known = [], pack = [], reserve = null, inPvp = false }) {
  if (!reserve || inPvp) return null;
  const cost = spellCost(spell);
  if (!cost?.reagents?.length) return null;
  const floors = floorsFor(reserve, known);
  for (const [item, need] of cost.reagents) {
    const key = reagentKey(item), floor = floors.get(key) ?? 0;
    if (!floor) continue;
    const have = countReagent(pack, key);
    if (have - need < floor) return { spell: lc(spell), reagent: key, have, need, floor };
  }
  return null;
}

/**
 * The per-client veto the session installs (`c.castVeto`). `who` = { fleet, agent, character }; `inPvp()` says whether
 * a PvP fight owns the body. Logs a refusal once per spell per VETO_NOTE_MS.
 */
export function makeCastVeto(session, c, { who = {}, inPvp = () => false, now = Date.now, log = () => {} } = {}) {
  const noted = new Map();
  return spellId => {
    // `who` may be a function: the keeper process names the character after the client exists. Nobody named: no reserve.
    const id = (typeof who === 'function' ? who() : who) ?? null;
    if (!id) return false;
    const reserve = resolveReserve(readReserve(reserveFile(id.fleet), now()), id);
    if (!reserve) return false;
    const nameOf = o => String(c.rsc?.get?.(o?.nameRsc) ?? o?.name ?? '').trim();
    const known = (c.spells ?? []).map(nameOf).filter(Boolean);
    const sp = (c.spells ?? []).find(s => s.id === spellId || Number(s.id) === Number(spellId));
    if (!sp) return false;
    const pack = (c.inventory ?? []).map(i => ({ name: nameOf(i), amount: i.amount }));
    let pvp = false;
    try { pvp = !!inPvp(); } catch { pvp = false; }
    const breach = reserveBreach({ spell: nameOf(sp), known, pack, reserve, inPvp: pvp });
    if (!breach) return false;
    const t = now(), last = noted.get(breach.spell) ?? -Infinity;
    if (t - last >= VETO_NOTE_MS) {
      noted.set(breach.spell, t);
      const why = `${breach.spell} not cast: ${breach.have} ${breach.reagent} on hand, ${breach.need} needed, ${breach.floor} reserved for PvP`;
      try { session?.recorder?.line?.('combat', { event: 'reagent_reserve_veto', ...breach }); } catch {}
      log(`[reserve] ${id.character ?? id.agent ?? '?'}: ${why}`);
    }
    session.lastReserveVeto = { at: t, ...breach };
    return true;
  };
}
