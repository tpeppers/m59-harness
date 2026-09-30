// HOW A KEEPER IS RESTARTED: HANDED OFF BY DEFAULT, LOGGED OFF ONLY WHEN MEMORY IS SHORT.
//
//   import { decideRestartMode } from './m59-keeper-restart.mjs';
//   const d = decideRestartMode({ concurrency: 3 });   // { mode: 'handoff'|'logoff', ... }
//
// Two ways exist to put a keeper onto new code, and only one of them keeps the character in
// the world.
//
//   HANDOFF (the broker's `war_restart` tool, `warRestartKeeper` in m59-broker.mjs). A hidden
//     replacement keeper logs in, the server drops the old connection, the old keeper exits.
//     Nobody leaves the world. It costs memory: for a moment there are TWO keeper processes
//     for that character, so N handoffs in flight need about N extra keepers' worth of RAM.
//
//   LOGOFF (POST /stop on the keeper port, then the broker's 45s rejoin sweep). The character
//     leaves the world and comes back when the sweep reaches it -- one at a time. On
//     2026-09-30 an enemy player killed the fleet one by one as it logged back in that way.
//
// The handoff is the critical, standard way to restart a keeper. The logoff is kept only as
// the fallback for a machine that cannot afford a second keeper process, and choosing it
// is SAID OUT LOUD: the message names the free memory and the threshold it missed.
//
// THE RULE. Handoff when
//     os.freemem() > (concurrency + 1) x per-keeper RSS + margin
// where per-keeper RSS is measured from the running keepers when a caller can (the largest
// one), else M59_KEEPER_RSS_MB, else 600 MB; and the margin is M59_RESTART_MARGIN_MB, else
// 2048 MB. Measured on prod 2026-09-30: 24 keepers at ~490 MB, 15.1 GB free of 63.8 GB, and a
// full 24/24 handoff at concurrency 1 succeeded. The "+ 1" is headroom for the replacement
// growing past the old keeper while both are up.
//
// In `auto`, a concurrency that does not fit is lowered before handoff is given up: two at a
// time on a tight machine beats logging everybody off. Only when ONE handoff does not fit
// does it fall back to a logoff.
//
// THE OVERRIDE. M59_RESTART_MODE=handoff|logoff|auto (default auto), or a caller's --mode.
// A forced handoff on a short machine goes ahead with a warning; a forced logoff is a logoff.
// An unrecognised value is REPORTED and treated as auto -- never silently applied, never
// silently dropped (docs/m59-policy.md).
//
// Nothing in this module opens a socket except `logoffKeepers` and `probeKeepers`, and the
// only program it can start is `tasklist`/`ps` for the RSS reading, hidden.
import { freemem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  resolveKeeperBand, keeperBandPorts, probeKeeperLive, keeperIdentityHeaders,
} from './runtime/keeper-discovery.mjs';

const MB = 1024 * 1024;
export const DEFAULT_KEEPER_RSS_MB = 600;
export const DEFAULT_MARGIN_MB = 2048;
export const RESTART_MODES = Object.freeze(['auto', 'handoff', 'logoff']);

const positiveMb = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Pure. Everything it reads is an argument, so the test can ask it any machine it likes.
export function decideRestartMode({
  concurrency = 1,
  requested = null,
  env = process.env,
  freeBytes = freemem(),
  keeperRssBytes = null,
  // An earlier decision being carried out, e.g. m59-update deciding before it parks. The mode
  // arrives as `requested`, and this names who chose it, so a logoff chosen by `auto` is never
  // reported as "forced by --mode".
  decidedBy = null,
} = {}) {
  const warnings = [];
  let asked = String(requested ?? env.M59_RESTART_MODE ?? 'auto').trim().toLowerCase() || 'auto';
  const source = decidedBy ? String(decidedBy)
    : requested != null ? '--mode' : env.M59_RESTART_MODE != null ? 'M59_RESTART_MODE' : 'default';
  const why = (m) => decidedBy ? `decided by ${decidedBy}` : `forced by ${source}=${m}`;
  if (!RESTART_MODES.includes(asked)) {
    warnings.push(`unrecognised restart mode ${JSON.stringify(asked)} from ${source}; ` +
                  `using auto (expected ${RESTART_MODES.join('|')})`);
    asked = 'auto';
  }

  let perKeeperMb, perKeeperSource;
  if (positiveMb(keeperRssBytes)) {
    perKeeperMb = Math.round(keeperRssBytes / MB); perKeeperSource = 'measured';
  } else if (positiveMb(env.M59_KEEPER_RSS_MB)) {
    perKeeperMb = positiveMb(env.M59_KEEPER_RSS_MB); perKeeperSource = 'M59_KEEPER_RSS_MB';
  } else {
    if (env.M59_KEEPER_RSS_MB != null)
      warnings.push(`M59_KEEPER_RSS_MB=${JSON.stringify(env.M59_KEEPER_RSS_MB)} is not a positive number; using ${DEFAULT_KEEPER_RSS_MB}`);
    perKeeperMb = DEFAULT_KEEPER_RSS_MB; perKeeperSource = 'default';
  }
  let marginMb = positiveMb(env.M59_RESTART_MARGIN_MB);
  if (marginMb == null) {
    if (env.M59_RESTART_MARGIN_MB != null)
      warnings.push(`M59_RESTART_MARGIN_MB=${JSON.stringify(env.M59_RESTART_MARGIN_MB)} is not a positive number; using ${DEFAULT_MARGIN_MB}`);
    marginMb = DEFAULT_MARGIN_MB;
  }

  const wanted = Math.max(1, Math.floor(Number(concurrency) || 1));
  const freeMb = Math.round(Number(freeBytes) / MB);
  const needMb = (c) => (c + 1) * perKeeperMb + marginMb;
  const rule = (c) => `(${c} + 1) x ${perKeeperMb} MB per keeper (${perKeeperSource}) + ${marginMb} MB margin = ${needMb(c)} MB`;
  const base = { requested: asked, source, free_mb: freeMb, per_keeper_mb: perKeeperMb,
                 per_keeper_source: perKeeperSource, margin_mb: marginMb, asked_concurrency: wanted, warnings };

  if (asked === 'logoff')
    return { ...base, mode: 'logoff', concurrency: wanted, need_mb: needMb(wanted),
             message: `LOGOFF restart (${why('logoff')}): characters leave the world and ` +
                      'return one at a time through the 45s rejoin sweep' };

  if (asked === 'handoff') {
    if (freeMb <= needMb(wanted))
      if (!decidedBy) warnings.push(`handoff forced by ${source} with ${freeMb} MB free, below ${rule(wanted)}`);
    return { ...base, mode: 'handoff', concurrency: wanted, need_mb: needMb(wanted),
             message: `handoff restart (${why('handoff')}), ${wanted} at a time, ${freeMb} MB free` };
  }

  let fits = 0;
  for (let c = wanted; c >= 1; c--) if (freeMb > needMb(c)) { fits = c; break; }
  if (fits >= 1)
    return { ...base, mode: 'handoff', concurrency: fits, need_mb: needMb(fits),
             message: `handoff restart, ${fits} at a time: ${freeMb} MB free > ${rule(fits)}` +
                      (fits < wanted ? ` (lowered from ${wanted}: ${rule(wanted)} does not fit)` : '') };
  return { ...base, mode: 'logoff', concurrency: wanted, need_mb: needMb(1),
           message: `LOGOFF RESTART: only ${freeMb} MB free, and one handoff needs more than ${rule(1)}. ` +
                    'Characters will LEAVE THE WORLD and return one at a time through the 45s rejoin ' +
                    'sweep; their claims, busy, live policy and mode are carried in substrate/fleets/.keeper-carry/. ' +
                    'Free memory, or force it with M59_RESTART_MODE=handoff / --mode handoff.' };
}

