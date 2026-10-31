// Offline: the pvpPace seam (m59-strategies.mjs) and the fleet focus book (m59-pvp-focus.mjs).
// No sockets, roster or private strategies; the strategies here are fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-pace-'));
process.env.M59_PVP_GEAR_FILE = join(dir, 'gear.json');
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_FOCUS_FILE = join(dir, 'focus.jsonl');
process.env.M59_PLAYER_HEALTH_FILE = join(dir, 'groans.jsonl');
process.env.M59_FLEET_HEALTH_DIR = join(dir, 'fleet-health');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ wands: [
  { match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }], volley_ms: 2000 }));
const { CombatMode, PACE_MAX, blowOutcome } = await import('./m59-combat-mode.mjs');
const focus = await import('./m59-pvp-focus.mjs');
const health = await import('./m59-player-health.mjs');
const { createHash } = await import('node:crypto');

let tests = 0;
async function test(name, fn) {
  for (const f of [process.env.M59_PVP_FOCUS_FILE, process.env.M59_PLAYER_HEALTH_FILE]) rmSync(f, { force: true });
  rmSync(process.env.M59_FLEET_HEALTH_DIR, { recursive: true, force: true });
  focus.resetFocusCache(); health.resetHealthCache();
  await fn(); tests++; console.log('ok ' + name);
}
const body = ({ row, col }) => ({ row, col, x: col * 64 + 32, y: row * 64 + 32 });
const T0 = 1000100;

