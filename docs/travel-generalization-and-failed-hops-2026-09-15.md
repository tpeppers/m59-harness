# Travel replay follow-up — 2026-09-15

The four additional shadow runs show no survival advantage from removing soft
movement threat costs in the Scooter and Floyd scenes. All four survived the
180-second observation window; none reached the intended destination within
that window. This does not overturn the earlier Janice result, where removing
those costs allowed several runs to complete the journey. It means that result
does not yet justify removing the costs fleet-wide.

A separate fallback-walking defect is now fixed on the experimental branch:
failed long moves were losing the first intermediate waypoint, and two-square
moves were miscounted as single steps. The correction passes offline checks.
Its effect on native survival and completed travel is **not yet measured**;
the movement candidate remains held from production.

## Four native runs

Both arms use the held continuity candidate from `b2f7efe`, before the new
failed-hop correction. “Normal costs” keeps the existing movement threat list.
“Costs omitted” supplies an empty list to movement planning while retaining
body collision, shelter checks and survival policy. Each arm ran once per scene.

| Scene | Arm | Lowest HP | Final HP | Left starting room | Reached destination |
|---|---|---:|---:|---|---|
| Scooter, room 599 → 39 | Normal costs | 24/51 | 51/51 | 169.623 s | No, stopped at 180 s |
| Scooter, room 599 → 39 | Costs omitted | 24/51 | 51/51 | 169.800 s | No, stopped at 180 s |
| Floyd, room 533 → 376 | Normal costs | 16/45 | 45/45 | No | No, stopped at 180 s |
| Floyd, room 533 → 376 | Costs omitted | 16/45 | 45/45 | No | No, stopped at 180 s |

Scooter selected the same safe wall, r22c44, in both runs. Safe-logoff recovery
began at approximately 4.8 seconds; reconnect-and-turn healing began at 7.7
seconds. Recovery finished at 141.4/141.5 seconds, followed by onward travel.
Both runs ended in room 2 with destination 39 still retained. The 0.18-second
room-exit difference is not useful evidence of a routing advantage.

Floyd selected r15c47 in both runs, reached it at about 15.5 seconds and entered
reconnect-and-turn healing at 18.4 seconds. He steadily healed from 16 to 45 HP,
reaching full HP near the end of the observation window. The recovery decision
was still open when observation ended; destination 376 remained retained.
Calling this a movement loop would be premature: almost the whole window was
spent healing. The next comparison must run long enough to observe departure
after recovery and the rest of the trip.

These are useful nonfatal reproductions. They demonstrate reachable walls and
safe healing from these reconstructed states. They do not estimate deaths per
trip, establish a benefit over production, or isolate the benefit of an
intervention against a no-intervention control.

## State and fidelity checks

Scooter starts at captured 32/51 HP, vigor 80, with 11 monsters. His checkpoint
is the latest retained frame before an external cancellation discarded the
destination, 31.497 seconds before the historical death. Floyd starts at
captured 16/45 HP, vigor 80, with 10 monsters and four scenery actors, 29.545
seconds before his historical death.

All four runs verified actor placement (12 actors for Scooter, 15 for Floyd)
and the supplied loadout. All used separate newly created runtime directories,
the same startup seed manifest and the same execution source manifest. The
shelter and bad-exit seeds match; prey-side and track-strike seeds were missing
in all four, explicitly recorded. Restore-to-start took **4.58–5.38 seconds**.

The supplied loadouts passed reconstruction checks, not historical completeness
checks. Item condition comes from constructors, unknown enchantments are absent,
and ability advancement flags are unknown. Historical rest posture, monster HP,
target memory, timer phase and bystander inputs are not fully reconstructed.
Missing freeze retry counters are explicitly initialized to two prior no-gain
freezes, with the starting HP as the reference, identically in both arms.
Freeze-invalidation policy is unchanged. These assumptions limit transfer to
the original deaths and must remain attached to later results.

The normal-cost and omitted-cost runs were consecutive, not randomized across
multiple server seeds. Four runs across two scenes are exploratory evidence,
not a fleet-wide mortality estimate.

## Failed-hop correction

The real `Session.walkTo` fallback walker exposed three related problems:

1. The first waypoint had already been removed from the queue before long-hop
   lookahead. It was never saved with the later skipped waypoints. From r34c16,
   a failed hop to r34c19 retried r34c18, omitting r34c17.
2. An extra decrement understated the hop length. A failed two-square hop
   entered ordinary single-step recovery instead of restoring intermediate
   steps. Successful long hops also reported one fewer planned step.
3. The legacy collinear branch ignored the shortened retry limit, allowing it
   to offer the same failed long move again.

The correction retains the initial waypoint, counts all consumed waypoints,
and applies the retry limit and failed-hop memory to collinear coalescing.
It changes no shelter population rule, threat-cost policy or freeze policy.

The original 11-check fixture had ten failures before the correction. The final
13-check suite passes, including full arrival through every intermediate
waypoint when only single-square moves are accepted. Geometry and body refusals,
two-/three-/five-square hops, cancellation and both coalescing paths are covered.
Travel continuity (22), string pulling (11), route-refuge arrival (12), and the
collision suite (404) also pass. Syntax and whitespace checks pass.

The next native test should replay Janice's room-598 scene with normal costs
and the corrected fallback. Success means leaving the danger room and reaching
room 39 while surviving; repeated healing without onward completion remains an
unresolved failure. The two new scenes also need production controls and a
longer horizon, especially Floyd.

## Availability and retained evidence

At 18:09 UTC, the first production-code shadow control failed before scene
start because the owned lab admin port 17998 refused the connection. Inspection
then found Docker Desktop's engine unavailable. This setup failure is retained
and is **not** counted as a death or survival trial. Further native validation
requires Docker Desktop to be started.

Production's broker was also unavailable when checked. The daily fleet history
ends at **12:29:06 UTC**, despite the exposure scan running at 18:08 UTC. The
51 positive-leg records and 1,529 zero-leg records since 10:08:57 contain no
recorded deaths, but they are not deduplicated trips and the later silence is
not observed travel exposure. No production restart or deployment was performed
for this follow-up.

Private evidence under `substrate/replay-smoke/travel-zero-2026-09-15/`:

- `trial-{111,109}-{route-fixed,route-cost}-natural-1.json`: all four native runs.
- `routing-generalization-progress.jsonl`: frozen inputs and complete run order.
- `routing-generalization-summary-1789495671515.json`: outcome comparison.
- `routing-generalization-integrity-1789495909362.json`: matching startup seeds,
  execution code, verified loadouts, healing phases and retained destinations.
- `case-{111,109}.json`: frame identities, source checksums and explicit assumptions.
- `route-fix-exposure-1789495720702.json`: production history scan; apply the
  12:29:06 data-coverage cutoff above rather than its scan time.

The failed production-code control receipt and its log are retained in the
parallel `replay-state-release` worktree's same private directory. All prior
trial data remains preserved, including divergent and nonfatal results.

Execution source manifest for the four completed runs:
`d787cffcf81ad3657aea0423980508a837001246e49b55d08902699e9a22d5d4`.
Shared runner SHA-256:
`db08a3eec48c774f3daf4286232962497104ef8e66db5632cfde7b754ec27980`.
