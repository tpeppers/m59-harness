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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { weighPack } from './m59-items.mjs';
import { chestDiff } from './m59-chest-eviction.mjs';
import { VAULTS } from './m59-vaults.mjs';

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

// EVERY GUILD HALL ON THE SERVER, BY ROOM NUMBER. A ROSTER MAY HOLD MORE THAN ONE GUILD, AND EACH
// GUILD MAY HOLD ONE OF THESE.
//
// `RID_GUILDH1..15` (blakston.khd) and each hall's own `room_name_*` and `viFoyer_*`
// (kod/object/active/holder/room/ghall/guildhN.kod). The room number is the hall's durable name:
// the map's number, which no save renumbers. A hall's object id is a handle and recycles.
//
// THIS IS WHAT LETS A CHEST READING SAY WHICH HALL IT CAME FROM. A chest is named by its square
// ("r18c6"), and squares are only unique WITHIN a room. With one hall that was enough; with two,
// "r18c6" names a chest in each of them, and a reading filed under the bare square would land in
// whichever hall's books happened to be open. So a reading is filed under the hall it was TAKEN
// IN -- the room the reader was standing in -- never under the reader's own guild. A member of one
// guild using an ally's chests updates the ally's books, because that is whose chest changed.
//
// `foyer` is the InFoyer box (ghall.kod:896), where the hall password is refused in silence;
// null where the hall declares none. Only 714's passage (m59-guild-passage.mjs) is surveyed.
export const GUILD_HALL_ROOMS = Object.freeze({
  701: { name: 'Mercenary Alley', foyer: { north: 16, south: 21, west: 11, east: 19 } },
  702: { name: 'The Hall of Explorers', foyer: { north: 16, south: 20, west: 30, east: 34 } },
  703: { name: 'The Den of Shadows', foyer: { north: 1, south: 8, west: 1, east: 7 } },
  704: { name: "The Wryn's Keep", foyer: { north: 44, south: 51, west: 21, east: 29 } },
  705: { name: "West Tower Guild Hall in Ko'catan", foyer: { north: 27, south: 48, west: 0, east: 27 } },
  706: { name: 'The Old Dwarven Hall', foyer: null },
  707: { name: 'Guild hall 707 (guildh5)', foyer: { north: 25, south: 33, west: 13, east: 23 } },
  708: { name: 'The Sewer Hideout', foyer: null },
  709: { name: 'The Abandoned Warehouse', foyer: { north: 5, south: 11, west: 15, east: 24 } },
  710: { name: 'Guild hall 710 (guildh10)', foyer: { north: 25, south: 33, west: 13, east: 23 } },
  711: { name: 'The Ivory Chapel', foyer: { north: 9, south: 15, west: 3, east: 12 } },
  712: { name: 'The home of the Friends of the Forest', foyer: { north: 2, south: 7, west: 11, east: 20 } },
  713: { name: 'The Hall of the Slaughtered Command', foyer: { north: 1, south: 13, west: 1, east: 7 } },
  714: { name: "The Bookmaker's Guild House", foyer: { north: 2, south: 3, west: 26, east: 39 } },
  715: { name: "Inner Sanctum of Queen Venya'cyr", foyer: { north: 0, south: 27, west: 0, east: 31 } },
});
export const isGuildHallRoom = (room) =>
  Number.isInteger(Number(room)) && Object.prototype.hasOwnProperty.call(GUILD_HALL_ROOMS, Number(room));
export const hallName = (room) => GUILD_HALL_ROOMS[Number(room)]?.name ?? (room == null ? null : `room ${room}`);

// THE FLAT LAYOUT IS HALL 714'S. Until the roster could hold a second guild every chest reading was
// the Bookmaker's, and was filed as `chests/<square>.json` with a `room` field that was often the
// room's OBJECT ID (2569 on prod) rather than its number. So a flat file is read as 714 whatever its
// `room` says, and 714 keeps writing there -- every reader of that layout keeps working and the
// history files stay continuous. Any other hall files under `chests/<room>/`.
export const LEGACY_CHEST_HALL = BOOKMAKERS_HALL_ROOM;

