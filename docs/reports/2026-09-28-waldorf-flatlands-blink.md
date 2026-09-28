# Waldorf's Flatlands crossing and backward Blinks

Waldorf was travelling from the Bookmaker's Guild House (714) back to Castle
Victoria (38), after selling cargo. His intended next hop in The Flatlands (584)
was **south to The border of the Badlands (585)**. He crossed the narrow corridor,
had trouble finishing the exit approach, and Blink repeatedly returned him to the
near side. The subsequent westward reroute was a later decision, not the intent
behind those casts.

All times below are **2026-09-28 Pacific daylight time (UTC−7)**. Source events use
UTC and Unix milliseconds. Locations use row/column notation; fine coordinates
in the new telemetry are KOD units, 64 per square.

## Reconstructed sequence

| Time | Evidence and intent |
| --- | --- |
| 07:15:49.831 | Town-trip completion receipt: selling trip finished in 714. |
| 07:18:08.529 | Entered 584 from 583. Journey `t4-mulbzn7f`, destination 38, next hop 585. |
| 07:18:30.637–32.309 | A body-lane attempt failed at r35c29; the perpendicular walk then passed two bodies in four steps. Its final fine point was x1928,y2275 (r35c30). This proves that local bypass, not yet the entire corridor. |
| 07:18:37.677–39.448 | Rail decisions reported the valid r42c36 exit stage first one step away, then zero steps away. |
| 07:18:41.984 | Blink selected from **r40c35**, beyond the r35c27–34 needle, still targeting **r43c38** toward 585. Predicate: 37 reachable squares here, 916 at the landing, goal reachable from neither. It selected the `unstrands` exception. |
| 07:18:53.352 | First verified Blink landing at **r24c29**. It took a wall before casting. |
| 07:19:03.962 | Back at r35c28, still aiming for r43c38. Blink declined. |
| 07:19:29.048 | Second Blink selected from **r35c32**, with ants at r35c29 and r35c32. Same `unstrands` rationale: 37 versus 917 squares; neither side reached r43c38. |
| 07:19:37.028 | During preparation, a nested walker ask targeted r34c35 from r35c33 and declined. The outer proposal remained pending. |
| 07:19:57.251 | Second verified landing at **r24c29**. Its tactic receipt says the attempted wall approach failed. The cast lasted 10.622 seconds, placing its start at approximately **07:19:46.629**—the event closest to the user's observation. |
| 07:20:19.019 | Travel interrupted for shelter after an object-blocked fallback; health 70→66. Original Castle Victoria destination retained. |
| 07:20:22.547–36.774 | Journey resumed, interrupted again by a failed shelter approach, then resumed again. |
| 07:20:48.188–50.252 | Again, rail decisions placed r42c36 one step away and then zero steps away. |
| 07:20:53.075 | Third Blink selected from **r40c35**, aiming at r43c38: 34 versus 918 reachable squares. Statler and ants now occupied the corridor. |
| 07:21:04.555 | Third verified landing at **r24c29**, after taking a wall. |
| 07:21:29.838 | Southward candidate batch exhausted: four actual attempts, all approach failures; another candidate skipped by the budget. The failed attempts named r43c38, r43c39, r43c30, then r43c38 after Blink. These were not rejected crossing packets. |
| 07:22:02.814 | Left **west to 574**, after a further successful perpendicular bypass in the opposite direction. |
| 07:25:21.166 | Entered Castle Victoria (38). Journey completion recorded at 07:25:21.583. |

The eventual route was **584 → 574 → 150 → 575 → 576 → 587 → 597 → 598 → 599 → 2 → 38**:
Cor Noth and The King's Way, rather than Merchant Way.

## What failed

The normal Blink predicate compares the current location and fixed landing against
the current goal. It already re-reads position and bodies before casting. However,
its **unstrand exception** allows Blink even when neither position reaches the
goal, provided the landing opens at least four times as many squares. That rule
was introduced to rescue small geometry pockets in room 567.

Here, ants behind Waldorf partitioned a small *exit-side* area from the main room.
The size comparison mistook that traffic partition for a sealed geometry pocket.
It explicitly chose to get more floor rather than make progress toward 585. The
same fixed teleport then put Waldorf behind the traffic again.

Offline replay of the first recorded decision reproduces **37 versus 916** exactly.
Removing the bodies gives **961 reachable squares from Waldorf's position**.
The same collision-based flood still cannot reach the selected r43c38 anchor in
an empty room, while it *can* reach the published **r42c36 staging square with the
recorded monsters present**. The world exit model publishes r42c36 with its own
fine approach and southward crossing target. These are distinct facts: an inland
stage is not the final crossing square.

The exit executor had an existing guard for a failed walk that ended on one of
that candidate's retained alternate stages. It did not re-read the destination's
published stages **before** walking toward an old anchor, so reaching a usable
stage did not necessarily prevent walking away again.

## Changes

1. The unstrand size advantage must persist in the empty-room comparison. A
   traffic-only partition with a goal unreachable from both sides now declines
   with `traffic_partition_not_stranded`. Genuine geometry-pocket rescue and
   ordinary goal-reaching Blink bypasses remain available.
2. Before an edge approach, the executor reuses the character's current square
   when the world publishes it as a valid stage for the **same destination and
   direction**. It takes that stage's complete fine crossing tuple, retains
   wrong-door exclusions, and runs the normal position/collision/crossing checks.
3. Blink proposals snapshot the selected position and goal and receive unique
   IDs. All production casting callers present that ID; an outer caller cannot
   consume a newer nested proposal in the same movement generation.
4. Moving at least one square's distance during preparation drops the old
   oscillation exception before the current reachability check. This does not
   assume movement means success: a newly evaluated real bypass can still cast.
5. Decision receipts add proposal ID, strategy intent, timing, fine position and
   exit destination where known. An unthrottled `pre_cast` receipt records the
   selection and current positions, displacement, current bodies, goal, landing,
   updated verdict and whether the cast was allowed. Outcome receipts carry the
   same proposal ID. Blocking-body snapshots retain IDs and available fine points.
   `exit_stage_reused` identifies selection reuse, not a completed crossing.

## Limits and verification

There was no pre-cast position receipt in the old code. The second cast's exact
starting square and fine position are therefore **not recoverable from these
records**. The r35c32 decision, subsequent r35c33 nested ask and r24c29 landing
are recorded; the user's approximate r37c36 cast position is neither confirmed
nor contradicted. First and third selections definitely occurred on the exit side
of the needle. No record proves that 585 would have been immediately crossable
from the exact observed fine position.

Offline tests reproduce the actual first decision, preserve genuine pocket
rescue, exercise movement after selection and nested proposals, and check that
only a matching allowed exit can reuse a reached stage. Network movement remains
mocked in executor tests. This is not a claim of live crossing success.

Validation: all **34 traffic/continuation tests passed**. The full existing
**14-suite movement gate reported zero regressions**, retaining the named baseline
of 12 needle, 4 travelling and 3 safe-spot failures. The traffic/continuation suite
is now included in that gate so these new regressions run on future movement changes.

Evidence was read from:

- `prod-deploy/substrate/history/prod/fleet-2026-09-28.jsonl` (journeys and Blink receipts).
- The configured shared evidence root's `transits/Waldorf.json` and
  `tactics/prod.jsonl`, resolved using `evidenceDirFor()`. The similarly named
  deployment-local transit/tactic copies are stale and omit this event.
- The deployed `m59-map.json`, routing code, and private `blink-escape` policy.

The patch is prepared in an isolated worktree. No production keeper was restarted
or switched to these changes during the investigation.
