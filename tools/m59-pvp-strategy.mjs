// m59-pvp-strategy.mjs — A CHARACTER'S ANSWER TO A PLAYER, AS A MODULE THIS MACHINE CHOOSES.
//
// Operator, 2026-10-13: "these strategy changes shouldn't be changes to the harness for everyone --
// they should be changes to the harness that allow for modular PVP strategies (engage, flee, etc. --
// each able to specify their own details), such that people can run fleets of bots that even each
// individually define their own PVP behaviors through privately mapped overrides. Leave the current
// behaviors as-is for the defaults."
//
// So this file is MECHANISM ONLY. It names no room, no enemy and no character. A strategy is an .mjs
// module somewhere this machine points at, and an assignment file maps characters to strategies with
// their own options. With no assignment — the state of every fresh clone — `decide` returns null and
// CombatMode does exactly what it did before this file existed.
//
// THE KEEPER ASKS, IT DOES NOT CALL (the playbook rule, docs/m59-boundary.md). The moments arrive on
// the server packet that showed them, inside the keeper, and the answer is a synchronous function call
// against a module already loaded — no broker, no network, no await. A module is (re)loaded off that
// path by `refresh()`, on a timer, keyed on file and mtime; until the first load lands, silence.
//
// THE MOMENTS
//   attacked_by_player   a player's blow landed on us (CombatMode.beginPvP)
//   player_seen          a non-fleetmate player is in our room (CombatMode.scanForEnemies), once per
//                        player per room every PLAYER_SEEN_EVERY_MS
//   alarm_elsewhere      a fleet-mate's war alarm (attacked / engaged, never a bare sighting) names a
//                        map OTHER than ours (CombatMode.onWarAlarm), once per map and enemy every
//                        PLAYER_SEEN_EVERY_MS. `player` is the enemy; `alarm_room`, `reporter` and
//                        `basis` say where and who. This is how a character hears a fight next door.
//                        OPT-IN: asked only of a module whose `moments` lists it, because a strategy written
//                        before this moment existed would read "a hostile, elsewhere" as one of its own.
//
// THE FACTS, every moment (a frozen object):
//   moment, character, agent, room, player, hostile (war book / server enemy mark), basis,
//   pvp_allowed_here (the character's own pvp_rooms answer), health_pct, max_health,
//   in_flight, flight_room, hold_room, now,
//   allies_here (fleet-mates in the room, NOT counting this character), hostiles_here (players in the
//   room the war book or the server marks hostile), sortie_room / sortie_phase (the sortie in force, or
//   null), alarm_room / reporter (alarm_elsewhere only),
//   pvp_episode -- the return-fire fight in progress, or null: { elapsed_ms, start_health, health, attacks_sent,
//   incoming_hits, incoming_misses, attackers, joust: { phase, exchanges, period_ms, swings } | null }.
//   (start_health - health) / exchanges is the net cost of one exchange, healing included,
//   player_health -- the fleet's groan-based estimate of the player's health (m59-player-health.mjs):
//   { band 1-4, min_pct, max_pct, age_ms, room } from the last time anyone of ours heard them hurt, or null
//
// THE DECISIONS — a CLOSED set, like the playbook verbs. Anything else is reported and ignored.
//   null | 'default' | { do: 'default' }    what the harness already does; silence
//   { do: 'flee_to', room, hold_ms?, hold_orders?, max_ms?, via?, row?, col?, why? }
//        take the body and travel to `room` now, as survival, through anything; on arrival hold the
//        character there for `hold_ms` (keeper journeys out of it are refused, explicit orders are not --
//        unless `hold_orders: true`, which refuses EVERY journey out, a director's `travel` included:
//        a DUM that walks its units with explicit travel would otherwise send a fled unit straight back).
//        `via`: walk to that room first, planning around `room`, then step in -- for a room whose
//        entrances land on islands that cannot reach each other (if the way in fails, it goes straight in).
//        row/col: on arrival, walk to that square (best effort; the room, not the square, ends the flight)
//        cup: true -- sip the Chalice of the Rain the body carries first, once, and keep going from wherever it lands
//        (operator, 2026-10-27: islanders who see a known enemy "can simply sip the chalice and run away")
//   { do: 'engage', why? }
//        fight here even where the character's pvp_rooms would refuse: return fire on a hit, the war
//        response on a hostile sighting. The server's own rules, the safety flag and every refused-target
//        memory still apply; this only lifts OUR room list, for this room, for ENGAGE_WINDOW_MS.
//   { do: 'sortie', room, home, row?, col?, max_ms?, idle_ms?, home_hold_ms?, wait_home_fight?, why? }
//        a deliberate excursion to fight in ONE other map. The body is taken exactly as a flight takes
//        it -- the walk out ignores the fight it is leaving, which is the point -- and travels to `room`,
//        then (given row and col) walks to that square. Once there: our room list is lifted for that
//        map, the keeper is held in it (explicit orders too), and the ordinary war response and return
//        fire engage whoever is hostile there. It ends -- and the body walks back to `home` as a
//        flight, held there for `home_hold_ms` -- after `idle_ms` with no hostile in the map, after
//        `max_ms` in all, or the moment the body is anywhere but `room` or `home` (a sortie never
//        follows anybody a second map out). A `flee_to` decided during it replaces it.
//        `wait_home_fight: true` keeps a posted sortie waiting while its HOME is still fighting: a fleet-mate's
//        attacked/engaged alarm from `home` counts as a hostile for the idle clock. A guard posted outside a door
//        waits for the fight inside to come out, not for the outside map to stay quiet.
//   { do: 'hold_fire', ms?, why? }
//        do not START a fight with this player: the war response's on-sight engagement and a fleet-mate's
//        alarm both pass over them for `ms` (default HOLD_FIRE_MS, renewed by deciding again). It never
//        stops return fire -- a player who hits us is answered exactly as before.
//   { do: 'joust', period_ms?, swings?, gap?, ms?, why? }
//        return fire in TIMED EXCHANGES rather than continuously: `swings` attacks (0-5, default 1), then the
//        body backs away inside this room until `gap` squares (2-10, default 4) separate it from the attacker,
//        and the next exchange starts `period_ms` (JOUST_MIN_PERIOD_MS..JOUST_MAX_PERIOD_MS, default 6 s) after
//        the last one began. `swings: 0` only evades. It lasts `ms` (default 60 s; every blow asks again, so a
//        strategy re-paces as the fight goes) and lifts our room list here as `engage` does. Any other answer
//        to a later blow -- null included -- ends it and the fight is ordinary return fire again. It never
//        leaves the room: it slows a fight down, it does not run from one.
//
// WHERE THE FILES ARE (all optional, all this machine's — gitignored, never committed):
//   strategies   substrate/pvp-strategies/<name>.mjs (or M59_PVP_STRATEGY_DIR), then every directory in
//                M59_PVP_STRATEGY_PATH (platform delimiter), then every directory listed in
//                substrate/pvp-strategy-dirs.json { "dirs": [...] }. The FIRST holding <name>.mjs wins, so
//                a local file of the same name overrides a private repository's.
//   assignment   substrate/pvp-strategy-<fleet>.json (or M59_PVP_STRATEGY_FILE):
//                { "default": <entry>, "agents": { "t9": <entry> }, "characters": { "Camilla": <entry> } }
//                <entry> = "name" | { "strategy": "name", "options": {...} } | null (explicitly: default)
//                Most specific wins: agent, then character, then default. A menagerie host is never
//                assigned anything — it is not a combatant.
//
// A STRATEGY MODULE:
//   export default {
//     name: 'bastion', describe: '...',
//     moments: ['attacked_by_player', 'player_seen', 'alarm_elsewhere'],   // optional; default the first two
//     decide(moment, facts, options) { return { do: 'flee_to', room: options.room } },
//   };
// It must be fast and must not throw; a throw, or more than DECIDE_BUDGET_MS, is reported and
// answered with silence, and three strikes stand the module down until its file changes.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { autoRestore, substrateFor } from './m59-substrate-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');

