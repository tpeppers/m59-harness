// THE GUARD FOR m59-stepbench.mjs — offline, pure, no server, no DM.
//
//   node tools/m59-stepbench-test.mjs
//
// The bench exists to stop a mover change being credited with an improvement it did not make, so the
// cases that matter most here are the ones where it must ABSTAIN.
import { stepMatrix, recordStep, summariseBench, compareBenches, formatBench, HEADINGS, DISTANCES,
         stepRequest, checkCell, cellReach, MIN_MOVER_REACH_CLIENT, MAX_MOVER_REACH_CLIENT }
  from './m59-stepbench.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

// ---- the matrix is deterministic, so two runs are comparable cell by cell ----------------
{
  const m = stepMatrix({ repeats: 2 });
  eq(m.length, 8 * 3 * 2, 'eight headings x three distances x two repeats');
  eq(m[0], { heading: 'N', dx: 0, dy: -1, distance: 128, repeat: 0 }, 'first cell is N at one step');
  const again = stepMatrix({ repeats: 2 });
  eq(JSON.stringify(m), JSON.stringify(again), 'the same matrix twice — order is not incidental');
  eq(stepMatrix({ headings: [['E', 1, 0]], distances: [64], repeats: 1 }).length, 1, 'and it narrows');
  // EVERY DEFAULT DISTANCE MUST BE ONE THE MOVER CAN ACTUALLY TRAVEL IN ONE STEP. The old first
  // entry, 64, was below walkFine's own step floor, so an eighth of the matrix measured dither.
  eq(DISTANCES, [128, 256, 512], 'the reaches are all inside the mover\'s one-step range');
  eq(HEADINGS.length, 8, 'all eight headings');
}

// ---- THE CELL HAS TO BE ONE THE MOVER CAN EXECUTE -----------------------------------------
{
  eq(cellReach({ dx: 0, dy: 1, distance: 256 }), 256, 'a cardinal cell asks for its distance');
  ok(Math.abs(cellReach({ dx: 1, dy: -1, distance: 256 }) - 362.04) < 0.01,
     '...and a DIAGONAL one asks for 1.41x that, on each axis');

  // The defect that produced the first baseline: 64 client units is below the mover's floor.
  const tooNear = checkCell({ heading: 'NE', dx: 1, dy: -1, distance: 45 });
  ok(tooNear, 'a cell inside the mover\'s minimum step is refused');
  ok(/dither/.test(tooNear), '...and says the body will dither rather than blaming geometry');
  ok(checkCell({ heading: 'N', dx: 0, dy: -1, distance: 64 }),
     'even a CARDINAL 64-unit cell is unmeasurable — 64 is a lattice step, not a mover step');
  ok(!checkCell({ heading: 'N', dx: 0, dy: -1, distance: MIN_MOVER_REACH_CLIENT }),
     'exactly at the floor is measurable');

  // And past the stride it is a walk, not a step — a different measurement wearing this one's name.
  const tooFar = checkCell({ heading: 'E', dx: 1, dy: 0, distance: MAX_MOVER_REACH_CLIENT + 64 });
  ok(tooFar && /not a step/.test(tooFar), 'past the stride it is a walk and says so');
  // The diagonal is the one that trips this: 512 on each axis is 724 units, still inside; 576 is not.
  ok(!checkCell({ heading: 'SE', dx: 1, dy: 1, distance: 512 }), 'the largest default diagonal fits');
  ok(DISTANCES.every((d) => HEADINGS.every(([h, dx, dy]) => !checkCell({ heading: h, dx, dy, distance: d }))),
     'EVERY cell of the default matrix is measurable — including the diagonals');
}

