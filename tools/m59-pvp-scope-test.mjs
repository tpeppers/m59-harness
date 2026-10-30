// Offline guard for the PvP SCOPE joints (pvp.target, pvp.refused, pvp.assist), tools/m59-combat-assist.mjs, the
// combat sheet in the fleet-health report, and the fleet action claim. Opens no socket and touches no roster: the war
// book, the alarm file, the published reports and the claims all live in a temp directory.
//
//   node tools/m59-pvp-scope-test.mjs
//
// What it pins, in the order a reviewer should care:
//   1. NO PAK, NO CHANGE. A refused swing at a player in a return-fire fight is retried, as it always was; nobody is
//      ever indirect; the target pick is the old one.
//   2. ONE PROBE. With a pak answering pvp.refused, a player the server will not let us hit is swung at once and the
//      fight moves to the player it CAN hit (Scooter, Rick Deckard and Morpheus, 2026-10-29).
//   3. A HIT UNDOES IT. An indirect combatant whose blow reaches us is direct again; pvp.target cannot overrule a hit.
//   4. ASSIST. When only indirect combatants are left the fight assists: a cast on an ally under a fleet claim, a
//      monster on an ally, another player who IS hittable. Never a cast at an enemy.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-scope-test-'));
for (const [k, f] of Object.entries({ M59_WAR_FILE: 'war.json', M59_WAR_ALARM_FILE: 'war-alarms.jsonl', M59_GRUDGE_FILE: 'grudges.json',
  M59_PVP_GEAR_FILE: 'gear.json' })) process.env[k] = join(dir, f);
process.env.M59_FLEET_HEALTH_DIR = join(dir, 'health');
process.env.M59_ACTION_CLAIM_DIR = join(dir, 'claims');
writeFileSync(process.env.M59_PVP_GEAR_FILE, '{}');
writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', enemy_guilds: {}, members: {} }));
writeFileSync(process.env.M59_WAR_ALARM_FILE, '');
writeFileSync(process.env.M59_GRUDGE_FILE, '{}');

const { CombatMode } = await import('./m59-combat-mode.mjs');
const { JointHost, validateJointDecision } = await import('./m59-joints.mjs');
const { claimFleetAction } = await import('./m59-fleet-claims.mjs');
const { publishFleetHealth, readFleetHealth } = await import('./m59-fleet-health.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const P = OF.PLAYER | OF.ATTACKABLE;
const SAFETY = 'Hey! You almost hit Rick Deckard! Good thing your safety was on!';
const OURS = new Set(['scooter', 'gonzo']);

let clock = 1_800_000_000_000;
function fixture({ paks = [], name = 'Scooter' } = {}) {
  const sent = [];
  const c = { state: 'game', combatReady: true, selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY | OF.PLAYER },
    me: { name }, room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, name], [2, 'Rick Deckard'], [3, 'Morpheus'], [4, 'Gonzo'], [5, 'avar warrior'], [10, 'magic shield'],
      [11, 'mushroom'], [12, 'red mushroom'], [13, 'flask']]),
    spells: [{ id: 900, nameRsc: 10 }], inventory: [{ id: 50, nameRsc: 11, amount: 6 }, { id: 51, nameRsc: 12, amount: 3 }, { id: 52, nameRsc: 13 }],
    hp: 100, mana: 40,
    vitals() { return { health: { value: this.hp, max: 100 }, mana: { value: this.mana, max: 60 } }; },
    enchantments: () => [],
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    cast(id, targets) { sent.push(`cast:${id}:${targets.join(',')}`); this.lastCastSent = { at: clock, id, name: 'magic shield' }; },
    apply(id, on) { sent.push(`apply:${id}:${on}`); },
    look() {}, safety(on) { sent.push('safety:' + on); this.self.flags = on ? (OF.SAFETY | OF.PLAYER) : OF.PLAYER; } };
  c.room.objects.set(1, c.self);
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0, job: null, need: () => c,
    credentials: { host: 'test.invalid', port: 5959 },
    world: { room: { num: 2154 }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); } };
  s.pacer = { holdStatus: () => ({ active: false }), async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  s.joints = new JointHost({ character: name, now: () => clock }).use(paks.map(pak => ({ pak })));
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock, schedule: () => 0, unschedule() {} });
  mode.character = () => name;
  mode.fleetmate = n => OURS.has(String(n).toLowerCase());
  mode.warEligibility = () => true;
  mode.crossDoorToward = async () => false;
  return { s, c, sent, mode };
}
const put = (f, id, flags, row = 5, col = 6) => f.c.room.objects.set(id, { id, nameRsc: id, row, col, flags });
const attacksAt = (f, id) => f.sent.filter(x => x === `attack:${id}`).length;
// The incoming blow the server says to the victim (m59-player-evidence.mjs parsePlayerCombat).
const blow = (f, who) => f.mode.event({ kind: 'message', text: `You dodge ${who}'s attack.`, at: clock });
async function swing(f) { await f.mode.tick(); clock += 1100; }

