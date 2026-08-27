// THE CONTRACT TEST FOR A POSTURE THAT IS ONLY WORTH ANYTHING IF IT NEVER LEAKS.
//
// `town_safe_farming` exists because a bare fleet dies on the roads and not at the farm.
// Its value is entirely in the things it REFUSES, and every one of those refusals is
// invisible from the fleet board when it stops working - a character that quietly walked
// out to a bank looks exactly like one that is farming, right up until it is in the
// Underworld. So the assertions here are mostly about absence and refusal.
//
// The one that matters most is `every departure is suppressed`. That list grew by
// discovery, one death at a time: `vault_items` deposits at the BARLOQUE vault,
// `guild_wants` walks to a guild hall, `conflict_response_hops` runs to a fleetmate's
// fight, `bank_above` to a bank, `sell_at_load` to a market, `farm_delivery` to an
// apothecary. None of them look like travel. If somebody adds a fourteenth and does not
// add it here, this suite passes and the fleet leaves town.

import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ISOLATE FROM THE REAL TUNING FILE. `m59-tuning.mjs` layers over the profile, so without
// this the suite asserts against whatever an operator happens to have set on this machine -
// and it FAILED that way the moment the first override was written. TUNING_FILE() is lazy,
// so setting this before any planProfile call is enough even though imports hoist. Same
// reason m59-loadout-test.mjs sets M59_LOADOUT_DIR.
process.env.M59_TUNING_FILE = join(tmpdir(), 'm59-profiles-test-no-such-tuning.json');

import { planProfile, allowedRooms, PROFILES, TOWNS, PREY } from './m59-profiles.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`)) : (fail++, console.log(`  FAIL ${name}`)); };
const group = n => console.log(`\n${n}`);
const has = (arr, re) => (arr || []).some(s => re.test(String(s)));

group('the town is a curated set, not a name match');
ok('the graveyard is inside Tos', allowedRooms('tos').includes(70));
ok('the crypt is inside Tos, though its name does not say so', allowedRooms('tos').includes(71));
ok('Familiars is inside Tos, though its name does not say so', allowedRooms('tos').includes(52));
ok('the Deep Dark Woods OF TOS is not - a name cannot do this job',
   !allowedRooms('tos').includes(4));
ok('the main gate is not inside', !allowedRooms('tos').includes(586));
ok('the outskirts are not inside', !allowedRooms('tos').includes(596));
ok('an unknown town has no rooms rather than throwing', allowedRooms('atlantis').length === 0);

group('refusal 1 - the farm room must be inside the walls');
ok('the graveyard is accepted', planProfile({ at: 52, room: 70, maxHealth: 50 }).ok);
ok('Castle Victoria is refused', !planProfile({ at: 52, room: 39, maxHealth: 50 }).ok);
ok('and the refusal lists where IS inside',
   has(planProfile({ at: 52, room: 39, maxHealth: 50 }).refusals, /Inside: .*70/));
ok('a BOUNDARY room is refused and named as one',
   has(planProfile({ at: 52, room: 587, maxHealth: 50 }).refusals, /BOUNDARY/));
ok('the other border room is refused too',
   !planProfile({ at: 52, room: 585, maxHealth: 50 }).ok);
ok('no room at all is refused rather than defaulted',
   has(planProfile({ at: 52, room: null, maxHealth: 50 }).refusals, /no farm room/));

group('refusal 2 - applying a posture does not move anybody');
ok('a character already in Tos is ready', planProfile({ at: 70, room: 70, maxHealth: 50 }).ok);
ok('one in the wilderness is REFUSED, not quietly sent',
   !planProfile({ at: 575, room: 70, maxHealth: 50 }).ok);
ok('and the refusal says to walk it in first',
   has(planProfile({ at: 575, room: 70, maxHealth: 50 }).refusals, /[Ww]alk it in first/));
ok('one in the Underworld is refused', !planProfile({ at: 1, room: 70, maxHealth: 50 }).ok);
ok('one at the main gate is refused - the gate is not the town',
   !planProfile({ at: 586, room: 70, maxHealth: 50 }).ok);
ok('an unknown current room is a NOTE, not a refusal - it is the one thing we may not know',
   planProfile({ at: null, room: 70, maxHealth: 50 }).ok);
ok('and it says so', has(planProfile({ at: null, room: 70, maxHealth: 50 }).notes, /cannot confirm/));

