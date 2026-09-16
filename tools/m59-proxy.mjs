#!/usr/bin/env node
// A rewriting proxy between a real Meridian client and the server, so that a human
// can watch their own character in their own client while the broker drives it.
//
//   node tools/m59-proxy.mjs --listen 5959 --server 127.0.0.1:5959
//
// WHY THIS CANNOT BE A PASSIVE TAP
//
// The server allows ONE connection per character, so the broker and the client
// cannot both hold Varuka — whoever logs in second bumps the first. The only way to
// have both is for the client's traffic to pass through us.
//
// And a passive relay is not enough either, because every in-game packet carries an
// anti-spoof value computed from a STREAM POSITION that advances on every packet:
//
//     securityStep()  advances all five seeds and returns an index
//     security = seeds[idx] ^ len ^ (signed char)payload[0] << 4 ^ crc16(payload)
//
// The server keeps its own copy advancing in lockstep. So if we inject a single
// packet of our own, the client's next packet is computed one step behind, the
// server logs "invalid security account N", sets seeds_hacked, and drops the
// connection with no message. Injection REQUIRES that we own the stream.
//
// So: we recompute the security field on every client->server packet at the true
// position, discarding whatever the client put there. The client's value is
// irrelevant; ours is the one the server checks. Once we own the stream we can
// inject freely, and the client never knows.
//
// Two stages, and stage one is the whole point of stage one:
//   --observe   forward and rewrite, inject nothing. If a session survives a long
//               play session in this mode, the rewriting is correct.
//   (default)   the same, plus an injection queue.
//
// The login phase is NOT checksummed — the client's own send() only applies security
// once state === 'game' and the seeds have arrived — so before that we are a plain
// pipe and simply watch for the seeds going past.
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { proxyContext, serveProxyContext } from './m59-proxy-context.mjs';
import { parseRoomContents, objId } from './m59-parse.mjs';
import { writeFileSync, appendFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join as joinPath, dirname as dirnamePath } from 'node:path';
import { fileURLToPath as fileURLToPathP } from 'node:url';

const REPO_DIR = joinPath(dirnamePath(fileURLToPathP(import.meta.url)), '..');
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where the leader's live state is published for the swarm to read. Under substrate/
// because it is per-machine live state, not something to commit.
const LEADER_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'swarm-leader.json');

const HEADER = 7;                 // len(2) + security(2) + len(2) + epoch(1)

// The two opcodes that bracket the login exchange. AP_GETCHOICE carries the five
// security seeds; everything after AP_GAME is checksummed.
const AP_GETCHOICE = 22;          // server -> client, carries the five seeds
const AP_GAME      = 25;          // server -> client, "you are in game mode now"

// Game-mode opcodes, in both directions. The two SERVER->CLIENT ones are the whole
// reason this proxy can drive a view at all; see forgeMove().
const BP_REQ_MOVE = 100;          // client -> server: u16 y, u16 x, u8 speed, u32 room
const BP_REQ_TURN = 101;          // client -> server: u32 objId(self), u16 angle
const BP_REQ_GO   = 102;          // client -> server: bare opcode
const BP_SEND_ROOM_CONTENTS = 42; // client -> server: bare opcode, "tell me the room"
const BP_PLAYER   = 130;          // server -> client: u32 playerId, ... (rest unused here)
const BP_ROOM_CONTENTS = 134;     // server -> client: u32 roomId, u16 count, objects...
const BP_MOVE     = 200;          // server -> client: u32 objId, u16 y, u16 x, u8 speed
const BP_TURN     = 201;          // server -> client: u32 objId, u16 angle

// THE "CRC16" IN THIS PROTOCOL IS NOT A CRC-16.
//
// It is zlib's CRC-32 truncated to sixteen bits — `zlib.crc32(buf) & 0xffff`. I
// originally hand-wrote a genuine CCITT CRC-16 here (polynomial 0x1021) so that the
// proxy could run standalone, and that is a completely different function of the
// same bytes.
//
// It cost a long time to find because it fails in the least suggestive way possible:
// the value it produces is a plausible 16-bit number, so every packet simply
// disagreed by an arbitrary amount. That looked exactly like a stream-position error
// — which sent me hunting offsets, brute-forcing 4000 start positions, and blaming
// the seeds — when the seeds and the LCG had been correct the whole time. The
// giveaway, once measured, was that NOT ONE packet in nineteen ever agreed: a wrong
// position still lines up occasionally, a wrong hash never does.
import zlib from 'node:zlib';
const crc16 = buf => zlib.crc32(buf) & 0xffff;

// The stream. One of these per connection; it is the single source of truth for
// where in the sequence we are, and both the rewriter and the injector go through it.
class SecurityStream {
  constructor() { this.seeds = null; this.sent = 0; }

  // The five 32-bit seeds arrive in the body of AP_GETCHOICE.
  adopt(body) {
    if (body.length < 20) return false;
    this.seeds = [];
    for (let i = 0; i < 5; i++) this.seeds.push(body.readUInt32LE(i * 4));
    return true;
  }

  // Advance all five, return the index to read. The seeds are arbitrary 32-bit
  // values so the multiply genuinely overflows; doing it in doubles is exact here
  // because seed * 9301 stays under 2^45.
  step() {
    const s = this.seeds;
    for (let i = 0; i < s.length; i++)
      s[i] = ((s[i] * 9301 + 49297) % 4294967296) % 233280;
    return s[s.length - 1] % (s.length - 1);
  }

