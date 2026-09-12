// THE GUARD FOR m59-steptrace.mjs — offline, pure, no socket.
//
//   node tools/m59-steptrace-test.mjs
//
// The logs below are the shapes walkFine actually returns, including the real one from a hand call
// on 2026-09-12 where every step slid 0.35 radians and the body did not move while the reply said
// `arrived: true`.
import { analyseLeg, verdictOf, summariseLegs, slideShape, MIN_MOVER_STEP,
         MAX_PLAUSIBLE_STEP, PROTOCOL_TO_CLIENT }
  from './m59-steptrace.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

const at = (x, y, col = 1, row = 1) => ({ x, y, col, row });

eq(PROTOCOL_TO_CLIENT, 16, 'protocol to client is x16');

// ---- THE REAL LOG. Hand call, r23c18, 2026-09-12. ---------------------------------------
{
  // Three logged steps, every one slid, all landing on the SAME protocol point, and the reply
  // claiming arrival. This is the shape that was believed eleven consecutive times.
  const reply = {
    arrived: true, steps: 5,
    log: [{ step: 0, slid: 0.35, to: at(1167, 1519, 18, 23) },
          { step: 2, slid: 0.35, to: at(1167, 1519, 18, 23) },
          { step: 4, slid: 0.35, to: at(1167, 1519, 18, 23) }],
    note: 'as close as fine movement gets — 52 units, inside one square',
  };
  const a = analyseLeg(reply, { requested: 1080, from: at(1167, 1519, 18, 23) });
  eq(a.net, 0, 'the body netted nothing');
  eq(a.travelled, 0, 'and travelled nothing');
  eq(a.slid, 3, 'every logged step slid');
  eq(a.slidFraction, 1, 'which is all of them');
  eq(a.revisits, 3, 'and it sat on one point four times over');
  eq(a.shortfall, 1080, 'falling the whole request short');
  const v = verdictOf(a);
  eq(v.verdict, 'BLOCKED', 'the verdict is BLOCKED, not arrived');
  ok(/heading is wrong, not the budget/.test(v.why), 'and it says the heading is the problem');
  ok(a.arrived === true, '...while the reply itself still says arrived:true — kept, not hidden');
}

