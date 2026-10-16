#!/usr/bin/env node
// m59-proxy-token-test.mjs — THE PROXY READS AND WRITES A PINGING CLIENT'S STREAM CORRECTLY.
//
//   node tools/m59-proxy-token-test.mjs
//
// Offline, loopback only. The server and the client below are written from blakserv/commcli.c
// (SecurePacketBufferList), game.c (GameEchoPing) and clientd3d/server.c (DesecureByServerToken,
// HandleEchoPing) independently of m59-proxy-token.mjs, so the test is not the code checking itself.
//
// What broke without this (2026-10-15): spectate attached a keeper to a real client's connection.
// The real client pings, so the server had scrambled every opcode; the keeper read garbage, the
// session fell into resync and the character-select screen, and the client crashed in char.dll.

import net from 'node:net';
import zlib from 'node:zlib';
import { OpcodeToken, DEFAULT_REDBOOK, BP_ECHO_PING } from './m59-proxy-token.mjs';
import { ProxySession } from './m59-proxy.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const BOOK_ID = 4242, BOOK = 'Zq!x~';      // a short redbook, so the walk wraps within the test
const lookup = id => (id === BOOK_ID ? BOOK : null);

// The server's side: secure, slide, and adopt a ping's token only AFTER sending it.
class Server {
  constructor(book = BOOK) { this.token = 0; this.slide = null; this.book = book; }
  secure(plain) {
    const b = Buffer.from(plain); b[0] ^= this.token & 0xff;
    if (this.slide !== null) { this.token += this.book.charCodeAt(this.slide) & 0x7f; this.slide++; if (this.slide >= this.book.length) this.slide = 0; }
    return b;
  }
  ping(seed0, id = BOOK_ID) {
    const token = seed0 & 0xff;
    const m = Buffer.alloc(6); m[0] = BP_ECHO_PING; m[1] = (token ^ 0xed) & 0xff; m.writeUInt32LE(id, 2);
    const out = this.secure(m);
    this.token = token; this.slide = 0; if (!id) this.book = DEFAULT_REDBOOK;
    return out;
  }
}
// The client's side: desecure, slide, then a BP_ECHO_PING sets the token and restarts the walk.
class Client {
  constructor() { this.token = 0; this.book = null; this.slide = 0; }
  read(wire) {
    const b = Buffer.from(wire); b[0] ^= this.token & 0xff;
    if (this.book) { this.token += this.book.charCodeAt(this.slide) & 0x7f; this.slide++; if (this.slide >= this.book.length) this.slide = 0; }
    if (b[0] === BP_ECHO_PING && b.length >= 6) { this.token = (b[1] << 24 >> 24) ^ 0xed; this.book = lookup(b.readUInt32LE(2)) || DEFAULT_REDBOOK; this.slide = 0; }
    return b;
  }
}
const msg = (op, n = 3) => Buffer.from([op, ...Array.from({ length: n }, (_, i) => (op * 7 + i) & 0xff)]);
const OPS = [130, 134, 200, 201, 200, 32, 31, 130, 200, 201, 202, 137, 200, 201, 200, 32];

