#!/usr/bin/env node
// A RETREAT THAT WAS REFUSED IS NOT A RETREAT, AND MUST NOT END THE PASS.
//
//   node tools/m59-retreat-refusal-test.mjs
//
// Offline. No socket, no broker, no roster.
//
// THE INCIDENT (issue #51). `retreatToSafety` refuses outright while `retreat_to_inn` is
// off — the operator switched it off on 2026-08-27 — and returns `{arrived:false}` having
// moved nothing. Every caller ignored that and reported success anyway, so the journal read
// like an escape while the body stood still:
//
//   what:  "hurt in the open — running for a town rather than playing dead"
//   what:  "no wall and no town — withdrawing rather than freezing"
//   what:  "not waiting this out — moving to somewhere I can heal"
//   what:  "not changing objective for an inn"        <- the refusal
//   progress: "moved toward somewhere I can heal"     <- the lie
//
// JohnsSlave, four deaths in two days. The last post-mortem window: 31.3 seconds, 46
// samples, `squares_per_second: 0.0`, `net_squares: 0`, `rooms_crossed: 0`, seven things
// adjacent, 2 of 21 health. The decision was correct every single pass.
//
// TWO THINGS WERE WRONG AND THIS SUITE PINS BOTH:
//
//   1. The refusal did nothing at all, while the comment above it said the replacement for
//      the inn walk is a route-adjacent safe spot. A sentence is not a behaviour: the
//      refusal now TAKES A WALL when there is one to take.
//
//   2. The rung that called it consumed the pass — `progress()` and `return HANDLED` —
//      which pre-empted the rung immediately below, the one that actually leaves the room
//      via `leaveViaAny` with a reconnect to shed the crowd. Only a retreat that HAPPENED
//      may claim the pass.
//
// It should fail the day a caller reports a refused retreat as movement again.

import { Autopilot, HANDLED } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
const BT_FLEE = readFileSync(join(HERE, 'm59-bt-flee.mjs'), 'utf8');
const BT_FARM = readFileSync(join(HERE, 'm59-bt-farm.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// A monster carries ATTACKABLE and not PLAYER — built from the real flags, because a
// fixture with invented bits builds a room the code under test cannot classify.
const monster = (id, col = 25, row = 6) => ({ id, flags: OF.ATTACKABLE, col, row, nameRsc: 1 });

// The keeper as the ladder sees it: enough of a body to walk the rungs, and every verb that
// does I/O replaced by a recorder. Nothing here fakes the two methods under test —
// `retreatToSafety` and `passFleeAndRest` are the real ones.
const keeper = ({ health = 3, max = 21, vigor = 140, monsters = 1, hold = null,
                  policy = {}, exits = [{ to: 545, to_name: 'Deep Woods', steps_away: 3 }],
                  spot = null, retreat = null } = {}) => {
  const notes = [], progressed = [], stalled = [];
  const self = { id: 1, col: 25, row: 5 };
  const objects = new Map();
  for (let i = 0; i < monsters; i++) objects.set(10 + i, monster(10 + i, 25, 6 + i));
  const calls = { leaveViaAny: 0, takeSafeSpot: 0, townTrip: 0, breakOut: 0, cooked: 0 };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, claims: new Map(), passes: 1,
    tally: {}, doing: null, hold, wallTriedAt: null, settledIn: null,
    book: { save: () => {} },
    watch: { pulses: [], wedges: 0 },
    policy: {
      fleeBelow: 0.7, restBelow: 0.6, holdResumeAbove: 0.9,
      useSafeSpots: true, panicLogoff: true, hunt: 'giant rat', strategy: 'baseline',
      ...policy,
    },
    mode: 'farm',
    note: (what, detail) => notes.push({ what, detail }),
    progress: (why) => progressed.push(why),
    noProgress: (why) => stalled.push(why),
    recordFrame: () => {}, ledgerEvent: () => {}, declareInterest: () => {},
    armed: () => true,
    safety: () => ({ engageAt: 0.9, fleeAt: 0.7 }),
    holdWorks: () => false,
    recovered: () => true,
    recoverUntilWhole: false,
    sanctuary: () => false,
    tooTiredToTravel: () => false,
    tradeInPlaceIfWedged: async () => false,
    townTripIfCornered: async () => { calls.townTrip++; return false; },
    playDead: async () => false,
    settle: async () => {},
    cookSomething: async () => { calls.cooked++; },
    provision: async () => 'full',
    breakOut: async () => { calls.breakOut++; return { did: false }; },
    // The real one SETS `this.hold` when it takes, and half the ladder is gated on
    // `!this.hold` — a stub that only reports success builds a character that is holding a
    // wall and standing in the open at the same time, which is not a state the game has.
    takeSafeSpot: async () => {
      calls.takeSafeSpot++;
      const got = spot ?? { took: false, why: 'no wall here' };
      if (got.took) k.hold = { room: 535, ...(got.spot ?? { col: 20, row: 9 }) };
      return got;
    },
    releaseRestedHold: () => {},
    s: {
      name: 't1',
      leaveViaAny: async () => { calls.leaveViaAny++; return { left: true, to: 545 }; },
      world: {
        room: { num: 535, name: 'West Merchant Way through Ilerian Woods' },
        exits: () => exits,
        geometry: null,
      },
      client: {
        selfId: 1, self,
        rsc: { get: () => 'giant rat' },
        room: { objects },
        ailments: () => [],
        vitals: () => ({ health: { value: health, max }, vigor: { value: vigor, max: 200 } }),
      },
    },
  });
  if (retreat) k.retreatToSafety = retreat;
  k.calls = calls; k.progressed = progressed; k.stalled = stalled;
  return k;
};

