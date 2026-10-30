// THE JOB BOARD: EVERY SCRIPT THAT DRIVES CHARACTERS, HELD OPEN BY THE BROKER, SO AN ALERT CAN PAUSE AND RESUME IT.
//
// Operator, 2026-10-25: "Set it up so that any scripts can register themselves to be cancelled and/or restarted by
// alerts via registering themselves, so that there's no need for you to manually kill/restart them" -- then: "Can we
// use it everywhere and just be able to generate reports of all current/paused/orphaned 'jobs' ... a universal job
// board that's held open by the broker". The incident it ends: a hostile logged in while archers, a fire queue and a
// dozen one-off movers held characters' leases, and the retreat could not move a body until each run was found and
// killed by hand -- one kill pattern too broad, one restart forgotten, one snapshot written mid-walk.
//
// A JOB is one run that holds characters: { id, name, kind ('fleetscript'|'script'), fleet, agents, owner_pid,
// owner_start, started_at, heartbeat_at, heartbeat_ms, state, stop: { pid?, stopFile? }, restart: { cmd, cwd } | null,
// finish_on_alert, paused_by/paused_at/why, ended_at/result }.
//
//   running   the owner is alive and has not ended the job
//   paused    stopped by pause() (an alert, an operator); its restart is kept
//   resumed   pause()d and then resume()d: the restart command was spawned (resumed_pid); the new run registers its
//             own job, which names this one in `resumes`
//   orphaned  the owner died without ending it, its pid now belongs to a different process (start time differs), or a
//             job that promised heartbeats stopped sending them
//   done / failed / cancelled   ended; kept as bounded history
//
// PURE BY INJECTION. Every effect -- the clock, "is this pid alive", "when did it start", kill, spawn, touching a stop
// file, the file the board persists to -- is a constructor argument, so m59-jobs-test.mjs drives the whole state
// machine with fakes and no process is ever killed or started by a test. The broker passes the real ones.
import fs from 'node:fs';
import { dirname } from 'node:path';

export const LIVE_STATES = Object.freeze(['running', 'paused', 'resumed', 'orphaned']);
export const END_STATES = Object.freeze(['done', 'failed', 'cancelled']);
const START_TOLERANCE_MS = 2000;          // the same tolerance runtime/process-identity.mjs gives a recorded start

