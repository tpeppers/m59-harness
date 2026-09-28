#!/usr/bin/env node
// PLAY A FLEET CHARACTER FROM ANOTHER MACHINE WITHOUT THAT MACHINE EVER HOLDING A PASSWORD.
//
//   remote   node tools/m59-gate.mjs keygen                       # once; prints a public key line
//   home     node tools/m59-gate.mjs authorize deck <that line> --agents t1,t4
//   home     node tools/m59-gate.mjs serve --fleet prod           # 127.0.0.1:8950
//   home     m59-tsrelay -forward 8950                            # publishes it on the tailnet
//   remote   node tools/m59-gate.mjs connect m59-fleet:8950 --tui # the TUI, as though at home
//
// WHAT IT IS. `ssh -L` for exactly four services, with the one thing ssh cannot do: the
// `login` service rewrites the game client's AP_LOGIN on its way past, so the client on
// the remote machine logs in as `t4` with the password `m59-gate`, and the server sees the
// roster's real account and real password digest. The roster never leaves this machine.
// Neither does a copy of it, which is the difference from handing somebody m59-private.
//
// WHY NOT m59-lend.mjs. The lend door lends the MCP — driving a character by tool call.
// This lends the BODY to a real client, which the MCP cannot give: the server allows one
// connection per character, and a client needs a login to take it.
//
// WHO MAY. A peer is an ed25519 public key in m59-private/gate/authorized_peers.json, with
// the services and the characters it may use. Keys, not tokens, because a key can be
// written down in a git repository beside the rosters it guards and a token cannot: the
// public half authorizes and is useless to anyone who reads it. The host's own key sits
// there too, and a peer pins it on first use (~/.m59/known_gates.json) — so a relay that
// answers with a different key is refused rather than trusted.
//
// THE WIRE. Handshake in the clear, then everything sealed:
//   C -> S   { v, eph_c, nonce_c }                     X25519 ephemeral
//   S -> C   { host, eph_s, nonce_s, sig_s }           sig_s = Ed25519(host, H1)
//   C -> S   { peer, sig_c }                           sig_c = Ed25519(peer, H2)
// H1 binds both ephemerals and both nonces; H2 = sha256(H1 | peer). Keys are HKDF over
// the X25519 secret salted with H2, one AES-256-GCM key per direction, nonce = counter.
// Then one sealed request { service, agent? }, one sealed reply, and a sealed pipe.
//
// THE CLAIM. Logging a client in bumps the broker's session, and the 45s rejoin sweep then
// logs the keeper straight back in and bumps the client — unless the character is
// `pilot`-claimed. A claim is bound to a LOCAL pid the broker can poll, and the client is
// on another machine. So for each login the gate starts a placeholder process here that
// lives exactly as long as the relayed session, claims with its pid, and kills it when
// the connection closes; the broker's own poll then gives the character back. The claim
// still means what it says: a process on this machine is holding that character's only
// session, and it is this one.
//
// WHAT THIS DOES NOT DO. It does not encrypt the game session end to end — the game has no
// such thing — only the leg between the two machines. And it forwards ONLY to 127.0.0.1:
// a service name maps to a local port, never to a host the peer names.
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolveFleet, resolveControlUrl } from './m59-fleetpath.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'm59-gate/1';
const DEFAULT_PORT = 8950;
const PLACEHOLDER_PASSWORD = 'm59-gate';
const HANDSHAKE_MS = 10_000;
const MAX_HANDSHAKE_MSG = 4096;
const MAX_RECORD = 1 << 20;

// What a peer can ask for, and where each lives on the HOME machine. The remote side
// listens on the same numbers so every tool there that hardcodes 127.0.0.1:<port> — the
// TUI does, five times — works unchanged.
export const SERVICES = {
  broker:    Number(process.env.M59_BROKER_PORT || 8901),
  dashboard: 8902,
  fleet:     3000,
  login:     Number(process.env.M59_PROXY_PORT || 5961),
};

// ------------------------------------------------------------------ keys and files

const HOME_DIR = process.env.M59_GATE_HOME || join(homedir(), '.m59');
const PEER_KEY_FILE = join(HOME_DIR, 'gate_ed25519.pem');
const KNOWN_GATES = join(HOME_DIR, 'known_gates.json');

