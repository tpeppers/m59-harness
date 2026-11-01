// EVERY FLEETSCRIPT STARTS FROM THE WORLD AS IT IS: who is holding the body, and where it is standing, read LIVE.
//
// The pure half of FleetScript's `liveStart` guarantee (tools/m59-fleetscript.mjs, UNSAFE_GUARANTEES.liveStart),
// split out so the decisions can be tested without a broker. The runner does the reading; this decides.
//
// THE INCIDENT, 2026-11-01 06:15-06:30Z. The operator and a Claude session both drive the prod fleet.
//   * Piggy (t14) was being piloted by the operator. The broker's `fleet` row still put him in room 537 on the
//     mainland -- a pre-pilot snapshot -- when he had been walked to 2143 on the island. A local fleetscript
//     (island-move-in) written for a mainland start code-kicked the operator and walked Piggy from 2143 back OUT
//     toward the Icky Cave (27).
//   * Minutes later the operator ran the same script on Waldorf (t4) from the TUI's MANAGE tab, and the same thing
//     happened. Neither side could see the other's run in time, and neither could cancel the other's job.
//   * The Piggy run's owner process died and its walk kept going; the next start "took over a stale lock" and said
//     nothing about the journey still in flight.
//
// SO, BEFORE THE LOCK AND BEFORE ANYTHING WALKS, PER AGENT:
//   a. a body a PERSON is piloting is refused, naming the client pid and how long it has been held -- unless the
//      script (or the invocation) declared `codeKick`, in which case the claim is released, the keeper is waited
//      back into the world, and the pilot state is READ AGAIN before step 0;
//   b. a body another LIVE job on the board holds is refused, naming the job id, script and owner pid. "Live" is
//      judged HERE, on this machine, by the owner pid AND its start time (pids are reused on Windows) AND the board's
//      own heartbeat rule -- never by the row's `state` alone, because a REPL killed with `taskkill /T /F` never
//      closes its row. A job whose owner is gone is TAKEN OVER at once, with its in-flight movement cancelled first
//      and its row retired so no alert release ever resumes it into the middle of this run;
//   c. the room is read live (`look`) into `state.startRoom`, never from the broker's snapshot fields.
//
// Helpers for scripts, at the bottom: `legFor` (which leg does this room start), `liveRoom` (where is it NOW).
import { processStartedAt, START_TIME_TOLERANCE_MS } from './runtime/process-identity.mjs';

/** The board's own orphan rule (m59-jobboard.mjs sweep): a job that promised heartbeats and stopped sending them. */
export const JOB_STALE_FLOOR_MS = 5 * 60_000;

const age = ms => {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(s)) return '?';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
export { age as formatAge };

/** `kill(pid, 0)`: is SOMETHING running under this number. Never "is it ours" -- see `jobOwnerVerdict`. */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }       // exists, owned by somebody else: alive
}

// ---------------------------------------------------------------- a. a person at the controls

/**
 * Is a person piloting `agent`? Reads `pilot action=status` first (`piloted: [{agent, pid, alive, held_s, holder?}]`)
 * and the fleet row's `piloted: {since, pid, remote?}` second.
 *
 * Returns `{ held: true, pid, heldMs, holder, source }`, `{ held: false, source }`, or `{ held: null }` when neither
 * answer could be read -- which the caller must NOT read as "nobody". A claim whose client the broker itself reports
 * dead (`alive: false`) is not a person at the controls: the broker releases it on its next look.
 */
export function pilotHold(agent, { pilotStatus = null, fleetRows = null, now = Date.now() } = {}) {
  const list = Array.isArray(pilotStatus?.piloted) ? pilotStatus.piloted : null;
  if (list) {
    // A RELINQUISHED CHARACTER IS NOT HELD (feat/spectate-gaps): its claim stays while a spectate keeper drives the person's
    // own connection, and the broker says so with `human_held: false` -- the fleet may run it, which is the point of
    // relinquishing. An older broker sends no `human_held`, and the claim then counts as before.
    const p = list.find(x => String(x?.agent) === String(agent) && x?.alive !== false && x?.human_held !== false);
    if (!p) return { held: false, source: 'pilot status' };
    return { held: true, pid: p.pid ?? null, heldMs: Number.isFinite(Number(p.held_s)) ? Number(p.held_s) * 1000 : null,
             holder: p.holder ?? null, source: 'pilot status' };
  }
  const rows = Array.isArray(fleetRows) ? fleetRows : null;
  if (rows) {
    const row = rows.find(r => String(r?.agent) === String(agent));
    if (!row) return { held: null, source: 'fleet row (agent not on it)' };
    const p = row.piloted;
    if (!p || row.human_held === false) return { held: false, source: 'fleet row' };
    return { held: true, pid: p.pid ?? null, heldMs: Number.isFinite(Number(p.since)) ? now - Number(p.since) : null,
             holder: p.remote ?? null, source: 'fleet row' };
  }
  return { held: null };
}

export function pilotRefusal(agent, h) {
  return `${agent} is being PILOTED BY A PERSON -- ` +
    (h.holder ? `remote holder "${h.holder}"` : `client pid ${h.pid ?? '?'}`) +
    `, held ${h.heldMs == null ? '?' : age(h.heldMs)} (${h.source}). Two controllers on one body is the ` +
    `2026-11-01 Piggy/Waldorf incident. Wait for them to finish, or declare \`codeKick: true\` on the script ` +
    `(or pass codeKick=true) to release their claim and take the body.`;
}

// ---------------------------------------------------------------- b. another live job

