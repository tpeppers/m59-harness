import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tryOceanSelfDedication } from './m59-ocean-self-dedication.mjs';
import { WeaponMagicBook } from './m59-weapon-magic.mjs';

const START = 1_800_000_000_000, AXE = 123, HAMMER = 124, SPELL = 3610;
const PLAIN = 'This axe is in flawless condition.';
const DEDICATED = "This weapon has been dedicated to Kraanan's glory. " + PLAIN;

function fixture() {
  let at = START, hold = null, safe = true;
  const sends = [], notes = [], released = [];
  const names = new Map([[1, 'axe'], [2, 'hammer'], [3, 'elderberry'], [4, 'orc tooth'], [5, 'enchant weapon']]);
  const descriptions = new Map([[AXE, PLAIN], [HAMMER, 'This hammer is in flawless condition.']]);
  const vitals = { health: { value: 125, max: 125 }, vigor: { value: 189 }, mana: { value: 45 } };
  const c = {
    state: 'game', combatReady: true, self: { row: 43, col: 55 }, selfId: 700, room: { id: 713 },
    idGenerations: [], rsc: names, evSeq: 1, spells: [{ id: SPELL, nameRsc: 5, numTargets: 1 }],
    inventory: [{ id: AXE, nameRsc: 1, rarity: 0 }, { id: HAMMER, nameRsc: 2, rarity: 0 },
      { id: 233, nameRsc: 3, amount: 5 }, { id: 234, nameRsc: 4, amount: 2 }],
    vitals: () => vitals,
    equipment: () => ({ known: true, equipped: [{ id: HAMMER, name: 'hammer' }] }),
    idsAsOf: () => ({ inventory_at: at - 100, last_save_at: START - 10_000 }),
    lastPostureCommand: { verb: 'stand', room_object_id: 713 },
    look(id) { this.looked = id; },
    waitFor: async () => ({ events: [{ kind: 'look', id: c.looked, description: descriptions.get(c.looked) }] }),
    cast(spell, targets) {
      sends.push({ spell, targets });
      hold = { active: true, auto: true, spell: 'enchant weapon' };
      return true;
    },
  };
  const s = { client: c, live: true, world: { room: { num: 552 } },
    pacer: { submit: async (_kind, callback) => callback(), holdStatus: () => hold,
      breakTrance: why => { released.push(why); hold = null; } } };
  const book = new WeaponMagicBook({ now: () => at });
  const pilot = { s, mode: 'farm', policy: { assignedRoom: 552, molluskCoverRecovery: true },
    playerThreatPresent: () => false, currentRecoveryWall: () => safe, facultyHeld: () => false,
    weaponMagicBook: () => book,
    packWeapons: () => c.inventory.filter(o => [AXE, HAMMER].includes(o.id)).map(o => ({ id: o.id, name: names.get(o.nameRsc) })),
    ledgerEvent: (kind, data) => notes.push({ kind, ...data }),
  };
  return { c, s, pilot, vitals, descriptions, sends, notes, released, book,
    run: () => tryOceanSelfDedication(pilot, { now: () => at }),
    setSafe: value => { safe = value; },
    finishHold: () => { at += 30_000; hold = null; },
  };
}

test('casts only on the exact verified axe and certifies dedication through its later LOOK', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.sends, [{ spell: SPELL, targets: [AXE] }]);
  assert.equal(await f.run(), false, 'do not block the next survival pass or send again while charging');
  assert.equal(f.notes.length, 1);
  f.descriptions.set(AXE, DEDICATED);
  f.finishHold();
  assert.equal(await f.run(), false);
  assert.equal(f.notes.at(-1).confirmed, true);
  assert.equal(f.book.readings.get(AXE).class, 'enchanted');
});

test('a refuge loss during the native trance releases only that hold and records no false dedication', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  f.setSafe(false);
  assert.equal(await f.run(), false);
  assert.equal(f.released.length, 1);
  f.setSafe(true);
  assert.equal(await f.run(), false);
  assert.equal(f.notes.at(-1).confirmed, false);
  assert.equal(f.sends.length, 1);
});

test('an armed farmer keeps a usable dedicated weapon and skips poor, conjured, unknown, or unsafe candidates', async () => {
  for (const change of [
    f => f.book.record(HAMMER, 'hammer', DEDICATED),
    f => { f.descriptions.set(AXE, 'It shimmers insubstantially. ' + PLAIN); },
    f => { f.descriptions.set(AXE, 'This axe is well worn and may not last much longer.'); },
    f => { f.descriptions.set(AXE, 'An unverified axe.'); },
    f => { f.c.inventory[0].rarity = 100; },
    f => { f.c.inventory.find(o => o.id === 233).amount = 2; },
    f => { f.c.spells[0].numTargets = 2; },
    f => { f.pilot.policy.neverAttack = true; },
    f => { f.vitals.health.value = 124; },
    f => { f.vitals.vigor.value = 139; },
    f => f.setSafe(false),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.sends, []);
  }
  const worn = fixture();
  worn.book.record(HAMMER, 'hammer', "Dedicated to Kraanan's glory. This hammer is well worn and may not last much longer.");
  assert.equal(await worn.run(), true, 'a nearly broken dedication no longer excludes the replacement');
});

test('the paced cast rechecks ownership, resources, and ward proof after the first look', async () => {
  for (const interrupt of [
    f => { f.c.idGenerations = []; },
    f => { f.vitals.mana.value = 16; },
    f => f.setSafe(false),
    f => { f.pilot.facultyHeld = name => name === 'work'; },
  ]) {
    const f = fixture();
    f.s.pacer.submit = async (kind, callback) => {
      if (kind === 'cast') interrupt(f);
      return callback();
    };
    assert.equal(await f.run(), false);
    assert.deepEqual(f.sends, []);
    assert.deepEqual(f.notes, []);
  }
});