// FRULAR NAMES THE GUILD IN HIS RENT ANSWER: "The The Second Swines owes 6547 coins in rent" --
// `The %s` with the guild's own name, which may itself begin with "The". That is the one rent fact
// that does not depend on who asked, so it is what a rent reading is filed under.
export function rentGuildName(said) {
  const m = /\bThe (.+?) (?:owes \d+ coins?|has a positive balance|owes no rent)/i.exec(String(said ?? ''));
  return m ? m[1].trim() : null;
}

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

// ---------------------------------------------------------------- WHICH VAULT A READING IS OF
//
// TWO VAULTS, AND EACH IS ITS OWN 3000. Obert Cair'bre (114) and Itzal cha'Nosak (2005) each
// hold a separate `Storage` object (`FindVaultByNum`, monster.kod:3219), so a character's
// mainland things and island things are two lists, two ceilings, and two readings taken on two
// different days. The per-character file's top-level `items` is "the last vault read", and the
// first island reading on prod (Kermit, 2026-10-31) replaced his mainland one there.
//
// A reading is placed by the best evidence it carries, in this order:
//   'room'      `by_room` / `room` — written by every reader since 7d0cd7fb (2026-10-29).
//   'vaultman'  a `vault-latest` snapshot of the same instant, which names the vaultman.
//   'inferred'  an untagged reading taken BEFORE f766246d: until then every reader matched
//               /obert cair|vaultman/, which Itzal cha'Nosak does not, so it is the mainland's
//               by construction. The page says "inferred", never "observed".
//   'snapshot'  a `vault-latest` snapshot on its own (written by the keeper's vault run).
// The newest reading of each vault wins. An untagged reading after f766246d with nothing
// naming its vaultman is UNPLACED: shown as such, never guessed into either vault.
export const ISLAND_VAULT_READABLE_SINCE = Date.parse('2026-10-27T03:23:03Z'); // f766246d
const SAME_INSTANT_MS = 5000;

const squash = s => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
/** The vault whose vaultman this text names ("Obert Cair'bre (id 780) [buy/offer]"), or null. */
export function vaultNamed(text) {
  const t = squash(text && typeof text === 'object' ? text.name : text);
  return t ? VAULTS.find(v => t.includes(squash(v.npc))) ?? null : null;
}

const sameItems = (a, b) => a.length === b.length &&
  a.every((x, i) => x.name === b[i]?.name && Number(x.amount) === Number(b[i]?.amount));

/**
 * Every vault, with this character's newest reading of each.
 *
 * `record` is the raw `storage/vaults/<character>.json` (or null); `snapshots` are
 * `vault-latest` rows for any character (filtered here). Returns
 * `{ vaults: [{ room, npc, where, reading }], unplaced }`, where a reading is
 * `{ items, observed_at, fullness, source }`. `reading: null` means nobody has looked —
 * not that the vault is empty.
 */
export function vaultReadings(record, { snapshots = [], character = record?.character } = {}) {
  const best = new Map();                 // room -> reading
  const offer = (room, items, at, source) => {
    if (!(Number(room) > 0) || !Array.isArray(items)) return;
    const prev = best.get(Number(room));
    if (prev && (prev.observed_at ?? 0) >= (Number(at) || 0)) return;
    best.set(Number(room), { items, observed_at: Number(at) || null, source,
                             fullness: vaultFullness(items) });
  };
  const mine = (snapshots ?? []).filter(s => s && s.character === character && Array.isArray(s.items));
  for (const s of mine) {
    const v = vaultNamed(s.vaultman);
    if (v) offer(v.room, s.items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1 })),
                 s.at, 'snapshot');
  }
  let unplaced = null;
  if (record && Array.isArray(record.items)) {
    // Offered after the snapshots so that, at the same instant, the richer record (fees) wins the tie.
    const offerFirst = (room, items, at, source) => {
      const prev = best.get(Number(room));
      if (prev && prev.source === 'snapshot' && (prev.observed_at ?? 0) <= (Number(at) || 0) + SAME_INSTANT_MS)
        best.delete(Number(room));
      offer(room, items, at, source);
    };
    for (const [room, r] of Object.entries(record.by_room ?? {}))
      offerFirst(room, r?.items, r?.observed_at, 'room');
    const at = Number(record.observed_at) || 0;
    if (Number(record.room) > 0) offerFirst(record.room, record.items, at, 'room');
    else {
      const twin = mine.find(s => Math.abs((Number(s.at) || 0) - at) <= SAME_INSTANT_MS && vaultNamed(s.vaultman));
      if (twin) offerFirst(vaultNamed(twin.vaultman).room, record.items, at, 'vaultman');
      else if (at && at < ISLAND_VAULT_READABLE_SINCE) offerFirst(VAULTS[0].room, record.items, at, 'inferred');
      else if (![...best.values()].some(r => sameItems(r.items, record.items)))
        unplaced = { items: record.items, observed_at: at || null, source: 'unplaced',
                     fullness: vaultFullness(record.items) };
    }
  }
  return { vaults: VAULTS.map(v => ({ ...v, reading: best.get(v.room) ?? null })), unplaced };
}

