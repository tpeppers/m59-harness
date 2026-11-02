// A KEEPER STAGED FOR A CHARACTER A PERSON IS PLAYING: warm on the new code, inert, and waiting for
// the person to let go before it logs on.
//
//   import { PendingSuccessors, pilotedRestartPlan, pendingVerdict } from './runtime/pending-successors.mjs';
//
// THE INCIDENT. Operator, 2026-11-02, deploy evening: `restart-keepers --fleet prod` handed off
// twenty-three keepers and said nothing at all about the twenty-fourth. Gonzo (t18) was being played
// through the DebugClient; a live broker handover twenty minutes earlier had PRESERVED his keeper
// under the human pilot (`piloted_preserved`), which keeps the process and its port but writes no
// keeperProcesses record -- and warRestartFleet only ever walked keeperProcesses. So t18 was dropped
// from the list before anything looked at him, no line was logged, and when the operator let go the
// SAME old keeper resumed the body on the old code. Somebody had to notice and hand him off by hand.
//
// The broker already knew how to replace a piloted keeper whose socket the person's client had
// bumped: a DORMANT SWAP (2026-10-07), which starts the replacement with a `pilot` hold, stops the
// old keeper, and lets the rejoin sweep wake the new one when the person is done. What it refused --
// loudly, but refused -- was every case where that swap is not safe RIGHT NOW: the person playing
// through the keeper's own connection (its socket is theirs), or an old keeper that would not say
// whether it is connected. Each of those left the body on old code with nothing to bring it forward.
//
// THE OPERATOR'S ASK, verbatim: "keepers can now do sort of a 'sleep start' where it starts up the
// code (e.g., the new code) but lays waiting to be activated, add an option to that where the
// keeper's started inert and waiting for me to log off before it logs on". So those cases now get a
// PENDING SUCCESSOR: a keeper process on the code on disk, started DORMANT with a record of its own
// (never written to the shared dormancy store, so nothing else wakes it), registered here and nowhere
// else -- not in keeperProcesses, not in sessions, never addressed by an order. It holds the
// account's ownership guard beside the old keeper's, exactly like a handoff replacement does, and
// sends NOTHING to the server: it has never logged in and cannot until it is woken.
//
// WHEN THE PERSON LETS GO (their client exits, a remote lease lapses, the spectate keeper's
// heartbeat ends -- every one of which makes `occupied` false), the successor takes over the way a
// normal handoff does: the old keeper is FENCED (POST /handoff -- it will not reconnect by any path),
// the successor is woken and logs in (a still-connected old keeper is dropped by the server, which
// is its cue to exit), and only once the successor answers in_game AND connected with its own pid
// does the broker swap its records; then the old keeper is told to stop, its socket already gone.
// The person's logoff is noticed by the pilot watch in seconds and acted on at once, so the body is
// out of the world for less time than the 45 s rejoin sweep used to leave it.
//
// THE RULES THAT MAKE IT SAFE, each of which the offline test drives:
//   * NEVER WHILE HELD. `occupied` is asked before anything is sent and asked AGAIN immediately
//     before the wake, after every await; a person who comes back in between is left alone and the
//     old keeper's fence is withdrawn.
//   * A RECORD THAT SAYS OUT STAYS OUT. If the shared dormancy store holds a hold that does not wake
//     on the person leaving (an operator hold, an evade), the successor takes that record instead of
//     logging in -- a dormant swap, decided at the moment it can actually be decided.
//   * ONE ATTEMPT. A take-over that fails stops the successor, withdraws the fence, and forgets it:
//     the old keeper and the rejoin sweep then do exactly what they did before this existed. Retrying
//     would keep the body out of the world while the sweep steps over it.
//   * BOUNDED. A successor is a whole keeper process (~500 MB on prod). The broker stages one only
//     when the restart memory gate passes (m59-keeper-restart.mjs), and gives up after `maxWaitMs`
//     (M59_PENDING_SUCCESSOR_MAX_MIN, or the caller's --defer-max-minutes; 12 h by default): the
//     successor is stopped with the reason logged and recorded, and the old keeper stays.
//
// Everything that touches a process, a port or the broker's maps is injected (`fx`), as in
// broker-handover.mjs, so the ordering and every refusal are driven offline by
// pending-successors-test.mjs. This module decides; the broker supplies the hands.

export const PENDING_ENV = 'M59_KEEPER_PENDING_SUCCESSOR';
export const DEFAULT_PENDING_MAX_WAIT_MS = 12 * 60 * 60_000;
export const PENDING_MAX_WAIT_ENV = 'M59_PENDING_SUCCESSOR_MAX_MIN';
const MAX_WAIT_CEILING_MIN = 7 * 24 * 60;

