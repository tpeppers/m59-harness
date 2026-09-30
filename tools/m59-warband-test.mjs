// Offline guard for WARBAND COMBAT (CombatMode.warbandTick / warbandBuff): with the swarm on, a
// keeper focus-fires the leader's target (player or monster) and buffers keep every ally buffed.
// Opens no socket, touches no roster.
//
//   node tools/m59-warband-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-warband-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_GEAR_FILE = join(dir, 'pvp-gear.json');
process.env.M59_SWARM_LEADER_FILE = join(dir, 'swarm-leader.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ format: 'm59-pvp-gear/1', items: [],
  warband_buffs: { t5: ['bless', 'super strength'] } }));

const { CombatMode } = await import('./m59-combat-mode.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const leader = (target, at = Date.now()) =>
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target, how: 'attack', at }));
const tick = ms => new Promise(r => setTimeout(r, ms));

function fixture({ agent = 't1', name = 'Kermit', swarm = true, spells = [] } = {}) {
  const sent = [];
  const names = new Map([[1, name], [2, 'Morpheus'], [3, 'troll'], [4, 'Gonzo'], [5, 'Innocent Bystander']]);
  let nid = 50;
  const spellObjs = spells.map(n => { const id = nid++; names.set(id, n); return { id, nameRsc: id }; });
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() }, rsc: names, spells: spellObjs, hp: 100, inventory: [], using: new Set(),
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    cast(id, targets) { sent.push(`cast:${names.get(id)}->${targets.join(',')}`); },
    use() {}, unuse() {}, apply() {}, look() {}, safety(on) { sent.push('safety:' + on); } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0, job: null, need: () => c,
    world: { room: { num: 38 }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; }, async step() {} };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.2 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, schedule: () => 0, unschedule: () => {} });
  mode.character = () => name; mode.agentId = agent;
  mode.fleetmate = n => ['kermit', 'gonzo', 'bunsen'].includes(String(n).toLowerCase());
  mode.warEligibility = () => false;                     // isolate the warband from the war response
  let held = swarm;
  mode.warbandEligibility = () => held;
  const put = (id, flags, row = 5, col = 6) => c.room.objects.set(id, { id, nameRsc: id, row, col, flags });
  return { s, c, sent, mode, put, setSwarm(v) { held = v; } };
}

await test('swarm on: the leader\'s MONSTER target is focus-fired', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE);                               // a troll, not a player
  leader(3);
  await f.mode.warbandTick();
  assert.ok(f.mode.active?.order?.warband, 'a warband order owns the body');
  assert.equal(f.mode.active.order.target, 3);
  await f.mode.tick();
  assert.ok(f.sent.includes('attack:3'), `sent ${f.sent} | active ${f.mode.active?.phase} | last ${f.mode.last?.reason}`);
  assert.ok(!f.sent.includes('safety:false'), 'a warband attack never turns safety off');
  f.mode.stop('test');
});

await test('swarm on: the leader\'s PLAYER target is focus-fired', async () => {
  const f = fixture();
  f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY);
  await tick(200); leader(2); await tick(200);           // past the leader file's 150ms re-read
  await f.mode.warbandTick();
  await f.mode.tick();
  assert.ok(f.sent.includes('attack:2'), `sent ${f.sent}`);
  f.mode.stop('test');
});

await test('not swarm-held: the leader file is ignored', async () => {
  const f = fixture({ swarm: false });
  f.put(3, OF.ATTACKABLE); await tick(200); leader(3); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null);
});

await test('an entry from a previous session (over 15 minutes) is never taken up; one elsewhere waits', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE);
  await tick(200); leader(3, Date.now() - 20 * 60_000); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'ancient: object ids recycle');
  await tick(200); leader(999); await tick(200);           // not in our room
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'elsewhere: nothing to swing at here');
  f.put(999, OF.ATTACKABLE);                                // it walks in
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 999, 'engaged the moment it is here');
  f.mode.stop('test');
});

await test('the target STANDS after the leader stops swinging, until it dies', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE);
  await tick(200); leader(3, Date.now() - 5 * 60_000); await tick(200);   // one swing, five minutes ago
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 3, 'still the target');
  f.c.room.objects.delete(3);                             // it dies
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'dead: the order ends');
  f.put(3, OF.ATTACKABLE);                                // the same id shows up again
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'a finished target is not re-engaged on its own');
  await tick(200); leader(3); await tick(200);            // the leader attacks it again
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 3, 're-armed by a new swing');
  f.mode.stop('test');
});

await test('a recycled id (same number, different name) is not the target', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE);                                // "troll"
  await tick(200); leader(3); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 3);
  f.mode.stop('test');
  f.c.rsc.set(3, 'heartstone');                           // the server reused the id
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null);
});

await test('the leader switching target switches the warband; losing it ends the order', async () => {
  const f = fixture();
  f.put(3, OF.ATTACKABLE); f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY);
  await tick(200); leader(3); await tick(200); await f.mode.warbandTick();
  assert.equal(f.mode.active.order.target, 3);
  await tick(200); leader(2); await tick(200); await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 2, 'switched');
  f.setSwarm(false); await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'the swarm ended, so did the warband order');
});

await test('never a fleetmate or guildmate, even if the leader swings at one -- and it is dropped', async () => {
  const f = fixture();
  f.put(4, OF.PLAYER | OF.ATTACKABLE);                   // Gonzo is ours
  await tick(200); leader(4); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null);
  assert.equal(f.mode.warbandTarget?.done, 'a fleetmate');
  f.put(6, OF.PLAYER | OF.ATTACKABLE | OF.GUILDMATE); f.c.rsc.set(6, 'Some Guildmate');
  await tick(200); leader(6); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'a guildmate is never a target either');
});

await test('an innocent the server refuses is dropped, not re-issued every tick', async () => {
  const f = fixture();
  f.put(5, OF.PLAYER | OF.ATTACKABLE);
  await tick(200); leader(5); await tick(200);
  await f.mode.warbandTick();
  assert.equal(f.mode.active?.order?.target, 5);
  await f.mode.tick();
  f.mode.event({ kind: 'message', text: 'Hey! You almost hit Innocent Bystander! Good thing your safety was on!' });
  assert.equal(f.mode.active, null);
  await f.mode.warbandTick();
  assert.equal(f.mode.active, null, 'not re-issued');
});

await test('a warband buffer buffs EVERY ally in the room, itself and the leader included', async () => {
  const f = fixture({ agent: 't5', name: 'Bunsen', spells: ['bless', 'super strength'] });
  f.put(4, OF.PLAYER | OF.ATTACKABLE);                   // Gonzo, an ally
  f.put(2, OF.PLAYER | OF.ATTACKABLE | OF.ENEMY);        // Morpheus: never buffed
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: null, at: 0 }));
  await tick(200);
  await f.mode.warbandTick();
  const casts = f.sent.filter(x => x.startsWith('cast:'));
  assert.deepEqual(casts.sort(), ['cast:bless->1', 'cast:bless->4', 'cast:super strength->1', 'cast:super strength->4'].sort(), `sent ${f.sent}`);
  f.sent.length = 0;
  await f.mode.warbandTick();
  assert.equal(f.sent.filter(x => x.startsWith('cast:')).length, 0, 'not again inside warband_rebuff_ms');
});

await test('a character that is not a named buffer casts nothing', async () => {
  const f = fixture({ agent: 't1', spells: ['bless'] });
  f.put(4, OF.PLAYER | OF.ATTACKABLE);
  await tick(200); await f.mode.warbandTick();
  assert.equal(f.sent.filter(x => x.startsWith('cast:')).length, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