// ---- the four causes stay four ----------------------------------------------------------
{
  // SLOW: steady progress, simply not enough of it. 8 steps x 64 client units = 512.
  const log = [];
  for (let i = 1; i <= 8; i++) log.push({ step: i, slid: 0, to: at(1000 + i * 4, 1000) });
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps', log },
                       { requested: 2496, from: at(1000, 1000) });
  eq(a.net, 512, 'net is the straight-line distance covered');
  eq(a.waste, 0, 'a straight walk wastes nothing');
  eq(a.efficiency, 1, 'and is perfectly efficient');
  eq(verdictOf(a).verdict, 'SLOW', 'so the verdict is SLOW — raise the budget');
  ok(/nothing is blocking/.test(verdictOf(a).why), 'and it says so explicitly');
}
{
  // GRINDING: out and back, repeatedly. Ground covered, nothing gained, points revisited.
  const log = [];
  for (let i = 1; i <= 10; i++) log.push({ step: i, slid: 0, to: at(1000 + (i % 2) * 20, 1000) });
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps', log },
                       { requested: 2496, from: at(1000, 1000) });
  ok(a.waste >= 256, 'the waste is real ground covered for nothing');
  ok(a.revisits > 0, 'and points were revisited');
  eq(verdictOf(a).verdict, 'GRINDING', 'which is GRINDING');
  ok(/stillness-based stall detector reads it as healthy/.test(verdictOf(a).why),
     'and the reason names why every existing detector misses it');
}
{
  // TELEPORTED: one step longer than a walk can carry a body — a fall, or another writer.
  const a = analyseLeg({ arrived: true, log: [{ step: 1, slid: 0, to: at(1100, 1000) }] },
                       { requested: 512, from: at(1000, 1000) });
  ok(a.teleports.length === 1, 'an implausible step is flagged');
  eq(verdictOf(a).verdict, 'TELEPORTED', 'and it outranks every other verdict');
  ok(a.steps[0].gained > MAX_PLAUSIBLE_STEP, 'because the gain exceeds one tick of run pace');
}
{
  // A SAMPLED LOG IS NOT A TELEPORT. walkFine logs notable steps only — a real reply reads
  // `step 0, 2, 4` — so the gap between entries covers several steps. The first live run of this
  // analyser called four of seven ordinary walking legs TELEPORTED for exactly this reason.
  const a = analyseLeg({ log: [{ step: 0, slid: 0.35, to: at(1000, 1000) },
                               { step: 20, slid: 0.35, to: at(1200, 1000) }] },
                       { requested: 4096, from: at(1000, 1000) });
  eq(a.steps[1].spanned, 20, 'the entry accounts for twenty steps');
  eq(a.steps[1].gained, 3200, 'which covered 3200 client units in total');
  eq(a.steps[1].perStep, 160, '...that is 160 per step — well inside run pace');
  eq(a.teleports.length, 0, 'so it is NOT a teleport');
  ok(verdictOf(a).verdict !== 'TELEPORTED', 'and the verdict says something useful instead');
}
{
  // ...but a genuine jump inside ONE step still is.
  const a = analyseLeg({ log: [{ step: 0, slid: 0, to: at(1000, 1000) },
                               { step: 1, slid: 0, to: at(1100, 1000) }] },
                       { requested: 512, from: at(1000, 1000) });
  eq(a.steps[1].spanned, 1, 'one step');
  ok(a.steps[1].perStep > MAX_PLAUSIBLE_STEP, 'that covered more than run pace allows');
  eq(verdictOf(a).verdict, 'TELEPORTED', 'is still a teleport');
}
{
  // BLOCKED needs BOTH low efficiency and little net movement, or a long messy-but-productive
  // leg would be mislabelled.
  const log = [];
  for (let i = 1; i <= 20; i++) log.push({ step: i, slid: 0.35, to: at(1000 + i * 8, 1000 + (i % 2) * 2) });
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps', log }, { requested: 4096, from: at(1000, 1000) });
  ok(a.net > 256, 'a leg that covered real ground');
  ok(verdictOf(a).verdict !== 'BLOCKED', 'is not called BLOCKED just because its steps slid');
}

// ---- AN EMPTY LOG WITH REFUSALS IS THE GUARD SPEAKING ----------------------------------
{
  // The real shape, twenty of twenty-two legs on 2026-09-12: no log at all, and seventy-plus
  // shelf refusals. Scoring that as "unknown" discards the loudest signal in the reply.
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps', log: [],
                         shelf_refusals: 72, dest_floor: 6144 },
                       { requested: 3399, from: at(1170, 1520, 18, 23) });
  eq(a.stepsMeasured, 0, 'nothing was measured, because no step was taken');
  eq(a.shelfRefusals, 72, 'but the refusal count is there');
  const v = verdictOf(a);
  eq(v.verdict, 'GUARD-REFUSED', 'so the verdict names the guard, not ignorance');
  ok(/the AIM is what needs fixing/.test(v.why), 'and points at the aim rather than the mover');
}
{
  // No log AND no refusals really is unknown — the distinction has to survive.
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps', log: [] }, { requested: 1024 });
  eq(verdictOf(a).verdict, 'unknown', 'an empty log with no refusals stays unknown');
}
{
  // Zero refusals explicitly reported is still not a guard refusal.
  const a = analyseLeg({ log: [], shelf_refusals: 0 }, { requested: 1024 });
  eq(verdictOf(a).verdict, 'unknown', 'shelf_refusals: 0 is not the guard speaking');
}

