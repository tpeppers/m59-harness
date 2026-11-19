#!/usr/bin/env node
// THE POISON EXIT -- offline, no socket, no roster.
//
//   node tools/m59-poison-exit-test.mjs
//
// Waldorf (t4), 2026-11-19 04:11Z, Ancient Place 579, 146 max health, killed by a black spider. Two stacked black-spider
// poisons (10 a tick), the healing session's one logoff spent at 112, then 112 -> 10 on a square nothing could reach while
// the recovery dispatcher rested him 8 s at a time and ended every pass before the survival ladder. The first poison
// ended, the client erased the ailment while the second still drained, the next tick read as "took 4 damage while resting
// -- something is hitting us", and he walked off the square at 9 health into four black spiders. What this pins:
//   * a stacked poison stays an ailment until its LAST stack ends (m59-client.mjs counts enchantments by the spell id);
//   * a poison tick is told from an attack by the poison's own 10 s clock and size, a hit message, or neither
//     (m59-poison.mjs PoisonWatch), including after the icon is gone;
//   * the verdict: a square nothing can reach SHELTERS (the operator's rule, no logoff); a reached square with health to
//     spare is not a shelter (RESPOND); reached with health, or health less the poison to come, at the flee line or one
//     blow from death: EXIT -- cure, potion, heal, the logoff even in a spent session (once), then out of the room;
//   * the one-logoff rule gives exactly one override per session, never a loop;
//   * restUntil no longer calls a poison tick an attack when the icon has gone, and does call a bite one when it has not;
//   * the recovery dispatcher asks the verdict before it sits a body down, and playDead sees through a spent session.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_HEALING_DIR = mkdtempSync(join(tmpdir(), 'm59-poison-exit-'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const P = await import('./m59-poison.mjs');
const H = await import('./m59-healing-session.mjs');
const { M59Client } = await import('./m59-client.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const skills = await import('./m59-skills.mjs');
const { readToolSource } = await import('./autopilot/source.mjs');

// ------------------------------------------------------------------------------------------------------------ the client
console.log('a stacked poison is an ailment until its last stack ends');
{
  // BP_ADD_ENCHANTMENT: type byte, then an object (id, icon, name, flags, rarity, light flags, animation NONE + group,
  // no overlays). BP_REMOVE_ENCHANTMENT: type byte, id. The id is the SPELL object's: two bites, one id.
  const add = (type, id, nameRsc) => {
    const b = Buffer.alloc(1 + 4 * 5 + 2 + 1 + 2 + 1);
    let p = 0; b.writeUInt8(type, p++);
    for (const v of [id, 7, nameRsc, 0]) { b.writeUInt32LE(v, p); p += 4; }
    b.writeInt32LE(0, p); p += 4; b.writeUInt16LE(0, p); p += 2;
    b.writeUInt8(1, p++); b.writeUInt16LE(0, p); p += 2; b.writeUInt8(0, p++);
    return b;
  };
  const remove = (type, id) => { const b = Buffer.alloc(5); b.writeUInt8(type, 0); b.writeUInt32LE(id, 1); return b; };
  const c = Object.create(M59Client.prototype);
  Object.assign(c, { enchantmentsById: new Map(), rsc: new Map([[900, 'poison'], [901, 'light']]), events: [], evSeq: 0,
    maxEvents: 500, waiters: [], parseErrors: [], enchantmentObservations: { add() {}, remove() {}, invalidate() {} } });
  c.onGameMessage(147, add(1, 3565, 900));
  c.onGameMessage(147, add(1, 3565, 900));
  ok('two black-spider bites: one ailment counted twice', c.ailments().length === 1 && c.ailments()[0].count === 2,
     JSON.stringify(c.ailments()));
  c.onGameMessage(148, remove(1, 3565));
  ok('the first poison ends ("The poison abates somewhat."): STILL POISONED -- Waldorf walked off his square here',
     c.poisoned() && P.poisonedNow(c) && c.ailments()[0].count === 1);
  c.onGameMessage(148, remove(1, 3565));
  ok('the second ends: not poisoned', !c.poisoned() && c.enchantmentsById.size === 0);
  c.onGameMessage(147, add(2, 77, 901)); c.onGameMessage(147, add(2, 77, 901));
  c.onGameMessage(148, remove(2, 77));
  ok('a ROOM icon is re-sent with every room-contents and stays a set: one remove clears it', c.enchantmentsById.size === 0);
  c.onGameMessage(147, add(1, 3565, 900)); c.onGameMessage(147, add(1, 3565, 900));
  c.send = () => {};
  c.requestEnchantments();
  ok('a full re-read (login, post-save) starts the player list from empty, so the reply cannot double it',
     c.enchantmentsById.size === 0);
  const SRC = readToolSource(new URL('./m59-client.mjs', import.meta.url), 'utf8');
  ok('the post-save re-read asks for the enchantments again (BP_INVALIDATE_DATA emptied them)',
     /requestSkills\(\); this\.requestEnchantments\(\); \}/.test(SRC));
}

