// FARMING STRATEGY (EXAMPLE): living trees for wands and berries in Faronath, spiders first.
//
// THE SHAPE, COMMITTED. Copy into substrate/farm-strategies/ to use it, then:
//
//   autopilot action=start agent=t1 mode=farm farm_strategy=wand-farmer-spiders-first
//
// The order it expresses (operator, 2026-10-02): Kermit (t1) farms Faronath (537) for the wands and
// entroot berries the living trees drop, and "should probably actually prioritize spiders when
// farming ... since all the Qor casters can't/won't kill them because of the karma effect" — "but not
// bother with their loot except purple mushrooms".
//
// Each line is a central primitive with its own module and tests: `huntPriority` reorders the hunt
// SET and never widens it or skips a safety gate (m59-hunt-priority.mjs); `lootOnly` takes only the
// named items from a spider's drop, attributed by novelty (m59-loot-filter.mjs); `protect` keeps
// what the trip is for out of every sell and shed.

export default {
  name: 'wand-farmer-spiders-first',
  describe: 'Faronath 537: spiders before trees; from a spider take only purple mushrooms; keep wands and berries.',

  hunt: ['spider', 'living tree'],
  huntPriority: ['spider', 'living tree'],

  lootOnly: { spider: ['purple mushroom'] },
  protect: ['wand', 'entroot berry'],

  confine: {
    station: 537,
    roam: false,
  },

  hooks: {
    // Task-specific bookkeeping: what each kind of kill was worth, so "are the spiders paying for
    // the detour" has an answer in the journal rather than a guess.
    onKill(ctx, kill) {
      const k = String(kill.creature ?? 'unknown').toLowerCase();
      const tally = (ctx.memory.kills ??= {});
      tally[k] = (tally[k] ?? 0) + 1;
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      if (total % 20 === 0) ctx.note('kills by creature this load', { ...tally });
    },
  },
};
