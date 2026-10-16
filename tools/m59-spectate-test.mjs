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
// The menu's seeds after a BP_REQ_QUIT: new ones, as SynchedSendMenuChoice makes them.
const SEEDS2 = [1234567891, 98765432, 777, 424242424, 31337];
const getChoice = seeds => { const b = Buffer.alloc(21); b[0] = 22; seeds.forEach((v, i) => b.writeUInt32LE(v, 1 + i * 4)); return b; };
const received = [], menu = []; let hungUp = null, srvSock = null, usedCharacter = null;
const server = net.createServer(sock => {
  srvSock = sock; let st = null, game = false, menuSeeds = SEEDS;
  frames(sock, (p, sec) => {
    // Menu mode (synched.c) is not checksummed. AP_LOGIN gets the seeds and the game; AP_REQ_GAME (4)
    // after a quit gets the game on the seeds the menu handed out.
    if (!game) {
      menu.push(p[0]);
      if (p[0] === 1) sock.write(plain(getChoice(SEEDS)));
      if (p[0] === 1 || p[0] === 4) { sock.write(plain(Buffer.from([25]))); st = new Stream(menuSeeds); game = true; }
      return;
    }
    const want = st.sec(p);
    if (want !== sec) { hungUp = `op ${p[0]}: got 0x${sec.toString(16)} want 0x${want.toString(16)}`; sock.destroy(); return; }
    received.push(p[0]);
    // The server answers a resend request (BP_SEND_PLAYER, 40) the way blakserv does: with BP_PLAYER.
    if (p[0] === 40) sock.write(plain(bpPlayer()));
    // A look (116) is answered with the object's description (BP_LOOK, 207).
    if (p[0] === 116) sock.write(plain(bytes(207, u32(p.readUInt32LE(1)), u32(0), u32(0))));
    // BP_REQ_QUIT: out of the world, BP_QUIT, then the menu with new seeds (game.c:421, SynchedDoMenu).
    if (p[0] === 54) { sock.write(plain(Buffer.from([149]))); sock.write(plain(getChoice(SEEDS2))); menuSeeds = SEEDS2; game = false; }
    // BP_USE_CHARACTER: back in the world, which starts with BP_PLAYER.
    if (p[0] === 46) { usedCharacter = p.readUInt32LE(1); sock.write(plain(bpPlayer())); }
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

// The keeper's looks: the description goes to the keeper, never into a window on the person's screen.
const h0 = toHuman.length;
keeper.look(77); await tick(80);
ok('a description the KEEPER asked for never opens on the person\'s screen', received.includes(116) && !toHuman.slice(h0).some(p => p[0] === 207) && session.stats.swallowed_looks === 1,
   JSON.stringify({ toHuman: toHuman.slice(h0).map(p => p[0]), swallowed: session.stats.swallowed_looks }));
humanSend(bytes(116, u32(78))); await tick(80);
ok('the person\'s own look still opens', toHuman.slice(h0).some(p => p[0] === 207 && p.readUInt32LE(1) === 78));

// The keeper's survival logoff, the way Session.rejoin does it attached: ask, drop the socket, re-attach.
const h1 = toHuman.length, r1 = received.length, m1 = menu.length;
await keeper.attachedLogoff(); keeper.sock.destroy(); await tick(80);
ok('a keeper\'s survival logoff really takes the character out of the world', received.slice(r1).join() === '54' && session.status().away?.phase === 'menu',
   JSON.stringify({ sent: received.slice(r1), away: session.status().away }));
ok('and the person\'s client sees none of it: no BP_QUIT, no menu', !toHuman.slice(h1).some(p => [149, 22, 25].includes(p[0])), JSON.stringify(toHuman.slice(h1).map(p => p[0])));
humanSend(reqMove(5, 5)); humanSend(bytes(110, 1, u16(2), Buffer.from('hi'))); await tick();
ok('nothing the person\'s client sends reaches a server sitting at its menu', menu.length === m1 && received.length === r1 + 1);
const keeper2 = new M59Client({ verbose: false });
await keeper2.login('t15', 'unused'); await tick(150);
ok('the keeper re-attaching brings the character back: AP_REQ_GAME, then BP_USE_CHARACTER for it', menu.slice(m1).join() === '4' && usedCharacter === PLAYER_ID && !session.away,
   JSON.stringify({ menu: menu.slice(m1), usedCharacter, away: session.status().away }));
ok('on the menu\'s NEW seeds, which the server accepted', hungUp === null && received.slice(r1).includes(46), hungUp ?? JSON.stringify(received.slice(r1)));
ok('the person\'s client gets the re-entry as a room burst, and still no menu', toHuman.slice(h1).some(p => p[0] === 130) && !toHuman.slice(h1).some(p => [149, 22, 25].includes(p[0])));
ok('the keeper is attached again once the character is back', keeper2.state === 'game' && session.attached?.agent === 't15' && received.slice(r1).includes(40));

// Taking control back in the middle of a logoff brings the character straight back to the person.
const m2 = menu.length; usedCharacter = null;
await keeper2.attachedLogoff(); await tick(80);
ok('(a second logoff, the keeper still attached)', session.status().away?.phase === 'menu');
session.clearGate('keeper:t15'); await tick(80);
ok('taking control back mid-logoff returns the character at once', !session.away && usedCharacter === PLAYER_ID && menu.slice(m2).join() === '4' && hungUp === null,
   JSON.stringify({ usedCharacter, menu: menu.slice(m2), away: session.status().away, hungUp }));
ok('(the keeper takes the controls again)', session.setGate({ holder: 'keeper:t15', reason: 'spectate' }).ok);

// Take control back.
session.clearGate('keeper:t15');
const sent2 = received.length;
keeper2.send(100, u16(7 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345)); await tick();
ok('taking control back silences the keeper on its very next packet', received.length === sent2 && session.attached.stats.dropped_not_holder > 0);
humanSend(reqMove(4, 5)); await tick();
ok('and the person steers again', received.at(-1) === 100 && received.length === sent2 + 1);
ok('no wrong security value across the whole handover', hungUp === null, hungUp ?? '');

const second = net.connect(attachSrv.address().port, '127.0.0.1');
const reply = await new Promise(r => { second.on('connect', () => second.write(JSON.stringify({ agent: 't16', player: PLAYER_ID }) + '\n')); second.once('data', d => r(String(d))); });
ok('a second keeper cannot attach to the same session', /already attached/.test(reply));
second.destroy();

keeper2.sock.destroy(); await tick();
ok('when the keeper goes away the session forgets it', session.attached === null);

human.destroy(); front.close(); server.close(); attachSrv.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
