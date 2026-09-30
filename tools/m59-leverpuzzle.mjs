#!/usr/bin/env node
// A ROOM THAT TAKES TWO PEOPLE TO OPEN, WORKED BY THE KEEPER ON THE WAY THROUGH.
//
//   node tools/m59-leverpuzzle.mjs            the declared puzzles, and who holds which lever now
//   node tools/m59-leverpuzzle.mjs --json     the same, for a script
//
// Operator, 2026-09-30: "those need to be hooked up to be basically automatic for travel to
// marion crypt2, because those two steps will always be in the way". The second of the two steps
// is room 2600, The crypt in Marion, and it is not a route. It is a lever puzzle
// (kod/object/active/holder/room/monsroom/marcryp1.kod, kod/object/passive/gstlever.kod):
//
//   * Two GuestLevers, r27c4 and r27c9. A lever answers only within ONE square (GUESTLEVER_RANGE),
//     so the pullers stand at r26c4 and r26c9. One lever switched lifts SECTOR_DOOR (3) to 128 and
//     a SlamTimer of SLAM_TIME = 2000 ms resets both. BOTH switched inside that window calls
//     OpenFinalDoor: sector 3 goes to 172 (shut is 84).
//   * The final area is rows 28-38, cols 1-10, PLUS every square west of col 3 below row 15
//     (CountInFinal's second clause). FightTimer runs every FIGHT_TIME = 10 s and calls ResetFinal
//     — levers up, doors shut, a living statue at r32c7 and five spectral mummies respawned — the
//     moment no player is inside it.
//   * Killing every monster in the final area while a player is inside calls OpenDoorDown:
//     SECTOR_EXIT1 (6) to 273 and SECTOR_EXIT2 (7) to 161, the well at r35-38 c6-7, whose
//     go-exits r38c6/r38c7 lead to 2601. OpenDoorDown also SHUTS the final door behind the
//     fighters, so a character still outside when the well opens waits for the next cycle.
//
// No character can do that alone, and no two processes here talk to each other. So:
//
//   1. WHO PULLS is settled in a small fleet-scoped book, `substrate/lever-claims-<fleet>.json`,
//      the same shape as the war book in m59-war.mjs: atomic rename, strict read before a write,
//      and a claim that nobody refreshes EXPIRES rather than holding a lever for a dead keeper.
//   2. WHEN THEY PULL is a shared wall-clock beat, the idea `beatOf` gives the wand volley in
//      m59-pvp-gear.mjs: both keepers are on one machine and one clock, so "the next 5 s boundary
//      at least 800 ms away" is the same instant for both of them without either asking the
//      other. The first to decide writes that beat into the book and the partner adopts it while
//      it is still ahead, which is what stops a 100 ms disagreement becoming a missed window.
//   3. WHETHER IT WORKED is read from the DOOR, never from the lever's reply: on a keeper-backed
//      character "You switch the lever." does not reliably come back, and a pull that "failed" by
//      every reply-shaped test had opened the door (2026-09-30). Sector 3 at 172 is the answer.
//
// AND THE DOOR IS TRUSTED ONLY FROM INSIDE THE ROOM. A `look` taken in Marion (200) carried
// 2600's door heights from the keeper's last visit — sector 3 at 172 while the door was shut at
// 84 — and a live errand that believed it sent six characters at a shut door (2026-09-30). The
// client clears `room.sectorHeights` on every BP_PLAYER, so a height read while the world says we
// stand in the puzzle room was sent for THIS visit; anything read elsewhere is refused. And it is
// re-read every pass: nothing here latches "the levers are open".
//
// The keeper side is `passLeverPuzzle` in m59-autopilot.mjs. This file is the declaration, the
// book and the decisions, all pure or fs-only, so m59-leverpuzzle-test.mjs can pin them offline.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

// ------------------------------------------------------------------ the declaration

// Squares are { row, col } (docs/m59-coordinates.md): named fields, never a bare pair.
const sq = (row, col) => Object.freeze({ row, col });

/**
 * THE PUZZLES THIS KEEPER KNOWS HOW TO WORK. One entry per room, keyed by room number.
 *
 * Data rather than code so another two-person room is an entry, not a branch — but only the
 * shape one real room needed. Every number is cited to the kod or to a walk that was measured.
 */