const ctxFor = k => {
  const v = k.s.client.vitals();
  return { s: k.s, c: k.s.client, room: k.s.world.room, v,
           hp: v.health.max ? v.health.value / v.health.max : null };
};

const said = (k, what) => k.notes.some(n => n.what === what);

console.log('');
console.log('THE REFUSAL DISPATCHES THE REPLACEMENT IT HAS BEEN DESCRIBING');
{
  // The comment over this branch has said "the replacement is not nothing, it is the
  // route-adjacent safe spot" since 2026-08-27, and for that whole time the branch returned
  // a refusal and moved nothing. The spot IS the doctrine's answer, so take one.
  const k = keeper({ spot: { took: true, spot: { col: 20, row: 9 } } });
  const r = await k.retreatToSafety({ because: 'test' });
  ok('with the inn walk off it takes a wall instead of standing still',
     r?.arrived === true && r?.took_spot === true, JSON.stringify(r));
  ok('and says which move it made', said(k, 'took a wall instead of an inn'));
  ok('the refusal itself is still logged, naming the switch that brings the inn back',
     k.notes.some(n => n.what === 'not changing objective for an inn' &&
                       n.detail?.enable_with === 'retreat_to_inn: true'));
}

{
  // AND WHEN THERE IS NO WALL, IT SAYS SO RATHER THAN CLAIMING ONE. This is the shape the
  // callers have to be able to tell apart; without `arrived:false` there is nothing to check.
  const k = keeper();
  const r = await k.retreatToSafety({ because: 'test' });
  ok('no wall to be had is a refusal, not an arrival',
     r?.arrived === false && r?.refused === 'retreat_to_inn is off', JSON.stringify(r));
  ok('and it reports why no wall was taken, so the log can tell "none" from "not asked"',
     typeof r?.no_spot === 'string' && r.no_spot.length > 0, JSON.stringify(r));
  ok('it did actually ask for one', k.calls.takeSafeSpot === 1, String(k.calls.takeSafeSpot));
}

{
  // ONE BUDGET FOR "GO AND GET A WALL", HOWEVER MANY RUNGS ASK. The ladder's own wall rung
  // sets `wallTriedAt`; sharing it stops a hurt character re-scanning a wall-less room every
  // pass, which is the cost this could otherwise add to exactly the character that is dying.
  const k = keeper();
  k.wallTriedAt = Date.now();
  const r = await k.retreatToSafety({ because: 'test' });
  ok('a wall searched for seconds ago is not searched for again',
     r?.arrived === false && k.calls.takeSafeSpot === 0, JSON.stringify(r));
  ok('and the refusal says that is why', /within the last 30s/.test(r?.no_spot ?? ''), r?.no_spot);

  // ...and the budget expires, or it is not a budget.
  k.wallTriedAt = Date.now() - 31_000;
  await k.retreatToSafety({ because: 'test' });
  ok('thirty seconds later it asks again', k.calls.takeSafeSpot === 1);
}

{
  // SPOTS OFF MEANS SPOTS OFF. The operator switching `use_safe_spots` off is an
  // instruction, not a preference this branch gets to override because somebody is dying.
  const k = keeper({ policy: { useSafeSpots: false } });
  const r = await k.retreatToSafety({ because: 'test' });
  ok('with safe spots switched off it does not take one', k.calls.takeSafeSpot === 0);
  ok('and the refusal names the switch rather than the room',
     /switched off in the policy/.test(r?.no_spot ?? ''), r?.no_spot);
}

{
  // THE OLDER GUARD IS ABOVE THIS AND MUST STAY THERE. A wall that has held IS safety, and
  // a character standing on one does not go looking for another.
  const k = keeper({ hold: { room: 535, col: 20, row: 9 } });
  k.holdWorks = () => true;
  const r = await k.retreatToSafety({ because: 'test' });
  ok('a character on a wall that has held stays on it',
     r?.arrived === true && r?.held_spot === true, JSON.stringify(r));
  ok('and never reaches the wall search', k.calls.takeSafeSpot === 0);
}

