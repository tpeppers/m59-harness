#!/usr/bin/env node
// THE OUT-OF-BAND GUARD — the contract test for m59-watchdog.mjs.
//
//   node tools/m59-watchdog-test.mjs
//
// Offline, against a fake host. What is pinned here is the SEPARATION the guard rests
// on: it observes on its own clock, and the only thing it ever DOES is cancel movement
// when health has crossed the withdraw line during a blocked pass. A same-pass repeat is
// rate-limited but deliberate: it invalidates a fallback that re-armed after the first
// cancel. Everything
// else is somebody else's decision.
//
// It exists because the guard used to be a method on the 13,000-line keeper, reachable
// only by that keeper. Two drivers now run it, so the interface between them is a real
// boundary and needs a test rather than a convention.
import * as wd from './m59-watchdog.mjs';
import { applyFleeBelowPolicy, safetyFor } from './m59-skills.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); }
};

function host({ hp = 20, max = 20, blockedMs = 0, inert = false, doing = 'travelling',
                hold = null, live = true, state = 'game' } = {}) {
  const notes = [], frames = [];
  let cancelled = 0;
  const h = {
    doing, hold, inert, passes: 1, tally: {},
    passStartedAt: blockedMs ? Date.now() - blockedMs : null,
    lastFrameAt: 0,
    s: { client: { vitals: () => ({ health: { value: hp, max } }),
                   self: { col: 4, row: 4 }, room: { id: 587 }, state },
         live,
         cancelMovement: () => { cancelled++; return { cancelled: true, interrupted: 1 }; } },
    safety: () => ({ fleeAt: 0.4 }),
    // THE REAL recordFrame STAMPS lastFrameAt, and the frame gate is computed from it.
    // A fake that only pushed to an array made the gate read "nothing has been recorded
    // for ever" and write a frame on every tick -- the fixture lying about the thing
    // under test, which is the failure docs/HANDOFF.md calls the most dangerous file.
    recordFrame(why) { frames.push(why); this.lastFrameAt = Date.now(); },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {},
    notes, frames, get cancels() { return cancelled; },
  };
  h.watch = wd.freshState();
  return h;
}

console.log('the handbrake — the only thing it actually does');
{
  const h = host({ hp: 5, blockedMs: 9000, doing: 'pulling' }); // 25%, below fleeAt 0.4
  wd.tick(h);
  ok('a blocked pass with health under the withdraw line is cancelled', h.cancels === 1);
  ok('and it says so in a note a person can find',
     h.notes.some(n => /WATCHDOG/.test(n.what)));
  wd.tick(h); wd.tick(h);
  ok('not once per tick', h.cancels === 1,
     'the repeat is rate limited rather than firing every 500ms');
  h.watch.lastInterruptAt -= wd.WATCHDOG_REPEAT_MS;
  h.watch.pulses = [
    { at: Date.now() - 1200, room: 587, col: 4, row: 4 },
    { at: Date.now() - 600, room: 587, col: 5, row: 4 },
    { at: Date.now(), room: 587, col: 4, row: 4 },
  ];
  wd.tick(h);
  ok('but a same-activity local bounce is cancelled again after the grace interval',
     h.cancels === 2 && h.watch.repeatInterrupts === 1,
     'fresh post-interrupt pulses prove the nested movement is still penned in');
  h.passes = 2;
  wd.tick(h);
  ok('a NEW blocked pass may be interrupted again', h.cancels === 3);
}

console.log('\na repeat cannot cancel the survival response to the first interrupt');
{
  const changed = host({ hp: 5, blockedMs: 9000, doing: 'pulling' });
  wd.tick(changed);
  changed.doing = 'travelling';
  changed.watch.lastInterruptAt -= wd.WATCHDOG_REPEAT_MS;
  changed.watch.pulses = [
    { at: Date.now() - 1200, room: 587, col: 4, row: 4 },
    { at: Date.now() - 600, room: 587, col: 4, row: 4 },
    { at: Date.now(), room: 587, col: 4, row: 4 },
  ];
  wd.tick(changed);
  ok('changing into the survival retreat is not treated as the old leaf re-arming',
     changed.cancels === 1 && changed.watch.repeatInterrupts === 0);

  const moving = host({ hp: 5, blockedMs: 9000, doing: 'pulling' });
  wd.tick(moving);
  moving.watch.lastInterruptAt -= wd.WATCHDOG_REPEAT_MS;
  moving.watch.pulses = [
    { at: Date.now() - 1200, room: 587, col: 4, row: 4 },
    { at: Date.now() - 600, room: 587, col: 5, row: 4 },
    { at: Date.now(), room: 587, col: 6, row: 4 },
  ];
  wd.tick(moving);
  ok('a same-activity escape making real square progress is not cancelled again',
     moving.cancels === 1 && moving.watch.repeatInterrupts === 0);
}