// A BROKER THAT ADVERTISES THE PORT RESERVATION (fae8bd3) may run handoffs concurrently;
// an older one lets two replacements probe the same free port and one dies EADDRINUSE
// (nine of twenty-two at concurrency 3, 2026-09-30). The loser fails safely -- the old
// keeper carries on -- but it fails, so an older broker gets one at a time.
export function defaultHandoffConcurrency(brokerHealth) {
  return brokerHealth?.keeper_handoff?.port_reservation === true ? 3 : 1;
}

// THE LARGEST RESIDENT SET among these pids, in bytes, or null when none could be read. One
// program start for the whole set, hidden: a console-less parent gives every unhidden child
// a window on the operator's desktop (m59-nowindow-test.mjs).
export function measureKeeperRssBytes(pids, { exec = execFileSync, platform = process.platform } = {}) {
  const wanted = new Set((pids ?? []).map(Number).filter(p => Number.isSafeInteger(p) && p > 0));
  if (!wanted.size) return null;
  let max = null;
  try {
    if (platform === 'win32') {
      const text = String(exec('tasklist', ['/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
      for (const line of text.split(/\r?\n/)) {
        const cols = line.split('","').map(s => s.replace(/^"|"$/g, ''));
        if (cols.length < 5 || !wanted.has(Number(cols[1]))) continue;
        const kb = Number(cols[4].replace(/[^\d]/g, ''));
        if (kb > 0) max = Math.max(max ?? 0, kb * 1024);
      }
    } else {
      for (const pid of wanted) {
        try {
          const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
          if (m) max = Math.max(max ?? 0, Number(m[1]) * 1024);
        } catch {}
      }
    }
  } catch { return null; }
  return max;
}

// WHO IS UP, by asking each port in the fleet's band who it is. Never by assuming an order.
export async function probeKeepers({ fleet, agents, band = null, fetchImpl = globalThis.fetch } = {}) {
  const checked = band ?? resolveKeeperBand(fleet ?? null, { missing: 'null' });
  const found = new Map();
  if (!checked || !agents?.length) return found;
  const expected = new Set(agents);
  const probes = await Promise.all(keeperBandPorts(checked).map(port =>
    probeKeeperLive(port, { expectedAgents: expected, fetchImpl }).catch(() => null)));
  for (const p of probes) if (p && !found.has(p.agent)) found.set(p.agent, p);
  return found;
}

// THE FALLBACK: POST /stop, ADDRESSED BY AGENT, CHARACTER AND EXACT PID, one keeper at a
// time, and the broker's 45s sweep logs each character back in on the code on disk. Only
// reached when decideRestartMode said logoff; its message is the caller's to print first.
export async function logoffKeepers(identities, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const results = [];
  for (const k of identities) {
    const ok = await fetchImpl(`http://127.0.0.1:${k.port}/stop`, {
      method: 'POST',
      headers: { ...keeperIdentityHeaders(k), 'content-type': 'application/json' },
      body: JSON.stringify({ agent: k.agent, character: k.character, keeper_pid: k.pid }),
      signal: AbortSignal.timeout(8000),
    }).then(r => r.ok).catch(() => false);
    results.push({ agent: k.agent, ok, old_pid: k.pid, port: k.port, ...(ok ? {} : { why: 'stop refused or unanswered' }) });
    log(`  ${k.agent.padEnd(5)} ${ok ? `logged off  pid ${k.pid} (port ${k.port}); the sweep brings it back, claims carried` : 'FAILED  stop refused or unanswered'}`);
  }
  return results;
}