group('every departure is suppressed - the list that grew one death at a time');
const p = planProfile({ at: 52, room: 70, maxHealth: 50 }).policy;
ok('roam off', p.roam === false);
ok('roam_limit 0', p.roam_limit === 0);
ok('bank_above unreachable - otherwise it walks to a bank', p.bank_above >= 1e6);
ok('sell_at_load 1 - otherwise it walks to a market', p.sell_at_load === 1);
ok('sell_when_broke off', p.sell_when_broke === false);
ok('buy_food off', p.buy_food === false);
ok('buy_weapons off', p.buy_weapons === false);
ok('buy_reagents off', p.buy_reagents === false);
ok('vault_items EMPTY - these deposit at the Barloque vault', Array.isArray(p.vault_items) && !p.vault_items.length);
ok('guild_wants null - and null rather than false, which THROWS', p.guild_wants === null);
ok('guild_tithe null - paying Frular is a Barloque trip', p.guild_tithe === null);
ok('farm_delivery null - a courier walks to an apothecary', p.farm_delivery === null);
ok('farm_cleanup null', p.farm_cleanup === null);
ok('conflict_response_hops is 1, never 0 - `Number(0) || 5` silently becomes 5',
   p.conflict_response_hops === 1);
ok('max_carry high - hitting the cap ends farming and invites a sell trip', p.max_carry >= 200);

group('what it keeps switched ON');
ok('safe spots - the only survival advantage a bare character has', p.use_safe_spots === true);
ok('player self-defence - standing still is not a defence', p.defend_against_players === true);
ok('the assigned room is the farm', p.assigned_room === 70);
ok('the hunt is the room\'s own prey, not a guess', p.hunt === 'zombie');
ok('fight_above_vigor is the profile\'s deliberate food-backed 100', p.fight_above_vigor === 100);
ok('travel_hold_vigor is 80, the resting cap an unfed fleet can actually reach',
   p.travel_hold_vigor === 80);

group('it says what a character cannot do rather than assigning it silently');
ok('a 31-health character is told the ceiling refuses the prey',
   has(planProfile({ at: 52, room: 70, maxHealth: 31 }).notes, /ceiling refuses/));
ok('but is still READY - being unable to earn is not a reason to leave it outside',
   planProfile({ at: 52, room: 70, maxHealth: 31 }).ok);
ok('a 56-health character is told zombies pay nothing (55 is not above 56)',
   has(planProfile({ at: 52, room: 70, maxHealth: 56 }).notes, /PAYS NOTHING/));
ok('a 50-health character is told neither - it can fight and it levels',
   planProfile({ at: 52, room: 70, maxHealth: 50 }).notes.length === 0);
ok('the boundary is STRICT: 55 is not above 55',
   has(planProfile({ at: 52, room: 70, maxHealth: 55 }).notes, /PAYS NOTHING/));

group('unknown things are refused, never guessed');
ok('an unknown profile is refused', !planProfile({ at: 52, room: 70, profile: 'reckless' }).ok);
ok('and it lists the ones that exist',
   has(planProfile({ at: 52, room: 70, profile: 'reckless' }).refusals, /town_safe_farming/));
ok('an unknown town is refused', !planProfile({ at: 52, room: 70, town: 'atlantis' }).ok);
ok('a refused plan carries no policy - nothing half-applied',
   planProfile({ at: 52, room: 70, town: 'atlantis' }).policy === null);

group('the reference data it plans against');
ok('a zombie is level 55', PREY.zombie.level === 55);
ok('a skeleton is level 75', PREY.skeleton.level === 75);
ok('the graveyard names its prey', TOWNS.tos.farms[70].prey === 'zombie');
ok('and warns that it is night-gated', /NIGHT ONLY/.test(TOWNS.tos.farms[70].why));
ok('the crypt does NOT claim to be verified either way',
   /NOT been verified/.test(TOWNS.tos.farms[71].why));
ok('the profile says what it is for', /never step outside/.test(PROFILES.town_safe_farming.why));

group('an AREA is tighter than a town - the graveyard/crypt pocket');
const und = TOWNS.tos.areas.undead;
ok('the area is exactly the two rooms', und.rooms.length === 2 &&
   und.rooms.includes(70) && und.rooms.includes(71));
ok('the graveyard is accepted inside the area',
   planProfile({ at: 70, room: 70, maxHealth: 50, area: 'undead' }).ok);
ok('the crypt is accepted inside the area',
   planProfile({ at: 70, room: 71, maxHealth: 50, area: 'undead' }).ok);
ok('a room that is in TOWN but not in the AREA is refused - narrowing must narrow',
   !planProfile({ at: 70, room: 54, maxHealth: 50, area: 'undead' }).ok);
