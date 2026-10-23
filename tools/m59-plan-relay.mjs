#!/usr/bin/env node
// THE PLAN DESK OVER THE NETWORK: a MANAGE tab on one machine, the fleet's desk on another.
//
//   node tools/m59-plan-relay.mjs run --broker vecna [--port 8901] [--dir substrate/client-context]
//   node tools/m59-plan-relay.mjs status [--dir ...]
//
// The patched client's MANAGE tab talks to the plan desk through two files and nothing else
// (m59-plan-desk.mjs has the format): plan/in/<pid>.tsv, rewritten every second, and
// plan/out/<pid>.tsv, the desk's answer. The desk runs beside the broker (startPlanDesk),
// because that is where the run locks, the receipts and the roster are -- a FleetScript a row
// starts runs THERE. A client on another machine (the Deck, playing through the operator
// gateway against the broker on Vecna) has the files and no desk. This carries them:
//
//   client --writes--> <dir>/plan/in/<pid>.tsv   --relay POST--> broker /plan/v1/exchange
//                                                                  writes the desk's plan/in/<remote pid>.tsv
//   client <--reads--  <dir>/plan/out/<pid>.tsv  <--relay------  returns the desk's plan/out/<remote pid>.tsv
//
// TWO THINGS ARE REWRITTEN, AND NOTHING ELSE.
//   * THE PID. Two machines' pids collide -- a Wine pid on the Deck can be the pid of a client
//     on Vecna -- and the desk keys acknowledgements on it, so a collision would run one
//     client's request as the other's. A remote pid is REMOTE_PID_BASE + slot * 1e9 + pid, the
//     slot a hash of this machine's name; the broker refuses a relayed pid below the base, so a
//     relay can never write over a local client's file.
//   * THE TIME. The desk drops a request older than 6 s by ITS clock and the client drops a
//     reply older than 6 s by ITS clock; two machines' clocks are not one clock. The broker
//     stamps the request on receipt, and returns the reply's age, which the relay restamps
//     against this machine's clock.
//
// The broker side is `servePlanRelay`, a handler the broker routes one path to; it is
// loopback-only like every other admin surface, which through the operator gateway means
// "a listed operator machine". When the broker does not answer -- down, unreachable, or a
// broker older than this route -- the relay writes the reason into the MANAGE tab itself,
// so the tab never just says "not answering".
//
// It also beats <dir>/plan/desk.json, so this machine's fleet terminal sees a desk serving
// the folder and does not start a local one.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { parsePlanRequest, renderPlanView, freshRequests, liveDesk, pidAlive, HARNESS } from './m59-plan-desk.mjs';

export const PLAN_RELAY_PATH = '/plan/v1/exchange';
export const REMOTE_PID_BASE = 8_000_000_000_000;   // 13 digits; the desk accepts up to 16
const MAX_BODY = 262144;
const FRESH_MS = 6000;

// ------------------------------------------------------------------ pids and stamps
export function slotFor(name = hostname()) {
  let h = 2166136261;
  for (const ch of String(name)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 1000;
}
export const remotePid = (pid, slot) => REMOTE_PID_BASE + slot * 1_000_000_000 + pid;
export const localPid = (rpid, slot) => rpid - REMOTE_PID_BASE - slot * 1_000_000_000;

// Replace header fields by index: the request header is M59PLANREQ ver at pid ..., the reply
// header M59PLAN ver at pid .... Both put `at` at 2 and `pid` at 3.
export function restamp(text, { at, pid }) {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const h = text.slice(0, nl).split('\t');
  if (h.length < 4) return null;
  if (at != null) h[2] = String(Math.trunc(at));
  if (pid != null) h[3] = String(pid);
  return h.join('\t') + text.slice(nl);
}
const errorText = e => e == null ? null : typeof e === 'string' ? e : (e.message ?? JSON.stringify(e));
const headerOf = text => String(text ?? '').split('\n', 1)[0].split('\t');

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
}

