// FARMING STRATEGY (EXAMPLE): an ARCHER at the needle in 2143 Deep in the Jungle (Ko'catan).
//
// The twin of deep-jungle-needle.mjs (read its header): same room, quarry and confinement; the bow and nothing else,
// because a melee swing zeroes the 75-attempt archery block (player.kod:4753-4757); and needle.role 'archer'. An archer
// holds one of the site's stations (r34c41 first: no monster square can see it, and it sees the tip, so every shot
// counts toward archery), shoots the closest valid monster in bow reach, and -- if it holds the front station -- steps
// to the pull square (r30c43) after the tip has been quiet for 15 s, shoots once, and steps back. Out of arrows or bow,
// it hands the pass back to ordinary farming, where the normal restock (the island coordinator, the town trip) answers;
// restocked, it walks back to its station by itself.
import striker from './deep-jungle-needle.mjs';

const MELEE = ['sword', 'axe', 'hammer', 'mace', 'scimitar', 'dagger', 'club', 'staff', 'spear', 'knife', 'flail', 'crossbow'];

export default {
  ...striker,
  name: 'deep-jungle-needle-archer',
  describe: "Ko'catan 2143: one of the needle's archers; the bow and nothing else.",
  weapons: { priority: ['practice bow', 'longbow', 'battle bow', 'bow'], banned: MELEE },
  needle: { site: 'deep-jungle-2143', role: 'archer' },
};
