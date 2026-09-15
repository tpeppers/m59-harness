# Replay state isolation and travel routing follow-up — 2026-09-15

The production shelter count veto is gone. A fresh cache-only audit at
11:35:50 UTC found all 23 keepers running movement revision `1744092`, which
includes removal commit `f421ce1`. Room population no longer refuses travel
refuges or recovery. Actual obstruction of the selected target or approach
still matters. The surviving six-monster threshold applies only to aggressive
quarry pulls and stationary melee. This audit made no production policy change
or restart.

The new shadow comparison suggests that soft routing threat costs are involved
in the repeated recovery loop. Two runs with the intended shelter baseline
completed the trip at full HP after those costs were disabled. This is still
one reconstructed scene; collision checks do not by themselves protect against
incoming damage, and removing threat costs globally is not validated.

## A confirmed replay isolation defect

The adapter used `replay-${process.pid}` as its runtime directory. Lab setup
copied baseline books only if their destinations did not already exist. Windows
reused two earlier process IDs, so a fresh process inherited an old shelter
book instead of the explicit frozen production snapshot requested by the runner.

The audit matched trial release/end windows to runtime uptime events, checked
directory creation dates and earlier events, and hashed the shelter book. For
both affected runs, the book's modification time preceded the trial, allowing
the unchanged file to establish the initial mismatch. A current hash alone
would not establish the initial contents of a book modified during the trial.

| Affected run | Reused scope | Scope created | Trial started | Classification |
|---|---|---|---|---|
| Production movement, no-cost trial 2 | `replay-50832` | 04:59:27 UTC | 10:18:07 UTC | Exploratory; different shelter baseline |
| Continuity candidate, no-cost trial 5 | `replay-21960` | 04:58:13 UTC | 11:20:27 UTC | Exploratory; different shelter baseline |

Requested shelter SHA-256:
`a25c5d93f9ac8a0379fcaa6e5cf15c0c2324dd49178e180ea305a04c73a4f2c4`.
Inherited shelter SHA-256:
`33d8024ec4afe86d23cdef7618d402066bb914c1ad33478741baab6c947d9e64`.

The other ten audited runs used the intended shelter book. In particular, the
three production controls and three continuity-only candidates were unaffected
by this defect. Their 2/3 versus 0/3 deaths and 0/3 versus 0/3 arrivals remain
observed outcomes with a verified shelter baseline. They did not record hashes
of every other mutable input, and server RNG/timer phases remain uncertain.

All raw trials, including the two mismatched runs, remain available. The
original routing-cost aggregate's `matched_provenance` field checked code and
loadout; it did not establish matching learned state. The
[earlier report](travel-routing-cost-repeats-2026-09-15.md) now states this
correction prominently. Its no-cost trials 3–4 both arrived alive with the
intended shelter baseline; trial 2 remains a separate survivor that reached
room 38 but not the captured destination, room 39.

## Fix and reporting contract

Replay workers now use an atomically created unique directory, even if the PID
or requested scope name was used earlier. Prior evidence folders are preserved.
Ordinary lab sessions remain persistent so deliberate learning is retained.

Every completed or rejected setup result includes a `runtime_environment`
receipt after environment initialization. It records initial destination hashes
and byte counts for shelter, bad-exit, prey-side and track-strike inputs, their
source/destination paths, and whether each was copied, retained or missing.
Failures before environment initialization cannot have that manifest.

The manifest is captured before importing the game engine. It is a snapshot;
later learned-state writes cannot rewrite it. Default isolated trials also
start a new engine process. Explicit callers that reuse an in-process adapter
receive an operation count and `reused_in_process` marker, because a fresh
scene does not erase module caches or earlier learning. Hashes in that mode
still describe environment initialization, not every later trial boundary.

This closes a harness-state fidelity gap. It does not claim exact server RNG,
timer phase, historical monster health or all configuration inputs are restored.

## Continuity candidate plus routing-cost experiment

The movement candidate is commit `99abe53`, retained on
`codex/death-replay-2026-09-14` with a release hold. It corrects fallback fine
coordinate/proof origins, preserves shelter checks during fallback, counts
actual onward progress after shelter, and preserves the suspended destination
through recovery. It does not change freeze invalidation or soft threat costs.

The experimental runner changes only `Session.threatsHere()` to return an empty
routing-cost list. Monster bodies, collision checks, shelter triggers and normal
recovery selection remain active (`recovery_route_override:false`). Three new
240-second trials followed the continuity-only trials. Each uses case 104:
Janice's lab-captured onward checkpoint in room 598, 49/49 HP, vigor 80,
14 monsters and destination 39. Every run uses a fresh native world restore and
verifies 15 actor positions plus the supplied loadout.

