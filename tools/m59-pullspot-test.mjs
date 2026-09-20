#!/usr/bin/env node
// Target-first safe-wall pulling. Offline: no broker, server, or fleet mutations.
//
//   node tools/m59-pullspot-test.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  coarseCombatReachFrom, geometryFor, nearestSafeSpot,
  preferSafeSpotCandidate, reachableFrom, safeSpots,
} from './m59-safespots.mjs';
import { fight } from './m59-skills.mjs';
import { OF } from './m59-parse.mjs';
import { takeSafeSpot as takeAtomicSafeSpot } from './m59-act/take-safe-spot.mjs';
import { beginPullProgress, samplePullProgress } from './m59-pull-progress.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

await test('target distance outranks a far wall with a higher legacy score', () => {
  const far = { target_distance: 12, from_fight: 12, quarry_steps: 12, value: 500 };
  const near = { target_distance: 2, from_fight: 2, quarry_steps: 20, value: -500 };
  assert.equal(preferSafeSpotCandidate(near, far, { closestToToward: true }), true);
  assert.equal(preferSafeSpotCandidate(near, far), false);
});

await test('pull progress samples every few seconds and stalls after three non-closing checks', () => {
  const wall = { room: 544, col: 5, row: 5 };
  let state = beginPullProgress({ col: 15, row: 5 }, wall, { now: 1_000 });
  let sample = samplePullProgress(state, { col: 15, row: 5 }, { now: 2_999 });
  assert.equal(sample.sampled, false, 'sampled before the three-second cadence');

  for (const now of [4_000, 7_000]) {
    sample = samplePullProgress(state, { col: 15, row: 5 }, { now });
    state = sample.state;
    assert.equal(sample.stalled, false);
  }
  // Delayed movement toward the wall resets the flat-sample count.
  sample = samplePullProgress(state, { col: 13, row: 5 }, { now: 10_000 });
  state = sample.state;
  assert.equal(sample.closer, true);
  assert.equal(state.non_closing_samples, 0);

  for (const now of [13_000, 16_000, 19_000]) {
    sample = samplePullProgress(state, { col: 13, row: 5 }, { now });
    state = sample.state;
  }
  assert.equal(sample.stalled, true);
  assert.equal(sample.stalled_samples, 3);
});

await test('coarse reach rejects a nearby disconnected wall and accepts a reachable one', () => {
  // The quarry can only move down column 1. The visually-near spot at (4,1) has no cell
  // from that component inside its radius-2 combat disc; the farther spot at (3,5) does.
  const floor = new Set(['1,1', '2,1', '3,1', '4,1', '5,1']);
  const geo = {
    rows: 5, cols: 7,
    inBounds: (row, col) => row >= 1 && row <= 5 && col >= 1 && col <= 7,
    walkable: (row, col) => floor.has(`${row},${col}`),
    openDirections(row, col, { fine }) {
      assert.equal(fine, false, 'quarry flood must use the coarse grid');
      const out = [];
      for (const dr of [-1, 1])
        if (floor.has(`${row + dr},${col}`)) out.push({ dr, dc: 0 });
      return out;
    },
  };
  const reach = coarseCombatReachFrom(geo, { row: 1, col: 1 });
  assert.equal(reach(4, 1).reachable, false);
  assert.equal(reach(3, 5).reachable, true);
  assert.equal(reach(3, 5).grid, 'coarse');
});