// ---- stepRequest: the two settings that were wrong in the first baseline ------------------
{
  const cell = { heading: 'E', dx: 1, dy: 0, distance: 256, repeat: 0 };
  const r = stepRequest(cell, { x: 16000, y: 16000 });
  ok(r.ok, 'a measurable cell produces a request');
  eq(r.args.max_steps, 1, 'ONE step — more than one is a search, not a measurement');
  ok(r.args.arrive_within * 16 < cellReach(cell),
     'the tolerance is strictly smaller than the aim, or walkFine arrives without moving');
  eq(r.aimClient, { x: 16256, y: 16000 }, 'the aim is the displacement, in client units');
  eq(r.args.x, 1080, 'and the wire gets protocol units');
  eq(r.args.y, 1064, '...on both axes');
  eq(r.requested, 256, 'the request states the true reach');

  // hold_shelf is the thing under experiment, so it is the caller's to set — and it narrows the fan.
  eq(stepRequest(cell, { x: 0, y: 0 }).args.hold_shelf, true, 'hold_shelf defaults on');
  eq(stepRequest(cell, { x: 0, y: 0 }, { holdShelf: false }).args.hold_shelf, false, '...and is settable');

  // AN UNMEASURABLE CELL PRODUCES NO REQUEST AT ALL. A bench cannot skip what it never asked.
  const no = stepRequest({ heading: 'NE', dx: 1, dy: -1, distance: 45 }, { x: 0, y: 0 });
  ok(!no.ok && /dither/.test(no.why), 'an unmeasurable cell is refused a request, with the reason');
  eq(no.args, undefined, '...and carries no arguments to send by accident');
}

const cell = { heading: 'S', dx: 0, dy: 1, distance: 256, repeat: 0 };
const at = (x, y) => ({ x, y });

// ---- recordStep: the POSITION is the receipt ---------------------------------------------
{
  // A clean step: moved the full distance, nothing slid.
  const r = recordStep(cell, { reply: { arrived: true, log: [{ step: 0, slid: 0, to: { x: 1100, y: 1116 } }] },
                               before: at(16000, 16000), after: at(16000, 16256), keeperPid: 47340 });
  eq(r.movedBy, 256, 'the movement is measured from the two position reads');
  ok(!r.contacted, 'and nothing was contacted');
  eq(r.falseArrival, false, 'so it is not a false arrival');
  eq(r.deflection, 0, 'and it went exactly where it was aimed');
  eq(r.keeperPid, 47340, 'stamped with the build that produced it');
}
{
  // THE SHAPE THIS CODEBASE KEEPS BELIEVING: arrived true, body stationary.
  const r = recordStep(cell, { reply: { arrived: true, log: [{ step: 0, slid: 0.35, to: { x: 1100, y: 1100 } }] },
                               before: at(16000, 16000), after: at(16000, 16000) });
  eq(r.movedBy, 0, 'nothing moved');
  ok(r.contacted, 'something was contacted');
  ok(r.falseArrival, 'and arrived:true with zero movement is flagged as a FALSE ARRIVAL');
  eq(r.deflection, null, 'with no direction to speak of');
}
{
  // Shelf refusals count as contact even when the log shows no slide — the guard refused before a
  // step was taken, which is contact with geometry by any useful definition.
  const r = recordStep(cell, { reply: { arrived: false, log: [], shelf_refusals: 12 },
                               before: at(16000, 16000), after: at(16000, 16000) });
  ok(r.contacted, 'shelf refusals are contact');
  eq(r.shelfRefusals, 12, 'and the count is kept');
  ok(!r.falseArrival, 'but arrived:false is not a false arrival');
}
{
  // DEFLECTION: asked to go south, went east. That angle is what the fan is getting wrong and it
  // is invisible in a distance-only measurement.
  const r = recordStep(cell, { reply: { arrived: false, log: [{ step: 0, slid: 1.2, to: { x: 1116, y: 1100 } }] },
                               before: at(16000, 16000), after: at(16256, 16000) });
  eq(r.movedBy, 256, 'it moved the full distance');
  ok(r.deflection > 1.5 && r.deflection < 1.6, '...ninety degrees off the heading it was given');
  ok(r.contacted, 'having hit something on the way');
}
{
  // Missing reads must not silently become zero movement.
  const r = recordStep(cell, { reply: { arrived: true, log: [] }, before: null, after: null });
  eq(r.movedBy, null, 'no position reads means movement is UNKNOWN, not zero');
  eq(r.falseArrival, false, '...and cannot be called a false arrival either');
}

