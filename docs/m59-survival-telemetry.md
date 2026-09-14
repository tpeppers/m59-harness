# Evidence for deaths during shelter and recovery

Death records now include `survival_trace.version: 1`. The existing `frames`,
`decisions`, `hits`, summary and killer attribution remain available. The trace
records choices and their execution without changing thresholds, movement fallback,
freeze handling or the order of survival decisions.

This addresses gaps in the September 14 investigation: repeated frozen/stuck
messages displaced the selected refuge, a recovery await outlasted several hits,
and a standing movement claim was mistaken for the action actually in progress.
An announced wall also differed from the exit subsequently selected.

Read these fields together:

| Field | What it establishes |
|---|---|
| `events` | Selected decisions, refuge search result/counts, movement cancellation, operation begin/end/error, disabled blind-walk watchdog branch, and travel shelter stop counters. |
| `damage` | Health-loss pushes with cached position, nearby bodies, active operations and keeper context, even while a pass is awaiting movement. This lane is independent of decision traffic. |
| `active_operations` | Operations that had begun but had not returned when the death snapshot was captured. Each has an ID, parent ID, start time, target/details and starting movement generation. |
| `current` | Cached state at snapshot time; this may already be the Underworld. Earlier damage snapshots retain the room and bodies seen when health fell. |
| `limits`, `dropped`, `suppressed`, `context_errors` | Retention bounds, rows evicted, repeated notes suppressed, and failed context reads. Missing history is not proof that nothing happened. |

The announced forward wall appears as a `decision` with
`what: "taking the next wall on the route and mending there"`. The actual
`refuge_selected.detail.selected` is a separate fact. Its `source`, `onward`,
search counts and sharing/collision fields explain what the selector was given.
A null selection is retained too. This does not preserve every rejected candidate
or reconstruct an exact historical path through moving bodies.

`take_safe_spot` contains `refuge_exit` or `refuge_island_crossing` when those
routes run. A normal wall approach contains `return_to_spot`, then `walk_to`,
`approach_fine` and, when needed, `walk_fine`. Nested operations use async context
IDs; unrelated simultaneous operations do not become each other's children.
The return values are observations of what the existing helper reported, not an
independent certificate of safety. In particular, compare an exit's intended
destination against its end context's room before interpreting a successful result.

For a cancellation, compare `movement_cancelled`'s previous/next generation with
the pending operation's starting generation. A subsequent approach records its
attempt number and `fallback_after`, including the previous attempt's cancellation
and reason. The current fallback behavior is deliberately unchanged: telemetry can
show an approach continuing after a canceled attempt without claiming to fix it.

Every context separates the active `job`, an active/expired `busy` declaration,
the standing `movement_claim`, `inert`, and `suspended_journey`. It also includes
the last ladder stage, its age, `pass_started_at`, and the health/room observation
used to enter the ladder. A stage name may be the last completed stage when
`pass_started_at` is null; its age alone does not prove a blocked pass.

The policy projection includes the effective flee fraction, the configured journey
guard, current `travelAllows` answers, the blind-walk watchdog switch and relevant
rest, shelter, crowd and freeze settings. `configured` values are the keeper's
current policy object; an absent key may still have a call-site default or an
environment override. `shelter_callback_installed` establishes presence of the
callback, not whether its next invocation would divert.

Nearby objects are the nearest 24 attackable/player bodies within the first 2,048
cached room objects scanned. The snapshot reports totals, omissions and an
incomplete-scan flag. Coordinates use named `row`/`col` and protocol fine `x`/`y`.
Room numbers and `client_room_object_id` have separately named fields. Flags and
proximity establish neither monster intent nor the source of an individual hit;
continue using server text and final-blow attribution for that question.

Retention is per Session: at most 192 events and 64 damage samples from the last
30 minutes, plus at most 24 pending operations. Repeated selected journal notes
are limited to one per message per five seconds; the disabled-watchdog branch to
one per ten seconds. Repeated `frozen` and `NOT MOVING` notes are excluded. Generic
detail bounds are listed in `limits`. Counters are cumulative since collector
startup, not just the last death. Records are detached snapshots, so a late movement
completion cannot rewrite already captured evidence.

Collection makes no stat/room request, sends no packet and performs no per-event
disk write. `M59Client.vitals()` reads its existing stat cache. The trace is written
with the existing postmortem under `substrate/postmortems/` (or its configured
override); a process crash/restart before a death record loses the in-memory trace.
Diagnostics failures cannot suppress an action, and a failed current-context read
does not erase the retained events. Arguments are explicitly projected; rosters,
passwords and control-token values are not collected.

Verify rollout through the actual keeper's cached `/state`:
`autopilot_status.survival_trace.version`, `collector_pid` and `started_at`. A new
file on disk or a broker shell's status is not proof that an existing keeper loaded
it. Do not request `fresh=1` merely to verify telemetry: a refresh can wake a frozen
character.

Validation: `node tools/m59-survival-trace-test.mjs` exercises the real Session
health/cancellation hooks, keeper postmortem/refuge selector and return helper.
It covers noisy journals, pending recovery at death, cancellation fallback,
pre-Underworld damage, detached snapshots, concurrent operation parents, original
result/error identity, broken diagnostic reads and bounded retention/nearby scans.
The existing survival-handoff, track-shelter, death-observation, take-safe-spot,
rest and pass-order suites also pass. These are observability/behavior-preservation
checks, not evidence that a survival policy saves lives.