const mapFile = new URL('../substrate/m59-map.json', import.meta.url);
if (existsSync(mapFile)) {
  await test('Valley chooses the closest coarse-reachable wall and skips an occupied winner', () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    assert.ok(geo, 'room 544 geometry is missing');

    const from = { col: 6, row: 39 };
    const quarry = { col: 17, row: 74 };
    const quarryReach = coarseCombatReachFrom(geo, quarry);
    assert.ok(quarryReach, 'coarse quarry component could not be built');
    // THE FAKE BOOK THAT USED TO BE BUILT HERE IS GONE. It stubbed `recall`/`discredited`
    // off the real substrate file so this test could check that a discredited square was
    // skipped. Nothing discredits a square any more (tombstone in m59-safespots.mjs), so the
    // assertion below is now purely about REACHABILITY — which is what it was really for:
    // the closest coarse-reachable wall, skipping one an ally already occupies.
    const options = {
      within: Math.max(geo.rows, geo.cols), room: 544,
      toward: quarry, quarryReach, strictQuarryReach: true, closestToToward: true,
    };
    const picked = nearestSafeSpot(geo, from, options);
    assert.ok(picked, 'no target-valid Valley wall was selected');

    const playerReach = reachableFrom(geo, from);
    const valid = safeSpots(geo, { limit: Infinity }).filter(spot => {
      return (!playerReach || playerReach.has(`${spot.row},${spot.col}`))
        && quarryReach(spot.col, spot.row).reachable;
    });
    const nearest = Math.min(...valid.map(spot =>
      Math.hypot(spot.col - quarry.col, spot.row - quarry.row)));
    assert.equal(picked.target_distance, nearest, 'selector did not choose the closest valid wall');
    assert.equal(quarryReach(picked.col, picked.row).reachable, true);

    // A visible player on the winning square removes it from this pass. The next result
    // must be a different, still-valid wall rather than sharing the body.
    const occupied = new Set([`${picked.col},${picked.row}`]);
    const alternative = nearestSafeSpot(geo, from, { ...options, unreachable: occupied });
    assert.ok(alternative, 'no alternative to the occupied wall was selected');
    assert.notEqual(`${alternative.col},${alternative.row}`, `${picked.col},${picked.row}`);
    assert.equal(occupied.has(`${alternative.col},${alternative.row}`), false);
    assert.equal(quarryReach(alternative.col, alternative.row).reachable, true);
  });

  await test('GOAP pull atomic passes the selected quarry through the same validation', async () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    const quarry = { id: 700, col: 17, row: 74 };
    const from = { id: 99, col: 6, row: 39 };
    const quarryReach = coarseCombatReachFrom(geo, quarry);
    const first = nearestSafeSpot(geo, from, {
      within: Math.max(geo.rows, geo.cols), toward: quarry, quarryReach,
      strictQuarryReach: true, closestToToward: true,
    });
    assert.ok(first, 'fixture has no initial target-valid wall');

    const client = {
      selfId: 99,
      self: { ...from },
      me: { name: 'pullspot-test' },
      room: { objects: new Map([
        [99, { ...from, flags: OF.PLAYER }],
        [50, { id: 50, col: first.col, row: first.row, flags: OF.PLAYER }],
        [700, { ...quarry, flags: OF.ATTACKABLE }],
      ]) },
    };
    const walks = [];
    const session = {
      name: 'pullspot-test', world: { geometry: geo },
      async walkTo(col, row) {
        walks.push({ col, row });
        client.self = { ...client.self, col, row };
        return { arrived: true };
      },
    };
    const result = await takeAtomicSafeSpot(client, session, { target: quarry });
    assert.equal(result.at_wall, true, result.reason);
    assert.equal(walks.length, 1);
    assert.notEqual(`${walks[0].col},${walks[0].row}`, `${first.col},${first.row}`,
      'the atomic chose the player-occupied wall');
    assert.equal(quarryReach(walks[0].col, walks[0].row).reachable, true);
  });

  await test('morphed players and blocking monsters cannot occupy a pull destination', async () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    const from = { id: 99, col: 6, row: 39, flags: OF.PLAYER };
    const quarry = { id: 700, col: 17, row: 74, flags: OF.ATTACKABLE };
    const baseline = nearestSafeSpot(geo, from, {
      within: 80, toward: quarry, quarryReach: coarseCombatReachFrom(geo, quarry),
      strictQuarryReach: true, closestToToward: true,
    });
    assert.ok(baseline);

    const morphed = { id: 50, col: baseline.col, row: baseline.row, flags: 0 };
    const client = {
      selfId: 99, self: { ...from }, me: { name: 'pullspot-morph-test' },
      playersOnline: new Map([[50, { id: 50, name: 'morphed player' }]]),
      room: { objects: new Map([[99, from], [50, morphed], [700, quarry]]) },
    };
    let aimed = null;
    const session = {
      name: 'pullspot-morph-test', world: { geometry: geo },
      async walkTo(col, row) { aimed = { col, row }; return { arrived: false, reason: 'ran out of steps' }; },
    };
    await takeAtomicSafeSpot(client, session, { target: quarry, maxSteps: 1 });
    assert.notDeepEqual(aimed, { col: morphed.col, row: morphed.row },
      'a morphed player without OF.PLAYER was treated as an empty wall');

    const blockingQuarry = {
      id: 701, col: baseline.col, row: baseline.row,
      flags: OF.ATTACKABLE | 1, // MOVEON.NO
    };
    const bodyClient = {
      selfId: 199, self: { id: 199, col: 6, row: 39, flags: OF.PLAYER },
      me: { name: 'pullspot-body-test' },
      room: { objects: new Map([[701, blockingQuarry]]) },
    };
    let bodyAim = null;
    const bodySession = {
      name: 'pullspot-body-test', world: { geometry: geo },
      async walkTo(col, row) { bodyAim = { col, row }; return { arrived: false, reason: 'ran out of steps' }; },
    };
    await takeAtomicSafeSpot(bodyClient, bodySession, { target: blockingQuarry, maxSteps: 1 });
    assert.notDeepEqual(bodyAim, { col: blockingQuarry.col, row: blockingQuarry.row },
      'the selected quarry itself occupied the chosen wall');
  });

  await test('target-wall pairing survives bounded legs and failed walls are skipped', async () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    const quarry = { id: 800, col: 17, row: 74, flags: OF.ATTACKABLE };
    const from = { id: 299, col: 6, row: 39, flags: OF.PLAYER };
    const client = {
      selfId: 299, self: { ...from }, me: { name: 'pullspot-stable-test' },
      room: { objects: new Map([[800, quarry]]) },
    };
    const aims = [];
    const session = {
      name: 'pullspot-stable-test', world: { geometry: geo },
      async walkTo(col, row) {
        aims.push({ col, row });
        return { arrived: false, reason: 'ran out of steps' };
      },
    };
    await takeAtomicSafeSpot(client, session, { target: quarry, maxSteps: 1 });
    quarry.col = 60; quarry.row = 20;
    await takeAtomicSafeSpot(client, session, { target: quarry, maxSteps: 1 });
    assert.deepEqual(aims[1], aims[0], 'a moving quarry re-aimed an in-progress wall approach');

    const failedClient = {
      selfId: 399, self: { id: 399, col: 6, row: 39, flags: OF.PLAYER },
      me: { name: 'pullspot-failed-test' },
      room: { objects: new Map([[900, { id: 900, col: 17, row: 74, flags: OF.ATTACKABLE }]]) },
    };
    const failedAims = [];
    const failedSession = {
      name: 'pullspot-failed-test', world: { geometry: geo },
      async walkTo(col, row) {
        failedAims.push({ col, row });
        return { arrived: false, reason: 'blocked — every heading refused, at every reach tried' };
      },
    };
    const failedQuarry = failedClient.room.objects.get(900);
    await takeAtomicSafeSpot(failedClient, failedSession, { target: failedQuarry });
    await takeAtomicSafeSpot(failedClient, failedSession, { target: failedQuarry });
    assert.notDeepEqual(failedAims[1], failedAims[0],
      'a no-progress wall failure was selected again on the next pass');
  });

  await test('concurrent pull selectors reserve different walls before either body arrives', async () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    const quarry = { id: 1000, col: 17, row: 74, flags: OF.ATTACKABLE };
    const make = (name, id, col) => {
      const self = { id, col, row: 39, flags: OF.PLAYER };
      const client = {
        selfId: id, self, me: { name },
        room: { objects: new Map([[id, self], [1000, quarry]]) },
      };
      let aim = null;
      const session = {
        name, world: { geometry: geo },
        async walkTo(c, r) { aim = { col: c, row: r }; return { arrived: false, reason: 'ran out of steps' }; },
      };
      return { client, session, aim: () => aim };
    };
    const a = make('pullspot-race-a', 501, 6);
    const b = make('pullspot-race-b', 502, 7);
    await Promise.all([
      takeAtomicSafeSpot(a.client, a.session, { target: quarry, maxSteps: 1 }),
      takeAtomicSafeSpot(b.client, b.session, { target: quarry, maxSteps: 1 }),
    ]);
    assert.ok(a.aim() && b.aim());
    assert.notDeepEqual(a.aim(), b.aim(), 'both selectors reserved the same empty wall');
  });

  await test('a partial target-first walk cannot substitute an unvalidated intermediate wall', async () => {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const geo = geometryFor(map.rooms['544']);
    const quarry = { id: 700, col: 17, row: 74, flags: OF.ATTACKABLE };
    // The north exit square touches a cardinal wall, which exercises the old generic
    // "any wall is success" fallback, but it is not the target-first candidate selected
    // for a quarry at the south end of Valley.
    const from = { id: 99, col: 23, row: 1, flags: OF.PLAYER };
    const client = {
      selfId: 99, self: { ...from }, me: { name: 'pullspot-partial-test' },
      room: { objects: new Map([[99, from], [700, quarry]]) },
    };
    let aimed = null;
    const session = {
      name: 'pullspot-partial-test', world: { geometry: geo },
      async walkTo(col, row) {
        aimed = { col, row };
        return { arrived: false, reason: 'bounded walk still in progress' };
      },
    };
    const result = await takeAtomicSafeSpot(client, session, { target: quarry, maxSteps: 1 });
    assert.ok(aimed, 'the atomic did not choose a target-valid wall');
    assert.notDeepEqual(aimed, { col: from.col, row: from.row });
    assert.equal(result.at_wall, false,
      'an intermediate wall was reported as the selected quarry-valid pull spot');
  });
} else {
  console.log('SKIP  Valley integration fixture (no baked map or safe-spot book)');
}

