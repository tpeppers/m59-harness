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
// ---------------------------------------------------------------- WHAT A CHEST IS CALLED
//
// A CHEST IS ITS SQUARE. That is the whole scheme, and everything else here follows from it.
//
// The obvious design is a slot number with a square recorded beside it, and it is wrong in a
// way that takes a while to see: a number implies a MAPPING, a mapping has to be learned, a
// reading can be too short to learn it, so you need an ordering rule to learn from, and an
// ordering rule applied to a short reading files one chest's contents under another chest's
// name. Every one of those steps exists to protect a number that carries no information.
//
// So there is no number. A chest observed at row 18, column 6 is called `r18c6`, read off the
// object itself on every visit. Nothing to learn, nothing to get out of order, nothing to
// mis-file, and a short reading is just a reading of fewer chests.
//
// It is also how a person refers to one -- "the chest in the north-west corner" -- which is
// the operator's argument and the better one.
//
// A chest cannot move, which is what makes the square a name rather than a position:
// `Chest is StorageBox is Holder` sets viObject_flags = CONTAINER_YES and declares no
// GETTABLE flag, so it is GETTABLE_NO (blakston.khd:62). It cannot be picked up and nothing
// in the hall relocates it.
export const chestKey = (o) => {
  const row = Number(o?.row), col = Number(o?.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || col < 0) return null;
  return `r${row}c${col}`;
};

export function parseChestKey(key) {
  const m = /^r(\d+)c(\d+)$/.exec(String(key ?? ''));
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

// The squares the Bookmaker's hall builds its chests on (guildh14.kod:518-522). Nothing
// MATCHES against this -- the key always comes off the object that was actually seen -- it is
// here so a plan can be written before anybody has walked to the hall, and so a reader can
// tell at a glance which hall a key belongs to.
export const BOOKMAKERS_CHEST_SQUARES = Object.freeze(['r18c2', 'r18c6', 'r20c4']);

export class StorageCache {
  constructor({ dir = STORAGE_DIR, now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.now = now;
  }

  vaultPath(character) { return join(this.dir, 'vaults', `${safe(character)}.json`); }
  chestPath(key) { return join(this.dir, 'chests', `${String(key)}.json`); }
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
  // KEYED ON THE SQUARE. `object_id` is still recorded — it is useful within a single visit
  // and it is how a recycled id gets noticed — but nothing addresses a chest by it.
  writeChest(where, { object_id = null, room = null, items = [], by = null, at = null } = {}) {
    const key = typeof where === 'string' ? where : chestKey(where);
    const at2 = parseChestKey(key);
    if (!at2)
      throw new Error(`a chest is named by its square, like "r18c6" — got ${JSON.stringify(where)}`);
    return writeJson(this.chestPath(key), { slot: key, row: at2.row, col: at2.col,
      object_id, room,
      items: items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1 })),
      opened_by: by ?? null, observed_at: Number(at) || this.now() });
  }

  readChest(where) {
    const key = typeof where === 'string' ? where : chestKey(where);
    if (!parseChestKey(key)) return null;
    const v = readJson(this.chestPath(key));
    return v ? { ...v, fullness: chestFullness(v.items ?? []) } : null;
  }

  // EVERY CHEST ANYONE HAS LOOKED IN, which is not the same as every chest that exists.
  //
  // This used to synthesise a fixed 1..4 and mark the gaps `never_opened`, because the slots
  // were an index. Squares are not an index: there is no list of every square a chest could
  // be on, and inventing one would be inventing chests. So this reports what has actually
  // been seen, and "we have never looked in the hall" is the empty list — which
  // `guildStoreAvailable` already treats as "no evidence of a hall to fill".
  allChests() {
    let names = [];
    try { names = readdirSync(join(this.dir, 'chests')); } catch { return []; }
    return names
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      // A file that is not named after a square is not a chest reading. The numeric ones
      // this scheme replaced are exactly that, and they are skipped rather than parsed --
      // they named a hall the guild no longer owns.
      .filter(k => !!parseChestKey(k))
      .map(k => this.readChest(k))
      .filter(Boolean)
      .sort((a, b) => (a.row - b.row) || (a.col - b.col));
  }

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
