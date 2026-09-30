// Offline guard for the guild-war response: tools/m59-war.mjs, the war arm of
// `mayReturnFire`, and CombatMode's zone-coordinated engagement. Opens no socket, touches
// no roster; the war book and alarm file live in a temp directory.
//
//   node tools/m59-war-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-war-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');

const war = await import('./m59-war.mjs');
const grudge = await import('./m59-grudge.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const reset = () => { writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', enemy_guilds: {}, members: {} }));
  writeFileSync(process.env.M59_WAR_ALARM_FILE, ''); writeFileSync(process.env.M59_GRUDGE_FILE, '{}'); };
const P = OF.PLAYER | OF.ATTACKABLE;
const OURS = new Set(['us', 'statler', 'gonzo', 'kermit']);
const isOurs = n => OURS.has(String(n).toLowerCase());

// ------------------------------------------------------------------ parsing

await test('the server kill broadcast names both guilds, with the doubled article', () => {
  const k = war.parseGuildCombat('### Statler of the The Second Swines has been slaughtered by Morpheus of the Human Resistance in guild combat.');
  assert.deepEqual(k, { victim: 'Statler', victimGuild: 'The Second Swines', killer: 'Morpheus', killerGuild: 'Human Resistance' });
  assert.equal(war.parseGuildCombat('### Kermit was just killed by a troll.'), null);
  assert.equal(war.normGuild('the The Second Swines'), war.normGuild('Second Swines'));
});

await test('a look reply yields the guild line and never the faction line', () => {
  const extra = 'He has called Jasper home for eight years.\nSquire of the Human Resistance.\nA staunch servant of Duke Akardius.\n';
  assert.deepEqual(war.parseGuildLine(extra), { rank: 'Squire', guild: 'Human Resistance' });
  assert.equal(war.parseGuildLine('She has wandered for two years.\nA staunch servant of Duke Akardius.\n'), null);
  assert.equal(war.parseGuildLine('She has wandered for two years.\nElected Royal Justicar of the Meridian.\n'), null);
});

await test('war declarations: mutual is war, one-sided is only intent', () => {
  assert.deepEqual(war.parseWarDeclaration('~BBe it known that The Second Swines and Human Resistance are now at war!'),
    { a: 'Second Swines', b: 'Human Resistance', mutual: true });
  assert.equal(war.parseWarDeclaration('Be it known that members of the Human Resistance are sworn enemies of the The Second Swines!').mutual, false);
});

// ------------------------------------------------------------------ the book

await test('a guild-combat kill of ours declares the war and remembers the killer', () => {
  reset();
  const r = war.learnFromMessage('### Statler of the The Second Swines has been slaughtered by Morpheus of the Human Resistance in guild combat.', { isOurs });
  assert.equal(r.ours, true); assert.equal(r.enemy, 'Morpheus');
  assert.equal(war.isEnemyGuild('Human Resistance'), true);
  assert.equal(war.isEnemyGuild('The Second Swines'), false, 'our own guild is never an enemy');
  assert.equal(war.current().our_guild, 'The Second Swines');
  assert.equal(war.rememberedEnemy('morpheus').guild, 'Human Resistance');
  // A kill between two strangers' guilds teaches nothing about our war.
  assert.equal(war.learnFromMessage('### A of the X has been slaughtered by B of the Y in guild combat.', { isOurs }).ours, false);
  assert.equal(war.isEnemyGuild('Y'), false);
});

await test('declaring our own guild an enemy is refused', () => {
  reset(); war.setOurGuild('The Second Swines');
  assert.equal(war.declareEnemyGuild('Second Swines'), null);
  assert.equal(war.isEnemyGuild('Second Swines'), false);
});

await test('a remembered member stays an enemy; an unguilded look does not erase it', () => {
  reset(); war.declareEnemyGuild('Human Resistance');
  war.recordMembership('Rick Deckard', 'Human Resistance', { source: 'look' });
  war.recordUnguilded('Rick Deckard');
  assert.equal(war.rememberedEnemy('Rick Deckard').guild, 'Human Resistance');
  assert.equal(war.needsLook('Rick Deckard'), false, 'a known enemy is not looked at again');
  assert.equal(war.needsLook('Somebody New'), true);
});

