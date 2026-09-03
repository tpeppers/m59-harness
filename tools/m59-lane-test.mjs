#!/usr/bin/env node
// THE LANE PAST A BODY, AGAINST THE JAM THAT WAS ACTUALLY RECORDED.
//
//   node tools/m59-lane-test.mjs
//
// Offline: it reads a committed fixture and the baked map, opens no socket and touches no
// roster.
//
// WHAT THIS PINS. `tools/fixtures/sewers-108-row27.json` is seventy seconds of a real
// traffic deadlock -- six giant rats one per square centre on row 27 of the Sewers of
// Barloque, 64 wire units apart, that never moved, while three fleet characters oscillated
// in the gaps and NOBODY GOT PAST A RAT. The question this file answers is why, and whether
// the answer is a thing the mover can do.
//
// It is not that the corridor is blocked. There is room to pass -- half a unit of it on each
// side -- and because the wire carries integers, exactly one aim point per side. A walker
// that thinks in SQUARES cannot express that aim, which is why `sidestepAround` returns
// nothing here and the walk falls through to marking the square taken and replanning.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepRightAim } from './m59-roo.mjs';
import { lanePastBodies, perpWalkPastBodies, gapAlongLine, MIN_NOMOVEON, PLAYER_RADIUS,
         CLIENT_FINENESS, KOD_FINENESS, sharedRoomGeometry } from './m59-roo.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skip = (name, why) => { skipped++; console.log('  --   ' + name + ' — ' + why); };

const PER_KOD = CLIENT_FINENESS / KOD_FINENESS;      // 16 client units to one wire unit
const NOMOVEON = MIN_NOMOVEON / PER_KOD;             // 16, in wire units
const RADIUS = PLAYER_RADIUS / PER_KOD;              // 15.5, in wire units

console.log('\nthe recorded jam — Sewers of Barloque, row 27');

