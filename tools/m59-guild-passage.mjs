// Walk a surveyed guild hall's doors (714, 713, 703) from their reachable trigger sides.
// The closed-state geometry identifies which section the character occupies;
// actual movement always uses the live, collision-checked session geometry.
import { readFileSync } from 'node:fs';
import { RoomGeometry, applySectorHeights } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { doorsFor } from './m59-doorplan.mjs';
import { waitForDoorOpen, refusedToGo, doorRetryAt } from './m59-door-wait.mjs';
import { noteDoorPressRefused, doorPressPose } from './m59-door-refusal.mjs';

// THE HALLS WHOSE PASSAGE IS SURVEYED, ONE TABLE EACH, KEYED BY ROOM NUMBER.
//
// This file was entirely the Bookmaker's Guild House (714) until the roster held a second guild.
// A hall is a chain of SECTIONS (closed-door regions, one anchor each, numbered from the foyer)
// with one DOOR between each neighbouring pair: `doors[i]` joins section i to section i+1. Every
// function below takes the hall from the room the body is standing in (`s.world.room.num`) and
// a hall that is not in `HALLS` is refused by name (autopilot/hall.mjs `hallHere`) rather than
// walked with another hall's doors. Squares are [row, col] throughout, as in the kod.
//
// A door's `inward` / `outward` are [trigger, across]: where to stand to work it, and the first
// square on the far side. A door is one of three kinds:
//   pressed   (default)        `go` on the trigger, wait for the server's sector-height event
//   secret                     SAY the guild password on the trigger, then wait as for a press
//   secret + teleport          SAY the password on the trigger and the server MOVES the body
//                              to `across` (UtilGoNearSquare); no sector moves, so there is no
//                              height to wait for -- the position is the fact
//   secret + lift              a FLOOR the password lowers and a timer raises (703's bridge): SAY
//                              it on the bank trigger, wait for the floor's sector-height event,
//                              board, walk the `deck` to its far end, and if the floor has risen
//                              under the body say it again and step off to `across` once it is
//                              down -- an elevator ridden, see `rideLift`
export const LEGACY_HALL = 714;
export const anchors = [[2,32],[5,28],[17,10],[7,8],[18,4]];
// EVERY DOOR IN THIS HALL IS SPOKEN, NOT PRESSED — INCLUDING ON THE WAY OUT.
//
// Operator, 2026-09-20: "It's not a traditional 'press space' door, you have to say the guild
// CORRECTED 2026-09-20 by the operator, and the earlier note here was overboard.
//
// It read "every door in this hall is SPOKEN, not pressed" and set `secret: true` on 59, 55
// and 53 as well as 3. That is wrong and it is the expensive direction of wrong: it makes a
// character SAY THE GUILD PASSWORD at three ordinary doors, out loud, in a hall on a shared
// server, to open something that only needed a press and a wait.
//
// What is actually true, in the operator's words: "not EVERY door is a secret door in the
// hall. The west-most door in that hall is the secret door. The rest of the doors are normal
// doors but open slow: all guild hall doors open slow, only the chest room requires the
// password."
//
// So the failure the earlier note was chasing -- `guild door 59 could not be crossed` after
// three attempts -- is a door that had not finished opening yet, not a door listening for a
// word. The verb was right and the patience was not. This matches the kod: `m59-doors.mjs`
// derives 59, 55, 53 and 58 from `SomethingTryGo` handlers, and only sector 3 -- SECRET_DOOR
// in guildh14.kod -- is reached through `SomeoneSaid` comparing against the guild password.
//
// `secret` therefore stays a per-door flag and sector 3 is the only door that carries it.
// The old note follows, kept because the reagent_coop consequence it records is real:
// hall password to open it (even to get out!)". Only sector 3 carried `secret: true`, so the
// crossing below sent `c.go()` for 59, 55 and 53 — the branch is literally
// `if (door.secret) sayHallPassword() else c.go()`. Pressing space at a door that answers only
// to a word does nothing, three times over, and then reports `guild door 59 could not be
// crossed` — which reads as geometry and is a verb.
//
// WHAT IT COST. `reagent_coop` is the ONLY caller of `getFromContainer` in this repository, and
// its `approach()` crosses these doors to get within the 7 squares `user.kod UserGet` wants. So
// this one flag is the whole reason a character standing in its own guild hall cannot draw on
// it: 543 elderberry, 446 mushroom and 490 red mushroom sitting in the chests, none reachable.
// DEPOSITS WERE EQUALLY DEAD — `transfer()` runs the same `approach()` for both directions and
// only then branches on `put` vs `getFromContainer` — so "contribute" never worked either.
// Nobody had noticed because nothing had asked it to.
//
// It also re-reads the older sighting this file already records: Zoot spending an hour on door
// 59's OUTWARD trigger with the hall's only exit two squares away, logged at the time as a
// geometry race. The trigger was reached every pass. The door was never asked to open.
//
// `secret` stays a per-door flag rather than becoming a hall-wide assumption, so a hall with a
// genuinely pressed door can still say so.
export const doors = [
  { sector: 59, inward: [[3,28],[5,28]], outward: [[4,28],[2,28]] },
  { sector: 55, inward: [[19,10],[17,10]], outward: [[18,10],[20,10]] },
  { sector: 53, inward: [[13,13],[11,13]], outward: [[11,13],[13,13]] },
  { sector: 3, inward: [[7,8],[7,4]], outward: [[7,4],[7,8]], secret: true, within_ms:5000 },
];

