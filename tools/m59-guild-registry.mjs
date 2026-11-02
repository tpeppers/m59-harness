#!/usr/bin/env node
// WHICH GUILD IS WHOSE: members, halls and allies, for a roster that holds more than one guild.
//
//   node tools/m59-guild-registry.mjs                          every guild, its hall, its members
//   node tools/m59-guild-registry.mjs --json
//   node tools/m59-guild-registry.mjs hall --room 714 --guild "The Second Swines"   say who owns a hall
//   node tools/m59-guild-registry.mjs ally --guild "A" --guild "B"                    say two guilds are allied
//   node tools/m59-guild-registry.mjs --root C:/code/m59-lab/prod-deploy              whose substrate to read
//
// Until 2026-11-01 everything here was implicitly ONE guild: one rent reading, one hall (714), one
// set of chests, one plan. The roster can now hold several guilds (two at first, up to four), each
// with its own hall, rent and chests -- and allied, so a member of one walks into the other's hall
// and moves things in and out of ITS chests. Three rules follow, and every caller obeys them:
//
//   1. A CHEST BELONGS TO THE HALL IT STANDS IN, never to the reader's guild. A reading is filed
//      under the room it was taken in (m59-storage.mjs `writeChest` refuses one with no hall room),
//      and this file says which guild that room belongs to.
//   2. RENT BELONGS TO THE GUILD FRULAR NAMED in his answer, not to whoever asked (m59-storage.mjs
//      `rentGuildName`).
//   3. A CHARACTER'S GUILD IS WHAT ITS OWN UC_GUILDINFO SAID, and every roster names every member,
//      so one read files the whole guild. Nothing volunteers membership at login, so the session
//      asks once (m59-game.mjs) and the reply lands here.
//
// WHERE IT LIVES. Beside the chest readings, in the broker root's `substrate/storage/`:
//
//   guilds/<guild>.json   one roster per guild, written whole from one UC_GUILDINFO. Whole files
//                         rather than a shared map, because twenty-odd keeper processes write here
//                         and the newest roster of a guild is simply the truth about it -- nothing
//                         to merge, so no read-modify-write race can lose a member.
//   guild-halls.json      hall room -> owning guild, and alliances. Written rarely (a chalice
//                         landing, the operator, the one-time adoption below).
//
// HOW A HALL'S OWNER IS LEARNED, strongest first:
//   - the operator says so (`hall --room --guild`);
//   - a CHALICE (or Rescue) LANDING: Rescue teleports to `Send(who,@GetGuild)`'s hall
//     (rescue.kod:125-136), so a guilded rider landing in a hall room is the server naming its hall;
//   - ADOPTION: a roster that has only ever seen one guild, with readings on disk in the flat
//     (714) chest layout, gives 714 to that guild -- that is what those readings always meant.
//
// THE GUILDINFO PASSWORD IS NEVER STORED HERE. The roster carries it to a guild's master
// (user.kod:1983); this file drops it. Hall passwords live in the fleet's secrets sidecar, keyed by
// hall room (m59-hallsecret.mjs).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STORAGE_DIR, LEGACY_CHEST_HALL, GUILD_HALL_ROOMS, isGuildHallRoom, hallName, sameGuild, StorageCache,
         rentGuildName } from './m59-storage.mjs';

export { isGuildHallRoom, hallName, sameGuild, GUILD_HALL_ROOMS };

const slug = name => String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
const readJson = path => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
const writeJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
  return value;
};
const lc = s => String(s ?? '').trim().toLowerCase();

