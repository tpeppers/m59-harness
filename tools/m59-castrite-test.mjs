#!/usr/bin/env node
// CAST RITES AND THE TRANCE DOOR: what must NOT change, and what is new.
//
//   node tools/m59-castrite-test.mjs
//
// Offline: fakes of a client and a session, the real Pacer, Session methods, M59Client methods and
// strategy loader. No socket, no roster, and never this machine's substrate/strategies/.
//
// WHAT IT PINS
//   1. Silence is the old behaviour: with no strategy (or one that declines, throws or answers
//      nonsense) a wrapped cast sends exactly what it sent before, once, and nothing else.
//   2. A caller's own cast hold is untouched: moves dropped, its opening cast passes, released by
//      the caller only.
//   3. Every cast with a trance is now waited out (Session.noteCastSent): moves and gear dropped,
//      a second cast WAITS rather than breaking it, a walk may go through on request, and the hold
//      ends on the broken/refused/no-start evidence -- never on its own sentence of completion,
//      which the game does not have.
//   4. No move sent during a trance is a run (M59Client.moveTo).
//   5. A rite dresses before the cast, never during the trance, and puts back exactly what it
//      changed; idle gear takes a robe off outside an inn and forbids the keeper re-wearing it.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pacer, Session } from './m59-game.mjs';
import { M59Client } from './m59-client.mjs';
import { withCastRite, idleGearCheck, normalizeRite, castRiteContext, riteStatus } from './m59-castrite.mjs';
import { tranceMs, baseTranceMs, classifyTranceLine, tranceSafeSpeed } from './m59-trance.mjs';
import { itemSpellModifier, gearSpellModifier, isDiscipleRobe, robeSchoolFromLook } from './m59-spellpower.mjs';
import { load } from './m59-strategies.mjs';
import { wearBest } from './m59-skills.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.stack ?? e).toString().split('\n').slice(0, 3).join('\n       ')); }
};
const pause = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ fakes
const ROBE = 101, PLATE = 102, AXE = 103, HAMMER = 104, BOW = 105;
function fakeClient({ worn = [PLATE, AXE] } = {}) {
  const names = { [ROBE]: 'robes of the disciple', [PLATE]: 'plate armor', [AXE]: 'axe', [HAMMER]: 'hammer', [BOW]: 'longbow' };
  const c = {
    sent: [], evSeq: 0, selfId: 1,
    inventory: Object.keys(names).map(id => ({ id: Number(id), nameRsc: Number(id), amount: 1 })),
    using: new Set(worn),
    spells: [{ id: 7, name: 'hold' }, { id: 8, name: 'enchant weapon' }, { id: 9, name: 'blink' }],
    rsc: { get: id => names[id] },
    use(id) { this.sent.push(['use', id]); if (id === ROBE) this.using.delete(PLATE); if (id === PLATE) this.using.delete(ROBE);
              if ([AXE, HAMMER, BOW].includes(id)) for (const w of [AXE, HAMMER, BOW]) this.using.delete(w);
              this.using.add(id); this.evSeq++; },
    unuse(id) { this.sent.push(['unuse', id]); this.using.delete(id); this.evSeq++; },
    cast(id, targets) { this.sent.push(['cast', id, targets]); this.onCastSent?.({ id, name: this.spells.find(x => x.id === id)?.name, targets }); },
    look(id) { this.sent.push(['look', id]); },
    async waitFor({ kinds, match } = {}) {
      if (kinds?.includes('look')) return { events: [{ kind: 'look', id: ROBE, description: 'Heavy and warm.  These robes bear the insignia of Qor and will give bonuses to spells in that school.' }] };
      return { events: [{ kind: 'equipment' }] };
    },
  };
  return c;
}
function fakeSession({ c = fakeClient(), answer = undefined, idle = undefined, room = 599, fighting = false } = {}) {
  const pacer = new Pacer(); pacer.minGapMs = 0;
  const s = Object.assign(Object.create(Session.prototype), {
    name: 'tester', client: c, pacer, world: { room: { num: room, name: 'here' } },
    combat: { active: fighting ? { pvp: {} } : null }, asked: [], tranceConfirmMs: 60, need: () => c,
  });
  c.onCastSent = info => s.noteCastSent(info);
  if (answer !== undefined || idle !== undefined)
    s._askStrategies = async (hook, ctx) => {
      s.asked.push({ hook, ctx });
      const a = hook === 'castRite' ? answer : idle;
      if (typeof a === 'function') return a(ctx);
      return a == null ? null : { strategy: 'test', answer: a };
    };
  else s._askStrategies = undefined;
  return s;
}
const castJob = (s, c, id, targets = []) => () => s.pacer.submit('cast', () => c.cast(id, targets), 0);
const waitIdle = async (s, ms = 3000) => { const end = Date.now() + ms; while ((s._rite || s.pacer.holdStatus().active) && Date.now() < end) await pause(20); };

