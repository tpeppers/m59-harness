#!/usr/bin/env node
// RESTART KEEPERS ONTO NEW CODE WITHOUT LOGGING ANYBODY OUT. THE STANDARD WAY TO RESTART A KEEPER.
//
//   node tools/m59-war-restart.mjs --fleet prod                 # every keeper the broker holds
//   node tools/m59-war-restart.mjs --fleet prod --agents t1,t8  # just these
//   node tools/m59-war-restart.mjs --fleet prod --concurrency 4 --timeout 120
//   node tools/m59-war-restart.mjs --fleet prod --mode logoff   # the old stop-and-sweep, on purpose
//   node tools/m59-war-restart.mjs --fleet prod --skip-piloted  # leave every character a person plays alone
//   node tools/m59-war-restart.mjs --fleet prod --defer-max-minutes 240
//
// The broker's `war_restart` tool: each old keeper is told to hand off, a hidden replacement logs
// in, the server drops the old connection, and the old keeper exits by itself. Nobody leaves the
// world and nobody comes back one at a time, which is what a /stop-and-sweep restart did mid-PvP
// (see warRestartKeeper in m59-broker.mjs). Needs a broker and keepers running code that has it.
//
// MEMORY-GATED (m59-keeper-restart.mjs). A handoff briefly runs a second keeper process for the
// character, so it goes ahead only when free memory covers (concurrency + 1) keepers plus a
// margin; the concurrency is lowered before the handoff is given up, and only a machine that
// cannot afford ONE falls back to the logoff -- saying so, with the numbers. M59_RESTART_MODE
// or --mode handoff|logoff|auto overrides it (default auto).
//
// Concurrency defaults to 1 unless the broker's /health advertises the port reservation
// (fae8bd3) under `keeper_handoff`; an older broker lets concurrent handoffs collide on a port.
//
// A CHARACTER A PERSON IS PLAYING (2026-11-02). Its keeper cannot be handed off -- the replacement's
// login would bump them -- and the broker used to skip it, sometimes without a line, leaving it on
// the old code when they logged off. Now, by default, it is either replaced dormant at once (its
// keeper is already out of the world) or given a PENDING SUCCESSOR: a keeper on the new code, inert,
// that takes over as a handoff the moment the person logs off (runtime/pending-successors.mjs). The
// line says which: "t18 piloted: successor staged ... takes over when the pilot logs off".
// --skip-piloted keeps every such character exactly as it is; --defer-max-minutes (or
// M59_PENDING_SUCCESSOR_MAX_MIN; 12 h by default) is how long a successor waits before it is stopped
// and the old keeper kept. `pending_successors` (the broker tool) and `m59-service.mjs status` list
// the ones still waiting.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fleetName, stateFileFor, resolveControlUrl } from './m59-fleetpath.mjs';
import {
  decideRestartMode, defaultHandoffConcurrency, measureKeeperRssBytes, probeKeepers, logoffKeepers,
} from './m59-keeper-restart.mjs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

export async function warRestart({ agents = null, concurrency = 1, timeoutS = 90, fleet = fleetName(),
  url = resolveControlUrl().url, fleetState = null, skipPiloted = false, deferMaxMinutes = null } = {}) {
  if (!url) throw Error(resolveControlUrl().why ?? 'war_restart: control URL required');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'war_restart',
      arguments: { fleet_state: fleetState ?? stateFileFor(fleet), ...(agents ? { agents } : {}), concurrency, timeout_ms: timeoutS * 1000,
                   // Sent only when asked. A broker older than them logs them as unrecognised and
                   // ignores them -- harmless here, because such a broker already leaves a character
                   // a person is playing on its old keeper, which is what --skip-piloted asks for.
                   ...(skipPiloted ? { skip_piloted: true } : {}),
                   ...(deferMaxMinutes != null ? { defer_max_minutes: deferMaxMinutes } : {}) } } }),
    signal: AbortSignal.timeout(Math.max(60_000, timeoutS * 1000 * 12)) });
  const reply = await response.json();
  const content = reply.result?.content?.find(c => c.type === 'text')?.text;
  if (reply.error || reply.result?.isError) throw Error(content ?? reply.error?.message ?? 'war_restart failed');
  return JSON.parse(content);
}

// A BROKER WITHOUT THE TOOL is the one case where the handoff cannot be had at any price, so it
// is the one failure that may fall through to the logoff. Anything else is reported as a failure.
export const brokerLacksHandoff = (e) =>
  /unknown tool|tool not found|no such tool|war_restart[^\n]*not (found|available)/i.test(String(e?.message ?? e));

