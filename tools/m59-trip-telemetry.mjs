// Small, process-neutral helpers for the journey result that crosses from the keeper's
// Autopilot back to Session.travelJob. Keep this module free of broker/session imports so
// the contract can be exercised offline without opening a socket or taking a fleet lock.

const wholeAtLeastZero = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};

// Autopilot owns these counters only while one call to travel() is in flight, then clears
// them in finally. Put a value snapshot on the outcome before that clear; returning a live
// reference to keeper state would make every completed journey read zero.
export function travelJourneyMetrics({ shelterStops = 0, heldMs = 0,
                                       hopWallStops = 0, sanctuaryStops = 0,
                                       routeStops = 0, trackStops = 0 } = {}) {
  return Object.freeze({
    shelter_stops: wholeAtLeastZero(shelterStops),
    held_ms: wholeAtLeastZero(heldMs),
    hop_wall_stops: wholeAtLeastZero(hopWallStops),
    sanctuary_stops: wholeAtLeastZero(sanctuaryStops),
    route_stops: wholeAtLeastZero(routeStops),
    track_stops: wholeAtLeastZero(trackStops),
  });
}

export function withTravelJourneyMetrics(outcome, counters = {}) {
  if (!outcome || typeof outcome !== 'object') return outcome;
  return { ...outcome, journey: travelJourneyMetrics(counters) };
}

// The keeper's travel hook counts wall holds and sanctuary pauses as shelter stops. Its
// ordinary tally counts a different, older kind of rest. Say which evidence we have rather
// than calling every pause a rest at a safe wall (a sanctuary is not one).
export function tripStopPhrase(outcome, keeperRestStops = 0) {
  const shelterValue = outcome?.journey?.shelter_stops;
  const hasShelterMetric = Number.isFinite(Number(shelterValue));
  const shelters = hasShelterMetric ? wholeAtLeastZero(shelterValue) : 0;
  if (hasShelterMetric) {
    if (!shelters) return 'no shelter stops';
    const kinds = [
      ['track', outcome.journey.track_stops],
      ['route', outcome.journey.route_stops],
      ['hop-wall', outcome.journey.hop_wall_stops],
      ['sanctuary', outcome.journey.sanctuary_stops],
    ].map(([name, count]) => [name, wholeAtLeastZero(count)])
      .filter(([, count]) => count > 0);
    const counted = kinds.reduce((sum, [, count]) => sum + count, 0);
    // Older outcomes may carry only the total. Keep them useful instead of inventing a
    // breakdown whose parts do not add up.
    const breakdown = kinds.length && counted === shelters
      ? ` (${kinds.map(([name, count]) => `${count} ${name}`).join(', ')})` : '';
    return `${shelters} shelter stop${shelters === 1 ? '' : 's'}${breakdown}`;
  }
  // No Autopilot journey means there is no journey-scoped shelter metric. The old tally is
  // retained only as that compatibility fallback; it is deliberately ignored above because
  // a keeper-wide counter can change for work unrelated to this trip.
  const rests = wholeAtLeastZero(keeperRestStops);
  return rests ? `${rests} rest stop${rests === 1 ? '' : 's'}` : 'no rest stops';
}
