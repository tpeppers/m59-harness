#!/usr/bin/env node
// m59-bt-farm-test.mjs -- offline tests for the farm behavior tree.
//
// Runs without a broker or server. Uses a mock keeper that records which
// methods were called and returns canned values.
//
//   node tools/m59-bt-farm-test.mjs

import { SUCCESS, FAILURE, RUNNING } from './m59-bt.mjs';
import {
  getFarmTree, provisionNode, autoRetargetNode, roomInvalidNode,
  bagsFullNode, capBlockedNode, noHuntTargetNode, noTargetFoundNode,
  unarmedNode, tooHurtNode, tooTiredNode, fightNode, scavengeNode,
} from './m59-bt-farm.mjs';

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
    note: (msg, detail) => calls.push(['note', msg]),
    policy: {
      hunt: 'giant rat',
      purpose: 'advance',
      goals: [{ kind: 'hp' }],
      maxCarry: 50,
      maxThreatOver: 20,
      roam: false,
      useSafeSpots: true,
      clearWeak: true,
      fightRounds: 30,
      ...overrides.policy,
    },
    s: {
      name: 't1',
      client: {
        vitals: () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } }),
        statsById: new Map([['stamina', { value: 20 }]]),
        rsc: { get: () => 'giant rat' },
        inventory: [],
        armed: () => true,
      },
    },
    hold: null,
    holdWorks: () => false,
    doing: null,
    emptyPasses: 0,
    homeRoom: null,
    foeId: null,
    clearing: null,
    unreachable: new Set(),
    cappedRooms: new Map(),
    noWallRooms: new Map(),
    tally: { kills: 0, rests: 0 },
    vigor: { waited: 0 },
    killTimes: [],
    weaponPriorityNow: () => null,
    // BT farm helpers
    _btFarmStrategy: () => ({}),
    _btFarmSpawnFile: () => 'test-spawns.json',
    _btFarmDeniedRooms: () => new Map(),
    _btFarmShouldRelocate: () => false,
    _btFarmFindCreature: () => [],
    _btFarmFoundTargets: () => [],
    _btFarmFight: async () => ({ killed: false, died: false, rounds: 0, target: 'test' }),
    // Methods that the BT nodes call
    provision: async () => 'ate',
    yieldCheck: () => ({ paying: true }),
    preyRooms: () => [],
    readyToLeaveSanctuary: async () => true,
    leaveHold: async () => ({ refused: false }),
    travel: async () => ({ arrived: true }),
    sweepBroken: async () => {},
    sweepGearCondition: async () => {},
    makeRoom: async () => ({ ok: true, did: 'sold junk' }),
    capBlockers: () => null,
    hibernate: async () => false,
    roam: async () => {},
    armSelf: async () => true,
    armed: () => true,
    safety: () => ({ engageAt: 0.75, fleeAt: 0.3, maxHit: 5 }),
    fightFloor: () => 100,
    takeSafeSpot: async () => ({ took: false }),
    inReachOfUs: () => [],
    clearRefusal: () => {},
    doneWaiting: () => {},
    askForHelp: async () => {},
    recordHealUse: () => {},
    ...overrides,
  };
  if (typeof k.atHold !== 'function') k.atHold = () => !!k.hold;
  if (typeof k.holdingForFight !== 'function')
    k.holdingForFight = () => k.policy.useSafeSpots !== false && !!k.atHold();
  return k;
}

