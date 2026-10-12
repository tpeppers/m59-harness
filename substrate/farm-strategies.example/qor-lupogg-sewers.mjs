// FARMING STRATEGY (EXAMPLE): Qor casters farm lupoggs in the Barloque sewers and never kill a rat.
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, then, per character:
//
//   autopilot action=start agent=t8 mode=farm farm_strategy=qor-lupogg-sewers
//
// The keeper walks there itself (the station below), with the spare rule already in force for the road
// through 108, which is ~94% rats.
//
// The order it expresses (operator, 2026-10-11): "for our Qor masters to need to be able to walk the
// barloque sewers without fighting/killing its rats, even if they get stuck (they might need some
// special tricks to get by the rats without killing them.. maybe sometimes you have to hit them once and
// then back up so they'll chase you to stop blocking you, etc.). I'd basically like to make a script for
// the Qor masters to farm lupoggs in the Barloque sewers".
//
// WHY, FROM THE KOD:
//   * lupogg: karma +75 (lupogg.kod), so every kill moves a killer's karma toward evil -- about -5 a kill
//     from 0 on the live server, which is what a Qor caster short of a spell's karma ceiling needs
//     (L3 -30, L4 -40). Level 105, difficulty 9, ~126 hp, bites 7-10 every ~2.5s, melee only, and SLOW:
//     a chase step is ~1.6s, so a character can always walk away from one. 70% resistant to every
//     weapon (-10 to slash, -20 to acid). Drops 2-5 items from TID_VERY_TOUGH (sapphire,
//     diamond, ruby, blue dragon scale, dark angel feather, inky cap, purple and blue mushrooms) and no
//     money.
//   * giant rat: karma -20, so each kill moves a Qor's karma the WRONG way. Aggressive and fast; it bites
//     for 2-3. Spared here: never targeted, the attack packet refused (m59-spare.mjs).
//   * the rooms (barlsew*.kod, cap 25 each): 108 rat 94 / lupogg 6, 111 rat 55 / lupogg 45,
//     112 rat 20 / lupogg 80. 112 is the farm; 111 is the way in and the fallback. 108 is crossed, not
//     farmed: three one-square pipes (row 27 cols 39-41, column 47 rows 35-42, r59c34-39).
//   * a rat in a pipe is a wall (tools/fixtures/sewers-108-row27.json). `spareBlockers` is the keeper's
//     answer (`lureSparedBlocker`): back off to a refuge outside the needle so the rat follows us out;
//     'provoke' first swings once, but only when nothing is already biting us.
//
// THE DANGER IS THE LUPOGGS, NOT THE RATS: 112 at its cap holds ~20 of them, and two or three at once out-
// damage a 70-hp caster. This file cannot set the flee line (survival is the keeper's); keep these
// characters' own flee line high, and never send anyone under 60 max health (docs/GOAP-HANDOFF.md).

const STATION = 112;

export default {
  name: 'qor-lupogg-sewers',
  describe: 'Barloque sewers 111/112: lupoggs with acid touch, one at a time through the crowd, for evil karma and gems; rats spared and lured out of the way.',

  hunt: ['lupogg'],
  spare: ['giant rat'],
  spareBlockers: 'provoke',

  // ACID TOUCH (operator, 2026-10-12: "Let's switch them over to the acid"). Measured that night: a lupogg
  // resists "largest resistance plus worst weakness" (battler.kod:189 ResistanceCheck) -- an axe is 70 (every
  // weapon) - 10 (slash) = 60 resisted; acid touch is also a weapon attack (touchatk.kod:83, unarmed+punch)
  // so pays the 70 too, but acid is -20: 50 resisted, 4-8 damage that strength does not touch
  // (acidtch.kod:70-75). And Janice's acid touch is 99 against 39 in axes; in ninety seconds the axes
  // landed 3 cuts in 14 swings. One entroot berry a cast, so they are protected below. `style: 'normal'`
  // and `trainingWeaponOnly: false` override the axe orders these characters were given as their own.
  weapons: {
    touchSpell: 'acid touch',
    touchSpellTiming: 'on_target',
    style: 'normal',
    trainingWeaponOnly: false,
  },

  // KARA'HOL'S CURSE AT THE START OF EVERY FIGHT (operator, 2026-10-12: "have them use karahols curse on
  // themselves when full hp and starting attacking", and "They can log off and on if the hold starts on them
  // while they are still fighting"). +100 + 2 x power to hit for 40 + power/2 seconds against a lupogg that
  // dodged most of the swings; 2 entroot berries a cast, on top of acid touch's one -- the berries are the
  // binding supply. The curse ends in a hold; a held hunter with a lupogg in reach reconnects.
  engageBuff: { spell: "kara'hol's curse", fullHealthOnly: true, logoffOnHold: true },

  // PULL THROUGH THE CROWD (operator, 2026-10-12: "Let strategies always pull through a crowd, but have them
  // just always prefer the closest target out of the crowd that fits the criteria"). 112 sits at its cap of 25
  // with ~20 lupoggs in it, which is over the keeper's crowd line of 6 on every pass, so without this every
  // pull to the wall is refused and the hunters only ever fight what wanders to them.
  pull: { throughCrowd: true },

  // THE ROAD IN, ALWAYS (operator, 2026-10-11): "always going through via valley of ileria -> sandy shores
  // -> ocean -> sewers". On the map it is 544 Valley of Ileria -> 552 the Great Ocean -> 562 the sandy shores
  // -> 108 the sewers (the ocean lies between the valley and the shore), never Barloque's own door at 101.
  // Walked from wherever on it the character already is (Autopilot.approachLegs).
  confine: {
    station: STATION,
    rooms: [108, 111, 112],
    approach: [544, 552, 562, 108],
    roam: false,
  },

  // KEEP (operator, 2026-10-11), from the lupogg's table, verytght.kod:33+: inky caps, the gems, dark angel
  // feathers, purple mushrooms, blue dragon scales, hold wands, mystic swords, plate armor, keys and
  // earthquake scrolls. Blue mushrooms and cloak potions are still picked up, just not held back from a sale.
  //
  // A hold wand drops UNIDENTIFIED as a bare "wand" and an earthquake scroll as a bare "scroll"; their
  // icon resource ids say exactly which (m59-item-signature.mjs: HoldWand_icon_rsc, EarthquakeScroll_icon_rsc),
  // and that is how fleet scripts tell them apart (`identified_as`). The keeper's keep list matches the
  // wire NAME, so the bare words are listed too. Nothing else a lupogg drops is called "wand" or
  // "scroll", so here that keeps exactly these two.
  protect: ['entroot berry', 'inky-cap mushroom', 'sapphire', 'ruby', 'diamond', 'dark angel feather', 'purple mushroom',
            'blue dragon scale', 'wand', 'scroll', 'mystic sword', 'plate armor', 'key'],

  hooks: {
    onKill(ctx, kill) {
      const k = String(kill.creature ?? 'unknown').toLowerCase();
      const tally = (ctx.memory.kills ??= {});
      tally[k] = (tally[k] ?? 0) + 1;
      // A rat on this list means the spare rule was bypassed somewhere: say so every time.
      if (/\brat\b/.test(k)) ctx.note('A RAT DIED -- karma moved toward good', { ...tally });
      else if (tally[k] % 10 === 0) ctx.note('kills this load', { ...tally });
    },
  },
};
