// THE SHAPE OF A PRIVATE TRAVEL STRATEGY. Copy into substrate/strategies/ and edit.
//
//   cp substrate/strategies.example.mjs substrate/strategies/blink-escape.mjs
//
// THIS FILE IS BESIDE THE DIRECTORY AND MUST STAY THERE. `m59-strategies.mjs` enumerates
// every .mjs inside substrate/strategies/, so an example in there loads as a real strategy.
// The same mistake with substrate/loadouts/ once put a twenty-second character on the board.
//
// Everything here is OFF. A strategy that arrives switched on is an instruction nobody gave.
//
// ---------------------------------------------------------------------------------------
// WHAT BLINK ACTUALLY IS, from kod/object/passive/spell/blink.kod, because the strategy is
// only as good as the mechanic underneath it:
//
//   - Riija level 1, SID_BLINK, viMana = 15, viSpellExertion = 20, viCast_time = 10000.
//     TEN SECONDS of casting, standing still, wherever you happen to be.
//   - `SuccessChance` returns TRUE unconditionally — "Since Blink is a bug fix, always have
//     it succeed." The spell does not fizzle. What is uncertain is whether it HELPS.
//   - It sends @Teleport to the ROOM, which answers from `viTeleport_row` / `viTeleport_col`
//     — a fixed pair per room. 256 rooms declare one; substrate/m59-blink.json has them.
//   - room.kod:789 moves you only `if GetTeleportRow <> $ AND GetTeleportCol <> $`, and
//     blink.kod prints its success line either way. **THE MESSAGE IS NOT PROOF YOU MOVED.**
//     Read the position back. ("No error has never meant success here.")
//   - Two rooms teleport you to a DIFFERENT ROOM and say "You find yourself...elsewhere."
//     instead: the KOC Hall of Heroes and Bazman's room. A strategy that assumes it stays in
//     the room will be wrong in exactly those two.
//
// The ordinary message is "You find yourself realigned with your surroundings."
import { canBlinkOut } from '../../tools/m59-blink.mjs';

export default {
  name: 'blink-escape',
  kind: 'travel',
  // OFF. Turn it on for this machine only, once the timings below say it is worth it.
  enabled: false,
  describe: 'when a jam cannot be threaded, blink to the room’s teleport point',

  settings: {
    // Casting costs 15 and leaves nothing for anything else if we scrape the floor.
    min_mana: 25,
    // Ten seconds standing still is the whole risk. Do not start one while being hit.
    refuse_under_fire: true,
    // Bodies move. If the walk has only just gone wrong, waiting is cheaper than 10s + 15
    // mana, and the fine lane (`lanePastBodies`) has usually not been tried yet either.
    min_stuck_ms: 20_000,
    // Two rooms blink you somewhere else entirely — see the header.
    refuse_rooms: [/* RID_KOC_HALL_OF_HEROES, RID_BAZMANS_ROOM */],
  },

  /**
   * Asked when a walk has run out of ordinary answers. Return null to decline.
   *
   * ctx = { geo, room, self, goal, bodies, vitals, stuck_ms, blink, underFire }
   *
   * THE ORDER MATTERS AND IT IS CHEAPEST-FIRST. Blink is the last resort, after the wait,
   * the lane and the sidestep, because it costs ten seconds of standing still in a room
   * that has already proved it has something unpleasant in it.
   */
  async whenStuck(ctx) {
    const s = this.settings;
    if (ctx.stuck_ms < s.min_stuck_ms) return null;
    if (s.refuse_under_fire && ctx.underFire) return null;
    if ((ctx.vitals?.mana ?? 0) < s.min_mana) return null;
    if (s.refuse_rooms.includes(Number(ctx.room?.num))) return null;
    if (!ctx.blink) return null;

    // THE WHOLE PREDICATE. True only when the goal is unreachable from here with the bodies
    // where they are, AND reachable from the blink point with those same bodies where they
    // are. Without the second half this fires into a blink point on OUR side of the jam,
    // which is the half of the time the operator expects it to be useless — and it is worse
    // than useless: a wasted cast and ten seconds standing in the open.
    const verdict = canBlinkOut({
      geo: ctx.geo, blink: ctx.blink, from: ctx.self, goal: ctx.goal,
      bodies: ctx.bodies, rows: ctx.room.rows, cols: ctx.room.cols,
    });
    if (!verdict.can) return null;

    // Run somewhere the caster will not be interrupted FIRST, and it has to be a spot the
    // traffic does not block — the point of this is that the direct way is blocked.
    return { do: 'blink', why: verdict.why, need_safe_spot: true,
             verify: 'read the position back; the success line prints either way' };
  },
};