export const PVP_MOMENTS = Object.freeze(['attacked_by_player', 'player_seen', 'alarm_elsewhere']);
/** What a module hears when it does not say: the moments that existed before `moments` did. */
export const DEFAULT_MOMENTS = Object.freeze(['attacked_by_player', 'player_seen']);
export const PVP_DECISIONS = Object.freeze(['default', 'flee_to', 'engage', 'sortie', 'hold_fire', 'joust']);
export const DECIDE_BUDGET_MS = Number(process.env.M59_PVP_STRATEGY_MS || 25);
export const STRIKES = 3;
export const MAX_HOLD_MS = 4 * 3600_000;
export const DEFAULT_FLIGHT_MS = 10 * 60_000;
export const ENGAGE_WINDOW_MS = 60_000;
export const PLAYER_SEEN_EVERY_MS = 5_000;
export const SORTIE_MAX_MS = 15 * 60_000;
export const DEFAULT_SORTIE_MS = 3 * 60_000;
export const DEFAULT_SORTIE_IDLE_MS = 30_000;
export const HOLD_FIRE_MS = 6_000;
export const HOLD_FIRE_MAX_MS = 60_000;
export const JOUST_MIN_PERIOD_MS = 2_000;
export const JOUST_MAX_PERIOD_MS = 30_000;
export const JOUST_PERIOD_MS = 6_000;
export const JOUST_MS = 60_000;
export const JOUST_MAX_MS = 15 * 60_000;

