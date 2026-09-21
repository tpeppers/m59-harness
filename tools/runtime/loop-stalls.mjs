// WHO STOPPED THE EVENT LOOP — not just how long for.
//
// A LAG HISTOGRAM SAYS THE LOOP WAS BLOCKED. IT NEVER SAYS BY WHAT, AND THAT IS THE COST.
//
// 2026-09-20: the prod broker wedged three times in one day. Each time `/health` took a
// minute or stopped answering at all, every keeper's readiness probe went unanswered so the
// rejoin declared keepers dead that answered a DIRECT probe in milliseconds with
// `in_game: true`, and the fleet earned nothing for hours — 9 kills in 45 minutes against a
// 0.60 kills/minute baseline. Three sessions diagnosed it independently and got three
// different answers: a memory leak (it was a plateau — 2.6GB is that broker's normal weight
// against a 4288MB ceiling), a synchronous roster write storm (the process wrote ~0 bytes and
// READ 48GB in nine minutes), and GC thrash (the loop's own p50 was 15.3ms). The histogram
// was true the whole time and settled none of it: `max: 117440.5` says the loop stopped for
// nearly two minutes and says nothing at all about who stopped it.
//
// Three wrong answers is not three careless readings. It is an instrument that cannot name a
// cause, so every reader supplies one.
//
// THE TRICK, WHICH `m59-keeper-process.mjs` HAS USED SINCE 2026-09-02: V8's sampling profiler
// runs on ITS OWN THREAD. It keeps sampling the stack while the loop is blocked, and
// `node:inspector` lets a process drive that profiler on itself with no flags and no port to
// open. So: sample continuously at 5ms (about one percent of a core), and when a tick comes
// back late, name the frames that owned the blocked window.
//
// SELF FRAMES AND CALLERS ARE BOTH KEPT, BECAUSE THE SYSCALL IS NOT THE FINDING. A stall
// inside `readFileSync` tells you nothing; `readFileSync` under `flushTrails` tells you which
// file and which fix. `hot` names the former and may be a node-internal frame; `callers`
// names the latter and is ours only.
//
// THE "OURS" FILTER IS A PATTERN, NOT A LIST. The keeper's copy names eight files by hand,
// and a hand-written list is wrong the day somebody adds a module — wrong by staying SILENT
// about the new one, which is the failure this whole file exists to end. Every module here is
// called `m59-something.mjs`, so that is the rule.
//
// It is an instrument, so it never throws and never blocks: a missing inspector, a profiler
// that will not start and a `context` callback that throws all degrade to a plain lateness
// report rather than to an error.

const OURS = /m59-[a-z0-9-]+\.mjs$/;

const frameName = f => f
  ? `${f.functionName || '(anon)'} ${(f.url || '').split(/[\\/]/).pop()}:${f.lineNumber + 1}`
  : null;

/**
 * Drive V8's sampler on ourselves and summarise a window of it.
 *
 * Returns `null` rather than throwing for every failure, including "the inspector is not
 * available in this build", because an instrument that can stop a broker starting is worse
 * than no instrument.
 */
