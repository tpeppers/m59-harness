# Death replay and scene reconstruction

The useful question is whether the reconstructed scenario produces repeatable failures we can investigate and improve. A death at a different time, refuge or route location may still reveal a useful flaw. Keep that evidence. Checksums, recording fidelity, failure recurrence and intervention outcomes answer different questions; none should silently replace the others.

## Standard first pass

0. Select a living checkpoint, preferably immediately before the relevant intervention. Verify the file checksum and scene setup, stamp the actual replay code, and retain capture gaps. Run the baseline three times. By default, at least two usable deaths allow intervention experiments on that reconstructed scenario. Keep every nonfatal, divergent and invalid run as well. Compare source identity, timing, room, decision sequence, selected refuges and paths with the original recording as a separate fidelity assessment.
1. If no intervention activation was recorded, test starting a named intervention at that checkpoint. The default candidate is `nearest_refuge`. No activation is not proof that every protection was disabled. Starting an intervention immediately is also different from merely enabling a policy threshold; the case says which experiment it performs.
2. If interventions activated, disable each recorded strategy separately, then their combination. Record whether the intended suppression actually happened. Do not count an unapplied variant as valid evidence.
3. If an intervention was replaced before completion, test continuing the first cancelled intervention. Suppress automatic movement cancellation, replacement decisions, and competing executors while retaining explicit operator stop. A refuge arrival may still transition into safe recovery. Record actual suppressions and the resulting decision history.
4. Keep deaths, observed recoveries, survival to the observation horizon, and invalid/unknown trials separate. Surviving the window is censored evidence, not a demonstrated life saved. Report run counts and the horizon. Repeat promising comparisons across more checkpoints and independent server realities before ranking policies.

Finish all requested baselines rather than stopping at the first mismatch or survivor. The default `reproducible-death` criterion accepts recurring deaths despite timing, room, decision or code differences. Report the scope as an experiment on the reconstructed scenario; a similar or identical root cause requires trace evidence, not merely two deaths. A close behavioral match supports recording fidelity without proving hidden-state identity.

Failed placement/release verification, known player-state mismatches, execution errors and unknown outcomes do not count as usable deaths. Their raw rows and exclusion reasons remain in the report. Code/capture differences are fidelity caveats in the default mode. `--criterion recorded-behavior` retains the stricter recording check, including exact captured source and close timing/decision/room matches, when that is the question being asked. Neither a strict rejection nor a later error erases observed outcomes.

## Capture without waiting for disk

Production keeper processes enable a replay recorder by default (`M59_REPLAY_CAPTURE=0` disables it). It copies existing protocol/controller caches once per second and at survival decision changes, damage, and movement cancellation. No game poll, git invocation, JSON serialization, or disk write happens inside the capture function. A worker thread performs source attestation, serialization and atomic file replacement.

The capture includes every visible room object up to an explicit 2,048-body budget, self and other players, named row/column and raw fine x/y, angle where known, health/mana/vigor, known inventory/equipment/abilities, effective keeper policy, controller state, and the active survival decision. Truncation, missing positions and predicted positions are marked. Secrets and account credentials are excluded from controller configuration.

The worker retains at most 120 frames / 16 MiB per keeper. Pending messages are bounded; saturation is recorded as dropped data instead of blocking survival. Fatal health updates seal the pre-death frames immediately. The later confirmed postmortem enriches the same bundle without replacing its original death time or pre-death frame window. Asking for a live postmortem does not create a death bundle.

Bundles live in `substrate/replays/` (or `M59_REPLAY_DIR`) and are private runtime evidence, excluded from git. The postmortem and death page carry the bundle path. Keeper status reports readiness, pending messages, dropped frames, errors, average/maximum capture time, and completed file writes. A postmortem's `queued` receipt is not itself proof that the background write completed: read/verify the bundle or check recorder status.