  security(payload) {
    const idx = this.step();
    let sec = this.seeds[idx] & 0xffff;
    sec ^= payload.length;
    sec ^= ((payload[0] << 24) >> 24) << 4;    // as a signed char, like the server
    sec ^= crc16(payload);
    return sec & 0xffff;
  }

  // Re-frame a payload at the current position. `epoch` is preserved from whatever
  // the client used, because it is the client's sequence number and not ours.
  frame(payload, epoch) {
    const out = Buffer.alloc(HEADER + payload.length);
    out.writeUInt16LE(payload.length, 0);
    out.writeUInt16LE(this.security(payload), 2);
    out.writeUInt16LE(payload.length, 4);
    out.writeUInt8(epoch & 0xff, 6);
    payload.copy(out, HEADER);
    this.sent++;
    return out;
  }
}

// The pre-game / server-to-client header: a plain crc16 of the payload, which is
// what the client's own frame() writes before the seeds arrive.
function plainFrame(payload, epoch) {
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt16LE(payload.length, 0);
  out.writeUInt16LE(crc16(payload), 2);
  out.writeUInt16LE(payload.length, 4);
  out.writeUInt8(epoch & 0xff, 6);
  payload.copy(out, HEADER);
  return out;
}

// Split a byte stream into frames without assuming they arrive whole.
class Framer {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk, onFrame) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < HEADER) return;
      const len = this.buf.readUInt16LE(0);
      if (this.buf.length < HEADER + len) return;
      const epoch = this.buf.readUInt8(6);
      const whole = Buffer.from(this.buf.subarray(0, HEADER + len));   // original, untouched
      const payload = whole.subarray(HEADER);
      this.buf = this.buf.subarray(HEADER + len);
      onFrame(payload, epoch, whole);
    }
  }
}

export class ProxySession extends EventEmitter {
  constructor(clientSock, { host, port, observe = false, log = () => {} }) {
    super();
    this.client = clientSock;
    this.observe = observe;
    this.log = log;
    this.stream = new SecurityStream();
    this.inGame = false;
    this.lastEpoch = 0;
    this.stats = { fromClient: 0, fromServer: 0, injected: 0, rewritten: 0 };
    // Where a human's own move requests get written down. One file per proxy run, because
    // a walk is a session and mixing two people's sessions into one trace would make the
    // step-to-step comparisons below meaningless.
    this.walkLog = ProxySession.walkLog ?? null;
    // How many times we have advanced the stream purely to stay level with the
    // server while forwarding the client's own packets untouched.
    this.shadowed = 0;
    this.compared = 0; this.aligned = 0; this.misaligned = 0;
    this.calibration = null;
    this.locked = false;       // have we solved for the server's stream position?
    this.seedSets = 0;         // how many times the server handed us seeds
    // The player's own object id, and the epoch byte the server is currently
    // stamping. Both are needed to forge a server->client packet; both are read off
    // the wire rather than assumed, for the same reason the room id is.
    this.playerId = null;
    this.serverEpoch = 0;
    this.stats.forged = 0;

    this.server = net.connect(port, host);
    const cf = new Framer(), sf = new Framer();

    this.client.on('data', d => cf.push(d, (p, e, w) => this.fromClient(p, e, w)));
    this.server.on('data', d => sf.push(d, (p, e, w) => this.fromServer(p, e, w)));

    const bye = (who) => () => { this.log(`${who} closed`); this.destroy(); };
    this.client.on('close', bye('client')); this.server.on('close', bye('server'));
    this.client.on('error', bye('client error')); this.server.on('error', bye('server error'));
  }

  // LEARN THE ROOM, POSITION AND IDENTITY FROM THE PLAYER'S OWN PACKETS.
  //
  // BP_REQ_MOVE (100) is u16 y, u16 x, u8 speed, u32 objId(room) — all of which we
  // want and none of which we can safely assume. The room's OBJECT id in particular
  // is renumbered by every `save game`, so the value in a prebuilt map goes stale
  // silently: the packet is accepted, the checksum is fine, and the character simply
  // does not move. Reading it out of a packet the client just sent is the only
  // version that cannot be wrong.
  //
  // The client addresses its own turns to itself — RequestTurn(player.id, angle),
  // clientd3d/protocol.h:105 — so a turn packet hands us the player's object id,
  // unmasked and exactly as the client holds it, which is what a forged BP_MOVE must
  // carry to be recognised as "me". BP_PLAYER carries the same value but only at
  // login and room changes, and this proxy usually attaches mid-session.
  //
  // THIS RUNS ON EVERY CLIENT PACKET, in both modes. It used to live inside the
  // passthrough branch, which meant learning stopped at the moment of the first
  // injection — precisely when the values start being used. A player who then walked
  // to another room left us injecting against the room they used to be in, and
  // BP_REQ_MOVE with the wrong room id is dropped without comment (NEXT-STEPS trap 5).
  // The symptom is the worst kind: everything reports success and nothing moves.
  // THE SWARM'S ONE SOURCE OF "WHAT IS THE LEADER FIGHTING".
  //
  // Debounced to a file rather than emitted, because the consumer is another process:
  // DUM ticks on its own clock and either side can restart. A file is the only interface
  // where neither restart loses the answer, and where a reader arriving late still gets
  // the last known target rather than nothing.
  //
  // `at` is written so a stale target can be recognised as stale. A leader that has
  // stopped swinging is a leader with no target, and a swarm that keeps piling onto a
  // corpse because the last packet said so is worse than one that stands still.
  noteLeaderTarget(target, how) {
    if (target === this.lastTarget && Date.now() - (this.lastTargetAt ?? 0) < 1000) return;
    this.lastTarget = target;
    this.lastTargetAt = Date.now();
    try {
      writeFileSync(LEADER_FILE, JSON.stringify({
        target, how, at: this.lastTargetAt,
        // `knownRoom` is the OBJECT id of the room, which is what BP_ROOM_CONTENTS carries
        // and what this proxy learns off the wire — not the room NUMBER the map speaks.
        // Named for what it is so nobody joins it to a room table by accident.
        room_object_id: this.knownRoom ?? null,
        player_object_id: this.playerId ?? null,
        note: 'written by m59-proxy from the leader\'s own REQ_ATTACK — the only place ' +
              'in the system that can see what a human is swinging at',
      }, null, 2));
    } catch { /* the swarm degrades to following without focus fire; not worth dying over */ }
  }