const FIX = join(HERE, 'fixtures', 'sewers-108-row27.json');
if (!existsSync(FIX)) {
  skip('the jam fixture is on disk', 'tools/fixtures/sewers-108-row27.json is missing');
} else {
  const jam = JSON.parse(readFileSync(FIX, 'utf8'));
  const rats = (jam.static ?? []).filter(o => o.kind === 'monster');

  ok('six monsters were recorded, one per square, and none of them moved',
     rats.length === 6 && rats.every(r => r.row === 27),
     JSON.stringify(rats.map(r => `${r.row},${r.col}`)));

  // 64 wire units apart is one square apart, which is what makes this a wall of bodies
  // rather than a crowd: there is no square between two of them to aim at.
  // Four of the five gaps are exactly one square; the westernmost rat sits a little off
  // its centre (x 2579, y 1755) and makes the first gap 77. Asserting all five were 64 was
  // an assertion about a tidier jam than the one that was recorded.
  const xs = rats.map(r => r.x).sort((a, b) => a - b);
  const spacing = xs.slice(1).map((x, i) => x - xs[i]);
  const oneSquare = spacing.filter(d => Math.abs(d - KOD_FINENESS) <= 8).length;
  ok('they stand one square apart, so there is no gap SQUARE to aim at',
     oneSquare >= spacing.length - 1 && spacing.every(d => d <= KOD_FINENESS + 16),
     JSON.stringify(spacing));

  // NOBODY GOT PAST. Two characters were recorded moving, and between them they visited
  // three squares in seventy seconds.
  //
  // Per character, not pooled: the two of them were at opposite ends of the rat wall, so
  // the union of their squares is five and says nothing. What matters is that NEITHER
  // crossed it -- each stayed inside a two-column stretch on its own side.
  const moved = (jam.moving ?? []).filter(m => m.kind === 'player');
  const spans = moved.map(m => {
    const cols = m.points.map(p => p.col);
    return { who: m.name, from: Math.min(...cols), to: Math.max(...cols) };
  });
  ok('neither moving character got past the rats in seventy seconds',
     spans.length === 2 && spans.every(s2 => s2.to - s2.from <= 1) && (jam.seconds ?? 0) >= 60,
     JSON.stringify(spans) + ' over ' + jam.seconds + 's');

  // ---------------------------------------------------------------- the arithmetic
  //
  // Taken from the recording rather than assumed: the corridor's floor spans one square in
  // y, and a rat sits on the centre line of it.
  const ratY = 1760, wallLo = 1728, wallHi = 1792;
  ok('a rat sits on the centre line of a corridor exactly one square tall',
     rats.some(r => Math.abs(r.y - ratY) <= 8) && (wallHi - wallLo) === KOD_FINENESS,
     `rat y ${rats.map(r => r.y).join(',')} in ${wallLo}..${wallHi}`);

  const standLo = wallLo + RADIUS, standHi = wallHi - RADIUS;
  const feasible = [];
  for (let y = Math.ceil(standLo); y <= Math.floor(standHi); y++)
    if (Math.abs(y - ratY) >= NOMOVEON) feasible.push(y);

  // THE FINDING. Half a unit of room on each side, and the wire carries integers.
  ok('there is exactly ONE integer aim point on each side of a centred body',
     feasible.length === 2 && feasible[0] === 1744 && feasible[1] === 1776,
     JSON.stringify({ standLo, standHi, feasible }));

  ok('and a square centre is NOT one of them, which is what the walker aims at',
     !feasible.includes(wallLo + KOD_FINENESS / 2),
     'the centre is ' + (wallLo + KOD_FINENESS / 2));

  // ---------------------------------------------------------------- the lane finds it
  const bodies = rats.map(r => ({ x: r.x, y: r.y, name: r.name }));
  const hasFloor = (_x, y) => y >= wallLo && y <= wallHi;
  const lane = lanePastBodies({
    fromX: 2513, fromY: 1760,          // where a recorded character actually stood
    toX: 2900, toY: 1760,              // east, past the whole row of rats
    bodies, hasFloor,
  });
  ok('the lane finds a way past a wall of bodies the sidestep cannot express',
     !!lane && Math.abs(lane.off) >= NOMOVEON && feasible.includes(lane.y),
     JSON.stringify(lane));

  ok('and it aims at one of the two integers the arithmetic allows',
     !!lane && (lane.y === 1744 || lane.y === 1776), JSON.stringify(lane?.y));

  // Straight down the middle is refused, which is the state the recording captured.
  const straight = gapAlongLine(2513, 1760, 2900, 1760, bodies);
  ok('while the straight line through them is refused',
     straight.gap < NOMOVEON, JSON.stringify(straight));

  // ---------------------------------------------------------------- and on the real map
  const map = (() => { try { return loadMap(); } catch { return null; } })();
  if (!map?.rooms?.['108']) {
    skip('the corridor is one square wide on the baked map', 'no room 108 geometry on disk');
  } else {
    attachStepMasks(map);
    const geo = sharedRoomGeometry(map.rooms['108']);
    const widths = [39, 40, 41].map(c => {
      let n = 0;
      for (let r = 25; r <= 29; r++) if (geo.standPoint(r, c)) n++;
      return n;
    });
    ok('cols 39-41 are one square wide on the baked map, so there IS no side square',
       widths.every(w => w === 1), JSON.stringify(widths));
  }
}

