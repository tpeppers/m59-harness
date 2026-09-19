#!/usr/bin/env node
// FOLLOW A FINE ROUTE EXACTLY, OR STOP AND SAY WHERE IT CAME OFF.
//
//   node tools/m59-fineclimb.mjs --agent shadow01 --to 52,30
//   node tools/m59-fineclimb.mjs --agent shadow01 --to 52,30 --dry-run
//   node tools/m59-fineclimb.mjs --agent shadow01 --room 589 --to 45,32 --port 8971
//   node tools/m59-fineclimb.mjs --agent shadow01 --rail ancient            walk a BAKED rail
//   node tools/m59-fineclimb.mjs --agent shadow01 --rail ancient --direction to_exit
//
// `--to` is `row,col` (KOD/RoomGeometry order), like every other geometry tool here.
//
// `--rail <node>` FOLLOWS A RAIL `m59-noderails.mjs` ALREADY CUT rather than planning one.
// The difference is not speed, it is that a baked rail has been CHECKED: every one of its
// points is a lattice step the mover's own trace accepted, and its aim list was decimated by
// stepping each chord rather than by noticing a heading change. A plan made here is a fresh
// opinion; a rail is one that has been re-walked offline by `noderails check`.
//
// AND A RAIL IS ONLY VALID FROM WHERE IT WAS CUT — `m59-railcut.mjs`'s first sentence. These
// are cut from the bake's own exit ANCHORS, which is where a journey delivers a body, so the
// follow refuses when the body is not on the line and says how far off it is. Boarding a rail
// from an arbitrary square is how sixteen legs of correct following produced no progress at
// all in room 49. `--board-within` is the knob; re-cutting from the body is the alternative.
//
// WHY THIS EXISTS, AND IT IS NOT THAT THE ROUTE WAS WRONG. `m59-fineroute.mjs` plans the
// Ancient Place climb correctly — the operator's own three declared jumps, in their order,
// through the spiral they described. Handing those waypoints to `walk_to` one at a time and
// letting it have twenty-four steps to reach each one produced a character at r37c34, a square
// THE PLAN NEVER VISITS, jittering in place until it was stopped. The plan was right and the
// walk was free: `walk_to` re-plans between waypoints, and on ground where the square grid is
// a lie it re-plans onto the lie.
//
// So this is the strict follower. Two rules and they are the whole tool:
//
//   A SHORT LEASH. Waypoints come out of the planner three quarters of a square apart, and
//   each one is asked for with a handful of steps. There is nowhere to wander to.
//
//   DIVERGENCE IS A STOP, NOT A RETRY LOOP. After every waypoint the body's real position is
//   compared with the one that was asked for. Drifting is normal and is tolerated to
//   `--tolerance` squares; past that the follow ENDS and reports the waypoint index, what was
//   asked, and where the body actually is. A follower that keeps trying is how the last
//   attempt spent ten minutes going nowhere, and a route that has come off is information
//   rather than something to grind against.
//
// It reads the body's position out of `walk_to`'s OWN REPLY rather than calling `look` after
// each step — the reply carries `position`, and doubling the call count on a 177-waypoint
// climb is the difference between three minutes and ten. Note the reply's x/y are kod
// PROTOCOL units, not client units; `(v - 64) * 16` is the conversion and getting it wrong
// silently compares two different coordinate spaces.
//
// It moves a character. It refuses a game server that is not loopback, on the roster, for the
// same reason every other tool here does.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';
import { fineRouter } from './m59-fineroute.mjs';
import { RAILS_FILE, findRoute } from './m59-noderails.mjs';
import { distanceToRail } from './m59-railfollow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const KNOWN = new Set(['agent', 'room', 'to', 'port', 'fleet', 'dry-run', 'tolerance',
                       'steps', 'stride', 'no-hop', 'max-jumps', 'allow-candidates', 'help',
                       'rail', 'exit', 'direction', 'rail-file', 'board-within']);
