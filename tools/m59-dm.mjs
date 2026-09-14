#!/usr/bin/env node
// DM POWERS OVER THE MAINTENANCE SOCKET, AS A LIBRARY AND AS ONE COMMAND.
//
//   node tools/m59-dm.mjs where TESTER Alpha Bravo
//   node tools/m59-dm.mjs relocate TESTER,Alpha,Bravo 60 --at 13,13
//   node tools/m59-dm.mjs kit TESTER --stats 50 --health 151 --karma -60 --spells 99
//   node tools/m59-dm.mjs heal TESTER,Alpha
//   node tools/m59-dm.mjs exec "set object 7124 piKarma INT -6000"
// CLI CONTRACT: `relocate --at` is `row,col` (KOD/RoomGeometry order).
//
// This exists because setting a test scenario up by PLAYING it does not scale. Walking
// six characters from the newbie island to the Tos arena is twenty minutes of travel
// that can fail halfway; the same placement over this socket is one packet and about a
// millisecond, and it cannot fail halfway because there is no "halfway".
//
// FOUR THINGS ABOUT THIS SOCKET THAT ARE NOT OBVIOUS AND COST TIME TO LEARN.
//
// 1. IT NEEDS NO PACING AT ALL. Every other caller of this socket in the repository
//    paces itself — 70ms in m59-godmode.mjs, 400ms in m59-makefleet.mjs — and that
//    pacing is the entire runtime of those tools. Measured here: 2000 commands written
//    as ONE buffer got 2000 replies, and the only elapsed time was the settle wait the
//    measurement itself imposed. So a batch is written in one go and the reply stream
//    is read until a sentinel comes back. A full character kit went from 14 seconds to
//    under one.
//
// 2. OBJECT IDS ARE NOT STABLE. The server renumbers objects when it garbage-collects,
//    which it does around a save — `[Auto] SavePeriod` is 15 minutes on the local
//    server. In one session here a character resolved as 7218, was configured as 7218
//    successfully, and half an hour later object 7218 was a heartstone while the
//    character had become 7124. Nothing errored and nothing looked wrong. So THIS FILE
//    NEVER CACHES AN OBJECT ID ACROSS A CALL: every verb resolves the names it was
//    given in the same batch it uses them, and `resolve()` is cheap enough that there
//    is no reason to do otherwise.
//
// 3. THE SERVER NEVER SAYS NO — the same rule the rest of this repository is built
//    around. `UtilGoNearSquare` returns 1 for a target square of (99,99) in a 24x24
//    room, because it searches outward for something standable and finds it. A reply
//    of 1 means "somebody was moved somewhere", not "moved where you asked". Verify
//    placement by reading the character back, which `relocate --verify` does.
//
// 4. THE MAINTENANCE PORT IS UNAUTHENTICATED AND IP-RESTRICTED, and that is the whole
//    security model. So this refuses to run against anything but a loopback address —
//    see the guard below. A DM tool pointed at a shared server is not a tool, it is an
//    incident.
//
// The relocate primitive is `System.UtilGoNearSquare` (util.kod:20), whose own docstring
// is "Move any object anywhere in any room." It is what the DM rescue spell uses
// (dmspell/dmrescue.kod:50). Rooms are found with `System.FindRoomByNum`
// (util/system.kod:1238) rather than from the map index, because the map index records
// the object id a room had when it was built and those move too.

import net from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const SYS = 0;

// ------------------------------------------------------------------ the socket

// ONE DEFINITION OF "IS THIS SERVER ON THIS MACHINE", because three things now gate on
// it — this socket, the testbed, and the chatter's arena reply — and a quantity with two
// homes in this repository has always ended up with two answers.
export const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);
export const isLoopbackHost = host => LOOPBACK.has(String(host ?? '').trim());

export function adminTarget(env = process.env) {
  const host = env.M59_ADMIN_HOST || env.M59_HOST || '127.0.0.1';
  const port = Number(env.M59_ADMIN_PORT || 19998);
  return { host, port };
}