function bb(keeper, overrides = {}) {
  return {
    session: keeper,
    client: keeper.s.client,
    policy: keeper.policy,
    room: { num: 100, name: 'Test Room' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('m59-bt-farm-test.mjs\n');

t('getFarmTree throws without a keeper', () => {
  let threw = false;
  try { getFarmTree({}); } catch { threw = true; }
  if (!threw) throw new Error('expected throw');
});

t('getFarmTree returns a tree with tick and tickAsync', () => {
  const k = mockKeeper();
  const tree = getFarmTree({ session: { keeper: k } });
  if (typeof tree.tick !== 'function') throw new Error('expected tick function');
  if (typeof tree.tickAsync !== 'function') throw new Error('expected tickAsync function');
});

t('provisionNode: SUCCESS when provision returns ate', async () => {
  const k = mockKeeper({ provision: async () => 'ate' });
  const node = provisionNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('provisionNode: FAILURE when provision returns not-ate', async () => {
  const k = mockKeeper({ provision: async () => 'full' });
  const node = provisionNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('provisionNode: SUCCESS when provision returns waiting (stomach drain)', async () => {
  // THE BUG: when the stomach is full and the character is below the fight floor,
  // provision() returns 'waiting' -- it is deliberately holding the pass so the
  // stomach can drain and the character can eat its way up to the floor. Treating
  // this as FAILURE let the tooTired node run next, but resting is a no-op above the
  // resting cap, so the pass spun at "too tired to start a fight" for ever while the
  // larder sat full. 'waiting' must end the pass like a meal does.
  const k = mockKeeper({ provision: async () => 'waiting' });
  const node = provisionNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS for 'waiting', got ${r}`);
});

t('autoRetargetNode: FAILURE when purpose is not set', async () => {
  const k = mockKeeper({ policy: { purpose: null } });
  const node = autoRetargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('autoRetargetNode: FAILURE when paying is true', async () => {
  const k = mockKeeper({ yieldCheck: () => ({ paying: true }) });
  const node = autoRetargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('roomInvalidNode: FAILURE when no room', async () => {
  const k = mockKeeper();
  const node = roomInvalidNode(k);
  const r = await node.tickAsync(bb(k, { room: null }));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('bagsFullNode: FAILURE when inventory is not full', async () => {
  const k = mockKeeper();
  k.s.client.inventory = [];
  const node = bagsFullNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('bagsFullNode: SUCCESS when inventory is full', async () => {
  const k = mockKeeper();
  k.s.client.inventory = Array(50).fill({ name: 'junk' });
  const node = bagsFullNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('capBlockedNode: FAILURE when no room', async () => {
  const k = mockKeeper();
  const node = capBlockedNode(k);
  const r = await node.tickAsync(bb(k, { room: null }));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('capBlockedNode: FAILURE when capBlockers returns null', async () => {
  const k = mockKeeper({ capBlockers: () => null });
  const node = capBlockedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('noHuntTargetNode: FAILURE when hunt is set', async () => {
  const k = mockKeeper({ policy: { hunt: 'giant rat' } });
  const node = noHuntTargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('noHuntTargetNode: SUCCESS when hunt is not set', async () => {
  const k = mockKeeper({ policy: { hunt: null } });
  const node = noHuntTargetNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('unarmedNode: FAILURE when armed', async () => {
  // Armed now means "a weapon in the pack" (the node checks weaponsOf, not just the
  // wielding flag), so the mock must actually carry one for this to be a fair test.
  const k = mockKeeper({ armed: () => true });
  k.s.client.inventory = [{ nameRsc: 7 }];
  k.s.client.rsc = { get: (r) => (r === 7 ? 'mace' : '') };
  const node = unarmedNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tooHurtNode: FAILURE when health is above engageAt', async () => {
  const k = mockKeeper();
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  const node = tooHurtNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tooTiredNode: FAILURE when vigor is above floor', async () => {
  const k = mockKeeper();
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  k.fightFloor = () => 100;
  const node = tooTiredNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('tooTiredNode: rests (SUCCESS) when vigor is below floor', async () => {
  // Regression guard for the broken m59-combat.mjs import: with the fix in, the node
  // reaches a live restUntil and actually attempts a rest rather than logging
  // "resting" while doing nothing. The mock session has no real pacer, so restUntil
  // fails inside its own .catch -- that is fine; what we assert is that the node went
  // the rest path (SUCCESS, doing='recovering', tally.rests bumped, resting noted).
  const k = mockKeeper();
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 60, max: 200 } });
  k.fightFloor = () => 70;          // starved floor; 60 < 70 -> must rest
  k.hold = null; k.policy.useSafeSpots = false;   // skip takeSafeSpot
  const node = tooTiredNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS (rested), got ${r}`);
  if (k.doing !== 'recovering') throw new Error(`expected doing='recovering', got ${k.doing}`);
  if (k.tally.rests < 1) throw new Error(`expected tally.rests >= 1, got ${k.tally.rests}`);
});

t('tree: provision wins when hungry', async () => {
  const k = mockKeeper({ provision: async () => 'ate' });
  const tree = getFarmTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('tree: falls through to next node when provision is full', async () => {
  const k = mockKeeper({
    provision: async () => 'full',
    policy: { purpose: null },  // skip auto-retarget
  });
  k.s.client.inventory = [];
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140 } });
  k.preyRooms = () => [];
  k.capBlockers = () => null;
  k.hibernation = false;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 0, target: 'giant rat' });
  const tree = getFarmTree({ session: { keeper: k } });
  const r = await tree.tickAsync(bb(k));
  // Should fall through to fight and succeed
  if (r !== SUCCESS && r !== FAILURE) throw new Error(`expected SUCCESS or FAILURE, got ${r}`);
});

// ---------------------------------------------------------------------------
// Fight node: post-fight handling that the BT path used to skip
//
// The legacy fight path (m59-autopilot.mjs:9776) captures foe_id, sets swungAt,
// handles stale_identity, and rests-or-retreats on disengage. The BT fight node
// used to read only killed/died, so it never resumed a wounded prey, never
// cleared a stale id, and sat in the open taking hits after a low-health break.
// These assert each of those is now wired through.
// ---------------------------------------------------------------------------

t('fightNode captures foe_id so the next fight resumes the wounded prey', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 7, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 2, target: 'giant rat', foe_id: 7 });
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (k.foeId !== 7) throw new Error(`expected foeId=7 (resume wounded prey), got ${k.foeId}`);
});