if (has('help') || !argv.length) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith('//'))
    .map(l => l.replace(/^\/\/ ?/, '')).join('\n').split('\n\n').slice(0, 2).join('\n\n'));
  process.exit(argv.length ? 0 : 2);
}
{
  const unknown = argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')[0])
                      .filter(a => !KNOWN.has(a));
  if (unknown.length) {
    console.error(`fineclimb: unknown option(s): ${unknown.map(u => '--' + u).join(', ')}`);
    process.exit(2);
  }
}
const PORT  = Number(flag('port', 8971));
const FLEET = flag('fleet', 'shadow');
const AGENT = flag('agent');
const TO    = flag('to');
const DRY   = has('dry-run');
// How far off a waypoint the body may be before the follow is declared to have come off.
const TOL   = Number(flag('tolerance', 1.6));       // squares
const STEPS = Number(flag('steps', 6));             // fine steps allowed per waypoint
// HOW BIG EACH FINE MOVE IS, in kod units of the 64 that make a square. `walk_to` defaults to
// 48 — three quarters of a square a packet — and on a staircase of slivers that is enough to
// step clean over the tread and into the gully beside it. Smaller strides cost packets and
// buy precision, which is the trade this tool exists to make.
const STRIDE = Number(flag('stride', 16));
// A BAKED RAIL, IF ONE WAS NAMED. Loaded before the roster check so a typo costs nothing and
// `--dry-run` can print the rail without a server.
const RAIL_NODE = flag('rail');
const DIRECTION = flag('direction', 'to_node');
const BOARD = Number(flag('board-within', 2));          // squares
let RAIL = null;
if (RAIL_NODE) {
  const railFile = flag('rail-file', RAILS_FILE());
  let baked = null;
  try { baked = JSON.parse(readFileSync(railFile, 'utf8')); }
  catch (e) {
    console.error(`fineclimb: cannot read ${railFile}: ${e.message}`);
    console.error('           bake one first: node tools/m59-noderails.mjs bake');
    process.exit(2);
  }
  RAIL = findRoute(baked, { node: RAIL_NODE, direction: DIRECTION, exit: flag('exit') });
  if (!RAIL) {
    // A MISSING RAIL IS NOT A MISSING ROUTE. Say which of the two it is, or this reads as
    // "there is no way there" when it means "nobody baked one, or the bake said no".
    const s = (baked.stones ?? []).find(x => x.node === RAIL_NODE);
    console.error(!s
      ? `fineclimb: ${railFile} has no stone called "${RAIL_NODE}"`
      : `fineclimb: no ${DIRECTION} rail for "${RAIL_NODE}"` +
        `${flag('exit') ? ` via ${flag('exit')}` : ''} — the bake holds ` +
        `${(s.routes ?? []).filter(r => r.direction === DIRECTION && r.ok).length} of ` +
        `${(s.routes ?? []).filter(r => r.direction === DIRECTION).length} in that direction`);
    process.exit(2);
  }
}
if (!AGENT || !(TO || RAIL)) {
  console.error('fineclimb: need --agent and either --to row,col or --rail <node>');
  process.exit(2);
}
const railTarget = RAIL ? /^r(\d+)c(\d+)$/.exec(RAIL.to) : null;
const [toRow, toCol] = TO ? TO.split(',').map(Number)
                          : [Number(railTarget[1]), Number(railTarget[2])];
if (!Number.isFinite(toRow) || !Number.isFinite(toCol)) {
  console.error('fineclimb: --to must be row,col'); process.exit(2);
}

const F = 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// THE TWO COORDINATE SPACES, AND GETTING THEM THE WRONG WAY ROUND WALKS OFF THE MAP.
//
// `m59-fineroute.mjs` works in CLIENT fine units (1024 to a square) because that is what the
// BSP is in. `walk_to`'s x/y are kod PROTOCOL units — its own col/row path computes
// `col * 64 + 32`, which is protocol — and 64 units to a square with a +64 origin offset.
//
// Passing a client x of 52512 as a protocol x asks for square 820 of a 74-column room. The
// mover dutifully set off toward it: a character standing ON the first waypoint was walked
// 6.9 squares away from it in three seconds, and the follower called that "came off". It had
// not come off; it had been sent somewhere else.
const toClient = v => (v - 64) * 16;      // kod protocol -> client fine
const toProto  = v => v / 16 + 64;        // client fine -> kod protocol

