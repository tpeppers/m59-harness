# Postmortem PvP simulation: implementation and live validation

The shared death simulator now creates temporary player accounts to stand in for captured players. It reproduces a useful PvP failure from Gonzo's recorded death: **four attacking-player trials died; all four paired idle-player controls survived the 10-second window.** These are modeled experiments, not faithful reconstructions of Morpheus's human inputs or equipment.

## Scenario and result

Source: `Gonzo-2026-09-14T23-19-35-270Z.json`, replay bundle `t18-9904-1789427381038-death-1789427975260`, checkpoint `t18-9904-1789427381038-658`. Gonzo has 5/48 HP in map 544, Valley of Ileria. His fine position is `{x:723,y:4322}` at r67c11; Morpheus is at `{x:707,y:4326}` in the same square. Gonzo's captured self position is marked predicted, a pre-existing fidelity limitation.

Five temporary accounts represented Morpheus, Robin, Gountrug, Spartacus and Sweetums. Only Morpheus's stand-in attacked. The other bodies remained idle at the captured positions in both cases. Each trial restored the native lab snapshot, created fresh accounts, verified creation attributes and final scene placement, and released the room before starting ordinary paced melee attacks and the victim's real survival controller.

| Pair | Attacker enabled | Attack attempts | Players idle |
|---|---|---:|---|
| 1 | Died at 4.120 s | 2 | Alive through 10.019 s |
| 2 | Died at 5.417 s | 3 | Alive through 10.074 s |
| 3, shared simulation-file entry | Died at 0.681 s | 1 | Alive through 10.098 s |
| 4, final creation/skill checks | Died at 7.053 s | 4 | Alive through 10.099 s |

Server text confirmed punches and player murder, including the victim's personal revenge message naming the temporary attacker. The final reports map that identity back to captured player Morpheus. The victim HP trace survives logout/reconnect, so the recovery attempt does not erase earlier damage. Idle controls reported no attacks or HP loss. All 40 temporary accounts created in these eight valid trials were verified absent after cleanup.

The deaths' differing times remain useful evidence of recurrence. In the first two attack trials, the controller approached its captured refuge and logged off/rejoined; the attacker then continued attacking and killed it. These runs establish a small reproducible PvP test case for comparing survival interventions. They do **not** establish that logging off caused the deaths, or that disabling a particular protection would help. That requires paired intervention variants against the same attacker model.

## Deliberate approximations

- The attacker model is unarmed melee with the legal `melee` attribute preset, 100 HP, 50 mana, 200 vigor and 99 punch. The final trial explicitly verified punch from the connected client's skill read. Historical enemy stats, weapons, spells, guild state and actions were not captured.
- The victim used the selected shadow account's inventory/equipment/skills. Its recorded HP, stats, position and controller state were loaded; the equipment/skill mismatch is preserved in the report.
- `noMonsters` removed recorded monsters, including a revenant whose class was absent from the generated catalogue, to isolate direct player pressure. It suppresses automatic spawns, not every reactive summon after a murder.
- `labScenery` retained snapshot scenery instead of recorded drops and loose soil that lacked matching lab objects. This option is explicit and reports the replaced item set. Collision differences are possible.
- Native timers/RNG, historical human inputs and JavaScript execution stacks are not rewound. Reports therefore remain exploratory and fail strict historical-fidelity checks.

## Tool and operational behavior

`m59-postmortem-sim.mjs plan|run` accepts either a postmortem referencing a replay or a checksum-protected replay bundle. It defaults to the latest living checkpoint containing the confirmed player killer. Explicit attacker names/keys and frame selection are supported. Missing captures, ambiguous players, mismatched loadouts and incomplete scene bindings are refused instead of guessed away.

The same operation is exposed through `simulatePostMortem` and `planPostMortemSimulation` in FleetScript, and the existing FleetScratch `simulate` simulation-file command via a `postMortem` field. Existing `simulateScene` cases also accept `pvp` alongside policy, intervention and reload variants. See [usage and configuration](m59-death-replay.md#postmortem-pvp-simulations).

Reports distinguish attempted attack packets, server refusals, observed HP loss and confirmed stand-in kills. They include the alias map, normal PvP eligibility, verified creation stats, cleanup, decisions, source manifest and native save/image identity. Strict-baseline validation rejects modeled enemy behavior and explicitly approximate victim loadouts, while recurring failures remain available for investigation.

Temporary accounts are limited to the attested owned container `m59-replay-lab`, game port 17959 and maintenance port 17998. No production keeper policy changed or required restart. The separate native shadow server was not modified.

The Linux server's account-delete command originally acknowledged deletion without performing it. The lab-only patch now calls the existing account-and-user deletion function on the server loop. The image advertises this capability; the tool additionally checks that each exact account is absent after deletion. The old lab container was retained stopped as `m59-replay-lab-before-pvp-20260915`; both standing and freshly saved checkpoints were retained under `substrate/native-scenes/before-pvp-upgrade/`.

Early development failures exposed missing scene bindings, a reconnect race and novice PvP eligibility left stale by raw stat restoration. Those failed runs and their reports were retained. The final setup waits for the creation socket to close, reconnects with full combat event wiring, calls normal `EvaluatePKStatus` after restoring stats, and records eligibility. It does not override the server's PvP rules. The first development trial's leftover account was separately identified and deleted; subsequent normal and handled-error cleanup verified deletion automatically.

## Performance and verification

Across eight valid trials, restore-to-start was **8.90–9.52 seconds**, median **9.05 seconds**. Complete overhead, excluding simulated play, was **9.05–9.65 seconds**, median **9.20 seconds**. Creating and verifying five new accounts accounts for most of the extra cost over the existing roughly four-second ordinary scene loop. No character is paused in production to perform this work.

Offline checks passed for postmortem selection/checksums/paired controls/CLI startup, temporary account lifecycle and failures, 31 death-replay scenarios, 13 scene-simulator scenarios, 98 scene assertions, 40 combat-mode scenarios and 301 FleetScript assertions. The lab image compiled successfully and the shared simulation-file path completed live paired trials. Cleanup left no game clients connected to the lab.

Private raw artifacts remain under the development checkout's `substrate/replay-smoke/`; credentials and recordings are not committed. Runs were made while developing atop `4ca1c96`, with their exact modified-source manifests recorded in each report:

| Artifact | SHA-256 |
|---|---|
| `pvp-gonzo-report-7.json` | `7efc0a4a088b9dd475557070354f9effbe409fe292aa3d7f7acb213932a42331` |
| `pvp-shared-entry-first.json` | `09e3e728aa7d3a57d41bb0e5ed1b7a4099180aac0374872bb4f78d045bca9166` |
| `pvp-fleetscratch-report.json` | `5f2361ec28e4eaba20089dedb63a5e53a499ad34a5574010dce0052496d6bc14` |
