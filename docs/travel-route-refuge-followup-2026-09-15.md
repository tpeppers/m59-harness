# Route refuge handoff and failed departure — 2026-09-15

The six-minute Janice replay exposed two different faults: a route recovery
whose decision record stayed `approaching` after healing, and a traveller
that repeatedly failed to leave the room. Successful recovery alone is not
successful travel. None of the completed natural runs below demonstrates a
reduction in deaths per completed trip.

## Correcting the apparent two-minute approach

In `trial-104-fallback-wall-natural-7.json`, the route refuge was chosen at
134.3 seconds and arrival was recorded at 136.7 seconds. The bot then stayed
at r34c16 and healed from 32/49 to 49/49 until about 221 seconds. Subsequent
movement failed, and another decision replaced it at 269.1 seconds.

The original report called the 135-second interval an unresolved approach.
The detailed HP, position and operation trace shows that much of it was
recovery. That interpretation has been corrected; the original trial is retained.

The route callback accepted a predicted square. `adoptRecoveryWall()` correctly
refused that unconfirmed position, but the callback then used an older passive
rest fallback. That fallback neither changed the decision to `recovering` nor
finished it after healing. Later travel damage was consequently attributed to
an apparent refuge approach. This also bypassed the operator's safe-wall
logoff, reconnect and turn-to-heal priority.

## Route arrival correction

Route and track arrivals now use the same position-confirmation helper as
other refuge approaches. A successful response is required while the position
is predicted. A stale reply clearing the prediction flag is insufficient.

If the selected square is confirmed and recovery is needed, the callback
requires the current geometric safe-wall check and hands off to the existing
logoff/turn/heal lifecycle. That lifecycle records arrival, replacement,
recovery and completion. The legacy unverified passive-rest fallback is removed.

An unanswered confirmation, corrected position or failed wall check replaces
the survival decision, retains the journey destination, revokes the old mover,
and executes the replacement immediately. It does not blacklist wall geometry
merely because a position read failed. A newer movement, room, client or survival
owner prevents the old callback from acting. A whole traveller completes the
decision and continues without recovery.

## Natural replay observations

