# Death replay and scene loader validation — 14 September 2026

The shared scene loader now reconstructs substantially more of a room, supports deliberate counterfactual reloads, and has a compiled native monster hold/start barrier. It is **not yet a 100% faithful replay system**. A live death replay reproduced the death but failed the timing criterion, and the comparison runner correctly stopped without attributing any lives saved.

## What changed

- Death capture copies fine positions and controller/SurvivalDecision state from existing keeper caches into a bounded background worker. It records damage, cancellation, decision changes and periodic checkpoints. Fatal damage seals the evidence; a later postmortem enriches the same bundle.
- The scene CLI, FleetScratch scene establishment and death replay adapter share preparation, placement verification and release. The loader creates missing monsters, removes extra monsters, suppresses room spawning during setup, restores player vitals/attributes and verifies actual room contents.
- Native held scenes also restore monster HP, class, behavior state, target references and remaining core timer durations. Targets bind to scene keys, independent of server object renumbering. The loader fixes newly created monsters remaining in LIMBO.
- A lab-only server patch holds core monster callbacks/timers during setup and releases room monsters in one KOD message. The image was compiled and booted successfully in a separate container.
- Complete native world checkpoints share save-set discovery with the existing shutdown/checkpoint tool. The adapter can restore the same checksummed world before every trial, including inventory lost on death.
- Each replay trial uses a fresh Node process. Returning from a trial waits for process exit, so a suspended resurrection or travel continuation cannot interfere with the next experiment.
- The standard checklist checks the baseline first, then tests activation, suppression of each executed strategy and their combination, or following through on the first cancelled intervention. Invalid, unapplied and censored results remain distinct.

## Live evidence

**Interpretation update:** the strict gate described below was the initial
implementation, not the current definition of useful evidence. Timing divergence
does not invalidate a repeatable failure. The [current replay workflow](m59-death-replay.md)
assesses recording fidelity separately and permits intervention experiments on
recurring deaths. The original measurements and report remain preserved.

Tests used the isolated container at game port 17959 / maintenance 17998. Its source is Meridian commit 1fb1f51478d14a2a7fa37a2bb5899899c0115c44, with scene-hold patch SHA-256 bf6b0db8a41860d32bdab9635202af2e92b26174358fadac80120fa2ee6a8188. Image ID: sha256:c1e6dd916b78baf8d4e70732fb27cbb14f38c564f8bb03d840dff509322c967b.

The controlled fixture used one shadow player at 3/36 HP and two 30-HP giant rats in room 39. The player stood at **r13c44, fine x2835/y869**. Both monsters had an explicit player target, attack state and a one-second initial behavior timer. The keeper was held in a stationary fixture state; this is a machinery test, not a recreation of a production death.

| Test | Observed result |
|---|---|
| Native hold | Both rats retained fine position and HP over a three-second hold; both reported held state. |
| Initial recorded run | Death after 13.594 seconds; all four room actors verified; 19 frames, zero dropped frames/errors. |
| Background recorder | One death bundle persisted, then enriched once; maximum capture/IPC-copy time 0.437 ms, mean 0.269 ms in this fixture. |
| First baseline replay | Death after 4.309 seconds; placement and native monster state verified; survival decision sequence matched. Timing diverged beyond the five-second tolerance. |
| Baseline gate | Rejected the baseline and ran **zero intervention comparisons**. No strategy efficacy conclusion. |
| Full-health variant | Restored the player from 3/36 to 36/36 HP and vigor from 80 to 200, verified before release. Four room actors remained. Survived the three-second smoke-test window at 36/36 HP. |
| No-monster variant | Verified only the player and mana node remained; ordinary monster spawning stayed disabled during the test. Survived the three-second window at 3/36 HP. |
| Trial isolation | Repeated native world resets and fresh child processes completed; the earlier stale-resurrection cleanup failure did not recur. |

The short option tests establish that the requested inputs load correctly. They are not evidence that a survival strategy saves lives.

Private evidence is retained under the development worktree's substrate/replay-smoke/: native-result.json, first-pass-report.json, options-report.json and bundles/. The native save is private world/account data under substrate/native-scenes/shadow-baseline and must not be published. Its completed server-save timestamp is 1789416000; it is not represented as an instantaneous production crisis save.

## Verification

The new offline suite passes 24 scenarios covering captured body completeness, asymmetric fine coordinates, duplicate/missing/extra actors, current versus maximum HP, checksum corruption, code mismatch, rejected baselines, counterfactual inputs, native target rebinding, timer checks, actual executor suppression, process-local replay controls, temporal rebasing, bounded critical-event capacity and background persistence.

Existing suites passed: scene (98), shadow scene (52), SurvivalDecision (16 scenarios), survival trace (6 scenarios), survival handoff regressions, death observation regressions and death presentation/analysis (82). A separate 201-actor cache-copy benchmark measured approximately 0.17 ms at the 95th percentile; this excludes the worker's serialization/disk work and is not a production load guarantee.

## Limits that matter when interpreting results

Production clients cannot observe server RNG state, exact monster HP/targets/timer phases, other clients' future inputs, or a simultaneous authoritative world snapshot. Their fine positions are the latest received observations; predicted or incomplete positions are explicitly rejected as baseline inputs.

Native saves preserve much more hidden state, but do not restore the C library RNG stream, TCP sessions or suspended JavaScript stacks. The hold barrier is for room monsters, not a freeze of players or the entire world. Unrelated rooms can continue consuming random numbers and running timers. Custom subclasses and enchantment/item object graphs require native checkpoint evidence beyond the portable monster scalar snapshot.

The observed timing divergence is consistent with these remaining uncontrolled factors; the test does not isolate which factor caused it. The current workflow retains that uncertainty as a recording-fidelity result while using recurrent deaths as experimental scenarios. There is no need to widen the timing tolerance or discard the death to do that.

Known inventory, equipment or ability mismatches refuse replay. Unknown state stays unknown. Old production deaths cannot acquire faithful pre-death saves retroactively. The recorder supplies prospective evidence and exact harness source manifests; intervention rankings need usable repeated scenario trials, with their scope, variation and observation horizons reported. A historical recording match is a separate, stronger claim.

Usage, configuration and CLI examples are in [the replay guide](m59-death-replay.md). Examples:

    node tools/m59-scene.mjs load scene.json --require-native-hold --full-hp --vigor 200 --start
    node tools/m59-scene.mjs load scene.json --require-native-hold --no-monsters --start
    node tools/m59-scene.mjs capture-held scene.json.prepared.json --out native-scene.json