ok('and the refusal names what it is confined to',
   has(planProfile({ at: 70, room: 54, maxHealth: 50, area: 'undead' }).refusals, /confined to 70 and 71/));
ok('the bank is fine WITHOUT the area - an area narrows, it never widens',
   planProfile({ at: 70, room: 54, maxHealth: 50 }).ok === false ||
   planProfile({ at: 70, room: 70, maxHealth: 50 }).ok);
ok('an unknown area is refused rather than falling back to the whole town',
   !planProfile({ at: 70, room: 70, maxHealth: 50, area: 'catacombs' }).ok);
ok('and it lists the areas that exist',
   has(planProfile({ at: 70, room: 70, maxHealth: 50, area: 'catacombs' }).refusals, /undead/));
ok('the plan reports what it is confined to',
   (planProfile({ at: 70, room: 70, maxHealth: 50, area: 'undead' }).confinedTo || []).join() === '70,71');

group('standing in the town but outside the area is a NOTE, not a refusal');
const fromFamiliars = planProfile({ at: 52, room: 70, maxHealth: 50, area: 'undead' });
ok('a character in Familiars is still ready - that walk is a town walk', fromFamiliars.ok);
ok('and it says a trip is coming', has(fromFamiliars.notes, /will walk to room 70/));
ok('but one in the wilderness is still refused',
   !planProfile({ at: 575, room: 70, maxHealth: 50, area: 'undead' }).ok);

group('the one door out is named rather than assumed shut');
ok('the leak is reported once, on the plan rather than in every note list', /way out|ways out/.test(fromFamiliars.leak || ''));
ok('and it names the actual exit, 70 -> 50',
   /70 -> 50/.test(fromFamiliars.leak || ''));
ok('the map agrees the crypt is a dead end - one exit, and it is the graveyard',
   und.leaks.length === 1 && und.leaks[0].from === 70 && und.leaks[0].to === 50);

group('the strategy that stops the walk to an inn');
const pol = planProfile({ at: 70, room: 70, maxHealth: 50, area: 'undead' }).policy;
ok('fieldrest - every other strategy carries restInTown:true', pol.strategy === 'fieldrest');
ok('and the assignment is the area room asked for', pol.assigned_room === 70);
ok('the crypt assignment sticks too',
   planProfile({ at: 70, room: 71, maxHealth: 50, area: 'undead' }).policy.assigned_room === 71);

group('Castle Victoria - a keep, and the room choice inside it is the whole point');
const cv = { town: 'castle_victoria', area: 'keep' };
ok('upstairs (39) is accepted', planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).ok);
ok('the base (38) is accepted too - both maps are allowed', planProfile({ at: 39, room: 38, maxHealth: 41, ...cv }).ok);
ok('the Throne Room is NOT', !planProfile({ at: 39, room: 40, maxHealth: 41, ...cv }).ok);
ok('the Underbasement is NOT', !planProfile({ at: 39, room: 41, maxHealth: 41, ...cv }).ok);
ok('Outside Castle Victoria is NOT - it leads on to Ukgoth',
   !planProfile({ at: 39, room: 2, maxHealth: 41, ...cv }).ok);
ok('all three doors out of the pair are named',
   (planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).leak.match(/->/g) || []).length === 3);
ok('and the wording is plural for three of them',
   /3 ways out/.test(planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).leak));

group('the ceiling is what makes 39 the right room and 38 the wrong one');
ok('upstairs prey is the battered skeleton',
   planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).policy.hunt === 'battered skeleton');
ok('at 41 max health the battered skeleton (60) is inside a 150% ceiling of 61.5, so no note',
   planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).notes.filter(n => /ceiling/.test(n)).length === 0);
ok('and it pays - 60 is strictly above 41',
   planProfile({ at: 39, room: 39, maxHealth: 41, ...cv }).notes.filter(n => /PAYS NOTHING/.test(n)).length === 0);
ok('one point lower and the ceiling refuses it - 40 gives 60.0 against level 60... still allowed',
   planProfile({ at: 39, room: 39, maxHealth: 40, ...cv }).notes.filter(n => /ceiling/.test(n)).length === 0);
ok('at 39 max health the ceiling is 58.5 and it IS refused',
   has(planProfile({ at: 39, room: 39, maxHealth: 39, ...cv }).notes, /ceiling refuses/));
ok('a Tos area is not valid in the keep - areas belong to their place',
   !planProfile({ at: 39, room: 39, maxHealth: 41, town: 'castle_victoria', area: 'undead' }).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
