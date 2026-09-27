#!/usr/bin/env node
// Offline contract for m59-weapon-magic.mjs. Opens no socket and joins nobody.
//
// Pins the cases that fail quietly:
//   - an unread weapon is `unknown`, never mundane (nobody looked is not "it is ordinary")
//   - born-magic and unflagged classes need no look and never go stale
//   - a lapse re-opens every reading of that NAME (the sentence names no id)
//   - a reading does not survive its id being handed to a different item (ids are handles)
//   - the swap stays inside the character's own weapon priority (no forced sword)
import { classifyWeapon, lapsedWeapon, dedicatedWeapon, WeaponMagicBook, magicSwap }
  from './m59-weapon-magic.mjs';
import { weaponRanking, inventorySalePlan, equipBest, armourOf, isOwnSummon } from './m59-skills.mjs';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

const ENCH = 'A finely crafted long sword. This weapon has been dedicated to Kraanan\'s glory.';
const PLAIN = 'A finely crafted long sword.';
const MADE = 'A finely crafted long sword. It shimmers insubstantially.';

console.log('classifyWeapon');
ok('born magic needs no look', classifyWeapon({ name: 'Mystic Sword' }).bypasses_nonmagic === true);
ok('nerudite sword is unflagged and a troll weakness',
   classifyWeapon({ name: 'nerudite sword' }).class === 'unflagged' &&
   classifyWeapon({ name: 'nerudite sword' }).troll_weakness === true);
ok('an unread long sword is unknown, not mundane',
   classifyWeapon({ name: 'long sword' }).bypasses_nonmagic === null);
ok('the dedication line reads as enchanted', classifyWeapon({ name: 'long sword', look: ENCH }).class === 'enchanted');
ok('a plain look reads as mundane', classifyWeapon({ name: 'long sword', look: PLAIN }).bypasses_nonmagic === false);
ok('a conjured weapon is flagged made', classifyWeapon({ name: 'long sword', look: MADE }).made === true);
ok('a real one is flagged not made', classifyWeapon({ name: 'long sword', look: PLAIN }).made === false);

console.log('messages');
ok('the lapse sentence names the weapon',
   lapsedWeapon('Your long sword suddenly seems a little more... ordinary.') === 'long sword');
ok('an unrelated line is not a lapse', lapsedWeapon('You suddenly feel a little tougher.') === null);
ok('the caster\'s dedication sentence names the weapon',
   dedicatedWeapon('Your hammer is now dedicated to Kraanan.') === 'hammer');

console.log('WeaponMagicBook');
{
  let t = 0;
  const book = new WeaponMagicBook({ now: () => t, maxAgeMs: 1000 });
  const pack = [{ id: 1, name: 'long sword' }, { id: 2, name: 'long sword' },
                { id: 3, name: 'mystic sword' }, { id: 4, name: 'bread' }];
  ok('everything unread and weapon-shaped needs a look, born magic does not',
     book.needsLook(pack).map(i => i.id).join() === '1,2');
  book.record(1, 'long sword', ENCH);
  book.record(2, 'long sword', PLAIN);
  ok('read weapons stop asking', book.needsLook(pack).length === 0);
  let s = book.summary(pack, 2);
  ok('summary: wielded mundane', s.wielded?.bypasses_nonmagic === false);
  ok('summary: two magic spares (enchanted + born magic)', s.magic_spares === 2);
  t = 2000;
  ok('an enchanted reading goes stale; a mundane one does not',
     book.needsLook(pack).map(i => i.id).join() === '1');
  t = 2100;
  const re = book.lapse('Long Sword');
  ok('a lapse re-opens the enchanted reading of that name only', re.join() === '1' &&
     book.summary(pack, 2).weapons.find(w => w.id === 1).bypasses_nonmagic === null);
  book.record(1, 'long sword', ENCH);
  book.reconcile([{ id: 1, name: 'hammer' }, { id: 2, name: 'long sword' }]);
  ok('a reading does not survive its id wearing a new name',
     book.summary([{ id: 1, name: 'hammer' }], null).weapons[0].class === 'unknown');
  book.reconcile([{ id: 2, name: 'long sword' }]);
  ok('a reading for an id no longer carried is dropped', !book.readings.has(1));
}