t('fightNode converts pending pull contact with the exact pre-fight target even on kill', async () => {
  const k = mockKeeper({ hibernation: false });
  const quarry = { id: 7, nameRsc: 'giant rat' };
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [quarry];
  k.inReachOfUs = () => [];
  k.foeId = quarry.id;
  k.pendingPull = { target: 'giant rat', target_id: quarry.id, waitUntil: Date.now() + 5000 };
  k.pullsWithoutContact = 2;
  const contacts = [];
  k.pullConverted = (id, name) => {
    contacts.push({ id, name, keeperFoeAtCall: k.foeId });
    if (k.pendingPull?.target_id !== id) return false;
    k.pendingPull = null;
    k.pullsWithoutContact = 0;
    return true;
  };
  // fight() deliberately clears foe_id on a kill. The pre-fight claimed object is
  // therefore the only exact identity available to close this pending pull.
  k._btFarmFight = async () => ({ killed: true, died: false, rounds: 1,
    target: 'giant rat', foe_id: null });
  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || contacts.length !== 1 || contacts[0].id !== quarry.id ||
      contacts[0].keeperFoeAtCall !== quarry.id ||
      k.pendingPull !== null || k.pullsWithoutContact !== 0) {
    throw new Error(`exact killed quarry did not convert its pull: ${JSON.stringify({
      r, contacts, pending: k.pendingPull, pullsWithoutContact: k.pullsWithoutContact,
    })}`);
  }
});

t('fightNode preserves a pending pull when combat contacts a different exact target', async () => {
  const k = mockKeeper({ hibernation: false });
  const defender = { id: 7, nameRsc: 'giant rat' };
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [defender];
  k.inReachOfUs = () => [];
  const pending = { target: 'groundworm larva', target_id: 8, waitUntil: Date.now() + 5000 };
  k.pendingPull = pending;
  k.pullsWithoutContact = 2;
  const contacts = [];
  k.pullConverted = (id, name) => {
    contacts.push({ id, name });
    if (k.pendingPull?.target_id !== id) return false;
    k.pendingPull = null;
    k.pullsWithoutContact = 0;
    return true;
  };
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 2,
    target: 'giant rat', foe_id: defender.id, landed_hits: 1 });
  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || contacts.length !== 1 || contacts[0].id !== defender.id ||
      k.pendingPull !== pending || k.pullsWithoutContact !== 2) {
    throw new Error(`unrelated contact erased the pending pull: ${JSON.stringify({
      r, contacts, pending: k.pendingPull, pullsWithoutContact: k.pullsWithoutContact,
    })}`);
  }
});

