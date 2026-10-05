#!/usr/bin/env node
// REAP ORPHANED MONITOR PIPELINES — the `tail -f log | grep …` an agent session left behind.
//
//   node tools/m59-reap.mjs              what it WOULD kill, and why. Changes nothing.
//   node tools/m59-reap.mjs --kill       kill them
//   node tools/m59-reap.mjs --json       the same, for a scheduler's log
//   node tools/m59-reap.mjs --min-age 30 only processes older than 30 minutes (default 10)
//
// WHY THIS EXISTS. A watcher started as `tail -f x.log | grep --line-buffered …` runs under a
// bash that the agent harness owns. When the session ends, or its task is stopped, bash goes
// and the two halves of the pipe do not: `tail -f` never reaches EOF, so it never exits, and
// the grep waits on it for ever. Measured 2026-10-05: 138 grep.exe and 129 tail.exe, about
// 1.45 GB, every one from a single afternoon's sessions in prod-deploy, every parent gone.
// Same family as TaskStop leaving the node child alive — a stop that reports success.
//
// WHAT IT WILL KILL, AND NOTHING ELSE. A process is reaped only when ALL of these hold:
//   - its image is one of REAPABLE (tail.exe, grep.exe) — a closed list, not a pattern;
//   - its command line is a monitor: `tail` with -f/-F/--follow, or `grep` with --line-buffered.
//     A one-shot grep that happens to be slow is not a monitor and is left alone;
//   - it is ORPHANED: its parent pid is gone, or that pid now names a process created AFTER
//     it (a recycled pid wearing the old number — on Windows the parent link is never cleared);
//   - it is older than --min-age, so a pipeline caught between its shell's fork and exec is
//     not mistaken for a dead one.
//
// NODE IS NEVER REAPED, ON PURPOSE. A keeper outliving its broker is by design — the 45s sweep
// re-adopts it, and a broker restarting the same roster adopts guarded survivors (CLAUDE.md,
// "Every keeper is a child process of the broker"). An orphaned node.exe is therefore often a
// live character, and a reaper that cannot tell the difference must not guess.
//
// Each pid is re-read immediately before the kill and must still carry the same creation time
// it was judged on, and only that pid is killed (`taskkill /F`, never `/T`). Windows only; on
// anything else it says so and exits 0, because a scheduled job failing is noise.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REAPABLE = new Set(['tail.exe', 'grep.exe']);

// A monitor is a process that is designed never to finish on its own.
export function isMonitor(name, cmd) {
  const c = String(cmd ?? '');
  const n = String(name ?? '').toLowerCase();
  if (n === 'tail.exe') return /(^|\s)(-[a-zA-Z0-9+]*[fF][a-zA-Z0-9]*|--follow(=\S+)?)(\s|$)/.test(c);
  if (n === 'grep.exe') return /(^|\s)--line-buffered(\s|$)/.test(c);
  return false;
}

// procs: [{pid, ppid, name, cmd, created: ms}]. Returns [{...proc, why}] to reap.
export function classify(procs, { now = Date.now(), minAgeMs = 10 * 60_000 } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = [];
  for (const p of procs) {
    if (!REAPABLE.has(String(p.name).toLowerCase())) continue;
    if (!isMonitor(p.name, p.cmd)) continue;
    if (!Number.isFinite(p.created) || now - p.created < minAgeMs) continue;
    const parent = byPid.get(p.ppid);
    let why = null;
    if (!parent) why = `parent ${p.ppid} is gone`;
    else if (Number.isFinite(parent.created) && parent.created > p.created)
      why = `parent pid ${p.ppid} was recycled (now ${parent.name}, started after this)`;
    if (why) out.push({ ...p, why });
  }
  return out;
}

function listProcesses() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
    "@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } }} | ConvertTo-Json -Compress";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.error || r.status !== 0) throw new Error(`could not list processes: ${r.error?.message ?? r.stderr}`);
  const rows = JSON.parse(r.stdout || '[]');
  return (Array.isArray(rows) ? rows : [rows]).map(x => ({
    pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name, cmd: x.CommandLine ?? '',
    created: x.Created ? Date.parse(x.Created) : NaN,
  }));
}

function parseArgs(argv) {
  const a = { kill: false, json: false, minAgeMs: 10 * 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--kill') a.kill = true;
    else if (v === '--json') a.json = true;
    else if (v === '--min-age') a.minAgeMs = Number(argv[++i]) * 60_000;
    else if (v === '-h' || v === '--help') a.help = true;
    else throw new Error(`unknown argument: ${v}`);
  }
  if (!Number.isFinite(a.minAgeMs) || a.minAgeMs < 0) throw new Error('--min-age takes a number of minutes');
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log('usage: node tools/m59-reap.mjs [--kill] [--json] [--min-age <minutes>]'); return 0; }
  if (process.platform !== 'win32') { console.log('m59-reap: Windows only; nothing to do here'); return 0; }

  const victims = classify(listProcesses(), { minAgeMs: a.minAgeMs });
  const results = [];
  if (a.kill && victims.length) {
    // Re-read once, right before killing: a pid judged a minute ago may be somebody else now.
    const fresh = new Map(listProcesses().map(p => [p.pid, p]));
    for (const v of victims) {
      const now = fresh.get(v.pid);
      if (!now) { results.push({ ...v, outcome: 'already gone' }); continue; }
      if (now.created !== v.created || now.name !== v.name) { results.push({ ...v, outcome: 'pid changed hands; left alone' }); continue; }
      const r = spawnSync('taskkill', ['/PID', String(v.pid), '/F'], { encoding: 'utf8', windowsHide: true });
      // Killing a tail closes its grep's stdin, so the grep often exits between the re-read and
      // its own taskkill. "not found" is that, not a failure.
      const msg = (r.stderr || r.stdout || '').trim();
      results.push({ ...v, outcome: r.status === 0 ? 'killed' : /not found/i.test(msg) ? 'exited' : `taskkill failed: ${msg}` });
    }
  } else {
    for (const v of victims) results.push({ ...v, outcome: a.kill ? 'killed' : 'would kill' });
  }

  const killed = results.filter(r => r.outcome === 'killed' || r.outcome === 'exited').length;
  if (a.json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), mode: a.kill ? 'kill' : 'dry-run',
      found: victims.length, killed, processes: results.map(({ pid, ppid, name, cmd, created, why, outcome }) =>
        ({ pid, ppid, name, cmd, created: new Date(created).toISOString(), why, outcome })) }));
  } else {
    for (const r of results)
      console.log(`${r.outcome.padEnd(12)} ${String(r.pid).padStart(6)} ${r.name.padEnd(9)} ${r.why}  ${r.cmd.slice(0, 110)}`);
    const verb = a.kill ? `killed ${killed} of ${victims.length}` : `${victims.length} would be reaped (dry run; --kill to act)`;
    console.log(`m59-reap: ${verb} orphaned monitor process(es)`);
  }
  return results.some(r => r.outcome.startsWith('taskkill failed')) ? 1 : 0;
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main().then(c => process.exit(c), e => { console.error(`m59-reap: ${e.message}`); process.exit(2); });
