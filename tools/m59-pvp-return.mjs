// THE PVP RETURN DELAY: after a PLAYER kills a character, its keeper does not set out for a
// farming room again until `pvp_return_delay_ms` has passed (default 30 minutes, 0 disables).
//
// The operator's order, 2026-09-30: "set it so that there's a 30m PVP delay on returning to
// any farming zone". What it answers: a Human Resistance player (Morpheus) camped the roads
// and farm entrances — Castle Victoria's front door, the Tos gate, Outside Castle Victoria —
// and killed respawned characters one at a time as each walked straight back. Five deaths in
// twenty minutes, each from full health. A monster does not wait at the door for you; a
// person does, and the cheapest counter is not being there when he is.
//
// This module is the PURE half — classifying a death, the persisted record, the arithmetic
// of the window — so the offline suite can pin it without a keeper. The keeper half (where
// the hold is enforced, and what it deliberately does not block) is in m59-autopilot.mjs,
// `pvpReturnGate` and `holdOffTheFarm`. See docs/m59-policy.md, "The PvP return delay".
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';
import { parseGuildCombat } from './m59-war.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

// Two hours, operator 2026-10-01: "characters should move themselves to an inn and rest for 2
// hours after a PVP death before continuing to farm". It was thirty minutes (2026-09-30).
export const PVP_RETURN_DELAY_MS_DEFAULT = 2 * 60 * 60_000;
// A day is far past anything the order meant, and a typo of an extra zero or two (3 hours,
// 30 hours) should be refused at the setter rather than park a character until tomorrow.
export const PVP_RETURN_DELAY_MS_MAX = 24 * 60 * 60_000;

// SILENCE MEANS THE DEFAULT, AND THE DEFAULT IS ON. Absent, null or unusable all mean the
// default (two hours) — the operator asked for this fleet-wide, and a character nobody configured is
// exactly the one walking back into the camper. Only an explicit number (0 included) wins.
export function pvpReturnDelayMs(policy) {
  const v = policy?.pvpReturnDelayMs;
  if (v == null) return PVP_RETURN_DELAY_MS_DEFAULT;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= PVP_RETURN_DELAY_MS_MAX
    ? Math.floor(n) : PVP_RETURN_DELAY_MS_DEFAULT;
}

const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
// `rsc.get` answers `<dynamic 1000081>` for an id it has no string for. That is a truthy
// string and it is NOT a person — counting one once turned six trolls into a PVP death.
const unresolved = s => !s || /^<.*>$/.test(String(s).trim()) || /<dynamic/i.test(String(s));

/**
 * WAS THIS DEATH PVP? Evidence available at death time only, strongest first:
 *
 *   guild_combat    "### <us> of <guild> has been slaughtered by <X> of <guild> in guild combat."
 *                   The server prints it only for mutual war enemies (system.kod:1564-1594), and
 *                   it replaces the ordinary "was just killed by" line — which is why the
 *                   death-attribution module never sees a Morpheus kill as anything but a guess.
 *   murder          "### <us> has been murdered in cold blood." — only a player murders.
 *   player_in_room  the killer's name was a PLAYER object (OF.PLAYER) in the last living frame.
 *   war_book        the killer is remembered as a member of a guild we are at war with.
 *   player_seen     the killer was a player in an earlier frame of the death's short memory.
 *   unarticled_name the server named the killer without "a"/"an"/"the", which is how it names a
 *                   person and never a monster — and the name is not one of the monsters that
 *                   were standing there.
 *   player_attack_recent  none of the above, but a stranger player hit us in the 60 seconds
 *                   before the death (`recentPlayerAttacks`). The killers named are the
 *                   attackers; whatever struck last is kept as `killed_by`.
 *
 * NEVER A PLAYER: an unresolved `<dynamic …>` id, a fleetmate (ours, even when one hits us by
 * accident — the hold answers a stranger at the gate, not Statler), a name that matches a
 * monster in the frames, or no named killer at all.
 *
 * @returns {{pvp: boolean, killers: string[], basis: string|null, why: string}}
 */