  learn(payload) {
    // IS THERE A HUMAN DRIVING THIS?
    //
    // A spectated character and a co-driven one are the same connection; the only
    // difference is whether the person at the keyboard is doing anything. They are
    // the only source of client-originated movement and turning — we never make the
    // client send, we forge what it receives — so a BP_REQ_MOVE or BP_REQ_TURN
    // arriving from the client IS the human, and its timestamp is how spectate mode
    // notices it should become co-operative.
    //
    // Caveat worth keeping: the client re-sends its facing on its own schedule
    // (MoveUpdateServer, move.c:739), so a lone turn is weaker evidence than a move.
    if (payload[0] === BP_REQ_MOVE || payload[0] === BP_REQ_TURN) {
      this.lastHumanInputAt = Date.now();
      if (payload[0] === BP_REQ_MOVE) this.lastHumanMoveAt = Date.now();
    }
    if (payload[0] === BP_REQ_TURN && payload.length >= 5) {
      if (this.playerId === null)
        this.log(`learned playerId=${payload.readUInt32LE(1)} from the player's own turn`);
      this.playerId = payload.readUInt32LE(1);
      this.lastAngle = payload.length >= 7 ? payload.readUInt16LE(5) : this.lastAngle;
    }
    if (payload[0] === BP_REQ_MOVE && payload.length >= 10) {
      this.lastMove = {
        y: payload.readUInt16LE(1), x: payload.readUInt16LE(3),
        speed: payload.readUInt8(5), room: payload.readUInt32LE(6),
      };
      // GROUND TRUTH ABOUT WHERE A PLAYER CAN ACTUALLY WALK, AND THERE IS NO OTHER SOURCE
      // FOR IT.
      //
      // Everything this repository believes about walkable space is a MODEL: the server's
      // one-byte-a-square grid (which is what monsters use), and our transcription of the
      // client's BSP. Both have been caught being wrong, and the only thing that settles it
      // is a person walking somewhere and us seeing the coordinates they walked to. This is
      // that: the human client's own move requests, in fine wire units, exactly as the
      // client decided them.
      //
      // It is APPEND-ONLY AND BEST-EFFORT. A failed write must never break the stream —
      // the stream is somebody playing the game, and a debugging convenience does not get
      // to interrupt it. See m59-walkcheck.mjs for the half that reads these back.
      if (this.walkLog) {
        try {
          appendFileSync(this.walkLog, JSON.stringify({
            at: Date.now(), room: this.lastMove.room,
            x: this.lastMove.x, y: this.lastMove.y, speed: this.lastMove.speed,
            col: Math.floor(this.lastMove.x / 64), row: Math.floor(this.lastMove.y / 64),
          }) + '\n');
        } catch { /* never let the recorder cost somebody their session */ }
      }
      if (this.knownRoom !== this.lastMove.room) {
        this.knownRoom = this.lastMove.room;
        this.log(`learned room objId=${this.knownRoom} from the player's move ` +
                 `(col ~${Math.floor(this.lastMove.x / 64)}, row ~${Math.floor(this.lastMove.y / 64)})`);
      }
    }
  }

