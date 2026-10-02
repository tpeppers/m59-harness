#!/usr/bin/env node
// THE OPERATOR GATEWAY: THE FLEET'S ADMIN PAGES ON THE TAILNET, FOR THE OPERATOR'S OTHER MACHINES.
//
//   node tools/m59-operator-gateway.mjs status    what it would listen on, who it admits, is it up
//   node tools/m59-operator-gateway.mjs start     detached; survives this terminal
//   node tools/m59-operator-gateway.mjs stop
//   node tools/m59-operator-gateway.mjs run       in the foreground
//
// Reads substrate/operator-access.json (tools/runtime/operator-access.mjs has the shape and the
// argument). For every listed port -- by default 8901 (the broker's control API, what the TUI
// talks to), 8902 (the fleet pages and their buttons) and 3000 (field command) -- it listens on
// THIS machine's tailnet address(es) and forwards to 127.0.0.1 on the same port.
//
// WHY A GATEWAY AND NOT A WIDER CHECK. Every admin surface already decides "is this the operator"
// by asking whether the socket is loopback, in about ten places, and each is right to. Widening
// them would mean ten edits and a broker restart that logs the whole fleet out. A forwarder makes
// the surfaces see a loopback caller -- the trust model tools/m59-lend.mjs already uses -- and
// puts the whole decision in one place:
//
//   * ADMISSION. A connection whose remote address is not a listed operator is refused before a
//     byte is forwarded. The listen addresses are tailnet interfaces, so the remote address is
//     WireGuard-authenticated.
//   * HOST. Rewritten to 127.0.0.1:<port>, because the surfaces refuse a non-loopback Host.
//   * ORIGIN. Forgery protection is preserved, not bypassed: a request carrying an Origin is
//     forwarded only if that Origin is THIS gateway (the same scheme+host+port the browser
//     addressed), and only then rewritten to the loopback origin the surface expects. A page on
//     another site cannot use the operator's browser to drive the fleet.
//   * RESPONSES. A redirect, and absolute links in HTML, that name a loopback admin port are
//     rewritten to the host the browser used, so a click on the Deck stays on the Deck's route.
//
// Binding beside the broker's own 0.0.0.0:8902 listener is fine: measured on this machine, a
// connection to the tailnet address goes to the more specific listener (2026-10-01).
//
// IT NEVER TOUCHES: m59-dm's maintenance-port check (the GAME server's locality) or any keeper
// port; keepers are reached by the broker, which is on this machine.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOperatorAccess, operatorFor, normalizeAddress, OPERATOR_ACCESS_FILE } from './runtime/operator-access.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
const PID_FILE = join(HERE, 'substrate', 'operator-gateway.pid');
const LOG_FILE = process.env.M59_OPERATOR_GATEWAY_LOG || join(HERE, 'substrate', 'operator-gateway.log');
// Loopback only: how `status` and `stop` recognise THIS gateway before signalling a pid.
export const CONTROL_PORT = Number(process.env.M59_OPERATOR_GATEWAY_CONTROL_PORT || 8929);

const log = line => {
  const s = `${new Date().toISOString()} ${line}`;
  console.error(s);
  try { appendFileSync(LOG_FILE, s + '\n'); } catch {}
};