/** One keeper's line in the restart report. Pure, so the wording is pinned offline. */
export function describeRestartRow(x) {
  if (x.deferred)
    return `piloted: successor staged (pid ${x.pid}, port ${x.port}) on the new code, inert; ` +
           `takes over when the pilot logs off` +
           (x.gives_up_at ? `, gives up ${new Date(x.gives_up_at).toISOString()}` : '') +
           ` (old pid ${x.old_pid ?? '?'} keeps the body until then)`;
  if (x.skipped) return `skipped  ${x.why}`;
  if (!x.ok) return `FAILED  ${x.why}`;
  if (x.dormant) return `replaced dormant  pid ${x.old_pid} -> ${x.pid} (port ${x.port}); logs in when ${x.wakes === 'pilot_released' ? 'the pilot logs off' : `its hold ends (${x.wakes ?? '?'})`}`;
  return `handed off  pid ${x.old_pid} -> ${x.pid} (port ${x.port})`;
}

/** The one-line total, for both CLIs. */
export function describeRestartTotal(r) {
  if (r.mode !== 'handoff') return `${r.restarted} of ${r.of} logged off and back on a new pid${r.why ? ` (${r.why})` : ''}`;
  return `${r.restarted} of ${r.of} handed off without leaving the world` +
         (r.deferred ? `, ${r.deferred} waiting for the person playing them (pending successor)` : '') +
         (r.skipped ? `, ${r.skipped} skipped` : '');
}

async function brokerHealthAt(url) {
  try { return await fetch(new URL('/health', url), { signal: AbortSignal.timeout(20_000) }).then(r => r.json()); }
  catch { return null; }
}

// THE ONE ENTRY POINT every caller that restarts keepers goes through: decide, then hand off or
// log off, and return one row per keeper. `log` gets the decision line and one line per keeper.
//
// `fleetState` defaults to this checkout's roster for `fleet`, and the broker's war_restart
// refuses any other: that is the identity check, so it is never filled in from the broker's
// own /health here. A caller that has already chosen a broker by port may pass it explicitly.
export async function restartKeepers({ agents = null, concurrency = null, timeoutS = 90, mode = null,
  fleet = fleetName(), url = resolveControlUrl().url, fleetState = null, health = undefined,
  waitS = 150, log = console.log, env = process.env, decidedBy = null,
  skipPiloted = false, deferMaxMinutes = null } = {}) {
  if (!url) throw Error(resolveControlUrl().why ?? 'restart: control URL required');
  const h = health === undefined ? await brokerHealthAt(url) : health;
  const who = agents?.length ? agents : (h?.sessions ?? []);
  const keepers = await probeKeepers({ fleet, agents: who }).catch(() => new Map());
  const rss = measureKeeperRssBytes([...keepers.values()].map(k => k.pid));
  const d = decideRestartMode({ concurrency: concurrency ?? defaultHandoffConcurrency(h),
                                requested: mode, env, keeperRssBytes: rss, decidedBy });
  for (const w of d.warnings) log(`WARNING: ${w}`);
  log(d.message);

  if (d.mode === 'handoff') {
    try {
      const r = await warRestart({ agents: agents?.length ? agents : null, concurrency: d.concurrency, timeoutS,
        fleet, url, fleetState, skipPiloted, deferMaxMinutes });
      for (const x of r.results) log(`  ${x.agent.padEnd(5)} ${describeRestartRow(x)}`);
      return { mode: 'handoff', decision: d, ...r };
    } catch (e) {
      if (!brokerLacksHandoff(e)) throw e;
      log(`LOGOFF RESTART: this broker has no keeper handoff (${e.message}); falling back to stop-and-sweep. ` +
          'Restart the broker onto current code to get the handoff.');
    }
  }

  const targets = [...keepers.values()];
  if (!targets.length) return { mode: 'logoff', decision: d, ok: false, restarted: 0, of: 0, results: [],
                                why: 'no keeper answered in the fleet band' };
  const stops = await logoffKeepers(targets, { log });
  // SEE THEM BACK. A pid that did not change is a keeper that never restarted and never loaded
  // the new code; waiting on in_game alone would wait for nothing.
  const until = Date.now() + Math.max(60, waitS) * 1000;
  let back = new Map();
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 5000));
    back = await probeKeepers({ fleet, agents: targets.map(k => k.agent) }).catch(() => new Map());
    if (targets.every(k => back.get(k.agent) && back.get(k.agent).pid !== k.pid)) break;
  }
  const results = stops.map(s => {
    const now = back.get(s.agent);
    const fresh = !!now && now.pid !== s.old_pid;
    return { ...s, ok: s.ok && fresh, pid: now?.pid ?? null,
             ...(s.ok && !fresh ? { why: 'not back on a new pid yet; the sweep may still be working' } : {}) };
  });
  return { mode: 'logoff', decision: d, ok: results.every(x => x.ok), restarted: results.filter(x => x.ok).length,
           of: results.length, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await restartKeepers({ agents: opt('agents')?.split(',').map(s => s.trim()).filter(Boolean) ?? null,
      concurrency: opt('concurrency') != null ? Number(opt('concurrency')) : null,
      timeoutS: Number(opt('timeout') ?? 90), mode: opt('mode'), waitS: Number(opt('wait-seconds') ?? 150),
      skipPiloted: argv.includes('--skip-piloted'),
      deferMaxMinutes: opt('defer-max-minutes') != null ? Number(opt('defer-max-minutes')) : null });
    console.log(describeRestartTotal(r));
    if (!r.ok) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