// ---------------------------------------------------------------------------------------
// THE SECOND STRATEGY, in the same shape, in its own file. It does not wait for trouble.
//
// export default {
//   name: 'blink-race',
//   kind: 'travel',
//   enabled: false,
//   describe: 'blink first when the walk from the blink point is shorter than the crossing',
//   settings: {
//     min_mana: 25,
//     // The bar. Blink costs ten seconds of casting plus the walk from the teleport point,
//     // so it is only a saving when that total beats the median crossing by a real margin —
//     // not by a second, which is noise.
//     must_save_ms: 30_000,
//     cast_ms: 10_000,
//   },
//   async beforeCrossing(ctx) {
//     // `blink_race_to_<exit>` is measured by the private recorder, per map, per exit, per
//     // movement epoch — substrate/blink-timings/. A map with no measurement DECLINES:
//     // guessing here spends mana to arrive slower.
//     const race = ctx.timings?.[`blink_race_to_${ctx.goalExit}`];
//     if (!race || !ctx.medianCrossingMs) return null;
//     const cost = this.settings.cast_ms + race.walk_ms;
//     if (cost + this.settings.must_save_ms > ctx.medianCrossingMs) return null;
//     if ((ctx.vitals?.mana ?? 0) < this.settings.min_mana) return null;
//     return { do: 'blink', why: `blink+walk ${Math.round(cost / 1000)}s beats the ` +
//                                `${Math.round(ctx.medianCrossingMs / 1000)}s median crossing` };
//   },
// };
//
// WHERE THIS PAYS. The King's Way (575/576) is the case worth measuring: a very large map
// whose blink point is 87,59 (576) and 35,34 (575). When the exit you want is near the
// teleport point, blink crosses most of the map for ten seconds and 15 mana. When it is not,
// this must decline — which is why the timing is measured per EXIT and not per map.

// ---------------------------------------------------------------------------------------
// THE THIRD SHAPE, AND THE SECOND KIND: `kind: 'town'`, answering `atTownStop`.
//
// A travel strategy decides where a character GOES. A town strategy decides only what it
// HANDS OVER once it is already standing at a counter it chose for its own reasons — which
// is why it can be on by default while the blink pair are off: it changes no route.
//
// The arithmetic is NOT here and must not be copied here. `tools/m59-townstop.mjs` turns a
// pack plus a loadout into {sell, keep, buy, keep_fragments}, and it is committed because it
// is general — every clone of this map has packs and loadouts. What belongs in YOUR copy of
// this file is only the stance: which kinds this fleet refuses to fence, what it protects on
// top of the loadout, and when a stop is not worth making.
//
// THE INVARIANT THE MODULE EXISTS FOR: an item is never in both `sell` and `buy`. That is
// money, not tidiness — a merchant buys below what it sells, so selling something the same
// trip buys back pays the spread twice for a pack that ends identical. `neverSellsWhatItBuys`
// asserts it, and a caller should refuse a plan that fails it rather than execute half.
//
// WHAT `never_sell_kinds` MEANS, because it was got wrong once already: it protects a KIND
// outright and is NOT conditional on that item having a floor. Gating it on `min > 0` looks
// reasonable and, on a fleet whose reagent floors are all 0 — as prod's are, zeroed on
// 2026-08-27 because unsatisfiable floors re-opened a town trip for ever — it protects
// nothing at all. A setting that silently does nothing is this repository's oldest failure.
//
// export default {
//   name: 'townstop-sell-buy',
//   kind: 'town',
//   enabled: false,
//   describe: 'sell the loot, keep every reagent with a floor, buy back what is short',
//   settings: {
//     never_sell_kinds: ['reagent'],     // a KIND, never a list of names — see above
//     protect: ['inky cap', 'guild'],    // substrings, on top of the loadout
//     sell_unknown: true,                // the "everything else" half of the sentence
//     min_stack: 2,
//     min_bulk_freed: 100,               // a stop that cannot pay for itself is declined
//   },
//   async atTownStop(ctx) {
//     // ctx = { loadout, items, equipped, room, merchant, purse, bulkFree }
//     const plan = planTownStop(ctx.loadout, {
//       items: ctx.items, equipped: ctx.equipped, settings: this.settings });
//     // null means "no opinion — do what you did before", and must never be read as
//     // "sell nothing" or "sell everything". An absent loadout answers null.
//     return plan && (plan.sell.length || plan.buy.length) ? plan : null;
//   },
// };

