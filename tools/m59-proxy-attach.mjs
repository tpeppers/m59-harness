// SPECTATE: A KEEPER ON THE HUMAN'S OWN CONNECTION, through the proxy's attach port.
//
// The server allows one connection per character and a person playing in the dev client
// holds it, so a keeper cannot log in beside them. Before this, "Relinquish control to
// Keeper" meant "you are locked out and nothing drives". Now the keeper ATTACHES to the
// session the proxy is already carrying, and the person watches it play:
//
//   proxy -> keeper   a copy of every server->client frame of that session, as received
//   keeper -> proxy   frames the keeper would have sent; the proxy discards their header,
//                     re-frames the payload at the true stream position, and injects it
//
// The keeper's client (M59Client with M59_KEEPER_ATTACH set) skips the login exchange and
// asks the server to resend player, room, inventory and stats -- requests the gate's
// allowlist passes -- which rebuild its picture mid-session. The person's client receives
// the same resends and simply redraws.
//
// WHO MAY SEND IS THE GATE'S HOLDER, NEVER THE ATTACHMENT. A keeper may attach any time and
// watch ("the keeper stands by on the proxy"). Its frames are injected only while the gate
// is held by `keeper:<agent>` for the agent it attached as; otherwise they are dropped and
// counted. A person who takes control back silences the keeper on its very next packet,
// with nothing the keeper has to get right.
//
// THE PERSON'S SCREEN FOLLOWS THE KEEPER. The server never echoes your own move to you
// (user.kod:6171-6176), so a keeper's BP_REQ_MOVE would leave the spectator's view frozen
// where they let go. The proxy forges the matching BP_MOVE / BP_TURN to the client, as
// step() does -- but ONLY for a square inside the current room's grid. Forging an out-of-
// room square reads past the client's grid array and crashes it (two ACCESS_VIOLATION dumps,
// see m59-proxy.mjs step()). Room size comes from BP_PLAYER's room resource and
// substrate/m59-map.json; an unknown room is never forged into, so the worst case is a view
// that lags until the server's next room burst, never a crash.
//
// A KEEPER'S SURVIVAL LOGOFF IS DONE HERE. Its BP_REQ_QUIT (holder only) becomes
// ProxySession.logoffAway on the shared connection, and its re-attach, answered only once the
// character is back in the world, is what ends the logoff. Its BP_REQ_LOOKs are tagged, so the
// descriptions they return never open a window on the person's screen.
//
// Handshake: the keeper's first line is JSON {"agent":"t15","player":<objId>}\n; the proxy
// answers one JSON line, then raw frames flow both ways. Loopback only.
//
// A WATCHER IS A KEEPER THAT NEVER DRIVES ({"watch":true} in the hello). While a person plays,
// the broker attaches the character's own keeper this way so `inventory`, `status` and the fleet
// board read the live session instead of the snapshot the keeper held when the person's login
// bumped it (operator, 2026-11-16: "it's always stale when I go to talk to Claude"). A watcher may
// send only WATCH_PASS -- requests that the server resend what it already told the person's
// client -- and only one every WATCH_GAP_MS, so the person's screen redraws at most that often.
// Anything else it sends is dropped, gate or no gate. A DRIVER (a hello without `watch`) displaces
// a watcher: releasing the controls to the keeper replaces the watching keeper with a driving one.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayer } from './m59-parse.mjs';
import { gateLive, gateRefusal } from './m59-proxy-gate.mjs';

// The resend requests a watcher may send without the controls: a subset of GATE_PASS
// (m59-proxy-gate.mjs) with no look (a window on the person's screen), no chat, no quit, no mail.
export const WATCH_PASS = new Set([40, 41, 42, 43, 44, 49, 50, 51, 52, 53, 117]);
export const WATCH_GAP_MS = 500;
const WATCH_QUEUE_MAX = 16;

const HEADER = 7;
const BP_PLAYER = 130, BP_REQ_MOVE = 100, BP_REQ_TURN = 101, BP_MOVE = 200, BP_TURN = 201;
const BP_REQ_QUIT = 54, BP_REQ_LOOK = 116;
const DEFAULT_MAP = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'm59-map.json');

let ROOMS = null;
export function roomDims(roomRsc, mapFile = DEFAULT_MAP) {
  if (!ROOMS) {
    ROOMS = new Map();
    try {
      for (const r of Object.values(JSON.parse(readFileSync(mapFile, 'utf8')).rooms ?? {}))
        if (r.roomRsc && r.rows && r.cols) ROOMS.set(r.roomRsc, { rows: r.rows, cols: r.cols, num: r.num });
    } catch { /* no map: nothing is ever forged, which is the safe answer */ }
  }
  return ROOMS.get(roomRsc) ?? null;
}

