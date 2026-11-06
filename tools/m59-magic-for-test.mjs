#!/usr/bin/env node
// Offline guard for MAGIC FOR (policy.magicWeaponFor, strategy weapons.magicFor, broker magic_weapon_for):
// the weapon READ as magic against a listed quarry, a mundane one of any family against everything else.
// Opens no socket, joins nobody, writes nothing (the weapon-magic book dir is pointed at a path that
// does not exist, and nothing here saves).
//
//   node tools/m59-magic-for-test.mjs
//
// Operator, 2026-11-06, of the Great Ocean mollusk hunters: "have them kill the slimes with other
// weapons (non-dedicated)" ... "Slimes or fungus, whatever else is on that map".
//
// Pinned, through the REAL equipBest and the keeper's real syncMagicSet / magicForMode hook:
//   - mollusk -> the dedicated axe is wielded; slime -> a mundane weapon, across families
//   - no mundane carried -> the magic one stays in hand (no use sent); an UNREAD weapon is not "mundane"
//   - no magic carried vs a mollusk -> the mundane one stays in hand
//   - key absent -> the ranking and the hook are exactly today's (global switches decide)
//   - one change per 10 s, the held change noted; between-fights equips keep the last decision
//   - the timed applyMagicPreference swap stands aside once a per-quarry decision exists
//   - schema + broker accept/refuse the value
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.M59_WEAPON_MAGIC_DIR = join(tmpdir(), `m59-magic-for-test-nonexistent-${process.pid}`);
const { normalizeMagicFor, magicForWant, decideMagicFor, MAGIC_FOR_GAP_MS } = await import('./m59-magic-for.mjs');
const { weaponRanking, equipBest } = await import('./m59-skills.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { validateStrategy } = await import('./m59-strategy-schema.mjs');
const { readToolSource } = await import('./autopilot/source.mjs');

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

const ENCH = "A sturdy axe. This weapon has been dedicated to Kraanan's glory.";
const PLAIN = 'A sturdy weapon.';

// A fake world: pack rows by id, a use list, a `use` that replaces the weapon in hand.
function world(pack, { wielding = null } = {}) {
  const names = new Map(pack.map(p => [p.id, p.name]));
  const c = {
    evSeq: 0, using: new Set(wielding != null ? [wielding] : []),
    inventory: pack.map(p => ({ id: p.id, nameRsc: 1000 + p.id, flags: 0, ...(p.rarity != null ? { rarity: p.rarity } : {}) })),
    rsc: { get: r => names.get(r - 1000) ?? '' },
    equipment() { return { known: true, equipped: [...this.using].map(id => ({ id, name: names.get(id) })) }; },
    use(id) { this.using = new Set([id]); this.evSeq += 1; },
    async waitFor() { return { events: [{ kind: 'equipment' }] }; },
    async requestInventory() {},
  };
  return c;
}

function keeper(c, policy, pack) {
  const notes = [];
  const rig = { policy, s: { client: c }, note: (k, d) => notes.push({ k, d }), notes };
  for (const m of ['weaponMagicBook', 'packWeapons', 'wieldedWeaponId', 'syncMagicSet', 'magicForMode',
                   'applyMagicPreference', 'weaponMagicStatus', 'noteSwapOutcome', 'huntsTrolls'])
    rig[m] = Autopilot.prototype[m].bind(rig);
  for (const p of pack) if (p.look) rig.weaponMagicBook().record(p.id, p.name, p.look);
  const sent = [];
  // The same hook the Autopilot constructor installs.
  const s = { need: () => c, beforeEquip: (cl, ctx = {}) => rig.syncMagicSet(cl, null, { quarry: ctx?.quarry ?? null }),
              pacer: { submit: async (k, f) => { sent.push(k); return f(); } } };
  rig.s = { ...rig.s, ...s, client: c };
  return { rig, s, sent, notes };
}
const fightEquip = (k, quarry, priority = ['axe']) =>
  equipBest(k.s, { priority, refresh: false, maxTries: 2, quarry });

const AXE_MAGIC = { id: 1, name: 'axe', look: ENCH };
const HAMMER = { id: 2, name: 'hammer', look: PLAIN };
const AXE_PLAIN = { id: 3, name: 'axe', look: PLAIN };
const FOR = { magicWeaponFor: ['mollusk creature'] };

// ------------------------------------------------------------------ the pure decision
await ok('normalize: lower-case, de-duplicated; [] and null are silence; junk refused', () => {
  assert.deepEqual(normalizeMagicFor(['Mollusk Creature', 'mollusk creature ']), ['mollusk creature']);
  assert.equal(normalizeMagicFor([]), null);
  assert.equal(normalizeMagicFor(null), null);
  assert.throws(() => normalizeMagicFor('mollusk'));
  assert.throws(() => normalizeMagicFor(['']));
});
await ok('want: substring, case-insensitive; no quarry or no list is null', () => {
  assert.equal(magicForWant(['mollusk'], 'a Mollusk Creature'), 'magic');
  assert.equal(magicForWant(['mollusk'], 'slime'), 'mundane');
  assert.equal(magicForWant(['mollusk'], null), null);
  assert.equal(magicForWant(null, 'slime'), null);
});
await ok('decide: first decision free, a flip inside 10 s held, after it allowed', () => {
  let d = decideMagicFor(null, { list: ['mollusk'], quarry: 'mollusk creature', now: 1000 });
  assert.ok(d.changed && d.mode === 'magic');
  const d2 = decideMagicFor(d.state, { list: ['mollusk'], quarry: 'slime', now: 1000 + MAGIC_FOR_GAP_MS - 1 });
  assert.ok(d2.held && !d2.changed && d2.mode === 'magic' && d2.want === 'mundane');
  const d3 = decideMagicFor(d.state, { list: ['mollusk'], quarry: 'slime', now: 1000 + MAGIC_FOR_GAP_MS });
  assert.ok(d3.changed && d3.mode === 'mundane');
  const d4 = decideMagicFor(d3.state, { list: ['mollusk'], quarry: null, now: 999999 });
  assert.ok(!d4.changed && !d4.held && d4.mode === 'mundane', 'no quarry keeps the last decision');
  assert.equal(decideMagicFor(d3.state, { list: null, quarry: 'slime' }).mode, null);
});

// ------------------------------------------------------------------ through equipBest
await ok('mollusk -> the dedicated axe is wielded (from a hammer in hand)', async () => {
  const pack = [AXE_MAGIC, HAMMER];
  const c = world(pack, { wielding: 2 });
  const k = keeper(c, { ...FOR }, pack);
  const r = await fightEquip(k, 'mollusk creature', ['hammer', 'axe']);
  assert.equal(r.id, 1, 'magic beats the family priority for a listed quarry');
  assert.ok(c.using.has(1) && k.sent.includes('use'));
  assert.ok(k.notes.some(x => x.k === 'MAGIC FOR' && x.d.want === 'magic'));
});
await ok('slime -> a mundane weapon of ANOTHER family (hammer beside the dedicated axe)', async () => {
  const pack = [AXE_MAGIC, HAMMER];
  const c = world(pack, { wielding: 1 });
  const k = keeper(c, { ...FOR, preferMagicWeapon: true }, pack);
  const r = await fightEquip(k, 'slime');
  assert.equal(r.id, 2, 'mundane beats the axe priority and the global preferMagic once decided');
  assert.ok(c.using.has(2));
  assert.equal(c._magicFor, 'mundane');
});
await ok('fungus beast -> a mundane same-family twin is preferred over another family', async () => {
  const pack = [AXE_MAGIC, HAMMER, AXE_PLAIN];
  const c = world(pack, { wielding: 1 });
  const k = keeper(c, { ...FOR }, pack);
  const r = await fightEquip(k, 'fungus beast');
  assert.equal(r.id, 3);
});
await ok('no mundane carried -> keeps the magic axe, sends no use; an UNREAD hammer is not the mundane kind', async () => {
  const pack = [AXE_MAGIC, { id: 4, name: 'hammer', rarity: 100 }];
  const c = world(pack, { wielding: 1 });
  const k = keeper(c, { ...FOR }, pack);
  const r = await fightEquip(k, 'slime', ['axe', 'hammer']);
  assert.equal(r.id, 1);
  assert.equal(r.already_wielded, true);
  assert.ok(!k.sent.includes('use'));
});
await ok('no magic carried vs a mollusk -> keeps the mundane weapon in hand', async () => {
  const pack = [HAMMER, AXE_PLAIN];
  const c = world(pack, { wielding: 2 });
  const k = keeper(c, { ...FOR }, pack);
  const r = await fightEquip(k, 'mollusk creature', ['hammer', 'axe']);
  assert.equal(r.id, 2);
  assert.ok(!k.sent.includes('use'));
});
await ok('nothing at all -> never unarms: the hand stays as it is', async () => {
  const pack = [AXE_MAGIC];
  const c = world(pack, { wielding: 1 });
  const k = keeper(c, { ...FOR }, pack);
  const r = await fightEquip(k, 'slime');
  assert.equal(r.id, 1);
  assert.ok(c.using.has(1));
});

// ------------------------------------------------------------------ silence
await ok('key absent -> no per-quarry flag, and the ranking is exactly the global switches', async () => {
  for (const policy of [{}, { preferMagicWeapon: true }, { preferMundaneWeapon: true }, { magicWeaponFor: null }, { magicWeaponFor: [] }]) {
    const pack = [AXE_MAGIC, HAMMER, AXE_PLAIN];
    const c = world(pack, { wielding: 2 });
    const k = keeper(c, policy, pack);
    k.rig.syncMagicSet(c, null, { quarry: 'slime' });
    assert.equal(c._magicFor, null);
    const got = weaponRanking(c, { priority: ['axe'] }).map(r => r.o.id).join();
    // Baseline: the same client flags without the new key at all.
    const base = world(pack);
    base._magicWeaponIds = c._magicWeaponIds; base._preferMundane = c._preferMundane;
    assert.equal(got, weaponRanking(base, { priority: ['axe'] }).map(r => r.o.id).join(), JSON.stringify(policy));
    assert.equal(k.notes.length, 0);
  }
  // and with preferMagic alone a slime still gets the magic axe, as today
  const pack = [AXE_MAGIC, HAMMER];
  const c = world(pack, { wielding: 2 });
  const k = keeper(c, { preferMagicWeapon: true }, pack);
  assert.equal((await fightEquip(k, 'slime')).id, 1);
});

// ------------------------------------------------------------------ rate limit
await ok('alternating quarries do not thrash: the second flip inside 10 s is held and noted once', async () => {
  const pack = [AXE_MAGIC, HAMMER];
  const c = world(pack, { wielding: 2 });
  const k = keeper(c, { ...FOR }, pack);
  assert.equal((await fightEquip(k, 'mollusk creature')).id, 1);
  const uses = () => k.sent.filter(x => x === 'use').length;
  const u0 = uses();
  assert.equal((await fightEquip(k, 'slime')).id, 1, 'held: the magic axe stays');
  assert.equal((await fightEquip(k, 'frogman')).id, 1);
  assert.equal(uses(), u0, 'no use sent while held');
  assert.equal(k.notes.filter(x => x.k === 'MAGIC FOR HELD').length, 1);
  assert.equal(k.rig.weaponMagicStatus().magic_for_held, 1);
  // a between-fights equip (no quarry) keeps the decision too
  assert.equal((await equipBest(k.s, { priority: ['axe'], refresh: false })).id, 1);
  k.rig._magicForState.at -= MAGIC_FOR_GAP_MS;          // ten seconds pass
  assert.equal((await fightEquip(k, 'slime')).id, 2);
  assert.equal(uses(), u0 + 1);
  assert.equal(k.rig.weaponMagicStatus().magic_for_mode.mode, 'mundane');
});

await ok('the timed preferMagic swap stands aside once a per-quarry decision exists', async () => {
  const pack = [AXE_MAGIC, AXE_PLAIN];
  const c = world(pack, { wielding: 3 });
  const k = keeper(c, { ...FOR, preferMagicWeapon: true }, pack);
  await fightEquip(k, 'slime');                          // decided mundane; plain axe in hand
  k.rig._magicSwapDue = true;
  const r = await k.rig.applyMagicPreference(c);
  assert.equal(r, null);
  assert.ok(c.using.has(3));
});

// ------------------------------------------------------------------ schema, broker, wiring
await ok('schema: weapons.magicFor maps to magicWeaponFor (work faculty), junk refused, unknown no longer', () => {
  const v = validateStrategy({ name: 'x', hunt: ['mollusk creature'],
    weapons: { priority: ['axe'], preferMagic: true, magicFor: ['Mollusk Creature'] } }, { file: 'x.mjs' });
  assert.ok(v.ok, v.why);
  assert.deepEqual(v.strategy.desired.magicWeaponFor, ['mollusk creature']);
  assert.equal(v.strategy.faculties.magicWeaponFor, 'work');
  assert.ok(!v.unrecognised.includes('weapons.magicFor'));
  assert.equal(validateStrategy({ name: 'x', weapons: { magicFor: 'mollusk' } }, { file: 'x.mjs' }).ok, false);
  assert.equal(validateStrategy({ name: 'x', weapons: { magicFor: [] } }, { file: 'x.mjs' }).strategy.desired.magicWeaponFor, null);
});
await ok('wiring: broker arg, policy default, fight names its quarry, hook forwards it', () => {
  const broker = readToolSource(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(broker.includes("magic_weapon_for: { type: 'array', items: { type: 'string' }"));
  assert.ok(broker.includes("p.policy.magicWeaponFor = normalizeMagicFor(a.magic_weapon_for, 'magic_weapon_for');"));
  const ap = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  assert.ok(ap.includes('magicWeaponFor: null,'));
  assert.ok(ap.includes('session.beforeEquip = (c, ctx = {}) => this.syncMagicSet(c, null, { quarry: ctx?.quarry ?? null });'));
  const sk = readToolSource(new URL('./m59-skills.mjs', import.meta.url), 'utf8');
  assert.equal(sk.split('banned: bannedWeapons, quarry: foeName').length - 1, 2, 'fight entry and the re-arm both name the quarry');
  assert.ok(sk.includes('s.beforeEquip?.(c, { quarry });'));
});

console.log(`\n${n} passed`);
