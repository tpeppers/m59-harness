# Travel deaths and world-tour stalls — September 16, 2026

This audit found two fixable keeper bugs and added automatic per-character stall reporting to the world-tour runner. It does **not** establish a percentage of deaths prevented: the behavioral fixes have offline regression evidence, while the latest death scenes still need comparative live trials.

## Completed tour

The 21-character shadow fleet ran the forward circuit on `bb38e2a`, movement epoch `24df8eadcfe9`. Measurement ran for 3,601 seconds, from September 15 **9:38:12 PM to 10:38:13 PM PDT**; staggered launch began at 9:37:53 PM.

| Measure | Result |
|---|---:|
| Deaths | 2 |
| Checkpoint legs completed | 193 |
| Characters completing at least one leg | 20 / 21 |
| Recorded HP damage | 3,031 |
| HP-decrease events | 746 |
| Distinct maps visited by the fleet | 49 |
| Character/map pairs | 901 |
| Bots flagged for lack of progress at the final observation | 7 |
| Death recordings saved / capture errors | 2 / 0 |
| Additional critical-health scenes saved | 11 |

Arrivals are checkpoint legs, not complete world tours. Damage includes subsequently healed HP and is not net health loss. All 21 final result rows previously said only “cycling,” which hid individual stalls. Stalled bots reduce travel exposure, so two deaths is not evidence that the whole fleet travelled safely for an hour.

The supervisor stopped the shadow broker and keepers. Both before/after native save sets passed file-set and SHA-256 verification; the tour deaths each have a verified 120-frame replay bundle. Runtime artifacts, saves and player/account data remain private under the run directory.

## Were stuck bots automatically detected?

Individual keeper movement pulses already recorded short stationary spells. The tour controller counted arrivals/deaths and checked handoffs, but did not publish a fleet count of individual bots failing to progress.

The new runner checks every observed character separately and writes `OUT.progress.json` by default when `--out OUT` is supplied. It always prints changes in stuck counts and identities. `--progress PATH` selects a separate live JSON file.

Defaults:
- `--stall-seconds 180`: no new coarse position or room, checkpoint arrival, or actual HP gain for three minutes.
- `--leg-stall-seconds 600`: no checkpoint for ten minutes plus no new room for three minutes flags prolonged recovery/loitering even if health occasionally rises.
- Missing/stale observations are **unknown**, not zero HP or proved stalls. Explicit prolonged offline observations have their own reason.
- A new checkpoint resets the leg history. Repeated movement through previously seen squares/rooms does not indefinitely hide a loop.
- Current count, ever-flagged count, episodes, per-bot reasons, destinations, health and timestamps are retained.

These are investigation flags, not automatic movement orders. A legitimately long recovery can be flagged; the monitor does not pull an injured bot off a safe wall.

The completed run was audited using its older room/HP observer journal, which lacks position samples. That retrospective audit flags 20 bots at some point; **do not interpret that as 20 confirmed permanent stalls**. The seven final flags were:

| Character | Room | Minutes without new observed route progress | Interpretation |
|---|---|---:|---|
| Hhhh | Sewers of Barloque (108) | 11.8 | Prolonged recovery; still gaining HP, less conclusive |
| Iiii | Sewers of Barloque (108) | 21.3 | Idle recovery loop |
| Kkkk | Sewers of Barloque (108) | 34.6 | Idle recovery loop |
| Llll | Sewers of Barloque (108) | 20.3 | Idle recovery loop |
| Oooo | Sewers of Barloque (108) | 44.8 | Idle recovery loop |
| Qqqq | Sewers of Barloque (108) | 41.8 | Idle recovery loop, 17/48 HP |
| Rrrr | Lake of Jala's Song (568) | 57.9 | Arming/mana recovery starved journey resumption; zero arrivals |

## Bugs fixed

### 1. Unarmed recovery could indefinitely prevent journey resumption

Rrrr retained a suspended destination of Castle Victoria but repeatedly attempted to recover mana for Create Weapon. The arming stage ran before recovery and journey resumption and consumed every pass. At the detailed capture Rrrr was at full HP, with insufficient mana, and the same destination had waited over 53 minutes.

The ordinary arming stage now yields when a suspended journey exists. Existing survival and readiness checks then decide whether to recover or resume. This accepts travelling unarmed, consistent with the existing active-travel policy; it does not bypass health/vigor gates or allow ordinary farming to ignore arming.

Regression fixtures exercise the real arming and resume methods: a whole unarmed traveller resumes the retained destination, while a hurt one retains the destination and waits. Ordinary rearming still passes its existing test. The new full-health regression fails on the original implementation.

### 2. Cancelling a dying internal journey failed to create survival intent

Rowlf died to a Guardian of Zjiria in Ukgoth at **9:20:50 PM PDT**, on the return leg of an internal supply/stockpile errand. The watchdog did act: at **9:20:48.216 PM**, 18/53 HP, it cancelled the wedged journey and retained destination 39. Approximately 2.5 seconds later Rowlf died. The last 6.9 seconds were stationary with at least 35 HP lost; no shelter stop was recorded on that journey.

The cancellation set a shelter-request flag but created no replacement `SurvivalDecision`. Consequently the existing same-pass decision drain had nothing to execute or report. A postmortem field showing zero ordinary watchdog “interrupts” did not mean no rescue occurred; the separate journey-rescue note proves that it did.

