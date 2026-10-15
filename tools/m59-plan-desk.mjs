#!/usr/bin/env node
// THE PLAN DESK: what the fleet can be asked to do, rendered into the dev client's PLAN tab.
//
//   node tools/m59-plan-desk.mjs --fleet prod [--substrate C:\code\m59-lab\prod-deploy\substrate]
//                                [--dir substrate/client-context] [--once]
//
// The PLAN tab in the patched client (Meridian59/module/merintr/clientcontext.c) is a list
// that works like Spells: one row per thing you can make the fleet do, double-click to run,
// arguments picked from lists the fleet itself supplies. This process is the other half —
// it decides what the rows ARE, from what is actually running, and it executes what you
// pick. The client never speaks to the broker; it only reads and writes two files.
//
// WHERE ROWS COME FROM — a registration pattern, not a hard-coded menu.
//   tools/plans/*.mjs and <substrate>/plans/*.mjs each export `provider`:
//     { id, entries(ctx) -> [entry], run(entryId, args, ctx) -> {ok, message} }
//   and any FleetScript module may export `plans` (same entry shape, with its own `run`),
//   which tools/plans/fleetscripts.mjs registers next to the script. An entry is
//     { id, group, icon, title, describe, running?, disabled?, args:[{id, title, type:
//       'choice'|'count'|'text', options?:[{value,label}], default?}] }
//
// THE FILES (under --dir, the same M59_CLIENT_CONTEXT_DIR the DUM pane uses; separate
// names, because the DUM parser rejects any line it does not know):
//   plan/in/<pid>.tsv    client -> desk, rewritten every second
//     M59PLANREQ 1 <at> <pid> <server%> <account%> <character%> <player_id> <visible 0|1>
//     I <id> <name%> <amount>              inventory, as the client holds it
//     W <id> <name%>                       other players in the client's room (names only the client can resolve)
//     R <seq> <entry id> <args%>           requests not yet acknowledged (args: k=v&k=v)
//     END
//   plan/out/<pid>.tsv   desk -> client
//     M59PLAN 1 <at> <pid> <ack> <control: none|keeper|other> <status%>
//     E <id> <group%> <icon%> <title%> <flags: r running, d disabled, c settings> <describe%>
//     A <entry> <arg> <type: choice|count|text|boolean> <title%> <default%>
//     O <entry> <arg> <value%> <label%>
//     M <seq> <ok 0|1> <message%>          the result of each request, newest last
//     END
//
// A request is executed AT MOST ONCE: its sequence must exceed every sequence already
// acknowledged for that client pid, and the ack is written before the next tick reads.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HARNESS = resolve(HERE, '..');
const FRESH_MS = 6000;

