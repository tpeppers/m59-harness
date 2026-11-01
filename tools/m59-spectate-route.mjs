// WHICH KEEPER IS DRIVING THIS CHARACTER: its own process, or a SPECTATE keeper on a person's connection.
//
// A spectate keeper (tools/m59-spectate-keeper.mjs) is the SAME keeper process (m59-keeper-process.mjs)
// attached to a person's own client connection through the proxy, started when they pick "Relinquish
// control to Keeper" on the PLAN tab. While it drives, the character's NORMAL keeper process is
// alive but offline -- the server allows one connection per character, and the person's client holds
// it -- so its `/state` is frozen and every order sent to it goes nowhere.
//
// Measured 2026-11-01 on t17 (Zoot): the broker's `fleet`, `status` and `autopilot` put him in room 566
// while he was in the East Tower (2013), and every broker order -- autopilot start, travel, cast,
// supply -- went to the offline keeper instead of the one holding the body. Operator: "can we get that
// so it's seamless whichever way it's being handled it's the same modules?.. because I'd like to be
// able to control through any interface".
//
// So the spectate keeper publishes where its HTTP API is (`http_port`, `pid`, the roster it serves) in
// its heartbeat, `substrate/spectate/<agent>.json`, and every reader -- the broker's KeeperProxy,
// `scanKeepers`, the plan desk -- asks the ONE decision below which keeper to talk to.
//
// THE DECISION IS PURE, so it is tested offline (m59-spectate-route-test.mjs). The two impure inputs --
// the heartbeat file and a `/live` reply from the port it names -- are read by the caller and handed in.
//
// WHAT IT GUARANTEES:
//   - A heartbeat is only believed when it is fresh, not `stopped`, names THIS agent and THIS roster,
//     and its pid is alive. Anything else is the normal keeper, exactly as before.
//   - `holds` is the conservative half: any believable heartbeat means a spectate keeper may hold the
//     body, so the normal keeper must not log in (that would bump the person and the spectate keeper).
//     It does not need the port to answer; one driver per character does not wait for a probe.
//   - `route: 'spectate'` needs MORE: a `/live` reply from the heartbeat's port, recent, naming this
//     agent, this character and the HEARTBEAT'S pid. The fleet has had cached-port bugs where a port
//     answered for the wrong agent (2026-10-04, 2026-08-26); a port that answers for somebody else is
//     `refused` -- never routed to, and never silently swapped for the offline keeper either.

import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateKeeperSample } from './runtime/keeper-liveness.mjs';

/** A heartbeat older than this is a spectate keeper that stopped beating (it beats every second). */
export const SPECTATE_BEAT_MAX_AGE_MS = 10_000;
/** A `/live` proof older than this must be asked again before anything is routed on it. */
export const SPECTATE_PROBE_MAX_AGE_MS = 15_000;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The heartbeat directory: this checkout's substrate/spectate, unless M59_SPECTATE_DIR says otherwise. */
export function spectateDir({ root = null, env = process.env } = {}) {
  if (!root && env.M59_SPECTATE_DIR) return resolve(env.M59_SPECTATE_DIR);
  return join(root ?? REPO, 'substrate', 'spectate');
}
export const spectateBeatPath = (agent, opts = {}) => join(spectateDir(opts), `${agent}.json`);

export function readSpectateBeat(agent, { dir = null, ...opts } = {}) {
  try { return JSON.parse(readFileSync(join(dir ?? spectateDir(opts), `${agent}.json`), 'utf8')); }
  catch { return null; }
}

/** Every heartbeat in the directory; an unreadable one is skipped. Roster copies and logs are not heartbeats. */
export function listSpectateBeats({ dir = null, ...opts } = {}) {
  const d = dir ?? spectateDir(opts);
  let names = [];
  try { names = readdirSync(d); } catch { return []; }
  return names.filter(f => /^[a-z0-9_-]{1,40}\.json$/.test(f) && !f.endsWith('-roster.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return null; } })
    .filter(b => b && typeof b === 'object' && b.agent);
}

/** Atomic: a reader never sees half a heartbeat. Never throws -- a heartbeat is evidence, not a dependency. */
export function writeSpectateBeat(path, beat) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(beat));
    renameSync(path + '.tmp', path);
    return true;
  } catch { return false; }
}

// Windows paths compare case-insensitively; a roster named two ways is still one roster.
const samePath = (a, b) => !!a && !!b &&
  resolve(String(a)).replace(/\\/g, '/').toLowerCase() === resolve(String(b)).replace(/\\/g, '/').toLowerCase();

const positivePid = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const validPort = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null; };

