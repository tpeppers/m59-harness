#!/usr/bin/env node
// THE COSTUME-CHANGE FRAMEWORK: the mechanics, the tags, and the extension points -- and that none of it
// does anything until a strategy says so.
//
//   node tools/m59-spellgear-test.mjs
//
// Offline: the generated item table (substrate/m59-spellmods.json), fakes of a client and a session,
// the real Pacer, Session prototype, castrite engine and m59-skills weaponRanking/equipBest/wearBest.
// A throwaway roles file; never this machine's substrate/cast-roles.json. What a "mage" WEARS is
// policy and lives in a private strategy; its tests live beside it.
//
// WHAT IT PINS
//   - a role tag on its own changes nothing: no strategy, no costume;
//   - a strategy's `wear` target becomes the fewest legal packets (a use replaces the incumbent, a bow's
//     two hands are freed explicitly, an empty target is an unuse), and an illegal target is refused;
//   - the stash is popped by the same transition, after the trance and the linger;
//   - the keeper's own equipBest/wearBest stand down while a rite is open; a failed cast still pops;
//   - rite packets jump the queue ahead of movement;
//   - ctx says when the keeper owns the hands (touch training, the roulette);
//   - `prefer_weapons` from idleGear ranks first in weaponRanking, after the magic-first rule; none
//     ranks as before.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gearCandidates, transitionSteps, legalHands, wornState, castRole, castRoles, setRole, setRolesFile }
  from './m59-spellgear.mjs';
import { withCastRite, riteStatus, castRiteContext, idleGearCheck } from './m59-castrite.mjs';
import { Pacer, Session } from './m59-game.mjs';
import { weaponRanking, equipBest, wearBest } from './m59-skills.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.stack ?? e).toString().split('\n').slice(0, 4).join('\n       ')); }
};
const pause = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'm59-spellgear-'));
setRolesFile(join(dir, 'cast-roles.json'));

let nextId = 1;
const it = (name, o = {}) => ({ id: nextId++, name, equipped: false, rarity: 0, ...o });
const nm = (items, steps) => steps.map(st => st.equip != null ? 'use ' + items.find(i => i.id === st.equip).name : 'unuse ' + items.find(i => i.id === st.unequip).name);

console.log('\nspell gear — the costume-change framework');

// ------------------------------------------------------------------ mechanics
await t('a one-handed swap is one packet; body and head replace their incumbents', async () => {
  const items = [it('axe', { equipped: true }), it('mace'), it('plate armor', { equipped: true }), it('robes'), it('helm', { equipped: true })];
  const c = gearCandidates(items), of = n => c.find(g => g.name === n);
  const steps = transitionSteps(wornState(c), { weapon: of('mace'), shield: null, armour: of('robes'), helm: null });
  assert.deepEqual(nm(items, steps), ['unuse helm', 'use mace', 'use robes']);
});
await t('a bow is freed explicitly, both ways', async () => {
  const items = [it('longbow', { equipped: true }), it('mace'), it('chain armor', { equipped: true })];
  const c = gearCandidates(items), of = n => c.find(g => g.name === n);
  assert.deepEqual(nm(items, transitionSteps(wornState(c), { weapon: of('mace'), shield: null, armour: of('chain armor'), helm: null })),
    ['unuse longbow', 'use mace']);
  assert.deepEqual(nm(items, transitionSteps({ weapon: of('mace'), shield: null, armour: null, helm: null },
                                             { weapon: of('longbow'), shield: null, armour: of('chain armor'), helm: null })),
    ['unuse mace', 'use longbow', 'use chain armor']);
});
await t('legal hands: a bow and an ordinary shield never; a bow and a soldier\'s shield yes', async () => {
  const c = gearCandidates([it('bow'), it("knight's shield"), it("soldier's shield"), it('hammer')]);
  const of = n => c.find(g => g.name === n);
  assert.equal(legalHands(of('bow'), of("knight's shield")), false);
  assert.equal(legalHands(of('bow'), of("soldier's shield")), true);
  assert.equal(legalHands(of('hammer'), of("knight's shield")), true);
});
await t('roles: any short word, read back, untagged; nonsense refused; no file is nobody', async () => {
  assert.deepEqual(castRoles(), {});
  setRole('t5', 'mage'); setRole('t6', 'healer');
  assert.equal(castRole('t5'), 'mage'); assert.equal(castRole('t6'), 'healer'); assert.equal(castRole('t1'), null);
  assert.throws(() => setRole('t7', 'Not A Word!'));
  setRole('t5', null); setRole('t6', null);
  assert.equal(castRole('t5'), null);
});

