#!/usr/bin/env node
// Offline test for m59-gate.mjs. Opens loopback sockets only, and touches no roster but a
// temporary one: the "game server" and the "broker" are fakes in this process.
//
//   node tools/m59-gate-test.mjs
//
// What it pins, in the order it would hurt:
//   - the password that reaches the game server is the ROSTER's, and the placeholder the
//     remote client typed never does
//   - an unauthorized key gets nothing, and an authorized key cannot play a character it
//     was not given — refused before one byte reaches the server
//   - a gate answering with a different host key than the one pinned is refused
//   - the character is pilot-claimed on a LIVE local pid for the session, and released after
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogin, rewriteLogin, LoginRewriter, frame } from './m59-gate.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'm59-gate.mjs');
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log('FAIL', what); } };

// --- the login packet, built the way m59-client.mjs builds it
const pbuf = (b) => { const o = Buffer.alloc(2 + b.length); o.writeUInt16LE(b.length); b.copy(o, 2); return o; };
const md = (pw) => { const d = crypto.createHash('md5').update(Buffer.from(pw, 'latin1')).digest(); for (let i = 0; i < 16; i++) if (!d[i]) d[i] = 1; return d; };
const login = (user, pw, sysLen = 36) =>
  Buffer.concat([Buffer.from([2, 50, 42]), Buffer.alloc(sysLen, 7), pbuf(Buffer.from(user, 'latin1')), pbuf(md(pw))]);

{
  const p = login('t4', 'm59-gate');
  ok(parseLogin(p)?.user === 't4', 'parse finds the username');
  ok(parseLogin(login('Loial', 'x', 52))?.user === 'Loial', 'parse does not assume the sysinfo length');
  const re = rewriteLogin(p, 'realacct', 'hunter2');
  ok(parseLogin(re)?.user === 'realacct', 'rewrite swaps the account');
  ok(re.subarray(re.length - 16).equals(md('hunter2')), 'rewrite writes the roster password digest');
  ok(re.subarray(0, 39).equals(p.subarray(0, 39)), 'rewrite keeps version and sysinfo untouched');
  ok(parseLogin(Buffer.from([5, 1, 2, 3])) === null, 'not a login is not parsed');
  const f = frame(re, 9);
  ok(f.readUInt16LE(2) === (zlib.crc32(re) & 0xffff), 'frame carries the truncated-crc32 checksum');

  // Split across chunks, with a frame before and bytes after.
  const other = frame(Buffer.from([1]), 0);
  const stream = Buffer.concat([other, frame(p, 3), Buffer.from('tail')]);
  const rw = new LoginRewriter((pl) => rewriteLogin(pl, 'realacct', 'hunter2'));
  const out = [];
  for (let i = 0; i < stream.length; i += 5) out.push(...rw.push(stream.subarray(i, i + 5)));
  const joined = Buffer.concat(out);
  ok(rw.done, 'rewriter finishes on a chunked login');
  ok(joined.subarray(0, other.length).equals(other), 'frames before the login pass untouched');
  ok(joined.includes(Buffer.from('realacct')) && !joined.includes(Buffer.from('t4\x10')), 'login rewritten in the stream');
  ok(joined.subarray(joined.length - 4).toString() === 'tail', 'bytes after the login pass untouched');
}

// --- end to end on loopback
const free = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = mkdtempSync(join(tmpdir(), 'm59-gate-test-'));
const priv = join(tmp, 'private'); mkdirSync(join(priv, 'credentials'), { recursive: true });
const homeA = join(tmp, 'home-a'), homeB = join(tmp, 'home-b');
const roster = join(tmp, 'roster.json');

const logins = [];
const game = net.createServer(s => s.on('error', () => {}).on('data', d => { logins.push(Buffer.from(d)); s.write('WELCOME'); }));
const gamePort = await new Promise(r => game.listen(0, '127.0.0.1', () => r(game.address().port)));
writeFileSync(roster, JSON.stringify({
  t4: { credentials: { account: 'realacct', password: 'hunter2', host: '127.0.0.1', port: gamePort, character: 'Loial' } },
  t9: { credentials: { account: 'other', password: 'secret9', host: '127.0.0.1', port: gamePort } },
}));

const pilot = [];
const broker = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const a = JSON.parse(b).params.arguments; pilot.push(a);
  if (a.action === 'claim') { try { process.kill(a.pid, 0); a.alive = true; } catch { a.alive = false; } }
  res.end(JSON.stringify({ result: { content: [{ text: JSON.stringify({ claimed: true }) }] } })); }); });
const brokerPort = await new Promise(r => broker.listen(0, '127.0.0.1', () => r(broker.address().port)));

