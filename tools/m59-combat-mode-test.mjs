import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CombatMode, normalizeCombatOrder, combatTarget, escapeGroundEffect } from './m59-combat-mode.mjs';
import { withBodyCommand, bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';
import { parseCombatCommand, dispatchCombatOrders } from './m59-combat-orders.mjs';
import { OF } from './m59-parse.mjs';
import { CombatDispatch, resolveCombatMap } from './m59-combat-dispatch.mjs';
import { parseCombatCLI } from './m59-combat-order.mjs';
import { combatWatchStore } from './m59-combat-watch-store.mjs';
import { currentSurvivalDecision, chooseSurvivalDecision, survivalDecisionSnapshot } from './m59-survival-decision.mjs';
import { captureCachedScene } from './m59-scene-capture.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const CONCENTRATION_SAFE ='), end = source.indexOf('// ---------------------------------------------------------------- session', start);
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
    world: { room: { num: 38 }, map: { rooms: { 38: { rows: 50, cols: 70 }, 39: { rows: 50, cols: 70 } } },
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

const watchOrder = { ...attack, action: 'kill', when_absent: 'farm', watch_maps: [38, 39] };
const farmer = () => {
  const f = fixture(); f.keeper.mode = 'farm'; f.keeper.running = true; return f;
};
await test('passive watch leaves normal farming packets, jobs and body authority intact', async () => {
  const f = farmer(); f.c.room.objects.clear();
  const epoch = f.s.combatEpoch, job = f.s.job;
  const reply = f.mode.issue(watchOrder);
  assert.equal(reply.active, false); assert.equal(reply.watch.enabled, true);
  assert.equal(f.s.combatEpoch, epoch); assert.equal(job.done, false);
  await withBodyCommand(f.s, () => f.s.pacer.submit('attack', () => f.sent.push('farm:monster')));
  await f.mode.tick(); assert.deepEqual(f.sent, ['farm:monster']);
  f.mode.issue({ action: 'stop' }); assert.equal(f.mode.watch, null);
});
await test('a sighting preempts farming and losing sight returns the body to normal farming', async () => {
  const f = farmer(), target = f.c.room.objects.get(2); f.c.room.objects.clear();
  f.mode.issue(watchOrder); assert.equal(f.s.job.done, false);
  f.c.room.objects.set(2, target); f.mode.event({ kind: 'appeared', id: 2 });
  assert.equal(f.mode.status().active, true); assert.equal(f.s.job.done, true);
  await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2');
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 }); await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.status().watch.phase, 'watching');
  await withBodyCommand(f.s, () => f.s.pacer.submit('attack', () => f.sent.push('farm:monster')));
  assert.equal(f.sent.at(-1), 'farm:monster');
  f.c.room.objects.set(22, { ...target, id: 22 }); f.mode.event({ kind: 'appeared', id: 22 });
  await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:22');
  assert.equal(f.mode.status().watch.engagements, 2); f.mode.issue({ action: 'stop' });
});
await test('low health suspends the encounter but retains and rearms the watch after recovery', async () => {
  const f = farmer(); f.mode.issue(watchOrder); await f.mode.tick();
  f.c.hp = 40; await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.watch.recovering, true);
  const attacks = f.sent.filter(p => p.startsWith('attack:')).length;
  for (const hp of [45, 65, 79]) {
    f.c.hp = hp; await f.mode.tick(); assert.equal(f.mode.status().active, false);
  }
  assert.equal(f.sent.filter(p => p.startsWith('attack:')).length, attacks);
  f.c.hp = 90; await f.mode.tick(); assert.equal(f.mode.status().active, true);
  assert.equal(f.mode.status().watch.engagements, 2); f.mode.issue({ action: 'stop' });
});
await test('watch can be installed during recovery without interrupting it', async () => {
  const f = farmer(); f.c.hp = 10;
  const reply = f.mode.issue(watchOrder);
  assert.equal(reply.accepted, true); assert.equal(reply.active, false);
  assert.equal(reply.watch.phase, 'recovering'); assert.equal(f.s.job.done, false);
  f.c.hp = 95; await f.mode.tick(); assert.equal(f.mode.status().active, true);
  f.mode.issue({ action: 'stop' });
});
await test('watch does not take over paused keepers, errands or nonfarming characters', async () => {
  for (const pause of [f => { f.keeper.running = false; }, f => { f.keeper.inert = {}; }, f => { f.keeper.mode = 'idle'; }]) {
    const f = farmer(); pause(f); f.mode.issue(watchOrder); await f.mode.tick();
    assert.equal(f.mode.status().watch.phase, 'paused'); assert.equal(f.s.job.done, false);
    assert.deepEqual(f.sent, []);
    f.keeper.running = true; f.keeper.mode = 'farm'; f.keeper.inert = null;
    await f.mode.tick(); assert.equal(f.mode.status().active, true);
    f.keeper.running = false; await f.mode.tick(); assert.equal(f.mode.status().active, false);
    f.keeper.running = true; await f.mode.tick(); assert.equal(f.mode.status().active, true);
    f.mode.issue({ action: 'stop' });
  }
});
await test('watch covers later arrivals in either assigned map without cross-map pursuit', async () => {
  const f = farmer(); f.s.world.room.num = 37;
  f.mode.issue(watchOrder); await f.mode.tick();
  assert.equal(f.mode.status().watch.phase, 'outside_map'); assert.equal(f.s.job.done, false);
  f.s.world.room.num = 39; f.c.room.id = 3900; f.mode.event({ kind: 'room-entered' });
  await f.mode.tick(); assert.equal(f.mode.active.room, 39);
  f.s.world.room.num = 37; f.c.room.id = 3700; f.mode.event({ kind: 'room-entered' }); await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.status().watch.phase, 'outside_map');
  f.mode.issue({ action: 'stop' });
});
await test('watch survives reconnection and scoped stop prevents any later reactivation', async () => {
  const f = farmer(); const receipt = f.mode.issue(watchOrder); await f.mode.tick();
  f.s.live = false; f.mode.event({ kind: 'disconnected' }); await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.watch.id, receipt.watch.order_id);
  f.s.live = true; f.c.selfId = 100; f.c.self.id = 100; f.c.room.id = 4000;
  await f.mode.tick(); assert.equal(f.mode.status().active, true);
  f.mode.issue({ action: 'stop', order_id: receipt.watch.order_id });
  await f.mode.tick(); assert.equal(f.mode.status().active, false); assert.equal(f.mode.watch, null);
});
await test('failed approach does not repeatedly seize farming until that sighting ends', async () => {
  const f = farmer(); f.s.world.geometry.path = () => ({ found: false }); f.c.room.objects.get(2).row = 30;
  f.mode.issue(watchOrder); await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.status().watch.phase, 'blocked');
  for (let i = 0; i < 5; i++) await f.mode.tick();
  assert.equal(f.mode.watch.engagements, 1); f.mode.issue({ action: 'stop' });
});
await test('group farm watch arms all recipients for both maps while preserving current jobs outside them', async () => {
  const a = farmer(), b = farmer(), c = farmer(); a.c.room.objects.clear(); b.c.room.objects.clear(); c.c.room.objects.clear();
  b.s.world.room.num = 39; c.s.world.room.num = 37;
  const byAgent = { a, b, c };
  const dispatch = new CombatDispatch({ candidates: () => Object.keys(byAgent).map(agent => ({ agent })),
    rooms: () => ({ 38: { name: 'First' }, 39: { name: 'Second' } }),
    send: (agent, input) => byAgent[agent].mode.issue(input) });
  const reply = await dispatch.run({ action: 'kill', target: 'Exact Player', when_absent: 'farm', rooms: ['First', 'Second'] });
  assert.equal(reply.ok, true); assert.deepEqual(reply.maps, [38, 39]);
  for (const f of [a, b, c]) { assert.equal(f.mode.watch.id, reply.command_id); assert.equal(f.s.job.done, false); }
  const stopped = await dispatch.run({ action: 'stop', command_id: reply.command_id });
  assert.equal(stopped.ok, true); for (const f of [a, b, c]) assert.equal(f.mode.watch, null);
  const again = await dispatch.run({ action: 'kill', target: 'Exact Player', when_absent: 'farm', rooms: ['First', 'Second'] });
  dispatch.commands.clear(); // Broker restarted; the keepers retained their durable watches.
  await dispatch.run({ action: 'stop', command_id: again.command_id });
  for (const f of [a, b, c]) assert.equal(f.mode.watch, null);
});
await test('durable watches are isolated by roster, endpoint and character; stops survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'm59-combat-watch-'));
  try {
    const options = { directory, fleetPath: join(directory, 'prod.json'), host: 'fixture', port: 5959, agent: 'test', character: 'Us' };
    const store = combatWatchStore(options), f = farmer(); f.mode.character = () => 'Us';
    f.mode.saveWatch = w => store.write(w); f.c.room.objects.clear(); f.mode.issue(watchOrder);
    assert.ok(store.read());
    const restored = farmer(); restored.mode.character = () => 'Us'; restored.mode.saveWatch = w => store.write(w);
    restored.mode.restoreWatch(store.read()); await restored.mode.tick();
    assert.equal(restored.mode.status().active, true);
    for (const change of [{ port: 5960 }, { character: 'Other' }, { fleetPath: join(directory, 'lab.json') }])
      assert.equal(combatWatchStore({ ...options, ...change }).read(), null);
    restored.mode.issue({ action: 'stop' }); assert.equal(store.read(), null);
    f.mode.issue({ action: 'stop' });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('m59-combat-watch-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
await test('CLI and FleetScratch express farm watches in both assigned maps', () => {
  const command = parseCombatCLI(['Kill Morpheus', '--maps', '39,544', '--when-absent', 'farm']);
  assert.deepEqual(command, { action: 'kill', target: 'Morpheus', rooms: [39, 544], when_absent: 'farm' });
  const scratch = parseCombatCommand('combat kill Morpheus maps=39,544 absent=farm');
  assert.deepEqual(scratch.rooms, [39, 544]); assert.equal(scratch.order.when_absent, 'farm');
  assert.throws(() => normalizeCombatOrder({ ...ambush, when_absent: 'farm' }), /farm watch/);
});
await test('restart restores the original PvP safety before a passive watch farms again', async () => {
  let saved;
  const f = farmer(); f.c.self.flags = OF.SAFETY;
  f.mode.saveWatch = w => { saved = structuredClone(w); };
  f.mode.issue(watchOrder); await f.mode.tick();
  assert.equal(saved.restoreSafety, true);
  const restored = farmer(); restored.c.room.objects.clear(); restored.c.self.flags = 0;
  restored.mode.saveWatch = w => { saved = structuredClone(w); };
  restored.mode.restoreWatch(saved); await restored.mode.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(restored.sent.at(-1), 'safety:true');
  assert.equal(saved.restoreSafety, false);
  assert.equal(restored.mode.status().active, false);
  restored.mode.issue({ action: 'stop' }); f.mode.issue({ action: 'stop' });
});

const incoming = f => f.mode.event({ kind: 'message', text: "Exact Player's scimitar cleaves you." });
await test('confirmed PvP at one HP preempts recovery and keeps returning fire below every health floor', async () => {
  const f = fixture(); f.c.hp = 1; f.keeper.safety = () => ({ fleeAt: .95 });
  f.keeper.inert = { why: 'shopping' }; f.keeper.frozenUntil = 999999;
  chooseSurvivalDecision(f.s, { strategy: 'logoff_at_refuge', reason: 'old recovery' });
  incoming(f); await f.mode.tick();
  assert.equal(f.mode.pvpStatus().active, true); assert.equal(f.mode.status().attacks, 1);
  assert.equal(f.sent.at(-1), 'attack:2'); assert.equal(f.keeper.frozenUntil, null);
  assert.equal(currentSurvivalDecision(f.s).strategy, 'pvp_return_fire');
  assert.equal(survivalDecisionSnapshot(f.s).history[0].outcome, 'cancelled');
  f.advance(31000); await f.mode.tick();
  assert.equal(f.mode.status().attacks, 2, 'visible assailant remains hostile after 30 seconds');
  assert.equal(chooseSurvivalDecision(f.s, { strategy: 'rest_safe' }).strategy, 'pvp_return_fire');
  assert.throws(() => bodyAuthority(f.s).guard(), /preempted/);
  f.mode.issue({ action: 'stop' });
});
await test('blocks and dodges establish PvP; monster hits, outgoing results and quoted chat do not', async () => {
  const f = fixture(); f.c.hp = 2;
  for (const text of ['a troll hits you.', 'Your punch slaps Exact Player.',
    'Other Player tells you, "Exact Player hits you."']) f.mode.event({ kind: 'message', text });
  assert.equal(f.mode.status().active, false);
  f.mode.event({ kind: 'message', text: "You dodge Exact Player's attack." });
  await f.mode.tick(); assert.equal(f.mode.status().attacks, 1);
  assert.equal(f.mode.pvpStatus().incoming_misses, 1);
  f.mode.issue({ action: 'stop' });
});
await test('a standing watch promotes into PvP instead of withdrawing at the survival floor', async () => {
  const f = fixture(); Object.assign(f.keeper, { mode: 'farm', running: true });
  f.mode.issue({ action: 'kill', target: 'Exact Player', when_absent: 'farm', watch_maps: [38] });
  await f.mode.tick(); incoming(f); f.c.hp = 30; f.keeper.running = false;
  f.advance(1100); await f.mode.tick();
  assert.equal(f.mode.pvpStatus().active, true);
  assert.equal(f.mode.status().attacks, 1);
  assert.equal(f.mode.status().watch.enabled, true);
  assert.equal(f.mode.issue(attack).accepted, false, 'ordinary orders cannot replace survival');
  f.mode.issue({ action: 'stop' });
});
await test('the last 30 seconds remain dangerous when an attacker vanishes, then recovery can resume', async () => {
  const f = fixture(); incoming(f); await f.mode.tick();
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 });
  f.advance(29999); await f.mode.tick(); assert.equal(f.mode.status().active, true);
  f.advance(1); await f.mode.tick(); assert.equal(f.mode.status().active, false);
  assert.equal(f.mode.pvpStatus().outcome, 'attackers_left');
  assert.equal(survivalDecisionSnapshot(f.s).history.at(-1).outcome, 'attackers_left');
  bodyAuthority(f.s).guard();
});
await test('another known assailant keeps combat active and is targeted when the first leaves', async () => {
  const f = fixture(); incoming(f); await f.mode.tick();
  f.c.room.objects.set(3, { id: 3, nameRsc: 3, row: 6, col: 5, flags: OF.PLAYER | OF.ATTACKABLE });
  f.mode.event({ kind: 'message', text: 'Other Player hits you.' });
  f.c.room.objects.get(2).flags = OF.PLAYER;
  f.mode.event({ kind: 'changed', id: 2 });
  assert.equal(f.mode.status().target, 'Other Player', 'an attackable assailant outranks a protected one');
  f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 });
  f.advance(31000); await f.mode.tick();
  assert.equal(f.mode.status().target, 'Other Player'); assert.equal(f.sent.at(-1), 'attack:3');
  assert.equal(f.mode.pvpStatus().attackers.length, 2); f.mode.issue({ action: 'stop' });
});
await test('reconnect keeps intent and counters, rejects the old client, and resumes at unchanged one HP', async () => {
  const f = fixture(); f.c.hp = 1; incoming(f); await f.mode.tick();
  f.mode.event({ kind: 'message', text: 'Your punch slaps Exact Player.' });
  f.mode.event({ kind: 'message', text: 'Exact Player blocks your attack.' });
  f.s.live = false; f.mode.event({ kind: 'disconnected' });
  assert.equal(f.mode.status().active, true); assert.equal(f.mode.status().phase, 'offline');
  const next = { ...f.c, selfId: 10, room: { id: 3801, objects: new Map([
    [22, { id: 22, nameRsc: 2, row: 5, col: 6, flags: OF.PLAYER | OF.ATTACKABLE }]]) }, combatReady: false };
  f.s.client = next; f.s.live = true; f.advance(20000); await f.mode.tick();
  assert.equal(f.mode.status().attacks, 1, 'no attacks during login bootstrap');
  f.mode.event({ kind: 'message', text: 'Exact Player hits you.' }, f.c);
  assert.equal(f.mode.pvpStatus().incoming_hits, 1, 'old socket cannot inject hostility');
  next.combatReady = true; await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:22'); assert.equal(f.mode.pvpStatus().reconnects, 1);
  assert.equal(f.mode.pvpStatus().outgoing_hits, 1); assert.equal(f.mode.pvpStatus().outgoing_misses, 1);
  const scene = captureCachedScene(f.s, null);
  assert.equal(scene.controller.pvp_survival.attacks, 2);
  assert.equal(scene.controller.pvp_survival.attackers[0].character, 'Exact Player');
  f.mode.issue({ action: 'stop' });
});
await test('death ends PvP and preserves its final record for mortality handling', async () => {
  const f = fixture(); incoming(f); await f.mode.tick();
  f.c.hp = 0; f.mode.event({ kind: 'stat', name: 'health', value: 0 });
  assert.equal(f.mode.status().active, false); assert.equal(f.mode.pvpStatus().outcome, 'died');
  assert.equal(f.mode.pvpStatus().attacks, 1);
  assert.equal(survivalDecisionSnapshot(f.s).history.at(-1).outcome, 'died');
  bodyAuthority(f.s).guard();
});
await test('server refusal and blocked approach retain survival ownership instead of resting', async () => {
  const f = fixture(); incoming(f);
  f.c.room.objects.get(2).col = 20; f.s.world.geometry.path = () => ({ found: false });
  await f.mode.tick(); assert.equal(f.mode.pvpStatus().active, true);
  assert.match(f.mode.pvpStatus().blocked_reason, /no safe approach/);
  f.c.room.objects.get(2).col = 6; f.advance(1100); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:2');
  f.mode.event({ kind: 'message', text: 'You cannot attack here.' });
  assert.equal(f.mode.pvpStatus().active, true);
  assert.match(f.mode.pvpStatus().blocked_reason, /server refused/);
  f.mode.issue({ action: 'stop' });
});
await test('incoming PvP invalidates queued old recovery before its packet can leave', async () => {
  const f = fixture({ realPacer: true }); f.s.pacer.lastSent = Date.now() + 200;
  const pending = withBodyCommand(f.s, () => f.s.pacer.submit('rest', () => f.sent.push('OLD REST')));
  const rejected = assert.rejects(pending, /preempted/); incoming(f);
  await f.mode.tick(); await rejected;
  assert.ok(!f.sent.includes('OLD REST')); assert.equal(f.sent.at(-1), 'attack:2');
  f.mode.issue({ action: 'stop' });
});
await test('explicit operator stop and connection suspension release PvP ownership', async () => {
  const f = fixture(); incoming(f); f.mode.issue({ action: 'stop' });
  await f.mode.tick(); assert.equal(f.mode.status().active, false);
  f.mode.pvpEligibility = () => false; incoming(f); await f.mode.tick();
  assert.equal(f.mode.status().active, false); assert.deepEqual(f.sent, []);
});
await test('shadow replay rebinds attacker names, carries counters and rebases the danger window', async () => {
  const original = fixture(); incoming(original); await original.mode.tick();
  const saved = original.mode.pvpStatus(); original.mode.issue({ action: 'stop' });
  const f = fixture(); f.advance(90000); f.c.rsc.set(2, 'ReplayAttacker');
  assert.throws(() => f.mode.restorePvPForReplay(saved, 10000), /shadow server/);
  f.s.credentials = { host: '127.0.0.1', port: 17959 };
  assert.equal(f.mode.restorePvPForReplay(saved, 10000, new Map([['Exact Player', 'ReplayAttacker']])), true);
  await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2');
  assert.equal(f.mode.pvpStatus().attacks, 2); assert.equal(f.mode.pvpStatus().last_attack_ago_ms, 0);
  f.mode.issue({ action: 'stop' });
});

