#!/usr/bin/env node
// GRINDING AGAINST A WALL, AS EPISODES — offline, no socket, no roster, no git:
//
//   node tools/m59-wallgrind-test.mjs
//
// WHAT THIS PINS. Operator, 2026-09-11: "are units just grinding against walls for hours?"
// Nothing in 651 tools could answer it, because everything recorded about being stuck is a
// POINT EVENT and the question is about DURATION. `m59-stucks.mjs` groups `stuck_backed_up`
// firings by square — that is "how often", and forty bounces in a minute wants a different fix
// from forty minutes of unbroken contact.
//
// THE SECOND SHAPE IS THE ONE NOTHING COULD SEE AT ALL. CLAUDE.md has carried this warning for
// months — "a stall detector that requires STILLNESS misses the commonest way to stand still: a
// two-square shuffle against a wall resets it on every sample" — and a search of every tool for
// "oscillat" returned ZERO on the day this was written. A documented blind spot with no
// instrument is a bug that has been agreed to rather than fixed, so the shuffle cases below are
// the point of the file and not an extra.
import { makeTracker, aggregate, WINDOW, SHUFFLE_MAX_SQUARES, CONTACT_MIN_REFUSALS }
  from './m59-wallgrind.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

// A sample generator: t is seconds, and every sample is TRAVELLING unless told otherwise.
const S = (t, row, col, { refused = null, destination = 39, room = 578 } = {}) =>
  ({ at: t * 1000, room, row, col, refused, destination });

console.log('\na wall leaned on, and how long for');
{
  const tr = makeTracker();
  let ended = [];
  for (let t = 0; t < 10; t++) ended = ended.concat(tr.push(S(t, 20, 30, { refused: 'wall' })));
  ok('nothing is emitted while it is still happening', ended.length === 0);
  // AN EPISODE WITHOUT AN END IS THE POINT EVENT THIS REPLACES, so the emit is on the close.
  const done = tr.push(S(10, 20, 31));            // a step that LANDED — off the wall
  ok('the episode lands when the character moves off', done.length === 1, JSON.stringify(done));
  eq('and it is a wall_contact', done[0]?.kind, 'wall_contact');
  eq('at the square it was leaning on', [done[0]?.room, done[0]?.row, done[0]?.col], [578, 20, 30]);
  eq('carrying the duration, which is the whole question', done[0]?.ms, 10_000);
  eq('and the mover\'s own reason', done[0]?.reason, 'wall');
}

console.log('\nweather is not an episode');
{
  const tr = makeTracker();
  tr.push(S(0, 5, 5, { refused: 'body' }));
  tr.push(S(1, 5, 5, { refused: 'body' }));        // two refusals: under the threshold
  const done = tr.push(S(2, 5, 6));
  ok(`fewer than ${CONTACT_MIN_REFUSALS} refusals is dropped`, done.length === 0,
     JSON.stringify(done));
  // Because the alert that fires on everything is the alert somebody switches off, which is
  // this repository's most repeated lesson about instrumentation.
  ok('the threshold is the documented one', CONTACT_MIN_REFUSALS === 3);
}

console.log('\nthe two-square shuffle — the documented blind spot');
{
  const tr = makeTracker();
  let ended = [];
  // Bouncing between two squares for twenty seconds. Every stillness test in the fleet reads
  // this as movement, every sample, for ever. That is the failure being instrumented.
  for (let t = 0; t < 20; t++)
    ended = ended.concat(tr.push(S(t, 27, 40 + (t % 2))));
  ok('nothing emitted mid-shuffle', ended.length === 0);
  const done = tr.flush(20_000);
  ok('the shuffle is caught', done.some(e => e.kind === 'shuffle'), JSON.stringify(done));
  const sh = done.find(e => e.kind === 'shuffle');
  ok('and it is long', sh?.ms >= 14_000, String(sh?.ms));
  eq('over two distinct squares', sh?.squares, 2);
  // THE KEY NEGATIVE: it moved on every single sample.
  ok('caught despite the body moving every sample', true);
}

console.log('\na real walk is not a shuffle');
{
  const tr = makeTracker();
  let ended = [];
  // Crossing a room: new ground every sample.
  for (let t = 0; t < 20; t++) ended = ended.concat(tr.push(S(t, 10, 10 + t)));
  ended = ended.concat(tr.flush(20_000));
  ok('a character making progress is never flagged',
     !ended.some(e => e.kind === 'shuffle'), JSON.stringify(ended));

  // And slow progress is still progress — the test is DISTINCT SQUARES, not displacement,
  // which is what separates a legitimately slow crossing from a wedge.
  const tr2 = makeTracker();
  let e2 = [];
  for (let t = 0; t < 24; t++) e2 = e2.concat(tr2.push(S(t, 10, 10 + Math.floor(t / 3))));
  e2 = e2.concat(tr2.flush(24_000));
  ok('slow but genuine progress is not a shuffle',
     !e2.some(x => x.kind === 'shuffle'), JSON.stringify(e2));
}

console.log('\nnot every stationary character is grinding');
{
  // A CHARACTER WITH NOWHERE TO BE IS RESTING, NOT STUCK. An inn, a safe wall held on purpose,
  // a parked body — all identical to a position sampler and none of them a defect.
  const tr = makeTracker();
  let ended = [];
  for (let t = 0; t < 20; t++)
    ended = ended.concat(tr.push(S(t, 3, 3, { refused: 'wall', destination: null })));
  ended = ended.concat(tr.flush(20_000));
  eq('no destination means no episode', ended.length, 0);

  // And a journey that ends closes the episode rather than running across the gap.
  const tr2 = makeTracker();
  for (let t = 0; t < 6; t++) tr2.push(S(t, 3, 3, { refused: 'wall' }));
  const done = tr2.push(S(6, 3, 3, { refused: 'wall', destination: null }));
  ok('arriving closes an open episode', done.length === 1 && done[0].ms === 6_000,
     JSON.stringify(done));
}

