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

import { sessionWalkPrototype } from './m59-session-walk.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { bindPacketScope } from './m59-packet-scope.mjs';
import { withBodyCommand, bodyAuthority } from './m59-body-command.mjs';
import { CombatMode } from './m59-combat-mode.mjs';
import { groundEffectOnSegment, groundEffectSquares } from './m59-ground-effects.mjs';
import { traceSurvival } from './m59-survival-trace.mjs';
import { cancelSurvivalDecision, observeSurvivalDecision, currentSurvivalDecision,
  finishSurvivalDecision } from './m59-survival-decision.mjs';
import {saleBlocked} from './m59-inventory-intent.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { M59Client, KOD_FINENESS, BPNAME, BP } from './m59-client.mjs';
import { loadResources } from './m59-rsc.mjs';
import { describeObject, affordances, OF, blocksMovement, prepareActTarget, readHealth,
         dropSpec } from './m59-parse.mjs';
import { planPickup, normalizeOverfarm, unitCost } from './m59-overfarm.mjs';
import { World, spreadEdges, distinctStagesFirst, boundedSilentGo, boundedRegionEntry,
         doorSettleMs, remainingDoorSettle , sameRoomDoorPlan} from './m59-world.mjs';
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
// Write-only, and safe to import anywhere: the ledger pulls in no keeper and no hook loader
// at module scope — `attachHooks` is wired by whoever actually loads hooks. See m59-ledger.mjs.
import { recordEvent } from './m59-ledger.mjs';
import * as descriptions from './m59-describe.mjs';
import { RemainingRequiredToLearnNewSkills, PointsToNextLevelOfTarget } from '../compendium/tools/learn.mjs';
import { StorageCache } from './m59-storage.mjs';
import { Recorder } from './m59-recorder.mjs';
import {attachPlayerEvidence} from './m59-player-evidence-store.mjs';

// ── IMPORTS THE PORTED SESSION NEEDS ────────────────────────────────────────────
//
// Upstream's Session grew these while it still lived in m59-broker.mjs, so they were in
// that file's module scope and needed no import. Moving the class here leaves them FREE
// IDENTIFIERS -- which do not fail at load, only when the branch that uses them runs.
// That is exactly how `joinSessionOnce` sat broken in Session.join() until the first
// outside caller found it. Named explicitly so the next move of this class fails loudly.
import { spawn } from 'node:child_process';
import { clientToProtocol } from './m59-roo.mjs';
import { fineRouteDetour, pullFine, pointOfSquare } from './m59-finepath.mjs';
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
import { tripStopPhrase } from './m59-trip-telemetry.mjs';
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
    // NULL IS AN ANSWER AND ZERO IS A LIE. A keeper snapshot carries no tactical exits --
    // `keeperView` sets `exits: []` unconditionally, because they need the live World that
    // lives in the keeper process -- so this line reported `0` for EVERY keeper-backed
    // character, which is every character in a running fleet. West Jasper declares thirty-five
    // ways out. `null` plus a note naming the instruments that CAN answer is the honest shape.
    exits: v.exits_unknown ? null : v.exits.length,
    ...(v.exits_unknown ? { exits_note: v.exits_note ?? 'not measurable from a snapshot' } : {}),
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

// THE DOOR WHOSE LANDING CAN STILL REACH THE NEXT HOP. The same question as
// `doorsLandingNear`, asked one hop further ahead, and the reason a through-route stopped
// stranding characters in Blackstone.
//
// WHY THE BACKTRACK MEMORY WAS NOT ENOUGH. `enteredVia` was added for this same trap, but it
// only fires when the hop goes back to the room we most recently came from — a BACKTRACK.
// The fleet's actual pattern is a through-route: Feast Hall 953 -> Keep 951 -> Courtyard 950
// -> home 39. Entering 951 from 953 and then wanting 950, the next room is not the one we
// came from, so the memory never applied, `orderExits` fell back to reachable-then-nearest,
// the south-east door was nearest, and it lands in a watch tower — a pocket of 950 with no
// floor connection to the main yard. Measured 2026-09-05: 950>39 and 951>39 both sat at
// 0-7% arrival while the character stood in a tower re-planning for ever.
//
// THE QUESTION IS NOT "WHICH DOOR IS NEAREST" BUT "WHICH LANDING CAN CONTINUE". When the
// route is A -> B -> C, a door out of A is only useful if the square it lands on in B can
// walk to a door of B that leads to C. That is exactly `doorsLandingNear` with the onward
// door as the target instead of the caller's final wish.
//
// B may publish several doors to C, so every one is asked and the answers unioned: a landing
// that reaches ANY way onward is a landing that works. Null means no opinion and the caller
// must leave the ordering alone — narrowing to nothing would refuse a boundary a wrong door
// could still have crossed, and a wrong side is recoverable where a refusal is not.
// COST IS THE WHOLE DESIGN HERE, not an afterthought. `doorsLandingNear` is one fine-grid
// `path()` per candidate door, and a path that FAILS explores the entire component — which is
// the common case, because the question is precisely about doors that do not connect. Naively
// this is |A->B| x |B->C| pathfinds: measured 100-400ms on real triples, 97% of them returning
// no opinion at all.
//
// That is not merely slow, it is the documented way this fleet dies. Every keeper shares ONE
// event loop and all geometry is synchronous (m59-broker.mjs:15148) — "while one character is
// planning, the other twenty get no timer service" — and a 1.2s cold path once "took twelve of
// twenty-one characters out of the world in five minutes" (m59-broker.mjs:618). A hot-path
// helper that blocks for 150ms on an ordinary journey is a fleet outage waiting for traffic.
//
// So two guards, in this order, and the cheap one first:
//
//   1. IDENTICAL LANDINGS ANSWER THEMSELVES, FOR FREE. If every A->B door arrives on the same
//      square then either all of them reach the onward door or none do, and `doorsLandingNear`
//      returns null for both. That is 83% of the triples this router can produce, decided by
//      comparing two integers instead of running a pathfind.
//   2. MEMOISE THE REST. Doors, geometry and step masks are fixed for a bake, so the answer
//      for (A,B,C) cannot change while it holds. The lock states ARE mutable — a door that
//      opens has to change the router's mind — so they go in the key rather than being
//      assumed, which costs a string and keeps the cache honest.
//
// MEASURED over all 1,293 triples this router can produce, with masks attached:
//
//   cold (first ask for a triple)   mean 2.81ms, worst 306ms, 25 asks over 40ms
//   warm (every ask after)          1ms TOTAL for all 1,293 — 0.001ms each
//   asks that narrow anything       35 of 1,293
//
// THE RESIDUAL RISK, STATED PLAINLY: the worst first-ask still blocks the shared loop for
// ~300ms, once, on a big room. That is paid once per triple for the life of the process and
// never again, against a failure mode where characters stand in a pocket until another
// player kills them. It is the right trade but it is not free, and if a cold stall is ever
// implicated in a fleet incident, this is the line to come back to.
const _onwardMemo = new Map();

