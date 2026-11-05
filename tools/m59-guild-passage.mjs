// Walk a surveyed guild hall's doors (714, 713) from their reachable trigger sides.
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
const BOOKMAKERS = {
  room: 714, name: "The Bookmaker's Guild House",
  anchors, doors,
  chestSection: 4, insideSection: 3, booth: true,
};
export const HALLS = Object.freeze({ 714: BOOKMAKERS, 713: SLAUGHTERED_COMMAND });
export const SURVEYED_HALLS = Object.freeze([714, 713]);

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

/** Which section of hall `room` the square [row, col] is in, by the all-doors-shut geometry; -1 if none. */
export function guildSection(row, col, room = LEGACY_HALL) {
  const hall = hallSurvey(room);
  if (!hall) return -1;
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
// writes substrate/rail-<room>.json (714, 713). This reads it.
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
    const section = guildSection(c.self.row, c.self.col, room);
    if (section === destination) return;
    // THE BOOTH IS OFF THE LINE: out through counter door 58 into section 3 first. A character left
    // in the booth (the vault broker's post) was stranded by every ordinary hall path —
    // hall_withdraw refused "outside the known passage" and a walk out never left the room
    // (2026-09-27, Statler, after the broker probe). 714 alone has a booth.
    if (section < 0 && hall.booth && inBoothPocket(c.self.row, c.self.col)) {
      await crossCounter(k, true, isInterrupted);
      continue;
    }
    if (section < 0) throw new Error('guild position is outside the known passage');
    const inward = section < destination, door = hall.doors[inward ? section : section - 1];
    const [trigger, across] = inward ? door.inward : door.outward;
    // UP TO THREE APPROACHES. Prod 2026-10-27: Kermit (door 59, stopped at r2c33 after 3 steps) and Lew (door 55, r20c18)
    // stopped short with no reason and no canceller, while the same draw worked for Animal half an hour earlier -- the
    // shape of a body briefly in a one-square hall passage during a trek's staging. A short pause and another walk costs
    // seconds; the refusal costs the whole stash.
    let approach = null, restWaits = 0;
    for (let tryNo = 0; tryNo < 3; tryNo++) {
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
    if (c.self.row !== trigger[0] || c.self.col !== trigger[1]) {
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