// ------------------------------------------------------------------ the engine, end to end
const ROBE = 901, PLATE = 902, AXE = 903, MACE = 904, BOW = 905, CHAIN = 906, SHIELD = 907;
function fake({ worn = [PLATE, AXE], answer = undefined } = {}) {
  const names = { [ROBE]: 'robes of the disciple', [PLATE]: 'plate armor', [AXE]: 'axe', [MACE]: 'mace', [BOW]: 'longbow', [CHAIN]: 'chain armor', [SHIELD]: "knight's shield" };
  const slot = { [ROBE]: 'a', [PLATE]: 'a', [CHAIN]: 'a', [AXE]: 'w', [MACE]: 'w', [BOW]: 'w', [SHIELD]: 's' };
  const c = {
    sent: [], evSeq: 0, selfId: 1, inventory: Object.keys(names).map(id => ({ id: Number(id), nameRsc: Number(id), rarity: 0 })),
    using: new Set(worn), spells: [{ id: 7, name: 'hold' }, { id: 8, name: 'bless' }], rsc: { get: id => names[id] },
    use(id) { this.sent.push('use ' + names[id]); for (const x of [...this.using]) if (slot[x] === slot[id]) this.using.delete(x); this.using.add(id); this.evSeq++; },
    unuse(id) { this.sent.push('unuse ' + names[id]); this.using.delete(id); this.evSeq++; },
    cast(id) { this.sent.push('cast ' + id); this.onCastSent?.({ id, name: id === 7 ? 'hold' : 'bless' }); },
    async waitFor() { return { events: [{ kind: 'equipment' }] }; }, look() {},
  };
  const p = new Pacer(); p.minGapMs = 0;
  const s = Object.assign(Object.create(Session.prototype), { name: 'caster1', client: c, pacer: p, need: () => c,
    world: { room: { num: 599 } }, combat: { active: null }, tranceConfirmMs: 60 });
  // NEVER the real loader: Session.prototype._askStrategies reads this machine's substrate/strategies/.
  s._askStrategies = answer === undefined ? undefined
    : async (hook, ctx) => { const a = typeof answer === 'function' ? answer(ctx, hook) : answer; return a ? { strategy: 'test', answer: a } : null; };
  c.onCastSent = info => s.noteCastSent(info);
  return { s, c };
}
const castHold = (s, c) => withCastRite(s, { spell: c.spells[0], pvp: true }, () => s.pacer.submit('cast', () => c.cast(7), 0));
const idle = async (s) => { const end = Date.now() + 3000; while (s._rite && Date.now() < end) await pause(20); };

