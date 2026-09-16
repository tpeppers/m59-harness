# World-tour progress monitoring

`node tools/m59-pilgrimage.mjs --fleet shadow --out substrate/tour-sim/run.json`
runs the existing circuit and automatically checks each bot for lack of progress.
Keep using the isolated lab roster/ports and the usual fleet identity preflight.

The live report defaults to `run.json.progress.json`. Use `--progress PATH` to
choose another new file. The final result contains the same `progress` object.
Console output reports count/identity changes even without an output file.

Defaults are `--stall-seconds 180` and `--leg-stall-seconds 600`. Three minutes
without a novel room/coarse position or HP gain flags `no_progress`. Ten minutes
without a checkpoint and three without a new room flags `checkpoint_overdue`,
including recovery loops. Completed legs reset the visited set; walking back and
forth through old squares does not repeatedly reset it. These thresholds are
configurable positive seconds. Long legitimate rests can be flagged for review.

Read `stuck_count`, `ever_stuck_count`, `stuck_episodes`, and `unknown_count`
separately. Actor rows name the character, destination, reason and elapsed times.
Stale/missing telemetry is unknown; explicit prolonged offline state is a distinct
stall reason. Finished one-pass actors are not considered stuck. The detector
observes and reports; it does not issue rescue movement or interrupt recovery.

`progressFromObservations` in `tools/m59-pilgrimage-progress.mjs` also accepts
legacy observer journals and timestamped checkpoint receipts. Old journals
without positions have less precise detection; report those flags as candidates.
Do not retroactively give an early observation credit for a later arrival.

Offline checks: `node tools/m59-pilgrimage-progress-test.mjs` and
`node tools/m59-pilgrimage-test.mjs`.
