# Survival jam handoff follow-up — 2026-09-22

Implemented in the survival-escalation worktree. Production remains on hold; this
follow-up did not deploy code or start another shadow tour.

## Problem and behavior

The completed tour exposed a gap between the travel watchdog and pending recovery:
after survival took over, `doing=null` reset the travel wedge clock. Pending refuge
could then fail repeatedly without reaching the existing blocker combat operation.
Replacing refuge decisions also needed to preserve failed retreat escalation.

Recovery now owns a bounded jam episode independently of the current decision ID.
It retains a measured travel wedge across an explicitly authorized survival
movement-generation handoff. Without watchdog evidence, two failed recovery
approaches spanning at least ten seconds in the same pocket establish a jam.
No weapon, attackability, player exclusion, engagement, cover or escape gate is
relaxed by that evidence.

An episode belongs to the same client, movement generation, room and initial
position pocket (at most two coarse squares on either axis). It expires after
120 seconds without extension. Leaving that pocket, reaching cover, changing room,
death, stop, external cancellation, or a faculty/human handoff invalidates it and
its failed-retreat history. Deliberate safe-wall rest cannot establish an episode.
Clearing an episode also clears its old watchdog evidence so it cannot immediately
reappear from the same stale travel measurement.

Pending recovery tries the existing hurt-and-wedged escape ladder before combat.
Failed attempts remain attached to the episode across replacement decisions, so
the sequence advances through the existing retreat rungs instead of returning to
rung one. An exhausted, unchanged recovery observation waits at most one second
before retrying. Changed health/damage, bodies, exits, geometry, position or
ownership bypass that delay. Cancellation during an awaited action prevents the
dispatcher from executing the next alternative under a new movement generation.

The existing exact-target sustained weak fight and health-aware stronger lure
remain responsible for combat. Local path clearance uses the body-aware recovery
reach test to the original blocker square. At full health and resting vigor, a
clear local path can finish pending recovery while retaining the suspended journey;
the normal journey resumer then continues its original destination. Otherwise
recovery retains control. Local clearance is not proof that the whole journey is
open.

## Evidence for the next evaluation

`survival_jam` events record start, measurement, explicit generation transfer and
invalidation. `blocker_event` records operation/target identifiers and start,
strong-lure refusal, retaliation, retreat, refuge arrival, observed chase,
disappearance, cancellation and local path clearance. Retreat-ladder events also
record rung, outcome and nearby target IDs.

Lure observation follows the exact retaliating object for up to thirty seconds.
It requires that object to leave the original blocker area and arrive beside the
chosen refuge. Moving in the opposite direction does not count as chase. This is
observational evidence; it does not establish the monster's internal intent.

The combat helper's `killed` result means target disappearance, which can be shared
by multiple attackers. Blocker combat no longer increments each observer's kill
counter or emits a personal `killed` event for that result. A shared, atomic
cross-process marker emits one canonical `blocker_clearance` for matching server,
room object, target ID/name observations within ten seconds. Each observer keeps
its own structured disappearance event and the correlation receipt. This short
window avoids treating reusable object IDs as permanent creature identities.
Cause and killing blow remain unattributed. Contention/storage failures return an
explicit unavailable receipt without waiting or blocking survival. A process
crash can leave a marker lock unavailable; raw observer events remain the audit
source in that case. Counts must not treat an unavailable receipt as zero events.

## Validation

`tools/m59-survival-jam-test.mjs` contains 27 passing offline integration cases.
It calls the actual watchdog pulse, Session cancellation, survival handoff,
pending dispatcher, recovery wrapper, retreat ladder and journey resumer. It does
not supply a fabricated `wedgedInPlace` result. Coverage includes:

- blocked travel → takeover → idle watchdog reset → refuge failure → six exact
  weak-target attacks → local clearance → resumption of the original destination;
- a productive fight interrupted by low health and successful refuge arrival;
- failed retreat rungs 1, 2 and 3 across replacement decisions in one pocket;
- all episode invalidations, mid-swing cancellation, brief faculty handoff and
  takeover during breadcrumbs, including no subsequent movement under the old owner;
- safe-wall protection even with stale measured travel evidence;
- recovery failures establishing a jam with no watchdog evidence at all;
- unchanged retry throttling and immediate reconsideration after damage/new bodies
  or exit information;
- exact larger-target retaliation, refuge arrival, immediate and delayed chase,
  local path clearance, and refusal to claim clearance when another body occupies it;
- shared-clearance correlation, object-ID reuse outside the interval, and two real
  Node processes competing to record the same clearance.

Wire attacks/movement, geometry observations and the selected lure refuge are
fixtures. These cases validate control flow and outcome accounting, not live
server chase behavior or a reduction in mortality. The separate existing blocker
tests retain coverage of lure-refuge filters and combat safety gates.

The ten-file survival/recovery regression command passed all 82 Node test entries
(some entries execute legacy assertion suites). The complete movement gate passed
all 13 suites with zero new regressions. Its existing named baseline remains:
twelve needle assertions and four travelling assertions; those are not claimed
fixed. Two older plain-object blocker fixtures now inherit the Autopilot prototype
to access its helpers, with their behavioral assertions unchanged.

One configuration confound remains: this worktree inherits a watchdog pinned
timeout of 2,147,483,647 milliseconds, approximately 25 days. That setting was not
changed. The real-pulse test explicitly uses the normal twenty-second timeout;
the separate no-watchdog test verifies that repeated recovery failures can still
qualify the new episode independently. Live validation must record the effective
setting and exercise both weak-blocker and larger-lure cases before making any
mortality or live-lure success claim.

Commands run from this worktree:

```text
node --test tools/m59-survival-jam-test.mjs tools/m59-pending-survival-blocker-test.mjs tools/m59-survival-escalation-test.mjs tools/m59-survival-decision-test.mjs tools/m59-survival-handoff-test.mjs tools/m59-survival-preempt-test.mjs tools/m59-survival-trace-test.mjs tools/m59-travel-continuity-test.mjs tools/m59-route-refuge-arrival-test.mjs tools/m59-handoff-test.mjs
node tools/m59-movement-suite.mjs
```
