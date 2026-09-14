import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CombatMode, normalizeCombatOrder, combatTarget, escapeGroundEffect } from './m59-combat-mode.mjs';
import { withBodyCommand, bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';
import { parseCombatCommand, dispatchCombatOrders } from './m59-combat-orders.mjs';
import { OF } from './m59-parse.mjs';

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const start = source.indexOf('class Pacer {'), end = source.indexOf('// ---------------------------------------------------------------- session', start);
const Pacer = Function('bindPacketScope', 'PACKETS_PER_SECOND', 'DOOR_SETTLE_MS', 'remainingDoorSettle',
  source.slice(start, end) + '; return Pacer;')(bindPacketScope, 100000, 300, () => 0);

function fixture({ realPacer = false } = {}) {
  let clock = 10000;
  const sent = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5 },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Exact Player'], [3, 'Other Player'], [4, 'hold'], [5, 'web']]),
    spells: [{ id: 4, nameRsc: 4 }], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    cast(id, targets) { sent.push(`cast:${id}:${targets.join(',')}`); } };
  c.room.objects.set(2, { id: 2, nameRsc: 2, row: 5, col: 6, flags: OF.PLAYER | OF.ATTACKABLE });
  const s = { name: 'test', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: { kind: 'travel', done: false }, need: () => c,
    world: { room: { num: 38 }, map: { rooms: { 38: { rows: 50, cols: 70 } } },
      geometry: { rows: 50, cols: 70, standable: (r, col) => r > 0 && col > 0 && r < 50 && col < 70,
        path(r, col, tr, tc, { avoid }) {
          const next = { row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) };
          return { found: !avoid.has(`${next.row},${next.col}`), steps: [next] };
        } } },
    cancelMovement() { this.movementGeneration++; this.job.cancelled = true; },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); },
    async faceToward() { return this.pacer.submit('turn', () => sent.push('face')); },
    async travel(map) { this.world.room.num = map; return { arrived: true }; },
  };
  s.pacer = realPacer ? new Pacer() : { async submit(kind, fn) {
    const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run();
  } };
  if (realPacer) s.pacer.authority = () => bodyAuthority(s);
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock,
    schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; }, unschedule: id => timers.delete(id) });
  return { s, c, sent, keeper, timers, mode: s.combat, advance(ms) { clock += ms; } };
}
const attack = { action: 'attack', target: 'Exact Player' };
const ambush = { action: 'ambush', target: 'Exact Player', map: 38, position: { row: 5, col: 5 } };

