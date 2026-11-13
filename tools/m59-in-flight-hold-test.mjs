#!/usr/bin/env node
// ONE DIRECTIONAL DECISION PER BODY: A RUNG STILL WALKING HOLDS EVERY DIRECTIONAL RUNG.
//
//   node tools/m59-in-flight-hold-test.mjs
//
// Offline. Drives the REAL `Autopilot.prototype.runPassLadder` and `runStageBounded` with the
// stage methods swapped for recorders, as m59-passorder-test.mjs does.
//
// PROD 2026-10-27, the Ko'catan East Tower (2013). `passErrand` overran its 30s ladder deadline
// while a town trip (`keeper:sell_circuit`, `keeper:food_shopping`) walked toward the SW door to
// 2000. The ladder abandoned the WAIT, as designed, then skipped `passErrand` as in flight on the
// next pass and carried on down to `passFarm` -- whose hunt relocation / station return set off
// for the NE door to 2115 on the same body, with the same movement generation. 94 of the 100
// departures from 2013 that ended `route_progressing_exits_exhausted` that day (to 15:30Z)
// overlapped another keeper journey on the same character; the two walkers dragged the body off
// each other's doorways (m59-kocatan-door-test.mjs replays the refusals). The survival rungs keep
// running every pass; what waits is the directional half.
import { Autopilot, PASS_STAGES, CONTINUE, HANDLED, DIRECTIONAL_STAGES, inFlightHoldMs }
  from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

function harness() {
  const calls = [], notes = [];
  const ap = Object.create(Autopilot.prototype);
  for (const stage of PASS_STAGES) ap[stage] = async () => { calls.push(stage); return CONTINUE; };
  ap.note = (what, detail) => notes.push({ what, detail });
  ap.tally = {};
  return { ap, calls, notes };
}
const runLadder = ap =>
  Autopilot.prototype.runPassLadder.call(ap, { s: null, c: null, room: null, v: null, hp: null });
const SURVIVAL = PASS_STAGES.slice(0, PASS_STAGES.indexOf('passFleeAndRest') + 1);
// A rung that walks until released: a town trip, a relocation, a retreat.
function walking(ap, calls, stage) {
  let release;
  const done = new Promise(r => { release = r; });
  ap[stage] = async () => { calls.push(stage); await done; return HANDLED; };
  // Arrived: the rung settles, and the next time it is asked it has nothing to do.
  return async () => {
    release(); await done; await new Promise(r => setTimeout(r, 10));
    ap[stage] = async () => { calls.push(stage); return CONTINUE; };
  };
}
const settle = () => new Promise(r => setTimeout(r, 10));

console.log('\nwhich rungs wait');
{
  ok('the directional rungs are everything below passFleeAndRest',
     DIRECTIONAL_STAGES[0] === 'passCooperative' && DIRECTIONAL_STAGES.at(-1) === 'passFarm'
     && DIRECTIONAL_STAGES.length === PASS_STAGES.length - SURVIVAL.length);
  ok('and none of the survival rungs is one of them', SURVIVAL.every(s => !DIRECTIONAL_STAGES.includes(s)));
  ok('the hold lasts thirty minutes by default', inFlightHoldMs({}) === 30 * 60_000);
  ok('M59_IN_FLIGHT_HOLD_MS=0 restores the old ladder, for a bisect', inFlightHoldMs({ M59_IN_FLIGHT_HOLD_MS: '0' }) === 0);
  ok('and an unusable override keeps the committed value',
     inFlightHoldMs({ M59_IN_FLIGHT_HOLD_MS: 'soon' }) === 30 * 60_000);
}

