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
import { weaponRanking } from './m59-skills.mjs';
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
