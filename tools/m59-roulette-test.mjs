// OFFLINE. The training-weapon roulette (Autopilot.trainingWeaponRoulette) and the chest
// draw that puts a whole stack's surplus back. `node tools/m59-roulette-test.mjs`.
//
// Pins, for the operator's order of 2026-09-25 ("everyone under 50% hammer trains hammers to
// 70, conjuring at the wall"): the roulette is off for normal/unarmed styles, for a skill at or
// over 70 and for an unread skill; a miss drops ONLY the summon it just made, never the real
// long swords already in the pack; a hit is wielded even though a summon reads unidentified;
// and an unidentified hammer that is NOT our summon is never wielded, because a cursed weapon
// can never be put down.
import { Autopilot, conjurePowerEstimate } from './m59-autopilot.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

function rig({ pack = [], ability = 13, style = 'short_sword', weapon = 'hammer', rolls = [],
               mana = 25, using = [] } = {}) {
  let nextId = 1000, lastLook = null;
  const casts = [], drops = [], uses = [];
  const c = {
    inventory: pack.map((p, i) => ({ id: i + 1, nameRsc: p.name, amount: 1, rarity: p.rarity ?? 0 })),
    rsc: { get: x => x },
    using: new Set(using),
    evSeq: 0,
    abilityOf: n => (n === 'hammer wielding' || n === 'axe wielding' || n === 'fencing') ? ability : null,
    vitals: () => ({ vigor: { value: 200 }, mana: { value: mana }, health: { value: 50, max: 50 } }),
    spells: [{ id: 77, nameRsc: 'create weapon' }],
    room: { objects: new Map([[1, {}], [2, {}]]) },
    equipment() { return { known: true, equipped: [...this.using].map(id => ({ id })) }; },
    cast(id) { casts.push(id); const name = rolls.shift(); if (name) this.inventory.push({ id: nextId++, nameRsc: name, amount: 1, rarity: 100 }); },
    use(id) { uses.push(id); this.using = new Set([id]); },
    drop(items) { for (const it of items) { const id = typeof it === 'object' ? it.id : it; drops.push(id); this.inventory = this.inventory.filter(o => o.id !== id); } },
    look(id) { lastLook = id; },
    stand() {}, requestInventory() {}, requestSpells() {},
    async waitFor() { return { events: lastLook ? [{ kind: 'look', id: lastLook, description: 'It shimmers insubstantially.' }] : [] }; },
  };
  const s = { client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() }, movementGeneration: 0 };
  const ap = Object.create(Autopilot.prototype);
  ap.s = s;
  ap.policy = { trainingStyle: style, trainingWeapon: weapon, bannedWeapons: ['mace'] };
  ap.tally = {}; ap.notes = [];
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.recordCast = () => {};
  return { ap, c, casts, drops, uses };
}

// ------------------------------------------------------------------ when it does nothing
{
  const r = rig({ style: 'normal', pack: [{ name: 'long sword' }] });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'normal style: no roulette');
}
{
  const r = rig({ style: 'unarmed' });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'unarmed style: no roulette');
}
{
  const r = rig({ ability: 70 });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'hammer at 70: done, no cast');
}
{
  const r = rig({ ability: null });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'unread skill is not permission');
}
{
  const r = rig({ mana: 10 });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'under 15 mana: no cast');
}
{
  const r = rig({ weapon: 'gold sword' });
  ok(await r.ap.trainingWeaponRoulette() === null && r.casts.length === 0, 'a weapon the spell cannot make: no cast');
}

// ------------------------------------------------------------------ a miss
{
  const r = rig({ pack: [{ name: 'long sword' }, { name: 'long sword' }], rolls: ['axe'] });
  const out = await r.ap.trainingWeaponRoulette();
  ok(out === null && r.casts.length === 1, 'a miss casts once and returns');
  ok(r.drops.length === 1 && r.drops[0] >= 1000, 'the miss (our axe) is dropped');
  ok(r.c.inventory.filter(o => o.nameRsc === 'long sword').length === 2, 'the real long swords stay');
}

// ------------------------------------------------------------------ a hit
{
  const r = rig({ pack: [{ name: 'long sword' }], rolls: ['hammer'] });
  const out = await r.ap.trainingWeaponRoulette();
  const hammer = r.c.inventory.find(o => o.nameRsc === 'hammer');
  ok(out?.armed === true, 'a hit arms the character');
  ok(hammer && r.c.using.has(hammer.id), 'with the summoned hammer, although it reads unidentified');
  ok(r.drops.length === 0, 'and nothing is dropped');
  const again = await r.ap.trainingWeaponRoulette();
  ok(again?.already === true && r.casts.length === 1, 'next time it is already wielded: no second cast');
  // EVERY OTHER EQUIP RANKS WITHOUT allowUnrevealed. The summon must stay at the top of the
  // ranking or the next equipBest in the fight path swaps straight back to the long sword.
  const { weaponRanking } = await import('./m59-skills.mjs');
  const ranked = weaponRanking(r.c, { priority: ['hammer', 'long sword'] });
  ok(ranked[0]?.name === 'hammer', `our summon ranks first in an ordinary equip (got ${ranked[0]?.name})`);
}
{
  // ...and a foreign unread hammer still does not.
  const r = rig({ pack: [{ name: 'hammer', rarity: 100 }, { name: 'long sword' }] });
  const { weaponRanking } = await import('./m59-skills.mjs');
  const ranked = weaponRanking(r.c, { priority: ['hammer', 'long sword'] });
  ok(ranked[0]?.name === 'long sword', 'a foreign unread hammer is still ranked out');
}

