# Death replay and scene reconstruction

The first question is whether the original death can be reproduced. A checksum proves that a file was not changed; it does **not** prove that its scene reproduces the death. This workflow keeps those two tests separate and refuses to publish strategy comparisons after a failed baseline.

## Standard first pass

0. Select a living checkpoint, preferably immediately before the relevant intervention. Verify its file checksum, code commit/source manifest, complete visible fine positions, and absence of capture errors or dropped frames. Restore and verify the scene. Run the original behavior three times. Each baseline must reproduce the death, room, approximate timing, and survival decisions, including selected refuges and paths.
1. If no intervention activation was recorded, test starting a named intervention at that checkpoint. The default candidate is `nearest_refuge`. No activation is not proof that every protection was disabled. Starting an intervention immediately is also different from merely enabling a policy threshold; the case says which experiment it performs.
2. If interventions activated, disable each recorded strategy separately, then their combination. Record whether the intended suppression actually happened. Do not count an unapplied variant as valid evidence.
3. If an intervention was replaced before completion, test continuing the first cancelled intervention. Suppress automatic movement cancellation, replacement decisions, and competing executors while retaining explicit operator stop. A refuge arrival may still transition into safe recovery. Record actual suppressions and the resulting decision history.
4. Keep deaths, observed recoveries, survival to the observation horizon, and invalid/unknown trials separate. Surviving the window is censored evidence, not a demonstrated life saved. Report run counts and the horizon. Repeat promising comparisons across more checkpoints and independent server realities before ranking policies.

If any baseline fails, the result is `baseline_not_reproduced`; no counterfactual strategy summary is produced. Errors, incomplete loads, and source mismatches also fail closed. Reproducing a death is necessary for this first pass, but does not certify hidden state or establish causality by itself.

## Capture without waiting for disk

Production keeper processes enable a replay recorder by default (`M59_REPLAY_CAPTURE=0` disables it). It copies existing protocol/controller caches once per second and at survival decision changes, damage, and movement cancellation. No game poll, git invocation, JSON serialization, or disk write happens inside the capture function. A worker thread performs source attestation, serialization and atomic file replacement.

The capture includes every visible room object up to an explicit 2,048-body budget, self and other players, named row/column and raw fine x/y, angle where known, health/mana/vigor, known inventory/equipment/abilities, effective keeper policy, controller state, and the active survival decision. Truncation, missing positions and predicted positions are marked. Secrets and account credentials are excluded from controller configuration.

The worker retains at most 120 frames / 16 MiB per keeper. Pending messages are bounded; saturation is recorded as dropped data instead of blocking survival. Fatal health updates seal the pre-death frames immediately. The later confirmed postmortem enriches the same bundle without replacing its original death time or pre-death frame window. Asking for a live postmortem does not create a death bundle.

Bundles live in `substrate/replays/` (or `M59_REPLAY_DIR`) and are private runtime evidence, excluded from git. The postmortem and death page carry the bundle path. Keeper status reports readiness, pending messages, dropped frames, errors, average/maximum capture time, and completed file writes. A postmortem's `queued` receipt is not itself proof that the background write completed: read/verify the bundle or check recorder status.

The harness stamp contains full commit, dirty status, Node version, and SHA-256 file manifest taken at recorder startup. Mutable deployment HEAD is not substituted for that identity later. Server commit and RNG state remain unknown unless independently attested. A dirty capture needs the exact matching files, not just checkout of its parent commit.

## One scene format and loader

`m59-scene.mjs` remains the scene schema and low-level placement/vitals implementation. Manual `save` prefers the same `scene_capture` cache projection as death recording. Old brokers fall back to the older, less complete capture and retain its limitations.

`m59-scene-staging.mjs` is the shared preparation layer used by scene CLI loads, FleetScratch scene establishment, and the shadow replay adapter. It:

- Resolves current actor identities; duplicate names need distinct scene keys/bindings. Captured object IDs are never trusted as restoration addresses.
- Rejects unbound player bodies, disables ordinary room generation during setup, holds monsters, creates missing monsters from known classes, and removes extra lab monsters.
- Restores exact fine coordinates and angle where recorded, six attributes/karma, current and maximum HP separately, mana and vigor/rest threshold. A wounded 12/50 character remains 12/50.
- Verifies actual room membership, extra bodies, positions, vitals and attributes; then verifies again at start. A quiet admin response does not mean the load succeeded.
- Keeps preparation separate from release. A held preparation receipt can be released later only after re-resolving and verifying its actors again.

The low-level `executeLoad` remains available for tools with their own bindings and preparation. Its `pause` option alone is a legacy timer stop, not an atomic world freeze. Use `prepareScene` for reconstructed room experiments. FleetScratch's scene establishment result exposes `start`, `cleanup`, and a serializable preparation receipt so a raid can finish its setup before starting.

```text
node tools/m59-scene.mjs save t4 --name before-raid
node tools/m59-scene.mjs load substrate/scenes/before-raid.json --require-native-hold
node tools/m59-scene.mjs capture-held substrate/scenes/before-raid.json.prepared.json --out held-native-scene.json
node tools/m59-scene.mjs release substrate/scenes/before-raid.json.prepared.json

node tools/m59-scene.mjs load scene.json --full-hp --vigor 200 --start
node tools/m59-scene.mjs load scene.json --no-monsters --start
```

Set `M59_ADMIN_HOST=127.0.0.1` and the intended lab maintenance port before loading. Loads never belong on a shared production server. `--full-hp` requires a known ceiling, and changes player HP only. `--vigor` accepts 0..200. `--no-monsters` removes captured monsters, removes extra room monsters during reconciliation, and keeps automatic monster generation off during the experiment. All changes are recorded under `scene.reload`; these are intentional counterfactuals, not faithful baseline loads. Restore a native world snapshot or call the staging handle's `cleanup` to restore the prior generation setting after a no-monster experiment.

