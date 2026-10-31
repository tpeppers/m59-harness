#!/usr/bin/env node
// LEARN THE UKGOTH JUMP BY DOING IT TWO HUNDRED TIMES AND WRITING DOWN WHAT HAPPENED.
//
//   node tools/m59-jumptrial.mjs --fleet shadow --rounds 3
//   node tools/m59-jumptrial.mjs --fleet shadow --strategies baseline,strafe_w,clear --rounds 5
//   node tools/m59-jumptrial.mjs --report            # just read the ledger back
//
// The declared fall-jump at 36,16 -> 38,10 is the one move on the road to Castle Victoria
// that cannot be walked, and missing it is not a slow crossing — it is terminal. The body
// lands on the gulley floor at 3200, the shelf it wanted is at 3840, and 640 units of rise
// against a 384 step limit means there is no way back up. From in there the strict geometry
// reaches 681 squares and neither Castle Victoria nor the Cragged Mountains is among them.
//
// WHY A HARNESS RATHER THAN A FIX. The obstacle is not geometry, which is fixed and known,
// but TRAFFIC: Ukgoth accumulates trolls, and a Guardian of Zjiria standing on the landing
// is a moving target that a static route cannot plan around. So the question is not "what is
// the right line" but "which approach succeeds most often against a room that will not hold
// still", and that is a measurement, not an argument.
//
// THE SHAPE, which is the operator's:
//
//   * every character waits on its own safe spot, queued back from the take-off, so a
//     character waiting its turn is not itself part of the traffic;
//   * ONE goes forward at a time, attempts the jump under a named strategy, and is sent back
//     to its spot whether it made it or not;
//   * every attempt records what was in the way and whether the thing in the way was MOVING,
//     because "a troll was there" and "a troll walked into me" want different answers.
//
// The ledger is substrate/jumptrials.jsonl, append-only, one line per attempt. It never
// records a character name — see the redaction note on `line()`.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { safeSpots } from './m59-safespots.mjs';
import { rosterGameEndpoint } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const sub = (...p) => join(REPO, 'substrate', ...p);
const LEDGER = sub('jumptrials.jsonl');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = n => argv.includes('--' + n);
const KNOWN = new Set(['fleet', 'port', 'rounds', 'strategies', 'agents', 'room',
                       'report', 'dry-run', 'walk', 'sweep', 'no-evacuate', 'help', 'h']);
for (const a of argv) if (a.startsWith('--') && !KNOWN.has(a.slice(2))) {
  console.error(`m59-jumptrial: unknown option ${a}`);
  console.error(`known: ${[...KNOWN].map(k => '--' + k).join(' ')}`);
  process.exit(2);
}

const ROOM = Number(flag('room', 599));
const PORT = Number(flag('port', 8971));
const ROUNDS = Number(flag('rounds', 3));
const DRY = has('dry-run');
const WALK = has('walk');
const FLEET = flag('fleet', process.env.M59_FLEET
  ?? (() => { try { return readFileSync(sub('fleet-default'), 'utf8').trim(); } catch { return '-'; } })());
const ONLY = flag('agents') ? String(flag('agents')).split(',').map(x => x.trim()).filter(Boolean) : null;

