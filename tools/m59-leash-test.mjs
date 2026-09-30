// Offline guard for THE SWARM LEASH (m59-war.mjs readLeash/unleash/holdLeash, CombatMode.warLeashed):
// war mode AND swarming, the fleet does not engage an enemy on sight until the operator says "go",
// attacks something, or his character dies. Opens no socket, touches no roster.
//
//   node tools/m59-leash-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-leash-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_WAR_LEASH_FILE = join(dir, 'war-leash.json');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_GEAR_FILE = join(dir, 'pvp-gear.json');
process.env.M59_SWARM_LEADER_FILE = join(dir, 'swarm-leader.json');
process.env.M59_KEEPOFF_FILE = join(dir, 'keepoff.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ format: 'm59-pvp-gear/1', items: [] }));

const { CombatMode } = await import('./m59-combat-mode.mjs');
const war = await import('./m59-war.mjs');

const tick = ms => new Promise(r => setTimeout(r, ms));
let tests = 0;
async function test(name, fn) {
  writeFileSync(process.env.M59_WAR_LEASH_FILE, '{}');
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: null, at: 0 }));
  await tick(300);                                     // past both read caches
  await fn(); tests++; console.log(`ok ${name}`);
}

function fixture({ swarm = true } = {}) {
  const names = new Map([[1, 'Kermit'], [2, 'Morpheus'], [4, 'Gonzo']]);
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() }, rsc: names, spells: [], inventory: [], using: new Set(),
    vitals() { return { health: { value: 100, max: 100 } }; },
    stand() {}, face() {}, attack() {}, cast() {}, use() {}, unuse() {}, apply() {}, look() {}, safety() {} };
  const s = { name: 'Kermit', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: null, need: () => c, world: { room: { num: 38 } }, cancelMovement() {}, pacer: { async submit() {}, wake() {} } };
  const mode = s.combat = new CombatMode(s, { keeper: () => ({ policy: { fleeBelow: 0.2 }, revive() {} }),
    schedule: () => 0, unschedule: () => {} });
  mode.character = () => 'Kermit'; mode.agentId = 't1';
  mode.fleetmate = n => ['kermit', 'gonzo'].includes(String(n).toLowerCase());
  mode.warEligibility = () => true;
  mode.sentinelEligibility = () => true;
  let held = swarm;
  mode.warbandEligibility = () => held;
  mode.leaderCharacter = () => held ? 'Gonzo' : null;
  c.room.objects.set(2, { id: 2, nameRsc: 2, row: 5, col: 7, flags: OF.PLAYER | OF.ATTACKABLE | OF.ENEMY });
  const scan = () => { mode.scanForEnemies(c); return !!mode.active?.pvp; };
  return { c, mode, scan, setSwarm(v) { held = v; } };
}

await test('not swarming: an enemy at war is engaged on sight, as before', async () => {
  const f = fixture({ swarm: false });
  assert.equal(f.scan(), true);
  f.mode.stop('test');
});

await test('swarming: the enemy is REPORTED, not engaged, until the operator says so', async () => {
  const f = fixture();
  assert.equal(f.scan(), false);
  assert.equal(f.mode.warLast?.basis, 'sighted', 'a sentinel report');
  assert.equal(f.mode.warStatus().leash.leashed, true);
});

await test('the operator says "go": unleashed, and every swarm character reads it from the file', async () => {
  const f = fixture(), g = fixture();
  f.scan(); g.scan();
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'go' });
  assert.equal(f.scan(), true);
  await tick(300);
  assert.equal(g.scan(), true, 'heard by one, obeyed by all');
  f.mode.stop('test'); g.mode.stop('test');
});

await test('"go north", "I have to go", or somebody else saying go: not an order', async () => {
  const f = fixture();
  f.scan();
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'go north' });
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'I have to go' });
  f.mode.event({ kind: 'said', name: 'Morpheus', text: 'go' });
  assert.equal(f.scan(), false);
  assert.equal(war.isGoOrder('GO GO!'), true);
});

await test('the operator ATTACKING anything unleashes', async () => {
  const f = fixture();
  f.scan();
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: 77, how: 'attack', at: Date.now() }));
  await tick(300);
  assert.equal(f.scan(), true);
  assert.equal(war.readLeash().unleash_why, 'the operator attacked');
  f.mode.stop('test');
});

await test('an attack from BEFORE the swarm started does not unleash it', async () => {
  const f = fixture({ swarm: false });
  f.scan(); f.mode.stop('test');                        // boots outside the swarm
  writeFileSync(process.env.M59_SWARM_LEADER_FILE, JSON.stringify({ target: 77, how: 'attack', at: Date.now() - 1000 }));
  await tick(300);
  f.setSwarm(true);
  assert.equal(f.scan(), false);
});

await test('the operator\'s character DYING unleashes -- murdered, or slaughtered in guild combat', async () => {
  for (const text of ['### Gonzo has been murdered in cold blood.',
    '### Gonzo of the Second Swines has been slaughtered by Morpheus of the Human Resistance in guild combat.']) {
    writeFileSync(process.env.M59_WAR_LEASH_FILE, '{}'); await tick(300);
    const f = fixture();
    f.scan();
    f.mode.event({ kind: 'message', text: '### Kermit has been murdered in cold blood.' });   // not him
    assert.equal(f.scan(), false);
    f.mode.event({ kind: 'message', text });
    assert.equal(f.scan(), true, text);
    f.mode.stop('test');
  }
});

await test('"hold" puts the leash back on', async () => {
  const f = fixture();
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'go' });
  assert.equal(f.scan(), true); f.mode.stop('test');
  await tick(5);
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'hold' });
  assert.equal(f.scan(), false);
});

await test('a fleetmate\'s alarm does not pull a leashed character in', async () => {
  const f = fixture();
  f.c.room.objects.delete(2);
  assert.equal(f.mode.onWarAlarm({ enemy: 'Morpheus', room: 38, reporter: 'Piggy', basis: 'engaged', at: Date.now() }), false);
  f.mode.event({ kind: 'said', name: 'Gonzo', text: 'go' });
  assert.equal(f.mode.onWarAlarm({ enemy: 'Morpheus', room: 38, reporter: 'Piggy', basis: 'engaged', at: Date.now() }), true);
  f.mode.stop('test');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