console.log('');
console.log('A REFUSED RETREAT DOES NOT CLAIM THE PASS');
{
  // THE DEATH, END TO END. Hurt in the open, monsters in the room, no wall, vigor above the
  // resting ceiling — the state JohnsSlave died in four times. The rung decides to move,
  // the retreat is refused, and the pass must carry on to the rung that actually walks out.
  const k = keeper({ health: 3, max: 21, vigor: 140, monsters: 7 });
  const r = await k.passFleeAndRest(ctxFor(k));
  ok('the ladder still decides, out loud, that standing here is not the answer',
     said(k, 'not waiting this out — moving to somewhere I can heal'));
  ok('and it does not pretend the refused retreat was movement',
     !k.progressed.includes('moved toward somewhere I can heal'),
     JSON.stringify(k.progressed));
  ok('it says the retreat was refused rather than swallowing it',
     said(k, 'the retreat was refused — not ending the pass on it'));
  ok('AND THE BODY ACTUALLY LEAVES THE ROOM', k.calls.leaveViaAny === 1,
     JSON.stringify(k.calls));
  ok('which is what the pass ends on', r === HANDLED);
  ok('and that is reported as the progress it is',
     k.progressed.some(p => /left a room I could neither fight nor rest in/.test(p)),
     JSON.stringify(k.progressed));
}

{
  // THE OTHER DIRECTION, WHICH IS WHAT MAKES THE ONE ABOVE AN ASSERTION RATHER THAN A
  // TAUTOLOGY: a retreat that HAPPENED still ends the pass, and must not also walk out of
  // the room it just retreated inside.
  const k = keeper({ health: 3, max: 21, vigor: 140, monsters: 7,
                     retreat: async () => ({ arrived: true, took_spot: true }) });
  const r = await k.passFleeAndRest(ctxFor(k));
  ok('a retreat that arrived ends the pass', r === HANDLED);
  ok('and is reported as progress', k.progressed.length > 0, JSON.stringify(k.progressed));
  ok('and nothing walks out of the room on top of it', k.calls.leaveViaAny === 0);
}

{
  // ONE WALL SEARCH PER PASS, AND THE ROOM IS NOT ABANDONED WHEN IT FINDS ONE.
  //
  // The ladder's own wall rung and the retreat's new one share `wallTriedAt` on purpose, so
  // adding the second search costs a wall-less room nothing: within one pass the question is
  // asked once. Here it is answered — the character gets the wall, and every rung below is
  // gated on `!this.hold`, so nothing walks it back out into the room it just sheltered in.
  const k = keeper({ health: 3, max: 21, vigor: 140, monsters: 7,
                     spot: { took: true, spot: { col: 20, row: 9 } } });
  await k.passFleeAndRest(ctxFor(k));
  ok('a wall is searched for once in a pass, not once per rung that wants one',
     k.calls.takeSafeSpot === 1, String(k.calls.takeSafeSpot));
  ok('and the character is holding it', !!k.hold, JSON.stringify(k.hold));
  ok('and the room is not abandoned on top of it', k.calls.leaveViaAny === 0,
     JSON.stringify(k.calls));
}

console.log('');
console.log('NO CALLER REPORTS A REFUSAL AS MOVEMENT');
{
  // THE CHURN GUARD. Five call sites had the same bug in the same shape, and the reason it
  // survived is that each one reads perfectly well on its own. So the rule is checked over
  // the file rather than per site: every `retreatToSafety` call has to keep its answer.
  const calls = [...SRC.matchAll(/(?:await\s+)?this\.retreatToSafety\??\.?\(/g)];
  ok('there are call sites to check', calls.length >= 4, String(calls.length));
  const bare = calls.filter(m => {
    const before = SRC.slice(Math.max(0, m.index - 40), m.index);
    // A call whose result is bound to something can be checked; one that is not, cannot.
    return !/(?:const|let|var)\s+\w+\s*=\s*$/.test(before.replace(/await\s+$/, ''));
  });
  ok('every caller keeps the answer instead of discarding it', bare.length === 0,
     bare.map(m => SRC.slice(0, m.index).split('\n').length).join(','));

  // AND THE SPECIFIC LIE, NAMED. This exact pair is what the post-mortems were full of.
  ok('nothing follows a retreat straight into an unconditional progress()',
     !/retreatToSafety\([^;]*\);\s*\n\s*this\.progress\(/s.test(SRC));
  ok('the ladder checks the result before claiming the pass',
     /if \(went\?\.arrived\) \{/.test(SRC));
}

{
  // THE TREE HAS TO AGREE WITH THE LADDER, or landing it re-opens the same grave. In a
  // selector, SUCCESS ends the tick, so it is the tree's version of `return HANDLED`.
  ok('the flee tree does not claim a tick for a refused retreat',
     !/await keeper\.retreatToSafety\([^;]*\);\s*\n\s*return SUCCESS;/s.test(BT_FLEE));
  ok('and its vigor-walk node checks before reporting progress',
     /if \(!went\?\.arrived\)/.test(BT_FLEE));
  ok('the farm tree checks its own retreat too', /if \(away\?\.arrived\)/.test(BT_FARM));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
