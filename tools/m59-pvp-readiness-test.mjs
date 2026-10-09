// Offline packet-boundary regressions: no sockets, roster or private strategies.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OF } from './m59-parse.mjs';
import { compile } from './m59-spells.mjs';
import { loadMap } from './m59-map.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { lineOfSight } from './m59-safespots.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-readiness-'));
process.env.M59_PVP_GEAR_FILE = join(dir, 'gear.json');
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_SPELLS = join(dir, 'spells.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ wands: [
  { match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }], volley_ms: 2000 }));
writeFileSync(process.env.M59_SPELLS, JSON.stringify({ spells: [
  { name: 'hold', parent: 'Spell', post_cast_ms: 2000 },
  { name: 'enfeeble', parent: 'Spell', post_cast_ms: 1000 },
  { name: 'lightning bolt', parent: 'BoltSpell', post_cast_ms: 2000 }] }));
const { CombatMode, safeCombatStep } = await import('./m59-combat-mode.mjs');
let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log('ok ' + name); }
const body = ({ row, col }) => ({ row, col, x: col * 64 + 32, y: row * 64 + 32 });

function fixture({ wand = 'lightning wand', privateWand = false } = {}) {
  let now = 1000100;
  const sent = [];
  const c = { selfId: 1, self: { id: 1, ...body({ row: 5, col: 5 }), degrees: 180, flags: 0 },
    room: { id: 3800, flags: 8, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Enemy'], [3, wand], [4, 'hold'], [5, 'lightning bolt'], [6, 'enfeeble']]),
    inventory: wand ? [{ id: 3, nameRsc: 3, translation: privateWand ? 223 : 0 }] : [],
    spells: [{ id: 4, nameRsc: 4 }, { id: 5, nameRsc: 5 }, { id: 6, nameRsc: 6 }], using: new Set(),
    vitals: () => ({ health: { value: 100, max: 100 } }),
    stand() { sent.push({ kind: 'stand', at: now }); },
    face(degrees) { this.self.degrees = degrees; sent.push({ kind: 'face', degrees, at: now }); },
    apply(wand, target) { sent.push({ kind: 'apply', wand, target, at: now }); },
    cast(spell, targets) { this.lastCastSent = { at: now, name: this.rsc.get(spell) }; sent.push({ kind: 'cast', spell, targets, at: now }); },
    attack(target) { (this.attackLog ??= []).push({ at: now, id: target }); sent.push({ kind: 'attack', target, at: now }); },
    safety() {},
  };
  c.room.objects.set(2, { id: 2, nameRsc: 2, ...body({ row: 5, col: 6 }), flags: OF.PLAYER | OF.ATTACKABLE });
  const geo = { rows: 50, cols: 70, canMove: () => true, standable: () => true,
    path(r, col, tr, tc, { avoid }) {
      const next = { row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) };
      return { found: !avoid.has(`${next.row},${next.col}`), steps: [next] };
    } };
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    need: () => c,
    world: { room: { num: 38, flags: 8 }, geometry: geo },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { sent.push({ kind: 'move', row, col }); Object.assign(c.self, body({ row, col })); return { moved: true }; },
    async stepFine(x, y) { sent.push({ kind: 'move', x, y }); Object.assign(c.self, { x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) }); return { moved: true }; },
  };
  let beforePacket = null;
  s.pacer = { async submit(kind, fn) {
    const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); beforePacket?.(kind); return run();
  } };
  const mode = s.combat = new CombatMode(s, { now: () => now, schedule: () => 0, unschedule() {} });
  mode.wandStrategies = { strategies: privateWand ? [{ name: 'private-fixture', enabled: true,
    pvpWand: ctx => ({ fire: ctx.unidentified[0].id, hold: true, face: false }) }] : [] };
  const start = (sequence) => { mode.issue({ action: 'attack', target: 'Enemy', sequence });
    // Exercise the common PvP path without generating any hostility or war records.
    mode.targetAtWar = () => true;
  };
  return { c, s, mode, sent, start, geo, advance(ms) { now += ms; },
    packets: kind => sent.filter(p => p.kind === kind), target: () => c.room.objects.get(2),
    before(fn) { beforePacket = fn; } };
}

