// SOURCING — FOR EVERY ITEM A RAID NEEDS, EVERY WAY TO GET IT, RANKED FOR THIS FLEET.
//
// Pure joins over data this repository already builds — nothing here reads a socket:
//
//   compendium/data/treasure.json   treasure TYPES (weighted tables, exact per-roll chances) and
//                                   itemDroppedBy: item class -> the types that can roll it
//   compendium/creatures.json       beasts: level, difficulty, treasure type, where they live
//   compendium/data/spawns.json     byMonster: the rooms each creature spawns in (generator/cap)
//   compendium/data/zones.json      rooms: room class -> room number
//   substrate/m59-merchants.json    who SELLS each class, and where
//   substrate/m59-values.json       base values, for prices
//   m59-prefarm-lib.mjs             faction soldiers — they drop CARRIED gear, not a table
//
// THE DROP MATH (treasure.json rules.summary, from monster.kod:4964-4973 and trestype.kod:223):
// a kill rolls 1 + level/55 + random(0, difficulty/3) items, capped at 6 (one for MOB_ONE_TREASURE),
// each roll one draw from the creature's weighted table. So an item with exact per-roll chance p
// drops with probability 1 - (1 - p)^rolls per kill, using the expected rolls. A battered skeleton
// (level 60, difficulty 4) rolls ~2.7 times: its knight's shield row is ~5% a kill.
//
// FIGHTABILITY is the keepers' own default: a creature is fought when its level is within 150% of
// the character's max health — and max health IS the level in this game (status's level_note). A
// source is graded against the fleet's real levels, so the menu an operator is shown is the menu
// THIS fleet can execute, not every monster in the book.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLDIER_DROPS, FACTIONS, SOLDIER, BUY_PRICE } from './m59-prefarm-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const lower = s => String(s ?? '').toLowerCase().trim();

/** Load every table once. `root` lets a test point at fixtures. */
export function loadSourcingData(root = ROOT) {
  const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const treasure = read('compendium/data/treasure.json');
  const creatures = read('compendium/creatures.json');
  const spawns = read('compendium/data/spawns.json');
  const zones = read('compendium/data/zones.json');
  const items = read('substrate/m59-items.json');
  const merchants = read('substrate/m59-merchants.json').merchants ?? [];
  const values = read('substrate/m59-values.json').values ?? {};
  return { treasure, creatures, spawns, zones, items, merchants, values };
}

/** Display name -> kod class, via the item table (m59-items.json) — never guessed. */
export function classOf(data, name) {
  const t = data.items?.[lower(name)] ?? data.items?.items?.[lower(name)] ?? null;
  if (t?.cls) return t.cls;
  const hit = Object.values(data.items?.items ?? data.items ?? {}).find(v => lower(v?.name) === lower(name));
  return hit?.cls ?? null;
}

/** Expected rolls per kill for a creature (level, difficulty). */
export const rollsPerKill = (level, difficulty, one = false) =>
  one ? 1 : Math.min(6, 1 + Math.floor(Number(level) / 55) + Number(difficulty) / 6);

/** Per-kill drop chance from a per-roll chance and the expected rolls. */
export const perKill = (pRoll, rolls) => 1 - Math.pow(1 - pRoll, rolls);

/** Grade a creature's level against the fleet's levels (= max health). */
export function fightability(level, fleetLevels = []) {
  const ls = fleetLevels.map(Number).filter(n => n > 0).sort((a, b) => a - b);
  if (!ls.length) return { grade: 'unknown', rank: 2, can: null };
  const median = ls[Math.floor(ls.length / 2)], top = ls[ls.length - 1];
  const can = ls.filter(l => level <= l * 1.5).length;
  if (level <= median) return { grade: 'easy', rank: 0, can };
  if (level <= median * 1.5) return { grade: 'in band', rank: 1, can };
  if (level <= top * 1.5) return { grade: 'stretch', rank: 3, can };
  return { grade: 'above the fleet', rank: 5, can: 0 };
}

const roomNum = (data, roomCls) => data.zones?.rooms?.[roomCls]?.ridValue ?? null;
const roomName = (data, roomCls) => data.zones?.rooms?.[roomCls]?.name ?? roomCls;

