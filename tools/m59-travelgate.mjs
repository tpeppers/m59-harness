// MAY THIS BODY START A JOURNEY? ONE ANSWER, FOR EVERY DRIVER.
//
// Pure. No I/O, no session, no clock. Import it from the broker, from fleetScript, from a bot,
// from a page — the point is that there is exactly one implementation of this decision and it
// cannot drift between them.
//
// THE OPERATOR NAMED THE PROBLEM: "it's important that the way an LLM responds to 'send Statler
// to Marion' needs to be fundamentally the same as the way the localhost:3000 'Meridian field
// command' sends units to Marion". Today it is not. The health floor on a journey is a
// FLEETSCRIPT guarantee, so a script refuses to set out hurt — and every other caller of the
// `travel` tool has no floor at all.
//
// WHAT THAT COSTS, TWICE, EIGHTEEN DAYS APART AND IN THE SAME SHAPE:
//
//   Cccc, 2026-08-21. m59-autopilot.mjs's own note: "A commute driver re-sent `travel` to a
//   character that was in the Underworld at 2 of 37 health." The keeper walked it out to an inn
//   at 11 of 37; the journey, already running, walked it straight back out into West Merchant
//   Way and six things ate it over twenty-two seconds. Its flee threshold was 70% and it never
//   went above 27%.
//
//   Floyd, 2026-09-10. `doing: travelling`, room 597, TRAIL 1/57 -> 1/57 -> 1/57 -> 2/57
//   against a flee threshold of 0.667. Something started or continued a journey with a body
//   that had nothing left.
//
// The fix taken after Cccc was `goTravelling` — keep the survival ladder armed DURING the
// journey instead of going inert. That was right and it is not this. It made the walk
// survivable; it never asked whether the walk should have begun. Eighteen days later the same
// driver shape killed Floyd, and the ladder was armed the whole way.
//
// WHY THE FLOOR IS THE FLEE LINE, AND NOT A NEW NUMBER.
//
// `travel_start_health` already exists as a per-character policy and the autopilot honours it in
// three places — but it is UNSET across this entire fleet (`travelStartHealth: null`, measured
// on a live keeper), and its code default is `?? 1`, full health. Using that as the gate's
// default would refuse nearly every journey a bot makes at 80% and re-architect fleet movement
// to fix a bug about bodies at 2%.
//
// So the default floor is the character's OWN FLEE THRESHOLD, which is set fleet-wide (0.5 here)
// and means something already: it is the fraction at which this character stops fighting and
// gets out. The argument is the one travel-guard rung 4 makes in the other direction — "the
// keeper flees at this fraction when it is driving, and a journey is not a reason to stand and
// take it". If a body would flee a fight at 50%, it has no business SETTING OUT at 2%. No new
// policy, no new number, and it catches both deaths above (Floyd 1.7%, Cccc 27%).
//
// A DECISION, NOT A REMEDY. This says whether the journey may start and why not. What to do
// about a refusal is the caller's, and the two callers rightly differ: fleetScript RESTS to the
// floor and then sets out (a script is patient and owns the body), while the broker's `travel`
// REFUSES and says so (a bot asking for something impossible needs an answer, not a body held
// hostage while it heals). Same decision, different remedies — which is only safe because the
// decision is in one place.

/** The Underworld. A dead body starts here at whatever health it has and must be able to leave. */
export const UNDERWORLD = 1;

export const REASONS = Object.freeze({
  WAIVED: 'waived',
  UNDERWORLD: 'leaving_the_underworld',
  FLOOR_OFF: 'floor_off',
  RECOVERING: 'destination_is_home',
  WHOLE_ENOUGH: 'whole_enough',
  TOO_HURT: 'too_hurt',
  UNREADABLE: 'health_unreadable',
  NO_WAIVER_REASON: 'waiver_without_a_reason',
});

/**
 * @param {object} q
 * @param {number|null} q.health   health as a FRACTION of max, 0..1, or null when unreadable.
 * @param {number|null} q.floor    the fraction required to set out. <= 0 or null turns it off.
 * @param {number|null} q.from     the room the body is standing in.
 * @param {number|null} q.to       the room it is being sent to.
 * @param {number|null} q.homeRoom this character's own home/recovery room, when known.
 * @param {{reason?: string}|null} q.waiver  a deliberate override. A REASON IS MANDATORY.
 * @returns {{ok: boolean, code: string, why: string, floor: number|null, health: number|null}}
 */
