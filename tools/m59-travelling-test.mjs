#!/usr/bin/env node
// A JOURNEY STEERS A CHARACTER. IT DOES NOT SWITCH OFF ITS WILL TO LIVE.
//
//   node tools/m59-travelling-test.mjs
//
// Offline. No socket, no broker, no roster — safe any time.
//
// ======================== THE DEATH THIS SUITE IS BUILT FROM ========================
//
// Cccc, shadow fleet, 2026-08-21T02:30:25Z. The record, second by second, because every
// assertion below is one line of it:
//
//   02:27:31  dies in the Cragged Mountains. Wakes in the Underworld at 2 of 37.
//   02:29:13  a commute driver polls, sees him "stuck in room 1" — which is the Underworld
//             — and re-sends `travel`. `travelJob` calls goInert. THE SURVIVAL LADDER IS
//             NOW OFF for the length of the walk.
//   02:29:31  the keeper escapes the Underworld (the one thing above the inert gate) into
//             the Limping Toad Inn, a sanctuary, at 11 of 37.
//   02:29:40  "You open the door and walk through." The journey walks him back OUT of the
//             inn at 30% health, against a flee threshold of 70%.
//   02:30:00  enters West Merchant Way through Ilerian Woods. Six things in the room.
//   02:30:00  ...to 02:30:23. Twenty-two seconds. Health 10, 8, 6, 4, 3. Pulses read
//             23,3 / 25,5 / 26,5 / 25,5 — a two-square shuffle against a wall.
//   02:30:19  the old rescue finally fires, 5.1 seconds before the end, because it also
//             required four seconds of STILLNESS and the shuffle reset that timer on
//             every sample.
//   02:30:23  "### Cccc was just killed by a giant rat."
//
// Nothing in the survival ladder was broken. The ladder was switched off, deliberately, by
// a state that means "somebody else is driving" being used for a driver that only steers.
//
// So this suite pins two properties, and both of them erode silently:
//
//   1. THE STATE IS DIFFERENT FROM INERT. A journey takes `goTravelling`, an errand takes
//      `goInert`, and a journey may not quietly upgrade itself into the errand's silence.
//   2. THE TRIGGERS DO NOT ASK WHETHER THE BODY IS MOVING. Below the flee line with
//      something adjacent is enough; so is losing health fast enough that the bar empties
//      before the road ends. A character being eaten while it walks is in exactly as much
//      trouble as one being eaten while it stands, and it is harder to see.
//
// It should fail the day somebody makes a journey blind again.

import { Autopilot, TRAVEL_GUARD_DEFAULTS, TRAVEL_GUARD_KEYS, TRAVEL_GUARD_CLOCK,
         PASS_STAGES, HANDLED, CONTINUE } from './m59-autopilot.mjs';
// The real flag values rather than numbers written out here. A fixture that hardcodes
// 0x200 for ATTACKABLE builds a room full of things the code under test cannot see, and
// then passes every assertion that expects nothing to happen.
import { OF } from './m59-parse.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// THE SPLIT MOVED THE CODE, SO A SOURCE GREP HAS TO FOLLOW IT — AND A GREP THAT
// CANNOT FIND ITS SUBJECT PASSES THE NEGATIVE ASSERTIONS RATHER THAN FAILING THEM.
// `Session` (travelJob) lives in m59-game.mjs and `pennedIn` in m59-watchdog.mjs since
// the keeper split. Reading only the two original files left the travelJob assertions
// searching a file that no longer contains travelJob: the positive ones failed loudly,
// which is how this was found, but `travelJob does not reach for goInert` sliced from
// an indexOf of -1 and passed on an empty haystack. Concatenate rather than re-point,
// so an assertion keeps working whichever side of the split its subject ends up on.
const read = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const AUTOPILOT_SRC = read('tools/m59-autopilot.mjs') + '\n' + read('tools/m59-watchdog.mjs');
const BROKER_SRC = read('tools/m59-broker.mjs') + '\n' + read('tools/m59-game.mjs');

// A keeper with no session behind it.
//
// The prototype rather than `new Autopilot(...)`, for the same reason m59-unattended-test
// does it: a real constructor wants a session, which wants a socket, which wants a server,
// and the whole value of this suite is that it runs on a laptop with nothing up.
//
// `who()` resolves to null here on purpose — `recordEvent` is a no-op for a nameless
// character, so a test that exercises a take-back does not append to the real ledger.
const keeper = ({ health = 30, max = 37, vigor = 80, adjacent = 0, players = 0, armed = true,
                  fleeAt = 0.7, guard = null, policy = {}, pulses = null } = {}) => {
  const notes = [];
  const objects = new Map();
  // A monster carries ATTACKABLE and not PLAYER. That distinction is load-bearing
  // everywhere in this file — every character is ATTACKABLE, and the fleet walks the same
  // roads — so the fixture builds it from the real flags.
  for (let i = 0; i < adjacent; i++)
    objects.set(i + 10, { id: i + 10, flags: OF.ATTACKABLE, col: 25, row: 5, nameRsc: 1 });
  // A STRANGER IS A PLAYER THAT IS NOT ONE OF OURS, and it needs BOTH flags: the room
  // filter asks for PLAYER and ATTACKABLE together. `rsc` is absent from this fixture, so
  // the name lookup yields undefined and `party.isFleetmate` says no — which is what makes
  // these strangers rather than fleetmates.
  for (let i = 0; i < players; i++)
    objects.set(i + 90, { id: i + 90, flags: OF.PLAYER | OF.ATTACKABLE, col: 25, row: 5, nameRsc: 2 });
  const self = { id: 1, col: 25, row: 5 };
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, policy, claims: new Map(), passes: 1,
    tally: {}, doing: 'travelling',
    book: { save: () => {} },
    watch: { pulses: pulses ?? [], wedges: 0 },
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {},
    noProgress: () => {},
    recordFrame: () => {},
    armed: () => armed,
    safety: () => ({ fleeAt }),
    ledgerEvent: () => {},
    s: {
      name: null,
      cancelMovement: () => ({ cancelled: true, interrupted: { kind: 'travel', label: 'walk to 39' } }),
      world: { room: { num: 535, name: 'West Merchant Way through Ilerian Woods' } },
      client: {
        selfId: 1, self,
        room: { objects },
        vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }),
      },
    },
  });
  if (guard) k.inert = { why: 'travelling to Upstairs in Castle Victoria', at: Date.now(),
                         maxMs: 900_000, travelling: true, guard: k.travelGuard(guard) };
  return k;
};

// The context the pass ladder hands every stage.
const ctxFor = k => {
  const v = k.s.client.vitals();
  return { s: k.s, c: k.s.client, room: k.s.world.room, v,
           hp: v.health.max ? v.health.value / v.health.max : null };
};

// Pulses shaped like the real ring: `n` samples one second apart, health falling by
// `perSample`, and — unless `still` — shuffling between two squares the way Cccc did.
const ring = ({ n = 6, from = 10, perSample = 0.5, still = false } = {}) => {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    at: now - (n - 1 - i) * 1000,
    room: 535,
    col: still ? 25 : (i % 2 ? 26 : 25),
    row: 5,
    health: Math.round(from - i * perSample),
    doing: 'travelling',
  }));
};