/** Every creature whose treasure table can roll `cls`, with its rooms and per-kill chance. */
export function farmSources(data, cls) {
  const tids = data.treasure.itemDroppedBy?.[cls] ?? [];
  const out = [];
  for (const tid of tids) {
    const type = data.treasure.types?.[tid];
    const row = (type?.items ?? []).find(r => r.cls === cls);
    if (!row) continue;
    const pRoll = (Number(row.exactChancePercent ?? row.chancePercent) || 0) / 100;
    const key = lower(tid.replace(/^TID_/, ''));
    for (const b of data.creatures.beasts ?? []) {
      if (lower(b.treasure) !== key || !(Number(b.level) > 1)) continue;
      const monsterCls = Object.keys(data.spawns.byMonster ?? {}).find(k => lower(k) === lower(b.slug));
      const rooms = (data.spawns.byMonster?.[monsterCls] ?? []).map(r => ({
        num: roomNum(data, r.room), name: r.name ?? roomName(data, r.room), how: r.how, chance: r.chance ?? null, cap: r.cap ?? null,
      })).filter(r => r.num != null);
      if (!rooms.length) continue;
      const rolls = rollsPerKill(b.level, b.difficulty);
      out.push({ kind: 'farm', creature: b.name, level: Number(b.level), difficulty: Number(b.difficulty),
                 tid, per_roll: pRoll, rolls, per_kill: perKill(pRoll, rolls), rooms });
    }
  }
  return out;
}

/** Faction soldiers as sources: they drop what they CARRY, not a table (m59-prefarm-lib). */
export function soldierSources(name) {
  const k = Object.keys(SOLDIER_DROPS).find(x => lower(x) === lower(name).replace(/s$/, '') || lower(x) === lower(name));
  if (!k) return [];
  return Object.entries(FACTIONS).map(([faction, f]) => ({
    kind: 'soldiers', creature: f.troop, faction, level: SOLDIER.level[1], level_range: SOLDIER.level,
    difficulty: SOLDIER.difficulty[1], per_kill: SOLDIER_DROPS[k],
    rooms: f.rooms.map(num => ({ num, name: `${faction} flag room ${num}`, how: 'flagpole', chance: null, cap: SOLDIER.cap })),
  }));
}

/** Merchants that sell `cls`, with an approximate price (base value x markup). */
export function buySources(data, cls, name) {
  const KNOWN_MARKUP = { 113: 4, 374: 1, 201: 3, 154: 5 };
  const base = Number(data.values?.[lower(name)] ?? data.values?.[lower(cls)] ?? 0) || null;
  return (data.merchants ?? []).filter(m => (m.sells ?? []).some(s => s.cls === cls)).map(m => {
    const markup = m.markup ?? KNOWN_MARKUP[m.room] ?? 3;
    const price = base ? Math.round(base * (100 + 20 * markup) / 100) : (BUY_PRICE[lower(name)] ?? null);
    return { kind: 'buy', merchant: m.name ?? m.cls, room: m.room, price,
             approx: m.markup == null && KNOWN_MARKUP[m.room] == null };
  }).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
}

/**
 * THE MENU FOR ONE ITEM. Options, best first:
 *   chest    already in the guild chests (free)
 *   farm     each creature that drops it, graded against the fleet, fewest kills first within a grade
 *   soldiers the three factions' flag rooms, when soldiers carry it
 *   buy      the cheapest counter first
 *   create   a weapon a Kraanan can conjure instead (create weapon) — offered, never assumed
 * Option 0 is ALWAYS "don't farm it: buy it" (or skip, when nobody sells it).
 */
export function optionsFor(data, name, need, { fleetLevels = [], chestHas = 0, createable = [] } = {}) {
  const cls = classOf(data, name);
  const opts = [];
  const buys = cls ? buySources(data, cls, name) : [];
  opts.push(buys.length
    ? { kind: 'buy', label: `Don't farm it. Buy it: ${buys[0].merchant} (room ${buys[0].room}), ~${buys[0].price?.toLocaleString() ?? '?'} each` +
        `${buys[0].approx ? ' (price approximate)' : ''} = ~${buys[0].price ? (buys[0].price * need).toLocaleString() : '?'}`,
        ...buys[0], cost: buys[0].price ? buys[0].price * need : null }
    : { kind: 'skip', label: "Don't. Nobody sells it — go without" });
  if (chestHas > 0) {
    const take = Math.min(chestHas, need), rest = need - take;
    opts.push({ kind: 'chest', count: take, rest, restBuy: rest && buys[0] ? buys[0] : null,
      label: `Take ${take} from the guild chests` + (rest ? (buys[0] ? ` and buy the other ${rest} at ${buys[0].merchant} (~${(buys[0].price * rest).toLocaleString()})` : ` — ${rest} short, nobody sells it`) : '') });
  }
  if (createable.map(lower).includes(lower(name)))
    opts.push({ kind: 'create', label: 'Create it (Kraanan "create weapon") — which weapon it makes is NOT verified; read the output back' });
  const farms = [...(cls ? farmSources(data, cls) : []), ...soldierSources(name)].map(s => {
    const f = fightability(s.level, fleetLevels);
    const kills = s.per_kill > 0 ? Math.ceil(need / s.per_kill) : Infinity;
    return { ...s, fight: f, kills };
  }).filter(s => Number.isFinite(s.kills))
    .sort((a, b) => (a.fight.rank - b.fight.rank) || (a.kills - b.kills));
  for (const s of farms) {
    const where = s.rooms.slice(0, 3).map(r => `${r.name} (${r.num})`).join(', ') + (s.rooms.length > 3 ? ` +${s.rooms.length - 3}` : '');
    opts.push({ ...s, label: `Farm ${s.creature}${s.kind === 'soldiers' ? ` (${s.faction})` : ''} — level ${s.level_range ? s.level_range.join('-') : s.level}, ` +
      `${s.per_roll ? `${(s.per_roll * 100).toFixed(1)}%/roll x ${s.rolls.toFixed(1)} rolls = ` : ''}${(s.per_kill * 100).toFixed(1)}%/kill, ~${s.kills} kills — ${s.fight.grade}${s.fight.can != null ? ` (${s.fight.can} fighters in band)` : ''} — at ${where}` });
  }
  return { item: name, cls, need, options: opts };
}