  fromClient(payload, epoch, whole) {
    this.stats.fromClient++;
    this.lastEpoch = epoch;
    if (this.inGame) this.learn(payload);
    // WHAT THE OPERATOR IS SWINGING AT, READ OFF THE WIRE.
    //
    // A swarm has to know its leader's target and there is no other way to learn it: the
    // client emits no attack event a bystander could parse, the server tells observers
    // nothing about who is hitting what, and the injected agent DLL reports position only.
    // But the attack itself is a CLIENT-TO-SERVER packet and every one of them passes
    // through here — so the one place in the system that can see the target is this one.
    //
    //   REQ_ATTACK 103 / REQ_SHOOT 104: [op][info u8][target u32 LE]  (m59-client.mjs:857)
    //
    // Written to a file rather than pushed anywhere, because the reader is a different
    // process on a different clock and a file is the only interface that survives either
    // of them restarting. Position comes from the same place for the same reason.
    if (this.inGame && (payload[0] === 103 || payload[0] === 104) && payload.length >= 6) {
      this.noteLeaderTarget(payload.readUInt32LE(2), payload[0] === 104 ? 'shoot' : 'attack');
    }
    // PASSTHROUGH UNTIL WE HAVE ACTUALLY INJECTED SOMETHING.
    //
    // While we have injected nothing, the client's own security values are correct
    // by construction — it is in perfect lockstep with the server and we are just a
    // wire. Rewriting in that state can only introduce a bug, and did: recomputing
    // from the first in-game packet dropped the session immediately, which says our
    // idea of the stream position starts out wrong, not that rewriting is impossible.
    //
    // So we only take over the arithmetic once we have perturbed the stream, and
    // from then on we owe the server every value. `offset` is how far ahead of the
    // client we are, which is exactly the number of packets we have injected.
    if (!this.inGame || !this.stream.seeds || this.stats.injected === 0) {
      this.server.write(whole);
      if (this.inGame) {
        // SOLVE FOR THE STREAM RATHER THAN SEARCHING FOR IT.
        //
        // blakserv/game.c:174-180 computes, for every message it receives:
        //     security  = GameRandomStreamsStep(s)      // low 16 bits of a seed
        //     security ^= msg.len
        //     security ^= (unsigned int)msg.data[0] << 4
        //     security ^= GetCRC16(msg.data, msg.len)
        //
        // Three of those four terms are visible to us in the packet itself, and the
        // fourth is the value the client wrote. So the equation rearranges: the seed
        // the server is about to select is
        //     expected = security ^ len ^ op<<4 ^ crc16
        // which we can read off EVERY packet the client sends, without sending
        // anything ourselves. The client is in lockstep with the server by
        // construction, so this is ground truth, continuously.
        //
        // That turns calibration from a search into a measurement. We step our copy
        // until the seed it selects matches what the client's packet implies, and
        // from then on we are the server's peer rather than its guess.
        //
        // It matters that this costs nothing to get wrong: game.c:184 latches
        // `seeds_hacked` on the FIRST bad value and hangs up, so there is exactly one
        // attempt per session. Measuring instead of guessing is the only approach
        // that does not spend it.
        const theirs = whole.readUInt16LE(2);
        const expected = (theirs ^ payload.length ^
                          ((((payload[0] << 24) >> 24) << 4) & 0xffff) ^
                          crc16(payload)) & 0xffff;

        if (!this.locked) {
          // Step until our selected seed is the one the client's packet implies.
          let found = -1;
          const probe = new SecurityStream();
          probe.seeds = this.stream.seeds.slice();
          for (let k = 0; k < 4000; k++) {
            const idx = probe.step();
            if ((probe.seeds[idx] & 0xffff) === expected) { found = k; break; }
          }
          if (found >= 0) {
            for (let j = 0; j <= found; j++) this.stream.step();
            this.locked = true;
            this.log(`stream LOCKED after ${found} catch-up step(s) — ` +
                     `selected seed now matches what the client's packets imply`);
          } else if (this.compared === 0) {
            this.log(`could not lock: no seed within 4000 steps has low bits 0x${expected.toString(16)}`);
          }
          this.compared++;
          return;                        // this packet's step was consumed by the lock
        }

        // Locked: step once and verify we are still the server's peer. Drifting is a
        // bug we want to hear about immediately, not discover by being hung up on.
        const idx = this.stream.step();
        const ours = this.stream.seeds[idx] & 0xffff;
        if (ours === expected) this.aligned++;
        else {
          this.misaligned++;
          if (this.misaligned < 4) this.log(`DRIFTED: expected 0x${expected.toString(16)} got 0x${ours.toString(16)}`);
        }
        this.shadowed++;

        return;
      }
      return;
    }
    this.stats.rewritten++;
    this.server.write(this.stream.frame(payload, epoch));
    this.emit('client-packet', payload);
  }

