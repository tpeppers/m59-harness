# Janice, Floyd, Gonzo, and Robin: death investigation

The travelers did have shelter protection, and the records contain successful recovery stops. They died after getting stuck between refuges and failing to complete recovery. Robin died while farming: his keeper was attempting to reach another safe spot when its decision loop stopped returning. **There are real gaps in choosing and reaching refuge, and in handing control back after a cancellation. The evidence does not establish that enabling more survival interrupts would have saved any particular character.**

This investigation covers the four production deaths identified when work began at approximately 17:22 UTC on September 14, 2026. All times below are PDT, seven hours behind the timestamps in the source files. Production was running `e1c26da82776`, including the shared `rideTrack` shelter change. The broker remained PID 42752. The four relevant keepers were still running when inspected. Production code, orders, and services were not changed. Freeze invalidation was not changed.

| Character | Death time, PDT | Activity and location | Observed killer | Fatal sequence |
|---|---|---|---|---|
| Janice | 10:01:05 | Traveling to Castle Victoria; Twisted Wood, room 597, r23c16 | Troll | Pinned, frozen at 20/50 HP, resumed at 20, still on the same square when killed |
| Floyd | 10:07:43 | Traveling to Castle Victoria; Cragged Mountains, room 598, around r40c22–23 | Troll | Healed earlier, pinned at 33/50, frozen without healing, then failed to reach an exit chosen in place of the announced refuge |
| Gonzo | 10:09:31 | Traveling to Castle Victoria; Cragged Mountains, room 598, r31c14 | Troll | Healed earlier, pinned at 32/50, frozen without healing, then failed to leave the square during attempted forward recovery |
| Robin | 10:17:27 | Farming upstairs in Castle Victoria, room 39; final damage at r8c16–18 | Battered skeleton | Left a working refuge, fought, attempted another refuge across a room partition, then lost health during a long blocked recovery pass |

Killers are confirmed by server death broadcasts. Locations are supported by damage events at the killing blow, rather than just the last keeper frame. Robin's last frame says r8c18 while the final damage event says r8c16; both place him in the same short corridor. The four had 50 maximum HP before these deaths.

**What shelter actually did**

The death summaries all report zero shelter stops. Those are **current journey counters**, cleared when `Autopilot.travel()` starts and in its completion cleanup; they are not lifetime totals or complete histories of the interrupted trip. Reading those zeros as “shelter never ran” would give the wrong diagnosis.

| Character | Independent evidence of shelter/recovery before death |
|---|---|
| Janice | On an earlier return to the Valley, a route refuge in room 545 at r3c25 healed 42→50 HP, finishing at 09:50:27. On the later Castle journey, she stopped in Cor Noth at full HP and recovered vigor to 80, finishing at 09:57:14. No successful refuge is recorded in her fatal room-597 crossing. |
| Floyd | Cor Noth sanctuary rest finished at 09:57:43. A refuge was selected in room 597 at r24c18 at 09:59:57, but that selection has no matching settlement. Later, a room-598 refuge at r5c17 demonstrably healed 48→50 HP, finishing at 10:03:46. |
| Gonzo | Cor Noth sanctuary rest finished at 10:02:44. Room 598, r5c17, then healed 45→50 HP, finishing at 10:05:13. |
| Robin | His journey reached Castle Victoria at 09:59:08 after three recorded stops, including healing 35→50 in Ukgoth. During farming, frames show him recovering at the proven wall r10c41 from 40 HP at 10:15:36 to 48 at 10:16:17, before leaving it. |

Thus the expectation that travelers should use refuges is implemented and sometimes fulfilled. The missing guarantee is **getting to the next usable refuge before another fatal exposure**, particularly once the original crossing has been interrupted.

**Janice: failed crossing, followed by recovery on the same exposed square**

Janice was going from the Valley to room 39 under the new station assignment. Her original journey crossed six rooms and recovered vigor in Cor Noth. At 09:58:10 a new DUM `return-to-station` busy declaration cancelled that already-running journey in room 576 and launched a replacement. DUM's recorded intent still described her as being in room 544. The transit ledger independently establishes that she had already reached room 576. This is an observed stale-observation/reissued-order problem, although it is not sufficient to attribute the eventual death to that interruption alone.