function monsterFixture(options) {
  const f = fixture(options);
  f.c.room.objects.set(7, { id: 7, name: 'troll', flags: OF.ATTACKABLE, row: 6, col: 6 });
  f.monsterHit = () => f.mode.event({ kind: 'message', text: 'The troll hits you.' });
  f.vanish = () => { f.c.room.objects.delete(2); f.mode.event({ kind: 'vanished', id: 2 }); };
  f.returnPlayer = () => {
    f.c.room.objects.set(2, { id: 2, nameRsc: 2, flags: OF.PLAYER | OF.ATTACKABLE, row: 5, col: 6 });
    f.mode.event({ kind: 'appeared', id: 2 });
  };
  return f;
}
await test('monster cover is below player combat and does not extend the PvP danger timer', async () => {
  const f = monsterFixture(); let shelters = 0;
  f.keeper.takeSafeSpot = async (_why, quarry, opts) => {
    shelters++; assert.equal(quarry, null); assert.equal(opts.recovery, true);
    assert.equal(opts.nearestOnly, true); assert.equal(opts.shelterOnly, true);
    assert.equal(opts.decisionId, f.mode.pvpStatus().decision_id);
    assert.equal(opts.shouldInterrupt(), false);
    return { took: true };
  };
  f.keeper.playDead = f.keeper.takeRecoverySpot = () => assert.fail('no healing or logout during PvP');
  incoming(f); f.monsterHit(); await f.mode.tick();
  assert.equal(shelters, 0); assert.equal(f.sent.at(-1), 'attack:2');
  const dangerUntil = f.mode.pvpStatus().danger_until;
  f.vanish(); f.advance(1500); f.monsterHit(); await f.mode.tick();
  assert.equal(shelters, 1); assert.equal(f.mode.pvpStatus().shelter.status, 'sheltered');
  assert.equal(f.mode.pvpStatus().danger_until, dangerUntil);
  assert.equal(currentSurvivalDecision(f.s).strategy, 'pvp_return_fire');
  assert.equal(currentSurvivalDecision(f.s).phase, 'monster_cover');
  const arrived = f.mode.pvpStatus().shelter.arrived_at;
  assert.ok(arrived); f.advance(1000); f.returnPlayer(); await f.mode.tick();
  assert.equal(f.mode.pvpStatus().shelter.arrived_at, arrived);
  assert.equal(f.mode.pvpStatus().shelter.ended_at, arrived + 1000);
  f.mode.issue({ action: 'stop' });
});
await test('unknown damage, missed monster attacks, poison and departed monsters do not invent pressure', async () => {
  const f = monsterFixture(); f.keeper.takeSafeSpot = () => assert.fail('unconfirmed monster damage');
  incoming(f); f.vanish();
  for (const text of ['You are poisoned.', "You dodge The troll's attack.", 'The troll fails to damage you.',
    'The absent rat hits you.', 'Other Player tells you, "The troll hits you."'])
    f.mode.event({ kind: 'message', text });
  f.c.hp = 10; f.mode.event({ kind: 'stat', name: 'health', value: 10 });
  await f.mode.tick(); assert.equal(f.mode.pvpStatus().last_monster_hit, undefined);
  f.monsterHit(); f.c.room.objects.delete(7); await f.mode.tick();
  f.mode.issue({ action: 'stop' });
});
await test('already at a safe wall stays covered and alert without healing or moving', async () => {
  const f = monsterFixture(); f.keeper.takeSafeSpot = () => assert.fail('already sheltered');
  f.keeper.hold = { room: 38, row: 5, col: 5 };
  f.keeper.adoptRecoveryWall = () => true;
  incoming(f); f.vanish(); f.monsterHit(); await f.mode.tick();
  assert.deepEqual(f.sent, []); assert.equal(f.mode.pvpStatus().shelter.status, 'sheltered');
  assert.equal(currentSurvivalDecision(f.s).phase, 'monster_cover');
  f.returnPlayer(); await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2');
  assert.equal(currentSurvivalDecision(f.s).chosen_refuge, null);
  f.mode.issue({ action: 'stop' });
});
await test('returning assailant fires immediately while the old shelter await is still unwinding', async () => {
  const f = monsterFixture(); let resume, entered;
  const ready = new Promise(r => { entered = r; });
  f.keeper.takeSafeSpot = async (_why, _quarry, opts) => {
    await new Promise(r => { resume = r; entered(); });
    assert.equal(opts.shouldInterrupt(), true);
    await f.s.pacer.submit('move', () => f.sent.push('STALE SHELTER MOVE'));
    return { took: true };
  };
  incoming(f); f.vanish(); f.monsterHit(); const old = f.mode.tick(); await ready;
  f.returnPlayer(); await f.mode.tick();
  assert.equal(f.sent.at(-1), 'attack:2', 'return fire did not wait for the old mover');
  assert.equal(f.mode.pvpStatus().shelter.status, 'interrupted');
  resume(); await old;
  assert.ok(!f.sent.includes('STALE SHELTER MOVE'));
  f.advance(1100); await f.mode.tick(); assert.equal(f.mode.pvpStatus().attacks, 2);
  f.mode.issue({ action: 'stop' });
});
await test('returning player revokes a shelter packet already queued in the real pacer', async () => {
  const f = monsterFixture({ realPacer: true }); let queued;
  const ready = new Promise(r => { queued = r; });
  f.keeper.takeSafeSpot = async () => {
    f.s.pacer.lastSent = Date.now() + 200;
    const move = f.s.pacer.submit('move', () => f.sent.push('QUEUED SHELTER MOVE'));
    queued(); await move; return { took: true };
  };
  incoming(f); f.vanish(); f.monsterHit(); const old = f.mode.tick(); await ready;
  f.returnPlayer(); await f.mode.tick(); await old;
  assert.ok(!f.sent.includes('QUEUED SHELTER MOVE')); assert.equal(f.sent.at(-1), 'attack:2');
  f.mode.issue({ action: 'stop' });
});
await test('no clear wall retains PvP intent and retries without a busy loop or healing', async () => {
  const f = monsterFixture(); let searches = 0;
  f.keeper.takeSafeSpot = async () => { searches++; return { took: false, why: 'blocked by monsters' }; };
  incoming(f); f.vanish(); f.monsterHit(); await f.mode.tick(); await f.mode.tick();
  assert.equal(searches, 1); assert.equal(f.mode.pvpStatus().active, true);
  assert.equal(f.mode.pvpStatus().shelter.status, 'blocked');
  f.advance(1000); await f.mode.tick(); assert.equal(searches, 2);
  f.mode.issue({ action: 'stop' });
});
await test('danger-window expiry revokes the shelter mover before ordinary recovery resumes', async () => {
  const f = monsterFixture(); let resume, entered;
  const ready = new Promise(r => { entered = r; });
  f.keeper.takeSafeSpot = async () => {
    await new Promise(r => { resume = r; entered(); });
    await f.s.pacer.submit('move', () => f.sent.push('EXPIRED MOVE')); return { took: true };
  };
  incoming(f); f.vanish(); f.monsterHit(); const old = f.mode.tick(); await ready;
  f.advance(30000); await f.mode.tick(); resume(); await old;
  assert.equal(f.mode.pvpStatus().outcome, 'attackers_left');
  assert.equal(f.mode.pvpStatus().shelter.status, 'interrupted');
  assert.ok(!f.sent.includes('EXPIRED MOVE')); bodyAuthority(f.s).guard();
});
await test('failed shelter calls retain their reason and use the same bounded retry', async () => {
  const f = monsterFixture(); let attempts = 0;
  f.keeper.takeSafeSpot = async () => { attempts++; throw Error('position read failed'); };
  incoming(f); f.vanish(); f.monsterHit(); await f.mode.tick(); await f.mode.tick();
  assert.equal(attempts, 1); assert.equal(f.mode.pvpStatus().shelter.status, 'blocked');
  assert.equal(f.mode.pvpStatus().shelter.reason, 'position read failed');
  f.advance(1000); await f.mode.tick(); assert.equal(attempts, 2);
  f.returnPlayer(); await f.mode.tick(); assert.equal(f.sent.at(-1), 'attack:2');
  f.mode.issue({ action: 'stop' });
});

console.log(`PASS ${tests} combat mode scenarios`);