// ---------------------------------------------------------------------------
console.log('\nthe guard: what a journey leaves switched on');
{
  // FIVE, not six. `play_dead` was removed 2026-08-21: it cancelled a journey so the
  // ordinary ladder could freeze, and freezing is now refused anywhere but a proven safe
  // spot because it recovers vigor and NEVER health. The doomed rung it gated still exists
  // and is gated on `flee` instead — see "inside two hits of death" below.
  // ONLY A PERSON AND DYING MAY END A JOURNEY — operator's doctrine, 2026-08-27, measured
  // off 37 road deaths (median 119s to die, median 68s below the flee line, 1.9% of frames
  // holding a spot). Everything else that happens on a road has ONE answer: park on the next
  // route-adjacent safe spot, play dead once, rest full, carry on.
  //
  // So the defaults are no longer uniform, and which ones are on is the doctrine written down:
  //
  //   flee        ON  — gated on `worthEnding`, PEOPLE ONLY under travel_flee_from
  //   fight_back  ON  — same gate; it is the "a PERSON is emptying the bar" abandon
  //   rest        ON  — a hop-boundary pause, never an abandon
  //   safe_spot   ON  — the whole replacement behaviour
  //   arm         OFF — the ONLY one that could fire for a monster, at full health
  //
  // The last line is the change. Pinned as an explicit map rather than "all of them", because
  // "every faculty is true" is exactly the assertion that cannot express a doctrine.
  ok('the guard permits a PERSON and a rate, and nothing a monster can cause',
     JSON.stringify(TRAVEL_GUARD_DEFAULTS) ===
       JSON.stringify({ flee: true, fight_back: true, arm: false, rest: true, safe_spot: true }),
     JSON.stringify(TRAVEL_GUARD_DEFAULTS));
  ok('and there are still exactly five of them', TRAVEL_GUARD_KEYS.length === 5,
     JSON.stringify(TRAVEL_GUARD_KEYS));
  // THE RULE BEHIND THE MAP, so a faculty added later has to answer this question too: can
  // this fire because of a MONSTER? If it can, it does not default on.
  ok('nothing that a monster alone can trigger is on by default',
     TRAVEL_GUARD_DEFAULTS.arm === false,
     'arm cancels at full health on a fact about the pack, in rooms that kill in nine seconds');
  ok('and every one of them says which clock it is on',
     TRAVEL_GUARD_KEYS.every(key => ['mid-hop', 'hop boundary', 'both'].includes(TRAVEL_GUARD_CLOCK[key])),
     JSON.stringify(TRAVEL_GUARD_CLOCK));
  // NOTHING IS ON BOTH ANY MORE, AND THE REASON IS WHAT MID-HOP COSTS.
  //
  // `safe_spot` was 'both' on a real argument — the Cragged Mountains is 2,450 squares and
  // kills a character long before it offers a boundary to be asked at. What that argument
  // missed is that the only thing a mid-hop trigger CAN do is cancel the crossing: the mover
  // has the body. Firing on any damage in a zone that outranks the character then tore the
  // crossing down at step 0 of 40, over and over, and a shelter that prevents arrival is not
  // shelter. One faculty on one clock, and the wall pauses at the boundary instead.
  // CORRECTED 2026-08-23. The line above is the argument as it stood, and the half of it
  // that has since become false is "cancelling is the cost". A cancelled journey used to be
  // a LOST journey; f245be5 made one that ends short keep its destination, and a4bb63f fixed
  // the rung that resumes it — `passErrand`'s idle catch-all ended every tick before
  // `passFarm` was ever reached, so the resume had never once fired in the life of this
  // repository. It fires now. Mid-hop is therefore a pause by a slower route.
  //
  // And the thing that actually made mid-hop unaffordable was never the clock: it was
  // `travelShelterBelow` returning 1 — shelter at any damage at all — in a zone that
  // outranks the character, which the Twisted Wood does continuously. Fixed at its source.
  ok('the wall is on BOTH clocks, because a mid-hop cancel now keeps its objective',
     TRAVEL_GUARD_CLOCK.safe_spot === 'both', JSON.stringify(TRAVEL_GUARD_CLOCK));
  ok('and it is the only faculty that is, because it is the only one that can be resumed',
     TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'both').join() === 'safe_spot',
     JSON.stringify(TRAVEL_GUARD_CLOCK));
  // A THRESHOLD OF 1 IS NOT A THRESHOLD, and that is the assertion that would have stopped
  // the whole detour. A dangerous room is a reason to shelter EARLIER, not at full health.
  // CORRECTED AGAIN, SAME DAY, AND DELIBERATELY LEFT AS A TRAIL RATHER THAN TIDIED.
  //
  // This line first said "nothing is on both clocks". Then it said "an outranking room
  // shelters earlier rather than at any scratch", asserting that the threshold was no longer
  // 1. It is 1 again, and the operator's argument for that is the one that holds:
  //
  //   What made a sensitive trigger unaffordable was never its sensitivity. It was that the
  //   shelter it triggered never COMPLETED — the search only considered coarse-walkable
  //   squares, so every spot in the book was ordinary floor, eighteen steps away, and a stop
  //   bought nothing. Standing on grass does not stop anything, so the rung fired again
  //   immediately and the crossing was torn down thirty times in a leg.
  //
  // With the spot a real wall 2.2 squares away and the cancel keeping its destination, a
  // stop costs a few seconds and returns full health behind geometry nothing can path to.
  // Against rooms that cross in fifteen to twenty-five seconds, that is cheap against any
  // chance of dying.
  //
  // So what is pinned now is the LOOP GUARD, because that is what carries the load once the
  // threshold stops trying to: a per-room budget, with the doomed case exempt from it.
  // CORRECTED AGAIN, AND THIS TIME BY THE TRANSIT BOOK RATHER THAN BY AN ARGUMENT.
  //
  // "Any damage is enough" was right about the cost of ONE stop and silent about the cost of
  // stopping OFTEN. Every journey of that evening ended
  //
  //     legs 2, planned_legs 7      hp 33 -> 29
  //
  // cancelled by this very rung, four health down, leaving the character idle in a
  // 750-danger room until something killed it. The room is not unsurvivable — twenty-
  // hitpoint mules cross to Castle Victoria daily — the difference is that they keep moving.
  // A stationary character measured thirty health lost in eight seconds; a moving one
  // outpaces most of what chases it.
  ok('a scratch does not cancel a crossing',
     /travelWallBelow \?\? 0\.5\)/.test(AUTOPILOT_SRC), 'mid-hop is for real trouble only');
  ok('and an outranking room shelters a little earlier, not at full health',
     /travelWallBelowOutranked \?\? 0\.55/.test(AUTOPILOT_SRC));
  ok('and the per-room budget is what stops a hostile room looping',
     /travelShelterPerRoom \?\? 4/.test(AUTOPILOT_SRC));
  // The split is what keeps "only one thing drives a body" true, so it is pinned rather
  // than left to a comment: the four that CANCEL a journey and the two that PAUSE it.
  const midHop = TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'mid-hop');
  ok('the three that interrupt a journey are the mid-hop ones',
     JSON.stringify(midHop.sort()) === JSON.stringify(['arm', 'fight_back', 'flee']),
     JSON.stringify(midHop));
  const boundary = TRAVEL_GUARD_KEYS.filter(key => TRAVEL_GUARD_CLOCK[key] === 'hop boundary');
  ok('and resting is the one that only ever pauses',
     JSON.stringify(boundary.sort()) === JSON.stringify(['rest']),
     JSON.stringify(boundary));

  const k = keeper({ policy: { travelGuard: { flee: false } } });
  ok('a policy switch turns exactly one faculty off', k.travelGuard().flee === false);
  // AGAINST THE DEFAULTS, NOT AGAINST `true`. The point of this assertion is that switching
  // one faculty does not disturb its neighbours, and once the defaults stopped being uniform
  // "everything else is true" stopped expressing that — it would fail on a correct switch and
  // pass on a broken one that happened to turn everything on.
  ok('and leaves every other faculty at its default',
     TRAVEL_GUARD_KEYS.filter(key => key !== 'flee')
       .every(key => k.travelGuard()[key] === TRAVEL_GUARD_DEFAULTS[key]),
     JSON.stringify(k.travelGuard()));
  ok('an explicit override beats the policy',
     k.travelGuard({ flee: true }).flee === true);
  // The rule from docs/m59-policy.md: an unrecognised key is never merged into a shape the
  // rest of the file would read as a real faculty. The TOOL refuses it; this refuses to
  // carry it.
  ok('an unrecognised faculty is dropped rather than carried into the shape',
     !('teleport' in keeper({ policy: { travelGuard: { teleport: true } } }).travelGuard()));
}