The harness stamp contains full commit, dirty status, Node version, and SHA-256 file manifest taken at recorder startup. Mutable deployment HEAD is not substituted for that identity later. Server commit and RNG state remain unknown unless independently attested. A dirty capture needs the exact matching files, not just checkout of its parent commit.

## One scene format and loader

Position confirmations must wait for a new room snapshot even when unsolicited
snapshots have put the received count ahead of the requested count. Scene setup
exposed a two-snapshot surplus: confirmation returned early, a fine mover acted
on an older position, and the keeper reported a wall arrival the server had
already undone. Requests now advance beyond both counters. Replay protocols
before the September 15 protocol-5 travel comparison retain useful failures but
must not be pooled with corrected trials to estimate intervention effectiveness.

Captures now include freeze retry counters, the last sent rest/stand command,
and room-snapshot request/receive/loss counters. The posture command is evidence
of an action sent, not confirmation of the server's posture or action flags.
The replay adapter restores captured keeper activity and retry counters and
starts its watchdog before resuming an in-flight approach. Old captures still
need explicit assumptions for missing counters and server action state.

`m59-scene.mjs` remains the scene schema and low-level placement/vitals implementation. Manual `save` prefers the same `scene_capture` cache projection as death recording. Old brokers fall back to the older, less complete capture and retain its limitations.

`m59-scene-staging.mjs` is the shared preparation layer used by scene CLI loads, FleetScratch scene establishment, and the shadow replay adapter. It:

- Resolves current actor identities; duplicate names need distinct scene keys/bindings. Captured object IDs are never trusted as restoration addresses.
- Rejects unbound player bodies, disables ordinary room generation during setup, holds monsters, creates missing monsters from known classes, and removes extra lab monsters.
- Restores exact fine coordinates and angle where recorded, six attributes/karma, current and maximum HP separately, mana and vigor/rest threshold. A wounded 12/50 character remains 12/50.
- Verifies actual room membership, extra bodies, positions, vitals and attributes; then verifies again at start. A quiet admin response does not mean the load succeeded.
- Keeps preparation separate from release. A held preparation receipt can be released later only after re-resolving and verifying its actors again.

The low-level `executeLoad` remains available for tools with their own bindings and preparation. Its `pause` option alone is a legacy timer stop, not an atomic world freeze. Use `prepareScene` for reconstructed room experiments. FleetScratch's scene establishment result exposes `start`, `cleanup`, and a serializable preparation receipt so a raid can finish its setup before starting.

Both shared release paths reconcile player regeneration with the server's normal `NewHealth` and `NewMana` handlers and verify that required timers exist. Raw stat assignments alone can turn a full-health lab character into a wounded character with no health timer, making a valid turn-and-rest experiment falsely appear unable to heal. Existing timers retain their phase; newly required timers use the normal interval. This does not grant health, force the moved-since-entry flag, or certify a safe wall. A post-login action still has to arm healing, and a turn is safe only when the character actually retains shelter. Release receipts include `player_vital_timers` and the measured preparation timestamps.

With explicit `labScenery`, ordinary items created by room-entry hooks are included in the prepared scene and reported as `include_entry_lab_item`. Extra players and monsters still fail verification. Faithful scenery loads retain their strict actor check.

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

`players` maps other captured player names to explicitly selected shadow stand-ins. `classes` resolves a monster whose name is not uniquely covered by the generated class catalogue. `native_snapshot` is optional and is only accepted for the owned isolated container; when present, every trial starts by restoring the same native world. This also restores inventory lost in the previous trial, instead of treating a newly unarmed corpse as an equivalent baseline. Account definitions are restored at the initial cold bootstrap; see the warm-reset contract below.

```text
node tools/m59-death-replay.mjs checklist BUNDLE.json
node tools/m59-death-replay.mjs run BUNDLE.json --config PRIVATE_CONFIG.json --frame FRAME_ID --baselines 3 --trials 3 --out REPORT.json
node tools/m59-death-replay.mjs run BUNDLE.json --config PRIVATE_CONFIG.json --baselines 8 --min-deaths 2 --horizon-ms 60000 --hypothesis "travel stalls before refuge arrival" --out LONGER_REPORT.json
node tools/m59-death-replay.mjs run BUNDLE.json --config PRIVATE_CONFIG.json --criterion recorded-behavior --out FIDELITY_REPORT.json
```