// THE HALL OF THE SLAUGHTERED COMMAND (713, guildh13.kod), the Rowlfs of War's hall on Ko'catan.
// Three sections, two doors, and its secret door is not a door at all.
//
//   section 0  the L-shaped FOYER (InFoyer, guildh13.kod:219-241: rows 1-13, cols 1-7, and only
//              cols 1-4 below row 4). Anchor r9c3 is viTeleport (guildh13.kod:40-41), which is
//              where a Rescue / Chalice of the Rain lands a member arriving from elsewhere in
//              Ko'catan (rescue.kod:136 -> room.kod:785 Teleport; ghall.kod:1208 propagates for
//              anyone not already inside).
//   section 1  the hall proper. Anchor r5c28 is viInner_teleport (guildh13.kod:61-62).
//   section 2  the CHEST ROOM, rows 9-14 cols 23-30, the four chests at r12c24, r13c24, r12c29,
//              r13c29 (guildh13.kod:313-320). Sealed in every door state: no step crosses the
//              wall on the row 8 / row 9 boundary at cols 26-27 (moverStepLands, both ways).
//
//   door 4     MAIN_DOOR (guildh13.kod:15-17), a ceiling slab on the col 7 / col 8 boundary,
//              rows 1-4, opened 360 -> 500 for DOOR_DELAY 5 s. Pressed from the foyer on col 7
//              (plGuild_doors, guildh13.kod:82, matched by ghall.kod:981 SomethingTryGo, gated on
//              CanEnter) and from inside on col 8 (guildh13.kod:123-137, gated on ReqLegalEntry).
//              Inward crosses hotplates 1 then 2 on cols 8 and 9 in that order (guildh13.kod:337).
//   door 5     SECRET_DOOR. Sector 5 itself is a sliver on r9c26-27 that every arriving user
//              lifts to its OPEN height at speed 0 (NewHold, guildh13.kod:112-121) and nothing
//              ever lowers (Open/CloseSecretDoor are no-ops, :284-294) -- it is never the barrier.
//              The barrier is a wall, and the way through is WalkThroughSecretWall
//              (guildh13.kod:191-217): the owner's password said outside the foyer
//              (SomeoneSaid, :180-186) moves a speaker on row 8 to row 10, and one on row 9 to
//              row 7, same column, for cols 26 and 27 only. Hence `teleport`.
const SLAUGHTERED_COMMAND = {
  room: 713, name: 'The Hall of the Slaughtered Command',
  anchors: [[9,3],[5,28],[12,26]],
  doors: [
    { sector: 4, inward: [[3,7],[3,9]], outward: [[3,8],[3,6]] },
    { sector: 5, inward: [[8,26],[10,26]], outward: [[9,26],[7,26]], secret: true, teleport: true, within_ms: 4000 },
  ],
  chestSection: 2, insideSection: 1, booth: false,
};
// THE DEN OF SHADOWS (703, guildh3.kod), Rizzo's Revenge's hall off the Lake of Jala's Song (568).
// Three sections, two doors, and its secret door is a FLOOR: an elevator, not a door.
//
//   section 0  the FOYER (viFoyer 1/8/1/7, guildh3.kod:45-48: rows 1-8, cols 1-7). Anchor r5c4 is
//              viTeleport (guildh3.kod:42-43), where a Rescue lands a member. Its `go` exit r5c1 is
//              the front door to 568 (guildh3.kod CreateStandardExits).
//   section 1  the hall proper, west of and north of the river. Anchor r12c16 is viInner_teleport
//              (guildh3.kod:55-56).
//   section 2  the FAR BANK: south of the river's east-west arm and east of its north-south arm,
//              holding both chests (r26c9 and r29c9, guildh3.kod:172 CreateStandardObjects) on a 588
//              shelf up a stair at cols 11-12, and the back stair to the room's second `go` exit
//              r25c1 (568's password door at r26c50 lands at r25c2, f8.kod). Anchor r27c9, between
//              the two chests.
//
//   door 1     ENTRANCE (guildh3.kod:16), a ceiling slab between cols 7 and 8 lifted 500 -> 580 for
//              LIFT_DELAY 10 s. Pressed from the foyer on r5c7 (plGuild_doors, guildh3.kod:76,
//              matched by ghall.kod SomethingTryGo, gated on CanEnter) and from inside on r5c8
//              (guildh3.kod SomethingTryGo, gated on ReqLegalEntry). Inward crosses hotplate 1
//              (r5c8) then 2 (r5c9) in that order (CreateHotPlates, guildh3.kod:214).
//   door 2     BRIDGE (guildh3.kod:15), the password door, and it is a FLOOR (ANIMATE_FLOOR_LIFT,
//              m59-variable-sectors.json kind 'floor') -- two of them. Sector 2 is the bridge's two END
//              PLATFORMS (north r17c13-14, south r20c15-r21c17) over the river's corner; the span
//              between them is a fixed floor at 654. Both platforms ship at BRIDGE_HIGH 654, flush with
//              the span and 154 above both banks (500), so at rest the bridge is a wall from either
//              bank. The owner's password said by a member outside the foyer (ghall.kod SomeoneSaid;
//              GuildHall3 never sets pbSecretDoorOpen, so the only guard is its own ptBridge timer)
//              calls OpenSecretDoor (guildh3.kod:149): both platforms LOWER to BRIDGE_LOW 500 at speed
//              16 (154 units, ~9.6 s), and LIFT_DELAY 10 s after the saying they RISE again
//              (CloseSecretDoor, :162). A saying while that timer runs is ignored. Hence `lift`, an
//              elevator ridden (see rideLift): say on the bank, step on when the platform is down, ride
//              it up, walk the span, say again, step off when the far platform is down -- the
//              operator's "say the password twice while riding it -- the first time to go up, then for
//              the elevator down" (2026-11-13). `deck` is the platforms' ends, [north, south].
//
//   THE RIVER IS THE MOAT, AND THAT IS AN ASSUMPTION THE STEP MASK DOES NOT SHARE. The river is a
//   492 channel 8 below its banks, and the coarse step mask lets a body wade it at r13-16 cols 16-18
//   (moverStepLands r13c16 -> r13c17 -> r13c18), which joins sections 1 and 2 without the bridge;
//   the server's walkable grid marks every river square walkable too. The operator's account is that
//   the chests are reached by the elevator, so section membership here treats every square whose
//   centre floor is below `moat.belowKod` as water nobody stands in (`moatSquares`), which splits the
//   hall exactly at the river. Which way a live body actually goes is the thing to confirm on prod.
const DEN_OF_SHADOWS = {
  room: 703, name: 'The Den of Shadows',
  anchors: [[5,4],[12,16],[27,9]],
  doors: [
    { sector: 1, inward: [[5,7],[5,9]], outward: [[5,8],[5,6]] },
    // `deck` is the two platforms, [north, south]: where a rider steps on, and off.
    { sector: 2, inward: [[16,14],[22,16]], outward: [[22,16],[16,14]], secret: true, lift: true,
      deck: [[17,14],[21,16]], within_ms: 12000 },
  ],
  moat: { belowKod: 497 },
  chestSection: 2, insideSection: 1, booth: false,
};
const BOOKMAKERS = {
  room: 714, name: "The Bookmaker's Guild House",
  anchors, doors,
  chestSection: 4, insideSection: 3, booth: true,
};
export const HALLS = Object.freeze({ 714: BOOKMAKERS, 713: SLAUGHTERED_COMMAND, 703: DEN_OF_SHADOWS });
export const SURVEYED_HALLS = Object.freeze([714, 713, 703]);

/** The surveyed passage of hall `room`, or null. */
export const hallSurvey = (room) => HALLS[Number(room)] ?? null;

/** The section that holds hall `room`'s chests (714: 4, 713: 2). Throws for an unsurveyed hall. */
export function chestSectionOf(room = LEGACY_HALL) {
  const hall = hallSurvey(room);
  if (!hall) throw new Error(`hall ${room} has no surveyed passage (only ${SURVEYED_HALLS.join(', ')})`);
  return hall.chestSection;
}

/**
 * Which hall a session is standing in. The room NUMBER, never the object id. A session that does
 * not carry a room at all -- the offline fakes written when there was one hall -- is 714, which is
 * what every caller meant before; a session that names a room this file has not surveyed throws.
 */
export function hallRoomOf(s) {
  const raw = s?.world?.room?.num;
  if (raw === undefined || raw === null) return LEGACY_HALL;
  const room = Number(raw);
  if (!hallSurvey(room))
    throw new Error(`hall ${raw} has no surveyed passage (only ${SURVEYED_HALLS.join(', ')}) — ` +
                    'refusing to walk another hall\'s doors in it');
  return room;
}

let CEILING = null;
const ceilingDoors = (room) =>
  (CEILING ??= JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url)))).rooms[room];

const CLOSED = new Map();
function closedGeometry(room) {
  if (!CLOSED.has(room)) {
    const data = ceilingDoors(room);
    const geo = RoomGeometry.fromJSON(loadMap().rooms[room].roo);
    const state = data.states[data.doors.map(d => d.closed).join(',')];
    applySectorHeights(geo, state.sectors, { mask: Buffer.from(state.mask, 'base64') });
    geo.attachStepMask(Buffer.from(state.mask, 'base64'));
    CLOSED.set(room, geo);
  }
  return CLOSED.get(room);
}