| Arm | Trial | Shelter baseline | Left room 598 | Reached room 39 | Outcome at 240 s |
|---|---:|---|---|---|---|
| Continuity, normal costs | 5 | Intended | No | No | Alive, 49/49 HP |
| Continuity, normal costs | 6 | Intended | No | No | Alive; last observed 49/49 before reconnect |
| Continuity, normal costs | 7 | Intended | No | No | Alive, 49/49 HP |
| Continuity, no soft cost | 5 | Different; keep separate | 11.1 s | 110.1 s, 49/49 HP | Alive, 49/49 HP |
| Continuity, no soft cost | 6 | Intended | 11.8 s | 108.4 s, 49/49 HP | Alive, 49/49 HP |
| Continuity, no soft cost | 7 | Intended | 11.1 s | 102.8 s, 49/49 HP | Alive, 49/49 HP |

The two new no-cost runs with the intended shelter baseline both completed one
safe-logoff recovery before arriving. This supports keeping recovery available
while investigating why the normal route revisits the same refuge. The earlier
normal-cost candidate trials completed 16 recoveries between them without
leaving the starting room. Neither group died within the window: this comparison
demonstrates improved progress in this scene, not a measured mortality decrease.

After arriving, the keeper resumed ordinary work toward room 544. That later
destination is not an abandonment of the already completed trip. Arrival and
room-exit times use one-second sampling and are approximate. The runs were not
randomized; original RNG, monster target memory and native timer phase were not
restored. The supplied loadout was captured later than the position checkpoint.

The candidate movement change remains held. Next comparisons need additional
starting positions and rooms, including cases where going closer to monsters
increases incoming damage. Count completed trips, abandoned trips, timeouts and
deaths separately. A movement policy that merely survives by repeatedly healing
has not demonstrated zero travel deaths per completed trip.

## Fix verification and subsequent native replay

The lab-environment, replay-environment and replay-provenance suites pass, as
do all 31 death-replay scenarios. The fresh-scope regression deliberately uses
the same process ID twice and changes the first trial's book: the next setup
must load the original baseline into a different directory, while leaving the
earlier trial's evidence untouched. Syntax and whitespace checks pass.

Native trial 9 tested the new setup with the same movement candidate and
no-cost hook. Its fresh directory was `replay-41764-W2oEvr`. The manifest
verified the requested 689,885-byte shelter baseline and the bad-exit book;
prey-side and track-strike inputs were explicitly missing. It was the first
operation in that process. All 15 actor positions and the supplied loadout
passed setup checks. It left room 598 at 11.1 seconds, reached room 39 at
67.2 seconds with 49/49 HP and remained alive at full HP at 240 seconds.
This later run is reported separately from the earlier six-run comparison.

Restore-to-start took **5.43 seconds**. The preceding three no-cost trials took
4.76–5.69 seconds, so this single check does not show a large new setup cost.
It is not a controlled performance benchmark. Trial 8 failed during the Docker
access check, before scene setup, and is retained with zero samples; it is not
counted as a survival trial. The retry used a new trial number and did not
overwrite that failure.

Execution base was `99abe53` with archived simulator edits. Its full execution
manifest is `d787cffcf81ad3657aea0423980508a837001246e49b55d08902699e9a22d5d4`.
Adapter SHA-256 is
`0e0bf94a323c483eb3ed902721de9e3ceb705488933c12abe5d17e3dc639ad15`;
lab-environment SHA-256 is
`ebb8046f2ffe8e31bde95ae2aca7dc1dd77b1134c5ce45bca77ee132bf5848d6`.

An independent production window from 10:08:57 to 11:40:49 UTC recorded zero
deaths and 50 positive-leg journey records on movement revision `1744092`.
These are not deduplicated end-to-end trips. Another 1,003 zero-leg records,
including 1,000 hk2 retries from room 49 to 370, are excluded from successful
travel. This short exposure window does not establish a zero death rate.

## Evidence

Private receipts are under `substrate/replay-smoke/travel-zero-2026-09-15/`:

- `replay-scope-audit-1789471978765.json`: all twelve audited initial shelter books.
- `travel-continuity-cost-summary-1789471978357.json`: six observed runs before
  separating the known baseline mismatch; use the audit alongside its totals.
- `trial-104-route-cost-natural-{5,6,7}.json` and process logs: complete traces.
- `travel-continuity-cost-repeat-progress.jsonl`: source checks and run order.
- `shelter-runtime-confirmation-1789472150447.json`: all 23 loaded production revisions.
- `fresh-replay-verification-1789472503924.json` and
  `trial-104-route-cost-natural-9.json`: native verification of the fixed setup.
- `trial-104-route-cost-natural-8.json`: retained Docker-access setup failure.
- `route-fix-exposure-1789472449242.json`: frozen production exposure window.

Shared runner SHA-256:
`db08a3eec48c774f3daf4286232962497104ef8e66db5632cfde7b754ec27980`.
Movement source hashes are unchanged across the continuity-only and new
no-cost runs: autopilot `daf55b1782a8a6682b117a76803fe08305b23bb4bd450c552aa131b7fa00f235`,
game `9cf70c56bb5f3441bb8a211df171c5cbb4b869b7062edfd20ca2544a94f0d4d1`,
skills `d667318ee1c440ef4573aa8cffd4e3cdbc6bfdb585454c84b92f3d9cc96d5aad`.
