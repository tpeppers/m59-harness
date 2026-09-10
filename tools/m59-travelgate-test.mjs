#!/usr/bin/env node
// ONE HEALTH FLOOR, FOR EVERY DRIVER — offline, no socket, no roster, no broker.
//
//   node tools/m59-travelgate-test.mjs
//
// WHAT THIS PINS. The health floor on a journey was a FLEETSCRIPT guarantee and nothing else,
// so a script refused to set out hurt while every other caller of the `travel` tool had no
// floor at all. The operator named it: "the way an LLM responds to 'send Statler to Marion'
// needs to be fundamentally the same as the way the localhost:3000 'Meridian field command'
// sends units to Marion".
//
// It cost two characters eighteen days apart in the same shape:
//
//   Cccc, 2026-08-21 — m59-autopilot.mjs's own note: "A commute driver re-sent `travel` to a
//   character that was in the Underworld at 2 of 37 health." Flee threshold 70%, never above
//   27%, eaten in twenty-two seconds.
//   Floyd, 2026-09-10 — `doing: travelling`, trail 1/57 -> 1/57 -> 1/57 -> 2/57, flee 0.667.
//
// The fix after Cccc was `goTravelling`: keep the ladder armed DURING the journey. That was
// right and it is not this. It made the walk survivable and never asked whether the walk should
// have begun — and eighteen days later the same driver shape killed Floyd with the ladder armed
// the whole way.
//
// THE LAST SECTION IS THE ONE THAT MATTERS. A shared decision that both callers copy is not a
// shared decision; it is two decisions that agree today. So the final block asserts that the
// broker and fleetScript both IMPORT this module and that neither carries its own comparison.
import { mayStartJourney, floorFor, floorSource, UNDERWORLD, REASONS }
  from './m59-travelgate.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

console.log('');
console.log('THE TWO DEATHS THIS IS WRITTEN FROM');
{
  // Floyd: 1 of 57 is 1.7%, against the 66.7% he would have fled a fight at.
  const floyd = mayStartJourney({ health: 1 / 57, floor: 0.667, from: 597, to: 54 });
  ok('Floyd at 1 of 57 is refused', floyd.ok === false && floyd.code === REASONS.TOO_HURT);
  ok('and the refusal carries both numbers, so it can be argued with',
     // 1 of 57 is 1.75%, which ROUNDS TO 2 -- my first version of this assertion looked for
     // '1%' and failed on arithmetic rather than on behaviour.
     /2%/.test(floyd.why) && /67%/.test(floyd.why), floyd.why);
  // Cccc, at the moment the commute driver re-sent travel — but NOT from the Underworld, which
  // is the exemption tested below. This is the same body once it is out.
  const cccc = mayStartJourney({ health: 0.27, floor: 0.70, from: 380, to: 381 });
  ok('Cccc at 27% against a 70% flee line is refused',
     cccc.ok === false && cccc.code === REASONS.TOO_HURT);
}