  fromServer(payload, epoch, whole) {
    this.stats.fromServer++;
    // The client keeps the epoch byte of the LAST server message and stamps it on
    // everything it sends (clientd3d/com.c:409-410). So anything we forge towards the
    // client must carry the epoch the server is currently using — otherwise we would
    // be changing what the client echoes back, which is the server's own sequencing
    // and none of our business.
    this.serverEpoch = epoch;
    // BP_PLAYER announces who we are. The kod builds it as
    //     AddPacket(1,BP_PLAYER, 4,self, 4,vrIcon, 4,vrName, 4,poOwner)
    // (user.kod:2471), so on paper the room is a fixed 4 bytes in at offset 13.
    //
    // ONLY THE FIRST FIELD IS SAFE TO READ. Reading the room at offset 13 returned
    // 1852797541 for a live session whose room was really object 484 — and
    // 1852797541 is 0x6E6F7265, the ASCII bytes "eron", i.e. the tail of the
    // character's name "Theron". A player's name is a DYNAMIC resource (>= 1,000,000,
    // NEXT-STEPS "How do names resolve?") and does not travel as a plain 4-byte id
    // here, so every offset past it slides by an amount that depends on the name.
    // It happened to read correctly for a character whose name resource behaved, and
    // that near miss is the dangerous part: a stale or garbage room id makes
    // BP_REQ_MOVE get dropped in silence (NEXT-STEPS trap 5).
    //
    // The room therefore comes only from the client's own BP_REQ_MOVE, which is what
    // learn() does and what the original design got right.
    if (this.inGame && payload[0] === BP_PLAYER && payload.length >= 5 &&
        this.playerId === null) {
      this.playerId = payload.readUInt32LE(1);
      this.log(`learned playerId=${this.playerId} from BP_PLAYER`);
    }

    // THE ROOM AND POSITION, WITHOUT ASKING A HUMAN TO WALK.
    //
    // Learning from the player's own BP_REQ_MOVE is authoritative but it only
    // arrives once they actually move far enough to report — MOVE_THRESHOLD is a
    // quarter square and MOVE_INTERVAL a whole second (move.c:57-58), so a client
    // that has just connected and is standing still has told us nothing at all. That
    // is fatal for attaching to a session on demand: the thing we most need to know
    // is unavailable exactly when we need it.
    //
    // BP_ROOM_CONTENTS carries the room id in its first four bytes and every object
    // in the room with its coordinates, including the player's own — and the server
    // sends it unprompted on entering a room, which includes logging in. So this
    // costs nothing, needs no injection, and re-establishes the truth on every room
    // change, which is also what makes chained room-to-room driving possible.
    if (this.inGame && payload[0] === BP_ROOM_CONTENTS) {
      try {
        const rc = parseRoomContents(payload.subarray(1));
        // `exact` is the invariant from HandleRoomContents: with a packed stream and
        // no per-object length, a desynchronised cursor produces plausible garbage,
        // so a parse that does not land exactly on the end is not evidence of
        // anything and must not be acted on.
        if (rc.exact) {
          // OBSERVED, as distinct from BELIEVED. `knownRoom` can be seeded by a
          // caller that is about to drive somewhere; `serverRoom` is only ever set
          // here, from a message the server actually sent. Keeping them apart is what
          // lets a driver tell a real arrival from its own optimism — and it fixes a
          // logging blind spot, since this line used to be suppressed whenever the
          // seed had already set knownRoom to the same value, i.e. exactly when a
          // confirmation was most wanted.
          if (this.serverRoom !== rc.roomId)
            this.log(`room is objId=${rc.roomId} (${rc.count} objects, from BP_ROOM_CONTENTS)`);
          this.serverRoom = rc.roomId;
          this.serverRoomAt = Date.now();
          this.knownRoom = rc.roomId;
          const me = this.playerId !== null
            ? rc.objects.find(o => o.id === objId(this.playerId)) : null;
          if (me) {
            this.lastMove = { y: me.y, x: me.x,
                              speed: this.lastMove?.speed ?? 18, room: rc.roomId };
            this.lastAngle = me.angle;
            this.log(`position row ${me.row}, col ${me.col} from the room contents`);
          }
        } else {
          // Dump the bytes. A count of 7204 is not a bad object, it is a header read
          // at the wrong offset — so the question is what this message actually is,
          // and only the payload can answer that.
          this.log(`room contents did not parse exactly (${rc.error ?? rc.leftover + 'b left'}) ` +
                   `— ignored. len=${payload.length} hex=${payload.subarray(0, 48).toString('hex')}`);
        }
      } catch (e) { this.log(`room contents parse threw: ${e.message}`); }
    }
    // Grab the seeds on their way past. This is the only chance: the server sends
    // them once, in the login handshake, and never again.
    // DISPATCH ON STATE, NOT ON THE BYTE. The AP_* and BP_* opcode spaces overlap:
    // AP_GETCHOICE and BP_UNWAIT are both 22, AP_GAME and BP_* collide likewise. Only
    // before game mode does 22 mean "here are your seeds".
    //
    // And re-read them EVERY time, exactly as the client does. The server sends
    // GETCHOICE more than once across the login exchange, the client keeps the last
    // set, and latching the first left us computing against seeds that had been
    // superseded — which is why no start position could ever reproduce its value.
    if (!this.inGame && payload[0] === AP_GETCHOICE) {
      const body = payload.subarray(1);
      if (this.stream.adopt(body)) {
        this.log(`seeds #${++this.seedSets} = [${this.stream.seeds.join(', ')}]  ` +
                 `from ${body.length}b body: ${body.subarray(0, 24).toString('hex')}`);
      }
    }
    // The SERVER decides when game mode begins, not the client — the client asks
    // with AP_REQ_GAME and the server answers AP_GAME. Watching for the request
    // instead would start rewriting one exchange too early.
    if (!this.inGame && payload[0] === AP_GAME) {
      this.inGame = true;
      // THE CLIENT IS ALREADY THREE STEPS IN BY THE TIME LOGIN FINISHES.
      //
      // Dumping the raw seeds off the wire and the client's own array immediately
      // after login() showed the client's values are exactly three LCG steps ahead:
      //   wire   [3571238106, 184153256, 462, 697447458, 184166115]
      //   client [91729, 206919, 18933, 178169, 138598]   == step(step(step(wire)))
      // So the client sends three in-game packets as part of finishing login, before
      // anything we would recognise as gameplay. Starting our copy at zero leaves us
      // three behind for the whole session, which is why every computed value
      // diverged and why no injection was ever accepted.
      const catchUp = Number(process.env.M59_STREAM_PRESTEP ?? 0);
      for (let i = 0; i < catchUp; i++) this.stream.step();
      this.presteps = catchUp;
      this.log(`server confirmed game mode — stream pre-stepped ${catchUp}`);
    }
    // Server -> client: forward the ORIGINAL bytes. Rebuilding them can only
    // introduce differences, and the client is entitled to exactly what the server
    // said.
    this.client.write(whole);
    this.emit('server-packet', payload);
  }

