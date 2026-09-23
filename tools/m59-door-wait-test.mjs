import assert from 'node:assert/strict';
import { waitForDoorOpen } from './m59-door-wait.mjs';

async function run({ speed = 20, delay = 700, events = true, cancelledAt = Infinity,
  closeAt = Infinity, roomAt = Infinity, unrelated = false } = {}) {
  let time = 0;
  const room = { id: 2572, sectorHeights: new Map() };
  const c = { room, async waitFor({ timeoutMs, match }) {
    time += timeoutMs;
    const event = { at: delay, room: 2572, sector: unrelated ? 55 : 59, height: 190, speed };
    if (events && time >= delay && match(event)) {
      room.sectorHeights.set(59, { height: 190 });
      return { events: [event], timedOut: false };
    }
    return { events: [], timedOut: true };
  } };
  const result = await waitForDoorOpen(c,
    { sector: 59, from_height: 100, to_height: 190, within_ms: 5000 }, {
      since: 0, now: () => time, cancelled: () => time >= cancelledAt,
      sleep: async ms => { time += ms;
        if (time >= closeAt) room.sectorHeights.set(59, { height: 100 });
        if (time >= roomAt) c.room = { id: 999 };
      },
    });
  return { result, time };
}
const slow = await run();
assert.equal(slow.result.opened, true);
assert.equal(slow.time, 5300); // 700 ms response + 4.6 s animation, not a 2.2 s cap.
assert.equal((await run({ events: false })).result.opened, false);
assert.equal((await run({ unrelated: true })).result.opened, false);
assert.equal((await run({ speed: undefined, events: false })).result.opened, false);
assert.equal((await run({ cancelledAt: 1200 })).result.reason, 'movement cancelled');
assert.equal((await run({ roomAt: 1200 })).result.reason, 'movement cancelled');
assert.equal((await run({ closeAt: 1700 })).result.opened, false);
assert.equal((await run({ speed: 0 })).time, 700);
assert.equal((await run({ speed: 10 })).result.opened, false);
console.log('door wait: slow opening, resolved timeout, wrong sector, cancellation, room change and closure passed');