try {
  await test('holding a decoded lightning wand cannot freeze a blocked-sight approach', async () => {
    const f = fixture({ wand: 'wand', privateWand: true });
    let hasSight = false;
    f.geo.canMove = () => hasSight;
    f.mode.crossDoorToward = async () => { hasSight = true; f.sent.push({ kind: 'door' }); return true; };
    f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 0);
    assert.equal(f.packets('door').length, 1);
    assert.equal(f.mode.lastVolleyBeat, undefined, 'an approach consumes no volley beat');
    await f.mode.tick();
    assert.equal(f.packets('apply').length, 1);
    assert.equal(f.packets('face').length, 1, 'mechanic overrides private face:false');
    assert.equal(f.packets('attack').length, 0);
    f.mode.stop('test');
  });
  await test('clock beat boundaries cannot fire a lightning wand before its 2s cooldown', async () => {
    const f = fixture(); f.advance(1800); f.start(); await f.mode.tick();
    f.advance(200); await f.mode.tick();
    assert.equal(f.packets('apply').length, 1, 'new beat only 200ms after the shot');
    f.advance(1799); await f.mode.tick(); assert.equal(f.packets('apply').length, 1);
    f.advance(1); await f.mode.tick(); assert.equal(f.packets('apply').length, 2);
    f.mode.stop('test');
  });
  await test('an opaque non-yellow wand selected by a private hook cannot borrow SpecialWand sight exceptions', async () => {
    const f = fixture({ wand: 'wand', privateWand: true });
    f.c.inventory[0].translation = 201; // encoded blue; not a proven timer-free SpecialWand
    f.geo.canMove = () => false;
    f.mode.crossDoorToward = async () => { f.sent.push({ kind: 'door' }); return true; };
    f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 0); assert.equal(f.packets('door').length, 1);
    f.mode.stop('test');
  });
  await test('a wand hold closes the gap while firing and on cooldown beats', async () => {
    const f = fixture(); Object.assign(f.target(), body({ row: 5, col: 15 }));
    f.start(); await f.mode.tick(); assert.equal(f.packets('apply').length, 1);
    assert.equal(f.packets('move').length, 1);
    await f.mode.tick(); assert.equal(f.packets('apply').length, 1);
    assert.equal(f.packets('move').length, 2); assert.equal(f.packets('attack').length, 0);
    f.mode.stop('test');
  });
  await test('moving behind a wall while apply is queued skips the packet and retries from a fresh approach', async () => {
    const f = fixture(); f.start();
    f.before(kind => { if (kind === 'cast') f.geo.canMove = () => false; });
    await f.mode.tick(); assert.equal(f.packets('apply').length, 0);
    assert.equal(f.mode.lastWandFireAt, undefined); assert.equal(f.mode.active.zaps, undefined);
    f.before(null); f.mode.crossDoorToward = async () => { f.geo.canMove = () => true; f.sent.push({ kind: 'door' }); return true; };
    await f.mode.tick(); assert.equal(f.packets('door').length, 1);
    await f.mode.tick(); assert.equal(f.packets('apply').length, 1); f.mode.stop('test');
  });
  await test('target crosses behind us between turn and apply: no blind packet or cooldown claim', async () => {
    const f = fixture(); f.target().col = 7; f.start();
    f.before(kind => { if (kind === 'cast') Object.assign(f.target(), body({ row: 5, col: 3 })); });
    await f.mode.tick(); assert.equal(f.packets('apply').length, 0);
    assert.equal(f.mode.lastVolleyBeat, undefined);
    f.before(null); await f.mode.tick(); assert.equal(f.packets('apply').length, 1);
    assert.equal(f.packets('face').at(-1).degrees, 180); f.mode.stop('test');
  });
  await test('target disappears or id is recycled while queued: no wrong-target apply', async () => {
    for (const replacement of [null, { id: 2, nameRsc: 1, ...body({ row: 5, col: 6 }), flags: OF.PLAYER | OF.ATTACKABLE }]) {
      const f = fixture(); f.start();
      f.before(kind => { if (kind === 'cast') replacement ? f.c.room.objects.set(2, replacement) : f.c.room.objects.delete(2); });
      await f.mode.tick(); assert.equal(f.packets('apply').length, 0); f.mode.stop('test');
    }
  });
  await test('a previous melee swing owns the shared timer even when a fresh combat order replaces it', async () => {
    const f = fixture({ wand: null }); f.start(); await f.mode.tick();
    assert.equal(f.packets('attack').length, 1);
    f.c.inventory = [{ id: 3, nameRsc: 3 }]; f.c.rsc.set(3, 'lightning wand');
    f.start(); await f.mode.tick(); assert.equal(f.packets('apply').length, 0);
    f.advance(1000); await f.mode.tick(); assert.equal(f.packets('apply').length, 1); f.mode.stop('test');
  });
  await test('base spell and attack spell reserve their different inherited timers for a subsequent wand', async () => {
    for (const [spell, ms] of [['enfeeble', 1000], ['hold', 2000], ['lightning bolt', 2000]]) {
      const f = fixture({ wand: null });
      f.start([{ do: 'cast', spell }]); await f.mode.tick(); assert.equal(f.packets('cast').length, 1);
      f.c.inventory = [{ id: 3, nameRsc: 3 }]; f.c.rsc.set(3, 'lightning wand'); f.start();
      f.advance(ms - 1); await f.mode.tick(); assert.equal(f.packets('apply').length, 0);
      f.advance(1); await f.mode.tick(); assert.equal(f.packets('apply').length, 1); f.mode.stop('test');
    }
  });
  await test('targeted opener establishes sight and faces before casting, without stamping an unsent cast', async () => {
    const f = fixture(); f.geo.canMove = () => false;
    f.mode.wandStrategies = { strategies: [{ name: 'caster', enabled: true, pvpOpener: () => ({ cast: 'hold' }) }] };
    f.mode.crossDoorToward = async () => { f.geo.canMove = () => true; f.sent.push({ kind: 'door' }); return true; };
    f.start(); await f.mode.tick(); assert.equal(f.packets('cast').length, 0);
    assert.equal(f.mode.active.openerAt, undefined); assert.equal(f.packets('door').length, 1);
    await f.mode.tick(); assert.equal(f.packets('cast').length, 1);
    assert.equal(f.packets('face').length, 1); assert.equal(f.packets('apply').length, 0); f.mode.stop('test');
  });
  await test('room and self openers do not need line of sight to the enemy', async () => {
    for (const target of ['none', 'self']) {
      const f = fixture(); f.geo.canMove = () => false;
      f.mode.wandStrategies = { strategies: [{ name: 'buff', enabled: true, pvpOpener: () => ({ cast: 'hold', target }) }] };
      f.start(); await f.mode.tick(); assert.equal(f.packets('cast').length, 1);
      assert.deepEqual(f.packets('cast')[0].targets, target === 'none' ? [] : [1]); f.mode.stop('test');
    }
  });
  await test('vampiric shock can fire behind a wall and during a lightning timer; melee still waits', async () => {
    const f = fixture({ wand: 'wand of vampiric shock' }); f.geo.canMove = () => false;
    f.mode.attackReadyAt = 1002100; f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 1); assert.equal(f.packets('attack').length, 0);
    f.advance(2000); await f.mode.tick(); assert.equal(f.packets('attack').length, 1); f.mode.stop('test');
  });
  await test('melee uses its actual range and facing gate at dispatch', async () => {
    const f = fixture({ wand: null }); f.start();
    f.before(kind => { if (kind === 'attack') Object.assign(f.target(), body({ row: 5, col: 12 })); });
    await f.mode.tick(); assert.equal(f.packets('attack').length, 0);
    f.before(null); await f.mode.tick(); assert.ok(f.packets('move').length); f.mode.stop('test');
  });
  await test('melee pursues a departing target while its swing is cooling down', async () => {
    const f = fixture({ wand: null }); f.start(); await f.mode.tick();
    Object.assign(f.target(), body({ row: 5, col: 12 }));
    f.advance(100); await f.mode.tick();
    assert.equal(f.packets('attack').length, 1); assert.equal(f.packets('move').length, 1);
    f.mode.stop('test');
  });
  await test('a stationary target with an old movement timestamp remains attackable', async () => {
    const f = fixture(); f.target().posAt = 1; f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 1); f.mode.stop('test');
  });
  await test('LOS walks beyond 64 steps and remains directional', () => {
    const geo = { canMove: (r, c, tr, tc) => !(c === 80 && tc === 81) };
    assert.equal(lineOfSight(geo, 5, 1, 5, 100), false);
    assert.equal(lineOfSight(geo, 5, 100, 5, 1), true);
  });
  const map = loadMap(); attachStepMasks(map);
  for (const sample of [
    { name: 'Lew / Optimus Prime, Oct 8 23:28Z', room: 38, me: { row: 8, col: 13, x: 880, y: 544 }, target: { row: 13, col: 1, x: 112, y: 835 }, blocked: true },
    { name: 'Zoot / SUPERHOTTIES, Oct 8 15:44Z', room: 38, me: { row: 8, col: 34, x: 2208, y: 528 }, target: { row: 15, col: 17, x: 1120, y: 992 } },
    { name: 'Gonzo / Rick Deckard, Oct 7 20:43Z', room: 102, me: { row: 46, col: 31, x: 2016, y: 2976 }, target: { row: 36, col: 41, x: 2634, y: 2366 } },
    { name: 'Zoot / SUPERHOTTIES, Oct 8 16:32Z', room: 599, me: { row: 45, col: 10, x: 672, y: 2896 }, target: { row: 4, col: 63, x: 4064, y: 288 }, stalls: true },
    { name: 'Zoot / Optimus Prime, Oct 8 20:26Z', room: 578, me: { row: 23, col: 45, x: 2927, y: 1484 }, target: { row: 46, col: 18, x: 1184, y: 2976 }, stalls: true },
    { name: 'Kermit / Rick Deckard, Oct 8 16:17Z', room: 2, me: { row: 1, col: 40, x: 2620, y: 80 }, target: { row: 21, col: 3, x: 224, y: 1376 } },
  ]) await test('historical approach or explicitly retained geometry limit: ' + sample.name, async () => {
    const f = fixture({ wand: 'wand', privateWand: true });
    f.s.world = { map, room: map.rooms[sample.room], geometry: sharedRoomGeometry(map.rooms[sample.room]) };
    Object.assign(f.c.self, sample.me); Object.assign(f.target(), sample.target);
    f.s.crossSameRoomDoor = async door => {
      f.sent.push({ kind: 'door', row: door.row, col: door.col });
      Object.assign(f.c.self, body({ row: door.arriveRow, col: door.arriveCol })); return { crossed: true };
    };
    f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 0);
    if (sample.blocked) {
      assert.equal(f.packets('door').length + f.packets('move').length, 0);
      assert.match(f.mode.last.reason, /no safe approach to player/);
      f.mode.stop('test'); return;
    }
    assert.ok(f.packets('door').length || f.packets('move').length, 'recorded fine body has a legal first approach');
    for (let i = 0; i < 200 && f.mode.active && !f.packets('apply').length; i++) await f.mode.tick();
    if (sample.stalls) {
      assert.equal(f.packets('apply').length, 0, 'disproved fine legs must not turn into blind attacks');
      assert.match(f.mode.last.reason, /no safe approach to player/);
    } else {
      assert.equal(f.packets('apply').length, 1, 'static recorded target becomes attackable');
      assert.ok(f.mode.active);
    }
    f.mode.stop('test');
  });
  await test('fine pursuit coalesces a legal straight prefix instead of sending quarter-square moves at 1Hz', () => {
    const f = fixture(); f.s.world.geometry = sharedRoomGeometry(map.rooms[150]);
    Object.assign(f.c.self, body({ row: 31, col: 68 }));
    const next = safeCombatStep(f.s, { row: 11, col: 60, sight: true }, { fineBody: true });
    assert.ok(next?.fine);
    const distance = Math.hypot(next.x - f.c.self.x, next.y - f.c.self.y);
    assert.ok(distance >= 48 && distance <= 96, 'ordinary-step speed with a collision-proven short segment');
    assert.equal(safeCombatStep(f.s, { row: 11, col: 60, sight: true })?.fine, undefined,
      'ambush staging and swarm callers retain a square waypoint they can consume');
  });
  await test('recorded Bunsen position in room 150 pursues instead of firing at a blocked Morpheus square', async () => {
    const f = fixture({ wand: 'wand', privateWand: true });
    f.s.world = { map, room: map.rooms[150], geometry: sharedRoomGeometry(map.rooms[150]) };
    Object.assign(f.c.self, body({ row: 31, col: 68 }));
    Object.assign(f.target(), body({ row: 11, col: 60 }));
    f.start(); await f.mode.tick();
    assert.equal(f.packets('apply').length, 0); assert.equal(f.packets('move').length, 1);
    for (let i = 0; i < 160 && !f.packets('apply').length; i++) await f.mode.tick();
    assert.equal(f.packets('apply').length, 1, 'the real fine route establishes sight and fires');
    assert.ok(f.mode.active, 'combat retains ownership'); f.mode.stop('test');
  });
  await test('wand holders traverse both real Castle doors, replan after each, then fire from sight', async () => {
    const f = fixture({ wand: 'wand', privateWand: true });
    f.s.world = { map, room: map.rooms[38], geometry: sharedRoomGeometry(map.rooms[38]) };
    Object.assign(f.c.self, body({ row: 7, col: 4 }));
    Object.assign(f.target(), body({ row: 7, col: 26 }));
    f.s.crossSameRoomDoor = async door => {
      f.sent.push({ kind: 'door', row: door.row, col: door.col });
      Object.assign(f.c.self, body({ row: door.arriveRow, col: door.arriveCol })); return { crossed: true };
    };
    f.start(); await f.mode.tick(); assert.deepEqual(f.packets('door').map(d => ({ row: d.row, col: d.col })), [{ row: 8, col: 4 }]);
    assert.equal(f.packets('apply').length, 0);
    await f.mode.tick(); assert.equal(f.packets('door').length, 2);
    assert.deepEqual({ row: f.packets('door')[1].row, col: f.packets('door')[1].col }, { row: 9, col: 26 });
    await f.mode.tick(); assert.equal(f.packets('apply').length, 1); f.mode.stop('test');
  });
  await test('spell compiler reads inherited timers from KOD rather than treating every cast as 2s', () => {
    const root = join(dir, 'kod-fixture');
    const spellDir = join(root, 'kod/object/passive/spell');
    mkdirSync(spellDir, { recursive: true }); mkdirSync(join(root, 'kod/include'), { recursive: true });
    writeFileSync(join(root, 'kod/include/blakston.khd'), 'SID_HOLD = 47\nSID_ENFEEBLE = 53\nSID_LIGHTNING_BOLT = 1\n');
    // Representative source declarations: a base, an inherited attack timer,
    // a direct subclass override, and one subclass that keeps the base timer.
    writeFileSync(join(root, 'kod/object/passive/spell.kod'), 'Spell is Passive\nclassvars:\n   viPostCast_time = 1\n');
    for (const [file, text] of [
      ['atakspel', 'AttackSpell is Spell\nclassvars:\n   viPostCast_time = 2\n'],
      ['boltspel', 'BoltSpell is AttackSpell\n'],
      ['hold', 'Hold is Spell\nclassvars:\n   viSpell_num = SID_HOLD\n   viPostCast_time = 2\n'],
      ['enfeeble', 'Enfeeble is Spell\nclassvars:\n   viSpell_num = SID_ENFEEBLE\n'],
      ['lightnin', 'Lightning is BoltSpell\nclassvars:\n   viSpell_num = SID_LIGHTNING_BOLT\n'],
    ]) writeFileSync(join(spellDir, file + '.kod'), text);
    const spells = compile(root);
    const timer = name => spells.find(s => s.name === name)?.post_cast_ms;
    assert.equal(timer('enfeeble'), 1000); assert.equal(timer('hold'), 2000); assert.equal(timer('lightning bolt'), 2000);
  });
  console.log(`\n${tests} tests passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
