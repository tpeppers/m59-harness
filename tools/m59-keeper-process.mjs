// m59-keeper-process.mjs — One process per character. Runs the GOAP loop
// and a small HTTP API.
//
// Usage:
//   node tools/m59-keeper-process.mjs --agent t1 --port 8911 --fleet substrate/fleet-state.json
process.env.M59_KEEPER = '1';
//
// The process:
//   1. Reads its agent ID, port, and fleet file from argv
//   2. Loads credentials from the fleet file
//   3. Creates a Session (imported from the broker module)
//   4. Joins the game
//   5. Starts the GOAP autopilot
//   6. Serves a small HTTP API on its port
//   7. Coalesces reader-refreshed state to disk and flushes once on shutdown
//   8. Handles SIGTERM gracefully

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createServer } from 'http';
import { resolve } from 'node:path';
import { Session, Pacer } from './m59-session.mjs';
import { autopilotFor, dropAutopilot, autopilotIfAny, releaseSpot } from './m59-autopilot.mjs';
import { TickLoop } from './m59-tick.mjs';
import { makeDecider, DEFAULT_GOALS, intend, INTENTS } from './m59-decide.mjs';
import { Router, routeIntent } from './m59-route.mjs';
import { protocolToClient, clientToProtocol, buildAllRoomGeometry } from './m59-roo.mjs';
import { loadMap, buildReverseEdges, resolveRoom } from './m59-map.mjs';
import { policyDiff, formatPolicyDiff, coerceSpotPair } from './m59-policydiff.mjs';
// The operator teleport, and the loopback check that is the reason it may exist at all.
import { relocate, isLoopbackHost } from './m59-dm.mjs';
import { attachStepMasks, applyDoorState } from './m59-routes.mjs';
import { recordTactic } from './m59-tactics.mjs';
import inspector from 'node:inspector';
import * as watchdog from './m59-watchdog.mjs';
import './m59-navgeom.mjs';   // installs the height model + lenient fine path onto RoomGeometry
import { resolveFleet } from './m59-fleetpath.mjs';
import { rtsJobReport, rtsSafeSpellRule, rtsSpellTargetAllowed } from './m59-rts-safety.mjs';
import { OF } from './m59-parse.mjs';
import { renderState } from './m59-world.mjs';
import * as skills from './m59-skills.mjs';
import * as party from './m59-party.mjs';
import { chatterFor, fleetChatter } from './m59-chatter.mjs';
import {
  configureSpotClaimStore, rememberFileSpotPartner, spotClaimNamespace,
} from './m59-spotclaims.mjs';
import { verifyFleetLockGuard } from './runtime/fleet-lock.mjs';
import { planAccountLeases } from './runtime/account-leases.mjs';
import { DemandSnapshot } from './runtime/demand-snapshot.mjs';
import { DeferredLatest } from './runtime/deferred-latest.mjs';
import { fallJumpsIn } from './m59-falljump.mjs';

// ---------------------------------------------------------------- args

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const agent = arg('--agent');
const port = Number(arg('--port') || 0);
const fleetName = arg('--fleet') || process.env.M59_FLEET || 'default';
const host = arg('--host') || process.env.M59_HOST || '127.0.0.1';
const serverPort = Number(arg('--server-port') || process.env.M59_PORT || 8899);

if (!agent || !port) {
  console.error('usage: m59-keeper-process.mjs --agent <id> --port <port> [--fleet <name>]');
  process.exit(1);
}

console.error(`[keeper] ${agent} starting on port ${port} (fleet: ${fleetName})`);

// ---------------------------------------------------------------- load credentials

// WHERE A NAMED ROSTER ACTUALLY LIVES — and asked of the module that decides, not copied.
//
// This resolved it itself, as `substrate/fleet-<name>.json`. That file has never existed
// here: the convention is `substrate/fleets/<name>.json`, which `stateFileFor` has always
// known. So every keeper started against a named fleet died on ENOENT before it read a
// credential, the broker's 30s readiness wait timed out, and the rejoin sweep respawned it
// for ever — 116 respawns with three keepers alive out of twenty-one.
//
// A second copy of a path convention is how that happens, so there is no second copy now.
// `resolveFleet` reads the same argv this process was given and honours M59_STATE_FILE and
// M59_FLEET exactly as every other tool does.
const resolvedFleet = resolveFleet(process.argv.slice(2));
const fleetPath = resolvedFleet.stateFile;

let fleet;
try {
  fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
} catch (e) {
  console.error(`[keeper] ${agent} cannot read fleet file ${fleetPath}: ${e.message}`);
  process.exit(1);
}

const entry = fleet[agent];
if (!entry?.credentials) {
  console.error(`[keeper] ${agent} not found in ${fleetPath} or has no credentials`);
  process.exit(1);
}

// WHO IS US, IN A PROCESS THAT HAS NO BROKER IN IT.
//
// `party.isFleetmate` is the one test that keeps this keeper from writing a fleetmate into
// the grudge book and then returning fire on it, and the roster fallback it consults was
// installed only by the broker (`parties.setRosterSource(fleetCharacters)`). In here that
// meant it answered "stranger" for every character in the fleet — for two days, on prod,
// until a mis-click turned one of them red and four keepers killed him. The argument, and
// the assertion that keeps this line here, are above `rosterFileSource` in m59-party.mjs.
//
// Seeded with the roster just parsed so the first answer is right before the first stat;
// re-read on mtime so a character added by hand reaches this process without a restart.
party.setRosterSource(party.rosterFileSource(fleetPath, {
  seed: fleet, extra: [entry.credentials.character],
}));
console.error(`[keeper] ${agent} knows ${party.rosterCharacterNames(fleet).size} fleetmate(s) from ${fleetPath}`);

const { account, password, character } = entry.credentials;
const credHost = entry.credentials.host || host;
const credPort = entry.credentials.port || serverPort;
// THE BOOT ORDERS, AND THEY ARE RE-APPLIED ON EVERY REJOIN — so they are `let`, not
// `const`. `join()` ends with `autopilot.mode = mode; Object.assign(autopilot.policy,
// policy)`, which means the roster snapshot this process read at startup is re-imposed
// every time the character reconnects: the 45s sweep, a phantom recovery, a pilot handing
// the character back. A policy pushed over /policy that updated only the live Autopilot
// would therefore survive until the next rejoin and then silently revert to the boot
// orders — the same disappearing-order bug the push was added to end, just on a longer
// fuse and far harder to catch. /policy updates these too, so a rejoin re-applies the
// CURRENT orders rather than the ones this process happened to start with.
let policy = entry.autopilot?.policy || {};
let mode = entry.autopilot?.mode || 'goap';

// Every character has its own process, so safe-wall reservations need a shared store.
// Scope it to BOTH the resolved roster and the game endpoint: two fleets may use the same
// handles, and one roster may be pointed at two servers. The directory is hidden runtime
// state under substrate (or an explicitly isolated test directory).
try {
  configureSpotClaimStore({
    directory: process.env.M59_SPOT_CLAIMS_DIR || resolve('substrate', '.spot-claims'),
    namespace: process.env.M59_SPOT_CLAIMS_NAMESPACE || spotClaimNamespace({
      fleetPath, host: credHost, port: credPort,
    }),
  });
  rememberFileSpotPartner(agent, policy.partner ?? null);
} catch (e) {
  // Leave the store configured so selection fails closed instead of silently falling back
  // to the per-process Map and recreating the wall pile-up this guard exists to prevent.
  console.error(`[keeper] ${agent} wall claim store unavailable: ${e.message}`);
}
// Log the mode source so a silent revert to 'survive' is visible. This is the value this
// process read from the fleet file at startup. If the broker later rewrites the file, the
// /mode endpoint's file_now field will differ from this.
console.error(`[keeper] ${agent} mode from file at startup: ${JSON.stringify(mode)} (entry.autopilot.mode=${JSON.stringify(entry.autopilot?.mode ?? 'MISSING')})`);