`--hypothesis` labels an investigation question; it never asserts that the root cause is confirmed. `--horizon-ms` applies to all cases in the experiment. Default recurrence is two deaths across three baseline runs; increase the run count/window for intermittent failures. An explicit `--baselines 1 --min-deaths 1` permits a single-observation exploratory test and labels it `single_death_observed`, never repeatable.

Version 2 reports separate `validation.failure_reproduction`, `validation.recording_fidelity`, technical `trial_assessment`, and per-run `recording_match`. `validation.valid` means the selected baseline criterion qualified for comparisons; it does not certify every variant or establish a life saved. `execution` counts unusable trials. Strategy rows retain all usable observations under `observed`, and separate confirmed intervention outcomes from `unapplied` and invalid trials. Experiments choose intervention cases from protections actually activated/cancelled in the usable baselines, preserving the recording's original checklist for context.

The CLI atomically saves a report after every completed trial and at the end. The default filename includes a timestamp, preserving previous reports. An explicit `--out` selects the file to update. Insufficient recurrence still produces a baseline outcome summary; later trial or cleanup failures retain earlier results and summaries.

The adapter claims the roster/account before login, runs the real Session/Autopilot methods, restores the captured policy/controller state where possible, and closes its own client and leases on completion. An in-flight approach resumes toward the captured refuge; the report admits that the JavaScript stack was not restored. Lab-only variant controls cannot be enabled on production endpoints.

An active journey also needs process-local callbacks. Replay reconstructs them
through `goTravelling` before restoring the recorded deadline and retry count;
copying `inert.travelling` alone makes the normal initializer return early and
silently omits route shelters. Explicitly disabled shelter guards remain disabled.
Resumed journeys use `Autopilot.travel`, including its room-boundary recovery
hook, rather than bypassing that wrapper. Trial receipts include
`controller_restore.journey` and the completed `replayed_journey` result when
available. A still-running or interrupted journey is not an arrival. Routes are
replanned from the captured position; this does not restore a JavaScript stack,
the exact original waypoint list, or historical per-journey stop counters.

Each trial runs in a fresh Node process. The next trial begins only after that process exits, preventing an old resurrection or travel continuation, cached book, or mutable controller from carrying over. Native trial receipts include the actual image ID, server source/patch identity and native save checksums.

## Fast repeated restores

The default `native_restore: "auto"` performs a full container restart/restore once per snapshot and container lifetime. Later trials use blakserv's native `reload game TIMESTAMP`, keeping the process and installed save files in place. Game objects, lists, strings and saved timers reload; account definitions remain from the verified cold bootstrap. Use `native_restore: "restart"` for experiments that create/delete/change accounts or require an account reset every trial. A warm reload is appropriate for combat/travel experiments, but is not a C-runtime or RNG rewind.

Warm reload requires the lab image label `org.openai.m59.scene-reload.ack=v1`. The lab patch preserves the requesting maintenance connection until the existing reload completion reply, while retaining the server's refusal to reload with players in game. `auto` falls back to cold restores on older images; `native_restore: "reload"` requires this capability (and still cold-bootstraps if the cache is missing). The private `.reload-cache.json` records snapshot hashes, container/image IDs and start time. Changing any of those forces a new bootstrap. Every warm trial rechecks the host checkpoint and installed save hashes; an unexpected installed-file mismatch is refused.

The isolated game port 17959 also permits response-driven initial ability reads: list replies must arrive before requesting positional ability groups, and both requested groups must finish. Empty groups count as replies; stale data and timeouts do not. Packet pacing is unchanged. `fast_reads: false` restores the fixed-wait path for a comparison. Other servers keep their existing behavior.

