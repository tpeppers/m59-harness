#!/usr/bin/env node
// "ONLY THOSE IN GUILDS MAY ATTACK EACH OTHER HERE." Offline; opens no socket, touches no roster.
//
//   node tools/m59-guild-refusal-test.mjs
//
// Operator, 2026-10-01: "The bots are getting 'distracted' by a character they cannot attack,
// getting the message 'Only those in guilds may attack each other here.' -- make getting this
// message when trying to attack a target disable the attack attempts for that target in that
// map". room.kod resource `room_guild_combat`, sent by ReqSomethingAttack in a
// ROOM_GUILD_PK_ONLY (0x8) room when AllowGuildAttack says no -- for us, an unguilded victim.
//
// Pins: after the sentence follows an attack on a player in a guild-only room, no path sends
// another attack at that player in that room; another player there is still attacked; leaving
// the room forgets it, so the next room attacks again; the refused player hurting us takes no
// body from the keeper's own survival ladder, while an attackable attacker still does.
import './m59-test-ledger.mjs';        // FIRST -- the ledger goes to a scratch file
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-guild-refusal-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_KEEPOFF_FILE = join(dir, 'keepoff.json');

const refused = await import('./m59-refused-targets.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { M59Client } = await import('./m59-client.mjs');
const skills = await import('./m59-skills.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');

let tests = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); tests++; console.log(`ok ${name}`); }
  catch (e) { failed++; console.log(`not ok ${name}\n  ${String(e.message).split('\n')[0]}`); }
}
const reset = () => { writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', enemy_guilds: {}, members: {} }));
  writeFileSync(process.env.M59_WAR_ALARM_FILE, ''); writeFileSync(process.env.M59_GRUDGE_FILE, '{}'); };
const P = OF.PLAYER | OF.ATTACKABLE;
const SENTENCE = 'Only those in guilds may attack each other here.';     // room.kod:37 room_guild_combat
const CV = 38, CV_FLAGS = 0x0008;                                       // Castle Victoria, ROOM_GUILD_PK_ONLY

function fixture({ name = 'Us', room = CV, roomFlags = CV_FLAGS, war = true } = {}) {
  let clock = Date.now();
  const sent = [], logged = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, name], [2, 'Morpheus'], [3, 'Stranger'], [4, 'Gonzo']]), spells: [], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    look(id) { sent.push(`look:${id}`); },
    safety(on) { sent.push('safety:' + on); this.self.flags = on ? OF.SAFETY : 0; } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: null, need: () => c, refusedLog: line => logged.push(line),
    world: { room: { num: room, flags: roomFlags }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); } };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock,
    schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; }, unschedule: id => timers.delete(id) });
  mode.character = () => name;
  mode.fleetmate = n => ['us', 'gonzo'].includes(String(n).toLowerCase());
  mode.warEligibility = () => war;
  return { s, c, sent, logged, mode, advance(ms) { clock += ms; } };
}
const put = (f, id, flags, row = 5, col = 6) => f.c.room.objects.set(id, { id, nameRsc: id, row, col, flags });
const attacksAt = (f, id) => f.sent.filter(x => x === `attack:${id}`).length;
const moveTo = (f, room, roomFlags = 0) => { f.s.world.room = { num: room, flags: roomFlags };
  f.mode.event({ kind: 'room-entered' }); };

// ------------------------------------------------------------------ the sentence

await test('the matcher takes the server resource exactly, and through colour codes and spacing', () => {
  assert.equal(refused.isGuildOnlyRefusal(SENTENCE), true);
  assert.equal(refused.isGuildOnlyRefusal('~BOnly those in guilds  may attack each other here.~n'), true);
  assert.equal(refused.isGuildOnlyRefusal("You can't fight here."), false, 'a ROOM refusal is a different sentence');
  assert.equal(refused.isGuildOnlyRefusal('Stranger says, "only those in guilds"'), false);
});

// ------------------------------------------------------------------ an operator order

