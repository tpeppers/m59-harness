// THE GUARD FOR m59-railcut.mjs — offline, no map, no socket, no room.
//
//   node tools/m59-railcut-test.mjs
//
// The edge test is injected, so this exercises the cutter against synthetic worlds whose shape is
// known exactly. Every case is a thing that went wrong on the real map on 2026-09-11/12.
import { snap, flood, chainTo, cutRail, verifyRail, furthestTraceable, chordWalkable, LATTICE }
  from './m59-railcut.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

const bounds = { w: 4096, h: 4096 };
// An open world: every lattice step allowed.
const open = () => true;
// A world with a wall: nothing may cross y = 1000 except through the gap at x >= 2000.
const walled = (a, b) => !((a.y < 1000) !== (b.y < 1000)) || Math.min(a.x, b.x) >= 2000;

// ---- snap, and the phase trap it exists for ---------------------------------------------
eq(snap(17648), 17664, 'snap rounds to the nearest lattice point');
eq(snap(0), 0, 'zero is already on it');
eq(snap(32), 64, 'a half step rounds up');
eq(snap(31), 0, 'and below half, down');
ok(snap(17648) % LATTICE === 0, 'the result is always on the lattice');
{
  // THE TRAP. 17648 is 48 mod 64; a goal at 0 mod 64 is unreachable by 64-unit steps from it.
  ok(17648 % 64 !== 0, '17648 is off-phase (48 mod 64) — Marco\'s real position');
  const parent = flood({ x: 17648, y: 0 }, { edge: open, bounds: { w: 20000, h: 64 } });
  ok(!parent.has('17664,0'), 'a flood from an off-phase seed never lands on an on-phase point');
  ok(parent.size > 1, '...even though it visits plenty of points — which is why it reads as ' +
     '"the goal is unreachable" rather than as a bug');
}

// ---- flood ------------------------------------------------------------------------------
{
  const parent = flood({ x: 0, y: 0 }, { edge: open, bounds: { w: 256, h: 256 } });
  eq(parent.size, 16, 'an open 4x4 lattice floods to all 16 points');
  eq(parent.get('0,0'), null, 'the seed has no parent');
  ok(parent.has('192,192'), 'including the far corner');
}
{
  const parent = flood({ x: 0, y: 0 }, { edge: open, bounds: { w: 4096, h: 4096 }, cap: 10 });
  ok(parent.size <= 10 + 8, 'the cap bounds the flood rather than running away');
}
{
  // stopAt short-circuits, so a near goal does not pay for the whole room.
  const all = flood({ x: 0, y: 0 }, { edge: open, bounds });
  const some = flood({ x: 0, y: 0 }, { edge: open, bounds, stopAt: { x: 128, y: 0 } });
  ok(some.size < all.size, 'stopAt stops early');
}

// ---- chainTo ----------------------------------------------------------------------------
{
  const parent = flood({ x: 0, y: 0 }, { edge: open, bounds: { w: 256, h: 64 } });
  const c = chainTo(parent, { x: 192, y: 0 });
  eq(c[0], { x: 0, y: 0 }, 'the chain starts at the seed');
  eq(c[c.length - 1], { x: 192, y: 0 }, 'and ends at the goal');
  ok(chainTo(parent, { x: 9999, y: 0 }) === null, 'an unreached goal yields null, not an empty path');
}

// ---- cutRail ----------------------------------------------------------------------------
{
  // Off-phase body: the bridge is prepended so the rail starts where the body IS.
  const r = cutRail({ x: 48, y: 0 }, { x: 192, y: 0 },
                    { edge: open, bounds: { w: 512, h: 64 }, floorAt: () => 6144 });
  ok(r.ok, 'a reachable goal cuts a rail');
  eq(r.seed, { x: 64, y: 0 }, 'the seed is snapped');
  eq(r.bridge, 16, 'and the bridge distance reported');
  eq(r.waypoints[0], { x: 48, y: 0, f: 6144 }, 'the RAW body position is waypoint 0');
  eq(r.waypoints[1], { x: 64, y: 0, f: 6144 }, '...and the snapped seed is waypoint 1');
  ok(r.bridgeOk, 'the bridge is checked against the edge test, not assumed');
  ok(r.waypoints.every(w => w.f === 6144), 'every waypoint carries its floor');
}
{
  // On-phase body: no bridge, no duplicated first point.
  const r = cutRail({ x: 64, y: 0 }, { x: 192, y: 0 },
                    { edge: open, bounds: { w: 512, h: 64 }, floorAt: () => 1 });
  eq(r.bridge, 0, 'an on-lattice body needs no bridge');
  eq(r.waypoints[0], { x: 64, y: 0, f: 1 }, 'and the rail starts at it directly');
}
{
  // The goal is snapped too — otherwise the flood can never match it.
  const r = cutRail({ x: 0, y: 0 }, { x: 200, y: 0 },
                    { edge: open, bounds: { w: 512, h: 64 }, floorAt: () => 1 });
  ok(r.ok, 'an off-phase GOAL is snapped rather than missed');
  eq(r.target, { x: 192, y: 0 }, 'to the nearest lattice point');
}
{
  // Genuinely unreachable: says so, and says how much it looked at.
  const sealed = (a, b) => a.y === b.y && a.y === 0;   // only the first row is connected
  const r = cutRail({ x: 0, y: 0 }, { x: 0, y: 1024 },
                    { edge: sealed, bounds, floorAt: () => 1 });
  ok(!r.ok, 'an unreachable goal is a failure, not an empty rail');
  ok(r.visited > 1, 'and it reports how many points it visited before concluding that');
  ok(/did not reach/.test(r.why), 'with a reason a human can act on');
}
{
  // A wall with a gap: the rail must go round, so it is longer than the straight line.
  const r = cutRail({ x: 0, y: 0 }, { x: 0, y: 2048 },
                    { edge: walled, bounds, floorAt: () => 1 });
  ok(r.ok, 'a detour is still a path');
  ok(r.legs > 2048 / LATTICE, 'and it is longer than the straight line, because it goes round');
  ok(r.waypoints.some(w => w.x >= 2000), 'passing through the gap');
}