// ------------------------------------------------------------------------------------------------------- the watch
console.log('which fall was the poison');
const T0 = 1_795_061_343_000;
function waldorfWatch() {
  // Two stacks, 10 a tick on a 10 s clock, regeneration +1 every 3 s in between: the vitals trail
  // [78,79,80,70,71,72,73,63,...]. Sampled at 500 ms like the watchdog.
  const w = new P.PoisonWatch(), client = {};
  let hp = 80;
  const falls = [];
  for (let ms = 0; ms <= 60_000; ms += 500) {
    if (ms > 0 && ms % 10_000 === 0) hp -= 10;
    else if (ms % 3_000 === 0 && ms % 10_000 !== 0) hp += 1;
    const f = w.sample({ at: T0 + ms, hp, poisoned: true, addedAt: T0 - 20_000, client });
    if (f) falls.push(f);
  }
  return { w, hp, falls, client };
}
{
  const { w, falls } = waldorfWatch();
  ok('six poison ticks in a minute, every one attributed to the poison', falls.length === 6 && falls.every(f => f.kind === 'poison'),
     JSON.stringify(falls.map(f => f.kind)));
  ok('the tick size is learned (10: two stacks)', w.tickSize() === 10);
  ok('it is ticking', w.ticking(T0 + 60_500, true));
}
{
  // The first stack ends; the icon goes; the second keeps draining at 5 on the same clock.
  const { w, client } = waldorfWatch();
  let hp = 40;
  w.sample({ at: T0 + 61_000, hp, poisoned: false, client });
  const tick = w.sample({ at: T0 + 70_000, hp: hp - 5, poisoned: false, client });
  ok('after the icon went, a 5 on the clock is STILL THE POISON (the misreading that killed Waldorf)', tick?.kind === 'poison',
     JSON.stringify(tick));
  ok('and the poison is still ticking for everyone who asks', w.ticking(T0 + 71_000, false));
  const bite = w.sample({ at: T0 + 74_000, hp: hp - 9, poisoned: false, client });
  ok('a fall off the clock is an attack', bite?.kind === 'attack');
  ok('...and the last attack is remembered for the exposure test', w.lastAttackAt() === T0 + 74_000);
  ok('a long quiet ends "ticking" (no stale poison forever)', !w.ticking(T0 + 200_000, false));
}
{
  const { w, client } = waldorfWatch();
  w.sample({ at: T0 + 63_000, hp: 46, poisoned: true, client });
  const bite = w.sample({ at: T0 + 64_000, hp: 42, poisoned: true, client });
  ok('POISONED, a fall off the clock is an attack too (it used to be excused for as long as the icon showed)', bite?.kind === 'attack');
  const w2 = waldorfWatch();
  w2.w.sample({ at: T0 + 69_000, hp: 46, poisoned: true, client: w2.client, hitAt: T0 + 69_500 });
  const hit = w2.w.sample({ at: T0 + 70_000, hp: 32, poisoned: true, client: w2.client });
  ok('a fall with a hit message beside it is an attack, even on the clock', hit?.kind === 'attack');
  const w3 = waldorfWatch();
  w3.w.sample({ at: T0 + 69_000, hp: 46, poisoned: true, client: w3.client });
  const big = w3.w.sample({ at: T0 + 70_000, hp: 30, poisoned: true, client: w3.client });
  ok('a fall on the clock but bigger than the tick is an attack', big?.kind === 'attack');
  const w4 = waldorfWatch();
  w4.w.sample({ at: T0 + 61_000, hp: 46, poisoned: true, client: {} });           // a reconnect: a new client object
  const first = w4.w.sample({ at: T0 + 64_000, hp: 36, poisoned: true, client: w4.w.client });
  ok('a reconnect restarts the clock (UserLogonHook starts a fresh timer): its first tick is the poison', first?.kind === 'poison');
}
{
  const w = new P.PoisonWatch();
  const f = w.sample({ at: 1000, hp: 50, client: 1 }) ?? w.sample({ at: 2000, hp: 44, client: 1 });
  ok('not poisoned, never was: every fall is an attack (unchanged)', f?.kind === 'attack');
}
{
  const { w } = waldorfWatch();
  const pr = w.projection({ hp: 80, now: T0 + 60_000, poisoned: true });
  ok('projection: 80 health less what is still to come, never under the clamp at 1 (player.kod PoisonTimer)',
     pr.floor === 1 && pr.tick === 10 && pr.drain >= 100, JSON.stringify(pr));
  const late = w.projection({ hp: 140, now: T0 + 155_000, poisoned: true });
  ok('a poison nearly over projects a small drain', late.drain <= 30 && late.floor >= 110, JSON.stringify(late));
  ok('levelBlow: a level-75 black spider hits for at most 9 (monster.kod GetDamage, Fuzzy)', P.levelBlow(75) === 9);
}

