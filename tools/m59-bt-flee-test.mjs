#!/usr/bin/env node
// m59-bt-flee-test.mjs -- offline tests for the flee/rest behavior tree.
//
// Runs without a broker or server. Uses a mock keeper that records which
// methods were called and returns canned values.
//
//   node tools/m59-bt-flee-test.mjs

import {
  getFleeTree, doomedNode, fleeThresholdNode, sanctuarySettleNode,
  getAWallNode, vigorWalkNode, leaveRoomNode, restNode,
  armHealthNode, healNode, restUntilNode,
  tryLeaveNode, breakOutNode, eatNode, declareTrappedNode,
} from './m59-bt-flee.mjs';

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Mock keeper
// ---------------------------------------------------------------------------

function mockKeeper(overrides = {}) {
  const calls = [];
  const k = {
    calls,
    note: (msg, detail) => calls.push(['note', msg]),
    progress: (msg) => calls.push(['progress', msg]),
    noProgress: (msg) => calls.push(['noProgress', msg]),
    policy: {
      fleeBelow: 0.4,
      restBelow: 0.6,
      doomedInSpotBelow: 0.35,
      holdResumeAbove: 0.8,
      useSafeSpots: true,
      panicLogoff: true,
      mode: 'farm',
      hunt: 'giant rat',
      strategy: 'baseline',
      ...overrides.policy,
    },
    s: {
      name: 't1',
      client: {
        vitals: () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } }),
        self: { col: 10, row: 10 },
        selfId: 1,
        room: { objects: new Map() },
        rsc: { get: () => 'giant rat' },
        armed: () => true,
      },
      world: { exits: () => [] },
    },
    hold: null,
    holdWorks: () => false,
    doing: null,
    wallTriedAt: null,
    settledIn: null,
    tally: { rests: 0, withdrawals: 0, mulligans: 0, fled_rooms: 0 },
    recoverUntilWhole: false,
    recovered: () => true,
    safety: () => ({ engageAt: 0.75, fleeAt: 0.3 }),
    sanctuary: () => false,
    armed: () => true,
    // BT flee helpers
    _btFleeNear: () => [],
    _btFleeHostiles: () => [],
    _btFleeStrategy: () => ({}),
    _btFleeRestAndCook: async () => {},
    _btFleeTurnInPlace: async () => ({ turned: true }),
    _btFleeNudge: async () => ({ moved: true }),
    _btFleeReturnToSpot: async () => ({ arrived: true }),
    _btFleeHealUp: async () => ({ healed: true }),
    _btFleeRestUntil: async () => null,
    // Methods that the BT nodes call
    playDead: async () => true,
    townTripIfCornered: async () => false,
    // ARRIVED, because a retreat that did not arrive is no longer a retreat: the nodes
    // return FAILURE on a refusal so the selector can reach the node that walks out. See
    // m59-retreat-refusal-test.mjs and issue #51.
    retreatToSafety: async () => ({ arrived: true }),
    settle: async () => {},
    takeSafeSpot: async () => false,
    breakOut: async () => ({ did: false }),
    provision: async () => 'full',
    declareInterest: () => {},
    cookSomething: async () => {},
    releaseHold: () => {},
    ...overrides,
  };
  return k;
}