await test('a server refusal suspends a remembered enemy, and it comes back after REFUSED_MS', () => {
  reset(); war.declareEnemyGuild('Human Resistance');
  const t = Date.now();
  war.recordMembership('Wenbo', 'Human Resistance', { at: t });
  war.markRefused('Wenbo', { at: t });
  assert.equal(war.rememberedEnemy('Wenbo', { now: t + 1000 }), null);
  assert.ok(war.rememberedEnemy('Wenbo', { now: t + war.REFUSED_MS + 1 }));
});

await test('a corrupt book is never overwritten by a mutation', () => {
  writeFileSync(process.env.M59_WAR_FILE, '{"format":"m59-war/1","enemy_guilds":{"human resist');
  const r = war.declareEnemyGuild('Somebody');
  assert.match(r.error, /will not parse/);
  assert.match(readFileSync(process.env.M59_WAR_FILE, 'utf8'), /human resist/);
});

// ------------------------------------------------------------------ mayReturnFire

await test('mayReturnFire: the server enemy mark is enough, no grudge and no murderer flag', () => {
  reset();
  const v = grudge.mayReturnFire({ name: 'Morpheus', flags: P | OF.ENEMY });
  assert.equal(v.engage, true); assert.equal(v.war, 'war_flag');
  // The pre-war rule is unchanged for an ordinary stranger.
  assert.equal(grudge.mayReturnFire({ name: 'Morpheus', flags: P }).engage, false);
});

await test('mayReturnFire: a remembered enemy member is engaged; a fleetmate or guildmate never is', () => {
  reset(); war.declareEnemyGuild('Human Resistance'); war.recordMembership('Morpheus', 'Human Resistance');
  assert.equal(grudge.mayReturnFire({ name: 'Morpheus', flags: P }).war, 'remembered');
  assert.equal(grudge.mayReturnFire({ name: 'Morpheus', flags: P | OF.ENEMY }, { fleetmate: true }).engage, false);
  assert.equal(grudge.mayReturnFire({ name: 'Morpheus', flags: P | OF.ENEMY | OF.GUILDMATE }).engage, false);
  assert.equal(grudge.mayReturnFire({ name: 'Morpheus', flags: OF.ENEMY | OF.ATTACKABLE }).engage, false, 'not a player');
});

await test('mayReturnFire: murderers with a grudge still engage exactly as before', () => {
  reset(); grudge.recordAttack('Spartacus', { who: 'Kermit' });
  assert.equal(grudge.mayReturnFire({ name: 'Spartacus', flags: P | 0x4000 }).engage, true);
  assert.equal(grudge.mayReturnFire({ name: 'Spartacus', flags: P }).engage, false);
});

// ------------------------------------------------------------------ CombatMode

function fixture({ name = 'Us', room = 38, enabled = true } = {}) {
  let clock = Date.now();
  const sent = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, name], [2, 'Morpheus'], [3, 'Stranger'], [4, 'Gonzo']]), spells: [], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    look(id) { sent.push(`look:${id}`); },
    safety(on) { sent.push('safety:' + on); this.self.flags = on ? OF.SAFETY : 0; } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: null, need: () => c,
    world: { room: { num: room }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); } };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock,
    schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; }, unschedule: id => timers.delete(id) });
  mode.character = () => name;
  mode.fleetmate = isOurs;
  mode.warEligibility = () => enabled;
  return { s, c, sent, mode, advance(ms) { clock += ms; } };
}
const put = (f, id, flags, row = 5, col = 6) => f.c.room.objects.set(id, { id, nameRsc: id, row, col, flags });

await test('off unless the owning process enables it: an enemy in the room is ignored', async () => {
  reset(); const f = fixture({ enabled: false });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  assert.equal(f.mode.active, null); assert.deepEqual(f.sent, []);
});