// ---- BLOCKED IS RELATIVE TO THE REQUEST ------------------------------------------------
{
  // A STEP-MODE LEG. It asked for 64 client units and travelled 35 of them — slow and scraping,
  // but not "could not move at all". An absolute 128-unit floor called 39 of 49 such legs BLOCKED.
  const a = analyseLeg({ arrived: true, log: [{ step: 0, slid: 0.35, to: at(1000, 1000) },
                                              { step: 1, slid: 0.35, to: at(1002, 1000) }] },
                       { requested: 64, from: at(1000, 1000) });
  eq(a.travelled, 32, 'it travelled 32 client units');
  ok(verdictOf(a).verdict !== 'BLOCKED',
     'against a 64-unit request that is not BLOCKED — half the leg is not immobility');
}
{
  // The SAME 32 units against a 3400-unit request IS blocked.
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps',
                         log: [{ step: 0, slid: 0.35, to: at(1000, 1000) },
                               { step: 1, slid: 0.35, to: at(1002, 1000) }] },
                       { requested: 3400, from: at(1000, 1000) });
  eq(verdictOf(a).verdict, 'BLOCKED', 'the same travel against a long request is BLOCKED');
  ok(/against 3400 requested/.test(verdictOf(a).why), 'and the reason names both numbers');
}
{
  // With no request to compare against, the absolute floor still applies — it is the only
  // information available, and abstaining entirely would be worse.
  const a = analyseLeg({ log: [{ step: 0, slid: 0.35, to: at(1000, 1000) },
                               { step: 1, slid: 0.35, to: at(1001, 1000) }] }, {});
  eq(verdictOf(a).verdict, 'BLOCKED', 'no request falls back to the absolute floor');
}

// ---- abstaining is a real answer -------------------------------------------------------
{
  const a = analyseLeg({ arrived: false, reason: 'ran out of steps' }, { requested: 1024 });
  eq(a.stepsMeasured, 0, 'a reply with no log measures nothing');
  eq(verdictOf(a).verdict, 'unknown', 'and the verdict abstains rather than guessing');
  ok(/nothing to read/.test(verdictOf(a).why), 'saying why');
  eq(verdictOf(null).verdict, 'unknown', 'a null analysis abstains too');
}
{
  // A log whose entries carry no `to` cannot be measured, and must not be counted as movement.
  const a = analyseLeg({ log: [{ step: 0, slid: 0.35 }, { step: 1, slid: 0 }] }, { from: at(1000, 1000) });
  eq(a.stepsMeasured, 0, 'entries without a position measure nothing');
  eq(a.slid, 1, 'though the slid count still reads what is there');
}

// ---- the from-point matters -------------------------------------------------------------
{
  // Without `from`, the first logged point is the origin and the step that got there is invisible.
  const log = [{ step: 0, slid: 0, to: at(1004, 1000) }, { step: 1, slid: 0, to: at(1008, 1000) }];
  const withFrom = analyseLeg({ log }, { from: at(1000, 1000) });
  const without = analyseLeg({ log }, {});
  eq(withFrom.net, 128, 'with a start point, the whole leg is measured');
  eq(without.net, 64, 'without one, the first step is lost — so callers should pass it');
}

// ---- summariseLegs ----------------------------------------------------------------------
{
  const blocked = analyseLeg({ log: [{ step: 0, slid: 0.35, to: at(1000, 1000) },
                                     { step: 1, slid: 0.35, to: at(1000, 1000) }] },
                             { requested: 1024, from: at(1000, 1000) });
  const slowLog = [];
  for (let i = 1; i <= 8; i++) slowLog.push({ step: i, slid: 0, to: at(1000 + i * 4, 1000) });
  const slow = analyseLeg({ log: slowLog }, { requested: 2496, from: at(1000, 1000) });

  const s = summariseLegs([blocked, slow, blocked]);
  eq(s.legs, 3, 'three legs');
  eq(s.netTotal, 512, 'net across all of them');
  ok(s.wasteFraction != null, 'with a waste fraction');
  eq(s.verdicts[0].verdict, 'BLOCKED', 'and the commonest verdict first');
  eq(s.verdicts[0].legs, 2, 'with its count');
  eq(summariseLegs([]).legs, 0, 'an empty run summarises to nothing rather than throwing');
}

