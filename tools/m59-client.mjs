#!/usr/bin/env node
// A headless Meridian 59 protocol client.
//
//   node tools/m59-client.mjs <username> <password> [host] [port]
//
// Foundation for letting arbitrary agents play as real player characters. It logs
// in over the game port exactly as meridian.exe does, so an agent driven through
// it holds a genuine session: its caller validates movement like the real client, it perceives
// only what a player would perceive, and it can connect from anywhere. That is
// strictly better than driving a body over the admin socket, which has no
// session, bypasses game rules, and must stay bound to loopback.
//
// Everything here is derived from this repository, not guessed:
//   doc/login.txt         the handshake, byte for byte
//   doc/protocol.txt      framing, and <string> = 2-byte length + bytes
//   include/proto.h       AP_* opcodes
//   clientd3d/server.h    HEADER_SIZE = 2*LENBYTES + CRCBYTES + 1 = 7
//   clientd3d/client.h    MAJOR_REV 7, MINOR_REV 37
//   blakserv/session.c    GetCRC16BufferList: CRC32, truncated to 16 bits

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { recordSeen } from './m59-trails.mjs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { loadResources } from './m59-rsc.mjs';
import {
  Reader, objId, MAX_ANGLE, KOD_FINENESS, OF,
  parseRoomContents, parseCreate, parseRemove, parseMove, parseTurn, parseChange,
  parseObjectList, parseObjectContents, parsePlayers, parsePlayerAdd,
  parseChangeResource, parsePlayer, parseBuyList, parseStringMessage, parseSaid,
  parseLook, parseLookPlayer, parseStat, parseStatGroup, parseSpells, parseSkills,
  parseGuildInfo, parseGuildAsk, parseGuildList, parseGuildHalls,
  parseOffer, parseOfferItems, parseInventoryAdd, encodeIdList, describeObject,
  parseUseList, parseObjectId, affordances, STAT_GROUP,
  parseAddEnchantment, parseRemoveEnchantment,
} from './m59-parse.mjs';

export { OF, KOD_FINENESS };

export const AP = {
  PING: 1, LOGIN: 2, REGISTER: 3, REQ_GAME: 4, REQ_ADMIN: 5, RESYNC: 6,
  GETLOGIN: 21, GETCHOICE: 22, LOGINOK: 23, LOGINFAILED: 24, GAME: 25,
  ADMIN: 26, ACCOUNTUSED: 27, TOOMANYLOGINS: 28, TIMEOUT: 29, CREDITS: 30,
  MESSAGE: 34, NOCHARACTERS: 37, GUEST: 38,
};
const APNAME = Object.fromEntries(Object.entries(AP).map(([k, v]) => [v, k]));

// Game-mode opcodes, include/proto.h. Client->server are requests; server->client
// are the world describing itself.
export const BP = {
  // low level
  ECHO_PING: 1, RESYNC: 2, PING: 3, ROUNDTRIP1: 4, ROUNDTRIP2: 5, SYSTEM: 6,
  LOGOFF: 20, WAIT: 21, UNWAIT: 22,
  CHANGE_RESOURCE: 30, SYS_MESSAGE: 31, MESSAGE: 32,
  // requests
  SEND_PLAYER: 40, SEND_STATS: 41, SEND_ROOM_CONTENTS: 42, SEND_OBJECT_CONTENTS: 43,
  SEND_PLAYERS: 44, SEND_CHARACTERS: 45, USE_CHARACTER: 46,
  DELETE_CHARACTER: 47, NEW_CHARINFO: 48, SEND_CHARINFO: 49,
  CHARINFO_OK: 56, CHARINFO_NOT_OK: 57, CHARINFO: 140,
  // include/proto.h: BP_CHANGE_PASSWORD = 23, and the two replies to it. The ordinary
  // client offers this on its account menu, so it is the normal port and needs no
  // maintenance socket — which matters when the server belongs to somebody else.
  CHANGE_PASSWORD: 23, PASSWORD_OK: 160, PASSWORD_NOT_OK: 161,
  SEND_SPELLS: 50, SEND_SKILLS: 51, SEND_STAT_GROUPS: 52, SEND_ENCHANTMENTS: 53,
  REQ_QUIT: 54,
  LOAD_MODULE: 58, UNLOAD_MODULE: 59,
  ACTION: 90,
  REQ_MOVE: 100, REQ_TURN: 101, REQ_GO: 102, REQ_ATTACK: 103, REQ_SHOOT: 104,
  REQ_CAST: 105, REQ_USE: 106, REQ_UNUSE: 107, REQ_APPLY: 108, REQ_ACTIVATE: 109,
  SAY_TO: 110, SAY_GROUP: 111,
  REQ_PUT: 112, REQ_GET: 113, REQ_GIVE: 114, REQ_TAKE: 115,
  REQ_LOOK: 116, REQ_INVENTORY: 117, REQ_DROP: 118, REQ_HIDE: 119,
  REQ_OFFER: 120, ACCEPT_OFFER: 121, CANCEL_OFFER: 122, REQ_COUNTEROFFER: 123,
  REQ_BUY: 124, REQ_BUY_ITEMS: 125, CHANGE_DESCRIPTION: 126,
  REQ_DEPOSIT: 230, WITHDRAWAL_LIST: 231, REQ_WITHDRAWAL: 232,
  REQ_WITHDRAWAL_ITEMS: 233,
  // world state
  PLAYER: 130, STAT: 131, STAT_GROUP: 132, STAT_GROUPS: 133,
  ROOM_CONTENTS: 134, OBJECT_CONTENTS: 135, PLAYERS: 136,
  PLAYER_ADD: 137, PLAYER_REMOVE: 138, CHARACTERS: 139, CHARINFO: 140,
  SPELLS: 141, SPELL_ADD: 142, SPELL_REMOVE: 143,
  SKILLS: 144, SKILL_ADD: 145, SKILL_REMOVE: 146,
  ADD_ENCHANTMENT: 147, REMOVE_ENCHANTMENT: 148,
  QUIT: 149, BACKGROUND: 150,
  // THE SUN AND THE MOON. Pushed to every logged-on user on every game hour — five real
  // minutes — by sun.kod:44 and moon.kod:89, and never parsed here until now, which is
  // the third time this repository has found a whole fact arriving and being dropped
  // because nothing looked at the opcode. The sun's angle IS the game hour.
  ADD_BG_OVERLAY: 152, REMOVE_BG_OVERLAY: 153, CHANGE_BG_OVERLAY: 154,
  USERCOMMAND: 155,
  MOVE: 200, TURN: 201, SHOOT: 202, USE: 203, UNUSE: 204, USE_LIST: 205,
  SAID: 206, LOOK: 207, INVENTORY: 208, INVENTORY_ADD: 209, INVENTORY_REMOVE: 210,
  OFFER: 211, OFFER_CANCELED: 212, OFFERED: 213,
  COUNTEROFFER: 214, COUNTEROFFERED: 215,
  BUY_LIST: 216, CREATE: 217, REMOVE: 218, CHANGE: 219,
  LIGHT_AMBIENT: 220, SECTOR_MOVE: 223, SECTOR_LIGHT: 224,
  WALL_ANIMATE: 225, SECTOR_ANIMATE: 226, CHANGE_TEXTURE: 227,
  INVALIDATE_DATA: 228,
};
export const BPNAME = Object.fromEntries(Object.entries(BP).map(([k, v]) => [v, k]));

// BP_USERCOMMAND sub-opcodes, include/proto.h:222. A whole second command space
// reached through one opcode, holding the things the real client's slash commands
// do — resting, safety toggling, banking, guild administration.
export const UC = {
  SEND_QUIT: 1, LOOK_PLAYER: 2, CHANGE_URL: 3, SPELL_SCHOOLS: 4,
  REST: 5, STAND: 6, SAFETY: 7, SUICIDE: 8,
  REQ_GUILDINFO: 10, GUILDINFO: 11, INVITE: 12, EXILE: 13, RENOUNCE: 14,
  ABDICATE: 15, VOTE: 16, SET_RANK: 17, GUILD_ASK: 18, GUILD_CREATE: 19,
  DISBAND: 20, REQ_GUILD_LIST: 21, GUILD_LIST: 22,
  MAKE_ALLIANCE: 23, END_ALLIANCE: 24, MAKE_ENEMY: 25, END_ENEMY: 26,
  GUILD_HALLS: 27, ABANDON_GUILD_HALL: 28, GUILD_RENT: 29,
  GUILD_SET_PASSWORD: 30, GUILD_SHIELD: 31, GUILD_SHIELDS: 32, CLAIM_SHIELD: 33,
  DEPOSIT: 35, WITHDRAW: 36, BALANCE: 37,
  APPEAL: 40, REQ_RESCUE: 41,
};

// include/proto.h
const SIZE_ID = 4, SIZE_LIST_LEN = 2, SIZE_STRING_LEN = 2, SIZE_AMOUNT = 4;

// kod/include/blakston.khd
const SAY_NAME = { 1:'say', 2:'yell', 3:'broadcast', 4:'group', 5:'resource',
                   6:'emote', 7:'message', 8:'group-one', 9:'dm', 10:'guild' };

// WHICH OF THOSE IS A PERSON TALKING. The chat stream carries these and nothing else.
//
// The two left out are the ones where the server is speaking through an object rather
// than a player relaying words: SAY_RESOURCE (5) is a canned resource string and
// SAY_MESSAGE (7) is prose. Both arrive on the same opcode as speech and read like it,
// which is exactly why they have to be excluded by number here — the untrusted-input
// banner on the chat tools means "a player wrote this", and it stops meaning anything
// the moment server narration is filed under it.
//
// SAY_DM (9) stays in. An admin talking to you is a person talking to you, and a
// transcript that silently drops the one channel that can order a character about
// would be missing the most important line in it.
const IS_SPEECH = new Set([1, 2, 3, 4, 6, 8, 9, 10]);

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u16b = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const u8b = n => Buffer.from([n & 0xff]);


const MAJOR_REV = 7, MINOR_REV = 37;
const P_CATCH = 3;                // clientd3d/client.h:68
const HEADER = 7;                 // len(2) + crc(2) + len(2) + seqno(1)

const crc16 = buf => zlib.crc32(buf) & 0xffff;

function pbuf(b) {
  const out = Buffer.alloc(2 + b.length);
  out.writeUInt16LE(b.length, 0);
  b.copy(out, 2);
  return out;
}
const pstr = s => pbuf(Buffer.from(s, 'latin1'));

// A {2, LIST_INT_PARM} / {2, LIST_RSC_PARM} argument: a 2-byte count then one
// 4-byte value each. parsecli.c:327 walks the elements BACKWARDS and Cons's each
// onto the front, so what arrives in kod is in the order written here.
function encodeIntList(values) {
  const head = Buffer.alloc(2);
  head.writeUInt16LE(values.length, 0);
  const body = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => body.writeInt32LE(v | 0, i * 4));
  return Buffer.concat([head, body]);
}

// The password never crosses the wire in plaintext. clientd3d/login.c calls
// MDString, which is MD5 into a 16-byte digest (ENCRYPT_LEN, include/md5.h) —
// and then, crucially, util/md5.c rewrites every 0x00 byte to 0x01 so the digest
// survives being handled as a C string. Miss that and roughly one login in
// sixteen fails for no visible reason.
function mdpass(pw) {
  const d = crypto.createHash('md5').update(Buffer.from(pw, 'latin1')).digest();
  for (let i = 0; i < d.length; i++) if (d[i] === 0) d[i] = 1;
  return d;
}

function frame(payload, seqno = 0) {
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt16LE(payload.length, 0);
  out.writeUInt16LE(crc16(payload), 2);
  out.writeUInt16LE(payload.length, 4);
  out.writeUInt8(seqno & 0xff, 6);
  payload.copy(out, HEADER);
  return out;
}

// doc/login.txt, verbatim.
const HELLO   = Buffer.from([1, 255, 66, 76, 65, 75, 10, 13, 2]);
const EXPECT  = Buffer.from([3, 251, 98, 108, 97, 107, 10, 13, 1]);
const CONFIRM = Buffer.from([7, 230, 98, 108, 97, 107, 10, 13, 8]);

// 36 bytes: os id, os major, os minor, memory, cpu id, width, height, 12 reserved.
function sysinfo() {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(2, 0);
  b.writeUInt32LE(10, 4);
  b.writeUInt32LE(0, 8);
  b.writeUInt32LE(4096, 12);
  b.writeUInt32LE(586, 16);
  b.writeUInt16LE(1024, 20);
  b.writeUInt16LE(768, 22);
  return b;
}

// HOW LONG A ROOM ANIMATION MAKES THE BAKED COLLISION SNAPSHOT UNTRUSTWORTHY.
//
// Long enough to cover a sector or wall program in flight; short enough that it can never
// become a cage. The refusal it drives is the right one — the stock client mutates its BSP
// on these packets and we cannot — but the first version never expired, and a flag cleared
// ONLY by a room change, gating the movement needed to change rooms, is a deadlock. Three
// characters were caught in one within ten minutes of it shipping.
const COLLISION_ANIMATION_MS = Number(process.env.M59_COLLISION_ANIMATION_MS || 8000);

// The tick loop declares an in-game session stale after 45s without a byte from
// the server. Even a continuously transmitting client therefore needs a bounded
// request which a live server will answer, leaving 15s for that reply to arrive.
const KEEPALIVE_REPLY_BOUND_MS = 30_000;

const SYSTEM_KEEPALIVE_CLOCK = Object.freeze({
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle),
});

function keepaliveClock(source = SYSTEM_KEEPALIVE_CLOCK) {
  for (const method of ['now', 'setTimeout', 'clearTimeout']) {
    if (typeof source?.[method] !== 'function')
      throw new TypeError(`keepaliveClock.${method} must be a function`);
  }
  // Keep method receivers intact so deterministic test clocks can use ordinary methods.
  return Object.freeze({
    now: () => source.now(),
    setTimeout: (callback, delayMs) => source.setTimeout(callback, delayMs),
    clearTimeout: handle => source.clearTimeout(handle),
  });
}

