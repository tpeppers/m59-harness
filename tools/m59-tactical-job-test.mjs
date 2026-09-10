import assert from 'node:assert/strict';
import { withPacketScope, bindPacketScope } from './m59-packet-scope.mjs';
import { startTacticalJob, tacticalJobStatus, selectTacticalExit, checkTacticalBinding,
  tacticalExitDescriptor } from './m59-tactical-job.mjs';
import { OF } from './m59-parse.mjs';

let held = true, sent = [];
let queued;
withPacketScope(() => { if (!held) throw Error('lease expired'); }, () => {
  queued = bindPacketScope('move', () => sent.push('move'));
});
held = false;
assert.throws(queued, /expired/);
assert.deepEqual(sent, []);
bindPacketScope('attack', () => sent.push('survival'))();
assert.deepEqual(sent, ['survival']);
// A pump started inside a command may execute an unrelated job later. That job
// must clear the ambient scope, including for any packets its callback enqueues.
const unrelated = bindPacketScope('move', () => bindPacketScope('rest', () => 42)());
assert.equal(withPacketScope(() => { throw Error('wrong scope'); }, unrelated), 42);

const fixture = () => {
  const c = { selfId: 101, roomRsc: 111, room: { id: 201, security: -2,
    objects: new Map([[202, { id: 202, nameRsc: 20, flags: OF.ATTACKABLE, col: 4, row: 3 }]]) },
    self: { nameRsc: 10, col: 3, row: 3 },
    rsc: { get: id => ({ 10: 'Example', 20: 'Creature', 21: 'Replacement' })[id] },
    vitals: () => ({ health: { value: 100, max: 100 } }),
    attack: id => { sent.push(id); c.room.objects.delete(id); } };
  const exit = { kind: 'go', to: 8, stand_on: { col: 61.0009765625, row: 30.125 },
    how: 'exact door', reachable: false };
  const s = { name: 'unit-test', client: c, world: { room: { num: 7 }, exits: () => [exit] },
    need: () => c, movementWasCancelled: () => false,
    pacer: { submit: async (kind, fn) => { await Promise.resolve(); return bindPacketScope(kind, fn)(); } },
    standBeforeGo: async () => s.pacer.submit('rest', () => sent.push('stand')),
    faceToward: async () => s.pacer.submit('turn', () => sent.push('face')),
    leaveVia: async selected => {
      assert.equal(selected, exit);
      await s.pacer.submit('move', () => { c.room.id = 203; s.world.room.num = 8; });
      return { left: true };
    },
    startJob(kind, label, fn, opts) {
      if (this.job && !this.job.done) throw Error('busy');
      const job = this.job = { kind, label, ...opts, startedAt: Date.now(), generation: 0, done: false };
      job.promise = fn(0).then(r => { job.result = r; }, e => { job.error = e.message; })
        .finally(() => { job.done = true; job.finishedAt = Date.now(); });
      return job;
    } };
  const args = { order_id: '1'.repeat(32), control_token: '1'.repeat(32), lease_token: 'capability-1234567',
    action: 'attack', target: { object_id: 202, name: 'Creature' },
    binding: { agent: s.name, character: 'Example', player_id: 101, room: 7,
      room_resource_id: 111, room_security_u32: 4294967294 } };
  return { s, c, args, exit };
};
for (const action of ['attack', 'exit']) {
  sent = [];
  const { s, args, exit } = fixture();
  args.action = action;
  if (action === 'exit') args.target = tacticalExitDescriptor(exit);
  const receipt = startTacticalJob(s, { policy: {} }, args, () => {});
  await s.job.promise;
  assert.equal(s.job.error, undefined);
  assert.equal(tacticalJobStatus(s.job, { ...args, started_at: receipt.started_at }).state, 'completed');
  assert.throws(() => tacticalJobStatus(s.job, { ...args, started_at: receipt.started_at + 1 }), /exact accepted/);
}
for (const crossed of [true, false]) {
  const { s, c, args, exit } = fixture();
  exit.to = args.binding.room;
  args.action = 'exit'; args.target = tacticalExitDescriptor(exit);
  const door = { to: exit.to, col: exit.stand_on.col, row: exit.stand_on.row,
    arriveCol: 59.25, arriveRow: 30.125 };
  s.world.room.goExits = [door];
  s.crossSameRoomDoor = async (chosen, options) => {
    assert.equal(chosen, door); assert.equal(options.controlToken, args.order_id);
    await s.pacer.submit('move', () => {
      if (crossed) Object.assign(c.self, { col: door.arriveCol, row: door.arriveRow });
    });
    return { crossed };
  };
  const receipt = startTacticalJob(s, { policy: {} }, args, () => {});
  await s.job.promise;
  assert.equal(s.job.error, undefined);
  assert.equal(s.job.result.arrived, crossed);
  assert.equal(tacticalJobStatus(s.job, { ...args, started_at: receipt.started_at }).state,
    crossed ? 'completed' : 'failed', 'same-room door needs confirmed crossing');
}
// A long, healthy fight must not be reported complete after twenty swings.
{
  const { s, c, args } = fixture();
  let swings = 0;
  c.attack = id => { if (++swings === 25) c.room.objects.delete(id); };
  const receipt = startTacticalJob(s, { policy: {} }, args, () => {});
  await s.job.promise;
  assert.equal(swings, 25);
  assert.equal(s.job.result.target_gone, true);
  assert.equal(tacticalJobStatus(s.job, { ...args, started_at: receipt.started_at }).state, 'completed');
}
for (const failure of ['cancel', 'authority', 'health', 'room', 'target', 'player', 'connection']) {
  const { s, c, args } = fixture();
  let denied = false;
  startTacticalJob(s, { policy: {} }, args, () => { if (denied) throw Error('lease lost'); });
  if (failure === 'cancel') s.job.cancelled = true;
  if (failure === 'authority') denied = true;
  if (failure === 'health') c.vitals = () => ({ health: { value: 10, max: 100 } });
  if (failure === 'room') c.room.id++;
  if (failure === 'target') c.room.objects.get(202).nameRsc = 21;
  if (failure === 'player') c.room.objects.get(202).flags |= OF.PLAYER;
  if (failure === 'connection') s.need = () => ({ ...c });
  sent = [];
  await s.job.promise;
  assert.ok(s.job.error, failure);
  assert.deepEqual(sent, [], failure);
}
const { s, args, exit } = fixture();
assert.throws(() => checkTacticalBinding(s, { binding: { ...args.binding, player_id: 999 } }), /identity/);
const target = tacticalExitDescriptor(exit);
assert.equal(selectTacticalExit([exit], target, 7), exit, 'go pocket is not refused');
assert.throws(() => selectTacticalExit([exit, exit], target, 7), /ambiguous/);
assert.throws(() => selectTacticalExit([exit], { ...target, col: 61 }, 7), /changed/);
assert.throws(() => selectTacticalExit([exit], target, 7, [7]), /confinement/);
assert.equal(selectTacticalExit([exit], target, 8), exit, 'same-room go uses position confirmation');
console.log('PASS tactical jobs: exact selected exit, PvE attack, queue guards, health/cancel/identity races and correlated status');