// ---- slideShape: WHICH WAY the fan kept turning ------------------------------------------
//
// A slide COUNT cannot tell a zigzag from an orbit, and they are different bugs. Alternating
// offsets cancel and still converge; same-sign offsets are a constant turn relative to a goal
// walkFine re-aims at every step, which is a circle.
{
  const L = (...slids) => slids.map((slid, step) => ({ step, slid, to: { x: 1000 + step, y: 1000 } }));

  const zig = slideShape(L(0.35, -0.35, 0.35, -0.35, 0.35));
  eq(zig.slideAlternation, 1, 'a perfect zigzag alternates on every pair');
  eq(zig.directTaken, 0, 'and never got the direct heading');

  const orbit = slideShape(L(0.35, 0.35, 0.35, 0.35, 0.35));
  eq(orbit.slideAlternation, 0, 'a constant deflection never alternates — THE ORBIT SIGNATURE');
  eq(orbit.slideBias, { offset: 0.35, steps: 5, share: 1 }, 'and the bias names the offset it kept');

  const clean = slideShape(L(0, 0, 0));
  eq(clean.directTaken, 3, 'steps that did not slide are counted as the direct heading taken');
  eq(clean.slideBias, null, 'with no bias to report');
  eq(clean.slideAlternation, null, '...and no alternation, rather than a misleading zero');

  eq(slideShape([]).slideBias, null, 'an empty log reports null rather than throwing');
  eq(slideShape([]).directTaken, null, '...and does not claim the direct heading was taken');
  // ONE slide cannot alternate with anything, and calling that 0 would read as an orbit.
  eq(slideShape(L(0.35)).slideAlternation, null, 'a single slide has no alternation to report');

  // Mixed magnitudes, same sign: still an orbit. The SIGN is what accumulates, not the size.
  const wide = slideShape(L(0.35, 0.75, 1.2, 0.35, 0.75));
  eq(wide.slideAlternation, 0, 'different magnitudes with one sign still never alternate');
  eq(wide.slideBias.offset, 0.35, 'and the bias is the commonest offset');
}