// THE MOAT: squares whose CENTRE floor (all doors shut) is below `hall.moat.belowKod` kod units, as
// "r,c" keys. Derived from the geometry every time, never typed -- 703's river is every square it
// names, and a re-bake that moves the river moves the moat with it. Empty for a hall with no moat.
const MOATS = new Map();
export function moatSquares(room) {
  const hall = hallSurvey(room);
  if (!hall?.moat) return new Set();
  if (!MOATS.has(hall.room)) {
    const g = closedGeometry(hall.room), out = new Set();
    for (let r = 1; r <= g.rows; r++) for (let c = 1; c <= g.cols; c++) {
      const x = (c - 1) * 1024 + 512, y = (r - 1) * 1024 + 512;
      const leaf = g.leafAtClient(x, y);
      if (leaf?.sector && g.floorBaseAtClient(x, y, leaf) / 16 < hall.moat.belowKod) out.add(`${r},${c}`);
    }
    MOATS.set(hall.room, out);
  }
  return MOATS.get(hall.room);
}

// SECTIONS OF A MOATED HALL: a mover-legal flood from each anchor, forwards and backwards, that never
// enters the moat. A square belongs to the first anchor that reaches it AND that it reaches -- the same
// two-way rule as `path` below, without the A* that would happily wade. Cached per hall.
const MOAT_SECTIONS = new Map();
function moatSections(hall) {
  if (MOAT_SECTIONS.has(hall.room)) return MOAT_SECTIONS.get(hall.room);
  const g = closedGeometry(hall.room), moat = moatSquares(hall.room);
  const lands = (a, b, c, d) => { try { return !!g.moverStepLands(a, b, c, d); } catch { return false; } };
  const flood = ([sr, sc], backwards) => {
    const seen = new Set([`${sr},${sc}`]), q = [[sr, sc]];
    for (let i = 0; i < q.length; i++) {
      const [r, c] = q[i];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const R = r + dr, C = c + dc, key = `${R},${C}`;
        if ((!dr && !dc) || R < 1 || C < 1 || R > g.rows || C > g.cols || seen.has(key) || moat.has(key)) continue;
        if (!(backwards ? lands(R, C, r, c) : lands(r, c, R, C))) continue;
        seen.add(key); q.push([R, C]);
      }
    }
    return seen;
  };
  const out = hall.anchors.map(a => ({ fwd: flood(a, false), back: flood(a, true) }));
  MOAT_SECTIONS.set(hall.room, out);
  return out;
}

/**
 * The section of the NEAREST square that has one, for a body standing where no section is (in a
 * moated hall: in the water, or on the bridge deck). Chebyshev rings outward; ties go to the
 * lower section, the one nearer the door out. -1 when nothing within 3 squares is filed. Used only
 * to decide which way to walk, never to decide that a crossing succeeded.
 */
