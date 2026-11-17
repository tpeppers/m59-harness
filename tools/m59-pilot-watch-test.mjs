#!/usr/bin/env node
// m59-pilot-watch-test.mjs — WHILE A PERSON PLAYS, THE BROKER'S KEEPER LISTENS ON THEIR CONNECTION.
//
//   node tools/m59-pilot-watch-test.mjs
//
// Operator, 2026-11-16: playing a character from the fleet terminal's L bumped its keeper, and
// every broker read -- inventory, room, vitals -- then answered from the snapshot taken at that
// login, for as long as they played. A WATCHER (m59-proxy-attach.mjs) is the character's own keeper
// attached to the person's proxied connection that never drives. This pins:
//
//   1. on the wire: a watcher hears the session, its resend requests reach the server with security
//      values the server accepts and with no gate held, nothing else it sends does, they are spaced
//      out, and the person still steers afterwards;
//   2. the queue: requests made before the stream is calibrated wait for it;
//   3. ownership: a driver displaces a watcher, a watcher displaces nobody, a watcher never brings
//      a logged-off character back;
//   4. the broker transition (RidealongControls.watch): the pilot claim is KEPT, and a release to
//      the keeper replaces the watcher with a driver;
//   5. the plan desk asks for a watcher, once, and never while something is attached.
//
// Offline, loopback only: the same fake blakserv and lockstep human client as m59-spectate-test.mjs.

import net from 'node:net';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { ProxySession } from './m59-proxy.mjs';
import { serveAttach, attachKeeper, WATCH_PASS, WATCH_GAP_MS } from './m59-proxy-attach.mjs';
import { RidealongControls } from './m59-ridealong.mjs';
import { createControlProvider } from './plans/control.mjs';

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
const PLAYER_ID = 4464, ROOM_RSC = 77777;
const bpPlayer = () => bytes(130, u32(PLAYER_ID), u32(1), u32(2), u32(345), u32(ROOM_RSC), u32(4), u32(0xffffffff),
  0, 0, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0));
const reqMove = (row, col, speed = 18) => bytes(100, u16(row * 64 + 32), u16(col * 64 + 32), speed, u32(345));
const hello = (port, h) => new Promise(r => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => s.write(JSON.stringify(h) + '\n'));
  s.once('data', d => r({ sock: s, reply: JSON.parse(String(d).split('\n')[0]) }));
});

// ------------------------------------------------------------------ 0. the allowlist
console.log('the allowlist');
ok('a watcher may ask for a resend (player, room, inventory, stats)', [40, 42, 117, 41, 52].every(o => WATCH_PASS.has(o)));
ok('and may not move, attack, look, speak or quit', [100, 103, 116, 110, 111, 54, 20].every(o => !WATCH_PASS.has(o)));