export const LEVER_PUZZLES = Object.freeze({
  2600: Object.freeze({
    room: 2600,
    to: 2601,
    name: 'The crypt in Marion',
    cite: 'kod/object/active/holder/room/monsroom/marcryp1.kod; kod/object/passive/gstlever.kod',
    // CreateLevers: NewHold at r27c4 and r27c9. The stand square is one north of each: the hall
    // side, since r28 is already inside the final area behind the shut door.
    levers: Object.freeze([
      Object.freeze({ lever: sq(27, 4), stand: sq(26, 4) }),
      Object.freeze({ lever: sq(27, 9), stand: sq(26, 9) }),
    ]),
    leverName: /lever/i,
    leverRange: 1,                 // GUESTLEVER_RANGE, a Chebyshev distance (gstlever.kod TryActivate)
    windowMs: 2000,                // SLAM_TIME
    fightTimerMs: 10000,           // FIGHT_TIME
    door: Object.freeze({ sector: 3, open: 172, shut: 84 }),              // SECTOR_DOOR
    well: Object.freeze({
      sectors: Object.freeze([Object.freeze({ sector: 6, open: 273, shut: 200 }),    // SECTOR_EXIT1
                              Object.freeze({ sector: 7, open: 161, shut: 88 })]),   // SECTOR_EXIT2
      exits: Object.freeze([sq(38, 6), sq(38, 7)]),                       // goExits -> 2601
    }),
    // MIN/MAX_FINAL_ROW/COL, and CountInFinal's `iCol < HALL_EAST AND iRow > HALL_NORTH`.
    final: Object.freeze({ rows: [28, 38], cols: [1, 10], alsoWestOfCol: 3, alsoBelowRow: 15 }),
    enterAt: sq(30, 6),            // inside, and within 3 squares of the statue so it wakes
    stage: sq(27, 6),              // between the two levers, just north of the final door (walked 2026-09-30)
    hall: Object.freeze({ rows: [24, 27], cols: [1, 12] }),
    foeNames: /statue|mummy|skeleton/i,
    // THE WAY DOWN FROM THE ENTRANCE (r11c17), walked live by Bunsen 2026-09-30 in these legs:
    // east along row 18, north up col 23, round the east side, down to the ledge, the running
    // fall r32c30 -> r35c30 over the gully (the planner's fallTargets find it; nothing declared),
    // west along row 37, and up the ramp at col 12 into the lever hall. Legs, not one walk,
    // because a single walk of ~110 steps is longer than one pass should hold the body.
    approach: Object.freeze([sq(18, 22), sq(9, 25), sq(16, 34), sq(30, 38), sq(37, 36),
                             sq(29, 32), sq(32, 30), sq(35, 30),
                             sq(37, 20), sq(37, 12), sq(29, 12), sq(25, 8)]),
  }),
});

/** The puzzle that stands in this room, or null. */
export function leverPuzzleFor(room) {
  const n = Number(room);
  return Number.isFinite(n) ? (LEVER_PUZZLES[n] ?? null) : null;
}

/**
 * Is a journey from `here` to `to` one this keeper has to WORK rather than walk? True only in the
 * puzzle room itself and only for its own destination: a character already below (2601) never
 * comes back up for this, and one merely passing near the crypt is not caught by it.
 */
export function puzzleBlocksJourney(here, to) {
  const p = leverPuzzleFor(here);
  return !!p && Number(to) === p.to;
}

// ------------------------------------------------------------------ geometry

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
export const chebyshev = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const dist = (a, b) => Math.hypot(a.row - b.row, a.col - b.col);

/** Inside the final BOX — where a character walks to so FightTimer counts it. */
export function inFinalBox(pos, puzzle) {
  if (!pos || !puzzle?.final) return false;
  return inRange(pos.row, puzzle.final.rows) && inRange(pos.col, puzzle.final.cols);
}

/** Inside what CountInFinal counts — the box, and the strip west of col 3 below row 15. */
export function inFinalZone(pos, puzzle) {
  if (!pos || !puzzle?.final) return false;
  if (inFinalBox(pos, puzzle)) return true;
  const f = puzzle.final;
  return f.alsoWestOfCol != null && pos.col < f.alsoWestOfCol && pos.row > f.alsoBelowRow;
}

export function inHall(pos, puzzle) {
  return !!pos && !!puzzle?.hall && inRange(pos.row, puzzle.hall.rows) && inRange(pos.col, puzzle.hall.cols);
}

