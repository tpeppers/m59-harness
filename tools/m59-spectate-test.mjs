#!/usr/bin/env node
// m59-spectate-test.mjs — A KEEPER DRIVES ON A PERSON'S CONNECTION WHILE THEY WATCH.
//
//   node tools/m59-spectate-test.mjs
//
// Offline, loopback only: a fake blakserv that checks every client packet's security value the
// way game.c:174-184 does (and hangs up on the first wrong one), a fake human client computing
// its own values in lockstep, the REAL ProxySession with its gate and attach port, and the REAL
// M59Client in attached mode (M59_KEEPER_ATTACH) as the keeper.

import net from 'node:net';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxySession } from './m59-proxy.mjs';
import { serveAttach, forgeFor, squareOf } from './m59-proxy-attach.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
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
  sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { if (buf.length < 7) return; const n = buf.readUInt16LE(0); if (buf.length < 7 + n) return; const w = buf.subarray(0, 7 + n); buf = buf.subarray(7 + n); on(Buffer.from(w.subarray(7)), w.readUInt16LE(2)); } });
}
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const bytes = (...x) => Buffer.concat(x.map(v => typeof v === 'number' ? Buffer.from([v]) : v));
// BP_PLAYER, laid out as m59-proxy-observation-test.mjs builds it (parsePlayer): self, icon, name, room, roomRsc, ...
const PLAYER_ID = 4464, ROOM_RSC = 77777;
const bpPlayer = () => bytes(130, u32(PLAYER_ID), u32(1), u32(2), u32(345), u32(ROOM_RSC), u32(4), u32(0xffffffff),
  0, 0, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0));
const reqMove = (row, col, speed = 18) => bytes(100, u16(row * 64 + 32), u16(col * 64 + 32), speed, u32(345));

// ------------------------------------------------------------------ 1. the forging rule, alone
{
  const dims = { rows: 20, cols: 30 };
  ok('a move inside the room is mirrored to the person', forgeFor(reqMove(5, 7), { playerId: 9, dims })?.[0] === 200);
  ok('a move past the room edge is NEVER forged (it would crash the client)', forgeFor(reqMove(21, 7), { playerId: 9, dims }) === null && forgeFor(reqMove(5, 31), { playerId: 9, dims }) === null);
  ok('a move off the room (speed 0) is left to the server\'s room burst', forgeFor(reqMove(5, 7, 0), { playerId: 9, dims }) === null);
  ok('an unknown room is never forged into', forgeFor(reqMove(5, 7), { playerId: 9, dims: null }) === null);
  ok('a turn is mirrored', forgeFor(bytes(101, u32(9), u16(1024)), { playerId: 9, dims: null })?.[0] === 201);
  ok('squares are 1-based off the +KOD_FINENESS offset', squareOf(64) === 1 && squareOf(64 * 20 + 63) === 20);
}

// ------------------------------------------------------------------ 2. on the wire
const tmp = mkdtempSync(join(tmpdir(), 'spectate-'));
const mapFile = join(tmp, 'map.json');
writeFileSync(mapFile, JSON.stringify({ rooms: { 345: { num: 345, roomRsc: ROOM_RSC, rows: 20, cols: 30 } } }));

