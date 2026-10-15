#!/usr/bin/env node
// m59-proxy-gate-test.mjs — THE KEEPER CAN HOLD THE CONTROLS WITHOUT THE SERVER HANGING UP.
//
//   node tools/m59-proxy-gate-test.mjs
//
// Offline. Loopback sockets only: a fake blakserv that checks every client packet's
// security value exactly as game.c:174-184 does (and hangs up on the first wrong one),
// a fake client that computes its own values in lockstep, and the REAL ProxySession
// between them.
//
// What it pins: dropping a client packet is a step the server never takes, so after the
// first drop the proxy must re-frame everything. If it ever forwards the client's own
// value again, the fake server sees the one-step skew and the test fails the same way a
// live session would — silently disconnected.

import net from 'node:net';
import zlib from 'node:zlib';
import { ProxySession } from './m59-proxy.mjs';
import { ProxyTrade } from './m59-proxy-trade.mjs';
import { gateDrops, newGate, gateLive, GATE_PASS } from './m59-proxy-gate.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// An independent oracle for the stream — deliberately not imported from the proxy.
const crc16 = b => zlib.crc32(b) & 0xffff;
class Stream {
  constructor(seeds) { this.s = seeds.slice(); }
  step() { const s = this.s; for (let i = 0; i < 5; i++) s[i] = ((s[i] * 9301 + 49297) % 4294967296) % 233280; return s[4] % 4; }
  sec(p) { const i = this.step(); return ((this.s[i] & 0xffff) ^ p.length ^ ((((p[0] << 24) >> 24) << 4) & 0xffff) ^ crc16(p)) & 0xffff; }
}
const frame = (p, sec, epoch = 1) => { const o = Buffer.alloc(7 + p.length); o.writeUInt16LE(p.length, 0); o.writeUInt16LE(sec, 2); o.writeUInt16LE(p.length, 4); o.writeUInt8(epoch, 6); p.copy(o, 7); return o; };
const plain = p => frame(p, crc16(p));
function frames(sock, on) {
  let buf = Buffer.alloc(0);
  sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 7) return; const n = buf.readUInt16LE(0); if (buf.length < 7 + n) return; const w = buf.subarray(0, 7 + n); buf = buf.subarray(7 + n); on(w.subarray(7), w.readUInt16LE(2)); } });
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ 1. pure rules
{
  const g = newGate({ holder: 'keeper:t1' });
  ok('a move is dropped while gated', gateDrops(g, Buffer.from([100, 0])));
  ok('an attack is dropped while gated', gateDrops(g, Buffer.from([103, 0])));
  ok('a buy is dropped while gated', gateDrops(g, Buffer.from([124])));
  ok('a user command (rest, safety) is dropped while gated', gateDrops(g, Buffer.from([155])));
  ok('a ping passes', !gateDrops(g, Buffer.from([3])));
  ok('logoff ALWAYS passes, so a person can leave', !gateDrops(g, Buffer.from([20])) && GATE_PASS.has(54));
  ok('look and inventory pass', !gateDrops(g, Buffer.from([116])) && !gateDrops(g, Buffer.from([117])));
  ok('speech passes by default (operator verbs ride on it)', !gateDrops(g, Buffer.from([110])));
  ok('speech is dropped when chat:false', gateDrops(newGate({ holder: 'k', chat: false }), Buffer.from([110])));
  ok('no gate drops nothing', !gateDrops(null, Buffer.from([100])));
  const t = newGate({ holder: 'k', ttl_ms: 5000 }, 1000);
  ok('a leased gate lapses by itself', gateLive(t, 5999) && !gateLive(t, 6001));
  let threw = false; try { newGate({}); } catch { threw = true; }
  ok('a gate needs a holder', threw);
}

