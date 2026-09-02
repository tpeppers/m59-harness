#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  RuntimeProfileError,
  assertTimeScaleAllowed,
  createRuntimeProfile,
  runtimeProfileFromEnv,
} from './runtime-profile.mjs';

let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

{
  const profile = createRuntimeProfile();
  check(profile.name, 'legacy');
  check(profile.timeScale, 1);
  check(profile.accelerated, false);
  check(Object.isFrozen(profile), true);
}

{
  const profile = createRuntimeProfile('prod');
  check(profile.production, true);
  check(profile.timeScale, 1);
  check(createRuntimeProfile('production').name, 'prod');
  assert.throws(() => createRuntimeProfile({ name: 'prod', timeScale: 10 }), error =>
    error instanceof RuntimeProfileError && /requires timeScale=1/.test(error.message));
  assertions++;
  assert.throws(() => assertTimeScaleAllowed(profile, 0.5), /requires timeScale=1/);
  assertions++;
  check(assertTimeScaleAllowed(profile, 1), 1);
}

{
  const lab = createRuntimeProfile({ name: 'lab', timeScale: '10' });
  check(lab.lab, true);
  check(lab.timeScale, 10);
  check(lab.scaled, true);
  check(lab.accelerated, true);
  check(assertTimeScaleAllowed(lab, 2.5), 2.5);

  const legacy = createRuntimeProfile({ name: 'legacy', timeScale: 2 });
  check(legacy.name, 'legacy');
  check(legacy.timeScale, 2, 'legacy defaults to 1 but remains usable for test canaries');
}

{
  const fromEnv = runtimeProfileFromEnv({ M59_RUNTIME_PROFILE: 'lab', M59_TIME_SCALE: '5' });
  check(fromEnv.name, 'lab');
  check(fromEnv.timeScale, 5);
  const overridden = runtimeProfileFromEnv(
    { M59_RUNTIME_PROFILE: 'lab', M59_TIME_SCALE: '5' },
    { name: 'prod', timeScale: 1 },
  );
  check(overridden.name, 'prod');
  check(overridden.timeScale, 1);
}

for (const bad of [0, -1, Infinity, 'nope']) {
  assert.throws(() => createRuntimeProfile({ name: 'lab', timeScale: bad }), RuntimeProfileError);
  assertions++;
}
assert.throws(() => createRuntimeProfile('mystery'), /unknown runtime profile/); assertions++;
assert.throws(() => runtimeProfileFromEnv(null), /env must be an object/); assertions++;

console.log(`runtime profile: ${assertions} assertions passed`);
