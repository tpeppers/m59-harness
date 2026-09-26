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

// ARMOUR LOOTED BY AN ARMED CHARACTER GOES ON. wearArmourIfNeeded's only caller was armSelf(),
// which runs only when unarmed — so Statler (axe in hand) carried two leather armours and wore
// none, and sellable() then refused to sell any body armour to a character wearing none.
console.log('\nlooted armour is worn by an armed character too');
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const { readFileSync } = await import('node:fs');
  // A client with an axe worn and, in the pack, a leather armour and a shield. `wearing` adds
  // names to the use list.
  const names = { 1: 'axe', 2: 'leather armor', 3: 'small round shield', 4: 'chain armor' };
  const mk = ({ wearing = ['axe'], carrying = [1, 2, 3], economy = 'keeper', saved = [] } = {}) => {
    const ap = Object.create(Autopilot.prototype);
    ap.policy = {}; ap.tally = {}; ap.note = () => {};
    ap.protectedItemNames = () => saved;
    ap.facultyHeld = (f) => f === 'economy' && economy !== 'keeper';
    const ids = Object.keys(names).map(Number).filter(i => carrying.includes(i));
    ap.s = { client: {
      inventory: ids.map(id => ({ id, nameRsc: id })),
      using: new Set(ids.filter(id => wearing.includes(names[id]))),
      rsc: { get: (id) => names[id] },
    } };
    ap.asked = [];
    ap._wearBest = async (_s, { slots, exclude }) => { ap.asked.push(slots); ap.exclude = exclude; return { worn: slots.map(slot => ({ slot, name: slot })) }; };
    return ap;
  };

  let ap = mk();
  await ap.wearLootedArmour(['orc tooth x3', 'scimitar']);
  ok('loot with no armour in it asks for nothing', ap.asked.length === 0);
  ap = mk();
  await ap.wearLootedArmour(['leather armor x2', 'orc tooth x3']);
  ok('an armed character with an empty body and shield slot fills both',
     ap.asked.length === 1 && ap.asked[0].includes('armour') && ap.asked[0].includes('shield'),
     JSON.stringify(ap.asked));
  // THE RAID'S CASE. Chain is worn (a deliberate outfit); looted leather must not replace it.
  ap = mk({ wearing: ['axe', 'chain armor', 'small round shield'], carrying: [1, 2, 3, 4] });
  await ap.wearLootedArmour(['leather armor']);
  ok('a worn slot is never swapped, even for a better-ranked piece', ap.asked.length === 0,
     JSON.stringify(ap.asked));
  ap = mk({ economy: 'fleetscript/ghost-raid' });
  await ap.wearLootedArmour(['leather armor']);
  ok('under an economy lease (a raid) it stands down entirely', ap.asked.length === 0);
  ap = mk();
  await ap.wearLootedArmour(undefined);
  ok('no loot at all is not an error', ap.asked.length === 0);

  // SAVED STOCK IS NOT WORN. Operator: "wear the leather and shields ... if they aren't being
  // saved". Leather on the protect list leaves the body slot alone; the shield still goes on.
  ap = mk({ saved: ['orc tooth', 'leather armor'] });
  await ap.wearIntoEmptySlots();
  ok('a saved leather armour does not fill the body slot, the unsaved shield does',
     ap.asked.length === 1 && !ap.asked[0].includes('armour') && ap.asked[0].includes('shield'),
     JSON.stringify(ap.asked));
  ok('...and wearBest is handed the same exclusion, so it cannot pick the saved piece',
     typeof ap.exclude === 'function' && ap.exclude('leather armor') && !ap.exclude('small round shield'));
  ap = mk({ saved: ['leather armor', 'small round shield'] });
  await ap.wearIntoEmptySlots();
  ok('everything saved: nothing is worn and nothing is sent', ap.asked.length === 0);
  // A SPARE ALREADY ABOARD, with no loot event at all — the farm pass's own clock.
  ap = mk();
  await ap.wearIntoEmptySlots();
  ok('a spare already in the pack is worn without a loot event', ap.asked.length === 1);
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('both loot sites call it', (AP.match(/await this\.wearLootedArmour\(looted\);/g) ?? []).length >= 2);
  ok('the farm pass dresses from the pack on a one-minute clock',
     /this\.mode === 'farm' && Date\.now\(\) - \(this\.dressedAt \?\? 0\) > 60_000[\s\S]{0,200}wearIntoEmptySlots/.test(AP));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