  // Send a packet AS the player. Only legal once we own the stream.
  inject(payload) {
    if (this.observe) return { sent: false, why: 'observe mode — injection disabled' };
    if (!this.inGame || !this.stream.seeds) return { sent: false, why: 'not in game yet' };
    this.server.write(this.stream.frame(Buffer.from(payload), this.lastEpoch));
    this.stats.injected++;
    return { sent: true, stream_position: this.shadowed + this.stats.rewritten + this.stats.injected };
  }

  // FORGE A PACKET TOWARDS THE CLIENT.
  //
  // This direction is unauthenticated and, as it turns out, unchecked: the client
  // reads len/crc/len/epoch, verifies only that the two lengths agree, and its CRC
  // check is compiled out entirely — `#if 0` around clientd3d/com.c:433. We compute
  // the CRC correctly anyway (it costs nothing and the #if 0 could come back).
  toClient(payload) {
    this.client.write(plainFrame(Buffer.from(payload), this.serverEpoch));
    this.stats.forged++;
  }

  // MOVE THE PLAYER ON THEIR OWN SCREEN.
  //
  // The received wisdom — and the previous version of the handoff note — was that
  // movement is client-authoritative and therefore undrivable: an injected
  // BP_REQ_MOVE relocates the character for everyone ELSE while the owner's client
  // keeps drawing wherever it thinks it is. That is a true description of what the
  // SERVER does, and a false description of what the CLIENT can do.
  //
  // clientd3d/moveobj.c:86 has an explicit branch:
  //
  //     /* Player moves specially */
  //     if (object_id == player.id)
  //     {
  //        player.x = x; player.y = y;
  //        r->motion.x = x; r->motion.y = y;
  //        RoomObjectSetHeight(r);
  //        ServerMovedPlayer();
  //        return;          // "Don't interpolate or animate our own motion"
  //     }
  //
  // So the client will happily relocate the player's own view on command. It simply
  // never receives the command, because Room.SomethingMoved builds the broadcast for
  // everyone except the mover. The mover is the one participant the server assumes
  // already knows.
  //
  // We are in the middle of both directions, so we can be the one to tell it. A step
  // is therefore TWO packets that must agree:
  //
  //     -> server   BP_REQ_MOVE   so the world, and every other player, moves us
  //     -> client   BP_MOVE       so the owner's own screen moves too
  //
  // and ServerMovedPlayer() sets server_x/server_y to the new position, so the client
  // considers the server already informed and does not argue (move.c:719-734).
  //
  // Coordinates are identical in both messages: kod fine units with + KOD_FINENESS.
  // Client->server writes them y-then-x (protocol.h:74), and ExtractCoordinates reads
  // them y-then-x too (server.c:176-184), so the value is simply mirrored.
  // `forge` exists because the two halves of a step are not always both safe.
  //
  // Leaving a room means walking onto a square OUTSIDE piRows/piCols — that is the
  // mechanism, and the server handles it fine. The CLIENT does not: it indexes its
  // current room's grid with whatever coordinates we hand it, so an out-of-bounds
  // square reads past the end of a fixed-size array. Two crash dumps from this,
  // both ACCESS_VIOLATION reading the same global address (0x994000) from different
  // call sites, which is the signature of exactly that.
  //
  // So: tell the SERVER about a move that leaves the room, and let the room-change
  // burst it sends back be what moves the client. Never forge a square the client's
  // current room cannot contain.
  step({ y, x, speed, turnToFace = true, forge = true }) {
    if (this.observe) return { ok: false, why: 'observe mode — injection disabled' };
    if (!this.inGame || !this.stream.seeds) return { ok: false, why: 'not in game yet' };
    if (!this.knownRoom) return { ok: false, why: 'room id not learned yet — move once in the client' };
    if (this.playerId === null) return { ok: false, why: 'player object id not learned yet — turn once in the client' };

    const req = Buffer.alloc(11);
    req.writeUInt8(BP_REQ_MOVE, 0);
    req.writeUInt16LE(y, 1); req.writeUInt16LE(x, 3);
    req.writeUInt8(speed, 5); req.writeUInt32LE(this.knownRoom, 6);
    this.inject(req);

    // The high bit of speed asks the client to turn the object to face the direction
    // of travel (server.c:698-702). Harmless for the player and it looks right.
    if (forge) {
      const mv = Buffer.alloc(10);
      mv.writeUInt8(BP_MOVE, 0);
      mv.writeUInt32LE(this.playerId, 1);
      mv.writeUInt16LE(y, 5); mv.writeUInt16LE(x, 7);
      mv.writeUInt8(turnToFace ? (speed | 0x80) : speed, 9);
      this.toClient(mv);
    }

    this.lastMove = { ...(this.lastMove ?? {}), y, x, speed, room: this.knownRoom };
    return { ok: true, y, x, speed, room: this.knownRoom, player: this.playerId };
  }