await test('holding a wall never launches a fine-grid chase at distance 2..3', async () => {
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 7, row: 6, nameRsc: 1 };
  const objects = new Map([[1, foe], [99, { id: 99, col: 5, row: 5 }]]);
  const walks = [];
  const client = {
    selfId: 99, self: { col: 5, row: 5 }, room: { objects }, inventory: [], evSeq: 0,
    rsc: { get: id => id === 1 ? 'fungus beast' : '?' }, lookup: () => 'fungus beast',
    vitals: () => ({ health: { value: 40, max: 40 }, vigor: { value: 200, max: 200 } }),
    stats: async () => {}, waitFor: async () => ({ events: [], timedOut: true }),
    roomContents: () => {}, face: async () => true,
  };
  const session = {
    need: () => client,
    pacer: { submit: async (_kind, fn) => fn() },
    world: { approachSquare: () => null },
    walkFine: async (...args) => { walks.push(args); return { arrived: false }; },
    attackRounds: async id => { objects.delete(id); return { messages: ['hit'], vitals: client.vitals() }; },
    lootFloor: async () => ({ taken: [], refused: [], carrying: [] }),
  };
  const result = await fight(session, {
    target: 'fungus beast', preferId: 1, holdPosition: true, reach: 3,
    equip: false, loot: false, rounds: 1,
  });
  assert.equal(walks.length, 0, 'holdPosition escaped into walkFine');
  assert.equal(result.killed, true);
});

console.log(`\n${passed} pull-safe-spot tests passed`);