export const sameGuild = (a, b) => a != null && b != null &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
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
// HOW CLOSE A TAKE HAS TO BE. UserGet (kod user.kod) refuses a get whose item is more than 7
// squares away, row distance plus column distance, with a sentence and nothing on the wire; an
// item in a chest is where the chest is. A put has no such check. So a withdrawal walks within
// STOCKPILE_WALK_WITHIN first, the same 5 the armour and stash paths use, and refuses to ask from
// beyond STOCKPILE_GET_REACH rather than reading the refusal as an empty chest.
export const STOCKPILE_GET_REACH = 7;
export const STOCKPILE_WALK_WITHIN = 5;

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
  // 714 is the flat layout (LEGACY_CHEST_HALL); every other hall has a directory of its own.
  chestDir(room = LEGACY_CHEST_HALL) {
    const r = room == null ? LEGACY_CHEST_HALL : Number(room);
    return r === LEGACY_CHEST_HALL ? join(this.dir, 'chests') : join(this.dir, 'chests', String(r));
  }
  chestPath(key, room = LEGACY_CHEST_HALL) { return join(this.chestDir(room), `${String(key)}.json`); }
  // RENT IS PER GUILD. `rent.json` is the reading from before a roster could hold two guilds (or one
  // whose guild could not be named); a named guild has `rent/<guild>.json`.
  get rentPath() { return join(this.dir, 'rent.json'); }
  rentPathFor(guild) { return guild ? join(this.dir, 'rent', `${safe(String(guild).toLowerCase())}.json`) : this.rentPath; }

  // ---------------------------------------------------------------- vaults
  // EACH TOWN'S VAULT IS ITS OWN, so the room it was read in is part of the reading. `items` stays the LAST vault read
  // (what every board already shows); `by_room` keeps one entry per vault room, so a character with things in Tos and
  // in Ko'catan keeps both, and a muster can ask "what is within three rooms of here" (m59-preflight.mjs). A reading
  // with no room (a caller that does not know it) leaves `by_room` as it was.
  writeVault(character, items = [], { at = null, account = null, room = null } = {}) {
    const rows = items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1,
                                   ...(i.fee != null ? { fee: Number(i.fee) } : {}) }));
    const when = Number(at) || this.now();
    const prev = readJson(this.vaultPath(character));
    const byRoom = { ...(prev?.character === character ? prev.by_room ?? {} : {}) };
    if (Number(room) > 0) byRoom[Number(room)] = { items: rows, observed_at: when };
    return writeJson(this.vaultPath(character), {
      character, account: account ?? null, items: rows, observed_at: when,
      ...(Number(room) > 0 ? { room: Number(room) } : {}),
      ...(Object.keys(byRoom).length ? { by_room: byRoom } : {}),
    });
  }

  readVault(character) {
    const v = readJson(this.vaultPath(character));
    if (!v || v.character !== character || !Array.isArray(v.items)) return null;
    return { ...v, fullness: vaultFullness(v.items) };
  }

  /** Both vaults for one character — see `vaultReadings`. Never null: an unread vault is `reading: null`. */
  readVaults(character, { snapshots = [] } = {}) {
    const v = readJson(this.vaultPath(character));
    return vaultReadings(v && v.character === character ? v : null, { snapshots, character });
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
  //
  // AND FILED UNDER ITS HALL. `room` is REQUIRED and must be a guild hall's room NUMBER: with more
  // than one guild in the roster a square names a chest in each hall, and a reading with no hall is
  // a reading that will be filed under the wrong one. The old fallback to the room's object id (2569
  // for 714 on prod) is refused rather than guessed at.
  writeChest(where, { object_id = null, room = null, items = [], by = null, at = null } = {}) {
    const key = typeof where === 'string' ? where : chestKey(where);
    const at2 = parseChestKey(key);
    if (!at2)
      throw new Error(`a chest is named by its square, like "r18c6" — got ${JSON.stringify(where)}`);
    if (!isGuildHallRoom(room))
      throw new Error(`a chest reading needs the guild hall's ROOM NUMBER (701-715) to say whose chest it is — ` +
                      `got ${JSON.stringify(room)}; an object id is a handle, not a hall`);
    room = Number(room);
    const prev = readJson(this.chestPath(key, room));
    const next = writeJson(this.chestPath(key, room), { slot: key, row: at2.row, col: at2.col,
      object_id, room,
      items: items.map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1 })),
      opened_by: by ?? null, observed_at: Number(at) || this.now() });
    // THE READING OVERWRITES, SO THE DIFFERENCE IS RECORDED HERE OR NOWHERE. What left the chest
    // between two readings is the only history a chest can have (see m59-chest-eviction.mjs), and
    // it exists only at this moment. A failed append must never fail the reading it follows.
    try {
      const d = chestDiff(prev, next);
      if (d && (d.left.length || d.arrived.length)) {
        const path = this.chestHistoryPath(key, room);
        mkdirSync(join(path, '..'), { recursive: true });
        appendFileSync(path, JSON.stringify({ slot: key, room: next.room,
          prev_at: prev.observed_at ?? null, at: next.observed_at, by: next.opened_by,
          left: d.left, arrived: d.arrived }) + '\n');
      }
    } catch { /* the reading is what matters */ }
    return next;
  }

  // Beside the readings, NOT among them: `allChests` takes every `*.json` in chests/ for a chest.
  chestHistoryPath(key, room = LEGACY_CHEST_HALL) {
    const r = room == null ? LEGACY_CHEST_HALL : Number(room);
    return r === LEGACY_CHEST_HALL ? join(this.dir, 'chest-history', `${String(key)}.jsonl`)
                                   : join(this.dir, 'chest-history', String(r), `${String(key)}.jsonl`);
  }

  /** The last `limit` changes seen in one chest, newest first. Missing file is an empty list. */
  readChestHistory(where, { limit = 20, room = LEGACY_CHEST_HALL } = {}) {
    const key = typeof where === 'string' ? where : chestKey(where);
    if (!parseChestKey(key)) return [];
    let text = '';
    try { text = readFileSync(this.chestHistoryPath(key, room), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { continue; }
      if (out.length >= limit) break;
    }
    return out;
  }

  readChest(where, room = LEGACY_CHEST_HALL) {
    const key = typeof where === 'string' ? where : chestKey(where);
    if (!parseChestKey(key)) return null;
    const hall = room == null ? LEGACY_CHEST_HALL : Number(room);
    const v = readJson(this.chestPath(key, hall));
    // A flat file's own `room` may be an object id (see LEGACY_CHEST_HALL); the directory says which hall.
    return v ? { ...v, room: hall, chest_id: `${hall}/${key}`, fullness: chestFullness(v.items ?? []) } : null;
  }

  /** The hall rooms anybody has filed a chest reading under. */
  chestHalls() {
    let names = [];
    try { names = readdirSync(join(this.dir, 'chests'), { withFileTypes: true }); } catch { return []; }
    const halls = new Set();
    for (const d of names) {
      if (d.isDirectory() && isGuildHallRoom(d.name) && Number(d.name) !== LEGACY_CHEST_HALL) halls.add(Number(d.name));
      else if (d.isFile() && d.name.endsWith('.json') && parseChestKey(d.name.slice(0, -5))) halls.add(LEGACY_CHEST_HALL);
    }
    return [...halls].sort((a, b) => a - b);
  }

  // EVERY CHEST ANYONE HAS LOOKED IN, which is not the same as every chest that exists.
  //
  // This used to synthesise a fixed 1..4 and mark the gaps `never_opened`, because the slots
  // were an index. Squares are not an index: there is no list of every square a chest could
  // be on, and inventing one would be inventing chests. So this reports what has actually
  // been seen, and "we have never looked in the hall" is the empty list — which
  // `guildStoreAvailable` already treats as "no evidence of a hall to fill".
  //
  // EVERY HALL, unless `room` names one. Each row carries `room` (the hall it was read in) and
  // `chest_id` ("714/r18c6"), because `slot` alone is no longer unique once there are two halls.
  // A caller deciding anything about ONE guild's stores must pass that guild's hall: the
  // unfiltered list is for boards that show every hall side by side.
  allChests({ room = null } = {}) {
    const halls = room == null ? this.chestHalls() : [Number(room)];
    const out = [];
    for (const hall of halls) {
      let names = [];
      try { names = readdirSync(this.chestDir(hall)); } catch { continue; }
      out.push(...names
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        // A file that is not named after a square is not a chest reading. The numeric ones
        // this scheme replaced are exactly that, and they are skipped rather than parsed --
        // they named a hall the guild no longer owns.
        .filter(k => !!parseChestKey(k))
        .map(k => this.readChest(k, hall))
        .filter(Boolean));
    }
    return out.sort((a, b) => (a.room - b.room) || (a.row - b.row) || (a.col - b.col));
  }

  // FILED UNDER THE GUILD FRULAR NAMED. The asker's guild is the fallback, never the first choice:
  // what Frular says is what the server's books say, whoever happened to ask.
  writeRent({ due = null, credit = null, in_guild = null, hours_left = null, said = null,
              guild = null, by = null, at = null } = {}) {
    guild = rentGuildName(said) ?? guild ?? null;
    return writeJson(this.rentPathFor(in_guild === false ? null : guild), { due: due == null ? null : Number(due),
      credit: credit == null ? null : Number(credit),
      in_guild: in_guild == null ? null : !!in_guild,
      hours_left: hours_left == null ? null : Number(hours_left),
      said, guild: guild ?? null, asked_by: by ?? null,
      observed_at: Number(at) || this.now() });
  }

  // `readRent(guild)` is that guild's reading. The pre-split `rent.json` still answers for a guild it
  // NAMES (its `guild` field, or the guild Frular named in `said`) -- and for nobody else, because a
  // second guild reading the first guild's balance as its own is exactly the mix-up this prevents.
  // With no guild, the newest reading of any guild: that is the old single-guild behaviour, and is
  // only right while the roster holds one guild.
  readRent(guild = null) {
    if (guild) {
      const own = readJson(this.rentPathFor(guild));
      if (own) return own;
      const legacy = readJson(this.rentPath);
      const named = legacy ? (legacy.guild ?? rentGuildName(legacy.said)) : null;
      return named && sameGuild(named, guild) ? { ...legacy, guild: named } : null;
    }
    const all = this.allRents();
    return all.sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0))[0] ?? null;
  }

  /** Every guild's last rent reading, one per guild (the legacy file only for a guild nothing newer names). */
  allRents() {
    const out = [];
    try {
      for (const f of readdirSync(join(this.dir, 'rent')).filter(f => f.endsWith('.json'))) {
        const r = readJson(join(this.dir, 'rent', f));
        if (r) out.push({ ...r, guild: r.guild ?? rentGuildName(r.said) });
      }
    } catch { /* no per-guild readings yet */ }
    const legacy = readJson(this.rentPath);
    if (legacy) {
      const named = legacy.guild ?? rentGuildName(legacy.said);
      if (!out.some(r => named && sameGuild(r.guild, named))) out.push({ ...legacy, guild: named, legacy: true });
    }
    return out;
  }
}
