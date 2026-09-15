# Travel shelter handoffs — 2026-09-15

The monster-count shelter veto is already removed from production. The change
is in `f421ce1`, included in the running movement revision `1744092`. Production
is checked out at `1cb117f` (`deploy-2026-09-15-17`); that last commit changed
replay provenance and reporting and did not require another keeper restart.
The remaining crowd threshold governs pulling quarry and trading blows in
place. Shelter eligibility checks the particular target and approach for
occupancy and geometry, rather than banning shelter because of room population.

The new candidate below addresses separate movement and recovery defects. It is
**experimental and not deployed**. All three candidate replays survived versus
two deaths in three production controls, but none completed the journey.
Repeatable recovery loops prevent treating this as fewer deaths per completed
trip. The candidate is retained on `codex/death-replay-2026-09-14` with an
explicit release hold until that failure has been resolved and validated.

The [next routing experiment and startup-state audit](replay-state-isolation-2026-09-15.md)
found that removing soft threat costs let two further runs with the intended
shelter baseline complete the journey. The six runs in this report all passed
that shelter-baseline audit. The movement candidate remains held while broader
route and survival validation continues.

## Candidate changes

1. The fallback walker now traces from the actual fine position in client units.
   It previously supplied protocol coordinates directly to a client-coordinate
   trace and started its route proof at the nominal stand point. At the saved
   r34c16 origin, protocol x1068/y2198 means client x16064/y34144. Membership in
   separate proved route legs no longer authorizes a direct hop around a corner;
   the proposed hop must itself pass a trace from the current body.
2. Ordinary single steps no longer pretend that a refuge was just reached.
   The one-leg guard after a real shelter stop counts actual onward progress;
   a duplicate waypoint at the same square cannot pay that debt. The body-blocked
   single-step branch also honors shelter arrival. A deferred shelter note no
   longer dereferences a null spot or invents a selection.
3. Before each fallback move, a journey can hand recovery to the existing
   survival controller. It replaces interrupted intent explicitly, preserves
   the journey, invalidates its old movement, and executes the replacement
   immediately. A fresh recovery selects the nearest clear refuge; an already
   confirmed safe wall gets safe logoff priority. Existing health triggers,
   threat costs, geometry checks and packet pacing remain in effect.
4. Adopting a confirmed recovery wall fulfills the outstanding shelter request.
   A journey waiting for recovery or retry retains the destination instead of
   falling through into provision/farming and silently selecting another trip.
   This also means an intentionally disabled resume can hold ordinary work until
   the destination is explicitly cancelled or replaced.

Freeze invalidation is unchanged. The earlier experiment removing soft threat
costs is not part of this candidate.

## Native shadow comparison

The three production controls are the ordinary-recovery trials 2–4 from the
[routing-cost report](travel-routing-cost-repeats-2026-09-15.md). The candidate
uses the same runner, saved scene, native baseline, full loadout and 240-second
observation window, in fresh processes. Each starts at 49/49 HP and vigor 80 in
room 598, with 14 monsters, and intends to reach room 39.

| Build | Trial | Result within 240 seconds | Lowest HP | Left room 598 | Reached room 39 |
|---|---:|---|---:|---|---|
| Production | 2 | Died at 216.5 s | 0 | No | No |
| Production | 3 | Alive, 26/49 HP | 25 | No | No |
| Production | 4 | Died at 239.5 s | 0 | No | No |
| Candidate | 5 | Alive, 49/49 HP | 40 | No | No |
| Candidate | 6 | Alive; last observed 49/49 HP before reconnect | 42 | No | No |
| Candidate | 7 | Alive, 49/49 HP | 38 | No | No |

Candidate trial 5 completed five safe-wall recoveries and retained destination
39 throughout. It reached different refuges, ending at r39c22, with a smaller
grid distance to the exit than its starting square. The first shelter handoff started at 4.25 seconds
with 44/49 HP, followed by safe logoff at the confirmed wall.

Trial 6 completed six recoveries, all at r24c10. It left the wall, lost a few HP,
returned, healed, and tried again. Its final HP read is unavailable because the
character was reconnecting at the time limit; the preceding samples show 49/49.
This is a useful reproduced failure, even though it did not die.

Trial 7 also ended at r24c10 after five safe-wall recoveries, the last three
at that same wall. Across all three
candidate runs, there were 16 completed safe-logoff recoveries, zero deaths,
zero room exits, and zero destination arrivals. Their lowest HP values were
40, 42 and 38 out of 49. Restore-to-start took 4.82–5.02 seconds.

All three candidate trials kept the original destination. Production
controls 2 and 3 instead changed from room 39 to farming room 544 before arriving.

The trade-off is visible: early sheltering can preserve health while spending
most of a trial healing or revisiting the same wall. Survival to a time limit
must not be counted as arrival or evidence of zero travel deaths. The next test
needs to preserve these recovery handoffs while fixing the route that repeatedly
leads back into the same geometry failure, and then observe complete journeys.

These are small, unseeded exploratory samples, with controls run before the
candidate rather than randomized between them. Original RNG, monster target
memory, native timer phase and historical monster HP were not reconstructed.
The saved loadout was captured later than the original position checkpoint.
They demonstrate reproducible behavior, not an estimated fleet-wide death rate.

## Verification and reproducibility

Passing checks: travel continuity (22), route-refuge arrival (12), collision
(404), string pulling (11), survival decisions (23), journey resumption (149),
recovery refuges (11), forward shelter (17), track shelter integration, and
survival handoffs. Syntax and whitespace checks pass.

Two older suites fail identically on unmodified production and the candidate:
`m59-travelling-test` has four obsolete passive-rest assertions;
`m59-travelguard-test` stops at its missing `runCommand` fixture method. They are
recorded separately and are not counted as passing checks.

Candidate base commit: `1cb117f7bffd9df9aa5724b68c89e00ea4c68964`, with these
archived execution sources:

| File | SHA-256 |
|---|---|
| `m59-autopilot.mjs` | `daf55b1782a8a6682b117a76803fe08305b23bb4bd450c552aa131b7fa00f235` |
| `m59-game.mjs` | `9cf70c56bb5f3441bb8a211df171c5cbb4b869b7062edfd20ca2544a94f0d4d1` |
| `m59-skills.mjs` | `d667318ee1c440ef4573aa8cffd4e3cdbc6bfdb585454c84b92f3d9cc96d5aad` |
| Shared trial runner | `db08a3eec48c774f3daf4286232962497104ef8e66db5632cfde7b754ec27980` |

All raw evidence is retained under
`substrate/replay-smoke/travel-zero-2026-09-15/`: candidate
`trial-104-route-fixed-natural-{5,6,7}.json`, corresponding process logs,
`travel-continuity-repeat-progress.jsonl`, unique summary receipts, engine and
runner source archives. The offline origin check is
`fallback-origin-probe-1789470229703.json`; it confirms that neither wrong-unit
tracing nor the nominal proof origin remains in the candidate.
The complete comparison is `travel-continuity-summary-1789470910790.json`.
All three candidate restores verified 15 actor positions and the supplied
loadout; the three execution bundles match the source hashes above.

An independent production window, 10:08:57–11:03:28 UTC, recorded no deaths and
39 positive-leg journey records. These records are not deduplicated end-to-end
trips. Another 594 records were hk2's zero-leg 49→370 retry and are excluded from
successful travel. The frozen window is `route-fix-exposure-1789470208335.json`.
