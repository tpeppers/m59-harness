#!/usr/bin/env node
// A STALL HAS TO NAME ITS LEVER, AND "NONE" IS AN ANSWER RATHER THAN A SILENCE.
//
//   node tools/m59-stall-lever-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// THE GAP (issue #50, suggested direction 3, and the one thing the walk did not close).
// `noProgress` counted idle passes and had exactly one keeper-side lever: blink, selected
// by testing the reason SENTENCE against a regex. A reason that did not match got no lever
// at all, and nothing anywhere said so — the counter went up, `stuck.since` advanced, and
// the character stood still. Measured at 27 minutes, 1,623 seconds, 943 idle passes, zero
// kills, in the character's own assigned farm room, with the detector watching all of it.
//
// The second lever lives outside the keeper — `m59-supervise.mjs` restarts a keeper stalled
// for eight passes — and it is a real lever for a STATEFUL stall, where the thing in the
// way is keeper-local: a room written off for the session, a route given up on, a square's
// failure budget. It is not a lever for a DETERMINISTIC one. A fresh keeper walks into the
// same room with the same orders and re-enters the loop in seconds, once every ninety
// seconds, for ever, and every line of it reads `restarted <character>` as though something
// had happened. That file already refuses the same trap twice by name.
//
// WHAT THIS SUITE PINS. The lever is now data rather than a regex nobody can enumerate;
// `null` is a legitimate answer and travels with the stall to every reader; a stall that
// keeps giving the SAME leverless reason is declared as a refusal with a stable code
// instead of being endured; and the supervisor's restart is bounded against that
// declaration, so the lever that cannot fix it stops firing for ever.
//
// Declaring is not a cure, and it is not pretending to be one. There is no verb here that
// fixes an unknown loop, and inventing one is how a fleet gets 107 room-flees and 0 kills.
// The fix is that "stalled, and nothing here can act on it" is now a state somebody can
// SEE, which is the difference between a character nobody can help and one nobody noticed.
//
// It should fail the day a stall reason can go unclassified again.

import { Autopilot, stallLever, STALL_LEVERS } from './m59-autopilot.mjs';
import { stallRestartDecision, STALL_RESTARTS_BEFORE_GIVING_UP } from './m59-supervise.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOPILOT = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
const KEEPER_PROC = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The reason JohnsSlave's keeper recited 943 times. It is the fixture because it is the
// incident: nothing in `STUCK_IN_PLACE` matches it, and nothing was ever going to.
const THE_LOOP = 'a pull attempt failed transiently; retrying from the same wall';

const keeper = ({ room = 575 } = {}) => {
  const notes = [];
  return Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, tally: {}, policy: {},
    idlePasses: 0, stalledSince: null, stalledWhy: null,
    stalledLever: null, stallRepeats: 0, lastNoProgressWhy: null,
    note: (what, detail) => notes.push({ what, detail }),
    s: { world: { room: { num: room } } },
  });
};

console.log('');
console.log('THE LEVER IS DATA, AND null IS ONE OF ITS ANSWERS');
{
  ok('the lever map is enumerable rather than a regex buried in a branch',
     Object.keys(STALL_LEVERS).length >= 1 && 'blink' in STALL_LEVERS,
     Object.keys(STALL_LEVERS).join(','));

  // UNCHANGED, and that is the point of pinning it: blink still answers the stalls it
  // always answered. This is a classification that was implicit, made explicit.
  for (const why of ['could not reach the safe spot', 'no route to 599',
                     'every square for that exit refused', 'stuck on a ledge',
                     'the room is unreachable', 'no exit from this room at all'])
    ok(`"${why.slice(0, 34)}" is still a blink`, stallLever(why) === 'blink', String(stallLever(why)));

  // AND THESE ARE THE ONES THAT HAD NOTHING. Every one is a real sentence this fleet has
  // stalled on, and not one of them is about getting out of somewhere.
  for (const why of [THE_LOOP, 'out of reach, will approach',
                     'the pull did not complete: nothing to pull',
                     'fought back without landing a hit',
                     'trapped: cannot fight, cannot rest, cannot leave -- needs food or a rescue'])
    ok(`"${why.slice(0, 34)}" has no lever, and says so`, stallLever(why) === null,
       String(stallLever(why)));

  ok('an empty reason is leverless rather than an exception', stallLever(undefined) === null);
}