// ---------------------------------------------------------------------------
console.log('\ntravelling is not inert, and cannot become it by accident');
{
  const k = keeper();
  k.goTravelling('travelling to Upstairs in Castle Victoria');
  ok('goTravelling marks the hold as a journey', k.inert?.travelling === true);
  ok('and `travelling` reads it back', !!k.travelling);
  ok('and it still reads as held to everything that asks the old question',
     k.inertStatus()?.inert === true);
  ok('the status says which stand-down it is', k.inertStatus()?.state === 'travelling');
  // THE LIST IS WHAT IS STILL ON, AND IT IS NO LONGER ALL OF THEM. That is precisely what an
  // operator needs to read before a death: `arm` being absent here is the doctrine visible
  // from outside, and a status that always listed five could never have shown it.
  ok('and lists what is still allowed, so an operator can see it before a death',
     Array.isArray(k.inertStatus()?.may_still) &&
     JSON.stringify([...k.inertStatus().may_still].sort()) ===
       JSON.stringify(TRAVEL_GUARD_KEYS.filter(f => TRAVEL_GUARD_DEFAULTS[f]).sort()),
     JSON.stringify(k.inertStatus()?.may_still));
  ok('and switched_off names the faculty this doctrine turned off',
     (k.inertStatus()?.switched_off ?? []).includes('arm'),
     JSON.stringify(k.inertStatus()?.switched_off));

  const errand = keeper();
  errand.goInert('m59-outfit: buying a weapon');
  ok('goInert is still blind — an errand asked for silence and gets it',
     errand.inert && !errand.inert.travelling && errand.travelling === null);
  ok('and refuses every faculty', TRAVEL_GUARD_KEYS.every(key => errand.travelAllows(key) === false));
  // A journey must not be able to take a character an errand already holds and quietly
  // hand its survival back — the errand is the one that knows why it wanted silence.
  errand.goTravelling('travelling to somewhere else');
  ok('a journey cannot upgrade an errand hold into a travelling one',
     errand.inert.travelling !== true);

  const free = keeper();
  ok('with nothing holding it, every faculty is allowed',
     TRAVEL_GUARD_KEYS.every(key => free.travelAllows(key) === true));
}

// ---------------------------------------------------------------------------
console.log('\nthe damage rate — the instrument that replaces stillness');
{
  const k = keeper({ health: 10, max: 37, pulses: ring({ from: 10, perSample: 0.5 }) });
  const rate = k.damageRate();
  ok('reads about half a point a second off the pulse ring — the rate that killed Cccc',
     rate !== null && Math.abs(rate - 0.5) < 0.15, String(rate));
  // Cccc had 10 health left and was losing about half a point a second, so roughly twenty
  // seconds. He died twenty-two seconds after entering the room.
  ok('and turns it into a time to death — about twenty seconds, which is what he had',
     Math.abs(k.timeToDeath() - 20_000) < 6_000, String(k.timeToDeath()));

  const steady = keeper({ pulses: ring({ from: 30, perSample: 0 }) });
  ok('a character that is not losing health has no rate', steady.damageRate() === 0);
  ok('and no time to death', steady.timeToDeath() === null);
  const healing = keeper({ pulses: ring({ from: 10, perSample: -1 }) });
  ok('and one that is HEALING is never reported as dying', healing.damageRate() === 0);
  ok('too little ring to say is null, not zero',
     keeper({ pulses: ring({ n: 2 }) }).damageRate() === null);

  // THE WHOLE POINT. The ring got wider so a rate could be read from it, and the two
  // movement tests must not have widened with it — `pennedIn` gets STRICTER as the ring
  // grows, so a careless edit here switches off the handbrake it feeds.
  // The ASSERTION is the narrow window, not the spelling of the guard in front of it:
  // the extracted copy reads `(w?.pulses ?? []).slice(-PULSE_MOVEMENT_SAMPLES)`, which is
  // the same read done defensively. Pinning the exact text would have forced the harder
  // form to be un-hardened to satisfy a grep.
  ok('pennedIn still reads only the newest few samples',
     /pulses[\s\S]{0,20}\.slice\(-PULSE_MOVEMENT_SAMPLES\)/.test(AUTOPILOT_SRC));
}

