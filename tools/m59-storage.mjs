// WHERE THE FLEET PUTS THINGS, AND HOW FULL IT IS.
//
// Four containers, four different rules, and NOT ONE OF THEM IS THE SAME ARITHMETIC:
//
//   | container      | limited by            | ceiling            | scope          |
//   |----------------|-----------------------|--------------------|----------------|
//   | a pack         | weight AND bulk       | 1700 + might*20    | one character  |
//   | a vault        | BULK ONLY             | 3000               | one character  |
//   | a guild chest  | BULK ONLY             | 24000              | the whole hall |
//   | a store box    | BULK ONLY             | 4000               | the hall       |
//
// A PACK IS THE ONLY ONE WITH TWO CEILINGS, and it is full when EITHER is reached — the
// server refuses at `piWeight_hold + weight > GetWeightMax` OR the bulk equivalent
// (holder.kod:259 ReqNewHold -> :281 CanHoldWeightAndBulk). So a pack's fullness is the
// WORSE of the two fractions, never the average and never whichever is prettier. The
// other three declare `viWeight_hold_max = $`, which is nil and means unlimited, so
// weighing them at all would invent a limit the server does not have.
//
// A VAULT IS PER CHARACTER AND A CHEST IS NOT. `Storage.plStored` is a list of per-owner
// boxes and `CanDepositItems` sums `GetCurrentBulkStored(#who=who)` against `piCapacity`
// (storage.kod:28,88-99) — so twenty-one characters have twenty-one separate 3000s in the
// same vault. A chest is an ordinary Holder in a room: one pool, and anything the guild
// puts in comes out of the same 24000.
//
// NOTHING HERE DOES ANY I/O ON THE WIRE. The cache below is disk, exactly like
// `substrate/banks/` and for the same reason: none of these three quantities is pushed by
// the server, so the only record of them is what was seen the last time somebody looked.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { weighPack } from './m59-items.mjs';

// player.kod:737-738 declare both at 1700; :10458 and :10463 add might*20 to each. The
// same formula the planner and `carryCapacity` use — imported rather than restated
// wherever a live client is in hand, and duplicated here only as the pure function of
// might that a page with no client can call.
export const PACK_BASE = 1700;
export const packMax = (might) => PACK_BASE + (Number(might) || 0) * 20;

export const VAULT_BULK_MAX = 3000;      // storage.kod:31, per depositor
export const CHEST_BULK_MAX = 24000;     // chest.kod:29, viWeight_hold_max = $ (unlimited)
export const STOREBOX_BULK_MAX = 4000;   // storebox.kod:33

// The hall this fleet bought. `guildh14.kod:518,520,522` creates exactly three `&Chest`,
// which is why three is what there is to show — but a hall may hold up to four, so the
// board has four slots and says which are empty rather than assuming three for ever.
export const GUILD_CHEST_SLOTS = 4;
export const BOOKMAKERS_HALL_ROOM = 714;
export const BOOKMAKERS_CHESTS = 3;
export const STORAGE_DIR = process.env.M59_STORAGE_DIR || 'substrate/storage';

const pct = (used, max) => (max > 0 ? Math.min(999, Math.round((used / max) * 100)) : null);

/**
 * How full a pack is.
 *
 * Returns both fractions and which one binds, because they are different questions and the
 * answer is routinely different: a pack of feathers is bulk-bound and a pack of plate is
 * weight-bound, and reporting only one of them says there is room when there is not.
 *
 * `exact` is false when any item is missing from the weight table, and then the load is a
 * LOWER BOUND — the same rule `carryCapacity` states. A percentage computed from a lower
 * bound is itself a lower bound, so it is returned with `exact:false` rather than withheld:
 * "at least 80% full" is useful and "unknown" is not, provided nothing reads it as a
 * ceiling.
 */
export function packFullness(items = [], might = null) {
  const load = weighPack(items);
  if (might == null)
    return { known: false, why: 'might has not been read, so the ceiling is unknown',
             weight: load.weight, bulk: load.bulk, exact: load.exact };
  const max = packMax(might);
  const weight_pct = pct(load.weight, max), bulk_pct = pct(load.bulk, max);
  return {
    known: true, max, might,
    weight: load.weight, bulk: load.bulk,
    weight_pct, bulk_pct,
    // The WORSE of the two, because either one full means the pack is full.
    percent: Math.max(weight_pct, bulk_pct),
    binding: bulk_pct > weight_pct ? 'bulk' : 'weight',
    exact: load.exact,
    ...(load.unknown.length ? { unweighed: load.unknown } : {}),
  };
}

