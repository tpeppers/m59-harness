// GUILD WANTS — a demand the whole fleet answers, into a store no one character owns.
//
// A loadout says what ONE character should be carrying. A guild want says what should end
// up IN THE HALL, and it is satisfied by whoever happens to be walking past with the right
// thing in its pack. That difference drives every rule below.
//
// THE PLAN IS AN END STATE, NOT AN ERRAND. It says "chest 2 should contain 300 inky-cap
// mushrooms", never "take 40 mushrooms to chest 2" — so any character can answer it, the
// answer shrinks as others contribute, and a plan that is already met produces no work at
// all. An errand list would need somebody to own it, decide who runs it, and cancel it
// when it was done; an end state needs none of that and cannot double-count.
//
// FOUR THINGS IT REFUSES TO DO, each of which is the cheap mistake:
//
//   - **It does nothing at all without a guild AND a hall.** Not "nothing to contribute" —
//     off, with a reason. A fleet that has not bought a hall has nowhere to put anything,
//     and a plan quietly accumulating shortfalls against chests that do not exist would
//     protect items from being sold for a hall that is never coming.
//   - **It never gives away what the character itself needs.** The contributor's own
//     loadout floor comes off the top, exactly as `deliverableSpare` does for farm
//     delivery. A guild is not entitled to the elderberry a caster eats with.
//   - **It never counts an unopened chest as empty.** `never_opened` means nobody has
//     looked, which is the opposite fact from "there is nothing in it", and treating it as
//     empty would send the whole fleet to fill a chest that may already be full.
//   - **It does not walk for nothing.** `plan.total === 0` means the trip is skipped, which
//     is the same rule the rent tithe already follows: a town check-in that walks to the
//     hall on every pass to look at a chest and come back is a tax on every sale.
//
// Nothing here does any I/O. The cache is `m59-storage.mjs`, the choreography is the
// keeper's town trip, and `m59-guildwants-test.mjs` pins this.
import { CHEST_BULK_MAX, GUILD_CHEST_SLOTS, chestFullness, parseChestKey, BOOKMAKERS_CHEST_SQUARES } from './m59-storage.mjs';
import { weighPack } from './m59-items.mjs';

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUILD_PLAN_FILE = process.env.M59_GUILD_PLAN ||
  resolve(fileURLToPath(new URL('../substrate/guild-plan.json', import.meta.url)));

const norm = s => String(s ?? '').trim().toLowerCase();

// Cached on mtime, exactly as `loadoutFor` is, because the keeper reads this every town
// trip: the common path is a stat() and a parse only when somebody has just saved from the
// planner. A missing file is null and null means "no guild wants", never "want nothing" —
// the same distinction a loadout draws, and for the same reason.
let planCache = { at: 0, value: null };
export function guildPlan(file = GUILD_PLAN_FILE) {
  try {
    if (!existsSync(file)) { planCache = { at: 0, value: null }; return null; }
    const mtime = statSync(file).mtimeMs;
    if (planCache.at === mtime) return planCache.value;
    const value = normalisePlan(JSON.parse(readFileSync(file, 'utf8')));
    planCache = { at: mtime, value };
    return value;
  } catch { return null; }
}

export function saveGuildPlan(raw, file = GUILD_PLAN_FILE) {
  const normalised = normalisePlan(raw);
  const out = { chests: Object.fromEntries([...normalised.chests]
    .map(([slot, items]) => [slot, { items }])) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, file);
  planCache = { at: 0, value: null };
  return { saved: out, problems: normalised.problems };
}

/**
 * Is there anywhere to put things?
 *
 * Answered from the CACHE, never from a live look, because this is consulted on every town
 * trip and the whole point is to not walk. Two independent facts are required and they fail
 * differently: belonging to a guild is stated by Frular, and having a hall is only ever
 * evidenced by somebody having seen a chest in it.
 *
 * Returns `{ok, why}` rather than a boolean, because "off because nobody has asked Frular"
 * and "off because this guild has no hall" are different problems with different fixes, and
 * a bare false would send somebody looking for a bug in the plan.
 */
