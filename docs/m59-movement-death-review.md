# Historical movement death review

Run a bounded catalog and paired replay study without production RPC:

```
node tools/m59-movement-death-review.mjs scan substrate/postmortems --since 2026-09-22T17:12:46Z --until 2026-10-06T17:12:46Z --roster substrate/fleets/prod.json --out substrate/replay-smoke/catalog.json
node tools/m59-movement-death-review.mjs run PRIVATE_PLAN.json --out substrate/replay-smoke/review.json
node tools/m59-movement-death-review.mjs run PRIVATE_PLAN.json --out substrate/replay-smoke/review.json --resume
```

The catalog checks replay checksums, observed non-player attribution, and an explicit active or suspended travel objective. With a roster, it includes that roster's characters only; departed members require a separate scan. The chosen living frame has named row/column and consistent fine x/y. Automatic selection prefers a confirmed pose in the fatal room where an active journey stayed within eight fine units for at least two seconds while a recorded monster was within three squares. It uses the onset of the latest such stall; otherwise it prefers the last active journey episode, then an observed earlier active frame. Predicted frames cannot establish the selected stall. If only a suspended journey remains, the report keeps that state; it does not override recovery to force travel.

A private plan contains the shared loopback replay config, explicit historical/candidate roots, checkpoints, horizons and trial counts:

```json
{
  "config_file": "C:/private/replay-config.json",
  "baseline_runs": 3,
  "patched_runs": 3,
  "minimum_baseline_deaths": 2,
  "reload": {"labScenery": true, "exactMonsterPlacement": true},
  "cases": [{
    "id": "character-death-id",
    "character": "Recorded Character",
    "killer": "troll",
    "bundle_file": "C:/private/replay.json",
    "frame_id": "recorded-living-frame-id",
    "room": 597,
    "horizon_ms": 90000,
    "original_root": "C:/private/build-original",
    "patched_root": "C:/private/build-movement"
  }]
}
```

The config requires an explicit native_snapshot, fleet_file and agent. The shared shadow adapter verifies one of the two existing loopback lab ports, exclusive fleet/account ownership, scene placement, release, and player state. Every trial uses a fresh child process and resets the native world. Use the dedicated scene container when the shared shadow fleet is occupied. A timeout or failed cleanup requires an ownership check before continuation. Never delete a live/guarded lease.

Prepare original_root from the captured commit, then restore every file in the captured harness manifest from checksum-matched source bytes. A dirty capture is usable only if all recorded bytes can be recovered. The baseline must match the captured commit and every captured file; extra or missing source files refuse the run. Materialize historical compendium and substrate dependencies as well. Compendium files are not attested by the old harness manifest: keep their historical commit and document that coverage limit. Make patched_root an independent copy at the same commit. Apply only the intended movement changes to tools/m59-finepath.mjs, tools/m59-session-walk.mjs and tools/m59-world.mjs. A broader movement bundle may set each case’s allowed_files to the exact gameplay files changed by the selected commits, including an added movement helper. Original sources still reject every extra file; a candidate may add only an explicitly approved dependency with an attested non-null hash. Retain the commit list, per-hunk receipts and changed/added file list. Existing ancestor fixes are not reapplied. Compare the isolated exit patch and a broader movement/shelter bundle in separate reports.

Applying a historical backport requires reviewing all hunks and confirming no other file changed; a syntax check alone does not prove imports work.

Today's scene loader is shared between both arms because old loaders cannot reconstruct every recorded monster pose. The adapter's explicit engineRoot loads Session, Autopilot, movement, skills, survival state, journey hooks, replay variants and game globals from the selected historical tree. Decision recording uses that tree's WeakMap. Execution provenance identifies gameplay source; driver_provenance separately identifies the current loader and observer. Keep the common driver unchanged across a pair. Explicit historical engines require their own fresh worker and refuse missing modules rather than falling back.

Original trials run first. Invalid placement, source mismatch, player mismatch, cleanup failures and execution errors never count as reproduced deaths. A baseline fatality in another room or with an observed different killer does not reproduce the selected death. Known source/player/scene assumptions remain in each trial. Source attestation compares full file maps, not just Git HEAD or dirty status.

A preliminary screen can use one baseline and one patched trial with minimum_baseline_deaths=1. That is a small unseeded sample. Defaults use three trials per arm and require at least two baseline deaths. Classifications are:

- **plausible**: the baseline death recurs and a patched trial survives the same observation window or arrives alive at the recorded destination.
- **highly_improbable_at_checkpoint**: at least three usable patched trials all die in a reproduced baseline death room without arriving. This applies to this checkpoint/model only.
- **no_benefit_observed**: usable paired deaths without arrival, with insufficient samples for the stronger label or changed death room.
- **baseline_not_reproduced**: the original runs do not reproduce enough selected deaths. This leaves the effect unresolved.
- **inconclusive**: missing source/backport, incomplete/invalid trials, or a changed common driver.

The report's summary gives plausibly_fixed / paired_tested. Baselines that do not reproduce and invalid trials stay outside that percentage. Reports persist after each trial; --resume requires exactly the original plan and preserves completed evidence. Create a file named STOP_REVIEW beside the report to stop safely between trials/cases. Remove that marker before resuming; completed evidence is retained. A worker checks the marker before setup as well.

JSONL traces record poses, HP, travel ownership/objective, exit requests/results, and server combat messages. A suspended objective is recorded even when recovery owns movement. Check arrival_ms and the observation horizon: surviving a bounded window is censored, and arrival alone is not proof of long-term survival.

Client recordings are observed reconstructions, not native production saves. Monster HP, targets, RNG/timer phases, hidden item modifiers and exact JavaScript stack/counters may be absent. An explicitly approximate player uses the same shadow loadout in both arms and retains the mismatch receipt. Do not invent historical enchantments or promote a modeled survival into certainty about the original character. If baseline deaths cannot recur, examine earlier/later recorded checkpoints and improve missing state before interpreting the patch.

FleetScript exports scanTravelDeaths, runMovementDeathReview and summarizeMovementDeathReview. Use the same explicit private plan/config; the review does not dispatch to the FleetScript caller’s production fleet.

Offline checks:

```
node tools/m59-movement-death-review-test.mjs
node tools/m59-replay-provenance-test.mjs
node tools/m59-replay-environment-test.mjs
node tools/m59-replay-journey-test.mjs
node tools/m59-death-replay-test.mjs
```