/** How full a bulk-only container is. Weight is not consulted: these declare no limit. */
export function bulkFullness(items = [], max = VAULT_BULK_MAX) {
  const load = weighPack(items);
  return { known: true, max, bulk: load.bulk, percent: pct(load.bulk, max),
           binding: 'bulk', exact: load.exact,
           ...(load.unknown.length ? { unweighed: load.unknown } : {}) };
}

export const vaultFullness = (items = []) => bulkFullness(items, VAULT_BULK_MAX);
export const chestFullness = (items = []) => bulkFullness(items, CHEST_BULK_MAX);

const safe = value => String(value ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'unknown';
const readJson = (path) => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};
const writeJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
  return value;
};

/**
 * The last thing anybody saw in a vault, a guild chest, or in front of Frular.
 *
 * All three are the `substrate/banks/` pattern: the server states them once, to one
 * character, and never mentions them again — so a record of the statement is the only
 * thing that can answer later, and every reading carries WHEN and WHO so a stale one can
 * be told from a fresh one. Nothing here is ever presented as current.
 */
// ---------------------------------------------------------------- WHICH CHEST IS WHICH
//
// A GUILD CHEST IS ADDRESSED BY WHERE IT STANDS, NEVER BY ITS OBJECT ID.
//
// An object id is a handle the server hands out and recycles. This repository has measured
// 23% of stored ids naming a different object three days later, so a slot->id cache is a
// slot->something-else cache on a long enough timeline. Prod demonstrated it exactly: three
// chest readings taken thirty days ago, naming a hall the guild no longer owns, and both the
// deposit and the withdraw leg skipping every slot because no recorded id was in the room.
//
// A chest cannot move. `Chest is StorageBox is Holder` sets viObject_flags = CONTAINER_YES
// and declares no GETTABLE flag, so it is GETTABLE_NO (blakston.khd:62): it cannot be picked
// up, and nothing relocates it. The hall builds its chests at fixed squares when it is
// created (guildh14.kod:518-522). So the square IS the chest's durable name -- and it is the
// name a person would use, which is the point.
//
// ORDER IS FOR LEARNING, NEVER FOR ADDRESSING. The id-matching code this replaces carried a
// warning worth keeping: falling back to the order chests appear in the room "would be a
// guess that silently files chest 3's contents into chest 1". So ordering assigns slots ONLY
// from a reading that shows every chest the hall should have; any shorter reading is matched
// against what was already learned, and anything that cannot be placed is skipped and named.
//
// The ordering itself is row-then-column, which is arbitrary but STABLE -- and stability is
// the whole requirement, because the slot number is our own label rather than the game's.
export const BOOKMAKERS_CHEST_SQUARES = Object.freeze([
  { row: 18, col: 2 }, { row: 18, col: 6 }, { row: 20, col: 4 },
]);

export const sameSquare = (a, b) =>
  !!a && !!b && Number(a.row) === Number(b.row) && Number(a.col) === Number(b.col);

/**
 * Map guild-chest slots onto the chests actually standing in this room.
 *
 * @param objects  room objects already filtered to chests: { id, row, col }
 * @param known    what each slot's square is believed to be: [{ slot, row, col }]
 * @param expected how many chests this hall builds (BOOKMAKERS_CHESTS)
 * @returns { slots: Map<slot, object>, learned, unplaced, complete, why }
 */
export function chestSlotsByPosition({ objects = [], known = [], expected = null } = {}) {
  const placed = objects.filter(o => Number.isFinite(Number(o?.row)) && Number.isFinite(Number(o?.col)));
  const slots = new Map();
  const usedIds = new Set();

  // 1. ANYTHING WE ALREADY KNOW THE SQUARE OF WINS, whatever else is in the room. This is
  //    what makes a short read safe: a slot whose chest is visible is still addressable even
  //    when its neighbours are missing from the packet.
  for (const k of known) {
    if (k?.row == null || k?.col == null) continue;
    const hit = placed.find(o => !usedIds.has(o.id) && sameSquare(o, k));
    if (hit) { slots.set(Number(k.slot), hit); usedIds.add(hit.id); }
  }

  // 2. ORDERING ONLY FROM A COMPLETE READING. Assigning by order when a chest is missing is
  //    precisely how slot 3's contents get filed as slot 1.
  const complete = expected == null ? placed.length > 0 : placed.length === Number(expected);
  let learned = 0;
  if (complete && slots.size < placed.length) {
    const ordered = [...placed].sort((a, b) => (a.row - b.row) || (a.col - b.col));
    for (let i = 0; i < ordered.length; i++) {
      const slot = i + 1;
      if (slots.has(slot) || usedIds.has(ordered[i].id)) continue;
      slots.set(slot, ordered[i]);
      usedIds.add(ordered[i].id);
      learned++;
    }
  }

  const unplaced = placed.filter(o => !usedIds.has(o.id)).map(o => ({ id: o.id, row: o.row, col: o.col }));
  return {
    slots, learned, unplaced, complete,
    why: complete
      ? undefined
      : `saw ${placed.length} chest(s) with a position` +
        (expected == null ? '' : ` where the hall builds ${expected}`) +
        ' — slots are matched against known squares only, never assigned by order, because ' +
        'ordering a short reading files one chest\'s contents under another chest\'s slot',
  };
}