// ------------------------------------------------------------------ 2. on the wire
const SEEDS = [3571238106, 184153256, 462, 697447458, 184166115];
const received = []; let hungUp = null;
let srvSock = null;
const server = net.createServer(sock => {
  srvSock = sock;
  const st = new Stream(SEEDS); let game = false;
  frames(sock, (p, sec) => {
    if (!game) { if (p[0] === 1) { const b = Buffer.alloc(21); b[0] = 22; SEEDS.forEach((v, i) => b.writeUInt32LE(v, 1 + i * 4)); sock.write(plain(b)); sock.write(plain(Buffer.from([25]))); game = true; } return; }
    const want = st.sec(p);
    if (want !== sec) { hungUp = `op ${p[0]}: got 0x${sec.toString(16)} want 0x${want.toString(16)}`; sock.destroy(); return; }
    received.push(p[0]);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const front = net.createServer();
await new Promise(r => front.listen(0, '127.0.0.1', r));
let session;
front.on('connection', sock => { session = new ProxySession(sock, { host: '127.0.0.1', port: server.address().port, observe: true, gateable: true }); });
const client = net.connect(front.address().port, '127.0.0.1');
await new Promise(r => client.on('connect', r));
let cst = null;
const toClient = [];
frames(client, p => { toClient.push(p[0]); if (p[0] === 22 && !cst) cst = new Stream([...Array(5)].map((_, i) => p.readUInt32LE(1 + i * 4))); });
const send = p => client.write(frame(p, cst.sec(p)));
client.write(plain(Buffer.from([1])));           // "login"
await tick(80);
ok('the fake login reached game mode with seeds', !!cst && session?.inGame);

const MOVE = Buffer.from([100, 1, 0, 2, 0, 18, 9, 0, 0, 0]), PING = Buffer.from([3]), LOOK = Buffer.from([116, 7, 0, 0, 0]), ATTACK = Buffer.from([103, 0, 5, 0, 0, 0]);
const refused = session.setGate({ holder: 'keeper:t1' });
ok('a gate is refused before the stream is calibrated', !refused.ok && /calibrated/.test(refused.why), refused.why);
send(MOVE); send(MOVE); await tick();
ok('the proxy calibrates from the client\'s own packets', session.locked);

const took = session.setGate({ holder: 'keeper:t1', reason: 'spectate' });
ok('the keeper takes the gate once calibrated', took.ok, took.why);
ok('a second holder cannot take it', !session.setGate({ holder: 'someone-else' }).ok);
send(MOVE); send(ATTACK); send(PING); send(MOVE); send(LOOK); await tick(60);
ok('nothing the human steered with reached the server', received.filter(o => o === 103).length === 0 && received.filter(o => o === 100).length === 2, JSON.stringify(received));
ok('ping and look passed while gated', received.includes(3) && received.includes(116));
ok('the server never saw a wrong security value across the drops', hungUp === null, hungUp ?? '');
ok('the session counts what it dropped', session.gate?.dropped === 3, String(session.gate?.dropped));

ok('a different holder cannot release it', !session.clearGate('someone-else').ok);
ok('the holder releases it', session.clearGate('keeper:t1').ok && !session.gate);
send(MOVE); send(MOVE); send(ATTACK); await tick(60);
ok('after release the human steers again', received.filter(o => o === 100).length === 4 && received.includes(103), JSON.stringify(received));
ok('still re-framed correctly after release (the client is one step off for ever now)', hungUp === null, hungUp ?? '');
ok('status reports owning the stream', session.status().owning_stream === true);

// ------------------------------------------------------------------ 3. the automated courier trade
// The person chose Full Auto: the proxy answers the courier's offer and offers the person's goods.
session.trade = new ProxyTrade(session, { offerFrom: body => body.readUInt32LE(0) });
const COURIER = 4242, u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const fromServer = p => srvSock.write(plain(p));
const before = received.length, seen = toClient.length;
// An offer from a stranger is the person's business: it reaches the client.
fromServer(Buffer.concat([Buffer.from([211]), u32(999), Buffer.from([0, 0])])); await tick(40);
ok('an offer from anyone else reaches the client untouched', toClient.slice(seen).includes(211) && received.length === before);
fromServer(Buffer.from([212])); await tick(20);
session.trade.acceptFrom(COURIER, 10_000);
const seen2 = toClient.length;
fromServer(Buffer.concat([Buffer.from([211]), u32(COURIER), Buffer.from([0, 0])])); await tick(40);
ok('the courier offer is answered with an empty counteroffer', received.at(-1) === 123, JSON.stringify(received.slice(before)));
fromServer(Buffer.from([215, 0, 0])); fromServer(Buffer.from([212])); await tick(40);
ok('and the client never saw any of that trade (no window)', !toClient.slice(seen2).some(o => o >= 211 && o <= 215), JSON.stringify(toClient.slice(seen2)));
ok('the receive is recorded as closed', /closed after our counter/.test(session.trade.results.at(-1)?.outcome ?? ''));
const g = session.trade.give(COURIER, [{ id: 77, amount: 40 }], 10_000); await tick(40);
ok('giving offers the goods to the courier', g.ok && received.at(-1) === 120, JSON.stringify(g));
const seen3 = toClient.length;
fromServer(Buffer.from([213, 0, 0])); fromServer(Buffer.from([214, 0, 0])); await tick(40);
ok('and accepts once the courier counters', received.at(-1) === 121 && session.trade.active === null);
ok('again without the client seeing the trade', !toClient.slice(seen3).some(o => o >= 211 && o <= 215));
ok('every injected trade packet carried a valid security value', hungUp === null, hungUp ?? '');
send(Buffer.from([120, 1, 0, 0, 0, 0, 0])); await tick(20);
ok('while the person has their own trade open, nothing is automated', !session.trade.give(COURIER, [77]).ok);

client.destroy(); front.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