console.log('\ncast rites and the trance door');

// ------------------------------------------------------------------ 1. silence
await t('no strategy hook at all: the cast is sent exactly once and nothing else', async () => {
  const s = fakeSession(); const c = s.client;
  const r = await withCastRite(s, { spell: c.spells[0] }, () => { c.cast(7, [5]); return 'sent'; });
  assert.equal(r, 'sent');
  assert.deepEqual(c.sent, [['cast', 7, [5]]]);
});
await t('a strategy that declines: one cast, no gear packet, no rite left behind', async () => {
  const s = fakeSession({ answer: null }); const c = s.client;
  await withCastRite(s, { spell: c.spells[0] }, castJob(s, c, 7, [5]));
  assert.deepEqual(c.sent, [['cast', 7, [5]]]);
  assert.equal(s._rite, undefined);
});
await t('a strategy that throws or answers nonsense is the same as silence', async () => {
  for (const answer of [() => { throw new Error('boom'); }, { steps: 'robe' }, { steps: [{ wear: 'robe' }] }, 42]) {
    const s = fakeSession({ answer }); const c = s.client;
    await withCastRite(s, { spell: c.spells[0] }, castJob(s, c, 7, []));
    assert.deepEqual(c.sent, [['cast', 7, []]]);
  }
});
await t('rite:false skips the question entirely', async () => {
  const s = fakeSession({ answer: { steps: [{ equip: 'robes of the disciple' }] } }); const c = s.client;
  await withCastRite(s, { spell: c.spells[0], rite: false }, castJob(s, c, 7));
  assert.deepEqual(c.sent, [['cast', 7, []]]);
  assert.equal(s.asked.length, 0);
});
await t('every wrapped cast site still sends its own cast (source check)', async () => {
  const ap = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'latin1');
  const wrapped = [...ap.matchAll(/withCastRite\(s, \{ spell, targets: (.+?), why: '\w+' \}, \(\) => s\.pacer\.submit\('cast', \(\) => c\.cast\(spell\.id, (.+?)\), 1050\)\)/g)];
  assert.ok(wrapped.length >= 12, 'twelve autopilot sites');
  for (const m of wrapped) assert.equal(m[1], m[2], 'the targets shown to the strategy are the ones sent');
  assert.match(ap, /async blinkFree[\s\S]{0,4000}?await s\.pacer\.submit\('cast', \(\) => c\.cast\(spell\.id, \[\]\), 1050\)\.catch/,
    'blink stays bare: an escape never waits on a costume change');
});

// ------------------------------------------------------------------ 2. a caller's own hold
await t('a caller hold: move dropped, its cast passes, endAutoTrance does not release it', async () => {
  const p = new Pacer(); p.minGapMs = 0; const sent = [];
  p.holdForCast(5000, 'casting enchant weapon');
  const mv = await p.submit('move', () => sent.push('move'));
  assert.equal(mv.held, true);
  await p.submit('cast', () => sent.push('cast'));
  assert.deepEqual(sent, ['cast']);
  assert.equal(p.endAutoTrance('hit'), false);
  assert.equal(p.holdStatus().active, true);
  p.releaseCastHold();
  assert.equal(p.holdStatus().active, false);
});