/** Standing where this lever answers: within `leverRange` of it, and not behind the door. */
export function atLever(pos, puzzle, ix) {
  const l = puzzle?.levers?.[ix];
  return !!pos && !!l && chebyshev(pos, l.lever) <= (puzzle.leverRange ?? 1) && !inFinalBox(pos, puzzle);
}

/**
 * The monsters CountInFinal counts. `objects` are plain rows: { id, name, row, col, player,
 * attackable }. A PLAYER IS NEVER A FOE HERE, whatever it is called — the war response owns PvP.
 */
export function finalFoes(objects, puzzle) {
  return (objects ?? []).filter(o => o && !o.player && inFinalZone(o, puzzle)
    && (o.attackable || puzzle.foeNames?.test(String(o.name ?? ''))));
}

// ------------------------------------------------------------------ the doors

/**
 * Door heights this keeper may believe, as `sector -> kod height`, or NULL.
 *
 * NULL unless the body is in the puzzle room — see the header: a height read from Marion was a
 * previous visit's. `sectorHeights` is the client's live map (`sector -> {height,...}`), cleared on
 * every room entry, so while the world says we are here, what it holds was sent for this visit.
 * A sector with no entry has not moved since the server replayed the room to us: it is at the
 * height the .roo shipped, which for every door here is SHUT.
 */
export function trustedDoorHeights({ roomNum, puzzle, sectorHeights }) {
  if (!puzzle || Number(roomNum) !== puzzle.room) return null;
  const out = {};
  const entries = sectorHeights instanceof Map ? [...sectorHeights]
    : Object.entries(sectorHeights ?? {});
  for (const [k, v] of entries) {
    const h = typeof v === 'object' ? v?.height : v;
    if (Number.isFinite(Number(h))) out[Number(k)] = Number(h);
  }
  return out;
}

/** 'open' | 'shut' | 'ajar' (one lever: 128) | 'unknown' (not trusted). */
export function doorState(heights, door) {
  if (!heights || !door) return 'unknown';
  const h = heights[door.sector];
  if (h == null) return 'shut';                  // never moved this visit: the shipped height
  if (h === door.open) return 'open';
  if (h === door.shut) return 'shut';
  return 'ajar';
}

/** The well is open when either exit sector has reached its open height. */
export function wellState(heights, well) {
  if (!heights || !well) return 'unknown';
  return well.sectors.some(s => heights[s.sector] === s.open) ? 'open' : 'shut';
}

// ------------------------------------------------------------------ the beat

export const PULL_BEAT_MS = 5000;
// A decision made closer to the boundary than this aims at the NEXT one, so the partner, whose
// pass may be a second behind, is still in time to adopt it.
export const PULL_LEAD_MS = 800;
// A proposed beat the partner adopts only if it is still at least this far ahead.
export const ADOPT_MIN_MS = 150;

export const beatOf = (now, period = PULL_BEAT_MS) => Math.floor(now / period);
export const beatStart = (beat, period = PULL_BEAT_MS) => beat * period;

/** The first beat boundary at least `lead` ms after `now`. */
export function nextPullBeat(now, { period = PULL_BEAT_MS, lead = PULL_LEAD_MS } = {}) {
  let b = beatOf(now, period) + 1;
  while (beatStart(b, period) - now < lead) b++;
  return b;
}

// ------------------------------------------------------------------ the book

export const CLAIM_TTL_MS = 60_000;      // a claim nobody refreshed in a minute belongs to a dead keeper
export const READY_FRESH_MS = 15_000;    // "standing at my lever" must be this recent to pull on

export const emptyBook = () => ({ format: 'm59-lever-claims/1', rooms: {} });

function roomOf(book, room) {
  book.rooms ??= {};
  const r = (book.rooms[String(room)] ??= { levers: {}, beat: null });
  r.levers ??= {};
  return r;
}

/** Drop every claim not refreshed within `ttl`, and a beat that has passed. Mutates and returns. */
export function pruneBook(book, now, { ttl = CLAIM_TTL_MS, period = PULL_BEAT_MS } = {}) {
  for (const r of Object.values(book?.rooms ?? {})) {
    for (const [ix, c] of Object.entries(r.levers ?? {}))
      if (!c?.agent || !(now - Number(c.seen ?? c.at ?? 0) <= ttl)) delete r.levers[ix];
    if (r.beat != null && beatStart(r.beat, period) + 2 * period < now) r.beat = null;
  }
  return book;
}