  // Same trick for facing: BP_REQ_TURN tells the world, BP_TURN tells the owner's
  // client, which sets player.angle when the id is its own (game.c:428-429).
  turn(angle) {
    if (this.observe) return { ok: false, why: 'observe mode — injection disabled' };
    if (this.playerId === null) return { ok: false, why: 'player object id not learned yet' };
    const a = angle & 0xfff;                     // angles are 0..4095

    const req = Buffer.alloc(7);
    req.writeUInt8(BP_REQ_TURN, 0);
    req.writeUInt32LE(this.playerId, 1); req.writeUInt16LE(a, 5);
    this.inject(req);

    const t = Buffer.alloc(7);
    t.writeUInt8(BP_TURN, 0);
    t.writeUInt32LE(this.playerId, 1); t.writeUInt16LE(a, 5);
    this.toClient(t);
    return { ok: true, angle: a, player: this.playerId };
  }

  status() {
    return { in_game: this.inGame, have_seeds: !!this.stream.seeds,
             player_id: this.playerId,
             observe: this.observe, ...this.stats, shadowed: this.shadowed,
             aligned: this.aligned, misaligned: this.misaligned, locked: this.locked,
             known_room: this.knownRoom ?? null, last_move: this.lastMove ?? null,
             // What the SERVER said, never a seed. A driver should trust this one.
             server_room: this.serverRoom ?? null,
             server_room_ms_ago: this.serverRoomAt ? Date.now() - this.serverRoomAt : null,
             human_move_ms_ago: this.lastHumanMoveAt ? Date.now() - this.lastHumanMoveAt : null,
             human_driving: !!(this.lastHumanMoveAt && Date.now() - this.lastHumanMoveAt < 5000),
             owning_stream: this.stats.injected > 0 };
  }

  destroy() {
    try { this.client.destroy(); } catch {}
    try { this.server.destroy(); } catch {}
    this.emit('closed', this.stats);
  }
}

// A control channel, so a live session can actually be driven from outside.
// Deliberately loopback-only: it can send arbitrary packets as the player.
function serveControl(port, getSession) {
  http.createServer(async (req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' });
                                res.end(JSON.stringify(o)); };
    const url = new URL(req.url, 'http://127.0.0.1');
    // ADDRESS A SESSION EXPLICITLY WHEN THERE IS MORE THAN ONE.
    //
    // The proxy used to hold a single `current` session, meaning whichever client
    // connected most recently. That is fine with one client and actively dangerous
    // with two: a command aimed at an agent silently lands on the human whose client
    // happened to reconnect, and the only symptom is that the wrong character moves.
    // `?player=<objId>` picks by the id learned from BP_PLAYER; the default is still
    // the newest session, which is what a single-client setup wants.
    const want = url.searchParams.get('player');
    const s = getSession(want ? Number(want) : null);
    if (url.pathname === '/status')
      return send(200, { ...(s ? s.status() : { session: null }),
                         sessions: getSession('list') });
    if (req.method !== 'POST') return send(405, { error: 'POST /inject|/move|/walk|/turn|/go' });
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      if (!s) return send(409, { error: want ? `no session for player ${want}` : 'no client is connected' });
      let msg = {};
      if (body.trim()) { try { msg = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); } }

      // SEEDING THE TRUTH FROM OUT OF BAND.
      //
      // The room and position are learned from the player's own BP_REQ_MOVE, which is
      // authoritative but only arrives once they actually walk — a client that has
      // just connected and stood still has told us nothing. The admin socket knows
      // both exactly (`send object <id> GetOwner` / `GetRow` / `GetCol`), so a caller
      // that has checked can hand them over instead of waiting.
      if (msg.room != null) s.knownRoom = msg.room;
      if (msg.at)
        s.lastMove = { y: msg.at.y, x: msg.at.x,
                       speed: msg.at.speed ?? s.lastMove?.speed ?? 18, room: s.knownRoom };

      // A square is KOD_FINENESS = 64 fine units (clientd3d/drawdefs.h:52). Relative
      // steps are taken from the player's own last position, which sidesteps the
      // +KOD_FINENESS base offset entirely — we never have to know it.
      const SQUARE = 64;
      const target = () => {
        const base = s.lastMove;
        if (msg.y != null && msg.x != null) return { y: msg.y, x: msg.x };
        if (!base) return null;
        return { y: base.y + Math.round((msg.drow ?? 0) * SQUARE),
                 x: base.x + Math.round((msg.dcol ?? 0) * SQUARE) };
      };
      const speed = () => msg.speed ?? s.lastMove?.speed ?? 18;

      // Update what the proxy BELIEVES without sending anything. After a room change
      // the caller knows the destination and arrival square before we hear about it,
      // and needs to say so — but saying so must not be a move. Folding that into
      // /move meant every room transition was followed by a real step into the new
      // room's coordinates, which the client was still rendering the old room for.
      if (url.pathname === '/seed')
        return send(200, { seeded: { room: s.knownRoom, at: s.lastMove }, status: s.status() });

      if (url.pathname === '/move') {
        const t = target();
        if (!t) return send(409, { error: 'no position known yet — move once in the client' });
        return send(200, { ...s.step({ ...t, speed: speed(), forge: msg.forge !== false }),
                           status: s.status() });
      }

      if (url.pathname === '/walk') {
        const steps = Math.max(1, Math.min(64, msg.steps ?? 1));
        const interval = Math.max(50, msg.interval ?? 250);
        const results = [];
        for (let i = 0; i < steps; i++) {
          const t = target();
          if (!t) return send(409, { error: 'no position known yet' });
          const r = s.step({ ...t, speed: speed() });
          results.push(r);
          if (!r.ok) break;
          if (i < steps - 1) await new Promise(res => setTimeout(res, interval));
        }
        return send(200, { steps: results, status: s.status() });
      }

      if (url.pathname === '/turn') {
        if (msg.angle == null) return send(400, { error: 'need angle 0..4095' });
        return send(200, { ...s.turn(msg.angle), status: s.status() });
      }

      if (url.pathname === '/go')
        return send(200, { ...s.inject(Buffer.from([BP_REQ_GO])), status: s.status() });

      // Raw escape hatches. /inject speaks to the server as the player; /toclient
      // speaks to the client as the server.
      const hex = msg.hex ?? ((msg.op != null)
        ? msg.op.toString(16).padStart(2, '0') + (msg.args || '') : null);
      if (!hex) return send(400, { error: 'need hex or op' });
      if (url.pathname === '/toclient') {
        s.toClient(Buffer.from(hex, 'hex'));
        return send(200, { forged: true, status: s.status() });
      }
      send(200, { ...s.inject(Buffer.from(hex, 'hex')), status: s.status() });
    });
  }).listen(port, '127.0.0.1', () => console.error(`  control on http://127.0.0.1:${port}`));
}

