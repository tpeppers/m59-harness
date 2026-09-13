#!/usr/bin/env node
// Offline: execute the real departure/rest/watchdog path without a socket or roster.
import assert from 'node:assert/strict';
import { Autopilot } from './m59-autopilot.mjs';
import { freshState } from './m59-watchdog.mjs';

let passed = 0;
for (const [hops, activity] of [[2, 'travelling'], [1, 'zoning']]) {
  for (const restFails of [false, true]) {
    let health = 10;
    const frames = [];
    const rests = [];
    const k = Object.assign(Object.create(Autopilot.prototype), {
      policy: {}, doing: 'banking', tally: {}, watch: freshState(), passes: 1,
      passStartedAt: Date.now() - 5000,
      note() {}, progress() {}, ledgerEvent() {}, detailEvent() {},
      recordFrame(why) { frames.push({ why, doing: this.doing }); },
      hitDamageTotal: () => 0, answerWedge: async () => null,
      sanctuary: () => true, inReachOfUs: () => [],
      fightBackCheck() {}, pulsePosition() {}, safety: () => ({ fleeAt: 0.4 }),
      settle: async () => {
        k.watchdogTick();
        rests.push({ doing: k.doing, pinned: k.watch.pinnedAnchor });
        health = 20; // the real restUntil can now observe its target without waiting
      },
      s: {
        live: true,
        world: { room: { num: 54, name: 'Bank' },
                 route: () => ({ found: true, hops: Array.from({ length: hops }, () => ({})) }) },
        client: { state: 'game', vitals: () => ({ health: { value: health, max: 20 },
                                               vigor: { value: 80, scale_max: 200 } }) },
        travel: async () => {
          assert.equal(k.doing, activity, 'the mover must see the resumed activity');
          k.watch.pulses = [{ at: Date.now(), room: 584, row: 35, col: 27, health }];
          k.watch.lastPulseAt = Date.now();
          k.watchdogTick();
          assert.deepEqual(k.watch.pinnedAnchor, { room: 584, row: 35, col: 27 },
                           'the real watchdog must recognize a resumed walk');
          return { arrived: true };
        },
      },
    });
    if (restFails) {
      // Exercise travel's existing catch: even a failed rest must not label the walk
      // as recovering. A refusal from restUntil itself is handled inside the real helper.
      k.restBeforeSettingOut = async () => { k.doing = 'recovering'; throw new Error('rest failed'); };
    }
    assert.equal((await k.travel(104, {})).arrived, true);
    assert.equal(frames.find(f => f.why === 'setting off').doing, activity);
    if (!restFails) assert.deepEqual(rests, [{ doing: 'recovering', pinned: null }],
                                    'an actual rest remains recovery and is not a walking wedge');
    passed++;
  }
}
console.log(`${passed} travel activity cases passed`);