// ------------------------------------------------------------------ the broker's half
// One exchange: a relayed request in, the desk's latest reply for that pid out.
export function exchange({ dir, text, now = Date.now() }) {
  if (typeof text !== 'string' || text.length > MAX_BODY) return { status: 413, body: { ok: false, error: 'request too large' } };
  const h = headerOf(text);
  const pid = /^\d{1,16}$/.test(h[3] ?? '') ? Number(h[3]) : NaN;
  if (h[0] !== 'M59PLANREQ') return { status: 400, body: { ok: false, error: 'not a plan request' } };
  if (!(pid >= REMOTE_PID_BASE) || !Number.isSafeInteger(pid))
    return { status: 400, body: { ok: false, error: `a relayed pid must be at least ${REMOTE_PID_BASE}` } };
  const stamped = restamp(text, { at: now });
  if (!stamped || !parsePlanRequest(stamped, now)) return { status: 400, body: { ok: false, error: 'malformed plan request' } };
  writeAtomic(join(dir, 'plan', 'in', `${pid}.tsv`), stamped);
  let out = null, age_ms = null;
  try {
    out = readFileSync(join(dir, 'plan', 'out', `${pid}.tsv`), 'utf8');
    const oh = headerOf(out);
    if (oh[0] !== 'M59PLAN' || Number(oh[3]) !== pid) out = null;
    else age_ms = Math.max(0, now - Number(oh[2]));
  } catch { /* the desk has not answered this pid yet */ }
  const desk = liveDesk({ dir }, { now });
  return { status: 200, body: { ok: true, out, age_ms, desk: desk ? { pid: desk.pid, fleet: desk.fleet ?? null } : null } };
}

// The HTTP handler the broker routes PLAN_RELAY_PATH to. `local` is the broker's own loopback
// verdict for this socket, decided before the body is read.
export function servePlanRelay(req, res, { dir, local }) {
  const reply = (status, body) => { const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
    res.end(s); };
  if (!local) return reply(403, { ok: false, error: 'the plan relay is loopback-only (use the operator gateway)' });
  let body = '';
  req.on('data', d => { body += d; if (body.length > MAX_BODY) { reply(413, { ok: false, error: 'request too large' }); req.destroy(); } });
  req.on('end', () => {
    if (res.headersSent) return;
    try { const r = exchange({ dir, text: body }); reply(r.status, r.body); }
    catch (e) { reply(500, { ok: false, error: e.message }); }
  });
}

// ------------------------------------------------------------------ this machine's half
// What the tab shows when the far side cannot be asked.
export function offlineView(text, why, now = Date.now()) {
  const h = headerOf(text);
  const pid = Number(h[3]), version = Number(h[1]) || 1;
  // Acknowledge nothing: a request typed while the broker is away stays pending in the client and
  // goes through when it comes back (the desk runs each sequence at most once).
  return renderPlanView({ version, pid, ack: 0, control: 'none', status: `PLAN RELAY: ${why}`,
    entries: [{ id: 'relay.offline', group: 'Desk', icon: '', disabled: true, title: 'The fleet desk cannot be reached',
      describe: `This client's MANAGE tab is relayed to the plan desk beside the fleet's broker.\n\n${why}` }] }, now);
}

