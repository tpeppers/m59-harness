**Internal shopping and the survival decision clock — September 13, 2026**

Internal shopping can delay particular survival decisions for the duration of a travel await. It does not disable every survival mechanism. The difference comes from which operation occupies the keeper's pass loop, not from a deliberate policy saying that shopping should take more risk. This report establishes the execution difference; it does not establish that enabling the delayed decisions would reduce deaths.

The source baseline is production commit `5a84258` (the travel code loaded by the 4:34 p.m. PDT keepers was already present in `872f079`). The accompanying change replaces `rideTrack`'s separate rest implementation with the route shelter policy. It does not change the pass scheduler, `passTravelling`, its thresholds, or freeze invalidation. Source references below name methods because line numbers change between checkouts.

**Where the wait happens.** [Autopilot.loop](../tools/m59-autopilot.mjs) awaits one `pass()` before scheduling the next. During ordinary shopping, the call chain is:

```text
loop → pass → runPassStages → passErrand
     → bankRun / continueTownTrip
     → ensurePurchaseFunds or a shopping service
     → Autopilot.travel → Session.travel → movement / rest / hop hooks
```

An existing `townTrip` is explicitly awaited by `passErrand`. Its service cursor is also sequential: a stockpile visit or apothecary leg must return before the shopping service and the enclosing pass can return. `Autopilot.travel` installs the travelling hold and shelter policy, but it does not start a second execution of the ordinary survival ladder.

The restricted ladder, `passTravelling`, is called from `passUnderworld`, near the beginning of an ordinary pass. That point has already been passed when `passErrand` awaits shopping. A two-second hold timer keeps the travel lease alive; it does not execute the restricted ladder. The independent watchdog does run while the pass is awaiting I/O, but it implements narrower interventions.

**Why externally started travel can differ.** [Session.travelJob](../tools/m59-game.mjs) starts an asynchronous movement job and calls the same `Autopilot.travel`. When the ordinary keeper loop is free, subsequent passes reach `passUnderworld → passTravelling` while the movement job remains in progress. The mover and pass loop interleave on the same JavaScript event loop; there is no guarantee of a decision every second if either is delayed.

“Internal shopping versus external travel” is therefore an approximation. Internal farming journeys and `resumeSuspendedJourney` can also await travel inside the pass. An externally requested trip can encounter an already-busy pass. After an externally started journey is suspended, its keeper-driven resume can itself occupy the ordinary pass. Conversely, calling a shopping routine outside the pass does not inherently block the pass. The relevant distinction is **travel awaited by the current pass versus travel concurrent with a free pass loop**.

**What continues during the wait.** The independent watchdog still records health and position. A damaging, detected travel wedge below the character's flee threshold can cancel movement, retain the destination, and request forward shelter. Its default age threshold is four seconds after the wedge's recorded start, not a promise to rescue four seconds after the first hit. Eligibility is per journey, following the earlier fix.

The mover's own cancellation checks, movement validation, route shelter callbacks, and hop hooks continue. Both entry paths call `Autopilot.travel`, including its pre-departure recovery and `onHop → travelHold` behavior. The track change gives recorded-track stations the same shelter need/arrival policy as ordinary route shelter. The geometry and movement method still determine which refuge opportunities can be offered.

**What is delayed.** With the default guard switches, the consequential missing evaluations are the low-health panic reconnect and estimated-time-to-death panic reconnect. Optional rearming is also delayed when explicitly enabled. Their exact conditions and tradeoffs are in [the decision comparison](shopping-travel-decisions-2026-09-13.md).

There are important non-differences. The apparent mid-hop wall-cancellation rung is now largely commentary and diagnostic bookkeeping; it does not currently cancel a journey for ordinary damage. `fightBackCheck` and `clearPathCheck` both return when `this.inert` is set, including a travelling hold. Enabling another call to the current `passTravelling` does not by itself enable either watchdog combat branch. Guard names and the status field's clock labels overstate what is actually executed.

**Offline reproduction.** [shopping-survival.mjs](reproductions/shopping-survival.mjs) uses the existing fake session from `m59-survival-handoff-test.mjs`, holds the real shopping/travel chain open, and compares the real watchdog plus a real `passUnderworld` dispatch when the pass loop is free. It opens no game socket. It supplies controlled health, nearby objects, and—in the rate case—a controlled time-to-death estimate. It is a branch-execution experiment, not a combat simulator.

```text
node docs/reproductions/shopping-survival.mjs
```

| Controlled situation | Shopping occupying the pass | Travel with a free pass |
|---|---|---|
| Health 20/50, nearby monster, no wedge | 0 restricted-ladder calls; keeps travelling | 1 call; cancels movement, freezes, retains destination |
| Health 40/50, estimated life 5 seconds, no nearby object | 0 calls; keeps travelling | 1 call; cancels, freezes, retains destination |
| Health 20/50, nearby non-fleet player, no wedge | 0 calls; keeps travelling | 1 call; cancels, freezes, clears suspended destination |
| Health 40/50, nearby monster, no imminent collapse | Keeps travelling | Restricted ladder runs but keeps travelling |
| Unarmed at full health, default arm guard off | Keeps travelling | Keeps travelling |
| Unarmed at full health, arm guard explicitly on | Keeps travelling | Cancels and retains destination; no freeze |
| Health 20/50, damaging wedge already five seconds old | Watchdog cancels and retains destination | Same watchdog intervention |

The fake flee threshold is 70%; actual `safety().fleeAt` is character-specific. Neither origin armed blocker combat in these fixtures, despite mature attack/pinned episodes, because both were travelling. Results are saved in [shopping-survival-results.json](reproductions/shopping-survival-results.json).

**What the evidence supports.** There is a real execution asymmetry, and the observed default difference is narrower than “shopping has no survival.” The September 12–13 death report documents harmful suspension/freeze handoffs, most of which have since changed. It does not isolate a beneficial or harmful causal effect of running today's extra reconnect branches during an otherwise progressing shopping journey. The earlier 4:47 p.m. fleet snapshot—146 kills and no deaths in about 13 minutes since restart—also cannot answer that question: it mostly describes farming, not comparable journeys under two decision policies.

No shopping scheduler or travel-guard change is proposed as part of this repair. A policy decision needs the decision-by-decision comparison and evidence about route progress, damage, refuge availability, recovery, arrival, and shopping completion, rather than an assumption that a branch named “survival” improves those outcomes.