On the 2026-09-14 four-body fixture, 13 warm trials took **3.69–4.29 seconds** of total restore/cleanup overhead (median **3.87 seconds**). Three prior cold-only trials took **6.60–7.21 seconds** (median **6.84 seconds**). The optimized first cold trial took **5.89 seconds**. These exclude the requested simulation time. See [the benchmark report](scene-reload-performance-2026-09-14.md) for measurement boundaries and raw results.

## FleetScript, FleetScratch and CLI simulator loops

The shared `simulateScene` loop resets between every case/trial, runs cases in paired order, and returns outcomes, setup verification, controller decisions, intervention application, server/native-save identities and phase timings. `horizonMs: 0` measures setup only and reports `setup_only`. A failed load, release or execution stops the loop and preserves partial evidence in the output report. Native world restoration still uses the same private replay config above.

Put a simulation definition beside its scene and private replay config:

```json
{
  "scene": "before-raid.json",
  "configFile": "replay-config.json",
  "trials": 5,
  "horizonMs": 10000,
  "cases": [
    {"id": "as-captured"},
    {"id": "full-health", "reload": {"fullHp": true, "vigor": 200}},
    {"id": "empty-room", "reload": {"noMonsters": true}},
    {"id": "earlier-retreat", "policy": {"fleeBelow": 0.6}},
    {"id": "without-refuge", "variant": {"kind": "disable", "strategies": ["nearest_refuge"]}}
  ],
  "out": "simulation-report.json"
}
```

Paths in the JSON resolve relative to that file. CLI:

```text
node tools/m59-scene-simulator.mjs substrate/scenes/simulation.json
```

At the FleetScratch prompt:

```text
simulate substrate/scenes/simulation.json
```

FleetScript authors can invoke the same exported API from an explicit simulation driver:

```js
import {simulateScene} from './tools/m59-fleetscript.mjs';
const report = await simulateScene({
  scene: 'substrate/scenes/before-raid.json',
  configFile: 'substrate/scenes/replay-config.json',
  trials: 5, horizonMs: 10000,
  cases: [{id: 'captured'}, {id: 'full', reload: {fullHp: true, vigor: 200}}],
  onTrial: row => console.log(row.case, row.outcome, row.timings)
});
```

This is an explicit simulation API, not a production errand step; importing/compiling a FleetScript does not run it. It never chooses an implicit account. Keep scene captures, native checkpoints, roster files and detailed simulation reports in private runtime storage.

Simulation reports are marked `exploratory`, with `baseline_reproduction_verified: false`. They expose intervention application so an inactive variation is not mistaken for an effective one. Reproducible deaths are useful regardless of exact recording similarity. Use `m59-death-replay.mjs run` to measure recurrence and compare interventions while recording fidelity separately. A strategy that improves this lab scenario is evidence worth investigating, even when it cannot establish that the particular historical death would have been prevented.

## What is and is not evidence

Offline tests cover corruption, incomplete frames, wrong fine offsets, missing/extra/duplicate actors, current-vs-max HP, source/fidelity differences, recurring deaths, nonfatal/invalid trial retention, observed-strategy selection, suppression and worker persistence. Live measurements and repeated-run results are recorded in the implementation reports.

Older production deaths have no retroactive complete replay bundle. Their existing traces remain useful for diagnosis, but cannot become faithful saves by filling missing state with guesses. The new workflow begins collecting prospective evidence; controlled lab fixtures demonstrate the machinery, not that any production intervention has saved lives.

## Postmortem PvP simulations

`m59-postmortem-sim.mjs` loads a checksum-verified replay bundle from a postmortem and creates temporary, account-backed player characters for every other captured player. It defaults to the latest living checkpoint containing the confirmed player killer. A nearby player is never automatically treated as the killer. Select other attackers or an earlier frame explicitly.