// ------------------------------------------------------------------ 3. the automatic trance hold
await t('the catalogue knows trances: enchant weapon 30s, hold none; GetTranceTime bounds', async () => {
  assert.equal(baseTranceMs('enchant weapon'), 30000);
  assert.equal(baseTranceMs('hold'), 0);
  assert.equal(tranceMs('enchant weapon'), 44700);                 // spellpower 1: 149%
  assert.equal(tranceMs('enchant weapon', { spellpower: 50 }), 30000);
  assert.equal(tranceMs('enchant weapon', { spellpower: 99 }), 15300);
  assert.equal(tranceMs('no such spell'), 0);
});
await t('trance sentences classify', async () => {
  assert.deepEqual(classifyTranceLine('You focus your whole will on casting enchant weapon.'), { kind: 'start', spell: 'enchant weapon' });
  assert.deepEqual(classifyTranceLine('Your concentration is broken and the identify spell fizzles.'), { kind: 'broken', spell: 'identify' });
  assert.equal(classifyTranceLine("You don't have the reagents to cast hold!").kind, 'refused');
  assert.equal(classifyTranceLine('You killed the troll.'), null);
});
await t('M59Client.cast reports every cast to the session', async () => {
  const seen = []; const fake = { send() {}, spells: [{ id: 8, name: 'enchant weapon' }], rsc: { get() {} }, noteAttackTarget() {}, emit() {},
    onCastSent: info => seen.push(info) };
  M59Client.prototype.cast.call(fake, 8, [44]);
  assert.deepEqual(seen, [{ id: 8, name: 'enchant weapon', targets: [44] }]);
});
await t('a trance cast opens an automatic hold; a no-trance cast opens none', async () => {
  const s = fakeSession();
  s.noteCastSent({ id: 7, name: 'hold' });
  assert.equal(s.pacer.holdStatus().active, false);
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  const h = s.pacer.holdStatus();
  assert.equal(h.active, true); assert.equal(h.auto, true); assert.equal(h.spell, 'enchant weapon');
  assert.ok(h.ms_left > 44000 && h.ms_left <= 45450, String(h.ms_left));
  s.pacer.releaseCastHold();
});
await t('the automatic hold never replaces a caller hold', async () => {
  const s = fakeSession();
  s.pacer.holdForCast(5000, 'casting blink');
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  assert.equal(s.pacer.holdStatus().reason, 'casting blink');
  assert.equal(s.pacer.holdStatus().auto, false);
  s.pacer.releaseCastHold();
});
await t('during an automatic trance: moves, sits and gear are dropped; a walk passes when asked', async () => {
  const s = fakeSession(); const sent = [];
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  s.noteTranceLine({ text: 'You focus your whole will on casting enchant weapon.' });
  for (const k of ['move', 'rest', 'use', 'act', 'attack', 'turn']) assert.equal((await s.pacer.submit(k, () => sent.push(k))).held, true, k);
  await s.pacer.submit('say', () => sent.push('say'));
  await s.pacer.submit('read', () => sent.push('read'));
  await s.pacer.submit('move', () => sent.push('walk'), 0, { walkInTrance: true });
  assert.deepEqual(sent, ['say', 'read', 'walk']);
  s.pacer.releaseCastHold();
  s.pacer.holdForCast(2000, 'casting enchant weapon');
  assert.equal((await s.pacer.submit('read', () => sent.push('x'))).held, true, 'a caller hold keeps its stricter list');
  s.pacer.releaseCastHold();
});
await t('a second cast WAITS OUT an automatic trance instead of breaking it', async () => {
  const s = fakeSession(); const sent = [];
  s.pacer.holdForCast(300, 'trance create food', { auto: true, spell: 'create food' });
  const t0 = Date.now();
  await s.pacer.submit('cast', () => sent.push('second'));
  assert.ok(Date.now() - t0 >= 280, 'it waited ' + (Date.now() - t0));
  assert.deepEqual(sent, ['second']);
});
await t('a cast that says breakTrance replaces the trance at once', async () => {
  const s = fakeSession(); const sent = [];
  s.pacer.holdForCast(5000, 'trance identify', { auto: true, spell: 'identify' });
  await s.pacer.submit('cast', () => sent.push('now'), 0, { breakTrance: true });
  assert.deepEqual(sent, ['now']);
  assert.equal(s.pacer.holdStatus().active, false);
  assert.match(s.pacer.holdStatus().last_end.why, /broken/);
});
await t('the hold ends on "concentration is broken", on a refusal, on a hit, and with no trance started', async () => {
  const s = fakeSession();
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  s.noteTranceLine({ text: 'You focus your whole will on casting enchant weapon.' });
  s.noteTranceLine({ text: 'Your concentration is broken and the enchant weapon spell fizzles.' });
  assert.equal(s.pacer.holdStatus().active, false);
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  s.noteTranceLine({ text: "You don't have the reagents to cast enchant weapon!" });
  assert.equal(s.pacer.holdStatus().active, false);
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  assert.equal(s.pacer.endAutoTrance('hit'), true);
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  await pause(120);
  assert.equal(s.pacer.holdStatus().active, false, 'nothing announced a trance');
  assert.equal(s.pacer.lastTranceEnd.why, 'no trance started');
  s.noteCastSent({ id: 8, name: 'enchant weapon' });
  s.noteTranceLine({ text: 'You focus your whole will on casting enchant weapon.' });
  await pause(120);
  assert.equal(s.pacer.holdStatus().active, true, 'an announced trance is held past the confirm window');
  s.pacer.releaseCastHold();
});
await t('the session ends the automatic hold on a hit and on a room change (source check)', async () => {
  const g = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  assert.match(g, /this\.damagedAt = now;\s*\n(\s*\/\/.*\n)*\s*this\.pacer\?\.endAutoTrance\?\.\('hit'\)/);
  assert.match(g, /ev\.kind === 'room-entered'\) \{\s*\n\s*this\.pacer\?\.endAutoTrance\?\.\('changed room'\)/);
  assert.match(g, /c\.onCastSent = info => this\.noteCastSent\(info\)/);
});