Known inventory, equipment and ability mismatches currently refuse replay. The strongest way to restore those, item attributes, enchantments and other hidden object graphs is the complete native checkpoint below. A scene alone cannot reconstruct unknown enchanted-item modifiers from an item name or rarity grade. Do not replace those gaps with fabricated “equivalent” equipment.

## Native monster hold and start barrier

The separate, lab-only image in `docker/Dockerfile.scene` applies `server-patches/scene-hold` to an immutable archive of Meridian commit `1fb1f51478d14a2a7fa37a2bb5899899c0115c44`. The build validates patch/source hashes, compiles KOD and blakserv, and checks the resulting image labels. It does not edit `M59_ROOT` or replace a running server.

```text
node tools/m59-scene-server-build.mjs --check
node tools/m59-scene-server-build.mjs --build --tag m59-scene:lab-replay
```

`SceneHoldRoom` holds existing monsters and holds new monsters as they enter the prepared room. Core Monster movement, attack and sensory callbacks are suppressed. Behavior, random, spasm, offer, turning and enchantment timers retain their remaining durations. `SceneStartRoom` releases all room monsters within one top-level KOD message, so a timer cannot execute between the first and last release. Missing behavior on a newly reconstructed monster can be started explicitly with `fresh=1`.

This preserves the timers of an existing lab monster; it does not reveal the unknown timer phase of a production monster. It is not a global freeze of players, other rooms or external inputs. Custom monster subclasses that bypass core Monster handlers require their own validation. Stock servers remain usable with a weaker staging hold, which is explicitly reported and can be refused with `--require-native-hold`.

The staging handle's `snapshot()` and CLI `capture-held` enrich a held scene with authoritative monster HP, class, behavior state, hatred, walking effort, core timer durations and target references. Targets use scene keys and are rebound to current objects on load. A target outside the explicitly captured scene is refused. The loader verifies these fields before release. Newly created monsters without recorded native state are explicitly initialized into WAIT; preserving their constructor's LIMBO state would create an inert reconstruction.

## Complete native saves

The native checkpoint helper shares save-set discovery with `m59-shutdown.mjs`: `gameuser`, `accounts`, `striings`, `dynarscs`, and `lastsave.txt`. All four parts must belong to one successful timestamp. Capture detects concurrent replacement, checksums every part, and verifies the copied result. Native checkpoints contain account/world state and must stay private and outside git.

```text
node tools/m59-scene-server-save.mjs capture PATH_TO_SAVEGAME --out substrate/native-scenes/checkpoint
node tools/m59-scene-server-save.mjs verify substrate/native-scenes/checkpoint
node tools/m59-scene-server-save.mjs restore substrate/native-scenes/checkpoint --container m59-replay-lab
```

Capture copies the last completed on-disk server save; its timestamp is reported. It does not pretend to be a fresh save taken at the command's wall-clock time. Restore refuses a running container or one without the explicit scene-lab label. Stop with the server's `terminate save`, never a bare forced stop. Native restoration preserves hidden object graphs much more fully than a client scene. It still does not restore the C library's RNG stream, TCP sessions, other clients' subsequent inputs, or a suspended JavaScript call stack.

The isolated image was booted at game port **17959**, maintenance **17998**, in container `m59-replay-lab`. The existing native shadow server at 15959/19998 and its other logged-in character remain separate. The replay adapter verifies the isolated container label and actual loopback port mappings before resetting it.

## Running a death comparison

A private config selects an existing lab roster/account. It never selects a fleet implicitly:

```json
{
  "fleet_file": "../fleets/replay-native.json",
  "agent": "shadow01",
  "require_native_hold": true,
  "native_snapshot": "../native-scenes/checkpoint",
  "players": {},
  "classes": {}
}
```

`players` maps other captured player names to explicitly selected shadow stand-ins. `classes` resolves a monster whose name is not uniquely covered by the generated class catalogue. `native_snapshot` is optional and is only accepted for the owned isolated container; when present, every trial starts by restoring the same complete native world. This also restores inventory lost in the previous trial, instead of treating a newly unarmed corpse as an equivalent baseline.

```text
node tools/m59-death-replay.mjs checklist BUNDLE.json
node tools/m59-death-replay.mjs run BUNDLE.json --config PRIVATE_CONFIG.json --frame FRAME_ID --baselines 3 --trials 3 --out REPORT.json
```

The adapter claims the roster/account before login, runs the real Session/Autopilot methods, restores the captured policy/controller state where possible, and closes its own client and leases on completion. An in-flight approach resumes toward the captured refuge; the report admits that the JavaScript stack was not restored. Lab-only variant controls cannot be enabled on production endpoints.

Each trial runs in a fresh Node process. The next trial begins only after that process exits, preventing an old resurrection or travel continuation, cached book, or mutable controller from carrying over. Native trial receipts include the actual image ID, server source/patch identity and native save checksums.

## What is and is not evidence

Offline tests cover corruption, incomplete frames, wrong fine offsets, missing/extra/duplicate actors, current-vs-max HP, source mismatch, failed-baseline gating, strategy suppression and worker persistence. Live measurements and repeated-run results are recorded in the implementation report for this change.

Older production deaths have no retroactive complete replay bundle. Their existing traces remain useful for diagnosis, but cannot become faithful saves by filling missing state with guesses. The new workflow begins collecting prospective evidence; controlled lab fixtures demonstrate the machinery, not that any production intervention has saved lives.