// ---------------------------------------------------------------- the observe seam
//
// `canBlinkOut` takes an optional `observe`, and NOTHING BEHIND IT SHIPS: the recorder that
// fills it is one machine's private strategy. What is committed is the seam, so the seam is
// what gets tested -- that every verdict is observable (not only the interesting one), that
// the sighting carries what a reproduction needs, and that a recorder which throws cannot
// turn a movement decision into an exception on an already-stuck walk.
// tools/fixtures/flatlands-584-row35.json — eight seconds of two keepers watching row 35 of
// The Flatlands on 2026-09-01, recorded while the fleet was dying in it. Same pipe as the
// sewers, one square tall for columns 29-32, and the same picket: an ant at column 27, a
// spider on the centre line at column 32, two of ours between them, a second ant walking the
// pipe. Three characters were eaten here that afternoon and the tactics ledger recorded
// twenty-one `body_lane` failures on these squares, every one "no side to step to".
//
// THE FINDING. The lane finder DID propose a lane — starting at y 2249. The floor starts at
// 2240 and a body needs PLAYER_RADIUS (15.5) from it, so that start is nine units into the
// wall, and the mover refused it. `lanePastBodies` tested floor under the lane's centre
// line and never under the body's edge. The arithmetic below says where the lane really is.
console.log('\nthe recorded jam — The Flatlands, row 35');
{
  const FIX2 = join(HERE, 'fixtures', 'flatlands-584-row35.json');
  if (!existsSync(FIX2)) {
    skip('the Flatlands jam fixture is on disk', 'tools/fixtures/flatlands-584-row35.json is missing');
  } else {
    const jam = JSON.parse(readFileSync(FIX2, 'utf8'));
    const monsters = (jam.static ?? []).filter(o => o.kind === 'monster');
    const ours = (jam.static ?? []).filter(o => o.kind === 'player');
    ok('an ant and a spider stood still on row 35 with two of ours between them',
       monsters.length === 2 && ours.length === 2 && [...monsters, ...ours].every(o => o.row === 35),
       JSON.stringify([...monsters, ...ours].map(o => `${o.name}@${o.col}`)));
    const f = jam.geometry.floor_y_by_col;
    const wallLo = f['32'].lo, wallHi = f['32'].hi;
    ok('columns 29-32 are one square tall — a pipe',
       [29, 30, 31, 32].every(c => f[String(c)].hi - f[String(c)].lo === KOD_FINENESS),
       JSON.stringify([29, 30, 31, 32].map(c => f[String(c)])));
    const spider = monsters.find(o => o.name === 'spider');
    ok('and the spider is on its centre line', Math.abs(spider.y - (wallLo + KOD_FINENESS / 2)) <= 2, String(spider.y));
    const standLo = wallLo + RADIUS, standHi = wallHi - RADIUS;
    const feasible = [];
    for (let y = Math.ceil(standLo); y <= Math.floor(standHi); y++)
      if (Math.abs(y - spider.y) >= NOMOVEON) feasible.push(y);
    ok('so there is exactly one integer aim point on each side of it, as in the sewers',
       feasible.length === 2, JSON.stringify({ standLo, standHi, feasible }));
    const hasFloor = (x, y) => { const b = f[String(Math.floor(x / KOD_FINENESS))]; return !!b && y >= b.lo && y <= b.hi; };
    const A = ours.find(o => o.name === 'player A');
    const bodies = [...monsters, ...ours.filter(o => o !== A), ...(jam.moving ?? []).map(m => m.points.at(-1))]
      .map(o => ({ x: o.x, y: o.y, name: o.name ?? 'ant' }));
    const lane = lanePastBodies({ fromX: A.x, fromY: A.y, toX: 35 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                  bodies, hasFloor });
    ok('the lane finder still finds a way east past the spider', !!lane, JSON.stringify(lane));
    // Each end is judged in ITS column: the pipe is one square tall at 29-32 and opens out
    // again at 34-35, so the far end may legitimately sit lower or higher than the pipe's band.
    const bandAt = x => { const b = f[String(Math.floor(x / KOD_FINENESS))]; return b && { lo: b.lo + RADIUS, hi: b.hi - RADIUS }; };
    const startBand = lane && bandAt(lane.fromX), endBand = lane && bandAt(lane.x);
    ok('and the lane it proposes is one the body can STAND in — both ends clear of their wall by a radius',
       !!lane && startBand && endBand && lane.fromY >= startBand.lo && lane.fromY <= startBand.hi
       && lane.y >= endBand.lo && lane.y <= endBand.hi,
       JSON.stringify(lane && { fromY: lane.fromY, startBand, y: lane.y, endBand }));
    ok('starting inside the pipe’s own half-unit band, which the point test used to miss by nine units',
       !!lane && lane.fromY >= standLo && lane.fromY <= standHi, JSON.stringify({ fromY: lane?.fromY, standLo, standHi }));
    ok('with the blocking rule\'s clearance from the spider', !!lane && lane.gap >= NOMOVEON, JSON.stringify(lane?.gap));

    // THE PERP WALK, on the same jam. Measured from the bodies and the walls rather than from
    // the walker's line: the spider sits 32 from each wall of a 64-tall pipe, so on either
    // side the window between "16 from the spider" and "15.5 from the wall" is half a unit,
    // and the hug line has to land in it and stay out of every disc all the way past.
    console.log('\nthe perp walk past the same picket');
    const perp = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: 35 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                      bodies, hasFloor });
    ok('it finds a side with room for a body between the blockers and the wall',
       !!perp?.points, JSON.stringify(perp && { side: perp.side, offset: perp.offset, slack: perp.slack, why: perp.why }));
    ok('the window it found is the half-unit one the arithmetic predicts',
       !!perp?.points && perp.slack >= 0 && perp.slack <= 1.5, JSON.stringify(perp?.slack));
    const clear = p => bodies.every(b => Math.hypot(b.x - p.x, b.y - p.y) >= NOMOVEON - 1e-6);
    ok('every point on the hug line is on the floor and outside every blocker\'s disc',
       !!perp?.waypoints && perp.waypoints.every(p => hasFloor(p.x, p.y) && clear(p)),
       JSON.stringify(perp?.waypoints?.map(p => `${p.x},${p.y}`)));
    const spider2 = bodies.find(b => b.name === 'spider');
    ok('and its far point is past the spider, not beside it',
       !!perp?.points && perp.points[1].x > spider2.x + NOMOVEON, JSON.stringify(perp?.points?.[1]));
    const back = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: 26 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                      bodies, hasFloor });
    ok('westward past the two ants it answers the same way',
       !!back?.points && back.points[1].x < Math.min(...bodies.filter(b => b.name === 'ant').map(b => b.x)) - NOMOVEON,
       JSON.stringify(back && { side: back.side, past: back.points?.[1], why: back.why }));
    const open = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: A.x + 200, toY: A.y, bodies: [], hasFloor });
    ok('and with nothing in the way it has nothing to say', open === null, JSON.stringify(open));
    // THE PRECHECK. Handed a tracer that refuses the first leg, the walk is refused BEFORE
    // it is walked, with the leg and the reason on the row, and never returns points.
    const refused = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: 35 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                         bodies, hasFloor, segmentClear: () => ({ ok: false, reason: 'fine_wall_edge' }) });
    ok('a line the tracer refuses is refused before it is walked', !!refused && !refused.points && refused.precheck === 'geometry',
       JSON.stringify(refused && { precheck: refused.precheck, why: refused.why }));
    const passed = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: 35 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                        bodies, hasFloor, segmentClear: () => ({ ok: true }) });
    ok('and a line the tracer accepts still comes back with its points', !!passed?.points, JSON.stringify(passed?.why));
    const bodyRefused = perpWalkPastBodies({ fromX: A.x, fromY: A.y, toX: 35 * KOD_FINENESS + 32, toY: wallLo + KOD_FINENESS / 2,
                                             bodies, hasFloor, segmentClear: () => ({ ok: false, reason: 'object_blocked' }) });
    ok('and a tracer refusal on a body is reported as a body precheck, not a geometry one',
       !!bodyRefused && !bodyRefused.points && bodyRefused.precheck === 'body', JSON.stringify(bodyRefused && { precheck: bodyRefused.precheck, why: bodyRefused.why }));
  }
}