The watchdog now immediately records a replacement: logoff at a verified current safe wall, otherwise the closest reachable recovery refuge. Cancellation preserves that decision. The existing pass wrapper dispatches it after the old mover unwinds, before yielding for another heartbeat. A regression exercises actual travel, watchdog cancellation and pass completion, checks that intent exists immediately, and checks that recovery never races the old mover.

This fixes an ownership/handoff gap. It does not prove the remaining 2.5 seconds would have been enough to save Rowlf, nor make an unresponsive mover unwind instantly.

## Current deaths and outstanding experiments

All three recent bundles identify the same clean harness build `bb38e2a` and epoch `24df8eadcfe9`; the deployed checkout subsequently advanced to `c3b8fe5` for guild-rent work.

| Death | Observed behavior | Next useful comparison |
|---|---|---|
| Eeee, 10:18:12 PM, Cragged Mountains, troll | Route shelter was interrupted off plan. A replacement selected a wall two path steps away at 49/60 HP; it never arrived and spent about 30 seconds approaching, eventually dying. | Bound failed refuge approaches by actual distance/damage progress, preserve exclusions, then choose a different reachable refuge/exit. Compare against original navigation; do not assume a short planned path means a safe executable approach. |
| Mmmm, 10:23:57 PM, Ukgoth, troll | Open-floor logoff held health at 16/51. After the freeze deadline, another ineffective logoff was refused; a three-step wall approach failed over about 14.7 seconds and the bot died. | Compare prompt reachable-wall selection against the observed logoff/approach sequence, with damage and arrival receipts. Do not count open-floor waiting as safe healing. |
| Rowlf, production | Watchdog cancelled the journey but left no executable replacement decision before death. | Replay the same initial scene against the new handoff, with enough repeated trials to distinguish a useful intervention from variance. |

Eeee/Mmmm still had protections enabled: these are failures to reach protection, not evidence that sheltering was switched off. A reproducible similar-root-cause death is useful even when timing or the exact blocked square differs from the original. Preserve those trials and label fidelity; do not discard them solely for timing mismatch.

### Sewers congestion requires a separate solution

Six detailed stalled scenes were saved. The idle sewers bots repeat nearest-refuge → route-refuge → open logoff → nearest-refuge. Refuge search says no reachable defensible square; logoff refuses because earlier cycles did not gain health. The bounded same-pass search ends correctly, but the next pass begins the same unsuccessful sequence.

Oooo's capture at **r35c40** is especially useful: north/south adjacent squares are not walkable, west is occupied by a rat and Kkkk, east by Qqqq. The current conservative body-aware path search has no clear route out. Qqqq has one open square east, with more bodies farther along. Simply removing occupancy checks would violate the requirement that recovery paths be clear, and faster retries cannot move those bodies.

Recommended experiment: replay the multi-character scene and compare coordinated yielding/backtracking, clearing a reachable blocking monster, and the existing behavior. Preserve the same geometry, body positions and loadouts. Require actual route progress as well as survival. Replanning must retain failed-option history across unchanged observations rather than endlessly starting another identical recovery episode.

## Archive review and limits

The inventory scanned **3,683** unique postmortems: the authoritative production store and local simulation stores under this task's owned worktrees. It found **2,381 travel-associated records**: 2,339 production and 42 local simulation/copy records. Of these, 1,842 explicitly describe travel; 539 only retain travel context and must not all be called confirmed travel deaths.

Attribution reports 2,090 PvE, 64 PvP and 227 unknown within that broad cohort, including inferred classifications. Morpheus/player deaths must stay outside monster-travel effectiveness claims. Most records (2,306) lack an epoch in their retained survival-decision history; unknown does not mean stale, but it prevents a current-code conclusion without further provenance work.

Within the 1,542 production records explicitly describing travel and classified PvE, 171 retain stationary-with-damage evidence, 253 record zero shelter stops, and 10 identify an internal-shopping stage. These categories overlap and telemetry coverage varies. They are search priorities, not counts of preventable deaths. Frequently recorded locations include Cragged Mountains (210), border of the Badlands (190), and Ukgoth (148); 396 lack a location in this normalized view.

The machine-readable private catalog preserves individual source paths, timestamps, attribution, evidence class, epoch, survival strategy, flags and replay availability. This pass inventories the corpus and deeply reviews current failures; it does not claim a manual reconstruction of every historical death.

## Verification and delivery

Passing: pilgrimage progress detector; 33 existing pilgrimage scenarios; 153 journey-resumption checks; rearming cleanup; survival handoff; 28 watchdog checks; 25 pass-order checks; 24 survival-decision scenarios; syntax checks. The two new keeper regression cases fail against the original source and pass after the fixes.

The older travelling suite reports **142 passed / 4 failed** on both the unchanged tour build and this branch. Those four source-pattern checks still expect the previous direct refuge-rest implementation, replaced earlier by survival decisions; they are pre-existing, not newly introduced failures.

Source changes are on `codex/travel-death-stalls-2026-09-16`. No keepers were restarted onto these fixes during this audit. Native checkpoints, full scenes, replay bundles, raw postmortems and credentials are not committed. Production's scheduled two-hour income/death reports continue through the original endpoint.