function bb(keeper, overrides = {}) {
  return {
    session: keeper,
    client: keeper.s.client,
    policy: keeper.policy,
    room: { num: 100, name: 'Test Room' },
    _bt: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-bt-flee-test.mjs\n');

t('getFleeTree throws without a keeper', () => {
  let threw = false;
  try { getFleeTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getFleeTree returns a tree with tick and tickAsync', () => {
  const k = mockKeeper();
  const tree = getFleeTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick function');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync function');
});

t('doomedNode: FAILURE when no nearby hostiles', async () => {
  const k = mockKeeper({ _btFleeNear: () => [] });
  const node = doomedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('doomedNode: FAILURE when health is above doomedAt', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = doomedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('doomedNode: a refused playDead yields the tick instead of running for a town', async () => {
  // FLIPPED 2026-09-10, BY THE OPERATOR. This used to assert that a refused freeze abandons the
  // spot and runs: "Moving is the only thing that changes the situation; staying still is how you
  // die." The evidence behind it was Lee, who froze 13 times at 1-4 HP in Main gate to the city
  // of Tos and died -- so the OLD conclusion was that freezing had failed and distance was left.
  //
  // The operator's instruction is the opposite and is about the whole codebase, not this node:
  // "everything else in our codebase is wrong about how to get monsters to stop attacking you.
  // There is truly only one way: The play_dead." A run for a town is dozens of seconds of being
  // hit through the rooms that were already killing us.
  //
  // So what a refusal now means is narrower and the response is different. playDead only
  // declines when we have ALREADY frozen here and not yet acted -- freezing again would clear
  // PFLAG_MOVED_SINCE_ENTRY and undo the healing the last one bought. In that state the right
  // answer is FAILURE, because FAILURE is what lets `leave_room` have the tick, and crossing an
  // exit is real movement rather than a walk across a monster room. Lee's 13 freezes are still
  // the case to beat; the answer to them is the exit, not the town.
  let townTrip = false;
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => true,
    hold: { col: 3, row: 17 },
    playDead: async () => false,    // already frozen here and not yet acted
    townTripIfCornered: async () => { townTrip = true; return true; },
  });
  k.s.client.vitals = () => ({ health: { value: 3, max: 30 }, vigor: { value: 80, max: 200 } });
  const r = await doomedNode(k).tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE (yield to the exit node), got ${r}`);
  if (townTrip) throw new Error('ran for a town; that strategy was removed');
  if (!k.calls.some(([kind, msg]) => kind === 'note' && /cannot freeze again yet/.test(msg)))
    throw new Error('the refusal was swallowed instead of said out loud');
});

t('doomedNode: playDead accepted -> SUCCESS (stays and freezes)', async () => {
  let townTrip = false;
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => true,
    hold: { col: 3, row: 17 },
    playDead: async () => true,    // playDead ACCEPTS
    townTripIfCornered: async () => { townTrip = true; return true; },
  });
  k.s.client.vitals = () => ({ health: { value: 3, max: 30 }, vigor: { value: 80, max: 200 } });
  const node = doomedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
  if (townTrip) throw new Error('should NOT run for a town when playDead accepted');
});

t('fleeThresholdNode: FAILURE when health is above fleeBelow', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = fleeThresholdNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('fleeThresholdNode: SUCCESS when below fleeBelow in the open', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    // ARRIVED, because a retreat that did not arrive is no longer a retreat: the nodes
    // return FAILURE on a refusal so the selector can reach the node that walks out. See
    // m59-retreat-refusal-test.mjs and issue #51.
    retreatToSafety: async () => ({ arrived: true }),
  });
  k.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = fleeThresholdNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// ISSUE #51, IN THE TREE'S OWN GRAMMAR. `retreatToSafety` returns `{arrived:false}`
// whenever `retreat_to_inn` is off, which on this fleet is always. A node that returns
// SUCCESS on that ends the selector tick, so `leave_room` -- the node that actually walks
// out -- never gets one, and the character stands still until it dies. Four deaths.
t('fleeThresholdNode: no wall means the LOGOFF, not a retreat', async () => {
  // The retreat this replaces was decorative: `retreatToSafety` returns `{arrived:false}`
  // whenever `retreat_to_inn` is off, and it has been off on this fleet since 2026-08-27. Four
  // deaths came of a node that decided to run and did not (issue #51). Operator, 2026-09-10:
  // "never resting in the open: use SAFE WALLS, and log out/in if the danger is immediate".
  let froze = false, retreated = false;
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    playDead: async () => { froze = true; return true; },
    retreatToSafety: async () => { retreated = true; return { arrived: true }; },
  });
  k.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const r = await fleeThresholdNode(k).tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS (the logoff landed), got ${r}`);
  if (!froze) throw new Error('expected playDead to be the answer with no wall');
  if (retreated) throw new Error('retreatToSafety was called; that strategy was removed');

  // AND A REFUSAL STILL YIELDS THE TICK, which is the half of issue #51 that must not regress:
  // a node claiming SUCCESS it did not earn pre-empts `leave_room`, the one node that walks out.
  const k2 = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    playDead: async () => false,
  });
  k2.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const r2 = await fleeThresholdNode(k2).tickAsync(bb(k2));
  if (r2 !== 'FAILURE') throw new Error(`expected FAILURE on a refused freeze, got ${r2}`);
  if (k2.tally.withdrawals) throw new Error('a withdrawal that did not happen was tallied');
});

