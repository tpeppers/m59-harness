#!/usr/bin/env node
// WHY A BARE CHARACTER IS BARE. Offline: no socket, no roster, no fleet.
//
// Two incidents are pinned here and they cost differently. 2026-09-11: Statler was handed
// three weapons with three `act use` calls and answered with silence each time, because
// `trainingStyle: 'unarmed'` makes the keeper take the weapon off on the first swing.
// 2026-09-18: Rowlf carried 22 long swords and Rizzo 24, both with `long sword` banned, and
// both stood bare waiting on 15 mana to conjure one — Rizzo for 4,293 idle passes — while
// the fleet board rendered `hunting: zombie or battered skeleton` the whole time.
//
// Both are hand-overs that complete and achieve nothing, which is the shape this repository
// keeps paying for: the call succeeds, the journal records the right argument, and the world
// does not change. So the assertion that matters most here is the NEGATIVE one — that
// `armingRefusal` returns null when it has nothing to say, rather than reaching for a cause.
// A diagnostic that always names something is not a diagnostic.

import { armingRefusal, bannedWeaponsHeld, usableWeaponsHeld } from './m59-arming.mjs';
import { isBannedWeapon, weaponScore } from './m59-skills.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// The real rule and the real weapon predicate, injected the way the callers inject them —
// a test that passes its own matcher is testing its own matcher.
const real = { isBannedWeapon, weaponScore };
const items = names => names.map(n => ({ name: n }));

console.log('the ban rule is the one in m59-skills.mjs, not a second one written here');
{
  // Substring, case-insensitive. Pinned because the module defaults to a private copy when a
  // caller passes nothing, and the two must not drift.
  const held = bannedWeaponsHeld({ items: items(['long sword', 'Long Sword', 'hammer']),
                                   banned: ['long sword'], ...real });
  ok('substring and case-insensitive, both matched', held.length === 2,
     JSON.stringify(held.map(h => h.name)));
  ok('and the unbanned weapon is left alone',
     usableWeaponsHeld({ items: items(['long sword', 'hammer']), banned: ['long sword'], ...real })
       .map(i => i.name).join() === 'hammer');
  ok('no ban list bans nothing',
     bannedWeaponsHeld({ items: items(['long sword']), banned: null, ...real }).length === 0);
  ok('an empty ban list bans nothing',
     bannedWeaponsHeld({ items: items(['long sword']), banned: [], ...real }).length === 0);
  // Non-weapons are never "banned weapons held", whatever the list says.
  ok('a ban that matches a non-weapon does not make it one',
     bannedWeaponsHeld({ items: items(['red mushroom']), banned: ['red mushroom'], ...real }).length === 0);
}

console.log('');
console.log('Rizzo, 2026-09-18: 24 long swords, long sword banned, bare for 4,293 passes');
{
  const r = armingRefusal({ policy: { bannedWeapons: ['long sword'], trainingStyle: 'normal' },
                            items: items(Array(24).fill('long sword')), ...real });
  ok('it is refused', !!r);
  ok('and the reason is the ban, not the mana', r?.reason === 'every_weapon_banned', JSON.stringify(r));
  ok('and it names the weapon so the fix is one edit', /long sword/.test(r?.detail ?? ''), r?.detail);

  // ONE USABLE WEAPON IS ENOUGH. The hoard is not the blocker if anything in it is allowed.
  const mixed = armingRefusal({ policy: { bannedWeapons: ['long sword'] },
                                items: items([...Array(24).fill('long sword'), 'hammer']), ...real });
  ok('one allowed weapon in the pack clears it', mixed === null, JSON.stringify(mixed));
}