/**
 * MAY A SPECTATE KEEPER BE HOLDING THIS CHARACTER? The conservative question: it gates the normal
 * keeper's login, so it says yes on any believable heartbeat and does not wait for the port to answer.
 * A heartbeat that names no roster (one written before routing existed) still holds: it is in this
 * checkout's directory, under this agent's name, with a live pid.
 */
export function spectateHolds(beat, { agent, roster = null, now = Date.now(), pidAlive,
                                       maxAgeMs = SPECTATE_BEAT_MAX_AGE_MS } = {}) {
  if (!beat || typeof beat !== 'object') return { holds: false, why: 'no spectate heartbeat' };
  if (String(beat.agent ?? '') !== String(agent)) return { holds: false, why: `heartbeat names ${beat.agent ?? 'nobody'}, not ${agent}` };
  if (roster && beat.roster && !samePath(beat.roster, roster))
    return { holds: false, why: `heartbeat serves another roster (${beat.roster})` };
  if (/^stopped/.test(String(beat.state ?? ''))) return { holds: false, why: `spectate keeper ${beat.state}` };
  const at = Number(beat.at);
  if (!Number.isFinite(at) || now - at > maxAgeMs)
    return { holds: false, why: `heartbeat is stale (${Number.isFinite(at) ? Math.round((now - at) / 1000) + 's' : 'no time'})` };
  const pid = positivePid(beat.pid);
  if (!pid) return { holds: false, why: 'heartbeat has no pid' };
  if (typeof pidAlive !== 'function' || !pidAlive(pid)) return { holds: false, why: `spectate keeper pid ${pid} is gone` };
  return { holds: true, pid, why: `spectate keeper pid ${pid} is ${beat.state ?? 'running'}` };
}

/**
 * WHERE TO SEND A READ OR AN ORDER FOR `agent`.
 *
 *   { route: 'keeper' }    its own keeper process, exactly as before (no spectate keeper holds it,
 *                           or one holds it that cannot be routed to -- `holds` says which)
 *   { route: 'probe' }     a spectate keeper holds it and names a port; ask `/live` there, then ask again
 *   { route: 'spectate' }  verified: talk to `port`, addressed to `pid`
 *   { route: 'refused' }   the port answered for somebody else, or with nothing usable: send NOTHING
 *
 * `probe` is `{ port, pid, at, value }`: the port and heartbeat pid it was asked about, when, and the
 * `/live` body. A probe of a different port or pid is a probe of a different process and is ignored.
 */
export function chooseKeeperRoute({ agent, character = null, roster = null, beat = null, probe = null,
                                    now = Date.now(), pidAlive,
                                    maxBeatAgeMs = SPECTATE_BEAT_MAX_AGE_MS,
                                    maxProbeAgeMs = SPECTATE_PROBE_MAX_AGE_MS } = {}) {
  const held = spectateHolds(beat, { agent, roster, now, pidAlive, maxAgeMs: maxBeatAgeMs });
  if (!held.holds) return { route: 'keeper', holds: false, why: held.why };
  const pid = held.pid;
  const port = validPort(beat.http_port);
  // HELD, BUT NOT ROUTABLE. A spectate keeper from before routing serves no API; one that has not bound
  // its port yet has none to give. Either way the normal keeper still must not log in.
  if (!port) return { route: 'keeper', holds: true, pid,
                      why: `spectate keeper pid ${pid} publishes no HTTP port (${beat.state ?? 'starting'}); ` +
                           'it predates routing or has not bound yet' };
  if (!beat.roster) return { route: 'keeper', holds: true, pid, why: 'spectate heartbeat names no roster; not routing to it' };
  const fresh = probe && Number(probe.port) === port && Number(probe.pid) === pid &&
    Number.isFinite(Number(probe.at)) && now - Number(probe.at) <= maxProbeAgeMs;
  if (!fresh) return { route: 'probe', holds: true, port, pid, why: `spectate keeper pid ${pid} on ${port} not yet proven` };
  if (probe.value == null) return { route: 'refused', holds: true, port, pid,
                                    why: `spectate keeper port ${port} did not answer${probe.error ? ` (${probe.error})` : ''}` };
  const valid = validateKeeperSample(probe.value, { agent, character, pid });
  if (!valid.ok) return { route: 'refused', holds: true, port, pid, why: `spectate keeper port ${port}: ${valid.reason}` };
  return { route: 'spectate', holds: true, port, pid, sample: probe.value,
           why: `spectate keeper pid ${pid} on ${port} is driving` };
}

/**
 * DOES THE `piloted` FLAG STILL KEEP THE BROKER'S HANDS OFF? Only when nobody but the person is driving.
 * A person who relinquished control to a spectate keeper is watching, not playing: the keeper's orders
 * are the character's orders. With no spectate keeper running, a piloted character is hands-off as ever.
 */
export function humanHeld({ piloted, route }) {
  return !!piloted && route?.route !== 'spectate';
}