// ---- chordWalkable: ONE LONG CALL IS NOT AN ANSWER --------------------------------------
{
  // THE MEASURED CASE. An edge test that accepts a long span while refusing a piece in the middle
  // is not a hypothetical: traceFineMoveClient did exactly this on room 49, accepting a 3300-unit
  // chord whose second 64-unit piece it refused when asked separately.
  const lazy = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 1000) return true;                 // long spans wave everything through
    return !(a.x >= 100 && a.x < 200);         // and a short piece in the middle is refused
  };
  ok(lazy({ x: 0, y: 0 }, { x: 3300, y: 0 }), 'the lazy edge accepts the whole span');
  const c = chordWalkable({ x: 0, y: 0 }, { x: 3300, y: 0 }, { edge: lazy });
  ok(!c.ok, 'stepping it finds the refusal the long call missed');
  eq(c.refusedAt, 3, 'naming which piece');
  eq(c.of, 52, 'of how many');
  eq(c.distance, 3300, 'and the distance asked about');
}
{
  const c = chordWalkable({ x: 0, y: 0 }, { x: 640, y: 0 }, { edge: open });
  ok(c.ok, 'an open chord walks');
  eq(c.of, 10, 'in ten lattice pieces');
  ok(c.refusedAt === undefined, 'with nothing refused');
}
{
  // A chord shorter than one lattice step is still one piece, never zero.
  const c = chordWalkable({ x: 0, y: 0 }, { x: 16, y: 0 }, { edge: open });
  eq(c.of, 1, 'a sub-lattice chord is one piece');
  ok(c.ok, 'and walks if the edge allows it');
  ok(!chordWalkable({ x: 0, y: 0 }, { x: 16, y: 0 }, { edge: () => false }).ok,
     'and does not if it does not');
}
{
  // Zero length: nothing to walk, and it must not divide by zero or loop for ever.
  const c = chordWalkable({ x: 5, y: 5 }, { x: 5, y: 5 }, { edge: open });
  eq(c.of, 1, 'a zero-length chord is one trivial piece');
  eq(c.distance, 0, 'of no distance');
}
{
  // AND furthestTraceable NOW USES IT: a lazy edge must not produce a long false aim.
  const lazy = (a, b) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 1000) return true;
    return !(a.x >= 100 && a.x < 200);
  };
  const rail = [];
  for (let k = 0; k <= 60; k++) rail.push({ x: k * 64, y: 0, f: 1 });
  const a = furthestTraceable(rail, { x: 0, y: 0 }, { edge: lazy, maxAhead: 60 });
  ok(a.i <= 3, 'the aim stops at the real obstruction, not where the lazy long call allowed');
  ok(a.dist <= 200, 'so the leg is honest about how far it can actually go');
}

