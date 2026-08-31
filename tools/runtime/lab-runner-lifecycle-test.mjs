import assert from 'node:assert/strict';

import {
  publicRuntimeFailure,
  publicStartupFailure,
  watchRuntimeFailure,
} from './lab-runner-lifecycle.mjs';

let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

const handlers = new Set();
const runtime = {
  on(event, handler) {
    assert.equal(event, 'failure');
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};
const delivered = [];
const unsubscribe = watchRuntimeFailure(runtime, value => delivered.push(value));
for (const handler of handlers)
  handler({ code: 'M59_SHARD_EXITED', shard_id: 'shard-2', message: 'password=secret' });
for (const handler of handlers)
  handler({ code: 'M59_SHARD_DISCONNECTED', shard_id: 'shard-2' });
check(delivered, [{ code: 'M59_SHARD_EXITED', shard_id: 'shard-2' }],
  'the runner receives one sanitized terminal cause');
check(JSON.stringify(delivered).includes('secret'), false, 'terminal messages never cross the seam');
unsubscribe();
check(handlers.size, 0, 'the runner removes its lifecycle subscription');

check(publicRuntimeFailure({ code: 'bad code', shard_id: '../../bad' }), {
  code: 'M59_SHARD_RUNTIME_FAILED',
}, 'invalid runtime failure fields fail closed');
check(publicStartupFailure({
  id: 'alpha', code: 'M59_LOGIN_FAILED', shard_id: 'shard-1', message: 'private',
}), {
  id: 'alpha', code: 'M59_LOGIN_FAILED', shard_id: 'shard-1',
}, 'startup diagnostics contain only actor, code, and shard');
check(publicStartupFailure({ id: 'bad actor', error: { code: 'not safe' } }), {
  id: 'unknown', code: 'M59_SHARD_RUNTIME_FAILED',
}, 'malformed startup diagnostics are replaced rather than echoed');

console.log(`lab runner lifecycle: PASS (${assertions} assertions)`);
