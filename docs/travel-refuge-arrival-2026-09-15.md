# Confirmed refuge arrival — 2026-09-15

The arrival fix makes safe recovery reproducible in Janice's reconstructed
onward-travel scene. Four short trials all healed fully at the initial wall
and survived. The earlier version abandoned that same refuge in all three
trials and died in two. **No trial demonstrated a completed journey**, including
a six-minute run. This is evidence for fixing the recovery handoff, not an
estimate of lives saved per trip.

## The defect and correction

The shelter selector could choose the square the client already believed it
occupied and return a zero-step route. `takeSafeSpotObserved` then skipped
`returnToSpot`, the shared arrival-confirmation boundary, and reported
`took: true` even though the position was still marked `predicted`.

The recovery predicate correctly refused to treat that unconfirmed position as
a safe wall. Recovery consequently skipped safe logoff and replaced its newly
acquired refuge on the following pass. In the three earlier trials this happened
0.6–1.0 seconds after acquisition, followed by an approach toward the exit.

The correction:

- Uses the shared arrival check for a predicted position even when the planned
  distance is zero.
- Requires a successful confirmation response before accepting the predicted
  arrival. An older room reply clearing the prediction flag cannot substitute
  for the requested response.
- Preserves cancellation when movement ownership, room or client changes.
- Reports an unanswered read as `unconfirmed`, without blacklisting the
  geometric wall as unreachable.
- Keeps a character that is already confirmed at its wall there: no stand or
  movement is sent before the existing safe logoff-and-heal behavior.

In fixed trial 4, confirmation returned the same r34c16 square in 2 ms. There
was no need to move to a different wall. The decision changed from nearest-refuge
arrival to safe logoff, then turn-and-heal, and completed recovery at 86.7 seconds.
The four short trials' initial confirmation calls cost 2, 2, 264 and 2 ms.

The shared survival trace already records predicted positions. The lab runner
now also records confirmation calls and the position, current-wall check and
survival decision after the recovery method returns. This closes the before/after
observation gap in the earlier experiment.

## Retained comparison

Same case 104 described in the [shelter audit](travel-shelter-audit-2026-09-15.md):
Janice starts at 49/49 HP in room 598, with 14 monsters. The prompt-refuge variant
cancels fallback movement at its first existing shelter trigger and calls normal
nearest-refuge recovery. That experimental trigger remains in the private lab
runner; the production correction changes arrival verification.

| Group | Trials | Deaths within 120 s | Trials completing safe recovery | Final HP of survivors | Journey arrivals |
|---|---:|---:|---:|---|---:|
| Original default travel | 3 | 0 | 0 | 23, 9, 41 | 0 |
| Prompt refuge before arrival fix | 3 | 2 | 0 | 34 | 0 |
| Prompt refuge with arrival fix | 4 | 0 | 4 | 34, 32, 8, 32 | 0 |
| Default travel with arrival fix | 1 | 0 | 0 | 20 | 0 |

All HP maxima were 49. The fixed runs completed their first recovery at 86.7,
89.7, 53.4 and 97.1 seconds. Some then walked into danger again; a result labelled
`recovered` means at least one completed recovery, not that the character was
still at full health when the window ended.

The six-minute fixed trial also survived. It completed initial recovery at
79.1 seconds and ended at 22/49 HP, still in room 598. A later route-refuge
decision began at 134.3 seconds, remained unresolved for about 135 seconds,
and was replaced at 269.1 seconds. The final position was r33c15. Resolving
that later approach and the fallback walker's missing shelter callback handling
are the next investigations.

The sample is small and unseeded. The original group ran on `b0887c8` with
the replay-journey correction; the new group ran on `f421ce1` plus the arrival
changes. The intervening count-gate changes and code hashes remain explicit,
so this is not presented as a randomized, same-epoch estimate of effect size.
The recorded default controls survived by the deadline too, while failing to
complete travel. Immobility must not inflate a denominator of safe trips.

The scene's fidelity limits remain those of case 104: visible fine positions,
later native loadout capture, explicit mana normalization, and unrecovered
original RNG/target-memory/timer phases. Divergent and nonfatal trials remain
useful. No historical death or failed trial was discarded.

## Evidence and validation

Private files under `substrate/replay-smoke/travel-zero-2026-09-15/`:

- `trial-104-fallback-wall-natural-{1,2,3}.json`: before the arrival fix.
- `trial-104-fallback-wall-natural-{4,5,6,8}.json`: short fixed trials.
- `trial-104-fallback-wall-natural-7.json`: six-minute trial.
- `trial-104-onward-natural-{1,2,3,4}.json`: default-travel controls.
- `refuge-arrival-short-comparison.json`: the first ten short results,
  before final validation trial 8.
- `predicted-refuge-diagnostic.json`, test logs, and archived experiment
  and engine sources keyed by SHA-256.

Trials 4–7 used the initial correction. Final trial 8 also includes strict
confirmation-result checking and client-change cancellation. Its archived
core hashes are:

| File | SHA-256 |
|---|---|
| `tools/m59-autopilot.mjs` | `36748815ecd6456cbb13d7080f3598e3514129a7df2655861862c96f06d87e87` |
| `tools/m59-skills.mjs` | `03cefbbd558067049aeaad9ee9402f3ffb1a6e7ff3ad4384eef77a7ed32baf98` |

The final short trial restored to simulation start in 4.56 seconds; the
six-minute trial took 5.06 seconds to restore. Simulation duration is separate.

Offline tests reproduced the zero-step false arrival, unanswered read and stale
reply failures before correction. Final checks pass: refuge posture (13),
recovery refuge (11), safe spots (242), survival decisions (23), and survival
handoff. They include a corrected prediction that requires walking back,
blocked/occupied paths, no movement at an already confirmed refuge, cancellation,
and preservation of valid wall geometry after a failed read.

Freeze invalidation was not changed. This fix does not enable the experimental
prompt-refuge trigger or claim that average production deaths per trip have
already fallen.
