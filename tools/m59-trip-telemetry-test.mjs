#!/usr/bin/env node
// Arrival telemetry's handoff contract. Offline: no socket, broker or fleet state.

import { strict as assert } from 'node:assert';
import { Autopilot } from './m59-autopilot.mjs';
import {
  travelJourneyMetrics,
  withTravelJourneyMetrics,
  tripStopPhrase,
} from './m59-trip-telemetry.mjs';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ok   ' + name);
};

await test('a journey metric is a bounded immutable value snapshot', () => {
  const counters = { shelterStops: 2.9, heldMs: 4567.8 };
  const metrics = travelJourneyMetrics(counters);
  counters.shelterStops = 0;
  counters.heldMs = 0;
  assert.deepEqual(metrics, {
    shelter_stops: 2, held_ms: 4567, hop_wall_stops: 0, sanctuary_stops: 0,
    route_stops: 0, track_stops: 0,
  });
  assert.equal(Object.isFrozen(metrics), true);
  assert.throws(() => { metrics.shelter_stops = 99; }, TypeError);
});

await test('attaching metrics preserves the travel result and does not mutate it', () => {
  const raw = { arrived: true, hops: 7 };
  const result = withTravelJourneyMetrics(raw, { shelterStops: 3, heldMs: 9000 });
  assert.deepEqual(raw, { arrived: true, hops: 7 });
  assert.deepEqual(result, {
    arrived: true, hops: 7,
    journey: { shelter_stops: 3, held_ms: 9000, hop_wall_stops: 0,
               sanctuary_stops: 0, route_stops: 0, track_stops: 0 },
  });
});

await test('arrival words use per-journey shelter telemetry, not a misleading rest tally', () => {
  const outcome = withTravelJourneyMetrics({ arrived: true }, {
    shelterStops: 3, trackStops: 2, sanctuaryStops: 1,
  });
  assert.equal(tripStopPhrase(outcome, 0), '3 shelter stops (2 track, 1 sanctuary)');
  // The keeper tally is process-wide, not evidence that this journey rested.
  assert.equal(tripStopPhrase(outcome, 9), '3 shelter stops (2 track, 1 sanctuary)');
  assert.equal(tripStopPhrase(withTravelJourneyMetrics({ arrived: true }, {
                 shelterStops: 1, routeStops: 1,
               }), 0), '1 shelter stop (1 route)');
  assert.equal(tripStopPhrase(withTravelJourneyMetrics({ arrived: true }, {}), 0),
               'no shelter stops');
});

await test('a result without keeper journey telemetry retains truthful rest wording', () => {
  assert.equal(tripStopPhrase({ arrived: true }, 0), 'no rest stops');
  assert.equal(tripStopPhrase({ arrived: true }, 1), '1 rest stop');
  assert.equal(tripStopPhrase({ arrived: true }, 2), '2 rest stops');
});

await test('Autopilot.travel returns its stop snapshot after clearing live counters', async () => {
  const detail = [];
  const ledger = [];
  let clocksBeforeReturn = null;
  const keeper = {
    policy: {},
    doing: 'travelling',
    travelShelterPolicy: Autopilot.prototype.travelShelterPolicy,
    travelGuard: Autopilot.prototype.travelGuard,
    answerWedge: async () => null,
    restBeforeSettingOut: async () => ({ rested: false }),
    travelHoldMode: () => 'on',
    recordFrame: () => {},
    hitDamageTotal: () => 0,
    ledgerEvent: (_kind, row) => ledger.push(row),
    detailEvent: (_category, _kind, row) => detail.push(row),
    travelHold: async function () {
      this.recordTravelShelterStop('hop_wall', { heldMs: 125 });
    },
    recordTravelShelterStop: Autopilot.prototype.recordTravelShelterStop,
    s: {
      world: {
        room: { num: 52, name: 'Tos' },
        route: () => ({ found: true, hops: [{ room: 100 }, { room: 106 }] }),
      },
      client: { vitals: () => ({ health: { value: 40, max: 40 } }) },
      travel: async (_room, { onHop, onTrackRest }) => {
        await onTrackRest({ stops: 3, held_ms: 375 });
        await onHop({ room: { num: 100, name: 'Road' }, hops_done: 0, remaining: 1 });
        await onHop({ room: { num: 106, name: 'Barloque' }, hops_done: 1, remaining: 0 });
        clocksBeforeReturn = {
          boundary_budget_ms: keeper.travelHeldMs,
          all_shelter_ms: keeper.travelShelterHeldMs,
        };
        return { arrived: true, hops: 2 };
      },
    },
  };

  const outcome = await Autopilot.prototype.travel.call(keeper, 106, {});
  assert.deepEqual(outcome.journey, {
    shelter_stops: 5, held_ms: 625, hop_wall_stops: 2, sanctuary_stops: 0,
    route_stops: 0, track_stops: 3,
  });
  assert.equal(Object.isFrozen(outcome.journey), true);
  assert.deepEqual(clocksBeforeReturn, { boundary_budget_ms: 250, all_shelter_ms: 625 });
  assert.equal(keeper.travelSafeStops, 0);
  assert.equal(keeper.travelHeldMs, 0);
  assert.equal(keeper.travelTrackStops, 0);
  assert.equal(detail.at(-1)?.safe_spot_stops, 5);
  assert.equal(detail.at(-1)?.safe_spot_ms, 625);
  assert.equal(ledger.at(-1)?.shelter_stops, 5);
  assert.equal(ledger.at(-1)?.hop_wall_stops, 2);
  assert.equal(ledger.at(-1)?.track_stops, 3);
  assert.equal(ledger.at(-1)?.shelter_held_ms, 625);
});

await test('arriving whole at a route refuge walks on without counting a stop', async () => {
  const keeper = Object.assign(Object.create(Autopilot.prototype), {
    policy: {}, inert: null, shelterRun: null,
    travelSafeStops: 0, travelHeldMs: 0, travelRouteStops: 0,
    book: { save: () => {} },
    note: () => {},
    sanctuary: () => false,
    travelDivertAt: () => 0.8,
    s: {
      name: null,
      world: { room: { num: 578, name: 'The Cragged Mountains' } },
      client: {
        self: { row: 12, col: 49 },
        vitals: () => ({ health: { value: 40, max: 40 },
                         vigor: { value: 80, scale_max: 200 } }),
      },
    },
  });
  keeper.goTravelling('test journey', { to: 576 });
  const rested = await keeper.s.shelterPolicy.onArrive({ row: 12, col: 49 });
  assert.equal(rested, false);
  assert.equal(keeper.travelSafeStops, 0);
  assert.equal(keeper.travelRouteStops, 0);
});

console.log(`\n${passed} passed, 0 failed`);