const gatePort = await free(), loginA = await free(), loginB = await free();
const baseEnv = { ...process.env, M59_PRIVATE: priv, M59_STATE_FILE: roster, M59_CONTROL_URL: `http://127.0.0.1:${brokerPort}/` };
const kids = [];
const run = (args, env) => { const k = spawn(process.execPath, [GATE, ...args], { env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(k); let out = ''; k.stdout.on('data', d => out += d); k.stderr.on('data', d => out += d); k.out = () => out;
  k.done = new Promise(r => k.on('exit', r)); return k; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(50); } return false; };

try {
  const kA = run(['keygen'], { M59_GATE_HOME: homeA }); await kA.done;
  const keyA = kA.out().match(/ed25519:\S+/)[0];
  const kB = run(['keygen'], { M59_GATE_HOME: homeB }); await kB.done;
  ok(/ed25519:/.test(kB.out()), 'keygen prints a public key line');
  const au = run(['authorize', 'deck', keyA, '--agents', 't4']); await au.done;
  ok(/may use/.test(au.out()), 'authorize writes the peer');
  ok(!readFileSync(join(priv, 'gate', 'authorized_peers.json'), 'utf8').includes('hunter2'), 'the peer file holds no password');

  const srv = run(['serve', '--listen', `127.0.0.1:${gatePort}`]);
  ok(await until(() => /gate for fleet/.test(srv.out())), 'serve comes up');

  // A: authorized for t4.
  const cA = run(['connect', `127.0.0.1:${gatePort}`, '--services', 'login'], { M59_GATE_HOME: homeA, M59_PROXY_PORT: String(loginA) });
  ok(await until(() => new RegExp(`127.0.0.1:${loginA} ->`).test(cA.out())), 'connect listens locally after the probe');

  const play = async (port, user) => {
    const s = net.connect(port, '127.0.0.1'); let got = '';
    s.on('data', d => got += d); s.on('error', () => {});
    await new Promise(r => s.once('connect', r));
    s.write(frame(login(user, 'm59-gate'), 1));
    await until(() => got.length > 0 || s.destroyed, 3000);
    return { s, got: () => got };
  };

  const a = await play(loginA, 't4');
  ok(a.got() === 'WELCOME', 'the game server answered through both hops');
  const seen = Buffer.concat(logins);
  ok(seen.includes(Buffer.from('realacct')), 'the server saw the roster account');
  ok(seen.includes(md('hunter2')), 'the server saw the roster password digest');
  ok(!seen.includes(md('m59-gate')), 'the placeholder password never reached the server');
  const claim = pilot.find(p => p.action === 'claim');
  ok(claim?.agent === 't4' && claim.alive, 'claimed t4 on a live local pid');
  a.s.destroy();
  ok(await until(() => pilot.some(p => p.action === 'release' && p.agent === 't4')), 'released when the session closed');
  ok(await until(() => { try { process.kill(claim.pid, 0); return false; } catch { return true; } }), 'placeholder pid is gone after release');

  // A asks for a character it was not given.
  logins.length = 0;
  const a2 = await play(loginA, 't9');
  ok(a2.got() === '' && logins.length === 0, 'a character not granted is refused before the server');
  ok(/may not play t9/.test(srv.out()), 'and the gate log says why');

  // B: a key nobody authorized.
  const cB = run(['connect', `127.0.0.1:${gatePort}`, '--services', 'login'], { M59_GATE_HOME: homeB, M59_PROXY_PORT: String(loginB) });
  await cB.done;
  ok(/closed the connection|not authorized/.test(cB.out()), 'an unauthorized key cannot connect');
  ok(/is not in/.test(srv.out()), 'the gate names the unknown key');

  // A pinned host key that no longer matches.
  const pins = join(homeA, 'known_gates.json');
  const j = JSON.parse(readFileSync(pins, 'utf8'));
  j[`127.0.0.1:${gatePort}`] = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  writeFileSync(pins, JSON.stringify(j));
  const cA2 = run(['connect', `127.0.0.1:${gatePort}`, '--services', 'login'], { M59_GATE_HOME: homeA, M59_PROXY_PORT: String(await free()) });
  await cA2.done;
  ok(/DIFFERENT KEY/.test(cA2.out()), 'a changed gate key is refused');

  // Revocation takes effect on the next connection, with no restart.
  const rv = run(['revoke', 'deck']); await rv.done;
  writeFileSync(pins, '{}');
  const cA3 = run(['connect', `127.0.0.1:${gatePort}`, '--services', 'login'], { M59_GATE_HOME: homeA, M59_PROXY_PORT: String(await free()) });
  await cA3.done;
  ok(cA3.exitCode !== 0 && /closed the connection/.test(cA3.out()), 'the key that worked a minute ago is refused after revoke');
} finally {
  for (const k of kids) k.kill();
  game.close(); broker.close();
  await wait(200);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(`m59-gate-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
