// Offline guard for THE KEEP-OFF LOCK (m59-keepoff.mjs, CombatMode.onPlayerListEvent/keepoffTick):
// a swarm target who LOGS OFF is locked by name at his ghost, waiters are posted, and his login
// sends every idle swarm character after him. Opens no socket, touches no roster.
//
//   node tools/m59-keepoff-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-keepoff-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_GEAR_FILE = join(dir, 'pvp-gear.json');
process.env.M59_SWARM_LEADER_FILE = join(dir, 'swarm-leader.json');
process.env.M59_KEEPOFF_FILE = join(dir, 'keepoff.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ format: 'm59-pvp-gear/1', items: [] }));

const { CombatMode } = await import('./m59-combat-mode.mjs');
const keepoff = await import('./m59-keepoff.mjs');

let tests = 0;
async function test(name, fn) {
  writeFileSync(process.env.M59_KEEPOFF_FILE, JSON.stringify({ format: 'm59-keepoff/1', locks: {} }));
  await tick(250);                                      // past the book's read cache
  await fn(); tests++; console.log(`ok ${name}`);
}
const tick = ms => new Promise(r => setTimeout(r, ms));
const leader = (target, at = Date.now()) =>
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target, how: 'attack', at }));

function fixture({ agent = 't1', name = 'Kermit', swarm = true, room = 38 } = {}) {
  const sent = [];
  const names = new Map([[1, name], [2, 'Morpheus'], [3, 'troll'], [4, 'Gonzo'], [9, 'Morpheus']]);
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() }, rsc: names, spells: [], hp: 100, inventory: [], using: new Set(),
    playersOnline: new Map([[1, { id: 1, name }], [2, { id: 2, name: 'Morpheus' }], [4, { id: 4, name: 'Gonzo' }]]),
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() {}, face() {}, attack(id) { sent.push(`attack:${id}`); }, cast() {}, use() {}, unuse() {}, apply() {}, look() {},
    safety(on) { sent.push('safety:' + on); } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0, job: null, need: () => c,
    world: { room: { num: room }, map: { rooms: { 38: { rows: 50, cols: 70 }, 39: { rows: 50, cols: 70 } } },
      geometry: { rows: 50, cols: 70, standable: () => true,
        path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    travels: [], async travel(map) { this.travels.push(map); this.world.room.num = map; return { arrived: true }; },
    cancelMovement() { this.movementGeneration++; }, async step(col, row) { c.self.row = row; c.self.col = col; } };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.2 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, schedule: () => 0, unschedule: () => {} });
  mode.character = () => name; mode.agentId = agent;
  mode.fleetmate = n => ['kermit', 'gonzo', 'bunsen', 'piggy'].includes(String(n).toLowerCase());
  mode.warEligibility = () => false;
  let held = swarm;
  mode.warbandEligibility = () => held;
  const put = (id, flags, row = 5, col = 6) => c.room.objects.set(id, { id, nameRsc: id, row, col, flags });
  const logoff = id => { c.room.objects.delete(id); const p = c.playersOnline.get(id); c.playersOnline.delete(id);
    mode.event({ kind: 'logged-off', id, name: p?.name }); };
  const logon = (id, nm) => { c.playersOnline.set(id, { id, name: nm }); mode.event({ kind: 'logged-on', id, name: nm }); };
  return { s, c, sent, mode, put, logoff, logon, setSwarm(v) { held = v; } };
}

await test('the swarm target LOGS OFF: locked by name at the square he left', async () => {
  const f = fixture();
  f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY, 7, 9);
  await tick(200); leader(2); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 2);
  f.logoff(2);
  const l = keepoff.lockOf('Morpheus');
  assert.ok(l?.offline, 'locked and offline');
  assert.deepEqual([l.room, l.row, l.col], [38, 7, 9]);
  assert.equal(f.mode.warbandTarget.done, 'logged off');
  f.mode.stop('test');
});

await test('the same, when the room removal is seen before the player-list removal', async () => {
  const f = fixture();
  f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY, 7, 9);
  await tick(200); leader(2); await tick(200);
  await f.mode.warbandTick();
  f.c.room.objects.delete(2); f.c.playersOnline.delete(2);     // no event yet: the tick finds it
  await f.mode.warbandTick();
  assert.ok(keepoff.lockOf('Morpheus')?.offline);
  f.mode.stop('test');
});

await test('gone from the room but still on the player list: NOT a logoff, no lock', async () => {
  const f = fixture();
  f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY);
  await tick(200); leader(2); await tick(200);
  await f.mode.warbandTick();
  f.c.room.objects.delete(2);                                  // walked out, still logged on
  await f.mode.warbandTick();
  assert.equal(f.mode.warbandTarget.done, false, 'given a moment for the list');
  await tick(2100);
  await f.mode.warbandTick();
  assert.equal(f.mode.warbandTarget.done, 'gone from the room');
  assert.equal(keepoff.lockOf('Morpheus'), null);
});

await test('a MONSTER target that vanishes is never locked', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE);
  await tick(200); leader(3); await tick(200);
  await f.mode.warbandTick();
  f.c.room.objects.delete(3);
  await f.mode.warbandTick();
  assert.equal(f.mode.warbandTarget.done, 'gone from the room');
  assert.equal(Object.keys(keepoff.current().locks).length, 0);
});