export class StorageCache {
  constructor({ dir = STORAGE_DIR, now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.now = now;
  }

  vaultPath(character) { return join(this.dir, 'vaults', `${safe(character)}.json`); }
  chestPath(slot) { return join(this.dir, 'chests', `${Number(slot) || 0}.json`); }
  get rentPath() { return join(this.dir, 'rent.json'); }

  // ---------------------------------------------------------------- vaults
  writeVault(character, items = [], { at = null, account = null } = {}) {
    return writeJson(this.vaultPath(character), {
      character, account: account ?? null,
      items: items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1,
                               ...(i.fee != null ? { fee: Number(i.fee) } : {}) })),
      observed_at: Number(at) || this.now(),
    });
  }

  readVault(character) {
    const v = readJson(this.vaultPath(character));
    if (!v || v.character !== character || !Array.isArray(v.items)) return null;
    return { ...v, fullness: vaultFullness(v.items) };
  }

  allVaults() {
    const dir = join(this.dir, 'vaults');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => readJson(join(dir, f))).filter(v => v && Array.isArray(v.items))
      .map(v => ({ ...v, fullness: vaultFullness(v.items) }));
  }

  // ---------------------------------------------------------------- chests
  //
  // Slots are 1..GUILD_CHEST_SLOTS and are addressed by the chest's OBJECT ID, not by
  // where it stands: two chests in one room are two ids and the room cannot tell them
  // apart. A slot nobody has opened is absent rather than empty, because "nobody looked"
  // and "there is nothing in it" are opposite facts about a guild's stores.
  // `row`/`col` are the DURABLE name — see chestSlotsByPosition. `object_id` is still
  // recorded because it is useful for one visit and for spotting a recycle, but nothing
  // addresses a chest by it any more.
  writeChest(slot, { object_id = null, room = null, items = [], by = null, at = null,
                     row = null, col = null } = {}) {
    const n = Number(slot);
    if (!(n >= 1 && n <= GUILD_CHEST_SLOTS))
      throw new Error(`chest slot must be 1..${GUILD_CHEST_SLOTS}, got ${slot}`);
    return writeJson(this.chestPath(n), { slot: n, object_id, room,
      // THE SQUARE IS WHAT THE NEXT VISIT MATCHES ON. Written as null rather than omitted
      // when unknown, so a reading taken before this field existed is distinguishable from
      // one where the position genuinely could not be read.
      row: row == null ? null : Number(row), col: col == null ? null : Number(col),
      items: items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1 })),
      opened_by: by ?? null, observed_at: Number(at) || this.now() });
  }

  readChest(slot) {
    const c = readJson(this.chestPath(slot));
    if (!c || !Array.isArray(c.items)) return null;
    return { ...c, fullness: chestFullness(c.items) };
  }

  allChests() {
    return Array.from({ length: GUILD_CHEST_SLOTS }, (_, i) => this.readChest(i + 1))
      .map((c, i) => c ?? { slot: i + 1, items: null, observed_at: null, opened_by: null,
                            fullness: null, never_opened: true });
  }

  // ------------------------------------------------------------------ rent
  //
  // `parseRentLine` already owns the sign convention — POSITIVE IS OWED, negative is
  // credit — and this only stores what it returned. The unparsed case is deliberately
  // storable as null rather than zero: a sentence nobody recognised and a guild that owes
  // nothing must not render the same, because one of them is a hall about to be lost.
  writeRent({ due = null, credit = null, in_guild = null, hours_left = null, said = null,
              guild = null, by = null, at = null } = {}) {
    return writeJson(this.rentPath, { due: due == null ? null : Number(due),
      credit: credit == null ? null : Number(credit),
      in_guild: in_guild == null ? null : !!in_guild,
      hours_left: hours_left == null ? null : Number(hours_left),
      said, guild: guild ?? null, asked_by: by ?? null,
      observed_at: Number(at) || this.now() });
  }

  readRent() { return readJson(this.rentPath); }
}
