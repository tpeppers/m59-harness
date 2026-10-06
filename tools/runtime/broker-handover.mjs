// A LIVE BROKER HANDOVER: the next broker comes up warm beside this one and takes the fleet
// without a gap.
//
// WHY. A broker restart used to be: stop every keeper, exit, start, log every character back
// in six at a time. Every character left the world, and in a fight the one-by-one relogin
// meant the fleet came back one character at a time while the other side kept swinging. The
// keepers were never the reason. Each one is its own process holding its own socket, it
// proves ownership against its own pid at login and never again, and the broker's own code
// already adopts a verified surviving keeper instead of logging in another. What forced the
// gap was the broker: its orderly stop killed its keepers, and its successor could not own
// the fleet until the predecessor was dead.
//
// THE SHAPE. The predecessor spawns the successor with a private IPC channel. The successor
// loads everything — code, map, routing tables, the slow part — and opens nothing: no port,
// no keeper, no claim. Then, in order:
//
//   1  ready      successor -> predecessor   warm, owns nothing, serves nothing
//   2  freeze     predecessor                stop spawning and reconciling; HOLD new requests
//   3  transfer   predecessor                fleet lock + every account lease now name the
//                                            successor's pid; every keeper guard is kept
//   4  handover   predecessor -> successor   the transferred claims and an in-memory snapshot
//   5  adopted    successor -> predecessor   it adopted the running keepers, nobody relogged
//   6  listen     predecessor -> successor   the listening sockets themselves (IPC handles),
//                                            so the port never closes
//   7  serving    successor -> predecessor
//   8  commit     predecessor                stop accepting, FORWARD every held request to the
//                                            successor, retire, drain, exit — keepers untouched
//
// ROLLBACK IS FREE UNTIL STEP 8. The predecessor is the fleet's broker until it commits: any
// failure kills the successor it spawned (it has the ChildProcess handle, so this is exact),
// transfers the claims back with the tokens it generated, unfreezes, and lets the held
// requests run where they arrived. A successor that dies is harmless at every stage before
// commit, and after commit it is a crashed broker with guarded survivors — the case startup
// adoption has always handled.
//
// Everything that touches a process, a socket, a file or the broker's state is injected, so
// the ordering, the timeouts and every abort path are driven offline by
// broker-handover-test.mjs. This module decides; the broker supplies the hands.

export const HANDOVER_PROTOCOL = 1;
export const SUCCESSOR_ENV = 'M59_BROKER_SUCCESSOR_OF';

export const HANDOVER_DEFAULTS = Object.freeze({
  warmMs: 240_000,      // module load + map + routes; measured cold starts are well under this
  adoptMs: 90_000,      // adopting is an identity probe per keeper, not a login
  listenMs: 15_000,
});

/** How the predecessor launches its successor: the same program, argv, env and log. */
export function successorSpawnSpec({ execPath, execArgv = [], argv, env, cwd, predecessorPid }) {
  if (!Array.isArray(argv) || !argv.length) throw new TypeError('argv must name the broker script');
  if (!Number.isSafeInteger(predecessorPid) || predecessorPid <= 0)
    throw new TypeError('predecessorPid must be a pid');
  return Object.freeze({
    command: execPath,
    args: Object.freeze([...execArgv, ...argv]),
    options: Object.freeze({
      cwd,
      // THE SAME ENVIRONMENT, NOT THE SERVICE'S DEFAULTS. A worktree broker started with
      // M59_STATE_FILE came back rosterless when a restart rebuilt its environment from
      // scratch; inheriting it is what keeps the successor on the same roster.
      env: Object.freeze({ ...env, [SUCCESSOR_ENV]: String(predecessorPid) }),
      // stdout/stderr are the predecessor's own, which the service pointed at the broker log:
      // one log, both processes, in order.
      stdio: Object.freeze(['ignore', 'inherit', 'inherit', 'ipc']),
      // Maps and Sets cross intact, and listening handles still pass (verified on Windows).
      serialization: 'advanced',
      // It must outlive the predecessor, which exits seconds after the commit.
      detached: true,
      windowsHide: true,
    }),
  });
}