// ------------------------------------------------------------------ 4. walking, never running
await t('moveTo clamps to walking speed during a trance and leaves it alone otherwise', async () => {
  const run = (inTrance, speed) => {
    let got = null; const STOP = new Error('stop');
    const fake = { inTrance: () => inTrance, room: { id: 1 }, send: (...a) => { got = a; throw STOP; } };
    try { M59Client.prototype.moveTo.call(fake, 100, 200, speed, 1); } catch (e) { if (e !== STOP) throw e; }
    return got[3][0];
  };
  assert.equal(run(true, 36), 18);
  assert.equal(run(true, 12), 12);
  assert.equal(run(false, 36), 36);
  assert.equal(tranceSafeSpeed(30), 18);
});

// ------------------------------------------------------------------ 5. spellpower facts
await t('spellpower modifiers follow the kod (generated table)', async () => {
  assert.equal(itemSpellModifier('plate armor'), -30);
  assert.equal(itemSpellModifier('chain armor'), -15);
  assert.equal(itemSpellModifier('axe'), -15, 'slash -15 (weapon.kod:386)');
  assert.equal(itemSpellModifier('scimitar'), -20, 'slash, high quality -5');
  assert.equal(itemSpellModifier('long sword'), -10, 'thrust -10');
  assert.equal(itemSpellModifier('mystic sword'), -15, 'thrust, high quality');
  assert.equal(itemSpellModifier('short sword'), -5, 'thrust, low quality +5');
  assert.equal(itemSpellModifier('hammer'), 0, 'bludgeon 0');
  assert.equal(itemSpellModifier('mace'), 5, 'bludgeon, low quality: the one weapon that helps');
  assert.equal(itemSpellModifier('longbow'), -20);
  assert.equal(itemSpellModifier('battle bow'), -30);
  assert.equal(itemSpellModifier('nerudite bow'), 0);
  assert.equal(itemSpellModifier('helm'), -5);
  assert.equal(itemSpellModifier('robes'), 10);
  assert.equal(itemSpellModifier('ivy circlet', { spellSchool: 'Qor' }), -15);
  assert.equal(itemSpellModifier('ivy circlet', { spellSchool: "Shal'ille" }), 15);
  assert.equal(itemSpellModifier('orc shield', { spellSchool: 'Qor' }), 15);
  assert.equal(itemSpellModifier('torch', { spellSchool: 'Faren' }), 10);
  assert.equal(itemSpellModifier('sword of Riija', { spellSchool: 'Riija' }), 10);
  assert.equal(itemSpellModifier('sword of Riija', { spellSchool: 'Qor' }), -10);
  assert.equal(itemSpellModifier('enchanted widget'), 0);
  assert.ok(isDiscipleRobe('robes of the disciple'));
  assert.equal(itemSpellModifier('robes of the disciple', { spellSchool: 'Qor', robeSchool: 'Qor', schoolLevel: 4 }), 16);
  assert.equal(itemSpellModifier('robes of the disciple', { spellSchool: 'Qor', robeSchool: 'Qor', schoolLevel: 6 }), 20);
  assert.equal(itemSpellModifier('robes of the disciple', { spellSchool: 'Qor', robeSchool: 'Faren', schoolLevel: 6 }), 5);
  assert.equal(itemSpellModifier('robes of the disciple', { spellSchool: 'Qor' }), 5, 'unknown school is the worse case');
  assert.equal(gearSpellModifier(['plate armor', 'helm'], { spellSchool: 'Kraanan' }), -17, 'Kraanan halves a negative total');
  assert.equal(robeSchoolFromLook('x  These robes bear the insignia of Shal\'ille and will give bonuses to spells in that school.'), "Shal'ille");
});

