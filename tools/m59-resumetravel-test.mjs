#!/usr/bin/env node
// AN INTERRUPTED JOURNEY IS SUSPENDED, NOT FORGOTTEN.
//
//   node tools/m59-resumetravel-test.mjs
//
// Offline. No socket, no broker, no roster — safe any time.
//
// ============================ WHAT THIS IS BUILT FROM ============================
//
// A shuttle test on the shadow fleet, 2026-08-21: twenty-one characters sent back and
// forth between Castle Victoria and Tos, and not one arrived. Some of that was a
// confinement refusing the journey outright. The rest was this: the mid-hop guards end a
// journey ON PURPOSE when the character is in trouble, and until this change they ended the
// OBJECTIVE along with the movement.
//
// `takeBack` did not even have a destination to keep. It recorded
// `was_travelling_to: held.why`, which is prose —— "travelling to Castle Victoria" —— and
// reads like a destination without being one. So a character pulled off the road at 30%
// health healed up at a wall, and then went back to farming with no memory that anybody
// had sent it anywhere. From outside, that is indistinguishable from travel not working:
// the shuttle logged it as "stopped being busy without arriving".
//
// THE RULE THIS SERVES, set by the operator 2026-08-21: A JOURNEY IS NEVER ABANDONED
// UNLESS A PLAYER IS ATTACKING. Every other kind of travel trouble — monsters, an empty
// hand, an emptying bar — is answered by finding a SAFE WALL and resting at it, which is
// drastically safer and more effective than running, because a wall a creature cannot path
// to is almost always closer than the nearest town. The journey then carries on.
//
// So the objective is kept, and picked back up from the LAST pass stage — by construction
// nothing more urgent wanted that tick — once health and vigor are back up, which is what
// "rested at the wall" means in numbers.
//
// THE FIVE REFUSALS are the safety of the resume itself, and two of them are RUNAWAY
// BACKSTOPS rather than policy: set tight, they quietly become a second abandon rule and
// undo the operator's rule above.
//
//   died since      resuming the road that killed you is the Cccc post-mortem with steps
//   too many tries  a BACKSTOP at 12, not "give up after two" — a road with eight
//                   wall-rests along it is a road, not a loop
//   stale           thirty minutes, which is longer than a bad rest; five was not
//   too hurt        NOT a drop —— being hurt is temporary and the note stays good
//   switched off    `resume_travel: false`, per character, live
//
// It should fail the day a resume stops asking one of those five questions, or the day
// something other than a player starts abandoning journeys.

import { Autopilot, HANDLED, CONTINUE, PASS_STAGES } from './m59-autopilot.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// THE SPLIT MOVED THE CODE, SO THE SOURCE GREPS HAVE TO FOLLOW IT. `Session` (travelJob)
// lives in m59-game.mjs and the watchdog rescue in m59-watchdog.mjs; reading only the two
// original files leaves these assertions searching haystacks that no longer contain their
// subject — which fails the positive ones loudly and passes the negative ones silently.
const readSrc = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const BROKER_SRC = readSrc('tools/m59-game.mjs') + '\n' + readSrc('tools/m59-broker.mjs');
const KEEPER_SRC = readSrc('tools/m59-autopilot.mjs') + '\n' + readSrc('tools/m59-watchdog.mjs');

// Same shape as m59-travelling-test's fixture, and for the same reason: a real constructor
// wants a session, which wants a socket, which wants a server. `who()` resolves to null so
// `recordEvent` is a no-op and no assertion here appends to the real ledger.
const keeper = ({ health = 37, max = 37, vigor = 80, hold = null,
                 policy = {}, room = 535, travelled = [] } = {}) => {
  const notes = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, policy, claims: new Map(), passes: 1,
    tally: { deaths: 0 }, doing: 'travelling',
    book: { save: () => {} },
    watch: { pulses: [], wedges: 0 },
    note: (what, detail) => notes.push({ what, detail }),
    recordFrame: () => {},
    ledgerEvent: () => {},
    progress: () => {}, noProgress: () => {},
    armed: () => true,
    safety: () => ({ fleeAt: 0.7 }),
    travel: async (to, opts) => { travelled.push({ to, opts }); return { arrived: true }; },
    s: {
      name: null,
      cancelMovement: () => ({ cancelled: true }),
      world: { room: { num: room, name: 'somewhere' } },
      client: { selfId: 1, self: { id: 1, col: 25, row: 5 }, room: { objects: new Map() },
                vitals: () => ({ health: { value: health, max },
                                 vigor: { value: vigor, scale_max: 200 } }) },
    },
  });
  k.travelled = travelled;
  // A HOLD, AND A LEAVE THAT RECORDS RATHER THAN DECIDES. The real `leaveHold` has its own
  // refusal rule for a HURT character; stubbing it keeps this section about the release
  // decision instead of re-testing that one.
  if (hold) k.hold = hold;
  k.left = [];
  k.leaveHold = async (why, opts) => { k.left.push({ why, opts }); k.hold = null; return { left: true }; };
  return k;
};
const ctxFor = k => {
  const v = k.s.client.vitals();
  return { s: k.s, c: k.s.client, room: k.s.world.room, v,
           hp: v.health.max ? v.health.value / v.health.max : null };
};
const said = (k, re) => k.notes.some(n => re.test(n.what) || re.test(JSON.stringify(n.detail ?? {})));

// ---------------------------------------------------------------------------
console.log('\nthe objective is stored at all');
{
  const k = keeper();
  k.goTravelling('travelling to Castle Victoria', { to: 38 });
  ok('goTravelling records the destination as a NUMBER, not just the prose reason',
     k.inert.to === 38 && typeof k.inert.to === 'number', JSON.stringify(k.inert?.to));
  ok('and the attempt count rides on the journey, not only on the suspended note',
     k.inert.attempts === 0);

  const legacy = keeper();
  legacy.goTravelling('travelling to somewhere');
  ok('a caller that names no destination still travels, with to = null',
     legacy.inert.travelling === true && legacy.inert.to === null);

  // A SUSPENDED OBJECTIVE OUTLIVES A SYSTEM SAVE. IT MAY NOT NAME ANYTHING TEMPORARY.
  //
  // In-game object ids are regenerated on every save, alongside garbage collection — a
  // character resolved as 7218 is a heartstone half an hour later, and nothing errors.
  // So what is kept across the gap between a take-back and a resume has to be the STABLE
  // room number (`look.room.num`), never the live room object (`look.room.object_id`) and
  // never a character's object id. The router resolves those fresh at the moment it moves.
  const k2 = keeper();
  k2.goTravelling('travelling to Castle Victoria', { to: 38 });
  k2.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'flee',
                          attempts: 1, deaths_at: 0 };
  const keys = Object.keys(k2.suspendedJourney).sort();
  ok('the suspended objective carries only stable fields — no object id of any kind',
     JSON.stringify(keys) === JSON.stringify(['at', 'attempts', 'deaths_at', 'to', 'trigger', 'why']),
     JSON.stringify(keys));
  ok('and nothing in the journey state is id-shaped either',
     !/object_id|objectId/.test(JSON.stringify(k2.inert)), JSON.stringify(k2.inert));

  // THE ONE THAT KEEPS "one direction per body" TRUE.
  const busy = keeper();
  busy.suspendedJourney = { to: 50, why: 'old', at: Date.now(), attempts: 1, deaths_at: 0 };
  busy.goTravelling('travelling to Castle Victoria', { to: 38 });
  ok('a NEW journey retires any suspended objective',
     busy.suspendedJourney === null);
}