console.log('');
console.log('THE SAME SENTENCE TWICE IS A DIFFERENT FACT FROM TWO WAYS OF FAILING');
{
  const k = keeper();
  k.noProgress(THE_LOOP);
  k.noProgress(THE_LOOP);
  k.noProgress(THE_LOOP);
  ok('a repeated reason accumulates', k.stallRepeats === 3, String(k.stallRepeats));
  k.noProgress('something else went wrong');
  ok('a different reason starts the run again', k.stallRepeats === 1, String(k.stallRepeats));
  ok('while idle passes keep climbing regardless', k.idlePasses === 4, String(k.idlePasses));

  // A CHARACTER FINDING A NEW OBSTACLE EVERY PASS IS WORKING, and must never be declared.
  const busy = keeper();
  for (let i = 0; i < 60; i++) busy.noProgress('failure number ' + i);
  ok('sixty different leverless failures are not a declared loop',
     !busy.refusals?.has('STALL_NO_LEVER'), JSON.stringify([...(busy.refusals?.keys() ?? [])]));
}

console.log('');
console.log('BLINK IS UNTOUCHED — the lever that already worked still fires');
{
  const k = keeper();
  for (let i = 0; i < 5; i++) k.noProgress('could not reach the safe spot');
  ok('five idle passes on a movement stall still arm the spell', !!k.wantsBlink,
     JSON.stringify(k.wantsBlink));
  ok('and the stall reports blink as its lever', k.stalledLever === 'blink');

  const other = keeper();
  for (let i = 0; i < 5; i++) other.noProgress(THE_LOOP);
  ok('a leverless stall still does not fire a spell at nothing', !other.wantsBlink);
  ok('and reports no lever rather than the last one it saw', other.stalledLever === null);
}

console.log('');
console.log('A STALL NOTHING CAN ACT ON IS DECLARED, NOT ENDURED');
{
  const k = keeper();
  for (let i = 0; i < 19; i++) k.noProgress(THE_LOOP);
  ok('nineteen repeats is patience, not an emergency',
     !k.refusals?.has('STALL_NO_LEVER'), String(k.stallRepeats));
  k.noProgress(THE_LOOP);
  const r = k.refusals?.get('STALL_NO_LEVER');
  ok('the twentieth declares it', !!r, JSON.stringify([...(k.refusals?.keys() ?? [])]));
  ok('with a stable code, blocking work, on the channel the supervisor reads',
     r?.code === 'STALL_NO_LEVER' && r?.faculty === 'work' && r?.blocking === true,
     JSON.stringify(r));
  ok('carrying the sentence that is repeating, so a reader sees WHICH loop',
     typeof r?.why === 'string' && r.why.includes(THE_LOOP), r?.why);
  ok('and a remedy that says a restart is worth one try and not a habit',
     /restart/i.test(String(r?.remedy)) && /deterministic|different room/i.test(String(r?.remedy)),
     r?.remedy);
  ok('the note names the room, which is the first thing anybody asks',
     k.notes.some(n => n.what === 'STALLED WITH NO LEVER' && n.detail?.room === 575));

  // SAID ONCE. A refusal re-announced every pass is a log nobody reads, and `since` has to
  // survive so "how long has this been going on" has an answer.
  const since = r.since;
  const saidAt = k.notes.filter(n => n.what === 'STALLED WITH NO LEVER').length;
  for (let i = 0; i < 30; i++) k.noProgress(THE_LOOP);
  ok('and only once, however long it goes on',
     k.notes.filter(n => n.what === 'STALLED WITH NO LEVER').length === saidAt,
     String(k.notes.filter(n => n.what === 'STALLED WITH NO LEVER').length));
  ok('while `since` keeps answering how long it has been true',
     k.refusals.get('STALL_NO_LEVER').since === since);

  // A STALL WITH A LEVER IS NEVER DECLARED, however long it runs — something can act on it.
  const movable = keeper();
  for (let i = 0; i < 50; i++) movable.noProgress('could not reach the safe spot');
  ok('a movement stall is never declared leverless, at any length',
     !movable.refusals?.has('STALL_NO_LEVER'));
}

console.log('');
console.log('AND IT IS CLEARED BY THE ONLY THING THAT SHOULD CLEAR IT');
{
  const k = keeper();
  for (let i = 0; i < 25; i++) k.noProgress(THE_LOOP);
  ok('declared', k.refusals?.has('STALL_NO_LEVER'));
  k.progress('killed something');
  ok('a character that did something is not refusing any more',
     !k.refusals?.has('STALL_NO_LEVER'));
  ok('and the repeat run goes with it', k.stallRepeats === 0 && k.lastNoProgressWhy === null,
     JSON.stringify({ repeats: k.stallRepeats, last: k.lastNoProgressWhy }));
  ok('and so does the lever', k.stalledLever === null);
  ok('the ordinary stall fields are cleared as they always were',
     k.idlePasses === 0 && k.stalledSince === null);
}

