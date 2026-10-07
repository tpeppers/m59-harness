// A KEEPER THAT WANTS TO BE OFFLINE. Pure, plus one small file store; no socket, no broker.
//
//   import { normalizeDormancy, dormancyVerdict, logoffPenalty, DormancyStore } from './m59-dormancy.mjs';
//   node tools/m59-dormancy-test.mjs
//
// Until this, "offline" was something that HAPPENED to a keeper, never something it could WANT.
// The broker's 45 s rejoin sweep exists to put back characters that fall out of the world, and it
// cannot tell a drop from a decision, so every decision to stay out lost to it within a lap:
//
//   * A PERSON PLAYING A CHARACTER (operator, 2026-10-07). `restart-keepers` cannot hand a piloted
//     character's keeper off -- the replacement's login would bump the person -- so it skipped it,
//     and the old keeper, disconnected but alive, was told to `/rejoin` on old code the moment the
//     person logged out. The fix is a replacement that starts DORMANT and waits for the person.
//   * A PERSON WHO LOGGED OFF TO SURVIVE. Logging off is the one move that breaks a fight in this
//     game (the ghost it leaves cannot be attacked -- logghost.kod has no combat handler), and the
//     sweep undid it: the keeper logged straight back in, onto the square the attacker was standing
//     on, and died there. Nothing could stop it.
//   * A KEEPER THAT LOGS ITSELF OFF TO SURVIVE (not built yet; this file is shaped for it). The
//     playbook verbs `logoff` and `call_for_help` already promise "stay off for stay_off_s" and
//     their comment says the broker honours the window. NOTHING READ IT: `breakOut` reconnects
//     (log off and straight back on), and only behind `breakOutViaLogoff` and a crowd. An `evade`
//     dormancy is what those verbs should become.
//
// THE RECORD. One per character, held by the keeper process (so it acts on it without asking
// anybody) and persisted by the broker (so a crashed or replaced keeper comes back dormant rather
// than logging in). `reason` says why, `wake` says what ends it, and `penalty` says what the
// SERVER will do if it goes on too long -- which is the half a bot has to plan around.
//
// THE SERVER'S RULE, which is why `penalty` exists (kod, read 2026-10-07):
//   user.kod:665-689  UserLogoff: outside a safe-logoff room (and outside a guild hall's interior
//                     you may enter) a LogoffGhost is left standing where you were.
//   user.kod:675-684  its deadline is GhostTime x Random(90,110)%; settings.kod:94 GhostTime = 600 s,
//                     so the strike lands between 540 and 660 s after the logoff, and we cannot know
//                     where in that window.
//   user.kod:680-681  THE DEADLINE IS NOT RESET BY A QUICK RELOG. A new one is drawn only if the old
//                     one has passed OR the character was online more than GhostTime/5 (120 s). Log
//                     in for a minute and off again and the ORIGINAL clock is still running.
//   logghost.kod      PenaltyTrigger: still offline at the deadline means InflictPenalties (items
//                     dropped where the ghost stands, spell and skill points lost, scaled by how many
//                     unsafe logoffs are recent -- up to death-equivalent) and a teleport to the
//                     blink point. Logged on before it: the ghost is deleted, no penalty at all.
//   user.kod:7127     and logging back on puts you on the square you left, where an attacker can wait.
// So a dormancy with an unsafe logoff behind it carries a hard deadline of its own, and the
// default is to come back before the EARLIEST possible strike. `accept_penalty` is the explicit way
// to say "stay off anyway" -- for a person who knows what the ghost costs them.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DORMANCY_REASONS = Object.freeze({
  pilot: 'a person is playing this character; the keeper waits until they are done',
  operator: 'an operator asked for this character to stay out of the world',
  evade: 'the keeper logged itself off to get away from something',
});

export const WAKE_RULES = Object.freeze({
  pilot_released: 'when nobody is at the controls any more',
  deadline: 'at `until`',
  manual: 'only when somebody says so',
});

/** What each reason ends on when the request does not say. */
const DEFAULT_WAKE = Object.freeze({ pilot: 'pilot_released', operator: 'manual', evade: 'deadline' });