// ---------------------------------------------------------------------------------------------------- the verdict
console.log('what a poisoned body on its shelter does');
const base = { max: 146, poisoned: true, fleeAt: 0.45, now: T0, strongestHit: 9,
               logoff: { available: false, overrideAvailable: true } };
{
  const v = P.poisonExitVerdict({ ...base, hp: 10, projection: { floor: 1 }, inReach: 0, wallOk: true });
  ok('WALDORF\'S REAL SQUARE: nothing in reach, a geometric wall, no attack -- shelter in place, no logoff (the operator\'s rule)',
     v.act === 'shelter' && !v.exits, v.why);
  const v2 = P.poisonExitVerdict({ ...base, hp: 10, projection: { floor: 1 }, inReach: 3, wallOk: true });
  ok('things standing beside a wall they cannot attack across do not make it exposed', v2.act === 'shelter');
}
{
  // The brief's case: 80/146, poison 10 every 10 s, a spider in reach landing 4s, one logoff already used.
  const v = P.poisonExitVerdict({ ...base, hp: 80, projection: { floor: 1 }, inReach: 1, wallOk: false, lastAttackAt: T0 - 2000 });
  ok('80/146, poison 10/10s, a spider in reach biting, logoff spent: EXIT, before health reaches the flee line (66)',
     v.act === 'exit' && v.line === 66 && v.floor === 1, v.why);
  ok('exits in order: the override logoff, then out of the room (no cure, potion or heal known)',
     JSON.stringify(v.exits) === JSON.stringify(['logoff_override', 'leave_room']), JSON.stringify(v.exits));
  const spent = P.poisonExitVerdict({ ...base, hp: 80, projection: { floor: 1 }, inReach: 1, wallOk: false, lastAttackAt: T0 - 2000,
    logoff: { available: false, overrideAvailable: false } });
  ok('override already used: the room\'s way out is what is left -- never a third logoff', JSON.stringify(spent.exits) === '["leave_room"]');
  const all = P.poisonExitVerdict({ ...base, hp: 80, projection: { floor: 1 }, inReach: 1, wallOk: false, lastAttackAt: T0 - 2000,
    can: { cure: true, potion: true, heal: true }, logoff: { available: true } });
  ok('cure, potion, heal, logoff, leave -- in that order', JSON.stringify(all.exits) === '["cure","potion","heal","logoff","leave_room"]');
  const hitOnWall = P.poisonExitVerdict({ ...base, hp: 30, projection: { floor: 1 }, inReach: 0, wallOk: true, lastAttackAt: T0 - 5000 });
  ok('a "wall" that was hit five seconds ago is not a shelter', hitOnWall.act === 'exit');
  const old = P.poisonExitVerdict({ ...base, hp: 30, projection: { floor: 1 }, inReach: 0, wallOk: true, lastAttackAt: T0 - 60_000 });
  ok('...but a hit a minute ago, on a wall nothing can reach now, does not make it one', old.act === 'shelter');
  const room = P.poisonExitVerdict({ ...base, hp: 140, projection: { floor: 135 }, inReach: 1, wallOk: false, lastAttackAt: T0 - 2000 });
  ok('reached with health to spare and the poison nearly over: RESPOND (the spot failed; move or fight), not a logoff',
     room.act === 'respond' && !room.exits, room.why);
  const oneBlow = P.poisonExitVerdict({ ...base, fleeAt: 0.05, hp: 12, projection: { floor: 12 }, inReach: 1, wallOk: false,
    strongestHit: 14, lastAttackAt: T0 - 1000 });
  ok('one blow from death counts even under a low flee line', oneBlow.act === 'exit' && oneBlow.line === 14);
  ok('not poisoned: no verdict at all (the ordinary ladder is untouched)', P.poisonExitVerdict({ ...base, poisoned: false, hp: 5 }).act === 'none');
}