t('fightNode trusts a surviving fight result when refreshed selection differs from the claim', async () => {
  const k = mockKeeper({ hibernation: false });
  const firstLook = { id: 7, nameRsc: 'giant rat' };
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [firstLook];
  k.inReachOfUs = () => [];
  k.pendingPull = { target: 'giant rat', target_id: 8, waitUntil: Date.now() + 5000 };
  const contacts = [];
  k.pullConverted = id => {
    contacts.push(id);
    if (k.pendingPull?.target_id !== id) return false;
    k.pendingPull = null;
    return true;
  };
  // The fight refresh may choose a different live object than the pre-fight snapshot.
  // Unlike a killed result, a surviving foe_id names the actual object contacted.
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 1,
    target: 'giant rat', foe_id: 8, landed_hits: 1 });
  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || contacts.length !== 1 || contacts[0] !== 8 || k.pendingPull !== null)
    throw new Error(`live fight id did not outrank stale claim: ${JSON.stringify({ r, contacts, pending: k.pendingPull })}`);
});

t('fightNode sets swungAt so the stall detector sees progress', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: true, died: false, rounds: 3, target: 'giant rat' });
  const node = fightNode(k);
  await node.tickAsync(bb(k));
  if (typeof k.swungAt !== 'number' || k.swungAt <= 0) throw new Error(`expected swungAt set, got ${k.swungAt}`);
});

t('fightNode rests (does not retreat) when breaking off behind a held spot', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = { col: 1, row: 1, proven: true };
  k.holdWorks = () => true;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 4, target: 'giant rat',
    disengaged: { at_health: '40%', mid_round: true } });
  let rested = 0, retreated = 0;
  // getSkills().restUntil would do real I/O; intercept the keeper-level path by
  // asserting no retreat happened and the node returned SUCCESS.
  k.retreatToSafety = async () => { retreated++; return { left: true }; };
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (retreated !== 0) throw new Error(`holding a spot must NOT retreat, got ${retreated} retreats`);
});

t('fightNode retreats when breaking off in the open (not holding a spot)', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = null; k.holdWorks = () => false;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 2, target: 'giant rat',
    disengaged: { at_health: '35%' } });
  let retreated = 0;
  k.retreatToSafety = async () => { retreated++; return { left: true }; };
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (retreated !== 1) throw new Error(`expected a retreat in the open, got ${retreated}`);
});

t('fightNode carries an unarmed weapon-loss reason into the retreat', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = null; k.holdWorks = () => false;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  const reason = 'the weapon shattered and no verified replacement could be equipped';
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 1, target: 'giant rat',
    disengaged: { at_health: '88%', unarmed: true, reason }, note: reason });
  let retreat = null;
  k.retreatToSafety = async args => { retreat = args; return { left: true }; };
  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || retreat?.because !== reason || retreat?.unarmed !== true)
    throw new Error(`weapon-loss cause was not preserved: ${JSON.stringify({ r, retreat })}`);
});