console.log('');
console.log('THE FACT TRAVELS TO EVERY READER, OR IT MIGHT AS WELL NOT EXIST');
{
  // A field added in one publisher and forgotten in the other is how the fleet board
  // reported `stalled: false` for a character standing in a corner for twenty minutes.
  // Both shapes in the pilot, and the keeper process's own /state, or it is not published.
  const stalled = AUTOPILOT.slice(AUTOPILOT.indexOf('      stalled: this.stalledSince'),
                                  AUTOPILOT.indexOf('      refusals: [...'));
  ok('`stalled` carries the lever and the repeat count',
     /lever: this\.stalledLever/.test(stalled) && /repeats: this\.stallRepeats/.test(stalled));
  ok('`stuck` carries them too — it is the shape every reader was told to use',
     /stuck: this\.stalledSince/.test(stalled) &&
     stalled.split('stuck: this.stalledSince')[1]?.includes('lever: this.stalledLever'));
  ok('and the keeper PROCESS publishes them, which is the architecture production runs',
     /stuck: \(autopilot\?\.stalledSince\)/.test(KEEPER_PROC) &&
     /lever: autopilot\.stalledLever/.test(KEEPER_PROC) &&
     /repeats: autopilot\.stallRepeats/.test(KEEPER_PROC));
}

console.log('');
console.log('THE RESTART IS AN EXPERIMENT, AND A TERRIBLE HABIT');
{
  const row = (why = THE_LOOP) => ({
    character: 'JohnsSlave',
    stalled: { idle_passes: 40, why, lever: null, repeats: 40 },
    refusals: [{ code: 'STALL_NO_LEVER', blocking: true, why: `the same stall 40 times running, and nothing here can act on it: ${why}` }],
  });

  // THE ORDINARY CASE IS NOT RATIONED. This must not become a general throttle on a
  // mechanism that works — most stalls are keeper-local and a restart is exactly right.
  const mem = new Map();
  const plain = { character: 'Gonzo', stalled: { idle_passes: 40, why: 'anything' }, refusals: [] };
  const tenRounds = Array.from({ length: 10 },
                               () => stallRestartDecision(mem, 'Gonzo', plain).restart);
  ok('an undeclared stall is restarted every round, ten rounds running',
     tenRounds.every(Boolean), JSON.stringify(tenRounds));
  ok('and nothing is remembered about it', !mem.has('Gonzo'));

  // THE DECLARED CASE GETS TWO GOES AND THEN THE TRUTH.
  const m2 = new Map();
  const first = stallRestartDecision(m2, 'JohnsSlave', row());
  const second = stallRestartDecision(m2, 'JohnsSlave', row());
  const third = stallRestartDecision(m2, 'JohnsSlave', row());
  ok('the first restart happens — it is a real experiment', first.restart === true);
  ok('so does the second, in case the first raced something', second.restart === true);
  ok('the third does not', third.restart === false, JSON.stringify(third));
  ok('and it says why rather than going quiet',
     /same declared stall/.test(String(third.because)), third.because);
  ok('the limit is the exported constant, not a number typed twice',
     STALL_RESTARTS_BEFORE_GIVING_UP === 2);

  // A NEW REASON IS A NEW EXPERIMENT. Rationing a character rather than a reason would
  // strand it the next time it got stuck on something a restart genuinely fixes.
  const moved = stallRestartDecision(m2, 'JohnsSlave', row('a completely different wedge'));
  ok('a different declared stall starts the count again', moved.restart === true,
     JSON.stringify(moved));

  // AND EARNING SOMETHING FORGETS IT. The keeper clears the refusal on progress(), so the
  // row stops carrying it, and the memory has to let go with it.
  const cleared = stallRestartDecision(m2, 'JohnsSlave', plain);
  ok('a character that stopped refusing is not still being counted',
     cleared.restart === true && !m2.has('JohnsSlave'));

  // A NON-BLOCKING DECLARATION IS NOT ONE. Same rule as everywhere else that reads this
  // channel: `blocking: false` is a note, not a condition.
  const soft = { ...row(), refusals: [{ code: 'STALL_NO_LEVER', blocking: false, why: 'x' }] };
  ok('a non-blocking refusal does not ration anything',
     stallRestartDecision(new Map(), 'X', soft).restart === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
