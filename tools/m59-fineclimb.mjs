#!/usr/bin/env node
// FOLLOW A FINE ROUTE EXACTLY, OR STOP AND SAY WHERE IT CAME OFF.
//
//   node tools/m59-fineclimb.mjs --agent shadow01 --to 52,30
//   node tools/m59-fineclimb.mjs --agent shadow01 --to 52,30 --dry-run
//   node tools/m59-fineclimb.mjs --agent shadow01 --room 589 --to 45,32 --port 8971
//
// `--to` is `row,col` (KOD/RoomGeometry order), like every other geometry tool here.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = (n, d = null) => {
  const at = argv.indexOf('--' + n);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
};
const KNOWN = new Set(['agent', 'room', 'to', 'port', 'fleet', 'dry-run', 'tolerance',
                       'steps', 'stride', 'max-jumps', 'allow-candidates', 'help']);
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
if (!AGENT || !TO) { console.error('fineclimb: need --agent and --to row,col'); process.exit(2); }
const [toRow, toCol] = TO.split(',').map(Number);
if (!Number.isFinite(toRow) || !Number.isFinite(toCol)) {
  console.error('fineclimb: --to must be row,col'); process.exit(2);
}

const F = 1024;
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
const plan = R.plan(fromPt, { row: toRow, col: toCol },
                    { maxJumps: Number(flag('max-jumps', 4)),
                      allowCandidates: has('allow-candidates') });
const total = (plan.legs ?? []).filter(l => l.kind === 'walk')
  .reduce((a, l) => a + l.waypoints.length, 0);
console.log(`room ${ROOM} — ${R.room.name}`);
console.log(`${AGENT} at r${at0.row}c${at0.col} hp ${at0.hp} -> r${toRow}c${toCol}`);
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
let came_off = null, pos = at0;
outer:
for (const [li, leg] of plan.legs.entries()) {
  if (leg.kind === 'jump') {
    const j = await call('jump', { agent: AGENT, to_row: leg.to.row, to_col: leg.to.col }, 60000);
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
                                      max_steps: STEPS, stride: STRIDE }, 60000);
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
    const off = (cx == null) ? 0 : Math.hypot(cx - wp.x, cy - wp.y) / F;
    const hBody = cx == null ? null : R.floorAt(cx, cy);
    const hWant = R.floorAt(wp.x, wp.y);
    const fell = hBody != null && hWant != null && Math.abs(hBody - hWant) > 384;
    if (fell) {
      console.log(`  leg ${li + 1}  FELL OFF at waypoint ${wi + 1}/${leg.waypoints.length}: ` +
                  `asked r${wp.row}c${wp.col} floor ${hWant}, body at r${pos.row}c${pos.col} ` +
                  `floor ${hBody} — ${off.toFixed(1)} squares away but ${hBody - hWant} below/above it`);
      came_off = { leg: li + 1, waypoint: wi + 1, asked: wp, got: { ...pos }, off, hBody, hWant };
      break outer;
    }
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
            (end.node ? `\n  sees "${end.node.name}" at r${end.node.row}c${end.node.col}, ${end.node.distance} away` : ''));
if (came_off) console.log(`  came off at leg ${came_off.leg}` +
                          (came_off.waypoint ? ` waypoint ${came_off.waypoint}` : ''));
process.exit(arrived ? 0 : 1);