// m59-private, found the way m59-custody.mjs finds it, plus a flag — prod-deploy lives in
// a different parent directory from the trunk, so "beside this checkout" is not always it.
function privateDir(argv) {
  const i = argv.indexOf('--private');
  const dir = i >= 0 ? argv[i + 1] : (process.env.M59_PRIVATE || join(REPO, '..', 'm59-private'));
  if (!existsSync(join(dir, 'credentials')))
    throw new Error(`no m59-private at ${dir} (no credentials/ in it) — pass --private <dir> or set M59_PRIVATE`);
  return dir;
}
const gateDir = (argv) => join(privateDir(argv), 'gate');
const authorizedFile = (argv) => join(gateDir(argv), 'authorized_peers.json');
const hostKeyFile = (argv) => join(gateDir(argv), 'host_ed25519.pem');

const pubRaw = (key) => crypto.createPublicKey(key).export({ format: 'jwk' }).x;   // base64url
const pubFromRaw = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const xPubFromRaw = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
export const fingerprint = (x) =>
  'SHA256:' + crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64').replace(/=+$/, '');

function loadOrMakeKey(file, what) {
  if (existsSync(file)) return crypto.createPrivateKey(readFileSync(file));
  mkdirSync(dirname(file), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.error(`made a new ${what} key at ${file}`);
  return privateKey;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file} will not parse: ${e.message} — refusing rather than treating it as empty`); }
}

// ------------------------------------------------------------------ the sealed stream

const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p) : p);
  return h.digest();
};

// Length-prefixed messages over a socket, for both the clear handshake and the sealed
// records. Chunks arrive however TCP likes; this is the only reader.
class Reader {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.waiters = []; this.closed = false;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    sock.on('close', () => { this.closed = true; this.pump(); });
    sock.on('error', () => {}); }
  pump() {
    while (this.waiters.length) {
      if (this.buf.length >= 4) {
        const n = this.buf.readUInt32BE(0);
        if (n > this.waiters[0].max) { this.waiters.shift().reject(new Error(`message of ${n} bytes`)); this.sock.destroy(); continue; }
        if (this.buf.length >= 4 + n) {
          const m = this.buf.subarray(4, 4 + n); this.buf = this.buf.subarray(4 + n);
          this.waiters.shift().resolve(Buffer.from(m)); continue;
        }
      }
      if (this.closed) { this.waiters.shift().reject(new Error('connection closed')); continue; }
      return;
    }
  }
  next(max) { return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject, max }); this.pump(); }); }
}
const writeMsg = (sock, buf) => { const h = Buffer.alloc(4); h.writeUInt32BE(buf.length); sock.write(Buffer.concat([h, buf])); };
const writeJson = (sock, o) => writeMsg(sock, Buffer.from(JSON.stringify(o)));
const readJsonMsg = async (r) => JSON.parse((await r.next(MAX_HANDSHAKE_MSG)).toString());

function sealer(key) {
  let n = 0n;
  return (plain) => {
    const iv = Buffer.alloc(12); iv.writeBigUInt64BE(n++, 4);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
}
function opener(key) {
  let n = 0n;
  return (sealed) => {
    const iv = Buffer.alloc(12); iv.writeBigUInt64BE(n++, 4);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  };
}

function deriveKeys(ephPriv, theirEph, h2) {
  const shared = crypto.diffieHellman({ privateKey: ephPriv, publicKey: xPubFromRaw(theirEph) });
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, h2, VERSION + ' keys', 64));
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32) };
}

// A sealed duplex: `send(buf)`, `recv()` for request/reply, then `onData` for the pipe.
function sealedChannel(sock, reader, sendKey, recvKey) {
  const seal = sealer(sendKey), open = opener(recvKey);
  return {
    send: (buf) => writeMsg(sock, seal(buf)),
    sendJson(o) { this.send(Buffer.from(JSON.stringify(o))); },
    async recvJson() { return JSON.parse(open(await reader.next(MAX_HANDSHAKE_MSG)).toString()); },
    // Hand the rest of the stream to `onData`, forever. A record that fails to open is a
    // tampered or desynchronised stream, and there is nothing to do but drop it.
    pipeTo(onData, onEnd) {
      (async () => {
        try { for (;;) onData(open(await reader.next(MAX_RECORD + 16))); }
        catch { onEnd(); }
      })();
    },
  };
}

// ------------------------------------------------------------------ the login rewrite

const HEADER = 7;
const AP_LOGIN = 2;
const crc16 = (buf) => zlib.crc32(buf) & 0xffff;
function mdpass(pw) {              // same digest as m59-client.mjs's mdpass, 0x00 -> 0x01 included
  const d = crypto.createHash('md5').update(Buffer.from(pw, 'latin1')).digest();
  for (let i = 0; i < d.length; i++) if (d[i] === 0) d[i] = 1;
  return d;
}
const pbuf = (b) => { const o = Buffer.alloc(2 + b.length); o.writeUInt16LE(b.length); b.copy(o, 2); return o; };

// Find the username in an AP_LOGIN payload. It ENDS with pstr(user) + pbuf(md5[16]), and
// that is all this relies on: what the real client puts between the version bytes and the
// name (sysinfo, and how much of it) is not ours to assume. Walk back from the digest to
// the one length prefix that exactly spans the gap.
export function parseLogin(payload) {
  if (payload[0] !== AP_LOGIN || payload.length < 1 + 2 + 2 + 18) return null;
  const pwAt = payload.length - 18;
  if (payload.readUInt16LE(pwAt) !== 16) return null;
  for (let i = pwAt - 2; i >= 1; i--) {
    if (payload.readUInt16LE(i) === pwAt - (i + 2))
      return { userAt: i, user: payload.subarray(i + 2, pwAt).toString('latin1') };
  }
  return null;
}

export function rewriteLogin(payload, account, password) {
  const p = parseLogin(payload);
  if (!p) return null;
  return Buffer.concat([payload.subarray(0, p.userAt), pbuf(Buffer.from(account, 'latin1')), pbuf(mdpass(password))]);
}

export function frame(payload, epoch) {
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt16LE(payload.length, 0);
  out.writeUInt16LE(crc16(payload), 2);
  out.writeUInt16LE(payload.length, 4);
  out.writeUInt8(epoch & 0xff, 6);
  payload.copy(out, HEADER);
  return out;
}

// Frames client->server bytes until the first AP_LOGIN, which is handed to `onLogin` to
// rewrite; everything after it passes untouched. Only the FIRST: once the session is past
// login the stream is checksummed against seeds this gate never sees, and a byte changed
// there is a dropped connection.
export class LoginRewriter {
  constructor(onLogin) { this.onLogin = onLogin; this.buf = Buffer.alloc(0); this.done = false; }
  push(chunk) {
    if (this.done) return [chunk];
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (!this.done && this.buf.length >= HEADER) {
      const len = this.buf.readUInt16LE(0);
      if (this.buf.length < HEADER + len) break;
      const whole = this.buf.subarray(0, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      const payload = whole.subarray(HEADER);
      if (payload[0] === AP_LOGIN) {
        const re = this.onLogin(payload);          // throws to refuse
        out.push(frame(re, whole.readUInt8(6)));
        this.done = true;
      } else out.push(Buffer.from(whole));
    }
    if (this.done && this.buf.length) { out.push(Buffer.from(this.buf)); this.buf = Buffer.alloc(0); }
    return out;
  }
}

// ------------------------------------------------------------------ serve (home)

function rosterEntry(stateFile, name) {
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const low = String(name).toLowerCase();
  for (const [agent, e] of Object.entries(s)) {
    const c = e?.credentials;
    if (!c) continue;
    if (agent.toLowerCase() === low || String(c.character ?? '').toLowerCase() === low
        || String(c.account ?? '').toLowerCase() === low)
      return { agent, creds: c };
  }
  return null;
}

async function brokerCall(name, args) {
  const { url, why } = resolveControlUrl();
  if (!url) throw new Error(why);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  const text = j?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return j?.result ?? j; }
}

const peerMayUse = (peer, service, agent) =>
  (peer.services ?? ['broker', 'dashboard', 'fleet', 'login']).includes(service) &&
  (service !== 'login' || peer.agents === '*' || (peer.agents ?? []).includes(agent));

async function serve(argv) {
  const { stateFile, label } = resolveFleet(argv);
  const hostKey = loadOrMakeKey(hostKeyFile(argv), 'host');
  const hostPub = pubRaw(hostKey);
  const authFile = authorizedFile(argv);
  const listen = flag(argv, '--listen') ?? `127.0.0.1:${DEFAULT_PORT}`;
  const [lhost, lport] = listen.includes(':') ? listen.split(':') : ['127.0.0.1', listen];
  if (!existsSync(stateFile)) throw new Error(`no roster at ${stateFile} (fleet ${label})`);
  const log = (...a) => console.error(new Date().toISOString(), ...a);

  const server = net.createServer(async (sock) => {
    const from = `${sock.remoteAddress}:${sock.remotePort}`;
    const timer = setTimeout(() => { log(from, 'handshake timed out'); sock.destroy(); }, HANDSHAKE_MS);
    const reader = new Reader(sock);
    try {
      const c1raw = await reader.next(MAX_HANDSHAKE_MSG);
      const c1 = JSON.parse(c1raw.toString());
      if (c1.v !== VERSION) throw new Error(`speaks ${c1.v}`);
      const eph = crypto.generateKeyPairSync('x25519');
      const ephS = eph.publicKey.export({ format: 'jwk' }).x;
      const nonceS = crypto.randomBytes(32).toString('base64url');
      const h1 = sha(VERSION, c1raw, hostPub, ephS, nonceS);
      writeJson(sock, { host: hostPub, eph_s: ephS, nonce_s: nonceS,
                        sig_s: crypto.sign(null, h1, hostKey).toString('base64url') });
      const c2 = await readJsonMsg(reader);
      // Re-read every connection: authorizing or revoking a peer takes effect on its next
      // connect, with nothing to restart.
      const peers = readJson(authFile, []);
      const peer = peers.find(p => p.key === c2.peer);
      if (!peer) throw new Error(`key ${fingerprint(c2.peer)} is not in ${authFile}`);
      const h2 = sha(h1, c2.peer);
      if (!crypto.verify(null, h2, pubFromRaw(c2.peer), Buffer.from(c2.sig_c, 'base64url')))
        throw new Error(`bad signature from ${peer.name}`);
      const keys = deriveKeys(eph.privateKey, c1.eph_c, h2);
      const ch = sealedChannel(sock, reader, keys.s2c, keys.c2s);
      const req = await ch.recvJson();
      clearTimeout(timer);
      await handle({ sock, ch, peer, req, from, log, stateFile });
    } catch (e) {
      clearTimeout(timer);
      log(from, 'refused:', e.message);
      sock.destroy();
    }
  });
  server.listen(Number(lport), lhost, () => {
    log(`gate for fleet ${label} on ${lhost}:${lport}`);
    log(`host key ${fingerprint(hostPub)}  (peers pin this on first connect)`);
    log(`peers from ${authFile}: ${readJson(authFile, []).map(p => p.name).join(', ') || 'NONE — authorize one first'}`);
  });
}

async function handle({ sock, ch, peer, req, from, log, stateFile }) {
  const service = String(req.service ?? '');
  if (!(service in SERVICES)) { ch.sendJson({ ok: false, error: `no service ${service}` }); return sock.end(); }
  if (service !== 'login') {
    if (!peerMayUse(peer, service)) { ch.sendJson({ ok: false, error: `${peer.name} may not use ${service}` }); return sock.end(); }
    const up = net.connect(SERVICES[service], '127.0.0.1');
    up.on('connect', () => { ch.sendJson({ ok: true }); log(from, peer.name, '->', service); });
    return splice(sock, ch, up, (d) => up.write(d));
  }
  // LOGIN: nothing is known until the client's AP_LOGIN names who it wants to be, so the
  // decision is made there — and a refusal there closes the connection before one byte of
  // it has reached the server.
  ch.sendJson({ ok: true });
  let up = null, placeholder = null, agent = null;
  const pending = [];
  const rw = new LoginRewriter((payload) => {
    const asked = parseLogin(payload)?.user;
    const hit = asked && rosterEntry(stateFile, asked);
    if (!hit) throw new Error(`no character "${asked}" in the roster`);
    if (!peerMayUse(peer, 'login', hit.agent)) throw new Error(`${peer.name} may not play ${hit.agent}`);
    agent = hit.agent;
    return rewriteLogin(payload, hit.creds.account, hit.creds.password) ?? (() => { throw new Error('unparseable AP_LOGIN'); })();
  });
  const cleanup = async () => {
    if (placeholder) { try { placeholder.kill(); } catch {} placeholder = null;
      brokerCall('pilot', { action: 'release', agent }).catch(() => {});
      log(from, peer.name, 'released', agent); }
  };
  // 'login' until the AP_LOGIN is seen, 'claiming' while the broker is asked (anything the
  // client sends meanwhile queues — records keep arriving during an await), then 'open'.
  let state = 'login';
  ch.pipeTo(async (d) => {
    if (state === 'open') return up.write(d);
    if (state === 'claiming') { pending.push(d); return; }
    let out;
    try { out = rw.push(d); }
    catch (e) { log(from, peer.name, 'login refused:', e.message); sock.destroy(); return; }
    pending.push(...out);
    if (!rw.done) return;
    state = 'claiming';
    // The login is decided. Claim before the session exists, so the broker's rejoin sweep
    // cannot take the character back between our login and the claim landing.
    const { creds } = rosterEntry(stateFile, agent);
    placeholder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore', windowsHide: true });
    const claim = await brokerCall('pilot', { action: 'claim', agent, pid: placeholder.pid,
                                              character: creds.character }).catch(e => ({ error: e.message }));
    if (claim?.error) log(from, peer.name, `pilot claim for ${agent} FAILED (${claim.error}) — the keeper may bump the client`);
    else log(from, peer.name, `playing ${agent}; claimed by placeholder pid ${placeholder.pid}`);
    up = net.connect(Number(creds.port), creds.host);
    up.on('data', (b) => ch.send(b));
    up.on('close', () => { sock.end(); cleanup(); });
    up.on('error', (e) => { log(from, 'game server:', e.message); sock.destroy(); });
    for (const b of pending.splice(0)) up.write(b);
    state = 'open';
  }, () => { up?.destroy(); cleanup(); });
  sock.on('close', () => { up?.destroy(); cleanup(); });
}

function splice(sock, ch, up, write) {
  up.on('data', (b) => ch.send(b));
  up.on('close', () => sock.end());
  up.on('error', () => sock.destroy());
  ch.pipeTo(write, () => up.destroy());
  sock.on('close', () => up.destroy());
}

// ------------------------------------------------------------------ connect (remote)

async function openTunnel(target, service, peerKey, pin) {
  const [host, port] = target.includes(':') ? [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))] : [target, DEFAULT_PORT];
  const sock = net.connect(port, host);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const reader = new Reader(sock);
  const eph = crypto.generateKeyPairSync('x25519');
  const c1raw = Buffer.from(JSON.stringify({ v: VERSION, eph_c: eph.publicKey.export({ format: 'jwk' }).x,
                                             nonce_c: crypto.randomBytes(32).toString('base64url') }));
  writeMsg(sock, c1raw);
  const s1 = await readJsonMsg(reader);
  pin(s1.host);
  const h1 = sha(VERSION, c1raw, s1.host, s1.eph_s, s1.nonce_s);
  if (!crypto.verify(null, h1, pubFromRaw(s1.host), Buffer.from(s1.sig_s, 'base64url')))
    throw new Error('the gate did not prove it holds its host key');
  const me = pubRaw(peerKey);
  const h2 = sha(h1, me);
  writeJson(sock, { peer: me, sig_c: crypto.sign(null, h2, peerKey).toString('base64url') });
  const keys = deriveKeys(eph.privateKey, s1.eph_s, h2);
  const ch = sealedChannel(sock, reader, keys.c2s, keys.s2c);
  ch.sendJson({ service });
  const rep = await ch.recvJson().catch(() => ({ ok: false, error: 'the gate closed the connection — is this key authorized? (the gate log says why)' }));
  if (!rep.ok) { sock.destroy(); throw new Error(rep.error); }
  return { sock, ch };
}

async function connect(argv) {
  const target = argv.find((a, i) => i > 0 && !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!target) throw new Error('connect <host[:port]> — the gate, e.g. m59-fleet:8950 on your tailnet');
  const peerKey = loadOrMakeKey(PEER_KEY_FILE, 'peer');
  const known = readJson(KNOWN_GATES, {});
  const pinFlag = flag(argv, '--host-key');
  const pin = (hostPub) => {
    const fp = fingerprint(hostPub);
    if (pinFlag && pinFlag !== fp) throw new Error(`gate key is ${fp}, --host-key says ${pinFlag}`);
    if (known[target] && known[target] !== hostPub)
      throw new Error(`THE GATE AT ${target} HAS A DIFFERENT KEY (${fp}) than the one pinned in ${KNOWN_GATES}. ` +
                      'If you rebuilt the gate on purpose, delete that entry; otherwise do not connect.');
    if (!known[target]) { known[target] = hostPub; mkdirSync(HOME_DIR, { recursive: true });
      writeFileSync(KNOWN_GATES, JSON.stringify(known, null, 2)); console.error(`pinned ${target} as ${fp}`); }
  };
  const wanted = (flag(argv, '--services') ?? Object.keys(SERVICES).join(',')).split(',').filter(Boolean);
  // Prove the whole path once before listening, so a bad key or a wrong address fails
  // here, loudly, rather than as a TUI that cannot reach its broker.
  const probe = await openTunnel(target, wanted.includes('broker') ? 'broker' : wanted[0], peerKey, pin);
  probe.sock.destroy();
  for (const service of wanted) {
    const port = SERVICES[service];
    if (!port) throw new Error(`no service ${service}`);
    const srv = net.createServer(async (local) => {
      local.pause();
      try {
        const { sock, ch } = await openTunnel(target, service, peerKey, pin);
        local.on('data', (d) => ch.send(d));
        local.on('close', () => sock.destroy());
        local.on('error', () => sock.destroy());
        ch.pipeTo((d) => local.write(d), () => local.end());
        sock.on('close', () => local.destroy());
        local.resume();
      } catch (e) { console.error(`${service}: ${e.message}`); local.destroy(); }
    });
    srv.on('error', (e) => console.error(`127.0.0.1:${port} (${service}): ${e.code === 'EADDRINUSE' ? 'already in use here — is a broker or proxy running on this machine?' : e.message}`));
    srv.listen(port, '127.0.0.1', () => console.error(`127.0.0.1:${port} -> ${target} ${service}`));
  }
  if (argv.includes('--tui')) {
    const tui = spawn(process.execPath, [join(REPO, 'tools', 'm59-tui.mjs')],
                      { stdio: 'inherit', env: { ...process.env, M59_GATE: target } });
    tui.on('exit', (code) => process.exit(code ?? 0));
  }
}

// ------------------------------------------------------------------ keygen / authorize

function keygen() {
  const k = loadOrMakeKey(PEER_KEY_FILE, 'peer');
  const x = pubRaw(k);
  console.log(`ed25519:${x}`);
  console.error(`${fingerprint(x)} — send the line above to whoever runs the gate; the private key stays in ${PEER_KEY_FILE}`);
}

function authorize(argv) {
  const [, name, keyArg] = argv;
  if (!name || !keyArg) throw new Error('authorize <name> <ed25519:...> [--agents t1,t2|*] [--services broker,dashboard,fleet,login]');
  const key = keyArg.replace(/^ed25519:/, '');
  pubFromRaw(key);                                  // throws on a malformed key, before anything is written
  const file = authorizedFile(argv);
  const peers = readJson(file, []).filter(p => p.name !== name && p.key !== key);
  const agents = flag(argv, '--agents');
  const services = flag(argv, '--services');
  const entry = { name, key, agents: agents === '*' ? '*' : (agents ? agents.split(',') : []),
                  services: services ? services.split(',') : Object.keys(SERVICES), added: new Date().toISOString() };
  peers.push(entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(peers, null, 2) + '\n');
  console.log(`${name} (${fingerprint(key)}) may use ${entry.services.join(', ')}; ` +
              `login as ${entry.agents === '*' ? 'ANY character' : entry.agents.join(', ') || 'NO character'}`);
  console.log(`written to ${file} — commit it in m59-private so it has a history`);
}

function revoke(argv) {
  const file = authorizedFile(argv);
  const peers = readJson(file, []);
  const kept = peers.filter(p => p.name !== argv[1]);
  if (kept.length === peers.length) throw new Error(`no peer called ${argv[1]} in ${file}`);
  writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
  console.log(`revoked ${argv[1]}; takes effect on its next connection`);
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmds = { serve, connect, keygen, authorize, revoke,
    peers: (a) => { for (const p of readJson(authorizedFile(a), [])) console.log(p.name, fingerprint(p.key), p.services.join(','), p.agents); },
    fingerprint: (a) => console.log(fingerprint(pubRaw(loadOrMakeKey(hostKeyFile(a), 'host')))) };
  const run = cmds[argv[0]];
  if (!run) { console.error('m59-gate.mjs keygen | authorize | revoke | peers | fingerprint | serve | connect  — see the header'); process.exit(2); }
  Promise.resolve(run(argv)).catch((e) => { console.error(e.message); process.exit(1); });
}