export function successorOf(env = process.env) {
  const pid = Number(env?.[SUCCESSOR_ENV]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Requests that arrive while the fleet is changing hands are HELD, not refused. When the
 * handover commits they are forwarded to the successor; when it aborts they run here, where
 * they arrived. Either way the caller sees latency, never a dropped order.
 */
export class RequestHold {
  #state = 'open';         // open | holding | forward | local
  #waiters = [];
  get state() { return this.#state; }
  get held() { return this.#waiters.length; }
  begin() { if (this.#state === 'open') this.#state = 'holding'; }
  /** 'proceed' | 'forward' — what the request should do, decided now or at release. */
  async admit() {
    if (this.#state === 'open' || this.#state === 'local') return 'proceed';
    if (this.#state === 'forward') return 'forward';
    return await new Promise(resolve => this.#waiters.push(resolve));
  }
  release(verdict) {
    if (verdict !== 'forward' && verdict !== 'local') throw new TypeError('verdict is forward or local');
    this.#state = verdict === 'local' ? 'open' : 'forward';
    const answer = verdict === 'forward' ? 'forward' : 'proceed';
    for (const resolve of this.#waiters.splice(0)) resolve(answer);
  }
}

// --------------------------------------------------------------------------- channel

/**
 * A promise for the next message of `type` on a child/process channel, which REJECTS if the
 * other end exits or disconnects first, or the deadline passes. Every wait in the protocol is
 * one of these, so no stage can hang a broker that is still the fleet's owner.
 */
export function nextMessage(channel, type, timeoutMs, what = type) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      channel.off?.('message', onMessage);
      channel.off?.('exit', onExit);
      channel.off?.('disconnect', onDisconnect);
      fn(value);
    };
    const onMessage = message => {
      if (message?.type === type) done(resolve, message);
      else if (message?.type === 'failed') done(reject, Object.assign(
        new Error(`successor failed during ${what}: ${message.why ?? 'no reason given'}`),
        { stage: what, remote: message }));
    };
    const onExit = code => done(reject, Object.assign(
      new Error(`the other broker exited (${code}) while waiting for ${what}`), { stage: what }));
    const onDisconnect = () => done(reject, Object.assign(
      new Error(`the handover channel closed while waiting for ${what}`), { stage: what }));
    const timer = setTimeout(() => done(reject, Object.assign(
      new Error(`no ${what} within ${Math.round(timeoutMs / 1000)}s`), { stage: what, timeout: true })),
      timeoutMs);
    // Not unref'd: a broker waiting on its own handover deadline must stay alive to meet it.
    channel.on('message', onMessage);
    channel.on('exit', onExit);
    channel.on('disconnect', onDisconnect);
  });
}

// --------------------------------------------------------------------------- predecessor

/**
 * Hand the fleet to a fresh successor. Resolves to `{ok:true, successor_pid, report}` once the
 * successor is serving and this process has committed, or `{ok:false, stage, why, ...}` with
 * this process still the fleet's broker, unfrozen and serving. It never throws.
 *
 * deps:
 *   canHandOver()              -> {ok, why?}
 *   spawnSuccessor()           -> ChildProcess-like (send/on/off/kill/pid/exitCode)
 *   freeze()                   -> Promise<{ok, why?}>   stop spawns/reconcile, begin holding
 *   unfreeze()                 -> void
 *   transferOwnership(pid)     -> {ok, why?, ownership}  (rolls itself back on partial failure)
 *   transferBack()             -> {ok, why?}
 *   snapshot()                 -> structured-cloneable object
 *   listeners()                -> [{name, server}]
 *   commit()                   -> stop accepting, forward held requests, retire
 *   releaseHeld(verdict)
 *   log(line)
 */
export async function handOver(deps, opts = {}) {
  const t = { ...HANDOVER_DEFAULTS, ...opts };
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const can = deps.canHandOver();
  if (!can?.ok) return { ok: false, stage: 'precheck', why: can?.why ?? 'handover not possible' };

  let child;
  try { child = deps.spawnSuccessor(); }
  catch (e) { return { ok: false, stage: 'spawn', why: e.message }; }
  log(`[handover] successor pid ${child.pid} starting warm (owns nothing, serves nothing)`);
  const killChild = async () => {
    if (child.exitCode != null || child.signalCode != null) return;
    const gone = new Promise(resolve => child.once ? child.once('exit', resolve) : resolve());
    try { child.kill(); } catch {}
    await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 5000).unref?.())]);
  };

  // 1. WARM. Nothing here has changed yet, so a failure costs only the child.
  let ready;
  try { ready = await nextMessage(child, 'ready', t.warmMs, 'warm start'); }
  catch (e) { await killChild(); return { ok: false, stage: 'warm', why: e.message }; }
  if (ready.protocol !== HANDOVER_PROTOCOL) {
    await killChild();
    return { ok: false, stage: 'warm',
             why: `successor speaks handover protocol ${ready.protocol}, this broker ${HANDOVER_PROTOCOL}` };
  }
  log(`[handover] successor warm after ${Math.round((Date.now() - started) / 1000)}s`);

  // 2. FREEZE. From here new requests are held, not served.
  const frozenAt = Date.now();
  const frozen = await deps.freeze();
  if (!frozen?.ok) {
    deps.unfreeze();
    deps.releaseHeld('local');
    await killChild();
    return { ok: false, stage: 'freeze', why: frozen?.why ?? 'could not freeze' };
  }

  // 3. TRANSFER. Self-rolling-back on a partial failure.
  const moved = deps.transferOwnership(child.pid);
  if (!moved?.ok) {
    deps.unfreeze();
    deps.releaseHeld('local');
    await killChild();
    return { ok: false, stage: 'transfer', why: moved?.why ?? 'ownership transfer failed' };
  }

  const abortAfterTransfer = async (stage, why) => {
    // Kill first: a successor that cannot act cannot race the claims back.
    await killChild();
    const back = deps.transferBack();
    deps.unfreeze();
    deps.releaseHeld('local');
    log(`[handover] ABORTED at ${stage}: ${why}; ownership ` +
        (back?.ok ? 'returned to this broker' : `NOT fully returned (${back?.why ?? 'unknown'})`));
    return { ok: false, stage, why, rolled_back: !!back?.ok, ...(back?.ok ? {} : { rollback: back }) };
  };

  // 4-5. HANDOVER and ADOPTION.
  let adopted;
  try {
    child.send({ type: 'handover', protocol: HANDOVER_PROTOCOL,
                 ownership: moved.ownership, snapshot: deps.snapshot() });
    adopted = await nextMessage(child, 'adopted', t.adoptMs, 'keeper adoption');
  } catch (e) { return await abortAfterTransfer('adopt', e.message); }
  if (!adopted.ok) return await abortAfterTransfer('adopt', adopted.why ?? 'successor refused the fleet');

  // 6-7. THE SOCKETS. One handle per message; the successor answers once it serves on all.
  try {
    const serving = nextMessage(child, 'serving', t.listenMs, 'listening');
    for (const { name, server } of deps.listeners())
      child.send({ type: 'listen', name }, server);
    child.send({ type: 'listen-done' });
    await serving;
  } catch (e) { return await abortAfterTransfer('listen', e.message); }

  // 8. COMMIT. Past this line there is no rollback: the successor is the broker.
  deps.commit();
  deps.releaseHeld('forward');
  try { child.send({ type: 'committed' }); } catch {}
  // Not closed at once: a close can overtake the message it follows. The channel goes when
  // this process exits after draining, or after a second, whichever is first.
  const closeLater = setTimeout(() => { try { child.disconnect?.(); } catch {} }, 1000);
  closeLater.unref?.();
  try { child.unref?.(); } catch {}
  const frozenMs = Date.now() - frozenAt;
  log(`[handover] committed to pid ${child.pid}: requests held ${frozenMs}ms, ` +
      `${adopted.report?.adopted ?? '?'} of ${adopted.report?.expected ?? '?'} keeper(s) adopted in place`);
  return { ok: true, successor_pid: child.pid, frozen_ms: frozenMs,
           total_ms: Date.now() - started, report: adopted.report ?? null };
}

// --------------------------------------------------------------------------- successor

/**
 * The successor's half. Resolves once committed — or, if the predecessor vanished after the
 * ownership was already ours, once this process has taken the ports itself.
 *
 * deps:
 *   install(handover)          -> {ok, why?}   take the transferred claims, restore state
 *   adopt()                    -> Promise<report>  resume the fleet by adopting live keepers
 *   adoptionAcceptable(report) -> {ok, why?}
 *   listen(name, handle)       -> Promise
 *   listenFresh()              -> Promise   bind the ports normally (predecessor is gone)
 *   started()                  -> void      start the timers a normal broker starts
 *   log(line)
 */
export async function takeOver(channel, deps, opts = {}) {
  const t = { ...HANDOVER_DEFAULTS, ...opts };
  const log = deps.log ?? (() => {});
  const fail = why => { try { channel.send({ type: 'failed', why }); } catch {} return { ok: false, why }; };

  try { channel.send({ type: 'ready', protocol: HANDOVER_PROTOCOL, pid: process.pid }); }
  catch (e) { return { ok: false, stage: 'ready', why: e.message, owns: false }; }
  let handover;
  try { handover = await nextMessage(channel, 'handover', t.warmMs + t.adoptMs, 'the fleet'); }
  catch (e) { return { ok: false, stage: 'await-handover', why: e.message, owns: false }; }

  const installed = deps.install(handover);
  if (!installed?.ok) return { ...fail(`install: ${installed?.why ?? 'refused'}`), owns: false };

  // FROM HERE THIS PROCESS OWNS THE FLEET'S CLAIMS. If the predecessor disappears now, the
  // claims are ours and its listeners died with it: bind the ports and carry on as the
  // broker, rather than exiting and leaving the fleet owned by a dead pid.
  let lost = false;
  const onGone = () => { lost = true; };
  channel.on('disconnect', onGone);

  let report;
  try { report = await deps.adopt(); }
  catch (e) { if (!lost) return { ...fail(`adopt: ${e.message}`), owns: true }; }
  const acceptable = lost ? { ok: true } : deps.adoptionAcceptable(report);
  if (!acceptable.ok) return { ...fail(acceptable.why), owns: true };

  if (lost) {
    log('[handover] predecessor vanished after transferring the fleet; taking the ports directly');
    await deps.listenFresh();
    deps.started();
    return { ok: true, orphaned: true, report };
  }

  // Listening for the sockets BEFORE saying `adopted`, because the predecessor sends them the
  // moment it reads that word.
  const listening = [];
  const done = new Promise((resolve, reject) => {
    const onMessage = (message, handle) => {
      if (message?.type === 'listen') {
        // Observed now, awaited at listen-done: a socket that fails before then must be
        // reported to the predecessor as a refusal, not crash this process as unhandled.
        const serving = Promise.resolve().then(() => deps.listen(message.name, handle));
        serving.catch(() => {});
        listening.push(serving);
      }
      else if (message?.type === 'listen-done') { channel.off('message', onMessage); resolve(); }
    };
    channel.on('message', onMessage);
    channel.once('disconnect', () => reject(new Error('channel closed before the sockets arrived')));
  });
  done.catch(() => {});
  // A send on a closed channel throws; the predecessor having gone is then the answer.
  try { channel.send({ type: 'adopted', ok: true, report }); }
  catch { lost = true; }
  if (lost) {
    log('[handover] predecessor vanished before the sockets moved; taking the ports directly');
    await deps.listenFresh();
    deps.started();
    return { ok: true, orphaned: true, report };
  }
  try {
    await done;
    await Promise.all(listening);
  } catch (e) {
    if (lost) {
      await deps.listenFresh();
      deps.started();
      return { ok: true, orphaned: true, report };
    }
    return { ...fail(`listen: ${e.message}`), owns: true };
  }
  deps.started();
  const committed = nextMessage(channel, 'committed', t.listenMs, 'commit').then(() => true, () => false);
  try { channel.send({ type: 'serving' }); } catch { /* already serving on the shared sockets */ }
  // A commit that never arrives is not a failure here: the predecessor commits after it sees
  // `serving`, and if it died in between, this process already serves on the shared sockets.
  const sawCommit = await committed;
  channel.off('disconnect', onGone);
  return { ok: true, committed: sawCommit, report };
}

/**
 * The successor's acceptance rule for an adoption. Strict on purpose, because declining costs
 * nothing: the predecessor is still the broker and simply carries on. A keeper that is
 * RUNNING but was not adopted means identity or guard verification broke, and committing
 * would leave that character unmanaged; a keeper whose process had already died is no worse
 * off than under the predecessor, which would have respawned it too.
 */
export function judgeAdoption(report) {
  if (!report || !Number.isInteger(report.expected)) return { ok: false, why: 'no adoption report' };
  const unadoptedLive = report.unadopted_live ?? [];
  if (unadoptedLive.length)
    return { ok: false, why: `${unadoptedLive.length} running keeper(s) were not adopted: ` +
                              unadoptedLive.join(', ') };
  if (report.expected > 0 && report.adopted === 0)
    return { ok: false, why: `none of ${report.expected} keeper(s) adopted` };
  return { ok: true };
}
