// ONE PLAY-DEAD LOGOFF PER HEALING SESSION, AND A SESSION ENDS ONLY AT FULL HEALTH.
//
// Operator, 2026-10-27: "Once logging back in poisoned from a play-dead logoff the fate is sealed, it should only ever do
// the play-dead log-to-lose-aggro code once per healing session on a single safe spot until healed full, so it should
// [not] ever get stuck in a loop increasing the timer, make sure that's true".
//
// Why a loop was possible: playDead refused a second logoff only while no damage had arrived since the turn at the wall
// (cooperative.mjs, `s.damagedAt > this.turnedAt`), and a poison tick IS damage -- so every tick re-armed another logoff,
// and every logoff adds 3 s to a harmful enchantment (player.kod FreezeAllEnchantments). Fozzie, 2026-10-27: four relogs
// while poisoned, then a troll's one blow at 1 HP.
//
// THE SESSION: opened by the first play-dead logoff (a body under its line, taking a recovery spot), closed when health is
// back to FULL and at least SESSION_MIN_MS has passed since the logoff (a logoff taken at full health is not "healed").
// Inside one session the logoff fires at most once, whatever the cause; after it the body keeps ONE safe spot until
// healed; a body that comes back OFF a spot flees to the nearest reachable one first (staysPut), and a refused logoff is
// replaced by something that moves it (spentLogoffReplacement). Persisted per character (substrate/.healing/), so a keeper
// handoff cannot hand out a second logoff.
// Pure apart from the small file.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALING_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.healing');
// Read at call time, so a test can point it at a temp dir after its imports have run.
const healingDir = () => process.env.M59_HEALING_DIR || HEALING_DIR;
// A session older than this is stale (a body that never reached full, a keeper that died): it is closed, not trusted.
export const SESSION_MAX_MS = 2 * 3_600_000;
// AND NOT BEFORE THIS LONG AFTER ITS LAST LOGOFF, however full health reads. Prod 2026-10-27, Robin (t8), room 599: a
// "logging off rather than dying" at 79/79 opened a session that the very next pass closed -- he was at full health --
// then a crowded-spot breakout did the same, then a hit-while-resting: three logoffs in two minutes. A logoff taken at
// full health is still the session's one logoff; "healed to full" has to mean healed AFTER it, and no healing session is
// shorter than this.
export const SESSION_MIN_MS = Number(process.env.M59_HEALING_MIN_MS || 5 * 60_000);
const fileOf = (agent, dir) => join(dir, `${String(agent ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

// A keeper always has a name; a nameless one is a test fake or a body not yet logged in, and gets no session -- one
// shared 'unknown' file would hand every such fake the same spent logoff.
const named = agent => String(agent ?? '').trim() !== '';

export function readSession(agent, { dir = healingDir(), now = Date.now() } = {}) {
  if (!named(agent)) return null;
  try {
    const s = JSON.parse(readFileSync(fileOf(agent, dir), 'utf8'));
    return s && now - Number(s.started_at) < SESSION_MAX_MS ? s : null;
  } catch { return null; }
}
function writeSession(agent, s, dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = fileOf(agent, dir), tmp = `${p}.${process.pid}.tmp`;
    if (s == null) { try { unlinkSync(p); } catch {} return; }
    writeFileSync(tmp, JSON.stringify(s) + '\n'); renameSync(tmp, p);
  } catch { /* unwritable: this process still remembers it in memory */ }
}

/** Close the session when health is back to full. Returns the session still open, or null. */
export function closeIfHealed(agent, { hp = null, max = null, dir = healingDir(), now = Date.now() } = {}) {
  const s = readSession(agent, { dir, now });
  if (!s) return null;
  const settled = now - Number(s.last_logoff_at ?? s.started_at) >= SESSION_MIN_MS;
  if (settled && Number.isFinite(hp) && Number.isFinite(max) && max > 0 && hp >= max) { writeSession(agent, null, dir); return null; }
  return s;
}
/** May this body play dead (log off) now? Only if no logoff has happened in the open session. */
export function mayLogoff(agent, { dir = healingDir(), now = Date.now() } = {}) {
  const s = readSession(agent, { dir, now });
  return !s || !(s.logoffs >= 1);
}
/** Record the logoff, opening the session if none is open. `cooperative`: a fleet-mate's distraction logoff. */
export function noteLogoff(agent, { why = null, room = null, cooperative = false, dir = healingDir(), now = Date.now() } = {}) {
  if (!named(agent)) return null;
  const s = readSession(agent, { dir, now }) ?? { started_at: now, logoffs: 0 };
  s.logoffs = (s.logoffs ?? 0) + 1; s.last_logoff_at = now; s.why = why; s.room = room;
  if (cooperative) s.cooperative = true;
  writeSession(agent, s, dir);
  return s;
}
/**
 * Inside a spent session, must the body stay exactly where it is? Only when it is ON a safe spot -- that is the one spot.
 * Operator, 2026-10-27: "if it logs in and it's not in a safe spot it basically should never stay still: the log-off for
 * protection behaviors best conditions is on a safe spot to rest, anything else should flee to the safe spot to try to
 * the nearest reachable heal spot there". So off a spot it flees to the nearest reachable one (never with a second logoff),
 * whatever caused the logoff; a cooperative one is only the commonest case.
 */
export function staysPut(agent, { holding = false, dir = healingDir(), now = Date.now() } = {}) {
  const s = readSession(agent, { dir, now });
  return !!s && s.logoffs >= 1 && !!holding;
}

// A REFUSED LOGOFF MUST LEAVE SOMETHING THAT MOVES THE BODY. Scooter (t21), Ko'catan 2115, prod 2026-10-27 13:10:44Z:
// the session's one logoff was spent at 13:08:12; a failed pull left him at r11c18 with no hold; the refuge search found
// nothing reachable ("nothing in this room is more defensible than open floor") and the survival ladder's replacement
// was `logoff_open`. playDead refused it (correctly: one logoff per session) and installed nothing, because its only
// replacement was `rest_safe` and that needed a hold. The un-executable logoff stayed pending; the dispatcher "handled" it
// every pass for 133 s while 8-9 avar warriors took him from 82/94 to 0, never moving and never swinging.
//
// This answers what the refused logoff becomes, and it never answers a logoff:
//   on its spot                                  -> null: the caller keeps the spot and heals (rest_safe), as before
//   off its spot, a refuge not yet tried         -> nearest_refuge: flee to the nearest reachable spot (staysPut's rule)
//   off its spot, the refuge search failed       -> leave_room: out by a permitted exit (the strategy's fall-back room)
//   ...and the exit was just tried from here     -> finish: end the logoff decision, so the ordinary ladder (fight back,
//                                                   trade in place, leave-to-recover) gets the pass instead of nothing
// `active` is the current survival decision. Only a PENDING logoff decision is replaced -- that is the one a caller has
// already chosen and is waiting to see carried out; anything else is not stranded by the refusal and is left alone.
// `hadHold`: a hold the body is no longer standing on. It used to be pinned with `rest_safe`; now it flees like any
// other body off its spot (unless an approach is already under way).
export const SPENT_EXIT_RETRY_MS = 30_000;
export function spentLogoffReplacement({ active = null, onSpot = false, hadHold = false, exitTriedRecently = false } = {}) {
  if (onSpot) return null;
  const logoffPending = !!active && active.status === 'pending'
    && (active.strategy === 'logoff_open' || active.strategy === 'logoff_safe');
  if (!logoffPending) {
    const approaching = !!active && ['pending', 'approaching'].includes(active.status)
      && ['nearest_refuge', 'route_refuge', 'leave_room'].includes(active.strategy);
    if (!hadHold || approaching) return null;
  }
  // A logoff_open in a pending state only follows a FAILED refuge approach: replacementSurvivalChoice picks it when the
  // previous decision was already logoff_open or had been re-planned at least once (safe-spots.mjs).
  const refugeFailed = logoffPending && active.strategy === 'logoff_open' && (active.replan_count ?? 0) >= 1;
  if (!refugeFailed) return { strategy: 'nearest_refuge', reason_code: 'one_logoff_spent',
    replan_count: Math.max(1, active?.replan_count ?? 0),
    mitigation: 'already logged off once this healing session and not on a safe spot: flee to the nearest reachable one' };
  if (!exitTriedRecently) return { strategy: 'leave_room', reason_code: 'one_logoff_spent_no_refuge',
    replan_count: (active.replan_count ?? 0) + 1,
    mitigation: 'no reachable safe spot here and the session logoff is spent: leave by the nearest permitted exit' };
  return { finish: true, outcome: 'refused',
    reason: 'one logoff per healing session, no reachable safe spot, and the way out was just tried: the ordinary ladder decides' };
}

// WHICH WAY OUT. The nearest reachable exit into a room the confinement allows -- for a farm strategy that is its own
// fall-back (kocatan-avar-warriors: 2115 -> 2013, the guard tower). A confinement is the operator's and is not waived here
// (the leave-to-recover rung in passFleeAndRest refuses the same exits): with no permitted exit the answer is null.
export function spentSessionExit(exits = [], { here = null, confine = null } = {}) {
  const allowed = Array.isArray(confine) && confine.length ? new Set(confine.map(Number)) : null;
  const usable = (Array.isArray(exits) ? exits : []).filter(e => e && e.to != null && e.reachable !== false
    && Number(e.to) !== Number(here) && Number(e.to) !== 1 && (!allowed || allowed.has(Number(e.to))));
  usable.sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999));
  return usable[0] ?? null;
}