export class M59Client {
  constructor({
    host = '127.0.0.1', port = 5959, verbose = true, resources = null,
    keepaliveClock: keepaliveClockSource = null,
  } = {}) {
    Object.assign(this, { host, port, verbose });
    this.state = 'connecting';      // connecting -> handshake -> login -> game
    // Whether the SERVER's plain `char` is signed -- see gameSecurity(). x86 (the
    // public servers) is signed; aarch64 is not. M59_MSG_CHAR_SIGNED=0 forces the
    // ARM answer for a lab server known to be one.
    this.charSigned = process.env.M59_MSG_CHAR_SIGNED !== '0';
    this.buf = Buffer.alloc(0);
    this.epoch = 0;
    this.gameMsgs = 0;
    this.opcodeCounts = new Map();
    this.log = (...a) => this.verbose && console.error('   ', ...a);

    // Perception. The resource table is shared across sessions by default: it is
    // ~10k static strings read from disk once, and every agent needs the same
    // ones. Dynamic resources learned from BP_CHANGE_RESOURCE and BP_PLAYERS go
    // into the same table, which is safe because dynamic ids are globally
    // allocated by the server (blakserv/blakres.c) rather than per-session.
    this.rsc = resources || loadResources();
    this.lookup = id => (this.rsc.has(id) ? this.rsc.get(id) : undefined);
    this.name = id => this.rsc.get(id);

    this.keepaliveClock = keepaliveClock(keepaliveClockSource ?? SYSTEM_KEEPALIVE_CLOCK);
    this.keepaliveTimer = null;      // one idle deadline; see startKeepalive
    this.keepaliveEveryMs = null;
    this.keepaliveStartedAt = null;
    this.keepaliveLastProbeAt = null;
    this.keepaliveLastRxAt = null;   // monotonic clock domain, unlike public lastRxAt
    this.keepalivePending = 0;       // heartbeat inventory replies still owed to us
    this.lastTxAt = null;            // monotonic successful-write time, including login
    // Wall-clock (ms) of the last byte received from the server. A live in-game
    // session receives data continuously. Outbound activity defers the 20s idle
    // heartbeat, but a 30s reply-probe ceiling retains the evidence needed by the
    // tick loop's 45s ghost guard. If this stops advancing while we still believe
    // we are in game, the connection has gone stale (a "ghost": the client replays
    // its last copy of the world while the server has moved on, or dropped us).
    this.lastRxAt = 0;

    this.room = { id: null, security: null, flags: 0, overrideDepths: [0, 0, 0, 0],
                  objects: new Map(), collisionInvalidated: null };
    // SEND_ROOM_CONTENTS has no request id on the wire, but replies preserve request
    // order. Monotonic local ordinals let a correctness-sensitive caller wait for the
    // reply to *its* request instead of accepting an older asynchronous resync that
    // happened to arrive first.
    this.roomContentsRequested = 0;
    this.roomContentsReceived = 0;
    // Local trigger token for renderer animation state. The server does not send an
    // animation epoch, so two identical BP_CHANGE attack programs are otherwise
    // indistinguishable. Increment only when an appearance record is installed.
    this.appearanceRevision = 0;
    this.inventory = [];
    this.spells = [];
    this.skills = [];
    this.trade = null;               // the open offer, if any
    // A trade is a tiny state machine whose dangerous edge is ACCEPT.  A monotonic
    // revision lets an RTS confirmation bind both sides of the table and refuse if a
    // counteroffer changed between the user's preview and the final packet.
    this.tradeRevision = 0;
    this.pendingOfferTo = null;
    this.playersOnline = new Map();                 // object id -> {name, flags}
    // THE SKY. Background overlays by object id — the Sun and the Moon, and nothing else
    // has ever been one. Pushed on every game hour, so this is a live reading rather than
    // something to poll, and it is the only clock on the wire.
    this.sky = new Map();                           // object id -> {angle, height, ...}
    this.statsById = new Map();                     // stat number -> value/text
    // WHAT IS CURRENTLY ON US — poison, disease, a blessing. Keyed by the enchantment
    // object's id, which is what BP_REMOVE_ENCHANTMENT names. See parseAddEnchantment.
    this.enchantmentsById = new Map();
    this.events = [];                               // recent world events, newest last
    this.maxEvents = 500;
    this.evSeq = 0;
    this.waiters = [];
    this.parseErrors = [];                          // desync reports, never silent

    // WHAT IS EQUIPPED, as the server has it. `using` is the server's own plUsing
    // list, replaced whole by BP_USE_LIST and moved item-by-item by BP_USE and
    // BP_UNUSE — never written by us on the strength of a request we sent. See
    // equipment() for why that distinction is the entire point.
    this.using = new Set();
    this.usingAt = null;         // when the server last confirmed the set, changed or not
    this.usingChangedAt = null;  // when it last actually differed

    // CHAT IS ITS OWN STREAM. Player speech shares nothing but a socket with combat
    // text, and the two arrive at wildly different rates: a single fight writes more
    // lines than a character hears in an hour. Keeping them in one 500-entry ring
    // means a sentence someone said is gone before anybody polls for it, evicted by
    // our own swings. So speech gets its own ring and its own sequence, and nothing
    // the world does to us can push it out.
    this.chat = [];
    this.maxChat = 300;
    this.chatSeq = 0;

    // HOW GOOD THIS CHARACTER IS AT EACH SKILL AND SPELL. Keyed by the spell/skill
    // object id, which is what groups 3 and 4 carry — see noteAbility. Read once after
    // login and then kept current by the server's own pushes, so this is a cache that
    // does not go stale on its own.
    this.abilities = new Map();
    this.abilitiesAt = { skills: null, spells: null };   // last FULL read of each group
  }

  // Every perceived change lands here. MCP is request/response, so an agent can
  // only receive by asking; `waitFor` below is the long poll, and the monotonic
  // sequence number is what lets a caller resume without missing an event that
  // arrived between two polls.
  emit(kind, data) {
    const ev = { seq: ++this.evSeq, kind, at: Date.now(), ...data };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.onEvent?.(ev);
    for (const w of this.waiters.splice(0)) w.check();
    return ev;
  }

  // Everything that happened after `since`. An agent's read loop is
  // `since = last.seq` — no event is seen twice and none is dropped.
  eventsSince(since = 0) { return this.events.filter(e => e.seq > since); }

  // SPEECH, kept apart. Called only for the SAY_ types a person can actually produce
  // — see the BP_SAID handler for which those are and why the other two are not.
  //
  // It still emits into the main stream as well, because `waitFor({kinds:'said'})` is
  // how every existing caller blocks on a reply and that must keep working. The ring
  // here is the durable copy: the event stream is a window on the last few seconds of
  // a busy world, and this is the transcript.
  noteChat(entry) {
    const line = { seq: ++this.chatSeq, at: Date.now(), ...entry };
    this.chat.push(line);
    if (this.chat.length > this.maxChat) this.chat.splice(0, this.chat.length - this.maxChat);
    this.onChat?.(line);
    return line;
  }

  // The chat equivalent of eventsSince, with its own independent sequence. A caller
  // polling chat and a caller polling events do not share a cursor and must not.
  chatSince(since = 0, { channels = null, includeSelf = true } = {}) {
    const want = channels && new Set([].concat(channels));
    return this.chat.filter(l => l.seq > since
      && (!want || want.has(l.channel))
      && (includeSelf || !l.self));
  }