export const pvpStrategyDir = (env = process.env) => env.M59_PVP_STRATEGY_DIR || join(SUBSTRATE, 'pvp-strategies');
export const pvpStrategyDirsFile = (env = process.env) => env.M59_PVP_STRATEGY_DIRS_FILE || join(SUBSTRATE, 'pvp-strategy-dirs.json');
export const pvpAssignmentFile = (fleet, env = process.env) => env.M59_PVP_STRATEGY_FILE
  || join(SUBSTRATE, fleet && fleet !== 'default' ? `pvp-strategy-${fleet}.json` : 'pvp-strategy.json');

/** Every directory searched for a strategy module, in order. */
export function pvpStrategyDirs({ env = process.env } = {}) {
  const out = [];
  const add = d => {
    if (typeof d !== 'string' || !d.trim()) return;
    const r = resolve(d.trim());
    if (!out.some(o => o.toLowerCase() === r.toLowerCase())) out.push(r);
  };
  add(pvpStrategyDir(env));
  for (const d of String(env?.M59_PVP_STRATEGY_PATH ?? '').split(delimiter)) add(d);
  try {
    const j = JSON.parse(readFileSync(pvpStrategyDirsFile(env), 'utf8'));
    for (const d of (Array.isArray(j?.dirs) ? j.dirs : [])) add(d);
  } catch { /* absent or unreadable: only this machine's own directory */ }
  return out;
}