export function serveProxy({ listen = 5960, host = '127.0.0.1', port = 5959,
                             observe = false, control = null, onSession = () => {},
                             listenHost = '0.0.0.0', contextPort = null } = {}) {
  if(contextPort!==null && (!observe || control))throw Error('native context requires observe-only with no injection control');
  const context=contextPort!==null?proxyContext({host,port,listen}):null;
  let current = null;
  const sessions = new Set();
  // 'list' is a peek for /status; a number selects by the player object id the
  // session learned from BP_PLAYER; null means "the newest", the single-client case.
  const pick = (sel) => {
    if (sel === 'list')
      return [...sessions].map(s => ({ player_id: s.playerId, known_room: s.knownRoom,
                                       in_game: s.inGame, current: s === current }));
    if (sel == null) return current;
    return [...sessions].find(s => s.playerId === sel) ?? null;
  };
  if (control) serveControl(control, pick);
  // RECORD WHERE A HUMAN ACTUALLY WALKS. One file per proxy run — see the note on
  // `walkLog` in the session. `--no-walklog` turns it off; it is on by default because
  // the trace is the only ground truth this repository has about walkable space, and the
  // one thing guaranteed to lose it is having to remember to switch it on.
  if (!process.argv.includes('--no-walklog')) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'substrate', 'walks');
    try {
      mkdirSync(dir, { recursive: true });
      ProxySession.walkLog = join(dir, `walk-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      console.error(`recording the player's own moves to ${ProxySession.walkLog}`);
    } catch (e) { console.error(`could not open a walk log (${e.message}) — carrying on without one`); }
  }
  const server = net.createServer(sock => {
    const tag = `${sock.remoteAddress}:${sock.remotePort}`;
    const log = (m) => console.error(`[proxy ${tag}] ${m}`);
    log('client connected');
    const s = new ProxySession(sock, { host, port, observe, log });
    if(context)try{context.attach(s);}catch{s.destroy();return;}
    current = s;
    sessions.add(s);
    s.on('closed', st => {
      sessions.delete(s);
      if (current === s) current = [...sessions].at(-1) ?? null;
      log(`closed — ${JSON.stringify(st)}`);
    });
    onSession(s);
  });
  server.listen(listen, listenHost, () =>
    console.error(`m59 proxy listening on ${listenHost}:${listen} -> ${host}:${port}` +
                  (observe ? '  [OBSERVE ONLY — no injection]' : '')));
  if(context){server.contextServer=serveProxyContext(context,contextPort);server.once('close',()=>{context.close();server.contextServer.closeAllConnections();server.contextServer.close();});}
  return server;
}

if (process.argv[1]?.endsWith('m59-proxy.mjs')) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const [h, p] = String(arg('--server', '127.0.0.1:5959')).split(':');
  const listen = Number(arg('--listen', 5960));
  const host = h, port = Number(p || 5959);

  // SAY WHAT THIS PROXY FRONTS, so a client launcher can find the right one by itself.
  //
  // "A proxy is listening on 5961" is not the same fact as "a proxy for the server this
  // character belongs to". Two fleets on this machine already sit on two different servers,
  // and pointing a client through the proxy for the wrong one logs it into the wrong world —
  // quietly, because the client cannot tell. So the endpoint is published rather than
  // assumed, and m59-devclient.mjs matches on it.
  //
  // The pid is in the file for the same reason the broker's is: a file outlives the process
  // that wrote it, and a reader has to be able to tell a live proxy from a leftover.
  try {
    const advert = joinPath(REPO_DIR, 'substrate', 'proxies', String(listen) + '.json');
    mkdirSync(dirnamePath(advert), { recursive: true });
    writeFileSync(advert, JSON.stringify({
      listen, server: { host, port }, pid: process.pid, at: Date.now(),
    }, null, 1));
    const drop = () => { try { unlinkSync(advert); } catch { /* already gone */ } };
    process.on('exit', drop);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { drop(); process.exit(0); });
  } catch { /* an unadvertised proxy still works; it just cannot be found automatically */ }

  serveProxy({
    listen, host, port,
    observe: process.argv.includes('--observe'),
    control: arg('--control') ? Number(arg('--control')) : null,
    listenHost: arg('--bind','0.0.0.0'),
    contextPort: arg('--context-port') ? Number(arg('--context-port')) : null,
  });
}
