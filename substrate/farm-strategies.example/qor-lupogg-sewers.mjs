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
//     weapon, -20% to acid: acid touch is the attack. Drops 2-5 items from TID_VERY_TOUGH (sapphire,
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
  describe: 'Barloque sewers 111/112: lupoggs with acid touch for evil karma and gems; rats spared and lured out of the way.',

  hunt: ['lupogg'],
  spare: ['giant rat'],
  spareBlockers: 'provoke',

  weapons: {
    touchSpell: 'acid touch',
    touchSpellTiming: 'on_target',
  },

  confine: {
    station: STATION,
    rooms: [108, 111, 112],
    roam: false,
  },

  // Acid touch eats one entroot berry a cast (acidtch.kod); the rest is what a lupogg is worth.
  protect: ['entroot berry', 'sapphire', 'diamond', 'ruby', 'blue dragon scale', 'dark angel feather',
            'inky-cap mushroom', 'purple mushroom', 'blue mushroom'],

  hooks: {
    onPass(ctx) {
      const berries = ctx.pack().filter(i => /entroot berr/i.test(i.name)).reduce((n, i) => n + i.amount, 0);
      if (berries < 5) ctx.note('entroot berries running low: acid touch stops with them', { berries });
    },
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