export function classifyPvpDeath({ character, deathAt, attribution = null, text = [], frames = [],
                                   attacks = [], isFleetmate = () => false, enemy = () => null,
                                   windowMs = 120_000, recentPvpMs = RECENT_PVP_MS } = {}) {
  const v = classifyKiller({ character, deathAt, attribution, text, frames, isFleetmate, enemy, windowMs });
  if (v.pvp) return v;
  const recent = recentPlayerAttacks({ deathAt, attacks, frames, isFleetmate, recentPvpMs });
  if (!recent.length) return v;
  const names = [...new Set(recent.map(r => r.name))];
  const last = recent.reduce((a, b) => (b.at > a.at ? b : a));
  return { pvp: true, killers: names, basis: 'player_attack_recent',
           killed_by: v.killers, killed_by_why: v.why,
           why: `${names.join(', ')} attacked us ${Math.max(0, Math.round((deathAt - last.at) / 1000))}s ` +
                `before the death (${last.source}); the killing blow was not theirs (${v.why}), but a ` +
                `death inside a player's minute is a PvP death for the return delay` };
}

/**
 * A PLAYER WHO HIT US IN THE LAST MINUTE MADE THIS A PVP DEATH, WHOEVER LANDED THE LAST BLOW.
 *
 * The operator, 2026-10-21: count every death with PvP against that character in the last 60
 * seconds as PvP-related, for the purpose of resting at the inn rather than running back. The
 * camper does not need the kill: he hits, the character flees below its line into a room of
 * monsters, a frogman finishes it — and the classifier above, which only asks who struck last,
 * filed that as a monster death and sent the character straight back to the man at the gate.
 *
 * Two sources, both "a stranger player within reach AND our health went down", which is the
 * same evidence standard `checkAttackedByPlayer` writes the grudge book on:
 *   attacks  the keeper's own observations, `{at, name}`, from `checkAttackedByPlayer`.
 *   frames   the death's short memory: a frame whose health fell since the previous frame with
 *            a player in `players_near`. The watchdog writes one per health change during a
 *            blind walk, which is exactly when a pass is not there to call the check.
 * A fleetmate and an unresolved `<dynamic …>` id are never the attacker, as above.
 */
export const RECENT_PVP_MS = 60_000;
export function recentPlayerAttacks({ deathAt, attacks = [], frames = [], isFleetmate = () => false,
                                      recentPvpMs = RECENT_PVP_MS } = {}) {
  if (!Number.isFinite(Number(deathAt)) || !(recentPvpMs > 0)) return [];
  const t = Number(deathAt);
  // Two seconds after the death for clock skew between the frame and the death stamp, never more:
  // a hit seen in the Underworld is not a hit that killed anybody.
  const inWindow = at => Number.isFinite(at) && at >= t - recentPvpMs && at <= t + 2000;
  const stranger = n => {
    if (unresolved(n)) return false;
    try { return !isFleetmate(n); } catch { return true; }
  };
  const out = [];
  for (const a of attacks ?? [])
    if (inWindow(Number(a?.at)) && stranger(a?.name))
      out.push({ at: Number(a.at), name: String(a.name).trim(), source: 'seen hitting us' });
  let prev = null;
  for (const f of frames ?? []) {
    const hp = Number(f?.health), was = Number(prev?.health);
    if (prev && Number.isFinite(hp) && Number.isFinite(was) && hp < was && inWindow(Number(f?.at)))
      for (const n of f?.players_near ?? [])
        if (stranger(n)) out.push({ at: Number(f.at), name: String(n).trim(), source: 'within reach as our health fell' });
    prev = f;
  }
  return out;
}

