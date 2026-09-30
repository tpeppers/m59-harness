// Offline guard for PvP-only gear and the synchronized wand volley (m59-pvp-gear.mjs and
// CombatMode.pvpGearOn / pvpGearOff / wandVolley). Opens no socket, touches no roster.
//
//   node tools/m59-pvp-gear-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-gear-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_GEAR_FILE = join(dir, 'pvp-gear.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ format: 'm59-pvp-gear/1',
  items: ['shield of the rebel militia', 'plate armor'],
  wands: [{ match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }], volley_ms: 2000 }));

const gear = await import('./m59-pvp-gear.mjs');
const skills = await import('./m59-skills.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const P = OF.PLAYER | OF.ATTACKABLE;

function fixture({ name = 'Kermit', items = [], clock0 = 1_000_000 } = {}) {
  let clock = clock0;
  const sent = [];
  const names = new Map([[1, name], [2, 'Morpheus']]);
  let nid = 100;
  const inventory = items.map(n => { const id = nid++; names.set(id, n); return { id, nameRsc: id }; });
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() }, rsc: names, spells: [], hp: 100, inventory, using: new Set(),
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    use(id) { sent.push(`use:${names.get(id)}`); this.using.add(id); },
    unuse(id) { sent.push(`unuse:${names.get(id)}`); this.using.delete(id); },
    apply(id, on) { sent.push(`apply:${names.get(id)}->${on}`); },
    look() {}, safety(on) { sent.push('safety:' + on); } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0, job: null, need: () => c,
    world: { room: { num: 38 }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step() {} };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock, schedule: () => 0, unschedule: () => {} });
  mode.character = () => name; mode.fleetmate = () => false; mode.warEligibility = () => true;
  c.room.objects.set(2, { id: 2, nameRsc: 2, row: 5, col: 6, flags: P | OF.ENEMY });
  return { s, c, sent, mode, advance(ms) { clock += ms; }, at(ms) { clock = ms; }, get clock() { return clock; } };
}

await test('a PvP-only piece is invisible to farming and visible in a PvP fight', () => {
  const f = fixture({ items: ['plate armor', 'leather armor'] });
  const names = () => Object.values(skills.armourOf(f.c)).flat().map(r => r.name);
  assert.ok(!names().includes('plate armor'), 'farming never considers the PvP plate');
  assert.ok(names().includes('leather armor'));
  f.c.pvpGearActive = true;
  assert.ok(names().includes('plate armor'), 'in a PvP fight it is wearable');
});

await test('a PvP-only weapon is never a farming weapon', () => {
  const f = fixture({ items: ['plate armor'] });
  assert.equal(gear.isPvpOnly('Plate Armor of Doom'), true);
  assert.equal(gear.isPvpOnly('leather armor'), false);
  assert.equal(gear.isPvpOnly('long sword'), false);
});

await test('a PvP fight puts the PvP gear on and the end of it takes it off', async () => {
  const f = fixture({ items: ['shield of the rebel militia', 'plate armor', 'leather armor'] });
  f.mode.event({ kind: 'appeared', id: 2 });              // a war-marked enemy: engage
  assert.ok(f.mode.active?.pvp);
  await f.mode.tick();
  assert.ok(f.sent.includes('use:shield of the rebel militia') && f.sent.includes('use:plate armor'), `sent ${f.sent}`);
  assert.ok(!f.sent.includes('use:leather armor'));
  assert.equal(f.c.pvpGearActive, true);
  f.mode.stop('test');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(f.sent.includes('unuse:shield of the rebel militia') && f.sent.includes('unuse:plate armor'),
    `sent ${f.sent}; error ${f.mode.pvpGearError}`);
  assert.equal(f.c.pvpGearActive, false);
});

await test('a lightning wand fires on the beat, faces the target, and holds the swing between beats', async () => {
  const f = fixture({ items: ['lightning wand'] });
  f.at(2_000_000);                                       // exactly on a beat boundary
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('apply:lightning wand->2'), `sent ${f.sent}`);
  assert.ok(f.sent.includes('face'));
  assert.ok(!f.sent.some(x => x.startsWith('attack:')), 'no melee: it would take the attack timer');
  const zaps = () => f.sent.filter(x => x.startsWith('apply:')).length;
  f.advance(900); await f.mode.tick();
  assert.equal(zaps(), 1, 'same beat: no second zap');
  assert.ok(!f.sent.some(x => x.startsWith('attack:')));
  f.advance(1200); await f.mode.tick();                   // next beat
  assert.equal(zaps(), 2);
  f.mode.stop('test');
});

await test('a vampiric wand fires on the beat and melee continues between beats', async () => {
  const f = fixture({ items: ['wand of vampiric shock'] });
  f.at(4_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('apply:wand of vampiric shock->2'), `sent ${f.sent}`);
  assert.ok(f.sent.some(x => x.startsWith('attack:')), 'no attack timer: it swings as well');
  f.mode.stop('test');
});

await test('two keepers in the fight fire on the SAME beat', async () => {
  const a = fixture({ name: 'Kermit', items: ['lightning wand'] }), b = fixture({ name: 'Gonzo', items: ['lightning wand'] });
  a.at(6_000_300); b.at(6_001_700);                        // 1.4s apart, same 2s beat
  a.mode.event({ kind: 'appeared', id: 2 }); b.mode.event({ kind: 'appeared', id: 2 });
  await a.mode.tick(); await b.mode.tick();
  assert.equal(gear.beatOf(a.clock), gear.beatOf(b.clock));
  assert.ok(a.sent.includes('apply:lightning wand->2') && b.sent.includes('apply:lightning wand->2'));
  a.mode.stop('test'); b.mode.stop('test');
});

await test('a broken wand is never picked again; an unidentified "wand" never matches', async () => {
  const f = fixture({ items: ['wand of vampiric shock', 'wand'] });
  f.at(8_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  f.mode.event({ kind: 'message', text: 'Your wand of vampiric shock is broken.' });
  f.advance(2100); await f.mode.tick();
  assert.equal(f.sent.filter(x => x.startsWith('apply:')).length, 1, `sent ${f.sent}`);
  assert.ok(!f.sent.includes('apply:wand->2'));
  f.mode.stop('test');
});

await test('no wands, no config: the fight is exactly the melee it was', async () => {
  const f = fixture({ items: [] });
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.some(x => x.startsWith('attack:')));
  assert.ok(!f.sent.some(x => x.startsWith('apply:') || x.startsWith('use:')));
  f.mode.stop('test');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