// A DM socket pointed anywhere but this machine is somebody else's server. There is no
// authentication on this port — the server's own protection is an IP mask — so the
// only honest place for this check is before the connect.
function assertLocal({ host, port }) {
  if (!isLoopbackHost(host))
    throw new Error(
      `refusing to open a DM socket to ${host}:${port} — this port is unauthenticated ` +
      `and only ever intended for a server on this machine. If you meant a remote ` +
      `server, you do not have DM rights on it and should not try to take them.`);
}

// One batch, one connection, no pacing. Completion is a SENTINEL rather than a timeout:
// `show status` prints a line nothing else prints, so the read loop knows the server has
// worked through everything ahead of it instead of guessing how long that took.
const SENTINEL_CMD = 'show status';
const SENTINEL_RE  = /System Status/;

// `async`, so the loopback guard REJECTS rather than throwing synchronously. A function
// that usually returns a promise and sometimes throws before it has one is two error
// paths for a caller to remember, and the one that gets forgotten is the guard.
export async function dm(cmds, { timeoutMs = 30000, env = process.env } = {}) {
  const list = (Array.isArray(cmds) ? cmds : [cmds]).filter(Boolean);
  const target = adminTarget(env);
  assertLocal(target);
  if (!list.length) return '';

  return new Promise((resolve, reject) => {
    const s = net.connect(target.port, target.host);
    let buf = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(bail); s.destroy(); fn(v); };
    const bail = setTimeout(() => finish(resolve, buf), timeoutMs);
    s.on('connect', () => s.write(list.join('\r\n') + '\r\n' + SENTINEL_CMD + '\r\n'));
    s.on('data', d => {
      buf += d;
      if (SENTINEL_RE.test(buf)) finish(resolve, buf);
    });
    s.on('close', () => finish(resolve, buf));
    s.on('error', e => finish(reject, e));
  });
}

// The replies for a batch come back in the order the commands were sent, one block per
// command, each introduced by the echoed command line. Splitting on that echo is what
// lets a caller line a reply up with the thing it asked, which matters the moment a
// batch resolves twenty names at once.
export function split(out, cmds) {
  const text = String(out);
  const blocks = [];
  let cursor = 0;
  for (const c of cmds) {
    const at = text.indexOf(c, cursor);
    if (at < 0) { blocks.push(null); continue; }
    const start = at + c.length;
    let end = text.length;
    for (const later of cmds.slice(cmds.indexOf(c) + 1)) {
      const n = text.indexOf(later, start);
      if (n >= 0) { end = n; break; }
    }
    blocks.push(text.slice(start, end));
    cursor = start;
  }
  return blocks;
}

export const REJECTION_RE =
  /can't handle|not a valid|invalid|Cannot find|should be an|no access|Unknown command|Missing parameter/i;

export const rejections = out => [...new Set(String(out).split(/\r?\n/)
  .filter(l => REJECTION_RE.test(l)).map(l => l.trim()))];

// ------------------------------------------------------------------ resolving

// Names in, object ids out. Re-run this every time; see note 2 at the top of the file.
// A name the server does not know maps to null rather than being dropped, so a caller
// iterating the result cannot silently act on the wrong number of characters.
export async function resolve(names, opts = {}) {
  const list = Array.isArray(names) ? names : [names];
  const cmds = list.map(n => `show name ${n}`);
  const out = await dm(cmds, opts);
  const blocks = split(out, cmds);
  const found = {};
  list.forEach((n, i) => {
    const m = /object (\d+)/i.exec(blocks[i] || '');
    found[n] = m ? Number(m[1]) : null;
  });
  return found;
}

// THE REPLY HEADER NAMES THE RECEIVER, SO A BARE /OBJECT (\d+)/ READS THE WRONG NUMBER.
// A `send` comes back as
//
//     :< return from OBJECT 0 MESSAGE FindRoomByNum (10268)
//     : OBJECT 267
//     :   is CLASS TosArena (10374)
//
// and the first match in that is the SYSTEM object the message was sent to. Asking for
// room 60 therefore returned 0, every relocate was told to move people into the system
// object, and `UtilGoNearSquare` reported nothing wrong because it never says no. The
// return value is the line that is only a colon and an object, and nothing else in the
// reply has that shape.
export const returnedObject = out => {
  const m = /^:\s+OBJECT (\d+)/m.exec(String(out));
  return m ? Number(m[1]) : null;
};

