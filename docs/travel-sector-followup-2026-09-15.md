# Travel follow-up: an unrelated door blocked Janice's exit approach

The longer Janice replay in [the travel review](travel-zero-review-2026-09-15.md)
survived its initial crisis but failed to complete its journey. Investigation of
its `collision_geometry_changed` refusals found a concrete identity bug: the
mover compared a server animation tag with a different numbering system used by
the room geometry. A live control reproduced eight false refusals on the exit
approach. Removing those false refusals is a correctness fix; it does not by
itself establish a life saved or a completed trip.

## The two sector identities

Native `clientd3d/roomanim.c`, `MoveSector`, applies a packet to every sector whose
`server_id` equals the packet's sector number. That number is a tag, and several
geometry sectors can share it. BSP leaves instead store one-based sector indices.
The compact collision bake previously omitted the tag table.

In room 598 (`i8.roo`), server tag 1 names the Qor door: zero-based geometry index
113, or one-based BSP sector 114. The native `i8.kod` room script uses this tag
to change its ceiling between 284 and 348. It does not name BSP sector 1.

The control received `SECTOR_MOVE`, tag 1, height 284, type 5, speed 0. From
r34c16, fine position `{x:1068,y:2198}` in BSP sector 68, Janice tried r35c15
and r47c14 in BSP sector 1. The old comparison rejected those unrelated targets
eight times between 222.6 and 230 seconds after release. This is direct evidence
for the false-refusal mechanism, rather than an inference from the final health.

## Change and retained restrictions

The mover now resolves packet tags to their geometry indices before deciding
whether an animation affects movement. Existing explicit door bindings remain
authoritative. The actual animated door is still restricted. A legacy map with
no tag metadata reports unknown identity and retains a conservative animation
restriction instead of guessing that a tag is an index.

The checked map now includes separately hashed tag tables for all 264 rooms.
The binding tool requires a raw room resource to reproduce every collision
payload byte, security value and relevant room field before accepting its tags.
All pre-existing map fields, exits, grids, collision hashes and the geometry
manifest are unchanged. The added metadata is 74,656 bytes. Of 264 sources,
263 matched the local server resources; the remaining Duke's Chambers resource
matched the installed client resource exactly. The mismatched server version was
rejected; its geometry was not substituted into the map.

Movement refusals now retain the packet tag, resolved geometry indices, missing
identity indicator and animation age through the public movement result. Scene
captures also copy the current cached animation record, so a future post-mortem
can inspect it. This is observation telemetry, not restoration of native door
timer phases. Survival freeze invalidation and recovery thresholds are unchanged.

## Shadow comparison

Both runs use the owned native `m59-replay-lab` server, the same Janice late
checkpoint, 15/49 HP, 14 monsters, modeled loadout, safespot snapshot and suspended
journey to room 39. The existing standing and immediate-handoff fixes are enabled
in both. The control changes only the animation tag comparison back to the old
tag-as-index behavior. The corrected run uses the new mapping.

<!-- SECTOR RESULTS -->
| Run | Observation | First full HP | Animation refusals | Final HP | Destination reached |
|---|---:|---:|---:|---:|---|
| Old tag comparison, 202 | 250 s | 216.5 s | 8 | 44/49, alive | No |
| Correct mapping, 202 | 250 s | 226.6 s | 0 | 35/49, alive | No |
| Correct mapping, 203 | 450 s | 226.7 s | 0 | 47/49, alive | No |

The longer corrected run evaluated the old rule alongside the real validation,
without using it to steer. Seven validations would have returned the old false
animation refusal. The corrected guard instead reached the ordinary collision
trace, which still found geometry or live-body obstructions. Removing a false
animation refusal does not mean that its requested path becomes clear.

That run left the original wall, made 30 movement steps, then cancelled travel
as wedged below the flee threshold. At 271.3 seconds, it selected safe logoff at
another confirmed wall, r24c10, with 13 HP; at 274.2 seconds it had reconnected
and turned to heal. It retained that wall and reached 47 HP by the endpoint.
The original destination, room 39, was never reached; all three runs remained
in room 598.

These trials confirm removal of the erroneous animation restriction and a
remaining travel/wedge problem. They demonstrate no additional life saved by
the sector fix: the control survived too, and the corrected 250-second run
ended with less HP. Do not rank survival effectiveness from those final totals.
The next experiment should target the onward route and its reachable recovery
stops, retaining this post-departure failure as a separate scenario.
<!-- END SECTOR RESULTS -->

Native monster RNG, timer phases and historical action flags are not fully
restored by this production capture. Trial labels do not imply a shared RNG
seed. The comparison can establish whether the erroneous restriction occurs;
different damage totals or recovery times alone cannot establish a survival
benefit. The adapter's `recovered` label means that a recovery completed sometime
during the observation, not that the trip completed or that the character ended
at full health.

The summary excludes missing HP samples during reconnect. It sums decreases
between valid sampled readings; healing between samples can hide some damage.
An initial private summary incorrectly treated missing health as both zero and
full health. The raw observations were unaffected and retained, and the summary
was corrected before drawing health conclusions.

## Production exposure after the prior rollout

The frozen ledger interval from September 15, 06:53:46 to 07:37:29.960 UTC
contains no death events. It contains 497 travel journey records, but 477 are
Marco Polo/hk2 retrying room 49 to 370 without completing a leg or leaving room
49. These are not 477 independently exposed trips. The remaining 20 records
contain 16 arrivals and four failures. Journey durations can straddle the window;
net start/end HP does not measure all damage taken during a trip.

At the 07:53 UTC post-mortem check, the latest file was still Piggy's 06:22 death,
before the prior movement rollout. This short observation is encouraging but
cannot establish zero travel deaths. The repeated room-49 routing failure is a
separate progress problem requiring investigation.

## Verification and evidence

Offline checks passed for sector identity binding and refusal scope, collision
(404 assertions), ceiling doors (5), door state (59), scene/replay behavior (31),
map sharing (8) and raw room geometry (832). Tests cover multiple sectors sharing
a tag, missing or corrupted metadata, rejecting a different geometry source,
preserving geometry hashes, allowing unrelated movement, and retaining the real
door refusal and its diagnostic fields. All 264 checked rooms retain valid
collision authority and the original geometry manifest.

Private evidence is in `substrate/replay-smoke/travel-zero-2026-09-15/` in the
death-replay worktree: full `trial-4-sector-old-*` and `trial-4-inspect-sector-*`
receipts, `sector-trial-summary.json`, `sector-refusal-offline.json`,
`sector-map-install.json`, source-binding receipts, test logs and
`current-exposure.json`. Exact experimental scripts and modified engine bytes
are archived by hash. Setup failures and earlier divergent trials remain on
disk. Runtime evidence and credentials are not committed.