She entered room 597 at 09:59:09. Damage began at 09:59:16; by 09:59:24 she was at 20/50 and effectively pinned at r23c16. The independent watchdog cancelled the crossing at 09:59:25 for being wedged below the flee line. A freeze stopped the damage but left her on that square at 20 HP.

DUM's arrival waiter subsequently declared 90 seconds without ground or recovery progress and sent `cancel_movement` at 10:00:55, shortly before the freeze deadline. Its record says the cancelled movement had not released the body. This was a caller timeout, not a deliberate shelter decision.

At 10:00:58 she unfroze at the same 20 HP. At 10:00:59 the keeper refused another unhelpful freeze and entered `passFleeAndRest`. It never completed that pass before death. The watchdog cancelled again at 10:01:02 with 13 HP, attributing the hold to DUM's movement claim. She took the final three hits between 10:01:01 and 10:01:05 without leaving r23c16.

There was nearby geometric cover: the production map offers walls about two square steps away, and Floyd's preceding/following route evidence identifies r24c18 as a candidate near this same position. That does **not** establish that Janice could enter an unoccupied refuge through the live crowd. The recorder retained only the last 14 decisions, so her final selected wall is not known. The supported finding is a failed recovery handoff and approach, not proof that an available wall was explicitly switched off.

**Floyd: the announced refuge was replaced by an exit**

Floyd's journey first stalled in room 597 at 09:59:59, then resumed into room 598. He successfully healed to 50 at r5c17. By 10:04:14 he had reached r40c23 and was taking damage. At 10:04:20 the wedged-journey watchdog suspended travel. Frames then hold him around 33 HP for approximately three minutes; the last freeze ends at 10:07:27 at exactly 33 HP.

At 10:07:27.832 the keeper announced **r51c22 as “the next wall on the route.”** At 10:07:27.971 it instead announced **the exit to room 599 at r65c19, 26 steps away**. It then awaited that crossing. He moved between r40c22 and r40c23, lost his remaining health, and died 15.7 seconds after the attempted recovery started. No new main-loop decision completed in that interval.

This mismatch is directly explained by the code: `shelterForwardAndMend()` computes and logs `ahead`, then calls `takeSafeSpot(why, null, {source: 'travel'})` **without passing `ahead`**. The second selector starts over, applies a strong forward preference, and can choose the exit. An exit may be an excellent escape when it is near and reachable; here the recorded choice substituted a long crossing for the refuge it claimed to be taking.

The production map independently reproduces that preference from Floyd's position. With the exit permitted, the simplified selector chooses r65c19. With the exit excluded but the same forward preference, it still chooses a distant wall at r61c19. With no forward preference, it finds a geometric wall at r39c22. Consequently, “disable exit-as-wall” alone is not equivalent to “take nearby cover.” Live occupancy, exclusions, fine movement, and the cost of leaving cover were not replayed.

**Gonzo: a successful refuge, then freezing and a recovery that never moved him**

Gonzo was also on a DUM `return-to-station` trip with `run_errands: false`. His room-598 refuge healed him to full at 10:05:13. He later encountered blocked movement, including a recorded body obstruction shortly before damage began at 10:06:08. By 10:06:13 he was at about 32 HP near r31c14. At 10:06:16 the ordinary travel guard recorded `logged off below the flee line` and suspended the journey.

The final freeze ended at 10:09:20 with 32 HP, unchanged. DUM had already timed out the journey and freed its **busy marker** at 10:08:00; its longer-lived ownership of the movement faculty remained. A movement claim and an active busy operation are different states.

On waking, the keeper noted that Gonzo was unarmed and too hurt to stop for arming, refused another freeze, and announced a forward refuge at r38c21. He remained at r31c14. At 10:09:24 the watchdog cancelled the walk with 28 HP, describing it as a stalled DUM driver. But the main loop was already inside the keeper's own `passFleeAndRest`, not waiting for a fresh DUM travel call. The ownership label alone does not identify the actual current mover.

He died at 10:09:31 after five final hits. There is no recorded arrival, recovery, or completed subsequent pass. The exact destination selected by the second refuge search is not retained. The map can find nearby cover, but it cannot prove that a particular alternate approach would have succeeded through those trolls. Being unarmed also limited a possible combat alternative; enabling the travel arming interrupt would add another stop and is not a demonstrated cure.

**Robin: farming recovery became a long, exposed movement operation**

