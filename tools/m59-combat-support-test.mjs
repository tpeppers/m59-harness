// Offline socket-owner integration: support must coexist with pursuit/offense.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OF } from './m59-parse.mjs';
import { CombatSupport } from './m59-combat-support.mjs';
import { CombatFallback } from './m59-combat-fallback.mjs';
import { claimFleetHeal } from './m59-heal-claims.mjs';
import { publishFleetHealth, readFleetHealth } from './m59-fleet-health.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';
const scratch = mkdtempSync(join(tmpdir(), 'm59-support-'));
process.env.M59_FLEET_HEALTH_DIR = join(scratch, 'published');
for (const [key, file] of Object.entries({ M59_PVP_GEAR_FILE: 'gear.json', M59_WAR_FILE: 'war.json',
  M59_WAR_ALARM_FILE: 'alarm.jsonl', M59_GRUDGE_FILE: 'grudge.json' })) process.env[key] = join(scratch, file);
writeFileSync(process.env.M59_PVP_GEAR_FILE, '{}');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const charged = 'This wand is almost comically decorated by obviously fake gems. Still, the wand hums nearly inaudibly, and when you put your hand on it, it is warm to the touch.';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok ' + name); }
function fixture() {
  let now = 1000100, hp = 50, held = false, description = charged, before = null, inventoryReply = true, claim = true;
  const sent = [], events = [], reports = new Map([[4, { health: { value: 30, max: 100 }, at: now }]]);
  const c = { state: 'game', combatReady: true, selfId: 1, self: { id: 1, row: 5, col: 5, degrees: 0 }, evSeq: 0,
    me: { name: 'Us' }, room: { id: 3800, flags: 8, objects: new Map() },
    rsc: new Map([[2, 'Enemy'], [3, 'wand of healing'], [4, 'Ally'], [5, 'Stranger'], [6, 'test potion']]),
    inventory: [{ id: 3, nameRsc: 3 }], spells: [], using: new Set(),
    vitals: () => ({ health: { value: hp, max: 100 } }), enchantments: () => [],
    emit(kind, rest = {}) { const e = { kind, at: now, seq: ++c.evSeq, ...rest }; events.push(e); return e; },
    requestInventory() { sent.push('inventory'); if (inventoryReply) c.emit('inventory'); },
    look(id) { sent.push('look:' + id); c.emit('look', { id, description }); },
    async waitFor({ since, kinds, match }) { return { events: events.filter(e => e.seq > since && kinds.includes(e.kind) && (!match || match(e))) }; },
    apply(id, to) { sent.push(['apply', id, to]); }, use(id) { sent.push(['use', id]); },
    stand() {}, safety() {}, face(deg) { c.self.degrees = deg; sent.push('face'); }, attack() { sent.push('attack'); },
  };
  c.room.objects.set(2, { id: 2, nameRsc: 2, flags: OF.PLAYER | OF.ATTACKABLE, row: 5, col: 12 });
  c.room.objects.set(4, { id: 4, nameRsc: 4, flags: OF.PLAYER, row: 20, col: 20 });
  c.room.objects.set(5, { id: 5, nameRsc: 5, flags: OF.PLAYER, row: 5, col: 6 });
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    credentials: { host: 'test.invalid', port: 5900 }, world: { room: { num: 38, flags: 8 }, geometry: { canMove: () => false } },
    cancelMovement() { s.movementGeneration++; }, need: () => c };
  s.pacer = { holdStatus: () => ({ active: held }), async submit(kind, fn) {
    const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); await before?.(kind); return run();
  } };
  const m = s.combat = new CombatMode(s, { now: () => now, schedule: () => 0, unschedule() {} });
  m.fleetmate = n => n === 'Ally';
  m.record = () => {}; m.targetAtWar = () => true;
  m.crossDoorToward = async () => { sent.push('move'); return true; };
  m.support = new CombatSupport(m, { claim: () => claim, health: (_id, opts) => {
    const r = reports.get(opts.bodyId);
    return r && now - r.at <= opts.maxAgeMs ? r : null;
  } });
  const strategy = { name: 'test-support', enabled: true, pvpSupport(ctx) {
    const target = ctx.targets.filter(t => t.health.value / t.health.max < .9).sort((a, b) => a.health.value - b.health.value)[0];
    return target && ctx.items.length ? { queue: [{ apply: ctx.items[0].id, to: target.id, below: .9, min_missing: 2 }], interval_ms: 1000 } : null;
  } };
  m.wandStrategies = { strategies: [strategy] };
  m.issue({ action: 'attack', target: 'Enemy' });
  const tick = async () => { await m.tick(); await m.support.task; await m.fallback.task; };
  return { c, s, m, sent, reports, strategy, tick, setHP: v => { hp = v; }, advance: ms => { now += ms; },
    hold: v => { held = v; }, description: v => { description = v; }, before: fn => { before = fn; },
    inventoryReply: v => { inventoryReply = v; }, claim: v => { claim = v; } };
}
const applications = f => f.sent.filter(s => Array.isArray(s) && s[0] === 'apply');
try {
  await test('support heals a same-room fleetmate through walls while pursuit continues', async () => {
    const f = fixture(); await f.tick(); assert.deepEqual(applications(f), [['apply', 3, 4]]);
    assert(f.sent.includes('move')); assert.equal(f.m.attackReadyAt ?? 0, 0);
    assert.equal(f.m.status().support_queue.last.status, 'sent'); f.m.stop('test');
  });
  await test('ready melee and healing both send without stealing the attack timer', async () => {
    const f = fixture(); f.c.room.objects.get(2).col = 6; await f.tick();
    assert(f.sent.includes('attack')); assert.equal(applications(f).length, 1);
    assert.equal(f.m.attackReadyAt, 1001100); f.m.stop('test');
  });
  await test('an offensive cooldown does not prevent a self heal', async () => {
    const f = fixture(); f.reports.clear(); f.m.attackReadyAt = 1010000; await f.tick();
    assert.deepEqual(applications(f), [['apply', 3, 1]]); assert.equal(f.m.attackReadyAt, 1010000); f.m.stop('test');
  });
  await test('no enabled private hook means no inspection or application', async () => {
    const f = fixture(); f.strategy.enabled = false; await f.tick(); assert.deepEqual(f.sent, ['move']); f.m.stop('test');
  });
  await test('same-room strangers and enemies never appear as support candidates', async () => {
    const f = fixture(); f.strategy.pvpSupport = ctx => { assert.deepEqual(ctx.targets.map(t => t.id), [1, 4]); return null; };
    await f.tick(); assert.equal(applications(f).length, 0); f.m.stop('test');
  });
  await test('stale ally HP is skipped; self remains eligible', async () => {
    const f = fixture(); f.advance(1501); await f.tick(); assert.deepEqual(applications(f), [['apply', 3, 1]]); f.m.stop('test');
  });
  await test('full, dead or missing HP cannot spend a charge', async () => {
    for (const value of [100, 0, NaN]) { const f = fixture(); f.setHP(value); f.reports.clear(); await f.tick();
      assert.equal(applications(f).length, 0); f.m.stop('test'); }
  });
  await test('only exact healing identity is accepted; depleted animation is skipped', async () => {
    for (const change of ['unknown', 'broken']) { const f = fixture();
      if (change === 'unknown') f.c.rsc.set(3, 'wand'); else f.c.inventory[0].animate = { animation: 1, group: 3 };
      await f.tick(); assert.equal(applications(f).length, 0); assert(!f.sent.includes('inventory')); f.m.stop('test'); }
  });
  await test('every charge requires a fresh charged LOOK; empty/unknown cannot apply', async () => {
    for (const desc of ['The once pristine wand is now a blackened mess.', 'unknown']) {
      const f = fixture(); f.description(desc); await f.tick(); assert.equal(applications(f).length, 0); f.m.stop('test');
    }
    const f = fixture(); await f.tick(); f.advance(1000); f.description('The once pristine wand is now a blackened mess.');
    await f.tick(); assert.equal(applications(f).length, 1); assert.equal(f.sent.filter(s => s === 'look:3').length, 2); f.m.stop('test');
  });
  await test('trance and active cast rite defer healing', async () => {
    for (const rite of [false, true]) { const f = fixture(); if (rite) f.s._rite = {}; else f.hold(true);
      await f.tick(); assert.equal(applications(f).length, 0); assert(!f.sent.includes('inventory')); f.m.stop('test'); }
  });
  await test('trance starting during inspection prevents the final APPLY', async () => {
    const f = fixture(); f.before(kind => { if (kind === 'use') f.hold(true); });
    await f.tick(); assert.equal(applications(f).length, 0); f.m.stop('test');
  });
  await test('health recovery, target departure/reuse, item loss, save, disconnect and stop revoke queued support', async () => {
    for (const change of ['healthy', 'threshold', 'left', 'reuse', 'item', 'save', 'disconnect', 'stop', 'expired']) {
      const f = fixture(); let saves = 0; f.c.idsAsOf = () => ({ saves_seen: saves, saving: false });
      f.before(kind => { if (kind !== 'use') return;
        if (change === 'healthy') f.reports.get(4).health.value = 100;
        if (change === 'threshold') f.reports.get(4).health.value = 95;
        if (change === 'left') f.c.room.objects.delete(4);
        if (change === 'reuse') f.c.room.objects.get(4).nameRsc = 5;
        if (change === 'item') f.c.inventory = [];
        if (change === 'save') saves++;
        if (change === 'disconnect') f.s.live = false;
        if (change === 'stop') f.m.stop('test');
        if (change === 'expired') f.advance(501);
      });
      await f.tick(); assert.equal(applications(f).length, 0, change); f.m.stop('test');
    }
  });
  await test('missing inventory or wrong/stale LOOK fails closed', async () => {
    for (const change of ['inventory', 'wrong', 'stale']) {
      const f = fixture(); if (change === 'inventory') f.inventoryReply(false);
      else f.c.look = id => f.c.emit('look', { id: change === 'wrong' ? 99 : id, at: change === 'stale' ? 1 : 1000100, description: charged });
      await f.tick(); assert.equal(applications(f).length, 0); f.m.stop('test');
    }
  });
  await test('invalid or hostile strategy targets are rejected', async () => {
    const f = fixture(); f.strategy.pvpSupport = () => ({ queue: [{ apply: 3, to: 2, below: .9, min_missing: 2 }], interval_ms: 1000 });
    await f.tick(); assert.equal(applications(f).length, 0); assert.equal(f.m.support.last.status, 'strategy_fault'); f.m.stop('test');
  });
  await test('healing throttle and recipient claim both prevent repeated charges', async () => {
    const f = fixture(); await f.tick(); await f.tick(); assert.equal(applications(f).length, 1);
    f.advance(1000); f.claim(false); await f.tick(); assert.equal(applications(f).length, 1); f.m.stop('test');
  });
  await test('an exhausted first wand cannot trap a charged second wand in repeated refusals', async () => {
    const f = fixture(); f.c.rsc.set(7, 'wand of healing'); f.c.inventory.push({ id: 7, nameRsc: 7 });
    f.c.look = id => f.c.emit('look', { id, description: id === 3 ? 'The once pristine wand is now a blackened mess.' : charged });
    await f.tick(); f.advance(1000); await f.tick();
    assert.deepEqual(applications(f), [['apply', 7, 4]]); f.m.stop('test');
  });
  await test('a claimed or newly healed first recipient does not starve later queue entries', async () => {
    for (const first of ['claimed', 'healthy']) {
      const f = fixture(); f.strategy.pvpSupport = () => ({ queue: [4, 1].map(to => ({ apply: 3, to, below: .9, min_missing: 2 })), interval_ms: 1000 });
      if (first === 'claimed') f.m.support.claim = id => id.character === 'Us';
      else f.before(kind => { if (kind === 'use') f.reports.get(4).health.value = 100; });
      await f.tick(); assert.deepEqual(applications(f), [['apply', 3, 1]]); f.m.stop('test');
    }
  });
  await test('delayed support inspection never holds up movement', async () => {
    const f = fixture(); const wait = f.c.waitFor; let release;
    f.c.waitFor = options => options.kinds.includes('look') ? new Promise(resolve => { release = resolve; }) : wait(options);
    await f.m.tick(); await new Promise(resolve => setImmediate(resolve)); assert(f.sent.includes('move')); assert(release);
    f.m.stop('test'); release({ events: [] }); await f.m.support.task; assert.equal(applications(f).length, 0);
  });
  await test('potions and independent healing compose on the same pursuit pass', async () => {
    const f = fixture(); f.c.inventory.push({ id: 6, nameRsc: 6 });
    f.m.fallback = new CombatFallback(f.m, { catalogue: () => new Map([['test potion', { effect: 'buff', good_description: charged, bad_description: 'spoiled', post_cast_ms: 1000 }]]) });
    f.strategy.pvpFallback = () => ({ queue: [{ use: 6 }], interval_ms: 1000 });
    await f.tick(); assert.equal(applications(f).length, 1); assert(f.sent.some(s => Array.isArray(s) && s[0] === 'use'));
    assert(f.sent.includes('move')); f.m.stop('test');
  });
  await test('published health requires matching endpoint, room, body and fresh time', () => {
    const f = fixture(), directory = join(scratch, 'health'), now = 1000100;
    f.s._healthPublishedVersion = null;
    assert(publishFleetHealth(f.s, { directory, now }));
    const identity = { ...f.s.credentials, character: 'Us' }, opts = { directory, now, room: 38, bodyId: 1, maxAgeMs: 1500 };
    assert.equal(readFleetHealth(identity, opts).health.value, 50);
    for (const extra of [{ room: 39 }, { bodyId: 9 }, { now: now + 1501 }, { now: now - 1 }]) assert.equal(readFleetHealth(identity, { ...opts, ...extra }), null);
    assert.equal(readFleetHealth({ ...identity, port: 5901 }, opts), null); f.m.stop('test');
  });
  await test('health changes publish immediately even within the ordinary half-second throttle', () => {
    const f = fixture(), directory = process.env.M59_FLEET_HEALTH_DIR, now = 1000100;
    f.setHP(70); assert(publishFleetHealth(f.s, { now: now + 1 }));
    assert.equal(readFleetHealth({ ...f.s.credentials, character: 'Us' }, { directory, now: now + 1, room: 38, bodyId: 1 }).health.value, 70);
    assert.equal(publishFleetHealth(f.s, { now: now + 2 }), false); f.m.stop('test');
  });
  await test('recipient claims are exclusive across processes and protect second boundaries', async () => {
    const identity = { host: 'test.invalid', port: 5900, character: 'Ally' }, directory = join(scratch, 'claims');
    const opts = { directory, room: 38, bodyId: 4, now: 1000999 };
    const code = `import {claimFleetHeal} from ${JSON.stringify(new URL('./m59-heal-claims.mjs', import.meta.url).href)}; console.log(claimFleetHeal(${JSON.stringify(identity)},${JSON.stringify(opts)}));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])));
    assert.equal(results.filter(r => r.stdout.trim() === 'true').length, 1);
    assert.equal(claimFleetHeal(identity, { ...opts, now: 1001001 }), false);
    assert.equal(claimFleetHeal(identity, { ...opts, now: 1002001 }), true);
    assert.equal(claimFleetHeal(identity, { ...opts, room: 39 }), true);
  });
  await test('the real pacer preserves offensive priority and does not add an attack gap for support', async () => {
    const { Pacer } = await import('./m59-session.mjs');
    const pacer = new Pacer(50), order = [];
    pacer.lastSent = Date.now();
    const support = pacer.submit('use', () => order.push('support'));
    const attack = pacer.submit('attack', () => order.push('attack'), 0);
    await Promise.all([support, attack]);
    assert.deepEqual(order, ['attack', 'support']);
    assert.equal(pacer.q.length, 0);
  });
  console.log(`\n${passed} support scenarios passed`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