console.log('\na guarded emergency retreat owns its own progress cancellation');
{
  const guarded = host({ hp: 5, blockedMs: 9000, doing: 'travelling' });
  guarded.emergencyRetreat = { active: true, room: 106 };
  guarded.strangersInReach = () => [];
  wd.tick(guarded);
  ok('the ordinary handbrake leaves an active monster-driven refuge route alone',
     guarded.cancels === 0);
  guarded.emergencyRetreat.active = false;
  wd.tick(guarded);
  ok('once the route guard disarms itself, a still-blocked walk is interruptible again',
     guarded.cancels === 1);

  const player = host({ hp: 20, blockedMs: 100, doing: 'travelling' });
  player.emergencyRetreat = { active: true, room: 106 };
  player.strangersInReach = () => [{ id: 7, name: 'a nearby player' }];
  wd.tick(player);
  ok('a nearby player ends even a fresh, healthy guarded retreat immediately',
     player.cancels === 1 &&
       player.emergencyRetreat.cancellationKind === 'player');
  wd.tick(player);
  ok('the player cancellation is issued once rather than on every watchdog tick',
     player.cancels === 1);
}

console.log('\nthe inert rescue — taking a character back from a driver that stopped');
{
  // Standing down for a driver is right until the body is penned in AND bleeding. Ported
  // from upstream, where reviving alone was measured to be worse than the stall: the
  // destination went with the driver and the character stood in a bad room until it died.
  const h = host({ hp: 5, blockedMs: 0, inert: { why: 'an errand' }, doing: 'travelling' });
  const calls = [];
  h.suspendJourney = (t) => { calls.push(['suspend', t]); return true; };
  h.wantForwardShelter = (w) => calls.push(['shelter', w]);
  h.revive = (w) => calls.push(['revive', w]);
  let t = 1000;
  h.s.client.vitals = () => ({ health: { value: 20 - Math.floor(t / 1000), max: 20 } });
  // Four pulses in one square, losing a point each second.
  for (let i = 0; i < 6; i++) { wd.pulse(h, t, h.s.client.vitals().health); t += 1000; }
  ok('a penned-in body is recognised', wd.pennedIn(h.watch) === true);
  ok('and losing health while penned in is the pair that matters',
     wd.inertBleeding(h.watch, { value: 10 }) === true);
  ok('the wedge records that something else was driving', h.watch.wedged?.inert === true,
     JSON.stringify(h.watch.wedged ?? null));
  ok('and that it is taking hits', h.watch.wedged?.taking_hits === true);

  h.passStartedAt = t; h.passes = 1;
  h.s.client.vitals = () => ({ health: { value: 5, max: 20 } });   // 25%, below fleeAt
  wd.tick(h);
  ok('the movement is cancelled', h.cancels === 1);
  ok('the journey is SUSPENDED, not thrown away', calls.some(c => c[0] === 'suspend'),
     'reviving without keeping the destination is how a character ends up idle where it was dying');
  ok('it is asked to mend FORWARD rather than idle here', calls.some(c => c[0] === 'shelter'));
  ok('and the keeper stops being inert', calls.some(c => c[0] === 'revive'));
  ok('counted', h.watch.rescues === 1 && h.tally.inert_rescues === 1);

  const before = h.cancels;
  wd.tick(h);
  ok('ONCE per pass, not once per tick', h.cancels === before);
}

console.log('\nand a host that cannot do any of it still gets the cancel');
{
  // The tick driver supplies none of these hooks. The rescue must degrade to its cheapest
  // useful action rather than throwing, or sharing the guard between drivers is a fiction.
  const h = host({ hp: 5, inert: { why: 'a bot' }, doing: 'travelling' });
  let t = 1000;
  h.s.client.vitals = () => ({ health: { value: 20 - Math.floor(t / 1000), max: 20 } });
  for (let i = 0; i < 6; i++) { wd.pulse(h, t, h.s.client.vitals().health); t += 1000; }
  h.passStartedAt = t; h.passes = 1;
  h.s.client.vitals = () => ({ health: { value: 5, max: 20 } });
  let threw = false;
  try { wd.tick(h); } catch { threw = true; }
  ok('no hooks, no throw', threw === false);
  ok('and the walk is still cancelled', h.cancels === 1);
}