console.log('');
console.log('Statler, 2026-09-11: three weapons handed over, three silences');
{
  const r = armingRefusal({ policy: { trainingStyle: 'unarmed' }, items: items(['mace']), ...real });
  ok('an unarmed trainer on its own ground refuses', r?.reason === 'training_style_unarmed');
  // SCOPED TO ITS OWN GROUND, the way the keeper scopes it: the weapon it wants off station
  // is for the road, not for the bout.
  const away = armingRefusal({ policy: { trainingStyle: 'unarmed' }, items: items(['mace']),
                               onOwnGround: false, ...real });
  ok('off its own ground it arms like anyone else', away === null, JSON.stringify(away));
  ok('the style wins over the ban when both apply',
     armingRefusal({ policy: { trainingStyle: 'unarmed', bannedWeapons: ['mace'] },
                     items: items(['mace']), ...real })?.reason === 'training_style_unarmed');
  ok('snake_case from a roster is read too',
     armingRefusal({ policy: { training_style: 'unarmed' }, items: items(['mace']), ...real })
       ?.reason === 'training_style_unarmed');
}

console.log('');
console.log('the weapon about to be handed over is checked on its own');
{
  const r = armingRefusal({ policy: { bannedWeapons: ['axe'] }, items: items(['hammer']),
                            offered: { name: 'battle axe' }, ...real });
  ok('a banned OFFER is refused before the walk', r?.reason === 'offer_banned', JSON.stringify(r));
  ok('and says so in terms of the walk', /after the walk/.test(r?.detail ?? ''));
  ok('an allowed offer to an empty-handed character goes ahead',
     armingRefusal({ policy: { bannedWeapons: ['axe'] }, items: [],
                     offered: { name: 'long sword' }, ...real }) === null);
  // A hand-over RESCUES an all-banned pack, so the pack check must not fire when an offer is
  // on the table — that is the case the tool exists for.
  ok('an allowed offer rescues an all-banned pack',
     armingRefusal({ policy: { bannedWeapons: ['long sword'] },
                     items: items(Array(24).fill('long sword')),
                     offered: { name: 'hammer' }, ...real }) === null);
}

console.log('');
console.log('the vigor floor is last, because it is the only one that clears by itself');
{
  const r = armingRefusal({ policy: { fightAboveVigor: 60 }, items: items(['hammer']),
                            vigor: 29, ...real });
  ok('under the floor is refused', r?.reason === 'below_vigor_floor', JSON.stringify(r));
  ok('and it names armSelf sitting after hibernate', /hibernate/.test(r?.detail ?? ''));
  ok('at the floor is not under it',
     armingRefusal({ policy: { fightAboveVigor: 60 }, items: items(['hammer']), vigor: 60, ...real }) === null);
  // A FLOOR OF ZERO IS NOT A FLOOR — the same rule the loadout carry minimum needed.
  ok('a floor of zero never blocks',
     armingRefusal({ policy: { fightAboveVigor: 0 }, items: items(['hammer']), vigor: 0, ...real }) === null);
  ok('an unknown vigor is not treated as a low one',
     armingRefusal({ policy: { fightAboveVigor: 60 }, items: items(['hammer']), vigor: null, ...real }) === null);
  ok('a ban outranks the floor, because the ban will still be there afterwards',
     armingRefusal({ policy: { fightAboveVigor: 60, bannedWeapons: ['hammer'] },
                     items: items(['hammer']), vigor: 29, ...real })?.reason === 'every_weapon_banned');
}

console.log('');
console.log('and it says nothing when it has nothing to say');
{
  ok('an ordinary bare character with an empty pack', armingRefusal({ policy: {}, items: [], ...real }) === null);
  ok('no policy at all', armingRefusal({ ...real }) === null);
  ok('a normal style and no bans', armingRefusal({ policy: { trainingStyle: 'normal' },
                                                   items: items(['hammer']), ...real }) === null);
  // An empty pack with a ban list is NOT "every weapon banned" — there are no weapons. That
  // conflation would report a cause for every character that had just been killed.
  ok('an empty pack is not an all-banned pack',
     armingRefusal({ policy: { bannedWeapons: ['long sword'] }, items: [], ...real }) === null);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