console.log('\na town trip still walking holds the farm (the East Tower)');
{
  const { ap, calls, notes } = harness();
  const finishTrip = walking(ap, calls, 'passErrand');
  process.env.M59_STAGE_DEADLINE_MS = '30';
  ok('the town trip overruns the ladder deadline', await runLadder(ap) === 'passErrand');
  calls.length = 0;
  const decided = await runLadder(ap);
  ok('the next pass still runs every survival rung',
     JSON.stringify(calls) === JSON.stringify(SURVIVAL));
  ok('does not start the town trip again', !calls.includes('passErrand'));
  ok('and does NOT start the farm -- no hunt relocation walking the other way', !calls.includes('passFarm'));
  ok('nor any other directional rung', !calls.some(s => DIRECTIONAL_STAGES.includes(s)));
  ok('the pass is decided by the rung that holds the body', decided === 'passErrand');
  ok('the hold is counted', ap.tally.stage_held_by_in_flight >= 1);
  ok('and said once, naming who holds and who waits',
     notes.filter(x => /still walking this body/.test(x.what)).length === 1
     && notes.find(x => /still walking this body/.test(x.what)).detail.in_flight === 'passErrand');
  calls.length = 0;
  await runLadder(ap);
  ok('a third pass says nothing new', notes.filter(x => /still walking this body/.test(x.what)).length === 1);
  await finishTrip();
  calls.length = 0;
  await runLadder(ap);
  ok('once the trip settles the farm runs again', calls.includes('passFarm'));
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\nthe other way round: a farm walk still in flight holds the errands above it');
{
  const { ap, calls } = harness();
  const finish = walking(ap, calls, 'passFarm');
  process.env.M59_STAGE_DEADLINE_MS = '30';
  await runLadder(ap);
  calls.length = 0;
  await runLadder(ap);
  ok('survival runs', SURVIVAL.every(s => calls.includes(s)));
  ok('no town trip starts on top of the relocation', !calls.includes('passErrand'));
  await finish();
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\na survival rung in flight holds the directional rungs, never the survival ones');
{
  const { ap, calls } = harness();
  const finish = walking(ap, calls, 'passArm');
  process.env.M59_STAGE_DEADLINE_MS = '30';
  await runLadder(ap);
  calls.length = 0;
  await runLadder(ap);
  ok('passFleeAndRest still gets its turn below the stuck rung', calls.includes('passFleeAndRest'));
  ok('passArm is not invoked twice', !calls.includes('passArm'));
  ok('and nothing directional starts', !calls.some(s => DIRECTIONAL_STAGES.includes(s)));
  await finish();
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\na rung in flight for longer than the hold is presumed hung');
{
  const { ap, calls, notes } = harness();
  const finish = walking(ap, calls, 'passErrand');
  process.env.M59_STAGE_DEADLINE_MS = '30';
  await runLadder(ap);
  ap.stageFlightStartedAt.set('passErrand', Date.now() - 31 * 60_000);
  calls.length = 0;
  await runLadder(ap);
  ok('the farm runs again rather than idling for ever behind a hung promise', calls.includes('passFarm'));
  ok('the hung rung is still not invoked twice', !calls.includes('passErrand'));
  ok('and the keeper says why', notes.some(x => /too long to be walking/.test(x.what)));
  await finish();
  delete process.env.M59_STAGE_DEADLINE_MS;
}

console.log('\nM59_IN_FLIGHT_HOLD_MS=0 is the old ladder exactly');
{
  const { ap, calls } = harness();
  const finish = walking(ap, calls, 'passErrand');
  process.env.M59_STAGE_DEADLINE_MS = '30';
  process.env.M59_IN_FLIGHT_HOLD_MS = '0';
  await runLadder(ap);
  calls.length = 0;
  await runLadder(ap);
  ok('the farm starts under the walking town trip, as it used to', calls.includes('passFarm'));
  await finish();
  delete process.env.M59_STAGE_DEADLINE_MS;
  delete process.env.M59_IN_FLIGHT_HOLD_MS;
}

console.log('\nnothing in flight, nothing held');
{
  const { ap, calls, notes } = harness();
  await runLadder(ap);
  ok('every rung runs in order', JSON.stringify(calls) === JSON.stringify(PASS_STAGES));
  ok('and nothing is said', notes.length === 0);
  await settle();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