/** Which lever this agent holds in this room, or null. Reads, never mutates. */
export function heldLever(book, room, agent, now, { ttl = CLAIM_TTL_MS } = {}) {
  const levers = book?.rooms?.[String(room)]?.levers ?? {};
  for (const [ix, c] of Object.entries(levers))
    if (c?.agent === agent && now - Number(c.seen ?? 0) <= ttl) return Number(ix);
  return null;
}

/**
 * Take a free lever, or refresh the one already held. Mutates `book`.
 * @returns the lever index held afterwards, or null when both are held by other characters.
 * `pos` orders free levers nearest first, so two arrivals from the same side do not both head for
 * the far one.
 */
export function claimLever(book, { puzzle, agent, now, pos = null, ttl = CLAIM_TTL_MS }) {
  pruneBook(book, now, { ttl });
  const r = roomOf(book, puzzle.room);
  const mine = heldLever(book, puzzle.room, agent, now, { ttl });
  if (mine != null) { r.levers[mine].seen = now; return mine; }
  const order = puzzle.levers.map((l, ix) => ({ ix, d: pos ? dist(pos, l.stand) : ix }))
    .sort((a, b) => a.d - b.d || a.ix - b.ix);
  for (const { ix } of order) {
    if (r.levers[ix]) continue;
    r.levers[ix] = { agent, at: now, seen: now, ready: null };
    return ix;
  }
  return null;
}

/** Let go of every lever this agent holds in this room. Mutates `book`. */
export function releaseLevers(book, { room, agent }) {
  const r = book?.rooms?.[String(room)];
  if (!r) return false;
  let any = false;
  for (const [ix, c] of Object.entries(r.levers ?? {}))
    if (c?.agent === agent) { delete r.levers[ix]; any = true; }
  if (!Object.keys(r.levers ?? {}).length) r.beat = null;
  return any;
}

/** "I am standing at my lever" — refreshed every pass while it is true. Mutates `book`. */
export function markReady(book, { room, agent, now, ready = true }) {
  const r = book?.rooms?.[String(room)];
  const ix = heldLever(book, room, agent, now);
  if (!r || ix == null) return false;
  r.levers[ix].seen = now;
  r.levers[ix].ready = ready ? now : null;
  return true;
}

/**
 * THE RULE THAT DECIDES A PULL: both levers held, by two different characters, both standing at
 * them recently enough to be believed. Nothing else — in particular not whether anybody ELSE is in
 * the hall, because a third character cannot pull anything.
 */
export function partnerReady(book, { room, agent, now, fresh = READY_FRESH_MS, ttl = CLAIM_TTL_MS }) {
  const levers = book?.rooms?.[String(room)]?.levers ?? {};
  const live = Object.values(levers).filter(c => c?.agent && now - Number(c.seen ?? 0) <= ttl);
  if (live.length < 2) return false;
  const agents = new Set(live.map(c => c.agent));
  if (agents.size < 2 || !agents.has(agent)) return false;
  return live.every(c => c.ready != null && now - Number(c.ready) <= fresh);
}

/**
 * The beat both pullers aim at. Adopt the one already in the book while it is still at least
 * ADOPT_MIN_MS ahead; otherwise propose the next one at least `lead` away. Mutates `book`.
 */
export function agreeBeat(book, { room, now, period = PULL_BEAT_MS, lead = PULL_LEAD_MS }) {
  const r = roomOf(book, room);
  if (r.beat != null && beatStart(r.beat, period) - now >= ADOPT_MIN_MS)
    return { beat: r.beat, fireAt: beatStart(r.beat, period), adopted: true };
  r.beat = nextPullBeat(now, { period, lead });
  return { beat: r.beat, fireAt: beatStart(r.beat, period), adopted: false };
}

// ------------------------------------------------------------------ the book on disk

/** `substrate/lever-claims-<fleet>.json`, or `M59_LEVER_CLAIMS_FILE`. Fleet-scoped like the war book. */
export function claimsFile(env = process.env) {
  if (env.M59_LEVER_CLAIMS_FILE) return env.M59_LEVER_CLAIMS_FILE;
  let name = null;
  try { name = fleetName(process.argv.slice(2), env); } catch { name = null; }
  return join(HERE, 'substrate', name ? `lever-claims-${name}.json` : 'lever-claims.json');
}