await test('an order on a player refused in a guild-only room stops, and is not retried there', async () => {
  reset(); const f = fixture({ war: false });
  put(f, 3, P);
  assert.equal(f.mode.issue({ action: 'attack', target: 'Stranger' }).accepted, true);
  await f.mode.tick();
  assert.equal(attacksAt(f, 3), 1);
  f.mode.event({ kind: 'message', text: SENTENCE });
  assert.equal(f.mode.active, null, 'the body is handed back rather than held on a target it cannot hit');
  assert.ok(f.mode.targetRefused('Stranger'), 'remembered for this room');
  assert.equal(f.logged.length, 1); assert.match(f.logged[0], /Stranger cannot be attacked in room 38 \(guild-only\); not retrying here/);
  // A re-issued order is refused here without a packet; no attack goes out however many ticks pass.
  const again = f.mode.issue({ action: 'attack', target: 'Stranger' });
  assert.equal(again.accepted, false); assert.match(again.reason, /guild-only/);
  for (let i = 0; i < 5; i++) { f.advance(2000); f.mode.event({ kind: 'appeared', id: 3 }); await f.mode.tick(); }
  assert.equal(attacksAt(f, 3), 1, `sent ${f.sent}`);
  assert.equal(f.mode.status().refused_targets?.[0]?.name, 'Stranger', 'visible in combat status');
});

await test('another player in the same room is still attacked', async () => {
  reset(); const f = fixture({ war: false });
  put(f, 3, P); put(f, 2, P, 5, 7);
  f.mode.issue({ action: 'attack', target: 'Stranger' }); await f.mode.tick();
  f.mode.event({ kind: 'message', text: SENTENCE });
  assert.equal(f.mode.issue({ action: 'attack', target: 'Morpheus' }).accepted, true);
  await f.mode.tick();
  assert.equal(attacksAt(f, 2), 1, `sent ${f.sent}`);
  f.mode.stop('test');
});

await test('leaving the room forgets it: the same player is attacked in a different room', async () => {
  reset(); const f = fixture({ war: false });
  put(f, 3, P);
  f.mode.issue({ action: 'attack', target: 'Stranger' }); await f.mode.tick();
  f.mode.event({ kind: 'message', text: SENTENCE });
  moveTo(f, 39);                                   // Upstairs in Castle Victoria
  assert.equal(f.mode.targetRefused('Stranger'), null);
  assert.equal(f.mode.issue({ action: 'attack', target: 'Stranger' }).accepted, true);
  await f.mode.tick();
  assert.equal(attacksAt(f, 3), 2, `sent ${f.sent}`);
  f.mode.stop('test');
  // ...and coming back to 38 is a fresh start too: the entry went when the room did.
  moveTo(f, CV, CV_FLAGS);
  assert.equal(f.mode.targetRefused('Stranger'), null);
});

await test('the entry expires after REFUSED_TTL_MS even without leaving', async () => {
  reset(); const f = fixture({ war: false });
  put(f, 3, P);
  f.mode.issue({ action: 'attack', target: 'Stranger' }); await f.mode.tick();
  f.mode.event({ kind: 'message', text: SENTENCE });
  f.advance(refused.REFUSED_TTL_MS - 1000); assert.ok(f.mode.targetRefused('Stranger'));
  f.advance(2000); assert.equal(f.mode.targetRefused('Stranger'), null);
});

// ------------------------------------------------------------------ the war response

await test('war: a war-marked player refused here is not re-engaged on the next scan or alarm', async () => {
  reset(); const f = fixture();
  put(f, 3, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 3 });
  assert.ok(f.mode.active?.pvp); await f.mode.tick();
  assert.equal(attacksAt(f, 3), 1);
  f.mode.event({ kind: 'message', text: SENTENCE });
  assert.equal(f.mode.active, null, 'no attacker left that can be hit: the fight ends');
  for (let i = 0; i < 4; i++) { f.advance(1000); f.mode.event({ kind: 'appeared', id: 3 }); f.mode.event({ kind: 'changed', id: 3 }); await f.mode.tick(); }
  assert.equal(f.mode.onWarAlarm({ at: Date.now(), room: CV, reporter: 'Gonzo', enemy: 'Stranger', basis: 'attacked' }), false);
  assert.equal(f.mode.active, null);
  assert.equal(attacksAt(f, 3), 1, `sent ${f.sent}`);
});

await test('war: a second, attackable enemy in the room is still engaged', async () => {
  reset(); const f = fixture();
  put(f, 3, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 3 }); await f.mode.tick();
  f.mode.event({ kind: 'message', text: SENTENCE });
  put(f, 2, P | OF.ENEMY, 5, 7); f.mode.event({ kind: 'appeared', id: 2 });
  assert.ok(f.mode.active?.pvp); await f.mode.tick();
  assert.equal(attacksAt(f, 2), 1, `sent ${f.sent}`);
  f.mode.stop('test');
});

