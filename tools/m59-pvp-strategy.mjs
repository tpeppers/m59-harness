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
//
// THE FACTS, every moment (a frozen object):
//   moment, character, agent, room, player, hostile (war book / server enemy mark), basis,
//   pvp_allowed_here (the character's own pvp_rooms answer), health_pct, max_health,
//   in_flight, flight_room, hold_room, now
//
// THE DECISIONS — a CLOSED set, like the playbook verbs. Anything else is reported and ignored.
//   null | 'default' | { do: 'default' }    what the harness already does; silence
//   { do: 'flee_to', room, hold_ms?, max_ms?, why? }
//        take the body and travel to `room` now, as survival, through anything; on arrival hold the
//        character there for `hold_ms` (keeper journeys out of it are refused, explicit orders are not)
//   { do: 'engage', why? }
//        fight here even where the character's pvp_rooms would refuse: return fire on a hit, the war
//        response on a hostile sighting. The server's own rules, the safety flag and every refused-target
//        memory still apply; this only lifts OUR room list, for this room, for ENGAGE_WINDOW_MS.
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
//     decide(moment, facts, options) { return { do: 'flee_to', room: options.room } },
//   };
// It must be fast and must not throw; a throw, or more than DECIDE_BUDGET_MS, is reported and
// answered with silence, and three strikes stand the module down until its file changes.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');

export const PVP_MOMENTS = Object.freeze(['attacked_by_player', 'player_seen']);
export const PVP_DECISIONS = Object.freeze(['default', 'flee_to', 'engage']);
export const DECIDE_BUDGET_MS = Number(process.env.M59_PVP_STRATEGY_MS || 25);
export const STRIKES = 3;
export const MAX_HOLD_MS = 4 * 3600_000;
export const DEFAULT_FLIGHT_MS = 10 * 60_000;
export const ENGAGE_WINDOW_MS = 60_000;
export const PLAYER_SEEN_EVERY_MS = 5_000;

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
  const room = Number(d.room);
  if (!Number.isInteger(room) || room <= 1) return { decision: null, error: `flee_to needs a room number above 1, not ${JSON.stringify(d.room)}` };
  const ms = (v, dflt, max) => v == null ? dflt : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Number(v), max) : NaN);
  const hold_ms = ms(d.hold_ms, 0, MAX_HOLD_MS), max_ms = ms(d.max_ms, DEFAULT_FLIGHT_MS, MAX_HOLD_MS);
  if (Number.isNaN(hold_ms) || Number.isNaN(max_ms)) return { decision: null, error: 'hold_ms and max_ms are non-negative milliseconds' };
  return { decision: { do: 'flee_to', room, hold_ms, max_ms, why } };
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
  }

  status() {
    return { strategy: this.assignment?.strategy ?? null, file: this.file, loaded: !!this.module,
      options: this.assignment?.options ?? null, error: this.error, strikes: this.strikes,
      decisions: this.decisions, last: this.last, assignment_file: pvpAssignmentFile(this.fleet, this.env) };
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
      const mod = await this.importer(`${pathToFileURL(where).href}?v=${st.mtimeMs}`);
      const m = mod?.default ?? mod?.strategy ?? mod;
      if (typeof m?.decide !== 'function') { this.clear(`${where} exports no decide(moment, facts, options)`); return this.status(); }
      this.module = m; this.file = where; this.loadedKey = key; this.strikes = 0; this.error = null;
      this.log(`[pvp-strategy] ${this.character ?? this.agent}: ${a.strategy} loaded from ${where}`);
    } catch (e) {
      this.error = `refresh: ${e.message}`;
    }
    return this.status();
  }

  clear(error) { this.module = null; this.file = null; this.loadedKey = null; this.error = error; }

  /** The answer for one moment: a validated decision, or null for "do what the harness does". */
  decide(moment, facts) {
    const m = this.module, a = this.assignment;
    if (!m || !a || this.isHost || this.strikes >= STRIKES || !PVP_MOMENTS.includes(moment)) return null;
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
      return { ...decision, strategy: a.strategy };
    }
    return null;
  }
}
