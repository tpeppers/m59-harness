#!/usr/bin/env node
// RESTART KEEPERS ONTO NEW CODE WITHOUT LOGGING ANYBODY OUT. THE STANDARD WAY TO RESTART A KEEPER.
//
//   node tools/m59-war-restart.mjs --fleet prod                 # every keeper the broker holds
//   node tools/m59-war-restart.mjs --fleet prod --agents t1,t8  # just these
//   node tools/m59-war-restart.mjs --fleet prod --concurrency 4 --timeout 120
//   node tools/m59-war-restart.mjs --fleet prod --mode logoff   # the old stop-and-sweep, on purpose
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
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fleetName, stateFileFor, resolveControlUrl } from './m59-fleetpath.mjs';
import {
  decideRestartMode, defaultHandoffConcurrency, measureKeeperRssBytes, probeKeepers, logoffKeepers,
} from './m59-keeper-restart.mjs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

export async function warRestart({ agents = null, concurrency = 1, timeoutS = 90, fleet = fleetName(),
  url = resolveControlUrl().url, fleetState = null } = {}) {
  if (!url) throw Error(resolveControlUrl().why ?? 'war_restart: control URL required');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'war_restart',
      arguments: { fleet_state: fleetState ?? stateFileFor(fleet), ...(agents ? { agents } : {}), concurrency, timeout_ms: timeoutS * 1000 } } }),
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
  waitS = 150, log = console.log, env = process.env, decidedBy = null } = {}) {
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
        fleet, url, fleetState });
      for (const x of r.results)
        log(`  ${x.agent.padEnd(5)} ${x.ok ? `handed off  pid ${x.old_pid} -> ${x.pid} (port ${x.port})` : `FAILED  ${x.why}`}`);
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
      timeoutS: Number(opt('timeout') ?? 90), mode: opt('mode'), waitS: Number(opt('wait-seconds') ?? 150) });
    console.log(r.mode === 'handoff'
      ? `${r.restarted} of ${r.of} handed off without leaving the world`
      : `${r.restarted} of ${r.of} logged off and back on a new pid${r.why ? ` (${r.why})` : ''}`);
    if (!r.ok) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