console.log('\nthe canBlinkOut observation seam');
{
  const { canBlinkOut } = await import('./m59-blink.mjs');
  const flat = { standPoint: () => ({ x: 0, y: 0 }), moverStepLands: () => true };
  const seen = [];
  const args = { geo: flat, blink: { row: 1, col: 1 }, from: { row: 5, col: 5 },
                 goal: { row: 9, col: 9 },
                 bodies: [{ row: 7, col: 7, kind: 'monster', name: 'giant rat' }],
                 rows: 12, cols: 12, room: { num: 108 },
                 route: [{ row: 6, col: 6 }, { row: 9, col: 9 }] };

  const declined = canBlinkOut({ ...args, observe: o => seen.push(o) });
  ok('a DECLINE is observed too, because the declines say whether it earns its mana',
     seen.length === 1 && seen[0].verdict.can === declined.can, JSON.stringify(seen.length));
  ok('and the sighting carries the map, the squares, the route and the bodies',
     seen[0]?.room?.num === 108 && seen[0]?.from?.row === 5 && seen[0]?.goal?.col === 9 &&
     seen[0]?.route?.length === 2 && seen[0]?.bodies?.[0]?.name === 'giant rat',
     JSON.stringify(seen[0]));

  let verdict = null, threw = false;
  try {
    verdict = canBlinkOut({ ...args, observe: () => { throw new Error('recorder broken'); } });
  } catch { threw = true; }
  ok('a recorder that throws does not take the movement decision down with it',
     !threw && verdict !== null && typeof verdict.can === 'boolean',
     JSON.stringify({ threw, verdict }));

  const noObserver = canBlinkOut(args);
  ok('and with no recorder at all it answers exactly the same',
     noObserver.can === declined.can && noObserver.why === declined.why,
     JSON.stringify({ noObserver, declined }));
}

