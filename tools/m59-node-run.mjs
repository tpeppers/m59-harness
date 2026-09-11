#!/usr/bin/env node
// THE NODE WALK. SIX MANA NODES, SIX BAD ROADS, AND WHETHER A CHARACTER REACHED THE STONE.
//
//   node tools/m59-node-run.mjs --list
//   node tools/m59-node-run.mjs --dry-run
//   node tools/m59-node-run.mjs --agents shadow01 --nodes ancient,sentinel
//   node tools/m59-node-run.mjs --stagger 45                  the whole circuit, everybody
//   node tools/m59-node-run.mjs --random --legs 6 --seed 777  an order drawn by lot
//   node tools/m59-node-run.mjs --no-approach                 room arrivals only
//
// WHY THIS RATHER THAN ANOTHER WORLD TOUR. `m59-solo-run.mjs` walks between town rooms
// chosen because they are places a fleet has business — gates, banks, a shadowy corner.
// Every one of them is reachable by a chain of edge exits over open ground, and the question
// it asks is how long a road takes.
//
// The mana nodes are the opposite selection. They sit at the ends of the world's worst
// approaches: a ledge whose square centres are not standable, a cave with NO EXIT LEADING
// INTO IT, an upstairs room reachable only through doors, a peak twelve hops out past the
// Forest of Farol. They are surrounded by what the game put there to guard them. And they
// are POINT targets — arriving in the room is not arriving at the node, and the server says
// where the line is, so the result is not a matter of opinion.
//
// THE TEST FOR "AT THE NODE" IS THE SERVER'S OWN. mananode.kod:177-178 is
//
//     abs(GetRow(who) - GetRow(self)) < MANANODE_RANGE  AND
//     abs(GetCol(who) - GetCol(self)) < MANANODE_RANGE
//
// with MANANODE_RANGE = 3 (mananode.kod:17). That is a 5x5 BOX in square coordinates, not a
// radius: two squares each way on each axis, judged independently. A character 2 rows and 2
// columns off is at the node; one 3 rows off and dead level is not. A euclidean distance
// would score both of those wrong, in opposite directions.
//
// ROOM 27 HAS NO ENTRANCE, AND THAT IS NOT A HOLE IN THE BAKE. Nothing in the world graph
// has an exit into "A Deep, Dark, Spooky, Icky Cave". Its only inbound links are from room 5
// (The Underground Lake) and room 2500 (Ugol's Warren Entrance) — both of which are inside
// the same cave complex, an island of rooms a breadth-first search from The Streets of Tos
// never reaches.
//
// You get in by WALKING ONTO A TRIGGER. h7.kod — room 587, the Western border of the Twisted
// Wood, two hops from Tos and on the main road out of the city — carries a `SomethingMoved`
// handler:
//
//     if (new_row < 18) and (new_col < 7) and (new_row > 14)
//        UtilGoNearSquare(what, RID_CAVE2, new_row=57, new_col=46, ANGLE_NORTH)
//
// Rows 15-17, columns 1-6: stand there and you are put into room 27 at r57c46. There is a
// second one in forest2.kod (room 26, rows <19 and cols <7, landing at r55c35), but room 26
// is not reachable from Tos either, so 587 is the door this uses.
//
// The router cannot plan through that, and it is RIGHT not to — a trigger is not an exit, it
// is a square with a consequence, and `travel` asking the room graph gets a truthful "no
// route". So this tool does the two halves by hand and reports WHICH HALF FAILED. A leg that
// never reached 587 and a leg that stood in the corner and was not teleported are different
// findings and must not share a row.
//
// IT REFUSES A GAME SERVER THAT IS NOT LOOPBACK, asked of the ROSTER rather than the broker
// and for the same reason solo-run does: this walks characters into places that kill them.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { takeRunLock, inspectRunLock, releaseRunLock,
         exitWhenOutputIsGone } from './m59-runlock.mjs';
// THE STONES THEMSELVES, from the one tracked table that is checked against the kod.
import { STONES, objectiveFor, approachWithin, requiredItem,
         holdsRequired } from './m59-stones.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};

// kod's own constant, and the reason the test below is a box and not a circle.
const MANANODE_RANGE = 3;

// ---------------------------------------------------------------- the six
//
//   key    what you type after --nodes
//   room   RID, from kod/include/blakston.khd
//   node   the square the stone stands on, from that room's Create(&ManaNode,...) call
//   entry  absent for a room the router can plan into; present for 27, which it cannot
//
// THE LIST IS NOT WRITTEN HERE ANY MORE. It said "the six BASIC nodes ... mananode.kod has more
// ... deliberately not here", and that was true of two of them and wrong about the rest: the kod
// places TEN stones, and `node tools/m59-stones.mjs --diff` showed this list missing four of
// them — 47 (NODE_Q), 599 (NODE_i9), 750 (the Ice Caves) and the guest Mausoleum. Room 750 is
// the one that matters: its stone is INSIDE the meld box by walking, from the square a body
// lands on entering from 526, and nobody could be sent to it because it was not on this list.
//
// So the stones come from `m59-stones.mjs` (tracked, and checked against the kod by
// `--check`), and what stays here is the part that is genuinely this file's: how to APPROACH
// each one. `seafarer` still resolves, because it was this file's name for room 515 while the
// errand called it `peak` — the collision that made `nodes/<key>.md` unfindable from one side.
const APPROACH_NOTES = {
  ancient: {
    src: 'g9.kod NODE_g9',
    // THE LEDGE ROOM. The broker's own `walk_to` comment is about this room: 21 of 49 sampled
    // points inside r40c52 are standable and the CENTRE IS NOT ONE OF THEM, and a character
    // walking that climb square by square stepped off after nine waypoints. It is why the
    // approach below is fine-movement by default.
    hard: 'a ledge room — square centres are not reliably standable' },
  sentinel: {
    src: 'objroom/h9.kod NODE_H9',
    hard: 'reached over the Cragged Mountains, or south from Ukgoth' },
  victoria: {
    src: 'castle1b.kod NODE_VICTORIA',
    hard: 'every inbound link is a DOOR from room 38, not an edge — four of them' },
  cave: {
    src: 'objroom/cave2.kod NODE_ORCCAVES',
    entry: { via: 587, viaName: 'Western border of the Twisted Wood',
             // The middle of the rows 15-17 x cols 1-6 box, so a step either way is still in it.
             trigger: { row: 16, col: 4 },
             lands: { row: 57, col: 46 },
             src: 'h7.kod SomethingMoved' },
    hard: 'NO ROOM HAS AN EXIT INTO IT — entered by a movement trigger in room 587' },
  badlands: {
    src: 'badland1.kod NODE_BADLANDS',
    // Room 615 is ALSO called "The Badlands". Selecting this one by name would have been a
    // coin toss; RID_BADLAND1 = 45 is the one holding the node.
    hard: 'two rooms share this name — 45 has the node, 615 does not' },
  peak: {
    src: 'a5.kod NODE_A5',
    hard: 'twelve hops from Tos, the longest approach of the six' },
};

// EVERY STONE, with this file's approach notes where it has them. A stone with no approach
// note is still runnable — the walk and the 5x5 box test do not need one, and pretending
// otherwise is what kept 750 out of reach.
const NODES = Object.entries(STONES).map(([key, s]) => ({
  node_num: s.node,
  key, room: s.room, name: s.where, node: { row: s.row, col: s.col },
  ...(APPROACH_NOTES[key] ?? {}),
  // A stone that is not there until something happens, and the one that is not meant to be
  // got at all, are carried so `--list` can SAY so rather than omitting them.
  ...(s.appears ? { appears: s.appears } : {}),
  ...(s.guest_demo ? { guest_demo: true } : {}),
  ...(s.exempt ? { exempt: s.exempt } : {}),
  ...(s.never ? { never: s.never } : {}),
  ...(s.conditional ? { conditional: true } : {}),
  // WHAT SUCCESS IS FOR THIS STONE. An approach leg is finished when the body is within a few
  // coarse squares, because the meld is behind something that is not a walk.
  objective: objectiveFor(s), within: approachWithin(s),
  ...(s.gate ? { gate: s.gate } : {}),
  // A KEY THE RUNNER HAS TO BE CARRYING, and the words that spend it.
  ...(requiredItem(s) ? { requires: s.requires, say: s.say ?? null,
                          door_open_ms: s.door_open_ms ?? null } : {}),
  ...(s.alias ? { alias: s.alias } : {}),
}));
const byKey = k => NODES.find(n => n.key === k || String(n.room) === String(k) ||
                                   (n.alias ?? []).includes(String(k).toLowerCase()));