// The square a wire coordinate names: kod fine units + KOD_FINENESS, so floor(v/64) is 1-based.
export const squareOf = v => Math.floor(v / 64);

// What, if anything, to show the person's client for a keeper's request.
export function forgeFor(payload, { playerId, dims }) {
  if (playerId == null) return null;
  if (payload[0] === BP_REQ_MOVE && payload.length >= 10) {
    if (!dims) return null;
    const y = payload.readUInt16LE(1), x = payload.readUInt16LE(3), speed = payload.readUInt8(5);
    const row = squareOf(y), col = squareOf(x);
    if (speed === 0 || row < 1 || col < 1 || row > dims.rows || col > dims.cols) return null;
    const mv = Buffer.alloc(10);
    mv.writeUInt8(BP_MOVE, 0); mv.writeUInt32LE(playerId >>> 0, 1);
    mv.writeUInt16LE(y, 5); mv.writeUInt16LE(x, 7); mv.writeUInt8(speed | 0x80, 9);
    return mv;
  }
  if (payload[0] === BP_REQ_TURN && payload.length >= 7) {
    const t = Buffer.alloc(7);
    t.writeUInt8(BP_TURN, 0); t.writeUInt32LE(playerId >>> 0, 1); t.writeUInt16LE(payload.readUInt16LE(5), 5);
    return t;
  }
  return null;
}

// Wire one attached keeper to one proxy session. Returns a detach function.
export function attachKeeper(session, sock, { agent, watch = false, watchInject = true, log = () => {}, mapFile = DEFAULT_MAP }) {
  const holder = `keeper:${agent}`;
  const stats = { to_keeper: 0, injected: 0, dropped_not_holder: 0, forged: 0, refused: 0,
                  ...(watch ? { watch_sent: 0, watch_queued: 0, watch_dropped: 0 } : {}) };
  // `kick` (set below, once detach exists) is how a driver displaces a watcher (serveAttach).
  session.attached ={ agent, stats, since: Date.now(), watch: !!watch };
  // THE WATCHER'S RESEND REQUESTS. Held until the stream is calibrated (injecting before then is
  // refused, see gateRefusal), then sent one per WATCH_GAP_MS. A repeat of an opcode already
  // waiting is the same question asked twice and is dropped.
  const queue = [];
  let pump = null, lastSentAt = 0;
  const flush = () => {
    if (!queue.length) { clearInterval(pump); pump = null; return; }
    if (Date.now() - lastSentAt < WATCH_GAP_MS) return;
    if (!session.inGame || session.away || gateRefusal(session)) return;
    const payload = queue.shift();
    const r = session.injectOwned(payload);
    if (r.sent) { stats.watch_sent++; lastSentAt = Date.now(); } else stats.refused++;
  };
  const watchRequest = payload => {
    if (!watchInject || !WATCH_PASS.has(payload[0])) { stats.dropped_not_holder++; return; }
    if (queue.some(q => q[0] === payload[0]) || queue.length >= WATCH_QUEUE_MAX) { stats.watch_dropped++; return; }
    queue.push(payload); stats.watch_queued++;
    flush();
    if (queue.length && !pump) { pump = setInterval(flush, Math.ceil(WATCH_GAP_MS / 4)); pump.unref?.(); }
  };
  const onFrame = whole => {
    const payload = whole.subarray(HEADER);
    if (payload[0] === BP_PLAYER) {
      try { session.attachDims = roomDims(parsePlayer(payload.subarray(1)).roomRsc, mapFile); } catch { session.attachDims = null; }
    }
    if (!sock.destroyed) { sock.write(whole); stats.to_keeper++; }
  };
  session.on('server-frame', onFrame);
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < HEADER) return;
      const len = buf.readUInt16LE(0);
      if (buf.length < HEADER + len) return;
      const payload = Buffer.from(buf.subarray(HEADER, HEADER + len));
      buf = buf.subarray(HEADER + len);
      if (!payload.length) continue;
      // A watcher never drives, whoever holds the gate: it is replaced by a driver, not promoted.
      if (watch) { watchRequest(payload); continue; }
      if (!session.inGame || session.away) continue;
      if (!(gateLive(session.gate) && session.gate.holder === holder)) { stats.dropped_not_holder++; continue; }
      // LOGGING OFF TO SURVIVE. The keeper's client sends BP_REQ_QUIT and then drops this socket
      // (m59-client.mjs attachedLogoff); the proxy takes the character out of the world on the shared
      // connection and brings it back when the keeper re-attaches (ProxySession.logoffAway).
      if (payload[0] === BP_REQ_QUIT) {
        const r = session.logoffAway({ by: holder });
        if (r.ok) stats.logoffs = (stats.logoffs ?? 0) + 1; else stats.refused++;
        log(`keeper ${agent} logoff: ${r.ok ? 'out of the world' : 'refused — ' + r.why}`);
        continue;
      }
      const r = session.injectOwned(payload);
      if (!r.sent) { stats.refused++; continue; }
      stats.injected++;
      if (payload[0] === BP_REQ_LOOK) session.noteLook('keeper');
      const forged = forgeFor(payload, { playerId: session.playerId, dims: session.attachDims });
      if (forged) { session.toClient(forged); stats.forged++; }
    }
  });
  let detached = false;
  const detach = () => {
    if (detached) return; detached = true;
    clearInterval(pump); pump = null; queue.length = 0;
    session.off('server-frame', onFrame);
    if (session.attached?.stats === stats) session.attached = null;
  };
  // Synchronous, so a driver displacing this watcher finds the session free at once.
  session.attached.kick = () => { detach(); sock.destroy(); };
  sock.on('close', () => { detach(); log(`keeper ${agent} detached (${JSON.stringify(stats)})`); });
  sock.on('error', () => {});
  session.once('closed', () => sock.destroy());
  log(`keeper ${agent} attached to player ${session.playerId}`);
  return detach;
}