// ------------------------------------------------------------------ 6. the rite
const QOR_RITE = ctx => {
  if (ctx.spell?.school !== 'Qor') return null;
  const robe = ctx.items.find(i => i.disciple_robe && !i.equipped);
  return robe ? { strategy: 'test', answer: { steps: [{ equip: robe.id }], restore: 'after', why: 'robe for Qor' } } : null;
};
await t('ctx shows the spell, the room and every item with its modifier for this spell', async () => {
  const s = fakeSession({ room: 52 }); s._robeSchools = new Map([[ROBE, { name: 'robes of the disciple', school: 'Qor' }]]);
  s.client.spells.push({ id: 11, name: 'enfeeble' });
  const ctx = castRiteContext(s, 'before_cast', { spell: { name: 'hold', school: 'Qor', level: 4 }, pvp: true });
  assert.equal(ctx.room.inn, true);
  assert.equal(ctx.pvp, true);
  assert.equal(ctx.items.find(i => i.id === PLATE).spell_modifier, -30);
  assert.equal(ctx.items.find(i => i.id === ROBE).robe_school, 'Qor');
  assert.equal(ctx.gear_spell_modifier, -45, 'plate -30 and axe -15');
  assert.equal(ctx.role, null);
  assert.equal(ctx.hands_locked, false);
  assert.equal(ctx.mage_plan, undefined, "no built-in plan: what to wear is a strategy's");
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.items));
});
await t('a rite dresses BEFORE the cast and restores AFTER the trance, exactly what it changed', async () => {
  const s = fakeSession({ answer: QOR_RITE }); const c = s.client;
  await withCastRite(s, { spell: c.spells[0], pvp: true }, castJob(s, c, 7, [55]));
  assert.deepEqual(c.sent.slice(0, 2), [['use', ROBE], ['cast', 7, [55]]]);
  assert.ok(c.using.has(ROBE) && !c.using.has(PLATE));
  await waitIdle(s);
  assert.deepEqual(c.sent.slice(2), [['use', PLATE]], 'one packet: plate replaces the robe by itself (armor.kod:49)');
  assert.ok(c.using.has(PLATE) && c.using.has(AXE) && !c.using.has(ROBE));
  assert.equal(riteStatus(s).active, false);
  assert.equal(riteStatus(s).last.ended, 'rite over');
});
await t('a rite never changes gear while a trance charges: the restore waits for it', async () => {
  const s = fakeSession({ answer: ctx => ({ strategy: 'test', answer: { steps: [{ equip: ROBE }] } }) }); const c = s.client;
  await withCastRite(s, { spell: c.spells[1] }, async () => { await castJob(s, c, 8)(); s.noteTranceLine({ text: 'You focus your whole will on casting enchant weapon.' }); });
  assert.equal(s.pacer.holdStatus().auto, true);
  await pause(400);
  assert.ok(c.using.has(ROBE), 'still dressed while charging');
  assert.equal(c.sent.filter(x => x[0] !== 'cast').length, 1, 'no gear packet during the trance');
  s.pacer.endAutoTrance('trance over');
  await waitIdle(s);
  assert.ok(c.using.has(PLATE) && !c.using.has(ROBE));
});
await t('no rite is asked while a trance already charges', async () => {
  const s = fakeSession({ answer: QOR_RITE }); const c = s.client;
  s.pacer.holdForCast(2000, 'trance x', { auto: true, spell: 'x' });
  await withCastRite(s, { spell: c.spells[0] }, () => 'x');
  assert.equal(s.asked.length, 0);
  s.pacer.releaseCastHold();
});
await t('linger: a second cast keeps the first snapshot, and the restore puts back the plate', async () => {
  const s = fakeSession({ answer: ctx => ({ strategy: 'test', answer: { steps: [{ equip: ROBE }, { equip: HAMMER }], restore: 'linger', linger_ms: 150 } }) });
  const c = s.client; c.using = new Set([PLATE, BOW]);
  await withCastRite(s, { spell: c.spells[0] }, castJob(s, c, 7));
  await withCastRite(s, { spell: c.spells[0] }, castJob(s, c, 7));
  assert.equal(c.sent.filter(x => x[0] === 'use').length, 2, 'the second rite found the gear already on');
  assert.equal(riteStatus(s).active, true);
  await waitIdle(s);
  assert.ok(c.using.has(PLATE) && c.using.has(BOW) && !c.using.has(ROBE) && !c.using.has(HAMMER), [...c.using].join(','));
});
await t("restore 'never' leaves the gear and the rite record cleared", async () => {
  const s = fakeSession({ answer: { steps: [{ equip: ROBE }], restore: 'never' } }); const c = s.client;
  await withCastRite(s, { spell: c.spells[0] }, castJob(s, c, 7));
  await pause(50);
  assert.ok(c.using.has(ROBE)); assert.equal(s._rite, null);
});
await t('normalizeRite takes only the closed shape', async () => {
  assert.equal(normalizeRite(null), null);
  assert.equal(normalizeRite({ steps: [{ eat: 'x' }] }), null);
  assert.equal(normalizeRite({ steps: [{ unequip: 'helm' }], restore: 'sometimes' }).restore, null, 'the decision applies the default');
  assert.equal(normalizeRite({ skip: true }).skip, true);
  assert.equal(normalizeRite({ plan: 'max_spellpower' }), null, 'no built-in planner to ask for');
  assert.deepEqual(normalizeRite({ wear: { weapon: 5, armour: null, cloak: 3 } }).wear, { weapon: 5, armour: null });
  assert.deepEqual(normalizeRite({ forbid: ['Robes Of The Disciple'] }).forbid, ['robes of the disciple']);
});