// ---------------------------------------------------------------- the strategies
//
// Each says where to take off from and where to aim. `wait` is the only one that looks at the
// room before committing; the rest are deliberately blind, so the difference between them and
// `clear` measures what LOOKING is worth rather than what a different line is worth.
//
// The take-off alternatives are all on the same ledge and the same floor as 36,16 — verified
// against floorBaseAtClient, not guessed — so every one of them is a jump somebody could
// actually stand and make, not a new claim about the map.
// MEASURED, AND THE GEOMETRY QUESTION IS CLOSED.
//
// The first hundred attempts settled it. By take-off square, jumps actually attempted:
//
//     36,16    9 jumps, 9 made, 100%   landed 39,12 every time
//     35,16    3 jumps, 0 made,   0%   landed 38,13, the gulley
//     37,15    3 jumps, 0 made,   0%   landed 38,13
//
// and with a clear line, 9 of 9. With anything on the line, 0 of 6. So there is nothing left
// to tune about WHERE to jump from: the operator declared 36,16 by walking it, and a square
// either side — same ledge, same floor, one step — never clears the gulley. Aiming a square
// short of the landing is fine, so it is the TAKE-OFF that is exact, not the target.
//
// `strafe_n` and `strafe_s` are kept as controls rather than deleted. They cost six attempts
// a run and they are the evidence that the declared square matters; a refuted idea that
// leaves no trace gets re-proposed.
//
// What is left is TIMING, because the only thing that fails a jump from 36,16 is something
// standing on the line. These vary how long to wait and how strict to be about 'clear'.
// RE-KEYED 2026-10-31 (docs/falljump-audit-2026-10-31.md): the declaration is now r37c14 -> r39c12,
// where the take-off ledge runs out past wall 39, and the jump verb only flies a declared jump from
// within one square of its take-off. The strategies below were MEASURED from r36c16 -> r38c10 and
// the figures quoted in this file are about that pair; they now run against the new one. The two
// strafe controls keep their old squares as recorded experiments: strafe_n (35,16) is outside the
// new neighbourhood and will be refused as undeclared, which is the honest answer.
const STRATEGIES = {
  baseline:  { from: { row: 37, col: 14 }, to: { row: 39, col: 12 },
               why: 'the declared jump, blind — jumps into whatever is there' },
  land_wide: { from: { row: 37, col: 14 }, to: { row: 39, col: 11 },
               why: 'a square short of the declared landing, same shelf — 100% so far' },
  clear1:    { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, wait: 1, patience: 0,
               why: 'jump unless something is ON the line — the loosest useful gate' },
  patient:   { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, wait: 2, patience: 20,
               why: 'wait up to 20s for a 2-square gap, then take it anyway' },
  // THE ADAPTIVE ONE, AND THE ONE MOST LIKELY TO BEAT A CROWDED ROOM: do not pick the landing
  // in advance. Raycast to every square of the shelf at the moment of the jump and take the
  // line with the most clearance from whatever is standing under the drop. A fixed target is
  // a bet that the room will be empty where you aimed; this is a choice made with the room in
  // front of you.
  pick_clear: { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, candidates: true, wait: 1, patience: 6,
               why: 'raycast every shelf square and jump at whichever line is clearest' },
  // BOTH LEVERS AT ONCE. The two that work do different things: waiting gets a clear line and
  // a clear line is worth ~100%, while re-aiming is the only thing that survives a line that
  // never clears. Neither alone reached both of the operator's targets — patient went 5/5
  // clean and 0/3 blocked, pick_clear 13/16 clean and 2/3 blocked — so this waits as long as
  // patient does and then, instead of jumping into whatever is left, re-aims at the clearest
  // landing the shelf offers.
  // WAIT AT A WALL, FOR AS LONG AS IT TAKES, AND ONLY THEN STEP OUT AND JUMP.
  //
  // The operator's argument, and the arithmetic is plainly right: a missed jump costs a whole
  // lap of Ukgoth — the pit is one-way, so recovering means walking the cycle round — while
  // waiting costs seconds. Thirty seconds of standing still is cheap against that, and the
  // present numbers make the case: with the room crowded, every blind strategy went to ZERO.
  //
  // Two details make it work. The character does NOT need line of sight to the pit: `look`
  // reports every object in the room with coordinates, so it can watch from anywhere. And it
  // waits at 37,14 — two squares from the take-off, two walls against it and three refused
  // approaches, the best-covered square on the plateau — rather than on the take-off itself,
  // which is exposed and is where the survival ladder keeps dragging characters off.
  //
  // Only when the line is clear does it step to the ledge and go, so the exposed moment is
  // one step and one jump instead of a minute of standing in the open.
  // WAIT ON THE EXTENSION OF THE JUMP LINE, SO THE JUMP IS A RUN THAT NEVER TURNS.
  //
  // The operator's refinement, and it is the better idea: `step()` turns to face its
  // destination before it moves, so a wait square off to one side makes the jump a stop, a
  // ninety-degree turn and a standing start. Waiting BEHIND the take-off on the same line
  // makes it one continuous run through the ledge and off it, which is how a person does it.
  //
  // Extending the line backward from 36,16 away from 38,10 and measuring every square on it:
  //
  //     35,19   0 deg off the line   walkable, plateau, but NO walls — exposed
  //     34,21   3 deg off the line   walkable, plateau, FOUR walls  <- cover and a straight run
  //     34,22   0 deg off the line   not walkable, off the plateau
  //
  // 34,21 is the one that is both: five squares back, almost exactly in line, and the
  // best-covered square on the plateau. It waits there until the line clears and then runs.
  // NO THRESHOLD, JUST THE BEST LINE AVAILABLE — because the threshold was unreachable.
  //
  // A Guardian of Zjiria camps on 38,13, stationary, directly under the flight path. Measured
  // against its actual position and the two trolls beside it, over every take-off x landing
  // pair the guard permits:
  //
  //     best of all 66 lines   35,16 -> 38,9    1.58 squares of clearance
  //     the declared line      36,16 -> 38,10   0.95
  //     lines clearing it by more than 2 squares:  NONE
  //
  // So every strategy that waits for a 2-square gap waits for something that cannot happen —
  // `hold_wall` sat behind its wall for 45 seconds, 12 times, and never once saw a clear line.
  // Waiting is right when the obstacle MOVES; this one does not.
  //
  // This takes the maximum-clearance line unconditionally and goes. It is the honest answer
  // to a camped obstacle: there is no clean jump to be had, so take the least dirty one.
  best_line: { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, candidates: true,
               wait: 1, patience: 0, alwaysJump: true,
               why: 'no gate: always jump at whichever line has the most clearance' },
  hold_wall: { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, candidates: true,
               wait: 2, patience: 45, waitAt: { row: 34, col: 21 },
               why: 'wait behind cover at 34,21, on the jump line, then run through and jump' },
  hybrid:    { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, candidates: true, wait: 2, patience: 20,
               why: 'wait up to 20s for a 2-square gap, then re-aim at the clearest shelf square' },
  clear:     { from: { row: 37, col: 14 }, to: { row: 39, col: 12 }, wait: 3, patience: 0,
               why: 'declines outright unless 3 squares of the line are clear' },
  strafe_n:  { from: { row: 35, col: 16 }, to: { row: 38, col: 10 },
               why: 'CONTROL: one square north — refuted, 0 of 3' },
  strafe_s:  { from: { row: 37, col: 15 }, to: { row: 38, col: 10 },
               why: 'CONTROL: one square south-west — refuted, 0 of 3' },
};
// A GEOMETRY SWEEP, GATED ON A CLEAR LINE — because the first attempt to answer this could
// not have.
//
// The refutation of strafing was worthless and I should not have drawn it: all six
// non-declared take-offs had something on the line, and a blocker is 0% from ANY square. So
// the geometry question had zero unconfounded attempts behind it, and the operator was right
// to say the geometry can probably vary.
//
// `--sweep` generates every take-off x landing pair the jump verb accepts — one square either
// way at both ends, on the two right floors, six by six — and gates every one of them on a
// clear line, so what varies is the geometry and nothing else. That is the experiment the
// question actually needs.
function sweepStrategies() {
  const F = (r, c) => { try { const pt = geo.standPoint(r, c); return pt ? geo.floorBaseAtClient(pt.x, pt.y) : null; } catch { return null; } };
  const same = (a, b) => a != null && b != null && Math.abs(a - b) <= 64;
  const TF = F(36, 16), LF = F(38, 10);
  const out = {};
  for (let r = 35; r <= 37; r++) for (let c = 15; c <= 17; c++) {
    if (!same(F(r, c), TF) || geo.walkable(r, c) !== true) continue;
    for (let lr = 37; lr <= 39; lr++) for (let lc = 9; lc <= 11; lc++) {
      if (!same(F(lr, lc), LF)) continue;
      out[`${r},${c}->${lr},${lc}`] = {
        from: { row: r, col: c }, to: { row: lr, col: lc }, wait: 1, patience: 8,
        why: 'sweep: waits up to 25s for a clear line so the GEOMETRY is what is measured',
      };
    }
  }
  return out;
}