export function serveAttach(port, getSession, log = m => console.error(m), opts = {}) {
  return net.createServer(sock => {
    let head = Buffer.alloc(0);
    const onHead = d => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(10);
      if (nl < 0) { if (head.length > 512) sock.destroy(); return; }
      sock.off('data', onHead);
      let hello; try { hello = JSON.parse(head.subarray(0, nl).toString('utf8')); } catch { sock.end('{"ok":false,"why":"bad hello"}\n'); return; }
      const s = getSession(hello.player != null ? Number(hello.player) : null);
      if (!s || !/^[a-z0-9_-]{1,40}$/.test(String(hello.agent ?? ''))) { sock.end('{"ok":false,"why":"no such session or bad agent"}\n'); return; }
      const watch = hello.watch === true;
      // A DRIVER DISPLACES A WATCHER (see the header); a watcher displaces nobody.
      const displace = () => {
        if (watch || !s.attached?.watch || s.attached.agent !== String(hello.agent)) return;
        log(`keeper ${hello.agent} displaces watcher ${s.attached.agent}`);
        s.attached.kick?.();
      };
      displace();
      if (s.attached) { sock.end(JSON.stringify({ ok: false, why: `keeper ${s.attached.agent} is already attached` }) + '\n'); return; }
      // Bringing a character back from a logoff is a driver's decision, never a watcher's.
      if (watch && s.away) { sock.end('{"ok":false,"why":"the character is logged off on this connection; a watcher waits"}\n'); return; }
      const rest = head.subarray(nl + 1);
      const accept = () => {
        if (sock.destroyed) return;
        displace();
        if (s.attached) { sock.end(JSON.stringify({ ok: false, why: `keeper ${s.attached.agent} is already attached` }) + '\n'); return; }
        sock.write(JSON.stringify({ ok: true, player: s.playerId }) + '\n');
        attachKeeper(s, sock, { agent: String(hello.agent), log, ...opts, watch });
        if (rest.length) sock.emit('data', rest);
      };
      // A keeper coming back from its survival logoff is what ends the logoff. It is answered only once
      // the character is in the world again, so the resend requests it opens with are not lost on a menu.
      if (s.away) {
        const back = () => { s.off('closed', gone); accept(); };
        const gone = () => { s.off('back', back); sock.end('{"ok":false,"why":"the session closed during the logoff"}\n'); };
        s.once('back', back); s.once('closed', gone);
        s.awayReturn(`keeper ${hello.agent} re-attached`);
        return;
      }
      accept();
    };
    sock.on('data', onHead);
    sock.on('error', () => {});
  }).listen(port, '127.0.0.1', () => log(`  keeper attach on 127.0.0.1:${port}`));
}
