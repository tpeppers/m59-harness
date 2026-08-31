#!/usr/bin/env node
// Offline, deterministic keepalive timing and wire invariants.
//
//   node tools/m59-client-keepalive-test.mjs

import assert from 'node:assert/strict';

import { AP, BP, M59Client } from './m59-client.mjs';

const HEADER = 7;

class FakeClock {
  constructor(startMs = 0) {
    this.time = startMs;
    this.nextId = 1;
    this.timers = new Map();
    this.clearedCallbacks = [];
    this.setCalls = 0;
    this.clearCalls = 0;
  }

  now() { return this.time; }

  setTimeout(callback, delayMs) {
    this.setCalls++;
    const handle = {
      id: this.nextId++,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    this.timers.set(handle, {
      at: this.time + Math.max(0, Number(delayMs) || 0),
      callback,
      id: handle.id,
    });
    return handle;
  }

  clearTimeout(handle) {
    const timer = this.timers.get(handle);
    if (timer) {
      this.clearCalls++;
      this.clearedCallbacks.push(timer.callback);
    }
    this.timers.delete(handle);
  }

  fireLastCleared() { this.clearedCallbacks.at(-1)?.(); }

  jumpBy(deltaMs) { this.time += deltaMs; }

  runNextDue() {
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.time)
      .sort((a, b) => a[1].at - b[1].at || a[1].id - b[1].id)[0];
    if (!due) return false;
    const [handle, timer] = due;
    this.timers.delete(handle);
    timer.callback();
    return true;
  }

  get pendingCount() { return this.timers.size; }

  get nextAt() {
    return this.timers.size
      ? Math.min(...[...this.timers.values()].map(timer => timer.at))
      : null;
  }

  advanceBy(deltaMs) {
    const target = this.time + deltaMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].id - b[1].id)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

function fixture(clock, { failWrites = false, state = 'game' } = {}) {
  const writes = [];
  const client = new M59Client({
    verbose: false,
    resources: new Map(),
    keepaliveClock: clock,
  });
  client.state = state;
  client.epoch = 7;
  client.seeds = [11, 22, 33, 44, 55];
  client.sock = {
    write(bytes) {
      if (failWrites) throw new Error('synthetic closed socket');
      writes.push(Buffer.from(bytes));
      return true;
    },
  };
  return { client, writes };
}

const opcode = frame => frame.readUInt8(HEADER);

console.log('one idle deadline replaces the fixed interval');
{
  const clock = new FakeClock(1000);
  const { client, writes } = fixture(clock);
  client.startKeepalive(100);
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 1100);
  assert.equal(client.keepaliveTimer.unrefCalled, true);

  client.startKeepalive(100);
  assert.equal(clock.pendingCount, 1, 'restart replaces rather than duplicates the timer');
  assert.equal(clock.nextAt, 1100, 'restart remains based on the last outbound activity');
  clock.fireLastCleared();
  assert.equal(clock.pendingCount, 1, 'a queued callback from the cleared timer is inert');
  assert.equal(writes.length, 0);

  clock.advanceBy(99);
  assert.equal(writes.length, 0);
  clock.advanceBy(1);
  assert.equal(writes.length, 1);
  assert.equal(opcode(writes[0]), BP.REQ_INVENTORY);
  assert.equal(client.keepalivePending, 1);
  assert.equal(clock.pendingCount, 1, 'a successful heartbeat re-arms one deadline');
  assert.equal(clock.nextAt, 1200);

  clock.advanceBy(99);
  assert.equal(writes.length, 1);
  clock.advanceBy(1);
  assert.equal(writes.length, 2, 'continued idleness retains the old heartbeat cadence');
  assert.equal(opcode(writes[1]), BP.REQ_INVENTORY);
  assert.equal(clock.pendingCount, 1);
}

console.log('ordinary outbound traffic defers the heartbeat without adding timers');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive(100);
  clock.advanceBy(60);
  client.go();
  assert.equal(opcode(writes[0]), BP.REQ_GO);
  assert.equal(client.lastTxAt, 60);
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 100, 'activity leaves the already-armed earlier deadline alone');

  clock.advanceBy(30);
  client.players();
  assert.equal(opcode(writes[1]), BP.SEND_PLAYERS);
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 100);

  clock.advanceBy(10);
  assert.equal(writes.length, 2, 'the earlier deadline recomputes without writing');
  assert.equal(clock.nextAt, 190);
  clock.advanceBy(89);
  assert.equal(writes.length, 2);
  clock.advanceBy(1);
  assert.equal(writes.length, 3);
  assert.equal(opcode(writes[2]), BP.REQ_INVENTORY);
  assert.equal(clock.pendingCount, 1);
}

console.log('an outbound burst does not churn timeout objects');
{
  const clock = new FakeClock();
  const { client } = fixture(clock);
  client.startKeepalive(1000);
  for (let i = 0; i < 500; i++) {
    clock.advanceBy(1);
    client.go();
  }
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.setCalls, 1, '500 writes retain the original one-shot');
  assert.equal(clock.clearCalls, 0, '500 writes cancel no timeout');

  clock.advanceBy(500);
  assert.equal(clock.setCalls, 2, 'the early deadline performs one bounded recompute');
  assert.equal(clock.pendingCount, 1);
}

