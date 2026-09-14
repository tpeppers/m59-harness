import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CombatMode, normalizeCombatOrder, combatTarget, escapeGroundEffect } from './m59-combat-mode.mjs';
import { withBodyCommand, bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';
import { parseCombatCommand, dispatchCombatOrders } from './m59-combat-orders.mjs';
import { OF } from './m59-parse.mjs';
import { CombatDispatch, resolveCombatMap } from './m59-combat-dispatch.mjs';
import { parseCombatCLI } from './m59-combat-order.mjs';

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const start = source.indexOf('class Pacer {'), end = source.indexOf('// ---------------------------------------------------------------- session', start);
const pacerClass = rate => Function('bindPacketScope', 'PACKETS_PER_SECOND', 'DOOR_SETTLE_MS', 'remainingDoorSettle',
  source.slice(start, end) + '; return Pacer;')(bindPacketScope, rate, 300, () => 0);
const Pacer = pacerClass(100000);

function fixture({ realPacer = false } = {}) {
  let clock = 10000;
  const sent = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5 },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Exact Player'], [3, 'Other Player'], [4, 'hold'], [5, 'web']]),
    spells: [{ id: 4, nameRsc: 4 }], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    safety(on) { sent.push('safety:' + on); this.self.flags = on ? OF.SAFETY : 0; },
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
  assert.equal(f.mode.issue({ ...attack, target: 'Exact' }).phase, 'waiting');
  assert.throws(() => f.mode.issue({ ...attack, target: 999 }), /not here/);
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
  assert.deepEqual(f.sent, ['stand', 'move:r6c5']); assert.equal(f.mode.status().phase, 'positioning');
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
await test('survival, room change and disconnect finish the override', async () => {
  for (const change of [f => { f.c.hp = 40; },
    f => { f.c.room.id++; }, f => { f.s.live = false; }, f => { f.c.selfId++; }]) {
    const f = fixture(); f.mode.issue(attack); change(f); await f.mode.tick();
    assert.equal(f.mode.status().active, false); assert.deepEqual(f.sent, []);
  }
});
await test('expiry interrupts a pending travel without waiting for it', async () => {
  const f = fixture(); f.s.world.room.num = 37; let finish;
  f.s.travel = () => new Promise(r => { finish = r; });
  f.mode.issue({ ...ambush, ttl_ms: 1000 }); const pending = f.mode.tick();
  await new Promise(r => setImmediate(r));
  f.advance(1001); await f.mode.tick(); assert.equal(f.mode.status().active, false);
  finish({ arrived: true }); await pending; assert.deepEqual(f.sent, ['stand']);
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
  assert.equal(f.sent[0], 'stand'); assert.match(f.sent[1], /^move:/); assert.notDeepEqual(f.c.self, { row: 5, col: 5 });
});
await test('names never resolve to monsters or self', () => {
  const f = fixture(); f.c.room.objects.get(2).flags = OF.ATTACKABLE;
  assert.equal(combatTarget(f.c, 'Exact Player'), null);
  assert.equal(f.mode.issue(attack).phase, 'waiting');
  f.mode.stop('test');
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

await test('unseen named target waits indefinitely and reacquires new visible object IDs', async () => {
  const f = fixture(); const player = f.c.room.objects.get(2); f.c.room.objects.clear();
  assert.equal(f.mode.issue(attack).phase, 'waiting');
  assert.equal(f.mode.status().expires_at, null);
  f.advance(3_600_000); await f.mode.tick();
  assert.deepEqual(f.sent, []); assert.equal(f.mode.status().active, true);
  f.c.room.objects.set(22, { ...player, id: 22 });
  f.mode.event({ kind: 'room-contents' }); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:22');
  f.c.room.objects.delete(22); f.mode.event({ kind: 'vanished', id: 22 }); await f.mode.tick();
  assert.equal(f.mode.status().phase, 'waiting'); const n = f.sent.length;
  f.advance(10000); await f.mode.tick(); assert.equal(f.sent.length, n);
  f.c.room.objects.set(23, { ...player, id: 23 });
  f.mode.event({ kind: 'appeared', id: 23 }); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:23');
  f.s.world.room.num = 39; await f.mode.tick();
  assert.match(f.mode.status().reason, /left the combat room/);
});
await test('nonattackable appearance waits until the exact player becomes attackable', async () => {
  const f = fixture(); f.c.room.objects.get(2).flags = OF.PLAYER;
  assert.equal(f.mode.issue(attack).phase, 'waiting'); await f.mode.tick();
  assert.deepEqual(f.sent, []);
  f.c.room.objects.get(2).flags |= OF.ATTACKABLE; f.mode.event({ kind: 'changed', id: 2 });
  await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2'); f.mode.stop('test');
});
await test('target loss revokes already queued packets without ending the waiting order', async () => {
  const f = fixture({ realPacer: true });
  f.s.pacer.lastSent = Date.now() + 100;
  f.mode.issue(attack); const inFlight = f.mode.tick();
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 });
  await inFlight; assert.deepEqual(f.sent, []); assert.equal(f.mode.status().phase, 'waiting');
  f.mode.stop('test');
});
await test('map selection does not preempt outsiders and late commands cannot undo a stop', () => {
  const f = fixture();
  assert.equal(f.mode.issue({ ...attack, select_map: 39, revision: 10 }).skipped, true);
  assert.equal(f.s.job.done, false);
  f.mode.issue({ action: 'stop', order_id: 'delayed', revision: 20 });
  assert.equal(f.mode.issue({ ...attack, command_id: 'delayed', revision: 10 }).accepted, false);
  f.mode.issue({ ...attack, command_id: 'new', revision: 30 });
  f.mode.issue({ action: 'stop', order_id: 'delayed', revision: 40 });
  assert.equal(f.mode.status().order_id, 'new');
  f.mode.issue({ action: 'stop', revision: 50 });
  assert.equal(f.mode.issue({ ...attack, command_id: 'late', revision: 45 }).accepted, false);
  assert.equal(f.mode.status().active, false);
});
await test('kill lowers game safety only while engaging and restores it on waiting and stop', async () => {
  const f = fixture(); f.c.self.flags = OF.SAFETY;
  const player = f.c.room.objects.get(2); f.c.room.objects.delete(2);
  f.mode.issue({ ...attack, action: 'kill' }); await f.mode.tick();
  assert.deepEqual(f.sent, []);
  f.c.room.objects.set(2, player); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  assert.deepEqual(f.sent.slice(0, 4), ['safety:false', 'stand', 'face', 'attack:2']);
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 }); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'safety:true');
  f.c.room.objects.set(2, player); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  f.mode.stop('operator stopped combat'); await new Promise(r => setImmediate(r));
  assert.equal(f.sent.at(-1), 'safety:true'); assert.equal(f.mode.safetyLease, null);
});
await test('kill replacements keep the safety lease through stale cleanup', async () => {
  const f = fixture(); f.c.self.flags = OF.SAFETY;
  f.mode.issue({ ...attack, action: 'kill' }); await f.mode.tick();
  f.mode.issue({ ...attack, action: 'kill' }); await f.mode.tick();
  assert.equal(f.sent.filter(p => p === 'safety:true').length, 0);
  f.mode.issue({ ...attack, target: 'Absent' }); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'safety:true');
  f.mode.stop('test');
});
await test('rapid reacquisition respects a safety restore whose server echo is still pending', async () => {
  const f = fixture(); f.c.self.flags = OF.SAFETY;
  f.c.safety = on => f.sent.push('safety:' + on); // Like the real client: no optimistic flags.
  f.mode.issue({ ...attack, action: 'kill' }); await f.mode.tick();
  f.c.self.flags = 0; f.mode.event({ kind: 'changed', id: 1 });
  const target = f.c.room.objects.get(2); f.c.room.objects.delete(2);
  f.mode.event({ kind: 'vanished', id: 2 }); await f.mode.tick();
  assert.equal(f.mode.status().active, true);
  f.c.room.objects.set(2, target); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  assert.deepEqual(f.sent.filter(x => x.startsWith('safety:')), ['safety:false', 'safety:true', 'safety:false']);
  f.mode.stop('test'); await new Promise(r => setImmediate(r));
});
await test('group dispatch has bounded receipts and no dependency on stalled keepers', async () => {
  const good = fixture(), other = fixture(), sent = [];
  other.s.world.room.num = 39;
  const dispatch = new CombatDispatch({
    candidates: () => [{ agent: 'slow' }, { agent: 'good' }, { agent: 'other' },
      { agent: 'human', unavailable: 'character is human-piloted' }],
    rooms: () => ({ 38: { name: 'Upstairs in Castle Victoria' }, 39: { name: 'Elsewhere' } }),
    receiptMs: 30,
    send: async (agent, order) => {
      sent.push(agent);
      if (agent === 'slow') return new Promise(() => {});
      return (agent === 'good' ? good : other).mode.issue(order);
    },
  });
  const reply = await dispatch.run({ action: 'kill', target: 'Exact Player', room: 'Upstairs Castle Victoria' });
  assert.equal(reply.pending, true); assert.ok(reply.dispatch_ms < 500);
  assert.deepEqual(sent, ['slow', 'good', 'other']);
  assert.equal(good.mode.status().phase, 'engaging'); assert.equal(other.s.job.done, false);
  assert.equal(reply.results.find(r => r.agent === 'human').skipped, true);
  const stop = await dispatch.run({ action: 'stop', command_id: reply.command_id });
  assert.equal(good.mode.status().active, false); assert.equal(stop.pending, true);
});
await test('group command reaches first attack within seconds under normal server pacing', async () => {
  const f = fixture(); f.s.pacer = new (pacerClass(5))(); f.s.pacer.authority = () => bodyAuthority(f.s);
  f.c.self.flags = OF.SAFETY; const started = Date.now(); let first;
  f.c.attack = id => { first = Date.now(); f.sent.push('attack:' + id); };
  const dispatch = new CombatDispatch({ rooms: () => ({ 38: { name: 'Assigned' } }),
    candidates: () => [{ agent: 'one' }],
    send: (_agent, order) => { const result = f.mode.issue(order); void f.mode.tick(); return result; } });
  const reply = await dispatch.run({ action: 'kill', target: 'Exact Player', room: 38 });
  assert.equal(reply.results[0].accepted, true);
  const deadline = Date.now() + 2000;
  while (!first && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(first && first - started < 1500, 'first paced attack exceeded 1500ms');
  console.log('  command-to-first-attack: ' + (first - started) + 'ms (5 packets/sec)');
  f.mode.stop('test'); await new Promise(r => setTimeout(r, 250));
});
await test('CLI and assigned room aliases preserve literal kill intent', () => {
  assert.deepEqual(parseCombatCLI(['Kill Morpheus', '--fleet', 'prod', '--room', 'Upstairs Castle Victoria']),
    { action: 'kill', target: 'Morpheus', room: 'Upstairs Castle Victoria' });
  assert.equal(resolveCombatMap({ 39: { name: 'Upstairs in Castle Victoria' } }, 'Upstairs Castle Victoria'), 39);
  assert.throws(() => resolveCombatMap({ 38: { name: 'Same' }, 39: { name: 'Same' } }, 'Same'), /exactly one/);
  assert.throws(() => parseCombatCLI(['Kill Player', '--bogus', 'true']), /invalid option/);
  const scratch = parseCombatCommand('combat kill Morpheus room="Upstairs Castle Victoria"');
  assert.equal(scratch.room, 'Upstairs Castle Victoria'); assert.equal(scratch.order.action, 'kill');
});

console.log(`PASS ${tests} combat mode scenarios`);