Robin's successful wall recovery was real. He left r10c41 at roughly 49 HP, reached full health briefly while fighting at r12c42, and took damage. At approximately 10:16:50 the keeper began `passFleeAndRest`. That recovery call had been given a quarry and went through the machinery for changing sides of a partitioned room. At 10:16:54 it reported reaching the quarry's side at r8c23, with the quarry at r6c16, and intended to choose a wall there.

The following 33 seconds were spent approaching through the short corridor around r8c16–22. At 10:17:01, still at 43 HP, the clear-path watchdog detected six seconds of insufficient progress with four creatures in reach and cancelled movement. Nevertheless the **same pass, number 39416, remained active until death**. Robin crossed below the effective 68% flee line at 10:17:06 and below the roughly 30% panic line later. Those ordinary survival decisions could not run afresh while the approach remained awaited. His final summary reports 37.3 seconds inside `passFleeAndRest` and zero low-health blind-walk interrupts.

This is why the summary's `doing: travelling` must not be interpreted as another station commute. It was movement within a farming recovery operation. The farming policy had `useSafeSpots: true` and `panicLogoff: true`, but `requireSafeWall: false` and `pullToSafeWall: false`; it permitted leaving cover to fight. More significantly, **a health-recovery call could pursue a quarry-compatible wall across the partition instead of first securing the wounded farmer on his current side**. That behavior sacrifices immediate recovery for a location useful for further combat.

The static map places his old refuge on the other disconnected component from his final corridor. There are other geometric walls on the final side, including r7c17 near his last position. We do not have the complete live occupancy and exclusion state needed to prove that one was available.

**Confirmed gaps and the tradeoffs they imply**

| Mechanism | What this investigation establishes | What a change would risk or still need to prove |
|---|---|---|
| Cancellation of a shelter approach | The actual `returnToSpot()` method treats a cancelled first approach like an ordinary failed approach and calls its fallback mover. Neither call carries the original movement generation. Both fine-first and square-first reproductions show a second movement call after cancellation. `takeSafeSpot()` checks cancellation only after that helper returns. | Making cancellation terminate the entire approach is a concrete control-flow correction. It still does not choose the next safe action or prove survival. This gap is consistent with Robin, Janice, and Gonzo remaining in one recovery pass after watchdog cancellation; the records do not identify their exact helper branches. |
| Forward refuge identity | The actual `shelterForwardAndMend()` logs a wall and discards that target before a second selection. Floyd's live decisions show the resulting wall-to-exit substitution. | Preserve the selected refuge through the approach, with an explicit reason if it becomes unusable. Test arrival and eventual exit; a nearby wall that traps the character indefinitely is not a successful journey. |
| Blind low-health walk interrupt | `blindWalkWatchdog` is absent in the inspected policies, so its `!== true` gate disables it. The actual watchdog probe makes zero cancellations by default and one with it enabled for the same blocked, low-health pass. This fits Robin's and Floyd's fatal awaited operations. | A broad enablement also interrupts wounded characters making useful progress. It was disabled for that documented reason. A correction should distinguish a failing approach from productive travel, and it needs the cancellation fix above to be effective. |
| Recovery prioritizes a quarry | The ordinary hurt-in-monster-room branch passes `near[0]` or another hostile to `takeSafeSpot`. That function can cross a room partition to find a quarry-compatible wall. Robin's recorded sequence followed that route during recovery. | A recovery-specific search on the current side might save exposure, but may sacrifice combat access, kill rate, and progress. Measure these costs instead of silently changing all farming wall selection. |
| Movement ownership versus active movement | The watchdog uses a standing movement-faculty claim as evidence of another driver. Janice and Gonzo were labelled DUM-held while the keeper's recovery stage was running. DUM also reissued Janice's already-running trip from a stale position. | Track the operation that owns the current walk, not just the standing claimant. Avoid cancelling a recovery approach because it resembles an abandoned external journey. |

Several protections were present but are not promises of rescue. The effective flee threshold was 68%, despite `fleeBelow: 0.45`, because `safetyFor()` raises it for a two-hit margin at 50 maximum HP. Freezing stopped incoming attacks for a time but did not heal these exposed travelers. The crowd gate also declined the “trade in place” combat fallback in all four cases; its journal wording about the exit being the only wall is **not evidence that route walls were globally disabled**. The two choices are separate in the executable code.

