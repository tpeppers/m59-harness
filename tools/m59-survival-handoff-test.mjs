// Offline regressions from the September 13 production deaths. No live session.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const evidence = mkdtempSync(path.join(tmpdir(), 'm59-survival-'));
process.env.M59_EVIDENCE_DIR = evidence;
process.env.M59_UPTIME_FILE = path.join(evidence, 'uptime.jsonl');
const { Autopilot, CONTINUE, HANDLED, PASS_STAGES } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const { sheltersAlong } = await import('./m59-safespots.mjs');
const {currentSurvivalDecision}=await import('./m59-survival-decision.mjs');

function keeper() {
  const k = Object.assign(Object.create(Autopilot.prototype), {
    policy: {}, tally: {}, claims: new Map(), passes: 1, notes: [], health: 20,
    book: { save() {} }, watch: { pulses: [], ticks: 0, frames: 0, lastPulseAt: Date.now() },
    note(what, detail) { this.notes.push({ what, detail }); },
    progress() {}, recordFrame() {}, ledgerEvent() {}, noProgress() {}, detailEvent() {},
    inertStatus() { return this.inert; }, who() { return null; },
    sanctuary() { return false; }, roomOutranksUs() { return true; },
    safety() { return { fleeAt: 0.7 }; }, armed() { return true; },
    tellPilot: async () => {}, holdWorks() { return false; },
    reconnect: async () => ({ ok: true }), answerWedge: async () => null,
    restBeforeSettingOut: async () => {}, travelHoldMode: () => 'off',
    hitDamageTotal: () => 0, fightBackCheck() {}, clearPathCheck() {},
    facultyHeld: () => false, pulsePosition() {},
    applyLoadoutPolicyOverlay() {}, declareInterest() {},
    observe() {}, noteToughness() {}, social: async () => {},
  });
  const c = {
    state: 'game', selfId: 1, self: { id: 1, col: 20, row: 20 }, inventory: [],
    room: { objects: new Map() },
    vitals: () => ({ health: { value: k.health, max: 50 }, vigor: { value: 80 } }),
    stats() {}, rest() {}, roomContents() {}, waitFor: async () => ({}),
  };
  k.s = { name: null, live: true, client: c, movementGeneration: 0,
    world: { room: { num: 584, name: 'The Flatlands' },
      route: () => ({ found: true, hops: [{ to: 585 }, { to: 714 }] }) },
    pacer: { submit: async (_lane, fn) => fn() }, need: () => c,
    movementWasCancelled(generation) { return generation !== this.movementGeneration; },
    cancelMovement() { this.movementGeneration++; return { cancelled: true }; },
  };
  return k;
}
const ctx = k => ({ s: k.s, c: k.s.client, room: k.s.world.room,
  v: k.s.client.vitals(), hp: k.health / 50 });

// The real travel method stays awaiting its mover while the real watchdog rescues it.
{
  const k = keeper();
  let tick, settle, moving;
  const entered = new Promise(resolve => { moving = resolve; });
  k.s.travel = async (_to, options) => {
    assert.equal(options.movementGeneration, 0);
    moving(); return new Promise(resolve => { settle = resolve; });
  };
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  globalThis.setInterval = fn => { tick = fn; return { unref() {} }; };
  globalThis.clearInterval = () => {};
  try {
    const trip = k.travel(714);
    await entered;
    assert.ok(k.inert?.travelling);
    const shelters = { spots: [{ row: 21, col: 21 }] };
    k.s.activeShelter = shelters;
    k.watch.wedged = { since: Date.now() - 60000, taking_hits: true,
      at: { room: 584, row: 20, col: 20 } };
    k.watchdogTick();
    assert.equal(k.inert, null, 'watchdog revokes the traveller');
    assert.equal(k.suspendedJourney.to, 714);
    assert.equal(k.s.activeShelter, shelters, 'recovery retains forward cover');
    tick();
    assert.equal(k.inert, null, 'lease timer cannot resurrect cancelled travel');
    assert.equal(k.suspendedJourney.to, 714);
    settle({ arrived: false, cancelled: true });
    await trip;
    const next = await k.travel(104);
    assert.equal(next.cancelled, true, 'the next shopping leg cannot steal the rescue');

    // A second journey in the same pass must have its own rescue allowance.
    k.goTravelling('new journey', { to: 39 });
    k.watchdogTick();
    assert.equal(k.inert, null);
    assert.equal(k.suspendedJourney.to, 39);
  } finally { globalThis.setInterval = interval; globalThis.clearInterval = clear; }
}