// ---------------------------------------------------------------------------
console.log('\nthe take-back suspends rather than discards');
{
  // takeBack is a closure inside passTravelling, so it is exercised the way the ladder
  // reaches it: through the real method, with the journey state the fixture sets up.
  const k = keeper({ health: 8 });
  k.goTravelling('travelling to Castle Victoria', { to: 38 });
  const before = k.inert;
  // Reproduce the takeBack contract directly against the state it reads, rather than
  // driving the whole threat ladder — this suite is about what happens to the OBJECTIVE.
  k.tally.travel_takebacks = 0;
  k.suspendedJourney = { to: 38, why: before.why, at: Date.now(), trigger: 'flee',
                         attempts: (before.attempts ?? 0) + 1, deaths_at: k.tally.deaths };
  k.revive('flee while travelling');
  ok('the destination survives the take-back', k.suspendedJourney?.to === 38);
  ok('and the first take-back counts as attempt 1', k.suspendedJourney.attempts === 1);
  ok('and the journey state itself is gone — a suspended journey holds nothing',
     k.inert === null);

  const src = KEEPER_SRC;
  ok('takeBack only suspends when it HAS a destination',
     /if \(held\.to != null\) \{/.test(src));
  ok('and carries the attempt count forward from the journey',
     /attempts: \(held\.attempts \?\? 0\) \+ 1/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\nthe five refusals');
{
  const suspended = (over = {}) => ({ to: 38, why: 'travelling to Castle Victoria',
    at: Date.now(), trigger: 'flee', attempts: 1, deaths_at: 0, ...over });

  // 1. died since
  const dead = keeper();
  dead.suspendedJourney = suspended();
  dead.tally.deaths = 1;
  ok('a journey the character DIED on is dropped, not resumed',
     await dead.resumeSuspendedJourney(ctxFor(dead)) === CONTINUE &&
     dead.suspendedJourney === null && dead.travelled.length === 0);
  ok('and says that is why', said(dead, /died since/));

  // 2. too many attempts — a RUNAWAY BACKSTOP, not the abandon policy. The default is
  //    deliberately generous (12) because a journey is only given up for a PLAYER; every
  //    other trouble pauses at a wall and carries on, so a corridor with several wall-rests
  //    in it must not trip this. A tight cap here silently becomes a second abandon rule.
  const tired = keeper();
  tired.suspendedJourney = suspended({ attempts: 13 });
  ok('past the runaway cap the objective is dropped rather than resuming for ever',
     await tired.resumeSuspendedJourney(ctxFor(tired)) === CONTINUE &&
     tired.suspendedJourney === null && tired.travelled.length === 0);
  const patient = keeper();
  patient.suspendedJourney = suspended({ attempts: 13 });
  patient.policy.resumeTravelAttempts = 20;
  ok('and the cap is a policy, so an operator can say otherwise',
     await patient.resumeSuspendedJourney(ctxFor(patient)) === HANDLED &&
     patient.travelled.length === 1);

  // 3. stale
  // Thirty minutes by default: five was shorter than a bad rest, so an objective could
  // expire while the character was doing the very thing it was taken off the road to do.
  const old = keeper();
  old.suspendedJourney = suspended({ at: Date.now() - 2_400_000 });
  ok('an objective older than the window is dropped',
     await old.resumeSuspendedJourney(ctxFor(old)) === CONTINUE &&
     old.suspendedJourney === null && old.travelled.length === 0);
  ok('and says it went stale', said(old, /stale/));

  // 4. too hurt — NOT a drop. This is the one that must not throw the objective away.
  const hurt = keeper({ health: 12, max: 37 });
  hurt.suspendedJourney = suspended();
  ok('a character still too hurt to set out does NOT resume',
     await hurt.resumeSuspendedJourney(ctxFor(hurt)) === CONTINUE && hurt.travelled.length === 0);
  ok('...and KEEPS the objective for a later tick — being hurt is temporary',
     hurt.suspendedJourney?.to === 38);

  // 5. switched off
  const off = keeper();
  off.suspendedJourney = suspended();
  off.policy.resumeTravel = false;
  ok('resume_travel: false refuses',
     await off.resumeSuspendedJourney(ctxFor(off)) === CONTINUE && off.travelled.length === 0);
  ok('...and keeps the objective rather than destroying it behind a switch',
     off.suspendedJourney?.to === 38);
}

// ---------------------------------------------------------------------------
console.log('\nand when nothing refuses, it goes');
{
  const k = keeper();
  k.suspendedJourney = { to: 38, why: 'travelling to Castle Victoria', at: Date.now(),
                         trigger: 'flee', attempts: 1, deaths_at: 0 };
  const verdict = await k.resumeSuspendedJourney(ctxFor(k));
  ok('the stage reports HANDLED so the tick is not also spent farming', verdict === HANDLED);
  ok('it actually travels, to the stored destination', k.travelled[0]?.to === 38);
  ok('the note is consumed exactly once', k.suspendedJourney === null);
  ok('and it says it is resuming rather than starting something new',
     said(k, /RESUMING THE JOURNEY/));

  // Already there: clearing without travelling, so the ledger gets no journey that never moved.
  const there = keeper({ room: 38 });
  there.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'flee',
                             attempts: 1, deaths_at: 0 };
  ok('a character already at the destination clears the note and travels nowhere',
     await there.resumeSuspendedJourney(ctxFor(there)) === CONTINUE &&
     there.suspendedJourney === null && there.travelled.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nthe wiring the keeper cannot check for itself');
{
  ok('the broker hands travelJob its destination, not just the room name',
     /goTravelling\(`travelling to \$\{where\}`, \{ to: dest \}\)/.test(BROKER_SRC));
  // An unrecognised key is REPORTED, never applied and never dropped — so a policy the
  // keeper reads has to exist in the schema or it can never be set at all.
  for (const key of ['resume_travel', 'resume_travel_attempts', 'resume_travel_within_ms'])
    ok(`\`${key}\` is a declared autopilot parameter`,
       BROKER_SRC.includes(`${key}:`) && BROKER_SRC.includes(`a.${key} !== undefined`));
  ok('resume happens in the LAST pass stage, so nothing more urgent is skipped for it',
     /await this\.resumeSuspendedJourney\(ctx\)/.test(KEEPER_SRC));
}


console.log('');
console.log('A WALL THAT HAS FINISHED ITS WORK IS RELEASED IN THE STAGE THAT OWNS IT');
{
  const src = KEEPER_SRC;
  const stage = src.slice(src.indexOf('async passFleeAndRest'), src.indexOf('async passFollow'));
  // `releaseRestedHold` lives at the top of `resumeSuspendedJourney`, which lives in
  // `passFarm` — the LAST stage. A character holding a wall never reaches it, because
  // passFleeAndRest handles the pass and returns first. So the release could only ever run
  // for a character that was not holding anything, which is the one case it is not for.
  //
  // Watched live, fifteen seconds a sample:
  //
  //   holding a proven safe spot | 587 | hp 30/46 | suspended to 38  age  21s
  //   holding a proven safe spot | 587 | hp 46/46 | suspended to 38  age 106s
  //   holding a proven safe spot | 587 | hp 46/46 | suspended to 38  age 206s
  //
  // Full health, vigor at the resting cap, a destination still carried — both release
  // conditions satisfied and nothing asking.
  ok('the stage that owns the wall asks whether it is finished',
     /this\.hold && this\.suspendedJourney[\s\S]{0,60}releaseRestedHold\(\)/.test(stage));
  ok('and only when there is a journey waiting on it',
     /if \(this\.hold && this\.suspendedJourney\)/.test(stage));
  // The release itself is unchanged: a hurt character still keeps its wall.
  // RUN, NOT GREPPED. This asserted the SPELLING of the threshold — `hp < (this.policy
  // .holdResumeAbove` — and went red the moment the expression grew a second case, while
  // the property it was defending was untouched. What matters is which characters keep
  // their wall, so ask the function.
  {
    const hurt = keeper({ health: 20, max: 46, hold: { room: 587, col: 5, row: 42 } });
    ok('the release still refuses a hurt character', (await hurt.releaseRestedHold()) === false);

    // ON A ROAD IT IS FULL HEALTH, NOT NINE-TENTHS. The last tenth is the margin that
    // decides whether the NEXT room is survivable, which is the whole reason it stopped.
    // Bbbb gave up a proven wall at nine-tenths and was dead forty seconds later, one room
    // on: 18s of holding, 15r of rest, then 597 -> 598 -> the Underworld.
    const nearly = keeper({ health: 43, max: 46, hold: { room: 587, col: 5, row: 42 } });
    nearly.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                                attempts: 1, deaths_at: 0 };
    ok('a traveller at nine-tenths keeps its wall', (await nearly.releaseRestedHold()) === false,
       'the last tenth is the margin the next room is crossed on');

    // ...AND A FARMER DOES NOT, because for it the last tenth is the slowest thing to come
    // back, the room it is in is the room it works in, and nothing waits on the other side.
    const farming = keeper({ health: 43, max: 46, hold: { room: 587, col: 5, row: 42 } });
    ok('a character with no road keeps the old nine-tenths', (await farming.releaseRestedHold()) !== false);

    const whole = keeper({ health: 46, max: 46, hold: { room: 587, col: 5, row: 42 } });
    whole.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                               attempts: 1, deaths_at: 0 };
    ok('and a whole one gives the wall up and goes', (await whole.releaseRestedHold()) !== false);
    ok('and says what it needed, so the number is arguable from the record',
       said(whole, /needed/) || said(whole, /full health/));
  }
}

console.log('');
console.log('AN INJURED LEG MENDS AT A WALL FORWARD ON THE ROUTE, AND KEEPS ITS DESTINATION');
{
  const src = KEEPER_SRC;
  const fn = src.slice(src.indexOf('async shelterForwardAndMend'),
                       src.indexOf('async shelterForwardAndMend') + 2200);
  // Two deaths asked for this, and both were survivable:
  //
  //   Aaaa  journey ended at two legs after a watchdog rescue, idle at +81s, dead at 201s
  //   Bbbb  reached the Cragged Mountains at 13 of 20, poisoned, and died there
  //
  // One answer for both: a wall AHEAD on the route, mended at, objective kept. Forward
  // because the room is what is dangerous — a wall behind pays the exposure twice.
  ok('there is a forward recovery stop at all', /async shelterForwardAndMend/.test(src));
  ok('and it asks the ROUTE for the next wall in front', /shelterAhead\(/.test(fn));
  ok('and refuses walls it has just failed to reach', /unreachableIn\(/.test(fn));
  ok('and says the destination is kept', /not the end of one/.test(fn));

  // TRIGGER ONE. The watchdog must never leave a body idle in the room it was dying in.
  const rescue = src.slice(src.indexOf('WATCHDOG — took the character back from a driver') - 2600,
                           src.indexOf('WATCHDOG — took the character back from a driver'));
  // EITHER SPELLING. Upstream sets `this.wantsForwardShelter =` and `this.suspendedJourney
  // = {` inline; the extracted watchdog reaches the same two through optional host hooks
  // (`host.wantForwardShelter?.()`, `host.suspendJourney?.()`), which m59-autopilot.mjs
  // implements at wantForwardShelter()/suspendJourney(). Same behaviour, one indirection —
  // so assert the ASK, not the assignment, or the split reads as a missing rescue.
  ok('the watchdog rescue asks for that stop',
     /wantsForwardShelter =/.test(rescue) || /wantForwardShelter\?\.\(/.test(rescue));
  ok('and still keeps the journey',
     /suspendedJourney = \{/.test(rescue) || /suspendJourney\?\.\(/.test(rescue));

  // TRIGGER TWO. Poison takes a character to 1 health and then makes it rest to full anyway
  // once the enchantment ends — the rest is coming either way, and the only question is
  // whether it happens behind a wall on the route or in the open where the fall started.
  const stage = src.slice(src.indexOf('async passFleeAndRest'), src.indexOf('async passFollow'));
  ok('being ailing and fading asks for it too', /poisonedAndFading/.test(stage));
  ok('and it reads the real ailments rather than guessing from health',
     /client\?\.ailments\?\.\(\)/.test(stage));
  ok('three quarters is the line, and it is overridable',
     /AILING_SHELTER_BELOW/.test(src) && /ailingShelterBelow/.test(stage));
  // A standing instruction that outlives its trouble is how a character stops travelling
  // for the rest of a session.
  ok('the request is cleared the moment it is acted on',
     /this\.wantsForwardShelter = null;/.test(stage));
}

console.log('');
console.log('FIT TO GO ON MEANS THE WALL HAS STOPPED PAYING, NOT AN ABSOLUTE NUMBER');
{
  const src = KEEPER_SRC;
  const fn = src.slice(src.indexOf('async resumeSuspendedJourney'),
                       src.indexOf('async resumeSuspendedJourney') + 14000);
  // Full health is the right bar for a character resting somewhere safe and the wrong one for
  // one stalled mid-journey — because a stalled character is usually stalled SOMEWHERE IT
  // CANNOT HEAL, and then the gate never opens. Measured, both characters, the same shape:
  //
  //     +237s  room 597  idle
  //     +258s  room 597  holding a proven safe spot
  //
  // Aaaa rested out its whole clock at 21 of 33; Bbbb wandered back to the Western border and
  // spent 360 seconds there at 9 of 20. Neither ever set off again.
  ok('the resume watches whether health is still climbing',
     /resumeFlat/.test(fn) && /resumeWatch/.test(fn));
  ok('and the health gate yields once it has stopped',
     /hp < floor && stillMending/.test(fn), 'floor && stillMending');
  ok('as does the vigor gate', /vig < REST_VIGOR_CAP && stillMending/.test(fn));
  ok('and the absolute floor is still there for anyone who wants one',
     /travelStartHealth/.test(fn));
  // AGAINST THE BEST SEEN, NOT THE LAST SAMPLE. Comparing each reading to the previous one
  // makes any upward tick count as "still climbing" — and a character regenerating between
  // the same two points ticks upward for ever. Measured on shadow02: whole, out of recovery,
  // `mode idle` for six minutes holding a live objective, at 19 of 20, with the trend gate
  // refusing on the grounds that it was still getting better. The default floor is FULL
  // health, so without this the gate opens only for a character that hits its maximum
  // exactly and holds it there.
  ok('the trend is measured against the best reading seen, not the previous one',
     /resumeBest/.test(fn), 'the oscillation that never resumed');
  ok('and an equal reading counts as flat rather than as progress',
     /nowHp > this\.resumeBest/.test(fn));
  ok('and the memory is cleared when there is no journey, so the next one starts fresh',
     /this\.resumeBest = null/.test(fn));
  // The same argument releaseRestedHold already makes about a rest stop, which is where this
  // rule came from — standing there is worth it only while it is buying something.
  ok('which is the rule the rest stop already follows',
     /releaseRestedHold/.test(src));
}

console.log('');
console.log('A WATCHDOG RESCUE PAUSES A JOURNEY — IT DOES NOT THROW THE DESTINATION AWAY');
{
  // `revive` drops the objective and hands the body to the ordinary ladder. For an ERRAND
  // that is right — somebody else was driving and the errand is off. For a JOURNEY it is how
  // a character ends up standing in a troll den with nothing permitted.
  //
  // Measured in Ukgoth: the rail was "cancelled at 12 of 112 by the watchdog rescuing a
  // stalled driver", and the character then walked ZERO squares in fifteen seconds while the
  // ladder worked through "could not reach the safe spot" / "will not rest in the open here"
  // / "leaving the room to recover safely" / "could not leave" — and died with eleven
  // threats on it.
  //
  // The rescue itself is right: something was hitting it and the mover was not answering.
  // Throwing the destination away with the driver is what is not.
  const src = KEEPER_SRC;
  const rescue = src.slice(src.indexOf('WATCHDOG — took the character back from a driver') - 2400,
                           src.indexOf('WATCHDOG — took the character back from a driver'));
  // FOLLOW THE DELEGATION RATHER THAN WEAKEN THE ASSERTION. The extracted watchdog calls
  // host.suspendJourney?.(); m59-autopilot.mjs's suspendJourney(trigger) is where the
  // record is actually written, and it carries BOTH halves this pins — the journey guard
  // and the assignment. Searching only the inline rescue reads the split as a lost rescue.
  const delegated = /suspendJourney\?\.\(/.test(rescue);
  const hostSuspend = delegated
    ? src.slice(src.indexOf('  suspendJourney(trigger) {'),
                src.indexOf('  wantForwardShelter(why)'))
    : '';
  ok('the rescue records a suspended journey before reviving',
     /suspendedJourney = \{/.test(rescue) || /suspendedJourney = \{/.test(hostSuspend),
     rescue.slice(-200));
  ok('and only when a journey is what was holding the character',
     /const journey = this\.travelling/.test(rescue)
     || /const journey = this\.travelling/.test(hostSuspend));
  ok('and names itself as the trigger, so a post-mortem can tell it from a guard rung',
     /the watchdog rescued a stalled driver/.test(rescue));
  ok('and it still revives — the rescue is not being cancelled, only the forgetting is',
     /this\.revive\(/.test(rescue) || /this\.revive\(/.test(src));
}

console.log('');
console.log('A REST STOP ENDS WHEN THERE IS NOTHING LEFT TO GAIN BY STANDING THERE');
{
  // `leaveHold` only ever REFUSES a departure, and only while hurt, so nothing in the file
  // ever asked a HEALED character to go. Measured on a live fleet: 54 of 54 health and 80 of
  // 200 vigor — which the server itself calls `rested: true` — still reading "holding a
  // proven safe spot", with hold_resume_above of 0.9 satisfied long since. Sixteen of
  // eighteen legs ended in a timeout rather than a death. They were not stuck; they were
  // parked, and the cap expired around them.
  const held = () => ({ proven: true, at: Date.now() });

  const full = keeper({ health: 54, max: 54, vigor: 80, hold: held() });
  ok('full health and vigor at the resting cap releases the hold',
     (await full.releaseRestedHold()) === true && full.left.length === 1);
  ok('and it is FORCED, because the ordinary refusal is an argument about being hurt',
     full.left[0]?.opts?.force === true, JSON.stringify(full.left[0]?.opts));
  ok('and it says so, so a post-mortem can see why it moved',
     said(full, /full health and all the vigor resting can give/i));

  // VIGOR'S FULL IS 80 OF 200, and that is the whole subtlety. Resting stops awarding vigor
  // at the resting cap and everything above it has to be EATEN, so a release that waited for
  // vigor to be "full" in the ordinary sense would wait for the timeout instead.
  ok('one point under the resting cap is not full, and it stays',
     (await keeper({ health: 54, max: 54, vigor: 79, hold: held() }).releaseRestedHold()) === false);
  ok('but ABOVE the cap is still full — vigor over 80 came from food, not from resting',
     (await keeper({ health: 54, max: 54, vigor: 150, hold: held() }).releaseRestedHold()) === true);

  // Still hurt is still a rest stop: the Camilla case, who gave up a proven wall at 69%
  // and died 17.8 seconds later.
  ok('hurt at the wall is not released, however rested',
     (await keeper({ health: 30, max: 54, vigor: 200, hold: held() }).releaseRestedHold()) === false);
  ok('and hold_resume_above decides that, not a literal',
     (await keeper({ health: 40, max: 54, vigor: 80, hold: held(),
              policy: { holdResumeAbove: 0.7 } }).releaseRestedHold()) === true);

  // Cheap and silent when there is nothing to release — it is asked on every pass.
  const noHold = keeper({ health: 54, max: 54, vigor: 80 });
  ok('a character with no hold is a no-op rather than a throw',
     (await noHold.releaseRestedHold()) === false && noHold.left.length === 0 && noHold.notes.length === 0);

  const fighting = keeper({ hold: held(), policy: { requireSafeWall: false } });
  fighting.mode = 'farm';
  fighting.inReachOfUs = () => [{ id: 2 }];
  ok('full health does not give up a fighting wall while a monster is in contact',
     await fighting.releaseRestedHold() === false && fighting.left.length === 0);
  fighting.inReachOfUs = () => [];
  fighting.pendingPull = { id: 2 };
  ok('an outstanding pull also keeps its wall', await fighting.releaseRestedHold() === false);
  fighting.pendingPull = null;
  ok('an optional farming wall is released when its contact clears',
     await fighting.releaseRestedHold() === true);

  const reconnecting = keeper({ hold: held() });
  let completeLeave;
  reconnecting.leaveHold = () => new Promise(resolve => { completeLeave = resolve; });
  let finished = false;
  const leaving = reconnecting.releaseRestedHold().then(value => { finished = true; return value; });
  await Promise.resolve();
  ok('rest release waits for reconnect and pocket exit before farming can continue', !finished);
  completeLeave({ left: true });
  ok('release completes when the character is ready', await leaving === true);
}

console.log('');
console.log('THE RUNG THAT RESUMES HAS TO GET A TURN, AND FOR A DAY IT DID NOT');
{
  const src = KEEPER_SRC;
  // NARROWED TO THE BRANCH, NOT TO THE FILE BETWEEN TWO METHOD NAMES. Both
  // `resumeSuspendedJourney` and `releaseRestedHold` are defined between `passErrand` and
  // `passFarm`, and both legitimately mention the gates the last assertion here says must
  // not be COPIED into the idle branch. Slicing by method name swallowed them and the first
  // draft duly failed against perfectly correct code — twice, on two different methods.
  //
  // So the subject is the branch itself: from the idle test to the end of the stage.
  const errandAll = src.slice(src.indexOf('async passErrand'), src.indexOf('async passFarm'));
  // The branch ends where the STAGE does: `return CONTINUE;` at four spaces. Matching a
  // closing brace instead ran 14,640 characters past the end of the stage and swept in the
  // whole of `resumeSuspendedJourney` again, which is the third spelling of this same
  // mistake in one sitting — a slice is only as good as the thing that terminates it.
  const idleAt = errandAll.indexOf("if (this.mode === 'idle') {");
  const stageEnd = errandAll.indexOf('\n    return CONTINUE;', idleAt);
  const errand = idleAt >= 0 ? errandAll.slice(idleAt, stageEnd > 0 ? stageEnd : undefined) : '';
  ok('the idle branch is where it always was, at the tail of the stage', idleAt >= 0);

  // THE FAILURE THIS PINS. `passErrand` ends with an idle catch-all that claimed the tick
  // for ANY character in `mode idle`, and `passFarm` — which holds `resumeSuspendedJourney`
  // — is the very next rung. A journey that ends short sets the character idle, so from the
  // instant an objective was suspended the rung that would resume it never ran again.
  //
  // Three fixes went into the resume's own gates before this was found, and none of them
  // could have mattered. The ladder tracer's first run said so in one line:
  //
  //   ran: passUnderworld -> ... -> passErrand   [28 passes, 33s, room 596]
  //
  // seven rungs and no eighth. It should fail the day the eighth stops being reachable.
  ok('the idle branch asks whether there is an objective before claiming the tick',
     /A SUSPENDED JOURNEY IS A JOB/.test(errand));
  ok('and hands the tick to the resume when there is one',
     /this\.suspendedJourney[\s\S]{0,160}resumeSuspendedJourney/.test(errand));
  ok('and still hibernates when the resume declines, because mending is what idle is for',
     /idle: no job to do/.test(errand));
  // The resume must be ASKED, not reimplemented here — one copy of the gates, in one place.
  ok('the idle branch does not re-implement any resume gate',
     !/travelStartHealth|REST_VIGOR_CAP|resumeFlat/.test(errand));

  // AND THE LADDER ORDER IS UNCHANGED. Fixing this by reordering PASS_STAGES would have
  // moved a directional decision above survival, which is the one thing the boundary
  // between this repository and a bot is not allowed to do.
  ok('passFarm is still last', PASS_STAGES[PASS_STAGES.length - 1] === 'passFarm',
     PASS_STAGES.join(','));
  ok('and passErrand is still the one before it',
     PASS_STAGES[PASS_STAGES.length - 2] === 'passErrand', PASS_STAGES.join(','));
}

console.log('');
console.log('AND THE WALK IS RECORDED, BECAUSE THAT IS WHAT FOUND IT');
{
  const src = KEEPER_SRC;
  // Every other instrument reports the RESULT of the ladder walk. This one reports the walk,
  // and three different bugs share the symptom `mode idle` without it.
  ok('the ladder records which rungs got a turn', /const ran = \[\];/.test(src));
  ok('and which one ended the tick', /traceThisPass\(ctx, ran, stage\)/.test(src));
  ok('and says so when every rung passed', /traceThisPass\(ctx, ran, null\)/.test(src));
  ok('and it carries the objective, which is the field it was built for',
     /suspended_to: this\.suspendedJourney/.test(src));
  // A diagnostic that can end a tick is worse than no diagnostic.
  ok('and a diagnostic can never end a tick',
     /never break the keeper/.test(src));
}

console.log('');
console.log('A DEATH IS A FAILED JOURNEY, NOT AN INTERRUPTED ONE');
{
  const src = KEEPER_SRC;
  const rule = src.slice(src.indexOf('journeyEndedInADeath(where'),
                         src.indexOf('recordFrame(why = null)'));

  // THE OPERATOR'S RULE. Out of the Underworld, to the inn the exit lands in, and rest —
  // and do NOT pick the road back up. Whatever killed the character is still on it,
  // everything carried is on the floor where it fell, and max health has already been paid.
  //
  // Refined by the operator into ONE NUMBER rather than a rule plus an exception: nought
  // deaths allowed IS "a death ends the journey", and a road worth dying for says so.
  ok('the allowance is a policy with a default of nought',
     /travelDeathsAllowed \?\? 0/.test(rule));
  ok('over the allowance the objective is cleared', /this\.suspendedJourney = null/.test(rule));
  ok('and says so, because a journey that vanishes silently is the bug this replaces',
     /the journey ended in a death, so it is not resumed/.test(rule));
  ok('and names what happens instead', /out of the Underworld, then rest at the inn/.test(rule));
  ok('under the allowance it is KEPT rather than dropped',
     /spent <= allowed[\s\S]{0,400}worth another try/.test(rule));

  // PER OBJECTIVE, NOT PER LIFETIME. `tally.deaths` cannot answer "what has THIS trip cost"
  // — a keeper restarts about once a minute and takes its counters with it.
  ok('the count is kept beside the destination it belongs to',
     /this\.journeyDeaths = \{ to: dest, count: spent \}/.test(rule));
  ok('and a different destination starts from nought',
     /Number\(book\.to\) === dest/.test(rule));

  // THE REST IS GUARANTEED BY THE LADDER, NOT BY THIS CODE, which is the only reason
  // offering a retry is safe: the recovery hold is the first rung, the resume is the last.
  ok('and the retry says the resting happens first',
     /rest to whole/.test(rule));

  // ONE COPY. This is the assertion that would have caught the bug this refactor fixes.
  //
  // Four places suspend an objective — the travel job's `finally`, the watchdog's rescue of
  // a stalled driver, a guard take-back, and the resume. The rule was first written into
  // only the first of them, and shadow02 came back from the Cragged Mountains still holding
  // `{to: 38, trigger: 'the watchdog rescued a stalled driver'}` twelve minutes after a
  // troll had settled the question, because its death arrived through a different door.
  ok('and the rule is called the moment a death is DISCOVERED, not from one walk path',
     /woke up dead[\s\S]{0,400}journeyEndedInADeath/.test(src));

  const broker = BROKER_SRC;
  const job = broker.slice(broker.indexOf('travelJob(dest,'),
                           broker.indexOf('travelExclusive(dest'));
  ok('the travel job DELEGATES rather than keeping a second copy',
     /journeyEndedInADeath/.test(job));
  ok('and the second copy is gone', !/travelDeathsAllowed/.test(job),
     'the allowance is spelled twice again');

  // THREE SIGNALS FOR "did it die", because the obvious one does not survive the escape.
  ok('room 1 counts as a death', /here === 1/.test(job));
  ok('and so does still being on the recovery hold, which survives leaving room 1',
     /keeper\?\.recoverUntilWhole === true/.test(job));
  ok('the death count is read BEFORE the walk, not after it',
     /const deathsAtStart = Number\(keeper\?\.tally\?\.deaths/.test(job));
  ok('and the tally is only ever used as a comparison, never on its own',
     /> deathsAtStart/.test(job));

  // A SETTING THAT IS NOT IN THE SCHEMA SILENTLY DOES NOTHING — how `purpose` stayed out of
  // one for a year with every keeper's audit switched off.
  ok('the knob is declared in the autopilot schema',
     /travel_deaths_allowed: \{ type: 'number'/.test(broker));
  ok('and it is actually read off the arguments',
     /a\.travel_deaths_allowed !== undefined/.test(broker));
  ok('and refused rather than coerced when it is not a whole number of deaths',
     /travel_deaths_allowed must be a whole number/.test(broker));
}

console.log('');
console.log('AND THE ALLOWANCE RUN AS CODE, NOT READ AS TEXT');
{
  // Everything above greps the source, which is right for pinning an ARGUMENT and wrong for
  // pinning ARITHMETIC. The bug this section exists for was not a missing sentence: the rule
  // was spelled correctly and simply never reached, because shadow02's death arrived through
  // the watchdog rather than through the travel job. So run it.

  // Nought allowed — the default, and the operator's rule.
  const k = keeper();
  k.suspendedJourney = { to: 38, why: 'travelling', at: Date.now(),
                         trigger: 'the watchdog rescued a stalled driver',
                         attempts: 1, deaths_at: 0 };
  const out = k.journeyEndedInADeath('a troll');
  ok('a death drops the objective when nothing is allowed', k.suspendedJourney === null);
  ok('and reports that it did not keep it', out?.kept === false, JSON.stringify(out));
  ok('and it does not matter which door the death came through — this one was a watchdog ' +
     'suspension, which is exactly what shadow02 was still carrying',
     !said(k, /worth another try/) && said(k, /not resumed/));

  // One allowed: kept the first time, dropped the second.
  const r = keeper({ policy: { travelDeathsAllowed: 1 } });
  r.suspendedJourney = { to: 38, why: 'travelling', at: Date.now(), trigger: 't',
                         attempts: 1, deaths_at: 0 };
  const first = r.journeyEndedInADeath('a troll');
  ok('one death allowed keeps the objective the first time', first?.kept === true
     && r.suspendedJourney !== null, JSON.stringify(first));
  ok('and says the resting comes first', said(r, /rest to whole/));
  const second = r.journeyEndedInADeath('another troll');
  ok('and drops it on the second', second?.kept === false && r.suspendedJourney === null,
     JSON.stringify(second));

  // PER OBJECTIVE. A different destination starts from nought, or a character that died once
  // on the way to Tos arrives at the next errand already one strike down.
  const per = keeper({ policy: { travelDeathsAllowed: 1 } });
  per.suspendedJourney = { to: 38, why: 'a', at: Date.now(), trigger: 't', attempts: 1, deaths_at: 0 };
  per.journeyEndedInADeath('x');
  per.suspendedJourney = { to: 593, why: 'b', at: Date.now(), trigger: 't', attempts: 1, deaths_at: 0 };
  const other = per.journeyEndedInADeath('x');
  ok('a death on a DIFFERENT objective starts its own count', other?.spent === 1,
     JSON.stringify(other));
  ok('and so that one is kept too', per.suspendedJourney !== null);

  // No objective at all is not an error — a character can die while nothing has been asked
  // of it, and the tab must not survive to be spent by whatever is asked next.
  const idle = keeper();
  idle.journeyDeaths = { to: 38, count: 5 };
  ok('a death with no objective is a no-op', idle.journeyEndedInADeath('x') === null);
  ok('and it clears any leftover tab', idle.journeyDeaths === null);
}

console.log('');
console.log('THE ERRANDS STAND DOWN UNDER A JOURNEY');
{
  // Every branch of `passErrand` WALKS THE CHARACTER SOMEWHERE — the bank, the vault, a
  // delivery — and not one of them asked whether it was already going somewhere. Measured
  // on shadow02, holding {to: 38} for a whole ten-minute leg:
  //
  //     mode idle | passes 2 | running_for_seconds 592
  //     recent: First Royal Bank of Tos ... banking ... buying food ... resting
  //
  // Two ladder passes in 592 seconds. Not stuck, not lost — in town, doing what its policy
  // says, while a journey waited. And because `bankRun` is a long await, nothing below it
  // got a turn either, including the rung that would have resumed the road.
  const travelling = keeper();
  travelling.inert = { travelling: true, to: 38, why: 'travelling to Castle Victoria' };
  ok('a travelling character does not go shopping',
     await travelling.passErrand(ctxFor(travelling)) === CONTINUE);
  ok('and says so once rather than a stage going quiet',
     said(travelling, /errands stand down while there is a road to walk/));

  // A SUSPENDED OBJECTIVE COUNTS TOO, and this is the half that matters most: it is
  // precisely while a journey is paused that the resume — one rung BELOW this one — is
  // trying to get the body back on the road. Handing those ticks to the bank instead is how
  // a paused journey becomes a shopping trip.
  const paused = keeper();
  paused.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                              attempts: 1, deaths_at: 0 };
  ok('a paused journey also stands the errands down',
     await paused.passErrand(ctxFor(paused)) === CONTINUE);
  ok('and names the state rather than only the destination',
     said(paused, /waiting to resume/));

  // SAID ONCE, NOT EVERY PASS. This runs about once a second.
  const before = paused.notes.length;
  await paused.passErrand(ctxFor(paused));
  ok('and it does not repeat every pass', paused.notes.length === before);

  // AND IT LIFTS. An errand is an END STATE rather than a schedule — the bank is still
  // there on arrival — so the stage has to come back when the road is finished, or a
  // character that once travelled would never bank again.
  paused.suspendedJourney = null;
  paused.inert = null;
  const after = await paused.passErrand(ctxFor(paused));
  ok('with no road left the stage runs again', after !== CONTINUE || paused.errandsStoodDown === false,
     JSON.stringify({ after: String(after), stoodDown: paused.errandsStoodDown }));
}

console.log('');
console.log('AND THEY ARE NOT ABOLISHED — THEY ARE MOVED IN FRONT OF THE ROAD');
{
  // The operator's shape, and it is the right one: most of the time a character sent across
  // the world should bank its takings and top up its food FIRST and then go — not discover
  // halfway through the Twisted Wood that it wants a bank. So the errands are not switched
  // off under a journey, they happen BEFORE it.
  const k = keeper();
  const ran = [];
  k.bankSurplus = async () => { ran.push('bankSurplus'); return false; };
  k.vaultRunIfPassing = async () => { ran.push('vaultRunIfPassing'); return false; };
  k.bankRun = async () => { ran.push('bankRun'); return true; };
  k.deliverFarmSupplies = async () => { ran.push('deliverFarmSupplies'); return false; };
  const did = await k.settleErrandsBeforeJourney({ where: 'Castle Victoria' });
  ok('every errand gets its one turn before setting off',
     JSON.stringify(ran) === JSON.stringify(['bankSurplus', 'vaultRunIfPassing', 'bankRun',
                                             'deliverFarmSupplies']), JSON.stringify(ran));
  ok('and what it actually did is recorded', did.includes('went to the bank'),
     JSON.stringify(did));
  ok('and said, so a journey that starts late has a reason',
     said(k, /did the errands before setting off/));

  // AN ERRAND THAT FAILS MUST NOT STOP THE JOURNEY. A full pack or a shut shop turning into
  // a character that never leaves town is the "a trip that cannot fix the thing that opened
  // it will run for ever" trap this repository already documents.
  const broken = keeper();
  broken.bankSurplus = async () => { throw new Error('pack is full'); };
  broken.vaultRunIfPassing = async () => false;
  broken.bankRun = async () => { throw new Error('no bank in Barloque'); };
  broken.deliverFarmSupplies = async () => false;
  let threw = false;
  try { await broken.settleErrandsBeforeJourney({ where: 'x' }); } catch { threw = true; }
  ok('a failing errand does not throw the journey away', !threw);
  ok('and the failure is named rather than swallowed',
     said(broken, /no bank in Barloque/));

  // THE FLAG ITSELF. Default true — the common case — and false for a timed measurement or
  // an emergency, which are the two cases the operator named.
  const broker = BROKER_SRC;
  ok('the journey takes the flag and defaults it to true',
     /travelJob\(dest, \{ where = `room \$\{dest\}`, runErrands = true/.test(broker));
  ok('and only runs them when it is set',
     /if \(runErrands && keeper\?\.settleErrandsBeforeJourney\)/.test(broker));
  ok('the travel tool declares it, so it is not a setting that silently does nothing',
     /run_errands: \{ type: 'boolean'/.test(broker));
  ok('and reads it off the arguments defaulting to on',
     /runErrands: a\.run_errands !== false/.test(broker));
  // The measurement is the case that must not include a shopping trip.
  const solo = readFileSync(join(HERE, 'm59-solo-run.mjs'), 'utf8');
  ok('and a timed leg asks for none of it', /run_errands: false/.test(solo));
}

console.log('');
console.log('THE WALL COMES FIRST, AND THE ROAD WAITS FOR IT');
{
  // TWO RUNGS THAT DISAGREED ABOUT WHAT "HURT" MEANS, with the resting supposed to happen
  // in the gap between them. The mid-hop rung now pauses a journey at ANY damage; the
  // ladder's rest rung only acts below `restBelow` (0.7). So a character at 85% cancelled
  // its crossing for a wall, dropped into a ladder with no answer for it, stood still, and
  // was picked back up by the resume having rested for none of it:
  //
  //   Aaaa  28/33 (85%)  travel_paused_for_wall  ->  0r rest, dead at 92s
  //   Bbbb  15/20 (75%)  travel_paused_for_wall  ->  0r rest, dead at 175s
  //
  //     +34s  room 587  idle
  //     +66s  room 587  inert — travelling to 38 (resumed)
  //
  // Thirty-two seconds standing still, no wall, no health, back on the road.

  // 1. A HOLD IN PROGRESS OUTRANKS THE ROAD. `releaseRestedHold` is what decides a rest is
  //    finished — it refuses below full health and the resting vigor cap — so if the hold
  //    survived that call, the rest is mid-way and the body is not available.
  const mending = keeper({ health: 20, max: 37, hold: { room: 587, col: 5, row: 42 } });
  mending.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'a wall',
                               attempts: 1, deaths_at: 0 };
  const verdict = await mending.resumeSuspendedJourney(ctxFor(mending));
  ok('a character still holding a wall does not resume', verdict === CONTINUE);
  ok('and the objective is kept rather than dropped', mending.suspendedJourney !== null);
  ok('and it says the rest is unfinished, not that it is unwell',
     said(mending, /the rest is not finished/));
  ok('and it did not travel', mending.travelled.length === 0);

  // 2. A WALL ASKED FOR BUT NOT YET TAKEN IS ALSO A REASON TO WAIT. The shelter rung is one
  //    pass away; resuming now cancels the request before anything acts on it.
  const asked = keeper({ health: 30, max: 37 });
  asked.wantsForwardShelter = 'the journey paused for a wall';
  asked.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'a wall',
                             attempts: 1, deaths_at: 0 };
  ok('a wall asked for and not taken holds the road back',
     await asked.resumeSuspendedJourney(ctxFor(asked)) === CONTINUE);
  ok('and says which of the two it is waiting on',
     said(asked, /asked for and not taken/));
  ok('and the request survives to be acted on',
     asked.wantsForwardShelter === 'the journey paused for a wall');

  // 3. AND IT LIFTS. Neither of these may become a character that never travels again.
  const done = keeper({ health: 37, max: 37 });
  done.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 'a wall',
                            attempts: 1, deaths_at: 0 };
  done.resumeBest = 37; done.resumeFlat = 99;      // whole, and the trend has settled
  const went = await done.resumeSuspendedJourney(ctxFor(done));
  ok('with no hold and no request outstanding the road resumes', went === HANDLED,
     JSON.stringify({ verdict: String(went), travelled: done.travelled.length }));
  ok('and it actually travels', done.travelled.some(t => t.to === 38),
     JSON.stringify(done.travelled));

  // 4. THE PAUSE ASKS FOR THE WALL AT ALL. The note in `takeBack` used to ASSERT that the
  //    ordinary ladder would answer, which was true only for a character it considered hurt.
  ok('pausing for a wall sets the request the shelter rung reads',
     /if \(!abandon\) this\.wantsForwardShelter = 'the journey paused for a wall'/
       .test(KEEPER_SRC));
}


console.log('');
console.log('FLAT ONLY MEANS "AS WELL AS I WILL GET" IF SOMETHING IS HEALING YOU');
{
  // The gate is "go on when the wall has stopped paying", counted as samples where health
  // did not reach a new high. Right for a character behind a wall. EXACTLY BACKWARDS for one
  // standing in the open: nothing is healing it, so health is flat, so the counter fills in
  // eight seconds and the gate opens on a hurt character.
  //
  // Measured, Aaaa — the whole failure in three lines of its own record:
  //
  //     +40s  room 587  idle                                  journey suspended
  //     +46s  room 587  inert — travelling to 38 (resumed)    SIX SECONDS later
  //     +194s room 598  idle          ... dead at 257s, 0r rest
  //
  // with the refusal one pass earlier reading `still mending — health 88%, flat 0`.
  const hurtInTheOpen = keeper({ health: 30, max: 37 });
  hurtInTheOpen.doing = 'travelling';
  hurtInTheOpen.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                                     attempts: 1, deaths_at: 0 };
  // Ten passes of no healing whatsoever — the shape that used to open the gate.
  for (let i = 0; i < 10; i++) await hurtInTheOpen.resumeSuspendedJourney(ctxFor(hurtInTheOpen));
  ok('ten samples of not healing do not add up to being well',
     hurtInTheOpen.travelled.length === 0, JSON.stringify(hurtInTheOpen.travelled));
  ok('and it asks for a wall rather than waiting for a recovery that cannot happen',
     hurtInTheOpen.wantsForwardShelter != null);
  ok('and says which of the two it is doing',
     said(hurtInTheOpen, /hurt with nowhere to mend/));

  // BOUNDED. A room with no reachable wall must not become a character that never travels
  // again, so after a few asks the old trend gate is allowed to open — which is at least a
  // decision, and the absolute floor and the attempt cap still bound it.
  ok('the asking is bounded rather than a new way to never leave',
     /resumeWallAsks/.test(KEEPER_SRC));

  // AND AT A WALL IT STILL WORKS AS BEFORE: flatness there is real evidence.
  const atAWall = keeper({ health: 36, max: 37, hold: { room: 587, col: 5, row: 42 } });
  atAWall.doing = 'holding a proven safe spot';
  atAWall.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                               attempts: 1, deaths_at: 0 };
  await atAWall.resumeSuspendedJourney(ctxFor(atAWall));
  // At a wall the HOLD gate answers first — the rest is not finished — so the trend counter
  // is never reached, and that is right:  is what decides a rest is done.
  ok('a character at a wall is held by the rest, not by the trend',
     said(atAWall, /the rest is not finished/) && atAWall.travelled.length === 0);

  // AND THE DEADLOCK THE FIRST DRAFT OF THIS CREATED. With flatness counting only while
  // resting, a character that had used up its wall-asks could never accumulate a sample, so
  // it declined for ever. A room with no reachable wall would have become a character that
  // never travels again — the exact failure every refusal in that method is written against.
  const noWall = keeper({ health: 30, max: 37 });
  noWall.doing = 'travelling';
  noWall.suspendedJourney = { to: 38, why: 'x', at: Date.now(), trigger: 't',
                              attempts: 1, deaths_at: 0 };
  for (let i = 0; i < 40; i++) await noWall.resumeSuspendedJourney(ctxFor(noWall));
  ok('and once the asking runs out it goes rather than declining for ever',
     noWall.travelled.length > 0, JSON.stringify({ flat: noWall.resumeFlat, asks: noWall.resumeWallAsks }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