/** settings.kod:94 piLogoffPenaltyGhostTime = 600; user.kod:683 Random(90,110); user.kod:681 GhostTime/5. */
export const LOGOFF_PENALTY = Object.freeze({
  ghost_ms: 600_000, min_factor: 0.9, max_factor: 1.1, reset_online_ms: 120_000,
  cite: 'user.kod:665-689 UserLogoff, settings.kod:94, logghost.kod PenaltyTrigger',
});

/** Come back this long before the EARLIEST possible strike: a login is not instant. */
export const PENALTY_MARGIN_MS = 60_000;

/**
 * ROOMS WHERE A LOGOFF LEAVES NO GHOST: `viPermanent_flags` carries ROOM_SAFELOGOFF (0x1000,
 * blakston.khd:1060). Read from the kod room files 2026-10-07; the number is the room's RID.
 * Guild hall interiors are safe too, but only for a member who may enter and not in the foyer
 * (user.kod:670-673) -- a fact about the character, not the room, so they are `null` (unknown)
 * here unless a caller says otherwise. Rented rooms (rentroom.kod) are safe and have no fixed RID.
 */
export const SAFE_LOGOFF_ROOMS = Object.freeze(new Set([
  1,    // the Underworld (uworld.kod)
  3,    // field1.kod
  43,   // Out of Grace (outgrace.kod)
  52,   // Tos inn
  72,   // Tos adventurers' hall
  103,  // Barloque bar (barlbar1.kod)
  105,  // Barloque adventurers' hall
  106,  // Barloque inn
  152,  // Cor Noth adventurers' hall
  153,  // Cor Noth inn
  202,  // Marion inn
  204,  // Marion adventurers' hall
  370,  // Jasper inn
  371,  // Jasper tavern
  372,  // Jasper adventurers' hall
  901,  // god room
  902,  // university
  903,  // gallery
  1001, // guest1.kod
  2001, // Ko'catan inn
  2007, // Ko'catan Hall of Heroes
  2008, // Ko'catan tavern
  2101, // jungle trading post
]));

/**
 * Does a logoff in `room` leave a ghost? `true` safe, `false` unsafe, `null` UNKNOWN -- and the
 * penalty arithmetic treats unknown as unsafe, because the wrong guess the other way costs items.
 */
export function logoffIsSafe(room, { guildHallRooms = [] } = {}) {
  const n = Number(room);
  if (room == null || !Number.isFinite(n)) return null;
  if (SAFE_LOGOFF_ROOMS.has(n)) return true;
  if ((guildHallRooms ?? []).map(Number).includes(n)) return null;
  return false;
}

/**
 * THE WINDOW IN WHICH THE SERVER MAY PUNISH THIS LOGOFF, or null for a safe one.
 *   at          when the character left the world (ms)
 *   safe        logoffIsSafe(); null is treated as unsafe and says so (`assumed_unsafe`)
 *   lastLoginAt when it last entered the world, for the 120 s rule; null = unknown, never carried
 *   prior       the window of the PREVIOUS unsafe logoff, if one is known
 * Returns { at, earliest, latest, carried, assumed_unsafe }.
 */
export function logoffPenalty({ at, safe = null, lastLoginAt = null, prior = null } = {}) {
  const when = Number(at);
  if (!Number.isFinite(when)) throw new Error('logoffPenalty: `at` must be a time in ms');
  if (safe === true) return null;
  const P = LOGOFF_PENALTY;
  const fresh = { at: when, earliest: when + P.ghost_ms * P.min_factor, latest: when + P.ghost_ms * P.max_factor };
  const assumed_unsafe = safe == null;
  const online = lastLoginAt == null ? null : when - Number(lastLoginAt);
  // user.kod:680: a NEW deadline only if the old one has passed or we were on for more than 120 s.
  // Otherwise the old deadline -- which we only know as a window -- is still the one that counts.
  const priorLatest = Number(prior?.latest), priorEarliest = Number(prior?.earliest);
  if (prior && Number.isFinite(priorLatest) && when < priorLatest
      && online != null && online <= P.reset_online_ms) {
    if (when < priorEarliest)
      return { at: when, earliest: priorEarliest, latest: priorLatest, carried: true, assumed_unsafe };
    // Inside the old window: either it has already fired (and a fresh one was drawn) or it fires at
    // any moment. The earliest strike we cannot rule out is NOW.
    return { at: when, earliest: when, latest: Math.max(priorLatest, fresh.latest), carried: 'maybe', assumed_unsafe };
  }
  return { ...fresh, carried: false, assumed_unsafe };
}