for (const monsters of [0, 1, 5, 6, 14]) {
  const k = keeper();
  for (let i = 0; i < monsters; i++) k.s.client.room.objects.set(i + 10,
    { id: i + 10, flags: OF.ATTACKABLE, col: 1, row: 1 });
  k.goTravelling('road shelter', { to: 39 });
  assert.equal(k.threatCountHere(), monsters);
  assert.equal(k.s.shelterPolicy.need(), true, 'crowds cannot veto route cover');
  k.policy.travelHoldPvp = 'ignore';
  assert.equal(k.travelHoldCandidate({ remaining: 1 }).candidate, true,
    'monster count cannot veto hop-boundary shelter');
  k.health = 50;
  assert.equal(k.s.shelterPolicy.need(), false, 'whole travellers still keep walking');
  k.health = 20;
  k.s.world.geometry = { rows: 64, cols: 64 };
  k.onwardExit = () => null;
  let searched = false;
  k.searchSafeSpot = (_g, _m, _r, opts) => {
    searched = true; assert.equal(opts.wallsAllowed, true); return null;
  };
  await k.takeSafeSpot('recovery', null, { source: 'travel' });
  assert.ok(searched, 'the actual recovery search is allowed to offer a wall');
}

{
  const k = keeper();
  // AT A WALL. Since 2026-09-18 `playDead` refuses the OPEN freeze against monsters, and this
  // case is about what a SUCCESSFUL freeze does to the pass rather than about when one is
  // allowed — so the geometry has to offer a wall for there to be a success to test. Stubbed
  // here rather than in `keeper()` because a fixture-wide wall changes what the failed-
  // selection cases below report.
  k.adoptRecoveryWall = () => true;
  k.timeToDeath = () => 9000; k.damageRate = () => 3;
  k.goTravelling('dying on the road', { to: 39 });
  const verdict = await k.passTravelling(ctx(k));
  assert.equal(verdict, HANDLED, 'a successful freeze ends this pass');
  assert.equal(k.inert, null);
  assert.equal(k.suspendedJourney.to, 39, 'monster damage suspends the destination');
  assert.ok(k.checkFreeze());
  assert.equal(k.tally.logoffs, 1);
  k.health--;
  k.watchdogTick();
  assert.equal(k.frozenUntil, null, 'the independent watchdog ends a damaged freeze');
  assert.match(k.wantsForwardShelter, /damage/);
  assert.ok(k.unreachableIn(584).has('20,20'), 'the damaged freeze square is skipped');
}

// Run the whole pass through a damaged stats wait, not just the freeze predicate.
{
  const k = keeper();
  k.s.world.room = null;
  k.adoptRecoveryWall = () => true;   // the freeze must land for the pass to be the subject
  await k.playDead('test');
  let ladderCalls = 0, rests = 0;
  k.runPassLadder = async () => { ladderCalls++; };
  k.s.client.rest = () => { rests++; };
  await k.pass();
  assert.equal(ladderCalls, 0);
  assert.equal(rests, 1);
  k.s.client.waitFor = async () => { k.health = 5; };
  await k.pass();
  assert.ok(k.notes.some(n=>n.what==='unfreezing'&&n.detail.why==='damage while playing dead'));
  assert.equal(k.tally.logoffs,2,'with no room geometry, the replacement logoff executes immediately');
  assert.ok(k.frozenUntil>Date.now(),'the replacement establishes a new freeze');
  assert.equal(ladderCalls, 0, 'the explicit replacement owns this pass before the ordinary ladder');
  assert.equal(currentSurvivalDecision(k.s).status, 'recovering', 'the replacement executes on this same pass');
  assert.equal(rests, 1, 'no extra frozen rest after the damage');
}

{
  const k = keeper();
  await k.playDead('test');
  k.s.client.self.row++;
  assert.equal(k.checkFreeze(), false, 'movement invalidates the grace period too');
}

