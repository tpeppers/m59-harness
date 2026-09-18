#!/usr/bin/env node
// WHEN NOT TO PULL THE LEVER. Offline: no broker, no socket, no roster, no fleet.
//
// `create weapon` is a slot machine over seven weapons (creaweap.kod CastSpell rolls
// `Random(iSpellPower/3, iSpellPower)` and picks by band), and the keeper used to cast it
// whenever `equipBest` came back empty. Two ways that never terminates:
//
//   * THE BAN AND THE SPELL DISAGREE. Every result is on the character's own ban list, so
//     `equipBest` refuses it, the character is still bare, and the next pass casts again.
//     Rizzo, prod 2026-09-18: bare in room 38 carrying TWENTY-FOUR long swords it was
//     banned from, with 14 mana against the 15 the spell costs. Fozzie died of the same
//     thing the same day — sixty seconds unarmed in a fifteen-troll room, standing on two
//     hammers its ban list forbade.
//   * THE CHARACTER IS BARE ON PURPOSE. `trainingStyle: 'unarmed'` fights with fists, and
//     `prepareTrainingStyle` takes any weapon back off at the start of the bout. Arming
//     between fights therefore paid 15 mana and 70 bulk to be disarmed on the first swing.
//
// The existing "conjured a weapon it cannot hold" check reads what the spell MADE and
// declines to call it armed. That is the diagnosis and it already says why — "the loop
// cannot end while the ban and the spell disagree". This pins the half that ENDS it.
import { Autopilot } from './m59-autopilot.mjs';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!condition) failed++;
};

// A stand-in carrying only what the guards actually read. Methods are taken off the real
// prototype, so this tests the shipped code rather than a copy of it.
const rig = ({ style = 'normal', room = 38, assigned = 38, mode = 'farm',
               banned = null, pack = [] } = {}) => {
  const declined = [];
  const notes = [];
  const self = {
    mode,
    policy: { trainingStyle: style, assignedRoom: assigned, bannedWeapons: banned },
    s: {
      world: { room: { num: room } },
      client: {
        inventory: pack.map((name, i) => ({ id: i + 1, nameRsc: i + 1, name })),
        rsc: { get: id => pack[id - 1] ?? '' },
        vitals: () => ({ vigor: { value: 200 }, mana: { value: 100, max: 100 } }),
      },
    },
    declinedCast: (spell, why, facts) => { declined.push({ spell, why, facts }); return false; },
    note: (what, facts) => { notes.push({ what, facts }); },
    declined, notes,
  };
  for (const m of ['bareHandedByTraining', 'bannedConjurablesHeld', 'styleForNonPrey',
                   'trainingStyleFor', 'bannedWeaponsNow'])
    self[m] = Autopilot.prototype[m].bind(self);
  return self;
};

console.log('--- bare on purpose is a decision, not a failure to arm ---');
{
  ok('unarmed style on its own farm ground is deliberate',
     rig({ style: 'unarmed', room: 38, assigned: 38 }).bareHandedByTraining());
  ok('OFF its own ground it still arms — that weapon is for travel and survival',
     !rig({ style: 'unarmed', room: 599, assigned: 38 }).bareHandedByTraining(),
     'dum-bot declines to send a weapon priority for unarmed for this reason');
  ok('a normal-style character is never bare on purpose',
     !rig({ style: 'normal', room: 38, assigned: 38 }).bareHandedByTraining());
  ok('outside farm mode it arms even on the assigned room',
     !rig({ style: 'unarmed', room: 38, assigned: 38, mode: 'travel' }).bareHandedByTraining());
}

console.log('\n--- the hoard is counted from the pack, against this character\'s own ban ---');
{
  const rizzo = rig({ banned: ['long sword', 'axe', 'scimitar'],
                      pack: Array(24).fill('long sword') });
  ok('24 banned long swords count as 24', rizzo.bannedConjurablesHeld() === 24,
     `got ${rizzo.bannedConjurablesHeld()}`);
  ok('a weapon it MAY hold is not part of the hoard',
     rig({ banned: ['long sword'], pack: ['hammer', 'hammer'] }).bannedConjurablesHeld() === 0);
  ok('non-conjurable banned items are not the hoard either',
     rig({ banned: ['bow'], pack: ['bow', 'crossbow'] }).bannedConjurablesHeld() === 0,
     'create weapon cannot produce a bow, so these are not its output');
  ok('no ban list means no hoard', rig({ pack: Array(9).fill('long sword') })
       .bannedConjurablesHeld() === 0);
}

console.log('\n--- makeWeapon refuses before it pays ---');
{
  const brawler = rig({ style: 'unarmed', room: 38, assigned: 38 });
  await Autopilot.prototype.makeWeapon.call(brawler, 'test');
  ok('a brawler on its own ground does not cast at all', brawler.declined.length === 1,
     brawler.declined[0]?.why ?? 'nothing declined');
  ok('and it says the bout would disarm it',
     /disarm|taken off/i.test(JSON.stringify(brawler.declined[0]?.facts ?? {})));

  const walled = rig({ banned: ['mace', 'short sword', 'hammer', 'axe', 'long sword',
                                'scimitar', 'mystic sword'] });
  await Autopilot.prototype.makeWeapon.call(walled, 'test');
  ok('banning all seven producible weapons refuses the cast',
     walled.declined[0]?.why === 'every weapon it could make is banned');

  const hoarder = rig({ banned: ['long sword'], pack: Array(24).fill('long sword') });
  await Autopilot.prototype.makeWeapon.call(hoarder, 'test');
  ok('a hoard of unusable results stops the next cast',
     hoarder.declined[0]?.why === 'already carrying unusable conjured weapons',
     hoarder.declined[0]?.why ?? 'nothing declined');
  ok('and it names what would still be worth holding',
     /hammer/.test(JSON.stringify(hoarder.declined[0]?.facts?.can_still_make ?? [])),
     'hammer is not banned here, so a supply is the way out');

  const fine = rig({ banned: ['long sword'], pack: ['long sword'] });
  const refusedEarly = await Autopilot.prototype.makeWeapon.call(fine, 'test')
    .then(() => fine.declined.length > 0, () => true);
  ok('ONE unusable result is not a hoard — bad luck still gets another roll',
     !fine.declined.some(d => d.why === 'already carrying unusable conjured weapons'),
     refusedEarly ? 'stopped later for an unrelated reason, which is fine' : 'proceeded');
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
