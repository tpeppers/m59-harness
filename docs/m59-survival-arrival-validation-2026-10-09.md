# Survival and arrival validation, 2026-10-09

This change bounds failed fine approaches and preserves keeper-owned recovery
during an external director's busy errand. It adds no successful-path delay.
The unchanged comparison build is `b142ba584cd8e8e767c297ae54633c6a8fb18817`.
Candidate gameplay changes are limited to `m59-session-walk.mjs`, `m59-skills.mjs`,
`m59-autopilot.mjs` and `m59-survival-jam.mjs`; private trial manifests retain
their exact source hashes.

## Independently reproduced defects

`approachFine` previously gave its sliding fallback a fresh budget after following
protocol waypoints, and omitted attempted waypoints from a failed result.
`returnToSpot` also omitted its requested budget when calling that fine approach.
Waypoints and fallback now share one budget. A finite planned detour can raise
the caller's default, as `walkTo` already does, preserving complete healthy routes.
A zero budget issues no movement. The square strategy and remembered-fine-point
adjustment retain their established separate budgets. A fallback step counts a
fan iteration, not a wire packet.

Terminal movement refusals were ignored in the waypoint loop and could be hidden
by later fallback results. They now stop immediately and preserve their receipt.
Cancellation or replacement of the client during an await is checked before
reporting arrival. The movement recovery tests exercise the real Session method,
every terminal reason, exhausted budgets, both return-to-spot route orders and
takeover on the last step.

Busy errand gates contradicted the keeper's ownership of survival and recovery:
they disabled the pending dispatcher, stalled-approach watcher, jam memory and
defensive clearance even when the director held only movement. Those paths now
continue while busy. A first busy declaration or new owner still invalidates old
movement. Renewal by the same owner cannot strand replacement recovery. Human
control, explicit survival/recovery/combat claims, movement generation, client,
room and life checks remain enforced. Tests exercise a real body-aware recovery
selector, replacement wall selection, busy renewal/new ownership and defensive
blocker clearance.

## Real-geometry approach comparison

The offline comparison selected eight protocol-reachable wall approaches in each
of rooms 27, 38, 39, 564, 578, 583, 584, 585, 597, 598 and 599. Both builds used
the same starts, targets, geometry and 24-step fine budget. The actual
`Session.approachFine` and `validateFineTarget` methods ran with modeled position
updates, without sockets, packet pacing, server confirmation or monsters.

Both builds reached 85 of 88 refuges. All 85 successful cases issued identical
movement requests. The three failures remained failures, but their combined
attempts fell from 284 to 218; total attempts fell from 562 to 496. This supports
preserving successful paths while ending unsuccessful attempts sooner. It does
not measure live travel speed or establish a higher production arrival rate.

An intermediate strict-cap implementation lost one previously successful 51-step
detour in room 597. The final implementation retains that complete planned route;
a real-geometry regression test now covers it. The comparison above includes
long detours, rather than selecting only routes that fit the caller's default.

## Castle chamber reachability

An offline check of the captured room-38 east-chamber layout found a monster on
the only reachable internal door square, r8c32. The recovery planner rejected
that occupied destination. Removing only that body made the one-step door
approach and the hall refuge eligible. The observed `clear to walk 0` refusal is
consistent with visible occupancy, rather than a missing door definition. The
victim pose in this capture was predicted, and this check did not execute attacks
or a server crossing. The independent recovery-refuge and Castle chamber suites
cover a clear door, an occupied door, confirmed crossings and failed crossings.

## Local current-build scene comparison

Three trials per build ran from each of two wall-approach checkpoints and one
exit-approach checkpoint. Every trial used a fresh process, the same checksummed
native reset and a shared scene driver. The final candidate trials reused the
nine verified unchanged-build observations from the preceding paired study;
intermediate candidate observations remain separate. Source and driver manifests,
placement, release and cleanup checks verified all 18 final observations.

| Scene | Horizon | Baseline refuge arrivals | Candidate refuge arrivals | Baseline arrival time | Candidate arrival time |
|---|---:|---:|---:|---:|---:|
| Room 598 wall approach | 45s | 3/3 | 3/3 | 2.056–2.058s | 2.047–2.061s |
| Room 599 wall approach, assumed aggression | 45s | 3/3 | 3/3 | 2.868–2.889s | 2.792–2.897s |
| Room 584 exit approach | 90s | 0/3 | 0/3 | No arrival | No arrival |

All trials survived their observation window. Arrival time is the first sampled
non-predicted occupancy of the selected refuge square, with 100-ms sampling; it
is not a complete journey's destination arrival. Neither build crossed the
room-584 exit. The unchanged-build deaths did not recur in these models, so the
comparison cannot measure deaths prevented. The wall approaches support no
meaningful speed loss in these tested scenes, rather than a fleet-wide speed claim.

The room-599 sensitivity scene explicitly supplied an estimated ATTACK state,
target, hatred and behavior timer to a nearby recorded killer. Those native fields
were unknown historically. Both builds used that same assumption. The shadow
character used an ordinary axe, no armour and different skills; captured other
players were idle bodies. The corrected common driver used route-first recovery,
the caller's 24-step budget and progress watcher, and the exit's actual travel
handler followed by far-side recovery. These are current-build experiments with
explicit assumptions, not restored historical control runs.

## Interpretation and follow-up

Historical client captures omit native monster HP, targets, hatred, timer phase
and RNG, and checkpoint busy leases/faculty claims. The local shadow character's
loadout and skills also differ. Current-build reconstructed trials cannot certify
an exact historical cause or quantify deaths prevented. Their source manifests,
common driver, native reset receipts, mismatches and nonfatal outcomes remain in
private investigation artifacts.

The useful next production observations are confirmed pose, movement ownership,
incoming damage and terminal movement reason around a failed refuge approach.
For a crowded chamber, record the blocking body, door reachability and any
defensive clearance before attributing a failed crossing to geometry. Compare
post-roll survival and completed journeys within the new movement epoch, including
arrival duration and the number of journeys; historical daily death totals alone
cannot establish an improvement.

## Additional validation limits

The final `npm run test:movement` run completed all 30 suites with zero regressions
against the named known-red baseline (12 needle, four travelling and three
safe-spot assertions). The baseline was not changed.

The targeted movement-recovery, death-prevention and survival-jam regressions
pass, alongside keeper authority, lease guards, recovery-refuge and Castle chamber
checks. No failure baseline was widened for this change.

The broader `test:farm-loop` chain stops at five source-extraction expectations in
`m59-exactexit-test.mjs`. Independent checks also found `originLabel` undefined in
the travel-ack fixture and a missing `runCommand` method in the keeper-sale fixture.
All three failures reproduce on the unchanged comparison build. The remaining
farm-loop checks passed independently; the entire farm-loop chain is not green.