export class GuildRegistry {
  constructor({ dir = STORAGE_DIR, now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.now = now;
  }

  get guildsDir() { return join(this.dir, 'guilds'); }
  guildPath(name) { return join(this.guildsDir, `${slug(name)}.json`); }
  get hallsPath() { return join(this.dir, 'guild-halls.json'); }

  // ------------------------------------------------------------------ rosters
  /**
   * File one UC_GUILDINFO answer (client.guild). Returns the stored roster, or null for a shape
   * that names no guild. `by` is the character that asked; it is a member by construction.
   */
  recordRoster(guild, { by = null, at = null } = {}) {
    if (!guild?.name) return null;
    const when = Number(at) || this.now();
    const prev = readJson(this.guildPath(guild.name));
    const members = (guild.members ?? []).filter(m => m?.name).map(m => ({ name: String(m.name), rank: m.rank ?? null }));
    if (by && !members.some(m => lc(m.name) === lc(by))) members.push({ name: String(by), rank: guild.rank ?? null });
    const out = writeJson(this.guildPath(guild.name), {
      name: String(guild.name), id: guild.id ?? null,           // the id is a handle: recorded, never matched on
      members, observed_at: when, by: by ?? null,
      // Allies come from UC_GUILD_LIST, not GUILDINFO; a roster read must not erase them.
      ...(prev?.allies ? { allies: prev.allies, allies_at: prev.allies_at ?? null } : {}),
    });
    this.adoptLegacyHall();
    return out;
  }

  /**
   * File the alliance half of a UC_GUILD_LIST, read by a member of `guildName`. The list's allies are
   * ids; `guilds` maps them to names. Mutual alliances only -- `declared_allies` is one-sided.
   */
  recordAllies(guildName, list, { at = null } = {}) {
    if (!guildName || !list) return null;
    const names = new Map((list.guilds ?? []).map(g => [g.id, g.name]));
    const allies = (list.allies ?? []).map(id => names.get(id)).filter(Boolean);
    const prev = readJson(this.guildPath(guildName)) ?? { name: guildName, members: [] };
    return writeJson(this.guildPath(guildName), { ...prev, allies, allies_at: Number(at) || this.now() });
  }

  /** Every guild anybody in the roster has read a roster of, newest reading first. */
  guilds() {
    let files = [];
    try { files = readdirSync(this.guildsDir).filter(f => f.endsWith('.json')); } catch { return []; }
    const halls = this.halls();
    return files.map(f => readJson(join(this.guildsDir, f))).filter(g => g?.name)
      .map(g => {
        const hall = halls.find(h => sameGuild(h.guild, g.name)) ?? null;
        return { ...g, hall_room: hall?.room ?? null, hall_name: hall ? hallName(hall.room) : null,
                 hall_source: hall?.source ?? null, allies: this.alliesOf(g.name, g) };
      })
      .sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0));
  }

  guild(name) { return this.guilds().find(g => sameGuild(g.name, name)) ?? null; }

  /**
   * The guild a character belongs to, from the NEWEST roster that lists it. A character that moved
   * guild appears in the old roster until somebody reads that guild again; the newer reading wins.
   */
  guildOf(character) {
    if (!character) return null;
    let best = null;
    for (const g of this.guilds()) {
      const m = (g.members ?? []).find(x => lc(x.name) === lc(character));
      if (m && (!best || (g.observed_at ?? 0) > (best.observed_at ?? 0)))
        best = { name: g.name, rank: m.rank ?? null, observed_at: g.observed_at ?? null, hall_room: g.hall_room };
    }
    return best;
  }

  /** { character -> guild name } for every member of every known guild. */
  membership() {
    const out = {};
    for (const g of [...this.guilds()].reverse())        // oldest first, so the newest roster wins
      for (const m of g.members ?? []) out[m.name] = g.name;
    return out;
  }

  // ------------------------------------------------------------------ halls
  readHalls() { return readJson(this.hallsPath) ?? { halls: {}, alliances: [] }; }

  /** [{room, guild, source, observed_at, name}] */
  halls() {
    const h = this.readHalls().halls ?? {};
    return Object.entries(h).map(([room, v]) => ({ room: Number(room), guild: v.guild, source: v.source ?? null,
      observed_at: v.observed_at ?? null, name: hallName(room) }));
  }

  /**
   * Say who owns a hall. A hall has one owner, so this also takes it away from any other guild; and a
   * guild has one hall (guild.kod keeps one `poGuild_hall`), so it takes any other hall away from it.
   */
  recordHall(room, guild, { source = 'operator', at = null } = {}) {
    if (!isGuildHallRoom(room)) throw new Error(`${room} is not a guild hall room (701-715)`);
    if (!guild) throw new Error('recordHall needs the owning guild\'s name');
    const data = this.readHalls();
    const halls = { ...(data.halls ?? {}) };
    for (const [r, v] of Object.entries(halls)) if (sameGuild(v.guild, guild) && Number(r) !== Number(room)) delete halls[r];
    halls[Number(room)] = { guild: String(guild), source, observed_at: Number(at) || this.now() };
    return writeJson(this.hallsPath, { ...data, halls });
  }

  hallOf(guild) {
    if (!guild) return null;
    return this.halls().find(h => sameGuild(h.guild, guild))?.room ?? null;
  }

  ownerOfHall(room) {
    return this.halls().find(h => h.room === Number(room))?.guild ?? null;
  }

  // THE ONE-TIME ADOPTION. Before the roster could hold two guilds, every chest reading on disk was
  // the Bookmaker's (714) and belonged to the one guild there was. Once a second guild shows up that
  // inference is gone for good, so it is written down while it is still true: the first time exactly
  // one guild is known, no hall is mapped, and flat (714) readings exist.
  //
  // LOGIN ORDER MUST NOT DECIDE IT. If the roster already holds two guilds when this code first runs,
  // whichever member logs in first files its guild first -- and "the only guild seen" would hand 714 to
  // whoever won that race. So the pre-split rent reading decides when it can: Frular named the guild
  // that has been paying for this hall ("The The Second Swines has a positive balance…"), and only THAT
  // guild adopts 714. The sole-guild rule is the fallback for a cache with no named rent reading.
  adoptLegacyHall() {
    try {
      const data = this.readHalls();
      if (Object.keys(data.halls ?? {}).length) return null;
      let files = [];
      try { files = readdirSync(this.guildsDir).filter(f => f.endsWith('.json')); } catch { return null; }
      const known = files.map(f => readJson(join(this.guildsDir, f))).filter(g => g?.name);
      const store = new StorageCache({ dir: this.dir });
      if (!known.length || !store.chestHalls().includes(LEGACY_CHEST_HALL)) return null;
      const legacyRent = readJson(store.rentPath);
      const payer = legacyRent ? (legacyRent.guild ?? rentGuildName(legacyRent.said)) : null;
      if (payer) {
        const g = known.find(x => sameGuild(x.name, payer));
        return g ? this.recordHall(LEGACY_CHEST_HALL, g.name,
          { source: 'adopted: the guild the pre-split rent reading names, and the flat chest readings were always hall 714' }) : null;
      }
      if (known.length !== 1) return null;
      return this.recordHall(LEGACY_CHEST_HALL, known[0].name,
        { source: 'adopted: the only guild seen, and the flat chest readings were always hall 714' });
    } catch { return null; }
  }

  // ------------------------------------------------------------------ alliances
  /** Declare two guilds allied (operator), in addition to whatever UC_GUILD_LIST reported. */
  recordAlliance(a, b) {
    if (!a || !b || sameGuild(a, b)) throw new Error('an alliance needs two different guilds');
    const data = this.readHalls();
    const alliances = (data.alliances ?? []).filter(p => !(p.some(x => sameGuild(x, a)) && p.some(x => sameGuild(x, b))));
    alliances.push([String(a), String(b)]);
    return writeJson(this.hallsPath, { ...data, alliances });
  }

  alliesOf(name, rec = null) {
    const out = new Set();
    const g = rec ?? readJson(this.guildPath(name));
    for (const a of g?.allies ?? []) out.add(a);
    for (const pair of this.readHalls().alliances ?? []) {
      if (sameGuild(pair[0], name)) out.add(pair[1]);
      if (sameGuild(pair[1], name)) out.add(pair[0]);
    }
    return [...out];
  }

  allied(a, b) { return !!a && !!b && (sameGuild(a, b) || this.alliesOf(a).some(x => sameGuild(x, b))); }

  // ------------------------------------------------------------------ the question every caller asks
  /**
   * Everything about where a character's guild stuff lives. `here` is the room it is standing in.
   *
   *   guild        its guild's name, or null
   *   rank         its rank in that guild, from the newest roster
   *   own_hall     its guild's hall room, or null
   *   here_hall    `here` when that is a guild hall room, else null
   *   here_owner   the guild that owns `here_hall`, or null when unknown
   *   may_use_here whether CanEnter would admit it (member or ally at rank >= SIR, ghall.kod:1039),
   *                null when the owner is unknown
   */
  contextFor(character, { here = null, guild = null, rank = null } = {}) {
    const mine = guild ? { name: guild, rank } : this.guildOf(character);
    const name = mine?.name ?? null;
    const myRank = rank ?? mine?.rank ?? null;
    const hereHall = isGuildHallRoom(here) ? Number(here) : null;
    const hereOwner = hereHall ? this.ownerOfHall(hereHall) : null;
    return {
      character: character ?? null, guild: name, rank: myRank,
      own_hall: name ? this.hallOf(name) : null,
      here_hall: hereHall, here_owner: hereOwner,
      may_use_here: hereHall == null ? false : hereOwner == null ? null
        : (!!name && this.allied(hereOwner, name) && Number(myRank ?? 0) >= 2),
    };
  }
}