{
  const k = keeper(), ran = [];
  for (const stage of PASS_STAGES) k[stage] = async () => {
    ran.push(stage);
    if (stage === 'passErrand') k.survivalInterruptedPass = k.passes;
    return CONTINUE;
  };
  await k.runPassLadder(ctx(k));
  assert.ok(!ran.includes('passFarm'), 'a rescued errand cannot fall into farming');
}
{
  const k = keeper();
  k.policy.guildWants = { enabled: true };
  k.reagentCount = () => ({ elderberry: 0, herbs: 0 });
  let withdrawals = 0, shops = 0;
  k.withdrawFromStockpile = async () => {
    withdrawals++; k.survivalInterruptedPass = k.passes;
    return { took: [], saved: 0 };
  };
  k.travel = async () => { shops++; return { arrived: false }; };
  await k.buyReagentsInTown();
  assert.equal(withdrawals, 1);
  assert.equal(shops, 0, 'the actual stockpile fallback yields to recovery');
}
// The entire shopping list survives two pauses, including the original approach
// and a later reagent detour. Completed purchases are not repeated.
{
  const k = keeper(), services = [];
  k.money = { trips: 0 };
  k.shoppingPlan = () => ({ lines: [], unpriced: [], required_purse: 0 });
  k.postShoppingPlan = () => {};
  k.leaveHold = async () => ({ left: true });
  k.townTrip = { target: { room: 114, hops: 3 }, nextService: -1 };
  k.travel = async () => {
    k.survivalInterruptedPass = k.passes;
    k.suspendedJourney = { to: 114 };
    return { arrived: false, paused: true };
  };
  assert.equal(await k.bankRun(), true);
  assert.equal(k.townTrip.nextService, -1, 'the shopping approach remains pending');
  k.s.world.room.num = 114;
  k.suspendedJourney = null; k.survivalInterruptedPass = null;
  k.townTrip.nextTryAt = 0;
  const methods = ['contributeGuildWants', 'sellInTown', 'guildTitheFromSale',
    'bankSurplus', 'ensurePurchaseFunds', 'restockInTown', 'buyFoodInTown',
    'buyReagentsInTown', 'buyFarmDeliveryCargo', 'vaultRunIfPassing'];
  let paused = false;
  for (const method of methods) k[method] = async () => {
    services.push(method);
    if (method === 'buyReagentsInTown' && !paused) {
      paused = true; k.survivalInterruptedPass = k.passes;
      k.suspendedJourney = { to: 714 };
    }
  };
  await k.bankRun();
  assert.equal(k.townTrip.nextService, 7, 'retry the interrupted purchase, not the whole trip');
  assert.deepEqual(services, methods.slice(0, 8));
  k.suspendedJourney = null; k.survivalInterruptedPass = null;
  assert.equal(await k.passErrand(ctx(k)), HANDLED);
  assert.equal(k.townTrip, null, 'shopping completes after recovery');
  assert.deepEqual(services, [...methods.slice(0, 8), ...methods.slice(7)]);
}
// Bunsen's live failure: break a rest, reconnect, immediately select the same
// geometric wall again. Recent local failure must survive that reconnect.
{
  const k = keeper();
  k.s.travel = async () => { throw new Error('mover failed'); };
  await assert.rejects(k.travel(39), /mover failed/);
  assert.equal(k.inert, null, 'a throwing journey returns its hold in finally');
  assert.equal(k.s.shelterPolicy, null);
}
{
  const k = keeper();
  k.hold = { room: 584, row: 20, col: 20 };
  k.book.failed = () => {};
  k.releaseHold = () => { k.hold = null; };
  k.takeSafeSpot = async () => {
    assert.ok(k.spotExclusions(584).has('20,20'));
    assert.equal(k.unreachableIn(585), null, 'the exclusion belongs to this room');
    return { took: false };
  };
  await k.restBroken(k.s.world.room, [{ id: 2 }]);
  assert.equal(k.hold, null);
  assert.equal(k.notes.at(-1).detail.got_a_wall, false, 'failed selection is not reported as shelter');
  k.goTravelling('resume shopping', { to: 39 });
  assert.ok(k.s.shelterPolicy.unreachable(584).has('20,20'), 'route planning shares recovery exclusions');
  k.failedRestSpots.get(584).set('20,20', Date.now() - 6 * 60 * 1000);
  assert.equal(k.unreachableIn(584), null, 'temporary failure expires');
  assert.equal(keeper().unreachableIn(584), null, 'another keeper does not inherit the failure');
}
{
  // Fine movement can cross this fake room; coarse attack LOS is blocked.
  const geo = { rows: 5, cols: 5,
    walkable: (r, c) => r >= 1 && r <= 5 && c >= 1 && c <= 5,
    canMove: (_r, _c, _r2, _c2, options) => !!options?.fine };
  const steps = [{ row: 3, col: 3 }];
  const first = sheltersAlong(geo, steps);
  assert.ok(first.length, 'fixture offers shelter');
  const key = `${first[0].col},${first[0].row}`;
  const next = sheltersAlong(geo, steps, { unreachable: new Set([key]) });
  assert.ok(next.length, 'an alternative shelter is still offered');
  assert.ok(next.every(s => `${s.col},${s.row}` !== key), 'route selector skips the failed rest square');
}
for (const monsters of [0, 1, 5, 6, 14])
for (const [refused, via] of [[false, null], [true, null], [false, 'exit'], [true, 'exit']]) {
  const k = keeper();
  for (let i = 0; i < monsters; i++) k.s.client.room.objects.set(i + 10,
    { id: i + 10, flags: OF.ATTACKABLE, col: 1, row: 1 });
  k.answerWedge = async () => ({ refused });
  k.crowdExit = { at: Date.now(), room: 584 };
  k.onwardExit = () => null;
  k.takeSafeSpot = async () => {
    k.hold = { room: via ? 585 : 584, row: 21, col: 21 }; return { took: true, via };
  };
  k.s.travel = async () => { assert.fail('a new mover must not walk away from recovery'); };
  k.townTrip = { target: { room: 714 }, nextService: 7 };
  k.goTravelling('shopping leg', { to: 714 });
  const result = await k.travel(714);
  assert.equal(result.sheltered, true);
  assert.equal(k.inert, null);
  assert.equal(k.suspendedJourney.to, 714);
  assert.equal(k.suspendedJourney.deaths_at, 0);
  assert.equal(k.hold.row, 21, 'the acquired wall remains held');
  assert.equal(k.townTrip.nextService, 7, 'the purchase remains pending');
  assert.equal(k.travelInterrupted(), true);
}
for (const monsters of [1, 14]) {
  const k = keeper();
  for (let i = 0; i < monsters; i++) k.s.client.room.objects.set(i + 10,
    { id: i + 10, flags: OF.ATTACKABLE, col: 1, row: 1 });
  k.answerWedge = async () => ({ refused: true, why: 'repeated wedge' });
  let attempts = 0;
  k.takeRecoverySpot = async () => {
    attempts++; return { took: false, why: 'no unoccupied refuge has a clear path' };
  };
  k.s.travel = async () => assert.fail('a refused wedge cannot start another mover');
  const result = await k.travel(714);
  assert.equal(attempts, 1, 'a wedge offers recovery even without a crowd or watchdog request');
  assert.equal(result.gave_up, true, 'removing the count gate cannot invent reachable cover');
  assert.equal(k.hold, undefined);
}
for (const forward of [true, false]) {
  const k = keeper();
  k.policy.restBelow = 0.95;
  k.policy.panicLogoff = false;
  k.escapeIfWedgedAndHurt = k.tradeInPlaceIfWedged = k.defensiveAnswer = async () => false;
  k.wantsForwardShelter = forward ? 'watchdog recovery' : null;
  let attempts = 0;
  const interruptedWalk = async () => {
    attempts++; k.survivalInterruptedPass = k.passes; k.s.cancelMovement(); return false;
  };
  k.shelterForwardAndMend = interruptedWalk;
  k.takeSafeSpot = interruptedWalk;
  k.travel = async () => assert.fail('cancelled recovery must not fall through to an exit');
  assert.equal(await k.passFleeAndRest(ctx(k)), HANDLED);
  assert.equal(attempts, 1, 'one cancelled recovery does not start another walk in the same pass');
}
{
  const k = keeper();
  k.s.world.geometry = { rows: 64, cols: 64 };
  let searches = 0;
  k.searchSafeSpot = () => { searches++; return { kind: 'exit', row: 20, col: 21, steps_away: 1 }; };
  k.s.travel = async () => {
    k.s.cancelMovement(); k.s.world.room = { num: 585 };
    return { arrived: true };
  };
  const result = await k.takeSafeSpot('recover across exit', null, { destination: 714 });
  assert.equal(result.cancelled, true);
  assert.equal(searches, 1, 'a cancelled crossing cannot start another far-side shelter walk');
  k.survivalInterruptedPass = k.passes;
  assert.equal((await k.takeSafeSpot('retry')).cancelled, true);
  assert.equal(searches, 1, 'an interrupted pass cannot start another shelter attempt');
}
console.log('survival handoff regressions passed (travel, crowd, freeze, ladder, shopping, failed rest, wedge, recovery cancellation)');