console.log('magicSwap');
{
  const rank = n => ({ hammer: 0, 'long sword': 1 }[n] ?? 5);
  const s = w => ({ weapons: w });
  ok('mundane hammer + enchanted hammer spare: swap to the spare',
     magicSwap(s([{ id: 1, name: 'hammer', wielded: true, bypasses_nonmagic: false },
                  { id: 2, name: 'hammer', wielded: false, bypasses_nonmagic: true }]), rank) === 2);
  ok('mundane hammer + enchanted long sword: NO swap (never trade down the priority)',
     magicSwap(s([{ id: 1, name: 'hammer', wielded: true, bypasses_nonmagic: false },
                  { id: 2, name: 'long sword', wielded: false, bypasses_nonmagic: true }]), rank) === null);
  ok('already magic: no swap',
     magicSwap(s([{ id: 1, name: 'hammer', wielded: true, bypasses_nonmagic: true },
                  { id: 2, name: 'hammer', wielded: false, bypasses_nonmagic: true }]), rank) === null);
  ok('an unknown wielded weapon with a magic peer swaps (unknown is not magic)',
     magicSwap(s([{ id: 1, name: 'hammer', wielded: true, bypasses_nonmagic: null },
                  { id: 2, name: 'hammer', wielded: false, bypasses_nonmagic: true }]), rank) === 2);
}

console.log('weaponRanking tie-break (the keeper\'s equip order)');
{
  const names = ['hammer', 'hammer', 'long sword'];
  const client = (magic) => ({
    inventory: names.map((n, i) => ({ id: i + 1, nameRsc: 1000 + i, flags: 0 })),
    rsc: { get: r => names[r - 1000] ?? '' }, using: new Set(), _magicWeaponIds: magic,
  });
  const order = (magic, priority) => weaponRanking(client(magic), { priority }).map(r => r.o.id).join();
  ok('with no magic set the equal hammers keep their order', order(null, ['hammer']).startsWith('1,2'));
  ok('the magic hammer wins the tie between hammers', order(new Set([2]), ['hammer']).startsWith('2,1'));
  ok('a magic long sword NEVER outranks a hammer the priority puts first',
     order(new Set([3]), ['hammer', 'long sword']) === '1,2,3');
}

console.log('Autopilot: the lapse re-opens, reports, and the status carries it');
{
  const notes = [], ledger = [];
  const names = ['hammer', 'hammer'];
  const c = { inventory: [{ id: 7, nameRsc: 1000 }, { id: 8, nameRsc: 1001 }],
              rsc: { get: r => names[r - 1000] ?? '' },
              equipment: () => ({ known: true, equipped: [{ id: 7, name: 'hammer' }] }) };
  const rig = {
    s: { client: c }, policy: { preferMagicWeapon: true },
    note: (k) => notes.push(k), ledgerEvent: (k) => ledger.push(k),
    sweepWeaponMagic: async () => {},
  };
  for (const m of ['weaponMagicBook', 'packWeapons', 'wieldedWeaponId', 'weaponMagicStatus', 'noteEnchantLapse'])
    rig[m] = Autopilot.prototype[m].bind(rig);
  rig.weaponMagicBook().record(7, 'hammer', 'dedicated to Kraanan\'s glory');
  rig.weaponMagicBook().record(8, 'hammer', 'dedicated to Kraanan\'s glory');
  let st = rig.weaponMagicStatus();
  ok('status: wielded hammer read magic, one magic spare',
     st.wielded?.bypasses_nonmagic === true && st.magic_spares === 1 && st.prefer_magic === true);
  rig.noteEnchantLapse('hammer');
  st = rig.weaponMagicStatus();
  ok('a lapse makes both same-named readings unknown (the sentence names no id)',
     st.wielded?.bypasses_nonmagic === null && st.magic_spares === 0);
  ok('the lapse is noted, ledgered, counted, and the swap made due',
     notes.includes('ENCHANTMENT LAPSED') && ledger.includes('enchant_lapse') &&
     st.lapses === 1 && rig._magicSwapDue === true);
}