// Newlines survive (percent-encoded, so never a raw TSV break): descriptions read better as paragraphs.
const clean = s => String(s ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
export const enc = s => encodeURIComponent(clean(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const dec = s => { try { return decodeURIComponent(s ?? ''); } catch { return null; } };
const num = s => /^\d{1,16}$/.test(s ?? '') ? Number(s) : NaN;
export const idOk = s => /^[a-z0-9][a-z0-9._:-]{0,99}$/.test(s ?? '');

// ------------------------------------------------------------------ the client's file
export function parsePlanRequest(text, now = Date.now()) {
  if (typeof text !== 'string' || text.length > 262144 || !text.endsWith('\nEND\n')) return null;
  const rows = text.trimEnd().split('\n').map(l => l.split('\t'));
  const h = rows.shift();
  if (rows.pop()?.join('\t') !== 'END') return null;
  if (h.length !== 9 || h[0] !== 'M59PLANREQ' || h[1] !== '1') return null;
  const at = num(h[2]);
  if (!(at <= now + 1000 && now - at <= FRESH_MS)) return null;
  const r = { at, pid: num(h[3]), server: dec(h[4])?.toLowerCase(), account: dec(h[5])?.toLowerCase(),
              character: dec(h[6]), player_id: num(h[7]), visible: h[8] === '1', inventory: [], room: [], requests: [] };
  if (!(r.pid > 0) || !r.account || r.character == null) return null;
  for (const f of rows) {
    if (f[0] === 'I' && f.length === 4) {
      const name = dec(f[2]); if (name == null || r.inventory.length >= 512) return null;
      r.inventory.push({ id: num(f[1]), name, amount: num(f[3]) || 1 });
    } else if (f[0] === 'W' && f.length === 3) {
      const name = dec(f[2]); if (name == null || r.room.length >= 128) return null;
      r.room.push({ id: num(f[1]), name });
    } else if (f[0] === 'R' && f.length === 4) {
      const seq = num(f[1]), args = dec(f[3]);
      if (!(seq > 0) || !idOk(f[2]) || args == null || r.requests.length >= 16) return null;
      r.requests.push({ seq, entry: f[2], args: parseArgs(args) });
    } else return null;
  }
  return r;
}

export function parseArgs(s) {
  const out = {};
  for (const part of String(s ?? '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i)), v = dec(i < 0 ? '' : part.slice(i + 1));
    if (k && v != null && /^[a-z0-9_]{1,40}$/.test(k)) out[k] = v.slice(0, 8192);
  }
  return out;
}

// ------------------------------------------------------------------ the desk's file
export function renderPlanView({ pid, ack, control = 'none', status = '', entries = [], messages = [] }, now = Date.now()) {
  const L = [['M59PLAN', 1, now, pid, ack, control, enc(status)].join('\t')];
  for (const e of entries.slice(0, 256)) {
    if (!idOk(e.id)) continue;
    const flags = (e.running ? 'r' : '') + (e.disabled ? 'd' : '') + (e.configure ? 'c' : '');
    L.push(['E', e.id, enc(e.group ?? ''), enc(e.icon ?? ''), enc(e.title), flags || '-', enc(e.describe ?? '')].join('\t'));
    for (const a of (e.args ?? []).slice(0, 8)) {
      if (!/^[a-z0-9_]{1,40}$/.test(a.id) || !['choice', 'count', 'text', 'boolean'].includes(a.type)) continue;
      L.push(['A', e.id, a.id, a.type, enc(a.title ?? a.id), enc(a.default ?? '')].join('\t'));
      for (const o of (a.options ?? []).slice(0, 600)) L.push(['O', e.id, a.id, enc(o.value), enc(o.label ?? o.value)].join('\t'));
    }
  }
  for (const m of messages.slice(-12)) L.push(['M', m.seq, m.ok ? 1 : 0, enc(m.message)].join('\t'));
  L.push('END');
  return L.join('\n') + '\n';
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
}

// ------------------------------------------------------------------ providers
export async function loadProviders(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter(f => f.endsWith('.mjs') && !f.endsWith('-test.mjs')).sort()) {
      try {
        const m = await import(pathToFileURL(join(d, f)).href + `?t=${statSync(join(d, f)).mtimeMs}`);
        if (m.provider?.id && typeof m.provider.entries === 'function') out.push(m.provider);
      } catch (e) { console.error(`plan provider ${f}: ${e.message}`); }
    }
  }
  return out;
}

// Gather every provider's rows. A provider that throws loses its rows for this tick and
// says so in a disabled row — never takes the whole tab down.
export async function gatherEntries(providers, ctx) {
  const entries = [], owner = new Map();
  for (const p of providers) {
    let rows;
    try { rows = await p.entries(ctx); }
    catch (e) { rows = [{ id: `${p.id}.error`, group: p.id, title: `${p.id}: unavailable`, describe: e.message, disabled: true }]; }
    for (const e of rows ?? []) {
      if (!idOk(e.id) || owner.has(e.id)) continue;
      owner.set(e.id, p); entries.push(e);
    }
  }
  return { entries, owner };
}

export async function runRequest(req, { entries, owner }, ctx) {
  const e = entries.find(x => x.id === req.entry);
  if (!e) return { ok: false, message: `no plan "${req.entry}" here any more` };
  if (e.disabled) return { ok: false, message: `${e.title}: ${e.describe || 'disabled'}` };
  for (const a of e.args ?? []) {
    const v = req.args[a.id] ?? a.default;
    if (v == null || v === '') return { ok: false, message: `${e.title}: ${a.title ?? a.id} is required` };
    if (a.type === 'count' && !/^\d{1,6}$/.test(String(v))) return { ok: false, message: `${a.title ?? a.id} must be a whole number` };
    if (a.type === 'boolean' && !['true', 'false'].includes(String(v))) return { ok: false, message: `${a.title ?? a.id} must be true or false` };
    if (a.type === 'choice' && a.options?.length && !a.options.some(o => String(o.value) === String(v)))
      return { ok: false, message: `${a.title ?? a.id}: "${v}" is not one of the offered options` };
    req.args[a.id] = String(v);
  }
  try {
    const r = await owner.get(e.id).run(e.id, req.args, ctx, e);
    return { ok: !!r?.ok, message: clean(r?.message ?? (r?.ok ? 'done' : 'refused')).slice(0, 2000) };
  } catch (err) { return { ok: false, message: `${e.title}: ${err.message}` }; }
}

// ------------------------------------------------------------------ the loop
export function rosterAgents(stateFile) {
  try {
    const j = JSON.parse(readFileSync(stateFile, 'utf8'));
    return Object.entries(j).map(([agent, v]) => ({ agent, account: String(v?.credentials?.account ?? '').toLowerCase(),
      character: v?.credentials?.character ?? v?.character ?? null }));
  } catch { return []; }
}

export async function createDesk({ fleet, dir, substrate, providerDirs, log = console.error, roster = null }) {
  const state = new Map();   // pid -> { ack, messages }
  roster ??= () => rosterAgents(resolveFleet(['--fleet', fleet === '' ? '-' : fleet]).stateFile);
  async function tick(now = Date.now()) {
    const inDir = join(dir, 'plan', 'in');
    if (!existsSync(inDir)) return 0;
    const providers = await loadProviders(providerDirs);
    const agents = roster();
    const presence = {};
    let served = 0;
    for (const f of readdirSync(inDir).filter(f => /^\d+\.tsv$/.test(f))) {
      let req; try { req = parsePlanRequest(readFileSync(join(inDir, f), 'utf8'), now); } catch { req = null; }
      if (!req || String(req.pid) + '.tsv' !== f) continue;
      const st = state.get(req.pid) ?? { ack: 0, messages: [] };
      const me = agents.find(a => a.account === req.account) ?? null;
      const ctx = { fleet, substrate, harness: HARNESS, dir, now, log, agents,
                    client: { ...req, agent: me?.agent ?? null }, desk: st };
      const g = await gatherEntries(providers, ctx);
      for (const r of req.requests.filter(r => r.seq > st.ack).sort((a, b) => a.seq - b.seq)) {
        st.ack = r.seq;                                          // at most once, even if it throws
        const out = await runRequest(r, g, ctx);
        st.messages.push({ seq: r.seq, ...out }); st.messages = st.messages.slice(-12);
        log(`[plan ${me?.agent ?? req.account}] ${r.entry} ${JSON.stringify(r.args)} -> ${out.ok ? 'ok' : 'refused'}: ${out.message}`);
      }
      // Standing work a provider does every tick for this client (e.g. the Full Auto courier).
      for (const p of providers) if (typeof p.tick === 'function') {
        try { await p.tick(ctx); } catch (e) { log(`[plan ${me?.agent ?? req.account}] ${p.id} tick: ${e.message}`); }
      }
      if (me) presence[me.agent] = { character: req.character, player_id: req.player_id, with: req.room,
                                     inventory: req.inventory, pid: req.pid, at: req.at };
      const after = st.messages.length && req.requests.length ? await gatherEntries(providers, ctx) : g;
      const control = ctx.control ?? 'none';
      const status = me ? `${me.agent} (${req.character}) on fleet ${fleet || '(unnamed)'}` :
        `account ${req.account} is not in fleet ${fleet || '(unnamed)'}'s roster — fleet plans need a fleet character`;
      writeAtomic(join(dir, 'plan', 'out', f), renderPlanView({ pid: req.pid, ack: st.ack, control, status,
        entries: after.entries, messages: st.messages }, Date.now()));
      state.set(req.pid, st); served++;
    }
    // WHO IS AT A KEYBOARD, AND WITH WHOM. The broker has no room for a piloted character (its
    // keeper is offline); the client does. Scripts that meet people read this, never the client files.
    if (substrate) { try { writeAtomic(join(substrate, 'human-presence.json'), JSON.stringify(presence, null, 1)); } catch {} }
    return served;
  }
  return { tick, state };
}

if (process.argv[1]?.endsWith('m59-plan-desk.mjs')) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const { fleet } = resolveFleet(argv);
  const substrate = resolve(arg('substrate', join(HARNESS, 'substrate')));
  const dir = resolve(arg('dir', process.env.M59_CLIENT_CONTEXT_DIR || join(HARNESS, 'substrate', 'client-context')));
  const providerDirs = [join(HERE, 'plans'), join(substrate, 'plans')];
  const desk = await createDesk({ fleet, dir, substrate, providerDirs });
  console.error(`plan desk: fleet ${fleet || '(unnamed)'}, substrate ${substrate}, files under ${join(dir, 'plan')}`);
  if (argv.includes('--once')) { console.error(`served ${await desk.tick()} client(s)`); process.exit(0); }
  for (;;) {
    try { await desk.tick(); } catch (e) { console.error(`plan desk tick: ${e.stack ?? e.message}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