function call(name, args, ms = 120000) {
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
        // A tool refusal is PROSE, not JSON, and the parse error hides it.
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) { done({ _error: text.slice(7) }); return; }
          done(JSON.parse(text));
        } catch (e) { done({ _error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}

// ---------------------------------------------------------------- which fleet
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const rosterFile = FLEET === '-' ? join(REPO, 'substrate', 'fleet-state.json')
                                 : join(REPO, 'substrate', 'fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!DRY) {
  if (!rostered) { console.error(`fineclimb: ${rosterFile} does not name one game server.`); process.exit(2); }
  if (!LOOPBACK.has(rostered.host.toLowerCase())) {
    console.error(`fineclimb: REFUSING. Fleet "${FLEET}" is on ${rostered.host}, not loopback.`);
    console.error(`           This walks a character off ledges on purpose. Lab servers only.`);
    process.exit(2);
  }
}

const look = async () => {
  const l = await call('look', { agent: AGENT }, 40000);
  if (l?._error) return { _error: l._error };
  const node = [...(Array.isArray(l?.objects) ? l.objects : []),
                ...(Array.isArray(l?.scenery) ? l.scenery : [])]
    .find(o => /mana node/i.test(String(o?.name ?? '')));
  return { room: Number(l?.room?.num ?? NaN), row: l?.you?.row, col: l?.you?.col,
           x: l?.you?.x, y: l?.you?.y, hp: l?.hp?.value, node };
};

const at0 = await look();
if (at0._error) { console.error(`fineclimb: ${at0._error}`); process.exit(1); }
const ROOM = Number(flag('room', at0.room));
if (at0.room !== ROOM) {
  console.error(`fineclimb: ${AGENT} is in room ${at0.room}, not ${ROOM}. This plans INSIDE one room.`);
  process.exit(2);
}
// A RAIL IS A LINE INSIDE ONE ROOM, AND NOTHING ELSE SAYS WHICH. Without this the router is
// built for the room the BODY is in while the waypoints come from another — it plans, it
// prints, it drives, and every coordinate is about a different building. Caught with shadow01
// standing in 801 following the rail cut for 589.
if (RAIL && Number(RAIL.room) !== ROOM) {
  console.error(`fineclimb: the "${RAIL_NODE}" rail is a line inside room ${RAIL.room}, and ` +
                `${AGENT} is in room ${ROOM}. Travel there first.`);
  process.exit(2);
}

// PLAN FROM WHERE THE BODY IS. A plan whose first waypoint is thirty squares away is a plan
// for somebody else, and the follower will spend its whole leash getting to the start.
// AND FROM THE BODY'S REAL FINE POINT, NOT THE SQUARE IT IS IN. `footing(row,col)` takes the
// HIGHEST floor in a square, and these squares hold two worlds: a character that has fallen
// into the valley under a ledge is at r37c34 with floor 3392 while the footing search says
// r37c34 means the 7040 shelf. Planning from the shelf for a body in the valley produces a
// route it cannot take a single step of. `look` gives x/y in kod PROTOCOL units.
const R = fineRouter(ROOM);
const fromPt = (at0.x != null && at0.y != null)
  ? { row: at0.row, col: at0.col, x: toClient(at0.x), y: toClient(at0.y) }
  : { row: at0.row, col: at0.col };
// A BAKED RAIL IS DRIVEN BY ITS `aims`, NOT BY ITS WAYPOINTS. The dense list is the proof —
// one lattice step a trace accepted, per point — and driving it one `walk_to` per point would
// be 1,249 round trips for a walk of forty squares. `aims` is the same line decimated to its
// straight runs, so every aim is a chord made of steps the flood already accepted.
const railLegs = RAIL
  ? RAIL.legs.map(l => (l.kind === 'walk' ? { ...l, waypoints: l.aims ?? l.waypoints } : l))
  : null;
const plan = RAIL
  ? { ok: true, legs: railLegs, jumps: RAIL.jumps, all_declared: RAIL.all_declared,
      confidence: `baked rail — ${RAIL.confidence}` }
  : R.plan(fromPt, { row: toRow, col: toCol },
           { maxJumps: Number(flag('max-jumps', 4)),
             allowCandidates: has('allow-candidates') });
const total = (plan.legs ?? []).filter(l => l.kind === 'walk')
  .reduce((a, l) => a + l.waypoints.length, 0);
console.log(`room ${ROOM} — ${R.room.name}`);
console.log(`${AGENT} at r${at0.row}c${at0.col} hp ${at0.hp} -> r${toRow}c${toCol}`);
if (RAIL)
  console.log(`rail: ${RAIL_NODE} ${DIRECTION} via ${RAIL.exit_label}, ` +
              `${RAIL.waypoints} waypoint(s) -> ${total} aim(s)` +
              `${RAIL.unvalidated ? `, ${RAIL.unvalidated} unvalidated span(s)` : ''}` +
              `${RAIL.committing_drops ? `, ${RAIL.committing_drops} committing drop(s)` : ''}`);
// A RAIL IS ONLY VALID FROM WHERE IT WAS CUT. Measured in room 49: a body 240 units off the
// seed had a step accepted from the seed and REFUSED from where it stood, and sixteen legs of
// correct boarding-and-following produced no along-track progress at all. So the board is
// checked on the SHELF as well as the distance — `distanceToRail` is the floor-aware answer,
// and the 2D one picks a waypoint on a ledge the body cannot step onto and calls it 304 units
// away. Refusing here costs a walk; not refusing costs the six minutes it takes to notice.
//
// AND A POSITION THAT WAS NOT READ IS NOT A DISTANCE. `toClient(undefined)` is NaN, every
// comparison against it is false, and the refusal below would then read "not on the rail: NaN
// square(s)" — blaming the line for a body nobody could locate. Measured on the shadow fleet
// 2026-09-19: 18 of 23 characters answer `status` with `you: null`, because the broker's
// room-view projection falls back to the keeper's own ROOM and not to its POSITION, while
// `look` answers with a position for those same characters in the same second. This tool reads
// `look` and `walk_to`'s own reply and never `status`, so it is not on that path — but a source
// that can go quiet has to say so when it does, which is the fix `crawl_to` took as
// `position_unreadable`.
if (RAIL && !DRY) {
  const first = (railLegs.find(l => l.kind === 'walk')?.waypoints) ?? [];
  if (at0.x == null || at0.y == null) {
    console.log(`position_unreadable: look answered for ${AGENT} in room ${at0.room} with no ` +
                `x/y, so there is nothing to board from. That is a READ failing, not the rail.`);
    process.exit(2);
  }
  const here = { x: toClient(at0.x), y: toClient(at0.y) };
  const d = distanceToRail(first, here, { floor: R.floorAt(here.x, here.y) });
  if (!(d.d <= BOARD * F)) {
    console.log(`not on the rail: ${(d.d / F).toFixed(1)} square(s) from it ` +
                `(nearest segment ${d.i}, shelf ${d.onShelf === false ? 'DIFFERENT' : 'same'}, ` +
                `floor ${d.floorKnown ? 'read' : 'UNREADABLE'}), --board-within is ${BOARD}`);
    console.log(`  this rail is cut from ${RAIL.from}. Walk there first, or cut one from here ` +
                `with m59-railcut.`);
    process.exit(2);
  }
  console.log(`boarding at segment ${d.i}, ${(d.d / F).toFixed(1)} square(s) off`);
}
if (!plan.ok) { console.log(`no plan: ${plan.why}`); process.exit(2); }
console.log(`plan: ${plan.jumps} jump(s), ${total} waypoint(s), all_declared=${plan.all_declared}`);
console.log(`  ${plan.confidence}`);
if (DRY) {
  for (const [i, leg] of plan.legs.entries())
    console.log(leg.kind === 'walk'
      ? `  ${i + 1}. walk ${leg.waypoints.length}` +
        (leg.biggest_drop ? ` (biggest drop ${leg.biggest_drop})` : '')
      : `  ${i + 1}. JUMP r${leg.from.row}c${leg.from.col} -> r${leg.to.row}c${leg.to.col}` +
        (leg.declared ? ' [declared]' : ' [CANDIDATE]'));
  process.exit(0);
}
if (!plan.all_declared)
  console.log('  NOTE: contains undeclared candidates; `jump` will refuse them. This will stop there.');

// Same starting conditions as any other measured run: nothing else driving the body.
await call('cancel_movement', { agent: AGENT }, 20000).catch(() => null);

const t0 = Date.now();
let came_off = null, pos = at0, hops = 0;
// The body's own floor, one waypoint ago — see the fall test below.
let lastFloor = (at0?.x != null) ? R.floorAt(toClient(at0.x), toClient(at0.y)) : null;
outer:
for (const [li, leg] of plan.legs.entries()) {
  if (leg.kind === 'jump') {
    // LINE UP ON THE DECLARED TAKE-OFF FIRST. A fall is a trajectory: it starts where it
    // starts. The walk leaves the body on the right SHELF but not the right POINT, and the
    // keeper's one-square tolerance then lets the jump fire from beside the take-off, where
    // it reports success and moves nobody.
    //
    // `arrive_within` matters as much as the target: the default is 40 kod units, which is
    // 640 client units and two thirds of a square, so a line-up "arrives" while still a
    // square and a half out.
    const aim = leg.declared_from ?? leg.fromFine;
    for (let k = 0; k < 30; k++) {
      const q = await look();
      if (q?._error || q?.room !== ROOM) break;
      if (Math.hypot(toClient(q.x) - aim.x, toClient(q.y) - aim.y) < 110) break;
      await call('walk_to', { agent: AGENT, x: toProto(aim.x), y: toProto(aim.y),
                              max_steps: 8, stride: 8, arrive_within: 6,
                              hold_shelf: k < 6 }, 60000).catch(() => null);
    }
    const j = await call('jump', { agent: AGENT, to_row: leg.to.row, to_col: leg.to.col }, 60000);
    // A FALL IS CONFIRMED BY THE SERVER, NOT BY THE REPLY. The mover answers `predicted: true`
    // and usually `geometry_blocked` — our local trace refuses what the client does anyway —
    // and the body is still on the take-off if you read it at once. A moment later it is on
    // the landing. Reading immediately recorded a jump that WORKED as one that did nothing,
    // twice, and each time sent the follower down the post-jump route from the take-off,
    // which is how it ended in the gully.
    await sleep(3000);
    pos = await look();
    const ok = j?.jumped === true;
    console.log(`  leg ${li + 1}  JUMP r${leg.from.row}c${leg.from.col} -> r${leg.to.row}c${leg.to.col}  ` +
                `${ok ? 'JUMPED' : 'REFUSED'}  now r${pos.row}c${pos.col} hp ${pos.hp}` +
                (ok ? '' : `\n           ${j?._error ?? j?.reason ?? JSON.stringify(j).slice(0, 200)}`));
    if (!ok) { came_off = { leg: li + 1, kind: 'jump' }; break; }
    continue;
  }
  for (const [wi, wp] of leg.waypoints.entries()) {
    const w = await call('walk_to', { agent: AGENT, x: toProto(wp.x), y: toProto(wp.y),
                                      max_steps: STEPS, stride: STRIDE,
                                      hold_shelf: true }, 60000);
    // THE REPLY CARRIES THE POSITION, in kod protocol units. Reading it here rather than
    // calling `look` halves the round trips on a long climb.
    const p = w?.position;
    const cx = p?.x != null ? toClient(p.x) : null, cy = p?.y != null ? toClient(p.y) : null;
    if (cx == null) { pos = await look(); }
    else pos = { room: pos.room, row: p.row, col: p.col, x: cx, y: cy, hp: pos.hp };
    if (w?._error) {
      console.log(`  leg ${li + 1}  waypoint ${wi + 1}/${leg.waypoints.length}: ${w._error}`);
      came_off = { leg: li + 1, waypoint: wi + 1, why: w._error }; break outer;
    }
    // DISTANCE ALONE CANNOT TELL "NEARLY THERE" FROM "FELL OFF".
    //
    // The body ended 0.7 squares from the Ancient Place take-off and FIVE THOUSAND UNITS
    // BELOW it — off the ledge, in the valley — and a horizontal tolerance called that
    // arrived. The leg then reported reaching r40c33 and the jump was refused with
    // `my_floor: 3520` against a take-off at 8640, which is the first thing that said out
    // loud what had happened.
    //
    // So the check is both: how far, and WHICH SHELF. A body more than one step-height off
    // its waypoint's floor is not near it in any sense that matters.
    let off = (cx == null) ? 0 : Math.hypot(cx - wp.x, cy - wp.y) / F;
    let hBody = cx == null ? null : R.floorAt(cx, cy);
    const hWant = R.floorAt(wp.x, wp.y);

    // BLOCKED BY SOMETHING STANDING THERE? GO ROUND IT IN THE AIR.
    //
    // Monster collision is HEIGHT-AGNOSTIC — every monster is effectively infinitely tall — so
    // a creature in the gully below a ledge is a WALL to a walk across it, and `hold_shelf`
    // correctly refuses to walk into one. Three runs of the Ancient Place climb stalled on a
    // single orc, at full health, for want of this.
    //
    // A hop of about a square onto ground within one step-height is not a jump and needs no
    // declaration; `short_hop` enforces exactly that and refuses anything bigger. It is tried
    // only when the ordinary walk has stopped making ground — never as the first move — so a
    // climb that is walking fine never leaves the floor.
    if (!w?.arrived && off > 0.9 && hWant != null) {
      const hop = await call('short_hop', { agent: AGENT, to_row: wp.row, to_col: wp.col,
                                            x: toProto(wp.x), y: toProto(wp.y) }, 60000);
      if (hop?.hopped) {
        pos = await look();
        const nx = pos?.x != null ? toClient(pos.x) : null, ny = pos?.y != null ? toClient(pos.y) : null;
        off = nx == null ? off : Math.hypot(nx - wp.x, ny - wp.y) / F;
        hBody = nx == null ? hBody : R.floorAt(nx, ny);
        hops++;
        console.log(`  leg ${li + 1}  hopped past a block at waypoint ${wi + 1}: ` +
                    `${hop.span_squares} squares, floor ${hop.from_floor} -> ${hop.landed_floor}`);
      } else if (hop?.reason && !/too far|past a step/.test(String(hop.reason))) {
        // A refusal on distance or height is the guard doing its job and is not worth saying.
        console.log(`  leg ${li + 1}  hop declined at waypoint ${wi + 1}: ${String(hop.reason).slice(0, 90)}`);
      }
    }
    // A FALL IS A DROP FROM WHERE THE BODY JUST WAS, NOT A DIFFERENCE FROM A WAYPOINT IT HAS
    // NOT REACHED YET.
    //
    // Waypoints are DECIMATED — kept on a heading change or every three quarters of a square —
    // so two consecutive ones are several flood-steps apart and legitimately differ by more
    // than one step-height. Judging the body against the NEXT waypoint's floor called the
    // Ancient Place staircase a fall at every tread: 6208 -> 6560 -> 6896 -> 7600 rises 352 a
    // step and the kept waypoints jump 704 at a time. The climb was working and the instrument
    // was stopping it.
    //
    // Against the body's own last floor, a tread reads as the climb it is and only a real drop
    // — the gully is thousands below the shelf — trips it.
    const fell = hBody != null && lastFloor != null && lastFloor - hBody > 1000;
    void hWant;
    if (fell) {
      console.log(`  leg ${li + 1}  FELL OFF at waypoint ${wi + 1}/${leg.waypoints.length}: ` +
                  `floor ${lastFloor} -> ${hBody}, body at r${pos.row}c${pos.col} ` +
                  `floor ${hBody} — ${off.toFixed(1)} squares away but ${hBody - hWant} below/above it`);
      console.log(`           the mover said: ${JSON.stringify(w).slice(0, 300)}`);
      came_off = { leg: li + 1, waypoint: wi + 1, asked: wp, got: { ...pos }, off, hBody, hWant };
      break outer;
    }
    if (hBody != null) lastFloor = hBody;
    if (off > TOL) {
      console.log(`  leg ${li + 1}  CAME OFF at waypoint ${wi + 1}/${leg.waypoints.length}: ` +
                  `asked r${wp.row}c${wp.col} (fine ${wp.x},${wp.y}), body at ` +
                  `r${pos.row}c${pos.col} (fine ${cx},${cy}) — ${off.toFixed(1)} squares off`);
      console.log(`           the mover said: ${JSON.stringify(w).slice(0, 220)}`);
      came_off = { leg: li + 1, waypoint: wi + 1, asked: wp, got: { ...pos }, off };
      break outer;
    }
  }
  console.log(`  leg ${li + 1}  walk ${leg.waypoints.length} waypoint(s) -> r${pos.row}c${pos.col}`);
}

const end = await look();
const arrived = end.room === ROOM && Math.abs(end.row - toRow) < 3 && Math.abs(end.col - toCol) < 3;
console.log('');
console.log(`${arrived ? 'ARRIVED' : 'did not arrive'} — r${end.row}c${end.col} in room ${end.room}, ` +
            `hp ${end.hp}, ${Math.round((Date.now() - t0) / 1000)}s` +
            (hops ? `, ${hops} hop(s) round something in the way` : '') +
            (end.node ? `\n  sees "${end.node.name}" at r${end.node.row}c${end.node.col}, ${end.node.distance} away` : ''));
if (came_off) console.log(`  came off at leg ${came_off.leg}` +
                          (came_off.waypoint ? ` waypoint ${came_off.waypoint}` : ''));
process.exit(arrived ? 0 : 1);
