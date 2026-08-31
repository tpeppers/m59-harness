import assert from 'node:assert/strict';

import { createShardChildShutdown } from './child-shutdown.mjs';

let assertions = 0;
const check = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message);
};

// A fulfilled-but-failed actor teardown must close IPC/resolve the child main loop,
// but its referenced hard-exit watchdog stays armed so leaked sockets cannot survive.
{
  const timers = [];
  const exits = [];
  let clears = 0;
  let closes = 0;
  let terminals = 0;
  const processTarget = {
    exitCode: 0,
    exit(code) { exits.push(code); },
  };
  const shutdown = createShardChildShutdown({
    stop: async () => ({ ok: false, failed: 1 }),
    close: () => { closes++; },
    resolveTerminal: () => { terminals++; },
    processTarget,
    setTimer(fn) { timers.push(fn); return { id: timers.length }; },
    clearTimer() { clears++; },
  });
  const first = shutdown('failed teardown');
  check(shutdown('again'), first, 'shutdown is idempotent');
  check(await first, { ok: false, failed: 1 }, 'failed stop result is retained');
  check(processTarget.exitCode, 1, 'failed teardown sets a failing process status');
  check([closes, terminals, clears], [1, 1, 0],
    'IPC closes once while the hard-exit watchdog remains armed');
  timers[0]();
  check(exits, [1], 'the retained watchdog terminates a child with leaked handles');
}

// A clean teardown cancels the hard-exit fallback after closing the control channel.
{
  let clears = 0;
  let closes = 0;
  let terminals = 0;
  const exits = [];
  const processTarget = { exitCode: 0, exit: code => exits.push(code) };
  const shutdown = createShardChildShutdown({
    stop: async () => ({ ok: true }),
    close: () => { closes++; },
    resolveTerminal: () => { terminals++; },
    processTarget,
    setTimer: () => ({ id: 1 }),
    clearTimer: () => { clears++; },
  });
  check(await shutdown('clean stop'), { ok: true }, 'clean stop result is retained');
  check([processTarget.exitCode, closes, terminals, clears, exits.length], [0, 1, 1, 1, 0],
    'clean teardown cancels the fallback and exits normally');
}

console.log(`shard child shutdown: PASS (${assertions} assertions)`);