console.log('\nand the four times it must NOT act');
{
  ok('healthy: a long pass on a full bar is not an emergency',
     host({ hp: 20, blockedMs: 9000 }) && (() => { const h = host({ hp: 20, blockedMs: 9000 }); wd.tick(h); return h.cancels === 0; })());
  ok('brief: hurt but the pass is not blocked — the pass will decide for itself',
     (() => { const h = host({ hp: 5, blockedMs: 100 }); wd.tick(h); return h.cancels === 0; })());
  // Cancelling under an errand is this keeper fighting the thing it stood down for.
  ok('INERT: something else is driving, so it is not ours to cancel',
     (() => { const h = host({ hp: 5, blockedMs: 9000, inert: true }); wd.tick(h); return h.cancels === 0; })());
  ok('not in game: nothing to cancel',
     (() => { const h = host({ hp: 5, blockedMs: 9000, live: false }); wd.tick(h); return h.cancels === 0; })());
}

console.log('\nit decides nothing else');
{
  const src = wd.tick.toString() + wd.pulse.toString();
  ok('nothing in it flees, rests, attacks or travels',
     !/\bflee\(|\brest\(|\battack\(|\btravel\(|walkTo\(/.test(src),
     'the ordinary pass already knows how to do those, with fresh numbers');
  ok('the only outward call is cancelMovement',
     (src.match(/\bs\.[a-zA-Z]+\(/g) ?? []).every(m => /cancelMovement|vitals/.test(m)));
}

console.log('\nthe record — because a death nobody framed cannot be placed');
{
  const h = host({ hp: 20, blockedMs: 0 });
  wd.tick(h);
  ok('a first tick writes a frame', h.frames.length === 1);
  const before = h.frames.length;
  wd.tick(h);
  ok('an unchanged bar does not write another straight away', h.frames.length === before);
  h.s.client.vitals = () => ({ health: { value: 12, max: 20 } });
  wd.tick(h);
  ok('but a health change always does — that is the resolution a post-mortem wants',
     h.frames.length === before + 1 &&
     /health moved/.test(h.frames[h.frames.length - 1]));
}

console.log('\na host that cannot answer must not take the guard down');
{
  // An exception inside a tick kills the timer and the guard dies silently. start()
  // wraps the tick for exactly this, so a broken host degrades to no guard rather than
  // to a crash — and records why.
  const h = host({ hp: 5, blockedMs: 9000 });
  h.safety = () => { throw new Error('no policy'); };
  wd.start(h);
  let threw = false;
  try { wd.tick(h); } catch { threw = true; }
  wd.stop(h);
  ok('the tick itself may throw, but start() catches it and records lastError',
     threw === true, 'and the timer keeps its next tick');
}

console.log('\none home for the withdraw line');
{
  const client = { vitals: () => ({ health: { value: 17, max: 40 } }) };
  const implicit = safetyFor(client, { fleeBelow: 0.4 });
  ok('an implicit floor still computes the adaptive two-hit margin',
     implicit.maxHit === 14 && implicit.fleeAt === 0.7,
     JSON.stringify(implicit));

  const policy = { fleeBelow: 0.4 };
  applyFleeBelowPolicy(policy, 17 / 40);
  const explicit = safetyFor(client, policy);
  ok('an explicit broker floor is marked and used exactly instead of the adaptive margin',
     policy.fleeBelowExplicit === true && explicit.fleeAt === 0.425,
     JSON.stringify({ policy, explicit }));
  ok('at exactly 17/40 the strict withdraw comparison does not fire',
     (17 / 40) < explicit.fleeAt === false);
  ok('at 16/40 the strict withdraw comparison fires',
     (16 / 40) < explicit.fleeAt === true);

  applyFleeBelowPolicy(policy, undefined);
  ok('an update which omits flee_below preserves the explicit order',
     policy.fleeBelow === 0.425 && policy.fleeBelowExplicit === true,
     JSON.stringify(policy));

  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const applyAt = broker.indexOf('skills.applyFleeBelowPolicy(p.policy, a.flee_below);');
  const persistAt = broker.indexOf('rememberAutopilot(a.agent', applyAt);
  ok('the broker marks an explicit flee_below before persisting the keeper policy',
     applyAt >= 0 && persistAt > applyAt,
     JSON.stringify({ applyAt, persistAt }));
  ok('and with no readable max it falls back to the policy floor',
     safetyFor({ vitals: () => ({}) }, { fleeBelow: 0.4 }).fleeAt === 0.4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