function classifyKiller({ character, deathAt, attribution, text, frames, isFleetmate, enemy, windowMs }) {
  const me = norm(character);
  const ours = n => { try { return !!isFleetmate(n); } catch { return false; } };
  // 1. The guild-combat broadcast naming US as the victim, near this death.
  if (me) {
    let best = null;
    for (const e of text ?? []) {
      if (e?.kind && e.kind !== 'message') continue;
      const g = parseGuildCombat(e?.text);
      if (!g || norm(g.victim) !== me || unresolved(g.killer)) continue;
      const dt = Number.isFinite(e.at) && Number.isFinite(deathAt) ? Math.abs(e.at - deathAt) : null;
      if (dt != null && dt > windowMs) continue;
      if (!best || (dt ?? Infinity) < (best.dt ?? Infinity)) best = { ...g, dt };
    }
    if (best && !ours(best.killer))
      return { pvp: true, killers: [best.killer], basis: 'guild_combat',
               why: `the server announced a guild-combat kill by ${best.killer} of ${best.killerGuild}` };
  }
  const a = attribution ?? {};
  const killer = unresolved(a.killer) ? null : String(a.killer).trim();
  // 2. Murder is certain without a name.
  if (a.kind === 'player_murder')
    return killer && ours(killer)
      ? { pvp: false, killers: [killer], basis: 'fleetmate', why: 'murdered by one of ours' }
      : { pvp: true, killers: killer ? [killer] : [], basis: 'murder',
          why: 'the server announced a murder, which only a player commits' };
  if (!killer) return { pvp: false, killers: [], basis: null, why: 'no named killer' };
  if (ours(killer))
    return { pvp: false, killers: [killer], basis: 'fleetmate',
             why: 'the killer is one of ours; the hold answers strangers, not accidents' };
  // 3. A player object by that name in the last living frame.
  if (a.kind === 'player_kill')
    return { pvp: true, killers: [killer], basis: 'player_in_room',
             why: `${killer} was a player standing in the room at the end` };
  // 4. The war book.
  let remembered = null;
  try { remembered = enemy(killer); } catch { remembered = null; }
  if (remembered)
    return { pvp: true, killers: [killer], basis: 'war_book',
             why: `${killer} is remembered as a member of ${remembered.guild ?? 'a guild'} we are at war with` };
  if (a.was_killed_by_player !== true)
    return { pvp: false, killers: [killer], basis: null, why: 'the attribution does not name a player' };
  // 5./6. The attribution's own guess — corroborated by the frames, or refused by them.
  const seenAsPlayer = (frames ?? []).some(f => (f?.players_present ?? []).some(n => norm(n) === norm(killer)));
  if (seenAsPlayer)
    return { pvp: true, killers: [killer], basis: 'player_seen',
             why: `${killer} was seen as a player in the frames before the death` };
  const seenAsMonster = (frames ?? []).some(f => (f?.threats ?? []).some(n => norm(n) === norm(killer)));
  if (seenAsMonster)
    return { pvp: false, killers: [killer], basis: null,
             why: `${killer} is the name of a monster that was standing there` };
  if (/^[A-Z]/.test(killer))
    return { pvp: true, killers: [killer], basis: 'unarticled_name',
             why: `the server named ${killer} without an article, which is how it names a person` };
  return { pvp: false, killers: [killer], basis: null, why: 'an uncorroborated guess; not held on' };
}

// ------------------------------------------------------------------ the persisted record
//
// THE HOLD HAS TO SURVIVE A KEEPER RESTART INSIDE THE WINDOW, and keepers restart about once
// a minute on a busy day. `lastDeath` lives on the Autopilot and dies with the process; the
// post-mortem directory is hundreds of megabytes and is not something to scan at boot. So the
// one fact the hold needs — when, and who — is written to its own small file, one per
// character, written only by that character's keeper. Gitignored: it names characters.

// A TEST NEVER TOUCHES THE REAL BOOK, in either direction — the same rule m59-ledger.mjs enforces.
// The offline suites build convincing keepers that die convincingly (a murder fixture is a PvP
// death), and without this one of them filed a hold for a character called OfflineMurderVictim
// into this checkout's substrate. A suite that wants persistence sets M59_PVP_HOLD_DIR.
const IS_TEST = /[\\/]m59-[a-z0-9-]+-test\.mjs$/.test(process.argv[1] || '');
const offLimits = env => IS_TEST && !env.M59_PVP_HOLD_DIR;

const safe = s => String(s ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);

export function pvpHoldDir(env = process.env) {
  if (env.M59_PVP_HOLD_DIR) return env.M59_PVP_HOLD_DIR;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `pvp-holds-${name}` : 'pvp-holds');
}

export const pvpHoldFile = (agent, env = process.env) => join(pvpHoldDir(env), `${safe(agent)}.json`);

