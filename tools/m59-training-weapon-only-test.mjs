// Offline guard for TRAINING WEAPON ONLY (policy.trainingWeaponOnly, Autopilot.trainingWeaponOnlyNow,
// equipBest's `s.equipOnly`). Opens no socket.
//
//   node tools/m59-training-weapon-only-test.mjs
//
// Operator, 2026-10-11: "we want lupoggs hunted with axes for the damage type slash". Janice held a hammer
// at 70 and an axe at 39 under short_sword + axe + priority [axe] and was re-armed with the hammer within
// forty seconds. Pinned: the restriction is opt-in and silent otherwise; with it, equipBest chooses only
// the training weapon whatever else outranks it, refuses rather than reaching for another weapon when
// none is in the pack, and a hook that throws restricts nothing. The strategy declares it and nulls the
// touch spell that empties the hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { equipBest } from './m59-skills.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

const keeper = policy => { const ap = Object.create(Autopilot.prototype); ap.policy = policy; return ap; };

// A pack, a use list that the fake server updates, and a session whose hook we control.
function session(names, only) {
  const c = {
    inventory: names.map((nm, i) => ({ id: i + 1, nameRsc: 1000 + i, flags: 0, rarity: 0 })),
    rsc: { get: r => names[r - 1000] ?? '' }, using: new Set(), statsById: new Map(), evSeq: 0,
  };
  const sent = [];
  c.use = id => { sent.push(id); c.using = new Set([id]); c.evSeq++; };
  c.waitFor = async () => ({ events: [{ kind: 'equipment' }] });
  const s = { need: () => c, client: c, pacer: { submit: async (k, f) => f() }, equipOnly: only };
  return { s, c, sent };
}

await ok('off unless asked: no flag, a non-armed style, or no weapon named -> no restriction', () => {
  assert.equal(keeper({ trainingStyle: 'short_sword', trainingWeapon: 'axe' }).trainingWeaponOnlyNow(), null);
  assert.equal(keeper({ trainingWeaponOnly: true, trainingStyle: 'normal', trainingWeapon: 'axe' }).trainingWeaponOnlyNow(), null);
  assert.equal(keeper({ trainingWeaponOnly: true, trainingStyle: 'unarmed', trainingWeapon: 'axe' }).trainingWeaponOnlyNow(), null);
  assert.equal(keeper({ trainingWeaponOnly: true, trainingStyle: 'short_sword', trainingWeapon: '' }).trainingWeaponOnlyNow(), null);
  assert.deepEqual(keeper({ trainingWeaponOnly: true, trainingStyle: 'short_sword', trainingWeapon: 'Axe' }).trainingWeaponOnlyNow(), ['axe']);
});

await ok('the keeper installs the hook on its session, beside the touch veto', () => {
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('if (session) session.equipOnly = () => this.trainingWeaponOnlyNow();'));
});

await ok('Janice\'s pack: hammer 70 outranks axe 39 by skill -- with the hook, the axe is wielded', async () => {
  const { s, c, sent } = session(['hammer', 'long sword', 'axe'], () => ['axe']);
  const r = await equipBest(s, { refresh: false, maxTries: 1 });
  assert.equal(r.wielding, 'axe', JSON.stringify(r));
  assert.deepEqual(sent, [3]);
  assert.ok(c.using.has(3));
});

await ok('without the hook the old ranking stands (silence is the old behaviour)', async () => {
  const { s } = session(['hammer', 'axe'], undefined);
  const r = await equipBest(s, { priority: ['axe'], refresh: false, maxTries: 1 });
  assert.equal(r.wielding, 'axe', 'a priority alone already prefers the axe when nothing filters it');
});

await ok('no axe in the pack: refuses and sends nothing, rather than reaching for the hammer', async () => {
  const { s, sent } = session(['hammer', 'long sword'], () => ['axe']);
  const r = await equipBest(s, { refresh: false });
  assert.equal(r.wielding, null);
  assert.equal(r.refused, true);
  assert.deepEqual(r.only, ['axe']);
  assert.deepEqual(sent, []);
  assert.match(r.note, /training_weapon_only/);
});

await ok('whole words: "axe" is not "battleaxe"-by-accident, and a hook that throws restricts nothing', async () => {
  {
    const { s } = session(['hammer', 'axe'], () => ['axe']);
    assert.equal((await equipBest(s, { refresh: false })).wielding, 'axe');
  }
  {
    const { s } = session(['hammer'], () => { throw new Error('boom'); });
    assert.equal((await equipBest(s, { refresh: false })).wielding, 'hammer');
  }
});

await ok('the strategy field and the broker argument exist, and a strategy may set it', async () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'weapons.trainingWeaponOnly');
  assert.equal(f?.arg, 'training_weapon_only');
  assert.deepEqual(f.keys, ['trainingWeaponOnly']);
  const v = validateStrategy({ name: 'axe-only', weapons: { style: 'short_sword', trainingWeapon: 'axe', trainingWeaponOnly: true } },
    { file: 'axe-only.mjs' });
  assert.ok(v.ok !== false && !(v.problems?.length), JSON.stringify(v).slice(0, 300));
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(broker.includes('p.policy.trainingWeaponOnly = a.training_weapon_only === true;'));
});

console.log(`\n${n} passed`);
