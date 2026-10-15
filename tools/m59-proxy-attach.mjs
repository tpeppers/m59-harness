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
// Handshake: the keeper's first line is JSON {"agent":"t15","player":<objId>}\n; the proxy
// answers one JSON line, then raw frames flow both ways. Loopback only.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayer } from './m59-parse.mjs';
import { gateLive } from './m59-proxy-gate.mjs';

const HEADER = 7;
const BP_PLAYER = 130, BP_REQ_MOVE = 100, BP_REQ_TURN = 101, BP_MOVE = 200, BP_TURN = 201;
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
export function attachKeeper(session, sock, { agent, log = () => {}, mapFile = DEFAULT_MAP }) {
  const holder = `keeper:${agent}`;
  const stats = { to_keeper: 0, injected: 0, dropped_not_holder: 0, forged: 0, refused: 0 };
  session.attached = { agent, stats, since: Date.now() };
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
      if (!session.inGame || !payload.length) continue;
      if (!(gateLive(session.gate) && session.gate.holder === holder)) { stats.dropped_not_holder++; continue; }
      const r = session.injectOwned(payload);
      if (!r.sent) { stats.refused++; continue; }
      stats.injected++;
      const forged = forgeFor(payload, { playerId: session.playerId, dims: session.attachDims });
      if (forged) { session.toClient(forged); stats.forged++; }
    }
  });
  let detached = false;
  const detach = () => {
    if (detached) return; detached = true;
    session.off('server-frame', onFrame);
    if (session.attached?.stats === stats) session.attached = null;
  };
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
      if (s.attached) { sock.end(JSON.stringify({ ok: false, why: `keeper ${s.attached.agent} is already attached` }) + '\n'); return; }
      sock.write(JSON.stringify({ ok: true, player: s.playerId }) + '\n');
      attachKeeper(s, sock, { agent: String(hello.agent), log, ...opts });
      const rest = head.subarray(nl + 1);
      if (rest.length) sock.emit('data', rest);
    };
    sock.on('data', onHead);
    sock.on('error', () => {});
  }).listen(port, '127.0.0.1', () => log(`  keeper attach on 127.0.0.1:${port}`));
}
