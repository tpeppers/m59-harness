# Monster cover during a PvP lull

Player combat retains first priority at every positive HP. During the existing
30-second danger window, when all known assailants are absent, a recent damaging
monster attack now permits movement to the closest available safe wall. Selection
uses the common recovery geometry, occupancy, path and exclusive-claim checks;
monster population alone is not a veto. The attacking monster must still be in
the room. No rest, logout or healing routine runs during this fallback.

A returning player cancels the shelter phase before another queued movement
packet can leave. Return fire can start while the old asynchronous movement call
is still unwinding. The same PvP survival decision retains ownership throughout.
Postmortems retain monster evidence, the actual chosen refuge and route, attempt
count, start/selection/arrival/interruption times and reasons. Monster hits do
not prolong the player danger window. Failed searches retry at most once per
second; an existing verified wall needs no movement.

## Shadow-server evidence

Three exploratory CV trials used the isolated Docker replay server on ports
17959/17998 and the shared native scene loader. The scene was derived from
`Rowlf-2026-09-15T22-27-15-480Z.json`, deliberately reduced to the victim, one
zombie and a temporary player with an opposing guild. Initial positions were
victim r8c16, zombie r8c18 and attacker r8c15. The victim started at 51/51 HP with
an approximate axe loadout; the attacker used modeled unarmed combat. The keeper
had a 67% ordinary survival floor. The attacker was relocated out at 4 seconds
and returned to r8c17. These are controlled behavioral tests, not faithful death
reproductions or estimates of wins against Morpheus's actual equipment.

The first 18-second trial exposed an approach defect: the selector offered the
clear four-step route to r5c17, but the close-range fine mover oscillated on open
floor until the attacker returned at 11 seconds. The queued approach was revoked
and player attacks resumed. The fallback now tries the shared square router
first with the recovery selector's occupied squares excluded; fine movement
remains available for a difficult wall pocket. Ordinary refuge handover behavior
is unchanged.

The second 18-second trial received no damaging monster hit during the player's
absence, so correctly did not seek cover. This is retained as non-triggering
evidence, not counted as successful wall arrival.

In the third, 30-second trial, the player returned at 23 seconds:

- The zombie hit at 6.875 seconds; the shelter decision started 2 ms later.
- The bot followed r8c15, r7c15, r6c16, r5c17. Confirmed shelter completed about
  **1.9 seconds after the hit**, at 46/51 HP.
- No further monster attack messages appeared while sheltered. The bot stayed
  on r5c17 until the player returned, without invoking healing or logout.
- The returning player interrupted cover at 23.020 seconds. The bot moved to
  engage and landed its first resumed attack **1.034 seconds later**.
- The PvP episode recorded 8 attack packets: 5 hits and 3 defenses. The victim
  survived the observation window at 50/51 HP. Normal regeneration explains HP
  gains; no special recovery maneuver was invoked.

All three trials verified temporary player/guild cleanup. They demonstrate
priority, arrival and preemption. They do not establish a fleet survival-rate
improvement. The first failure and non-triggering trial remain available.

Raw reports and matching scripts are retained in the development worktree under
`substrate/replay-smoke/`; each report includes execution provenance. SHA-256:

| Report | SHA-256 |
| --- | --- |
| `pvp-monster-shelter-smoke.json` | `d31402261d5ffb18f16532e4dbcf77f2c36b250f23a1ee2a540cd1dde502ec7c` |
| `pvp-monster-shelter-routed.json` | `88572928956c180a9dfbc2ed7e8508f18dd3992e5332496b91c609f91ff916ab` |
| `pvp-monster-shelter-long.json` | `a4a86bc4e5b900c7f3f22eb415fa9dd381fca184ddec439fe840cb10e9148053` |

## Regression checks

Passing: 59 combat-mode scenarios, 24 survival-decision scenarios, 16 refuge
posture scenarios, 11 recovery-refuge scenarios, 12 route-arrival scenarios,
242 safe-spot assertions, 6 survival-trace scenarios, combat integration,
packet-scope isolation and 32 death-replay scenarios. Coverage includes return
fire while shelter is awaiting completion, cancellation of an already queued
movement packet, actual shared refuge selection, failed-search backoff, safe-wall
hold without healing, danger expiry and preservation of arrival time when a
returning player interrupts cover.
