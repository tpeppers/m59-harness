#!/usr/bin/env node
// Perception: the server->client parsers, ported from clientd3d/server.c.
//
// This is the half of the protocol the repository did not have. An agent could
// already speak and act, but every interesting action needs a target object id,
// and ids only arrive inside BP_ROOM_CONTENTS. That message is a packed stream
// with no per-item length, so a sub-parser that consumes one byte too few
// desynchronises the cursor and every later object is garbage — silently. The
// C client's own defence is the invariant at the end of HandleRoomContents:
//
//     len -= (ptr - start);
//     if (len != 0) return false;
//
// Every parser here reports the same thing, so the caller can assert it. Nothing
// in this file is guessed; the authority for each field is named at its parser.

// ---------------------------------------------------------------- constants

// include/proto.h
export const SIZE = {
  ID: 4, COORD: 2, LIST_LEN: 2, STRING_LEN: 2, AMOUNT: 4, COST: 4,
  ANGLE: 2, ANIMATE: 1, ANIMATE_GROUP: 2, HOTSPOT: 1, VALUE: 4,
};

export const ANIMATE = {
  NONE: 1, CYCLE: 2, ONCE: 3,
  FLOOR_LIFT: 4, CEILING_LIFT: 5, ROOM_BITMAP: 6, SCROLL: 7, FLICKER: 8,
  TRANSLATION: 9, EFFECT: 10,
};

export const CLIENT_TAG_NORMAL = 0, CLIENT_TAG_NUMBER = 1;
export const LIGHT_FLAG_NONE = 0x0000;
export const MAX_ANGLE = 4096;          // proto.h — a full turn
export const KOD_FINENESS = 64;         // clientd3d/drawdefs.h — units per square

// clientd3d/object.h — the top nibble of an id is a client-side type tag.
export const objId  = id => id & 0x0fffffff;
export const objTag = id => (id >>> 28) & 0xf;
export const isNumberObj = id => objTag(id) === CLIENT_TAG_NUMBER;

// Object flags, include/proto.h:357. These are what turn a list of names into a
// list of affordances: the server has already decided what a player may do with
// each object and says so in these bits. An agent that filters on them never
// wastes a request — and requests are scarce, since the server drops everything
// past five per second.
export const OF = {
  NOMOVEON_MASK: 0x00000003,   // see MOVEON below — what happens if you step on it
  PLAYER:        0x00000004,
  ATTACKABLE:    0x00000008,   // a legal target for BP_REQ_ATTACK
  GETTABLE:      0x00000010,   // BP_REQ_GET will be considered
  CONTAINER:     0x00000020,   // BP_SEND_OBJECT_CONTENTS makes sense
  NOEXAMINE:     0x00000040,   // set means BP_REQ_LOOK will NOT work
  OFFERABLE:     0x00000200,   // can be traded with
  BUYABLE:       0x00000400,   // a shopkeeper: BP_REQ_BUY works
  ACTIVATABLE:   0x00000800,
  APPLYABLE:     0x00001000,
  SAFETY:        0x00002000,   // only meaningful on ourselves
  PLAYER_MASK:   0x0001C000,
  ENEMY:         0x02000000,
  FRIEND:        0x04000000,
  GUILDMATE:     0x08000000,
};

// The low two bits of the flags say what happens when you walk ONTO the object
// (include/proto.h:415). TELEPORTER is the one that matters: it is how the game
// marks a portal, and it is the only signal a client gets — a portal's name is just
// "portal" and its `can` list is nothing but "look", so it is otherwise
// indistinguishable from scenery. An agent that ignores this bit and dies is stuck
// in the Underworld, whose only exits are teleporters.
export const MOVEON = { YES: 0, NO: 1, TELEPORTER: 2, NOTIFY: 3 };
export const moveOn = flags => flags & OF.NOMOVEON_MASK;
export const isTeleporter = flags => moveOn(flags) === MOVEON.TELEPORTER;
export const blocksMovement = flags => moveOn(flags) === MOVEON.NO;

// What the server says you may do with this thing. Reading it from the flags
// rather than guessing from the name is the difference between an agent that
// tries to attack a table and one that does not.
export function affordances(flags) {
  const a = [];
  if (flags & OF.ATTACKABLE)  a.push('attack');
  if (flags & OF.GETTABLE)    a.push('get');
  if (flags & OF.CONTAINER)   a.push('open');
  if (flags & OF.BUYABLE)     a.push('buy');
  if (flags & OF.OFFERABLE)   a.push('offer');
  if (flags & OF.ACTIVATABLE) a.push('activate');
  if (flags & OF.APPLYABLE)   a.push('apply');
  if (isTeleporter(flags))    a.push('teleports-you');
  if (!(flags & OF.NOEXAMINE)) a.push('look');
  return a;
}