function parseBook(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  return { ...emptyBook(), ...raw, rooms: raw.rooms && typeof raw.rooms === 'object' ? raw.rooms : {} };
}

/**
 * A READ THAT FAILS IS NOT AN EMPTY BOOK — for a WRITER. Same rule as the war book: `strict`
 * refuses to proceed on a file that will not parse, so a half-written file is never written back
 * as emptiness. A plain reader gets an empty book, which here costs one pass of "nobody holds a
 * lever" and nothing permanent.
 */
export function readClaims({ file = claimsFile(), strict = false } = {}) {
  if (!existsSync(file)) return emptyBook();
  try { return parseBook(readFileSync(file, 'utf8')); }
  catch (e) {
    if (strict) throw new Error(`lever claims at ${file} will not parse (${e.message}); refusing to overwrite it`);
    return emptyBook();
  }
}

function writeClaims(book, file) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 1));
  // Rename is atomic; on Windows it can be refused while another process has the target open.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); break; }
    catch (e) {
      if (i >= 20) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
    }
  }
}

/** Read strictly, apply `fn(book)`, write atomically. Returns `{ book, result }`. */
export function updateClaims(fn, { file = claimsFile(), now = Date.now() } = {}) {
  const book = pruneBook(readClaims({ file, strict: true }), now);
  const result = fn(book);
  writeClaims(book, file);
  return { book, result };
}

/**
 * Claim through the file, then READ IT BACK. Two keepers arriving in the same second can both
 * read "lever 0 is free" and both write; rename makes the last write win, so the loser learns it
 * lost by reading, not by being told. Returns the lever index this agent really holds, or null.
 */
export function claimLeverOnDisk({ puzzle, agent, pos = null, file = claimsFile(), now = Date.now() }) {
  updateClaims(book => claimLever(book, { puzzle, agent, now, pos }), { file, now });
  return heldLever(readClaims({ file }), puzzle.room, agent, now);
}

// ------------------------------------------------------------------ the decision

/**
 * THE WHOLE PUZZLE AS ONE PURE FUNCTION OF WHAT THE KEEPER CAN SEE. Returns one action for this
 * pass; the keeper executes it and asks again next pass. Nothing is remembered between calls that
 * the world does not also say — the door is re-read every time.
 *
 * kinds:
 *   not_here        not in the puzzle room, or position unknown
 *   descend         in the final area and the well is open: walk to an exit square and go
 *   fight           in the final area with an attackable monster in it
 *   wake            in the final area; the only monsters left are dormant (the statue)
 *   hold_final      in the final area, nothing left to fight, the well not yet open
 *   enter_final     the final door is open: get inside before FightTimer finds it empty
 *   wait_cycle      the well is open but the final door has shut behind the fighters
 *   approach        the door is shut and this body is not in the lever hall yet
 *   claim           in the hall, no lever held, one is free
 *   wait_hall       in the hall, both levers held by others
 *   go_to_lever     holding a lever, not standing at it
 *   wait_partner    at my lever, the other is not held or its holder is not at it yet
 *   pull            at my lever, and so is the partner: pull on the agreed beat
 */