  // The long poll. Resolves as soon as anything matching arrives, or at timeout
  // with whatever accumulated. Returning empty on timeout rather than throwing is
  // deliberate: "nothing happened" is a real and useful answer about a world with
  // other people in it.
  waitFor({ since = this.evSeq, kinds = null, timeoutMs = 30000 } = {}) {
    const want = kinds && new Set([].concat(kinds));
    const pick = () => this.eventsSince(since).filter(e => !want || want.has(e.kind));
    return new Promise(resolve => {
      const ready = pick();
      if (ready.length) return resolve({ events: ready, seq: this.evSeq, timedOut: false });
      const w = {
        check: () => {
          const got = pick();
          if (!got.length) { this.waiters.push(w); return; }
          clearTimeout(timer);
          resolve({ events: got, seq: this.evSeq, timedOut: false });
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        resolve({ events: pick(), seq: this.evSeq, timedOut: true });
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  // The end-of-payload invariant from HandleRoomContents. A packed stream gives
  // no other signal, so a parse that does not land exactly at the end is treated
  // as a failure and recorded — never quietly used.
  check(what, res) {
    if (res.exact && !res.error) return true;
    const why = res.error || `cursor off by ${res.leftover} bytes`;
    this.parseErrors.push({ what, why, at: Date.now() });
    this.log(`PARSE ${what}: ${why}`);
    return false;
  }

  // WHAT IS CURRENTLY EQUIPPED. The server's answer, not ours.
  //
  // Every other route to this question in the harness was a guess, and each one was
  // wrong in a way that took a while to notice:
  //
  //   * "the weapon equipBest last picked" — it reported the name it had chosen
  //     without reading the reply, so a refusal left it naming a weapon the
  //     character was not holding, for as long as it carried the thing.
  //   * "the last `use` we sent did not come back broken" — the server refuses a
  //     re-`use` of something already wielded with "your hands are too full"
  //     (player.kod:131), which is not the broken message, so the guess said yes.
  //   * "it is in the inventory" — the inventory is the pack. Wielding is a
  //     different list entirely.
  //
  // `fresh_ms` is here so a caller can tell "nothing is equipped" from "nobody has
  // asked yet". Those are not the same answer and must never render the same. The
  // set starts empty and stays empty until the server says otherwise, so `known` is
  // false until the first BP_USE_LIST lands.
  equipment() {
    const byId = new Map((this.inventory || []).map(o => [o.id, o]));
    const items = [...this.using].map(id => {
      const o = byId.get(id);
      return {
        id,
        name: o ? this.rsc.get(o.nameRsc) : null,
        ...(o ? { can: affordances(o.flags) } : {
          // In `using` but not in the pack. Worth surfacing rather than hiding: it is
          // what a stale inventory looks like, and it is also what a cursed item that
          // equipped itself looks like before the next inventory read.
          note: 'the server says this is equipped but it is not in our copy of the ' +
                'pack — re-read the inventory',
        }),
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id - b.id);

    return {
      known: this.usingAt !== null,
      equipped: items,
      count: items.length,
      fresh_ms: this.usingAt === null ? null : Date.now() - this.usingAt,
      changed_ms: this.usingChangedAt === null ? null : Date.now() - this.usingChangedAt,
      source: 'BP_USE_LIST/BP_USE/BP_UNUSE — the server\'s own plUsing list',
      ...(this.usingAt === null ? {
        note: 'NOT YET KNOWN. Nothing is being claimed here: no use-list has arrived. ' +
              'Any inventory request brings one (user.kod:955), and the keepalive makes ' +
              'one every 20s anyway.',
      } : {}),
    };
  }

  // Take the server's word for the equipped set and say what moved.
  //
  // `usingAt` advances on every confirmation, changed or not, because "the server told
  // us this 200ms ago" is the freshness answer and it is true even when the answer is
  // the same one. `usingChangedAt` and the event advance only on a real difference.
  noteUsing(next, how, id = null) {
    const before = this.using;
    const added = [...next].filter(x => !before.has(x));
    const removed = [...before].filter(x => !next.has(x));
    this.using = next;
    this.usingAt = Date.now();
    if (!added.length && !removed.length) return null;

    this.usingChangedAt = this.usingAt;
    const nameOf = (oid) => {
      const o = (this.inventory || []).find(x => x.id === oid);
      return o ? this.rsc.get(o.nameRsc) : null;
    };
    const ev = this.emit('equipment', {
      how, ...(id === null ? {} : { id }),
      added: added.map(x => ({ id: x, name: nameOf(x) })),
      removed: removed.map(x => ({ id: x, name: nameOf(x) })),
      equipped: [...next].map(x => ({ id: x, name: nameOf(x) })),
    });
    this.log(`EQUIP ${how}${added.length ? ' +' + added.map(nameOf).join(',') : ''}` +
             `${removed.length ? ' -' + removed.map(nameOf).join(',') : ''}`);
    return ev;
  }

  // What an agent sees. Sorted so repeated looks read the same way.
  describeRoom() {
    const objs = [...this.room.objects.values()]
      .sort((a, b) => a.id - b.id)
      .map(o => describeObject(o, this.lookup));
    const where = this.roomNameRsc ? this.rsc.get(this.roomNameRsc) : `room ${this.room.id}`;
    return { room: this.room.id, roomName: where, count: objs.length, objects: objs };
  }

  // Anything in the room whose name matches, for turning agent words into ids.
  find(needle) {
    const n = String(needle).toLowerCase();
    return [...this.room.objects.values()].filter(o =>
      this.rsc.get(o.nameRsc).toLowerCase().includes(n));
  }

  get self() { return this.selfId ? this.room.objects.get(this.selfId) : undefined; }

  // CLIENT-SIDE PREDICTION OF OUR OWN POSITION, which is what the real client does and
  // what this game's server expects it to do.
  //
  // `UserMove` calls `Room.SomethingMoved` directly and `ReqSomethingMoved` is BYPASSED for
  // users — room.kod's comment on that line is "already been checked by client (HAHA!)".
  // There is no geometry, distance or occupancy validation on a user move. So a move we
  // sent is a move that happened, and asking the server where we are afterwards is asking
  // it to repeat what we just told it.
  //
  // It is not free of risk and the risk is named rather than hidden: nothing here is
  // confirmation, and a caller that genuinely needs to know whether a step HAPPENED —
  // rather than where we now are — must ask for a real read. `predicted` is set so the
  // difference is visible to anything that cares, and cleared the moment the server says
  // anything about this object, which BP_MOVE and BP_ROOM_CONTENTS both do.
  // COORDINATE CONTRACT: `col/row` are named 1-based squares; optional `x/y`
  // are the same point in 64-units-per-square kod wire space.
  predictSelf({ col, row, x, y } = {}) {
    const me = this.self;
    if (!me) return null;
    const half = KOD_FINENESS >> 1;
    Object.assign(me, {
      col, row,
      x: x ?? (col * KOD_FINENESS + half),
      y: y ?? (row * KOD_FINENESS + half),
      predicted: true,
    });
    return me;
  }

  // Stats are identified by their (group, slot) position, not by name — their
  // `name_res` resolves to a bitmap filename. Index by both the slot pair and the
  // name STAT_NAMES gives it, so an agent can ask for "health".
  noteStat(s, { bulk = false } = {}) {
    this.statsById.set(`${s.group}.${s.num}`, s);
    if (s.name) this.statsById.set(s.name, s);
    this.emit('stat', { name: s.name || `${s.group}.${s.num}`,
                        value: s.value, max: s.currentMax, text: s.text });
    if (s.group === STAT_GROUP.SPELLS || s.group === STAT_GROUP.SKILLS)
      this.noteAbility(s, { bulk });
  }

  // HOW GOOD THIS CHARACTER IS AT ONE THING, and when we learned it.
  //
  // Ability levels arrive in stat groups 3 (spells) and 4 (skills), and — this is the
  // part worth building on — the server does not only send them when asked.
  // ChangeSkillAbility calls DrawStatSkill on EVERY change, before and regardless of
  // its own `report` flag (player.kod:7343), and DrawStatSkill sends BP_STAT group 4
  // for that one slot (user.kod). So an advancement arrives here the moment it
  // happens, unprompted, and the cache stays true between reads for free.
  //
  // Groups 3 and 4 are STATS_LIST, so each carries the spell's or skill's OBJECT ID.
  // Key on that, not on the slot number: the slot is a position in plSkills and means
  // nothing on its own, which is why `statsById`'s "4.7" keys cannot answer "how good
  // am I with an axe".
  noteAbility(s, { bulk = false } = {}) {
    if (s.id == null) return null;
    const kind = s.group === STAT_GROUP.SKILLS ? 'skill' : 'spell';
    const prev = this.abilities.get(s.id) ?? null;
    // The name comes from the spell/skill LIST, which may not have arrived yet — a
    // stat can land before the list that explains it. Keep the number either way and
    // backfill the name in nameAbilities() when the list turns up; a nameless ability
    // is still a true one, and dropping it would lose an advancement.
    const list = kind === 'skill' ? this.skills : this.spells;
    const entry = (list || []).find(o => o.id === s.id);
    const name = entry ? this.rsc.get(entry.nameRsc) : (prev?.name ?? null);

    const now = { kind, id: s.id, name, ability: s.value, slot: s.num, at: Date.now() };
    this.abilities.set(s.id, now);
    if (bulk) this.abilitiesAt[kind === 'skill' ? 'skills' : 'spells'] = now.at;

    // Only a CHANGE is advancement. The first sighting of a number is not news — it is
    // the read that established it — and emitting for those would put one event per
    // skill into the stream every time anything asks for the group.
    if (!prev || prev.ability === s.value) return null;
    // `what`, not `kind`. emit() spreads this object over the event and the event's own
    // discriminator is called `kind` — so a payload field of that name silently
    // replaces it, and every listener waiting for kind:'ability' sees kind:'skill' and
    // never fires. Which is exactly what happened.
    return this.emit('ability', {
      what: kind, id: s.id, name, from: prev.ability, to: s.value,
      by: s.value - prev.ability,
      pushed: !bulk,     // true means the server volunteered it: a real advancement
    });
  }

  // Put names to abilities learned before the list that explains them arrived.
  nameAbilities() {
    for (const [kind, list] of [['skill', this.skills], ['spell', this.spells]]) {
      for (const o of list || []) {
        const a = this.abilities.get(o.id);
        if (a && !a.name && a.kind === kind) a.name = this.rsc.get(o.nameRsc);
      }
    }
  }

  // HOW GOOD ARE WE AT <name>. This is the lookup the harness has always wanted and
  // never had: group 3 and 4 stats have no `name` — STAT_NAMES only covers groups 1
  // and 2 — so they were never indexed by name, and every by-name search of
  /** Everything currently on this character — poison, disease, a blessing. */
  enchantments() { return [...this.enchantmentsById.values()]; }

  /**
   * IS SOMETHING DRAINING US THAT IS NOT AN ATTACK?
   *
   * Poison takes health with nobody adjacent and CANNOT KILL — it stops short — so it looks
   * exactly like a safe spot leaking, and that is the reading it was producing: a wall
   * discredited for good on the strength of damage no wall could have stopped.
   *
   * Matched on the resource name because that is what the server sends and the sickness
   * classes are named for what they are. Returns the list rather than a boolean so a caller
   * can say WHICH in a note; empty means nothing found, never "we cannot tell".
   */
  ailments() {
    return this.enchantments().filter(e => /poison|disease|sick|plague|venom/i.test(e.name ?? ''));
  }

  poisoned() { return this.ailments().length > 0; }

  // `statsById` for a proficiency returned nothing at all. Ask the ability map.
  abilityOf(name) {
    if (!name) return null;
    const q = String(name).toLowerCase();
    for (const a of this.abilities.values())
      if (a.name && a.name.toLowerCase() === q) return a.ability;
    return null;
  }

  // Everything we know about how good this character is, and how stale it is allowed
  // to be. `known` is per kind, because the two groups are asked for separately and
  // one can be current while the other has never been read.
  abilitiesKnown() {
    const rows = [...this.abilities.values()];
    const of = k => rows.filter(a => a.kind === k)
      .sort((x, y) => (y.ability ?? -1) - (x.ability ?? -1) ||
                      String(x.name).localeCompare(String(y.name)));
    const age = t => (t === null ? null : Date.now() - t);
    return {
      skills: of('skill'), spells: of('spell'),
      read_at: { ...this.abilitiesAt },
      age_ms: { skills: age(this.abilitiesAt.skills), spells: age(this.abilitiesAt.spells) },
      known: { skills: this.abilitiesAt.skills !== null, spells: this.abilitiesAt.spells !== null },
      unnamed: rows.filter(a => !a.name).length,
    };
  }

  stat(name) {
    const s = this.statsById.get(String(name).toLowerCase());
    return s && (s.text !== undefined ? s.text : s.value);
  }

  // Everything an agent needs to decide whether to fight, flee or rest. Note
  // `currentMax`, not `max`: kod sends max as a fixed display scale of 100 and
  // the real ceiling as current_max, so reading `max` says everyone has 100 hp.
  //
  // The three are NOT the same shape, and the fourth field only means "ceiling"
  // for two of them (user.kod:6820-6840):
  //   health  value=piHealth  scale=100  current_max=piMax_health           <- a real ceiling
  //   mana    value=piMana    scale=100  current_max=piMax_mana             <- a real ceiling
  //   vigor   value=piVigor   scale=200  current_max=piVigor_rest_threshold <- NOT a ceiling
  // Vigor's fourth field is the level at which the character has rested enough
  // (player.kod:891, default 80, bounded 10..100), so dividing by it reports 125%
  // for a perfectly ordinary character and makes "am I rested" unanswerable.
  vitals() {
    const st = n => this.statsById.get(n);
    const ratio = (v, d) => (d ? Math.round(100 * v / d) : null);
    const out = {};

    for (const n of ['health', 'mana']) {
      const s = st(n);
      if (!s) continue;
      out[n] = { value: s.value, max: s.currentMax, pct: ratio(s.value, s.currentMax) };
      // A value above its own ceiling is not a parse error — it is what a character
      // granted health or mana over the admin socket looks like, because the grant
      // writes piMana without touching piMax_mana. Saying so beats reporting 913%:
      // every affordability check downstream reads `value`, and the ceiling is what
      // it will actually regenerate to once spent.
      if (s.value > s.currentMax)
        out[`${n}_over_max`] = `${n} is ${s.value} against a ceiling of ${s.currentMax}; the ceiling is ` +
          `the real one, so this was granted rather than earned and will not refill past ${s.currentMax} once spent`;
    }

    const v = st('vigor');
    if (v) out.vigor = {
      value: v.value,
      scale_max: v.max ?? 200,
      rest_threshold: v.currentMax,
      pct: ratio(v.value, v.max ?? 200),
      rested: v.currentMax != null ? v.value >= v.currentMax : null,
      note: 'vigor is out of ' + (v.max ?? 200) + '; rest_threshold is the point the game counts as ' +
            'rested, not a maximum',
    };
    return out;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host);
      this.sock.on('connect', () => {
        this.log(`connected to ${this.host}:${this.port}`);
        // Send NOTHING on connect.
        //
        // blakserv/async.c:241 puts a new session straight into STATE_SYNCHED,
        // which expects framed messages immediately, and the server opens the
        // conversation itself with AP_GETLOGIN. The three raw byte strings in
        // clientd3d/statstrt.c are for RE-synchronising after a stream error
        // (blakserv/trysync.c), not for connecting. Sending client_string1 here
        // gets parsed as a frame header — len 65281 vs len2 19265 — which fails
        // the length check and earns an immediate AP_RESYNC.
        this.state = 'login';
        resolve();
      });
      this.sock.on('data', d => this.onData(d));
      this.sock.on('error', reject);
      this.sock.on('close', () => this._connectionClosed());
    });
  }

  _connectionClosed() {
    this.log('connection closed');
    this.state = 'closed';
    this.stopKeepalive();
  }

  onData(chunk) {
    this.lastRxAt = Date.now();
    this.keepaliveLastRxAt = Number(this.keepaliveClock.now());
    this.rxBytes = (this.rxBytes ?? 0) + chunk.length;
    this.rxPackets = (this.rxPackets ?? 0) + 1;
    this.buf = Buffer.concat([this.buf, chunk]);

    // doc/login.txt describes a three-step raw byte exchange before login mode.
    // The current server does not do that: it accepts the client's opening bytes
    // and replies immediately with a framed AP_GETLOGIN. Observed reply was
    // 01 00 66 0b 01 00 00 15 — len 1, crc 0x0b66, len 1, seqno 0, payload 0x15
    // which is AP_GETLOGIN. So the doc is stale; parse frames straight away and
    // never wait for the documented server hello.
    if (this.state === 'handshake') this.state = 'login';

    for (;;) {
      if (this.buf.length < HEADER) return;
      const len  = this.buf.readUInt16LE(0);
      const crc  = this.buf.readUInt16LE(2);
      const len2 = this.buf.readUInt16LE(4);
      if (len !== len2) {
        this.log(`length mismatch ${len}/${len2} — dropping buffer`);
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < HEADER + len) return;
      // clientd3d/com.c:409 — "Save latest epoch byte for us to send in our
      // messages." The epoch is the GC generation; the server silently drops any
      // BP_* message whose seqno does not match its current value, so it must be
      // echoed from the most recent inbound frame rather than assumed to be 0.
      this.epoch = this.buf.readUInt8(6);
      const payload = this.buf.subarray(HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      const seen = crc16(payload);
      if (seen !== crc && this.state !== 'game') this.log(`crc mismatch: got ${crc}, computed ${seen}`);
      this.onMessage(payload);
    }
  }

  onMessage(payload) {
    if (!payload.length) return;
    const op = payload[0];
    const body = payload.subarray(1);

    // AP_* and BP_* opcode spaces OVERLAP numerically — BP_WAIT is 21 and
    // AP_GETLOGIN is 21, BP_UNWAIT is 22 and AP_GETCHOICE is 22. They must be
    // dispatched on connection state, never on the byte alone, or the client
    // will cheerfully re-send its password mid-game.
    if (this.state === 'game') {
      this.gameMsgs++;
      this.opcodeCounts.set(op, (this.opcodeCounts.get(op) || 0) + 1);
      // A parser that reads off the end of a payload throws, and this runs inside the
      // socket's data handler — so an uncaught throw here does not just lose one
      // message, it takes down the process and every other agent's session with it.
      // Record it the same way a failed invariant is recorded and carry on: one
      // unparsed message is a gap in perception, not a reason to stop playing.
      try {
        this.onGameMessage(op, body);
      } catch (e) {
        this.parseErrors.push({ what: BPNAME[op] || `bp ${op}`, why: e.message, at: Date.now() });
        this.log(`PARSE ${BPNAME[op] || op}: ${e.message}`);
        this.emit('parse-error', { opcode: BPNAME[op] || op, why: e.message });
      }
      return;
    }

    this.log(`<- ${APNAME[op] || `op ${op}`} (${payload.length}b)`);

    switch (op) {
      case AP.GETLOGIN:      this.sendLogin(); break;
      case AP.LOGINOK:       this.log(`login accepted (admin byte ${body[0]})`); this.reqGame(); break;
      case AP.LOGINFAILED:   this.fail('login rejected — wrong username or password'); break;
      case AP.ACCOUNTUSED:   this.fail('account already in use'); break;
      case AP.TOOMANYLOGINS: this.fail('too many login attempts'); break;
      case AP.NOCHARACTERS:  this.fail('account has no characters (needs `create user <acct>`)'); break;
      case AP.TIMEOUT:       this.fail('login timed out'); break;
      // AP_GETCHOICE is not just "you are at the main menu" — it carries the five
      // 32-bit seeds that initialise the game-mode security stream
      // (blakserv/synched.c:SynchedSendMenuChoice). 1 opcode + 5*4 = 21 bytes,
      // which matches the observed payload exactly. Miss these and every
      // game-mode message is rejected.
      case AP.GETCHOICE: {
        if (body.length >= 20) {
          this.seeds = [];
          for (let i = 0; i < 5; i++) this.seeds.push(body.readUInt32LE(i * 4));
          this.log(`security seeds: ${this.seeds.join(', ')}`);
        } else this.log(`GETCHOICE without seeds (${body.length}b)`);
        break;
      }

      case AP.MESSAGE: {
        const n = body.readUInt16LE(0);
        this.log(`server message: "${body.subarray(2, 2 + n).toString('latin1')}"`);
        break;
      }
      case AP.GAME:
        this.state = 'game';
        this.log('IN GAME');
        // startKeepalive() is public and historically worked even when called before
        // this transition: its interval stayed dormant until game mode. Arm the
        // one-shot now if a caller installed the policy early.
        this._armKeepalive();
        break;
    }
  }

  fail(why) { this.error = why; this.log(`FAILED: ${why}`); }

  // ------------------------------------------------------------- actions
  //
  // Byte widths come from blakserv/sprocket.c client_def_table, which is the
  // authoritative mapping of each BP_* request to its kod message parameters.
  // The width in that table is what the server reads, so a 1-byte TAG_INT must
  // be sent as one byte even though kod treats it as an integer.

  // type is a kod SAY_ constant (include/blakston.khd:2179). Only these six are
  // things a client may SEND; the rest of the enum is what the server sends back.
  //
  //   1 SAY_NORMAL    the room
  //   2 SAY_YELL      the room plus the adjacent rooms in its yell zone
  //   3 SAY_EVERYONE  the whole server. Gated by TryBroadcast (player.kod:3173):
  //                   refused outright while squelched, and otherwise it COSTS
  //                   MANA — max_mana * GetBroadcastManaCostPercent / 100 + 1.
  //   6 SAY_EMOTE     the room, phrased as an action rather than speech
  //   9 SAY_DM        admin channel; an ordinary character is not allowed it
  //  10 SAY_GUILD     the speaker's guild, wherever its members are. Refused
  //                   with a message if you have no guild, or nobody is on.
  //
  // Every one of these refusals arrives as prose, not as an error, so the only
  // way to know a line was actually said is to watch for the SAID echo.
  say(text, type = 1)   { this.send(BP.SAY_TO, u8b(type), pstr(text)); }
  yell(text)            { this.say(text, 2); }
  broadcast(text)       { this.say(text, 3); }
  emote(text)           { this.say(text, 6); }
  sayGuild(text)        { this.say(text, 10); }

  // CHANGE THIS ACCOUNT'S PASSWORD, over the ordinary game port.
  //
  // Both values are MD5 digests, not text: clientd3d/maindlg.c runs MDString over each
  // before sending, and the server calls SetAccountPasswordAlreadyEncrypted with what
  // arrives. Sending plaintext here would store the plaintext AS the digest, and the
  // account would then only be reachable by an client that hashed to that same string
  // — which is to say, never again.
  //
  // Resolves true on BP_PASSWORD_OK, false on BP_PASSWORD_NOT_OK, and rejects on
  // silence. The caller MUST record the new password before relying on this: there is
  // no way to read a password back, so a change that is not written down is a
  // character lost.
  async changePassword(oldPw, newPw, { timeoutMs = 8000 } = {}) {
    // Take the sequence number BEFORE sending, or a reply that arrives while we are
    // still setting up the wait is missed and the whole thing times out.
    const since = this.evSeq;
    this.send(BP.CHANGE_PASSWORD, pbuf(mdpass(oldPw)), pbuf(mdpass(newPw)));
    const { events } = await this.waitFor({
      since, kinds: ['password-ok', 'password-not-ok'], timeoutMs });
    const hit = events.find(e => e.kind === 'password-ok' || e.kind === 'password-not-ok');
    if (!hit) throw new Error('no reply to BP_CHANGE_PASSWORD');
    return hit.kind === 'password-ok';
  }

  // BP_SAY_GROUP {2,LIST_OBJ_PARM} {0,TAG_TEMP_STRING} (sprocket.c:28) — the
  // "tell"/"send" system, and a DIFFERENT opcode from say. It carries a list of
  // player OBJECT ids, not names, so a caller has to resolve names first.
  //
  // One recipient is a private tell and the server reports it back as
  // SAY_GROUP_ONE; more than one is a group send (user.kod:4203-4207). It costs
  // ONE MANA PER RECIPIENT and TrySayGroup (player.kod:3210) refuses the whole
  // thing when piMana < recipients — again as prose, not an error.
  sayGroup(ids, text)   { this.send(BP.SAY_GROUP, encodeIdList([].concat(ids)), pstr(text)); }
  tell(id, text)        { this.sayGroup([id], text); }

  // {2,INT} {2,INT} {1,INT} {4,OBJECT} — but Y GOES FIRST. clientd3d/protocol.h:74
  //
  //   #define RequestMove(y, x, speed, room) ToServer(BP_REQ_MOVE, NULL, ... y, x ...)
  //
  // and the receiving ExtractCoordinates reads y before x too. Coordinates are in
  // kod fine units — row * 64 + offset, rows 1-based — which is exactly what
  // BP_ROOM_CONTENTS reports, so a coordinate read from perception can be sent
  // back unchanged. Speed 0 means "teleport-style step"; the real client sends 18
  // for a walk and 36 for a run.
  //
  // The room id must be the room we are actually in or the move is refused, so it
  // defaults to the one BP_PLAYER told us.
  // MOVEMENT SPEED IS A REAL CHOICE, not a constant.
  //
  // USER_WALKING_SPEED = 18 (user.kod:46). Anything above it is RUNNING, and the
  // server checks two things: you must have at least VIGOR_RUN_THRESHOLD = 10 vigor
  // or it snaps you back to where you were and logs you as a speedhacker, and it
  // charges exertion as EXERTION_PER_MOVE * (speed * 5/6)^2 — QUADRATIC in speed.
  // Running at 24 costs 1.8x the vigor of walking; at 30 it costs 2.8x.
  //
  // That trade is worth taking outdoors and not indoors. Vigor sets the health
  // regeneration rate, so burning it in a safe town is pure loss, while crossing a
  // field of groundworms slowly is how you arrive dead.
  // COORDINATE CONTRACT: arguments are fine `(x,y)` in 64-units-per-square kod
  // wire space; BP_REQ_MOVE serializes the same point as Y then X below.
  moveTo(x, y, speed = 18, room = this.room.id) {
    if (!Number.isInteger(x) || x < 0 || x > 0xffff
        || !Number.isInteger(y) || y < 0 || y > 0xffff)
      throw new RangeError(`movement coordinates must be unsigned 16-bit integers, got (${x},${y})`);
    this.send(BP.REQ_MOVE, u16b(y), u16b(x), u8b(speed), u32(objId(room || 0)));
    // OUR OWN TRAIL, AT THE RATE WE ACTUALLY WALK IT.
    //
    // `BP_MOVE` is the server telling us where everyone is, and it arrives about once a
    // second — measured on this fleet, a median of 1202ms between samples and 69 wire units
    // of movement, which is roughly one square. That is the best resolution obtainable for
    // ANOTHER body, and it is far coarser than our own walking: every move we send is a
    // point we chose, in exact fine coordinates, already proved by `validateFineTarget`
    // before it reached this line.
    //
    // Recording it here rather than at the caller because this is the one place every sent
    // move passes through — a walk, a fine step, a doorway nudge and a retreat all end up
    // here, and a recorder attached to any one of them would miss the others.
    //
    // Flagged `sent`, because it is where we ASKED to be and the server has not confirmed
    // it yet. The straightener raycasts every leg it keeps, so an intention that was refused
    // cannot become a track through a wall — it simply fails to join and is dropped.
    recordSeen({ at: Date.now(),
                 room_name_rsc: this.roomNameRsc ?? null, room_rsc: this.roomRsc ?? null,
                 room: this.room?.id ?? null, id: this.selfId,
                 name: this.character ?? null, by: this.character ?? null,
                 player: true, sent: true, x, y });
  }
  // COORDINATE CONTRACT: the movement API is `(col,row)`; this is the adapter to
  // fine `(x,y)` kod wire coordinates. Do not reorder this legacy public signature.
  moveToSquare(col, row, speed = 18, room = this.room.id) {
    const half = KOD_FINENESS >> 1;
    return this.moveTo(col * KOD_FINENESS + half, row * KOD_FINENESS + half, speed, room);
  }
  turn(angle)           {
    this.send(BP.REQ_TURN, u32(objId(this.selfId || 0)), u16b(angle));
    // Track our own angle LOCALLY so a caller can coalesce re-faces (the packet-throttle
    // fix, docs/packet-throttle.md). The real client keeps a local angle; we were only
    // updating it from server BP.TURN pushes, which lag, so the coalescing compared
    // against a stale value and re-sent every turn. Update immediately on send.
    if (this.self) this.self.degrees = Math.round(angle * 360 / MAX_ANGLE);
  }
  face(degrees)         { this.turn(Math.round(degrees * MAX_ANGLE / 360) & (MAX_ANGLE - 1)); }

  look(id)              { this.send(BP.REQ_LOOK, u32(objId(id))); }

  // BP_CHANGE_DESCRIPTION (126) — {4,OBJECT} then {0,STRING}, sprocket.c:71. The object
  // is WHO is being described, and user.kod:1345 accepts it only when that object is
  // ourselves, or when an Admin names a player; anything else falls through to the
  // inscription branch and is refused. So this always addresses selfId, and refuses to
  // send at all before we have one — object 0 gets `Debug("Tried setting description of
  // nil object")` server-side and nothing on the wire, which is the sort of silent
  // success this client exists to avoid.
  //
  // The server runs the string through SYS.CleanseString (system.kod:5687 — swear
  // substitution, nothing else) and stores it in psPlayerDescription, a saved property.
  //
  // IT REPLACES THE LOOK TEXT ENTIRELY. Player.ShowDesc (player.kod:1521) sends the
  // description under the "%q" resource and RETURNS, never reaching the propagate that
  // builds the default prose — so a character carrying one stops reporting its own
  // level and guild to anyone who looks. And there is no packet that reads it back: the
  // only way to see a description is for someone else to BP_REQ_LOOK at you. Whatever
  // was last sent is the only record, which is why m59-describe.mjs writes it down.
  setDescription(text) {
    if (!this.selfId) throw new Error('no object id yet — a description can only be set once in game');
    this.send(BP.CHANGE_DESCRIPTION, u32(objId(this.selfId)), pstr(String(text)));
  }

  // Swing/attack packet. Instrumented for diagnosis: every REQ_ATTACK is
  // timestamped into this.attackLog so a caller (or the keeper's /swingstats
  // endpoint) can measure the ACTUAL rate the client is sending swings — as
  // opposed to what the decider "decided". A decision to swing and a packet
  // sent are different things; this is the packet. Kept bounded so a long
  // session does not grow it without bound.
  attack(id, info = 1)  {
    if (!Array.isArray(this.attackLog)) this.attackLog = [];
    this.attackLog.push({ at: Date.now(), id });
    if (this.attackLog.length > 500) this.attackLog.splice(0, this.attackLog.length - 500);
    this.send(BP.REQ_ATTACK, u8b(info), u32(objId(id)));
  }

  // Record a combat outcome from a server message. The server sends prose for
  // every attack result (verified against the .kod source, stroke.kod):
  //   hit:  "Your <weapon> hits <target>."      (stroke_hit_attacker)
  //   miss: "Your <weapon> misses <target>."    (stroke_miss_attacker)
  //   far:  the out-of-range message             (player_attack_out_of_range)
  // This is the ground truth for whether a swing LANDED — the server is telling
  // us, and we can finally read it instead of assuming. Bounded ring.
  _noteCombatOutcome(text) {
    const t = String(text);
    let kind = null;
    if (/out of range/i.test(t)) kind = 'out_of_range';
    else if (/your .* hits /i.test(t) || /^you hit /i.test(t)) kind = 'hit';
    else if (/your .* misses /i.test(t) || /^you miss /i.test(t)) kind = 'miss';
    if (!kind) return;
    if (!Array.isArray(this.combatLog)) this.combatLog = [];
    this.combatLog.push({ at: Date.now(), kind, text: t.slice(0, 120) });
    if (this.combatLog.length > 500) this.combatLog.splice(0, this.combatLog.length - 500);
  }
  use(id)               { this.send(BP.REQ_USE, u32(objId(id))); }
  unuse(id)             { this.send(BP.REQ_UNUSE, u32(objId(id))); }
  get(id)               { this.send(BP.REQ_GET, u32(objId(id))); }
  buy(id)               { this.send(BP.REQ_BUY, u32(objId(id))); }
  action(n)             { this.send(BP.ACTION, u8b(n)); }
  contents(id)          { this.send(BP.SEND_OBJECT_CONTENTS, u32(objId(id))); }
  activate(id)          { this.send(BP.REQ_ACTIVATE, u32(objId(id))); }

  // BP_REQ_DROP is {2,LIST_OBJ_PARM} — a LIST of ids, not one id. The single-item
  // form is the common case, so accept either.
  drop(ids)             { this.send(BP.REQ_DROP, encodeIdList([].concat(ids))); }

  // BP_REQ_PUT {4,OBJECT} {4,OBJECT} — put an item into a container.
  put(what, container)  { this.send(BP.REQ_PUT, u32(objId(what)), u32(objId(container))); }

  // BP_REQ_BUY_ITEMS {4,OBJECT} {2,LIST_OBJ_PARM} — the seller, then the ids to
  // buy as a count-prefixed id list.
  buyItems(sellerId, ids) {
    this.send(BP.REQ_BUY_ITEMS, u32(objId(sellerId)), encodeIdList([].concat(ids)));
  }

  // BP_REQ_DEPOSIT is the vault/banker one-shot deposit path. Unlike a merchant
  // offer it has no counteroffer and no accept: the server moves accepted items
  // before returning from the request. Stacked items still need an explicit amount.
  depositItems(vaultmanId, items) {
    this.send(BP.REQ_DEPOSIT, u32(objId(vaultmanId)), encodeIdList([].concat(items)));
  }

  // BP_REQ_CAST {4,OBJECT spell} {2,LIST_OBJ_PARM targets}. A spell with no
  // target still sends an empty list.
  cast(spellId, targets = []) {
    this.send(BP.REQ_CAST, u32(objId(spellId)), encodeIdList([].concat(targets)));
  }

  // BP_REQ_APPLY {4,OBJECT} {4,OBJECT} — use one item on another.
  apply(what, onWhat) {
    this.send(BP.REQ_APPLY, u32(objId(what)), u32(objId(onWhat)));
  }

  // There is no BP_REQ_GIVE in sprocket.c's table despite the opcode existing, so
  // handing anything over is always a two-sided trade. `items` may be plain ids, or
  // {id, amount} to offer part of a stack — which is how money gets split.
  //
  // Only BP_REQ_OFFER is subject to the packet throttle; the other three are not.
  offer(toId, items)    {
    const id = objId(toId);
    const target = this.room?.objects?.get(id);
    this.pendingOfferTo = {
      id,
      name: target ? (this.rsc.get(target.nameRsc) || '') : '',
    };
    this.send(BP.REQ_OFFER, u32(id), encodeIdList([].concat(items)));
  }
  counterOffer(items = []) { this.send(BP.REQ_COUNTEROFFER, encodeIdList([].concat(items))); }
  acceptOffer()         { this.send(BP.ACCEPT_OFFER); }
  cancelOffer()         { this.send(BP.CANCEL_OFFER); }

  // BP_USERCOMMAND is a second dispatch table (sprocket.c usercommand_def_table):
  // one byte of sub-opcode, then that command's own parameters. Resting is here,
  // not in the main table, and resting is how a character heals.
  userCommand(uc, ...parts) { this.send(BP.USERCOMMAND, u8b(uc), ...parts); }
  // ------------------------------------------------- making a character
  //
  // The game's own creation path, which nothing here used before: a client that
  // could only ever USE a character the admin socket had already made. `create
  // automated` produces a character with NO attributes at all — every stat pinned
  // to the floor of 1, permanently — so anything built that way is crippled from
  // birth. This is how a real player builds one instead.
  //
  // The sequence is a RESTART, which is an ordinary in-game action:
  //
  //   1. UC_SUICIDE while logged in. PerformSuicide (user.kod:1447) sets
  //      piLastLoginTime = 0, and IsFirstTime() is exactly that test — which is
  //      the gate system.kod:3726 checks before it will accept a new character.
  //   2. Reconnect, and at the character list send BP_NEW_CHARINFO instead of
  //      BP_USE_CHARACTER.
  //   3. BP_CHARINFO_OK comes back carrying the object id to then USE.
  //
  // WHAT THE SERVER WILL ACCEPT (player.kod:1971 PlayerNewCharInfo):
  //   * six stats, each 1..50, SUMMING TO AT MOST 200. Over budget or out of
  //     range and it does not complain — it silently stamps a junk character
  //     (3/1/4/1/5/9) on you and carries on.
  //   * spells and skills costing at most 45 points total, 10 a piece for a
  //     level-1 and 25 for anything higher (`viSkill_level`). Over budget is
  //     likewise silently discarded.
  //   * a face-part list of exactly 5 valid resources — and a list of the WRONG
  //     LENGTH is quietly replaced with the default male face, which is why this
  //     can send an empty one rather than carry a table of icon resources.
  //
  // Order and widths are from sprocket.c:87, which is the authority on both.
  suicide()             { this.userCommand(UC.SUICIDE); }
  useCharacter(id)      { this.me = { id }; this.send(BP.USE_CHARACTER, u32(objId(id))); }

  // THE SYSTEM OPCODES ARE A SUBTABLE, NOT TOP-LEVEL OPCODES.
  //
  // Sending BP_NEW_CHARINFO (48) as an opcode gets "ParseClientSendBlakod got
  // invalid command 48", and it is tempting to read that as "this server does not
  // support character creation" — which is what I concluded, wrongly, from the fact
  // that 48 appears only in sprocket.c's system_def_table and that table is never
  // passed to the parser.
  //
  // It is never passed because it does not need to be. parsecli.c:130 dispatches on
  // the FIRST param of the entry it finds, and BP_SYSTEM (6) is declared
  // {0, SYSTEM_TABLE_PARM} — a redirect. Seeing it, the parser swaps to the system
  // table, retargets the message at the system object, and reads ANOTHER byte as the
  // real command. Exactly the mechanism BP_USERCOMMAND already uses for rest/safety
  // /banking, which this client has been using correctly all along.
  //
  // So every system message is two bytes of opcode: BP_SYSTEM, then the system
  // command. Nothing about it is state-dependent, and no handshake is required.
  systemCommand(cmd, ...parts) { this.send(BP.SYSTEM, u8b(cmd), ...parts); }

  sendCharInfoRequest() { this.systemCommand(BP.SEND_CHARINFO); }

  newCharInfo({ user, name, desc = '', gender = 1, faceparts = [], hair = 0,
                skin = 0, stats, spells = [], skills = [] }) {
    this.systemCommand(BP.NEW_CHARINFO,
      u32(objId(user)), pstr(name), pstr(desc), u8b(gender),
      encodeIntList(faceparts), u8b(hair), u8b(skin),
      encodeIntList(stats), encodeIntList(spells), encodeIntList(skills));
  }

  rest()                { this.userCommand(UC.REST); }
  stand()               { this.userCommand(UC.STAND); }
  safety(on)            { this.userCommand(UC.SAFETY, u8b(on ? 1 : 0)); }
  balance()             { this.userCommand(UC.BALANCE); }
  deposit(n)            { this.userCommand(UC.DEPOSIT, u32(n)); }
  withdraw(n)           { this.userCommand(UC.WITHDRAW, u32(n)); }
  requestRescue()       { this.userCommand(UC.REQ_RESCUE); }

  // ------------------------------------------------- guilds
  //
  // The widths are module/merintr/merintr.c:88's `user_msg_table`, which is the real
  // client's own declaration of every one of these: PARAM_ID is 4 bytes, PARAM_BYTE is
  // 1, PARAM_STRING is a 2-byte length and then Latin-1 bytes.
  //
  // NOTHING HERE REPORTS ITS OWN SUCCESS AND MOST OF IT CANNOT FAIL VISIBLY.
  // `User.UserGuildCommand` (user.kod:4848) tests `HasGuildCommand` and, when the bit
  // is absent, writes a line to the SERVER LOG and returns — the player is sent nothing
  // whatsoever. So an under-ranked invite, exile, promotion, alliance or disband is
  // indistinguishable on the wire from one that worked. Check `client.guild.flags`
  // through m59-guild.mjs's `mayI` before sending, and confirm afterwards by re-reading
  // the roster, which is what the broker's `guild` tool does.
  requestGuildInfo()    { this.userCommand(UC.REQ_GUILDINFO); }
  requestGuildList()    { this.userCommand(UC.REQ_GUILD_LIST); }

  // THE HALL LIST AND THE FOUNDING PRICES ARE PUSH-ONLY, AND THE THING THAT TRIGGERS THEM
  // IS A SHOPPING REQUEST THAT DELIBERATELY SELLS NOTHING.
  //
  // There is no UC_GUILD_HALLS request. merintr.c lists it in the incoming handler table and
  // NOT in `user_msg_table`, and user.kod has no `iClient_cmd = UC_GUILD_HALLS` branch at all
  // — sending one reaches "got unknown UserCommand" and nothing else. This client had such a
  // sender, and it was silent in the usual way: a request nobody handles and a reply nobody
  // sends are the same nothing.
  //
  // What produces both dialogs is `GuildCreator.GetForSale`, whose own docstring calls itself
  // hacky: "user.kod:UserBuy() aborts if it gets $ returned from here, so we can use it as a
  // hook" (gcreator.kod:250). So asking Frular to trade pushes UC_GUILD_HALLS to an officer of
  // a mature guild, or UC_GUILD_ASK to somebody eligible to found one, and then returns an
  // empty for-sale list. A `shop` at Frular therefore looks exactly like a merchant with
  // nothing to sell, which is the visible half of the same call.
  askFrular(frularId)   { this.buy(frularId); }

  guildInvite(id)       { this.userCommand(UC.INVITE,   u32(objId(id))); }
  guildExile(id)        { this.userCommand(UC.EXILE,    u32(objId(id))); }
  guildRenounce()       { this.userCommand(UC.RENOUNCE); }
  guildAbdicate(id)     { this.userCommand(UC.ABDICATE, u32(objId(id))); }
  guildVote(id)         { this.userCommand(UC.VOTE,     u32(objId(id))); }
  guildDisband()        { this.userCommand(UC.DISBAND); }
  guildAlly(id)         { this.userCommand(UC.MAKE_ALLIANCE, u32(objId(id))); }
  guildEndAlliance(id)  { this.userCommand(UC.END_ALLIANCE,  u32(objId(id))); }
  guildDeclareWar(id)   { this.userCommand(UC.MAKE_ENEMY,    u32(objId(id))); }
  guildMakePeace(id)    { this.userCommand(UC.END_ENEMY,     u32(objId(id))); }
  guildAbandonHall()    { this.userCommand(UC.ABANDON_GUILD_HALL); }
  guildSetPassword(s)   { this.userCommand(UC.GUILD_SET_PASSWORD, pstr(s ?? '')); }

  // RANK IS A BYTE AND IT IS AN ABSOLUTE RANK, NOT A DIRECTION. GCID_PROMOTE and
  // GCID_DEMOTE exist as bits but no client command sends them; the real client only
  // ever sends UC_SET_RANK with the rank it wants (merintr.c:99, PARAM_ID + PARAM_BYTE).
  guildSetRank(id, rank) { this.userCommand(UC.SET_RANK, u32(objId(id)), u8b(rank)); }

  // Renting a hall is the only guild command that is NOT routed through
  // UserGuildCommand, so it is the only one that reports failure out loud: user.kod:1815
  // reads the price itself, says `user_no_guildhall_broke` if the purse is short, and
  // otherwise calls ClaimGuildHall, which answers with its own prose for a guild that is
  // not mature or already holds a hall. The password is set on the hall in the same call.
  guildRentHall(hallId, password = '') {
    this.userCommand(UC.GUILD_RENT, u32(objId(hallId)), pstr(password));
  }

  // Founding one. Ten titles in RANK_TITLE_FIELDS order, then a byte for secrecy.
  //
  // THE ORDER IS FLAT AND WRONG ORDER DOES NOT ERROR — it gives every woman in the
  // guild a man's title, permanently, since nothing renames a guild. Validate through
  // m59-guild.mjs's `validateGuild` first: an over-long name or title is dropped by the
  // server with a Debug and no reply, and the founder is not charged, so the whole
  // attempt is silent in both directions.
  guildCreate({ name, titles, secret = false }) {
    if (!Array.isArray(titles) || titles.length !== 10)
      throw new Error('guildCreate needs exactly 10 rank titles — see RANK_TITLE_FIELDS');
    this.userCommand(UC.GUILD_CREATE, pstr(name), ...titles.map(t => pstr(t)), u8b(secret ? 1 : 0));
  }

  // No-parameter requests. These are how an agent refreshes its perception —
  // nothing arrives unasked except changes to things already known. Named
  // `requestInventory` rather than `inventory` because `this.inventory` is the
  // parsed result; a method and a property cannot share a name.
  // These are `request*` because the parsed results live on `this.inventory`,
  // `this.spells` and `this.skills`, and in JavaScript a method and a property
  // cannot share a name — the assignment silently replaces the method, and the
  // next call fails with "not a function" long after the cause.
  requestInventory()    { this.send(BP.REQ_INVENTORY); }
  requestSpells()       { this.send(BP.SEND_SPELLS); }
  requestSkills()       { this.send(BP.SEND_SKILLS); }
  // WHO ARE WE. The reply is BP_PLAYER, whose handler re-assigns `selfId` and then
  // re-requests the room contents, so this is the one packet that recovers an identity
  // the server has renumbered underneath us — which it does on every garbage collection,
  // and it collects on every save. `self` is `room.objects.get(selfId)`, so a stale
  // `selfId` reads exactly like "I do not know where I am" and no amount of re-reading
  // the room can fix it: the new contents are keyed by the NEW id.
  //
  // It is a METHOD here rather than a constant the broker sends by hand, because it was
  // sent by hand — `c.send(BP_SEND_PLAYER)` — against an identifier that does not exist
  // in that file. That is a ReferenceError at the moment of use, in two places, and both
  // were the recovery path for a fault nobody could reproduce on purpose. A missing
  // method fails at load; a missing free variable fails only when the world goes wrong.
  requestPlayer()       { this.send(BP.SEND_PLAYER); }
  roomContents()        {
    const request = this.roomContentsRequested + 1;
    this.send(BP.SEND_ROOM_CONTENTS);
    this.roomContentsRequested = request;
    return request;
  }

  /**
   * GIVE UP ON EVERY ROOM-CONTENTS REPLY UP TO `upTo`, AND SAY SO OUT LOUD.
   *
   * These two counters are ordinals: `roomContents()` hands out a request number and the
   * BP_ROOM_CONTENTS handler counts replies, so "has my read landed" is
   * `received >= request`. That is exactly right while every request gets a reply, and it
   * has no way back if one does not — the requested side climbs on every ask and the
   * received side cannot, so ONE lost reply puts them permanently out of step and every
   * future read waits on an ordinal that can never arrive.
   *
   * It is not hypothetical and it is not rare. Two characters on the shadow fleet recorded
   * 600 hops each with a 0% success rate over four and a half hours — 1,180 failures, all
   * `position_confirmation_timeout`, 80% of everything the fleet logged. Fresh keepers in
   * the same room confirmed their position in 345ms, so it was never the room: it was one
   * dropped packet, hours earlier, that the session could not forgive. And drops were the
   * expected case, because fine movement was sending a move AND a read four times a second
   * into a server that discards anything over five (INCOMING_PACKET_THROTTLE).
   *
   * A reader that has waited out its deadline KNOWS those replies are not coming, so it
   * retires them and the next read starts even. The cost is bounded and named: if a reply
   * was merely slow and lands just after being retired, one subsequent read may be
   * satisfied by a snapshot older than it wanted. That is the staleness `confirmPosition`
   * warns about, for one read, against a session that otherwise never moves again.
   */
  retireRoomContents(upTo = this.roomContentsRequested) {
    const target = Math.max(this.roomContentsReceived, Number(upTo) || 0);
    const lost = target - this.roomContentsReceived;
    if (lost > 0) {
      this.roomContentsReceived = target;
      this.roomContentsLost = (this.roomContentsLost ?? 0) + lost;
    }
    return lost;
  }
  players()             { this.send(BP.SEND_PLAYERS); }
  go()                  { this.send(BP.REQ_GO); }

  // BP_SEND_STATS takes a GROUP, and kod validates it: ToCliStats logs
  // "Invalid stat group number" and sends nothing for anything outside 1..4.
  // Group 1 is health/mana/vigor, which is the one that matters for staying
  // alive; 2 is the attributes; 3 and 4 are spell and skill ability levels.
  stats(group = 1)      { this.send(BP.SEND_STATS, u8b(group)); }
  allStats()            { for (const g of [1, 2, 3, 4]) this.stats(g); }

  // ---------------------------------------------------------- game mode

  onGameMessage(op, body) {
    const r = new Reader(body);
    switch (op) {
      // The server does not start streaming the world on its own. It sends
      // BP_LOAD_MODULE, and the real client loads module/char, whose init calls
      // RequestCharacters(). Without that the session sits in game state
      // receiving exactly one message, which is what happened on first contact.
      // The server sends LOAD_MODULE repeatedly as it swaps UI modules around.
      // Only the first one means "pick a character" — responding to every one
      // re-enters selection in a loop.
      case BP.LOAD_MODULE: {
        const mod = body.length >= 2 ? r.u16() : 0;
        if (!this.me) {
          this.log(`module ${mod} — requesting characters`);
          this.send(BP.SEND_CHARACTERS);
        } else if (this.trace) this.log(`module ${mod} (already playing)`);
        break;
      }

      case BP.CHARACTERS: {
        const n = r.u16();
        this.characters = [];
        for (let i = 0; i < n; i++) {
          const id = r.id(), name = r.str(), flags = r.u8();
          this.characters.push({ id, name, flags });
        }
        this.log(`characters: ${this.characters.map(c => `${c.name} (${c.id})`).join(', ') || 'none'}`);
        this.emit('characters', { characters: this.characters });
        // Creating one? Then this list is the moment to do it — BP_NEW_CHARINFO
        // is only legal here, before a character has been taken into the world.
        if (this.onCharacters) { this.onCharacters(this.characters); break; }
        const pick = this.characters.find(c => !this.wantName ||
          c.name.toLowerCase() === this.wantName.toLowerCase()) || this.characters[0];
        if (!pick) { this.fail('account has no characters'); break; }
        this.log(`using character "${pick.name}"`);
        this.me = pick;
        this.send(BP.USE_CHARACTER, u32(objId(pick.id)));
        break;
      }

      // Our own object, and which room we are in. The room id matters: BP_REQ_MOVE
      // carries it, and the server rejects a move whose room does not match.
      case BP.PLAYER: {
        const p = parsePlayer(body);
        this.selfId = p.id;
        this.room.id = p.roomId;
        this.room.security = p.security;
        this.room.flags = p.roomFlags;
        this.room.overrideDepths = p.overrideDepths;
        this.room.collisionInvalidated = null;
        this.roomNameRsc = p.roomNameRsc;
        this.roomRsc = p.roomRsc;
        this.inGame = true;
        this.log(`we are object ${p.id} in room ${p.roomId} (${this.rsc.get(p.roomNameRsc)})`);
        // A new room means the old contents are stale. The real client asks for
        // them on entry; nothing arrives unrequested.
        this.room.objects.clear();
        this.roomContents();
        this.emit('room-entered', { room: p.roomId, roomName: this.rsc.get(p.roomNameRsc) });
        break;
      }

      // ------------------------------------------------------- perception
      //
      // The whole point. Everything below turns packed bytes into ids an agent
      // can name and act on.

      case BP.ROOM_CONTENTS: {
        const res = parseRoomContents(body);
        if (!this.check('ROOM_CONTENTS', res)) {
          this.lastRoomHex = body.toString('hex');
          // A REPLY WE COULD NOT READ IS STILL A REPLY, AND THE ORDINAL MUST MOVE.
          //
          // Breaking here without touching the counter is the second way to fall
          // permanently behind — see retireRoomContents. The server answered; this end
          // could not parse it. Retiring the ordinal costs one unusable snapshot and keeps
          // the session able to read anything ever again, where leaving it costs every
          // future read. The parse failure itself is already reported by `check`.
          this.retireRoomContents(this.roomContentsReceived + 1);
          break;
        }
        const request = ++this.roomContentsReceived;
        this.room.id = res.roomId;
        this.room.objects = new Map(res.objects.map(o => {
          o.appearanceRevision = ++this.appearanceRevision;
          return [o.id, o];
        }));
        // SELF-HEAL A STALE selfId. selfId is set only by the BP.PLAYER packet (one per
        // room entry), and if it ever goes stale — the object map is rebuilt, an id is
        // reassigned — `self` resolves to undefined and the character is BLIND: no
        // position, no room, every tick "no room or position yet", while the session
        // itself stays perfectly alive (so the liveness guard never fires). Re-requesting
        // room contents cannot fix it, because BP.PLAYER is not resent. Character names
        // are unique in this game, and we know ours from character select, so the player
        // object carrying our name in the fresh contents IS us: re-bind selfId to it.
        if (this.inGame && (this.selfId == null || !this.room.objects.has(this.selfId))
            && this.me?.name) {
          const want = String(this.me.name).toLowerCase();
          const mine = res.objects.find(o => (o.flags & OF.PLAYER)
            && String(this.rsc.get(o.nameRsc) ?? o.name ?? '').toLowerCase() === want);
          if (mine) {
            this.log(`self-heal: selfId ${this.selfId} did not resolve; re-bound to ${mine.id} (${this.me.name})`);
            this.selfId = mine.id;
          }
        }
        this.log(`room ${res.roomId}: ${res.count} object(s)`);
        this.emit('room-contents', { room: res.roomId, count: res.count, request,
                                     objects: res.objects.map(o => describeObject(o, this.lookup)) });
        break;
      }

      case BP.CREATE: {
        const res = parseCreate(body);
        if (!this.check('CREATE', res)) break;
        res.object.appearanceRevision = ++this.appearanceRevision;
        this.room.objects.set(res.object.id, res.object);
        this.emit('appeared', { id: res.object.id, what: describeObject(res.object, this.lookup) });
        break;
      }

      case BP.REMOVE: {
        const res = parseRemove(body);
        if (!this.check('REMOVE', res)) break;
        const gone = this.room.objects.get(res.id);
        this.room.objects.delete(res.id);
        this.emit('vanished', { id: res.id, what: gone ? describeObject(gone, this.lookup) : `id ${res.id}` });
        break;
      }

      case BP.MOVE: {
        const res = parseMove(body);
        if (!this.check('MOVE', res)) break;
        const o = this.room.objects.get(res.id);
        // Anything the SERVER says about this object supersedes a prediction, so the flag
        // is cleared here rather than left to rot — a stale `predicted: true` on a
        // confirmed position would make every later reader distrust a good reading.
        if (o) Object.assign(o, { x: res.x, y: res.y, col: res.col, row: res.row, predicted: false });
        // WRITE DOWN WHERE EVERY BODY ACTUALLY WENT.
        //
        // This packet is the only ground truth about walkable space this repository has, and
        // until now it updated a map in memory and was thrown away. It covers EVERY object
        // the room can see — our own characters, a proxied human, a stranger, a monster — so
        // one character standing in a room is an instrument for everyone in it. That is what
        // makes the same record serve travel (a trail through a room, straightened, is a
        // route no planner can be wrong about) and formations (several trails on one clock).
        //
        // Buffered, deduplicated against standing still, and unable to throw: this is the
        // packet path that every session shares.
        // THE ROOM'S STABLE IDENTITY, NOT ITS OBJECT ID.
        //
        // `this.room.id` is the object id, and m59-map.mjs says plainly that objId is NOT
        // stable — the server renumbers objects on every `save game`, which is every 15
        // minutes here. A ledger keyed on it silently re-points at different rooms after a
        // save, which is the worst kind of wrong for a record meant to outlive the session.
        // It is also ambiguous even within one boot: 30 of the 264 object ids are ALSO a
        // room number, so room 1's objId of 6 is indistinguishable from room 6.
        //
        // `roomNameRsc` and `roomRsc` come from BP_PLAYER, are unique per room across the
        // world, and survive a save — which is why m59-world identifies rooms by them and
        // uses the object id only as a last resort. The reader resolves whichever of these
        // it is given; the id is kept alongside for debugging rather than as the key.
        recordSeen({ at: Date.now(),
                     room_name_rsc: this.roomNameRsc ?? null, room_rsc: this.roomRsc ?? null,
                     room: this.room?.id ?? null,
                     id: res.id, name: o?.name ?? null, by: this.character ?? null,
                     player: !!(o && (o.flags & OF.PLAYER)),
                     x: res.x, y: res.y, col: res.col, row: res.row });
        // Our own moves confirm what the server accepted, which is the only
        // trustworthy position — dead reckoning drifts and illegal moves are
        // simply refused with no reply.
        if (res.id === this.selfId) { this.emit('moved', { col: res.col, row: res.row }); break; }
        // SOMEBODY ELSE MOVED, and until now nothing could see it.
        //
        // The room map was being updated from these packets and the fact of the move was
        // then thrown away, so a character standing in a room could tell you where another
        // player IS but never that they had gone anywhere — which makes it impossible to
        // measure anyone's movement but our own. That is the whole basis of a baseline:
        // to know whether 285 seconds to cross a map is the map or is us, somebody has to
        // watch a person do it. See m59-watch.mjs.
        //
        // PLAYERS ONLY. Every monster in a room emits one of these several times a second,
        // and the event ring is 500 entries shared with combat — publishing them all would
        // evict everything else in a busy room within seconds. A player move is rare and
        // is the one worth having.
        //
        // The payload deliberately has no `kind` field: emit() spreads data over the event,
        // so a field of that name would replace the event's own and every listener waiting
        // on 'player-moved' would starve while the emit itself looked fine.
        if (o && (o.flags & OF.PLAYER))
          this.emit('player-moved', { id: res.id, who: this.rsc.get(o.nameRsc) ?? null,
                                      col: res.col, row: res.row, x: res.x, y: res.y });
        break;
      }

      case BP.TURN: {
        const res = parseTurn(body);
        if (!this.check('TURN', res)) break;
        const o = this.room.objects.get(res.id);
        if (o) Object.assign(o, { angle: res.angle, degrees: res.degrees });
        break;
      }

      // THE SKY, WHICH IS A CLOCK. Both bodies use one 19-byte layout
      // (`ExtractNewBackgroundOverlay`, server.c:443):
      //
      //   id u32 | icon u32 | name u32 | animType u8 | group u16 | angle u16 | height u16
      //
      // The palette field the C client reads between `name` and the animation consumes
      // ZERO bytes here: `ExtractPaletteTranslation` peeks one byte and REWINDS unless it
      // is ANIMATE_TRANSLATION (9) or ANIMATE_EFFECT (10), and the server writes
      // ANIMATE_NONE (1). Getting that wrong would shift everything after it by a byte and
      // produce plausible, wrong hours — which is why it is spelled out rather than
      // inferred from the kod's AddPacket calls alone.
      //
      // Height is read as an UNSIGNED word by the real client and cast to int, so the
      // documented -200 floor arrives as 65336 rather than a negative. It is kept as sent
      // and left to the reader; the angle is the field that carries the time.
      case BP.ADD_BG_OVERLAY:
      case BP.CHANGE_BG_OVERLAY: {
        if (body.length < 19) { this.check('BG_OVERLAY', null); break; }
        const sky = {
          id: body.readUInt32LE(0),
          iconRsc: body.readUInt32LE(4),
          nameRsc: body.readUInt32LE(8),
          animation: body.readUInt8(12),
          group: body.readUInt16LE(13),
          angle: body.readUInt16LE(15),
          height: body.readUInt16LE(17),
        };
        sky.name = this.rsc.get(sky.nameRsc) || null;
        // WHICH PUSH THIS WAS, because the two carry different precision. A CHANGE lands
        // ON an hour boundary (`NewGameHour` is what sends it), so it calibrates the clock
        // to the second. An ADD arrives at login, at an arbitrary point inside an hour, so
        // it fixes the hour but places the boundary only within five minutes. A consumer
        // timing a departure to the start of a 35-minute window cares about the difference.
        sky.via = op === BP.CHANGE_BG_OVERLAY ? 'change' : 'add';
        this.sky.set(sky.id, { ...sky, at: Date.now() });
        this.emit('sky', { what: sky.name, ...sky });
        break;
      }

      case BP.REMOVE_BG_OVERLAY: {
        if (body.length >= 4) this.sky.delete(body.readUInt32LE(0));
        break;
      }

      case BP.CHANGE: {
        const res = parseChange(body);
        if (!this.check('CHANGE', res)) break;
        const o = this.room.objects.get(res.object.id);
        // Keep position: BP_CHANGE carries appearance only.
        if (o) Object.assign(o, res.object, {
          x: o.x, y: o.y, col: o.col, row: o.row, angle: o.angle,
          appearanceRevision: ++this.appearanceRevision,
        });

        // PICKING UP A STACKABLE ITEM YOU ALREADY CARRY ARRIVES HERE, NOT AS
        // BP_INVENTORY_ADD. There is no new inventory object to add — the existing
        // one's amount goes up — so the server changes it instead. Without this the
        // count stays stale and, worse, no `got` event ever fires, so picking up
        // four herbs when you already hold four is reported as a REFUSAL even
        // though it worked. Observed live: herbs went 4 -> 8 while loot said
        // "no reply".
        const held = this.inventory.find(i => i.id === res.object.id);
        if (held) {
          const was = held.amount || 1;
          Object.assign(held, res.object);
          const now = held.amount || 1;
          if (now > was)
            this.emit('got', { items: [describeObject(held, this.lookup)],
                               amount: now - was, stacked: true });
        }
        break;
      }

      // The stock client mutates its in-memory BSP when these arrive. Moving sectors
      // alter floor/ceiling heights and wall animation can change passability, so the
      // baked snapshot is no longer authoritative. Until those programs are modeled,
      // fail closed rather than treating the server as a collision oracle.
      //
      // BUT FAIL CLOSED FOR A BOUNDED TIME, NOT FOR EVER — this froze three characters
      // solid within ten minutes of shipping. The flag was cleared in exactly one place,
      // BP_PLAYER, which arrives on a ROOM CHANGE; movement is refused while it is set;
      // and changing rooms requires walking to an exit. So any room that ever animates a
      // sector became a trap: North Barloque and room 589 held Bunsen, Rizzo and Scooter
      // with "could not reach the bank" six times over, and nothing short of a restart,
      // a death or a teleport would have freed them.
      //
      // An animation is a moment, so the refusal is a moment. After it, the walls are
      // still where the bake says — only sector HEIGHTS can have shifted — and a
      // character that may mis-step is a far smaller problem than one that can never
      // move again. `until` is what the movement check reads; see m59-broker.mjs.
      // AND IT SAYS WHICH SECTOR, SO THE REFUSAL DOES NOT HAVE TO BE THE WHOLE ROOM.
      // `HandleSectorMove` (clientd3d/server.c:1453) reads
      //     type(1) sector_num(2) height(2) speed(1)
      // and that sector number is the difference between "one door is moving" and "this
      // room is unusable". The Temple of Qor door lives in room 598 and cycles faster than
      // the 8s window, so every packet re-armed a room-wide block and a character standing
      // anywhere in the Cragged Mountains could never move again — reproduced with the
      // character claimed, six attempts over seventy seconds, never moved a square. The
      // operator had named that room as THE exception to "the geometry does not change".
      case BP.SECTOR_MOVE:
        this.room.collisionInvalidated = {
          opcode: op,
          kind: BPNAME[op] || `bp ${op}`,
          // Absent if the packet is short, and the movement check reads a missing sector
          // as "we do not know which" and keeps refusing the whole room — the same safe
          // reading it already applies to a record with no `until`.
          sector: body.length >= 3 ? body.readUInt16LE(1) : null,
          at: Date.now(),
          until: Date.now() + COLLISION_ANIMATION_MS,
        };
        this.emit('collision-geometry-invalidated', { ...this.room.collisionInvalidated });
        break;

      case BP.WALL_ANIMATE: {
        // WORD wall id, then the stock variable-length Animate, then RA_*. The
        // action byte is not safely "the last byte" until the Animate type has
        // established the exact packet length: accepting trailing bytes could hide
        // a passability change at the canonical action offset.
        const animateType = body.length >= 3 ? body.readUInt8(2) : 0;
        const layout = animateType === 1 ? { length: 6, actionOffset: 5 }
          : animateType === 2 ? { length: 12, actionOffset: 11 }
          : animateType === 3 ? { length: 14, actionOffset: 13 }
          : null;
        const action = layout && body.length === layout.length
          ? body.readUInt8(layout.actionOffset) : 0xff;
        if (action !== 0) {
          this.room.collisionInvalidated = {
            opcode: op,
            kind: BPNAME[op] || `bp ${op}`,
            at: Date.now(),
            until: Date.now() + COLLISION_ANIMATION_MS,
            action,
          };
          this.emit('collision-geometry-invalidated', { ...this.room.collisionInvalidated });
        }
        break;
      }

      // Sector animation changes floor/ceiling bitmap groups, not geometry. Likewise,
      // normal-wall, floor, and ceiling texture replacements are visual only. Above-
      // and below-wall bitmap presence participates in IntersectNode's headroom/step
      // tests, however, so those two CHANGE_TEXTURE forms invalidate collision.
      case BP.SECTOR_ANIMATE:
        break;

      case BP.CHANGE_TEXTURE: {
        // WORD id, WORD texture, BYTE flags. Malformed or unknown flag bits fail
        // conservatively because their effect cannot be classified.
        const flags = body.length === 5 ? body.readUInt8(4) : 0xff;
        if (flags & (0x01 | 0x04 | 0xe0)) {
          this.room.collisionInvalidated = {
            opcode: op,
            kind: BPNAME[op] || `bp ${op}`,
            at: Date.now(),
            until: Date.now() + COLLISION_ANIMATION_MS,
            flags,
          };
          this.emit('collision-geometry-invalidated', { ...this.room.collisionInvalidated });
        }
        break;
      }

      case BP.INVENTORY: {
        const res = parseObjectList(body);
        if (!this.check('INVENTORY', res)) break;
        this.inventory = res.objects;
        // A keepalive asks for the inventory purely to make noise on the socket.
        // Its reply is still worth keeping — it is a free refresh — but emitting
        // an event for it would put a heartbeat into the agent's event stream
        // every 20 seconds and make waitFor return junk.
        if (this.keepalivePending > 0) { this.keepalivePending--; break; }
        this.emit('inventory', { items: res.objects.map(o => describeObject(o, this.lookup)) });
        break;
      }

      // EQUIPMENT, straight from the server's plUsing list. See equipment().
      //
      // The snapshot arrives unbidden behind every inventory request — including the
      // keepalive's, twenty seconds apart — so this state stays current with no
      // traffic of its own. That is also why the event fires only on a CHANGE: a
      // snapshot identical to what we already knew is not news, and emitting it would
      // put a heartbeat in the stream every twenty seconds, which is exactly the junk
      // the INVENTORY case above goes out of its way to avoid.
      case BP.USE_LIST: {
        const res = parseUseList(body);
        if (!this.check('USE_LIST', res)) break;
        this.noteUsing(new Set(res.ids), 'snapshot');
        break;
      }

      // One item started or stopped being used. kod sends these from the same two
      // lines that write plUsing (player.kod:3425, 3543), so they cannot disagree
      // with the snapshot — but they arrive the moment it happens rather than at the
      // next inventory read, which is what makes verifying a wield possible at all.
      case BP.USE:
      case BP.UNUSE: {
        const res = parseObjectId(body);
        if (!this.check(op === BP.USE ? 'USE' : 'UNUSE', res)) break;
        const next = new Set(this.using);
        if (op === BP.USE) next.add(res.id); else next.delete(res.id);
        this.noteUsing(next, op === BP.USE ? 'used' : 'unused', res.id);
        break;
      }

      // ONE object, no count prefix — HandleInventoryAdd extracts a single object and
      // then requires the payload to be exactly consumed.
      case BP.INVENTORY_ADD: {
        const res = parseInventoryAdd(body);
        if (!this.check('INVENTORY_ADD', res)) break;
        this.inventory.push(res.object);
        this.emit('got', { items: [describeObject(res.object, this.lookup)] });
        break;
      }

      case BP.INVENTORY_REMOVE: {
        const res = parseRemove(body);
        if (res.exact) this.inventory = this.inventory.filter(o => o.id !== res.id);
        break;
      }

      case BP.OBJECT_CONTENTS: {
        const res = parseObjectContents(body);
        if (!this.check('OBJECT_CONTENTS', res)) break;
        // STRUCTURED, like `shop` and `vault-list` beside it — `describeObject` returns a
        // human STRING ("chest (id 2578) x1 [get]"), and emitting that made every consumer
        // read `o.name` as undefined while `o.amount || 1` quietly produced a 1. A reading
        // of two items with no names is indistinguishable from a container holding two
        // things nobody can identify, which is how the guild chests mapped as empty.
        this.emit('container', { id: res.containerId,
          items: res.objects.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc),
                                         amount: o.amount || undefined })),
          described: res.objects.map(o => describeObject(o, this.lookup)) });
        break;
      }

      // The one message that carries names as text. Feeding them into the
      // resource table is how a session learns dynamic name resources, which is
      // what makes other players nameable in room contents.
      case BP.PLAYERS: {
        const res = parsePlayers(body);
        if (!this.check('PLAYERS', res)) break;
        this.playersOnline.clear();
        for (const p of res.players) {
          this.rsc.set(p.nameRsc, p.name);
          this.playersOnline.set(p.id, p);
        }
        this.log(`online: ${res.players.map(p => p.name).join(', ') || '(none)'}`);
        this.emit('who', { players: res.players.map(p => ({ id: p.id, name: p.name })) });
        break;
      }

      case BP.PLAYER_ADD: {
        const res = parsePlayerAdd(body);
        if (!res.exact) break;
        this.rsc.set(res.nameRsc, res.name);
        this.playersOnline.set(res.id, res);
        this.emit('logged-on', { id: res.id, name: res.name });
        break;
      }

      case BP.PLAYER_REMOVE: {
        const res = parseRemove(body);
        if (!res.exact) break;
        const p = this.playersOnline.get(res.id);
        this.playersOnline.delete(res.id);
        this.emit('logged-off', { id: res.id, name: p?.name });
        break;
      }

      // A dynamic resource — a player or guild name — pushed to this session.
      case BP.CHANGE_RESOURCE: {
        const res = parseChangeResource(body);
        if (res.exact) this.rsc.set(res.id, res.text);
        break;
      }

      case BP.LOOK: {
        const res = parseLook(body, this.lookup);
        if (!this.check('LOOK', res)) break;
        this.emit('look', { id: res.object.id, what: describeObject(res.object, this.lookup),
                            description: res.text, inscription: res.inscription });
        break;
      }

      // BP_USERCOMMAND ARRIVES AS WELL AS DEPARTS, and this client only ever sent it.
      // A whole second command space was therefore falling into the default case and
      // being dropped in silence — including the ONLY reply the server gives when you
      // look at a person. `look_at` on a character has always timed out and blamed
      // OF_NOEXAMINE for it, because a packet nobody parses and a packet nobody sends
      // look exactly alike from the far end.
      case BP.USERCOMMAND: {
        const uc = body[0];
        if (uc === UC.LOOK_PLAYER) {
          const res = parseLookPlayer(body.subarray(1), this.lookup);
          if (!this.check('LOOK_PLAYER', res)) break;
          // Emitted as `look`, deliberately: to everything upstream this is the same
          // question with the same answer, and the shape of the packet is our problem
          // rather than the caller's. `editable` says the server would accept a
          // description change for this object from us — true for ourselves.
          this.emit('look', { id: res.object.id, what: describeObject(res.object, this.lookup),
                              description: res.text, inscription: null,
                              player: true, editable: res.editable,
                              extra: res.extra, url: res.url });
        } else if (uc === UC.GUILDINFO) {
          const res = parseGuildInfo(body.subarray(1));
          if (!this.check('GUILDINFO', res)) break;
          // KEPT, NOT POLLED, for the same reason abilities are: nothing re-sends it.
          // UC_GUILDINFO arrives only when asked, and `flags` is the only authoritative
          // answer to what this character may do — a question that has to be answerable
          // at the moment of a command, not one round trip later.
          this.guild = {
            id: res.guildId, name: res.name, flags: res.flags,
            password: res.password, rankTitles: res.titles,
            vote: res.vote, members: res.members,
            // The reader's own rank comes off the roster rather than being sent
            // separately, so a member list that somehow omits us leaves it null rather
            // than defaulting to something a permission check would trust.
            rank: res.members.find(m => m.id === this.me?.id)?.rank ?? null,
            readAt: Date.now(),
          };
          this.emit('guild', { what: 'roster', guild: this.guild });
        } else if (uc === UC.GUILD_ASK) {
          const res = parseGuildAsk(body.subarray(1));
          if (!this.check('GUILD_ASK', res)) break;
          // UNPROMPTED, and that is the point: Frular pushes this only after deciding
          // the character is eligible (gcreator.kod:321), so its arrival is the positive
          // evidence that the PFLAG_PKILL_ENABLE gate passed. The refusal is a sentence.
          this.guildPrices = { price: res.price, secret: res.secretPrice, at: Date.now() };
          this.emit('guild', { what: 'may-create', prices: this.guildPrices });
        } else if (uc === UC.GUILD_LIST) {
          const res = parseGuildList(body.subarray(1));
          if (!this.check('GUILD_LIST', res)) break;
          this.guildList = { ...res, at: Date.now() };
          this.emit('guild', { what: 'list', list: this.guildList });
        } else if (uc === UC.GUILD_HALLS) {
          const res = parseGuildHalls(body.subarray(1));
          if (!this.check('GUILD_HALLS', res)) break;
          // The name is a 4-byte resource id here, unlike every other name on this
          // opcode, so it is resolved rather than read. `rentDaily` keeps its factor in
          // its name: the wire carries 24 hours of an hourly rate.
          this.guildHalls = {
            halls: res.halls.map(h => ({ ...h, name: this.rsc.get(h.nameRsc) || null })),
            at: Date.now(),
          };
          this.emit('guild', { what: 'halls', halls: this.guildHalls });
        } else {
          this.log(`unhandled user command ${uc} (${body.length - 1} bytes)`);
        }
        break;
      }

      case BP.BUY_LIST: {
        const res = parseBuyList(body);
        this.buyList = res;
        this.emit('shop', {
          seller: describeObject(res.seller, this.lookup),
          sellerId: res.seller.id,
          items: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), cost: o.cost,
                                      amount: o.amount || undefined })),
        });
        break;
      }

      // WHAT THIS CHARACTER HAS ON DEPOSIT — the only statement of it that exists.
      //
      // A vault is per-player storage (`Storage.plStored` is keyed by owner, storage.kod:28)
      // and nothing pushes its contents. The server sends them only in answer to a
      // withdrawal request, in exactly the BUY_LIST shape — object, count, then object and
      // a u32 each (user.kod:5741; HandleWithdrawalList, server.c:1195) — where the "cost"
      // is `GetVaultRetrievalFee` rather than a price.
      //
      // The opcode was declared here and never parsed, which is the failure mode this
      // repository has already paid for once with UC_LOOK_PLAYER: a packet nobody parses is
      // indistinguishable from a packet nobody sends, and the conclusion drawn from the
      // silence was that the protocol could not answer. It can.
      case BP.WITHDRAWAL_LIST: {
        const res = parseBuyList(body);
        if (!this.check('WITHDRAWAL_LIST', res)) break;
        this.vaultList = {
          vaultman: describeObject(res.seller, this.lookup),
          vaultmanId: res.seller.id,
          items: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), fee: o.cost,
                                       amount: o.amount || undefined })),
          at: Date.now(),
        };
        this.emit('vault-list', this.vaultList);
        break;
      }

      // ------------------------------------------------------------ trading
      //
      // Someone is offering us something. This is the only unsolicited message that
      // requires a reply to make progress: until we counteroffer, the other side
      // cannot accept, and the trade sits open.
      case BP.OFFER: {
        const res = parseOffer(body);
        if (!this.check('OFFER', res)) break;
        this.trade = {
          revision: ++this.tradeRevision,
          updatedAt: Date.now(),
          role: 'recipient',
          withId: res.from.id,
          withName: this.rsc.get(res.from.nameRsc),
          theirs: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), amount: o.amount || undefined })),
          ours: [],
          mayAccept: false,
        };
        this.emit('offered-to-us', { ...this.trade,
          note: 'reply with a counteroffer (which may be empty) — until you do, neither side can complete' });
        break;
      }

      // The echo of what the server actually put on OUR side of the table. Worth
      // reading rather than assuming: quantities are silently clamped to what we
      // really hold, so this is the authoritative statement of our own offer.
      case BP.OFFERED: {
        const res = parseOfferItems(body);
        if (!this.check('OFFERED', res)) break;
        this.trade = { ...(this.trade || { role: 'offerer' }), role: this.trade?.role || 'offerer',
                       revision: ++this.tradeRevision, updatedAt: Date.now(),
                       withId: this.trade?.withId ?? this.pendingOfferTo?.id,
                       withName: this.trade?.withName ?? this.pendingOfferTo?.name,
                       ours: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), amount: o.amount || undefined })) };
        this.pendingOfferTo = null;
        this.emit('offer-sent', { ours: this.trade.ours });
        break;
      }

      // Their side of the table — AND our permission to accept. UserCounterOffer sets
      // pbOffer_OtherAccepted when it sends this, and accepting without it is logged
      // as an ALERT and cancels the trade.
      case BP.COUNTEROFFER: {
        const res = parseOfferItems(body);
        if (!this.check('COUNTEROFFER', res)) break;
        this.trade = { ...(this.trade || {}), revision: ++this.tradeRevision, updatedAt: Date.now(),
                       theirs: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), amount: o.amount || undefined })),
                       mayAccept: true };
        this.emit('countered', { theirs: this.trade.theirs, may_accept: true });
        break;
      }

      case BP.COUNTEROFFERED: {
        const res = parseOfferItems(body);
        if (!this.check('COUNTEROFFERED', res)) break;
        this.trade = { ...(this.trade || {}), revision: ++this.tradeRevision, updatedAt: Date.now(),
                       ours: res.items.map(o => ({ id: o.id, name: this.rsc.get(o.nameRsc), amount: o.amount || undefined })) };
        this.emit('counter-sent', { ours: this.trade.ours });
        break;
      }

      // Overloaded, and the overload matters: this is sent on cancel, on every
      // mid-flight validation failure, AND to the non-accepting side when a trade
      // SUCCEEDS. So it means "the trade is over", not "the trade failed" — check the
      // inventory to find out which.
      case BP.OFFER_CANCELED: {
        const was = this.trade;
        this.tradeRevision++;
        this.trade = null;
        this.pendingOfferTo = null;
        this.emit('trade-ended', { was,
          note: 'the server sends this both when a trade is cancelled and to the other side when one completes — compare inventory to tell which' });
        break;
      }

      // Stats. The important ones for staying alive are health (1), mana (2) and
      // vigor — vigor gates running and some skill costs, and the server snaps a
      // character back if it tries to run without it.
      // WHY HEALTH FALLS WHEN NOTHING IS HITTING US. Both of these were declared in the BP
      // table and never handled, so a sickness was invisible and every reader downstream had
      // to guess. `restUntil` aborts on falling health and a spot that fails a rest is
      // discredited for good, so a poisoned character was quietly burning good walls out of
      // the book on every rest it took.
      case BP.ADD_ENCHANTMENT: {
        const res = parseAddEnchantment(body);
        if (!this.check('ADD_ENCHANTMENT', res)) break;
        const o = res.object;
        this.enchantmentsById.set(o.id, {
          id: o.id, type: res.type, nameRsc: o.nameRsc,
          name: this.rsc.get(o.nameRsc) ?? null, at: Date.now(),
        });
        this.emit('enchantment', { added: this.enchantmentsById.get(o.id) });
        break;
      }
      case BP.REMOVE_ENCHANTMENT: {
        const res = parseRemoveEnchantment(body);
        if (!this.check('REMOVE_ENCHANTMENT', res)) break;
        const gone = this.enchantmentsById.get(res.id) ?? { id: res.id, type: res.type };
        this.enchantmentsById.delete(res.id);
        this.emit('enchantment', { removed: gone });
        break;
      }

      case BP.STAT: {
        const res = parseStat(body, this.lookup);
        if (!this.check('STAT', res)) break;
        this.noteStat(res.stat);
        break;
      }

      // A whole group at once — the reply to an explicit stats(n). That is what makes
      // it a READ rather than a push, which is the difference between "we asked and
      // this is the answer" and "something just changed". Only the former refreshes
      // the ability cache's age.
      case BP.STAT_GROUP: {
        const res = parseStatGroup(body, this.lookup);
        if (!this.check('STAT_GROUP', res)) break;
        for (const s of res.stats) this.noteStat(s, { bulk: true });
        // An empty group is still an answer: a character with no spells at all would
        // otherwise never be marked as read and would be re-asked for ever.
        if (res.group === STAT_GROUP.SPELLS) this.abilitiesAt.spells = Date.now();
        if (res.group === STAT_GROUP.SKILLS) this.abilitiesAt.skills = Date.now();
        break;
      }

      case BP.SPELLS: {
        const res = parseSpells(body);
        if (!this.check('SPELLS', res)) break;
        this.spells = res.spells;
        // The list is what puts names to the ability numbers, and the two arrive in
        // either order — a BP_STAT can land before the list that explains it.
        this.nameAbilities();
        this.emit('spells', { spells: res.spells.map(s =>
          ({ id: s.id, name: this.rsc.get(s.nameRsc), targets: s.numTargets, school: s.school })) });
        break;
      }

      case BP.SKILLS: {
        const res = parseSkills(body);
        if (!this.check('SKILLS', res)) break;
        this.skills = res.skills;
        this.nameAbilities();
        this.emit('skills', { skills: res.skills.map(s => ({ id: s.id, name: this.rsc.get(s.nameRsc) })) });
        break;
      }

      // Speech and prose. Both go through CheckServerMessage, so the resource
      // table is what makes them readable at all.
      case BP.SAID: {
        const res = parseSaid(body, this.lookup);
        if (!this.check('SAID', res)) break;
        const said = { speaker: res.speaker, name: this.rsc.get(res.nameRsc),
                       type: SAY_NAME[res.sayType] || res.sayType, text: res.text };
        this.onSaid?.(said);
        this.log(`SAID [${said.type}] ${said.name}: ${said.text}`);
        this.emit('said', said);
        // Speech goes to the chat ring as well. Not everything on this opcode is
        // speech: SAY_RESOURCE (5) and SAY_MESSAGE (7) are the server narrating
        // through a character — a shopkeeper's canned line, a sign — and putting
        // those in the transcript is how the untrusted-input boundary gets blurred.
        // See IS_SPEECH for the list and blakston.khd:2179 for the constants.
        if (IS_SPEECH.has(res.sayType)) {
          this.noteChat({
            channel: said.type, speaker: said.speaker, name: said.name, text: said.text,
            self: this.selfId != null && said.speaker === this.selfId,
          });
        }
        break;
      }

      // System prose: combat, refusals, the server telling you what just happened to
      // you. Deliberately NOT chat — nobody said it, and it is the high-rate stream
      // that the separate chat ring exists to be safe from.
      case BP.MESSAGE:
      case BP.SYS_MESSAGE: {
        const res = parseStringMessage(body, this.lookup);
        if (res.text) {
          this.log(`message: ${res.text}`);
          this._noteCombatOutcome?.(res.text);
          this.emit('message', { text: res.text });
        }
        break;
      }

      // The new character exists and this is its object id. It is NOT in the
      // world yet — BP_USE_CHARACTER still has to be sent.
      case BP.CHARINFO_OK: {
        const id = body.length >= 4 ? objId(body.readUInt32LE(0)) : null;
        // The raw bytes travel with the event. Character creation happens once and
        // cannot be re-run without another suicide, so a run that comes back wrong is
        // expensive to reproduce — carrying the payload means the next attempt can be
        // diagnosed from the recording instead of by repeating the experiment.
        this.log(`character created, object ${id} (raw ${body.toString('hex')})`);
        this.emit('charinfo-ok', { id, raw: body.toString('hex'), bytes: body.length });
        break;
      }

      // Refused, and the server does not say why — every rejection in
      // system.kod:3717 funnels into this one bare opcode. Name taken, name
      // containing a monster's, bad gender, or simply not a first-time
      // character all look identical from here.
      case BP.CHARINFO_NOT_OK:
        this.log('character creation refused');
        this.emit('charinfo-not-ok', {});
        break;

      case BP.PASSWORD_OK:
        this.log('password changed');
        this.emit('password-ok', {});
        break;

      // blakserv/game.c sends this when it declines. Note the check it guards is
      // `s->account->password == password` — a POINTER comparison between the stored
      // password and a local buffer, so it is never true and the old password is in
      // practice never verified. We send it correctly anyway: the check may be fixed,
      // and relying on a server bug is not a design.
      case BP.PASSWORD_NOT_OK:
        this.log('password change refused');
        this.emit('password-not-ok', {});
        break;

      case BP.QUIT:
        this.log('server ended the session');
        this.emit('quit', {});
        break;

      // Keepalive: the server expects the round trip echoed back or it will
      // eventually consider the session dead.
      case BP.ROUNDTRIP1:
        this.send(BP.ROUNDTRIP2, body.subarray(0, 4));
        break;

      default:
        if (this.trace) this.log(`<- ${BPNAME[op] || `bp ${op}`} (${body.length}b)`);
    }
  }

  // blakserv/game.c:244 — one LCG per seed, then one seed selected by the last.
  // Unsigned 32-bit wraparound happens BEFORE the modulus, and the initial seeds
  // are arbitrary 32-bit values, so the first step genuinely overflows. Doing the
  // arithmetic in plain doubles is safe here: seed * 9301 stays under 2^45, which
  // is exact, so an explicit % 2^32 reproduces C's wrapping faithfully.
  securityStep() {
    const s = this.seeds;
    for (let i = 0; i < s.length; i++)
      s[i] = ((s[i] * 9301 + 49297) % 4294967296) % 233280;
    return s[s.length - 1] % (s.length - 1);
  }

  // In game mode the "crc16" header field is not a checksum — it is an anti-spoof
  // value the server recomputes from its own copy of the stream (game.c:174-184).
  // `security` is declared unsigned short there, so everything truncates to 16
  // bits. Get this wrong and the server logs "invalid security account N", sets
  // seeds_hacked, and drops the connection with no message to the client.
  //
  // The opcode byte is SIGN-EXTENDED. `msg.data` is `char data[]` (blakserv.h:189)
  // and MSVC's char is signed, so `(unsigned int)msg.data[0] << 4` on an opcode
  // >= 0x80 becomes 0xFFFFF9B0-ish rather than 0x09B0, and truncating into
  // `unsigned short security` keeps the high nibble. Treating the byte as
  // unsigned here differs from the server by exactly 0xF000 for any opcode with
  // the top bit set.
  //
  // TWO opcodes this client sends are >= 128: BP_USERCOMMAND (155) and
  // BP_REQ_DEPOSIT (230). So the whole user-command surface — rest, stand,
  // safety, deposit, withdraw, balance, the guild commands — silently killed the
  // session, and it stayed hidden because resting produces no reply even when it
  // works, so a dropped connection was indistinguishable from the documented
  // silence. (An earlier version of this comment said ONE; enumerate the sends
  // rather than trusting the count, because a second one is just as fatal.)
  // ...AND WHETHER `char` IS SIGNED IS THE SERVER'S ARCHITECTURE, NOT THE PROTOCOL.
  // `msg.data` is `char data[]` and the server casts `(unsigned int)msg.data[0] << 4`
  // (game.c:179). Plain `char` is SIGNED on x86 (MSVC and gcc alike) and UNSIGNED on
  // ARM, so the same opcode 155 gives the server 0xF9B0 on an x86 host and 0x09B0 on
  // an aarch64 one -- differing by exactly the 0xF000 described above, in whichever
  // direction the client did not choose. Measured 2026-08-23 against an aarch64
  // container: every BP_USERCOMMAND was answered with "found invalid security
  // account 3" in the server log and the connection dropped, with nothing on the wire.
  //
  // So the convention is a PROPERTY OF THE PEER. It is NOT auto-detected: the default
  // is the x86 answer, which is what the public servers are, and M59_MSG_CHAR_SIGNED=0
  // selects the ARM one for a lab server known to be one. Detection would mean sending
  // a >=128 opcode and watching for a drop, which COSTS THE SESSION each time it
  // guesses wrong -- and a wrong guess is silent on the wire, visible only as
  // "invalid security" in the SERVER's log, which a client cannot read.
  //
  // Nothing below opcode 128 is affected either way. That is why a bot that only walks
  // and fights works perfectly against both, and why this stayed invisible for so long:
  // it is exactly the user-command surface that breaks, and resting produces no reply
  // even when it works.
  gameSecurity(payload) {
    const streamIdx = this.securityStep();
    let sec = this.seeds[streamIdx] & 0xffff;
    sec ^= payload.length;
    const op = this.charSigned ? ((payload[0] << 24) >> 24) : payload[0];
    sec ^= op << 4;
    sec ^= crc16(payload);
    return sec & 0xffff;
  }

  send(op, ...parts) {
    const payload = Buffer.concat([Buffer.from([op]), ...parts]);
    if (this.state === 'game' && this.seeds) {
      const out = Buffer.alloc(HEADER + payload.length);
      out.writeUInt16LE(payload.length, 0);
      out.writeUInt16LE(this.gameSecurity(payload), 2);
      out.writeUInt16LE(payload.length, 4);
      out.writeUInt8(this.epoch & 0xff, 6);
      payload.copy(out, HEADER);
      this.sock.write(out);
      this._outboundActivity();
      return;
    }
    this.sock.write(frame(payload, 0));
    this._outboundActivity();
  }

  sendLogin() {
    if (!this.user) {
      // AP_GETLOGIN arrived before login() was called — the socket connected
      // before credentials were set. Close the socket; the caller will retry.
      console.error('[m59-client] sendLogin called with no user — closing socket');
      this.sock?.destroy(); return;
    }
    this.log(`sending login as "${this.user}"`);
    this.send(AP.LOGIN, Buffer.from([MAJOR_REV, MINOR_REV]), sysinfo(),
              pstr(this.user), pbuf(mdpass(this.pass)));
  }

  // clientd3d/protocol.c: AP_REQ_GAME is INT, INT, STRING — download_time,
  // an encoded version number, and the hostname from the ini. Sending only the
  // one <time> field that doc/login.txt documents leaves the session sitting in
  // the main menu forever, with no error.
  //
  // login.c:224 — encodednum = ((MAJOR*100 + MINOR) * P_CATCH) + P_CATCH,
  // with P_CATCH = 3 (client.h:68). It is a version handshake, so it has to be
  // computed rather than stubbed.
  reqGame() {
    const encoded = ((MAJOR_REV * 100 + MINOR_REV) * P_CATCH) + P_CATCH;
    const a = Buffer.alloc(4); a.writeInt32LE(0, 0);            // download_time
    const b = Buffer.alloc(4); b.writeInt32LE(encoded, 0);
    this.log(`requesting game (encodednum ${encoded})`);
    this.send(AP.REQ_GAME, a, b, pstr(this.host));
  }

  // THE SERVER HANGS UP A SESSION IT HAS NOT HEARD FROM IN 30 SECONDS.
  //
  // blakserv/game.c:99 — `GetTime() - game_last_message_time > ConfigInt(INACTIVE_GAME)`
  // and INACTIVE_GAME defaults to 30 (config.c:99). The comment there says "even
  // ping", i.e. the real client is expected to keep the socket talking. Nothing
  // is sent to the client when this fires: the session simply ends, and the next
  // request fails with "not in game". For an agent that is a disaster, because
  // thinking for half a minute between two tool calls is completely normal, and
  // the symptom looks like a broker bug rather than a timeout.
  //
  // GameProcessSessionBuffer (game.c:136) stamps game_last_message_time on ANY
  // inbound packet, before it even parses one, so any legal request will do.
  //
  // NOT BP_PING, though — that is the trap. GameEchoPing (game.c:368) answers a
  // ping by choosing a fresh `secure_token`, and from then on the server XORs the
  // opcode byte of every packet it sends with that token (commcli.c:162), walking
  // it along a "redbook" string per packet. A client that pings without also
  // implementing that handshake would have its whole inbound stream scrambled.
  // The token starts at 0 and stays there as long as we never ping, which is why
  // this client can read the wire at all. So the heartbeat is BP_REQ_INVENTORY:
  // no parameters (sprocket.c:34), no side effects, and its reply is a free
  // refresh of the inventory we keep anyway.
  _outboundActivity() {
    this.lastTxAt = Number(this.keepaliveClock.now());
    // Outbound and inbound activity only move their deadlines later. Keep an
    // already-earlier one-shot: when it wakes it will recompute once, avoiding a
    // clear/allocate pair for every movement packet.
    if (this.keepaliveEveryMs !== null && this.state === 'game' && this.keepaliveTimer === null)
      this._armKeepalive();
  }

  _keepaliveDeadline(now) {
    const started = Number.isFinite(this.keepaliveStartedAt) ? this.keepaliveStartedAt : now;
    const lastTx = Number.isFinite(this.lastTxAt) ? this.lastTxAt : started;
    const lastRx = Number.isFinite(this.keepaliveLastRxAt)
      ? this.keepaliveLastRxAt
      : started;
    // A sent probe temporarily advances this bound so a missing reply cannot create
    // a zero-delay loop. The 45s liveness guard will close a genuinely dead session.
    const probeBasis = Number.isFinite(this.keepaliveLastProbeAt)
      ? Math.max(lastRx, this.keepaliveLastProbeAt)
      : lastRx;
    return Math.min(
      lastTx + this.keepaliveEveryMs,
      probeBasis + KEEPALIVE_REPLY_BOUND_MS,
    );
  }

  _scheduleKeepalive(delayMs) {
    if (this.keepaliveTimer !== null) {
      this.keepaliveClock.clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.keepaliveEveryMs === null || this.state !== 'game') return;

    let handle = null;
    const fire = () => {
      // A cleared timeout may already be queued. Only the currently armed handle owns
      // the deadline, so stale callbacks cannot create a second heartbeat or timer.
      if (this.keepaliveTimer !== handle) return;
      this.keepaliveTimer = null;
      this._keepaliveDue();
    };
    handle = this.keepaliveClock.setTimeout(fire, Math.max(0, delayMs));
    this.keepaliveTimer = handle;
    handle?.unref?.();
  }

  _armKeepalive() {
    if (this.keepaliveEveryMs === null || this.state !== 'game') return;
    const now = Number(this.keepaliveClock.now());
    this._scheduleKeepalive(Math.max(0, this._keepaliveDeadline(now) - now));
  }

  _keepaliveDue() {
    if (this.keepaliveEveryMs === null || this.state !== 'game') return;
    const now = Number(this.keepaliveClock.now());
    const remainingMs = this._keepaliveDeadline(now) - now;
    if (remainingMs > 0) {
      this._scheduleKeepalive(remainingMs);
      return;
    }
    this.keepaliveLastProbeAt = now;
    try {
      this.keepalivePending++;
      this.send(BP.REQ_INVENTORY);
      // send() records the successful write and arms the next idle deadline.
    } catch (error) {
      this.keepalivePending = Math.max(0, this.keepalivePending - 1);
      // gameSecurity() advances the stream before socket.write(). A synchronous write
      // failure therefore cannot be retried safely: another frame would use seeds the
      // server never saw. Retire the scheduler and let normal connection recovery win.
      this.log(`keepalive write failed: ${error?.message || error}`);
      this.state = 'closed';
      this.stopKeepalive();
      try { this.sock?.destroy?.(); } catch { /* already terminal */ }
    }
  }

  startKeepalive(everyMs = 20000) {
    const interval = Number(everyMs);
    if (!Number.isFinite(interval) || interval <= 0)
      throw new RangeError('keepalive interval must be a positive finite number');
    this.stopKeepalive();
    this.keepaliveEveryMs = interval;
    this.keepaliveStartedAt = Number(this.keepaliveClock.now());
    if (!Number.isFinite(this.lastTxAt)) this.lastTxAt = this.keepaliveStartedAt;
    this._armKeepalive();
    return this;
  }

  stopKeepalive() {
    if (this.keepaliveTimer !== null) this.keepaliveClock.clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.keepaliveEveryMs = null;
    this.keepaliveStartedAt = null;
    this.keepaliveLastProbeAt = null;
    this.keepalivePending = 0;
  }

  async login(user, pass, waitMs = 15000) {
    this.user = user; this.pass = pass;
    await this.connect();
    const t0 = Date.now();
    while (this.state !== 'game' && !this.error && Date.now() - t0 < waitMs)
      await new Promise(r => setTimeout(r, 120));
    if (this.state !== 'game') throw new Error(this.error || `stuck in state "${this.state}"`);
    this.startKeepalive();
    return this;
  }
}