Both runs use case 104, the same native baseline, exact supplied loadout,
49/49 initial HP and 14 monsters. The control reinstalls only the exact route
arrival callback from `36bf098`; its source is archived by hash. Other engine
code is the candidate in both arms. The observations are unseeded.
The [capture's fidelity limits](travel-shelter-audit-2026-09-15.md#fidelity-limits)
still apply, including later loadout capture and unrecovered original RNG,
target memory and timer phase.
Both also inherited a private runner override that passes `route:true` to
recovery selection: a broad substring test matched their experiment names.
This is a shared condition, but it means these are not exact default-policy
comparisons. The source archives preserve it. Subsequent routing tests name
the override explicitly and leave it off unless it is the requested variant.

| Variant | Observation window | Result | Route-arrival callbacks | Destination reached |
|---|---:|---|---:|---|
| Previous callback, trial 1 | 240 s maximum | Died at 151.3 s in room 598, after one completed safe recovery | 0 | No |
| Confirmed callback, trial 1 | 240 s | Alive at 24/49 HP, still in room 598 | 0 | No |
| Confirmed callback, soft proximity cost removed, trial 1 | 240 s | Alive at 49/49 HP; reached room 39 at 107.7 s | 1 during the resumed original journey | Yes, then began later travel |

**The first two runs did not exercise the changed callback. Their difference cannot be
attributed to the correction.** The candidate spent much of its window in
open logoff protection, then reached a safe wall. This is useful evidence
about journey failure, not proof of efficacy for the arrival change.

The cost-removal run left room 598 at 24.2 seconds with 46/49 HP. A predicted
route arrival in room 599 at 26.0 seconds used the corrected callback, handed
off to safe logoff, and completed recovery at 44.5 seconds. The suspended
destination survived: room 39 was reached at 107.7 seconds with 49/49 HP.
The initial `replayed_journey` receipt says cancelled because recovery interrupted
that first invocation; the subsequent room trace proves the destination was
reached after resumption. The runner continued ordinary behavior afterward,
ending in room 544 at full HP. This single observation is promising, not an
effect-size estimate or justification to disable proximity costs everywhere.

## Focused arrival comparison

To exercise the changed branch, two more runs explicitly offered the current
geometric wall to the real route callbacks after damage. This is a controlled
branch trigger, not the default travel trigger. Both started from case 104;
unseeded attacks produced different HP by the time the callback ran.

| Callback | HP at arrival | Handoff | First full recovery | HP at 120 s |
|---|---:|---|---:|---:|
| Previous | 33/49 | Passive rest; decision remained `approaching` even after full healing | About 86.2 s, inferred from callback HP | 7/49 |
| Confirmed | 40/49 | Confirmed position, then `logoff_safe` with status `recovering` | 55.0 s, explicitly recorded as `recovered` | 36/49 |

Both survived and neither reached the destination. The different arrival HP
precludes attributing the recovery-time difference to the fix. What this proves
is the corrected handoff and reporting: the new route decision ended with
`arrived`, its linked safe-logoff decision completed with `recovered`, and later
danger began a new recovery decision. The old callback healed successfully but
left the original approach open until a later cancellation.

These focused runs retained the same legacy route-recovery override described
above. The corrected callback's core source hashes match those used in all
the preceding candidate runs:

| File | SHA-256 |
|---|---|
| `tools/m59-autopilot.mjs` | `ff86df45c909de537371698829a6f12065a2926b1760b3b6bbc29a13e4aac4ce` |
| `tools/m59-skills.mjs` | `d667318ee1c440ef4573aa8cffd4e3cdbc6bfdb585454c84b92f3d9cc96d5aad` |

## Why departure remains difficult

A separate offline probe uses the same room geometry and captured monsters.
With the existing monster-proximity costs, the first planned step is southwest
from r34c16 to r35c15. Without those costs, the first step is east to r34c17.
Both eager and lazy geometry loading produce the same result.

The movement mask validates the southwest step from the square's nominal stand
point, fine x1056/y2208. The character actually starts at x1068/y2198, where
the same southwest aim is blocked by wall 243. The eastward aim validates
from both positions. Thus the live start point matters even within one square;
this is not evidence that the mask is missing or the lazy loader changed it.

The natural control confirms the failure on the wire-facing movement path:
the first southwest step returns `geometry_blocked`; later attempts slide
between nearby squares. Repeatedly offering a route whose first edge works
only from a different fine position is a concrete source of exposure.

Removing the soft proximity cost is an experiment, not a production policy
recommendation. Actual body collision remains enforced in that experiment.
An alternative worth testing is to validate departure edges from the actual
fine position while retaining threat-aware ranking among viable routes.

That narrower variant was also run once for 240 seconds, with the accidental
recovery override removed. It rejected the initial southwest edge and offered
eastward departures, but still failed to leave room 598. It survived at 17/49
HP after prolonged open logoff protection and a late safe-wall recovery.
The trace retains 568 path calls with rejected origin edges; later movement
still clipped or hit bodies and returned to nearby squares. Validating the
first edge alone did not demonstrate a successful crossing. It remains a
negative result for this particular implementation, not a production change.

The next comparison should repeat soft-cost removal with ordinary recovery
selection, against a matching control, and investigate how route pulling and
fallback movement lose a viable departure after the initial plan. Both routing
variants remain confined to the private simulator.

The [six matched ordinary-recovery repeats](travel-routing-cost-repeats-2026-09-15.md)
are now complete. They also reproduce additional fallback, shelter-progress and
suspended-journey ownership faults, with retained traces and separate outcomes.

## Evidence and checks

Private evidence under `substrate/replay-smoke/travel-zero-2026-09-15/`:

- `refuge-long-stall-trace.json`: complete decision trace and summarized operations.
- `trial-104-route-{control,fixed}-natural-1.json`: natural comparisons above.
- `trial-104-route-cost-natural-1.json`: soft-cost removal experiment.
- `trial-104-route-probe-{control,fixed}-natural-1.json`: focused branch comparisons.
- `trial-104-route-origin-natural-1.json`: unsuccessful departure-edge variant,
  explicitly recording `recovery_route_override:false`.
- `departure-routing-{eager,lazy}.json`, `departure-start-point-comparison.json`
  and `refuge-departure-geometry.json`: geometry probes.
- `route-arrival-before.log`: regression fails against the old route callback.
- `route-fix-*-test.log`: passing targeted regression results.
- Source archives keyed by SHA-256, including the exact prior callback.

Offline checks pass: route arrival (11), refuge posture (13), recovery refuge
(11), survival decisions (23), survival handoff, and track integration. Track
integration exercises the real predicted-arrival, logoff and continued-healing
sequence while retaining the suspended destination.

From 09:35:54.917 to 10:03:33.319 UTC, production on `36bf098` had 12
positive-leg journey records: 11 arrivals and one cancellation, with no deaths.
The cancelled t4 journey had completed six legs and retained 50/50 HP.
Another 301 records were zero-leg retries of hk2's 49→370 route; these are not
successful trips. The frozen window is `arrival-exposure-1789466613319.json`.
These are journey records, not deduplicated end-to-end resumed trips, and this
short observational window does not establish an effectiveness change.

Freeze invalidation is unchanged. Failed, nonfatal and divergent trials remain
available; no replay is discarded because its death timing differs.