const PORT  = Number(flag('port', 8971));
const FLEET = flag('fleet', 'shadow');
const FROM  = Number(flag('from', 50));     // The Streets of Tos

// THE DEFAULT ORDER IS GEOGRAPHY, NOT THE TABLE ABOVE. Tos sits east of the Cragged
// Mountains, so the ancient place and the Sentinel come first and are next door to one
// another; Castle Victoria is reached through Ukgoth from the Sentinel side; the cave's
// trigger room is back on the Tos road; the Badlands are out past Barloque; the Peak is the
// long haul. A circuit that ping-ponged across the map would measure the ordering instead of
// the approaches.
const DEFAULT_ORDER = ['ancient', 'sentinel', 'victoria', 'cave', 'badlands', 'seafarer'];
const ORDER = (flag('nodes', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const CIRCUIT = (ORDER.length ? ORDER : DEFAULT_ORDER).map(k => {
  const n = byKey(k);
  if (!n) {
    console.error(`node-run: "${k}" is not one of the six. Known: ` +
                  NODES.map(x => `${x.key} (room ${x.room})`).join(', '));
    process.exit(2);
  }
  return n;
});

// A DRAWN ORDER, LIKE solo-run's --random AND FOR THE SAME REASON. A fixed circuit asks the
// same six approaches from the same six directions every lap, so an approach that only breaks
// when it is entered from the other side is never asked about. Seeded per character, so an
// itinerary can be walked again.
const RANDOM = has('random');
const LEGS   = Number(flag('legs', CIRCUIT.length));
const SEED   = Number(flag('seed', Date.now() % 1000000));
function rngFor(name) {
  let h = SEED >>> 0;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const nextNode = (rng, currentRoom) => {
  const choices = CIRCUIT.filter(n => n.room !== Number(currentRoom));
  return choices[Math.floor(rng() * choices.length)] ?? CIRCUIT[0];
};
function drawItinerary(name) {
  const rng = rngFor(name), out = [];
  let at = FROM;
  for (let i = 0; i < LEGS; i++) { const n = nextNode(rng, at); out.push(n); at = n.room; }
  return out;
}

const RECOVERY_WAIT_MS = Number(flag('recovery-wait', 60)) * 1000;
const TIMEOUT = Number(flag('timeout', 600)) * 1000;
// THE WALK FROM THE DOORWAY TO THE STONE IS TIMED SEPARATELY FROM THE ROAD, because the two
// fail for different reasons and one number hides which. A character that crossed the world
// in four minutes and then spent three more failing to climb a ledge has said something very
// specific, and only two clocks can say it.
const APPROACH_MS = Number(flag('approach-timeout', 180)) * 1000;
// HOW LONG TO KEEP WALKING AT THE TRIGGER CORNER BEFORE CALLING IT A MISS. Measured: a
// character arriving in room 587 from the Tos road lands around r7c55 and the trigger box is
// fifty-one columns west of that, which at the client's one-square-a-second is most of a
// minute before anything can possibly happen. The first version of this budgeted 60s, scored
// `no trigger`, and was wrong — the walk was still going and the trigger fired afterwards,
// with nothing watching.
const TRIGGER_MS = Number(flag('trigger-timeout', 180)) * 1000;
const WALL = flag('wall-below', null);
const HOLD = flag('hold-below', null);
const ONLY = flag('agents', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const DRY  = has('dry-run');
const APPROACH = !has('no-approach');
// Stop a character's circuit at the first node it does not REACH, rather than at the first
// room it cannot get to. The old default; useful when sweeping one approach.
const STOP_SHORT = has('stop-short');
// PUT THE ORDERS BACK WHEN THE RUN ENDS. Every leg sets `mode: idle, roam: false,
// confine_rooms: []` so that the run measures a road and not a keeper's own errands — and
// nothing ever put them back, so a finished run left twenty-one characters standing idle for
// ever with their confinement CLEARED rather than overridden. From outside that looks exactly
// like a broker that has died. `--keep-orders` leaves them parked, which is what you want if
// the next thing you are going to do is another run.
const RESTORE_ORDERS = !has('keep-orders');

// THE TWO WALKS WANT DIFFERENT RESOLUTIONS, AND MEASURING IT SETTLED IT.
//
// Crossing room 587 to the cave trigger — fifty-one columns of open woodland — asked of each
// mover from the same square, r7c55:
//
//   fine:true    60s, ZERO squares moved, then "The operation was aborted due to timeout"
//   fine:false   22s, 13 steps, "a step crossed the room edge", landed room 27 r57c46
//
// which is the landing square h7.kod names. So a long traversal is COARSE work: the fine BSP
// solver is for the last few squares of interesting ground, and pointing it across a room
// does not merely cost time, it produces no movement at all.
//
// The approach to the stone is the opposite case, and the ancient place is why: aiming at
// square CENTRES on that ledge walks a body off it. So fine leads there.
//
// Each phase falls back to the other resolution if the first ends short with budget left, and
// the row says WHICH ONE got there — on a tool built to find out where movement breaks, that
// is half the answer.
const MOVES = { coarse: [false, true], fine: [true, false] };
const pickModes = (name, dflt) => {
  const v = (flag(name, dflt) || dflt).toLowerCase();
  if (!MOVES[v]) {
    console.error(`node-run: --${name} takes "coarse" or "fine", not "${v}".`);
    process.exit(2);
  }
  return MOVES[v];
};
const TRIGGER_MODES  = pickModes('trigger-move', 'coarse');
const APPROACH_MODES = pickModes('approach-move', 'fine');
const REST_CREDIT_MS = Number(flag('rest-credit', 180)) * 1000;
const BROADCAST = !has('no-broadcast');

// AN UNRECOGNISED FLAG IS NOT A REQUEST TO DO THE DEFAULT THING TO A LIVE FLEET, and
// `--help` prints without taking the lock. Both rules are solo-run's, and it learned them the
// day a `--help` that did not exist was ignored, every other setting fell back to its
// default, and the tool walked two characters into Ukgoth until one of them died.
const KNOWN = new Set(['port', 'fleet', 'from', 'nodes', 'recovery-wait', 'timeout',
                       'approach-timeout', 'trigger-timeout', 'wall-below', 'hold-below',
                       'agents', 'dry-run', 'rest-credit', 'stagger', 'stop', 'force',
                       'help', 'on-shared-server', 'random', 'legs', 'seed',
                       'broadcast', 'no-broadcast', 'no-approach',
                       'trigger-move', 'approach-move', 'list', 'stop-short',
                       'keep-orders']);
if (has('help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith('//'))
    .map(l => l.replace(/^\/\/ ?/, '')).join('\n').split('\n\n').slice(0, 3).join('\n\n'));
  process.exit(0);
}
if (has('list')) {
  for (const n of NODES) {
    console.log(`  ${n.key.padEnd(9)} room ${String(n.room).padStart(3)}  ` +
                `node at r${n.node.row}c${n.node.col}  ${n.name}`);
    console.log(`             ${n.src ?? n.node_num ?? ''}`.trimEnd());
    if (n.hard)  console.log(`             ${n.hard}`);
    // A STONE THAT IS NOT AN ERRAND SAYS SO IN THE LIST, rather than being quietly absent from
    // it. Two are exempt by the operator's ruling and one by the design of the game; two more
    // are conditional — a lever and a timed faction swing. Omitting them is how this list came
    // to be missing four stones in the first place.
    if (n.exempt)
      console.log(`             EXEMPT FROM ATTEMPT (${n.exempt}) — not casually obtainable`);
    else if (n.conditional)
      console.log(`             CONDITIONAL — there is nothing to stand on until it appears`);
    if (n.appears) console.log(`             appears ${n.appears}`);
    if (n.requires)
      console.log(`             NEEDS THE ${n.requires.item.toUpperCase()} CARRIED` +
                  `${n.requires.consumed ? ' (consumed by the door — one opening)' : ''}` +
                  `${n.say ? `, then say "${n.say}" in the room` : ''}` +
                  `${n.door_open_ms ? ` — ${Math.round(n.door_open_ms / 1000)}s of open floor` : ''}`);
    if (n.objective === 'approach')
      console.log(`             APPROACH ONLY — success is within ${n.within} coarse squares. ` +
                  `The meld is gated: ${n.gate}`);
    if (n.entry) console.log(`             enter through room ${n.entry.via} ` +
                             `(${n.entry.viaName}) at r${n.entry.trigger.row}c${n.entry.trigger.col}, ` +
                             `landing r${n.entry.lands.row}c${n.entry.lands.col}`);
  }
  process.exit(0);
}
{
  const unknown = argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')[0])
                      .filter(a => !KNOWN.has(a));
  if (unknown.length) {
    console.error(`node-run: unknown option(s): ${unknown.map(u => '--' + u).join(', ')}`);
    console.error('          Refused rather than ignored: this tool drives a live fleet, and');
    console.error('          ignoring a flag means running the DEFAULT experiment instead of');
    console.error('          the one that was asked for. `--help` lists what it takes.');
    process.exit(2);
  }
}
if (RANDOM && CIRCUIT.length < 2) {
  console.error('node-run: --random needs at least two nodes to draw between.');
  process.exit(2);
}
if (RANDOM && !(Number.isInteger(LEGS) && LEGS > 0)) {
  console.error('node-run: --legs must be a whole number of legs greater than zero.');
  process.exit(2);
}
if (RANDOM && !Number.isInteger(SEED)) {
  console.error('node-run: --seed must be an integer.');
  process.exit(2);
}

exitWhenOutputIsGone();

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const UNDERWORLD = 1;

function call(name, args, ms = 90000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json',
                 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        // A TOOL REFUSAL IS PROSE, NOT JSON, and the parse error hides it: `error: Aaaa is
        // busy: walk to ...` comes back as "Unexpected token 'e'", which reads like a broken
        // broker and is the broker answering clearly. Report what it said.
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) { done({ _error: text.slice(7) }); return; }
          done(JSON.parse(text));
        }
        catch (e) { done({ _error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// IS THIS CHARACTER DELIBERATELY STOPPED? Resting at a wall or in a sanctuary is the survival
// ladder doing its job, and it is NOT the road being slow.
const RESTING = /rest|holding a (proven|untested) safe spot|healing|recovering/i;
const isResting = ap => RESTING.test(String(ap?.activity ?? ''));

// THE SERVER'S TEST, TRANSCRIBED: independent per axis, strictly less than 3.
const atNode = (pos, node) =>
  pos != null && Number.isFinite(pos.row) && Number.isFinite(pos.col) &&
  Math.abs(pos.row - node.row) < MANANODE_RANGE &&
  Math.abs(pos.col - node.col) < MANANODE_RANGE;

// TWO DIFFERENT QUESTIONS, AND CONFLATING THEM COST A WHOLE RUN.
//
// `reachedNode` is the result. `reachedRoom` is whether the CIRCUIT MAY GO ON. They are not
// the same test, and the first version of this used one for both: the circuit stopped at the
// first node it did not reach, so twenty-one characters all stopped at the ancient place —
// which nobody can currently reach, for reasons that have nothing to do with the other five
// roads — and the run measured one approach twenty-one times instead of six roads once each.
//
// A road is worth walking whether or not the stone at the end of it is reachable. So the
// circuit carries on from any room it arrives in, and only a death, a refusal or a timeout
// ends the walk. `--stop-short` restores the old behaviour for somebody sweeping one node.
// AN APPROACH LEG THAT APPROACHED IS A LEG THAT SUCCEEDED. Counting it as a near miss would
// report the two gated stones as failures for ever, which is how a list stops being read.
const reachedNode = rec => rec.ended === 'at node' || rec.ended === 'approached';
const reachedRoom = rec => rec.ended === 'at node' || rec.ended === 'approached' ||
                           rec.ended === 'in room';
const legOk = rec => (APPROACH && !STOP_SHORT) ? reachedRoom(rec)
                   : STOP_SHORT ? reachedNode(rec) : reachedRoom(rec);

// ---------------------------------------------------------------- who is driving
if (has('stop')) {
  const found = inspectRunLock(FLEET);
  if (found.state === 'none') { console.log(`nothing holds fleet "${FLEET}"`); process.exit(0); }
  const pid = Number(found.lock?.pid);
  console.log(`fleet "${FLEET}" is ${found.state} by pid ${pid}` +
              (found.why ? ` (${found.why})` : '') +
              (found.lock?.at ? `, since ${new Date(found.lock.at).toISOString()}` : ''));
  if (found.state === 'held' && Number.isInteger(pid) && pid !== process.pid) {
    // BY PID, NEVER BY NAME. Matching `node` or `m59-*` across every process once killed a
    // live broker belonging to a different checkout and logged out its whole fleet.
    try { process.kill(pid, 'SIGTERM'); console.log(`  signalled pid ${pid}`); }
    catch (e) { console.log(`  could not signal pid ${pid}: ${e.message}`); }
  }
  releaseRunLock(FLEET);
  console.log('  lock cleared');
  process.exit(0);
}

const claim = takeRunLock(FLEET, {
  label: RANDOM ? `node-run random x${LEGS} seed ${SEED}`
                : `node-run ${CIRCUIT.map(n => n.key).join('>')}`,
  force: has('force') });
if (!claim.ok) {
  const h = claim.holder ?? {};
  console.error(`node-run: REFUSING — fleet "${FLEET}" is already being driven.`);
  console.error(`          pid ${h.pid}, "${h.label ?? '?'}", since ` +
                `${h.at ? new Date(h.at).toISOString() : '?'}`);
  console.error(`          ${h.argv ?? ''}`);
  console.error(`          Two runs on one fleet fight for the same bodies and both report`);
  console.error(`          "movement cancelled by a newer command". Stop that one first:`);
  console.error(`            node tools/m59-node-run.mjs --stop --fleet ${FLEET}`);
  process.exit(3);
}
if (claim.tookOverFrom)
  console.log(`(took over a stale lock: ${claim.tookOverFrom.why})`);

// ---------------------------------------------------------------- which fleet
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) {
  console.error(`node-run: ${rosterFile} does not name one game server.`);
  process.exit(2);
}
// A SHARED SERVER IS STILL REFUSED — but naming one or two volunteers out loud is a different
// request from walking a whole fleet into a cave, and no flag combination reaches a shared
// server without the roll-call.
const MAX_SHARED = 2;
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  const named = ONLY ?? [];
  if (!has('on-shared-server') || !named.length) {
    console.error(`node-run: REFUSING. Fleet "${FLEET}" is on ${rostered.host}:${rostered.port}, not loopback.`);
    console.error(`          This walks characters into caves and off ledges. Lab servers only.`);
    console.error(`          To send named volunteers anyway: --on-shared-server --agents <a,b>`);
    process.exit(2);
  }
  if (named.length > MAX_SHARED) {
    console.error(`node-run: REFUSING. --on-shared-server allows at most ${MAX_SHARED} named ` +
                  `character(s); you named ${named.length}.`);
    process.exit(2);
  }
  console.error(`node-run: SHARED SERVER (${rostered.host}:${rostered.port}). ` +
                `Running only: ${named.join(', ')}. Everyone else is untouched.`);
}

// THE DM TOOLS ARE LOOPBACK-ONLY BY DESIGN, SO ON A SHARED SERVER THEY ARE OFF — not tried,
// not caught, OFF, and said out loud.
//
// MEASURED 2026-09-10, sending Marco Polo to the Ice Caves on prod: the run printed its whole
// header, printed the results table's header, and then died with
// `Error: connect ECONNREFUSED 127.0.0.1:19998` before walking a single step. The maintenance
// port is unauthenticated and pointing it at a shared server is not a configuration choice —
// `m59-dm.mjs` is right to refuse — so the first thing this tool did on a shared server was an
// operation that server forbids.
//
// The crash was one missing `.catch` next to two calls that have one: `dm.relocate` and
// `dm.heal` were both guarded and `dm.resolve` was not. But a catch would have been the wrong
// fix on its own, because it would have left the run silently pretending it had placed and
// healed a character it had not. What the leg needs to know is that it starts WHERE THE BODY
// IS STANDING, and the header now says so.
const DM_OK = LOOPBACK.has(rostered.host.toLowerCase());

const fleet = await call('fleet', {});
let rows = (fleet.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) rows = rows.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
rows.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!rows.length) { console.error('node-run: no characters matched.'); process.exit(1); }

// A STONE THAT IS EXEMPT FROM ATTEMPT IS REFUSED HERE, before anything walks. Two are the
// operator's ruling — "The Ukgoth nodes and Fey nodes should also be exempt from attempt, because
// they're not casually obtainable (usually take planning or coordination across multiple
// people)" — and the guest stone is unreachable by the design of the game. `--force` is the way
// to say you know: a run that means to test the Ukgoth stone at midnight is a real errand and
// this must not be the thing that stops it.
{
  // A STONE WITH NO OBJECTIVE AT ALL. An APPROACH stone is not barred — walking to it is the
  // errand — so this refuses only the ones nothing should be sent to.
  const barred = CIRCUIT.filter(n => n.objective === null);
  if (barred.length && !has('force')) {
    for (const n of barred)
      console.error(`node-run: REFUSING ${n.key} (room ${n.room}) — ` +
                    `${n.never ? `not obtainable: ${n.never}`
                      : n.exempt ? `exempt from attempt: ${n.exempt}` : 'conditional'}. ` +
                    `It appears ${n.appears}`);
    console.error('          Pass --force if this run is deliberately going after one.');
    process.exit(2);
  }
}

console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(`${rows.length} character(s), ` +
            (RANDOM ? `${LEGS} node(s) each drawn by lot from ${CIRCUIT.length} (seed ${SEED})`
                    : `the circuit ${CIRCUIT.map(n => n.key).join(' -> ')}`) +
            `, ${DM_OK ? `first leg from room ${FROM}` : 'first leg from wherever each body is ' +
              'standing (no DM placement on a shared server)'}, ${TIMEOUT / 1000}s per road`);
console.log('nodes: ' + CIRCUIT.map(n => `${n.key}=${n.room}@r${n.node.row}c${n.node.col}`).join('  '));
console.log(APPROACH
  ? `approach: walk to the stone, ${APPROACH_MODES[0] ? 'fine' : 'coarse'} then ` +
    `${APPROACH_MODES[1] ? 'fine' : 'coarse'}, up to ${APPROACH_MS / 1000}s; ` +
    `"at node" is |dr|<3 and |dc|<3 (mananode.kod:177)`
  : 'approach: OFF — a leg is done when the ROOM is reached (--no-approach)');
console.log(`shelter: travel_wall_below ${WALL ?? '(unchanged)'}, travel_hold_below ${HOLD ?? '(unchanged)'}`);
console.log(BROADCAST ? 'arrivals at a stone are broadcast to the whole server'
                      : 'arrivals are NOT announced in game (--no-broadcast)');
console.log(DM_OK
  ? 'DM: placement and top-up are available (loopback server)'
  : 'DM: OFF — the maintenance port is loopback-only, so no teleport to the start line and no ' +
    'healing between legs. Every road here is walked from where the body already is, at ' +
    'whatever health it already has.');
console.log('');
if (DRY) {
  for (const r of rows)
    console.log(`  ${String(r.character).padEnd(12)} (${r.agent})  ` +
                (RANDOM ? drawItinerary(r.character).map(n => n.key).join(' -> ')
                        : CIRCUIT.map(n => n.key).join(' -> ')));
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');

const LAPFILE = join(REPO, 'substrate', 'node-laps.json');
const readLaps = () => { try { return JSON.parse(readFileSync(LAPFILE, 'utf8')); } catch { return {}; } };
const writeLaps = o => { try { writeFileSync(LAPFILE, JSON.stringify(o, null, 1)); } catch { /* a lost count is not a lost run */ } };
const lapsOf = who => Number(readLaps()[who] ?? 0);
const setLaps = (who, n) => { const o = readLaps(); o[who] = n; writeLaps(o); };
const ordinal = n => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + 'th';
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
};

// WHEN A LEG FAILS, SAY WHERE IT STOPPED AND WHAT IT NEEDED. "timed out" IS NOT A DIAGNOSIS.
//
// MEASURED 2026-09-10, Marco Polo to the Ice Caves. The whole account of a ten-minute failure
// was one word:
//
//     Marco Polo   ice   timed out   603s   0s   50 -> 536 r34c2   10   0r
//
// Which is true and tells you nothing. The answer took two more commands by hand, and it was
// not a hazard, not a boundary the mover cannot cross, and not a missing affordance:
//
//     the west door out of 536 to 526 stands at r18c1
//     she stopped at r34c2 — the CORRECT WALL, sixteen rows south of the door
//     and from r34c2 the geometry says that door IS reachable by walking
//
// So the leg stood on the right wall at the wrong row for ten minutes while spiders took it
// from 20 health to 10. A run that reports the word and not the square makes the next session
// re-derive this from scratch, which is the failure this skill exists to stop — eleven refused
// departures in room 49 and not one measurement.
//
// The instruments already existed: `m59-exitreport.mjs` answers exactly this and is importable
// (it guards its own CLI). Nothing was missing but the CALL. Paid only on a failure, because
// the map and the route table together cost about a second and a half to load.
let _geo = null;
async function geometry() {
  if (_geo) return _geo;
  const [{ loadMap, movementMapFile }, routes, report] = await Promise.all([
    import('./m59-map.mjs'), import('./m59-routes.mjs'), import('./m59-exitreport.mjs')]);
  const map = loadMap(movementMapFile());
  // The step masks are what make the flood answer about the map the MOVER enforces rather than
  // a map nobody walks — see the standing rule about measuring geometry without them.
  try { routes.attachStepMasks(map); } catch { /* an unmasked answer is still better than none */ }
  // THE TABLE IS ASKED FOR BY MANIFEST, and it answers null when the bake was built against a
  // different map. That is not a detail to swallow: without anchors the door list comes back
  // EMPTY, and an empty list printed as "NO door in this room" is a fabrication of exactly the
  // kind this run is trying to stop reporting.
  _geo = { map, table: routes.routesFor(map.geometryManifestSha256) ?? null,
           roomReport: report.roomReport, reachableFrom: routes.reachableFrom };
  return _geo;
}

async function frontier(roomNum, at) {
  if (!Number.isFinite(Number(roomNum)) || !at || at.row == null || at.col == null) return null;
  try {
    const g = await geometry();
    if (!g.table) return { unavailable: 'the baked route table was built against a different ' +
                                        'map, so this checkout cannot say which doors are ' +
                                        'reachable — rebake, or ask m59-exitreport --checked' };
    const rep = g.roomReport(g.map, g.table, Number(roomNum),
                             { reachFrom: g.reachableFrom,
                               standingAt: { row: at.row, col: at.col } });
    if (rep?.error) return null;
    const here = (rep.inbound ?? []).find(a => a.from == null);
    if (!here) return null;
    const name = x => `${x.dir ?? x.kind} to ${x.to} at r${x.row}c${x.col}`;
    return { at, why: here.why ?? null,
             can: (here.canTake ?? []).map(name), cannot: (here.cannotTake ?? []).map(name) };
  } catch { return null; }
}

// WHERE IS THE BODY, IN SQUARES. `status` answers with a room and NO COORDINATES, so the
// position has to come from `look` — which is also the only thing that can say whether the
// stone was visible from wherever the character stopped, and "could see it and could not
// reach it" is a different bug report from "never got near".
async function where(agent) {
  const l = await call('look', { agent }, 40000);
  if (l?._error) return { _error: l._error, room: null, col: null, row: null, node: null };
  const room = Number(l?.room?.num ?? l?.room ?? NaN);
  const you = l?.you ?? null;
  // Both lists: `look` tallies inert scenery separately from things with affordances, and
  // which side of that line a mana node falls on is not worth assuming.
  const seen = [...(Array.isArray(l?.objects) ? l.objects : []),
                ...(Array.isArray(l?.scenery) ? l.scenery : [])]
    .filter(o => /mana node/i.test(String(o?.name ?? '')));
  return { room: Number.isFinite(room) ? room : null,
           col: you?.col ?? null, row: you?.row ?? null,
           node: seen[0] ? { col: seen[0].col, row: seen[0].row,
                             distance: seen[0].distance, name: seen[0].name } : null };
}

// WALK, AND WATCH THE BODY RATHER THAN THE REPLY.
//
// THE CLIENT-SIDE TIMEOUT ON `walk_to` DOES NOT STOP THE WALK. This is the single most
// expensive thing measured while building this tool, and it is the same shape as every other
// cancel trap in this repository: the walk lives in the BROKER, so an HTTP request that gives
// up after sixty seconds gets no answer and the character keeps walking. Two consequences,
// and the second one kills characters:
//
//   The verdict is wrong. A leg scored `no trigger` after 60s of silence while the walk was
//   still crossing room 587 — it reached the corner and went through about forty seconds
//   later, with nothing watching and the row already printed.
//
//   THE LEFTOVER WALK RE-AIMS IN THE NEW ROOM. `walk_to col=4 row=16` sent at the trigger
//   corner of room 587 does not stop when the trigger teleports the character into room 27:
//   it keeps going, and `r16c4` now means a square in a cave the character has never seen.
//   Aaaa was walked into a pocket there — "no route even after walking the breadcrumbs back
//   out" — and died. The walk has to be CANCELLED the instant the room changes.
//
// So: fire the walk without awaiting it, poll `look` for the thing actually being waited on,
// and cancel whatever is still running on the way out. Exactly what the road leg already does
// with `travel ... background:true`, which is the pattern that works.
//
// `until(pos)` says what this walk was for. It is not "did walk_to say arrived" — that answer
// arrives late, sometimes never, and is about the mover's opinion rather than the body.
// HOW CLOSE, IN THE UNITS THE SERVER JUDGES BY. Chebyshev — the larger of the two axis
// gaps — because mananode.kod tests the axes independently, so the axis you are WORST on is
// the one that decides, and a euclidean number would flatter a body that is 1 row and 5
// columns out.
const cheb = (pos, sq) =>
  (pos != null && sq != null && Number.isFinite(pos.row) && Number.isFinite(pos.col))
    ? Math.max(Math.abs(pos.row - sq.row), Math.abs(pos.col - sq.col)) : null;

// THE CLOSEST IT EVER GOT, NOT WHERE IT HAPPENED TO STOP. A walker that reaches within three
// squares and is then pushed back to nine has told us the approach is nearly there; a row
// that only reports the final square says it never got close. Both were happening in the same
// run and were indistinguishable.
async function oneWalk(agent, target, { until, budgetMs, fine, near = null, nearRoom = null }) {
  let settled = null;
  call('walk_to', { agent, col: target.col, row: target.row, fine, max_steps: 200 },
       budgetMs + 60000)
    .then(w => { settled = w ?? { arrived: false, reason: 'the mover said nothing' }; })
    .catch(e => { settled = { _error: String(e?.message ?? e) }; });
  const t0 = Date.now();
  let pos = null, why = null, closest = null;
  const note = p => {
    const d = cheb(p, near);
    if (d != null && (closest === null || d < closest.away))
      closest = { row: p.row, col: p.col, away: d, at: Math.round((Date.now() - t0) / 1000) };
  };
  for (;;) {
    await sleep(4000);
    pos = await where(agent);
    // Only meaningful in the node's own room: r48c34 of somewhere else is not eight away
    // from anything.
    if (near && pos?.room === nearRoom) note(pos);
    if (pos?.room === UNDERWORLD) { why = 'died on the way'; break; }
    if (until(pos)) { why = null; break; }
    if (settled) {
      // The mover has spoken. A refusal the geometry is certain about does not get better by
      // being repeated with the same heading — `TERMINAL_MOVEMENT_REASONS` is the closed list
      // of failures no other heading can fix, and they propagate rather than loop.
      why = settled._error ?? settled.reason ?? settled.note ??
            (settled.arrived ? null : 'the walk ended short and said nothing about why');
      break;
    }
    if (Date.now() - t0 > budgetMs) { why = 'ran out of time'; break; }
  }
  // ALWAYS, even on success: a walk still running when this returns is a walk that will fight
  // the next command for the body, and in a room the caller did not choose.
  await call('cancel_movement', { agent }, 20000).catch(() => null);
  return { pos, why, settled, closest, secs: Math.round((Date.now() - t0) / 1000) };
}

async function walkAndWatch(agent, target, { until, budgetMs, modes, near = null, nearRoom = null }) {
  const t0 = Date.now();
  let last = null, closest = null;
  for (const fine of modes) {
    const left = budgetMs - (Date.now() - t0);
    if (left <= 5000 && last) break;
    const got = await oneWalk(agent, target,
                              { until, budgetMs: Math.max(left, 15000), fine, near, nearRoom });
    // The closest square is kept ACROSS the resolutions, because "coarse got within four and
    // fine got within nine" is one fact about the approach and not two.
    if (got.closest && (closest === null || got.closest.away < closest.away))
      closest = { ...got.closest, mode: fine ? 'fine' : 'coarse' };
    last = { ...got, mode: fine ? 'fine' : 'coarse' };
    if (until(got.pos) || got.pos?.room === UNDERWORLD) break;
  }
  return { ...last, closest, secs: Math.round((Date.now() - t0) / 1000) };
}

// THE ORDERS THIS RUN IS ABOUT TO FLATTEN, KEPT SO THEY CAN GO BACK.
//
// Every leg sends `mode: idle, roam: false, confine_rooms: []`, which is right for a
// measurement and wrong to leave behind: `confine_rooms: []` CLEARS a confinement rather than
// overriding it, so when the run ends the character is not merely paused, its orders are gone.
// Measured on this fleet: a finished run left all twenty-one idle with roam off and no
// confinement, which is indistinguishable from a dead broker to anybody looking at the board,
// and `roam:false` outside a confine idles for ever without being flagged as stalled.
//
// `mode` and the three policy keys are the whole of what this tool touches, so they are the
// whole of what it puts back. Anything else a character was carrying is not this tool's to
// restore and is not this tool's to break.
const ORDERS = new Map();
async function keepOrders(agent) {
  if (!RESTORE_ORDERS || ORDERS.has(agent)) return;
  const st = await call('autopilot', { agent, action: 'status' }, 30000).catch(() => null);
  if (!st || st._error) return;
  ORDERS.set(agent, { mode: st.mode ?? null,
                      roam: st.policy?.roam ?? null,
                      confine_rooms: st.policy?.confineRooms ?? null,
                      assigned_room: st.policy?.assignedRoom ?? null });
}
async function putOrdersBack() {
  if (!RESTORE_ORDERS || !ORDERS.size) return;
  console.log('');
  console.log(`putting orders back for ${ORDERS.size} character(s)`);
  for (const [agent, o] of ORDERS) {
    const args = { agent };
    if (o.mode) args.mode = o.mode;
    if (o.roam != null) args.roam = o.roam;
    // A NULL CONFINEMENT IS NOT AN EMPTY ONE. Sending `[]` is what cleared them in the first
    // place, so a character that had no confinement is left alone rather than re-cleared.
    if (Array.isArray(o.confine_rooms) && o.confine_rooms.length) args.confine_rooms = o.confine_rooms;
    const r = await call('autopilot', args, 30000).catch(() => null);
    if (r?._error) console.log(`  ${agent}: ${r._error}`);
  }
}
// AND PUT THEM BACK WHEN SOMEBODY STOPS THE RUN, not only when it finishes on its own — a run
// this long is far more often ended with Ctrl-C than allowed to complete, and that is exactly
// the case where a fleet gets left parked.
let restoring = false;
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    if (restoring) return;
    restoring = true;
    console.log('');
    console.log(`(${sig} — putting orders back before exiting)`);
    await putOrdersBack().catch(() => null);
    process.exit(130);
  });

console.log('  character    node      outcome      road  appr  from ->  ended        low  rest');
const results = [];

// ------------------------------------------------------------ the road to one node
//
// The outcome vocabulary is deliberately narrow and each word means exactly one thing:
//
//   at node     stood inside the server's own 5x5 box around the stone
//   in room     reached the room and did not reach the stone
//   no trigger  reached room 587 and standing in the corner did not teleport it (cave only)
//   DIED        ended in the Underworld
//   refused     `travel` would not start, and the reason is printed underneath
//   timed out   the road ran past its budget
//   rested out  the road ran past its budget and most of it was spent healing
// DOES THIS BODY CARRY WHAT THE DOOR WANTS? Asked of the live pack, per leg, because it is the
// only place the answer exists — and asked BEFORE the road, because the point of the skip is
// not to walk somebody across the world to a door that will not open for them.
async function carriesKey(r, node) {
  if (!node.requires) return { ok: true };
  const inv = await call('inventory', { agent: r.agent }, 40000).catch(() => null);
  const items = inv?.items ?? inv?.inventory ?? null;
  if (!Array.isArray(items))
    return { ok: false, unknown: true,
             why: `could not read ${r.character}'s pack, so whether the ` +
                  `${node.requires.item} is in it is unknown` };
  if (holdsRequired(STONES[node.key] ?? node, items)) return { ok: true };
  return { ok: false,
           why: `${r.character} is not carrying the ${node.requires.item}` +
                `${node.requires.consumed ? ', which the door consumes — one relic, one ' +
                  'opening, so this is not a walk to make on spec' : ''}` };
}

async function runLeg(r, node, { from, place, heal, next = null } = {}) {
  // A LOCKED STONE IS SKIPPED BEFORE THE ROAD, NOT FAILED AFTER IT. Operator, 2026-09-10:
  // "let's make it 'skip' when we run the node run unless the runner has the item." Asked first,
  // because the whole value of the skip is not walking a body across the world to a door that
  // will not open for it — and for Ukgoth the key is CONSUMED, so a speculative trip spends a
  // one-use relic on a walk that could not have arrived.
  if (node.requires) {
    const key = await carriesKey(r, node);
    if (!key.ok) {
      const rec = { character: r.character, node: node.key, room: node.room,
                    ended: key.unknown ? 'key unknown' : 'skipped', roadSecs: 0, apprSecs: 0,
                    triggerSecs: 0, restSecs: 0, died: false, low: null,
                    endedIn: null, endedAt: null, skipped_why: key.why, rooms: [], perRoom: {},
                    ailments: [], activity: [] };
      results.push(rec);
      console.log(`  ${String(r.character).padEnd(12)} ${node.key.padEnd(9)} ` +
                  `${rec.ended.padEnd(11)}    -     -      -  ->    -`.padEnd(40));
      console.log(`               ${key.why}`);
      if (node.say)
        console.log(`               with it: stand in room ${node.room} and say "${node.say}" — ` +
                    `the floor lifts for ${Math.round((node.door_open_ms ?? 0) / 1000)}s and the ` +
                    `relic is spent`);
      return rec;
    }
  }
  // BEFORE the first thing that changes them.
  await keepOrders(r.agent);
  // Same starting conditions for every one of them, or the run measures who went first.
  await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [] });
  await call('autopilot', { agent: r.agent, action: 'unpark' });
  if (WALL !== null) await call('autopilot', { agent: r.agent, travel_wall_below: Number(WALL) });
  if (HOLD !== null) await call('autopilot', { agent: r.agent, travel_hold_below: Number(HOLD) });
  // STOP WHATEVER IS STILL GOING, EVERY LEG AND NOT ONLY THE FIRST. A travel job lives in the
  // BROKER, so killing the script does not end it — the character walks on and the next leg is
  // refused with "is busy: walk to ..." before it measures anything. The same is true between
  // legs of one run: the approach walk that just ended short is still a live command.
  //
  // `cancel_movement` FIRST: `autopilot action=cancel` returns a healthy status and leaves the
  // walk running, which is a cancel that reports success and cancels nothing.
  await call('cancel_movement', { agent: r.agent }, 20000).catch(() => null);
  await call('autopilot', { agent: r.agent, action: 'cancel' }, 20000).catch(() => null);
  await sleep(1500);
  if (place && DM_OK)
    await dm.relocate([r.character], from, { verify: false }).catch(() => null);
  // GUARDED LIKE ITS NEIGHBOURS. Not because a shared server reaches this — it does not, DM_OK
  // is false there — but because a LOOPBACK server whose maintenance port happens to be down
  // must degrade rather than take the run down with it.
  const ids = DM_OK ? await dm.resolve([r.character]).catch(() => ({})) : {};
  if (heal && DM_OK && ids[r.character] != null) {
    // ALL THREE VITALS, because the recovery hold asks for all three and because vigor is the
    // one that decides how long the character is standing in the room being hit. `dm.heal`
    // fills health and mana to their real ceilings and vigor to MAX_VIGOR — resting stops at
    // 80 of 200, so a leg that starts from rest starts unable to run.
    await dm.heal([r.character], { timeoutMs: 60000 }).catch(() => null);
  }

  // A LEG THAT STARTS UNDER A RECOVERY HOLD IS NOT A MEASUREMENT OF ANYTHING.
  // `recoverUntilWhole` is the KEEPER's flag and survives the DM tools filling the bars.
  // While it is up, `travel` is refused the instant it is asked — which reads exactly like a
  // room that cannot be left, at zero seconds, from and to the same room.
  let heldBack = null;
  for (let waited = 0; waited <= RECOVERY_WAIT_MS; waited += 5000) {
    const ap = await call('autopilot', { agent: r.agent, action: 'status' }, 30000);
    if (!ap?.recovering_from_death) { heldBack = null; break; }
    heldBack = ap.recovering_from_death?.until ?? 'recovering after a death';
    if (waited >= RECOVERY_WAIT_MS) break;
    await sleep(5000);
  }
  if (heldBack)
    console.log(`  ${String(r.character).padEnd(12)} still recovering after ` +
                `${Math.round(RECOVERY_WAIT_MS / 1000)}s — ${heldBack}; ` +
                `this leg is not a measurement of the road`);

  // THE ROAD GOES TO THE ROOM THE ROUTER CAN REACH, WHICH FOR THE CAVE IS NOT THE CAVE.
  const roadTo = node.entry ? node.entry.via : node.room;
  const started = Date.now();
  // NO ERRANDS ON A TIMED LEG. `run_errands` defaults to true — a character sent across the
  // world should stock up first — and that is exactly what this must not measure. A whole
  // ten-minute leg has been spent in a bank and scored as a failure to cross.
  const sent = await call('travel', { agent: r.agent, to: roadTo, max_hops: 30,
                                      background: true, run_errands: false }, 60000);
  let ended = null, low = null, died = false, restedMs = 0, refusedWhy = null;
  const rooms = new Set([from]);
  const perRoom = {};             // room number -> seconds spent in it
  const ailments = new Set();
  const activity = [];            // what the keeper said it was doing, changes only
  let roomNow = from;
  if (sent?._error || sent?.refused) {
    // A REFUSAL WITH NO REASON IS THE THING THIS REPOSITORY KEEPS PAYING FOR: the reason is
    // computed by the broker and returned over the wire, and a leg that never started must
    // not look identical to one that started and got nowhere.
    ended = 'refused';
    refusedWhy = sent?._error ?? sent?.reason ?? sent?.refused ?? 'no reason given';
    if (heldBack) refusedWhy += ` (and it was still ${heldBack})`;
  } else {
    for (;;) {
      await sleep(5000);
      const [st, ap] = await Promise.all([
        call('status', { agent: r.agent }, 30000),
        call('autopilot', { agent: r.agent, action: 'status' }, 30000),
      ]);
      // THE CLOCK PAUSES WHILE IT RESTS, and the paused time is kept rather than discarded —
      // a leg that spent its budget healing is a different animal from one that spent it
      // walking. A PAUSED CLOCK NEEDS A CEILING or it is not a pause, it is a hang: past
      // REST_CREDIT_MS the leg ends as `rested out`, which is its own finding.
      if (isResting(ap)) restedMs = Math.min(restedMs + 5000, REST_CREDIT_MS);
      for (const e of (st?.ailments ?? [])) if (e?.name) ailments.add(e.name);
      const room = st?.where?.num ?? null;
      if (room != null) {
        if (roomNow !== room) roomNow = room;
        perRoom[room] = (perRoom[room] ?? 0) + 5;
        rooms.add(room);
      }
      const doing = String(ap?.activity ?? '').slice(0, 60);
      if (doing && doing !== activity[activity.length - 1]?.what)
        activity.push({ what: doing, at: Date.now(), room });
      const hp = st?.vitals?.health?.value ?? null;
      if (hp != null && (low === null || hp < low)) low = hp;
      // THE UNDERWORLD IS THE DEATH, and it is the only reliable sign of one: a 5s poll
      // almost never lands on the frame where health reads zero.
      if (room === UNDERWORLD) { died = true; ended = 'DIED'; break; }
      // The road's destination, OR the node's room — a character can arrive somewhere better
      // than it was sent, and for the cave the trigger fires on any movement into the corner
      // including one the walker made on its way past.
      if (room === roadTo || room === node.room) { ended = 'in room'; break; }
      if (Date.now() - started - restedMs > TIMEOUT) {
        ended = restedMs >= REST_CREDIT_MS ? 'rested out' : 'timed out';
        break;
      }
    }
  }
  const roadSecs = Math.round((Date.now() - started) / 1000);
  const restSecs = Math.round(restedMs / 1000);

  // ------------------------------------------------- the words, for a door that wants them
  //
  // SAID IN THE ROOM, AND ONLY ONCE WE ARE IN IT. `SomeoneSaid` is the room's own handler and
  // it reads the SPEAKER's pack, so the words are worth nothing said anywhere else — and they
  // spend the relic, so they are said after arriving rather than hopefully on the way.
  //
  // WHAT IS NOT KNOWN HERE, and is the next real question for this stone: where SECTOR_DOOR
  // actually is in room 599. The floor lifts 440 -> 340 for ten seconds and this run does not
  // know which squares that opens, so it says the words, records the window, and lets the
  // ordinary approach try. If it comes up short the FRONTIER line will say where it stopped,
  // which is the measurement somebody needs before this can be timed properly.
  let saidWords = null;
  if (node.say && (ended === 'in room' || ended === 'at node')) {
    const at = Date.now();
    const r2 = await call('say', { agent: r.agent, type: 'say', text: node.say }, 20000)
      .catch(e => ({ error: e?.message ?? String(e) }));
    saidWords = { text: node.say, at, error: r2?.error ?? null,
                  window_ms: node.door_open_ms ?? null };
    console.log(`               said "${node.say}" in room ${node.room}` +
                `${r2?.error ? ` — the say FAILED: ${r2.error}` : ''}` +
                `${node.door_open_ms ? `; the floor is open for ` +
                  `${Math.round(node.door_open_ms / 1000)}s and the relic is spent` : ''}`);
  }

  // ------------------------------------------------- through the trigger, if there is one
  let triggerSecs = 0, triggered = null, triggerWhy = null, triggerMode = null;
  let pos = ended === 'in room' ? await where(r.agent) : null;
  if (ended === 'in room' && node.entry && pos?.room !== node.room) {
    // The thing being waited on is the ROOM NUMBER CHANGING, not the walker arriving at the
    // corner: the trigger fires on movement INTO the box, so the character is teleported
    // before it ever reaches the square that was aimed at.
    const w = await walkAndWatch(r.agent, node.entry.trigger, {
      until: p => p?.room === node.room, budgetMs: TRIGGER_MS, modes: TRIGGER_MODES });
    pos = w.pos; triggerSecs = w.secs; triggerWhy = w.why; triggerMode = w.mode;
    triggered = pos?.room === node.room;
    if (pos?.room === UNDERWORLD) { died = true; ended = 'DIED'; }
    else if (!triggered) ended = 'no trigger';
  }

  // ------------------------------------------------- the last few squares, to the stone
  let apprSecs = 0, sawNode = null, approachWhy = null, approachMode = null, closest = null;
  if (APPROACH && ended === 'in room' && pos?.room === node.room) {
    // AIM AT THE STONE, STOP AT THE BOX. `until` is the server's own 5x5 rule, so a character
    // that gets within two squares and can go no further has SUCCEEDED and is not walked on
    // into whatever is between it and the exact centre — which on the ancient place's ledge
    // is a drop.
    const w = await walkAndWatch(r.agent, node.node, {
      until: p => p?.room === node.room && atNode(p, node.node),
      budgetMs: APPROACH_MS, modes: APPROACH_MODES,
      near: node.node, nearRoom: node.room });
    pos = w.pos; apprSecs = w.secs; approachWhy = w.why; approachMode = w.mode;
    closest = w.closest;
    if (pos?.room === UNDERWORLD) { died = true; ended = 'DIED'; }
    else if (atNode(pos, node.node)) { ended = 'at node'; approachWhy = null; }
    // AND THE APPROACH VERDICT, which is the whole errand for a gated stone. Chebyshev, in
    // coarse squares, because the meld box is per-axis and so is this.
    else if (node.objective === 'approach' && pos?.room === node.room &&
             Number.isFinite(pos.row) && Number.isFinite(pos.col) &&
             Math.max(Math.abs(pos.row - node.node.row),
                      Math.abs(pos.col - node.node.col)) <= node.within) {
      ended = 'approached'; approachWhy = null;
    }
    sawNode = pos?.node ?? null;
  }
  if (!pos) pos = await where(r.agent).catch(() => null);

  // ANNOUNCED ON ARRIVAL AT THE STONE, not merely at the room — the broadcast has to mean the
  // same thing the row means. Best-effort on purpose: a broadcast the server swallowed must
  // not turn a reached node into a failed leg.
  let said = null;
  if (died) setLaps(r.character, 0);
  else if (ended === 'at node' && BROADCAST) {
    const lap = lapsOf(r.character) + 1;
    said = await call('say', { agent: r.agent, type: 'broadcast',
      text: `I'm on my ${ordinal(lap)} node walk since dying, and I'm standing at the mana ` +
            `node in ${node.name}. The road took ${roadSecs} seconds.` +
            (next ? ` Next node: ${next.name}.` : '') }, 20000).catch(() => null);
  }

  const rec = { character: r.character, node: node.key, room: node.room, ended,
                roadSecs, apprSecs, triggerSecs, restSecs, died, low,
                endedIn: pos?.room ?? null, endedAt: pos ? { col: pos.col, row: pos.row } : null,
                sawNode, approachWhy, triggerWhy, approachMode, triggerMode, closest,
                ...(saidWords ? { said: saidWords } : {}),
                rooms: [...rooms], perRoom,
                ailments: [...ailments], activity };
  results.push(rec);

  console.log(`  ${String(r.character).padEnd(12)} ${node.key.padEnd(9)} ` +
              `${String(ended).padEnd(11)} ${String(roadSecs).padStart(4)}s ` +
              `${String(apprSecs + triggerSecs).padStart(4)}s  ` +
              `${String(from).padStart(4)} -> ` +
              `${String(pos?.room ?? '?').padStart(4)}` +
              `${pos?.col != null ? ` r${pos.row}c${pos.col}` : ''}`.padEnd(14) +
              ` ${String(low ?? '?').padStart(3)}  ${String(restSecs).padStart(4)}r`);
  if (refusedWhy)
    console.log('               REFUSED: ' + refusedWhy);

  // THE FRONTIER, on any leg that did not reach the stone. Printed for the room the body is
  // ACTUALLY in, which on a failed road is not the room it was aiming at.
  if (ended !== 'at node' && pos?.room != null && pos.col != null) {
    const f = await frontier(pos.room, { row: pos.row, col: pos.col });
    if (f?.unavailable)
      console.log(`               FRONTIER: cannot say — ${f.unavailable}`);
    else if (f?.why)
      console.log(`               FRONTIER r${pos.row}c${pos.col}: ${f.why}`);
    else if (f)
      console.log(`               FRONTIER r${pos.row}c${pos.col} in room ${pos.room}: ` +
                  `can walk to ${f.can.length ? f.can.join(', ') : 'NO door in this room'}` +
                  `${f.cannot.length ? `; cannot reach ${f.cannot.join(', ')}` : ''}`);
  }
  if (ended === 'no trigger')
    console.log(`               ${triggerSecs}s walking at r${node.entry.trigger.row}c${node.entry.trigger.col} ` +
                `of room ${node.entry.via} and was never sent to ${node.room} ` +
                `(${node.entry.src})${triggerWhy ? ' — ' + triggerWhy : ''}`);
  if (triggered === true)
    console.log(`               through the trigger in ${triggerSecs}s on ${triggerMode} movement, landed r${pos?.row}c${pos?.col}`);
  if (ended === 'in room' && APPROACH)
    console.log(`               the room, not the stone: closest ` +
                (closest ? `r${closest.row}c${closest.col}, ${closest.away} away ` +
                           `(${closest.mode}, at +${closest.at}s)` : 'never measured') +
                `; ended r${pos?.row}c${pos?.col}, node r${node.node.row}c${node.node.col}` +
                (sawNode ? `, could SEE it ${sawNode.distance} away` : ', never saw it') +
                (approachWhy ? ` — ${approachWhy}` : ''));
  if (ended === 'at node' && sawNode)
    console.log(`               "${sawNode.name}" at r${sawNode.row}c${sawNode.col}, ${sawNode.distance} away` +
                (approachMode ? ` (${approachMode} movement)` : ''));
  if (ailments.size)
    console.log('               AILING: ' + [...ailments].join(', ') +
                " — this leg's time is not a measurement of the road");
  if (ended === 'at node' && BROADCAST && said && !said.echoed)
    console.log('               (arrival broadcast may not have gone out: ' +
                String(said?._error ?? JSON.stringify(said?.messages ?? said ?? null)).slice(0, 160) + ')');
  // Printed when the leg did not reach the stone, because that is when anybody asks.
  if (!legOk(rec) && activity.length) {
    const t0 = activity[0].at;
    console.log('               what it thought it was doing:');
    for (const a of activity.slice(0, 12))
      console.log('                 +' + String(Math.round((a.at - t0) / 1000)).padStart(3) + 's  room ' +
                  String(a.room ?? '?').padStart(4) + '  ' + a.what);
    if (activity.length > 12) console.log('                 ... and ' + (activity.length - 12) + ' more');
  }
  // SECONDS PER ROOM, because a journey that fails is usually a journey that was slow
  // somewhere specific, and a room total hides which room.
  const spent = Object.entries(perRoom).sort((x, y) => y[1] - x[1]).filter(([, sec]) => sec >= 10);
  if (spent.length)
    console.log('               time by room: ' +
                spent.map(([num, sec]) => num + '=' + sec + 's').join('  '));
  return rec;
}

