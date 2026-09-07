import assert from 'node:assert/strict';
import { preserveDoorVariants } from './m59-routebake.mjs';
import { STEP_MASK_VERSION } from './m59-roo.mjs';
const baseline = { room: 951, rows: 42, cols: 30, security: 123, stepMask: 'same mask' };
const prior = { ...baseline, stepMaskVariantVersion: STEP_MASK_VERSION,
  stepMaskVariants: { 'sector3@356': { sectors: [{ id: 3, index: 1, floor: 100 }], mask: 'open' } } };
const next = { ...baseline, routes: { corrected: true } };
assert.deepEqual(preserveDoorVariants(next, prior, { sameGeometry: true }).stepMaskVariants,
  prior.stepMaskVariants, 'correcting routes preserves the compatible open-door masks');
for (const changed of [{ stepMask: 'new predicate' }, { security: 456 }, { rows: 43 }])
  assert.equal(preserveDoorVariants({ ...next, ...changed }, prior,
    { sameGeometry: true }).stepMaskVariants, undefined);
assert.equal(preserveDoorVariants(next, prior).stepMaskVariants, undefined);
assert.equal(preserveDoorVariants(next, { ...prior, stepMaskVariantVersion: -1 },
  { sameGeometry: true }).stepMaskVariants, undefined);
console.log('route rebuilds preserve compatible door states and reject stale ones');