// 2026-09-27: Animal reconnected in Ukgoth to shed aggro, the new client had no magic set, the
// sweep that rebuilds it sits in a pass rung the recovery ladder pre-empted, and every fight's
// equip picked the conjured mundane long sword over the enchanted one in his pack.
console.log('a reconnect cannot blind the equip: the set is rebuilt from the book at ranking time');
{
  const names = ['long sword', 'long sword'];
  const fresh = () => ({ inventory: [{ id: 1, nameRsc: 1000, flags: 0 }, { id: 2, nameRsc: 1001, flags: 0 }],
    rsc: { get: r => names[r - 1000] ?? '' },
    equipment: () => ({ known: true, equipped: [{ id: 1, name: 'long sword' }] }) });
  const rig = { policy: { preferMagicWeapon: true } };
  for (const m of ['weaponMagicBook', 'packWeapons', 'wieldedWeaponId', 'syncMagicSet'])
    rig[m] = Autopilot.prototype[m].bind(rig);
  rig.weaponMagicBook().record(1, 'long sword', 'It shimmers insubstantially.');
  rig.weaponMagicBook().record(2, 'long sword', 'This weapon has been dedicated to Kraanan\'s glory.');
  const c = fresh();
  rig.s = { client: c };
  ok('a fresh client starts with no magic set', c._magicWeaponIds === undefined);
  rig.syncMagicSet(c);
  ok('syncMagicSet restores it from the book, and marks the conjured one',
     c._magicWeaponIds?.has(2) && !c._magicWeaponIds.has(1) && c._madeItemIds?.has(1));

  // equipBest itself asks: with the hook, the enchanted twin is already in hand and nothing is sent.
  const c2 = { ...fresh(), using: new Set([2]) };
  const sent = [];
  const s = { need: () => c2, beforeEquip: (cl) => rig.syncMagicSet(cl),
              pacer: { submit: async (k, f) => { sent.push(k); return f(); } } };
  c2.use = () => {}; c2.waitFor = async () => ({ events: [] });
  const r = await equipBest(s, { priority: ['long sword'], refresh: false, maxTries: 1 });
  ok('equipBest ranks with the hook: it keeps the enchanted sword and sends no use',
     r?.id === 2 && r?.already_wielded === true && !sent.includes('use'));
}

// Operator, 2026-09-27: nobody uses magic items that are not Kraanan-enchanted; they are revealed
// and kept. An enchantment leaves the grade at 0, so the grade decides.
console.log('magic loot is kept, not wielded or worn');
{
  const names = ['short sword', 'short sword', 'scimitar', 'leather armor', 'small round shield'];
  const inv = [{ id: 1, rarity: 2 }, { id: 2, rarity: 0 }, { id: 3, rarity: 100 },
               { id: 4, rarity: 1 }, { id: 5, rarity: 0 }]
    .map((o, i) => ({ ...o, nameRsc: 1000 + i, flags: 0 }));
  const c = { inventory: inv, rsc: { get: r => names[r - 1000] ?? '' }, using: new Set() };
  const ids = weaponRanking(c, { priority: ['short sword', 'scimitar'] }).map(r => r.o.id);
  ok('an identified magic short sword (grade 2) is never ranked', !ids.includes(1));
  ok('the normal-grade twin is', ids.includes(2));
  ok('an unidentified scimitar (100) is not either', !ids.includes(3));
  const arm = armourOf(c);
  ok('magic armour (grade 1) is not worn', !arm.armour.some(x => x.o.id === 4));
  ok('a normal shield is', arm.shield.some(x => x.o.id === 5));
  const summoned = { ...c, _summoned: new Set([3]) };
  ok('a remembered summon may be wielded unread', weaponRanking(summoned).some(r => r.o.id === 3));
  const renumbered = { ...c, _summoned: new Set([3]), _notMadeIds: new Set([3]) };
  ok('but not once a look has read it as NOT conjured (ids renumber on a save)',
     !weaponRanking(renumbered).some(r => r.o.id === 3));
}

console.log('inventorySalePlan: a conjured weapon is never offered');
{
  const c = { me: { id: 17, name: 'Fixture' },
    inventory: [{ id: 41, nameRsc: 1, amount: 1 }, { id: 42, nameRsc: 1, amount: 1 }, { id: 43, nameRsc: 1, amount: 1 }],
    rsc: new Map([[1, 'long sword']]), using: new Set([43]), statsById: new Map(), evSeq: 0,
    eventsSince: () => [], _madeItemIds: new Set([42]) };
  const s = { name: 'fixture', client: c, credentials: { host: 'fixture.invalid', port: 5959, account: 'fixture' },
    need: () => c, pacer: { submit: async (k, fn) => fn() } };
  // A weapon limit, or the equipment plan keeps every weapon and nothing is for sale at all.
  const plan = inventorySalePlan(s, { maxWeapons: 1, weaponPriority: ['long sword'] });
  const row = id => plan.items.find(i => i.id === id);
  ok('the conjured long sword is blocked, and says why', /conjured/.test(String(row(42)?.blocked ?? '')));
  ok('the real one is not blocked for being conjured', !/conjured/.test(String(row(41)?.blocked ?? '')));
}