// A perception smoke test. The pass condition is the invariant from
// HandleRoomContents: the cursor must land exactly at the end of every payload.
// With a packed stream there is no other way to know a parse was right — a
// plausible-looking object list can be entirely fabricated by a one-byte slip.
if (import.meta.filename === process.argv[1]) {
  const [user, pass, host, port] = process.argv.slice(2);
  if (!user || !pass) {
    console.error('usage: m59-client.mjs <username> <password> [host] [port]');
    process.exit(1);
  }
  const c = new M59Client({ host, port: port && Number(port) });
  try {
    await c.login(user, pass);
    console.log(`\nin game as object ${c.selfId}, resource table has ${c.rsc.size} strings`);

    // Give the server time to push the room, then ask for everything.
    await new Promise(r => setTimeout(r, 1500));
    c.roomContents(); c.players(); c.requestInventory(); c.stats(1);
    await new Promise(r => setTimeout(r, 2000));

    const room = c.describeRoom();
    console.log(`\nroom ${room.room} — ${room.roomName} — ${room.count} object(s)`);
    for (const line of room.objects) console.log(`  ${line}`);

    if (c.inventory.length) {
      console.log('\ncarrying:');
      for (const o of c.inventory) console.log(`  ${describeObject(o, c.lookup)}`);
    }
    if (c.playersOnline.size)
      console.log(`\nonline: ${[...c.playersOnline.values()].map(p => p.name).join(', ')}`);

    // Look at one thing, to exercise the message formatter end to end.
    const target = [...c.room.objects.values()].find(o => o.id !== c.selfId);
    if (target) {
      c.look(target.id);
      const { events } = await c.waitFor({ kinds: 'look', timeoutMs: 3000 });
      for (const e of events) console.log(`\nlook at ${e.what}:\n  ${e.description}`);
    }

    console.log(`\ngame-mode messages: ${c.gameMsgs}`);
    const top = [...c.opcodeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    console.log('busiest opcodes:', top.map(([op, n]) => `${BPNAME[op] || op}x${n}`).join(' ') || '(none)');

    if (c.parseErrors.length) {
      console.log(`\nPARSE FAILURES (${c.parseErrors.length}) — the invariant did not hold:`);
      for (const e of c.parseErrors.slice(0, 10)) console.log(`  ${e.what}: ${e.why}`);
      if (c.lastRoomHex) console.log(`\nroom contents hex:\n${c.lastRoomHex}`);
      process.exit(2);
    }
    console.log('\nall payloads parsed exactly to their end.');
    process.exit(0);
  } catch (e) {
    console.error(`\nfailed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}
