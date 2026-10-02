// FARMING STRATEGY (EXAMPLE): the Castle Victoria undead — skeletons and zombies upstairs.
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, then:
//
//   autopilot action=start agent=t4 mode=farm farm_strategy=cv-skeletons
//
// The order it expresses: the standing Castle Victoria farm. Upstairs (39) generates battered
// skeletons (60%, level 60) and zombies (40%, level 55); the room is SPLIT and its only bridge runs
// through 38, which adds the plain skeleton (level 75), so the confinement is [39, 38] — a [39]-only
// confinement refuses the bridge and strands half the room (docs: the 2026-08-27 crowd).
//
// The weapon is the point. The whole skeleton family resists thrust and pierce 70% and takes 20%
// EXTRA from bludgeon (skel.kod SetResistances); zombies resist nothing physical. So hammers and
// maces first, and never a short sword against a skeleton. The keeper already prepends hammer/mace
// against a skeleton target (weaponPriorityNow); this file makes it the standing order and bans
// nothing — a ban is what once defeated that switch (memory: skeletons-resist-thrust).

export default {
  name: 'cv-skeletons',
  describe: 'Castle Victoria 39/38: battered skeletons, then zombies; blunt weapons first.',

  hunt: ['battered skeleton', 'skeleton', 'zombie'],
  // The skeletons pay more per kill (level 60/75 against 55); a zombie is still a fine fallback.
  huntPriority: ['battered skeleton', 'skeleton', 'zombie'],

  weapons: {
    priority: ['hammer', 'mace'],
  },

  confine: {
    rooms: [39, 38],
    station: 39,
    roam: false,
  },

  hooks: {
    // Task-specific: a landed swing with a thrusting weapon on a skeleton is a 70% waste that no log
    // line says out loud. Count them and say so, so a character that kept its short sword in hand is
    // visible on the first pass rather than in a week's kill rate.
    onCombatLine(ctx, line) {
      const p = line.parsed;
      if (p?.kind !== 'my-swing' || !p.landed || !p.weapon) return;
      if (!/skeleton/i.test(p.other ?? '')) return;
      if (!/sword|dagger|spear|scimitar|rapier/i.test(p.weapon)) return;
      ctx.memory.thrusts = (ctx.memory.thrusts ?? 0) + 1;
      ctx.note('thrusting at a skeleton (70% resisted)', { weapon: p.weapon, count: ctx.memory.thrusts });
    },
  },
};