// -------------------------------------------- a stalled crossing overrides "you could walk it"
//
// "The goal is already reachable on foot" is 1,349 of ~2,300 recorded declines and 226 of the
// 233 in the Cragged Mountains. It is a true statement about the MAP and it was being read as
// one about whether the body is getting there. The operator's rule, 2026-09-03: past two
// minutes in a room and oscillating, open blink up regardless. Only that check is dropped —
// the blink point must still reach the goal, or a stalled body pays fifteen mana to arrive
// somewhere just as stuck.
console.log('\na stalled crossing outranks "the goal is already reachable on foot"');
{
  const { canBlinkOut } = await import('./m59-blink.mjs');
  const open = { standPoint: () => ({ x: 0, y: 0 }), moverStepLands: () => true };
  const base = { geo: open, blink: { row: 1, col: 1 }, from: { row: 5, col: 5 },
                 goal: { row: 9, col: 9 }, bodies: [], rows: 12, cols: 12 };

  const walkable = canBlinkOut(base);
  ok('an open room declines, because walking really would do',
     walkable.can === false && /already reachable on foot/.test(walkable.why),
     JSON.stringify(walkable));

  const stalled = canBlinkOut({ ...base, stalled: '131s in this room, 24 moves over 3 square(s)' });
  ok('the same room with a stalled crossing allows the cast',
     stalled.can === true, JSON.stringify(stalled));
  ok('and the verdict says it fired DESPITE the goal being walkable, so the ledger cannot lie about why',
     stalled.despite_walkable === true && /24 moves over 3 square\(s\)/.test(stalled.why),
     JSON.stringify(stalled));

  // The second half is not negotiable: a blink point that cannot reach the goal is a wasted
  // cast whatever the crossing has been doing.
  const sealed = { standPoint: () => ({ x: 0, y: 0 }),
                   // Nothing may step out of the blink point's corner.
                   moverStepLands: (r, c) => !(r <= 2 && c <= 2) };
  const useless = canBlinkOut({ ...base, geo: sealed, from: { row: 9, col: 8 },
                                stalled: '200s in this room, 24 moves over 2 square(s)' });
  ok('but a stall does not buy a blink point that cannot reach the goal either',
     useless.can === false && /same side of the traffic/.test(useless.why),
     JSON.stringify(useless));

  // And the flag is inert when the crossing is going normally.
  ok('a crossing that is not stalled is unaffected by the option existing',
     canBlinkOut({ ...base, stalled: null }).can === false,
     JSON.stringify(canBlinkOut({ ...base, stalled: null })));
}