const asList = v => Array.isArray(v) ? v.map(String).filter(Boolean)
  : String(v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

export class JobBoard {
  constructor({ file = null, fleet = null, now = () => Date.now(), pidAlive = () => true, pidStarts = () => new Map(),
                kill = () => {}, spawnDetached = () => null, touch = () => {}, historyMax = 300, staleMs = 5 * 60_000 } = {}) {
    Object.assign(this, { file, fleet, now, pidAlive, pidStarts, kill, spawnDetached, touch, historyMax, staleMs });
    this.jobs = new Map();
    this.seq = 0;
    // REVISION counts every change; a handover compares it to tell "the board moved after the snapshot" (late state).
    this.revision = 0;
    // A WARM SUCCESSOR READS BUT NEVER WRITES: until it owns the fleet the file is the predecessor's (handover).
    this.persist = true;
  }

  // ---------------------------------------------------------------- the live broker handover (runtime/broker-handover.mjs)
  //
  // The predecessor exports the board as part of its handover snapshot (and flushes it to disk); the successor imports
  // it before adopting, verifies every running job (owner alive, same start time, heartbeat fresh) BEFORE it commits and
  // reports what it orphaned in the receipt. Anything that changed on the predecessor after the snapshot -- a job call
  // admitted just before the freeze that finished after it -- arrives as `late-state` before the commit and replaces
  // the import. Requests arriving during the freeze are held and forwarded to the successor, so they are never lost.
  // On a rollback nothing here ran on the predecessor except a copy and a flush: its board is untouched.
  exportSnapshot() {
    return { format: 'm59-jobs/1', fleet: this.fleet, seq: this.seq, revision: this.revision, at: this.now(),
             jobs: JSON.parse(JSON.stringify([...this.jobs.values()])) };
  }
  importSnapshot(s) {
    if (!s || s.format !== 'm59-jobs/1' || !Array.isArray(s.jobs)) return { ok: false, why: 'not a job board snapshot' };
    this.jobs = new Map(JSON.parse(JSON.stringify(s.jobs)).map(j => [j.id, j]));   // a copy: never share with the sender
    this.seq = Math.max(Number(s.seq) || 0, this.seq);
    this.revision = Number(s.revision) || 0;
    return { ok: true, jobs: this.jobs.size, revision: this.revision };
  }
  verifyAfterHandover() {
    const before = [...this.jobs.values()].filter(j => j.state === 'running').length;
    const orphaned = this.sweep().map(j => ({ id: j.id, name: j.name, agents: j.agents, why: j.history?.at(-1)?.why ?? null }));
    return { running_before: before, running: before - orphaned.length, orphaned,
             paused: [...this.jobs.values()].filter(j => j.state === 'paused').length, revision: this.revision };
  }

  // ---------------------------------------------------------------- persistence
  load() {
    if (!this.file) return this;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const j of d.jobs ?? []) this.jobs.set(j.id, j);
      this.seq = Number(d.seq) || this.jobs.size;
      this.revision = Number(d.revision) || 0;
    } catch { /* no board yet, or unreadable: start empty rather than refuse to serve */ }
    return this;
  }
  save() {
    this.revision++;
    if (!this.file || this.persist === false) return;
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ fleet: this.fleet, seq: this.seq, revision: this.revision, saved_at: this.now(), jobs: [...this.jobs.values()] }, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error(`[jobs] could not save ${this.file}: ${e.message}`); }
  }
  trim() {
    const ended = [...this.jobs.values()].filter(j => END_STATES.includes(j.state) || j.state === 'resumed')
      .sort((a, b) => (a.ended_at ?? a.started_at) - (b.ended_at ?? b.started_at));
    while (ended.length > this.historyMax) this.jobs.delete(ended.shift().id);
  }

  // ---------------------------------------------------------------- lifecycle
  register(spec = {}) {
    if (!spec.name) throw new Error('job_register needs a name');
    const t = this.now();
    const id = `j${(++this.seq).toString(36)}-${t.toString(36)}`;
    const job = {
      id, name: String(spec.name), kind: spec.kind === 'fleetscript' ? 'fleetscript' : 'script',
      fleet: spec.fleet ?? this.fleet, agents: asList(spec.agents),
      owner_pid: Number(spec.owner_pid ?? spec.pid) || null, owner_start: Number(spec.owner_start) || null,
      started_at: t, heartbeat_at: t, heartbeat_ms: Number(spec.heartbeat_ms) || null,
      state: 'running',
      stop: { pid: Number(spec.stop?.pid ?? spec.owner_pid ?? spec.pid) || null, stopFile: spec.stop?.stopFile ?? spec.stopFile ?? null,
              pids: asList(spec.stop?.pids ?? spec.pids).map(Number).filter(Boolean) },
      restart: spec.restart?.cmd ? { cmd: String(spec.restart.cmd), cwd: spec.restart.cwd ?? null }
        : typeof spec.restart === 'string' && spec.restart ? { cmd: spec.restart, cwd: null } : null,
      finish_on_alert: spec.finish_on_alert === true || spec.finishOnAlert === true,
      resumes: spec.resumes ?? null, note: spec.note ?? null, history: [{ at: t, state: 'running', why: 'registered' }],
    };
    if (job.resumes && this.jobs.has(job.resumes)) this.mark(this.jobs.get(job.resumes), 'resumed', `resumed as ${id}`, { resumed_as: id });
    this.jobs.set(id, job);
    this.trim();
    this.save();
    return job;
  }
  mark(job, state, why, extra = {}) {
    Object.assign(job, extra, { state });
    if (END_STATES.includes(state) && !job.ended_at) job.ended_at = this.now();
    (job.history ??= []).push({ at: this.now(), state, why: why ?? null });
    if (job.history.length > 20) job.history.splice(0, job.history.length - 20);
    return job;
  }
  get(id) { return this.jobs.get(id) ?? null; }
  heartbeat(id, { agents, note } = {}) {
    const j = this.get(id);
    if (!j) return { ok: false, why: `no job ${id}` };
    j.heartbeat_at = this.now();
    if (agents) j.agents = asList(agents);
    if (note != null) j.note = note;
    // A heartbeat from an orphan is the owner proving it is alive after all (a slow pid probe, a broker restart).
    if (j.state === 'orphaned') this.mark(j, 'running', 'heartbeat from the owner');
    this.save();
    return { ok: true, state: j.state };
  }
  addPid(id, pid) {
    const j = this.get(id);
    if (!j || !Number(pid)) return { ok: false };
    j.stop.pids = [...new Set([...(j.stop.pids ?? []), Number(pid)])];
    this.save();
    return { ok: true };
  }
  end(id, { result = null, ok = true, state = null } = {}) {
    const j = this.get(id);
    if (!j) return { ok: false, why: `no job ${id}` };
    // A job ended by its owner while paused (the alert killed the REPL child, the wrapper exited) stays paused:
    // the pause is what is true, and the restart must survive it.
    if (j.state === 'paused' || j.state === 'resumed') return { ok: true, state: j.state, kept: true };
    this.mark(j, state ?? (ok ? 'done' : 'failed'), 'ended by its owner', { result });
    this.trim();
    this.save();
    return { ok: true, state: j.state };
  }

  // ---------------------------------------------------------------- orphans
  sweep() {
    const running = [...this.jobs.values()].filter(j => j.state === 'running');
    if (!running.length) return [];
    const pids = [...new Set(running.map(j => j.owner_pid).filter(Boolean))];
    const starts = pids.length ? this.pidStarts(pids) : new Map();
    const t = this.now(), changed = [];
    for (const j of running) {
      let why = null;
      if (j.owner_pid && !this.pidAlive(j.owner_pid)) why = `owner pid ${j.owner_pid} is gone`;
      else if (j.owner_pid && j.owner_start) {
        const s = starts.get?.(j.owner_pid);
        if (s != null && Math.abs(s - j.owner_start) > START_TOLERANCE_MS) why = `pid ${j.owner_pid} is a different process now`;
      }
      if (!why && j.heartbeat_ms) {
        const limit = Math.max(3 * j.heartbeat_ms, this.staleMs);
        if (t - (j.heartbeat_at ?? j.started_at) > limit) why = `no heartbeat for ${Math.round((t - j.heartbeat_at) / 1000)}s`;
      }
      if (why) { this.mark(j, 'orphaned', why); changed.push(j); }
    }
    if (changed.length) this.save();
    return changed;
  }

  // ---------------------------------------------------------------- pause / resume
  select({ ids, agents, all = false, states = ['running'] } = {}) {
    const idSet = new Set(asList(ids)), agentSet = new Set(asList(agents));
    return [...this.jobs.values()].filter(j => states.includes(j.state) &&
      (all || idSet.has(j.id) || (agentSet.size && j.agents.some(a => agentSet.has(a)))));
  }
  pause({ ids, agents, all = false, by = null, why = null, force = false } = {}) {
    this.sweep();
    const out = { paused: [], left_to_finish: [], skipped: [] };
    for (const j of this.select({ ids, agents, all })) {
      if (j.finish_on_alert && !force) { out.left_to_finish.push(j.id); continue; }
      if (j.stop.stopFile) { try { this.touch(j.stop.stopFile); } catch {} }
      for (const pid of new Set([j.stop.pid, ...(j.stop.pids ?? [])].filter(Boolean)))
        if (this.pidAlive(pid)) { try { this.kill(pid); } catch {} }
      this.mark(j, 'paused', why ?? 'paused', { paused_by: by, paused_at: this.now(), paused_why: why ?? null });
      out.paused.push(j.id);
    }
    if (out.paused.length) this.save();
    return out;
  }
  // RETIRE A JOB SO NOTHING BRINGS IT BACK. `pause` keeps the restart on purpose, and an alert's own release resumes
  // what it paused -- so a job paused by a tripwire over characters a launch is about to take restarts in the middle of
  // the launch. On 2026-10-29 `buy-sapphires [t17,t20]` and `walk-legs [t10]` sat paused by the island-PvP tripwire:
  // the solo avar-road errands that had just killed Lew and Zoot. `cancel` kills a live one exactly as `pause` does,
  // then marks it cancelled, which `resume` never selects. By ids or by agents only: there is no "cancel everything".
  cancel({ ids, agents, by = null, why = null } = {}) {
    this.sweep();
    const out = { cancelled: [] };
    for (const j of this.select({ ids, agents, states: ['running', 'paused', 'resumed', 'orphaned'] })) {
      const was = j.state;
      if (['running', 'resumed', 'orphaned'].includes(was)) {
        if (j.stop.stopFile) { try { this.touch(j.stop.stopFile); } catch {} }
        for (const pid of new Set([j.stop.pid, j.resumed_pid, ...(j.stop.pids ?? [])].filter(Boolean)))
          if (this.pidAlive(pid)) { try { this.kill(pid); } catch {} }
      }
      this.mark(j, 'cancelled', why ?? 'cancelled', { cancelled_by: by, cancelled_at: this.now(), was });
      out.cancelled.push({ id: j.id, name: j.name, was, agents: j.agents });
    }
    if (out.cancelled.length) this.save();
    return out;
  }
  resume({ ids, all = false, by = null } = {}) {
    const out = { resumed: [], cancelled: [] };
    for (const j of this.select({ ids, all, states: ['paused'] })) {
      if (!j.restart?.cmd) { this.mark(j, 'cancelled', 'paused with nothing to restart'); out.cancelled.push(j.id); continue; }
      if (j.stop.stopFile) { try { this.touch(j.stop.stopFile, { remove: true }); } catch {} }
      let pid = null;
      try { pid = this.spawnDetached(j.restart.cmd, j.restart.cwd, { resumes: j.id }); } catch (e) { pid = null; j.resume_error = e.message; }
      this.mark(j, 'resumed', `restart spawned${by ? ` by ${by}` : ''}`, { resumed_at: this.now(), resumed_pid: pid });
      out.resumed.push({ id: j.id, pid });
    }
    if (out.resumed.length || out.cancelled.length) this.save();
    return out;
  }

  // ---------------------------------------------------------------- reading
  list({ state, agent, kind, fleet } = {}) {
    this.sweep();
    const states = asList(state);
    return [...this.jobs.values()].filter(j => (!states.length || states.includes(j.state)) &&
      (!agent || j.agents.includes(agent)) && (!kind || j.kind === kind) && (!fleet || j.fleet === fleet))
      .sort((a, b) => b.started_at - a.started_at);
  }
  report({ recent = 10 } = {}) {
    const all = this.list();
    const by = s => all.filter(j => j.state === s);
    return {
      fleet: this.fleet, at: this.now(),
      running: by('running'), paused: by('paused'), orphaned: by('orphaned'),
      resumed: by('resumed').slice(0, recent),
      recent: all.filter(j => END_STATES.includes(j.state)).slice(0, recent),
      held: [...new Set(all.filter(j => ['running', 'paused', 'orphaned'].includes(j.state)).flatMap(j => j.agents))],
    };
  }
}

/** One line per job, for the CLI and a terminal-width answer. */
export function formatJob(j, now = Date.now()) {
  const age = s => s == null ? '?' : s < 90_000 ? `${Math.round(s / 1000)}s` : s < 5_400_000 ? `${Math.round(s / 60_000)}m` : `${(s / 3_600_000).toFixed(1)}h`;
  return `${j.id.padEnd(16)} ${j.state.padEnd(9)} ${j.kind === 'fleetscript' ? 'fs' : 'sc'} ${String(j.name).slice(0, 34).padEnd(34)} ` +
    `[${j.agents.join(',')}] pid ${j.owner_pid ?? '-'} ${age(now - j.started_at)}` +
    (j.restart ? ' restart' : '') + (j.finish_on_alert ? ' finish-on-alert' : '') +
    (j.state === 'orphaned' || j.state === 'paused' ? ` — ${j.history?.at(-1)?.why ?? ''}` : '');
}