/** The shape a board or a picker wants: one row per guild, plus any hall whose owner is not a known guild. */
export function guildSummary({ registry, store }) {
  const guilds = registry.guilds();
  const rows = guilds.map(g => ({
    guild: g.name, hall_room: g.hall_room, hall_name: g.hall_name, allies: g.allies,
    members: (g.members ?? []).map(m => m.name), roster_at: g.observed_at ?? null,
    rent: store.readRent(g.name),
    chests: g.hall_room ? store.allChests({ room: g.hall_room }).length : 0,
  }));
  for (const room of store.chestHalls())
    if (!rows.some(r => r.hall_room === room))
      rows.push({ guild: registry.ownerOfHall(room), hall_room: room, hall_name: hallName(room), allies: [],
                  members: [], roster_at: null, rent: null, chests: store.allChests({ room }).length,
                  note: 'chest readings exist for this hall but no known guild owns it' });
  return rows;
}

// ------------------------------------------------------------------------------- cli
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const all = (name) => argv.flatMap((a, i) => a === name ? [argv[i + 1]] : []).filter(Boolean);
  const root = opt('--root');
  const dir = root ? join(resolve(root), 'substrate', 'storage') : STORAGE_DIR;
  const registry = new GuildRegistry({ dir });
  const store = new StorageCache({ dir });
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show';
  if (cmd === 'hall') {
    const room = Number(opt('--room')), guild = opt('--guild');
    registry.recordHall(room, guild, { source: 'operator' });
    console.log(`hall ${room} (${hallName(room)}) now belongs to "${guild}"`);
  } else if (cmd === 'ally') {
    const [a, b] = all('--guild');
    registry.recordAlliance(a, b);
    console.log(`"${a}" and "${b}" are recorded as allies`);
  } else if (cmd === 'show') {
    const rows = guildSummary({ registry, store });
    if (argv.includes('--json')) { console.log(JSON.stringify({ dir: registry.dir, guilds: rows }, null, 2)); process.exit(0); }
    if (!rows.length) { console.log(`no guild rosters under ${registry.dir} — no character has read its guild yet`); process.exit(0); }
    for (const r of rows) {
      const rent = r.rent ? (r.rent.credit >= 0 ? `credit ${r.rent.credit}` : `owes ${-r.rent.credit}`) : 'rent unknown';
      console.log(`${r.guild ?? '(unknown guild)'} — hall ${r.hall_room ?? '?'}${r.hall_name ? ` ${r.hall_name}` : ''} · ` +
                  `${r.chests} chest reading(s) · ${rent}${r.allies.length ? ` · allies: ${r.allies.join(', ')}` : ''}`);
      if (r.members.length) console.log(`  members: ${r.members.join(', ')}`);
      if (r.note) console.log(`  ${r.note}`);
    }
  } else {
    console.error(`unknown command "${cmd}" — try: show | hall --room N --guild NAME | ally --guild A --guild B`);
    process.exit(2);
  }
}