async function selfProfiler({ intervalUs = 5000, restartAfterMs = 120_000 } = {}) {
  try {
    const inspector = await import('node:inspector');
    const session = new inspector.Session();
    session.connect();
    const post = (m, p = {}) =>
      new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
    let startedAt = 0;
    const start = () => post('Profiler.start').then(() => { startedAt = Date.now(); })
                                              .catch(() => {});
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: intervalUs });
    await start();

    /** Summarise the samples that fall inside [fromMs, toMs] on the WALL clock. */
    const hotDuring = async (fromMs, toMs, top = 5) => {
      let profile = null;
      try { ({ profile } = await post('Profiler.stop')); } catch { return null; }
      start();
      if (!profile?.samples?.length) return null;
      const byId = new Map(profile.nodes.map(n => [n.id, n]));
      const parentOf = new Map();
      for (const n of profile.nodes) for (const c of (n.children || [])) parentOf.set(c, n.id);
      // `profile.startTime` is on the profiler's own monotonic clock, which is not the wall
      // clock the stall was measured against. Pin the profile's END to now and walk the
      // deltas backwards — the same mapping the keeper's copy makes.
      const totalUs = profile.timeDeltas.reduce((a, b) => a + b, 0);
      const endWall = Date.now();
      const self = new Map(), incl = new Map();
      let tUs = 0, inWindow = 0;
      for (let i = 0; i < profile.samples.length; i++) {
        tUs += profile.timeDeltas[i] || 0;
        const wall = endWall - (totalUs - tUs) / 1000;
        if (wall < fromMs || wall > toMs) continue;
        inWindow++;
        const us = profile.timeDeltas[i] || 0;
        const k = frameName(byId.get(profile.samples[i])?.callFrame);
        if (k) self.set(k, (self.get(k) || 0) + us);
        // Every ancestor of ours, once per sample, so a hot leaf is attributed to the callers
        // that asked for it rather than counted once at the bottom of the stack.
        const seen = new Set();
        for (let cur = profile.samples[i]; cur != null; cur = parentOf.get(cur)) {
          const f = byId.get(cur)?.callFrame;
          if (!f || !OURS.test(f.url || '')) continue;
          const ak = frameName(f);
          if (!ak || seen.has(ak)) continue;
          seen.add(ak);
          incl.set(ak, (incl.get(ak) || 0) + us);
        }
      }
      if (!inWindow) return null;
      const line = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
        .map(([k, us]) => `${k} ${Math.round(us / 1000)}ms`).join(', ');
      const callers = line(incl);
      return line(self) + (callers ? ` | callers: ${callers}` : '');
    };

    // Bound the profile's memory: restart it when nothing has asked for a while. A broker
    // already sits near its heap ceiling, so an unbounded sample buffer is not free.
    const cycle = setInterval(() => {
      if (Date.now() - startedAt > restartAfterMs) post('Profiler.stop').then(start).catch(() => {});
    }, Math.max(1000, Math.round(restartAfterMs / 4)));
    cycle.unref?.();

    return { hotDuring, stop: () => { clearInterval(cycle); try { session.disconnect(); } catch { /* already gone */ } } };
  } catch { return null; }
}

/**
 * Watch this process's own event loop and report every gap longer than `reportOverMs`.
 *
 * `context()` is called when a stall is REPORTED, never on the hot path, and its keys are
 * merged into the row — that is where a caller puts "how many sessions" or "which fleet".
 * It is wrapped, because a stall report that throws loses the stall as well as the context.
 *
 * Returns `{ stalls(), stop() }`. `stalls()` is the ring buffer, oldest first.
 */
export async function startLoopStallMonitor({
  label = 'loop',
  everyMs = 500,
  reportOverMs = 2000,
  keep = 20,
  profile = true,
  context = () => ({}),
  log = m => console.error(m),
} = {}) {
  const rows = [];
  const profiler = profile ? await selfProfiler() : null;
  let stopped = false;
  let timer = null;
  let lastTick = Date.now();

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const late = now - lastTick - everyMs;
    lastTick = now;
    if (late >= reportOverMs) {
      const write = hot => {
        let extra = {};
        try { extra = context() ?? {}; } catch { extra = {}; }
        const row = { at: new Date(now).toISOString(), blocked_ms: late, ...extra,
                      hot: hot ?? null };
        rows.push(row);
        while (rows.length > keep) rows.shift();
        const tail = Object.entries(extra).map(([k, v]) => `${k} ${v}`).join(', ');
        try {
          log(`[loop] ${label} event loop was blocked ~${late}ms, resumed ${row.at}` +
              (tail ? ` (${tail})` : '') + (hot ? ` hot: ${hot}` : ''));
        } catch { /* a report must never be the reason anything fails */ }
      };
      // Never awaited by anything: the profiler's own round trip must not extend the stall.
      if (profiler) profiler.hotDuring(now - late - everyMs, now).then(write, () => write(null));
      else write(null);
    }
    timer = setTimeout(tick, everyMs);
    timer.unref?.();
  };

  timer = setTimeout(tick, everyMs);
  timer.unref?.();

  return {
    stalls: () => rows.slice(),
    stop: () => { stopped = true; if (timer) clearTimeout(timer); profiler?.stop?.(); },
  };
}