export function guildStoreAvailable({ rent = null, chests = [] } = {}) {
  if (!rent)
    return { ok: false, why: 'nobody has asked Frular about the guild yet — no rent reading is cached' };
  if (rent.in_guild === false)
    return { ok: false, why: 'the fleet belongs to no guild' };
  if (rent.in_guild !== true)
    return { ok: false, why: 'the cached rent answer does not say whether the fleet is in a guild' };
  const seen = chests.filter(c => c && !c.never_opened && Array.isArray(c.items));
  if (!seen.length)
    return { ok: false, why: 'no chest in the hall has ever been opened, so there is no evidence of a hall to fill' };
  return { ok: true, chests_known: seen.length };
}

/**
 * Read a plan into a shape the rest of this file can trust.
 *
 * A slot outside 1..GUILD_CHEST_SLOTS is dropped and NAMED rather than clamped: clamping
 * would file chest 7's contents into chest 4 and look like it worked. A target of zero is
 * kept — it is a legitimate "this chest should hold none of this" and is what makes an
 * item sellable again after the guild stops wanting it.
 */
export function normalisePlan(raw) {
  const problems = [];
  const chests = new Map();
  for (const [key, entry] of Object.entries(raw?.chests ?? {})) {
    // A CHEST IS NAMED BY ITS SQUARE, like "r18c6". It used to be a slot number 1..4, which
    // implied a mapping from number to chest — and a mapping has to be learned, can be
    // learned from too short a reading, and then files one chest's contents under another
    // chest's name. The square is read off the object every visit, so there is nothing to
    // learn and nothing to get wrong. GUILD_CHEST_SLOTS survives as a fact about how many
    // chests a hall may hold; it is no longer an index into anything.
    const slot = String(key);
    if (!parseChestKey(slot)) {
      problems.push(`chest "${key}" is not a square like "r18c6" and was dropped — ` +
                    `the Bookmaker's hall builds its chests at ${BOOKMAKERS_CHEST_SQUARES.join(', ')}`);
      continue;
    }
    const items = [];
    for (const it of [].concat(entry?.items ?? entry ?? [])) {
      const item = norm(it?.item ?? it?.name);
      const target = Math.max(0, Math.floor(Number(it?.target ?? it?.amount) || 0));
      if (!item) { problems.push(`chest ${slot} has an entry with no item name`); continue; }
      const already = items.find(x => x.item === item);
      // TWO LINES FOR ONE ITEM ARE A CONTRADICTION, NOT A SUM. Adding them would invent a
      // target nobody typed; the larger is kept and the collision is reported.
      if (already) {
        problems.push(`chest ${slot} lists "${item}" twice (${already.target} and ${target}) — kept the larger`);
        already.target = Math.max(already.target, target);
        continue;
      }
      items.push({ item, target });
    }
    chests.set(slot, items);
  }
  return { chests, problems, empty: [...chests.values()].every(items => !items.length) };
}

const countIn = (items, item) => (items || [])
  .filter(i => norm(i.name ?? i.item) === item)
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

/**
 * What THIS character should hand over on this town trip.
 *
 * `keepFloor(item)` is the contributor's own reserve — its loadout floor — and is
 * subtracted before anything is offered. `chests` is the cached contents, and an unopened
 * one contributes nothing to the plan rather than being read as empty.
 *
 * Every chest is also bounded by its own remaining BULK. A chest is 24000 bulk with no
 * weight limit at all, so it is nearly always the plan rather than the container that
 * binds — but "nearly always" is not "always", and a plan that asks for more than fits
 * would otherwise be walked to the hall once per trip for ever.
 */