t('fightNode leaves a held wall before retreating unarmed, without resting or discrediting it', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = { col: 1, row: 1, proven: true };
  k.atHold = () => true;
  k.holdWorks = () => true;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  const reason = 'the weapon shattered and no verified replacement could be equipped';
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 1, target: 'giant rat',
    disengaged: { at_health: '88%', unarmed: true, reason }, note: reason });

  const persistedBook = { rooms: { 999: { '1,1': { held: 3, failed: 0, verified: true } } } };
  k.book = persistedBook;
  const bookBefore = JSON.stringify(persistedBook);
  const order = [];
  let leave = null, retreat = null, restReads = 0;
  k.s.need = () => { restReads++; return k.s.client; };
  k.leaveHold = async (why, options) => {
    order.push('leave');
    leave = { why, options };
    k.hold = null;
    return { left: true };
  };
  k.retreatToSafety = async args => {
    order.push('retreat');
    retreat = args;
    return { left: true };
  };

  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || order.join(',') !== 'leave,retreat' ||
      leave?.why !== reason || leave?.options?.force !== true ||
      retreat?.because !== reason || retreat?.unarmed !== true || restReads !== 0 ||
      JSON.stringify(persistedBook) !== bookBefore)
    throw new Error(`unsafe held-wall weapon recovery: ${JSON.stringify({
      r, order, leave, retreat, restReads, persistedBook,
    })}`);
});

t('fightNode treats a stale hold as open field when safe spots are disabled', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.useSafeSpots = false;
  k.hold = { col: 1, row: 1, proven: true };
  k.atHold = () => true;
  k.holdWorks = () => true;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ killed: false, died: false, rounds: 2, target: 'giant rat',
    disengaged: { at_health: '35%' } });
  let retreated = 0;
  k.retreatToSafety = async () => { retreated++; return { left: true }; };
  const r = await fightNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || retreated !== 1)
    throw new Error(`policy-off stale hold must retreat as open field: ${JSON.stringify({ r, retreated })}`);
});

t('fightNode reconnects on a stale object id instead of looping', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  k.inReachOfUs = () => [];
  k._btFarmFight = async () => ({ fought: true, killed: false, died: false, rounds: 1,
    stale_identity: true, note: 'id renumbered', target: 'giant rat' });
  let reconnected = 0;
  k.reconnect = async () => { reconnected++; return { ok: true }; };
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (reconnected !== 1) throw new Error(`expected a reconnect on stale id, got ${reconnected}`);
});

// ---------------------------------------------------------------------------
// Resting while waiting in a proven safe spot
//
// The fix for a character parked in a spot with nothing to hunt standing
// still and regenerating nothing. The wait path must sit (regen vigor to the
// 0.4 cap) when vitals are below the ceiling, and skip the sit when already
// whole.
// ---------------------------------------------------------------------------

t('wait-in-spot sits and rests when vigor is below the ceiling', async () => {
  const k = mockKeeper({
    hold: { col: 5, row: 5, proven: true },
    holdWorks: () => true,
    sanctuary: () => false,
  });
  // Vigor 60/200 = 0.3, below the 0.4 cap -> must rest.
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 60, max: 200 } });
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const node = noTargetFoundNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (rested !== 1) throw new Error(`expected one rest call, got ${rested}`);
  if (k.tally.rests !== 1) throw new Error(`expected tally.rests=1, got ${k.tally.rests}`);
});

t('wait-in-spot does not sit when already whole', async () => {
  const k = mockKeeper({
    hold: { col: 5, row: 5, proven: true },
    holdWorks: () => true,
    sanctuary: () => false,
  });
  // Vigor 140/200 = 0.7 (>= 0.4) and health full -> already whole, no sit.
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 140, max: 200 } });
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const node = noTargetFoundNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (rested !== 0) throw new Error(`expected no rest call, got ${rested}`);
});

t('wait-in-spot does not sit when a target is present (falls to fight)', async () => {
  const k = mockKeeper({
    hold: { col: 5, row: 5, proven: true },
    holdWorks: () => true,
    sanctuary: () => false,
  });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 60, max: 200 } });
  // A rat is in the room -> noTargetFound returns FAILURE, no rest, fight handles it.
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'giant rat' }];
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const node = noTargetFoundNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE (target present), got ${r}`);
  if (rested !== 0) throw new Error(`expected no rest call, got ${rested}`);
});

t('not-holding empty room rests when below the ceiling (Lee\u2019s stall)', async () => {
  // The real case: in a valid hunting room, NOT holding a spot, no prey present, vigor
  // below the floor. The empty-room path must sit and regen -- the fix for Lee sitting
  // at 60 vigor for ever with nothing to fight.
  const k = mockKeeper({ hold: null, holdWorks: () => false, sanctuary: () => false });
  k.s.client.vitals = () => ({ health: { value: 29, max: 29 }, vigor: { value: 60, max: 200 } });
  k._btFarmFoundTargets = () => [];
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const node = noTargetFoundNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS (rested while waiting), got ${r}`);
  if (rested !== 1) throw new Error(`expected a rest while waiting, got ${rested}`);
});