console.log('');
console.log('A REFUSAL SAYS WHERE ITS NUMBER CAME FROM, rather than asserting the flee line');
{
  // MEASURED ON THE FIRST LIVE CALL after deploy-2026-09-10-15. Janice at 39/58 was refused a
  // journey with an explicit `health_floor: 1`, and the message read "A body that would flee a
  // fight at 100% has no business starting a journey at 67%" -- which describes no character in
  // this game. The sentence is true and useful when the floor IS the flee line and false the
  // moment a caller passes one, and a refusal that misstates where its own number came from is
  // what gets a guarantee deleted by the next person in a hurry.
  const flee = mayStartJourney({ health: 0.2, floor: 0.5, floorFrom: 'the flee line' });
  ok('when the floor IS the flee line, the argument is made',
     /would flee a fight at 50%/.test(flee.why), flee.why);
  const caller = mayStartJourney({ health: 0.67, floor: 1, floorFrom: 'the caller' });
  ok('when the caller chose it, the flee-line claim is NOT made',
     !/would flee a fight/.test(caller.why), caller.why);
  ok('and it names the source instead', /came from the caller/.test(caller.why), caller.why);
  ok('an unknown source claims nothing either way',
     !/would flee a fight/.test(mayStartJourney({ health: 0.2, floor: 0.5 }).why));
  // The source is reported by floorFor rather than guessed, and read after it.
  floorFor({ explicit: 0.9, fleeBelow: 0.5 });
  ok('floorSource says the caller when an explicit floor won', floorSource() === 'the caller');
  floorFor({ fleeBelow: 0.5 });
  ok('and the flee line when that is what applied', floorSource() === 'the flee line');
  floorFor({ travelStartHealth: 0.8, fleeBelow: 0.5 });
  ok('and travel_start_health when it is set', floorSource() === 'travel_start_health');
}
console.log('');
console.log('AND THE THINGS THAT MUST NOT BE REFUSED, or the gate causes what it prevents');
{
  // THE UNDERWORLD HAS NO GRAPH EXITS. A dead character left there stays for ever, and walking
  // onto a portal is the only way out. Recovery is a protected faculty; refusing this would be
  // the gate manufacturing the stranding it exists to stop.
  const dead = mayStartJourney({ health: 2 / 37, floor: 0.70, from: UNDERWORLD, to: 54 });
  ok('leaving the Underworld at 2 of 37 is always allowed',
     dead.ok === true && dead.code === REASONS.UNDERWORLD);
  ok('and UNDERWORLD is room 1, named rather than spelled at the call site', UNDERWORLD === 1);

  // GOING HOME IS THE CURE, NOT THE DISEASE. Refusing a hurt body the journey to the room it
  // recovers in strands it exactly where it is worst off — the "a trip that cannot fix the
  // thing that opened it" trap, inverted into a gate that forbids the trip that would fix it.
  const home = mayStartJourney({ health: 0.10, floor: 0.5, from: 597, to: 39, homeRoom: 39 });
  ok('a hurt body may always walk to its own home room',
     home.ok === true && home.code === REASONS.RECOVERING);
  ok('but not to somewhere else that is not home',
     mayStartJourney({ health: 0.10, floor: 0.5, from: 597, to: 40, homeRoom: 39 }).ok === false);

  ok('ordinary movement at 80% against a 50% floor is untouched',
     mayStartJourney({ health: 0.8, floor: 0.5, from: 544, to: 39 }).ok === true);
  ok('and exactly AT the floor is allowed, not refused',
     mayStartJourney({ health: 0.5, floor: 0.5 }).ok === true);
  ok('a floor of 0 is off, which is how a caller switches it off deliberately',
     mayStartJourney({ health: 0.02, floor: 0 }).code === REASONS.FLOOR_OFF);
}

console.log('');
console.log('THE WAIVER IS SHAPED LIKE fleetScript\'s, AND A REASON IS MANDATORY');
{
  // fleetScript's rule, and the argument is the same: people who did not write this have to be
  // able to drive the fleet, and a rescue or a corpse run genuinely needs to set out hurt.
  const waived = mayStartJourney({ health: 0.02, floor: 0.5, waiver: { reason: 'corpse run' } });
  ok('a waiver with a reason goes anyway', waived.ok === true && waived.code === REASONS.WAIVED);
  ok('and the reason is echoed, so it lands on the record', /corpse run/.test(waived.why));
  // "I know about the floor" and "I forgot" must not look the same on the page.
  const bare = mayStartJourney({ health: 0.9, floor: 0.5, waiver: {} });
  ok('a waiver with NO reason is refused, even on a whole body',
     bare.ok === false && bare.code === REASONS.NO_WAIVER_REASON);
  ok('and a blank reason counts as no reason',
     mayStartJourney({ health: 0.9, floor: 0.5, waiver: { reason: '   ' } }).ok === false);
}