// --------------------------------------------------------------------------------------------- the one-logoff rule
console.log('projected death outranks the one-logoff rule, once');
{
  ok('no session: no override (there is an ordinary logoff to take)', !H.mayOverrideLogoff('waldorf'));
  H.noteLogoff('waldorf', { why: 'poisoned: sheltering in place', room: 579 });
  ok('the session\'s one logoff spent: ordinary logoff refused, override available', !H.mayLogoff('waldorf') && H.mayOverrideLogoff('waldorf'));
  H.noteLogoff('waldorf', { why: 'poisoned and reached', room: 579, override: 'projected death' });
  const s = H.readSession('waldorf');
  ok('the override is recorded with its reason', s.logoffs === 2 && s.overrides === 1 && s.override_why === 'projected death');
  ok('and is spent: no third logoff, override or not', !H.mayLogoff('waldorf') && !H.mayOverrideLogoff('waldorf'));
  let logoffs = 0;
  for (let i = 0; i < 40; i++) {                                   // forty "dying" triggers inside one session
    const now = Date.now() + i * 3000;
    if (H.mayLogoff('fozzie2', { now })) { H.noteLogoff('fozzie2', { why: 'doomed', now }); logoffs++; }
    else if (H.mayOverrideLogoff('fozzie2', { now })) { H.noteLogoff('fozzie2', { why: 'doomed', override: 'projected', now }); logoffs++; }
  }
  ok('NO LOOP: forty triggers, exactly two logoffs (the one, and its one override)', logoffs === 2, String(logoffs));
}