await test('validate complete orders and exact names before preemption', () => {
  const f = fixture();
  assert.throws(() => normalizeCombatOrder({ ...ambush, position: { row: 5, col: NaN } }), /row and col/);
  assert.throws(() => normalizeCombatOrder({ ...attack, ttl_ms: Infinity }), /ttl_ms/);
  assert.throws(() => normalizeCombatOrder({ ...attack, sequence: [{ do: 'trade' }] }), /verbs/);
  assert.throws(() => normalizeCombatOrder({ ...attack, sequence: [{ do: 'cast', spell: 'hold', hold_ms: -1 }] }), /hold_ms/);
  assert.throws(() => f.mode.issue({ ...attack, target: 'Exact' }), /not here/);
  const r = f.mode.issue(attack);
  assert.throws(() => f.mode.issue({ ...ambush, map: 2000 }), /known map/);
  assert.equal(f.mode.status().order_id, r.order_id);
  f.mode.stop('test');
});
await test('acceptance preempts jobs and fights without waiting or sending', async () => {
  const f = fixture(); const r = f.mode.issue(attack);
  assert.equal(r.accepted, true); assert.equal(f.s.job.cancelled, true);
  assert.equal(f.s.job.done, true); assert.equal(f.s.fightGeneration, 1);
  assert.deepEqual(f.sent, []);
  await f.mode.tick(); assert.deepEqual(f.sent, ['stand', 'face', 'attack:2']);
  assert.equal(f.mode.status().attacks, 1); f.mode.stop('test');
});
await test('already-present players, refreshes and moves cannot trigger an ambush', async () => {
  const f = fixture(); f.mode.issue(ambush); await f.mode.tick();
  assert.equal(f.mode.status().phase, 'armed');
  for (const kind of ['room-contents', 'player-moved']) { f.mode.event({ kind, id: 2 }); await f.mode.tick(); }
  assert.deepEqual(f.sent, []);
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 });
  f.c.room.objects.set(2, { id: 2, nameRsc: 2, flags: OF.PLAYER | OF.ATTACKABLE, row: 5, col: 6 });
  f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:2'); assert.equal(f.mode.status().phase, 'engaging'); f.mode.stop('test');
});
await test('door area filters other entrances; coordinates are row/col', async () => {
  const f = fixture(); f.mode.issue({ ...ambush, door: { row: 5, col: 7, radius: 0 } }); await f.mode.tick();
  f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick(); assert.deepEqual(f.sent, []);
  f.c.room.objects.get(2).col = 7;
  f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2'); f.mode.stop('test');
});
await test('arrival while positioning does not arm early', async () => {
  const f = fixture(); f.mode.issue({ ...ambush, position: { row: 6, col: 5 } });
  f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  assert.deepEqual(f.sent, ['move:r6c5']); assert.equal(f.mode.status().phase, 'positioning');
  await f.mode.tick(); assert.equal(f.mode.status().phase, 'armed'); f.mode.stop('test');
});
await test('replacement invalidates queued packets and stale cancellation is scoped', async () => {
  const f = fixture({ realPacer: true });
  f.s.pacer.lastSent = Date.now() + 100;
  const old = withBodyCommand(f.s, () => f.s.pacer.submit('attack', () => f.sent.push('OLD')));
  const caught = assert.rejects(old, /preempted/);
  const first = f.mode.issue(attack); const second = f.mode.issue(attack);
  assert.notEqual(first.order_id, second.order_id);
  assert.equal(f.mode.issue({ action: 'stop', order_id: first.order_id }).stopped, false);
  await caught; assert.deepEqual(f.sent, []); f.mode.stop('test');
});
await test('combat wakes the pacer out of an obsolete long cooldown wait', async () => {
  const f = fixture({ realPacer: true }); let deadline;
  f.s.pacer.lastByKind.set('read', Date.now());
  const old = withBodyCommand(f.s, () => f.s.pacer.submit('read', () => f.sent.push('OLD'), 30000));
  const cancelled = assert.rejects(old, /preempted/);
  f.mode.issue(attack);
  try {
    await Promise.race([f.mode.tick(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('combat stuck behind obsolete read')), 1000);
    })]);
    await cancelled;
    assert.equal(f.sent.at(-1), 'attack:2');
  } finally { clearTimeout(deadline); f.mode.stop('test'); }
});
await test('the computed keeper survival margin cannot be lowered by an order', async () => {
  const f = fixture(); f.keeper.safety = () => ({ fleeAt: 0.7 });
  f.mode.issue({ ...attack, stop_below: 0.05 });
  f.c.hp = 70; await f.mode.tick();
  assert.match(f.mode.status().reason, /survival floor/); assert.deepEqual(f.sent, []);
});
await test('old asynchronous cleanup remains invalid after combat ends', async () => {
  const f = fixture(); let resume;
  const cleanup = withBodyCommand(f.s, async () => {
    await new Promise(r => { resume = r; });
    await f.s.pacer.submit('rest', () => f.sent.push('old cleanup'));
  });
  const caught = assert.rejects(cleanup, /preempted/);
  f.mode.issue(attack); f.mode.stop('operator'); resume(); await caught;
  await withBodyCommand(f.s, () => f.s.pacer.submit('rest', () => f.sent.push('new keeper')));
  assert.deepEqual(f.sent, ['new keeper']);
});
await test('survival, target loss, room change and disconnect finish the override', async () => {
  for (const change of [f => { f.c.hp = 40; }, f => { f.c.room.objects.delete(2); },
    f => { f.c.room.id++; }, f => { f.s.live = false; }, f => { f.c.selfId++; }]) {
    const f = fixture(); f.mode.issue(attack); change(f); await f.mode.tick();
    assert.equal(f.mode.status().active, false); assert.deepEqual(f.sent, []);
  }
});
await test('expiry interrupts a pending travel without waiting for it', async () => {
  const f = fixture(); f.s.world.room.num = 37; let finish;
  f.s.travel = () => new Promise(r => { finish = r; });
  f.mode.issue({ ...ambush, ttl_ms: 1000 }); const pending = f.mode.tick();
  f.advance(1001); await f.mode.tick(); assert.equal(f.mode.status().active, false);
  finish({ arrived: true }); await pending; assert.deepEqual(f.sent, []);
});
await test('scripted cast, wait and attacks finish and restore ordinary behavior', async () => {
  const f = fixture(); f.mode.issue({ ...attack, repeat: false,
    sequence: [{ do: 'cast', spell: 'hold' }, { do: 'wait', ms: 100 }, { do: 'attack', swings: 2 }] });
  await f.mode.tick(); f.advance(1001); await f.mode.tick();
  f.advance(101); await f.mode.tick(); f.advance(1001); await f.mode.tick();
  assert.equal(f.mode.status().reason, 'sequence completed');
  assert.deepEqual(f.sent.filter(x => /attack|cast/.test(x)), ['cast:4:2', 'attack:2', 'attack:2']);
});
await test('hazard underfoot interrupts attacks with a safe outward move', async () => {
  const f = fixture(); f.c.room.objects.set(5, { id: 5, nameRsc: 5, flags: OF.NOEXAMINE | 3, row: 5, col: 5 });
  assert.equal(await escapeGroundEffect(f.s), true);
  assert.match(f.sent[0], /^move:/); assert.notDeepEqual(f.c.self, { row: 5, col: 5 });
});
await test('names never resolve to monsters or self', () => {
  const f = fixture(); f.c.room.objects.get(2).flags = OF.ATTACKABLE;
  assert.equal(combatTarget(f.c, 'Exact Player'), null);
  assert.throws(() => f.mode.issue(attack), /not here/);
});
await test('terminal grammar and parallel fleet dispatch preserve exact intent', async () => {
  const command = parseCombatCommand('combat ambush "Exact Player" agents=t1,t2 map=38 at=r30,c61 door=r8c28');
  assert.deepEqual(command.order.position, { row: 30, col: 61 });
  assert.throws(() => parseCombatCommand('combat attack Player agents=t1 speed=fast'), /invalid/);
  assert.throws(() => parseCombatCommand('combat attack Player agents=t1 map=38'), /invalid/);
  assert.throws(() => parseCombatCommand('combat ambush Player agents=t1 map=38 at=r5c5 radius=1'), /invalid/);
  const starts = []; let release;
  const result = dispatchCombatOrders({ agents: ['t1', 't2'], order: attack, send: async a => {
    starts.push(a); if (a === 't1') await new Promise(r => { release = r; });
    return { accepted: true };
  } });
  await new Promise(r => setImmediate(r)); assert.deepEqual(starts, ['t1', 't2']); release();
  assert.equal((await result).ok, true);
});
await test('invalid fleet declaration sends nothing; per-character errors are reported', async () => {
  let sends = 0;
  await assert.rejects(dispatchCombatOrders({ agents: ['t1', 't2'], order: a => a === 't1' ? attack : { action: 'oops' },
    send: () => { sends++; } }), /action/);
  assert.equal(sends, 0);
  const result = await dispatchCombatOrders({ agents: ['t1'], order: attack, send: () => ({ error: 'disconnected' }) });
  assert.equal(result.ok, false);
});