function fixture({ wand = null, strategies = [], targetFlags = OF.PLAYER | OF.ATTACKABLE, hp = 100 } = {}) {
  let now = T0, health = hp;
  const sent = [];
  const c = { selfId: 1, self: { id: 1, ...body({ row: 5, col: 5 }), degrees: 180, flags: 0 },
    room: { id: 3800, flags: 8, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Enemy'], [3, wand], [7, 'Bystander']]),
    inventory: wand ? [{ id: 3, nameRsc: 3 }] : [], spells: [], using: new Set(),
    vitals: () => ({ health: { value: health, max: 100 } }),
    stand() { sent.push({ kind: 'stand', at: now }); },
    face(degrees) { this.self.degrees = degrees; },
    apply(w, target) { sent.push({ kind: 'apply', wand: w, target, at: now }); },
    cast() {},
    attack(target) { (this.attackLog ??= []).push({ at: now, id: target }); sent.push({ kind: 'attack', target, at: now }); },
    safety() {},
  };
  c.room.objects.set(2, { id: 2, nameRsc: 2, ...body({ row: 5, col: 6 }), flags: targetFlags });
  const geo = { rows: 50, cols: 70, canMove: () => true, standable: () => true,
    path(r, col, tr, tc) { return { found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }; } };
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    credentials: { host: 'lab', port: 5959 }, need: () => c,
    world: { room: { num: 38, flags: 8 }, geometry: geo },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { Object.assign(c.self, body({ row, col })); return { moved: true }; },
    async stepFine() { return { moved: true }; },
  };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const mode = s.combat = new CombatMode(s, { now: () => now, schedule: () => 0, unschedule() {} });
  mode.wandStrategies = { strategies };
  const start = () => { mode.issue({ action: 'attack', target: 'Enemy' }); mode.targetAtWar = () => true; };
  return { c, s, mode, sent, start, advance(ms) { now += ms; }, now: () => now, setHp(v) { health = v; },
    attacks: () => sent.filter(p => p.kind === 'attack').length, applies: () => sent.filter(p => p.kind === 'apply').length };
}
const pacer = (pvpPace, extra = {}) => ({ name: 'pace-fixture', kind: 'combat', enabled: true, pvpPace, ...extra });
const focusRows = () => existsSync(process.env.M59_PVP_FOCUS_FILE)
  ? readFileSync(process.env.M59_PVP_FOCUS_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const fleetHealth = (character, room, value, at) => {
  const d = process.env.M59_FLEET_HEALTH_DIR; mkdirSync(d, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify(['lab', 5959, character.toLowerCase()])).digest('hex');
  writeFileSync(join(d, key + '.json'), JSON.stringify({ at, character, endpoint: { host: 'lab', port: 5959 }, body_id: 9, room, health: { value, max: 100 } }));
};

try {
  await test('no pvpPace strategy: the swing timer is the plain second and the focus book is not written', async () => {
    const f = fixture(); f.start(); await f.mode.tick();
    assert.equal(f.attacks(), 1); assert.equal(f.mode.attackReadyAt, T0 + 1000);
    assert.equal(f.mode.active.pace, null); assert.equal(focusRows().length, 0); f.mode.stop('test');
  });
  await test('a factor of 2 doubles the stamped swing timer, and the next swing waits for it', async () => {
    const f = fixture({ strategies: [pacer(() => ({ factor: 2, why: 'fixture' }))] }); f.start(); await f.mode.tick();
    assert.equal(f.attacks(), 1); assert.equal(f.mode.attackReadyAt, T0 + 2000);
    f.advance(1999); await f.mode.tick(); assert.equal(f.attacks(), 1);
    f.advance(1); await f.mode.tick(); assert.equal(f.attacks(), 2);
    assert.equal(f.mode.active.pace.factor, 2); assert.equal(f.mode.active.pace.strategy, 'pace-fixture'); f.mode.stop('test');
  });
  await test('every paced swing at a player is a line in the focus book', async () => {
    const f = fixture({ strategies: [pacer(() => null)] }); f.start(); await f.mode.tick();
    assert.deepEqual(focusRows().map(r => [r.room, r.attacker, r.target]), [[38, 'us', 'enemy']]);
    f.mode.stop('test');
  });
  await test('a factor below 1 cannot speed us up, one above the cap is the cap, and nonsense is full speed', async () => {
    for (const [answer, ms] of [[{ factor: 0.25 }, 1000], [{ factor: 99 }, 1000 * PACE_MAX], [{ factor: 'fast' }, 1000], [{ factor: 1.25 }, 1250]]) {
      const f = fixture({ strategies: [pacer(() => answer)] }); f.start(); await f.mode.tick();
      assert.equal(f.mode.attackReadyAt - T0, ms, JSON.stringify(answer)); f.mode.stop('test');
    }
  });
  await test('a strategy that throws or answers a promise is full speed, and the fight goes on', async () => {
    for (const fn of [() => { throw new Error('boom'); }, async () => ({ factor: 3 })]) {
      const f = fixture({ strategies: [pacer(fn)] }); f.start(); await f.mode.tick();
      assert.equal(f.attacks(), 1); assert.equal(f.mode.attackReadyAt, T0 + 1000); f.mode.stop('test');
    }
  });
  await test('the largest factor of several strategies wins; a release from any of them wins outright', async () => {
    let f = fixture({ strategies: [pacer(() => ({ factor: 1.5 })), pacer(() => ({ factor: 2 }), { name: 'b' })] });
    f.start(); await f.mode.tick(); assert.equal(f.mode.active.pace.factor, 2); f.mode.stop('test');
    f = fixture({ strategies: [pacer(() => ({ factor: 2 })), pacer(() => ({ released: true }), { name: 'b' })] });
    f.start(); await f.mode.tick(); assert.equal(f.mode.active.pace.released, true); assert.equal(f.mode.attackReadyAt, T0 + 1000);
    f.mode.stop('test');
  });
  await test('a release holds for the rest of the fight: the hook is not asked again', async () => {
    let asked = 0, answer = { released: true };
    const f = fixture({ strategies: [pacer(() => { asked++; return answer; })] }); f.start(); await f.mode.tick();
    answer = { factor: 2 };
    for (let i = 0; i < 4; i++) { f.advance(1000); await f.mode.tick(); }
    assert.equal(asked, 1); assert.equal(f.mode.active.pace.released, true);
    assert.equal(f.mode.attackReadyAt - f.now(), 1000); f.mode.stop('test');
  });
  await test('the hook is asked at most every 250 ms', async () => {
    let asked = 0;
    const f = fixture({ strategies: [pacer(() => { asked++; return { factor: 1 }; })] }); f.start();
    await f.mode.tick(); f.advance(100); await f.mode.tick(); assert.equal(asked, 1);
    f.advance(150); await f.mode.tick(); assert.equal(asked, 2); f.mode.stop('test');
  });
  await test('a monster target is never paced and never asked', async () => {
    let asked = 0;
    const f = fixture({ targetFlags: OF.ATTACKABLE, strategies: [pacer(() => { asked++; return { factor: 2 }; })] });
    f.start(); await f.mode.tick(); assert.equal(asked, 0); assert.equal(f.mode.active.pace ?? null, null);
    // Even a pace left over from an earlier target does not stretch a timer stamped at a monster.
    f.mode.active.pace = { factor: 2 };
    assert.equal(f.mode.attackSent(f.mode.active, 1000), T0 + 1000);
    assert.equal(focusRows().length, 0); f.mode.stop('test');
  });
  await test('a timed wand zap is stretched; a timerless zap waits volley_ms x factor', async () => {
    let f = fixture({ wand: 'lightning wand', strategies: [pacer(() => ({ factor: 2 }))] }); f.start(); await f.mode.tick();
    assert.equal(f.applies(), 1); assert.equal(f.mode.attackReadyAt, T0 + 4000); f.mode.stop('test');
    f = fixture({ wand: 'wand of vampiric shock', strategies: [pacer(() => ({ factor: 2 }))] }); f.start(); await f.mode.tick();
    assert.equal(f.applies(), 1);
    f.advance(2000); await f.mode.tick(); assert.equal(f.applies(), 1, 'one volley beat is not enough at factor 2');
    f.advance(2000); await f.mode.tick(); assert.equal(f.applies(), 2); f.mode.stop('test');
  });
  await test('ctx counts the fleet on this target and in this fight from the focus book, us included', async () => {
    let seen = null;
    const f = fixture({ strategies: [pacer(ctx => { seen = ctx; return null; })] });
    for (const [who, target] of [['Statler', 'Enemy'], ['Waldorf', 'Enemy'], ['Kermit', 'Other']])
      focus.recordFocus({ room: 38, attacker: who, target, at: T0 - 1000 });
    focus.recordFocus({ room: 38, attacker: 'Gonzo', target: 'Enemy', at: T0 - 20_000 });   // left the window
    focus.recordFocus({ room: 39, attacker: 'Piggy', target: 'Enemy', at: T0 - 1000 });     // another room
    f.c.room.objects.set(7, { id: 7, nameRsc: 7, ...body({ row: 9, col: 9 }), flags: OF.PLAYER | OF.ATTACKABLE });
    f.start(); await f.mode.tick();
    assert.equal(seen.attackers_on_target, 3); assert.equal(seen.engaged, 4);
    assert.equal(seen.enemies_here, 1, 'the target counts; a bystander nobody is hitting does not');
    assert.equal(seen.fight.started_at, T0 - 20_000); assert.equal(seen.target.name, 'enemy'); f.mode.stop('test');
  });
  await test('a band-4 groan since the fight began is low_groan; one from before it is not', async () => {
    let seen = null;
    const f = fixture({ strategies: [pacer(ctx => { seen = ctx; return null; })] });
    appendFileSync(process.env.M59_PLAYER_HEALTH_FILE, JSON.stringify({ at: T0 - 90_000, name: 'Enemy', band: 4, room: 38 }) + '\n');
    focus.recordFocus({ room: 38, attacker: 'Statler', target: 'Enemy', at: T0 - 5000 });
    appendFileSync(process.env.M59_PLAYER_HEALTH_FILE, JSON.stringify({ at: T0 - 4000, name: 'Enemy', band: 3, room: 38 }) + '\n');
    f.start(); await f.mode.tick(); assert.equal(seen.fight.low_groan, null);
    appendFileSync(process.env.M59_PLAYER_HEALTH_FILE, JSON.stringify({ at: T0 + 100, name: 'Other', band: 4, room: 38, reporter: 'Statler' }) + '\n');
    health.resetHealthCache(); f.advance(300); await f.mode.tick();
    assert.deepEqual(seen.fight.low_groan, { name: 'Other', at: T0 + 100, reporter: 'Statler' });
    assert.deepEqual(seen.target.health && seen.target.health.band, 3); f.mode.stop('test');
  });
  await test('ally_low is us or a fresh fleet-mate report in this room at 25% or less', async () => {
    let seen = null;
    let f = fixture({ strategies: [pacer(ctx => { seen = ctx; return null; })] }); f.start(); await f.mode.tick();
    // Our own body at 25% is the survival layer's before it is ours, so read the ctx directly.
    f.setHp(25); seen = f.mode.paceContext(f.mode.active, f.c.room.objects.get(2));
    assert.equal(seen.fight.ally_low.character.toLowerCase(), 'us'); assert.equal(seen.me.health_pct, 25); f.mode.stop('test');
    fleetHealth('Statler', 38, 20, T0 - 1000); fleetHealth('Waldorf', 39, 5, T0 - 1000); fleetHealth('Kermit', 38, 5, T0 - 60_000);
    f = fixture({ hp: 90, strategies: [pacer(ctx => { seen = ctx; return null; })] }); f.start(); await f.mode.tick();
    assert.equal(seen.fight.ally_low.character, 'Statler'); assert.equal(seen.fight.ally_low.health_pct, 20);
    fleetHealth('Statler', 38, 60, T0 - 1000); f.advance(300); await f.mode.tick();
    assert.equal(seen.fight.ally_low, null, 'another room or a stale report is not in this fight'); f.mode.stop('test');
  });
  await test('roomFocus: the fight is the unbroken run, and a quiet room has none', () => {
    for (const at of [T0 - 100_000, T0 - 50_000, T0 - 25_000, T0 - 2000])
      focus.recordFocus({ room: 38, attacker: `A${at}`, target: 'Enemy', at });
    assert.equal(focus.roomFocus(38, { now: T0 }).started_at, T0 - 50_000);
    assert.deepEqual(focus.roomFocus(38, { now: T0 }).engaged, [`A${T0 - 2000}`]);
    focus.resetFocusCache();
    assert.equal(focus.roomFocus(38, { now: T0 + 40_000 }).started_at, null);
  });
  await test('the focus book writes one attacker on one target at most twice a second', () => {
    assert.equal(focus.recordFocus({ room: 38, attacker: 'A', target: 'E', at: T0 }), true);
    assert.equal(focus.recordFocus({ room: 38, attacker: 'A', target: 'E', at: T0 + 400 }), false);
    assert.equal(focus.recordFocus({ room: 38, attacker: 'A', target: 'F', at: T0 + 400 }), true);
    assert.equal(focus.recordFocus({ room: 38, attacker: 'A', target: 'E', at: T0 + 500 }), true);
    assert.equal(focus.recordFocus({ room: 1, attacker: 'A', target: 'E', at: T0 + 900 }), false);
  });

  // ---------------------------------------------------------------- after: 'hit'
  const say = (f, text) => f.mode.event({ kind: 'message', text }, f.c);
  const hitPacer = (fn = () => ({ factor: 2, after: 'hit' })) => pacer(fn);
  await test('blowOutcome reads the server: a damaging hit, a 0-damage hit, a miss, a wand, and someone else', () => {
    for (const [text, out] of [
      ['Your scimitar wounds Enemy.', 'hit'], ['~bYour longsword slays Enemy.', 'hit'], ['Your fireball burns Enemy.', 'hit'],
      ['Your scimitar fails to damage Enemy.', 'miss'], ['Enemy blocks your attack.', 'miss'], ['Enemy dodges your attack.', 'miss'],
      ['You watch with satisfaction as a ball of fire engulfs Enemy!', 'hit'],
      ["You feel giddy with energy as Enemy's life force fills your body.", 'hit'],
      ["You cackle with glee as Enemy's life force is sucked away.", 'hit'],
      ['Your scimitar wounds Other.', null], ['Other blocks your attack.', null], ['Your scimitar wounds FrenEnemy.', null],
      ['Enemy wounds you with his scimitar.', null], ['You hit Enemy.', null]])
      assert.equal(blowOutcome(text, 'enemy'), out, text);
  });
  await test("after: 'hit' -- the swing stamps the plain second, and a confirmed hit stretches it from the send", async () => {
    const f = fixture({ strategies: [hitPacer()] }); f.start(); await f.mode.tick();
    assert.equal(f.mode.attackReadyAt, T0 + 1000);
    f.advance(150); say(f, 'Your scimitar wounds Enemy.');
    assert.equal(f.mode.attackReadyAt, T0 + 2000); assert.equal(f.mode.active.pace.last_blow.stretched_ms, 1000);
    f.advance(1849); await f.mode.tick(); assert.equal(f.attacks(), 1);
    f.advance(1); await f.mode.tick(); assert.equal(f.attacks(), 2);
    assert.deepEqual(focusRows().filter(r => r.hit).map(r => r.target), ['enemy']); f.mode.stop('test');
  });
  await test("after: 'hit' -- a miss or a 0-damage blow leaves the plain timer: the next swing goes at full speed", async () => {
    for (const text of ['Enemy parries your attack.', 'Your scimitar fails to damage Enemy.']) {
      const f = fixture({ strategies: [hitPacer()] }); f.start(); await f.mode.tick();
      f.advance(150); say(f, text); assert.equal(f.mode.attackReadyAt, T0 + 1000, text);
      assert.equal(f.mode.active.pace.last_blow.hit, false);
      f.advance(850); await f.mode.tick(); assert.equal(f.attacks(), 2, text);
      assert.equal(focusRows().filter(r => r.hit).length, 0); f.mode.stop('test');
    }
  });
  await test("after: 'hit' -- a hit line arriving after that blow's cooldown, or a second one, stretches nothing", async () => {
    let f = fixture({ strategies: [hitPacer()] }); f.start(); await f.mode.tick();
    f.advance(1000); say(f, 'Your scimitar wounds Enemy.'); assert.equal(f.mode.attackReadyAt, T0 + 1000); f.mode.stop('test');
    f = fixture({ strategies: [hitPacer()] }); f.start(); await f.mode.tick();
    f.advance(100); say(f, 'Your scimitar wounds Enemy.'); f.mode.attackReadyAt = T0 + 1000;
    f.advance(100); say(f, 'Your scimitar wounds Enemy.'); assert.equal(f.mode.attackReadyAt, T0 + 1000); f.mode.stop('test');
  });
  await test('the factor is recomputed at the hit, counting it: hitters inside 4 s, us only once we have hit', async () => {
    const seen = [];
    const strat = hitPacer(ctx => { seen.push(ctx.hitters_on_target); return ctx.hitters_on_target >= 3 ? { factor: 2, after: 'hit' } : null; });
    for (const [who, at] of [['Statler', T0 - 1000], ['Waldorf', T0 - 3000], ['Gonzo', T0 - 4500]])
      focus.recordFocus({ room: 38, attacker: who, target: 'Enemy', hit: true, at });
    const f = fixture({ strategies: [strat] }); f.start(); await f.mode.tick();
    assert.equal(seen.at(-1), 2, 'Gonzo is out of the window and we have not hit yet');
    f.advance(150); say(f, 'Your scimitar wounds Enemy.');
    assert.equal(seen.at(-1), 3); assert.equal(f.mode.attackReadyAt, T0 + 2000); f.mode.stop('test');
  });
  await test("without after: 'hit' the old rule stands: every blow is stretched at send, hit or miss", async () => {
    const f = fixture({ strategies: [pacer(() => ({ factor: 2 }))] }); f.start(); await f.mode.tick();
    f.advance(150); say(f, 'Enemy blocks your attack.'); assert.equal(f.mode.attackReadyAt, T0 + 2000); f.mode.stop('test');
  });
  await test("after: 'hit' -- a timerless zap waits volley_ms x factor only after a zap that hit", async () => {
    let f = fixture({ wand: 'wand of vampiric shock', strategies: [hitPacer()] }); f.start(); await f.mode.tick();
    assert.equal(f.applies(), 1); f.advance(2000); await f.mode.tick(); assert.equal(f.applies(), 2, 'no hit line: full speed');
    f.mode.stop('test');
    f = fixture({ wand: 'wand of vampiric shock', strategies: [hitPacer()] }); f.start(); await f.mode.tick();
    f.advance(200); say(f, "You feel giddy with energy as Enemy's life force fills your body.");
    f.advance(1800); await f.mode.tick(); assert.equal(f.applies(), 1, 'it hit: wait for the stretched beat');
    f.advance(2000); await f.mode.tick(); assert.equal(f.applies(), 2); f.mode.stop('test');
  });
  await test('roomFocus counts hitters per target inside the hit window, apart from senders', () => {
    focus.recordFocus({ room: 38, attacker: 'A', target: 'Enemy', at: T0 - 1000 });
    focus.recordFocus({ room: 38, attacker: 'B', target: 'Enemy', hit: true, at: T0 - 1000 });
    focus.recordFocus({ room: 38, attacker: 'C', target: 'Enemy', hit: true, at: T0 - 5000 });
    const r = focus.roomFocus(38, { now: T0 });
    assert.deepEqual(r.hitters, { Enemy: ['B'] }); assert.deepEqual(r.targets.Enemy.sort(), ['A', 'B', 'C']);
  });
  console.log(`\n${tests} tests passed`);
} finally { rmSync(dir, { recursive: true, force: true }); }