/** A whole list: one menu per item. wants: {item: count}. */
export function sourcingMenu(data, wants, ctx = {}) {
  return Object.entries(wants).map(([item, n]) => optionsFor(data, item, Number(n), {
    ...ctx, chestHas: ctx.chest?.[lower(item)] ?? 0 }));
}

/**
 * THE CHOSEN PLAN -> JOBS. choices: {item: optionIndex}. Farm choices that share a creature and a
 * room are merged into ONE job (chains AND shields off the same skeletons are one trip); buys are
 * one provisioning list; chest draws are one provisioning list.
 */
export function jobsFrom(menu, choices = {}, prefs = {}) {
  const farm = new Map(), buy = [], chest = [], create = [], skipped = [];
  for (const m of menu) {
    const opt = m.options[Number(choices[m.item] ?? 0)] ?? m.options[0];
    if (opt.kind === 'farm' || opt.kind === 'soldiers') {
      // The room: the operator's preferred one when it is among this source's rooms, else the first.
      const want = prefs[m.item]?.room;
      const room = opt.rooms.some(r => r.num === want) ? want : opt.rooms[0]?.num;
      const key = `${opt.creature}@${room}`;
      const j = farm.get(key) ?? { kind: opt.kind, creature: opt.creature, faction: opt.faction ?? null,
                                   rooms: opt.rooms.map(r => r.num), room, items: [], kills: 0 };
      j.items.push({ item: m.item, count: m.need, per_kill: opt.per_kill });
      j.kills = Math.max(j.kills, opt.kills);
      farm.set(key, j);
    } else if (opt.kind === 'buy') buy.push({ item: m.item, amount: m.need, at: opt.room, merchant: opt.merchant, cost: opt.cost });
    else if (opt.kind === 'chest') {
      chest.push({ item: m.item, amount: opt.count });
      // The rest of a partial chest draw is BOUGHT, at the cheapest counter.
      if (opt.rest > 0 && opt.restBuy)
        buy.push({ item: m.item, amount: opt.rest, at: opt.restBuy.room, merchant: opt.restBuy.merchant,
                   cost: opt.restBuy.price ? opt.restBuy.price * opt.rest : null });
    }
    else if (opt.kind === 'create') create.push({ item: m.item, amount: m.need });
    else skipped.push(m.item);
  }
  return { farm: [...farm.values()], buy, chest, create, skipped,
           cost: buy.reduce((n, b) => n + (b.cost ?? 0), 0) };
}

/** The ghost raid's own choices (operator, 2026-09-25): knight's shields farmed off the battered
 *  skeletons upstairs in Castle Victoria (room 39); hammers bought or created, never farmed. */
export const GHOST_PLAN = Object.freeze({
  wants: { "knight's shield": 21, 'chain armor': 15 },
  prefer: { "knight's shield": { creature: 'battered skeleton', room: 39 } },
});

/** Pick the option index matching a preference {creature, room}, or null. */
export function preferredIndex(menuEntry, pref) {
  if (!pref) return null;
  const i = menuEntry.options.findIndex(o => (o.kind === 'farm' || o.kind === 'soldiers')
    && lower(o.creature) === lower(pref.creature) && (pref.room == null || o.rooms.some(r => r.num === pref.room)));
  return i >= 0 ? i : null;
}