// A WALK IS RUN PER CHARACTER, NODE AFTER NODE, AND STOPS AT THE FIRST ONE IT DOES NOT REACH.
// Carrying on from a body that is dead or stranded would measure a relocate rather than a
// road, and how far round the six it got is the number worth having.
//
// ONLY THE FIRST LEG IS PLACED AND HEALED. Relocating between nodes throws away what the
// circuit is asking — whether the character is still in a state to go on — and healing
// between them turns six legs into six first legs.
async function runWalk(r) {
  const plan = RANDOM ? drawItinerary(r.character) : CIRCUIT;
  const legs = [];
  let at = FROM;
  for (let i = 0; i < plan.length; i++) {
    const out = await runLeg(r, plan[i], { from: at, place: i === 0, heal: i === 0,
                                           next: plan[i + 1] ?? null });
    legs.push(out);
    if (!legOk(out)) break;
    at = out.endedIn ?? plan[i].room;
  }
  const done = legs.filter(reachedNode).length;
  const rooms = legs.filter(reachedRoom).length;
  if (done === plan.length) setLaps(r.character, lapsOf(r.character) + 1);
  console.log(`  ${String(r.character).padEnd(12)} ${rooms} of ${plan.length} room(s), ` +
              `${done} node(s) ` +
              `— ${legs.map(l => `${l.node}:${l.ended}@${l.endedIn ?? '?'}`).join(' -> ')}`);
  return legs;
}