```text
node tools/m59-postmortem-sim.mjs plan POSTMORTEM.json
node tools/m59-postmortem-sim.mjs run POSTMORTEM.json --config PRIVATE_CONFIG.json --trials 3 --horizon-ms 15000 --out REPORT.json
node tools/m59-postmortem-sim.mjs run BUNDLE.json --config PRIVATE_CONFIG.json --attacker Morpheus --frame FRAME_ID --out REPORT.json
```

Each pair runs the captured victim controller against (1) the selected players attacking and (2) the same player bodies standing idle. Every case reloads independently. Attackers use ordinary, paced CombatMode melee packets, pursue only within the captured room, and stop below 5% health or at the time limit. They start after the shared room-release barrier. Account creation uses a validated ordinary character request, verifies all six attributes, recalculates normal server PvP eligibility after stat restoration, and verifies account deletion after each trial or handled error. Linux scene images must advertise `org.openai.m59.scene-accounts.delete=v1`; rebuild with `m59-scene-server-build.mjs` if missing. The owned isolated container at 17959/17998 is required for automatic stand-ins; the separate shadow server and production endpoints are refused.

Other players' equipment, attributes and actual human inputs are usually unknown. Without a supplied or captured native loadout, the model is **unarmed melee**, with the `melee` creation preset, 100 HP, 50 mana, 200 vigor and 99 punch. Known captured vitals/stat fields take precedence; unknown fields use the profile. A JSON/API `profile` can change `stats` (creation preset), `health`, `mana`, `vigor`, and `unarmed`. An explicit loadout replaces inventory/equipment and the entire skill/spell lists, including the creation profile's punch ability. Keep the same profile and loadouts across compared cases. This model cannot certify the historical fight's difficulty.

Strict loading is the default. Optional approximations are explicit:

- `--approximate-player` uses the selected shadow victim's inventory/equipment/abilities when they differ from the capture; the mismatch is retained in `player_state.original_check`.
- `--no-monsters` removes captured monsters and suppresses automatic room spawns during the trial. Reactive consequences such as a revenant summoned by a murder can still occur.
- `--lab-scenery` retains the lab snapshot's room items/scenery instead of restoring recorded drops, corpses and temporary effects such as loose soil. The report lists the replacement; this can affect collisions and must be held constant between cases.

Without these options, an unknown monster class, missing item binding or mismatched victim loadout stops the experiment. `classes` in the private replay config can resolve known monster KOD classes. A missing historical replay bundle is refused; prose cannot supply the absent positions.

The shared FleetScratch `simulate` command and `m59-scene-simulator.mjs` accept a postmortem simulation definition:

```json
{
  "postMortem": "../postmortems/DEATH.json",
  "configFile": "replay-config.json",
  "trials": 3,
  "horizonMs": 10000,
  "approximatePlayer": true,
  "profile": {"stats": "melee", "health": 100, "unarmed": 99},
  "reload": {"noMonsters": true, "labScenery": true},
  "out": "pvp-report.json"
}
```

FleetScript exports `planPostMortemSimulation` and `simulatePostMortem`. For intervention experiments, feed `plan.scene` to `simulateScene` and attach `pvp: plan.options` to each case alongside its `policy`, `variant`, and `reload`. This reuses exactly the same scene, stand-in and controller machinery.

Reports retain temporary-to-captured player identities, source/save/image hashes, creation verification, normal PvP eligibility, attack attempts, refusal messages, victim HP pushes across reconnects, raw death messages, mapped killer attribution, survival decisions and cleanup receipts. `attacks` counts packets attempted, not successful hits; inspect refusals, HP loss and server-confirmed killer evidence. `survived_window` only means no death was observed within the horizon. Modeled PvP and approximate victim loadouts explicitly fail strict historical-fidelity validation, while repeatable deaths remain useful experimental results. Earlier trials remain in a partial report if a later trial fails.

Private account journals live under the selected lab runtime's `pvp/` directory. Passwords exist only in memory and are excluded from reports/journals. A hard process kill or server outage can prevent cleanup; inspect the recorded exact temporary account identities before recovery, and never delete an account based on a name prefix alone. Normal completion and handled setup failures require confirmed absence after deletion.