console.log('');
console.log('UNKNOWN IS NOT PERMISSION — the rule fleetScript earned');
{
  // A health that cannot be read usually means the keeper is not answering at all, which is
  // exactly when a journey must not start. It caught a character whose keeper process had died.
  const blind = mayStartJourney({ health: null, floor: 0.5, from: 597, to: 54 });
  ok('unreadable health is a refusal', blind.ok === false && blind.code === REASONS.UNREADABLE);
  ok('and it says the keeper is the likely reason', /keeper/.test(blind.why));
  // But not when the floor is off, and not out of the Underworld — an unreadable body still has
  // to be able to leave a room with no exits.
  ok('unless the floor is off', mayStartJourney({ health: null, floor: 0 }).ok === true);
  ok('or it is leaving the Underworld',
     mayStartJourney({ health: null, floor: 0.5, from: UNDERWORLD, to: 54 }).ok === true);
}

console.log('');
console.log('THE FLOOR IS THE FLEE LINE, because that number already means something');
{
  // `travel_start_health` is the operator-facing key and wins when SET. It is unset across this
  // whole fleet (measured on a live keeper: `travelStartHealth: null`) and its code default is
  // `?? 1` — full health — which as a gate default would refuse nearly every journey a bot makes
  // at 80% to fix a bug about bodies at 2%.
  ok('an explicit floor from the caller wins', floorFor({ explicit: 0.9, travelStartHealth: 0.8, fleeBelow: 0.5 }) === 0.9);
  ok('then the character\'s own travel_start_health', floorFor({ travelStartHealth: 0.8, fleeBelow: 0.5 }) === 0.8);
  // The working default, and the argument is travel-guard rung 4's in the other direction: if a
  // body would flee a fight at 50%, it has no business SETTING OUT at 2%.
  ok('then its flee threshold, which is set fleet-wide', floorFor({ fleeBelow: 0.5 }) === 0.5);
  ok('and a last-resort fallback when no policy could be read', floorFor({}) === 0.35);
  ok('an explicit 0 is honoured as OFF rather than falling through to the flee line',
     floorFor({ explicit: 0, fleeBelow: 0.5 }) === 0);
}

console.log('');
console.log('ONE DECISION, TWO CALLERS — and neither keeps a copy');
{
  const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const FS = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');

  ok('the broker imports it', /from '\.\/m59-travelgate\.mjs'/.test(BROKER));
  ok('fleetScript imports it', /from '\.\/m59-travelgate\.mjs'/.test(FS));
  ok('the broker asks it at the door every driver uses',
     /async _journeyGate\(/.test(BROKER) && /await this\._journeyGate\(/.test(BROKER));
  // THE SIGNATURE HAD TO STAY SYNCHRONOUS. One caller fires and forgets
  // (`try { s.travelJob(...) } catch {}` in the spread driver), so the gate runs inside the
  // returned promise and RESOLVES with a refusal rather than rejecting — a rejection there
  // would become an unhandled crash.
  ok('and travelJob still returns { promise } rather than becoming async',
     /travelJob\(dest, opts = \{\}\) \{/.test(BROKER) &&
     /return \{ promise: started, keeper: true \}/.test(BROKER));
  ok('a refused journey comes back as started:false, which the tool already tests for',
     /started: false, refused: gate\.code/.test(BROKER));

  // THE REMEDIES DIFFER ON PURPOSE, and that is only safe because the decision does not.
  // fleetScript rests to the floor and goes; the broker refuses and says so.
  ok('fleetScript still rests to the floor rather than refusing the errand',
     /healToFloor\(ctx, agent, minHealth, ctx\.healMs\)/.test(FS));
  ok('and it carries its own floor through, so the broker agrees rather than second-guessing',
     /health_floor: minHealth/.test(FS));
  // The tool has to expose both halves or the gate is a wall, and the first errand it blocked
  // would get it deleted by the next person in a hurry.
  ok('the travel tool advertises a named floor', /health_floor: \{ type: 'number'/.test(BROKER));
  ok('and a waiver', /despite_health: \{ type: 'object'/.test(BROKER));

  // NO SECOND IMPLEMENTATION. fleetScript's inline `at.health < minHealth` comparison is what
  // this replaced; if it comes back, the two will agree until the day they do not.
  ok('fleetScript no longer compares health to the floor itself',
     !/at\.health < minHealth/.test(FS));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
