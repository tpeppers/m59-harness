#!/usr/bin/env node
// VITALS ARE `{ value, max }`, AND READING THEM AS TWO NUMBERS FAILS SILENTLY.
//
// This is the guard for the mistake that killed eleven characters in fifteen minutes on one
// Tos -> Castle Victoria walk. `rideTrack`'s shelter rest — sit down on a square something
// measured as hard to reach, when hurt — was written as:
//
//     const hp = vit.health, max = vit.maxHealth;
//     if (Number.isFinite(hp) && Number.isFinite(max) && ...)
//
// `vit.health` is an OBJECT, so `Number.isFinite` is false; `vit.maxHealth` does not exist,
// so `max` is undefined. The condition could never be true. The feature never ran once, and
// `onTrackRest` honestly reported zero shelter stops for as long as it existed — a counter
// reading zero because the feature is dead, not because the road is clean.
//
// THE SAME MISTAKE LANDED THREE TIMES IN ONE FUNCTION, which is why this test guards a shared
// reader rather than one call site. The third instance survived the first fix: the success
// counter compared an OBJECT to a number (`(c.vitals().health ?? before) > before`), so even
// with the rest working its own telemetry still said zero. An instrument that reports failure
// when the thing works is worse than no instrument.
//
// Offline: no socket, no roster, no map. `readHealth` is a pure function.
// FROM m59-parse, NOT m59-game: importing m59-game builds the route table at load, and a
// test that imports it inherits that state. That side effect silently changed an unrelated
// door-crossing assertion in m59-collision-test when this reader briefly lived there.
import { readHealth } from './m59-parse.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log('  FAIL ' + what); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what}: expected ${b}, got ${a}`);

console.log('the real client shape');
{
  // Exactly what client.vitals() answers.
  const v = { health: { value: 42, max: 50 }, mana: { value: 5, max: 9 } };
  const { hp, max, frac } = readHealth(v);
  eq(hp, 42, 'hp comes off health.value');
  eq(max, 50, 'max comes off health.max');
  ok(Math.abs(frac - 0.84) < 1e-9, 'frac is value/max');
  // THE ASSERTION THIS FILE EXISTS FOR: the numbers must be NUMBERS. The old code bound an
  // object here and every downstream test of it failed closed.
  ok(Number.isFinite(hp) && Number.isFinite(max), 'both reads are finite — the original bug');
  ok(typeof hp !== 'object', 'hp is never the health object itself');
}

console.log('the comparisons the old code got wrong');
{
  const v = { health: { value: 42, max: 50 } };
  const before = 30;
  // Instance 3: the success counter. `obj > n` is false for every obj and every n.
  ok(((v.health ?? before) > before) === false, 'object > number is false — why rested++ never ran');
  ok(readHealth(v).hp > before, 'through the reader it compares correctly');
  // Instance 1: the entry guard.
  ok(Number.isFinite(v.health) === false, 'Number.isFinite on the object is false — why the guard never fired');
  ok(Number.isFinite(readHealth(v).hp), 'through the reader the guard can fire');
  // Instance 2: the poll broke out on its first pass.
  ok(Number.isFinite(v.health?.value ?? v.health), 'the poll needs .value, not .health');
}

console.log('the flat shape some callers pass');
{
  // A roster row rather than a client's vitals. Accepted on purpose — refusing it would move
  // the breakage rather than remove it.
  const { hp, max, frac } = readHealth({ health: 20, maxHealth: 40 });
  eq(hp, 20, 'flat health is taken as a number');
  eq(max, 40, 'maxHealth is the fallback for max');
  eq(frac, 0.5, 'frac works on the flat shape too');
}

console.log('it refuses rather than lies');
{
  eq(readHealth(undefined).hp, null, 'no vitals at all is null, not a throw');
  eq(readHealth({}).hp, null, 'no health key is null');
  eq(readHealth({}).frac, null, 'no fraction without both halves');
  eq(readHealth({ health: { value: 5, max: 0 } }).frac, null, 'max 0 does not divide by zero');
  eq(readHealth({ health: { value: 5 } }).max, null, 'value without max gives no max');
  eq(readHealth({ health: { max: 5 } }).hp, null, 'max without value gives no hp');
  // A fraction of exactly 0 is a real answer and must not be confused with "no reading".
  eq(readHealth({ health: { value: 0, max: 50 } }).frac, 0, 'zero health is a reading, not an absence');
  ok(readHealth({ health: { value: 0, max: 50 } }).hp === 0, 'hp 0 survives the nullish checks');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