export async function roomObject(num, opts = {}) {
  const out = await dm([`send object ${SYS} FindRoomByNum num INT ${Number(num)}`], opts);
  return returnedObject(out);
}

// ------------------------------------------------------------------ command builders
//
// Pure string builders, kept separate from anything that opens a socket so the whole
// command vocabulary can be tested offline. Every live failure in this repository's
// history has been "the command we sent was not the command we meant"; that is a thing
// a test can catch, and a live server is not needed to catch it.

export const setProp = (obj, prop, value) => `set object ${obj} ${prop} INT ${value}`;
export const sendMsg = (obj, msg, parms = {}) =>
  `send object ${obj} ${msg}` +
  Object.entries(parms).map(([k, v]) => ` ${k} ${v[0]} ${v[1]}`).join('');

export const ATTRIBUTES =
  ['piMight', 'piIntellect', 'piStamina', 'piAgility', 'piMysticism', 'piAim'];

export const ATTRIBUTE_OF = {
  might: 'piMight', intellect: 'piIntellect', stamina: 'piStamina',
  agility: 'piAgility', mysticism: 'piMysticism', aim: 'piAim',
};

// 50 is the per-stat cap the character-creation protocol enforces; nothing stops this
// socket writing more, and nothing in the game expects it, so the builder clamps and
// the caller can see it did.
export const STAT_CAP = 50;

export function statCmds(obj, spec) {
  const cmds = [];
  if (typeof spec === 'number') {
    const v = Math.max(0, Math.min(STAT_CAP, spec));
    for (const p of ATTRIBUTES) cmds.push(setProp(obj, p, v));
    return cmds;
  }
  for (const [name, v] of Object.entries(spec || {})) {
    const prop = ATTRIBUTE_OF[String(name).toLowerCase()];
    if (!prop) continue;
    cmds.push(setProp(obj, prop, Math.max(0, Math.min(STAT_CAP, Number(v)))));
  }
  return cmds;
}

// MAX HEALTH IS THE LEVEL HERE, and three properties carry it. Setting only piHealth
// gets refigured straight back down by the next thing that looks at the character, and
// setting only piMax_Health leaves the base — which is what the game reads as level —
// where it was. All three, always.
export function healthCmds(obj, hp) {
  return ['piHealth', 'piMax_Health', 'piBase_Max_Health'].map(p => setProp(obj, p, hp));
}
export function manaCmds(obj, mp) {
  return ['piMana', 'piMax_Mana'].map(p => setProp(obj, p, mp));
}

// piKarma is in HUNDREDTHS of a karma unit (player.kod:822) and NewKarma bounds it to
// +/-10000, i.e. +/-100 as the game reports it. Taking the number the player sees and
// multiplying is the whole conversion, and getting it backwards gives a character with
// -0.6 karma that looks like it worked.
export const KARMA_LIMIT = 100;
export function karmaCmd(obj, karma) {
  const k = Math.max(-KARMA_LIMIT, Math.min(KARMA_LIMIT, Number(karma)));
  return setProp(obj, 'piKarma', k * 100);
}

// ------------------------------------------------------------------ abilities
//
// Ids come from the game's own headers rather than a range, so gaps in the numbering
// are skipped instead of generating failures — the same reason m59-godmode.mjs reads
// them. bDM is the flag the game's OWN DM grants pass, which is what skips the
// prerequisite checks; this is not a bypass invented here.