// ---------------------------------------------------------------- keep right in a corridor
console.log('\nkeep right — two lanes in a one-square pipe');
{
  // A horizontal pipe one coarse square tall: floor for y in [2240, 2304), everywhere in x.
  const pipe = (_x, y) => y >= 2240 && y < 2304;
  const K = 16;                                        // MIN_NOMOVEON in kod units (256 / 16)
  const east = keepRightAim({ fromX: 2100, fromY: 2272, toX: 2272, toY: 2272, hasFloor: pipe });
  const west = keepRightAim({ fromX: 2400, fromY: 2272, toX: 2272, toY: 2272, hasFloor: pipe });
  ok('the pipe is a corridor', east?.corridor === true && west?.corridor === true,
     JSON.stringify({ east, west }));
  ok('eastbound keeps right: south of the centre line (y down)', east && east.y > 2272 && east.x === 2272,
     JSON.stringify(east));
  ok('westbound keeps right: north of the centre line', west && west.y < 2272 && west.x === 2272,
     JSON.stringify(west));
  ok('each lane keeps the body radius off its wall', east && west &&
     2304 - east.y >= 15.5 && west.y - 2240 >= 15.5, JSON.stringify({ east, west }));
  ok('the two lanes are further apart than the blocking distance, so they pass',
     east && west && Math.abs(east.y - west.y) >= K, JSON.stringify({ gap: east && west && east.y - west.y, K }));
  ok('a lane point has floor', east && west && pipe(east.x, east.y) && pipe(west.x, west.y));

  // A vertical pipe: southbound keeps to the west wall, northbound to the east wall.
  const shaft = (x, _y) => x >= 2240 && x < 2304;
  const south = keepRightAim({ fromX: 2272, fromY: 2100, toX: 2272, toY: 2272, hasFloor: shaft });
  const north = keepRightAim({ fromX: 2272, fromY: 2400, toX: 2272, toY: 2272, hasFloor: shaft });
  ok('southbound keeps right: west of the centre line', south?.corridor && south.x < 2272 && south.y === 2272,
     JSON.stringify(south));
  ok('northbound keeps right: east of the centre line', north?.corridor && north.x > 2272 && north.y === 2272,
     JSON.stringify(north));
  ok('the vertical lanes pass too', south && north && Math.abs(north.x - south.x) >= K);

  // Wide floor is not a corridor and gets no lane.
  const hall = () => true;
  const open = keepRightAim({ fromX: 2100, fromY: 2272, toX: 2272, toY: 2272, hasFloor: hall });
  ok('wide floor gets no lane', open && open.corridor === false && open.offset === 0 && open.x === 2272 && open.y === 2272,
     JSON.stringify(open));

  // A slot too narrow to shift in keeps the stand point rather than aiming into the wall.
  const slot = (_x, y) => y >= 2260 && y < 2284;       // 24 wide
  const tight = keepRightAim({ fromX: 2100, fromY: 2272, toX: 2272, toY: 2272, hasFloor: slot });
  ok('a slot narrower than a body plus margin keeps the stand point', tight?.corridor && tight.offset === 0 && tight.y === 2272,
     JSON.stringify(tight));

  // No direction, no lane.
  ok('standing still has no right-hand side', keepRightAim({ fromX: 2272, fromY: 2272, toX: 2272, toY: 2272, hasFloor: pipe }) === null);
}

// The recorded Flatlands pipe (row 35): the lane rule answers on the real floor too.
{
  const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'flatlands-584-row35.json');
  if (!existsSync(file)) skip('flatlands fixture: keep right', 'fixture missing');
  else {
    const fx = JSON.parse(readFileSync(file, 'utf8'));
    const f = fx.geometry?.floor_y_by_col ?? null;
    const cols = f && typeof f === 'object' ? Object.keys(f).map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    if (!cols.length) skip('flatlands fixture: keep right', 'fixture carries no per-column floor');
    else {
      const hasFloor = (x, y) => { const b = f[String(Math.floor(x / KOD_FINENESS))]; return !!b && y >= b.lo && y <= b.hi; };
      const c = cols[Math.floor(cols.length / 2)];
      const b = f[String(c)];
      const cy = Math.round((b.lo + b.hi) / 2), cx = c * KOD_FINENESS + 32;
      const e = keepRightAim({ fromX: cx - 64, fromY: cy, toX: cx, toY: cy, hasFloor });
      const w = keepRightAim({ fromX: cx + 64, fromY: cy, toX: cx, toY: cy, hasFloor });
      ok('the Flatlands pipe is a corridor with a lane each way', e?.corridor && w?.corridor && e.offset > 0 && w.offset > 0,
         JSON.stringify({ col: c, floor: b, e, w }));
      ok('the two lanes pass on the real floor', e && w && Math.abs(e.y - w.y) >= 16 && hasFloor(e.x, e.y) && hasFloor(w.x, w.y),
         JSON.stringify({ e, w }));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ''));
process.exit(fail ? 1 : 0);