t('vigorWalkNode: the logoff answers it, and a refusal is not progress', async () => {
  // This rung is hurt + no wall + vigor already above the resting ceiling, so waiting produces
  // nothing but time spent hurt in a monster room. It used to walk to an inn; the inn walk has
  // been switched off since 2026-08-27, so it never moved anybody. It is now the logoff.
  let froze = false, retreated = false;
  const k = mockKeeper({
    _btFleeHostiles: () => [{ id: 2, nameRsc: 1 }],
    _btFleeNear: () => [],
    holdWorks: () => false,
    playDead: async () => { froze = true; return true; },
    retreatToSafety: async () => { retreated = true; return { arrived: true }; },
  });
  k.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const r = await vigorWalkNode(k).tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS (the logoff landed), got ${r}`);
  if (!froze) throw new Error('expected playDead to answer this rung');
  if (retreated) throw new Error('retreatToSafety was called; that strategy was removed');

  // A REFUSED FREEZE IS STILL NOT PROGRESS. That half is issue #51 and must never regress:
  // reporting progress for something that did not happen hides the body from every stall
  // detector at the same time as pre-empting the node that could still move it.
  const k2 = mockKeeper({
    _btFleeHostiles: () => [{ id: 2, nameRsc: 1 }],
    _btFleeNear: () => [],
    holdWorks: () => false,
    playDead: async () => false,
  });
  k2.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const r2 = await vigorWalkNode(k2).tickAsync(bb(k2));
  if (r2 !== 'FAILURE') throw new Error(`expected FAILURE on a refused freeze, got ${r2}`);
  if (k2.calls.some(([kind]) => kind === 'progress'))
    throw new Error('a refused freeze was reported as progress');
});

t('vigorWalkNode: SUCCESS when the logoff lands', async () => {
  const k = mockKeeper({
    _btFleeHostiles: () => [{ id: 2, nameRsc: 1 }],
    _btFleeNear: () => [],
    holdWorks: () => false,
    playDead: async () => true,
  });
  k.s.client.vitals = () => ({ health: { value: 10, max: 36 }, vigor: { value: 140, max: 200 } });
  const r = await vigorWalkNode(k).tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
  if (!k.calls.some(([kind]) => kind === 'progress'))
    throw new Error('a retreat that happened was not reported');
});

t('sanctuarySettleNode: FAILURE when not in a sanctuary', async () => {
  const k = mockKeeper({ sanctuary: () => false });
  const node = sanctuarySettleNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('getAWallNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = getAWallNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('vigorWalkNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = vigorWalkNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('leaveRoomNode: FAILURE when no hostiles', async () => {
  const k = mockKeeper({ _btFleeHostiles: () => [] });
  const node = leaveRoomNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('restNode: FAILURE when in combat zone and not sheltered', async () => {
  const k = mockKeeper({
    _btFleeHostiles: () => [{ id: 2 }],
    holdWorks: () => false,
    hold: null,
  });
  const node = restNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('restNode: SUCCESS when safe and hurt', async () => {
  const k = mockKeeper({
    _btFleeHostiles: () => [],
    holdWorks: () => false,
    hold: null,
  });
  k.s.client.vitals = () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = restNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- Sub-nodes: armHealth, heal, restUntil ---

t('armHealthNode: FAILURE when not hurt', async () => {
  const k = mockKeeper({
    hold: null,
    holdWorks: () => false,
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = armHealthNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('armHealthNode: SUCCESS when hurt', async () => {
  const k = mockKeeper({
    hold: null,
    holdWorks: () => false,
    _btFleeNudge: async () => ({ moved: true }),
  });
  k.s.client.vitals = () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } });
  const node = armHealthNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('healNode: SUCCESS when healed', async () => {
  const k = mockKeeper({
    _btFleeHealUp: async () => ({ healed: true, used: ['flask'] }),
  });
  const node = healNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('restUntilNode: SUCCESS', async () => {
  const k = mockKeeper({
    _btFleeRestUntil: async () => null,
  });
  const node = restUntilNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// --- Sub-nodes: tryLeave, breakOut, eat, declareTrapped ---

t('tryLeaveNode: FAILURE when no exits', async () => {
  const k = mockKeeper();
  k.s.world.exits = () => [];
  const node = tryLeaveNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('tryLeaveNode: SUCCESS when leave succeeds', async () => {
  const k = mockKeeper();
  k.s.world.exits = () => [{ to: 200, to_name: 'Next Room' }];
  k.s.leaveViaAny = async () => ({ left: true });
  const node = tryLeaveNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('breakOutNode: FAILURE when breakOut fails', async () => {
  const k = mockKeeper({
    breakOut: async () => ({ did: false }),
  });
  const node = breakOutNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('breakOutNode: SUCCESS when breakOut and leave succeed', async () => {
  const k = mockKeeper({
    breakOut: async () => ({ did: true, crowd: 5 }),
  });
  k.s.world.exits = () => [{ to: 200, to_name: 'Next Room' }];
  k.s.leaveViaAny = async () => ({ left: true });
  const node = breakOutNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('eatNode: FAILURE when provision does not eat', async () => {
  const k = mockKeeper({
    provision: async () => 'full',
  });
  const node = eatNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'FAILURE') throw new Error(`expected FAILURE, got ${r}`);
});

t('eatNode: SUCCESS when provision eats', async () => {
  const k = mockKeeper({
    provision: async () => 'ate',
  });
  const node = eatNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('declareTrappedNode: SUCCESS', async () => {
  const k = mockKeeper();
  const node = declareTrappedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: rest wins when safe and hurt', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [],
    _btFleeHostiles: () => [],
    holdWorks: () => false,
    hold: null,
    sanctuary: () => false,
  });
  k.s.client.vitals = () => ({ health: { value: 20, max: 36 }, vigor: { value: 140, max: 200 } });
  const tree = getFleeTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: doomed wins when very low health with nearby hostile', async () => {
  const k = mockKeeper({
    _btFleeNear: () => [{ id: 2, nameRsc: 1 }],
    holdWorks: () => false,
    playDead: async () => true,
  });
  k.hold = { col: 10, row: 10 };
  k.holdWorks = () => true;
  k.s.client.vitals = () => ({ health: { value: 5, max: 36 }, vigor: { value: 140, max: 200 } });
  const tree = getFleeTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== 'SUCCESS') throw new Error(`expected SUCCESS, got ${r}`);
});

// ---------------------------------------------------------------------------

run();