// ------------------------------------------------------------------ survival

await test('a hit FROM a refused player clears the refusal: they are a target again and return fire starts', async () => {
  // AllowGuildAttack is symmetric. A player it refuses us cannot hit us here either, so a stroke
  // that lands means they joined a guild, took a shield or a token, or turned murderer.
  reset(); const f = fixture({ war: false });
  put(f, 3, P);
  f.mode.issue({ action: 'attack', target: 'Stranger' }); await f.mode.tick();
  f.mode.event({ kind: 'message', text: SENTENCE });
  assert.ok(f.mode.targetRefused('Stranger'));
  f.c.hp = 70;
  f.mode.event({ kind: 'message', text: "Stranger's scimitar cleaves you." });
  assert.equal(f.mode.targetRefused('Stranger'), null, 'the refusal is stale and forgotten');
  assert.ok(f.logged.some(l => /Stranger attacked us in room 38; the guild-only refusal is stale/.test(l)), `${f.logged}`);
  assert.ok(f.mode.active?.pvp, 'return fire starts, exactly as for anybody else');
  await f.mode.tick();
  assert.equal(attacksAt(f, 3), 2, `sent ${f.sent}`);
  f.mode.stop('test');
});

await test('survival: a refused player who has NOT attacked us is never swung at while an attacker is fought', async () => {
  reset(); const f = fixture();
  put(f, 3, P); put(f, 2, P, 5, 7);
  f.mode.refuseTarget('Stranger');
  f.mode.event({ kind: 'message', text: "Morpheus's scimitar cleaves you." });
  assert.ok(f.mode.active?.pvp, 'return fire on the attacker we CAN hit');
  await f.mode.tick();
  assert.equal(attacksAt(f, 2), 1); assert.equal(attacksAt(f, 3), 0, `sent ${f.sent}`);
  assert.ok(f.mode.targetRefused('Stranger'), 'somebody else hitting us clears nothing');
  f.mode.stop('test');
});

// ------------------------------------------------------------------ the session-wide memory

await test('the session observer attributes the sentence to the player the client last attacked', () => {
  const s = { name: 't7', world: { room: { num: CV } }, refusedLog: () => {} };
  const c = { lastAttackTarget: { at: Date.now(), id: 77, name: 'Stranger', player: true, via: 'attack' } };
  assert.equal(refused.observeRefusal(s, c, { kind: 'message', text: SENTENCE })?.name, 'Stranger');
  assert.ok(refused.refusedHere(s, 'stranger'), 'case-insensitive, by name');
  // A monster swing is never what this sentence is about.
  const s2 = { world: { room: { num: CV } }, refusedLog: () => {} };
  const m = { lastAttackTarget: { at: Date.now(), id: 9, name: 'orc', player: false } };
  assert.equal(refused.observeRefusal(s2, m, { kind: 'message', text: SENTENCE }), null);
  // Leaving the room forgets.
  s.world.room = { num: 39 }; refused.observeRefusal(s, c, { kind: 'room-entered' });
  assert.equal(refused.refusedHere(s, 'Stranger'), null);
});

await test('the client sends no attack packet at a refused player here, and still attacks everything else', () => {
  const s = { world: { room: { num: CV } }, refusedLog: () => {} };
  const c = new M59Client({ resources: new Map() });
  const packets = []; c.send = (op, ...rest) => packets.push(op);
  c.selfId = 1; c.rsc = new Map([[3, 'Stranger'], [2, 'Morpheus'], [5, 'orc']]);
  c.room = { id: 1, objects: new Map([[3, { id: 3, nameRsc: 3, flags: P }], [2, { id: 2, nameRsc: 2, flags: P }],
    [5, { id: 5, nameRsc: 5, flags: OF.ATTACKABLE }]]) };
  c.attackVeto = id => refused.vetoAttack(s, c, id);
  c.attack(3);
  assert.equal(c.lastAttackTarget.name, 'Stranger'); assert.equal(c.lastAttackTarget.player, true);
  refused.observeRefusal(s, c, { kind: 'message', text: SENTENCE });
  const before = packets.length;
  assert.equal(c.attack(3), false); assert.equal(packets.length, before, 'vetoed');
  c.attack(2); c.attack(5);
  assert.equal(packets.length, before + 2, 'another player and a monster are unaffected');
  s.world.room = { num: 39 };
  c.attack(3); assert.equal(packets.length, before + 3, 'a different room attacks again');
});

