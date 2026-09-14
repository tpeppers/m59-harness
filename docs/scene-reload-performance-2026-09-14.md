# Saved-scene reload performance — 2026-09-14

Repeated combat/travel scene restores now take **3.87 seconds median**, versus
**6.84 seconds** before: a **43% reduction in overhead**. All 13 measured warm
trials finished setup and cleanup within **4.29 seconds**. The first restore
after changing the snapshot or restarting/replacing the container still does a
full bootstrap; the optimized cold sample took **5.89 seconds**.

This is overhead, separate from the simulation window: a 10-second combat trial
will typically occupy approximately 14 seconds. A zero-duration trial measures
setup and is not evidence of survival.

## Measurements

The test ran on the isolated `m59-replay-lab` Docker container at loopback
17959/17998, limited to 2 CPUs and 1 GiB RAM. Each iteration restored the same
private native checkpoint, joined a fresh bot process, reconstructed the room,
verified the actors and player state, released the scene, then closed the bot
and released its leases. The fixture has one player, two rats and a mana node.
Setup-only comparisons used full HP and 200 vigor. CLI variant tests also
removed monsters and changed the retreat threshold.

| Measurement | Samples | Median | Range |
|---|---:|---:|---:|
| Previous complete restore/cleanup overhead | 3 | 6.840 s | 6.602–7.210 s |
| Optimized first cold restore, including cleanup | 1 | 5.892 s | one sample |
| Warm complete restore/cleanup overhead | 13 | 3.872 s | 3.694–4.287 s |
| Warm in-worker restore to released start | 13 | 3.686 s | 3.576–3.938 s |
| Previous native reset phase | 3 | 2.288 s | — |
| Warm native reset phase | 13 | 0.363 s | — |
| Previous ability read phase | 3 | 1.662 s | — |
| Optimized ability read phase | 13 | 0.653 s | — |

Complete overhead is the parent's elapsed time through child exit, minus the
measured simulation phase. The in-worker metric starts after process launch and
ends after verified release. Thirteen warm trials comprise five setup benchmarks,
six CLI runs with a one-second horizon, and two FleetScratch setup-only cases.
All loaded and verified successfully; each of the eight simulator cases also
passed known inventory/equipment/ability comparison. The short live windows were
functional tests, not death-reproduction or strategy-efficacy experiments.

The benchmark matrix used base `85a45f6` plus the simulator changes. After
integrating concurrently published main `3c49ea7`, two additional FleetScratch
cases passed with **3.714–3.769 seconds** of complete overhead (median
**3.742 seconds**). Those integration checks are recorded separately from the
13-sample comparison above.

The [machine-readable measurements](scene-reload-benchmark-2026-09-14.json)
contain phase times and setup status only; private saves and detailed traces
remain outside git. The previous three samples and first optimized cold sample
are small, and these results are specific to this host, world and scene. Larger
rooms or different host load can take longer.

## Changes

1. **Reload the native world in the running server.** One cold restore installs
   and verifies the checkpoint, including accounts. Later trials use the native
   `reload game` path, avoiding process startup and five Docker copy operations.
   Each trial still verifies host and installed checkpoint checksums. Container,
   image, start-time or snapshot changes invalidate the bootstrap cache.
2. **Acknowledge completion reliably.** The lab server preserves the maintenance
   caller during reload, so the adapter can require the actual completion reply.
   The server still refuses reload while a player is in game. No object-loader
   implementation was replaced.
3. **Read abilities when replies arrive.** The isolated lab waits for confirmed
   lists and complete ability-group replies instead of fixed 500/700 ms sleeps.
   Empty responses work; stale data, missing replies and failed initial reads
   fail setup. Request pacing and the normal production read path are retained.
4. **Expose one repeatable simulation loop.** CLI, FleetScratch and FleetScript
   share the same adapter and scene loader. Each case gets a pristine scene copy,
   its own policy/initial-state variation, a fresh bot process, and phase timings.
   Invalid setup/release/execution stops the loop with partial reporting.

Scene reconstruction itself was already fast: approximately **43 ms median**
before and after. Remaining overhead is mostly paced login/initial state reads
(about 1.6 seconds), abilities (0.65 seconds), client synchronization (about
0.5 seconds), native reset, process startup and verification. Reusing a bot
process would require proving that old movement/resurrection continuations and
caches cannot leak between trials; the current design retains that isolation.

## Fidelity and reset choices

Warm resets reload game objects, lists, strings and saved timers, restoring the
character/world state used by combat and travel. Account definitions stay from
the cold bootstrap. Use `native_restore: "restart"` if creating, deleting or
changing accounts is part of an experiment. `auto` is the default; older lab
images without the completion-acknowledgement capability use cold resets.

Neither reset reconstructs the C-library RNG stream, an old TCP session, future
inputs of other players, or a suspended JavaScript stack. A scene reconstructed
from production still has its recorded uncertainty. The existing baseline
reproduction gate remains mandatory for claims about lives saved. Simulator
reports explicitly remain exploratory.

## Validation and deployment

The new lab image was built from pinned server source
`1fb1f51478d14a2a7fa37a2bb5899899c0115c44`, with patch SHA-256
`208fd5ee9209289bc3f6b39c1485d1142f579c4ab69de70c48f8baaa0d549168`.
The running image is
`sha256:8eeef56bb320924591b0e53ddb61bbffeb2ca925158359830b1388f3f04bc098`.
Its predecessor is stopped and retained as
`m59-replay-lab-before-fast-20260914` for rollback. Production keepers and the
other native shadow server were not restarted for this optimization.

Thirteen new offline scenarios cover reset identity, checksum corruption,
missing acknowledgements, endpoint restrictions, response freshness, empty
ability lists, paired-case isolation, failure reporting and timing aggregation.
The existing death-replay, scene, FleetScript, FleetScratch and FleetScratch
session suites also passed: **24, 98, 301, 263 and 36** assertions/scenarios
respectively. Live CLI/FleetScratch runs above verify the actual
interfaces against the installed lab image.

See [usage and configuration](m59-death-replay.md#fleetscript-fleetscratch-and-cli-simulator-loops).