export function nearestSection(row, col, room = LEGACY_HALL) {
  for (let d = 1; d <= 3; d++) {
    let best = -1;
    for (let r = row - d; r <= row + d; r++) for (let c = col - d; c <= col + d; c++) {
      if (Math.max(Math.abs(r - row), Math.abs(c - col)) !== d) continue;
      const s = guildSection(r, c, room);
      if (s >= 0 && (best < 0 || s < best)) best = s;
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Which section of hall `room` the square [row, col] is in, by the all-doors-shut geometry; -1 if none. */
export function guildSection(row, col, room = LEGACY_HALL) {
  const hall = hallSurvey(room);
  if (!hall) return -1;
  if (hall.moat) {
    const key = `${row},${col}`;
    return moatSections(hall).findIndex(s => s.fwd.has(key) && s.back.has(key));
  }
  const closed = closedGeometry(hall.room);
  // STRICT, NO GOAL EXEMPTION. `path` lets its final step into the goal skip `moverStepLands`
  // when no legal approach exists, which is right for a walker and wrong for a membership test:
  // the shut door's own slab is exactly a step the mover refuses, so a square ADJACENT to a shut
  // door reached it "both ways" and was filed on the far side. r7c7, one square short of the
  // secret door's across square, read as section 3 while the body was still sealed in with the
  // chests -- so a crossing that stopped in the doorway reported success, the door shut, and the
  // next leg answered `guild door 53 trigger not reached` (Camilla, prod 2026-10-01).
  //
  // STRICT FIRST, RELAXED ONLY WHEN STRICT HAS NO ANSWER. Strict alone unfiles squares people
  // stand on: r19c10 (door 55's inward trigger, where Animal sat for twelve hours) has no
  // mover-legal two-way path to any anchor, only a goal-exempt one. So a square keeps the old
  // reading when strict membership is empty, and only a square that strictly belongs somewhere
  // -- r7c7 strictly belongs to the chests -- is filed by it.
  const member = goalExempt => hall.anchors.findIndex(([r,c]) =>
    closed.path(row, col, r, c, { goalExempt }).found && closed.path(r, c, row, col, { goalExempt }).found);
  const strict = member(false);
  return strict >= 0 ? strict : member(null);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// THE BAKED LINE ACROSS EACH DOOR, AND WHY THERE IS ONE.
//
// The live plan below asks `s.world.geometry.path(...)` inside a 350ms wait for a `sector-height`
// event, in a window the door holds open for about five seconds. When the event has not arrived
// yet, the geometry it plans across is the SHUT hall, `path` reports not-found, and the crossing
// records `no live path across the open door` — which reads exactly like "there is no way out of
// this room". Zoot spent an hour on door 59's outward trigger answering that every pass, with the
// hall's only exit two squares away, and `come-home` gave up with route_progressing_exits_exhausted.
//
// The hall's geometry is ENUMERABLE — all 32 ceiling states are in substrate/m59-ceiling-doors.json
// — so the line across an open door is a fact that can be cut in advance. m59-guildrails.mjs cuts
// it against the state where that one door is up, verifies it with the mover's own trace, and
// writes substrate/rail-<room>.json (714, 713, 703). This reads it.
//
// IT IS A FALLBACK, NOT A REPLACEMENT. The live geometry is the only thing that knows about
// BODIES, and a rail knows only about the ceiling — so the live plan still goes first and the rail
// answers only when the live plan has nothing. That way this can fix the race and cannot cause one.
// One file per hall, `substrate/rail-<room>.json`.
const RAILS = new Map();
function bakedRails(room = LEGACY_HALL) {
  if (!RAILS.has(room)) {
    try {
      RAILS.set(room, JSON.parse(readFileSync(new URL(`../substrate/rail-${room}.json`, import.meta.url))));
    } catch { RAILS.set(room, false); }  // false, not absent: asked once, missing, do not re-read
  }
  return RAILS.get(room) || null;
}

/**
 * The baked crossing from one square to another, as SQUARES, deduped.
 *
 * The rail is cut on a 64-unit client lattice because that is what the mover enforces; `s.step`
 * takes a square. So the waypoints are collapsed to the square transitions they represent, which
 * is the same line expressed in the units the caller can act on. A COORDINATE CARRIES ITS UNIT:
 * waypoints are CLIENT (1024 to a square), the result is grid.
 */
export function bakedCrossing(from, to, sector, room = LEGACY_HALL) {
  const baked = bakedRails(Number(room));
  if (!baked) return null;
  const name = ([r, c]) => `r${r}c${c}`;
  const leg = baked.legs?.find(l => l.ok && l.from === name(from) && l.to === name(to) &&
                                    (l.doors_open ?? []).includes(sector));
  if (!leg?.waypoints?.length) return null;
  const out = [];
  for (const p of leg.waypoints) {
    const col = Math.floor(p.x / 1024) + 1, row = Math.floor(p.y / 1024) + 1;
    const last = out[out.length - 1];
    if (!last || last.row !== row || last.col !== col) out.push({ row, col });
  }
  // Drop the square we are already standing on; what is wanted is where to go NEXT.
  if (out.length && out[0].row === from[0] && out[0].col === from[1]) out.shift();
  return out.length ? out : null;
}
// STAND UP BEFORE EVERY WALK AND EVERY PRESS — THE THIRD TIME THIS HAS HAD TO BE WRITTEN.
//
// A resting character carries PFLAG_NO_MOVE (player.kod:1162): the server snaps every move
// back and answers every `go` with "You are unable to go anywhere." without ever asking the
// room. `standBeforeGo` exists for exactly this and every crossing in m59-session-walk uses
// it; this file called `c.go()` bare. Measured 2026-09-24 on prod: Kermit and Robin sat on
// door 55's trigger (r18c10) for eight and three hours, 1,900 failed journeys between them,
// each press refused while Zoot stood up on the same square and walked out. Animal, seated
// on the far side at r19c10, could not walk to door 59 (`no_ground_gained`) for twelve.
// A character already ON the trigger never walks, so nothing else ever stood it up.
//
// Per attempt, not once: the keeper sits between journeys, and a redundant stand is one packet.
async function standUp(s, isInterrupted) {
  if (typeof s.standBeforeGo === 'function')
    await s.standBeforeGo({ shouldCancel: isInterrupted }).catch(() => null);
}

// "(body at r4c28, trigger r3c28, seated:false, 0 bodies within 2 sq; ledger dp-3f2a9c01d4)": the
// scene of the last press that did not open, for the error a FleetScript prints.
const pressSuffix = p => p?.summary ? ` (${p.summary}${p.written && p.detail?.id ? `; ledger ${p.detail.id}` : ''})` : '';

// THE SECRET WALL MOVES THE BODY; NOTHING ELSE ANNOUNCES IT. WalkThroughSecretWall
// (guildh13.kod:191) is UtilGoNearSquare inside the room, which reaches us as our own BP_MOVE.
// So the only evidence is the position: poll it until it is in the section the wall leads to,
// then ask the server once (`confirmPosition`) before calling it a refusal, because a position
// that was predicted rather than read is exactly the kind that misses a server-side move.
async function awaitTeleport(s, c, room, target, { within_ms = 4000, isInterrupted = () => false } = {}) {
  const here = () => guildSection(c.self.row, c.self.col, room) === target;
  const until = Date.now() + within_ms;
  while (Date.now() < until) {
    if (here()) return true;
    if (isInterrupted()) return false;
    await sleep(150);
  }
  if (here()) return true;
  await s.confirmPosition?.();
  return here();
}

/**
 * A baked leg between two squares cut under exactly the door state `open` (sector ids that are at
 * their OPEN height), as squares to step to next -- the starting square dropped. Null when none.
 * Unlike `bakedCrossing` the state must match exactly: 703's lift has legs cut with the bridge DOWN
 * (`[2]`) and legs cut along the deck with it UP (`[]`), between the same squares.
 */
export function bakedLeg(from, to, open = [], room = LEGACY_HALL) {
  const baked = bakedRails(Number(room));
  if (!baked) return null;
  const name = ([r, c]) => `r${r}c${c}`, want = [...open].map(Number).sort((a, b) => a - b).join(',');
  const leg = baked.legs?.find(l => l.ok && l.from === name(from) && l.to === name(to) &&
    [...(l.doors_open ?? [])].map(Number).sort((a, b) => a - b).join(',') === want);
  if (!leg?.waypoints?.length) return null;
  const out = [];
  for (const p of leg.waypoints) {
    const col = Math.floor(p.x / 1024) + 1, row = Math.floor(p.y / 1024) + 1;
    const last = out[out.length - 1];
    if (!last || last.row !== row || last.col !== col) out.push({ row, col });
  }
  if (out.length && out[0].row === from[0] && out[0].col === from[1]) out.shift();
  return out.length ? out : null;
}

// ------------------------------------------------------------------ the lift (703's bridge)
//
// THE BRIDGE IS TWO ELEVATORS AND A SPAN. Sector 2 is not the whole bridge: it is its two END
// PLATFORMS, the north one at r17c13-14 and the south one at r20c15-r21c17. The span between them
// (r18c14 to r20c15) is an ordinary floor fixed at 654. At rest both platforms are UP at 654, flush
// with the span and 154 above both banks, so the bridge is a wall from either bank. The word drops
// BOTH platforms to the banks (500); LIFT_DELAY after the saying they rise again. Nothing crosses
// with the platforms down -- the span is then 154 above them. So a crossing is:
//
//   1. on the near bank (`trigger`), SAY the word; wait for the platforms' sector-height event (500)
//   2. step onto the near platform (`deck` end) once it is within a step of the bank
//   3. ride it up: wait for the rise (the timer, ~10 s after the saying) and for the platform to be
//      within a step of the span
//   4. walk the span to the far platform, which rose with ours
//   5. SAY the word again (its timer has run out: the rise IS the timer); wait for the event; step off
//      to `across` once the far platform is within a step of the bank
//
// which is the operator's "say the guild hall password twice while riding it -- the first time to go
// up, then for the elevator down" (2026-11-13), arrived at from the kod and the geometry.
//
// WHAT IS DERIVED AND WHAT IS ASSUMED, so the first live run knows what it is testing.
//
//   derived (kod)       the word lowers sector 2 to BRIDGE_LOW 500 at speed 16 and a timer raises it
//                       to BRIDGE_HIGH 654 LIFT_DELAY 10 s after the SAYING; a saying while that timer
//                       runs does nothing (ptBridge); only a member outside the foyer can call it
//                       (ghall.kod SomeoneSaid). Heights come from substrate/m59-ceiling-doors.json
//                       (kind 'floor'), whose masks are the .roo re-baked at each height.
//   derived (geometry)  which squares are platform and which span (sector records 93 and 94 carry
//                       server id 2); that r16c14 -> r17c14 and r21c16 -> r22c16 step only with the
//                       platforms down, and r17c14 -> r21c16 walks only with them up (moverStepLands,
//                       both states, and the four rails in substrate/rail-703.json).
//   assumed             that the river is a moat (see DEN_OF_SHADOWS); that a body on a platform is
//                       carried with it (the server is two-dimensional, so it is OUR geometry that
//                       decides, and it does); and the BOARDING waits -- our observer applies a
//                       sector's destination height the moment its packet arrives, so the mover would
//                       let a body step at once; waiting until the platform is within a step (24) of
//                       where it is going is what a real client has to do, and it costs ~8 s a leg.

/** The lift's two heights from the door table: `up` where it rests (closed), `down` where the word sends it. */
export function liftHeights(room, sector) {
  const d = ceilingDoors(room)?.doors?.find(x => Number(x.id) === Number(sector) && x.kind === 'floor');
  return d ? { up: d.closed, down: d.open } : null;
}

/** How long after it starts moving a platform at `from` is within `step` of `to`, at `speed` kod units/s. */
export function liftBoardDelayMs({ from, to, speed, step = 24 }) {
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.ceil((Math.abs(from - to) - step) * 1000 / speed));
}

/** Where an animating platform is at `now`: from `from` toward `to` at `speed` since `at` (ms). */
export function liftFloorAt({ from, to, speed, at }, now) {
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(at) || !Number.isFinite(from)) return to;
  const moved = speed * Math.max(0, now - at) / 1000;
  return from > to ? Math.max(to, from - moved) : Math.min(to, from + moved);
}

export const LIFT_SAYINGS = 4;   // two to ride (down-and-board, then down-and-alight), and one retry of each
const LIFT_EVENT_MS = 3000;      // the lowering packet follows the saying at once; silence means ignored
const LIFT_TIMER_MS = 12_000;    // LIFT_DELAY 10 s from the saying, and slack

async function rideLift(k, { room, door, inward, trigger, across, target, isInterrupted, guard,
                             sleepFn = sleep, now = Date.now }) {
  const s = k.s, c = s.need();
  const h = liftHeights(room, door.sector);
  if (!h) return { crossed: false, why: `sector ${door.sector} is not a floor lift in substrate/m59-ceiling-doors.json` };
  const [near, far] = inward ? door.deck : [...door.deck].reverse();
  const at = ([r, col]) => c.self.row === r && c.self.col === col;
  const here = () => [c.self.row, c.self.col];
  const where = () => `r${c.self.row}c${c.self.col}`;
  const latest = () => c.room?.sectorHeights?.get(door.sector) ?? null;
  const isAt = (height, since) => { const o = latest(); return !!o && o.height === height && (o.at ?? 0) >= since; };
  const waitEvent = async (since, height, ms) => {
    const match = e => e.sector === door.sector && e.height === height && (e.type == null || e.type === 4);
    const until = now() + ms;
    while (now() < until) {
      guard();
      const reply = await c.waitFor({ since, kinds: ['sector-height'], match, timeoutMs: Math.min(250, until - now()) });
      const e = reply?.events?.find(match);
      if (e) return e;
    }
    return null;
  };
  const livePath = (to) => {
    const p = s.world?.geometry?.path?.(c.self.row, c.self.col, to[0], to[1]);
    return p?.found && p.steps?.length ? p.steps.map(x => ({ row: x.row, col: x.col })) : null;
  };
  const stepTo = async (to, open) => {
    const squares = bakedLeg(here(), to, open, room) ?? livePath(to) ?? [{ row: to[0], col: to[1] }];
    for (const sq of squares) {
      guard();
      if (c.self.row === sq.row && c.self.col === sq.col) continue;
      const r = await s.step(sq.col, sq.row, { confirm: true, beforeMutation: guard });
      if (!r?.moved) return { ok: false, reason: r?.reason ?? 'step refused' };
    }
    return { ok: at(to), reason: at(to) ? null : `stopped at ${where()}` };
  };
  const note = (phase, extra = {}) => k.note?.('guild lift passage', { sector: door.sector, inward, phase,
    at: { row: c.self.row, col: c.self.col }, ...extra });
  // Where the platforms are, as far as anything has said: settled at the last height reported.
  let motion = { from: latest()?.height ?? h.up, to: latest()?.height ?? h.up, speed: 16, at: 0 };
  let lastPress = null, sayings = 0;

  // CALL THE PLATFORMS DOWN, and wait until the one we mean to step on/off is within a step of the
  // bank. Returns false when the word was ignored or they turned round first.
  const callDown = async (phase) => {
    // DOWN ALREADY means a timer is running (ours from the last crossing, or somebody else's), and a
    // saying now would be ignored: wait for the rise that ends it, then call.
    if (latest()?.height === h.down) {
      const rise = await waitEvent(c.evSeq, h.up, LIFT_TIMER_MS);
      if (rise) motion = { from: h.down, to: h.up, speed: rise.speed ?? motion.speed, at: now() };
    }
    await standUp(s, isInterrupted);
    guard();
    const since = c.evSeq, pose = doorPressPose(s, c), saidAt = now();
    const from = liftFloorAt(motion, saidAt);
    if (!(await k.sayHallPassword()).ok) throw new Error('guild chest key unavailable');
    sayings++;
    const lowering = await waitEvent(since, h.down, LIFT_EVENT_MS);
    if (isInterrupted()) throw new Error('guild passage paused for survival');
    if (!lowering) {
      // IGNORED: the timer of a saying we never saw is still running (ptBridge), or the word was not
      // taken (the foyer, a wrong word). Wait out one timer for the rise that clears it.
      lastPress = noteDoorPressRefused(s, { source: 'guild_passage', keeper: k, since, pose,
        door: { sector: door.sector, kind: 'guild', direction: inward ? 'inward' : 'outward', secret: true },
        trigger, across, openingReason: 'password said, the lift did not move', attempt: sayings, attempts: LIFT_SAYINGS });
      note(`${phase}: the lift did not answer`, { sayings });
      if (!isAt(h.up, saidAt)) {
        const rise = await waitEvent(since, h.up, LIFT_TIMER_MS);
        if (rise) motion = { from: h.down, to: h.up, speed: rise.speed, at: now() };
      }
      return false;
    }
    motion = { from, to: h.down, speed: lowering.speed, at: now() };
    const ready = motion.at + liftBoardDelayMs({ from, to: h.down, speed: lowering.speed });
    while (now() < ready) {
      guard();
      if (isAt(h.up, motion.at)) return false;           // turned round before it got down
      await sleepFn(100);
    }
    return { since, saidAt };
  };

  while (sayings < LIFT_SAYINGS) {
    guard();
    // ON THE NEAR BANK: call it, board it.
    if (!(guildSection(...here(), room) < 0)) {
      if (!at(trigger)) {
        await s.walkTo(trigger[1], trigger[0], { maxSteps: 10, hardCap: 12, beforeMutation: guard });
        await s.confirmPosition?.();
      }
      const called = await callDown('board');
      if (!called) continue;
      const board = await stepTo(near, [door.sector]);
      note('board', { reason: board.reason, sayings });
      if (!board.ok) {
        // Missed it. Let it go back up and call again from the bank.
        if (!isAt(h.up, called.saidAt)) await waitEvent(called.since, h.up, LIFT_TIMER_MS);
        motion = { from: h.down, to: h.up, speed: motion.speed, at: now() };
        continue;
      }
      // RIDE IT UP: the rise is the timer; then until the platform is within a step of the span.
      const rise = isAt(h.up, called.saidAt) ? { speed: motion.speed } : await waitEvent(called.since, h.up, LIFT_TIMER_MS);
      if (!rise) return { crossed: false, why: `on the platform at ${where()} and it never rose`, lastPress, sayings };
      motion = { from: h.down, to: h.up, speed: rise.speed ?? motion.speed, at: now() };
      const top = motion.at + liftBoardDelayMs({ from: h.down, to: h.up, speed: motion.speed });
      while (now() < top) { guard(); await sleepFn(100); }
      note('rode up', { sayings });
    }
    // ON THE BRIDGE (a platform or the span): walk the span to the far platform. With the platforms up
    // the deck is an island, so the live plan cannot wade off it either.
    if (!at(far)) {
      const span = await stepTo(far, []);
      note('span', { reason: span.reason });
      if (!span.ok) return { crossed: false, why: `could not walk the bridge to r${far[0]}c${far[1]} ` +
        `(${span.reason})`, lastPress, sayings };
    }
    // AND DOWN: the second saying, and off.
    const called = await callDown('alight');
    if (!called) continue;
    const off = await stepTo(across, [door.sector]);
    note('alight', { reason: off.reason, sayings });
    if (guildSection(...here(), room) === target) return { crossed: true, sayings, lastPress };
    if (!off.ok && !isAt(h.up, called.saidAt)) await waitEvent(called.since, h.up, LIFT_TIMER_MS);
    motion = { from: h.down, to: h.up, speed: motion.speed, at: now() };
  }
  return { crossed: false, why: `the lift was called ${sayings} times and the body is at ${where()}, ` +
    `not across at r${across[0]}c${across[1]}`, lastPress, sayings };
}

/**
 * Walk the hall the body is standing in to `destination`, a SECTION NUMBER of that hall (0 is
 * the foyer; `chestSectionOf(room)` is the chests). The hall is read off `k.s.world.room.num`.
 */
export async function guildPassage(k, destination, isInterrupted) {
  const s = k.s, c = s.need();
  const room = hallRoomOf(s), hall = hallSurvey(room);
  if (!Number.isInteger(destination) || destination < 0 || destination >= hall.anchors.length)
    throw new Error(`hall ${room} has no section ${destination} (it has 0-${hall.anchors.length - 1})`);
  const guard = () => { if (isInterrupted()) throw new Error('guild passage paused for survival'); };
  for (let leg = 0; leg < 8; leg++) {
    if (isInterrupted()) throw new Error('guild passage paused for survival');
    // A MOATED HALL HAS SQUARES NO SECTION OWNS -- the water and the bridge deck. A body found on one
    // walks from the side it is nearest; that reading only picks a direction, never declares arrival.
    const strictSection = guildSection(c.self.row, c.self.col, room);
    if (strictSection === destination) return;
    // ON THE BRIDGE ITSELF (out of the water, in no section): it is a lift, so ride it off towards the
    // destination rather than try to walk to a bank trigger 154 below.
    const liftAt = hall.moat && strictSection < 0 && !moatSquares(room).has(`${c.self.row},${c.self.col}`)
      ? hall.doors.findIndex(d => d.lift) : -1;
    const section = liftAt >= 0 ? (destination > liftAt ? liftAt : liftAt + 1)
      : strictSection < 0 && hall.moat ? nearestSection(c.self.row, c.self.col, room) : strictSection;
    // THE BOOTH IS OFF THE LINE: out through counter door 58 into section 3 first. A character left
    // in the booth (the vault broker's post) was stranded by every ordinary hall path —
    // hall_withdraw refused "outside the known passage" and a walk out never left the room
    // (2026-09-27, Statler, after the broker probe). 714 alone has a booth.
    if (section < 0 && hall.booth && inBoothPocket(c.self.row, c.self.col)) {
      await crossCounter(k, true, isInterrupted);
      continue;
    }
    if (section < 0) throw new Error('guild position is outside the known passage');
    // On a square no section owns, nearest to the destination's own side: just walk to its anchor.
    if (section === destination) {
      const [ar, ac] = hall.anchors[destination];
      await s.walkTo(ac, ar, { maxSteps: 30, hardCap: 40, beforeMutation: guard });
      await s.confirmPosition?.();
      if (guildSection(c.self.row, c.self.col, room) === destination) return;
      throw new Error(`guild position r${c.self.row}c${c.self.col} is on no section of hall ${room}, ` +
                      `and the walk to section ${destination}'s anchor did not land on one`);
    }
    const inward = section < destination, door = hall.doors[inward ? section : section - 1];
    const [trigger, across] = inward ? door.inward : door.outward;
    // UP TO THREE APPROACHES. Prod 2026-10-27: Kermit (door 59, stopped at r2c33 after 3 steps) and Lew (door 55, r20c18)
    // stopped short with no reason and no canceller, while the same draw worked for Animal half an hour earlier -- the
    // shape of a body briefly in a one-square hall passage during a trek's staging. A short pause and another walk costs
    // seconds; the refusal costs the whole stash.
    let approach = null, restWaits = 0;
    for (let tryNo = 0; tryNo < 3 && !(door.lift && liftAt >= 0); tryNo++) {
      if (tryNo) { await sleep(1500); guard(); }
      await standUp(s, isInterrupted);
      approach = await s.walkTo(trigger[1], trigger[0], { maxSteps: 50, hardCap: 60, beforeMutation: guard });
      await s.confirmPosition?.();
      if (c.self.row === trigger[0] && c.self.col === trigger[1]) break;
      // OUR OWN KEEPER SAT US DOWN. Prod 2026-10-27, Waldorf: "cancelled by keeper:play_dead (rest at the safe wall instead
      // of logging off)" -- he arrived at the hall under his rest line, and the survival ladder rested him mid-passage.
      // That is right, and a reason to WAIT, not to spend the retries in four seconds: let the rest finish (health back
      // over the rest line, or two and a half minutes), then walk again, without counting it as a failed approach.
      if (/^keeper:/.test(String(approach?.cancelled_by_label ?? '')) && restWaits < 2) {
        restWaits++; tryNo--;
        k.note?.('guild passage waiting for the keeper\'s rest', { by: approach.cancelled_by_label, why: approach.cancelled_by ?? null });
        const restLine = Number(k.policy?.restBelow ?? 0.7);
        const until = Date.now() + 150_000;
        while (Date.now() < until) {
          if (isInterrupted()) throw new Error('guild passage paused for survival');
          const h = c.vitals?.()?.health;
          if (h?.max > 0 && h.value / h.max >= Math.min(0.95, restLine + 0.05) && k.doing !== 'recovering') break;
          await sleep(3000);
        }
      }
    }
    if ((c.self.row !== trigger[0] || c.self.col !== trigger[1]) && !(door.lift && liftAt >= 0)) {
      // WHO STANDS NEAR THE TRIGGER, by name: the likeliest reason a walk in this hall stops short.
      const near = [...(c.room?.objects?.values?.() ?? [])].filter(o => o.id !== c.selfId && Number.isFinite(o.row)
        && Math.max(Math.abs(o.row - trigger[0]), Math.abs(o.col - trigger[1])) <= 2).map(o => c.rsc?.get?.(o.nameRsc) || o.name || '?');
      if (approach) approach.near_trigger = near;
      k.note?.('guild door trigger not reached', { sector: door.sector, reason: approach?.reason,
        at: { row: c.self.row, col: c.self.col }, target: { row: trigger[0], col: trigger[1] } });
      // THE REASON TRAVELS WITH THE REFUSAL. The note above goes to a keeper buffer nobody can read
      // after the fact; on 2026-10-05 three hall draws failed "door 55 trigger not reached" with no way
      // to tell a refused route from a body in the way from a stale position. The caller's `why` now
      // carries where the walk stopped and what it said.
      throw new Error(`guild door ${door.sector} trigger not reached ` +
        `(stopped at r${c.self.row}c${c.self.col}, wanted r${trigger[0]}c${trigger[1]}` +
        `${approach?.reason ? `: ${approach.reason}` : ''}${approach?.steps != null ? `, ${approach.steps} step(s)` : ''}` +
        // AND WHO CANCELLED IT. On the 2026-10-05 rerun it was the keeper's own recovery rung ("rest at the
        // safe wall") resting a body that had arrived hurt -- correct, and a reason to wait, not to retry.
        `${approach?.cancelled_by_label && approach.cancelled_by_label !== 'unattributed'
          ? `; cancelled by ${approach.cancelled_by_label}${approach.cancelled_by ? ` (${approach.cancelled_by})` : ''}`
          : approach?.cancelled_by ? `; cancelled by ${approach.cancelled_by}` : ''}` +
        `${approach?.near_trigger?.length ? `; near the trigger: ${approach.near_trigger.join(', ')}` : ''}, after 3 approaches)`);
    }
    // `lastPress` is the scene of the last press that did not open (m59-door-refusal.mjs): the
    // pose AT the press, the trigger it was meant for, posture, movement in flight and the bodies
    // round the trigger. It is written to the ledger as `door_press_refused` and its one-line
    // summary rides the error, because "refused 3 of 3" alone was all prod had on 2026-11-01.
    if (door.lift) {
      // AN ELEVATOR (703's bridge): spoken, waited for, boarded, ridden, and spoken to again if it
      // rose under us. The refusal keeps the "could not be crossed" wording m59-hall-access retries.
      const ride = await rideLift(k, { room, door, inward, trigger, across,
        target: section + (inward ? 1 : -1), isInterrupted, guard,
        // A ride is ~30 s of waiting on a server timer; `k.clock` lets an offline test run it on its own.
        sleepFn: k.clock?.sleep ?? sleep, now: k.clock?.now ?? Date.now });
      if (!ride.crossed) throw new Error(`guild door ${door.sector} could not be crossed: ${ride.why}` +
        pressSuffix(ride.lastPress));
      continue;
    }
    let crossed = false, refused = 0, lastPress = null;
    for (let attempt = 0; attempt < 3 && !crossed; attempt++) {
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      await standUp(s, isInterrupted);
      guard();
      const since = c.evSeq;
      let pressedAt=null, pose=null;
      if (door.teleport) {
        // A SPOKEN WALL (713's door 5): the word is said ON the trigger and the server moves the
        // body to `across`. There is no sector to wait on and no step to take.
        if (attempt && (c.self.row !== trigger[0] || c.self.col !== trigger[1])) {
          await s.walkTo(trigger[1], trigger[0], { maxSteps: 10, hardCap: 12, beforeMutation: guard });
          await s.confirmPosition?.();
        }
        pose=doorPressPose(s, c);pressedAt=Date.now();
        if (!(await k.sayHallPassword()).ok) throw new Error('guild chest key unavailable');
        crossed = await awaitTeleport(s, c, room, section + (inward ? 1 : -1),
          { within_ms: door.within_ms ?? 4000, isInterrupted });
        if (isInterrupted()) throw new Error('guild passage paused for survival');
        k.note?.('guild door passage', { sector: door.sector, inward, crossed, via: 'password teleport',
          at: { row: c.self.row, col: c.self.col } });
        if (!crossed) {
          lastPress = noteDoorPressRefused(s, { source: 'guild_passage', keeper: k, since, pose,
            door: { sector: door.sector, kind: 'guild', direction: inward ? 'inward' : 'outward', secret: true },
            trigger, across, openingReason: 'password said, body not moved', attempt: attempt + 1, attempts: 3 });
          if (attempt < 2) await sleep(1500);
        }
        continue;
      }
      if (door.secret) {
        pose=doorPressPose(s, c);pressedAt=Date.now();
        if (!(await k.sayHallPassword()).ok) throw new Error('guild chest key unavailable');
      } else await s.pacer.submit('move', () => { guard();pose=doorPressPose(s, c);pressedAt=Date.now();return c.go(); });
      const plans = doorsFor(room, { row: c.self.row, col: c.self.col });
      // The password-operated door is not in SomethingTryGo's table, and neither is a door pressed
      // through the base class's plGuild_doors (713's foyer side, ghall.kod:981).
      const definition = [...plans.on, ...plans.others].find(p => p.sector === door.sector)
        ?? ceilingDoors(room).doors.find(d => d.id === door.sector);
      const plan = definition?.to_height != null ? definition : {
        sector: door.sector, from_height: definition?.closed, to_height: definition?.open,
        within_ms: door.within_ms ?? 8000,
      };
      const opening = await waitForDoorOpen(c, plan, { since, cancelled: isInterrupted,pressedAt });
      if (isInterrupted()) throw new Error('guild passage paused for survival');
      if (!opening.opened) {
        const cantGo = refusedToGo(c, since);
        if (cantGo) refused++;
        lastPress = noteDoorPressRefused(s, { source: 'guild_passage', keeper: k, since, pose,
          door: { sector: door.sector, kind: 'guild', direction: inward ? 'inward' : 'outward', secret: !!door.secret },
          trigger, across, openingReason: opening.reason, attempt: attempt + 1, attempts: 3, refused });
        k.note?.('guild door opening not verified', { sector: door.sector,
          reason: cantGo ? 'the server refused the press: "You are unable to go anywhere." ' +
                           '(seated, held or webbed, or not on the trigger), not a slow door' : opening.reason,
          ...(lastPress?.summary ? { scene: lastPress.summary } : {}) });
        if (attempt < 2) {
          const retryAt = doorRetryAt(plan,pressedAt);
          while (Date.now() < retryAt && !isInterrupted()) await sleep(100);
        }
        continue;
      }
      // Do not coalesce across the entrance: its first and second hotplates
      // occupy consecutive squares and must be crossed in order. Confirm each
      // short step, then plan from the body's actual position.
      let result, usedRail = false;
      if (s.step && s.world?.geometry) {
        for (let step = 0; step < 6; step++) {
          guard();
          if (c.self.row === across[0] && c.self.col === across[1]) break;
          const path = s.world.geometry.path(c.self.row, c.self.col, across[0], across[1]);
          let next = path.steps?.[0];
          if (!path.found || !next) {
            // The live geometry has nothing. That is USUALLY the ceiling not having arrived yet
            // rather than a wall, so ask the baked line for this door before giving up on it.
            const rail = bakedCrossing([c.self.row, c.self.col], across, door.sector, room) ??
                         bakedCrossing(trigger, across, door.sector, room);
            next = rail?.[0] ?? null;
            usedRail = !!next;
            if (!next) { result = { reason: 'no live path across the open door, and nothing baked' }; break; }
          }
          result = await s.step(next.col, next.row, { confirm: true, beforeMutation: guard });
          if (!result.moved) break;
        }
      } else result = await s.walkTo(across[1], across[0], { maxSteps: 5, hardCap: 6, beforeMutation: guard });
      crossed = guildSection(c.self.row, c.self.col, room) === section + (inward ? 1 : -1);
      k.note?.('guild door passage', { sector: door.sector, inward, crossed,
        at: { row: c.self.row, col: c.self.col }, reason: result?.reason,
        // A FALLBACK NOBODY CAN COUNT IS A FALLBACK NOBODY WILL MAINTAIN. If the rail is carrying
        // this hall, that has to be visible in the log rather than inferred from the absence of
        // the old refusal.
        ...(usedRail ? { via: 'baked rail' } : {}) });
      if (!crossed && attempt < 2) {
        // GO while a door is already open does not restart its five-second
        // timer. Let that cycle finish, then request a fresh opening.
        const retryAt = doorRetryAt(plan,pressedAt);
        while (Date.now() < retryAt && !isInterrupted()) await sleep(100);
      }
    }
    if (!crossed) throw new Error(`guild door ${door.sector} could not be crossed` +
      (refused ? `: the server refused ${refused} of 3 presses as "unable to go anywhere"` : '') +
      pressSuffix(lastPress));
  }
  throw new Error('guild passage exceeded its door limit');
}

// ------------------------------------------------------------------ the booth, and door 58
//
// THE VAULT BROKER'S POST (operator, 2026-09-27): the chest manager stands in the BOOTH, rows 2-3
// col 25 (guildh14.kod InZone :604-607), the one square whose speech crosses to and from the
// foyer (:227-229), and serves the foyer across it without the main door opening. The booth is
// NOT on the line of sections above: with every door shut it reaches the counter strip and nothing
// else. The counter strip opens WEST through COUNTER_DOOR, sector 58 (press on rows 2-3, cols
// 19-21, :340-351, no gate, 5 s), into the room east of the secret door (section 3). So the
// manager's whole beat is booth <-58-> section 3 <-password-> chests: two doors, never the
// main door. Which trigger square each side reaches was measured on the closed-door bake:
// the section-3 side reaches (2,19), the booth side (2,21); (2,20) is ambiguous and never used.
export const BOOTH = [2, 25];
export const COUNTER = Object.freeze({ sector: 58, west: [2, 19], east: [2, 21],
  westLanding: [2, 19], eastLanding: [2, 22] });

/** Is this square on the booth side of door 58 (the booth pocket)? 714's closed-door geometry. */
export function inBoothPocket(row, col) {
  const closed = closedGeometry(714);
  return closed.path(row, col, BOOTH[0], BOOTH[1]).found && closed.path(BOOTH[0], BOOTH[1], row, col).found;
}

async function crossCounter(k, westward, isInterrupted) {
  const s = k.s, c = s.need();
  const guard = () => { if (isInterrupted()) throw new Error('guild passage paused for survival'); };
  const trigger = westward ? COUNTER.east : COUNTER.west;
  const landing = westward ? COUNTER.westLanding : COUNTER.eastLanding;
  await standUp(s, isInterrupted);
  await s.walkTo(trigger[1], trigger[0], { maxSteps: 40, hardCap: 50, beforeMutation: guard });
  await s.confirmPosition?.();
  if (c.self.row !== trigger[0] || c.self.col !== trigger[1])
    throw new Error(`counter door trigger (${trigger.join(',')}) not reached`);
  const plan = { sector: COUNTER.sector, from_height: 100, to_height: 190, within_ms: 5000 };
  let lastPress = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    guard();
    await standUp(s, isInterrupted);
    guard();
    const since = c.evSeq;
    let pressedAt=null, pose=null;
    await s.pacer.submit('move', () => { guard();pose=doorPressPose(s, c);pressedAt=Date.now();return c.go(); });
    const opening = await waitForDoorOpen(c, plan, { since, cancelled: isInterrupted,pressedAt });
    if (opening.opened) {
      for (let step = 0; step < 6; step++) {
        guard();
        if (c.self.row === landing[0] && c.self.col === landing[1]) break;
        const path = s.world?.geometry?.path(c.self.row, c.self.col, landing[0], landing[1]);
        const next = path?.found ? path.steps?.[0] : { row: landing[0], col: landing[1] };
        const r = await s.step(next.col, next.row, { confirm: true, beforeMutation: guard });
        if (!r?.moved) break;
      }
      const ok = westward ? !inBoothPocket(c.self.row, c.self.col) : inBoothPocket(c.self.row, c.self.col);
      k.note?.('counter door passage', { westward, crossed: ok, at: { row: c.self.row, col: c.self.col } });
      if (ok) return;
    } else {
      lastPress = noteDoorPressRefused(s, { source: 'counter_door', keeper: k, since, pose,
        door: { sector: COUNTER.sector, kind: 'counter', direction: westward ? 'west' : 'east' },
        trigger, across: landing, openingReason: opening.reason, attempt: attempt + 1, attempts: 3 });
      k.note?.('counter door opening not verified', { reason: refusedToGo(c, since)
        ? 'the server refused the press: "You are unable to go anywhere."' : opening.reason,
        ...(lastPress?.summary ? { scene: lastPress.summary } : {}) });
    }
    const retryAt = doorRetryAt(plan,pressedAt);
    while (Date.now() < retryAt && !isInterrupted()) await sleep(100);
  }
  throw new Error('counter door 58 could not be crossed' + pressSuffix(lastPress));
}

/**
 * Walk to a broker post inside the hall: 'booth' (the window, 714 only), 'chests' (the hall's chest
 * section: 714's 4, 713's 2), or 'inside' (the section before it: 714's 3, 713's 1). Never the main door: from the foyer or the main hall this
 * refuses rather than walk in through door 59, because opening it is what the broker exists to stop.
 */
export async function hallPost(k, where, isInterrupted = () => false) {
  const c = k.s.need();
  const here = () => [c.self.row, c.self.col];
  // A SHORT WALK SAYS SO. This answered {ok:false, at} with no reason, which the vault desk logged as
  // "undefined" three times before closing (prod 2026-09-28 02:44, stopped at (3,21)).
  const atBooth = () => (c.self.row === BOOTH[0] && c.self.col === BOOTH[1]
    ? { ok: true, at: here() }
    : { ok: false, at: here(), pocket: inBoothPocket(...here()),
        why: `stopped at (${here().join(',')}), short of the booth (${BOOTH.join(',')})` });
  // WHICH HALL'S POSTS. Only 714 has a booth; 'chests' and 'inside' are that hall's own sections.
  let room;
  try { room = hallRoomOf(k.s); } catch (e) { return { ok: false, why: e.message, at: here() }; }
  const hall = hallSurvey(room);
  if (where === 'booth') {
    if (!hall.booth) return { ok: false, why: `hall ${room} has no booth`, at: here() };
    if (inBoothPocket(...here())) {
      await k.s.walkTo(BOOTH[1], BOOTH[0], { maxSteps: 20, hardCap: 30 });
      return atBooth();
    }
    const sec = guildSection(...here(), room);
    if (sec < 1) return { ok: false, why: `refusing to reach the booth from section ${sec} (it would open the main door)`, at: here() };
    await guildPassage(k, hall.insideSection, isInterrupted);
    await crossCounter(k, false, isInterrupted);
    await k.s.walkTo(BOOTH[1], BOOTH[0], { maxSteps: 20, hardCap: 30 });
    return atBooth();
  }
  if (where === 'chests' || where === 'inside') {
    if (hall.booth && inBoothPocket(...here())) await crossCounter(k, true, isInterrupted);
    const sec = guildSection(...here(), room);
    if (sec < 1) return { ok: false, why: `refusing to walk in from section ${sec} (it would open the main door)`, at: here() };
    const target = where === 'chests' ? hall.chestSection : hall.insideSection;
    await guildPassage(k, target, isInterrupted);
    return { ok: guildSection(...here(), room) === target, at: here() };
  }
  return { ok: false, why: `unknown post ${where}: booth, chests or inside` };
}