/**
 * Is the job that holds this body still being driven by a live owner? Judged on this machine, not on the row's
 * state: `taskkill /T /F` leaves a row `running` for ever, and the broker's sweep and this one may disagree for a
 * moment. Returns `{ live, why }`.
 *
 *   own process, a run still in flight here      live (a concurrent run in the same process)
 *   own process, not one of ours in flight       dead: a leftover row whose end never reached the board
 *   owner pid not running                        dead
 *   owner pid running, recorded start differs    dead: the pid was reused (Windows does, within hours)
 *   no heartbeat past the board's own limit      dead: the board's orphan rule
 *   otherwise                                    live -- including a start time we could not read, because the
 *                                                dangerous mistake is calling a live driver dead
 */
export function jobOwnerVerdict(job, { selfPid = process.pid, ownJobIds = new Set(), alive = pidAlive,
                                       startOf = pid => processStartedAt(pid), now = Date.now(),
                                       tolerance = START_TIME_TOLERANCE_MS, staleFloorMs = JOB_STALE_FLOOR_MS } = {}) {
  const pid = Number(job?.owner_pid) || null;
  if (!pid) return { live: true, why: 'the job names no owner pid, so nothing here can prove it dead' };
  if (pid === selfPid)
    return ownJobIds.has(job.id) ? { live: true, why: 'a run still in flight in this same process' }
      : { live: false, why: `a leftover row from this process (pid ${pid}) that never reached the board's end` };
  if (!alive(pid)) return { live: false, why: `owner pid ${pid} is gone` };
  const recorded = Number(job.owner_start) || null;
  if (recorded) {
    let actual = null;
    try { actual = startOf(pid); } catch { actual = null; }
    if (actual != null && Math.abs(Number(actual) - recorded) > tolerance)
      return { live: false, why: `pid ${pid} is a different process now (started ${new Date(Number(actual)).toISOString()}, ` +
                                 `the job's owner started ${new Date(recorded).toISOString()})` };
  }
  const hb = Number(job.heartbeat_ms) || 0;
  if (hb) {
    const limit = Math.max(3 * hb, staleFloorMs);
    const last = Number(job.heartbeat_at ?? job.started_at) || null;
    if (last && now - last > limit) return { live: false, why: `no heartbeat for ${age(now - last)} (owner pid ${pid})` };
  }
  return { live: true, why: recorded ? `owner pid ${pid} is running and is the same process` :
    `owner pid ${pid} is running (the row recorded no start time, so pid reuse cannot be ruled out)` };
}

/** Which board rows hold any of `agents`, and what to do about each: refuse (live), take over (dead), or note (paused). */
export function judgeJobs(jobs, agents, opts = {}) {
  const want = new Set((agents ?? []).map(String));
  const live = [], dead = [], paused = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const mine = (j?.agents ?? []).map(String).filter(a => want.has(a));
    if (!mine.length) continue;
    if (j.state === 'paused') { paused.push({ job: j, agents: mine }); continue; }
    if (!['running', 'orphaned'].includes(j.state)) continue;
    const v = jobOwnerVerdict(j, opts);
    (v.live ? live : dead).push({ job: j, agents: mine, why: v.why });
  }
  return { live, dead, paused };
}

export function jobRefusal({ job, agents, why }, now = Date.now()) {
  return `${agents.join(', ')} ${agents.length > 1 ? 'are' : 'is'} held by LIVE job ${job.id} "${job.name}" ` +
    `(${job.kind ?? 'job'}, owner pid ${job.owner_pid ?? '?'}, started ${age(now - (Number(job.started_at) || now))} ago` +
    `${job.note ? `, ran as: ${String(job.note).slice(0, 80)}` : ''}) -- ${why}. Wait for it, or stop it: ` +
    `node tools/m59-jobs.mjs cancel ${job.id}`;
}

// ---------------------------------------------------------------- c. where the run starts, for scripts

/**
 * WHICH LEG DOES THIS ROOM START? The first `[name, test]` whose test accepts the room, else `otherwise`.
 * A test is a predicate, an array of room numbers, or a single room number.
 *
 *   const leg = legFor(state.startRoom, [
 *     ['farm',   [2143, 2144, 2101]],
 *     ['island', r => r >= 2000 && r < 2500],
 *     ['cave',   r => r >= 2500 && r <= 2505],
 *   ], 'mainland');
 *
 * An unreadable room (null) matches nothing and is `otherwise` only when `otherwise` says so -- pass
 * `{ unknown: '<leg>' }` to name what an unreadable room means, or the answer is null.
 */
export function legFor(room, legs = [], otherwise = null, { unknown = null } = {}) {
  const r = Number(room);
  if (room == null || !Number.isFinite(r)) return unknown;
  for (const [name, test] of legs) {
    const hit = typeof test === 'function' ? test(r)
      : Array.isArray(test) ? test.map(Number).includes(r)
      : Number(test) === r;
    if (hit) return name;
  }
  return otherwise;
}

/**
 * WHERE IS IT STANDING NOW -- `look`, never the broker's status or fleet snapshot (which for a character a person
 * has been playing is where it was BEFORE they took it). For a verify step deciding a mid-run leg:
 *
 *   verify(async ctx => { const here = await liveRoom(ctx); ... })
 *
 * Takes the verify `ctx` (`{ call, agent }`). Returns `{ room, name, you }`; `room` is null when unreadable.
 */
export async function liveRoom({ call, agent }, ms = 60_000) {
  const l = await call('look', { agent }, ms).catch(e => ({ error: e?.message ?? String(e) }));
  const n = Number(l?.room?.num);
  return { room: l?.error || !Number.isFinite(n) || n <= 0 ? null : n, name: l?.room?.name ?? null,
           you: l?.you ?? null, ...(l?.error ? { error: String(l.error) } : {}) };
}