// ---------------------------------------------------------------------------
console.log('\nthe triggers — none of them ask whether the body is moving');
{
  // A JOURNEY IS ONLY ABANDONED FOR A PLAYER — everything else PAUSES to take a wall and
  // carries on afterwards (operator's rule, 2026-08-21). Both outcomes cancel the movement
  // and return CONTINUE, so `took` is still the right question for "did the ladder get the
  // character back"; what changed is that the note says which of the two it was, and
  // whether the objective survived.
  const run = async k => {
    const verdict = await k.passTravelling(ctxFor(k));
    const notes = k.notes;
    const paused = notes.some(n => /^PAUSED THE JOURNEY/.test(n.what ?? ''));
    const abandoned = notes.some(n => /^ABANDONED THE JOURNEY/.test(n.what ?? ''));
    return { verdict, took: verdict === CONTINUE, notes,
             tookBack: paused || abandoned, paused, abandoned,
             kept: k.suspendedJourney != null };
  };

  // ---- CCCC'S EXACT SITUATION, and the one the old rescue could not see. 10 of 37 is
  // 27%, the flee line is 70%, six things in the room — and the pulses are SHUFFLING
  // between 25,5 and 26,5, which is what reset the four-second stillness timer over and
  // over while he was eaten.
  const cccc = keeper({ health: 10, max: 37, adjacent: 6, fleeAt: 0.7,
                        guard: {}, pulses: ring({ from: 10, perSample: 0.5 }) });
  const r = await run(cccc);
  // ============ CORRECTED 2026-08-23: A MONSTER DOES NOT STOP A JOURNEY ============
  //
  // These four assertions used to require that Cccc's exact situation — 27% health, six
  // monsters adjacent, shuffling — TOOK THE CHARACTER BACK. That was the fix for his death
  // and it was aimed at the right thing (the ladder had been switched off) and settled on
  // the wrong remedy (stop the journey).
  //
  // The operator's rule, stated repeatedly and finally taken: DEATH OR A PLAYER ARE THE ONLY
  // TWO REASONS TO STOP TRAVELLING. Everything else keeps walking, and takes its walls as
  // WAYPOINTS on the way past.
  //
  // The evidence for it is a whole evening of journeys that read
  //
  //     legs 2, planned_legs 7      hp 33 -> 29
  //
  // two legs of seven, four health down, cancelled by these very rungs — and then the
  // character stood idle in a 750-danger room and lost thirty health in eight seconds. A
  // character that keeps walking outpaces most of what chases it. Twenty-hitpoint mules
  // cross to Castle Victoria every day, and they do it by never stopping.
  //
  // What Cccc actually needed was not to have his survival ladder switched off — which is
  // what `goInert` did and what `goTravelling` fixed — and a wall he could take without
  // giving up the road, which is what the fuel stop does.
  ok('six monsters and a shuffle do NOT end the crossing', !r.tookBack,
     JSON.stringify({ paused: r.paused, abandoned: r.abandoned }));
  ok('and the journey is still his — nothing was handed back', cccc.inert !== null);
  ok('and the ladder was never switched off, which is what actually killed him',
     cccc.inert?.travelling === true);
  // SIX MONSTERS AND NO PLAYER, SO THE JOURNEY IS NOT GIVEN UP. This is the operator's
  // rule of 2026-08-21 and the reason the note names two different acts: the movement
  // stops so the ladder can put a wall at his back, and the destination is kept so he
  // walks on once he is whole. Abandoning is for a person being on us, and nothing else.
  ok('and it is certainly not ABANDONED — that is for a person, and only a person',
     !r.abandoned, JSON.stringify({ paused: r.paused, abandoned: r.abandoned }));

  // THE SWITCH HAS TO ACTUALLY WORK, or it is decoration. Isolating the flee trigger needs
  // a character below the flee line and NOT inside two hits of death, or `play_dead` fires
  // instead and the pair proves nothing: worstHit is min(30, floor((max+2)/3)), so a
  // 60-health character is doomed at 40 and flees at 42. 41 sits in the one-point gap
  // between them. (Cccc at 10 of 37 was below BOTH, which is why the case above is taken
  // back whichever of the two you switch off — and is the right answer for him.)
  const bracket = { health: 41, max: 60, adjacent: 2, fleeAt: 0.7,
                    pulses: ring({ from: 41, perSample: 0 }) };
  // AND MONSTERS DO NOT REACH THIS RUNG, WHICH IS THE POINT OF IT.
  //
  // I asserted the opposite here and was wrong, and the way it was wrong is worth keeping:
  // rung 4 tests `worthEnding`, and under the default `travel_flee_from: 'players'` that
  // list is STRANGERS ONLY. Two monsters adjacent, below the flee line, is not this rung's
  // business — being bitten on the road is the ordinary condition of travel, and the answer
  // to it is the WALL rung above, which pauses and keeps the objective.
  //
  // That is the operator's rule stated as code: never abandon a journey unless a PLAYER is
  // attacking. A test that expects a monster to end a journey is asking for the behaviour
  // that made trips accumulate the same damage in both directions and never arrive.
  const monstersOnly = keeper({ ...bracket, guard: {} });
  const rMon = await run(monstersOnly);
  ok('below the flee line with MONSTERS on us, the flee rung does not fire — the wall does',
     !monstersOnly.notes.some(n => n.detail?.trigger === 'below the flee line with someone adjacent'),
     JSON.stringify(monstersOnly.notes.map(n => n.detail?.trigger)));
  ok('and the journey is not abandoned for them', !rMon.abandoned);
  // A STRANGER IS A DIFFERENT FACT. A wall stops monsters and says nothing about a person,
  // who can walk to the same square, swing first and take the pack.
  const willFlee = keeper({ ...bracket, adjacent: 0, players: 2, guard: {} });
  ok('below the flee line with a STRANGER adjacent, the flee trigger is the one that fires',
     (await run(willFlee)).took &&
     willFlee.notes.some(n => n.detail?.trigger === 'below the flee line with someone adjacent'),
     JSON.stringify(willFlee.notes.map(n => n.detail?.trigger)));
  const noFlee = keeper({ ...bracket, adjacent: 0, players: 2, guard: { flee: false } });
  const r2 = await run(noFlee);
  ok('and with flee switched off that same character walks on',
     !r2.took && r2.verdict === HANDLED);
  ok('and stays in the travelling state', !!noFlee.travelling);

  // ---- ABOVE THE FLEE LINE, BUT DYING FAST. Nothing adjacent in the room model at all,
  // so this can only fire on the rate.
  //
  // AND IT IS GATED ON A PERSON DOING IT, for the same reason rung 4 is: this rung is the
  // only one in the file that ABANDONS. A bar emptying under monsters is the road doing what
  // the road does — the wall rung answers that and keeps the objective. I asserted this one
  // wrongly too, in the same direction, which is what a rule is for.
  const bleedingMonsters = keeper({ health: 30, max: 37, adjacent: 2, fleeAt: 0.7, guard: {},
                                    pulses: ring({ from: 34, perSample: 4 }) });
  const rBleedMon = await run(bleedingMonsters);
  ok('a bar emptying under MONSTERS never abandons the journey', !rBleedMon.abandoned,
     JSON.stringify(bleedingMonsters.notes.map(n => n.detail?.trigger)));
  const bleeding = keeper({ health: 30, max: 37, adjacent: 0, players: 1, fleeAt: 0.7, guard: {},
                            pulses: ring({ from: 34, perSample: 4 }) });
  const r3 = await run(bleeding);
  ok('a STRANGER emptying the bar fast enough is taken back on the rate alone',
     r3.took && r3.tookBack, JSON.stringify(bleeding.notes.map(n => n.detail?.trigger)));
  ok('and says how long it had left', bleeding.notes.some(n => n.detail?.seconds_left != null));
  ok('and THIS is the one rung that abandons, because a wall does not stop a person',
     r3.abandoned);
  const noFight = keeper({ health: 30, max: 37, adjacent: 0, fleeAt: 0.7,
                           guard: { fight_back: false },
                           pulses: ring({ from: 34, perSample: 4 }) });
  ok('with fight_back off, a fast bleed does not interrupt the journey',
     !(await run(noFight)).took);

  // ---- TWO HITS FROM DEATH. worstHit is min(30, floor((max+2)/3)) = 13 for a 37-health
  // character, so 26 or below with something adjacent is the doomed case.
  const doomed = keeper({ health: 8, max: 37, adjacent: 1, fleeAt: 0.2, guard: {},
                          pulses: ring({ from: 8, perSample: 0 }) });
  const r4 = await run(doomed);
  // CORRECTED 2026-08-23. This required that a character two hits from death be TAKEN BACK,
  // and that rung is gone. Being nearly killed by a monster is neither death nor a player,
  // and the argument that stopping helps only holds if stopping helps — it does not:
  //
  //     act=idle | hp 3/33 | for 8s | walked 5.4 | net 2.8 | shelter_after None
  //
  // thirty health in eight seconds, stationary, in the room this fleet dies in. A character
  // two hits from death that keeps walking outpaces most of what is chasing it; one that
  // stops is surrounded by all of it. The wall it wanted is still taken, as a waypoint the
  // walker splices into the route — shelter that does not cost the crossing.
  ok('two hits from death does NOT end the crossing any more', !r4.tookBack,
     JSON.stringify({ paused: r4.paused, abandoned: r4.abandoned }));
  ok('and no rung claims to have taken it back for that',
     !doomed.notes.some(n => n.detail?.trigger === 'two hits from death'));
  // The doomed rung is gated on `flee` now, not on a `play_dead` key that no longer
  // exists — so switching flee off is what leaves the decision to the journey.
  ok('and flee off leaves that decision to the journey',
     !(await run(keeper({ health: 8, max: 37, adjacent: 1, fleeAt: 0.2,
                          guard: { flee: false, fight_back: false },
                          pulses: ring({ from: 8, perSample: 0 }) }))).took);

  // ---- THE WEAPON IS GONE, AND THE JOURNEY CARRIES ON ANYWAY.
  //
  // This rung used to be ahead of everything else, on the argument that being unarmed is WHY
  // the next room goes badly. True, and it is still not a reason to STOP ON THE ROAD: it is
  // the one faculty of the five a MONSTER can trigger, it fires at FULL HEALTH on a fact
  // about the pack, and it cancels a crossing in rooms measured to take a character from
  // full to dead in about nine seconds. Under the road doctrine the answer to "something is
  // wrong out here" is always the route-adjacent safe spot, which takes the body off the
  // road first; re-arming is something to do parked, and `loadout` does it at the far end.
  //
  // Kept as a switch rather than deleted — `arm: true` restores it per character.
  const bare = keeper({ health: 36, max: 37, adjacent: 0, armed: false, guard: {},
                        pulses: ring({ from: 36, perSample: 0 }) });
  const r5 = await run(bare);
  ok('an unarmed character is NOT taken back — being unarmed is not worth stopping on a road for',
     !r5.took, JSON.stringify(bare.notes.map(n => n.detail?.trigger)));
  ok('and no rung claims to have taken it back for the weapon',
     !bare.notes.some(n => n.detail?.trigger === 'unarmed'),
     JSON.stringify(bare.notes.map(n => n.detail?.trigger)));
  ok('and the journey still holds the character', !!bare.travelling);
  // THE SWITCH STILL WORKS IN BOTH DIRECTIONS, which is what "optional and default off"
  // means and is the half a default change usually forgets to pin.
  ok('with arm switched back ON it is taken back at full health',
     (await run(keeper({ health: 36, max: 37, adjacent: 0, armed: false, guard: { arm: true },
                          pulses: ring({ from: 36, perSample: 0 }) }))).took);

  // ---- NOTHING WRONG. The journey keeps the character, and this must not read as a stall
  // to the supervisor, which restarts keepers that report no progress.
  const fine = keeper({ health: 36, max: 37, adjacent: 0, guard: {},
                        pulses: ring({ from: 36, perSample: 0 }) });
  const r6 = await run(fine);
  ok('a healthy character on a quiet road is left alone', !r6.took && r6.verdict === HANDLED);
  ok('and is not taken back', !r6.tookBack);
  ok('and stays travelling', !!fine.travelling);
}