// ------------------------------------------------------------------------------------------------------- restUntil
console.log('a rest is interrupted by a bite and not by a poison tick');
async function restWith({ hpAt, ailing, prepare }) {
  let t = T0 + 100_000;
  const c = { evSeq: 0, events: [], statsById: new Map(),
    vitals: () => ({ health: { value: hpAt(t), max: 146 }, vigor: { value: 120, scale_max: 200 } }),
    ailments: () => (ailing(t) ? [{ name: 'poison', at: T0 }] : []),
    stats: async () => {}, waitFor: async () => {}, rest: () => {}, stand: () => {} };
  const s = { need: () => c, client: c, pacer: { submit: async (_k, f) => f() }, poisonWatch: new P.PoisonWatch() };
  prepare?.(s.poisonWatch, c, t);
  // The keeper's watchdog samples every 500 ms during the rest's waits.
  const wait = async ms => { for (let i = 0; i < ms; i += 500) { t += 500; s.poisonWatch.sampleClient(c, t); } };
  const r = await skills.restUntil(s, { health: 1, vigor: 0.4, maxSeconds: 24, now: () => t, wait });
  return r;
}
{
  // Icon gone, second stack still ticking 5 on its clock (anchor at T0 + 90 s).
  const r = await restWith({
    hpAt: t => 40 - 5 * Math.floor((t - (T0 + 90_000)) / 10_000),
    ailing: () => false,
    prepare: (w, c) => { w.sample({ at: T0 + 80_000, hp: 50, poisoned: true, addedAt: T0, client: c });
                         w.sample({ at: T0 + 90_000, hp: 40, poisoned: true, addedAt: T0, client: c }); },
  });
  ok('icon gone, the second stack still on its clock: the rest is NOT interrupted (Waldorf walked off his square here)',
     !r.interrupted && r.poison_drain > 0, JSON.stringify({ interrupted: r.interrupted, drain: r.poison_drain }));
}
{
  // Icon showing, and a bite at +101.7 s that is nowhere near the clock.
  const r = await restWith({
    hpAt: t => (t >= T0 + 101_500 ? 32 : 40),
    ailing: () => true,
    prepare: (w, c) => { w.sample({ at: T0 + 90_000, hp: 50, poisoned: true, addedAt: T0, client: c });
                         w.sample({ at: T0 + 100_000, hp: 40, poisoned: true, addedAt: T0, client: c }); },
  });
  ok('poisoned and bitten off the clock: the rest IS interrupted (a poisoned body on a leaking square is not resting)',
     /off the poison's clock/.test(r.interrupted ?? ''), String(r.interrupted));
}

// ------------------------------------------------------------------------------------------------------ the keeper
console.log('the keeper asks before it sits a poisoned body down');
{
  const AP = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = AP.indexOf("if (d.status==='recovering') {");
  const branch = AP.slice(at, AP.indexOf('skills.restUntil(s,{health:1', at));
  ok('the recovering branch asks the poison verdict before any heal or rest', /const poison=this\.poisonExitState\?\.\(v\);\s*\n\s*if\(poison\?\.act==='exit'\) return await this\.takePoisonExit\(poison,d\);/.test(branch));
  ok('and its rest is cancelled when the verdict turns to exit', /poisonExitState\?\.\(\)\?\.act==='exit'/.test(branch));
  ok('playDead sees through a spent session when the verdict grants the override',
     /override=mayOverrideLogoff\(me\)\?\(this\.poisonOverrideReason\?\.\(\)\?\?null\):null;/.test(AP));
  ok('the overmatch verdict counts a poison still ticking after its icon went', /poison still ticking after its icon went/.test(AP));
}
function pilot({ hp = 80, poisoned = true, near = [], wallOk = false, attackAt = null, spent = true, name = 'waldorf-k' } = {}) {
  const notes = [], onset = Date.now() - 20_000;   // two bites twenty seconds ago
  const c = { selfId: 1, self: { id: 1, row: 20, col: 36 }, state: 'game', combatReady: true, evSeq: 0, events: [],
    statsById: new Map(), inventory: [], spells: [], rsc: new Map(), room: { id: 1549, objects: new Map() },
    vitals: () => ({ health: { value: hp, max: 146 }, vigor: { value: 64, scale_max: 200 }, mana: { value: 39, max: 39 } }),
    ailments: () => (poisoned ? [{ name: 'poison', at: onset, last_at: onset, count: 2 }] : []) };
  const s = { name, client: c, live: true, world: { room: { num: 579 } }, movementGeneration: 0, poisonWatch: new P.PoisonWatch() };
  if (attackAt) s.poisonWatch.hitAt = attackAt;
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { s, policy: { fleeBelow: 0.45 }, note: (w, d) => notes.push({ w, d }), _notes: notes,
    inReachOfUs: () => near, wallHere: () => ({ ok: wallOk }), safety: () => ({ fleeAt: 0.45 }), creatureLevel: () => 75 });
  if (spent) H.noteLogoff(name, { why: 'poisoned: sheltering in place', room: 579 });
  return k;
}
{
  const sheltered = pilot({ name: 'shelter-k', hp: 10, near: [], wallOk: true });
  ok('the keeper\'s verdict on Waldorf\'s real square: shelter', sheltered.poisonExitState().act === 'shelter');
  ok('...and no override is offered to playDead there', sheltered.poisonOverrideReason() === null);
  const spider = { id: 9, name: 'black spider', row: 20, col: 37 };
  const reached = pilot({ name: 'reached-k', hp: 80, near: [spider], wallOk: false, attackAt: Date.now() - 2000 });
  const v = reached.poisonExitState();
  ok('the keeper\'s verdict at 80/146 with a spider biting: exit, override first', v.act === 'exit' && v.exits[0] === 'logoff_override',
     JSON.stringify(v.exits));
  ok('playDead is offered the override with the verdict\'s reason', /poisoned and reached/.test(reached.poisonOverrideReason() ?? ''));
  const arrived = pilot({ name: 'arrived-k', hp: 40, near: [], wallOk: true, attackAt: Date.now() - 4000 });
  arrived.hold = { row: 20, col: 36, takenAt: Date.now() - 1000 };
  ok('the bites that drove a body to its wall do not condemn the wall it reached: shelter', arrived.poisonExitState().act === 'shelter');
  arrived.s.poisonWatch.hitAt = Date.now() - 200;
  ok('a bite taken ON the wall does: exit', arrived.poisonExitState().act === 'exit');
  const calm = pilot({ name: 'calm-k', hp: 80, poisoned: false, near: [spider], attackAt: Date.now() - 2000 });
  ok('not poisoned: the verdict is none, and nothing here changes the ordinary ladder', calm.poisonExitState().act === 'none'
     && calm.poisonOverrideReason() === null);
}
{
  // takePoisonExit walks the exits in order, one per call, and never logs off twice.
  const spider = { id: 9, name: 'black spider', row: 20, col: 37 };
  const k = pilot({ name: 'exit-k', hp: 80, near: [spider], wallOk: false, attackAt: Date.now() - 2000 });
  const calls = [];
  k.playDead = async why => { calls.push(['playDead', why]); return true; };
  k.leaveRoomForRecovery = async d => { calls.push(['leave', d?.strategy]); return true; };
  k.noteFailedRestSpot = (...a) => calls.push(['failed', ...a]);
  k.progress = () => {};
  const v = k.poisonExitState();
  ok('first call: the square is recorded as failed and the logoff is taken', await k.takePoisonExit(v) === true
     && calls.some(x => x[0] === 'failed') && calls.some(x => x[0] === 'playDead'));
  calls.length = 0;
  ok('an immediate second call does not log off again (one try per step), it leaves the room', await k.takePoisonExit(v) === true
     && !calls.some(x => x[0] === 'playDead') && calls.some(x => x[0] === 'leave' && x[1] === 'leave_room'), JSON.stringify(calls));
  calls.length = 0;
  ok('a third, with everything tried: false -- the ordinary ladder gets the pass', await k.takePoisonExit(v) === false && calls.length <= 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
