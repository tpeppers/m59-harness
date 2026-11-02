// WHICH GUILD HALL A BOARD IS SHOWING, WHEN THE ROSTER HOLDS MORE THAN ONE.
//
// Not a CLI. Three pages read the guild's stores -- the Inventory board (m59-inventory-page.mjs),
// the compendium's guild-hall planner (`/_guildplan` in m59-compendium.mjs) and, for rent, the
// Economy board -- and until 2026-11-01 every one of them could assume there was ONE hall (714,
// the Bookmaker's), one plan and one rent reading. The roster can now hold several guilds, allied,
// each with its own hall, so each of those pages has to be asked WHICH hall, and all of them have
// to answer the same three questions the same way:
//
//   hallChoices  what halls there are to pick from
//   pickHall     which one to show when the request did not say
//   rentForHall  whose rent decides whether that hall can be planned against
//
// They live here rather than in each page for the reason the tab bar lives in m59-page-chrome.mjs:
// three copies of "which hall is the default" would disagree the first time one was edited, and a
// planner that defaults to one hall while the board beside it defaults to another is a plan saved
// against the chests nobody was looking at.
//
// READ-ONLY. Nothing here writes a registry, a plan or a reading -- not even GuildRegistry's
// one-time `adoptLegacyHall`, which belongs to the keepers that actually see a guild.
import { LEGACY_CHEST_HALL, isGuildHallRoom, hallName } from './m59-storage.mjs';
import { GuildRegistry, guildSummary } from './m59-guild-registry.mjs';
import { guildPlanRooms } from './m59-guildwants.mjs';

const lc = s => String(s ?? '').trim().toLowerCase();

/**
 * Every hall a board could show, one row each, sorted by room:
 *   { room, name, guild, allies, chests, has_plan, rent }
 *
 * THREE SOURCES, because each one alone misses a hall somebody cares about: a guild the registry
 * says owns a hall (even before anybody has opened a chest there), a hall with chest readings
 * (even when nothing records who owns it), and a hall with a PLAN on disk (somebody wrote one before
 * walking there -- dropping it from the picker would hide a file the keepers obey). A guild with no
 * known hall is not a hall and is not listed; its rent still shows on the Economy board.
 */
export function hallChoices({ store, registry = null, planRooms = null } = {}) {
  const reg = registry ?? new GuildRegistry({ dir: store.dir });
  let rows = [];
  try { rows = guildSummary({ registry: reg, store }); } catch { rows = []; }
  let plans = planRooms;
  if (plans == null) { try { plans = guildPlanRooms(); } catch { plans = []; } }
  const out = new Map();
  for (const r of rows) {
    if (r.hall_room == null || out.has(Number(r.hall_room))) continue;
    out.set(Number(r.hall_room), { room: Number(r.hall_room), name: r.hall_name ?? hallName(r.hall_room),
      guild: r.guild ?? null, allies: r.allies ?? [], chests: r.chests ?? 0, has_plan: false, rent: r.rent ?? null });
  }
  for (const room of plans ?? []) {
    if (!isGuildHallRoom(room)) continue;
    if (!out.has(Number(room)))
      out.set(Number(room), { room: Number(room), name: hallName(room), guild: reg.ownerOfHall(room) ?? null,
        allies: [], chests: 0, has_plan: true, rent: null });
  }
  const planned = new Set((plans ?? []).map(Number));
  for (const c of out.values()) c.has_plan = planned.has(c.room);
  return [...out.values()].sort((a, b) => a.room - b.room);
}

/**
 * The hall to show. `requested` is whatever the request carried (`?hall=705`, a POST field), or null.
 *
 *   { room, explicit, invalid }
 *
 * The default, when the request did not say: the only hall if there is one; otherwise 714 if it
 * has readings (it is the hall every older link and every older plan meant); otherwise the first;
 * and with no hall known at all, 714 -- which is exactly what every one of these pages showed
 * before there could be two. A request naming something that is not a guild hall room comes back
 * `invalid` with the default filled in, so a READ can fall back and say so while a WRITE can refuse.
 */
export function pickHall(choices = [], requested = null) {
  const asked = requested == null ? '' : String(requested).trim();
  if (asked && isGuildHallRoom(asked)) return { room: Number(asked), explicit: true, invalid: null };
  let room = LEGACY_CHEST_HALL;
  if (choices.length === 1) room = choices[0].room;
  else if (choices.some(c => c.room === LEGACY_CHEST_HALL && c.chests > 0)) room = LEGACY_CHEST_HALL;
  else if (choices.length) room = choices[0].room;
  return { room, explicit: false, invalid: asked || null };
}

/**
 * Whose rent decides whether a hall can be planned against: the guild that OWNS it.
 *
 *   { rent, owner, why }   `why` set when there is no rent to give and the reason is not Frular's
 *
 * With an owner on record it is that guild's reading and nobody else's -- a second guild reading the
 * first guild's balance as its own is the mix-up the per-guild rent files exist to prevent. A single
 * reading that names no guild, on a roster that has only ever seen one guild, is still that guild's:
 * that is the shape every reading had before the split.
 *
 * With NO owner on record it is the old single-guild answer (the newest reading) only while at most
 * one guild has rent readings. With two, guessing which of them owns this hall would be the same
 * mix-up from the other side, so it refuses and says how to record the owner.
 */
export function rentForHall({ store, registry = null, room }) {
  const reg = registry ?? new GuildRegistry({ dir: store.dir });
  const owner = reg.ownerOfHall(room) ?? null;
  let all = [];
  try { all = store.allRents(); } catch { all = []; }
  if (owner) {
    const own = store.readRent(owner);
    if (own) return { rent: own, owner, why: null };
    if (all.length === 1 && !all[0].guild && reg.guilds().length <= 1) return { rent: all[0], owner, why: null };
    return { rent: null, owner, why: `nobody has asked Frular about "${owner}", the guild that owns ` +
      `${hallName(room)} (${room}) — no rent reading is cached for it` };
  }
  const named = new Set(all.filter(r => r.guild).map(r => lc(r.guild)));
  if (named.size <= 1) return { rent: store.readRent(), owner: null, why: null };
  return { rent: null, owner: null, why: `${named.size} guilds have rent readings and nothing records which of them ` +
    `owns ${hallName(room)} (${room}) — node tools/m59-guild-registry.mjs hall --room ${room} --guild "<name>"` };
}

/** One line for a hall in a picker: "The Bookmaker's Guild House (714) · The Second Swines". */
export const hallLabel = (c) =>
  `${c.name ?? hallName(c.room)} (${c.room})${c.guild ? ` · ${c.guild}` : ''}`;