/** The last PvP death on record for this agent, or null. A file that will not parse is null. */
export function readPvpDeath(agent, env = process.env) {
  if (offLimits(env)) return null;
  const file = pvpHoldFile(agent, env);
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return r && Number.isFinite(Number(r.died_at)) ? { ...r, died_at: Number(r.died_at) } : null;
  } catch { return null; }
}

/**
 * EVERY PLAYER WHO HAS KILLED ONE OF OURS, as far as the hold records know: the `killers` of
 * every character's last PvP death, folded to lower case. Asked by m59-ally.mjs so that a
 * player who killed a fleet character is never treated as an ally (buffed, healed) however
 * else he looks. A record is one character's LAST PvP death, so this is a floor, not a
 * history -- the grudge book and the war book are the other two sources. Cached for a few
 * seconds because a keeper asks it per player per pass. A directory that cannot be read is
 * an empty set; the caller's other sources still apply.
 */
let killersCache = { dir: null, at: 0, set: new Set() };
export function knownKillers(env = process.env, { now = Date.now(), ttlMs = 10_000 } = {}) {
  if (offLimits(env)) return new Set();
  const dir = pvpHoldDir(env);
  if (killersCache.dir === dir && now - killersCache.at < ttlMs) return killersCache.set;
  const set = new Set();
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { files = []; }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (r?.pvp === false || r?.basis === 'fleetmate') continue;
      for (const k of Array.isArray(r?.killers) ? r.killers : [])
        if (k) set.add(String(k).trim().replace(/\s+/g, ' ').toLowerCase());
    } catch { /* one bad file is not every file */ }
  }
  killersCache = { dir, at: now, set };
  return set;
}

/**
 * ROOMS WHERE ONE OF OURS DIED TO A PLAYER RECENTLY: `room_num` of every hold record whose death is within
 * `withinMs`. Fleet-mate kills and records marked `pvp: false` are not PvP. Asked by the survival edge pass
 * (m59-survival-edge.mjs), which will not walk a hurt body out of its confinement into such a room. Cached
 * like knownKillers; an unreadable directory is an empty set.
 */
let pvpRoomsCache = { dir: null, at: 0, records: [] };
export function recentPvpDeathRooms({ withinMs = PVP_RETURN_DELAY_MS_DEFAULT, env = process.env, now = Date.now(),
                                      ttlMs = 10_000 } = {}) {
  if (offLimits(env)) return new Set();
  const dir = pvpHoldDir(env);
  if (pvpRoomsCache.dir !== dir || now - pvpRoomsCache.at >= ttlMs) {
    const records = [];
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { files = []; }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (r?.pvp === false || r?.basis === 'fleetmate') continue;
        if (Number.isFinite(Number(r?.room_num)) && Number.isFinite(Number(r?.died_at)))
          records.push({ room: Number(r.room_num), at: Number(r.died_at) });
      } catch { /* one bad file is not every file */ }
    }
    pvpRoomsCache = { dir, at: now, records };
  }
  return new Set(pvpRoomsCache.records.filter(r => now - r.at <= withinMs).map(r => r.room));
}

export function writePvpDeath(agent, record, env = process.env) {
  if (offLimits(env)) return null;
  const file = pvpHoldFile(agent, env);
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify({ format: 'm59-pvp-hold/1', agent, ...record }, null, 1);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body);
  try { renameSync(tmp, file); } catch { writeFileSync(file, body); }
  return file;
}

/**
 * The hold as of `now`, or null when there is none. The window is read against the delay
 * CURRENTLY in policy, so lowering the delay (or setting 0) releases a held character on the
 * next pass rather than at the delay it died under.
 */
export function pvpHoldState(record, delayMs, now = Date.now()) {
  if (!record || !(delayMs > 0)) return null;
  const until = Number(record.died_at) + delayMs;
  if (!Number.isFinite(until) || now >= until) return null;
  const killers = Array.isArray(record.killers) ? record.killers : [];
  return {
    until, died_at: Number(record.died_at), delay_ms: delayMs,
    remaining_s: Math.ceil((until - now) / 1000),
    killer: killers[0] ?? null, killers,
    basis: record.basis ?? null,
    died_in: record.died_in ?? null, room_num: record.room_num ?? null,
  };
}