// ---- furthestTraceable: ASK the geometry, do not estimate --------------------------------
{
  // A straight rail in an open world: the aim should reach as far as it is allowed to look.
  const rail = [];
  for (let k = 0; k <= 40; k++) rail.push({ x: k * 64, y: 0, f: 1 });
  const a = furthestTraceable(rail, { x: 0, y: 0 }, { edge: open, maxAhead: 10 });
  eq(a.i, 10, 'an open straight rail is chord-reachable as far as maxAhead');
  eq(a.spanned, 10, 'spanning ten waypoints in one leg');
  ok(!a.fallback, 'and it is not a fallback');
}
{
  // A WALL, refused by POSITION rather than by chord length. Once a chord is checked by stepping
  // it, "only short chords are walkable" stops being a meaningful fixture — every 64-unit piece is
  // short. A real obstruction sits somewhere, and the aim must stop before it.
  const wallAt256 = (p, q) => !(q.x > 250 && q.x < 320);
  const rail = [];
  for (let k = 0; k <= 40; k++) rail.push({ x: k * 64, y: 0, f: 1 });
  const a = furthestTraceable(rail, { x: 0, y: 0 }, { edge: wallAt256, maxAhead: 20 });
  eq(a.i, 3, 'the aim stops at the last waypoint before the wall');
  eq(a.dist, 192, 'which is 192 units, not the 1280 maxAhead would have allowed');
  ok(!a.fallback, 'this is a real answer, not a fallback');
}
{
  // NOTHING ahead is chord-reachable: the fallback is one validated lattice step, and it SAYS so.
  const a = furthestTraceable([{ x: 0, y: 0, f: 1 }, { x: 64, y: 0, f: 1 }, { x: 128, y: 0, f: 1 }],
                              { x: 0, y: 0 }, { edge: () => false });
  ok(a.fallback, 'a rail with no walkable chord falls back');
  eq(a.i, 1, 'to the next waypoint');
  ok(/no chord from here/.test(a.why), 'and says why, which is a stronger statement than "short leg"');
}
{
  // CONTIGUITY, not the best hit. Walkability along a rail is not monotonic, so a reachable
  // waypoint BEYOND an unreachable one must not be claimed — the body cannot skip the gap.
  const gapAt3 = (p, q) => !(q.x === 192);
  const rail = [];
  for (let k = 0; k <= 10; k++) rail.push({ x: k * 64, y: 0, f: 1 });
  const a = furthestTraceable(rail, { x: 0, y: 0 }, { edge: gapAt3, maxAhead: 10 });
  eq(a.i, 2, 'it stops before the gap');
  ok(!a.fallback, 'having found a real answer');
}
{
  // The budget still caps it, because a leg must also fit the walker's step allowance.
  const rail = [];
  for (let k = 0; k <= 40; k++) rail.push({ x: k * 64, y: 0, f: 1 });
  const a = furthestTraceable(rail, { x: 0, y: 0 }, { edge: open, maxAhead: 40, budget: 500 });
  ok(a.dist <= 500, 'the aim respects the distance budget');
  ok(a.i < 40, 'and stops short of the end');
}
{
  eq(furthestTraceable([], { x: 0, y: 0 }, { edge: open }), null, 'an empty rail has no aim');
  eq(furthestTraceable([{ x: 0, y: 0, f: 1 }], { x: 0, y: 0 }, { edge: open }).i, 0,
     'a one-waypoint rail aims at itself');
  eq(furthestTraceable([{ x: 0, y: 0 }], { x: 0, y: 0 }, {}), null,
     'and no edge test means no answer, rather than a guess');
}

// ---- verifyRail: the granularity rule ---------------------------------------------------
{
  const rail = [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 128, y: 64 }];
  ok(verifyRail(rail, { edge: open }).ok, 'an open world verifies');
  eq(verifyRail(rail, { edge: open }).legs, 2, 'and counts its legs');
}
{
  // THE ARTIFACT THIS RULE EXISTS FOR: an edge test that accepts a whole 64-unit step and refuses
  // either half of it. Verifying finer than the flood turns a good rail into a broken one.
  const halfHater = (a, b) => Math.round(Math.hypot(b.x - a.x, b.y - a.y)) >= 64;
  const rail = [{ x: 0, y: 0 }, { x: 64, y: 0 }];
  ok(verifyRail(rail, { edge: halfHater }).ok,
     'a one-lattice-step leg is checked whole, so a half-step-refusing world still verifies');
}
{
  // A long leg IS split, because nothing validated it as one piece.
  const shortOnly = (a, b) => Math.round(Math.hypot(b.x - a.x, b.y - a.y)) <= 64;
  const rail = [{ x: 0, y: 0 }, { x: 1024, y: 0 }];
  const v = verifyRail(rail, { edge: shortOnly });
  ok(v.ok, 'a long leg split into lattice pieces verifies when each piece is walkable');
  const v2 = verifyRail(rail, { edge: (a, b) => a.x < 256 });
  ok(!v2.ok, '...and fails when a piece in the middle is not');
  eq(v2.bad[0].i, 0, 'naming the leg');
  ok(v2.bad[0].piece > 1, 'and which piece of it');
}
{
  eq(verifyRail([], { edge: open }).legs, 0, 'an empty rail has no legs');
  eq(verifyRail([{ x: 0, y: 0 }], { edge: open }).ok, true, 'a single waypoint is trivially fine');
}

console.log(`\nm59-railcut: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