// NORTH OF THE LEDGE, ON THE SAME PLATEAU. The operator's own staging ground: everything
// here is floor 5872 and everything here can reach the take-off. Anything at row 38 or more
// is below the drop and cannot get back.
const STAGE = { row: 32, col: 19 };

// THE SHELF, AS THE OPERATOR DESCRIBES IT. All six measure floor 3840, the declared landing's
// own floor; 38,13 beside them is 3200 and is the gulley every miss ends in.

const DEFAULT_SET = ['best_line', 'pick_clear', 'baseline'];
// `sweepStrategies` reads the room geometry, which is loaded further down, so the sweep is
// applied there rather than here. A const that needs a value that does not exist yet is the
// kind of ordering bug that reads as an empty strategy list.
let CHOSEN = (flag('strategies') ? String(flag('strategies')).split(',') : DEFAULT_SET)
  .map(x => x.trim()).filter(Boolean);
for (const n of (has('sweep') ? [] : CHOSEN)) if (!STRATEGIES[n]) {
  console.error(`m59-jumptrial: no strategy "${n}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
  process.exit(2);
}

// ---------------------------------------------------------------- plumbing

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
        let text = null;
        try { text = JSON.parse(t).result.content[0].text; }
        catch { return done({ _error: `no result from ${name}` }); }
        try { done(JSON.parse(text)); }
        catch { done({ _error: String(text).trim().slice(0, 160) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.on('error', e => done({ _error: e.message }));
    req.end(body);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dist = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

// Same ledge, not merely nearby: two squares a step apart can be a cliff apart. This is the
// same floor test the `jump` verb's guard uses, and it is what makes "one square over" mean
// a variation of the jump rather than a different drop.
function floorAt(row, col) {
  try { const pt = geo.standPoint(row, col); return pt ? geo.floorBaseAtClient(pt.x, pt.y) : null; }
  catch { return null; }
}
function sameFloorAs(a, b) {
  const x = floorAt(a.row, a.col), y = floorAt(b.row, b.col);
  return x != null && y != null && Math.abs(x - y) <= 64;
}

// Distance from a point to the take-off -> landing segment, in squares. What "on the line"
// means, and it is the number the collision column is built on.
function distToLine(p, a, b) {
  const vx = b.col - a.col, vy = b.row - a.row;
  const wx = p.col - a.col, wy = p.row - a.row;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(a.col + t * vx - p.col, a.row + t * vy - p.row);
}

// A LEDGER THAT NEVER NAMES A CHARACTER. The same rule m59-roomview.mjs follows and
// bard-guard.mjs enforces one repository over: the finding is which STRATEGY works, and a
// name adds nothing to it while being the one thing that must not leave this machine.
function line(row) {
  const { character, ...rest } = row;
  if (!DRY) appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), ...rest }) + '\n');
  return rest;
}

// ---------------------------------------------------------------- report

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function report(rows) {
  if (!rows.length) { console.log(''); console.log('no attempts on record yet.'); return; }

  // A JUMP AND A FAILURE TO GET TO THE JUMP ARE DIFFERENT MEASUREMENTS.
  //
  // The first version counted 'never got on the ledge' as a missed jump, which made the
  // declared take-off look like it failed a third of the time when it had not failed once.
  // Twelve of the first thirty records were approach failures. The approach is a real
  // problem — Ukgoth's traffic between the queue and the ledge — but it is not this
  // question, and averaging the two together answers neither.
  // Records written before `outcome` existed are still evidence; the kind is recoverable
  // from what they do carry. A ledger that quietly drops its own older half is worse than one
  // that has to work a little to read it.
  const kindOf = r => r.outcome
    ?? (r.declined ? 'declined'
      : r.landed ? (r.made ? 'made' : 'missed')
      : /not on the ledge|never reached/.test(r.note ?? '') ? 'no_approach'
      : /left the ledge|drifted/.test(r.note ?? '') ? 'left_ledge'
      : 'no_jump');
  const jumped = rows.filter(r => ['made', 'missed'].includes(kindOf(r)));
  const approach = rows.filter(r => ['no_approach', 'left_ledge'].includes(kindOf(r)));
  const declined = rows.filter(r => kindOf(r) === 'declined');
  console.log('');
  console.log(rows.length + ' record(s): ' + jumped.length + ' actual jump(s), ' +
              approach.length + ' never reached the ledge, ' + declined.length + ' declined');
  console.log('');
  const by = {};
  for (const r of jumped) {
    const k = r.strategy ?? '?';
    by[k] ??= { n: 0, made: 0, blocked: 0, moving: 0, still: 0, byWhat: {} };
    const b = by[k];
    b.n++; if (r.made) b.made++;
    if (r.collided) {
      b.blocked++; b[r.collided.moving ? 'moving' : 'still']++;
      const w = r.collided.name ?? '?';
      b.byWhat[w] = (b.byWhat[w] || 0) + 1;
    }
  }
  console.log('  OF THE JUMPS ACTUALLY ATTEMPTED');
  console.log('  strategy     jumps   made    rate   blocked   the blocker was');
  for (const [k, b] of Object.entries(by).sort((x, y) => y[1].made / y[1].n - x[1].made / x[1].n)) {
    const what = Object.entries(b.byWhat).sort((x, y) => y[1] - x[1])
      .map(([n, c]) => n + ' x' + c).join(', ') || '-';
    console.log('  ' + k.padEnd(12) + String(b.n).padStart(6) + String(b.made).padStart(7) +
                String(Math.round(100 * b.made / b.n) + '%').padStart(8) +
                String(b.blocked).padStart(10) + '   ' + what +
                (b.blocked ? '  (' + b.moving + ' moving, ' + b.still + ' still)' : ''));
  }

  // BY THE SQUARE IT ACTUALLY LEFT FROM, which is the question worth asking of a jump: the
  // take-off is exact even when the aim is not, and this is where that shows.
  const bySquare = {};
  for (const r of jumped) {
    const k = r.took_off_from ?? '?';
    bySquare[k] ??= { n: 0, made: 0, lands: {} };
    bySquare[k].n++; if (r.made) bySquare[k].made++;
    const l = r.landed ?? '-';
    bySquare[k].lands[l] = (bySquare[k].lands[l] || 0) + 1;
  }
  console.log('');
  console.log('  BY TAKE-OFF SQUARE');
  console.log('  from      jumps   made    rate   landed');
  for (const [k, b] of Object.entries(bySquare).sort((x, y) => y[1].made / y[1].n - x[1].made / x[1].n)) {
    const lands = Object.entries(b.lands).sort((x, y) => y[1] - x[1])
      .map(([l, c]) => l + ' x' + c).join(', ');
    console.log('  ' + k.padEnd(9) + String(b.n).padStart(6) + String(b.made).padStart(7) +
                String(Math.round(100 * b.made / b.n) + '%').padStart(8) + '   ' + lands);
  }
  console.log('');
  const blocked = jumped.filter(r => r.collided);
  if (blocked.length) {
    const moving = blocked.filter(r => r.collided.moving).length;
    console.log('  of ' + blocked.length + ' jumps with something on the line, ' + moving +
                ' blockers were MOVING and ' + (blocked.length - moving) + ' standing still; ' +
                blocked.filter(r => r.made).length + ' made it anyway.');
  }
  const clean = jumped.filter(r => !r.collided);
  if (clean.length)
    console.log('  with a clear line, ' + clean.filter(r => r.made).length + ' of ' + clean.length +
                ' made it (' + Math.round(100 * clean.filter(r => r.made).length / clean.length) + '%).');
  if (approach.length)
    console.log('  the approach failed ' + approach.length + ' time(s) — Ukgoth between the queue ' +
                'and the ledge, which is a different problem from the jump.');
}
if (has('report')) { report(readLedger()); process.exit(0); }

// ---------------------------------------------------------------- setup

const rosterFile = FLEET === '-' ? sub('fleet-state.json') : sub('fleets', `${FLEET}.json`);
const rostered = rosterGameEndpoint(rosterFile);
if (!rostered) { console.error(`m59-jumptrial: ${rosterFile} does not name one game server.`); process.exit(2); }
if (!LOOPBACK.has(rostered.host.toLowerCase())) {
  console.error(`m59-jumptrial: REFUSING. Fleet "${FLEET}" is on ${rostered.host}, not loopback.`);
  console.error('          This deliberately walks characters off a cliff, repeatedly.');
  process.exit(2);
}

const world = JSON.parse(readFileSync(sub('m59-map.json'), 'utf8'));
try { attachStepMasks(world); } catch {}
const room = world.rooms[String(ROOM)];
if (!room) { console.error(`m59-jumptrial: no room ${ROOM}`); process.exit(1); }
const geo = sharedRoomGeometry(room);

if (has('sweep')) {
  const swept = sweepStrategies();
  Object.assign(STRATEGIES, swept);
  CHOSEN = Object.keys(swept);
  if (!CHOSEN.length) { console.error('m59-jumptrial: the sweep produced no pairs'); process.exit(1); }
}

const jumps = (JSON.parse(readFileSync(sub('m59-falljumps.json'), 'utf8')).jumps ?? [])
  .filter(j => Number(j.room) === ROOM);
if (!jumps.length) { console.error(`m59-jumptrial: room ${ROOM} declares no fall-jump`); process.exit(1); }

const fleetNow = await call('fleet', {});
if (fleetNow._error) { console.error(`m59-jumptrial: broker on ${PORT} did not answer (${fleetNow._error})`); process.exit(1); }
let agents = (fleetNow.fleet ?? []).filter(r => r.agent && r.character);
if (ONLY) agents = agents.filter(r => ONLY.includes(r.agent) || ONLY.includes(r.character));
agents.sort((a, b) => a.agent.localeCompare(b.agent, 'en', { numeric: true }));
if (!agents.length) { console.error('m59-jumptrial: no characters matched.'); process.exit(1); }

// THE QUEUE, AND WHY IT IS NOT MADE OF SAFE SPOTS.
//
// The obvious design — and the one this started with — is one character per safe spot, queued
// back from the take-off. It does not work, and the reason is a property of what a safe spot IS.
//
// A safe wall is a square where the two grids DISAGREE: the BSP admits a body, the coarse grid
// the monsters path on refuses it. That is the whole mechanism. But the strict predicate — the
// one that matches what a walker can actually do — also requires a coarse-walkable destination.
// So a safe spot is, by construction, an ISLAND to it. Measured on the ten spots this tool
// first chose: seven strictly reach exactly ONE square, their own.
//
// Parked there, a character cannot walk to the ledge at all. The permissive predicate says it
// can — `moverStepLands` gates on `standable`, and that is true for all 4,686 squares in this
// room — so the walker sets off, meets a wall the model does not have, and grinds along it.
// Watched from the client: bodies hugging the EAST wall while the jump is to the south-west.
//
// So the queue is ordinary connected ground that STRICTLY reaches the take-off, and among
// those the squares with the most walls against them: defensible AND reachable, rather than
// defensible and marooned.
const takeoff = STRATEGIES[CHOSEN[0]].from;

function strictReach(from) {
  const seen = new Set([from.row * 1000 + from.col]);
  let frontier = [from];
  const R = room.rows, C = room.cols;
  while (frontier.length) {
    const next = [];
    for (const p of frontier)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = p.row + dr, nc = p.col + dc;
        if (nr < 1 || nc < 1 || nr > R || nc > C) continue;
        const k = nr * 1000 + nc;
        if (seen.has(k) || geo.walkable(nr, nc) !== true) continue;
        let ok = false;
        try { ok = geo._traceMoverStep(p.row, p.col, nr, nc); } catch {}
        if (!ok) continue;
        seen.add(k); next.push({ row: nr, col: nc });
      }
    frontier = next;
  }
  return seen;
}

// AND THE ONE THAT MATTERS: WHICH SQUARES CAN REACH THE TAKE-OFF.
//
// `strictReach` answers what the take-off can reach, and on one-way terrain that is a
// DIFFERENT SET — the operator has had to correct me on this exact confusion once already.
// Measured here: 1071 squares are reachable FROM 36,16, 1381 can reach it, and only 390 do
// both. Three of the five queue squares this tool first chose could not reach the take-off
// at all, and neither could a single one of the places relocate actually drops people:
// 41,14 / 44,10 / 46,7 / 47,11 are all below the ledge, and below the ledge is one-way.
//
// So a waiting room has to be in the BOTH-WAYS set, and a drop is only usable if it lands
// somewhere that can still get to the ledge.
function reverseReach(to) {
  const seen = new Set([to.row * 1000 + to.col]);
  let frontier = [to];
  const R = room.rows, C = room.cols;
  while (frontier.length) {
    const next = [];
    for (const p of frontier)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const q = { row: p.row + dr, col: p.col + dc };
        if (q.row < 1 || q.col < 1 || q.row > R || q.col > C) continue;
        const k = q.row * 1000 + q.col;
        if (seen.has(k) || geo.walkable(q.row, q.col) !== true) continue;
        let ok = false;
        try { ok = geo._traceMoverStep(q.row, q.col, p.row, p.col); } catch {}
        if (!ok) continue;                       // q -> p is the direction that matters
        seen.add(k); next.push(q);
      }
    frontier = next;
  }
  return seen;
}

// THE SHELF, BUILT AFTER THE GEOMETRY EXISTS.
//
// This list used to be declared beside STAGE, above `const geo = sharedRoomGeometry(room)`,
// and its floor filter therefore ran against `geo` in the temporal dead zone. The throw was
// caught, every candidate was dropped, and SHELF came out EMPTY — so `best_line` and
// `pick_clear` had nothing to choose between and aimed at the declared landing every single
// time. Twenty-one attempts of a strategy whose entire purpose is to choose, choosing
// nothing, and reporting a plausible number while doing it.
//
// 38,9 / 39,9 / 39,10 are the westward squares that matter: west leads AWAY from the pit the
// blockers stand in, and measured against the Guardian camped on 38,13, from 36,16, 38,9
// clears it by 1.10 squares against 38,10's 0.95.
const SHELF = [
  { row: 38, col:  9 }, { row: 38, col: 10 }, { row: 38, col: 11 }, { row: 38, col: 12 },
  { row: 39, col:  9 }, { row: 39, col: 10 }, { row: 39, col: 11 }, { row: 39, col: 12 },
  { row: 40, col: 12 },
].filter(sq => {
  try {
    const a = geo.standPoint(38, 10), b = geo.standPoint(sq.row, sq.col);
    if (!a || !b) return false;
    return Math.abs(geo.floorBaseAtClient(a.x, a.y) - geo.floorBaseAtClient(b.x, b.y)) <= 64
           && geo.walkable(sq.row, sq.col) === true;
  } catch { return false; }
});
if (!SHELF.length) { console.error('m59-jumptrial: the shelf came out empty — refusing to run blind'); process.exit(1); }
console.log(`shelf: ${SHELF.length} landing candidate(s) — ${SHELF.map(x => x.row + ',' + x.col).join(' ')}`);

const connected = strictReach(takeoff);
const canReach = reverseReach(takeoff);
const coverAt = (r, c) => {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    if (geo.walkable(r + dr, c + dc) !== true) n++;
  }
  return n;
};
const candidates = [];
for (const k of connected) {
  if (!canReach.has(k)) continue;            // a waiting room you cannot leave is a cell
  const r = Math.floor(k / 1000), c = k % 1000;
  const d = dist({ row: r, col: c }, takeoff);
  if (d < 3 || d > 16) continue;
  // ON THE PLATEAU. A waiting square below the drop is a cell, however well covered.
  if (!sameFloorAs({ row: r, col: c }, takeoff)) continue;
  candidates.push({ row: r, col: c, d, cover: coverAt(r, c) });
}
candidates.sort((a, b) => b.cover - a.cover || a.d - b.d);
const spots = candidates.slice(0, Math.max(agents.length, 8));
console.log(`queue: ${connected.size} reachable from the take-off, ${canReach.size} can reach it, ` +
            `${candidates.length} do both at 3-16 away; taking ${spots.length}`);

const queue = agents.map((a, i) => ({ ...a, spot: spots[i % Math.max(1, spots.length)] }));

console.log(`fleet "${FLEET}" -> ${rostered.host}:${rostered.port}`);
console.log(`room ${ROOM} (${room.name}), ${agents.length} character(s), ${ROUNDS} round(s)`);
console.log(`strategies: ${CHOSEN.join(', ')}`);
for (const n of CHOSEN) {
  const st = STRATEGIES[n];
  console.log(`  ${n.padEnd(11)} ${st.from.row},${st.from.col} -> ${st.to.row},${st.to.col}` +
              (st.wait ? `  (waits for a clear ${st.wait}-square line)` : '') + `  — ${st.why}`);
}
console.log();
if (DRY) {
  for (const q of queue)
    console.log(`  ${q.character.padEnd(8)} waits at ${q.spot ? q.spot.row + ',' + q.spot.col : '(nowhere)'}`);
  process.exit(0);
}

const dm = await import('./m59-dm.mjs');

// ---------------------------------------------------------------- one attempt

// SOMETHING IN THE PIT *IS* IN THE WAY, AND THE MEASUREMENT SAYS SO.
//
// This filtered out anything standing on the gulley floor, on the reasoning that a jump which
// clears the pit passes over their heads. It is wrong, and the experiment that assumed it is
// what proved it: with pit occupants no longer counted, the jumps that were reclassified as
// having a "clear line" FAILED — pick_clear went 8/27 to 1/16 and its clear-line rate to 0/9.
//
// The reason is the trace rather than the altitude. The line from 36,16 to 38,10 passes
// directly over 38,13, and a falling body is clipped by an object in a square it passes
// THROUGH, not merely one it lands on: every such attempt reported `object_blocked` and ended
// at 38,13, in the pit, on top of the troll that stopped it.
//
// So the filter is inert now and the flag it computes is kept only as evidence. If it is ever
// re-proposed, this is the run that refutes it.
const LEDGE_FLOOR = () => floorAt(36, 16);
const SHELF_FLOOR = () => floorAt(38, 10);
function inFlightPath(o) {
  return true;                                 // everything counts — see the note above
}

async function observe(agent) {
  const l = await call('look', { agent });
  if (l._error) return null;
  const objects = (l.objects ?? []).filter(o => !o.is_player || o.is_player === false);
  return { me: l.you, objects, atHeight: objects.filter(inFlightPath) };
}

async function attempt(q, name) {
  const st0 = STRATEGIES[name];
  const st = { ...st0 };
  const out = { character: q.character, strategy: name,
                from: `${st.from.row},${st.from.col}`, to: `${st.to.row},${st.to.col}` };

  // 1. GET ONTO THE TAKE-OFF SQUARE, AND DO NOT LET THE WALK BE THE EXPERIMENT.
  //
  // The first version walked there and six of fifteen attempts never arrived — so most of
  // what it measured was Ukgoth's traffic between the queue and the ledge, which is a real
  // problem and a DIFFERENT one. This is about the jump. So the body is placed on the square
  // (lab server, DM powers) and `--walk` opts back into walking for anyone who wants to
  // measure the approach instead. Which one happened is recorded either way.
  // WHOLE BEFORE EVERY ATTEMPT, VIGOR INCLUDED — see the note at the queue placement. A
  // declared fall-jump requires RUNNING and running is paid for in vigor; a character on
  // 1/200 cannot make a jump that has nothing to do with its legs being tired in any way the
  // trial is trying to measure. Recycling five characters six times without this is what took
  // the success rate from 85% to 0%.
  await dm.heal([q.character]).catch(() => null);
  out.approach = WALK ? 'walked' : 'placed';
  if (WALK) {
    const walk = await call('walk_to', { agent: q.agent, col: st.from.col, row: st.from.row }, 120000);
    if (walk?._error) out.walk_error = walk._error;
  } else {
    // RELOCATE PUTS YOU NEAR, NEVER ON. `UtilGoNearSquare` is documented in CLAUDE.md as the
    // call that never says no; what it does not do is land you on the square you asked for —
    // measured here at 35,21 / 29,19 / 34,21 for a request of 36,16. So the DM call gets the
    // body into the neighbourhood and a SHORT walk finishes it. That walk is a few squares on
    // one ledge rather than a crossing of Ukgoth, which is the confound this avoids.
    // AIM THE DROP NORTH OF THE LEDGE, NOT AT IT.
    //
    // Aiming at the take-off itself was the mistake. `UtilGoNearSquare` scatters, and from
    // 36,16 it scatters SOUTH — 41,14 / 44,10 / 46,7 / 47,11 — which is the region BELOW the
    // drop, and below the drop is one-way. Not one of those squares can reach the take-off
    // again, so the body was being teleported into the trap the jump exists to clear, eight
    // times in a row, which is what the operator was watching when the bots looked like they
    // were aiming at 42,14.
    //
    // The staging ground is north of the ledge and on the same plateau: 30,18 / 31,18 /
    // 32,19 / 33,19 / 34,18 are all floor 5872, the take-off's own floor, and all of them can
    // reach it. The ledge itself runs 37,14 to 35,21 on that same floor.
    //
    // So the drop is aimed at STAGE, and a drop is only accepted if it lands on the plateau —
    // the floor test IS the "am I above the drop or below it" test, and it is the one that
    // matters. Then a short walk south-west onto the take-off.
    let placed = false;
    for (let drop = 0; drop < 6 && !placed; drop++) {
      await dm.relocate([q.character], ROOM, { row: STAGE.row, col: STAGE.col, verify: false }).catch(() => null);
      await sleep(600);
      const here = await observe(q.agent);
      placed = !!(here?.me && sameFloorAs(here.me, st.from) && canReach.has(here.me.row * 1000 + here.me.col));
      if (placed) { out.drops = drop + 1; out.dropped_at = `${here.me.row},${here.me.col}`; }
    }
    if (!placed) out.drops = 6;

    // Now the walk is worth doing, because we only walk from somewhere that can get there.
    if (placed) {
      for (let tries = 0; tries < 2; tries++) {
        const here = await observe(q.agent);
        if (here?.me && dist(here.me, st.from) <= 2 && sameFloorAs(here.me, st.from)) break;
        await call('walk_to', { agent: q.agent, col: st.from.col, row: st.from.row }, 20000);
      }
    }
  }
  // ON THE LEDGE IS GOOD ENOUGH, AND INSISTING ON THE EXACT SQUARE THREW THE EXPERIMENT AWAY.
  //
  // The walk reliably gets within one square and reliably fails the last step onto 36,16 —
  // 37,16 and 36,17 over and over. Demanding the exact square recorded those as "never
  // reached the take-off", which is fifteen non-attempts and no data.
  //
  // A square either side is a real jump: the guard on the `jump` verb already allows the
  // one-square neighbourhood of a declared jump on the same two floors, precisely because
  // that is the variation worth measuring. So the attempt proceeds from where the body
  // actually is and RECORDS it, which is better evidence than the intention was.
  const at = await observe(q.agent);
  const onLedge = at?.me && dist(at.me, st.from) <= 2 && sameFloorAs(at.me, st.from);
  if (!onLedge) {
    out.made = false;
    out.outcome = 'no_approach';
    out.note = `not on the ledge (${at?.me ? at.me.row + ',' + at.me.col : 'no position'})`;
    return line(out);
  }
  const takeOffAt = { row: at.me.row, col: at.me.col };
  out.took_off_from = `${takeOffAt.row},${takeOffAt.col}`;
  out.exact = takeOffAt.row === st.from.row && takeOffAt.col === st.from.col;

  // 2. WHAT IS IN THE WAY, AND IS IT MOVING. Two samples a second apart, because "a troll was
  //    standing on the landing" and "a troll walked into the landing" are different findings
  //    and only the second one argues for timing rather than for a different line.
  // ONE LOOK WHEN THE LINE IS CLEAR, TWO ONLY WHEN THERE IS SOMETHING TO CHARACTERISE.
  //
  // The second sample exists to tell a blocker that is STANDING on the line from one that
  // WALKED onto it, which is a real distinction and worth a second — but only when there is a
  // blocker. Taking it unconditionally left the body standing on a one-square ledge beside
  // Guardians for a second longer than it needed to, every attempt, and `left the ledge before
  // jumping` went from 6 to 19 once the tolerance widened enough to notice.
  //
  // So: look once, and if nothing is near the line, jump NOW. The exposure that costs attempts
  // is the time between arriving and committing, and with a clear line that time is waste.
  const first = at;
  const nearFirst = (first.atHeight ?? first.objects ?? []).filter(o =>
    distToLine({ col: o.col, row: o.row }, st.from, st.to) <= (st.wait ?? 2));
  const second = nearFirst.length ? (await sleep(500), await observe(q.agent)) : first;
  const near = (second?.atHeight ?? second?.objects ?? []).filter(o =>
    distToLine({ col: o.col, row: o.row }, st.from, st.to) <= (st.wait ?? 2));
  // Recorded even though it does not gate anything: 'the pit was full and we cleared it' is
  // the sentence that proves the height filter is right, and it would be invisible otherwise.
  out.in_the_pit = ((second?.objects ?? []).length - (second?.atHeight ?? []).length);
  const movedById = new Map((first.objects ?? []).map(o => [o.id, o]));
  const blockers = near.map(o => {
    const was = movedById.get(o.id);
    return { id: o.id, name: o.name, col: o.col, row: o.row,
             moving: !!(was && (was.col !== o.col || was.row !== o.row)),
             on_landing: o.col === st.to.col && o.row === st.to.row };
  });
  out.in_the_way = blockers.length;
  out.blockers = blockers.map(b => `${b.name}@${b.row},${b.col}${b.moving ? ' moving' : ''}`);

  // 3. `clear` is the only strategy that may decline. It is a strategy, not a safety rail —
  //    the others jump into whatever is there on purpose, so the difference is measurable.
  // PATIENCE: WAIT FOR THE ROOM, THEN GO ANYWAY. A strategy with `patience` re-looks until
  // the line clears or the clock runs out and then jumps regardless; one without it declines.
  // Those are different questions — 'is waiting worth it' and 'is refusing worth it' — and an
  // earlier edit of this missed its target, so every sweep pair declined rather than waited
  // and threw away 28 of 108 attempts.
  if (st.patience && blockers.length) {
    // STAND SOMEWHERE WITH A WALL AT YOUR BACK WHILE YOU WAIT. Waiting on the take-off is
    // waiting in the open on a one-square ledge with Guardians two squares away, which is how
    // 'left the ledge before jumping' became the commonest outcome of the patient strategies.
    if (st.waitAt) {
      await call('walk_to', { agent: q.agent, col: st.waitAt.col, row: st.waitAt.row }, 12000);
      out.waited_at = `${st.waitAt.row},${st.waitAt.col}`;
    }
    const until = Date.now() + st.patience * 1000;
    while (Date.now() < until) {
      await sleep(1500);
      const look = await observe(q.agent);
      const now = (look?.atHeight ?? look?.objects ?? []).filter(o =>
        distToLine({ col: o.col, row: o.row }, st.from, st.to) <= st.wait);
      if (!now.length) { blockers.length = 0; break; }
    }
    out.waited_s = Math.round((st.patience * 1000 - Math.max(0, until - Date.now())) / 1000);
    // Back to the ledge, now that the line is clear. This is the exposed moment and it is one
    // step long, which is the whole point of having waited elsewhere.
    if (st.waitAt) {
      for (let tries = 0; tries < 2; tries++) {
        const back = await observe(q.agent);
        if (back?.me && dist(back.me, st.from) <= 1 && sameFloorAs(back.me, st.from)) break;
        await call('walk_to', { agent: q.agent, col: st.from.col, row: st.from.row }, 10000);
      }
    }
  }
  if (st.wait && !st.patience && !st.alwaysJump && blockers.length) {
    out.made = false;
    out.declined = true;
    out.collided = blockers[0] ? { name: blockers[0].name, moving: blockers[0].moving,
                                   kind: blockers[0].name === 'troll' ? 'troll'
                                       : /guardian/i.test(blockers[0].name) ? 'guardian' : 'other' } : null;
    out.outcome = 'declined';
    out.note = `declined: ${blockers.length} within ${st.wait} of the line`;
    return line(out);
  }

  // 4. STILL ON THE SQUARE? The second of watching costs a second, and a body can be pushed
  //    or drift in it — one attempt jumped from 35,20 having been checked at 35,16, and the
  //    guard caught it as "not a declared fall-jump" from a square nobody meant to be on.
  //    A drifted attempt is not this strategy and is recorded as its own outcome.
  const still = await observe(q.agent);
  if (!still?.me || !sameFloorAs(still.me, st.from) || dist(still.me, st.from) > 2) {
    out.made = false;
    out.drifted = still?.me ? `${still.me.row},${still.me.col}` : 'unknown';
    out.outcome = 'left_ledge';
    out.note = `left the ledge before jumping (to ${out.drifted})`;
    return line(out);
  }
  out.took_off_from = `${still.me.row},${still.me.col}`;

  // 5. PICK THE LINE, IF THIS STRATEGY PICKS. Clearance is the distance from the nearest
  //    object to the line, so the best candidate is the one that maximises it; ties go to the
  //    declared landing, which is the one somebody has actually walked.
  if (st.candidates) {
    const objs = (second?.atHeight ?? second?.objects ?? []);
    let best = null;
    for (const cand of SHELF) {
      const clearance = objs.length
        ? Math.min(...objs.map(o => distToLine({ col: o.col, row: o.row }, st.from, cand)))
        : 99;
      const isDeclared = cand.row === 38 && cand.col === 10;
      if (!best || clearance > best.clearance + 0.01 ||
          (Math.abs(clearance - best.clearance) <= 0.01 && isDeclared)) {
        best = { cand, clearance };
      }
    }
    if (best) {
      st.to = best.cand;
      out.to = `${best.cand.row},${best.cand.col}`;
      out.clearance = Math.round(best.clearance * 10) / 10;
    }
  }

  // 6. jump.
  const j = await call('jump', { agent: q.agent, to_col: st.to.col, to_row: st.to.row }, 60000);
  out.made = !!j?.made;
  out.outcome = j?.landed ? (j.made ? 'made' : 'missed') : 'no_jump';
  out.landed = j?.landed ? `${j.landed.row},${j.landed.col}` : null;
  out.floor = j?.floor ?? null;
  out.landing_floor = j?.landing_floor ?? null;
  if (j?._error) out.note = j._error;
  else if (j?.reason) out.note = j.reason;

  // 7. WHO WAS IN THE WAY, decided after the fact against where the body ended up. A blocker
  //    that was on the line and a jump that came up short is the collision this exists to
  //    count; a blocker that was on the line and a jump that landed anyway is evidence the
  //    line is survivable, which is just as useful and used to be invisible.
  const onLanding = blockers.find(b => b.on_landing) ?? blockers[0] ?? null;
  out.collided = (!out.made && onLanding)
    ? { name: onLanding.name, moving: onLanding.moving,
        kind: onLanding.name === 'troll' ? 'troll'
            : /guardian/i.test(onLanding.name) ? 'guardian' : 'other' }
    : null;
  return line(out);
}

// ---------------------------------------------------------------- run

// EVERYONE NOT IN THE TRIAL IS TRAFFIC, AND TRAFFIC IS WHAT WE ARE TRYING TO MEASURE
// AGAINST — not to add to.
//
// A queue of sixteen characters waiting their turn on a plateau eight squares from the ledge
// is sixteen more bodies in a room whose whole difficulty is bodies. It showed up as 45
// attempts that never reached the ledge and 25 that were pushed off it. The waiting room was
// the problem it was meant to avoid.
//
// So the characters not taking part are sent out of the room entirely and parked there. Five
// recycled repeatedly is a cleaner experiment than twenty-one queueing, and it is the
// operator's suggestion.
const EVACUATE_TO = 52;                       // Familiars, the Tos inn — far, and safe
// `--no-evacuate` leaves the rest of the fleet alone, which is what you want when the others
// are doing something — a circuit through this very room, say. Then the traffic is REAL
// rather than removed, and the trial measures the jump under the conditions the road actually
// presents instead of a laboratory emptiness.
const sittingOut = has('no-evacuate') ? []
  : (fleetNow.fleet ?? []).filter(r => r.agent && r.character &&
                                  !queue.some(q => q.agent === r.agent));
if (has('no-evacuate'))
  console.log('not evacuating: the rest of the fleet is left to whatever it is doing');
if (sittingOut.length) {
  console.log(`clearing the room: ${sittingOut.length} character(s) not in this trial -> room ${EVACUATE_TO}`);
  // UNPARK FIRST. A PARKED CHARACTER CANNOT BE RELOCATED.
  //
  // This parked and then moved, and a body already parked — from this run or a previous one —
  // silently refused the move and stayed exactly where it was. The result was the opposite of
  // an evacuation: sixteen characters frozen IN the room as permanent obstacles. Counted from
  // the ledge afterwards: nineteen of my own characters plus fifteen trolls and three
  // Guardians, which is why the success rate collapsed from 85% to 12%.
  let cleared = 0;
  for (const r of sittingOut) {
    await call('autopilot', { agent: r.agent, action: 'unpark', why: 'moving out of the trial room' });
    await call('autopilot', { agent: r.agent, mode: 'idle', roam: false, confine_rooms: [EVACUATE_TO] });
    const moved = await dm.relocate([r.character], EVACUATE_TO, { verify: false }).catch(() => null);
    if (moved?.ok) cleared++;
    await call('autopilot', { agent: r.agent, action: 'park', why: 'sitting out a jump trial' });
    await sleep(150);
  }
  console.log(`cleared: ${cleared} of ${sittingOut.length} moved out.`);
  if (cleared < sittingOut.length)
    console.log('  WARNING: the ones that did not move are still in the room and are traffic.');
}

console.log('placing the queue…');
for (const q of queue) {
  if (!q.spot) continue;
  // DO NOT PARK. It was tried and it is worse than the problem.
  //
  // The keeper walking the body off the ledge is a real confound — a Guardian two squares from
  // the take-off means the survival ladder is doing its job and the jump never happens. But
  // parking stops the session moving AT ALL, including for this harness: with the fleet parked
  // every attempt read "not on the ledge (35,21)", which is simply where the relocate dropped
  // them, unmoved. The harness needs the character driveable and needs the keeper's own
  // opinions out of the way, and `park` gives it neither.
  //
  // So: idle, not roaming, confined to this room, and the attempt records where the body
  // actually took off from. A keeper that pulls it off the ledge shows up as `left the ledge
  // before jumping`, which is a finding rather than a failure of the harness — it is the
  // measurement of how much the survival ladder costs at this particular cliff.
  await call('autopilot', { agent: q.agent, mode: 'idle', roam: false, confine_rooms: [ROOM] });
  await call('autopilot', { agent: q.agent, action: 'unpark', why: 'jump trial: the harness drives, the keeper must not be frozen' });
  await dm.relocate([q.character], ROOM, { row: q.spot.row, col: q.spot.col, verify: false }).catch(() => null);
  try {
    const ids = await dm.resolve([q.character]);
    const max = q.max_health ?? null;
    if (ids?.[q.character] != null && max) await dm.dm([...dm.healthCmds(ids[q.character], max)], { timeoutMs: 30000 });
  } catch {}
  await sleep(200);
}
console.log(`${queue.length} placed.\n`);

let n = 0;
for (let round = 1; round <= ROUNDS; round++) {
  for (const name of CHOSEN) {
    for (const q of queue) {
      const r = await attempt(q, name);
      n++;
      console.log('  ' + String(round).padStart(2) + '  ' + name.padEnd(11) +
                  (r.made ? 'MADE  ' : r.declined ? 'declined' : 'missed') +
                  '  landed ' + String(r.landed ?? '—').padEnd(7) +
                  (r.blockers?.length ? '  in the way: ' + r.blockers.slice(0, 2).join(', ') : '') +
                  (r.note ? '  — ' + r.note : ''));
      // BACK TO THE SPOT EITHER WAY. A character that made the jump is on the far shelf and
      // would otherwise be out of the experiment; one that missed is in the gulley it cannot
      // climb out of. The relocate is the only thing that makes this a LOOP.
      await dm.relocate([q.character], ROOM, { row: q.spot.row, col: q.spot.col, verify: false }).catch(() => null);
      await dm.heal([q.character]).catch(() => null);
      await sleep(300);
    }
  }
}

console.log(`\n${n} attempt(s) this run.`);
report(readLedger());
console.log(`\nledger: ${LEDGER}`);