// ---- ORBIT: the verdict GRINDING structurally cannot reach --------------------------------
{
  // Marco's shape, room 49: the body walks a long way, keeps its deflection sign, and arrives
  // nowhere — WITHOUT revisiting an exact protocol point, which is what GRINDING requires. Before
  // this verdict existed the worst legs in the repository fell through to MIXED.
  // DELIBERATELY NOT A CLOSED LOOP. An orbit does not have to return to a point it has already
  // occupied — that is exactly why GRINDING, which requires a revisited protocol point, cannot see
  // it — so this arc stops short of closing and revisits nothing.
  const circle = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * 0.92 * 2 * Math.PI;          // 0.92 of a turn, radius 40 protocol units
    circle.push({ step: i, slid: 0.35,
                  to: { x: Math.round(1000 + 40 * Math.cos(t)), y: Math.round(1000 + 40 * Math.sin(t)) } });
  }
  const a = analyseLeg({ arrived: false, reason: 'out of steps', log: circle },
                       // `from` is where the body stood BEFORE step 0, so it is deliberately not
                       // the same point as the first log entry — passing (1040,1000) made it
                       // identical to it and manufactured the one revisit this case must not have.
                       { requested: 4096, from: { x: 1036, y: 998 } });
  ok(a.travelled > 2000, 'the body covered real ground');
  ok(a.net < 600 && a.net * 6 < a.travelled,
     '...and ended up near where it started: 466 client units net against 3,538 travelled');
  eq(a.revisits, 0, 'without revisiting a single protocol point — so GRINDING cannot see it');
  const v = verdictOf(a);
  eq(v.verdict, 'ORBIT', 'and the verdict is ORBIT');
  ok(/KEPT their sign/.test(v.why), 'it says the deflections kept their sign');
  ok(/constant offset is a/.test(v.why), '...and names the mechanism: a constant turn');
  ok(/available on NONE/.test(v.why), '...and that the direct heading was never available');

  // A ZIGZAG OF THE SAME EFFICIENCY MUST NOT BE CALLED AN ORBIT. Same waste, opposite cause, and
  // the fix for one is not the fix for the other.
  const zz = [];
  for (let i = 0; i < 24; i++)
    zz.push({ step: i, slid: i % 2 ? 0.35 : -0.35,
              to: { x: 1000 + (i % 2 ? 20 : 0), y: 1000 } });
  const zv = verdictOf(analyseLeg({ arrived: false, log: zz }, { requested: 4096, from: { x: 1000, y: 1000 } }));
  ok(zv.verdict !== 'ORBIT', 'an alternating leg of the same efficiency is NOT an orbit');

  // And an efficient same-sign leg is a CURVE, not an orbit: a constant turn that still arrives is
  // simply a body going round a corner, which is the fan doing its job.
  const curve = [];
  for (let i = 0; i < 12; i++) curve.push({ step: i, slid: 0.35, to: { x: 1000 + i * 20, y: 1000 + i } });
  const cv = verdictOf(analyseLeg({ arrived: true, log: curve }, { requested: 3520, from: { x: 1000, y: 1000 } }));
  ok(cv.verdict !== 'ORBIT', 'a same-sign leg that MAKES PROGRESS is a curve, not an orbit');

  // A body that barely moved is BLOCKED, and that must still win — it is not orbiting, it is stuck.
  const stuck = [{ step: 0, slid: 0.35, to: { x: 1000, y: 1000 } },
                 { step: 1, slid: 0.35, to: { x: 1001, y: 1000 } },
                 { step: 2, slid: 0.35, to: { x: 1000, y: 1000 } },
                 { step: 3, slid: 0.35, to: { x: 1001, y: 1000 } },
                 { step: 4, slid: 0.35, to: { x: 1000, y: 1000 } }];
  eq(verdictOf(analyseLeg({ arrived: false, log: stuck }, { requested: 2048, from: { x: 1000, y: 1000 } })).verdict,
     'BLOCKED', 'a body that barely moved stays BLOCKED rather than becoming an orbit');
}
// ---- ALREADY-THERE: an empty log with arrived:true is the LOUDEST signal, not a missing one ----
//
// walkFine returns `{arrived:true, steps:0, log:[]}` the moment `remaining <= arriveWithin`. The mover
// is neither refusing nor failing — it is being asked to walk somewhere it already stands, and the
// CALLER is the bug. 53 of Marco's 169 legs were this, filed as `unknown` and read as missing
// telemetry, and 41 of the 53 asked for less than the mover's own minimum step.
{
  const zero = { arrived: true, steps: 0, log: [], shelf_refusals: 0 };

  const near = verdictOf(analyseLeg(zero, { requested: 93 }));
  eq(near.verdict, 'ALREADY-THERE', 'zero steps with arrived:true is its own verdict');
  ok(/already inside arriveWithin/.test(near.why), 'it says the aim was inside the tolerance');
  ok(new RegExp(`BELOW the mover's ${MIN_MOVER_STEP}`).test(near.why),
     '...and that 93 units is below the minimum step');
  ok(/re-issuing it will not help/.test(near.why),
     '...and that retrying cannot fix it, which is what the follower kept doing');
  ok(/The AIM is the bug/.test(near.why), '...and names the caller as the thing to change');
  ok(/skipping waypoints until it clears/.test(near.why), '...with what to do instead');

  // A far aim that still took no step is a DIFFERENT problem — a tolerance set too wide — and must
  // not be blamed on the minimum step.
  const far = verdictOf(analyseLeg(zero, { requested: 4096 }));
  eq(far.verdict, 'ALREADY-THERE', 'a far aim with zero steps is still ALREADY-THERE');
  ok(!/BELOW the mover/.test(far.why), '...but is NOT blamed on the minimum step');
  ok(/4096 client units away/.test(far.why), '...and states the distance so the tolerance is suspect');

  // With no `requested` there is nothing to say about distance, and it must not invent one.
  ok(!/client units away/.test(verdictOf(analyseLeg(zero)).why),
     'without a requested distance it claims nothing about how far');

  // THE THREE EMPTY-LOG CASES STAY DISTINCT. Refusals mean the guard spoke; arrived:true means the
  // caller asked for nothing; neither is "no data".
  eq(verdictOf(analyseLeg({ arrived: false, log: [], shelf_refusals: 70 })).verdict, 'GUARD-REFUSED',
     'an empty log WITH refusals is still the guard speaking');
  eq(verdictOf(analyseLeg({ arrived: false, log: [], shelf_refusals: 0 })).verdict, 'unknown',
     'and an empty log with neither is genuinely unknown — which is now a much smaller set');
}

console.log(`\nm59-steptrace: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
