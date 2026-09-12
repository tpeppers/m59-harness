#!/usr/bin/env node
// THE GUARD FOR m59-pinch.mjs — offline, no map file, no server. The geometry is a fake.
//
//   node tools/m59-pinch-test.mjs
//
// The case that matters is OPEN, because it is the one that reads as good news. A bench sited on open
// ground reports a clean, stable, reproducible contact rate either side of a mover change, and that
// number is about nothing at all: the fan is never consulted, so there is nothing for a fan change to
// move. This tool exists to refuse that site, and these assertions are what stops the refusal rotting
// into a warning nobody reads.
import { pinchAt, pinchPoints, classify, canMeasureFanAt, formatRoom, PINCH_REACHES }
  from './m59-pinch.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

// A fake room. `walls` is a predicate over the DESTINATION point, so a test can shape geometry without
// a .roo: `traceFineMoveClient` is what m59-ground's edge test calls, and `leafAtClient` +
// `floorBaseAtClient` are what its floor probe calls.
const fakeGeo = ({ rows = 3, cols = 3, blocked = () => false, floor = () => 0 } = {}) => ({
  rows, cols,
  leafAtClient: (x, y) => (floor(x, y) == null ? null : { sector: 1 }),
  floorBaseAtClient: (x, y) => floor(x, y),
  traceFineMoveClient: (ax, ay, bx, by) => ({ ok: !blocked(bx, by, ax, ay) }),
});

// ---- classify ----------------------------------------------------------------------------
eq(classify(0), 'open', 'nothing refused is OPEN — and that is a problem, not a compliment');
eq(classify(1), 'pinch', 'one refusal is a pinch');
eq(classify(5), 'pinch', 'five is still a pinch');
eq(classify(6), 'pocket', 'six of eight is a pocket');
eq(classify(8), 'sealed', 'all eight is sealed');
eq(classify(3, 4), 'pocket', 'and the denominator is a parameter, not an assumption');

// ---- pinchAt -----------------------------------------------------------------------------
{
  // Wide open: every heading accepted at every reach.
  const s = pinchAt(fakeGeo(), 2, 2);
  eq(s.refusedCount, 0, 'an open square refuses nothing');
  eq(s.kind, 'open', '...and is classified OPEN');
  eq(s.byReach.length, PINCH_REACHES.length, 'with an answer for every reach');
  eq(s.byReach.map((b) => b.reach), [128, 256, 512], 'the reaches are the mover\'s, in order');
}
{
  // A SQUARE OPEN AT ONE REACH AND PINCHED AT ANOTHER. The fan fires per step, so the verdict has to
  // be the worst reach — reporting only the shortest would call this square open.
  const near = fakeGeo({ blocked: (bx, by, ax, ay) => Math.hypot(bx - ax, by - ay) > 300 && bx > ax });
  const s = pinchAt(near, 2, 2);
  ok(s.byReach[0].refused.length === 0, 'open at 128');
  ok(s.byReach[2].refused.length > 0, '...and pinched at 512');
  ok(s.refusedCount > 0, 'so the SQUARE is pinched');
  eq(s.reach, 512, 'and the verdict names the reach that pinched it');
}
{
  // No floor under the centre is its own answer — NOT the same as unwalkable. r40c52 of the Ancient
  // Place is walkable with no floor at its centre, because the footing is a sliver off to one side.
  eq(pinchAt(fakeGeo({ floor: () => null }), 2, 2), null, 'no floor at the centre yields null');
}

// ---- pinchPoints -------------------------------------------------------------------------
{
  const r = pinchPoints(fakeGeo({ rows: 4, cols: 4 }));
  eq(r.squares, 16, 'every square with a floor is counted');
  eq(r.open, 16, 'all of them open');
  eq(r.pinched, 0, 'none constrained');
  eq(r.openFraction, 1, 'and the fraction says so — the number this tool exists to surface');
  eq(r.noFloor, 0, 'with nothing floorless');
  eq(r.histogram, [[0, 16]], 'the histogram is the distribution, not a mean');
}
{
  // One wall on the east side of the room: the squares against it refuse the eastward headings.
  const walled = fakeGeo({ rows: 3, cols: 3, blocked: (bx) => bx > 2600 });
  const r = pinchPoints(walled);
  ok(r.pinched > 0, 'a wall produces constrained squares');
  ok(r.open < r.squares, '...and not every square is open any more');
  ok(r.sites[0].refusedCount >= r.sites[r.sites.length - 1].refusedCount,
     'most constrained first, because that is the site a bench wants');
  ok(r.sites.every((s) => s.refusedCount > 0), 'and only constrained squares are listed');
}
{
  const r = pinchPoints(fakeGeo({ rows: 2, cols: 2, floor: (x) => (x < 1000 ? 0 : null) }));
  eq(r.noFloor, 2, 'floorless squares are counted separately');
  eq(r.squares, 2, '...and excluded from the squares that have one');
}

// ---- canMeasureFanAt: THE REFUSAL THAT SAVES A RUN ---------------------------------------
{
  const v = canMeasureFanAt(fakeGeo(), 2, 2);
  eq(v.ok, false, 'AN OPEN SQUARE CANNOT ANSWER A FAN QUESTION');
  eq(v.verdict, 'OPEN', '...and the verdict is OPEN rather than a pass');
  ok(/never consults the fan/.test(v.why), 'it says the fan is never consulted');
  ok(/INVISIBLE/.test(v.why), '...and that the change would be invisible');
  ok(/about nothing/.test(v.why), '...and that the resulting number is about nothing');
}
{
  const walled = fakeGeo({ blocked: (bx) => bx > 2600 });
  const v = canMeasureFanAt(walled, 2, 3);
  eq(v.ok, true, 'a constrained square CAN answer');
  ok(/the fan is consulted/.test(v.why), 'and says why');
  ok(v.square.refusedCount > 0, 'carrying the square it judged');
}
{
  const sealed = canMeasureFanAt(fakeGeo({ blocked: () => true }), 2, 2);
  eq(sealed.ok, false, 'a sealed square cannot answer either');
  eq(sealed.verdict, 'SEALED', '...and it is a DIFFERENT refusal from OPEN');
  // The two failures look identical in a contact rate and are opposite in cause: one body never
  // chooses, the other never moves. Collapsing them is how "contact 0" gets read as health.
  ok(/never moved/.test(sealed.why), 'and it warns that zero contact here means a body that never moved');
}
{
  const v = canMeasureFanAt(fakeGeo({ floor: () => null }), 2, 2);
  eq(v.verdict, 'NO FLOOR', 'no floor is its own verdict');
  ok(/NOT the same as unwalkable/.test(v.why), '...and it does not claim the square is unwalkable');
}

// ---- formatting --------------------------------------------------------------------------
{
  const out = formatRoom(pinchPoints(fakeGeo({ rows: 3, cols: 3, blocked: (bx) => bx > 2600 })),
                         { room: 576, limit: 2 });
  ok(/room 576/.test(out), 'the render names the room');
  ok(/OPEN/.test(out), '...leads with how much of it cannot answer');
  ok(/cannot be measured/.test(out), '...and says what that means');
  ok(/refused headings -> squares/.test(out), 'and prints the distribution');
}

console.log(`\nm59-pinch: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