// ---------------------------------------------------------------------------------------
// THE THIRD KIND: `kind: 'convoy'` — a GROUP question, asked on beforeCrossing.
//
// A travel strategy asks "how do I get through". A convoy strategy asks "should we all go
// now", and the difference is why it is a separate kind rather than another travel one: the
// solo mover must never consult it, and an operator must be able to see at a glance whether
// the fleet is currently moving as a group.
//
// The observing half is committed in tools/m59-vanguard.mjs — assessRoom() turns a keeper's
// /state into what a convoy behind it would want to know, and postScout()/readScout() carry
// it between characters. What belongs in YOUR copy is the nerve: how far ahead, how many
// creatures is too many, who is expendable, how long a report stays believed.
//
// TWO THINGS THAT LOOK LIKE THE RIGHT ANSWER AND ARE NOT:
//
//   * m59-party.report() for the channel. Every keeper is its own PROCESS, so that roster
//     Map is per-process memory and a scout would report into a void.
//   * an in-game tell for the channel. It does cross processes — the server carries it — but
//     prod is a SHARED server, and "hold, eight trolls at 578, convoy behind me" is an
//     announcement to precisely the murderers a vanguard exists to detect.
//
// AND ONE RULE: NO REPORT IS NOT "CLEAR". readScout() answers null when nobody has looked,
// and a convoy that reads that as safety has replaced a vanguard with a delay.
//
// export default {
//   name: 'convoy-vanguard',
//   kind: 'convoy',
//   enabled: false,
//   describe: 'send one character a hop ahead; the convoy crosses on its report',
//   settings: {
//     lead_hops: 1,
//     scout_by: ['mule', 'lightest', 'strongest'],   // never the most valuable character
//     trust_ms: 90_000,
//     hold_if: { capped: true, creatures_over: 6, any_flagged_aggressor: true },
//     // Hazard classes we know about and CANNOT yet see. Named so the gap is visible in the
//     // strategy that would act on them: fire/lightning/illusionary walls, webs, and the
//     // room-wide effects (heat, sandstorm, winds, jig) are not in the snapshot today.
//     unseen_hazards: ['fire wall', 'lightning wall', 'illusionary wall', 'web'],
//   },
//   async beforeCrossing(ctx) {
//     if (ctx.role === 'scout') { postScout(ctx.self, assessRoom(ctx, {...})); return null; }
//     const word = readScout(ctx.nextRoom, { staleMs: this.settings.trust_ms });
//     if (!word || word.stale) return null;            // silence is not clearance
//     return word.stuck_why ? { do: 'hold', why: word.stuck_why } : null;
//   },
// };
