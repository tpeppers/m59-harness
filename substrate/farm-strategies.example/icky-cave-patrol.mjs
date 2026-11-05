// FARMING STRATEGY (EXAMPLE): patrol the Icky Cave (27) spawn points, killing orcs and spiders.
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, then, per character:
//
//   autopilot action=start agent=t21 mode=farm farm_strategy=icky-cave-patrol
//   node tools/m59-patrol-farm.mjs check --strategy icky-cave-patrol       every leg, proved offline
//
// The order (operator, 2026-11-04): "walk across all the various spawn locations and kill any monsters seen
// ... those are the rails I'd have it take in an infinite loop, killing everything it comes across ... I'd
// like to see if you can get its kills/30m as high as a human player like mine." His loop, confirmed as ROW,
// COL squares: r23c53 -> r35c58 -> r31c31 / r32c35 (one stop: his rail starts one square off) -> r51c14 ->
// r50c34 -> back to r23c53. That last leg was the one "missing from the bake": the pocket round r23c53 (rows
// 17-34, cols 45-56, two of the room's generators) is entered by a running drop over the row-35 trench,
// r36c46 -> r34c46, now declared in substrate/m59-falljumps.json and baked.
//
// Everything else is icky-cave-orc-teeth's (local orders, 2026-10-26): the room spawns orc or spider on a
// coin toss (cave2.kod plMonsters [[&Orc,50],[&Spider,50]], cap 10 at monsroom.kod), so killing both keeps
// it cycling and orcs keep dropping teeth. The patrol changes one decision only: with nothing within
// `engageWithin` squares the keeper walks the next piece of the loop instead of holding a wall. Survival,
// flee lines, the wall a fight opens from, spare / gang-up / the engagement ceiling, loot policy and any
// practice_spells pushed alongside are the keeper's, unchanged.

export default {
  name: 'icky-cave-patrol',
  describe: 'Icky Cave 27: walk the spawn-point loop for ever, killing orcs (first) and spiders met on the way.',
  hunt: ['orc', 'spider'],
  huntPriority: ['orc'],
  protect: ['orc tooth'],
  confine: { station: 27, rooms: [27], roam: false },
  patrol: {
    room: 27,
    loop: [
      { row: 23, col: 53 },   // inside the pocket (via the declared drop r36c46 -> r34c46)
      { row: 35, col: 58 },
      { row: 31, col: 31 },
      { row: 32, col: 35 },
      { row: 51, col: 14 },
      { row: 50, col: 34 },
    ],
    engageWithin: 8,          // squares; farther quarry is met by the loop
  },
  // A patrol that kills nothing is a walk. Escalate rather than circle for ever (docs/m59-strategies.md).
  floor: { kills: 4, minutes: 30 },
};