await test('idle swarm characters in his map take the waiter slots -- two by default, no third', async () => {
  keepoff.markOffline('Morpheus', { room: 38, row: 7, col: 9 });
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: null, at: 0 }));
  await tick(250);
  const a = fixture({ agent: 't1' }), b = fixture({ agent: 't2', name: 'Gonzo' }), c3 = fixture({ agent: 't3', name: 'Piggy' });
  for (const f of [a, b, c3]) await f.mode.warbandTick();
  assert.equal(a.mode.active?.order?.keepoff, 'wait');
  assert.equal(b.mode.active?.order?.keepoff, 'wait');
  assert.equal(c3.mode.active, null, 'a third does not wait');
  assert.deepEqual(Object.keys(keepoff.lockOf('Morpheus').waiters).sort(), ['t1', 't2']);
  // The waiter walks to NEAR the ghost (not onto it) and waits there.
  for (let i = 0; i < 6 && a.mode.active?.phase === 'positioning'; i++) await a.mode.tick();
  assert.equal(a.mode.active.phase, 'waiting');
  assert.ok(Math.hypot(a.c.self.row - 7, a.c.self.col - 9) <= 2, `stood at r${a.c.self.row}c${a.c.self.col}`);
  // He logs back in, at his ghost: the waiter engages.
  a.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY, 7, 9);
  a.logon(2, 'Morpheus');
  a.mode.event({ kind: 'appeared', id: 2 });
  assert.equal(a.mode.active.phase, 'engaging');
  assert.equal(a.mode.active.targetId, 2);
  for (const f of [a, b]) f.mode.stop('test');
});

await test('a waiter across the world waits five seconds for those in his map, then goes', async () => {
  keepoff.markOffline('Morpheus', { room: 39, row: 7, col: 9 });
  await tick(250);
  const far = fixture({ agent: 't4' });
  await far.mode.warbandTick();
  assert.equal(far.mode.active, null, 'first claim is for those in 39');
  const book = keepoff.current(); book.locks.morpheus.offline_at -= 6000;
  writeFileSync(process.env.M59_KEEPOFF_FILE, JSON.stringify(book)); await tick(250);
  await far.mode.warbandTick();
  assert.equal(far.mode.active?.order?.keepoff, 'wait');
  await far.mode.tick();
  assert.deepEqual(far.s.travels, [39], 'travelled to his map');
  far.mode.stop('test');
});

await test('HIS LOGIN: every idle swarm character rushes; one in a PvP fight does not', async () => {
  keepoff.markOffline('Morpheus', { room: 39, row: 7, col: 9 });
  await tick(250);
  const idle = fixture({ agent: 't5' }), monster = fixture({ agent: 't6', name: 'Gonzo' }), pvp = fixture({ agent: 't7', name: 'Piggy' });
  monster.put(3, OF.ATTACKABLE); await tick(200); leader(3); await tick(200);
  await monster.mode.warbandTick();                        // fighting a troll: not PvP
  assert.equal(monster.mode.active?.order?.target, 3);
  pvp.put(9, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY); pvp.c.rsc.set(9, 'Rick Deckard');
  await tick(200); leader(9); await tick(200);
  await pvp.mode.warbandTick(); await pvp.mode.tick();     // fighting a person
  assert.equal(pvp.mode.active?.phase, 'engaging');
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: null, at: 0 }));
  for (const f of [idle, monster, pvp]) f.logon(2, 'Morpheus');
  assert.equal(idle.mode.active?.order?.keepoff, 'rush');
  assert.equal(idle.mode.active.order.map, 39);
  assert.equal(monster.mode.active?.order?.keepoff, 'rush', 'a monster fight gives way');
  assert.equal(pvp.mode.active?.order?.warband, true, 'a PvP fight is kept');
  assert.equal(keepoff.lockOf('Morpheus').offline, false, 'marked online');
  // He logs off again: the rushers let go, and the lock re-arms at the new ghost.
  idle.logoff(2);
  assert.equal(idle.mode.active, null);
  assert.equal(keepoff.lockOf('Morpheus').offline, true);
  for (const f of [monster, pvp]) f.mode.stop('test');
});

await test('never a fleetmate, and nothing at all when not swarm-held', async () => {
  const f = fixture();
  f.mode.lockLoggedOff('Gonzo', { room: 38, row: 1, col: 1, at: Date.now() });
  assert.equal(keepoff.lockOf('Gonzo'), null);
  keepoff.markOffline('Morpheus', { room: 38, row: 7, col: 9 }); await tick(250);
  const off = fixture({ swarm: false });
  off.logon(2, 'Morpheus');
  await off.mode.warbandTick();
  assert.equal(off.mode.active, null);
});

await test('the server refusing him (safety on) lifts the lock; an inn stops the waiting', async () => {
  keepoff.markOffline('Morpheus', { room: 38, row: 5, col: 6 }); await tick(250);
  const f = fixture();
  await f.mode.warbandTick();
  await f.mode.tick(); await f.mode.tick();
  f.put(2, OF.PLAYER | OF.ATTACKABLE, 5, 6);
  f.logon(2, 'Morpheus');
  f.mode.event({ kind: 'appeared', id: 2 });
  assert.equal(f.mode.active.phase, 'engaging');
  f.mode.event({ kind: 'message', text: 'Hey! You almost hit Morpheus! Good thing your safety was on!' });
  await tick(250);
  assert.equal(keepoff.lockOf('Morpheus'), null, 'lifted');
  keepoff.markOffline('Rick Deckard', { room: 38, row: 7, col: 9 }); keepoff.markNoCombat('Rick Deckard'); await tick(250);
  const g = fixture({ agent: 't9' });
  await g.mode.warbandTick();
  assert.equal(g.mode.active, null, 'nobody waits in a no-combat room');
});

await test('his ghost refines the square he will come back to', async () => {
  keepoff.markOffline('Morpheus', { room: 38, row: 7, col: 9 }); await tick(250);
  const f = fixture();
  f.put(9, 0, 8, 10);                                      // "Morpheus", not a player: the ghost
  f.mode.keepoffTrack();
  await tick(250);
  const l = keepoff.lockOf('Morpheus');
  assert.deepEqual([l.row, l.col], [8, 10]);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