// ------------------------------------------------------------------ 1. the tracker alone
{
  const srv = new Server(), dec = new OpcodeToken({ lookup });
  ok('before any ping the stream is plain', OPS.slice(0, 3).every(op => dec.decode(srv.secure(msg(op)))[0] === op));
  const pingPlain = dec.decode(srv.ping(0x5b));
  ok('the echo ping itself still carries the OLD token', pingPlain[0] === BP_ECHO_PING);
  const after = OPS.map(op => dec.decode(srv.secure(msg(op)))[0]);
  ok('after the ping every opcode decodes, through several wraps of the redbook', after.join() === OPS.join(), after.join());
  const wires = OPS.map(op => srv.secure(msg(op)));
  ok('...and the wire really was scrambled (or this test proves nothing)', wires.filter((w, i) => w[0] !== OPS[i]).length >= OPS.length - 2);
  ok('...and those decode too', wires.map(w => dec.decode(w)[0]).join() === OPS.join());
  const p2 = dec.decode(srv.ping(0x0e));
  ok('a second ping re-keys both ends', p2[0] === BP_ECHO_PING && OPS.every(op => dec.decode(srv.secure(msg(op)))[0] === op));
  const s3 = new Server(), d3 = new OpcodeToken({ lookup });
  d3.decode(s3.ping(0x77, 0));
  ok('redbook id 0 means the default string on both ends', OPS.every(op => d3.decode(s3.secure(msg(op)))[0] === op));
  const s4 = new Server(DEFAULT_REDBOOK), d4 = new OpcodeToken({ lookup: () => null });
  d4.decode(s4.ping(0x31, 999));
  ok('an id the client cannot find also means the default string', OPS.every(op => d4.decode(s4.secure(msg(op)))[0] === op));
}
{
  // Forging adds a message only the client sees; swallowing removes one only the server sent.
  const srv = new Server(), dec = new OpcodeToken({ lookup }), enc = new OpcodeToken({ lookup }), cli = new Client();
  const pass = w => cli.read(enc.encode(dec.decode(w)));
  pass(srv.ping(0x44));
  const got = [];
  OPS.forEach((op, i) => {
    const plain = dec.decode(srv.secure(msg(op)));
    if (i === 3) return;                                            // swallowed: never encoded, never sent
    got.push(cli.read(enc.encode(plain))[0]);
    if (i === 5) got.push(cli.read(enc.encode(msg(201)))[0]);      // forged towards the client
  });
  const want = OPS.filter((_, i) => i !== 3); want.splice(5, 0, 201);
  ok('a swallowed and a forged message leave the client reading every later opcode right', got.join() === want.join(), got.join() + ' vs ' + want.join());
}

// ------------------------------------------------------------------ 2. through the real ProxySession
const crc16 = b => zlib.crc32(b) & 0xffff;
const frame = p => { const o = Buffer.alloc(7 + p.length); o.writeUInt16LE(p.length, 0); o.writeUInt16LE(crc16(p), 2); o.writeUInt16LE(p.length, 4); o.writeUInt8(1, 6); p.copy(o, 7); return o; };
function frames(sock, on) {
  let buf = Buffer.alloc(0);
  sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 7) return; const n = buf.readUInt16LE(0); if (buf.length < 7 + n) return; const p = Buffer.from(buf.subarray(7, 7 + n)); const c = buf.readUInt16LE(2); buf = buf.subarray(7 + n); on(p, c); } });
}
const srv = new Server(); let srvSock = null;
const server = net.createServer(s => { srvSock = s; });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const front = net.createServer(); await new Promise(r => front.listen(0, '127.0.0.1', r));
let session;
front.on('connection', sock => {
  session = new ProxySession(sock, { host: '127.0.0.1', port: server.address().port, observe: true, gateable: true });
  session.fromServerToken.lookup = lookup; session.toClientToken.lookup = lookup;
});
const human = net.connect(front.address().port, '127.0.0.1'); await new Promise(r => human.on('connect', r));
await tick(80);
const cli = new Client(), seen = [], crcBad = [];
frames(human, (p, c) => { if (crc16(p) !== c) crcBad.push(p[0]); seen.push(cli.read(p)[0]); });
const keeperSaw = [];
session.on('server-frame', whole => keeperSaw.push(whole[7]));
const send = p => srvSock.write(frame(srv.secure(p)));
srvSock.write(frame(srv.ping(0x9d)));
for (const op of OPS) send(msg(op));
await tick(120);
ok('the client gets the server\'s bytes and reads every opcode', seen.slice(1).join() === OPS.join(), seen.join());
ok('an attached keeper is handed every frame PLAIN', keeperSaw.slice(1).join() === OPS.join(), keeperSaw.join());
session.toClient(msg(201, 6));
for (const op of OPS) send(msg(op));
await tick(120);
ok('a move forged towards the client is read as one, and the stream after it still reads right',
  seen.slice(1 + OPS.length).join() === [201, ...OPS].join(), seen.slice(1 + OPS.length).join());
ok('every frame the client got has a correct crc', crcBad.length === 0, crcBad.join());

human.destroy(); front.close(); server.close(); srvSock?.destroy();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
