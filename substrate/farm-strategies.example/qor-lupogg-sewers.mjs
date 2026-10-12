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
  describe: 'Barloque sewers 111/112: lupoggs with conjured axes and a shield, for evil karma and gems; rats spared and lured out of the way.',

  hunt: ['lupogg'],
  spare: ['giant rat'],
  spareBlockers: 'provoke',

  // AXES, NOT ACID TOUCH (operator, 2026-10-11: "switch them over to use axes (from create weapon roulette)
  // and shields and leather armor, because we need them high defense"). A touch spell needs an empty hand;
  // an axe leaves the shield on. Axes slash, and a lupogg takes -10 from slash. The armed training style
  // holds the training weapon, and while axe wielding is under 70 the keeper conjures one with create
  // weapon (Kraanan; every Qor master here knows it, 89-99) rather than buying. The shield and the leather
  // armour are each character's loadout (gear.slots), not this file's: a strategy cannot dress anybody.
  //
  // AXE ONLY, AND NO TOUCH SPELL (operator, 2026-10-11: "we want lupoggs hunted with axes for the damage
  // type slash"). Janice carried a hammer at 70 and was re-armed with it; `trainingWeaponOnly` makes the
  // axe the only weapon any equip may choose. And a character's own `touchSpell` order outlives the
  // strategy that set it -- Janice, Beaker and Camilla still carried `acid touch`, which empties the
  // hand on the station -- so this file says null, and while it is assigned null is in force.
  weapons: {
    style: 'short_sword',
    trainingWeapon: 'axe',
    trainingWeaponOnly: true,
    priority: ['axe'],
    touchSpell: null,
  },

  confine: {
    station: STATION,
    rooms: [108, 111, 112],
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
  protect: ['inky-cap mushroom', 'sapphire', 'ruby', 'diamond', 'dark angel feather', 'purple mushroom',
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