t('policy-off stale hold uses ordinary empty-room waiting, not the wall branch', async () => {
  const k = mockKeeper({
    hold: { col: 5, row: 5, proven: true },
    atHold: () => true,
    holdWorks: () => true,
    sanctuary: () => false,
  });
  k.policy.useSafeSpots = false;
  k.s.client.vitals = () => ({ health: { value: 29, max: 29 }, vigor: { value: 60, max: 200 } });
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const r = await noTargetFoundNode(k).tickAsync(bb(k));
  const notes = k.calls.filter(call => call[0] === 'note').map(call => call[1]);
  if (r !== SUCCESS || rested !== 1 || !notes.includes('resting while we wait for a spawn') ||
      notes.includes('resting in a proven spot while we wait for a spawn')) {
    throw new Error(`policy-off stale hold took the wrong wait branch: ${JSON.stringify({ r, rested, notes })}`);
  }
});

t('not-holding empty room does not rest when already whole', async () => {
  const k = mockKeeper({ hold: null, holdWorks: () => false, sanctuary: () => false });
  k.s.client.vitals = () => ({ health: { value: 36, max: 36 }, vigor: { value: 200, max: 200 } });
  k._btFarmFoundTargets = () => [];
  let rested = 0;
  k._btFarmRestWhileWaiting = async () => { rested++; return { rested: true }; };
  const node = noTargetFoundNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (rested !== 0) throw new Error(`expected no rest when whole, got ${rested}`);
});

// ---------------------------------------------------------------------------

// Fight node: out_of_reach must NOT loop "broke off, landed_hits 0" for ever
//
// The root of Lee's clearing deadlock: holding a safe spot, the nearest quarry is
// 9+ squares away, so fight() reports out_of_reach (it did NOT swing). Without a
// response the next pass re-fights the same distant quarry and reports the same
// out_of_reach, and the character loops "broke off, landed_hits 0" for ever while a
// monster sits across the room. The fix pulls the quarry to the wall (walk, hit once,
// walk back -- the legacy pull), so the next pass fights it where it can land hits.
// ---------------------------------------------------------------------------