const num = v => (v == null || v === '' ? null : Number(v));

/**
 * A REQUEST TO GO DORMANT, made into a record -- or a thrown reason. Accepts `until` (ms epoch) or
 * `for_ms`; `wake` defaults by reason. A deadline wake without a deadline is refused rather than
 * read as "for ever": an `evade` that forgot its length must not become indefinite by omission.
 */
export function normalizeDormancy(req = {}, { now = Date.now() } = {}) {
  const r = req ?? {};
  const reason = String(r.reason ?? '');
  if (!Object.hasOwn(DORMANCY_REASONS, reason))
    throw new Error(`dormancy reason must be one of ${Object.keys(DORMANCY_REASONS).join(', ')} (got "${reason}")`);
  const wake = String(r.wake ?? (DEFAULT_WAKE[reason] === 'manual' && (r.until != null || r.for_ms != null) ? 'deadline' : DEFAULT_WAKE[reason]));
  if (!Object.hasOwn(WAKE_RULES, wake))
    throw new Error(`dormancy wake must be one of ${Object.keys(WAKE_RULES).join(', ')} (got "${wake}")`);
  let until = num(r.until);
  const forMs = num(r.for_ms);
  if (until == null && forMs != null) until = now + forMs;
  if (until != null && (!Number.isFinite(until) || until <= now - 1000))
    throw new Error('dormancy `until` must be a time in the future (ms since the epoch)');
  if (wake === 'deadline' && until == null)
    throw new Error('a deadline wake needs `until` or `for_ms`; for no deadline say wake: "manual"');
  const note = r.note == null ? null : String(r.note).slice(0, 200);
  return {
    v: 1, reason, wake, since: Number(r.since) || now, until, by: String(r.by ?? 'unattributed').slice(0, 80),
    note, accept_penalty: r.accept_penalty === true,
    logoff: r.logoff ?? null, penalty: r.penalty ?? null,
  };
}

/** The record after the character actually left the world: where, and what the server will do. */
export function withLogoff(rec, { at = Date.now(), room = null, safe, lastLoginAt = null, prior = null,
                                  guildHallRooms = [] } = {}) {
  const s = safe === undefined ? logoffIsSafe(room, { guildHallRooms }) : safe;
  return { ...rec, logoff: { at, room: room == null ? null : Number(room), safe: s },
           penalty: logoffPenalty({ at, safe: s, lastLoginAt, prior }) };
}

/**
 * SHOULD THIS DORMANT KEEPER COME BACK NOW? Pure.
 *   pilotHeld  is a person at the controls right now (the broker's pilot claim)
 * Returns { dormant, wake, why, next_at, must_wake_by }. `must_wake_by` is the penalty guard's
 * deadline, published so a planner can see how long it has; `next_at` is when the answer can next
 * change on the clock alone (null: only an event -- a pilot leaving, an operator -- changes it).
 */