export function contributionPlan({ plan, chests = [], pack = [], keepFloor = () => 0,
                                   rent = null } = {}) {
  const gate = guildStoreAvailable({ rent, chests });
  if (!gate.ok) return { enabled: false, why: gate.why, total: 0, chests: [], walk: false };

  const { chests: want, problems } = plan?.chests instanceof Map ? plan : normalisePlan(plan);
  const bySlot = new Map(chests.map(c => [c.slot, c]));
  // What this character may part with at all, per item, spent down as chests claim it —
  // so two chests wanting the same item cannot each be promised the whole stack.
  const spare = new Map();
  const spareOf = (item) => {
    if (!spare.has(item))
      spare.set(item, Math.max(0, countIn(pack, item) - Math.max(0, Number(keepFloor(item)) || 0)));
    return spare.get(item);
  };

  const out = [];
  for (const [slot, items] of [...want].sort((a, b) => a[0] - b[0])) {
    const chest = bySlot.get(slot);
    if (!chest || chest.never_opened || !Array.isArray(chest.items)) {
      if (items.length) out.push({ slot, give: [], total: 0,
        why: 'this chest has never been opened, so what it already holds is unknown' });
      continue;
    }
    let roomBulk = Math.max(0, CHEST_BULK_MAX - (chestFullness(chest.items).bulk || 0));
    const give = [];
    for (const { item, target } of items) {
      const have = countIn(chest.items, item);
      const short = Math.max(0, target - have);
      if (!short) continue;
      const canGive = Math.min(short, spareOf(item));
      if (canGive <= 0) continue;
      // Bulk-bounded, per item, against what is left in this chest after earlier lines.
      const each = weighPack([{ name: item, amount: 1 }]).bulk || 0;
      const fits = each > 0 ? Math.min(canGive, Math.floor(roomBulk / each)) : canGive;
      if (fits <= 0) {
        give.push({ item, amount: 0, short, why: 'the chest has no room left for this' });
        continue;
      }
      roomBulk -= fits * each;
      spare.set(item, spareOf(item) - fits);
      give.push({ item, amount: fits, short, chest_had: have, target });
    }
    const total = give.reduce((n, g) => n + g.amount, 0);
    out.push({ slot, give, total });
  }

  const total = out.reduce((n, c) => n + c.total, 0);
  return {
    enabled: true, total, chests: out,
    // THE WHOLE POINT OF THE CHECK-IN. Nothing to give means no walk, and the caller is
    // expected to honour it rather than travelling to discover it.
    walk: total > 0,
    ...(problems?.length ? { problems } : {}),
  };
}

/**
 * Should the sell path hold on to this item?
 *
 * OVERFLOW IS THE POINT, AND IT ONLY WORKS IF THE ORDER IS RIGHT. Everything the fleet
 * gathers goes: pack -> the character's own floor -> the guild's chests -> sold -> banked,
 * because a bank balance is the only unlimited store in the game and the only one that
 * survives death. So an item is protected from the vendor exactly while the guild still has
 * a shortfall of it, and becomes sellable the moment the plan is met — which is what turns
 * a full hall into money instead of into a fleet that can never sell anything again.
 *
 * Returns a predicate, so the caller composes it with the loadout's own keep test rather
 * than this file knowing anything about loadouts.
 */
export function guildKeepTest({ plan, chests = [], rent = null } = {}) {
  const gate = guildStoreAvailable({ rent, chests });
  if (!gate.ok) return () => false;
  const { chests: want } = plan?.chests instanceof Map ? plan : normalisePlan(plan);
  const bySlot = new Map(chests.map(c => [c.slot, c]));
  const shortfall = new Map();
  for (const [slot, items] of want) {
    const chest = bySlot.get(slot);
    for (const { item, target } of items) {
      // An unopened chest counts its whole target as short: the safe direction is to keep
      // the item until somebody has looked, because selling it is not reversible.
      const have = (chest && !chest.never_opened && Array.isArray(chest.items))
        ? countIn(chest.items, item) : 0;
      const short = Math.max(0, target - have);
      if (short > 0) shortfall.set(item, (shortfall.get(item) || 0) + short);
    }
  }
  const test = (name) => shortfall.get(norm(name)) > 0;
  test.shortfall = shortfall;
  return test;
}

/** What the guild is still short of overall, for a board. */
export function guildShortfall({ plan, chests = [], rent = null } = {}) {
  const test = guildKeepTest({ plan, chests, rent });
  return [...(test.shortfall ?? new Map())]
    .map(([item, short]) => ({ item, short }))
    .sort((a, b) => b.short - a.short);
}