console.log('a delayed callback sends once and never catches up in a burst');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive(100);
  clock.jumpBy(1000);
  assert.equal(clock.runNextDue(), true);
  assert.equal(writes.length, 1);
  assert.equal(opcode(writes[0]), BP.REQ_INVENTORY);
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 1100);
  assert.equal(clock.runNextDue(), false, 'no overdue interval callbacks accumulated');
}

console.log('a truly idle client sends the existing heartbeat at 20 seconds');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive();
  assert.equal(clock.nextAt, 20_000);
  clock.advanceBy(19_999);
  assert.equal(writes.length, 0);
  clock.advanceBy(1);
  assert.equal(writes.length, 1);
  assert.equal(opcode(writes[0]), BP.REQ_INVENTORY);
}

console.log('a policy installed before game mode arms on the game transition');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock, { state: 'login' });
  client.startKeepalive(100);
  assert.equal(clock.pendingCount, 0, 'login mode has no active keepalive timeout');
  clock.advanceBy(50);
  client.onMessage(Buffer.from([AP.GAME]));
  assert.equal(client.state, 'game');
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 100);
  clock.advanceBy(50);
  assert.equal(writes.length, 1);
  assert.equal(opcode(writes[0]), BP.REQ_INVENTORY);
}

console.log('reply-silent outbound traffic cannot postpone the receive probe past 30 seconds');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive();

  clock.advanceBy(10_000);
  client.go();
  clock.advanceBy(9_000);
  client.players();
  clock.advanceBy(10_000);
  client.go();
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.nextAt, 30_000);

  clock.advanceBy(999);
  assert.equal(writes.length, 3);
  clock.advanceBy(1);
  assert.equal(writes.length, 4);
  assert.equal(opcode(writes[3]), BP.REQ_INVENTORY,
    'the liveness probe is forced even though the latest outbound write is only 1s old');
}

console.log('ordinary inbound traffic satisfies and defers the 30-second receive probe');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive();

  clock.advanceBy(10_000);
  client.go();
  clock.advanceBy(5_000);
  client.onData(Buffer.alloc(0));
  assert.equal(client.keepaliveLastRxAt, 15_000);
  assert.ok(client.lastRxAt > 1_000_000_000_000,
    'the public liveness timestamp stays in the wall-clock domain used by m59-tick');
  assert.equal(clock.nextAt, 20_000,
    'inbound traffic updates the probe basis without timer re-arm churn');

  clock.advanceBy(5_000);
  client.players();
  assert.equal(clock.nextAt, 30_000);
  clock.advanceBy(9_000);
  client.go();
  assert.equal(clock.nextAt, 30_000);

  clock.advanceBy(15_999);
  assert.equal(writes.length, 3);
  clock.advanceBy(1);
  assert.equal(writes.length, 4);
  assert.equal(opcode(writes[3]), BP.REQ_INVENTORY);
}

console.log('the timeout writes the exact existing inventory-request frame');
{
  const keepaliveClock = new FakeClock(500);
  const { client: automatic, writes: automaticWrites } = fixture(keepaliveClock);
  automatic.startKeepalive(100);
  keepaliveClock.advanceBy(100);

  const manualClock = new FakeClock(600);
  const { client: manual, writes: manualWrites } = fixture(manualClock);
  manual.send(BP.REQ_INVENTORY);

  assert.deepEqual(automaticWrites, manualWrites,
    'keepalive uses send(BP.REQ_INVENTORY) with unchanged framing and security');
}

console.log('keepalive replies stay out of the event stream');
{
  const clock = new FakeClock();
  const { client } = fixture(clock);
  client.startKeepalive(100);
  clock.advanceBy(100);
  assert.equal(client.keepalivePending, 1);

  const emptyInventory = Buffer.alloc(2);
  client.onGameMessage(BP.INVENTORY, emptyInventory);
  assert.equal(client.keepalivePending, 0);
  assert.equal(client.events.some(event => event.kind === 'inventory'), false,
    'the heartbeat inventory reply is still suppressed');

  client.onGameMessage(BP.INVENTORY, emptyInventory);
  assert.equal(client.events.filter(event => event.kind === 'inventory').length, 1,
    'a non-heartbeat inventory reply remains observable');
}

console.log('disconnect and failed writes cannot leave a timer');
{
  const clock = new FakeClock();
  const { client, writes } = fixture(clock);
  client.startKeepalive(100);
  clock.advanceBy(40);
  client._connectionClosed();
  assert.equal(client.state, 'closed');
  assert.equal(client.keepaliveTimer, null);
  assert.equal(client.keepalivePending, 0);
  assert.equal(clock.pendingCount, 0);
  clock.fireLastCleared();
  assert.equal(clock.pendingCount, 0, 'a queued pre-close callback cannot resurrect the timer');
  clock.advanceBy(1000);
  assert.equal(writes.length, 0);

  const failedClock = new FakeClock();
  const { client: failed } = fixture(failedClock, { failWrites: true });
  failed.startKeepalive(100);
  failedClock.advanceBy(100);
  assert.equal(failed.keepalivePending, 0);
  assert.equal(failedClock.pendingCount, 0,
    'a failed secure write cannot be retried after advancing the security stream');
  assert.equal(failed.keepaliveTimer, null);
  assert.equal(failed.state, 'closed');
}

console.log('client keepalive: PASS');