function doorsLandingOnward(map, fromRoomNum, viaRoomNum, ontoRoomNum) {
  if (ontoRoomNum == null) return null;
  const via = map?.rooms?.[viaRoomNum];
  const from = map?.rooms?.[fromRoomNum];
  if (!via || !from) return null;

  const onward = (via.goExits || []).filter(g =>
    !g.locked && Number(g.to) === Number(ontoRoomNum) &&
    Number.isFinite(Number(g.col)) && Number.isFinite(Number(g.row)));
  if (!onward.length) return null;

  const inbound = (from.goExits || []).filter(g =>
    !g.locked && Number(g.to) === Number(viaRoomNum) &&
    g.arriveRow != null && g.arriveCol != null);
  if (inbound.length < 2) return null;   // nothing to choose between

  // GUARD 1 — free. One landing square means one answer for every door.
  const landings = new Set(inbound.map(g => `${g.arriveCol},${g.arriveRow}`));
  if (landings.size < 2) return null;

  // GUARD 2 — memo. Lock state is in the key because it is the one input that moves.
  const locks = `${inbound.length}:${landings.size}:${onward.length}`;
  const key = `${fromRoomNum}>${viaRoomNum}>${ontoRoomNum}|${locks}`;
  if (_onwardMemo.has(key)) return _onwardMemo.get(key);

  const union = new Set();
  let answered = false;
  for (const g of onward) {
    const ok = doorsLandingNear(map, fromRoomNum, viaRoomNum, { col: g.col, row: g.row });
    if (ok === null) continue;          // no opinion about this particular onward door
    answered = true;
    for (const k of ok) union.add(k);
  }
  const answer = answered && union.size ? union : null;
  _onwardMemo.set(key, answer);
  return answer;
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

// WHAT MAY STILL BE SENT WHILE A SPELL IS CHARGING. An ALLOW list, not a deny list, and the
// polarity is the point: kod breaks a trance on EVENT_RUN, EVENT_REST, EVENT_USE,
// EVENT_ATTACK, EVENT_CAST, EVENT_DAMAGE and EVENT_NEWOWNER, and EVENT_USE alone is raised
// by using, eating, reading, buying, selling, banking and half a dozen other things that do
// not look alike from here. A deny list has to name all of them and is wrong the day somebody
// adds a packet kind; this is wrong only for kinds that are genuinely harmless, which fail
// safe by being suppressed for a few seconds.
//
// These five are speech and observation. They send no action the server can treat as the
// caster doing something, so they neither break the trance nor need to wait for it.
//
// `cast` is allowed for one reason only: the cast that OPENED the hold has to reach the
// wire. A second cast arriving mid-trance genuinely does break the first (EVENT_CAST), and
// that is correct behaviour rather than something to suppress — the caller changed its mind.
const CONCENTRATION_SAFE = new Set(['say', 'look', 'describe', 'safety', 'guild', 'cast']);

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

  // ---------------------------------------------------------------------------
  // CONCENTRATION -- the one door, held shut, for exactly as long as a cast charges
  // ---------------------------------------------------------------------------
  //
  // A spell with `viCast_time` puts the caster in a TRANCE (trance.kod). The mana and the
  // reagents are taken up front and then the caster must do nothing at all until it ends:
  // EVENT_RUN, EVENT_REST, EVENT_USE, EVENT_ATTACK, EVENT_CAST, EVENT_DAMAGE and
  // EVENT_NEWOWNER each break it, half the mana is refunded, the reagents are not, and the
  // spell does nothing. `enchant weapon` charges for THIRTY SECONDS.
  //
  // WHY IT IS HERE AND NOT IN THE REST PATH. It was tried there first, and the trance still
  // broke: a keeper sits down from several places, and the tick loop's own move/turn packets
  // at 10Hz break it too. Every one of those reaches the wire through `submit`, so this is
  // the only place where "hold perfectly still" can be said once and be true. Same argument
  // as the menagerie guard's single `callTool` door.
  //
  // IT DROPS RATHER THAN QUEUES, and only the kinds that actually break concentration. A
  // queued move fires the instant the hold lifts, which is a move decided thirty seconds ago
  // by a tick that has long since been superseded. Dropping is also visible: `heldDropped`
  // counts what was suppressed and by kind, so a hold that misbehaves shows up as a number
  // rather than as a character that mysteriously stopped moving.
  holdForCast(ms, reason = 'casting') {
    // BOUNDED, ALWAYS. A hold that outlives its cast is a deaf character, so it can never be
    // open-ended: the longest trance in the game is 30s and this allows double that.
    const capped = Math.max(0, Math.min(Number(ms) || 0, 60_000));
    this.holdUntil = Date.now() + capped;
    this.holdReason = reason;
    return this.holdUntil;
  }

  releaseCastHold() { this.holdUntil = 0; this.holdReason = null; }

  /** Is concentration being held right now, and what has it suppressed? */
  holdStatus() {
    const active = !!this.holdUntil && Date.now() < this.holdUntil;
    return { active, reason: active ? this.holdReason : null,
             ms_left: active ? this.holdUntil - Date.now() : 0,
             dropped: Object.fromEntries(this.heldDropped ?? []) };
  }

  static CONCENTRATION_SAFE = CONCENTRATION_SAFE;

  submit(kind, fn, minGapForKind = 0) {
    const authority = this.authority?.();
    // Concentration first: a packet sent during a casting trance breaks it.
    if (this.holdUntil) {
      if (Date.now() >= this.holdUntil) { this.holdUntil = 0; this.holdReason = null; }
      else if (!Pacer.CONCENTRATION_SAFE.has(kind)) {
        this.heldDropped = this.heldDropped ?? new Map();
        this.heldDropped.set(kind, (this.heldDropped.get(kind) ?? 0) + 1);
        return Promise.resolve({ held: true, kind, reason: this.holdReason,
                                 ms_left: this.holdUntil - Date.now() });
      }
    }
    this.prodTimes.push(Date.now());
    if (!this.prodByKind.has(kind)) this.prodByKind.set(kind, []);
    this.prodByKind.get(kind).push(Date.now());
    const job = { kind, fn: bindPacketScope(kind, authority?.bind ? authority.bind(fn) : fn), minGapForKind,
                  guard: authority?.guard, priority: authority?.priority ?? 0,
                  resolve: null, reject: null, queuedAt: Date.now() };
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
      this.wake?.();
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
        // Drop invalidated packets before they spend a pacing slot. A sleeping
        // low-priority packet must not hold up a newly arrived combat command.
        this.q = this.q.filter(job => {
          try { job.guard?.(); return true; }
          catch (e) { job.reject(e); return false; }
        });
        if (!this.q.length) break;
        this.q.sort((a, b) => b.priority - a.priority);
        const job = this.q[0];
        const now = Date.now();
        const waitGlobal = Math.max(0, this.lastSent + this.minGapMs - now);
        const lastKind = this.lastByKind.get(job.kind) || 0;
        const waitKind = job.kind === 'move' && job.minGapForKind === DOOR_SETTLE_MS
          ? remainingDoorSettle({ lastMovementAt: lastKind, now, settleMs: job.minGapForKind })
          : Math.max(0, lastKind + job.minGapForKind - now);
        const wait = Math.max(waitGlobal, waitKind);
        Pacer.note(job.kind, 'queued', Math.max(0, now - job.queuedAt));
        Pacer.note(job.kind, waitKind >= waitGlobal ? 'paced' : 'throttled', wait);
        if (wait > 0) {
          await new Promise(resolve => {
            const timer = setTimeout(done, wait);
            const pacer = this;
            function done() { clearTimeout(timer); pacer.wake = null; resolve(); }
            this.wake = done;
          });
          continue;
        }
        await new Promise(r => setImmediate(r));
        if (this.q[0] !== job) continue;
        this.q.shift();
        try { job.guard?.(); } catch (e) { job.reject(e); continue; }
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
  const memoKey = `${from.row},${from.col}|${from.x},${from.y}|${steps.length}|${steps.map(s => s.row + ',' + s.col).join('>')}`;
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
    // Only the origin carries protocol fine coordinates. Route points use the
    // geometry's client-unit stand points, matching the step mover's targets.
    const points = line.map((st,i) => i===0 && Number.isFinite(from.x) && Number.isFinite(from.y)
      ? {x:protocolToClient(from.x),y:protocolToClient(from.y)} : pointOf(st));
    const pulled = geo.stringPull(points);
    if (!pulled?.points?.length || !pulled.proved) return null;
    // Walk the pulled points back onto the plan, so a square can be asked "is the leg you
    // are on one the pull proved". Matching by POSITION rather than by index, because the
    // pull returns a subsequence and the caller holds the full route.
    const key = pt => Math.round(pt.x) + ',' + Math.round(pt.y);
    const pivotAt = new Map(pulled.points.map((pt, i) => [key(pt), i]));
    const ok = new Set();
    let leg = -1;
    for (const [i,st] of line.entries()) {
      const hit = pivotAt.get(key(points[i]));
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
    this.combatEpoch = 0;
    this.combat = new CombatMode(this, { keeper: () => autopilotIfAny(this.name) });
    this.pacer.authority = () => bodyAuthority(this);
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
    // A FIGHT IS ITS OWN GENERATION, AND NOT MOVEMENT'S. Deliberately separate: almost
    // every `cancelMovement` caller in the keeper is the watchdog or a travel guard
    // saying "stop WALKING" — breaking a wedge, pulling out of a blind walk. If a fight
    // shared that counter, the watchdog breaking a movement wedge would also cancel the
    // trade-in-place swing, which is the one rung that exists precisely for a body that
    // cannot move. The cancelled-token set IS shared, so a commander that cancels by
    // token stops both, which is what "stop what you are doing" means from outside.
    this.fightGeneration = 0;
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
    observeSurvivalDecision(this, value);
    if (value <= 0) finishSurvivalDecision(this, currentSurvivalDecision(this)?.id, 'died', 'health reached zero');
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
    this.replayRecorder?.capture('health_loss',{before,value,max,at:now});
    if(value===0)this.replayRecorder?.death({reason:'fatal health push',where:{room:this.world?.room?.num??null},fatal_at:now});
    traceSurvival(this, 'health_loss', { pushed_at: now, before, value, max,
      lost: before - value }, { lane: 'damage' });
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

  // AN ITEM LEFT THE PACK. THE COUNTERPART TO `looted`, AND IT DID NOT EXIST.
  //
  // `looted` records a floor drop becoming a carried item. Nothing recorded the other
  // direction, so the ledger could answer "what did this character pick up" and could not
  // answer "and where did it go" — which is how roughly two dozen magic items went missing
  // across 2026-09-07/08, the whole identification queue among them, leaving no row of any
  // kind behind. A sale leaves a purse trace, a death leaves `died`, and neither of those
  // had happened. Everything else an item can do was invisible.
  //
  // NO FILTER, ON PURPOSE. It is tempting to record only the interesting items and skip the
  // mushrooms and the arrows — but the filter would be a guess about the answer, and not
  // having the answer is the reason for the hunt. It costs a few thousand rows a day against
  // the twelve thousand `killed` rows already there; narrow it once it has spoken.
  //
  // The row's shape matches `looted` — a one-element `items` array — so a reader can put the
  // two directions side by side without special-casing either.
  noteLeftPack(ev) {
    const who = this.client?.me?.name ?? null;
    if (!who) return;
    try {
      recordEvent(who, 'left_pack', {
        agent: this.name ?? undefined,
        // The MAP NUMBER, never the room object id — the same distinction `looted` makes
        // at length above, and for the same reason: object ids are renumbered by `save game`.
        room: this.world?.room?.num ?? null,
        items: [{ id: ev.id, name: ev.name ?? null, amount: ev.amount,
                  icon_rsc: ev.icon_rsc, translation: ev.translation }],
        count: 1,
        // What we had asked for, if anything, and how long ago. `after: null` is the row
        // worth reading: the item left and we had requested nothing that could explain it.
        after: ev.after ?? null,
        after_ms: ev.after_ms ?? null,
        // False means it was not in the inventory we were holding — a stale id, or a pack
        // we had never read. Still evidence something left; just not evidence of what.
        known: ev.known !== false,
      });
    } catch { /* bookkeeping must never interrupt play */ }
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
        // THE SAME SPACE CONFUSION AS THE `looted` EMITTER, FOUND WHILE FIXING THAT ONE.
        // This wrote the room OBJECT id into a durable ledger field called `room`, while
        // `world.room.name` — the map's own view of where we are — resolved on the very next
        // line. Dormant rather than broken: `bankFromLine` keys off the NAME, and
        // m59-bank.mjs:213 stores `room` without ever reading it back. But object ids are
        // renumbered by `save game`, so the column's meaning drifts and rows either side of a
        // checkpoint cannot be compared. Rows written before this keep an object id; nothing
        // ever consumed them.
        room: this.world?.room?.num ?? null,
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
  runCommand(fn) { return withBodyCommand(this, fn); }

  groundEffectBlock(from, to) {
    const effect = groundEffectOnSegment(this.client, from, to);
    return effect ? { available: true, moved: false, blocked: true,
      reason: 'ground_effect_blocked', ground_effect: effect } : null;
  }

  hazardSquares() { return groundEffectSquares(this.client); }

  startJob(kind, label, fn, { controlToken = null, leaseToken = null } = {}) {
    if (this.combat?.active) throw new Error(`${this.name}: combat override owns the body`);
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
    job.promise = this.runCommand(() => withIntent(this,null,()=>fn(generation))).then(
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
  // `opts` reaches `travel` verbatim, so `allowHazard`/`hazardWhy` need no plumbing here —
  // but the announcement does, because a journey into a hazard room should be visible in the
  // job label rather than only in whatever asked for it.
  travelJob(dest, { where = `room ${dest}`, runErrands = true, ...opts } = {}) {
    const keeper = autopilotIfAny(this.name);
    return this.startJob('travel', `walk to ${where}${opts.allowHazard ? ' (HAZARD ROOM, on purpose)' : ''}`, async movementGeneration => {
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
            const stops = tripStopPhrase(outcome, rests);
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
              `, ${stops}.`;
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
          } else if (!ours.cancelled && !arrived && dest != null && here !== Number(dest)) {
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

  // THE SAME QUESTION FOR A FIGHT, WHICH COULD NOT BE ASKED AT ALL UNTIL NOW.
  //
  // `fight()` took no token and no generation, and there was no `cancelAttack` anywhere
  // in the tree. Once the keeper entered a fight the only ways out were inside the loop:
  // the foe died, we died, the weapon shattered, health fell through the flee line, or
  // THE ROUND COUNT RAN OUT. So the round budget was not a tactical choice — it was the
  // only exit that anything outside the fight controlled, which is why the three call
  // sites disagree (3 by omission, 10 and 30 by choice) and why none of them argued.
  //
  // What that cost while it stood: a commander_claim, an errand, a park or a shutdown
  // could not reach a swinging character; vigor is not checked inside the loop at all, so
  // a long fight drains the bar that sets the health regeneration rate (1.0 hp/s at 200
  // against 0.29 at 80) with nothing watching; and the room is invisible in there, so a
  // threats can build while the keeper cannot interrupt combat to take shelter.
  fightWasCancelled(generation, controlToken) {
    return generation !== this.fightGeneration ||
      (!!controlToken && this.cancelledMovementTokens.has(controlToken));
  }

  /** Stop the fight this character is in. The counterpart to `cancelMovement`. */
  cancelFight(controlToken, why = 'unattributed') {
    this.lastFightCancel = { why, at: Date.now(), room: this.world?.room?.num ?? null };
    this.fightGeneration++;
    if (controlToken) {
      this.cancelledMovementTokens.add(controlToken);
      if (this.cancelledMovementTokens.size > 100)
        this.cancelledMovementTokens.delete(this.cancelledMovementTokens.values().next().value);
    }
    return { cancelled: true, why, generation: this.fightGeneration };
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

  // WHO CANCELLED THIS, RECORDED WHERE IT HAPPENS.
  //
  // A journey that ends "movement cancelled by a newer command" names the mechanism and not
  // the caller, and for one night that was the whole of what the fleet could say about 46 of
  // 46 failed journeys. The `why` argument has always existed and four callers were passing
  // nothing, so the answer was `unattributed` exactly where it mattered.
  //
  // `unattributed` is kept as the default deliberately rather than being made to guess: a
  // guessed attribution is worse than an admitted gap, and it now shows up in the journey
  // ledger as a named hole to go and close rather than as a plausible-looking caller.
  cancelMovement(controlToken, why = 'unattributed', survival = {}) {
    try { bodyAuthority(this).guard(); }
    catch { return { cancelled: false, reason: 'combat override owns this body or caller was preempted' }; }
    this.replayRecorder?.capture('before_movement_cancel',{why});
    const job = this.job && !this.job.done ? this.job : null;
    this.lastMovementCancel = { why, at: Date.now(),
                                room: this.world?.room?.num ?? null };
    this.movementGeneration++;
    const replacement = cancelSurvivalDecision(this, why, survival);
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
    traceSurvival(this, 'movement_cancelled', { why,
      previous_generation: this.movementGeneration - 1,
      next_generation: this.movementGeneration, token_present: !!controlToken,
      survival_decision_id: replacement?.id ?? null,
      interrupted: job ? { kind: job.kind, label: job.label } : null });
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
    c.combatReady = false;
    const loginCombatEvents = [];
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
      if (!c.combatReady && ev.kind === 'message') loginCombatEvents.push(ev);
      else this.combat?.event(ev, c);
      this.recorder.line('event', ev);
      this.playerEvidence?.event(ev,c);
      if (ev.kind === 'ability') this.noteAdvancement(ev);
      if (ev.kind === 'message' && ev.text) { this.noteBanker(ev); this.noteCombatLine(ev); this.noteLoyalty(ev); }
      // A VAULT ANSWERS ONCE AND ONLY WHEN ASKED, so this is caught off the stream for
      // exactly the reason a bank balance is: whatever walked a character to a vaultman
      // has already paid for the trip, and if the reply goes past unread the contents are
      // unknown until somebody pays for it again.
      if (ev.kind === 'vault-list') this.noteVault(ev);
      // AND OFF THE STREAM FOR THE SAME REASON. An item leaving is announced once, by the
      // server, whatever took it; there is nothing to poll and nothing to ask afterwards,
      // because by then it is gone. See noteLeftPack.
      if (ev.kind === 'left') this.noteLeftPack(ev);
      // THE SERVER'S OWN SAVE, WRITTEN DOWN AS A BOUNDARY. BP_WAIT/BP_UNWAIT bracket the
      // pause (user.kod:2154, :2182), and m59-savelog.mjs uses these rows to partition the
      // ledger into windows — so what we record and what the checkpoint holds describe the
      // same instants. Their save has the STOCK; the window between two of them has the FLOW,
      // which nothing else keeps.
      //
      // Recorded by EVERY logged-in character, and that is deliberate: a client writes down
      // what it saw, and the reader collapses the burst. A single nominated observer would be
      // one restart away from a silently missing boundary.
      //
      // AND IT DOES NOT GO THROUGH THE AUTOPILOT, which is the difference between a boundary
      // that is usually there and one that is always there. `ledgerEvent` is a keeper method,
      // and a keeper has no autopilot until `autopilotFor` has run — so a save landing during
      // a fleet-wide resume would have been dropped by every character at once, silently, and
      // the two windows either side of a restart would have been welded into one. A restart is
      // exactly when the build changes, so that is the boundary that matters most.
      if (ev.kind === 'server-save') {
        const who = c.me?.name;
        if (who) {
          try {
            recordEvent(who, 'server_save',
              { agent: this.name ?? null, phase: ev.phase, held_ms: ev.held_ms ?? null });
          } catch { /* never let bookkeeping break play */ }
        }
      }
      // OFF THE STREAM, NOT OFF THE KEEPER. This is the one measurement that keeps
      // working while the keeper is inside a multi-minute travel await or held inert by
      // an errand — which is where 23 of the last 50 deaths happened. See m59-hits.mjs.
      if (ev.kind === 'stat' && ev.name === 'health') this.noteHealth(ev);
      // A travel await can enter AND leave the Underworld before the next keeper
      // pass. Observe the authoritative room event while it is still here. The
      // observer records only; the current movement owner remains the only escape.
      if (ev.kind === 'room-entered' && this.client === c) {
        const keeper = autopilotIfAny(this.name);
        if (keeper?.s === this)
          keeper.observeDeathRoom(ev)?.catch(e => keeper.note('death record failed', { why: e.message }));
      }
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
    c.beforeGameMutation = () => bodyAuthority(this).guard();
    c.beforeMove = target => {
      const hazard = this.groundEffectBlock(c.self, target);
      if (hazard) throw Object.assign(new Error('ground_effect_blocked'), {
        code: 'GROUND_EFFECT_BLOCKED', ground_effect: hazard.ground_effect });
    };
    this.world = new World(c, worldMap);
    attachPlayerEvidence(this).reset();
    this.playerEvidence.event({kind:'room-contents',at:Date.now()},c);

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
    // Bootstrap observations may run while PvP retains ownership across login.
    // Only these reads inherit that owner; an old recovery caller does not.
    const loginRead = fn => withBodyCommand(this, () => this.pacer.submit('read', fn),
      this.combat?.active?.id ?? 'login-observation');
    await loginRead(() => c.roomContents());
    await loginRead(() => c.players());
    await loginRead(() => c.requestInventory());
    await loginRead(() => c.stats(1));
    await loginRead(() => c.stats(2));
    // Existing poison survives logout but its icon needs this initial read.
    // Without it, reconnecting recovery can mistake poison ticks for attacks
    // and repeatedly restart the rest. Subsequent changes arrive as pushes.
    await loginRead(() => c.requestEnchantments());
    await new Promise(r => setTimeout(r, 600));
    c.combatReady = true;
    for (const ev of loginCombatEvents) this.combat?.event(ev, c);
    this.combat?.event({ kind: 'room-contents' }, c);

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
    // Isolated scene stand-ins verify stats through the lab admin read immediately
    // afterward. Ordinary character creation retains its existing settle waits.
    const fastReplay=this.replayFastReads===true&&Number(port)===17959&&
      ['127.0.0.1','localhost','::1'].includes(host);
    try { this.client?.sock?.destroy(); } catch { /* already gone */ }
    this.client = null;
    if(!fastReplay)await new Promise(r => setTimeout(r, 900));

    const c = new M59Client({ host, port, verbose: false, resources });
    c.onEvent = ev => {this.recorder.line('event', ev);this.playerEvidence?.event(ev,c);};
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
      // THE FACE, WHICH USED TO BE OMITTED AND THEREFORE ALWAYS THE SAME MAN.
      //
      // Sending no faceparts is not "no preference" to this server: a list whose length is
      // not exactly five is its "hacking the protocol" branch, which stamps the default
      // male face and says nothing (player.kod:1997). So every character this repository
      // has ever created came out identical. `planCharacter` now resolves an appearance —
      // randomising when nobody chose — and it is passed here. See m59-appearance.mjs.
      c.newCharInfo({
        user, name: plan.name, gender: plan.appearance?.gender ?? plan.gender ?? 1,
        faceparts: plan.appearance?.faceparts ?? [],
        hair: plan.appearance?.hair ?? 0,
        skin: plan.appearance?.skin ?? 0,
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
    attachPlayerEvidence(this).reset();
    this.playerEvidence.event({kind:'room-contents',at:Date.now()},c);
    this.credentials = { ...this.credentials, character: plan.name };
    await this.pacer.submit('read', () => c.stats(1));
    await this.pacer.submit('read', () => c.stats(2));
    if(!fastReplay)await new Promise(r => setTimeout(r, 800));
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
    // A recovery await begun before incoming PvP cannot disconnect the fighter.
    if (this.live) bodyAuthority(this).guard();
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
    return { ...this.world.snapshot(opts), combat: this.combat?.status() };
  }

  // Raw cached perception for a renderer. Unlike view(), this never runs A* for
  // every object and exit. Keep tactical validation on view(); keep frames fast here.
  perception() {
    this.need();
    return { ...this.world.perception(), combat: this.combat?.status() };
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
    const observed = await c.waitFor({ since: before, kinds: ['room-entered'], timeoutMs: 2500 });
    const entered = observed.events?.find(event => event.kind === 'room-entered') ?? null;
    return { confirmed: !!entered, entered, timedOut: !!observed.timedOut,
             room_id: c.room?.id ?? null,
             room_num: Number(this.world?.room?.num ?? NaN) };
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
  async standBeforeGo({ shouldCancel = null } = {}) {
    const c = this.need();
    await this.pacer.submit('rest', () => {
      // A refuge decision may be replaced while this command is queued. Its
      // delayed stand must not disturb the replacement's stationary recovery.
      if (!shouldCancel?.()) c.stand();
    });
  }

  // ONE BARE `GO` AT THE SQUARE THE CHARACTER IS ALREADY ON, stood up first.
  //
  // This is what the broker's `act verb=go` means — press the key, here — and it is NOT
  // `leaveViaAny`, which picks an exit and walks to it. The two are different verbs and
  // conflating them would turn "use the door under my feet" into "find me any way out".
  //
  // It exists because the broker could not express it any more. `act verb=go` called
  // `c.go()` directly, and on a keeper-backed session `c` is the proxy, which forwards
  // `standBeforeGo` but has no `go` — so the one crossing path that DID remember to stand
  // up then threw `c.go is not a function`. Every character is keeper-backed, so that path
  // had been dead for as long as the split has existed.
  async rawGo() {
    const c = this.need();
    await this.standBeforeGo();
    await this.pacer.submit('move', () => c.go(), DOOR_SETTLE_MS);
    return { ok: true, sent: 'go' };
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
      let touches = true, narrowed = false, sectorIndices = null;
      if (Number.isInteger(invalidated.sector) && typeof geo.leafAtClient === 'function') {
        // BP_SECTOR_MOVE names a server tag, not leaf.sectorNum's 1-based BSP
        // index. In room 598 tag 1 is BSP sector 114 (the Qor door), not sector 1.
        // Older compact bakes omitted tags; they cannot establish a narrow scope.
        sectorIndices = invalidated.sectorIndices ?? geo.sectorIndicesForServerId?.(invalidated.sector) ?? null;
        narrowed = Array.isArray(sectorIndices);
        const scale0 = CLIENT_FINENESS / KOD_FINENESS;
        const wx = Number.isFinite(me.x) ? me.x : me.col * KOD_FINENESS + (KOD_FINENESS >> 1);
        const wy = Number.isFinite(me.y) ? me.y : me.row * KOD_FINENESS + (KOD_FINENESS >> 1);
        const inSector = (cx, cy) => {
          const leaf = geo.leafAtClient(cx, cy);
          return leaf != null && sectorIndices.includes(leaf.sectorNum - 1);
        };
        if (narrowed) touches = inSector((wx - KOD_FINENESS) * scale0, (wy - KOD_FINENESS) * scale0)
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
          narrowed,
          sector_indices: sectorIndices,
          sector_identity_missing: Number.isInteger(invalidated.sector) && !narrowed,
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
                 // THE ROOM NUMBER IS WHAT A READER MEANS BY `room`; the object id goes under
                 // its own name. See tools/m59-roomref.mjs.
                 drift: { room: this.world?.room?.num ?? null, room_object_id: c.room.id,
                          live: roomSecurity >>> 0, baked: geo.security >>> 0 },
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
        const hazard = this.groundEffectBlock?.(before, target);
        if (hazard) return { sent: false, validation: hazard };
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
      const hazard = this.groundEffectBlock?.(c.self, validation.target);
      if (hazard) return { sent: false, validation: hazard };
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

  // ===================== THE WALKING HALF LIVES IN m59-session-walk.mjs =====================
  //
  // walkPivots, step, stepFine, approachFine, walkFine, the breadcrumb and rail retreats,
  // walkTo, railAcross, followRail, leaveVia, leaveViaAny, rideTrack, blinkOut and the rest
  // were moved out VERBATIM and are copied back onto this prototype below the class. Half of
  // this file was those twenty-nine methods, walkTo alone being 1,827 lines, and movement is
  // the subsystem under active churn -- it has its own commit tag and its own evidence
  // epochs. Nothing about how they behave changed in the move.
  //
  // They still read this file's constants and helpers: those are passed to the factory, so
  // inside a method every name resolves exactly as it did when it lived here.


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
  // `shouldCancel` is asked between swings, where the health abort already is. A swing is
  // ~2.9s on the wire, so this is the finest grain a cancel can land at without abandoning
  // an attack the server has already accepted.
  async attackRounds(targetId, swings = 4, { abortBelow = null, shouldCancel = null } = {}) {
    const c = this.need();
    // THE RESISTANCE SENTENCE ARRIVES AFTER THE HIT SENTENCE, AND THIS USED TO DROP IT.
    //
    // Each round waited from a `since` taken just before its own swing, and pushed only what
    // that wait returned. `waitFor` resolves the instant ONE matching event is there, so a
    // hit line resolved the wait and the line that follows it a fraction later — "The ghost
    // of Far'Nohl staggers backwards from the blow." — arrived after the resolve and before
    // the next round's `since`, into the gap, and was never reported to anybody.
    //
    // That sentence is the ONLY prod-safe read of whether the weapon in this hand is
    // enchanted (player.kod:9686 selects the band from the target's resistance to what was
    // just dealt), so losing it cost the raid its weapon check: 21 raiders reported
    // "first contact said nothing conclusive" while the server had said it 21 times.
    //
    // So the per-round wait is unchanged — it still paces the exchange and still decides when
    // to stop — but what is REPORTED is collected by sequence number into a map, and swept
    // once more at the end from the whole exchange. The map is keyed on `seq` so the sweep
    // cannot double-count what the rounds already saw, and a sweep that finds its start
    // trimmed out of the 500-event ring still keeps everything the rounds collected.
    const collected = new Map();
    const keep = ev => { for (const e of ev) if (e.kind === 'message' && e.text) collected.set(e.seq, e.text); };
    const exchangeFrom = c.evSeq;
    let aborted = null;
    let cancelled = null;
    const healthPct = () => {
      const h = c.vitals()?.health;
      return h?.max ? h.value / h.max : null;
    };
    for (let i = 0; i < swings; i++) {
      const o = c.room.objects.get(targetId);
      if (!o) break;
      // Before the swing, like the health abort below it: a cancel that arrives mid-round
      // must not buy one more packet.
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        cancelled = { at_swing: i };
        break;
      }
      // Before the swing as well as after it: the previous exchange's damage has
      // already landed, and one more swing at 15% is how a character dies mid-round.
      if (abortBelow != null) {
        const hp = healthPct();
        if (hp != null && hp < abortBelow) { aborted = { at_health: hp, swing: i }; break; }
      }
      await this.faceToward(o);
      const before = c.evSeq;
      await this.pacer.submit('attack', () => c.attack(targetId), ATTACK_INTERVAL_MS);
      // Combat results and disappearance are server messages.  Do not admit chat
      // (`said`) into the evidence window: another player can quote hit prose while
      // this swing is outstanding, and that must not turn a miss into progress.
      const ev = await c.waitFor({
        since: before, kinds: ['message', 'vanished'], timeoutMs: 2500,
      });
      keep(ev.events);
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
      if ([...collected.values()].some((t) => skills.cannotSwingText(t))) break;
    }
    // Health after the exchange, since deciding whether to keep fighting depends on
    // it and the stat only arrives when it changes.
    await this.pacer.submit('read', () => c.stats(1));
    await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    // The trailing sweep. `said` is still excluded by `keep` — another player quoting hit
    // prose must never become evidence — and ordering by seq puts the resistance band back
    // immediately after the blow it describes, which is how a reader tells them apart.
    // Guarded: a session double in a test has no ring to sweep, and the rounds' own
    // collection is already the answer there.
    if (typeof c.eventsSince === 'function') keep(c.eventsSince(exchangeFrom));
    const messages = [...collected.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    // SAY THAT THE SWING WAS REFUSED, on the path that nearly every character in this fleet
    // takes. The broker's own `attack` tool computes `could_not_swing` and prints the cure —
    // stand up and swing again — but only on the in-process branch. Keeper-backed sessions
    // return straight out of here, so the flag was simply absent, `r?.could_not_swing` read
    // `undefined`, and a raid read 590 refusals as 590 swings that did no damage.
    const couldNotSwing = messages.some(t => skills.cannotSwingText(t));
    return { messages, vitals: c.vitals(), aborted, cancelled,
             ...(couldNotSwing ? { could_not_swing: true,
                                   note: 'the swings were refused, not missed — the character is ' +
                                         'sitting down (PFLAG_NO_FIGHT, player.kod:1164). Send `rest` ' +
                                         'with stand:true and swing again. Hold, Dazzle, Blind and a ' +
                                         'DM freeze say the same thing and standing will not help those.' }
                                : {}) };
  }

  /**
   * Install the overfarm policy this character is running, and what it may never drop.
   *
   * The sift counter is NOT reset here: a policy change mid-lap is still the same lap, and
   * zeroing it would hand the character a fresh 150% budget every time DUM re-asserted an
   * unchanged setting — which it does on a timer.
   */
  setOverfarmPolicy(policy = null, protect = []) {
    this._overfarmPolicy = policy ?? null;
    this._overfarmProtect = Array.isArray(protect) ? protect : [];
    if (policy?.enabled) this._overfarm ??= { sifted: 0, stream: [], taken: 0, dropped: 0, left: 0 };
  }

  /**
   * A LAP ENDS WHERE THE GOODS DO. Called when the pack is emptied into a merchant, a vault
   * or a guild chest — that is the moment the next 150% starts counting, and it is the only
   * moment, because a lap measured from anything else (a clock, a room change, a restart)
   * would let a character that never delivers farm for ever.
   *
   * Returns the finished lap so the caller can record it; the arithmetic of what the
   * overfarming was worth is `siftValue` in m59-overfarm.mjs.
   */
  endOverfarmLap() {
    const lap = this._overfarm ?? null;
    this._overfarm = this._overfarmPolicy?.enabled
      ? { sifted: 0, stream: [], taken: 0, dropped: 0, left: 0 } : null;
    return lap;
  }

  // Pick up everything gettable within reach. Shared with the `loot` tool.
  // `stayPut` is for looting from a safe spot: UserGet reaches seven squares on its
  // own, so most of a kill's drops are already gettable from where you stand, and the
  // few that are not are not worth giving up the wall for. What is left behind is
  // reported rather than silently skipped.
  async lootFloor({ only = null, ids = null, maxItems = 12, stayPut = false,
                    movementGeneration = this.movementGeneration, controlToken = null,
                    shouldCancel = null, explicitIdsOverride = true,
                    beforeMutation = null,
                    // DEFAULTED FROM THE SESSION, NOT REQUIRED FROM THE CALLER. Six places
                    // call lootFloor and only one of them is inside the autopilot; asking
                    // each to remember to forward the policy is how a strategy ends up
                    // enabled on a character that never applies it. The autopilot installs
                    // it on the session (`setOverfarmPolicy`) and every path inherits it.
                    overfarm = this._overfarmPolicy ?? null,
                    protect = this._overfarmProtect ?? [] } = {}) {
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

    // OVERFARMING: DECIDE WHICH OF THIS FLOOR IS WORTH THE PACK IT WOULD COST.
    //
    // Here rather than in a caller, because this function's own comment forty lines down
    // already says why: it is "the single place a floor drop becomes a carried item". Six
    // call sites reach it — the kill tick, the loot-runner errand, the clean-up sweep, the
    // `loot` tool, the corpse follow-up and the keeper action — and a policy installed in
    // one of them would be a policy four characters do not have.
    //
    // It runs AFTER the cursed and broken filters and never reverses them: those are
    // refusals about the item, this is a decision about the pack, and a thing we will not
    // touch cannot be ranked into it.
    let overfarmPlan = null;
    const ofPolicy = overfarm ? normalizeOverfarm(overfarm) : null;
    if (ofPolicy?.enabled && cands.length && !ids?.length) {
      const cap = skills.carryCapacity(c);
      // AN INEXACT LOAD IS A LOWER BOUND, and `carryCapacity` withholds `room_for` rather
      // than guess — the same rule the sell trigger follows. Overfarming on a lower bound
      // would compute a pack that is emptier than it is and then drop things to make room
      // it already had, so it stands down and loots normally instead.
      if (cap?.known && cap.load?.exact) {
        const named = o => c.rsc.get(o.nameRsc) || '';
        this._overfarm ??= { sifted: 0, stream: [], taken: 0, dropped: 0, left: 0 };
        overfarmPlan = planPickup({
          floor: cands.map(o => ({ id: o.id, name: named(o), amount: o.amount || 1 })),
          pack: (c.inventory || []).map(o => ({ name: c.rsc.get(o.nameRsc) || o.name,
                                                amount: o.amount || 1, id: o.id })),
          policy: ofPolicy, protect, capacity: cap.weight_max,
          sifted: this._overfarm.sifted,
        });

        // The swaps first: the pack has to have the room before the get is sent, or the
        // server refuses the pickup and we have thrown something away for nothing.
        for (const swap of overfarmPlan.swaps) {
          for (const giving of swap.drop) {
            const held = (c.inventory || []).find(o =>
              (c.rsc.get(o.nameRsc) || o.name) === giving.name);
            if (!held) continue;
            await this.pacer.submit('drop', () => {
              if (typeof beforeMutation === 'function') beforeMutation('drop', { target_id: held.id });
              return c.drop([dropSpec(held, giving.amount)]);
            }).catch(() => {});
            this._overfarm.dropped++;
            refused.push({ id: held.id, name: giving.name, dropped: true,
                           why: `traded away for ${swap.take.name}: ${swap.why}` });
          }
        }
        if (overfarmPlan.swaps.length) {
          await this.pacer.submit('read', () => c.requestInventory()).catch(() => {});
          await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
        }

        const wanted = new Set(overfarmPlan.take.map(t => t.id));
        for (const skipped of overfarmPlan.leave) {
          refused.push({ id: skipped.id, name: skipped.name, why: skipped.why });
          this._overfarm.left++;
        }
        cands = cands.filter(o => wanted.has(o.id));
      }
    }

    for (const n of brokenSkipped)
      refused.push({ item: n, why: 'BROKEN — the server says it has been shattered. It cannot be ' +
                                   'wielded or sold, and its name does not say so, which is why the ' +
                                   'fleet used to carry them for ever. Left on the floor.' });
    for (const n of cursedSkipped)
      refused.push({ item: n, why: 'CURSED — it equips itself, cannot be removed without an ' +
                                   'uncurse spell, and makes you easier to hit. Leave it.' });
    for (const o of cands) {
      if (cancelled()) { wasCancelled = true; break; }
      setIntentTarget(this,{kind:'pickup',object_id:o.id});
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
    setIntentTarget(this,null);
    if (!wasCancelled) {
      await this.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    }

    // SOMETHING ENTERED THE PACK, AND UNTIL NOW NOTHING SAID SO.
    //
    // The ledger already records what a character kills, buys, spends and dies of — but not
    // what it PICKED UP, which is the one that decides whether the thing in the pack is worth
    // a trip. Anybody wanting to react to loot had to poll every pack and diff it.
    //
    // Emitted here because this is the single place a floor drop becomes a carried item: the
    // pickup atomic deliberately depends on nothing, and every other route in (a trade, a
    // purchase, the operator's own client) already has its own record or is outside the
    // harness entirely. `taken` is what the server CONFIRMED with a `got`, never what was
    // asked for — a refusal is a sentence spoken to the room here, as everywhere.
    //
    // WHAT SUBSCRIBES TO THIS IS NOT THIS REPOSITORY'S BUSINESS. Which loot is worth
    // abandoning a hunt for is a fleet's bet, and it lives in substrate/hooks. This states
    // the fact and stops.
    //
    // NOTE FOR A HANDLER: recordEvent fires hooks in whatever process calls it, and lootFloor
    // runs in the KEEPER — one keeper, the one that looted, not the broker and not all
    // twenty-one. A handler that starts a fleet-wide anything from here starts it once per
    // looting character. Act on `character`, or check argv[1] before doing something global.
    if (taken.length) {
      try {
        recordEvent(c.me?.name ?? this.name ?? null, 'looted', {
          agent: this.name ?? undefined,
          // A ROOM IDENTIFIER CARRIES ITS SPACE, AND THERE ARE TWO OF THEM.
          //
          // `c.room.id` is the SERVER'S ROOM OBJECT ID, assigned from BP_PLAYER's `roomId`
          // (m59-client.mjs:1378). `world.room.num` is the MAP NUMBER — 39, 114, 544 — which
          // is what the bake, the router, `travel`, every ledger and every human use.
          // They are different spaces: the Valley of Ileria is object 1386 and room 544.
          //
          // This line has now been wrong twice, in opposite directions, and the second was
          // worse than the first. `c.room?.num` was always undefined, so every row read
          // `room: null` — honest, if useless. "Fixing" it to `c.room?.id` filled the field
          // with 1386, which is not a room number in any table anything else consults: a
          // confident answer in a language nothing else speaks. A null says "I do not know";
          // a wrong-space number says "544" and is believed.
          //
          // AND AN OBJECT ID IS NOT EVEN STABLE. They are renumbered by `save game` — which
          // is why this ledger is keyed on character NAME and not on object id. So `1386`
          // was not merely the wrong language, it was a language whose words change meaning
          // at the next checkpoint: rows written either side of a save would disagree about
          // the same room while both looked perfectly well-formed.
          //
          // `world.room` resolves by roomNameRsc/roomRsc against the baked map
          // (m59-world.mjs:493) and is the same idiom the hit book uses twelve hundred lines
          // up. If the map does not know the room this is null again, which is correct.
          room: this.world?.room?.num ?? null,
          items: taken.map(t => ({ id: t.id, name: t.name, amount: t.amount })),
          count: taken.length,
        });
      } catch { /* a ledger write must never cost us the loot we just picked up */ }
    }

    // THE SIFT COUNTER IS WHAT MAKES `overfarm_percent` MEASURABLE, and it counts what the
    // hands passed over, not what came home: an item picked up and later traded away is the
    // whole evidence that overfarming happened. Accumulated from `taken` — what the server
    // CONFIRMED with a `got` — never from what was asked for.
    if (this._overfarm && taken.length) {
      for (const t of taken) {
        const cost = unitCost(t.name);
        if (cost.known) this._overfarm.sifted += cost.cost * (t.amount || 1);
        this._overfarm.stream.push({ name: t.name, amount: t.amount || 1 });
      }
      this._overfarm.taken += taken.length;
    }

    return { taken, refused,
             carrying: c.inventory.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc), amount: o.amount || undefined })),
             ...(overfarmPlan ? { overfarm: { phase: overfarmPlan.phase,
                                              pack_percent: overfarmPlan.pack_percent,
                                              sifted_percent: overfarmPlan.sifted_percent,
                                              swapped: overfarmPlan.swaps.length,
                                              why: overfarmPlan.why } } : {}),
             ...(wasCancelled ? { cancelled: true,
               note: 'loot intent stopped before the next paced item action' } : {}) };
  }

  // Offer one item to a merchant and either read the price or complete the sale.
  // Selling is the trade protocol, so this is offer -> wait for the money
  // counteroffer -> accept (or cancel, when we only wanted the quote).
  async sellOne(merchantRef, item, confirm) {
    const c = this.need();
    const liveItem=(c.inventory||[]).find(o=>o.id===item.id);
    if(!liveItem)return {sold:false,offered_price:null,note:'item is no longer carried'};
    const heldBefore=liveItem.amount||1, offeredAmount=liveItem.amount>0?item.amount:1;
    if (!(offeredAmount>0) || offeredAmount>heldBefore)
      return {sold:false,offered_price:null,note:'offered quantity is no longer carried'};
    const intentItem={id:item.id,name:c.rsc.get(liveItem.nameRsc)||liveItem.name||''};
    const blocked=saleBlocked(this,intentItem);
    if(blocked)return {sold:false,offered_price:null,note:blocked};
    const t = typeof merchantRef === 'object' && merchantRef !== null ? merchantRef : { id: Number(merchantRef) };
    const before = c.evSeq;
    await this.pacer.submit('trade', () => c.offer(t.id, [liveItem.amount > 0 ? { id: item.id, amount: item.amount } : item.id]));
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
    const held=await this.pacer.submit('trade', () => {
      const current=(c.inventory||[]).find(o=>o.id===item.id);
      const reason=!current||c.rsc.get(current.nameRsc)!==intentItem.name
        ? 'item changed during the offer' : saleBlocked(this,intentItem);
      if(reason){c.cancelOffer();return reason;}
      c.acceptOffer();return null;
    });
    if(held)return {sold:false,offered_price:price,merchant_said:said,note:held};
    await new Promise(r => setTimeout(r, 1400));
    await this.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 4000 });
    const remaining=c.inventory.find(o=>o.id===item.id);
    const removed=heldBefore-(remaining?(remaining.amount||1):0);
    return { sold: removed>=offeredAmount, amount: removed, offered_price: price, merchant_said: said,
      ...(removed<offeredAmount?{note:'sale did not remove the offered quantity'}:{}) };
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
    // Going into a room on the NEVER_ENTER list, on purpose, with a reason that is recorded.
    // Both halves are required: an override nobody has to justify is just a hole.
    allowHazard = false,
    hazardWhy = null,
    maxHops = 25,
    maxStumbles = 6,
    movementGeneration = this.movementGeneration,
    controlToken,
    onHop = null,
    // Baked-track stations rest inside rideTrack, below the room-boundary hook. Surface
    // those stops separately instead of turning them into another onHop, which would also
    // run boundary behaviour and change the journey merely to count it.
    onTrackRest = null,
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
      const { hp, max } = readHealth(v);
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
                               { within: 14, room: Number(this.world?.room?.num) || null,
                                 unreachable: this.shelterPolicy?.unreachable?.(this.world?.room?.num) ?? null });
      } catch { spot = null; }
      if (!spot) return false;
      const shelterRoom = this.world?.room?.num;
      const walked = await this.walkTo(spot.col, spot.row,
        { maxSteps: 40, movementGeneration, controlToken }).catch(() => null);
      if (!walked?.arrived || walked.left_room
          || this.movementWasCancelled(movementGeneration, controlToken)
          || this.world?.room?.num !== shelterRoom
          || c.self?.col !== spot.col || c.self?.row !== spot.row) return false;
      log.push({ healing_at: { row: spot.row, col: spot.col },
                 room: this.world?.room?.name ?? null, from: Math.round(100 * hp / max) + '%' });
      await this.pacer.submit('rest', () =>
        this.movementWasCancelled(movementGeneration, controlToken) ? false : c.rest()).catch(() => null);
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
      await this.pacer.submit('rest', () =>
        this.movementWasCancelled(movementGeneration, controlToken) ? false : c.stand()).catch(() => null);
      const after = c.vitals?.()?.health?.value ?? c.vitals?.()?.health;
      if (Number.isFinite(after) && after > hp) healed++;
      return true;
    };

    // Every completed crossing pays the same recovery checks, including tracks.
    const finishHop = async () => {
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      await healAtAWall().catch(() => false);

      // Arriving brings a fresh BP_PLAYER, and with it the identity the world model
      // needs; give the room contents a moment to land as well.
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      await this.pacer.submit('read', () => this.client.roomContents());
      await this.client.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });

      // THE PAUSE POINT. One per room, with the room already visible.
      if (this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
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
      return null;
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
        allowHazard,
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
            until: () => this.world.route(toRoomNum, { allowHazard,
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
      // WHERE WE WANT TO LAND, from whichever of the two things knows.
      //
      // `arriveNear` is the caller's wish and only applies to the hop that ENTERS the final
      // destination. The backtrack is this journey's own memory: if this hop goes back to the
      // room we most recently came from, the door we came in by is a landing we know reaches
      // where we were, and it beats "the nearest one" every time in a room whose exits do not
      // land together. The caller's wish wins where both have an opinion.
      const back = this.enteredVia;
      const backtrackTo = (back && Number(back.room) === Number(this.world?.room?.num)
                           && Number(back.from) === Number(nextHop.to)) ? back.door : null;
      const wantLanding = (arriveNear && Number(nextHop.to) === Number(toRoomNum))
        ? arriveNear : backtrackTo;

      // AND WHEN NEITHER KNOWS, ASK THE ROUTE. An intermediate hop has no `arriveNear` — the
      // caller only says where it wants to land in the FINAL room — and no backtrack unless
      // it happens to be doubling back. That left every middle hop of a through-route picking
      // by distance, which is how Blackstone stranded a fleet. See `doorsLandingOnward`.
      const onwardTo = route.hops[1]?.to ?? null;
      let wanted = null, doorChoice = null;
      if (wantLanding) {
        wanted = doorsLandingNear(this.world?.map, this.world?.room?.num,
                                  nextHop.to, wantLanding);
        doorChoice = backtrackTo === wantLanding ? 'the door we came in by' : 'landing side';
      } else if (onwardTo != null) {
        wanted = doorsLandingOnward(this.world?.map, this.world?.room?.num,
                                    nextHop.to, onwardTo);
        doorChoice = 'the landing that can still reach the next hop';
      }
      if (wantLanding || wanted) {
        const right = wanted
          ? candidates.filter(e => e.stand_on &&
              wanted.has(`${e.stand_on.col},${e.stand_on.row}`))
          : [];
        // Narrow only when something survives. An empty result means the map disagrees with
        // the published exits, and crossing by the wrong door beats not crossing at all.
        // `wantLanding` is null on the onward path — there the goal is a door in the NEXT
        // room rather than a square this journey asked for, so it is named as the hop.
        // Computed here so the narrowing below stays one short block: m59-doorside-test
        // pins `candidates = right` to within a few lines of `if (right.length)`, which is
        // what stops an empty answer ever being allowed to refuse a boundary.
        const wantsToReach = wantLanding
          ? { col: wantLanding.col, row: wantLanding.row }
          : `a door onward to ${onwardTo}`;
        if (right.length) {
          log.push({ door_choice: doorChoice, to: nextHop.to, to_name: nextHop.to_name,
                     kept: right.length, of: candidates.length, wants_to_reach: wantsToReach });
          candidates = right;
        } else if (wanted) {
          log.push({ door_choice: 'no door lands on the wanted side', to: nextHop.to,
                     of: candidates.length,
                     note: 'crossing anyway by the ordinary ordering — a wrong side is ' +
                           'recoverable, a refused boundary is not' });
        }
      }
      // THE DOOR INTO THE HALF OF THIS ROOM THE EXIT IS IN.
      //
      // Every candidate above can be a real, published, correctly baked exit and still be
      // one no body in this room can walk to, because a room number is not necessarily one
      // connected floor. Castle Victoria's is 23 regions: everything arrives in region 0,
      // and the trapdoor down to the Underbasement is in region 3. `anchorReach` says
      // false from every square in the body and it is RIGHT - there is no walk. There is a
      // door, four of them, declared in the map as `go` exits pointing back at room 38
      // (castle1.kod:88-98), and nothing had ever planned through one because a room graph
      // discards a self-loop.
      //
      // What that cost: travel to 41 picked the trapdoor, could not reach it, and ground
      // against the internal wall until the job timed out - the crate errand's whole
      // failure, and the reason the fleet has never been able to work the ground floor.
      // Eleven rooms in this map have doors into themselves.
      //
      // ASK THE PLANNER, NOT `reachable`. The obvious gate here is "every candidate says
      // reachable: false", and it is wrong: `exits()` says in as many words that a `go`
      // square IS the door tile, is a pocket by design, and is very often false while the
      // door is perfectly usable. Gating on it would open an internal door on ordinary
      // crossings all over the world.
      //
      // `planSameRoomDoors` answers the real question — can this body WALK to any of these
      // squares, allowing the doorway pocket — and returns `walkable: true` with no doors
      // when it can. It also returns null before touching geometry for a room that declares
      // no internal door, which is 253 of this map's 264, so this costs nothing anywhere
      // else.
      //
      // ONE DOOR PER PASS. `continue` re-reads the room from the far side of the wall and
      // re-plans, which is what makes a wrong guess cost a walk rather than a journey.
      {
        const plan = this.planSameRoomDoors(
          candidates.map(e => e.stand_on).filter(Boolean)
                    .map(p => ({ row: p.row, col: p.col })));
        if (plan?.doors?.length) {
          const door = plan.doors[0];
          const crossed = await this.crossSameRoomDoor(door, { movementGeneration, controlToken });
          log.push({ from: String(nextHop.from), to: nextHop.to_name, via: 'internal door',
                     stand_on: { col: door.col, row: door.row },
                     lands: { col: door.arriveCol, row: door.arriveRow },
                     doors_planned: plan.doors.length,
                     ok: crossed.crossed === true,
                     ...(crossed.crossed ? { at: crossed.at }
                                         : { reason: crossed.reason, note: crossed.note }) });
          if (crossed.cancelled) return this.cancelledMovement({ log });
          // A DOOR IS NOT A HOP. It moved the body inside one room, so nothing about the
          // route changed and `hops` must not advance - `continue` re-reads the exits from
          // the other side of the wall and the ordinary path takes it from there.
          if (crossed.crossed) continue;
          // It did not open. Fall through rather than returning: the candidates are still
          // there to be tried, and a refusal that has never sent a packet at the boundary
          // is not evidence that the boundary is shut.
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
      const leavingRoomId = this.client?.room?.id ?? null;
      // A published room can blink for one observation. Stop source-room movement on the
      // first identity change, but count a hop only after an authoritative BP_PLAYER refresh
      // (or the stable-read fallback used by the lifted offline fixture) confirms it.
      const settlePublishedRoom = async () => {
        let confirmed = false;
        if (typeof this.refreshRoomIdentity === 'function') {
          const refreshed = await this.refreshRoomIdentity().catch(() => null);
          confirmed = refreshed?.confirmed === true;
        } else {
          let room0 = Number(this.world?.room?.num ?? NaN);
          let roomId0 = this.client?.room?.id ?? null;
          let stable = 0;
          for (let sample = 0; sample < 3 && stable < 2; sample++) {
            await new Promise(resolve => setTimeout(resolve, 25));
            const nextRoom = Number(this.world?.room?.num ?? NaN);
            const nextRoomId = this.client?.room?.id ?? null;
            if (nextRoom === room0 && nextRoomId === roomId0) stable++;
            else { room0 = nextRoom; roomId0 = nextRoomId; stable = 0; }
          }
          confirmed = stable >= 2;
        }
        return { confirmed,
                 cancelled: this.movementWasCancelled(movementGeneration, controlToken),
                 room: Number(this.world?.room?.num ?? NaN),
                 roomId: this.client?.room?.id ?? null };
      };
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
      if ((ridden.rested ?? 0) > 0 && onTrackRest) {
        try {
          await onTrackRest({ stops: ridden.rested, held_ms: ridden.rested_ms ?? 0,
                              from: leavingRoom, to: nextHop.to });
        } catch (e) {
          log.push({ from: String(nextHop.from), to: nextHop.to_name,
                     track_rest_hook_failed: e.message,
                     note: 'the track rest happened; only its journey counter failed' });
        }
      }
      if (ridden.cancelled || this.movementWasCancelled(movementGeneration, controlToken))
        return this.cancelledMovement({ log });
      const afterRideRoom = Number(this.world?.room?.num ?? NaN);
      const afterRideRoomId = this.client?.room?.id ?? null;
      const roomChangedDuringRide = leavingRoomId != null && afterRideRoomId != null
        && afterRideRoomId !== leavingRoomId;
      if (ridden.left_room || ridden.room_changed || roomChangedDuringRide) {
        const settled = await settlePublishedRoom();
        if (settled.cancelled) return this.cancelledMovement({ log });
        const changedLogically = settled.confirmed
          && Number.isFinite(leavingRoom) && Number.isFinite(settled.room)
          && settled.room !== leavingRoom;
        if (changedLogically) {
          const reachedExpectedRoom = settled.room === Number(nextHop.to);
          cameFromRoom = Number.isFinite(leavingRoom) ? leavingRoom : null;
          log.push({ from: String(nextHop.from), to: nextHop.to_name,
                     via: 'track', ok: reachedExpectedRoom, ms: ridden.ms,
                     ...(reachedExpectedRoom ? {} : {
                       landed_in: settled.room,
                       reason: `track crossing landed in ${settled.room} instead of ${nextHop.to}`,
                     }),
                     ...((ridden.room_changed || roomChangedDuringRide) && !ridden.left_room
                       ? { late_room_change: true } : {}),
                     rode: { reached: ridden.reached ?? 0, blocked: ridden.blocked ?? 0,
                             rested: ridden.rested ?? 0 } });
          if (!reachedExpectedRoom) {
            const why = `track crossing landed in ${settled.room} instead of ${nextHop.to}`;
            if (await stumble(why)) continue;
            return arrivedIfHere({ arrived: false, log, reason: why, stumbles: totalStumbles });
          }
          hops++; stumbles = 0;
          const interrupted = await finishHop();
          if (interrupted) return interrupted;
          continue;
        }
        const why = 'room identity changed during track replay, but the settled logical room did not';
        log.push({ from: String(nextHop.from), to: nextHop.to_name, via: 'track', ok: false,
                   reason: why, late_room_change: true,
                   rode: { reached: ridden.reached ?? 0, blocked: ridden.blocked ?? 0,
                           rested: ridden.rested ?? 0 } });
        if (await stumble(why)) continue;
        return arrivedIfHere({ arrived: false, log, reason: why, stumbles: totalStumbles });
      }
      // EXIT CANDIDATES BELONG TO THE ROOM THAT PUBLISHED THEM.
      //
      // Even a track implementation that misses a late transition must not make those
      // coordinates executable in another room. Require both the graph room and, when it is
      // available, the protocol room object to still be the identities captured before the
      // await. Unknown is not "same": re-read and re-plan instead of guessing with stale
      // geometry.
      const candidatesStillCurrent = Number.isFinite(leavingRoom)
        && Number.isFinite(afterRideRoom) && afterRideRoom === leavingRoom
        && (leavingRoomId == null || afterRideRoomId === leavingRoomId);
      if (!candidatesStillCurrent) {
        const why = 'room identity changed while track replay reported no crossing';
        if (await stumble(why)) continue;
        return arrivedIfHere({ arrived: false, log, reason: why, stumbles: totalStumbles });
      }
      let r = await this.leaveViaAny(candidates, { movementGeneration, controlToken });
      if (!r.left && r.room_changed) {
        const settled = await settlePublishedRoom();
        if (settled.cancelled) return this.cancelledMovement({ log });
        const changedLogically = settled.confirmed
          && Number.isFinite(leavingRoom) && Number.isFinite(settled.room)
          && settled.room !== leavingRoom;
        if (changedLogically) {
          r = { ...r, left: true, confirmed_room_change: true,
                arrived_in: this.world?.room?.name ?? String(settled.room) };
        } else {
          const why = 'room identity changed during exit execution, but the settled logical room did not';
          if (await stumble(why)) continue;
          return arrivedIfHere({ arrived: false, log, reason: why, stumbles: totalStumbles });
        }
      }
      // `tried` is exit-candidate evidence everywhere else in this pipeline. Older
      // region results used it for a numeric count; tolerate that legacy contract at
      // this boundary so evidence collection cannot turn a completed crossing into a
      // failed travel job.
      if (r?.tried != null && !Array.isArray(r.tried)) {
        const legacyRegionAttempts = Number(r.tried);
        r = { ...r,
              ...(r.region_attempts == null && Number.isFinite(legacyRegionAttempts)
                ? { region_attempts: legacyRegionAttempts } : {}),
              tried: [] };
      }
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
        region_attempts: r.region_attempts ?? null,
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
                 ...(r.region_attempts != null ? { region_attempts: r.region_attempts } : {}),
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
        // A DELIBERATE SECOND ASK AT ONE SQUARE MUST NOT READ AS THE BUG THAT ASKED TWICE
        // BY ACCIDENT.
        //
        // `recentred` is carried because without it the two are indistinguishable in this
        // book, and this book is the first thing anybody reads when a leg detours. The
        // squares column for a re-centred crossing looks exactly like the duplicate-candidate
        // bug fixed in 814f377 — `1,21 | 1,21 | 2,21 | 2,21 | 2,20` — and the note that says
        // which it was is dropped by this very mapping.
        //
        // It caught its author out within twenty minutes of the deploy: the field check
        // written to CONFIRM that fix read those repeats and reported the bug still present,
        // in a boundary where it had in fact been fixed and the pairs were the new free
        // retry. The tactics ledger had the answer under `edge_recentre` all along, but a
        // reader should not need two instruments to answer one question.
        ...(r.tried?.length ? { refusals: r.tried.slice(0, 8).map(t => ({
              square: t.stand_on ? `${t.stand_on.row},${t.stand_on.col}` : null,
              stage: t.stage ?? null,
              crossing_packet_sent: t.crossing_packet_sent ?? null,
              ...(t.recentred === undefined ? {} : { recentred: t.recentred }),
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
      // WHICH DOOR WE CAME IN BY, so the way out can be the same one.
      //
      // A room's several ways to the same place are alternatives only when that place is one
      // connected floor. Blackstone Keep has THREE pairs of doors back to the Courtyard and
      // they do not land together: two of them put a character in a watch tower, which is a
      // pocket of the Courtyard that the main yard cannot be walked to from. The tower is
      // there for shooting at people from, and the fleet has no business in one - but
      // `orderExits` ranks by reachable-then-nearest, so the nearest door won and the
      // character then spent vigor and minutes trying to path out of a tower before falling
      // back to a blink.
      //
      // The door square we just used is the one square in the room we are LEAVING that we
      // know connects to where we were. Storing it means the return trip can ask
      // `doorsLandingNear` the question it already knows how to answer.
      if (exit?.stand_on && Number.isFinite(leavingRoom))
        this.enteredVia = { room: Number(this.world?.room?.num ?? NaN), from: leavingRoom,
                            door: { col: exit.stand_on.col, row: exit.stand_on.row },
                            at: Date.now() };
      // AND GET OFF THE DOORWAY BEFORE DOING ANYTHING ELSE. See stepInland: a crossing lands
      // on the far room's boundary, and the next movement from there is one square from
      // leaving again — sometimes into a different room than the one we came from.
      // Guarded: `travel` is lifted out of this file by text and evaluated against a fake
      // session elsewhere, and a bare call there is a TypeError rather than a no-op.
      if (typeof this.stepInland === 'function') await this.stepInland().catch(() => false);
      cameFromRoom = Number.isFinite(leavingRoom) ? leavingRoom : null;
      const interrupted = await finishHop();
      if (interrupted) return interrupted;
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

// `doorsLandingNear` and `doorsLandingOnward` are exported so a test can call the SHIPPED
// function rather than reimplement it. m59-doorside-test used to re-derive the logic and
// then grep this file's source to check it was still here, which pins the text and not the
// behaviour — and it silently omitted the `ok.size === asked -> null` rule that is the most
// consequential line in doorsLandingNear.
installIntentObservers(Session.prototype);
export { Session, Recorder, Pacer, readAbilitiesOnce, loadMonsterLevels, monsterKarmaByName, monsterLevelByName, arrivalReport, orderExits, geometryStartupMode, doorsLandingNear, doorsLandingOnward };

import {installIntentObservers,setIntentTarget,withIntent} from './m59-intent-observations.mjs';

// ===================== INSTALL THE WALKING HALF =====================
//
// Copied onto the prototype rather than inherited, because Session already has a base and
// because a mixin that changes the prototype CHAIN changes `instanceof` and every
// `Object.getPrototypeOf` answer in the tree. Descriptors are copied so the methods stay
// non-enumerable, which is what a class body produces and what `for...in` over a session
// has always assumed.
{
  const walk = sessionWalkPrototype({
    ATTACK_INTERVAL_MS,
    BLINK_EVADE_MS,
    COMBAT_FACE_HOLD_MS,
    CROSSING_ASK_EVERY_MS,
    CROSSING_DISTINCT,
    CROSSING_PINNED_MS,
    CROSSING_STALL_MS,
    CROSSING_WINDOW,
    DOOR_SETTLE_MS,
    EDGE_CONFIRM_MS,
    EDGE_CROSSING_WAIT_MS,
    EDGE_NUDGE_MAX_STEPS,
    EDGE_NUDGE_WITHIN,
    EDGE_STEP_IN_WITHIN,
    FACE_EPS,
    FINE_CONFIRM_EVERY,
    FINE_STRIDE,
    FINE_STRIDE_MAX,
    INLAND_MARGIN_SQUARES,
    LEAVE_VIA_CLEARANCE,
    MOVE_HOP_MAX_SQUARES,
    MOVE_INTERVAL_MS,
    OFF_PLAN_STEP_BUDGET,
    PIVOT_ARRIVE_WITHIN,
    PROVED_HOP_MAX_SQUARES,
    Pacer,
    QUEUE_PATIENCE,
    RAIL_SKIP_WITHIN_SQUARES,
    RAIL_STALL_JUMP,
    RAIL_STALL_WAYPOINTS,
    ROOM_RESYNC_MS,
    RUN_VIGOR_FLOOR,
    SHELTER_HIT_WINDOW_MS,
    Session,
    WALK_STALL_STEPS,
    atEdgeOpening,
    bodyWalkArrives,
    declaredJumpNeedsRun,
    orderExits,
    provedSquares,
    resources,
    squaresPerSecond,
    MAX_STEP_HEIGHT,
    MIN_NOMOVEON,
    lanePastBodies,
    perpWalkPastBodies,
    sameRoomDoorPlan,
  });
  for (const name of Object.getOwnPropertyNames(walk)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Session.prototype, name))
      throw new Error(`m59-session-walk.mjs would overwrite Session.${name} — the seam has drifted`);
    Object.defineProperty(Session.prototype, name, Object.getOwnPropertyDescriptor(walk, name));
  }
}