await test('final cast holds concentration before returning the body', async () => {
  const f = fixture();
  f.mode.issue({ ...attack, repeat: false, sequence: [{ do: 'cast', spell: 'hold', hold_ms: 5000 }] });
  await f.mode.tick(); assert.equal(f.mode.status().active, true);
  f.advance(4999); await f.mode.tick(); assert.equal(f.mode.status().active, true);
  f.advance(1); await f.mode.tick(); assert.equal(f.mode.status().reason, 'sequence completed');
});
await test('stale connection, displaced ambush and server safety refusal stop combat', async () => {
  const stale = fixture(); stale.mode.issue(attack); stale.c.lastRxAt = 1; stale.advance(45000);
  await stale.mode.tick(); assert.match(stale.mode.status().reason, /connection stale/);
  const displaced = fixture(); displaced.mode.issue(ambush); await displaced.mode.tick();
  displaced.c.self.row++; displaced.mode.event({ kind: 'appeared', id: 2 });
  assert.match(displaced.mode.status().reason, /position changed/);
  const refusal = fixture(); refusal.mode.issue(attack);
  refusal.mode.event({ kind: 'message', text: 'Good thing your safety was on.' });
  assert.equal(refusal.mode.status().last_outcome.kind, 'refused');
  assert.equal(refusal.mode.status().active, false);
});

console.log(`PASS ${tests} combat mode scenarios`);