const STAGGER = Number(flag('stagger', 0));
// SEQUENTIAL IS THE HONEST WAY TO MEASURE A ROAD; STAGGERED IS THE HONEST WAY TO MEASURE A
// FLEET. Twenty-one characters setting off together queue at the same doorway and share the
// spawn they walk through, so a fleet run measures contention as much as the route — but
// "if I send everybody, how many arrive" is the question an operator actually has.
if (STAGGER > 0) {
  console.log(`(staggered: one every ${STAGGER}s, all polled together)\n`);
  await Promise.all(rows.map((r, i) => sleep(i * STAGGER * 1000).then(() => runWalk(r))));
} else {
  for (const r of rows) await runWalk(r);
}

// ---------------------------------------------------------------- what it found
//
// PER NODE FIRST, because the whole point of this selection is that the six are not equally
// hard and the output worth having is WHICH ONE stops the fleet.
console.log('');
console.log('PER NODE');
console.log('  node      tried  in room  at node  died  other       median road   best   where');
for (const n of NODES) {
  const mine = results.filter(x => x.node === n.key);
  if (!mine.length) continue;
  const got = mine.filter(reachedNode);
  const inRoom = mine.filter(reachedRoom);
  const med = a => (a.length ? a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)] + 's' : '-');
  const other = mine.filter(x => !reachedRoom(x) && !x.died);
  // HOW CLOSE ANYBODY GOT, AND ON WHICH SQUARE. On a node nobody reaches this is the entire
  // result: "0 of 21" says the approach is broken and says nothing about where, and the square
  // is the thing a rail has to be built to.
  const best = mine.map(x => x.closest).filter(Boolean)
                   .sort((a, b) => a.away - b.away)[0] ?? null;
  console.log(`  ${n.key.padEnd(9)} ${String(mine.length).padStart(4)}  ` +
              `${String(inRoom.length).padStart(7)}  ` +
              `${String(got.length).padStart(7)}  ` +
              `${String(mine.filter(x => x.died).length).padStart(4)}  ` +
              `${(other.length ? [...new Set(other.map(x => x.ended))].join(',') : '-').padEnd(11)} ` +
              `${med(inRoom.map(x => x.roadSecs)).padStart(11)}  ` +
              `${(best ? best.away + ' away' : '-').padStart(7)}  ` +
              `${best ? `r${best.row}c${best.col} (${best.mode})` : ''}`);
}