export function abilityIds(prefix, root = process.env.M59_ROOT || 'C:/code/meridian59') {
  const dir = join(root, 'kod', 'include');
  const found = new Set();
  for (const f of readdirSync(dir).filter(x => x.endsWith('.khd'))) {
    const txt = readFileSync(join(dir, f), 'utf8');
    for (const m of txt.matchAll(new RegExp(`${prefix}_[A-Z_0-9]+\\s*=\\s*(\\d+)`, 'g')))
      found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

// EVERY SKILL IN THE GAME IS A WEAPONCRAFT SKILL. `viSchool = SKS_FENCING` on all of
// them bar kick and the unarmed default, which are SKS_BRAWLING; magic is spells, not
// skills. So "all weaponcraft skills" and "all skills" are the same set, and a caller
// asking for the former does not need a filter that would only ever drop kick.
export const skillCmds = (obj, ability, ids) =>
  ids.map(n => `send object ${obj} AddSkill num INT ${n} iability INT ${ability} bDM INT 1`);
export const spellCmds = (obj, ability, ids) =>
  ids.map(n => `send object ${obj} AddSpell num INT ${n} iability INT ${ability} bDM INT 1`);

// ------------------------------------------------------------------ reagents
//
// Every reagent named by any spell in substrate/m59-spells.json, spelled the way the kod
// declares the class. All are NumberItem subclasses — Food is one, so Snack stacks —
// except HeartStone, which is a plain PassiveItem and therefore needs one object each.

export const REAGENTS = [
  'BlueDragonScale', 'BlueMushroom', 'DarkAngelFeather', 'Diamond', 'DragonflyEye',
  'ElderBerry', 'Emerald', 'EntrootBerry', 'FairyWing', 'FireSand', 'Herbs',
  'KriipaClaw', 'Mushroom', 'OrcTooth', 'PolishedSeraphym', 'PurpleMushroom',
  'RainbowFern', 'RedMushroom', 'Ruby', 'Sapphire', 'ShamanBlood', 'Snack',
  'Solagh', 'UncutSeraphym', 'WebMoss', 'Yrxlsap',
];
export const UNSTACKABLE_REAGENTS = ['HeartStone'];

// WHAT IS IN A PACK, BY CLASS. Three round trips whatever the size: the holder names a
// list, the list names its objects, and one batch reads them all. Stacking classes
// report their piNumber; anything without one counts as a single object.
export async function packOf(obj, opts = {}) {
  const head = await dm([`show object ${obj}`], opts);
  const listId = /plPassive\s+= LIST (\d+)/.exec(head)?.[1];
  if (!listId) return {};
  const items = await dm([`show list ${listId}`], opts);
  const ids = [...String(items).matchAll(/^:\s+OBJECT (\d+)/gm)].map(m => Number(m[1]));
  if (!ids.length) return {};
  const cmds = ids.map(id => `show object ${id}`);
  return parsePack(await dm(cmds, { timeoutMs: 60000, ...opts }), cmds);
}

// Pure, so the counting can be pinned without a server. A stack reports its piNumber; an
// object with none is one thing. Getting that backwards counts fifty heartstones as one.
export function parsePack(out, cmds) {
  const have = {};
  for (const b of split(out, cmds)) {
    const cls = /is CLASS (\w+)/.exec(b || '')?.[1];
    if (!cls) continue;
    const num = /piNumber\s+= INT (\d+)/.exec(b || '')?.[1];
    have[cls] = (have[cls] ?? 0) + (num ? Number(num) : 1);
  }
  return have;
}

// What still has to be created to reach the target. Class names are matched
// case-insensitively because kod class names are — `CorNothTown` and `CornothTown` are
// one class to the compiler and were two keys to a plain Map once already, which stopped
// a lookup silently and in the direction that looks like a legitimate answer.
export function topUp({ have = {}, each = 50, stacking = [], singles = [] } = {}) {
  const carrying = new Map(Object.entries(have).map(([k, v]) => [k.toLowerCase(), Number(v)]));
  const short = cls => Math.max(0, each - (carrying.get(String(cls).toLowerCase()) ?? 0));
  return [
    ...stacking.filter(c => short(c) > 0).map(c => `create object ${c} number INT ${short(c)}`),
    ...singles.flatMap(c => Array.from({ length: short(c) }, () => `create object ${c}`)),
  ];
}

// A TARGET, NOT A DELIVERY — and getting this backwards is what made `m59-testbed.mjs up`
// non-idempotent on its first real run. A scenario says "this character carries 50 of
// each reagent"; running it twice therefore has to leave 50, not 100. Stating the END
// STATE rather than the errand is the same shape as the guild wants in
// m59-guildwants.mjs, and for the same reason: it can be re-run, it cannot double-count,
// and a satisfied target produces no work at all.
//
// It tops up and never takes away. Trimming a pack back down would mean deleting objects
// out of a character to satisfy a number, which is a destructive act nobody asked for —
// so `each` is a floor, and a character already carrying more keeps it.
//
// Two batches for the creating half, because the second needs the ids the first hands
// back. `NewHold` and not `ReqNewHold` deliberately: ReqNewHold weighs the pack first and
// this is meant to exceed it — 50 of everything is far past what a character can carry,
// which is the point of a test character and would otherwise be refused item by item.
export async function give(obj, { each = 50, stacking = REAGENTS, singles = UNSTACKABLE_REAGENTS } = {}, opts = {}) {
  const have = await packOf(obj, opts);
  const makes = topUp({ have, each, stacking, singles });
  if (!makes.length) return { created: 0, held: 0, note: 'already carrying the target of every kind' };
  const out = await dm(makes, { timeoutMs: 60000, ...opts });
  const ids = [...String(out).matchAll(/Created object (\d+)/g)].map(m => Number(m[1]));
  if (ids.length !== makes.length)
    return { created: ids.length, held: 0, expected: makes.length,
             note: 'count mismatch — nothing was handed over, because the ids would not line up' };
  const out2 = await dm(ids.map(id => `send object ${obj} NewHold what OBJECT ${id}`),
                        { timeoutMs: 60000, ...opts });
  return { created: ids.length, held: ids.length, rejected: rejections(out2) };
}

// Money is an item of class Money counted by piNumber, not a property on the player, so
// it is found or created rather than set.
export async function money(obj, amount, opts = {}) {
  const out = await dm([`send object ${obj} GetMoneyObject`], opts);
  // returnedObject, not a bare /OBJECT (\d+)/ — see the note on it. The old fallback
  // here would have matched the PLAYER out of the reply header and then set the
  // player's own piNumber, which is not a property the player has.
  const found = returnedObject(out);
  if (found) {
    await dm([setProp(found, 'piNumber', amount)], opts);
    return { object: found, amount };
  }
  const made = await dm([`create object Money number INT ${amount}`], opts);
  const n = /Created object (\d+)/.exec(made);
  if (!n) return { object: null, amount: 0, note: 'could not create money' };
  await dm([`send object ${obj} NewHold what OBJECT ${n[1]}`], opts);
  return { object: Number(n[1]), amount, created: true };
}

// ------------------------------------------------------------------ relocate

// COORDINATE CONTRACT: positional square arguments here are `(row,col)`, matching
// KOD and RoomGeometry; returned positions use named `{row,col}` fields.
// Room coordinates are the kod grid — 1-based, bounded by the room's own rows and cols.
// UtilGoNearSquare searches OUTWARD from the square it is given until it finds one that
// will hold the object, so an out-of-bounds target does not fail, it silently lands
// somewhere else. Clamping here is what makes the request mean what it says.
export function clampSquare(row, col, rows, cols) {
  const c = (v, max) => Math.max(1, Math.min(max || 1e9, Math.round(Number(v))));
  return { row: c(row, rows), col: c(col, cols) };
}

export const relocateCmd = (obj, roomObj, row, col) =>
  `send object ${SYS} UtilGoNearSquare what OBJECT ${obj} where OBJECT ${roomObj}` +
  ` new_row INT ${row} new_col INT ${col}`;

// Exact scene placement. KOD/protocol fine units (64/square), never BSP units.
// util.kod:20 accepts fine_row/fine_col; max_distance=0 forbids a silent nearby snap.
export function relocateFineCmd(obj, roomObj, {x,y,row,col,angle=null}) {
  if (![x,y,row,col].every(Number.isInteger) || Math.floor(x/64)!==col || Math.floor(y/64)!==row)
    throw Error('fine scene position must agree with its named row/col in 64-unit coordinates');
  return relocateCmd(obj,roomObj,row,col)+` max_distance INT 0 fine_row INT ${y%64} fine_col INT ${x%64}`
    +(Number.isInteger(angle)?` new_angle INT ${angle}`:'');
}

// Names in, one batch out. Everything is resolved in the same call that uses it, and
// the room is resolved through the server rather than from substrate/m59-map.json,
// because that file records the object id a room had when the index was built.
export async function relocate(names, roomNum, { row, col, verify = false } = {}, opts = {}) {
  // COORDINATE CONTRACT: relocation accepts a named `{row,col}` square.
  const list = Array.isArray(names) ? names : [names];
  const ids = await resolve(list, opts);
  const roomObj = await roomObject(roomNum, opts);
  if (roomObj == null) return { ok: false, why: `no room ${roomNum} on this server` };

  const geom = roomGeometry(roomNum);
  const want = clampSquare(row ?? Math.round((geom.rows || 20) / 2),
                           col ?? Math.round((geom.cols || 20) / 2), geom.rows, geom.cols);

  // SNAPPED TO FLOOR BEFORE THE PACKET GOES, never after. See walkableSquare: the server
  // accepts a square inside a wall and answers 1, and a character standing in rock cannot
  // be routed from at all.
  const snapped = walkableSquare(roomNum, want.row, want.col);
  const place = { row: snapped.row, col: snapped.col };

  const movable = list.filter(n => ids[n] != null);
  const out = await dm(movable.map(n => relocateCmd(ids[n], roomObj, place.row, place.col)), opts);

  const moved = {};
  for (const n of list) moved[n] = ids[n] == null ? 'no such character' : 'sent';
  if (verify) {
    // A reply of 1 is not evidence of arrival; only reading the character back is.
    const check = await dm(movable.map(n => `show object ${ids[n]}`), opts);
    const blocks = split(check, movable.map(n => `show object ${ids[n]}`));
    movable.forEach((n, i) => {
      const owner = /poOwner\s+= OBJECT (\d+)/.exec(blocks[i] || '');
      moved[n] = owner && Number(owner[1]) === roomObj ? 'in the room' : 'NOT in the room';
    });
  }
  return { ok: true, room: roomNum, room_object: roomObj, square: place, moved,
           ...(snapped.moved ? { snapped_to_floor: { asked: snapped.from, placed: place,
                                                     squares_away: Math.round(snapped.distance * 10) / 10 } } : {}),
           ...(snapped.why ? { placement_warning: snapped.why } : {}),
           rejected: rejections(out) };
}

// The map index is the right source for a room's SHAPE — that does not move — even
// though it is the wrong source for its object id.
let MAP = null;
export function roomGeometry(num) {
  if (MAP === null) {
    try { MAP = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8')).rooms; }
    catch { MAP = {}; }
  }
  const r = MAP[String(num)];
  return { rows: r?.rows ?? null, cols: r?.cols ?? null, name: r?.name ?? null };
}

// THE SERVER WILL PUT A CHARACTER INSIDE A WALL AND SAY 1.
//
// `UtilGoNearSquare` searches outward for somewhere STANDABLE by its own rules, which are
// not the client's collision rules, and it returns 1 for "somebody was moved somewhere".
// This file already warns that a reply of 1 is not evidence of arrival. What it did not
// do is check the destination against the baked geometry first — so a caller who picks a
// square by eye gets a character standing in solid rock, from which `walkTo` cannot plan
// at all and every measurement taken there is rubbish.
//
// That is not hypothetical: four placements in a row in room 587 landed inside walls
// (14,8 / 25,30 / 30,25 / 20,28, all `walkable: false`), the operator looked and said
// "they're all stuck in the wall, as am I", and two earlier `start_has_no_floor` results
// had been recorded as a routing fault before anybody checked the coordinates. Room 587
// is 38% walkable, so a square chosen by eye is worse than a coin flip.
//
// SNAPS RATHER THAN REFUSES, because the caller's intent — "put it about here" — is
// almost always satisfiable a square or two away, and a refusal in the middle of a batch
// is worse than a small correction that says so. `null` geometry means no opinion and the
// square is passed through untouched: a checkout with no baked map must place exactly as
// it always did.
let WALKABLE_CACHE = null;
export function walkableSquare(num, row, col, { maxRadius = 8 } = {}) {
  // COORDINATE CONTRACT: positional square arguments are `(row,col)`.
  if (MAP === null) roomGeometry(num);
  const room = MAP?.[String(num)];
  if (!room?.roo) return { row, col, checked: false };
  try {
    WALKABLE_CACHE ??= new Map();
    let geo = WALKABLE_CACHE.get(num);
    if (!geo) {
      const { RoomGeometry } = require_roo();
      geo = RoomGeometry.fromJSON(room.roo);
      WALKABLE_CACHE.set(num, geo);
    }
    if (geo.walkable(row, col)) return { row, col, checked: true, moved: false };
    const near = geo.nearestWalkable(row, col, { maxRadius });
    if (!near) return { row, col, checked: true, moved: false,
                        why: `no walkable square within ${maxRadius} of ${row},${col}` };
    return { row: near.row, col: near.col, checked: true, moved: true,
             from: { row, col }, distance: near.distance };
  } catch { return { row, col, checked: false }; }
}

// Loaded lazily and through a helper so this module keeps working in a checkout with no
// baked map, and so importing m59-dm.mjs stays cheap for the callers that never place
// anything.
let ROO_MOD = null;
function require_roo() {
  if (!ROO_MOD) throw new Error('geometry not loaded');
  return ROO_MOD;
}
export function attachRoo(mod) { ROO_MOD = mod; }
try { ROO_MOD = await import('./m59-roo.mjs'); } catch { /* no geometry here */ }

// ------------------------------------------------------------------ kit

// Everything a test character needs, in as few round trips as the dependencies allow:
// one resolve, one batch for all the properties and abilities, then the two that must
// read an id back (money, reagents).
export async function kit(name, want = {}, opts = {}) {
  const ids = await resolve([name], opts);
  const obj = ids[name];
  if (obj == null) return { ok: false, why: `no character called ${name} on this server` };

  const cmds = [];
  if (want.stats != null) cmds.push(...statCmds(obj, want.stats));
  if (want.health != null) cmds.push(...healthCmds(obj, want.health));
  if (want.mana != null) cmds.push(...manaCmds(obj, want.mana));
  if (want.karma != null) cmds.push(karmaCmd(obj, want.karma));
  if (want.skills != null)
    cmds.push(...skillCmds(obj, want.skills, want.skill_ids || abilityIds('SKID')));
  if (want.spells != null)
    cmds.push(...spellCmds(obj, want.spells, want.spell_ids || abilityIds('SID')));

  const out = cmds.length ? await dm(cmds, { timeoutMs: 60000, ...opts }) : '';
  const done = { object: obj, commands: cmds.length, rejected: rejections(out) };

  if (want.money != null) done.money = await money(obj, want.money, opts);
  if (want.reagents != null) done.reagents = await give(obj, { each: want.reagents }, opts);
  return { ok: true, ...done };
}

// viMax_vigor, player.kod:740. A Player classvar, so it is the same 200 for every
// character and there is nothing to read per head.
export const MAX_VIGOR = 200;

export const parseCeilings = block => ({
  maxHealth: Number(/piMax_Health\s+= INT (\d+)/i.exec(block || '')?.[1] ?? NaN),
  maxMana:   Number(/piMax_Mana\s+= INT (\d+)/i.exec(block || '')?.[1] ?? NaN),
});

// PUT A CHARACTER BACK ON ITS FEET BETWEEN ROUNDS. This is the verb a test loop calls,
// so it reads the ceilings once and then writes, rather than sending a gain message per
// vital — and it SETS rather than GAINS, for three reasons that are all traps:
//
//  * `GainHealth` is not the one whose docstring says it stops at the maximum. It caps
//    at TWICE piMax_health ("some attempt here to quell the vamp touch bugs",
//    player.kod), so a flat `GainHealth 10000` leaves a 50-health opponent at 88/50 —
//    which is what it did on the first live run of this function.
//  * `GainMana` does not clamp AT ALL unless it is passed `bCapped`, which defaults
//    FALSE. The obvious call is the uncapped one.
//  * `GainHealthNormal`, which does clamp, returns 0 and changes nothing when health is
//    ALREADY over the maximum — so it cannot undo the damage the first bullet does.
//    Setting the property is the only thing that brings an over-max character back.
//
// The ceilings come from the character itself rather than from a number chosen here: a
// test bed that healed everyone to 151 would quietly re-level the 50-health opponents it
// exists to keep small.
export async function heal(names, opts = {}) {
  const list = Array.isArray(names) ? names : [names];
  const ids = await resolve(list, opts);
  const present = list.filter(n => ids[n] != null);
  if (!present.length)
    return { healed: [], missing: list, rejected: [] };

  const reads = present.map(n => `show object ${ids[n]}`);
  const blocks = split(await dm(reads, opts), reads);

  const cmds = [];
  present.forEach((n, i) => {
    const o = ids[n];
    const { maxHealth, maxMana } = parseCeilings(blocks[i]);
    if (Number.isFinite(maxHealth)) cmds.push(setProp(o, 'piHealth', maxHealth));
    if (Number.isFinite(maxMana)) cmds.push(setProp(o, 'piMana', maxMana));
    cmds.push(setProp(o, 'piVigor', MAX_VIGOR), setProp(o, 'piExertion', 0));
    // Nothing redraws a bar that was set behind the game's back, so each vital is
    // pushed. A reset the client cannot see is a reset the operator will redo.
    cmds.push(`send object ${o} NewHealth`, `send object ${o} NewMana`,
              `send object ${o} NewVigor`);
  });
  const out = await dm(cmds, { timeoutMs: 60000, ...opts });
  return { healed: present,
           missing: list.filter(n => ids[n] == null),
           rejected: rejections(out) };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith('--')) {
      const k = v.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[k] = true;
      else { a[k] = next; i++; }
    } else a._.push(v);
  }
  return a;
}

const names = s => String(s).split(',').map(x => x.trim()).filter(Boolean);

async function main(argv) {
  const a = parseArgs(argv);
  const [verb, ...rest] = a._;

  if (!verb || a.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).slice(0, 8).join('\n'));
    return 0;
  }

  if (verb === 'where') {
    const found = await resolve(rest.length ? rest.flatMap(names) : []);
    for (const [n, id] of Object.entries(found))
      console.log(`${n.padEnd(16)} ${id ?? 'not on this server'}`);
    return Object.values(found).some(v => v == null) ? 1 : 0;
  }

  if (verb === 'relocate') {
    const [who, room] = rest;
    if (!who || !room) { console.error('usage: relocate <name[,name]> <room> [--at row,col]'); return 2; }
    const at = a.at ? String(a.at).split(',').map(Number) : [];
    const r = await relocate(names(who), Number(room),
                             { row: at[0], col: at[1], verify: a.verify !== undefined });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }

  if (verb === 'kit') {
    const [who] = rest;
    if (!who) { console.error('usage: kit <name> [--stats 50] [--health N] [--mana N] [--karma N] [--skills N] [--spells N] [--money N] [--reagents N]'); return 2; }
    const num = k => (a[k] === undefined ? null : Number(a[k]));
    const want = { stats: num('stats'), health: num('health'), mana: num('mana'),
                   karma: num('karma'), skills: num('skills'), spells: num('spells'),
                   money: num('money'), reagents: num('reagents') };
    for (const n of names(who)) {
      const r = await kit(n, want);
      console.log(`${n}: ${JSON.stringify(r)}`);
    }
    return 0;
  }

  if (verb === 'heal') {
    const [who] = rest;
    if (!who) { console.error('usage: heal <name[,name]>'); return 2; }
    console.log(JSON.stringify(await heal(names(who)), null, 2));
    return 0;
  }

  if (verb === 'exec') {
    const out = await dm(rest.join(' ').split(';').map(s => s.trim()).filter(Boolean));
    process.stdout.write(out);
    return 0;
  }

  console.error(`unknown verb: ${verb}`);
  return 2;
}

// Importable for its builders without running anything — a Windows path is not a URL
// and is not comparable to import.meta.url without pathToFileURL, which is the same
// trap m59-supervise.mjs documents at its own entry-point guard.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error(e.message); process.exit(1);
  });
}