export function dormancyVerdict(rec, { now = Date.now(), pilotHeld = false } = {}) {
  if (!rec) return { dormant: false, wake: false, why: 'not dormant', next_at: null, must_wake_by: null };
  const mustWakeBy = rec.penalty && !rec.accept_penalty ? rec.penalty.earliest - PENALTY_MARGIN_MS : null;
  const out = (wake, why) => ({ dormant: true, wake, why, must_wake_by: mustWakeBy,
    next_at: wake ? null : [rec.wake === 'deadline' ? rec.until : null, mustWakeBy]
      .filter(t => t != null && t > now).sort((a, b) => a - b)[0] ?? null });
  // THE SERVER'S CLOCK OUTRANKS EVERY REASON. A body left in an unsafe room is struck between 540
  // and 660 s; being back on before the earliest of those is what avoids it (logghost.kod).
  if (mustWakeBy != null && now >= mustWakeBy)
    return out(true, `logoff penalty: the server may strike the abandoned body from ` +
      `${new Date(rec.penalty.earliest).toISOString()} (logged off in ` +
      `${rec.logoff?.room ?? 'an unknown room'}${rec.penalty.assumed_unsafe ? ', assumed unsafe' : ''})`);
  switch (rec.wake) {
    case 'pilot_released':
      return pilotHeld ? out(false, 'a person is at the controls') : out(true, 'nobody is at the controls any more');
    case 'deadline':
      return now >= rec.until ? out(true, `the ${rec.reason} window is over`)
                              : out(false, `${rec.reason}: until ${new Date(rec.until).toISOString()}`);
    default:
      return out(false, `${rec.reason}: until somebody says otherwise`);
  }
}

// ------------------------------------------------------------------------------- the hand-over
// The broker hands a record to the keeper it spawns in an environment variable, so the keeper
// knows BEFORE its first login. An unreadable one fails CLOSED -- dormant, waiting to be told --
// because the only thing worse than a character that stays out too long is one that logs in onto
// the square somebody logged it off to escape.

export const DORMANCY_ENV = 'M59_KEEPER_DORMANT';

export const encodeDormancy = rec => Buffer.from(JSON.stringify(rec), 'utf8').toString('base64url');

export function decodeDormancy(text, { now = Date.now() } = {}) {
  if (text == null || text === '') return null;
  try { return normalizeDormancy(JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8')), { now }); }
  catch (e) {
    return normalizeDormancy({ reason: 'operator', wake: 'manual', by: 'keeper startup',
      note: `unreadable ${DORMANCY_ENV} (${e.message}); staying out until told` }, { now });
  }
}

// ------------------------------------------------------------------------------- the store
// One JSON file per fleet, written by the broker. It names characters and holds this machine's
// orders, so it is gitignored (/substrate/dormancy-*.json).

export const dormancyFileFor = (fleet, directory = join(HERE, '..', 'substrate')) =>
  join(resolve(String(directory)), `dormancy-${String(fleet ?? 'default').replace(/[^\w.-]+/g, '_') || 'default'}.json`);

export class DormancyStore {
  constructor({ file }) { this.file = file; }

  static forFleet(fleet, directory) { return new DormancyStore({ file: dormancyFileFor(fleet, directory) }); }

  /**
   * A MISSING FILE IS "NOBODY IS DORMANT"; AN UNREADABLE ONE THROWS. Reading garbage as empty would
   * log every held character back in at once -- the exact failure this store exists to prevent --
   * so a caller that cannot read it has to decide to stand still, not be told all is clear.
   */
  read() {
    let text;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (e) { if (e?.code === 'ENOENT') return { v: 1, agents: {}, log: [] }; throw e; }
    let s;
    try { s = JSON.parse(text); }
    catch (e) { throw new Error(`dormancy store ${this.file} is unreadable (${e.message})`); }
    return { v: 1, agents: s?.agents ?? {}, log: Array.isArray(s?.log) ? s.log : [] };
  }

  all() { return { ...this.read().agents }; }
  get(agent) { return this.read().agents[agent] ?? null; }

  set(agent, rec, now = Date.now()) { return this.#write(agent, rec, 'set', rec?.by ?? null, rec?.note ?? null, now); }

  /** Ends a dormancy; `why` is kept in the file's short log, so "who woke him" has an answer. */
  clear(agent, { why = null, by = null } = {}, now = Date.now()) {
    if (!this.get(agent)) return null;
    return this.#write(agent, null, 'clear', by, why, now);
  }

  #write(agent, rec, what, by, why, now) {
    const s = this.read();
    if (rec) s.agents[agent] = rec; else delete s.agents[agent];
    s.log = [...s.log, { at: now, agent, what, by, why, reason: rec?.reason ?? null }].slice(-200);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    // Windows refuses a rename over a file another process has open; readers are short.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, this.file); break; }
      catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || attempt >= 20) { try { unlinkSync(tmp); } catch {} throw e; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    return rec;
  }
}
