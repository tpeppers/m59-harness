#!/usr/bin/env node
// THE PLAN DESK: what the fleet can be asked to do, rendered into the dev client's PLAN tab.
//
//   node tools/m59-plan-desk.mjs --fleet prod [--substrate C:\code\m59-lab\prod-deploy\substrate]
//                                [--dir substrate/client-context] [--once] [--parent <pid>]
//
// NORMALLY YOU DO NOT START THIS. The broker does (m59-broker.mjs startPlanDesk): one desk per
// broker, on the broker's own substrate, stopped when the broker stops, restarted if it dies,
// and taken over by the successor across a live handover. `--parent` is how it knows its
// broker: the desk leaves when that pid does, so even a broker killed with taskkill /F does
// not leave one behind. M59_NO_PLAN_DESK=1 (or --no-plan-desk) keeps a broker from starting it.
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
import { execFileSync } from 'node:child_process';
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
export const MAX_ARGS = 6;
export function renderPlanView({ pid, ack, control = 'none', status = '', entries = [], messages = [] }, now = Date.now()) {
  const L = [['M59PLAN', 1, now, pid, ack, control, enc(status)].join('\t')];
  for (const e of entries.slice(0, 256)) {
    if (!idOk(e.id)) continue;
    const flags = (e.running ? 'r' : '') + (e.disabled ? 'd' : '') + (e.configure ? 'c' : '');
    L.push(['E', e.id, enc(e.group ?? ''), enc(e.icon ?? ''), enc(e.title), flags || '-', enc(e.describe ?? '')].join('\t'));
    // AT MOST SIX ARGUMENTS, the client's MAX_ARGS (planpane.c). Its parser rejects the WHOLE reply on
    // a seventh, and a seventh is what a FleetScript with seven params reflects (stock-desk), so every
    // reply was dropped and the PLAN tab said the desk was not answering. Valid ones first, then cut.
    const args = (e.args ?? []).filter(a => /^[a-z0-9_]{1,40}$/.test(a.id) && ['choice', 'count', 'text', 'boolean'].includes(a.type));
    for (const a of args.slice(0, MAX_ARGS)) {
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

// ------------------------------------------------------------------ one desk per client folder
// THE GUARD IS THE CLIENT FOLDER, not the substrate. Every desk writes its replies into the
// client folder, so two desks on two substrates still answered one client twice (the 2026-10-16
// "two desks" problem in docs/m59-plan-tab.md). The substrate heartbeat is still written, for a
// fleet terminal from before this that looks only there.
export const DESK_FRESH_MS = 30_000;
export const deskBeatFiles = ({ dir, substrate = null }) =>
  [join(dir, 'plan', 'desk.json'), ...(substrate ? [join(substrate, 'plan-desk.json')] : [])];
export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function liveDesk({ dir, substrate = null }, { exceptPid = null, now = Date.now(), alive = pidAlive } = {}) {
  for (const file of deskBeatFiles({ dir, substrate })) {
    try {
      const h = JSON.parse(readFileSync(file, 'utf8'));
      if (h.pid > 0 && h.pid !== exceptPid && now - h.at < DESK_FRESH_MS && alive(h.pid)) return { ...h, file };
    } catch { /* none, or half-written */ }
  }
  return null;
}
// Two desks that both started before either beat: the one that started later steps aside.
export const yieldsTo = (other, me) => (other.since ?? 0) < me.since || ((other.since ?? 0) === me.since && other.pid < me.pid);

// WHAT THIS CLIENT WAS LAST TOLD, so a desk that restarts (a broker handover, a crash) does not
// run again a request its predecessor already acknowledged and the client has not yet dropped.
export function lastAck(dir, pid) {
  try {
    const h = readFileSync(join(dir, 'plan', 'out', `${pid}.tsv`), 'utf8').split('\n', 1)[0].split('\t');
    return h[0] === 'M59PLAN' && num(h[3]) === pid ? (num(h[4]) || 0) : 0;
  } catch { return 0; }
}

// ------------------------------------------------------------------ a desk elsewhere
// A CLIENT WITH NO DESK IS TOLD WHERE ONE IS. dev.bat points a client at ITS checkout's client
// folder, and the desk runs with the broker -- usually prod-deploy's. A client launched from the
// trunk then said only "the plan desk is not answering" while a desk for the same fleet was up one
// checkout over. So every desk also looks at the client folders of this repository's other
// checkouts, and answers any client there that no desk serves: who is serving, from where, and
// which client to launch. It runs nothing for that client; a request typed there is refused, so
// it is never left pending for a desk that might pick it up minutes later.
//
// NOT DURING A HANDOVER. A folder whose own desk beat within STRAY_QUIET_MS is a desk restarting
// (the broker's successor starts its own within ten seconds), and answering it as deskless would
// refuse a request its real desk is about to run.
export const STRAY_QUIET_MS = 60_000;
const sameDir = (a, b) => { const n = p => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };

// Every checkout of this repository, by `git worktree list`: the trunk, prod-deploy, work-*.
export function checkoutRoots(harness = HARNESS, run = null) {
  run ??= () => execFileSync('git', ['-C', harness, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try { return run().split('\n').filter(l => l.startsWith('worktree ')).map(l => resolve(l.slice(9).trim())); }
  catch { return [harness]; }
}
export function clientFolders(roots, extra = []) {
  const out = [];
  for (const d of [...roots.map(r => join(r, 'substrate', 'client-context')), ...extra.filter(Boolean)])
    if (!out.some(o => sameDir(o, d))) out.push(resolve(d));
  return out;
}
// The live desks among those folders, each with the checkout it runs from.
export function desksIn(folders, opts = {}) {
  const out = [];
  for (const dir of folders) { const d = liveDesk({ dir }, opts); if (d && !out.some(o => o.pid === d.pid)) out.push(d); }
  return out;
}
const deskRoot = d => d.root ?? (d.substrate ? dirname(d.substrate) : null);

export function elsewhereView({ pid, ack, dir, desks, messages = [] }, now = Date.now()) {
  const d = desks[0];
  const root = deskRoot(d) ?? '(unknown checkout)';
  const launch = `node "${join(root, 'tools', 'm59-tui.mjs')}" --fleet ${d.fleet || '-'}`;
  const status = `NO PLAN DESK FOR THIS CLIENT. A desk for fleet ${d.fleet || '(unnamed)'} is running from ` +
    `${root} -- launch the client from there: ${launch}`;
  const entries = [{ id: 'desk.elsewhere', group: 'Desk', icon: '', disabled: true,
    title: `The desk is running from ${root}`,
    describe: [`This client reads ${dir}, and no plan desk serves it, so nothing here can run.`,
      `A desk for fleet ${d.fleet || '(unnamed)'} is up (pid ${d.pid}) in ${root}, answering the client folder ${d.dir}.`,
      `To use it, close this client and launch the one from that checkout: ${launch} (then L), or prod.ps1 for prod.`,
      ...(desks.length > 1 ? [`Other desks: ${desks.slice(1).map(o => `${deskRoot(o)} (fleet ${o.fleet || '-'})`).join('; ')}.`] : [])]
      .join('\n\n') }];
  return renderPlanView({ pid, ack, control: 'none', status, entries, messages }, now);
}

// One pass over the other folders. `state` keeps each stray client's ack and messages.
export function serveStrays({ ownDir, folders, state = new Map(), now = Date.now(), alive = pidAlive, log = () => {} }) {
  const desks = desksIn(folders, { now, alive });
  if (!desks.length) return 0;
  let served = 0;
  for (const dir of folders) {
    if (sameDir(dir, ownDir) || liveDesk({ dir }, { now, alive })) continue;
    try { if (now - statSync(join(dir, 'plan', 'desk.json')).mtimeMs < STRAY_QUIET_MS) continue; } catch { /* never had one */ }
    const inDir = join(dir, 'plan', 'in');
    let files; try { files = readdirSync(inDir).filter(f => /^\d+\.tsv$/.test(f)); } catch { continue; }
    for (const f of files) {
      let req; try { req = parsePlanRequest(readFileSync(join(inDir, f), 'utf8'), now); } catch { req = null; }
      if (!req || String(req.pid) + '.tsv' !== f) continue;
      const key = `${resolve(dir)}|${req.pid}`;
      const st = state.get(key) ?? { ack: lastAck(dir, req.pid), messages: [] };
      for (const r of req.requests.filter(r => r.seq > st.ack).sort((a, b) => a.seq - b.seq)) {
        st.ack = r.seq;
        st.messages.push({ seq: r.seq, ok: false, message: `not run: no plan desk serves this client. The desk is ` +
          `running from ${deskRoot(desks[0])}; launch the client from there.` });
        st.messages = st.messages.slice(-12);
        log(`[plan stray] ${dir} pid ${req.pid}: refused ${r.entry} -- its desk runs from ${deskRoot(desks[0])}`);
      }
      try { writeAtomic(join(dir, 'plan', 'out', f), elsewhereView({ pid: req.pid, ack: st.ack, dir, desks, messages: st.messages }, Date.now())); }
      catch { continue; }
      state.set(key, st); served++;
    }
  }
  return served;
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
      const st = state.get(req.pid) ?? { ack: lastAck(dir, req.pid), messages: [] };
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
  // ONE DESK PER CLIENT FOLDER. The broker starts one (startPlanDesk) and so does the fleet
  // terminal's L when no broker has (m59-tui.mjs ensurePlanDesk); either way a second is refused.
  const parent = Number(arg('parent', 0)) || null;
  const me = { pid: process.pid, since: Date.now() };
  const held = liveDesk({ dir, substrate }, { exceptPid: process.pid });
  if (held) { console.error(`a plan desk (pid ${held.pid}) is already serving ${held.dir ?? dir}`); process.exit(0); }
  const beats = deskBeatFiles({ dir, substrate });
  const heartbeat = () => {
    const other = liveDesk({ dir, substrate }, { exceptPid: process.pid });
    if (other && yieldsTo(other, me)) { console.error(`plan desk pid ${other.pid} also started; this one (pid ${process.pid}) steps aside`); process.exit(0); }
    const h = JSON.stringify({ pid: process.pid, at: Date.now(), since: me.since, fleet, dir, substrate, root: HARNESS, parent });
    for (const f of beats) { try { writeAtomic(f, h); } catch {} }
  };
  // The other checkouts' client folders, re-listed once a minute (a worktree can appear any time).
  // ONLY THOSE WITH A plan/ FOLDER, which a client or a desk has used: this machine had 333
  // checkouts, and reading all of them every two seconds cost ~100ms a pass to answer three.
  const strays = new Map();
  let folders = [], listedAt = 0;
  const strayPass = () => {
    if (Date.now() - listedAt > 60_000) {
      folders = clientFolders(checkoutRoots(HARNESS), [process.env.M59_CLIENT_CONTEXT_DIR, dir]).filter(d => existsSync(join(d, 'plan')));
      listedAt = Date.now();
    }
    try { serveStrays({ ownDir: dir, folders, state: strays, log: m => console.error(m) }); }
    catch (e) { console.error(`plan desk strays: ${e.message}`); }
  };
  process.on('exit', () => {
    for (const f of beats) { try { const h = JSON.parse(readFileSync(f, 'utf8')); if (h.pid === process.pid) writeFileSync(f, JSON.stringify({ ...h, at: 0 })); } catch {} }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  for (let n = 0; ; n++) {
    if (parent && !pidAlive(parent)) { console.error(`plan desk: broker pid ${parent} is gone; leaving with it`); process.exit(0); }
    if (n % 5 === 0) heartbeat();
    if (n % 2 === 1) strayPass();   // inside the client's 6s freshness window
    try { await desk.tick(); } catch (e) { console.error(`plan desk tick: ${e.stack ?? e.message}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
