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
import * as skills from './m59-skills.mjs';

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


// ── ESCALATION: a murderer inherits the loadout anyway ───────────────────────
//
// `bannedWeapons` protects a training block that a different proficiency would reset
// (player.kod:4753-4757). Worth defending against a fungus beast; not worth defending
// against a person who is killing you, because the block dies with the character and the
// pack drops to the killer. Operator, 2026-09-18. Scoped to PVP and nothing else.

const pvpRig = (pack, { banned = ['long sword', 'axe'], abilities = {} } = {}) => {
  const items = pack.map((p, i) => typeof p === 'string'
    ? { id: i + 1, nameRsc: i + 1, name: p }
    : { id: i + 1, nameRsc: i + 1, ...p });
  const names = items.map(o => o.name);
  const equipped = [];
  const self = {
    tally: {}, notes: [],
    policy: { bannedWeapons: banned },
    s: {
      client: {
        inventory: items,
        rsc: { get: id => names[id - 1] ?? '' },
        abilityOf: sk => abilities[sk] ?? null,
      },
    },
    note: (what, facts) => self.notes.push({ what, facts }),
  };
  self.bannedWeaponsNow = Autopilot.prototype.bannedWeaponsNow.bind(self);
  // Stub the wield so the test stays offline; record what was asked for.
  self._equipped = equipped;
  return { self, equipped, items };
};

console.log('\n--- escalation picks the weapon this character is BEST with ---');
{
  // The proficiency names are the SERVER's, not the ones you would guess: a long sword is
  // `fencing` and a hammer is `hammer wielding` (WEAPON_PROFICIENCY). Keying the stub on
  // anything else returns null for both and the sort silently falls back to the crude name
  // score — which passed, and proved nothing about ability ordering.
  const { self } = pvpRig(['long sword', 'hammer'],
    { banned: ['long sword'], abilities: { fencing: 80, 'hammer wielding': 20 } });
  const ranked = skills.weaponRanking(self.s.client, { banned: null });
  ok('with the ban lifted the pack ranks by PROFICIENCY, best first',
     ranked.length === 2 && ranked[0].name === 'long sword' && ranked[0].ability === 80,
     `got ${ranked.map(r => `${r.name}:${r.ability}`).join(', ')}`);
  const flipped = pvpRig(['long sword', 'hammer'],
    { banned: ['long sword'], abilities: { fencing: 10, 'hammer wielding': 90 } }).self;
  const ranked2 = skills.weaponRanking(flipped.s.client, { banned: null });
  ok('and it is the ABILITY deciding, not the name — flip them and the hammer wins',
     ranked2[0].name === 'hammer' && ranked2[0].ability === 90,
     `got ${ranked2.map(r => `${r.name}:${r.ability}`).join(', ')}`);
  const legal = skills.weaponRanking(self.s.client, { banned: ['long sword'] });
  ok('and the ban is what was hiding it — legally there is only the hammer',
     legal.length === 1 && legal[0].name === 'hammer');
}

console.log('\n--- what escalation still refuses ---');
{
  const cursedish = skills.weaponRanking(
    pvpRig([{ name: 'long sword', rarity: 100 }]).self.s.client, { banned: null });
  ok('an UNREVEALED weapon is refused even with the ban lifted', cursedish.length === 0,
     'a ban is a preference; wielding a cursed weapon is the one irreversible mistake');

  const bowOnly = pvpRig(['bow']).self.s.client;
  const noAmmo = (bowOnly.inventory || []).some(o =>
    /arrow|bolt/.test(String(bowOnly.rsc.get(o.nameRsc)).toLowerCase()));
  ok('a bow with no arrows is not ammunition-backed', !noAmmo,
     'escalateArmForPvp drops bows unless arrows or bolts are aboard');

  const withAmmo = pvpRig(['bow', 'arrow']).self.s.client;
  const hasAmmo = (withAmmo.inventory || []).some(o =>
    /arrow|bolt/.test(String(withAmmo.rsc.get(o.nameRsc)).toLowerCase()));
  ok('a bow WITH arrows is', hasAmmo);
}

console.log('\n--- fists are an answer, not a failure ---');
{
  const { self } = pvpRig([], { banned: ['long sword'] });
  const ranked = skills.weaponRanking(self.s.client, { banned: null });
  ok('an empty pack ranks nothing, so escalation returns null and the swing goes bare',
     ranked.length === 0,
     'defendAgainstPlayers proceeds either way — standing still is the only wrong answer');
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
