// FARMING STRATEGY (EXAMPLE): the STRIKER at the needle in 2143 Deep in the Jungle (Ko'catan).
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, with its site file
// substrate/needles.example/deep-jungle-2143.json copied into substrate/needles/, then, per character:
//
//   autopilot action=start agent=t1 mode=farm farm_strategy=deep-jungle-needle            a melee: striker or bench
//   autopilot action=start agent=t9 mode=farm farm_strategy=deep-jungle-needle-archer     a trainee: an archer station
//   node tools/m59-needle-farm.mjs check --site deep-jungle-2143                           the squares, proved offline
//   node tools/m59-needle-farm.mjs status --site deep-jungle-2143                          who holds what, now
//
// The order (operator, 2026-11-05): "a single striker stands in front of the safe-spot/choke-point and strikes at
// whatever monster stands in the front of the pack, regardless of if it changes ... the archers stand back safely and
// train their abilities ... it just becomes a killzone". The striker holds r35c42 and swings at the closest valid
// monster within its weapon's reach (3 for a thrust weapon -- carry the nerudite sword); the pack stops at r34c43 because
// on the coarse grid that square leads to r35c42 and r35c42 leads only back.
//
// Every character given THIS file is a striker CANDIDATE: the first fit one (incumbent first, then the site's
// roster.strikers order) holds the tip and the rest wait on the bench (reserve squares) to replace it. So give it to
// one or two melee, not to the whole crew. Everything a melee farmer here already did is unchanged: hunt order, loot,
// selling, survival, the flee line, resting.

export default {
  name: 'deep-jungle-needle',
  describe: "Ko'catan 2143: the needle's striker (or its bench), avar shamans first.",
  // The two avar tribes' names in full, as kocatan-avar-village has them (m59-spawns 2143: warrior 80%, shaman 18%,
  // chieftain 2%, cap 12). Shamans first: they cast the Sandstorm.
  hunt: ['peet-seeeep avar shaman', 'kyip-kyip-kreeet avar shaman', 'peet-seeeep avar warrior', 'kyip-kyip-kreeet avar warrior',
         'peet-seeeep avar chieftain', 'kyip-kyip-kreeet avar chieftain'],
  huntPriority: ['peet-seeeep avar shaman', 'kyip-kyip-kreeet avar shaman'],
  confine: { rooms: [2143, 2144, 2101], station: 2143, roam: false },
  weapons: { priority: ['nerudite sword', 'long sword', 'short sword'] },
  needle: { site: 'deep-jungle-2143', role: 'striker' },
};