// The paks the tests load. Synthetic and deliberately dumb: the private policy is not under test here.
const REFUSE = { name: 't-refuse', joints: { 'pvp.refused': () => ({ do: 'indirect', why: 'the server said no' }) } };
const PRESORT = { name: 't-presort', joints: { 'pvp.target': f => ({ do: 'order',
  indirect: f.candidates.filter(c => /rick/i.test(c.name)).map(c => c.name), why: 'same faction' }) } };
const assistPak = answer => ({ name: 't-assist', joints: { 'pvp.assist': f => answer(f) } });

try {
  // ---------------------------------------------------------------------------------------------- the catalogue
  await test('the three joints validate their closed answer sets', () => {
    assert.deepEqual(validateJointDecision('pvp.target', { do: 'order', first: ['Morpheus'], indirect: 'Rick Deckard' }).decision,
      { do: 'order', first: ['morpheus'], indirect: ['rick deckard'], why: null });
    assert.match(validateJointDecision('pvp.target', { do: 'order' }).error, /first or indirect/);
    assert.equal(validateJointDecision('pvp.refused', { do: 'indirect' }).decision.do, 'indirect');
    assert.match(validateJointDecision('pvp.refused', { do: 'swing_harder' }).error, /unknown answer/);
    const cast = validateJointDecision('pvp.assist', { do: 'cast', spell: 'Magic Shield', target: 'Gonzo', claim: { key: 'ms|gonzo|7', ms: 2000 } }).decision;
    assert.deepEqual(cast, { do: 'cast', spell: 'magic shield', target: 'Gonzo', claim: { key: 'ms|gonzo|7', ms: 2000 }, why: null });
    assert.match(validateJointDecision('pvp.assist', { do: 'cast', spell: 'bless', claim: 'mine' }).error, /claim/);
    assert.match(validateJointDecision('pvp.assist', { do: 'fight_monster', id: -3 }).error, /object id/);
    assert.equal(validateJointDecision('pvp.assist', { do: 'wait', ms: 99_999 }).decision.ms, 10_000);
    assert.match(validateJointDecision('pvp.assist', { do: 'say', text: 'hi' }).error, /unknown answer/, 'no answer speaks');
  });

  await test('fleet claims: one claimant per key per window, and the next window is open again', () => {
    const scope = { host: 'h', port: 1, room: 2154 };
    assert.equal(claimFleetAction(scope, 'magic shield|gonzo', { now: 10_000, ms: 2000 }), true);
    assert.equal(claimFleetAction(scope, 'magic shield|gonzo', { now: 11_500, ms: 2000 }), false, 'same window');
    assert.equal(claimFleetAction(scope, 'MAGIC SHIELD|Gonzo', { now: 11_900, ms: 2000 }), false, 'keys are case-insensitive');
    assert.equal(claimFleetAction(scope, 'magic shield|gonzo', { now: 12_000, ms: 2000 }), true, 'a fizzle is picked up next window');
    assert.equal(claimFleetAction({ ...scope, room: 2101 }, 'magic shield|gonzo', { now: 11_000, ms: 2000 }), true, 'rooms are separate');
    assert.equal(claimFleetAction({ host: 'h', port: 1, room: 1 }, 'x', { now: 1 }), false, 'a claim it cannot scope is refused');
  });

  // ---------------------------------------------------------------------------------------- 1. no pak, no change
  await test('NO PAK: a safety refusal in return fire is retried at the same player, as it always was', async () => {
    const f = fixture();
    put(f, 2, P); put(f, 3, P, 5, 7);
    blow(f, 'Rick Deckard'); blow(f, 'Morpheus');
    assert.ok(f.mode.active?.pvp);
    assert.equal(String(f.mode.active.order.target).toLowerCase(), 'rick deckard');
    await swing(f);
    f.mode.event({ kind: 'message', text: SAFETY });
    await swing(f); await swing(f);
    assert.ok(attacksAt(f, 2) >= 2, `swung at Rick ${attacksAt(f, 2)}x (the old loop)`);
    assert.equal(attacksAt(f, 3), 0);
    assert.deepEqual(f.mode.active.pvp.indirect ?? {}, {}, 'nobody is indirect without a pak');
    assert.notEqual(f.mode.active.phase, 'assisting');
    f.mode.stop('test');
  });

  // ------------------------------------------------------------------------------------------- 2. one probe
  await test('pvp.refused: ONE swing at the player we cannot hit, then the fight is at the one we can', async () => {
    const f = fixture({ paks: [REFUSE] });
    put(f, 2, P); put(f, 3, P, 5, 7);
    blow(f, 'Rick Deckard'); blow(f, 'Morpheus');
    await swing(f);
    assert.equal(attacksAt(f, 2), 1);
    f.mode.event({ kind: 'message', text: SAFETY });
    assert.ok(f.mode.isIndirect(f.mode.active, 'Rick Deckard'));
    assert.equal(String(f.mode.active.order.target).toLowerCase(), 'morpheus');
    for (let i = 0; i < 4; i++) await swing(f);
    assert.equal(attacksAt(f, 2), 1, 'never again');
    assert.ok(attacksAt(f, 3) >= 2, `Morpheus swung at ${attacksAt(f, 3)}x`);
    assert.equal(f.mode.active.pvp.indirect['rick deckard'].source, 'pvp.refused');
    f.mode.stop('test');
  });

  await test('pvp.refused with only the indirect one left and no assist handler: the fight hands back to the keeper', async () => {
    const f = fixture({ paks: [REFUSE] });
    put(f, 2, P);
    blow(f, 'Rick Deckard');
    await swing(f);
    f.mode.event({ kind: 'message', text: SAFETY });
    assert.equal(f.mode.active, null);
    assert.match(f.mode.last.reason, /indirect combatant/);
  });

  // ----------------------------------------------------------------------------------------- 3. a hit undoes it
  await test('an indirect combatant who hits us is direct again (one more probe)', async () => {
    const f = fixture({ paks: [REFUSE] });
    put(f, 2, P); put(f, 3, P, 5, 7);
    blow(f, 'Rick Deckard'); blow(f, 'Morpheus');
    await swing(f);
    f.mode.event({ kind: 'message', text: SAFETY });
    assert.ok(f.mode.isIndirect(f.mode.active, 'Rick Deckard'));
    clock += 5000;
    blow(f, 'Rick Deckard');
    assert.equal(f.mode.isIndirect(f.mode.active, 'Rick Deckard'), false);
    f.mode.stop('test');
  });

  await test('pvp.target: a known same-side player is never swung at -- zero probes', async () => {
    const f = fixture({ paks: [PRESORT] });
    put(f, 2, P); put(f, 3, P, 5, 7);
    // Morpheus arrives by a blow, Rick by a fleetmate's alarm (he never hit us).
    blow(f, 'Morpheus');
    f.mode.beginPvP({ character: 'Rick Deckard', text: 'zone alarm', reason_code: 'zone_alarm' });
    for (let i = 0; i < 3; i++) await swing(f);
    assert.equal(attacksAt(f, 2), 0);
    assert.ok(attacksAt(f, 3) >= 1);
    assert.equal(f.mode.active.pvp.indirect['rick deckard'].source, 'pvp.target');
    f.mode.stop('test');
  });

  await test('pvp.target cannot make indirect a player whose blow reached us in the last 30 s', async () => {
    const f = fixture({ paks: [PRESORT] });
    put(f, 2, P);
    blow(f, 'Rick Deckard');
    assert.equal(f.mode.isIndirect(f.mode.active, 'Rick Deckard'), false);
    await swing(f);
    assert.equal(attacksAt(f, 2), 1, 'the hit earns him a swing');
    f.mode.stop('test');
  });

  // ----------------------------------------------------------------------------------------------- 4. assist
  await test('assist: only indirect players left -> the fight ASSISTS, and casts on an ally under a claim', async () => {
    const asked = [];
    const f = fixture({ paks: [REFUSE, assistPak(facts => { asked.push(facts);
      return { do: 'cast', spell: 'magic shield', target: 'Gonzo', claim: { key: `magic shield|gonzo|${Math.floor(clock / 2000)}`, ms: 2000 } }; })] });
    put(f, 2, P); put(f, 4, OF.PLAYER, 6, 6);
    blow(f, 'Rick Deckard');
    await swing(f);
    f.mode.event({ kind: 'message', text: SAFETY });
    assert.equal(f.mode.active.phase, 'assisting');
    await f.mode.tick();
    assert.ok(f.sent.includes('cast:900:4'), `sent ${f.sent}`);
    assert.equal(attacksAt(f, 2), 1);
    const facts = asked[0];
    assert.deepEqual(facts.hostiles.map(h => [h.name, h.indirect, h.combatant]), [['Rick Deckard', true, true]]);
    assert.deepEqual(facts.allies.map(a => [a.name, a.self]), [['Scooter', true], ['Gonzo', false]]);
    assert.ok(facts.me.castable.includes('magic shield'), 'mana 40 >= 9, two mushrooms and a red one');
    assert.ok(!f.sent.includes('safety:false'), 'safety never comes off to assist');
    f.mode.stop('test');
  });

  await test('assist: a claim another keeper already holds is not cast', async () => {
    const key = `magic shield|gonzo|lost`;
    const f = fixture({ paks: [REFUSE, assistPak(() => ({ do: 'cast', spell: 'magic shield', target: 'Gonzo', claim: { key, ms: 10_000 } }))] });
    put(f, 2, P); put(f, 4, OF.PLAYER, 6, 6);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    // Another keeper took it this window.
    assert.equal(claimFleetAction({ host: 'test.invalid', port: 5959, room: 2154 }, key, { now: clock, ms: 10_000 }), true);
    await f.mode.tick();
    assert.ok(!f.sent.some(x => x.startsWith('cast:')), `sent ${f.sent}`);
    assert.equal(f.mode.assist.last?.reason, 'claim_lost');
    f.mode.stop('test');
  });

  await test('assist: a cast is never aimed at an enemy -- that is `attack`', async () => {
    const f = fixture({ paks: [REFUSE, assistPak(() => ({ do: 'cast', spell: 'magic shield', target: 'Rick Deckard' }))] });
    put(f, 2, P);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    await f.mode.tick();
    assert.ok(!f.sent.some(x => x.startsWith('cast:')));
    assert.equal(f.mode.assist.last.reason, 'cast_target_not_an_ally_here');
    f.mode.stop('test');
  });

  await test('assist: `attack` puts another player back in the fight, and he is swung at', async () => {
    const f = fixture({ paks: [REFUSE, assistPak(f2 => f2.hostiles.some(h => h.name === 'Morpheus' && !h.in_fight)
      ? { do: 'attack', target: 'Morpheus' } : { do: 'wait', ms: 1000 })] });
    put(f, 2, P);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    assert.equal(f.mode.active.phase, 'assisting');
    put(f, 3, P, 5, 7);           // Morpheus walks in; he has hit nobody of ours that this keeper heard
    await swing(f);
    assert.notEqual(f.mode.active.phase, 'assisting');
    await swing(f);
    assert.ok(attacksAt(f, 3) >= 1, `sent ${f.sent}`);
    assert.equal(attacksAt(f, 2), 1);
    f.mode.stop('test');
  });

  await test('assist: `fight_monster` swings at that monster by id', async () => {
    const f = fixture({ paks: [REFUSE, assistPak(f2 => f2.monsters[0] ? { do: 'fight_monster', id: f2.monsters[0].id } : null)] });
    put(f, 2, P); put(f, 5, OF.ATTACKABLE, 5, 6);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    await swing(f);
    assert.equal(attacksAt(f, 5), 1, `sent ${f.sent}`);
    f.mode.stop('test');
  });

  await test('assist: `stand_down` ends the fight', async () => {
    const f = fixture({ paks: [REFUSE, assistPak(() => ({ do: 'stand_down', why: 'nothing to do' }))] });
    put(f, 2, P);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    await f.mode.tick();
    assert.equal(f.mode.active, null);
    assert.match(f.mode.last.reason, /stand_down/);
  });

  // ------------------------------------------------------------------------------------- the published sheet
  await test('fleet-health carries the combat sheet, and an ally reads it back as facts', async () => {
    const gonzo = fixture({ name: 'Gonzo' });
    gonzo.c.selfId = 4; gonzo.c.self.id = 4; gonzo.c.self.nameRsc = 4; gonzo.c.room.objects.clear(); gonzo.c.room.objects.set(4, gonzo.c.self);
    gonzo.c.enchantments = () => [{ name: 'Bless', type: 1 }];
    assert.equal(publishFleetHealth(gonzo.s, { now: clock }), true);
    const r = readFleetHealth({ host: 'test.invalid', port: 5959, character: 'Gonzo' }, { room: 2154, bodyId: 4, now: clock });
    assert.deepEqual(r.combat.buffs, ['bless']);
    assert.ok(r.combat.spells.includes('magic shield'));
    assert.equal(r.combat.role, null, 'not in a fight');
    const f = fixture({ paks: [REFUSE, assistPak(() => ({ do: 'wait', ms: 1000 }))] });
    put(f, 2, P); put(f, 4, OF.PLAYER, 6, 6);
    blow(f, 'Rick Deckard'); await swing(f); f.mode.event({ kind: 'message', text: SAFETY });
    clock -= 1100;
    const facts = f.mode.assist.facts(f.mode.active);
    const ally = facts.allies.find(a => a.name === 'Gonzo');
    assert.deepEqual(ally.buffs, ['bless']);
    assert.equal(ally.health_pct, 100);
    assert.ok(ally.report_age_ms >= 0);
    assert.equal(facts.allies[0].role, 'indirect', 'our own role while assisting');
    clock += 1100;
    f.mode.stop('test');
  });

  await test('alarm_elsewhere tells a strategy whether the alarm room is one exit away', () => {
    const f = fixture();
    let facts = null;
    f.mode.pvpStrategy = { decide: (moment, x) => { facts = x; return null; } };
    f.mode.exitRooms = () => [2153, 2155];
    f.mode.onWarAlarm({ enemy: 'Rick Deckard', room: 2153, basis: 'attacked', reporter: 'Gonzo', at: clock });
    assert.equal(facts.alarm_adjacent, true);
    clock += 6000;
    f.mode.onWarAlarm({ enemy: 'Rick Deckard', room: 2001, basis: 'attacked', reporter: 'Gonzo', at: clock });
    assert.equal(facts.alarm_adjacent, false);
  });

  console.log(`\n${tests} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
