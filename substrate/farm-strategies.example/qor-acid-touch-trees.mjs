// FARMING STRATEGY (EXAMPLE): train acid touch on the living trees of the Forest of Farol.
//
// THE SHAPE, COMMITTED. To use it, copy it into substrate/farm-strategies/ (gitignored: a strategy
// is an order to a character, and orders are this machine's), then:
//
//   autopilot action=start agent=t9 mode=farm farm_strategy=qor-acid-touch-trees
//
// The order it expresses (operator, 2026-10-02): Camilla (t9), a Qor disciple, builds acid touch by
// hitting living trees in 536 with an empty hand and the touch buff on. Everything about HOW a
// touch spell is trained — the empty hand, the self-cast at our own object id, reading "Your acid
// touch ..." against "Your punch ...", the start/stop lines, recasting when the next tree is chosen —
// is the keeper's central support (tools/m59-touchspell.mjs). This file only says WHICH spell, WHAT
// to hit and WHERE. It cannot say when to flee or rest; those stay with the keeper.
//
// Spiders are 70% of 536's table (substrate/m59-spawns.json) and are not hunted here: a Qor caster
// will not kill them for the karma. They still fight back, and the keeper's survival ladder answers
// that exactly as it would without this file.

export default {
  name: 'qor-acid-touch-trees',
  describe: 'Acid touch training: bare hands, the touch buff kept on, living trees only, in 536.',

  hunt: 'living tree',

  weapons: {
    touchSpell: 'acid touch',
    // Cast when the next tree is chosen, not in the opening round (the default; said for clarity).
    touchSpellTiming: 'on_target',
    // No `style` or `banned` here: with a touch spell set, the keeper itself keeps the hand empty on
    // the station and arms normally off it (the road is no place to be bare-handed).
  },

  confine: {
    station: 536,         // the touch posture applies on the station room only
    roam: false,
  },

  // One entroot berry per cast (acidtch.kod:89-94): never sell or shed them.
  protect: ['entroot berry'],

  hooks: {
    // Task-specific: say so, once a minute at most, when the berries that feed the touch run low.
    // The keeper already reports a cast it cannot afford (touch_spell.blocked_reason); this warns
    // BEFORE that, while there is still time to send supplies.
    onPass(ctx) {
      const berries = ctx.pack().filter(i => /entroot berr/i.test(i.name)).reduce((n, i) => n + i.amount, 0);
      if (berries < 5) ctx.note('entroot berries running low', { berries, casts_left: berries });
    },
    // Count what the touch has killed, for the note above and for whoever reads the status.
    onKill(ctx, kill) {
      ctx.memory.kills = (ctx.memory.kills ?? 0) + 1;
      if (ctx.memory.kills % 25 === 0) ctx.note('trees killed this load', { kills: ctx.memory.kills, last: kill.creature });
    },
  },
};