await test('an enemy-marked entrant starts return fire at once, with safety LEFT ON', async () => {
  reset(); const f = fixture();
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 });
  assert.ok(f.mode.active?.pvp, 'PvP survival owns the body');
  assert.equal(f.mode.active.keepSafety, true);
  await f.mode.tick();
  assert.ok(f.sent.includes('attack:2'), `sent ${f.sent}`);
  assert.ok(!f.sent.includes('safety:false'), 'safety never comes off for a war target');
  // And the rest of the map hears about it.
  const alarms = war.readAlarms();
  assert.equal(alarms.length, 1); assert.equal(alarms[0].enemy, 'Morpheus'); assert.equal(alarms[0].room, 38);
  f.mode.stop('test');
});

await test('an operator kill order on a war-marked target also keeps safety on', async () => {
  reset(); const f = fixture(); f.mode.warEligibility = () => false;
  put(f, 2, P | OF.ENEMY);
  f.mode.issue({ action: 'kill', target: 'Morpheus' }); await f.mode.tick();
  assert.ok(f.sent.includes('attack:2')); assert.ok(!f.sent.includes('safety:false'));
  f.mode.stop('test');
});

await test('a zone alarm pulls in a fleetmate in the same map, and only that map', async () => {
  reset();
  const here = fixture({ name: 'Kermit', room: 38 }), there = fixture({ name: 'Gonzo', room: 39 });
  put(here, 2, P); put(there, 2, P);                      // no enemy mark: only the alarm says so
  assert.equal(there.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Statler', enemy: 'Morpheus', basis: 'attacked' }), false);
  assert.equal(there.mode.active, null);
  assert.equal(here.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Statler', enemy: 'Morpheus', basis: 'attacked' }), true);
  assert.equal(here.mode.active.keepSafety, true);
  await here.mode.tick(); assert.ok(here.sent.includes('attack:2'));
  // An alarm naming one of ours, or raised by ourselves, is ignored.
  const other = fixture({ name: 'Kermit', room: 38 });
  assert.equal(other.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Kermit', enemy: 'Morpheus' }), false);
  assert.equal(other.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Statler', enemy: 'Gonzo' }), false);
  here.mode.stop('test');
});

await test('an incoming hit raises the alarm, so the victim is not alone', async () => {
  reset(); const f = fixture();
  put(f, 2, P);
  f.mode.event({ kind: 'message', text: "Morpheus's scimitar cleaves you." });
  assert.ok(f.mode.active?.pvp);
  assert.equal(war.readAlarms().at(-1)?.basis, 'attacked');
  f.mode.stop('test');
});

await test('the alarm file reaches a watcher, fresh lines only', async () => {
  reset();
  appendFileSync(process.env.M59_WAR_ALARM_FILE, JSON.stringify({ at: Date.now(), room: 38, reporter: 'Old', enemy: 'X' }) + '\n');
  const got = [];
  const w = war.watchAlarms(a => got.push(a), { pollMs: 20 });
  war.raiseAlarm({ room: 38, reporter: 'Statler', enemy: 'Morpheus' });
  w.drain();
  w.close();
  assert.deepEqual(got.map(a => a.reporter), ['Statler'], 'an alarm from before the watcher started is not replayed');
});

await test('a refused war swing drops the target and marks the memory, safety stayed on', async () => {
  reset(); war.declareEnemyGuild('Human Resistance'); war.recordMembership('Morpheus', 'Human Resistance');
  const f = fixture();
  put(f, 2, P);                                          // remembered only, no server mark
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('attack:2'));
  f.mode.event({ kind: 'message', text: 'Hey! You almost hit Morpheus! Good thing your safety was on!' });
  assert.equal(f.mode.active, null, 'the war engagement ended');
  assert.equal(war.rememberedEnemy('Morpheus'), null, 'and the memory is suspended');
  assert.ok(!f.sent.includes('safety:false'));
});

await test('unknown strangers are looked at once, by the room\'s look leader only', async () => {
  reset(); war.declareEnemyGuild('Human Resistance');
  const leader = fixture({ name: 'Gonzo' }), follower = fixture({ name: 'Kermit' });
  for (const f of [leader, follower]) { put(f, 3, P); put(f, 9, P, 6, 6); f.c.rsc.set(9, f === leader ? 'Kermit' : 'Gonzo'); }
  leader.mode.event({ kind: 'appeared', id: 3 }); follower.mode.event({ kind: 'appeared', id: 3 });
  assert.deepEqual(leader.sent, ['look:3']); assert.deepEqual(follower.sent, []);
  // The answer names an enemy guild: remembered, and engaged.
  leader.mode.event({ kind: 'look', id: 3, player: true,
    extra: 'He has wandered for a year.\nRecruit of the Human Resistance.\n' });
  assert.equal(war.rememberedEnemy('Stranger')?.rank, 'Recruit');
  assert.ok(leader.mode.active?.pvp, 'a newly identified enemy is engaged');
  leader.mode.stop('test');
});

await test('no looks at all while the fleet is at war with nobody', async () => {
  reset(); const f = fixture();
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  assert.deepEqual(f.sent, []);
});

await test('a guildmate or fleetmate in the room is never a target, whatever the flags say', async () => {
  reset(); const f = fixture();
  put(f, 4, P | OF.ENEMY);                               // Gonzo is ours
  put(f, 3, P | OF.ENEMY | OF.GUILDMATE);
  f.mode.event({ kind: 'room-contents' });
  assert.equal(f.mode.active, null);
});

// ------------------------------------------------------------------ sentinels

await test('a sentinel (a host) reports an enemy fleet-wide and never engages', async () => {
  reset(); const f = fixture({ name: 'Loial', room: 2, enabled: false });
  f.mode.sentinelEligibility = () => true;
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 });
  assert.equal(f.mode.active, null, 'a sentinel does not fight');
  assert.deepEqual(f.sent, []);
  const a = war.readAlarms().at(-1);
  assert.equal(a.basis, 'sighted'); assert.equal(a.room, 2); assert.equal(a.enemy, 'Morpheus'); assert.equal(a.reporter, 'Loial');
  // Standing there does not flood the file: one sighting per WAR_SIGHTING_EVERY_MS.
  f.mode.event({ kind: 'changed', id: 2 }); f.mode.event({ kind: 'changed', id: 2 });
  assert.equal(war.readAlarms().length, 1);
});

await test('a sighting in another map is recorded as the fleet\'s threat, and pulls nobody', async () => {
  reset(); const guard = fixture({ name: 'Lew', room: 39 });
  put(guard, 2, P);
  assert.equal(guard.mode.onWarAlarm({ at: Date.now(), room: 2, reporter: 'Loial', enemy: 'Morpheus', basis: 'sighted' }), false);
  assert.equal(guard.mode.active, null);
  assert.equal(guard.mode.status().war.threat.room, 2);
  assert.equal(guard.mode.status().war.threat.enemy, 'Morpheus');
});

await test('a sighting in OUR map is a report, not a call to arms; a fight is', async () => {
  reset(); const f = fixture({ name: 'Kermit', room: 38 });
  put(f, 2, P);                                          // no enemy mark here
  assert.equal(f.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Loial', enemy: 'Morpheus', basis: 'sighted' }), false);
  assert.equal(f.mode.active, null);
  assert.equal(f.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Statler', enemy: 'Morpheus', basis: 'attacked' }), true);
  f.mode.stop('test');
});

await test('a noncombatant is named in the book, by character, and can be taken back off', () => {
  reset();
  assert.equal(war.isNoncombatant('Loial the Ogier'), false);
  war.setNoncombatant('Loial the Ogier');
  assert.equal(war.isNoncombatant('  loial THE ogier '), true);
  war.setNoncombatant('Loial the Ogier', false);
  assert.equal(war.isNoncombatant('Loial the Ogier'), false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