export function createRelay({ dir, url, slot = slotFor(), fetchImpl = fetch, log = () => {} }) {
  const lastWhy = new Map();
  async function tick(now = Date.now()) {
    const inDir = join(dir, 'plan', 'in');
    let served = 0;
    for (const f of freshRequests(inDir, now)) {
      const pid = Number(f.replace(/\.tsv$/, ''));
      if (!(pid > 0) || pid >= REMOTE_PID_BASE) continue;
      let text; try { text = readFileSync(join(inDir, f), 'utf8'); } catch { continue; }
      if (!parsePlanRequest(text, now)) continue;                   // half-written, or not a request
      const rpid = remotePid(pid, slot);
      const outFile = join(dir, 'plan', 'out', f);
      let why = null;
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'text/plain' },
          body: restamp(text, { pid: rpid }), signal: AbortSignal.timeout(4000) });
        const j = await r.json().catch(() => null);
        // A broker without the route answers this path as MCP: a JSON-RPC parse error, not a 404.
        if (r.status === 404 || j?.jsonrpc || (r.status === 405 && !j))
          why = `the broker at ${url} has no plan relay route -- it is older than this relay; deploy and restart it`;
        else if (!j?.ok) why = `the broker refused: ${errorText(j?.error) ?? `HTTP ${r.status}`}`;
        else if (!j.desk) why = 'the broker answered, but no plan desk is running beside it';
        else if (j.out && j.age_ms <= FRESH_MS) {
          const local = restamp(j.out, { at: Date.now() - j.age_ms, pid });
          if (local) { writeAtomic(outFile, local); served++; }
        }
        // else: the desk has not answered this pid yet; it will within a second.
      } catch (e) { why = `the broker at ${url} did not answer (${e.cause?.code ?? e.name ?? e.message})`; }
      if (why) {
        writeAtomic(outFile, offlineView(text, why));
        if (lastWhy.get(pid) !== why) log(`[plan relay] pid ${pid}: ${why}`);
      } else if (lastWhy.get(pid)) log(`[plan relay] pid ${pid}: reaching the desk again`);
      lastWhy.set(pid, why);
    }
    return served;
  }
  return { tick };
}

// ------------------------------------------------------------------ cli
export const relayBeat = dir => join(dir, 'plan', 'desk.json');
export function relayStatus(dir, now = Date.now()) {
  const d = liveDesk({ dir }, { now });
  return d ? { up: true, ...d } : { up: false };
}

if (process.argv[1]?.endsWith('m59-plan-relay.mjs')) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const cmd = argv[0] ?? 'status';
  const dir = resolve(arg('dir', process.env.M59_CLIENT_CONTEXT_DIR || join(HARNESS, 'substrate', 'client-context')));
  if (cmd === 'status') {
    const s = relayStatus(dir);
    console.log(s.up ? `${s.relay ? 'relay' : 'desk'} pid ${s.pid} serving ${dir}${s.relay ? ` -> ${s.relay}` : ''}` : `nothing serving ${dir}`);
    process.exit(s.up ? 0 : 1);
  }
  if (cmd !== 'run') { console.error('usage: m59-plan-relay.mjs run --broker <host> [--port 8901] [--dir <client-context>] | status'); process.exit(2); }
  const host = arg('broker', process.env.M59_BROKER_HOST);
  if (!host) { console.error('--broker <host> (or M59_BROKER_HOST) is required: the machine whose broker runs the desk'); process.exit(2); }
  const url = `http://${host}:${Number(arg('port', process.env.M59_BROKER_PORT || 8901))}${PLAN_RELAY_PATH}`;
  const held = liveDesk({ dir }, { exceptPid: process.pid });
  if (held) { console.error(`${held.relay ? 'a relay' : 'a plan desk'} (pid ${held.pid}) already serves ${dir}`); process.exit(0); }
  mkdirSync(join(dir, 'plan', 'in'), { recursive: true });
  const since = Date.now();
  const beat = () => writeAtomic(relayBeat(dir), JSON.stringify({ pid: process.pid, at: Date.now(), since, dir, relay: url, root: HARNESS, fleet: null }));
  process.on('exit', () => { try { const h = JSON.parse(readFileSync(relayBeat(dir), 'utf8')); if (h.pid === process.pid) writeFileSync(relayBeat(dir), JSON.stringify({ ...h, at: 0 })); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const relay = createRelay({ dir, url, log: m => console.error(`${new Date().toISOString()} ${m}`) });
  console.error(`plan relay: ${dir} <-> ${url} (slot ${slotFor()})`);
  let beatAt = 0;
  const parent = Number(arg('parent', 0)) || null;
  for (;;) {
    if (parent && !pidAlive(parent)) process.exit(0);
    if (Date.now() - beatAt >= 5000) { beat(); beatAt = Date.now(); }
    let busy = 0;
    try { busy = await relay.tick(); } catch (e) { console.error(`plan relay tick: ${e.message}`); }
    await new Promise(r => setTimeout(r, busy || existsSync(join(dir, 'plan', 'in')) ? 1000 : 5000));
  }
}