// ---- summariseBench ----------------------------------------------------------------------
{
  const rows = [
    recordStep({ heading: 'S', dx: 0, dy: 1, distance: 64, repeat: 0 },
               { reply: { arrived: true, log: [{ step: 0, slid: 0.35, to: { x: 1, y: 1 } }] },
                 before: at(0, 0), after: at(0, 0), keeperPid: 1 }),
    recordStep({ heading: 'S', dx: 0, dy: 1, distance: 64, repeat: 1 },
               { reply: { arrived: true, log: [{ step: 0, slid: 0.35, to: { x: 1, y: 1 } }] },
                 before: at(0, 0), after: at(0, 0), keeperPid: 1 }),
    recordStep({ heading: 'N', dx: 0, dy: -1, distance: 64, repeat: 0 },
               { reply: { arrived: true, log: [{ step: 0, slid: 0, to: { x: 1, y: 1 } }] },
                 before: at(0, 64), after: at(0, 0), keeperPid: 1 }),
  ];
  const s = summariseBench(rows);
  eq(s.cells, 3, 'three cells');
  eq(s.contactRate, 0.67, 'two of three contacted');
  eq(s.falseArrivals, 2, 'two false arrivals');
  eq(s.movedRate, 0.33, 'one of three actually moved');
  eq(s.keeperPids, [1], 'and the build is recorded');
  eq(s.groups[0].key, 'S@64', 'the worst group comes first');
  eq(s.groups[0].contactRate, 1, 'at a contact rate of one');
  eq(summariseBench([]).cells, 0, 'an empty bench summarises to nothing rather than throwing');
}

// ---- compareBenches: ABSTAINING IS THE POINT --------------------------------------------
{
  const mk = (contact, pid) => ({ cells: 24, contactRate: contact, falseArrivals: 0,
                                  movedRate: 1, keeperPids: [pid], groups: [] });
  const better = compareBenches(mk(0.72, 1), mk(0.30, 2));
  eq(better.verdict, 'BETTER', 'a large fall in contact rate is BETTER');
  eq(better.delta, 0.42, 'with the delta stated');

  eq(compareBenches(mk(0.30, 1), mk(0.72, 2)).verdict, 'WORSE', 'and the reverse is WORSE');

  // THE CASE THAT MATTERS: a small difference is noise and must not be credited.
  const same = compareBenches(mk(0.72, 1), mk(0.68, 2));
  eq(same.verdict, 'NO DIFFERENCE', 'a 0.04 change is inside the noise band');
  ok(/claim nothing/.test(same.why), 'and it says to claim nothing');

  // AND THE TRAP: the same keeper pid means the same build, so nothing was tested at all. A
  // keeper respawn is what loads new mover code, and it happens roughly once a minute with no
  // announcement — comparing across a run where no respawn occurred proves nothing.
  const sameBuild = compareBenches(mk(0.72, 5), mk(0.30, 5));
  eq(sameBuild.verdict, 'SAME BUILD?', 'sharing a keeper pid is reported before any improvement is');
  ok(/respawn is what loads new mover code/.test(sameBuild.why), 'and it explains why');

  eq(compareBenches(null, mk(0.3, 2)).verdict, 'unknown', 'a missing bench abstains');
  eq(compareBenches({ cells: 0 }, mk(0.3, 2)).verdict, 'unknown', 'and so does an empty one');
}

// ---- formatting --------------------------------------------------------------------------
{
  eq(formatBench({ cells: 0 }), 'no cells', 'an empty bench formats without throwing');
  const s = summariseBench([recordStep(cell, { reply: { arrived: false, log: [] },
                                               before: at(0, 0), after: at(0, 0), keeperPid: 9 })]);
  ok(/1 cell\(s\)/.test(formatBench(s)), 'and a real one names its cell count');
}

console.log(`\nm59-stepbench: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