// AND THE WHOLE DISTRIBUTION OF CLOSEST SQUARES, per node, commonest first. One best square is
// one lucky sample; a square twelve characters all stopped on is the thing to build a rail to.
for (const n of NODES) {
  const mine = results.filter(x => x.node === n.key && x.closest);
  if (mine.length < 2) continue;
  const bySq = {};
  for (const x of mine) {
    const k = `r${x.closest.row}c${x.closest.col}`;
    (bySq[k] ??= { n: 0, away: x.closest.away }).n++;
  }
  const rows = Object.entries(bySq).sort((a, b) => b[1].n - a[1].n || a[1].away - b[1].away);
  console.log('');
  console.log(`  where they stopped for ${n.key} (node r${n.node.row}c${n.node.col}):`);
  for (const [sq, v] of rows.slice(0, 8))
    console.log(`    ${String(v.n).padStart(3)} x  ${sq.padEnd(9)} ${v.away} away`);
}

// WHERE THE TIME WENT, ACROSS EVERY LEG. One slow room costs every character, so the total
// per room is the thing to attack; a single leg's figure is one sample of it.
const totals = {};
for (const r of results) for (const [num, sec] of Object.entries(r.perRoom ?? {}))
  totals[num] = (totals[num] ?? 0) + sec;
const worst = Object.entries(totals).sort((x, y) => y[1] - x[1]).slice(0, 10);
if (worst.length) {
  console.log('');
  console.log('seconds spent per room, worst first (all legs):');
  for (const [num, sec] of worst) console.log('  ' + String(sec).padStart(5) + 's  room ' + num);
}

// AND WHERE THE BODIES STOPPED. A room appearing here repeatedly is the next thing to open
// with `m59-roomview.mjs`, which is the tool that answers "where IN the room" — the question
// a room total cannot.
const stops = {};
for (const r of results) if (!legOk(r)) stops[r.endedIn ?? '?'] = (stops[r.endedIn ?? '?'] ?? 0) + 1;
if (Object.keys(stops).length) {
  console.log('');
  console.log('where the ones that did not finish their leg ended up:');
  for (const [k, v] of Object.entries(stops).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  room ${k}    node tools/m59-roomview.mjs ${k}`);
}

const gotRoom = results.filter(reachedRoom).length;
const gotNode = results.filter(reachedNode).length;
const dead = results.filter(r => r.died).length;
console.log(`\n${results.length} leg(s): ${gotRoom} reached the room, `
          + `${gotNode} reached the stone, ${dead} died, `
          + `${results.length - gotRoom - dead} neither`);

await putOrdersBack();
