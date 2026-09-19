#!/usr/bin/env node
// A WEAPON IT MAY NEVER HOLD GOES OVERBOARD FIRST.
// Offline: no broker, no socket, no roster, no fleet.
//
// ======================== THE CLAIM THIS SUITE EXISTS TO PIN ========================
//
// `makeRoom` ranks the pack and sheds from the front. The order was:
//
//     -1    on the loadout's explicit sell list      (an instruction)
//     -0.5  surplus food
//      0    sell-fodder, nothing has an opinion
//      1    a crewmate wants it
//      2    our own reagents, still short
//      3    the loadout protects it
//
// A BANNED WEAPON SCORED 0 — the same as any other loot — despite being the only thing in
// the pack with NO possible use to its holder. `equipBest` refuses it on every pass for as
// long as it is aboard, and it costs a second time: `bannedConjurablesHeld()` counts it, and
// at three `create weapon` declines. So the pack fills with weapons the character cannot
// wield, and the spell that would give it one it CAN wield is switched off by their presence.
//
// MEASURED ON PROD 2026-09-19. Beaker: 25 mana, unarmed, refusing to conjure, holding two
// hammers and an axe — all three banned, NONE of them conjured. The operator identified them
// as orc drops and corrected the diagnosis: "Beaker is not hoarding conjured weapons, they're
// scimitars dropped by orcs, and they're supposed to be prioritized to be dropped based on
// our loot preferences."
//
// The gate itself is not wrong — three unusable weapons is three reasons not to add a fourth
// — but it counted by NAME, so an orc's hammer counted exactly like a conjured one, and the
// decline sentence said "conjured" about loot. Both are fixed: the ranking sheds them first
// so the condition clears itself, and the sentence says what was actually counted.
import { Autopilot } from './m59-autopilot.mjs';
import * as skills from './m59-skills.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// Beaker's real ban list, copied from the live keeper rather than invented.
const BANNED = ['mace', 'club', 'dagger', 'hammer', 'axe', 'long sword', 'scimitar',
                'mystic sword', 'nerudite sword', 'gold sword', 'black dagger', 'bow', 'crossbow'];

const rig = (banned = BANNED) => ({ bannedWeaponsNow: () => banned });
const useless = (name, banned) =>
  Autopilot.prototype.bannedWeaponUseless.call(rig(banned), name);

console.log('\nWHAT COUNTS AS UNUSABLE: THE BAN, NOT WHO MADE IT');
{
  ok('a banned hammer is useless to this character', useless('hammer') === true);
  ok('a banned axe too', useless('axe') === true);
  ok('and a banned scimitar — the operator\'s own example', useless('scimitar') === true);
  // Provenance is deliberately NOT consulted. An orc's hammer and a conjured one are refused
  // by `equipBest` identically, so they are dead weight identically.
  ok('a conjured one is no different — the ban is the whole test', useless('long sword') === true);
}

console.log('\nAND IT MUST NOT SWALLOW THINGS THAT ARE NOT WEAPONS');
{
  // The ban list is matched by substring, so the weapon test is what stops a name fragment
  // catching a bystander. `weaponScore` is the repository's own answer to "is this a weapon".
  ok('a shield is not a banned weapon', useless('small round shield') === false);
  ok('nor is armour', useless('leather armor') === false);
  ok('nor food', useless('loaf of bread') === false);
  ok('nor a reagent', useless('elderberry') === false);
  ok('nor a gem', useless('emerald') === false);
  // The control that makes the above mean something: weaponScore really does separate them.
  ok('weaponScore agrees a hammer is a weapon and bread is not',
     skills.weaponScore('hammer') > 0 && !(skills.weaponScore('loaf of bread') > 0));
}

console.log('\nAN UNBANNED WEAPON IS ORDINARY LOOT, NOT JUNK');
{
  ok('a short sword this character MAY hold is not useless',
     useless('short sword') === false,
     'it is sellable loot and must keep its ordinary rank');
  ok('and with no ban list at all, nothing is useless', useless('hammer', []) === false);
  ok('a null ban list is not a ban on everything', useless('hammer', null) === false);
}

console.log('\nTHE RANK ITSELF, READ OUT OF THE RANKING FUNCTION');
{
  // NOT CONSTANTS I DECLARED HERE. The first draft of this section asserted -0.75 < 0 against
  // numbers written at the top of the file, which is arithmetic rather than a test — it would
  // have passed with the production ranking deleted. These are read out of `makeRoom`.
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async makeRoom()'), src.indexOf('async makeRoom()') + 14000);
  // NaN when a pattern does not match, so a slice that is too short FAILS rather than
  // quietly comparing nothing — the first cut was 9000 chars and the sell-fodder line
  // sits at 9056.
  const num = (re) => { const m = re.exec(fn); return m ? Number(m[1]) : NaN; };
  const bannedRank  = num(/bannedWeaponUseless[^)]*\)[^)]*\)\s*return\s*(-?[0-9.]+)/);
  const foodRank    = num(/surplus\?\.id === o\.id\)\s*return\s*(-?[0-9.]+)/);
  const fodderRank  = num(/return\s*(-?[0-9.]+);.*sell-fodder/);
  ok('the ranking really consults the predicate', Number.isFinite(bannedRank), String(bannedRank));
  ok('a banned weapon goes before ordinary sell-fodder',
     Number.isFinite(fodderRank) && bannedRank < fodderRank, bannedRank + ' vs ' + fodderRank);
  ok('and before surplus food, which is at least edible',
     Number.isFinite(foodRank) && bannedRank < foodRank, bannedRank + ' vs ' + foodRank);
  // The loadout's explicit sell list is -1 and must still outrank this: an instruction beats
  // an inference. Asserted against the DOCUMENTED value in dropRank rather than re-derived.
  ok('but AFTER what the loadout explicitly named for selling', bannedRank > -1,
     'that list is an instruction; this is an inference');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
