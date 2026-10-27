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
// back to FULL. Inside one session the logoff fires at most once, whatever the cause; after it the body keeps ONE safe
// spot until healed; a body that comes back OFF a spot flees to the nearest reachable one first (staysPut). Persisted per character (substrate/.healing/), so a keeper handoff cannot hand out a second logoff.
// Pure apart from the small file.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEALING_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', '.healing');
// Read at call time, so a test can point it at a temp dir after its imports have run.
const healingDir = () => process.env.M59_HEALING_DIR || HEALING_DIR;
// A session older than this is stale (a body that never reached full, a keeper that died): it is closed, not trusted.
export const SESSION_MAX_MS = 2 * 3_600_000;
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
  if (Number.isFinite(hp) && Number.isFinite(max) && max > 0 && hp >= max) { writeSession(agent, null, dir); return null; }
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