const SEEDS = [3571238106, 184153256, 462, 697447458, 184166115];
const received = []; let hungUp = null, srvSock = null;
const server = net.createServer(sock => {
  srvSock = sock; const st = new Stream(SEEDS); let game = false;
  frames(sock, (p, sec) => {
    if (!game) { if (p[0] === 1) { const b = Buffer.alloc(21); b[0] = 22; SEEDS.forEach((v, i) => b.writeUInt32LE(v, 1 + i * 4)); sock.write(plain(b)); sock.write(plain(Buffer.from([25]))); game = true; } return; }
    const want = st.sec(p);
    if (want !== sec) { hungUp = `op ${p[0]}: got 0x${sec.toString(16)} want 0x${want.toString(16)}`; sock.destroy(); return; }
    received.push(p[0]);
    // The server answers a resend request (BP_SEND_PLAYER, 40) the way blakserv does: with BP_PLAYER.
    if (p[0] === 40) sock.write(plain(bpPlayer()));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const front = net.createServer();
await new Promise(r => front.listen(0, '127.0.0.1', r));
let session;
front.on('connection', sock => { session = new ProxySession(sock, { host: '127.0.0.1', port: server.address().port, observe: true, gateable: true }); });
const human = net.connect(front.address().port, '127.0.0.1');
await new Promise(r => human.on('connect', r));
let hst = null; const toHuman = [];
frames(human, p => { toHuman.push(p); if (p[0] === 22 && !hst) hst = new Stream([...Array(5)].map((_, i) => p.readUInt32LE(1 + i * 4))); });
const humanSend = p => human.write(frame(p, hst.sec(p)));
human.write(plain(Buffer.from([1]))); await tick(80);
humanSend(reqMove(3, 3)); humanSend(reqMove(3, 4)); await tick();
srvSock.write(plain(bpPlayer())); await tick();
ok('the person is in game, the stream calibrated, the player id learned', session.inGame && session.locked && session.playerId === PLAYER_ID);

const attachSrv = serveAttach(0, sel => (sel == null || sel === session.playerId) ? session : null, () => {}, { mapFile });
await new Promise(r => attachSrv.once('listening', r));
process.env.M59_KEEPER_ATTACH = JSON.stringify({ port: attachSrv.address().port, agent: 't15', player: PLAYER_ID });
const { M59Client } = await import('./m59-client.mjs');
const keeper = new M59Client({ verbose: false });
const beforeAttach = received.length;
await keeper.login('t15', 'unused');
await tick(120);
ok('the keeper attaches without logging in', keeper.state === 'game' && session.attached?.agent === 't15');
ok('while the PERSON holds the controls, the keeper\'s requests go nowhere', received.length === beforeAttach && session.attached.stats.dropped_not_holder > 0,
   JSON.stringify({ sent: received.slice(beforeAttach), stats: session.attached }));
// It still sees everything the server says: the BP_PLAYER pushed above reached it? Push another and watch.
srvSock.write(plain(bpPlayer())); await tick(80);
ok('the keeper reads the person\'s session (it learned its own id from BP_PLAYER)', keeper.selfId === PLAYER_ID, String(keeper.selfId));
ok('and the proxy learned the room size from the same frame', session.attachDims?.rows === 20);

// Relinquish.
const took = session.setGate({ holder: 'keeper:t15', reason: 'spectate' });
ok('the keeper takes the controls', took.ok, took.why);
const seenHuman = toHuman.length, sent0 = received.length;
keeper.send(40);                                   // a resend request: the server will answer with BP_PLAYER
keeper.send(100, u16(6 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345));   // a step inside the room
keeper.send(100, u16(25 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345));  // a step past the edge
await tick(80);
ok('the keeper\'s packets reach the server', received.slice(sent0).filter(o => o === 100).length === 2 && received.slice(sent0).includes(40), JSON.stringify(received.slice(sent0)));
ok('with security values the server accepts (it hangs up on the first wrong one)', hungUp === null, hungUp ?? '');
const mirrored = toHuman.slice(seenHuman).filter(p => p[0] === 200);
ok('the person\'s screen follows the step inside the room', mirrored.length === 1 && squareOf(mirrored[0].readUInt16LE(5)) === 6 && mirrored[0].readUInt32LE(1) === PLAYER_ID,
   JSON.stringify(mirrored.map(p => [...p])));
ok('and is never sent the square past the edge', !toHuman.slice(seenHuman).some(p => p[0] === 200 && squareOf(p.readUInt16LE(5)) === 25));
const sent1 = received.length;
humanSend(reqMove(4, 4)); humanSend(bytes(103, 0, u32(55))); await tick();
ok('the person\'s own movement and attacks are dropped while the keeper drives', received.length === sent1);

// Take control back.
session.clearGate('keeper:t15');
const sent2 = received.length;
keeper.send(100, u16(7 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345)); await tick();
ok('taking control back silences the keeper on its very next packet', received.length === sent2 && session.attached.stats.dropped_not_holder > 0);
humanSend(reqMove(4, 5)); await tick();
ok('and the person steers again', received.at(-1) === 100 && received.length === sent2 + 1);
ok('no wrong security value across the whole handover', hungUp === null, hungUp ?? '');

const second = net.connect(attachSrv.address().port, '127.0.0.1');
const reply = await new Promise(r => { second.on('connect', () => second.write(JSON.stringify({ agent: 't16', player: PLAYER_ID }) + '\n')); second.once('data', d => r(String(d))); });
ok('a second keeper cannot attach to the same session', /already attached/.test(reply));
second.destroy();

keeper.sock.destroy(); await tick();
ok('when the keeper goes away the session forgets it', session.attached === null);

human.destroy(); front.close(); server.close(); attachSrv.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
