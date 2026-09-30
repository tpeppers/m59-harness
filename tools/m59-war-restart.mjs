#!/usr/bin/env node
// RESTART KEEPERS ONTO NEW CODE WITHOUT LOGGING ANYBODY OUT.
//
//   node tools/m59-war-restart.mjs --fleet prod                 # every keeper the broker holds
//   node tools/m59-war-restart.mjs --fleet prod --agents t1,t8  # just these
//   node tools/m59-war-restart.mjs --fleet prod --concurrency 4 --timeout 120
//
// The broker's `war_restart` tool: each old keeper is told to hand off, a hidden replacement logs
// in, the server drops the old connection, and the old keeper exits by itself. Nobody leaves the
// world and nobody comes back one at a time, which is what a /stop-and-sweep restart did mid-PvP
// (see warRestartKeeper in m59-broker.mjs). Needs a broker and keepers running code that has it.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fleetName, stateFileFor, resolveControlUrl } from './m59-fleetpath.mjs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

export async function warRestart({ agents = null, concurrency = 3, timeoutS = 90, fleet = fleetName(),
  url = resolveControlUrl().url } = {}) {
  if (!url) throw Error(resolveControlUrl().why ?? 'war_restart: control URL required');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'war_restart',
      arguments: { fleet_state: stateFileFor(fleet), ...(agents ? { agents } : {}), concurrency, timeout_ms: timeoutS * 1000 } } }),
    signal: AbortSignal.timeout(Math.max(60_000, timeoutS * 1000 * 12)) });
  const reply = await response.json();
  const content = reply.result?.content?.find(c => c.type === 'text')?.text;
  if (reply.error || reply.result?.isError) throw Error(content ?? reply.error?.message ?? 'war_restart failed');
  return JSON.parse(content);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await warRestart({ agents: opt('agents')?.split(',').map(s => s.trim()).filter(Boolean) ?? null,
      concurrency: Number(opt('concurrency') ?? 3), timeoutS: Number(opt('timeout') ?? 90) });
    console.log(`${r.restarted} of ${r.of} handed off without leaving the world`);
    for (const x of r.results) console.log(`  ${x.agent.padEnd(5)} ${x.ok ? `ok  pid ${x.old_pid} -> ${x.pid} (port ${x.port})` : `FAILED  ${x.why}`}`);
    if (!r.ok) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
