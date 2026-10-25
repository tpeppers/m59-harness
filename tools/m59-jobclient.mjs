// JOB CLIENT: A SCRIPT PUTS ITSELF ON THE BROKER'S JOB BOARD IN ONE CALL, AND NEVER FAILS BECAUSE THE BOARD IS AWAY.
//
//   import { registerJob } from '../../tools/m59-jobclient.mjs';
//   const job = await registerJob({ name: 'fire-queue', agents: ['t17', 't20'],
//     restart: 'node substrate/scratch/fire-queue.mjs', stopFile: 'substrate/scratch/fire-queue.stop' });
//   job.addPid(child.pid);          // a REPL child that holds the leases -- a pause kills it too
//   ...
//   await job.end({ ok: true, result: 'wave A sent' });
//
// The board (m59-jobboard.mjs, held by the broker; see docs/m59-operations.md "The job board") is what an alert pauses
// and resumes: `job_pause` kills every pid a job names and touches its stop file, and `job_resume` spawns its
// `restart` command once the alert is over. A job that must not be interrupted (the island ride) says
// `finishOnAlert: true`.
//
// UNREACHABLE IS A NO-OP, SAID ONCE. Registration is bookkeeping, never a precondition: a broker that is restarting,
// a lab with no broker, a test -- every call here resolves, the handle's methods do nothing, and one line says so.
// A script must never refuse to drive characters because the board did not answer.
//
// Fleetscripts do not call this: the runner (m59-fleetscript.mjs) registers every run itself, and the REPL hands it
// the line that would run it again (setJobContext), which is the restart.
import { resolveControlUrl } from './m59-fleetpath.mjs';
import { processStartedAt } from './runtime/process-identity.mjs';

let warned = false;
const say = (onLog, m) => { if (!warned) { warned = true; (onLog ?? console.log)(`[jobs] ${m}`); } };

async function tool(name, args, ms = 15_000) {
  const r = resolveControlUrl();
  if (!r.url) throw new Error(r.why ?? 'no broker named');
  const res = await fetch(r.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms) });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message ?? String(d.error));
  const text = d?.result?.content?.[0]?.text;
  if (d?.result?.isError) throw new Error(String(text ?? 'refused').replace(/^error:\s*/i, ''));
  try { return JSON.parse(text); } catch { return text; }
}
export const jobTool = tool;

const NOOP = Object.freeze({ id: null, registered: false, addPid() {}, heartbeat: async () => {}, end: async () => {} });

/**
 * Register this process as a job. Resolves to a handle whose methods never throw.
 * spec: { name, agents, kind?, restart?: string | { cmd, cwd }, stopFile?, pids?, finishOnAlert?, heartbeatMs?, resumes?,
 *         note?, onLog? }
 */
export async function registerJob(spec = {}) {
  const heartbeatMs = spec.heartbeatMs ?? 60_000;
  let job;
  try {
    job = await tool('job_register', {
      name: spec.name, kind: spec.kind ?? 'script', agents: spec.agents ?? [], owner_pid: process.pid,
      owner_start: processStartedAt(process.pid) ?? undefined, heartbeat_ms: heartbeatMs || undefined,
      restart: spec.restart ? (typeof spec.restart === 'string' ? { cmd: spec.restart, cwd: spec.cwd ?? process.cwd() } : spec.restart) : undefined,
      stop: { stopFile: spec.stopFile ?? null, pids: spec.pids ?? [] }, finish_on_alert: spec.finishOnAlert === true,
      resumes: spec.resumes ?? process.env.M59_JOB_RESUMES ?? undefined, note: spec.note ?? undefined,
    });
  } catch (e) { say(spec.onLog, `job board unreachable, running unregistered: ${e.message}`); return NOOP; }
  const id = job?.id;
  if (!id) { say(spec.onLog, `job board did not register "${spec.name}"`); return NOOP; }
  const beat = heartbeatMs ? setInterval(() => { tool('job_heartbeat', { id }).catch(() => {}); }, heartbeatMs) : null;
  beat?.unref?.();
  let ended = false;
  return {
    id, registered: true, job,
    addPid(pid) { if (pid) tool('job_heartbeat', { id, add_pid: pid }).catch(() => {}); },
    heartbeat: (extra = {}) => tool('job_heartbeat', { id, ...extra }).catch(() => {}),
    async end({ ok = true, result = null } = {}) {
      if (ended) return; ended = true;
      if (beat) clearInterval(beat);
      await tool('job_end', { id, ok, result: result == null ? undefined : String(result).slice(0, 300) }).catch(() => {});
    },
  };
}

// THE LINE THAT WOULD RUN THIS AGAIN. The REPL sets it before each script it runs; the fleetscript runner reads it
// when it registers the run, so a paused fleetscript is resumed by replaying exactly what was typed.
let context = null;
export function setJobContext(ctx) { context = ctx ?? null; }
export function getJobContext() { return context; }