export function decideLeverStep({ puzzle, roomNum, pos, heights, book, agent, now, foes = [] }) {
  const status = (kind, why, extra = {}) => ({ kind, why, status: STATUS[kind] ?? why, ...extra });
  if (!puzzle || Number(roomNum) !== puzzle.room || !pos) return status('not_here', 'not in the puzzle room');
  const door = doorState(heights, puzzle.door);
  const well = wellState(heights, puzzle.well);
  const inside = inFinalBox(pos, puzzle);
  if (inside) {
    if (well === 'open') {
      const exit = [...puzzle.well.exits].sort((a, b) => dist(pos, a) - dist(pos, b))[0];
      return status('descend', 'the well is open', { exit, door, well });
    }
    const awake = foes.filter(o => o.attackable);
    if (awake.length) return status('fight', `${awake.length} monster(s) left in the final area`, { foes: awake, door, well });
    if (foes.length) {
      const foe = [...foes].sort((a, b) => dist(pos, a) - dist(pos, b))[0];
      return status('wake', `${foe.name ?? 'a monster'} is dormant; walking close wakes it`, { foe, door, well });
    }
    return status('hold_final', 'nothing left to fight; the well opens on the last kill', { door, well });
  }
  if (door === 'open') return status('enter_final', 'the final door is open', { to: puzzle.enterAt, door, well });
  const mine = heldLever(book, puzzle.room, agent, now);
  if (!inHall(pos, puzzle) && mine == null) return status('approach', 'not in the lever hall yet', { door, well });
  if (well === 'open') return status('wait_cycle', 'the well is open but the final door shut behind the fighters', { door, well });
  if (mine == null) {
    const r = book?.rooms?.[String(puzzle.room)]?.levers ?? {};
    const free = puzzle.levers.some((_, ix) => !r[ix] || !(now - Number(r[ix].seen ?? 0) <= CLAIM_TTL_MS));
    return free ? status('claim', 'a lever square is free', { door, well })
                : status('wait_hall', 'both lever squares are held by other characters', { to: puzzle.stage, door, well });
  }
  if (!atLever(pos, puzzle, mine))
    return status('go_to_lever', `holding lever ${mine}`, { lever: mine, to: puzzle.levers[mine].stand, door, well });
  if (partnerReady(book, { room: puzzle.room, agent, now }))
    return status('pull', 'both lever squares are manned', { lever: mine, door, well });
  return status('wait_partner', 'nobody is at the other lever', { lever: mine, door, well });
}

// What the keeper's status says for each kind — in the words an operator watching would use.
export const STATUS = Object.freeze({
  descend: 'lever puzzle: going down the well',
  fight: 'lever puzzle: clearing the final area',
  wake: 'lever puzzle: waking the statue',
  hold_final: 'lever puzzle: holding the final area until the well opens',
  enter_final: 'lever puzzle: entering the final area',
  wait_cycle: 'lever puzzle: waiting for the next cycle (the final door shut behind the fighters)',
  approach: 'lever puzzle: walking to the lever hall',
  claim: 'lever puzzle: taking a lever',
  wait_hall: 'lever puzzle: waiting in the hall (both levers are manned)',
  go_to_lever: 'lever puzzle: walking to my lever',
  wait_partner: 'waiting for a second lever puller',
  pull: 'lever puzzle: pulling on the beat',
});

// ------------------------------------------------------------------ the approach

/**
 * The next square of the declared approach. `memo` carries the index this visit has reached; with
 * none, it starts from the nearest declared square (and past it, when already standing on it).
 */
export function nextApproachLeg(pos, puzzle, memo = null) {
  const legs = puzzle?.approach ?? [];
  if (!legs.length || !pos) return null;
  if (memo && Number.isInteger(memo.index) && memo.index >= 0 && memo.index < legs.length)
    return { index: memo.index, to: legs[memo.index] };
  let k = 0;
  for (let i = 1; i < legs.length; i++) if (dist(pos, legs[i]) <= dist(pos, legs[k])) k = i;
  const index = dist(pos, legs[k]) <= 1.5 ? Math.min(k + 1, legs.length - 1) : k;
  return { index, to: legs[index] };
}

// ------------------------------------------------------------------ the CLI

function main(argv) {
  const book = readClaims();
  const now = Date.now();
  const rows = Object.values(LEVER_PUZZLES).map(p => ({
    room: p.room, to: p.to, name: p.name,
    levers: p.levers.map((l, ix) => {
      const c = book.rooms?.[String(p.room)]?.levers?.[ix];
      return { lever: `r${l.lever.row}c${l.lever.col}`, stand: `r${l.stand.row}c${l.stand.col}`,
               held_by: c?.agent ?? null, seen_s_ago: c ? Math.round((now - c.seen) / 1000) : null,
               ready: c?.ready != null ? Math.round((now - c.ready) / 1000) + 's ago' : null };
    }),
  }));
  if (argv.includes('--json')) { console.log(JSON.stringify({ file: claimsFile(), puzzles: rows }, null, 2)); return; }
  console.log(`lever claims: ${claimsFile()}`);
  for (const r of rows) {
    console.log(`\n${r.room} ${r.name} -> ${r.to}`);
    for (const l of r.levers)
      console.log(`  lever ${l.lever} (stand ${l.stand}): ${l.held_by ? `${l.held_by}, seen ${l.seen_s_ago}s ago${l.ready ? `, at it ${l.ready}` : ''}` : 'free'}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
