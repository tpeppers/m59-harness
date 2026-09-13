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

{
  const k = keeper();
  for (let i = 0; i < 8; i++) k.s.client.room.objects.set(i + 10,
    { id: i + 10, flags: OF.ATTACKABLE, col: 1, row: 1 });
  k.goTravelling('crowded road', { to: 39 });
  assert.equal(k.crowded(), true);
  assert.equal(k.s.shelterPolicy.need(), true, 'crowds cannot veto route cover');
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
}

// Run the whole pass through a damaged stats wait, not just the freeze predicate.
{
  const k = keeper();
  k.s.world.room = null;
  await k.playDead('test');
  let ladderCalls = 0, rests = 0;
  k.runPassLadder = async () => { ladderCalls++; };
  k.s.client.rest = () => { rests++; };
  await k.pass();
  assert.equal(ladderCalls, 0);
  assert.equal(rests, 1);
  k.s.client.waitFor = async () => { k.health = 5; };
  await k.pass();
  assert.equal(k.frozenUntil, null);
  assert.equal(ladderCalls, 1, 'damage returns control to survival on the same pass');
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
console.log('survival handoff regressions passed (travel, crowd, freeze, ladder, shopping)');
