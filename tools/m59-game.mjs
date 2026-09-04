// m59-game.mjs — Session class and its dependencies, extracted from m59-broker.mjs.
//
// Phase 3: Per-character keeper processes. The Session class (3400 lines) and its
// immediate dependencies (Recorder, constants, helper functions) are extracted here
// so that keeper processes can import Session without loading the full HTTP gateway.
//
// Import surface:
//   import { Session, Pacer } from './m59-session.mjs';
//   import { Session } from './m59-game.mjs';  // direct
//
// The broker imports Session from here:
//   import { Session, Recorder } from './m59-game.mjs';

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { M59Client, KOD_FINENESS, BPNAME, BP } from './m59-client.mjs';
import { loadResources } from './m59-rsc.mjs';
import { describeObject, affordances, OF, blocksMovement, prepareActTarget } from './m59-parse.mjs';
import { World, spreadEdges, boundedSilentGo, boundedRegionEntry,
         doorSettleMs, remainingDoorSettle } from './m59-world.mjs';
import { loadMap, movementMapReadiness, resolveRoom, forgetInferredExit, findPath, buildReverseEdges }
         from './m59-map.mjs';
import { CLIENT_FINENESS, elideLoops, protocolToClient, loadRoo, buildAllRoomGeometry, sharedRoomGeometry,
         MAX_STEP_HEIGHT, MIN_NOMOVEON, PLAYER_HEIGHT,
         lanePastBodies, perpWalkPastBodies, keepRightAim } from './m59-roo.mjs';
import { isTerminalMovementReason } from './m59-movement.mjs';
// THE GATE THAT WAS NEVER WIRED IN. `traversable()` is the only thing that honours a
// declaration's `requires: {running: true}`, and until now this module was imported by
// nobody at all -- so every declared jump was attempted whatever the character's vigor,
// and a character that could not run fell into the gulley instead of clearing it. See the
// jump_rest block in rideTrack.
import { fallJumpsIn, traversable as fallJumpTraversable, physics as fallPhysics } from './m59-falljump.mjs';
import { loadMerchants } from './m59-merchants.mjs';
import { loadSpells, karmaAllows, requiredKarma, SCHOOLS } from './m59-spells.mjs';
import * as abilities from './m59-abilities.mjs';
import * as hitbook from './m59-hits.mjs';
import * as transits from './m59-transits.mjs';
import * as bankbook from './m59-bank.mjs';
import * as descriptions from './m59-describe.mjs';
import { RemainingRequiredToLearnNewSkills, PointsToNextLevelOfTarget } from '../compendium/tools/learn.mjs';
import { StorageCache } from './m59-storage.mjs';
import { Recorder } from './m59-recorder.mjs';

// ── IMPORTS THE PORTED SESSION NEEDS ────────────────────────────────────────────
//
// Upstream's Session grew these while it still lived in m59-broker.mjs, so they were in
// that file's module scope and needed no import. Moving the class here leaves them FREE
// IDENTIFIERS -- which do not fail at load, only when the branch that uses them runs.
// That is exactly how `joinSessionOnce` sat broken in Session.join() until the first
// outside caller found it. Named explicitly so the next move of this class fails loudly.
import { spawn } from 'node:child_process';
import { clientToProtocol } from './m59-roo.mjs';
import { finePath, pullFine, pointOfSquare, boundsAround } from './m59-finepath.mjs';
import { traceMove, traceUnsafeWireMove, traceWireMove } from './m59-collision-trace.mjs';
import { isMutableGeometry } from './m59-mutable.mjs';
import { recordTactic } from './m59-tactics.mjs';
import { recallTrack, strikeTrack, clearStrikes } from './m59-tracks.mjs';
import { nearestSafeSpot, sheltersAlong, shelterAhead } from './m59-safespots.mjs';
import { activeRoutes, anchorFor, bakedPath } from './m59-routes.mjs';
import { isLoyaltyWarning, isLoyaltyLost } from './m59-factions.mjs';
import { rtsJobReport } from './m59-rts-safety.mjs';
import * as exitgap from './m59-exitgap.mjs';
// Safe as a plain import: m59-autopilot.mjs imports neither m59-session nor m59-game, so
// there is no cycle here. Checked rather than assumed -- a cycle would leave this in the
// temporal dead zone and throw only on the branch that calls it.
import { autopilotIfAny } from './m59-autopilot.mjs';
// Session.join() calls joinSessionOnce and the Phase 3 extraction left it behind: the
// BROKER imports it, and ESM modules do not share scope, so the reference here was free
// and `join()` threw ReferenceError wherever it was called. Nothing called it -- the
// keeper process uses joinOnce directly -- so a broken method sat in the class until the
// first outside caller found it.
import { joinSessionOnce } from './m59-session-readiness.mjs';

// noteGeometryDrift is defined in m59-broker.mjs and used here for
// drift logging. In the keeper process (no broker), it's undefined.
// Provide a no-op fallback so movement validation doesn't crash.
if (typeof noteGeometryDrift !== 'function') {
  globalThis.noteGeometryDrift = (session, drift) => {
    // Log drift to stderr for debugging
    if (process.env.M59_DEBUG_DRIFT) {
      console.error(`[drift] ${session.name ?? '?'} ${JSON.stringify(drift)}`);
    }
  };
}
import { loadSpawns } from './m59-spawns.mjs';
import * as skills from './m59-skills.mjs';

const SPAWN_FILE = process.env.M59_SPAWN_FILE ||
  fileURLToPath(new URL('../substrate/m59-spawns.json', import.meta.url));
const CURSED_ITEMS = /amulet of shadows|ring of lethargy/i;
// Facing coalescing tolerance (degrees) for the turn-before-move in walkTo. A player only
// turns when the heading changes; we suppress the per-step re-face that pushed us over the
// server's 5-packet/s throttle. See docs/packet-throttle.md.
const FACE_EPS = 8;
// How long (ms) after the combat controller faces a target the walkTo turn-before-move must
// NOT re-face to the movement heading. Without this, closing the gap to a target oscillated
// the facing between the target and the walk direction, so every melee swing whiffed on the
// server's view-cone check (player.kod ~4185: a target behind the facing line is rejected).
const COMBAT_FACE_HOLD_MS = 1500;

// ---------------------------------------------------------------- constants
// Server hard limit: INCOMING_PACKET_THROTTLE = 5 (user.kod:50). Above this the server
// sets bSpam and SILENTLY DROPS the packet (no error, no response). We were at 12, which
// meant ~2.4x our packets were being dropped as spam -- the cause of the slow movement,
// the ~0.2/s swing rate, and the zero combat responses.
//
// 8 is a deliberate middle value, NOT the fix. The real fix is to stop PRODUCING more
// than ~5 packets/s (see docs/packet-throttle.md): the tick loop at 10Hz was submitting
// a move/face every 100ms regardless of whether it changed anything, so the queue grew
// faster than any drain rate could keep up. Capping the drain at 5 made it worse (attacks
// queued behind a flood of redundant moves). 8 keeps the backlog from growing unbounded
// while the production throttle is implemented; it is a stopgap, not a solution.
// Server throttle: INCOMING_PACKET_THROTTLE = 5 (user.kod:50). The server drops
// packets silently when it receives more than 5/s. We pace at exactly 5/s so we
// never trip the throttle. The old 8/s was 60% over the limit — the server was
// dropping our swings and moves.
const PACKETS_PER_SECOND = Number(process.env.M59_RATE || 5);
const ATTACK_INTERVAL_MS = 1050;     // IsOkayAttackTime, plus a little

// WALKING AT ONE SQUARE A SECOND WAS COSTING US CHARACTERS.
//
// This was 1050ms — one move packet per second — and it was never a server rule. It
// was caution, and the caution was aimed at the wrong thing. What the kod actually
// does with movement (docs/m59-coordination-research.md, user.kod:2941-2971):
//
//   * every BP_REQ_MOVE bumps an anti-speedhack counter that decays one per second,
//     and exceeding MOVEMENT_COUNT_THRESHOLD **only writes a log line**. It does not
//     block the move, reject the packet, or snap you back.
//   * there is NO geometry or distance validation on a user move at all. UserMove
//     calls Room.SomethingMoved directly and ReqSomethingMoved is bypassed for users
//     — room.kod's own comment is "already been checked by client (HAHA!)".
//   * the ONE thing that does snap you back is speed above USER_WALKING_SPEED with
//     vigor under the run threshold, which moveSpeed() already guards.
//
// So the rate was self-imposed, and it was expensive: crossing a monster field at a
// square a second means standing next to every creature on the way for a full second
// each, taking a swing from each one, which is where nearly all of our travel deaths
// come from. A real player crosses the same ground several times faster and is hit a
// fraction as often.
//
// 250ms is four squares a second — still a walk rather than a teleport, still one
// square per packet with the server tracking every step, but fast enough that walking
// past something is walking past it rather than standing beside it.
const MOVE_INTERVAL_MS = Number(process.env.M59_MOVE_INTERVAL_MS || 250);

// HOW LONG A BOUNDARY CROSSING MAY TAKE TO COME BACK. Not the same question as a door,
// and not the same answer: the operator's account of doing this by hand is that under
// load you stop dead against the edge and are moved a beat later, so a slow crossing is
// the ordinary case rather than a failed one. At the old 4s this gave up on crossings
// that were still in flight and reported them as "stepping past the edge did nothing" —
// the reading that makes a working exit look like a phantom, and the one that would have
// had us delete a real edge from the map.
const EDGE_CROSSING_WAIT_MS = Number(process.env.M59_EDGE_CROSSING_WAIT_MS || 10000);

// The server may silently discard UserGo when it follows the final movement packet
// too closely. Preserve normal 250ms walking, but leave half a second between the
// most recent movement packet and every door request. Pacer waits only the remaining
// portion of this interval, so slow position confirmation does not add another 500ms.
const DOOR_SETTLE_MS = doorSettleMs(process.env.M59_DOOR_SETTLE_MS);

// HOW OFTEN THE ROOM MAY BE RE-READ WHILE WALKING. A hard cap, not a target.
//
// `step()` used to re-read the whole room after every single square, and that round trip
// is 1.2-5.6s regardless of how much is in the room. It is why the fleet walked at 0.55
// squares a second against a person's 4.1 in the same room, and why MOVE_INTERVAL_MS —
// tuned to 250ms specifically to make walking faster — did nothing at all.
//
// Six seconds is chosen to be far longer than a step and far shorter than a crossing: at
// four squares a second it is one read every ~24 squares instead of one per square, and
// nothing in a room changes so fast that a six-second-old object map makes a walk wrong.
const ROOM_RESYNC_MS = Number(process.env.M59_ROOM_RESYNC_MS || 6000);

// user.kod:46. At or below this you are walking; above it you are running, which
// needs vigor >= 10 and costs exertion quadratically in the speed.
const WALK_SPEED = 18;
// USER_RUNNING_SPEED, user.kod:47 — what the real client sends when it runs. This was
// 24, a number from nowhere: above the walking threshold, so it paid the full cheat
// check, but not what any client emits.
const RUN_SPEED  = Number(process.env.M59_RUN_SPEED || 36);
// The server snaps you back and logs you if speed > 18 with vigor < VIGOR_RUN_THRESHOLD
// = 10 (user.kod:54, :2958). This was 25 — a margin of fifteen over a hard limit of ten,
// which is not caution, it is walking. At 0.18 vigor a second the whole reason for the
// margin is gone: a character at 12 that runs for ten seconds is still above the
// threshold, and a character that walks because it is at 24 is walking through the
// exact ground that kills this fleet. Two points of headroom against a race between
// our reading of vigor and the server's.
const RUN_VIGOR_FLOOR = 12;

// HOW MANY PATIENT LAPS A PLAYER IN THE WAY IS WORTH BEFORE THE WALKER ROUTES AROUND IT.
//
// Each lap is the jittered 500-1000ms wait in `walkTo`, so six is three to six seconds of
// queuing -- long enough for a character walking a corridor to clear the square ahead, short
// enough that a genuinely parked body still gets routed around inside one walk. A monster
// gets one lap, as before: monsters wander but engaged ones do not, and patience next to
// something that is hitting you is how a character stands on one square and is eaten.
const QUEUE_PATIENCE = 6;

/**
 * DOES THIS DECLARED JUMP NEED A RUN — asked of the table, not of the geometry.
 *
 * Returns true when the declaration says so, false when it does not, and false when there
 * is no declaration for this pair at all, because a pair the table does not describe is
 * not a declared jump and this gate has nothing to say about it.
 *
 * Split out so the one caller reads as a decision rather than as a lookup, and so the
 * import above has a named reason to exist that a future reader can follow.
 */
function declaredJumpNeedsRun(roomNum, from, to) {
  try {
    const jump = fallJumpsIn(roomNum).find(j =>
      Number(j?.from?.row) === Number(from.row) && Number(j?.from?.col) === Number(from.col) &&
      Number(j?.to?.row) === Number(to.row) && Number(j?.to?.col) === Number(to.col));
    if (!jump) return false;
    // `running: false` asks the question of the declaration rather than of the character:
    // "would a walker be refused this?" The caller supplies the character's actual vigor.
    return fallJumpTraversable(jump, { running: false }).ok === false;
  } catch { return false; }
}

// WHAT RUNNING COSTS, ARITHMETIC RATHER THAN NERVES — because the caution here was
// expensive and was never priced.
//
// user.kod:3020 charges exertion once per second as EXERTION_PER_MOVE * (speed*5/6)^2,
// with EXERTION_PER_MOVE = 2 (user.kod:26). necroam.kod:518 gives the scale: 20000
// units is commented "2 vigor points", so 10000 units is one vigor point.
//
//   walking, speed 18:  2 * 15^2 =  450/s = 0.045 vigor/s
//   running, speed 36:  2 * 30^2 = 1800/s = 0.18  vigor/s
//
// So a full minute of unbroken sprinting costs about ELEVEN vigor. Dying costs
// vastly more than that and takes the character out of play besides. The old rule
// spent vigor only in rooms the spawn index called dangerous, which is precisely
// backwards: the spawn index describes where we choose to fight, and nearly every
// travel death is on ground in between. There is no such thing as safe travel here;
// speed is the safety mechanism. So we run whenever we can afford to, everywhere.
const VIGOR_UNIT = 10000;                                     // necroam.kod:518
export const exertionPerSecond = speed => 2 * Math.floor(speed * 5 / 6) ** 2;

// HOW FAST THE REAL CLIENT ACTUALLY MOVES, which is the thing we were never matching.
//
// move.c:184 moves 2*MOVEUNITS per MOVE_DELAY when the action is a *FAST one and
// MOVEUNITS otherwise; MOVEUNITS is FINENESS>>2 = 256 client units and MOVE_DELAY is
// 100ms (move.c:49,53, draw3d.h:53). So:
//
//   running  512 units / 100ms = 5120/s = 5.0 squares/second
//   walking  256 units / 100ms = 2560/s = 2.5 squares/second
//
// and move.c:59 tells the server at most once per MOVE_INTERVAL = 1000ms. That is the
// shape the speedhack comment describes from the other side — "normal players only
// send 1 movement packet per second" — and it is one packet covering about five
// squares, not five packets covering one square each.
//
// We were doing the opposite: one square per packet, four packets a second, 4 sq/s at
// the very best and measured at 1.18. Sending FEWER packets that each cover more
// ground is both faster and further from the cheat detector, which is a rare
// direction for a change to go.
const SQUARES_PER_SECOND = { [WALK_SPEED]: 2.5, [RUN_SPEED]: 5.0 };
const squaresPerSecond = speed => SQUARES_PER_SECOND[speed] ?? (speed > WALK_SPEED ? 5.0 : 2.5);

// The cap on one hop, and it is a real server rule rather than taste. user.kod:3072
// logs a suspected teleport and DRAINS VIGOR as a penalty when the squared distance
// from the position at the last second-boundary reaches 200 with under 3 seconds
// elapsed — so about 14 squares. One second of running is 5 squares, squared distance
// 25, comfortably inside it. Eight is the ceiling this uses, which is still only 64.
const MOVE_HOP_MAX_SQUARES = Number(process.env.M59_MOVE_HOP_MAX || 8);

// HOW MANY OFF-PLAN LANDINGS BEFORE THE WALKER STOPS TALKING IN SQUARES.
//
// Measured on room 587's approach to its western gap: 4 of 9 planned steps land somewhere
// other than the plan asked for from one start, 24 of 42 from another — so the rate is
// high enough that a threshold of two or three separates "the world moved" from "my plan
// is in the wrong unit", while a walk across open floor never reaches it at all. Three,
// because two is within the noise of a single monster stepping across a doorway.
//
// Raise it to disable the behaviour without removing it; the square walk below is
// unchanged and still ends the walk honestly on its own budget.
const OFFPLAN_BEFORE_FINE = Number(process.env.M59_OFFPLAN_BEFORE_FINE || 3);

// HOW FAR ONE FINE STEP MAY REACH, AND WHY IT USED TO BE A SIXTH OF A REAL CLIENT'S.
//
// Measured on the live fleet before this existed: a six-square fine walk on open floor in
// North Barloque took 7518ms over 8 steps — 940ms a step, 0.80 SQUARES PER SECOND. A person
// running covers about five. So the fleet walked its hardest ground at a sixth of the pace
// of the client it is imitating, and the whole cost was in two constants and one blocking
// read.
//
// The stride is the first. 48 KOD units is three quarters of a square, and it could never
// grow: the loop halves it when a step is refused and restores it on success, but the
// restore was capped at the stride it STARTED with, so open floor was walked at exactly the
// reach chosen for squeezing through a gap. The adaptation was already there and only ever
// pointed downwards.
//
// 80 units — a square and a quarter — is not a taste. At the 250ms move pacing that is
// 5 squares a second, which is USER_RUNNING_SPEED's 5.0 in SQUARES_PER_SECOND: the fleet
// now moves at a client's pace and not faster. The server's own teleport check
// (user.kod:3072) trips at a squared distance of 200 from the last second boundary, about
// 14 squares, so this stays a long way inside the rule it has to respect.
//
// IT ONLY APPLIES TO THE DEFAULT STRIDE. Three call sites deliberately pass 24, 32 and 40
// for delicate work — the last mile into a safe spot, an edge nudge, a two-step recovery —
// and a ceiling that overrode those would make every careful walk careless. See `strideMax`.
const FINE_STRIDE     = Number(process.env.M59_FINE_STRIDE || 48);
const FINE_STRIDE_MAX = Number(process.env.M59_FINE_STRIDE_MAX || 80);

// HOW MANY FINE STEPS MAY BE PREDICTED BEFORE ONE IS READ BACK.
//
// The second constant. Every fine step blocked on `confirmPosition()` — a full room-contents
// round trip, measured at 203ms on a healthy character — and that is not merely latency:
// it DOUBLES the packet rate. One move plus one read, four times a second, is eight packets
// a second against a server that drops anything over five (INCOMING_PACKET_THROTTLE). The
// fleet was rate-limiting itself into the throttle and then waiting for the replies it had
// caused to be dropped, which is where 940ms a step comes from rather than the 450ms the
// pacing and the read account for.
//
// The read is also unnecessary most of the time, and the comment that demanded it says why
// without meaning to: it argues that fine movement may clip or slide, so prediction cannot
// know the endpoint. But `validateFineTarget` COMPUTES the slide, `queueValidatedMove`
// sends `validation.target` — the already-clipped point — and the server takes whatever
// coordinates it is sent. The endpoint is known before the packet leaves. `predictSelf` is
// the established answer and three other movement paths already use it.
//
// Not never, though. A prediction is not a confirmation and drift is real, so one step in
// six is read back, and any step that could have gone somewhere unexpected is read back
// immediately — see `mustConfirm`. Set to 1 to restore a confirm on every step.
const FINE_CONFIRM_EVERY = Number(process.env.M59_FINE_CONFIRM_EVERY || 6);

// HOW CLOSE A TRACED LINE MUST LAND TO COUNT AS ARRIVING, when deciding whether several
// planned squares can be crossed in one packet.
//
// A sixteenth of a square. It is deliberately tight: the whole safety argument for
// skipping ground is that the line ARRIVED rather than slid, and a loose threshold would
// quietly readmit the sliding this is meant to avoid. Loosening it does not make walks
// succeed, it makes them skip ground nothing checked.
const PIVOT_ARRIVE_WITHIN = Number(process.env.M59_PIVOT_ARRIVE_WITHIN || 64);

// ---------------------------------------------------------------- storage
const storage = new StorageCache();
const resources = loadResources();
let worldMap = loadMap();

// Attach baked step masks so pathfinding uses the mover's own geometry
// (fine BSP) instead of the coarse grid (monster perspective).
import { attachStepMasks } from './m59-routes.mjs';
let geometryStartupMode = 'eager';
try {
  const masks = attachStepMasks(worldMap, {
    lazy: process.env.M59_RUNTIME_PROFILE === 'lab',
  });
  geometryStartupMode = masks.lazy ? 'lazy' : 'eager';
  const usableMasks = (masks.attached ?? 0) + (masks.deferred ?? 0);
  if (usableMasks > 0) {
    console.error(`[routes] ${usableMasks} room(s) planning on the mover's own geometry` +
      (masks.deferred ? ` (${masks.deferred} deferred until first room use)` : '') +
      (masks.refused ? `, ${masks.refused} mask(s) refused as the wrong size` : ''));
  }
} catch (e) {
  console.error(`[routes] no step masks — ${e.message}`);
}

// EAGERLY BUILD THE INFERRED-REVERSE-EDGE TABLE. This is the ~10s map-global build that
// used to run lazily on the first world.exits() call — i.e. on a character's FIRST TICK
// after entering a room, stalling the tick loop for 24s (the cold-start stall). It is a
// pure, complete build (no budget, no truncation, no dropped edges), so moving it to
// startup only changes WHEN the cost is paid, not WHAT is computed. At startup the keeper
// is already busy loading geometry and masks, so the cost is off the tick path and
// invisible. inferredExits() still builds lazily as a fallback, so this is belt-and-braces
// rather than load-bearing.
try {
  const t0 = Date.now();
  buildReverseEdges(worldMap);
  console.error(`[routes] inferred-reverse table built at startup in ${Date.now() - t0}ms` +
                `, ${worldMap.__reverse?.size ?? 0} rooms (off the first tick)`);
} catch (e) {
  // A failure here means the lazy build will just happen on first use, as before.
  geometryStartupMode = 'eager';
  console.error(`[routes] startup reverse-edge build failed (${e.message}); will build lazily on first use`);
}

// EAGERLY PARSE EVERY ROOM'S GEOMETRY, off the tick path. The route search (findPath)
// visits many rooms, and the first access to each parses its .roo via RoomGeometry.
// fromJSON (~tens of ms each) — the ~12s half of the cold-start stall. Building them all
// at startup means the first tick does no geometry parsing. Same rationale as the
// reverse-edge build above: a pure, idempotent, complete build scheduled off the tick.
if (geometryStartupMode === 'lazy') {
  console.error('[routes] lab room geometry will decode lazily on first room use');
} else {
  try {
    const t0 = Date.now();
    const n = buildAllRoomGeometry(worldMap);
    console.error(`[routes] ${n} room geometries parsed at startup in ${Date.now() - t0}ms` +
                  ` (off the first tick)`);
  } catch (e) {
    console.error(`[routes] startup geometry build failed (${e.message}); will parse lazily on first use`);
  }
}

// ---------------------------------------------------------------- helpers

// Of several exits that all lead to the same place, try the reachable ones first
// and the nearest of those first. `reachable` is undefined for kinds the geometry
// cannot judge, so only an explicit false demotes a candidate.
// Stubs for broker-level infrastructure that the Session class references.
// These are fire-and-forget calls with .catch(), so a no-op stub is safe.
async function readFactionStatus(s, { refresh = false } = {}) {
  return { character: s.client?.me?.name ?? s.name, faction: 'unknown', soldier: false,
           observed_at: null, source: null, cached: false, max_health: null,
           note: 'faction read not available in keeper process' };
}
function chatterIfAny(name) { return null; }

// Monster levels, from the catalogue the repo already builds. viLevel is what
// AdvancementCheck compares against your max health, and the display name lives in
// the class's own resource block rather than anywhere on the wire, so the join is
// name -> level and has to be done here.
let _monsterLevels = null, _monsterKarma = null;
function loadMonsterLevels() {
  if (_monsterLevels) return _monsterLevels;
  _monsterLevels = new Map(); _monsterKarma = new Map();
  try {
    const raw = JSON.parse(readFileSync(new URL('./monsters.json', import.meta.url), 'utf8'));
    for (const m of Object.values(raw)) {
      const lvl = Number(m.viLevel);
      const krm = Number(m.viKarma);
      const put = (k) => {
        if (Number.isFinite(lvl)) _monsterLevels.set(k, lvl);
        if (Number.isFinite(krm)) _monsterKarma.set(k, krm);
      };
      if (m.class) put(String(m.class).toLowerCase());
      for (const v of Object.values(m._res || {}))
        if (Array.isArray(v) && typeof v[0] === 'string') put(v[0].toLowerCase());
    }
  } catch { /* catalogue missing — progress still reports the rule, just not levels */ }
  return _monsterLevels;
}
const monsterKarmaByName = (_, name) => {
  if (!_monsterKarma || !name) return null;
  const q = String(name).toLowerCase();
  if (_monsterKarma.has(q)) return _monsterKarma.get(q);
  let best = null, len = -1;
  for (const [k, v] of _monsterKarma)
    if ((k.includes(q) || q.includes(k)) && k.length > len) { best = v; len = k.length; }
  return best;
};

// Names on the wire are the display names ("giant rat"), and a caller may pass a
// partial. Exact first, then the longest containing match so "rat" does not win
// over "giant rat" by accident.
function monsterLevelByName(map, name) {
  if (!name) return null;
  const q = String(name).toLowerCase();
  if (map.has(q)) return map.get(q);
  let best = null, bestLen = -1;
  for (const [k, v] of map)
    if ((k.includes(q) || q.includes(k)) && k.length > bestLen) { best = v; bestLen = k.length; }
  return best;
}

// What arriving somewhere is worth saying. `travel` used to answer a request to
// MOVE with the entire destination room — every object, both map renderings — which
// is the single largest reply the broker produces and almost never what was asked
// for. A move should report that it moved, and what is worth knowing on arrival:
// is anything here hostile, is there loot, who else is standing about. Call `look`
// when the answer is yes.
const arrivalReport = (s) => {
  const v = s.view();
  const has = (o, verb) => Array.isArray(o.can) && o.can.includes(verb);
  return {
    room: v.room,
    you: v.you,
    vitals: v.vitals,
    here: {
      attackable: v.objects.filter(o => has(o, 'attack') && !o.is_player).length,
      players: v.objects.filter(o => o.is_player).length,
      on_the_floor: v.objects.filter(o => has(o, 'get')).length,
      merchants: v.objects.filter(o => has(o, 'buy')).length,
      other: v.objects.filter(o => !has(o, 'attack') && !has(o, 'get') && !has(o, 'buy') && !o.is_player).length,
      scenery: v.scenery?.total ?? 0,
    },
    exits: v.exits.length,
    note: 'arrival summary — call look for the full contents, or look with minimap:true for the picture',
  };
};

// WHICH DOOR LANDS WHERE — THE FIELD THE MAP HAS ALWAYS CARRIED AND NOTHING EVER READ.
//
// "A room's several ways to the same place are alternatives, not different journeys" is
// true right up until the destination is SPLIT, and then they are different journeys with
// the same name. Measured on prod 2026-08-27, room 38 into room 39:
//
//   door (19,2) and (19,1)  ->  arrives (28,8)
//   door (17,2) and (17,1)  ->  arrives (23,8)
//
// Four doors, two landing squares, one per disconnected island of Upstairs Castle Victoria.
// `orderExits` ranks by reachable-then-nearest, so a character wanting the far side takes
// the near door, arrives on the wrong island, and then stands looking at six battered
// skeletons it cannot path to — "the coarse grid found no route beside the target, and the
// fine grid could not reach one either". Six characters produced zero kills for an entire
// night that way, in a room with prey standing in it.
//
// `sameRoomIslandBridgePlan` already asks this question the right way round, filtering
// return doors by whether their LANDING can reach the goal. It could only ask it from
// inside the room, so a character part-way through the bridge — standing in the via room,
// which is exactly where they wedge — fell back to plain travel and picked by distance.
//
// Returns the set of door squares ("col,row", which is a `go` exit's own `stand_on`) whose
// arrival can walk to `target`, or null when the question cannot be answered — no target,
// no geometry, no arrival coordinates. Null means "no opinion", and the caller must then
// leave the ordering exactly as it was: a door set that silently narrowed to nothing would
// strand a character at a boundary it could otherwise have crossed.
function doorsLandingNear(map, fromRoomNum, toRoomNum, target) {
  if (!target || !Number.isFinite(Number(target.col)) || !Number.isFinite(Number(target.row)))
    return null;
  const from = map?.rooms?.[fromRoomNum], to = map?.rooms?.[toRoomNum];
  if (!from || !to?.roo) return null;
  let geo = null;
  try { geo = sharedRoomGeometry(to); } catch { geo = null; }
  if (!geo) return null;
  const onFloor = (p) => {
    if (geo.walkable(p.row, p.col)) return { row: p.row, col: p.col };
    const near = geo.nearestWalkable?.(p.row, p.col);
    return near ? { row: near.row, col: near.col } : null;
  };
  const goal = onFloor({ row: Number(target.row), col: Number(target.col) });
  if (!goal) return null;
  const ok = new Set();
  let asked = 0;
  for (const g of (from.goExits || [])) {
    if (g.locked || Number(g.to) !== Number(toRoomNum)) continue;
    if (g.arriveRow == null || g.arriveCol == null) continue;
    asked++;
    const landing = onFloor({ row: g.arriveRow, col: g.arriveCol });
    if (!landing) continue;
    if (geo.path(landing.row, landing.col, goal.row, goal.col, { fine: true }).found)
      ok.add(`${g.col},${g.row}`);
  }
  // No arrival coordinates anywhere, or every door reaches the goal: either way there is
  // nothing to choose between, and saying so is different from saying "none of them work".
  if (!asked || ok.size === asked) return null;
  return ok.size ? ok : null;
}

const orderExits = (candidates) => candidates.slice().sort((a, b) =>
  (a.reachable === false) - (b.reachable === false) ||
  // THE BAKED ANCHOR GOES FIRST, AND DISTANCE MUST NOT OUTRANK IT.
  //
  // leaveViaAny puts the anchor at the head of the list; this used to sort it straight back
  // down again, because the anchor is frequently the FURTHEST crossing square — in Ukgoth the
  // door to Castle Victoria is at 1,27 and the edge scan's squares are at 1,62 and beyond, so
  // the real doorway sorted last and the four-candidate budget never reached it. Unshifting it
  // achieved nothing at all, which is the kind of fix that looks applied and is not.
  //
  // Nearest-first is right among squares that are equally good guesses. An anchor is a better
  // guess: the bake planned a walkable line to it, while a scanned square only has floor on it.
  (b.from_anchor === true) - (a.from_anchor === true) ||
  // AN EXIT WITH NO SQUARE TO STAND ON GOES LAST. Without a stand_on, leaveVia falls
  // back to scanning the whole boundary line for somewhere walkable — and when that
  // line has no floor it fails outright, which is the "no floor anywhere on the west
  // boundary" dead end. A sibling exit that names an actual square is strictly better,
  // even if it is further away, because it is the one that can be walked to.
  (a.stand_on == null) - (b.stand_on == null) ||
  (a.steps_away ?? Infinity) - (b.steps_away ?? Infinity));


async function readAbilitiesOnce(s, { why = 'read', kinds = 'both' } = {}) {
  if (!s.live) return null;
  await abilities.readLive(s, { kinds });
  return s.recordAbilities({ why });
}

// ---------------------------------------------------------------- Pacer

class Pacer {
  constructor(rate = PACKETS_PER_SECOND) {
    this.minGapMs = 1000 / rate;
    this.q = [];
    this.running = false;
    this.lastSent = 0;
    this.lastByKind = new Map();
    // Packet-rate accounting for the server's 5/s throttle (user.kod:50). production =
    // how many jobs the tick loop SUBMITS per second (the bug: >5/s); sent = how many
    // actually leave the socket per second (what the server counts). If production > sent
    // the queue is backing up; if sent > 5 the server is dropping us as spam. Exposed via
    // the keeper's /pacerstats for ground-truth measurement.
    this.prodTimes = [];   // submission timestamps (rolling)
    this.sentTimes = [];   // send timestamps (rolling)
    this.prodByKind = new Map();  // kind -> rolling submission timestamps
  }

  // Per-kind production rate, for diagnosing WHAT is flooding the queue.
  prodByKindRate() {
    const cutoff = Date.now() - 3000;
    const out = {};
    for (const [kind, times] of this.prodByKind) {
      while (times.length && times[0] < cutoff) times.shift();
      out[kind] = +(times.length / 3).toFixed(2);
    }
    return out;
  }

  // Rolling per-second counts. Keep a 3s window so a just-ended second is still visible.
  _rate(times) {
    const cutoff = Date.now() - 3000;
    while (times.length && times[0] < cutoff) times.shift();
    return times.length / 3;  // avg per second over the window
  }

  submit(kind, fn, minGapForKind = 0) {
    this.prodTimes.push(Date.now());
    if (!this.prodByKind.has(kind)) this.prodByKind.set(kind, []);
    this.prodByKind.get(kind).push(Date.now());
    const job = { kind, fn, minGapForKind, resolve: null, reject: null, queuedAt: Date.now() };
    // PRIORITY: attack packets are time-critical (server cooldown = 1s). They jump
    // the queue ahead of move/turn/read packets so swings don't wait behind a backlog
    // of movement packets. Without this, a busy mover (move+turn every ~270ms) pushes
    // the swing to every 3s instead of every 1s.
    const isUrgent = kind === 'attack' || kind === 'cast';
    if (isUrgent) {
      // Insert after any other urgent packets but before non-urgent ones.
      let i = 0;
      while (i < this.q.length && (this.q[i].kind === 'attack' || this.q[i].kind === 'cast')) i++;
      this.q.splice(i, 0, job);
    } else {
      this.q.push(job);
    }
    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      this.pump();
    });
  }

  // What the server sees: jobs that actually leave the socket, per second.
  sentRate() { return this._rate(this.sentTimes); }
  // What the tick loop is asking for: submissions per second. If this is >> sentRate()
  // the queue is backing up; if it is > 5 we are over the server's throttle.
  prodRate() { return this._rate(this.prodTimes); }

  static budget = new Map();
  static startedAt = Date.now();
  static note(kind, phase, ms) {
    const k = `${kind}.${phase}`;
    const b = Pacer.budget.get(k) ?? { ms: 0, n: 0 };
    b.ms += ms; b.n++;
    Pacer.budget.set(k, b);
  }

  get depth() { return this.q.length; }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length) {
        const job = this.q.shift();
        const now = Date.now();
        const waitGlobal = Math.max(0, this.lastSent + this.minGapMs - now);
        const lastKind = this.lastByKind.get(job.kind) || 0;
        const waitKind = job.kind === 'move' && job.minGapForKind === DOOR_SETTLE_MS
          ? remainingDoorSettle({ lastMovementAt: lastKind, now, settleMs: job.minGapForKind })
          : Math.max(0, lastKind + job.minGapForKind - now);
        const wait = Math.max(waitGlobal, waitKind);
        Pacer.note(job.kind, 'queued', Math.max(0, now - job.queuedAt));
        Pacer.note(job.kind, waitKind >= waitGlobal ? 'paced' : 'throttled', wait);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        else await new Promise(r => setTimeout(r, 0));
        this.lastSent = Date.now();
        this.lastByKind.set(job.kind, this.lastSent);
        this.sentTimes.push(this.lastSent);
        const t0 = Date.now();
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
        Pacer.note(job.kind, 'send', Date.now() - t0);
        await new Promise(r => setImmediate(r));
      }
    } finally { this.running = false; }
  }
}

// ---------------------------------------------------------------- session
// MOVED FROM m59-broker.mjs WITH THE CLASS THAT USES IT. Session calls this; leaving it
// behind made it a free identifier that loads fine and throws on the branch that runs
// it -- the same shape as joinSessionOnce. m59-collision-test extracts it by name, and
// that extraction failing is what caught it here.
// REFUSALS THAT ARE ABOUT THE CHARACTER RATHER THAN THE MOMENT, so retrying can only
// reproduce them. `player_no_enter` (player.kod) is a GuildHall turning away anyone
// without PFLAG_PKILL_ENABLE. Matched on the server's own words because there is no code
// on the wire: it arrives as ordinary prose, exactly like a merchant's refusal.
// PROVE THE ROUTE ONCE, NOT ONCE PER STEP.
//
// `stringPull` reaches as far along a route as the straight line still ARRIVES with
// `slide:false`, and the bake has used it for exactly this since routes were first baked —
// "doing it HERE rather than at walk time is the point of a bake". Nothing at runtime ever
// called it. Instead `walkTo` rediscovered the same thing per step, tracing up to seven
// fine BSP lines every single move, on the one event loop every session in the broker
// shares. Measured across the twenty rooms of the Tos/Castle Victoria/Barloque circuit,
// the same routes are 97,113 grid squares and 16,810 pivots: 5.8x more moves than needed,
// each one paying for its own proof.
//
// So the plan is pulled ONCE, and the walker is told which squares sit on a leg the pull
// PROVED. On a proved leg every intermediate point is safe to aim at — a prefix of a
// straight line that arrives also arrives — so the coalescer can take the furthest square
// its hop cap allows without asking the geometry anything.
//
// AIMED AT THE STAND POINT, NOT THE CENTRE, because that is what `step` sends. The bake
// pulls between centres, which is the older aim; matching the sender here is the same
// "the second aim has to match the first" rule the coalescer below is built on.
//
// A room with no collision model, a pull that throws, or a route of one step all return
// null, and null means "walk exactly as before".
// MEMOISED, two seconds, per geometry: the walker asks the same (from, steps) on consecutive
// iterations while the body has not moved, and each answer is a string pull with a trace
// per pivot — the keeper's own profiler put it in every stall left once the needle had its
// clock (2026-09-02). The call site is unchanged, so the fixtures that lift walkTo see the
// same free symbols.
const PROVED_MEMO = new WeakMap();
function provedSquares(geo, from, steps) {
  if (!geo?.collisionReady || typeof geo.stringPull !== 'function') return null;
  if (!Array.isArray(steps) || steps.length < 2 || !from) return null;
  const memoKey = `${from.row},${from.col}|${steps.length}|${steps.map(s => s.row + ',' + s.col).join('>')}`;
  const now = Date.now();
  let perGeo = PROVED_MEMO.get(geo);
  if (!perGeo) { perGeo = new Map(); PROVED_MEMO.set(geo, perGeo); }
  const hit = perGeo.get(memoKey);
  if (hit && now - hit.at < 2000) return hit.value;
  const value = provedSquaresUncached(geo, from, steps);
  if (perGeo.size > 64) perGeo.clear();
  perGeo.set(memoKey, { at: now, value });
  return value;
}
function provedSquaresUncached(geo, from, steps) {
  const half = KOD_FINENESS >> 1;
  const pointOf = s => geo.standPoint?.(s.row, s.col)
    ?? { x: protocolToClient(s.col * KOD_FINENESS + half),
         y: protocolToClient(s.row * KOD_FINENESS + half) };
  try {
    const line = [from, ...steps];
    const pulled = geo.stringPull(line.map(pointOf));
    if (!pulled?.points?.length || !pulled.proved) return null;
    // Walk the pulled points back onto the plan, so a square can be asked "is the leg you
    // are on one the pull proved". Matching by POSITION rather than by index, because the
    // pull returns a subsequence and the caller holds the full route.
    const key = pt => Math.round(pt.x) + ',' + Math.round(pt.y);
    const pivotAt = new Map(pulled.points.map((pt, i) => [key(pt), i]));
    const ok = new Set();
    let leg = -1;
    for (const st of line) {
      const hit = pivotAt.get(key(pointOf(st)));
      if (hit !== undefined) leg = hit;               // we are standing on a pivot
      // `proved[leg]` is the leg LEAVING pivot `leg`; the final pivot has no leg after it.
      if (leg >= 0 && pulled.proved[leg]) ok.add(st.row + ',' + st.col);
    }
    return { squares: ok, pivots: pulled.points.length, unverified: pulled.unverified };
  } catch { return null; }
}


// ── CONSTANTS THE PORTED SESSION READS ──────────────────────────────────────────
//
// Verbatim from m59-broker.mjs, comments and all, because these are tuning decisions with
// reasoning attached and a re-derived number is a different decision wearing the same
// name. They were in the broker's module scope, so moving the class left them FREE --
// and a free CONSTANT is worse than a free function: my first scan looked for identifiers
// that were CALLED and missed every one of these, so the port loaded, passed every
// offline suite, and threw `LEAVE_VIA_CLEARANCE is not defined` the moment a live
// character tried to walk out of a room.
const BARRED_ON_ENTRY = /guardian angel holds you back/i;

// AND HOW LONG TO GO ON LOOKING AFTER THAT WAIT EXPIRES. Cheap insurance against a
// crossing that lands a moment late: the alternative to waiting three more seconds is
// walking the whole room again to try another square. See the confirmation poll in
// leaveVia's edge branch.
const EDGE_CONFIRM_MS = Number(process.env.M59_EDGE_CONFIRM_MS || 3000);

const EDGE_NUDGE_MAX_STEPS = Number(process.env.M59_EDGE_NUDGE_MAX_STEPS || 6);

const EDGE_NUDGE_WITHIN = Number(process.env.M59_EDGE_NUDGE_WITHIN || 16);
// HOW FAR SHORT OF THE OPENING A CHARACTER STILL WALKS IN RATHER THAN FEELING FOR IT.
// One square: the case the operator watched is a body standing beside a two-wide spur
// fanning nine headings for the doorway and sliding off the cliff instead. Two would start
// covering ground the ordinary approach walk should have covered.
const EDGE_STEP_IN_WITHIN = Number(process.env.M59_EDGE_STEP_IN_WITHIN || 1);

// HOW MANY WAYPOINTS MAY PASS WITH THE BODY NO FURTHER ALONG THE LINE before the follower
// stops asking for the next square and jumps. Small, because each one is a second or two
// spent standing in whatever room this is, and the Cragged Mountains is not a room to spend
// seconds in. The jump is short for the same reason a skip is: the line ahead is still the
// line, and `walkFine` covers a gap of a few squares perfectly well.
// HOW MUCH CLEAR GROUND TO PUT BETWEEN THE BODY AND A BOUNDARY AFTER ARRIVING.
//
// ONE IS NOT ENOUGH, and the map says why. Entering the Western border of the Twisted Wood
// from the Main gate to the city of Tos lands the character at row 8, column 66 — and that
// room is 55 rows by 67 columns, so the east boundary is one square away. That boundary
// carries TWO exits, split on the crossing row:
//
//     east -> 586  Main gate to the city of Tos   when row < 19
//     east -> 597  The Twisted Wood               when row > 20
//
// Row 8 is inside the first band. So the body arrives one slide from the door it just came
// through, and the tracer shows exactly that: `586->587` followed immediately by `587->586`.
// Stepping merely OFF the boundary does not help when the arrival square is already off it.
//
// Two squares costs one extra step and removes the whole class: a slide has to go wrong
// twice in the same direction before it crosses anything.
const INLAND_MARGIN_SQUARES = Number(process.env.M59_INLAND_MARGIN || 2);

const LEAVE_VIA_CLEARANCE = Number(process.env.M59_LEAVE_VIA_CLEARANCE ?? 0);

// How many packets a planned square may cost before the walk is called runaway. One would
// be right if the mover landed where the router aims it; it does not, and the argument and
// the measurement are at the `budget` line in walkTo.
const OFF_PLAN_STEP_BUDGET = Number(process.env.M59_STEP_BUDGET_FACTOR || 3);

// AND HOW FAR ONE MOVE MAY REACH ALONG A LEG THE STRING PULL ALREADY PROVED.
//
// Eight is the right cap for ground nobody has traced: a long move that fails costs its
// whole length. It is the WRONG cap for a leg the pull proved arrives, and chopping one is
// how the fleet lost the Cragged Mountains. The baked crossing of room 598 — its north
// doorway to its south — is 64 squares and SEVEN proved legs, of 20, 3, 9, 1, 1, 7 and 23
// squares. At a cap of eight the walker cannot take the 20 or the 23 in one move; it stops
// at an intermediate square CENTRE that nothing ever proved, aims at it, slides, and starts
// the bounce the rest of this file is about. The proof is "the straight line from here to
// there arrives"; a prefix of it aimed at a different point is not that proof.
//
// THIRTEEN, AND THE NUMBER IS THE SERVER'S. user.kod:3049 logs a possible speedhacker when
// a move covers `iSquaredDistance >= 200` with fewer than three seconds since the last
// update — 200 is 14.1 squares, so 13 (169) keeps a square of margin. `step` also paces a
// hop by its OWN duration as well as the one it owes, so a long move is never sent hard on
// the heels of a short one; without that the distance check is the only thing standing
// between a proved leg and a cheat log.
const PROVED_HOP_MAX_SQUARES = Number(process.env.M59_PROVED_HOP_MAX || 13);
// HOW CLOSE A BODY MAY COME TO ANOTHER BODY, IN KOD FINE UNITS — AND IT IS THE SERVER'S OWN
// NUMBER, NOT A DERIVATION FROM THE PLAYER'S WIDTH.
//
// `MIN_NOMOVEON` is `CLIENT_FINENESS / 4` = 256 client units (move.c:62), which is 16 kod.
// `_resolveObjectMicrostep` is the rule it feeds: an obstacle is ONE exclusion zone of that
// radius around its centre, and a move is refused only when it ends inside it AND closer than
// it started.
//
// I first set this to 32, reasoning "PLAYER_RADIUS is 15.5 kod, so two bodies need 31 apart".
// That is the wrong model and it was double the truth — the server does not add two radii, it
// tests one. The cost was not theoretical: the live walker sat at "clear by 16", which is
// EXACTLY the real limit, while this constant told it that was a collision. It spent ninety
// seconds refusing positions the server would have accepted, and the operator — who had
// walked the same corridor by hand — said so.
//
// WALL clearance really is `PLAYER_RADIUS`, and that is a different question asked by
// `_resolveClientMicrostep`. Two numbers, two rules; conflating them is what made a passable
// corridor read as impassable.
//
// No safety margin on purpose. With a body dead centre in a one-square corridor the passable
// band is y 1871.5..1872 — half a unit wide — and any margin at all closes it. Aiming exactly
// at the limit and letting the mover's own collision resolve the rest is what a person does.
// Keep-right lanes in corridors (see keepRightAim in m59-roo.mjs). On by default for every
// fleet; M59_KEEP_RIGHT=0 is the only way off, because a rule of the road only works when
// every keeper follows it.
const KEEP_RIGHT_OFF = process.env.M59_KEEP_RIGHT === '0';
const BODY_CLEARANCE_KOD =
  Number(process.env.M59_BODY_CLEARANCE ?? (MIN_NOMOVEON * KOD_FINENESS / CLIENT_FINENESS));
// HOW FINELY A LEG IS RESOLVED AGAINST BODIES, and how near counts as arriving. Both are
// modelling choices about the client's frame rate rather than facts on the wire, which is why
// they are named and overridable.
// FOUR, NOT EIGHT, AND THE NEGATIVE CASE IS WHAT SETTLED IT. The slide clamps a coordinate to
// the obstacle's centre plus or minus MIN_NOMOVEON, and WHICH SIDE depends on where the attempt
// landed: an attempt that overshoots past the body is clamped to the far side, which is a jump
// THROUGH it. A real client cannot do that because it resolves a few units at a time — about
// 5 kod a frame at a run — but a coarse simulation can, and at a stride of 8 three bodies
// abreast in one square became passable. They are not. Four is under the frame step and a
// divisor of the lattice.
// HOW LONG A HIT KEEPS THE WALKER ON SHORT LEGS. Long enough to cover the gap between
// blows from anything that is actually fighting us — the fleet's own hit book shows a
// character under attack taking one every one to two seconds — and short enough that a
// journey through a quiet room goes straight back to full-length legs. See walkPivots.
const SHELTER_HIT_WINDOW_MS = 4000;

const BODY_WALK_STRIDE = Number(process.env.M59_BODY_WALK_STRIDE || 4);
const BODY_WALK_ARRIVE = Number(process.env.M59_BODY_WALK_ARRIVE || 8);

/**
 * HOW CLOSE A STRAIGHT LINE COMES TO A POINT. Ordinary segment/point distance, clamped to
 * the segment so a body BEYOND the far end is not treated as being on the way to it.
 */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * DOES THIS LINE GET PAST EVERYTHING STANDING NEAR IT.
 *
 * The half that was missing, and the reason the first threading attempt failed live. A
 * body-clear DESTINATION is not a body-clear MOVE: `traceFineMoveClient` validates against
 * walls, and the mover's own note says so outright — "a body in the way is the one collision
 * that is not in the .roo". So the aim was chosen on the far side of a spider and the line to
 * it still went straight through the spider, the step was refused, the square was marked
 * occupied, and the walker went round. Watched live on 2026-08-27: it touched the contested
 * square twice at clearances of 21 and 18 against a required 32, then wandered for two
 * minutes.
 *
 * Same clearance as the destination test, because it is the same question asked along the
 * whole segment rather than only at its end.
 */
export function lineClearsBodies(ax, ay, bx, by, bodies, clearance = BODY_CLEARANCE_KOD) {
  if (!bodies?.length) return true;
  for (const b of bodies) {
    // NEVER ASK FOR MORE ROOM THAN WE ALREADY HAVE.
    //
    // A segment's distance to a point is bounded by the distance at its START, so a flat
    // `>= clearance` test refuses EVERY move once the body is already inside the clearance —
    // including the move that walks away from it. The test poisons itself, and the walker
    // stops dead.
    //
    // Watched live on 2026-08-27: the walker settled 16 units from a body in the row-29
    // corridor and never moved again, while the offline fixture — which fed each step an
    // idealised start — happily produced aims 50 clear. That gap between the suite and the
    // server was this line.
    //
    // So the bar is "do not get CLOSER than you already are", capped at the clearance we
    // actually want. Far away it is the full body width; already squeezed, it is whatever
    // room we have, which is what lets a body finish a squeeze it is halfway through and what
    // lets one that has been shoved against a spider get out again.
    const already = Math.hypot(b.x - ax, b.y - ay);
    if (distanceToSegment(b.x, b.y, ax, ay, bx, by) < Math.min(clearance, already)) return false;
  }
  return true;
}

/**
 * ONE ATTEMPTED MOVE AGAINST THE BODIES, TRANSCRIBED FROM THE CLIENT RATHER THAN MODELLED.
 *
 * `clientd3d/move.c:666-697`, the `OF_MOVEON_NO` arm of the object loop, in kod units. Every
 * line of it matters and three of them are things this repository previously got wrong:
 *
 *   1. THE TEST IS ON THE MOVE'S ENDPOINT, NOT ON THE PATH IT TAKES. `dx = abs(r->motion.x -
 *      *new_x)` — the destination. Walls are swept (`FindIntersection`); bodies are not. So a
 *      line that passes near somebody and lands clear is not a collision, and every "the LINE
 *      has to clear too" rule written here was an invention.
 *
 *   2. "Allowed to move away from object" — `if (new_distance > old_distance) break;`. You may
 *      END INSIDE the zone as long as you are farther out than you were. This is what lets a
 *      body that has been shoved against somebody get out again.
 *
 *   3. WHEN IT DOES BLOCK, IT SLIDES. It does not refuse: it clamps one coordinate to the
 *      obstacle's centre plus or minus MIN_NOMOVEON, re-checks the walls, and returns
 *      MOVE_CHANGED. You move — just not where you asked. X is clamped in preference to Y,
 *      which is not symmetric and is exactly what the code says.
 *
 * The consequence is the whole reason this exists. Two bodies 25.3 apart cannot both be cleared
 * by 16, so a clearance model says the gap is shut — and the operator walked between them with
 * the stock client and recorded it. Under these rules that run is twelve consecutive slides,
 * each one legal, grinding between the pair. A rule that cannot express "grind through" cannot
 * predict what the game does.
 *
 * Returns the position the client would end at, and how it got there. The caller owns the wall
 * test, because it owns the geometry.
 */
export function resolveBodyMove(px, py, tx, ty, bodies, clearance = BODY_CLEARANCE_KOD) {
  let nx = tx, ny = ty;
  if (!bodies?.length) return { x: nx, y: ny, slid: false };
  for (const b of bodies) {
    let dx = Math.abs(b.x - nx), dy = Math.abs(b.y - ny);
    // Not in the zone at all. The square pre-check and the circle are both in the original;
    // the circle is inside the square, so the effective shape is a disc of radius MIN_NOMOVEON.
    if (dx > clearance || dy > clearance || dx * dx + dy * dy > clearance * clearance) continue;
    const newD = dx * dx + dy * dy;
    const odx = Math.abs(b.x - px), ody = Math.abs(b.y - py);
    if (newD > odx * odx + ody * ody) break;             // "Allowed to move away from object"
    // The slide. X first, exactly as written — `if (dx < MIN_NOMOVEON) ... else if (dy < ...)`.
    if (dx < clearance) nx = b.x > nx ? b.x - clearance : b.x + clearance;
    else if (dy < clearance) ny = b.y > ny ? b.y - clearance : b.y + clearance;
    return { x: nx, y: ny, slid: true, on: b };          // move.c returns on the first blocker
  }
  return { x: nx, y: ny, slid: false };
}

/**
 * CAN A BODY ACTUALLY WALK THIS LEG, THE WAY THE CLIENT WOULD WALK IT?
 *
 * The client resolves a move per frame, so a leg is a sequence of short attempts, each one
 * subject to `resolveBodyMove` and each one wall-checked. Sliding is not failing — it is how
 * the game gets people past each other — so this asks the only question that matters at the
 * end: did we arrive.
 *
 * `stride` is the granularity, and it is a modelling choice rather than a fact: too coarse and
 * a body steps over an obstacle it would have ground against, too fine and every leg costs
 * dozens of wall traces. Eight kod is about what a running character covers in a frame.
 *
 * NOT A REPLACEMENT FOR THE WALL TRACE. `wallOk` is passed in and asked on every sub-move,
 * because a slide moves the endpoint sideways and the .roo has to be re-asked about the line
 * that actually results.
 */
export function bodyWalkArrives(ax, ay, bx, by, bodies, {
  clearance = BODY_CLEARANCE_KOD,
  stride = BODY_WALK_STRIDE,
  wallOk = null,
  arriveWithin = BODY_WALK_ARRIVE,
} = {}) {
  const total = Math.hypot(bx - ax, by - ay);
  if (!(total > 0)) return true;
  if (!bodies?.length) return wallOk ? wallOk(ax, ay, bx, by) : true;
  // EACH ATTEMPT IS AIMED FROM WHERE WE ACTUALLY ARE, NOT SAMPLED OFF THE ORIGINAL LINE, and
  // that distinction is not cosmetic. The client computes `new_x` as the player's position plus
  // this frame's velocity; a simulation that walks a fixed parameterisation keeps offering
  // targets further along even after a slide has pushed it back, and the slide's choice of side
  // depends on which side of the obstacle the TARGET fell. Sampled off the line, a body pinned
  // at x 2896 was eventually offered x 2913 — past the obstacle's centre at 2912 — and the clamp
  // duly put it on the far side at 2928. It teleported through three bodies abreast, which is
  // the one configuration this must never allow.
  let px = ax, py = ay, stalled = 0;
  const budget = Math.ceil(total / stride) * 3 + 8;
  for (let i = 0; i < budget; i++) {
    const rem = Math.hypot(bx - px, by - py);
    if (rem <= arriveWithin) return true;
    const t = Math.min(1, stride / rem);
    const r = resolveBodyMove(px, py, px + (bx - px) * t, py + (by - py) * t, bodies, clearance);
    const moved = Math.hypot(r.x - px, r.y - py);
    // A slide that leaves us where we were is the bodies actually holding. Three attempts with
    // nothing to show is a grind that is not grinding, and continuing costs traces for nothing.
    if ((wallOk && !wallOk(px, py, r.x, r.y)) || moved < 0.5) {
      if (++stalled > 2) return false;
      continue;
    }
    stalled = 0; px = r.x; py = r.y;
  }
  return Math.hypot(px - bx, py - by) <= arriveWithin;
}

// Fine-positioning at a boundary opening before the outward step that actually crosses.
// Both are deliberately small: this is a nudge onto the opening, and the crossing does
// not depend on hitting it exactly. See leaveVia's edge branch.
// HOW HARD `leaveVia` PREFERS OPEN GROUND ON THE WAY TO A BOUNDARY — AND IT IS ZERO NOW.
//
// The argument for 0.6 was good and the measurement behind it was of the wrong thing. It
// counted PLAN-TIME blocked neighbours per step (1.35 -> 0.72 in room 587) on the reasoning
// that threading a walker along a wall is where a slid step starts the bounce. Measured
// instead on whether the walker ARRIVES — `m59-walksim.mjs --cycle --clearance 0,0.6`, the
// same starts, the same twelve walks a room to each room's own baked exit anchors:
//
//     clearance 0     218/252   86.5%   36.2 steps per arrival
//     clearance 0.6   211/252   83.7%   37.9
//
// No room is better with it on. Two are much worse, and one of them is the room that was
// blocking the whole itinerary: THE CRAGGED MOUNTAINS GOES 7/12 TO 2/12. Traced on the one
// walk a live character kept failing — 598, 30,24 to the Ukgoth doorway at 64,19 — it is
// 93 steps and arrives flat, and 118 steps and runs out of budget at clearance 0.6, with
// the off-plan landings going 14 to 26.
//
// That is the whole of "598 -> 599: every square for that exit refused (4 tried)", which
// the transit ledger recorded 49 times in a row: `leaveVia` walks to the boundary with this
// preference on, the walk never gets there, and the exit is blamed for it.
//
// Left as a named constant rather than deleted because the mechanism is real — a wall-hug
// IS where a slide starts — and somebody may yet find the right weight. The number to beat
// is 218/252, and `m59-walksim.mjs` is how to beat it.
// HOW CLOSE TO A DOOR MAKES A RAIL POINTLESS. A rail crosses a ROOM; inside this radius the
// ordinary walk is a short approach over ground the coarse grid expresses, and getting onto a
// line that starts somewhere else is strictly worse — sometimes catastrophically, when the
// line's start is itself a doorway to somewhere we do not want to go.
const RAIL_SKIP_WITHIN_SQUARES = Number(process.env.M59_RAIL_SKIP_WITHIN || 8);

// WHEN A CROSSING HAS GONE ON LONG ENOUGH THAT "YOU COULD WALK IT" STOPS BEING AN ANSWER.
//
// The operator's rule, 2026-09-03: past two minutes in a room, oscillating, offer blink
// whatever the reachability predicate thinks. Two minutes is his number and it is a long
// way above the honest crossings — 578 measured 20-22s over seven consecutive trials, and
// the rooms this repository complains about most are 88-208s at their worst. So this fires
// on a genuine outlier rather than on a slow room.
const CROSSING_STALL_MS = Number(process.env.M59_CROSSING_STALL_MS || 120_000);
// The footprint window, and how few distinct squares in it count as going round in circles.
// Twenty-four moves is long enough that an honest walk through a corridor cannot be mistaken
// for a loop, and six squares is wide enough to catch a shuffle that wanders a little.
const CROSSING_WINDOW = Number(process.env.M59_CROSSING_WINDOW || 24);
const CROSSING_DISTINCT = Number(process.env.M59_CROSSING_DISTINCT || 6);
// Do not ask the strategies about the same loop every tick; one ask per this many ms.
const CROSSING_ASK_EVERY_MS = Number(process.env.M59_CROSSING_ASK_EVERY_MS || 20_000);
// AND HOW LONG ON ONE SQUARE COUNTS AS COVERING NO GROUND. Sixty seconds: a body that has
// not changed square in a minute, inside a crossing already past its two-minute clock, is
// not walking anywhere. Deliberately far longer than any ordinary pause at a door.
const CROSSING_PINNED_MS = Number(process.env.M59_CROSSING_PINNED_MS || 60_000);
// HOW LONG TO SPEND BREAKING CONTACT BEFORE CASTING WITHOUT A WALL. The operator's number,
// 2026-09-03: five seconds. Long enough to back off a few proven crumbs and short enough
// that it cannot become a second way of standing still — which is the condition it is being
// asked to end. It bounds an attempt, never the cast: the cast follows either way.
const BLINK_EVADE_MS = Number(process.env.M59_BLINK_EVADE_MS || 5_000);

// THERE WAS A SECOND GUTTER THRESHOLD HERE AND IT WAS WRONG. Written down in case anybody
// reaches for it again: `RAIL_GUTTER_MIN_DOOR`, which declined a gutter rail whenever the
// door was already within 25 steps, on the argument that a gutter line is the long way
// round and cannot pay for itself over a short walk. The argument sounds right and the
// number came off a map the fleet does not walk — an unmasked `neighbors()` reading, which
// is the server's coarse grid (see the gutter head that used to be declared for 578).
//
// What kills it is Ukgoth. `67,15 -> 71,2` is the operator's terminal rail out of the lower
// basin, the one written after seven of thirteen deaths in one thirty-minute run happened
// down there, and on the masked graph that door is FIFTEEN steps away. The threshold would
// have declined the basin's only declared way out — re-breaking, quietly, the exact case
// that `railAcross` reading `r.gutters` was added to fix.
//
// A gutter head is not a hint that the walk is long. It is a hand-placed claim that the
// ordinary walk does not work from there, and distance is not what decides that.

const RAIL_STALL_JUMP = Number(process.env.M59_RAIL_STALL_JUMP || 3);

const RAIL_STALL_WAYPOINTS = Number(process.env.M59_RAIL_STALL_WAYPOINTS || 3);

// HOW MANY STEPS A WALK MAY TAKE WITHOUT EVER GETTING CLOSER. Generous enough to go round a
// building — the Streets of Tos crossing is 24 squares and its worst legitimate detour is a
// handful — and far short of the sixty-odd squares of oscillation that prompted it.
const WALK_STALL_STEPS = Number(process.env.M59_WALK_STALL_STEPS || 24);

const HOST = process.env.M59_HOST || '127.0.0.1';

const PORT = Number(process.env.M59_PORT || 5959);

// TWO BROKER-OWNED HOOKS, STUBBED RATHER THAN MOVED.
//
// `drainExitGaps` walks the broker's `sessions` registry and `saveFleetState` writes the
// broker's `fleetState` -- neither is Session's to own, and dragging them here would pull
// the broker's global state into a module the keeper processes load on their own. So they
// are declared inert here and the broker overrides them, exactly as noteGeometryDrift
// above already does. A keeper process therefore drains nothing and saves nothing, which
// is correct: it has no registry and no roster.
// FOUR broker-owned things now, not two. `factionStatuses` is the broker's status cache
// and `fleetState` is its roster Map -- a keeper process has neither, and creating our own
// would be two homes for one quantity, which is the shape this repository keeps paying
// for. So the broker's instances are shared through globalThis when there is a broker, and
// the defaults are inert: a keeper process reads no faction status and finds no roster
// entry, which is the truth rather than a guess.
if (!globalThis.factionStatuses)
  globalThis.factionStatuses = { read: () => null, observe: () => null,
                                 reconcileInventory: () => null };
if (!globalThis.fleetState) globalThis.fleetState = new Map();
const factionStatuses = globalThis.factionStatuses;
const fleetState = globalThis.fleetState;
if (typeof globalThis.drainExitGaps !== 'function') globalThis.drainExitGaps = () => {};
if (typeof globalThis.saveFleetState !== 'function') globalThis.saveFleetState = () => {};
const drainExitGaps = (...a) => globalThis.drainExitGaps(...a);
const saveFleetState = (...a) => globalThis.saveFleetState(...a);

// PURE GEOMETRY, MOVED WITH THE CLASS THAT USES IT. leaveVia calls this; left in the
// broker it was a free identifier that threw only on the branch that reached it.
function atEdgeOpening(position, opening, direction) {
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)
      || !Number.isFinite(opening?.x) || !Number.isFinite(opening?.y)) return false;
  const name = String(direction ?? '').toLowerCase();
  const fixedAxisMatches = name === 'north' || name === 'south'
    ? Number.isInteger(position.row) && position.row === Math.floor(opening.y / KOD_FINENESS)
    : name === 'west' || name === 'east'
      ? Number.isInteger(position.col) && position.col === Math.floor(opening.x / KOD_FINENESS)
      : false;
  return fixedAxisMatches
    && Math.abs(position.x - opening.x) <= KOD_FINENESS
    && Math.abs(position.y - opening.y) <= KOD_FINENESS;
}

class Session {
  constructor(name) {
    this.name = name;
    this.pacer = new Pacer();
    this.client = null;
    this.world = null;
    // Fleet resume and an HTTP caller can request the same slot during broker
    // boot. They must share one login attempt instead of racing two sockets for
    // the same character.
    this.joining = null;
    this.cursor = 0;                    // last event seq this agent has been told about
    this.fine = false;                  // fine-movement mode — see walkFine
    this.recorder = new Recorder(name); // flight recorder; never surfaced in replies
    this.job = null;                    // one background action — see startJob
    // Every movement operation captures this generation when it starts. Bumping it
    // invalidates walks already in progress without poisoning later, independent
    // orders. This is deliberately session-local: one character has one body.
    this.movementGeneration = 0;
    this.cancelledMovementTokens = new Set();
    // BP_PLAYER/BP_MOVE do not carry the body's visual z. Keep a short-lived,
    // conservative range after changing floor height so a rapid follow-up packet
    // cannot assume an instantaneous climb/fall and slip through a low arch or up
    // the next step. Re-entering a room or the settle deadline resets it naturally.
    this.collisionVertical = null;
    // HOW GOOD THIS CHARACTER IS, kept across logins and across restarts of this
    // process. Loaded lazily by character name, because the agent name is which slot
    // of the fleet is driving and gets reassigned — the character is the thing that
    // has the skills. See m59-abilities.mjs.
    this.book = null;
    this.bookSaveTimer = null;
    // WHERE THIS CHARACTER GETS HURT, off the event stream rather than off the keeper.
    //
    // Health is PUSHED — one BP_STAT per change — so this records at full resolution
    // through the windows where nothing else is looking: mid-travel, mid-errand, and
    // while the keeper is inert with something else driving. Those windows are where the
    // fleet has been dying and are exactly what the post-mortem cannot see. See
    // m59-hits.mjs.
    this.hits = null;                   // the book, loaded lazily by character name
    this.lastHealth = null;             // to tell a hit from a heal
    this.damagedAt = 0;                 // when the last of those was a DROP — see noteHealth
    this.lastCombatLine = null;         // { at, who } — best-effort attribution
    this.hitsSaveTimer = null;
    // HOW LONG EACH MAP TAKES TO CROSS. The other half of the same question and the more
    // actionable one: damage on the road is normal and not a fault, but two minutes inside
    // one room is a slow crossing, and slow is something we control. See m59-transits.mjs.
    this.transits = null;
    this.transitSaveTimer = null;
    // A PvP target is never inferred from a name or a broadcast. The opt-in faction
    // game surface records only a freshly inspected player profile in this room and
    // expires it quickly; engage() rechecks the profile once more before attacking.
    this.factionGameTargets = new Map();
  }

  // The hit record for whoever this session is currently playing. Keyed by CHARACTER and
  // not by agent, for the same reason the ability book is: the agent name is which slot of
  // the fleet is driving and gets reassigned.
  hitBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.hits || this.hits.character !== who) this.hits = hitbook.loadBook(who);
    return this.hits;
  }

  // The transit record for whoever this session is currently playing. Keyed by CHARACTER
  // for the same reason the others are — the agent name is a fleet slot and gets reused.
  transitBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.transits || this.transits.character !== who) this.transits = transits.loadBook(who);
    return this.transits;
  }

  // ONE MAP, CROSSED ONCE. Called from travel()'s hop loop — see m59-transits.mjs.
  noteTransit(entry) {
    const book = this.transitBook();
    if (!book) return;
    try {
      transits.record(book, { at: Date.now(), ...entry });
      // On a timer, like the hit book: a journey writes one of these per room and there is
      // no reason to put the disk in the middle of a walk.
      if (!this.transitSaveTimer) {
        this.transitSaveTimer = setTimeout(() => {
          this.transitSaveTimer = null;
          try { transits.saveBook(this.transits); } catch { /* never let a write stop play */ }
        }, 10_000);
        this.transitSaveTimer.unref?.();
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  // WHO IS SWINGING, when the server happens to have said so.
  //
  // Damage arrives as a stat packet and names nobody; the prose that names an attacker is
  // a separate message and there is no id tying the two together. They do arrive close
  // together, so a combat line within a couple of seconds of a health drop is almost
  // always about it — and "almost always" is the honest description, which is why this
  // lands in a `by` LIST on the segment rather than a `killed_by` field that would read as
  // authoritative. The death broadcast is the authoritative one and the post-mortem
  // already has it.
  noteCombatLine(ev) {
    // "The fungus beast nicks you with its attack." / "The troll hits you."
    const m = /^(?:The|An?) ([a-z' -]+?) (?:[a-z]+s) you\b/i.exec(ev.text || '');
    if (m) this.lastCombatLine = { at: ev.at ?? Date.now(), who: m[1].toLowerCase() };
  }

  // ONE HEALTH READING. Called for every health stat the server sends.
  //
  // A DROP IS A HIT AND A RISE IS NOT, and that is the whole of the logic that cannot live
  // in m59-hits.mjs — it sees one number at a time and has no way to tell regeneration
  // from damage. Resting, eating and a heal all push health the other way and must never
  // become segments.
  //
  // A LOGIN IS NOT A HIT EITHER. `lastHealth` is cleared on join, so the first reading
  // after a login establishes the baseline rather than being compared against whatever the
  // character had before it died.
  noteHealth(ev) {
    const now = ev.at ?? Date.now();
    const value = ev.value, max = ev.max;
    if (typeof value !== 'number') return;
    const before = this.lastHealth;
    this.lastHealth = value;
    if (before == null || value >= before) return;      // a heal, or the first reading
    // TOOK A HIT. STAMP IT, BECAUSE THE WALKER NEEDS TO KNOW *NOW* AND NOT AT THE END OF
    // THE LEG IT IS IN THE MIDDLE OF.
    //
    // The shelter divert used to be read once per leg, and a proved leg coalesces up to
    // twenty-three squares into a single move — several seconds of walking with nothing
    // asked. Measured over 138 diverts on the shadow fleet: 42% fired more than 25 points
    // below their own threshold, median shortfall 20 points, worst 97 — one character
    // decided to run for cover at 3% health against a threshold of 100%. Two of the eight
    // deaths in that tour chose a wall at 5% and 3%.
    //
    // This is the only place in the session that can tell damage from regeneration, so it
    // is the only honest place to stamp it. Nothing is decided here: the walker reads the
    // stamp and re-asks its own question, because what counts as "hurt enough" belongs to
    // the keeper's policy and not to a packet handler.
    this.damagedAt = now;
    const book = this.hitBook();
    if (!book) return;
    const me = this.client?.self;
    const keeper = autopilotIfAny(this.name);
    const line = this.lastCombatLine;
    try {
      hitbook.record(book, {
        at: now,
        room: this.world?.room?.num ?? null,
        roomName: this.world?.room?.name ?? null,
        col: me?.col ?? null, row: me?.row ?? null,
        // WHAT THE KEEPER THOUGHT IT WAS DOING. `doing` is cleared at the end of each
        // pass, so `lastDoing` is what a reading taken between passes should report — and
        // between passes is precisely when travel damage arrives.
        doing: keeper?.doing ?? keeper?.lastDoing ?? null,
        health: value, max: max ?? null,
        lost: before - value,
        by: line && now - line.at < 2500 ? line.who : null,
      });
      // Written on a timer rather than per hit: a character under six attackers takes one
      // every second or two, and a synchronous write each time would put the disk in the
      // packet path. Ten seconds is far shorter than any window we would want to explain.
      if (!this.hitsSaveTimer) {
        this.hitsSaveTimer = setTimeout(() => {
          this.hitsSaveTimer = null;
          try { hitbook.saveBook(this.hits); } catch { /* never let a write stop play */ }
        }, 10_000);
        this.hitsSaveTimer.unref?.();
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  get live() { return this.client && this.client.state === 'game'; }

  // The ability record for whoever this session is currently playing.
  abilityBook() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    if (!this.book || this.book.character !== who) this.book = abilities.loadBook(who);
    return this.book;
  }

  // Writes are batched. An advancement arrives as its own packet and a character in a
  // good fight can gain several in a minute; one file write each would be a lot of
  // syscalls to record a number that nothing reads until somebody asks.
  saveBookSoon() {
    if (this.bookSaveTimer) return;
    this.bookSaveTimer = setTimeout(() => {
      this.bookSaveTimer = null;
      if (this.book) abilities.saveBook(this.book);
    }, 5000);
    this.bookSaveTimer.unref?.();
  }

  // One advancement, as the server pushed it. This is the whole reason the cache does
  // not need polling: ChangeSkillAbility sends BP_STAT for the slot that moved, every
  // time (player.kod:7343), so the record is written as it happens rather than
  // reconstructed later from two reads and a subtraction.
  noteAdvancement(ev) {
    const book = this.abilityBook();
    if (!book) return;
    const changed = abilities.noteAdvancement(book, ev);
    if (changed.length) this.saveBookSoon();
  }

  // A BANK BALANCE GOES PAST ON THE WIRE AND IS NEVER MENTIONED AGAIN. Catch it here.
  //
  // Same reasoning as noteAdvancement above and the same seam, for a stronger reason:
  // an ability can at least be re-read for four requests, and a balance cannot be read
  // at all without walking the character to a counter. The server states it as PROSE
  // from a banker's mouth (monster.kod:136) and there is no packet to poll, so if this
  // line goes past unread the number is gone until someone spends the walk.
  //
  // It was going past unread. The only balances this fleet had on record were the ones
  // that happened to fall inside a flight recording still on disk, or inside the
  // postmortem of a character that died shortly after banking. Everything else had
  // already been pruned.
  //
  // Cheap enough to do on every message: m59-bank.mjs bails on the first regex for
  // anything that is not about an account, which is every line but a handful per hour.
  // What this character has on deposit, written down the moment the vaultman says it.
  //
  // The fee the packet carries per item is kept: it is `GetVaultRetrievalFee`, which is
  // what getting the thing back will cost, and that is a different number from what the
  // item is worth. Storing it means the board can say what emptying the vault would cost
  // without another trip.
  noteVault(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      const entry = storage.writeVault(who, ev.items || [],
        { at: ev.at ?? Date.now(), account: ev.vaultmanId ?? null });
      this.recorder.line('note', { what: 'vault contents recorded', character: who,
        items: entry.items.length });
    } catch { /* a record is a convenience; never let it interrupt play */ }
  }

  // THE ONLY NOTICE A FACTION MEMBER EVER GETS, CAUGHT ON ITS WAY PAST.
  //
  // `player_faction_time` (player.kod:160) is `MsgSendUser` prose, sent once when the
  // service counter crosses FACTION_WARN_TIME, and there is no packet, no stat and
  // nothing to poll. Four hours later `ResignFaction` runs and the character is out. So
  // this is the bank-balance pattern exactly: written down at the moment it is said, or
  // the fleet finds out by noticing a membership has quietly become 'neutral'.
  //
  // The expulsion line is caught too, because "the deadline passed" and "the server threw
  // this character out" are different claims and only the second one is observed.
  noteLoyalty(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      if (isLoyaltyWarning(ev.text)) {
        const status = factionStatuses.read(who);
        const entry = factionStatuses.noteLoyaltyWarning(who,
          { at: ev.at ?? Date.now(), soldier: status?.soldier === true });
        this.recorder.line('note', { what: 'faction loyalty warning', character: who,
          faction: entry.faction, due_at: entry.loyalty?.due_at ?? null,
          soldier: entry.loyalty?.soldier_at_warning === true });
      } else if (isLoyaltyLost(ev.text)) {
        factionStatuses.noteLoyaltyLost(who, { at: ev.at ?? Date.now() });
        this.recorder.line('note', { what: 'faction membership lost', character: who });
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  noteBanker(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      const entry = bankbook.record(who, ev.text, {
        at: ev.at ?? Date.now(),
        room: this.client?.room?.id ?? null,
        roomName: this.world?.room?.name ?? null,
      });
      if (entry) {
        this.lastBank = entry;
        this.recorder.line('note', { what: 'bank balance recorded', ...entry });
      }
    } catch { /* the record is a convenience; never let it interrupt play */ }
  }

  // The last balance we know of, for whichever account was touched most recently.
  // Null rather than zero when nothing has ever been recorded — "we have not seen this
  // character at a bank" and "this character has nothing" are different answers.
  bankKnown() {
    const who = this.client?.me?.name ?? null;
    if (!who) return null;
    try {
      const rows = bankbook.balancesFor(who);
      if (!rows.length) return null;
      const latest = rows[0];
      return {
        balance: latest.balance, account: latest.account, at: latest.at,
        observed: latest.observed,
        ...(rows.length > 1 ? { accounts: Object.fromEntries(rows.map(r => [r.account, r.balance])) } : {}),
      };
    } catch { return null; }
  }

  // Fold everything the client currently holds into the record. Called after the read
  // that follows a login, and after any refresh.
  recordAbilities({ why = 'read' } = {}) {
    const book = this.abilityBook();
    if (!book || !this.client) return null;
    const known = this.client.abilitiesKnown();
    const changed = abilities.mergeAbilities(book, {
      skills: known.known.skills ? known.skills : null,
      spells: known.known.spells ? known.spells : null,
    }, { why });
    abilities.saveBook(book);
    return changed;
  }

  // The server accepts one move packet per second and there is no way around that,
  // so a cross-map walk genuinely costs minutes of wall clock. For a single
  // character, blocking for those minutes is honest. For a fleet it is the wrong
  // shape: a supervisor moving twenty characters would spend twenty times the
  // longest walk, in series, purely because the reply is the only way to learn the
  // outcome. So: start it, return now, and let `status` and `fleet` carry the
  // result. One job at a time per session — the character has one body.
  startJob(kind, label, fn, { controlToken = null, leaseToken = null } = {}) {
    if (this.job && !this.job.done) throw new Error(`${this.name} is busy: ${this.job.label}`);
    const generation = this.movementGeneration;
    const job = { kind, label, startedAt: Date.now(), done: false, generation,
                  ...(controlToken ? { controlToken } : {}),
                  ...(leaseToken ? { leaseToken } : {}) };
    this.job = job;
    // KEPT SO A FOREGROUND CALLER CAN AWAIT THE SLOT IT JUST CLAIMED.
    //
    // Background callers poll `job.result`/`job.error` and that is unchanged. A
    // foreground one has to be able to await the same work WITHOUT a second code path,
    // because "there is another way to run a travel" is exactly how one of the two ways
    // ended up with no busy check at all — see the travel tool.
    job.promise = fn(generation).then(
      r => { job.result = r; return r; },
      e => { job.error = e.message; throw e; })
      .finally(() => { job.done = true; job.finishedAt = Date.now(); });
    // Nobody is obliged to await it, so absorb the rejection here or a failed background
    // job becomes an unhandled rejection and takes the broker — and its sessions — down.
    // `job.error` still carries the failure to every existing reader, exactly as before.
    job.promise.catch(() => {});
    return job;
  }

  // THE ONLY WAY ANYTHING IN THIS FILE SHOULD START A JOURNEY.
  //
  // `travel()` is the hop loop and knows nothing about who else wants the character. Two
  // things have to be true AROUND it, and both used to be the travel tool's private
  // business:
  //
  //   the JOB SLOT   — so a second journey is refused instead of driving the same body;
  //   the KEEPER HOLD — so the keeper is not taking safe spots and pulling monsters while
  //                     we walk, which is the same contention by a different door.
  //
  // Every other caller here — the faction errands, the Raza exit, the follow loop —
  // reached `travel()` directly and got NEITHER. So an errand could walk a character that
  // a travel call was already walking, and the thirty lines of comment on the travel tool
  // preventing exactly that protected only the callers that came through the tool.
  //
  // It THROWS when the body is taken, exactly as `startJob` does, and that is the useful
  // answer: an errand that cannot have the character should say so rather than fight for
  // it. Callers that already turn a throw into a failed leg need no change at all.
  // A JOURNEY STEERS. IT DOES NOT TAKE THE CHARACTER AWAY FROM ITS OWN SURVIVAL.
  //
  // This used to call `keeper.goInert()` and then `Session.travel` directly, and both
  // halves of that were wrong in the same way — they treated a journey like an errand:
  //
  //   goInert switched the survival ladder OFF for the whole walk. Cccc was walked out of
  //   a sanctuary at 27% health with a 70% flee threshold and eaten over twenty-two
  //   seconds by four giant rats while the keeper watched every frame of it. It is
  //   `goTravelling` now — see TRAVEL_GUARD_DEFAULTS in m59-autopilot.mjs for what that
  //   keeps armed and how each part of it is switched off.
  //
  //   `Session.travel` is the hop loop and nothing else. Going straight to it skipped
  //   `restBeforeSettingOut` (so a character asked to cross the world at 30% health set
  //   off at 30% health), skipped the `onHop` hook (so the mid-journey wall hold and the
  //   sanctuary rest could never fire — `travel_arm` reads null on every one of those
  //   post-mortems), and wrote no `travel_journey` row, so the travel-safety experiment
  //   could not see externally-driven journeys at all. Every one of those is a faculty
  //   that exists in this repository and was simply not reachable from the tool the fleet
  //   is actually driven by.
  //
  // So it goes through the KEEPER's travel when there is a keeper, and falls back to the
  // raw hop loop only when there is not — a session with no autopilot has nothing to ask.
  //
  // ONE BEHAVIOUR CHANGE WORTH STATING: `Autopilot.travel` enforces `confine_rooms`, so a
  // confined character now refuses an external travel out of its confinement instead of
  // quietly taking it. That is the documented intent of the setting — "the rooms this
  // character may be in AT ALL" — and the refusal is returned, not thrown.
  travelJob(dest, { where = `room ${dest}`, runErrands = true, ...opts } = {}) {
    const keeper = autopilotIfAny(this.name);
    return this.startJob('travel', `walk to ${where}`, async movementGeneration => {
      let ours = null;
      // READ BEFORE THE WALK, BECAUSE THE ONLY USE FOR IT IS A COMPARISON. Read afterwards
      // it is the count that already includes the death it is supposed to detect — which is
      // exactly the bug this pairs with below.
      const deathsAtStart = Number(keeper?.tally?.deaths ?? NaN);
      // WHAT THE TRIP COST, FOR THE ANNOUNCEMENT AT THE END OF IT.
      //
      // A death is broadcast by the SERVER, so an operator watching from inside the game
      // sees every failure and no successes — the fleet looks like it does nothing but die
      // while 96% of hops are arriving. These are the three numbers that make an arrival
      // worth reading: where it came from, how close it came to not making it, and how many
      // walls it had to stop at on the way.
      const restsAtStart = Number(keeper?.tally?.rests ?? 0);
      const fromRoom = { num: Number(this.world?.room?.num ?? NaN),
                         name: String(this.world?.room?.name ?? '') };
      let lowHealth = null, lowMax = null;
      // ERRANDS FIRST, AND ONLY EVER HERE. `passErrand` stands down for the whole of a
      // journey — every branch of it walks the character somewhere and it is already going
      // somewhere — so this is the one moment they get. Default on, because a character
      // sent across the world should bank and stock up before it goes rather than discover
      // halfway through the Twisted Wood that it wants a bank.
      if (runErrands && keeper?.settleErrandsBeforeJourney)
        await keeper.settleErrandsBeforeJourney({ where }).catch(() => null);
      // RE-ASSERTED ON A TIMER, because a stood-down keeper WAKES ON A DEADLINE
      // (`INERT_MAX_MS`, so a crashed errand cannot silence one for ever) and that
      // deadline does not know a journey is in progress. Watched live before this
      // existed: a stale hold lapsed mid-walk and the character was being driven by the
      // keeper and by travel at once.
      //
      // And only ever revive a hold that is OURS — reviving somebody else's is how a
      // character ends up driven by two things again, which is the whole point of this.
      //
      // IT ALSO RE-ASSERTS AFTER A TAKE-BACK, and that is deliberate. When the travelling
      // guard cancels the journey the mover sees `movementWasCancelled` and unwinds within
      // a step or two; until it does, this timer must not put the character straight back
      // into the state the guard just left. So it re-asserts only while the movement
      // generation it was given is still the live one — once the guard has cancelled, this
      // journey is over and its hold is not reinstated.
      // `ours` is the hold OBJECT, not a boolean, and that is the whole of the release
      // check below. A take-back can end this journey and a second one can start before
      // this `finally` runs, at which point "is the keeper travelling" is true and is
      // about somebody else's walk — and reviving that is the two-drivers bug wearing a
      // different hat. Identity is the only question that survives the race.
      const assert_ = () => {
        // The health low-water mark, sampled on the timer that is already ticking. A
        // journey is minutes long and the keeper's own frames are not visible from here,
        // so this is the cheapest honest sample available: every two seconds, whatever the
        // walk is doing.
        try {
          const v = this.client?.vitals?.();
          const h = v?.health?.value, m = v?.health?.max;
          if (Number.isFinite(h) && (lowHealth === null || h < lowHealth)) { lowHealth = h; lowMax = m; }
        } catch { /* a vitals read is never worth ending a journey over */ }
        if (!keeper || keeper.inert) return;
        if (this.movementWasCancelled(movementGeneration)) return;
        keeper.goTravelling(`travelling to ${where}`, { to: dest });
        ours = keeper.inert;
      };
      assert_();
      const timer = setInterval(assert_, 2000);
      timer.unref?.();
      let outcome = null;
      try {
        // Through the keeper, so the journey gets the pre-departure rest, the hop hook and
        // the ledger row. `Autopilot.travel` calls `Session.travel` underneath, so this is
        // one extra frame and no recursion.
        if (keeper && typeof keeper.travel === 'function')
          outcome = await keeper.travel(dest, { ...opts, movementGeneration });
        else outcome = await this.travel(dest, { ...opts, movementGeneration });
        return outcome;
      } finally {
        clearInterval(timer);
        // Only if it is still the very hold we took.
        if (ours && keeper?.inert === ours) {
          // A JOURNEY THAT DID NOT ARRIVE IS NOT FINISHED, AND THIS IS WHERE IT WAS FORGOTTEN.
          //
          // `revive` hands the body back to the ordinary ladder and drops the objective with
          // it. That is right when the character got there, and wrong every other time — and
          // every other time is common: a journey ends short on stumbles, on a hop budget, on
          // a terminal refusal.
          //
          // Measured, from the harness's own account of what the character thought it was
          // doing:
          //
          //     +  0s  room  50  inert — travelling to Castle Victoria
          //     +213s  room 597  idle
          //     +219s  room 597  holding a proven safe spot
          //
          //     travel_journey: to 38 | legs 3 of 7 | 214s | hp 33 -> 17
          //
          // Three legs of seven, then idle in The Twisted Wood — and it sat there for the
          // remaining five hundred and seventy seconds of the leg, resting behind a wall with
          // a destination it no longer knew about. `suspended_journey` read null.
          //
          // Kept HERE rather than at the individual failure paths, because there are many of
          // those and this is the one place they all pass through. The resume machinery
          // already exists and already refuses the cases it should — died since, too many
          // tries, stale, too hurt, switched off — so all it needed was to be told.
          const arrived = outcome?.arrived === true;
          const here = Number(this.world?.room?.num ?? NaN);

          // SAY SO, WHEN IT WORKED. OFF BY DEFAULT, AND THAT IS NOT TIMIDITY.
          //
          // `broadcast` costs a percentage of MAXIMUM MANA per line, and this fleet spends
          // mana on `create food` at 15 a casting — which is the only way past the vigor
          // rest cap of 80. A fleet announcing every arrival to the whole server would pay
          // for the telemetry out of the larder. So the channel is an operator's choice:
          //
          //   M59_TRIP_ANNOUNCE=broadcast   the whole server — what a watcher on another
          //                                 account sees, and the only one that costs mana
          //   M59_TRIP_ANNOUNCE=yell        this room and its neighbours, free
          //   M59_TRIP_ANNOUNCE=say         this room only, free
          //   unset / off                   nothing, which is the committed default
          //
          // A FAILED JOURNEY SAYS NOTHING. The server already broadcasts deaths and the
          // transit ledger already records short trips; a character announcing its own
          // failures would be the noisiest thing on the server and the least informative.
          // THE CHARACTER'S OWN SETTING FIRST, THE MACHINE'S SECOND.
          //
          // The environment variable is all-or-nothing across a broker, so watching ONE
          // character run errands meant making the whole fleet broadcast — and a broadcast
          // costs mana the larder needs. `trip_announce` in that character's loadout is the
          // narrow answer: per character, live on the next pass after the file is saved, no
          // restart and no second broker. "off" in the file beats the variable being on,
          // which is the direction that has to work for a fleet-wide default to be usable.
          const channel = String(keeper?.policy?.tripAnnounce
                                 ?? process.env.M59_TRIP_ANNOUNCE ?? '').trim().toLowerCase();
          const kind = { say: 1, yell: 2, broadcast: 3 }[channel];
          if (arrived && kind && this.client?.say) {
            const rests = Math.max(0, Number(keeper?.tally?.rests ?? 0) - restsAtStart);
            const pct = (lowHealth !== null && lowMax) ? Math.round(100 * lowHealth / lowMax) : null;
            const toName = String(this.world?.room?.name ?? where);
            const line =
              `Arrived: ${fromRoom.name || ('room ' + fromRoom.num)} to ${toName}` +
              ` in ${outcome?.hops ?? '?'} hop(s)` +
              // "health down to 100%" is not a sentence anybody wants to read a hundred
              // times a night. Untouched is the good outcome and should read like one.
              (pct === null ? ''
               : pct >= 100 ? ', untouched'
               : `, health down to ${pct}% (${lowHealth}/${lowMax})`) +
              (rests === 0 ? ', no rest stops.' :
               rests === 1 ? ', 1 rest stop at a safe wall.'
                           : `, ${rests} rest stops at safe walls.`);
            // Never let the announcement be the thing that fails a journey that arrived.
            // THE PACER FIRST, THE CLIENT IF IT REFUSES. In the broker's proxy Session
            // `pacer.submit` throws on purpose — "the pacer is in the keeper process" —
            // so choosing it merely because it EXISTS would mean this line never went out
            // from that side, silently, which is the failure mode this whole change is
            // trying to cure.
            try {
              try { await this.pacer.submit('say', () => this.client.say(line, kind)); }
              catch { await this.client.say(line, kind); }
            } catch { /* said nothing; the trip still happened */ }
          }
          // ARRIVING SETTLES THE TAB. Otherwise a character that reached Castle Victoria at
          // the cost of one death carries that death into the NEXT objective and is given
          // one fewer try for a road that has not charged it anything.
          if (arrived && keeper && Number(keeper.journeyDeaths?.to) === Number(dest))
            keeper.journeyDeaths = null;

          // A DEATH IS A FAILED JOURNEY, NOT AN INTERRUPTED ONE. THE OPERATOR'S RULE.
          //
          // Get out of the Underworld, go to the inn the exit lands in, and rest. Do not
          // pick the road back up: whatever killed the character is still on it, the body
          // has lost everything it was carrying, and max health has already been paid. A
          // second attempt on the same road with less of everything is how one death
          // becomes three.
          //
          // AND THIS LINE WAS ALREADY WRONG IN A WAY THAT DEFEATED THE EXISTING GUARD.
          // `resumeSuspendedJourney` refuses when `tally.deaths !== j.deaths_at` — "died
          // since it was suspended" — but `deaths_at` was being stamped HERE, in the
          // `finally`, which runs AFTER the death. So the two numbers agreed, the guard
          // never fired, and a character that had just been killed would set off again.
          //
          // THREE SIGNALS, BECAUSE ONE OF THEM IS NOT TRUSTWORTHY ON ITS OWN. Room 1 is
          // where the game puts the dead and the hop loop already treats it as a death
          // rather than a wrong doorway. `recoverUntilWhole` is set on the way out of the
          // Underworld and stays set until health, mana and vigor are all back, so it
          // survives the escape that room 1 does not. The counter is the weakest of the
          // three and is only ever used as a comparison against the value read before the
          // walk — keepers restart about once a minute and a tally is not a rate, which is
          // this repository's own warning and the reason it is not asked on its own.
          const diedOnTheWay = here === 1
            || keeper?.recoverUntilWhole === true
            || (Number.isFinite(deathsAtStart)
                && Number(keeper?.tally?.deaths ?? deathsAtStart) > deathsAtStart);

          if (diedOnTheWay) {
            // ONE COPY OF THE RULE, AND IT IS NOT THIS ONE. `journeyEndedInADeath` applies
            // `travel_deaths_allowed` and keeps the per-objective tally; it is also called
            // the moment a character wakes up dead, which is the door a death arrives
            // through when something OTHER than this job suspended the objective. Writing
            // it twice is how shadow02 came back from the Cragged Mountains still carrying
            // a destination a troll had already settled.
            //
            // The objective may not exist yet at this point — a journey that died before
            // anything suspended it — so hand the destination over first.
            if (keeper && !keeper.suspendedJourney && dest != null)
              keeper.suspendedJourney = {
                to: Number(dest), why: `travelling to ${where}`, at: Date.now(),
                trigger: 'died on the way',
                attempts: (keeper.inert?.attempts ?? 0) + 1,
                deaths_at: Number.isFinite(deathsAtStart) ? deathsAtStart
                                                          : (keeper.tally?.deaths ?? 0),
              };
            keeper?.journeyEndedInADeath?.('the travel job ended in a death');
          } else if (!arrived && dest != null && here !== Number(dest)) {
            keeper.suspendedJourney = {
              to: Number(dest), why: `travelling to ${where}`, at: Date.now(),
              // Keep a stable executor diagnosis visible to status/polling callers. This
              // field is reporting metadata, not retry policy; the generic sentence remains
              // the backward-compatible fallback for every older failure shape.
              trigger: outcome?.outcome ?? 'the travel job ended short of the destination',
              attempts: (keeper.inert?.attempts ?? 0) + 1,
              deaths_at: Number.isFinite(deathsAtStart) ? deathsAtStart
                                                        : (keeper.tally?.deaths ?? 0),
            };
          }
          keeper.revive('travel finished');
        }
      }
    });
  }

  // The same thing for a caller that wants to WAIT. `travelJob` for one that does not.
  travelExclusive(dest, opts = {}) { return this.travelJob(dest, opts).promise; }

  movementWasCancelled(generation, controlToken) {
    return generation !== this.movementGeneration ||
      (!!controlToken && this.cancelledMovementTokens.has(controlToken));
  }

  cancelledMovement(extra = {}) {
    return { arrived: false, left: false, cancelled: true,
             reason: 'movement cancelled by a newer command',
             // WHO PULLED THE HANDBRAKE, AND WHEN. Without this the transit book records
             // 45 of 46 hop failures as "movement cancelled by a newer command" and there
             // is no way to tell WHICH newer command — the flee watchdog, a travel guard
             // rung, an operator, or the keeper starting an errand of its own over the top
             // of a journey. Four different bugs behind one sentence.
             cancelled_by: this.lastMovementCancel?.why ?? 'unattributed',
             cancelled_ms_ago: this.lastMovementCancel
               ? Date.now() - this.lastMovementCancel.at : null,
             ...extra };
  }

  cancelMovement(controlToken, why = 'unattributed') {
    const job = this.job && !this.job.done ? this.job : null;
    this.lastMovementCancel = { why, at: Date.now(),
                                room: this.world?.room?.num ?? null };
    this.movementGeneration++;
    if (controlToken) {
      this.cancelledMovementTokens.add(controlToken);
      // Tokens are short-lived command leases, not history. Keep enough to cover
      // stale local requests without letting a long-running broker grow forever.
      if (this.cancelledMovementTokens.size > 100) {
        this.cancelledMovementTokens.delete(this.cancelledMovementTokens.values().next().value);
      }
    }
    if (job) {
      job.cancelRequestedAt = Date.now();
      job.cancelled = true;
    }
    return {
      cancelled: true,
      interrupted: job ? { kind: job.kind, label: job.label } : null,
      note: job
        ? 'the active movement will stop after its current paced server step'
        : 'any in-flight foreground walk will stop after its current paced server step',
    };
  }

  jobReport() {
    return rtsJobReport(this.job);
  }

  async join(args) {
    return joinSessionOnce(this, args, value => this.joinOnce(value));
  }

  async joinOnce({ account, password, character, host = HOST, port = PORT }) {
    // Kept so the session can put itself back together. A `save game` renumbers
    // every object id, which leaves a live session holding a selfId the server has
    // stopped using — see Autopilot.pass. Logging in again is the only cure, and it
    // needs these.
    this.credentials = { account, password, character, host, port };
    const c = new M59Client({ host, port, verbose: false, resources });
    // Everything the server says, straight to disk. This is the only place the raw
    // stream is kept — the in-memory event ring is small and is overwritten fast.
    //
    // Advancement is picked off the same stream on its way past. It has to be caught
    // here rather than polled for: the server sends one BP_STAT the instant an ability
    // moves and never mentions it again, so a poll that arrives later sees the number
    // but not the event, and cannot tell a gain from a value it had all along.
    // A FRESH LOGIN IS A FRESH BASELINE. Without this the first health reading after a
    // death would be compared against whatever the character had before it died and
    // recorded as one enormous hit in whatever room it woke up in.
    this.lastHealth = null;
    this.lastCombatLine = null;
    c.onEvent = ev => {
      this.recorder.line('event', ev);
      if (ev.kind === 'ability') this.noteAdvancement(ev);
      if (ev.kind === 'message' && ev.text) { this.noteBanker(ev); this.noteCombatLine(ev); this.noteLoyalty(ev); }
      // A VAULT ANSWERS ONCE AND ONLY WHEN ASKED, so this is caught off the stream for
      // exactly the reason a bank balance is: whatever walked a character to a vaultman
      // has already paid for the trip, and if the reply goes past unread the contents are
      // unknown until somebody pays for it again.
      if (ev.kind === 'vault-list') this.noteVault(ev);
      // OFF THE STREAM, NOT OFF THE KEEPER. This is the one measurement that keeps
      // working while the keeper is inside a multi-minute travel await or held inert by
      // an errand — which is where 23 of the last 50 deaths happened. See m59-hits.mjs.
      if (ev.kind === 'stat' && ev.name === 'health') this.noteHealth(ev);
    };
    if (character) c.wantName = character;
    try {
      await c.login(account, password);
    } catch (error) {
      // A failed login never becomes this.client, so nobody else can close its socket.
      // Reconnect backoff would otherwise leak one connected/stalled socket per attempt.
      try { c.stopKeepalive?.(); } catch {}
      try { c.sock?.destroy?.(); } catch {}
      throw error;
    }
    this.client = c;
    this.world = new World(c, worldMap);

    // WRITE THE NAME DOWN. The roster records an account and a password; which CHARACTER
    // that account is only becomes known once the login gets as far as the character
    // list, and it was being thrown away every time. That is why the resume log prints
    // "resumed t1 (?)" for characters this broker has run for weeks.
    //
    // It matters beyond tidiness: the startup check that stands down for a person playing
    // one of ours has to ask the who list whether that character is online, and the who
    // list speaks names, not accounts. With nothing on record it can only take the client
    // command line's word for it.
    const learned = c.me?.name ?? null;
    if (learned && learned !== this.credentials.character) {
      this.credentials = { ...this.credentials, character: learned };
      const entry = fleetState.get(this.name);
      if (entry?.credentials) {
        fleetState.set(this.name, { ...entry, credentials: { ...entry.credentials, character: learned } });
        saveFleetState();
      }
    }
    // The server does not volunteer the world. Ask, paced, and let the replies
    // land before reporting.
    await this.pacer.submit('read', () => c.roomContents());
    await this.pacer.submit('read', () => c.players());
    await this.pacer.submit('read', () => c.requestInventory());
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    await new Promise(r => setTimeout(r, 600));

    // ABILITIES, ONCE, HERE. Four more requests, and this is the only place they have
    // to be spent: from now on the server pushes every change, so the cache stays
    // true without anybody asking again.
    //
    // Deliberately not awaited. It is four paced requests and a settle, and a fleet
    // resume brings twenty-one sessions up at once — making each login wait for its
    // own ability read would add that to the time the fleet is not playing, to
    // populate something nothing needs in the first second.
    this.firstAbilityRead = readAbilitiesOnce(this)
      .catch(e => { this.recorder.line('note', { what: 'ability read failed', why: e.message }); });

    // FACTION MEMBERSHIP, ONCE, HERE, FOR THE SAME REASON — except that unlike abilities
    // the server never pushes a change, so this is the only moment it can be caught
    // cheaply. It is one paced `look` at ourselves, and `Player.TryLook` (user.kod:4374)
    // checks invisibility, checks the room and sends the profile: it moves nothing, breaks
    // no invisibility and touches no aggression timer, so there is no safe-moment to wait
    // for and nothing is attracted by asking.
    //
    // Deliberately not awaited, exactly as above: a fleet resume brings twenty-one sessions
    // up at once and none of them should wait on a profile read to start playing. A person
    // who joins a faction between logins therefore has it noticed at the next login rather
    // than never, which is what happened to Piggy — joined the Jonas rebels, and the board
    // reported neutral until somebody asked by hand.
    //
    // `M59_FACTION_ON_LOGIN=0` turns it off.
    if (process.env.M59_FACTION_ON_LOGIN !== '0')
      readFactionStatus(this, { refresh: true })
        .then(status => this.recorder.line('note', { what: 'faction read', faction: status?.faction }))
        .catch(e => { this.recorder.line('note', { what: 'faction read failed', why: e.message }); });
    // A chatter binds to the CLIENT, not to the session, so a rejoin after a save-game
    // renumber leaves it listening to a socket that no longer exists. Rebind here rather
    // than making every caller remember to.
    chatterIfAny(this.name)?.reattach();
    return this.snapshot('joined');
  }

  // MAKE A NEW CHARACTER ON THIS ACCOUNT, at the one moment the server will accept
  // one: the character list, before anything has been taken into the world.
  //
  // The client already exposes the seam — `onCharacters` fires exactly there — so
  // this is the ordinary login with BP_NEW_CHARINFO substituted for BP_USE_CHARACTER,
  // then a USE of whatever id comes back in BP_CHARINFO_OK.
  //
  // The `user` field is the one part not documented anywhere in this repository, and
  // the server's habit of accepting bad input silently means a wrong value would look
  // like success and produce a junk character. So the caller is expected to have
  // verified this against a throwaway account before pointing it at anything real,
  // and `verify` below is what does that checking.
  // The `user` field is the OBJECT ID OF THE CHARACTER BEING REPLACED, and this is
  // not a guess any more — kod/util/system.kod:3719 reads it straight off the wire:
  //
  //     oUser = Nth(client_msg,2);
  //     if NOT Send(oUser, @IsFirstTime) { bLegal = FALSE; }
  //
  // BP_NEW_CHARINFO is a RECREATE, not a create-from-nothing: the server deletes the
  // old user, recycles the object, renames it and re-rolls it in place. So the id has
  // to name an existing character on this account, and that character has to be
  // first-time — which is what the suicide arranges (PerformSuicide sets
  // piLastLoginTime = 0, and IsFirstTime is exactly that test).
  //
  // Passing 0 is the failure we actually hit: Send(0,@IsFirstTime) does not throw, so
  // bLegal stays true, the handler runs on a null object, and AddPacket(4,oUser) sends
  // CHARINFO_OK carrying 0. It looks like success and produces nothing.
  async joinAsNewCharacter(plan, { userField = null } = {}) {
    if (!this.credentials) throw new Error('nothing to create against — this session never joined');
    const { account, password, host = HOST, port = PORT } = this.credentials;
    try { this.client?.sock?.destroy(); } catch { /* already gone */ }
    this.client = null;
    await new Promise(r => setTimeout(r, 900));

    const c = new M59Client({ host, port, verbose: false, resources });
    c.onEvent = ev => this.recorder.line('event', ev);
    let asked = false, newId = null, refused = false, replaced = null, notFirstTime = null;
    c.onCharacters = (list) => {
      if (asked) return;
      asked = true;
      // PICK THE ONE THE SERVER WILL ACCEPT.
      //
      // system.kod:3725 refuses any character that is not IsFirstTime, and the
      // character list already says which one that is: the low bit of `flags` is set
      // on exactly the character a suicide has made available. Choosing by name or by
      // position instead sends a perfectly valid id for a character the server will
      // not re-roll, and the refusal is silent — no CHARINFO_OK, no CHARINFO_NOT_OK,
      // just a login that never completes.
      const want = String(this.credentials.character || '').toLowerCase();
      const firstTime = list.filter(x => x.flags & 1);
      // NO FIRST-TIME CHARACTER MEANS THE SUICIDE DID NOT LAND — AND THE USUAL REASON
      // IS THE COOLDOWN. user.kod:32 sets SUICIDE_REPEAT_TIME = 600, and :1520 refuses
      // a second suicide within ten minutes of the last one, per character. The
      // refusal is a message to the user, not an error, so a client that does not read
      // it carries on and sends a creation request for a character the server will
      // never re-roll.
      //
      // Sending it anyway is worse than useless: it burns the attempt and produces a
      // result that looks like a protocol bug. Refuse here instead, and say which of
      // the two it is.
      const pick = (want && firstTime.find(x => x.name.toLowerCase() === want)) || firstTime[0];
      if (!pick) {
        notFirstTime = list.map(x => x.name);
        return;   // leaves `asked` false; the caller reports why
      }
      replaced = pick ? { id: pick.id, name: pick.name } : null;
      const user = userField ?? pick?.id ?? 0;
      c.newCharInfo({
        user, name: plan.name, gender: plan.gender ?? 1,
        stats: plan.stat_list, spells: plan.spell_nums, skills: plan.skills ?? [],
      });
    };
    const priorEmit = c.emit?.bind(c);
    c.emit = (kind, data) => {
      // CHARINFO_OK carries the new object id, and taking it into the world is the
      // ordinary USE — the same call the normal login path makes once it has picked a
      // character off the list.
      if (kind === 'charinfo-ok' && data?.id != null) {
        newId = data.id;
        c.useCharacter(data.id);
        c.me = { id: data.id, name: plan.name };
      }
      if (kind === 'charinfo-not-ok') refused = true;
      return priorEmit(kind, data);
    };

    await c.login(account, password).catch(e => { throw new Error(`creation login failed: ${e.message}`); });
    this.client = c;
    this.world = new World(c, worldMap);
    this.credentials = { ...this.credentials, character: plan.name };
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    await new Promise(r => setTimeout(r, 800));
    return {
      created: !refused && !!c.selfId, refused, object_id: newId ?? c.selfId,
      name: plan.name, asked, replaced,
      ...(notFirstTime ? {
        blocked: 'no character on this account is available for creation',
        characters: notFirstTime,
        why: 'a character only becomes available after a suicide, and user.kod:32 sets ' +
             'SUICIDE_REPEAT_TIME = 600 — one suicide per character per ten minutes. Either ' +
             'the suicide was refused by that cooldown, or it never ran. Nothing was sent.',
      } : {}),
    };
  }

  // Drop the connection and log in again with the same credentials. The object id
  // is reissued at login, so this is what repairs a session whose selfId the server
  // renumbered underneath it.
  async rejoin() {
    if (!this.credentials) throw new Error('nothing to rejoin with — this session never joined');
    try { this.client?.sock?.destroy(); } catch { /* already gone */ }
    this.client = null;
    await new Promise(r => setTimeout(r, 800));
    return this.join(this.credentials);
  }

  // "NOT IN GAME" IS TRUE OF TWO DIFFERENT FAULTS AND ONLY ONE OF THEM IS A CONNECTION.
  //
  // A session that HAS joined and dropped is the case this sentence was written for, and
  // "call join first" is the right advice for it. A session that has NEVER joined — no
  // client, no join in flight, no credentials — is a session nobody ever tried to log in,
  // and on this broker that has one overwhelmingly common cause: the name is wrong. A
  // character name where an agent name goes used to mint exactly such a session, and then
  // every call against it reported a connection problem for a naming one, which sends the
  // reader (or a monitoring layer, which is the point of this harness) to restart and
  // rejoin a character that was never unwell. session() in m59-broker.mjs now refuses that
  // name outright; this stays because it is the guard that was LYING, and a session can
  // still reach here unjoined by other routes.
  need() {
    if (!this.live) {
      if (!this.client && !this.joining && !this.credentials)
        throw new Error(`agent "${this.name}" was never joined — this session holds no ` +
                        `credentials and no connection was ever attempted for it. If the ` +
                        `character is in game, the agent name is probably wrong (an agent ` +
                        `name is not the character's name); otherwise join it with an ` +
                        `account and password.`);
      throw new Error(`agent "${this.name}" is not in game — call join first`);
    }
    return this.client;
  }

  snapshot(note) {
    const c = this.client;
    if (!c) return { note, in_game: false };
    const me = c.self;
    return {
      note,
      in_game: true,
      agent: this.name,
      character: c.me?.name,
      object_id: c.selfId,
      room: { id: c.room.id, name: c.rsc.get(c.roomNameRsc) },
      position: me ? { col: me.col, row: me.row, facing_degrees: me.degrees } : null,
      vitals: c.vitals(),
      // WHAT IS ON US, because health alone cannot tell poison from a fight.
      //
      // Poison takes a character to 1 health and then makes it rest to full once the
      // enchantment ends, so a poisoned journey spends minutes standing still through no
      // fault of the route — and from outside it is indistinguishable from a slow road. The
      // keeper has read `ailments()` since BP_ADD_ENCHANTMENT (147) was declared, and the
      // safe-spot book already refuses to discredit a wall for damage taken while poisoned,
      // but nothing put it where a timing could see it. Absent rather than empty when the
      // client cannot answer, so "we did not look" never reads as "nothing was on us".
      ailments: typeof c.ailments === 'function' ? (c.ailments() ?? []) : undefined,
      queued_requests: this.pacer.depth,
    };
  }

  // Everything known about where we are standing, joined into one thing: perception,
  // the room graph, and the walkability geometry the minimap is drawn from. This is
  // the call an agent should make at the start of every turn.
  view(opts = {}) {
    this.need();
    return this.world.snapshot(opts);
  }

  // Raw cached perception for a renderer. Unlike view(), this never runs A* for
  // every object and exit. Keep tactical validation on view(); keep frames fast here.
  perception() {
    this.need();
    return this.world.perception();
  }

  // WHAT IS WORTH WALKING AROUND, AND HOW WIDE A BERTH IT IS WORTH.
  //
  // Every number here is the monster's own, from `monster.kod`:
  //
  //   GetVisionDistance()  4 + viDifficulty/2      (:1676) — "either 4, 5, or 6"
  //   GetAttackRange()     Bound(2 + viDifficulty/6, 2, 3)  (:1682)
  //
  // which leaves a band two to three squares wide where it has noticed you and still
  // has to close. Crossing that band at a run costs nothing; standing in it is a
  // fight. That is the whole case for routing round rather than through.
  //
  // `CanSee` is a plain distance test with no line-of-sight call, so a wall does not
  // hide us and the radius is a disc rather than a cone. Difficulty comes from the
  // spawn index, which cites the kod for each creature; anything we cannot identify
  // gets the top of the published range rather than the bottom, because being wrong
  // toward caution costs a short detour and being wrong the other way costs a fight.
  //
  // Deliberately NOT a hard avoid. A route that only exists through something's reach
  // is still a route, and refusing it would strand characters exactly as the coarse
  // grid does at doorways.
  threatsHere(view = null) {
    const v = view ?? this.view();
    const creatures = loadSpawns(SPAWN_FILE)?.creatures ?? {};
    const out = [];
    for (const o of (v.objects ?? [])) {
      if (o.is_player) continue;
      if (!(Array.isArray(o.can) && o.can.includes('attack'))) continue;
      if (o.row == null || o.col == null) continue;
      const meta = creatures[String(o.name ?? '').toLowerCase()];
      const diff = meta?.difficulty;
      out.push({
        row: o.row, col: o.col, name: o.name,
        // WHERE IN THE SQUARE. Carried through because a square is a summary: two bodies fit
        // side by side inside one, so "there is a monster on that square" and "there is no
        // way past" are different claims and only the fine position can tell them apart.
        // Undefined on a session whose projection predates this, and every consumer must
        // treat that as "square resolution only" rather than as the origin.
        x: o.x, y: o.y,
        vision: diff != null ? 4 + Math.floor(diff / 2) : 6,
        reach:  diff != null ? Math.min(3, Math.max(2, 2 + Math.floor(diff / 6))) : 3,
      });
    }
    return out;
  }

  // Re-read, then view. Perception is pull-only for room contents: the server sends
  // incremental BP_CREATE/BP_MOVE for things it already told you about, but never
  // volunteers a fresh list.
  async refresh(opts = {}) {
    const c = this.need();
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
    return this.view(opts);
  }

  // BP_PLAYER is the only message that NAMES the room, and its name resource is what
  // lets the world model find the room in the graph. It arrives on entering a room,
  // but after an admin teleport or a reconnect the broker can be holding a stale
  // name, so it is worth asking outright.
  async refreshRoomIdentity() {
    const c = this.need();
    const before = c.evSeq;
    await this.pacer.submit('read', () => c.requestPlayer());
    await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 2500 });
  }

  // Turn to face a target. Skipping this is the single most common way for an agent's
  // attacks to vanish: TargetWithinSightAndRange (player.kod:4115) rejects anything
  // behind you at distance > 1, and the refusal message is about view, not range, so
  // it reads like a different problem.
  async faceToward(target, { beforePacket = null } = {}) {
    const c = this.need();
    const me = c.self;
    if (!me || !target) return null;
    const dx = target.col - me.col, dy = target.row - me.row;
    if (dx === 0 && dy === 0) return me.degrees;
    // kod angle 0 is east and increases clockwise as rows grow downward, which is
    // exactly what atan2(dy, dx) gives in screen coordinates.
    const deg = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI)) % 360 + 360) % 360;
    await this.pacer.submit('turn', () => {
      if (typeof beforePacket === 'function') beforePacket('turn');
      return c.face(deg);
    });
    return deg;
  }

  // One paced step, then read back where we ended up. Reading back is not optional:
  // the server never confirms the mover's own move, because Room.SomethingMoved
  // builds the move packet for everyone else in the room and skips the mover.
  // FACE WHERE YOU ARE GOING, AND RUN WHEN IT MATTERS.
  //
  // Neither was being done. Every move went out at speed 18 — USER_WALKING_SPEED
  // exactly — with whatever angle the character happened to be left on, which is a
  // character strolling backwards through a field of groundworms.
  //
  // Running is the right default OUTDOORS and the wrong one indoors: exertion is
  // charged as (speed * 5/6)^2, so it is quadratic, and vigor is what sets the
  // health regeneration rate. Burning it in a town buys nothing; burning it crossing
  // a monster field buys the difference between arriving and not.
  // RUN EVERYWHERE. The previous rule ran only in rooms the spawn index called
  // dangerous, and walked everywhere else — which sounds prudent and is backwards.
  //
  // The spawn index describes where we go to FIGHT. It says nothing about the ground
  // between, and the ground between is where the fleet dies: 20 deaths at the border
  // of the Badlands, 17 of the last 23 travel deaths outbound to a hunting ground.
  // Every one of those was walked at half pace to save a resource that costs 0.18
  // vigor a second — about eleven for a whole minute of sprinting — while a death
  // costs the character its equipment, its position and the rest of the hour.
  //
  // So the gate is affordability, not location. The floor stays at 25 rather than the
  // server's 10 so that arriving somewhere still leaves enough vigor to fight.
  moveSpeed() {
    const c = this.client;
    const vigor = c?.vitals?.()?.vigor?.value ?? 0;
    if (this.walkOnly) return WALK_SPEED;
    if (vigor < RUN_VIGOR_FLOOR) return WALK_SPEED;      // too tired; the server would snap us back
    return RUN_SPEED;
  }

  // STAND UP BEFORE TRYING TO LEAVE THE ROOM.
  //
  // `Player.ResetFlags` (player.kod:1162) sets PFLAG_NO_MOVE, PFLAG_NO_FIGHT and
  // PFLAG_NO_MAGIC together whenever IsResting, and `UserGo` (user.kod:5657) refuses
  // on that flag with "You are unable to go anywhere." — which is 589 of our 700
  // failed hops, and reads in the transit log as the map being shut rather than as
  // the character being sat down.
  //
  // Nothing clears resting by itself, and at least one path sits deliberately: the
  // unarmed branch rests to regain mana and holds it. So the character can be seated
  // for a minute at a time with every exit attempt failing identically.
  //
  // Sent unconditionally rather than guarded on a cached "am I resting" flag, because
  // that flag is exactly the thing that goes stale — the server never announces the
  // rest ending, and a wrong `false` costs a whole journey while a redundant stand
  // costs one packet.
  async standBeforeGo() {
    const c = this.need();
    await this.pacer.submit('rest', () => c.stand());
  }

  // AND CONFIRM WHERE THE SERVER THINKS WE ARE, ONCE, BEFORE CROSSING OUT.
  //
  // `Room.SomethingTryGo` matches the exit against `piRow`/`piCol` — the SERVER's
  // position, not ours — and its refusal is the same "You are unable to go anywhere."
  // that a seated character gets. Two causes, one message, opposite fixes.
  //
  // Walking is dead-reckoned now, deliberately: the server does not echo a mover's own
  // accepted move, so predicting is the only alternative to a 1.2-5.6s round trip per
  // square. That trade is right in the middle of a room and wrong at its edge — cant-go
  // went from 36% to 52% of all crossings when the resync cap shipped, because a
  // predicted square we never actually reached looks exactly like an exit that does not
  // work.
  //
  // So: one read per HOP, not one per square. That is a single round trip against a
  // whole room crossing, which keeps essentially all of the speed and removes the
  // entire class of failure. It also makes a retry meaningful — `approachSquare` is
  // computed from where we are, so re-planning from a predicted position returns the
  // identical answer forever, which is what a character stuck in a doorway loop is
  // actually doing.
  async confirmPosition() {
    const c = this.need();
    this.lastRoomRead = Date.now();
    // There may already be a fire-and-forget room read in flight. Waiting for merely
    // "the next room-contents event" can consume that older snapshot and certify the
    // exact stale position this method was called to correct. The protocol returns
    // these reads in request order, so wait through any older replies until the local
    // ordinal for this request has arrived.
    //
    // A TIMED-OUT READ ANSWERS null, IT DOES NOT THROW. Callers already treat an
    // unknown position as a wrong one — goThrough leans into the doorway in fine units
    // rather than sending a `go` it has no evidence for — and that is the whole design.
    // Throwing here would turn a transient dropped reply into an exception out of the
    // middle of a walk, which is a worse answer than "I do not know where I am".
    const since = c.evSeq;
    const request = await this.pacer.submit('read', () => c.roomContents());
    const t0 = Date.now();
    let cursor = since, fresh = true;
    // BOUNDED IN WALL CLOCK, NOT ONLY PER REPLY. The per-wait timeout below only ends this
    // loop if replies STOP; every reply that arrives for an older request advances `cursor`
    // and sends it round again, so a stream of traffic keeps it spinning while the ordinal
    // it wants never lands. That is not hypothetical — measured on the live fleet, 18 of 21
    // characters sat inside one keeper pass for 300-1090s and CLIMBING, completing zero
    // passes, at ~38% CPU. Low CPU is the tell: they were not computing, they were waiting
    // 2s at a time, for ever. The board said "travelling" throughout and nobody moved.
    const CONFIRM_DEADLINE_MS = 8000;
    while ((c.roomContentsReceived ?? request) < request) {
      if (Date.now() - t0 >= CONFIRM_DEADLINE_MS) { fresh = false; break; }
      const reply = await c.waitFor({ since: cursor, kinds: ['room-contents'], timeoutMs: 2000 });
      if (reply.timedOut) { fresh = false; break; }
      cursor = reply.seq;
    }
    Pacer.note('confirm_position', 'blocked', Date.now() - t0);
    if (!fresh) {
      // RETIRE WHAT WE JUST GAVE UP ON, or this call has poisoned every future one.
      //
      // `request` is an ordinal and the wait above is `received >= request`. Returning null
      // without retiring leaves the requested side one ahead for the rest of the session,
      // so the NEXT confirm asks for a higher ordinal that is also unreachable, and so on
      // forever. Measured: two characters, 1,180 consecutive `position_confirmation_timeout`
      // over four and a half hours, while fresh keepers in the same room confirmed in
      // 345ms. The room was never the problem; this line was.
      const lost = c.retireRoomContents?.(request) ?? 0;
      if (lost) this.log?.(`confirmPosition gave up on ${lost} room-contents reply(ies); ` +
                           `retired them so the next read can succeed`);
      return null;
    }
    return c.self ? { col: c.self.col, row: c.self.row } : null;
  }

  // "I DO NOT KNOW WHERE I AM" IS A QUESTION, NOT A VERDICT.
  //
  // `client.self` is `room.objects.get(selfId)`, so it is undefined whenever our own object
  // is not in the room map — and that is the ORDINARY state for a moment after a room is
  // rebuilt, not a fault. A boundary crossing brings a fresh BP_PLAYER, the client rebuilds
  // the room, and our own id is genuinely absent until the contents land. `step` deliberately
  // does not await that read, because nothing in the NEXT step needs it.
  //
  // So every site that treated the gap as terminal was abandoning a whole journey over a
  // reply that was milliseconds away. Measured on a 21-character run to Castle Victoria,
  // with the routes and the anchors both since proven correct: 47 of 51 hop failures were
  // `own_position_unknown`, 17 of 21 characters ended their journey on one, and NOBODY
  // DIED. The fleet was not killed and was not walled in — it stopped knowing where it was
  // and gave up.
  //
  // THIS RELAXES NO COLLISION, which is the objection to answer before believing it is
  // safe. It re-reads our own COORDINATES, which is the one thing the server is
  // authoritative about for a user — `UserMove` takes whatever we send — and every wall
  // test still runs against the baked geometry exactly as before. A walker that knows where
  // it is enforces the walls BETTER than one that does not; the failure mode being fixed is
  // a walker that gives up, never one that walks through something.
  //
  // Bounded and honest: `confirmPosition` already carries its own 8s deadline and answers
  // null rather than throwing, so a server that has genuinely gone quiet still ends the walk
  // — just with the same verdict as before instead of one taken prematurely.
  // AND THE READ THAT FIXES IT IS RE-IDENTIFY, NOT RE-READ. THIS IS THE WHOLE BUG.
  //
  // The first version of this asked `confirmPosition` — a fresh room-contents read — and it
  // did not help at all, because the thing that was wrong was not the room. `self` is
  // `room.objects.get(selfId)`, and it was `selfId` that had gone bad:
  //
  //   the broker's cached id for shadow01 ... 7454
  //   the server's actual id for Aaaa ....... 7424
  //   and 7424 was IN the room list .......... 7410,7375,7340,7347,7312,7424,3500
  //
  // THE SERVER RENUMBERS OBJECTS WHEN IT GARBAGE-COLLECTS, WHICH IT DOES ON EVERY SAVE, and
  // `[Auto] SavePeriod` here is fifteen minutes. So a save silently invalidates every cached
  // id at once — which is exactly what a whole fleet freezing in the same instant looks
  // like, with the server perfectly healthy and nobody dying. Re-reading the room can never
  // fix that: the new contents are keyed by the NEW id, and we go on asking for the old one.
  //
  // BP_SEND_PLAYER is the cure: the server answers with BP_PLAYER, whose handler assigns
  // `this.selfId = p.id` and then clears and re-requests the room contents. One packet
  // re-establishes who we are.
  //
  // AND IT WAS SENT AS A FREE VARIABLE THAT DOES NOT EXIST IN THIS FILE. The first version
  // of this said "the cure already existed" and wrote `c.send(BP_SEND_PLAYER)`. There is no
  // such binding here — the constants live on `BP` in m59-client.mjs and this module never
  // imports them — so both call sites threw ReferenceError the moment they were reached,
  // and the OTHER one, `refreshRoomIdentity`, had been shipped that way since the initial
  // commit. Measured live on the arena server, 2026-08-20: Aaaa walked Tos -> 586, the
  // server had renumbered it 7420 -> 7400, `look` reported "not present in room contents
  // yet" for four minutes, and the journey ended in `own_position_unknown` with the
  // recovery path unable to send its packet. It is `c.requestPlayer()` now, because a
  // method that does not exist fails at load and a free variable fails only when the world
  // has already gone wrong — which is exactly when a recovery path runs.
  //
  // Order matters. Re-identify FIRST, then refresh the room — the reverse repopulates the
  // object map and then looks up the stale key in it, which is the failure this replaces.
  async selfOrResync({ tries = 2 } = {}) {
    const c = this.need();
    if (c.self) return c.self;
    for (let i = 0; i < tries && !c.self; i++) {
      await this.pacer.submit('read', () => c.requestPlayer());
      // Polled rather than waited on an event kind, because the useful signal is the
      // FIELD appearing and a bounded poll cannot starve on a reply that never comes.
      // BP_PLAYER's own handler re-requests the contents, so what this waits for is the
      // new id and the list that carries it, not just the id.
      for (let w = 0; w < 20 && !c.self; w++)
        await new Promise(r => setTimeout(r, 100));
      if (c.self) break;
      // A new id still needs a room map that contains it.
      await this.confirmPosition();
    }
    return c.self ?? null;
  }

  // COORDINATE CONTRACT: `(x,y)` is a fine point in 64-units-per-square kod wire space.
  // A FALL IS PLANNED IN FALL MODE AND MUST BE ATTEMPTED IN FALL MODE — see `fall` below.
  validateFineTarget(x, y, { slide = false, fall = false } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me = c.self;
    if (!me) return { available: false, moved: false, blocked: true,
                      reason: 'own_position_unknown' };
    if (!geo?.traceFineMoveClient) return {
      available: false, moved: false, blocked: true,
      reason: 'collision_geometry_unavailable',
      note: 'this room has no locally validated BSP collision geometry',
    };
    // BOUNDED, AND THE BOUND IS THE WHOLE FIX. This refusal is correct while a sector or
    // wall program is in flight — the stock client mutates its BSP on those packets and we
    // cannot. It was NOT correct for ever: the flag is cleared only by BP_PLAYER, which
    // arrives on a room change, and changing rooms needs the movement this refuses. Any
    // room that animates became a cage, and three characters were in one inside ten
    // minutes. `until` is stamped by the client; a legacy record without one still blocks,
    // which is the safe reading of "we do not know when this ends".
    //
    // Pure on purpose: m59-collision-test lifts this method out by text, so this may use
    // nothing but `this`, the injected dependencies and built-ins.
    // AND SCOPED TO THE SECTOR THAT MOVED, WHICH IS THE SECOND HALF OF THE SAME FIX.
    //
    // Bounding the refusal in TIME stopped a room being a permanent cage only while the
    // animation is rare. The Temple of Qor door in room 598 cycles faster than the 8s
    // window, so every packet re-armed the block and the bound never expired: reproduced
    // with the character claimed so nothing else could steer it, six attempts across
    // seventy seconds, never moved one square. The operator had already named that room as
    // THE exception to "the geometry does not change day to day".
    //
    // The refusal was always wider than its own justification. This file's note says it:
    // after the animation "the walls are still where the bake says — only sector HEIGHTS
    // can have shifted". One sector moved; the rest of the room is exactly as baked. So
    // refuse a move that STARTS OR ENDS in that sector, and let the rest of the room walk.
    //
    // `sector` absent means we could not tell which — a short packet, or a wall program
    // rather than a sector one — and that reads as "we do not know", so the whole room is
    // still refused. Same safe reading `until == null` already gets.
    const invalidated = c.room.collisionInvalidated;
    if (invalidated && (invalidated.until == null || Date.now() < invalidated.until)) {
      let touches = true;
      if (Number.isInteger(invalidated.sector) && typeof geo.leafAtClient === 'function') {
        const scale0 = CLIENT_FINENESS / KOD_FINENESS;
        const wx = Number.isFinite(me.x) ? me.x : me.col * KOD_FINENESS + (KOD_FINENESS >> 1);
        const wy = Number.isFinite(me.y) ? me.y : me.row * KOD_FINENESS + (KOD_FINENESS >> 1);
        const inSector = (cx, cy) => {
          const leaf = geo.leafAtClient(cx, cy);
          return leaf != null && leaf.sectorNum === invalidated.sector;
        };
        touches = inSector((wx - KOD_FINENESS) * scale0, (wy - KOD_FINENESS) * scale0)
               || inSector((x - KOD_FINENESS) * scale0, (y - KOD_FINENESS) * scale0);
      }
      // A ROOM WE HAVE DECLARED TO BE PERMANENTLY IN MOTION DOES NOT GET TO CAGE US.
      //
      // Everywhere else, a record that does not name its sector reads as "we do not know
      // which part moved, so refuse the whole room" — the safe reading, and the right one
      // when a room is not supposed to change at all. In the Cragged Mountains, the Arena
      // of Kraanan, Castle Brax and North Barloque it is not caution, it is a cage: those
      // rooms are ALWAYS animating, so the unnarrowed record is permanent and the character
      // can never leave. See m59-mutable.mjs for the list and for the failure direction.
      //
      // Only the UNNARROWED case is relaxed. When the packet names its sector the ordinary
      // narrowing still applies and still refuses a move that really does cross the part
      // that moved, in these rooms exactly as in every other — which is the whole of "do
      // not care about the change unless you are travelling through it".
      if (touches && !Number.isInteger(invalidated.sector) && isMutableGeometry(c.room.id)) {
        touches = false;
      }
      if (touches) return {
        available: false, moved: false, blocked: true,
        reason: 'collision_geometry_changed',
        // THE EVIDENCE, NOT JUST THE REFUSAL. This block has already been narrowed once —
        // the Temple of Qor door in 598 cycles faster than the 8s window, so an
        // unnarrowed record caged anything standing in the Cragged Mountains. It is
        // firing again on the Tos -> Castle Victoria road, seven refusals in thirty-five
        // seconds, and from outside the process there is no way to tell WHICH of the two
        // reasons applies: the moving sector really is on our path, or the packet arrived
        // short so `sector` is null and the whole room is being refused again. Those want
        // opposite fixes, so the refusal now says which.
        animation: {
          sector: Number.isInteger(invalidated.sector) ? invalidated.sector : null,
          narrowed: Number.isInteger(invalidated.sector) && typeof geo.leafAtClient === 'function',
          kind: invalidated.kind ?? null,
          // How long this record still has to run, so a caller can tell "it will clear in
          // 200ms" from "this has been re-armed continuously for a minute".
          expires_in_ms: invalidated.until == null ? null : Math.max(0, invalidated.until - Date.now()),
          armed_ms_ago: invalidated.at ? Date.now() - invalidated.at : null,
        },
        note: `${invalidated.kind} changed live room geometry` +
              (Number.isInteger(invalidated.sector) ? ` in sector ${invalidated.sector}` : '') +
              '; movement is fail-closed until that animation finishes or the room is re-entered',
      };
    }
    const roomSecurity = c.room.security;
    if (!Number.isInteger(roomSecurity) || !Number.isInteger(geo.security)) return {
      available: false, moved: false, blocked: true, reason: 'room_security_unknown',
      note: 'cannot bind baked collision geometry to the room version announced by the server',
    };
    // PURE, AND IT HAS TO STAY PURE. m59-collision-test.mjs lifts this method out of this
    // file by text and evals it, because the broker cannot be imported without taking the
    // fleet lock — so anything this function CALLS must also exist in that scope. The
    // evidence for the drift record is returned instead, and the caller writes it down.
    if ((roomSecurity & 0x0fffffff) !== (geo.security & 0x0fffffff)) {
      // In the keeper process, the baked .roo may be stale relative
      // to the server's room version. The geometry is still usable
      // for collision — the mismatch means the .roo needs re-baking,
      // not that movement should be blocked. Log the drift and
      // proceed with the available geometry.
      if (process.env.M59_KEEPER) {
        if (process.env.M59_DEBUG_DRIFT)
          console.error(`[drift] ${this.name ?? '?'} room geometry mismatch: live=${roomSecurity >>> 0} baked=${geo.security >>> 0}`);
        // Fall through and use the geometry anyway
      } else {
        return { available: false, moved: false, blocked: true, reason: 'room_geometry_mismatch',
                 drift: { room: c.room.id, live: roomSecurity >>> 0, baked: geo.security >>> 0 },
                 note: 'the server announced a different .roo security value; refresh collision geometry' };
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || x > 0xffff || y < 0 || y > 0xffff) return {
      available: false, moved: false, blocked: true, reason: 'invalid_move_target',
    };
    const scale = CLIENT_FINENESS / KOD_FINENESS;
    // Wire coordinates carry a +64 bias. The official client's ExtractCoordinates
    // subtracts it before entering 0-based 1024-unit BSP space, and RequestMove adds
    // it back. Keeping raw wire coordinates elsewhere is intentional; convert only
    // at this collision boundary.
    const toClient = value => (value - KOD_FINENESS) * scale;
    const toProtocol = (value, fromValue) => {
      const wire = value / scale + KOD_FINENESS;
      if (value > fromValue) return Math.floor(wire + 1e-9);
      if (value < fromValue) return Math.ceil(wire - 1e-9);
      return Math.round(wire);
    };
    const fromWireX = Number.isFinite(me.x) ? me.x : me.col * KOD_FINENESS + (KOD_FINENESS >> 1);
    const fromWireY = Number.isFinite(me.y) ? me.y : me.row * KOD_FINENESS + (KOD_FINENESS >> 1);
    const fromX = toClient(fromWireX), fromY = toClient(fromWireY);
    const obstacles = [...c.room.objects.values()]
      .filter(object => object.id !== c.selfId && blocksMovement(object.flags ?? 0)
        && Number.isFinite(object.x) && Number.isFinite(object.y))
      .map(object => ({ id: object.id, x: toClient(object.x), y: toClient(object.y) }));
    const vertical = this.collisionVertical;
    const now = Date.now();
    const motionZ = vertical?.roomId === c.room.id && vertical.settleAt > now
      && Number.isFinite(vertical.min) && Number.isFinite(vertical.max)
      ? { min: vertical.min, max: vertical.max }
      : null;
    if (vertical && (!motionZ || vertical.roomId !== c.room.id)) this.collisionVertical = null;
    // THE ROUTER PROVES A FALL WITH ONE PREDICATE AND THE MOVER ATTEMPTED IT WITH ANOTHER.
    // THAT IS THE WHOLE OF THE MOUNTAIN ROOMS.
    //
    // `fallTargets` offers a two-or-three square drop only after proving it:
    // `traceFineMoveClient(from, to, { slide: false, fall: true })` must ARRIVE. The mover
    // then sent the same two squares WITHOUT the flag, and the walk-mode trace refuses it —
    // measured in room 578, the step 45,16 -> 43,16 that begins every failing crossing:
    //
    //     { slide: false, fall: true }   arrived
    //     { slide: false }               blocked by wall 669
    //     { slide: true }                blocked by wall 669, slid sideways
    //
    // So the router planned a ledge the mover could not leave, the body slid along the
    // cliff instead, and the walker replanned into the same ledge. Every room on the
    // Castle Victoria road that crosses at exactly the theoretical minimum has ZERO jumps
    // in its plan; every room that fails has them, and the first deviation is always the
    // first jump. This is the repository's own rule — the router must plan on the map the
    // mover enforces — broken for exactly one kind of step.
    const traceOptions = {
      slide, fall, obstacles,
      roomFlags: c.room.flags ?? 0,
      overrideDepths: c.room.overrideDepths ?? null,
      motionZ,
    };
    let requestedTrace = geo.traceFineMoveClient(fromX, fromY, toClient(x), toClient(y), traceOptions);

    // A TRACE FROM NOWHERE ANSWERS NOTHING, AND REFUSING ON IT IS A CAGE.
    //
    // `traceFineMoveClient` tests the leaf under the ORIGIN before it tests a single wall,
    // and answers `start_has_no_floor` when there is none. That refusal is about where we
    // ARE, not about where we are going — so it is identical for every heading, and the
    // fan in `walkFine` tries nine of them, at four reaches, and gets it thirty-six times.
    // Measured offline against room 587's real geometry: from the centre of square 2,4 the
    // walk to the west exit fails with `blocked — every heading refused` having sent
    // ZERO PACKETS, while from three of the surrounding squares — and from the parts of
    // 2,4 that do have floor, 21 of 64 points sampled — the identical call arrives in
    // three or four packets. A character whose position reads as such a point cannot move
    // by any path this file owns: `walkTo`'s off-grid recovery routes through here too,
    // which is why it reports `could not step back onto solid ground`.
    //
    // The server has no opinion about any of this. It does not validate player movement at
    // all — `ReqSomethingMoved` is bypassed for users — so the only thing holding the
    // character still is our own check, applied from an origin the check itself calls
    // invalid. That is the definition of failing closed on no information.
    //
    // SO: WHEN THE ORIGIN HAS NO FLOOR, THE DESTINATION DECIDES. Narrowly, and every
    // clause is load-bearing:
    //
    //   * only for `start_has_no_floor` — a wall between here and there is still a wall,
    //     and every other refusal is about the journey rather than the origin;
    //   * the destination must itself be standable, checked by the same BSP that just
    //     refused, so this can only ever move a character ONTO valid floor;
    //   * at most one square, so it is a recovery step and not a licence to cross a room;
    //   * and it is reported as `recovered_from_no_floor`, because a move nothing
    //     validated must be visible to whatever reads the result.
    //
    // This cannot widen what the fleet may traverse: the reachable set is unchanged for
    // every character standing anywhere the trace can start from. It only restores the
    // ability to leave a square the model cannot reason about — which the game plainly
    // allows, because a person walks off those squares without noticing they exist.
    let recovered = null;
    // The recovery radius is 3 cells (3×KOD_FINENESS) rather than 1, because
    // some rooms (e.g. the Twisted Wood, room 587) have coarse-grid pockets
    // where the character's position and several surrounding cells are all
    // marked unwalkable, but the server allows the character to stand there.
    // The nearest walkable square can be 2-3 cells away.
    const NO_FLOOR_RECOVERY_RADIUS = 3 * KOD_FINENESS;
    if (requestedTrace.reason === 'start_has_no_floor'
        && Math.abs(x - fromWireX) <= NO_FLOOR_RECOVERY_RADIUS
        && Math.abs(y - fromWireY) <= NO_FLOOR_RECOVERY_RADIUS
        && geo.leafAtClient(toClient(x), toClient(y))) {
      recovered = { from: { x: fromWireX, y: fromWireY } };
      requestedTrace = { available: true, moved: true, arrived: true, blocked: false,
                         slid: false, x: toClient(x), y: toClient(y),
                         reason: 'recovered_from_no_floor' };
    }
    if (!requestedTrace.available) return requestedTrace;
    if (!requestedTrace.moved) return requestedTrace;

    // Protocol coordinates are integer KOD units. Quantize toward the starting point,
    // then require that exact integer endpoint to be reachable. A trace can clip at a
    // leaf/headroom edge as well as a wall; wall-radius padding alone is not enough.
    let quantizedX = toProtocol(requestedTrace.x, fromX);
    let quantizedY = toProtocol(requestedTrace.y, fromY);
    let trace = null;
    // THE QUANTIZER RE-TRACES FROM THE SAME ORIGIN, so a recovery has to carry through it
    // or it is undone one line later — the loop below would ask the identical question,
    // get `start_has_no_floor` again, and refuse. The endpoint is already an exact integer
    // wire coordinate (it is the caller's own target, checked for floor above), so there
    // is nothing left for the quantizer to converge on.
    if (recovered) {
      quantizedX = Math.round(x); quantizedY = Math.round(y);
      trace = { ...requestedTrace, arrived: true };
    }
    for (let attempt = 0; !recovered && attempt < 8; attempt++) {
      trace = geo.traceFineMoveClient(fromX, fromY, toClient(quantizedX), toClient(quantizedY),
        traceOptions);
      if (!trace.available) return trace;
      if (trace.arrived) break;
      if (!trace.moved) return trace;
      const nextX = toProtocol(trace.x, fromX), nextY = toProtocol(trace.y, fromY);
      if (nextX === quantizedX && nextY === quantizedY) return {
        ...trace, moved: false, reason: trace.reason ?? 'geometry_blocked',
        note: 'no collision-safe integer protocol endpoint was available',
      };
      quantizedX = nextX; quantizedY = nextY;
    }
    if (!trace?.arrived) return { ...trace, moved: false,
      reason: trace?.reason ?? 'geometry_blocked',
      note: 'collision-safe protocol quantization did not converge' };
    if (!Number.isInteger(quantizedX) || !Number.isInteger(quantizedY)
        || quantizedX < 0 || quantizedX > 0xffff || quantizedY < 0 || quantizedY > 0xffff)
      return { available: false, moved: false, blocked: true, reason: 'invalid_move_target' };
    return {
      ...trace,
      target: { x: quantizedX, y: quantizedY },
      requested: { x: Math.round(x), y: Math.round(y) },
      // The verifier must replay the same geometry question the sender answered. These
      // options are live packet-bound evidence (moving objects, room flags and vertical
      // state), not defaults that can be reconstructed honestly after the run.
      trace_options: traceOptions,
      blocked: requestedTrace.blocked || trace.blocked,
      slid: requestedTrace.slid || trace.slid,
      reason: trace.reason ?? requestedTrace.reason,
    };
  }

  // OUTSIDE queueValidatedMove ON PURPOSE. The collision suite lifts that queue method out
  // of this module as source text; a module-scope tracer call inside it becomes an undefined
  // free identifier in the isolated test. The queue therefore calls this instance method,
  // while this non-lifted boundary owns the import and the schema.
  //
  // This is invoked only AFTER M59Client.moveTo returns from its synchronous socket write.
  // If moveTo throws, no `sent:true` row is emitted. Conversely, a diagnostic failure after
  // a successful send must never make the queue claim the packet was refused.
  recordValidatedWireMove({ client, roomId, from, requested, to, speed,
                            slide = false, fall = false, offMap = false, validation }) {
    try {
      traceWireMove({
        agent: this.name,
        roomNum: this.world?.room?.num ?? null,
        roomId,
        liveSecurity: client?.room?.security ?? null,
        bakedSecurity: this.world?.geometry?.security ?? null,
        from,
        requested,
        to,
        speed,
        slide,
        fall,
        offMap,
        traceOptions: offMap ? null : validation?.trace_options ?? null,
        validation,
      });
    } catch {
      // A trace is evidence, never movement authority. The packet is already on the socket;
      // throwing here would falsely report it as unsent and could cause a duplicate retry.
    }
  }

  // The keeper and explicit exit fallback deliberately bypass sender geometry. They are
  // still real synchronous socket writes, so omitting them would make an unsafe capture
  // look like a complete validated proof. This separate boundary makes it impossible for
  // either path to accidentally inherit the validated row shape above.
  recordUnsafeWireMove({ client, roomId, from, requested, to, speed,
                         offMap = false, unsafeReason, priorValidation = null }) {
    try {
      traceUnsafeWireMove({
        agent: this.name,
        roomNum: this.world?.room?.num ?? null,
        roomId,
        liveSecurity: client?.room?.security ?? null,
        bakedSecurity: this.world?.geometry?.security ?? null,
        from,
        requested,
        to,
        speed,
        slide: false,
        fall: false,
        offMap,
        unsafeReason,
        priorValidation,
      });
    } catch {
      // The packet has already left. A trace failure cannot turn it into an unsent move or
      // cause the caller to retry a deliberately unvalidated packet.
    }
  }

  // COORDINATE CONTRACT: `(x,y)` is a fine point in kod wire units, not a grid tuple.
  async queueValidatedMove(x, y, { speed = 18, slide = true, fall = false, beforeMutation = null,
                                    minGap = MOVE_INTERVAL_MS, expectedRoomId = null,
                                    offMap = false } = {}) {
    const c = this.need();
    const roomId = expectedRoomId ?? c.room.id;
    if (c.room.id !== roomId) return { sent: false, validation: {
      available: false, moved: false, blocked: true, reason: 'room_changed_before_move',
    } };

    // OFF THE MAP IS A LEGAL DESTINATION, AND IT STILL NEEDS AN ATOMIC LOCAL PROOF.
    //
    // One move in the whole client deliberately targets a square that does not exist:
    // the outward step past a room boundary, which is the ONLY thing that reaches
    // `Room.SomethingMoved`'s `new_col < 1` branch and therefore the only thing that
    // triggers StandardLeaveDir (room.kod:2232-2258). `RoomGeometry` explicitly models
    // those minimum outside coordinates: a baked edge candidate exists only when its
    // inside-to-outside, no-slide trace arrives.
    //
    // `UserMove` BYPASSES
    // `ReqSomethingMoved` for users — room.kod's own comment is "already been checked by
    // client (HAHA!)" — so the proof is repeated synchronously from the live position
    // inside the paced callback. Proximity to a candidate is only a precondition; the exact
    // packet must also arrive through BSP geometry with no slide before it can be sent.
    //
    // It is opt-in per call and used by the ordinary edge path. The explicitly unvalidated
    // diagnostic fallback is separate and disabled by default. NO BREADCRUMB IS RECORDED:
    // the escape logic replays crumbs in reverse and its whole safety argument is that every
    // crumb was a move the validator accepted, so a crumb pointing off the map would let it
    // "undo" its way through a wall.
    if (offMap) {
      const target = { x: Math.round(x), y: Math.round(y) };
      return this.pacer.submit('move', () => {
        if (c.room.id !== roomId) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'room_changed_before_move' } };
        const observed = c.self;
        if (!observed) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'own position unknown' } };
        if (typeof beforeMutation === 'function') beforeMutation('move', { x, y });
        // The hook records mutation authority and may synchronously change session state.
        // Re-read both the room and position after it; no callback or await occurs between
        // the proof below and `moveTo`.
        if (c.room.id !== roomId) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'room_changed_before_move' } };
        const before = c.self
          ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row }
          : null;
        if (!before) return { sent: false, validation: {
          available: false, moved: false, blocked: true, reason: 'own position unknown' } };
        // This is the authority check, not merely a caller preflight. Pacing can delay the
        // callback while combat or dead reckoning changes `c.self`; approving the earlier
        // position and sending from the later one would reopen the wall bypass this guard
        // exists to close.
        if (typeof offMap !== 'object'
            || !atEdgeOpening(before, offMap.opening, offMap.direction))
          return { sent: false, validation: {
            available: false, moved: false, blocked: true, reason: 'not_at_edge_opening',
            note: 'the live send position is not at the BSP-proved boundary opening',
          } };
        // Prove the ACTUAL packet from the ACTUAL live origin. The baked candidate proves
        // opening -> outside, but a diagonally offset body could otherwise cut a corner on
        // its way there. `slide:false` must reach this exact integer endpoint; clipped,
        // recovered-from-no-floor, or merely-near results are not movement authority.
        const validation = this.validateFineTarget(target.x, target.y,
          { slide: false, fall: false });
        if (validation?.drift) noteGeometryDrift(this, validation.drift);
        const exact = validation?.target?.x === target.x && validation?.target?.y === target.y;
        if (!validation?.available || !validation?.moved || !validation?.arrived
            || validation?.blocked || validation?.reason === 'recovered_from_no_floor' || !exact)
          return { sent: false, validation: {
            ...validation, moved: false, blocked: true,
            reason: validation?.reason ?? 'off_map_path_unproved',
            note: validation?.note ??
              'the complete live path through the baked opening did not validate exactly',
          } };
        const sentValidation = { ...validation, available: true, moved: true, blocked: false,
                                 offMap: true, target };
        const eventSeq = c.evSeq;
        c.moveTo(target.x, target.y, speed, roomId);
        this.recordValidatedWireMove?.({
          client: c, roomId,
          from: { x: before.x, y: before.y },
          requested: target,
          to: target,
          speed,
          slide: false,
          fall: false,
          offMap: true,
          validation: sentValidation,
        });
        return { sent: true, roomId, eventSeq, before, target,
                 validation: sentValidation };
      }, minGap);
    }

    const initial = this.validateFineTarget(x, y, { slide, fall });
    // WRITE DOWN THAT PROD MOVED. Otherwise a drifted room is only ever visible as a move
    // that did not happen — and the baked map is evidence about somebody else's server,
    // which can be patched without telling us.
    if (initial?.drift) noteGeometryDrift(this, initial.drift);
    if (!initial.available || !initial.moved || !initial.target)
      return { sent: false, validation: initial };
    return this.pacer.submit('move', () => {
      // Pacing can delay this callback while an asynchronous room entry, teleport,
      // or older room read changes the world beneath it. Bind the packet to the room
      // it was requested in and recompute from the live start immediately before send.
      if (c.room.id !== roomId) return { sent: false, validation: {
        available: false, moved: false, blocked: true, reason: 'room_changed_before_move',
      } };
      const validation = this.validateFineTarget(x, y, { slide, fall });
      if (validation?.drift) noteGeometryDrift(this, validation.drift);
      const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
      if (!validation.available || !validation.moved || !validation.target || !before)
        return { sent: false, validation };
      if (validation.target.x === before.x && validation.target.y === before.y)
        return { sent: false, validation: { ...validation, moved: false } };
      if (typeof beforeMutation === 'function') beforeMutation('move', { x, y });
      const eventSeq = c.evSeq;
      // BREADCRUMBS — the only record of how this character got where it is standing.
      //
      // A safe spot IS the coarse grid and the BSP disagreeing, which is what makes it
      // safe and what the fleet seeks out. Since the router plans on the collision view,
      // a character parked in such a pocket cannot plan a route out of it: room 587 is 68
      // regions and both exits are in region 0, and there are 17,402 such pockets
      // world-wide. It tries, is refused, replans, forever, and the board says
      // `travelling` while it twitches in a corner.
      //
      // Every crumb here is a move the fine validator ACCEPTED, immediately before it was
      // sent. Replaying them in reverse therefore cannot invent an impossible traversal —
      // it can only undo one. That is the whole safety argument for the escape, and it is
      // why the escape is breadcrumbs rather than a coarse-grid fallback: falling back to
      // the server's grid would relax collision precisely where the two views disagree
      // most, which is the mechanism that let bots climb cliffs no client can.
      //
      // Recorded here rather than in `step`, because this is the one choke point every
      // move in this file passes through, and it is the only place that knows both the
      // position the packet left from and the clipped endpoint it actually asked for.
      const crumbs = (this.breadcrumbs ??= []);
      const last = crumbs[crumbs.length - 1];
      if (!last || last.roomId !== roomId || last.to.x !== before.x || last.to.y !== before.y)
        crumbs.length = 0;             // a teleport, a room change, or somebody else moved us
      crumbs.push({ roomId, at: Date.now(),
                    from: { x: before.x, y: before.y },
                    to: { x: validation.target.x, y: validation.target.y } });
      if (crumbs.length > 64) crumbs.shift();
      c.moveTo(validation.target.x, validation.target.y, speed, roomId);
      this.recordValidatedWireMove?.({
        client: c, roomId,
        from: { x: before.x, y: before.y },
        requested: validation.requested,
        to: validation.target,
        speed,
        slide,
        fall,
        offMap: false,
        validation,
      });
      const destinationFloor = validation.destinationFloor;
      if (Number.isFinite(destinationFloor)) {
        const commandZ = validation.motionZ;
        const startMin = Number.isFinite(commandZ?.min) ? commandZ.min
          : Number.isFinite(commandZ) ? commandZ : destinationFloor;
        const startMax = Number.isFinite(commandZ?.max) ? commandZ.max
          : Number.isFinite(commandZ) ? commandZ : destinationFloor;
        const min = Math.min(startMin, startMax, destinationFloor);
        const max = Math.max(startMin, startMax, destinationFloor);
        if (max - min > 1e-6) {
          const existing = this.collisionVertical;
          const now = Date.now();
          const active = existing?.roomId === roomId && existing.settleAt > now;
          const combinedMin = active ? Math.min(existing.min, min) : min;
          const combinedMax = active ? Math.max(existing.max, max) : max;
          const floorChanged = !active || existing.lastFloor !== destinationFloor;
          if (floorChanged || min < existing.min || max > existing.max) {
            // A normal client animates this transition between input commands. The
            // headless protocol has no z updates, so retain the entire possible range
            // for a conservative settling window instead of guessing a single height.
            const settleMs = Math.min(5000,
              500 + Math.ceil((combinedMax - combinedMin) / CLIENT_FINENESS * 1500));
            this.collisionVertical = { roomId, min: combinedMin, max: combinedMax,
              lastFloor: destinationFloor, settleAt: now + settleMs };
          }
        } else this.collisionVertical = null;
      }
      return { sent: true, roomId, eventSeq, before, target: validation.target, validation };
    }, minGap);
  }

  // ONE SQUARE, AND NOT A ROOM RE-READ TO GO WITH IT.
  //
  // This used to end with a full `roomContents()` request and a wait for the reply, ONCE
  // PER SQUARE. That round trip measures 1.2 to 5.6 seconds — and it measures the same
  // whether the room holds two objects or fifteen, so it is latency and queueing, not
  // payload. It was the entire reason the fleet walked at 0.55 squares a second while the
  // operator, measured in the same room on the same evening, sustained 4.1.
  //
  // MOVE_INTERVAL_MS was tuned to 250ms — four squares a second — with a long comment
  // about how walking at one square a second was costing us characters. It never took
  // effect. It was never the binding constraint; this was.
  //
  // WHY DEAD RECKONING IS SAFE HERE, which is the part that has to be right:
  //
  //   * the server does not echo a user's own accepted move. Measured, not assumed: a
  //     six-square walk produced ONE self `moved` event. So there is no cheap confirmation
  //     to swap the re-read for — the choice is the re-read or prediction.
  //   * and there is nothing to confirm. `UserMove` calls `Room.SomethingMoved` directly
  //     and `ReqSomethingMoved` is BYPASSED for users — room.kod's own comment on that is
  //     "already been checked by client (HAHA!)". There is no geometry, distance or
  //     occupancy validation on a user move at all (docs/m59-coordination-research.md,
  //     user.kod:2941-2971). The one thing that snaps you back is speed above walking pace
  //     with vigor under the run threshold, and moveSpeed() already guards that.
  //
  // So the client is authoritative for its own movement, exactly as the real one is, and
  // predicting the position is not a guess about the server — it is the same thing the
  // server is about to do. The resync below is a correction for the things prediction
  // cannot cover: everything ELSE in the room moving, which is what the object map is for.
  //
  // `confirm: true` forces the read anyway, for the one caller that genuinely needs to
  // know whether a step happened rather than where we now are.
  // WALK INTO THE SQUARE, NOT AT ITS STAND POINT.
  //
  // THIS IS THE TWO-SQUARE BOUNCE, AND IT IS THE LAST OF IT. `moverStepLands` decides what
  // to PLAN by tracing stand point to stand point, and after the first slide the body is
  // never on a stand point again — so every step after that is being attempted from a
  // position the router never asked about. The straight line from where we actually are to
  // the next square's stand point clips the wall the plan was threading, slides, and lands
  // somewhere else; the walker replans from there and is sent straight back.
  //
  // Reproduced offline against the real baked geometry, room 598 from 23,17: the plan says
  // south to 24,17, the mover lands in 23,16; from 23,16 the plan says east to 23,17 and it
  // lands back at 23,17. Both moves report `geometry_blocked`. Live at the same time, a
  // character oscillated between col 8 rows 17-19 for twenty-two seconds and reported
  // "kept ending up somewhere other than the planned square" with `routed_around: []` —
  // nothing was in the way, the aim was.
  //
  // So when the stand point cannot be reached from HERE, ask the square for somewhere that
  // can. A person walking through a doorway does not aim at the middle of the far tile; it
  // aims into the tile. Nine sample points, tried nearest-to-the-stand-point first, each
  // proved by the same trace the mover enforces with SLIDING OFF — `arrived` means the
  // whole line is clear, so this cannot authorise a traversal the mover would refuse.
  //
  // Bounded and lazy: nothing runs at all unless the naive aim already fails, which is
  // 1406 of 1705 squares unchanged in the Western border of the Twisted Wood. The cost when
  // it does run is at most nine BSP traces — the same call `validateFineTarget` makes once
  // per step — against a replan, a re-plan and another packet, which is what it replaces.
  /**
   * WHAT IS STANDING IN THIS SQUARE, IN FINE UNITS.
   *
   * Read from `c.room.objects` rather than `world.objects()` for the reason `measureLineGap`
   * already documents: the projection does not carry `flags`, so `blocksMovement(o.flags ?? 0)`
   * asks MOVEON of zero — which is "walk through" — and quietly empties the list. The raw
   * store is also where `x`/`y` live, which is the whole point here.
   *
   * BLOCKERS ONLY, by the server's own MOVEON bits: a corpse the server marks walk-through
   * is not something to squeeze past, and the operator is explicit that dead bodies do not
   * block. Same predicate `queueValidatedMove` enforces, so the aim and the mover agree.
   *
   * Returns [] when nothing is there, when the session has no room, or when the objects
   * carry no fine position — and an empty list means "aim exactly as you always did".
   */
  // COORDINATE CONTRACT: positional grid arguments follow geometry order `(row,col)`.
  bodiesInSquare(row, col, spread = 0) {
    const c = this.client;
    if (!c?.room?.objects) return [];
    const out = [];
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
      if (!blocksMovement(o.flags ?? 0)) continue;
      // `spread` widens this to the neighbouring squares, which is what the LINE test needs:
      // a step spans two squares, and a body sitting just inside the one we are leaving is on
      // the way even though it is not on the square we are entering.
      if (Math.abs(o.col - col) > spread || Math.abs(o.row - row) > spread) continue;
      out.push({ x: o.x, y: o.y, id: o.id, col: o.col, row: o.row });
    }
    return out;
  }

  // COORDINATE CONTRACT: the square is `(row,col)`; `from` and the returned aim
  // carry named `{x,y}` values in kod wire units.
  // THE LANE, in wire units: where `aimInto` should aim inside a square when the floor there
  // is a corridor — see keepRightAim. Null on wide floor, when the geometry cannot be asked,
  // or when the corridor is too narrow to shift in (the stand point is then the only lane).
  keepRightLane(from, home) {
    if (KEEP_RIGHT_OFF) return null;
    const geo = this.world?.geometry;
    if (!geo?.floorBaseAtClient || !from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) return null;
    const hasFloor = (x, y) => { try {
      return Number.isFinite(geo.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
    } catch { return false; } };
    try {
      const lane = keepRightAim({ fromX: from.x, fromY: from.y, toX: home.x, toY: home.y, hasFloor });
      if (!lane?.corridor || !(lane.offset > 0)) return null;
      return { x: Math.round(lane.x), y: Math.round(lane.y), lane: 'right',
               width: lane.width, offset: lane.offset };
    } catch { return null; }
  }
  // Counted per session and written to the tactics ledger ONCE PER ROOM, so a tour says which
  // corridors were laned without a row per step.
  noteLane(aim, row, col) {
    const room = Number(this.world?.room?.num ?? 0);
    this.laneStats ??= { aims: 0, rooms: new Set() };
    this.laneStats.aims++;
    if (!this.laneStats.rooms.has(room)) {
      this.laneStats.rooms.add(room);
      try {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room,
                       tactic: 'keep_right', trigger: 'corridor', worked: true, ms: 0, hp_lost: 0,
                       attempted: true,
                       note: `first lane in this room at ${row},${col}: corridor ${aim.width} wide, ` +
                             `aiming ${aim.offset.toFixed(1)} right of the stand point` });
      } catch { /* evidence, not a dependency */ }
    }
    return aim;
  }
  aimInto(from, row, col) {
    const geo = this.world?.geometry;
    const half = KOD_FINENESS >> 1;
    const home = geo?.standPointWire?.(row, col)
              ?? { x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half };
    if (!from || !geo?.traceFineMoveClient || !Number.isFinite(from.x)) return home;

    const fx = protocolToClient(from.x), fy = protocolToClient(from.y);
    const wallOk = (ax, ay, bx, by) => {
      try {
        return geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                       protocolToClient(bx), protocolToClient(by),
                                       { slide: false }).arrived === true;
      } catch { return false; }
    };
    // `arrived` with sliding OFF is the strict question: did the whole line stay clear.
    // WALLS AND BODIES ARE TWO DIFFERENT COLLISIONS AND BOTH HAVE TO BE ASKED.
    //
    // `traceFineMoveClient` is the .roo — walls, ledges, slopes — and the mover's own note
    // says what it leaves out: "a body in the way is the one collision that is not in the
    // .roo". Validating only the walls is what made the first version of this threading fail
    // in front of the operator: it picked an aim on the clear side of a spider and then drove
    // a line straight through the spider to get there.
    //
    // `spread: 1` because a step spans two squares — something sitting just inside the square
    // being LEFT is on the way out of it, and asking only about the destination square misses
    // exactly the body a walker is trying to edge around.
    const lineBodies = typeof this.bodiesInSquare === 'function'
      ? this.bodiesInSquare(row, col, 1) : [];
    //
    // AND THE BODY HALF IS THE CLIENT'S OWN RESOLUTION, NOT A CLEARANCE ALONG THE LINE. It used
    // to be `lineClearsBodies` — refuse if the segment ever passes within a body width — and
    // that rule is an invention: `move.c` tests the ENDPOINT of each move, lets you end inside
    // the zone if you are moving away, and SLIDES rather than refusing. Two bodies 25.3 apart
    // are impassable under the invented rule and the operator walked between them, on camera,
    // in twelve slides.
    const reaches = (wx, wy) =>
      geo.traceFineMoveClient(fx, fy, protocolToClient(wx), protocolToClient(wy),
                              { slide: false }).arrived === true
      && bodyWalkArrives(from.x, from.y, wx, wy, lineBodies, { wallOk });

    // ASKED BEFORE THE STAND POINT IS ACCEPTED, NOT AFTER.
    //
    // The stand point is almost always reachable — that is what makes it the stand point —
    // so a body check placed after `if (reaches(home)) return home` is a body check that
    // never runs. The first version of this sat below it and threaded exactly nothing: every
    // aim came back as the square's centre with a spider twenty units away, which is inside
    // a body width. The geometry question and the occupancy question are independent, and
    // the occupancy one has to be asked first because it is the one that can reject the
    // default answer.
    //
    // Guarded for the same reason `leaveVia` guards `world.wrongExitSquares`: this method is
    // lifted out of this file by text and evaluated against fixtures that have only what they
    // inject, and a bare call is a TypeError rather than a falsy answer.
    const bodies = typeof this.bodiesInSquare === 'function' ? this.bodiesInSquare(row, col) : [];
    // KEEP RIGHT IN A CORRIDOR, bodies or not. Guarded like the rest of this method: it is
    // lifted by text into fixtures that inject only what they have.
    const lane = typeof this.keepRightLane === 'function' ? this.keepRightLane(from, home) : null;
    const laned = aim => typeof this.noteLane === 'function' ? this.noteLane(aim, row, col) : aim;
    if (!bodies.length) {
      if (lane && reaches(lane.x, lane.y)) return laned(lane);
      if (reaches(home.x, home.y)) return home;
    }

    // A quarter square in each direction, ordered by how far they move the aim — the
    // nearest usable point to the one the router priced is the one that keeps the plan
    // honest. The centre is included because `standPointWire` is only the centre for
    // squares a wall does not cut, and the two differ exactly where this matters.
    const q = KOD_FINENESS >> 2;
    const centre = { x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half };
    const offsets = [[0, 0], [-q, 0], [q, 0], [0, -q], [0, q],
                     [-q, -q], [-q, q], [q, -q], [q, q]];

    // SQUEEZE PAST, RATHER THAN DECIDE THE SQUARE IS BLOCKED.
    //
    // A square is 64 kod units across; a body is PLAYER_RADIUS = 248 client units, which is
    // 15.5 kod, so about 31 across. TWO BODIES FIT SIDE BY SIDE INSIDE ONE SQUARE with half
    // a body's width to spare. That is not a curiosity — it is how the one-square corridor
    // at cols 44-46 of the Western border of the Twisted Wood is walked. A spider on the
    // north side of 29,44 leaves the south side of 29,44 free, and a person goes past it.
    //
    // Everything upstream of here reasons in squares — the room projection used to stop at
    // col/row, the threat field penalises whole squares — so "there is a monster in that
    // square" became "there is no way through", and the fleet died in that corridor seven
    // times in one run. The information to do better was on the wire the whole time.
    //
    // So when something is standing in the square we are entering, the aim is no longer the
    // FIRST reachable point in the lattice — it is the reachable point FURTHEST FROM IT.
    // Same lattice, same "never aim outside this square" rule, same straight-line proof;
    // only the ordering changes, and only when there is a body to order against.
    if (bodies.length) {
      // Finer than quarters, because the whole margin here is half a body wide: eighths give
      // the aim somewhere to go along a wall instead of only to the middle of a quadrant.
      //
      // AND IT HAS TO REACH THE EDGES OF THE SQUARE, which the first version did not. Three
      // eighths either side of the centre is ±24 on a square that is ±32, so the outermost
      // seven units of each side were not candidates at all — and those are exactly the units
      // a squeeze needs. Measured on the random sweep: a walker at y 1904 with a body at 1900
      // in the square ahead had one legal lane, y ≥ 1916, and the lattice stopped at 1912. It
      // fell through to the unchecked stand point and drove a leg 8.4 units past the body.
      // The step is finer than the eighth for the same reason the eighth beat the quarter.
      const e = KOD_FINENESS >> 4;                      // 4 units
      const reach = (KOD_FINENESS >> 1) - e;            // 28 — the last point still inside
      const fine = [];
      for (let dx = -reach; dx <= reach; dx += e)
        for (let dy = -reach; dy <= reach; dy += e) fine.push([dx, dy]);
      const clearOf = (wx, wy) => Math.min(...bodies.map(b => Math.hypot(wx - b.x, wy - b.y)));
      // With a body in the square the lane is still the first choice when it clears the body:
      // the body is usually the oncoming character, and the lane is how we pass it.
      if (lane && clearOf(lane.x, lane.y) >= BODY_CLEARANCE_KOD && reaches(lane.x, lane.y)) return laned(lane);
      // HOLD A LINE RATHER THAN RE-MAXIMISING EVERY SQUARE.
      //
      // Taking the furthest point from the body in each square independently produces a
      // zig-zag — north, north, centre, north — and the DIAGONALS BETWEEN those choices are
      // what foul the next body, so a run that clears seven squares individually still fails
      // on the eighth. Measured on the dead-centre corridor: 7 of 8 squeezed, and the one that
      // failed had no candidate whose approach line was clear from the previous zig.
      //
      // The operator walks it differently, and it is obviously right once said: pick a side
      // and go straight. "42508,296668 to 52116,296668 is a straight 90-degree west-to-east
      // walk that bypasses the testing units" — one constant lateral offset, held for the
      // whole run. Checked against this room's BSP, y 1904..1916 is exactly that: a 13-unit
      // band where a straight line clears every dead-centre body AND stays on floor.
      //
      // So among the points that CLEAR, prefer the one that deviates least from the line we
      // are already walking — same lateral offset, carried forward — instead of the one that
      // maximises a number this square alone can see. Clearance is a threshold to meet, not a
      // quantity to maximise; once it is met, straightness is worth more than another unit of
      // room, because straightness is what makes the NEXT square's approach clear too.
      // AND THE OFFSET HAS TO BE PERPENDICULAR TO THE TRAVEL, WHICH IS THE WHOLE OF "A LANE".
      //
      // Euclidean clearance alone is not enough, and the way it fails is subtle: walking east
      // past a body, a point offset in X clears it by distance while sitting in the SAME lane.
      // It passes this square and is then refused on the next, because going straight on runs
      // through the body it just went "around". Measured: aims pinned to y=1888 — the bodies'
      // own line — clearing four squares by x-distance and failing the other four.
      //
      // Passing something while travelling east means being to the NORTH or SOUTH of it. So
      // the qualifying test is separation on the perpendicular axis, and once that is met the
      // tie-break is straightness: least drift from the lane we are already in. Together those
      // two produce the operator's line — pick a side, hold it, walk straight through.
      const goingEast = Math.abs(centre.x - from.x) >= Math.abs(centre.y - from.y);
      const lateral = (a, b) => goingEast ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
      const inLaneOf = (wx, wy) =>
        bodies.some(b => lateral({ x: wx, y: wy }, b) < BODY_CLEARANCE_KOD);
      const drift = (wx, wy) => goingEast ? Math.abs(wy - from.y) : Math.abs(wx - from.x);
      // AND DOES THE LANE KEEP WORKING ONE SQUARE ON.
      //
      // Choosing a lane greedily picks whichever side is clear HERE, and a lane that dies two
      // squares later cannot be escaped in one move: switching sides means a diagonal, and the
      // diagonal runs through the body you were going around. Measured on the dead-centre
      // corridor — the north lane is clear at 43 and 44, blocked at 45, and the move that would
      // have crossed to the south lane passes 0.8 units from the body in 44.
      //
      // So a lane is only taken if it survives the NEXT square too. One square is enough: it is
      // the difference between committing to a side and discovering it, and it costs one trace
      // on a path that already pays for several.
      //
      // IT ASKS ABOUT BODIES AS WELL AS WALLS, and it did not at first. A wall-only lookahead
      // is the reason `inLaneOf` had to be a hard filter — with nothing else able to see a body
      // one square on, refusing to share a lane with one was the only proxy available. It is a
      // crude proxy, and on the random sweep it refused a legal squeeze: bodies at 2840,1884
      // and 2884,1908 are 50 apart, which is 32 of clearance plus 18 to spare, and the way past
      // is straight between them through 2862,1896 — a point in neither lane and clear of both
      // by 25. Asked the real question, the lookahead licenses it.
      const holdsAhead = (wx, wy) => {
        const ahead = goingEast
          ? { x: wx + (centre.x >= from.x ? KOD_FINENESS : -KOD_FINENESS), y: wy }
          : { x: wx, y: wy + (centre.y >= from.y ? KOD_FINENESS : -KOD_FINENESS) };
        let holds = true;
        try {
          holds = geo.traceFineMoveClient(
            protocolToClient(wx), protocolToClient(wy),
            protocolToClient(ahead.x), protocolToClient(ahead.y), { slide: false }).arrived === true;
        } catch { holds = true; }                       // cannot say is not a refusal
        return holds && bodyWalkArrives(wx, wy, ahead.x, ahead.y, lineBodies, { wallOk });
      };

      // TWO PASSES, AND THE STRICTER ONE FIRST. Holding a lane is still what is wanted whenever
      // it is available — it is what makes the next square's approach clear, and it is what the
      // operator walks. Sharing a lane is the answer only when there is no lane to be had, so
      // it is asked for second and never preferred.
      // THE SEARCH IS BOUNDED, because it runs on every step. Measured 2026-09-02 by the
      // keeper's own profiler: in a crowded room this loop, in grid order with no cap and run
      // twice, was thousands of traces per aim and the whole of every event-loop stall. The
      // candidates are ordered once by drift (then by clearance, widest first), so the first
      // one that arrives and holds IS the best and the loop stops there; a candidate is
      // traced at most once across both passes; and a square where the nearest-to-line
      // candidates all fail is a jam, not a search problem — a cap (M59_AIM_TRACE_CAP, off by
      // default: tours 9 and 10 died more with one on) would say so, and the callers
      // below handle "no aim" as they always did.
      const TRACE_CAP = Number(process.env.M59_AIM_TRACE_CAP || Infinity);
      const ordered = fine
        .map(([dx, dy]) => ({ wx: centre.x + dx, wy: centre.y + dy }))
        .filter(({ wx, wy }) => Math.floor(wx / KOD_FINENESS) === col && Math.floor(wy / KOD_FINENESS) === row)
        .map(p => ({ ...p, gap: clearOf(p.wx, p.wy), d: drift(p.wx, p.wy) }))
        .filter(p => p.gap >= BODY_CLEARANCE_KOD)        // must clear; below the bar is a collision
        .sort((a, b) => a.d - b.d || b.gap - a.gap);
      const verdicts = new Map();                         // "x,y" -> arrives && holds
      let traced = 0;
      const arrivesAndHolds = (wx, wy) => {
        const k = `${wx},${wy}`;
        if (verdicts.has(k)) return verdicts.get(k);
        traced++;
        const ok = reaches(wx, wy) && holdsAhead(wx, wy);
        verdicts.set(k, ok);
        return ok;
      };
      const search = (requireLane) => {
        for (const p of ordered) {
          if (traced >= TRACE_CAP) break;
          if (requireLane && inLaneOf(p.wx, p.wy)) continue;  // same lane as something: not past it
          if (!arrivesAndHolds(p.wx, p.wy)) continue;          // the line has to arrive, and hold
          return { best: { x: p.wx, y: p.wy, aimed_into: true, squeezed_past: bodies.length,
                           clearance: Math.round(p.gap), shared_lane: !requireLane || undefined },
                   bestClear: p.gap };
        }
        return { best: null, bestClear: -1 };
      };
      let { best, bestClear } = search(true);
      if (!best) ({ best, bestClear } = search(false));
      // NOTHING CLEARED THE BAR? Then take the roomiest reachable point anyway — a squeeze
      // that is tighter than ideal is still better than aiming at the body's own square
      // centre, which is what the fallback below would do.
      //
      // IT STILL HAS TO LOOK ONE SQUARE AHEAD. Dropping the lookahead here along with the bar
      // was the single largest remaining source of failed crossings on the random sweep, and
      // the margin it threw away was eight units: with bodies at 2840,1884 and 2884,1908 the
      // fallback picked 2820,1868, from which square 45 has ZERO legal entries, while 2820,1860
      // — the next lattice point north, equally roomy — has 4,679. Relaxing the clearance bar is
      // a decision about this square; walking into a pocket is a decision about the next one,
      // and they are not the same concession.
      if (!best) {
        for (const wantAhead of [true, false]) {
          for (const [dx, dy] of fine) {
            const wx = centre.x + dx, wy = centre.y + dy;
            if (Math.floor(wx / KOD_FINENESS) !== col || Math.floor(wy / KOD_FINENESS) !== row) continue;
            const gap = clearOf(wx, wy);
            if (gap <= bestClear || !reaches(wx, wy)) continue;
            if (wantAhead && !holdsAhead(wx, wy)) continue;
            best = { x: wx, y: wy, aimed_into: true, squeezed_past: bodies.length,
                     clearance: Math.round(gap), tight: true };
            bestClear = gap;
          }
          if (best) break;
        }
      }
      // TWO BODY RADII IS THE BAR — OR NOT GETTING WORSE, WHICHEVER IS EASIER TO MEET.
      //
      // A flat `>= BODY_CLEARANCE_KOD` has the same self-poisoning shape as the line test did:
      // a body that has drifted to 16 from a spider can never reach 32 in one step, so the
      // bar is unmeetable, the threading falls through, and the aim goes back to the square's
      // centre — straight at the thing it is trying to get past. That is precisely what the
      // live walker did: it sat at 16 and re-aimed at the centre for ninety seconds.
      //
      // So: full clearance if we can get it, otherwise any aim that does not make things
      // worse. Edging out of a squeeze is a sequence of small improvements, and a rule that
      // only accepts the finished state forbids every step toward it.
      const nowClear = Math.min(...bodies.map(b => Math.hypot(from.x - b.x, from.y - b.y)));
      if (best && (bestClear >= BODY_CLEARANCE_KOD || bestClear >= nowClear)) return best;
    }

    for (const base of home.x === centre.x && home.y === centre.y ? [centre] : [home, centre])
      for (const [dx, dy] of offsets) {
        const wx = base.x + dx, wy = base.y + dy;
        // Never aim outside the square we were told to enter: an aim that lands next door
        // is the very failure this exists to stop, dressed as a fix.
        if (Math.floor(wx / KOD_FINENESS) !== col || Math.floor(wy / KOD_FINENESS) !== row) continue;
        if (reaches(wx, wy)) return { x: wx, y: wy, aimed_into: true };
      }
    // Nothing in the square is reachable in a straight line. Hand back the stand point and
    // let the ordinary machinery slide, refuse and learn — this must never be the reason a
    // step stops being attempted.
    //
    // AND SAY SO. This is the one exit that returns a point nothing has proved: every other
    // one has been through `reaches`. Unlabelled, it is indistinguishable from a good aim, and
    // `threadInto` passed it straight through — 105 of 200 random corridors had a leg four
    // units from a body while their endpoints all sat above 21, because the endpoint of a
    // square's stand point is fine and the line to it was never asked about.
    return bodies.length ? { ...home, unproved: true } : home;
  }


  // ======================= THREADING A NEEDLE, PROPERLY =======================
  //
  // `aimInto` answers a question about ONE square: given where I am, what is the best point
  // inside that square. It is cheap, it is what almost every step needs, and it is greedy — and
  // a greedy chooser walks into pockets. Measured on a 200-corridor random sweep of row 29 of
  // the Western border of the Twisted Wood, one body per square, every body standing somewhere
  // the .roo actually allows: fifteen crossings failed, and not one of them failed because the
  // corridor was shut.
  //
  // The one that was checked by hand is worth stating in full, because it is the whole argument
  // for this method existing. Bodies at 2840,1884 and 2884,1908; the walker takes the north lane
  // at square 44 and lands on 2820,1868. From there square 45 has ZERO legal entries. Eight
  // units north, at 2820,1860 — same square, equally roomy, one lattice point away — there are
  // 4,679. The same configuration was then laid out on the live server and walked by a person,
  // who found two routes through it and looped the corridor twice.
  //
  // So the corridor was never the problem. What is needed is the thing a person does without
  // thinking: when the next square will not open, MOVE WITHIN THE ONE YOU ARE IN and try again.
  // That is a search, not a heuristic, and the honest way to write it is as a search.
  //
  //   * the unit is the FINE POINT, never the square — CLAUDE.md's standing rule, and the whole
  //     reason a spider does not close a corridor
  //   * a leg is legal when the .roo trace ARRIVES with sliding off and the line clears every
  //     body by MIN_NOMOVEON; both, always, because walls and bodies are different collisions
  //   * a destination is only worth reaching if the square AFTER it can be entered from it —
  //     the pocket test, and the one thing greedy cannot do
  //   * at most one intermediate waypoint, so the worst case costs one extra packet
  //
  // NOT ON THE COMMON PATH. Everything here runs only when `aimInto`'s answer is fouled or
  // unproved, which on the sweep is under a fifth of contested squares and zero uncontested
  // ones. An empty corridor still costs exactly what it always did.
  //
  // The three numbers are named rather than inline because movement is where the operator wants
  // to experiment, and a number worth tuning is one worth being able to find.
  //
  //   M59_NEEDLE_GOAL_STEP  lattice spacing for destinations   default 4  (finest useful)
  //   M59_NEEDLE_VIA_STEP   lattice spacing for the backtrack  default 8  (coarser; it is only
  //                                                                        a staging point)
  //   M59_NEEDLE_WORK       ceiling on legs tested             default 8000 (a hang guard, not
  //                                                                         a ration — see below)
  //   M59_NEEDLE_LEGS       most moves one squeeze may cost    default 3

  // SYMMETRIC, so it reaches both edges of the square and not just one.
  //
  // Starting at `step` and running while `< KOD_FINENESS` leaves the last `step` units of each
  // axis unsampled — at 8 that is y 1913..1919 of a row, and a squeeze lives in exactly those
  // units. This is the THIRD time that shape has cost a wrong answer here: `aimInto`'s candidate
  // set stopped at three eighths of a square either side of centre, the offline oracle stopped
  // at 56, and this one did too, which is what made a corridor the operator watched a character
  // walk through come back "no search has solved it". Its only entry ran along y 1916.
  //
  // Half a step in from each edge is the fix and it costs nothing: same count, centred.
  // THE WALL HALF OF A LEG, as one predicate, because four places now need it and a fifth
  // copy is a fifth chance to ask it with sliding on by mistake.
  _wallOk() {
    const geo = this.world?.geometry;
    if (typeof geo?.traceFineMoveClient !== 'function') return null;
    return (ax, ay, bx, by) => {
      try {
        return geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                       protocolToClient(bx), protocolToClient(by),
                                       { slide: false }).arrived === true;
      } catch { return false; }
    };
  }

  // COORDINATE CONTRACT: the square is `(row,col)`; `step` and returned `{x,y}`
  // points are in kod wire units.
  _fineLattice(row, col, step) {
    const out = [];
    const x0 = col * KOD_FINENESS, y0 = row * KOD_FINENESS, half = Math.max(1, step >> 1);
    for (let dy = half; dy < KOD_FINENESS; dy += step)
      for (let dx = half; dx < KOD_FINENESS; dx += step) out.push({ x: x0 + dx, y: y0 + dy });
    return out;
  }

  // ONE LEG, ASKED OF BOTH COLLISIONS. A walk that clears the walls and goes through a spider is
  // not a walk, and a walk that misses every spider through a wall is not one either.
  _legIsLegal(a, b, bodies) {
    const geo = this.world?.geometry;
    if (typeof geo?.traceFineMoveClient !== 'function') return false;
    let arrived = false;
    try {
      arrived = geo.traceFineMoveClient(protocolToClient(a.x), protocolToClient(a.y),
                                        protocolToClient(b.x), protocolToClient(b.y),
                                        { slide: false }).arrived === true;
    } catch { arrived = false; }
    return arrived && bodyWalkArrives(a.x, a.y, b.x, b.y, bodies, { wallOk: this._wallOk() });
  }

  // IS THERE ANYWHERE IN THAT SQUARE TO STAND, FROM HERE? Early-exits on the first one found:
  // this is a yes/no about a pocket, not a request for the best point, and asking it as a
  // request is how a lookahead becomes too expensive to keep.
  // COORDINATE CONTRACT: the square is `(row,col)`; fine points and `step` use kod units.
  // The needle's clock reaches this through `_needleDeadline` on the instance, set by
  // threadInto around each entry check, so the signature the fixtures lift stays the same.
  _canEnter(from, row, col, step) {
    const deadline = Number.isFinite(this._needleDeadline) ? this._needleDeadline : Infinity;
    const geo = this.world?.geometry;
    if (!geo) return true;                              // no geometry is not a refusal
    if (typeof geo.inBounds === 'function' && !geo.inBounds(row, col)) return true;
    try { if (typeof geo.walkable === 'function' && !geo.walkable(row, col)) return true; }
    catch { /* a square we cannot ask about is not a pocket */ }
    const bodies = this.bodiesInSquare(row, col, 1);
    for (const p of this._fineLattice(row, col, step)) {
      if (Date.now() > deadline) return false;          // out of time is not an entry
      if (bodies.length
          && Math.min(...bodies.map(b => Math.hypot(p.x - b.x, p.y - b.y))) < BODY_CLEARANCE_KOD)
        continue;
      if (this._legIsLegal(from, p, bodies)) return true;
    }
    return false;
  }

  /**
   * Returns `{ aim }` for the ordinary case, `{ via, aim }` when getting past somebody needs a
   * reposition inside the current square first, and `{ aim, blocked: true }` when nothing legal
   * was found — in which case `aim` is still the ordinary one, labelled `unproved`, because
   * refusing to aim is how a step stops being attempted and this must never be that.
   */
  // COORDINATE CONTRACT: the square is `(row,col)`; `from`, `aim`, and `vias`
  // use named `{x,y}` points in kod wire units.
  // The clock cut a needle: one ledger row per session per 30 s, because a jam asks every step.
  _noteNeedleCut(row, col, bodyCount, tookMs, budgetMs) {
    const now = Date.now();
    if (this._needleCutAt > now - 30_000) return;
    this._needleCutAt = now;
    try {
      recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                     room: Number(this.world?.room?.num ?? 0),
                     tactic: 'needle_budget', trigger: 'clock', worked: false, ms: tookMs,
                     hp_lost: 0, attempted: true,
                     note: `needle into ${row},${col} cut at ${tookMs}ms (budget ${budgetMs}ms) with ` +
                           `${bodyCount} bodies in the square; answered blocked` });
    } catch { /* evidence, not a dependency */ }
  }
  threadInto(from, row, col) {
    const aim = this.aimInto(from, row, col);
    if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.row)) return { aim };
    // GUARDED, for the same reason `aimInto` guards it: this method is lifted out of this file
    // by text and evaluated against fixtures that have only what they inject, and a bare call is
    // a TypeError rather than a falsy answer. A session with no room projection has no opinion
    // about bodies, and no opinion means aim exactly as we always did.
    if (typeof this.bodiesInSquare !== 'function') return { aim };
    // `spread` 1, for the same reason the line test uses it: a step spans two squares, and the
    // body to get past may be sitting in the one being left.
    const bodies = this.bodiesInSquare(row, col, 1);
    if (!bodies.length) return { aim };

    // THE TRIGGER IS THE LINE, NOT THE ENDPOINT — the same distinction that had to be made
    // inside `aimInto`, and it had to be made again here for the same reason. `aimInto` ends
    // with an unchecked `return home`: when nothing in the square is reachable it hands back the
    // stand point deliberately, so the ordinary machinery slides, refuses and learns rather than
    // the step never being attempted. That is right, and it means the point it returns is
    // sometimes NOT proved clear of anything. Asked only whether the endpoint had room, this
    // passed it straight through: 105 of 200 random corridors had a leg passing four units from
    // a body while every endpoint sat above 21.
    const clearOf = (p) => Math.min(...bodies.map(b => Math.hypot(p.x - b.x, p.y - b.y)));

    const geo = this.world?.geometry;
    if (typeof geo?.traceFineMoveClient !== 'function') return { aim };

    const GOAL_STEP = Number(process.env.M59_NEEDLE_GOAL_STEP || 4);
    const VIA_STEP = Number(process.env.M59_NEEDLE_VIA_STEP || 8);
    const WORK = Number(process.env.M59_NEEDLE_WORK || 8000);
    // HOW MANY PACKETS A SQUEEZE MAY COST. Three is the cap because at four the search is no
    // longer describing "get past this spider" — it is finding a route, which is somebody else's
    // job and a different budget.
    const MAX_LEGS = Number(process.env.M59_NEEDLE_LEGS || 3);
    // THE CLOCK. Every leg below is a fine-move trace and a body walk, and the direct phase
    // alone can be 256 goals x 65 legs before the work budget applies. Measured 2026-09-02
    // by the keeper's own profiler: 29 s in one call, the whole of every stall that was
    // left. A needle that has not threaded in this long is a jam, and a jam is what the
    // walker's other tactics are for; the answer is the honest "blocked" below, and a
    // ledger row says the clock cut it. M59_NEEDLE_MS=0 removes the clock.
    const BUDGET_MS = Number(process.env.M59_NEEDLE_MS ?? 400);
    const startedAt = Date.now();
    const deadline = BUDGET_MS > 0 ? startedAt + BUDGET_MS : Infinity;
    let cut = false;
    const legal = (a, b, bs) => {
      if (Date.now() > deadline) { cut = true; return false; }
      return this._legIsLegal(a, b, bs);
    };

    // THE SQUARE AFTER THIS ONE, carried on in the same direction. Nothing here knows the route
    // — `step` is called one square at a time — so the continuation is inferred, which is enough
    // for the only question being asked of it: is the place we are about to stand a dead end.
    const ar = Math.sign(row - from.row), ac = Math.sign(col - from.col);
    const beyond = (ar || ac) ? { row: row + ar, col: col + ac } : null;
    const opensOn = (p) => {
      if (!beyond) return true;
      this._needleDeadline = deadline;
      try { return this._canEnter(p, beyond.row, beyond.col, VIA_STEP); }
      finally { this._needleDeadline = null; }
    };

    // AND THE POCKET TEST APPLIES TO THE CHOICE, NOT ONLY TO THE RESCUE.
    //
    // Asked only when the ordinary aim was already fouled, the search never sees the step that
    // causes the trouble. Traced on the dead-centre corridor: square 44 hands back 2820,1868 —
    // clear by 34, line proved, nothing wrong with it — and square 45 then has no legal entry at
    // all, so the solver is called for the first time from inside the pocket, where by
    // definition it cannot help. Backtracking one square is not something `step` can do; not
    // walking in is.
    //
    // So a good aim has to be good in three ways, and the third is about the next square. It
    // costs one `_canEnter` per contested step, which early-exits on the first point it finds.
    if (clearOf(aim) >= BODY_CLEARANCE_KOD
        && !aim.unproved
        && bodyWalkArrives(from.x, from.y, aim.x, aim.y, bodies, { wallOk: this._wallOk() })
        && opensOn(aim))
      return { aim };

    // Destinations first, ordered the way a person would take them: hold the lane you are
    // already in (least drift off the perpendicular), and among equals take the roomiest. That
    // ordering is what makes the search terminate early on almost every real corridor.
    const goingEast = Math.abs(col - from.col) >= Math.abs(row - from.row);
    const drift = (p) => goingEast ? Math.abs(p.y - from.y) : Math.abs(p.x - from.x);
    //
    // ORDERED, NOT TRIMMED. Keeping only the lowest-drift few is the obvious economy and it is
    // exactly wrong: low drift means "in the lane I am already in", so trimming to it discards
    // every lane change before the search has looked at one. Tried at 24 of 225, it turned two
    // passing hand-built cases into failures and took the random sweep from 15 bad crossings to
    // 31. The budget belongs on the WORK, further down, where it costs coverage of the rare
    // two-leg case rather than of the answer.
    const goals = this._fineLattice(row, col, GOAL_STEP)
      .map(p => ({ ...p, gap: clearOf(p), d: drift(p) }))
      .filter(p => p.gap >= BODY_CLEARANCE_KOD)
      .sort((a, b) => a.d - b.d || b.gap - a.gap);

    // The pocket test is the expensive half, so it is asked once per destination and only when
    // a leg has actually reached it.
    const opens = new Map();
    const isOpen = (g) => {
      const k = `${g.x},${g.y}`;
      if (!opens.has(k)) opens.set(k, opensOn(g));
      return opens.get(k);
    };

    // ONE LEG. The overwhelmingly common repair, and it costs nothing extra to send.
    for (const g of goals)
      if (legal(from, g, bodies) && isOpen(g))
        return { aim: { x: g.x, y: g.y, aimed_into: true, squeezed_past: bodies.length,
                        clearance: Math.round(g.gap) } };

    // MORE THAN ONE LEG, BECAUSE ONE IS NOT ALWAYS ENOUGH.
    //
    // This started as a single sideways waypoint — the move a person makes without noticing, and
    // the one a greedy chooser cannot make. It fixed the hand-built cases and most of the random
    // ones, and then the operator laid a configuration the suite had called SHUT out on the live
    // server and watched a character walk through it. A full breadth-first search agrees: that
    // configuration is crossable inside row 29 alone. One waypoint was simply not deep enough.
    //
    // So the repair is a bounded search rather than a fixed shape. Nodes are fine points in the
    // square being left; the goal is a fine point in the square being entered that is clear of
    // bodies and from which the square after THAT can be entered; edges are legs that arrive on
    // the .roo and clear every body. Breadth-first, so the answer found is the one with the
    // fewest packets, and depth-capped so a pathological room cannot hang a keeper mid-walk.
    //
    // It is still not a general path-finder and should not become one. It searches two squares
    // and hands back a handful of moves; the route is the router's job, and a walker that starts
    // solving mazes inside `step` has stopped being a walker.
    //
    // AND THE GROUND BEHIND COUNTS AS STAGING. Confined to the square it is standing in, the
    // search still missed two configurations a full search solves — and watching what the full
    // search did with one of them says why: it stepped BACK, west, to get the angle for a long
    // diagonal past two bodies straddling the boundary ahead. Backing up is not losing progress
    // when the alternative is not crossing; a person does it without thinking, and the aim still
    // has to land in the square the router asked for, so nothing downstream can tell the
    // difference. The square behind is the one opposite the way we are going.
    const behind = { row: from.row - ar, col: from.col - ac };
    const here = this.bodiesInSquare(from.row, from.col, 1);
    const clearHere = (p) => !here.length
      || Math.min(...here.map(b => Math.hypot(p.x - b.x, p.y - b.y))) >= BODY_CLEARANCE_KOD;
    const staging = this._fineLattice(from.row, from.col, VIA_STEP)
      .concat((behind.row !== from.row || behind.col !== from.col)
                ? this._fineLattice(behind.row, behind.col, VIA_STEP) : [])
      .filter(clearHere);

    // The budget bounds LEGS TESTED, which is the only cost here that is a product. Running out
    // means the repair went unexplored — a missed opportunity, and the step still happens.
    // Trimming the destinations instead, which was tried, means the answer was never a
    // candidate: it turned two passing hand-built cases into failures and took the random sweep
    // from fifteen bad crossings to thirty-one. It also has to be big enough to reach past the
    // preference order — the goals are sorted by least drift, so the cheap end of the list is
    // precisely the lane that has just failed, and a budget of 576 examined 23 goals of 180 and
    // called a corridor blocked that had 536 solutions.
    let work = WORK;
    const key = (p) => `${p.x},${p.y}`;
    const cameFrom = new Map();
    const seen = new Set([key(from)]);
    let frontier = [from];
    for (let depth = 1; depth <= MAX_LEGS && frontier.length && work > 0; depth++) {
      const next = [];
      for (const p of frontier) {
        if (work <= 0) break;
        // Can this node finish it? Goals are ordered the way a person would take them, so the
        // first that answers is the one that holds the lane.
        for (const g of goals) {
          if (--work <= 0) break;
          if (!legal(p, g, bodies)) continue;
          if (!isOpen(g)) continue;
          const vias = [];
          for (let at = p; at !== from; at = cameFrom.get(key(at)))
            vias.unshift({ x: at.x, y: at.y,
                           row: Math.floor(at.y / KOD_FINENESS), col: Math.floor(at.x / KOD_FINENESS),
                           lane_change: true });
          return { vias,
                   via: vias[0],                        // the one-waypoint case, unchanged
                   aim: { x: g.x, y: g.y, aimed_into: true, squeezed_past: bodies.length,
                          clearance: Math.round(g.gap) },
                   lane_changed: vias.length > 0 };
        }
        if (depth === MAX_LEGS) continue;               // no point expanding what cannot be used
        for (const v of staging) {
          const k = key(v);
          if (seen.has(k) || (--work <= 0)) continue;
          if (!legal(p, v, here)) continue;
          seen.add(k); cameFrom.set(k, p); next.push(v);
        }
      }
      frontier = next;
    }

    // NOTHING OPENS IT. Say so rather than passing off a line that goes through somebody: the
    // aim is still returned, so the step is still attempted, but it is labelled — and a caller
    // that wants to replan rather than bounce now has something to test.
    if ((cut || Date.now() > deadline) && typeof this._noteNeedleCut === 'function')
      this._noteNeedleCut(row, col, bodies.length, Date.now() - startedAt, BUDGET_MS);
    return { aim: { ...aim, unproved: true }, blocked: true, cut: cut || undefined };
  }

  // WALK THE ROUTE THAT WAS PROVED, NOT THE LATTICE IT WAS DERIVED FROM.
  //
  // THIS IS THE ANSWER TO "WHY DOES THE FLEET DEVIATE FROM ITS PLAN AT ALL". Almost
  // nothing about a room changes: walls, floor heights, slopes and water depth are in the
  // `.roo` and are the same today as yesterday. So which straight lines a body can actually
  // complete is a fact that can be — and already IS — computed offline. `stringPull` reaches
  // as far along a route as the line still ARRIVES with sliding off, and the bake has used
  // it since routes were first baked: the crossing of room 598 from its Twisted Wood
  // doorway to its Ukgoth doorway is 64 squares and SEVEN proved legs of 20, 3, 9, 1, 1, 7
  // and 23 squares, with zero unverified.
  //
  // The walker never used any of it. It re-derived a square lattice at runtime and aimed at
  // each square's stand point in turn — and a stand point in the MIDDLE of a proved leg is
  // not a point the proof says anything about. `moverStepLands` clears it centre to centre,
  // the body is not on a centre after the first slide, the move clips, and the walker
  // replans from a square it never chose. That is every "kept ending up somewhere other
  // than the planned square" in the ledger, and it is self-inflicted.
  //
  // So: aim at the PIVOTS. One move per proved leg, paced by the leg's own length, with the
  // position predicted rather than read — which is exactly what the proof licenses, because
  // a line that arrives arrives. Sixty-four squares becomes seven moves and about thirteen
  // seconds at a run, against a measured median of eighty-five and a worst of 1,778.
  //
  // WHAT IT DOES NOT AND CANNOT PRE-COMPUTE, because the answer to "why not zero deviations"
  // has to be honest and short:
  //
  //   * A BODY IN THE WAY. `blocksMovement` is the one collision that is not in the .roo,
  //     and a troll standing on a pivot is not knowable in advance. A refused leg drops
  //     straight back to the square walker, which already knows how to go round one.
  //   * A ROOM THAT ANIMATES. m59-mutable.mjs names them, and 598 is on the list — the
  //     Temple of Qor door cycles faster than the eight-second collision-invalidation
  //     window. A moving sector genuinely changes the geometry the proof was taken against.
  //   * WHERE THE BODY IS WHEN IT ARRIVES. The proof is anchored at a point; a character
  //     dropped somewhere else by a death, a rescue or a boundary that lands wide has to
  //     walk onto the spine first, and that first stretch is unproved.
  //
  // Everything else — every wall, every ledge, every slope this fleet has ever slid on — is
  // static and was already computed. This just uses it.
  // `shelter` is the fuel-stop contract, and it is the whole of the change: { spots, need,
  // maxDetour, onDivert }. `spots` came from `sheltersAlong` when this crossing was PLANNED,
  // `need()` says whether the character wants one now, and when both are true the next
  // shelter ahead is spliced into the route rather than searched for.
  //
  // Nothing stops. No replan, no handing the character back, no asking the room where the
  // walls are from a standstill — the walker aims at one more waypoint than it did before
  // and carries on. That matters because health leaves at a median of 4.7 a second once
  // something starts, and the average maximum on this fleet is 45: nine and a half seconds
  // from full to dead, and the braking version spent most of it thinking.
  async walkPivots(planSteps, geo, { movementGeneration = this.movementGeneration,
                                    controlToken = null, maxMoves = null,
                                    shelter = null } = {}) {
    const c = this.need();
    const roomId = c.room.id;
    let legs = 0, singles = 0;
    let divertedTo = null, diverted = 0;
    // ONE LEG OF ACTUAL PROGRESS BEFORE THE NEXT DIVERT, AND IT IS A LIVE-LOCK GUARD.
    //
    // Making the divert immediate on damage (see the hit clamp below) makes this necessary
    // rather than merely tidy. A character that rests to full, steps off the wall, is hit
    // once, and re-asks the question in the same second will pick the wall it is standing
    // next to — it is by definition the nearest one — walk back onto it, rest, step off,
    // and do it again for as long as anything in the room keeps swinging. The journey never
    // advances and every lap reports success, which is this repository's oldest failure
    // shape and the one hardest to see from outside.
    //
    // Infinity to start, so the FIRST leg of a fresh crossing may divert normally — the
    // guard is about leaving shelter, not about setting out. Zeroed on arrival at a refuge,
    // and one completed leg is the whole of the debt.
    //
    // The worst case this buys is a crossing made entirely of wall-to-wall hops with a rest
    // at each, which is slow and finishes. The worst case it replaces is a character that
    // never leaves one square. Nothing here touches the survival ladder: fleeing, the
    // watchdog and the protected faculties run on their own one-second clock and are not
    // suppressed by this — only the decision to go and sit somewhere is.
    let legsSinceShelter = Infinity;
    const budget = maxMoves ?? (planSteps.length + 20);
    const half = KOD_FINENESS >> 1;
    const ptOf = st => geo.standPoint?.(st.row, st.col)
      ?? { x: protocolToClient(st.col * KOD_FINENESS + half),
           y: protocolToClient(st.row * KOD_FINENESS + half) };
    let remaining = planSteps.slice();

    // PUBLISHED SO THE KEEPER CAN ASK THE SAME QUESTION THE WALKER ASKS.
    //
    // The fuel stops are worked out here, when the crossing is planned, and until now they
    // never left this function — so the keeper's mid-hop wall rung had no way to see them
    // and searched the room from wherever the body happened to be standing instead. That is
    // the braking version this whole mechanism exists to replace, and it was still running
    // one layer up. `atStep` is kept current per leg so `shelterAhead` can refuse anything
    // already passed; behind is where the character has already been bitten.
    // `onward` is the last planned step — the square this crossing leaves by — so the
    // survival ladder can judge a refuge against the door rather than against where the body
    // happens to be standing. Kept even when the route offers no shelter of its own.
    const onward = planSteps.length ? { row: planSteps[planSteps.length - 1].row, col: planSteps[planSteps.length - 1].col } : null;
    this.activeShelter = shelter?.spots?.length
      ? { spots: shelter.spots, maxDetour: shelter.maxDetour ?? 5, atStep: 0, onward }
      : (onward ? { spots: [], maxDetour: shelter?.maxDetour ?? 5, atStep: 0, onward } : null);

    while (remaining.length && legs + singles < budget) {
      if (this.activeShelter) this.activeShelter.atStep = planSteps.length - remaining.length;
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return { done: false, legs, singles, cancelled: true };

      // THE FUEL STOP. Checked before each leg, which is where a route can still be changed
      // cheaply — the walker is between aims rather than mid-slide.
      //
      // AND AGAIN THE MOMENT A HIT LANDS, which is the half that was missing. See the
      // clamp below: a leg is short while a hit is recent, so "before each leg" becomes
      // "about once a second" exactly when it matters, and the divert stops being decided
      // twenty points of health after the threshold it is supposed to defend.
      if (shelter?.spots?.length && !divertedTo && typeof shelter.need === 'function') {
        let wants = false;
        try { wants = !!shelter.need(); } catch { wants = false; }
        if (wants && legsSinceShelter < 1) {
          // Just off a wall and already wanting another. Say so in the record rather than
          // silently walking on: a suppressed divert and a divert that found nowhere to go
          // look identical from the outside, and they are different rooms.
          try { shelter.onDivert?.(null, { atStep: planSteps.length - remaining.length,
                                           suppressed: 'one leg of progress owed since the last refuge' }); }
          catch { /* a note that cannot be written does not stop the walk */ }
        }
        if (wants && legsSinceShelter >= 1) {
          // How far along we are: the plan minus what is left. `shelterAhead` refuses
          // anything behind that, because a character got hurt somewhere and walking back
          // through it to a wall it has already passed is a longer way to die.
          const at = planSteps.length - remaining.length;
          const stop = shelterAhead(shelter.spots, at, { maxDetour: shelter.maxDetour ?? 5 });
          if (stop) {
            divertedTo = stop; diverted++;
            // ONE MORE WAYPOINT, NOT A NEW PLAN. The rest of the route is untouched and is
            // walked afterwards exactly as it would have been.
            remaining.unshift({ row: stop.row, col: stop.col, shelter: true });
            try { shelter.onDivert?.(stop, { atStep: at, remaining: remaining.length }); }
            catch { /* a note that cannot be written does not stop the walk */ }
          }
        }
      }
      if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
      const me = c.self;
      if (!me || !Number.isFinite(me.x))
        return { done: false, legs, singles, why: 'own_position_unknown' };

      // RE-PROVE FROM WHERE THE BODY ACTUALLY IS, EVERY TIME IT IS NOT ON A PIVOT.
      //
      // This is the difference between a proof and a plan. From room 598's own doorway the
      // pull proves all nine legs — `111111111` — and the crossing is nine moves. From an
      // interior square a character was dropped on, the FIRST leg is routinely unproved
      // (`011`, `011111`), and a walker that gives up there gets no benefit from any of it.
      // So an unproved leg is walked as one ordinary step and the route is re-proved from
      // wherever that lands: one `stringPull`, a handful of traces, not a whole replan.
      const pull = (() => {
        try {
          return geo.stringPull([{ x: protocolToClient(me.x), y: protocolToClient(me.y) },
                                 ...remaining.map(ptOf)]);
        } catch { return null; }
      })();
      if (!pull || !pull.points || pull.points.length < 2)
        return { done: false, legs, singles, why: 'the route could not be pulled' };

      if (!(pull.proved && pull.proved[0])) {
        // The one square the pull could not prove: hand it to the ordinary step, which has
        // the aim correction, the slide and the edge learning. Then re-prove.
        const target = remaining[0];
        // A FALL IS ALWAYS "UNPROVED" TO THE PULL, because the pull traces in walk mode —
        // which is precisely the predicate that refuses a fall. So it lands here, and here
        // is where the flag has to be passed on.
        const r = await this.step(target.col, target.row, { fall: !!target.fall });
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        singles++;
        legsSinceShelter++;   // progress since the last refuge — see the live-lock guard
        if (r.left_room) return { done: false, legs, singles, left_room: true };
        if (isTerminalMovementReason(r.reason)) return { done: false, legs, singles, ...r };
        const now = c.self;
        if (!now) return { done: false, legs, singles, why: 'own_position_unknown' };
        if (now.col === target.col && now.row === target.row) {
          // ARRIVED AT A REFUGE. SIT DOWN IF WE ARE NOT WHOLE.
          //
          // The operator's rule: stop at each safe waypoint until health and vigor are full,
          // and skip the ones you do not need. Until now the fuel stop put the wall on the
          // route and WALKED THROUGH IT — the comment above says "nothing stops", which is
          // right about not cancelling the crossing and wrong about not resting. A refuge you
          // pass at 40% health is a square, not a refuge.
          //
          // This is NOT a cancellation. The mover keeps the body, the route behind this
          // waypoint is untouched, and the walk continues from here the moment the rest is
          // done. That is the whole difference between a pause and an ending.
          if (target.shelter && typeof shelter?.onArrive === 'function') {
            try { await shelter.onArrive({ col: target.col, row: target.row }); }
            catch { /* a rest that cannot happen must not strand the crossing */ }
            if (this.movementWasCancelled(movementGeneration, controlToken))
              return { done: false, legs, singles, cancelled: true };
            if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
          }
          remaining.shift(); divertedTo = null; legsSinceShelter = 0; continue;
        }
        return { done: false, legs, singles, why: 'an unproved step landed off plan' };
      }

      // A RECENT HIT ENDS THE COALESCING, AND THAT IS WHAT MAKES THE DIVERT IMMEDIATE.
      //
      // A proved leg is ONE move covering up to twenty-three squares, paced by its own
      // length — several seconds during which the shelter question is not asked, because it
      // is asked at the top of this loop and the loop is not coming round. That is the
      // whole of the latency: 42% of diverts fired more than 25 points below their own
      // threshold, and every one of the ten latest fired at `at_step 0`, i.e. only once the
      // walk it was on had ended and a new one begun.
      //
      // So while a hit is recent the leg is one square. The check at the top then runs at
      // the pace the game actually moves at — about once a second — and the character
      // decides to run for cover while it still can. The proof is not thrown away: the same
      // squares are walked, through the mover that can thread them, and full-length legs
      // come back as soon as nothing has hit us for `SHELTER_HIT_WINDOW_MS`.
      //
      // Only when a shelter policy is in force, so an errand, a fight or a shopping trip
      // pays nothing for this. Being hurt is not the trigger — being hurt is a state and
      // could last a whole crossing; being HIT is an event, and it is the event that means
      // the number the last check read is already out of date.
      if (shelter?.need && this.damagedAt
          && Date.now() - this.damagedAt < SHELTER_HIT_WINDOW_MS
          && remaining.length > 1) {
        const one = remaining[0];
        const r = await this.step(one.col, one.row, { fall: !!one.fall });
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        singles++;
        legsSinceShelter++;   // progress since the last refuge — see the live-lock guard
        if (r.left_room) return { done: false, legs, singles, left_room: true };
        if (isTerminalMovementReason(r.reason)) return { done: false, legs, singles, ...r };
        if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
        const now2 = c.self;
        if (now2 && now2.col === one.col && now2.row === one.row) {
          if (one.shelter && typeof shelter?.onArrive === 'function') {
            try { await shelter.onArrive({ col: one.col, row: one.row }); }
            catch { /* a rest that cannot happen must not strand the crossing */ }
            if (this.movementWasCancelled(movementGeneration, controlToken))
              return { done: false, legs, singles, cancelled: true };
            if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
          }
          remaining.shift(); divertedTo = null; legsSinceShelter = 0;
        }
        continue;
      }

      // A PROVED LEG: one move, aimed at the pivot, paced by its own length.
      const aim = pull.points[1];
      // `let`, because a refused pivot may be retried at another point in the SAME square —
      // see the refusal below. The square is the plan; the point is a choice within it.
      let target = { x: clientToProtocol(aim.x), y: clientToProtocol(aim.y) };
      // BUT A PROOF ABOUT WALLS IS NOT A PROOF ABOUT BODIES.
      //
      // The pull proved this line against the .roo, offline, in an empty room — and a body is
      // the one collision that is not in the .roo. So a leg that is geometrically perfect can
      // still run straight into something standing on it, and this is the path that does it:
      // `step()` threads past bodies through `aimInto`, and a proved leg never calls `step()`.
      //
      // Watched live on 2026-08-27 in the corridor at row 29 of the Western border of the
      // Twisted Wood, with eight bodies parked one per square: the walker covered 29,40 to
      // 29,43 in ONE move and stopped at x=2768 against a body at x=2784 — sixteen units
      // short, which is one body radius. It had aimed through it, been clipped, and then
      // bounced. Threading the aim was useless here because the aim was never asked for.
      //
      // So a leg with something on it is given back to the square walker, which knows how to
      // go past one body at a time. The proof is not discarded — the same squares are walked,
      // one at a time, through the mover that can thread them. Only the coalescing is given
      // up, and only for the legs that need it.
      const legBodies = typeof this.bodiesInSquare === 'function'
        ? this.bodiesInSquare(Math.floor(target.y / KOD_FINENESS),
                              Math.floor(target.x / KOD_FINENESS), 2) : [];
      if (legBodies.length
          && !bodyWalkArrives(me.x, me.y, target.x, target.y, legBodies,
                               { wallOk: this._wallOk() })) {
        const nextSq = remaining[0];
        if (nextSq) {
          const r = await this.step(nextSq.col, nextSq.row, { fall: !!nextSq.fall });
          if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
          if (r?.left_room || c.room.id !== roomId)
            return { done: false, legs, singles, left_room: true };
          singles++;
          legsSinceShelter++;   // progress since the last refuge — see the live-lock guard
          if (c.self && c.self.col === nextSq.col && c.self.row === nextSq.row) remaining.shift();
          continue;
        }
      }
      const dist = Math.max(Math.abs(target.x - me.x), Math.abs(target.y - me.y)) / KOD_FINENESS;
      // A twenty-three square move landing a fifth of a second after a one-square one is
      // the shape user.kod:3049 logs as a speedhacker; covering the ground at a run takes
      // the time it takes either way, so the wait is honest as well as safe.
      const speed = this.moveSpeed();
      const owed = Math.round(1000 * dist / squaresPerSecond(speed));
      const deg = (Math.atan2(target.y - me.y, target.x - me.x) * 180 / Math.PI + 360) % 360;
      await this.pacer.submit('turn', () => (c.room.id === roomId ? c.face(deg) : false));
      let queued = await this.queueValidatedMove(target.x, target.y,
        { speed, slide: false, minGap: Math.max(this._moveGapMs ?? MOVE_INTERVAL_MS, owed),
          expectedRoomId: roomId });
      // Traced at the CALL SITE, never inside `queueValidatedMove` — that method is lifted
      // out of this file by text and evaluated by m59-collision-test.mjs, so anything it
      // calls has to exist in that scope too. Off unless M59_COLLISION_TRACE=1.
      traceMove({ agent: this.name, room: this.world?.room?.num ?? null, kind: 'pivot',
                  to: { x: target.x, y: target.y }, sent: !!queued.sent,
                  reason: queued.validation?.reason ?? null });
      if (!queued.sent) {
        // A PIVOT IS A SQUARE, AND A STAND POINT IS ONE POINT IN IT.
        //
        // This gave up on the whole proved leg the moment the pivot's stand point was refused,
        // and a stand point is refusable while the square is perfectly enterable — it is one
        // point of a 64-unit square, chosen for openness, not for reachability FROM HERE.
        //
        // Measured on the shadow fleet, 2026-08-28, room 578 stepping 47,14 -> 46,15, by asking
        // the body to aim at each lattice point in turn:
        //
        //     992,2976  the stand point          geometry_blocked
        //     992,2992                           MOVED, landed in 46,15
        //     976,2992 and 1008,2992             MOVED, landed in 46,15
        //
        // Three of nine points work and the one this aimed at is not one of them. So the baked
        // route was right that the step exists, the square walker's `aimInto` would have found
        // it, and only the pivot walker could not — it is the one path that never asks. The
        // operator watched characters sit in that room for minutes on a route that was correct.
        //
        // `aimInto` is exactly the question worth asking here and it is already written: same
        // square, other points, each proved by the same trace. One retry, and on failure the
        // leg gives up as before and the square walker takes over below.
        const other = typeof this.aimInto === 'function'
          ? this.aimInto(me, Math.floor(target.y / KOD_FINENESS),
                             Math.floor(target.x / KOD_FINENESS))
          : null;
        const retry = other && (other.x !== target.x || other.y !== target.y)
          ? await this.queueValidatedMove(other.x, other.y,
              { speed, slide: false, minGap: Math.max(this._moveGapMs ?? MOVE_INTERVAL_MS, owed),
                expectedRoomId: roomId }).catch(() => null)
          : null;
        if (!retry?.sent)
          return { done: false, legs, singles, why: queued.validation?.reason ?? 'refused',
                   note: queued.validation?.note };
        queued = retry;
        target = other;
      }
      this._moveGapMs = owed;
      legs++;
      legsSinceShelter++;   // progress since the last refuge — see the live-lock guard
      // PREDICTED, WHICH IS WHAT THE PROOF IS FOR. `slide: false` means the move either
      // lands on the pivot or is not sent at all, so there is nothing to read back — and
      // reading back is a 1.2-5.6s round trip that would cost more than the leg.
      c.predictSelf({ x: queued.target.x, y: queued.target.y,
                      col: Math.floor(queued.target.x / KOD_FINENESS),
                      row: Math.floor(queued.target.y / KOD_FINENESS) });
      // Drop every planned square the leg just covered. The pivot IS one of them, so the
      // route is consumed up to and including it.
      const at = c.self;
      let cut = remaining.findIndex(st => st.col === at.col && st.row === at.row);
      if (cut < 0) cut = 0;
      // A PROVED LEG CAN SWALLOW THE REFUGE, AND BEING PAST IT IS NOT BEING AT IT.
      //
      // This used to call `onArrive({ col: at.col, row: at.row })` for any leg whose consumed
      // squares included a shelter — `at` being where the LEG ENDED, which on a proved leg is
      // up to thirteen squares beyond the wall. So the character sat down wherever the pivot
      // put it, in the open, and rested there.
      //
      // Measured on the shadow fleet, 2026-08-27: of 41 shelter stops that reported arriving,
      // fifteen LOST health — 134 points given away at places the ledger called refuges — and
      // 598 51,22 alone took 92 of that across eight characters. The operator's correction is
      // what identified it: those squares are valid safe spots, and a character that reaches
      // one is safe on it. They were not reaching them. The wall was never the problem, and a
      // ledger that says `arrived: true` for a body standing somewhere else is worse than no
      // ledger, because it moves the blame onto the geometry.
      //
      // So a swallowed refuge is PUT BACK rather than counted. The walker's next iteration
      // aims at it as an ordinary waypoint and the other call site — which checks the position
      // before resting — does the honours. The cost is one short leg backwards; the thing it
      // buys is that "arrived" means arrived.
      const swallowed = remaining.slice(0, cut + 1).filter(st => st.shelter);
      const onIt = swallowed.some(st => st.col === at.col && st.row === at.row);
      remaining = remaining.slice(cut + 1);
      if (swallowed.length && !onIt) {
        // Nearest first: a leg can swallow more than one, and the one worth turning back for
        // is the one we are closest to.
        const back = swallowed.reduce((best, st) =>
          !best || Math.max(Math.abs(st.col - at.col), Math.abs(st.row - at.row))
                 < Math.max(Math.abs(best.col - at.col), Math.abs(best.row - at.row)) ? st : best, null);
        remaining.unshift(back);
        continue;                                  // aim at it properly, then rest on it
      }
      if (onIt && typeof shelter?.onArrive === 'function') {
        try { await shelter.onArrive({ col: at.col, row: at.row }); }
        catch { /* a rest that cannot happen must not strand the crossing */ }
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return { done: false, legs, singles, cancelled: true };
        if (c.room.id !== roomId) return { done: false, legs, singles, left_room: true };
        divertedTo = null; legsSinceShelter = 0;
      }
    }
    return { done: remaining.length === 0, legs, singles,
             ...(remaining.length ? { why: 'ran out of moves before the route ended' } : {}) };
  }

  /**
   * WHERE TO AIM A DECLARED JUMP, GIVEN WHO IS STANDING IN THE WAY.
   *
   * Extracted so the walker and the rail share one implementation. It was written for the
   * rail and only ever ran there — and the rail is not how this fleet takes the jump, so
   * every measurement below was being paid for and thrown away. Two homes for one
   * heuristic is how they drift; this is the one home.
   *
   * Sixty-eight measured jumps, every one a real attempt:
   *
   *     declared landing always   31/35 = 89%   clear 29/29 = 100%   blocked 2/6 = 33%
   *     always re-aim             29/33 = 88%   clear 27/30 =  90%   blocked 2/3 = 67%
   *
   * The same overall, and opposite where it matters. The declared landing is the one
   * somebody walked, and on a clear line it does not miss. Re-aiming trades a little of
   * that for the only thing that helps when something is on the line. So there is nothing
   * to choose between them: keep the declared line while it is clear, and go looking only
   * when it is not.
   *
   * A falling body is clipped by anything in a square it passes THROUGH, which is why
   * distance is measured to the SEGMENT from the take-off rather than to the landing.
   * Candidates are the declared landing's own shelf — neighbours on the same floor — so
   * this stays a variation on a walked jump rather than a new claim about the map.
   */
  clearestLanding(here, target, geo) {
    if (!here || !target || !geo) return target;
    const CLEAR = 1.5;                       // squares; below this something is on the line
    try {
      const floorAt = (r, c) => { const sp = geo.standPoint?.(r, c);
                                  return sp ? (geo.floorBaseAtClient?.(sp.x, sp.y) ?? null) : null; };
      // WHERE THE JUMP IS MEANT TO END UP. Not the aim — the FLOOR the aim is for. Ukgoth's
      // shelf is 3840 and the gulley beside it is 3200, and an aim is only worth considering
      // if the arc it produces finishes on the first.
      const wantFloor = (() => {
        const a = fallPhysics(here, target, floorAt);
        return a?.ok ? floorAt(a.lands.row, a.lands.col) : floorAt(target.row, target.col);
      })();
      if (wantFloor == null) return target;

      const bodies = [...(this.client?.room?.objects?.values?.() ?? [])]
        .filter(o => blocksMovement(o.flags ?? 0) && o.id !== this.client?.selfId
                     && Number.isFinite(o.row) && Number.isFinite(o.col));
      const gapTo = (cand) => {
        if (!bodies.length) return Infinity;
        const vx = cand.col - here.col, vy = cand.row - here.row;
        const len2 = vx * vx + vy * vy;
        return Math.min(...bodies.map(o => {
          const wx = o.col - here.col, wy = o.row - here.row;
          const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
          return Math.hypot(here.col + t * vx - o.col, here.row + t * vy - o.row);
        }));
      };
      if (gapTo(target) >= CLEAR) return target;

      // THREAD THE NEEDLE, BUT ONLY THROUGH AIMS THE BODY CAN ACTUALLY REACH.
      //
      // The first version of this picked whichever square was furthest from the blockers and
      // scored 1/10 against 5/10, because on this cliff that is always the aim furthest out
      // of reach — it chose 38,8, an 8.2-square jump from a ledge with about 3.8 squares of
      // carry. Distance from a troll is not the constraint; the arc is.
      //
      // So every candidate is put through the same ballistics the operator's own jump was
      // measured with, and kept only if it FINISHES ON THE SAME FLOOR the declared jump
      // finishes on. Measured offline from 36,16: aiming at 39,12 lands 39,12 on the shelf,
      // aiming at 38,13 lands 38,12 on the shelf, and the declared 38,10 lands 37,13 on an
      // intermediate ledge — so there are genuinely several ways down, and only some of them
      // are reachable. Among those, the clearest line wins; ties keep the declared aim.
      let best = { cand: target, gap: gapTo(target) };
      for (let dr = -1; dr <= 1; dr++) for (let dc = -3; dc <= 3; dc++) {
        const cand = { row: target.row + dr, col: target.col + dc };
        if (!dr && !dc) continue;
        if (geo.walkable(cand.row, cand.col) !== true) continue;
        const arc = fallPhysics(here, cand, floorAt);
        if (!arc?.ok) continue;
        const lands = floorAt(arc.lands.row, arc.lands.col);
        if (lands == null || Math.abs(lands - wantFloor) > 96) continue;   // not our shelf
        const gap = gapTo(cand);
        if (gap > best.gap + 0.01) best = { cand, gap };
      }
      return best.cand;
    } catch { return target; }
  }

  // COORDINATE CONTRACT: this movement API is `(col,row)`; geometry calls inside
  // it deliberately adapt to `(row,col)`.
  // A STEP THAT SENT NOTHING MUST NOT CHAIN INTO THE NEXT ONE WITHOUT A REAL YIELD. A refused
  // step returns through a settled await, which is a microtask and not a turn of the event
  // loop; a loop of them starves the keepalive, the HTTP server and the stall monitor for as
  // long as the loop runs (45 s measured on 2026-09-02 with every needle inside it clocked
  // at 400 ms). One macrotask yield per packetless result is the difference. Guarded by
  // `typeof` at every call site, because the fixtures lift those loops by text.
  async _yieldIfPacketless(r) {
    if (r?.moved || r?.left_room || (r?.travelled ?? 0) > 0 || r?.reason === 'raw_move_rejected') return;
    await new Promise(res => setTimeout(res, 25));
  }
  async step(col, row, { confirm = false, beforeMutation = null, fall = false } = {}) {
    const c = this.need();
    const roomId = c.room.id;
    const before = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : null;
    // NO RE-AIM HERE, AND THE MEASUREMENT IS WHY.
    //
    // A re-aim was wired in at this exact point and made things strictly worse: ten trials
    // from the same square at the same vigor went 9 into the gulley and 1 dead, against
    // 3 for 3 landing cleanly without it. The telemetry says what it chose — "line to 38,10
    // was blocked; aiming 38,8 instead" — and 38,8 is a LONGER jump than the declared one,
    // 8.2 squares against 6.3 from a take-off whose ballistic reach is about 3.8 before the
    // intermediate shelves are counted. `clearestLanding` maximises distance from bodies
    // and knows nothing about whether the body can physically arrive, so on this cliff its
    // best answer is always the one furthest out of reach.
    //
    // The declared landing is the square an operator actually walked to. Until a re-aim can
    // be told what is REACHABLE as well as what is clear, holding that line beats guessing:
    // 3/3 against 1/10, measured the same afternoon on the same character.
    // A DECLARED JUMP THE BODY CANNOT RUN IS REFUSED HERE, BECAUSE HERE IS THE ONLY PLACE
    // EVERY FALL PASSES THROUGH.
    //
    // The first attempt at this gate went into `followRail`, and it never fired once: the
    // fleet reached Ukgoth 9 times out of 9 and then failed 599 -> 2 sixteen times with
    // `every square for that exit refused`, which comes from `leaveViaAny`. The jump is
    // taken by the ORDINARY WALKER following a planned fall edge, not by the rail. Putting
    // the check on the primitive covers the walker, the rail, the planner's waypoints and
    // anything added later, which is the whole argument for choosing a choke point over a
    // call site.
    //
    // REFUSE, DO NOT REST. Resting is a minute of blocking work and this is a primitive
    // that callers expect to return in milliseconds; `followRail` still owns sitting down
    // on the ledge. What this must guarantee is only that a body which cannot run never
    // LEAVES the ledge, because the gulley it lands in has no exit.
    // DECLARED OUT HERE, BECAUSE THE AIM IS READ OUT HERE.
    //
    // This was `let laneAim` INSIDE the block below, and the fall's aim is chosen a hundred
    // lines further down in the enclosing scope -- so every fall that reached the aim threw
    // `laneAim is not defined`. A ReferenceError in the mover is not a refused step: the pass
    // dies, the keeper's whole tick dies with it, and the character stands there. Seen in
    // PRODUCTION as `pass failed  why: laneAim is not defined`, and it killed somebody.
    //
    // `node --check` cannot see this -- the code is syntactically perfect -- and the dependency
    // guard in m59-collision-test only knows about MODULE-scope names, so a local declared in
    // the wrong block passes both. The test below pins the position rather than the spelling.
    let laneAim = null;   // set by laneClearing; the fall aims here when it exists
    if (fall && before) {
      const vig = (() => { try { return c.vitals?.()?.vigor?.value ?? null; } catch { return null; } })();
      const isDeclared = declaredJumpNeedsRun(this.world?.room?.num, before, { row, col });
      if (Number.isFinite(vig) && vig < RUN_VIGOR_FLOOR && isDeclared) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'declared_jump', trigger: 'refused_no_run', worked: false,
                       ms: 0, hp_lost: 0, attempted: true,
                       note: `from ${before.row},${before.col} to ${row},${col} at vigor ${vig}` });
        return { moved: false, left_room: false, position: before,
                 reason: 'jump_needs_run',
                 note: `this declared jump needs a run and vigor is ${vig} against a floor of ` +
                       `${RUN_VIGOR_FLOOR}; refusing rather than falling short of the landing` };
      }
      // EVERY FALL STEP LEAVES A RECORD, AND THAT INCLUDES THE ONES THAT WORK.
      //
      // Three rounds were spent arguing about this jump from the outside, off transit rows
      // that only ever say the HOP failed. What nobody could see was the attempt itself:
      // where the body left from, what its vigor was at that instant, and what was standing
      // in the line. A falling body is clipped by whatever it passes THROUGH — which is why
      // waiting and jumping blind both go 0 against a blocker — so the neighbours matter as
      // much as the vigor.
      //
      // Recorded on every fall rather than only on declared ones: a fall the table does not
      // describe is exactly the case worth seeing, and `worked` is left false because this
      // side cannot yet know where the body ends up. The landing is read off position by
      // whoever is watching; this row says what was attempted.
      // THE GAP TO THE FLIGHT LINE, NOT THE DISTANCE TO THE JUMPER.
      //
      // The first version of this logged everything within three squares of the take-off and
      // therefore flagged all twelve attempts, successes and failures alike — an indicator
      // that fires every time separates nothing. What matters is how close a body is to the
      // LINE the falling character travels along, because that is what clips it.
      //
      // BLOCKERS ONLY, decided by the server's own MOVEON bits. A corpse that the server
      // marks walk-through is not an obstacle and must not delay or divert anybody; the
      // operator is explicit that dead bodies do not block, and `blocksMovement` is where
      // that question is already answered for movement, so it is the same answer here.
      // READ THE RAW ROOM OBJECTS, NOT `world.objects()`.
      //
      // `World.objects()` returns a PROJECTION — id, name, col, row, can, is_player — and
      // it does not carry `flags`. So `blocksMovement(o.flags ?? 0)` asked MOVEON of zero,
      // which is MOVEON_YES, which is "walk through", for every object in the room. The
      // filter therefore emptied the list and the sensor reported `linegap clear` on
      // sixteen consecutive jumps taken past three Guardians of Zjiria standing beside the
      // landing. An indicator that can only say one thing is worse than none, because it
      // gets believed: it very nearly produced the finding "a clear line lands 16/16".
      //
      // `c.room.objects` is where the flags live, and it is the same source
      // `queueValidatedMove` filters for real collision — so the answer here and the answer
      // the mover enforces come from one place.
      // A BODY IN A GULLY IS NOT ON THE LINE. IT IS UNDER IT.
      //
      // This measured distance from `o.col`/`o.row` alone — squares, flat — so anything sharing
      // a square with the arc counted as blocking it however far below it stood. A fall-jump is
      // the one move where that is routinely wrong: the whole point of it is that the ground in
      // between is at a different height.
      //
      // The Sewers of Barloque, row 27, is the case that makes it undeniable
      // (tools/fixtures/sewers-108-row27.json):
      //
      //     28,43  floor 2304      the take-off
      //     27,43  floor  820      the gully — six giant rats standing in it, one per square
      //     26,43  floor 1920      the landing
      //
      // The arc runs 2304 -> 1920 and the rats are ELEVEN HUNDRED UNITS BELOW IT. Flat, the rat
      // at 27,43 reads as gap 0 and the jump can never be taken; it waits three times, re-aims,
      // logs, and repeats for as long as the rat stands there — which is for ever, because the
      // rats in that fixture never moved across seventy seconds of observation.
      //
      // The rule is the same one CLAUDE.md puts in capitals about floor, applied to bodies: a
      // square is a summary. A body can only clip a jump if it is at a height the jump passes
      // through, and `PLAYER_HEIGHT` is the client's own figure for how tall one is. Anything
      // more than that below the LOWER end of the arc is under the traveller's feet.
      //
      // Conservative in the direction that matters: an unknown floor counts as ON the line, so
      // a body we cannot place is still respected. Only a body we can prove is beneath the arc
      // is discounted.
      // THERE IS NO JUMPING OVER ANYTHING. Corrected 2026-08-29, from the operator, who has
      // played this client: "Meridian 59 is merciless on enforcing collisions regardless of
      // vertical disparities. There is no jumping over anything except the parts of the world
      // that exist in the .roo files."
      //
      // What was here discounted any body more than PLAYER_HEIGHT below the arc -- so the
      // giant rats standing in the gully at 27,43, 1484 units beneath a jump that leaves from
      // 2304, read as not being there at all. That is a rule for a game with ballistic arcs
      // and this is not one: a body in a square you pass through clips you whatever its floor
      // is. The exemption is gone, which makes this STRICTER, and the lane below pays for it.
      //
      // AND THE GAP IS MEASURED IN FINE UNITS, NOT SQUARES.
      //
      // `DECLARED_CLEAR` was 1.5 SQUARES and the old measure differenced `o.col` against
      // `before.col`, so a rat at the CENTRE of a square the line crosses measured zero and
      // the jump was refused outright. That is the error this file warns about in capitals:
      // a square is a summary, and on interesting ground a false one. The real question is
      // whether a body of MIN_NOMOVEON clears, and at column 43 of the Sewers it does -- 16
      // units west of a centred rat, 20 east, both with take-off and landing floor beneath
      // them. The operator's framing: a stationary blocker is the BEST case, because nothing
      // has to be timed, you just pick a side.
      const NOMOVEON_KOD = MIN_NOMOVEON / (CLIENT_FINENESS / KOD_FINENESS);   // 16, in wire units
      const bodyPoints = () => { try {
        return [...c.room.objects.values()]
          .filter(o => blocksMovement(o.flags ?? 0) && o.id !== c.selfId
                       && (Number.isFinite(o.x) || Number.isFinite(o.col)))
          .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                       y: o.y ?? (o.row * KOD_FINENESS + 32),
                       name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      } catch { return []; } };
      const gapAlong = (ax, ay, bx, by, bodies) => {
        if (!bodies.length) return { gap: Infinity, who: [] };
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
        let best = Infinity, who = [];
        for (const o of bodies) {
          const t = len2 ? Math.max(0, Math.min(1, ((o.x - ax) * vx + (o.y - ay) * vy) / len2)) : 0;
          const d = Math.hypot(ax + t * vx - o.x, ay + t * vy - o.y);
          if (d < best) { best = d; who = [o.name]; } else if (d < best + 0.01) who.push(o.name);
        }
        return { gap: best, who };
      };
      const fromX = before.x ?? (before.col * KOD_FINENESS + 32);
      const fromY = before.y ?? (before.row * KOD_FINENESS + 32);
      const toXc = col * KOD_FINENESS + 32, toYc = row * KOD_FINENESS + 32;
      const measureLineGap = () => gapAlong(fromX, fromY, toXc, toYc, bodyPoints());

      // A LANE IS THE SAME JUMP, SHIFTED SIDEWAYS. Same take-off square, same landing square,
      // same distance -- so it cannot repeat the 1/10 result recorded below, which came from
      // choosing a FURTHER landing the body could not reach. Only the line moves.
      //
      // Offsets are tried nearest-first, and a candidate is kept only if both ends still have
      // floor: a lane that leaves the take-off ledge or misses the landing shelf is not a
      // lane, it is a fall.
      const laneClearing = () => {
        const g = this.world?.geometry;
        if (typeof g?.floorBaseAtClient !== 'function') return null;
        const bodies = bodyPoints();
        if (!bodies.length) return null;
        const dx = toXc - fromX, dy = toYc - fromY;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        const hasFloor = (x, y) => { try {
          return Number.isFinite(g.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
        } catch { return false; } };
        let best = null;
        for (let off = 4; off <= 28; off += 2) {
          for (const sign of [1, -1]) {
            const ox = px * off * sign, oy = py * off * sign;
            const ax = Math.round(fromX + ox), ay = Math.round(fromY + oy);
            const bx = Math.round(toXc + ox), by = Math.round(toYc + oy);
            if (!hasFloor(ax, ay) || !hasFloor(bx, by)) continue;
            const m = gapAlong(ax, ay, bx, by, bodies);
            if (!(m.gap >= NOMOVEON_KOD)) continue;
            if (!best || m.gap > best.gap) best = { x: bx, y: by, gap: m.gap, off: off * sign };
          }
          if (best) break;
        }
        return best;
      };
      const lineGap = measureLineGap();
      // WAIT FOR THE LINE, RATHER THAN RE-AIMING AROUND IT.
      //
      // Re-aiming was tried here and measured 1/10 against 5/10: `clearestLanding` picks the
      // square furthest from bodies and knows nothing about reach, so on this cliff it chose
      // 38,8 — a longer jump than the declared one — and fell short every time. The other
      // half of the same old measurement is the one that survives: a CLEAR LINE lands 29/29,
      // and waiting scored 100% on a clear line where jumping blind scored 50%.
      //
      // So the aim never moves. What changes is WHEN. A falling body is clipped by anything
      // in a square it passes through, monsters wander, and a second or two is cheap against
      // a gulley that costs a lap of Ukgoth to escape.
      //
      // 1.5 squares is not a new number: it is `DECLARED_CLEAR`, from the 68-jump study
      // already in this file. Bounded hard — this is a primitive, callers expect it back
      // quickly, and a doorway held by something that never moves must still end the walk.
      const JUMP_WAITS = Number(process.env.M59_JUMP_WAITS || 3);
      const JUMP_WAIT_MS = Number(process.env.M59_JUMP_WAIT_MS || 1200);
      let waited = 0, gapNow = lineGap;
      if (isDeclared) {
        while (Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD && waited < JUMP_WAITS) {
          await new Promise(r => setTimeout(r, JUMP_WAIT_MS));
          waited++;
          gapNow = measureLineGap();
        }
        if (waited) {
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                         tactic: 'declared_jump', trigger: 'waited_for_line',
                         worked: !(Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD),
                         ms: waited * JUMP_WAIT_MS, hp_lost: 0, attempted: true,
                         note: `line was ${Number(lineGap.gap).toFixed(2)}; after ${waited} wait(s) ` +
                               `it is ${gapNow.gap === Infinity ? 'clear' : Number(gapNow.gap).toFixed(2)}` });
        }
        // WAITING FIRST, THREADING SECOND — because a blocker that wanders costs nothing to
        // outlast and the aim that worked is the one somebody walked. But some of them do
        // not wander: measured here, `line was 0.95; after 3 wait(s) it is 0.95` twelve
        // times running, all twelve into the gulley. Against a troll that has decided to
        // stand there, waiting is just a slower way to jump blind.
        //
        // So once the line has failed to clear, look for another aim — and `clearestLanding`
        // now only offers aims whose ARC finishes on the same shelf, so this cannot repeat
        // the 1/10 mistake of choosing a landing the body cannot reach.
      }
      // THE LANE IS FOR EVERY FALL, NOT ONLY A DECLARED ONE.
      //
      // Everything above sat behind `isDeclared`, and the traffic does not. Twelve characters
      // staged into the Cragged Mountains produced 1,103 fall attempts in nine minutes -- every
      // one an `undeclared_fall`, every blocker one of our own bots standing on the line
      // (`linegap 1.00 (Llll)`, `linegap 0.00 (Hhhh)`) -- and not one reached a wait, a lane
      // or a re-aim, because none of that runs for an ordinary fall. They retried until the
      // run ended.
      //
      // The lane costs one pass over the blockers and no waiting, so there is no reason it was
      // ever the privilege of a declared jump. The WAIT stays declared-only (three seconds on
      // every ordinary fall is not affordable) and so does `clearestLanding`, which moves the
      // destination and is the one that measured 1/10.
        // A LANE FIRST, AND ONLY THEN A DIFFERENT LANDING. Shifting the line sideways keeps
        // the declared take-off and landing, so reach is unchanged by construction -- which is
        // why the 1/10 result below does not apply to it. Changing WHERE you land is the thing
        // that fell short; changing which side of the blocker you pass is not.
        if (Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
          const lane = laneClearing();
          if (lane) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'declared_jump', trigger: 'lane', worked: true, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `line to ${row},${col} was ${Number(gapNow.gap).toFixed(1)} `
                                 + `(${gapNow.who.join(', ')}); took the lane ${lane.off > 0 ? '+' : ''}${lane.off} `
                                 + `for ${lane.gap.toFixed(1)} of clearance` });
            laneAim = { x: lane.x, y: lane.y };
            gapNow = { gap: lane.gap, who: [] };
          }
        }
        if (isDeclared && Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
          const threaded = this.clearestLanding(before, { row, col }, this.world?.geometry);
          if (threaded && (threaded.row !== row || threaded.col !== col)) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'declared_jump', trigger: 'threaded', worked: false, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `line to ${row},${col} stayed at ${Number(gapNow.gap).toFixed(2)}; ` +
                                 `threading to ${threaded.row},${threaded.col} instead` });
            row = threaded.row; col = threaded.col;
            gapNow = measureLineGap();
          }
        }
      // AN ORDINARY FALL THE LANE COULD NOT CLEAR IS A REFUSAL, NOT A RETRY.
      //
      // A declared jump has somewhere else to go from here -- it waits, and it re-aims. An
      // ordinary fall has neither, and without this it returned an unremarkable failure that
      // the walker replanned and tried again, at about twelve attempts a second per character.
      // `fall_blocked_by_body` is terminal, so the caller stops and the road is reported shut
      // rather than being hammered. Both sides of the blocker have already been tried by the
      // time this is reached.
      if (!isDeclared && Number.isFinite(gapNow.gap) && gapNow.gap < NOMOVEON_KOD) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'fall', trigger: 'blocked_no_lane', worked: false, ms: 0,
                       hp_lost: 0, attempted: false,
                       note: `${before.row},${before.col} -> ${row},${col} line ${Number(gapNow.gap).toFixed(1)} `
                             + `(${gapNow.who.join(', ')}); no lane clears it` });
        return { moved: false, left_room: false, position: before,
                 reason: 'fall_blocked_by_body',
                 note: `something is on the line of this fall and neither side of it clears; `
                       + `waiting is a declared jump's remedy, not an ordinary fall's` };
      }
      // WHAT THIS ROW IS, AND WHY IT IS NOT A FAILURE.
      //
      // It is written BEFORE the jump is attempted — it records the line as measured, so that a
      // jump that goes wrong can be read against what was known at the time. `worked: false`
      // was hardcoded here, and the ledger has no other state for "not an outcome", so this
      // became the largest entry in the whole book and the largest entry in its
      // SPENDING TIME AND NOT WORKING section:
      //
      //     declared_jump on undeclared_fall: 0/1616 (prod), 0/5524 (shadow)
      //
      // Nothing was failing. It is one row per candidate landing per evaluation — thirteen of
      // them share a single timestamp in Rowlf's log, and the row immediately after is a rail
      // boarded successfully — so the count is the number of aims considered, not attempts, and
      // the 0% is a constant. Read as a tactic it says the fleet cannot jump; read correctly it
      // says nothing at all about outcomes.
      //
      // It cost an hour of this session: 244 rows from one square read as 244 stuck attempts,
      // and a character that had already moved on read as pinned. The ledger is what every
      // movement question gets asked of, so a row that cannot be right is worse than no row.
      //
      // `attempted: false` is the honest label. `recordTactic` scores `worked ? ok : fail` and
      // the ledger's own note says a row for a DECISION rather than an attempt is what made
      // Ukgoth read as an 84% rail failure — the same mistake, already written down.
      recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                     tactic: 'declared_jump', trigger: isDeclared ? 'declared' : 'undeclared_fall',
                     worked: false, ms: 0, hp_lost: 0, attempted: false,
                     note: `line as measured, before the jump: ` +
                           `${before.row},${before.col} -> ${row},${col} vigor ${vig ?? '?'} ` +
                           `linegap ${gapNow.gap === Infinity ? 'clear' : Number(gapNow.gap).toFixed(2)}` +
                           (gapNow.who.length ? ` (${gapNow.who.slice(0, 2).join(', ')})` : '') +
                           (waited ? ` after ${waited} wait(s)` : '') });
    }
    // Turn to face the destination first. It costs nothing, it is what a player
    // does, and several things in this game care about facing.
    //
    // FACE COALESCING (the packet-throttle fix, docs/packet-throttle.md). The session used to
    // send a turn packet BEFORE EVERY move, so a walk produced a turn+move pair every tick
    // (~4-6/s) which tripped the server's 5/s throttle. A player only turns when the heading
    // actually changes. Compare the requested heading against our current facing (c.self.degrees,
    // kept up to date by server pushes) and only send a turn when it differs by more than
    // FACE_EPS. This drops turn production from ~4/s to near zero while tracking.
    if (before && (before.col !== col || before.row !== row)) {
      const deg = (Math.atan2(row - before.row, col - before.col) * 180 / Math.PI + 360) % 360;
      const curDeg = c.self?.degrees;
      // COMBAT-FACING LOCK. If the combat controller just faced a target (to swing), do NOT
      // re-face to the movement heading. Re-facing to the walk direction overrode the combat
      // facing, making the character oscillate between the target and the heading, so every
      // melee swing landed on a target behind the facing line (rejected by the server's
      // view-cone check, player.kod ~4185). Honor the combat face for COMBAT_FACE_HOLD_MS.
      const cf = c._combatFacing;
      const combatHolding = cf && (Date.now() - cf.at) < COMBAT_FACE_HOLD_MS;
      const facingChanged = !combatHolding && (curDeg == null ||
        (() => { const a = ((curDeg % 360) + 360) % 360, b = ((deg % 360) + 360) % 360;
                 const d = Math.abs(a - b); return Math.min(d, 360 - d) > FACE_EPS; })());
      if (facingChanged) {
        await this.pacer.submit('turn', () => {
          if (c.room.id !== roomId) return false;
          if (typeof beforeMutation === 'function') beforeMutation('turn', { col, row });
          return c.face(deg);
        });
      }
    }
    if (c.room.id !== roomId) return {
      moved: false, position: c.self ? { x: c.self.x, y: c.self.y,
        col: c.self.col, row: c.self.row } : null,
      left_room: true, reason: 'room_changed_before_move',
    };
    const speed = this.moveSpeed();
    // PACE BY DISTANCE, NOT BY PACKET. A hop may now cover several squares, so a fixed
    // gap between packets would make a five-square hop arrive five times too early —
    // which is the actual definition of speedhacking, and would be visible as such.
    //
    // The gap owed is for the hop just SENT, and `minGapForKind` is applied against the
    // previous send of this kind, so it is carried on the session rather than computed
    // here from the current hop. A single square at a run is 200ms; five squares is a
    // full second. Both are the same 5 squares/second.
    const gap = this._moveGapMs ?? MOVE_INTERVAL_MS;
    const dist = before ? Math.max(Math.abs(col - before.col), Math.abs(row - before.row)) : 1;
    // AND A LONG HOP WAITS FOR ITS OWN LENGTH AS WELL AS FOR THE ONE BEFORE IT.
    //
    // The gap owed is computed from the hop just SENT, which keeps the average rate honest
    // and says nothing about a single packet. user.kod:3049 checks the single packet:
    // `iSquaredDistance >= 200` with under three seconds since the last update is logged as
    // a possible speedhacker and charged exertion. So a thirteen-square hop arriving a fifth
    // of a second after a one-square one is exactly the shape that trips it. Waiting this
    // hop's own duration first is also simply true — a body cannot cross thirteen squares
    // in less time than it takes to run them.
    const owed = Math.round(1000 * dist / squaresPerSecond(speed));
    // THE ONE PLACE A PLANNED SQUARE BECOMES A PACKET, so it is the one place the aim can
    // diverge from the plan. `moverStepLands` decides what to plan by tracing between the
    // two squares' STAND POINTS; if this kept aiming at centres, the router would be
    // authorising steps against one point and the mover attempting them against another —
    // the exact split this whole subsystem exists to close.
    //
    // For every square whose centre is floor `standPointWire` returns `col * KOD_FINENESS
    // + half` exactly, so ordinary movement is unchanged to the byte and only a square a
    // wall cuts in half moves at all. Measured in Western border of the Twisted Wood: 1406
    // squares identical to their centre — precisely the count the coarse grid calls
    // walkable — and 299 moved, none of which the grid had accepted.
    //
    // Falls back to the centre when there is no geometry, which is both the honest answer
    // for a room with no collision payload and what keeps this method liftable: it had no
    // dependency on `this.world` at all before, and one of its test fixtures has none.
    // AND FROM WHERE WE ACTUALLY ARE. See aimInto: the stand point is what the router
    // priced, and it is not always reachable from a body that has slid off one.
    //
    // NOT FOR A FALL, THOUGH. `fallTargets` proved this exact pair of stand points and
    // nothing else, so hunting for a different point inside the landing square would be
    // asking a question nobody answered — and every one of those nine traces is in walk
    // mode, which is the predicate that refuses a fall in the first place.
    const half = KOD_FINENESS >> 1;
    // `laneAim` is the same landing square entered on the side that clears the blocker --
    // see laneClearing. Null when nothing was in the way, so an unobstructed jump aims at the
    // stand point exactly as before and is unchanged to the byte.
    let aim = fall
      ? (laneAim
         ?? this.world?.geometry?.standPointWire?.(row, col)
         ?? { x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half })
      : null;

    // A LANE CHANGE IS A STEP OF ITS OWN. `threadInto` decides whether this one needs one and
    // returns both halves; the argument, the measurements and why a diagonal cannot do it are
    // on the method. A fall never asks — it is already leaving the floor.
    if (!fall) {
      const threaded = this.threadInto(before, row, col);
      aim = threaded.aim;
      // A squeeze can cost more than one packet. Each waypoint is a proved leg from the last, so
      // they go in order; the first that does not send stops the sequence rather than skipping
      // ahead, because a leg whose start never happened proves nothing about the leg after it.
      let last = null;
      for (const via of threaded.vias ?? []) {
        const stepped = await this.queueValidatedMove(via.x, via.y,
          { speed, slide: true, minGap: MOVE_INTERVAL_MS, expectedRoomId: c.room.id })
          .catch(() => null);
        if (!stepped?.sent) break;
        last = via;
      }
      // Re-aim from where the body ACTUALLY ended up, not from where it was sent: a leg that
      // clipped short leaves the next one starting somewhere else, and aiming from the intended
      // point is how a walk drifts off a proof it still believes in.
      if (last) aim = this.aimInto(c.self ?? last, row, col);
    }
    // SLIDING STAYS ON FOR A FALL TOO. The flag that matters is `fall`, which is what lets
    // a body leave a ledge at all; `slide` only decides whether an endpoint the trace
    // cannot reach exactly is clipped back or refused outright. Turning it off made a fall
    // all-or-nothing from a body that is rarely exactly on the take-off stand point the
    // router priced — measured: Ukgoth 2,27 -> 71,2 went from 1.04x to bouncing on 12 of 13
    // steps. Both `{ slide: true, fall: true }` and `{ slide: false, fall: true }` arrive on
    // the step that started this; only the missing `fall` ever refused one.
    const queued = await this.queueValidatedMove(aim.x, aim.y, { speed, slide: true, fall,
        beforeMutation: typeof beforeMutation === 'function'
          ? () => beforeMutation('move', { col, row }) : null,
        minGap: Math.max(gap, owed), expectedRoomId: roomId });
    // `col`/`row` are `step`'s ARGUMENTS, which are where it is going — not where it is.
    // The first cut of this called them `from`, and a trace of an oscillating walk then read
    // as a character teleporting between two distant squares. Both ends are recorded now:
    // `at` is the body, `target` is the aim, and a loop is the pair repeating.
    traceMove({ agent: this.name, room: this.world?.room?.num ?? null, kind: 'step',
                square: c.self ? { col: c.self.col, row: c.self.row } : null,
                target: { col, row }, to: { x: aim.x, y: aim.y }, sent: !!queued.sent,
                reason: queued.validation?.reason ?? null });
    if (!queued.sent) {
      const validation = queued.validation ?? {};
      const leftRoom = c.room.id !== roomId;
      const at = c.self ? { x: c.self.x, y: c.self.y, col: c.self.col, row: c.self.row } : before;
      return { moved: false, position: at, left_room: leftRoom,
               geometry_blocked: validation.blocked !== false,
               reason: validation.reason ?? 'geometry_blocked', note: validation.note };
    }
    this._moveGapMs = owed;
    // Predict, the way the real client does.
    const target = queued.target;
    c.predictSelf({ x: target.x, y: target.y,
                    col: Math.floor(target.x / KOD_FINENESS),
                    row: Math.floor(target.y / KOD_FINENESS) });
    // AND RESYNC ON A CLOCK, AT MOST — BUT DO NOT STAND STILL FOR IT.
    //
    // This awaited the reply, and the reply is a 1.2-5.6s round trip. So a walk ran for
    // six seconds, froze for one to five, ran for six. That is the visible jerk, and it
    // is the reason a fleet character does not move like a person even when every other
    // number is right: the pauses are not pacing, they are us waiting.
    //
    // Nothing in the next step needs the answer. Position is dead-reckoned and the
    // server does not echo our own moves, so the re-read is for the OBJECT MAP —
    // furniture, monsters, loot — and the walker only consults that when it replans.
    // The reply lands on the event stream and updates the room whenever it arrives,
    // which is exactly as good a few hundred milliseconds later.
    //
    // So it is fired and not awaited. `confirm: true` still blocks, because the one
    // caller that passes it genuinely needs to know where it ended up — and
    // confirmPosition(), before crossing out of a room, is the other place we still pay
    // for the truth on purpose.
    if (confirm) {
      const confirmed = await this.confirmPosition();
      if (!confirmed) return { moved: false, position: null, left_room: false,
                               reason: 'position_confirmation_timeout', predicted: true };
    } else if (Date.now() - (this.lastRoomRead ?? 0) >= ROOM_RESYNC_MS) {
      this.lastRoomRead = Date.now();
      // Not awaited. A failure here is not a movement failure — the walk carries on
      // with a slightly older object map, which is the state it was already in.
      this.pacer.submit('read', () => c.roomContents()).catch(() => {});
    }
    const after = c.self;
    return {
      moved: !!after && (!before || after.x !== before.x || after.y !== before.y),
      position: after ? { x: after.x, y: after.y, col: after.col, row: after.row } : null,
      // Still honest without a re-read: crossing a boundary brings a fresh BP_PLAYER and
      // the client rebuilds the room, so our own id is genuinely absent from the new one
      // until contents land. That is the answer this wants.
      left_room: !c.room.objects.has(c.selfId),
      // So a caller can tell a confirmed position from a predicted one rather than having
      // to know this function's internals.
      predicted: !confirm && !!after?.predicted,
      locally_validated: true,
      ...(queued.validation.blocked ? { geometry_blocked: true,
        clipped: queued.target, requested: queued.validation.requested,
        reason: queued.validation.reason } : {}),
    };
  }

  // ------------------------------------------------------- fine movement
  //
  // THE SQUARE GRID CANNOT DESCRIBE A LEDGE, AND MERIDIAN HAS MANY.
  //
  // The .roo carries movement as one byte per SQUARE — eight direction bits, 64
  // fine units to the square. A walkable strip narrower than one square has
  // nowhere to live in that structure, so the square reads solid and the ordinary
  // pathfinder refuses the route before sending a packet. The cliff path in
  // Kardde's Canyon that is the only way into the Badlands is exactly this: present
  // in the fine BSP, absent from the grid.
  //
  // The server does not use that grid — or validate player geometry at all. The real
  // client clips movement against the fine BSP before it sends a position. We must do
  // the same locally; asking the server to judge is precisely how a bot crosses walls.
  //
  // Two rules make it work, and both were learned the hard way:
  //
  //  * VALIDATE BEFORE SENDING. The server accepts player coordinates; a room read is
  //    confirmation of state, never a collision oracle.
  //  * WHEN BLOCKED, SLIDE. A locally clipped step usually means the straight line touched
  //    rock, not that the way is shut. Fanning the heading out to either side is
  //    what "hugging the wall" actually is, and it is how a human gets along a
  //    ledge without falling off it.
  // COORDINATE CONTRACT: `(x,y)` is a fine point in kod wire units.
  async stepFine(x, y) {
    const c = this.need();
    const startRoom = c.room.id;
    if (this.finePositionUnknown) {
      const recovered = await this.confirmPosition();
      if (!recovered) return { moved: false, left_room: false,
        reason: 'position_confirmation_timeout',
        note: 'no further fine packet was sent because its starting point is unknown' };
      this.finePositionUnknown = false;
    }
    const p0 = c.self;
    const before = p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null;
    if (!before) return { moved: false, left_room: false, reason: 'own_position_unknown' };
    const queued = await this.queueValidatedMove(x, y,
      { speed: this.moveSpeed(), slide: true, minGap: MOVE_INTERVAL_MS });
    const validation = queued.validation ?? {};
    if (!queued.sent) {
      // In keeper mode, if the collision check rejected the move
      // due to geometry (stale .roo), send it anyway. The server
      // will accept or reject based on its own geometry.
      if (process.env.M59_KEEPER && (validation.blocked || validation.reason) && validation.reason !== 'room_changed_before_move') {
        // DECLARED OUTSIDE THE TRY. It used to be `const c2` inside it, and the catch
        // below reads c2.room.id -- where it is out of scope. So any failure in this
        // branch made the ERROR HANDLER throw `ReferenceError: c2 is not defined`,
        // which destroyed the real error and propagated a crash to the caller. Seen
        // live as `reason=c2 is not defined (32792ms)`: a swallowed ReferenceError
        // wearing the costume of an ordinary refusal.
        let c2 = null;
        try {
          c2 = this.need();
          const rawTo = { x: Math.round(x), y: Math.round(y) };
          const rawSpeed = c2.moveSpeed() ?? 1;
          const rawRoomId = c2.room?.id ?? 0;
          const rawFrom = c2.self ? { x: c2.self.x, y: c2.self.y } : null;
          c2.moveTo(rawTo.x, rawTo.y, rawSpeed, rawRoomId);
          this.recordUnsafeWireMove?.({
            client: c2,
            roomId: rawRoomId,
            from: rawFrom,
            requested: rawTo,
            to: rawTo,
            speed: rawSpeed,
            offMap: false,
            unsafeReason: 'keeper_unvalidated_fallback',
            priorValidation: validation,
          });
          await new Promise(r => setTimeout(r, 300));
          const after = c2.self;
          if (after && before && (after.x !== before.x || after.y !== before.y)) {
            return { moved: true, position: { x: after.x, y: after.y, col: after.col, row: after.row },
                     left_room: c2.room?.id !== startRoom, travelled: Math.hypot(after.x - before.x, after.y - before.y),
                     raw_move: true };
          }
          return { moved: false, position: before, left_room: c2.room?.id !== startRoom,
                   reason: 'raw_move_rejected', note: 'server rejected the raw move' };
        } catch (e) {
          return { moved: false, position: before,
                   left_room: (c2?.room?.id ?? startRoom) !== startRoom,
                   reason: 'raw_move_error', note: e.message };
        }
      }
      return {
        moved: false, position: p0 ? { x: p0.x, y: p0.y, col: p0.col, row: p0.row } : null,
        left_room: c.room.id !== startRoom,
        geometry_blocked: validation.blocked !== false,
        reason: validation.reason,
        ...(validation.objectId != null ? { objectId: validation.objectId } : {}),
        note: validation.note ?? 'local client collision rejected this move before any packet was sent',
      };
    }
    const target = queued.target;
    // THIS USED TO BLOCK ON EVERY STEP, and it was the most expensive thing in the file.
    //
    // The old note said fine movement may clip or slide to a sub-square point, so prediction
    // cannot establish the starting point for the next local collision pass. That is the
    // right worry and the wrong conclusion: `validateFineTarget` COMPUTES the slide, the
    // packet carries `validation.target` — the already-clipped point — and the server takes
    // the coordinates it is sent. The endpoint is known before the packet leaves.
    //
    // See FINE_CONFIRM_EVERY for the measurement. Briefly: the read costs 203ms and, worse,
    // doubles the packet rate into a server that drops anything over five a second.
    //
    // A STEP THAT COULD HAVE GONE SOMEWHERE UNEXPECTED IS STILL READ BACK, IMMEDIATELY.
    // Prediction is only safe where this side already knows the answer, so anything that
    // means it might not — a room that changed under us, a clipped endpoint, a fall, or
    // simply too many predictions in a row — takes the round trip.
    const roomChanged = c.room.id !== startRoom;
    const clipped = validation.blocked === true
      || target.x !== Math.round(x) || target.y !== Math.round(y);
    this._finePredicted = (this._finePredicted ?? 0) + 1;
    const mustConfirm = roomChanged || clipped
      || this._finePredicted >= FINE_CONFIRM_EVERY
      || FINE_CONFIRM_EVERY <= 1;

    if (!mustConfirm) {
      // The same call the pivot walk and the breadcrumb retreat already make. `predicted`
      // is set on the object, and the client clears it the moment the server says anything
      // about us — so a caller that genuinely needs to know whether a step HAPPENED can
      // still tell that it has not been told.
      c.predictSelf({ x: target.x, y: target.y,
                      col: Math.floor(target.x / KOD_FINENESS),
                      row: Math.floor(target.y / KOD_FINENESS) });
      const sentFrom0 = queued.before ?? before;
      return { moved: target.x !== sentFrom0.x || target.y !== sentFrom0.y,
               position: { x: target.x, y: target.y,
                           col: Math.floor(target.x / KOD_FINENESS),
                           row: Math.floor(target.y / KOD_FINENESS) },
               left_room: false, locally_validated: true, predicted: true,
               travelled: Math.hypot(target.x - sentFrom0.x, target.y - sentFrom0.y) };
    }

    const tFine = Date.now();
    const confirmed = await this.confirmPosition();
    Pacer.note('step_fine', 'blocked', Date.now() - tFine);
    this._finePredicted = 0;
    if (!confirmed) {
      this.finePositionUnknown = true;
      return { moved: false, position: null, left_room: c.room.id !== startRoom,
        locally_validated: true, reason: 'position_confirmation_timeout',
        note: 'the endpoint was safe, but no further fine move is allowed until position is re-observed' };
    }
    this.finePositionUnknown = false;
    const p1 = c.self;
    const sentFrom = queued.before ?? before;
    const after = p1 ? { x: p1.x, y: p1.y, col: p1.col, row: p1.row } : null;
    const moved = !!(sentFrom && after && (after.x !== sentFrom.x || after.y !== sentFrom.y));
    return { moved, position: after,
             left_room: c.room.id !== startRoom || !c.room.objects.has(c.selfId),
             travelled: moved ? Math.hypot(after.x - sentFrom.x, after.y - sentFrom.y) : 0,
             locally_validated: true,
             ...(validation.blocked ? { geometry_blocked: true, clipped: target,
                                         requested: validation.requested,
                                         reason: validation.reason } : {}) };
  }

  // Walk to a fine coordinate without consulting the square grid at all.
  // `stride` is how far to reach per request; a short stride hugs geometry more
  // closely but costs a second per step, since the move rate is one per second.
  // THE LAST MILE INTO A SAFE SPOT, AND THE TOOL IS NOT THE ONE YOU WOULD PICK.
  //
  // A SAFE WALL *IS* THE TWO GRIDS DISAGREEING. That is the entire mechanism and the reason
  // the fleet seeks these squares out: the coarse grid calls the square open, the BSP hems
  // it in, and a monster's pathing cannot follow. So the obvious conclusion is that the
  // square router — which plans stand point to stand point — is the wrong tool for the
  // approach, and that the fine grid should own the last mile.
  //
  // MEASURED, AND THAT CONCLUSION IS WRONG. Across 107 approaches to nominated safe spots
  // in the eleven rooms this fleet uses, from ordinary floor within ten squares:
  //
  //     walkTo    91/107   85%   the square lattice
  //     walkFine  74/107   69%   a greedy fan of nine headings that slides on purpose
  //     finePath  25/107   23%   A* on the quarter-square lattice
  //
  // The square walker is the BEST of the three, and `finePath` — the tool that looks most
  // like "plan the last mile properly" — is by far the worst. The reason is one line of it:
  // `moveLands` rejects any move whose slide ends more than ARRIVE_WITHIN from where it was
  // aimed, because an edge that goes somewhere else is not the edge being put in the graph.
  // That is correct for a route across open floor and fatal here, because a pocket the BSP
  // hems in is a place where EVERY move slides. The fine lattice is STRICTER than the square
  // walker, not more capable, and it has no edges at all in exactly the squares that make a
  // safe spot safe.
  //
  // So this is `walkFine`, which slides on purpose, and it is a FALLBACK rather than a
  // replacement: it is worse on average and it reaches two walls in the Cragged Mountains
  // that the square walker loses, which is the room the whole road turns on. Second, never
  // first, and free when the square walk works.
  //
  // (Widening or narrowing the search radius was tried too and is a wash in the wrong
  // direction: a nearer wall is reached more reliably — 88% at four squares against 83% at
  // ten — but is found so much less often that the share of characters that end up on a
  // wall at all falls from 68% to 51%. `travel_hold_within` stays at ten.)
  // COORDINATE CONTRACT: the destination square is `(col,row)`; optional `toX/toY`
  // are a named fine point in kod wire units.
  async approachFine(col, row, { toX = null, toY = null, maxSteps = 60, stride = 48,
                                 movementGeneration = this.movementGeneration,
                                 controlToken = null } = {}) {
    const c = this.need();
    const geo = this.world?.geometry;
    const me = c.self ?? await this.selfOrResync();
    if (!me || !Number.isFinite(me.x))
      return { arrived: false, reason: 'own_position_unknown' };
    if (!geo?.collisionReady)
      return { arrived: false, reason: 'collision_geometry_unavailable' };

    // The remembered fine position if there is one — it is a record of where a body
    // actually stood — otherwise the square's own stand point.
    const goal = (Number.isFinite(toX) && Number.isFinite(toY))
      ? { x: toX, y: toY }
      : (geo.standPointWire?.(row, col)
         ?? { x: col * KOD_FINENESS + (KOD_FINENESS >> 1),
              y: row * KOD_FINENESS + (KOD_FINENESS >> 1) });

    // A WALL SQUARE IS ONE THE MOVER REFUSES TO ENTER FROM ITS COARSE NEIGHBOURS. That is
    // not an obstacle to the safe-spot search, it is the DEFINITION of what it looks for
    // (safeSpots: coarseRefusesIt; gridDisagreementAt: refused approaches). So the straight
    // line into such a square, from a square the coarse grid offers, is precisely the step
    // the geometry declines — and walkFine's fan slides along the face instead of finding
    // the way round. Measured 2026-08-27 in the Valley of Ileria: 506 grid-disagreement
    // walls in the room, one of them a single square from Zoot, and every approach ended
    // "could not walk back to the square — ran out of steps" while the keeper's own
    // /findpath found the way in with a waypoint.
    //
    // TWO FINE A*s LIVE HERE AND ONLY ONE OF THEM CAN SEE A WALL SQUARE. walkTo's lattice
    // detour (`finePath`, 256-unit steps) answered "no fine route" for every wall next to
    // Zoot; the geometry's own `finePathProtocol` — step 8, the one /findpath and combat
    // use — found each of them in five to seven waypoints. A wall square is standable only
    // in a sliver, and the coarser lattice cannot land on a sliver. So this asks the fine
    // one, in protocol units end to end, and follows its waypoints with stepFine. A body on
    // a waypoint is not this walk's problem — it drops through to the line-walk, whose
    // body rule reports it.
    if (typeof geo.finePathProtocol === 'function') {
      const path = geo.finePathProtocol(me.x, me.y, goal.x, goal.y,
        { step: 8, margin: 4 * KOD_FINENESS, maxNodes: 4000 });
      if (path?.found && Array.isArray(path.waypoints) && path.waypoints.length) {
        let taken = 0;
        for (const wp of path.waypoints) {
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return this.cancelledMovement({ steps: taken, log: [] });
          const step = await this.stepFine(wp.x, wp.y).catch(() => null);
          taken++;
          if (step?.left_room) return { arrived: false, left_room: true, steps: taken };
          if (step?.reason === 'object_blocked') break;
          const at = c.self;
          if (at && at.col === col && at.row === row)
            return { arrived: true, steps: taken, via: 'fine path',
                     position: { col: at.col, row: at.row } };
        }
      }
    }
    const r = await this.walkFine(goal.x, goal.y,
      { maxSteps, stride, arriveWithin: KOD_FINENESS >> 1, movementGeneration, controlToken })
      .catch(e => ({ arrived: false, reason: e.message }));
    if (r?.left_room) return { arrived: false, left_room: true, steps: r.steps ?? 0 };
    const at = c.self;
    // ON THE SQUARE IS THE ONLY THING THAT COUNTS. `walkFine` answers "as close as fine
    // movement gets", which is the right answer to its own question and not to this one:
    // the hold belongs to a square, and `observe()` revokes one taken on the wrong square
    // a pass later.
    const landed = !!at && at.col === col && at.row === row;
    return { arrived: landed, steps: r?.steps ?? 0,
             position: at ? { col: at.col, row: at.row } : null,
             ...(landed ? {} : { reason: r?.reason ?? 'fine approach ended off the square' }) };
  }

  // COORDINATE CONTRACT: `(destX,destY)` is a fine point in kod wire units.
  async walkFine(destX, destY, {
    // SQUARES THIS WALK MAY NOT ENTER, as `row,col` strings. The coarse walker has honoured
    // these since the split-boundary fix; the FINE walker never saw them, and it is the one
    // that actually reaches a boundary. See wrongExitSquares.
    avoidSquares = null,
    maxSteps = 120,
    stride = FINE_STRIDE,
    // THE CEILING THE STRIDE MAY GROW TO, and it is deliberately NOT `stride` for the
    // default caller and exactly `stride` for everyone else. Three sites pass 24, 32 and 40
    // on purpose — the last mile into a safe spot, an edge nudge, a two-step recovery — and
    // those are small because the ground is delicate, so raising their ceiling would make
    // every careful walk careless. A caller that took the default gets to run.
    strideMax = stride >= FINE_STRIDE ? Math.max(FINE_STRIDE_MAX, stride) : stride,
    arriveWithin = 40,
    // DO NOT WALK OFF THE SHELF YOU ARE ON. OFF BY DEFAULT, AND THAT IS DELIBERATE.
    //
    // The fan exists to find a way round geometry, and it is judged purely on DISTANCE: the
    // first heading that moves and gets closer wins. On flat ground that is right. On a ledge
    // it is how a body leaves one: a fanned heading slides off the tread, the step lands a few
    // units nearer the destination, and the walk counts it as progress while the character is
    // now in the gully five thousand units below the route.
    //
    // Measured on the Ancient Place staircase, following a plan that was correct: asked for
    // r42c47 at floor 5856, arrived in THAT SAME SQUARE at 4672, and every later waypoint was
    // then walked along the valley underneath the climb. The treads rise 352 a step against a
    // MAX_STEP_HEIGHT of 384, so there is no margin for a heading that wanders.
    //
    // Every other caller of this function walks ordinary ground where descending is fine and
    // often necessary, so this stays OFF unless asked. `m59-fineroute.mjs` plans routes that
    // only make sense on one shelf, and that is who turns it on.
    holdShelf = false,
    movementGeneration = this.movementGeneration,
    controlToken,
  } = {}) {
    const c = this.need();
    const startRoom = c.room.id;
    let me = c.self ?? await this.selfOrResync();
    if (!me) return { arrived: false, reason: 'own_position_unknown',
                      note: 'own position is unknown and a re-read did not recover it' };

    const log = [];
    let stalls = 0, lastStep = null;
    let closest = Infinity, sinceCloser = 0;
    const geometryRejections = new Set();
    // Floors, asked in CLIENT units. `me.x`/`aimX` here are kod PROTOCOL units — the same
    // space `walk_to`'s col/row path builds with `col * KOD_FINENESS + half` — and the
    // geometry is in client units, so everything must go through `protocolToClient`.
    const shelfGeo = holdShelf ? (this.world?.geometry ?? null) : null;
    const floorOf = (px, py) => {
      if (!shelfGeo) return null;
      try {
        const cx = protocolToClient(px), cy = protocolToClient(py);
        const leaf = shelfGeo.leafAtClient(cx, cy);
        return leaf?.sector ? shelfGeo.floorBaseAtClient(cx, cy, leaf) : null;
      } catch { return null; }
    };
    const destFloor = floorOf(destX, destY);
    let shelfRefusals = 0;
    // Headings to try, in order: straight at it, then fanned out to either side.
    // The wide angles are what carry you along a wall rather than into it.
    const FAN = [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2, 1.7, -1.7];
    // A BODY ON THE DIRECT LINE IS NOT A WALL, AND FANNING AROUND IT IS NOT A WALK.
    //
    // The fan exists for geometry: nine headings and a slide find the gap in a wall the
    // straight line missed. Against a BODY it does something else — the slid step counts
    // as "progress" (a few units closer), the next iteration re-aims through the same
    // body, slides the other way, and the character shuffles two squares for the whole
    // step budget. Measured 2026-08-26 in Castle Victoria: six fleet characters stacked
    // in a 2x3 block at 45-46,3-5, every one "travelling — NOT MOVING" for a quarter of
    // an hour, each one's direct heading refused by a fleetmate.
    //
    // walkTo already treats a body as the caller's problem ("a person is not a hole in
    // the map"): it refunds the step and never persists the refusal. This does the same,
    // faster: once the direct heading has been object_blocked for BODY_BLOCK_STREAK
    // iterations without half a square of net progress, hand it back as object_blocked
    // so the caller can pick another square or wait, instead of spending the budget here.
    const BODY_BLOCK_STREAK = 3;
    let bodyStreak = 0, bodyStart = null, baseReason = null, baseBlockedId = null;

    for (let i = 0; i < maxSteps; i++) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: i, log });
      me = c.self ?? await this.selfOrResync();
      if (!me) return { arrived: false, reason: 'own_position_unknown',
                        note: 'lost own-position while walking; a re-read did not recover it', log };
      const dx = destX - me.x, dy = destY - me.y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= arriveWithin)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
                 steps: i, log };

      const base = Math.atan2(dy, dx);
      // DO NOT STRIDE PAST THE TARGET. A fixed 48-unit step aimed at a point 20 units away
      // overshoots, the next step overshoots back, and a two-square walk dithers until it
      // runs out of steps — which is what happened the moment the skid fix let short walks
      // reach their target at all. The step is capped at what is left.
      const reach = Math.max(8, Math.min(stride, remaining));
      // AND CLOSE ENOUGH IS ARRIVED. Position is confirmed by the server and our own moves
      // are still settling, so the last few units cannot be closed by aiming harder. If the
      // walk has stopped improving on its closest approach and that approach is inside a
      // square, it is there — the alternative is spending the whole step budget shaving
      // units off a number that a body's own width makes meaningless.
      if (remaining < closest - 1) { closest = remaining; sinceCloser = 0; }
      else if (++sinceCloser >= 4 && closest <= KOD_FINENESS)
        return { arrived: true, position: { col: me.col, row: me.row, x: me.x, y: me.y },
                 steps: i, log, note: 'as close as fine movement gets — ' +
                   Math.round(closest) + ' units, inside one square' };
      let progressed = false;

      // A NARROW FAN ON A LEDGE. The wide angles exist to carry a body ALONG a wall, and on
      // flat ground they are what makes this function work at all. On a tread 352 units above
      // the gully they are how it leaves: a heading 1.2 radians off course swings the body
      // sideways past the edge, the step lands a little nearer the goal, and the walk counts
      // it as progress. Measured on stair four — three headings correctly refused by the
      // shelf guard and the fourth, a wide one, allowed.
      //
      // So when the caller says it is on a shelf, it may look a fifth of a turn either way and
      // no further. If that finds nothing the walk stops, which is the right answer on a
      // staircase: there is one way up and it is forward.
      // NARROWED, NOT CRIPPLED. At [0, ±0.35] the body stopped falling and also stopped
      // climbing: from the 5856 tread every one of three headings led down, twelve refusals a
      // call, because the way up a spiral staircase TURNS. The wide angles (±1.2, ±1.7) are
      // the ones that swing a body off a ledge; ±0.75 is still a step along it.
      const fan = holdShelf ? [0, 0.35, -0.35, 0.75, -0.75] : FAN;
      for (const off of fan) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return this.cancelledMovement({ steps: i, log });
        const a = base + off;
        const aimX = me.x + Math.cos(a) * reach, aimY = me.y + Math.sin(a) * reach;
        // DO NOT DRAG ONTO A SQUARE THAT FIRES THE WRONG DOOR.
        //
        // This is where the Western border of the Twisted Wood was losing every crossing. The
        // rail wants WEST — seven south-west steps and then a long west run before it turns
        // south and finally east to the door at 46,67. When the rail stopped, the fine
        // fallback aimed straight at that door, which is EAST and ON the boundary, and every
        // refusal nudged the body a few fine units along the wall:
        //
        //   3936 -> 3974 -> 4012 -> 4050 -> 4088 -> 4126 -> 4164 -> 4202
        //   15,61   15,62   15,63   15,64   15,65   14,65   ...
        //
        // Four hundred and thirty refused fine moves, creeping east until it reached column
        // 66 at row 14 — inside the `row < 19` band — and the server sent it back to the Main
        // gate to the city of Tos. Dragging along a wall, back out the entrance it came in by.
        if (avoidSquares?.size) {
          const col = Math.floor(aimX / KOD_FINENESS), row = Math.floor(aimY / KOD_FINENESS);
          if (avoidSquares.has(`${row},${col}`)) continue;
        }
        // THE SHELF GUARD. A heading that drops off the ledge is refused before it is sent,
        // not judged afterwards by whether it happened to get closer.
        //
        // Descending ONTO THE DESTINATION'S OWN SHELF is still allowed — the route may
        // legitimately end lower than it starts, and a rule that forbade that would refuse
        // the last step of every climb down. What is refused is leaving the shelf for
        // somewhere that is neither where we are nor where we are going.
        if (shelfGeo) {
          const hereFloor = floorOf(me.x, me.y);
          if (hereFloor != null) {
            // ASK WHERE THE BODY WOULD LAND, NOT WHERE IT IS AIMED. The move slides, and on a
            // ledge the slide is the whole danger: checking the aim point passed a heading
            // whose aim was on the tread and whose SLID ENDPOINT was over the edge. Measured
            // on stair four — three headings correctly refused, the fourth allowed, and the
            // body 1536 units down in the gully with the walk reporting `arrived: true`.
            // WITH THE BODIES IN IT, BECAUSE MONSTER COLLISION IS HEIGHT-AGNOSTIC AND THE
            // GEOMETRY IS NOT.
            //
            // The operator's rule: every monster is infinitely tall. A hop or a step whose
            // geometry is clear — 5000 down to 4000 over a gully at 0 — is still blocked by
            // something standing in that gully, which the height model says is far below the
            // arc. So a trace WITHOUT obstacles predicts a landing the body will not reach:
            // the real move is blocked, slides somewhere else, and on a tread "somewhere
            // else" is off it.
            //
            // That is also the only thing here that can vary between two runs of identical
            // code, and it did: the same climb walked all 47 waypoints once and fell at 15
            // the next time. Geometry does not move. Monsters do.
            const bodies = [...(c.room?.objects?.values?.() ?? [])]
              .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0) &&
                           Number.isFinite(o.x) && Number.isFinite(o.y))
              .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
            // A TRACE THAT SAYS THE BODY WILL NOT MOVE IS A REFUSAL, NOT A REASON TO GUESS.
            //
            // This fell back to judging the AIM whenever the trace reported no movement, and
            // the aim is the permissive case: on a tread it is the tread, so the heading was
            // allowed, the real move slid, and the body left the shelf. Adding the obstacle
            // list made that worse rather than better — a blocked step is exactly when the
            // trace reports no movement — so the climb went from occasionally working to
            // falling every time at the same tread. If the mover says this heading goes
            // nowhere, take the next heading.
            let landX = aimX, landY = aimY, traced = false;
            try {
              const t = shelfGeo.traceFineMoveClient(
                protocolToClient(me.x), protocolToClient(me.y),
                protocolToClient(aimX), protocolToClient(aimY),
                { slide: true, obstacles: bodies, roomFlags: c.room?.flags ?? 0,
                  overrideDepths: c.room?.overrideDepths ?? null });
              if (t) {
                traced = true;
                if (!t.moved) { shelfRefusals++; continue; }
                landX = clientToProtocol(t.x); landY = clientToProtocol(t.y);
              }
            } catch { traced = false; /* no trace at all: judge the aim and hope */ }
            void traced;
            const landFloor = floorOf(landX, landY);
            if (landFloor != null &&
                hereFloor - landFloor > MAX_STEP_HEIGHT &&
                (destFloor == null || Math.abs(landFloor - destFloor) > MAX_STEP_HEIGHT)) {
              shelfRefusals++;
              continue;
            }
          }
        }
        const r = await this.stepFine(aimX, aimY);
        // AND CHECK WHERE IT ACTUALLY WENT. The trace is a model and the body is the fact: if
        // this step has put us off the shelf, stop here. Walking on is how one missed tread
        // becomes thirty-five waypoints walked along the valley underneath the climb, with the
        // caller told it arrived.
        if (shelfGeo && r?.moved) {
          const now = this.client?.self;
          const nowFloor = now ? floorOf(now.x, now.y) : null;
          const wasFloor = floorOf(me.x, me.y);
          if (nowFloor != null && wasFloor != null &&
              wasFloor - nowFloor > MAX_STEP_HEIGHT &&
              (destFloor == null || Math.abs(nowFloor - destFloor) > MAX_STEP_HEIGHT))
            return { arrived: false, reason: 'left the shelf',
                     note: `stepped from floor ${wasFloor} to ${nowFloor} on the way to a ` +
                           `destination at ${destFloor}; stopped rather than walking on below the route`,
                     shelf_refusals: shelfRefusals, dest_floor: destFloor,
                     position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
                     steps: i + 1, log };
        }
        if (off === 0) {
          baseReason = r.reason ?? null;
          baseBlockedId = r.reason === 'object_blocked' ? (r.objectId ?? null) : null;
        }
        // THE FINE WALK IS WHERE THE TRACE USED TO GO DARK.
        //
        // `traceMove` sat on the two square-step call sites only, so every fine move was
        // invisible — and fine movement is exactly what carries a body across the seam where
        // the coarse grid stops. In room 587 the baked line's sixth square, 16,60, is
        // fine-grid-only (coarse says no, the BSP says yes), and the trace ends at the square
        // before it every single time: five squares recorded, then sixty-two moves with no
        // position at all, then a reading of the room we came from.
        //
        // Whether that reading is real is the open question, and it cannot be answered from
        // a record that stops at the seam. So the fine walk records too: the same fields, plus
        // the FINE coordinates, because a square number is exactly the resolution that hides
        // what happens inside one.
        traceMove({ agent: this.name, room: this.world?.room?.num, kind: 'fine',
                    square: c.self ? { col: c.self.col, row: c.self.row } : null,
                    fine: { x: Math.round(me.x), y: Math.round(me.y) },
                    aimed: { x: Math.round(me.x + Math.cos(a) * reach),
                             y: Math.round(me.y + Math.sin(a) * reach) },
                    sent: !!r.moved, reason: r.reason ?? null,
                    left_room: !!r.left_room });
        lastStep = { aimed: { x: Math.round(me.x + Math.cos(a) * reach), y: Math.round(me.y + Math.sin(a) * reach) },
                     from: { x: me.x, y: me.y }, reach,
                     moved: r.moved, travelled: r.travelled, reason: r.reason ?? null,
                     locally_validated: r.locally_validated ?? null,
                     geometry_blocked: r.geometry_blocked ?? null,
                     position: r.position ?? null, note: (r.note ?? '').slice(0, 90) };
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room while following the fine route' };
        }
        if (r.reason) geometryRejections.add(r.reason);
        if (isTerminalMovementReason(r.reason))
          return { arrived: false, reason: r.reason, note: r.note,
                   position: r.position, steps: i, log };
        if (r.left_room || (c.room.id !== startRoom)) {
          log.push({ step: i, left_room: true });
          return { arrived: false, left_room: true, room: c.room.id, steps: i + 1, log,
                   note: 'walked out of the room — for an edge exit that IS arriving' };
        }
        // PROGRESS IS GROUND GAINED ON THE TARGET, NOT A POSITION COMPARISON THAT RACES
        // PREDICTION.
        //
        // `r.moved` is only `after !== queued.before`; it says the body changed position,
        // not that it got nearer this target. In room 578 every blocked northward request
        // slid sideways, so `moved` stayed true and reset the stall counter for eighteen
        // minutes while the distance never improved. Conversely, paced dead reckoning can
        // make a genuinely forward step report `moved: false` when `queued.before` was read
        // after the prior prediction advanced. Neither boolean answers this question.
        //
        // Distance to the destination cannot be fooled that way: it is measured from the
        // position the server confirmed, against a target that does not move.
        const now = c.self;
        const gained = now ? remaining - Math.hypot(destX - now.x, destY - now.y) : 0;
        if (gained > 1) {
          progressed = true;
          // A step that gained ground gets a LONGER stride, not merely the one it started
          // with. The halving below is for a body wedged in a gap; a step that just gained
          // ground is not wedged, and on open floor there is no reason to keep asking for
          // three quarters of a square at a time. Capped at `strideMax` — see FINE_STRIDE_MAX
          // for why that number is a client's pace rather than a preference.
          stride = Math.min(stride * 2, strideMax);
          if (off !== 0) log.push({ step: i, slid: Number(off.toFixed(2)), to: r.position });
          break;
        }
      }

      if (!progressed) {
        stalls++;
        // Nine headings refused in a row sent nothing; let the timers and the HTTP server run.
        await new Promise(res => setTimeout(res, 40));
        // Halve the reach and try again: a tight gap may only admit a short step.
        // Floor at 24 (37% of a cell) — below that the walk burns steps
        // without meaningful progress, and the budget was calculated for
        // the initial stride.
        stride = Math.max(24, Math.round(stride / 2));
        if (stalls >= 4)
          return { arrived: false, reason: 'blocked — every heading refused, at every reach tried',
                   ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
                   // WHAT THE LAST REFUSAL ACTUALLY SAID. Without this the caller is told
                   // "every heading refused" and cannot tell a wall from a rate limit from a
                   // move the server simply ignored — which is exactly the wall this
                   // investigation hit.
                   last_step: lastStep,
                   position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
                   steps: i, log, geometry_rejections: [...geometryRejections],
                   note: geometryRejections.has('geometry_blocked')
                     ? 'local BSP collision rejected the requested headings; no endpoint was sent through the obstacle'
                     : undefined };
      } else stalls = 0;

      if (baseReason === 'object_blocked') {
        const now = c.self ?? me;
        const nowRemaining = now ? Math.hypot(destX - now.x, destY - now.y) : remaining;
        if (!bodyStart || bodyStart.remaining - nowRemaining > (KOD_FINENESS >> 1)) {
          bodyStart = { remaining: nowRemaining };
          bodyStreak = 1;
        } else bodyStreak++;
        if (bodyStreak >= BODY_BLOCK_STREAK)
          return { arrived: false, reason: 'object_blocked', objectId: baseBlockedId,
                   position: now ? { col: now.col, row: now.row, x: now.x, y: now.y } : null,
                   steps: i + 1, log, geometry_rejections: [...geometryRejections],
                   note: 'something is standing on the direct line and ' + bodyStreak +
                         ' fans of headings around it gained under half a square. A body ' +
                         "is the caller's to wait for or route around, not a wall to feel along" };
      } else { bodyStreak = 0; bodyStart = null; }
    }
    me = c.self;
    return { arrived: false, reason: 'ran out of steps',
             ...(shelfGeo ? { shelf_refusals: shelfRefusals, dest_floor: destFloor } : {}),
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null, log,
             geometry_rejections: [...geometryRejections] };
  }

  // THE WAY OUT OF A POCKET IS THE WAY IN, WALKED BACKWARDS.
  //
  // Called when the router says there is no route from here — which, in this world, far
  // more often means "here is one of the 17,402 squares the collision view considers cut
  // off from the rest of its room" than it means the destination is unreachable. The
  // character walked in, so a walk out exists; the router simply cannot see it, because
  // the pocket is a pocket to the model and not to the world.
  //
  // Every step replayed was accepted by the fine validator on the way in, so this CANNOT
  // INVENT AN IMPOSSIBLE TRAVERSAL — it can only undo one. If a character reached a pocket
  // by a traversal that should never have been legal, the breadcrumbs walk it back out the
  // same way rather than widening the hole. That is why this, and not a coarse-grid escape
  // hatch: the grid disagrees with the BSP exactly where the cliff climbs and the boundary
  // crossings live, and relaxing collision there is the failure we are protecting.
  //
  // `until` is asked after every crumb, so the caller stops the moment its route reappears
  // rather than unwinding the whole trail — the goal is to get out of the pocket, not to
  // undo the journey.
  async retreatAlongBreadcrumbs({ maxCrumbs = 12, until = null,
    movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const crumbs = this.breadcrumbs ?? [];
    // TRIM THE LOOPS OUT OF THE TRAIL BEFORE WALKING IT BACKWARDS.
    //
    // The trail is what the character actually did, and what it actually did includes the
    // bouncing that got it into trouble — `4,15 -> 5,15` / `5,15 -> 4,16`, over and over.
    // Replaying that in reverse spends the crumb budget re-doing a round trip that arrived
    // exactly where it started. `maxCrumbs` is 12, so a single eight-step bounce can eat
    // the whole retreat and leave the character in the pocket it was trying to leave.
    //
    // Nothing here can be invented by removing a cycle, because both ends of a cycle are
    // THE SAME SQUARE: the join is "X, then whatever followed X the last time", which is a
    // pair the trail already contained. And every step is still put through the validator
    // on the way back out, so a one-way ledge still stops the retreat rather than being
    // teleported over — see the note below about a refused reverse step.
    //
    // Measured over the recorded walks: 41% of per-room runs contain a loop, and across
    // all of them 47% of the squares visited are revisits. Some of that is a person
    // exploring on purpose; none of it is worth undoing.
    if (crumbs.length > 2) {
      // Keyed on the EXACT landing point, which is what keeps the chain joinable — see
      // elideLoops. A crumb is a validated move, not a square.
      const trimmed = elideLoops(crumbs, cr => `${cr.roomId}:${cr.to.x},${cr.to.y}`);
      if (trimmed.length < crumbs.length) crumbs.length = 0, crumbs.push(...trimmed);
    }
    const roomId = c.room?.id;
    let steps = 0, blocked = null;
    while (steps < maxCrumbs && crumbs.length) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps });
      const crumb = crumbs[crumbs.length - 1];
      const me = c.self;
      if (!me) { blocked = 'own_position_unknown'; break; }
      // A crumb from another room, or one that does not START where we are standing, is
      // not a step we can undo: something moved us since, and reversing it would be a
      // guess about geometry rather than a replay of it. Drop the whole trail rather
      // than skipping — the crumbs below it are no more connected to us than this one.
      if (crumb.roomId !== roomId || crumb.to.x !== me.x || crumb.to.y !== me.y) {
        crumbs.length = 0; blocked = 'breadcrumb_trail_broken'; break;
      }
      const back = await this.queueValidatedMove(crumb.from.x, crumb.from.y,
        { slide: true, expectedRoomId: roomId });
      if (!back.sent) { blocked = back.validation?.reason ?? 'geometry_blocked'; break; }
      // The crumb this move just recorded is the retreat itself; drop both, or the trail
      // grows a there-and-back pair and the next retreat undoes the undo.
      if (crumbs[crumbs.length - 1] !== crumb) crumbs.pop();
      const idx = crumbs.lastIndexOf(crumb);
      if (idx >= 0) crumbs.splice(idx, 1);
      steps++;
      c.predictSelf({ x: back.target.x, y: back.target.y,
                      col: Math.floor(back.target.x / KOD_FINENESS),
                      row: Math.floor(back.target.y / KOD_FINENESS) });
      if (typeof until === 'function' && until()) break;
    }
    const me = c.self;
    return { moved: steps > 0, steps, crumbs_left: crumbs.length,
             position: me ? { col: me.col, row: me.row, x: me.x, y: me.y } : null,
             ...(blocked ? { reason: blocked } : {}) };
  }

  // LEAVE A SAFE-WALL POCKET FOR THE ROOM'S MAIN BODY.
  //
  // Runtime geometry carries no region labels — only the bake does, and only on exit ANCHORS
  // (m59-routes.json: each anchor has `region` and `from_body`; the room has `main_region`). A
  // go-door anchor is itself a one-square pocket (room 39's anchors are region 7/0, not its main
  // region 21), but `from_body:true` means the room's main body was PROVEN able to walk to it —
  // which is exactly the square that re-enables the first hop, because reach() is 0 steps from a
  // square you are standing on and exits() then offers that crossing. Walk to the nearest such
  // anchor; walkTo's walkFine fallback does the BSP crossing out of the pocket. This is the escape
  // for a character PARKED on a safe wall, where retreatAlongBreadcrumbs (which needs a fresh trail
  // in) cannot help. Not lifted by any test, so it may use module-scope `activeRoutes` freely.
  async escapeToMainRegion({ movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const geo = this.world?.geometry, me = c.self;
    const roomNum = Number(this.world?.room?.num ?? NaN);
    if (!geo || !me || !Number.isFinite(roomNum)) return { moved: false, reason: 'no geometry/self/room' };
    const table = activeRoutes();
    const baked = table?.rooms?.[roomNum] ?? table?.rooms?.[String(roomNum)];
    const targets = (baked?.anchors ?? [])
      .filter(a => a.from_body && Number.isFinite(a.row) && Number.isFinite(a.col))
      .map(a => ({ col: a.col, row: a.row, d: Math.hypot(a.col - me.col, a.row - me.row) }))
      .sort((x, y) => x.d - y.d);
    if (!targets.length) return { moved: false, reason: 'no from_body anchor to aim for' };
    const startKey = `${me.col},${me.row}`;
    for (const t of targets) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement({});
      if (`${t.col},${t.row}` === startKey) continue;   // already standing on it
      const walk = await this.walkTo(t.col, t.row, { movementGeneration, controlToken, maxSteps: 60 })
        .catch(() => null);
      if (walk?.cancelled) return this.cancelledMovement({});
      const now = c.self;
      if (now && `${now.col},${now.row}` !== startKey)
        return { moved: true, steps: walk?.steps ?? null, arrived: !!walk?.arrived,
                 target: { col: t.col, row: t.row }, position: { col: now.col, row: now.row } };
    }
    return { moved: false, reason: 'could not walk to any main-body anchor' };
  }

  // Walk to a square along a route computed through the real geometry, rather than
  // pushing blindly toward it. Both halves matter: the route lets an agent round a
  // corner it would otherwise stall against, and the pacing keeps the session from
  // being logged as a speedhacker.
  //
  // With no geometry it fails closed. Player movement is not checked by the server,
  // so sign-stepping without a map is an unchecked coordinate write, not navigation.
  // GO ROUND A BODY, NOT ROUND THE ROOM.
  //
  // Pure, and it takes the geometry rather than reading `this`, so the decision can be
  // tested without a session. Returns `{ back, through }` — the square to retreat to
  // first (may be null when standing still already opens the angle) and the square to
  // pass through — or null when neither side is available.
  //
  // THE TWO SIDES ARE THE PERPENDICULARS OF THE STEP WE WERE REFUSED, which is what makes
  // this cheap: one body occupies one square, so the detour is one square wide and the
  // router never has to be consulted. Both are checked against the SAME things the walker
  // already knows — the mover's step relation, the edges it has been refused, and the
  // squares it has seen bodies on — so a sidestep cannot propose a traversal the ordinary
  // path would reject.
  /**
   * THE LANE PAST A BODY, FOR AN ORDINARY STEP -- the same move, shifted sideways.
   *
   * `sidestepAround` above is the walker's answer to something in the way and it thinks in
   * SQUARES: try the one either side, then give the square up. In a corridor ONE SQUARE WIDE
   * there is no side, so it returns null and the walk marks the square taken and replans --
   * which in a corridor is the long way or no way.
   *
   * The pass is not a different square. It is a different fine `y` inside the same one.
   * Measured on the recorded jam (tools/fixtures/sewers-108-row27.json, and see
   * m59-lane-test.mjs): a rat on the centre line of a one-square corridor leaves half a unit
   * of room on each side, and because the wire carries integers there is EXACTLY ONE aim
   * point per side. Six rats stood one per square there for seventy seconds and three
   * characters oscillated in the gaps without one of them getting past.
   *
   * IT IS AN AIM, NOT A PROMISE. `stepFine` still has to land it, and a refused lane costs
   * one step. Tried ONCE per blocked square, because a lane that does not work will not work
   * on the second ask either and the fall-through below is the real recovery.
   */
  laneAroundBody(was, blocked, geo, c) {
    try {
      if (typeof geo?.floorBaseAtClient !== 'function') return null;
      const me = c?.self;
      if (!me) return null;
      const to = geo.standPointWire?.(blocked.row, blocked.col);
      if (!to) return null;
      const bodies = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0)
                     && (Number.isFinite(o.x) || Number.isFinite(o.col)))
        .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                     y: o.y ?? (o.row * KOD_FINENESS + 32),
                     name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      if (!bodies.length) return null;
      const hasFloor = (x, y) => { try {
        return Number.isFinite(geo.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
      } catch { return false; } };
      return lanePastBodies({
        fromX: me.x ?? (me.col * KOD_FINENESS + 32),
        fromY: me.y ?? (me.row * KOD_FINENESS + 32),
        toX: to.x, toY: to.y, bodies, hasFloor,
      });
    } catch { return null; }
  }


  /**
   * THE PERP WALK, FOR THE SAME BLOCKED STEP — see perpWalkPastBodies. The axis is the
   * direction of the blocked step, extended three squares so a picket just beyond the
   * blocked square is measured with it; the bodies are everything in the room that blocks
   * movement; the floor test is the room's own BSP at a point.
   */
  perpWalkAroundBodies(was, blocked, geo, c) {
    try {
      if (typeof geo?.floorBaseAtClient !== 'function') return null;
      const me = c?.self;
      if (!me) return null;
      const to = geo.standPointWire?.(blocked.row, blocked.col);
      if (!to) return null;
      const fromX = me.x ?? (me.col * KOD_FINENESS + 32), fromY = me.y ?? (me.row * KOD_FINENESS + 32);
      const dx = to.x - fromX, dy = to.y - fromY, len = Math.hypot(dx, dy) || 1;
      const reach = Math.max(len, 3 * KOD_FINENESS);
      const toX = fromX + dx / len * reach, toY = fromY + dy / len * reach;
      const bodies = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0)
                     && (Number.isFinite(o.x) || Number.isFinite(o.col)))
        .map(o => ({ x: o.x ?? (o.col * KOD_FINENESS + 32),
                     y: o.y ?? (o.row * KOD_FINENESS + 32),
                     name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? '?' }));
      if (!bodies.length) return null;
      const hasFloor = (x, y) => { try {
        return Number.isFinite(geo.floorBaseAtClient(protocolToClient(x), protocolToClient(y)));
      } catch { return false; } };
      // THE PRECHECK IS THE MOVER'S OWN TRACER, walls and bodies both, in client units. A
      // line it refuses here would have been refused on the wire; asking first costs nothing
      // and saves the packet — and the ledger still records the refusal as a perp_walk row.
      const obstacles = [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0) && Number.isFinite(o.x) && Number.isFinite(o.y))
        .map(o => ({ id: o.id, x: protocolToClient(o.x), y: protocolToClient(o.y) }));
      const segmentClear = typeof geo.traceFineMoveClient === 'function'
        ? (ax, ay, bx, by) => {
            const r = geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                              protocolToClient(bx), protocolToClient(by),
                                              { slide: false, obstacles, roomFlags: c.room?.flags ?? 0,
                                                overrideDepths: c.room?.overrideDepths ?? null });
            if (!r || r.available === false) return null;          // no opinion: carry on
            return { ok: !!r.arrived && !r.blocked, reason: r.reason ?? null };
          }
        : null;
      return perpWalkPastBodies({ fromX, fromY, toX, toY, bodies, hasFloor, segmentClear });
    } catch { return null; }
  }

  sidestepAround(was, blocked, { blockedEdges, occupied, geo, prefer = 0,
                                 blockerIsPlayer = false }) {
    if (!was || !blocked || !geo) return null;
    const dr = Math.sign(blocked.row - was.row), dc = Math.sign(blocked.col - was.col);
    if (!dr && !dc) return null;
    // Perpendiculars of the refused direction. For a diagonal step these are the two
    // cardinals it decomposes into, which is the right answer for the same reason.
    let sides = (dr && dc) ? [{ dr, dc: 0 }, { dr: 0, dc }]
                           : [{ dr: dc, dc: dr }, { dr: -dc, dc: -dr }];
    // CLOCKWISE FIRST, THEN COUNTERCLOCKWISE. The operator's rule, and the reason it is a
    // fixed order rather than a preference is that a detour round a MONSTER has no second
    // party to deadlock with — the thing in the way is not also running this function.
    //
    // Clockwise in room coordinates, where row increases DOWNWARD: rotating a heading right
    // takes east to south, south to west, west to north. The cross product `dr*s.dc -
    // dc*s.dr` is negative for exactly those, which is the test used here rather than a
    // table, so it is right for the diagonal decompositions too.
    const clockwise = s2 => (dr * s2.dc - dc * s2.dr) < 0;
    sides = [...sides.filter(clockwise), ...sides.filter(s2 => !clockwise(s2))];

    // AND THE OBJECT-ID TIE-BREAK SURVIVES, FOR PLAYERS ONLY.
    //
    // Two CHARACTERS meeting head-on both run this identical function, so a fixed order
    // makes them both dodge the same way, collide, both dodge back, and mirror each other
    // indefinitely — watched live and described exactly: "like two people stuck in a
    // hallway, I'll go left, no you go left, no my left, no your left". Ordering by the
    // mover's own object id makes them prefer opposite sides by construction.
    //
    // That argument is entirely about a blocker that is ALSO dodging. A troll is not, so
    // applying it there bought nothing and cost the fixed order the operator asked for —
    // half the fleet would take the long way round the same body for no reason. So the
    // swap is now conditional on what is actually in the way.
    if (blockerIsPlayer && (prefer & 1)) sides = [sides[1], sides[0]];
    // `standable`: somewhere to step round a body is somewhere a body can BE, which is a
    // question about floor rather than about the server's byte. `moverStepLands` still has
    // to authorise the step itself, so this only widens the candidates, never the rules.
    const free = (r, c) => geo.standable(r, c) && !occupied.has(`${r},${c}`);
    const canStep = (fr, fc, tr, tc) =>
      !blockedEdges.has(`${fr},${fc}>${tr},${tc}`) && geo.moverStepLands(fr, fc, tr, tc);

    for (const s of sides) {
      const tr = was.row + s.dr, tc = was.col + s.dc;
      if (!free(tr, tc) || !canStep(was.row, was.col, tr, tc)) continue;
      // From the side square, can we reach the square BEYOND the blocker — i.e. carry on
      // in the direction we were going? That is the whole point; stepping aside and back
      // again achieves nothing.
      const br = blocked.row + dr, bc = blocked.col + dc;
      if (free(br, bc) && canStep(tr, tc, br, bc))
        return { back: null, through: { row: tr, col: tc }, beyond: { row: br, col: bc } };
      // Otherwise settle for reaching the blocked square itself from the side, which is
      // the case where the body is standing in a doorway we can enter at an angle.
      if (canStep(tr, tc, blocked.row, blocked.col))
        return { back: null, through: { row: tr, col: tc } };
    }

    // NOTHING WORKED FROM HERE, SO BACK UP AND TRY AGAIN — the operator's own suggestion,
    // and the reason it is second rather than first is that retreating costs a step and
    // is usually unnecessary. Standing hard against a body the diagonal past it is often
    // refused for clearance; one square back it is not.
    const br0 = was.row - dr, bc0 = was.col - dc;
    if (!free(br0, bc0) || !canStep(was.row, was.col, br0, bc0)) return null;
    for (const s of sides) {
      const tr = br0 + s.dr, tc = bc0 + s.dc;
      if (!free(tr, tc) || !canStep(br0, bc0, tr, tc)) continue;
      if (canStep(tr, tc, blocked.row, blocked.col) ||
          (free(blocked.row + dr, blocked.col + dc) &&
           canStep(tr, tc, blocked.row + dr, blocked.col + dc)))
        return { back: { row: br0, col: bc0 }, through: { row: tr, col: tc } };
    }
    return null;
  }

  // COORDINATE CONTRACT: this public movement API is `(col,row)`. Named position
  // objects remain `{ col, row }`; geometry adapters below reverse positional calls.
  async walkTo(col, row, {
    maxSteps = 120,
    hardCap = 400,
    movementGeneration = this.movementGeneration,
    controlToken,
    beforeMutation = null,
    // Squares to route around, as `row,col` strings. See the note beside `occupied`.
    avoidSquares = null,
    // KEEP OFF THE WALLS ON THE WAY PAST THEM — OPT IN, AND OFF BY DEFAULT.
    //
    // See RoomGeometry.clearanceField. It is right for CROSSING a room and wrong for a
    // walk to a square somebody has already chosen tactically: a safe wall is a tight
    // square BY DEFINITION — that is the whole mechanism, the coarse grid and the BSP
    // disagreeing — and the fleet must not be taught to shy away from the thing the game
    // is balanced around. `leaveVia` turns it on, because walking to a boundary is the
    // long routing where a slid step starts the bounce. A pull, a melee approach and a
    // walk back to a held wall all leave it off and plan exactly as they did before it
    // existed.
    clearance = 0,
  } = {}) {
    const c = this.need();
    const geo = this.world.geometry;
    const me0 = c.self ?? await this.selfOrResync();
    if (!me0) return { arrived: false, reason: 'own_position_unknown',
                       note: 'own position is unknown and a re-read did not recover it' };
    // "ALREADY THERE" IS A SUCCESS REPORT, SO IT HAS TO BE CHECKED LIKE ONE.
    //
    // `c.self` is a belief. `predictSelf` writes to it after every proved leg without a
    // read-back, and a DM relocate moves the body on the server with the client learning only
    // when the next room read lands — so there are two ordinary ways for it to be stale, and
    // both of them end here returning `arrived: true, steps: 0` for a body somewhere else.
    //
    // Seen immediately after the false-arrival fix below, 2026-08-28: a walk that had wrongly
    // predicted 46,15 left the belief there; the body was relocated to 47,14; `/state` said
    // 47,14 and this said "already there". A zero-step success is exactly the shape a caller
    // cannot argue with — no steps taken, nothing refused, nothing to retry.
    //
    // One read, and only on this path: every other route through `walkTo` does real work and
    // pays for its own confirmation at the end.
    if (me0.col === col && me0.row === row) {
      // Optional, for the reason `aimInto` guards its own calls: this method is lifted out of
      // this file by text and run against fixtures that have only what they inject, and a bare
      // call is a TypeError rather than a missing confirmation. `confirmPosition` IS on the
      // real prototype — this is not a call to a name that never existed, which is the other
      // failure this repository has had today and a different thing entirely.
      // Same rule as the proved-route return below: an unconfirmed position cannot certify
      // that we are already somewhere. This site was added to CATCH a false arrival and
      // repeated the cause -- it awaited the confirmation and then read the prediction.
      const ok0 = await this.confirmPosition?.().catch(() => null);
      const now0 = ok0 ?? c.self ?? me0;
      if (ok0 && now0.col === col && now0.row === row)
        return { arrived: true, position: { col, row }, steps: 0, note: 'already there' };
      // The belief was stale. Carry on and walk it properly from where we actually are.
      me0.col = now0.col; me0.row = now0.row; me0.x = now0.x; me0.y = now0.y;
    }

    if (!geo) {
      return { arrived: false, steps: 0, reason: 'collision_geometry_unavailable',
               position: { col: me0.col, row: me0.row },
               note: 'no movement packet was sent because the server does not validate player geometry' };
    }

    // If something has parked us on a square with no floor, no route exists from it at
    // all. The server does not check walls for players, so we can simply step onto
    // solid ground and carry on — but it has to be done deliberately, because from
    // here the pathfinder has nothing to say.
    //
    // `standable`, NOT `walkable`, AND THIS ONE IS LOAD-BEARING. Asked the coarse grid's
    // way, a character standing in a diagonal corridor square that the grid rounds down to
    // wall — 137 such positions are recorded in the operator's own walk logs — reads as
    // "parked off the floor" and gets DRAGGED to `nearestWalkable` before the walk even
    // begins. That is the opposite of the repair: it takes a character that is standing
    // somewhere perfectly legitimate and moves it, every walk, for ever.
    if (!geo.standable(me0.row, me0.col)) {
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      const spot = geo.nearestWalkable(me0.row, me0.col);
      if (!spot) {
        // TWO VERY DIFFERENT FAILURES USED TO SHARE ONE NAME, and the common one is not
        // the one the name describes.
        //
        // `nearestWalkable` searches out to twelve squares. Cibilo Creek Inn is TEN ROWS
        // BY THIRTEEN COLUMNS — that radius covers the whole room twice over, and every
        // square in it and around it resolves to floor — and yet `start_has_no_floor` was
        // the single commonest travel failure on the shadow fleet: 1,535 of 2,361 hop
        // failures in fourteen hours, 404 of them on one character, ALL of them leaving
        // room 153. A character genuinely parked in solid rock cannot produce that.
        //
        // What produces it is the position and the geometry belonging to DIFFERENT ROOMS.
        // 153's only real exit declares `arriveRow: 11, arriveCol: 59` in room 150; read
        // those coordinates against 153's thirteen columns and the character is forty-six
        // squares outside the map, so every ring of the search is empty and the answer is
        // null. The character is not off the floor. The floor is the wrong floor.
        //
        // So the two are named apart. This changes no behaviour — both still refuse, and
        // `TERMINAL_MOVEMENT_REASONS` covers both — but a refusal that names the right
        // condition is the difference between a fixable bug and 1,535 rows of noise. The
        // bounds are reported with it so the next reader does not have to re-derive them.
        const rows = Number(geo.rows), cols = Number(geo.cols);
        const outside = Number.isFinite(rows) && Number.isFinite(cols) &&
          (me0.row < 0 || me0.col < 0 || me0.row > rows + 1 || me0.col > cols + 1);
        if (outside)
          return { arrived: false, reason: 'position_outside_room_geometry',
                   note: 'the character is standing outside the bounds of the room geometry ' +
                         'loaded for it — the two are almost certainly different rooms, which ' +
                         'is a room-change race and not a hole in the map',
                   position: { col: me0.col, row: me0.row },
                   geometry: { rows, cols, room: this.world?.room?.num ?? null,
                               name: this.world?.room?.name ?? null } };
        return { arrived: false, reason: 'start_has_no_floor',
                 note: 'standing off the floor with no walkable square anywhere near',
                 position: { col: me0.col, row: me0.row },
                 geometry: { rows: Number.isFinite(rows) ? rows : null,
                             cols: Number.isFinite(cols) ? cols : null } };
      }
      // CONFIRMED, because this is the one place the ANSWER is the question. Everywhere
      // else `step` is asked "where am I now" and prediction answers it; here it is asked
      // "did that work", and a predicted yes would report solid ground under a character
      // still standing off the floor — from which no route exists at all.
      const half = KOD_FINENESS >> 1;
      const targetX = spot.col * KOD_FINENESS + half, targetY = spot.row * KOD_FINENESS + half;
      const r = await this.stepFine(targetX, targetY);
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, position: r.position ?? { col: me0.col, row: me0.row } };

      // ONE STEP IS NOT ENOUGH TO GET OFF THE GRID, AND FINE MOVEMENT IS THE STRICTER
      // TOOL RATHER THAN THE LOOSER ONE.
      //
      // Measured 2026-08-17: characters really do end up on squares the bake calls
      // unwalkable — Bravo standing at 30,30 in room 587 and Charlie at 25,25 in 566,
      // both `walkable: false`, both perfectly upright on the server, and from there
      // `walkTo` cannot plan at all. `stepFine` asks for ONE clipped step at the nearest
      // floor square, and when the pocket is deeper than one step, or that particular
      // endpoint is refused, the walk ends here with `could not step back onto solid
      // ground` — which is what the three broken boundaries on the Tos-Jasper corridor
      // came down to.
      //
      // `walkFine` is the same collision rules applied up to 120 times with sliding, so
      // it can work its way out where a single step cannot. It is NOT the coarse-grid
      // escape hatch this repository considered and rejected: that one FELL BACK to the
      // server's one-byte grid and relaxed collision, which is the mechanism that let
      // bots climb cliffs. This clips every endpoint against the same BSP the stock
      // client enforces — walls, step heights, slopes, ceilings and the 248-unit player
      // radius — so it is strictly more conservative than the router it is rescuing, and
      // cannot authorise a traversal a person could not make.
      //
      // Second, and only on failure, because it costs packets and the single step is
      // usually enough.
      if (!r.moved) {
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const fine = await this.walkFine(targetX, targetY,
          { maxSteps: 40, movementGeneration, controlToken }).catch(() => null);
        if (isTerminalMovementReason(fine?.reason))
          return { arrived: false, ...fine, position: fine.position ?? { col: me0.col, row: me0.row } };
        const now = c.self;
        // Same question as above — did we reach ground a player can occupy — so it has to
        // be the same predicate, or the recovery declares failure while standing on floor.
        if (!now || !geo.standable(now.row, now.col))
          return { arrived: false, reason: 'could not step back onto solid ground',
                   position: now ?? r.position,
                   recovered_by: 'neither one clipped step nor fine walking reached floor',
                   note: r.note ?? r.reason ?? 'local collision found no safe recovery path' };
      }
    }

    let from = c.self ?? me0;
    // Route round what can see us, at a cost rather than a prohibition — see
    // threatsHere(). Computed once per walk rather than per step: monsters wander, but
    // re-deriving a whole field every square would cost more than the detour saves,
    // and the replan below picks up anything that has moved into the way since.
    const threats = this.threatsHere();
    // THE MASK MAY ONLY EVER PREFER, AND THAT HAS TO HOLD AT PLAN TIME TOO.
    //
    // The replan inside the walk already falls back to the coarse grid when the collision
    // view runs out of routes; the FIRST plan did not, so a goal the model dislikes was
    // refused before a single packet — which is the same silent refusal this whole path
    // exists to remove, just arriving earlier. It bites hardest at doors: an exit anchor
    // for a `go` exit is the door tile itself, a pocket by design, and 346 of the 383
    // anchors this bake cannot reach from their room's body are exactly those. Exempting
    // the last step into the goal recovers 57 of them; the other 326 have the whole
    // approach refused, and for those the answer is to plan on the grid and let the mover
    // clip each step for real — which is what `leaveVia` then finishes with fine
    // positioning.
    //
    // Only when the COLLISION view is what refused. A coarse-grid "no route" is the room
    // telling us something, and re-asking it the same question would just be slower.
    const blockedEdges = new Set();
    // One re-centre per square per walk. Standing in the middle either helps or it does not;
    // trying it twice from the same square is the dither this is meant to remove.
    const recentredAt = new Set();
    // The closest this walk has ever been to its target, and how long since that improved.
    let bestGap = Infinity, sinceCloser = 0;
    // Where the body has already been. A dither revisits; a detour walks new ground.
    const seenSquares = new Set();
    const edgeKey = (fr, fc, tr, tc) => `${fr},${fc}>${tr},${tc}`;
    // AN EDGE THE MOVER CANNOT WALK IS A FACT ABOUT THE MAP, NOT ABOUT THIS WALK.
    //
    // `blockedEdges` is built fresh on every call, so everything the walker learns dies with
    // the walk and is re-learned from nothing on the next replan. For a body in the way that
    // is correct — it will have moved. For GEOMETRY it is amnesia, and it is expensive:
    // measured in room 50, the single step 54,40 -> 53,40 was refused ONE HUNDRED AND
    // THIRTY-FIVE times in one two-character run, 135 of that room's 145 refusals. Offline,
    // `moverStepLands(54,40 -> 53,40)` is false. Both squares are walkable and the step
    // between them is not, so the mover was right every time and the walker asked anyway.
    //
    // Nothing reaches the wire — the local validator refuses first — so this is pure thrash
    // that spends the step budget and the clock while every instrument reports a healthy
    // character with somewhere to be.
    //
    // Where it comes from is the deliberate escape hatch above: when the collision-aware
    // pathfinder finds no route, `replan` re-asks with `collision: false`. That plan is
    // allowed to contain edges the mover refuses — the point is that fine positioning
    // usually rescues them — but the ones that are geometrically impossible have to be
    // learned ONCE and remembered, or the same blind plan comes back unchanged.
    //
    // Only provable impossibility is kept. `object_blocked` is never persisted: a troll
    // moves, and remembering it would carve permanent holes in a room over a long session.
    const roomNow = Number(geo?.num ?? this.world?.room?.num ?? NaN);
    const impossibleHere = Number.isFinite(roomNow)
      ? ((this.impossibleEdges ??= new Map()).get(roomNow)
         ?? this.impossibleEdges.set(roomNow, new Set()).get(roomNow))
      : null;
    if (impossibleHere) for (const e of impossibleHere) blockedEdges.add(e);

    // BLOCKED EDGES GO INTO THE FIRST QUESTION, NOT ONLY THE LATER ONES.
    //
    // The re-plan twenty lines down has always passed `blockedEdges`; the OPENING plan never
    // did, so every walk began blind to everything the walker already knew. That was
    // invisible while the set was rebuilt empty on each call — there was nothing to be blind
    // to. The moment the room's impossible edges survive a walk, the opening plan is the one
    // place they have to be honoured, or they are learned for ever and consulted never.
    //
    // It matters most for the `collision: false` fallback: that plan is ALLOWED to contain
    // edges the mover refuses, which is the whole point of it, and the blocked set is the
    // only thing that stops it proposing the same refused edge on every attempt.
    // PATH JITTER, re-applied onto upstream's replan. A small per-agent cost bias on
    // intermediate cells, so two characters walking to the same place take slightly
    // different routes instead of stacking on each other. THE GOAL IS NEVER JITTERED --
    // only the ground between start and goal -- so the character still arrives exactly
    // where it was sent. It rides on `extraCost`, which is why that parameter was kept
    // alongside upstream's `clipCost` when the two collided in m59-roo.mjs's A*.
    let jitterCost = null;
    if (this.name && Math.abs(from.row - row) + Math.abs(from.col - col) > 3) {
      let h = 0;
      for (const ch of this.name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      jitterCost = (r, c) => {
        // Only bias cells that are already walkable -- never penalise the only viable
        // cell in a corridor, which would turn a preference into a refusal.
        if (!geo.standable(r, c)) return 0;
        const v = ((r * 7919 + c * 104729 + h) & 0xff) / 255;
        return v > 0.7 ? 0.3 : 0;
      };
    }
    const replan = (r, cc) => {
      let p = geo.path(r, cc, row, col, { blockedEdges, threats, clearance, extraCost: jitterCost });
      if (!p.found && p.collision_view)
        p = geo.path(r, cc, row, col, { blockedEdges, threats, clearance, collision: false, extraCost: jitterCost });
      return p;
    };
    let plan = replan(from.row, from.col);
    // NO ROUTE FROM HERE USUALLY MEANS "HERE IS A POCKET", NOT "THERE IS UNREACHABLE".
    //
    // Both are refusals of the same shape and only one of them is about the destination.
    // A character standing on a safe wall is standing where the coarse grid and the BSP
    // disagree — that is what a safe wall IS — and to the collision view that square is
    // frequently cut off from its own room's exits. Walking the breadcrumbs back undoes
    // whatever got it in there, and the plan is re-asked from wherever that lands.
    let escaped = 0;
    if (!plan.found && !plan.stuck) {
      const out = await this.retreatAlongBreadcrumbs({
        movementGeneration, controlToken,
        until: () => replan(c.self?.row ?? -1, c.self?.col ?? -1).found,
      });
      if (out.cancelled) return out;
      escaped = out.steps ?? 0;
      if (out.moved) {
        from = c.self ?? from;
        plan = replan(from.row, from.col);
      }
    }
    if (!plan.found) {
      // COARSE GRID FOUND NO ROUTE — TRY THE FINE GRID. The coarse grid is a
      // 1-byte-per-square projection of the BSP. A square it calls unwalkable
      // (step height, ledge, diagonal wall, or a gap between polygons) may be
      // perfectly fine at the fine resolution. walkFine navigates using BSP
      // collision directly and can find routes the coarse grid cannot see.
      // This is the last resort: the fine grid is slower (one confirmed step
      // per second) but more accurate.
      const half = KOD_FINENESS >> 1;
      const destX = col * KOD_FINENESS + half;
      const destY = row * KOD_FINENESS + half;
      if (process.env.M59_EXIT_DEBUG !== '0')
        console.error(`[walkTo] ${this.name ?? '?'} coarse grid failed (${plan.reason}), trying fine grid to (${destX},${destY}) [fine x,y in kod units; requested square r${row}c${col}]`);
      const fine = await this.walkFine(destX, destY, {
        maxSteps: Math.max(60, Math.ceil(Math.hypot(col - from.col, row - from.row) * 2)), stride: 48, arriveWithin: 100,
        movementGeneration, controlToken,
      }).catch(e => ({ arrived: false, reason: e.message }));
      if (fine.arrived)
        return { arrived: true, steps: fine.steps, position: fine.position,
                 note: 'coarse grid found no route; fine grid walked it' };
      // RAW WALK FALLBACK: both grids failed. In keeper mode,
      // try a direct raw walk toward the target. Send move
      // commands in the target direction, ignoring geometry.
      // The server accepts or rejects each move. This bypasses
      // stale local geometry that blocks both grids.
      if (process.env.M59_KEEPER === '1') {
        const c = this.client;
        const self = c.self;
        if (self) {
          const dx = col - self.col;
          const dy = row - self.row;
          const dist = Math.hypot(dx, dy);
          if (dist > 1) {
            const deg = Math.atan2(dy, dx) * 180 / Math.PI;
            console.error(`[walkTo] ${this.name ?? '?'} raw walk fallback: both grids failed, walking raw toward (${col},${row}) dist=${dist.toFixed(1)} [col,row; r${row}c${col}]`);
            const rawSteps = Math.min(Math.ceil(dist), 8);
            const speed = c.moveSpeed?.() ?? 1;
            for (let i = 0; i < rawSteps; i++) {
              try {
                const step = 24; // 1/4 cell in fine units
                const rad = deg * Math.PI / 180;
                const nx = Math.round((self.x ?? self.col * 48) + Math.cos(rad) * step);
                const ny = Math.round((self.y ?? self.row * 48) + Math.sin(rad) * step);
                c.moveTo?.(nx, ny, speed, c.room?.id ?? 0);
                await new Promise(r => setTimeout(r, 250));
                const newSelf = c.self;
                if (newSelf && (newSelf.col !== self.col || newSelf.row !== self.row)) {
                  console.error(`[walkTo] ${this.name ?? '?'} raw walk moved to (${newSelf.col},${newSelf.row}) [col,row; r${newSelf.row}c${newSelf.col}]`);
                  return { arrived: false, reason: 'raw walk made progress', position: { col: newSelf.col, row: newSelf.row }, raw_walk: true };
                }
              } catch { break; }
            }
          }
        }
      }
      return { arrived: false, reason: plan.reason, position: { col: from.col, row: from.row },
               ...(plan.stuck ? { nearest_floor: plan.nearest_floor } : {}),
               ...(escaped ? { retreated: escaped } : {}),
               fine_reason: fine.reason,
               note: escaped
                 ? 'no route even after walking the breadcrumbs back out of the pocket'
                 : 'the geometry says there is no route to that square from here' };
    }

    // If a route exists, walking it is what was asked for. Refusing partway because of
    // a caller's default budget is a silent failure dressed as a limit — so the plan
    // itself raises the ceiling, and only a genuinely runaway walk is capped.
    //
    // AND THE PLAN LENGTH IS NOT THE STEP COUNT, IN THE ROOMS WHERE THIS MATTERS.
    //
    // `plan.steps.length + 10` assumes one packet per planned square. That holds in open
    // ground and fails exactly where the fleet gets stuck: the router validates a step
    // centre-to-centre and the mover SLIDES, so after the first slide the body is never on
    // a centre again and a planned step lands next door instead. Each of those costs a
    // replan and another packet, and none of them is a wasted step — the walk is learning
    // the edge or gaining ground.
    //
    // Measured offline against the real baked geometry, driving the real `path`,
    // `standPoint` and `traceFineMoveClient` with the fine position carried forward, over
    // walks from random floor to the room's own baked exit anchors (12 per room, only
    // starts the router says are routable):
    //
    //                                    plan-length budget    x3
    //   598 The Cragged Mountains              4/12          6/12
    //   599 Ukgoth                             3/12          5/12
    //   575 The King's Way                     5/12          8/12
    //   all 21 cycle rooms                  203/252       211/252
    //   of which failed on the step budget      33             8
    //
    // The rooms that do not slide are unaffected — 587, 597, 576, 50, 150 and the Barloque
    // pair all measure a steps/plan ratio of 1.00 — so this is not a blanket loosening: it
    // is a ceiling that stops binding in the four rooms where the plan was never the number
    // of packets. `hardCap` (400) still bounds the whole walk, and the REPLAN budget still
    // ends a walk that is neither learning nor closing, which is the one that is actually
    // going nowhere.
    const budget = plan.steps.length * OFF_PLAN_STEP_BUDGET + 10;
    if (budget > maxSteps) maxSteps = Math.min(budget, hardCap);

    // WALK THE PROVED ROUTE FIRST — see walkPivots, and the argument there for why this is
    // the whole fix rather than another reaction to a deviation. The pull is taken from
    // where the body ACTUALLY is, not from the middle of its square, because that is the
    // line that will be walked.
    //
    // Everything below is untouched and is what runs when this cannot finish the job: a
    // leg the pull could not prove, a refused move, a body in the way, a room that animated
    // under it. Falling through costs one plan and loses nothing — which is the property
    // that makes it safe to put in front of a walker this fleet depends on.
    let pivotLegs = 0;
    if (geo.collisionReady && typeof geo.stringPull === 'function' && plan.steps.length > 1
        && !this.movementWasCancelled(movementGeneration, controlToken)) {
      const here = c.self;
      const startPt = here && Number.isFinite(here.x)
        ? { x: protocolToClient(here.x), y: protocolToClient(here.y) } : null;
      const half2 = KOD_FINENESS >> 1;
      const ptOf = st => geo.standPoint?.(st.row, st.col)
        ?? { x: protocolToClient(st.col * KOD_FINENESS + half2),
             y: protocolToClient(st.row * KOD_FINENESS + half2) };
      if (startPt) {
        // THE STOPS ARE WORKED OUT NOW, WHILE THE ROUTE IS BEING PLANNED, AND NOT LATER FROM
        // A STANDSTILL. `this.shelterPolicy` is set by whoever asked for the walk — the
        // keeper, during a journey — and is absent for every other caller, so an ordinary
        // walk pays nothing for this beyond one pass over the plan.
        const sp = this.shelterPolicy;
        const shelter = sp?.need
          ? { spots: sheltersAlong(geo, plan.steps,
                                   { book: sp.book ?? null, room: c.room?.num ?? null,
                                     within: sp.within ?? 6 }),
              need: sp.need, maxDetour: sp.maxDetour ?? 5, onDivert: sp.onDivert ?? null,
              onArrive: sp.onArrive ?? null }
          : null;
        const ran = await this.walkPivots(plan.steps, geo,
                                          { movementGeneration, controlToken, shelter });
        pivotLegs = (ran.legs ?? 0) + (ran.singles ?? 0);
        if (ran.cancelled) return this.cancelledMovement({ steps: pivotLegs });
        if (ran.left_room)
          return { arrived: false, left_room: true, steps: pivotLegs,
                   note: 'a proved leg crossed the room edge' };
        if (pivotLegs) {
          // ONE READ AFTER THE RUN, NOT ONE PER LEG. The prediction is what the proof
          // licenses; this is the single confirmation that the world agrees, and it is the
          // same trade `step` makes across a whole hop rather than per square.
          // A CONFIRMATION THAT TIMED OUT IS NOT A CONFIRMATION, AND THIS IS WHERE THAT
          // COST THE MOST.
          //
          // `confirmPosition` answers null when the room-contents read does not land inside
          // its 8s deadline -- its own comment says callers "already treat an unknown
          // position as a wrong one", and this caller did not: it threw the verdict away and
          // read `c.self`, which after a proved leg is the DEAD-RECKONED PREDICTION of the
          // target. So `at.col === col && at.row === row` was true by construction, and every
          // timed-out confirm became `arrived: true, note: 'walked the proved route'` on a
          // walk that moved nobody.
          //
          // Measured on the shadow fleet in The Flatlands, 2026-08-28: 35,29 -> asked for
          // 35,35 -> still 35,29, no damage taken, and the mover reported success. A room
          // busy enough to delay a read -- spiders, ants, other characters -- is exactly the
          // room where this fires, which is why it looked like a corridor that could not be
          // threaded rather than a lie about having threaded it.
          const confirmed = await this.confirmPosition();
          const at = confirmed ?? c.self ?? await this.selfOrResync();
          if (confirmed && at.col === col && at.row === row)
            return { arrived: true, position: { col, row }, steps: pivotLegs, replans: 0,
                     pivots: pivotLegs, note: 'walked the proved route' };
          // Not there: re-plan from wherever the proved part left us and carry on below.
          if (at) {
            from = at;
            const again = replan(at.row, at.col);
            if (again.found) plan = again;
          }
        }
      }
    }

    let queue = plan.steps.slice();
    let taken = pivotLegs, replans = 0;
    // ITERATIONS THAT SENT NOTHING. A step the validator refuses returns in a tenth of a
    // millisecond with no packet; a replan costs a few; and `learned` — a newly blamed edge
    // — exempts the iteration from the replan budget. In a room with thousands of edges that
    // is a loop that runs at hundreds of iterations a second, sends nothing, and never
    // yields, so the keepalive timer and the HTTP server starve, the server logs the session
    // out at 30 s of silence, and the journey is lost. Measured on 2026-09-01 in the Sewers
    // of Barloque: four keepers at r59c35, 99% of a core each, sent_per_sec 0, and no
    // ledger rows because none of these branches writes one. Two bars: yield to the event
    // loop every few packetless iterations so the timers run, and give up out loud after a
    // few hundred, because a walk that has not sent a packet in that long is not walking.
    let packetless = 0;
    // A STEP A MONSTER REFUSED IS NOT A STEP THE ROUTE SPENT.
    //
    // `maxSteps` exists to stop a walk that is going nowhere. A body in the way is going
    // nowhere for a completely different reason, and the walk's own reply already says so
    // — "N monster collision(s) during travel ate the budget; the route itself was not
    // refused" — while nothing acted on it. So a busy doorway exhausted the budget before
    // the geometry ever got a fair try, and the walker reported a wall.
    //
    // Traced live crossing the Western border of the Twisted Wood, a room whose west door
    // is one body wide: 14 and then 19 monster collisions inside a 40-step budget, seven
    // stumbles, five minutes, and 6-17 health lost per attempt. That is the room's 19 prod
    // deaths in eight hours, and the geometry was never the thing that ran out.
    //
    // Refunded, not waived — and the refund is bounded by the budget itself, so a walk can
    // be pushed through traffic at most twice over and a corridor that is permanently
    // plugged still ends. The damage checks above are untouched: a character being HIT
    // still gives up early, because bleeding out in a doorway is the failure this is meant
    // to prevent, not one to be patient about.
    let refunded = 0;
    // How much fine threading one walk may spend. Each is a bounded A* plus a few validated
    // moves; the cap is what stops a genuinely sealed pocket paying for it over and over.
    let fineDetours = 0;
    const FINE_DETOUR_MAX = Number(process.env.M59_FINE_DETOURS || 12);
    const FINE_DETOUR_NODES = Number(process.env.M59_FINE_DETOUR_NODES || 4000);
    const FINE_DETOUR_MARGIN = Number(process.env.M59_FINE_DETOUR_MARGIN || 4);
    // AND A REPLAN THAT GOT US CLOSER IS NOT A WASTED REPLAN.
    //
    // `replanBudget` is 8 plus a tenth of the plan, so a 65-step crossing gets about 14.
    // That is a fine allowance for "the route was stale" and far too small for what these
    // rooms actually do: the mover SLIDES, so a walk lands off its planned square
    // constantly, replans from where it really is, and carries on — measured offline
    // against the real geometry, Western border of the Twisted Wood arrives at 5.35x the
    // planned step count and The Cragged Mountains at 6.58x. A budget of 14 cannot reach
    // the end of either, so the walk was guaranteed to report "kept ending up somewhere
    // other than the planned square" no matter how well it was going.
    //
    // Traced live on 587 after the monster refund above: two collisions, three health, and
    // still no arrival — the budget ran out while the character was making ground.
    //
    // So the budget is spent on replans that get us NO CLOSER, which is the thing it was
    // always meant to catch. Distance is Chebyshev to the target square, the same metric
    // the router's heuristic uses. A walk that keeps closing the gap keeps its allowance;
    // one that is genuinely going nowhere still ends after the same fourteen tries.
    let closest = Infinity;
    // THE SHORTEST ROUTE SEEN, WHICH IS WHAT PROGRESS ACTUALLY MEANS IN A ROOM THAT BENDS.
    // See the replan budget below: crow-fly distance is the wrong measure the moment the
    // way out goes AWAY from the goal first, and the Cragged Mountains does exactly that.
    let shortestRoute = Infinity;
    // AND ROUTING ROUND A LIVE OBSTACLE COSTS REPLANS THAT THE ROUTE DID NOT.
    //
    // The budget is an allowance for the MAP being wrong. A monster in the way is not the
    // map being wrong — it is the map being briefly occupied, and getting round it is
    // exactly the work we want the walker to do. Charging that to the same purse means a
    // busy corridor spends the allowance meant for genuine dead ends, and the walk reports
    // a route failure for what was traffic.
    //
    // Worth knowing what this refund is trusting. `object_blocked` is OUR pass, in
    // m59-roo.mjs, and the RULE is not a guess: it reproduces the server's own
    // MoveObjectAllowed — obstacle as a square, one coordinate pushed to its edge, the
    // modified point taken only if walls allow it. What it cannot be sure of is WHERE the
    // obstacle is, because positions arrive on the server's push and a moving monster's
    // can be a second stale. So the refund is bounded rather than open: a real wall
    // misreported as a body would otherwise buy itself unlimited retries.
    let collisionReplans = 0;
    const collisionReplanMax = Number(process.env.M59_COLLISION_REPLANS || 12);
    // SQUARES SOMETHING IS STANDING ON. The geometry models walls and knows nothing
    // about occupancy, and these rooms cap at seven to twelve monsters — so the common
    // reason a step does not happen is that something is in the way.
    const occupied = new Set();
    // SQUARES THAT WOULD FIRE THE WRONG DOOR. A boundary is not one exit: the server picks
    // between the exits on an edge by evaluating a condition on the crossing square, so on a
    // split edge some of that boundary leads somewhere we are not going. Standing there and
    // sliding one square is how `587 -> 597` reported the crossing and landed in 586 THIRTEEN
    // TIMES in one leg — a hundred and eighty seconds in one room without leaving it.
    //
    // Passed in rather than derived here, because only the caller knows which door it wants.
    for (const sq of (avoidSquares ?? [])) occupied.add(sq);
    // AND EDGES THE MOVER WILL NOT CROSS, WHICH IS A DIFFERENT FACT AND WAS NOT RECORDED
    // AT ALL. A monster moves; a wall does not. Blaming the SQUARE for a wall between two
    // squares removes a perfectly good place to stand that other neighbours still reach,
    // and — much worse — a step that SLID and landed one square sideways recorded nothing
    // whatever, so the replan from the new position produced the same step and the walker
    // bounced along the wall until its replan budget ran out.
    //
    // Measured offline against the baked geometry, on the twelve boundaries the exit-gap
    // record complains about most: 249 of 422 walks to an exit — 59% — died exactly that
    // way, with trails reading `4,15->5,15=5,15` / `5,15->4,16=4,15` over and over. Nobody
    // was trapped: the same rooms are 96-100% connected to their own exits when the mover's
    // edges are the ones being walked. The walker simply never learned.
    // LONG HOPS THAT WERE SENT, MOVED THE BODY, AND DID NOT ARRIVE.
    //
    // Not a blocked edge: nothing refused it, and a single step along the same line is
    // usually fine — it is the LENGTH that fails, because the move slides and lands
    // somewhere the plan did not ask for. `blockedEdges` records refusals and so never
    // learns this, and the reach collapse below is undone by the next arrival.
    //
    // Which is how a character with 200 health, taking no damage at all, spent sixty
    // seconds inside three squares of the Cragged Mountains: 30,33 -> 36,34 slides to
    // 30,32; 30,32 -> 31,35 slides to 29,34; 29,34 -> 30,33 ARRIVES, which restores the
    // full reach — and the six-square hop that never works is offered again. Thirty-two
    // moves sent, none refused, no progress.
    const missedHops = new Set();
    let stalledOn = null, stalledTimes = 0;
    // THE SQUARE WE WERE IN BEFORE THE ONE WE ARE IN NOW. A refused FALL is a bad approach
    // rather than a bad ledge, and blaming it needs the step before last — see the learning
    // block below.
    let prevSquare = null;
    // MONSTER COLLISION DURING TRAVEL, kept as its own fact. See the block below that
    // increments these: a body is not a wall, it moves, and a walk that failed because of
    // one has a completely different remedy from a walk the geometry refused.
    let monsterBlocks = 0;
    // ONCE PER WALK. Backing up to make an attacker follow is the last tier and it costs
    // ground; doing it repeatedly is how a character walks backwards out of a corridor it
    // was trying to cross. If one retreat does not free the square, the ordinary occupancy
    // replan below is the honest answer.
    let retreatedFromBodies = false, bodyRetreats = 0;
    const blockedBy = new Set();       // squares a body was standing on
    const sidestepped = new Set();     // squares we have already tried to go round, once each
    const lanedPast = new Set();
    const perpWalked = new Set();
    const blinkAsked = new Set();
    const killTried = new Set();
    const blockedSince = new Map();      // squares we have already tried to thread past, once each
    // HOW OFTEN THE MOVER PUT US SOMEWHERE THE PLAN DID NOT ASK FOR. See the note where
    // this is incremented; past a handful it means the square-by-square plan is not the
    // thing being walked, and continuing to replan it is how a room takes three minutes.
    let offPlan = 0, wentFine = false;
    // HOW FAR ONE MOVE MAY REACH, WHICH IS NOT A CONSTANT ONCE A LONG ONE HAS FAILED.
    //
    // Coalescing turns a walk into a few long moves, which is the whole point of proving a
    // route once. It also means a move that fails costs its whole length: measured in
    // Outskirts of Tos, a character sat on one square for 106 counted steps — about fifteen
    // identical seven-square attempts — because a failed hop is retried as the SAME hop,
    // and every retry billed seven. Single steps from that square worked in all four
    // directions the entire time.
    //
    // So the reach collapses to one after a long move fails and climbs back on success. A
    // walk can still be long-legged where the ground allows it and always has the single
    // step to fall back on, which is the move the geometry was actually asked about.
    let hopLimit = MOVE_HOP_MAX_SQUARES;
    // The current plan's pulled proof, or null when it has none. `undefined` means "not
    // computed for this queue yet"; every place that REPLACES the queue resets it.
    let pulled;
    // Health across the walk, so a body in the way can be told from a body that is EATING
    // us. See the under-fire note in the blocked branch below.
    let hpAtLastBlock = c.vitals?.()?.health?.value, damageWhileBlocked = 0, underFire = false;
    while (queue.length && taken < maxSteps) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ steps: taken, replans });
      // ONE PACKET, SEVERAL SQUARES — as long as they are in a STRAIGHT LINE.
      //
      // The planned route is a list of adjacent squares, and sending one packet per
      // square is what made us four times slower than a person while sending four
      // times as many packets. A real client reports a position about once a second
      // and the ground it crossed in between is never transmitted at all.
      //
      // Collinear only, and that restriction is the whole safety argument: every
      // square between here and the far end is a square the router already accepted,
      // so the line we skip along is the line we planned. Coalescing across a TURN
      // would cut the corner — through whatever the turn was avoiding — which is the
      // one way this could put a character through a wall on purpose.
      // AND COLLINEAR IS TOO NARROW A TEST ON GEOMETRY THAT IS NOT AXIS-ALIGNED.
      //
      // The paragraph above is right that coalescing across a turn could cut a corner —
      // IF the only thing known about the skipped ground is that the router accepted the
      // squares. But there is a stronger check available and it is the one the mover
      // itself uses: trace the straight line and require it to ARRIVE, with `slide:false`.
      // A line that arrives without sliding has not clipped anything, whatever direction
      // it runs, so the corner-cutting argument does not apply to it.
      //
      // This matters because the rooms are not boxes. Room 587's wall length is 54.9% NOT
      // axis-aligned; the exit to the Twisted Wood is a 45 degree run. Measured there,
      // stepping centre-to-centre along a grid route fails 218 of 311 steps, and 200 of
      // those 218 — 92% — do not move the character AT ALL. Collinear coalescing cannot
      // help with any of them, because the refused step is a single step.
      //
      // Same six routes, reaching as far as the line still clears: 311 grid steps become
      // 66 pivots. See RoomGeometry.stringPull and m59-stringpull-test.mjs.
      let next = queue.shift();
      let hop = 1;
      // A HOP THAT MISSED FROM A GIVEN SQUARE IS NOT TRIED FROM THAT SQUARE AGAIN.
      // Declared outside the loop — see `missedHops` above the loop.
      // THE SQUARES A COALESCED HOP SWALLOWED, kept so they can be given back if it misses.
      // See the `hop > 1` branch below: without these, collapsing the reach to one achieves
      // nothing, because the only square left on the queue is the far end of the hop that
      // just failed.
      const skipped = [];
      const from0 = c.self ? { col: c.self.col, row: c.self.row } : null;
      // THE SECOND AIM, AND IT HAS TO MATCH THE FIRST. This traces a straight line across
      // several squares to decide which of them may be skipped, so if it measured that
      // line between CENTRES while `step` sends stand points, the line proved clear is not
      // the line walked. `standPoint` is the centre for every ordinary square, so this is
      // unchanged wherever the old aim was right.
      const half0 = KOD_FINENESS >> 1;
      const fineOf = s => geo.standPoint?.(s.row, s.col)
                       ?? { x: protocolToClient(s.col * KOD_FINENESS + half0),
                            y: protocolToClient(s.row * KOD_FINENESS + half0) };
      const arrives = (a, b) => {
        const t = geo.traceFineMoveClient?.(a.x, a.y, b.x, b.y, { slide: false });
        return !!t && Math.hypot(t.x - b.x, t.y - b.y) <= PIVOT_ARRIVE_WITHIN;
      };
      // THE PULL, IF THE CURRENT PLAN HAS ONE. Recomputed only when the queue was
      // replaced (a new plan), never per step — that is the entire point.
      // OVER THE WHOLE PLAN, INCLUDING THE SQUARE ALREADY SHIFTED OFF. `next` came out of
      // the queue a few lines above, so pulling `queue` alone proves a line that starts one
      // square further on — and then the very first thing asked, "is `next` on a proved
      // leg", is false about a square the pull never saw. Measured: the proof was perfect
      // offline (30 steps -> 2 pivots, one proved leg, 30 of 31 squares) and did nothing at
      // all live, 26 steps before and 26 after.
      if (pulled === undefined)
        pulled = provedSquares(geo, from0 ?? me0, next ? [next, ...queue] : queue);
      if (from0 && geo.collisionReady) {
        // FROM WHERE THE CHARACTER ACTUALLY IS, NOT FROM THE MIDDLE OF ITS SQUARE.
        //
        // This trace decides which squares may be SKIPPED, so the line it proves clear has
        // to be the line that gets walked — the same "second aim has to match the first"
        // argument as the comment above, applied to its other end. `fineOf(from0)` is the
        // stand point of the square we are IN, and after the first slide the walker is not
        // standing there: `offPlan` below exists precisely because "after the first slide
        // the walker is never at a centre again". So the coalescer was clearing a run from
        // a point the character had already left, then sending a multi-square hop along it
        // — which slides, lands off-plan, and costs a replan that re-plans the same route.
        //
        // The server pushes our fine position and `walkFine` already steers by it, so this
        // is the authoritative answer rather than a better guess. Falling back to the stand
        // point keeps a client that has not reported one behaving exactly as before.
        const here = Number.isFinite(c.self?.x) && Number.isFinite(c.self?.y)
          ? { x: c.self.x, y: c.self.y }
          : fineOf(from0);
        // FURTHEST FIRST, so a long clear run costs one trace rather than one per square.
        // Bounded by the same hop ceiling as before, so the packet a walk sends is no
        // bigger than it ever was — this changes WHICH squares may be skipped, not how
        // many.
        // A PROVED LEG MAY REACH FURTHER THAN AN UNPROVED ONE — see PROVED_HOP_MAX_SQUARES.
        // The lookahead is only a candidate list; `took` below still refuses anything the
        // pull did not prove, so widening it cannot lengthen an unproved hop.
        const onProof = pulled && next && pulled.squares.has(`${next.row},${next.col}`);
        const cap = hopLimit >= MOVE_HOP_MAX_SQUARES && onProof
          ? PROVED_HOP_MAX_SQUARES : hopLimit;
        const reach = [];
        for (let i = 0; i < queue.length && reach.length < Math.max(1, cap) - 1; i++) {
          const s = queue[i];
          if (occupied.has(`${s.row},${s.col}`)) break;
          reach.push(s);
        }
        // A SQUARE ON A PROVED LEG NEEDS NO TRACE. The pull already showed the straight
        // line arrives, and a prefix of a line that arrives also arrives — so the furthest
        // square inside the hop cap is takeable for free. This is the 5.8x, and it is also
        // what stops the walker burning the shared event loop on proofs it already has.
        let took = -1;
        // Where the body is, for the mover check below and for `missedHops` further down.
        const hereSq = c.self ?? from0;
        if (pulled && next && pulled.squares.has(`${next.row},${next.col}`)) {
          for (let i = reach.length - 1; i >= 0; i--) {
            const s = reach[i];
            if (!pulled.squares.has(`${s.row},${s.col}`)) continue;
            // THE PROOF IS A SHORTCUT PAST THE TRACE. IT IS NOT A SHORTCUT PAST THE MOVER.
            //
            // A proved leg skips the per-square `arrives()` trace, which is the 5.8x and
            // worth keeping. What it must not skip is the question of whether the step LANDS,
            // because the pull is computed from the character's exact FINE position and a
            // line that was clear from one sub-square offset is not clear from another — and
            // after the first slide the walker is never at a centre again.
            //
            // Left unchecked it offered squares the coarse grid calls SOLID ROCK. Measured in
            // the Cragged Mountains on a character at full health taking no damage at all:
            // targets 36,34 / 31,35 / 38,34 all read walkable=false, standable=true,
            // moverStepLands=false, and the walker aimed a six-square hop into the rock face
            // over and over. Every move was SENT — thirty-two of them, none refused — and
            // each one clipped and slid along the wall instead of arriving, which is what an
            // operator watching it described as the character walking along the western wall.
            // Sixty seconds inside three squares, untouched.
            //
            // `moverStepLands` is the same question the router is required to plan on
            // (docs/m59-routing.md), so this makes the fast path agree with the slow one
            // about what a step is, rather than agreeing with a proof about what a LINE is.
            if (hereSq && typeof geo.moverStepLands === 'function' &&
                !geo.moverStepLands(hereSq.row, hereSq.col, s.row, s.col)) continue;
            took = i; break;
          }
        }
        // Otherwise, or on a leg the pull could NOT prove, ask the geometry exactly as
        // before. An unproved leg carries no promise and must not be jumped along.
        if (took < 0) {
          for (let i = reach.length - 1; i >= 0; i--)
            if (arrives(here, fineOf(reach[i]))) { took = i; break; }
        }
        // Never re-offer a hop this walk has already watched miss from this square. The
        // shorter candidates below it are still available, which is the point: the line is
        // walkable, the LENGTH is not.
        while (took >= 0 && hereSq &&
               missedHops.has(edgeKey(hereSq.row, hereSq.col, reach[took].row, reach[took].col)))
          took--;
        if (took >= 0) {
          for (let k = 0; k <= took; k++) {
            const s = queue.shift();
            if (k < took) skipped.push(s);   // everything between here and the far end
            next = s;
            hop++;
          }
          hop--;                         // `next` was already counted by the shift above
        }
      } else {
        // NO COLLISION MODEL MEANS THE OLD RULE, EXACTLY. A checkout with no baked
        // geometry has nothing to trace against, and must walk precisely as it did.
        const dc0 = Math.sign(next.col - (c.self?.col ?? next.col));
        const dr0 = Math.sign(next.row - (c.self?.row ?? next.row));
        while (hop < MOVE_HOP_MAX_SQUARES && queue.length) {
          const peek = queue[0];
          if (Math.sign(peek.col - next.col) !== dc0 || Math.sign(peek.row - next.row) !== dr0) break;
          if (occupied.has(`${peek.row},${peek.col}`)) break;
          if (blockedEdges.has(edgeKey(next.row, next.col, peek.row, peek.col))) break;
          skipped.push(next);
          next = queue.shift(); hop++;
        }
      }
      const was = c.self ? { col: c.self.col, row: c.self.row } : null;
      // A FALL IS A DIFFERENT KIND OF STEP AND THE MOVER HAS TO BE TOLD. `neighbors` marks
      // it; `fallTargets` proved it in fall mode; without the flag the same two squares are
      // refused by an ordinary wall trace. See validateFineTarget.
      // A DECLARED JUMP RE-AIMS AROUND WHATEVER IS ON THE LINE — HERE, WHERE IT IS TAKEN.
      //
      // `clearestLanding` was written for the rail and only ever ran there, and the rail is
      // not how this fleet crosses Ukgoth: the walker takes the jump as an ordinary planned
      // fall edge, right here. So sixty-eight jumps' worth of measurement sat on a path
      // nobody used while the fleet jumped blind into a queue of trolls — 38% blind against
      // 79% re-aimed, and 0 against a blocker either way if you do not move the aim.
      //
      // Only for a DECLARED fall. An ordinary detected fall has no shelf to choose from and
      // no operator behind it, and re-aiming one would be inventing a landing.
      // The re-aim used to be duplicated here. `step` owns it now — it is the primitive every
      // fall passes through, and two homes for one heuristic is how they drift apart.
      const r = await this.step(next.col, next.row, { beforeMutation, fall: !!next.fall });
      // Every packetless result yields (see _yieldIfPacketless): the guard below yields every
      // twenty-fifth, which was tuned for refusals of a tenth of a millisecond — with a clocked
      // needle in each one, twenty-five is ten seconds without a turn of the event loop.
      if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
      if (r?.moved || r?.reason === 'raw_move_rejected' || (r?.travelled ?? 0) > 0) packetless = 0;
      else {
        packetless++;
        if (packetless % 25 === 0) await new Promise(res => setTimeout(res, 60));
        if (packetless >= 400) {
          try {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                           room: Number(this.world?.room?.num ?? 0),
                           tactic: 'walk_spin', trigger: 'no_packets', worked: false, ms: 0, hp_lost: 0,
                           attempted: false,
                           note: `${packetless} consecutive step attempts refused locally without a packet at ` +
                                 `${next.row},${next.col} (last reason ${r?.reason ?? '?'}); walk abandoned` });
          } catch { /* evidence, not a dependency */ }
          return { arrived: false, reason: 'spinning_without_packets',
                   blocked_at: { col: next.col, row: next.row }, steps: taken, replans,
                   note: `${packetless} consecutive step attempts refused locally without a packet — ` +
                         'the room refuses every move from here; let the caller re-plan from a different square' };
        }
      }
      taken += hop;
      if (r.left_room)
        return { arrived: false, left_room: true, steps: taken, note: 'a step crossed the room edge' };
      if (isTerminalMovementReason(r.reason))
        return { arrived: false, ...r, steps: taken, replans };
      // ASK BEFORE GIVING UP. This is the site that ended 17 of 21 journeys on one run:
      // the step landed, the room was rebuilt, our own object had not come back yet, and
      // the walk was abandoned rather than waiting for a read already on its way.
      const now = c.self ?? await this.selfOrResync();
      // EVERY SQUARE THIS BODY LANDS ON, whether the plan asked for it or not. Recorded here
      // rather than where a step is REQUESTED, because the off-plan slide is the thing worth
      // counting: a loop made of steps the mover kept redirecting looks like progress at the
      // request site and like a shuffle here. See `_crossingOscillation`.
      // Guarded the way `_blockingBodies` and `_blinkPointHere` are guarded a few lines
      // below: `walkTo` is lifted out of this class and run against hand-built sessions by
      // m59-collision-test.mjs, and a fixture is not obliged to carry the whole Session.
      if (now && typeof this._noteCrossingSquare === 'function')
        this._noteCrossingSquare(now.row, now.col);
        if (!now)
          return { arrived: false, reason: 'own_position_unknown',
                   note: 'lost authoritative own-position state while walking, and a ' +
                         'position re-read did not bring it back',
                   steps: taken, replans };
      // GROUND ALREADY MADE IS NOT GIVEN BACK — the rail's rule, which the ordinary walker
      // never had.
      //
      // The existing `gainedGround` test only runs when a step MISSES, and the dither is made
      // of steps that land exactly where they were aimed, on a plan that keeps changing. So it
      // was invisible. Measured crossing The Streets of Tos — open town floor, nothing in the
      // way:
      //
      //   43,24 -> 42,31 -> 43,24 -> 42,31 -> 43,24 -> 42,31 -> 43,24
      //   37,27 -> 41,28 -> 37,27 -> 41,28 -> 37,27
      //
      // 324 moves over 164 seconds, 184 distinct positions, for a crossing 24 squares long —
      // 1.12 squares a second against the five a player does, and the same diagonal walked
      // three times over.
      //
      // Measured on the TARGET rather than on the plan, because the plan is what is wrong: how
      // far is the body from where it is going, and has that number moved. Bounded, not
      // forbidden — going around something legitimately costs ground, and a walk that is
      // genuinely progressing resets this on every improvement.
      //
      // A BODY IN THE WAY IS NOT A DITHER. Standing still because something is standing on
      // the next square is a fight or a wait, it has its own budget below, and it reports its
      // own facts — how many bodies, where, and the health lost to them. Counting it here
      // would swallow all of that and call it a bad plan.
      // AND IT HAS TO BE A DITHER, NOT MERELY A DETOUR.
      //
      // The first version of this counted steps that did not get closer, and that is not the
      // same thing: walking round a building legitimately loses ground for a while. It cost a
      // character its whole leg — Bbbb spent THREE HUNDRED AND EIGHTY SECONDS in The Streets
      // of Tos and never left, because the guard fired, `walkTo` handed back a failure, and
      // `leaveViaAny` read that as `every square for that exit refused (2 tried)`. A dither
      // became an unreachable door.
      //
      // The signature of a dither is REVISITING: 43,24 -> 42,31 -> 43,24 -> 42,31. A detour
      // walks new ground even while the gap grows. So the count only advances when the body
      // lands somewhere it has already been AND the walk is no closer than its best.
      const gapNow = Math.max(Math.abs(now.row - row), Math.abs(now.col - col));
      const hereKey = `${now.row},${now.col}`;
      const revisited = seenSquares.has(hereKey);
      seenSquares.add(hereKey);
      if (gapNow < bestGap) { bestGap = gapNow; sinceCloser = 0; }
      else if (r.reason === 'object_blocked') { /* the body path owns this one */ }
      else if (revisited && ++sinceCloser > WALK_STALL_STEPS)
        return { arrived: false, steps: taken, replans,
                 blocked_at: { col: now.col, row: now.row },
                 reason: 'no_ground_gained',
                 note: `${sinceCloser} revisited squares without getting closer than ` +
                       `${bestGap} — this is a dither, not a walk. The plan is what is wrong, ` +
                       'so the caller gets it back rather than another lap of the same two ' +
                       'squares.' };
      if (now.col === next.col && now.row === next.row) {
        // It landed where it was aimed, so the reach it used is one the ground supports.
        if (was && (was.col !== now.col || was.row !== now.row)) prevSquare = was;
        hopLimit = MOVE_HOP_MAX_SQUARES;
        stalledOn = null; stalledTimes = 0; continue;
      }
      if (was && (was.col !== now.col || was.row !== now.row)) prevSquare = was;
      // A LONG MOVE THAT MISSED SAYS NOTHING ABOUT A SHORT ONE. Shorten before blaming the
      // route, the edge or the body in the way: those verdicts are all about a step, and
      // what just failed was several.
      if (hop > 1) {
        hopLimit = 1;
        // REMEMBERED, so the next arrival cannot hand this same hop back. `hopLimit` alone
        // is not enough: it climbs back to full on the first step that lands where it was
        // aimed, and in a cycle that step comes round every three moves.
        if (was) missedHops.add(edgeKey(was.row, was.col, next.row, next.col));
        // AND GIVE BACK EVERY SQUARE THE HOP SWALLOWED, not just its far end.
        //
        // Collapsing the reach to one is the right instinct and it did nothing, because the
        // coalescer SHIFTS the intermediate squares off the queue and keeps only the far
        // endpoint. Re-queueing that endpoint alone leaves the walker with a single plan
        // entry thirteen squares away — so "retry as single steps" has no single steps to
        // take, and the next attempt is the identical long move.
        //
        // Measured in the Cragged Mountains, one character, traced move by move:
        //
        //   at 7,14 -> target 7,27   sent      (slides to 8,15 instead of arriving)
        //   at 8,15 -> target 7,27   REFUSED   geometry_blocked
        //   at 8,15 -> target 7,14   sent      (walks back to the proof line)
        //   at 7,14 -> target 7,27   sent      ...and round again, seven times, until dead
        //
        // Twenty-five seconds inside two squares while things ate it. The operator ran the
        // same room by hand in under twenty seconds. Putting the swallowed squares back is
        // what turns the retry into an actual walk.
        queue.unshift(next);
        if (skipped.length) queue.unshift(...skipped);
        taken -= hop - 1;
        continue;
      }

      // LANDED SOMEWHERE ELSE — counted, because the RATE is the diagnosis.
      //
      // The router validates a step centre-to-centre (`moverStepLands` asks "from the
      // CENTRE of A, can I land in B"), and after the first slide the walker is never at
      // a centre again. Simulated on room 587's approach to its western gap with the real
      // fine position carried forward: 4 of 9 planned steps land off-plan from one start
      // and 24 of 42 from another, while the model calls every one of them legal.
      //
      // Each of those costs a replan, and the replan produces the same square-to-square
      // plan that just failed — which is why crossing one room took 88-208s against 15s
      // for a direct walk to the same gap, and why a four-square doorway becomes a
      // pile-up as soon as a second character wants it.
      offPlan++;

      // DID NOT MOVE AT ALL vs ENDED UP SOMEWHERE ELSE. These were treated the same and
      // they need opposite responses. Ending up elsewhere means the route is stale, so
      // replanning from the new position is right. NOT MOVING means the next square is
      // occupied — and replanning from an unchanged position returns the identical
      // route, so the walker spent its three replans re-deciding to walk into the same
      // monster and then reported "kept ending up somewhere other than the planned
      // square" about a character that had not moved at all.
      const didNotMove = was && now.col === was.col && now.row === was.row;

      // A MONSTER MOVES AND A WALL DOES NOT, SO THEY GET OPPOSITE TREATMENT — and the
      // server already tells us which it was. `object_blocked` is the obstacle arm of the
      // local collision pass; every other refusal is geometry. Waiting 700ms for a wall to
      // wander off was pure cost, and it was paid on every lap of the bounce above.
      const hitSomething = r.reason === 'object_blocked';
      if (hitSomething && refunded < maxSteps) { taken -= hop; refunded++; }

      // THE WALL-HUG RECOVERY BELONGS HERE TOO, NOT ONLY ON A RAIL.
      //
      // `recentreInSquare` was added to `followRail` and cut room 586's geometry refusals
      // from 144 to 21 in a measured pair of runs. The ordinary walker never got it, and it
      // is the same failure: the bake traces centre to centre, the mover traces from where
      // the body actually is, and a body slid against a wall inside its own square is refused
      // a step the geometry plainly allows.
      //
      // 586's row-47 corridor is where this still shows: `47,14 -> 47,13` refused eight
      // times, `48,15 -> 47,13` twelve, with the body sending from 47,11, 47,12 and 48,12
      // over and over. Every one of those squares is walkable and every step between them
      // answers `moverStepLands` true.
      //
      // Once per square, and only for a geometry refusal that did not move the body: a
      // refusal that survives standing in the middle is a real one, and the blame below is
      // then the right answer. Guarded because `walkTo` is lifted out of this file by text.
      if (!hitSomething && didNotMove && r.reason === 'geometry_blocked'
          && was && !recentredAt.has(`${was.row},${was.col}`)
          && typeof this.recentreInSquare === 'function') {
        recentredAt.add(`${was.row},${was.col}`);
        if (await this.recentreInSquare().catch(() => false)) continue;
      }

      // THE EDGE THAT REFUSED IS THE ONE WE ASKED FOR, AND IT IS NAMED FROM WHERE WE
      // ASKED IT — not from where we ended up. That distinction is the whole of this fix.
      // A slid step leaves the character at neither end of the step it requested, so
      // blaming the edge out of the LANDING square blames an edge nobody tried: measured,
      // the two-square bounce simply carried on, alternating between the refused edge and
      // an unblocked twin. `was -> was + one step in the requested direction` is exactly
      // what the mover was asked to do and exactly what a replan would ask again.
      //
      // A coalesced hop covers several squares and only names its first, so when one fails
      // this attributes the first rather than the guilty one. That is deliberate and it is
      // the safe direction: the cost of blocking a good edge is a slightly longer route,
      // the replan re-asks from nearer, and the real blocker is found on the next lap.
      const bdr = Math.sign(next.row - (was?.row ?? next.row));
      const bdc = Math.sign(next.col - (was?.col ?? next.col));
      // A REFUSED FALL IS A BAD APPROACH, NOT A BAD LEDGE.
      //
      // `fallTargets` proved this drop from the take-off square's STAND POINT and the proof
      // still holds: measured in room 578, 36 of the 64 points sampled inside 45,16 make
      // the fall to 43,16 land correctly. A body that slid into one of the other 28 is
      // wedged against the cliff — no point in the landing square works from there, no
      // neighbouring landing works, and `finePath` cannot even reach the take-off point.
      //
      // Blaming the ledge is what learning `45,16 > 43,16` does, and it deletes the only
      // way down: 578 has no other, so the walk bounced 45,16 <-> 45,17 until its budget
      // ran out, every single crossing. Blaming the APPROACH sends the router at the same
      // ledge from a different neighbour, which puts the body on a different fine point,
      // and most of them work. Offline, that alone turns the crossing from "bouncing" into
      // an arrival.
      const blamed = next.fall && prevSquare
        ? edgeKey(prevSquare.row, prevSquare.col, was?.row ?? next.row, was?.col ?? next.col)
        : (was ? edgeKey(was.row, was.col, was.row + bdr, was.col + bdc) : null);
      let learned = false;
      if (!hitSomething && was && blamed && (bdr || bdc || next.fall)) {
        if (!blockedEdges.has(blamed)) { blockedEdges.add(blamed); learned = true; }
        // AND REMEMBERED PAST THIS WALK, but only when the geometry says so outright.
        //
        // `moverStepLands` asked from the square we actually stood on is the same question
        // the mover just answered, so a `false` here is proof rather than inference — the
        // one thing worth carrying into the next replan. A refusal we cannot corroborate
        // (a slide, a fall, an unbaked room) stays local and is forgotten as before.
        //
        // Bounded, because a session is long and a map is not: past the cap the room stops
        // learning rather than growing without limit.
        if (impossibleHere && !next.fall && (bdr || bdc)
            && typeof geo?.moverStepLands === 'function'
            && impossibleHere.size < 4096) {
          const tr = was.row + bdr, tc = was.col + bdc;
          try {
            if (!geo.moverStepLands(was.row, was.col, tr, tc)) impossibleHere.add(blamed);
          } catch { /* a geometry that cannot answer teaches nothing, which is the old behaviour */ }
        }
      }

      // HALF OF WHAT THE SQUARE LATTICE CALLS A WALL IS A SLIDE THAT LANDED NEXT DOOR.
      //
      // `moverStepLands` asks whether a step from one stand point ARRIVES IN the target
      // square. Around the Cibilo Creek Inn's porch — where prod characters pile up, 295
      // samples on one square — five of the eight steps out of 8,58 are "refused", and only
      // two of those are walls: the rest MOVE the body and simply land in a neighbouring
      // square. A lattice cannot express that, so the walker learns an edge, replans, and
      // meets the same lip from the next square along.
      //
      // Fine positioning can: `finePath` searches a quarter-square lattice, validating every
      // move with the same trace the mover enforces, and raycasts the result down to the
      // corners the geometry actually requires. On this porch it threads 8,58 to the inn
      // door in 56 nodes and 25ms, and pulls to a SINGLE straight move.
      //
      // Local, and only after a refusal. A fine search across a whole outdoor room is tens
      // of thousands of nodes and is not what this is for — the coarse plan is good at
      // "which way round", and this is good at "and now through the gap".
      // FIRE ON ANY GEOMETRY-CAUSED OFF-PLAN LANDING, NOT ONLY ON A NEW REFUSED EDGE.
      //
      // Gating this on `learned` was too narrow, and the Cibilo Creek porch is exactly why:
      // walking from the inn door to Cor Noth's north gate the walker takes 38 steps,
      // learns only TWO edges, and ends at 8,58 — the square 295 prod samples pile up on.
      // The steps are not being refused; they MOVE the body and land somewhere the plan did
      // not expect, which is what a slide off a fenced lip does. So the detour has to answer
      // the landing, not the refusal.
      if (!hitSomething && was && geo.collisionReady && fineDetours < FINE_DETOUR_MAX) {
        // CLIENT UNITS ON BOTH ENDS. `finePath` searches the client lattice — 1024 to the
        // square — while `c.self` is the WIRE position at 64 to the square. Handing it wire
        // coordinates starts the search a twentieth of the way across the room from where
        // the body is, which finds nothing and costs a search to find it. The same mixing
        // this repository already warns about for traces.
        const here = Number.isFinite(c.self?.x) && Number.isFinite(c.self?.y)
          ? { x: protocolToClient(c.self.x), y: protocolToClient(c.self.y) } : null;
        const goal = pointOfSquare(geo, next.row, next.col);
        if (here && goal) {
          fineDetours++;
          const bounds = boundsAround([{ row: was.row, col: was.col },
                                       { row: next.row, col: next.col }], FINE_DETOUR_MARGIN);
          const found = finePath(geo, here, goal, { bounds, maxNodes: FINE_DETOUR_NODES });
          if (found?.found) {
            const legs = pullFine(geo, here, found.points);
            let threaded = false;
            for (const leg of legs) {
              if (this.movementWasCancelled(movementGeneration, controlToken)) break;
              const step = await this.stepFine(clientToProtocol(leg.x), clientToProtocol(leg.y))
                .catch(() => null);
              if (step?.left_room)
                return { arrived: false, left_room: true, steps: taken,
                         note: 'a fine detour crossed the room edge' };
              const at = c.self;
              if (at && at.row === next.row && at.col === next.col) { threaded = true; break; }
            }
            const at = c.self;
            if (threaded || (at && at.row === next.row && at.col === next.col)) {
              // Through the gap. The edge we blamed was never the problem, so unlearn it —
              // leaving it would push every later replan away from a way that works.
              // Local only. If `moverStepLands` called this edge impossible it is in the
              // room's memory too, and threading PAST it in fine units does not make the
              // square-to-square step walkable — that is the distinction the persistent set
              // exists to keep.
              if (learned && blamed && !impossibleHere?.has(blamed)) blockedEdges.delete(blamed);
              recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: geo?.num ?? null,
                             tactic: 'fine_walk', trigger: 'off_plan', worked: true,
                             note: `threaded ${legs.length} fine leg(s) past a lattice refusal` });
              continue;
            }
          }
        }
      }

      // A BODY THAT IS HITTING US IS NOT GOING TO WANDER OFF.
      //
      // The retry below is built on "monsters wander, so one retry costs a second and
      // often clears it". That is true of a monster that has not noticed us and false of
      // the only case that kills anybody: one that is ENGAGED. An engaged monster stays
      // exactly where it is, because we are what it is standing there for — so every
      // patient 500-1000ms lap is damage taken for nothing, and the walker takes them one
      // after another while its keeper is inert by design for the length of the errand.
      //
      // Measured on prod, deaths in one two-hour window: 5 of the 18 that recorded hits in
      // their last minute took EVERY one of them on a single square. Kermit stood on one
      // square in Main gate to Cor Noth for 118 seconds and took 23 hits; Beaker and
      // Statler each lost 47-51 health in 9 seconds without moving. Those are not walks
      // that were too slow, they are walks that stood still and were eaten.
      //
      // So being hit does not end the trip — doctrine is explicit that a planned journey
      // completes, and two attempts to bail out on health were tried here and reverted —
      // it just stops us WAITING. Under fire the polite lap is skipped and the walker goes
      // straight to the moves that change something: round the body, or a replan that
      // treats its square as taken.
      const hpNow = c.vitals?.()?.health?.value;
      if (Number.isFinite(hpNow)) {
        if (!Number.isFinite(hpAtLastBlock)) hpAtLastBlock = hpNow;
        if (hpNow < hpAtLastBlock) { damageWhileBlocked += hpAtLastBlock - hpNow; underFire = true; }
        else if (hpNow > hpAtLastBlock) underFire = false;   // healed or disengaged
        hpAtLastBlock = hpNow;
      }

      if (didNotMove && hitSomething) {
        // COUNTED, BECAUSE A WALK EATEN BY BODIES USED TO BE INDISTINGUISHABLE FROM A
        // WALK WITH TOO SMALL A BUDGET. Both returned `stopped after N steps` with
        // `replans: 0` — the zero because adding an occupied square sets `learned`, and
        // `learned` suppresses the replan counter below. Measured live in the King's Way:
        // the same 3-step walk read `steps: 40, replans: 0` with eleven rats plugging a
        // two-wide corridor and `steps: 3, arrived` once they moved. Nothing in the reply
        // named a monster, so this read as a routing fault for as long as anyone looked
        // at it — which is how it got attributed to the safe-wall geometry it happened to
        // be near. It is a different bug and it needs a different word.
        monsterBlocks++;
        blockedBy.add(`${next.row},${next.col}`);

        // Monsters wander. One retry costs a second and often clears it, which is
        // cheaper and less disruptive than routing the long way round.
        // PATIENCE IS FOR PLAYERS. A MONSTER IS AN OBSTACLE; A PLAYER IS A QUEUE.
        //
        // One patient lap, then mark the square occupied and replan -- which is right for a rat
        // and wrong for the commonest blocker on a travelled road, which is another character
        // walking the same road. A player is going SOMEWHERE. It vacates on its own, and the
        // only thing needed is to not give up in the second before it does.
        //
        // AND IN A ONE-SQUARE CORRIDOR GIVING UP IS UNRECOVERABLE. The escalation is a sidestep,
        // there is no side, so the square goes into `occupied` for the rest of the walk and A*
        // is asked for a route through a pipe with a hole punched in it. Room 108's sewer pipe
        // (row 35, col 47) is exactly one square wide and is the only way to the jump take-off:
        // one bot crosses 108 -> 110 four times out of four, and six bots at once crossed it
        // none out of six, each having poisoned the corridor for itself against bodies that
        // were merely passing through.
        //
        // So a player blocker buys laps instead of a verdict. The wait below is already jittered,
        // so the queue does not move in lockstep, and `underFire` still overrides everything --
        // a body that is HITTING us is not queuing, and waiting on it is how characters die on
        // one square. Monsters are unchanged at one lap.
        //
        // Escalation is not abandoned, only deferred: after this many laps the sidestep, the
        // retreat and the replan all run exactly as before.
        const blockerIsPlayer = !!(c.room?.objects && [...c.room.objects.values()].some(o =>
          o.id !== c.selfId && o.col === next.col && o.row === next.row && (o.flags & OF.PLAYER)));
        const patience = (blockerIsPlayer && !underFire) ? QUEUE_PATIENCE : 1;
        if (underFire || (stalledOn === `${next.row},${next.col}` && stalledTimes >= patience)) {
          // GO ROUND IT RATHER THAN ROUND THE ROOM. Marking the square occupied and
          // replanning is correct and expensive: A* re-solves the whole route, and in a
          // corridor the only answer it can find is the long way, which is how a
          // three-step walk becomes forty. A body is one square wide — the cheap move is
          // to try the two squares either side of it first.
          //
          // BACK UP FIRST, and that is the part that is not obvious. Standing next to the
          // blocker, the diagonal past it is frequently refused by the mover as well:
          // squeezing between a body and a wall is exactly the clearance the player disc
          // does not have. Retreating one square opens the angle, which is what a person
          // does without thinking about it.
          //
          // It is only ever a PREFERENCE. If neither side works the ordinary occupancy
          // path below runs exactly as it did before, so this can cost a couple of steps
          // and cannot cost the walk.
          // WHAT IS IN THE WAY DECIDES WHICH ORDER TO TRY THE SIDES IN. A player is also
          // dodging and needs the id tie-break; a monster is not, and gets the fixed
          // clockwise-first order. Read off the room rather than assumed: `blockedBy` only
          // records the square.
          const side = this.sidestepAround(was, next,
            { blockedEdges, occupied, geo, prefer: Number(c.self?.id ?? 0), blockerIsPlayer });
          if (side && !sidestepped.has(`${next.row},${next.col}`)) {
            sidestepped.add(`${next.row},${next.col}`);
            queue.unshift(next);
            queue.unshift(side.through);
            if (side.back) queue.unshift(side.back);
            // A SIDESTEP IS OFF THE PULLED LINE. Its squares were never proved, and the
            // one behind us is deliberately backwards, so drop the proof rather than let
            // the coalescer jump along a leg nobody traced.
            pulled = null;
            stalledOn = null; stalledTimes = 0;
            continue;
          }
          // NO SIDE TO STEP TO IS NOT THE SAME AS NO WAY PAST. See laneAroundBody: in a
          // one-square corridor the pass is a different fine y inside the SAME square, which
          // nothing above can express. Tried once per blocked square, before the square is
          // written off, and a refusal simply falls through to the recovery below.
          let laneTried = false, laneMoved = false;
          if (!lanedPast.has(`${next.row},${next.col}`)) {
            lanedPast.add(`${next.row},${next.col}`);
            const lane = this.laneAroundBody(was, next, geo, c);
            if (lane) {
              laneTried = true;
              const moved = await this.stepFine(lane.x, lane.y).catch(() => null);
              laneMoved = !!moved?.moved;
              recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                             room: Number(this.world?.room?.num ?? 0),
                             tactic: 'body_lane', trigger: 'no_side_to_step_to',
                             worked: !!moved?.moved, ms: 0, hp_lost: 0, attempted: true,
                             note: `threaded ${next.row},${next.col} at offset ${lane.off} ` +
                                   `for ${lane.gap.toFixed(1)} of clearance` });
              if (moved?.moved) {
                pulled = null; stalledOn = null; stalledTimes = 0;
                queue.unshift(next);
                continue;
              }
            }
          }
          // THE PERP WALK, when the lane found nothing or its one step was refused. Tried once
          // per blocked square, like the lane, and every attempt is a `perp_walk` row in the
          // tactics ledger — side, offset, slack, how far it got — because the operator asked
          // for this as an experiment with telemetry, and an experiment that cannot be read
          // back is an opinion. See perpWalkPastBodies for the geometry.
          if (!laneMoved && !perpWalked.has(`${next.row},${next.col}`)) {
            perpWalked.add(`${next.row},${next.col}`);
            const perp = this.perpWalkAroundBodies(was, next, geo, c);
            const who = this.client?.me?.name ?? this.name ?? null;
            const roomNum = Number(this.world?.room?.num ?? 0);
            if (perp?.points?.length === 2) {
              const t0 = Date.now();
              const hpNow = () => { try { return c.vitals?.()?.health?.value ?? null; } catch { return null; } };
              const hp0 = hpNow();
              const [p0, p1] = perp.points;
              const on = await this.stepFine(p0.x, p0.y).catch(e => ({ moved: false, reason: e.message }));
              const ran = on?.moved
                ? await this.walkFine(p1.x, p1.y, { maxSteps: 16, stride: 32, arriveWithin: 12,
                                                    movementGeneration, controlToken })
                        .catch(e => ({ arrived: false, reason: e.message }))
                : null;
              const worked = !!ran?.arrived;
              const hp1 = hpNow();
              recordTactic({ character: who, room: roomNum,
                             tactic: 'perp_walk', trigger: laneTried ? 'lane_refused' : 'no_lane',
                             worked, ms: Date.now() - t0, attempted: true,
                             hp_lost: (hp0 != null && hp1 != null) ? Math.max(0, hp0 - hp1) : 0,
                             note: `side ${perp.side > 0 ? '+' : '-'} offset ${perp.offset.toFixed(1)} ` +
                                   `slack ${perp.slack.toFixed(2)} past ${perp.bodies} body(ies) ` +
                                   `${p0.x},${p0.y} -> ${p1.x},${p1.y}: ` +
                                   (worked ? `arrived in ${ran.steps ?? '?'} step(s)`
                                           : on?.moved ? `walk stopped: ${ran?.reason ?? ran?.note ?? 'did not arrive'}`
                                                       : `sidestep refused: ${on?.reason ?? 'no reason'}`) });
              if (worked) {
                // Squares the walk has already passed are not aimed at again: anything whose
                // centre projects behind the body along the walk axis is dropped, and the
                // ordinary walker carries on from the far point toward what is left.
                const meNow = c.self;
                const ahead = sq => meNow
                  ? ((sq.col * KOD_FINENESS + 32) - meNow.x) * perp.axis.ux
                    + ((sq.row * KOD_FINENESS + 32) - meNow.y) * perp.axis.uy
                  : 0;
                pulled = null; stalledOn = null; stalledTimes = 0;
                if (ahead(next) > -(KOD_FINENESS >> 1)) queue.unshift(next);
                while (queue.length > 1 && ahead(queue[0]) < -(KOD_FINENESS >> 1)) queue.shift();
                continue;
              }
            } else if (perp?.why) {
              recordTactic({ character: who, room: roomNum, tactic: 'perp_walk',
                             trigger: laneTried ? 'lane_refused' : 'no_lane',
                             worked: false, ms: 0, hp_lost: 0, attempted: false,
                             note: `${perp.bodies} body(ies) in the way; ${perp.why}` });
            }
          }
          // BLINK, FROM THE BLOCKED STEP. The strategies were only ever asked from the
          // room-crossing give-up, which a jam in the middle of a route never reaches — tour 5
          // walked through the 584 pipe with blink enabled for everyone and produced no
          // blink_escape row at all. So the same question is put here, once per blocked
          // square, after the sidestep, the lane and the perp walk have all had their turn and
          // the square has held us for the strategy's own patience. The answer's need_safe_spot
          // is honoured (a wall first, via the keeper's ladder), and a teleport that lands is
          // followed by a REPLAN from where the body now is, not by the old queue.
          const stuckKey = `${next.row},${next.col}`;
          if (!blockedSince.has(stuckKey)) blockedSince.set(stuckKey, Date.now());
          // ONCE PER SQUARE IS THE WRONG BUDGET FOR A LOOP, and it is why a shuffle could
          // never get an answer out of this site. `blinkAsked` stops us re-asking about the
          // same blocked square, which is right for a body pushing at one obstacle. A body
          // going round in circles visits four or five squares in turn, banks an ask against
          // each of them within the first few seconds, and is then silent for the rest of the
          // crossing — the longer it goes on, the more certainly every square in the loop is
          // already in the set. So a crossing that is past the stall clock AND oscillating
          // asks again regardless, on its own cooldown rather than per square.
          const oscillating = typeof this._crossingOscillation === 'function'
            ? this._crossingOscillation() : null;
          const crossingMs = typeof this._crossingMs === 'function' ? this._crossingMs() : 0;
          const stalledCrossing = crossingMs >= CROSSING_STALL_MS && !!oscillating;
          const askAgain = stalledCrossing &&
                           Date.now() - (this._lastBlinkAskAt ?? 0) >= CROSSING_ASK_EVERY_MS;
          if ((!blinkAsked.has(stuckKey) || askAgain) && typeof this._askStrategies === 'function') {
            if (askAgain) this._lastBlinkAskAt = Date.now();
            const stuckMs = Date.now() - blockedSince.get(stuckKey);
            const answer = await this._askStrategies('whenStuck', {
              room: this.world?.room ?? null, geo, self: c.self ?? null,
              goal: { row, col },
              route: [next, ...queue].filter(Boolean).map(sq => ({ row: sq.row, col: sq.col })),
              bodies: typeof this._blockingBodies === 'function' ? this._blockingBodies() : [],
              blink: typeof this._blinkPointHere === 'function' ? this._blinkPointHere() : null,
              vitals: c.vitals?.() ?? null, stuck_ms: stuckMs, underFire: !!underFire,
              agent: this.name ?? this.client?.me?.name ?? null, from: 'walker',
              // THE CROSSING'S OWN HISTORY, which is the only thing that can contradict a
              // reachability flood. `stalled` carries the evidence sentence, not a boolean,
              // so the observation store says WHY the usual decline was overridden.
              crossing_ms: crossingMs, oscillating,
              stalled: stalledCrossing
                ? `${Math.round(crossingMs / 1000)}s in this room, ${oscillating}` : null,
            }).catch(() => null);
            if (answer?.answer?.do === 'blink') {
              blinkAsked.add(stuckKey);
              const who2 = this.client?.me?.name ?? this.name ?? null;
              let wall = null;
              if (answer.answer.need_safe_spot) {
                const pilot = autopilotIfAny(this.name);
                wall = pilot && typeof pilot.takeSafeSpot === 'function'
                  ? await pilot.takeSafeSpot('a wall to blink from', null, { source: 'travel' })
                               .catch(e => ({ took: false, why: e.message }))
                  : { took: false, why: 'no autopilot to take a wall with' };
              }
              // The nearest wall may have been the exit (see takeSafeSpot): then we are in
              // another room, every attacker is behind us, and there is nothing to cast for.
              if (wall?.via === 'exit' || wall?.crossed) {
                recordTactic({ character: who2, room: Number(this.world?.room?.num ?? 0),
                               tactic: 'blink_escape', trigger: `${answer.strategy} (walker)`,
                               worked: true, ms: 0, hp_lost: 0, attempted: false,
                               note: `blocked at ${next.row},${next.col} for ${Math.round(stuckMs / 1000)}s; ` +
                                     `the nearest wall was the exit and it was taken; no cast needed` });
                try { answer.answer.settled?.(true, 'took the exit instead', null); } catch { /* evidence, not a dependency */ }
                return { arrived: false, left_room: true, reason: 'took_the_exit',
                         blocked_at: { col: next.col, row: next.row }, steps: taken, replans };
              }
              // NO WALL IS NOT A REASON TO STAY STUCK. THE OPERATOR, 2026-09-03.
              //
              // This refused the cast whenever `takeSafeSpot` came back empty, and on the
              // day the stall fix shipped that is what it did to Kermit — twice in two
              // minutes in room 567, on the GENUINE blocked verdict: "blocked from here (24
              // squares) and clear from the blink point (826 squares); no wall (nothing in
              // this room is more defensible)". Twenty-four squares against eight hundred
              // and twenty-six, the one spell that crosses that gap known and afforded, and
              // the answer was to stand there because the room had nowhere tidy to sit.
              //
              // A wall is preparation, not permission. Where there is none the cast still
              // happens; what changes is only what we do first:
              //
              //   not under fire   cast now — nothing is swinging, the wall bought nothing
              //   under fire       back off along proven crumbs for up to five seconds to
              //                    break contact, then cast anyway
              //
              // Breadcrumbs rather than any free square, for the reason the body-retreat a
              // few lines down gives: every crumb is a move the validator already accepted,
              // so backing up cannot open a hole the collision rules would refuse. Bounded
              // by a deadline AND by crumbs, and it stops early the moment nothing that
              // blocks movement is adjacent — the goal is to break contact, not to undo the
              // journey.
              let evaded = null;
              if (!wall?.took && underFire && typeof this.retreatAlongBreadcrumbs === 'function') {
                const deadline = Date.now() + BLINK_EVADE_MS;
                const adjacent = () => !!(c.room?.objects && [...c.room.objects.values()].some(o =>
                  o.id !== c.selfId && blocksMovement(o.flags ?? 0) && c.self &&
                  Math.max(Math.abs(o.row - c.self.row), Math.abs(o.col - c.self.col)) <= 1));
                evaded = await this.retreatAlongBreadcrumbs({
                  maxCrumbs: Number(process.env.M59_BLINK_EVADE_CRUMBS || 4),
                  until: () => Date.now() >= deadline || !adjacent(),
                  movementGeneration, controlToken,
                }).catch(() => null);
              }
              // GET THE LEGS BACK BEFORE THE CAST, NOT AFTER. Blink lands the body on a
              // fixed square the room's kod declares and promises nothing about what is
              // standing on it; running needs at least 10 vigor, and the shuffle that
              // prompted the blink is exactly what grinds vigor away. So the wall we just
              // took is sat on first. Advisory in every direction: no autopilot, no rest,
              // and a rest that is interrupted by damage still casts — tired is worse than
              // still going round in circles.
              //
              // ONLY ON A WALL. The rest was asked for as "rest to vigor IN A SAFE SPOT";
              // sitting down in the open next to whatever we just failed to get away from
              // is not the same thing and is not what it is for. With no wall we cast tired.
              let rested = null;
              if (wall?.took && (answer.answer.rest_to_vigor || answer.answer.rest_to_mana)) {
                const pilot = autopilotIfAny(this.name);
                rested = pilot && typeof pilot.restBeforeBlink === 'function'
                  ? await pilot.restBeforeBlink('vigor and mana before a blink out of a stalled crossing',
                                                { mana: Number(answer.answer.rest_to_mana ?? 0) })
                               .catch(e => ({ rested: false, why: e.message }))
                  : { rested: false, why: 'no autopilot to rest with' };
              }
              const out = await this.blinkOut({ expect: answer.answer.expect }).catch(() => null);
              recordTactic({ character: who2, room: Number(this.world?.room?.num ?? 0),
                             tactic: 'blink_escape', trigger: `${answer.strategy} (walker)`,
                             // ALWAYS TRUE NOW: the cast is no longer gated on a wall, so
                             // there is nothing left that can turn this into a decision
                             // rather than an attempt. This read `castable` until that
                             // variable was deleted, which left a ReferenceError sitting
                             // AFTER the await — the spell went off and the walk then threw.
                             worked: !!out?.arrived, ms: 0, hp_lost: 0, attempted: true,
                             note: `blocked at ${next.row},${next.col} for ${Math.round(stuckMs / 1000)}s; ${answer.answer.why}; ` +
                                   (answer.answer.need_safe_spot
                                     ? (wall?.took ? 'took a wall first; '
                                        : `no wall (${wall?.why ?? '?'}) — casting anyway; `) : '') +
                                   (evaded ? `backed off ${evaded.steps ?? 0} crumb(s) to break contact first; ` : '') +
                                   (rested ? (rested.rested
                                     ? `rested vigor ${Math.round((rested.before ?? 0) * 100)}% -> ${Math.round((rested.vigor_pct ?? 0) * 100)}%` +
                                       `${rested.interrupted ? ' (cut short by damage)' : ''}; `
                                     : `did not rest (${rested.why ?? '?'}); `) : '') +
                                   `${out?.why ?? 'no result'}` });
              try { answer.answer.settled?.(!!out?.arrived, out?.why ?? null, out?.at ?? null); } catch { /* evidence, not a dependency */ }
              if (out?.arrived) {
                const here = c.self;
                const re = here ? geo.path(here.row, here.col, row, col,
                                           { blockedEdges, threats: this.threatsHere(), clearance }) : null;
                if (re?.found) {
                  queue = re.steps.slice();
                  pulled = undefined; stalledOn = null; stalledTimes = 0;
                  continue;
                }
              }
            }
          }
          // KILL AND CONTINUE, THE LAST RESORT. A monster standing on the next square that the
          // character outranks — the same engagement rule the hunt uses, `refuseEngagement`
          // answering null — is fought from here, in the keeper's own bounded rounds, and the
          // square is tried again when it falls or moves. Never a player, never above the
          // flee line, never twice for the same square, and every attempt is a
          // kill_and_continue row: what stood there, how many rounds, whether it cleared.
          if (!killTried.has(stuckKey)) {
            const blocker = [...(c.room?.objects?.values?.() ?? [])].find(o =>
              o.id !== c.selfId && o.col === next.col && o.row === next.row
              && blocksMovement(o.flags ?? 0) && !(o.flags & OF.PLAYER));
            const pilot = blocker ? autopilotIfAny(this.name) : null;
            if (blocker && pilot && typeof pilot.fightInPlace === 'function') {
              killTried.add(stuckKey);
              const name = c.rsc?.get?.(blocker.nameRsc) ?? blocker.name ?? null;
              const who3 = this.client?.me?.name ?? this.name ?? null;
              const roomNum3 = Number(this.world?.room?.num ?? 0);
              const refusal = typeof pilot.refuseEngagement === 'function' ? pilot.refuseEngagement(name) : { why: 'no engagement rule' };
              const hpFrac = () => { const v = c.vitals?.(); return v?.health?.max ? v.health.value / v.health.max : null; };
              const fleeAt = (() => { try { return pilot.safety?.().fleeAt ?? 0.4; } catch { return 0.4; } })();
              if (refusal || (hpFrac() ?? 0) < fleeAt) {
                recordTactic({ character: who3, room: roomNum3, tactic: 'kill_and_continue', trigger: 'blocked_by_monster',
                               worked: false, ms: 0, hp_lost: 0, attempted: false,
                               note: `${name ?? 'a monster'} on ${next.row},${next.col}: ` +
                                     (refusal ? `not fightable — ${refusal.why}` : `health ${Math.round((hpFrac() ?? 0) * 100)}% is under the flee line`) });
              } else {
                const t0 = Date.now(), hp0 = c.vitals?.()?.health?.value ?? null;
                let rounds = 0, killed = false, cleared = false;
                for (let bout = 0; bout < 3; bout++) {
                  if (this.movementWasCancelled(movementGeneration, controlToken)) break;
                  const f = await pilot.fightInPlace(blocker, name).catch(e => ({ killed: false, note: e.message }));
                  rounds += 3;
                  killed = !!f?.killed;
                  const still = [...(c.room?.objects?.values?.() ?? [])].some(o => o.id === blocker.id && o.col === next.col && o.row === next.row);
                  cleared = killed || !still;
                  if (cleared || (hpFrac() ?? 0) < fleeAt) break;
                }
                const hp1 = c.vitals?.()?.health?.value ?? null;
                recordTactic({ character: who3, room: roomNum3, tactic: 'kill_and_continue', trigger: 'blocked_by_monster',
                               worked: cleared, ms: Date.now() - t0, attempted: true,
                               hp_lost: (hp0 != null && hp1 != null) ? Math.max(0, hp0 - hp1) : 0,
                               note: `${name ?? 'a monster'} on ${next.row},${next.col}: ${rounds} round(s), ` +
                                     (killed ? 'killed it' : cleared ? 'it moved off the square' : 'still standing there') });
                if (cleared) {
                  pulled = null; stalledOn = null; stalledTimes = 0;
                  queue.unshift(next);
                  continue;
                }
              }
            }
          }
          // NEITHER SIDE WORKED. BACK UP THE WAY WE CAME AND LET IT FOLLOW US.
          //
          // The third tier, and the operator's: a monster that is attacking will step
          // FORWARD into the square we vacate, which moves the body that is blocking us and
          // opens the ground it was standing on. Retreating is not an escape here — it is a
          // way of making the obstacle move, which is the one thing a sidestep cannot do
          // when every square around us is occupied.
          //
          // ONLY UNDER FIRE, and that is the whole justification. A body that is merely in
          // the way will drift off on its own and the polite wait above is cheaper; a body
          // that is EATING us will not, and the trace that prompted this recorded seventy-
          // five refusals in ten seconds with zero packets sent while health fell from 33 to
          // 4. Standing still there is certain; backing up is merely uncertain.
          //
          // Breadcrumbs rather than any free square, because every crumb is a move the
          // validator already accepted — so the retreat cannot open a hole the collision
          // rules would refuse, which is the property that makes this safe to do at all.
          // `until` stops it the moment the blocked square frees up: the goal is to make the
          // thing move, not to undo the journey.
          if (underFire && !retreatedFromBodies && typeof this.retreatAlongBreadcrumbs === 'function') {
            retreatedFromBodies = true;
            // A BODY, not any object: a logoff ghost is an ActiveObject with the kod's default
            // flags (MOVEON_YES — no collision in the client), and so is an item on the ground.
            // Counting them here made a mushroom on the next square look like a crowd that
            // never left, and the walker backed off three crumbs for it every time.
            const stillThere = () => !!(c.room?.objects && [...c.room.objects.values()].some(o =>
              o.id !== c.selfId && o.col === next.col && o.row === next.row && blocksMovement(o.flags ?? 0)));
            const back = await this.retreatAlongBreadcrumbs({
              maxCrumbs: Number(process.env.M59_BODY_RETREAT_CRUMBS || 3),
              until: () => !stillThere(),
              movementGeneration, controlToken,
            }).catch(() => null);
            if (back?.steps) {
              bodyRetreats++;
              queue.unshift(next);       // and try the same square again from further back
              pulled = null;
              stalledOn = null; stalledTimes = 0;
              continue;
            }
          }
          occupied.add(`${next.row},${next.col}`);
          stalledOn = null; stalledTimes = 0; learned = true;
        } else {
          stalledOn = `${next.row},${next.col}`;
          stalledTimes++;
          queue.unshift(next);                       // try the same square once more
          // JITTERED, TO BREAK LOCKSTEP IN TIME AS WELL AS IN SPACE.
          //
          // Two characters that meet head-on retry on the same 700ms cadence, so they
          // step, collide, wait, and step again in perfect unison — and a side preference
          // alone does not help if both are always deciding at the same instant. A few
          // hundred milliseconds of spread means one of them acts while the other is
          // still waiting, which is how two people actually get past each other.
          //
          // THE JITTER IS ON THE WAIT AND NEVER ON THE CHOICE. Randomising which side to
          // try would make the walker unreproducible, and every routing test here depends
          // on the same inputs giving the same route; a timing difference changes when a
          // decision happens, not what it is.
          // The wait is for a body that might drift off its square. Under fire it will
          // not, so the second spent here is simply a hit taken — skip it and let the
          // branch above route round on the very next lap.
          if (!underFire)
            await new Promise(res => setTimeout(res, 500 + Math.floor(Math.random() * 500)));
          continue;
        }
      }

      // A REPLAN THAT LEARNED SOMETHING IS NOT THE ONE THIS BUDGET IS FOR. The cap exists
      // to stop an endless loop, and a loop is precisely a replan that discovers nothing:
      // every walk of a wall of any length would otherwise exhaust eight tries and report a
      // room impassable. So an informative failure is free — the edge set is finite and
      // shrinks the search each time — and only a repeat burns the budget. `hardCap` still
      // bounds the whole walk in steps, so this cannot run away.
      // AND THE BUDGET HAS TO SCALE WITH THE ROUTE, FOR THE SAME REASON `maxSteps` DOES.
      //
      // Eight was a fixed number against a route of any length, and the step budget ten
      // lines above already scales (`plan.steps.length + 10`) — that asymmetry was
      // arbitrary and it is what ends long walks. The King's Way is 129x88 with 8,639
      // walkable squares and its east boundary is a median 91 steps away; in geometry
      // where ~70% of steps land off-plan, eight uninformative replans are gone in the
      // first quarter of the walk.
      //
      // Measured, with an operator watching the character it happened to: Western border
      // of the Twisted Wood -> The Twisted Wood failed six times over 40s, every attempt
      // reporting "kept ending up somewhere other than the planned square" — this exact
      // message — against the SAME staging square, which it then re-planned and tried
      // again. The character was standing on a square with seven of seven mover
      // neighbours and an eighteen-step route to the boundary.
      //
      // One extra replan per ten planned steps, so a short walk is unchanged (a 9-step
      // route still gets 8) and a 91-step crossing gets 17. `hardCap` still bounds the
      // whole walk at 400 steps, so this cannot run away — the cap that actually stops a
      // runaway is the step count, not this.
      const replanBudget = 8 + Math.floor((plan.steps?.length ?? 0) / 10);
      // THE REPLAN IS COMPUTED HERE, BEFORE THE BUDGET DECIDES, BECAUSE IT IS THE EVIDENCE.
      //
      // It used to be computed twenty lines below, after the budget had already ended the
      // walk — so the one number that says whether the walk is going anywhere was not
      // available to the decision about whether the walk is going anywhere. The same call,
      // moved, and reused below: no extra A*.
      const re = geo.path(now.row, now.col, row, col,
        { avoid: occupied, blockedEdges, threats: this.threatsHere(), clearance });

      // AND "GAINED GROUND" IS MEASURED ON THE ROUTE, NOT ON THE CROW FLY.
      //
      // `gap` is Chebyshev distance to the goal, and it is the wrong measure the moment the
      // way out goes AWAY from the goal first — which is what a mountain room IS. Traced
      // offline in the Cragged Mountains from 30,24 to the Ukgoth doorway, the walk that
      // arrives runs 33,35 -> 32,36 -> 31,35 -> 30,34 -> ... -> 26,23 before turning: nine
      // consecutive steps that are all further from the goal and all correct. Every one of
      // them read as "no ground gained", and eleven of those exhaust the budget.
      //
      // Live, that is exactly what happened: `walk_to` gave up after 38 steps with
      // `refused_edges: 1` and `routed_around: []` — nothing in the way, one wall learned,
      // and the walk abandoned in a room the same route completes offline in 93 steps.
      //
      // The route's own length is the honest measure: a shorter plan than any seen means
      // the walk is closer to done however the crow flies. Both are kept, because either
      // one improving is progress.
      const gap = Math.max(Math.abs(now.row - row), Math.abs(now.col - col));
      const routeLeft = re.found ? (re.steps?.length ?? Infinity) : Infinity;
      const gainedGround = gap < closest || routeLeft < shortestRoute;
      if (gap < closest) closest = gap;
      if (routeLeft < shortestRoute) shortestRoute = routeLeft;
      // A body in the way buys its own replan, up to a bound.
      const bodyPaid = hitSomething && collisionReplans < collisionReplanMax
        ? (collisionReplans++, true) : false;
      if (!learned && !gainedGround && !bodyPaid && ++replans > replanBudget)
        return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                 routed_around: [...occupied], refused_edges: blockedEdges.size,
                 ...(monsterBlocks ? { monster_blocked: monsterBlocks,
                                       blocked_by_bodies_at: [...blockedBy] } : {}),
                 ...(damageWhileBlocked ? { damage_while_blocked: damageWhileBlocked } : {}),
                 note: damageWhileBlocked
                   ? `kept ending up somewhere other than the planned square, and lost ` +
                     `${damageWhileBlocked} health to whatever is standing in the way`
                   : 'kept ending up somewhere other than the planned square' };
      // A SWITCH TO FINE MOVEMENT HERE WAS TRIED, AND ITS MEASUREMENT WAS INVALID.
      //
      // The idea was to hand the remainder of a walk to `walkFine` once `offPlan` passed
      // a threshold. It A/B'd at 1/5 against 4/5 for the plain square walk, which looked
      // decisive — and was not: a second agent was committing to this same file between
      // the two arms (5421a69, a4d4c71), so the arms differed by more than the change
      // under test. The comparison is withdrawn rather than reported.
      //
      // It is still not reinstated, for a reason that survives the bad measurement: those
      // two commits found the actual causes of the same symptom — the outward step past a
      // boundary was clipped and never sent, and `neighbors()` was gating every step on
      // the monster grid — and both are upstream of the off-plan rate this was trying to
      // paper over. Fixing a rate is the wrong move when the thing generating it has just
      // been fixed properly.
      //
      // `offPlan` is kept as TELEMETRY only. It costs an integer, it is the number that
      // would say whether the remaining slide still matters, and nothing acts on it.
      // `re` was computed above, before the budget, because the budget needs it — see the
      // note there. A replan is exactly when something has moved into the way, so its
      // threat field is re-read at that point rather than reused from the top of the walk.
      if (!re.found) {
        // RELAX IN THE ORDER THE FACTS DECAY. Occupancy is a guess about where something
        // was standing a moment ago and is dropped first; a refused edge is a wall and is
        // kept. Only if that still fails is the collision model itself set aside — being
        // wrong about a wall costs a walk, and refusing costs the errand, so the last try
        // is the coarse grid we planned on before any of this existed.
        let open = occupied.size
          ? geo.path(now.row, now.col, row, col,
              { blockedEdges, threats: this.threatsHere(), clearance })
          : re;
        if (open.found) occupied.clear();
        else if (blockedEdges.size) {
          // NOT CLEARED, ONLY SET ASIDE FOR THIS ONE PLAN. Forgetting the refusals would
          // re-enter the same bounce with the same enthusiasm; keeping them means the hop
          // coalescer still steps over them and the next replan still knows. If the coarse
          // plan's own first step is one of them we fail again, learn nothing new, and the
          // budget above ends the walk honestly instead of grinding.
          open = geo.path(now.row, now.col, row, col, { collision: false });
          if (open.found) occupied.clear();
        }
        // AND THE POCKET CAN BE WALKED INTO MID-WALK, not only stood in at the start —
        // a slid step lands where it lands, and where it lands can be cut off. Same
        // escape, once per walk: undoing the trail twice would unwind the journey.
        if (!open.found && !escaped) {
          const out = await this.retreatAlongBreadcrumbs({
            movementGeneration, controlToken,
            until: () => geo.path(c.self?.row ?? -1, c.self?.col ?? -1, row, col,
              { blockedEdges }).found,
          });
          if (out.cancelled) return out;
          escaped = Math.max(1, out.steps ?? 0);
          const at = c.self;
          if (out.moved && at) open = geo.path(at.row, at.col, row, col, { blockedEdges });
        }
        if (!open.found)
          return { arrived: false, blocked_at: { col: now.col, row: now.row }, steps: taken,
                   refused_edges: blockedEdges.size, reason: open.reason,
                   ...(escaped ? { retreated: escaped } : {}) };
        queue = open.steps.slice();
        pulled = undefined;      // a new plan needs its own proof
        continue;
      }
      queue = re.steps.slice();
      pulled = undefined;          // a new plan needs its own proof
    }
    // ARRIVED IS A FACT ABOUT THE WORLD, AND `c.self` IS A BELIEF ABOUT IT.
    //
    // This read `c.self` directly, and `predictSelf` writes to `c.self` after every proved leg
    // WITHOUT a read-back — that is the whole point of a proof, and it is the right trade per
    // leg. What it is not is evidence at the end. When a prediction is wrong the belief is
    // wrong, `arrived` is computed from the wrong belief, and the walk reports success for a
    // step the body never made.
    //
    // Measured on the shadow fleet, 2026-08-28, with the keeper held so nothing else could move
    // the character, twice in a row:
    //
    //     walk 47,14 -> 46,15 in room 578
    //     reply  { arrived: true, position: { col: 15, row: 46 }, steps: 1, replans: 0 }
    //     server  47,14, fine 928,3040 — the exact centre of the take-off square
    //
    // That is the operator's "the baked route goes through a wall", seen from the inside: the
    // planner believes the step exists, the mover believes it happened, and the body has not
    // moved. It is why characters sat in the Cragged Mountains at full health with live jobs
    // and NOTHING logged a failure — every leg reported success — and why `baked_rail` rows
    // read OK for crossings that never happened. I spent an hour comparing step predicates
    // because they were measurable; the thing to measure was whether the body moved.
    //
    // ONE READ, AT THE END. The same trade the proved-route path above already makes at
    // `confirmPosition()` — one round trip per walk, not per step. A walk is seconds of work
    // and this is 1.2 to 5.6s at worst on a bad link; reporting a false arrival costs a leg,
    // and silently, which is far more expensive.
    // AND THE FINAL VERDICT, WHICH HAS TO BE THE STRICTEST OF THE THREE. Unconfirmed is
    // not arrived: the whole point of this read is that dead reckoning cannot be trusted to
    // mark its own homework, and `arrived` here is what a journey counts a leg by.
    const okEnd = await this.confirmPosition?.().catch(() => null);
    const me = okEnd ?? c.self ?? await this.selfOrResync?.().catch(() => null) ?? null;
    const arrived = !!okEnd && !!me && me.col === col && me.row === row;
    // MONSTER COLLISION DURING TRAVEL IS NAMED, EVERY TIME, INCLUDING ON SUCCESS.
    //
    // The failure this repairs was not that the walk stopped — it was that the reply
    // said `stopped after 40 steps` and nothing else, so an operator watching a bot
    // shuffle in a corridor had no way to tell a plugged corridor from a wall, and the
    // fault was filed against the geometry it happened to be standing near. A count and
    // the squares are enough to tell them apart at a glance, and reporting it on a
    // SUCCESSFUL walk matters just as much: that is how "this route is fine but it costs
    // us thirty steps whenever the rats are out" becomes visible at all.
    const bodies = monsterBlocks
      ? { monster_blocked: monsterBlocks, blocked_by_bodies_at: [...blockedBy],
          ...(sidestepped.size ? { sidestepped: sidestepped.size } : {}),
          // WHAT IT COST, NOT JUST THAT IT HAPPENED. "11 monster collisions" reads as
          // traffic; "11 monster collisions and 33 health" reads as the thing that killed
          // the character, and only the second tells an operator which rooms are eating
          // the fleet. Absent when nothing was lost, so a quiet block stays quiet.
          ...(damageWhileBlocked ? { damage_while_blocked: damageWhileBlocked } : {}) }
      : {};
    return { arrived, position: me && { col: me.col, row: me.row }, steps: taken, replans,
             ...bodies,
             ...(taken >= maxSteps
                 ? { note: monsterBlocks
                       ? `stopped after ${maxSteps} steps — ${monsterBlocks} monster collision(s) ` +
                         'during travel ate the budget; the route itself was not refused' +
                         (damageWhileBlocked ? `, and it lost ${damageWhileBlocked} health standing there` : '')
                       : 'stopped after ' + maxSteps + ' steps' }
                 : {}) };
  }

  // Leave the room. The tool picks the mechanism, because using the wrong one
  // produces no reply at all:
  //   an edge exit -> walk to the boundary square, then one more step outward
  //   a `go` exit  -> stand on EXACTLY the exit square, then BP_REQ_GO
  // ================== THE RAIL: A BAKED CROSSING, FOLLOWED RATHER THAN REPLANNED ==================
  //
  // WHY THIS EXISTS. Whether a character is "on the coarse grid" or "on the fine grid" it is
  // always walking the fine one — the coarse square is a handle, a short name for a stand
  // point. The trouble is that the PLANNER re-derives its route from wherever the body
  // actually is, and inside terrain the coarse grid cannot express, every move slides. So
  // the walker lands off-plan, replans, produces a route that slides again, and thrashes:
  // measured in the Cragged Mountains, one character aimed at the same grid-solid square
  // sixty-one times in seventy seconds while holding a live order to cross the room.
  //
  // The routes for exactly this were baked long ago and never driven. `bakedPath` returns
  // the square-by-square crossing between two exit anchors — 64 steps for 598's north exit
  // to its south one — and `m59-routes.mjs --verify` already re-walks every one of them.
  // The only caller in the tree was a COMMENT explaining why something else asked a
  // different question. The permission to leave the grid got wired in; the path did not.
  //
  // Three parts, and the middle one is the whole point:
  //
  //   1. GET ON    an ordinary walk to the entry anchor, over ground the grid does express
  //   2. FOLLOW    the baked squares in order, re-aiming at the SAME square when a move
  //                slides, and never replanning — a replan is what loses the line
  //   3. COME OFF  arrive at the far anchor and hand back to ordinary travel
  //
  // It is advisory. Every failure returns null or a reason and the caller walks as it always
  // did, so a room with no baked route, a stale table, or a rail that cannot be joined costs
  // nothing but the attempt.
  railAcross(toSquare) {
    const table = activeRoutes();
    const room = Number(this.world?.room?.num ?? NaN);
    const r = table?.rooms?.[room] ?? table?.rooms?.[String(room)];
    if (!r?.anchors?.length || !toSquare) return null;
    const me = this.client?.self;
    if (!me) return null;
    // A GUTTER HEAD IS A BOARDABLE START, AND FOR A YEAR IT WAS NOT.
    //
    // The bake writes two kinds of line into `routes`: anchor-to-anchor, and one per GUTTER
    // — a place the room drops you into and does not walk you out of. The gutter half was
    // built for exactly the character this function serves, is keyed into `routes` the same
    // way, and `bakedPath` looks a line up BY KEY and never asks whether its start is an
    // exit. Only this candidate list did, and it read `r.anchors` alone. So every gutter
    // rail ever baked — 578's two, and the four the operator DECLARED in
    // substrate/m59-gutters.json after Ukgoth killed seven characters in thirty minutes —
    // was written to disk, verified by `--verify`, and never once offered to anybody.
    //
    // Measured in the Cragged Mountains, which is what sent me here. 217 of its squares
    // need 45+ steps to reach ANY exit; the worst needs 64. The north-east lobe of that
    // pocket (rows 2-18, cols 30-37) contains r10c33, where the operator reports characters
    // piling up, and it had no head at all: the detector's one head for the whole 776-square
    // group went to 20,48, in the EASTERN lobe. From r10c33 the north exit is 21.9 away by
    // crow and 60 steps by mover, and the nearest waypoint of the line that actually leaves
    // — 12,29 on the column-29 leg — is 4.5 by crow and FORTY-ONE steps to walk to, because
    // a cliff runs between them. One column west, r10c32 is nineteen steps from the same
    // exit. That is the whole shape of the trap, and a rail is the mechanism for it.
    //
    // Additive and inert where the bake found none: a room with no `gutters` gets exactly
    // the candidate list it got before. A head is not an exit, so `onBoundary` below leaves
    // interior heads alone and still steps the one boundary gutter (9,50) inland.
    const heads = [...r.anchors.map(a => ({ ...a, gutter: false })),
                   ...(Array.isArray(r.gutters) ? r.gutters : []).map(a => ({ ...a, gutter: true }))];
    // The entry anchor is whichever baked start actually has a line to where we are going.
    // Nearest first, because getting on is an ordinary walk and a shorter one is cheaper.
    const starts = heads
      .filter(a => !(a.row === toSquare.row && a.col === toSquare.col))
      .sort((a, b) => (Math.hypot(a.col - me.col, a.row - me.row))
                    - (Math.hypot(b.col - me.col, b.row - me.row)));
    for (const a of starts) {
      let squares = null;
      try { squares = bakedPath(table, room, { row: a.row, col: a.col }, toSquare); }
      catch { squares = null; }
      if (Array.isArray(squares) && squares.length) {
        // DO NOT GET ON AT A LIVE DOORWAY TO SOMEWHERE ELSE.
        //
        // `railAcross` picks the nearest OTHER anchor as the line's start, and an anchor is
        // by definition a crossing square — standing on it and slipping one square outward
        // leaves the room. Where the boundary carries more than one exit, that is not merely
        // a wasted step, it goes to the WRONG ROOM.
        //
        // The Western border of the Twisted Wood is exactly that shape. Its east edge is
        // split by a row condition, from the map's own data:
        //
        //     east -> 586 (Main gate to the city of Tos)  when row < 19
        //     east -> 597 (The Twisted Wood)              when row > 20
        //
        // The line to 597 is baked from the 586 anchor at 9,67 — on the boundary, row 9,
        // inside the `row < 19` zone. So the walk to GET ON the rail ends with the character
        // standing in the doorway back to Tos, and the transit book fills with "crossed into
        // 586 instead of 597". Measured: every journey paid ~46s reaching 587 and ~11s
        // failing there before rerouting, on a crossing that is perfectly good.
        //
        // The anchor is still the right place to CROSS FROM at the far end; it is the wrong
        // place to STAND at the near end. The line's first square is one step inland, so get
        // on there instead and let the walk approach the boundary only where the line does.
        const geo = this.world?.geometry;
        const onBoundary = (sq) => geo && sq
          && (sq.row === 1 || sq.col === 1
              || sq.row === Number(geo.rows) || sq.col === Number(geo.cols));
        if (onBoundary(a)) {
          let n = 0;
          while (n < squares.length - 1 && onBoundary(squares[n])) n++;
          if (n < squares.length - 1)
            return { from: squares[n], squares: squares.slice(n + 1), steppedOffBoundary: true,
                     gutter: a.gutter === true };
        }
        return { from: a, squares, gutter: a.gutter === true };
      }
    }
    return null;
  }

  /**
   * STEP OFF THE DOORWAY YOU JUST CAME THROUGH.
   *
   * A crossing lands the body ON the far room's boundary — that is what a boundary is — and
   * the very next movement is then one square from leaving again. Where the edge carries
   * more than one exit that is not a wasted step, it is the WRONG ROOM; and where it carries
   * one, it is straight back where we came from.
   *
   * Measured: `587 -> 597 OK` immediately followed by `587 -> 597 FAIL crossed into 586`.
   * The first crossing genuinely succeeded — the check verifies the room number — and then
   * the character drifted west out of 597's arrival anchor at 5,1, which sits on 597's own
   * west boundary, and was back in 587. The same shape as boarding a rail at a live doorway,
   * one room later.
   *
   * One square inland, onto ground the mover already agrees is standable, and only when the
   * body is actually on a boundary. If it fails, nothing is worse than it was.
   */
  async stepInland(margin = INLAND_MARGIN_SQUARES) {
    const geo = this.world?.geometry;
    if (!geo) return false;
    const rows = Number(geo.rows), cols = Number(geo.cols);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return false;
    let moved = false;
    // At most one step per axis per call: this is a nudge off a doorway, not a walk.
    for (let n = 0; n < 2; n++) {
      const me = this.client?.self;
      if (!me) break;
      // How far from each boundary, and which way is inland from the nearest one.
      const dr = me.row <= margin ? 1 : me.row > rows - margin ? -1 : 0;
      const dc = me.col <= margin ? 1 : me.col > cols - margin ? -1 : 0;
      if (!dr && !dc) break;                          // clear of every edge; nothing to do
      const tries = [{ dr, dc }, { dr, dc: 0 }, { dr: 0, dc }].filter(t => t.dr || t.dc);
      let stepped = false;
      for (const t of tries) {
        const r = me.row + t.dr, c = me.col + t.dc;
        if (typeof geo.standable === 'function' && !geo.standable(r, c)) continue;
        if (typeof geo.moverStepLands === 'function' && !geo.moverStepLands(me.row, me.col, r, c)) continue;
        const out = await this.step(c, r).catch(() => null);
        if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(out);
        if (out?.left_room) return moved;             // it went out anyway; nothing to add
        const now = this.client?.self;
        if (now && now.row === r && now.col === c) { stepped = true; moved = true; break; }
      }
      if (!stepped) break;                            // nowhere inland from here; leave it
    }
    return moved;
  }

  /**
   * PUT THE BODY BACK IN THE MIDDLE OF THE SQUARE IT IS ALREADY STANDING ON.
   *
   * THE BAKE TRACES CENTRE TO CENTRE. THE MOVER TRACES FROM WHERE THE BODY ACTUALLY IS.
   * Those are different questions and the gap between them is a wall.
   *
   * Measured in room 586: the body sat on square 47,14 and every westward target from 47,13
   * out to 47,5 was refused `geometry_blocked` — eighteen times for the adjacent one alone.
   * Offline, from the CENTRE of 47,14, `moverStepLands` and `stepAllowedByCollision` both
   * say 47,13 is fine, and both squares are walkable and standable. Nothing was wrong with
   * the line. The body had slid to a fine position inside its own square, hard against a
   * wall, and from there the fine trace west hits that wall immediately.
   *
   * That is the whole of "people get caught on the wall half way through and just stand
   * there": nine consecutive waypoints refused, the rail abandoned, and every instrument
   * reporting a healthy character with somewhere to be.
   *
   * A step of at most half a square, onto ground the mover has already agreed is standable,
   * and it is the body's OWN square so there is no boundary to cross. If it fails, nothing
   * is worse than it was.
   */
  async recentreInSquare() {
    const geo = this.world?.geometry;
    const me = this.client?.self;
    if (!geo || !me || typeof geo.standPointWire !== 'function'
        || typeof this.walkFine !== 'function') return false;
    if (typeof geo.standable === 'function' && !geo.standable(me.row, me.col)) return false;
    // `walkFine` and `client.self` use protocol/wire coordinates. `standPoint` is in
    // client units (16x finer), so passing it here aims almost sideways at a point far
    // outside the room instead of back into this square.
    const pt = geo.standPointWire(me.row, me.col);
    if (!pt) return false;
    const r = await this.walkFine(pt.x, pt.y, { maxSteps: 3, stride: 24 }).catch(() => null);
    return !!(r?.arrived ?? r?.moved);
  }

  /**
   * Walk a baked line square by square. NO REPLANNING — that is the contract.
   *
   * A slide re-aims at the SAME square rather than asking the router where to go from the
   * new position, because the router's answer inside fine-only ground is what produced the
   * thrash this replaces. `maxSlips` bounds how long one square may be insisted on, so a
   * rail that genuinely cannot be walked gives up and lets the ordinary walk try.
   */
  async followRail(squares, { movementGeneration = this.movementGeneration,
                              controlToken = null, maxSlips = 4, maxSkips = 8,
                              avoidSquares = null } = {}) {
    let walked = 0, skipped = 0, skippedInARow = 0, missed = 0;
    // GROUND ALREADY MADE IS NOT GIVEN BACK.
    //
    // A rail is an ordered line, so "how far along are we" is a NUMBER, and the walker never
    // consulted it. Measured in the Cragged Mountains: the body reached waypoint 24 at
    // col 23 row 26, slid back to col 22 row 26 — which is not on the line at all — and then
    // ping-ponged between the two while trolls hit it. Fifty seconds in that room, nine
    // squares of net progress, against a human who crosses it in about five squares a second.
    //
    // The slide itself is ordinary and unavoidable: a step lands where the geometry puts it,
    // not where it was aimed. What turned a slide into a dither is that the next aim was taken
    // from wherever the body ended up, with no memory that it had already been further on. So
    // it walked the same two squares over and over, each attempt perfectly reasonable.
    //
    // `furthest` is the highest waypoint index the body has actually stood on. Aiming never
    // goes behind it, and when the line stops yielding it jumps AHEAD rather than retrying the
    // neighbour — a line that cannot be walked one square at a time from here is frequently
    // rejoinable a few squares on, and every second spent proving otherwise is a second in the
    // room.
    let furthest = -1, sinceProgress = 0;
    const onLine = (at) => {
      if (!at) return -1;
      for (let n = squares.length - 1; n >= 0; n--)
        if (squares[n].row === at.row && squares[n].col === at.col) return n;
      return -1;
    };
    for (let i = 0; i < squares.length; i++) {
      // NEVER AIM BEHIND. If a slide put us further along than the cursor, take the credit;
      // re-walking ground we are already past is the dither itself.
      const standingAt = onLine(this.client?.self);
      if (standingAt > furthest) { furthest = standingAt; sinceProgress = 0; }
      if (furthest >= i) { i = furthest; continue; }
      const target = squares[i];
      // THE RAIL IS WALKED AS BAKED, AND GOING PAST WHAT IS ON IT IS `aimInto`'S JOB.
      //
      // A first attempt at this re-planned any contested waypoint through the threat-aware
      // router and spliced a square-level detour into the line. That was the wrong
      // resolution and it is worth saying why, because it is the mistake CLAUDE.md warns
      // about in capitals: THE FINE GRID IS THE REALITY, A SQUARE IS A SUMMARY. Reasoning in
      // squares says a one-square corridor with a spider in it is closed. It is not — a
      // square is 64 kod units and a body is about 31 across, so two of them pass inside one
      // square with room to spare, which is exactly how a person walks the pinch at cols
      // 44-46 of the Western border of the Twisted Wood.
      //
      // So there is no detour here at all. The line stays the line, and the threading happens
      // one level down, where the aim point inside each square is chosen — see `aimInto` and
      // `bodiesInSquare`.
      let slips = 0, gaveUpOnThisSquare = false, recentred = false;
      for (;;) {
        if (this.movementWasCancelled(movementGeneration, controlToken))
          // NAMED, BECAUSE AN UNNAMED CANCELLATION READS AS A REFUSAL. This is the only
          // exit from the follow loop that carried no `reason`, so the ledger printed
          // "slipped at 16 of 65: undefined" — which looks exactly like the mover rejecting
          // a baked square, and sent me looking for a bad bake. It is the opposite: the
          // squares were fine and something took the body away mid-line.
          return { railed: false, cancelled: true, reason: 'movement_cancelled', at: i, walked,
                   // WHO, not just THAT. The rail dies at the same index every lap and the
                   // ledger could only say "something took the body off the line".
                   cancelled_by: this.lastMovementCancel?.why ?? 'unattributed',
                   cancelled_ms_ago: this.lastMovementCancel
                     ? Date.now() - this.lastMovementCancel.at : null };
        const here = this.client?.self;
        if (here && here.col === target.col && here.row === target.row) break;
        // FINE GROUND IS WALKED FINELY. THIS IS THE WHOLE REASON THE RAIL EXISTS.
        //
        // A rail crosses terrain the coarse grid cannot express — that is what it is for —
        // and `step` aims at a square's stand point as a COARSE move, which is the thing
        // that slides in exactly this ground. Measured: the rail carried a character 24 of
        // 64 squares and gave up at the boundary where the line enters fine-only floor
        // (index 26 onward reads walkable=false the whole way).
        //
        // So where the grid does not admit the square, hand the step to the fine mover and
        // aim at the same stand point in wire units. The square is still the handle; the
        // walk underneath it is the fine one it always really was.
        const geo = this.world?.geometry;
        const fineOnly = geo && typeof geo.walkable === 'function'
          && !geo.walkable(target.row, target.col);
        // `walkFine` consumes protocol/wire coordinates; `standPoint` is client-space.
        // The wrong unit here turns a diagonal fine-only rail into an almost-horizontal
        // aim at a point roughly sixteen times farther away.
        const pt = fineOnly && typeof geo.standPointWire === 'function'
          ? geo.standPointWire(target.row, target.col) : null;
        // A DECLARED FALL-JUMP IS NOT A WALK, AND WALKING IT IS HOW UKGOTH STRANDS PEOPLE.
        //
        // `m59-falljumps.json` says it outright: the mover's one vertical rule gates
        // climbing, so "none of these can be expressed as a step". `step()` has taken
        // `{ fall: true }` since fallTargets landed, and the planner's own waypoints carry a
        // `fall` flag which its walkers honour. The RAIL never did — it reaches every
        // waypoint with `walkFine`, which has no way to be told that this one is a drop.
        //
        // Ukgoth's jump, 36,16 -> 38,10, through the mover's own predicate. Same pair, same
        // slide, only the flag differs:
        //
        //     fall=false  slide=true    ends 38.1,12.3   destinationFloor 3200
        //     fall=true   slide=true    ends 38.1,10.3   destinationFloor 3840
        //
        // 3840 is the shelf the jump is for. 3200 is the floor of the gulley, and the way
        // out of the gulley does not exist: 38,13 -> 38,12 is 640 units of rise against a
        // MAX_STEP_HEIGHT of 384 and traces `geometry_blocked` under every combination of
        // slide and fall. From inside that pocket the strict geometry reaches 681 squares,
        // and neither Castle Victoria nor the Cragged Mountains is among them.
        //
        // Only a DECLARED jump takes this path. That is the whole safeguard: the table is
        // operator-supplied and walked, never derived, so this cannot become a general
        // licence to move through geometry the mover refuses.
        const declaredJumpHere = (here && geo && typeof geo.declaredFallJumps === 'function')
          ? geo.declaredFallJumps(here.row, here.col)
              // declaredFallJumps returns the LANDING as {row, col, dir:'fall', distance},
              // not a nested {to:{...}} — reading it as the latter is a check that silently
              // never fires, which is the failure mode this repository keeps meeting.
              .some(j => j.row === target.row && j.col === target.col)
          : false;
        // A BAKED ROUTE'S OWN DROP IS A FALL TOO, EVEN WHEN NOBODY DECLARED IT.
        //
        // The declared table describes ONE jump in Ukgoth, 36,16 -> 38,10. The baked route
        // the fleet actually rides does not use it: its tail is 34,19 -> 38,15 -> 38,12,
        // and 38,15 is floor 6080 while 38,12 is 3840. That step is a 2240-unit drop, and
        // because it is not in the table `jumpHere` was false, so the rail reached it with
        // `walkFine` — and this file already measured what that does:
        //
        //     fall=false  slide=true   ends 38.1,12.3   destinationFloor 3200   the gulley
        //     fall=true   slide=true   ends 38.1,10.3   destinationFloor 3840   the shelf
        //
        // So the rail was walking off the drop instead of falling down it, landing in the
        // hole every time, and every jump fix in this file applied only to a pair the route
        // never takes. The operator saw it from inside the room before the ledger did: "the
        // jumps I'm watching just don't look like they're trying the right thing".
        //
        // THIS IS NOT A NEW CLAIM ABOUT THE MAP, which is the line the declared table
        // exists to hold. The waypoint pair comes from the route bake, which computed it on
        // the mover's own geometry and stored it; all that is added here is sending it with
        // the flag that matches what it IS. Only downward, only along a baked rail, and only
        // past MAX_STEP_HEIGHT — a step the mover could walk needs no special handling.
        const bakedDropHere = (() => {
          if (declaredJumpHere || !here || !geo || !target) return false;
          try {
            const a = geo.standPoint(here.row, here.col);
            const b = geo.standPoint(target.row, target.col);
            if (!a || !b) return false;
            const fa = geo.floorBaseAtClient(a.x, a.y), fb = geo.floorBaseAtClient(b.x, b.y);
            if (!Number.isFinite(fa) || !Number.isFinite(fb)) return false;
            return (fa - fb) > MAX_STEP_HEIGHT;
          } catch { return false; }
        })();
        const jumpHere = declaredJumpHere || bakedDropHere;
        // AND AIM THE JUMP AT WHICHEVER LANDING IS CLEAREST, NOT ALWAYS THE DECLARED ONE.
        //
        // Measured over 54 attempts in Ukgoth with the fleet running a circuit through the
        // room, so the traffic was real rather than staged:
        //
        //     re-aim by clearance   15/19 = 79%   clear line 81%   BLOCKED line 2/3 = 67%
        //     wait, then jump        5/8  = 63%   clear line 100%  blocked line 0/3
        //     jump blind             9/24 = 38%   clear line 50%   blocked line 0/6
        //
        // Re-aiming is the only response that ever beats a blocker. Waiting and jumping blind
        // both go 0 against one, because the line from the ledge passes directly over the pit
        // and a falling body is clipped by anything in a square it passes THROUGH — every such
        // attempt ends in the gulley on top of whatever stopped it.
        //
        // The candidates are the landings the declared jump's own shelf offers: the declared
        // one and its neighbours ON THE SAME FLOOR, which is what keeps this a variation of a
        // walked jump rather than a new claim about the map. Ties go to the declared landing.
        // QUEUE FOR THE LEDGE RATHER THAN CROWDING IT.
        //
        // A fall-jump take-off is one square, and the approach to it is a ledge one or two
        // squares wide. When several characters want it at once they stand on each other,
        // push each other off, and the ones waiting become the obstacle the jumper is trying
        // to avoid — measured as 'left the ledge before jumping' becoming the commonest
        // outcome, and as a room in which nobody could reach the take-off at all.
        //
        // So a character that finds one of its own already at the ledge does not join it. It
        // falls back to the nearest covered square that is FARTHER from the take-off than
        // whoever is there — a queue by distance, formed without anybody coordinating — and
        // tries again on the next pass. Waiting costs seconds; the pit costs a lap of Ukgoth,
        // which is the arithmetic that makes this worth doing at all.
        // A JUMP AT A WALK IS A FALL INTO THE GULLEY, AND NOTHING WAS CHECKING.
        //
        // `m59-falljumps.json` declares `requires: {running: true}` for this jump, and
        // `traversable()` in m59-falljump.mjs is the function that honours it -- its own
        // docstring says why: "at a walk you do not clear the gap... falling into a gulley
        // is not a cheap mistake". That module was imported by NOBODY. The gate has never
        // run, so a character below the run threshold committed to the jump exactly as one
        // that could run, fell short, and landed in the pit at 3200 where the only ways out
        // are 640 units of rise against a MAX_STEP_HEIGHT of 384.
        //
        // AND THE ANSWER IS TO SIT DOWN, NOT TO GIVE UP. The take-off ledge is above the
        // jump by construction -- reaching it is what makes `jumpHere` true -- so the place
        // to wait is where the character already stands. Resting here costs a minute and
        // saves the character; refusing outright would send the journey round a route that
        // does not exist, and jumping anyway is what has been happening.
        //
        // Bounded, and it gives up rather than sitting on a ledge for ever. Health falling
        // means this is not a safe place to sit after all, and the survival ladder owns that
        // decision -- so this stops and lets the caller replan rather than resting into a
        // death.
        if (jumpHere) {
          const vitalsNow = () => { try { return this.client?.vitals?.() ?? null; } catch { return null; } };
          const vigorNow = () => vitalsNow()?.vigor?.value ?? null;
          const declared = (() => {
            try { return geo.declaredFallJumps(here.row, here.col)
              .find(j => j.row === target.row && j.col === target.col) ?? null; } catch { return null; }
          })();
          const needsRun = declared ? (declaredJumpNeedsRun(this.world?.room?.num, here, target) !== false) : false;
          if (needsRun && Number.isFinite(vigorNow()) && vigorNow() < RUN_VIGOR_FLOOR) {
            const c2 = this.client;
            const startedAt = Date.now();
            const waitMs = Number(process.env.M59_JUMP_REST_MS || 120000);
            const hp0 = vitalsNow()?.health?.value ?? null;
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'jump_rest', trigger: 'vigor_below_run', worked: false, ms: 0,
                           hp_lost: 0, attempted: true,
                           note: `vigor ${vigorNow()} is under the run floor ${RUN_VIGOR_FLOOR}; ` +
                                 `resting on the take-off ledge at ${here.row},${here.col}` });
            await this.pacer.submit('rest', () => c2.rest()).catch(() => null);
            let rested = false;
            while (Date.now() - startedAt < waitMs) {
              if (this.movementWasCancelled(movementGeneration, controlToken)) break;
              await new Promise(r => setTimeout(r, 3000));
              const v = vigorNow();
              if (Number.isFinite(v) && v >= RUN_VIGOR_FLOOR) { rested = true; break; }
              const hp = vitalsNow()?.health?.value ?? null;
              // Being hit while sitting on a ledge is not resting, it is dying slowly.
              if (Number.isFinite(hp) && Number.isFinite(hp0) && hp < hp0) break;
            }
            await this.pacer.submit('move', () => c2.stand()).catch(() => null);
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'jump_rest', trigger: 'vigor_below_run', worked: rested,
                           ms: Date.now() - startedAt, hp_lost: 0, attempted: true,
                           note: rested ? `vigor reached ${vigorNow()}, taking the jump`
                                        : `still ${vigorNow()} after ${Math.round((Date.now() - startedAt) / 1000)}s` });
            if (!rested) {
              // REFUSED, NOT ATTEMPTED. This is the whole point of the gate: the character
              // stays on the ledge it can stand on rather than in the hole it cannot leave.
              return { railed: false, reason: 'jump_needs_run', at: i, walked,
                       note: `this jump needs a run and vigor is ${vigorNow() ?? '?'} ` +
                             `against a floor of ${RUN_VIGOR_FLOOR}; rested on the ledge and it did not recover` };
            }
          }
          const others = (() => { try { return this.world?.objects?.() ?? []; } catch { return []; } })()
            .filter(o => o.is_player && o.id !== this.client?.selfId);
          const atLedge = others.filter(o =>
            Math.max(Math.abs(o.row - here.row), Math.abs(o.col - here.col)) <= 2);
          if (atLedge.length) {
            // Somebody else is on the ledge. Stand off, behind cover if there is any, farther
            // back than they are, and let them go first.
            const backoff = [];
            for (let r = here.row - 6; r <= here.row + 6; r++)
              for (let c = here.col - 6; c <= here.col + 6; c++) {
                if (geo.walkable(r, c) !== true) continue;
                let same = false;
                try {
                  const a = geo.standPoint(here.row, here.col), b = geo.standPoint(r, c);
                  same = a && b && Math.abs(geo.floorBaseAtClient(a.x, a.y) - geo.floorBaseAtClient(b.x, b.y)) <= 64;
                } catch {}
                if (!same) continue;
                const d = Math.max(Math.abs(r - here.row), Math.abs(c - here.col));
                if (d < 3 || d > 6) continue;
                if (others.some(o => o.row === r && o.col === c)) continue;
                let cover = 0;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                  if (!dr && !dc) continue;
                  if (geo.walkable(r + dr, c + dc) !== true) cover++;
                }
                backoff.push({ row: r, col: c, d, cover });
              }
            backoff.sort((a, b) => b.cover - a.cover || a.d - b.d);
            const spot = backoff[0];
            if (spot) {
              await this.walkTo(spot.col, spot.row, { maxSteps: 12 }).catch(() => null);
              return { railed: false, reason: 'queued_for_the_jump', at: i, walked,
                       queued_behind: atLedge.length, waiting_at: `${spot.row},${spot.col}` };
            }
          }
        }

        let jumpTo = target;
        if (jumpHere) {
          const shelf = [];
          for (let dr = -1; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) {
            const cand = { row: target.row + dr, col: target.col + dc };
            if (geo.walkable(cand.row, cand.col) !== true) continue;
            let a = null, b = null;
            try {
              const pa = geo.standPoint(target.row, target.col);
              const pb = geo.standPoint(cand.row, cand.col);
              a = pa && geo.floorBaseAtClient(pa.x, pa.y);
              b = pb && geo.floorBaseAtClient(pb.x, pb.y);
            } catch {}
            if (a == null || b == null || Math.abs(a - b) > 64) continue;
            shelf.push(cand);
          }
          const bodies = (() => { try { return this.world?.objects?.() ?? []; } catch { return []; } })();
          if (shelf.length > 1 && bodies.length) {
            const gapTo = (cand) => Math.min(...bodies.map(o => {
              const vx = cand.col - here.col, vy = cand.row - here.row;
              const wx = o.col - here.col, wy = o.row - here.row;
              const len2 = vx * vx + vy * vy;
              const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
              return Math.hypot(here.col + t * vx - o.col, here.row + t * vy - o.row);
            }));
            // KEEP THE DECLARED LINE WHEN IT IS CLEAR; RE-AIM ONLY WHEN IT IS NOT.
            //
            // Sixty-eight measured jumps, every one of them a real attempt:
            //
            //     declared landing always   31/35 = 89%   clear 29/29 = 100%   blocked 2/6 = 33%
            //     always re-aim             29/33 = 88%   clear 27/30 =  90%   blocked 2/3 = 67%
            //
            // The same overall, and opposite where it matters. The declared landing is the one
            // somebody walked, and on a clear line it does not miss — twenty-nine for
            // twenty-nine. Re-aiming trades a little of that for the only thing that helps
            // when something is standing on the line, where it is twice as good.
            //
            // So there is no reason to choose between them: take the declared line whenever it
            // is clear, and go looking for a better one only when it is not.
            const DECLARED_CLEAR = 1.5;              // squares; below this something is on it
            const declaredGap = gapTo(target);
            if (declaredGap < DECLARED_CLEAR) {
              let best = { cand: target, gap: declaredGap };
              for (const cand of shelf) {
                const gap = gapTo(cand);
                if (gap > best.gap + 0.01) best = { cand, gap };
              }
              jumpTo = best.cand;
            }
          }
        }
        const r = jumpHere
          ? await this.step(jumpTo.col, jumpTo.row, { fall: true })
              .catch(e => ({ moved: false, reason: e.message }))
          : (pt && typeof this.walkFine === 'function')
          ? await this.walkFine(pt.x, pt.y, { maxSteps: 6, stride: 40, avoidSquares })
              .then(w => ({ ...w, moved: w?.arrived ?? w?.moved }))
              .catch(e => ({ moved: false, reason: e.message }))
          : await this.step(target.col, target.row);
          if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
        if (r.left_room) return { railed: true, left_room: true, at: i, walked };
        if (isTerminalMovementReason(r.reason))
          return { railed: false, reason: r.reason, at: i, walked };
        const now = this.client?.self;
        // ON THIS WAYPOINT *OR FURTHER ALONG* IS PROGRESS, AND BOTH END THE RETRY.
        //
        // This asked only "did we land exactly on the square we aimed at", so a step that
        // OVERSHOT — landed further down the same line, which a slide does routinely — read
        // as a miss and the retry re-aimed at a waypoint the body was already past. That is
        // the dither, and it is invisible from inside the loop: every individual aim is
        // correct, and the body walks backwards to collect a square it does not need.
        const landed = onLine(now);
        if (landed >= i) break;
        // SLID. Aim at the same square again rather than re-deriving the route.
        // A WAYPOINT IS NOT THE LINE. Missing one square does not invalidate the other
        // sixty-three, and abandoning the whole rail for it is how a crossing that was
        // three-quarters done went back to the thrash: measured, the follower gave up at
        // index 24 of 64 — on ORDINARY floor — four runs in a row. Skip the square and aim
        // at the next one; the line ahead is still the line. Consecutive skips are bounded,
        // because a rail nothing can be hit on is a rail worth leaving.
        // ONE RE-CENTRE BEFORE GIVING UP ON A SQUARE, AND ONLY FOR A GEOMETRY REFUSAL.
        //
        // `geometry_blocked` from a square the bake calls walkable means the BODY is in the
        // wrong part of its own square, not that the line is wrong — see recentreInSquare.
        // Tried once per waypoint: if standing in the middle does not help, the square is
        // genuinely refused and the skip below is the right answer.
        if (slips === 1 && r.reason === 'geometry_blocked' && !recentred) {
          recentred = true;
          if (await this.recentreInSquare()) continue;
        }
        // A refused step costs no packet and no time; without this the slip loop is a spin.
        if (!r?.moved && !r?.left_room) await new Promise(res => setTimeout(res, 30));
        if (++slips > maxSlips) {
          skipped++; missed++;
          // CONSECUTIVE, WHICH IS WHAT THE PARAGRAPH ABOVE ALWAYS CLAIMED IT WAS.
          //
          // `skipped` was declared once outside this loop and never reset, so it counted
          // every miss on the whole line. On a 65-square rail through the Twisted Wood that
          // is the difference between "this line cannot be walked" and "nine monsters stood
          // on it at some point during a two-minute crossing" — and the second is the
          // ordinary case, not a failure. Measured: room 586's rail died at index 35 of 40
          // seven times running, having walked the first 34 perfectly; every one of those 40
          // squares answers `moverStepLands` TRUE, so the line was never the problem.
          //
          // A rail is worth leaving when it cannot hit ANY of its next several waypoints —
          // that means the body is somewhere the line does not describe. Scattered misses
          // mean something was standing there, and the answer to that is the next square.
          if (++skippedInARow > maxSkips)
            return { railed: false, reason: 'slipped_off_rail', at: i, walked, skipped,
                     note: `${skippedInARow} waypoints missed in a row` };
          gaveUpOnThisSquare = true;
          break;
        }
      }
      if (!gaveUpOnThisSquare) skippedInARow = 0;
      walked++;
      // DID THAT WAYPOINT BUY ANYTHING? Measured on the line rather than on the cursor: the
      // cursor advances whether or not the body did, which is exactly how the dither stayed
      // invisible to every counter here.
      const after = onLine(this.client?.self);
      if (after > furthest) { furthest = after; sinceProgress = 0; }
      else if (++sinceProgress >= RAIL_STALL_WAYPOINTS) {
        // The line is not yielding from here. Jump ahead rather than grinding: a rail that
        // cannot be walked square by square at this point is usually rejoinable further on,
        // and `walkFine` covers the gap. Bounded by the same skip budget, so a rail nothing
        // can be hit on still gives up rather than skimming to the end.
        sinceProgress = 0;
        skipped += RAIL_STALL_JUMP;
        if (++skippedInARow > maxSkips)
          return { railed: false, reason: 'slipped_off_rail', at: i, walked, skipped,
                   note: `no forward progress on the line after ${maxSkips} jumps` };
        i += RAIL_STALL_JUMP;
      }
    }
    // A LINE THE BODY NEVER ADVANCED ON WAS NOT RIDDEN.
    //
    // The stall-jump above moves the CURSOR three waypoints at a time so a rail that cannot
    // be walked from here can be rejoined further on. On a short rail that runs the cursor
    // off the end in four jumps with the body still standing at the boarding square — and
    // this returned `railed: true`. The ledger then read "boarded at 1 of 11, followed 6 of
    // 10, skipped 12 ... ok" forty-six times in room 585 and five times in 578 on the day
    // the 578 line went straight over a ridge and killed everyone who boarded it; the
    // evidence said the rail worked and the wall face said otherwise. `furthest` is the
    // highest waypoint the body actually stood on: index 0 is where it got on, so anything
    // above that is progress and nothing above it is a slip, whatever the cursor did. The
    // caller's behaviour is unchanged either way — the ordinary crossing walk still follows —
    // only the verdict is now the body's rather than the cursor's.
    if (furthest <= 0 && squares.length > 1)
      return { railed: false, reason: 'slipped_off_rail', at: Math.min(furthest + 1, squares.length - 1),
               walked, skipped, missed, note: `the body never stood on a waypoint past the boarding square (cursor skipped ${skipped})` };
    return { railed: true, walked, skipped, missed };
  }

  // UPSTREAM'S leaveVia, TAKEN WHOLE.
  //
  // This method is where upstream did most of its movement work, and its terminal-
  // propagation test pins that control flow exactly. Ours had grown a staging
  // approach, exit-debug logging and a raw-grid fallback on top of the old shape, and
  // the hybrid failed their test in three different places -- each fix revealing the
  // next. Patching a control flow to satisfy a test written for a different control
  // flow is how both end up wrong, so this takes theirs entire.
  //
  // What that gives up, deliberately: the M59_EXIT_DEBUG traces and the distToStaging
  // fine-direct approach (whose `> 0` condition never matched its own comment), and
  // the raw-grid fallback, which was a beeline in a 50-second loop around an await.
  // COORDINATE CONTRACT: exit squares are named `{col,row}`; `fine_stand_on`,
  // `edge_target`, and fine-path points are named `{x,y}` in kod wire units.
  async leaveVia(exit, { movementGeneration = this.movementGeneration, controlToken } = {}) {
    // ROUTE AROUND THE PART OF THIS BOUNDARY THAT LEADS SOMEWHERE ELSE.
    //
    // Computed once, here, because BOTH movers need it and they are used in different
    // branches below. The coarse walker has honoured it since the split-boundary fix; the
    // fine walker is the one that actually reaches a boundary, and it was dragging along the
    // wall into the wrong door — four hundred and thirty refused fine moves creeping east
    // until the server sent the character back to the Main gate to the city of Tos.
    //
    // Guarded because `leaveVia` is lifted out of this file by text and evaluated against a
    // fake world that has no such method.
    const wrongDoor = typeof this.world?.wrongExitSquares === 'function'
      ? this.world.wrongExitSquares(exit) : null;
    const c = this.need();
    if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();

    // RESTING IS A MOVEMENT LOCK, SO CLEAR IT BEFORE THE APPROACH, NOT AT THE DOOR.
    //
    // Player.ResetFlags sets PFLAG_NO_MOVE while seated. The server then refuses every
    // ordinary move on the way to an exit, which means a stand sent immediately before
    // `go` is too late and an edge crossing never reaches its outward packet at all. The
    // same ordering matters for a baked rail: boarding it is movement too. `stand` is safe
    // and deliberately unconditional (see standBeforeGo), and the shared pacer/socket keeps
    // it ordered ahead of every movement branch below.
    await this.standBeforeGo();
    if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();

    // Budget every walk by the ROUTE length, never by a fixed cap. Outdoor rooms here
    // are up to 80x80, so a boundary square can be well over a hundred steps away —
    // and a cap turns a perfectly good exit into a hop that "fails" for no stated
    // reason, which is exactly the silent failure this broker exists to remove.
    // THE BUDGET HAS TO PAY FOR THE WALK, NOT FOR THE PLAN.
    //
    // `steps_away` counts PLANNED squares, and a plan is not what a walk costs here: the
    // mover slides, so the walker lands off its planned square, replans from where it
    // really is, and carries on. Measured offline against the real geometry, an arriving
    // walk costs 0.87-1.04x its plan in the easy rooms and 2.40x in the Badlands, 5.35x in
    // the Western border of the Twisted Wood and 6.58x in the Cragged Mountains — which
    // are precisely the rooms where the fleet dies. `plan + 20` therefore ran out before
    // arrival by construction in the only rooms that needed it, and the walk reported
    // `stopped after 40 steps` about a route that was working.
    //
    // Doubled, with a floor that covers a short approach that goes badly. This is a
    // ceiling on effort, not a promise to spend it: a walk that arrives spends what it
    // needs, and the monster refund and the progress rule above already stop a walk that
    // is going nowhere from reaching this number at all.
    const budget = e => Math.max(60, (e.steps_away ?? 0) * 2 + 20);

    // ---- THE RAIL, TRIED FIRST AND NEVER INSISTED ON. See railAcross / followRail.
    //
    // Only where the ordinary walk is known to struggle: a crossing whose far end is an exit
    // anchor with a baked line to it. Getting ON is an ordinary walk to the entry anchor over
    // ground the coarse grid does express; the crossing itself is then replayed rather than
    // re-planned, which is the difference between arriving and thrashing.
    //
    // Every failure below falls through to exactly the walk this function always did, so a
    // room with no baked route, a stale table, or a rail that cannot be joined costs one
    // attempt and nothing else. `M59_RAIL=0` switches it off for comparison.
    if (process.env.M59_RAIL !== '0' && exit.to != null) {
      // ASKED BY DESTINATION, NOT BY THE SQUARE THIS EXIT HAPPENS TO OFFER.
      //
      // `exit.stand_on` is one crossable square among many on a boundary — 598's west edge
      // alone offers eight. The baked routes are keyed on the ANCHOR, one per declared exit,
      // so looking a rail up by `stand_on` finds nothing and the whole mechanism silently
      // never runs. It did exactly that: zero `baked_rail` rows in the ledger after a full
      // crossing attempt. `anchorFor` is the accessor that cannot express the mistake.
      const railTable = activeRoutes();
      const railRoom = Number(this.world?.room?.num ?? NaN);
      const target = anchorFor(railTable, railRoom, Number(exit.to));
      let rail = target ? this.railAcross({ row: target.row, col: target.col }) : null;
      let railSkipped = false;
      const me0 = this.client?.self;
      // DO NOT RAIL ACROSS A ROOM TO REACH A DOOR THAT IS FOUR SQUARES AWAY.
      //
      // `railAcross` excludes the target anchor from its candidate starts — a line has to
      // begin somewhere else — and then picks the start NEAREST the body. When the body has
      // just arrived beside the door it wants, the nearest remaining anchor is somewhere
      // else entirely, and the rail becomes a tour of the room to reach a square it could
      // have stepped onto.
      //
      // The Western border of the Twisted Wood is the measured case, and it is worse than a
      // detour. A character crossing in from 586 arrives at 41,63 or 44,66 — within a few
      // squares of the 597 door at 46,67. The nearest other anchor is 9,67, which is
      // thirty-five squares north AND IS THE DOORWAY BACK INTO 586. So the walk to get on
      // the rail ends with the character standing on a live exit to the room it just left,
      // and the transit book fills up with
      //
      //   587 -> 597  FAIL  crossed into 586 instead of 597
      //
      // Six of those in one two-character run, against a door it began four squares from.
      //
      // So when the door is already close, there is nothing for a rail to add: the ordinary
      // crossing walk below is a short approach over ground the coarse grid expresses, which
      // is exactly the case it has always been good at. The rail is for crossing a ROOM.
      // HOW FAR IT REALLY IS, WHICH IN THESE ROOMS IS NOT HOW FAR IT LOOKS.
      //
      // Every decision below used `Math.hypot` — the crow line — to judge a walk, in the
      // three rooms whose entire character is that the crow line is a cliff. Measured with
      // the fleet's own step masks:
      //
      //     Ukgoth   13,35 -> the Castle Victoria door   crow 14.4   mover 126
      //     Ukgoth   22,29 -> the same door              crow 21.1   mover 113
      //     535      49,30 -> its east door              crow 28.3   mover  78
      //
      // Up to 8.75x out. So "the door is eight squares away, a rail would be a detour" was
      // being said about a hundred-step climb around a one-way cycle, and the boarding walk
      // was then budgeted for the crow line too and ran out — `could not get on at 49,30
      // (nearest of 13, 6.7 away): stopped after 60 steps`, which is `max(60, 6.7*2+20)`
      // exactly. The rail is the mechanism that crosses this ground and it was being thrown
      // away precisely where it is the only thing that works.
      //
      // `path` is an array index once a step mask is attached, so asking is cheap. Three
      // answers, and they are not the same: a number is the route, `Infinity` is the mover
      // saying there is NO route (never skip the rail for that), and null is a room with no
      // collision model, which must behave exactly as it always did.
      //
      // SWITCHABLE, BECAUSE THE FIRST FLEET-SCALE MEASUREMENT OF IT WENT THE WRONG WAY.
      // `M59_RAIL_MEASURE=crow` restores the old straight-line judgement exactly. The
      // five-inn pilgrimage went 12/21 arrived and 6 dead before this change and 2/21 and
      // 12 dead after it — one run each, and confounded (the second fleet set off battered
      // from the first), which is precisely why the comparison has to be runnable rather
      // than argued. The mechanism to suspect is that both sites here REMOVE A BRAKE: a
      // boarding walk budgeted by a 126-step route will spend 272 packets where it used to
      // give up at 60, and every one of those is a second standing in the room.
      const measure = process.env.M59_RAIL_MEASURE || 'route';
      const routeSteps = (fromRow, fromCol, toRow, toCol) => {
        if (measure === 'crow') return null;            // null == no opinion == the crow line
        const g = this.world?.geometry;
        if (!g || typeof g.path !== 'function') return null;
        try {
          const p = g.path(fromRow, fromCol, toRow, toCol, { collision: true });
          if (!p) return null;
          return p.found ? (p.steps?.length ?? p.path?.length ?? null) : Infinity;
        } catch { return null; }
      };
      if (rail && me0 && target) {
        const crow = Math.hypot(target.col - me0.col, target.row - me0.row);
        const route = routeSteps(me0.row, me0.col, target.row, target.col);
        const away = route ?? crow;
        if (away <= RAIL_SKIP_WITHIN_SQUARES) {
          // A DECISION, NOT A FAILED ATTEMPT — and the ledger has to be able to tell them
          // apart. `worked:false` here counted as "the rail was tried and it did not work",
          // and Ukgoth therefore read as an 84% rail failure with seventy-one of the rows
          // saying the door was already 0 squares away. That is the walk going RIGHT, and
          // an operator reading the ledger to pick what to fix was being sent at it.
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                         tactic: 'baked_rail', trigger: 'exit_crossing',
                         worked: false, attempted: false, ms: 0, hp_lost: 0,
                         // BOTH NUMBERS, ALWAYS. The whole defect was a skip decided on the
                         // crow line, and a ledger that prints one distance cannot show that
                         // it happened. `route` is what decided; `crow` is what used to.
                         note: `no rail needed — the door at ${target.row},${target.col} is ` +
                               `${Math.round(away)} step(s) away ` +
                               `(route ${route ?? 'unknown'}, crow ${crow.toFixed(1)}) ` +
                               `and the line starts at ${rail.from.row},${rail.from.col}` });
          rail = null;
          railSkipped = true;
        } else {
          // AND NEVER WALK FURTHER TO GET ON A LINE THAN TO REACH THE DOOR ITSELF.
          //
          // The candidate starts are ranked by the CROW line (see `railAcross`), in rooms
          // whose entire character is that the crow line is a cliff — the same mistake this
          // block was written to fix for the skip decision, still uncorrected one function
          // away. Adding gutter heads makes it bite: a head is deliberately placed in the
          // worst-served pocket of a room, so it is close to the squares nobody can leave
          // AND close, as the crow flies, to squares on the other side of the wall that are
          // a few steps from the exit.
          //
          // Measured in the Cragged Mountains for the new head at 8,33: of the 29 cheap
          // squares that would rank it their nearest start, r6c24 is 9.2 away by crow and
          // FORTY-SIX steps to walk to, while its own door is thirteen. Boarding there is an
          // eightfold detour to reach a line whose whole purpose is to be quicker.
          //
          // So: compare the two walks that are actually on offer. If getting ON costs more
          // than getting THERE, the rail cannot pay for itself whatever it does afterwards,
          // and this declines it — leaving exactly the ordinary walk that runs today.
          // Twenty-four of those 29 squares are cut by this and every square the gutter was
          // added for is kept, because in a gutter the head is a handful of steps away and
          // the door is fifty: r10c33 boards at 2 against a door 60 away.
          //
          // NOT A COMPARISON OF TOTAL LENGTH. `board + ride` against `route` would decline
          // the corner too — 2 + 63 against 60 — and be wrong, because a rail is not bought
          // for being shorter. It is bought because the ordinary walk SLIDES and replans and
          // does not arrive, which is the premise this whole mechanism rests on.
          const board = rail.from ? routeSteps(me0.row, me0.col, rail.from.row, rail.from.col) : null;
          if (board != null && Number.isFinite(route) && board > route) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: false, attempted: false, ms: 0, hp_lost: 0,
                           note: `rail declined — getting on at ${rail.from.row},${rail.from.col} is ` +
                                 `${board === Infinity ? 'unreachable' : `${board} step(s)`} away and the door at ` +
                                 `${target.row},${target.col} is only ${route}` });
            rail = null;
            railSkipped = true;
          }
        }
      }
      // LOGGED EVEN WHEN NOTHING HAPPENS. The first two attempts at this wrote a ledger row
      // only after the character had got onto the rail, so a run that found no rail at all
      // and a run where `leaveVia` was never reached produced the same evidence — nothing —
      // and there was no way to tell which. The decision is the thing worth recording.
      // ONCE, NOT TWICE. The skip above sets `rail = null`, which then fell into this block
      // and wrote a SECOND row for the same moment — so one deliberate skip appeared in the
      // ledger as two rail failures. That is why 'no rail needed ... 1,66' and 'no baked
      // line to the anchor 1,66' have nearly the same count: they are largely the same
      // events, counted again.
      if (!rail && !railSkipped) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                       tactic: 'baked_rail', trigger: 'exit_crossing',
                       worked: false, attempted: false, ms: 0, hp_lost: 0,
                       note: target ? `no baked line to the anchor ${target.row},${target.col}`
                                    : `no anchor for room ${exit.to}` });
      }
      if (rail && me0) {
        // JOIN THE LINE WHERE WE ARE STANDING, NOT WHERE IT STARTS.
        //
        // A crossing gets interrupted — that is the ordinary condition of travel here, and
        // the survival ladder is SUPPOSED to interrupt it. `travelShelterBelow` returns 1
        // (any damage at all) in a zone that outranks the character, which the Twisted Wood
        // does for every character this fleet has, so a scratch takes a wall and the journey
        // resumes a moment later. That is all correct.
        //
        // What was not correct is where it resumed. Getting on always walked back to the
        // ENTRY ANCHOR, so six squares of progress were thrown away every time and the body
        // re-walked the same six. Measured: thirty-two laps of the first six squares of a
        // sixty-five square rail in room 587, six refusals in two hundred and thirty
        // attempts. Nothing was blocked; it was being sent back to the start.
        //
        // If the body is already on or beside a square of this line, that square is where
        // the line is joined. Beside as well as on, because a shelter detour ends a step or
        // two off the road and walking back to the anchor to recover one square is the
        // behaviour this replaces.
        // NEAREST, NOT FURTHEST. A body beside the first two points of a diagonal line is
        // closer to the first; scanning backwards chose the second and then skipped it,
        // turning a one-square join into a two-row jump. Room 578 repeated that jump for
        // eighteen minutes at the foot of its cliff.
        let joinAt = -1, joinDistance = Infinity, exactlyOnJoin = false;
        for (let n = 0; n < rail.squares.length; n++) {
          const sq = rail.squares[n];
          const dr = Math.abs(sq.row - me0.row), dc = Math.abs(sq.col - me0.col);
          if (dr > 1 || dc > 1) continue;
          const distance = Math.hypot(dr, dc);
          if (distance < joinDistance || (distance === joinDistance && n > joinAt)) {
            joinAt = n;
            joinDistance = distance;
            exactlyOnJoin = distance === 0;
          }
        }
        const rejoinAttempted = joinAt >= 0;
        if (rejoinAttempted) {
          // Standing ON a waypoint has already earned it; standing BESIDE one has not. In
          // the latter case it must be the first target, or rejoin skips the very move that
          // puts the body onto the proved line.
          const ahead = rail.squares.slice(joinAt + (exactlyOnJoin ? 1 : 0));
          if (ahead.length) {
            const ran = await this.followRail(ahead, { movementGeneration, controlToken,
                                     avoidSquares: wrongDoor?.size ? wrongDoor : null })
              .catch(e => ({ railed: false, reason: e.message }));
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: !!ran?.railed, ms: 0, hp_lost: 0,
                           note: `rejoined at ${joinAt} of ${rail.squares.length} — ` +
                                 (ran?.railed ? `followed ${ran.walked} of ${ahead.length} remaining`
                                              : `${ran?.cancelled ? 'cancelled' : 'slipped'} at ${ran?.at}` +
                                                (ran?.cancelled_by ? ` by ${ran.cancelled_by}` : '')) });
            if (ran?.left_room)
              return { left: true, via: 'rail', rail: { steps: ran.walked, rejoined: joinAt } };
          }
        }
        // A failed rejoin leaves the body at a newer, real position. Do not use stale
        // pre-rail `me0` to walk back to the entrance and replay the same failed line in
        // this call; the ordinary exit walk below continues from where the body really is.
        if (!rejoinAttempted) {
          // BOARD AT THE NEAREST POINT OF THE LINE, NOT AT ITS BEGINNING.
          //
          // The join above only looks one square out, so a body that is genuinely off the
          // road â€” thrown there by a flee, or walked there by the ordinary exit walk after
          // an earlier rail failure â€” falls through to here and is sent to `rail.from`,
          // which is the ENTRY ANCHOR and therefore about the furthest point of the line
          // from anywhere else in the room.
          //
          // In Ukgoth that is fatal rather than merely wasteful. Measured 2026-08-24 over
          // three characters: 342 moves in the room, 301 of them refused, and 244 of the
          // refusals on 50,23 / 50,24 / 50,25. Those are ordinary walkable squares â€” but
          // their step masks are E, SE, S, SW, W and NOTHING ELSE. There is no northward
          // move from any of them; they are cliff top. The entry anchor is at row 1, so the
          // walk to it asks for north, the room has no north to give, and the body grinds
          // against the cliff until `no_ground_gained` fires or a troll finishes it. The
          // same walk is what `no_ground_gained` was refusing at 3,61 and 5,65.
          //
          // Ukgoth is a CYCLE â€” which is why its fall-jumps had to be declared at all â€” and
          // "walk back to the start" is not a move a cycle supports. So board at the
          // nearest square of the line and follow from there. It may be behind us or ahead
          // of us; both are ground the bake proved, and either is nearer than the anchor.
          // NEAREST IS NOT THE SAME AS REACHABLE, AND IN THIS ROOM IT IS USUALLY NOT.
          //
          // Picking the closest square by straight line asks the crow. Ukgoth is a cycle
          // with one-way cliffs — forward and reverse reachability differ by hundreds of
          // squares — so the nearest point of the line is regularly on the far side of a
          // drop, and `walkTo` cannot get there from here at any price. Nothing noticed,
          // because the next call recomputed the SAME nearest square and tried again.
          // Eleven minutes of it, one character, on one crossing:
          //
          //   17:11:30  could not get on at 38,15 (nearest of 38, 15.6 away)
          //   17:12:39  could not get on at 38,15 (nearest of 38, 15.6 away)
          //   17:13:49  could not get on at 38,15 (nearest of 38, 16.4 away)
          //   ... unchanged until 17:22:15 ...
          //
          // The distance alternating between two values and never falling IS the dithering
          // an operator sees from inside the room: a character shuffling between two
          // squares, fifteen away from a line it will never reach, while a troll eats it.
          //
          // So candidates are tried nearest-first and each is ASKED whether it can be
          // walked to before it is committed to. Bounded, because this runs on the keeper's
          // clock: the ten nearest are enough when the line has 38 squares, and a room that
          // answers "no" ten times has told us what we needed to know.
          //
          // AND A SQUARE THAT FAILED IS NOT OFFERED AGAIN. Reachability says whether a path
          // exists; it does not say whether the walk survives contact with whatever is
          // standing on it. Remembering the failures is what turns a loop into a search —
          // per room, and cleared when the room changes, because this is a fact about one
          // crossing rather than about the map.
          const boardKey = Number(this.world?.room?.num ?? 0);
          if (this._railBoardFailed?.room !== boardKey)
            this._railBoardFailed = { room: boardKey, squares: new Set() };
          const tried = this._railBoardFailed.squares;
          const geoNow = this.world?.geometry;
          // AND KEEP WHAT THE PROBE ALREADY WORKED OUT. This asks the mover for a PATH and
          // then threw everything but its boolean away, so the budget below was taken from
          // the crow line — which is how boarding a square "6.7 away" died `stopped after 60
          // steps` against a 78-step route. The length is free here and it is exactly the
          // number the walk is about to be judged by.
          //
          // Three answers again, and the middle one is the one that matters: a number is the
          // route, `false` is the mover saying there is no way there at all, and null is a
          // room with no collision model — which keeps the old "no opinion: carry on".
          let boardRoute = null;
          const walkCost = (sq) => {
            if (!geoNow || typeof geoNow.path !== 'function') return null;  // no opinion: carry on
            try {
              const p = geoNow.path(me0.row, me0.col, sq.row, sq.col);
              if (!p?.found) return false;
              // Under `M59_RAIL_MEASURE=crow` the reachability answer is still used — it is
              // what stops a body being sent at a square across a one-way drop — but the
              // LENGTH is withheld, so the budget below falls back to the crow line exactly
              // as it did before. That is what makes the A/B a clean one-variable change.
              return measure === 'crow' ? null : (p.steps?.length ?? p.path?.length ?? null);
            } catch { return null; }
          };
          const ranked = rail.squares
            .map((sq, n) => ({ sq, n, d: Math.hypot(sq.row - me0.row, sq.col - me0.col) }))
            .sort((a, b) => a.d - b.d);
          let boardAt = -1, boardDistance = Infinity, probed = 0;
          for (const cand of ranked) {
            if (tried.has(`${cand.sq.row},${cand.sq.col}`)) continue;
            if (probed++ >= 10) break;
            const cost = walkCost(cand.sq);
            if (cost === false) continue;               // the mover says there is no way there
            boardAt = cand.n; boardDistance = cand.d; boardRoute = cost; break;
          }
          // Everything near is unreachable or already failed. Fall back to the old answer
          // rather than refusing the crossing — the ordinary exit walk below is still there,
          // and one more honest attempt beats a silent skip.
          if (boardAt < 0) {
            const first = ranked.find(c => !tried.has(`${c.sq.row},${c.sq.col}`)) ?? ranked[0];
            boardAt = first.n; boardDistance = first.d;
          }
          const board = rail.squares[boardAt] ?? rail.from;
          const onIt = me0.col === board.col && me0.row === board.row;
          // 1. GET ON â€” skipped when we are already standing on the boarding square.
          // BUDGETED BY THE ROUTE THE MOVER WILL WALK, not by the line the crow would fly.
          const boardCrow = Math.hypot(board.col - me0.col, board.row - me0.row);
          const boardAway = Number.isFinite(boardRoute) ? boardRoute : boardCrow;
          const got = onIt ? { arrived: true } : await this.walkTo(board.col, board.row,
            { maxSteps: budget({ steps_away: boardAway }) })
            .catch(e => ({ arrived: false, reason: e.message }));
          if (!got?.arrived) {
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing', worked: false, ms: 0, hp_lost: 0,
                           // A NET, SO NO BOARDING FAILURE CAN BE SILENT AGAIN. `walkTo`
                           // returns down several paths and not all of them carry a
                           // `reason`; 64 of 183 failures in Ukgoth were recorded as `?`
                           // and were indistinguishable from each other. Whatever is
                           // present gets written â€” where it stopped, how far it got,
                           // whether it left the room â€” because a third of the evidence
                           // arriving as one character is how this stayed unexplained.
                           note: `could not get on at ${board.row},${board.col}` +
                                 ` (nearest of ${rail.squares.length}, ${boardDistance.toFixed(1)} away,` +
                                 ` route ${boardRoute ?? 'unknown'}, budget ${budget({ steps_away: boardAway })}): ` +
                                 (got?.reason
                                  ?? (got?.left_room ? 'left the room while walking to the rail'
                                      : got?.note ? String(got.note).slice(0, 60)
                                      : `no reason given (steps ${got?.steps ?? 0}` +
                                        `${got?.blocked_at ? `, blocked at ${got.blocked_at.row},${got.blocked_at.col}` : ''}` +
                                        `${got?.replans != null ? `, replans ${got.replans}` : ''})`)) });
            // Do not offer this square again for this room. See the note above the ranking.
            this._railBoardFailed.squares.add(`${board.row},${board.col}`);
          }
          if (got?.arrived) {
            // 2. FOLLOW â€” from where we joined, not from the anchor.
            const ahead = rail.squares.slice(boardAt);
            const ran = await this.followRail(ahead, { movementGeneration, controlToken,
                                        avoidSquares: wrongDoor?.size ? wrongDoor : null })
              .catch(e => ({ railed: false, reason: e.message }));
            if (ran?.left_room) return { left: true, via: 'rail', rail: { steps: ran.walked, boarded: boardAt } };
            // 3. COME OFF â€” at the far anchor, so the ordinary crossing below is a step, not
            //    a room-crossing. A rail that slipped leaves the body somewhere real and the
            //    walk below simply carries on from there.
            recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: Number(this.world?.room?.num ?? 0),
                           tactic: 'baked_rail', trigger: 'exit_crossing',
                           worked: !!ran?.railed, ms: 0, hp_lost: 0,
                           note: ran?.railed ? `boarded at ${boardAt} of ${rail.squares.length}, followed ${ran.walked} of ${ahead.length}, skipped ${ran.skipped ?? 0}`
                                             : ran?.cancelled
                                               ? `cancelled at ${ran?.at} of ${ahead.length} by ` +
                                                 `${ran?.cancelled_by} (${ran?.cancelled_ms_ago}ms ago)`
                                               : `slipped at ${ran?.at} of ${ahead.length}: ${ran?.reason ?? 'unknown'}` });
          }
        }
      }
    }

    if (exit.kind === 'go') {
      // CLEARANCE ON, because this is the long routing: crossing a whole room to a
      // boundary square is exactly where hugging the wall makes a step slide, the mover
      // land off plan, and the walker start the bounce. See walkTo's `clearance`.
      let walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                   { maxSteps: budget(exit), movementGeneration, controlToken,
                                     clearance: LEAVE_VIA_CLEARANCE });
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };

      // COARSE "UNREACHABLE" IS NOT THE SAME AS IMPOSSIBLE.
      //
      // The movement grid is one byte per square; the world underneath it is BSP
      // geometry at 64 fine units to the square. Anything narrower than a square —
      // a ledge, a gap between pillars, the diagonal slot through a crypt — exists
      // in the geometry and simply cannot be represented in the grid, so the
      // pathfinder reports no route to somewhere you can plainly walk.
      //
      // Six characters sat in the Marion crypt for half an hour because of this.
      // The grid said the way back was unreachable; stepping there in fine units
      // worked first time. So when coarse pathing fails, try fine before believing
      // it — the cost is one more attempt and the alternative is a permanent trap.
      if (!walk.arrived) {
        // walkFine works in fine units, not squares — the centre of a square is
        // col*64 + 32. Passing square coordinates walks to the top-left corner of
        // the map instead, which looks like a wildly broken pathfinder.
        const half = KOD_FINENESS >> 1;
        // THE FINE WALK GETS THE SAME AVOID SET AS THE COARSE ONE. It is the mover that
        // actually reaches a boundary, and it was dragging along the wall into the wrong door.
        const fine = await this.walkFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half,
                                         { maxSteps: budget(exit), movementGeneration, controlToken,
                                           avoidSquares: wrongDoor?.size ? wrongDoor : null }).catch(() => null);
        if (isTerminalMovementReason(fine?.reason))
          return { left: false, stage: 'walk', ...fine };
        if (fine?.arrived) walk = { ...fine, via: 'fine movement after coarse pathing failed' };
      }
      let leaned = false;

      // A DOORWAY IS USUALLY NOT WALKABLE IN THE ROOM'S OWN GRID.
      //
      // The square Room.SomethingTryGo matches on is frequently drawn as wall, and
      // the direction bits of the square beside it do not open onto it — so the
      // pathfinder correctly reports "no route" to a square that is nonetheless
      // the only way out. The Royal Bank of Jasper is the clean example: its exit
      // sits at (9,6) in a column the grid seals off completely, and an agent that
      // trusts the route planner is simply stuck in the bank forever.
      //
      // The server does not require you to STAND on it. Movement is in fine units
      // — 64 to the square — and the real client clips a requested point to the
      // closest legal position. Do that collision pass locally, which can slide us
      // hard up against the doorway without ever sending an endpoint through it.
      if (!walk.arrived) {
        let spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
        // WHERE WE ARE STANDING CAN BE THE WHOLE PROBLEM.
        //
        // approachSquare answers from the square we occupy, and some squares simply have
        // no path to the doorway even though the room does. Cibilo Creek Inn is the case:
        // a character at (2,3) has every direction in can_step except the one the exit is
        // in, and both walk_to and go_through fail on it — while a character at (5,5) in
        // the same room walks out on the first try. Four characters sat in two taverns on
        // squares like that, reporting the room unleavable, and it was only ever the spot.
        //
        // So before giving up, step somewhere else and ask again. Anywhere reachable will
        // do; the middle of the room is the likeliest to see the door.
        if (!spot) {
          const rows = this.world?.room?.size?.rows ?? 0, cols = this.world?.room?.size?.cols ?? 0;
          for (const [c2, r2] of [[Math.floor(cols / 2), Math.floor(rows / 2)],
                                  [Math.floor(cols / 3), Math.floor(rows / 2)],
                                  [Math.floor(cols / 2), Math.floor(rows / 3)]]) {
            if (!(c2 > 0 && r2 > 0)) continue;
            // KEEP OFF THE WALLS HERE TOO. This is a CROSSING — a third of the way across
            // the room, to a point nobody chose tactically — which is precisely the case
            // `clearance` is for, and it was the one long walk in `leaveVia` that did not
            // ask for it. It runs only after the direct walk to the exit has already
            // failed, so it is the route a character takes WHILE it is milling: planning
            // it flat threads the recovery along the same walls that caused the failure.
            const step = await this.walkTo(c2, r2, { maxSteps: 30, movementGeneration, controlToken,
                                                     clearance: LEAVE_VIA_CLEARANCE })
                                   .catch(() => ({ arrived: false }));
            if (isTerminalMovementReason(step.reason))
              return { left: false, stage: 'walk', ...step };
            if (!step.arrived) continue;
            spot = this.world.approachSquare(exit.stand_on.col, exit.stand_on.row);
            if (spot) break;
          }
        }
        if (!spot) return { left: false, stage: 'walk', ...walk,
                            note: 'no path to the doorway from here, and moving elsewhere in the ' +
                                  'room did not find one either' };
        if (spot.steps > 0) {
          // Same again: the SQUARE was chosen tactically, the WALK to it is a crossing.
          // `clearance` prices the route and exempts the destination, so asking for it
          // here keeps the approach off the walls without shying away from the doorway
          // itself — which is the distinction the whole setting turns on.
          const near = await this.walkTo(spot.col, spot.row,
                                         { maxSteps: Math.max(40, spot.steps + 20), movementGeneration, controlToken,
                                           clearance: LEAVE_VIA_CLEARANCE });
          if (!near.arrived) return { left: false, stage: 'walk', ...near };
        }
        if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
      }

      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      // Where the server thinks we are, before asking it to let us out. If prediction
      // drifted, lean again from the position we are ACTUALLY on — the first lean was
      // aimed from a square we may never have reached.
      let at = await this.confirmPosition();
      if (!at) {
        this.finePositionUnknown = true;
        return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                 note: 'the server position could not be confirmed, so no doorway correction or go was sent' };
      }
      if (at && (Math.abs(at.col - exit.stand_on.col) > 1 || Math.abs(at.row - exit.stand_on.row) > 1)) {
        const half = KOD_FINENESS >> 1;
        const lean = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                         exit.stand_on.row * KOD_FINENESS + half);
        if (isTerminalMovementReason(lean.reason))
          return { left: false, stage: 'walk', reason: lean.reason, note: lean.note };
        leaned = true;
        at = await this.confirmPosition();
        if (!at) {
          this.finePositionUnknown = true;
          return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                   note: 'the corrected doorway position could not be confirmed, so go was not sent' };
        }
      }

      // THE LAST SQUARE IS THE ONE THE GRID CANNOT SEE, AND IT IS THE ONLY ONE THAT
      // COUNTS. `UserGo` passes the server's own piRow/piCol and `SomethingTryGo`
      // (room.kod:2777) matches them against plExits with `=`. Not a radius, not a
      // facing cone — that exact square or nothing.
      //
      // And the way IN is not the way OUT. Measured in the Brownestone Inn with the
      // operator standing in it: the door from North Barloque delivers you to (12,16),
      // the door back out is at (12,17), and row 17 is walkable floor that the coarse
      // grid marks unreachable from every square touching it. So a character walks in,
      // lands one square short of the way home, and the router refuses to try before
      // sending a single packet. Camilla sat there failing 29 crossings in five minutes.
      //
      // Fine movement can cross its legal low step even though the square grid cannot
      // represent it, because it checks the fine BSP instead. So when the
      // square-based approach has left us anywhere but the exit square, fall through to
      // it rather than issuing a `go` that cannot possibly be accepted.
      // AN UNKNOWN POSITION IS NOT A CORRECT ONE. `at` is null when the confirming read
      // timed out, and both corrections below were guarded on `at` being truthy — so a
      // failed read skipped them BOTH and sent `go` blind, then reported the result as
      // "stood on the exit square and nothing happened", which is a claim we had no
      // evidence for. Treat unknown like wrong: request the square in fine units and
      // let the local collision pass cross or clip it before anything is sent.
      if (at.col !== exit.stand_on.col || at.row !== exit.stand_on.row) {
        const half = KOD_FINENESS >> 1;
        const correction = await this.stepFine(exit.stand_on.col * KOD_FINENESS + half,
                                                exit.stand_on.row * KOD_FINENESS + half)
                                     .catch(error => ({ moved: false, reason: error.message }));
        if (isTerminalMovementReason(correction.reason))
          return { left: false, stage: 'walk', reason: correction.reason, note: correction.note };
        const corrected = correction.position;
        if (!corrected || corrected.col !== exit.stand_on.col || corrected.row !== exit.stand_on.row)
          return { left: false, stage: 'walk', reason: correction.reason ?? 'geometry_blocked',
                   note: correction.note ?? 'local collision could not place the character on the exact exit square' };
        leaned = true;
      }
      // Wait for the ROOM CHANGE specifically. A door announces itself first —
      // "You open the door and walk through." arrives as a message a beat before
      // BP_PLAYER reports the new room — and waitFor returns on the first match of
      // ANY listed kind. Listening for 'message' too therefore returned the
      // announcement of success and called it a failure, every single time.
      const go = await boundedSilentGo({
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        send: () => this.pacer.submit('move', () => c.go(), DOOR_SETTLE_MS),
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
      });
      if (go.cancelled)
        return this.cancelledMovement({ go_attempts: go.attempts });
      const entered = go.entered, messages = go.messages, goAttempts = go.attempts;
      return { left: !!entered, arrived_in: entered ? entered.roomName : null,
               go_attempts: goAttempts,
               ...(leaned && entered
                   ? { note: 'the exit square is not walkable in this room\'s grid, so this ' +
                             'leaned into the doorway from the square beside it' } : {}),
               ...(entered ? {} : {
                 reason: messages.length ? messages.join('; ')
                       : leaned ? `leaned into (${exit.stand_on.col},${exit.stand_on.row}) from beside ` +
                                  `it and the server did not open a door there after ${goAttempts} attempts`
                       : `sent go ${goAttempts} time${goAttempts === 1 ? '' : 's'} and the server ` +
                         'answered nothing at all — no room change and no refusal' }),
               messages };
    }

    if (exit.kind === 'edge') {
      // Graph hops carry the abstract edge; the live world attaches an exact
      // BSP-validated inside point, the minimum out-of-bounds target, and (when
      // needed) a short fine route from a coarse staging square.
      if (!exit.fine_stand_on || !exit.edge_target) {
        const enriched = this.world.exits().find(candidate => candidate.kind === 'edge'
          && candidate.to === exit.to && candidate.direction === exit.direction);
        if (enriched) exit = { ...exit, ...enriched };
      }
      if (!exit.stand_on || !exit.fine_stand_on || !exit.edge_target)
        return { left: false, stage: 'walk',
                 reason: `no BSP-valid crossing on the ${exit.direction} boundary` };
      const edgeStartRoom = c.room.id;
      // No reachable boundary square, says the square grid — the same verdict it
      // gives for a cliff ledge, and wrong for the same reason. Pick the nearest
      // floor square actually on that boundary and walk to it with fine BSP collision.
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: LEAVE_VIA_CLEARANCE,
                                       avoidSquares: wrongDoor?.size ? wrongDoor : null });
      if (walk.left_room || c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed while approaching the boundary' };
      if (isTerminalMovementReason(walk.reason))
        return { left: false, stage: 'walk', ...walk };
      // ARRIVING ON *A* CROSSING SQUARE IS ARRIVING. THE EXACT ONE DOES NOT MATTER.
      //
      // This used to demand the walk finish on the one anchor `exits()` picked, and give
      // up otherwise — without ever attempting the crossing. That produced the dance an
      // operator watched and described exactly: a character walks to one opening, does
      // not cross, walks all the way across the room to the other opening, does not
      // cross, and comes back. `travel` re-plans after each refusal and picks a different
      // candidate, so the two openings alternate for ever.
      //
      // It is also unnecessary, and `exits()` says so twenty lines away: "the boundary is
      // one exit and any square on it crosses". Measured on the west wall of Main gate to
      // the city of Tos, which has two separate openings at rows 20-23 and 43-48: a
      // character teleported onto 20,1 and onto 47,1 crossed in ZERO seconds from both.
      // The crossing was never the problem — landing on one exact square was.
      //
      // So when the walk ends somewhere else, look for where we ACTUALLY are among this
      // boundary's crossing squares and use that one's own fine target. Only if we are on
      // none of them is the walk a failure.
      if (!walk.arrived) {
        const me = c.self;
        const crossings = [{ col: exit.stand_on.col, row: exit.stand_on.row,
                             fine_stand_on: exit.fine_stand_on, edge_target: exit.edge_target,
                             fine_path: exit.fine_path },
                           ...(exit.alternates ?? [])];
        const here = me && crossings.find(a => a.col === me.col && a.row === me.row
                                            && a.fine_stand_on && a.edge_target);
        if (!here) return { left: false, stage: 'walk', ...walk };
        exit = { ...exit, stand_on: { col: here.col, row: here.row },
                 fine_stand_on: here.fine_stand_on, edge_target: here.edge_target,
                 fine_path: here.fine_path,
                 crossed_from_alternate: true };
      }
      // THE OPENING THE BODY IS STANDING IN, NOT THE ONE THE PLAN NAMED.
      //
      // `atEdgeOpening` permits one square of drift ALONG the boundary, measured from the
      // single opening `exits()` ranked first — and a boundary publishes many. Ukgoth's
      // north edge offers x=1736 and x=1773 inside column 27 alone, and which one is
      // chosen is decided by a one-step difference in the approach walk. Measured from the
      // valley, the ranking picks 1736, which sits EIGHT fine units from the solid rock of
      // square 26 and therefore admits a body only from square 27 exactly:
      //
      //     standing on 1,27  x=1760   |1760-1736| =  24   within one square
      //     standing on 1,28  x=1824   |1824-1736| =  88   REFUSED
      //
      // So a character that climbs the whole cliff and arrives on 1,28 — on the boundary
      // row, in the doorway, one column east of the anchor — is told `not_at_edge_opening`
      // and the outward packet is never sent at all. `leaveViaAny` then walks it across the
      // room to the next candidate and the lap repeats: the exit-gap ledger reads 182
      // refusals and ZERO crossings on this boundary, while a body teleported onto 1,27
      // crosses in three seconds.
      //
      // The plan-time choice is a guess about where the body will end up, and the body has
      // now stopped somewhere. So re-ask: of the crossings this boundary publishes for THIS
      // exit, which is nearest along the edge to where we are actually standing. The
      // `edge_target` moves with it, because the outward packet has to leave from the
      // opening we are in rather than aim diagonally across a wall at another one.
      //
      // This can only ever reduce the distance the gate measures — a strictly-nearer test,
      // and no change at all when the ranked opening already is the nearest. `wrongDoor` is
      // the same set the approach walk avoids, so a split boundary cannot be re-anchored
      // onto a crossing that fires the other room.
      const reanchorToNearestOpening = () => {
        const me = c.self;
        if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.y)) return;
        let published = null;
        try { published = this.world?.geometry?.edgeApproachCandidates?.(exit.direction) ?? null; }
        catch { published = null; }
        if (!Array.isArray(published) || !published.length) return;
        const horizontal = exit.direction === 'north' || exit.direction === 'south';
        const along = pt => (horizontal ? pt.x : pt.y);
        let best = null, bestGap = Math.abs(along(exit.fine_stand_on) - along(me));
        for (const cand of published) {
          if (!cand?.fine_stand_on || !cand?.edge_target) continue;
          const row = Math.floor(cand.fine_stand_on.y / KOD_FINENESS);
          const col = Math.floor(cand.fine_stand_on.x / KOD_FINENESS);
          if (wrongDoor?.has?.(`${row},${col}`)) continue;      // fires the other exit
          const gap = Math.abs(along(cand.fine_stand_on) - along(me));
          if (gap < bestGap) { bestGap = gap; best = cand; }
        }
        if (!best) return;
        exit = { ...exit, fine_stand_on: best.fine_stand_on, edge_target: best.edge_target,
                 fine_path: [best.fine_stand_on], reanchored_to_nearest_opening: true };
      };
      reanchorToNearestOpening();

      const finePath = exit.fine_path?.length ? exit.fine_path : [exit.fine_stand_on];
      // ALREADY IN THE DOORWAY SQUARE? THEN DO NOT WIGGLE AT ALL — STEP OUT.
      //
      // The note below already argues the precision is not load-bearing: the crossing is
      // triggered by the OUTWARD step, not by where you stood, and two characters teleported
      // onto different openings crossed in zero seconds from both. If that is true — and it
      // is — then a character that has ALREADY been walked into the exit square has nothing
      // left to gain here, and something real to lose.
      //
      // What it loses is the character. Ukgoth's Castle Victoria doorway sits on a finger of
      // cliff top three squares wide at row 1 and narrowing to two by row 4, with a drop on
      // every other side. `walkFine` fans NINE headings and slides, and the floors on that
      // finger differ by exactly 384 in places — MAX_STEP_HEIGHT — so each slid step down is
      // individually legal while the sequence of them walks off the edge. The operator
      // watched a production character make the jump, cross the whole room, reach the door,
      // wiggle, and put itself off the cliff.
      //
      // AND A CHARACTER ONE SQUARE SHORT WALKS FORWARD, IT DOES NOT FAN.
      //
      // The operator's account of how these exits work is the whole design note: "the player
      // knows just keep going forward into the narrowing spur, because that's how these
      // exits work". A boundary crossing is a WALK OFF THE EDGE, so the move that gets you
      // there is a step in the direction of the edge — not a nine-heading search for a point
      // inside the doorway square.
      //
      // So the skip widens by a square, and it widens by STEPPING rather than by ignoring
      // the gap. `step` is the mover's own square primitive: one validated move, no fan, no
      // slide-until-something-sticks. If it lands us in the opening the nudge has nothing
      // left to do; if it does not, the fine path is still there and behaves exactly as it
      // did. What is removed is the case that killed characters — being one square off a
      // two-wide spur and searching for the doorway by feel.
      // AND THE DOORWAY IS THE CROSSING SQUARE, NEVER THE STAGING SQUARE.
      //
      // `stand_on` is where the room can be WALKED TO; `fine_stand_on` is where the boundary
      // can be CROSSED, and on a boundary approached from inland they are different squares.
      // Ukgoth's north exit stages on row 2 and crosses on row 1 — so arriving at `stand_on`
      // set `atDoor`, which skips the fine nudge below, which was the only thing left that
      // would have moved the body onto the crossing row. The gate then measured the body
      // against an opening one row in front of it and refused, having spent the entire
      // approach getting there. Every mechanism agreed the walk had succeeded and no packet
      // was ever sent.
      //
      // So both the test and the step aim at the square the crossing is actually in. That
      // also makes the step-in do what its own note says it should — "keep going forward
      // into the narrowing spur" is a step toward the EDGE, and the staging square is the
      // one place on the approach that is not toward the edge.
      const doorSquare = {
        col: Math.floor(exit.fine_stand_on.x / KOD_FINENESS),
        row: Math.floor(exit.fine_stand_on.y / KOD_FINENESS),
      };
      let atDoor = (() => {
        const me = c.self;
        return !!(me && me.col === doorSquare.col && me.row === doorSquare.row);
      })();
      if (!atDoor) {
        const me = c.self;
        const away = me ? Math.max(Math.abs(me.row - doorSquare.row),
                                   Math.abs(me.col - doorSquare.col)) : Infinity;
        if (away <= EDGE_STEP_IN_WITHIN) {
          for (let n = 0; n < EDGE_STEP_IN_WITHIN && !atDoor; n++) {
            const r = await this.step(doorSquare.col, doorSquare.row,
                                      { movementGeneration, controlToken })
              .catch(() => null);
            if (typeof this._yieldIfPacketless === 'function') await this._yieldIfPacketless(r);
            if (r?.left_room || c.room.id !== edgeStartRoom)
              return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                       note: 'stepped straight out of the room while closing on the opening' };
            const now = c.self;
            atDoor = !!(now && now.col === doorSquare.col && now.row === doorSquare.row);
            if (!r?.moved) break;                 // refused: let the fine path try instead
          }
        }
      }
      for (const point of (atDoor ? [] : finePath)) {
        // A SHORT NUDGE, NOT A SEARCH — AND THIS IS THE WIGGLE AT THE DOOR.
        //
        // `arriveWithin: 1` asks to land within ONE fine unit, a 64th of a square, and
        // `walkFine` pursues that by fanning nine headings and re-stepping until its
        // budget runs out. On a boundary square that budget was the whole ROUTE length —
        // forty-plus packets — so a character that was already standing at the opening
        // spent half a minute shuffling a few units back and forth in front of the exit
        // before the outward step it actually needed. Watched from the client that is
        // exactly what it looks like: stopping in front of the door and wiggling.
        //
        // The precision was never load-bearing, and the comment below already says so:
        // the crossing is triggered by the OUTWARD step, not by where you stood, and two
        // characters teleported onto different openings crossed in zero seconds from
        // both. Nor can loosening it change WHICH exit fires — an edge condition is on
        // the row/col, and every point here is inside the same square we already walked
        // to, so this only moves us within that one square.
        //
        // So: land near the opening if a few steps get us there, and otherwise press. A
        // miss still falls through to the edge step exactly as before, which is the half
        // that does the work.
        const fine = await this.walkFine(point.x, point.y, {
          maxSteps: EDGE_NUDGE_MAX_STEPS, stride: 32, arriveWithin: EDGE_NUDGE_WITHIN,
          movementGeneration, controlToken,
          // The nudge stays inside the square we already walked to, so this can only ever
          // refuse a fine point that is already over the wrong door.
          avoidSquares: wrongDoor?.size ? wrongDoor : null,
        });
        if (fine.left_room || c.room.id !== edgeStartRoom)
          return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                   note: 'crossed the boundary while fine-positioning at its opening' };
        if (isTerminalMovementReason(fine.reason))
          return { left: false, stage: 'walk', ...fine };
        // NOT ARRIVING EXACTLY IS NOT YET A REASON TO GIVE UP.
        //
        // `arriveWithin: 1` above asks to land within ONE fine unit — a 64th of a square
        // — and returning here when it does not is the machinery refusing to press into
        // the wall. The operator's rule, and it is simply how the game works: for every
        // exit that is not a door or a portal, leaving ALWAYS requires one more step
        // toward the edge, and that edge is an invisible wall you run into. There is no
        // version of it where precision at the opening matters, because the thing that
        // triggers `Room.StandardLeaveDir` is the outward step, not where you stood.
        //
        // Proved by teleport: a character placed on 20,1 and on 47,1 of Main gate to the
        // city of Tos — different openings, neither the blessed anchor — both crossed in
        // ZERO seconds. What has been failing is never the crossing; it is everything
        // this function does before allowing itself to attempt one.
        //
        // A fine-positioning miss falls through to the boundary-position gate below. The
        // server does not validate player geometry, so the outward packet cannot be used
        // as the test: sent from inside the room it can cross the intervening wall.
        if (!fine.arrived) break;
      }
      // Dead reckoning is appropriate across a room and insufficient at the one packet the
      // server will accept without any geometry check. Refresh the server's position before
      // authorizing the edge; the paced callback below still re-proves whatever live position
      // exists at the exact instant of send.
      const confirmedEdge = await this.confirmPosition().catch(() => null);
      if (c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed while confirming the edge position' };
      if (!confirmedEdge) {
        this.finePositionUnknown = true;
        return { left: false, stage: 'walk', reason: 'position_confirmation_timeout',
                 note: 'the edge position could not be confirmed, so no outward packet was sent' };
      }
      // AND ASK ONE LAST TIME WHICH OPENING WE ARE IN, now that the position is the
      // server's rather than dead reckoning. The step-in and the nudge both move the body,
      // and `confirmPosition` is the first moment this function knows where it really is —
      // which is exactly the moment to decide which opening it is standing in. Re-anchoring
      // is strictly-nearer, so this can only shrink the distance the gate is about to
      // measure; where the ranked opening was already the nearest it changes nothing.
      reanchorToNearestOpening();

      // THE OUTWARD PACKET IS AUTHORIZED ONLY FROM THE PROVED OPENING.
      //
      // `offMap` selects the separately-authorized boundary branch; it does not bypass
      // collision. A bot in room 536 failed every fine nudge toward the north opening,
      // remained on row 2 at (1125,178), and was nevertheless allowed to send the target
      // (1120,63). The server accepted it and moved the bot to room 535 through geometry
      // the client had just refused. The server is not a collision oracle, so the queue
      // rechecks this proximity and replays the exact packet through BSP at send time.
      //
      // Permit the ordinary sub-square wiggle along an opening, but require the body to
      // be on its boundary row/column and within one fine square of this exact candidate.
      // Along-edge coarse squares may legitimately differ at a square boundary, so do not
      // require both coarse coordinates to equal the candidate's.
      const opening = exit.fine_stand_on;
      const meAtEdge = c.self;
      if (!atEdgeOpening(meAtEdge, opening, exit.direction))
        return { left: false, stage: 'walk', reason: 'not_at_edge_opening',
                 note: 'the outward edge packet was refused because the character did not reach ' +
                       'the BSP-proved boundary opening' };
      // One more step OUTWARD, past the grid. Nothing else triggers
      // Room.StandardLeaveDir. `offMap` keeps this transition out of the in-room breadcrumb
      // chain while the queue still requires the baked outside coordinate to validate.
      if (this.movementWasCancelled(movementGeneration, controlToken)) return this.cancelledMovement();
      const edgeMove = await this.queueValidatedMove(
        exit.edge_target.x, exit.edge_target.y,
        // Stock UserMovePlayer sends speed zero for the one StandardLeaveDir
        // out-of-room request; it is not a run/vigor-bearing in-room step.
        { speed: 0, slide: false, minGap: MOVE_INTERVAL_MS,
          expectedRoomId: edgeStartRoom,
          offMap: { opening: exit.fine_stand_on, direction: exit.direction } });
      if (!edgeMove.sent && c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed before the final edge packet was needed' };
      if (!edgeMove.sent) return {
        left: false, stage: 'edge',
        crossing_packet_sent: false,
        reason: edgeMove.validation?.reason ?? 'geometry_blocked',
        note: edgeMove.validation?.note ??
          'the outward edge packet could not be sent at all — not a collision refusal',
      };
      const tGo = Date.now();
      // THE CROSSING IS SLOW WHEN THE SERVER IS BUSY, AND IT STILL WORKS.
      //
      // The operator's description of playing this by hand: you stop dead against the
      // invisible wall, and a beat later it jumps you to the next map. So a late
      // `room-entered` is the ORDINARY case under load, not a failure — and at 4s we
      // were giving up on crossings that were still in flight and recording them as
      // "stepping past the edge did nothing", which is the one reading that makes a
      // working exit look like a phantom.
      const ev = await c.waitFor({ since: edgeMove.eventSeq, kinds: ['room-entered'],
                                   timeoutMs: EDGE_CROSSING_WAIT_MS });
      Pacer.note('go', 'blocked', Date.now() - tGo);
      let entered = ev.events.find(e => e.kind === 'room-entered');
      // ASK THE WORLD, NOT ONLY THE EVENT RING. The event can be missed — evicted, or
      // arriving on a rejoined client — while the character is demonstrably somewhere
      // else. Having crossed is a fact about where we are standing.
      //
      // AND ASK IT MORE THAN ONCE, BECAUSE THE ALTERNATIVE IS ANOTHER WALK ACROSS THE ROOM.
      //
      // A single look the instant the event wait expires makes the whole crossing a race
      // against one deadline: land at 10.5s and it reads as "stepping past the edge did
      // nothing", `leaveViaAny` moves to the next square, and confirming that costs a full
      // crossing of the room — which in The King's Way is a minute and a half. The exit-gap
      // record says plainly that this is what has been happening: the dominant row is a
      // delta of (0,0) with 72 sightings across rooms 150, 586, 574, 587 and 382. The model
      // named the RIGHT square, the character was standing on it, and the crossing was
      // recorded as refused anyway — 342 times on 587's west boundary alone.
      //
      // So the confirmation is a short poll rather than a single glance. It costs at most a
      // couple of seconds on a genuinely dead edge and saves a room crossing on every late
      // one, and the two are not close.
      if (!entered && c.room.id === edgeStartRoom) {
        const until = Date.now() + EDGE_CONFIRM_MS;
        while (Date.now() < until && c.room.id === edgeStartRoom) {
          if (this.movementWasCancelled(movementGeneration, controlToken))
            return this.cancelledMovement();
          await new Promise(r => setTimeout(r, 400));
        }
      }
      if (!entered && c.room.id !== edgeStartRoom)
        return { left: true, arrived_in: c.rsc.get(c.roomNameRsc),
                 note: 'the room changed but no room-entered event was seen' };
      if (!entered) {
        // If this was an edge we INFERRED rather than one the room declared, the
        // inference was simply wrong — drop it so neither the planner nor anything
        // else keeps routing through a boundary that does not exist.
        if (exit.inferred && this.world?.room?.num != null && exit.to != null) {
          forgetInferredExit(this.world.room.num, exit.to);
          return { left: false, stage: 'edge', crossing_packet_sent: true,
                   reason: 'stepping past the edge did nothing',
                   note: 'this exit was inferred from the other room declaring an edge into here, and the ' +
                         'server refused it — the inference is now dropped and routes will avoid it' };
        }
        return { left: false, stage: 'edge', crossing_packet_sent: true,
                 reason: 'stepping past the edge did nothing',
                 note: 'that boundary may have no plEdge_Exits entry, or a condition on it excludes where we crossed' };
      }
      return { left: true, arrived_in: entered.roomName };
    }

    // A region exit needs nothing but arriving on the square: the room's own
    // SomethingMoved fires as we land and moves us across. So walk, then confirm by
    // the room having changed rather than by any reply, because there is not one.
    if (exit.kind === 'region') {
      const candidates = Array.isArray(exit.trigger_targets) && exit.trigger_targets.length
        ? exit.trigger_targets
        : exit.stand_on ? [{ stand_on: exit.stand_on, steps_away: exit.steps_away,
                             reachable: exit.reachable, approach_on: exit.approach_on }] : [];
      if (!candidates.length)
        return { left: false, reason: 'no walkable square or reachable approach for the trigger region',
                 note: 'the region is ' + exit.trigger + ' — it may really be walled off from here' };

      const result = await boundedRegionEntry({
        candidates,
        sequence: () => c.evSeq,
        eventsSince: since => c.eventsSince(since),
        cancelled: () => this.movementWasCancelled(movementGeneration, controlToken),
        walk: candidate => this.walkTo(candidate.stand_on.col, candidate.stand_on.row,
          { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: LEAVE_VIA_CLEARANCE }),
        fineWalk: async candidate => {
          // Get as close as the square graph knows how before bypassing it. Fine movement
          // is deliberately expensive — every step is confirmed by a room read — and from
          // across an outdoor map it is both slow and needlessly risky. The staging square
          // makes this a short locally validated crossing of the disputed geometry.
          const target = candidate.stand_on;
          const knownApproach = candidate.approach_on;
          const computedApproach = this.world.approachSquare(target.col, target.row);
          const approach = knownApproach ?? (computedApproach && {
            col: computedApproach.col, row: computedApproach.row,
          });
          let staged = null;
          if (approach) {
            staged = await this.walkTo(approach.col, approach.row,
              { maxSteps: budget(candidate), movementGeneration, controlToken, clearance: LEAVE_VIA_CLEARANCE });
            if (staged.left_room || (!staged.arrived &&
                !(c.self && c.self.col === approach.col && c.self.row === approach.row)))
              return { arrived: false, ...(staged.left_room ? { left_room: true } : {}),
                       reason: staged.reason ?? 'could not reach the square beside the trigger', staged };
          }
          const half = KOD_FINENESS >> 1;
          const fine = await this.walkFine(target.col * KOD_FINENESS + half,
                                           target.row * KOD_FINENESS + half,
                                           { maxSteps: 40, movementGeneration, controlToken })
                                 .catch(error => ({ arrived: false, reason: error.message }));
          return { ...fine, ...(staged ? { staged } : {}) };
        },
        waitForEntry: async since => {
          const started = Date.now();
          const observed = await c.waitFor({ since, kinds: ['room-entered'], timeoutMs: 4000 });
          Pacer.note('go', 'blocked', Date.now() - started);
          return observed.events.find(event => event.kind === 'room-entered') ?? null;
        },
        // A genuine region fires merely by arriving. Asking to go is retained as one
        // bounded compatibility probe for map entries that are really doors in disguise.
        askGo: async () => {
          await this.pacer.submit('move', () => c.go(), DOOR_SETTLE_MS);
        },
      });
      if (result.cancelled) return this.cancelledMovement({ tried: result.tried.length });
      if (result.terminal)
        return { left: false, stage: 'walk', ...result.terminal,
                 tried: result.tried.length };
      if (result.unconfirmed_transition)
        return { left: false, reason: 'left the source room but could not confirm the destination',
                 tried: result.tried.length,
                 note: 'movement stopped immediately rather than issuing a blind request in the new room' };
      if (result.entered) {
        const successful = result.tried[result.tried.length - 1] ?? {};
        return { left: true, arrived_in: result.entered.roomName,
                 via: successful.asked_go ? 'region trigger, after asking to go'
                      : successful.fine ? 'region trigger via fine movement' : 'region trigger',
                 trigger_target: successful.candidate?.stand_on ?? null };
      }

      const tried = result.tried.map(attempt => ({
        stand_on: attempt.candidate.stand_on,
        approach_on: attempt.candidate.approach_on ?? null,
        coarse: attempt.coarse?.reason ?? (attempt.coarse?.arrived ? 'arrived' : null),
        fine: attempt.fine?.reason ?? (attempt.fine?.arrived ? 'arrived' : null),
        asked_go: !!attempt.asked_go,
      }));
      const reached = result.tried.some(attempt => attempt.coarse?.arrived || attempt.fine?.arrived);
      return { left: false,
               reason: reached
                 ? 'reached the trigger region but neither automatic entry nor `go` changed rooms'
                 : `could not reach any of ${candidates.length} bounded trigger-region target(s)`,
               tried, note: 'the trigger is ' + exit.trigger };
    }

    // THE SQUARE WE ACTUALLY STOOD ON. Recorded on `this` rather than written anywhere,
    // because this method is lifted out of this file by text and evaluated by
    // m59-collision-test — it may touch nothing but `this`, its injected dependencies and
    // built-ins. A non-lifted caller flushes it; see flushExitGaps.
    this.lastExitStand = c.self ? { col: c.self.col, row: c.self.row } : null;

    if (exit.kind === 'portal') {
      // Nothing to send: Portal.SomethingMoved fires on arrival at its square and
      // teleports whatever is standing there. So walking IS the action.
      const before = c.evSeq;
      const portalStartRoom = c.room.id;
      const walk = await this.walkTo(exit.stand_on.col, exit.stand_on.row,
                                     { maxSteps: budget(exit), movementGeneration, controlToken,
                                       clearance: LEAVE_VIA_CLEARANCE });
      if (isTerminalMovementReason(walk.reason) && c.room.id === portalStartRoom)
        return { left: false, stage: 'walk', ...walk };
      const tGo = Date.now();
      const ev = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 4000 });
      Pacer.note('go', 'blocked', Date.now() - tGo);
      const entered = ev.events.find(e => e.kind === 'room-entered');
      if (!entered)
        return { left: false, stage: walk.arrived ? 'stood on it' : 'walk', ...walk,
                 reason: walk.arrived ? 'standing on it did nothing — it may not be a portal after all' : undefined };
      return { left: true, arrived_in: entered.roomName, via: 'portal' };
    }

    return { left: false, reason: 'cannot leave through a ' + exit.kind };
  }

  /**
   * THE LAST RESORT AT A DOORWAY THE MODEL CANNOT DESCRIBE — bounded, counted, and only
   * ever reached once the ordinary path has spent its bounded candidate budget.
   *
   * #18 made the harness enforce collision the way the stock client does, which was right:
   * the server accepts whatever coordinates you send, so nothing else was enforcing it and
   * bots crossed walls. But the approach model is incomplete at some doorways, and a
   * doorway the model cannot describe became a doorway nothing could use — ten of
   * twenty-one characters could not reach a bank, which is the same blockage that starves
   * the whole fleet of reagents.
   *
   * So where the model has refused every square the bounded budget attempted, take the one step it would
   * not, onto a square IT ITSELF published as crossing that boundary. That is far narrower
   * than "movement without validation": the target is the model's own answer, and every
   * step up to it was fully validated.
   *
   * Recorded every time, with the square the model believed in beside the square that
   * actually worked — a bypass nobody measures is a bypass that becomes permanent.
   * This deliberately relaxes collision and is OFF by default. `M59_EXIT_FALLBACK=1`
   * enables it explicitly for diagnosing a known model gap; normal travel fails closed.
   */
  async leaveViaUnvalidated(exit, { movementGeneration = this.movementGeneration } = {}) {
    const c = this.need();
    const target = exit?.stand_on;
    if (!target || !Number.isInteger(target.col) || !Number.isInteger(target.row))
      return { left: false, reason: 'no square to fall back to' };
    if (this.movementWasCancelled(movementGeneration)) return this.cancelledMovement({});
    const before = c.evSeq, startRoom = c.room.id;
    const half = KOD_FINENESS >> 1;
    const x = target.col * KOD_FINENESS + half, y = target.row * KOD_FINENESS + half;
    if (!Number.isInteger(x) || x < 0 || x > 0xffff ||
        !Number.isInteger(y) || y < 0 || y > 0xffff)
      return { left: false, reason: 'fallback target is off the wire grid' };
    this.exitFallbacks = (this.exitFallbacks || 0) + 1;
    // AN EDGE IS LEFT BY STEPPING PAST IT, NOT ONTO IT — and this fallback stepped onto
    // it. `Room.SomethingMoved` only reaches StandardLeaveDir when the new row or col is
    // OUT of the room (room.kod:2232-2258), so moving to the boundary square is an
    // ordinary in-room step and can never cross. For a region exit arriving is the whole
    // trigger, which is why this went unnoticed: the fallback worked for the kind of exit
    // that needs no outward step, and silently could not work for the kind that does.
    //
    // Measured before this: 587 -> 576 reported "every square for that exit refused"
    // even though the outward step had been fixed, because every square WAS refused and
    // then the fallback took the one step that cannot cross either.
    // AND IT MUST ALREADY BE AT THE OPENING. This is the dangerous half, and without the
    // guard the fix above is worse than the bug it repairs.
    //
    // The server does no geometry check on a player move, so an unvalidated packet aimed
    // off the map from ANYWHERE in the room would cross — straight through whatever
    // stands between here and the boundary. Meridian has one-way overland links that are
    // one-way precisely because of terrain near the seam: 589 -> 599 -> 598 is walkable
    // westward and not eastward, because eastward you would have to climb the cliffs you
    // drop off going the other way. The boundary openings are wide (30 and 40 squares);
    // it is the APPROACH that is impossible, and this fallback firing from mid-room would
    // step straight over it and call a one-way link two-way.
    //
    // That is the same failure the breadcrumb note below warns about — relaxing collision
    // exactly where the two views disagree is what let bots climb cliffs no client can.
    // So: only when we are already standing within a square of the published opening,
    // which means the approach succeeded and the only thing left is the step the model
    // will not take.
    const outward = exit?.edge_target;
    const opening = exit?.fine_stand_on;
    const near = Number.isFinite(c.self?.x) && Number.isFinite(opening?.x)
      && Math.abs(c.self.x - opening.x) <= KOD_FINENESS
      && Math.abs(c.self.y - opening.y) <= KOD_FINENESS;
    const useOutward = exit?.kind === 'edge' && outward
      && Number.isFinite(outward.x) && Number.isFinite(outward.y) && near;
    if (exit?.kind === 'edge' && !useOutward)
      return { left: false, reason: 'not at the opening',
               note: 'the unvalidated outward step is only taken from the boundary itself — ' +
                     'firing it from mid-room would cross terrain the approach could not' };
    const fallbackTo = useOutward
      ? { x: Math.round(outward.x), y: Math.round(outward.y) }
      : { x, y };
    const fallbackSpeed = useOutward ? 0 : 18;
    const wireFrom = c.self ? { x: c.self.x, y: c.self.y } : null;
    try {
      c.moveTo(fallbackTo.x, fallbackTo.y, fallbackSpeed, startRoom);
      this.recordUnsafeWireMove?.({
        client: c,
        roomId: startRoom,
        from: wireFrom,
        requested: fallbackTo,
        to: fallbackTo,
        speed: fallbackSpeed,
        offMap: useOutward,
        unsafeReason: 'exit_unvalidated_fallback',
      });
    } catch (e) { return { left: false, reason: e.message }; }
    const ev = await c.waitFor({ since: before, kinds: ['room-entered'],
                                 timeoutMs: EDGE_CROSSING_WAIT_MS })
                      .catch(() => ({ events: [] }));
    const entered = ev.events?.find(e => e.kind === 'room-entered');
    if (entered) return { left: true, arrived_in: entered.roomName, via: 'exit-fallback',
                          stood_on: { col: target.col, row: target.row } };
    // The room is the authority on having left, not the event — see the same argument
    // at the end of leaveVia.
    if (c.room.id !== startRoom)
      return { left: true, arrived_in: c.rsc.get(c.roomNameRsc), via: 'exit-fallback',
               stood_on: { col: target.col, row: target.row },
               note: 'the room changed but no room-entered event was seen' };
    return { left: false, reason: 'the unvalidated step did not change rooms either' };
  }

  // One doorway is often published as several squares, and they are NOT
  // interchangeable: in the Royal Bank of Jasper (9,7) has a brazier standing on
  // it and refuses, while (9,6) one square north opens. Which is which is not in
  // the protocol, so the only honest thing is to try them in a sensible order and
  // report what each said.
  /**
   * Ride a learned track across this room, or say why not.
   *
   * THE MONORAIL. A track is the quickest crossing anybody has actually made of this room
   * between these two doors, straightened against the baked BSP — so it is made of accepted
   * moves and cannot contain a step the mover refuses, which is the failure mode of planning
   * on square stand points a body never occupies.
   *
   * IT BOARDS COARSELY AND RIDES FINELY. The stations are the waypoints the SQUARE router
   * can reach; the tight ones between them are exactly what the coarse grid cannot deliver
   * you to, which is the same fact that makes them safe walls. So getting on is an ordinary
   * walk and only the ride is fine.
   *
   * NULL-ISH IS "PLAN IT THE WAY YOU ALWAYS DID". Every refusal here returns `rode: false`
   * and moves nothing that matters, because a book with one observation per key must never
   * be able to make travel worse than not having it.
   */
  async rideTrack(fromRoom, toRoom, { movementGeneration = this.movementGeneration, controlToken } = {}) {
    const c = this.need();
    const here = Number(this.world?.room?.num ?? NaN);
    if (!Number.isFinite(here) || !Number.isFinite(Number(toRoom))) return { rode: false, why: 'no room' };
    const track = recallTrack(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
    if (!track?.waypoints?.length) return { rode: false, why: 'no track' };
    // AN UNPROVEN STITCH IS TRIED ONCE, WITH THE WALKED ROUTE STILL UNDERNEATH IT.
    //
    // `waypoints` may be a route sewn from several walks: every leg raycast-proved, and the
    // whole thing never ridden. `walked` is the real crossing it was built to beat. Ride the
    // stitch — that is how it becomes proven — but if it does not get us out of the room,
    // fall back to the route something has actually walked rather than reporting the
    // crossing shut.
    const sewn = track.proven === false && Array.isArray(track.walked) && track.walked.length >= 2
      ? track.walked : null;
    const geo = this.world?.geometry ?? null;
    const me0 = c.self;
    if (!me0) return { rode: false, why: 'own position unknown' };
    const JOIN_WITHIN = Number(process.env.M59_TRACK_JOIN_WITHIN || 640);
    let joinAt = -1, joinDist = Infinity;
    for (let i = 0; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      const row = Math.floor(wp.y / KOD_FINENESS) + 1, col = Math.floor(wp.x / KOD_FINENESS) + 1;
      if (geo && typeof geo.walkable === 'function' && !geo.walkable(row, col)) continue;
      const d = Math.hypot(wp.x - me0.x, wp.y - me0.y);
      if (d < joinDist) { joinDist = d; joinAt = i; }
    }
    if (joinAt < 0) return { rode: false, why: 'no station reachable on the coarse grid' };
    if (joinDist > JOIN_WITHIN) return { rode: false, why: 'not on this track', off_by: Math.round(joinDist) };
    const started = Date.now();
    if (joinDist > KOD_FINENESS) {
      const wp = track.waypoints[joinAt];
      const board = await this.walkTo(Math.floor(wp.x / KOD_FINENESS) + 1,
                                      Math.floor(wp.y / KOD_FINENESS) + 1,
                                      { maxSteps: 60, movementGeneration, controlToken }).catch(() => null);
      if (board?.left_room) return { rode: true, left_room: true, boarded: false, ms: Date.now() - started };
      if (!board?.arrived) return { rode: false, why: 'could not reach the station', off_by: Math.round(joinDist) };
    }
    // MONORAIL HEALING STEPS.
    //
    // The tight squares that make these crossings awkward are the same squares a monster
    // cannot reach — that IS a safe wall, measured — so a track already runs past the best
    // shelter in the room, and `shelter` names which of its stations those are. A traveller
    // hurt on the way does not need to reach a town; it needs the next station with a wall
    // at its back, and it is standing on the route to one.
    //
    // Doctrine says a planned trip completes AS FAST AS POSSIBLE WHILE BEING ATTACKED and
    // does not stop to fight — this does not break that. It is not a fight and it is not a
    // detour: the shelter is a waypoint the journey was going to walk over anyway, and
    // resting on it is strictly cheaper than arriving dead. It only fires BELOW the rest
    // threshold, only on a station the track already contains, and it is bounded.
    const shelter = new Set(track.shelter ?? []);
    const restBelow = Number(process.env.M59_TRACK_REST_BELOW || 0.5);
    const restMs = Number(process.env.M59_TRACK_REST_MS || 20000);
    let rested = 0;
    let reached = 0, blocked = 0, bodiesInTheWay = 0;
    for (let i = joinAt; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      if (this.movementWasCancelled(movementGeneration, controlToken)) break;
      // RIDE A LEG THE WAY IT WAS PROVED.
      //
      // A track's legs are proved by `straighten`, which asks `traceFineMoveClient` whether
      // ONE slide from here to there lands within a body's width of the target. Riding them
      // with `walkFine` asks a different question entirely — 48-unit steps with a fan of
      // headings, groping toward a point — and a leg that is a single clean slide is not
      // something that gropes well. Measured on the Tos gate track: three of four legs came
      // back "blocked, every heading refused, at every reach tried", on a route a body had
      // actually walked and a raycast had re-proved.
      //
      // So the leg is sent as the single validated move it was proved to be. walkFine stays
      // as the fallback for the leg that really does need feeling out, which is the job it
      // is good at.
      let r = await this.stepFine(wp.x, wp.y).catch(() => null);
      const arrivedNear = () => { const p = c.self;
        return p && Math.hypot(p.x - wp.x, p.y - wp.y) <= 48; };
      if (!r?.left_room && !arrivedNear())
        r = await this.walkFine(wp.x, wp.y, { maxSteps: 40, movementGeneration, controlToken })
          .catch(() => null) ?? r;
      if (r?.left_room) {
        clearStrikes(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
        return { rode: true, left_room: true, reached, blocked, rested,
                 ms: Date.now() - started };
      }
      // WAS ANYTHING ALIVE IN THE WAY? This is the whole of the strike rule: a ride that
      // fails while a body is standing on it says nothing about the route.
      if (r?.reason === 'object_blocked' || (r?.monster_blocked ?? 0) > 0
          || (Array.isArray(r?.blocked_by_bodies_at) && r.blocked_by_bodies_at.length))
        bodiesInTheWay++;
      const now = c.self;
      const near = now && Math.hypot(now.x - wp.x, now.y - wp.y) <= 48;
      if (near) reached++;
      else {
        blocked++;
        // The next leg was proved from this waypoint, not from wherever the body stopped.
        // End the replay at the first broken proof boundary and let the normal fallback act.
        break;
      }
      // Standing on shelter, and hurt: take it. Only here, because only here is the
      // character on a square something measured as hard to reach.
      if (near && shelter.has(i)) {
        // SIT, WATCH, STAND. `rest` is the client verb — there is no session-level
        // rest-until, and reaching for one that does not exist would have made this whole
        // feature a silent no-op. Polled rather than slept through, because the reason to
        // be here is that something may be hitting us: it stops the moment health stops
        // climbing, and stands up before walking on so the next leg is not crawled.
        const vit = c.vitals?.() ?? {};
        const hp = vit.health, max = vit.maxHealth;
        if (Number.isFinite(hp) && Number.isFinite(max) && max > 0 && hp / max < restBelow) {
          const before = hp;
          let last = hp, quiet = 0;
          await this.pacer.submit('rest', () => c.rest()).catch(() => null);
          const until = Date.now() + restMs;
          while (Date.now() < until) {
            if (this.movementWasCancelled(movementGeneration, controlToken)) break;
            await new Promise(r => setTimeout(r, 2000));
            const h = c.vitals?.()?.health;
            if (!Number.isFinite(h)) break;
            if (h / max >= restBelow) break;
            // LOSING health means something is hitting us and this is not shelter after
            // all; standing still to be killed is the opposite of the point.
            if (h < last) break;
            if (h === last && ++quiet >= 3) break;      // nothing is coming back
            if (h > last) quiet = 0;
            last = h;
          }
          await this.pacer.submit('rest', () => c.stand()).catch(() => null);
          if ((c.vitals?.()?.health ?? before) > before) rested++;
        }
      }
    }
    // The stitch did not get us out. Try the route that has actually been walked before
    // giving the crossing back to the planner.
    if (sewn) {
      // JOIN THE WALKED ROUTE WHERE THE STITCH LEFT US, NOT BACK AT ITS ENTRANCE.
      //
      // The stitched and walked routes have different numbers of stations, so their array
      // indices do not describe the same progress. Project the CURRENT position onto the
      // walked polyline instead: an interior projection has already passed that leg's first
      // station, hence the next station is the earliest non-regressive join. Among viable
      // stations at or beyond there, take the nearest one.
      //
      // This is not just an optimisation. In The King's Way an unproven 587>575 stitch got
      // most of the way north, missed its final long leg, then spent ten minutes driving
      // south into a wall because the fallback restarted at walked[0].
      const now = c.self;
      const finitePoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.y);
      const viableStation = i => {
        const wp = sewn[i];
        if (!finitePoint(wp)) return false;
        if (!geo || typeof geo.standable !== 'function') return true;
        return geo.standable(Math.floor(wp.y / KOD_FINENESS),
                             Math.floor(wp.x / KOD_FINENESS));
      };
      let progressAt = 0;
      if (finitePoint(now)) {
        let projectionDist = Infinity;
        for (let i = 0; i + 1 < sewn.length; i++) {
          const a = sewn[i], b = sewn[i + 1];
          if (!finitePoint(a) || !finitePoint(b)) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const length2 = dx * dx + dy * dy;
          if (!(length2 > 0)) continue;
          const t = Math.max(0, Math.min(1,
            ((now.x - a.x) * dx + (now.y - a.y) * dy) / length2));
          const d = Math.hypot(now.x - (a.x + t * dx), now.y - (a.y + t * dy));
          const ahead = t > 0 ? i + 1 : i;
          if (d < projectionDist || (d === projectionDist && ahead > progressAt)) {
            projectionDist = d;
            progressAt = ahead;
          }
        }
      }
      let fallbackAt = -1, fallbackDist = Infinity;
      for (let i = progressAt; i < sewn.length; i++) {
        if (!viableStation(i)) continue;
        const d = finitePoint(now) ? Math.hypot(sewn[i].x - now.x, sewn[i].y - now.y) : i;
        if (d < fallbackDist) { fallbackDist = d; fallbackAt = i; }
      }
      for (const wp of fallbackAt < 0 ? [] : sewn.slice(fallbackAt)) {
        if (this.movementWasCancelled(movementGeneration, controlToken)) break;
        const r = await this.walkFine(wp.x, wp.y, { maxSteps: 60, movementGeneration, controlToken })
          .catch(() => null);
        if (r?.left_room) {
          clearStrikes(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom));
          return { rode: true, left_room: true, reached, blocked, rested,
                   fell_back_to_walked: true, ms: Date.now() - started };
        }
      }
    }
    // THE RIDE DID NOT GET US OUT. Whose fault was it?
    //
    // Nothing living in the way means the route is wrong, and three of those in a row
    // retires it. A body in the way means traffic, which is exactly what a monorail is for
    // and says nothing about the line — so it is not counted, or every busy corridor would
    // strike out its own best route.
    const struck = bodiesInTheWay === 0
      ? strikeTrack(here, fromRoom == null ? null : Number(fromRoom), Number(toRoom))
      : 0;
    return { rode: true, left_room: false, reached, blocked, rested, ms: Date.now() - started,
             waypoints: track.waypoints.length - joinAt, track_best_ms: track.ms,
             bodies_in_the_way: bodiesInTheWay,
             ...(struck ? { strikes: struck,
                            retired: struck >= 3 ? 'this track will not be offered again' : undefined }
                        : {}),
             ...(sewn ? { stitch_unproven: true } : {}),
             ...(shelter.size ? { shelter_stations: shelter.size } : {}) };
  }

  // `exact` — THE CALLER'S DOOR SET IS THE WHOLE PERMITTED SET, not a starting suggestion.
  // Off by default, so every ordinary crossing keeps the anchor-first, spread-wide
  // behaviour that makes a wide wall reliable. See the block below for what it turns off
  // and the measurement that made it necessary.
  /**
   * THE PRIVATE STRATEGIES, LOADED ONCE PER PROCESS AND NEVER RE-READ.
   *
   * Cached deliberately: this is asked on a stuck walk, and a directory scan plus a set of
   * dynamic imports on that path would add latency exactly where the character is already in
   * trouble. A changed strategy therefore takes effect when the KEEPER restarts, which is the
   * same rule as every other piece of code here (see CLAUDE.md on keeper restarts) and means
   * an edit cannot half-apply to a fleet mid-journey.
   *
   * NEVER THROWS AND NEVER BLOCKS THE MOVER. A missing directory, a broken strategy, an
   * import that fails -- all of them resolve to "no answer", which is the behaviour the fleet
   * had before any of this existed.
   */
  async _askStrategies(hook, ctx) {
    try {
      if (Session._strategies === undefined) {
        Session._strategies = null;
        const mod = await import('./m59-strategies.mjs');
        Session._strategies = await mod.load();
        Session._firstAnswer = mod.firstAnswer;
        const problems = Session._strategies?.problems ?? [];
        if (problems.length)
          console.error('[strategies] ' + problems.map(p => `${p.file}: ${p.why}`).join('; '));
      }
      if (!Session._strategies || !Session._firstAnswer) return null;
      return await Session._firstAnswer(Session._strategies, hook, ctx,
        { onError: e => console.error(`[strategies] ${e.strategy} threw: ${e.why}`) });
    } catch { return null; }
  }

  /** Bodies in this room that block movement, as squares — the shape a strategy expects. */
  _blockingBodies() {
    try {
      const c = this.need();
      return [...(c.room?.objects?.values?.() ?? [])]
        .filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0))
        .map(o => ({
          row: o.row ?? (Number.isFinite(o.y) ? Math.floor(o.y / KOD_FINENESS) : null),
          col: o.col ?? (Number.isFinite(o.x) ? Math.floor(o.x / KOD_FINENESS) : null),
          kind: (o.flags & OF.PLAYER) ? 'player' : 'monster',
          name: c.rsc?.get?.(o.nameRsc) ?? o.nameRsc ?? null,
        }))
        .filter(b => Number.isFinite(b.row) && Number.isFinite(b.col));
    } catch { return []; }
  }

  /**
   * This room's blink point, from the bake, or null.
   *
   * Read from substrate/m59-blink.json once. A room with no entry is a room where blink is
   * not an option, and that has to reach the strategy as an ABSENCE rather than as a guess —
   * room.kod:789 simply does not move you when the room declares no teleport pair, while
   * blink.kod still prints its success line, so a guessed point would read as a working
   * escape that never moved anybody.
   */
  _blinkPointHere() {
    try {
      const num = Number(this.world?.room?.num ?? 0);
      if (!num) return null;
      if (Session._blinkPoints === undefined) {
        Session._blinkPoints = null;
        const url = new URL('../substrate/m59-blink.json', import.meta.url);
        const raw = readFileSync(url, 'utf8');
        Session._blinkPoints = JSON.parse(raw)?.rooms ?? null;
      }
      const p = Session._blinkPoints?.[String(num)];
      return p && Number.isFinite(p.row) && Number.isFinite(p.col)
        ? { row: p.row, col: p.col } : null;
    } catch { return null; }
  }


  /**
   * CAST BLINK AND FIND OUT WHETHER IT MOVED US. The primitive; the decision is elsewhere.
   *
   * A CAST NEEDS CONCENTRATION and the tick driver sends move/turn at 10Hz, so any packet we
   * send while the spell is charging kills it. The keeper's own `/action cast` solved this
   * already -- freeze the loop, cast, wait for the server's `moved` event rather than a fixed
   * hold -- and this is that logic, reachable from the mover. Blink is `viCast_time = 10000`,
   * so the wait is seconds, not the ~1s an attack takes.
   *
   * THE SERVER'S SENTENCE IS NOT EVIDENCE. `blink.kod` prints "You find yourself realigned
   * with your surroundings." whether or not the room declares a teleport point (room.kod:789
   * moves you only `if GetTeleportRow <> $ AND GetTeleportCol <> $`), so a strategy that
   * believed the message would report success in every room that has no blink point at all.
   * What is believed here is the `moved` EVENT and the position read back after it.
   */
  async blinkOut({ expect = null, holdMs = 15000 } = {}) {
    const c = this.client;
    if (!c) return { cast: false, why: 'no client' };
    const spell = (c.spells ?? []).find(sp => {
      const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
      return String(n).toLowerCase() === 'blink';
    });
    if (!spell) return { cast: false, why: 'this character does not know blink' };
    const loop = this._tickLoop;
    const since = c.evSeq;
    let waited = null;
    try {
      if (loop) loop._frozen = true;
      c.cast(spell.id, []);
      waited = await c.waitFor({ since, kinds: ['moved'], timeoutMs: holdMs });
    } catch (e) {
      return { cast: false, why: 'the cast threw: ' + e.message };
    } finally {
      // ALWAYS UNFROZEN. A loop left frozen is a character that never moves again, which is
      // a far worse outcome than a failed cast, so this is a finally and not a happy-path
      // line.
      if (loop) loop._frozen = false;
    }
    const moved = (waited?.events ?? []).filter(e => e.kind === 'moved');
    const at = c.self ? { row: c.self.row, col: c.self.col } : null;
    const arrived = !!expect && !!at && at.row === expect.row && at.col === expect.col;
    return { cast: true, relocated: moved.length > 0, timedOut: !!waited?.timedOut,
             at, expect, arrived,
             why: moved.length ? (arrived ? 'blinked to the room teleport point'
                                          : 'moved, but not to the square expected')
                               : 'no move event: the cast was interrupted, or this room ' +
                                 'declares no teleport point' };
  }


  // WHERE THIS BODY HAS ACTUALLY BEEN DURING THIS CROSSING, and whether that is a walk.
  //
  // A STALL DETECTOR THAT ASKS "HAVE YOU STOPPED" CANNOT SEE THIS ONE. The commonest way to
  // get nowhere here is a two-square shuffle, which resets every stillness timer it meets
  // and keeps `ms_since_moved` honest and useless — the same trap already written down for
  // the keeper's own clock. So this counts GROUND COVERED instead: the last `WINDOW` squares
  // the body has occupied, and how many of them are distinct. Twenty-four moves that visited
  // four squares is an oscillation whatever the timers say, and it is exactly what the
  // Cragged Mountains produced (r15c29 <-> r15c30 for two minutes).
  //
  // Bounded, cheap, and reset per crossing in `leaveViaAny`.
  _noteCrossingSquare(row, col) {
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    const fp = (this._crossingFootprint ??= []);
    const key = `${row},${col}`;
    this._crossingLastAt ??= Date.now();
    if (fp[fp.length - 1] === key) return;          // a repeat is not a move
    fp.push(key);
    this._crossingLastAt = Date.now();
    if (fp.length > CROSSING_WINDOW) fp.shift();
  }

  /**
   * Is this crossing going round in circles? `null` when there is not enough history to say.
   *
   * Returns the sentence that goes in the ledger, because "oscillating: true" is not
   * something an operator can check afterwards and "24 moves over 4 squares" is.
   */
  _crossingOscillation() {
    const fp = this._crossingFootprint ?? [];
    // PINNED IS THE OTHER WAY OF COVERING NO GROUND, and leaving it to "the stillness
    // detector" was a guess that the evidence did not support. Floyd sat on r9c14 in room
    // 567 for five minutes without moving one square, with mana to spare and a blink point
    // that opens 835 squares; Scooter did the same on r8c14 while firing 102 rail attempts
    // in six minutes. Neither is an oscillation, so neither got a `stalled` signal, so
    // neither was ever offered the spell — while Janice and Piggy, who happened to shuffle,
    // both got out. A body that has not changed square in a minute is not less stuck than
    // one bouncing between four; it is more.
    if (this._crossingLastAt && Date.now() - this._crossingLastAt >= CROSSING_PINNED_MS)
      return `pinned on ${fp[fp.length - 1] ?? 'one square'} for ` +
             `${Math.round((Date.now() - this._crossingLastAt) / 1000)}s`;
    if (fp.length < CROSSING_WINDOW) return null;
    const distinct = new Set(fp).size;
    if (distinct > CROSSING_DISTINCT) return null;
    return `${fp.length} moves over ${distinct} square(s)`;
  }

  /** How long this room crossing has been going, in ms. */
  _crossingMs() { return Date.now() - (this._crossingStartedAt ?? Date.now()); }

  // COORDINATE CONTRACT: every candidate follows leaveVia's named square/fine schema.
  async leaveViaAny(candidates, { movementGeneration = this.movementGeneration, controlToken,
                                  exact = false } = {}) {
    // WHEN THIS CROSSING BEGAN, because `stuck_ms` is the only thing standing between a
    // strategy and firing on every boundary that refuses once. Nothing set it, so the value
    // read below was always 0 and `min_stuck_ms` would have declined for ever -- a strategy
    // switched on, loaded, asked, and silently never firing, which is the failure mode this
    // repository has paid for before (`purpose` missing from a schema, every audit off).
    this._crossingStartedAt = Date.now();
    this._crossingFootprint = [];
    this._lastBlinkAskAt = 0;
    const tried = [];
    const skipped = [];
    let attempts = 0;
    // `tried` contains evidence about calls that happened. Keep candidates rejected by the
    // room-walk budget separate, and carry the actual invocation count on every result so a
    // caller never has to reconstruct it from a mixture of failures, successes and skips.
    const finish = result => ({ ...result, attempts,
      ...(skipped.length ? { skipped } : {}) });
    const refusal = (exit, result, extra = {}) => ({
      stand_on: exit?.stand_on,
      stage: result?.stage ?? null,
      crossing_packet_sent: result?.crossing_packet_sent ?? null,
      why: result?.reason || result?.note || 'no reason reported',
      ...extra,
    });
    // Captured before the first attempt, because a successful crossing changes the room out
    // from under us and the book has to be told which room the door was IN.
    const roomBefore = Number(this.world?.room?.num ?? this.client?.room?.id ?? NaN);
    // HOW MANY FULL ROOM-WALKS ONE DOORWAY IS WORTH.
    //
    // Every candidate after the first is another walk across the room to another square on
    // the same wall, and in the big outdoor rooms that is minutes each. Measured over three
    // hours: the hops that cost 5-16 MINUTES are precisely the ones that worked through 5,
    // 6, 7, 13 and 14 squares, while a hop that takes its first or second square costs
    // seconds. Fourteen attempts never once found a square the first two did not.
    //
    // So a boundary gets a bounded number of tries and the journey then REPLANS — which is
    // the cheaper answer by a wide margin, because `travel`'s stumble already re-reads the
    // room and can pick a different way round entirely. This is a budget on how long to
    // insist, not a claim that the wall is shut: `spreadEdges` still offers every square,
    // ordering still puts the best first, and an explicitly enabled diagnostic fallback can
    // still be used to investigate a known model gap.
    const budget = Number(process.env.M59_EXIT_CANDIDATES || 3);
    let spent = 0;
    // A NEEDLE WANTS PATIENCE, NOT BREADTH — AND SPENDING BREADTH ON ONE IS HOW A FLEET
    // QUEUES AT A DOOR AND CALLS IT A WALL.
    //
    // The budget above buys tries at DIFFERENT squares on the same wall, and its whole
    // argument is that a refusal is usually local: something is standing there, so ask
    // somewhere else. That argument needs somewhere else to exist. Measured across the
    // world, 13 of 280 declared exits offer two or fewer distinct staging squares, and
    // Western border of the Twisted Wood's west door is one of them: three published
    // crossings, all staging on 5,2, spread over 32 fine units — half a square, one body
    // wide. Watched live, five runners sent through it took 35-124 seconds each, one never
    // made it, and every retry in the log reads `stand_on: {col:2,row:5}` because there is
    // no other square to name.
    //
    // Re-asking the same square three times is not three tries, it is one try repeated
    // instantly. So when the candidates collapse to a single staging square AND the
    // refusal was a BODY rather than geometry, wait and ask again — the same distinction
    // `walkTo` already makes about `object_blocked`: a monster moves and a wall does not.
    // Bounded, because a door held by something that never moves must still end the walk
    // and let `travel` route round.
    const narrowWaits = Number(process.env.M59_NARROW_WAITS || 3);
    const narrowWaitMs = Number(process.env.M59_NARROW_WAIT_MS || 1200);
    // Far enough that a chasing monster has to come out of the gap to follow, short enough
    // that the re-approach is a few seconds rather than a second crossing of the room.
    const narrowBackoffCrumbs = Number(process.env.M59_NARROW_BACKOFF_CRUMBS || 4);
    // THE BAKED ANCHOR IS THE DOORWAY; THE EDGE SCAN IS A GUESS ABOUT WHERE ONE MIGHT BE.
    //
    // `exits()` publishes crossing squares by walking the room's declared edge openings, and
    // for Ukgoth's north edge it offers 1,62 / 1,63 / 1,64 / 1,66 and never 1,27. The route
    // bake, which planned a path somebody can walk, says the anchor for room 2 IS 1,27 — and
    // `substrate/m59-falljumps.json` wrote down why a year of this went wrong:
    //
    //   "The ONLY doorway to Outside Castle Victoria is at row 1, col 27, on the cliff top
    //    this reaches; the eastern crossing the router used instead (row 1, col 62) goes
    //    through solid rock."
    //
    // So the fleet crossed the whole room — 'followed 37 of 38' eighteen times, jump and all —
    // and then walked thirty-five columns east to try a wall. Measured over an hour: 599 -> 2
    // failed 15 times out of 15, every one of them 'every square for that exit refused', and
    // the four squares tried were 1,62 / 1,63 / 1,64 / 1,66. Never the door.
    //
    // The anchor goes in front. It is not a replacement — the scanned squares stay as
    // fallbacks, because a stale bake should degrade rather than strand anybody — but a
    // square the bake proved walkable is a better first guess than a square the edge scan
    // merely found floor on.
    const spread = spreadEdges(candidates);
    // SAY WHY, WHEN IT DOES NOT HAPPEN. Two attempts at this fix looked applied and were not —
    // the injection ran and the transit log still showed the same four eastern squares — so
    // the reasons are named out loud rather than inferred from a count that did not move.
    // WHEN THE CALLER PICKED THE DOORS ON PURPOSE, DO NOT PICK DIFFERENT ONES.
    //
    // Everything below this line exists to WIDEN a boundary: spreadEdges offers every
    // square that crosses it, and the anchor is unshifted to the front because the bake
    // planned a walkable line to it and a scanned square only has floor on it. Both are
    // right when the question is "get me through that wall" and the crossings are
    // alternatives.
    //
    // They are not alternatives when the destination is SPLIT, and then this widening is
    // the bug. Measured on prod 2026-08-27: `crossSameRoomIsland` filtered room 38's four
    // doors down to the TWO that land on the quarry's island (23,8) — and the baked anchor
    // for 38 -> 39 is door (19,2), which lands on the OTHER one (28,8). `orderExits` ranks
    // `from_anchor` above everything, so the anchor won, the character crossed by the wrong
    // door, and the keeper reported "returned to the room, but not to the quarry's connected
    // side" — a perfect round trip back to where it started. Three of six characters did
    // that in one window; the whole group killed nothing all night.
    //
    // So `exact` narrows the spread back to the squares the caller actually named and skips
    // the anchor injection entirely. IT NARROWS ONLY WHEN SOMETHING SURVIVES: an empty
    // result means the published exits and the caller's list disagree, and crossing by the
    // wrong door beats standing at a boundary refusing to cross at all — the same argument
    // the door-choice in `travel` makes.
    const exactSquares = exact
      ? new Set((candidates || []).filter(e => e?.stand_on)
          .map(e => `${e.stand_on.col},${e.stand_on.row}`))
      : null;
    if (exactSquares?.size) {
      const kept = spread.filter(e => e.stand_on &&
        exactSquares.has(`${e.stand_on.col},${e.stand_on.row}`));
      if (kept.length) { spread.length = 0; spread.push(...kept); }
    }
    const anchorTrace = [];
    for (const e of (exact ? [] : (candidates || []))) {
      if (e?.to == null) { anchorTrace.push('candidate with no `to`'); continue; }
      let anchor = null, why = null;
      try {
        const table = activeRoutes();
        const from = Number(this.world?.room?.num);
        if (!table) why = 'no routing table loaded';
        else if (!Number.isFinite(from)) why = `current room unknown (${this.world?.room?.num})`;
        else {
          anchor = anchorFor(table, from, Number(e.to));
          if (!anchor) why = `no baked anchor ${from} -> ${e.to}`;
        }
      } catch (err) { why = `anchorFor threw: ${err.message}`; }
      if (!anchor || anchor.row == null) { anchorTrace.push(why ?? `anchor had no row for ${e.to}`); continue; }
      const already = spread.some(x => Number(x.to) === Number(e.to) &&
                                       x.stand_on?.row === anchor.row && x.stand_on?.col === anchor.col);
      if (already) continue;
      const me = this.client?.self;
      spread.unshift({ ...e, stand_on: { col: anchor.col, row: anchor.row },
                       steps_away: me ? Math.max(Math.abs(anchor.row - me.row), Math.abs(anchor.col - me.col)) : 0,
                       alternates: undefined, from_anchor: true });
      anchorTrace.push(`injected ${anchor.row},${anchor.col} for ${e.to} [row,col; r${anchor.row}c${anchor.col}]`);
    }
    if (process.env.M59_EXIT_DEBUG !== '0' && anchorTrace.length)
      console.error(`[exit] room ${this.world?.room?.num}: ${anchorTrace.join('; ')}`);
    const stagingSquares = new Set(spread.map(e => `${e.stand_on?.col},${e.stand_on?.row}`));
    const isNeedle = stagingSquares.size <= 1 && spread.length > 0;
    let waited = 0;
    // A cycling door is worth a handful of asks; a room whose geometry really has changed
    // is not. Both bounds matter — the count stops the loop, the per-wait cap stops one ask
    // swallowing the whole errand.
    let animationWaits = 0;
    const ANIMATION_MAX_WAITS = Number(process.env.M59_ANIMATION_WAITS || 6);
    const ANIMATION_WAIT_MS = Number(process.env.M59_ANIMATION_WAIT_MS || 2500);
    // spreadEdges turns each declared edge into one candidate per square that crosses
    // that boundary — see m59-world.mjs. Without it this tried the nearest square and
    // called the whole wall refused.
    // Indexed rather than for-of, so the needle wait below can ask the SAME candidate
    // again. `continue` in a for-of advances to the next one, which is not a retry — and
    // on a needle publishing a single square there is no next one, so the wait would have
    // been a no-op in exactly the case it exists for.
    const ordered = orderExits(spread);
    for (let index = 0; index < ordered.length; index++) {
      const exit = ordered[index];
      if (spent >= budget) {
        skipped.push({ stand_on: exit.stand_on,
                       why: `not tried — this boundary had already cost ${budget} walks across the room` });
        break;
      }
      spent++;
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return finish(this.cancelledMovement({ tried }));
      const askedAt = Date.now();
      attempts++;
      const r = await this.leaveVia(exit, { movementGeneration, controlToken });

      // WE ARE THROUGH. STOP. DO NOT RUN A RECOVERY.
      //
      // Every tactic below exists to get an unstuck walk moving again, and every one of
      // them is movement — a retreat, a wait, another approach. Run after the crossing has
      // ALREADY happened, they are movement in the wrong room, and the character is
      // standing a step from the boundary it just came through, so the cheapest of them
      // walks it straight back. Watched live: a subject wiggled its way through the
      // entrance to The Flatlands, kept wiggling because nothing told it to stop, and
      // zoned back into Main gate to Cor Noth — undoing the only thing that had worked.
      //
      // THE ROOM IS THE AUTHORITY, NOT `r.left`. `leaveVia` reports what its own last move
      // saw, and a transition that lands a beat late reads as a refusal; asking the session
      // which room it is in cannot be late in that way, because the server pushed it. So
      // the check is against the room we started in, and it runs before anything else can
      // move the character.
      const roomNow = Number(this.world?.room?.num ?? this.client?.room?.id ?? NaN);
      const crossed = Number.isFinite(roomBefore) && Number.isFinite(roomNow)
                   && roomNow !== roomBefore;
      if (crossed && !r.left) {
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                       tactic: 'needle_backoff', trigger: 'door_refused', worked: true,
                       ms: Date.now() - askedAt,
                       note: 'the room changed while the crossing reported failure — ' +
                             'stopped rather than recovering back through the door' });
        return finish({ left: true, late: true, used_exit: exit,
                        stood_on: this.lastExitStand ?? null,
                        ...(tried.length ? { tried } : {}) });
      }
      if (r.left) {
        // THE DOOR HAS NOT MOVED, SO IT SHOULD BE WRITTEN DOWN — AND THIS IS NOT YET THE
        // PLACE THAT CAN DO IT HONESTLY.
        //
        // `exits()` already ranks a square somebody was OBSERVED crossing at above every
        // derived candidate, and nothing but a human's proxy walk log has ever written to
        // that book — so the fleet crosses these boundaries hundreds of times a day and
        // re-derives the door on every one of them. Recording its own successes is exactly
        // the right idea.
        //
        // The first attempt at it was WRONG and is left here as a warning rather than as
        // code. Recording at this point produced pairs like `574>574` and `587>587`, and a
        // square of 115,88 in a room that is 55x67 — the ARRIVAL coordinate in the room we
        // had just entered. By the time a crossing has succeeded, both the room and the
        // position have moved on, so this site can see neither the door it used nor the
        // side it used it from. Being wrong here is not a wasted walk: the learned book is
        // merged into the operator's observed evidence and OUTRANKS every derived
        // candidate, so a fictitious door would be preferred over the real one for ever.
        //
        // What it needs is the room and the crossing square captured BEFORE the move, by
        // the code that actually sends it — `leaveVia` — and confirmed against the room we
        // land in, which is the same discipline `m59-crossings.json` already applies to the
        // operator's logs. Until then the fleet re-derives, which is slow and correct.
        if (tried.length)
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore ?? null,
                         tactic: 'needle_backoff', trigger: 'door_refused', worked: true,
                         ms: Date.now() - askedAt,
                         note: `crossed on attempt ${attempts}` });
        return finish({ ...r, used_exit: exit, stood_on: this.lastExitStand ?? null,
                        ...(tried.length ? { tried } : {}) });
      }
      // AN ANIMATING DOOR IS A TEMPORARY OBSTACLE WEARING A TERMINAL REASON'S CLOTHES.
      //
      // `collision_geometry_changed` is on the terminal list for a good reason: the room's
      // geometry moved, we cannot mutate our BSP the way the stock client does, and a
      // refusal that loops is how a bad route gets learned. But the thing that fires it
      // most is a DOOR, and a door opens again — the Temple of Qor's lives in room 598 and
      // cycles faster than the 8s invalidation window, which is why it sits exactly on the
      // Cragged Mountains -> Ukgoth crossing on the road to Castle Victoria. Measured
      // there: seven refusals in thirty-five seconds and the Tos -> Castle Victoria leg
      // never once completed, 0 of 3 in a grand tour.
      //
      // Abandoning the boundary is the worst response available, because the next attempt
      // walks the whole room again and arrives at a fresh random phase of the same cycle.
      // Standing at the door and asking again costs nothing and is what a person does.
      // Bounded in tries AND in total time, so a genuine geometry change — the case the
      // terminal list is really for — still ends the walk rather than pinning a character
      // at a wall for ever.
      if (r.reason === 'collision_geometry_changed' && animationWaits < ANIMATION_MAX_WAITS) {
        animationWaits++; spent--;
        const gap = Number.isFinite(r.animation?.expires_in_ms)
          ? Math.min(ANIMATION_WAIT_MS, Math.max(250, r.animation.expires_in_ms + 250))
          : ANIMATION_WAIT_MS;
        tried.push(refusal(exit, r, {
          waited_for_the_animation_ms: gap,
          ...(r.animation ? { animation: r.animation } : {}),
          note: `a live animation holds this doorway — waiting at it rather than ` +
                `walking the room again (${animationWaits}/${ANIMATION_MAX_WAITS})`,
        }));
        recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                       tactic: 'animation_wait', trigger: 'door_refused', worked: false,
                       ms: gap, note: r.animation?.sector != null
                         ? `sector ${r.animation.sector}` : 'whole room refused' });
        await new Promise(resolve => setTimeout(resolve, gap));
        index--;                        // the same door, one cycle later
        continue;
      }
      if (isTerminalMovementReason(r.reason)) {
        tried.push(refusal(exit, r));
        return finish({ ...r, left: false, used_exit: exit, tried });
      }
      // BLOCKED BY A BODY AT A ONE-SQUARE DOOR: the next candidate is this candidate, so
      // waiting is the only thing that can change the answer. It does not consume the
      // budget, because it is not another square — it is the same square, later.
      const bodyBlocked = (r.monster_blocked ?? 0) > 0
        || (Array.isArray(r.blocked_by_bodies_at) && r.blocked_by_bodies_at.length > 0)
        || r.reason === 'object_blocked';
      if (isNeedle && bodyBlocked && waited < narrowWaits) {
        const bodyRefusal = refusal(exit, r, {
          waited_for_the_doorway_ms: narrowWaitMs,
          note: `one-square doorway held by a body — waiting rather than asking the same square again (${waited + 1}/${narrowWaits})`,
          ...(r.monster_blocked ? { monster_blocked: r.monster_blocked } : {}),
          ...(r.damage_while_blocked ? { damage_while_blocked: r.damage_while_blocked } : {}),
        });
        tried.push(bodyRefusal);
        // A CHARACTER BEING HIT IN A DOORWAY DOES NOT STAND THERE COUNTING. The whole
        // reason to wait is that the blocker is expected to wander off; taking damage says
        // it has noticed us instead, and this repository has already paid for confusing
        // those two — see the note on `object_blocked` in walkTo.
        // BACK UP, SO THE THING IN THE WAY FOLLOWS AND LEAVES THE DOORWAY.
        //
        // Standing at a one-body door waiting for a monster to wander off is the wrong
        // model of a monster: it is not wandering, it is coming for us, and coming for us
        // is exactly what makes it useful. A monster that chases vacates the choke point,
        // and the door we could not squeeze past is then open. That is the ordinary way a
        // person plays this — pull the blocker off the gap and go round it — and it is
        // strictly better than the wait, which asks the same question with the same body
        // in the same square.
        //
        // Retreat along BREADCRUMBS rather than picking a direction. Every crumb was
        // authorised by the fine validator on the way in, so backing up cannot invent a
        // traversal — it can only undo one — which matters here more than anywhere else,
        // because the squares behind a needle are the tight ones. See the breadcrumb note
        // in walkTo for why a coarse-grid escape hatch was rejected for this job.
        //
        // Still bounded, and still NOT done while we are being hit: a blocker that is
        // already swinging is not going to be pulled anywhere, and the character needs to
        // leave rather than to keep dancing at the gap. That is the one case where giving
        // up quickly is the survival answer, and it is the case that kills characters in
        // the Western border of the Twisted Wood.
        if (r.damage_while_blocked) {
          bodyRefusal.note = 'one-square doorway, and we are being hit in it — not waiting';
        } else {
          waited++; spent--;
          const backed = await this.retreatAlongBreadcrumbs(
            { maxCrumbs: narrowBackoffCrumbs, movementGeneration, controlToken }).catch(() => null);
          bodyRefusal.backed_off = backed?.steps ?? 0;
          recordTactic({ character: this.client?.me?.name ?? this.name ?? null, room: roomBefore,
                         tactic: 'needle_backoff', trigger: 'body_blocked',
                         // Not known to have worked yet — the NEXT attempt says that, and a
                         // tactic that reports its own success is the failure this ledger
                         // exists to make visible.
                         worked: false, ms: narrowWaitMs,
                         hp_lost: r.damage_while_blocked ?? 0,
                         note: `backed off ${backed?.steps ?? 0} crumb(s)` });
          await new Promise(resolve => setTimeout(resolve, narrowWaitMs));
          index--;                      // the same square, later — that is the whole point
          continue;
        }
        // This call is already represented by bodyRefusal. Move to the next candidate
        // without appending the same failure a second time below.
        continue;
      }
      tried.push(refusal(exit, r));
    }
    // EVERY SQUARE REFUSED. Normal travel reports the refusal and replans. An operator may
    // explicitly enable the unvalidated diagnostic below to test a known model gap, but
    // nothing inferred from an ordinary refusal grants that movement authority.
    // A BODY IS NOT A GAP IN THE MODEL, SO IT DOES NOT EARN THE UNVALIDATED STEP.
    //
    // The explicit diagnostic override exists for one situation: our collision model refuses
    // a square that people demonstrably walk on, so the model is wrong and the door is real.
    // Every word of that argument is about GEOMETRY.
    //
    // It said nothing about bodies, and `object_blocked` is not terminal — so a doorway held
    // by players refused every attempted square, fell through here, and forced a crossing anyway. That
    // is walking through a person: the one thing the whole collision subsystem exists to
    // stop, arriving through the door reserved for admitting the subsystem is wrong.
    //
    // And it is not even the same bet. A wall the model invented will be there next time; a
    // body will not. The honest answer to a door full of people is that the crossing cannot
    // be made right now, which sends the journey to the OTHER door — or, if that is held
    // too, reports a refusal the caller can act on.
    //
    // Found by the operator's own negative case: four characters shoulder to shoulder across
    // a doorway, and the test asked what happens when both ways in are shut.
    const everyRefusalWasABody = tried.length > 0 &&
      tried.every(t => /object_blocked|body_blocked/i.test(String(t.why ?? '')));
    if (everyRefusalWasABody)
      return finish({ left: false, tried, blocked_by_bodies: true,
                      reason: 'object_blocked',
                      note: 'every attempted square on this boundary had somebody standing on it. Not using ' +
                            'the explicit diagnostic override: a person is not a hole in the map' });
    if (tried.length && process.env.M59_EXIT_FALLBACK === '1') {
      const best = ordered[0] ?? null;
      if (best) {
        attempts++;
        const forced = await this.leaveViaUnvalidated(best, { movementGeneration });
        if (forced.left) return finish({ ...forced, used_exit: best, fallback: true, tried });
        tried.push(refusal(best, forced, { fallback: true }));
      }
    }
    // LAST, AND ONLY WITH SOMETHING PRIVATE LOADED. Every ordinary answer has now been
    // tried: each candidate square, the queue behind a player, the fine lane past a body,
    // the sidestep, the retreat. This is the moment the crossing is about to be reported
    // shut, and it is the only honest place to ask a strategy whether it has one more idea.
    //
    // A CLONE HAS NO STRATEGIES AND THEREFORE NO CHANGE IN BEHAVIOUR. `m59-strategies.load`
    // returns an empty set when substrate/strategies/ does not exist, `firstAnswer` returns
    // null, and the return below runs exactly as it did before. Silence is the behaviour
    // that was already there.
    // DECLARED HERE, NOT BORROWED FROM BELOW. `offered` is defined further down as part of
    // the gap report, and reaching forward to it threw `Cannot access 'offered' before
    // initialization` -- the same shape as the `laneAim` crash that killed a character in
    // prod, caught this time by the dependency suite rather than by a death.
    const bestExit = ordered[0] ?? null;
    // Guarded like `_blockingBodies` below: `leaveViaAny` is lifted out of this class and run
    // against hand-built sessions by m59-collision-test.mjs.
    const crossingMs = typeof this._crossingMs === 'function' ? this._crossingMs() : 0;
    const crossingLoop = typeof this._crossingOscillation === 'function'
      ? this._crossingOscillation() : null;
    const stuckAnswer = await this._askStrategies('whenStuck', {
      room: this.world?.room ?? null,
      geo: this.world?.geometry ?? null,
      self: this.client?.self ?? null,
      goal: bestExit?.stand_on ?? null,
      route: tried.map(t => t.stand_on).filter(Boolean),
      bodies: this._blockingBodies(),
      blink: this._blinkPointHere(),
      vitals: this.client?.vitals?.() ?? null,
      stuck_ms: crossingMs,
      underFire: !!this._underFireDuringCrossing,
      agent: this.name ?? this.client?.me?.name ?? null,
      // The same two signals the walker's ask carries. Reaching the give-up at all means the
      // boundary refused every candidate, so this is usually already past the stall clock —
      // but it is passed rather than assumed, because a first-try refusal reaches here too.
      crossing_ms: crossingMs, oscillating: crossingLoop,
      stalled: crossingMs >= CROSSING_STALL_MS && crossingLoop
        ? `${Math.round(crossingMs / 1000)}s in this room, ${crossingLoop}` : null,
    }).catch(() => null);
    if (stuckAnswer?.answer?.do === 'blink') {
      // A WALL BEFORE THE CAST, WHEN THE ANSWER ASKS FOR ONE. `need_safe_spot` was in every
      // strategy's answer and nothing ever read it, so a character being hit was either
      // refused outright or asked to stand still for ten seconds in the open. A safe wall is
      // a square nothing attacks until you attack first: take one, then cast from it. If no
      // wall can be taken, there is no cast — the ledger says so rather than the Underworld.
      let wall = null;
      if (stuckAnswer.answer.need_safe_spot) {
        const pilot = autopilotIfAny(this.name);
        wall = pilot && typeof pilot.takeSafeSpot === 'function'
          ? await pilot.takeSafeSpot('a wall to blink from', null, { source: 'travel' })
                       .catch(e => ({ took: false, why: e.message }))
          : { took: false, why: 'no autopilot to take a wall with' };
      }
      // THE SAME RULE AS THE WALKER'S SITE, AND IT HAD TO BE SAID TWICE BECAUSE THERE ARE
      // TWO OF THEM. `leaveViaAny`'s give-up is the one that fires when every candidate on
      // a boundary has been refused, and on the day the wall-less cast shipped this was
      // still the old code — so Animal sat in room 567's 17-square pocket writing
      // `blink_escape ... no wall (nothing in this room is more defensible)` every forty
      // seconds while Kermit, whose walk went through the OTHER site, blinked out and
      // reached Castle Victoria. Same fix: a wall is preparation, not permission; under
      // fire, break contact along proven crumbs first and cast either way.
      let evaded = null;
      if (!wall?.took && this._underFireDuringCrossing &&
          typeof this.retreatAlongBreadcrumbs === 'function') {
        const deadline = Date.now() + BLINK_EVADE_MS;
        evaded = await this.retreatAlongBreadcrumbs({
          maxCrumbs: Number(process.env.M59_BLINK_EVADE_CRUMBS || 4),
          until: () => Date.now() >= deadline,
          movementGeneration, controlToken,
        }).catch(() => null);
      }
      let rested = null;
      if (wall?.took && (stuckAnswer.answer.rest_to_vigor || stuckAnswer.answer.rest_to_mana)) {
        const pilot = autopilotIfAny(this.name);
        rested = pilot && typeof pilot.restBeforeBlink === 'function'
          ? await pilot.restBeforeBlink('vigor and mana before a blink out of a stalled crossing',
                                        { mana: Number(stuckAnswer.answer.rest_to_mana ?? 0) })
                       .catch(e => ({ rested: false, why: e.message }))
          : { rested: false, why: 'no autopilot to rest with' };
      }
      const out = await this.blinkOut({ expect: stuckAnswer.answer.expect }).catch(() => null);
      recordTactic({ character: this.client?.me?.name ?? this.name ?? null,
                     room: Number(this.world?.room?.num ?? 0),
                     tactic: 'blink_escape', trigger: stuckAnswer.strategy,
                     worked: !!out?.arrived, ms: 0, hp_lost: 0, attempted: true,
                     note: `${stuckAnswer.answer.why}; ` +
                           (stuckAnswer.answer.need_safe_spot
                              ? (wall?.took ? 'took a wall first; '
                                 : `no wall (${wall?.why ?? '?'}) — casting anyway; `) : '') +
                           (evaded ? `backed off ${evaded.steps ?? 0} crumb(s) first; ` : '') +
                           (rested ? (rested.rested ? 'rested to the cap first; '
                                                    : `did not rest (${rested.why ?? '?'}); `) : '') +
                           `${out?.why ?? 'no result'}` });
      // E, AND IT IS THE STRATEGY'S OWN CALLBACK. The predicate recorded what it saw; only
      // the caller knows what happened next, and 'the spell never fizzles' is not the same
      // claim as 'the character is now unstuck'.
      try { stuckAnswer.answer.settled?.(!!out?.arrived, out?.why ?? null, out?.at ?? null); }
      catch { /* the record is evidence, not a dependency */ }
      if (out?.arrived) {
        // One more go at the SAME boundary from where we now stand. Not a recursion into
        // leaveViaAny -- that would re-ask the strategy from the new position and could
        // blink twice -- just the best candidate, once.
        if (bestExit) attempts++;
        const again = bestExit ? await this.leaveVia(bestExit, { movementGeneration, controlToken })
                               : null;
        if (again?.left)
          return finish({ ...again, used_exit: bestExit, after_blink: true, tried });
        if (again) tried.push(refusal(bestExit, again, { after_blink: true }));
      }
    }
    // THE EVIDENCE FOR A GAP REPORT, carried out rather than filed here. What makes a
    // refusal actionable is not that it happened but WHAT THE MODEL BELIEVED — the best
    // square it could offer — so that it can be set against the square a character is
    // standing on when the same door works. See m59-exitgap.mjs.
    const last = tried[tried.length - 1];
    const offered = ordered[0] ?? null;
    return finish({ left: false, outcome: 'exit_candidates_exhausted', tried,
                    gap: { believed: offered?.stand_on
                             ? { col: offered.stand_on.col, row: offered.stand_on.row } : null,
                           direction: offered?.direction ?? candidates?.[0]?.direction ?? null,
                           offered: attempts,
                           ...(skipped.length ? { skipped: skipped.length } : {}) },
                    reason: attempts > 1
                      ? `every square for that exit refused (${attempts} tried)`
                      : (last ? last.why : 'no exit to try') });
  }

  // One paced round of swings, facing the target before each. Split out from the
  // `attack` tool so the composite skills can drive combat without going through the
  // MCP layer and re-resolving the target every time.
  // `abortBelow` is a health FRACTION, checked after every swing rather than after the
  // round. It is the difference between looking at your own health twice a second and
  // twice a minute.
  //
  // WE WERE SAMPLING AT HALF THE RATE WE DIE. A round is four swings, each paced at
  // ATTACK_INTERVAL_MS and each waiting up to 2500ms for the exchange — call it four
  // seconds — and the disengage test sat AFTER all four (m59-skills.mjs:1483), inside a
  // loop that runs twelve rounds. Meanwhile six centipedes land 12-18 damage a round on
  // a 27-health character: dead in about two seconds.
  //
  // It shows up in the ledger exactly as you would predict. Of 65 deaths, 42% never
  // recorded a health value BELOW their own flee threshold and 32% have a trail that
  // reads 27/27 -> 27/27 -> 27/27 -> dead. Not a threshold tuned wrong — a threshold
  // that was never read while it mattered.
  //
  // And the check is free. `c.vitals()` is already live: BP_STAT is PUSHED on every
  // change (player.kod:7343 calls DrawStatSkill on each one), so the number is sitting
  // in memory between swings. We were not failing to know it, we were failing to look.
  async attackRounds(targetId, swings = 4, { abortBelow = null } = {}) {
    const c = this.need();
    const messages = [];
    let aborted = null;
    const healthPct = () => {
      const h = c.vitals()?.health;
      return h?.max ? h.value / h.max : null;
    };
    for (let i = 0; i < swings; i++) {
      const o = c.room.objects.get(targetId);
      if (!o) break;
      // Before the swing as well as after it: the previous exchange's damage has
      // already landed, and one more swing at 15% is how a character dies mid-round.
      if (abortBelow != null) {
        const hp = healthPct();
        if (hp != null && hp < abortBelow) { aborted = { at_health: hp, swing: i }; break; }
      }
      await this.faceToward(o);
      const before = c.evSeq;
      await this.pacer.submit('attack', () => c.attack(targetId), ATTACK_INTERVAL_MS);
      const ev = await c.waitFor({ since: before, timeoutMs: 2500 });
      messages.push(...ev.events.filter(e => e.text).map(e => e.text));
      if (ev.events.some(e => e.kind === 'vanished' && e.id === targetId)) break;
      if (!c.room.objects.has(c.selfId)) break;      // we died
      if (abortBelow != null) {
        const hp = healthPct();
        if (hp != null && hp < abortBelow) { aborted = { at_health: hp, swing: i + 1 }; break; }
      }
      // A refused swing is refused for the same reason for the whole round — nothing
      // inside a round clears PFLAG_NO_FIGHT — so the other three are three more
      // identical refusals bought at a packet each. Stop and let the caller act on it;
      // `fight` stands up and takes the round again, which is the usual cure.
      if (messages.some((t) => skills.cannotSwingText(t))) break;
    }
    // Health after the exchange, since deciding whether to keep fighting depends on
    // it and the stat only arrives when it changes.
    await this.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    return { messages, vitals: c.vitals(), aborted };
  }

  // Pick up everything gettable within reach. Shared with the `loot` tool.
  // `stayPut` is for looting from a safe spot: UserGet reaches seven squares on its
  // own, so most of a kill's drops are already gettable from where you stand, and the
  // few that are not are not worth giving up the wall for. What is left behind is
  // reported rather than silently skipped.
  async lootFloor({ only = null, ids = null, maxItems = 12, stayPut = false,
                    movementGeneration = this.movementGeneration, controlToken = null,
                    shouldCancel = null, explicitIdsOverride = true,
                    beforeMutation = null } = {}) {
    const c = this.need();
    const cancelled = () => typeof shouldCancel === 'function' && shouldCancel();
    if (cancelled())
      return { taken: [], refused: [], carrying: [], cancelled: true,
               note: 'loot intent was cancelled before its first server request' };
    await this.pacer.submit('read', () => c.roomContents());
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
    const me0 = c.self;
    if (!me0) return { taken: [], refused: [], carrying: [], reason: 'own position unknown' };
    const manhattan = o => Math.abs(o.col - me0.col) + Math.abs(o.row - me0.row);

    let cands = [...c.room.objects.values()].filter(o => o.id !== c.selfId && (o.flags & OF.GETTABLE));

    // NEVER PICK THESE UP.
    //
    // Two items in the game return TRUE from IsCursed, and picking one up is not a
    // mistake you can undo by dropping it. The Amulet of Shadows equips itself, costs
    // you light, applies a defence PENALTY so everything hits you more often, and
    // cannot be taken off without an uncurse spell — and shadowam.kod can call
    // @Killed on its owner outright. Its own source comments that handing them to
    // people is a known griefing tactic. The ring of lethargy is the other.
    //
    // A keeper looting a corpse field will happily take one, so this is not caution,
    // it is the difference between scavenging being profitable and being a trap. They
    // are REFUSED rather than silently skipped, so the reason is visible.
    const cursedSkipped = [];
    cands = cands.filter(o => {
      const n = c.rsc.get(o.nameRsc) || '';
      if (CURSED_ITEMS.test(n)) { cursedSkipped.push(n); return false; }
      return true;
    });

    if (ids?.length) { const w = new Set(ids.map(Number)); cands = cands.filter(o => w.has(o.id)); }
    else if (only) { const q = String(only).toLowerCase(); cands = cands.filter(o => c.rsc.get(o.nameRsc).toLowerCase().includes(q)); }
    cands.sort((a, b) => manhattan(a) - manhattan(b));
    cands = cands.slice(0, maxItems);

    // DO NOT PICK UP A WEAPON THAT IS ALREADY BROKEN.
    //
    // A shattered weapon is worth nothing, cannot be wielded, cannot be sold, and is not
    // renamed — so it looks exactly like the real thing on the floor and gets taken every
    // time. That is where the fleet's dead maces came from: Floyd carrying six and Kermit
    // eight, all picked up off corpses, all indistinguishable until something tried to
    // wield one. Asking the server here costs one look per weapon-shaped candidate and
    // saves a pack slot carried across the world.
    //
    // Only weapon-shaped names are checked, because that is the only class whose
    // brokenness we can read, and only when nothing was asked for by id — an explicit
    // `ids` request is the caller overriding us on purpose. UNKNOWN is taken, not
    // skipped: a look that came back empty is not evidence of anything.
    const brokenSkipped = [];
    if ((!ids?.length || !explicitIdsOverride) && cands.length) {
      // ARMOUR AND SHIELDS BREAK THE SAME WAY AND WERE NOT BEING ASKED ABOUT.
      //
      // This checked weapon-shaped names only, and the comment above explains why — that
      // was the class whose brokenness we knew how to read. It is not: a broken shield
      // refuses on the use path with the same sentence a broken mace does ("You can't use
      // the gold round shield--it's broken."), and examining it answers the same way. So
      // dead armour was picked up off every corpse field exactly as the dead maces were,
      // and worse, it read as ARMOUR in every audit — a character carrying a shattered
      // breastplate looks equipped until something tries to wear it.
      const brokenish = cands.filter(o => {
        const n = c.rsc.get(o.nameRsc) || '';
        return skills.weaponScore(n) > 0 || !!skills.armourKind(n);
      });
      if (brokenish.length) {
        const verdict = await skills.inspectForBroken(this, brokenish.map(o => o.id))
                                    .catch(() => ({ broken: [] }));
        const dead = new Set(verdict.broken || []);
        if (dead.size) {
          cands = cands.filter(o => {
            if (!dead.has(o.id)) return true;
            brokenSkipped.push(c.rsc.get(o.nameRsc) || 'a piece of gear');
            return false;
          });
        }
      }
    }

    const taken = [], refused = [];
    let wasCancelled = false;
    for (const n of brokenSkipped)
      refused.push({ item: n, why: 'BROKEN — the server says it has been shattered. It cannot be ' +
                                   'wielded or sold, and its name does not say so, which is why the ' +
                                   'fleet used to carry them for ever. Left on the floor.' });
    for (const n of cursedSkipped)
      refused.push({ item: n, why: 'CURSED — it equips itself, cannot be removed without an ' +
                                   'uncurse spell, and makes you easier to hit. Leave it.' });
    for (const o of cands) {
      if (cancelled()) { wasCancelled = true; break; }
      const name = c.rsc.get(o.nameRsc);
      const me = c.self;
      // UserGet measures MANHATTAN distance and refuses past 7, so only walk when
      // we actually have to — most drops are already in reach.
      if (me && (Math.abs(o.col - me.col) + Math.abs(o.row - me.row)) > 7) {
        if (stayPut) {
          refused.push({ id: o.id, name,
                         why: 'more than seven squares away, and we are holding a safe spot — ' +
                              'walking over to it would give up the wall' });
          continue;
        }
        const spot = this.world.approachSquare(o.col, o.row);
        if (!spot) { refused.push({ id: o.id, name, why: 'cannot reach it through the geometry' }); continue; }
        const walk = await this.walkTo(spot.col, spot.row, {
          maxSteps: Math.max(30, spot.steps + 10), movementGeneration, controlToken,
          beforeMutation: typeof beforeMutation === 'function'
            ? (packet, detail) => beforeMutation(packet, { ...detail, target_id: o.id })
            : null,
        });
        if (!walk.arrived) { refused.push({ id: o.id, name, why: walk.reason || 'could not get there' }); continue; }
      }
      if (cancelled()) { wasCancelled = true; break; }
      const before = c.evSeq;
      await this.pacer.submit('get', () => {
        if (typeof beforeMutation === 'function') beforeMutation('get', { target_id: o.id });
        return c.get(o.id);
      });
      const ev = await c.waitFor({ since: before, kinds: ['got', 'message', 'vanished'], timeoutMs: 3000 });
      const got = ev.events.find(e => e.kind === 'got');
      if (got) taken.push({ id: o.id, name, amount: o.amount || undefined });
      else refused.push({ id: o.id, name, why: ev.events.filter(e => e.text).map(e => e.text).join('; ') || 'no reply' });
    }
    if (!wasCancelled) {
      await this.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    }
    return { taken, refused,
             carrying: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })),
             ...(wasCancelled ? { cancelled: true,
               note: 'loot intent stopped before the next paced item action' } : {}) };
  }

  // Offer one item to a merchant and either read the price or complete the sale.
  // Selling is the trade protocol, so this is offer -> wait for the money
  // counteroffer -> accept (or cancel, when we only wanted the quote).
  async sellOne(merchantRef, item, confirm) {
    const c = this.need();
    const t = typeof merchantRef === 'object' && merchantRef !== null ? merchantRef : { id: Number(merchantRef) };
    const before = c.evSeq;
    await this.pacer.submit('trade', () => c.offer(t.id, [item.amount > 1 ? { id: item.id, amount: item.amount } : item.id]));
    // Wait for the COUNTEROFFER specifically: our own echo always lands first, and
    // listening for both makes every sale look like a refusal.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 });
    const countered = ev.events.find(e => e.kind === 'countered');
    const all = c.eventsSince(before);
    const said = all.filter(e => e.kind === 'said' && e.speaker === t.id).map(e => e.text);
    if (!countered) {
      await this.pacer.submit('trade', () => c.cancelOffer());
      return { sold: false, offered_price: null, merchant_said: said,
               note: said.length ? 'the merchant refused out loud' : 'no counteroffer came back' };
    }
    const price = (c.trade?.theirs || []).reduce((n, i) => n + (i.amount || 1), 0);
    if (!confirm) {
      await this.pacer.submit('trade', () => c.cancelOffer());
      return { sold: false, offered_price: price, merchant_said: said, note: 'quote only' };
    }
    await this.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(r => setTimeout(r, 1400));
    await this.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 4000 });
    return { sold: true, offered_price: price, merchant_said: said };
  }

  // Travel to another room, hop by hop, replanning at each arrival. Replanning per
  // hop rather than trusting the whole route up front matters because a conditional
  // edge exit's destination depends on where along the boundary we crossed, so the
  // room we actually land in is not always the one the plan named.
  // `onHop` IS A PAUSE POINT, NOT AN ABORT. It is awaited once per room, after arriving
  // and before choosing the next exit, and whatever it does the journey continues
  // afterwards.
  //
  // That asymmetry is the whole design and it is easy to get backwards. A journey is 3
  // rooms at the median and 10 at p90, and a character that gives up in the middle of one
  // is not safe — it is stranded in a worse room than either end, with the same walk still
  // to do and less health to do it with. Travel in this game is dangerous and there is no
  // version of it that is not; the only thing worth doing between rooms is stopping
  // somewhere defensible until you can go on. So the hook may take as long as it likes and
  // its return value is ignored: cancellation stays the caller's business, through
  // `cancelMovement`, which this loop already honours at the top of every iteration.
  //
  // It is awaited AFTER the arrival settle, so the room contents have landed and anything
  // deciding where to stand is looking at a room it can actually see.
  // ONE CALL IS THE WHOLE JOURNEY. `stumbles` is why.
  //
  // This used to return `arrived: false` the moment any single hop failed, which made a
  // cross-world trip a coin flip that the CALLER had to keep flipping — m59-supervise
  // wrapped it in three tries, and a run that did not (a rent errand, measured here) had
  // Clifford fail to reach a bank twice and Waldorf twice, from one attempt each, while
  // the identical call succeeded on the second or third go every time.
  //
  // The failures are transient and the route is RESUMABLE: each attempt re-plans from
  // wherever the character actually got to, so a retry continues the journey rather than
  // restarting it. "start is outside the room grid" is the classic one — the character
  // arrives at an edge, its coordinates read as off the grid for an instant, and the next
  // edge cannot be computed. Nothing is wrong; the position has not settled.
  //
  // So the retry belongs HERE, once, rather than in every caller — because a caller that
  // forgets it does not get a slower journey, it gets a character stranded halfway across
  // the world with the trip reported as finished.
  //
  // A STUMBLE IS NOT A HOP. They are counted separately so `maxHops` still means what it
  // says: re-settling in the same room must not eat the budget for crossing rooms, or a
  // long trip through one sticky doorway would run out of journey before it ran out of
  // patience.
  async travel(toRoomNum, {
    maxHops = 25,
    maxStumbles = 6,
    movementGeneration = this.movementGeneration,
    controlToken,
    onHop = null,
    // WHICH SIDE OF THE DESTINATION, when the destination has sides. A square in the
    // destination room that the arrival must be able to walk to. Omit it and travel
    // behaves exactly as it always did. See doorsLandingNear.
    arriveNear = null,
  } = {}) {
    const log = [];
    // TIME EXPOSED, PER MAP. See m59-transits.mjs for why this is the number worth having
    // and why "damage taken in transit" is not: there is no safe travel in this game and
    // there is not meant to be. Every second inside a map is a second something can reach
    // you, so the crossing time is the part we actually control.
    //
    // The clock starts here rather than at the first hop, because "told to travel" to
    // "out of the first room" is time in the room exactly like any other.
    const journeyId = `${this.name}-${Date.now().toString(36)}`;
    let enteredAt = Date.now();
    let hops = 0, stumbles = 0, totalStumbles = 0, pocketEscaped = false, mainRegionEscaped = false;
    // WHICH DOOR WE CAME IN BY, because that is half of a track's identity. A crossing of a
    // room is not one route, it is one per entrance — Western border of the Twisted Wood is
    // entered from three different rooms and leaves by three more — so a book keyed only on
    // the destination would hand every arrival the same approach, which is the mistake
    // `anchorFor` exists to make inexpressible. Null on the first hop: we did not walk in.
    let cameFromRoom = null;
    // Exact directed hops this journey has already exhausted. A room number is too broad:
    // failing A->B says nothing about reaching B from C, and says nothing about another
    // character. World.route accepts this exact `from>to` unit and may relax it only when
    // there is no other graph route; if that permissive pass hands the same hop back, the
    // loop below reports one stable terminal result instead of walking the same boundary
    // again. Nothing here is persisted beyond this journey.
    const exhaustedHops = new Map();
    // A WRONG-ROOM LANDING DOES NOT BAN THE HOP IT AIMED FOR.
    //
    // This kept a journey-scoped set and added to it whenever a crossing landed in the wrong
    // room. It cascaded exactly as the operator warned it would: in one leg, ten wrong-room
    // crossings banned SIX GOOD HOPS —
    //
    //   586->585   50->61   587->576   587->597   586->596   586->50
    //
    // the first hop of a perfectly good road out of Tos, the way BACK to Tos, and both ways
    // onward from the Main gate. With those gone the router had almost nothing left and set
    // off for the border of the Badlands. Hops that had taken twenty seconds started taking
    // four hundred.
    //
    // None of those edges is false. Every one is walkable, and what fails is that the body
    // drifts across a boundary whose exit is chosen BY ROW, firing the neighbour's door
    // instead of ours. Deleting the door to work around a drift is how a movement bug
    // becomes a map that shrinks every time a character stumbles.
    //
    // `exhaustedHops` above is narrower evidence: leaveViaAny has actually spent its bounded
    // candidate set without leaving the room. That exact executor result may steer this one
    // journey; an unplanned landing, a guessed cause, or a remembered map opinion may not.

    // Let the position settle and the room re-publish itself, then try again from
    // wherever we actually are. Returns false when the patience is spent.
    //
    // TWO COUNTERS, because they answer different questions. `stumbles` is CONSECUTIVE and
    // is the patience budget — it resets on every real hop, so one sticky doorway early on
    // must not shorten the patience available to a sticky doorway later. `totalStumbles` is
    // the whole journey's, and is what gets reported: a trip that arrived after eleven
    // retries arrived, but it is not the same event as one that walked straight there, and
    // a report that reset to zero on success could not tell them apart.
    // DYING MID-JOURNEY PUTS YOU SOMEWHERE WITH NO EXITS, AND STUMBLING THERE IS FREE
    // ONLY IN THE SENSE THAT IT ACHIEVES NOTHING.
    //
    // The Underworld publishes no exits in the room graph — "six teleporters, and that is
    // all" — so a journey that dies on the way spends its whole stumble budget re-reading a
    // room and re-planning a route that cannot exist. Measured on Tos -> North Barloque: the
    // character died in The Flatlands and then stumbled seven times over THIRTEEN MINUTES,
    // each one reporting "no route from 1 to 101 in the graph". Two runs of that were
    // recorded at 795s and 799s and read, from outside, as a slow journey with a wrong turn.
    // It was a corpse.
    //
    // Escaping is a thing this repository already knows how to do, and it is what the
    // character needs before any route exists. One attempt, because a second is the same
    // attempt: if it did not work, the journey is genuinely over and should say so rather
    // than spend ten more minutes proving it.
    let escapedUnderworld = false;
    const leaveTheUnderworld = async () => {
      if (escapedUnderworld) return false;
      escapedUnderworld = true;
      log.push({ stumble: stumbles + 1, at: this.world.room?.name ?? null,
                 reason: 'died on the way — the Underworld has no exits in the graph',
                 note: 'escaping before re-planning' });
      const out = await this.escapeUnderworld?.({ movementGeneration, controlToken })
        .catch(() => null);
      if (out?.left) return true;
      const skills = await import('./m59-skills.mjs').catch(() => null);
      const r = await skills?.escapeUnderworld?.(this, {}).catch(() => null);
      return !!r?.left;
    };

    // BLEED SLOWLY ENOUGH AND ANY ROAD KILLS YOU. STOP AT A WALL AND HEAL.
    //
    // The operator's reading of the deaths, and it is a better model than the one I had:
    // what kills a traveller is not which room it crossed but how long it was out there
    // while hurt and never stopping. A slow trip that never heals arrives dead on a road a
    // fast one walks safely.
    //
    // A safe wall IS the coarse grid and the BSP disagreeing — the fleet's own book measures
    // 44% of held squares at such a disagreement against 24% of ordinary floor — and the
    // whole point of one is that a monster cannot reach you there. So mid-journey recovery
    // is not a detour into safety, it is a step to the nearest square the room already
    // offers, and then sitting until whole.
    //
    // Between hops, because that is where a journey has a choice: crossing a room is
    // committed, arriving somewhere new is the moment to look at the health bar. Doctrine
    // still holds — a planned trip completes as fast as possible while being attacked and
    // does not stop to FIGHT. This does not fight; it stands where nothing can swing.
    const healBelow = Number(process.env.M59_TRAVEL_HEAL_BELOW || 0.7);
    const healToward = Number(process.env.M59_TRAVEL_HEAL_TO || 0.95);
    const healMs = Number(process.env.M59_TRAVEL_HEAL_MS || 90000);
    let healed = 0;
    const healAtAWall = async () => {
      const c = this.need();
      const v = c.vitals?.() ?? {};
      const hp = v.health?.value ?? v.health, max = v.health?.max ?? v.maxHealth;
      if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return false;
      if (hp / max >= healBelow) return false;
      const geo = this.world?.geometry;
      const me = c.self;
      if (!geo?.collisionReady || !me) return false;
      // The nearest square the room offers where a body cannot be reached. Null is a
      // perfectly ordinary answer — plenty of rooms have none — and it means carry on.
      let spot = null;
      try {
        spot = nearestSafeSpot(geo, { row: me.row, col: me.col },
                               { within: 14, room: Number(this.world?.room?.num) || null });
      } catch { spot = null; }
      if (!spot) return false;
      const walked = await this.walkTo(spot.col, spot.row,
        { maxSteps: 40, movementGeneration, controlToken }).catch(() => null);
      if (walked?.left_room) return false;
      log.push({ healing_at: { row: spot.row, col: spot.col },
                 room: this.world?.room?.name ?? null, from: Math.round(100 * hp / max) + '%' });
      await this.pacer.submit('rest', () => c.rest()).catch(() => null);
      const until = Date.now() + healMs;
      let last = hp, quiet = 0;
      while (Date.now() < until) {
        if (this.movementWasCancelled(movementGeneration, controlToken)) break;
        await new Promise(r => setTimeout(r, 3000));
        const now = c.vitals?.()?.health?.value ?? c.vitals?.()?.health;
        if (!Number.isFinite(now)) break;
        if (now / max >= healToward) break;
        // FALLING means this is not shelter after all, and sitting still to be killed is
        // the opposite of the point.
        if (now < last) break;
        if (now === last && ++quiet >= 4) break;
        if (now > last) quiet = 0;
        last = now;
      }
      await this.pacer.submit('rest', () => c.stand()).catch(() => null);
      const after = c.vitals?.()?.health?.value ?? c.vitals?.()?.health;
      if (Number.isFinite(after) && after > hp) healed++;
      return true;
    };

    // THE ARRIVAL GUARD. ASK WHETHER WE ARE THERE BEFORE REPORTING THAT WE ARE NOT.
    //
    // The destination test lives at the TOP of the loop, so every early return between one
    // top and the next reports failure without ever asking where the body is standing. The
    // check after the loop was added for exactly this reason in the max-hops case — "a
    // journey whose final hop is also its last permitted hop leaves the loop standing in the
    // right room and reported gave up" — and the same hole is open on all six of the others:
    // no route, room not in the graph, no exit to the next hop, an unreachable door, a barred
    // room, and a crossing that landed somewhere else.
    //
    // Every one of those is REACHED FROM SOMEWHERE, and where a hop lands is not always
    // where it aimed — that is now a routine outcome rather than a surprise, since a boundary
    // carrying two exits puts a character in a neighbouring room without asking. Sometimes
    // the neighbour is the destination. A journey that has arrived is finished, whatever the
    // reason it was about to give for stopping.
    const arrivedIfHere = (fallback) => {
      const at = this.world?.room;
      if (at && Number(at.num) === Number(toRoomNum))
        return { arrived: true, room: { num: at.num, name: at.name },
                 hops, stumbles: totalStumbles, log,
                 note: 'arrived — noticed while giving up for another reason: ' +
                       (fallback?.reason ?? 'unstated') };
      return fallback;
    };

    const exhaustedRouteResult = (here, preferredHop = null) => {
      const exhaustedHere = [...exhaustedHops.entries()]
        .filter(([, detail]) => Number(detail.from) === Number(here?.num));
      if (!exhaustedHere.length) return null;
      const [blockedHop, blockedDetail] = exhaustedHere.find(([hop]) => hop === preferredHop)
        ?? exhaustedHere[0];
      const exhausted = exhaustedHere.map(([hop, detail]) => ({ hop, ...detail }));
      log.push({ outcome: 'route_progressing_exits_exhausted', room: here.num,
                 blocked_hop: blockedHop, exhausted_hops: exhausted,
                 note: 'the router has no untried route-progressing exit from this room' });
      return arrivedIfHere({
        arrived: false,
        outcome: 'route_progressing_exits_exhausted',
        reason: 'route_progressing_exits_exhausted',
        note: `the remaining route reuses ${blockedHop}, whose exit candidates ` +
              'were already exhausted in this journey',
        room: { num: here.num, name: here.name },
        destination: toRoomNum,
        blocked_hops: exhaustedHere.map(([hop]) => hop),
        exhausted_hops: exhausted,
        attempts: blockedDetail.attempts ?? null,
        refusals: blockedDetail.refusals ?? [],
        skipped: blockedDetail.skipped ?? [],
        hops, stumbles: totalStumbles, log,
      });
    };

    const stumble = async (why) => {
      // The Underworld is not a room to re-plan in; it is a room to leave.
      if (/no route from 1 to|The Underworld/i.test(String(why)) || Number(this.world?.room?.num) === 1) {
        if (await leaveTheUnderworld()) { stumbles = 0; return true; }
      }
      totalStumbles++;
      if (++stumbles > maxStumbles) return false;
      log.push({ stumble: stumbles, at: this.world.room?.name ?? null, reason: why,
                 note: 're-reading the room and re-planning from here' });
      await this.pacer.submit('read', () => this.client.roomContents()).catch(() => null);
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => null);
      return true;
    };

    while (hops < maxHops) {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      const here = this.world.room;
      // NOT A DEAD END — the coordinates have not settled yet. This is the same instant
      // that produces "start is outside the room grid", and it clears on its own.
      if (!here) {
        if (await stumble('current room is not in the graph')) continue;
        return arrivedIfHere({ arrived: false, log, reason: 'current room is not in the graph', stumbles: totalStumbles });
      }
      if (here.num === toRoomNum)
        return { arrived: true, room: { num: here.num, name: here.name }, hops, stumbles: totalStumbles, log };

      const route = this.world.route(toRoomNum, {
        avoid: this.barredRooms?.size ? new Set(this.barredRooms) : null,
        blockedHops: exhaustedHops.size ? new Set(exhaustedHops.keys()) : null,
      });
      if (!route.found) {
        const exhausted = exhaustedRouteResult(here);
        if (exhausted) return exhausted;
        // SAFE-WALL POCKET ESCAPE, FOR THE FIRST HOP. A character parked on a safe wall is
        // standing in one of the 17,402 collision pockets the router cannot plan out of to its
        // own room's exits — a safe wall IS the coarse grid and the BSP disagreeing (see the
        // breadcrumb note above and docs/m59-routing.md). `walkTo` already retreats along the
        // breadcrumbs when a FINE target is cut off, but travel's ROOM-level route fails here,
        // before any walkTo runs — so without this a character that hunted on a safe wall can
        // never set off for town: travel acks `started:true`, stumbles six times against the
        // pocket, and hands the body back to the keeper, which reads as "started then never
        // moved". Undo the moves that walked it onto the wall until the route reappears, then
        // re-plan from where that lands. Once per journey — undoing the trail twice unwinds the
        // journey rather than the pocket, the same bound `walkTo`'s own escape keeps.
        // `typeof` guard because `travel` is lifted out of this file by text and evaluated
        // against a minimal fake session in m59-travel-test; the fake has no breadcrumb retreat,
        // and in that case this must fall through to the ordinary stumble exactly as before.
        if (!pocketEscaped && typeof this.retreatAlongBreadcrumbs === 'function') {
          pocketEscaped = true;
          const escaped = await this.retreatAlongBreadcrumbs({
            movementGeneration, controlToken,
            until: () => this.world.route(toRoomNum, {
              avoid: this.barredRooms?.size ? new Set(this.barredRooms) : null,
              blockedHops: exhaustedHops.size ? new Set(exhaustedHops.keys()) : null,
            }).found,
          }).catch(() => null);
          if (escaped?.cancelled) return this.cancelledMovement({ log });
          if (escaped?.moved) {
            log.push({ pocket_escape: true, steps: escaped.steps,
                       note: 'retreated off a safe wall into the room\'s main region so the first hop could plan' });
            stumbles = 0;
            continue;   // re-plan from where the retreat landed
          }
        }
        // POCKET ESCAPE, PART TWO — walk to a square the room BODY reaches. The breadcrumb retreat
        // above only rescues a body that walked INTO the pocket seconds ago; a character parked and
        // fighting on a safe wall has breadcrumbs that are tiny in-place shuffles, so the retreat
        // returns moved:false and the route still cannot plan (from a pocket exits() reaches no
        // crossing square, availableFirstHops is empty, findPath skips every first hop). So leave
        // the pocket outright: walk to a from_body exit anchor — a square the bake proved the room's
        // MAIN body walks to — and standing on a go-anchor makes exits() offer that crossing at 0
        // steps, which is the first hop the pocket denied. Then re-plan. Once per journey. `typeof`
        // guard so the lifted-and-evaluated travel test falls straight through to the stumble.
        if (!mainRegionEscaped && typeof this.escapeToMainRegion === 'function') {
          mainRegionEscaped = true;
          const out = await this.escapeToMainRegion({ movementGeneration, controlToken }).catch(() => null);
          if (out?.cancelled) return this.cancelledMovement({ log });
          if (out?.moved) {
            log.push({ pocket_escape: 'main_region', to: out.target ?? null, steps: out.steps ?? null,
                       note: 'walked off a safe wall to a square the room body reaches so the first hop could plan' });
            stumbles = 0;
            continue;   // re-plan from where the escape landed
          }
        }
        // A route failure right after an arrival is the transient one. A route failure
        // that survives re-reading the room is real, and is reported as it always was.
        if (await stumble(route.reason || 'no route')) continue;
        return arrivedIfHere({ arrived: false, log, reason: route.reason || 'no route', stumbles: totalStumbles,
                 ...(this.barredRooms?.size ? { barred_rooms: [...this.barredRooms] } : {}) });
      }
      const nextHop = route.hops[0];

      // findPath deliberately relaxes a blocked hop when no strict route exists. That is
      // the right fail-open rule for an offline model; it is the wrong instruction for an
      // executor that has already watched this exact candidate set fail. Detect the relaxed
      // first hop before paying for the same room walk again and expose a stable result a
      // caller can act on.
      const nextHopKey = `${here.num}>${nextHop.to}`;
      if (exhaustedHops.has(nextHopKey)) return exhaustedRouteResult(here, nextHopKey);

      // A room often publishes SEVERAL squares for the same doorway — the Royal
      // Bank of Jasper lists two, and the first has a brazier standing on it.
      // Taking whichever came first in the file is a coin flip, so try them all.
      // MATCH ON THE DESTINATION, NOT ON THE KIND.
      //
      // Requiring e.kind === nextHop.kind threw away every working way out. Cor Noth
      // publishes THREE exits to room 574: one declared `edge`/west with
      // reachable:false and stand_on:null, and two more at row 1 — the north boundary —
      // both reachable with real squares. The route planner names the west one, the
      // kind filter then discarded the two that work, and the hop failed with "no floor
      // anywhere on the west boundary" about a room with two usable doors to that
      // destination. It stranded every donor in that town for hours, and read as a
      // sealed area rather than as a bad pick.
      //
      // A room's several ways to the same place are alternatives, not different
      // journeys. Take them all and let orderExits choose — it already prefers
      // reachable ones and then the nearest.
      let candidates = this.world.exits().filter(e => e.to === nextHop.to);
      // ...UNLESS THE DESTINATION HAS SIDES. See doorsLandingNear: when several doors lead
      // to the same room and that room is split, they are not alternatives, and picking by
      // distance arrives on the wrong island with the prey visible and unreachable. Only
      // consulted for the hop that actually ENTERS the destination, and only when the
      // caller said which side it wants.
      if (arriveNear && Number(nextHop.to) === Number(toRoomNum)) {
        const wanted = doorsLandingNear(this.world?.map, this.world?.room?.num,
                                        nextHop.to, arriveNear);
        const right = wanted
          ? candidates.filter(e => e.stand_on &&
              wanted.has(`${e.stand_on.col},${e.stand_on.row}`))
          : [];
        // Narrow only when something survives. An empty result means the map disagrees with
        // the published exits, and crossing by the wrong door beats not crossing at all.
        if (right.length) {
          log.push({ door_choice: 'landing side', to: nextHop.to, to_name: nextHop.to_name,
                     kept: right.length, of: candidates.length,
                     wants_to_reach: { col: arriveNear.col, row: arriveNear.row } });
          candidates = right;
        } else if (wanted) {
          log.push({ door_choice: 'no door lands on the wanted side', to: nextHop.to,
                     of: candidates.length,
                     note: 'crossing anyway by the ordinary ordering — a wrong side is ' +
                           'recoverable, a refused boundary is not' });
        }
      }
      const exit = orderExits(candidates)[0];
      if (!exit)
      {
        // The exit list is republished on arrival, so an exit that is missing right now is
        // usually one we asked about too early.
        if (await stumble('cannot find the exit to ' + nextHop.to_name + ' from here')) continue;
        return arrivedIfHere({ arrived: false, log, stumbles: totalStumbles,
                 reason: 'cannot find the exit to ' + nextHop.to_name + ' from here',
                 ...(this.barredRooms?.size ? { barred_rooms: [...this.barredRooms] } : {}) });
      }

      // Split so the record can say whether the time went on DECIDING or on DOING. Above
      // this line is routing and exit selection; below it is the walk. If the tail turns
      // out to be in the gap between them, the fix is in the planner, not the legs.
      const walkBegan = Date.now();
      const leavingRoom = Number(this.world?.room?.num ?? NaN);
      // THE MONORAIL FIRST, THE PLANNER SECOND.
      //
      // This hop is exactly what a track describes — a crossing of THIS room, in by the door
      // we came through and out by the one we want — so if somebody has already walked it,
      // walking it again is strictly better evidence than planning it afresh. It is tried
      // first and it is allowed to fail: `rode:false` costs nothing and falls straight
      // through to the ordinary exit walk below, which is the whole safety argument for
      // shipping a book whose keys mostly have one observation each.
      const ridden = await this.rideTrack(cameFromRoom, nextHop.to, { movementGeneration, controlToken })
        .catch(() => ({ rode: false, why: 'ride threw' }));
      if (ridden.left_room) {
        hops++; stumbles = 0;
        cameFromRoom = Number.isFinite(leavingRoom) ? leavingRoom : null;
        log.push({ from: this.world?.room?.name ?? String(nextHop.from), to: nextHop.to_name,
                   via: 'track', ok: true, ms: ridden.ms,
                   rode: { reached: ridden.reached ?? 0, blocked: ridden.blocked ?? 0 } });
        await this.settleAfterRoomChange?.().catch?.(() => {});
        continue;
      }
      const r = await this.leaveViaAny(candidates, { movementGeneration, controlToken });
      // QUEUE THE GAP ON `this`, AND LET SOMETHING ELSE FILE IT.
      //
      // Three methods in this chain are lifted out of this file by text and evaluated —
      // validateFineTarget and queueValidatedMove by m59-collision-test, and `travel`
      // itself by m59-travel-test — so a module-scope call here is a ReferenceError in a
      // test rather than a runtime error, which is the good kind of caught but only if
      // somebody runs it. Pushing onto `this` needs nothing but the object we already
      // have; drainExitGaps() does the writing from outside the lifted region.
      (this.pendingExitGaps ??= []).push({
        room: here?.num ?? null,
        direction: r?.gap?.direction ?? r?.used_exit?.direction ?? null,
        left: !!r.left, reason: r.reason ?? null, outcome: r.outcome ?? null,
        attempts: r.attempts ?? null,
        believed: r?.gap?.believed ?? null,
        stood_on: r.stood_on ?? null,
        tried: (r.tried ?? []).slice(0, 8).map(t => ({ ...(t.stand_on ?? {}),
          stage: t.stage ?? null, crossing_packet_sent: t.crossing_packet_sent ?? null,
          why: t.why })),
        skipped: (r.skipped ?? []).slice(0, 8),
      });
      // Never log an empty reason: a hop that fails without saying why is exactly the
      // silent failure this whole broker exists to avoid, so surface whatever stage
      // it got to.
      const why = (r.cancelled && r.cancelled_by
                    ? `movement cancelled by ${r.cancelled_by}`
                    : r.reason) || r.note ||
        (r.stage ? `failed while trying to ${r.stage}` +
                   (r.blocked_at ? ` (blocked at ${r.blocked_at.col},${r.blocked_at.row})` : '')
                 : 'no reason reported');
      // Log the square that actually worked, not the one we happened to try first —
      // otherwise a hop that succeeded on the second candidate reports the square
      // that refused.
      const inRoomMs = Date.now() - enteredAt;
      log.push({ from: here.name, to: nextHop.to_name, via: exit.kind, ok: r.left,
                 stand_on: (r.used_exit ?? exit).stand_on,
                 // On the hop log too, so a caller reading a travel result sees where the
                 // time went without having to go to the transit book for it.
                 ms: inRoomMs,
                 ...(r.tried?.length ? { also_tried: r.tried } : {}),
                 ...(r.left ? {} : { reason: why }) });
      // RECORDED WHETHER OR NOT IT WORKED, and the failures are the ones worth having:
      // a hop that spent two minutes being refused by ten exit squares in turn is the
      // shape this is looking for, and it is invisible in a journey-level timing.
      // ONE HOP, ONE ROW. The wrong-room check below used to write a SECOND transit record
      // for the same crossing, so every one of these appeared twice — once as a success,
      // because the room really did change, and once as the failure it actually was. Reading
      // the book back, "OK then FAIL at the same timestamp" is one event wearing two hats,
      // and it inflated every count taken from it since the check was added.
      const landedNow = Number(this.world?.room?.num ?? NaN);
      // A ROOM NUMBER READ ONCE IS NOT A ROOM YOU ARE IN.
      //
      // This check used to believe a single reading, and the reading blinks. From the
      // collision trace, the same shape every time and for both characters:
      //
      //     room 587 x 6      six steps of the baked line
      //     room 586 x 1      ONE move reads the Main gate
      //     room 587 x 6      back again, and the line starts over
      //
      // The body was at 14,62 walking to 15,61 — south-west, FIVE columns from the boundary
      // and heading away from it. Nothing there can enter the Main gate to the city of Tos,
      // and a character that had would be there for many moves and would have to walk back
      // across an edge to return. It never left the Western border of the Twisted Wood.
      //
      // So the wrong-room check was firing on a phantom, tearing down a crossing that was
      // working, and the rail restarted from the anchor each time. Every conclusion built on
      // "crossed into 586 instead of 597" — the hop bans, the reroute through the Outskirts,
      // the three fixes aimed at a drift — was chasing an instrument, not a bug.
      //
      // Confirmed before it is believed: read the room back and require it to still disagree.
      // A real crossing survives that; a blink does not.
      const wrongRoom = r.left && Number.isFinite(landedNow) && nextHop.to != null
        && landedNow !== Number(nextHop.to);
      // A SECOND READ WAS TRIED HERE AND DID NOT HELP: it confirmed the same room every time,
      // and cost a room-contents round trip plus up to 1500ms on every attempt — enough that
      // neither character reached The Twisted Wood at all in that run, where the one before it
      // had. Removed rather than kept "just in case", because an instrument that costs a
      // second and changes no answer is a slower way to be wrong.
      //
      // WHAT IS STILL UNEXPLAINED. The tracer shows six steps in 587 and then ONE move
      // reading 586, from a body at 14,62 walking to 15,61 — south-west, five columns from
      // the boundary. Nothing there can enter the Main gate. But `walkFine` does not go
      // through `traceMove` (only the two `queueValidatedMove` sites do), so the crossing may
      // be happening in a move the trace cannot see. That is the next thing to instrument,
      // and it should be instrumented before anything else is changed.
      this.noteTransit({
        room: here.num, roomName: here.name, to: nextHop.to, toName: nextHop.to_name,
        ms: inRoomMs, walkMs: Date.now() - walkBegan, ok: r.left && !wrongRoom,
        ...(wrongRoom ? { landed_in: landedNow } : {}),
        // The one that worked plus the ones that did not. Above 1 means squares are being
        // refused, which is the suspicion this exists to confirm or kill.
        tried: r.attempts ?? ((r.tried?.length ?? 0) + 1),
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.skipped?.length ? { skipped: r.skipped } : {}),
        // WHAT EACH SQUARE ACTUALLY SAID, AND NOT JUST HOW MANY THERE WERE.
        //
        // `leaveViaAny` computes a `why` per candidate square and this line dropped all of
        // them on the floor, keeping the count. So the transit book has been recording
        //
        //     to 598  every square for that exit refused (4 tried)   56.2s
        //
        // over and over — six times in one leg, four hundred and fifty seconds — and the
        // record could not say whether those four squares were blocked by a body, refused by
        // collision, unreachable from where the character stood, or never walked to at all.
        // Four different bugs, one sentence, and no way to tell them apart after the fact.
        // SERIALIZED CONTRACT: travel-ledger `refusals[].square` is a legacy
        // `"row,col"` string. Do not transpose or relabel the stored value.
        ...(r.tried?.length ? { refusals: r.tried.slice(0, 8).map(t => ({
              square: t.stand_on ? `${t.stand_on.row},${t.stand_on.col}` : null,
              stage: t.stage ?? null,
              crossing_packet_sent: t.crossing_packet_sent ?? null,
              why: String(t.why ?? t.reason ?? '?').slice(0, 90),
            })) } : {}),
        // The best square the model could offer, so a refusal can be set against the square
        // a character is standing on when the same door works. See m59-exitgap.mjs.
        ...(r.gap?.believed ? { believed: r.gap.believed } : {}),
        // THE UNDERWORLD IS A DEATH, NOT A DOORWAY — AND THIS ROW DID NOT KNOW THAT.
        // The hop loop already special-cases room 1; this row was computed separately and
        // had no such case, so every death mid-hop was recorded as a wrong doorway — a
        // sentence about geometry describing a character being killed.
        reason: wrongRoom
          ? (landedNow === 1
              ? `died on the way to ${nextHop.to} — this is the Underworld, not a wrong doorway`
              : `crossed into ${landedNow} instead of ${nextHop.to} — that boundary carries more than one exit`)
          : (r.left ? null : why),
        journey: journeyId, hop: hops, destination: toRoomNum,
      });
      // A REFUSED DOORWAY IS THE ORDINARY CASE, NOT THE END OF THE JOURNEY. leaveViaAny has
      // already spent its bounded candidate budget for that destination; re-settling and
      // re-planning is what turns the second attempt into the one that works.
      if (!r.left) {
        // CANCELLATION OUTRANKS EVIDENCE FROM AN EARLIER CANDIDATE IN THE SAME BATCH.
        // `leaveViaAny` keeps `tried` when a newer command interrupts it. One candidate may
        // therefore contain a real guardian refusal even though the batch's final outcome
        // is cancellation. That history must not turn a survival command into a room ban.
        if (r.cancelled) return this.cancelledMovement({ log });
        // A DOOR THAT WILL NEVER OPEN FOR THIS CHARACTER IS NOT A STICKY DOORWAY, AND
        // RETRYING IT IS THE WHOLE FAILURE.
        //
        // `Player.CanEnterRoom` (player.kod, resource `player_no_enter`) refuses a
        // GuildHall outright to anyone without PFLAG_PKILL_ENABLE:
        //
        //   if IsClass(oRoom,&GuildHall) AND NOT CheckPlayerFlag(PFLAG_PKILL_ENABLE)
        //      MsgSendUser(player_no_enter); return FALSE;
        //
        // That is a property of the character, not of the moment, so re-settling and
        // asking again gets the identical refusal for ever. Measured on the arena fleet:
        // Delta spent two full attempts and 43 seconds being told this by The Old Dwarven
        // Hall, with a baby spider chewing on it throughout, and the journey then failed
        // with the hall still on the only route it would consider.
        //
        // So the refusal TEACHES THE ROUTER instead of being retried. The room goes into a
        // per-session barred set, the next plan routes around it, and the patience is not
        // spent — this is new information, which is exactly the case the stumble budget
        // should not be charged for.
        //
        // SESSION-SCOPED, because the answer is per character: a guildmate walks into the
        // same hall freely, and PK-enable arrives on its own at base max health 30. It is
        // a PREFERENCE in the router, so a barred room that is the ONLY way somewhere is
        // still attempted and still fails honestly, rather than the journey silently
        // becoming impossible.
        // AND THE OTHER HALF: THE DOOR WE CANNOT REACH FROM THIS SIDE OF THE ROOM.
        //
        // `findPath` plans over ROOMS, so a hop A -> B -> C assumes B can be crossed from
        // the door A left you at to the door C wants. Frequently it cannot. West Merchant
        // Way is the measured case: entering from Marion at 20,1 or 24,1, the exit to Deep
        // Forest of Farol at 49,70 is UNREACHABLE — the only route between them needs a
        // 1280-unit climb in one step against a limit of 384, so it is not a modelling
        // artifact, it is a wall of rock. The room graph says 545 connects to 556 and it
        // does; it just does not connect to it FROM HERE.
        //
        // The route planner already accepts exact directed `blockedHops`. Record the one
        // candidate set the executor watched fail, then replan. If no strict alternative
        // exists, findPath's permissive pass returns that same hop and the guard above stops
        // with a stable result before a second full boundary walk.
        //
        // JOURNEY-SCOPED, NOT SESSION-SCOPED, and that is the difference from the bar
        // above. "This character may never enter a guild hall" is true tomorrow; "I cannot
        // reach that door from where I am standing" stops being true the moment it stands
        // somewhere else, and a session-long memory of it would delete good doors from the
        // map for ever.
        // A SERVER ACCESS BAR OUTRANKS THE GENERIC CANDIDATE AGGREGATE. `leaveViaAny`
        // attaches `exit_candidates_exhausted` after trying a barred doorway too, but a
        // guardian-angel refusal is character/session policy, not evidence about this
        // approach or hop. Preserve the long-standing room-level avoidance for an
        // intermediate hall; the destination exception remains an honest failure below.
        // `leaveViaAny` reports its aggregate reason at the top level, so the useful
        // server refusal can live only on the individual candidate that reached the
        // crossing. Do not let that evidence disappear behind generic exhaustion prose.
        const barredWhy = BARRED_ON_ENTRY.test(why) ? why :
          (r.tried ?? []).map(t => t?.why ?? t?.reason ?? t?.note ?? '')
            .find(candidateWhy => BARRED_ON_ENTRY.test(String(candidateWhy)));
        if (barredWhy && nextHop.to != null && Number(nextHop.to) !== Number(toRoomNum)) {
          (this.barredRooms ??= new Set()).add(Number(nextHop.to));
          log.push({ barred: nextHop.to, name: nextHop.to_name, reason: barredWhy,
                     note: 'the server refuses this character entry, so it is off the map ' +
                           'for this session and the route is being replanned around it' });
          continue;
        }
        if (barredWhy && nextHop.to != null && Number(nextHop.to) === Number(toRoomNum)) {
          return arrivedIfHere({ arrived: false, log, reason: barredWhy,
                   ...(r.attempts != null ? { attempts: r.attempts } : {}),
                   ...(r.tried?.length ? { refusals: r.tried } : {}),
                   ...(r.skipped?.length ? { skipped: r.skipped } : {}),
                   stumbles: totalStumbles,
                   ...(this.barredRooms?.size ? { barred_rooms: [...this.barredRooms] } : {}) });
        }
        // Only the structured aggregate proves that the bounded candidate budget was attempted.
        // Prose such as "no floor" can describe one transient walk and must keep the ordinary
        // stumble/retry behaviour below.
        const candidatesExhausted = r.outcome === 'exit_candidates_exhausted';
        if (candidatesExhausted && nextHop.to != null && !exhaustedHops.has(nextHopKey)) {
          exhaustedHops.set(nextHopKey, {
            from: here.num, to: Number(nextHop.to), to_name: nextHop.to_name,
            reason: why, outcome: r.outcome ?? 'legacy_unreachable_exit',
            attempts: r.attempts ?? null,
            refusals: r.tried ?? [], skipped: r.skipped ?? [],
          });
          log.push({ unreachable_exit: nextHop.to, blocked_hop: nextHopKey,
                     name: nextHop.to_name, reason: why,
                     note: 'that exact route-progressing exit is exhausted for this journey — ' +
                           'replanning without it' });
          if (await stumble(why)) continue;
          return arrivedIfHere({ arrived: false, log, reason: why,
                   outcome: r.outcome ?? 'exit_candidates_exhausted',
                   attempts: r.attempts ?? null, refusals: r.tried ?? [], skipped: r.skipped ?? [],
                   blocked_hops: [...exhaustedHops.keys()], stumbles: totalStumbles });
        }
        if (await stumble(why)) continue;
        return arrivedIfHere({ arrived: false, log, reason: why,
                 ...(r.outcome ? { outcome: r.outcome } : {}),
                 ...(r.attempts != null ? { attempts: r.attempts } : {}),
                 ...(r.tried?.length ? { refusals: r.tried } : {}),
                 ...(r.skipped?.length ? { skipped: r.skipped } : {}),
                 stumbles: totalStumbles,
                 ...(this.barredRooms?.size ? { barred_rooms: [...this.barredRooms] } : {}) });
      }
      // A ROOM CHANGE IS NOT THE ROOM WE ASKED FOR.
      //
      // Every success path in `leaveVia` confirms a crossing with `c.room.id !== edgeStartRoom`
      // — that the room CHANGED — and none of them asks which room it changed to. On a
      // boundary carrying more than one exit that is not the same question, and the Western
      // border of the Twisted Wood is exactly that shape: its east edge leads to 586 at row 9
      // and to 597 at row 46, so walking south along col 67 to reach the second one runs ALONG
      // the first. Drift across it and the room changes, the check passes, and the crossing to
      // 597 is reported as having worked.
      //
      // Measured: Aaaa recorded `587 -> 597 OK` TEN TIMES IN A ROW, and every hop after each
      // one started from 587 again. The collision tracer never saw room 597 at all in that
      // run — 50, 52, 586 and 587, nothing else. The character never went there once.
      //
      // The cost is not just a wrong line in a book. Each false success spends a hop out of
      // `max_hops`, resets the stumble budget that would otherwise have forced a replan, and
      // leaves `remaining` where it was — which is the "hops climbing while remaining stands
      // still" signature that made a journey look like it was progressing while it walked in
      // a circle until the leg timed out.
      //
      // Being somewhere unplanned is not a failure to recover from: the loop re-reads the room
      // at the top and plans again from wherever the body actually is. It just must not be
      // counted as the hop that was asked for.
      const landedIn = Number(this.world?.room?.num ?? NaN);
      if (Number.isFinite(landedIn) && nextHop.to != null && landedIn !== Number(nextHop.to)) {
        // THE UNDERWORLD IS A DEATH, NOT A DOORWAY.
        //
        // Every other way of ending up somewhere unplanned is a boundary that carries more
        // than one exit. This one is the character having died on the way, and it read
        // `crossed into 1 instead of 599 — that boundary carries more than one exit`, which
        // is a sentence that would send the next person looking at Ukgoth's geometry for a
        // shared edge that does not exist. Room 1 is where the game puts the dead.
        //
        // Not learned as a bad hop either: the crossing is not what was wrong with it, and
        // barring the last door a character walked through before dying would take a good
        // route off the map for the rest of the journey.
        const died = landedIn === 1;
        const wrong = died
          ? `died on the way to ${nextHop.to} — this is the Underworld, not a wrong doorway`
          : `crossed into ${landedIn} instead of ${nextHop.to} — confirmed by a second read`;
        // NOT RECORDED AGAIN — the single transit row above already carries this, with the
        // room we actually landed in beside it.
        log.push({ from: here.name, to: nextHop.to_name, via: exit.kind, ok: false, reason: wrong });
        // LEARNED AS A HOP, so the replan below routes around it instead of trying it again.
        //
        // Not the room: 587 is perfectly crossable in other directions and 597 is somewhere
        // the journey still has to reach. It is this one crossing that does not work, and
        // there is another way to the same place — 586 -> 596 -> 597 — of the same length.
        // Journey-scoped, like the unreachable-door bar below and for the same reason: this
        // is a fact about where the body happens to be standing, not about the map.
        // NOT LEARNED AS A BAD HOP. THIS IS A MOVEMENT BUG WEARING A ROUTING BUG'S CLOTHES.
        //
        // The operator said so before the evidence did: "I'm pretty sure this journey doesn't
        // have any false routes and whatever we're badHopping here is a bug in our code." He
        // was right, and banning the hop turned one bad crossing into a cascade.
        //
        // Measured in a single leg, ten wrong-room crossings banned SIX GOOD HOPS:
        //
        //   586->585   50->61   587->576   587->597   586->596   586->50
        //
        // That is the first hop of a perfectly good route out of Tos, the way BACK to Tos,
        // and both ways onward from the Main gate. With those gone the router had almost
        // nothing left and set off for the border of the Badlands, which is not on the way to
        // anywhere it was going. Hops that had taken 20 seconds started taking 400.
        //
        // Every one of these edges is real and the crossing is walkable. What fails is that
        // the body drifts over a boundary whose exit is chosen BY ROW, so it fires the
        // neighbour's door instead of ours. The answer to that is to stop drifting, not to
        // delete the door: the loop already re-reads the room and plans again from wherever
        // the body actually is, which is all the recovery this needs.
        if (!died) {
          log.push({ wrong_room: `${here.num}>${nextHop.to}`, landed_in: landedIn, reason: wrong,
                     note: 'the crossing fired a neighbouring exit — replanning from where we ' +
                           'actually are. NOT barred: the hop is good, the drift is the bug' });
        } else {
          log.push({ died_in_transit: `${here.num}>${nextHop.to}`, reason: wrong,
                     note: 'the Underworld is where the dead go, not somewhere this hop led' });
        }
        // A stumble rather than a hop: the body moved, so the patience for THIS room is spent,
        // but the plan it was following is void and the next pass builds a new one from here.
        if (await stumble(wrong)) continue;
        return arrivedIfHere({ arrived: false, log, reason: wrong, stumbles: totalStumbles });
      }
      hops++;
      stumbles = 0;                      // it moved; the patience is for the NEXT sticky room
      // AND GET OFF THE DOORWAY BEFORE DOING ANYTHING ELSE. See stepInland: a crossing lands
      // on the far room's boundary, and the next movement from there is one square from
      // leaving again — sometimes into a different room than the one we came from.
      // Guarded: `travel` is lifted out of this file by text and evaluated against a fake
      // session elsewhere, and a bare call there is a TypeError rather than a no-op.
      if (typeof this.stepInland === 'function') await this.stepInland().catch(() => false);
      cameFromRoom = Number.isFinite(leavingRoom) ? leavingRoom : null;
      await healAtAWall().catch(() => false);

      // Arriving brings a fresh BP_PLAYER, and with it the identity the world model
      // needs; give the room contents a moment to land as well.
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      await this.pacer.submit('read', () => this.client.roomContents());
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });

      // THE PAUSE POINT. One per room, with the room already visible.
      //
      // A p90 journey is ten of these, so this is the difference between one 87-second
      // await nothing can reach into and ten 9-second ones with a decision between each.
      // Whatever it does, we carry on afterwards — see the note on `onHop` above for why
      // stopping in the middle is not the safer option it looks like.
      //
      // It cannot break the journey by throwing, either. A hook that fails is a hook with
      // a bug in it, and a character halfway between two towns is the worst possible place
      // to discover one; the failure is logged against the hop and the walk continues.
      if (onHop) {
        const room = this.world.room;
        try {
          await onHop({
            room: room ? { num: room.num, name: room.name } : null,
            hop: hops, hops_done: hops, destination: toRoomNum,
            remaining: Math.max(0, (this.world.route(toRoomNum)?.hops?.length ?? 0)),
            journey: journeyId,
          });
        } catch (e) {
          log.push({ from: room?.name ?? null, onhop_failed: e.message,
                     note: 'the between-rooms hook threw; the journey carried on regardless' });
        }
        // The hook can take minutes — holding a wall until health comes back is the whole
        // point of it — so re-check cancellation before committing to another room rather
        // than trusting the check at the top of the next iteration to be soon enough.
        if (this.movementWasCancelled(movementGeneration, controlToken))
          return this.cancelledMovement({ log });
      }

      // The next room's clock starts once we have actually landed and can see. The settle
      // above is charged to arriving, not to the room we just left — otherwise every
      // room's time would carry the previous one's tail and the worst room would always
      // look like whichever came after the real problem.
      //
      // AND AFTER THE HOOK, not before it: a hold at a wall is time spent in the room we
      // are standing in, but it is not time the ROUTE cost, and charging it to the room
      // would make every room a character rested in look like the slowest map in the game.
      enteredAt = Date.now();
    }
    // CHECK ARRIVAL ONE LAST TIME. The destination test lives at the TOP of the loop, so a
    // journey whose final hop is also its last permitted hop leaves the loop standing in
    // the right room and reported "gave up" — the one failure mode that is both wrong and
    // reassuringly plausible, since the hop count really had been spent.
    const finally_ = this.world.room;
    if (finally_ && finally_.num === toRoomNum)
      return { arrived: true, room: { num: finally_.num, name: finally_.name },
               hops, stumbles: totalStumbles, log };
    return arrivedIfHere({ arrived: false, log, stumbles: totalStumbles,
             reason: 'gave up after ' + maxHops + ' hops' });
  }
}

export { Session, Recorder, Pacer, readAbilitiesOnce, loadMonsterLevels, monsterKarmaByName, monsterLevelByName, arrivalReport, orderExits, geometryStartupMode };