See [the live validation report](postmortem-pvp-simulation-2026-09-14.md) for the first reproduced PvP deaths, assumptions and timings.

### Guild-only PvP and guild teams

Postmortem simulations now default to **opposing temporary guilds**: Guild A
contains the victim and unselected player bodies; Guild B contains the selected
attackers. The plan resolves these assignments once, so the attacking and idle
controls have identical memberships. This is a modeled relationship, not inferred
historical guild intelligence. Direct `simulateScene` cases preserve membership
unless their `pvp.guilds` option supplies a setup.

Guild creation uses native server `Guild` constructors and `InductNewMember`, with
real roster entries, membership pointers and command powers. The loader verifies
the system registry, both sides of membership, and configured relationships,
then verifies them again before release. It also reports the room's
`AllowGuildAttack` result for each attacker. Normal PvP eligibility and actual
combat rules still run; room flags, damage and protection checks are not overridden.

This requires the owned isolated container and the replay config's
`native_snapshot`. The baseline's player accounts must be unguilded for modeled
team setup. An existing guild is refused before membership changes; use
`--guild-mode preserve` to use existing native memberships or reproduce an
unguilded refusal. Temporary guilds avoid hall travel, invitation waits and a
persistent pool of special accounts.

Custom teams use exact captured player names or actor keys. Include every player;
`null` leaves a player unguilded. Team labels have 1–16 simple characters. The native
names get a unique simulation prefix. Relationships default to neutral; `allied`
and `war` establish mutual relationships. A war fixture credits the native guild
rent accounts by 50,000 coins per side so the scenario carries its war backing.

```json
{
  "mode": "teams",
  "assignments": {"self": "Guild A", "Morpheus": "Guild B"},
  "relations": [{"a": "Guild A", "b": "Guild B", "kind": "war"}]
}
```

```text
node tools/m59-postmortem-sim.mjs plan POSTMORTEM.json --guilds guilds.json
node tools/m59-postmortem-sim.mjs run POSTMORTEM.json --config PRIVATE_CONFIG.json --guilds guilds.json --out REPORT.json
node tools/m59-postmortem-sim.mjs run POSTMORTEM.json --config PRIVATE_CONFIG.json --guild-mode preserve --out UNGUILDED_CONTROL.json
```

FleetScript `simulatePostMortem` accepts `guilds` as this object, a JSON file, or
`"opponents"`/`"preserve"`. FleetScratch simulation JSON accepts the same field;
file paths resolve relative to that JSON. General scene cases use
`pvp: {enabled: true, attackers: [...], guilds: {...}}`. Reuse an explicit team
mapping across manual attack/idle comparisons. Teams support multi-guild exercise
setup; combat inputs still come from the configured player/controller behaviors.

Reports retain native guild IDs/names, actor assignments, relationship and
membership verification, room permission, setup duration and cleanup. Teardown
disbands only verified owned guilds, restores original rejoin cooldowns, and then
deletes the temporary accounts. Disbanded KOD objects can remain allocated until
garbage collection; cleanup verifies registry removal, empty rosters, absent
timers and cleared membership rather than waiting for object-node removal.
Native world restoration also clears setup mail/news/resources before the next
trial. A failed guild teardown retains account identities for investigation,
disconnects their sessions and reports incomplete cleanup in the private journal.

See [guild simulation validation](postmortem-guild-simulation-2026-09-15.md).

### Exact supplied loadouts

The shared scene loader restores `m59-player-loadout/v1` specifications for both victims and other players. It recreates each item by its native class, restores all captured integer/boolean item properties (including condition, stack quantities, charges, damage/hit/defense modifiers and appearance flags), item attributes and equipped state, and installs the complete skill/spell lists. Skills retain their encoded proficiency and used/unused state. Native school totals, carried weight/bulk and lighting are recalculated. Normal equipment eligibility still applies; an impossible or incomplete specification stops the load.

