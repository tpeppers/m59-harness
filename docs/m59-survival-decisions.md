# Explicit survival decisions

Survival intent is now runtime state shared by the keeper and movement code. A cancelled
shelter approach no longer becomes an unlabelled retry. The fine approach, square walk,
final fine positioning and confirmation boundaries all honour cancellation. Ordinary
blockage can still use the alternate mover while the original decision remains valid.

## The record

Each decision has a stable ID and an episode ID linking attempts during one recovery.

| Field | Meaning |
| --- | --- |
| `reason`, `reason_code`, `original_reason` | Current explanation, stable category, and initiating reason carried through replacements. |
| `hp`, `vigor`, `threat` | Values when chosen. Threats are bounded cached visible bodies, not an attribution of attacks. |
| `chosen_refuge` | Named row/column, room, wall/exit kind, and an exit's destination. Null while selection is pending. |
| `path`, `path_length`, `path_source` | Clear geometry plan at selection. Movers may adjust around moving bodies. Unavailable plans are null, not invented straight lines. |
| `chosen_at`, `selected_at`, `activated_at`, `arrived_at` | Separate timestamps for choice, target selection, execution and arrival. |
| `status`, `phase`, `outcome` | Pending, approaching, active, recovering, yielded or ended; logoff/turn/freeze progress; and observed result. |
| `cancelled_at`, `cancel_reason`, `replacement_id`, `previous_decision_id` | Cancellation and its explicit successor. |
| `mitigation` | The observed circumstance that changes the usual choice. |
| `damage_taken`, `min_hp`, `end_hp`, `epoch` | Observed health losses, lowest sample, last observed health and movement code version. |

Cancellation installs the replacement before publishing the old decision's cancellation.
An old async result cannot complete a newer decision. A pending replacement has not yet
selected a target; its executor selects once and records the actual square before moving.
Reaching cover and recovering there are separate outcomes.

## Replacement rules

1. At a confirmed canonical safe wall, log off, reconnect, turn without leaving the
   square, and heal there. A predicted position alone does not establish shelter.
   Reclaiming the wall after reconnect checks the room and wall too.
2. If already reconnected and turned there, with no subsequent damage, preserve the
   health timer and continue healing. This is a `rest_safe` decision with an explicit
   `healing_already_armed` mitigation. Fresh damage permits another logoff. A failed
   turn remains explicit and must be retried before resting.
3. A blocked or interrupted approach tries another clear refuge. During travel the
   replacement can prefer forward cover or the onward exit, then a local wall after
   crossing. Failed approaches use the existing unreachable-spot memory. Replanning
   is bounded; a failed replacement falls back to `logoff_open`.
4. Off-wall logoff retains the existing freeze behaviour. It is a separate strategy
   because it can break engagement without restoring health. Existing freeze
   invalidation rules remain in place.
5. Explicit cancellation, keeper stop, or another controller owning movement produces
   `yield_to_controller`. It does not secretly restart the cancelled journey.

Automatic recovery preserves the destination and death counter. Active recovery runs
ahead of ordinary planners, including GOAP and BT. A route handed to logoff cannot
continue under its old movement generation. Recovery relinquishes its decision at
full health and the resting vigor cap; combat then chooses its quarry and wall through
the existing combat readiness gates. Initial recovery still selects the nearest clear
local wall. The exit/progress preference is available to a replacement after interruption.

These choices spend reconnect time and may delay travel or combat. An exit replacement
can trade a shorter local approach for progress out of the dangerous room. Successful
movement or observed recovery does not establish how many deaths were prevented.

## Postmortems and reporting

Keeper status exposes the current decision and age, plus persistence queue statistics.
Death records contain the active decision and up to 64 previous decisions, with at most
256 named path points each. Omitted history/path points are stated. The survival trace
links decisions to damage, movement operations and cancellation. Expanded death reports
show choices and cancellations in seconds before death, reasons, target squares, path
lengths and replacement IDs. Older records explicitly say this history is unavailable.

Lifecycle transitions, including successful recovery, are appended to
`substrate/survival-decisions/`, per fleet, process and day. Writes are asynchronous and
bounded; errors and dropped writes are visible in keeper status. A process exiting
before its queue flushes can leave an unfinished record. That is unknown, not evidence
of death. Postmortems independently preserve the in-memory history.

From the production checkout:

```powershell
node tools/m59-survival-decisions.mjs --since 24h
node tools/m59-survival-decisions.mjs --since 7d --json
node tools/m59-survival-decisions.mjs --dir C:/path/to/survival-decisions --since 24h --json
```

The report groups by strategy and code epoch: choices, activations, arrivals,
replacements, outcomes, recovery/death episodes, unknown episodes, elapsed time, planned
distance and damage. A chain can include several strategies, so they share an outcome
and are not independent trials. These are associations, not estimates of lives saved.
Compare similar starting HP, threats and routes; use controlled shadow trials to establish
whether a strategy causes better survival.

`m59-survival-decision-test.mjs` covers atomic replacements, both cancelled mover paths,
stale arrival, ordinary fallback, another wall after blockage, logoff/turn at a safe wall,
fresh damage, failed turns, controller cancellation, bounds and successful/unknown reporting.
Track shelter, survival handoff, trace, death observation, rest, pass-order and safe-spot
tests cover the integration boundaries.