// ------------------------------------------------------------------ 1. on the wire
console.log('on the wire');
const SEEDS = [3571238106, 184153256, 462, 697447458, 184166115];
const getChoice = seeds => { const b = Buffer.alloc(21); b[0] = 22; seeds.forEach((v, i) => b.writeUInt32LE(v, 1 + i * 4)); return b; };
const received = []; let hungUp = null, srvSock = null;
const server = net.createServer(sock => {
  srvSock = sock; let st = null, game = false;
  frames(sock, (p, sec) => {
    if (!game) { if (p[0] === 1) { sock.write(plain(getChoice(SEEDS))); sock.write(plain(Buffer.from([25]))); st = new Stream(SEEDS); game = true; } return; }
    const want = st.sec(p);
    if (want !== sec) { hungUp = `op ${p[0]}: got 0x${sec.toString(16)} want 0x${want.toString(16)}`; sock.destroy(); return; }
    received.push({ op: p[0], at: Date.now() });
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
ok('(the person is in game and the stream calibrated)', session.inGame && session.locked && session.playerId === PLAYER_ID);

const attachSrv = serveAttach(0, sel => (sel == null || sel === session.playerId) ? session : null, () => {});
await new Promise(r => attachSrv.once('listening', r));
const port = attachSrv.address().port;
process.env.M59_KEEPER_ATTACH = JSON.stringify({ port, agent: 't15', player: PLAYER_ID, watch: true });
const { M59Client } = await import('./m59-client.mjs');
const watcher = new M59Client({ verbose: false });
const r0 = received.length;
await watcher.login('t15', 'unused');
await tick(WATCH_GAP_MS * 4 + 200);
ok('the watcher attaches, marked as a watcher', watcher.state === 'game' && session.attached?.agent === 't15' && session.attached.watch === true);
const opened = received.slice(r0);
ok('its opening resend requests reach the server with NO gate held', !session.gate && opened.some(x => x.op === 40) && opened.some(x => x.op === 117),
   JSON.stringify(opened.map(x => x.op)));
ok('one at a time, at least WATCH_GAP_MS apart', opened.every((x, i) => i === 0 || x.at - opened[i - 1].at >= WATCH_GAP_MS - 25),
   JSON.stringify(opened.map(x => x.at - opened[0].at)));
ok('with security values the server accepts', hungUp === null, hungUp ?? '');
ok('the server\'s answer reaches the watcher (it learned its id from BP_PLAYER)', watcher.selfId === PLAYER_ID, String(watcher.selfId));

const r1 = received.length;
watcher.send(100, u16(6 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345));
watcher.send(103, Buffer.from([0]), u32(55));
watcher.send(116, u32(77));
await tick(WATCH_GAP_MS + 100);
ok('a watcher\'s move, attack and look go nowhere', received.length === r1 && session.attached.stats.dropped_not_holder >= 3,
   JSON.stringify({ sent: received.slice(r1), stats: session.attached.stats }));
session.setGate({ holder: 'keeper:t15', reason: 'test' });
watcher.send(100, u16(6 * 64 + 32), u16(9 * 64 + 32), Buffer.from([18]), u32(345)); await tick(80);
ok('even while the gate names its agent: a watcher is replaced by a driver, never promoted', received.length === r1);
session.clearGate('keeper:t15');

const r2 = received.length;
watcher.requestInventory(); watcher.requestInventory(); watcher.requestInventory();
await tick(WATCH_GAP_MS * 3);
ok('the same question asked three times while waiting is sent at most twice', received.slice(r2).filter(x => x.op === 117).length <= 2,
   JSON.stringify(received.slice(r2).map(x => x.op)));
const r3 = received.length;
humanSend(reqMove(4, 4)); humanSend(bytes(103, 0, u32(55))); await tick();
ok('the person still steers, after the proxy took over the stream for the watcher', received.slice(r3).map(x => x.op).join() === '100,103' && hungUp === null,
   hungUp ?? JSON.stringify(received.slice(r3)));

// ------------------------------------------------------------------ 3. ownership
console.log('ownership');
const second = await hello(port, { agent: 't15', player: PLAYER_ID, watch: true });
ok('a second watcher is refused', second.reply.ok === false && /already attached/.test(second.reply.why));
second.sock.destroy();
const driver = await hello(port, { agent: 't15', player: PLAYER_ID });
await tick();
ok('a DRIVER displaces the watcher', driver.reply.ok === true && session.attached?.watch === false && watcher.sock.destroyed);
const third = await hello(port, { agent: 't15', player: PLAYER_ID, watch: true });
ok('and a watcher cannot displace the driver', third.reply.ok === false && session.attached?.watch === false);
third.sock.destroy(); driver.sock.destroy(); await tick();
ok('(the driver leaves)', session.attached === null);
session.away = { by: 'keeper:t15', phase: 'menu' };
const away = await hello(port, { agent: 't15', player: PLAYER_ID, watch: true });
ok('a watcher never brings a logged-off character back', away.reply.ok === false && /logged off/.test(away.reply.why) && session.away);
away.sock.destroy(); session.away = null;

human.destroy(); front.close(); server.close(); attachSrv.close();
delete process.env.M59_KEEPER_ATTACH;

// ------------------------------------------------------------------ 2. the queue, alone
console.log('the queue');
{
  const s = Object.assign(new EventEmitter(), { inGame: false, away: null, locked: false, stream: { seeds: null }, sent: [],
    injectOwned(p) { this.sent.push(p[0]); return { sent: true }; } });
  const sock = Object.assign(new EventEmitter(), { destroyed: false, write() {}, destroy() { this.destroyed = true; this.emit('close'); } });
  attachKeeper(s, sock, { agent: 't3', watch: true });
  const f = p => { const o = Buffer.alloc(7 + p.length); o.writeUInt16LE(p.length, 0); p.copy(o, 7); return o; };
  sock.emit('data', f(Buffer.from([117]))); sock.emit('data', f(Buffer.from([40])));
  await tick(WATCH_GAP_MS + 50);
  ok('requests made before the stream is calibrated wait for it', s.sent.length === 0 && s.attached.stats.watch_queued === 2);
  Object.assign(s, { inGame: true, locked: true, stream: { seeds: [1] } });
  await tick(WATCH_GAP_MS * 2 + 150);
  ok('and are sent, in order, once it is', s.sent.join() === '117,40', s.sent.join());
  const off = Object.assign(new EventEmitter(), { inGame: true, locked: true, stream: { seeds: [1] }, sent: [],
    injectOwned(p) { this.sent.push(p[0]); return { sent: true }; } });
  const sock2 = Object.assign(new EventEmitter(), { destroyed: false, write() {}, destroy() {} });
  attachKeeper(off, sock2, { agent: 't3', watch: true, watchInject: false });
  sock2.emit('data', f(Buffer.from([117]))); await tick(50);
  ok('--no-watch-inject: a watcher only listens', off.sent.length === 0);
  sock.destroy();
}

// ------------------------------------------------------------------ 4. the broker transition
console.log('the broker transition');
{
  const stateFile = resolve('substrate', 'fleets', 'fixture-watch.json');
  const args = { agent: 't7', pid: 123, fleet_state: stateFile, player: 456, attach_port: 8932, gate_control: 8931 };
  const credentials = { account: 'fixture', character: 'Fixture Seven', host: '127.0.0.1', port: 5959 };
  const status = (gate = null) => ({ pid: 789, attach_port: 8932, gate_control: 8931, server: { host: '127.0.0.1', port: 5959 },
    sessions: [{ player_id: 456, in_game: true, gate, attached: null }] });
  const make = () => {
    const events = [];
    let pilot = { pid: 123, keeperWasRunning: true }, st = status();
    const c = new RidealongControls({ stateFile, credentials: a => a === 't7' ? credentials : null,
      pilot: () => pilot, keeper: () => ({ pid: 100 }), pidAlive: () => true, proxyStatus: async () => st,
      logPath: a => `keeper-${a}.log`,
      claim: () => events.push('claim'), unclaim: () => { events.push('unclaim'); pilot = null; },
      stop: async () => { events.push('stop'); return true; }, start: async () => { events.push('start'); return true; },
      ready: async () => { events.push('ready'); return true; } });
    return { c, events, setStatus: v => { st = v; }, setPilot: v => { pilot = v; }, pilot: () => pilot };
  };
  const f = make();
  const w = await f.c.watch(args);
  ok('watch swaps the bumped keeper for a watcher and KEEPS the pilot claim', w.ok && f.events.join() === 'stop,start,ready' && f.pilot()?.pid === 123,
     JSON.stringify({ w, events: f.events }));
  ok('it reports watching, not automated', w.watching === true && w.automated === false && f.c.records.get('t7').mode === 'watch');
  f.events.length = 0;
  ok('asking again is a no-op', (await f.c.watch(args)).already === true && f.events.length === 0);
  const other = make(); other.setPilot({ pid: 999 });
  ok('a watch for a client that is not the one claimed is refused', (await other.c.watch(args)).ok === false && other.events.length === 0);
  const releasing = make(); releasing.setStatus(status({ holder: 'keeper:t7' }));
  ok('a watch while the controls are being released to the keeper is refused', (await releasing.c.watch(args)).ok === false && releasing.events.length === 0);
  f.setStatus(status({ holder: 'keeper:t7' }));
  const d = await f.c.attach(args);
  ok('releasing to the keeper replaces the watcher with a driver', d.ok && d.automated === true && f.events.join() === 'stop,start,ready,unclaim' && !f.c.records.get('t7').mode,
     JSON.stringify({ d, events: f.events }));
  ok('and watch then refuses: the keeper is driving', /driving/.test((await f.c.watch(args)).error ?? ''));
  const g = make(); await g.c.watch(args); g.events.length = 0; g.setStatus(status({ holder: 'keeper:t7' }));
  const renumbered = await g.c.attach({ ...args, player: 457, ...{} }).catch(e => ({ error: e.message }));
  ok('a watcher on a renumbered player does not block a release', !/already released/.test(renumbered.error ?? ''), JSON.stringify(renumbered));
}

// ------------------------------------------------------------------ 5. the plan desk asks
console.log('the plan desk');
{
  const calls = [];
  let session = { player_id: 99, in_game: true, gate: null, gate_refusal: null, attached: null };
  const p = createControlProvider({ find: async () => ({ advert: { gate_control: 1001, attach: 1002 }, session }),
    proxy: async () => ({ ok: true }), callBroker: async a => { calls.push(a.action); return { ok: true, watching: true }; } });
  const ctx = { fleet: 'test', stateFile: resolve('substrate', 'fleets', 'fixture-watch.json'), substrate: '.', now: 1_000_000,
    client: { agent: 't1', pid: 42, player_id: 99, capabilities: {} }, desk: { messages: [] } };
  await p.tick(ctx); await tick(10);
  ok('a client in game with nothing attached gets a watcher asked for', calls.join() === 'watch', calls.join());
  await p.tick(ctx); await tick(10);
  ok('once, not on every tick', calls.length === 1);
  ctx.now += 15_001; session = { ...session, attached: { agent: 't1', watch: true } };
  await p.tick(ctx); await tick(10);
  ok('never while something is attached', calls.length === 1);
  const rows = await p.entries(ctx);
  ok('and the MANAGE tab says the reads are live', rows.find(r => r.id === 'control.reads')?.title === 'Broker reads: live');
  const off = createControlProvider({ watch: false, find: async () => ({ advert: { gate_control: 1001, attach: 1002 },
    session: { player_id: 99, in_game: true, gate: null, attached: null } }), proxy: async () => ({ ok: true }),
    callBroker: async a => { calls.push('off:' + a.action); return { ok: true }; } });
  await off.tick({ ...ctx, desk: { messages: [] } }); await tick(10);
  ok('M59_PLAN_WATCH=0 asks for nothing', !calls.some(c => c.startsWith('off:')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