/**
 * How long a pending successor may wait for the person, in ms. The caller's minutes win, then the
 * environment, then the default. An unusable value is REPORTED and the default kept -- never
 * silently applied, never silently dropped (docs/m59-policy.md).
 */
export function pendingMaxWaitMs({ minutes = null, env = process.env } = {}) {
  const warnings = [];
  for (const [value, source] of [[minutes, '--defer-max-minutes'], [env?.[PENDING_MAX_WAIT_ENV], PENDING_MAX_WAIT_ENV]]) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n <= MAX_WAIT_CEILING_MIN) return { ms: Math.round(n * 60_000), source, warnings };
    warnings.push(`${source}=${JSON.stringify(value)} is not a number of minutes in 1..${MAX_WAIT_CEILING_MIN}; ignored`);
  }
  return { ms: DEFAULT_PENDING_MAX_WAIT_MS, source: 'default', warnings };
}

/**
 * WHAT A RESTART DOES WITH ONE CHARACTER that a person holds or a dormancy record keeps out. Pure.
 *   occupied   a person is at the controls (a pilot claim, or a spectate keeper on their connection)
 *   dormant    the shared dormancy store holds a record for the character
 *   connected  the OLD keeper's own answer: true, false, or null when it did not say
 *   defer      stage a pending successor where a swap is not safe now (default on)
 *   skip       --skip-piloted: leave every occupied character exactly as it is
 * Returns { action: 'handoff' | 'dormant_swap' | 'defer' | 'skip' | 'refuse', why }.
 */
export function pilotedRestartPlan({ occupied = false, dormant = false, connected = null, defer = true, skip = false } = {}) {
  if (occupied && skip)
    return { action: 'skip', why: 'being played by a person; --skip-piloted leaves its keeper exactly as it is' };
  if (!occupied && !dormant) return { action: 'handoff', why: 'nobody holds it' };
  // The old keeper's socket is already gone: there is nothing to hand, so the replacement starts
  // dormant now and the rejoin sweep wakes it when the hold ends (the 2026-10-07 dormant swap).
  if (connected === false) return { action: 'dormant_swap', why: occupied ? 'played by a person; its keeper is out of the world' : 'held dormant' };
  if (!occupied)
    return { action: 'refuse', why: connected === true
      ? 'a dormancy record says this character is out, but its keeper is in the world; wake it or clear the record first'
      : 'held dormant, and the old keeper did not say whether it is connected' };
  const now = connected === true
    ? 'being played by a person through this keeper\'s own connection (a proxied client); replacing it now would bump them'
    : 'being played by a person, and the old keeper did not say whether it is connected';
  return defer ? { action: 'defer', why: `${now}; a successor waits for them to log off` }
               : { action: 'refuse', why: now };
}

/**
 * WHAT TO DO WITH ONE PENDING SUCCESSOR NOW. Pure.
 * Returns { action: 'wait' | 'activate' | 'teardown' | 'busy', why }.
 */
export function pendingVerdict(rec, { now = Date.now(), occupied = true, successorAlive = true } = {}) {
  if (!rec) return { action: 'wait', why: 'no pending successor' };
  if (rec.activating) return { action: 'busy', why: 'taking over now' };
  if (!successorAlive) return { action: 'teardown', why: 'the pending successor is no longer running' };
  if (occupied) {
    if (Number.isFinite(rec.deadline) && now >= rec.deadline)
      return { action: 'teardown', why: `waited ${describeMs(now - (rec.startedAt ?? now))} for the person to log off ` +
                                        '(max wait); the old keeper stays on its code' };
    return { action: 'wait', why: 'a person is at the controls' };
  }
  return { action: 'activate', why: 'nobody is at the controls any more' };
}