const NAME_OK = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** Where <name>.mjs lives, or null. A name with a path in it is refused rather than resolved. */
export function findPvpStrategy(name, opts = {}) {
  if (!NAME_OK.test(String(name ?? '')) || String(name).includes('..')) return null;
  for (const d of pvpStrategyDirs(opts)) {
    const f = join(d, `${name}.mjs`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** An assignment entry, normalised: { strategy, options } | null. A malformed entry is an error, not silence. */
export function normalizeEntry(e) {
  if (e == null) return null;
  if (typeof e === 'string') return e.trim() ? { strategy: e.trim(), options: {} } : null;
  if (typeof e === 'object' && !Array.isArray(e) && typeof e.strategy === 'string') {
    const options = e.options == null ? {} : e.options;
    if (typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
    return { strategy: e.strategy.trim(), options };
  }
  throw new Error(`an assignment is "name", { strategy, options } or null, not ${JSON.stringify(e)}`);
}

/** Who gets what: the most specific of agent, character, default. `undefined` keys fall through; `null` stops. */
export function resolveAssignment(book, { agent, character } = {}) {
  if (!book || typeof book !== 'object') return null;
  const pick = (table, key) => {
    if (!table || typeof table !== 'object' || key == null) return undefined;
    const hit = Object.keys(table).find(k => k.toLowerCase() === String(key).toLowerCase());
    return hit === undefined ? undefined : table[hit];
  };
  for (const e of [pick(book.agents, agent), pick(book.characters, character), book.default]) {
    if (e !== undefined) return normalizeEntry(e);
  }
  return null;
}

/** A strategy's answer, validated against the closed set. Returns { decision, error }. */
export function validateDecision(d) {
  if (d == null || d === 'default') return { decision: null };
  if (typeof d === 'string') d = { do: d };
  if (typeof d !== 'object' || Array.isArray(d)) return { decision: null, error: `not a decision: ${JSON.stringify(d)}` };
  const verb = String(d.do ?? '');
  if (!PVP_DECISIONS.includes(verb)) return { decision: null, error: `unknown decision "${verb}" (${PVP_DECISIONS.join(', ')})` };
  if (verb === 'default') return { decision: null };
  const why = d.why == null ? null : String(d.why).slice(0, 200);
  if (verb === 'engage') return { decision: { do: 'engage', why } };
  if (verb === 'hold_fire') {
    const v = d.ms == null ? HOLD_FIRE_MS : Number(d.ms);
    if (!Number.isFinite(v) || v < 0) return { decision: null, error: 'hold_fire ms is non-negative milliseconds' };
    return { decision: { do: 'hold_fire', ms: Math.min(v, HOLD_FIRE_MAX_MS), why } };
  }
  if (verb === 'joust') {
    const num = (v, dflt) => v == null ? dflt : Number(v);
    const period = num(d.period_ms, JOUST_PERIOD_MS), swings = num(d.swings, 1), gap = num(d.gap, 4), len = num(d.ms, JOUST_MS);
    if (!Number.isFinite(period) || period < 0) return { decision: null, error: 'joust period_ms is non-negative milliseconds' };
    if (!Number.isInteger(swings) || swings < 0 || swings > 5) return { decision: null, error: 'joust swings is a whole number 0..5' };
    if (!Number.isFinite(gap) || gap < 2 || gap > 10) return { decision: null, error: 'joust gap is 2..10 squares' };
    if (!Number.isFinite(len) || len < 0) return { decision: null, error: 'joust ms is non-negative milliseconds' };
    return { decision: { do: 'joust', period_ms: Math.min(Math.max(period, JOUST_MIN_PERIOD_MS), JOUST_MAX_PERIOD_MS),
      swings, gap, ms: Math.min(len, JOUST_MAX_MS), why } };
  }
  const room = Number(d.room);
  if (!Number.isInteger(room) || room <= 1) return { decision: null, error: `${verb} needs a room number above 1, not ${JSON.stringify(d.room)}` };
  const ms = (v, dflt, max) => v == null ? dflt : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Number(v), max) : NaN);
  if (verb === 'sortie') {
    const home = Number(d.home);
    if (!Number.isInteger(home) || home <= 1 || home === room) return { decision: null, error: `sortie needs a home room above 1 that is not its room, not ${JSON.stringify(d.home)}` };
    const hasSquare = d.row != null || d.col != null;
    const row = Number(d.row), col = Number(d.col);
    if (hasSquare && !(Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0)) return { decision: null, error: 'sortie row and col are whole squares, given together' };
    const max_ms = ms(d.max_ms, DEFAULT_SORTIE_MS, SORTIE_MAX_MS), idle_ms = ms(d.idle_ms, DEFAULT_SORTIE_IDLE_MS, SORTIE_MAX_MS);
    const home_hold_ms = ms(d.home_hold_ms, 0, MAX_HOLD_MS);
    if ([max_ms, idle_ms, home_hold_ms].some(Number.isNaN)) return { decision: null, error: 'max_ms, idle_ms and home_hold_ms are non-negative milliseconds' };
    return { decision: { do: 'sortie', room, home, ...(hasSquare ? { row, col } : {}), max_ms, idle_ms, home_hold_ms,
      wait_home_fight: d.wait_home_fight === true, why } };
  }
  const hold_ms = ms(d.hold_ms, 0, MAX_HOLD_MS), max_ms = ms(d.max_ms, DEFAULT_FLIGHT_MS, MAX_HOLD_MS);
  if (Number.isNaN(hold_ms) || Number.isNaN(max_ms)) return { decision: null, error: 'hold_ms and max_ms are non-negative milliseconds' };
  // THE WAY IN AND THE SQUARE. A room whose entrances land on different islands is entered by the
  // NEIGHBOUR, not by a door choice -- Ukgoth's three are edge exits, one per neighbour -- so `via` names
  // the room to pass through first, and row/col the square to walk to on arrival.
  const via = d.via == null ? null : Number(d.via);
  if (via != null && !(Number.isInteger(via) && via > 1 && via !== room)) return { decision: null, error: `flee_to via is a room above 1 that is not its room, not ${JSON.stringify(d.via)}` };
  const hasSquare = d.row != null || d.col != null, row = Number(d.row), col = Number(d.col);
  if (hasSquare && !(Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0)) return { decision: null, error: 'flee_to row and col are whole squares, given together' };
  return { decision: { do: 'flee_to', room, hold_ms, hold_orders: d.hold_orders === true, max_ms, why,
    ...(via != null ? { via } : {}), ...(hasSquare ? { row, col } : {}), ...(d.cup === true ? { cup: true } : {}) } };
}

/**
 * One character's strategy host: holds the loaded module and answers `decide` synchronously.
 * `refresh()` is the only asynchronous part and is run off the event path, on a timer.
 */
export class PvpStrategyHost {
  constructor({ fleet = null, agent = null, character = null, isHost = false, env = process.env,
                now = Date.now, log = () => {}, importer = (url) => import(url) } = {}) {
    Object.assign(this, { fleet, agent, character, isHost, env, now, log, importer });
    this.assignment = null; this.module = null; this.file = null; this.loadedKey = null;
    this.error = null; this.strikes = 0; this.decisions = 0; this.last = null; this.assignmentKey = null;
    this.loadedStrategy = null; this.lastRestore = null; this.loudSaid = null;
  }

  // CONFIGURED IS NOT LOADED. 2026-10-21: bastion.mjs's imports were archived by a bare `mv`, every
  // keeper's refresh failed with "Cannot find module", and the keepers kept answering with the module
  // they had loaded before (FleeTA) for hours while `strategy` read "bastion". `strategy` is the
  // ASSIGNMENT; `loaded_strategy` is the module actually answering; `stale` and `warning` say so when
  // they differ. A running keeper picks this up only when it is restarted (restart-keepers).
  status() {
    const strategy = this.assignment?.strategy ?? null;
    const stale = !!(this.module && strategy && this.loadedStrategy && this.loadedStrategy !== strategy);
    return { strategy, loaded_strategy: this.module ? this.loadedStrategy : null, file: this.file, loaded: !!this.module,
      stale, warning: stale ? `CONFIGURED "${strategy}" BUT RUNNING "${this.loadedStrategy}" (${this.file})` +
        (this.error ? ` -- ${this.error}` : '') : null,
      options: this.assignment?.options ?? null, error: this.error, strikes: this.strikes,
      decisions: this.decisions, last: this.last, last_restore: this.lastRestore,
      assignment_file: pvpAssignmentFile(this.fleet, this.env) };
  }

  /** Loud once per distinct message: a keeper log line, not a status field nobody reads. */
  loud(msg) {
    if (msg === this.loudSaid) return;
    this.loudSaid = msg;
    this.log(`[pvp-strategy] LOUD ${this.character ?? this.agent}: ${msg}`);
  }

  /** import, and on ERR_MODULE_NOT_FOUND restore archived modules and retry once (m59-substrate-archive.mjs). */
  async importStrategy(where, url) {
    try { return await this.importer(url); }
    catch (e) {
      const substrate = substrateFor(where) ?? substrateFor(pvpAssignmentFile(this.fleet, this.env)) ?? join(SUBSTRATE);
      const r = autoRestore(e, { entry: where, substrate, log: m => this.log(m) });
      if (!r.attempted) throw e;
      this.lastRestore = { at: this.now(), summary: r.summary, restored: r.restored.map(m => m.to), missing: r.missing };
      if (!r.restored.length) throw new Error(`${e.message} -- ${r.summary}`);
      this.loud(r.summary);
      try { return await this.importer(`${url}&restored=${this.now()}`); }
      catch (e2) { throw new Error(`${e2.message} -- after ${r.summary}`); }
    }
  }

  /** Re-read the assignment and (re)load the module when either changed. Never throws. */
  async refresh() {
    try {
      if (this.isHost) { this.clear(null); return this.status(); }
      const file = pvpAssignmentFile(this.fleet, this.env);
      let book = null, akey = 'absent';
      try { const st = statSync(file); akey = `${st.mtimeMs}:${st.size}`; } catch { /* absent: silence */ }
      if (akey !== this.assignmentKey) {
        this.assignmentKey = akey;
        if (akey !== 'absent') book = JSON.parse(readFileSync(file, 'utf8'));
        this.assignment = resolveAssignment(book, { agent: this.agent, character: this.character });
        this.error = null;
      }
      const a = this.assignment;
      if (!a) { this.clear(null); return this.status(); }
      const where = findPvpStrategy(a.strategy, { env: this.env });
      if (!where) { this.clear(`no strategy module "${a.strategy}.mjs" in ${pvpStrategyDirs({ env: this.env }).join(', ')}`); return this.status(); }
      const st = statSync(where), key = `${where}:${st.mtimeMs}`;
      if (key === this.loadedKey && this.module) return this.status();
      const mod = await this.importStrategy(where, `${pathToFileURL(where).href}?v=${st.mtimeMs}`);
      const m = mod?.default ?? mod?.strategy ?? mod;
      if (typeof m?.decide !== 'function') { this.clear(`${where} exports no decide(moment, facts, options)`); return this.status(); }
      this.module = m; this.file = where; this.loadedKey = key; this.strikes = 0; this.error = null;
      this.loadedStrategy = a.strategy; this.loudSaid = null;
      this.log(`[pvp-strategy] ${this.character ?? this.agent}: ${a.strategy} loaded from ${where}`);
    } catch (e) {
      this.error = `refresh: ${e.message}`;
      const st = this.status();
      this.loud(st.stale ? st.warning : this.error);
    }
    return this.status();
  }

  clear(error) { this.module = null; this.file = null; this.loadedKey = null; this.loadedStrategy = null; this.error = error; }

  /** The answer for one moment: a validated decision, or null for "do what the harness does". */
  decide(moment, facts) {
    const m = this.module, a = this.assignment;
    if (!m || !a || this.isHost || this.strikes >= STRIKES || !PVP_MOMENTS.includes(moment)) return null;
    if (!(Array.isArray(m.moments) ? m.moments : DEFAULT_MOMENTS).includes(moment)) return null;
    let raw;
    const t0 = this.now();
    try { raw = m.decide(moment, Object.freeze({ ...facts, moment }), Object.freeze({ ...a.options })); }
    catch (e) { this.strikes++; this.error = `decide threw: ${e.message}`; return null; }
    const took = this.now() - t0;
    if (raw && typeof raw.then === 'function') { this.strikes++; this.error = 'decide returned a promise; it must answer synchronously'; return null; }
    if (took > DECIDE_BUDGET_MS) { this.strikes++; this.error = `decide took ${took}ms (budget ${DECIDE_BUDGET_MS})`; return null; }
    const { decision, error } = validateDecision(raw);
    if (error) { this.error = error; return null; }
    if (decision) {
      this.decisions++;
      this.last = { at: this.now(), moment, player: facts?.player ?? null, room: facts?.room ?? null, ...decision };
      // The module that ANSWERED, not the assignment: they differ while a refresh is failing.
      const strategy = this.loadedStrategy ?? a.strategy;
      return { ...decision, strategy, ...(strategy !== a.strategy ? { configured_strategy: a.strategy } : {}) };
    }
    return null;
  }
}