// A KEEPER MAY OUTLIVE ITS BROKER ON WINDOWS. Before constructing a Session or opening a
// game socket, prove that this exact child PID has been installed into both the broker's
// fleet claim and this account's endpoint-normalized claim. The parent passes tokens but
// not credentials in one base64url envelope, then writes our PID immediately after spawn.
// If the parent dies or loses either claim first, verification never succeeds and this
// process exits without logging in.
async function requireKeeperOwnership() {
  const encoded = process.env.M59_KEEPER_OWNERSHIP;
  let permit;
  try {
    permit = JSON.parse(Buffer.from(String(encoded ?? ''), 'base64url').toString('utf8'));
  } catch {
    throw new Error('ownership permit is missing or malformed');
  }
  if (permit?.version !== 1 || permit?.agent !== agent || !permit?.fleet || !permit?.account)
    throw new Error('ownership permit does not name this keeper');
  const expectedAccount = planAccountLeases([{ agent, credentials: {
    account, character, host: credHost, port: credPort,
  } }])[0];
  if (resolve(permit.fleet.path) !== resolve(resolvedFleet.lockFile))
    throw new Error('ownership permit names a different fleet roster lock');
  if (resolve(permit.account.path) !== resolve(expectedAccount.path) ||
      permit.account.subject !== expectedAccount.subject)
    throw new Error('ownership permit does not match the roster credentials read by this keeper');
  const checks = [permit.fleet, permit.account];
  for (let attempt = 0; attempt < 50; attempt++) {
    const held = checks.every(claim => verifyFleetLockGuard(claim.path, {
      pid: claim.pid,
      token: claim.token,
      kind: claim.kind,
      subject: claim === permit.account ? expectedAccount.subject : null,
      guardPid: process.pid,
    }).ok);
    if (held) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('broker did not install both ownership guards before login');
}

try { await requireKeeperOwnership(); }
catch (error) {
  console.error(`[keeper] ${agent} refused before Session/login: ${error.message}`);
  process.exit(3);
}

// ---------------------------------------------------------------- session

const session = new Session(agent);
session.pacer; // exists from constructor

let autopilot = null;
// The deterministic responder, held so `/state` can report whether this character can
// actually hear -- see the attach in join(). Keeper stderr is discarded by the spawner
// (`stdio: 'ignore'`), so a log line is not evidence of anything and the state is.
let chatter = null;
let inGame = false;
let startedAt = Date.now();
// Every successful login starts a new connection epoch. The broker uses this to discard
// `connected:false` evidence gathered against the previous socket instead of immediately
// declaring a freshly rejoined character phantom.
let connectionRevision = 0;
let initialJoinRetryTimer = null;
let joinWanted = true;
let joinGeneration = 0;
let keeperJoinInFlight = null;

function cancelInitialJoinRetry() {
  if (initialJoinRetryTimer !== null) clearTimeout(initialJoinRetryTimer);
  initialJoinRetryTimer = null;
}

function scheduleInitialJoinRetry() {
  if (!joinWanted) return false;
  if (initialJoinRetryTimer !== null) return false;
  let handle = null;
  const retry = async () => {
    if (initialJoinRetryTimer !== handle) return;
    initialJoinRetryTimer = null;
    if (!joinWanted) return;
    if (inGame && session.live) return;
    try { await join(); }
    catch { if (joinWanted) scheduleInitialJoinRetry(); }
  };
  handle = setTimeout(retry, 30_000);
  initialJoinRetryTimer = handle;
  handle.unref?.();
  return true;
}

function changeJoinIntent(wanted) {
  joinWanted = wanted;
  joinGeneration++;
  cancelInitialJoinRetry();
  return joinGeneration;
}

function assertJoinIntent(generation) {
  if (joinWanted && generation === joinGeneration) return;
  if (session.client) { try { session.client.close(); } catch {} }
  inGame = false;
  throw new Error('keeper join was superseded by a newer leave/rejoin intent');
}

// ------------------------------------------------------- the errand hold
//
// AN ERRAND'S HOLD ON A CHARACTER, WHICH THE BROKER USED TO TAKE BY REACHING INTO A
// KEEPER OBJECT IT NO LONGER HAS.
//
// `supplyBetween` in m59-broker.mjs held both ends of a trade still with
// `autopilotIfAny(name).stop(...)` and put them back with `.start()`. That was right when
// the keeper ran inside the broker. It is now a no-op: `resumeFleet` calls
// `dropAutopilot` for every keeper-backed character, so `autopilotIfAny` answers
// undefined and the hold silently did nothing — both keepers kept driving straight
// through the four-step trade handshake, which is the failure the hold was written to
// prevent (see the note on `holdStill` over there: a receiver's keeper cancelling an
// offer leaves the goods in a dead trade window, and the next three deliveries then
// report "carrying nothing matching food").
//
// So the hold lives here now, with the body. Two drivers, two ways to stop one:
//
//   goap/bt  `goInert` — the documented state for an ERRAND (m59-autopilot.mjs:376 names
//            a supply exchange as its example). The keeper keeps LOOKING; it stops
//            moving, swinging, speaking and trading.
//   tick     `loop._frozen` — the tick driver's own hold, already used by the cast
//            override for the same reason: a decide at 10Hz sends move packets that
//            interrupt whatever else is being attempted. `autopilot.stop()` is NOT usable
//            here — in tick mode `start` is `() => {}`, so a stopped tick loop can never
//            be restarted and the hold would be permanent.
//
// ONE HOLD AT A TIME, AND IT IS NAMED. A second caller is refused rather than layered,
// because the failure that matters is two errands each reviving the other's hold. The
// token is what a release must present, and a release with the wrong token is refused.
//
// AND IT HAS A DEADLINE. `goInert` carries its own (INERT_MAX_MS) and `_frozen` carries
// none at all, so a broker that died mid-exchange would freeze a tick-driven character
// for the rest of the session. The timer below is that floor, for both kinds.
let errandHold = null;      // { token, why, at, maxMs, kind, timer }
let errandHoldSeq = 0;

function holdReport() {
  if (!errandHold) return null;
  return { token: errandHold.token, why: errandHold.why, kind: errandHold.kind,
           since: errandHold.at, seconds: Math.round((Date.now() - errandHold.at) / 1000),
           max_ms: errandHold.maxMs };
}

// AND A HOLD HAS TO BE RE-ASSERTABLE BY WHOEVER TOOK IT.
//
// The deadline below exists so a caller that dies cannot silence a character for ever, and
// it does not know how long the caller's errand is. The broker's travel tool has the same
// note and learned it the hard way: "a stale supply hold lapsed mid-walk, the keeper woke
// up, and the character was being driven by the keeper and by travel at the same time — the
// exact contention this is for". A supply exchange walks one character to the other and
// then trades, and the walk can outlast the hold the walk itself took.
//
// So presenting the token in force RENEWS it rather than being refused. Presenting no token,
// or the wrong one, is still refused: this must not become a way to take somebody else's.
function renewHold(maxMs) {
  clearTimeout(errandHold.timer);
  errandHold.maxMs = maxMs;
  errandHold.renewedAt = Date.now();
  // The keeper's own inert deadline is a separate clock and would otherwise wake it on the
  // original one. `goInert` returns early when already inert, so this moves it in place.
  if (errandHold.kind === 'inert' && autopilot?.inert) {
    autopilot.inert.at = Date.now();
    autopilot.inert.maxMs = maxMs;
  }
  const token = errandHold.token;
  errandHold.timer = setTimeout(() => {
    if (errandHold?.token !== token) return;
    console.error(`[keeper] ${agent} errand hold expired after ${Math.round(maxMs / 1000)}s — releasing`);
    releaseKeeper('hold deadline — whoever took it never gave it back', token);
  }, maxMs);
  errandHold.timer.unref?.();
  return { held: true, ours: true, renewed: true, hold: holdReport() };
}

function holdKeeper(why, maxMs, token = null) {
  if (errandHold) {
    if (token && token === errandHold.token) return renewHold(maxMs);
    return { held: false, ours: false, reason: `already held: ${errandHold.why}`, hold: holdReport() };
  }
  if (!autopilot)
    return { held: false, reason: 'nothing is driving this character, so there is nothing to hold' };
  const tick = !!autopilot._tickLoop;
  if (tick) {
    const loop = autopilot._tickLoop;
    // Somebody else's freeze — the cast override holds it the same way. Leave it: taking
    // it would mean releasing it, and releasing a cast's freeze breaks the cast.
    if (loop._frozen)
      return { held: false, reason: 'the tick loop is already frozen by something else' };
    loop._frozen = true;
  } else {
    if (autopilot.inert)
      return { held: false, reason: `already held: ${autopilot.inert.why ?? 'no reason given'}` };
    autopilot.goInert?.(why, { maxMs });
  }
  errandHold = { token: `hold-${agent}-${++errandHoldSeq}`, why, at: Date.now(), maxMs,
                 kind: tick ? 'tick' : 'inert' };
  const holdToken = errandHold.token;
  errandHold.timer = setTimeout(() => {
    if (errandHold?.token !== holdToken) return;
    console.error(`[keeper] ${agent} errand hold expired after ${Math.round(maxMs / 1000)}s — releasing`);
    releaseKeeper('hold deadline — whoever took it never gave it back', holdToken);
  }, maxMs);
  errandHold.timer.unref?.();
  console.error(`[keeper] ${agent} held (${errandHold.kind}) — ${why}`);
  return { held: true, ours: true, hold: holdReport() };
}

function releaseKeeper(why, token) {
  if (!errandHold) return { released: false, reason: 'nothing was holding this character' };
  if (token && token !== errandHold.token)
    return { released: false, reason: 'that is not the hold in force', hold: holdReport() };
  const h = errandHold;
  errandHold = null;
  clearTimeout(h.timer);
  try {
    if (h.kind === 'tick') { if (autopilot?._tickLoop) autopilot._tickLoop._frozen = false; }
    else autopilot?.revive?.(why);
  } catch (e) {
    console.error(`[keeper] ${agent} release failed: ${e.message}`);
    return { released: false, reason: e.message };
  }
  console.error(`[keeper] ${agent} released after ${Math.round((Date.now() - h.at) / 1000)}s — ${why}`);
  return { released: true, held_ms: Date.now() - h.at, was: h.why };
}

// ---------------------------------------------------------------- join

async function joinGenerationOnce(generation) {
  try {
    await session.join({
      account, password, character,
      host: credHost, port: credPort,
    });
    assertJoinIntent(generation);
    inGame = true;
    connectionRevision++;
    cancelInitialJoinRetry();
    console.error(`[keeper] ${agent} joined as ${session.client?.me?.name ?? character}`);

    // THE DOORS THAT ARE FLOORS — move the bake to the state the SERVER says it is in.
    //
    // A Meridian 59 door is usually a sector that lifts past the 384-unit step limit, and
    // the .roo ships whichever state the room was authored in. So the bake held the Duke's
    // feast door shut for ever: four journeys walked eleven hops to Blackstone Keep, could
    // not take the last step, and the doctrine reported the hall LOCKED for a day while it
    // stood open. `applyDoorState` swaps in the mask baked for the live state and moves the
    // sector heights under it, so the router and the mover change their minds together —
    // the mask alone moves only the router, and that is a plan the mover then refuses.
    //
    // ARRIVAL IS COVERED, not just changes we happen to witness. room.kod's SetSector keeps
    // every change in `plSector_changes` and `SendSectorChanges` replays the lot at speed 0
    // to a user "when gets into new room" — so a character walking into a room whose door
    // opened yesterday is told about it, and this fires on that just as it does on a door
    // moving in front of us.
    session.client?.on?.('sector-height', () => {
      // `session.world.room.num` and NOT the client's `room.id`, which is the room OBJECT
      // id — a different number, and one this repository already warns is not stable.
      const num = Number(session.world?.room?.num);
      if (!Number.isFinite(num)) return;
      try {
        const out = applyDoorState(loadMap(), num, session.client?.room?.sectorHeights ?? new Map());
        // Only the transitions, never the steady state — this fires per packet and a door
        // that is animating sends a stream of them.
        if (out.changed) console.error(`[keeper] ${agent} room ${num} doors -> ${out.state ?? 'as shipped'}`);
        // An unbaked state is worth one line, because it is the case where we KNOW the bake
        // disagrees with the server and are deliberately not guessing. Silence here is how
        // the feast hall went unexplained for a day.
        else if (out.unbaked) console.error(`[keeper] ${agent} room ${num} ${out.why}`);
      } catch (error) { console.error(`[keeper] ${agent} door state: ${error.message}`); }
    });

    // LISTEN. THIS IS WHERE THE SOCKET IS, AND FOR A YEAR IT WAS NOWHERE.
    //
    // `m59-broker.mjs` attaches a Chatter on join and its comment explains why: "the
    // conversational machinery was all present and none of it was switched on... `fleet`
    // dutifully reported `listening: false` for all twenty-five and it read as a field
    // rather than a fault." That fix is real and it is on the IN-PROCESS path -- the
    // fallback. Every keeper-backed character, which is every character in both live
    // fleets, goes down the other branch and was never given one.
    //
    // So the whole deterministic responder has been dead since the fleet moved to keeper
    // processes: the same symptom, `listening: false` twenty-one times, in a different
    // place. It has to be here because the keeper owns the socket and therefore `onSaid`;
    // the broker holds a KeeperProxy whose client is a picture, not a wire.
    //
    // The hooks are the ones this process can answer honestly. The keeper knows its own
    // autopilot and its own roster, so peers, status, the debug report and the freeze are
    // all local facts. It does NOT know which client a human is sitting at -- that is the
    // broker's `pilotedSpeaker`, bound to a live local pid -- so `isOperator` and
    // `operatorInstruction` are simply not offered, and the chatter treats their absence
    // as "this is a stranger", which is the safe reading.
    // OPT IN, PER FLEET. See DEFAULT_CHATTER_POLICY.listen: attaching for everybody would
    // put prod into conversation with real players as a side effect of fixing a bug.
    const wantChat = fleetChatter(fleetName);
    if (!wantChat.listen) {
      console.error(`[keeper] ${agent} stays silent — fleet "${fleetName}" has not asked to listen`);
    } else try {
      chatter = chatterFor(session, {
        policy: { ack: true, smallTalk: true, faceSpeaker: true, escalate: true, ...wantChat },
        hooks: {
          // Two auto-responders greeting each other do so for ever and the server does
          // not rate limit speech. The roster is the keeper's own -- see the 2026-08-27
          // correction about a keeper process calling its whole fleet strangers.
          // The id is an object in the room; `isFleetmate` wants a NAME, so it is resolved
          // through this keeper's own client. A speaker we cannot name is not a peer, which
          // errs toward answering a stranger rather than ignoring a fleetmate -- the wrong
          // way round would be two bots talking to each other for ever.
          isPeer: (id) => {
            try {
              const c = session.client;
              const o = c?.room?.objects?.get?.(id);
              const nm = o ? c.rsc?.get?.(o.nameRsc) : null;
              return nm ? party.isFleetmate(nm) : false;
            } catch { return false; }
          },
          autopilotStatus: () => { try { return autopilot?.status?.() ?? null; } catch { return null; } },
          debugReport: () => { try { return autopilot?.debug ? autopilot.debugLines() : null; }
                               catch { return null; } },
          keeperFrozen: () => !!(autopilot?.frozenUntil && Date.now() < autopilot.frozenUntil),

          // WHICH ROOMS COULD THAT BE. `resolveRoom` already answers a number, an exact
          // name, or a single partial, and THROWS with `err.ambiguous` listing the rest --
          // which is exactly the shape the rule wants, so the throw is turned back into
          // data rather than being treated as a failure.
          resolveRooms: (q) => {
            try {
              const map = loadMap();
              try {
                const num = resolveRoom(map, q);
                if (num == null) return { matches: [] };
                return { matches: [{ num, name: map.rooms[String(num)]?.name ?? String(num) }] };
              } catch (e) {
                if (Array.isArray(e.ambiguous)) return { matches: e.ambiguous };
                return { error: e.message };
              }
            } catch (e) { return { error: e.message }; }
          },

          // AND TAKE THEM THERE. The two refusals are the whole safety argument and both are
          // checked here, before anything is sent:
          //
          //   * LOOPBACK ONLY. The maintenance port is unauthenticated, and `m59-dm.mjs`
          //     refuses a non-loopback host for that reason. This checks the same fact about
          //     the game server this keeper is logged in to, so the capability cannot exist
          //     on prod even if a chatter file turned the policy on by mistake.
          //   * IT MOVES THE SPEAKER. Never this character, never a third party -- the name
          //     comes from the speech event, and the worst outcome of any confusion is that
          //     the operator is standing somewhere they did not expect.
          //
          // Fired and not awaited: the reply should arrive with the move, not after a
          // round-trip to the admin socket, and a failure is logged rather than spoken twice.
          teleportOperator: (num, who) => {
            if (!isLoopbackHost(credHost))
              return { queued: false, why: `${credHost} is not loopback` };
            if (!who) return { queued: false, why: 'I could not tell who asked' };
            relocate([who], num, {}, { env: process.env })
              .then(r => console.error(`[keeper] ${agent} sent ${who} to room ${num}: ` +
                                       `${r?.ok === false ? r.why : 'ok'}`))
              .catch(e => console.error(`[keeper] ${agent} could not send ${who} to ${num}: ${e.message}`));
            return { queued: true };
          },
        },
      });
      chatter.reattach();
      console.error(`[keeper] ${agent} is listening` +
        (wantChat.debugAnswers ? ' (debug answers on)' : ''));
    } catch (e) {
      console.error(`[keeper] ${agent} could not listen: ${e.message}`);
    }

    // Start the autopilot: GOAP (default) or tick driver
    // THE STEP MASKS GO ON WHATEVER MODE THIS KEEPER IS IN.
    //
    // They were attached inside the `tick` warm-up below, and these keepers run `idle`/goap.
    // So `geo.hasStepMask` was false for every live character, and `World.exits()` reads
    // exactly that flag: `moverBySquare = geo.hasStepMask ? flood(true) : coarseBySquare`.
    // With no mask the mover flood silently BECOMES the coarse flood, and the coarse grid
    // has no falls and no heights -- it is symmetric, so it happily walks back up a cliff.
    //
    // Measured in Ukgoth from the gutter at 61,27: the mover flood reaches 319 squares and
    // not the Castle Victoria door; the coarse flood reaches 4,673 and does. The router
    // therefore planned a single hop 599 -> 2 at a door on top of a cliff the character
    // cannot climb, which is how characters that miss the jump die down there rather than
    // taking the long way round through 589.
    //
    // `attachStepMasks` is cheap and idempotent -- it is the reverse-edge and geometry build
    // beside it that costs ~12s, and those stay where they were. The bake exists to be
    // planned on; a keeper that never attaches it is planning on the map the bake replaced.
    try { attachStepMasks(loadMap()); }
    catch (e) { console.error(`[keeper] ${agent} could not attach step masks: ${e.message}`); }

    assertJoinIntent(generation);
    if (mode === 'tick') {
      // WARM THE MAP THIS KEEPER'S ROUTER WILL USE, before the Router loads it.
      // loadMap() is cached per process, so calling it here (and building on the SAME map
      // object) means the Router's own loadMap() gets the warmed instance. Without this,
      // the first findPath the router runs pays a ~13s reverse-edge/geometry build on the
      // FIRST tick, stalling the loop. See m59-broker.mjs / m59-game.mjs for the rationale.
      // A keeper lives one login session; a single ~12s warm at startup is acceptable (it is
      // not repeated per rejoin in a way that matters, and it is off the tick path).
      try {
        const _wt0 = Date.now();
        const _wmap = loadMap();
        attachStepMasks(_wmap);
        buildReverseEdges(_wmap);   // no-ops if already built (idempotent)
        buildAllRoomGeometry(_wmap);
        console.error(`[keeper] ${agent} map warmed at startup in ${Date.now() - _wt0}ms` +
                      ` (reverse=${_wmap.__reverse?.size ?? 0} rooms)`);
      } catch (e) {
        console.error(`[keeper] ${agent} map warm failed (${e.message}); will build lazily on first use`);
      }
      const router = new Router({ session });
      session._mover = router.mover;
      session._router = router;
      INTENTS.travel = routeIntent(router);

      const plannerDecide = makeDecider({ session, goals: DEFAULT_GOALS,
        onDecision: (d) => {
          // Log decisions that change, not every tick.
          const line = `${d.goal ?? 'idle'}${d.action ? ' -> ' + d.action : ''}${d.what ? ' (' + d.what + ')' : ''}${d.why ? ' — ' + d.why : ''}`;
          if (line !== lastTickLog) {
            lastTickLog = line;
            console.error(`[tick] ${agent} ${line}`);
          }
        }
      });
      let lastTickLog = '';
      let decideTimes = [];  // rolling window of decide durations
      let lastMetricsLog = 0;
      session._tickDecide = plannerDecide;  // expose for state/3D target
      const decide = (frame, act, loop) => {
        const t0 = Date.now();
        if (router.dest != null) {
          const r = intend('travel', frame, act, { client: session.client, session, ws: {} });
          if (r.sent) { decideTimes.push(Date.now() - t0); _maybeLogMetrics(); return; }
        }
        plannerDecide(frame, act, loop);
        decideTimes.push(Date.now() - t0);
        _maybeLogMetrics();
      };
      function _maybeLogMetrics() {
        const now = Date.now();
        if (now - lastMetricsLog < 30000) return; // every 30s
        if (decideTimes.length < 10) return;
        lastMetricsLog = now;
        const sorted = [...decideTimes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        const max = sorted[sorted.length - 1];
        const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        console.error(`[tick-metrics] ${agent} n=${decideTimes.length} median=${median}ms p99=${p99}ms max=${max}ms avg=${avg}ms`);
        decideTimes = []; // reset window
      }

      const loop = new TickLoop({
        session, decide, hz: 10,
        onSessionDead: ({ staleMs }) => {
          // The session is a ghost: no server data for staleMs while we believed
          // we were in game. The client is replaying stale in-memory state — the
          // character is invisible to anyone actually on the server (this is what
          // happened to JayB in the Mausoleum: 0% CPU, "fighting" a frozen
          // position). The fix is a fresh login, not a local reset — the in-memory
          // world is wrong, so we must let the broker rejoin us. Stop the loop and
          // exit; the broker's reconcile (45s) restarts a clean keeper.
          console.error(`[keeper] ${agent} LIVENESS: session stale (${Math.round(staleMs/1000)}s no server data) — exiting for rejoin`);
          try { loop.stop(); } catch {}
          // Give the log a beat to flush, then exit non-zero so it is distinguishable
          // from a crash. process.exitCode is set, not process.exit, so any pending
          // writes get a chance to flush on the natural tick end.
          setTimeout(() => process.exit(42), 500);
        },
      });
      // Expose the loop on the session so the /action cast override can freeze it
      // (hold the character still) while a spell is casting — movement breaks
      // concentration and fails the cast.
      session._tickLoop = loop;
      // The survival floor: watchdog over the tick driver.
      const { safetyFor } = await import('./m59-skills.mjs');
      const wdHost = {
        s: session, watch: null, inert: false, hold: null,
        doing: router.dest != null ? 'travelling' : null,
        passes: 0, passStartedAt: null, lastFrameAt: 0, tally: {},
        safety: () => safetyFor(session.client, {}),
        recordFrame() { this.lastFrameAt = Date.now(); },
        note: (what, d) => console.error(`[keeper] ${agent} ! ${what}${d?.why ? ' — ' + d.why : ''}`),
        progress: () => {},
      };
      // The dynamic import above yields. A leave/rejoin may have invalidated this attempt
      // while it loaded, so check again before either driver is allowed to start.
      assertJoinIntent(generation);
      autopilot = { start: () => {}, stop: () => { loop.stop(); watchdog.stop(wdHost); }, mode, policy,
                    _tickLoop: loop, _router: router, _wdHost: wdHost };
      loop.start();
      watchdog.start(wdHost);
      console.error(`[keeper] ${agent} tick driver started (10hz, watchdog on)`);
    } else {
      autopilot = autopilotFor(session);
      autopilot.mode = mode;
      Object.assign(autopilot.policy, policy);
      assertJoinIntent(generation);
      autopilot.start();
      console.error(`[keeper] ${agent} autopilot started (mode=${mode}, hunt=${policy.hunt ?? 'none'})`);
    }
  } catch (e) {
    console.error(`[keeper] ${agent} join failed: ${e.message}`);
    throw e;
  }
}

// One keeper-level join at a time. Session.join coalesces the socket login itself; this
// wrapper also coalesces all of the post-login chatter/autopilot setup and serializes a new
// rejoin intent behind an older attempt. A leave increments joinGeneration and waits for
// the old attempt to observe that invalidation before it can report the character out.
async function join() {
  if (!joinWanted) throw new Error('keeper is intentionally left out of game');
  const generation = joinGeneration;
  const current = keeperJoinInFlight;
  if (current) {
    if (current.generation === generation) return current.promise;
    await current.promise.catch(() => null);
    assertJoinIntent(generation);
    if (inGame && session.live) return session.snapshot('already in game');
  }
  if (inGame && session.live) return session.snapshot('already in game');
  const promise = joinGenerationOnce(generation);
  const record = { generation, promise };
  keeperJoinInFlight = record;
  try { return await promise; }
  finally { if (keeperJoinInFlight === record) keeperJoinInFlight = null; }
}

// ---------------------------------------------------------------- state

function state() {
  const c = session.client;
  const me = c?.me;
  const roomBinding = session.world?.roomBinding ?? null;
  const room = roomBinding?.room ?? session.world?.room;
  const roomWire = roomBinding?.room_wire ?? null;
  const v = c?.vitals?.() || {};
  // THE AUTHORITATIVE KEEPER STATUS CROSSES THE PROCESS BOUNDARY AS ONE OBJECT.
  //
  // The broker used to reconstruct this object from a handful of fields in `/state` and
  // fill everything else with plausible zeroes/nulls.  In production every keeper is in
  // this process, so that made `did.deaths`, safe-wall evidence, threat, recent decisions,
  // coordination and the live policy permanently stale or absent in the broker and TUI.
  // `status()` already owns the definitions; publish its non-full form rather than growing
  // a second, inevitably drifting list here.  It is computed locally and sends no packet.
  let autopilotStatus = null;
  try { autopilotStatus = autopilot?.status?.({ full: false }) ?? null; }
  catch (e) {
    // A status projection must never take the keeper down.  The surrounding snapshot still
    // carries vitals/position and the explicit error distinguishes missing telemetry from 0.
    autopilotStatus = { projection_error: e.message, running: !!autopilot?.running,
                        mode: autopilot?.mode ?? mode };
  }
  return {
    agent,
    character: me?.name ?? character,
    pid: process.pid,
    in_game: inGame,
    connection_revision: connectionRevision,
    // WHAT WE BELIEVE vs WHAT THE SOCKET SAYS.
    //
    // `inGame` is set true on a successful join and cleared ONLY by /leave and /rejoin —
    // nothing clears it when the SERVER drops us, which is what happens every time a
    // person logs in on the character. The keeper then reports in_game:true for ever on a
    // dead connection: every plan succeeds, every action comes back "not in game", and
    // hp/vigor/pack freeze at the last values read. Four of twenty-one prod characters
    // were in that state when this was written.
    //
    // `connected` is the Session's own liveness (client.state === 'game'). It is reported
    // BESIDE in_game rather than replacing it because the state field LAGS after a rejoin
    // — see the rawmove note below — so a reader that treats one false sample as death
    // will rejoin healthy characters. Judge them together, with hysteresis.
    connected: !!session.live,
    // Stable room RID and live room object id are different namespaces. The latter is
    // renumbered by server saves and is the generation guard used by RTS packets.
    room: room ? { name: c?.rsc?.get?.(room.nameRsc) ?? room.name, num: room.num,
                   object_id: c?.room?.id ?? null } : null,
    // Exact BP_PLAYER provenance. Null means the complete resource pair did not
    // select one configured map row; never substitute the runtime object id or a
    // checksum/resource read from that map.
    room_wire: roomWire,
    hp: v.health ? { value: v.health.value, max: v.health.max } : null,
    vigor: v.vigor ? { value: v.vigor.value, max: v.vigor.max } : null,
    mana: v.mana ? { value: v.mana.value, max: v.mana.max } : null,
    gold: me?.gold ?? null,
    // WHAT YOU ARE WEARING IS NOT A FILTER ON WHAT YOU CARRY, and this was.
    //
    // `client.equipment()` is the only answer — it is the first line of the protocol traps
    // note and it was being ignored here in favour of `flags & 0x04` over the pack. The
    // result: Kermit wielding a mace reported `equipment: []` with "mace" listed under
    // `pack`, so every consumer of this snapshot believed the fleet was unarmed. The broker
    // proxy builds its whole emulated client from this object, so one wrong list here is
    // wrong everywhere the broker looks.
    equipment: (() => {
      try {
        const eq = c?.equipment?.();
        return (eq?.equipped ?? []).map(o => o.name ?? c?.rsc?.get?.(o.nameRsc) ?? '').filter(Boolean);
      } catch { return []; }
    })(),
    // STRUCTURED, BECAUSE `pack` IS PROSE. "elderberry (x30)" is for a human reading a
    // dashboard; a tool that wants to know whether twenty elderberry are aboard has to
    // parse English out of it. Both are kept: `pack` is unchanged for everything already
    // reading it, `items` is what the proxy's `client.inventory` is built from.
    // WHAT `view()` NEEDS, BECAUSE THE BROKER CANNOT BUILD IT.
    //
    // `arrivalReport` — used by `travel`, `go_through` and `leave` — calls `s.view()` and
    // then `v.objects.filter(...)`. The proxy returned this raw state object, which has no
    // `objects` and no `exits`, so every one of those tools died with
    // "Cannot read properties of undefined (reading 'filter')" on a keeper-backed broker.
    // That is the whole of "twenty-one of twenty-one travels refused": not a movement bug,
    // a shape bug, one property deep.
    //
    // Compact on purpose. The full object list is what `/room-view` is for; this is polled
    // every two seconds for every character, so it carries what the report actually reads —
    // where we are, what is here and what it can do — and nothing else.
    you: (() => {
      const me = c?.self;
      // THE OBJECT ID, WITHOUT WHICH THE BROKER'S SELF IS A PLACEHOLDER.
      //
      // The emulated client filled `selfId` with -1 because this did not carry one, and -1
      // is a number the server has never heard of. Everything that acts ON the character
      // therefore aimed at nothing: `apply(food, selfId)` is how eating works (food.kod:56)
      // and `look(selfId)` is how the faction read refreshes. Both are packets that would
      // have been sent to object -1 the moment the broker gained a mutation path.
      //
      // `objects` below already filters self out by the same id, so nothing that reads the
      // room changes shape because this is now real.
      return me ? { id: c.selfId ?? null, col: me.col, row: me.row,
                    x: me.x, y: me.y, facing: me.facing ?? null } : null;
    })(),
    objects: (() => {
      try {
        const me = c?.self;
        return [...(c?.room?.objects?.values?.() ?? [])]
          .filter(o => o.id !== c.selfId)
          .map(o => ({
            id: o.id,
            name: c.rsc?.get?.(o.nameRsc) ?? '',
            // THE RAW FLAGS, not a guess at what they mean. The broker rebuilds an object
            // list from this and its callers test `o.flags & OF.ATTACKABLE` themselves —
            // 0x0008 attackable, 0x0004 player, per m59-bt-combat.mjs. Re-deriving booleans
            // here and flags there is two homes for one fact, and the second one is always
            // the one that is wrong.
            flags: o.flags ?? 0,
            is_player: !!((o.flags ?? 0) & 0x0004),
            // AND WHERE IT IS. The travel guard asks `Math.hypot(o.col - me.col, o.row -
            // me.row) <= 2` — "what is close enough to be swinging at us" — so an object
            // list without positions answers "nothing is near" for a character being eaten.
            col: o.col ?? null, row: o.row ?? null,
            // AND WHERE IN THE SQUARE, for the same reason the row above exists: a square is
            // a summary. Two bodies fit inside one, so "is something on that square" and "can
            // I get past it" are different questions and only these answer the second. The
            // mover threads on them (`bodiesInSquare` / `aimInto`), and a state view that
            // cannot show them cannot be used to tell a squeeze from a collision — which is
            // exactly the diagnosis this projection was needed for on 2026-08-27.
            x: o.x ?? null, y: o.y ?? null,
          }));
      } catch { return []; }
    })(),
    exits: (() => {
      try { return (session.world?.exits?.() ?? []).map(e => ({ to: e.to, direction: e.direction })); }
      catch { return []; }
    })(),
    // AMOUNT AS THE WIRE REPORTED IT, WHICH FOR A NON-STACK IS ZERO AND NOT ONE.
    //
    // This said `?? 1`, and that one character destroys the only distinction that decides
    // how an item may be OFFERED. `extractObject` files an amount only for an object the
    // server tagged as a NumberItem and zero for everything else, and `UserDropItems` pairs
    // a PARALLEL number list against exactly those — positionally. So an offer has to carry
    // a count for every stack and none for anything else, and coercing every item to 1 made
    // a sword indistinguishable from a herb.
    //
    // Measured: Hhhh could hand Jjjj neither its elderberry nor its herbs — handshake
    // complete, `may_accept` true, nothing moved, in both directions. Nobody was full; the
    // id list was malformed. `tag` is the server's own answer and is carried beside it, so
    // `dropSpec` can ask the authoritative question rather than infer from a quantity.
    items: c?.inventory ? c.inventory.map(o => ({
      id: o.id,
      name: c.rsc?.get?.(o.nameRsc) ?? '',
      amount: o.amount ?? 0,
      tag: o.tag ?? null,
      flags: o.flags ?? 0,
    })).filter(o => o.name) : [],
    // Load is derived beside the live client because might and the authoritative
    // inventory both live here. The broker's KeeperProxy cannot reconstruct might;
    // publishing the measured result lets same-room transfers fail closed on receiver
    // capacity instead of treating an unknown load as empty.
    carry: c ? skills.carryCapacity(c) : { known: false, why: 'client is unavailable' },
    pack: c?.inventory ? c.inventory
      .filter(o => !(o.flags & 0x04))
      .map(o => {
        const name = c.rsc?.get?.(o.nameRsc) ?? '';
        return o.amount > 1 ? `${name} (x${o.amount})` : name;
      })
      .filter(Boolean) : [],
    skills: (c?.skills ?? []).map(s => ({
      name: c.rsc?.get?.(s.nameRsc) ?? '',
    })).filter(s => s.name),
    spells: (c?.spells ?? []).map(s => ({
      id: s.id,
      name: c.rsc?.get?.(s.nameRsc) ?? '',
      school: s.school,
      mana: s.mana,
      targets: s.numTargets,
    })).filter(s => s.name),
    // STUCK, AS A FACT THE FLEET BOARD CAN READ.
    //
    // The keeper has known this all along — `stalledSince` is set after five idle passes and
    // `stalledWhy` says what it was trying to do — and none of it left this process. The
    // broker's proxy answered `stalled: false` unconditionally, so on the architecture
    // production now runs the fleet board could not report a stuck character at all: it said
    // everything was fine while a body stood in a corner for twenty minutes.
    //
    // Published here rather than derived over there, because "did anything happen in the last
    // five passes" is a question only the process running the passes can answer.
    stuck: (autopilot?.stalledSince)
      ? { since: autopilot.stalledSince,
          seconds: Math.round((Date.now() - autopilot.stalledSince) / 1000),
          why: autopilot.stalledWhy ?? null }
      : null,
    // IS THIS CHARACTER IN THE MIDDLE OF SOMETHING. `KeeperProxy.jobReport()` returns a
    // hardcoded `null`, so on a keeper-backed broker — every broker — `busy` was absent
    // from `status` and from every fleet row, and absent reads as `false` to everything
    // downstream. That is not a cosmetic gap: `m59-circuit.mjs` abandons a leg when a
    // character is not busy and has not changed room for three polls, so it declared 0/21
    // arrived on a fleet that was still walking, and its own comment describes being
    // caught by exactly this once before with a different cause. The job slot lives here,
    // with the body; the broker holds a snapshot and cannot see it.
    // WHERE THE EVENT STREAM HAD GOT TO WHEN THIS SNAPSHOT WAS TAKEN.
    //
    // The broker's emulated client answered `waitFor` with "there is no event stream here",
    // which was true and cost eight MCP tools: everything that sends a packet and then
    // reads what the server said — attack, cast, shop, act, look — either threw or reported
    // that it had seen nothing. The stream is on this process's socket and stays here; what
    // crosses is a WINDOW into it (`/action {name:"events"}`), and a window needs a mark to
    // start from. This is that mark. It is as old as the snapshot carrying it, so a wait
    // anchored on it reaches slightly further back than the caller meant — which errs
    // toward returning the reply rather than missing it, and every caller filters by kind.
    ev_seq: session.client?.evSeq ?? null,
    job: rtsJobReport(session.job) ?? null,
    // AND WHETHER SOMEBODY ELSE IS HOLDING IT STILL. `KeeperProxy.status()` reported
    // `inert: null` unconditionally, so a character standing still because a supply
    // exchange had deliberately stopped its keeper was indistinguishable on the board from
    // one that had stalled. That is the distinction m59-supervise.mjs unsticks on, and
    // unsticking a character mid-trade is the contention the hold exists to prevent.
    hold: holdReport(),
    goap: autopilot ? {
      goal: autopilot._goapKeeper?.state()?.goal ?? null,
      action: autopilot._currentAction ?? null,
      // In tick mode the driver is session._tickDecide, NOT autopilot.running
      // (which stays false because the autopilot's own loop isn't the driver).
      // Report running=true when EITHER is active, or the broker's proxy sees
      // goap.running undefined and reports "no keeper" for a character that is
      // actually being driven — the dashboard then says nothing is driving JayB
      // while the tick driver is swinging at mummies.
      running: autopilot.running || !!(session._tickDecide),
      mode: autopilot.mode,
      useGOAP: autopilot.policy?.useGOAP ?? false,
      plan: autopilot._goapKeeper?.state() ?? null,
      // Tick driver target (for the 3D viewer).
      target: (autopilot.mode === 'tick' && session._tickDecide)
        ? (() => {
            const tid = session._tickDecide.state?.()?.targetId ?? null;
            if (tid == null) return null;
            const t = c?.room?.objects?.get?.(tid);
            if (!t) return null;
            return { id: tid, col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) ?? '', in_band: true };
          })()
        : null,
    } : null,
    // Full live autopilot projection used by KeeperProxy.status() and the terminal TUI.
    // `goap` above stays as the compact movement/render shape; this is the operational
    // status shape.  Keeping both named prevents a reader from mistaking one for the other.
    autopilot_status: autopilotStatus,
    // CAN THIS CHARACTER HEAR. The broker's `fleet` reported `listening: false` for every
    // keeper-backed character and it was TRUE -- the chatter was only ever attached on the
    // in-process fallback path. Reported from here now, because here is where the socket is.
    listening: !!chatter?.attached,
    chatter: chatter ? { debug_answers: !!chatter.policy?.debugAnswers,
                         small_talk: !!chatter.policy?.smallTalk } : null,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    // WHERE THIS CHARACTER'S TIME WENT, WHICH LEFT THE BUILDING WITH THE KEEPER.
    //
    // The fleet row carries `time` straight off the keeper's status, and `KeeperProxy`
    // hardcodes it to null — honestly, because the broker holds a snapshot. But the
    // ACCUMULATORS are right here, on the autopilot this process is running, and nothing
    // was sending them. So every activity clock downstream read zero: the strategy game's
    // Harness tab showed 0s in all eight buckets for twenty-one characters, and
    // `history time=true` filed `active_s: null` on every sample, which is why its numbers
    // are older than the fleet they describe.
    //
    // Read off `autopilot.time` rather than `autopilot.status().time`, and that is not
    // micro-optimisation: `status()` calls `threat()`, which scans the room, and this runs
    // once every two seconds per character. The keeper process exists to keep work off a
    // shared event loop; a status poll that walks the room contents would put it back.
    //
    // Absent rather than zeroed when there is no autopilot to ask — a tick-driven keeper
    // has no such buckets, and "we did not measure" must not read as "it did nothing".
    ...(autopilot?.time ? { time: (() => {
      const t = autopilot.time, r = n => Math.round(n || 0);
      const active = r(t.fighting) + r(t.pulling) + r(t.waiting) + r(t.recovering) +
                     r(t.zoning) + r(t.travelling) + r(t.trading);
      const total = active + r(t.stalled);
      return { fighting_s: r(t.fighting), pulling_s: r(t.pulling), waiting_s: r(t.waiting),
               recovering_s: r(t.recovering), zoning_s: r(t.zoning),
               travelling_s: r(t.travelling), trading_s: r(t.trading),
               stalled_s: r(t.stalled), active_s: active,
               stalled_pct: total ? +((100 * r(t.stalled)) / total).toFixed(1) : 0 };
    })() } : {}),
    // WHY IT IS NOT WORKING, AS DATA. Both of these are already on the autopilot and both
    // are one read: `refusals` is a Map of the decisions it declined to make and
    // `waiting_on` is what it is blocked behind. The broker's fleet row publishes them for
    // in-process keepers and published `[]` and `null` for every keeper-backed one, which
    // is the difference between "nothing is refusing" and "nobody asked".
    refusals: [...(autopilot?.refusals?.values?.() ?? [])],
    waiting_on: autopilot?.waitingOn ?? null,
  };
}

// ---------------------------------------------------------------- HTTP API

const logLines = [];
function log(line) {
  logLines.push(line);
  if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  console.error(line);
}

// The broker owns lease issuance; this process owns the socket and therefore performs
// the final authority check immediately before every RTS mutation. Exact-room and
// exact-faculty checks are correctness boundaries, not an artificial local/prod gate.
const RTS_COMMANDER_FACULTIES = ['work', 'movement', 'economy', 'social'];

function requireKeeperRtsAuthority(args, packet = 'action') {
  const expectedHost = String(args.server_host ?? '').trim().toLowerCase();
  const expectedPort = Number(args.server_port);
  if (String(credHost).trim().toLowerCase() !== expectedHost || Number(credPort) !== expectedPort)
    throw new Error(`RTS ${packet} server mismatch: keeper is on ${credHost}:${credPort}`);
  const room = Number(args.room);
  const actualRoom = Number(session.world?.room?.num);
  if (!Number.isSafeInteger(room) || room !== actualRoom)
    throw new Error(`RTS ${packet} room mismatch: expected ${room}, keeper is in ${actualRoom}`);
  const expectedRoomObjectId = Number(args.room_object_id);
  const actualRoomObjectId = Number(session.client?.room?.id);
  if (Number.isSafeInteger(expectedRoomObjectId) && Number.isSafeInteger(actualRoomObjectId) &&
      expectedRoomObjectId !== actualRoomObjectId)
    throw new Error(`RTS ${packet} room generation changed`);
  const owner = String(args.commander_owner ?? '');
  if (!owner) throw new Error(`RTS ${packet} has no commander owner`);
  if (!autopilot?.running || typeof autopilot.facultyOwner !== 'function')
    throw new Error(`RTS ${packet} has no running keeper authority`);
  for (const faculty of RTS_COMMANDER_FACULTIES) {
    const heldBy = autopilot.facultyOwner(faculty);
    if (heldBy !== owner)
      throw new Error(`RTS ${packet} lost ${faculty}; owner is ${heldBy}`);
  }
  return session.client;
}

function keeperRtsCancelled(controlToken) {
  const job = session.job;
  return !job || job.done || job.controlToken !== controlToken ||
    job.cancelled === true || job.cancelRequestedAt != null ||
    session.movementWasCancelled(job.generation, controlToken);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  const json = (data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // TWO `/action` HANDLERS, AND THE SECOND ONE HAS NEVER RUN.
  //
  // There are two `if (req.method === 'POST' && path === '/action')` blocks in this
  // function. The first one answers every name it knows and answers `unknown action` with a
  // 400 for everything else, so the second — `go`, `attack`, `cast`, `rawmove`, `movetest`,
  // `shop`, `buyitem`, `use`, `equip`, `look` — is unreachable. Every one of those verbs
  // has been dead on a keeper-backed broker, which is every broker now: `shop` and
  // `buyitem` are how a character supplies itself, and `equip` is how it arms itself.
  //
  // It is the failure mode this file keeps writing down — code that looks written and does
  // nothing — one level up, in the routing rather than in a method. Rather than merge two
  // switches by hand and risk changing the half that works, the first one's `default` now
  // hands the name down here instead of refusing it. A name neither switch knows still ends
  // as `unknown action`, so nothing that was answered before is answered differently.
  //
  // The body is passed along already parsed. The request stream has been consumed by then,
  // so re-reading it would give `{}` and turn every delegated call into `unknown action:
  // undefined` — which is the same bug again, wearing the fix's clothes.
  let actionFallthrough = null;

  // AN ORDER ADDRESSED TO SOMEBODY ELSE IS REFUSED, AND THIS PROCESS IS THE ONLY ONE THAT
  // CAN TELL.
  //
  // Keeper ports are `KEEPER_PORT_BASE + index` with no override, so every broker on a
  // machine allocates from the same number and a broker that lost a slot falls back to
  // GUESSING that number — `keeperPort()` in m59-broker.mjs — and then commands whatever is
  // listening there. Its read path checks the reply's `agent` and refuses; its write paths
  // did not check anything at all.
  //
  // Measured 2026-08-26 with three brokers up: an `arena` broker posted its 45s `/rejoin`
  // sweep to a `shadow` fleet's keepers, and the server logged `ACCOUNT 64 (shadow05) in
  // use; new connection overrides old one` every 90 seconds for that broker's whole life,
  // wrecking a set of timed tours that had nothing to do with it. Nothing on either side
  // said a word.
  //
  // The check is here rather than there because a caller that has guessed a port has by
  // definition already lost track of who is on it. 409 rather than 400: it is a conflict
  // about identity, and the broker turns that into "drop the allocation and respawn".
  //
  // Writes fail closed on a complete agent/character/PID tuple. New brokers carry it in
  // headers so the flat JSON body remains compatible with an old keeper's policy schema;
  // direct diagnostic tools may carry the same fields in JSON. Unaddressed GET diagnostics
  // remain available on loopback, while a GET that claims an identity must claim all of it.
  const normalizedKeeperCharacter = value => typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('en-US') : null;
  const presentIdentityPart = value => value !== undefined && value !== null && value !== '';
  const addressedToUs = (claimed, claimedCharacter, claimedPid, { required = true } = {}) => {
    const supplied = [claimed, claimedCharacter, claimedPid].some(presentIdentityPart);
    if (!supplied) return !required;
    if (![claimed, claimedCharacter, claimedPid].every(presentIdentityPart)) return false;
    if (String(claimed) !== String(agent)) return false;
    if (normalizedKeeperCharacter(claimedCharacter) !== normalizedKeeperCharacter(character))
      return false;
    return Number(claimedPid) === process.pid;
  };
  const addressedToUsQuery = (u) => addressedToUs(
    u.searchParams.get('agent'), u.searchParams.get('character'), u.searchParams.get('keeper_pid'),
    { required: false });
  const requestIdentity = (req, body = {}) => ({
    agent: req.headers['x-m59-agent'] ?? body?.agent,
    character: req.headers['x-m59-character'] ?? body?.character,
    keeperPid: req.headers['x-m59-keeper-pid'] ?? body?.keeper_pid,
  });
  const requireAddressedWrite = (req, body = {}) => {
    const identity = requestIdentity(req, body);
    if (addressedToUs(identity.agent, identity.character, identity.keeperPid)) return true;
    refuseMisaddressed(identity.agent);
    return false;
  };
  const refuseMisaddressed = (claimed) => {
    console.error(`[keeper] ${agent} refused an order addressed to "${claimed}" — ` +
                  `another broker is guessing this port`);
    json({ error: `this keeper is "${agent}", not "${claimed}"`, agent }, 409);
  };

  // A READ IS ADDRESSED THE SAME WAY, in the query string. `/chat` is a character's whole
  // transcript and `/room-view` is where it is standing; handed to a broker that guessed
  // this port, both come back looking exactly like answers about ITS character. `/health`
  // and `/state` are deliberately exempt — they NAME their own agent in the reply and the
  // broker checks it, and they are how a caller discovers whose port this is in the first
  // place. `/live` carries the same exact identity tuple without constructing state.
  // Refusing those would take away the tool that resolves the confusion.
  if (req.method === 'GET' && path !== '/health' && path !== '/state' && path !== '/live' &&
      !addressedToUsQuery(url)) {
    refuseMisaddressed(url.searchParams.get('agent'));
    return;
  }

  try {
    if (req.method === 'GET' && path === '/live') {
      // Cheap process/session proof for the supervisor. This MUST NOT call stateSnapshot:
      // the enriched projection below includes routing, world objects, inventory and GOAP
      // status, and rebuilding it just to prove a PID still owns a socket was the broker's
      // dominant idle hot loop. Legacy `/health` remains rich for rolling compatibility.
      json({
        schema: 'm59-keeper-live/v1',
        ok: !!(inGame && session.live),
        agent,
        character: session.client?.me?.name ?? character,
        pid: process.pid,
        in_game: inGame,
        connected: !!session.live,
        connection_revision: connectionRevision,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      // A bounded-staleness snapshot avoids rebuilding the expensive status projection
      // until somebody actually asks for it. Bursts share one value; an unobserved keeper
      // owns no cache timer and does no routing work.
      const snapshot = stateSnapshot();
      const s = snapshot.value;
      // The broker may survive-reuse this process across a Windows service restart.
      // Publishing the exact PID lets it adopt the existing keeper instead of spawning
      // a doomed duplicate on the occupied port and recording that dead child's PID.
      json({ ok: inGame, agent, pid: process.pid, ...s, as_of_ms: snapshot.ageMs });
      return;
    }

    if (req.method === 'GET' && path === '/state') {
      // CACHED BY DEFAULT AND RE-READ ON DEMAND, WITH THE AGE SAID OUT LOUD.
      //
      // The cache exists so a dashboard poll cannot block a character mid-swing, and that
      // is right. But the broker proxies READS here too, and a tool asking what a character
      // is carrying wants an answer about now — the old contract offered only the cache, so
      // the broker's `inventory` and `equipment` tools had to reach for the wire themselves
      // and hit `keeper-backed: pacer is in the keeper process`.
      //
      // `?fresh=1` asks this process — the one that owns the socket — to do the read it is
      // the only thing entitled to do. Everything else still gets the cache, and every
      // answer now carries `as_of_ms` so a caller can tell how old its evidence is rather
      // than assuming it is current.
      const wantFresh = url.searchParams.get('fresh') === '1';
      if (wantFresh && inGame) {
        try {
          await session.pacer.submit('read', () => session.client.requestInventory());
          await session.client.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 3000 })
                     .catch(() => null);
        } catch { /* a refused read still answers from the cache below */ }
        const fresh = stateSnapshot({ fresh: true });
        json({ ...fresh.value, as_of_ms: fresh.ageMs, fresh: fresh.refreshed });
        return;
      }
      const snapshot = stateSnapshot();
      json({ ...snapshot.value, as_of_ms: snapshot.ageMs, fresh: snapshot.refreshed });
      return;
    }

    // THE HALF OF THE PROXY THAT WAS NEVER BUILT.
    //
    // `KeeperProxy` in m59-broker.mjs forwards every mutating tool here as
    // POST /action {name, args} — walk, fight, travel, cancel, pass. This endpoint did not
    // exist, so a broker holding keeper processes could READ a character and not MOVE one.
    // Measured: twenty-one of twenty-one travels refused, and the fleet could only be driven
    // by falling back to in-process keepers, which is the arrangement whose event-loop p99
    // is thirty times worse.
    //
    // The keeper is the right place for this. It holds the real Session, the real World and
    // the real geometry; the broker holds a cached snapshot. So an order arrives here as a
    // name and is executed by the thing that owns the body.
    //
    // ACTION COORDINATES. Square destinations are 1-based KOD coordinates in public
    // (col,row) order. walk_fine and step_fine carry protocol/KOD (x,y), 64 units per
    // square, and stride uses that same unit. Geometry checks below intentionally swap
    // public (col,row) into RoomGeometry's positional (row,col) convention.
    if (req.method === 'POST' && path === '/action') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let ask;
      try { ask = JSON.parse(body || '{}'); }
      catch (e) { json({ error: `unparseable action: ${e.message}` }, 400); return; }
      // Before anything is executed, and before `inGame` — a stranger's order must not even
      // learn whether this character is logged in.
      if (!requireAddressedWrite(req, ask)) return;
      const name = String(ask?.name ?? '');
      const args = ask?.args ?? {};
      if (!inGame) { json({ error: `${agent}: not in game` }, 409); return; }
      try {
        switch (name) {
          case 'rts_move_intent': {
            const c = requireKeeperRtsAuthority(args, 'move-intent');
            const col = Number(args.col), row = Number(args.row);
            if (!Number.isSafeInteger(col) || !Number.isSafeInteger(row)) {
              json({ error: 'move intent destination must be an integer col/row square' }, 400);
              return;
            }
            const geometry = session.world?.geometry;
            if (!geometry || row < 1 || row > geometry.rows || col < 1 || col > geometry.cols ||
                !geometry.standable(row, col)) {
              json({ error: `move intent destination ${col},${row} is outside the walkable room floor` }, 409);
              return;
            }
            const controlToken = String(args.control_token ?? '');
            const leaseToken = String(args.lease_token ?? '');
            const maxSteps = Math.max(1, Math.min(400, Math.trunc(Number(args.max_steps ?? 120))));
            const job = session.startJob('move',
              `move to ${col},${row} in room ${Number(args.room)}`,
              movementGeneration => session.walkTo(col, row, {
                maxSteps, hardCap: 400, movementGeneration, controlToken,
                beforeMutation: (packet, detail) => {
                  requireKeeperRtsAuthority(args, packet);
                  if (keeperRtsCancelled(controlToken))
                    throw new Error(`RTS ${packet} cancelled before mutation`);
                  if (!detail || !Number.isSafeInteger(detail.col) ||
                      !Number.isSafeInteger(detail.row))
                    throw new Error(`RTS ${packet} has no exact next-step square`);
                  const liveGeometry = session.world?.geometry;
                  if (!liveGeometry || detail.row < 1 || detail.row > liveGeometry.rows ||
                      detail.col < 1 || detail.col > liveGeometry.cols ||
                      !liveGeometry.standable(detail.row, detail.col))
                    throw new Error(`RTS ${packet} next step ${detail.col},${detail.row} is not walkable`);
                },
              }),
              { controlToken, leaseToken });
            json({ accepted: true, started_at: job.startedAt, destination: { col, row }, max_steps: maxSteps });
            return;
          }
          case 'rts_attack_intent': {
            const c = requireKeeperRtsAuthority(args, 'attack-intent');
            const target = Number(args.target);
            const liveTarget = c.room?.objects?.get?.(target);
            if (!Number.isSafeInteger(target) || !liveTarget || !(liveTarget.flags & OF.ATTACKABLE)) {
              json({ error: `attack target ${target} is absent or not attackable` }, 409);
              return;
            }
            if (liveTarget.flags & OF.PLAYER) {
              json({ error: `RTS attack target ${target} is a player; commander attacks are PvE-only` }, 409);
              return;
            }
            const controlToken = String(args.control_token ?? '');
            const leaseToken = String(args.lease_token ?? '');
            const swings = Math.max(1, Math.min(20, Math.trunc(Number(args.swings ?? 20))));
            const job = session.startJob('attack',
              `attack ${target} in room ${Number(args.room)}`, async () => {
                const log = [];
                for (let swing = 1; swing <= swings; swing++) {
                  if (keeperRtsCancelled(controlToken))
                    return { target, swings: log, cancelled: true };
                  const currentClient = requireKeeperRtsAuthority(args, 'attack');
                  const current = currentClient.room?.objects?.get?.(target);
                  if (!current || !(current.flags & OF.ATTACKABLE)) {
                    log.push({ swing, result: 'target is no longer here or attackable' });
                    break;
                  }
                  if (current.flags & OF.PLAYER)
                    throw new Error(`RTS attack refused: target ${target} is now a player`);
                  await session.faceToward(current, {
                    beforePacket: packet => requireKeeperRtsAuthority(args, packet),
                  });
                  const since = c.evSeq;
                  await session.pacer.submit('attack', () => {
                    const packetClient = requireKeeperRtsAuthority(args, 'attack');
                    if (keeperRtsCancelled(controlToken))
                      throw new Error('RTS attack cancelled before mutation');
                    const packetTarget = packetClient.room?.objects?.get?.(target);
                    if (!packetTarget || !(packetTarget.flags & OF.ATTACKABLE) ||
                        (packetTarget.flags & OF.PLAYER))
                      throw new Error(`RTS attack refused: target ${target} is absent, changed, or not PvE-attackable`);
                    if (swings > 1) {
                      const health = packetClient.vitals()?.health;
                      const maximum = health?.max ?? health?.scale_max;
                      const fraction = Number.isFinite(health?.value) &&
                        Number.isFinite(maximum) && maximum > 0 ? health.value / maximum : null;
                      if (!(fraction > 0.35))
                        throw new Error('RTS attack refused: multi-swing health must remain above 35%');
                    }
                    return packetClient.attack(target);
                  }, 1050);
                  const observed = await c.waitFor({ since, timeoutMs: 2500 })
                    .catch(() => ({ events: [] }));
                  log.push({ swing,
                    messages: (observed.events ?? []).filter(event => event.text)
                      .map(event => String(event.text)) });
                  if (!c.room?.objects?.has?.(target)) break;
                }
                return { target, swings: log };
              }, { controlToken, leaseToken });
            json({ accepted: true, started_at: job.startedAt, target, swings });
            return;
          }
          case 'rts_context_intent': {
            const c = requireKeeperRtsAuthority(args, 'context-intent');
            const action = String(args.action ?? '');
            const actions = new Set([
              'stand', 'rest_here', 'recover_here', 'grab_nearby', 'take', 'cast',
              'approach', 'face', 'equip_best', 'wear_best', 'eat_best', 'prepare',
              'item_use', 'item_unuse', 'item_eat', 'safety_on',
            ]);
            if (!actions.has(action)) { json({ error: `unknown RTS context action ${action}` }, 400); return; }
            const controlToken = String(args.control_token ?? '');
            const leaseToken = String(args.lease_token ?? '');
            const col = Number(args.col), row = Number(args.row);
            const target = Number(args.target), itemId = Number(args.item);
            const targets = action === 'take' ? [target]
              : Array.isArray(args.targets) ? args.targets.map(Number) : [];
            const spellName = String(args.spell ?? '').trim();
            let item = null, itemName = null, spell = null;
            let spellRule = null, spellIdentity = null, spellTargetIdentity = null;
            let spellHasTarget = false;

            if (action === 'rest_here' || action === 'recover_here') {
              const geometry = session.world?.geometry;
              if (!Number.isSafeInteger(col) || !Number.isSafeInteger(row) || !geometry ||
                  row < 1 || row > geometry.rows || col < 1 || col > geometry.cols ||
                  !geometry.standable(row, col)) {
                json({ error: `${action} destination ${col},${row} is outside the walkable room floor` }, 409);
                return;
              }
            } else if (action === 'take' || action === 'grab_nearby') {
              if (!targets.length || targets.length > 12 ||
                  targets.some(id => !Number.isSafeInteger(id) || id < 1) ||
                  new Set(targets).size !== targets.length) {
                json({ error: `${action} requires 1-12 unique positive object ids` }, 400);
                return;
              }
              const missing = targets.find(id => {
                const object = c.room?.objects?.get?.(id);
                return !object || !(object.flags & OF.GETTABLE);
              });
              if (missing != null) {
                json({ error: `object ${missing} is absent or no longer gettable` }, 409);
                return;
              }
            } else if (action === 'approach' || action === 'face') {
              const object = c.room?.objects?.get?.(target);
              if (!Number.isSafeInteger(target) || !object ||
                  !Number.isFinite(object.col) || !Number.isFinite(object.row)) {
                json({ error: `target ${target} is no longer perceived` }, 409);
                return;
              }
            } else if (action.startsWith('item_')) {
              item = (c.inventory ?? []).find(value => value.id === itemId) ?? null;
              itemName = item ? c.rsc?.get?.(item.nameRsc) ?? '' : '';
              if (!item || !Number.isSafeInteger(itemId) ||
                  String(args.expected_item_name ?? '') !== itemName) {
                json({ error: `inventory item ${itemId} is absent or changed` }, 409);
                return;
              }
            } else if (action === 'cast') {
              spell = (c.spells ?? []).find(value =>
                String(c.rsc?.get?.(value.nameRsc) ?? '').toLowerCase() === spellName.toLowerCase()) ?? null;
              const observedSpellName = spell ? c.rsc?.get?.(spell.nameRsc) ?? '' : '';
              if (!spell || !spellName || !Number.isSafeInteger(spell.id)) {
                json({ error: `spell not found: ${spellName}` }, 409);
                return;
              }
              spellRule = rtsSafeSpellRule(observedSpellName, Number(spell.numTargets));
              if (!spellRule) {
                json({ error: `${observedSpellName} is not classified as safe for RTS casting` }, 409);
                return;
              }
              spellHasTarget = args.target !== undefined && args.target !== null;
              if (spellHasTarget && (!Number.isSafeInteger(target) || target < 1)) {
                json({ error: 'cast target must be a positive object id' }, 400);
                return;
              }
              const targetObject = !spellHasTarget ? null
                : target === c.selfId ? c.self : c.room?.objects?.get?.(target);
              const targetIsPlayer = target === c.selfId ? true
                : Number.isInteger(targetObject?.flags) ? !!(targetObject.flags & OF.PLAYER) : null;
              if (!rtsSpellTargetAllowed(spellRule, {
                targetId: spellHasTarget ? target : null,
                selfId: Number.isSafeInteger(c.selfId) ? c.selfId : null,
                targetIsPlayer,
              })) {
                json({ error: spellRule.target_mode === 'none'
                  ? `${observedSpellName} accepts no target`
                  : 'RTS context casting may not target players or unknown object kinds' }, 409);
                return;
              }
              spellIdentity = {
                id: spell.id, nameRsc: spell.nameRsc, name: observedSpellName,
                targets: Number(spell.numTargets), targetMode: spellRule.target_mode,
              };
              if (targetObject) {
                spellTargetIdentity = {
                  id: targetObject.id, nameRsc: targetObject.nameRsc,
                };
              }
            }

            const guard = (packet, detail = null) => {
              const live = requireKeeperRtsAuthority(args, packet);
              if (keeperRtsCancelled(controlToken))
                throw new Error(`RTS ${packet} cancelled before mutation`);
              if (detail && Number.isSafeInteger(detail.col) && Number.isSafeInteger(detail.row)) {
                const geometry = session.world?.geometry;
                if (!geometry || detail.row < 1 || detail.row > geometry.rows ||
                    detail.col < 1 || detail.col > geometry.cols ||
                    !geometry.standable(detail.row, detail.col))
                  throw new Error(`RTS ${packet} next step ${detail.col},${detail.row} is not walkable`);
              }
              return live;
            };
            const cancelled = () => keeperRtsCancelled(controlToken);
            const label = action === 'stand' ? `stand in room ${Number(args.room)}`
              : action === 'rest_here' ? `rest at ${col},${row} in room ${Number(args.room)}`
              : action === 'recover_here' ? `recover at ${col},${row} in room ${Number(args.room)}`
              : action === 'take' ? `take ${target} in room ${Number(args.room)}`
              : action === 'grab_nearby' ? `grab ${targets.length} nearby item(s)`
              : action === 'approach' || action === 'face' ? `${action} ${target}`
              : action.startsWith('item_') ? `${action.slice(5)} ${itemName}`
              : action === 'cast' ? `cast ${spellName}` : action.replaceAll('_', ' ');
            const job = session.startJob(`context:${action}`, label, async movementGeneration => {
              if (cancelled()) return { cancelled: true };
              if (action === 'stand') {
                await session.pacer.submit('rest', () => { guard('stand'); return c.stand(); });
                return { resting: false };
              }
              if (action === 'rest_here' || action === 'recover_here') {
                const walk = await session.walkTo(col, row, {
                  maxSteps: 120, hardCap: 400, movementGeneration, controlToken,
                  beforeMutation: guard,
                });
                if (!walk.arrived || cancelled())
                  return { walk, resting: false, ...(cancelled() ? { cancelled: true } : {}) };
                if (action === 'rest_here') {
                  await session.pacer.submit('rest', () => { guard('rest'); return c.rest(); });
                  return { walk, resting: true };
                }
                const recovery = await skills.restUntil(session, {
                  health: 0.9, vigor: 0.9, maxSeconds: 120,
                  beforeMutation: guard, beforeCleanup: guard, shouldCancel: cancelled,
                });
                return { walk, recovery };
              }
              if (action === 'take' || action === 'grab_nearby')
                return session.lootFloor({
                  ids: targets, maxItems: Math.min(12, targets.length),
                  movementGeneration, controlToken, shouldCancel: cancelled,
                  stayPut: action === 'grab_nearby',
                  explicitIdsOverride: action !== 'grab_nearby', beforeMutation: guard,
                });
              if (action === 'approach' || action === 'face') {
                let walk = null;
                let object = c.room?.objects?.get?.(target);
                if (action === 'approach') {
                  const me = c.self;
                  const distance = me && object
                    ? Math.hypot(object.col - me.col, object.row - me.row) : Infinity;
                  if (distance > 1.5) {
                    const spot = object ? session.world?.approachSquare?.(object.col, object.row) : null;
                    if (!spot) return { target, in_position: false, reason: 'no reachable adjacent square' };
                    walk = await session.walkTo(spot.col, spot.row, {
                      maxSteps: Math.max(30, Math.min(400, (spot.steps ?? 0) + 10)), hardCap: 400,
                      movementGeneration, controlToken, beforeMutation: guard,
                    });
                  }
                }
                object = c.room?.objects?.get?.(target);
                if (!object) return { target, walk, reason: 'target left the room' };
                const facing = await session.faceToward(object, { beforePacket: guard });
                return { target, walk, facing_degrees: facing };
              }
              const options = { beforeMutation: guard, shouldCancel: cancelled };
              if (action === 'equip_best') return skills.equipBest(session, options);
              if (action === 'wear_best') return skills.wearBest(session, options);
              if (action === 'eat_best')
                return skills.eat(session, { maxItems: 1, upToVigor: skills.VIGOR_MAX, ...options });
              if (action === 'prepare') {
                const weapon = await skills.equipBest(session, options);
                const armour = cancelled() ? null
                  : await skills.wearBest(session, { ...options, refresh: false });
                return { weapon, armour, ...(cancelled() ? { cancelled: true } : {}) };
              }
              if (action === 'safety_on') {
                await session.pacer.submit('safety', () => { guard('safety'); return c.safety(true); });
                return { requested: true };
              }
              if (action === 'item_use' || action === 'item_unuse') {
                await session.pacer.submit('use', () => {
                  guard(action === 'item_use' ? 'use' : 'unuse');
                  return action === 'item_use' ? c.use(itemId) : c.unuse(itemId);
                });
                return { item: itemId, name: itemName };
              }
              if (action === 'item_eat') {
                await session.pacer.submit('act', () => { guard('eat'); return c.apply(itemId, c.selfId); }, 1050);
                return { item: itemId, name: itemName };
              }
              await session.pacer.submit('cast', () => {
                const live = guard('cast');
                const currentSpell = (live.spells ?? []).find(value => value.id === spellIdentity.id);
                const currentName = currentSpell ? live.rsc?.get?.(currentSpell.nameRsc) ?? '' : '';
                const currentRule = currentSpell && currentSpell.nameRsc === spellIdentity.nameRsc &&
                    currentName === spellIdentity.name &&
                    Number(currentSpell.numTargets) === spellIdentity.targets
                  ? rtsSafeSpellRule(currentName, Number(currentSpell.numTargets)) : null;
                if (!currentRule || currentRule.target_mode !== spellIdentity.targetMode)
                  throw new Error(`RTS cast refused: exact spell ${spellIdentity.name} is absent, changed, or unsafe`);
                const currentTarget = !spellHasTarget ? null
                  : target === live.selfId ? live.self : live.room?.objects?.get?.(target);
                if (spellTargetIdentity && (!currentTarget ||
                    currentTarget.id !== spellTargetIdentity.id ||
                    currentTarget.nameRsc !== spellTargetIdentity.nameRsc))
                  throw new Error(`RTS cast refused: exact target ${target} is absent or changed`);
                const targetIsPlayer = target === live.selfId ? true
                  : Number.isInteger(currentTarget?.flags) ? !!(currentTarget.flags & OF.PLAYER) : null;
                if (!rtsSpellTargetAllowed(currentRule, {
                  targetId: spellHasTarget ? target : null,
                  selfId: Number.isSafeInteger(live.selfId) ? live.selfId : null,
                  targetIsPlayer,
                }))
                  throw new Error('RTS cast refused: live target policy is not PvE-safe');
                return live.cast(currentSpell.id, spellHasTarget ? [target] : []);
              });
              return { spell: spellName, ...(Number.isSafeInteger(target) ? { target } : {}) };
            }, { controlToken, leaseToken });
            json({ accepted: true, started_at: job.startedAt, action,
                   ...(['rest_here', 'recover_here'].includes(action)
                     ? { destination: { col, row } } : {}),
                   ...(['take', 'approach', 'face'].includes(action) ? { target } : {}),
                   ...(action === 'grab_nearby' ? { targets } : {}),
                   ...(action === 'cast' ? { spell: spellName } : {}),
                   ...(action.startsWith('item_') ? { item: itemId, name: itemName } : {}) });
            return;
          }
          case 'rts_cancel': {
            const expectedHost = String(args.server_host ?? '').trim().toLowerCase();
            const expectedPort = Number(args.server_port);
            if (String(credHost).trim().toLowerCase() !== expectedHost ||
                Number(credPort) !== expectedPort) {
              json({ error: `RTS cancel server mismatch: keeper is on ${credHost}:${credPort}` }, 409);
              return;
            }
            const job = session.job && !session.job.done ? session.job : null;
            if (!job) { json({ cancelled: false, note: 'no background action is active' }); return; }
            if (!job.controlToken || job.controlToken !== String(args.control_token ?? '')) {
              json({ error: 'control_token does not own the active background action' }, 409);
              return;
            }
            if (!job.leaseToken || job.leaseToken !== String(args.lease_token ?? '')) {
              json({ error: 'lease_token does not own the active background action' }, 409);
              return;
            }
            if (job.kind === 'move' || job.kind.startsWith('context:')) {
              json(session.cancelMovement(job.controlToken, 'RTS controller cancellation'));
              return;
            }
            job.cancelled = true;
            job.cancelRequestedAt = Date.now();
            json({ cancelled: true, interrupted: { kind: job.kind, label: job.label },
                   note: 'action will stop before its next paced packet' });
            return;
          }
          case 'travel': {
            // BACKGROUND BY DEFAULT, because a journey outlives any sane HTTP timeout and
            // the caller polls /state to watch it. `travelJob` is the one definition of the
            // job slot and the keeper hold; calling `travel` directly would give this path
            // its own private copy of both, which is the bug the broker's travel tool has
            // a long comment about.
            const dest = Number(args.to ?? args.toRoomNum);
            if (!Number.isFinite(dest)) { json({ error: 'travel needs a destination room number' }, 400); return; }
            const job = session.travelJob(dest, {
              where: args.where, maxHops: Number(args.max_hops ?? args.maxHops ?? 25),
              controlToken: args.control_token ?? args.controlToken,
              runErrands: args.run_errands !== false && args.runErrands !== false,
            });
            if (args.background === false) { json({ ...(await job.promise), destination: dest }); return; }
            json({ started: true, destination: dest,
                   note: 'walking now; poll /state — do not re-issue while busy' });
            return;
          }
          case 'walk': {
            const r = await session.walkTo(Number(args.col), Number(args.row), args);
            json(r ?? { ok: true });
            return;
          }
          case 'fight': {
            const r = await session.fight?.(args.target, args);
            json(r ?? { ok: true });
            return;
          }
          // SPEECH, WHICH THE PROXY COULD NOT DO AT ALL.
          //
          // `c.say is not a function`, measured on the shadow fleet: the broker's emulated
          // client has no `say`, so on a keeper-backed broker — which is every broker now —
          // the `say` tool threw for every character and every channel. Nothing in the fleet
          // could speak, tell, broadcast or answer a question put to it, and the inbox and
          // the chatter both go out through that same tool.
          //
          // It belongs here for the same reason movement does: the socket is here. The
          // broker holds a two-second snapshot and no wire.
          //
          // THE ECHO IS THE RECEIPT. This game confirms nothing — a refusal is a sentence
          // spoken to the room, and a say that goes nowhere looks exactly like one that
          // worked. So this waits briefly for the server to send our own line back and
          // reports whether it did, rather than returning `{ok:true}` for a packet that was
          // merely written to a socket.
          case 'say': {
            const c = session.client;
            const text = String(args.text ?? '');
            if (!text) { json({ error: 'say needs text' }, 400); return; }
            const since = c.evSeq;
            const to = [].concat(args.to ?? []).filter(x => x !== null && x !== undefined);
            if (to.length) {
              // tell/send: object ids, so names are resolved against who is online NOW.
              await session.pacer.submit('read', () => c.players());
              await c.waitFor({ kinds: ['who'], timeoutMs: 3000 });
              const online = [...c.playersOnline.values()];
              const ids = [], unknown = [];
              for (const w of to) {
                const n = Number(w);
                const hit = Number.isFinite(n) && String(w).trim() !== ''
                  ? online.find(p => p.id === n)
                  : online.find(p => p.name && p.name.toLowerCase() === String(w).toLowerCase())
                    ?? online.find(p => p.name && p.name.toLowerCase().includes(String(w).toLowerCase()));
                if (hit) ids.push(hit.id); else unknown.push(w);
              }
              if (!ids.length) {
                json({ spoken: null, unknown, online: online.map(p => ({ id: p.id, name: p.name })),
                       note: 'nobody by that name is logged on, so there was nothing to send to' });
                return;
              }
              const sent = c.evSeq;
              await session.pacer.submit('say', () => c.sayGroup(ids, text));
              const { events } = await c.waitFor({ since: sent, kinds: ['said', 'message'], timeoutMs: 2500 });
              const mine = events.find(e => e.kind === 'said' && e.speaker === c.selfId);
              json({ spoken: text, to: ids.map(id => ({ id, name: c.playersOnline.get(id)?.name })),
                     ...(unknown.length ? { unknown } : {}),
                     echoed: mine ? mine.text : null,
                     messages: events.filter(e => e.text).map(e => e.text) });
              return;
            }
            const kind = Number(args.kind ?? 1);
            await session.pacer.submit('say', () => c.say(text, kind));
            const { events } = await c.waitFor({ since, kinds: ['said', 'message'], timeoutMs: 2500 });
            const mine = events.find(e => e.kind === 'said' && e.speaker === c.selfId);
            json({ spoken: text, say_type: kind, echoed: mine ? mine.text : null,
                   messages: events.filter(e => e.text).map(e => e.text) });
            return;
          }
          case 'cancel': {
            const r = session.cancelMovement?.(args.control_token, 'the keeper /action endpoint');
            json({ cancelled: true, ...(r ?? {}) });
            return;
          }
          case 'loot': {
            const r = await session.lootFloor?.(args);
            json(r ?? { ok: true });
            return;
          }
          // FINE MOVEMENT, WHICH THE PROXY ANSWERED WITH null AND NOTHING ELSE.
          //
          // `KeeperProxy.walkFine` was `return Promise.resolve(null)` — a stub that moves
          // nobody and reports success by saying nothing at all. With `movement_mode fine`
          // on, EVERY walk_to took that branch, so a keeper-backed character could not walk
          // in fine coordinates at all. Thirty-one calls in a row returned null and the
          // character never left its square.
          //
          // Fine movement is not a nicety here: the coarse grid is 64 units to the square
          // and cannot represent a walkable strip narrower than one, which is exactly what
          // the ledges in 579 and the catwalk in 108 are. Without this a bot cannot walk a
          // sliver, and slivers are where the interesting places in this game are.
          case 'walk_fine': {
            const r = await session.walkFine(Number(args.x), Number(args.y), {
              maxSteps: Number(args.max_steps ?? args.maxSteps ?? 60),
              stride: args.stride != null ? Number(args.stride) : undefined,
              controlToken: args.control_token ?? args.controlToken,
            });
            json(r ?? { ok: true });
            return;
          }
          case 'step_fine': {
            const r = await session.stepFine(Number(args.x), Number(args.y));
            json(r ?? { ok: true });
            return;
          }
          // AND THE SURVIVAL VERBS. Same failure, higher stakes: `rest` and
          // `escapeUnderworld` were also `Promise.resolve(null)`, so a keeper-backed
          // character asked to recover did nothing and said it was fine.
          case 'rest': {
            const health = Number(args.health ?? args.to_health ?? args.toHealth ?? 0.99);
            const vigor = Number(args.vigor ?? args.to_vigor ?? args.toVigor ?? 80);
            const maxSeconds = Math.max(5, Math.min(300,
              Number(args.max_seconds ?? args.maxSeconds ?? 90) || 90));
            const r = await skills.restUntil(session, {
              health: Number.isFinite(health) ? Math.max(0, Math.min(1, health)) : 0.99,
              vigor: Number.isFinite(vigor) ? Math.max(0, Math.min(200, vigor)) : 80,
              maxSeconds,
            });
            json(r);
            return;
          }
          case 'escape_underworld': {
            // The socket and live World belong to this keeper process. Calling an
            // optional Session method used to return {ok:true} even though Session has
            // no such method, leaving the character in the Underworld. Use the proven
            // survival implementation directly and report its actual room-changing
            // verdict; callers must still require `left:true`.
            const r = await skills.escapeUnderworld(session, {
              city: args.city ?? null,
              nearestTo: args.nearest_to ?? args.nearestTo ?? null,
              maxSeconds: Math.max(5, Math.min(300,
                Number(args.max_seconds ?? args.maxSeconds ?? 180) || 180)),
              allowRip: args.allow_rip ?? args.allowRip ?? true,
            });
            json(r);
            return;
          }
          case 'face': {
            const r = await session.faceToward?.(args.target ?? args, {});
            json(r ?? { ok: true });
            return;
          }
          // A JUMP NEEDS THE GEOMETRY, AND ONLY THIS PROCESS HAS IT.
          //
          // The broker's `jump` tool asks `s.world.geometry.declaredFallJumps(...)` and the
          // proxy's world has `geometry: null` on purpose — it holds a two-second-old
          // snapshot, not a World. So every jump on a keeper-backed broker answered
          // "no geometry for this room", which is true and unhelpful: the geometry is here.
          //
          // Same shape as `route`, which is already handled this way for the same reason.
          case 'jump': {
            const geo = session.world?.geometry;
            if (!geo?.declaredFallJumps) { json({ error: 'no geometry for this room' }, 409); return; }
            const me = session.client?.self;
            if (!me) { json({ error: 'own position unknown' }, 409); return; }
            const toRow = Number(args.to_row ?? args.toRow);
            const toCol = Number(args.to_col ?? args.toCol);
            // THE TAKE-OFF IS A LEDGE, NOT A SQUARE, AND ARRIVING ONE SQUARE SHORT IS NORMAL.
            //
            // This asked `declaredFallJumps(me.row, me.col)` for the body's EXACT square. The
            // broker's copy of the same verb has always allowed a one-square neighbourhood,
            // deliberately — you must leave from the ledge and the ledge is narrow, but where
            // on it you end up after a walk is not something a walk guarantees. Measured: a
            // character walked the whole Ancient Place spiral to the take-off, stopped at
            // r41c33 instead of r40c33, and was refused with `declared_here: []` while the
            // declaration sat one square north.
            //
            // AND THE FLOOR IS WHAT KEEPS IT HONEST. One square either way is "the same jump,
            // a step to the left" only if it is on the SAME SHELF; r40c33 spans 3520 to 10880
            // and the two halves are different places. Where the operator gave fine points
            // they say which shelf, because they were read off somebody making the jump.
            let match = null, from = { row: me.row, col: me.col };
            const declaredHere = geo.declaredFallJumps(me.row, me.col) ?? [];
            const floorClient = (x, y) => {
              try { return geo.floorBaseAtClient(x, y); } catch { return null; }
            };
            const myFloor = floorClient(me.x, me.y) ??
              (() => { try { const p = geo.standPoint(me.row, me.col); return p ? floorClient(p.x, p.y) : null; }
                       catch { return null; } })();
            const raw = (() => { try { return fallJumpsIn(Number(session.world?.room?.num ?? NaN)) ?? []; }
                                 catch { return []; } })();
            const shelfOk = (row, col) => {
              const d = raw.find(x => x?.from && x.from_fine &&
                Number(x.from.row) === row && Number(x.from.col) === col);
              if (!d || myFloor == null) return true;          // nothing declared: do not invent a refusal
              const h = floorClient(d.from_fine.x, d.from_fine.y);
              return h == null || Math.abs(h - myFloor) <= 64;
            };
            for (let r0 = me.row - 1; r0 <= me.row + 1 && !match; r0++)
              for (let c0 = me.col - 1; c0 <= me.col + 1 && !match; c0++) {
                const here = geo.declaredFallJumps(r0, c0) ?? [];
                const hit = here.find(j => Math.abs(j.row - toRow) <= 2 && Math.abs(j.col - toCol) <= 2);
                if (hit && shelfOk(r0, c0)) { match = hit; from = { row: r0, col: c0 }; }
              }
            if (!match) {
              json({ jumped: false,
                     reason: `no declared fall-jump from ${me.row},${me.col} to ${toRow},${toCol}`,
                     declared_here: declaredHere.map(j => j.row + ',' + j.col),
                     my_floor: myFloor });
              return;
            }
            void from;
            const r = await session.step(toCol, toRow, { fall: true });
            const now = session.client?.self;
            json({ jumped: true, asked: { row: toRow, col: toCol },
                   landed: now ? { row: now.row, col: now.col } : null,
                   arrived: !!now && now.row === toRow && now.col === toCol,
                   mover: r ?? null });
            return;
          }
          case 'confirm_position': {
            const r = await session.confirmPosition?.();
            json({ confirmed: r ?? false });
            return;
          }
          case 'stand': {
            const r = await session.standBeforeGo?.(args);
            json(r ?? { ok: true });
            return;
          }
          case 'pass': {
            const r = await autopilot?.pass?.();
            json({ passed: true, ...(r ?? {}) });
            return;
          }
          // A ROUTE IS A QUESTION, NOT AN ORDER, but it belongs here for the same reason:
          // only this process has the live World that can answer it.
          case 'route': {
            const dest = Number(args.to ?? args.toRoomNum);
            json(session.world?.route?.(dest) ?? { found: false, reason: 'no world' });
            return;
          }
          // STAND STILL WHILE SOMEBODY ELSE DRIVES. See holdKeeper above for why this is
          // here rather than in the broker, and why the tick driver is held a different
          // way from the goap one.
          case 'hold': {
            json(holdKeeper(String(args.why ?? 'an errand owns this character'),
                            Math.max(5000, Math.min(Number(args.max_ms ?? 180000), 900000)),
                            args.token ?? null));
            return;
          }
          case 'release': {
            json(releaseKeeper(String(args.why ?? 'errand finished'), args.token ?? null));
            return;
          }
          case 'hold_status': { json({ hold: holdReport() }); return; }

          // The broker owns the short commander capability; this process owns the
          // Autopilot and its per-faculty claims. Preserve that ownership API across the
          // keeper-process boundary so a split keeper can be driven without stopping its
          // survival, recovery, mortality, or identity faculties.
          case 'commander_claim': {
            if (!autopilot?.running || typeof autopilot.claimFaculties !== 'function') {
              json({ error: 'running keeper does not expose faculty ownership' }, 409);
              return;
            }
            json(autopilot.claimFaculties({
              faculties: Array.isArray(args.faculties) ? args.faculties : [],
              by: String(args.by ?? ''),
              leaseMs: Math.max(1000,
                Math.min(Number(args.leaseMs ?? args.lease_ms ?? 20000), 30000)),
              why: String(args.why ?? 'RTS commander lease'),
              mayYield: Array.isArray(args.mayYield ?? args.may_yield)
                ? (args.mayYield ?? args.may_yield) : [],
            }));
            return;
          }
          case 'commander_heartbeat': {
            if (!autopilot?.running || typeof autopilot.heartbeatFaculties !== 'function') {
              json({ error: 'running keeper does not expose faculty ownership' }, 409);
              return;
            }
            json(autopilot.heartbeatFaculties({
              by: String(args.by ?? ''),
              leaseMs: Math.max(1000,
                Math.min(Number(args.leaseMs ?? args.lease_ms ?? 20000), 30000)),
            }));
            return;
          }
          case 'commander_release': {
            if (!autopilot || typeof autopilot.releaseFaculties !== 'function') {
              json({ released: [], faculties: {} });
              return;
            }
            json(autopilot.releaseFaculties({
              faculties: Array.isArray(args.faculties) ? args.faculties : null,
              by: String(args.by ?? ''),
            }));
            return;
          }
          case 'commander_free_busy': {
            if (!autopilot || typeof autopilot.freeBusy !== 'function') {
              json({ busy: null, was: null });
              return;
            }
            json(autopilot.freeBusy({ by: String(args.by ?? '') }));
            return;
          }

          // WHO IS ACTUALLY STANDING HERE, ASKED RATHER THAN REMEMBERED.
          //
          // `/state` carries a room object list, but it is whatever the client last happened
          // to be told — the poller never requests one — so after a walk it can still
          // describe the room we left. A trade needs the receiver to be VISIBLE to the giver
          // at the moment of the offer, and "X is not in the room with Y" while the two are
          // standing together is what comes of reading a stale snapshot. This puts
          // BP_SEND_ROOM_CONTENTS on the wire and waits for the reply.
          // A WINDOW ONTO THE EVENT STREAM, WHICH IS THE OTHER HALF OF EVERY MUTATION.
          //
          // This game answers almost nothing with an error: a merchant refusal is a
          // sentence spoken to the room, a skill you cannot learn is simply absent, a
          // malformed drop moves nothing and says so in prose. So "send the packet" is
          // never the whole of a tool — reading what the server said back is — and on a
          // keeper-backed broker the reading half did not exist. The broker's emulated
          // client said so honestly (`no_event_stream: true`) and eighty-odd call sites
          // treated that as "nothing happened".
          //
          // The socket stays here; only the window crosses. `since` comes from the
          // snapshot's `ev_seq` and may be a second or two old, which is the safe
          // direction: a caller that filters by kind would rather see one stale event than
          // miss the reply it is waiting for.
          case 'events': {
            const c = session.client;
            if (!c) { json({ error: 'no client' }, 409); return; }
            const since = Number.isFinite(Number(args.since)) ? Number(args.since) : c.evSeq;
            const kinds = args.kinds ?? null;
            const w = await c.waitFor({
              since,
              kinds,
              // Bounded on this side too. A caller that asks for thirty seconds holds a
              // keeper's HTTP handler for thirty seconds, and the keeper has a body to
              // drive; the broker's own fetch timeout is the other half of this.
              timeoutMs: Math.min(20000, Math.max(0, Number(args.timeout_ms) || 4000)),
            });
            json({ events: w.events, seq: c.evSeq, since, timedOut: !!w.timedOut });
            return;
          }
          case 'room_contents': {
            const c = session.client;
            if (!c) { json({ error: 'no client' }, 409); return; }
            const since = c.evSeq;
            await session.pacer.submit('read', () => c.roomContents());
            const w = await c.waitFor({ since, kinds: ['room-contents'],
                                        timeoutMs: Number(args.timeout_ms ?? 2500) })
                             .catch(() => null);
            const me = c.self;
            json({
              room: session.world?.room?.num ?? null,
              answered: !!w && !w.timedOut,
              you: me ? { col: me.col, row: me.row } : null,
              objects: [...(c.room?.objects?.values?.() ?? [])]
                .filter(o => o.id !== c.selfId)
                .map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) ?? '',
                             flags: o.flags ?? 0, is_player: !!((o.flags ?? 0) & 0x0004),
                             col: o.col ?? null, row: o.row ?? null })),
            });
            return;
          }

          // THE TRADE HANDSHAKE, ONE STEP PER CALL.
          //
          // A trade is offer -> counter-with-nothing -> accept, interleaved across TWO
          // characters, and accepting before the counteroffer has arrived is logged by the
          // server as cheating and cancels the trade. Both ends used to be driven from the
          // broker against a live client it had in hand; on a keeper-backed broker there is
          // no client and no event stream over there, so every one of those steps was either
          // "not a function" or a `waitFor` that resolved null.
          //
          // The SEQUENCING stays in the broker — it is the only thing that can see both
          // characters — and each step is executed here, by the process that owns the socket.
          // Each waiting step takes an explicit `since` for a reason: the reply can arrive
          // before the broker gets round to asking about it, and `waitFor`'s default `since`
          // is "now", which steps straight over the event being waited for.
          // THE SHOP, WHICH A KEEPER-BACKED CHARACTER COULD NOT OPEN AT ALL.
          //
          // The broker's `shop` tool calls `c.find(name)`, `c.buy(id)`, `c.waitFor(...)` and
          // `c.buyItems(...)`. On a keeper-backed session `c` is KeeperProxy's emulated
          // client, which is REBUILT FROM A /state SNAPSHOT — a picture, not a wire — so the
          // tool died on the first of them with `c.find is not a function` and no character
          // in this fleet could buy anything. Measured 2026-08-29: a resupply run walked two
          // characters across the map to a shop that could not be opened when they arrived.
          //
          // The fix is NOT to fake `buy` on the picture. KeeperProxy's own note says it:
          // mutations go over /action, and "the wire is still only ever touched by the
          // process that owns it". So the two round trips that must touch the wire live
          // here, and the broker keeps the arithmetic — purse, weight and bulk clamping —
          // where it already is.
          //
          // Two ops rather than one: reading a shop and buying from it are separate wire
          // exchanges, and the clamping in between needs the item list and its prices before
          // it can decide what actually fits.
          case 'shop': {
            const c = session.client;
            if (!c) { json({ error: 'no client' }, 409); return; }
            const op = String(args.op ?? 'list');
            if (op === 'list') {
              const seller = Number(args.seller_id);
              if (!Number.isFinite(seller)) { json({ error: 'shop list needs seller_id' }, 400); return; }
              await session.pacer.submit('buy', () => c.buy(seller)).catch(() => {});
              const { events, timedOut } = await c.waitFor({
                kinds: ['shop', 'message'], timeoutMs: Number(args.timeout_ms) || 4000 });
              const shop = (events ?? []).find(e => e.kind === 'shop');
              json(shop
                ? { seller_id: shop.sellerId, items: shop.items, seq: c.evSeq }
                : { seller_id: seller, items: [], timed_out: !!timedOut,
                    // The refusal is a SENTENCE SPOKEN TO THE ROOM here, never an error on
                    // the wire, so the messages are the whole diagnosis.
                    said: (events ?? []).map(e => e.text).filter(Boolean).join('; ') });
              return;
            }
            if (op === 'buy') {
              const seller = Number(args.seller_id);
              if (!Number.isFinite(seller)) { json({ error: 'shop buy needs seller_id' }, 400); return; }
              // {id, amount} SURVIVES THE TRIP. encodeIdList writes a BARE id as four plain
              // bytes with no tag nibble, so the server's number_list arrives empty and
              // UserBuyItems has no quantity to pair with the item — nothing is bought and
              // nothing is said. That is why this fleet has zero successful purchases in its
              // recorded history while selling always worked.
              const wanted = [].concat(args.items ?? []).map(i =>
                (i && typeof i === 'object')
                  ? { id: Number(i.id), amount: Number(i.amount) }
                  : Number(i));
              if (!wanted.length) { json({ error: 'shop buy needs items' }, 400); return; }
              const before = c.evSeq;
              await session.pacer.submit('buy', () => c.buyItems(seller, wanted));
              const after = await c.waitFor({ since: before,
                timeoutMs: Number(args.timeout_ms) || 4000 });
              // WHAT ARRIVED, NOT WHAT WAS ASKED FOR. Reporting the request back as
              // `bought` is a claim the wire never made: a merchant that refuses says so in
              // a SENTENCE to the room, or says nothing at all, and either way the packet
              // succeeded. Measured 2026-08-29: a buy of 4 herbs by a character with no
              // shillings returned `bought: [{id:521, amount:4}]` and moved nothing.
              // `got` is the only half of this answer that is evidence.
              const evs = after?.events ?? [];
              json({ asked: wanted, seq: c.evSeq,
                     got: evs.filter(e => e.kind === 'got').flatMap(e => e.items ?? []),
                     said: evs.map(e => e.text).filter(Boolean).join('; ') });
              return;
            }
            json({ error: `shop op must be list or buy, not "${op}"` }, 400);
            return;
          }
          // THE BANK, FOR THE SAME REASON AS THE SHOP ABOVE.
          //
          // `c.balance()`, `c.deposit()` and `c.withdraw()` are wire calls, and on a
          // keeper-backed character `c` in the broker is a /state snapshot with none of
          // them. Measured 2026-08-29 at the First Royal Bank of Tos, after walking a
          // character across the map to reach it:
          //
          //     balance  -> error: c.balance is not a function
          //     withdraw -> error: c.withdraw is not a function
          //
          // Same split as `shop`: the exchange happens here, and the broker keeps the
          // bookkeeping — the balance record, the arithmetic, the ledger line.
          case 'bank': {
            const c = session.client;
            if (!c) { json({ error: 'no client' }, 409); return; }
            const op = String(args.op ?? '');
            const amount = Math.floor(Number(args.amount) || 0);
            if (op !== 'balance' && !(amount > 0)) {
              json({ error: `${op || 'bank'} needs a positive amount` }, 400); return;
            }
            const fn = { balance: () => c.balance(),
                         deposit: () => c.deposit(amount),
                         withdraw: () => c.withdraw(amount) }[op];
            if (!fn) { json({ error: `bank op must be balance, deposit or withdraw, not "${op}"` }, 400); return; }
            const before = c.evSeq;
            await session.pacer.submit('bank', fn);
            const after = await c.waitFor({ since: before,
              timeoutMs: Number(args.timeout_ms) || 4000 });
            // A BALANCE IS PROSE, SENT ONCE, and a withdrawal states the amount HANDED OVER
            // rather than the new balance. So the sentences are the answer and the broker
            // parses them; this hands them over untouched rather than guessing here.
            json({ op, amount: op === 'balance' ? undefined : amount, seq: c.evSeq,
                   said: (after?.events ?? []).map(e => e.text).filter(Boolean) });
            return;
          }
          case 'trade': {
            const c = session.client;
            if (!c) { json({ error: 'no client' }, 409); return; }
            const op = String(args.op ?? '');
            const view = () => (c.trade
              ? { role: c.trade.role ?? null, may_accept: c.trade.mayAccept ?? null,
                  revision: c.trade.revision ?? null }
              : null);
            const idList = (xs) => [].concat(xs ?? []).map(i =>
              (i && typeof i === 'object') ? { id: Number(i.id), amount: Number(i.amount) } : Number(i));
            switch (op) {
              // WHERE IN THE STREAM WE ARE, BEFORE ANYTHING IS SENT. The broker reads this
              // off the receiver first, so its later `await_offer` cannot miss an offer that
              // landed while the round trip was still in flight.
              case 'seq': { json({ seq: c.evSeq, trade: view() }); return; }
              case 'cancel': {
                await session.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
                json({ cancelled: true, seq: c.evSeq, trade: view() });
                return;
              }
              case 'offer': {
                const to = Number(args.to_id);
                if (!Number.isFinite(to)) { json({ error: 'offer needs to_id' }, 400); return; }
                // {id, amount} SURVIVES THE TRIP, because a bare id means ONE: the server
                // reads "is there a quantity here" from the tag nibble alone. Flattening a
                // stack to its id hands over a single item and reports complete — which is
                // what it did, one shilling out of 1,647.
                const items = idList(args.items);
                if (!items.length) { json({ error: 'offer needs items' }, 400); return; }
                const since = c.evSeq;
                await session.pacer.submit('trade', () => c.offer(to, items));
                json({ sent: true, since, to_id: to, count: items.length, trade: view() });
                return;
              }
              case 'await_offer': {
                const w = await c.waitFor({ since: args.since ?? undefined, kinds: ['offered-to-us'],
                                            timeoutMs: Number(args.timeout_ms ?? 6000) })
                                 .catch(() => null);
                json({ saw: !!w?.events?.length, timed_out: w?.timedOut ?? true,
                       seq: c.evSeq, trade: view() });
                return;
              }
              // COUNTER WITH NOTHING. That is how a gift is accepted here, and it is what
              // grants the GIVER permission to accept — `mayAccept` goes true on the
              // offerer's side only once a counteroffer has arrived.
              case 'counter': {
                const items = idList(args.items);
                const since = c.evSeq;
                await session.pacer.submit('trade', () => c.counterOffer(items));
                json({ sent: true, since, count: items.length, trade: view() });
                return;
              }
              case 'await_countered': {
                const w = await c.waitFor({ since: args.since ?? undefined, kinds: ['countered'],
                                            timeoutMs: Number(args.timeout_ms ?? 6000) })
                                 .catch(() => null);
                json({ saw: !!w?.events?.length, timed_out: w?.timedOut ?? true,
                       seq: c.evSeq, trade: view() });
                return;
              }
              // THE ACCEPT, AND WHAT IT IS ALLOWED TO SAY ABOUT ITSELF. `may_accept` is
              // reported rather than enforced: `trade` lies in both directions and the only
              // proof that anything moved is the receiver's own count afterwards, which is
              // what the broker checks. It is here so a failed exchange can be read back —
              // a false `may_accept` means the counteroffer never arrived, and this accept
              // ENDED the trade rather than completing it.
              case 'accept': {
                const before = view();
                await session.pacer.submit('trade', () => c.acceptOffer());
                json({ sent: true, may_accept_before: before?.may_accept ?? null, trade: view() });
                return;
              }
              default:
                json({ error: `unknown trade op "${op}"` }, 400);
                return;
            }
          }

          default:
            // Not ours. See `actionFallthrough` at the top of this handler: the second
            // `/action` switch below owns a dozen more verbs and has never been reached.
            actionFallthrough = { name, args };
            break;
        }
      } catch (e) {
        json({ error: e?.message ?? String(e) }, 500);
        return;
      }
      if (!actionFallthrough) return;
    }

    // WHAT THIS CHARACTER HAS HEARD, because the broker cannot hear anything.
    //
    // The `chat` tool reads `client.chatSince()` off the session, and the emulated client a
    // keeper-backed broker holds has no chat ring — so it hit `if (!c?.chat) continue` and
    // returned `count: 0` for the whole fleet, for ever. Not an error: a silent, permanent
    // "nobody has said anything", which is the worst possible answer about a shared server.
    // Everything anybody says to this character arrives on THIS socket, so the transcript
    // lives here and the broker asks for it.
    //
    // Sequences are per character and this endpoint is one character, so `since` means what
    // it says here in a way it cannot across a fleet.
    if (req.method === 'GET' && path === '/chat') {
      const c = session.client;
      if (!c?.chat) { json({ seq: 0, messages: [], note: 'not in game' }); return; }
      const q = url.searchParams;
      const channels = q.get('channels') ? q.get('channels').split(',').filter(Boolean) : null;
      const limit = Number(q.get('limit') ?? 50);
      const rows = c.chatSince(Number(q.get('since') ?? 0), {
        channels, includeSelf: q.get('include_self') !== 'false',
      });
      json({ seq: c.chatSeq, heard_by: c.me?.name ?? null,
             messages: rows.slice(-limit) });
      return;
    }

    // THE FLIGHT RECORDER, WHICH THE BROKER DOES NOT HAVE EITHER.
    //
    // Same shape of gap as /chat, and it cost a measurement rather than a fleet: the
    // `recording` tool reads `session.recorder` off the session, and a KeeperProxy has no
    // recorder, so on a keeper-backed broker every call threw
    // `Cannot read properties of undefined (reading 'tail')`. m59-circuit.mjs counts
    // incoming SWINGS off this to answer "did the road get more dangerous", and it was
    // reporting `0 swing(s) taken` for whole laps in which characters were being eaten --
    // the one survival number the experiment exists to produce, silently zero.
    //
    // The Session that owns the socket owns the recorder. The broker holds neither.
    if (req.method === 'GET' && path === '/recording') {
      const r = session.recorder;
      if (!r) { json({ lines: 0, recording: false, tail: [], note: 'no recorder on this session' }); return; }
      const q = url.searchParams;
      if (q.get('action') === 'status') {
        json({ recording: r.enabled, bytes_written: r.written,
               dropped_lines: r.dropped, buffered: r.buf?.length ?? 0 });
        return;
      }
      const kinds = q.get('kinds') ? q.get('kinds').split(',').filter(Boolean) : undefined;
      const lines = r.tail(Number(q.get('limit') ?? 120), kinds);
      json({ agent, lines: lines.length, recording: r.enabled, tail: lines });
      return;
    }

    if (req.method === 'GET' && path === '/pacerstats') {
      // Ground-truth packet rates for the server's 5/s throttle (user.kod:50).
      // prodRate = what the tick loop SUBMITS per second; sentRate = what actually
      // leaves the socket per second (what the server counts toward bSpam).
      const p = session.pacer;
      json({
        in_game: inGame,
        prod_per_sec: p ? +(p.prodRate()).toFixed(2) : null,
        sent_per_sec: p ? +(p.sentRate()).toFixed(2) : null,
        prod_by_kind: p ? p.prodByKindRate() : {},
        queue_depth: p ? p.depth : null,
        min_gap_ms: p ? p.minGapMs : null,
        note: 'server drops packets when sent_per_sec > 5 (INCOMING_PACKET_THROTTLE). prod > sent means a backlog.',
      });
      return;
    }

    if (req.method === 'GET' && path === '/mode') {
      // WHERE IS THIS KEEPER'S MODE COMING FROM? The mode silently reverting to 'survive'
      // was undiagnosable because nothing said which value won. This reports, in priority
      // order, every source of the mode so the winning one is visible:
      //   1. `running`   - what the autopilot object actually has NOW (ground truth).
      //   2. `from_file` - what THIS process read from the fleet file at startup (line 74).
      //   3. `file_now`  - what the fleet file says RIGHT NOW (re-read live). If this differs
      //                    from `from_file`, the broker overwrote it after we started.
      //   4. `tick_running` - is the tick driver actually up (session._tickDecide) and driving?
      let fileNow = null, fileNowErr = null;
      try {
        const { readFileSync: rfs } = await import('node:fs');
        const fp = process.argv.includes('--fleet')
          ? null : 'substrate/fleet-state.json';
        // Resolve the same file the startup read. --fleet is passed to us; reuse the
        // fleetpath resolution so we read the identical file.
        const { resolveFleet } = await import('./m59-fleetpath.mjs');
        const rf = resolveFleet(process.argv.slice(2));
        const now = JSON.parse(rfs(rf.stateFile, 'utf8'));
        fileNow = now?.[agent]?.autopilot?.mode ?? null;
      } catch (e) { fileNowErr = e.message; }
      json({
        agent,
        running: autopilot?.mode ?? null,
        from_file: mode,
        file_now: fileNow,
        file_now_error: fileNowErr,
        tick_running: !!(session._tickDecide),
        in_game: inGame,
        note: 'running is ground truth. If file_now !== from_file, the broker rewrote the roster after this keeper started.',
      });
      return;
    }

    if (req.method === 'GET' && path === '/rxstats') {
      // Is the client actually RECEIVING server data? rxBytes/rxPackets are updated on
      // every socket chunk. If these aren't growing, the connection is dead/stale and
      // no command (attack, move, look) is reaching the server or getting a reply.
      const c = session.client;
      const lastRx = c?.lastRxAt ?? 0;
      json({
        in_game: inGame,
        rxBytes: c?.rxBytes ?? 0,
        rxPackets: c?.rxPackets ?? 0,
        lastRxAgo_ms: lastRx ? Date.now() - lastRx : null,
        totalSwingsSent: c?.attackLog?.length ?? 0,
      });
      return;
    }

    if (req.method === 'GET' && path === '/swingstats') {
      // Ground-truth swing rate: the timestamps of every REQ_ATTACK packet the
      // client actually sent (this.client.attackLog). This is the real rate,
      // independent of what the decider "decided" or what the log (which dedups
      // repeated lines) shows. Report the count, the rate over the last N, and
      // the gaps between consecutive swings so a stall or a too-slow cadence is
      // visible.
      const log = session.client?.attackLog ?? [];
      const now = Date.now();
      // Rate over the trailing 15s window.
      const recent = log.filter(e => now - e.at <= 15000);
      const n = recent.length;
      let gaps = null;
      if (n >= 2) {
        gaps = [];
        for (let i = 1; i < recent.length; i++) gaps.push(recent[i].at - recent[i-1].at);
        const avg = Math.round(gaps.reduce((a,b)=>a+b,0) / gaps.length);
        const min = Math.min(...gaps);
        const max = Math.max(...gaps);
        gaps = { avg, min, max };
      }
      json({
        in_game: inGame,
        total_swings: log.length,
        swings_last_15s: n,
        rate_per_sec: n ? +(n / 15).toFixed(3) : 0,
        one_every_ms: n >= 2 ? Math.round(15000 / n) : null,
        gaps_ms: gaps,
        last_swing_ago_ms: log.length ? now - log[log.length-1].at : null,
      });
      return;
    }

    if (req.method === 'GET' && path === '/combatstats') {
      // Ground-truth combat outcomes: the server's own prose for each swing
      // (hit / miss / out of range), classified and timestamped by the client
      // (this.client.combatLog). This tells us whether swings are actually
      // LANDING or silently whiffing — the question we kept assuming.
      const log = session.client?.combatLog ?? [];
      const now = Date.now();
      const count = (k, winMs) => log.filter(e => e.kind === k && (!winMs || now - e.at <= winMs)).length;
      const recent = log.filter(e => now - e.at <= 60000);
      const hits = recent.filter(e => e.kind === 'hit').length;
      const misses = recent.filter(e => e.kind === 'miss').length;
      const outOfRange = recent.filter(e => e.kind === 'out_of_range').length;
      const total = hits + misses + outOfRange;
      json({
        in_game: inGame,
        last_60s: { hits, misses, out_of_range: outOfRange, total,
                    hit_rate: total ? +(hits / total).toFixed(3) : null },
        all_time: { hits: count('hit'), misses: count('miss'), out_of_range: count('out_of_range') },
        recent: recent.slice(-12).map(e => ({ at: e.at, kind: e.kind, text: e.text })),
      });
      return;
    }

    if (req.method === 'GET' && path === '/room-view') {
      // Live room view for the 3D map. Reads directly from the session's client.
      const c = session.client;
      const me = c?.self;
      const room = c?.room;
      const roomBinding = session.world?.roomBinding ?? null;
      const worldRoom = roomBinding?.room ?? session.world?.room ?? null;
      const roomWire = roomBinding?.room_wire ?? null;
      if (!room?.objects) return json({ error: 'no room data', in_game: inGame });
      const objects = [];
      for (const o of room.objects.values()) {
        objects.push({
          id: o.id, col: o.col, row: o.row,
          ...renderState(c, o),
          name: c?.rsc?.get?.(o.nameRsc) ?? '',
          is_self: o.id === c?.selfId,
          // OF.PLAYER is 0x0004 (m59-parse.mjs). The old 0x01 check was part of
          // NOMOVEON_MASK and mislabelled every NPC (mummies etc.) as a player,
          // which made the combat controller skip all of them.
          is_player: !!(o.flags & 0x0004),
          can_attack: !!(o.flags & 0x0008),
          // THE RAW FLAGS, SO NOBODY DOWNSTREAM HAS TO GUESS THE REST OF THEM.
          //
          // `is_player` and `can_attack` are two bits out of a word, and every consumer
          // that wanted a third had to either re-derive it from a hex constant of its own
          // or go without. The broker's render projection wants `affordances(flags)` — the
          // same closed list `World.objects()` publishes — so that a renderer can tell a
          // mummy from a bar stool. It cannot compute that from two booleans, which is why
          // /rts/v1/read had to collapse everything that was not a player into one bucket.
          // Sent as the word, parsed by the one function that owns its meaning.
          flags: o.flags ?? 0,
          degrees: o.degrees ?? null,
          ...(o.amount ? { amount: o.amount } : {}),
        });
      }
      json({
        cols: room.cols ?? 50,
        rows: room.rows ?? 48,
        self: me ? { col: me.col, row: me.row, degrees: me.degrees ?? null,
                     object_id: c?.selfId ?? null,
                     ...renderState(c, me) } : null,
        objects,
        room_name: c?.rsc?.get?.(c.roomNameRsc) ?? null,
        // The MAP room number (session.world.room.num), NOT the runtime room id
        // (c.room.id). The runtime id does not match the world map's numbering:
        // c.room.id is 2000 for "Raza Inn", but the map's room 2000 is a different
        // room (Ko'catan). The geometry lookup is by map number / name, so sending the
        // runtime id made the 3D view + geometry load the WRONG room's .roo — which is
        // why the character "spun in circles": the fine geometry model was for a
        // different room than the one the server had, so every validated step landed
        // somewhere unexpected and the walk re-planned in a loop. session.world.room.num
        // is the same source the /health endpoint uses (1011 for Raza Inn).
        room_num: worldRoom?.num ?? c?.room?.id ?? null,
        // Recomputed from the same synchronous client cache as this room view.
        // keeperView reconciles it with the independently cached /state tuple
        // before publishing bound provenance.
        room_wire: roomWire,
        // The decider's current target, for the 3D viewer.
        target: (() => {
          const tid = session._tickDecide?.state?.()?.targetId ?? null;
          if (tid == null) return null;
          const t = room.objects.get(tid);
          if (!t) return null;
          return { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) ?? '' };
        })(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/grid') {
      // Debug: render the fine-walkable grid as ASCII around the character.
      // # = fine-blocked, . = fine-open, @ = self, T = target.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      const wroom = session?.world?.room ?? null;
      if (!me) return json({ error: 'no self' });
      // Diagnostics: which room did the World resolve, and does its size match the .roo?
      const gridHeader = `self=(${me.col},${me.row}) worldRoom=${wroom ? wroom.name+' num='+wroom.num : 'null'} rooDims=${wroom?.roo ? wroom.roo.cols+'x'+wroom.roo.rows : '?'} clientRoomId=${c?.room?.id ?? '?'} `;
      const R = 8; // radius in squares
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      const lines = [];
      lines.push(gridHeader);
      lines.push(`self=(${me.col},${me.row}) target=${t ? `(${t.col},${t.row})` : 'none'} fineHeightAt self=${geo?.fineHeightAt ? geo.fineHeightAt(me.col * 64 + 32, me.row * 64 + 32) : '?'} `);
      for (let r = me.row - R; r <= me.row + R; r++) {
        let line = '';
        for (let col = me.col - R; col <= me.col + R; col++) {
          if (col === me.col && r === me.row) { line += '@'; continue; }
          if (t && col === t.col && r === t.row) { line += 'T'; continue; }
          const f = geo?.fineWalkable ? geo.fineWalkable(r, col) : undefined;
          line += (f === false) ? '#' : '.';
        }
        lines.push(line);
      }
      json({ grid: lines.join('\n') });
      return;
    }
    if (req.method === 'GET' && path === '/raycast') {
      // Debug: trace the direct line from self to the target. Reports whether it's
      // clear, and if blocked, WHERE (the first collision point in client coords) +
      // the reason. This tells us if a wall/ledge is between them.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      if (!t || t.col == null) return json({ error: 'no target', pos: { col: me.col, row: me.row } });
      const sx = me.col * 64 + 32, sy = me.row * 64 + 32;
      const tx = t.col * 64 + 32, ty = t.row * 64 + 32;
      const trace = geo?.traceFineMoveClient ? geo.traceFineMoveClient(
        protocolToClient(sx), protocolToClient(sy),
        protocolToClient(tx), protocolToClient(ty), { slide: false }) : null;
      json({
        self: { col: me.col, row: me.row },
        target: { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) },
        trace: trace ? {
          available: trace.available, moved: trace.moved, blocked: trace.blocked,
          reason: trace.reason ?? null,
          // Convert the client stop point back to viewer col/row (1-indexed game squares).
          stopProtocolX: trace.x != null ? clientToProtocol(trace.x) : null,
          stopProtocolY: trace.y != null ? clientToProtocol(trace.y) : null,
          stopSquare: trace.x != null
            ? { col: Math.floor(clientToProtocol(trace.x) / 64), row: Math.floor(clientToProtocol(trace.y) / 64) }
            : null,
        } : 'no trace fn',
      });
      return;
    }
    if (req.method === 'GET' && path === '/edgecheck') {
      // Debug: trace the edge between two squares (?c1=&r1=&c2=&r2=) at several
      // radius/slide combos, so we can see what distinguishes a ledge wall
      // (must be rejected) from a corridor (must be allowed).
      const geo = session?.world?.geometry;
      if (!geo?.traceFineMoveClient) return json({ error: 'no geometry' });
      const u = new URL(req.url, 'http://x');
      const g = (k, d) => { const v = parseInt(u.searchParams.get(k), 10); return Number.isInteger(v) ? v : d; };
      const c1 = g('c1'), r1 = g('r1'), c2 = g('c2'), r2 = g('r2');
      const CF = 1024, HF = 512;
      const a = { x: (c1 - 1) * CF + HF, y: (r1 - 1) * CF + HF };
      const b = { x: (c2 - 1) * CF + HF, y: (r2 - 1) * CF + HF };
      const R = 248; // PLAYER_RADIUS
      const combos = [
        ['r1 nslide', { slide: false, playerRadius: 1 }],
        ['r1 slide',  { slide: true,  playerRadius: 1 }],
        ['R  nslide', { slide: false, playerRadius: R }],
        ['R  slide',  { slide: true,  playerRadius: R }],
      ];
      const out = combos.map(([name, opt]) => {
        const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y, opt);
        return { name, arrived: t.arrived, blocked: t.blocked, reason: t.reason ?? null };
      });
      return json({ from: [c1, r1], to: [c2, r2], results: out });
    }
    if (req.method === 'GET' && path === '/findpath') {
      // Debug: compute the fine A* from self to an arbitrary square (?c=&r=).
      // Used to diagnose "why is the mover oscillating" — shows exactly what
      // the A* finds (or doesn't) for a destination the router is targeting.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const u = new URL(req.url, 'http://x');
      const dc = parseInt(u.searchParams.get('c'), 10);
      const dr = parseInt(u.searchParams.get('r'), 10);
      if (!Number.isInteger(dc) || !Number.isInteger(dr)) return json({ error: 'need ?c=<col>&r=<row>' });
      const F = 64, H = 32;
      const t0 = Date.now();
      const p = geo?.finePathProtocol
        ? geo.finePathProtocol(me.col * F + H, me.row * F + H, dc * F + H, dr * F + H, { step: 8, margin: 12 * F, maxNodes: 20000 })
        : { found: false, reason: 'no finePathProtocol' };
      return json({
        self: { col: me.col, row: me.row },
        to: { col: dc, row: dr },
        targetFineWalkable: geo?.fineWalkable ? geo.fineWalkable(dr, dc) : undefined,
        found: p.found,
        reason: p.reason ?? null,
        waypoints: (p.waypoints ?? []).map(w => ({ col: Math.round((w.x - H) / F) + 1, row: Math.round((w.y - H) / F) + 1 })),
        wpCount: p.waypoints?.length ?? 0,
        expanded: p.expanded ?? null,
        ms: Date.now() - t0,
      });
    }
    if (req.method === 'GET' && path === '/path3d') {
      // Debug: compute the fine path from self to the current target, plus a
      // raycast of the DIRECT line, for the 3D viewer. Waypoints are in
      // 0-indexed viewer coords (col/row, same as objects/self).
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      if (!t || t.col == null) return json({ path: [], direct: null });
      const F = 64, H = 32; // KOD_FINENESS, half
      const sx = me.col * F + H, sy = me.row * F + H;
      const tx = t.col * F + H, ty = t.row * F + H;
      // The fine path (waypoints in protocol coords -> viewer col/row).
      let path = [];
      if (geo?.finePathProtocol) {
        try {
          const p = geo.finePathProtocol(sx, sy, tx, ty, { step: 8, margin: 12 * F, maxNodes: 4000 });
          if (p.found) {
            path = (p.waypoints ?? []).map(w => ({
              x: Math.round((w.x - H) / F) - 1, z: Math.round((w.y - H) / F) - 1,
            }));
          }
        } catch {}
      }
      // Raycast the DIRECT line (client coords for traceFineMoveClient).
      let direct = null;
      if (geo?.traceFineMoveClient) {
        try {
          const trace = geo.traceFineMoveClient(protocolToClient(sx), protocolToClient(sy), protocolToClient(tx), protocolToClient(ty), { slide: false });
          direct = {
            blocked: !!trace.blocked,
            moved: !!trace.moved,
            reason: trace.reason ?? null,
            // Where the direct line stops, in viewer col/row (0-indexed).
            stopX: trace.x != null ? Math.floor(clientToProtocol(trace.x) / 64) - 1 : null,
            stopZ: trace.y != null ? Math.floor(clientToProtocol(trace.y) / 64) - 1 : null,
          };
        } catch (e) { direct = { blocked: false, error: e.message }; }
      }
      json({ path, direct, self: { x: me.col - 1, z: me.row - 1 }, target: { x: t.col - 1, z: t.row - 1 } });
      return;
    }
    if (req.method === 'GET' && path === '/probe') {
      // Debug: report the character's position, neighbor walkability,
      // and the geometry state. Used to diagnose stuck-on-a-ledge.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const neighbors = {};
      const dirs = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
      for (const [dir, [dc, dr]] of Object.entries(dirs)) {
        const nc = me.col + dc, nr = me.row + dr;
        const f = geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined;
        const s = geo?.standable ? geo.standable(nr, nc) : undefined;
        neighbors[dir] = { col: nc, row: nr, fine: f, coarse: s };
      }
      // The target and the engage square
      const tid = session._tickDecide?.state?.()?.targetId ?? null;
      const t = tid != null ? c?.room?.objects?.get?.(tid) : null;
      // Reachability from me to the target
      let reach = null;
      if (t && geo?.finePathProtocol) {
        const p = geo.finePathProtocol(
          me.col * 64 + 32, me.row * 64 + 32,
          t.col * 64 + 32, t.row * 64 + 32,
          { step: 8, margin: 12 * 64, maxNodes: 20000 });
        reach = { found: p.found, waypoints: p.waypoints?.length ?? 0, expanded: p.expanded ?? null, reason: p.reason ?? null };
      }
      json({
        pos: { col: me.col, row: me.row },
        myHeight: geo?.fineHeightAt ? geo.fineHeightAt(me.col * 64 + 32, me.row * 64 + 32) : null,
        neighbors,
        target: t ? { col: t.col, row: t.row, name: c?.rsc?.get?.(t.nameRsc) } : null,
        reach,
        geoReady: !!geo?.collisionReady,
        // Equipment + inventory + spells, for debugging the caster combat.
        equipment: (() => { try { const e = c.equipment?.(); return e ? { known: e.known, equipped: e.equipped.map(o => o.name) } : null; } catch { return 'err'; } })(),
        inventory: (() => { try { const inv = c.inventory ?? []; return inv.map(o => ({ n: c.rsc?.get?.(o.nameRsc) ?? o.name ?? '', id: o.id ?? null, count: o.count ?? o.amount ?? 1, flags: o.flags ?? null, rarity: o.rarity ?? null })); } catch { return 'err'; } })(),
        spells: (c.spells ?? []).map(s => ({ name: s.name, id: s.id })),
        // Any active effects / enchantments the client tracks.
        effects: (c.effects && typeof c.effects === 'function') ? c.effects() : (c.activeEffects ?? null),
        abilities: (c.abilities && typeof c.abilities === 'function') ? c.abilities() : (c.abilities ?? null),
      });
      return;
    }

    if (req.method === 'GET' && path === '/stepmask') {
      // Debug: for each of the 8 neighbors of self, report fineWalkable, standable,
      // AND moverStepLands (the actual step validator walkTo uses). This distinguishes
      // "the square is walkable" from "you can actually STEP to it from where you are."
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me) return json({ error: 'no self' });
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = me.row + dr, nc = me.col + dc;
          out.push({
            dir: [dr, dc],
            to: { col: nc, row: nr },
            fine: geo?.fineWalkable ? geo.fineWalkable(nr, nc) : undefined,
            standable: geo?.standable ? geo.standable(nr, nc) : undefined,
            stepLands: geo?.moverStepLands ? geo.moverStepLands(me.row, me.col, nr, nc) : undefined,
          });
        }
      }
      json({ self: { col: me.col, row: me.row }, hasStepMask: !!geo?._stepMask, cols: geo?.cols, rows: geo?.rows, neighbors: out });
      return;
    }

    if (req.method === 'GET' && path === '/traceline') {
      // Debug: sample fineWalkable along the direct line from self to a target square,
      // showing which square along the path the fine grid says is NOT walkable. This is
      // the exact thing the per-microstep check in traceFineMoveClient blocks on.
      const c = session.client;
      const me = c?.self;
      const geo = session?.world?.geometry;
      if (!me || !geo) return json({ error: 'no self or geometry' });
      const url2 = new URL(req.url, 'http://x');
      const tcol = Number(url2.searchParams.get('col') ?? me.col + 1);
      const trow = Number(url2.searchParams.get('row') ?? me.row);
      const x0 = me.col * 64 + 32, y0 = me.row * 64 + 32;  // protocol center
      const x1 = tcol * 64 + 32, y1 = trow * 64 + 32;
      const samples = [];
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(2, Math.ceil(dist / 8));  // sample every ~8 protocol units
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const sx = x0 + (x1 - x0) * t, sy = y0 + (y1 - y0) * t;
        const sc = Math.floor(sx / 64), sr = Math.floor(sy / 64);
        const fw = geo.fineWalkable ? geo.fineWalkable(sr, sc) : undefined;
        const st = geo.standable ? geo.standable(sr, sc) : undefined;
        samples.push({ t: +t.toFixed(2), sq: [sc, sr], fineWalkable: fw, standable: st });
      }
      // Collapse consecutive same-square samples
      const collapsed = [];
      for (const s of samples) {
        const last = collapsed[collapsed.length - 1];
        if (!last || last.sq[0] !== s.sq[0] || last.sq[1] !== s.sq[1]) collapsed.push(s);
      }
      json({ from: { col: me.col, row: me.row }, to: { col: tcol, row: trow }, path: collapsed });
      return;
    }

    if (req.method === 'GET' && path === '/movecheck') {
      // Debug: run validateFineTarget for the 4 cardinal neighbors and report the
      // exact refusal reason (room_security_unknown, geometry_blocked, etc.). This
      // distinguishes "the step mask says ok" from "validateFineTarget refuses the move."
      const c = session.client;
      const me = c?.self;
      if (!me) return json({ error: 'no self' });
      const geo = session?.world?.geometry;
      const out = {
        self: { col: me.col, row: me.row, x: me.x, y: me.y },
        roomSecurity: c?.room?.security,
        geoSecurity: geo?.security,
        collisionInvalidated: c?.room?.collisionInvalidated ?? null,
        inGame: c?.state,
      };
      const half = 32;
      out.neighbors = [];
      for (const [dir, dc, dr] of [['E',1,0],['W',-1,0],['N',0,-1],['S',0,1]]) {
        const nc = me.col + dc, nr = me.row + dr;
        const tx = nc * 64 + half, ty = nr * 64 + half;
        let v = null;
        try { v = session.validateFineTarget?.(tx, ty, { slide: true }); } catch (e) { v = { error: e.message }; }
        out.neighbors.push({ dir, to: { col: nc, row: nr },
          validation: v ? { available: v.available, moved: v.moved, blocked: v.blocked, reason: v.reason, note: v.note } : null });
      }
      json(out);
      return;
    }

    if (req.method === 'GET' && path === '/log') {
      const n = Number(url.searchParams.get('n') || 50);
      json({ lines: logLines.slice(-n) });
      return;
    }

    if (req.method === 'POST' && path === '/join') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      if (!joinWanted) changeJoinIntent(true);
      await join();
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/leave') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      changeJoinIntent(false);
      if (autopilot) autopilot.stop('keeper leave');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      // A retry may already be inside login. It must see the invalidated generation and
      // settle before this endpoint can truthfully report that the character stayed out.
      await keeperJoinInFlight?.promise?.catch(() => null);
      if (session.client) { try { session.client.close(); } catch {} }
      inGame = false;
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/rejoin') {
      // THE ONE THAT ACTUALLY DID THE DAMAGE. This handler ignores the posted body entirely
      // — `join()` below takes no arguments and uses this process's own account and
      // password — so a misaddressed rejoin never logged anybody in as somebody else. What
      // it did was drop a stranger's socket and re-log them in as themselves, every 45s, for
      // as long as the guessing broker was up. That is the `ACCOUNT ... in use; new
      // connection overrides old one` line in the server log.
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      changeJoinIntent(true);
      if (autopilot) autopilot.stop('rejoin');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      inGame = false;
      await new Promise(r => setTimeout(r, 1000));
      await join();
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/pass') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      if (autopilot?.running) {
        log(`[keeper] ${agent} forced pass`);
        // Force a pass by stopping and restarting
        autopilot.stop('forced pass');
        await new Promise(r => setTimeout(r, 500));
        autopilot.start();
      }
      json({ ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/policy') {
      const body = JSON.parse(await readBody(req));
      // A WRITE IS ADDRESSED LIKE EVERY OTHER WRITE. See `keeperEnvelope` in
      // m59-broker.mjs: a broker that has guessed this port would otherwise re-policy a
      // stranger's character, and a policy is the least visible thing you can change —
      // no logout, no server line, just somebody else's fleet quietly hunting the wrong
      // creature in the wrong room. Fails OPEN on an unaddressed body, as everywhere else.
      if (!requireAddressedWrite(req, body)) return;
      // FIVE RESERVED KEYS, NONE OF WHICH IS A POLICY FIELD. `agent`, `character`, and
      // `keeper_pid` are the exact process identity envelope.
      // `mode` lives on the Autopilot object, not in `policy` — assigning it into the
      // policy would leave a `policy.mode` that looks authoritative and is read by nothing,
      // which is the `purpose`-shaped bug this repository has already paid for once.
      // `by` IS THE FIFTH RESERVED KEY, and it is what the one existing log line lacked.
      // Twenty-one `policy updated` lines in a single process, none of them naming a
      // writer, could not answer "who reverted my spot policy" — which was the entire
      // question after deaths #24, #25 and #26. Stripped here rather than applied, for
      // exactly the reason the two keys above it are: a `policy.by` that looks
      // authoritative and is read by nothing is the `purpose`-shaped bug again.
      const { agent: _addressed, character: _character, keeper_pid: _keeperPid,
              mode: wantMode, by: writtenBy, ...fields } = body;
      const applied = [];
      let modeChange = null;
      // THE PAIRING INVARIANT, ON THE RECEIVING SIDE TOO. The broker coerces before it
      // pushes, but a push can arrive from anything holding this port, and `Object.assign`
      // below will merge whatever it is handed. `requireSafeWall` without `useSafeSpots`
      // asks this keeper to refuse a fight for the want of a wall it is not looking for.
      const coercedSpots = coerceSpotPair(fields);
      // The boot orders move with the live ones. See the `let policy` / `let mode`
      // declarations: without this the push survives only until the next rejoin.
      Object.assign(policy, fields);
      if (wantMode) mode = wantMode;
      if (autopilot) {
        // Captured before the merge — a diff needs both sides and `Object.assign` destroys
        // the first one. Shallow is right: policy fields are compared by value below.
        const before = { ...autopilot.policy };
        Object.assign(autopilot.policy, fields);
        applied.push(...Object.keys(fields));
        if (Object.hasOwn(fields, 'partner'))
          rememberFileSpotPartner(agent, autopilot.policy.partner ?? null);
        // `this.mode` is consulted fresh on every pass (m59-autopilot.mjs: `this.mode ===
        // 'farm'`), so this lands on the next decision without restarting the loop or
        // dropping the socket. Restarting the keeper was the only way to change a mode
        // before this, and it costs a logout and a rejoin sweep per character.
        if (wantMode && wantMode !== autopilot.mode) {
          modeChange = { from: autopilot.mode ?? null, to: wantMode };
          autopilot.mode = wantMode;
        }
        // WHAT IT WAS, NOT ONLY WHAT IT NOW IS.
        //
        // This line used to print the incoming fields flat, so a push and a revert of the
        // same flag looked identical — both just show the new value — and nothing said who
        // sent either. `before` is captured above the merge; the diff is the pair of
        // values, and `by` is the writer the broker now names on the wire. An older broker
        // sends no `by`, which reads as "unattributed" rather than as a lie.
        const rows = policyDiff(before, autopilot.policy)
          .filter(r => Object.hasOwn(fields, r.key));
        log(`[keeper] ${agent} policy updated: ` +
            (rows.length ? formatPolicyDiff(rows) : 'no field changed value') +
            ` | asked: ${JSON.stringify(fields)}` +
            ` | by ${writtenBy ?? 'unattributed (a keeper-policy push that named no writer)'}` +
            (modeChange ? ` | mode ${modeChange.from} -> ${modeChange.to}` : '') +
            (coercedSpots.length
              ? ` | coerced ${coercedSpots.map(c => `${c.key} ${c.from} -> ${c.to}`).join(', ')}`
              : ''));
      }
      // REPORT WHAT LANDED, NOT `ok: true`. This endpoint exists because a policy change
      // that silently did nothing is indistinguishable from one that worked, so a bare
      // acknowledgement would rebuild the exact failure on the receiving side. `applied`
      // is also the version marker the broker reads to tell a real confirmation from an
      // older keeper's reflexive ok.
      json({ ok: true, agent, applied, mode: autopilot?.mode ?? null,
             mode_changed: modeChange, running: !!autopilot?.running,
             // Same argument as `applied`: a field that was accepted and then changed must
             // ride back, or the pusher believes it got what it asked for.
             ...(coercedSpots.length ? { coerced: coercedSpots } : {}),
             no_autopilot: !autopilot });
      return;
    }

    if (req.method === 'POST' && path === '/pause') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      log(`[keeper] ${agent} pause requested`);
      if (autopilot) autopilot.stop('paused for testing');
      json({ ok: true, paused: true });
      return;
    }

    if (req.method === 'POST' && path === '/resume') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      log(`[keeper] ${agent} resume requested`);
      if (autopilot && !autopilot.running) {
        autopilot.start();
        json({ ok: true, resumed: true });
      } else {
        json({ ok: true, already_running: true });
      }
      return;
    }

    if (req.method === 'POST' && path === '/stop') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      log(`[keeper] ${agent} stop requested`);
      armShutdownWatchdog('POST /stop');
      changeJoinIntent(false);
      if (autopilot) autopilot.stop('keeper stop');
      if (session.client) {
        try { session.client.close(); } catch {}
      }
      saveFinalState();
      // Let the acknowledgement reach the verified caller before ending the process.
      json({ ok: true });
      setImmediate(() => process.exit(0));
      return;
    }

    if (req.method === 'POST' && path === '/cancel') {
      const asked = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      if (!requireAddressedWrite(req, asked)) return;
      session.movementGeneration++;
      json({ ok: true });
      return;
    }

    // THE SECOND `/action` SWITCH, REACHED ONLY BY FALLING OUT OF THE FIRST. Its guard used
    // to be a second `path === '/action'` test, which the first block always won — see the
    // note on `actionFallthrough` above. The body arrives already parsed because the request
    // stream was consumed up there.
    if (actionFallthrough) {
      const { name, args } = actionFallthrough;
      try {
        let result;
        switch (name) {
          case 'walk':
            result = await session.walkTo(args.col, args.row, args);
            break;
          case 'travel': {
            // EVERY NAME THE PROXY HAS USED, AND A LOUD REFUSAL WHEN THERE IS NONE.
            //
            // The broker's KeeperProxy sent `toRoomNum` and this read `to ?? room`, so
            // `dest` was undefined and session.travel(undefined) answered "no route from
            // 586 to undefined in the graph" -- a sentence that looks exactly like a
            // routing failure and is actually a wiring failure. Every travel through the
            // broker went nowhere from the day the keeper split landed, and the fleet
            // reported it as bad terrain.
            const dest = args.to ?? args.room ?? args.toRoomNum;
            if (dest == null) {
              result = { error: 'travel: no destination given (expected to/room/toRoomNum)',
                         args_seen: Object.keys(args ?? {}) };
              break;
            }
            const maxHops = args.maxHops ?? 5;
            result = await session.travel(dest, { maxHops });
            break;
          }
          case 'go': {
            const dest = args.to ?? args.room;
            const exits = session.world?.exits?.() ?? [];
            const candidates = dest != null ? exits.filter(e => e.to === Number(dest)) : exits;
            if (!candidates.length) {
              result = { error: `no exit to ${dest}`, exits: exits.map(e => ({ kind: e.kind, to: e.to, col: e.stand_on?.col, row: e.stand_on?.row })) };
            } else {
              result = await session.leaveViaAny(candidates);
            }
            break;
          }
          case 'go_exact': {
            // Use one specific exit square from the live world's published set. This is
            // intentionally narrower than `go`: it cannot reorder the candidates or inject
            // a stale baked anchor ahead of the square an operator has just observed. The
            // ordinary leaveVia path still performs the approach, BSP/fine-position checks,
            // outward-edge validation, pacing, and room-change confirmation.
            const dest = Number(args.to ?? args.room);
            const col = Number(args.col), row = Number(args.row);
            const c = session.need();
            const me = c.self;
            if (!Number.isFinite(dest) || !Number.isInteger(col) || !Number.isInteger(row)) {
              result = { error: 'go_exact requires integer to, col, and row' };
              break;
            }
            if (!me || me.col !== col || me.row !== row) {
              result = { error: 'not standing on the requested exit square',
                         expected: { col, row },
                         actual: me ? { col: me.col, row: me.row } : null };
              break;
            }
            const exits = session.world?.exits?.() ?? [];
            const exact = exits.find(e => Number(e.to) === dest
              && Number(e.stand_on?.col) === col && Number(e.stand_on?.row) === row);
            if (!exact) {
              result = { error: 'the live world does not publish that exact exit square',
                         requested: { to: dest, col, row },
                         exits: exits.filter(e => Number(e.to) === dest).map(e => ({
                           kind: e.kind, to: e.to, col: e.stand_on?.col, row: e.stand_on?.row,
                         })) };
              break;
            }
            result = await session.leaveVia(exact);
            break;
          }
          case 'attack': {
            const targetId = args.target ?? args.id;
            if (!targetId) {
              result = { error: 'no target id' };
            } else {
              const c = session.need();
              const tgt = c.room?.objects?.get?.(targetId);
              if (!tgt) {
                result = { error: `target ${targetId} not in room` };
              } else {
                const me = c.self;
                if (!me) {
                  result = { error: 'position unknown' };
                } else {
                  // Face the target
                  const deg = Math.atan2(tgt.row - me.row, tgt.col - me.col) * 180 / Math.PI;
                  await c.face(deg);
                  // Attack
                  c.attack(targetId);
                  await new Promise(r => setTimeout(r, 500));
                  // Check if it died
                  const after = c.room?.objects?.get?.(targetId);
                  result = { sent: true, killed: !after, target: tgt.nameRsc ? c.rsc?.get?.(tgt.nameRsc) : String(targetId) };
                }
              }
            }
            break;
          }
          case 'face': {
            const c = session.need();
            c.face(args.degrees ?? 0);
            result = { sent: true };
            break;
          }
          case 'cast': {
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const spellName = String(args.spell ?? '').toLowerCase();
            const spell = (c.spells ?? []).find(sp => {
              const n = c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '';
              return n.toLowerCase() === spellName;
            });
            if (!spell) {
              result = { error: `spell not found: ${spellName}` };
            } else {
              // A cast needs CONCENTRATION: any move or turn packet we send while the
              // spell is charging interrupts it and the cast fails. The tick driver
              // sends move/turn at 10Hz, so it would break the cast instantly. Freeze
              // the loop (hold the character perfectly still) and wait for the cast
              // to actually resolve — blink takes SEVERAL seconds, not the ~1s a
              // simple attack does. We wait for the `moved` event (the server confirms
              // the character relocated) or a max timeout, rather than a fixed short
              // hold that would unfreeze too early and let the next move packet kill
              // the cast.
              const loop = session._tickLoop;
              if (loop) {
                const since = c.evSeq;  // events after this are from the cast
                loop._frozen = true;
                c.cast(spell.id, []);
                const maxMs = Number(args.holdMs) || 15000;  // blink can take several s
                const w = await c.waitFor({ since, kinds: ['moved'], timeoutMs: maxMs });
                loop._frozen = false;
                const moved = w.events.filter(e => e.kind === 'moved');
                result = { sent: true, spell: spellName, frozenMs: Date.now() - since,
                           relocated: moved.length > 0, timedOut: w.timedOut };
              } else {
                c.cast(spell.id, []);
                result = { sent: true, spell: spellName };
              }
            }
            break;
          }
          case 'rest':
            result = { note: 'use goap instead' };
            break;
          case 'stand':
            // Use the pacer (the same path the tick driver's actuator uses), not
            // session.client.stand() directly — the pacer paces the packet and
            // handles the socket state. session.client can be undefined early in
            // the join, but the pacer is always present.
            await session.pacer.submit('stand', () => session.client?.stand?.()).catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true };
            break;
          case 'rawmove': {
            // DEBUG: client-authoritative move, no geometry check. The server does NOT
            // validate movement against geometry (it's all client-side), so this places
            // the character directly. Use when the mover's cached geometry is stale
            // (e.g. the Raza Blacksmith is 50x48 on the live server but 10x10 in the
            // local map, so the mover thinks the character is out of bounds and won't
            // path).
            // Use session.client directly (not need()) — need() throws when
            // client.state !== 'game', but the client can be fully functional (the
            // tick driver drives it fine) while the state field lags after a rejoin.
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const col = Number(args.col), row = Number(args.row);
            if (Number.isNaN(col) || Number.isNaN(row)) { result = { error: 'no col/row' }; break; }
            const { KOD_FINENESS } = await import('./m59-parse.mjs');
            const half = KOD_FINENESS / 2;
            await session.pacer.submit('move', () => c.moveTo(col * KOD_FINENESS + half, row * KOD_FINENESS + half, 18, c.room?.id ?? 0), 100).catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true, col, row };
            break;
          }
          case 'movetest': {
            // DEBUG: attempt a one-square move and return the SERVER'S REPLY.
            // Discriminates the stuck-state hypotheses: a blind/held character gets
            // "You are unable to go anywhere" (user_cant_go); a character wedged in
            // geometry gets a different reply (or the move just doesn't confirm).
            // Uses session.client directly (not need()).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const me = c.self;
            const col = Number(args.col ?? (me ? me.col + 1 : 0));
            const row = Number(args.row ?? (me ? me.row : 0));
            const { KOD_FINENESS } = await import('./m59-parse.mjs');
            const half = KOD_FINENESS / 2;
            const since = c.evSeq ?? 0;
            await session.pacer.submit('move', () => c.moveTo(col * KOD_FINENESS + half, row * KOD_FINENESS + half, 18, c.room?.id ?? 0), 100).catch(e => { result = { error: e.message }; });
            let reply = null, confirmed = null;
            try {
              const ev = await c.waitFor({ since, kinds: ['message', 'moved'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events) {
                const m = ev.events.find(e => e.kind === 'message');
                if (m) reply = m.text ?? m.what;
                const mv = ev.events.find(e => e.kind === 'moved');
                if (mv) confirmed = { col: mv.col, row: mv.row };
              }
            } catch {}
            const after = c.self;
            result = { sent: true, from: { col: me?.col, row: me?.row }, to: { col, row },
                       reply, confirmed, now: { col: after?.col, row: after?.row } };
            break;
          }
          case 'shop': {
            // DEBUG: open a shop directly by object id, with the loop frozen so the
            // tick driver's move/turn packets don't interrupt the shop interaction.
            // This is the manual override for when the buy atomic's approach can't
            // position the character (stale geometry).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const targetId = Number(args.id ?? args.object);
            if (!targetId) { result = { error: 'no object id' }; break; }
            const obj = c.room?.objects?.get(targetId);
            if (!obj) { result = { error: `object ${targetId} not in room` }; break; }
            const loop = session._tickLoop;
            if (loop) loop._frozen = true;
            const sinceEv = c.evSeq ?? 0;
            await session.pacer.submit('buy', () => c.buy(targetId)).catch(e => { result = { error: e.message }; });
            let shopItems = null, msg = null;
            try {
              const ev = await c.waitFor({ since: sinceEv, kinds: ['shop', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events) {
                const s = ev.events.find(e => e.kind === 'shop');
                if (s) shopItems = (s.items ?? []).map(i => ({ name: c.rsc?.get?.(i.nameRsc) ?? i.name, id: i.id, cost: i.cost }));
                const m = ev.events.find(e => e.kind === 'message');
                if (m) msg = m.text ?? m.what;
              }
            } catch {}
            if (loop) loop._frozen = false;
            result = { sent: true, targetId, name: c.rsc?.get?.(obj.nameRsc) ?? '', shopItems, msg };
            break;
          }
          case 'buyitem': {
            // DEBUG: buy an item directly. sellerId + itemId. Opens the shop first (to
            // activate the seller), then sends the real purchase packet (buyItems).
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const sellerId = Number(args.seller ?? args.seller_id ?? args.id);
            // A LIST, AND {id, amount} SPECS RATHER THAN BARE NUMBERS.
            //
            // This took exactly one bare item id, and `encodeIdList` writes a bare id as
            // four plain bytes with NO TAG NIBBLE — so the server's number_list arrives
            // empty, `UserBuyItems` has no quantity to pair with the item, and nothing is
            // bought and nothing is said. The broker's `shop` tool has always built
            // {id, amount} specs; there was no way to get one down here. Passed through
            // verbatim, because the tagging is `encodeIdList`'s job and re-deriving it here
            // is how the tag gets lost.
            const wanted = [].concat(args.items ?? args.itemId ?? args.item ?? [])
              .filter(i => i != null)
              .map(i => (i && typeof i === 'object')
                ? { id: Number(i.id), amount: Number(i.amount) }
                : Number(i));
            const itemId = wanted.length ? wanted : null;
            if (!sellerId || !itemId) { result = { error: 'need seller and itemId' }; break; }
            const loop = session._tickLoop;
            if (loop) loop._frozen = true;
            const sinceEv = c.evSeq ?? 0;
            try {
              // Open the shop to activate the seller.
              await session.pacer.submit('buy', () => c.buy(sellerId), 300).catch(() => {});
              await new Promise(r => setTimeout(r, 600));
              const before = c.evSeq ?? 0;
              // The real purchase packet.
              await session.pacer.submit('buy', () => c.buyItems(sellerId, wanted), 300).catch(() => {});
              const ev = await c.waitFor({ since: before, kinds: ['message', 'inventory', 'shop'], timeoutMs: 2500 }).catch(() => null);
              const msgs = (ev?.events ?? []).filter(e => e.text).map(e => e.text);
              // WHAT ARRIVED, NOT WHAT WAS ASKED FOR. A merchant that refuses says so in a
              // SENTENCE to the room, or says nothing at all, and either way the packet
              // succeeded — so echoing the request back as if it were the outcome is a
              // claim the wire never made. `got` is the only half of this that is evidence.
              result = { sent: true, sellerId, asked: wanted, msgs,
                         got: (ev?.events ?? []).filter(e => e.kind === 'got')
                                .flatMap(e => e.items ?? []),
                         allEvents: (ev?.events ?? []).map(e => e.kind) };
            } catch (e) { result = { error: e.message }; }
            if (loop) loop._frozen = false;
            break;
          }
          // SELL A PACK TO THE MERCHANT IN THIS ROOM. The broker's sell_all runs on its own
          // Session (m59-game.mjs, which has sellOne); a keeper-backed character runs the keeper's
          // Session, which does not — so the broker proxies sell_all here, where the CLIENT has the
          // raw trade packets. Quote-based and safe: an item with no counteroffer or a price below
          // min_price is cancelled and skipped, never handed over. Money and worn/wielded gear are
          // never offered, and any name matching `keep` is protected. A merchant with a per-offer
          // stack cap (the Barloque jeweler refuses a stack over 25, bqmerch.kod:113) is sold in
          // chunks of max_stack.
          case 'sell_all': {
            const c = session.client;
            if (!c) { result = { error: 'no client' }; break; }
            const ref = args.merchant;
            let merchant = null;
            if (ref != null) {
              if (typeof ref === 'number' || /^\d+$/.test(String(ref))) merchant = c.room?.objects?.get(Number(ref));
              else if (typeof c.find === 'function') { const h = c.find(String(ref)); merchant = h && h[0]; }
            }
            if (!merchant) { result = { error: `no merchant matching "${ref}" in this room` }; break; }
            const merchId = merchant.id;
            const keepRe = (args.keep || []).map(k => String(k).toLowerCase());
            const minPrice = Number(args.min_price ?? 1);
            const maxStack = args.max_stack == null ? null : Number(args.max_stack);
            const wornIds = new Set((typeof c.equipment === 'function' ? (c.equipment() || []) : []).map(o => o.id));
            const nameOf = (o) => c.rsc?.get?.(o.nameRsc) || '';
            const sellChunk = async (id, amount) => {
              const before = c.evSeq;
              await session.pacer.submit('trade', () => c.offer(merchId, [amount > 1 ? { id, amount } : id]));
              const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 }).catch(() => ({ events: [] }));
              if (!ev.events.find(e => e.kind === 'countered')) { await session.pacer.submit('trade', () => c.cancelOffer()).catch(() => {}); return { sold: false }; }
              const price = (c.trade?.theirs || []).reduce((n, i) => n + (i.amount || 1), 0);
              if (price < minPrice) { await session.pacer.submit('trade', () => c.cancelOffer()).catch(() => {}); return { sold: false, price }; }
              await session.pacer.submit('trade', () => c.acceptOffer());
              await new Promise(r => setTimeout(r, 1200));
              await session.pacer.submit('read', () => c.requestInventory()).catch(() => {});
              await c.waitFor({ kinds: ['inventory'], timeoutMs: 4000 }).catch(() => {});
              return { sold: true, price };
            };
            const loop = session._tickLoop; if (loop) loop._frozen = true;
            const sold = [], refused = [];
            const targets = [...new Set((c.inventory || []).map(nameOf).filter(Boolean))]
              .filter(nm => !/shilling|\bcoins?\b/i.test(nm) && !keepRe.some(k => nm.toLowerCase().includes(k)));
            try {
              for (const nm of targets) {
                let guard = 0;
                while (guard++ < 25) {
                  const it = (c.inventory || []).find(o => nameOf(o) === nm && !wornIds.has(o.id));
                  if (!it) break;
                  const stack = it.amount || 1;
                  const amount = maxStack && stack > maxStack ? maxStack : stack;
                  const r = await sellChunk(it.id, amount).catch(() => ({ sold: false }));
                  if (!r.sold) { refused.push(nm + (r.price != null ? ` (${r.price} < ${minPrice})` : '')); break; }
                  sold.push({ name: nm, amount, price: r.price });
                  if (!maxStack || stack <= maxStack) break;   // whole stack sold, or single-shot when uncapped
                }
              }
            } catch (e) { refused.push('loop error: ' + e.message); }
            if (loop) loop._frozen = false;
            result = { sold, refused, total_received: sold.reduce((n, s) => n + (s.price || 0), 0), count: sold.length };
            break;
          }
          // APPLY IS NOT USE, AND THE DIFFERENCE IS EATING.
          //
          // Food sends ReqEatSomething to the APPLY TARGET (food.kod:56), so `use` on a
          // loaf does nothing at all — no message, no error, no vigor. That matters more
          // here than anywhere: resting stops awarding vigor at 80 of 200, everything above
          // it has to be eaten, and a character sitting at 80 with bread in its pack is far
          // more likely to die than one above 85. The broker's `act` tool has an `eat` verb
          // for exactly this and it threw `c.apply is not a function` on every
          // keeper-backed character, which is every character in a running fleet.
          //
          // Defaults to applying to SELF, because that is what eating is and what every
          // caller here wants; an explicit `on` covers applying one thing to another.
          case 'apply': {
            const id = args.id ?? args.item;
            // A BROKER OLD ENOUGH TO STILL BELIEVE IN -1 MUST NOT SEND IT. That was the
            // emulated client's placeholder for "self" before /state carried the real id,
            // and forwarding it would apply the food to an object that does not exist —
            // which, this being Meridian, would report no error whatsoever.
            const asked = args.on ?? args.target;
            const onto = (asked == null || Number(asked) < 0) ? session.client?.selfId : asked;
            if (!id) { result = { error: 'no item id' }; break; }
            if (onto == null) { result = { error: 'apply: no target, and self is unknown' }; break; }
            const sinceEv = session.client?.evSeq ?? 0;
            await session.pacer.submit('act', () => session.client?.apply?.(id, onto))
              .catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true, id, on: onto, since: sinceEv };
            break;
          }
          // THE REST OF THE `act` VERB SET, WHICH HAD NOWHERE TO LAND.
          //
          // The broker's `act` tool offers use, unuse, get, drop, activate, eat and go;
          // only `use` had a keeper equivalent, so on a keeper-backed character — every
          // character in a running fleet — the other five threw `c.<verb> is not a
          // function` in the broker before anything reached the wire.
          //
          // Each is one packet and the client already has it. They send and report the
          // send; what the server SAID about it is read separately through `events`,
          // because in this game the answer to a refused drop is a sentence to the room
          // and never an error on the socket.
          case 'unuse':
          case 'pickup':
          case 'activate': {
            const id = args.id ?? args.item;
            if (!id) { result = { error: `${name}: no item id` }; break; }
            const verb = name === 'pickup' ? 'get' : name;
            const sinceEv = session.client?.evSeq ?? 0;
            await session.pacer.submit('act', () => session.client?.[verb]?.(id))
              .catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true, id, verb, since: sinceEv };
            break;
          }
          // DROP TAKES A LIST, AND A STACK IS NOT AN ITEM. Money, arrows, mushrooms and
          // herbs are one object carrying a count, and the server reads that count from a
          // separate list (UserDropItems, user.kod:3775) — so the id list has to arrive in
          // the tagged form. The broker builds those specs; this hands them straight to
          // `encodeIdList` rather than coercing them to bare numbers, which is the
          // malformed-id-list failure that completes the handshake and moves nothing.
          case 'drop': {
            const items = [].concat(args.items ?? args.id ?? []);
            if (!items.length) { result = { error: 'drop: no items' }; break; }
            const sinceEv = session.client?.evSeq ?? 0;
            await session.pacer.submit('drop', () => session.client?.drop?.(items))
              .catch(e => { result = { error: e.message }; });
            result = result ?? { sent: true, items, since: sinceEv };
            break;
          }
          case 'use':
          case 'equip': {
            const id = args.id ?? args.item;
            if (!id) { result = { error: 'no item id' }; break; }
            // Equip/use an item by id. Bypasses the decider so we can test whether
            // the server accepts the equip at all (diagnose the mace-not-equipping
            // case: is the item broken, is the character seated, is the id stale?).
            // Stand first (a seated character cannot equip), then use.
            await session.pacer.submit('stand', () => session.client?.stand?.()).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
            const before = session.client.equipment?.()?.equipped?.map(o => o.id) ?? [];
            const sinceEv = session.client.evSeq ?? 0;
            await session.pacer.submit('use', () => session.client?.use?.(id)).catch(e => { result = { error: e.message }; });
            // Wait for the server's response — a broken weapon says so in prose
            // (player.kod:127 "You can't use X--it's broken"). Capture any message.
            let serverSaid = null;
            try {
              const ev = await session.client.waitFor({ since: sinceEv, kinds: ['equipment', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events?.length) {
                serverSaid = ev.events.map(e => e.text ?? e.what ?? e.kind).join(' | ');
              }
            } catch {}
            const after = session.client.equipment?.()?.equipped?.map(o => o.id) ?? [];
            result = result ?? { sent: true, id, before, after, equipped: after.includes(id), serverSaid };
            break;
          }
          case 'look': {
            const id = args.id ?? args.item;
            if (!id) { result = { error: 'no item id' }; break; }
            // Read the item's description (condition is in the description, weapon.kod:87-92).
            const sinceEv = session.client.evSeq ?? 0;
            await session.pacer.submit('look', () => session.client?.look?.(id)).catch(e => { result = { error: e.message }; });
            let desc = null;
            try {
              const ev = await session.client.waitFor({ since: sinceEv, kinds: ['look', 'message'], timeoutMs: 2500 }).catch(() => null);
              if (ev?.events?.length) desc = ev.events.map(e => e.text ?? e.description ?? e.what ?? e.kind).join('\n');
            } catch {}
            result = result ?? { sent: true, id, description: desc };
            break;
          }
          default:
            result = { error: `unknown action: ${name}` };
        }
        json(result);
      } catch (e) {
        json({ error: e.message }, 500);
      }
      return;
    }

    // --- reroll: replace the character with a new one ---
    if (req.method === 'POST' && path === '/reroll') {
      const body = JSON.parse(await readBody(req));
      if (!requireAddressedWrite(req, body)) return;
      const { planCharacter } = await import('./m59-newchar.mjs');
      const plan = planCharacter({
        name: body.name || 'JayB',
        stats: body.stats || 'caster',
        loadout: body.loadout || 'selfSufficient',
        skills: body.skills || [],
      });
      if (!plan.ok) {
        json({ done: false, problems: plan.problems }, 400);
        return;
      }
      if (!body.confirm) {
        json({ done: false, note: 'pass confirm:true to proceed — this deletes the existing character' });
        return;
      }
      try {
        const c = session.client;
        if (!c) {
          json({ done: false, error: 'no game client — not in game' });
          return;
        }
        // Suicide the current character to set IsFirstTime
        console.error(`[keeper] ${agent} rerolling: suiciding current character`);
        c.suicide();
        await new Promise(r => setTimeout(r, 2000));
        // Join as new character
        console.error(`[keeper] ${agent} rerolling: creating new character ${plan.name} with stats ${JSON.stringify(plan.stats)}`);
        const made = await session.joinAsNewCharacter(plan, { userField: null });
        if (!made?.created) {
          json({ done: false, created: false, error: made?.error || 'character was not created', plan_summary: { name: plan.name, stats: plan.stats } });
          return;
        }
        // Verify stats
        const got = {};
        for (const [k, v] of (c.statsById ?? new Map()))
          if (!/^\d+\.\d+$/.test(k)) got[k] = v?.text !== undefined ? v.text : v.value;
        const asked = plan.stats;
        const STAT_ORDER = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
        const haveReadings = STAT_ORDER.every(k => got[k] != null);
        const matched = haveReadings && STAT_ORDER.every(k => Number(got[k]) === asked[k]);
        const junk = haveReadings && STAT_ORDER.map(k => Number(got[k])).join('/') === '3/1/4/1/5/9';
        json({
          done: true, created: true,
          stats_now: got,
          max_health_now: c.vitals?.()?.health?.max ?? null,
          stats_as_asked: matched,
          stats_readable: haveReadings,
          looks_like_the_junk_default: junk,
          verdict: !haveReadings ? 'INCONCLUSIVE' : junk ? 'JUNK DEFAULT' : matched ? 'OK' : 'MISMATCH',
          plan_summary: { name: plan.name, stats: asked, ceiling: plan.max_health_ceiling, spells: plan.spells.map(s => s.name) },
        });
      } catch (e) {
        json({ done: false, error: e.message }, 500);
      }
      return;
    }

    json({ error: `unknown endpoint: ${req.method} ${path}` }, 404);
  } catch (e) {
    json({ error: e.message }, 500);
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- state caching
//
// State projection includes route exits and the full operational status. Building that
// every two seconds in the background made an unobserved keeper spend CPU indefinitely.
// Readers now share a projection for two seconds; after that, the next reader rebuilds it.
// There is no cache timer and therefore no work when nobody is observing this keeper.

const stateCache = new DemandSnapshot(state, { maxAgeMs: 2_000, maxStaleMs: 2_000 });
const statePath = `substrate/keeper-${agent}.json`;

function writeStateSnapshot(value) {
  try {
    mkdirSync('substrate', { recursive: true });
    writeFileSync(statePath, JSON.stringify(value, null, 2));
  } catch (e) {
    console.error(`[keeper] ${agent} state save failed: ${e.message}`);
  }
}

// This file is an operator/debugging snapshot; the keeper does not read it on restart.
// Only a real HTTP reader pays for the enriched projection. Refreshed snapshots within a
// 30s window collapse to the newest value and the persistence path never rebuilds state.
const statePersistence = new DeferredLatest(writeStateSnapshot, { delayMs: 30_000 });

function stateSnapshot(options) {
  const snapshot = stateCache.read(options);
  if (snapshot.refreshed) statePersistence.push(snapshot.value);
  return snapshot;
}

// EXIT EVEN IF THE TIDY-UP HANGS ON SOMETHING ASYNCHRONOUS.
//
// WHAT THIS DOES AND DOES NOT COVER, because the first version of this comment claimed more
// than a timer can deliver. A `setTimeout` fires from the event loop, so it catches a
// shutdown that is WAITING — an await that never resolves, a socket close that never calls
// back. It cannot fire while the loop is blocked, so a synchronous wedge inside
// `writeFileSync` would starve this watchdog exactly as it starves the exit line. Anything
// stronger than this needs a supervisor outside the process.
//
// The shutdown path is still worth insuring: everything before `process.exit(0)` —
// changeJoinIntent, autopilot.stop, client.close, saveFinalState — can wait on something,
// and a keeper that logged "stop requested" and never exited is a stranded character.
//
// AND IT IS NOT WHAT HAPPENED TO t4, which is worth writing down because the wrong
// diagnosis was mine. Pid 44176 on 2026-09-02 was not a JavaScript hang at all: Windows
// reported `HasExited` TRUE with one suspended thread, no CPU, and its listening port still
// bound. The JS had already finished; a filter driver never completed the pending I/O on the
// socket, so the process object could not be released. Nothing can kill that — there is
// nothing left to kill — and `process.kill(pid, 0)` keeps succeeding on it, which is why the
// broker's sweep read "recorded PID is alive" and left it alone for ever. The fix for THAT
// is in the sweep (retire the port and respawn elsewhere once HasExited reads true), not
// here. A watchdog inside the process cannot outlive the process.
//
// The SIGTERM handler already carried the right idea and could never run it:
//
//     process.exit(0);
//     setTimeout(() => process.exit(1), 5000);   // unreachable — exit(0) does not return
//
// So the timer is armed FIRST, before any of the work it is insuring. `unref()` so it
// cannot itself hold the process open when the ordinary path succeeds.
function armShutdownWatchdog(why, ms = 5000) {
  const t = setTimeout(() => {
    try { log(`[keeper] ${agent} shutdown watchdog fired after ${ms}ms (${why}) — exiting hard`); }
    catch { /* logging is part of what may be wedged */ }
    process.exit(1);
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

let finalStateSaved = false;
function saveFinalState() {
  if (finalStateSaved) return false;
  finalStateSaved = true;
  // A graceful stop keeps the historical final snapshot contract. This is the only
  // unobserved path which constructs enriched state, and it happens once, not twice.
  statePersistence.flush(state());
  return true;
}

// ---------------------------------------------------------------- signal handling

process.on('SIGTERM', () => {
  log(`[keeper] ${agent} SIGTERM received`);
  armShutdownWatchdog('SIGTERM');
  changeJoinIntent(false);
  if (autopilot) autopilot.stop('SIGTERM');
  saveFinalState();
  if (session.client) {
    try { session.client.close(); } catch {}
  }
  process.exit(0);
});

process.on('SIGINT', () => process.kill(process.pid, 'SIGTERM'));

process.on('exit', () => {
  releaseSpot(agent);
  saveFinalState();
});

// ---------------------------------------------------------------- start

server.listen(port, '127.0.0.1', () => {
  log(`[keeper] ${agent} HTTP API on port ${port}`);
  // THE EVENT-LOOP STALL MONITOR. blakserv logs a session out after 30 seconds of silence
  // (INACTIVE_GAME), and on 2026-09-01 the shadow fleet lost about five keepers a tour that
  // way while their own logs said nothing at all: the broker's /live probe went unanswered,
  // then "joined as" twice. A blocked loop cannot report itself while it is blocked, but it
  // can the moment it resumes: this timer measures how late it fired, and anything over the
  // threshold is written to this log WITH A CLOCK (the keeper log has none) and to the
  // tactics ledger as a `loop_stall` row carrying what the keeper was doing, so the next
  // stall names its own cause instead of leaving four hypotheses standing.
  {
    const EVERY_MS = 500;
    const REPORT_OVER_MS = Number(process.env.M59_LOOP_STALL_MS || 1500);
    // THE SELF-PROFILER. A blocked loop cannot say what blocked it — but V8's sampling
    // profiler runs on its own thread and keeps sampling the stack while the loop is
    // blocked, and `node:inspector` lets this process drive that profiler on itself with
    // no flags and no port. So it runs continuously at a 5 ms interval (about one percent
    // of a core), is restarted every two minutes to bound memory, and when the stall
    // monitor fires it takes the samples that fall inside the blocked window and names the
    // frames that owned them. On 2026-09-02 sixty-one stalls in one tour, thirty-five of
    // them in the Sewers of Barloque and the worst 70 seconds, carried `doing ?` and
    // nothing else; every offline reproduction of the suspects came back in milliseconds.
    // M59_KEEPER_PROFILE=0 switches it off.
    const profiler = (() => {
      if (process.env.M59_KEEPER_PROFILE === '0') return null;
      try {
        const session = new inspector.Session();
        session.connect();
        const post = (m, p = {}) => new Promise((res, rej) => session.post(m, p, (e, r) => e ? rej(e) : res(r)));
        let startedAt = 0;
        const start = () => post('Profiler.start').then(() => { startedAt = Date.now(); }).catch(() => {});
        post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 5000 })).then(start).catch(() => {});
        // Summarise the samples inside [fromMs, toMs] (wall clock) by self frame, top N.
        const hotDuring = async (fromMs, toMs, top = 5) => {
          let profile = null;
          try { ({ profile } = await post('Profiler.stop')); } catch { return null; }
          start();
          if (!profile?.samples?.length) return null;
          const byId = new Map(profile.nodes.map(n => [n.id, n]));
          const parentOf = new Map();
          for (const n of profile.nodes) for (const c of (n.children || [])) parentOf.set(c, n.id);
          const incl = new Map();                       // inclusive time by frame, our files only
          const OURS = /m59-(game|autopilot|world|safespots|skills|movement|supervise|keeper-process)\.mjs$/;
          // profile.startTime is µs on the profiler's monotonic clock; map it to wall time
          // by pinning the profile's end to now.
          const totalUs = profile.timeDeltas.reduce((a, b) => a + b, 0);
          const endWall = Date.now();
          let tUs = 0;
          const self = new Map();
          let inWindow = 0;
          for (let i = 0; i < profile.samples.length; i++) {
            tUs += profile.timeDeltas[i] || 0;
            const wall = endWall - (totalUs - tUs) / 1000;
            if (wall < fromMs || wall > toMs) continue;
            inWindow++;
            const f = byId.get(profile.samples[i])?.callFrame;
            if (!f) continue;
            const k = `${f.functionName || '(anon)'} ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
            self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0));
            // and every ancestor from our own files, once per sample
            const seen = new Set();
            for (let cur = profile.samples[i]; cur != null; cur = parentOf.get(cur)) {
              const a = byId.get(cur)?.callFrame;
              if (!a || !OURS.test(a.url || '')) continue;
              const ak = `${a.functionName || '(anon)'} ${(a.url || '').split('/').pop()}:${a.lineNumber + 1}`;
              if (seen.has(ak)) continue;
              seen.add(ak);
              incl.set(ak, (incl.get(ak) || 0) + (profile.timeDeltas[i] || 0));
            }
          }
          if (!inWindow) return null;
          const selfLine = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
            .map(([k, us]) => `${k} ${Math.round(us / 1000)}ms`).join(', ');
          const callers = [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([k, us]) => `${k} ${Math.round(us / 1000)}ms`).join(', ');
          return selfLine + (callers ? ` | callers: ${callers}` : '');
        };
        // Bound memory: restart the profile every two minutes when nothing is being asked.
        const cycle = setInterval(() => { if (Date.now() - startedAt > 120_000) post('Profiler.stop').then(start).catch(() => {}); }, 30_000);
        if (typeof cycle.unref === 'function') cycle.unref();
        return { hotDuring };
      } catch { return null; }
    })();
    let lastTick = Date.now();
    const tick = () => {
      const now = Date.now();
      const late = now - lastTick - EVERY_MS;
      lastTick = now;
      if (late >= REPORT_OVER_MS) {
        let doing = null, to = null, roomNum = null, who = null;
        try {
          doing = autopilot?.doing ?? null;
          to = autopilot?.inert?.to ?? autopilot?.suspendedJourney?.to ?? null;
          roomNum = autopilot?.s?.world?.room?.num ?? session?.world?.room?.num ?? null;
          who = autopilot?.s?.client?.me?.name ?? session?.client?.me?.name ?? null;
        } catch { /* a stall report must not throw */ }
        const write = hot => {
          log(`[loop] ${agent} event loop was blocked ~${late}ms, resumed ${new Date(now).toISOString()} ` +
              `(room ${roomNum ?? '?'}, doing ${doing ?? '?'}${to != null ? ', travelling to ' + to : ''})` +
              (hot ? ` hot: ${hot}` : ''));
          try {
            recordTactic({ character: who ?? agent, room: Number(roomNum ?? 0), tactic: 'loop_stall',
                           trigger: 'event_loop', worked: false, ms: late, hp_lost: 0, attempted: false,
                           note: `blocked ~${late}ms; doing ${doing ?? '?'}${to != null ? '; travelling to ' + to : ''}; ` +
                                 `resumed ${new Date(now).toISOString()}` + (hot ? `; hot: ${hot}` : '') });
          } catch { /* evidence, not a dependency */ }
        };
        if (profiler) profiler.hotDuring(now - late - EVERY_MS, now).then(write, () => write(null));
        else write(null);
      }
      const t = setTimeout(tick, EVERY_MS);
      if (typeof t.unref === 'function') t.unref();
    };
    const t0 = setTimeout(tick, EVERY_MS);
    if (typeof t0.unref === 'function') t0.unref();
  }
  join().catch(e => {
    log(`[keeper] ${agent} initial join failed: ${e.message}`);
    // Stay alive so a transient startup failure can recover. A recursive one-shot owns no
    // timer after success (the previous fixed interval kept waking for the process lifetime).
    scheduleInitialJoinRetry();
  });
});