await test('skills.findCreature leaves a refused player out of a player hunt; monsters unaffected', () => {
  const c = { selfId: 1, self: { row: 5, col: 5 }, rsc: new Map([[3, 'Stranger'], [2, 'Morpheus'], [5, 'Stranger']]),
    room: { objects: new Map([[3, { id: 3, nameRsc: 3, row: 5, col: 6, flags: P }], [2, { id: 2, nameRsc: 2, row: 5, col: 7, flags: P }],
      [5, { id: 5, nameRsc: 5, row: 5, col: 8, flags: OF.ATTACKABLE }]]) } };
  const s = { need: () => c, world: { room: { num: CV } }, refusedLog: () => {} };
  refused.noteRefused(s, 'Stranger');
  const ids = skills.findCreature(s, '', { includePlayers: true }).map(o => o.id);
  assert.deepEqual(ids.sort(), [2, 5], `got ${ids}`);
});

// ------------------------------------------------------------------ the keeper's own paths

function keeperWith(players, { refusedName = null } = {}) {
  const k = Object.create(Autopilot.prototype);
  const c = { selfId: 1, self: { col: 10, row: 10 }, me: { name: 'Us' },
    rsc: new Map(players.map(o => [o.nameRsc, o.name])), room: { objects: new Map(players.map(o => [o.id, o])) },
    equipment: () => ({ known: false }), vitals: () => ({}) };
  const s = { name: 't1', live: true, client: c, world: { room: { num: CV } }, refusedLog: () => {},
    cancelMovement: () => ({ interrupted: true }) };
  Object.assign(k, { policy: { fightBackAfterMs: 10_000, defendAgainstPlayers: true }, watch: { attack: null },
    tally: { kills: 0 }, notes: [], fought: [], killTimes: [], fledInARow: 0, passes: 1, doing: 'farming',
    inert: null, hold: null, s, inReachOfUs: () => players, refuseEngagement: () => null,
    safety: () => ({ fleeAt: 0.4, engageAt: 0.75 }), note: (what, d) => k.notes.push({ what, ...d }),
    progress() {}, noProgress() {}, ledgerEvent() {}, countLoot() {}, who: () => 't1',
    weaponPriorityNow: () => null, bannedWeaponsNow: () => null, wearLootedArmour: async () => {},
    fightNow: async opts => { k.fought.push(opts); return { fought: true, killed: false, rounds: 1, landed_hits: 0 }; } });
  if (refusedName) refused.noteRefused(s, refusedName);
  return k;
}
const pl = (id, name, col) => ({ id, name, nameRsc: 'r' + id, col, row: 10, flags: P });

await test('fight-back: a refused player in reach is not picked; another one is', async () => {
  const k = keeperWith([pl(3, 'Stranger', 11), pl(2, 'Morpheus', 12)], { refusedName: 'Stranger' });
  k.fightBackDue = { since: Date.now() - 12_000, hits: 5, lost: 5, at: Date.now() };
  await k.passFightBack({ s: k.s, c: k.s.client, room: { name: 'CV', num: CV }, v: { health: { value: 90, max: 100 } }, hp: 0.9 });
  assert.equal(k.fought.length, 1); assert.equal(k.fought[0].target, 'Morpheus');
  const only = keeperWith([pl(3, 'Stranger', 11)], { refusedName: 'Stranger' });
  only.fightBackDue = { since: Date.now() - 12_000, hits: 5, lost: 5, at: Date.now() };
  await only.passFightBack({ s: only.s, c: only.s.client, room: { name: 'CV', num: CV }, v: { health: { value: 90, max: 100 } }, hp: 0.9 });
  assert.equal(only.fought.length, 0, 'nothing to swing at: the ordinary ladder carries on');
});

await test('self-defence: a flagged attacker refused here is not returned fire on', async () => {
  const grudge = await import('./m59-grudge.mjs');
  reset(); grudge.recordAttack('Stranger', { who: 'Us' });
  const k = keeperWith([{ ...pl(3, 'Stranger', 11), flags: P | 0x4000 }], { refusedName: 'Stranger' });
  assert.equal(await k.defendAgainstPlayers(), null);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