const hostOnly = h => String(h ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/** Rewrite every absolute loopback URL on one of our ports to the host the browser used. */
export function rewriteLoopbackUrls(text, ports, publicHost) {
  const alt = ports.join('|');
  return String(text).replace(new RegExp(`(https?:)//(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):(${alt})\\b`, 'g'),
    (_, scheme, port) => `${scheme}//${publicHost}:${port}`);
}

/**
 * The admission and header decision for one request, as data -- pure, so it is tested without a
 * socket. Returns { ok:false, status, why } or { ok:true, operator, headers }.
 */
export function admit(cfg, { remoteAddress, headers, port }) {
  const op = operatorFor(cfg, remoteAddress);
  if (!op) return { ok: false, status: 403, why: `not an operator address: ${normalizeAddress(remoteAddress)}` };
  const host = String(headers.host ?? '');
  if (!host) return { ok: false, status: 400, why: 'no Host header' };
  const out = { ...headers, host: `127.0.0.1:${port}` };
  if (headers.origin != null) {
    let o = null;
    try { o = new URL(String(headers.origin)); } catch { o = null; }
    // The browser addressed `host`; the Origin must be that same place, or it is another site.
    if (!o || o.host.toLowerCase() !== host.toLowerCase())
      return { ok: false, status: 403, why: `cross-origin request refused (origin ${headers.origin}, host ${host})` };
    out.origin = `${o.protocol}//127.0.0.1:${port}`;
  }
  if (headers.referer != null) {
    try {
      const r = new URL(String(headers.referer));
      if (r.host.toLowerCase() === host.toLowerCase()) { r.host = `127.0.0.1:${port}`; out.referer = r.toString(); }
    } catch {}
  }
  out['x-m59-operator'] = op.name;
  return { ok: true, operator: op, headers: out };
}

function serve(cfg, address, port) {
  const server = http.createServer((req, res) => {
    const d = admit(cfg, { remoteAddress: req.socket.remoteAddress, headers: req.headers, port });
    if (!d.ok) {
      log(`${address}:${port} refused ${normalizeAddress(req.socket.remoteAddress)} ${req.method} ${req.url}: ${d.why}`);
      res.writeHead(d.status, { 'content-type': 'text/plain' }); res.end(d.why + '\n'); return;
    }
    const publicHost = hostOnly(req.headers.host);
    const headers = { ...d.headers, 'accept-encoding': 'identity' };   // so HTML can be rewritten
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, ur => {
      const h = { ...ur.headers };
      if (h.location) h.location = rewriteLoopbackUrls(h.location, cfg.ports, publicHost);
      const html = /text\/html/i.test(String(h['content-type'] ?? ''));
      if (!html) { res.writeHead(ur.statusCode, h); ur.pipe(res); return; }
      const chunks = [];
      ur.on('data', c => chunks.push(c));
      ur.on('end', () => {
        const body = Buffer.from(rewriteLoopbackUrls(Buffer.concat(chunks).toString('utf8'), cfg.ports, publicHost), 'utf8');
        delete h['transfer-encoding'];
        h['content-length'] = String(body.length);
        res.writeHead(ur.statusCode, h); res.end(body);
      });
    });
    up.on('error', e => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`nothing is serving 127.0.0.1:${port} (${e.code ?? e.message})\n`);
    });
    req.pipe(up);
  });
  // WebSockets (the field page's dev server and anything live) are forwarded as raw TCP once the
  // same admission has passed, with the request head rewritten.
  server.on('upgrade', (req, socket, head) => {
    const d = admit(cfg, { remoteAddress: req.socket.remoteAddress, headers: req.headers, port });
    if (!d.ok) { socket.end(`HTTP/1.1 ${d.status} Refused\r\n\r\n`); return; }
    const upstream = net.connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(d.headers)) for (const x of [].concat(v)) lines.push(`${k}: ${x}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, address, () => { log(`listening ${address}:${port} -> 127.0.0.1:${port}`); ok(server); });
  });
}

export async function runGateway(cfg) {
  const servers = [];
  for (const address of cfg.listen) for (const port of cfg.ports) {
    try { servers.push(await serve(cfg, address, port)); }
    catch (e) { log(`could not listen on ${address}:${port}: ${e.code ?? e.message}`); }
  }
  // Loopback-only identity for status/stop. Never on the tailnet.
  const control = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ gateway: 'm59-operator-gateway', pid: process.pid, file: cfg.file,
      listening: servers.map(s => s.address()), operators: cfg.operators.map(o => o.name) }));
  });
  await new Promise(ok => control.listen(CONTROL_PORT, '127.0.0.1', ok)).catch(() => {});
  return { servers, control };
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j?.gateway === 'm59-operator-gateway' ? j : null;
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? 'status';
  let cfg = null;
  try { cfg = loadOperatorAccess(); }
  catch (e) { console.error(`operator access file is unusable: ${e.message}`); process.exit(2); }

  if (cmd === 'status') {
    if (!cfg) { console.log(`no ${OPERATOR_ACCESS_FILE()} -- nothing to serve (install it from the private repository: access/install.mjs)`); process.exit(0); }
    console.log(`config   ${cfg.file}`);
    console.log(`listen   ${cfg.listen.join(', ')}  ports ${cfg.ports.join(', ')}`);
    console.log(`admits   ${cfg.operators.map(o => `${o.name} (${o.addresses.join(', ')})`).join('; ') || 'nobody'}`);
    const h = await health();
    console.log(h ? `running  pid ${h.pid}, ${h.listening.length} listener(s)` : 'stopped');
    process.exit(0);
  }
  if (cmd === 'stop') {
    const h = await health();
    if (!h) { console.log('not running'); process.exit(0); }
    // Identified by its own loopback health, never by process name (CLAUDE.md).
    try { process.kill(h.pid); console.log(`stopped pid ${h.pid}`); } catch (e) { console.error(e.message); process.exit(1); }
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }
  if (!cfg) { console.error(`no ${OPERATOR_ACCESS_FILE()} -- nothing to serve`); process.exit(2); }
  if (!cfg.listen.length || !cfg.operators.length) { console.error('the access file lists no listen address or no operator'); process.exit(2); }
  if (cmd === 'start') {
    const h = await health();
    if (h) { console.log(`already running, pid ${h.pid}`); process.exit(0); }
    const fd = openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'],
      { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: HERE });
    closeSync(fd);
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const up = await health();
      if (up) { console.log(`started pid ${up.pid}: ${up.listening.map(a => `${a.address}:${a.port}`).join(', ')}`); process.exit(0); }
    }
    console.error(`did not come up; read ${LOG_FILE}`); process.exit(1);
  }
  if (cmd === 'run') { await runGateway(cfg); }
  else { console.error(`unknown command ${cmd}: status | start | stop | run`); process.exit(2); }
}