// A cursor over a payload. Every Extract() in the C client maps to one call, so
// a port reads as a transcription rather than as offset arithmetic.
export class Reader {
  constructor(buf, p = 0) { this.b = buf; this.p = p; }
  get left() { return this.b.length - this.p; }
  need(n, what) {
    if (this.left < n) throw new Error(`short read: need ${n} for ${what}, ${this.left} left at offset ${this.p}`);
  }
  u8()  { this.need(1, 'u8');  return this.b.readUInt8(this.p++); }
  i8()  { this.need(1, 'i8');  return this.b.readInt8(this.p++); }
  u16() { this.need(2, 'u16'); const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  i16() { this.need(2, 'i16'); const v = this.b.readInt16LE(this.p);  this.p += 2; return v; }
  u32() { this.need(4, 'u32'); const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  i32() { this.need(4, 'i32'); const v = this.b.readInt32LE(this.p);  this.p += 4; return v; }
  id()  { return this.u32(); }
  str() {
    const n = this.u16(); this.need(n, `string of ${n}`);
    const s = this.b.subarray(this.p, this.p + n).toString('latin1');
    this.p += n; return s;
  }
  peek() { this.need(1, 'peek'); return this.b.readUInt8(this.p); }
  skip(n) { this.need(n, 'skip'); this.p += n; }
  hex(from = 0, to = this.b.length) { return this.b.subarray(from, to).toString('hex'); }
}

// -------------------------------------------------------- packed sub-parsers

// ExtractPaletteTranslation (server.c:191). The trap: this field is OPTIONAL and
// self-identifying. It reads one byte, and if that byte is neither
// ANIMATE_TRANSLATION nor ANIMATE_EFFECT it REWINDS — the byte belongs to the
// animation that follows. Consume it unconditionally and everything after
// desynchronises by one.
export function extractPaletteTranslation(r) {
  const type = r.peek();
  if (type === ANIMATE.TRANSLATION) { r.skip(1); return { translation: r.u8(), effect: 0 }; }
  if (type === ANIMATE.EFFECT)      { r.skip(1); return { translation: 0, effect: r.u8() }; }
  return { translation: 0, effect: 0 };
}

// ExtractAnimation (server.c:222). Variable length by animation type. The C
// version's default branch consumes only the type byte and warns — which means
// the stream is already ruined, so here it is a hard error instead. kod only ever
// sends 1, 2 or 3 for an object (the other ANIMATE_* values are sector and wall
// animations carried by different messages), so reaching this is a real bug.
export function extractAnimation(r) {
  const animation = r.u8();
  switch (animation) {
    case ANIMATE.NONE:
      return { animation, group: r.u16() };
    case ANIMATE.CYCLE:
      return { animation, period: r.u32(), groupLow: r.u16(), groupHigh: r.u16() };
    case ANIMATE.ONCE:
      return { animation, period: r.u32(), groupLow: r.u16(), groupHigh: r.u16(), groupFinal: r.u16() };
    default:
      throw new Error(`unknown animation type ${animation} at offset ${r.p - 1} — stream is desynchronised`);
  }
}

// ExtractOverlay / ExtractOverlays (server.c:267,291). Count-prefixed and each
// entry is itself variable length, so this is the highest-risk sub-parser.
export function extractOverlays(r) {
  const n = r.u8();
  const out = [];
  for (let i = 0; i < n; i++) {
    const iconRsc = r.u32();
    const hotspot = r.i8();                     // signed: negative means "behind"
    const pal = extractPaletteTranslation(r);
    const animate = extractAnimation(r);
    out.push({ iconRsc, hotspot, ...pal, animate });
  }
  return out;
}

// ExtractDLighting (server.c:300). Two bytes of flags, and the rest only if the
// flags are not LIGHT_FLAG_NONE. NEXT-STEPS.md's sketch of the object layout
// omitted this field entirely — but ExtractObject's `includeLight` parameter
// defaults to true (clientd3d/server.h:48) and ExtractNewRoomObject calls it with
// two arguments, so room contents DO carry lighting. Confirmed on the sending
// side: ToCliObject calls @SendLightingInformation, whose Object default is
// AddPacket(2,0) (kod/object.kod:510).
export function extractDLighting(r) {
  const flags = r.u16();
  if (flags === LIGHT_FLAG_NONE) return { flags, intensity: 0, color: 0 };
  return { flags, intensity: r.u8(), color: r.u16() };
}

// ExtractCoordinates (server.c:176). Y FIRST, then X — both in kod fine units,
// where a value is row * 64 + offset_within_square and rows are 1-based. The C
// client converts to its own 0-based 1024-unit space; we keep the wire units,
// because BP_REQ_MOVE takes exactly these (clientd3d/protocol.h:74 converts back)
// and an agent's whole reason to know a coordinate is to move to it.
export function extractCoordinates(r) {
  const y = r.u16();
  const x = r.u16();
  return { x, y, col: (x / KOD_FINENESS) | 0, row: (y / KOD_FINENESS) | 0 };
}

// ExtractObject (server.c:319), includeLight defaulting to true.
export function extractObject(r, { includeLight = true } = {}) {
  const raw = r.u32();
  const id = objId(raw);
  // If the top nibble tags this as a quantity (money, arrows) an amount follows.
  // blakserv/commcli.c:85 sets that tag when kod sends with width NUMBER_OBJECT.
  const amount = isNumberObj(raw) ? r.u32() : 0;
  const iconRsc = r.u32();
  const nameRsc = r.u32();
  const flags   = r.u32();
  const rarity  = r.i32();
  const light   = includeLight ? extractDLighting(r) : null;
  const pal     = extractPaletteTranslation(r);
  const animate = extractAnimation(r);
  const overlays = extractOverlays(r);
  return { id, raw, tag: objTag(raw), amount, iconRsc, nameRsc, flags, rarity,
           light, ...pal, animate, overlays };
}

// ExtractNewRoomObject (server.c:384): an object, then where it is and which way
// it faces, then a second animation and overlay set describing it in motion.
export function extractRoomObject(r) {
  const obj = extractObject(r);
  const pos = extractCoordinates(r);
  const angle = r.u16();
  const motionPal = extractPaletteTranslation(r);
  const motionAnimate = extractAnimation(r);
  const motionOverlays = extractOverlays(r);
  return {
    ...obj, ...pos, angle,
    degrees: Math.round(angle * 360 / MAX_ANGLE) % 360,
    motion: { ...motionPal, animate: motionAnimate, overlays: motionOverlays },
  };
}

// --------------------------------------------------------- message payloads
//
// Each of these takes the payload AFTER the opcode byte and returns a plain
// object with an `exact` field: true iff the cursor landed precisely at the end,
// which is the invariant HandleRoomContents enforces. A caller that ignores it
// is trusting a packed stream, which is the one thing this file exists to avoid.

const done = (r, o) => ({ ...o, exact: r.left === 0, leftover: r.left });

// BP_ROOM_CONTENTS (134) — HandleRoomContents, server.c:644.
export function parseRoomContents(body) {
  const r = new Reader(body);
  const roomId = objId(r.u32());
  const count = r.u16();
  const objects = [];
  for (let i = 0; i < count; i++) {
    try {
      objects.push(extractRoomObject(r));
    } catch (e) {
      // Report how far we got: with a packed stream the index of the first bad
      // object is the only useful diagnostic.
      return { roomId, count, objects, exact: false, leftover: r.left,
               error: `object ${i}/${count}: ${e.message}` };
    }
  }
  return done(r, { roomId, count, objects });
}

// BP_CREATE (217) — HandleCreate, server.c:728. One room object, nothing else.
export function parseCreate(body) {
  const r = new Reader(body);
  return done(r, { object: extractRoomObject(r) });
}

// A payload that is one object id and nothing else. Three opcodes have this shape —
// BP_REMOVE (218, HandleRemove server.c:751), BP_USE (203) and BP_UNUSE (204,
// HandleUse/HandleUnuse server.c:1002/1015) — and all three refuse a payload that is
// not exactly SIZE_ID, so the exactness check is the whole validation.
export function parseObjectId(body) {
  const r = new Reader(body);
  return done(r, { id: objId(r.u32()) });
}
export const parseRemove = parseObjectId;

// BP_USE_LIST (205) — HandleUseList, server.c:969.
//
// THE ONLY AUTHORITATIVE ANSWER TO "WHAT AM I WEARING". It is the server's own
// plUsing list (user.kod:2643, ToCliUseList) sent whole: a count, then one id each.
// Everything else an agent could use to guess — the name it asked to wield, the
// absence of a refusal, the overlays on its own sprite — is inference. This is the
// record itself.
//
// It costs nothing to keep current, because BP_REQ_INVENTORY replies with BOTH
// ToCliInventory AND ToCliUseList (user.kod:955-957). Every inventory read the
// harness already makes, including the keepalive's, carries this behind it.
export function parseUseList(body) {
  const r = new Reader(body);
  const count = r.u16();
  const ids = [];
  for (let i = 0; i < count; i++) {
    // A short read here must not become "nothing is equipped". Report it the way
    // parseRoomContents does and let the caller leave the last known set alone — a
    // truncated packet is a gap in perception, and an empty hand is a fact.
    try { ids.push(objId(r.u32())); }
    catch (e) { return { count, ids, exact: false, leftover: r.left,
                         error: `id ${i}/${count}: ${e.message}` }; }
  }
  return done(r, { count, ids });
}

// BP_MOVE (200) — HandleMove, server.c:684. The high bit of speed is a
// turn-to-face flag, not part of the speed.
export function parseMove(body) {
  const r = new Reader(body);
  const id = objId(r.u32());
  const pos = extractCoordinates(r);
  const raw = r.u8();
  return done(r, { id, ...pos, speed: raw & 0x7f, turnToFace: !!(raw & 0x80) });
}

// BP_TURN (201) — HandleTurn, server.c:713.
export function parseTurn(body) {
  const r = new Reader(body);
  const id = objId(r.u32());
  const angle = r.u16();
  return done(r, { id, angle, degrees: Math.round(angle * 360 / MAX_ANGLE) % 360 });
}

// BP_CHANGE (219) — HandleChange, server.c:766. Like BP_CREATE but with no
// position: an object already in the room has changed appearance.
export function parseChange(body) {
  const r = new Reader(body);
  const obj = extractObject(r);
  const pal = extractPaletteTranslation(r);
  const animate = extractAnimation(r);
  const overlays = extractOverlays(r);
  return done(r, { object: { ...obj, motion: { ...pal, animate, overlays } } });
}

// BP_INVENTORY (208) — ExtractObjectList, server.c:414. Count-prefixed plain
// objects, no coordinates.
export function parseObjectList(body) {
  const r = new Reader(body);
  const count = r.u16();
  const objects = [];
  for (let i = 0; i < count; i++) objects.push(extractObject(r));
  return done(r, { count, objects });
}

// BP_INVENTORY_ADD (209) — ONE object, with no count prefix (HandleInventoryAdd,
// clientd3d/server.c). It is not a one-element object list, and parsing it as one
// eats the object's id as a count and then runs off the end of the payload.
export function parseInventoryAdd(body) {
  const r = new Reader(body);
  return done(r, { object: extractObject(r) });
}

// BP_OBJECT_CONTENTS (135) — a container id then the same object list.
export function parseObjectContents(body) {
  const r = new Reader(body);
  const containerId = objId(r.u32());
  const count = r.u16();
  const objects = [];
  for (let i = 0; i < count; i++) objects.push(extractObject(r));
  return done(r, { containerId, count, objects });
}

// BP_PLAYERS (136) — HandlePlayers, server.c:1244. The one message that carries
// names as text: kod sends each with width STRING_RESOURCE, which writes the
// resolved string rather than the id (blakserv/commcli.c:92). The C client feeds
// them straight into its resource table, and so should we — it is how a session
// learns the dynamic name resources of everyone logged on.
export function parsePlayers(body) {
  const r = new Reader(body);
  const count = r.u16();
  const players = [];
  for (let i = 0; i < count; i++) {
    const id = objId(r.u32());
    const nameRsc = r.u32();
    const name = r.str();
    const flags = r.u32();
    players.push({ id, nameRsc, name, flags });
  }
  return done(r, { count, players });
}

// BP_PLAYER_ADD (137) / BP_PLAYER_REMOVE (138) — HandleAddPlayer / one id.
export function parsePlayerAdd(body) {
  const r = new Reader(body);
  const id = objId(r.u32());
  const nameRsc = r.u32();
  const name = r.str();
  const flags = r.left >= 4 ? r.u32() : 0;
  return done(r, { id, nameRsc, name, flags });
}

// BP_CHANGE_RESOURCE (30) — HandleChangeResource, server.c:1409. The server
// telling a live session about a dynamic resource. Feeding these into the
// resource table is the only protocol-level way to learn a player's name.
export function parseChangeResource(body) {
  const r = new Reader(body);
  const id = r.u32();
  const text = r.str();
  return done(r, { id, text });
}

// BP_PLAYER (130) — HandlePlayer. Our own object, and the room we are in.
// From kod's ToCliPlayer (user.kod:2466): self, icon, name, room, room resource,
// room name, security, then light bytes and background.
export function parsePlayer(body) {
  const r = new Reader(body);
  const id = objId(r.u32());
  const iconRsc = r.u32();
  const nameRsc = r.u32();
  const roomId = objId(r.u32());
  const roomRsc = r.u32();
  const roomNameRsc = r.u32();
  const security = r.u32();
  const roomLight = r.left ? r.u8() : 0;
  const playerLight = r.left ? r.u8() : 0;
  const backgroundRsc = r.left >= 4 ? r.u32() : 0;
  // The rest is @SendExtraRoomInfo, which is room geometry detail we do not need.
  return { id, iconRsc, nameRsc, roomId, roomRsc, roomNameRsc, security,
           roomLight, playerLight, backgroundRsc, leftover: r.left, exact: true };
}

// BP_BUY_LIST (216) — HandleBuyList, server.c:770. A seller, then a
// count-prefixed list of object-plus-cost. Note the C client deliberately does
// NOT enforce the end-of-payload invariant here (`if (0)`), so neither do we.
export function parseBuyList(body) {
  const r = new Reader(body);
  const seller = extractObject(r);
  const count = r.u16();
  const items = [];
  for (let i = 0; i < count; i++) {
    const obj = extractObject(r);
    items.push({ ...obj, cost: r.i32() });
  }
  return { seller, count, items, exact: r.left === 0, leftover: r.left };
}

// LIST_OBJ_PARM — 2-byte count then the ids. The stride is NOT fixed: an id whose
// top nibble is CLIENT_TAG_NUMBER is followed by four more bytes giving how many of
// the stack to include (clientd3d/protocol.c PARAM_OBJECT_LIST; blakserv/parsecli.c
// reads the extra four bytes only when the tag is set).
//
// That variable stride is the whole mechanism for offering PART of a stack — half
// your money, twenty of your fifty arrows. Without it a trade can only move whole
// objects, and two agents cannot split anything.
//
// Accepts plain ids, or {id, amount} to send a quantity.
export function encodeIdList(items) {
  const parts = [];
  let count = 0;
  for (const it of items) {
    const isObj = typeof it === 'object' && it !== null;
    const rawId = isObj ? it.id : it;
    const amount = isObj ? it.amount : undefined;
    if (amount === undefined || amount === null) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(objId(rawId) >>> 0, 0);
      parts.push(b);
    } else {
      // The server decides "is there a quantity here" purely from the tag nibble,
      // so the tag has to go back ON before sending even though perception stripped
      // it off. protocol.c drops any element whose amount is <= 0 rather than
      // sending a zero, so do the same and keep the count honest.
      if (!(amount > 0)) continue;
      const b = Buffer.alloc(8);
      b.writeUInt32LE(((CLIENT_TAG_NUMBER << 28) | objId(rawId)) >>> 0, 0);
      b.writeInt32LE(amount, 4);
      parts.push(b);
    }
    count++;
  }
  const head = Buffer.alloc(2);
  head.writeUInt16LE(count, 0);
  return Buffer.concat([head, ...parts]);
}

// WHAT TO HAND encodeIdList FOR AN ITEM, WHICH IS NOT THE SAME AS ITS ID.
//
// UserDropItems (user.kod:3775) walks the id list and, for every item the SERVER thinks
// is a NumberItem, takes the next count off a PARALLEL number list — the one
// encodeIdList writes when an element carries {id, amount}. Send a stack as a bare id
// and that list is empty, so `number` arrives nil, Split refuses it (it wants
// `number >= 1 and number <= piNumber`, numbitem.kod:257) and the character is told
// "You don't have that amount of X to drop." (user.kod:183). Nothing is dropped, and as
// far as the wire is concerned the request succeeded.
//
// The `number <= 0` guard above Split (user.kod:3806) does NOT catch this: nil is not
// less than or equal to zero in kod, so a missing count falls past it into Split and
// comes back as the "don't have that amount" message rather than the "can't do anything
// with N items" one. Same outcome, different sentence — worth knowing when reading a
// report of it.
//
// THE TEST IS THE TAG, NOT WHETHER THERE IS MORE THAN ONE. extractObject reads an amount
// only for a number-tagged object and files 0 for everything else, so a stack with ONE
// left carries amount 1 — and an `amount > 1` test sends that as a bare id and drops
// nothing. That is the same bug again at the bottom of every stack, where it is hardest
// to notice, because "I dropped my last herb and still have it" reads as a UI glitch.
//
// `want` asks for part of the stack; omitted, it drops the lot.
export function dropSpec(o, want = null) {
  if (!o) return undefined;
  const stack = o.tag === CLIENT_TAG_NUMBER || (o.amount ?? 0) >= 1;
  if (!stack) return o.id;
  return { id: o.id, amount: want == null ? (o.amount ?? 1) : want };
}

// Validate the public `act` contract before anything reaches the wire. Kept outside
// m59-broker so the exact behavior can be exercised without starting a broker or
// opening a game session.
export function prepareActTarget({ verb, target, amount = null } = {}) {
  if (!target || target.id == null) throw new Error('act requires a resolved target');
  if (verb !== 'drop') {
    if (amount != null) throw new Error('amount is only valid for drop');
    return { wire_target: target.id, target: target.id, requested_amount: null };
  }
  if (amount != null && (!Number.isInteger(amount) || amount < 1))
    throw new Error(`amount must be a whole number of 1 or more, got ${amount}`);
  const wireTarget = dropSpec(target, amount);
  if (amount != null && typeof wireTarget !== 'object')
    throw new Error('drop amount is only valid for a stackable inventory item');
  const have = target.amount ?? 0;
  if (amount != null && have >= 1 && amount > have)
    throw new Error(`asked to drop ${amount} but only ${have} in the stack`);
  return {
    wire_target: wireTarget,
    target: target.id,
    requested_amount: typeof wireTarget === 'object' ? wireTarget.amount : 1,
  };
}

// ------------------------------------------------------------------- trading
//
// The offer protocol, which is the only way one player hands anything to another —
// BP_REQ_GIVE exists as an opcode but appears in no dispatch table anywhere in the
// tree, so giving is always a two-sided trade.
//
//   A -> BP_REQ_OFFER(120)        target id + item list
//   A <- BP_OFFERED(213)          what the server actually put on A's side
//   B <- BP_OFFER(211)            who is offering, and what
//   B -> BP_REQ_COUNTEROFFER(123) B's side, WHICH MAY BE EMPTY (that is a gift)
//   B <- BP_COUNTEROFFERED(215)   echo
//   A <- BP_COUNTEROFFER(214)     ...and this is what grants A permission to accept
//   A -> BP_ACCEPT_OFFER(121)     no payload
//
// Accepting without having received a counteroffer logs an ALERT server-side and
// cancels the trade, so the permission is real and must be waited for.
//
// On success the NON-accepting side gets BP_OFFER_CANCELED; the accepting side gets
// nothing at all and has to infer completion from BP_INVENTORY_ADD/REMOVE.

// BP_OFFER (211) — the offerer, then a count-prefixed object list.
export function parseOffer(body) {
  const r = new Reader(body);
  const from = extractObject(r);
  const count = r.u16();
  const items = [];
  for (let i = 0; i < count; i++) items.push(extractObject(r));
  return done(r, { from, count, items });
}

// BP_OFFERED (213) / BP_COUNTEROFFER (214) / BP_COUNTEROFFERED (215) — all just a
// count-prefixed object list, no sender.
export function parseOfferItems(body) {
  const r = new Reader(body);
  const count = r.u16();
  const items = [];
  for (let i = 0; i < count; i++) items.push(extractObject(r));
  return done(r, { count, items });
}

// ------------------------------------------------------- server text messages
//
// CheckServerMessage (clientd3d/srvrstr.c:18). Every piece of prose the server
// sends — BP_MESSAGE, BP_SYS_MESSAGE, the description behind BP_LOOK, and the
// non-speech forms of BP_SAID — is a resource id used as a printf format string,
// followed by parameters whose count and widths are determined ENTIRELY by the
// format string's fields. There is no length prefix on the parameter block, so
// without the resource table you cannot even find where a message ends.
//
//   %%      literal percent, consumes nothing
//   %d %i   4 bytes, an integer, printed as-is
//   %s      4 bytes, a RESOURCE ID, replaced by its string
//   %q      2-byte length + bytes, a literal string from the server
//
// The C version loops: a %s substitution can introduce further format fields, so
// it re-scans until a pass finds no %s. %q strings are protected across passes by
// being rewritten to a low control byte, because a player-supplied string could
// itself contain "%s". Reproduced here with sentinels for the same reason.
const MAXQPARAMS = 10;

// kod embeds two-character formatting codes in text, introduced by `~` or a
// backtick — `~r` is red, `~n` returns to normal (module/merintr/groups.c:363
// writes "~r%s~n"). clientd3d/say.c treats them as a pair and counts them
// against a limit, so they are display markup, not content. An agent reading
// "You say, \"hello~n\"" should see the words, not the escape, so strip them from
// agent-facing text while leaving `raw` available.
export const stripCodes = s => s.replace(/[~`]./g, '');

export function formatServerMessage(r, fmtId, lookup) {
  const fmt0 = lookup(fmtId);
  if (fmt0 === undefined || fmt0 === null) return { text: `<rsc ${fmtId}>`, resolved: false };

  const qstrings = [];
  const SENTINEL = i => `${i}`;

  let s = fmt0;
  for (let pass = 0; pass < 16; pass++) {
    let out = '';
    let i = 0;
    let sawS = false;
    while (i < s.length) {
      const c = s[i];
      if (c !== '%') { out += c; i++; continue; }
      const t = s[i + 1];
      if (t === undefined) { out += c; break; }   // trailing '%': the C code stops
      i += 2;
      switch (t) {
        case '%': out += '%'; break;
        case 'd': case 'i': out += String(r.i32()); break;
        case 's': {
          const rsc = r.u32();
          const sub = lookup(rsc);
          out += sub === undefined || sub === null ? `<rsc ${rsc}>` : sub;
          sawS = true;                            // may have introduced new fields
          break;
        }
        case 'q': {
          const text = r.str();
          if (qstrings.length < MAXQPARAMS) { out += SENTINEL(qstrings.length); qstrings.push(text); }
          else out += text;
          break;
        }
        default:
          // Unknown field: the C code copies the format section through
          // untouched and consumes nothing.
          out += c + t;
      }
    }
    s = out;
    if (!sawS) break;
  }

  for (let i = 0; i < qstrings.length; i++) s = s.split(SENTINEL(i)).join(qstrings[i]);
  return { text: stripCodes(s), raw: s, resolved: true };
}

// BP_MESSAGE (32) / BP_SYS_MESSAGE (31) — HandleStringMessage, server.c:857.
export function parseStringMessage(body, lookup) {
  const r = new Reader(body);
  const fmtId = r.u32();
  const { text } = formatServerMessage(r, fmtId, lookup);
  return done(r, { fmtId, text });
}

// BP_SAID (206) — HandleSaid, server.c:880. sender, sender's NAME RESOURCE, say
// type, then a formatted server message. Player speech uses a format resource
// that is a bare "%q", so the spoken words arrive as an inline string; a monster
// grunting uses a resource with no fields at all and sends no parameters.
export function parseSaid(body, lookup) {
  const r = new Reader(body);
  const speaker = objId(r.u32());
  const nameRsc = r.u32();
  const sayType = r.u8();
  const fmtId = r.u32();
  const { text } = formatServerMessage(r, fmtId, lookup);
  return done(r, { speaker, nameRsc, sayType, fmtId, text });
}

// BP_LOOK (207) — HandleLook, server.c:940. An object, a flags byte, then a
// formatted description; if the flags say the item is inscribed, a second
// formatted message follows.
export const DF_EDITABLE = 0x01, DF_INSCRIBED = 0x02;

export function parseLook(body, lookup) {
  const r = new Reader(body);
  const object = extractObject(r);
  const flags = r.u8();
  const fmtId = r.u32();
  const { text } = formatServerMessage(r, fmtId, lookup);
  let inscription = null;
  if ((flags & (DF_EDITABLE | DF_INSCRIBED)) && r.left >= 4) {
    const inscrFmt = r.u32();
    inscription = formatServerMessage(r, inscrFmt, lookup).text;
  }
  return done(r, { object, flags, fmtId, text, inscription });
}

// LOOKING AT A PLAYER IS NOT BP_LOOK. It is BP_USERCOMMAND / UC_LOOK_PLAYER (2),
// and this is not a detail — a client that handles only BP_LOOK gets nothing at all
// back when it looks at a person, which is indistinguishable from an object that
// refuses to be examined. `Player.TryLook` (user.kod:4374) diverts to
// `SendLookPlayer` (user.kod:4328) instead of the base `TryLook`'s `SendLook`, so
// the whole reply has a different shape:
//
//   object, one flags byte, then a formatted message (the DESCRIPTION), then two
//   plain length-prefixed strings — the extra info and the URL.
//
// HandleLookPlayer, module/merintr/merintr.c:1501. The flags byte is not the
// DF_EDITABLE/DF_INSCRIBED pair BP_LOOK carries: it is 1 when the viewer may EDIT
// this description — self, or an Admin looking at a player — and 0 otherwise
// (user.kod:4347). Both trailing strings are written by `AddPacket(0, …)` or by
// `AddPacket(STRING_RESOURCE, …)`, which commcli.c:92 says "writes actual string,
// even though it's a resource" — so both are literals on the wire either way.
//
// The description itself is a format resource with parameters, exactly like every
// other piece of server prose: a player who has SET one gets `player_desc_enchanted_none`
// ("%q", player.kod:321) carrying the text inline, and a player who has not gets
// whatever the default ShowDesc builds. That is why this is the only way to read a
// description back, and why it works on yourself — which is precisely what the real
// client's right-click-your-own-face dialog does.
export function parseLookPlayer(body, lookup) {
  const r = new Reader(body);
  const object = extractObject(r);
  const editable = r.u8();
  const fmtId = r.u32();
  const { text } = formatServerMessage(r, fmtId, lookup);
  // ExtractString, both of them. A truncated tail is reported rather than thrown:
  // the description is the part that matters and it has already been read.
  let extra = null, url = null;
  try { if (r.left >= 2) extra = r.str(); } catch { /* truncated */ }
  try { if (r.left >= 2) url = r.str(); } catch { /* truncated */ }
  return done(r, { object, editable: !!editable, fmtId, text,
                   extra: extra ? stripCodes(extra) : null, url: url || null });
}

// BP_STAT (131) / BP_STAT_GROUP (132) — health, mana, vigor and every character
// number. The handler does NOT live in clientd3d: stats are a UI module, so the
// authority is module/merintr/merintr.c:ExtractStatistic. Two levels of type tag,
// and the integer form carries four numbers, not one:
//
//   value, min, max, current_max
//
// kod sends health as (piHealth, 0, 100, piMax_health) — so `max` is a display
// scale and `currentMax` is the real ceiling. Health fraction is
// value / currentMax; reading `max` instead says every character has 100 hit
// points.
export const STATS_NUMERIC = 1, STATS_LIST = 2;   // proto.h:315
export const STAT_INT = 1, STAT_RES = 2;          // proto.h:534

// A stat's `name_res` is NOT its name — it is a bitmap filename. kod declares
// `user_stat_health = heal.bgf` (user.kod:144), so resolving it gives "heal.bgf".
// The only names stats have are their (group, number) slots, from
// User.ToCliStats (user.kod:2659) and the SendStat* methods it calls. Groups 3
// and 4 are the per-spell and per-skill ability levels, indexed by position in
// the character's spell/skill list rather than by a fixed slot.
export const STAT_GROUP = { CONDITION: 1, ATTRIBUTES: 2, SPELLS: 3, SKILLS: 4 };

export const STAT_NAMES = {
  1: { 1: 'health', 2: 'mana', 3: 'vigor' },
  2: { 1: 'might', 2: 'intellect', 3: 'stamina', 4: 'agility',
       5: 'mysticism', 6: 'aim', 7: 'karma' },
};

export const statName = (group, num) => STAT_NAMES[group]?.[num];

export function extractStatistic(r, lookup, group) {
  const num = r.u8();
  const nameRsc = r.u32();
  const type = r.u8();
  const out = { group, num, nameRsc, icon: lookup ? lookup(nameRsc) : undefined,
                name: statName(group, num), type };
  if (type === STATS_NUMERIC) {
    out.tag = r.u8();
    out.value = r.i32();
    if (out.tag === STAT_INT) { out.min = r.i32(); out.max = r.i32(); out.currentMax = r.i32(); }
    else { out.rsc = out.value; out.text = lookup ? lookup(out.value) : undefined; }
  } else if (type === STATS_LIST) {
    out.id = r.u32(); out.value = r.i32(); out.iconRsc = r.u32();
  } else {
    throw new Error(`unknown stat type ${type}`);
  }
  return out;
}

export function parseStat(body, lookup) {
  const r = new Reader(body);
  const group = r.u8();
  return done(r, { group, stat: extractStatistic(r, lookup, group) });
}

// BP_STAT_GROUP (132) — a whole group at once, count as ONE byte (SIZE_NUM_STATS).
export function parseStatGroup(body, lookup) {
  const r = new Reader(body);
  const group = r.u8();
  const count = r.u8();
  const stats = [];
  for (let i = 0; i < count; i++) stats.push(extractStatistic(r, lookup, group));
  return done(r, { group, count, stats });
}

// BP_SPELLS (141) / BP_SKILLS (144) — merintr.c ExtractNewSpell/ExtractNewSkill.
// A spell is an object plus how many targets it takes and which school it is in;
// num_targets is what BP_REQ_CAST's target list must satisfy.
export function parseSpells(body) {
  const r = new Reader(body);
  const count = r.u16();
  const spells = [];
  for (let i = 0; i < count; i++) {
    const obj = extractObject(r);
    spells.push({ ...obj, numTargets: r.u8(), school: r.u8() - 1 });
  }
  return done(r, { count, spells });
}

export function parseSkills(body) {
  const r = new Reader(body);
  const count = r.u16();
  const skills = [];
  for (let i = 0; i < count; i++) skills.push(extractObject(r));
  return done(r, { count, skills });
}

// ----------------------------------------------------------------- describe

// The point of all of the above: a line an agent can read.
export function describeObject(o, lookup) {
  const name = lookup ? lookup(o.nameRsc) : `rsc ${o.nameRsc}`;
  const bits = [];
  if (o.amount) bits.push(`x${o.amount}`);
  if (o.x !== undefined) bits.push(`at (${o.col},${o.row})`);
  if (o.degrees !== undefined && o.x !== undefined) bits.push(`facing ${o.degrees}°`);
  if (o.flags & OF.PLAYER) bits.push('player');
  const can = affordances(o.flags).filter(x => x !== 'look');
  if (can.length) bits.push(`[${can.join('/')}]`);
  return `${name} (id ${o.id})${bits.length ? ' ' + bits.join(' ') : ''}`;
}