console.log('\nthe stream ending must not lose the long ones');
{
  // A keeper restarts about once a minute. Dropping whatever is open would systematically
  // discard exactly the long episodes this exists to find — the bias would be invisible and
  // would point the wrong way.
  const tr = makeTracker();
  for (let t = 0; t < 30; t++) tr.push(S(t, 8, 8, { refused: 'wall' }));
  const done = tr.flush(30_000);
  ok('flush emits the open episode', done.length >= 1);
  eq('with its full duration', done.find(e => e.kind === 'wall_contact')?.ms, 30_000);
}

console.log('\nmoving between walls is two episodes, not one');
{
  const tr = makeTracker();
  let out = [];
  for (let t = 0; t < 5; t++) out = out.concat(tr.push(S(t, 1, 1, { refused: 'wall' })));
  for (let t = 5; t < 10; t++) out = out.concat(tr.push(S(t, 2, 2, { refused: 'wall' })));
  out = out.concat(tr.flush(10_000));
  const contacts = out.filter(e => e.kind === 'wall_contact');
  eq('two squares, two episodes', contacts.length, 2);
  eq('and they are the right squares', contacts.map(c => c.col), [1, 2]);
}

console.log('\na gap in the samples is a new stream, not a long episode');
{
  // THIS WAS A REAL BUG, FOUND BY THE END-TO-END CHECK RATHER THAN BY A UNIT TEST. Samples stop
  // whenever a keeper restarts (about once a minute), a character logs out, or a pass blocks --
  // and this fleet's passes block for twenty seconds at a time. Carrying the ring across the
  // silence dated an episode to before it: a ninety-second shuffle reported as FIFTY MINUTES,
  // in the one number the whole tool exists to produce.
  const tr = makeTracker();
  for (let t = 0; t < 6; t++) tr.push(S(t, 4, 4, { refused: 'wall' }));
  const done = tr.push(S(600, 4, 4, { refused: 'wall' }));   // ten minutes later
  ok('the gap closes the old episode', done.length === 1, JSON.stringify(done));
  // Charged to its OWN last sample, never to the far side of the silence nobody watched.
  eq('and it is charged only for what was observed', done[0]?.ms, 5_000);

  // The new stream starts clean rather than inheriting the old clock. The sample that arrives
  // AFTER the silence is the one that opens the new episode, so t=600..606 is seven seconds --
  // not six. Worth stating, because the off-by-one here is the difference between an episode
  // dated from when it was first observed and one dated from the second observation of it.
  for (let t = 601; t < 607; t++) tr.push(S(t, 4, 4, { refused: 'wall' }));
  const after = tr.flush(607_000);
  eq('the episode after the gap is its own, dated from its first sample', after[0]?.ms, 7_000);
  ok('and nowhere near the ten-minute silence before it', after[0]?.ms < 60_000);
}

console.log('\nrolling up into what is kept for ever');
{
  const eps = [
    { kind: 'wall_contact', room: 578, row: 20, col: 30, ms: 2_000, reason: 'wall' },
    { kind: 'wall_contact', room: 578, row: 20, col: 30, ms: 4_000, reason: 'wall' },
    { kind: 'wall_contact', room: 578, row: 20, col: 30, ms: 2_400_000, reason: 'wall' },
    { kind: 'shuffle', room: 599, row: 5, col: 5, ms: 60_000, reason: null },
  ];
  const rolled = aggregate(eps, { epoch: 'abc1234' });
  eq('one bucket per place and kind', rolled.length, 2);
  const wall = rolled.find(r => r.kind === 'wall_contact');
  eq('counted', wall.count, 3);
  eq('total time is the headline', wall.ms_total, 2_406_000);
  eq('and the worst single episode survives the roll-up', wall.ms_max, 2_400_000);
  // THE REASON THERE IS NO MEAN. Two bounces and one forty-minute grind average to something
  // unremarkable, and the forty-minute one is the entire finding.
  ok('p50 stays small while the max is huge — the mean would have hidden it',
     wall.ms_p50 <= 4_000 && wall.ms_max === 2_400_000, `p50=${wall.ms_p50}`);
  eq('every bucket carries the epoch that produced it', wall.epoch, 'abc1234');

  // A checkout with no git is not "the current epoch" — it is an unknown one, and saying so
  // is the difference between comparable evidence and a silent lie.
  eq('a missing epoch is recorded as unknown, never as current',
     aggregate(eps, {})[0].epoch, 'unknown');
  eq('an empty roll-up is empty, not an error', aggregate([]).length, 0);
  eq('junk is skipped rather than thrown on', aggregate([null, { kind: 'x' }]).length, 0);
}

console.log('\nthe window is the autopilot\'s own');
{
  // Two different widths for one question is how `pennedIn` nearly got switched off by a
  // careless widening of the ring it shares. Pinned so the next change has to be deliberate.
  eq('WINDOW matches PULSE_SAMPLES', WINDOW, 6);
  eq('a shuffle is at most three squares', SHUFFLE_MAX_SQUARES, 3);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
