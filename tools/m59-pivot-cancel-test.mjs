import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from './m59-game.mjs';

function pivotFixture({ cancelAtMove = null, retry = false } = {}) {
  const packets = [];
  const client = {
    room: { id: 1416 }, self: { row: 49, col: 44, x: 2833, y: 3183 },
    face() {},
    moveTo(x, y) { packets.push({ x, y }); },
    predictSelf(position) { this.self = position; },
  };
  let queuedMoves = 0;
  let validations = 0;
  const session = {
    client, name: 'fixture', movementGeneration: 304,
    need: () => client,
    moveSpeed: () => 18,
    movementWasCancelled(generation) { return generation !== this.movementGeneration; },
    aimInto: () => ({ x: 4704, y: 480 }),
    queueValidatedMove: Session.prototype.queueValidatedMove,
    validateFineTarget(x, y) {
      if (++validations === 2 && retry) return { available: true, moved: false, reason: 'fixture blocked pivot point' };
      return { available: true, moved: true, target: { x, y } };
    },
    pacer: {
      async submit(kind, send) {
        if (kind === 'move' && ++queuedMoves === cancelAtMove) session.movementGeneration++;
        return send();
      },
    },
  };
  const geometry = { stringPull: points => ({ points: [points[0], points.at(-1)], proved: [true] }) };
  const move = () => Session.prototype.walkPivots.call(session, [{ row: 6, col: 74 }], geometry);
  return { client, packets, move };
}

test('a queued pivot sends no wire packet after recovery cancels its generation', async () => {
  const { client, packets, move } = pivotFixture({ cancelAtMove: 1 });
  assert.equal((await move()).cancelled, true);
  assert.deepEqual(packets, []);
  assert.equal(client.self.row, 49);
});

test('the pivot retry has the same wire authority fence', async () => {
  const { packets, move } = pivotFixture({ cancelAtMove: 2, retry: true });
  assert.equal((await move()).cancelled, true);
  assert.deepEqual(packets, []);
});

test('an owned pivot still sends one packet and finishes', async () => {
  const { packets, move } = pivotFixture();
  assert.equal((await move()).done, true);
  assert.equal(packets.length, 1);
});
