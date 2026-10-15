// PLAN ROWS: EVERY FLEETSCRIPT THIS DEPLOYMENT CAN RUN, BY REFLECTION OVER ITS OWN `params`.
//
// A FleetScript already describes itself — `script.params` is { key: {type, required,
// default, describe} } and the REPL's `describe` renders it. This provider renders the
// same description as a PLAN row whose arguments ARE those params, so a script added to
// tools/fleetscripts/ or substrate/fleetscripts/ appears in the client with no edit here.
//
// A script may also export `plans`: [{ id, title, icon, describe, args, run(args, ctx) }]
// for intents that are not "run me with these params" — e.g. editing a loop's standing
// config. Those register under `fs.<script>.<id>` next to the script's own row.
//
// RUNNING means: a per-agent run lock (m59-runlock.mjs) labelled with the script, or a
// repeat loop (substrate/fleetscripts/lib/repeat.mjs) whose log says it runs the script,
// with a live pid. Neither is a registry anybody maintains; both are what the runners
// already leave behind, which is why they can be trusted to exist.
//
// Running a row is exactly what typing the line into m59-fleet-repl.mjs would do — the
// same process, the same checks, the same run locks — detached, with its output kept in
// <substrate>/history/<fleet>/plan-desk/.

import { readFileSync, readdirSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { loadFleetScripts, asAgents } from '../m59-fleetlib.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const fsId = n => `fs.${String(n).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`.slice(0, 90);

export function runningScripts(substrate, fleet) {
  const out = new Map();   // script name -> [what]
  const add = (name, what) => { if (!out.has(name)) out.set(name, []); out.get(name).push(what); };
  for (const f of existsSync(substrate) ? readdirSync(substrate).filter(f => /^run-.*\.lock$/.test(f)) : []) {
    const l = readJson(join(substrate, f));
    const name = String(l?.label ?? '').split(' ')[0];
    if (name && l.pid && alive(l.pid)) add(name, `running now on ${l.agent ?? 'the fleet'}`);
  }
  const loops = join(substrate, 'history', fleet || 'default', 'loops');
  for (const f of existsSync(loops) ? readdirSync(loops).filter(f => f.endsWith('-repeat.pid')) : []) {
    const pid = Number(readFileSync(join(loops, f), 'utf8'));
    if (!pid || !alive(pid)) continue;
    // The LAST "repeat up" line: a log outlives restarts, and the `until` stamp is full of colons.
    let line = [];
    try { line = [...readFileSync(join(loops, f.replace(/\.pid$/, '.log')), 'utf8').matchAll(/repeat up: every ([\d.]+) min until \S+: (.+)/g)].at(-1) ?? []; } catch {}
    const name = (line[2] ?? '').split(' ')[0] || f.replace(/-repeat\.pid$/, '');
    add(name, `looping every ${line[1] ?? '?'} min: ${line[2] ?? '(line unknown)'}`);
  }
  return out;
}

export function argsFor(script, ctx) {
  return Object.entries(script.params ?? {}).slice(0, 8).map(([key, spec]) => {
    const id = key.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
    const title = `${key}${spec?.required ? '' : ' (optional)'}`;
    if (spec?.type === 'number') return { id, key, title, type: 'text', default: spec.default != null ? String(spec.default) : '' };
    if (spec?.type === 'agents')
      return { id, key, title: `${title} — comma-separated`, type: 'text', default: spec.default != null ? String(spec.default) : '' };
    return { id, key, title, type: 'text', default: spec?.default != null ? String(spec.default) : '' };
  });
}

// The REPL line a row stands for. Values are quoted the way the REPL tokenises them.
export function replLine(name, script, args) {
  const parts = [name];
  for (const a of argsFor(script)) {
    const v = String(args[a.id] ?? '').trim();
    if (!v) continue;
    if (/[\s"]/.test(v)) return null;   // the REPL splits on whitespace; refuse rather than mangle
    parts.push(`${a.key}=${v}`);
  }
  return parts.join(' ');
}

export function launch(root, fleet, line, substrate, tag) {
  const dir = join(substrate, 'history', fleet || 'default', 'plan-desk');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.log`);
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [join(root, 'tools', 'm59-fleet-repl.mjs'), '--fleet', fleet === '' ? '-' : fleet],
    { cwd: root, detached: true, windowsHide: true, stdio: ['pipe', out, out] });
  child.stdin.end(`${line}\nquit\n`);
  child.unref();
  return { pid: child.pid, log };
}

let cache = { key: '', scripts: new Map() };
async function scriptsOf(substrate, harness) {
  const local = join(substrate, 'fleetscripts');
  const pub = join(dirname(substrate), 'tools', 'fleetscripts');
  const key = `${pub}|${local}`;
  const { scripts } = await loadFleetScripts({ dirs: [['public', existsSync(pub) ? pub : join(harness, 'tools', 'fleetscripts')],
    ['local', local], ['pvp', join(local, 'pvp')]] });
  cache = { key, scripts };
  return scripts;
}

export const provider = {
  id: 'fleetscripts',
  async entries(ctx) {
    const scripts = await scriptsOf(ctx.substrate, ctx.harness);
    const running = runningScripts(ctx.substrate, ctx.fleet);
    const rows = [
      { id: 'fs.line', group: 'FleetScript', icon: 'scroll', title: 'Run a FleetScript line…',
        describe: 'Exactly as if typed into m59-fleet-repl.mjs on this fleet, e.g. `zheng-he-lap agents=hk2`. ' +
                  'Also runnable from the chat box: `fs <line>`.',
        args: [{ id: 'line', title: 'Line', type: 'text', default: '' }] },
      { id: 'fs.dry', group: 'FleetScript', icon: 'scroll', title: 'Dry-run a FleetScript line…',
        describe: 'Shows the steps the line would take, without moving anybody (the REPL\'s `dry`).',
        args: [{ id: 'line', title: 'Line', type: 'text', default: '' }] },
    ];
    // Running scripts first, then the rest alphabetically: the tab answers "what is the fleet doing" before "what could it do".
    const names = [...scripts.keys()].sort((a, b) => (running.has(b) - running.has(a)) || a.localeCompare(b));
    for (const name of names) {
      const s = scripts.get(name), r = running.get(name);
      rows.push({ id: fsId(name), group: r ? 'FleetScript: running' : `FleetScript: ${s.source}`, icon: 'scroll',
        title: name, running: !!r,
        describe: `${r ? r.join('; ') + '\n\n' : ''}${s.describe ?? ''}${s.unsafe ? `\n\nWAIVES: ${(s.unsafe.waives ?? []).join(', ')} — ${s.unsafe.reason ?? ''}` : ''}`,
        args: argsFor(s, ctx), _script: name });
      for (const p of Array.isArray(s.plans) ? s.plans : []) {
        if (!p?.id || typeof p.run !== 'function') continue;
        rows.push({ id: `${fsId(name)}.${String(p.id).toLowerCase()}`.slice(0, 100), group: `FleetScript: ${name}`, icon: p.icon ?? 'scroll',
          title: p.title ?? p.id, describe: p.describe ?? '', running: !!r, args: p.args ?? [], _plan: p });
      }
    }
    return rows;
  },
  async run(entry, args, ctx, e) {
    const root = dirname(ctx.substrate);
    if (e._plan) return e._plan.run(args, ctx);
    if (entry === 'fs.line' || entry === 'fs.dry') {
      const line = String(args.line ?? '').trim();
      if (!/^[a-z0-9][\w.-]*(\s+[\w.-]+=\S+)*\s*$/i.test(line)) return { ok: false, message: 'expected `<script> key=value ...`' };
      const r = launch(root, ctx.fleet, entry === 'fs.dry' ? `dry ${line}` : line, ctx.substrate, line.split(/\s/)[0]);
      return { ok: true, message: `${entry === 'fs.dry' ? 'dry run' : 'started'}: ${line} (pid ${r.pid}; log ${r.log})` };
    }
    const scripts = await scriptsOf(ctx.substrate, ctx.harness);
    const s = scripts.get(e._script);
    if (!s) return { ok: false, message: `${e._script} is not loadable any more` };
    const line = replLine(e._script, s, args);
    if (!line) return { ok: false, message: 'a value contains a space or quote; use "Run a FleetScript line…" instead' };
    const agentsArg = argsFor(s).find(a => s.params[a.key]?.type === 'agents');
    if (agentsArg && asAgents(args[agentsArg.id]).includes(ctx.client.agent))
      return { ok: false, message: `${ctx.client.agent} is the character you are piloting — a FleetScript drives keepers, and yours is offline while you play` };
    const r = launch(root, ctx.fleet, line, ctx.substrate, e._script);
    return { ok: true, message: `started: ${line} (pid ${r.pid}; log ${r.log})` };
  },
};
