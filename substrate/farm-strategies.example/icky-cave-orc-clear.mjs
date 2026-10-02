// FARMING STRATEGY (EXAMPLE): hold the Icky Cave (27) orc-free for the chalice.
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, then, per character:
//
//   autopilot action=start agent=t10 mode=farm farm_strategy=icky-cave-orc-clear
//
// The order it expresses (operator, 2026-10-02): "clear all the orcs from the cave, and specifically
// leave the spiders alive even if they attack our characters ... Camilla will come through to cast
// Dispel Illusion and take the chalice, but first we have to clear all orcs from the room, which is
// most easily done by killing all the orcs and letting the spiders spawn until there are 10 spiders,
// so that they fill the full spawn capacity for the map and no orcs can spawn".
//
// WHY IT WORKS, FROM THE KOD:
//   * cave2.kod Constructed: plMonsters = [[&Orc, 50], [&Spider, 50]] -- every spawn is a coin toss;
//   * monsroom.kod piMonster_count_max = 10 -- nothing spawns while ten monsters are alive;
//   * cave2.kod OkayToGetChalice: refuses while the illusion stands (Dispel Illusion opens it for 30s)
//     AND while ANY orc is in the room.
// So: kill every orc, never a spider, and the spiders fill the cap; then no orc can appear at all.
//
// `spare` is the keeper's own rule (m59-spare.mjs), not this file's: a spared monster is never picked
// as a target and the attack packet is refused, so even fight-back cannot kill one. Survival is
// unchanged -- a character bitten down to its flee line still walks away, it just never swings back.
//
// The hook only REPORTS. It reads the room through ctx.contents() and says when the cave is held,
// so Camilla's run knows when to come.

const CAP = 10;     // monsroom.kod piMonster_count_max

export default {
  name: 'icky-cave-orc-clear',
  describe: 'Icky Cave 27: kill every orc, never a spider, until ten spiders hold the spawn cap.',

  hunt: ['orc'],
  spare: ['spider'],

  confine: {
    station: 27,
    rooms: [27],
    roam: false,
  },

  hooks: {
    onPass(ctx) {
      if (ctx.room !== 27) return;
      const monsters = ctx.contents().filter(o => o.kind === 'monster');
      const orcs = monsters.filter(o => /\borc\b/i.test(o.name)).length;
      const spiders = monsters.filter(o => /\bspider\b/i.test(o.name)).length;
      // Held = no orc AND the room is at its cap, so nothing at all can spawn.
      const state = orcs > 0 ? 'clearing' : monsters.length >= CAP ? 'held' : 'open';
      const was = ctx.memory.state;
      ctx.memory.state = state;
      if (state === was && ctx.memory.orcs === orcs && ctx.memory.spiders === spiders) return;
      ctx.memory.orcs = orcs; ctx.memory.spiders = spiders;
      if (state === 'held')
        ctx.note('HELD: no orcs, the spawn cap is full -- no orc can spawn; ready for the chalice',
          { orcs, spiders, monsters: monsters.length, cap: CAP });
      else if (state === 'open')
        ctx.note('no orcs right now, but the cap is not full -- an orc may still spawn',
          { orcs, spiders, monsters: monsters.length, cap: CAP });
      else
        ctx.note('clearing orcs', { orcs, spiders, monsters: monsters.length, cap: CAP });
    },
  },
};