Capture an existing player from the owned isolated scene container:

```text
node tools/m59-scene-loadout.mjs capture SHADOW_PLAYER --out substrate/scenes/attacker-loadout.json
```

Capture reads twice and refuses inventory/ability changes between reads. The file carries a checksum and source character/time/image/server commit. Native object/list/timer IDs are not exported. `capture-held` and the prepared scene's `snapshot()` also include player loadouts, so ordinary saved scenes and postmortem simulations use the same restoration code.

Create a private name-to-file map, with paths relative to the map file:

```json
{
  "Morpheus": "attacker-loadout.json",
  "Gonzo": "victim-loadout.json"
}
```

```text
node tools/m59-postmortem-sim.mjs plan POSTMORTEM.json --loadouts substrate/scenes/loadouts.json --require-loadouts
node tools/m59-postmortem-sim.mjs run POSTMORTEM.json --config PRIVATE_CONFIG.json --loadouts substrate/scenes/loadouts.json --require-loadouts --out REPORT.json
```

Names or scene actor keys must match exactly, ignoring case; absent or ambiguous mappings are refused. `--require-loadouts` requires a complete loadout for every selected attacker. Unselected bodies can remain unarmed. An actor's embedded `loadout` is used automatically; an explicit mapping overrides it. A victim loadout requires the private config's `native_snapshot` so each trial restores the existing shadow account before applying the next case.

FleetScript exports `capturePlayerLoadout`, `readLoadoutFile`, `readLoadoutBindings`, and `writeLoadoutFile`. `planPostMortemSimulation` and `simulatePostMortem` accept `loadouts` as a map of specifications or a map-file path, and `requireLoadouts: true`. FleetScratch's simulation JSON accepts the same options, with file paths relative to that JSON:

```json
{
  "postMortem": "../postmortems/DEATH.json",
  "configFile": "replay-config.json",
  "loadouts": "loadouts.json",
  "requireLoadouts": true,
  "sequences": {
    "Morpheus": [{"do": "cast", "spell": "fireball"}, {"do": "attack", "swings": 2}]
  },
  "trials": 3,
  "horizonMs": 10000,
  "out": "equipped-pvp-report.json"
}
```

An explicit sequence uses ordinary CombatMode casts/attacks and the restored abilities, mana and reagents. Owning a spell does not automatically select it. Without a sequence, the stand-in uses its equipped weapon for melee. The idle control retains the same loadouts while sending no combat inputs. Reports distinguish melee packets, casts, observed cast failures, damage and server-confirmed kills.

Timed item enchantments are saved as remaining milliseconds. They stay paused during setup, including held-scene re-capture, and are armed just before room release with the native `AttributeTimer` callback. Reports show requested/remaining duration and arming timestamps; this is a measured small start skew, not a claim of simultaneous item/monster timer release. Full loadouts are checked after restoration and again immediately before start. Receipts include a full specification hash, normalized expected/actual state hashes and loadout provenance.

**Exact here means matching the supplied specification.** Old production recordings do not expose other players' hidden inventory, modifiers or abilities, so this cannot retroactively discover Morpheus's loadout. Base attributes, vitals, guild relationships, player buffs/debuffs, RNG and human input timing remain separate scene/native-save concerns. Item state referencing external objects, strings, nested structures or unsupported timers is refused instead of replaced with plain gear. Very short timers that expire before verification also refuse the start. Use a native server checkpoint for state the portable schema cannot represent. `historical_loadout_verified` remains false, and exploratory death evidence remains usable.

See [the loadout validation report](postmortem-loadouts-2026-09-14.md) for armed and spell-casting live trials.
Player combat estimates and witnessed dropped loot are available through the
[player evidence workflow](m59-player-evidence.md). Evidence-informed models use
the same portable loadout files and native restore verification as supplied
loadouts; inferred skills and unknown equipment remain explicit assumptions.