t('fightNode delegates held-wall out_of_reach to the shared pending-pull state machine', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = { col: 5, row: 5, proven: true };
  k.holdWorks = () => true;
  k.policy.hunt = 'giant rat';
  k.policy.clearing = 'centipede';
  k.clearing = 'centipede';
  const quarry = { id: 7573, nameRsc: 'centipede' };
  k._btFarmFoundTargets = () => [quarry];
  k.inReachOfUs = () => [];
  let delegated = 0, directPulls = 0;
  k.pull = async () => { directPulls++; return { pulled: true, back: true }; };
  k.handleOutOfReachQuarry = async (f, found) => {
    delegated++;
    if (f.foe_id !== quarry.id || found[0] !== quarry)
      throw new Error('shared handler did not receive the exact selected quarry');
    return { handled: true, mode: 'wall', pulled: true };
  };
  // fight() reported out_of_reach: nothing matching within melee reach while holding.
  k._btFarmFight = async () => ({ out_of_reach: true, foe_id: 7573,
    nearest: { distance: 9.2 } });
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS (shared handler owns the pass), got ${r}`);
  if (delegated !== 1 || directPulls !== 0)
    throw new Error(`BT must delegate once and never pull directly: ${JSON.stringify({ delegated, directPulls })}`);
});

t('fightNode delegates open-field out_of_reach to the same shared handler', async () => {
  const k = mockKeeper({ hibernation: false });
  k.hold = null;
  k.holdWorks = () => false;
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 7573, nameRsc: 'centipede' }];
  k.inReachOfUs = () => [];
  let delegated = 0, directPulls = 0, directAdvances = 0, args = null;
  k.pull = async () => { directPulls++; return { pulled: true, back: true }; };
  k.advanceOnOpenFieldQuarry = async () => { directAdvances++; return { advanced: true }; };
  k.handleOutOfReachQuarry = async (f, found) => {
    delegated++;
    args = { f, found };
    return { handled: true, mode: 'open-field', advanced: true };
  };
  k._btFarmFight = async () => ({ out_of_reach: true, foe_id: 7573,
    nearest: { distance: 6.0 } });
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (delegated !== 1 || directPulls !== 0 || directAdvances !== 0 ||
      args?.found?.[0]?.id !== 7573 || args?.f?.foe_id !== 7573)
    throw new Error(`open-field handling was not delegated exactly once: ${JSON.stringify({
      delegated, directPulls, directAdvances, args,
    })}`);
});

t('fightNode delegates policy-off stale-hold handling instead of choosing pull itself', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.useSafeSpots = false;
  k.hold = { col: 5, row: 5, proven: true };
  k.policy.hunt = 'giant rat';
  const quarry = { id: 7573, nameRsc: 'centipede' };
  k._btFarmFoundTargets = () => [quarry];
  k.inReachOfUs = () => [];
  let pulled = 0, advanced = 0, delegated = 0;
  k.pull = async () => { pulled++; return { pulled: true, back: true }; };
  k.advanceOnOpenFieldQuarry = async () => { advanced++; return { advanced: true }; };
  k.handleOutOfReachQuarry = async (f, found) => {
    if (f.foe_id !== quarry.id || found[0] !== quarry)
      throw new Error('wrong quarry passed to shared handler');
    delegated++;
    return { handled: true, mode: 'open-field', advanced: true };
  };
  k._btFarmFight = async () => ({ out_of_reach: true,
    foe_id: quarry.id, nearest: { distance: 9.2 } });
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
  if (pulled !== 0 || advanced !== 0 || delegated !== 1)
    throw new Error(`BT must leave stale-hold mode selection to the shared handler: ${JSON.stringify({
      pulled, advanced, delegated,
    })}`);
});

t('fightNode fails closed when the shared out-of-reach handler is unavailable', async () => {
  const k = mockKeeper({ hibernation: false });
  k.policy.hunt = 'giant rat';
  k._btFarmFoundTargets = () => [{ id: 7573, nameRsc: 'centipede' }];
  k.inReachOfUs = () => [];
  let pulled = 0, advanced = 0;
  k.pull = async () => { pulled++; return { pulled: true, back: true }; };
  k.advanceOnOpenFieldQuarry = async () => { advanced++; return { advanced: true }; };
  k._btFarmFight = async () => ({ out_of_reach: true, foe_id: 7573,
    nearest: { distance: 9.2 } });
  const node = fightNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS || pulled !== 0 || advanced !== 0 ||
      !k.calls.some(call => call[0] === 'noProgress' && /no safe shared/.test(call[1])))
    throw new Error(`missing handler must cause no mutation: ${JSON.stringify({ r, pulled, advanced, calls: k.calls })}`);
});

// ---------------------------------------------------------------------------
// Scavenge node
// ---------------------------------------------------------------------------

t('scavengeNode: FAILURE when armed', async () => {
  const k = mockKeeper({ armed: () => true });
  k._btFarmFoundTargets = () => [];
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('scavengeNode: SUCCESS when hunt targets exist but we are unarmed', async () => {
  const k = mockKeeper({ armed: () => false });
  k._btFarmFoundTargets = () => [{ id: 1, nameRsc: 'fungus beast' }];
  k.s.client.vitals = () => ({ health: { value: 30, max: 30 }, vigor: { value: 140 } });
  k.s.client.rsc = { get: () => 'ant' };
  const weakCreature = { id: 50, nameRsc: 'ant', health: { value: 8, max: 8 } };
  k.constructor = { _combatSkills: {
    findCreature: () => [weakCreature],
    fight: async () => ({ ok: true, killed: true, xp: 1 }),
  }};
  k.takeSafeSpot = async () => ({ took: false });
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS (scavenge ant while fungus beast present), got ${r}`);
});