export function describeMs(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

/**
 * THE BOOK OF PENDING SUCCESSORS, and the take-over. `fx` (all required unless noted):
 *   occupied(agent)               -> bool, sync: is a person holding the body right now
 *   successorAlive(rec)           -> bool, sync
 *   oldKeeper(agent)              -> Promise<{ pid, port, identity, live: {connected, in_game, cooperative_wait}|null } | null>
 *   dormancy(agent)               -> { record, stayOut } | null, sync: the shared store's record and its verdict
 *   clearDormancy(agent, why)     a record that wakes on the person leaving is cleared before the login
 *   fenceOld(old)                 -> Promise<bool>  POST /handoff: the old keeper will not reconnect
 *   unfenceOld(old)               -> Promise<bool>  POST /handoff {cancel}
 *   wake(rec, why)                -> Promise<any>   POST /wake on the successor: it logs in
 *   sleep(rec, record)            -> Promise<bool>  POST /dormant on the successor with the store's record
 *   waitReady(rec, {dormant})     -> Promise<bool>  in_game AND connected with its own pid (dormant: out and ours)
 *   swap(agent, rec)              -> Promise<void>  the broker's records now name the successor
 *   stopOld(old)                  -> Promise<bool>  POST /stop: its socket is already gone
 *   stopSuccessor(rec)            -> Promise<void>  addressed /stop, then the exact child handle
 *   mark(agent, on)               optional: keeperHandoffs, so the rejoin sweep steps over the take-over
 *   record(agent, what, detail)   optional: the character's ledger
 */
export class PendingSuccessors {
  #book = new Map();
  #ticking = false;

  constructor({ fx, now = () => Date.now(), log = () => {} } = {}) {
    if (!fx) throw new TypeError('PendingSuccessors needs its effects (fx)');
    this.fx = fx;
    this.now = now;
    this.log = log;
  }

  has(agent) { return this.#book.has(agent); }
  get(agent) { return this.#book.get(agent) ?? null; }
  activating(agent) { return !!this.#book.get(agent)?.activating; }
  get size() { return this.#book.size; }
  /** Ports the successors are listening on, which no other spawn may take. */
  ports() { return [...this.#book.values()].map(r => r.port).filter(p => Number.isInteger(p)); }

  /** What an operator sees: no process handles, nothing that could address the successor. */
  list(now = this.now()) {
    return [...this.#book.values()].map(r => ({
      agent: r.agent, pid: r.pid, port: r.port, old_pid: r.old_pid ?? null,
      since: r.startedAt, waiting_ms: now - r.startedAt, deadline: r.deadline ?? null,
      gives_up_in_ms: Number.isFinite(r.deadline) ? Math.max(0, r.deadline - now) : null,
      reason: r.reason ?? null, by: r.by ?? null, activating: !!r.activating,
      occupied: (() => { try { return !!this.fx.occupied(r.agent); } catch { return null; } })(),
    }));
  }

  /** Register a successor the broker has already spawned, guarded and seen dormant. */
  stage(agent, { pid, port, child = null, startedAt = this.now(), deadline = null, old_pid = null, reason = null, by = null } = {}) {
    if (!agent) throw new TypeError('stage: agent is required');
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`stage ${agent}: a successor needs a pid`);
    if (this.#book.has(agent)) throw new Error(`stage ${agent}: a pending successor is already registered; tear it down first`);
    const rec = { agent, pid, port, child, startedAt, deadline, old_pid, reason, by, activating: false };
    this.#book.set(agent, rec);
    this.log(`[pending] ${agent}: successor pid ${pid} port ${port} staged, waiting for the person to log off` +
             (Number.isFinite(deadline) ? ` (gives up after ${describeMs(deadline - startedAt)})` : ''));
    this.#record(agent, 'staged', { pid, port, old_pid, reason, deadline });
    return rec;
  }

  /** Decide every successor once. Never overlaps itself; never throws. */
  async tick() {
    if (this.#ticking) return [];
    this.#ticking = true;
    const done = [];
    try {
      for (const rec of [...this.#book.values()]) {
        let v;
        try {
          v = pendingVerdict(rec, { now: this.now(), occupied: !!this.fx.occupied(rec.agent),
                                    successorAlive: !!this.fx.successorAlive(rec) });
        } catch (e) { v = { action: 'wait', why: `could not decide: ${e.message}` }; }
        if (v.action === 'activate') done.push(await this.activate(rec.agent, v.why));
        else if (v.action === 'teardown') done.push(await this.teardown(rec.agent, v.why));
      }
    } finally { this.#ticking = false; }
    return done;
  }

  /** THE TAKE-OVER. See the header for the order and why each step is where it is. */
  async activate(agent, why = 'nobody is at the controls any more') {
    const rec = this.#book.get(agent);
    if (!rec) return { agent, ok: false, why: 'no pending successor' };
    if (rec.activating) return { agent, ok: false, why: 'already taking over' };
    rec.activating = true;
    try { this.fx.mark?.(agent, true); } catch {}
    let fenced = null, woke = false;
    const wait = (w) => ({ agent, ok: false, waiting: true, why: w });
    try {
      if (this.fx.occupied(agent)) return wait('a person is still at the controls');
      if (!this.fx.successorAlive(rec)) return await this.#forget(rec, 'the pending successor is no longer running');
      const old = await this.fx.oldKeeper(agent);
      if (old?.live?.cooperative_wait) return wait('the old keeper is in a cooperative logoff wait');
      const dorm = this.fx.dormancy(agent);
      if (this.fx.occupied(agent)) return wait('a person took the controls again');

      // A RECORD THAT SAYS OUT STAYS OUT: the successor takes the record instead of logging in.
      if (dorm?.stayOut) {
        if (old?.live?.connected === true)
          return await this.#forget(rec, 'a dormancy record says this character is out, but its old keeper is in the world');
        if (!(await this.fx.sleep(rec, dorm.record)))
          return await this.#forget(rec, 'the successor would not take the dormancy record');
        if (!(await this.fx.waitReady(rec, { dormant: true })))
          return await this.#forget(rec, 'the successor did not confirm the dormancy record');
        await this.fx.swap(agent, rec);
        if (old) await this.fx.stopOld(old).catch(() => false);
        this.#book.delete(agent);
        this.log(`[pending] ${agent}: successor pid ${rec.pid} took over DORMANT (${dorm.record?.reason ?? '?'}); ` +
                 `old pid ${old?.pid ?? '?'} stopped`);
        this.#record(agent, 'activated', { pid: rec.pid, old_pid: old?.pid ?? null, dormant: true, why });
        return { agent, ok: true, pid: rec.pid, port: rec.port, old_pid: old?.pid ?? null, dormant: true };
      }

      // THE FENCE: an old keeper that is alive must promise not to reconnect before anything logs in.
      if (old) {
        if (await this.fx.fenceOld(old)) fenced = old;
        else if (old.live) return await this.#forget(rec, 'the old keeper would not take the handoff fence; it carries on');
      }
      // THE LAST GATE before anything reaches the server.
      if (this.fx.occupied(agent)) {
        if (fenced) await this.fx.unfenceOld(fenced).catch(() => false);
        return wait('a person took the controls again');
      }
      if (dorm && !dorm.stayOut) this.fx.clearDormancy(agent, why);
      woke = true;
      await this.fx.wake(rec, why);
      if (!(await this.fx.waitReady(rec, { dormant: false }))) {
        await this.fx.stopSuccessor(rec).catch(() => {});
        if (fenced) await this.fx.unfenceOld(fenced).catch(() => false);
        return await this.#forget(rec, 'the successor did not reach the world in time; the old keeper carries on', { stopped: true });
      }
      await this.fx.swap(agent, rec);
      // Its socket is already gone (the person's client took it, or the successor's login did):
      // a stop logs nobody out. A connected old keeper may already be exiting on its own.
      if (old) await this.fx.stopOld(old).catch(() => false);
      this.#book.delete(agent);
      this.log(`[pending] ${agent}: successor pid ${rec.pid} port ${rec.port} took over (${why}); ` +
               `old pid ${old?.pid ?? '?'} ${old ? 'stopped' : 'was not running'}`);
      this.#record(agent, 'activated', { pid: rec.pid, old_pid: old?.pid ?? null, waited_ms: this.now() - rec.startedAt, why });
      return { agent, ok: true, pid: rec.pid, port: rec.port, old_pid: old?.pid ?? null };
    } catch (e) {
      if (woke) await this.fx.stopSuccessor(rec).catch(() => {});
      if (fenced) await this.fx.unfenceOld(fenced).catch(() => false);
      return await this.#forget(rec, `take-over failed: ${e?.message ?? e}; the old keeper carries on`, { stopped: woke });
    } finally {
      rec.activating = false;
      try { this.fx.mark?.(agent, false); } catch {}
    }
  }

  /** Stop a successor that will not be used, with the reason said and recorded. */
  async teardown(agent, why) {
    const rec = this.#book.get(agent);
    if (!rec) return { agent, ok: false, why: 'no pending successor' };
    if (rec.activating) return { agent, ok: false, why: 'it is taking over right now' };
    return this.#forget(rec, why);
  }

  async teardownAll(why) {
    const out = [];
    for (const agent of [...this.#book.keys()]) out.push(await this.teardown(agent, why));
    return out;
  }

  async #forget(rec, why, { stopped = false } = {}) {
    if (this.#book.get(rec.agent) === rec) this.#book.delete(rec.agent);
    if (!stopped) await this.fx.stopSuccessor(rec).catch(() => {});
    this.log(`[pending] ${rec.agent}: successor pid ${rec.pid} torn down -- ${why}`);
    this.#record(rec.agent, 'torn_down', { pid: rec.pid, why, waited_ms: this.now() - rec.startedAt });
    return { agent: rec.agent, ok: false, torn_down: true, why };
  }

  #record(agent, what, detail) {
    try { this.fx.record?.(agent, what, detail); } catch {}
  }

  // A LIVE BROKER HANDOVER carries the book: the successor broker adopts each entry by pid and
  // port (no process handle crosses), and proves its identity before it ever addresses it.
  exportSnapshot() {
    return [...this.#book.values()].map(({ agent, pid, port, startedAt, deadline, old_pid, reason, by }) =>
      ({ agent, pid, port, startedAt, deadline, old_pid, reason, by }));
  }

  importSnapshot(rows) {
    let n = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.agent || !Number.isSafeInteger(r.pid) || this.#book.has(r.agent)) continue;
      this.#book.set(r.agent, { ...r, child: null, adopted: true, activating: false });
      n++;
    }
    return n;
  }
}
