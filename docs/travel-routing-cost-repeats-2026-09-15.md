# Ordinary recovery and routing costs: matched repeats — 2026-09-15

The monster-count shelter restrictions remain removed in production. These
experiments test a separate choice: whether monster-proximity costs help route
selection when actual body and wall collision checks remain active.

Across three fresh trials per arm, current routing had **2/3 deaths**,
**0/3 starting-room exits** and **0/3 arrivals at the captured destination**.
Removing only the soft proximity cost had **0/3 deaths**,
**3/3 starting-room exits** and **2/3 destination arrivals**.
These are observations from one reconstructed scene, not a fleet-wide survival
rate or proof that threat-aware routing is generally harmful.

## Comparison and fidelity

All six runs use commit `1744092a026c9e0f4fdd1f3dea079675accf539f`, the same
runner and ordinary recovery selection: `recovery_route_override:false`.
Each runs in a fresh process after restoring the same owned native lab baseline.
The runner alternates arms, with order reversed for the middle pair. The maximum
observation window is 240 seconds; death ends a run early. The engine and runner
are checked against fixed hashes before every run.

Case 104 is Janice's **lab-captured onward checkpoint**, after recovering to
49/49 HP, vigor 80, at r34c16 in room 598 with 14 monsters. It is not an exact
historical production save. Fine positions, supplied loadout and controller are
restored and checked. Original monster HP/target memory, RNG and timer phase
remain uncertain, and the loadout was captured later than the position. The
[previous fidelity discussion](travel-shelter-audit-2026-09-15.md#fidelity-limits)
applies. Neither arm changes freeze invalidation.

The experimental hook replaces only `Session.threatsHere()` with an empty
routing-cost list. It leaves live room objects, damage, refuge eligibility,
recovery decisions and physical collision checks intact. The four production
call sites use that list for route planning/replanning.

The [earlier trial 1 comparisons](travel-route-refuge-followup-2026-09-15.md)
are retained separately. They had a shared accidental recovery-selection
override and are not pooled with these ordinary-recovery repeats.

| Arm / trial | Whole-window outcome | First exit from room 598 | First arrival in room 39 | Final sampled room |
|---|---|---|---|---|
| Current routing 2 | Died at 216.5 s | No | No | 598 |
| Current routing 3 | Alive at 26/49 after 240 s | No | No | 598 |
| Current routing 4 | Died at 239.5 s | No | No | 598 |
| No proximity cost 2 | Alive at 49/49 after 240 s | 12.1 s, 41/49 | No | 38 |
| No proximity cost 3 | Alive at 49/49 after 240 s | 11.1 s, 49/49 | 68.3 s, 49/49 | 544 |
| No proximity cost 4 | Alive at 49/49 after 240 s | 90.7 s, 49/49 | 147.9 s, 49/49 | 350 |

Room milestones are taken from one-second samples, so their timing is approximate.
Arrival is checked across resumed movement, not only the first invocation's
`replayed_journey` receipt. The keeper continues its normal work after arriving;
later movement and any later deaths belong to the whole-window observation.
Destination changes are retained separately in the aggregate.

The first no-cost repeat reached room 38 at 117.6 seconds and stayed alive at
full HP while failing to climb to room 39. That is an escape from the danger
rooms, but not a completed trip. The second reached room 39 at 68.3 seconds
with 49/49 HP, then began ordinary travel to room 544. It had no completed
safe-logoff recovery before the original arrival. Survival therefore cannot be
credited to a shelter stop in that particular run.

The third no-cost repeat needed one safe recovery before leaving room 598 at
90.7 seconds. It reached room 39 at 147.9 seconds with full HP. The successful
crossings therefore include both a run with recovery and a run without a
completed safe-logoff intervention. Two of the three controls replaced the
original destination before the window ended.

## A reproduced death after successful healing

Current-routing trial 2 initially lost 31 HP and reached the safe wall at
r33c15. Its safe logoff/reconnect/turn recovery completed at 175.7 seconds,
at 49/49 HP. The next movement ended in death at 216.5 seconds, still in room 598.

The post-mortem explains an important ownership error. The old
`wantsForwardShelter` request remained after successful healing. Journey
resumption declined because a wall was supposedly still awaited. The farming
stage then continued and selected its assigned room 544, replacing the suspended
destination 39. Thus this is a travel death after the original objective was
replaced, not a death while continuing that original route.

The second departure's pivot walk fell back after one off-plan step. The fallback
continued for about 37 seconds without the route shelter check. Its next refuge
choice came at 7 HP, roughly 40 milliseconds before the death decision finished.
The full-health recovery worked; subsequent routing and control ownership did not.

## Additional faults reproduced offline

Three small probes call the actual shipped methods, without a game connection:

1. **Fallback coordinates and proof origin.** A call to `Session.walkTo`
   passed protocol x1068/y2198 directly to `traceFineMoveClient`, whose correct
   input for that point is x16064/y34144. Its route proof also began at the nominal
   stand point x15872/y34304 rather than the body's actual point. The two spaces
   are different in both scale and origin. Real room geometry confirms that these
   questions can produce different reachability answers.
2. **Ordinary steps suppress shelter.** Both single-step branches reset
   `legsSinceShelter` after every arrived step, including ordinary route squares.
   A fixture that becomes hurt after its first ordinary step then passes the
   offered refuge while reporting progress owed since a refuge it never visited.
   The suppression callback also dereferences a null stop, so its intended
   telemetry is swallowed by the caller's exception handler.
3. **Waiting on a journey still permits farming.** The real `passFarm` and
   `resumeSuspendedJourney` methods reproduce the first control's ownership
   problem: resumption reports waiting for the old shelter request, then farming
   proceeds while destination 39 is still retained. This can replace the journey
   with a farming assignment, as the live post-mortem demonstrates.

These probes establish implementation faults. They do not establish how many
lives each correction saves. The engine remained unchanged during the six-run
comparison so these faults could not silently alter one arm.

## Replay code labels corrected after the comparison

The six trials' full execution manifests correctly identify `1744092` and
matching source bytes. However, the replay adapter copied the source scene's
`b0887c8` commit into newly chosen survival decisions. Those individual epoch
labels must not be used to infer which code executed these trials. The original
receipts remain unchanged; the full manifests and this correction explain them.

The adapter now records `execution_provenance` separately from
`source_scene_provenance`. New decisions use the executing commit, and each
event includes its execution source hash and dirty state. A restored historical
decision retains its original epoch while its newly recorded actions also name
the executing code. The execution manifest is cached with the imported engine,
so a later checkout change cannot silently relabel that loaded engine.

The focused offline provenance test and all 31 death-replay scenarios pass.
A separate 30-second live smoke run produced three decision events with the
correct executing commit and source hash, while retaining the old scene commit.
Its source manifest is
`25bee5debd8208532522db06782ecef6358269bd6f459514b870afd199bae87b`;
the dirty-source receipt and archived adapter source identify the tested patch.
This verification is not pooled with the survival comparison.

The new first-process execution audit took 465 ms, making that smoke run's
restore-to-start time 5.17 seconds. The audit is cached for later trials in the
same adapter. This is a measured setup cost, not time spent pausing a live bot.

## Recommended next experiments

Retain ordinary recovery and compare narrow corrections to the actual fine
origin/proof and fallback shelter handling. Also test keeping a suspended
journey's ownership until it resumes or is explicitly retired, and clearing a
fulfilled shelter request when safe recovery completes. Correct the ordinary-step
progress counter and record suppression without inventing a selected refuge.

The cost-removal result justifies testing more starting positions and rooms,
including crowded approaches where avoiding an attacker may help. Globally
discarding the cost can trade a shorter route for more exposure to monsters whose
bodies do not physically block it. This experiment preserves collision checks,
but those checks alone do not predict incoming damage. The goal remains deaths
per completed trip, with stalled and abandoned trips reported alongside it.

## Production window and evidence

From 2026-09-15T10:08:57.074Z to 2026-09-15T10:38:30.586Z, production on `1744092` recorded
32 positive-leg journey records: 25 arrivals and 7 non-arrivals,
with 0 deaths. Another 322 zero-leg records were recorded separately.
These are journey records, not deduplicated end-to-end trips; the short window
does not establish an effectiveness change.

Private evidence is under `substrate/replay-smoke/travel-zero-2026-09-15/`:

- `trial-104-route-{fixed,cost}-natural-{2,3,4}.json`, raw operation/HP/decision
  traces, exact loadout verification and server/code attestations.
- `route-cost-repeat-progress.jsonl`, order and frozen source hashes.
- `route-cost-series-summary-1789468716478.json`, matched aggregate and destination changes.
- `route-fix-exposure-1789468710586.json`, frozen production window.
- `fallback-origin-probe-1789467438379.json`,
  `pivot-shelter-progress-probe-1789467487159.json`, and
  `suspended-farm-probe-1789467906968.json`, the offline reproductions.
- Control trial 2's native post-mortem is retained in its private
  `replay-55856` runtime, including the keeper notes explaining the destination change.

The shared runner SHA-256 is
`db08a3eec48c774f3daf4286232962497104ef8e66db5632cfde7b754ec27980`.
All six source receipts agree. Native restore through scene start took
4598–4723 ms.
Failed, nonfatal, delayed and divergent trials are retained.