// ------------------------------------------------------------------ 7. idle gear
const IDLE = ctx => ({ strategy: 'test', answer: {
  forbid: ctx.room.inn ? [] : ['robes of the disciple'],
  steps: ctx.room.inn ? [] : ctx.equipped.filter(i => i.disciple_robe).map(i => ({ unequip: i.id })) } });
await t('idle gear outside an inn: the robe comes off and the armour slot is refilled without it', async () => {
  const s = fakeSession({ idle: IDLE, room: 599 }); const c = s.client; c.using = new Set([ROBE, AXE]);
  let refilled = null;
  await idleGearCheck(s, { force: true, refill: async (_s, opts) => { refilled = opts; } });
  assert.ok(!c.using.has(ROBE));
  assert.ok(refilled && refilled.exclude('robes of the disciple') && !refilled.exclude('plate armor'));
  assert.equal(s.gearForbidden('robes of the disciple'), true);
});
await t('idle gear in an inn leaves the robe alone', async () => {
  const s = fakeSession({ idle: IDLE, room: 52 }); const c = s.client; c.using = new Set([ROBE, AXE]);
  await idleGearCheck(s, { force: true, refill: async () => { throw new Error('should not refill'); } });
  assert.ok(c.using.has(ROBE));
  assert.equal(s.gearForbidden('robes of the disciple'), false);
});
await t('idle gear waits for a rite, a trance and a fight', async () => {
  for (const setup of [s => { s._rite = { put_on: [], took_off: [] }; }, s => s.pacer.holdForCast(1000, 'x'), s => { s.combat.active = { pvp: {} }; }]) {
    const s = fakeSession({ idle: IDLE }); s.client.using = new Set([ROBE]);
    setup(s);
    await idleGearCheck(s, { force: true, refill: async () => {} });
    assert.ok(s.client.using.has(ROBE));
    s.pacer.releaseCastHold();
  }
});
await t('idle gear learns a robe school from its look, checking the id that came back', async () => {
  const s = fakeSession({ idle: () => null }); s.client.using = new Set([PLATE]);
  await idleGearCheck(s, { force: true });
  assert.equal(s._robeSchools.get(ROBE)?.school, 'Qor');
});
await t('wearBest will not put on a forbidden robe by itself, and will without the strategy', async () => {
  const mk = () => { const c = fakeClient({ worn: [] }); c.inventory = c.inventory.filter(o => o.id === ROBE); return c; };
  const plain = fakeSession({ c: mk() });
  await wearBest(plain, { refresh: false, slots: ['armour'] });
  assert.ok(plain.client.using.has(ROBE), 'unforbidden: the old behaviour wears it');
  const s = fakeSession({ c: mk() }); s.gearForbidden = n => /robes of the disciple/.test(n);
  await wearBest(s, { refresh: false, slots: ['armour'] });
  assert.ok(!s.client.using.has(ROBE));
});

// ------------------------------------------------------------------ 8. the loader
await t('the loader accepts a casting strategy that answers only castRite/idleGear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm59-castrite-'));
  try {
    writeFileSync(join(dir, 'gear.mjs'), "export default { name: 'gear', kind: 'casting', enabled: true, async castRite() { return null; }, async idleGear() { return null; } };");
    const loaded = await load({ dir });
    assert.equal(loaded.problems.length, 0, JSON.stringify(loaded.problems));
    assert.deepEqual(loaded.strategies[0].hooks, ['castRite', 'idleGear']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
