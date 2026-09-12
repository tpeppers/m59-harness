// THE GUARD FOR m59-steptrace.mjs — offline, pure, no socket.
//
//   node tools/m59-steptrace-test.mjs
//
// The logs below are the shapes walkFine actually returns, including the real one from a hand call
// on 2026-09-12 where every step slid 0.35 radians and the body did not move while the reply said
// `arrived: true`.
import { analyseLeg, verdictOf, summariseLegs, MAX_PLAUSIBLE_STEP, PROTOCOL_TO_CLIENT }
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

console.log(`\nm59-steptrace: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
