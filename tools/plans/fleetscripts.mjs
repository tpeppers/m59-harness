// PLAN ROWS: EVERY FLEETSCRIPT THIS DEPLOYMENT CAN RUN, BY REFLECTION OVER ITS OWN `params`.
//
// A FleetScript already describes itself — `script.params` is { key: {type, required,
// default, describe} } and the REPL's `describe` renders it. This provider renders the
// same description as a PLAN row whose arguments ARE those params, so a script added to
// tools/fleetscripts/ or substrate/fleetscripts/ appears in the client with no edit here.
//
// EACH PARAM IS A PICKER, not a text box, wherever its answer is a finite list the fleet holds:
// agents from the roster, rooms, merchants and what each sells, banks and what is banked in them,
// wanderers, and other FleetScripts (nested, configured in their own form). The vocabulary a
// script declares, and the guesses made for one that declares nothing, are in m59-plan-kinds.mjs.
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
import { argsFor as kindArgs, argId } from '../m59-plan-kinds.mjs';
import { parseArgs } from '../m59-plan-desk.mjs';

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

// The arguments a row offers: m59-plan-kinds.mjs turns each param into its picker (agents, rooms,
// merchants, what a merchant sells, banks, nested scripts). `taskId` maps a script to its row id
// for a nested-script picker.
export function argsFor(script, ctx = {}, scripts = null) {
  return kindArgs(script, ctx, { scripts, taskId: fsId });
}

// A value the REPL can take as one token. The REPL splits on whitespace and has no quoting, so a
// space (a merchant's name, a nested script's JSON) travels as %20 and m59-fleet-repl.mjs decodes
// it. A value with no space or % is passed exactly as before, for a REPL older than that decoding.
export const replValue = v => /[\s%]/.test(v) ? v.replace(/%/g, '%25').replace(/\s/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()) : v;

// The REPL line a row stands for, from values keyed by PARAM NAME. Empty values are left out, so
// the script's own default applies.
export function replLine(name, values) {
  const parts = [name];
  for (const [key, raw] of Object.entries(values)) {
    const v = String(raw ?? '').trim();
    if (v) parts.push(`${key}=${replValue(v)}`);
  }
  return parts.join(' ');
}

const coerce = (spec, v) => ['number', 'room', 'bank'].includes(spec?.type) && v !== '' && Number.isFinite(Number(v)) ? Number(v)
  : spec?.type === 'boolean' ? v === 'true' : v;

// A NESTED SCRIPT'S VALUE IS "<row id>?<its own args>" (protocol 2's task type). It becomes the
// script's name in the param itself and its params, as JSON, in the param `paramsIn` names --
// the shape island-trip's task/taskParams already had. The nested form's agents are dropped: the
// outer run owns the bodies (composeTask in m59-fleetlib.mjs overrides them anyway).
export function taskValue(value, scripts) {
  const [entry, query = ''] = String(value ?? '').split('?');
  if (!entry) return { name: '', params: {} };
  const name = [...scripts.keys()].find(n => fsId(n) === entry || n === entry);
  if (!name) throw new Error(`no script for "${entry}"`);
  const child = scripts.get(name), given = parseArgs(query), params = {};
  for (const [key, spec] of Object.entries(child.params ?? {})) {
    if (spec?.type === 'agents' || key === 'agents') continue;
    const v = String(given[argId(key)] ?? '').trim();
    if (v !== '') params[key] = coerce(spec, v);
  }
  return { name, params };
}

// Row args -> values keyed by param name, nested scripts expanded.
export function valuesFor(script, args, scripts) {
  const values = {};
  for (const [key, spec] of Object.entries(script.params ?? {})) {
    const v = args[argId(key)];
    // A value equal to the declared default is left out, so the script gets its default as a
    // typed value (60000, not "60000") -- several scripts check Number.isSafeInteger on theirs.
    if (v == null || (spec?.default != null && String(spec.default) === String(v).trim())) continue;
    if (spec?.type === 'script' && spec.paramsIn) {
      const t = taskValue(v, scripts);
      values[key] = t.name;
      if (t.name) values[spec.paramsIn] = JSON.stringify(t.params);
      continue;
    }
    values[key] = v;
  }
  return values;
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
        args: argsFor(s, ctx, scripts), _script: name });
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
    let values;
    try { values = valuesFor(s, args, scripts); }
    catch (err) { return { ok: false, message: `${e._script}: ${err.message}` }; }
    const piloted = Object.entries(s.params ?? {}).filter(([, spec]) => spec?.type === 'agents')
      .some(([key]) => asAgents(values[key]).includes(ctx.client.agent));
    if (piloted)
      return { ok: false, message: `${ctx.client.agent} is the character you are piloting — a FleetScript drives keepers, and yours is offline while you play` };
    const line = replLine(e._script, values);
    const r = launch(root, ctx.fleet, line, ctx.substrate, e._script);
    return { ok: true, message: `started: ${line} (pid ${r.pid}; log ${r.log})` };
  },
};
