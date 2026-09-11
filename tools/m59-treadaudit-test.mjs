#!/usr/bin/env node
// CAN THE TREAD AUDIT CALL AN EXCLUSIVE CAP "CALIBRATED"?
//
//   node tools/m59-treadaudit-test.mjs
//
// Offline. No map, no bake, no socket — the reading rule is a pure function of the tallies and
// this pins it there, because the whole value of the tool is the verdict and a verdict that is
// wrong in the reassuring direction is worse than no tool.
import { riseBucket, bucketOrder, calibration } from './m59-treadaudit.mjs';
import { MAX_STEP_HEIGHT } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const CAP = MAX_STEP_HEIGHT;
const EXACT = `${CAP} (exact)`;

console.log('\nthe exact cap gets its OWN bucket, or the signal is averaged away');
{
  ok('384 is its own bucket', riseBucket(384) === EXACT);
  ok('383 is not', riseBucket(383) !== EXACT);
  ok('and 383 lands in the band just below', riseBucket(383) === '319-383');
  ok('385 is not a legal upward tread at all', riseBucket(385) === null);
  ok('nor is a descent', riseBucket(-100) === null);
  ok('nor is level ground', riseBucket(0) === null);
  ok('a 1-unit rise is the smallest bucket', riseBucket(1) === '1-128');
  ok('bucketOrder ends with the exact bucket, beside its neighbour',
     bucketOrder().at(-1) === EXACT && bucketOrder().at(-2) === '319-383',
     'they have to be adjacent in the report or the comparison is not visible');
  ok('every bucket the bucketer can return is in the order list',
     [1, 100, 200, 300, 350, 383, 384].every(r => bucketOrder().includes(riseBucket(r))));
}

console.log('\nAN EXCLUSIVE CAP IS THE THING THIS MUST NEVER MISS');
{
  const t = {
    '1-128': { tried: 200, refused: 30 },
    '129-253': { tried: 400, refused: 40 },
    '254-318': { tried: 150, refused: 45 },
    [EXACT]: { tried: 1900, refused: 1900 },      // every single one refused
  };
  const c = calibration(t);
  ok('100% refusal at the cap is called EXCLUSIVE CAP', c.verdict === 'EXCLUSIVE CAP');
  ok('and it names the cause', /< rather than <=/.test(c.why));
}

console.log('\nand a rate merely HIGH is SUSPECT rather than waved through');
{
  const t = {
    '1-128': { tried: 200, refused: 20 },         // 10%
    '129-253': { tried: 400, refused: 40 },       // 10%
    [EXACT]: { tried: 1900, refused: 1425 },      // 75%, 7.5x the worst other
  };
  ok('a rate far above the others is SUSPECT', calibration(t).verdict === 'SUSPECT');
}

console.log('\nthe measured room 515 shape reads as CALIBRATED');
{
  // The real tallies, 2026-09-10, lattice step 256.
  const t = {
    '1-128': { tried: 224, refused: 36 },         // 16.1%
    '129-253': { tried: 421, refused: 43 },       // 10.2%
    '254-318': { tried: 156, refused: 47 },       // 30.1%
    [EXACT]: { tried: 1932, refused: 273 },       // 14.1%
  };
  const c = calibration(t);
  ok('room 515 reads CALIBRATED', c.verdict === 'calibrated',
     'the mover accepts 85.9% of exact-384 treads, so its step rule is not the defect there');
  ok('and the verdict says the refusals are geometry', /geometry, not the step rule/.test(c.why));
  ok('the rate is reported', c.rate > 0.14 && c.rate < 0.142);
}

console.log('\nit refuses to conclude rather than guessing');
{
  ok('no exact-cap treads is "no data", not a pass',
     calibration({ '1-128': { tried: 50, refused: 5 } }).verdict === 'no data');
  ok('an empty room is "no data" too', calibration({}).verdict === 'no data');
  ok('a lone exact bucket with nothing to compare is INCONCLUSIVE',
     calibration({ [EXACT]: { tried: 100, refused: 20 } }).verdict === 'inconclusive',
     'a rate means nothing without a neighbouring band to read it against');
  ok('and a bucket too small to compare is ignored rather than trusted',
     calibration({ '1-128': { tried: 3, refused: 3 }, [EXACT]: { tried: 100, refused: 20 } })
       .verdict === 'inconclusive');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
