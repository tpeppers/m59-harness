// Offline threat and shared-slot integration. No roster, private policy or socket.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { PersonalThreat } from './m59-personal-threat.mjs';
import { CombatFallback } from './m59-combat-fallback.mjs';
import { potionCondition, compilePotions, potionCatalogue } from './m59-potions.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';
import { compile } from './m59-spells.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'm59-fallback-'));
process.env.M59_PVP_GEAR_FILE = join(scratch, 'gear.json');
process.env.M59_WAR_FILE = join(scratch, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(scratch, 'alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(scratch, 'grudges.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ wands: [{ match: 'lightning wand', timer: true }] }));
const { CombatMode } = await import('./m59-combat-mode.mjs');
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('ok ' + name); }
const good = 'This is a clear blue vial.';
const bad = 'This is a cloudy foul vial.';
const catalogue = new Map([
  ['test potion a', { effect: 'effect a', good_description: good, bad_description: bad, post_cast_ms: 1000 }],
  ['test potion b', { effect: 'effect b', good_description: good, bad_description: bad, post_cast_ms: 1000 }],
]);
function fixture() {
  let now = 1000100, los = false, held = false, lookDescription = good, before = null, inventoryReply = true;
  const sent = [], events = [];
  const c = { selfId: 1, self: { id: 1, row: 5, col: 5, degrees: 0, flags: 0 }, evSeq: 0,
    me: { name: 'Us' }, room: { id: 3800, flags: 8, objects: new Map() },
    rsc: new Map([[2, 'Enemy'], [3, 'test potion a'], [4, 'test potion b'], [5, 'lightning wand']]),
    inventory: [{ id: 3, nameRsc: 3 }, { id: 4, nameRsc: 4 }], spells: [], using: new Set(),
    vitals: () => ({ health: { value: 100, max: 100 } }), enchantments: () => [],
    emit(kind, rest = {}) { const e = { kind, seq: ++c.evSeq, at: now, ...rest }; events.push(e); return e; },
    requestInventory() { sent.push('inventory'); if (inventoryReply) c.emit('inventory'); },
    look(id) { sent.push('look:' + id); c.emit('look', { id: 999, description: good }); c.emit('look', { id, description: lookDescription }); },
    async waitFor({ since, kinds, match }) { return { events: events.filter(e => e.seq > since && kinds.includes(e.kind) && (!match || match(e))), seq: c.evSeq }; },
    use(id) { sent.push('use:' + id); }, stand() { sent.push('stand'); }, safety() {},
    face(degrees) { c.self.degrees = degrees; sent.push('face'); },
    apply() { sent.push('wand'); }, attack() { sent.push('attack'); },
  };
  c.room.objects.set(2, { id: 2, nameRsc: 2, row: 5, col: 12, flags: OF.PLAYER | OF.ATTACKABLE });
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    world: { room: { num: 38, flags: 8 }, geometry: { canMove: () => los } },
    cancelMovement() { s.movementGeneration++; }, need: () => c };
  s.pacer = { holdStatus: () => ({ active: held }), async submit(kind, fn) {
    const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); await before?.(kind); return run();
  } };
  const mode = s.combat = new CombatMode(s, { now: () => now, schedule: () => 0, unschedule() {} });
  mode.record = () => {};
  mode.fallback = new CombatFallback(mode, { catalogue: () => catalogue });
  mode.wandStrategies = { strategies: [{ name: 'test-policy', enabled: true,
    pvpFallback: ctx => ctx.personal_threat.level !== 'under_attack' ? null :
      ({ queue: ctx.items.filter(i => !ctx.attempted_effects.includes(i.effect)).map(i => ({ use: i.id })), interval_ms: 1000 }) }] };
  mode.crossDoorToward = async () => { sent.push('move'); return true; };
  mode.targetAtWar = () => true;
  const start = () => { mode.issue({ action: 'attack', target: 'Enemy' }); mode.active.fallbackPrimary = { range: 2 }; };
  start();
  const attacked = () => mode.personalThreat.note({ kind: 'player_hit', attacker: 'Enemy' }, { engaged: true });
  const tick = async () => { await mode.tick(); if (mode.fallback.task) await mode.fallback.task; };
  return { c, s, mode, sent, start, attacked, tick, advance: ms => { now += ms; },
    sight: value => { los = value; }, hold: value => { held = value; },
    before: fn => { before = fn; }, description: value => { lookDescription = value; },
    inventoryReply: value => { inventoryReply = value; } };
}
try {
  await test('personal hits/misses escalate; outgoing attacks, alarms and quoted speech do not', () => {
    let now = 100; const p = new PersonalThreat({ now: () => now });
    const c = { selfId: 1, room: { objects: new Map([[2, { id: 2, name: 'Enemy', flags: OF.PLAYER }]]) } };
    assert.equal(p.snapshot({ engaged: true }).level, 'engaged');
    for (const ev of [{ kind: 'said', text: 'Enemy hits you.' }, { kind: 'alarm', text: 'Enemy hits you.' },
      { kind: 'message', text: 'Your lightning bolt shocks Enemy.' }, { kind: 'message', text: 'Enemy hits Someone Else.' }]) p.observe(ev, c);
    assert.equal(p.snapshot().severity, 0);
    p.observe({ kind: 'message', text: 'You dodge Enemy\'s attack.' }, c);
    assert.equal(p.snapshot().level, 'under_attack');
    p.observe({ kind: 'message', text: 'Enemy hits you.' }, c);
    assert.equal(p.snapshot().personal_events, 2);
    now += 30000; assert.equal(p.snapshot().level, 'quiet');
    assert.equal(p.snapshot({ engaged: true }).level, 'under_attack');
  });
  await test('harmful personal effects and hostile failed spells count; buffs and room effects do not', () => {
    const p = new PersonalThreat({ catalogue: () => new Map([['hold', { harmful: true }], ['bless', { harmful: false }]]) });
    const c = { selfId: 1, room: { objects: new Map([[2, { id: 2, name: 'Enemy', flags: OF.PLAYER }]]) } };
    p.observe({ kind: 'enchantment', added: { type: 2, name: 'hold' } }, c);
    p.observe({ kind: 'enchantment', added: { type: 1, name: 'bless' } }, c);
    assert.equal(p.snapshot().level, 'quiet');
    p.observe({ kind: 'enchantment', added: { type: 1, name: 'hold' } }, c);
    assert.equal(p.snapshot().evidence.attacker, null, 'do not invent the caster');
    p.observe({ kind: 'message', text: 'Enemy tried to cast hold on you.' }, c);
    assert.equal(p.snapshot().evidence.kind, 'hostile_spell_attempt');
    p.observe({ kind: 'stat', name: 'health', value: 0 }, c);
    assert.equal(p.snapshot().level, 'quiet');
  });
  await test('joining a fight and having no private fallback hook sends no inspection or use', async () => {
    const f = fixture(); await f.tick();
    assert.deepEqual(f.sent, ['move']);
    f.attacked(); f.mode.wandStrategies.strategies = []; await f.tick();
    assert.equal(f.sent.some(s => /inventory|look|use/.test(s)), false); f.mode.stop('test');
  });
  await test('victim-only hold/resist messages count even without damage or an effect icon', () => {
    const p = new PersonalThreat(), c = { selfId: 1 };
    p.observe({ kind: 'said', text: 'You evade an attempt to restrict your movement.' }, c);
    p.observe({ kind: 'message', text: 'You sense an unsavory presence.' }, c);
    assert.equal(p.snapshot().level, 'quiet', 'enfeeble sends this same line to its caster');
    for (const text of ['A magical tingling pulses through your body.  You are unable to move.',
      'You evade an attempt to restrict your movement.', "You can feel Kraanan's magic working to free you."])
      p.observe({ kind: 'message', text }, c);
    assert.equal(p.snapshot().personal_events, 3);
    assert.equal(p.snapshot().evidence.attacker, null);
  });
  await test('enfeeble/dement sickness icons are personal harm even though they are not Spell subclasses', () => {
    const p = new PersonalThreat({ catalogue: () => new Map() }), c = {};
    for (const name of ['palsy', 'dementia', 'poison'])
      p.observe({ kind: 'enchantment', added: { type: 1, name } }, c);
    assert.equal(p.snapshot().personal_events, 3);
    assert.equal(p.snapshot().evidence.kind, 'harmful_effect');
  });
  await test('a ready melee attack wins over the fallback queue', async () => {
    const f = fixture(); f.attacked(); f.c.room.objects.get(2).col = 6; await f.tick();
    assert.ok(f.sent.includes('attack')); assert.ok(!f.sent.includes('inventory')); f.mode.stop('test');
  });
  await test('the threat threshold is private policy, not a hardcoded consumption rule', async () => {
    const f = fixture();
    f.mode.wandStrategies.strategies[0].pvpFallback = () => ({ queue: [{ use: 3 }], interval_ms: 1000 });
    await f.tick(); assert.ok(f.sent.includes('use:3')); f.mode.stop('test');
  });
  await test('a ready wand wins; its cooldown is not an available potion slot', async () => {
    const f = fixture(); f.attacked(); f.sight(true); f.c.inventory.push({ id: 5, nameRsc: 5 });
    await f.tick(); await f.tick();
    assert.equal(f.sent.filter(s => s === 'wand').length, 1);
    assert.ok(!f.sent.includes('inventory')); f.mode.stop('test');
  });
  await test('pursuit continues while fresh inventory/inspection obtains a potion for the unused slot', async () => {
    const f = fixture(); f.attacked(); await f.tick();
    assert.ok(f.sent.includes('move')); assert.ok(f.sent.indexOf('inventory') < f.sent.indexOf('look:3'));
    assert.ok(f.sent.indexOf('look:3') < f.sent.indexOf('use:3'));
    assert.deepEqual(f.mode.fallback.snapshot().attempted_effects, ['effect a']);
    assert.equal(f.mode.attackReadiness(f.mode.active, f.c.room.objects.get(2)).timer_remaining_ms, 1000);
    f.mode.stop('test');
  });
  await test('a delayed look reply cannot stall the pursuit pass', async () => {
    const f = fixture(); f.attacked();
    const wait = f.c.waitFor; let release;
    f.c.waitFor = options => options.kinds.includes('look')
      ? new Promise(resolve => { release = resolve; }) : wait(options);
    let timeout;
    try {
      await Promise.race([f.mode.tick(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error('inspection blocked pursuit')), 200);
      })]);
    } finally { clearTimeout(timeout); }
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.sent.includes('move')); assert.equal(typeof release, 'function');
    assert.equal(f.mode.fallback.snapshot().pending, true);
    release({ events: [{ id: 3, description: good, at: 1000100 }], seq: f.c.evSeq });
    await f.mode.fallback.task; assert.ok(f.sent.includes('use:3')); f.mode.stop('test');
  });
  await test('rejecting a spoiled bottle does not retire its effect or prevent another fresh bottle', async () => {
    const f = fixture(); f.attacked();
    f.c.inventory = [{ id: 3, nameRsc: 3 }, { id: 6, nameRsc: 3 }];
    f.c.look = id => f.c.emit('look', { id, description: id === 3 ? bad : good });
    await f.tick(); assert.deepEqual(f.mode.fallback.snapshot().attempted_effects, []);
    f.advance(1000); await f.tick();
    assert.ok(!f.sent.includes('use:3')); assert.ok(f.sent.includes('use:6')); f.mode.stop('test');
  });
  await test('one effect per encounter and at most one send per second, across replacement orders', async () => {
    const f = fixture(); f.attacked(); await f.tick(); await f.tick();
    assert.deepEqual(f.sent.filter(s => s.startsWith('use:')), ['use:3']);
    f.advance(1000); f.start(); await f.tick();
    assert.deepEqual(f.sent.filter(s => s.startsWith('use:')), ['use:3', 'use:4']); f.mode.stop('test');
  });
  await test('spoiled and unknown descriptions, including crafted labels, never permit use', async () => {
    for (const description of [bad, bad + ' Made by Someone Master Distiller', 'A mystery bottle.', '']) {
      const f = fixture(); f.attacked(); f.description(description); await f.tick();
      assert.ok(!f.sent.some(s => s.startsWith('use:')));
      assert.ok(['spoiled', 'condition_unknown'].includes(f.mode.fallback.last.reason)); f.mode.stop('test');
    }
    assert.equal(potionCondition(catalogue.get('test potion a'), good + ' Made by Someone Master Distiller').safe, true);
  });
  await test('inventory refresh timeout cannot fall back to a cached bottle', async () => {
    const f = fixture(); f.attacked(); f.inventoryReply(false); await f.tick();
    assert.ok(!f.sent.some(s => s.startsWith('use:'))); f.mode.stop('test');
  });
  await test('a primary becoming feasible during the inspection wins at dispatch', async () => {
    const f = fixture(); f.attacked(); f.before(kind => { if (kind === 'use') f.c.room.objects.get(2).col = 6; });
    await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:'))); await f.tick();
    assert.ok(f.sent.includes('attack')); f.mode.stop('test');
  });
  await test('an intervening attack/cast timer suppresses an already-inspected potion', async () => {
    const f = fixture(); f.attacked(); f.before(kind => { if (kind === 'use') f.mode.attackReadyAt = 1001100; });
    await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:'))); f.mode.stop('test');
  });
  await test('paced inspection expiry and removed/replaced inventory invalidate the use', async () => {
    for (const mutate of [f => f.advance(501), f => { f.c.inventory = []; },
      f => { f.c.inventory = f.c.inventory.map(i => ({ ...i })); }]) {
      const f = fixture(); f.attacked(); f.before(kind => { if (kind === 'use') mutate(f); });
      await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:'))); f.mode.stop('test');
    }
  });
  await test('stop while reading revokes the queued fallback without stopping unrelated movement', async () => {
    const f = fixture(); f.attacked(); f.before(kind => { if (kind === 'read') f.mode.stop('operator stopped'); });
    await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:')));
  });
  await test('a server save between inspection and use invalidates the item generation', async () => {
    const f = fixture(); f.attacked();
    let saving = false, saves = 1;
    f.c.idsAsOf = () => ({ inventory_at: 1000100, last_save_at: 1000000, saving, saves_seen: saves });
    f.before(kind => { if (kind === 'use') { saving = true; saves++; } });
    await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:'))); f.mode.stop('test');
  });
  await test('a casting trance cannot be interrupted by a fallback', async () => {
    const f = fixture(); f.attacked(); f.hold(true); await f.tick();
    assert.ok(!f.sent.includes('inventory')); f.mode.stop('test');
  });
  await test('a hostile effect alone raises the personal meter during PvP without inventing an attacker', async () => {
    const f = fixture();
    f.mode.event({ kind: 'enchantment', added: { id: 99, type: 1, name: 'hold' } }, f.c);
    assert.equal(f.mode.status().personal_threat.level, 'under_attack');
    assert.equal(f.mode.status().personal_threat.evidence.attacker, null);
    await f.tick(); assert.ok(f.sent.includes('use:3')); f.mode.stop('test');
  });
  await test('wrong-id and stale look replies cannot supply the bottle condition', async () => {
    for (const stale of [false, true]) {
      const f = fixture(); f.attacked();
      f.c.emit('look', { id: 3, description: good });
      f.c.look = id => f.c.emit('look', { id: stale ? id : 999, description: good,
        ...(stale ? { at: 1 } : {}) });
      await f.tick(); assert.ok(!f.sent.some(s => s.startsWith('use:'))); f.mode.stop('test');
    }
  });
  await test('item-removal and effect observations remain separate from the sent packet', async () => {
    const f = fixture(); f.attacked(); await f.tick();
    assert.equal(f.mode.fallback.last.status, 'sent');
    f.mode.fallback.observe({ kind: 'left', id: 3 });
    f.mode.fallback.observe({ kind: 'enchantment', added: { type: 1, name: 'effect a' } });
    const row = f.mode.fallback.snapshot().history[0];
    assert.ok(row.item_left_at && row.effect_seen_at); assert.equal(row.status, 'sent'); f.mode.stop('test');
  });
  await test('shipped KOD potion conditions reject spoiled variants for every known type', () => {
    const rows = [...potionCatalogue().values()];
    assert.ok(rows.length >= 29);
    for (const row of rows) {
      assert.equal(potionCondition(row, row.good_description).safe, true, row.name);
      assert.equal(potionCondition(row, row.bad_description).safe, false, row.name);
      assert.ok(Number.isFinite(row.post_cast_ms));
    }
  });
  await test('the compiler inherits harmful flags and extracts exact potion condition resources', () => {
    const root = join(scratch, 'source'), spells = join(root, 'kod/object/passive/spell');
    const potions = join(root, 'kod/object/item/passitem/spelitem/potion');
    mkdirSync(join(root, 'kod/include'), { recursive: true });
    mkdirSync(spells, { recursive: true }); mkdirSync(potions, { recursive: true });
    writeFileSync(join(root, 'kod/include/blakston.khd'), 'SID_HOLD = 47\nSID_BLESS = 2\n');
    writeFileSync(join(root, 'kod/object/passive/spell.kod'), 'Spell is Passive\nclassvars:\n viHarmful = FALSE\n viPostCast_time = 1\n');
    writeFileSync(join(spells, 'hold.kod'), 'Hold is Spell\nclassvars:\n viSpell_num = SID_HOLD\n viHarmful = TRUE\n');
    writeFileSync(join(spells, 'bless.kod'), 'Bless is Spell\nclassvars:\n viSpell_num = SID_BLESS\n');
    const flags = new Map(compile(root).map(s => [s.num, s.harmful]));
    assert.equal(flags.get(47), true); assert.equal(flags.get(2), false);
    writeFileSync(join(potions, 'example.kod'), [
      'ExamplePotion is Potion', 'resources:', ' Example_name = "test blessing potion"',
      ' Example_good = "Clear " "blue vial."', ' Example_bad = "Cloudy foul vial."',
      'classvars:', ' vrLabelName = Example_name', ' vrDesc = Example_good', ' vrBadDesc = Example_bad',
      ' viSpellEffect = SID_BLESS', 'properties:', 'messages:', 'end',
    ].join('\n'));
    const rows = compilePotions(root);
    assert.equal(rows.length, 1); assert.equal(rows[0].good_description, 'Clear blue vial.');
    assert.equal(rows[0].effect, 'bless'); assert.equal(rows[0].post_cast_ms, 1000);
  });
  console.log(count + ' fallback/threat scenarios passed');
} finally { rmSync(scratch, { recursive: true, force: true }); }
