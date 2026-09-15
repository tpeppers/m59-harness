# Travel shelter audit and Janice onward replay — 2026-09-15

## Shelter eligibility

The old rule that banned routine shelter stops at six monsters was already absent
from production revision `b0887c8`. Comments and the critic still described it as
current policy. That description was incorrect.

The audit found two remaining gates and removes them:

| Entry | Before | After |
|---|---|---|
| Wedge recovery in keeper travel | Tried the nearest recovery refuge only at six or more monsters | Tries it regardless of room population |
| Hop-boundary shelter | Refused the search if any monster was within melee reach | Considers a refuge and checks its approach for walls and occupied squares |
| Routine route diversion and recovery selection | Already allowed walls regardless of count | Same eligibility |

The hop-boundary preview now uses the shared `recoveryRefugeReach` check, also
used by actual recovery. It rejects occupied targets and paths blocked by bodies
or geometry. A monster beside the route is not itself a reason to refuse it.
Health thresholds, explicit travel guard settings and PvP checks still apply.

The legacy `travelStopMaxThreats` setting now has only two callers: fetching
quarry from an existing wall and trading melee blows in place. Those are combat
choices, not permission to take shelter. Their new telemetry is named
`crowd_combat_refusal`; it no longer says that the exit is the only wall.
Historical `crowd_no_stop` records are retained. The critic now reports the
observed count without inferring that shelter was disabled or the room impassable.
The explicit exit-only search option remains available for experiments; no
production caller sets it from monster count.

These changes implement the operator's shelter rule. They are not a measured
reduction in deaths per trip. Freeze invalidation was not changed.

## Replay restoration defect

Restoring an active journey by copying `inert.travelling` skipped initialization
of its shelter callbacks: the normal initializer saw the existing flag and
returned. The replay also called `Session.travel` directly, skipping keeper
hop-boundary recovery and journey accounting.

Replay now restores the serializable journey state through its initializer,
checks callback installation, and starts travel through the keeper wrapper.
It preserves explicit disabled guards, deadlines, retries and replacement
ownership. An ordinary failed journey retains its destination for recovery and
retry. Receipts expose `controller_restore.journey` and `replayed_journey`.
Routes are replanned; this does not recreate the original JavaScript stack,
waypoint list or accumulated journey stop counters.

The frozen Janice, Floyd and Scooter source cases reviewed here had no active
`inert` journey. Their initial recovery resumes through the normal keeper
later, so this specific missing-initializer defect does not invalidate those
earlier recovery comparisons. The new onward checkpoint does have an active
journey and needed this correction.

## Six retained onward trials

To skip roughly 230 seconds of initial healing on every experiment, a new scene
was captured just before Janice resumed travel at 49/49 HP in room 598, from
r34c16, fine coordinates x1068/y2198. It contains the player and 14 monsters.
Every trial restored the same native baseline, applied that scene and loadout,
and ran in a fresh process for up to 120 seconds.

The experimental variant interrupted fallback movement at the first damage
that satisfied the existing route shelter trigger, then called the normal
nearest-refuge recovery method. This variant is confined to the private lab
runner and is not part of the production change above.

| Variant | Trial | Outcome within 120 s | Final HP | Destination reached |
|---|---:|---|---:|---|
| Control | 1 | Alive | 23/49 | No |
| Control | 2 | Alive | 9/49 | No |
| Control | 3 | Alive | 41/49 | No |
| Early nearest refuge | 1 | Died at 31.7 s | — | No |
| Early nearest refuge | 2 | Died at 45.7 s | — | No |
| Early nearest refuge | 3 | Alive | 34/49 | No |

The observed result is **0/3 deaths in the control and 2/3 in the variant**.
This small, unseeded sample does not establish a population death rate or prove
causation. It is negative evidence against deploying this particular variant.
All six remained in room 598. Survival to the time limit must not be counted as
a successful trip.

All three variant trials selected the existing r34c16 wall at 4.2–4.6 seconds,
reported taking it, and replaced that decision 0.6–1.0 seconds later because
recovery was no longer at a safe wall. The replacement sought the exit at
r57c21. Two then died; the third later entered open logoff protection. The
initial wall acquisition did not produce safe logoff-and-heal recovery.
Late movement or position changes are plausible causes, not yet established.
This recurring failure is useful even though not every trial dies.

The control exposed another gap: after `walkPivots` failed, the fallback
walker did not use the route shelter callbacks. In control trial 1 the pivot
planner had six shelter candidates, then returned after an unproved step landed
off plan. Fallback movement continued without a shelter stop until the watchdog
took over. A complete fix needs reliable refuge arrival and ownership through
that handoff; simply invoking recovery early did not demonstrate a benefit.

Restore-to-start time was **4.60–5.26 seconds**, including native restore,
login, abilities, scene preparation and client synchronization. The native
restore portion was 0.33–0.64 seconds. Each trial's timing and source hashes
are retained.

### Fidelity limits

The onward scene records all visible fine positions, but it is not a simultaneous
native world checkpoint. The complete loadout was read after the capture run:
its 20 inventory items matched the cached count, while durability and timers
could have changed. The captured mana was internally inconsistent (26/25);
both arms explicitly used 25/25. Native RNG, target memory and original timer
phases were not restored. These are exploratory reproductions, not identical
historical death replays.

Private evidence is under
`substrate/replay-smoke/travel-zero-2026-09-15/`: `case-104.json`,
`trial-104-{onward,fallback-wall}-natural-{1,2,3}.json`,
`onward-repeat-progress.jsonl`, the capture run
`trial-4-capture-onward-natural-204.json`, and source/provenance archives.
Failed, surviving and divergent trials are all retained.

## Production exposure before this change

From 08:19:35.626 to 08:49:31.468 UTC, after the sector-mapping rollout:
17 journey records with at least one completed leg all arrived, and no death
event was recorded. Another **326 zero-leg failures were the same hk2
49→370 retry loop**. Those retries must not inflate a denominator of safe trips.
This is a short observational window, not evidence of a causal improvement.
The frozen window is `sector-exposure-before-count-fix.json`.

## Verification

The regression test failed on the prior count gate and passes after its removal.
It exercises actual keeper travel, route callback eligibility and hop-boundary
eligibility with 0, 1, 5, 6 and 14 monsters, retaining recovery ownership and the
suspended destination. Real-geometry recovery tests cover a blocked corridor,
occupied refuge, walls, adjacent nonblocking bodies, distant populations and
exclusive claims.

Passing checks: survival handoff, recovery refuge (8), replay journey,
forward shelter (17), critic (120), track shelter integration, death replay
(31), and scene simulator (13).

Two older suites contain pre-existing failures: travel A/B has 12 obsolete
source/threshold assertions, and station has one keeper RPC timeout assertion.
Both were run against production `b0887c8` and the candidate; the failure
lists are identical. The modified travel eligibility assertions pass.