export function mayStartJourney({ health = null, floor = null, from = null, to = null,
                                  homeRoom = null, waiver = null,
                                  floorFrom = null } = {}) {
  const pct = (x) => (x == null ? 'unreadable' : Math.round(x * 100) + '%');
  const out = (ok, code, why) => ({ ok, code, why, floor, health });

  // 1. AN EXPLICIT WAIVER WINS, AND IT MUST SAY WHY.
  //
  // Shaped like fleetScript's `unsafe: { reason, waives }` because that is the operator's own
  // escape hatch and the argument for it is the same: people who did not write this rule have
  // to be able to drive the fleet, and some errands genuinely need the thing it forbids — a
  // corpse run, a rescue, a deliberate test. A reason is mandatory so that "I know" and "I
  // forgot" cannot look identical on the page.
  if (waiver) {
    const reason = typeof waiver === 'object' ? waiver.reason : null;
    if (!reason || !String(reason).trim())
      return out(false, REASONS.NO_WAIVER_REASON,
                 'a health waiver was passed with no reason. Say why this body may set out ' +
                 'hurt — "I know about the floor" and "I forgot" have to look different');
    return out(true, REASONS.WAIVED, `waived on purpose: ${String(reason).trim()}`);
  }

  // 2. THE UNDERWORLD IS ALWAYS LEAVABLE. Recovery is a protected faculty and a dead character
  // left there stays for ever; the Underworld has no graph exits and walking onto a portal is
  // the only way out. Refusing this would be the gate causing the thing it exists to prevent.
  if (from != null && Number(from) === UNDERWORLD)
    return out(true, REASONS.UNDERWORLD,
               'leaving the Underworld, which is never refused — a body left there stays there');

  // 3. THE FLOOR CAN BE SWITCHED OFF, and 0 is how. Unset is not off: an absent floor falls
  // back to the caller's own default, which is why this takes a number rather than a policy.
  if (!(Number(floor) > 0))
    return out(true, REASONS.FLOOR_OFF, 'no health floor is in force for this journey');

  // 4. UNKNOWN IS NOT PERMISSION. fleetScript already had this rule and it earned it: a health
  // that cannot be read usually means the keeper is not answering at all, which is exactly when
  // a journey must not start. It caught a character whose keeper process had died.
  if (health == null)
    return out(false, REASONS.UNREADABLE,
               'health is unreadable, so this is not a body we know is fit to travel. That ' +
               'usually means the keeper is not answering, which is when a journey must not start');

  if (health >= floor)
    return out(true, REASONS.WHOLE_ENOUGH, `at ${pct(health)} against a floor of ${pct(floor)}`);

  // 5. GOING HOME IS THE CURE, NOT THE DISEASE. A hurt body walking to the room it recovers in
  // is the one journey being hurt is a REASON for, and refusing it stalls the character exactly
  // where it is worst off. Same trap as "a trip that cannot fix the thing that opened it will
  // run for ever", inverted: a gate that forbids the trip that would fix it.
  if (homeRoom != null && to != null && Number(to) === Number(homeRoom))
    return out(true, REASONS.RECOVERING,
               `at ${pct(health)}, below the ${pct(floor)} floor, but travelling to its own ` +
               `home room ${homeRoom} — which is where it gets better`);

  // The flee-line argument is only made when the floor came FROM the flee line. `floorFrom` is
  // optional so a caller that does not know can simply not claim.
  const because = floorFrom === 'the flee line'
    ? `A body that would flee a fight at ${pct(floor)} has no business starting a journey at ` +
      `${pct(health)}. `
    : (floorFrom ? `That floor came from ${floorFrom}. ` : '');
  return out(false, REASONS.TOO_HURT,
             `at ${pct(health)}, below the ${pct(floor)} floor this character sets out at. ` +
             because +
             'Rest first, send it home, or pass a waiver with a reason');
}

/**
 * The floor to use, most explicit first — so a caller that has decided keeps its decision.
 *
 * `travel_start_health` is the operator-facing key and takes precedence when it is SET; it is
 * unset across this fleet, which is why the flee line is the working default rather than the
 * `?? 1` the autopilot uses for its own resume checks. `fallback` is the last resort for a
 * character whose policy could not be read at all.
 */
// Set by `floorFor` and read by `floorSource()`. Module-level rather than returned alongside
// the number because every existing caller destructures a bare number, and a shape change
// there would be a silent one -- `const floor = floorFor(...)` would become an object and
// every comparison against it would quietly read NaN.
let lastSource = 'nothing';

export function floorFor({ explicit = null, travelStartHealth = null, fleeBelow = null,
                           fallback = 0.35 } = {}) {
  // AN EXPLICIT ZERO IS A DELIBERATE "OFF" AND MUST NOT FALL THROUGH.
  //
  // The first version was a single `if (Number(c) > 0) return c` chain over all four, so a
  // caller passing 0 -- which the travel tool's own schema advertises as the way to switch the
  // floor off, and which `travel_start_health` documents the same way -- skipped the 0 and took
  // the flee line instead. The switch was advertised and did nothing, which is the exact class
  // of no-op this repository keeps paying for.
  //
  // So the two OPERATOR-SET keys are read first and their 0 is honoured; only when both are
  // absent does the flee line, and then the fallback, apply.
  for (const [c, src] of [[explicit, 'the caller'], [travelStartHealth, 'travel_start_health']]) {
    if (c == null) continue;
    const n = Number(c);
    if (Number.isFinite(n)) { lastSource = src; return n > 0 ? n : 0; }
  }
  // `fleeBelow` of 0 means "never flee", which is not a statement about travelling, so it
  // falls through to the fallback rather than switching the floor off.
  for (const [c, src] of [[fleeBelow, 'the flee line'], [fallback, 'the fallback']])
    if (Number(c) > 0) { lastSource = src; return Number(c); }
  lastSource = 'nothing';
  return 0;
}

// WHERE THE LAST FLOOR CAME FROM, so a refusal can say it instead of assuming.
//
// The refusal used to end "a body that would flee a fight at N% has no business starting a
// journey at M%" unconditionally -- which is a true and useful sentence when the floor IS the
// flee line, and a false one the moment a caller passes `health_floor` explicitly. Measured on
// the first live call after deploy-2026-09-10-15: `health_floor: 1` produced "a body that would
// flee a fight at 100%", which describes no character in this game. A refusal that misstates
// where its own number came from is the class of thing that gets deleted by the next person in
// a hurry, so the sentence is now conditional on the source.
export const floorSource = () => lastSource;