// ---------------------------------------------------------------------------
console.log('\nthe wiring — the parts a rename would silently break');
{
  // The gate in passUnderworld is what routes a travelling keeper into the restricted
  // ladder rather than into the blind `return HANDLED`. If this comes out, everything
  // above still passes and the fleet is back where it started.
  ok('the pass gate sends a travelling keeper to the restricted ladder',
     /\} else if \(this\.inert\.travelling\) \{/.test(AUTOPILOT_SRC) &&
     /await this\.passTravelling\(ctx\)/.test(AUTOPILOT_SRC));
  ok('and the ordinary stages run on the SAME pass after a take-back',
     /const verdict = await this\.passTravelling\(ctx\);\s*\n\s*if \(verdict !== CONTINUE\) return HANDLED;/
       .test(AUTOPILOT_SRC));
  ok('an errand still gets the blind branch',
     /this\.progress\('inert -- something else is driving'\);/.test(AUTOPILOT_SRC));

  // The broker half. `travelJob` is the one entry into the hop loop, and which stand-down
  // it takes is the whole difference between this suite passing and Cccc dying.
  ok('travelJob stands the keeper down as travelling', /goTravelling\(/.test(BROKER_SRC));
  ok('and travelJob does not reach for goInert',
     !/goTravelling[\s\S]{0,1200}goInert\(/.test(BROKER_SRC.slice(BROKER_SRC.indexOf('  travelJob(dest, {'))));
  // The result is CAPTURED rather than returned straight out, because the `finally` needs to
  // know whether the journey arrived: one that ended short keeps its destination so the resume
  // can pick it up, and one that arrived must not.
  ok('and it goes through the KEEPER travel, which carries the rest and the hop hook',
     /keeper && typeof keeper[.]travel === 'function'[)][\s\S]{0,40}outcome = await keeper[.]travel[(]/
       .test(BROKER_SRC));
  ok('and a journey that ended short keeps its destination for the resume',
     /keeper[.]suspendedJourney = [{]\s*to: Number[(]dest[)]/.test(BROKER_SRC));
  ok('and a stable executor outcome survives into the operator-visible suspension',
     /trigger: outcome[?][.]outcome \?\? 'the travel job ended short/.test(BROKER_SRC));
  ok('while one that ARRIVED does not',
     /const arrived = outcome[?][.]arrived === true/.test(BROKER_SRC)
     && /if [(]!arrived && dest != null/.test(BROKER_SRC));
  ok('travel_guard is settable from the autopilot tool', /travel_guard: \{/.test(BROKER_SRC));
  ok('and an unknown faculty is refused rather than ignored',
     /travel_guard: no such faculty/.test(BROKER_SRC));

  // passTravelling is deliberately NOT in PASS_STAGES — it is reached only from the gate,
  // because a stage would run it on every pass including the ones where nothing holds the
  // character at all.
  ok('passTravelling is not a stage in its own right',
     !PASS_STAGES.includes('passTravelling'));
}

// ---------------------------------------------------------------------------
console.log('\nresting mid-journey stops at BOTH ceilings');
{
  // Cccc left the Limping Toad at 11 of 37 health and 11 of 200 vigor and never rose above
  // either. Vigor is not a nicety here: it sets the RATE health comes back at, so a
  // character that leaves an inn full but exhausted has no recovery left for the road.
  const src = AUTOPILOT_SRC.slice(AUTOPILOT_SRC.indexOf('  async travelRestAtSanctuary('));
  const body = src.slice(0, src.indexOf('\n  async restBeforeSettingOut('));
  ok('the sanctuary rest asks for a health target and a vigor target together',
     /restUntil\(this\.s, \{\s*\n\s*health: wantHealth, vigor: wantVigor,/.test(body));
  ok('and the vigor target is capped at what sitting can actually reach',
     /Math\.min\(this\.policy\.travelStartVigor \?\? REST_VIGOR_CAP, REST_VIGOR_CAP\)/.test(body));
  ok('and full health rather than travel_hold_to, because a sanctuary costs no exposure',
     /const wantHealth = this\.policy\.travelStartHealth \?\? 1;/.test(body));
  ok('it is asked at EVERY hop boundary, not once at the top of the journey',
     /await this\.travelRestAtSanctuary\(at, arm\)/.test(AUTOPILOT_SRC));
  ok('and it restores `doing` afterwards so the pulse keeps watching the road',
     /\} finally \{ this\.doing = wasDoing; \}/.test(body));
  ok('the pre-departure rest and the mid-journey one share one switch',
     /travel_guard\.rest is off for this character/.test(AUTOPILOT_SRC));
}

// ---------------------------------------------------------------------------
console.log('\nthe safe-wall A/B is retired');
{
  const k = keeper({ policy: { travelHold: 'ab' } });
  ok('ab is honoured as "on" rather than rolling a coin', k.travelHoldMode() === 'on');
  ok('half too', keeper({ policy: { travelHold: 'half' } }).travelHoldMode() === 'on');
  ok('and the remap is SAID, not silent',
     k.notes.some(n => /A\/B is retired/.test(n.what)));
  ok('once per keeper, not once per hop',
     (() => { const k2 = keeper({ policy: { travelHold: 'ab' } });
              k2.travelHoldMode(); k2.travelHoldMode(); k2.travelHoldMode();
              return k2.notes.filter(n => /A\/B is retired/.test(n.what)).length === 1; })());
  ok('off is still off — the one setting that stops a hold',
     keeper({ policy: { travelHold: 'off' } }).travelHoldMode() === 'off');
  ok('observe still only writes down what it would have done',
     keeper({ policy: { travelHold: 'observe' } }).travelHoldMode() === 'observe');
  ok('and the fleet default is to hold', /M59_TRAVEL_HOLD \|\| 'on'/.test(AUTOPILOT_SRC));
}


console.log('');
console.log('A TRIP IS REFUGE TO REFUGE — DIVERTS ARE EAGER, CANCELS ARE RARE');
{
  // AND IT IS CONDITIONED THE SAME WAY THE CANCEL IS, which took two corrections to land.
  //
  // It pinned 0.95 — a threshold pretending to be a rule, since nothing makes 96% fine. Then it
  // pinned a flat 1, which cost 33 points of arrival on one run (43% to 10%, same seed) because
  // a detour is free once and ruinous every time anything scratches you across twenty-six hops.
  // The operator's rule has a condition in it and the condition is the load-bearing half: any
  // damage at all **where the map holds things stronger than us**, an ordinary threshold
  // everywhere else. A hundred-hitpoint character nicked by a baby spider walks on.
  ok('the divert has its own threshold, separate from the cancel',
     /travelDivertAt\(\) \{/.test(AUTOPILOT_SRC));
  ok('and it is a pair, like the cancel — outranked, and ordinary',
     /travelDivertBelowOutranked \?\? 1/.test(AUTOPILOT_SRC)
     && /travelDivertBelow \?\? 0\.95/.test(AUTOPILOT_SRC));
  ok('and both arms turn on the same roomOutranksUs the cancel uses',
     /travelDivertAt\(\) \{\s*return this\.roomOutranksUs\(\)/.test(AUTOPILOT_SRC));
  ok('and the cancel is for real trouble only',
     /travelWallBelow \?\? 0\.5\)/.test(AUTOPILOT_SRC));
  // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG: the fuel-stop `need()` must not
  // be reading the cancel's number.
  const need = AUTOPILOT_SRC.slice(AUTOPILOT_SRC.indexOf('need: () => {'),
                                   AUTOPILOT_SRC.indexOf('onDivert:'));
  ok('the fuel stop does NOT ask the cancel what it thinks',
     !/travelShelterBelow/.test(need), 'a divert and a cancel are different decisions');

  // AND THE WALKER STILL SPLICES RATHER THAN STOPS, which is the half of the paradigm that
  // was already right and must stay that way.
  ok('a diverted wall is one more waypoint, not a new plan',
     /ONE MORE WAYPOINT, NOT A NEW PLAN/.test(BROKER_SRC));
  ok('and the route behind it is untouched',
     /remaining\.unshift\(\{ row: stop\.row, col: stop\.col, shelter: true \}\)/.test(BROKER_SRC));
  ok('and the policy is armed for the length of the journey, not per walk',
     /THE FUEL-STOP POLICY, HANDED TO THE MOVER FOR THE LENGTH OF THE JOURNEY/.test(AUTOPILOT_SRC));
}


// ---------------------------------------------------------------------------
// A REFUGE IS SOMEWHERE YOU STOP UNTIL YOU ARE WHOLE — OR WALK PAST IF YOU ARE.
//
// The operator's rule completed: stop at each safe waypoint until health and vigor are
// full, and skip the ones you do not need.
//
// The divert alone only put the wall ON the route. The walker's own comment — "nothing
// stops" — is right about not cancelling the crossing and wrong about not resting, and a
// whole evening of journeys recorded `0r` rest while crossing rooms holding twelve to
// twenty-one perfectly good walls. A refuge you pass at 40% health is a square.
//
// This is NOT a cancellation, and that distinction is the whole design: the mover keeps the
// body, the route behind the waypoint is untouched, and the walk continues the moment the
// rest is done. A pause, not an ending — which is the only kind of stop the operator's
// "death or a player" rule leaves room for.
console.log('');
console.log('A REFUGE IS SOMEWHERE YOU STOP UNTIL YOU ARE WHOLE');
{
  ok('the shelter contract carries an arrival hook, not just a divert one',
     /onArrive: sp\.onArrive \?\? null/.test(BROKER_SRC));
  ok('and the walker awaits it when it lands on a refuge',
     /target\.shelter && typeof shelter\?\.onArrive === 'function'/.test(BROKER_SRC));
  // A PROVED LEG CAN SWALLOW THE WAYPOINT, AND THIS USED TO PIN THE BUG THAT CAUSED.
  //
  // It asserted that any leg whose consumed squares INCLUDED a shelter called `onArrive` —
  // which is true, and was the defect: the handler got the end of the LEG, up to thirteen
  // squares past the wall, and the character rested there in the open. Measured on the shadow
  // fleet 2026-08-27: fifteen shelter stops lost 134 health between them, 92 of it on one
  // square, and every one read as `arrived: true`. The operator's correction — those squares
  // are valid safe spots, and a character that reaches one is safe on it — is what turned the
  // finding round.
  //
  // A test can pin the wrong half of a behaviour and look like coverage. What is wanted is
  // that the refuge is not SKIPPED, not that it is counted from wherever we stopped.
  ok('a proved leg that swallowed the waypoint turns back to it',
     /const swallowed = remaining\.slice\(0, cut \+ 1\)\.filter\(st => st\.shelter\);/.test(BROKER_SRC)
     && /remaining\.unshift\(back\);/.test(BROKER_SRC));
  ok('and rests only once the body is on the square',
     /const onIt = swallowed\.some\(st => st\.col === at\.col && st\.row === at\.row\);/.test(BROKER_SRC));
  ok('and a rest that cannot happen does not strand the crossing',
     /a rest that cannot happen must not strand the crossing/.test(BROKER_SRC));

  // THE SKIP IS THE OTHER HALF OF THE RULE.
  ok('a character that is already whole walks straight past',
     /if \(whole\) \{ settle\(\{[\s\S]{0,140}\); return false; \}/.test(AUTOPILOT_SRC));
  // AND IT STILL SAYS SO ON DISK. A run that reached its wall and did not need it is the good
  // case, and without an outcome row it is indistinguishable from one that never arrived —
  // which is the fault this ledger exists to tell apart. See tools/m59-shelter.mjs.
  ok('and a stop that was not needed is still recorded as having been reached',
     /arrived whole — walked on without resting/.test(AUTOPILOT_SRC));
  ok('and one that is not rests to FULL health and the resting cap',
     /health: 1, vigor: REST_VIGOR_CAP/.test(AUTOPILOT_SRC));
  ok('bounded, so a refuge that cannot heal cannot hold a crossing for ever',
     /refugeRestSeconds \?\? 90/.test(AUTOPILOT_SRC));
  ok('and it says both arriving and leaving, so a long leg can be read afterwards',
     /resting at a refuge on the way/.test(AUTOPILOT_SRC)
     && /leaving the refuge/.test(AUTOPILOT_SRC));
}


// ---------------------------------------------------------------------------
// NOT EVEN THE WATCHDOG STOPS A JOURNEY.
//
// The last thing in the file that broke the operator's rule. The two most recent journeys
// before it was fixed both ended here:
//
//     599 -> 2    FAIL  movement cancelled by the watchdog rescuing a stalled driver
//     587 -> 597  FAIL  movement cancelled by the watchdog rescuing a stalled driver
//
// and the rung's own comment, written after an earlier death, already said what it cost:
// "the rail was cancelled at 12 of 112 by the watchdog rescuing a stalled driver and the
// character then walked ZERO squares in fifteen seconds ... and died". Known to be lethal,
// and kept, because nothing had connected it to the rule.
//
// An ERRAND keeps its rescue: something else is driving, it has stopped moving the body, and
// no destination is thrown away by stepping in.
console.log('');
console.log('NOT EVEN THE WATCHDOG STOPS A JOURNEY');
{
  ok('the wedge rescue asks whether this is a journey first',
     /const travelling = !!this\.inert\?\.travelling;/.test(AUTOPILOT_SRC));
  // UPDATED 2026-09-04, and the rule it guards is unchanged: a wedged journey is not
  // cancelled for being wedged. Two things moved underneath it.
  //
  //   * `this.inert` became `heldByOther`. It asked whether the KEEPER had stood itself
  //     down, which was the only way to drive a character when this was written. A
  //     fleetscript or bot now takes `movement` with a commander claim and leaves survival
  //     here, so the keeper is never inert and the rescue could never fire for the case its
  //     own comment describes — "the character bleeds out in a healthy-looking keeper".
  //
  //   * A wedged journey below the FLEE LINE is now suspended. "The journey stands" is the
  //     answer to being hit; the 2026-08-21 correction says it is not the answer to being
  //     below the flee line, and a wedged journey is that picture with the walking removed.
  //     Two couriers died proving it — 5 -> 1 -> 1 -> 2 health over fifty seconds at
  //     `net_squares: 1`, with `travel_arm: null` so the guard was not armed either.
  //     SUSPENDED, not ended: the destination is kept and resumed.
  ok('and only cancels when it is NOT one',
     /if \(!travelling && heldByOther && wedge\?\.inert/.test(AUTOPILOT_SRC));
  ok('a driver is either an inert keeper OR a claimed mover',
     /const heldByOther = !!this\.inert \|\| this\.facultyHeld\('movement'\);/.test(AUTOPILOT_SRC));
  ok('and a wedged journey below the flee line is SUSPENDED rather than ended',
     /WEDGED AND DYING MID-JOURNEY — the trip is suspended, not ended/.test(AUTOPILOT_SRC) &&
     /suspendedJourney = \{[\s\S]{0,200}wedged below the flee line/.test(AUTOPILOT_SRC));
  ok('a wedged journey says so rather than going quiet',
     /wedged mid-journey, and the journey stands/.test(AUTOPILOT_SRC));
  ok('once, not every pass — this runs on a 500ms clock',
     /saidTravelWedge/.test(AUTOPILOT_SRC));
  // AND THE BLIND-WALK WATCHDOG ALREADY DID THE RIGHT THING, which is worth pinning so
  // nobody "fixes" it into symmetry with the other one.
  ok('the blind-walk watchdog was already skipping travelling characters',
     /if \(blockedFor < WATCHDOG_BLOCKED_MS\) return;[\s\S]{0,400}if \(this\.inert\) return;/.test(AUTOPILOT_SRC));
}

// ---------------------------------------------------------------------------
// THE ROAD DOCTRINE, 2026-08-27: ONE ANSWER TO EVERYTHING THAT IS NOT A PERSON OR DEATH.
//
// Measured off 37 shadow road deaths across two five-inn pilgrimages. All `mode: idle` —
// pure travel — and 36 of 37 in five corridor rooms, none in a town:
//
//     decline from peak health to death   median 119s, 32 of 37 over a minute
//     time spent BELOW the flee line      median  68s, max 243s
//     regenerated 5hp+ mid-decline        23 of 37, several by +20 to +25
//     frames `stalled`                    1,155 of 1,498
//     frames holding a safe spot             29 of 1,498  (1.9%)
//     15 attackers at once                26 of 37
//
// An enormous window, and nothing used it. The answers the ladder had were not answers:
// walking away does not work on a monster (vision 4 + difficulty/2, and they follow), and
// changing objective for an inn is the same move with more road attached — begun at the
// health that made it an emergency, through the rooms that caused it.
//
// So: park on the next safe spot within `travel_shelter_detour` of the planned route, play
// dead ONCE to shed what is chasing, rest to FULL, carry on. These pin the settings that
// express that, IN BOTH DIRECTIONS, because "optional and default off" is a claim about two
// behaviours and a default change usually only pins one.
console.log('');
console.log('THE ROAD DOCTRINE: park, play dead once, rest full, carry on');
{
  // THE ROAD FLOOR, NOT THE FIGHTING ONE. `holdResumeAbove` (0.9) decides when a HUNTING
  // character gets up off a wall to swing again; a road has its own floor and it is 1. Those
  // are two different decisions and I conflated them once already — pinning the wrong one
  // here would make a combat-pacing change look like the travel doctrine.
  ok('a traveller that stops to mend rests FULL, and by its own floor',
     /travelHoldResumeAbove \?\? 1/.test(AUTOPILOT_SRC) && /const onARoad =/.test(AUTOPILOT_SRC),
     'the onARoad branch of the leave-the-wall test');
  ok('and the fighting floor is left alone at nine tenths',
     /holdResumeAbove: 0\.9,/.test(AUTOPILOT_SRC),
     'raising this would change hunting, not travelling');
  ok('a safe spot counts as route-adjacent within five squares of the planned path',
     /travelShelterDetour \?\? 5/.test(AUTOPILOT_SRC));
  ok('and every fallback agrees, so no path quietly uses a different adjacency',
     !/maxDetour \?\? 4/.test(AUTOPILOT_SRC) && !/maxDetour \?\? 4/.test(BROKER_SRC),
     'a second default is a second doctrine');

  // CHANGING OBJECTIVE FOR AN INN IS OFF, AND REFUSES OUT LOUD. A behaviour that is off and
  // silent is indistinguishable from one that is broken, which is why the refusal is a
  // `note` naming the switch that brings it back.
  const stranded = keeper({ health: 8, max: 37 });
  stranded.s.world.room.num = 598;               // The Cragged Mountains — a road, not a town
  const refused = await stranded.retreatToSafety({ because: 'test' });
  ok('a character in trouble on a road does NOT change objective for an inn',
     refused?.arrived === false && refused?.refused === 'retreat_to_inn is off',
     JSON.stringify(refused));
  ok('and says so, naming the switch that would bring it back',
     stranded.notes.some(n => n.what === 'not changing objective for an inn' &&
                              n.detail?.enable_with === 'retreat_to_inn: true'),
     JSON.stringify(stranded.notes.map(n => n.what)));

  // AND THE SWITCH WORKS. Without this, the assertion above is satisfied by a function that
  // always refuses — which is deletion wearing a policy flag.
  const allowed = keeper({ health: 8, max: 37, policy: { retreatToInn: true } });
  allowed.s.world.room.num = 598;
  const tried = await allowed.retreatToSafety({ because: 'test' }).catch(e => ({ threw: e.message }));
  ok('with retreat_to_inn ON it gets past the refusal and tries',
     tried?.refused !== 'retreat_to_inn is off', JSON.stringify(tried));

  // THE ONE THING THAT OUTRANKS THE DOCTRINE. Standing on a wall that has held IS safety,
  // and that guard is older than this change — it must not have been swallowed by the new
  // gate, which sits BELOW it on purpose.
  const onAWall = keeper({ health: 8, max: 37 });
  onAWall.s.world.room.num = 598;
  onAWall.hold = { col: 20, row: 45 };
  onAWall.holdWorks = () => true;
  const stays = await onAWall.retreatToSafety({ because: 'test' });
  ok('a character already on a wall that has held stays on it, doctrine or no doctrine',
     stays?.arrived === true && stays?.held_spot === true, JSON.stringify(stays));
}

// ---------------------------------------------------------------------------
// AN EXHAUSTED TRAVELLER IS A STRANDED ONE — the vigor floor, 2026-08-27.
//
// Mmmm is the case, and it is the clearest single failure in the five-inn run. It crossed
// ELEVEN ROOMS IN FOUR MINUTES, every leg `ok`, 6 to 43 seconds each:
//
//     202 -> 200 -> 535 -> 545 -> 554 -> 564 -> 150 -> 575 -> 576 -> 587 -> 598 -> 599
//
// then entered Ukgoth and spent FORTY-THREE MINUTES failing to leave it:
//
//     10:01  599 -> 2   FAIL   353s   every square for that exit refused (4 tried)
//     10:20  599 -> 2   FAIL  1512s   every square for that exit refused (4 tried)
//     10:36  599 -> 598 FAIL  1061s   every square for that exit refused (3 tried)
//
// It was at vigor ONE. `RUN_VIGOR_FLOOR` is 12, so it could not run: five squares a second
// became two and a half, the 86-126 step climb out of that valley exhausted `leaveViaAny`'s
// candidate budget every time, and the failure was reported against the DOORWAY. An energy
// problem wearing a geometry verdict — the same crossing runs in 24-27s, six times of six.
//
// THE HALF THAT IS EASY TO LEAVE OUT is getting up again. `REST_VIGOR_WORTH_WAITING` already
// said "do not wait for vigor from the bottom", so a floor that only decides when to STOP
// would have produced a character that stops for nothing and walks away exactly as tired as
// it arrived. Both halves are pinned here.
console.log('');
console.log('THE VIGOR FLOOR: never arrive at a hard crossing unable to run');
{
  const onRoad = (vigor) => {
    const k = keeper({ vigor, guard: {} });
    return k;
  };
  ok('a traveller below the floor is too tired to be on a road',
     onRoad(1).tooTiredToTravel() === true);
  ok('and one above it is not', onRoad(80).tooTiredToTravel() === false);
  ok('the floor is well above the server rule of 12 — it is about ARRIVING able to run',
     /M59_TRAVEL_VIGOR_FLOOR \?\? 40/.test(AUTOPILOT_SRC));
  // A CHARACTER NOT ON A ROAD IS NOT IN TROUBLE. Vigor 3 in a town is between errands, and
  // `restBelow` governs that; firing here would make every idle character stop for a wall.
  const inTown = keeper({ vigor: 1 });
  ok('a character with no journey is never "too tired to travel"',
     inTown.tooTiredToTravel() === false);
  // AND IT IS SETTABLE, because 40 is this fleet's number rather than this game's.
  ok('the floor is a policy, not a constant nobody can reach',
     onRoad(1).policy && keeper({ vigor: 30, guard: {}, policy: { travelVigorFloor: 10 } })
       .tooTiredToTravel() === false);
  ok('and it is exposed on the autopilot tool', /travel_vigor_floor: \{ type: 'number'/.test(BROKER_SRC));
  ok('and applied when set', /p\.policy\.travelVigorFloor = Number\(a\.travel_vigor_floor\)/.test(BROKER_SRC));

  // GETTING UP IS THE OTHER HALF. Both travel rests must fill to the cap when the stop was
  // FOR vigor, overriding the "do not wait from the bottom" rule that stranded Mmmm.
  ok('the mid-journey wall fills vigor to the cap when the stop was for exhaustion',
     /vigor: this\.tooTiredToTravel\(\) \? REST_VIGOR_CAP/.test(AUTOPILOT_SRC));
  ok('and so does the sanctuary rest',
     /const wantVigor = this\.tooTiredToTravel\(\) \|\| \(vig \?\? 0\) >= REST_VIGOR_WORTH_WAITING/
       .test(AUTOPILOT_SRC));
  ok('and the refuge mend already asked for the cap unconditionally',
     /health: 1, vigor: REST_VIGOR_CAP/.test(AUTOPILOT_SRC));
  // ONE QUESTION IN THREE PLACES. A floor that decides when to stop but not when to get up is
  // a character that stops for nothing — which is what the two halves did before this.
  ok('all three sites ask the same predicate rather than re-deriving it',
     (AUTOPILOT_SRC.match(/tooTiredToTravel\(/g) ?? []).length >= 4,
     'definition plus the shelter trigger and both rests');
}

// ---------------------------------------------------------------------------
// THE LAST HOLE IN THE ROAD DOCTRINE, 2026-08-27.
//
// `travel_guard` was narrowed to a person and dying. `retreat_to_inn` was switched off. The
// flee rung was removed long before either. And a walk through a dangerous room was STILL
// cancelled after two or three steps — from a completely different code path, on a threshold
// none of those settings can see:
//
//     cancelled_by: "the watchdog pulling us out of a blind walk below the flee line"
//
// Measured in the row-29 corridor of the Western border of the Twisted Wood with eight bodies
// parked along it: FOUR separate live crossings cut off after two or three steps, every one by
// that line. Held off, the same walk ran nineteen. It is also what made every live movement
// measurement in a dangerous room meaningless — the thing being measured was the watchdog.
//
// The operator's rule, verbatim: "My bots either complete their travel orders, get interrupted
// by PVP, or die."
//
// A doctrine with an exception nobody configured is not a doctrine, so this pins the switch in
// both directions AND pins that the OTHER half of the watchdog survives — the pinned-wedge
// rung fires at FULL health on a character that has covered no ground for minutes, which is a
// stuck bot rather than a hurt one, and nothing else in the file interrupts it.
console.log('');
console.log('THE BLIND-WALK WATCHDOG IS OFF, AND ONLY THAT HALF');
{
  ok('the hurt half is gated behind a policy that defaults off',
     /if \(this\.policy\.blindWalkWatchdog !== true\) \{/.test(AUTOPILOT_SRC));
  ok('and it says the walk stands rather than going silent',
     /travelling — hurt, and the walk stands/.test(AUTOPILOT_SRC));
  // THE GATE MUST SIT ABOVE THE CANCEL, not below it. A guard placed after the call is a
  // guard that does nothing — which is exactly the mistake made earlier the same day in
  // `aimInto`, where a body check below an early return threaded nothing.
  const gate = AUTOPILOT_SRC.indexOf('if (this.policy.blindWalkWatchdog !== true)');
  const cancel = AUTOPILOT_SRC.indexOf('the watchdog pulling us out of a blind walk below the flee line');
  ok('and the gate is ABOVE the cancel it guards', gate > 0 && cancel > gate,
     `gate at ${gate}, cancel at ${cancel}`);

  // THE OTHER HALF STAYS. It is the one that unsticks a healthy character going nowhere, and
  // it is gated on `frac >= fleeAt` — full health — so it cannot fire on a hurt traveller.
  ok('the pinned-wedge half is untouched and still fires at full health',
     /WATCHDOG — broke a wedge that was not hurting anybody/.test(AUTOPILOT_SRC));
  // Reached only at or above the flee line, and its first gate is the LADDER clock, not the
  // cancel clock. The arm asks two questions now: WEDGE_LADDER_MS decides whether to RECORD
  // the wedge -- which is the only thing an escape ladder is reached from -- and
  // WATCHDOG_HEALTHY_CANCEL_MS decides whether to also cancel. They were one `if`, and
  // fusing them meant that turning cancels off turned the ladder off with them.
  {
    const arm = AUTOPILOT_SRC.indexOf('if (frac >= fleeAt) {');
    const gate = AUTOPILOT_SRC.indexOf('if (pinnedFor < WEDGE_LADDER_MS) return;', arm);
    const cancel = AUTOPILOT_SRC.indexOf(
      'const cancelling = pinnedFor >= WATCHDOG_HEALTHY_CANCEL_MS;', arm);
    ok('and it is still reached only when health is AT OR ABOVE the flee line',
       arm > 0 && gate > arm && cancel > gate, `arm ${arm}, gate ${gate}, cancel ${cancel}`);
  }

  // KEPT, NOT DELETED — the repository's standing rule for a behaviour being retired.
  ok('the cancel itself is still in the file, switchable back on',
     /the watchdog pulling us out of a blind walk below the flee line/.test(AUTOPILOT_SRC));
  ok('and the switch is offered on the autopilot tool',
     /blind_walk_watchdog: \{ type: 'boolean'/.test(BROKER_SRC));
  ok('and applied when set',
     /p\.policy\.blindWalkWatchdog = a\.blind_walk_watchdog === true/.test(BROKER_SRC));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