// ------------------------------------------------------------------ not ours
{
  const r = rig({ pack: [{ name: 'hammer', rarity: 100 }, { name: 'long sword' }] });
  const out = await r.ap.trainingWeaponRoulette();
  ok(!r.c.using.has(1), 'an unidentified hammer we did not make is never wielded');
  ok(r.casts.length === 0 && out === null, 'and no second one is conjured beside it');
}

// ------------------------------------------------------------------ overfarm must not evict it
{
  const r = rig({ ability: 13 });
  ok(r.ap.protectedItemNames().includes('hammer'), 'the training weapon is protected while the skill is under 70');
  const done = rig({ ability: 70 });
  ok(!done.ap.protectedItemNames().includes('hammer'), 'and released at 70');
  const normal = rig({ style: 'normal' });
  ok(!normal.ap.protectedItemNames().includes('hammer'), 'and never under a normal style');
}

// ------------------------------------------------------------------ the odds note
{
  const r = rig();
  r.c.abilityOf = n => (n === 'create weapon' ? 98 : null);
  const e = conjurePowerEstimate(r.c);
  ok(e.power === 49 + 2 + 10, `power = ability/2 + crowd + health (got ${e.power})`);
  const p = e.chance('hammer');
  ok(p > 0.3 && p < 0.4, `hammer odds at 61 are ~37% (got ${Math.round(p * 100)}%)`);
  ok(e.chance('mystic sword') === 0, 'a mystic sword is unreachable at 61');
}

// ------------------------------------------------------------------ the chest put-back
{
  let purse = 400, chest = 75000;
  const c = {
    inventory: [{ id: 5, nameRsc: 'shilling', amount: purse }],
    rsc: { get: x => x }, evSeq: 0,
    room: { num: 714, objects: new Map([[900, { id: 900, nameRsc: 'chest', row: 18, col: 6 }]]) },
    contents() {}, requestInventory() {},
    get() { purse += chest; chest = 0; c.inventory = [{ id: 5, nameRsc: 'shilling', amount: purse }]; },
    put(spec, _id) { const n = Number(spec?.amount ?? 0); purse -= n; chest += n; c.inventory = [{ id: 5, nameRsc: 'shilling', amount: purse }]; },
    async waitFor({ kinds } = {}) {
      return { events: kinds?.includes('container') ? [{ kind: 'container', items: [{ id: 901, name: 'shilling', amount: chest }] }] : [] };
    },
  };
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() }, world: { room: { num: 714 } } };
  ap.policy = {}; ap.tally = {}; ap.notes = [];
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.travel = async () => ({ arrived: true });
  ap.reachHallChests = async () => ({ ok: true });
  ap.refreshChestCache = async () => {};
  ap.packAsItems = () => c.inventory.map(o => ({ name: o.nameRsc, amount: o.amount }));
  ap.dropSpec = (o, n) => ({ id: o.id, amount: n });
  const tookN = [];
  const left = await ap.takeFromChest({ target: { id: 900 }, want: { item: 'shilling', amount: 4800, slot: 'r18c6' },
    inside: [{ id: 901, name: 'shilling', amount: 75000 }], onTook: n => tookN.push(n) });
  ok(purse === 400 + 4800, `the purse gains exactly the 4,800 asked for (purse ${purse})`);
  ok(chest === 75000 - 4800, `the other ${75000 - 4800} goes back into the chest (chest ${chest})`);
  ok(tookN.join() === '4800' && left === 0, 'and the errand is told it took 4,800, not 75,000');
  ok(ap.notes.some(n => /put the rest of the stack back/.test(n.what)), 'the put-back is noted');
}
{
  // A chest that refuses the put: the character is told plainly rather than walking off quietly.
  let purse = 0, chest = 500;
  const c = {
    inventory: [], rsc: { get: x => x }, evSeq: 0,
    requestInventory() {},
    get() { purse += chest; chest = 0; c.inventory = [{ id: 5, nameRsc: 'shilling', amount: purse }]; },
    put() {}, async waitFor() { return { events: [] }; },
  };
  const ap = Object.create(Autopilot.prototype);
  ap.s = { client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() } };
  ap.policy = {}; ap.notes = [];
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.packAsItems = () => c.inventory.map(o => ({ name: o.nameRsc, amount: o.amount }));
  ap.dropSpec = (o, n) => ({ id: o.id, amount: n });
  const tookN = [];
  await ap.takeFromChest({ target: { id: 900 }, want: { item: 'shillings', amount: 100 },
    inside: [{ id: 901, name: 'shilling', amount: 500 }], onTook: n => tookN.push(n) });
  ok(ap.notes.some(n => /COULD NOT put the rest/.test(n.what)), 'a refused put-back is said out loud');
  ok(tookN.join() === '500', 'and the ledger records what actually arrived (500), plural name matched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