// EVERY MODE READS ITS WEAPONS (2026-09-26). The sweep lived only in passFarm's farm block, so the
// troll crew DUM stages IDLE at room 2, and the SURVIVE-mode dedicator, never read one: every
// weapon `unknown`, no mundane spare to dedicate, and no swap to an enchanted one either.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const idleAt = src.indexOf("if (this.mode === 'idle') {\n      // A SUSPENDED JOURNEY IS A JOB");
  const idle = src.slice(idleAt, src.indexOf("hibernate('idle: no job to do')", idleAt));
  ok('the idle branch sweeps weapon magic before it hibernates',
     idleAt >= 0 && /this\.sweepWeaponMagic\(\)/.test(idle));
  const farmStart = src.indexOf('async passFarm(');
  const farmBlock = src.indexOf("if (this.mode === 'farm') {", farmStart);
  ok('passFarm sweeps weapon magic before the farm-only block (survive mode)',
     farmStart >= 0 && /this\.sweepWeaponMagic\(\)/.test(src.slice(farmStart, farmBlock)));
  // The fleet row's `provides` is how DUM finds a dedicator. Without enchant weapon in it,
  // nobody on the board ever knew the spell (2026-09-26).
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const prov = broker.slice(broker.indexOf('provides: (c.spells || [])'), broker.indexOf('mana_now:', broker.indexOf('provides: (c.spells || [])')));
  ok("the fleet row's provides carries enchant weapon for the troll dedication",
     /n === 'enchant weapon'/.test(prov));
  ok('and says how well each is known, to choose between dedicators', /provides_ability:/.test(broker));
  // THE TRANCE HOLD REACHES THE KEEPER. It was dropped at the proxy, so a 30-second enchant
  // weapon ran under the keeper's 15-second default freeze.
  const proxyCast = broker.slice(broker.indexOf('cast: (spellId, targets = [], opts = {}) => {'),
                                 broker.indexOf('// AND NO `buy`/`buyItems` HERE'));
  ok('the keeper proxy forwards holdMs', /holdMs: Number\(opts\.holdMs\)/.test(proxyCast));
  ok('and the cast tool sends one, defaulting from the spell cast time',
     /c\.cast\(mine\.id, targets, holdMs \? \{ holdMs \} : \{\}\)/.test(broker) &&
     /await castHoldMs\(mine\.name\)/.test(broker));
  const { buffCatalogue } = await import('./m59-buffs.mjs');
  ok('the catalogue knows enchant weapon is a 30-second trance',
     buffCatalogue().find(b => b.name === 'enchant weapon')?.cast_time_ms === 30000);
}

// 2026-09-27: a hunter's dedicated hammer read "This weapon has been dedicated to Kraanan's glory ...
// This hammer has been shattered by a powerful blow." and was re-ordered as a magic spare every pass.
console.log('a shattered enchanted weapon is not a magic spare');
{
  const SHATTERED = 'A hammer. This weapon has been dedicated to Kraanan\'s glory. This hammer has been shattered by a powerful blow.';
  const c = classifyWeapon({ name: 'hammer', look: SHATTERED });
  ok('the look reads enchanted AND broken', c.class === 'enchanted' && c.broken === true);
  const book = new WeaponMagicBook();
  book.record(1, 'hammer', SHATTERED);
  book.record(2, 'short sword', 'A short sword.');
  const items = [{ id: 1, name: 'hammer' }, { id: 2, name: 'short sword' }];
  const sum = book.summary(items, 2);
  ok('it is not counted as a magic spare', sum.magic_spares === 0);
  ok('and the row says broken', sum.weapons.find(w => w.id === 1)?.broken === true);
  ok('and the keeper\'s swap does not choose it', magicSwap(sum) === null);
  const book2 = new WeaponMagicBook();
  book2.record(1, 'hammer', ENCH.replace('long sword', 'hammer'));
  book2.record(2, 'short sword', 'A short sword.');
  const sum2 = book2.summary(items, 2, undefined, new Set([1]));
  ok('a weapon the server refused as broken is excluded too', sum2.magic_spares === 0 && magicSwap(sum2) === null);
}

// 2026-09-27: after a keeper restart `_summoned` is empty, so a conjured weapon the look had read as
// made ("shimmers insubstantially") was treated as unidentified loot and never wielded.
console.log('the look decides what is a summon');
{
  const o = { id: 77, rarity: 100 };
  ok('a weapon the look read as made is our summon, with no id memory at all',
     isOwnSummon({ _madeItemIds: new Set([77]) }, o) === true);
  ok('a weapon the look read as NOT made is not, whatever the id memory says',
     isOwnSummon({ _summoned: new Set([77]), _notMadeIds: new Set([77]) }, o) === false);
  ok('an unread weapon falls back to the id memory', isOwnSummon({ _summoned: new Set([77]) }, o) === true);
  ok('and with neither it is not ours', isOwnSummon({}, o) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