await t('a role tag ALONE does nothing: tagged, no strategy, exactly the old cast', async () => {
  setRole('caster1', 'mage');
  let { s, c } = fake();
  await castHold(s, c);
  assert.deepEqual(c.sent, ['cast 7']);
  ({ s, c } = fake({ answer: null }));
  await castHold(s, c);
  assert.deepEqual(c.sent, ['cast 7'], 'a strategy that declines: still the old cast');
});
await t('the role tag reaches the strategy in ctx.role', async () => {
  let seen = null;
  const { s, c } = fake({ answer: ctx => { seen = ctx.role; return null; } });
  await castHold(s, c);
  assert.equal(seen, 'mage');
});
await t('a `wear` target: fewest legal packets in, cast, popped by the same rules', async () => {
  const { s, c } = fake({ answer: { wear: { weapon: MACE, armour: ROBE }, restore: 'linger', linger_ms: 100 } });
  await castHold(s, c);
  assert.deepEqual(c.sent, ['use mace', 'use robes of the disciple', 'cast 7']);
  assert.equal(riteStatus(s).active, true);
  await idle(s);
  assert.deepEqual(c.sent.slice(3), ['use axe', 'use plate armor']);
});
await t('a `wear` target with an empty hand and a bow stash: unuse, cast, then the bow back', async () => {
  const { s, c } = fake({ worn: [CHAIN, BOW], answer: { wear: { weapon: null, armour: ROBE } } });
  await withCastRite(s, { spell: c.spells[1] }, () => s.pacer.submit('cast', () => c.cast(8), 0));
  assert.deepEqual(c.sent.slice(0, 3), ['unuse longbow', 'use robes of the disciple', 'cast 8']);
  await idle(s);
  assert.deepEqual(c.sent.slice(3), ['use longbow', 'use chain armor']);
});
await t('an illegal `wear` is refused whole: a bow beside an ordinary shield, an item in the wrong slot', async () => {
  for (const wear of [{ weapon: BOW, shield: SHIELD }, { weapon: ROBE }, { armour: 424242 }]) {
    const { s, c } = fake({ worn: [AXE], answer: { wear } });
    await castHold(s, c);
    assert.deepEqual(c.sent, ['cast 7'], JSON.stringify(wear));
  }
});
await t('a chain of casts inside the linger is dressed for once and popped once', async () => {
  const { s, c } = fake({ answer: { wear: { weapon: MACE, armour: ROBE }, restore: 'linger', linger_ms: 250 } });
  await castHold(s, c); await castHold(s, c); await castHold(s, c);
  assert.equal(c.sent.filter(x => /^(un)?use/.test(x)).length, 2);
  await idle(s);
  assert.deepEqual(c.sent.slice(-2), ['use axe', 'use plate armor']);
});
await t('skip: the strategy says cast as-is', async () => {
  const { s, c } = fake({ answer: { skip: true } });
  await castHold(s, c);
  assert.deepEqual(c.sent, ['cast 7']);
});
await t('equipBest and wearBest stand down while a rite is open', async () => {
  const { s, c } = fake({ answer: { wear: { weapon: MACE }, restore: 'linger', linger_ms: 300 } });
  await castHold(s, c);
  assert.equal((await equipBest(s, { refresh: false })).vetoed, true);
  assert.equal((await wearBest(s, { refresh: false })).deferred, true);
  await idle(s);
});
await t('a failed cast still pops the stash', async () => {
  const { s, c } = fake({ answer: { wear: { weapon: MACE, armour: ROBE } } });
  await assert.rejects(withCastRite(s, { spell: c.spells[0] }, async () => { throw new Error('refused'); }));
  await idle(s);
  assert.deepEqual([...c.using].sort(), [PLATE, AXE].sort());
});
await t('ctx says when the keeper owns the hands (touch training, the roulette)', async () => {
  const { s } = fake();
  assert.equal(castRiteContext(s, 'before_cast', {}).hands_locked, false);
  s.equipVeto = () => 'touch training';
  assert.equal(castRiteContext(s, 'before_cast', {}).hands_locked, true);
  s.equipVeto = null; s.equipOnly = () => 'axe';
  assert.equal(castRiteContext(s, 'before_cast', {}).hands_locked, true);
});
await t('rite packets jump the queue ahead of movement', async () => {
  const p = new Pacer(); const order = [];
  const moves = [1, 2, 3].map(i => p.submit('move', () => order.push('move' + i)));
  const use = p.submit('use', () => order.push('use'), 0, { urgent: true });
  await Promise.all([...moves, use]);
  assert.ok(order.indexOf('use') <= 1, order.join(','));
});

// ------------------------------------------------------------------ the weapon-preference extension point
await t('prefer_weapons: none ranks as before; a list ranks first; magic-first still wins', async () => {
  const names = { 1: 'long sword', 2: 'mace', 3: 'hammer' };
  const c = { inventory: [1, 2, 3].map(id => ({ id, nameRsc: id, rarity: 0 })), rsc: { get: id => names[id] }, stats: new Map(), abilities: [] };
  const top = () => c.rsc.get(weaponRanking(c, { priority: ['long sword', 'hammer'] })[0].o.nameRsc);
  assert.equal(top(), 'long sword', 'no preference: the priority');
  c._preferWeapons = ['mace', 'hammer'];
  assert.equal(top(), 'mace');
  c._magicWeaponIds = new Set([1]);
  assert.equal(top(), 'long sword', 'an enchanted long sword still beats a mundane mace');
});
await t('idleGear prefer_weapons reaches the client, and silence clears it', async () => {
  let say = { prefer_weapons: ['Mace'] };
  const { s, c } = fake({ answer: (ctx, hook) => (hook === 'idleGear' ? say : null) });
  await idleGearCheck(s, { force: true });
  assert.deepEqual(c._preferWeapons, ['mace']);
  say = null;
  await idleGearCheck(s, { force: true });
  assert.equal(c._preferWeapons, null);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