Shared route shelter checks occur between movement legs or at eligible track stations; they do not continuously select every nearby geometric wall. The route also has a progress requirement after a refuge. Once travel is suspended, recovery moves through a different set of calls. The September 13 track fix therefore does not cover the failed selection/cancellation chain identified here. None of these deaths establishes that the old track-specific health threshold has returned.

**Would different protections have saved them?**

These records establish preventable-looking failure mechanisms and opportunities for better recovery. They do not establish four counterfactual survivors. The nearby walls are geometric possibilities, not reconstructed live arrivals. A complete damage frame is not a complete snapshot of every monster's position, target, timing, and collision state.

The previous shadow comparison is relevant caution: across 20 trials, keeping shared shelter while disabling the additional `flee`/`fight_back` travel guards produced 7 deaths and 3 arrivals in 10 runs; enabling those guards produced 10 deaths and no arrivals. Three paired runs favored continuing with shared shelter; none favored the additional guards. That was a separate, small set of staged troll encounters, **not** a test of these four incidents or of `blindWalkWatchdog`. It cannot justify enabling or disabling every protection. The earlier report remains in the sibling `shadow-survival` worktree at `docs/shadow-shopping-survival-2026-09-14.md`.

For the next survival comparison, the useful variants are separate: terminate cancelled refuge approaches; preserve the actual selected refuge; and limit recovery to current-side, reachable cover before chasing quarry. Compare each against production with identical starting HP, equipment, food/vigor, route, and staged attackers. Record deaths **and completed arrivals**, HP gained at refuge, time exposed, return-to-work time, and kills forgone. Only then test a narrowly targeted interruption policy. Repeated freezing without progress should count as failure to recover, not as a life saved merely because death was delayed.

**Evidence and reproduction**

The new checks are offline calls into the actual production methods and production-matching geometry. They ran successfully without opening game sockets. No new live shadow mortality experiment was run for this report, and no claim above treats these probes as one.

- [Executable probes](reproductions/latest-four-deaths.mjs), [results](reproductions/latest-four-deaths-results.json), and [source hashes](reproductions/latest-four-deaths-source.json). Run `node docs/reproductions/latest-four-deaths.mjs` from this report's worktree. All four source modules and the map were byte-identical to production when verified.
- Production death files: `substrate/postmortems/Janice-2026-09-14T17-01-05-410Z.json`, `Floyd-2026-09-14T17-07-43-560Z.json`, `Gonzo-2026-09-14T17-09-31-125Z.json`, and `Robin-2026-09-14T17-17-27-975Z.json`, under `C:/code/m59-lab/prod-deploy`.
- Persistent journey and sanctuary events: production `substrate/history/prod/fleet-2026-09-14.jsonl`. Route refuge choices and settlements: production `substrate/shelter-runs-prod.json`.
- Crossing and tactic records resolve to the shared evidence root, `C:/code/mindmap/maps/m59-harness/substrate/transits/` and `tactics/prod.jsonl`. Relevant tactics and shelter records carry movement epoch `e1c26da82776`.
- DUM calls and completed errand records: `C:/code/m59-lab/dum-head/var/journal/dum-2026-09-14.ndjson`. Its inspected errand executor was unchanged from DUM commit `eff4ab79e7c3bd734c2f59b6592634047396c39d`.
- Frozen copies of the four postmortems, filtered auxiliary records, and cached policy observations are retained locally in this worktree's ignored `substrate/latest-four-evidence/`. Runtime data and cached states are not published with the report.

Code references at the examined commit: `m59-autopilot.mjs` lines 3864–4181 (refuge selection/approach), 7007–7014 and 7248–7255 (counter resets), 8068–8100 (forward refuge handoff), 11233–11241 and 11454–11521 (claim attribution and rescue), 11689–11709 (disabled interrupt), and 15419–15426 (hurt recovery with a quarry); `m59-skills.mjs` lines 1767–1883 (`returnToSpot`); `m59-game.mjs` lines 4024–4061 (between-leg shelter) and 10012–10052 (shared track shelter).

There is also a measurement trap: Floyd's later `exit_as_wall` tactic row says it worked because he eventually appeared in room 382 after dying and escaping the Underworld. The actual attempted destination was room 599. That row is not evidence of a successful escape. This report uses the contemporaneous death, damage, and crossing records instead.