t('scavengeNode: FAILURE when no creatures in room', async () => {
  const k = mockKeeper({ armed: () => false });
  k._btFarmFoundTargets = () => [];
  // Mock the combat skills to return no creatures
  k.constructor = { _combatSkills: { findCreature: () => [], fight: async () => ({ ok: false }) } };
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE, got ${r}`);
});

t('scavengeNode: SUCCESS when it kills a weak creature', async () => {
  const k = mockKeeper({ armed: () => false });
  k._btFarmFoundTargets = () => [];
  k.s.client.vitals = () => ({ health: { value: 30, max: 30 }, vigor: { value: 140 } });
  k.s.client.rsc = { get: () => 'rat' };
  const weakCreature = { id: 100, nameRsc: 'rat', health: { value: 5, max: 5 } };
  k.constructor = { _combatSkills: {
    findCreature: () => [weakCreature],
    fight: async () => ({ ok: true, killed: true, xp: 2 }),
  }};
  k.takeSafeSpot = async () => ({ took: false });
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== SUCCESS) throw new Error(`expected SUCCESS, got ${r}`);
});

t('scavengeNode does not hold position for a stale hold when safe spots are disabled', async () => {
  const k = mockKeeper({ armed: () => false });
  k.policy.useSafeSpots = false;
  k.hold = { col: 5, row: 5, proven: true };
  k.atHold = () => true;
  k.holdWorks = () => true;
  k.s.client.vitals = () => ({ health: { value: 30, max: 30 }, vigor: { value: 140 } });
  k.s.client.rsc = { get: () => 'rat' };
  const weakCreature = { id: 100, nameRsc: 'rat', health: { value: 5, max: 5 } };
  let options = null;
  k.constructor = { _combatSkills: {
    findCreature: () => [weakCreature],
    fight: async (_session, given) => { options = given; return { ok: true, killed: true, xp: 2 }; },
  }};
  const r = await scavengeNode(k).tickAsync(bb(k));
  if (r !== SUCCESS || options?.holdPosition !== false)
    throw new Error(`policy-off stale hold leaked into scavenge fight: ${JSON.stringify({ r, options })}`);
});

t('scavengeNode: FAILURE when creature is too strong', async () => {
  const k = mockKeeper({ armed: () => false });
  k._btFarmFoundTargets = () => [];
  k.s.client.vitals = () => ({ health: { value: 30, max: 30 }, vigor: { value: 140 } });
  k.s.client.rsc = { get: () => 'dragon' };
  // 50 max hp > 30 * 1.5 = 45, so too strong
  const strongCreature = { id: 200, nameRsc: 'dragon', health: { value: 50, max: 50 } };
  k.constructor = { _combatSkills: {
    findCreature: () => [strongCreature],
    fight: async () => ({ ok: false }),
  }};
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE (too strong), got ${r}`);
});

t('scavengeNode: FAILURE when too hurt to fight', async () => {
  const k = mockKeeper({ armed: () => false });
  k._btFarmFoundTargets = () => [];
  // HP at 30%, below engageAt of 75%
  k.s.client.vitals = () => ({ health: { value: 9, max: 30 }, vigor: { value: 140 } });
  k.s.client.rsc = { get: () => 'rat' };
  const weakCreature = { id: 300, nameRsc: 'rat', health: { value: 5, max: 5 } };
  k.constructor = { _combatSkills: {
    findCreature: () => [weakCreature],
    fight: async () => ({ ok: true, killed: true }),
  }};
  k.safety = () => ({ engageAt: 0.75, fleeAt: 0.3 });
  const node = scavengeNode(k);
  const r = await node.tickAsync(bb(k));
  if (r !== FAILURE) throw new Error(`expected FAILURE (too hurt), got ${r}`);
});

// ---------------------------------------------------------------------------

run();
